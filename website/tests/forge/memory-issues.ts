// The test double's issues and pull requests (memory.ts): one numbering per repository, shared
// by both, as on GitHub; comments, reactions, labels, milestones, locks, pins, sub-issues,
// dependencies and timelines; reviews, line comments and threads; merges by merge commit, squash
// or rebase (three-way at path level), with "fixes #N" closing issue N when the base is the
// default branch.

import { GitBackendError, invalid } from "../../worker/forge/errors.ts";
import type { IssueOps, IssueTarget, PullOps } from "../../worker/forge/gitbackend.ts";
import { text } from "../../worker/forge/objects.ts";
import { checkBody, checkId, checkLogin, checkNumber, checkObjectId, checkPage, checkPath, checkRefName, checkRepo, checkTitle } from "../../worker/forge/paths.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Flat, ZERO } from "./gitobjects.ts";
import { type Account, atLeast, type Call, iso, type MemIssue, type MemPull, type MemRepo, type MemReviewComment, pageOf } from "./memory.ts";
import { commitOut, makeCommit, mergeCommits, notFound, setBranch } from "./memory-core.ts";

const REACTIONS = new Set(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]);
const LOCKS = new Set(["off-topic", "too heated", "resolved", "spam"]);
const REASONS = new Set(["completed", "not_planned", "duplicate", "reopened"]);
/** An organization's default issue types (GitHub's); a personal repository has none. */
export const ISSUE_TYPES = ["Task", "Bug", "Feature"];
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
const MENTION = /(?:^|[^\w/#&])#(\d+)\b/g;

function vp(page: T.PageRequest | undefined): void {
  const { cursor } = checkPage(page);
  if (cursor !== null && !/^\d{1,5}$/.test(cursor)) throw invalid("not a page cursor");
}

function checkLabelName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 50 || /[\u0000-\u001f]/.test(name)) throw invalid("not a label name");
  return name;
}

function checkColor(color: unknown): string {
  if (typeof color !== "string" || !/^[0-9a-fA-F]{6}$/.test(color)) throw invalid("a colour is 6 hex digits");
  return color.toLowerCase();
}

function checkReaction(r: unknown): T.Reaction {
  if (typeof r !== "string" || !REACTIONS.has(r)) throw invalid("not a reaction");
  return r as T.Reaction;
}

function counts(map: Map<string, Set<T.Reaction>>): Partial<Record<T.Reaction, number>> {
  const out: Partial<Record<T.Reaction, number>> = {};
  for (const set of map.values()) for (const k of set) out[k] = (out[k] ?? 0) + 1;
  return out;
}

// ─── shared by issues and pull requests ───────────────────────────────────

function issueOut(c: Call, r: MemRepo, i: MemIssue): T.Issue {
  const children = i.subIssues.map((n) => r.issues.get(n)).filter((x): x is MemIssue => Boolean(x && !x.gone));
  return {
    number: i.number,
    id: i.id,
    nodeId: i.nodeId,
    title: i.title,
    body: i.body,
    state: i.state,
    stateReason: i.stateReason,
    author: c.b.actorOf(i.authorId),
    labels: [...i.labels],
    assignees: [...i.assignees],
    milestone: i.milestone,
    locked: i.locked,
    lockReason: i.lockReason,
    pinned: i.pinned,
    comments: i.comments.length,
    reactions: counts(i.reactions),
    subIssues: { total: children.length, completed: children.filter((x) => x.state === "closed").length },
    type: i.type,
    isPullRequest: i.pull !== null,
    createdAt: iso(i.createdAt),
    updatedAt: iso(i.updatedAt),
    closedAt: i.closedAt === null ? null : iso(i.closedAt),
  };
}

function note(c: Call, i: MemIssue, kind: T.TimelineEvent["kind"], subject: string | null = null): void {
  i.timeline.push({ kind, actorId: c.userId(), at: c.b.now(), subject });
  i.updatedAt = c.b.now();
}

/** "#N" in a text: a cross-reference on issue N's timeline. */
function crossReference(c: Call, r: MemRepo, source: number, body: string): void {
  const subject = `${c.b.ownerLogin(r)}/${r.name}#${source}`;
  for (const m of body.matchAll(MENTION)) {
    const n = Number(m[1]);
    const target = r.issues.get(n);
    if (!target || target.gone || n === source) continue;
    if (target.timeline.some((e) => e.kind === "cross-referenced" && e.subject === subject)) continue;
    note(c, target, "cross-referenced", subject);
  }
}

function newIssue(c: Call, r: MemRepo, title: string, body: string, pull: MemPull | null): MemIssue {
  const b = c.b;
  const number = ++r.counter;
  const id = b.nextId();
  const i: MemIssue = {
    number,
    id,
    nodeId: `${pull ? "PR" : "I"}_mem${id}`,
    title,
    body,
    state: "open",
    stateReason: null,
    authorId: c.userId() ?? "",
    labels: [],
    assignees: [],
    milestone: null,
    locked: false,
    lockReason: null,
    pinned: false,
    comments: [],
    reactions: new Map(),
    subIssues: [],
    parent: null,
    blockedBy: [],
    type: null,
    timeline: [],
    createdAt: b.now(),
    updatedAt: b.now(),
    closedAt: null,
    pull,
    gone: false,
  };
  r.issues.set(number, i);
  crossReference(c, r, number, body);
  return i;
}

function issueAt(r: MemRepo, n: number): MemIssue {
  const i = r.issues.get(n);
  if (!i || i.gone) throw notFound("no such issue");
  return i;
}

function closeIssue(c: Call, i: MemIssue, reason: T.StateReason, subject: string | null = null): void {
  if (i.state === "closed") return;
  i.state = "closed";
  i.stateReason = reason;
  i.closedAt = c.b.now();
  note(c, i, "closed", subject);
}

// ─── pull requests ────────────────────────────────────────────────────────

function pullAt(r: MemRepo, n: number): MemIssue & { pull: MemPull } {
  const i = r.issues.get(n);
  if (!i || i.gone || !i.pull) throw notFound("no such pull request");
  return i as MemIssue & { pull: MemPull };
}

export function pullOps(c: Call): PullOps {
  const b = c.b;
  const store = b.store;
  const treeOf = (commit: T.ObjectId) => (store.commit(commit) as { tree: string }).tree;

  const headRepo = (p: MemPull) => {
    const x = b.repos.get(p.headRepoId);
    return x && !x.deleted ? x : null;
  };
  const headSha = (p: MemPull) => (p.merged ? (p.mergedHead as string) : (headRepo(p)?.branches.get(p.headRef) ?? p.headSha));
  const baseSha = (r: MemRepo, p: MemPull) => (p.merged ? (p.mergedBase as string) : (r.branches.get(p.baseRef) ?? ZERO));

  const prCommits = (r: MemRepo, p: MemPull): T.ObjectId[] => {
    const base = baseSha(r, p);
    return store.missing(base === ZERO ? null : base, headSha(p));
  };

  const prFiles = (r: MemRepo, p: MemPull): T.FileChangeSummary[] => {
    const base = baseSha(r, p);
    const head = headSha(p);
    const mb = base === ZERO ? null : store.mergeBase(base, head);
    return store.changes(mb ? treeOf(mb) : null, treeOf(head));
  };

  const conflicts = (r: MemRepo, p: MemPull): string[] => {
    const base = baseSha(r, p);
    return base === ZERO ? [] : mergeCommits(b, base, headSha(p)).conflicts;
  };

  const out = (r: MemRepo, i: MemIssue & { pull: MemPull }): T.PullRequest => {
    const p = i.pull;
    const files = prFiles(r, p);
    const open = i.state === "open";
    const mergeable = open ? conflicts(r, p).length === 0 : null;
    const hr = headRepo(p);
    return {
      number: i.number,
      id: i.id,
      nodeId: i.nodeId,
      title: i.title,
      body: i.body,
      state: i.state,
      draft: p.draft,
      merged: p.merged,
      mergedAt: p.mergedAt === null ? null : iso(p.mergedAt),
      mergeCommit: p.mergeCommit,
      author: b.actorOf(i.authorId),
      createdAt: iso(i.createdAt),
      updatedAt: iso(i.updatedAt),
      closedAt: i.closedAt === null ? null : iso(i.closedAt),
      head: { repo: hr ? b.refOf(hr) : null, ref: p.headRef, sha: headSha(p) },
      base: { repo: b.refOf(r), ref: p.baseRef, sha: baseSha(r, p) },
      mergeable,
      mergeState: !open ? "unknown" : p.draft ? "draft" : mergeable ? "clean" : "dirty",
      requestedReviewers: [...p.requestedReviewers],
      labels: [...i.labels],
      assignees: [...i.assignees],
      milestone: i.milestone,
      autoMerge: p.autoMerge,
      maintainerCanModify: p.maintainerCanModify,
      counts: {
        commits: prCommits(r, p).length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        changedFiles: files.length,
        comments: i.comments.length + p.reviewComments.length,
      },
    };
  };

  const event = (r: MemRepo, i: MemIssue & { pull: MemPull }, action: string) =>
    b.record({
      kind: "pull_request",
      delivery: "",
      installation: b.installationFor(r),
      action,
      number: i.number,
      repo: b.stub(r),
      head: { ref: i.pull.headRef, sha: headSha(i.pull) },
      base: { ref: i.pull.baseRef },
      merged: i.pull.merged,
      sender: c.actor(),
    });

  /** The pull request's author, or someone who may write to the repository. */
  const mayEdit = (r: MemRepo, i: MemIssue) => i.authorId === c.userId() || atLeast(c.permission(r), "triage");

  const commentOut = (x: MemReviewComment, stale: boolean): T.ReviewComment => ({
    id: x.id,
    reviewId: x.reviewId,
    inReplyTo: x.inReplyTo,
    author: b.actorOf(x.authorId),
    path: x.path,
    line: stale ? null : x.line,
    startLine: stale ? null : x.startLine,
    side: x.side,
    commit: x.commit,
    originalCommit: x.commit,
    body: x.body,
    createdAt: iso(x.createdAt),
    updatedAt: iso(x.updatedAt),
  });

  /** Whether a line comment's line changed since it was written. */
  const outdated = (p: MemPull, x: MemReviewComment): boolean => {
    const now = headSha(p);
    if (x.side === "LEFT" || x.commit === now) return false;
    const was = store.at(treeOf(x.commit), x.path);
    const is = store.at(treeOf(now), x.path);
    return was?.sha !== is?.sha;
  };

  const threadOut = (r: MemRepo, id: string): T.ReviewThread => {
    const t = r.threads.get(id);
    if (!t) throw notFound("no such thread");
    const p = pullAt(r, t.number).pull;
    const comments = t.comments.map((cid) => b.reviewComments.get(cid) as MemReviewComment);
    const stale = outdated(p, comments[0]);
    return { id: t.id, resolved: t.resolved, outdated: stale, path: comments[0].path, line: stale ? null : comments[0].line, comments: comments.map((x) => commentOut(x, stale)) };
  };

  /** The lines of a file at a commit (0 when absent). */
  const lineCount = (commit: T.ObjectId, path: string): number => {
    const at = store.at(treeOf(commit), path);
    const bytes = at ? store.blob(at.sha)?.bytes : undefined;
    if (!bytes) return 0;
    const t = text(bytes);
    return t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
  };

  /** Carry out a merge by one method; the new tip of the base branch. */
  const carry = async (r: MemRepo, i: MemIssue & { pull: MemPull }, input: T.PullMergeInput): Promise<T.ObjectId> => {
    const p = i.pull;
    const base = r.branches.get(p.baseRef) as string;
    const head = headSha(p);
    const hr = headRepo(p);
    if (input.method === "rebase") {
      const list = prCommits(r, p).filter((s) => (store.commit(s)?.parents.length ?? 0) <= 1);
      if (list.length > b.limits.rebaseMergeCommits) throw new GitBackendError("not_mergeable", "too many commits to rebase");
      let tip = base;
      let flat: Flat = b.flat(base);
      for (const s of list) {
        const co = store.commit(s);
        if (!co) continue;
        const before = b.flat(co.parents[0] ?? null);
        const after = b.flat(s);
        const next: Flat = new Map(flat);
        for (const path of new Set([...before.keys(), ...after.keys()])) {
          const x = before.get(path);
          const y = after.get(path);
          if (x?.sha === y?.sha && x?.mode === y?.mode) continue;
          const cur = flat.get(path);
          const clean = cur?.sha === x?.sha || cur?.sha === y?.sha;
          if (!clean) throw new GitBackendError("not_mergeable", "the commits do not apply cleanly on the base");
          if (y) next.set(path, y);
          else next.delete(path);
        }
        flat = next;
        tip = (await makeCommit(c, { flat, parents: [tip], message: co.message, author: co.author, authoredAt: co.authoredAt })).sha;
      }
      return tip;
    }
    const { merged, conflicts: clash } = mergeCommits(b, base, head);
    if (clash.length) throw new GitBackendError("not_mergeable", "the pull request has conflicts");
    if (input.method === "squash") {
      const title = input.title ?? `${i.title} (#${i.number})`;
      const message = input.message ?? prCommits(r, p).map((s) => `* ${store.commit(s)?.message.split("\n")[0] ?? ""}`).join("\n");
      return (await makeCommit(c, { flat: merged, parents: [base], message: message ? `${title}\n\n${message}` : title })).sha;
    }
    const title = input.title ?? `Merge pull request #${i.number} from ${hr ? b.ownerLogin(hr) : "unknown"}/${p.headRef}`;
    const message = input.message ?? i.title;
    return (await makeCommit(c, { flat: merged, parents: [base, head], message: `${title}\n\n${message}` })).sha;
  };

  return {
    async list(ref, filter = {}, page) {
      checkRepo(ref);
      vp(page);
      if (filter.state !== undefined && !["open", "closed", "all"].includes(filter.state)) throw invalid("not a state");
      if (filter.base !== undefined) checkRefName(filter.base, "branch");
      c.enter("pulls.list", { act: "read", view: `${b.links.repo(ref)}/pulls` });
      const r = c.repo(ref, "read");
      const state = filter.state ?? "open";
      let list = [...r.issues.values()].filter((i): i is MemIssue & { pull: MemPull } => Boolean(i.pull && !i.gone));
      if (state !== "all") list = list.filter((i) => i.state === state);
      if (filter.base !== undefined) list = list.filter((i) => i.pull.baseRef === filter.base);
      if (filter.head !== undefined) {
        const [owner, branch] = filter.head.includes(":") ? filter.head.split(":", 2) : [b.ownerLogin(r), filter.head];
        list = list.filter((i) => {
          const hr = headRepo(i.pull);
          return hr !== null && b.ownerLogin(hr).toLowerCase() === owner.toLowerCase() && i.pull.headRef === branch;
        });
      }
      const sort = filter.sort ?? "created";
      const key = (i: MemIssue & { pull: MemPull }) =>
        sort === "updated" ? i.updatedAt * 1e6 + i.number : sort === "popularity" ? i.comments.length * 1e6 + i.number : sort === "long-running" ? -i.createdAt * 1e6 + i.number : i.createdAt * 1e6 + i.number;
      const direction = filter.direction ?? (sort === "long-running" ? "asc" : "desc");
      list.sort((x, y) => (direction === "asc" ? key(x) - key(y) : key(y) - key(x)));
      return pageOf(list.map((i) => out(r, i)), page);
    },

    async get(ref, number) {
      checkRepo(ref);
      checkNumber(number);
      c.enter("pulls.get", { act: "read", view: `${b.links.repo(ref)}/pull/${number}` });
      const r = c.repo(ref, "read");
      return out(r, pullAt(r, number));
    },

    async files(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("pulls.files", { act: "read", view: `${b.links.repo(ref)}/pull/${number}` });
      const r = c.repo(ref, "read");
      return pageOf(prFiles(r, pullAt(r, number).pull), page);
    },

    async commits(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("pulls.commits", { act: "read", view: `${b.links.repo(ref)}/pull/${number}` });
      const r = c.repo(ref, "read");
      return pageOf(prCommits(r, pullAt(r, number).pull).map((s) => commitOut(b, s)), page);
    },

    async create(ref, input) {
      checkRepo(ref);
      const title = checkTitle(input?.title);
      const body = checkBody(input.body);
      if (typeof input.head !== "string") throw invalid("not a head");
      const [headOwner, headRef] = input.head.includes(":") ? input.head.split(":", 2) : [null, input.head];
      checkRefName(headRef, "branch");
      if (headOwner !== null) checkLogin(headOwner);
      checkRefName(input.base, "branch");
      c.enter("pulls.create", { act: "write" });
      const r = c.repo(ref, "read");
      if (r.archived) throw new GitBackendError("archived", "the repository is archived");
      let hr: MemRepo | undefined = r;
      if (headOwner !== null && headOwner.toLowerCase() !== b.ownerLogin(r).toLowerCase()) {
        hr = [...b.repos.values()].find((x) => !x.deleted && b.ownerLogin(x).toLowerCase() === headOwner.toLowerCase() && isForkOf(x, r));
        if (!hr) throw invalid("head: no such fork");
      }
      const head = hr.branches.get(headRef);
      const base = r.branches.get(input.base);
      if (!head) throw invalid("head: no such branch");
      if (!base) throw invalid("base: no such branch");
      if (hr.id === r.id && headRef === input.base) throw invalid("the head and the base are the same branch");
      const headRepoId = hr.id;
      const dup = [...r.issues.values()].some((i) => i.pull && i.state === "open" && i.pull.headRepoId === headRepoId && i.pull.headRef === headRef && i.pull.baseRef === input.base);
      if (dup) throw new GitBackendError("conflict", "A pull request already exists");
      if (store.ancestors(base).has(head)) throw invalid(`No commits between ${input.base} and ${headRef}`);
      const pull: MemPull = {
        headRepoId,
        headRef,
        headSha: head,
        baseRef: input.base,
        draft: input.draft === true,
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        mergedBase: null,
        mergedHead: null,
        maintainerCanModify: input.maintainerCanModify ?? true,
        requestedReviewers: [],
        autoMerge: null,
        reviews: [],
        reviewComments: [],
      };
      const i = newIssue(c, r, title, body, pull) as MemIssue & { pull: MemPull };
      event(r, i, "opened");
      return out(r, i);
    },

    async update(ref, number, patch) {
      checkRepo(ref);
      checkNumber(number);
      if (!patch || typeof patch !== "object") throw invalid("no change");
      if (patch.title !== undefined) checkTitle(patch.title);
      if (patch.body !== undefined) checkBody(patch.body);
      if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") throw invalid("not a state");
      if (patch.base !== undefined) checkRefName(patch.base, "branch");
      c.enter("pulls.update", { act: "write" });
      const r = c.repo(ref, "read");
      const i = pullAt(r, number);
      if (!mayEdit(r, i)) throw new GitBackendError("forbidden", "only the author or a maintainer edits a pull request");
      if (r.archived) throw new GitBackendError("archived", "the repository is archived");
      if (patch.title !== undefined && patch.title !== i.title) {
        i.title = patch.title;
        note(c, i, "renamed", patch.title);
      }
      if (patch.body !== undefined) {
        i.body = patch.body;
        crossReference(c, r, i.number, patch.body);
      }
      if (patch.base !== undefined && patch.base !== i.pull.baseRef) {
        if (!r.branches.has(patch.base)) throw invalid("base: no such branch");
        i.pull.baseRef = patch.base;
        event(r, i, "edited");
      }
      if (patch.state === "closed" && i.state === "open") {
        if (i.pull.merged) throw invalid("the pull request is merged");
        i.state = "closed";
        i.closedAt = b.now();
        note(c, i, "closed");
        event(r, i, "closed");
      } else if (patch.state === "open" && i.state === "closed") {
        if (i.pull.merged) throw invalid("a merged pull request stays closed");
        if (!headRepo(i.pull)?.branches.has(i.pull.headRef)) throw invalid("the head branch is gone");
        i.state = "open";
        i.closedAt = null;
        note(c, i, "reopened");
        event(r, i, "reopened");
      }
      i.updatedAt = b.now();
      return out(r, i);
    },

    async setDraft(ref, number, draft) {
      checkRepo(ref);
      checkNumber(number);
      if (typeof draft !== "boolean") throw invalid("draft is true or false");
      c.enter("pulls.setDraft", { act: "write", need: "draftToggle", graphql: true });
      const r = c.repo(ref, "read");
      const i = pullAt(r, number);
      if (!mayEdit(r, i)) throw new GitBackendError("forbidden", "only the author or a maintainer changes a draft");
      if (i.state !== "open") throw invalid("the pull request is closed");
      if (i.pull.draft !== draft) {
        i.pull.draft = draft;
        event(r, i, draft ? "converted_to_draft" : "ready_for_review");
      }
      return out(r, i);
    },

    async requestReviewers(ref, number, logins) {
      checkRepo(ref);
      checkNumber(number);
      if (!Array.isArray(logins) || !logins.length || logins.length > 15) throw invalid("1 to 15 logins");
      logins.forEach(checkLogin);
      c.enter("pulls.requestReviewers", { act: "write" });
      const r = c.repo(ref, "triage");
      const i = pullAt(r, number);
      for (const login of logins) {
        const who = b.accountByLogin(login);
        if (!who || who.type !== "user") throw invalid("Reviews may only be requested from collaborators");
        const collaborator = r.ownerId === who.id || r.collaborators.has(who.id) || (b.accounts.get(r.ownerId) as Account).members.has(who.id);
        if (!collaborator) throw invalid("Reviews may only be requested from collaborators");
        if (who.id === i.authorId) throw invalid("the author does not review their own pull request");
        if (!i.pull.requestedReviewers.includes(who.login)) i.pull.requestedReviewers.push(who.login);
      }
      event(r, i, "review_requested");
      return out(r, i);
    },

    async removeReviewers(ref, number, logins) {
      checkRepo(ref);
      checkNumber(number);
      if (!Array.isArray(logins) || !logins.length || logins.length > 15) throw invalid("1 to 15 logins");
      logins.forEach(checkLogin);
      c.enter("pulls.removeReviewers", { act: "write" });
      const r = c.repo(ref, "triage");
      const i = pullAt(r, number);
      const drop = new Set(logins.map((l) => l.toLowerCase()));
      i.pull.requestedReviewers = i.pull.requestedReviewers.filter((l) => !drop.has(l.toLowerCase()));
      event(r, i, "review_request_removed");
      return out(r, i);
    },

    async reviews(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("pulls.reviews", { act: "read", view: `${b.links.repo(ref)}/pull/${number}` });
      const r = c.repo(ref, "read");
      const i = pullAt(r, number);
      return pageOf(i.pull.reviews.map((x) => ({ id: x.id, author: b.actorOf(x.authorId), state: x.state, body: x.body, commit: x.commit, submittedAt: iso(x.at) })), page);
    },

    async review(ref, number, input) {
      checkRepo(ref);
      checkNumber(number);
      if (!input || !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(input.event)) throw invalid("not a review event");
      const body = checkBody(input.body);
      if (input.commit !== undefined) checkObjectId(input.commit);
      const lineComments = (input.comments ?? []).map((x) => {
        const side = x.side ?? "RIGHT";
        if (side !== "LEFT" && side !== "RIGHT") throw invalid("not a side");
        return { path: checkPath(x.path), line: checkNumber(x.line, "line"), side, startLine: x.startLine === undefined ? null : checkNumber(x.startLine, "line"), body: checkBody(x.body, "comment", true) };
      });
      if (input.event === "REQUEST_CHANGES" && !body.trim() && !lineComments.length) throw invalid("a change request says what to change");
      if (input.event === "COMMENT" && !body.trim() && !lineComments.length) throw invalid("a review comment says something");
      c.enter("pulls.review", { act: "write" });
      const r = c.repo(ref, "read");
      const i = pullAt(r, number);
      if (i.authorId === c.userId() && input.event !== "COMMENT") throw invalid("Can not approve your own pull request");
      const p = i.pull;
      const head = headSha(p);
      const commit = input.commit ?? head;
      const files = new Set(prFiles(r, p).map((f) => f.path));
      const base = baseSha(r, p);
      for (const x of lineComments) {
        if (!files.has(x.path)) throw invalid("pull_request_review_thread.path: diff not found");
        const max = x.side === "LEFT" ? lineCount(store.mergeBase(base, head) ?? base, x.path) : lineCount(commit, x.path);
        if (x.line > max || (x.startLine !== null && x.startLine > x.line)) throw invalid("pull_request_review_thread.line: could not be resolved");
      }
      const review = {
        id: b.nextId(),
        authorId: c.userId() ?? "",
        state: (input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED") as T.Review["state"],
        body,
        commit,
        at: b.now(),
      };
      p.reviews.push(review);
      for (const x of lineComments) {
        const id = b.nextId();
        const threadId = `PRRT_mem${id}`;
        const comment: MemReviewComment = { id, reviewId: review.id, inReplyTo: null, authorId: review.authorId, path: x.path, line: x.line, startLine: x.startLine, side: x.side as "LEFT" | "RIGHT", commit, body: x.body, createdAt: b.now(), updatedAt: b.now(), threadId };
        b.reviewComments.set(id, { ...comment, repoId: r.id, number });
        p.reviewComments.push(id);
        r.threads.set(threadId, { id: threadId, number, resolved: false, comments: [id] });
      }
      const me = c.me().login.toLowerCase();
      p.requestedReviewers = p.requestedReviewers.filter((l) => l.toLowerCase() !== me);
      note(c, i, "reviewed", review.state);
      return { id: review.id, author: b.actorOf(review.authorId), state: review.state, body, commit, submittedAt: iso(review.at) };
    },

    async comments(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("pulls.comments", { act: "read", view: `${b.links.repo(ref)}/pull/${number}` });
      const r = c.repo(ref, "read");
      const p = pullAt(r, number).pull;
      return pageOf(p.reviewComments.map((id) => b.reviewComments.get(id) as MemReviewComment).map((x) => commentOut(x, outdated(p, x))), page);
    },

    async reply(ref, number, commentId, body) {
      checkRepo(ref);
      checkNumber(number);
      checkId(commentId, "comment id");
      const said = checkBody(body, "reply", true);
      c.enter("pulls.reply", { act: "write" });
      const r = c.repo(ref, "read");
      const i = pullAt(r, number);
      const parent = b.reviewComments.get(commentId);
      if (!parent || parent.repoId !== r.id || parent.number !== number) throw notFound("no such comment");
      if (parent.inReplyTo !== null) throw invalid("replies to replies are not supported");
      const id = b.nextId();
      const reply: MemReviewComment = { ...parent, id, reviewId: null, inReplyTo: parent.id, authorId: c.userId() ?? "", body: said, createdAt: b.now(), updatedAt: b.now() };
      b.reviewComments.set(id, { ...reply, repoId: r.id, number });
      i.pull.reviewComments.push(id);
      r.threads.get(parent.threadId)?.comments.push(id);
      return commentOut(reply, outdated(i.pull, reply));
    },

    async threads(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("pulls.threads", { act: "read", need: "reviewThreads", fallback: `${b.links.repo(ref)}/pull/${number}/files`, graphql: true });
      const r = c.repo(ref, "read");
      pullAt(r, number);
      const ids = [...r.threads.values()].filter((t) => t.number === number).map((t) => t.id);
      return pageOf(ids.map((id) => threadOut(r, id)), page);
    },

    async resolveThread(ref, threadId, resolved) {
      checkRepo(ref);
      checkId(threadId, "thread id");
      c.enter("pulls.resolveThread", { act: "write", need: "reviewThreads", graphql: true });
      const r = c.repo(ref, "read");
      const t = r.threads.get(threadId);
      if (!t) throw notFound("no such thread");
      const i = pullAt(r, t.number);
      if (!mayEdit(r, i) && !atLeast(c.permission(r), "write")) throw new GitBackendError("forbidden", "only the author or a maintainer resolves a thread");
      t.resolved = resolved;
      return threadOut(r, threadId);
    },

    async merge(ref, number, input) {
      checkRepo(ref);
      checkNumber(number);
      if (!input || !["merge", "squash", "rebase"].includes(input.method)) throw invalid("not a merge method");
      checkObjectId(input.expectedHead);
      if (input.title !== undefined) checkTitle(input.title);
      if (input.message !== undefined) checkBody(input.message, "message");
      c.enter("pulls.merge", { act: "write" });
      const r = c.repo(ref, "write");
      const i = pullAt(r, number);
      const p = i.pull;
      if (i.state !== "open") throw new GitBackendError("not_mergeable", "Pull Request is not mergeable");
      if (headSha(p) !== input.expectedHead) throw new GitBackendError("conflict", "Head branch was modified");
      if (p.draft) throw new GitBackendError("not_mergeable", "a draft is not merged");
      if (!r.branches.has(p.baseRef)) throw new GitBackendError("not_mergeable", "the base branch is gone");
      const base = r.branches.get(p.baseRef) as string;
      const head = headSha(p);
      const tip = await carry(r, i, input);
      p.merged = true;
      p.mergedAt = b.now();
      p.mergeCommit = tip;
      p.mergedBase = base;
      p.mergedHead = head;
      p.autoMerge = null;
      i.state = "closed";
      i.closedAt = b.now();
      setBranch(c, r, p.baseRef, tip);
      note(c, i, "merged", tip);
      note(c, i, "closed", tip);
      event(r, i, "closed");
      if (p.baseRef === r.defaultBranch) {
        for (const m of `${i.title}\n${i.body}`.matchAll(CLOSING)) {
          const target = r.issues.get(Number(m[1]));
          if (target && !target.gone && !target.pull) closeIssue(c, target, "completed", tip);
        }
      }
      const hr = headRepo(p);
      if (r.features.deleteBranchOnMerge && hr && hr.id === r.id && p.headRef !== r.defaultBranch && hr.branches.has(p.headRef)) setBranch(c, hr, p.headRef, null);
      return { sha: tip };
    },

    async updateBranch(ref, number, expectedHead) {
      checkRepo(ref);
      checkNumber(number);
      if (expectedHead !== undefined) checkObjectId(expectedHead);
      c.enter("pulls.updateBranch", { act: "write" });
      const r = c.repo(ref, "read");
      const i = pullAt(r, number);
      const p = i.pull;
      const hr = headRepo(p);
      if (!hr || !hr.branches.has(p.headRef)) throw invalid("the head branch is gone");
      if (!atLeast(c.permission(hr), "write") && !(p.maintainerCanModify && atLeast(c.permission(r), "write"))) throw new GitBackendError("forbidden", "the credential may not push to the head branch");
      const head = hr.branches.get(p.headRef) as string;
      if (expectedHead !== undefined && expectedHead !== head) throw new GitBackendError("conflict", "expected head sha didn't match current head ref");
      const base = r.branches.get(p.baseRef) as string;
      if (store.ancestors(head).has(base)) return;
      const { merged, conflicts: clash } = mergeCommits(b, head, base);
      if (clash.length) throw new GitBackendError("conflict", "merge conflict between base and head");
      const made = await makeCommit(c, { flat: merged, parents: [head, base], message: `Merge branch '${p.baseRef}' into ${p.headRef}` });
      setBranch(c, hr, p.headRef, made.sha);
    },

    async autoMerge(ref, number, method) {
      checkRepo(ref);
      checkNumber(number);
      if (method !== null && !["merge", "squash", "rebase"].includes(method)) throw invalid("not a merge method");
      c.enter("pulls.autoMerge", { act: "write", need: "autoMerge", graphql: true });
      const r = c.repo(ref, "write");
      const i = pullAt(r, number);
      if (method !== null && !r.features.autoMerge) throw invalid("auto-merge is not allowed for this repository");
      if (i.state !== "open") throw invalid("the pull request is closed");
      i.pull.autoMerge = method;
      event(r, i, method ? "auto_merge_enabled" : "auto_merge_disabled");
      return out(r, i);
    },

    async revert(ref, number, input = {}) {
      checkRepo(ref);
      checkNumber(number);
      if (input.title !== undefined) checkTitle(input.title);
      if (input.body !== undefined) checkBody(input.body);
      c.enter("pulls.revert", { act: "write", need: "revertPullRequest", graphql: true });
      const r = c.repo(ref, "write");
      const i = pullAt(r, number);
      const p = i.pull;
      if (!p.merged || !p.mergeCommit || !p.mergedBase) throw invalid("only a merged pull request is reverted");
      const baseHead = r.branches.get(p.baseRef);
      if (!baseHead) throw invalid("the base branch is gone");
      const before = b.flat(p.mergedBase);
      const after = b.flat(p.mergeCommit);
      const flat: Flat = b.flat(baseHead);
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        const x = before.get(path);
        const y = after.get(path);
        if (x?.sha === y?.sha && x?.mode === y?.mode) continue;
        if (flat.get(path)?.sha !== y?.sha) throw new GitBackendError("conflict", "the revert does not apply cleanly");
        if (x) flat.set(path, x);
        else flat.delete(path);
      }
      let branch = `revert-${number}-${p.headRef}`.slice(0, 200);
      for (let n = 2; r.branches.has(branch); n++) branch = `revert-${number}-${p.headRef}-${n}`.slice(0, 200);
      const made = await makeCommit(c, { flat, parents: [baseHead], message: `Revert "${i.title}"\n\nThis reverts commit ${p.mergeCommit}.` });
      setBranch(c, r, branch, made.sha);
      const pull: MemPull = {
        headRepoId: r.id,
        headRef: branch,
        headSha: made.sha,
        baseRef: p.baseRef,
        draft: input.draft === true,
        merged: false,
        mergedAt: null,
        mergeCommit: null,
        mergedBase: null,
        mergedHead: null,
        maintainerCanModify: true,
        requestedReviewers: [],
        autoMerge: null,
        reviews: [],
        reviewComments: [],
      };
      const reverting = newIssue(c, r, input.title ?? `Revert "${i.title}"`, input.body ?? `Reverts ${b.ownerLogin(r)}/${r.name}#${number}`, pull) as MemIssue & { pull: MemPull };
      event(r, reverting, "opened");
      return out(r, reverting);
    },
  };

  function isForkOf(x: MemRepo, r: MemRepo): boolean {
    let cur: MemRepo | undefined = x;
    for (let n = 0; cur && n < 100; n++) {
      if (cur.parentId === r.id) return true;
      cur = cur.parentId ? b.repos.get(cur.parentId) : undefined;
    }
    return false;
  }
}

// ─── issues ───────────────────────────────────────────────────────────────

export function issueOps(c: Call): IssueOps {
  const b = c.b;

  /** A repository whose issues are on (GitHub answers 410 when they are off). */
  const withIssues = (ref: T.RepoRef, level: T.Permission, o: { archivedOk?: boolean } = {}): MemRepo => {
    const r = c.repo(ref, level, o);
    if (!r.features.issues) throw new GitBackendError("gone", "Issues are disabled for this repository");
    return r;
  };

  const triage = (r: MemRepo) => atLeast(c.permission(r), "triage");
  const mine = (i: { authorId: string }) => i.authorId !== "" && i.authorId === c.userId();

  const commentAt = (r: MemRepo, id: string) => {
    const where = b.issueComments.get(id);
    const issue = where && where.repoId === r.id ? r.issues.get(where.number) : undefined;
    const comment = issue?.comments.find((x) => x.id === id);
    if (!issue || !comment) throw notFound("no such comment");
    return { issue, comment };
  };

  const commentOut = (x: { id: string; authorId: string; body: string; createdAt: number; updatedAt: number; reactions: Map<string, Set<T.Reaction>> }): T.IssueComment => ({
    id: x.id,
    author: b.actorOf(x.authorId),
    body: x.body,
    createdAt: iso(x.createdAt),
    updatedAt: iso(x.updatedAt),
    reactions: counts(x.reactions),
  });

  const milestoneOut = (r: MemRepo, m: { number: number; title: string; description: string; state: "open" | "closed"; dueOn: string | null }): T.Milestone => {
    const issues = [...r.issues.values()].filter((i) => !i.gone && i.milestone === m.number);
    return { ...m, openIssues: issues.filter((i) => i.state === "open").length, closedIssues: issues.filter((i) => i.state === "closed").length };
  };

  const reactionsOf = (r: MemRepo, target: IssueTarget) => {
    if (target && "issue" in target) return issueAt(r, target.issue).reactions;
    if (target && "comment" in target) return commentAt(r, target.comment).comment.reactions;
    throw invalid("not a reaction target");
  };

  const checkTarget = (target: IssueTarget) => {
    if (target && "issue" in target) checkNumber(target.issue);
    else if (target && "comment" in target) checkId(target.comment, "comment id");
    else throw invalid("not a reaction target");
  };

  /** Labels as the forge keeps them: known ones by their case; unknown ones created (GitHub does
   *  so for people who may write). */
  const labelNames = (r: MemRepo, names: string[]): string[] =>
    names.map((n) => {
      const known = r.labels.get(n.toLowerCase());
      if (known) return known.name;
      r.labels.set(n.toLowerCase(), { name: n, color: "ededed", description: "" });
      return n;
    });

  const assigneeLogins = (logins: string[]): string[] =>
    logins.map((l) => {
      const who = b.accountByLogin(l);
      if (!who || who.type !== "user") throw invalid(`cannot assign ${l}`);
      return who.login;
    });

  const setLabels = (i: MemIssue, next: string[]) => {
    const before = new Set(i.labels.map((l) => l.toLowerCase()));
    const after = new Set(next.map((l) => l.toLowerCase()));
    for (const l of next) if (!before.has(l.toLowerCase())) note(c, i, "labeled", l);
    for (const l of i.labels) if (!after.has(l.toLowerCase())) note(c, i, "unlabeled", l);
    i.labels = [...new Set(next)];
  };

  const setAssignees = (i: MemIssue, next: string[]) => {
    for (const l of next) if (!i.assignees.includes(l)) note(c, i, "assigned", l);
    for (const l of i.assignees) if (!next.includes(l)) note(c, i, "unassigned", l);
    i.assignees = [...new Set(next)];
  };

  const setMilestone = (r: MemRepo, i: MemIssue, n: number | null) => {
    if (n !== null && !r.milestones.has(n)) throw invalid("no such milestone");
    if (n === i.milestone) return;
    if (i.milestone !== null) note(c, i, "demilestoned", r.milestones.get(i.milestone)?.title ?? null);
    if (n !== null) note(c, i, "milestoned", r.milestones.get(n)?.title ?? null);
    i.milestone = n;
  };

  /** An issue type of the repository's organization, as GitHub names it; a personal repository
   *  has none (GitHub's issue types are an organization's). */
  const typeName = (r: MemRepo, name: unknown): string => {
    if (typeof name !== "string" || !name.trim() || name.length > 50) throw invalid("not an issue type");
    if (b.accounts.get(r.ownerId)?.type !== "organization") throw invalid("issue types belong to organizations: this repository's owner has none");
    const known = ISSUE_TYPES.find((t) => t.toLowerCase() === name.trim().toLowerCase());
    if (!known) throw invalid(`no issue type named ${name.trim()}`);
    return known;
  };

  const plainIssue = (r: MemRepo, n: number): MemIssue => {
    const i = issueAt(r, n);
    if (i.pull) throw invalid("a pull request is not an issue here");
    return i;
  };

  const descendants = (r: MemRepo, n: number, seen = new Set<number>()): Set<number> => {
    for (const child of r.issues.get(n)?.subIssues ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants(r, child, seen);
    }
    return seen;
  };

  return {
    async list(ref, filter = {}, page) {
      checkRepo(ref);
      vp(page);
      if (filter.state !== undefined && !["open", "closed", "all"].includes(filter.state)) throw invalid("not a state");
      if (filter.creator !== undefined) checkLogin(filter.creator);
      if (filter.mentioned !== undefined) checkLogin(filter.mentioned);
      if (filter.since !== undefined && Number.isNaN(Date.parse(filter.since))) throw invalid("not a time");
      c.enter("issues.list", { act: "read", view: `${b.links.repo(ref)}/issues` });
      const r = withIssues(ref, "read");
      const state = filter.state ?? "open";
      let list = [...r.issues.values()].filter((i) => !i.gone && (filter.includePulls || !i.pull));
      if (state !== "all") list = list.filter((i) => i.state === state);
      for (const l of filter.labels ?? []) list = list.filter((i) => i.labels.some((x) => x.toLowerCase() === l.toLowerCase()));
      if (filter.milestone !== undefined) {
        const m = filter.milestone;
        list = list.filter((i) => (m === "none" ? i.milestone === null : m === "any" ? i.milestone !== null : i.milestone === m));
      }
      if (filter.assignee !== undefined) {
        const a = filter.assignee;
        list = list.filter((i) => (a === "none" ? !i.assignees.length : a === "any" ? i.assignees.length > 0 : i.assignees.some((x) => x.toLowerCase() === a.toLowerCase())));
      }
      if (filter.creator !== undefined) list = list.filter((i) => b.actorOf(i.authorId).login?.toLowerCase() === filter.creator?.toLowerCase());
      if (filter.mentioned !== undefined) {
        const at = `@${filter.mentioned.toLowerCase()}`;
        list = list.filter((i) => i.body.toLowerCase().includes(at) || i.comments.some((x) => x.body.toLowerCase().includes(at)));
      }
      if (filter.since !== undefined) {
        const since = Date.parse(filter.since) / 1000;
        list = list.filter((i) => i.updatedAt >= since);
      }
      const sort = filter.sort ?? "created";
      const key = (i: MemIssue) => (sort === "updated" ? i.updatedAt : sort === "comments" ? i.comments.length : i.createdAt) * 1e6 + i.number;
      list.sort((x, y) => ((filter.direction ?? "desc") === "asc" ? key(x) - key(y) : key(y) - key(x)));
      return pageOf(list.map((i) => issueOut(c, r, i)), page);
    },

    async get(ref, number) {
      checkRepo(ref);
      checkNumber(number);
      c.enter("issues.get", { act: "read", view: `${b.links.repo(ref)}/issues/${number}` });
      const r = c.repo(ref, "read");
      const i = issueAt(r, number);
      if (!i.pull && !r.features.issues) throw new GitBackendError("gone", "Issues are disabled for this repository");
      return issueOut(c, r, i);
    },

    async create(ref, input) {
      checkRepo(ref);
      const title = checkTitle(input?.title);
      const body = checkBody(input.body);
      const labels = input.labels?.map(checkLabelName);
      const assignees = input.assignees?.map(checkLogin);
      const milestone = input.milestone === undefined ? undefined : checkNumber(input.milestone);
      c.enter("issues.create", { act: "write" });
      const r = withIssues(ref, "read");
      if (r.archived) throw new GitBackendError("archived", "the repository is archived");
      const type = input.type === undefined ? undefined : typeName(r, input.type);
      const i = newIssue(c, r, title, body, null);
      if (triage(r)) {
        if (labels) setLabels(i, labelNames(r, labels));
        if (assignees) setAssignees(i, assigneeLogins(assignees));
        if (milestone !== undefined) setMilestone(r, i, milestone);
        if (type !== undefined) i.type = type;
      }
      return issueOut(c, r, i);
    },

    async update(ref, number, patch) {
      checkRepo(ref);
      checkNumber(number);
      if (!patch || typeof patch !== "object") throw invalid("no change");
      if (patch.title !== undefined) checkTitle(patch.title);
      if (patch.body !== undefined) checkBody(patch.body);
      if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") throw invalid("not a state");
      if (patch.stateReason !== undefined && !REASONS.has(patch.stateReason)) throw invalid("not a state reason");
      const labels = patch.labels?.map(checkLabelName);
      const assignees = patch.assignees?.map(checkLogin);
      if (patch.milestone !== undefined && patch.milestone !== null) checkNumber(patch.milestone);
      c.enter("issues.update", { act: "write" });
      const r = c.repo(ref, "read");
      const i = issueAt(r, number);
      if (!i.pull && !r.features.issues) throw new GitBackendError("gone", "Issues are disabled for this repository");
      if (r.archived) throw new GitBackendError("archived", "the repository is archived");
      const canTriage = triage(r);
      if (!canTriage && !mine(i)) throw new GitBackendError("forbidden", "only the author or a triager edits an issue");
      if (!canTriage && (labels || assignees || patch.milestone !== undefined || patch.type !== undefined)) throw new GitBackendError("forbidden", "labels, assignees, milestones and types need triage");
      const type = patch.type === undefined || patch.type === null ? patch.type : typeName(r, patch.type);
      if (patch.title !== undefined && patch.title !== i.title) {
        i.title = patch.title;
        note(c, i, "renamed", patch.title);
      }
      if (patch.body !== undefined) {
        i.body = patch.body;
        crossReference(c, r, i.number, patch.body);
      }
      if (labels) setLabels(i, labelNames(r, labels));
      if (assignees) setAssignees(i, assigneeLogins(assignees));
      if (patch.milestone !== undefined) setMilestone(r, i, patch.milestone);
      if (type !== undefined) i.type = type;
      if (patch.state === "closed" && i.state === "open") {
        if (i.pull) throw invalid("close a pull request through pulls.update");
        closeIssue(c, i, patch.stateReason && patch.stateReason !== "reopened" ? patch.stateReason : "completed");
      } else if (patch.state === "open" && i.state === "closed") {
        if (i.pull) throw invalid("reopen a pull request through pulls.update");
        i.state = "open";
        i.stateReason = "reopened";
        i.closedAt = null;
        note(c, i, "reopened");
      } else if (patch.stateReason !== undefined && i.state === "closed" && patch.stateReason !== "reopened") {
        i.stateReason = patch.stateReason;
      }
      i.updatedAt = b.now();
      return issueOut(c, r, i);
    },

    async lock(ref, number, reason) {
      checkRepo(ref);
      checkNumber(number);
      if (reason !== undefined && !LOCKS.has(reason)) throw invalid("not a lock reason");
      c.enter("issues.lock", { act: "write" });
      const r = c.repo(ref, "triage");
      const i = issueAt(r, number);
      i.locked = true;
      i.lockReason = reason ?? null;
      note(c, i, "locked", reason ?? null);
    },

    async unlock(ref, number) {
      checkRepo(ref);
      checkNumber(number);
      c.enter("issues.unlock", { act: "write" });
      const r = c.repo(ref, "triage");
      const i = issueAt(r, number);
      i.locked = false;
      i.lockReason = null;
      note(c, i, "unlocked");
    },

    async comments(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("issues.comments", { act: "read", view: `${b.links.repo(ref)}/issues/${number}` });
      const r = c.repo(ref, "read");
      return pageOf(issueAt(r, number).comments.map(commentOut), page);
    },

    async comment(ref, number, body) {
      checkRepo(ref);
      checkNumber(number);
      const said = checkBody(body, "comment", true);
      c.enter("issues.comment", { act: "write" });
      const r = c.repo(ref, "read");
      const i = issueAt(r, number);
      if (!i.pull && !r.features.issues) throw new GitBackendError("gone", "Issues are disabled for this repository");
      if (r.archived) throw new GitBackendError("archived", "the repository is archived");
      if (i.locked && !triage(r)) throw new GitBackendError("forbidden", "the conversation is locked");
      const x = { id: b.nextId(), authorId: c.userId() ?? "", body: said, createdAt: b.now(), updatedAt: b.now(), reactions: new Map<string, Set<T.Reaction>>() };
      i.comments.push(x);
      b.issueComments.set(x.id, { repoId: r.id, number });
      note(c, i, "commented");
      crossReference(c, r, number, said);
      return commentOut(x);
    },

    async editComment(ref, commentId, body) {
      checkRepo(ref);
      checkId(commentId, "comment id");
      const said = checkBody(body, "comment", true);
      c.enter("issues.editComment", { act: "write" });
      const r = c.repo(ref, "read");
      const { issue, comment } = commentAt(r, commentId);
      if (!mine(comment) && !triage(r)) throw new GitBackendError("forbidden", "only the author or a triager edits a comment");
      comment.body = said;
      comment.updatedAt = b.now();
      crossReference(c, r, issue.number, said);
      return commentOut(comment);
    },

    async deleteComment(ref, commentId) {
      checkRepo(ref);
      checkId(commentId, "comment id");
      c.enter("issues.deleteComment", { act: "write" });
      const r = c.repo(ref, "read");
      const { issue, comment } = commentAt(r, commentId);
      if (!mine(comment) && !atLeast(c.permission(r), "write")) throw new GitBackendError("forbidden", "only the author or a maintainer deletes a comment");
      issue.comments = issue.comments.filter((x) => x.id !== commentId);
      b.issueComments.delete(commentId);
    },

    async react(ref, target, reaction) {
      checkRepo(ref);
      checkTarget(target);
      const kind = checkReaction(reaction);
      c.enter("issues.react", { act: "write" });
      const r = c.repo(ref, "read");
      const map = reactionsOf(r, target);
      const me = c.me().id;
      const set = map.get(me) ?? new Set<T.Reaction>();
      set.add(kind);
      map.set(me, set);
    },

    async unreact(ref, target, reaction) {
      checkRepo(ref);
      checkTarget(target);
      const kind = checkReaction(reaction);
      c.enter("issues.unreact", { act: "write" });
      const r = c.repo(ref, "read");
      const map = reactionsOf(r, target);
      const me = c.me().id;
      map.get(me)?.delete(kind);
      if (map.get(me)?.size === 0) map.delete(me);
    },

    async labels(ref, page) {
      checkRepo(ref);
      vp(page);
      c.enter("issues.labels", { act: "read", view: `${b.links.repo(ref)}/labels` });
      const r = c.repo(ref, "read");
      return pageOf([...r.labels.values()].sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase())).map((l) => ({ ...l })), page);
    },

    async createLabel(ref, label) {
      checkRepo(ref);
      const name = checkLabelName(label?.name);
      const color = checkColor(label.color);
      const description = checkBody(label.description ?? "", "description").slice(0, 100);
      c.enter("issues.createLabel", { act: "write" });
      const r = c.repo(ref, "write");
      if (r.labels.has(name.toLowerCase())) throw new GitBackendError("conflict", "already_exists");
      const l = { name, color, description };
      r.labels.set(name.toLowerCase(), l);
      return { ...l };
    },

    async updateLabel(ref, name, patch) {
      checkRepo(ref);
      checkLabelName(name);
      if (patch.name !== undefined) checkLabelName(patch.name);
      if (patch.color !== undefined) checkColor(patch.color);
      if (patch.description !== undefined) checkBody(patch.description, "description");
      c.enter("issues.updateLabel", { act: "write" });
      const r = c.repo(ref, "write");
      const l = r.labels.get(name.toLowerCase());
      if (!l) throw notFound("no such label");
      if (patch.name !== undefined && patch.name.toLowerCase() !== name.toLowerCase() && r.labels.has(patch.name.toLowerCase())) throw new GitBackendError("conflict", "already_exists");
      const next = { name: patch.name ?? l.name, color: patch.color?.toLowerCase() ?? l.color, description: patch.description?.slice(0, 100) ?? l.description };
      r.labels.delete(name.toLowerCase());
      r.labels.set(next.name.toLowerCase(), next);
      if (next.name !== l.name) for (const i of r.issues.values()) i.labels = i.labels.map((x) => (x.toLowerCase() === l.name.toLowerCase() ? next.name : x));
      return { ...next };
    },

    async deleteLabel(ref, name) {
      checkRepo(ref);
      checkLabelName(name);
      c.enter("issues.deleteLabel", { act: "write" });
      const r = c.repo(ref, "write");
      if (!r.labels.delete(name.toLowerCase())) throw notFound("no such label");
      for (const i of r.issues.values()) i.labels = i.labels.filter((x) => x.toLowerCase() !== name.toLowerCase());
    },

    async milestones(ref, state, page) {
      checkRepo(ref);
      if (state !== undefined && !["open", "closed", "all"].includes(state)) throw invalid("not a state");
      vp(page);
      c.enter("issues.milestones", { act: "read", view: `${b.links.repo(ref)}/milestones` });
      const r = c.repo(ref, "read");
      const s = state ?? "open";
      const list = [...r.milestones.values()].filter((m) => s === "all" || m.state === s).sort((x, y) => x.number - y.number);
      return pageOf(list.map((m) => milestoneOut(r, m)), page);
    },

    async createMilestone(ref, input) {
      checkRepo(ref);
      const title = checkTitle(input?.title);
      const description = checkBody(input.description ?? "", "description");
      if (input.dueOn !== undefined && input.dueOn !== null && Number.isNaN(Date.parse(input.dueOn))) throw invalid("not a time");
      if (input.state !== undefined && input.state !== "open" && input.state !== "closed") throw invalid("not a state");
      c.enter("issues.createMilestone", { act: "write" });
      const r = c.repo(ref, "write");
      if ([...r.milestones.values()].some((m) => m.title === title)) throw new GitBackendError("conflict", "already_exists");
      const m = { number: ++r.milestoneCounter, title, description, state: input.state ?? "open", dueOn: input.dueOn ?? null };
      r.milestones.set(m.number, m);
      return milestoneOut(r, m);
    },

    async updateMilestone(ref, number, patch) {
      checkRepo(ref);
      checkNumber(number);
      if (patch.title !== undefined) checkTitle(patch.title);
      if (patch.description !== undefined) checkBody(patch.description, "description");
      if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") throw invalid("not a state");
      if (patch.dueOn !== undefined && patch.dueOn !== null && Number.isNaN(Date.parse(patch.dueOn))) throw invalid("not a time");
      c.enter("issues.updateMilestone", { act: "write" });
      const r = c.repo(ref, "write");
      const m = r.milestones.get(number);
      if (!m) throw notFound("no such milestone");
      if (patch.title !== undefined) m.title = patch.title;
      if (patch.description !== undefined) m.description = patch.description;
      if (patch.state !== undefined) m.state = patch.state;
      if (patch.dueOn !== undefined) m.dueOn = patch.dueOn;
      return milestoneOut(r, m);
    },

    async deleteMilestone(ref, number) {
      checkRepo(ref);
      checkNumber(number);
      c.enter("issues.deleteMilestone", { act: "write" });
      const r = c.repo(ref, "write");
      if (!r.milestones.delete(number)) throw notFound("no such milestone");
      for (const i of r.issues.values()) if (i.milestone === number) i.milestone = null;
    },

    async subIssues(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("issues.subIssues", { act: "read", need: "subIssues", view: `${b.links.repo(ref)}/issues/${number}` });
      const r = withIssues(ref, "read");
      const i = issueAt(r, number);
      return pageOf(i.subIssues.map((n) => r.issues.get(n)).filter((x): x is MemIssue => Boolean(x && !x.gone)).map((x) => issueOut(c, r, x)), page);
    },

    async addSubIssue(ref, parent, child) {
      checkRepo(ref);
      checkNumber(parent);
      checkNumber(child);
      c.enter("issues.addSubIssue", { act: "write", need: "subIssues" });
      const r = withIssues(ref, "triage");
      const p = plainIssue(r, parent);
      const ch = plainIssue(r, child);
      if (parent === child) throw invalid("an issue is not its own sub-issue");
      if (ch.parent !== null) throw invalid("the issue already has a parent");
      if (descendants(r, child).has(parent)) throw invalid("a sub-issue cannot contain its parent");
      p.subIssues.push(child);
      ch.parent = parent;
      p.updatedAt = b.now();
    },

    async removeSubIssue(ref, parent, child) {
      checkRepo(ref);
      checkNumber(parent);
      checkNumber(child);
      c.enter("issues.removeSubIssue", { act: "write", need: "subIssues" });
      const r = withIssues(ref, "triage");
      const p = plainIssue(r, parent);
      if (!p.subIssues.includes(child)) throw notFound("not a sub-issue of this issue");
      p.subIssues = p.subIssues.filter((n) => n !== child);
      const ch = r.issues.get(child);
      if (ch) ch.parent = null;
    },

    async blockedBy(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("issues.blockedBy", { act: "read", need: "issueDependencies", view: `${b.links.repo(ref)}/issues/${number}` });
      const r = withIssues(ref, "read");
      const i = issueAt(r, number);
      return pageOf(i.blockedBy.map((n) => r.issues.get(n)).filter((x): x is MemIssue => Boolean(x && !x.gone)).map((x) => issueOut(c, r, x)), page);
    },

    async addBlockedBy(ref, number, blocker) {
      checkRepo(ref);
      checkNumber(number);
      checkNumber(blocker);
      c.enter("issues.addBlockedBy", { act: "write", need: "issueDependencies" });
      const r = withIssues(ref, "triage");
      const i = plainIssue(r, number);
      plainIssue(r, blocker);
      if (number === blocker) throw invalid("an issue does not block itself");
      if (!i.blockedBy.includes(blocker)) i.blockedBy.push(blocker);
    },

    async removeBlockedBy(ref, number, blocker) {
      checkRepo(ref);
      checkNumber(number);
      checkNumber(blocker);
      c.enter("issues.removeBlockedBy", { act: "write", need: "issueDependencies" });
      const r = withIssues(ref, "triage");
      const i = plainIssue(r, number);
      if (!i.blockedBy.includes(blocker)) throw notFound("not a dependency of this issue");
      i.blockedBy = i.blockedBy.filter((n) => n !== blocker);
    },

    async transfer(ref, number, to) {
      checkRepo(ref);
      checkNumber(number);
      checkRepo(to);
      c.enter("issues.transfer", { act: "write", need: "transferIssue", graphql: true });
      const r = withIssues(ref, "write");
      const target = withIssues(to, "write");
      if (target.id === r.id) throw invalid("the issue is already there");
      if (target.ownerId !== r.ownerId) throw invalid("issues move between repositories of the same owner only");
      const i = plainIssue(r, number);
      const moved = newIssue(c, target, i.title, i.body, null);
      moved.authorId = i.authorId;
      moved.state = i.state;
      moved.stateReason = i.stateReason;
      moved.closedAt = i.closedAt;
      moved.createdAt = i.createdAt;
      moved.labels = i.labels.filter((l) => target.labels.has(l.toLowerCase()));
      moved.assignees = [...i.assignees];
      moved.type = i.type;
      moved.comments = i.comments.map((x) => ({ ...x }));
      for (const x of moved.comments) b.issueComments.set(x.id, { repoId: target.id, number: moved.number });
      note(c, moved, "transferred", `${b.ownerLogin(r)}/${r.name}#${number}`);
      i.gone = true;
      return issueOut(c, target, moved);
    },

    async pin(ref, number, pinned) {
      checkRepo(ref);
      checkNumber(number);
      if (typeof pinned !== "boolean") throw invalid("pinned is true or false");
      c.enter("issues.pin", { act: "write", need: "pinIssue", graphql: true });
      const r = withIssues(ref, "write");
      const i = plainIssue(r, number);
      if (pinned && !i.pinned && [...r.issues.values()].filter((x) => x.pinned && !x.gone).length >= 3) throw invalid("a repository pins 3 issues at most");
      i.pinned = pinned;
    },

    async timeline(ref, number, page) {
      checkRepo(ref);
      checkNumber(number);
      vp(page);
      c.enter("issues.timeline", { act: "read", view: `${b.links.repo(ref)}/issues/${number}` });
      const r = c.repo(ref, "read");
      const i = issueAt(r, number);
      return pageOf(i.timeline.map((e) => ({ kind: e.kind, actor: e.actorId ? b.actorOf(e.actorId) : null, createdAt: iso(e.at), subject: e.subject })), page);
    },

    async search(ref, query, page) {
      checkRepo(ref);
      if (typeof query !== "string" || query.length > 256 || /[\u0000-\u001f]/.test(query)) throw invalid("not a search");
      vp(page);
      c.enter("issues.search", { act: "read", view: `${b.links.repo(ref)}/issues` });
      const r = c.repo(ref, "read");
      let list = [...r.issues.values()].filter((i) => !i.gone);
      const words: string[] = [];
      for (const term of query.trim().split(/\s+/).filter(Boolean)) {
        const m = /^(is|label|author|state):(.+)$/i.exec(term);
        if (!m) {
          words.push(term.toLowerCase());
          continue;
        }
        const [, key, value] = m;
        const v = value.toLowerCase();
        if (key.toLowerCase() === "is" || key.toLowerCase() === "state") {
          if (v === "issue") list = list.filter((i) => !i.pull);
          else if (v === "pr") list = list.filter((i) => i.pull);
          else if (v === "open" || v === "closed") list = list.filter((i) => i.state === v);
        } else if (key.toLowerCase() === "label") list = list.filter((i) => i.labels.some((l) => l.toLowerCase() === v));
        else list = list.filter((i) => b.actorOf(i.authorId).login?.toLowerCase() === v);
      }
      list = list.filter((i) => words.every((w) => `${i.title}\n${i.body}`.toLowerCase().includes(w))).sort((x, y) => y.number - x.number);
      return pageOf(list.map((i) => issueOut(c, r, i)), page);
    },
  };
}
