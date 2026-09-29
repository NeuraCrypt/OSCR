// One web commit as an authorized action (night phase 03, E1; docs/WEB_EDITING.md; D00-7, D03-*).
// The registry's editor (edit, create, rename, move, delete, upload: src/scripts/repo-edit.ts,
// repo-upload.ts) declares the repository, the branch and the head it read (start's target); the
// person approves on GitHub; here, as the person, ONE commit is made by GitHub:
// - the ordinary case (puts and deletes, no executable bit) is `createCommitOnBranch`: one request
//   whatever the number of files, `expectedHeadOid` = the head the page saw, so a branch that moved
//   fails (409 `conflict`, offer "new_branch": the page keeps the draft and offers a new branch);
// - moves (no content re-sent) and executable bits use the Git data API (GitBackend decides:
//   github/git.ts), whose ref update refuses anything but a fast-forward from that head;
// - a new branch (`newBranch`) is made at the head the page saw, then the commit goes on it: the
//   pull request itself is phase 04's (the result names its base and head: `pullRequest`);
// - "propose changes": when GitHub says the person may not write to the repository, and the page
//   allowed it (`propose`), GitHub forks the repository into the person's account and the commit
//   goes on a new branch of the fork, made at the same head (objects are shared in a fork network).
// GitHub signs the commit and the person is its author (their own address settings on GitHub, never
// one the registry picks: D00-14). The message gets trailers the registry builds, never an address
// the person typed: `Co-authored-by` with GitHub's no-reply address of each co-author (their login
// and numeric id, which the page read from GitHub's public API), and `Signed-off-by` with the
// no-reply address of the account GitHub says authorized the action, when the person signs off or
// the repository requires it (GitHub's `web_commit_signoff_required`).
//
// The payload (≤ ACTION_PAYLOAD_BYTES, 1 MiB; ≤ COMMIT_FILES changes):
//   {branch, base, newBranch?, propose?, message, description?, coAuthors?: [{login, id}],
//    signOff?, changes: [{op: "put", path, text | base64, executable?} | {op: "delete", path} |
//    {op: "move", from, to}]}
// `branch` and `base` repeat the target (start's branch and expectedHead): the sentence names the
// branch, and a payload prepared for another branch or head is refused. Nothing is written to D1 but
// the action row (1 row). The file contents never reach D1 or a log.

import { GitBackendError } from "../errors.ts";
import { fromBase64, utf8 } from "../objects.ts";
import { MESSAGE_BYTES } from "../limits.ts";
import { checkChanges, checkPath, isObjectId, isRefName, LOGIN } from "../paths.ts";
import type { FileChange, RepoInfo, RepoRef } from "../types.ts";
import { COMMIT_FILES } from "./caps.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type ActionTarget, type AnyActionSpec } from "./types.ts";

/** A change as the page sends it: a text as text, bytes as base64. */
export type PayloadChange =
  | { op: "put"; path: string; text: string; executable?: boolean }
  | { op: "put"; path: string; base64: string; executable?: boolean }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

export interface CoAuthor {
  login: string;
  /** GitHub's numeric id (the no-reply address is "<id>+<login>@users.noreply.github.com"). */
  id: string;
}

export interface CommitPayload {
  branch: string;
  base: string;
  newBranch?: string;
  propose?: boolean;
  message: string;
  description?: string;
  coAuthors?: CoAuthor[];
  signOff?: boolean;
  changes: PayloadChange[];
}

export interface CommitParsed {
  branch: string;
  base: string;
  newBranch: string | null;
  propose: boolean;
  message: string;
  description: string;
  coAuthors: CoAuthor[];
  signOff: boolean;
  changes: FileChange[];
  /** What the sentence counts. */
  counts: { edited: number; deleted: number; moved: number };
}

export interface CommitDone {
  /** The repository the page declared (its forge id). */
  id: string;
  /** Where the commit is: the repository, or the person's fork when proposed. */
  owner: string;
  name: string;
  sha: string;
  /** The branch that received the commit. */
  branch: string;
  /** The branch the page showed, and its head then (the commit's parent). */
  base: { branch: string; sha: string };
  newBranch: boolean;
  /** Made on the person's fork ("propose changes"). */
  proposed: boolean;
  /** The commit's page in the registry's viewer (a /r/ path). */
  page: string;
  /** The comparison of the new branch with the branch it came from, in the registry's viewer. */
  compare: string | null;
  /** Phase 04's hook: the pull request to open (base ← head), or null for a commit on the branch. */
  pullRequest: { repo: string; base: string; head: string } | null;
  /** The pages the callback page links to, all in the registry's viewer: the file (or folder) as
   *  committed, the commit, the comparison. */
  links: { href: string; text: string }[];
  notes: string[];
}

/** The summary line's length at most (GitHub shows 72 characters, and cuts the rest). */
export const SUMMARY_CHARS = 500;
/** The extended description's length at most. */
export const DESCRIPTION_CHARS = 60_000;
/** Co-authors of one commit at most. */
export const CO_AUTHORS = 10;
/** GitHub's no-reply domain: the only address the registry ever writes into a commit (D00-14). */
export const NOREPLY_DOMAIN = "users.noreply.github.com";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const NUMERIC_ID = /^[0-9]{1,20}$/;

/** A branch name as the site takes it: a ref name, and no "refs/" prefix. */
const isBranchName = (v: unknown): v is string => isRefName(v) && !String(v).startsWith("refs/");

/** GitHub's no-reply address of an account: its id and its login. */
export const noreply = (a: CoAuthor): string => `${a.id}+${a.login}@${NOREPLY_DOMAIN}`;

/** The commit message the registry sends: the summary, the description, then the trailers
 *  (co-authors, then the sign-off), as git and GitHub read them (the last paragraph). */
export function commitMessage(p: Pick<CommitParsed, "message" | "description" | "coAuthors">, signer: CoAuthor | null): string {
  const trailers = [
    ...p.coAuthors.map((a) => `Co-authored-by: ${a.login} <${noreply(a)}>`),
    ...(signer ? [`Signed-off-by: ${signer.login} <${noreply(signer)}>`] : []),
  ];
  return [p.message.trim(), p.description.trim(), trailers.join("\n")].filter(Boolean).join("\n\n");
}

/** The changes of the payload as GitBackend's, checked (paths, duplicates), or the problem. */
function readChanges(raw: unknown): { changes: FileChange[]; counts: CommitParsed["counts"] } | ForgeProblem {
  if (!Array.isArray(raw) || raw.length === 0) return bad("The commit changes no file.");
  if (raw.length > COMMIT_FILES) return bad(`A commit from the browser changes at most ${COMMIT_FILES} files: git can make larger ones.`);
  const out: FileChange[] = [];
  const counts = { edited: 0, deleted: 0, moved: 0 };
  for (const c of raw) {
    if (!isObject(c)) return bad("A change is not readable.");
    if (c.op === "put") {
      if (typeof c.path !== "string") return bad("A file's path is missing.");
      let content: Uint8Array;
      if (typeof c.text === "string" && c.base64 === undefined) content = utf8(c.text);
      else if (typeof c.base64 === "string" && c.text === undefined && BASE64.test(c.base64) && c.base64.length % 4 === 0) content = fromBase64(c.base64);
      else return bad(`The content of ${String(c.path).slice(0, 200)} is not readable.`);
      if (c.executable !== undefined && typeof c.executable !== "boolean") return bad("The executable flag is not true or false.");
      out.push({ op: "put", path: c.path, content, executable: c.executable === true });
      counts.edited += 1;
    } else if (c.op === "delete") {
      if (typeof c.path !== "string") return bad("A file's path is missing.");
      out.push({ op: "delete", path: c.path });
      counts.deleted += 1;
    } else if (c.op === "move") {
      if (typeof c.from !== "string" || typeof c.to !== "string") return bad("A move names the file and where it goes.");
      out.push({ op: "move", from: c.from, to: c.to });
      counts.moved += 1;
    } else return bad("A change is not an edit, a deletion or a move.");
  }
  try {
    return { changes: checkChanges(out), counts };
  } catch (e) {
    if (e instanceof GitBackendError) {
      return bad(/twice/.test(e.message) ? "The same file appears twice in the commit." : "A file's path is not one a repository may hold (an empty part, “.”, “..” or “.git”).");
    }
    throw e;
  }
}

function readCoAuthors(raw: unknown): CoAuthor[] | ForgeProblem {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > CO_AUTHORS) return bad(`At most ${CO_AUTHORS} co-authors, named by their GitHub accounts.`);
  const out: CoAuthor[] = [];
  for (const a of raw) {
    if (!isObject(a) || typeof a.login !== "string" || !LOGIN.test(a.login) || typeof a.id !== "string" || !NUMERIC_ID.test(a.id)) {
      return bad("A co-author is a GitHub account: its login and its numeric id.");
    }
    if (out.some((x) => x.id === a.id)) return bad(`${a.login} is named twice among the co-authors.`);
    out.push({ login: a.login, id: a.id });
  }
  return out;
}

export function validateCommit(payload: unknown): CommitParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The commit is not readable.");
  const p = payload;
  if (!isBranchName(p.branch)) return bad("The branch is not a branch name.");
  if (!isObjectId(p.base)) return bad("The branch's head the change was made on is missing.");
  if (p.newBranch !== undefined && p.newBranch !== null && !isBranchName(p.newBranch)) return bad("The new branch's name is not a branch name.");
  if (p.newBranch === p.branch) return bad("The new branch has the name of the branch it starts from.");
  if (p.propose !== undefined && typeof p.propose !== "boolean") return bad("The proposal choice is not true or false.");
  if (typeof p.message !== "string" || !p.message.trim()) return bad("Write a commit message: one line that says what the change does.");
  if (/[\r\n]/.test(p.message.trim())) return bad("The commit message is one line; the description takes the rest.");
  if (p.message.length > SUMMARY_CHARS) return bad(`The commit message is one line of at most ${SUMMARY_CHARS} characters; the description takes the rest.`);
  if (p.description !== undefined && (typeof p.description !== "string" || p.description.length > DESCRIPTION_CHARS)) {
    return bad(`The description is at most ${DESCRIPTION_CHARS.toLocaleString("en-GB")} characters.`);
  }
  if (p.signOff !== undefined && typeof p.signOff !== "boolean") return bad("The sign-off choice is not true or false.");
  const coAuthors = readCoAuthors(p.coAuthors);
  if (coAuthors instanceof ForgeProblem) return coAuthors;
  const read = readChanges(p.changes);
  if (read instanceof ForgeProblem) return read;
  const parsed: CommitParsed = {
    branch: p.branch,
    base: p.base as string,
    newBranch: typeof p.newBranch === "string" ? p.newBranch : null,
    propose: p.propose === true,
    message: p.message.trim(),
    description: typeof p.description === "string" ? p.description.replace(/\r\n?/g, "\n").trim() : "",
    coAuthors,
    signOff: p.signOff === true,
    changes: read.changes,
    counts: read.counts,
  };
  // The whole message, with the longest trailers the Worker may add, fits git's and the forge's cap.
  const longest = commitMessage(parsed, { login: "x".repeat(39), id: "9".repeat(20) });
  if (new TextEncoder().encode(longest).byteLength > MESSAGE_BYTES) return bad("The commit message and its description are too long for one commit.");
  return parsed;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the commit does, in words: "2 files changed, 1 deleted". */
export function changesInWords(counts: CommitParsed["counts"]): string {
  const parts: string[] = [];
  if (counts.edited) parts.push(`${plural(counts.edited, "file")} written`);
  if (counts.moved) parts.push(`${plural(counts.moved, "file")} moved`);
  if (counts.deleted) parts.push(`${plural(counts.deleted, "file")} deleted`);
  return parts.join(", ");
}

export function describeCommit(p: CommitParsed): string {
  const where = p.newBranch ? `on a new branch ${p.newBranch}, from ${p.branch}` : `to the branch ${p.branch}`;
  const also = [
    p.coAuthors.length ? `with ${plural(p.coAuthors.length, "co-author")}` : "",
    p.signOff ? "signed off" : "",
  ].filter(Boolean);
  // A proposal from a fork is said before it is made: GitHub makes a copy in the person's account.
  const fork = p.propose ? "; if GitHub says you may not write to the repository, on a new branch of your own copy of it (a fork)" : "";
  return `Commit “${p.message}” ${where} (${changesInWords(p.counts)}${also.length ? `; ${also.join(", ")}` : ""}${fork})`;
}

/** The target a commit needs: a repository, a branch and the head the page saw. */
export function commitTarget(target: ActionTarget): ForgeProblem | null {
  if (!target.repo || !target.branch || !target.expectedHead) {
    return new ForgeProblem(400, "bad_request", "A commit names the repository, the branch and the head the page read.");
  }
  return null;
}

const WRITES = new Set(["write", "maintain", "admin"]);
const pageOf = (ref: RepoRef): string => `/r/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}/`;
/** A /r/ path of the registry's viewer, when its characters are ones a page's link keeps (a fork's
 *  branch in a comparison is "owner:branch"). */
const viewerPath = (base: string, rest: string): string | null => {
  const path = `${base}${rest}`;
  return /^\/r\/[A-Za-z0-9._~\-/:%]{1,400}$/.test(path) ? path : null;
};

/** The repository the page declared, as GitHub serves it now to the person. */
async function declared(ctx: ActionContext<CommitParsed>): Promise<RepoInfo> {
  const repo = ctx.target.repo!;
  const info = "id" in repo ? await ctx.session.repos.getById({ forge: repo.forge, id: repo.id }) : await ctx.session.repos.get({ forge: repo.forge, owner: repo.owner, name: repo.name });
  if ("id" in repo && info.key.id !== repo.id) throw new ForgeProblem(502, "mismatch", "GitHub answered for another repository: nothing was done.");
  if (info.visibility !== "public") throw new ForgeProblem(403, "not_public", "The registry works on public repositories only: nothing was done.");
  return info;
}

export const commitSpec: ActionSpec<CommitParsed, CommitDone> = {
  kind: "commit",
  needsRepo: false,
  checkTarget: commitTarget,
  validate: validateCommit,
  describe: describeCommit,
  async perform(ctx) {
    const p = ctx.parsed;
    // The payload was prepared for the branch and the head the page declared: nothing else.
    if (p.branch !== ctx.target.branch || p.base !== ctx.target.expectedHead) {
      throw bad("This change was prepared for another branch or another version of it: nothing was done. Go back to the page, then commit again.");
    }
    const info = await declared(ctx);
    const signer = p.signOff || info.signoffRequired ? { login: ctx.github.login, id: ctx.github.id } : null;
    const message = commitMessage(p, signer);
    const notes: string[] = [];
    if (info.signoffRequired && !p.signOff) notes.push("The repository asks web commits to be signed off: the commit carries your Signed-off-by line.");
    const mayWrite = info.permission === null || WRITES.has(info.permission);

    let where: RepoInfo = info;
    let branch = p.newBranch ?? p.branch;
    let createFrom: string | undefined = p.newBranch ? p.base : undefined;
    let proposed = false;
    if (!mayWrite) {
      if (!p.propose) {
        throw new ForgeProblem(403, "forbidden", "GitHub says your account may not write to this repository. Propose the change instead: GitHub makes your own copy (a fork) and the change goes on a branch there.", { offer: "propose" });
      }
      // Propose changes: the person's fork (GitHub makes it, or finds the one they have), a new
      // branch there at the head the page saw.
      const fork = await ctx.session.repos.fork(info.ref);
      where = fork.repo;
      branch = p.newBranch ?? `${ctx.github.login}-patch-${p.base.slice(0, 7)}`;
      createFrom = p.base;
      proposed = true;
      notes.push(
        `GitHub said your account may not write to ${info.ref.owner}/${info.ref.name}: the change is on the branch ${branch} of your own copy, ${where.ref.owner}/${where.ref.name}, to propose from there.`,
      );
      if (!fork.ready) notes.push("GitHub made that copy (a fork) for this change.");
    }
    let done;
    try {
      done = await ctx.session.git.createCommit(where.ref, {
        branch,
        expectedHead: createFrom ? null : p.base,
        ...(createFrom ? { createFrom } : {}),
        changes: p.changes,
        message,
      });
    } catch (e) {
      if (proposed && e instanceof GitBackendError && (e.code === "not_found" || e.code === "invalid")) {
        throw new ForgeProblem(409, "fork_not_ready", "GitHub is still copying the repository into your account: wait a minute, then commit again. Your change is kept in this browser.");
      }
      if (createFrom && e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "branch_exists", `A branch named ${branch} already exists there: choose another name, then commit again. Your change is kept in this browser.`);
      }
      throw e;
    }
    const base = pageOf(where.ref);
    const target = pageOf(info.ref);
    const segments = (s: string) => s.split("/").map(encodeURIComponent).join("/");
    const branchSegments = segments(done.branch);
    const compare = createFrom
      ? viewerPath(target, `compare/${p.branch.split("/").map(encodeURIComponent).join("/")}...${proposed ? `${where.ref.owner}:` : ""}${branchSegments}/`)
      : null;
    // The file as committed (the first one written or moved), else the folder a deletion emptied.
    const written = p.changes.find((c) => c.op === "put" || c.op === "move");
    const deleted = p.changes.find((c) => c.op === "delete");
    const view = written
      ? viewerPath(base, `blob/${branchSegments}/${segments(written.op === "move" ? written.to : written.path)}`)
      : deleted && deleted.path.includes("/")
        ? viewerPath(base, `tree/${branchSegments}/${segments(deleted.path.slice(0, deleted.path.lastIndexOf("/")))}/`)
        : viewerPath(base, `tree/${branchSegments}/`);
    const commitPage = viewerPath(base, `commit/${done.sha}/`) ?? base;
    const links = [
      view ? { href: view, text: written ? (p.changes.length > 1 ? "The first file, as committed" : "The file, as committed") : "The folder, after the deletion" } : null,
      { href: commitPage, text: "The commit" },
      compare ? { href: compare, text: `The comparison with ${p.branch}` } : null,
    ].filter((l): l is { href: string; text: string } => l !== null);
    return {
      result: {
        id: info.key.id,
        owner: where.ref.owner,
        name: where.ref.name,
        sha: done.sha,
        branch: done.branch,
        // GitHub's answer: the commit's parent, which the check compares with the head the page saw.
        base: { branch: p.branch, sha: done.parents[0] ?? "" },
        newBranch: createFrom !== undefined,
        proposed,
        page: commitPage,
        compare,
        pullRequest: createFrom ? { repo: `${info.ref.owner}/${info.ref.name}`, base: p.branch, head: proposed ? `${where.ref.owner}:${done.branch}` : done.branch } : null,
        links,
        notes,
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id, branch: done.branch },
    };
  },
  check: (r, p, ctx) =>
    isObjectId(r.sha) &&
    r.id === (ctx.target.repo && "id" in ctx.target.repo ? ctx.target.repo.id : r.id) &&
    r.branch === (r.proposed ? r.branch : (p.newBranch ?? p.branch)) &&
    r.base.sha === p.base,
};

/** A path as the page may name it (the editor's own check, before anything is sent). */
export function isRepoPath(path: unknown): path is string {
  try {
    checkPath(path);
    return true;
  } catch {
    return false;
  }
}

export const COMMIT_ACTIONS: readonly AnyActionSpec[] = [commitSpec];
