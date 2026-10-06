// Snippets as authorized actions (night phase 13; docs/SNIPPETS.md; D00-2, D00-4, D00-14, D13-*).
// A snippet's FILES live in a `snippets` repository in the researcher's OWN GitHub account, one folder
// per snippet. Creating, revising and forking a snippet is ONE commit made by GitHub as the person
// (the phase-03 model, act-commit.ts): OSCR never asks for the Gists permission (D00-14) and never
// writes to GitHub itself. The record is written to oscr_forge in the same batch as the action row;
// the files' content never reaches D1 (the manifest does: snippets-core.ts).
//
//   snippet_create  {title, description?, visibility?, files:[{path,content}], passage?}
//   snippet_revise  {id, files:[{path,content}], title?, description?, passage?}
//   snippet_fork    {id}
//
// Each resolves the person's own `snippets` repository (never one a payload names: the action always
// acts on ctx.github.login's `snippets` repo, so it can never be aimed at someone else's), creating it
// with a README on the first snippet. The folder is a slug of the title, kept unique in the account.
// A revision and a fork read the record first (the owner revises their own; a fork reads a public or
// unlisted snippet's files from GitHub). GitHub's answer (a commit id in the person's account) is
// checked before the record is recorded.

import { randomToken } from "../../account/crypto.ts";
import { GitBackendError } from "../errors.ts";
import type { FileChange, RepoInfo, RepoRef } from "../types.ts";
import {
  EMPTY_PASSAGE,
  insertSnippet,
  bumpForks,
  parseManifest,
  passageOf,
  slugify,
  snippetById,
  snippetByHandle,
  updateSnippet,
  validateCreate,
  validateRevise,
  type CreateParsed,
  type FileMeta,
  type Passage,
  type Person,
  type ReviseParsed,
  type SnippetRow,
} from "./snippets-core.ts";
import { first } from "./store.ts";
import { personOf } from "./research-core.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec, type D1Database, type Write } from "./types.ts";

/** The repository a researcher's snippets live in (D13-*). */
export const SNIPPETS_REPO = "snippets";

export interface SnippetDone {
  /** The record's handle: the owner's login and the folder. The page resolves the numeric id from it
   *  (POST does not surface D1's last_row_id through the authorized-action flow). */
  owner: string;
  folder: string;
  repoId: string;
  revision: string;
  /** The snippet's page in the registry. */
  page: string;
  /** For a fork: the snippet it came from. */
  forkedFrom: number | null;
  notes: string[];
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

/** The person's `snippets` repository, created with a README on the first snippet (public: D00-14;
 *  an unlisted snippet still lives in a public repository, said on the form). */
async function ensureSnippetsRepo(ctx: ActionContext<unknown>): Promise<RepoInfo> {
  const ref: RepoRef = { forge: ctx.backend.forge, owner: ctx.github.login, name: SNIPPETS_REPO };
  try {
    const info = await ctx.session.repos.get(ref);
    if (info.visibility !== "public") throw new ForgeProblem(409, "not_public", "Your `snippets` repository is not public on GitHub: snippets are shown from a public repository. Make it public, or rename it, then try again.");
    return info;
  } catch (e) {
    if (!(e instanceof GitBackendError) || (e.code !== "not_found" && e.code !== "gone")) throw e;
  }
  return ctx.session.repos.create({
    name: SNIPPETS_REPO,
    description: "Snippets shared through the registry.",
    visibility: "public",
    autoInit: true,
  });
}

/** A folder for a new snippet: a slug of the title, kept unique in the account (a short suffix when
 *  taken). One read by the handle key. */
async function freeFolder(db: D1Database, ownerLogin: string, title: string): Promise<string> {
  const base = slugify(title);
  if (!(await first(snippetByHandle(db, ownerLogin, base)))) return base;
  const suffix = randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "x";
  return `${base.slice(0, 54)}-${suffix}`;
}

/** The author's role on a snippet: a verified author of the paper the passage names, else "". One
 *  read of the person's roles by key. */
async function roleForPassage(community: D1Database, userId: string, passage: Passage): Promise<SnippetRow["author_role"]> {
  if (!passage.paperId) return "";
  const row = await first(
    community.prepare("SELECT 1 AS x FROM roles WHERE user_id = ? AND role = 'verified_author' AND scope_kind = 'paper' AND scope_id = ?").bind(userId, passage.paperId),
  );
  return row ? "verified_author" : "";
}

/** The head of the repository's default branch, or null for an empty repository. */
async function headOf(ctx: ActionContext<unknown>, info: RepoInfo): Promise<{ branch: string; head: string } | null> {
  if (!info.defaultBranch) return null;
  try {
    const head = await ctx.session.git.resolve(info.ref, info.defaultBranch);
    return { branch: info.defaultBranch, head };
  } catch (e) {
    if (e instanceof GitBackendError && (e.code === "not_found" || e.code === "conflict")) return null;
    throw e;
  }
}

/** One commit that writes `changes` to the repository's default branch; a branch that moved is tried
 *  once more at the new head. */
async function commitChanges(ctx: ActionContext<unknown>, info: RepoInfo, changes: FileChange[], message: string): Promise<string> {
  const at = await headOf(ctx, info);
  if (!at) throw new ForgeProblem(409, "no_branch", "Your `snippets` repository has no branch yet: nothing was done. Try again in a moment.");
  try {
    return (await ctx.session.git.createCommit(info.ref, { branch: at.branch, expectedHead: at.head, changes, message })).sha;
  } catch (e) {
    if (e instanceof GitBackendError && e.code === "conflict") {
      const again = await headOf(ctx, info);
      if (again) return (await ctx.session.git.createCommit(info.ref, { branch: again.branch, expectedHead: again.head, changes, message })).sha;
    }
    throw e;
  }
}

/** The changes for a snippet folder: every file under "<folder>/", and the files the folder no longer
 *  holds deleted (a revision that drops a file). */
function folderChanges(folder: string, puts: FileChange[], previous: FileMeta[] = []): FileChange[] {
  const keep = new Set(puts.map((c) => c.path.toLowerCase()));
  const out: FileChange[] = puts.map((c) => ({ ...c, path: `${folder}/${c.path}` }));
  for (const old of previous) if (!keep.has(old.path.toLowerCase())) out.push({ op: "delete", path: `${folder}/${old.path}` });
  return out;
}

const pageOf = (owner: string, folder: string): string => `/snippet/${owner.toLowerCase()}/${folder.toLowerCase()}/`;

// ─── create ────────────────────────────────────────────────────────────────────

export const snippetCreateSpec: ActionSpec<CreateParsed, SnippetDone> = {
  kind: "snippet_create",
  needsRepo: false,
  checkTarget: (t) => (t.repo || t.branch || t.expectedHead ? new ForgeProblem(400, "bad_request", "A snippet is made in your own snippets repository: it names no other.") : null),
  validate: validateCreate,
  describe: (p) => `Create the ${p.visibility} snippet “${p.title}” in your snippets repository (${p.files.length} ${p.files.length === 1 ? "file" : "files"})`,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await ensureSnippetsRepo(ctx as ActionContext<unknown>);
    const folder = await freeFolder(ctx.db, ctx.github.login, p.title);
    const sha = await commitChanges(ctx as ActionContext<unknown>, info, folderChanges(folder, p.changes), `Add snippet: ${p.title}`);
    const who: Person = personOf(ctx.user);
    const role = await roleForPassage(ctx.community, ctx.user.id, p.passage);
    const write: Write = insertSnippet(ctx.db, {
      ownerId: info.owner.id, ownerLogin: info.ref.owner, forge: info.key.forge, repoId: info.key.id, folder, revision: sha,
      visibility: p.visibility, title: p.title, description: p.description, manifest: p.manifest, passage: p.passage, forkedFrom: null, who, role,
    }, ctx.t);
    return {
      result: { owner: info.ref.owner.toLowerCase(), folder, repoId: info.key.id, revision: sha, page: pageOf(info.ref.owner, folder), forkedFrom: null, notes: [] },
      writes: [write],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, _p, ctx) => /^[0-9a-f]{40,64}$/.test(r.revision) && r.owner === ctx.github.login.toLowerCase() && !!r.folder,
};

// ─── revise ────────────────────────────────────────────────────────────────────

export const snippetReviseSpec: ActionSpec<ReviseParsed, SnippetDone> = {
  kind: "snippet_revise",
  needsRepo: false,
  checkTarget: (t) => (t.repo || t.branch || t.expectedHead ? new ForgeProblem(400, "bad_request", "A revision is a commit in your own snippets repository: it names no other.") : null),
  validate: validateRevise,
  describe: (p) => `Revise the snippet #${p.id} (${p.files.length} ${p.files.length === 1 ? "file" : "files"})`,
  async perform(ctx) {
    const p = ctx.parsed;
    const row = await first<SnippetRow>(snippetById(ctx.db, p.id));
    if (!row) throw new ForgeProblem(404, "not_found", "The registry has no snippet of this number: nothing was done.");
    if (row.owner_id !== ctx.user.id) throw new ForgeProblem(403, "not_owner", "Only the snippet's owner revises it: nothing was done.");
    if (row.owner_login !== ctx.github.login.toLowerCase()) throw new ForgeProblem(403, "not_owner", "This snippet is in another GitHub account: nothing was done.");
    const info = await ctx.session.repos.getById({ forge: row.forge as RepoInfo["key"]["forge"], id: row.repo_id });
    const previous = parseManifest(row.files);
    const sha = await commitChanges(ctx as ActionContext<unknown>, info, folderChanges(row.folder, p.changes, previous), `Update snippet: ${p.title ?? row.title}`);
    const set: Record<string, string | number | null> = { revision: sha, files: JSON.stringify(p.manifest) };
    if (p.title !== null) set.title = p.title;
    if (p.description !== null) set.description = p.description;
    if (p.passage !== null) Object.assign(set, { paper_id: p.passage.paperId, section: p.passage.section, paragraph: p.passage.paragraph, start_line: p.passage.startLine, end_line: p.passage.endLine });
    return {
      result: { owner: row.owner_login, folder: row.folder, repoId: row.repo_id, revision: sha, page: pageOf(row.owner_login, row.folder), forkedFrom: row.forked_from, notes: [] },
      writes: [updateSnippet(ctx.db, p.id, set, ctx.t)],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, _p, ctx) => /^[0-9a-f]{40,64}$/.test(r.revision) && r.owner === ctx.github.login.toLowerCase(),
};

// ─── fork ────────────────────────────────────────────────────────────────────

export interface ForkParsed {
  id: number;
}

export function validateFork(payload: unknown): ForkParsed | ForgeProblem {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || typeof p.id !== "number" || !Number.isInteger(p.id) || p.id < 1 || p.id > 2 ** 31) {
    return bad("Name the snippet to fork by its number.");
  }
  return { id: p.id };
}

export const snippetForkSpec: ActionSpec<ForkParsed, SnippetDone> = {
  kind: "snippet_fork",
  needsRepo: false,
  checkTarget: (t) => (t.repo || t.branch || t.expectedHead ? new ForgeProblem(400, "bad_request", "A fork is a commit in your own snippets repository: it names no other.") : null),
  validate: validateFork,
  describe: (p) => `Fork the snippet #${p.id} into your snippets repository`,
  async perform(ctx) {
    const src = await first<SnippetRow>(snippetById(ctx.db, ctx.parsed.id));
    if (!src) throw new ForgeProblem(404, "not_found", "The registry has no snippet of this number: nothing was done.");
    if (src.hidden) throw new ForgeProblem(410, "hidden", "This snippet is hidden: it cannot be forked. Nothing was done.");
    if (src.owner_login === ctx.github.login.toLowerCase()) throw new ForgeProblem(409, "own_snippet", "This snippet is already in your account: nothing was done.");
    // Read the source files from GitHub, at the pinned revision (a public repository the person reads).
    const srcRef = (await ctx.session.repos.getById({ forge: src.forge as RepoInfo["key"]["forge"], id: src.repo_id })).ref;
    const manifest = parseManifest(src.files);
    const changes: FileChange[] = [];
    for (const f of manifest) {
      let content: Uint8Array;
      try {
        const file = await ctx.session.git.readFile(srcRef, src.revision, `${src.folder}/${f.path}`, { maxBytes: 512 * 1024 });
        content = file.bytes;
      } catch (e) {
        if (e instanceof GitBackendError) throw new ForgeProblem(502, "source_gone", `The snippet's file “${f.path}” could not be read from GitHub: nothing was done.`);
        throw e;
      }
      changes.push({ op: "put", path: f.path, content });
    }
    const info = await ensureSnippetsRepo(ctx as ActionContext<unknown>);
    const folder = await freeFolder(ctx.db, ctx.github.login, src.title);
    const sha = await commitChanges(ctx as ActionContext<unknown>, info, folderChanges(folder, changes), `Fork snippet: ${src.title}`);
    const who: Person = personOf(ctx.user);
    const passage = passageOf(src) ?? EMPTY_PASSAGE;
    const writes: Write[] = [
      insertSnippet(ctx.db, {
        ownerId: info.owner.id, ownerLogin: info.ref.owner, forge: info.key.forge, repoId: info.key.id, folder, revision: sha,
        visibility: "public", title: src.title, description: src.description, manifest, passage, forkedFrom: src.id, who, role: "",
      }, ctx.t),
      bumpForks(ctx.db, src.id, ctx.t),
    ];
    return {
      result: { owner: info.ref.owner.toLowerCase(), folder, repoId: info.key.id, revision: sha, page: pageOf(info.ref.owner, folder), forkedFrom: src.id, notes: [`Forked from snippet #${src.id}.`] },
      writes,
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, _p, ctx) => /^[0-9a-f]{40,64}$/.test(r.revision) && r.owner === ctx.github.login.toLowerCase() && r.forkedFrom !== null,
};

export const SNIPPET_ACTIONS: readonly AnyActionSpec[] = [snippetCreateSpec, snippetReviseSpec, snippetForkSpec];
