// The wiki, versioned by git (night phase 06, E4; docs/DISCUSSIONS.md; D00-6, D06-*). GitHub offers
// no API for its own wikis, so OSCR's wiki is Markdown pages on a `wiki` branch of the repository
// (D00-6: "the inventory's second repository in the GitBackend becomes this branch"), edited through
// the phase-03 one-authorized-commit model: the person's own token, used once, never stored; OSCR
// never writes to GitHub itself.
//
//   wiki_edit  {base, createFrom?, message, description?, pages: [{slug, content} | {slug, delete:true}],
//               sidebar?, footer?}
// `base` is the wiki branch's head the page read (expectedHead): a branch that moved fails (409
// conflict). An empty `base` with `createFrom` (a sha of the repository) makes the `wiki` branch for
// the first page. Pages are Markdown files named `<slug>.md`; a sidebar is `_Sidebar.md`, a footer
// `_Footer.md` (GitHub's wiki convention). The commit is GitHub's, signed, with the person its author
// (D00-14); the registry writes only its action row (1 row). The file contents never reach D1 or a
// log, and they are not masked here (a commit to the person's own repository is their own text; the
// masking happens when the registry DISPLAYS a page). History, a page at a revision, compare and
// revert are reads of GitHub in the reader's browser (0 Worker requests, the §15.6 budget).

import { GitBackendError } from "../errors.ts";
import { utf8 } from "../objects.ts";
import type { FileChange, RepoInfo } from "../types.ts";
import { COMMIT_FILES } from "./caps.ts";
import { commitMessage, DESCRIPTION_CHARS, SUMMARY_CHARS } from "./act-commit.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type ActionTarget, type AnyActionSpec } from "./types.ts";

/** The branch the wiki lives on. */
export const WIKI_BRANCH = "wiki";
/** A wiki page's content at most (a Markdown page). */
export const WIKI_PAGE_CHARS = 512 * 1024;
/** Pages changed in one authorized action. */
export const WIKI_PAGES = Math.min(COMMIT_FILES, 50);

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A wiki page's slug: a safe file-name base (no path, no dot segments, no reserved underscore page). */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,98}$/;

/** A slug as its file on the wiki branch: spaces become hyphens (GitHub's convention), then `.md`. */
export const wikiFile = (slug: string): string => `${slug.trim().replace(/\s+/g, "-")}.md`;
/** The page in the registry's viewer. */
export const wikiPageUrl = (owner: string, name: string, slug: string): string =>
  `/r/${owner.toLowerCase()}/${name.toLowerCase()}/wiki/${encodeURIComponent(slug.trim().replace(/\s+/g, "-"))}`;

export interface WikiPage {
  slug: string;
  content: string | null; // null: delete
}

export interface WikiParsed {
  base: string;
  createFrom: string | null;
  message: string;
  description: string;
  pages: WikiPage[];
  sidebar: string | null | undefined;
  footer: string | null | undefined;
}

export interface WikiDone {
  id: string;
  owner: string;
  name: string;
  branch: string;
  sha: string;
  base: { branch: string; sha: string };
  newBranch: boolean;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

function readSlug(v: unknown): string | ForgeProblem {
  if (typeof v !== "string" || !SLUG.test(v.trim()) || /(^|[\\/])\.\.?($|[\\/])/.test(v) || v.trim().startsWith("_")) {
    return bad("A wiki page's name is a short title (letters, numbers, spaces, - _ .), not a path, and not one starting with “_”.");
  }
  return v.trim();
}

function readContent(v: unknown, what: string): string | ForgeProblem {
  if (typeof v !== "string") return bad(`${what} is not text.`);
  if (v.length > WIKI_PAGE_CHARS) return bad(`${what} is at most ${WIKI_PAGE_CHARS.toLocaleString("en-GB")} characters.`);
  return v.replace(/\r\n?/g, "\n");
}

export function validateWiki(payload: unknown): WikiParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The wiki change is not readable.");
  const p = payload;
  const createFrom = p.createFrom === undefined || p.createFrom === null || p.createFrom === "" ? null : p.createFrom;
  if (createFrom !== null && (typeof createFrom !== "string" || !OBJECT_ID.test(createFrom))) return bad("The commit to start the wiki branch from is a full commit id.");
  const base = p.base === undefined || p.base === null ? "" : p.base;
  if (createFrom === null) {
    if (typeof base !== "string" || !OBJECT_ID.test(base)) return bad("The wiki branch's head the change was made on is missing.");
  } else if (base !== "") {
    return bad("Starting the wiki branch and editing it at a head are not done at once.");
  }
  if (typeof p.message !== "string" || !p.message.trim() || /[\r\n]/.test(p.message.trim()) || p.message.length > SUMMARY_CHARS) {
    return bad("Write a commit message: one line that says what the change does.");
  }
  if (p.description !== undefined && (typeof p.description !== "string" || p.description.length > DESCRIPTION_CHARS)) return bad("The description is too long.");
  if (!Array.isArray(p.pages) && p.sidebar === undefined && p.footer === undefined) return bad("The change touches no page.");
  const pages: WikiPage[] = [];
  const seen = new Set<string>();
  for (const raw of (Array.isArray(p.pages) ? p.pages : [])) {
    if (!isObject(raw)) return bad("A page is not readable.");
    const slug = readSlug(raw.slug);
    if (slug instanceof ForgeProblem) return slug;
    if (seen.has(slug.toLowerCase())) return bad(`The page “${slug}” appears twice.`);
    seen.add(slug.toLowerCase());
    if (raw.delete === true) {
      pages.push({ slug, content: null });
    } else {
      const content = readContent(raw.content, "A page's content");
      if (content instanceof ForgeProblem) return content;
      pages.push({ slug, content });
    }
  }
  let sidebar: string | null | undefined;
  if (p.sidebar !== undefined) {
    if (p.sidebar === null) sidebar = null;
    else {
      const c = readContent(p.sidebar, "The sidebar");
      if (c instanceof ForgeProblem) return c;
      sidebar = c;
    }
  }
  let footer: string | null | undefined;
  if (p.footer !== undefined) {
    if (p.footer === null) footer = null;
    else {
      const c = readContent(p.footer, "The footer");
      if (c instanceof ForgeProblem) return c;
      footer = c;
    }
  }
  const changes = pages.length + (sidebar !== undefined ? 1 : 0) + (footer !== undefined ? 1 : 0);
  if (!changes) return bad("The change touches no page.");
  if (changes > WIKI_PAGES) return bad(`A wiki commit changes at most ${WIKI_PAGES} pages at once.`);
  return { base: base as string, createFrom, message: p.message.trim(), description: typeof p.description === "string" ? p.description.replace(/\r\n?/g, "\n").trim() : "", pages, sidebar, footer };
}

export function describeWiki(p: WikiParsed): string {
  const edits = p.pages.filter((x) => x.content !== null).map((x) => x.slug);
  const deletes = p.pages.filter((x) => x.content === null).map((x) => x.slug);
  const parts: string[] = [];
  if (edits.length) parts.push(`write ${edits.map((s) => `“${s}”`).join(", ")}`);
  if (deletes.length) parts.push(`delete ${deletes.map((s) => `“${s}”`).join(", ")}`);
  if (p.sidebar !== undefined) parts.push(p.sidebar === null ? "remove the sidebar" : "set the sidebar");
  if (p.footer !== undefined) parts.push(p.footer === null ? "remove the footer" : "set the footer");
  const where = p.createFrom ? "and start the repository's wiki branch" : "on the repository's wiki branch";
  return `Commit “${p.message}” to the wiki (${parts.join("; ")}) ${where}`;
}

/** The repository the page declared, as GitHub serves it to the person now; public only. */
async function declared(ctx: ActionContext<WikiParsed>): Promise<RepoInfo> {
  const repo = ctx.target.repo!;
  const info = "id" in repo ? await ctx.session.repos.getById({ forge: repo.forge, id: repo.id }) : await ctx.session.repos.get({ forge: repo.forge, owner: repo.owner, name: repo.name });
  if ("id" in repo && info.key.id !== repo.id) throw new ForgeProblem(502, "mismatch", "GitHub answered for another repository: nothing was done.");
  if (info.visibility !== "public") throw new ForgeProblem(403, "not_public", "The registry works on public repositories only: nothing was done.");
  return info;
}

function changesOf(p: WikiParsed): FileChange[] {
  const out: FileChange[] = [];
  for (const page of p.pages) {
    if (page.content === null) out.push({ op: "delete", path: wikiFile(page.slug) });
    else out.push({ op: "put", path: wikiFile(page.slug), content: utf8(page.content) });
  }
  if (p.sidebar !== undefined) out.push(p.sidebar === null ? { op: "delete", path: "_Sidebar.md" } : { op: "put", path: "_Sidebar.md", content: utf8(p.sidebar) });
  if (p.footer !== undefined) out.push(p.footer === null ? { op: "delete", path: "_Footer.md" } : { op: "put", path: "_Footer.md", content: utf8(p.footer) });
  return out;
}

export const wikiSpec: ActionSpec<WikiParsed, WikiDone> = {
  kind: "wiki_edit",
  needsRepo: false,
  checkTarget(target: ActionTarget): ForgeProblem | null {
    if (!target.repo) return new ForgeProblem(400, "bad_request", "A wiki commit names the repository.");
    if (target.branch !== WIKI_BRANCH) return new ForgeProblem(400, "bad_request", "The wiki lives on the repository's wiki branch.");
    return null;
  },
  validate: validateWiki,
  describe: describeWiki,
  async perform(ctx) {
    const p = ctx.parsed;
    if (p.createFrom === null && p.base !== ctx.target.expectedHead) {
      throw bad("This change was prepared for another version of the wiki: nothing was done. Go back to the page, then commit again.");
    }
    const info = await declared(ctx);
    const signer = info.signoffRequired ? { login: ctx.github.login, id: ctx.github.id } : null;
    const notes: string[] = [];
    if (signer) notes.push("The repository asks web commits to be signed off: the commit carries your Signed-off-by line.");
    let done;
    try {
      done = await ctx.session.git.createCommit(info.ref, {
        branch: WIKI_BRANCH,
        expectedHead: p.createFrom ? null : p.base,
        ...(p.createFrom ? { createFrom: p.createFrom } : {}),
        changes: changesOf(p),
        message: commitMessage({ message: p.message, description: p.description, coAuthors: [] }, signer),
      });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "forbidden") {
        throw new ForgeProblem(403, "forbidden", "GitHub says your account may not write to this repository's wiki branch: nothing was done.");
      }
      if (p.createFrom && e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "wiki_exists", "The repository already has a wiki branch: reload the wiki, then edit it. Your change is kept in this browser.");
      }
      throw e;
    }
    const firstEdited = p.pages.find((x) => x.content !== null);
    const slug = firstEdited?.slug ?? "Home";
    const page = wikiPageUrl(info.ref.owner, info.ref.name, slug);
    const commitPage = `/r/${info.ref.owner.toLowerCase()}/${info.ref.name.toLowerCase()}/commit/${done.sha}/`;
    return {
      result: {
        id: info.key.id,
        owner: info.ref.owner,
        name: info.ref.name,
        branch: done.branch,
        sha: done.sha,
        base: { branch: WIKI_BRANCH, sha: done.parents[0] ?? "" },
        newBranch: p.createFrom !== null,
        page,
        links: [
          { href: page, text: "The wiki page" },
          { href: commitPage, text: "The commit" },
        ],
        notes,
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id, branch: done.branch },
    };
  },
  check: (r, p, ctx) =>
    OBJECT_ID.test(r.sha) &&
    r.id === (ctx.target.repo && "id" in ctx.target.repo ? ctx.target.repo.id : r.id) &&
    r.branch === WIKI_BRANCH &&
    (p.createFrom !== null || r.base.sha === p.base),
};

export const WIKI_ACTIONS: readonly AnyActionSpec[] = [wikiSpec];
