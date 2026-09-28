// GitBackend: the forge adapter. Every read and every write OSCR makes on a Git forge, in the
// forge-neutral types of types.ts.
//
// Why (docs/DECISIONS.md D00-1, D00-2): no option lets OSCR host Git repositories itself with
// certain compliance and zero cost, so OSCR hosts none. Repositories live in each researcher's
// own GitHub account; OSCR's GitHub App creates them and acts on them with that person's consent,
// one authorization per action, as that person, with the token used once and never stored. The
// mirror mode uses the same App on an existing repository (installed: webhooks and write-back
// with consent; or, for a public repository without the App, read-only).
//
// Backends:
// - `githubBackend` (github/index.ts): GitHub's REST and GraphQL APIs, network through an
//   injected `fetch`. The first backend.
// - `MemoryBackend` (tests/forge/memory.ts): the in-memory test double, with GitHub's semantics
//   where the contract depends on them.
// - The contract suite (tests/forge/contract.ts) is what any backend must pass. Forgejo, GitLab
//   or a Cloudflare Git server can be added later, if the owner ever unlocks one (D00-13).
// - The Mac's read-only counterpart is oscr/forge.py (same error codes).
//
// What it is not:
// - OSCR's layer (D1 `oscr_forge`, roles, per-account caps, jobs): the forge service of phase 01
//   (`forge/service/`, routes /api/forge/*), built on top of this.
// - git's wire protocol: no clone, fetch or push ever passes through OSCR (D00-3).
// - The archive (Software Heritage, D00-15) or Zenodo (oscr/zenodo.py).
//
// Where it runs:
// - The browser: anonymous sessions reading public repositories on the reader's own quota
//   (api.github.com and raw.githubusercontent.com answer CORS). It holds no token.
// - The Worker: user sessions for one authorized action (the token from the exchange, used for
//   one request, then revoked); installation sessions for the App's own acts (check runs,
//   reading after a webhook), with installation tokens kept in memory only.
//
// Using it:
//   const backend = githubBackend(githubConfigFromEnv(env), { fetch: globalThis.fetch.bind(globalThis) });
//   const s = backend.session({ kind: "anonymous" });
//   const repo = await s.repos.get({ forge: "github", owner: "ada", name: "compendium" });
//   const file = await s.git.readFile(repo.ref, repo.defaultBranch!, "README.md");
//   render(maskEmails(text(file.bytes)));          // every renderer masks email addresses
//
// Every rejection is a `GitBackendError` (errors.ts). Names, refs and paths are checked before any
// request (paths.ts); who may do what is rules.ts; what each forge allows is limits.ts.

import type { Capability, BackendLimits } from "./limits.ts";
import type * as T from "./types.ts";

export interface GitBackend {
  readonly forge: T.ForgeName;
  readonly limits: BackendLimits;
  readonly links: ForgeLinks;
  readonly webhooks: WebhookCodec;
  /** null where the forge has no per-user authorization OSCR can drive (never for GitHub). */
  readonly auth: ForgeAuth | null;
  capabilities(kind: T.CredentialKind): ReadonlySet<Capability>;
  /** A session is cheap: no request is made until a method is called. */
  session(credential: T.Credential): GitSession;
}

export interface GitSession {
  readonly credential: T.CredentialKind;
  readonly repos: RepoOps;
  readonly git: GitOps;
  readonly pulls: PullOps;
  readonly issues: IssueOps;
  readonly releases: ReleaseOps;
  readonly checks: CheckOps;
  /** What this session has spent so far on the forge. */
  cost(): T.Cost;
}

/** Repositories (phase 01). */
export interface RepoOps {
  get(repo: T.RepoRef): Promise<T.RepoInfo>;
  /** Follows renames and transfers (OSCR keys repositories by id). */
  getById(key: T.RepoKey): Promise<T.RepoInfo>;
  /** In the session user's own account. Capability "createRepository". */
  create(input: T.CreateRepositoryInput): Promise<T.RepoInfo>;
  /** One new commit holding the template's files (GitHub does not copy the template's history). */
  generate(template: T.RepoRef, input: T.GenerateInput): Promise<T.RepoInfo>;
  /** The forge copies in the background: `ready` false means "not yet cloneable". */
  fork(repo: T.RepoRef, input?: T.ForkInput): Promise<{ repo: T.RepoInfo; ready: boolean }>;
  update(repo: T.RepoRef, patch: T.RepoPatch): Promise<T.RepoInfo>;
  setTopics(repo: T.RepoRef, topics: string[]): Promise<string[]>;
  /** "pending": the new owner must accept (GitHub: within one day). Capability "transfer". */
  transfer(repo: T.RepoRef, input: T.TransferInput): Promise<{ status: "pending" | "done"; repo: T.RepoInfo }>;
  /** Immediate on the forge. OSCR's grace period lives in its own layer (D00-10); this is called
   *  only by the researcher's own authorization when that period ends. */
  delete(repo: T.RepoRef): Promise<void>;
  /** A person's permission on the repository (reviewer suggestions, buttons shown). */
  permission(repo: T.RepoRef, login: string): Promise<T.Permission>;
  languages(repo: T.RepoRef): Promise<Record<string, number>>;
  license(repo: T.RepoRef): Promise<{ spdx: string | null; path: string } | null>;
  readme(repo: T.RepoRef, rev?: T.Rev, dir?: string): Promise<T.FileContent | null>;
  /** Capability "serverImport". GitHub: `unsupported`, with fallbackUrl = links.importer(). */
  importRepository(input: T.ImportInput): Promise<T.RepoInfo>;
}

/** Refs, trees, files and commits (phases 01–03, 06). */
export interface GitOps {
  listBranches(repo: T.RepoRef, page?: T.PageRequest): Promise<T.Page<T.Branch>>;
  getBranch(repo: T.RepoRef, name: string): Promise<T.Branch>;
  createBranch(repo: T.RepoRef, name: string, from: T.ObjectId): Promise<T.Branch>;
  /** The forge moves the default branch and retargets open pull requests with it. */
  renameBranch(repo: T.RepoRef, from: string, to: string): Promise<T.Branch>;
  /** Deleting the default branch is `invalid`. */
  deleteBranch(repo: T.RepoRef, name: string): Promise<void>;
  listTags(repo: T.RepoRef, page?: T.PageRequest): Promise<T.Page<T.Tag>>;
  createTag(repo: T.RepoRef, input: T.TagInput): Promise<T.Tag>;
  deleteTag(repo: T.RepoRef, name: string): Promise<void>;

  /** A revision's commit id. */
  resolve(repo: T.RepoRef, rev: T.Rev): Promise<T.ObjectId>;
  /** The root tree, or `path`'s; recursive lists every entry below it (may be truncated). */
  tree(repo: T.RepoRef, rev: T.Rev, options?: { path?: string; recursive?: boolean }): Promise<T.Tree>;
  /** A file's bytes. Larger than maxBytes (default 10 MB): `too_large`. An LFS pointer is
   *  returned as is, with `lfs` set. Anonymous GitHub sessions read the raw CDN (no REST call). */
  readFile(repo: T.RepoRef, rev: T.Rev, path: string, options?: { maxBytes?: number }): Promise<T.FileContent>;
  /** A browser-readable address of the file at a commit, or null (no request is made).
   *  Capability "rawUrls". */
  rawUrl(repo: T.RepoRef, commit: T.ObjectId, path: string): string | null;

  commits(repo: T.RepoRef, filter?: T.CommitFilter, page?: T.PageRequest): Promise<T.Page<T.CommitSummary>>;
  /** The commit and one page of its changed files. */
  commit(repo: T.RepoRef, sha: T.ObjectId, filesPage?: T.PageRequest): Promise<T.CommitDetail>;
  compare(repo: T.RepoRef, base: T.Rev, head: T.Rev, filesPage?: T.PageRequest): Promise<T.Comparison>;
  /** The unified diff as text; over maxBytes (default 1 MB): `too_large`. */
  diff(repo: T.RepoRef, base: T.Rev, head: T.Rev, options?: { maxBytes?: number }): Promise<string>;
  /** Capability "blame" (GitHub: GraphQL, not anonymous). */
  blame(repo: T.RepoRef, rev: T.Rev, path: string): Promise<T.BlameRange[]>;
  /** Capability "searchCode" (GitHub: authenticated only, 10 requests a minute). */
  search(repo: T.RepoRef, query: string, page?: T.PageRequest): Promise<T.Page<T.CodeHit>>;

  /** One commit, made by the forge. Fails with `conflict` when the branch moved. */
  createCommit(repo: T.RepoRef, input: T.CommitInput): Promise<T.CommitResult>;
  /** Merge a branch or commit into a branch: a merge commit, "up_to_date", or `conflict`. */
  merge(repo: T.RepoRef, input: T.MergeInput): Promise<T.MergeResult>;
}

/** Pull requests and reviews (phase 04).
 *  - CODEOWNERS is read with git.readFile and parsed in the service layer: no backend method.
 *  - "fixes #12": the forge closes the issue when the pull request merges into the default branch.
 *  - A merge conflict resolved in the browser: the three versions are read with readFile, the
 *    hunks computed with diff.ts on the reader's CPU, and the Worker calls createCommit with
 *    `parents: [headOfPrBranch, baseHead]` on the pull request's branch. */
export interface PullOps {
  list(repo: T.RepoRef, filter?: T.PullFilter, page?: T.PageRequest): Promise<T.Page<T.PullRequest>>;
  get(repo: T.RepoRef, number: number): Promise<T.PullRequest>;
  files(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.FileChangeSummary>>;
  commits(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.CommitSummary>>;
  create(repo: T.RepoRef, input: T.NewPullRequest): Promise<T.PullRequest>;
  /** Title, body, base; close and reopen. */
  update(repo: T.RepoRef, number: number, patch: T.PullPatch): Promise<T.PullRequest>;
  /** Capability "draftToggle". */
  setDraft(repo: T.RepoRef, number: number, draft: boolean): Promise<T.PullRequest>;
  requestReviewers(repo: T.RepoRef, number: number, logins: string[]): Promise<T.PullRequest>;
  removeReviewers(repo: T.RepoRef, number: number, logins: string[]): Promise<T.PullRequest>;
  reviews(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.Review>>;
  /** Approve, request changes or comment, with line comments and suggestions. */
  review(repo: T.RepoRef, number: number, input: T.NewReview): Promise<T.Review>;
  comments(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.ReviewComment>>;
  reply(repo: T.RepoRef, number: number, commentId: string, body: string): Promise<T.ReviewComment>;
  /** Capability "reviewThreads" (resolved state: GitHub GraphQL only). */
  threads(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.ReviewThread>>;
  resolveThread(repo: T.RepoRef, threadId: string, resolved: boolean): Promise<T.ReviewThread>;
  /** Fails with `conflict` when the head moved since `expectedHead`, `not_mergeable` when the
   *  forge refuses (conflicts, blocked, draft). */
  merge(repo: T.RepoRef, number: number, input: T.PullMergeInput): Promise<{ sha: T.ObjectId }>;
  /** Merge the base into the head branch. */
  updateBranch(repo: T.RepoRef, number: number, expectedHead?: T.ObjectId): Promise<void>;
  /** Capability "autoMerge"; null switches it off. */
  autoMerge(repo: T.RepoRef, number: number, method: T.MergeMethod | null): Promise<T.PullRequest>;
  /** A new pull request that reverts a merged one. Capability "revertPullRequest". */
  revert(repo: T.RepoRef, number: number, input?: { title?: string; body?: string; draft?: boolean }): Promise<T.PullRequest>;
}

export type IssueTarget = { issue: number } | { comment: string };

/** Issues (phase 05). OSCR's scientific issue types ("code error", "code–paper mismatch",
 *  "reproduction failure") are OSCR-native and live in D1 (D00-6); saved replies have no API. */
export interface IssueOps {
  list(repo: T.RepoRef, filter?: T.IssueFilter, page?: T.PageRequest): Promise<T.Page<T.Issue>>;
  get(repo: T.RepoRef, number: number): Promise<T.Issue>;
  create(repo: T.RepoRef, input: T.NewIssue): Promise<T.Issue>;
  /** Also closes (with a reason) and reopens. */
  update(repo: T.RepoRef, number: number, patch: T.IssuePatch): Promise<T.Issue>;
  lock(repo: T.RepoRef, number: number, reason?: T.LockReason): Promise<void>;
  unlock(repo: T.RepoRef, number: number): Promise<void>;
  comments(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.IssueComment>>;
  comment(repo: T.RepoRef, number: number, body: string): Promise<T.IssueComment>;
  editComment(repo: T.RepoRef, commentId: string, body: string): Promise<T.IssueComment>;
  deleteComment(repo: T.RepoRef, commentId: string): Promise<void>;
  react(repo: T.RepoRef, target: IssueTarget, reaction: T.Reaction): Promise<void>;
  unreact(repo: T.RepoRef, target: IssueTarget, reaction: T.Reaction): Promise<void>;
  labels(repo: T.RepoRef, page?: T.PageRequest): Promise<T.Page<T.Label>>;
  createLabel(repo: T.RepoRef, label: T.Label): Promise<T.Label>;
  updateLabel(repo: T.RepoRef, name: string, patch: Partial<T.Label>): Promise<T.Label>;
  deleteLabel(repo: T.RepoRef, name: string): Promise<void>;
  milestones(repo: T.RepoRef, state?: "open" | "closed" | "all", page?: T.PageRequest): Promise<T.Page<T.Milestone>>;
  createMilestone(repo: T.RepoRef, input: T.NewMilestone): Promise<T.Milestone>;
  updateMilestone(repo: T.RepoRef, number: number, patch: Partial<T.NewMilestone>): Promise<T.Milestone>;
  deleteMilestone(repo: T.RepoRef, number: number): Promise<void>;
  /** Capability "subIssues" (same repository). */
  subIssues(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.Issue>>;
  addSubIssue(repo: T.RepoRef, parent: number, child: number): Promise<void>;
  removeSubIssue(repo: T.RepoRef, parent: number, child: number): Promise<void>;
  /** Capability "issueDependencies". */
  blockedBy(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.Issue>>;
  addBlockedBy(repo: T.RepoRef, number: number, blocker: number): Promise<void>;
  removeBlockedBy(repo: T.RepoRef, number: number, blocker: number): Promise<void>;
  /** Capability "transferIssue": the issue gets a new number in `to`. */
  transfer(repo: T.RepoRef, number: number, to: T.RepoRef): Promise<T.Issue>;
  /** Capability "pinIssue" (GitHub: at most 3 pinned per repository). */
  pin(repo: T.RepoRef, number: number, pinned: boolean): Promise<void>;
  timeline(repo: T.RepoRef, number: number, page?: T.PageRequest): Promise<T.Page<T.TimelineEvent>>;
  /** The forge's issue search, scoped to this repository (GitHub: "repo:owner/name " is
   *  prefixed; anonymous: 10 requests a minute). */
  search(repo: T.RepoRef, query: string, page?: T.PageRequest): Promise<T.Page<T.Issue>>;
}

/** Releases (phase 07). Semantic versions and the changelog are pure functions of the service
 *  layer. A Zenodo DOI is never OSCR's for code: the map's DOI stays author-triggered
 *  (oscr/zenodo.py). */
export interface ReleaseOps {
  list(repo: T.RepoRef, page?: T.PageRequest): Promise<T.Page<T.Release>>;
  get(repo: T.RepoRef, id: string): Promise<T.Release>;
  byTag(repo: T.RepoRef, tag: string): Promise<T.Release>;
  /** null when the repository has no published release. */
  latest(repo: T.RepoRef): Promise<T.Release | null>;
  create(repo: T.RepoRef, input: T.NewRelease): Promise<T.Release>;
  update(repo: T.RepoRef, id: string, patch: T.ReleasePatch): Promise<T.Release>;
  /** The tag stays. */
  delete(repo: T.RepoRef, id: string): Promise<void>;
  generateNotes(repo: T.RepoRef, input: { tagName: string; target?: string; previousTagName?: string }): Promise<{ name: string; body: string }>;
  assets(repo: T.RepoRef, releaseId: string, page?: T.PageRequest): Promise<T.Page<T.ReleaseAsset>>;
  /** Capability "releaseAssets"; size ≤ limits.releaseAssetBytes. The forge service caps what
   *  passes through the Worker far lower. */
  uploadAsset(repo: T.RepoRef, releaseId: string, upload: T.AssetUpload): Promise<T.ReleaseAsset>;
  deleteAsset(repo: T.RepoRef, assetId: string): Promise<void>;
}

/** Checks (phases 04, 10). The researcher's CI results (their own GitHub Actions) are read here;
 *  OSCR's own check that needs the forge ("tracing-map links touched") is posted as a check run
 *  by an installation session. OSCR's checks run no code. */
export interface CheckOps {
  runs(repo: T.RepoRef, rev: T.Rev, page?: T.PageRequest): Promise<T.Page<T.CheckRun>>;
  /** The App's own act: installation sessions only. */
  create(repo: T.RepoRef, input: T.NewCheckRun): Promise<T.CheckRun>;
  update(repo: T.RepoRef, id: string, patch: T.CheckRunPatch): Promise<T.CheckRun>;
  status(repo: T.RepoRef, rev: T.Rev): Promise<T.CombinedStatus>;
}

/** The forge's own pages (no request, ever): what OSCR links to, and the fallbacks of
 *  `unsupported` and anonymous `rate_limited`. */
export interface ForgeLinks {
  repo(repo: T.RepoRef): string;
  tree(repo: T.RepoRef, rev: T.Rev, path?: string): string;
  /** A permalink when `rev` is a commit id: what tracing maps and OSCR's pages link to. */
  blob(repo: T.RepoRef, rev: T.Rev, path: string, lines?: { start: number; end?: number }): string;
  blame(repo: T.RepoRef, rev: T.Rev, path: string): string;
  commit(repo: T.RepoRef, sha: T.ObjectId): string;
  compare(repo: T.RepoRef, base: T.Rev, head: T.Rev): string;
  search(repo: T.RepoRef, query: string): string;
  upload(repo: T.RepoRef, branch: string, dir?: string): string;
  newRelease(repo: T.RepoRef, tag?: string): string;
  importer(): string;
  install(state?: string): string;
  clone(repo: T.RepoRef): string;
  archive(repo: T.RepoRef, rev: T.Rev, format: "zip" | "tar.gz"): string;
  /** The parts of a forge URL (a repository, tree, blob or commit page), or null. */
  parse(url: string): { repo: T.RepoRef; rev: T.Rev | null; path: string | null; lines: { start: number; end: number } | null } | null;
}

/** Webhook deliveries: checked over the raw body, then read as neutral events. */
export interface WebhookCodec {
  /** Deliveries larger than this are refused before any hashing (CPU). */
  readonly maxBytes: number;
  /** Constant-time check of the delivery's signature over the raw body. */
  verify(headers: Headers, body: Uint8Array, secret: string): Promise<boolean>;
  /** The delivery as a neutral event; `invalid` when malformed. Email addresses in the payload
   *  (pusher, commit authors) are never copied. */
  parse(headers: Headers, body: Uint8Array): T.ForgeEvent;
}

/** A person's authorization of one action (the App's user-to-server flow, PKCE S256). */
export interface ForgeAuth {
  /** Where the browser goes to authorize one action. */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** The code for a user token, server to server: the client secret never leaves the Worker. */
  exchange(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<T.UserToken>;
  whoAmI(token: string): Promise<{ id: string; login: string }>;
  /** Revoke one token after its action (best effort, in waitUntil). */
  revoke(token: string): Promise<void>;
  installUrl(state: string): string;
  /** The installations the token's user can see, and their repositories with the user's own
   *  permission on each (the linking page of the mirror mode). */
  installations(token: string, page?: T.PageRequest): Promise<T.Page<T.Installation>>;
  installationRepositories(token: string, installationId: string, page?: T.PageRequest): Promise<T.Page<T.RepoStub & { permission: T.Permission }>>;
}
