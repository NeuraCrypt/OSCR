// Content rules (night phase 16): the pure part of reports, moderation, appeals, blocks and interaction
// limits, what a target is, what a reason means, what a payload may hold, and the words people read.
// No request, no database: the routes are moderation.ts (reports, the owner's queue, appeals) and
// blocks.ts (blocks, interaction limits); what the reads drop is hidden.ts. The contract:
// docs/MODERATION.md; the decisions: docs/DECISIONS.md D16-*.
//
// Every text a person types here is plain text, masked (no email address ever reaches D1: the
// address becomes "[email hidden]", and a remaining at sign becomes "＠", which the CHECKs accept),
// without control characters, and cut to its length.

import { maskEmails } from "../mask.ts";
import { orcidChecks } from "./social-core.ts";
import { ForgeProblem } from "./types.ts";

// ─── the numbers ─────────────────────────────────────────────────────────────

/** A report's, an appeal's, a request's body. */
export const MODERATION_BODY_BYTES = 16 * 1024;
export const DETAILS_MAX = 2_000;
export const LABEL_MAX = 200;
export const NOTICE_MAX = 1_000;
export const MESSAGE_MAX = 1_000;
export const APPEAL_MAX = 2_000;
export const BLOCK_NOTE_MAX = 300;
/** Reports made without an account, every one of them together, in 24 hours (each passed Turnstile). */
export const ANONYMOUS_REPORTS_DAY = 50;
/** The open reports, appeals and requests the owner's queue shows at once (the oldest wait). */
export const QUEUE_MAX = 100;
/** Blocks one account keeps. */
export const BLOCKS_MAX = 1_000;

// ─── reasons ─────────────────────────────────────────────────────────────────

/** Why a person reports something: the acceptable-use policy's list (/acceptable-use/). */
export const REPORT_REASONS = [
  "spam", "abuse", "private_information", "malware", "copyright", "impersonation", "misinformation", "unlawful", "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** Why the owner hides something: the reports' reasons, and "low quality" (a maintainer's hidden comment). */
export const HIDE_REASONS = [...REPORT_REASONS, "low_quality"] as const;
export type HideReason = (typeof HIDE_REASONS)[number];

export const REASON_WORDS: Readonly<Record<HideReason, string>> = {
  spam: "spam or advertising",
  abuse: "harassment, threats or abuse",
  private_information: "private information about a person (doxxing)",
  malware: "malware or a harmful file",
  copyright: "a copyright or licence infringement",
  impersonation: "impersonation of a person or an organisation",
  misinformation: "deliberately false or misleading content",
  unlawful: "unlawful content",
  low_quality: "low quality or off-topic",
  other: "another breach of the rules",
};

export const isReportReason = (v: unknown): v is ReportReason => typeof v === "string" && (REPORT_REASONS as readonly string[]).includes(v);
export const isHideReason = (v: unknown): v is HideReason => typeof v === "string" && (HIDE_REASONS as readonly string[]).includes(v);

// ─── targets ─────────────────────────────────────────────────────────────────

/** What can be reported: a person, a repository, a research issue or one of its comments, a GitHub
 *  issue, pull request or release as the registry shows it, a star list, a commit status, a snippet
 *  (phase 13 builds them: the report is kept). */
export const REPORT_KINDS = ["person", "repo", "research", "comment", "issue", "pull", "release", "list", "status", "snippet"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const KIND_WORDS: Readonly<Record<ReportKind, string>> = {
  person: "a person",
  repo: "a repository",
  research: "a research issue",
  comment: "a comment on a research issue",
  issue: "an issue",
  pull: "a pull request",
  release: "a release",
  list: "a star list",
  status: "a commit status",
  snippet: "a snippet",
};

/** A target, as the pages name it and D1 keeps it. */
export interface Target {
  kind: ReportKind;
  /** "person:github:12", "repo:github:5", "research:3#2", "release:github:5/v1.0", … */
  target: string;
}

const FORGE = "(github|memory)";
const NUM = "([1-9][0-9]{0,19})";
const RE = {
  personGithub: /^person:github:([1-9][0-9]{0,19})$/,
  personOrcid: /^person:orcid:(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/,
  repo: new RegExp(`^repo:${FORGE}:${NUM}$`),
  research: /^research:([1-9][0-9]{0,9})(?:#([1-9][0-9]{0,3}))?$/,
  thread: new RegExp(`^(issue|pull):${FORGE}:${NUM}#([1-9][0-9]{0,9})$`),
  release: new RegExp(`^release:${FORGE}:${NUM}/(.{1,200})$`, "s"),
  list: /^list:(github:[1-9][0-9]{0,19}|orcid:\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/([1-9][0-9]?)$/,
  status: new RegExp(`^status:${FORGE}:${NUM}:([0-9a-f]{40}|[0-9a-f]{64}):(.{1,100})$`, "s"),
  snippet: /^snippet:([1-9][0-9]{0,19})$/,
};

/** Control characters, and the characters that reorder text invisibly. */
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

/** A tag or a context as a target holds it: printable, no at sign, no line break. */
const plainPart = (s: string): boolean => !/[\u0000-\u001f\u007f@]/.test(s) && s.trim() === s && s.length > 0;

/** A target as the registry keeps it, or null. */
export function readTarget(value: unknown): Target | null {
  if (typeof value !== "string" || value.length > 400) return null;
  const v = value.trim();
  let m: RegExpExecArray | null;
  if (RE.personGithub.test(v)) return { kind: "person", target: v };
  if ((m = RE.personOrcid.exec(v.replace(/x$/, "X")))) return orcidChecks(m[1]) ? { kind: "person", target: `person:orcid:${m[1]}` } : null;
  if (RE.repo.test(v)) return { kind: "repo", target: v };
  if ((m = RE.research.exec(v))) return { kind: m[2] ? "comment" : "research", target: v };
  if ((m = RE.thread.exec(v))) return { kind: m[1] as "issue" | "pull", target: v };
  if ((m = RE.release.exec(v))) return plainPart(m[3]) ? { kind: "release", target: v } : null;
  if ((m = RE.list.exec(v))) return m[1].startsWith("orcid:") && !orcidChecks(m[1].slice(6)) ? null : { kind: "list", target: v };
  if ((m = RE.status.exec(v))) return plainPart(m[4]) ? { kind: "status", target: v } : null;
  if (RE.snippet.test(v)) return { kind: "snippet", target: v };
  return null;
}

/** The kinds of `moderation` rows (the migration's CHECK). */
export const HIDDEN_KINDS = ["account", "github", "repo", "research", "comment", "issue", "pull", "release", "profile", "list", "status"] as const;
export type HiddenKind = (typeof HIDDEN_KINDS)[number];

/** The moderation row a target is kept under, when its key needs no lookup: a repository, a research
 *  issue or comment, a GitHub issue, pull request or release, a status. A person (their account's id)
 *  and a list (its owner's id) are resolved by the route; a snippet cannot be hidden yet. */
export function keyOf(t: Target): { kind: HiddenKind; key: string } | null {
  let m: RegExpExecArray | null;
  if ((m = RE.repo.exec(t.target))) return { kind: "repo", key: `${m[1]}:${m[2]}` };
  if ((m = RE.research.exec(t.target))) return m[2] ? { kind: "comment", key: `${m[1]}#${m[2]}` } : { kind: "research", key: m[1] };
  if ((m = RE.thread.exec(t.target))) return { kind: m[1] as "issue" | "pull", key: `${m[2]}:${m[3]}#${m[4]}` };
  if ((m = RE.release.exec(t.target))) return { kind: "release", key: `${m[1]}:${m[2]}/${m[3]}` };
  if ((m = RE.status.exec(t.target))) return { kind: "status", key: `${m[1]}:${m[2]}:${m[3]}:${m[4]}` };
  return null;
}

/** A person target's provider and subject ("github", "12"), for identities' key. */
export function personOfTarget(target: string): { provider: "github" | "orcid"; subject: string } | null {
  const g = RE.personGithub.exec(target);
  if (g) return { provider: "github", subject: g[1] };
  const o = RE.personOrcid.exec(target);
  return o ? { provider: "orcid", subject: o[1] } : null;
}

/** A list target's person and list number. */
export function listOfTarget(target: string): { person: string; listId: number } | null {
  const m = RE.list.exec(target);
  return m ? { person: `person:${m[1]}`, listId: Number(m[2]) } : null;
}

/** The repository a target is on ("github:5"), for a repository, a GitHub thread, a release, a status. */
export function repoOfTarget(target: string): { forge: "github" | "memory"; repoId: string } | null {
  const m = /^(?:repo|issue|pull|release|status):(github|memory):([1-9][0-9]{0,19})/.exec(target);
  return m ? { forge: m[1] as "github" | "memory", repoId: m[2] } : null;
}

/** The research issue a target is about (an issue or one of its comments). */
export function researchOfTarget(target: string): { id: number; comment: number | null } | null {
  const m = RE.research.exec(target);
  return m ? { id: Number(m[1]), comment: m[2] ? Number(m[2]) : null } : null;
}

// ─── texts ───────────────────────────────────────────────────────────────────

/** A text as stored: plain, several lines allowed, addresses masked, at signs made harmless, cut. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = maskEmails(value.replace(/\r\n?/g, "\n").replace(CONTROL, "")).replace(/@/g, "＠").trim();
  return [...text].slice(0, max).join("");
}

/** A one-line text (a label, a note): the same, on one line. */
export function cleanLine(value: unknown, max: number): string {
  return cleanText(typeof value === "string" ? value.replace(/\s+/g, " ") : value, max);
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const token = (v: unknown): string => (typeof v === "string" && v.length <= 2048 ? v : "");

// ─── reports ─────────────────────────────────────────────────────────────────

export interface ReportParsed {
  target: Target;
  reason: ReportReason;
  details: string;
  label: string;
  /** Turnstile's token (turnstile.ts checks it). */
  turnstile: string;
}

/** A report: its target, its reason, the reporter's words (required for "other", and to say which
 *  work a copyright report is about), a label for the queue. */
export function validateReport(body: unknown): ReportParsed | ForgeProblem {
  if (!isObject(body)) return bad("The report is not readable.");
  const target = readTarget(body.target);
  if (!target) return bad("This is not something the registry shows, or it is not named the way the registry names it.");
  if (!isReportReason(body.reason)) return bad("Choose why you report it.");
  if (body.details !== undefined && typeof body.details !== "string") return bad("Your words are not text.");
  if (typeof body.details === "string" && [...body.details].length > DETAILS_MAX) return bad(`Say it in ${DETAILS_MAX.toLocaleString("en-GB")} characters at most.`);
  const details = cleanText(body.details, DETAILS_MAX);
  if (body.reason === "other" && details.length < 10) return bad("Say in a few words what breaks the rules.");
  if (body.reason === "copyright" && details.length < 30) return bad("Say which work of yours it copies, and where it is: at least a sentence.");
  return { target, reason: body.reason, details, label: cleanLine(body.label, LABEL_MAX), turnstile: token(body.turnstile) };
}

// ─── the owner's decisions ───────────────────────────────────────────────────

export type DecisionOp = "dismiss" | "hide" | "restore" | "appeal";
export interface DecisionParsed {
  op: DecisionOp;
  /** The report it answers (dismiss; hide from a report). */
  report: number | null;
  target: Target | null;
  /** hide a person: the whole account ("account"), or only the words of their profile ("profile"). */
  scope: "account" | "profile" | null;
  reason: HideReason | null;
  notice: string;
  message: string;
  /** appeal: the owner's answer. */
  appeal: "accepted" | "rejected" | null;
  label: string;
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2 ** 53;

export function validateDecision(body: unknown): DecisionParsed | ForgeProblem {
  if (!isObject(body)) return bad("The decision is not readable.");
  const op = body.op;
  if (op !== "dismiss" && op !== "hide" && op !== "restore" && op !== "appeal") return bad("The decision is dismiss, hide, restore or appeal.");
  const report = body.report === undefined || body.report === null ? null : isId(body.report) ? body.report : NaN;
  if (Number.isNaN(report)) return bad("A report is named by its number.");
  const out: DecisionParsed = {
    op,
    report: report as number | null,
    target: null,
    scope: null,
    reason: null,
    notice: cleanText(body.notice, NOTICE_MAX),
    message: cleanText(body.message, MESSAGE_MAX),
    appeal: null,
    label: cleanLine(body.label, LABEL_MAX),
  };
  if (op === "dismiss") {
    if (out.report === null) return bad("Name the report to dismiss.");
    return out;
  }
  const target = readTarget(body.target);
  if (!target) return bad("Name what the decision is about.");
  if (target.kind === "snippet") return bad("Snippets are not built yet: nothing of them can be hidden.");
  out.target = target;
  if (target.kind === "person") {
    const scope = body.scope ?? "account";
    if (scope !== "account" && scope !== "profile") return bad("A person is hidden whole (account) or only their profile's words (profile).");
    out.scope = scope;
  }
  if (op === "hide") {
    if (!isHideReason(body.reason)) return bad("Say why it is hidden.");
    out.reason = body.reason;
  }
  if (op === "appeal") {
    if (body.appeal !== "accepted" && body.appeal !== "rejected") return bad("An appeal is accepted or rejected.");
    out.appeal = body.appeal;
  }
  return out;
}

/** The public notice of a decision when the owner gives none: what, and why, never who asked. */
export function defaultNotice(kind: HiddenKind, reason: HideReason): string {
  const what: Readonly<Record<HiddenKind, string>> = {
    account: "An account was suspended and its activity hidden",
    github: "An account's activity on GitHub was hidden",
    repo: "A repository was hidden from the registry's pages",
    research: "A research issue was hidden",
    comment: "A comment on a research issue was hidden",
    issue: "An issue was hidden from the registry's pages",
    pull: "A pull request was hidden from the registry's pages",
    release: "A release was hidden from the registry's pages",
    profile: "A profile's words were hidden",
    list: "A star list was hidden",
    status: "A commit status was hidden",
  };
  return `${what[kind]}: ${REASON_WORDS[reason]}.`;
}

// ─── appeals and counter-notices ─────────────────────────────────────────────

export interface AppealParsed {
  target: Target;
  kind: "appeal" | "counter_notice";
  text: string;
  turnstile: string;
}

/** An appeal (or, for a copyright takedown, a counter-notice with its two statements): the person
 *  says why the decision is wrong. */
export function validateAppeal(body: unknown): AppealParsed | ForgeProblem {
  if (!isObject(body)) return bad("The appeal is not readable.");
  const target = readTarget(body.target);
  if (!target) return bad("Name what the appeal is about.");
  const kind = body.kind ?? "appeal";
  if (kind !== "appeal" && kind !== "counter_notice") return bad("It is an appeal or a counter-notice.");
  if (typeof body.text !== "string") return bad("Say why the decision is wrong.");
  if ([...body.text].length > APPEAL_MAX) return bad(`Say it in ${APPEAL_MAX.toLocaleString("en-GB")} characters at most.`);
  const text = cleanText(body.text, APPEAL_MAX);
  if (text.length < 20) return bad("Say in a sentence or two why the decision is wrong.");
  if (kind === "counter_notice" && (body.goodFaith !== true || body.accurate !== true)) {
    return bad("A counter-notice needs both statements: that you believe in good faith the content was removed by mistake, and that what you say is accurate.");
  }
  return { target, kind, text, turnstile: token(body.turnstile) };
}

// ─── blocks and interaction limits ───────────────────────────────────────────

export interface BlockParsed {
  /** A person ("person:github:12"), or the thing whose author is blocked ("research:3#2"). */
  target: Target;
  on: boolean;
  note: string;
}

export function validateBlock(body: unknown): BlockParsed | ForgeProblem {
  if (!isObject(body)) return bad("The block is not readable.");
  const target = readTarget(body.target);
  if (!target || !["person", "research", "comment"].includes(target.kind)) return bad("Block a person, or the author of a research issue or comment.");
  if (typeof body.on !== "boolean") return bad("Say whether to block or unblock.");
  if (body.note !== undefined && typeof body.note !== "string") return bad("The note is not text.");
  return { target, on: body.on, note: cleanLine(body.note, BLOCK_NOTE_MAX) };
}

export const LIMIT_LEVELS = ["existing_users", "contributors", "managers"] as const;
export type LimitLevel = (typeof LIMIT_LEVELS)[number];
export const LIMIT_WORDS: Readonly<Record<LimitLevel, string>> = {
  existing_users: "only accounts older than 24 hours",
  contributors: "only the paper's verified authors, the code's maintainers, the people who manage it and those who already took part",
  managers: "only the people who manage the repository",
};
/** How strict a level is (the stricter of a repository's and its account's limits applies). */
export const LIMIT_RANK: Readonly<Record<LimitLevel, number>> = { existing_users: 1, contributors: 2, managers: 3 };
/** GitHub's durations: 24 hours, 3 days, 1 week, 1 month, 6 months. */
export const LIMIT_DURATIONS: Readonly<Record<string, number>> = { "24h": 86_400, "3d": 3 * 86_400, "1w": 7 * 86_400, "1m": 30 * 86_400, "6m": 182 * 86_400 };
/** "Existing users": accounts older than this. */
export const NEW_ACCOUNT_SECONDS = 86_400;

export interface LimitParsed {
  /** "repo:<forge>:<id>", or "account" (every repository the person manages). */
  scope: string;
  /** null: the limit is lifted. */
  level: LimitLevel | null;
  seconds: number;
}

export function validateLimit(body: unknown): LimitParsed | ForgeProblem {
  if (!isObject(body)) return bad("The limit is not readable.");
  const scope = body.scope === "account" ? "account" : typeof body.scope === "string" && RE.repo.test(body.scope) ? body.scope : null;
  if (!scope) return bad("A limit is on a repository (repo:<forge>:<id>) or on your account.");
  if (body.level === null) return { scope, level: null, seconds: 0 };
  if (!(LIMIT_LEVELS as readonly unknown[]).includes(body.level)) return bad("The limit is existing_users, contributors or managers, or null to lift it.");
  const seconds = typeof body.duration === "string" ? LIMIT_DURATIONS[body.duration] : undefined;
  if (!seconds) return bad("A limit lasts 24h, 3d, 1w, 1m or 6m.");
  return { scope, level: body.level as LimitLevel, seconds };
}

// ─── data rights ─────────────────────────────────────────────────────────────

export const RIGHTS = ["access", "portability", "rectification", "erasure", "objection", "restriction"] as const;
export type Right = (typeof RIGHTS)[number];
export const RIGHT_WORDS: Readonly<Record<Right, string>> = {
  access: "a copy of the personal data the registry holds about you (access)",
  portability: "your data in a machine-readable form (portability)",
  rectification: "a correction of data about you (rectification)",
  erasure: "the erasure of data about you (erasure)",
  objection: "that the registry stop a use of your data (objection)",
  restriction: "that the registry keep but not use your data while a question is settled (restriction)",
};
/** Open requests one account may have at once. */
export const RIGHTS_OPEN_MAX = 3;

export interface RightsParsed {
  right: Right;
  details: string;
  turnstile: string;
}

export function validateRights(body: unknown): RightsParsed | ForgeProblem {
  if (!isObject(body)) return bad("The request is not readable.");
  if (!(RIGHTS as readonly unknown[]).includes(body.right)) return bad("Choose the right you exercise.");
  if (body.details !== undefined && typeof body.details !== "string") return bad("Your words are not text.");
  if (typeof body.details === "string" && [...body.details].length > DETAILS_MAX) return bad(`Say it in ${DETAILS_MAX.toLocaleString("en-GB")} characters at most.`);
  const details = cleanText(body.details, DETAILS_MAX);
  if ((body.right === "rectification" || body.right === "objection") && details.length < 10) return bad("Say what to correct, or which use you object to.");
  return { right: body.right as Right, details, turnstile: token(body.turnstile) };
}
