// The test double's refs, trees, files, commits and merges; its releases and check runs
// (memory.ts). Commits are made as git makes them (gitobjects.ts); a ref update is a
// compare-and-swap on the head the caller saw, and records the events GitHub would send.

import { fileDiff } from "../../worker/forge/diff.ts";
import { GitBackendError, invalid } from "../../worker/forge/errors.ts";
import type { CheckOps, GitOps, ReleaseOps } from "../../worker/forge/gitbackend.ts";
import { escapePath } from "../../worker/forge/github/links.ts";
import { DEFAULT_DIFF_BYTES, DEFAULT_READ_BYTES } from "../../worker/forge/limits.ts";
import { fileContent, isBinary, text, utf8 } from "../../worker/forge/objects.ts";
import {
  checkBody, checkCommitInput, checkId, checkMessage, checkObjectId, checkPage, checkPath, checkRefName, checkRepo, checkRev, checkTitle,
} from "../../worker/forge/paths.ts";
import { guard } from "../../worker/forge/rules.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Flat, isTreeShaped } from "./gitobjects.ts";
import { atLeast, type Call, iso, type MemAsset, type MemCheckRun, type MemRelease, type MemRepo, pageOf } from "./memory.ts";
import { commitOut, makeCommit, mergeCommits, notFound, reachable, resolveRev, setBranch, setTag } from "./memory-core.ts";

function checkMax(v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1) throw invalid("maxBytes is a positive integer");
  return v;
}

function checkQuery(q: unknown): string {
  if (typeof q !== "string" || !q.trim() || q.length > 256 || /[\u0000-\u001f]/.test(q)) throw invalid("not a search");
  return q.trim();
}

/** A page request checked before anything is counted. */
function vp(page: T.PageRequest | undefined): void {
  const { cursor } = checkPage(page);
  if (cursor !== null && !/^\d{1,5}$/.test(cursor)) throw invalid("not a page cursor");
}

export function gitOps(c: Call): GitOps {
  const b = c.b;
  const store = b.store;
  const treeOf = (commit: T.ObjectId) => (store.commit(commit) as { tree: string }).tree;

  const changesOf = (from: T.ObjectId | null, to: T.ObjectId) => store.changes(from ? treeOf(from) : null, treeOf(to));

  return {
    async listBranches(ref, page) {
      checkRepo(ref);
      vp(page);
      c.enter("git.listBranches", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const items = [...r.branches].sort(([x], [y]) => x.localeCompare(y)).map(([name, sha]) => ({ name, sha, protected: r.protectedBranches.has(name) }));
      return pageOf(items, page);
    },

    async getBranch(ref, name) {
      checkRepo(ref);
      checkRefName(name, "branch");
      c.enter("git.getBranch", { act: "read", view: b.links.tree(ref, name) });
      const r = c.repo(ref, "read");
      const sha = r.branches.get(name);
      if (!sha) throw notFound("no such branch");
      return { name, sha, protected: r.protectedBranches.has(name) };
    },

    async createBranch(ref, name, from) {
      checkRepo(ref);
      checkRefName(name, "branch");
      checkObjectId(from);
      c.enter("git.createBranch", { act: "write" });
      const r = c.repo(ref, "write");
      if (r.branches.has(name)) throw new GitBackendError("conflict", "Reference already exists");
      const commit = store.peel(from);
      if (!commit || !reachable(b, r, commit)) throw invalid("Object does not exist");
      setBranch(c, r, name, commit);
      return { name, sha: commit, protected: false };
    },

    async renameBranch(ref, from, to) {
      checkRepo(ref);
      checkRefName(from, "branch");
      checkRefName(to, "branch");
      c.enter("git.renameBranch", { act: "write" });
      const r = c.repo(ref, "write");
      const sha = r.branches.get(from);
      if (!sha) throw notFound("no such branch");
      if (from === r.defaultBranch && !atLeast(c.permission(r), "admin")) throw new GitBackendError("forbidden", "renaming the default branch needs admin");
      if (r.branches.has(to)) throw new GitBackendError("conflict", "a branch of that name exists");
      r.branches.delete(from);
      r.branches.set(to, sha);
      if (r.protectedBranches.delete(from)) r.protectedBranches.add(to);
      if (r.defaultBranch === from) r.defaultBranch = to;
      for (const x of b.repos.values()) {
        for (const issue of x.issues.values()) {
          const p = issue.pull;
          if (!p || issue.state !== "open") continue;
          if (x.id === r.id && p.baseRef === from) p.baseRef = to;
          if (p.headRepoId === r.id && p.headRef === from) p.headRef = to;
        }
      }
      const sender = c.actor();
      const installation = b.installationFor(r);
      b.record({ kind: "ref", delivery: "", installation, action: "created", refType: "branch", ref: to, repo: b.stub(r), sender });
      b.record({ kind: "ref", delivery: "", installation, action: "deleted", refType: "branch", ref: from, repo: b.stub(r), sender });
      return { name: to, sha, protected: r.protectedBranches.has(to) };
    },

    async deleteBranch(ref, name) {
      checkRepo(ref);
      checkRefName(name, "branch");
      c.enter("git.deleteBranch", { act: "write" });
      const r = c.repo(ref, "write");
      if (name === r.defaultBranch) throw invalid("the default branch cannot be deleted");
      if (!r.branches.has(name)) throw notFound("no such branch");
      if (r.protectedBranches.has(name)) throw new GitBackendError("forbidden", "the branch is protected");
      setBranch(c, r, name, null);
      for (const x of b.repos.values()) {
        for (const issue of x.issues.values()) {
          const p = issue.pull;
          if (!p || issue.state !== "open" || p.headRepoId !== r.id || p.headRef !== name) continue;
          issue.state = "closed";
          issue.closedAt = b.now();
          b.record({ kind: "pull_request", delivery: "", installation: b.installationFor(x), action: "closed", number: issue.number, repo: b.stub(x), head: { ref: name, sha: p.headSha }, base: { ref: p.baseRef }, merged: false, sender: c.actor() });
        }
      }
    },

    async listTags(ref, page) {
      checkRepo(ref);
      vp(page);
      c.enter("git.listTags", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const items = [...r.tags].sort(([x], [y]) => x.localeCompare(y)).map(([name, sha]) => ({ name, sha: store.peel(sha) as string, annotation: null }));
      return pageOf(items, page);
    },

    async createTag(ref, input) {
      checkRepo(ref);
      checkRefName(input?.name, "tag");
      checkObjectId(input.sha);
      if (input.message !== undefined) checkMessage(input.message);
      c.enter("git.createTag", { act: "write" });
      const r = c.repo(ref, "write");
      if (r.tags.has(input.name)) throw new GitBackendError("conflict", "Reference already exists");
      const commit = store.peel(input.sha);
      if (!commit || !reachable(b, r, commit)) throw invalid("Object does not exist");
      if (input.message === undefined) {
        setTag(c, r, input.name, commit);
        return { name: input.name, sha: commit, annotation: null };
      }
      const tagger = c.actor();
      const tagSha = await store.putTag({ object: commit, name: input.name, tagger, at: b.now(), message: input.message });
      setTag(c, r, input.name, tagSha);
      return { name: input.name, sha: commit, annotation: { sha: tagSha, message: input.message, tagger } };
    },

    async deleteTag(ref, name) {
      checkRepo(ref);
      checkRefName(name, "tag");
      c.enter("git.deleteTag", { act: "write" });
      const r = c.repo(ref, "write");
      if (!r.tags.has(name)) throw notFound("no such tag");
      setTag(c, r, name, null);
    },

    async resolve(ref, rev) {
      checkRepo(ref);
      checkRev(rev);
      c.enter("git.resolve", { act: "read", view: b.links.tree(ref, rev) });
      return resolveRev(b, c.repo(ref, "read"), rev);
    },

    async tree(ref, rev, options = {}) {
      checkRepo(ref);
      checkRev(rev);
      const path = options.path === undefined ? "" : checkPath(options.path, true);
      c.enter("git.tree", { act: "read", view: b.links.tree(ref, rev, path || undefined) });
      const r = c.repo(ref, "read");
      const at = store.at(treeOf(resolveRev(b, r, rev)), path);
      if (!at) throw notFound("no such directory");
      if (at.mode !== "040000") throw invalid("not a directory");
      const entries = store.entries(at.sha, path ? `${path}/` : "", options.recursive === true);
      const truncated = options.recursive === true && entries.length > b.limits.treeEntries;
      return { sha: at.sha, entries: truncated ? entries.slice(0, b.limits.treeEntries) : entries, truncated };
    },

    async readFile(ref, rev, path, options = {}) {
      checkRepo(ref);
      checkRev(rev);
      const p = checkPath(path);
      const max = checkMax(options.maxBytes, DEFAULT_READ_BYTES);
      const view = b.links.blob(ref, rev, p);
      c.enter("git.readFile", { act: "read", view, free: c.kind === "anonymous" });
      const r = c.repo(ref, "read");
      const at = store.at(treeOf(resolveRev(b, r, rev)), p);
      if (!at) throw notFound("no such file");
      if (at.mode === "040000" || at.mode === "160000") throw invalid("not a file");
      const bytes = store.blob(at.sha)?.bytes ?? new Uint8Array();
      if (bytes.length > max) throw new GitBackendError("too_large", "the file is larger than asked", { fallbackUrl: view });
      return fileContent(p, bytes, at.sha);
    },

    rawUrl(ref, commit, path) {
      checkRepo(ref);
      checkObjectId(commit);
      const p = checkPath(path);
      if (!c.caps.has("rawUrls")) return null;
      return `${b.raw}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/${commit}/${escapePath(p)}`;
    },

    async commits(ref, filter = {}, page) {
      checkRepo(ref);
      if (filter.rev !== undefined) checkRev(filter.rev);
      const file = filter.path === undefined ? undefined : checkPath(filter.path);
      for (const t of [filter.since, filter.until]) if (t !== undefined && Number.isNaN(Date.parse(t))) throw invalid("not a time");
      vp(page);
      c.enter("git.commits", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      if (filter.rev === undefined && !r.defaultBranch) return { items: [], next: null };
      const start = resolveRev(b, r, filter.rev ?? (r.defaultBranch as string));
      const since = filter.since ? Date.parse(filter.since) / 1000 : -Infinity;
      const until = filter.until ? Date.parse(filter.until) / 1000 : Infinity;
      const login = filter.authorLogin?.toLowerCase();
      const shas = [...store.ancestors(start)]
        .sort((x, y) => store.order(y) - store.order(x))
        .filter((sha) => {
          const co = store.commit(sha);
          if (!co || co.committedAt < since || co.committedAt > until) return false;
          if (login !== undefined && co.author.login?.toLowerCase() !== login) return false;
          if (file === undefined) return true;
          const here = store.at(co.tree, file);
          const parent = co.parents[0] ? store.at(treeOf(co.parents[0]), file) : undefined;
          return (here?.sha ?? null) !== (parent?.sha ?? null);
        });
      return pageOf(shas.map((s) => commitOut(b, s)), page);
    },

    async commit(ref, sha, filesPage) {
      checkRepo(ref);
      checkRev(sha);
      vp(filesPage);
      c.enter("git.commit", { act: "read", view: b.links.commit(ref, sha) });
      const r = c.repo(ref, "read");
      const s = resolveRev(b, r, sha);
      const co = store.commit(s);
      const files = changesOf(co?.parents[0] ?? null, s);
      const additions = files.reduce((n, f) => n + f.additions, 0);
      const deletions = files.reduce((n, f) => n + f.deletions, 0);
      return { ...commitOut(b, s), stats: { additions, deletions, total: additions + deletions }, files: pageOf(files, filesPage) };
    },

    async compare(ref, base, head, filesPage) {
      checkRepo(ref);
      checkRev(base);
      checkRev(head);
      vp(filesPage);
      c.enter("git.compare", { act: "read", view: b.links.compare(ref, base, head) });
      const r = c.repo(ref, "read");
      const bs = resolveRev(b, r, base);
      const hs = resolveRev(b, r, head);
      const mb = store.mergeBase(bs, hs);
      if (!mb) throw notFound("no common ancestor");
      const ahead = store.missing(bs, hs);
      const behind = store.missing(hs, bs).length;
      const status = !ahead.length && !behind ? "identical" : !behind ? "ahead" : !ahead.length ? "behind" : "diverged";
      return {
        status,
        aheadBy: ahead.length,
        behindBy: behind,
        mergeBase: mb,
        commits: ahead.slice(0, b.limits.compareCommits).map((s) => commitOut(b, s)),
        files: pageOf(changesOf(mb, hs), filesPage),
      };
    },

    async diff(ref, base, head, options = {}) {
      checkRepo(ref);
      checkRev(base);
      checkRev(head);
      const max = checkMax(options.maxBytes, DEFAULT_DIFF_BYTES);
      const view = b.links.compare(ref, base, head);
      c.enter("git.diff", { act: "read", view });
      const r = c.repo(ref, "read");
      const bs = resolveRev(b, r, base);
      const hs = resolveRev(b, r, head);
      const mb = store.mergeBase(bs, hs);
      if (!mb) throw notFound("no common ancestor");
      const before = b.flat(mb);
      const after = b.flat(hs);
      const parts: string[] = [];
      for (const f of changesOf(mb, hs)) {
        const x = before.get(f.path);
        const y = after.get(f.path);
        const old = x ? (store.blob(x.sha)?.bytes ?? new Uint8Array()) : null;
        const now = y ? (store.blob(y.sha)?.bytes ?? new Uint8Array()) : null;
        const binary = Boolean((old && isBinary(old)) || (now && isBinary(now)));
        parts.push(fileDiff({ old: x ? f.path : null, new: y ? f.path : null }, old ? text(old) : null, now ? text(now) : null, binary));
      }
      const out = parts.join("");
      if (utf8(out).length > max) throw new GitBackendError("too_large", "the diff is larger than asked", { fallbackUrl: view });
      return out;
    },

    async blame(ref, rev, path) {
      checkRepo(ref);
      checkRev(rev);
      const p = checkPath(path);
      c.enter("git.blame", { act: "read", need: "blame", fallback: b.links.blame(ref, rev, p), graphql: true, view: b.links.blame(ref, rev, p) });
      const r = c.repo(ref, "read");
      const commit = resolveRev(b, r, rev);
      const at = store.at(treeOf(commit), p);
      if (!at || at.mode === "040000" || at.mode === "160000") throw notFound("no such file at this revision");
      return store.blame(commit, p).map((x) => ({ startLine: x.startLine, endLine: x.endLine, commit: commitOut(b, x.commit) }));
    },

    async search(ref, query, page) {
      checkRepo(ref);
      const q = checkQuery(query);
      vp(page);
      c.enter("git.search", { act: "read", need: "searchCode", fallback: b.links.search(ref, q), view: b.links.search(ref, q) });
      const r = c.repo(ref, "read");
      if (!r.defaultBranch) return { items: [], next: null };
      const needle = q.toLowerCase();
      const hits: T.CodeHit[] = [];
      for (const [path, e] of [...b.flat(r.branches.get(r.defaultBranch) as string)].sort(([x], [y]) => x.localeCompare(y))) {
        const bytes = store.blob(e.sha)?.bytes;
        if (!bytes || isBinary(bytes)) continue;
        const lines = text(bytes).split("\n").filter((l) => l.toLowerCase().includes(needle));
        if (lines.length) hits.push({ path, sha: e.sha, fragments: lines.slice(0, 3) });
      }
      return pageOf(hits, page);
    },

    async createCommit(ref, raw) {
      checkRepo(ref);
      const input = checkCommitInput(raw);
      if (input.parents?.length === 2) guard(c.kind, c.caps, "write", "multiParentCommits");
      if (input.parents?.length === 0) guard(c.kind, c.caps, "write", "orphanCommits");
      if (!input.changes.length && !input.allowEmpty) throw invalid("a commit that changes nothing");
      for (const ch of input.changes) {
        if (ch.op === "put" && ch.content.length > b.limits.blobApiBytes) throw new GitBackendError("too_large", "a file is larger than the forge's API takes");
      }
      const expected = input.expectedHead ?? input.createFrom ?? null;
      const ordinary =
        (input.parents === undefined || (input.parents.length === 1 && input.parents[0] === expected)) &&
        input.changes.every((ch) => ch.op !== "move" && !(ch.op === "put" && ch.executable));
      c.enter("git.createCommit", { act: "write", graphql: ordinary });
      const r = c.repo(ref, "write");
      const current = r.branches.get(input.branch) ?? null;
      const orphan = input.parents !== undefined && input.parents.length === 0;
      if (input.createFrom !== undefined) {
        if (current !== null) throw new GitBackendError("conflict", "Reference already exists");
        if (!store.commit(input.createFrom) || !reachable(b, r, input.createFrom)) throw invalid("Object does not exist");
      } else if (orphan) {
        if (current !== input.expectedHead) throw new GitBackendError("conflict", "the branch moved");
      } else {
        if (current === null) throw notFound("no such branch");
        if (current !== input.expectedHead) throw new GitBackendError("conflict", "the branch moved");
      }
      const parents = input.parents ?? [expected as string];
      for (const p of parents) if (!store.commit(p) || !reachable(b, r, p)) throw invalid("a parent does not exist");
      if (current !== null && !orphan && input.createFrom === undefined && !parents.includes(current)) {
        throw new GitBackendError("conflict", "not a fast forward");
      }
      if (orphan && current !== null) throw new GitBackendError("conflict", "not a fast forward");
      const baseFlat: Flat = parents.length ? b.flat(parents[0]) : new Map();
      const flat: Flat = new Map(baseFlat);
      for (const ch of input.changes) {
        if (ch.op === "put") flat.set(ch.path, { mode: ch.executable ? "100755" : "100644", sha: await store.putBlob(ch.content) });
        else if (ch.op === "delete") {
          if (!flat.delete(ch.path)) throw invalid("a path to delete does not exist");
        } else {
          const e = flat.get(ch.from);
          if (!e) throw notFound("no file to move");
          flat.delete(ch.from);
          flat.set(ch.to, e);
        }
      }
      if (!isTreeShaped(flat)) throw invalid("a file and a directory share a path");
      const tree = await store.writeFlat(flat);
      if (!input.allowEmpty && parents.length === 1 && tree === treeOf(parents[0])) throw invalid("a commit that changes nothing");
      const made = await makeCommit(c, { flat, parents, message: input.message });
      setBranch(c, r, input.branch, made.sha);
      return { sha: made.sha, tree: made.tree, branch: input.branch, parents };
    },

    async merge(ref, input) {
      checkRepo(ref);
      checkRefName(input?.base, "branch");
      checkRev(input.head);
      if (input.message !== undefined) checkMessage(input.message);
      if (input.expectedBaseHead !== undefined) checkObjectId(input.expectedBaseHead);
      c.enter("git.merge", { act: "write" });
      const r = c.repo(ref, "write");
      const baseSha = r.branches.get(input.base);
      if (!baseSha) throw notFound("no such branch");
      const headSha = resolveRev(b, r, input.head);
      if (input.expectedBaseHead !== undefined && input.expectedBaseHead !== baseSha) throw new GitBackendError("conflict", "the branch moved");
      if (store.ancestors(baseSha).has(headSha)) return { status: "up_to_date" };
      const { merged, conflicts } = mergeCommits(b, baseSha, headSha);
      if (conflicts.length) throw new GitBackendError("conflict", "Merge conflict");
      const made = await makeCommit(c, { flat: merged, parents: [baseSha, headSha], message: input.message ?? `Merge ${input.head} into ${input.base}` });
      setBranch(c, r, input.base, made.sha);
      return { status: "merged", sha: made.sha };
    },
  };
}

// ─── releases ─────────────────────────────────────────────────────────────

function checkAssetName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\u0000-\u001f/\\]/.test(name)) throw invalid("not an asset name");
  return name;
}

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const parts: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function releaseOps(c: Call): ReleaseOps {
  const b = c.b;
  const drafts = (r: MemRepo) => atLeast(c.permission(r), "write") && c.kind === "user";

  const assetOut = (r: MemRepo, rel: MemRelease, a: MemAsset): T.ReleaseAsset => ({
    id: a.id,
    name: a.name,
    label: a.label,
    contentType: a.contentType,
    size: a.size,
    downloads: 0,
    downloadUrl: `${b.links.repo(b.refOf(r))}/releases/download/${escapePath(rel.tagName)}/${encodeURIComponent(a.name)}`,
    createdAt: iso(a.createdAt),
  });

  const out = (r: MemRepo, rel: MemRelease): T.Release => ({
    id: rel.id,
    tagName: rel.tagName,
    target: rel.target,
    name: rel.name,
    body: rel.body,
    draft: rel.draft,
    prerelease: rel.prerelease,
    immutable: false,
    author: b.actorOf(rel.authorId),
    createdAt: iso(rel.createdAt),
    publishedAt: rel.publishedAt === null ? null : iso(rel.publishedAt),
    assets: rel.assets.map((a) => assetOut(r, rel, a)),
    webUrl: `${b.links.repo(b.refOf(r))}/releases/tag/${escapePath(rel.tagName)}`,
  });

  const find = (r: MemRepo, id: string): MemRelease => {
    const rel = r.releases.get(id);
    if (!rel || (rel.draft && !drafts(r))) throw notFound("no such release");
    return rel;
  };

  const releaseEvent = (r: MemRepo, rel: MemRelease, action: string) =>
    b.record({ kind: "release", delivery: "", installation: b.installationFor(r), action, repo: b.stub(r), releaseId: rel.id, tagName: rel.tagName, sender: c.actor() });

  /** The tag of a release being published: created at its target when missing. */
  const ensureTag = (r: MemRepo, rel: MemRelease) => {
    if (r.tags.has(rel.tagName)) return;
    const commit = resolveRev(b, r, rel.target || (r.defaultBranch ?? "HEAD"));
    setTag(c, r, rel.tagName, commit);
  };

  const published = (r: MemRepo) => [...r.releases.values()].filter((x) => !x.draft);

  const notes = (r: MemRepo, tagName: string, target: string | undefined, previousTagName: string | undefined, exclude: string | null) => {
    const head = r.tags.has(tagName) ? (b.store.peel(r.tags.get(tagName) as string) as string) : resolveRev(b, r, target || (r.defaultBranch ?? "HEAD"));
    let previous: string | null = null;
    if (previousTagName !== undefined) previous = resolveRev(b, r, `refs/tags/${previousTagName}`);
    else {
      const candidates = published(r)
        .filter((x) => x.id !== exclude && x.tagName !== tagName && r.tags.has(x.tagName))
        .map((x) => ({ x, sha: b.store.peel(r.tags.get(x.tagName) as string) as string }))
        .filter(({ sha }) => sha !== head && b.store.ancestors(head).has(sha))
        .sort((p, q) => (q.x.publishedAt ?? 0) - (p.x.publishedAt ?? 0));
      previous = candidates[0]?.sha ?? null;
    }
    const range = new Set(b.store.missing(previous, head));
    const repoUrl = b.links.repo(b.refOf(r));
    const lines = [...r.issues.values()]
      .filter((i) => i.pull?.merged && i.pull.mergeCommit && range.has(i.pull.mergeCommit))
      .sort((x, y) => x.number - y.number)
      .map((i) => `* ${i.title} by @${b.actorOf(i.authorId).login ?? "ghost"} in ${repoUrl}/pull/${i.number}`);
    const body = `## What's Changed\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
    return { name: tagName, body };
  };

  return {
    async list(ref, page) {
      checkRepo(ref);
      vp(page);
      c.enter("releases.list", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const items = [...r.releases.values()].filter((x) => !x.draft || drafts(r)).sort((x, y) => Number(y.id) - Number(x.id));
      return pageOf(items.map((x) => out(r, x)), page);
    },

    async get(ref, id) {
      checkRepo(ref);
      checkId(id, "release id");
      c.enter("releases.get", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      return out(r, find(r, id));
    },

    async byTag(ref, tag) {
      checkRepo(ref);
      checkRefName(tag, "tag");
      c.enter("releases.byTag", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const rel = published(r).find((x) => x.tagName === tag);
      if (!rel) throw notFound("no such release");
      return out(r, rel);
    },

    async latest(ref) {
      checkRepo(ref);
      c.enter("releases.latest", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const all = published(r);
      const chosen = all.filter((x) => x.latest === true).sort((x, y) => Number(y.id) - Number(x.id))[0]
        ?? all.filter((x) => !x.prerelease && x.latest !== false).sort((x, y) => (y.publishedAt ?? 0) - (x.publishedAt ?? 0) || Number(y.id) - Number(x.id))[0];
      return chosen ? out(r, chosen) : null;
    },

    async create(ref, input) {
      checkRepo(ref);
      checkRefName(input?.tagName, "tag");
      if (input.target !== undefined) checkRev(input.target);
      if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 256)) throw invalid("not a release name");
      const body = checkBody(input.body);
      c.enter("releases.create", { act: "write" });
      const r = c.repo(ref, "write");
      if ([...r.releases.values()].some((x) => x.tagName === input.tagName)) throw new GitBackendError("conflict", "already_exists");
      if (!r.tags.has(input.tagName)) resolveRev(b, r, input.target ?? r.defaultBranch ?? "HEAD");
      const rel: MemRelease = {
        id: b.nextId(),
        tagName: input.tagName,
        target: input.target ?? r.defaultBranch ?? "",
        name: input.name ?? input.tagName,
        body,
        draft: input.draft === true,
        prerelease: input.prerelease === true,
        latest: input.makeLatest === undefined ? null : input.makeLatest,
        authorId: c.userId() ?? "",
        createdAt: b.now(),
        publishedAt: null,
        assets: [],
      };
      if (input.generateNotes) {
        const n = notes(r, rel.tagName, input.target, undefined, rel.id);
        rel.body = rel.body ? `${rel.body}\n\n${n.body}` : n.body;
      }
      if (rel.latest === true) for (const x of r.releases.values()) x.latest = x.latest === true ? null : x.latest;
      r.releases.set(rel.id, rel);
      releaseEvent(r, rel, "created");
      if (!rel.draft) {
        ensureTag(r, rel);
        rel.publishedAt = b.now();
        releaseEvent(r, rel, "published");
      }
      return out(r, rel);
    },

    async update(ref, id, patch) {
      checkRepo(ref);
      checkId(id, "release id");
      if (patch.tagName !== undefined) checkRefName(patch.tagName, "tag");
      if (patch.target !== undefined) checkRev(patch.target);
      if (patch.body !== undefined) checkBody(patch.body);
      if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.length > 256)) throw invalid("not a release name");
      c.enter("releases.update", { act: "write" });
      const r = c.repo(ref, "write");
      const rel = find(r, id);
      if (patch.tagName !== undefined && patch.tagName !== rel.tagName) {
        if ([...r.releases.values()].some((x) => x.tagName === patch.tagName)) throw new GitBackendError("conflict", "already_exists");
        rel.tagName = patch.tagName;
      }
      if (patch.target !== undefined) rel.target = patch.target;
      if (patch.name !== undefined) rel.name = patch.name;
      if (patch.body !== undefined) rel.body = patch.body;
      if (patch.prerelease !== undefined) rel.prerelease = patch.prerelease;
      if (patch.makeLatest !== undefined) {
        if (patch.makeLatest) for (const x of r.releases.values()) x.latest = x.latest === true ? null : x.latest;
        rel.latest = patch.makeLatest;
      }
      const publishing = patch.draft === false && rel.draft;
      if (patch.draft !== undefined) rel.draft = patch.draft;
      releaseEvent(r, rel, "edited");
      if (publishing) {
        ensureTag(r, rel);
        rel.publishedAt = b.now();
        releaseEvent(r, rel, "published");
      }
      return out(r, rel);
    },

    async delete(ref, id) {
      checkRepo(ref);
      checkId(id, "release id");
      c.enter("releases.delete", { act: "write" });
      const r = c.repo(ref, "write");
      const rel = find(r, id);
      r.releases.delete(rel.id);
      for (const a of rel.assets) b.assetsById.delete(a.id);
      releaseEvent(r, rel, "deleted");
    },

    async generateNotes(ref, input) {
      checkRepo(ref);
      checkRefName(input?.tagName, "tag");
      if (input.target !== undefined) checkRev(input.target);
      if (input.previousTagName !== undefined) checkRefName(input.previousTagName, "tag");
      c.enter("releases.generateNotes", { act: "write", write: false });
      const r = c.repo(ref, "write");
      return notes(r, input.tagName, input.target, input.previousTagName, null);
    },

    async assets(ref, releaseId, page) {
      checkRepo(ref);
      checkId(releaseId, "release id");
      vp(page);
      c.enter("releases.assets", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const rel = find(r, releaseId);
      return pageOf(rel.assets.map((a) => assetOut(r, rel, a)), page);
    },

    async uploadAsset(ref, releaseId, upload) {
      checkRepo(ref);
      checkId(releaseId, "release id");
      const name = checkAssetName(upload?.name);
      const label = upload.label === undefined ? "" : checkTitle(upload.label);
      if (typeof upload.contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+/.test(upload.contentType)) throw invalid("not a content type");
      if (!Number.isInteger(upload.size) || upload.size < 1) throw invalid("an asset's size is known in advance");
      guard(c.kind, c.caps, "write", "releaseAssets", b.links.newRelease(ref));
      if (upload.size > b.limits.releaseAssetBytes) throw new GitBackendError("too_large", "the asset is larger than the forge takes", { fallbackUrl: b.links.newRelease(ref) });
      if (upload.body instanceof Uint8Array && upload.body.length !== upload.size) throw invalid("the asset's size is not its length");
      c.enter("releases.uploadAsset", { act: "write" });
      const r = c.repo(ref, "write");
      const rel = find(r, releaseId);
      if (rel.assets.some((a) => a.name === name)) throw new GitBackendError("conflict", "already_exists");
      if (rel.assets.length >= b.limits.releaseAssets) throw new GitBackendError("too_large", "the release has as many assets as the forge takes");
      const bytes = await collect(upload.body);
      if (bytes.length !== upload.size) throw invalid("the asset's size is not its length");
      const a: MemAsset = { id: b.nextId(), name, label, contentType: upload.contentType, size: bytes.length, bytes, createdAt: b.now() };
      rel.assets.push(a);
      b.assetsById.set(a.id, { repoId: r.id, releaseId: rel.id });
      return assetOut(r, rel, a);
    },

    async deleteAsset(ref, assetId) {
      checkRepo(ref);
      checkId(assetId, "asset id");
      c.enter("releases.deleteAsset", { act: "write" });
      const r = c.repo(ref, "write");
      const where = b.assetsById.get(assetId);
      const rel = where && where.repoId === r.id ? r.releases.get(where.releaseId) : undefined;
      if (!rel) throw notFound("no such asset");
      rel.assets = rel.assets.filter((a) => a.id !== assetId);
      b.assetsById.delete(assetId);
    },
  };
}

// ─── checks ───────────────────────────────────────────────────────────────

const STATUSES = new Set(["queued", "in_progress", "completed"]);
const CONCLUSIONS = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"]);

function checkRunPatch(p: T.CheckRunPatch): void {
  if (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100)) throw invalid("not a check name");
  if (p.status !== undefined && !STATUSES.has(p.status)) throw invalid("not a check status");
  if (p.conclusion !== undefined && !CONCLUSIONS.has(p.conclusion)) throw invalid("not a conclusion");
  for (const a of p.output?.annotations ?? []) {
    if (!a || typeof a.path !== "string" || !Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine) throw invalid("not an annotation");
  }
}

export function checkOps(c: Call): CheckOps {
  const b = c.b;

  const out = (run: MemCheckRun): T.CheckRun => ({
    id: run.id,
    name: run.name,
    headSha: run.headSha,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.startedAt === null ? null : iso(run.startedAt),
    completedAt: run.completedAt === null ? null : iso(run.completedAt),
    detailsUrl: run.detailsUrl,
    app: b.appSlug,
    output: { title: run.output.title, summary: run.output.summary, annotations: run.annotations.length },
  });

  const apply = (run: MemCheckRun, p: T.CheckRunPatch) => {
    if (p.name !== undefined) run.name = p.name;
    if (p.detailsUrl !== undefined) run.detailsUrl = p.detailsUrl;
    if (p.externalId !== undefined) run.externalId = p.externalId;
    if (p.status !== undefined) run.status = p.status;
    if (p.conclusion !== undefined) {
      run.conclusion = p.conclusion;
      run.status = "completed";
    }
    if (run.status !== "queued" && run.startedAt === null) run.startedAt = b.now();
    if (run.status === "completed" && run.completedAt === null) run.completedAt = b.now();
    if (p.output) {
      run.output = { title: p.output.title, summary: p.output.summary, text: p.output.text ?? run.output.text };
      run.annotations.push(...(p.output.annotations ?? []));
    }
  };

  const writable = (ref: T.RepoRef) => {
    const r = c.repo(ref, "read");
    if (!c.mayCheck(r)) throw new GitBackendError("forbidden", "the App is not installed here with checks: write");
    if (r.archived) throw new GitBackendError("archived", "the repository is archived");
    return r;
  };

  return {
    async runs(ref, rev, page) {
      checkRepo(ref);
      checkRev(rev);
      vp(page);
      c.enter("checks.runs", { act: "read", need: "checkRuns", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const sha = resolveRev(b, r, rev);
      const runs = [...r.checkRuns.values()].filter((x) => x.headSha === sha).sort((x, y) => Number(y.id) - Number(x.id));
      return pageOf(runs.map(out), page);
    },

    async create(ref, input) {
      checkRepo(ref);
      if (!input || typeof input.name !== "string") throw invalid("a check run has a name");
      checkObjectId(input.headSha);
      checkRunPatch(input);
      c.enter("checks.create", { act: "check", need: "checkRuns" });
      const r = writable(ref);
      if (!b.store.commit(input.headSha) || !reachable(b, r, input.headSha)) throw invalid("No commit found for SHA");
      const run: MemCheckRun = {
        id: b.nextId(),
        name: input.name,
        headSha: input.headSha,
        status: "queued",
        conclusion: null,
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
        externalId: null,
        output: { title: "", summary: "", text: "" },
        annotations: [],
      };
      apply(run, input);
      r.checkRuns.set(run.id, run);
      return out(run);
    },

    async update(ref, id, patch) {
      checkRepo(ref);
      checkId(id, "check run id");
      checkRunPatch(patch ?? {});
      c.enter("checks.update", { act: "check", need: "checkRuns" });
      const r = writable(ref);
      const run = r.checkRuns.get(id);
      if (!run) throw notFound("no such check run");
      apply(run, patch ?? {});
      return out(run);
    },

    async status(ref, rev) {
      checkRepo(ref);
      checkRev(rev);
      c.enter("checks.status", { act: "read", view: b.links.repo(ref) });
      const r = c.repo(ref, "read");
      const statuses = r.statuses.get(resolveRev(b, r, rev)) ?? [];
      const state: T.StatusState = !statuses.length
        ? "pending"
        : statuses.some((s) => s.state === "failure" || s.state === "error")
          ? "failure"
          : statuses.some((s) => s.state === "pending")
            ? "pending"
            : "success";
      return { state, statuses: statuses.map((s) => ({ ...s })) };
    },
  };
}
