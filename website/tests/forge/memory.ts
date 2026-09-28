// MemoryBackend: GitBackend in memory, the test double of every forge (worker/forge/gitbackend.ts).
// It implements every method, with GitHub's semantics where the contract depends on them, and it
// is deterministic: time is injected (Unix seconds), ids are sequential, nothing is random.
//
// State:
// - accounts (users and organizations), user tokens, installations (an account, a selection,
//   the App's permissions);
// - repositories: owner, name, visibility, archived, features, topics, template flag, parent
//   (forks), template source, collaborators, refs, and a redirect map from old paths to ids
//   (renames and transfers: reads of an old path follow it, as GitHub does);
// - git objects with real ids (gitobjects.ts), shared by forks as GitHub's fork networks are;
// - issues and pull requests (one numbering per repository), comments, reactions, labels,
//   milestones, locks, pins (3 at most), sub-issues, dependencies, timelines; releases and their
//   assets; check runs and commit statuses;
// - the ForgeEvents GitHub would have delivered.
//
// Where it differs from GitHub (the contract accepts both):
// - merges are three-way at path level (GitHub also merges edits to different lines of a file);
// - no rename detection in diffs (a move is a removal and an addition);
// - a commit that leaves the tree unchanged is refused unless `allowEmpty`;
// - auto-merge is recorded, never carried out.
//
// Hooks for tests (and, through the contract's harness, for any backend's fake):
//   addUser(login) → { user, token() }       addOrg(login, admins, members)
//   install(accountLogin, repos?)             grant(repo, login, permission)
//   markTemplate(repo)                        acceptTransfer(repoId)
//   authorize(url, login) → { code, state }   (the person approving on the forge's page)
//   events()                                  (returns and clears what was recorded)
//   deliver(event, secret) → { headers, body } (a signed delivery for MemoryWebhookCodec)
//   limit(kind, remaining, resetAt)           failNext(method, code)
//   setStatus(repo, sha, context, state)      advance(seconds)
//
// Costs follow GitHub's: one request per call (a mutation also one write; the methods that are
// GraphQL on GitHub, one `graphql`); an anonymous readFile (the raw CDN) and rawUrl cost nothing;
// an installation's first call in an hour mints a token.

import { GitBackendError, type GitErrorCode } from "../../worker/forge/errors.ts";
import type { ForgeAuth, ForgeLinks, GitBackend, GitSession, WebhookCodec } from "../../worker/forge/gitbackend.ts";
import { forgeLinks } from "../../worker/forge/github/links.ts";
import { checkBody as checkSignature, signBody } from "../../worker/forge/hmac.ts";
import { type BackendLimits, type Capability, GITHUB_CAPABILITIES, GITHUB_LIMITS } from "../../worker/forge/limits.ts";
import { base64, text, utf8 } from "../../worker/forge/objects.ts";
import { checkPage, LOGIN } from "../../worker/forge/paths.ts";
import { type Act, guard } from "../../worker/forge/rules.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Flat, ObjectStore, ZERO } from "./gitobjects.ts";
import { issueOps, pullOps } from "./memory-issues.ts";
import { repoOps } from "./memory-repos.ts";
import { checkOps, gitOps, releaseOps } from "./memory-git.ts";

// ─── state ────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  login: string;
  type: "user" | "organization";
  /** Organizations: user ids of their admins and members. */
  admins: Set<string>;
  members: Set<string>;
}

export interface MemInstallation {
  id: string;
  accountId: string;
  selection: "all" | "selected";
  repos: Set<string>;
  suspended: boolean;
  /** The App's permissions on the account's repositories. */
  permissions: Record<string, "read" | "write">;
}

export interface MemComment {
  id: string;
  authorId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  reactions: Map<string, Set<T.Reaction>>;
}

export interface MemReview {
  id: string;
  authorId: string;
  state: T.Review["state"];
  body: string;
  commit: T.ObjectId;
  at: number;
}

export interface MemReviewComment {
  id: string;
  reviewId: string | null;
  inReplyTo: string | null;
  authorId: string;
  path: string;
  line: number;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  commit: T.ObjectId;
  body: string;
  createdAt: number;
  updatedAt: number;
  threadId: string;
}

export interface MemThread {
  id: string;
  number: number;
  resolved: boolean;
  comments: string[];
}

export interface MemPull {
  headRepoId: string;
  headRef: string;
  /** The head as last seen (kept when its branch is deleted). */
  headSha: T.ObjectId;
  baseRef: string;
  draft: boolean;
  merged: boolean;
  mergedAt: number | null;
  mergeCommit: T.ObjectId | null;
  /** The base and head at merge time, for files() and commits() afterwards. */
  mergedBase: T.ObjectId | null;
  mergedHead: T.ObjectId | null;
  maintainerCanModify: boolean;
  requestedReviewers: string[];
  autoMerge: T.MergeMethod | null;
  reviews: MemReview[];
  reviewComments: string[];
}

export interface MemIssue {
  number: number;
  id: string;
  nodeId: string;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: T.StateReason | null;
  authorId: string;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  locked: boolean;
  lockReason: T.LockReason | null;
  pinned: boolean;
  comments: MemComment[];
  reactions: Map<string, Set<T.Reaction>>;
  subIssues: number[];
  parent: number | null;
  blockedBy: number[];
  timeline: { kind: T.TimelineEvent["kind"]; actorId: string | null; at: number; subject: string | null }[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  pull: MemPull | null;
  /** Transferred away: the issue lives on elsewhere. */
  gone: boolean;
}

export interface MemMilestone {
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  dueOn: string | null;
}

export interface MemAsset {
  id: string;
  name: string;
  label: string;
  contentType: string;
  size: number;
  bytes: Uint8Array;
  createdAt: number;
}

export interface MemRelease {
  id: string;
  tagName: string;
  target: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  latest: boolean | null;
  authorId: string;
  createdAt: number;
  publishedAt: number | null;
  assets: MemAsset[];
}

export interface MemCheckRun {
  id: string;
  name: string;
  headSha: T.ObjectId;
  status: T.CheckStatus;
  conclusion: T.CheckConclusion | null;
  startedAt: number | null;
  completedAt: number | null;
  detailsUrl: string | null;
  externalId: string | null;
  output: { title: string; summary: string; text: string };
  annotations: T.CheckAnnotation[];
}

export interface MemRepo {
  id: string;
  nodeId: string;
  ownerId: string;
  name: string;
  visibility: "public" | "private";
  archived: boolean;
  disabled: boolean;
  deleted: boolean;
  isTemplate: boolean;
  parentId: string | null;
  templateId: string | null;
  defaultBranch: string | null;
  description: string;
  homepage: string;
  topics: string[];
  features: T.RepoFeatures;
  createdAt: number;
  pushedAt: number | null;
  collaborators: Map<string, T.Permission>;
  branches: Map<string, T.ObjectId>;
  protectedBranches: Set<string>;
  /** A tag's name → the commit, or the annotated tag object. */
  tags: Map<string, T.ObjectId>;
  counter: number;
  issues: Map<number, MemIssue>;
  labels: Map<string, T.Label>;
  milestones: Map<number, MemMilestone>;
  milestoneCounter: number;
  releases: Map<string, MemRelease>;
  pendingTransfer: { ownerId: string; name: string } | null;
  autolinks: Map<string, T.Autolink>;
  checkRuns: Map<string, MemCheckRun>;
  statuses: Map<T.ObjectId, { context: string; state: T.StatusState; description: string; targetUrl: string | null }[]>;
  threads: Map<string, MemThread>;
}

export type Who = { kind: "anonymous" } | { kind: "user"; token: string } | { kind: "installation"; installationId: string };

export interface MemoryOptions {
  /** Unix seconds; default a fixed 2026-09-28 12:00 UTC that `advance` moves. */
  now?: () => number;
  limits?: Partial<BackendLimits>;
  web?: string;
  appSlug?: string;
}

const LEVELS: T.Permission[] = ["none", "read", "triage", "write", "maintain", "admin"];
export const atLeast = (have: T.Permission, need: T.Permission): boolean => LEVELS.indexOf(have) >= LEVELS.indexOf(need);

export const iso = (t: number): string => new Date(t * 1000).toISOString().replace(".000Z", "Z");

/** Page numbers as cursors, as on GitHub's REST API. */
export function pageOf<V>(items: V[], page?: T.PageRequest): T.Page<V> {
  const { cursor, perPage } = checkPage(page);
  if (cursor !== null && !/^\d{1,5}$/.test(cursor)) throw new GitBackendError("invalid", "not a page cursor");
  const n = cursor === null ? 1 : Number(cursor);
  if (n < 1) throw new GitBackendError("invalid", "not a page cursor");
  const from = (n - 1) * perPage;
  return { items: items.slice(from, from + perPage), next: from + perPage < items.length ? String(n + 1) : null };
}

// ─── the webhook codec of the double ──────────────────────────────────────

export class MemoryWebhookCodec implements WebhookCodec {
  readonly maxBytes = 2 ** 20;

  async verify(headers: Headers, body: Uint8Array, secret: string): Promise<boolean> {
    if (!(body instanceof Uint8Array) || body.length > this.maxBytes) return false;
    return checkSignature(secret, body, headers.get("X-Memory-Signature"));
  }

  parse(headers: Headers, body: Uint8Array): T.ForgeEvent {
    if (!(body instanceof Uint8Array)) throw new GitBackendError("invalid", "no delivery");
    if (body.length > this.maxBytes) throw new GitBackendError("too_large", "the delivery is larger than OSCR reads");
    let event: unknown;
    try {
      event = JSON.parse(text(body));
    } catch {
      throw new GitBackendError("invalid", "the delivery is not JSON");
    }
    const e = event as { kind?: unknown; delivery?: unknown };
    const kinds = ["ping", "installation", "installation_repositories", "push", "repository", "ref", "pull_request", "release", "other"];
    if (!e || typeof e.kind !== "string" || !kinds.includes(e.kind) || typeof e.delivery !== "string") throw new GitBackendError("invalid", "a malformed delivery");
    if (headers.get("X-Memory-Event") !== e.kind || headers.get("X-Memory-Delivery") !== e.delivery) throw new GitBackendError("invalid", "the headers do not match the delivery");
    return event as T.ForgeEvent;
  }
}

// ─── the backend ──────────────────────────────────────────────────────────

export class MemoryBackend implements GitBackend {
  readonly forge = "memory" as const;
  readonly limits: BackendLimits;
  readonly links: ForgeLinks;
  readonly webhooks = new MemoryWebhookCodec();
  readonly auth: ForgeAuth;
  readonly web: string;
  readonly raw: string;
  readonly appSlug: string;
  readonly store = new ObjectStore();
  readonly accounts = new Map<string, Account>();
  readonly tokens = new Map<string, string>();
  readonly installations = new Map<string, MemInstallation>();
  readonly repos = new Map<string, MemRepo>();
  /** "owner/name" in lower case → repository id: current paths, then old ones. */
  readonly paths = new Map<string, string>();
  readonly redirects = new Map<string, string>();
  readonly issueComments = new Map<string, { repoId: string; number: number }>();
  readonly reviewComments = new Map<string, MemReviewComment & { repoId: string; number: number }>();
  readonly assetsById = new Map<string, { repoId: string; releaseId: string }>();
  readonly codes = new Map<string, { userId: string; state: string; challenge: string; redirectUri: string; used: boolean }>();
  readonly minted = new Map<string, number>();
  private recorded: T.ForgeEvent[] = [];
  private seq = 1000;
  private tokenSeq = 0;
  private deliveries = 0;
  private clock = 1_790_596_800;
  private readonly nowFn: (() => number) | null;
  private readonly rate = new Map<T.CredentialKind, { remaining: number; resetAt: number }>();
  private readonly failures = new Map<string, GitErrorCode>();

  constructor(options: MemoryOptions = {}) {
    this.limits = { ...GITHUB_LIMITS, ...options.limits };
    this.web = (options.web ?? "https://memory.forge.test").replace(/\/+$/, "");
    this.raw = this.web.replace("://", "://raw.");
    this.appSlug = options.appSlug ?? "memory-app";
    this.nowFn = options.now ?? null;
    this.links = forgeLinks({ forge: "memory", web: this.web, appSlug: this.appSlug });
    this.auth = memoryAuth(this);
  }

  now(): number {
    return this.nowFn ? this.nowFn() : this.clock;
  }

  advance(seconds: number): void {
    this.clock += seconds;
  }

  nextId(): string {
    return String(++this.seq);
  }

  capabilities(kind: T.CredentialKind): ReadonlySet<Capability> {
    return GITHUB_CAPABILITIES[kind];
  }

  session(credential: T.Credential): GitSession {
    const kind = credential?.kind;
    let who: Who;
    if (kind === "anonymous") who = { kind };
    else if (kind === "user" && typeof credential.token === "string") who = { kind, token: credential.token };
    else if (kind === "installation" && typeof credential.installationId === "string") who = { kind, installationId: credential.installationId };
    else throw new GitBackendError("invalid", "not a credential");
    const call = new Call(this, who);
    return {
      credential: who.kind,
      repos: repoOps(call),
      git: gitOps(call),
      pulls: pullOps(call),
      issues: issueOps(call),
      releases: releaseOps(call),
      checks: checkOps(call),
      cost: () => ({ ...call.spent }),
    };
  }

  // ─── hooks ──────────────────────────────────────────────────────────────

  addUser(login: string): { user: Account; token: () => string } {
    if (!LOGIN.test(login) || this.accountByLogin(login)) throw new Error(`bad or taken login ${login}`);
    const user: Account = { id: this.nextId(), login, type: "user", admins: new Set(), members: new Set() };
    this.accounts.set(user.id, user);
    return { user, token: () => this.issueToken(user.id) };
  }

  addOrg(login: string, admins: string[] = [], members: string[] = []): Account {
    if (!LOGIN.test(login) || this.accountByLogin(login)) throw new Error(`bad or taken login ${login}`);
    const ids = (logins: string[]) => new Set(logins.map((l) => (this.accountByLogin(l) as Account).id));
    const org: Account = { id: this.nextId(), login, type: "organization", admins: ids(admins), members: ids([...admins, ...members]) };
    this.accounts.set(org.id, org);
    return org;
  }

  issueToken(userId: string): string {
    const token = `memtok_${++this.tokenSeq}_${userId}_k${(this.tokenSeq * 7919) % 104729}`;
    this.tokens.set(token, userId);
    return token;
  }

  /** The App installed on an account: every repository ("all"), or the ones named. */
  install(accountLogin: string, repos?: T.RepoRef[], permissions: Record<string, "read" | "write"> = { metadata: "read", contents: "write", checks: "write", issues: "write", pull_requests: "write" }): string {
    const account = this.accountByLogin(accountLogin);
    if (!account) throw new Error(`no account ${accountLogin}`);
    const inst: MemInstallation = {
      id: this.nextId(),
      accountId: account.id,
      selection: repos ? "selected" : "all",
      repos: new Set((repos ?? []).map((r) => (this.find(r) as MemRepo).id)),
      suspended: false,
      permissions,
    };
    this.installations.set(inst.id, inst);
    const sender = this.actorOf(account.id);
    this.record({ kind: "installation", delivery: "", action: "created", installation: this.installationOut(inst), sender });
    return inst.id;
  }

  grant(repo: T.RepoRef, login: string, permission: T.Permission): void {
    const r = this.find(repo);
    const user = this.accountByLogin(login);
    if (!r || !user) throw new Error("no such repository or person");
    r.collaborators.set(user.id, permission);
  }

  markTemplate(repo: T.RepoRef, isTemplate = true): void {
    const r = this.find(repo);
    if (!r) throw new Error("no such repository");
    r.isTemplate = isTemplate;
  }

  acceptTransfer(repoId: string): void {
    const r = this.repos.get(repoId);
    if (!r || !r.pendingTransfer) throw new Error("no transfer pending");
    const previous = { owner: this.ownerLogin(r), name: r.name };
    this.move(r, r.pendingTransfer.ownerId, r.pendingTransfer.name);
    r.pendingTransfer = null;
    this.record({ kind: "repository", delivery: "", installation: this.installationFor(r), action: "transferred", repo: this.stub(r), previous: { owner: previous.owner, name: previous.name === r.name ? null : previous.name }, sender: this.actorOf(r.ownerId) });
  }

  /** The person approving an authorization on the forge's page: the code the callback receives. */
  authorize(url: string, login: string): { code: string; state: string } {
    const u = new URL(url);
    const user = this.accountByLogin(login);
    if (!user || user.type !== "user") throw new Error(`no person ${login}`);
    if (u.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 only");
    const code = `memcode_${this.nextId()}`;
    const state = u.searchParams.get("state") ?? "";
    this.codes.set(code, { userId: user.id, state, challenge: u.searchParams.get("code_challenge") ?? "", redirectUri: u.searchParams.get("redirect_uri") ?? "", used: false });
    return { code, state };
  }

  /** The events recorded since the last call. */
  events(): T.ForgeEvent[] {
    const out = this.recorded;
    this.recorded = [];
    return out;
  }

  async deliver(event: T.ForgeEvent, secret: string): Promise<{ headers: Headers; body: Uint8Array }> {
    const body = utf8(JSON.stringify(event));
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Memory-Event": event.kind,
      "X-Memory-Delivery": event.delivery,
      "X-Memory-Signature": await signBody(secret, body),
    });
    return { headers, body };
  }

  /** Calls of this kind fail with `rate_limited` once `remaining` more are spent, until `resetAt`. */
  limit(kind: T.CredentialKind, remaining: number, resetAt: number): void {
    this.rate.set(kind, { remaining, resetAt });
  }

  /** The next call of `method` ("git.readFile") fails with this code. */
  failNext(method: string, code: GitErrorCode): void {
    this.failures.set(method, code);
  }

  setStatus(repo: T.RepoRef, sha: T.ObjectId, context: string, state: T.StatusState, description = ""): void {
    const r = this.find(repo);
    if (!r) throw new Error("no such repository");
    const list = (r.statuses.get(sha) ?? []).filter((s) => s.context !== context);
    list.push({ context, state, description, targetUrl: null });
    r.statuses.set(sha, list);
  }

  // ─── lookups and views ──────────────────────────────────────────────────

  accountByLogin(login: string): Account | undefined {
    const l = login.toLowerCase();
    for (const a of this.accounts.values()) if (a.login.toLowerCase() === l) return a;
    return undefined;
  }

  ownerLogin(r: MemRepo): string {
    return (this.accounts.get(r.ownerId) as Account).login;
  }

  refOf(r: MemRepo): T.RepoRef {
    return { forge: "memory", owner: this.ownerLogin(r), name: r.name };
  }

  /** A live repository by its path, following redirects. */
  find(ref: T.RepoRef): MemRepo | undefined {
    const key = `${ref.owner}/${ref.name}`.toLowerCase();
    const id = this.paths.get(key) ?? this.redirects.get(key);
    const r = id ? this.repos.get(id) : undefined;
    return r && !r.deleted ? r : undefined;
  }

  move(r: MemRepo, ownerId: string, name: string): void {
    const old = `${this.ownerLogin(r)}/${r.name}`.toLowerCase();
    this.paths.delete(old);
    this.redirects.set(old, r.id);
    r.ownerId = ownerId;
    r.name = name;
    const now = `${this.ownerLogin(r)}/${r.name}`.toLowerCase();
    this.redirects.delete(now);
    this.paths.set(now, r.id);
  }

  actorOf(userId: string | null): T.Actor {
    const a = userId ? this.accounts.get(userId) : undefined;
    return a ? { name: a.login, login: a.login, id: a.id } : { name: "ghost", login: null, id: null };
  }

  stub(r: MemRepo): T.RepoStub {
    return { key: { forge: "memory", id: r.id }, ref: this.refOf(r), visibility: r.visibility, defaultBranch: r.defaultBranch };
  }

  installationOut(i: MemInstallation): T.Installation {
    const a = this.accounts.get(i.accountId) as Account;
    return { id: i.id, account: { id: a.id, login: a.login, type: a.type }, selection: i.selection, suspended: i.suspended };
  }

  /** The installation that covers a repository, or null. */
  installationFor(r: MemRepo): string | null {
    for (const i of this.installations.values()) {
      if (i.accountId === r.ownerId && !i.suspended && (i.selection === "all" || i.repos.has(r.id))) return i.id;
    }
    return null;
  }

  /** A person's permission on a repository. */
  permissionOf(r: MemRepo, userId: string | null): T.Permission {
    if (userId) {
      if (r.ownerId === userId) return "admin";
      const owner = this.accounts.get(r.ownerId) as Account;
      if (owner.type === "organization" && owner.admins.has(userId)) return "admin";
      const granted = r.collaborators.get(userId);
      if (granted) return granted;
      if (owner.type === "organization" && owner.members.has(userId)) return "read";
    }
    return r.visibility === "public" ? "read" : "none";
  }

  record(event: T.ForgeEvent): void {
    this.recorded.push({ ...event, delivery: `mem-${++this.deliveries}` } as T.ForgeEvent);
  }

  /** A push event for a ref update. */
  pushed(r: MemRepo, sender: T.Actor, ref: string, before: T.ObjectId | null, after: T.ObjectId | null): void {
    const commits: { sha: T.ObjectId; added: string[]; removed: string[]; modified: string[] }[] = [];
    if (after && ref.startsWith("refs/heads/")) {
      for (const sha of this.store.missing(before, after).slice(-20)) {
        const c = this.store.commit(sha);
        if (!c) continue;
        const parent = c.parents[0] ? (this.store.commit(c.parents[0])?.tree ?? null) : null;
        const changes = this.store.changes(parent, c.tree);
        commits.push({
          sha,
          added: changes.filter((f) => f.status === "added").map((f) => f.path),
          removed: changes.filter((f) => f.status === "removed").map((f) => f.path),
          modified: changes.filter((f) => f.status !== "added" && f.status !== "removed").map((f) => f.path),
        });
      }
    }
    r.pushedAt = this.now();
    this.record({
      kind: "push",
      delivery: "",
      installation: this.installationFor(r),
      repo: this.stub(r),
      ref,
      before: before ?? ZERO,
      after: after ?? ZERO,
      created: before === null,
      deleted: after === null,
      forced: Boolean(before && after && !this.store.ancestors(after).has(before)),
      pushedAt: this.now(),
      commits,
      pusher: { name: sender.name, login: sender.login, id: sender.id },
    });
  }

  /** The files of a commit (or none). */
  flat(commit: T.ObjectId | null): Flat {
    if (!commit) return new Map();
    const c = this.store.commit(commit);
    if (!c) throw new GitBackendError("not_found", "no such commit");
    return this.store.flatten(c.tree);
  }

  /** Rate limits and injected failures, for one counted call. */
  gate(kind: T.CredentialKind, method: string, view: string | null): void {
    const limit = this.rate.get(kind);
    if (limit) {
      if (this.now() >= limit.resetAt) this.rate.delete(kind);
      else if (limit.remaining <= 0) {
        throw new GitBackendError("rate_limited", "the forge's hourly quota is spent", {
          retryAfter: Math.max(1, limit.resetAt - this.now()),
          limit: "primary",
          forgeStatus: 403,
          ...(kind === "anonymous" && view ? { fallbackUrl: view } : {}),
        });
      } else limit.remaining--;
    }
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw new GitBackendError(failure, `injected failure of ${method}`);
    }
  }
}

// ─── one session ──────────────────────────────────────────────────────────

/** What a session's methods share: the backend, who acts, and what they spent. */
export class Call {
  readonly b: MemoryBackend;
  readonly who: Who;
  readonly spent: T.Cost = { requests: 0, writes: 0, graphql: 0, mints: 0 };

  constructor(b: MemoryBackend, who: Who) {
    this.b = b;
    this.who = who;
  }

  get kind(): T.CredentialKind {
    return this.who.kind;
  }

  get caps(): ReadonlySet<Capability> {
    return GITHUB_CAPABILITIES[this.who.kind];
  }

  /** The start of every method, once its arguments are checked: the rule, the count, the
   *  credential, the rate limit, an injected failure. */
  enter(method: string, o: { act: Act; need?: Capability; fallback?: string | null; view?: string | null; graphql?: boolean; free?: boolean; write?: boolean }): void {
    guard(this.kind, this.caps, o.act, o.need, o.fallback);
    if (!o.free) {
      if (this.who.kind === "installation") {
        const last = this.b.minted.get(this.who.installationId);
        if (last === undefined || this.b.now() - last > 3300) {
          this.b.minted.set(this.who.installationId, this.b.now());
          this.spent.mints++;
          this.spent.requests++;
        }
      }
      this.spent.requests++;
      if (o.write ?? o.act !== "read") this.spent.writes++;
      if (o.graphql) this.spent.graphql++;
    }
    if (this.who.kind === "user" && !this.b.tokens.has(this.who.token)) throw new GitBackendError("unauthorized", "the forge refused the credential");
    if (this.who.kind === "installation") {
      const inst = this.b.installations.get(this.who.installationId);
      if (!inst || inst.suspended) throw new GitBackendError("unauthorized", "the forge refused the credential");
    }
    if (!o.free) this.b.gate(this.kind, method, o.view ?? null);
  }

  userId(): string | null {
    return this.who.kind === "user" ? (this.b.tokens.get(this.who.token) ?? null) : null;
  }

  me(): Account {
    const id = this.userId();
    const a = id ? this.b.accounts.get(id) : undefined;
    if (!a) throw new GitBackendError("unauthorized", "no person behind this credential");
    return a;
  }

  actor(): T.Actor {
    return this.b.actorOf(this.userId());
  }

  installation(): MemInstallation | null {
    return this.who.kind === "installation" ? (this.b.installations.get(this.who.installationId) ?? null) : null;
  }

  /** This session's permission on a repository. */
  permission(r: MemRepo): T.Permission {
    const inst = this.installation();
    if (inst) {
      const covers = inst.accountId === r.ownerId && (inst.selection === "all" || inst.repos.has(r.id));
      if (covers) return "read";
      return r.visibility === "public" ? "read" : "none";
    }
    return this.b.permissionOf(r, this.userId());
  }

  /** A repository this session may act on at `level`: not_found when it cannot see it,
   *  forbidden when it may not act, archived for a write to an archived repository. */
  repo(ref: T.RepoRef, level: T.Permission, o: { archivedOk?: boolean } = {}): MemRepo {
    const r = this.b.find(ref);
    if (!r) throw new GitBackendError("not_found", "no such repository");
    const have = this.permission(r);
    if (have === "none") throw new GitBackendError("not_found", "no such repository");
    if (r.disabled) throw new GitBackendError("gone", "the repository is disabled");
    if (!atLeast(have, level)) throw new GitBackendError("forbidden", "the credential may not do this here");
    if (level !== "read" && r.archived && !o.archivedOk) throw new GitBackendError("archived", "the repository is archived");
    return r;
  }

  /** Whether the installation may post check runs on this repository. */
  mayCheck(r: MemRepo): boolean {
    const inst = this.installation();
    return Boolean(inst && inst.accountId === r.ownerId && (inst.selection === "all" || inst.repos.has(r.id)) && inst.permissions.checks === "write");
  }
}

// ─── authorization ────────────────────────────────────────────────────────

async function s256(verifier: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(verifier) as Uint8Array<ArrayBuffer>)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The double's per-action authorization: codes bound to the state, the PKCE challenge (S256)
 *  and the redirect address, each usable once; revoked tokens are refused. The same behaviour as
 *  tests/account/mock.ts. */
function memoryAuth(b: MemoryBackend): ForgeAuth {
  const person = (token: string): Account => {
    const id = typeof token === "string" ? b.tokens.get(token) : undefined;
    const a = id ? b.accounts.get(id) : undefined;
    if (!a) throw new GitBackendError("unauthorized", "the forge refused the credential");
    return a;
  };
  return {
    authorizeUrl(input) {
      if (typeof input?.state !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(input.state)) throw new GitBackendError("invalid", "not a state");
      if (typeof input.codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw new GitBackendError("invalid", "not a PKCE challenge");
      const u = new URL(`${b.web}/login/oauth/authorize`);
      u.searchParams.set("client_id", "memory-app");
      u.searchParams.set("redirect_uri", input.redirectUri);
      u.searchParams.set("state", input.state);
      u.searchParams.set("code_challenge", input.codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },
    async exchange(input) {
      const code = b.codes.get(input?.code);
      if (!code || code.used) throw new GitBackendError("unauthorized", "the forge refused the code");
      if (code.redirectUri !== input.redirectUri || code.challenge !== (await s256(String(input.codeVerifier)))) {
        throw new GitBackendError("unauthorized", "the forge refused the code");
      }
      code.used = true;
      return { token: b.issueToken(code.userId), expiresAt: b.now() + 8 * 3600 };
    },
    async whoAmI(token) {
      const a = person(token);
      return { id: a.id, login: a.login };
    },
    async revoke(token) {
      b.tokens.delete(token);
    },
    installUrl(state) {
      return `${b.web}/apps/${encodeURIComponent(b.appSlug)}/installations/new?${new URLSearchParams({ state })}`;
    },
    async installations(token, page) {
      const a = person(token);
      const mine = [...b.installations.values()].filter((i) => {
        const acc = b.accounts.get(i.accountId) as Account;
        return acc.id === a.id || acc.members.has(a.id);
      });
      return pageOf(mine.map((i) => b.installationOut(i)), page);
    },
    async installationRepositories(token, installationId, page) {
      const a = person(token);
      const inst = b.installations.get(installationId);
      const acc = inst ? (b.accounts.get(inst.accountId) as Account) : undefined;
      if (!inst || !acc || (acc.id !== a.id && !acc.members.has(a.id))) throw new GitBackendError("not_found", "no such installation");
      const repos = [...b.repos.values()]
        .filter((r) => !r.deleted && r.ownerId === inst.accountId && (inst.selection === "all" || inst.repos.has(r.id)))
        .filter((r) => b.permissionOf(r, a.id) !== "none");
      return pageOf(
        repos.map((r) => ({ ...b.stub(r), permission: b.permissionOf(r, a.id) })),
        page,
      );
    },
  };
}
