// GitHub's issues as authorized actions (night phase 05, E1; docs/ISSUES.md; D00-4, D00-6, D05-*).
// The registry's issue pages (src/scripts/repo-issues.ts, repo-issue.ts) read GitHub's issues in the
// reader's browser, on the reader's own quota; every write is ONE authorized action, made by GitHub
// as the person, one authorization each, the token used once and revoked:
//
//   issue_open       {title, body?, labels?, assignees?, milestone?, type?, parent?}: GitHub opens it
//                    (labels, assignees, a milestone and a type are kept only for people who triage:
//                    what GitHub dropped is said); `parent` makes it a sub-issue of that issue.
//   issue_edit       {number | numbers, title?, body?, state?, reason?, duplicateOf?, labels?: {add?,
//                    remove?}, assignees?: {add?, remove?}, milestone?, type?}: edit, close with a
//                    reason (completed, not planned, duplicate of #n: GitHub's "Duplicate of #n"
//                    comment with it), reopen; `numbers` (≤ 25; ≤ 15 when labels or assignees
//                    change, each read first) changes several at once (the list's bulk actions).
//   issue_comment    {number, body} a comment; {number, comment, body} its edit; {number, comment,
//                    delete: true} its deletion.
//   issue_react      {number, comment?, reaction, remove?}: one of GitHub's eight reactions, added or
//                    taken back, on the issue or one of its comments.
//   issue_lock       {number, locked, reason?}: lock the conversation (off-topic, too heated, resolved,
//                    spam) or unlock it.
//   issue_pin        {number, pinned}: pin it above the list (3 at most, GitHub's rule) or unpin it.
//   issue_transfer   {number, to}: move it to another repository of the same account (GitHub gives it
//                    a new number there).
//   issue_relation   {number, sub?: {add | remove}, blockedBy?: {add | remove}}: a sub-issue added or
//                    removed; a dependency ("blocked by #n") added or removed. One change per action.
//   issue_branch     {number, name, from}: "Create a branch for this issue", named "<n>-…" as GitHub
//                    names it, from a branch of the repository.
//   issue_labels     {create?, update?, delete?}: the repository's labels (25 changes at most: GitHub's
//                    ten default labels and the three research ones in one authorization).
//   issue_milestone  {create} | {number, title?, description?, dueOn?, state?} | {number, delete}.
//
// The target is the repository the page declared (by GitHub's id, as the page read it); the payload
// names the issue. The registry writes the action row only (1 row): no title, body, comment or label
// reaches D1 or a log (D00-6: ordinary issues are GitHub's objects). GitHub decides who may do what;
// its refusals are said in words. The registry's own research issues are research.ts's.

import { GitBackendError } from "../errors.ts";
import { BODY_CHARS } from "../limits.ts";
import { isRefName, LOGIN, SEGMENT } from "../paths.ts";
import type { Issue, LockReason, Reaction, RepoInfo, RepoRef, StateReason } from "../types.ts";
import { declaredRepo, numbersInWords, onDeclaredRepo } from "./act-pulls.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec } from "./types.ts";

// ─── shared ──────────────────────────────────────────────────────────────────

/** Issues a bulk action changes at most (one authorization, one GitHub request each). */
export const BULK_ISSUES = 25;
/** Issues a bulk change of labels or assignees reaches at most (each read first: two requests). */
export const BULK_LABELLED = 15;
/** Labels or assignees added or removed at once. */
export const LABELS_AT_ONCE = 20;
export const ASSIGNEES_AT_ONCE = 10;
/** Changes to the repository's labels in one action. */
export const LABEL_CHANGES = 25;

export const REACTIONS: readonly Reaction[] = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];
export const LOCK_REASONS: readonly LockReason[] = ["off-topic", "too heated", "resolved", "spam"];
export type CloseReason = Exclude<StateReason, "reopened">;
export const CLOSE_REASONS: readonly CloseReason[] = ["completed", "not_planned", "duplicate"];

/** A reaction in words, as screen readers and the sentences say it. */
export const REACTION_WORDS: Readonly<Record<Reaction, string>> = {
  "+1": "thumbs up",
  "-1": "thumbs down",
  laugh: "laugh",
  confused: "confused",
  heart: "heart",
  hooray: "hooray",
  rocket: "rocket",
  eyes: "eyes",
};

export const reasonInWords = (r: CloseReason): string => (r === "not_planned" ? "not planned" : r === "duplicate" ? "a duplicate" : "completed");

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 31;
const COMMENT_ID = /^[0-9]{1,20}$/;
const inWords = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const quoted = (xs: readonly string[]): string => inWords(xs.map((x) => `“${x}”`));

const repoPageOf = (ref: RepoRef): string => `/r/${ref.owner.toLowerCase()}/${ref.name.toLowerCase()}/`;
/** An issue's page in the registry (GitHub's shape after /r/). */
export const issuePage = (ref: RepoRef, number: number): string => `${repoPageOf(ref)}issues/${number}`;
const listPage = (ref: RepoRef): string => `${repoPageOf(ref)}issues`;

/** The target's repository id, when the page declared one (else the answer's own). */
const declaredId = (ctx: ActionContext<unknown>, fallback: string): string => (ctx.target.repo && "id" in ctx.target.repo ? ctx.target.repo.id : fallback);

/** GitHub's refusal of an issue action, in words. */
function said(e: unknown, what: string): never {
  if (e instanceof GitBackendError) {
    if (e.code === "not_found") throw new ForgeProblem(404, "not_found", `GitHub does not know ${what} (deleted, transferred, or never there): nothing was done.`);
    if (e.code === "forbidden") throw new ForgeProblem(403, "forbidden", `GitHub says your account may not do this on ${what}: nothing was done.`);
    if (e.code === "gone") throw new ForgeProblem(410, "issues_off", "The repository's issues are turned off on GitHub: its owner turns them on in the settings. Nothing was done.");
    if (e.code === "archived") throw new ForgeProblem(409, "archived", "The repository is archived: it is read-only on GitHub. Nothing was done.");
  }
  throw e;
}

export function readIssueTitle(v: unknown): string | ForgeProblem {
  if (typeof v !== "string" || !v.trim()) return bad("Give the issue a title: one line that says what is wrong or wanted.");
  if (/[\r\n]/.test(v.trim()) || v.trim().length > 256) return bad("The title is one line of at most 256 characters; the description takes the rest.");
  return v.trim();
}

export function readText(v: unknown, what: string, required = false): string | ForgeProblem {
  if (v === undefined || v === null) return required ? bad(`${what} is empty.`) : "";
  if (typeof v !== "string") return bad(`${what} is not text.`);
  if (v.length > BODY_CHARS) return bad(`${what} is at most ${BODY_CHARS.toLocaleString("en-GB")} characters.`);
  if (required && !v.trim()) return bad(`${what} is empty.`);
  return v.replace(/\r\n?/g, "\n");
}

/** A label's name as GitHub takes it: one line of at most 50 characters. */
export const isLabelName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 50 && !/[\u0000-\u001f\u007f]/.test(v) && v.trim() === v;
const isColor = (v: unknown): v is string => typeof v === "string" && /^[0-9a-fA-F]{6}$/.test(v);
export const isIssueType = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 50 && !/[\u0000-\u001f]/.test(v);

function readNames(v: unknown, max: number, what: string, ok: (x: unknown) => boolean): string[] | ForgeProblem {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return bad(`At most ${max} ${what} at once.`);
  const out: string[] = [];
  for (const x of v) {
    if (!ok(x)) return bad(`“${String(x).slice(0, 60)}” is not ${what === "labels" ? "a label's name" : "a GitHub account"}.`);
    if (out.some((y) => y.toLowerCase() === (x as string).toLowerCase())) return bad(`“${x}” is named twice.`);
    out.push(x as string);
  }
  return out;
}

const isLogin = (x: unknown): boolean => typeof x === "string" && LOGIN.test(x) && x.length <= 39;
const readLabels = (v: unknown) => readNames(v, LABELS_AT_ONCE, "labels", isLabelName);
const readAssignees = (v: unknown) => readNames(v, ASSIGNEES_AT_ONCE, "assignees", isLogin);

function readAddRemove(v: unknown, read: (x: unknown) => string[] | ForgeProblem, what: string): { add: string[]; remove: string[] } | ForgeProblem {
  if (!isObject(v)) return bad(`The ${what} to add and to remove are not readable.`);
  const add = read(v.add);
  if (add instanceof ForgeProblem) return add;
  const remove = read(v.remove);
  if (remove instanceof ForgeProblem) return remove;
  if (add.some((a) => remove.some((r) => r.toLowerCase() === a.toLowerCase()))) return bad(`One of the ${what} is both added and removed.`);
  if (!add.length && !remove.length) return bad(`No ${what} to add or remove.`);
  return { add, remove };
}

function readNumber(p: Record<string, unknown>): number | ForgeProblem {
  return isNumber(p.number) ? p.number : bad("Name the issue by its number.");
}

export interface IssueLinks {
  links: { href: string; text: string }[];
}

interface Done extends IssueLinks {
  id: string;
  page: string;
  notes: string[];
}

function done<X extends object>(info: RepoInfo, page: string, text: string, notes: string[], extra: X) {
  const result: Done & X = { id: info.key.id, page, notes, links: [{ href: page, text }], ...extra };
  return { result, writes: [], repo: { forge: info.key.forge, repoId: info.key.id } };
}

// ─── issue_open ──────────────────────────────────────────────────────────────

export interface IssueOpenParsed {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  type: string | null;
  parent: number | null;
}

export interface IssueOpenDone extends Done {
  number: number;
  labels: string[];
  assignees: string[];
}

export function validateIssueOpen(payload: unknown): IssueOpenParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The issue is not readable.");
  const p = payload;
  const title = readIssueTitle(p.title);
  if (title instanceof ForgeProblem) return title;
  const body = readText(p.body, "The description");
  if (body instanceof ForgeProblem) return body;
  const labels = readLabels(p.labels);
  if (labels instanceof ForgeProblem) return labels;
  const assignees = readAssignees(p.assignees);
  if (assignees instanceof ForgeProblem) return assignees;
  if (p.milestone !== undefined && p.milestone !== null && !isNumber(p.milestone)) return bad("A milestone is named by its number.");
  if (p.type !== undefined && p.type !== null && !isIssueType(p.type)) return bad("The issue's type is one of the repository's types, by its name.");
  if (p.parent !== undefined && p.parent !== null && !isNumber(p.parent)) return bad("The parent issue is named by its number.");
  return {
    title,
    body,
    labels,
    assignees,
    milestone: (p.milestone as number | undefined) ?? null,
    type: (p.type as string | undefined) ?? null,
    parent: (p.parent as number | undefined) ?? null,
  };
}

export function describeIssueOpen(p: IssueOpenParsed): string {
  const also = [
    p.type ? `of type ${p.type}` : "",
    p.labels.length ? `labelled ${quoted(p.labels)}` : "",
    p.assignees.length ? `assigned to ${inWords(p.assignees)}` : "",
    p.milestone ? `in the milestone #${p.milestone}` : "",
    p.parent ? `as a sub-issue of #${p.parent}` : "",
  ].filter(Boolean);
  return `Open the issue “${p.title}”${also.length ? ` (${also.join("; ")})` : ""}`;
}

export const issueOpenSpec: ActionSpec<IssueOpenParsed, IssueOpenDone> = {
  kind: "issue_open",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueOpen,
  describe: describeIssueOpen,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let issue: Issue;
    try {
      issue = await ctx.session.issues.create(info.ref, {
        title: p.title,
        body: p.body || undefined,
        labels: p.labels.length ? p.labels : undefined,
        assignees: p.assignees.length ? p.assignees : undefined,
        milestone: p.milestone ?? undefined,
        type: p.type ?? undefined,
      });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "invalid") {
        throw new ForgeProblem(422, "not_opened", "GitHub did not open it: a milestone, an assignee or a type it names is not the repository's (issue types belong to organizations; assignees need access to the repository). Nothing was done.");
      }
      return said(e, "this repository");
    }
    const notes: string[] = [];
    const lost = [
      p.labels.length && !issue.labels.length ? "the labels" : "",
      p.assignees.length && !issue.assignees.length ? "the assignees" : "",
      p.milestone && issue.milestone === null ? "the milestone" : "",
      p.type && !issue.type ? "the type" : "",
    ].filter(Boolean);
    if (lost.length) notes.push(`GitHub opened it without ${inWords(lost)}: only people who triage the repository's issues set them.`);
    if (p.parent) {
      try {
        await ctx.session.issues.addSubIssue(info.ref, p.parent, issue.number);
        notes.push(`It is a sub-issue of #${p.parent}.`);
      } catch {
        notes.push(`GitHub opened it, but did not make it a sub-issue of #${p.parent} (that needs write access, and the parent issue open in this repository): add it from #${p.parent}'s page.`);
      }
    }
    const page = issuePage(info.ref, issue.number);
    return done(info, page, `The issue #${issue.number}`, notes, { number: issue.number, labels: issue.labels, assignees: issue.assignees });
  },
  check: (r, _p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && isNumber(r.number),
};

// ─── issue_edit ──────────────────────────────────────────────────────────────

export interface IssueEditParsed {
  numbers: number[];
  title: string | null;
  body: string | null;
  state: "open" | "closed" | null;
  reason: CloseReason | null;
  duplicateOf: number | null;
  labels: { add: string[]; remove: string[] } | null;
  assignees: { add: string[]; remove: string[] } | null;
  /** undefined: unchanged; null: none. */
  milestone: number | null | undefined;
  type: string | null | undefined;
}

export interface IssueEditDone extends Done {
  numbers: number[];
  issues: { number: number; state: "open" | "closed"; reason: StateReason | null; labels: string[]; assignees: string[] }[];
}

export function validateIssueEdit(payload: unknown): IssueEditParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The change is not readable.");
  const p = payload;
  let numbers: number[];
  if (p.numbers !== undefined) {
    if (p.number !== undefined) return bad("Name one issue, or several: not both.");
    if (!Array.isArray(p.numbers) || !p.numbers.length || p.numbers.length > BULK_ISSUES || !p.numbers.every(isNumber)) return bad(`Choose 1 to ${BULK_ISSUES} issues.`);
    numbers = [...new Set(p.numbers as number[])];
  } else {
    const n = readNumber(p);
    if (n instanceof ForgeProblem) return n;
    numbers = [n];
  }
  const out: IssueEditParsed = { numbers, title: null, body: null, state: null, reason: null, duplicateOf: null, labels: null, assignees: null, milestone: undefined, type: undefined };
  if (p.title !== undefined) {
    const t = readIssueTitle(p.title);
    if (t instanceof ForgeProblem) return t;
    out.title = t;
  }
  if (p.body !== undefined) {
    const b = readText(p.body, "The description");
    if (b instanceof ForgeProblem) return b;
    out.body = b;
  }
  if (p.state !== undefined) {
    if (p.state !== "open" && p.state !== "closed") return bad("An issue is closed or reopened.");
    out.state = p.state;
  }
  if (p.reason !== undefined) {
    if (!CLOSE_REASONS.includes(p.reason as CloseReason)) return bad("An issue is closed as completed, as not planned, or as a duplicate.");
    if (out.state !== "closed") return bad("A reason goes with closing the issue.");
    out.reason = p.reason as CloseReason;
  }
  if (p.duplicateOf !== undefined) {
    if (!isNumber(p.duplicateOf)) return bad("A duplicate names the issue it repeats, by its number.");
    if (out.reason !== "duplicate") return bad("“Duplicate of” goes with closing the issue as a duplicate.");
    if (numbers.includes(p.duplicateOf)) return bad("An issue is not a duplicate of itself.");
    out.duplicateOf = p.duplicateOf;
  }
  if (out.state === "closed" && !out.reason) out.reason = "completed";
  if (p.labels !== undefined) {
    const l = readAddRemove(p.labels, readLabels, "labels");
    if (l instanceof ForgeProblem) return l;
    out.labels = l;
  }
  if (p.assignees !== undefined) {
    const a = readAddRemove(p.assignees, readAssignees, "assignees");
    if (a instanceof ForgeProblem) return a;
    out.assignees = a;
  }
  if (p.milestone !== undefined) {
    if (p.milestone !== null && !isNumber(p.milestone)) return bad("A milestone is named by its number, or none.");
    out.milestone = p.milestone as number | null;
  }
  if (p.type !== undefined) {
    if (p.type !== null && !isIssueType(p.type)) return bad("The issue's type is one of the repository's types, by its name, or none.");
    out.type = p.type as string | null;
  }
  const changes = [out.title, out.body, out.state, out.labels, out.assignees].filter((x) => x !== null).length + (out.milestone !== undefined ? 1 : 0) + (out.type !== undefined ? 1 : 0);
  if (!changes) return bad("Nothing to change.");
  if (numbers.length > 1) {
    if (out.title !== null || out.body !== null || out.type !== undefined || out.duplicateOf !== null) return bad("Several issues at once are closed, reopened, labelled, assigned or given a milestone: nothing else.");
    if ((out.labels || out.assignees) && numbers.length > BULK_LABELLED) return bad(`Labels and assignees change on ${BULK_LABELLED} issues at most at once (each is read first).`);
  }
  return out;
}

export function describeIssueEdit(p: IssueEditParsed): string {
  const one = p.numbers.length === 1;
  const what = one ? `the issue #${p.numbers[0]}` : `the issues ${numbersInWords(p.numbers)}`;
  const it = one ? "it" : "them";
  const its = one ? "its" : "their";
  const parts: string[] = [];
  const fields = [p.title !== null ? "its title" : "", p.body !== null ? "its description" : ""].filter(Boolean);
  if (fields.length) parts.push(`change ${fields.join(" and ")}`);
  if (p.labels?.add.length) parts.push(`add the ${p.labels.add.length === 1 ? "label" : "labels"} ${quoted(p.labels.add)}`);
  if (p.labels?.remove.length) parts.push(`remove the ${p.labels.remove.length === 1 ? "label" : "labels"} ${quoted(p.labels.remove)}`);
  if (p.assignees?.add.length) parts.push(`assign ${inWords(p.assignees.add)}`);
  if (p.assignees?.remove.length) parts.push(`unassign ${inWords(p.assignees.remove)}`);
  if (p.milestone !== undefined) parts.push(p.milestone === null ? `take ${it} out of ${its} milestone` : `put ${it} in the milestone #${p.milestone}`);
  if (p.type !== undefined) parts.push(p.type === null ? "clear its type" : `make its type ${p.type}`);
  if (p.state === "closed") parts.push(p.reason === "duplicate" && p.duplicateOf ? `close ${it} as a duplicate of #${p.duplicateOf}` : `close ${it} as ${reasonInWords(p.reason ?? "completed")}`);
  if (p.state === "open") parts.push(`reopen ${it}`);
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}: ${parts.join("; ")}`;
}

const merged = (have: readonly string[], change: { add: string[]; remove: string[] }): string[] => {
  const drop = new Set(change.remove.map((x) => x.toLowerCase()));
  const out = have.filter((x) => !drop.has(x.toLowerCase()));
  for (const a of change.add) if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  return out;
};

export const issueEditSpec: ActionSpec<IssueEditParsed, IssueEditDone> = {
  kind: "issue_edit",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueEdit,
  describe: describeIssueEdit,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const notes: string[] = [];
    const issues: IssueEditDone["issues"] = [];
    for (const number of p.numbers) {
      const what = `the issue #${number}`;
      try {
        let current: Issue | null = null;
        if (p.labels || p.assignees) current = await ctx.session.issues.get(info.ref, number);
        if (current?.isPullRequest) throw new ForgeProblem(400, "is_pull", `#${number} is a pull request: its page changes it. Nothing was done.`);
        const issue = await ctx.session.issues.update(info.ref, number, {
          title: p.title ?? undefined,
          body: p.body ?? undefined,
          state: p.state ?? undefined,
          stateReason: p.state === "closed" ? (p.reason ?? "completed") : undefined,
          labels: p.labels && current ? merged(current.labels, p.labels) : undefined,
          assignees: p.assignees && current ? merged(current.assignees, p.assignees) : undefined,
          milestone: p.milestone,
          type: p.type,
        });
        if (issue.isPullRequest) throw new ForgeProblem(400, "is_pull", `#${number} is a pull request: its page changes it.`);
        issues.push({ number: issue.number, state: issue.state, reason: issue.stateReason, labels: issue.labels, assignees: issue.assignees });
        if (p.assignees?.add.length && !p.assignees.add.every((a) => issue.assignees.some((x) => x.toLowerCase() === a.toLowerCase()))) {
          notes.push(`GitHub did not assign everyone asked on #${number}: it assigns people who have access to the repository.`);
        }
      } catch (e) {
        if (e instanceof ForgeProblem) throw e;
        if (e instanceof GitBackendError && e.code === "invalid" && (p.milestone !== undefined || p.type !== undefined || p.assignees)) {
          throw new ForgeProblem(422, "not_changed", "GitHub did not change it: the milestone, the type or an assignee is not the repository's (issue types belong to organizations). Nothing else was changed after that.");
        }
        if (p.numbers.length > 1 && issues.length) {
          notes.push(`GitHub stopped at ${what}: ${e instanceof GitBackendError ? "it refused it" : "an error"}. The ones before it were changed.`);
          break;
        }
        return said(e, what);
      }
    }
    if (p.duplicateOf && issues.length) {
      try {
        await ctx.session.issues.comment(info.ref, p.numbers[0], `Duplicate of #${p.duplicateOf}`);
      } catch {
        notes.push(`It is closed as a duplicate, but GitHub did not take the comment “Duplicate of #${p.duplicateOf}”: add it from its page.`);
      }
    }
    const page = p.numbers.length === 1 ? issuePage(info.ref, p.numbers[0]) : listPage(info.ref);
    return done(info, page, p.numbers.length === 1 ? `The issue #${p.numbers[0]}` : "The issues", notes, { numbers: issues.map((x) => x.number), issues });
  },
  check: (r, p, ctx) =>
    r.id === declaredId(ctx as ActionContext<unknown>, r.id) &&
    r.numbers.length > 0 &&
    r.numbers.every((n) => p.numbers.includes(n)) &&
    (p.state === null || r.issues.every((x) => x.state === p.state)),
};

// ─── issue_comment ───────────────────────────────────────────────────────────

export interface IssueCommentParsed {
  number: number;
  comment: string | null;
  body: string | null;
  delete: boolean;
}

export interface IssueCommentDone extends Done {
  number: number;
  comment: string;
}

export function validateIssueComment(payload: unknown): IssueCommentParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The comment is not readable.");
  const number = readNumber(payload);
  if (number instanceof ForgeProblem) return number;
  if (payload.comment !== undefined && (typeof payload.comment !== "string" || !COMMENT_ID.test(payload.comment))) return bad("A comment is named by its id.");
  const comment = (payload.comment as string | undefined) ?? null;
  if (payload.delete !== undefined) {
    if (payload.delete !== true || !comment) return bad("Deleting names the comment, and only that.");
    if (payload.body !== undefined) return bad("A deleted comment has no new text.");
    return { number, comment, body: null, delete: true };
  }
  const body = readText(payload.body, "The comment", true);
  if (body instanceof ForgeProblem) return body;
  return { number, comment, body, delete: false };
}

export const describeIssueComment = (p: IssueCommentParsed): string =>
  p.delete ? `Delete your comment on the issue #${p.number}` : p.comment ? `Edit your comment on the issue #${p.number}` : `Comment on the issue #${p.number}`;

export const issueCommentSpec: ActionSpec<IssueCommentParsed, IssueCommentDone> = {
  kind: "issue_comment",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueComment,
  describe: describeIssueComment,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let id: string;
    try {
      if (p.delete && p.comment) {
        await ctx.session.issues.deleteComment(info.ref, p.comment);
        id = p.comment;
      } else if (p.comment) {
        id = (await ctx.session.issues.editComment(info.ref, p.comment, p.body ?? "")).id;
      } else {
        id = (await ctx.session.issues.comment(info.ref, p.number, p.body ?? "")).id;
      }
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "forbidden") {
        throw new ForgeProblem(403, "forbidden", "GitHub refused it: the conversation may be locked (only collaborators comment then), or the comment is someone else's. Nothing was done.");
      }
      return said(e, p.comment ? "this comment" : `the issue #${p.number}`);
    }
    const page = issuePage(info.ref, p.number);
    return done(info, page, `The issue #${p.number}`, [], { number: p.number, comment: id });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && COMMENT_ID.test(r.comment) && (p.comment === null || r.comment === p.comment),
};

// ─── issue_react ─────────────────────────────────────────────────────────────

export interface IssueReactParsed {
  number: number;
  comment: string | null;
  reaction: Reaction;
  remove: boolean;
}

export function validateIssueReact(payload: unknown): IssueReactParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The reaction is not readable.");
  const number = readNumber(payload);
  if (number instanceof ForgeProblem) return number;
  if (payload.comment !== undefined && (typeof payload.comment !== "string" || !COMMENT_ID.test(payload.comment))) return bad("A comment is named by its id.");
  if (!REACTIONS.includes(payload.reaction as Reaction)) return bad("A reaction is one of GitHub's eight.");
  if (payload.remove !== undefined && typeof payload.remove !== "boolean") return bad("Taking a reaction back is true or false.");
  return { number, comment: (payload.comment as string | undefined) ?? null, reaction: payload.reaction as Reaction, remove: payload.remove === true };
}

export const describeIssueReact = (p: IssueReactParsed): string =>
  `${p.remove ? "Take back your" : "React with"} “${REACTION_WORDS[p.reaction]}”${p.remove ? " reaction" : ""} on ${p.comment ? "a comment of " : ""}the issue #${p.number}`;

export const issueReactSpec: ActionSpec<IssueReactParsed, Done & { number: number }> = {
  kind: "issue_react",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueReact,
  describe: describeIssueReact,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const target = p.comment ? { comment: p.comment } : { issue: p.number };
    try {
      if (p.remove) await ctx.session.issues.unreact(info.ref, target, p.reaction);
      else await ctx.session.issues.react(info.ref, target, p.reaction);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "forbidden") throw new ForgeProblem(403, "forbidden", "GitHub refused it: reactions are off while a conversation is locked, except for collaborators. Nothing was done.");
      return said(e, p.comment ? "this comment" : `the issue #${p.number}`);
    }
    return done(info, issuePage(info.ref, p.number), `The issue #${p.number}`, [], { number: p.number });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number,
};

// ─── issue_lock, issue_pin ───────────────────────────────────────────────────

export interface IssueLockParsed {
  number: number;
  locked: boolean;
  reason: LockReason | null;
}

export function validateIssueLock(payload: unknown): IssueLockParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The lock is not readable.");
  const number = readNumber(payload);
  if (number instanceof ForgeProblem) return number;
  if (typeof payload.locked !== "boolean") return bad("The conversation is locked or unlocked.");
  if (payload.reason !== undefined && payload.reason !== null) {
    if (!payload.locked) return bad("A reason goes with locking.");
    if (!LOCK_REASONS.includes(payload.reason as LockReason)) return bad("A lock's reason is off-topic, too heated, resolved or spam.");
  }
  return { number, locked: payload.locked, reason: (payload.reason as LockReason | undefined) ?? null };
}

export const describeIssueLock = (p: IssueLockParsed): string =>
  p.locked ? `Lock the conversation of the issue #${p.number}${p.reason ? ` as ${p.reason}` : ""}: only collaborators may comment or react then` : `Unlock the conversation of the issue #${p.number}`;

export const issueLockSpec: ActionSpec<IssueLockParsed, Done & { number: number; locked: boolean }> = {
  kind: "issue_lock",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueLock,
  describe: describeIssueLock,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let locked: boolean;
    try {
      if (p.locked) await ctx.session.issues.lock(info.ref, p.number, p.reason ?? undefined);
      else await ctx.session.issues.unlock(info.ref, p.number);
      locked = (await ctx.session.issues.get(info.ref, p.number)).locked;
    } catch (e) {
      return said(e, `the issue #${p.number}`);
    }
    return done(info, issuePage(info.ref, p.number), `The issue #${p.number}`, [], { number: p.number, locked });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && r.locked === p.locked,
};

export interface IssuePinParsed {
  number: number;
  pinned: boolean;
}

export const issuePinSpec: ActionSpec<IssuePinParsed, Done & { number: number }> = {
  kind: "issue_pin",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload)) return bad("The pin is not readable.");
    const number = readNumber(payload);
    if (number instanceof ForgeProblem) return number;
    if (typeof payload.pinned !== "boolean") return bad("The issue is pinned or unpinned.");
    return { number, pinned: payload.pinned };
  },
  describe: (p) => (p.pinned ? `Pin the issue #${p.number} above the repository's issues` : `Unpin the issue #${p.number}`),
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    try {
      await ctx.session.issues.pin(info.ref, p.number, p.pinned);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "invalid") throw new ForgeProblem(409, "three_pinned", "GitHub pins three issues at most: unpin one first. Nothing was done.");
      return said(e, `the issue #${p.number}`);
    }
    return done(info, issuePage(info.ref, p.number), `The issue #${p.number}`, [], { number: p.number });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number,
};

// ─── issue_transfer ──────────────────────────────────────────────────────────

export interface IssueTransferParsed {
  number: number;
  to: string;
}

export const issueTransferSpec: ActionSpec<IssueTransferParsed, Done & { number: number; to: string; moved: number }> = {
  kind: "issue_transfer",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload)) return bad("The transfer is not readable.");
    const number = readNumber(payload);
    if (number instanceof ForgeProblem) return number;
    if (typeof payload.to !== "string" || !SEGMENT.test(payload.to) || /\.git$/i.test(payload.to)) return bad("The issue moves to another repository of the same account, named by its name.");
    return { number, to: payload.to };
  },
  describe: (p) => `Transfer the issue #${p.number} to the repository ${p.to} of the same account (GitHub gives it a new number there)`,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    if (p.to.toLowerCase() === info.ref.name.toLowerCase()) throw bad("The issue is already in this repository.");
    const to: RepoRef = { forge: info.ref.forge, owner: info.ref.owner, name: p.to };
    let moved: Issue;
    try {
      moved = await ctx.session.issues.transfer(info.ref, p.number, to);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "invalid") throw new ForgeProblem(422, "not_transferred", "GitHub did not transfer it: issues move between repositories of the same account, to a repository with issues on, and pull requests never move. Nothing was done.");
      return said(e, `the issue #${p.number} or the repository ${p.to}`);
    }
    const page = issuePage(to, moved.number);
    return done(info, page, `The issue, now #${moved.number} in ${p.to}`, [`GitHub moved it with its comments; labels and milestones move only when the other repository has them.`], { number: p.number, to: p.to, moved: moved.number });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && isNumber(r.moved) && r.to === p.to,
};

// ─── issue_relation ──────────────────────────────────────────────────────────

export interface IssueRelationParsed {
  number: number;
  relation: "sub" | "blockedBy";
  op: "add" | "remove";
  other: number;
}

export function validateIssueRelation(payload: unknown): IssueRelationParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The relationship is not readable.");
  const number = readNumber(payload);
  if (number instanceof ForgeProblem) return number;
  const which = (["sub", "blockedBy"] as const).filter((k) => payload[k] !== undefined);
  if (which.length !== 1) return bad("One relationship changes at a time: a sub-issue, or what blocks this issue.");
  const rel = payload[which[0]];
  if (!isObject(rel)) return bad("The relationship is not readable.");
  const ops = (["add", "remove"] as const).filter((k) => rel[k] !== undefined);
  if (ops.length !== 1 || !isNumber(rel[ops[0]])) return bad("A relationship is added or removed, naming the other issue by its number.");
  const other = rel[ops[0]] as number;
  if (other === number) return bad("An issue is not related to itself.");
  return { number, relation: which[0], op: ops[0], other };
}

export function describeIssueRelation(p: IssueRelationParsed): string {
  if (p.relation === "sub") return p.op === "add" ? `Make the issue #${p.other} a sub-issue of #${p.number}` : `Take the sub-issue #${p.other} out of #${p.number}`;
  return p.op === "add" ? `Mark the issue #${p.number} as blocked by #${p.other}` : `The issue #${p.number} is no longer blocked by #${p.other}`;
}

export const issueRelationSpec: ActionSpec<IssueRelationParsed, Done & { number: number }> = {
  kind: "issue_relation",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueRelation,
  describe: describeIssueRelation,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    try {
      if (p.relation === "sub" && p.op === "add") await ctx.session.issues.addSubIssue(info.ref, p.number, p.other);
      else if (p.relation === "sub") await ctx.session.issues.removeSubIssue(info.ref, p.number, p.other);
      else if (p.op === "add") await ctx.session.issues.addBlockedBy(info.ref, p.number, p.other);
      else await ctx.session.issues.removeBlockedBy(info.ref, p.number, p.other);
    } catch (e) {
      if (e instanceof GitBackendError && (e.code === "invalid" || e.code === "conflict")) {
        throw new ForgeProblem(422, "not_related", p.relation === "sub"
          ? "GitHub did not change it: a sub-issue has one parent, a parent holds 100 sub-issues at most, eight levels deep, and a loop is refused. Nothing was done."
          : "GitHub did not change it: the dependency is already there, not there, or would make a loop. Nothing was done.");
      }
      return said(e, `the issue #${p.number} or #${p.other}`);
    }
    return done(info, issuePage(info.ref, p.number), `The issue #${p.number}`, [], { number: p.number });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number,
};

// ─── issue_branch ────────────────────────────────────────────────────────────

export interface IssueBranchParsed {
  number: number;
  name: string;
  from: string;
}

/** GitHub's name for an issue's branch: "12-results-differ-from-table-2". */
export function issueBranchName(number: number, title: string): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return `${number}${slug ? `-${slug}` : ""}`;
}

export const issueBranchSpec: ActionSpec<IssueBranchParsed, Done & { number: number; branch: string; sha: string }> = {
  kind: "issue_branch",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload)) return bad("The branch is not readable.");
    const number = readNumber(payload);
    if (number instanceof ForgeProblem) return number;
    if (!isRefName(payload.name) || String(payload.name).startsWith("refs/")) return bad("The branch's name is not a branch name.");
    if (!String(payload.name).startsWith(`${number}-`) && payload.name !== String(number)) return bad(`An issue's branch starts with its number, “${number}-”, as GitHub names it: that is how its page finds it.`);
    if (!isRefName(payload.from) || String(payload.from).startsWith("refs/")) return bad("The branch starts from a branch of the repository.");
    return { number, name: payload.name as string, from: payload.from as string };
  },
  describe: (p) => `Create the branch ${p.name} for the issue #${p.number}, from ${p.from}`,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let sha: string;
    try {
      const from = await ctx.session.git.getBranch(info.ref, p.from);
      sha = (await ctx.session.git.createBranch(info.ref, p.name, from.sha)).sha;
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "branch_exists", `A branch named ${p.name} already exists: nothing was done.`);
      return said(e, `the branch ${p.from}`);
    }
    const page = `${repoPageOf(info.ref)}tree/${p.name.split("/").map(encodeURIComponent).join("/")}`;
    return done(info, page, `The branch ${p.name}`, [`Check it out: git fetch origin, then git switch ${p.name}. Its pull request, when it says “Fixes #${p.number}”, closes the issue on merge.`], {
      number: p.number,
      branch: p.name,
      sha,
    });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.number === p.number && r.branch === p.name && /^[0-9a-f]{40,64}$/.test(r.sha),
};

// ─── issue_labels ────────────────────────────────────────────────────────────

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export interface IssueLabelsParsed {
  create: LabelSpec[];
  update: { name: string; newName: string | null; color: string | null; description: string | null }[];
  delete: string[];
}

function readDescription(v: unknown): string | ForgeProblem {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || v.length > 100 || /[\r\n]/.test(v)) return bad("A label's description is one line of at most 100 characters.");
  return v;
}

export function validateIssueLabels(payload: unknown): IssueLabelsParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The labels are not readable.");
  const out: IssueLabelsParsed = { create: [], update: [], delete: [] };
  const seen = new Set<string>();
  const once = (name: string): ForgeProblem | null => {
    if (seen.has(name.toLowerCase())) return bad(`The label “${name}” is named twice.`);
    seen.add(name.toLowerCase());
    return null;
  };
  for (const k of ["create", "update", "delete"] as const) if (payload[k] !== undefined && !Array.isArray(payload[k])) return bad("The labels are not readable.");
  for (const l of (payload.create as unknown[] | undefined) ?? []) {
    if (!isObject(l) || !isLabelName(l.name)) return bad("A new label needs a name of one line, at most 50 characters.");
    if (!isColor(l.color)) return bad("A label's colour is one of the palette's.");
    const d = readDescription(l.description);
    if (d instanceof ForgeProblem) return d;
    const twice = once(l.name);
    if (twice) return twice;
    out.create.push({ name: l.name, color: l.color.toLowerCase(), description: d });
  }
  for (const l of (payload.update as unknown[] | undefined) ?? []) {
    if (!isObject(l) || !isLabelName(l.name)) return bad("A label to change is named by its name.");
    if (l.newName !== undefined && !isLabelName(l.newName)) return bad("A label's new name is one line of at most 50 characters.");
    if (l.color !== undefined && !isColor(l.color)) return bad("A label's colour is one of the palette's.");
    const d = l.description === undefined ? null : readDescription(l.description);
    if (d instanceof ForgeProblem) return d;
    if (l.newName === undefined && l.color === undefined && d === null) return bad(`Nothing to change on the label “${l.name}”.`);
    const twice = once(l.name);
    if (twice) return twice;
    out.update.push({ name: l.name, newName: (l.newName as string | undefined) ?? null, color: l.color ? (l.color as string).toLowerCase() : null, description: d });
  }
  for (const name of (payload.delete as unknown[] | undefined) ?? []) {
    if (!isLabelName(name)) return bad("A label to delete is named by its name.");
    const twice = once(name);
    if (twice) return twice;
    out.delete.push(name);
  }
  const n = out.create.length + out.update.length + out.delete.length;
  if (!n) return bad("No label to create, change or delete.");
  if (n > LABEL_CHANGES) return bad(`At most ${LABEL_CHANGES} changes to the labels at once.`);
  return out;
}

export function describeIssueLabels(p: IssueLabelsParsed): string {
  const parts = [
    p.create.length ? `create ${p.create.length === 1 ? "the label" : "the labels"} ${quoted(p.create.map((l) => l.name))}` : "",
    p.update.length ? `change ${p.update.length === 1 ? "the label" : "the labels"} ${quoted(p.update.map((l) => l.name))}` : "",
    p.delete.length ? `delete ${p.delete.length === 1 ? "the label" : "the labels"} ${quoted(p.delete)} (it leaves every issue and pull request that has it)` : "",
  ].filter(Boolean);
  const s = parts.join("; ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

export const issueLabelsSpec: ActionSpec<IssueLabelsParsed, Done & { created: number; updated: number; deleted: number }> = {
  kind: "issue_labels",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueLabels,
  describe: describeIssueLabels,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    const notes: string[] = [];
    const count = { created: 0, updated: 0, deleted: 0 };
    const steps: { what: string; run: () => Promise<unknown>; counts: keyof typeof count; exists?: boolean }[] = [
      ...p.create.map((l) => ({ what: `the label “${l.name}”`, run: () => ctx.session.issues.createLabel(info.ref, l), counts: "created" as const, exists: true })),
      ...p.update.map((l) => ({
        what: `the label “${l.name}”`,
        run: () => ctx.session.issues.updateLabel(info.ref, l.name, { name: l.newName ?? undefined, color: l.color ?? undefined, description: l.description ?? undefined }),
        counts: "updated" as const,
      })),
      ...p.delete.map((name) => ({ what: `the label “${name}”`, run: () => ctx.session.issues.deleteLabel(info.ref, name), counts: "deleted" as const })),
    ];
    for (const step of steps) {
      try {
        await step.run();
        count[step.counts]++;
      } catch (e) {
        if (step.exists && e instanceof GitBackendError && e.code === "conflict") {
          notes.push(`${step.what.charAt(0).toUpperCase()}${step.what.slice(1)} already exists: left as it is.`);
          continue;
        }
        if (!(count.created + count.updated + count.deleted)) {
          if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "label_exists", `A label of that name already exists: nothing was done.`);
          return said(e, step.what);
        }
        notes.push(`GitHub stopped at ${step.what}: ${e instanceof GitBackendError && e.code === "conflict" ? "a label of that name exists" : "it refused it"}. The changes before it were made.`);
        break;
      }
    }
    const { created, updated, deleted } = count;
    const page = `${repoPageOf(info.ref)}labels`;
    return done(info, page, "The labels", notes, { created, updated, deleted });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && r.created + r.updated + r.deleted + r.notes.length > 0 && r.created <= p.create.length,
};

// ─── issue_milestone ─────────────────────────────────────────────────────────

export interface IssueMilestoneParsed {
  number: number | null;
  title: string | null;
  description: string | null;
  /** undefined: unchanged; null: none. */
  dueOn: string | null | undefined;
  state: "open" | "closed" | null;
  delete: boolean;
}

export function validateIssueMilestone(payload: unknown): IssueMilestoneParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The milestone is not readable.");
  const p = payload;
  if (p.number !== undefined && !isNumber(p.number)) return bad("A milestone is named by its number.");
  const number = (p.number as number | undefined) ?? null;
  if (p.delete !== undefined) {
    if (p.delete !== true || number === null) return bad("Deleting names the milestone, and only that.");
    if (Object.keys(p).some((k) => k !== "number" && k !== "delete")) return bad("A deleted milestone has nothing else to change.");
    return { number, title: null, description: null, dueOn: undefined, state: null, delete: true };
  }
  let title: string | null = null;
  if (p.title !== undefined) {
    if (typeof p.title !== "string" || !p.title.trim() || p.title.trim().length > 256 || /[\r\n]/.test(p.title)) return bad("A milestone's title is one line of at most 256 characters.");
    title = p.title.trim();
  }
  if (number === null && title === null) return bad("A new milestone needs a title: a version of the paper, a revision, a release.");
  const description = p.description === undefined ? null : readText(p.description, "The milestone's description");
  if (description instanceof ForgeProblem) return description;
  let dueOn: string | null | undefined;
  if (p.dueOn !== undefined) {
    if (p.dueOn !== null && (typeof p.dueOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.dueOn) || Number.isNaN(Date.parse(p.dueOn)))) return bad("A due date is a day, 2026-12-01.");
    dueOn = p.dueOn === null ? null : `${p.dueOn}T00:00:00Z`;
  }
  if (p.state !== undefined && p.state !== "open" && p.state !== "closed") return bad("A milestone is open or closed.");
  const state = (p.state as "open" | "closed" | undefined) ?? null;
  if (number !== null && title === null && description === null && dueOn === undefined && state === null) return bad("Nothing to change on the milestone.");
  return { number, title, description, dueOn, state, delete: false };
}

export function describeIssueMilestone(p: IssueMilestoneParsed): string {
  if (p.delete) return `Delete the milestone #${p.number} (its issues stay, without a milestone)`;
  if (p.number === null) return `Create the milestone “${p.title}”${p.dueOn ? `, due on ${p.dueOn.slice(0, 10)}` : ""}`;
  const parts = [p.title !== null ? `rename it “${p.title}”` : "", p.description !== null ? "change its description" : "", p.dueOn !== undefined ? (p.dueOn ? `make it due on ${p.dueOn.slice(0, 10)}` : "take its due date away") : "", p.state === "closed" ? "close it" : p.state === "open" ? "reopen it" : ""].filter(Boolean);
  return `The milestone #${p.number}: ${parts.join("; ")}`;
}

export const issueMilestoneSpec: ActionSpec<IssueMilestoneParsed, Done & { number: number; deleted: boolean }> = {
  kind: "issue_milestone",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateIssueMilestone,
  describe: describeIssueMilestone,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let number: number;
    try {
      if (p.delete && p.number !== null) {
        await ctx.session.issues.deleteMilestone(info.ref, p.number);
        number = p.number;
      } else if (p.number === null) {
        number = (await ctx.session.issues.createMilestone(info.ref, { title: p.title ?? "", description: p.description ?? undefined, dueOn: p.dueOn ?? undefined, state: p.state ?? undefined })).number;
      } else {
        const patch: Record<string, unknown> = {};
        if (p.title !== null) patch.title = p.title;
        if (p.description !== null) patch.description = p.description;
        if (p.dueOn !== undefined) patch.dueOn = p.dueOn;
        if (p.state !== null) patch.state = p.state;
        number = (await ctx.session.issues.updateMilestone(info.ref, p.number, patch)).number;
      }
    } catch (e) {
      if (e instanceof GitBackendError && (e.code === "conflict" || e.code === "invalid")) throw new ForgeProblem(409, "not_changed", "GitHub did not do it: a milestone of that title may exist already. Nothing was done.");
      return said(e, p.number === null ? "this repository" : `the milestone #${p.number}`);
    }
    const page = p.delete ? `${repoPageOf(info.ref)}milestones` : `${repoPageOf(info.ref)}milestone/${number}`;
    return done(info, page, p.delete ? "The milestones" : `The milestone #${number}`, [], { number, deleted: p.delete });
  },
  check: (r, p, ctx) => r.id === declaredId(ctx as ActionContext<unknown>, r.id) && isNumber(r.number) && (p.number === null || r.number === p.number) && r.deleted === p.delete,
};

export const ISSUE_ACTIONS: readonly AnyActionSpec[] = [
  issueOpenSpec, issueEditSpec, issueCommentSpec, issueReactSpec, issueLockSpec, issuePinSpec, issueTransferSpec,
  issueRelationSpec, issueBranchSpec, issueLabelsSpec, issueMilestoneSpec,
];
