// Pull requests as authorized actions (night phase 04, E1; docs/PULL_REQUESTS.md; D00-4, D00-6,
// D00-7, D04-*). The registry's pull request pages (src/scripts/repo-pull*.ts) read pull requests
// in the reader's browser, on the reader's own GitHub quota; every write is ONE authorized action,
// made by GitHub as the person, one authorization each, with the token used once and revoked:
//
//   pull_open     {base, head, title, body?, draft?, maintainerCanModify?, reviewers?}
//                 GitHub opens it (a branch, or "owner:branch" of a fork); reviewers are asked after,
//                 a refusal of theirs said in words (the pull request exists).
//   pull_edit     {number | numbers, title?, body?, base?, state?, draft?, reviewers?: {add?, remove?},
//                 autoMerge?, headBranch?}: edit, close or reopen, change the base, draft or ready,
//                 reviewers asked or removed, auto-merge on or off, the head branch deleted or
//                 restored; `numbers` (≤ 25) closes or reopens several at once (the list's bulk action).
//   pull_review   {number, commit, event, body?, comments?}: Comment, Approve or Request changes at the
//                 commit the page showed, with line, multi-line and deleted-line comments (a suggestion
//                 is a comment whose body holds a ```suggestion block). The author may not approve or
//                 request changes on their own pull request (GitHub's rule, said before GitHub is).
//   pull_comment  {number, body, replyTo?}: a comment on the conversation, or a reply to a review
//                 comment.
//   pull_thread   {number, comment, resolved}: resolve or unresolve the conversation a review comment
//                 starts (GitHub keeps that state in GraphQL only: the Worker finds the thread as the
//                 person, by the comment's id, which the page reads anonymously).
//   pull_merge    {number, method, head, title?, message?, deleteBranch?}: merge commit, squash or
//                 rebase, at the head the page showed (GitHub's compare-and-swap: a head that moved is
//                 409, nothing merged); then the head branch deleted when asked.
//   pull_update   {number, head}: "Update branch" (GitHub merges the base into the head branch); a
//                 conflict is 409 with the offer to resolve it in the registry.
//   pull_revert   {number}: GitHub opens a pull request that reverts a merged one.
//
// The target is the repository the page declared (by GitHub's id, as the page read it); the payload
// names the pull request. The registry writes the action row only (1 row); no title, body, comment
// or login reaches D1 or a log (D00-6: pull requests are GitHub's objects). GitHub decides who may do
// what; its refusals are said in words. A conflict resolved in the browser is phase 03's `commit` with
// `mergeParent` (act-commit.ts), and a suggestion applied is a `commit` on the head branch.

import { GitBackendError } from "../errors.ts";
import { BODY_CHARS } from "../limits.ts";
import { isObjectId, isRefName, LOGIN } from "../paths.ts";
import type { MergeMethod, PullRequest, RepoInfo, RepoRef, ReviewEvent, ReviewLineComment } from "../types.ts";
import { isRepoPath } from "./act-commit.ts";
import { closeByMerge, issueById, researchClosing, type IssueRow } from "./research-core.ts";
import { first } from "./store.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type ActionTarget, type AnyActionSpec, type Write } from "./types.ts";

// ─── shared ──────────────────────────────────────────────────────────────────

/** Pull requests a bulk action changes at most (one authorization, one GitHub request each). */
export const BULK_PULLS = 25;
/** Reviewers asked or removed at once (GitHub's own cap). */
export const REVIEWERS = 15;
/** Line comments in one review at most. */
export const REVIEW_COMMENTS = 100;
/** Pages of review threads the Worker reads to find one (100 a page). */
const THREAD_PAGES = 5;

export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];
export const REVIEW_EVENTS: readonly ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
const isBranchName = (v: unknown): v is string => isRefName(v) && !String(v).startsWith("refs/");
/** A head as GitHub takes it: "branch", or "owner:branch" of a fork. */
export const isHead = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const i = v.indexOf(":");
  return i < 0 ? isBranchName(v) : LOGIN.test(v.slice(0, i)) && isBranchName(v.slice(i + 1));
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "#3", "#3 and #4", "#3, #4 and #7". */
export const numbersInWords = (ns: readonly number[]): string => {
  const t = ns.map((n) => `#${n}`);
  return t.length <= 1 ? (t[0] ?? "") : `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
};
const loginsInWords = (ls: readonly string[]): string => (ls.length <= 1 ? (ls[0] ?? "") : `${ls.slice(0, -1).join(", ")} and ${ls[ls.length - 1]}`);

function readTitle(v: unknown): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad("Give the pull request a title: one line that says what it changes.");
  if (/[\r\n]/.test(v.trim()) || v.trim().length > 256) return bad("The title is one line of at most 256 characters; the description takes the rest.");
  return v.trim();
}

function readBody(v: unknown, what = "The description", required = false): string | ForgeProblem {
  if (v === undefined || v === null) return required ? bad(`${what} is empty.`) : "";
  if (typeof v !== "string") return bad(`${what} is not text.`);
  if (v.length > BODY_CHARS) return bad(`${what} is at most ${BODY_CHARS.toLocaleString("en-GB")} characters.`);
  if (required && !v.trim()) return bad(`${what} is empty.`);
  return v.replace(/\r\n?/g, "\n");
}

function readLogins(v: unknown): string[] | ForgeProblem {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > REVIEWERS) return bad(`At most ${REVIEWERS} reviewers at once, named by their GitHub accounts.`);
  const out: string[] = [];
  for (const l of v) {
    if (typeof l !== "string" || !LOGIN.test(l) || l.length > 39) return bad("A reviewer is a GitHub account: its login.");
    if (out.some((x) => x.toLowerCase() === l.toLowerCase())) return bad(`${l} is named twice.`);
    out.push(l);
  }
  return out;
}

function readNumber(p: Record<string, unknown>): number | ForgeProblem {
  return isNumber(p.number) ? p.number : bad("Name the pull request by its number.");
}

/** A target that names a repository (the kinds of this file act on one). */
export function onDeclaredRepo(target: ActionTarget): ForgeProblem | null {
  return target.repo ? null : new ForgeProblem(400, "bad_request", "This action needs the repository it works on.");
}

const pageOf = (ref: RepoRef): string => `/r/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}/`;
/** The pull request's page in the registry (GitHub's shape after /r/). */
export const pullPage = (ref: RepoRef, number: number, tab = ""): string => `${pageOf(ref)}pull/${number}${tab ? `/${tab}` : ""}`;

/** The repository the page declared, as GitHub serves it now to the person: by its durable id
 *  (GitHub follows renames), public only. */
export async function declaredRepo(ctx: ActionContext<unknown>): Promise<RepoInfo> {
  const repo = ctx.target.repo;
  if (!repo) throw new ForgeProblem(400, "bad_request", "This action needs the repository it works on.");
  const info = "id" in repo ? await ctx.session.repos.getById({ forge: repo.forge, id: repo.id }) : await ctx.session.repos.get({ forge: repo.forge, owner: repo.owner, name: repo.name });
  if ("id" in repo && info.key.id !== repo.id) throw new ForgeProblem(502, "mismatch", "GitHub answered for another repository: nothing was done.");
  if (info.visibility !== "public") throw new ForgeProblem(403, "not_public", "The registry works on public repositories only: nothing was done.");
  return info;
}

/** The target's repository id, when the page declared one (else the answer's own). */
const declaredId = (ctx: ActionContext<unknown>, fallback: string): string => (ctx.target.repo && "id" in ctx.target.repo ? ctx.target.repo.id : fallback);

/** GitHub's refusal of a pull request action, in words. */
function said(e: unknown, what: string): never {
  if (e instanceof GitBackendError) {
    if (e.code === "not_found") throw new ForgeProblem(404, "not_found", `GitHub does not know ${what} (deleted, or never there): nothing was done.`);
    if (e.code === "forbidden") throw new ForgeProblem(403, "forbidden", `GitHub says your account may not do this on ${what}: nothing was done.`);
  }
  throw e;
}

export interface PullLinks {
  links: { href: string; text: string }[];
}

// ─── pull_open ───────────────────────────────────────────────────────────────

export interface PullOpenParsed {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  maintainerCanModify: boolean;
  reviewers: string[];
}

export interface PullOpenDone extends PullLinks {
  id: string;
  number: number;
  base: string;
  head: string;
  draft: boolean;
  page: string;
  reviewers: string[];
  notes: string[];
}

export function validatePullOpen(payload: unknown): PullOpenParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The pull request is not readable.");
  const p = payload;
  if (!isBranchName(p.base)) return bad("The base is not a branch name.");
  if (!isHead(p.head)) return bad("The head is a branch, or owner:branch for a fork's.");
  if (p.head === p.base) return bad("A pull request asks to merge one branch into another: the head and the base are the same branch.");
  const title = readTitle(p.title);
  if (title instanceof ForgeProblem) return title;
  const body = readBody(p.body);
  if (body instanceof ForgeProblem) return body;
  for (const k of ["draft", "maintainerCanModify"] as const) {
    if (p[k] !== undefined && typeof p[k] !== "boolean") return bad(`The choice ${k} is not true or false.`);
  }
  const reviewers = readLogins(p.reviewers);
  if (reviewers instanceof ForgeProblem) return reviewers;
  return { base: p.base, head: p.head as string, title, body, draft: p.draft === true, maintainerCanModify: p.maintainerCanModify !== false, reviewers };
}

export const describePullOpen = (p: PullOpenParsed): string => {
  const also = [p.draft ? "as a draft" : "", p.reviewers.length ? `asking ${loginsInWords(p.reviewers)} to review it` : ""].filter(Boolean);
  return `Open the pull request “${p.title}” from ${p.head} into ${p.base}${also.length ? ` (${also.join("; ")})` : ""}`;
};

export const pullOpenSpec: ActionSpec<PullOpenParsed, PullOpenDone> = {
  kind: "pull_open",
  needsRepo: false,
  checkTarget: (t) => onDeclaredRepo(t) ?? (t.branch === null ? new ForgeProblem(400, "bad_request", "A pull request names the base branch it goes into.") : null),
  validate: validatePullOpen,
  describe: describePullOpen,
  async perform(ctx) {
    const p = ctx.parsed;
    if (p.base !== ctx.target.branch) throw bad("This pull request was prepared for another base branch: nothing was done. Go back to the page, then open it again.");
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let pr: PullRequest;
    try {
      pr = await ctx.session.pulls.create(info.ref, { title: p.title, body: p.body || undefined, head: p.head, base: p.base, draft: p.draft, maintainerCanModify: p.maintainerCanModify });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "already_open", `A pull request from ${p.head} into ${p.base} is already open: nothing was done.`);
      }
      if (e instanceof GitBackendError && e.code === "invalid") {
        throw new ForgeProblem(422, "not_opened", `GitHub did not open it: ${p.head} may have no commit that ${p.base} lacks, or the branch may not exist. Nothing was done.`);
      }
      return said(e, "this repository");
    }
    const notes: string[] = [];
    let reviewers: string[] = [];
    if (p.reviewers.length) {
      try {
        reviewers = (await ctx.session.pulls.requestReviewers(info.ref, pr.number, p.reviewers)).requestedReviewers;
      } catch {
        notes.push(`GitHub opened it, but did not ask ${loginsInWords(p.reviewers)} to review it (GitHub asks reviews of the repository's collaborators only, and never of the author): ask again from its page.`);
      }
    }
    if (p.draft) notes.push("It is a draft: nobody can merge it until you mark it ready for review.");
    const page = pullPage(info.ref, pr.number);
    return {
      result: {
        id: info.key.id,
        number: pr.number,
        base: pr.base.ref,
        head: p.head,
        draft: pr.draft,
        page,
        reviewers,
        notes,
        links: [
          { href: page, text: `The pull request #${pr.number}` },
          { href: pullPage(info.ref, pr.number, "files"), text: "Its files changed" },
        ],
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id, branch: pr.base.ref },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && isNumber(r.number) && r.base === p.base,
};

// ─── pull_edit ───────────────────────────────────────────────────────────────

export type HeadBranchChange = "delete" | "restore";

export interface PullEditParsed {
  numbers: number[];
  title: string | null;
  body: string | null;
  base: string | null;
  state: "open" | "closed" | null;
  draft: boolean | null;
  reviewers: { add: string[]; remove: string[] };
  /** undefined: unchanged; null: off. */
  autoMerge: MergeMethod | null | undefined;
  headBranch: HeadBranchChange | null;
}

export interface PullEditDone extends PullLinks {
  id: string;
  numbers: number[];
  pulls: { number: number; state: "open" | "closed"; draft: boolean; merged: boolean }[];
  page: string;
  notes: string[];
}

export function validatePullEdit(payload: unknown): PullEditParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The change is not readable.");
  const p = payload;
  let numbers: number[];
  if (p.numbers !== undefined) {
    if (p.number !== undefined) return bad("Name one pull request, or several: not both.");
    if (!Array.isArray(p.numbers) || !p.numbers.length || p.numbers.length > BULK_PULLS || !p.numbers.every(isNumber)) {
      return bad(`Choose 1 to ${BULK_PULLS} pull requests.`);
    }
    numbers = [...new Set(p.numbers as number[])];
  } else {
    const n = readNumber(p);
    if (n instanceof ForgeProblem) return n;
    numbers = [n];
  }
  const out: PullEditParsed = { numbers, title: null, body: null, base: null, state: null, draft: null, reviewers: { add: [], remove: [] }, autoMerge: undefined, headBranch: null };
  if (p.title !== undefined) {
    const t = readTitle(p.title);
    if (t instanceof ForgeProblem) return t;
    out.title = t;
  }
  if (p.body !== undefined) {
    const b = readBody(p.body);
    if (b instanceof ForgeProblem) return b;
    out.body = b;
  }
  if (p.base !== undefined) {
    if (!isBranchName(p.base)) return bad("The new base is not a branch name.");
    out.base = p.base;
  }
  if (p.state !== undefined) {
    if (p.state !== "open" && p.state !== "closed") return bad("A pull request is closed or reopened.");
    out.state = p.state;
  }
  if (p.draft !== undefined) {
    if (typeof p.draft !== "boolean") return bad("The draft choice is not true or false.");
    out.draft = p.draft;
  }
  if (p.reviewers !== undefined) {
    if (!isObject(p.reviewers)) return bad("The reviewers are not readable.");
    const add = readLogins(p.reviewers.add);
    if (add instanceof ForgeProblem) return add;
    const remove = readLogins(p.reviewers.remove);
    if (remove instanceof ForgeProblem) return remove;
    if (add.some((a) => remove.some((r) => r.toLowerCase() === a.toLowerCase()))) return bad("A reviewer is both asked and removed.");
    out.reviewers = { add, remove };
  }
  if (p.autoMerge !== undefined) {
    if (p.autoMerge !== null && !MERGE_METHODS.includes(p.autoMerge as MergeMethod)) return bad("Auto-merge is by a merge commit, a squash or a rebase, or off.");
    out.autoMerge = p.autoMerge as MergeMethod | null;
  }
  if (p.headBranch !== undefined) {
    if (p.headBranch !== "delete" && p.headBranch !== "restore") return bad("The head branch is deleted or restored.");
    out.headBranch = p.headBranch;
  }
  const changes = [out.title, out.body, out.base, out.state, out.draft, out.headBranch].filter((x) => x !== null).length +
    (out.reviewers.add.length || out.reviewers.remove.length ? 1 : 0) +
    (out.autoMerge !== undefined ? 1 : 0);
  if (!changes) return bad("Nothing to change.");
  if (numbers.length > 1 && (changes !== 1 || out.state === null)) return bad("Several pull requests at once are closed or reopened, nothing else.");
  if (out.headBranch && (changes !== 1)) return bad("Deleting or restoring the head branch is its own action.");
  return out;
}

export function describePullEdit(p: PullEditParsed): string {
  const one = p.numbers.length === 1;
  const what = one ? `the pull request #${p.numbers[0]}` : `the pull requests ${numbersInWords(p.numbers)}`;
  if (p.headBranch === "delete") return `Delete the head branch of ${what}`;
  if (p.headBranch === "restore") return `Restore the head branch of ${what}`;
  const parts: string[] = [];
  const fields = [p.title !== null ? "its title" : "", p.body !== null ? "its description" : "", p.base !== null ? `its base (now ${p.base})` : ""].filter(Boolean);
  if (fields.length) parts.push(`change ${fields.join(", ")}`);
  if (p.state) parts.push(p.state === "closed" ? "close it" : "reopen it");
  if (p.draft !== null) parts.push(p.draft ? "convert it to a draft" : "mark it ready for review");
  if (p.reviewers.add.length) parts.push(`ask ${loginsInWords(p.reviewers.add)} to review it`);
  if (p.reviewers.remove.length) parts.push(`remove the review request of ${loginsInWords(p.reviewers.remove)}`);
  if (p.autoMerge !== undefined) parts.push(p.autoMerge === null ? "disable auto-merge" : `enable auto-merge (${methodInWords(p.autoMerge)}) once its requirements are met`);
  if (!one) return `${p.state === "closed" ? "Close" : "Reopen"} ${what}`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}: ${parts.join("; ")}`;
}

export const methodInWords = (m: MergeMethod): string => (m === "merge" ? "a merge commit" : m === "squash" ? "squash and merge" : "rebase and merge");

export const pullEditSpec: ActionSpec<PullEditParsed, PullEditDone> = {
  kind: "pull_edit",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validatePullEdit,
  describe: describePullEdit,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const notes: string[] = [];
    const pulls: PullEditDone["pulls"] = [];
    for (const number of p.numbers) {
      const what = `the pull request #${number}`;
      try {
        let pr: PullRequest | null = null;
        if (p.headBranch) {
          pr = await ctx.session.pulls.get(info.ref, number);
          await headBranch(ctx as ActionContext<unknown>, info, pr, p.headBranch, notes);
        }
        if (p.title !== null || p.body !== null || p.base !== null || p.state !== null) {
          const patch = { title: p.title ?? undefined, body: p.body ?? undefined, base: p.base ?? undefined, state: p.state ?? undefined };
          pr = await ctx.session.pulls.update(info.ref, number, patch);
        }
        if (p.draft !== null) pr = await ctx.session.pulls.setDraft(info.ref, number, p.draft);
        if (p.reviewers.add.length) pr = await ctx.session.pulls.requestReviewers(info.ref, number, p.reviewers.add);
        if (p.reviewers.remove.length) pr = await ctx.session.pulls.removeReviewers(info.ref, number, p.reviewers.remove);
        if (p.autoMerge !== undefined) {
          try {
            pr = await ctx.session.pulls.autoMerge(info.ref, number, p.autoMerge);
          } catch (e) {
            if (e instanceof GitBackendError && e.code === "invalid") {
              throw new ForgeProblem(422, "auto_merge", "GitHub did not enable auto-merge: the repository must allow it (Settings), and the pull request must be open and waiting for a requirement. Nothing was done.");
            }
            throw e;
          }
        }
        pr ??= await ctx.session.pulls.get(info.ref, number);
        pulls.push({ number: pr.number, state: pr.state, draft: pr.draft, merged: pr.merged });
      } catch (e) {
        if (e instanceof ForgeProblem) throw e;
        if (e instanceof GitBackendError && e.code === "invalid" && p.reviewers.add.length) {
          throw new ForgeProblem(422, "reviewers", `GitHub did not ask ${loginsInWords(p.reviewers.add)}: it asks reviews of the repository's collaborators only, and never of the pull request's author. Nothing else was changed after that.`);
        }
        if (p.numbers.length > 1 && pulls.length) {
          notes.push(`GitHub stopped at ${what}: ${e instanceof GitBackendError ? "it refused it" : "an error"}. The ones before it were changed.`);
          break;
        }
        return said(e, what);
      }
    }
    const page = p.numbers.length === 1 ? pullPage(info.ref, p.numbers[0]) : `${pageOf(info.ref)}pulls`;
    return {
      result: {
        id: info.key.id,
        numbers: pulls.map((x) => x.number),
        pulls,
        page,
        notes,
        links: [{ href: page, text: p.numbers.length === 1 ? `The pull request #${p.numbers[0]}` : "The pull requests" }],
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) =>
    r.id === declaredId(ctx as ActionContext<unknown>, r.id) &&
    r.numbers.length > 0 &&
    r.numbers.every((n) => p.numbers.includes(n)) &&
    (p.state === null || p.numbers.length > 1 || r.pulls.every((x) => x.state === p.state || (p.state === "closed" && x.merged))),
};

/** Deletes or restores a pull request's head branch, where the person may write (the base
 *  repository's own branch, or their fork's). */
async function headBranch(ctx: ActionContext<unknown>, info: RepoInfo, pr: PullRequest, change: HeadBranchChange, notes: string[]): Promise<void> {
  const where = pr.head.repo;
  if (!where) throw new ForgeProblem(409, "fork_gone", "The fork this pull request came from was deleted: its branch cannot be deleted or restored from here.");
  if (change === "delete" && pr.state === "open") throw new ForgeProblem(409, "still_open", "The pull request is still open: close or merge it before deleting its branch.");
  const same = where.owner.toLowerCase() === info.ref.owner.toLowerCase() && where.name.toLowerCase() === info.ref.name.toLowerCase();
  if (same && pr.head.ref === info.defaultBranch) throw new ForgeProblem(400, "default_branch", "The head branch is the repository's default branch: it is never deleted from here.");
  if (change === "delete") {
    try {
      await ctx.session.git.deleteBranch(where, pr.head.ref);
    } catch (e) {
      if (e instanceof GitBackendError && (e.code === "not_found" || e.code === "invalid")) throw new ForgeProblem(404, "no_branch", `The branch ${pr.head.ref} is already gone.`);
      throw e;
    }
    notes.push(`Its last commit, ${pr.head.sha.slice(0, 12)}, stays in the pull request: the branch can be restored from its page.`);
  } else {
    try {
      await ctx.session.git.createBranch(where, pr.head.ref, pr.head.sha);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "branch_exists", `A branch named ${pr.head.ref} already exists: nothing was done.`);
      throw e;
    }
    notes.push(`The branch ${pr.head.ref} is back at ${pr.head.sha.slice(0, 12)}.`);
  }
}

// ─── pull_review ─────────────────────────────────────────────────────────────

export interface PullReviewParsed {
  number: number;
  commit: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewLineComment[];
  suggestions: number;
}

export interface PullReviewDone extends PullLinks {
  id: string;
  number: number;
  review: { id: string; state: string };
  comments: number;
  page: string;
  notes: string[];
}

const SUGGESTION = /^[ \t]*```suggestion[ \t]*$/m;

export function validatePullReview(payload: unknown): PullReviewParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The review is not readable.");
  const p = payload;
  const number = readNumber(p);
  if (number instanceof ForgeProblem) return number;
  if (!isObjectId(p.commit)) return bad("The review names the commit it was written on.");
  if (!REVIEW_EVENTS.includes(p.event as ReviewEvent)) return bad("A review comments, approves or requests changes.");
  const body = readBody(p.body, "The review's summary");
  if (body instanceof ForgeProblem) return body;
  const raw = p.comments ?? [];
  if (!Array.isArray(raw) || raw.length > REVIEW_COMMENTS) return bad(`A review holds at most ${REVIEW_COMMENTS} line comments.`);
  const comments: ReviewLineComment[] = [];
  let suggestions = 0;
  for (const c of raw) {
    if (!isObject(c) || !isRepoPath(c.path) || !isNumber(c.line)) return bad("A line comment names its file and its line.");
    const side = c.side ?? "RIGHT";
    if (side !== "LEFT" && side !== "RIGHT") return bad("A line comment is on the old side (LEFT) or the new side (RIGHT).");
    const text = readBody(c.body, "A line comment", true);
    if (text instanceof ForgeProblem) return text;
    const out: ReviewLineComment = { path: c.path as string, line: c.line, side, body: text };
    if (c.startLine !== undefined) {
      if (!isNumber(c.startLine) || c.startLine >= c.line) return bad("A comment on several lines starts before its last line.");
      const startSide = c.startSide ?? side;
      if (startSide !== "LEFT" && startSide !== "RIGHT") return bad("A line comment is on the old side (LEFT) or the new side (RIGHT).");
      out.startLine = c.startLine;
      out.startSide = startSide;
    }
    if (SUGGESTION.test(text)) {
      if (side === "LEFT") return bad("A suggestion replaces lines of the new version: it is written on the new side.");
      suggestions += 1;
    }
    comments.push(out);
  }
  const event = p.event as ReviewEvent;
  if (event === "COMMENT" && !body.trim() && !comments.length) return bad("A comment says something: write it first.");
  return { number, commit: p.commit as string, event, body, comments, suggestions };
}

export function describePullReview(p: PullReviewParsed): string {
  const single = p.event === "COMMENT" && p.comments.length === 1 && !p.body.trim();
  const verb = p.event === "APPROVE" ? "Approve" : p.event === "REQUEST_CHANGES" ? "Request changes on" : single ? "Comment on a line of" : "Comment on";
  const lines = p.comments.length && !single ? plural(p.comments.length, "line comment") : "";
  const suggested = p.suggestions ? plural(p.suggestions, "suggested change") : "";
  const extras = lines && suggested ? `, with ${lines} (${suggested})` : lines ? `, with ${lines}` : suggested ? `: ${suggested === "1 suggested change" ? "a suggested change" : suggested}` : "";
  return `${verb} the pull request #${p.number} at ${p.commit.slice(0, 7)}${extras}`;
}

const REVIEW_STATE: Record<ReviewEvent, string> = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };

export const pullReviewSpec: ActionSpec<PullReviewParsed, PullReviewDone> = {
  kind: "pull_review",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validatePullReview,
  describe: describePullReview,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const what = `the pull request #${p.number}`;
    let pr: PullRequest;
    try {
      pr = await ctx.session.pulls.get(info.ref, p.number);
    } catch (e) {
      return said(e, what);
    }
    // GitHub's rule, said before GitHub is asked: the author does not approve their own work.
    if (p.event !== "COMMENT" && pr.author.id !== null && pr.author.id === ctx.github.id) {
      throw new ForgeProblem(422, "own_pull", "You opened this pull request: its author cannot approve it or request changes on it. Comment instead.");
    }
    if (pr.state !== "open" && p.event !== "COMMENT") throw new ForgeProblem(409, "closed", "The pull request is closed: it can still be commented, not approved or refused.");
    const notes: string[] = [];
    if (pr.head.sha !== p.commit) notes.push(`The pull request moved since you read it (its head is now ${pr.head.sha.slice(0, 7)}): your review is on the version you read, ${p.commit.slice(0, 7)}.`);
    let review;
    try {
      review = await ctx.session.pulls.review(info.ref, p.number, { event: p.event, body: p.body || undefined, commit: p.commit, comments: p.comments });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "invalid") {
        throw new ForgeProblem(422, "not_reviewed", "GitHub refused the review: a line comment must be on a line the pull request changes or shows around a change, at the version you read. Nothing was posted.");
      }
      return said(e, what);
    }
    const page = pullPage(info.ref, p.number, p.comments.length ? "files" : "");
    return {
      result: { id: info.key.id, number: p.number, review: { id: review.id, state: review.state }, comments: p.comments.length, page, notes, links: [{ href: page, text: `The pull request #${p.number}` }] },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && r.review.state === REVIEW_STATE[p.event],
};

// ─── pull_comment ────────────────────────────────────────────────────────────

export interface PullCommentParsed {
  number: number;
  body: string;
  replyTo: string | null;
}

export interface PullCommentDone extends PullLinks {
  id: string;
  number: number;
  comment: string;
  page: string;
  notes: string[];
}

const COMMENT_ID = /^[0-9]{1,20}$/;

export function validatePullComment(payload: unknown): PullCommentParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The comment is not readable.");
  const number = readNumber(payload);
  if (number instanceof ForgeProblem) return number;
  const body = readBody(payload.body, "The comment", true);
  if (body instanceof ForgeProblem) return body;
  if (payload.replyTo !== undefined && (typeof payload.replyTo !== "string" || !COMMENT_ID.test(payload.replyTo))) return bad("A reply names the review comment it answers.");
  return { number, body, replyTo: (payload.replyTo as string | undefined) ?? null };
}

export const pullCommentSpec: ActionSpec<PullCommentParsed, PullCommentDone> = {
  kind: "pull_comment",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validatePullComment,
  describe: (p) => (p.replyTo ? `Reply to a review comment on the pull request #${p.number}` : `Comment on the pull request #${p.number}`),
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let id: string;
    try {
      id = p.replyTo
        ? (await ctx.session.pulls.reply(info.ref, p.number, p.replyTo, p.body)).id
        : (await ctx.session.issues.comment(info.ref, p.number, p.body)).id;
    } catch (e) {
      return said(e, p.replyTo ? "this review comment" : `the pull request #${p.number}`);
    }
    const page = pullPage(info.ref, p.number);
    return {
      result: { id: info.key.id, number: p.number, comment: id, page, notes: [], links: [{ href: page, text: `The pull request #${p.number}` }] },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && typeof r.comment === "string" && r.comment.length > 0,
};

// ─── pull_thread ─────────────────────────────────────────────────────────────

export interface PullThreadParsed {
  number: number;
  comment: string;
  resolved: boolean;
}

export interface PullThreadDone extends PullLinks {
  id: string;
  number: number;
  resolved: boolean;
  page: string;
  notes: string[];
}

export const pullThreadSpec: ActionSpec<PullThreadParsed, PullThreadDone> = {
  kind: "pull_thread",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload)) return bad("The conversation is not readable.");
    const number = readNumber(payload);
    if (number instanceof ForgeProblem) return number;
    if (typeof payload.comment !== "string" || !COMMENT_ID.test(payload.comment)) return bad("Name the conversation by its first comment.");
    if (typeof payload.resolved !== "boolean") return bad("A conversation is resolved or reopened.");
    return { number, comment: payload.comment, resolved: payload.resolved };
  },
  describe: (p) => `${p.resolved ? "Resolve" : "Unresolve"} a conversation on the pull request #${p.number}`,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    // The thread's id is GraphQL's: found as the person, by the comment the page read anonymously.
    let cursor: string | null = null;
    let found: { id: string; resolved: boolean } | null = null;
    try {
      for (let n = 0; n < THREAD_PAGES && !found; n++) {
        const page = await ctx.session.pulls.threads(info.ref, p.number, { perPage: 100, cursor });
        const t = page.items.find((x) => x.comments.some((c) => c.id === p.comment));
        if (t) found = { id: t.id, resolved: t.resolved };
        if (!page.next) break;
        cursor = page.next;
      }
    } catch (e) {
      return said(e, `the pull request #${p.number}`);
    }
    if (!found) throw new ForgeProblem(404, "no_thread", "GitHub has no conversation with this comment on this pull request (deleted?): nothing was done.");
    const notes: string[] = [];
    let resolved = found.resolved;
    if (found.resolved === p.resolved) notes.push(`The conversation was already ${p.resolved ? "resolved" : "open"}.`);
    else resolved = (await ctx.session.pulls.resolveThread(info.ref, found.id, p.resolved)).resolved;
    const page = pullPage(info.ref, p.number, "files");
    return {
      result: { id: info.key.id, number: p.number, resolved, page, notes, links: [{ href: page, text: `The pull request #${p.number}` }] },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && r.resolved === p.resolved,
};

// ─── pull_merge ──────────────────────────────────────────────────────────────

export interface PullMergeParsed {
  number: number;
  method: MergeMethod;
  head: string;
  title: string | null;
  message: string | null;
  deleteBranch: boolean;
  /** Research issues the pull request says it fixes ("Fixes research#12", phase 05): closed as "fixed
   *  in the code" at the merge commit, when the pull request names them and goes into the default
   *  branch (GitHub's rule for its own closing keywords). */
  closes: number[];
}

/** Research issues one merge closes at most (1 row each, within the rows act reserves). */
export const MERGE_CLOSES = 5;

export interface PullMergeDone extends PullLinks {
  id: string;
  number: number;
  sha: string;
  method: MergeMethod;
  branchDeleted: boolean;
  /** The research issues this merge closed. */
  closed: number[];
  page: string;
  notes: string[];
}

export function validatePullMerge(payload: unknown): PullMergeParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The merge is not readable.");
  const p = payload;
  const number = readNumber(p);
  if (number instanceof ForgeProblem) return number;
  if (!MERGE_METHODS.includes(p.method as MergeMethod)) return bad("Merge by a merge commit, a squash or a rebase.");
  if (!isObjectId(p.head)) return bad("The merge names the head the page showed.");
  let title: string | null = null;
  if (p.title !== undefined && p.title !== "") {
    if (typeof p.title !== "string" || /[\r\n]/.test(p.title.trim()) || p.title.trim().length > 500) return bad("The commit's title is one line.");
    title = p.title.trim() || null;
  }
  const message = p.message === undefined ? "" : readBody(p.message, "The commit's message");
  if (message instanceof ForgeProblem) return message;
  if (p.deleteBranch !== undefined && typeof p.deleteBranch !== "boolean") return bad("The choice to delete the branch is not true or false.");
  if (p.method === "rebase" && (title || message)) return bad("A rebase keeps each commit's own message: no title or message to give.");
  let closes: number[] = [];
  if (p.closes !== undefined) {
    if (!Array.isArray(p.closes) || p.closes.length > MERGE_CLOSES || !p.closes.every(isNumber)) return bad(`A merge closes ${MERGE_CLOSES} research issues at most, named by their numbers.`);
    closes = [...new Set(p.closes as number[])];
  }
  return { number, method: p.method as MergeMethod, head: p.head as string, title, message: message || null, deleteBranch: p.deleteBranch === true, closes };
}

export const describePullMerge = (p: PullMergeParsed): string =>
  `Merge the pull request #${p.number} (${methodInWords(p.method)}) at ${p.head.slice(0, 7)}${p.deleteBranch ? ", then delete its branch" : ""}` +
  (p.closes.length ? `; this closes the research ${p.closes.length === 1 ? "issue" : "issues"} ${p.closes.map((n) => `research#${n}`).join(", ")} as fixed in the code` : "");

export const pullMergeSpec: ActionSpec<PullMergeParsed, PullMergeDone> = {
  kind: "pull_merge",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validatePullMerge,
  describe: describePullMerge,
  async perform(ctx) {
    const p = ctx.parsed;
    if (ctx.target.expectedHead !== null && ctx.target.expectedHead !== p.head) {
      throw bad("This merge was prepared for another version of the pull request: nothing was done. Go back to the page, then merge again.");
    }
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let sha: string;
    try {
      sha = (await ctx.session.pulls.merge(info.ref, p.number, { method: p.method, expectedHead: p.head, title: p.title ?? undefined, message: p.message ?? undefined })).sha;
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "conflict", "The pull request changed since the page showed it (a new commit on its branch): nothing was merged. Go back to the page, read what changed, then merge again.", { offer: "reload" });
      }
      if (e instanceof GitBackendError && e.code === "not_mergeable") {
        throw new ForgeProblem(409, "not_mergeable", "GitHub did not merge it: it has conflicts to resolve, a required review or check is missing, it is a draft, or the repository does not allow this method. Nothing was merged.", { offer: "conflicts" });
      }
      return said(e, `the pull request #${p.number}`);
    }
    const notes: string[] = [];
    let branchDeleted = false;
    const writes: Write[] = [];
    const closed: number[] = [];
    if (p.closes.length) {
      // What the pull request says, as GitHub has it now (its title and description), and where it
      // went: GitHub's own keywords close on the default branch only; the registry's follow the rule.
      const pr = await ctx.session.pulls.get(info.ref, p.number).catch(() => null);
      const named = new Set(pr ? researchClosing(`${pr.title}\n${pr.body}`) : []);
      const toDefault = pr !== null && pr.base.ref === info.defaultBranch;
      for (const id of p.closes) {
        const row = await first<IssueRow>(issueById(ctx.db, id));
        if (!toDefault) notes.push(`research#${id} stays open: a merge closes issues only into the default branch.`);
        else if (!named.has(id)) notes.push(`research#${id} stays open: the pull request does not say it fixes it (“Fixes research#${id}”).`);
        else if (!row || row.forge !== info.key.forge || row.repo_id !== info.key.id) notes.push(`research#${id} stays open: it is not about this repository.`);
        else if (row.state !== "open") notes.push(`research#${id} was already closed.`);
        else {
          writes.push(closeByMerge(ctx.db, id, sha, p.number, ctx.github.login, ctx.t));
          closed.push(id);
        }
      }
      if (closed.length) notes.push(`Closed as fixed in the code, at this merge: ${closed.map((n) => `research#${n}`).join(", ")}.`);
    }
    if (p.deleteBranch) {
      try {
        const pr = await ctx.session.pulls.get(info.ref, p.number);
        await headBranch(ctx as ActionContext<unknown>, info, pr, "delete", []);
        branchDeleted = true;
        notes.push(`Its branch ${pr.head.ref} was deleted; it can be restored from the pull request's page.`);
      } catch (e) {
        notes.push(e instanceof ForgeProblem && e.code === "no_branch" ? "Its branch was already gone (the repository deletes merged branches)." : "It was merged, but its branch was not deleted: delete it from the pull request's page.");
      }
    }
    const page = pullPage(info.ref, p.number);
    return {
      result: { id: info.key.id, number: p.number, sha, method: p.method, branchDeleted, closed, page, notes, links: [{ href: page, text: `The pull request #${p.number}` }, { href: `${pageOf(info.ref)}commit/${sha}/`, text: "The commit on the base branch" }] },
      writes,
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && isObjectId(r.sha) && r.method === p.method,
};

// ─── pull_update ─────────────────────────────────────────────────────────────

export interface PullNumberHead {
  number: number;
  head: string;
}

export interface PullUpdateDone extends PullLinks {
  id: string;
  number: number;
  page: string;
  notes: string[];
}

export const pullUpdateSpec: ActionSpec<PullNumberHead, PullUpdateDone> = {
  kind: "pull_update",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload)) return bad("The update is not readable.");
    const number = readNumber(payload);
    if (number instanceof ForgeProblem) return number;
    if (!isObjectId(payload.head)) return bad("The update names the head the page showed.");
    return { number, head: payload.head as string };
  },
  describe: (p) => `Update the branch of the pull request #${p.number} with its base (GitHub merges the base into it, at ${p.head.slice(0, 7)})`,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    try {
      await ctx.session.pulls.updateBranch(info.ref, p.number, p.head);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "conflict", "GitHub could not update the branch: the pull request changed since the page showed it, or its changes conflict with the base. Nothing was done: resolve the conflicts in the registry.", { offer: "conflicts" });
      }
      return said(e, `the branch of the pull request #${p.number}`);
    }
    const page = pullPage(info.ref, p.number);
    return {
      result: { id: info.key.id, number: p.number, page, notes: [], links: [{ href: page, text: `The pull request #${p.number}` }] },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number,
};

// ─── pull_revert ─────────────────────────────────────────────────────────────

export interface PullRevertDone extends PullLinks {
  id: string;
  number: number;
  revert: number;
  page: string;
  notes: string[];
}

export const pullRevertSpec: ActionSpec<{ number: number }, PullRevertDone> = {
  kind: "pull_revert",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload)) return bad("The revert is not readable.");
    const number = readNumber(payload);
    return number instanceof ForgeProblem ? number : { number };
  },
  describe: (p) => `Open a pull request that reverts the pull request #${p.number}`,
  async perform(ctx) {
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let revert: PullRequest;
    try {
      revert = await ctx.session.pulls.revert(info.ref, ctx.parsed.number);
    } catch (e) {
      if (e instanceof GitBackendError && (e.code === "invalid" || e.code === "conflict")) {
        throw new ForgeProblem(409, "not_reverted", "GitHub did not revert it: only a merged pull request is reverted, and later changes may conflict with the revert. Nothing was done.");
      }
      return said(e, `the pull request #${ctx.parsed.number}`);
    }
    const page = pullPage(info.ref, revert.number);
    return {
      result: {
        id: info.key.id,
        number: ctx.parsed.number,
        revert: revert.number,
        page,
        notes: [`The revert is a new pull request, #${revert.number}: review it, then merge it like any other.`],
        links: [{ href: page, text: `The revert, #${revert.number}` }],
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && isNumber(r.revert) && r.revert !== p.number,
};

export const PULL_ACTIONS: readonly AnyActionSpec[] = [
  pullOpenSpec, pullEditSpec, pullReviewSpec, pullCommentSpec, pullThreadSpec, pullMergeSpec, pullUpdateSpec, pullRevertSpec,
];
