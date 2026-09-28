// GitBackend's types: every read and write OSCR makes on a Git forge, in forge-neutral shapes.
//
// What this is (night run 2026-09-28/29, phase 00; docs/DECISIONS.md D00-1 to D00-16):
// - OSCR hosts no Git repository. Repositories live in each researcher's own account on a forge
//   (GitHub first), created and driven by OSCR's GitHub App with that person's consent, one
//   authorization per action. OSCR keeps only its own layer (links to papers and DOIs, tracing
//   maps pinned to commits, reviews, scientific issue types) in D1 `oscr_forge` and on the Mac.
// - `GitBackend` (gitbackend.ts) is the forge adapter; these are its data. A backend returns them,
//   the forge service of phase 01 (`forge/service/`, routes /api/forge/*) and the browser's
//   pages consume them.
//
// Rules every backend keeps (the contract suite, tests/forge/contract.ts, checks them):
// - Every field is plain JSON-able data, except `Uint8Array`, `ReadableStream` and `Headers`.
// - **No email address in any structure.** `Actor` has no email field; the mappers never copy
//   one. Free texts (commit messages, bodies, file contents, patches) are returned raw: every
//   renderer masks them with `maskEmails` (mask.ts), as CLAUDE.md asks of the whole site.
// - Repositories are keyed by the forge's durable id (`RepoKey`), which survives renames and
//   transfers; `RepoRef` (the path) is what people type and what the forge's URLs carry.
// - Times are ISO 8601 strings (UTC), except `pushedAt` of a push event and token expiries, which
//   are Unix seconds.

// ─── identifiers ───────────────────────────────────────────────────────────

/** The forges a backend speaks for. "memory" is the test double. "gitlab", "forgejo" and
 *  "cloudflare" are reserved for later backends (D00-13). */
export type ForgeName = "github" | "memory";

/** A repository by its path: changes on a rename or a transfer (the forge redirects the old
 *  path for a while). Compare owner and name case-insensitively. */
export interface RepoRef {
  forge: ForgeName;
  owner: string;
  name: string;
}

/** A repository by the forge's durable id: survives renames and transfers. GitHub: the numeric
 *  `id` as a decimal string. OSCR's rows and tracing maps key repositories by this. */
export interface RepoKey {
  forge: ForgeName;
  id: string;
}

/** A Git object id, lower-case hex: 40 characters (SHA-1); 64 (SHA-256) is accepted so a later
 *  forge with SHA-256 repositories fits (Git plans SHA-256 as its default). */
export type ObjectId = string;

/** A revision as a caller writes it: a branch or tag name, "refs/…", or a full object id. */
export type Rev = string;

// ─── credentials, pages, people ───────────────────────────────────────────

/** Who a session acts as (D00-4):
 *  - anonymous: the browser reading public repositories on its own quota;
 *  - user: a per-action user access token, held for one request, never stored;
 *  - installation: the App itself, on a repository whose owner installed it; the backend mints
 *    the 1-hour token from the App's key and keeps it in memory only. */
export type Credential =
  | { kind: "anonymous" }
  | { kind: "user"; token: string }
  | { kind: "installation"; installationId: string };

export type CredentialKind = Credential["kind"];

/** Pages: an opaque cursor, never a URL (the Worker must not fetch an address a client chose).
 *  GitHub REST: the page number as text; GraphQL: the connection's endCursor. */
export interface PageRequest {
  cursor?: string | null;
  /** 1 to 100; default 30. */
  perPage?: number;
}

export interface Page<T> {
  items: T[];
  /** The next page's cursor; null on the last page. */
  next: string | null;
}

/** A person as OSCR may show them. There is no email field, on purpose (D00-14). */
export interface Actor {
  /** The commit metadata's name, or the account's login. */
  name: string;
  /** The forge account, when the forge links one. */
  login: string | null;
  /** The forge account's durable id, as a decimal string. */
  id: string | null;
}

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

// ─── repositories ─────────────────────────────────────────────────────────

export interface RepoFeatures {
  issues: boolean;
  wiki: boolean;
  autoMerge: boolean;
  deleteBranchOnMerge: boolean;
}

export interface RepoInfo {
  key: RepoKey;
  /** GitHub's GraphQL node id (several operations need it); null for other forges. */
  nodeId: string | null;
  ref: RepoRef;
  owner: { id: string; login: string; type: "user" | "organization" };
  visibility: "public" | "private" | "internal";
  archived: boolean;
  /** Disabled by the forge (GitHub: a takedown or a policy action). */
  disabled: boolean;
  isTemplate: boolean;
  /** Forked from. */
  parent: RepoRef | null;
  /** Generated from. */
  template: RepoRef | null;
  /** null: an empty repository (no commit yet). */
  defaultBranch: string | null;
  description: string;
  homepage: string;
  topics: string[];
  /** The forge's own license detection (SPDX), or null. OSCR's verified license is the Mac's. */
  licenseSpdx: string | null;
  sizeKb: number;
  /** ISO 8601. */
  createdAt: string;
  pushedAt: string | null;
  features: RepoFeatures;
  /** The session's own permission when the forge says (user and installation sessions). */
  permission: Permission | null;
  webUrl: string;
  /** https; the researcher's git uses it directly (D00-3). */
  cloneUrl: string;
}

export interface CreateRepositoryInput {
  name: string;
  description?: string;
  homepage?: string;
  /** Public only for now (D00-14); the type widens when private repositories are supported. */
  visibility: "public";
  /** A first commit (a README), so the repository has a default branch at once. */
  autoInit?: boolean;
  /** A forge template key: "Python", "R". */
  gitignoreTemplate?: string;
  /** A forge license key: "mit", "cc-by-4.0". */
  licenseTemplate?: string;
  /** A template others generate repositories from (a research compendium's skeleton). */
  isTemplate?: boolean;
  features?: Partial<RepoFeatures>;
}

export interface GenerateInput {
  /** The caller's login, or an organization they may create in. */
  owner: string;
  name: string;
  description?: string;
  visibility: "public";
  includeAllBranches?: boolean;
}

export interface ForkInput {
  /** Default: the caller's own account. */
  organization?: string;
  name?: string;
  defaultBranchOnly?: boolean;
}

export interface RepoPatch {
  /** A rename. The forge redirects the old path; OSCR follows the id. */
  name?: string;
  description?: string;
  homepage?: string;
  archived?: boolean;
  defaultBranch?: string;
  /** Not in the design's first sketch: GitHub's PATCH takes `is_template`, and a researcher
   *  turns a compendium into a template (the contract's `generate` needs one). */
  isTemplate?: boolean;
  features?: Partial<RepoFeatures>;
}

export interface TransferInput {
  newOwner: string;
  newName?: string;
}

/** A server-side import (capability "serverImport"). GitHub has none since its Source Imports
 *  API was retired (2024): its adapter throws `unsupported` with the importer page as
 *  fallbackUrl, and imports run on the researcher's machine (D00-8). */
export interface ImportInput {
  source: { kind: "git"; url: string } | { kind: "zenodo"; recordId: string };
  owner: string;
  name: string;
  description?: string;
  visibility: "public";
}

// ─── refs, trees, files ───────────────────────────────────────────────────

export interface Branch {
  name: string;
  /** The commit it points to. */
  sha: ObjectId;
  protected: boolean;
}

export interface Tag {
  name: string;
  /** The commit it names (peeled). */
  sha: ObjectId;
  annotation: { sha: ObjectId; message: string; tagger: Actor | null } | null;
}

export interface TagInput {
  name: string;
  /** A commit. */
  sha: ObjectId;
  /** An annotated tag when set; a lightweight one otherwise. */
  message?: string;
}

/** "commit": a submodule. */
export type EntryType = "blob" | "tree" | "commit";

export interface TreeEntry {
  /** From the root, "/"-separated, no leading "/". */
  path: string;
  mode: "100644" | "100755" | "120000" | "040000" | "160000";
  type: EntryType;
  sha: ObjectId;
  /** Blobs only. */
  size: number | null;
}

export interface Tree {
  sha: ObjectId;
  entries: TreeEntry[];
  /** The forge cut the listing (GitHub, recursive: 100,000 entries or 7 MB): list sub-trees. */
  truncated: boolean;
}

export interface FileContent {
  path: string;
  /** The blob id; computed locally (SHA-1 of "blob <size>\0" + bytes) when the forge does not
   *  send it (a raw read). */
  sha: ObjectId;
  size: number;
  bytes: Uint8Array;
  /** git's own rule: a NUL byte in the first 8,000 bytes. */
  binary: boolean;
  /** The blob is a Git LFS pointer. Its object is never fetched: the download would spend the
   *  owner's LFS bandwidth (D00-9). */
  lfs: { oid: string; size: number } | null;
}

// ─── commits, comparisons, blame, search ──────────────────────────────────

export interface CommitSummary {
  sha: ObjectId;
  parents: ObjectId[];
  tree: ObjectId;
  /** Raw: renderers mask email addresses (Signed-off-by lines carry them). */
  message: string;
  author: Actor;
  authoredAt: string;
  committer: Actor;
  committedAt: string;
  /** The forge verified a signature; null when it does not say. */
  verified: boolean | null;
}

export type FileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

export interface FileChangeSummary {
  path: string;
  /** Renames and copies. */
  previousPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** A unified diff of this file; null when binary or too large for the forge to send. */
  patch: string | null;
  /** The new blob; null when removed. */
  blob: ObjectId | null;
}

export interface CommitDetail extends CommitSummary {
  stats: { additions: number; deletions: number; total: number };
  /** One page of changed files (GitHub: 300 a page, 3,000 at most). */
  files: Page<FileChangeSummary>;
}

export interface CommitFilter {
  /** Default: the default branch. */
  rev?: Rev;
  /** A file's history. */
  path?: string;
  /** ISO 8601. */
  since?: string;
  until?: string;
  authorLogin?: string;
}

export interface Comparison {
  status: "identical" | "ahead" | "behind" | "diverged";
  aheadBy: number;
  behindBy: number;
  mergeBase: ObjectId;
  /** Oldest first; at most `limits.compareCommits` (GitHub: 250). */
  commits: CommitSummary[];
  /** The changes from the merge base to head (a "three-dot" comparison). */
  files: Page<FileChangeSummary>;
}

export interface BlameRange {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  commit: CommitSummary;
}

export interface CodeHit {
  path: string;
  sha: ObjectId;
  /** Raw: renderers mask email addresses. */
  fragments: string[];
}

// ─── writing commits ──────────────────────────────────────────────────────

export type FileChange =
  | { op: "put"; path: string; content: Uint8Array; executable?: boolean }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

export interface CommitInput {
  branch: string;
  /** The branch's head the change was made on. The commit fails with `conflict` when the
   *  branch has moved (optimistic concurrency). null only with `createFrom` or `parents: []`. */
  expectedHead: ObjectId | null;
  /** Create `branch` at this commit first (a new branch, e.g. for a pull request). */
  createFrom?: ObjectId;
  /** Default [expectedHead]. Two for a merge commit (a conflict resolved in the browser,
   *  capability "multiParentCommits"); [] for an orphan commit (a new `wiki` branch, capability
   *  "orphanCommits"). */
  parents?: ObjectId[];
  changes: FileChange[];
  message: string;
  /** A commit that changes nothing is refused (`invalid`) unless this is set. */
  allowEmpty?: boolean;
}

export interface CommitResult {
  sha: ObjectId;
  tree: ObjectId;
  branch: string;
  parents: ObjectId[];
}

export interface MergeInput {
  /** The branch that receives. */
  base: string;
  /** A branch or a commit. */
  head: Rev;
  message?: string;
  /** Checked just before merging: GitHub's branch merge has no compare-and-swap of its own. */
  expectedBaseHead?: ObjectId;
}

export type MergeResult = { status: "merged"; sha: ObjectId } | { status: "up_to_date" };

// ─── pull requests and reviews (phase 04) ─────────────────────────────────

export type MergeMethod = "merge" | "squash" | "rebase";

export interface PullRequest {
  /** Shared numbering with issues on GitHub. */
  number: number;
  id: string;
  nodeId: string | null;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommit: ObjectId | null;
  author: Actor;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** repo null: the fork was deleted. */
  head: { repo: RepoRef | null; ref: string; sha: ObjectId };
  base: { repo: RepoRef; ref: string; sha: ObjectId };
  /** null while the forge is still computing it: ask again later, never in a loop. */
  mergeable: boolean | null;
  mergeState: "clean" | "dirty" | "blocked" | "behind" | "unstable" | "draft" | "unknown";
  requestedReviewers: string[];
  labels: string[];
  assignees: string[];
  milestone: number | null;
  autoMerge: MergeMethod | null;
  maintainerCanModify: boolean;
  counts: { commits: number; additions: number; deletions: number; changedFiles: number; comments: number };
}

export interface PullFilter {
  state?: "open" | "closed" | "all";
  /** "owner:branch". */
  head?: string;
  base?: string;
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
}

export interface NewPullRequest {
  title: string;
  body?: string;
  /** "branch", or "owner:branch" from a fork. */
  head: string;
  base: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
}

export interface PullPatch {
  title?: string;
  body?: string;
  /** Close, reopen. */
  state?: "open" | "closed";
  base?: string;
}

export interface PullMergeInput {
  method: MergeMethod;
  /** The head the reader saw and approved: the merge fails with `conflict` when it moved. */
  expectedHead: ObjectId;
  title?: string;
  message?: string;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewLineComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  /** A suggested change is a "```suggestion" block; applying one is a commit. */
  body: string;
}

export interface NewReview {
  event: ReviewEvent;
  body?: string;
  /** Default: the head. */
  commit?: ObjectId;
  comments?: ReviewLineComment[];
}

export interface Review {
  id: string;
  author: Actor;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  commit: ObjectId | null;
  submittedAt: string | null;
}

export interface ReviewComment {
  id: string;
  reviewId: string | null;
  inReplyTo: string | null;
  author: Actor;
  path: string;
  /** null: outdated. */
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  commit: ObjectId;
  originalCommit: ObjectId;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewThread {
  id: string;
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewComment[];
}

// ─── issues (phase 05) ────────────────────────────────────────────────────

export type LockReason = "off-topic" | "too heated" | "resolved" | "spam";
export type Reaction = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
export type StateReason = "completed" | "not_planned" | "duplicate" | "reopened";

export interface Issue {
  number: number;
  id: string;
  nodeId: string | null;
  title: string;
  /** Raw: renderers mask email addresses. */
  body: string;
  state: "open" | "closed";
  stateReason: StateReason | null;
  author: Actor;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  locked: boolean;
  lockReason: LockReason | null;
  /** null: this answer does not say. */
  pinned: boolean | null;
  comments: number;
  reactions: Partial<Record<Reaction, number>>;
  subIssues: { total: number; completed: number } | null;
  /** GitHub numbers issues and pull requests together, and lists both as issues. */
  isPullRequest: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface IssueFilter {
  state?: "open" | "closed" | "all";
  labels?: string[];
  milestone?: number | "none" | "any";
  assignee?: string | "none" | "any";
  creator?: string;
  mentioned?: string;
  since?: string;
  sort?: "created" | "updated" | "comments";
  direction?: "asc" | "desc";
  /** Pull requests are dropped from the list unless this is set. */
  includePulls?: boolean;
}

export interface NewIssue {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  stateReason?: StateReason;
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

export interface IssueComment {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
  updatedAt: string;
  reactions: Partial<Record<Reaction, number>>;
}

export interface Label {
  name: string;
  /** 6 hex digits, no "#". */
  color: string;
  description: string;
}

export interface Milestone {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  dueOn: string | null;
  openIssues: number;
  closedIssues: number;
}

export interface NewMilestone {
  title: string;
  description?: string;
  dueOn?: string | null;
  state?: "open" | "closed";
}

export interface TimelineEvent {
  kind: "commented" | "cross-referenced" | "referenced" | "closed" | "reopened" | "labeled"
    | "unlabeled" | "assigned" | "unassigned" | "milestoned" | "demilestoned" | "renamed" | "locked"
    | "unlocked" | "transferred" | "merged" | "reviewed" | "other";
  actor: Actor | null;
  createdAt: string;
  /** What the event names: an issue ("owner/name#12"), a commit, a label, a new title. */
  subject: string | null;
}

// ─── releases (phase 07) ──────────────────────────────────────────────────

export interface ReleaseAsset {
  id: string;
  name: string;
  label: string;
  contentType: string;
  size: number;
  downloads: number;
  /** A link. OSCR never downloads assets itself. */
  downloadUrl: string;
  createdAt: string;
}

export interface Release {
  id: string;
  tagName: string;
  /** A branch or a commit. */
  target: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  author: Actor;
  createdAt: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
  webUrl: string;
}

export interface NewRelease {
  tagName: string;
  /** Default: the default branch; the tag is created when missing. */
  target?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  makeLatest?: boolean;
  generateNotes?: boolean;
}

export interface ReleasePatch {
  tagName?: string;
  target?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  makeLatest?: boolean;
}

export interface AssetUpload {
  name: string;
  label?: string;
  contentType: string;
  /** Bytes, known in advance (the upload's Content-Length). */
  size: number;
  body: ReadableStream<Uint8Array> | Uint8Array;
}

// ─── checks (phases 04 and 10) ────────────────────────────────────────────

export type CheckStatus = "queued" | "in_progress" | "completed";
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required";

export interface CheckRun {
  id: string;
  name: string;
  headSha: ObjectId;
  status: CheckStatus;
  conclusion: CheckConclusion | null;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  /** The App's slug. */
  app: string | null;
  output: { title: string; summary: string; annotations: number };
}

export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  title?: string;
  message: string;
}

export interface NewCheckRun {
  /** Shown on the forge: built by the caller from SITE_NAME, never hard-coded. */
  name: string;
  headSha: ObjectId;
  status?: CheckStatus;
  conclusion?: CheckConclusion;
  /** The OSCR page that explains the result. */
  detailsUrl?: string;
  externalId?: string;
  output?: { title: string; summary: string; text?: string; annotations?: CheckAnnotation[] };
}

export type CheckRunPatch = Partial<Omit<NewCheckRun, "headSha">>;

export type StatusState = "success" | "failure" | "pending" | "error";

export interface CombinedStatus {
  state: StatusState;
  statuses: { context: string; state: StatusState; description: string; targetUrl: string | null }[];
}

// ─── installations, webhooks ──────────────────────────────────────────────

export interface Installation {
  id: string;
  account: { id: string; login: string; type: "user" | "organization" };
  selection: "all" | "selected";
  suspended: boolean;
}

export interface RepoStub {
  key: RepoKey;
  ref: RepoRef;
  visibility: "public" | "private" | "internal";
  defaultBranch: string | null;
}

/** A webhook delivery, forge-neutral. Every variant has the delivery id (for logs); the ones
 *  about a repository carry the installation that sent them (null: none). */
export type ForgeEvent =
  | { kind: "ping"; delivery: string }
  | { kind: "installation"; delivery: string; action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted"; installation: Installation; sender: Actor }
  | { kind: "installation_repositories"; delivery: string; action: "added" | "removed"; installation: Installation; added: RepoStub[]; removed: RepoStub[]; sender: Actor }
  | { kind: "push"; delivery: string; installation: string | null; repo: RepoStub; ref: string; before: ObjectId; after: ObjectId; created: boolean; deleted: boolean; forced: boolean; pushedAt: number; commits: { sha: ObjectId; added: string[]; removed: string[]; modified: string[] }[]; pusher: Actor }
  | { kind: "repository"; delivery: string; installation: string | null; action: "created" | "deleted" | "archived" | "unarchived" | "renamed" | "transferred" | "publicized" | "privatized" | "edited"; repo: RepoStub; previous: { owner: string | null; name: string | null } | null; sender: Actor }
  | { kind: "ref"; delivery: string; installation: string | null; action: "created" | "deleted"; refType: "branch" | "tag"; ref: string; repo: RepoStub; sender: Actor }
  | { kind: "pull_request"; delivery: string; installation: string | null; action: string; number: number; repo: RepoStub; head: { ref: string; sha: ObjectId }; base: { ref: string }; merged: boolean; sender: Actor }
  | { kind: "release"; delivery: string; installation: string | null; action: string; repo: RepoStub; releaseId: string; tagName: string; sender: Actor }
  | { kind: "other"; delivery: string; event: string };

export type ForgeEventKind = ForgeEvent["kind"];

// ─── the App's authorization ──────────────────────────────────────────────

export interface UserToken {
  token: string;
  /** Unix seconds (GitHub: 8 hours); null when the forge issues tokens that do not expire. */
  expiresAt: number | null;
}

// ─── costs ────────────────────────────────────────────────────────────────

export interface Cost {
  /** Every API request to the forge: REST, GraphQL, uploads, token minting. Reads of the raw
   *  file CDN by an anonymous session are not counted: they are the reader's own, as on GitHub. */
  requests: number;
  /** Content-creating ones: GitHub's secondary limit is 80 a minute and 500 an hour per user. */
  writes: number;
  graphql: number;
  /** Installation tokens minted (one JWT signature each). */
  mints: number;
}
