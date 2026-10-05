// OSCR's own caps on the forge service (the design's §10.4; docs/FORGE.md "Caps"). They are not the
// forge's limits (those are ../limits.ts, GITHUB_LIMITS): they keep what passes through the Worker
// within its 10 ms of CPU and the forge service within its share of D1's free plan.
//
// - The Worker parses and rebuilds an action's JSON: 1 MiB costs 0.6 to 2.8 ms (V8 on the Mac,
//   ../limits.ts), 5 MiB does not fit. Above it, GitHub's own pages or `git push`.
// - D1: 100,000 rows written a day for the whole account; the Worker's share is 10,000, and the
//   forge service's 5,000 until the owner confirms C3 (D00-12). Counted from the rows written
//   today (actions.rows, deliveries.rows: gate.ts), with no counter row.

import type { RowKind } from "./types.ts";

const MiB = 2 ** 20;

/** An authorized action's payload (a web commit's files, a body). */
export const ACTION_PAYLOAD_BYTES = 1 * MiB;
/** A release asset streamed through the Worker, raw (no parse, no base64). Larger: GitHub's page. */
export const ASSET_UPLOAD_BYTES = 25 * MiB;
/** A webhook delivery: larger ones get 413 before any hashing, and the Mac's polling catches up. */
export const WEBHOOK_BYTES = 1 * MiB;
/** Files in one web commit. */
export const COMMIT_FILES = 100;
/** Changed files OSCR's pull-request check reads (3 pages); beyond, it says so. */
export const PR_FILES_CHECKED = 300;
/** Rows the forge service writes in D1 in a UTC day, every account and every webhook together. */
export const FORGE_ROWS_PER_DAY = 5_000;
/** What one account may do in 24 hours: authorized actions of every kind (and the registry's own
 *  writes of research issues, phase 05), repositories created (create, generate), repositories
 *  linked (link), research issues opened (research_open). */
export const PER_ACCOUNT_DAY = {
  actions: 100, creations: 10, links: 20, research: 20, social: 300, notices: 500, automation: 50, statuses: 300,
  // Phase 16: reports, the owner's decisions, appeals, blocks and interaction limits, data-rights requests.
  reports: 20, moderation: 500, appeals: 5, blocks: 100, limits: 20, rights: 3,
  // Phase 11: a security alert triaged, a SARIF upload, a private vulnerability report written.
  triage: 200, scanning: 100, advisory: 50,
  // Phase 09: an organization, membership, role or team change; an account-security change (a
  // passkey, a session revoked, an identity unlinked).
  orgs: 300, security: 200,
} as const;
export type Cap = keyof typeof PER_ACCOUNT_DAY;
/** OSCR's grace period before a repository asked for deletion may be deleted (D00-10). */
export const GRACE_SECONDS = 30 * 86_400;
/** The flow cookie of one authorized action (start → GitHub → act). */
export const FLOW_SECONDS = 600;
/** The body of POST /api/forge/start: the declared action, never its payload. */
export const START_BODY_BYTES = 8 * 1024;
/** GitHub lets a delivery be redelivered for 3 days: the redelivery check reads that far back. */
export const REDELIVERY_DAYS = 3;

export const DAY_SECONDS = 86_400;

/** The UTC day of a time (D1's own day, and the key's first column of actions and deliveries). */
export const utcDay = (t: number): number => Math.floor(t / DAY_SECONDS);

/** Seconds until the next 00:00 UTC, when the day's caps start again (Retry-After). */
export const untilNextDay = (t: number): number => Math.max(60, (utcDay(t) + 1) * DAY_SECONDS - Math.floor(t));

/** The cap each kind counts toward besides `actions` (phase 08's social kinds count toward their own
 *  cap only, never toward the 100 authorized actions: a person who stars and reads does not lose the
 *  right to act). */
export const CAP_OF: Readonly<Partial<Record<RowKind, Exclude<Cap, "actions">>>> = {
  create: "creations",
  generate: "creations",
  link: "links",
  research_open: "research",
  star: "social",
  star_list: "social",
  follow: "social",
  profile: "social",
  notice: "notices",
  token: "automation",
  hook: "automation",
  status: "statuses",
  report: "reports",
  moderate: "moderation",
  appeal: "appeals",
  block: "blocks",
  limit: "limits",
  rights: "rights",
  security_alert: "triage",
  sarif: "scanning",
  advisory_open: "advisory",
  advisory_post: "advisory",
  advisory_edit: "advisory",
  org: "orgs",
  member: "orgs",
  team: "orgs",
  passkey: "security",
  session: "security",
  identity: "security",
};

/** The kinds each cap counts. */
export const KINDS_OF: Readonly<Record<Exclude<Cap, "actions">, readonly RowKind[]>> = {
  creations: ["create", "generate"],
  links: ["link"],
  research: ["research_open"],
  social: ["star", "star_list", "follow", "profile"],
  notices: ["notice"],
  automation: ["token", "hook"],
  statuses: ["status"],
  reports: ["report"],
  moderation: ["moderate"],
  appeals: ["appeal"],
  blocks: ["block"],
  limits: ["limit"],
  rights: ["rights"],
  triage: ["security_alert"],
  scanning: ["sarif"],
  advisory: ["advisory_open", "advisory_post", "advisory_edit"],
  orgs: ["org", "member", "team"],
  security: ["passkey", "session", "identity"],
};

/** Phase 08: the caps that stand alone (their kinds are not counted in `actions`); phase 10 adds its
 *  own (tokens and hooks changed; statuses posted by an outside service). */
export const OWN_CAPS: ReadonlySet<Cap> = new Set<Cap>(["social", "notices", "automation", "statuses", "reports", "moderation", "appeals", "blocks", "limits", "rights", "triage", "scanning", "advisory", "orgs", "security"]);

/** A cap in words, for the answers ("10 repositories created"). */
export const CAP_WORDS: Readonly<Record<Cap, (n: number) => string>> = {
  actions: (n) => `${n} authorized ${n === 1 ? "action" : "actions"}`,
  creations: (n) => `${n} ${n === 1 ? "repository" : "repositories"} created`,
  links: (n) => `${n} ${n === 1 ? "repository" : "repositories"} linked`,
  research: (n) => `${n} research ${n === 1 ? "issue" : "issues"} opened`,
  social: (n) => `${n} stars, follows, lists and profile changes`,
  notices: (n) => `${n} changes to your notifications`,
  automation: (n) => `${n} changes to your tokens and webhooks`,
  statuses: (n) => `${n} commit statuses posted`,
  reports: (n) => `${n} reports`,
  moderation: (n) => `${n} moderation decisions`,
  appeals: (n) => `${n} appeals`,
  blocks: (n) => `${n} blocks and unblocks`,
  limits: (n) => `${n} changes to interaction limits`,
  rights: (n) => `${n} data-rights requests`,
  triage: (n) => `${n} security alerts triaged`,
  scanning: (n) => `${n} code-scanning uploads`,
  advisory: (n) => `${n} changes to private vulnerability reports`,
  orgs: (n) => `${n} changes to organizations and teams`,
  security: (n) => `${n} changes to your account's security`,
};
