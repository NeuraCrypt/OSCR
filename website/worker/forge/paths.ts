// Names, refs and paths, checked before any request: a failure is `invalid` and nothing is sent
// to the forge (the contract suite checks that such a call costs nothing).
//
// - Owner and repository segments: ^(?!\.+$)[A-Za-z0-9._-]{1,100}$, the `SEGMENT` of
//   account/repo.ts. A repository name must also not end in ".git".
// - Branch and tag names: a subset of `git check-ref-format`, at most 255 bytes. None of: an
//   empty component, "..", a component starting with "." or ending with ".lock", the characters
//   ~^:?*[\ or a space, control characters, "@{", a leading or trailing "/", the name "@".
// - File paths: relative, "/"-separated, NFC-normalized, at most 4,096 bytes; no empty
//   component, no "." or "..", no component named ".git" in any letter case, no NUL. The same
//   path may not appear twice in one commit.
// - Commit messages up to 64 KiB; issue, pull-request and comment bodies up to 65,536 characters.

import { invalid } from "./errors.ts";
import { BODY_CHARS, MESSAGE_BYTES } from "./limits.ts";
import type { CommitInput, FileChange, ObjectId, PageRequest, RepoRef, Rev } from "./types.ts";

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

export const SEGMENT = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
/** A forge login (GitHub: letters, digits, hyphens; an underscore in managed accounts). */
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function checkOwner(owner: unknown): string {
  if (typeof owner !== "string" || !SEGMENT.test(owner)) throw invalid("not an account name");
  return owner;
}

export function checkRepoName(name: unknown): string {
  if (typeof name !== "string" || !SEGMENT.test(name) || /\.git$/i.test(name)) throw invalid("not a repository name");
  return name;
}

export function checkRepo(repo: RepoRef): RepoRef {
  if (!repo || typeof repo !== "object") throw invalid("no repository");
  checkOwner(repo.owner);
  checkRepoName(repo.name);
  return repo;
}

export function checkLogin(login: unknown): string {
  if (typeof login !== "string" || !LOGIN.test(login)) throw invalid("not a login");
  return login;
}

/** Whether `name` is a branch or tag name OSCR accepts (a subset of git check-ref-format). */
export function isRefName(name: unknown): name is string {
  if (typeof name !== "string" || !name || name === "@" || byteLength(name) > 255) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.includes("..") || name.includes("@{")) return false;
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
}

export function checkRefName(name: unknown, what = "branch or tag"): string {
  if (!isRefName(name)) throw invalid(`not a ${what} name`);
  return name;
}

export function isObjectId(sha: unknown): sha is ObjectId {
  return typeof sha === "string" && OBJECT_ID.test(sha);
}

export function checkObjectId(sha: unknown): ObjectId {
  if (!isObjectId(sha)) throw invalid("not a full object id");
  return sha;
}

/** A revision: a full object id, a branch or tag name, or "refs/…". */
export function checkRev(rev: unknown): Rev {
  if (isObjectId(rev) || isRefName(rev)) return rev as Rev;
  throw invalid("not a revision");
}

/** A file path as the forge stores it: NFC, relative, "/"-separated; "" is the root only where
 *  `root` is allowed. */
export function checkPath(path: unknown, root = false): string {
  if (typeof path !== "string") throw invalid("not a path");
  if (root && path === "") return "";
  const p = path.normalize("NFC");
  if (!p || byteLength(p) > 4096 || p.includes("\u0000")) throw invalid("not a path");
  for (const c of p.split("/")) {
    if (c === "" || c === "." || c === ".." || c.toLowerCase() === ".git") throw invalid("not a path");
  }
  return p;
}

export function checkMessage(message: unknown): string {
  if (typeof message !== "string" || !message.trim() || byteLength(message) > MESSAGE_BYTES) throw invalid("not a commit message");
  return message;
}

export function checkBody(body: unknown, what = "body", required = false): string {
  if (body === undefined || body === null) {
    if (required) throw invalid(`no ${what}`);
    return "";
  }
  if (typeof body !== "string" || body.length > BODY_CHARS || (required && !body.trim())) throw invalid(`not a ${what}`);
  return body;
}

export function checkTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim() || title.length > 256) throw invalid("not a title");
  return title;
}

export function checkNumber(n: unknown, what = "number"): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 2 ** 31) throw invalid(`not an ${what}`);
  return n;
}

/** A forge id as text: decimal digits (GitHub) or a GraphQL node id. */
export function checkId(id: unknown, what = "id"): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_=-]{1,100}$/.test(id)) throw invalid(`not a ${what}`);
  return id;
}

/** The page asked for: `perPage` 1 to 100 (default 30); the cursor is checked by the backend. */
export function checkPage(page: PageRequest | undefined, max = 100): { cursor: string | null; perPage: number } {
  const perPage = page?.perPage ?? 30;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > max) throw invalid(`perPage is 1 to ${max}`);
  const cursor = page?.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length > 200)) throw invalid("not a page cursor");
  return { cursor, perPage };
}

/** The changes of one commit, their paths normalized; a path named twice is `invalid`. */
export function checkChanges(changes: FileChange[]): FileChange[] {
  if (!Array.isArray(changes)) throw invalid("no changes");
  const seen = new Set<string>();
  const use = (p: string) => {
    if (seen.has(p)) throw invalid("a path appears twice in one commit");
    seen.add(p);
  };
  return changes.map((c) => {
    if (!c || typeof c !== "object") throw invalid("not a change");
    if (c.op === "put") {
      const path = checkPath(c.path);
      use(path);
      if (!(c.content instanceof Uint8Array)) throw invalid("a put needs bytes");
      return { op: "put", path, content: c.content, executable: c.executable === true };
    }
    if (c.op === "delete") {
      const path = checkPath(c.path);
      use(path);
      return { op: "delete", path };
    }
    if (c.op === "move") {
      const from = checkPath(c.from);
      const to = checkPath(c.to);
      if (from === to) throw invalid("a move to the same path");
      use(from);
      use(to);
      return { op: "move", from, to };
    }
    throw invalid("not a change");
  });
}

/** A commit's input, checked: the branch, the head, the parents, the changes, the message. */
export function checkCommitInput(input: CommitInput): CommitInput {
  if (!input || typeof input !== "object") throw invalid("no commit");
  checkRefName(input.branch, "branch");
  checkMessage(input.message);
  if (input.expectedHead !== null) checkObjectId(input.expectedHead);
  if (input.createFrom !== undefined) checkObjectId(input.createFrom);
  if (input.parents !== undefined) {
    if (!Array.isArray(input.parents) || input.parents.length > 2) throw invalid("a commit has at most two parents here");
    input.parents.forEach(checkObjectId);
  }
  const orphan = input.parents !== undefined && input.parents.length === 0;
  if (input.expectedHead === null && input.createFrom === undefined && !orphan) throw invalid("expectedHead is needed");
  if (input.createFrom !== undefined && input.expectedHead !== null && input.expectedHead !== input.createFrom) {
    throw invalid("a new branch starts at createFrom");
  }
  return { ...input, changes: checkChanges(input.changes) };
}
