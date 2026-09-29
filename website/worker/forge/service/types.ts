// The forge service's shared types (night phase 01): what the routes of /api/forge/* receive, what
// an authorized action is, and the rows of D1 `oscr_forge` (migrations/d1-forge/). The contract,
// with the payloads and the rows each action writes: docs/FORGE.md.
//
// The service sits above GitBackend (../gitbackend.ts): repositories live in each researcher's own
// GitHub account (D00-2), every write is the person's own through one authorization per action
// (D00-4), and OSCR keeps only its layer in `oscr_forge` (D00-12).
//
// Where each part is built (the elements of phase 01):
//   index.ts      the routes (F)                 http.ts   answers, errors in words (F)
//   gate.ts       FORGE_OPEN and the caps (F)    caps.ts   the numbers (F)
//   store.ts      the rows, as statements (F)    backend.ts the GitBackend of production (F)
//   actions.ts    the registry of action kinds (F), filled by:
//     act-create.ts (E2), act-link.ts (E3), act-settings.ts, act-refs.ts, act-delete.ts (E4),
//     act-autolinks.ts (E5)
//   start.ts, act.ts (E1)   webhook.ts (E3)   read.ts (E6)

import type { AccountEnv, Context, D1Database, D1PreparedStatement } from "../../account/types.ts";
import type { Principal } from "./bearer.ts";
import type { User } from "../../account/store.ts";
import type { GitBackend, GitSession } from "../gitbackend.ts";
import type { ForgeEnv } from "../github/index.ts";
import type { ForgeName, Installation, Page, PageRequest, Permission, RepoStub } from "../types.ts";

export type { Context, D1Database, D1PreparedStatement };

// ─── the Worker's environment ────────────────────────────────────────────────

/** What the forge service reads from the Worker's environment: the accounts' (COMMUNITY, SESSION_KEY
 *  and the sign-in's secrets), the GitHub App's (ForgeEnv: Cloudflare secrets, and the development
 *  mocks' addresses), and its own. */
export type ForgeServiceEnv = AccountEnv &
  ForgeEnv & {
    /** D1 `oscr_forge` (migrations/d1-forge/). Optional: without it every /api/forge/* route answers
     *  503 not_configured, until the owner has run tools/setup_cloudflare.sh. */
    FORGE?: D1Database;
    /** "true" opens the write routes (start, act) to every signed-in account. Unset (the default,
     *  and until phase 16's content rules): only the owner may write (D01-1). Never set by the
     *  setup script. */
    FORGE_OPEN?: string;
    /** The owner's numeric GitHub id (public, stored as a Cloudflare secret by the setup script so
     *  that a deployment never wipes it): the only account that may write while FORGE_OPEN is not
     *  "true". Unset: nobody may. */
    FORGE_OWNER_GITHUB_ID?: string;
    /** Phase 10 (bearer.ts): Cloudflare's rate-limiting binding for the public API, when the owner binds
     *  it (not in wrangler.toml: its price on the free plan is the owner's to confirm). Without it, the
     *  isolate's own count limits each token. */
    API_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  };

/** What the tests (and only they) inject. The Worker passes nothing: service/backend.ts builds
 *  GitHub's backend from the environment, and the Worker's bundle never imports website/tests/. */
export interface ForgeDeps {
  /** A backend in place of GitHub's: MemoryBackend (tests/forge/memory.ts) in the tests. */
  backend?: GitBackend;
  /** The fetch GitHub's backend uses (a mock in tests). */
  fetch?: typeof fetch;
  /** Unix seconds. */
  now?: () => number;
  /** The action kinds, in place of ACTIONS (actions.ts): a test registers a fake action. */
  actions?: ActionRegistry;
}

/** One request to a forge route, as index.ts hands it to its handler: FORGE is bound, the method is
 *  the route's, and for the signed-in routes the accounts are set up (COMMUNITY, SESSION_KEY). */
export interface ForgeRequest {
  request: Request;
  url: URL;
  /** The path without its final "/": "/api/forge/start". */
  path: string;
  env: ForgeServiceEnv & { FORGE: D1Database };
  /** env.FORGE (counted in development when ACCOUNT_DEV_METRICS=1). */
  db: D1Database;
  ctx: Context;
  /** Unix seconds, from deps.now when given. */
  t: number;
  /** The backend: deps.backend, or GitHub's built from the environment on first use. */
  backend(): GitBackend;
  actions: ActionRegistry;
  deps: ForgeDeps;
  /** Phase 10: the person behind the token of a public API request (/api/v1/*), set by the API's
   *  router (api.ts) once the token, its scope and its rate limit passed; never set for the site's own
   *  routes. The shared routes read it through who.ts in place of a session. */
  principal?: Principal;
}

export type RouteHandler = (r: ForgeRequest) => Promise<Response>;

// ─── authorized actions ──────────────────────────────────────────────────────

/** Every kind of authorized action (phase 01's, phase 03's commit, phase 04's forks and pull
 *  requests, phase 05's issues, phase 07's releases). The migrations' CHECK on actions.kind lists the
 *  same (a test compares them); a later phase adds its kinds to both. */
export const ACTION_KINDS = [
  "create", "generate", "link", "papers", "rename", "edit", "topics", "features", "template",
  "default_branch", "archive", "unarchive", "transfer", "branch_create", "branch_rename",
  "branch_delete", "autolink_create", "autolink_delete", "delete_request", "restore",
  "delete_final", "software_heritage",
  // Phase 03 (migrations/d1-forge/0002_commit.sql): one web commit, made by GitHub as the person.
  "commit",
  // Phase 04 (migrations/d1-forge/0003_pulls.sql): forks and pull requests, made by GitHub as the
  // person (act-forks.ts, act-pulls.ts).
  "fork", "fork_sync", "pull_open", "pull_edit", "pull_review", "pull_comment", "pull_thread",
  "pull_merge", "pull_update", "pull_revert",
  // Phase 05 (migrations/d1-forge/0004_issues.sql): GitHub's issues, labels and milestones, made by
  // GitHub as the person (act-issues.ts).
  "issue_open", "issue_edit", "issue_comment", "issue_react", "issue_lock", "issue_pin", "issue_transfer",
  "issue_relation", "issue_branch", "issue_labels", "issue_milestone",
  // Phase 05 (migrations/d1-forge/0005_research.sql): a research issue copied to GitHub as an ordinary
  // issue, when its author asks (act-research.ts).
  "research_copy",
  // Phase 07 (migrations/d1-forge/0006_releases.sql): GitHub's releases, tags and release assets, made
  // by GitHub as the person; the release tied to a version of a paper, the Mac's jobs asked for it
  // (act-releases.ts).
  "release_create", "release_edit", "release_delete", "release_drafts", "release_research", "tag_create",
  "tag_delete", "asset_upload", "asset_delete",
  // Phase 07 (migrations/d1-forge/0007_packages.sql): a package the manifests declare, confirmed or
  // declined by a person who may push (act-packages.ts).
  "package_confirm",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** The registry's own writes of research issues (phase 05, research.ts): not authorized actions on
 *  GitHub (no start, no act), but logged in `actions` like them, so that the per-account caps and the
 *  day's rows count them. The migrations' CHECK lists ACTION_KINDS then these. */
export const RESEARCH_KINDS = ["research_open", "research_comment", "research_edit"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

/** The registry's own social writes (phase 08, social.ts and inbox.ts: migrations/d1-forge/0008_social.sql):
 *  a star, a star list or its entries, a follow or a watch level, a notification's state, a profile.
 *  Not authorized actions (nothing is written on GitHub: OSCR never stars or follows there), but logged
 *  in `actions` like the research writes, so that the per-account caps and the day's rows count them;
 *  they have their own cap (caps.ts `social`, `notices`), out of the 100 authorized actions. */
export const SOCIAL_KINDS = ["star", "star_list", "follow", "notice", "profile"] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];

/** Phase 10's writes (migrations/d1-forge/0009_automation.sql): a personal token made or revoked
 *  (tokens.ts), an outgoing webhook made, changed or deleted (hooks.ts), a commit status posted by an
 *  outside service (statuses.ts). Not authorized actions (nothing is written on GitHub), logged in
 *  `actions` like the social writes, with caps of their own (caps.ts `automation`, `statuses`). */
export const AUTOMATION_KINDS = ["token", "hook", "status"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** Every kind an action row may have. */
export const ROW_KINDS = [...ACTION_KINDS, ...RESEARCH_KINDS, ...SOCIAL_KINDS, ...AUTOMATION_KINDS] as const;
export type RowKind = ActionKind | ResearchKind | SocialKind | AutomationKind;

export const isSocialKind = (value: unknown): value is SocialKind => typeof value === "string" && (SOCIAL_KINDS as readonly string[]).includes(value);

export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && (ACTION_KINDS as readonly string[]).includes(value);
}

/** A repository as a page names it: by the forge's durable id (once known), or by its path. */
export type RepoTarget = { forge: ForgeName; id: string } | { forge: ForgeName; owner: string; name: string };

/** What the page declares at start, bound in the flow cookie with the payload's digest (E1): the
 *  action runs on this repository and this branch, never on one its payload names otherwise. */
export interface ActionTarget {
  kind: ActionKind;
  repo: RepoTarget | null;
  branch: string | null;
  /** The branch's head the page saw: a change of head is a `conflict` (the page then offers a new
   *  branch). */
  expectedHead: string | null;
}

/** A refusal said in words: `code` for the page's script, `message` for people. It is an answer,
 *  not a failure: validate returns one, a handler turns it into its HTTP answer (http.ts). */
export class ForgeProblem {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Extra fields of the answer's `error` (retryAfter, fallbackUrl, offer, cap…). */
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    this.status = status;
    this.code = code;
    this.message = message;
    this.extra = extra;
  }
}

export const isProblem = (value: unknown): value is ForgeProblem => value instanceof ForgeProblem;

/** A D1 write and the rows D1 bills for it (the row, plus one per index entry it touches): the
 *  action row's `rows` and the global cap add these up. store.ts builds them. */
export interface Write {
  stmt: D1PreparedStatement;
  rows: number;
}

/** What an action's `perform` receives. */
export interface ActionContext<P> {
  env: ForgeServiceEnv;
  /** D1 oscr_forge. */
  db: D1Database;
  /** D1 oscr_community: the reader's roles (verified author, maintainer) and the Mac's facts. */
  community: D1Database;
  backend: GitBackend;
  /** The person's own session, for this one action (a user token, revoked after it: act.ts). */
  session: GitSession;
  /** The GitHub account that authorized the action, linked to `user` (identity.ts, E1). */
  github: { id: string; login: string };
  /** The signed-in OSCR account. */
  user: User;
  /** What `validate` made of the payload. */
  parsed: P;
  /** What the page declared at start (the repository, the branch, the head it saw). */
  target: ActionTarget;
  /** The repository the target names, when OSCR knows it: loaded by act.ts for every spec with
   *  `needsRepo` (a spec with needsRepo never runs without it). */
  repo: RepoRow | null;
  t: number;
  /** The action's nonce: its row's key (actions.nonce). */
  nonce: string;
  /** The App's installations the person can see, and their repositories with the person's own
   *  permission (GitHub's /user/installations): bound to this action's token inside act.ts, so the
   *  token itself never reaches a spec. */
  installations: PersonInstallations;
  /** Phase 07: the file of a release asset, streamed as the request's body (POST /api/forge/asset,
   *  asset.ts), never parsed nor buffered; its length is the request's, held to it. Absent for every
   *  other route. */
  upload?: { body: ReadableStream<Uint8Array>; size: number };
}

/** What `ActionContext.installations` answers (ForgeAuth's, without the token). */
export interface PersonInstallations {
  list(page?: PageRequest): Promise<Page<Installation>>;
  repositories(installationId: string, page?: PageRequest): Promise<Page<RepoStub & { permission: Permission }>>;
}

/** What an action did: the answer for the page, the rows to write in the same batch as the action
 *  row (nothing is written before `check` passed), and the repository the action row names. */
export interface ActionResult<R> {
  result: R;
  writes: Write[];
  repo?: { forge: ForgeName; repoId: string; branch?: string | null };
  /** "pending": the forge will finish it later (a transfer waits for the new owner). */
  outcome?: "done" | "pending";
}

/** One kind of authorized action. The rules every spec keeps (docs/FORGE.md):
 *  - `validate` checks the payload completely before any request (names, refs and paths with
 *    ../paths.ts), and answers a ForgeProblem, never throws for a wrong payload;
 *  - `perform` acts on `ctx.repo` and `ctx.target` only, as the person (`ctx.session`), and returns
 *    its D1 rows as statements: it never executes a write itself;
 *  - `check` compares the forge's answer with what was authorized (same repository id, same
 *    branch, the new name…): false and nothing is recorded;
 *  - no token, email address or Git object ever goes into a row or an answer. */
export interface ActionSpec<P = unknown, R = unknown> {
  kind: ActionKind;
  /** The action works on a repository OSCR already knows (a row of `repos`). */
  needsRepo: boolean;
  /** Optional: whether the declared target suits this kind (start checks it before GitHub). */
  checkTarget?(target: ActionTarget): ForgeProblem | null;
  validate(payload: unknown): P | ForgeProblem;
  /** The sentence the page confirms, and the answer repeats: "Create the public repository ada/eeg". */
  describe(parsed: P): string;
  perform(ctx: ActionContext<P>): Promise<ActionResult<R>>;
  check(result: R, parsed: P, ctx: ActionContext<P>): boolean;
}

// The registry holds specs of every payload type.
// deno-lint-ignore no-explicit-any
export type AnyActionSpec = ActionSpec<any, any>;
export type ActionRegistry = ReadonlyMap<ActionKind, AnyActionSpec>;

// ─── the rows of oscr_forge ──────────────────────────────────────────────────

export type RepoMode = "created" | "installed" | "public";
export type RepoState = "active" | "archived" | "pending_deletion" | "hidden" | "deleted" | "gone";
export type PaperStatus = "linked" | "proposed";
/** Phase 07 adds `release` (the paper's tracing map versioned with a release) and `deposit` (the
 *  release's validated map deposited on Zenodo at its author's request): oscr/forgejobs.py. */
export type JobKind = "link" | "push" | "archive" | "delete_due" | "reconcile" | "release" | "deposit";
export type Outcome = "done" | "pending" | "failed";

export const REPO_MODES: readonly RepoMode[] = ["created", "installed", "public"];
export const REPO_STATES: readonly RepoState[] = ["active", "archived", "pending_deletion", "hidden", "deleted", "gone"];
export const JOB_KINDS: readonly JobKind[] = ["link", "push", "archive", "delete_due", "reconcile", "release", "deposit"];

export interface RepoRow {
  forge: ForgeName;
  repo_id: string;
  owner_id: string;
  /** Lower case. */
  owner_login: string;
  /** Lower case; "" once hidden. */
  name: string;
  mode: RepoMode;
  installation_id: string | null;
  default_branch: string | null;
  head: string | null;
  head_at: number | null;
  template: 0 | 1;
  state: RepoState;
  delete_after: number | null;
  linked_by: string;
  created_at: number;
  updated_at: number;
}

export interface RepoPaperRow {
  forge: ForgeName;
  repo_id: string;
  /** "doi:10.…", lower case. */
  paper_id: string;
  status: PaperStatus;
  by_user: string;
  at: number;
}

export interface InstallationRow {
  forge: ForgeName;
  id: string;
  account_id: string;
  account_login: string;
  account_type: "user" | "organization";
  selection: "all" | "selected";
  suspended: 0 | 1;
  updated_at: number;
}

export interface TracedPathRow {
  forge: ForgeName;
  repo_id: string;
  path: string;
  paper_id: string;
  commit_sha: string;
  ranges: number;
}

export interface ActionRow {
  day: number;
  user_id: string;
  at: number;
  nonce: string;
  kind: RowKind;
  forge: string;
  repo_id: string;
  github_user: string;
  outcome: Outcome;
  rows: number;
  /** Phase 08: what the write was about (a starred subject, a followed target, an event's subject). */
  subject: string;
}

export interface DeliveryRow {
  day: number;
  delivery: string;
  at: number;
  event: string;
  rows: number;
}

export interface JobRow {
  id: number;
  kind: JobKind;
  forge: string;
  repo_id: string;
  ref: string;
  user_id: string;
  created_at: number;
  not_before: number | null;
  /** Phase 07: the paper of a `release` or `deposit` job ("" otherwise). */
  paper_id: string;
}
