// The contract every GitBackend must pass (worker/forge/gitbackend.ts). `runContract(name, make)`
// registers the cases with node:test; `make` gives a fresh harness per case:
// - a backend;
// - three people with a token each: an owner, a collaborator (given write on what the owner
//   seeds), a stranger;
// - an installation of the App on the owner's account (every repository, checks: write);
// - `seed(spec)`: a repository with files, made through the backend's own `create` and
//   `createCommit`, so the suite never reaches into a backend's internals;
// - hooks a forge has no API for, which a test double or a fake forge provides: granting a
//   permission, accepting a transfer, approving an authorization, reading the recorded webhook
//   events and signing a delivery, setting a commit status, a rate limit.
//
// Where a feature is optional the suite asks `capabilities(kind)` first: present, it must work;
// absent, the call must be `unsupported` (with a `fallbackUrl` where the forge has a page for it).
// Backends differ only where the double's header says so (path-level merges, no rename
// detection), and the cases assert only what both sides share.
//
// Run on the double by memory.test.ts. A fake GitHub answering from a double's state
// (the design's §14, "should") would run the same suite on the GitHub adapter.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GIT_ERROR_CODES, GitBackendError, type GitErrorCode } from "../../worker/forge/errors.ts";
import type { GitBackend, GitSession } from "../../worker/forge/gitbackend.ts";
import { text, utf8 } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";

export interface Person {
  login: string;
  token: string;
}

export interface RepoSpec {
  name: string;
  files?: Record<string, string | Uint8Array>;
  description?: string;
  /** Default: the owner. */
  as?: Person;
}

export interface Harness {
  backend: GitBackend;
  owner: Person;
  collaborator: Person;
  stranger: Person;
  /** The App on the owner's account: every repository, checks: write. */
  installationId: string;
  webhookSecret: string;
  /** The treeEntries limit the backend was built with (small, to test truncation). */
  treeEntries: number;
  /** The releaseAssetBytes limit the backend was built with. */
  releaseAssetBytes: number;
  now(): number;
  /** A public repository with these files on `main`; the collaborator is given write. */
  seed(spec: RepoSpec): Promise<T.RepoInfo>;
  grant(repo: T.RepoRef, login: string, permission: T.Permission): Promise<void>;
  acceptTransfer(key: T.RepoKey): Promise<void>;
  /** The person approving on the forge's authorization page: the code the callback gets. */
  authorize(url: string, login: string): Promise<{ code: string; state: string }>;
  /** The webhook events since the last call. */
  events(): T.ForgeEvent[];
  deliver(event: T.ForgeEvent): Promise<{ headers: Headers; body: Uint8Array }>;
  setStatus(repo: T.RepoRef, sha: T.ObjectId, context: string, state: T.StatusState): Promise<void>;
  limit(kind: T.CredentialKind, remaining: number, resetAt: number): void;
}

const b = (s: string) => utf8(s);
const put = (path: string, content: string | Uint8Array, executable?: boolean): T.FileChange => ({
  op: "put",
  path,
  content: typeof content === "string" ? b(content) : content,
  ...(executable ? { executable } : {}),
});

/** A rejection with this code (and a GitBackendError). */
async function refused(p: Promise<unknown>, code: GitErrorCode, check?: (e: GitBackendError) => void): Promise<GitBackendError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof GitBackendError, `expected a GitBackendError ${code}, got ${String(caught)}`);
  assert.equal((caught as GitBackendError).code, code, (caught as GitBackendError).message);
  assert.ok(GIT_ERROR_CODES.includes((caught as GitBackendError).code));
  check?.(caught as GitBackendError);
  return caught as GitBackendError;
}

/** Every key named like an email field, anywhere in a result. */
function emailKeys(v: unknown, path = "$", out: string[] = []): string[] {
  if (v instanceof Uint8Array || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) v.forEach((x, i) => emailKeys(x, `${path}[${i}]`, out));
  else {
    for (const [k, x] of Object.entries(v)) {
      if (/e-?mail/i.test(k)) out.push(`${path}.${k}`);
      emailKeys(x, `${path}.${k}`, out);
    }
  }
  return out;
}

async function all<V>(fetchPage: (page: T.PageRequest) => Promise<T.Page<V>>, perPage = 2): Promise<V[]> {
  const out: V[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 100; n++) {
    const p: T.Page<V> = await fetchPage({ cursor, perPage });
    out.push(...p.items);
    if (p.next === null) return out;
    cursor = p.next;
  }
  throw new Error("pages never end");
}

export function runContract(name: string, make: () => Promise<Harness>): void {
  const user = (h: Harness, p: Person = h.owner): GitSession => h.backend.session({ kind: "user", token: p.token });
  const anon = (h: Harness): GitSession => h.backend.session({ kind: "anonymous" });
  const inst = (h: Harness): GitSession => h.backend.session({ kind: "installation", installationId: h.installationId });
  const has = (h: Harness, kind: T.CredentialKind, cap: string): boolean => (h.backend.capabilities(kind) as ReadonlySet<string>).has(cap);

  /** One more commit on a branch. */
  const commit = async (s: GitSession, repo: T.RepoRef, branch: string, changes: T.FileChange[], message = "a change") => {
    const head = (await s.git.getBranch(repo, branch)).sha;
    return s.git.createCommit(repo, { branch, expectedHead: head, changes, message });
  };

  /** A branch from main with one commit on it. */
  const branchWith = async (s: GitSession, repo: T.RepoRef, branch: string, changes: T.FileChange[], message = "work") => {
    const main = (await s.git.getBranch(repo, "main")).sha;
    return s.git.createCommit(repo, { branch, expectedHead: null, createFrom: main, changes, message });
  };

  describe(`GitBackend contract: ${name}`, () => {
    // ─── 1. repositories ──────────────────────────────────────────────────
    describe("repositories", () => {
      it("creates a repository, with and without a first commit", async () => {
        const h = await make();
        const s = user(h);
        const empty = await s.repos.create({ name: "empty-one", visibility: "public" });
        assert.equal(empty.ref.name, "empty-one");
        assert.equal(empty.owner.login.toLowerCase(), h.owner.login.toLowerCase());
        assert.deepEqual((await s.git.commits(empty.ref)).items, []);
        const started = await s.repos.create({ name: "started", visibility: "public", autoInit: true, description: "A compendium" });
        assert.ok(started.defaultBranch);
        assert.equal(started.description, "A compendium");
        const readme = await s.repos.readme(started.ref);
        assert.ok(readme && /README/i.test(readme.path));
        assert.equal((await s.git.commits(started.ref)).items.length, 1);
      });

      it("refuses a taken name (conflict) and a bad name (invalid, before any request)", async () => {
        const h = await make();
        const s = user(h);
        await s.repos.create({ name: "taken", visibility: "public" });
        await refused(s.repos.create({ name: "taken", visibility: "public" }), "conflict");
        const before = s.cost().requests;
        for (const bad of ["", "..", "a b", "x.git", "a/b", "é"]) await refused(s.repos.create({ name: bad, visibility: "public" }), "invalid");
        assert.equal(s.cost().requests, before, "no request for a bad name");
      });

      it("gets a repository by path and, after a rename, by its id", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "before-rename", files: { "a.txt": "a\n" } });
        assert.deepEqual((await s.repos.get(r.ref)).key, r.key);
        const renamed = await s.repos.update(r.ref, { name: "after-rename" });
        assert.equal(renamed.ref.name, "after-rename");
        const byId = await s.repos.getById(r.key);
        assert.equal(byId.ref.name, "after-rename");
        assert.deepEqual(byId.key, r.key);
        // The old path: the forge redirects it, or answers not_found.
        try {
          assert.deepEqual((await s.repos.get(r.ref)).key, r.key);
        } catch (e) {
          assert.ok(e instanceof GitBackendError && e.code === "not_found");
        }
      });

      it("updates the description and the topics", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "described" });
        assert.equal((await s.repos.update(r.ref, { description: "Methods of the 2026 paper", homepage: "https://example.org/paper" })).description, "Methods of the 2026 paper");
        assert.deepEqual(await s.repos.setTopics(r.ref, ["neuroscience", "eeg"]), ["neuroscience", "eeg"]);
        assert.deepEqual((await s.repos.get(r.ref)).topics, ["neuroscience", "eeg"]);
        await refused(s.repos.setTopics(r.ref, ["Not A Topic"]), "invalid");
        await refused(user(h, h.stranger).repos.update(r.ref, { description: "defaced" }), "forbidden");
      });

      it("archives: writes are refused as archived; unarchiving restores them", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "archivable", files: { "a.txt": "a\n" } });
        assert.equal((await s.repos.update(r.ref, { archived: true })).archived, true);
        await refused(commit(s, r.ref, "main", [put("b.txt", "b\n")]), "archived");
        await refused(s.issues.create(r.ref, { title: "An issue" }), "archived");
        assert.equal((await s.repos.update(r.ref, { archived: false })).archived, false);
        await commit(s, r.ref, "main", [put("b.txt", "b\n")]);
      });

      it("sets the default branch", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "branches", files: { "a.txt": "a\n" } });
        const main = await s.git.getBranch(r.ref, "main");
        await s.git.createBranch(r.ref, "develop", main.sha);
        assert.equal((await s.repos.update(r.ref, { defaultBranch: "develop" })).defaultBranch, "develop");
        assert.equal((await s.repos.get(r.ref)).defaultBranch, "develop");
      });

      it("transfers (pending until the new owner accepts), then deletes", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "moving", files: { "a.txt": "a\n" } });
        const t = await s.repos.transfer(r.ref, { newOwner: h.stranger.login });
        assert.equal(t.status, "pending");
        await h.acceptTransfer(r.key);
        const moved = await s.repos.getById(r.key);
        assert.equal(moved.ref.owner.toLowerCase(), h.stranger.login.toLowerCase());
        const theirs = user(h, h.stranger);
        await theirs.repos.delete(moved.ref);
        await refused(theirs.repos.get(moved.ref), "not_found");
        await refused(theirs.repos.getById(r.key), "not_found");
      });

      it("generates from a template: one new commit holding the template's tree", async () => {
        const h = await make();
        const s = user(h);
        const t = await h.seed({ name: "compendium-template", files: { "README.md": "# Template\n", "env/environment.yml": "name: x\n", "CITATION.cff": "cff-version: 1.2.0\n" } });
        await commit(s, t.ref, "main", [put("LICENSE", "MIT License\n")]);
        assert.equal((await s.repos.update(t.ref, { isTemplate: true })).isTemplate, true);
        const made = await user(h, h.stranger).repos.generate(t.ref, { owner: h.stranger.login, name: "my-study", visibility: "public" });
        assert.equal(made.template?.name, "compendium-template");
        const history = await anon(h).git.commits(made.ref);
        assert.equal(history.items.length, 1);
        assert.deepEqual(history.items[0].parents, []);
        const templateHead = (await s.git.commits(t.ref)).items[0];
        assert.equal(history.items[0].tree, templateHead.tree);
        await refused(s.repos.generate((await h.seed({ name: "not-a-template" })).ref, { owner: h.owner.login, name: "nope", visibility: "public" }), "invalid");
      });

      it("forks: the parent is set and the commits are the same", async () => {
        const h = await make();
        const r = await h.seed({ name: "upstream", files: { "a.txt": "a\n" } });
        const { repo: fork } = await user(h, h.stranger).repos.fork(r.ref);
        assert.equal(fork.parent?.name, "upstream");
        assert.equal(fork.ref.owner.toLowerCase(), h.stranger.login.toLowerCase());
        const s = user(h);
        assert.equal(await s.git.resolve(fork.ref, "main"), await s.git.resolve(r.ref, "main"));
      });

      it("says each person's permission", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "permissions" });
        assert.equal(await s.repos.permission(r.ref, h.owner.login), "admin");
        assert.equal(await s.repos.permission(r.ref, h.collaborator.login), "write");
        assert.equal(await s.repos.permission(r.ref, h.stranger.login), "read");
        assert.equal((await user(h, h.collaborator).repos.get(r.ref)).permission, "write");
        await refused(anon(h).repos.permission(r.ref, h.owner.login), "unauthorized");
      });

      it("refuses writes from anonymous sessions (unauthorized) and from installations (forbidden)", async () => {
        const h = await make();
        const r = await h.seed({ name: "guarded" });
        const a = anon(h);
        await refused(a.repos.create({ name: "anonymous-repo", visibility: "public" }), "unauthorized");
        await refused(a.repos.update(r.ref, { description: "x" }), "unauthorized");
        assert.equal(a.cost().requests, 0);
        await refused(inst(h).repos.create({ name: "app-repo", visibility: "public" }), "forbidden");
        await refused(inst(h).repos.update(r.ref, { description: "x" }), "forbidden", (e) => assert.match(e.message, /only post check runs/));
        await refused(user(h).repos.importRepository({ source: { kind: "git", url: "https://example.org/x.git" }, owner: h.owner.login, name: "imported", visibility: "public" }), "unsupported", (e) => assert.ok(e.fallbackUrl));
      });
    });

    // ─── 2. refs ──────────────────────────────────────────────────────────
    describe("refs", () => {
      it("creates, renames and deletes branches; the default branch follows a rename", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "refs", files: { "a.txt": "a\n" } });
        const main = await s.git.getBranch(r.ref, "main");
        const feature = await s.git.createBranch(r.ref, "feature/x", main.sha);
        assert.equal(feature.sha, main.sha);
        await refused(s.git.createBranch(r.ref, "feature/x", main.sha), "conflict");
        const names = (await s.git.listBranches(r.ref)).items.map((x) => x.name);
        assert.ok(names.includes("feature/x") && names.includes("main"));
        const trunk = await s.git.renameBranch(r.ref, "main", "trunk");
        assert.equal(trunk.sha, main.sha);
        assert.equal((await s.repos.get(r.ref)).defaultBranch, "trunk");
        await s.git.deleteBranch(r.ref, "feature/x");
        await refused(s.git.getBranch(r.ref, "feature/x"), "not_found");
        await refused(s.git.createBranch(r.ref, "bad..name", main.sha), "invalid");
      });

      it("refuses to delete the default branch", async () => {
        const h = await make();
        const r = await h.seed({ name: "keep-main", files: { "a.txt": "a\n" } });
        await refused(user(h).git.deleteBranch(r.ref, "main"), "invalid");
      });

      it("makes lightweight and annotated tags", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "tags", files: { "a.txt": "a\n" } });
        const head = await s.git.resolve(r.ref, "main");
        const light = await s.git.createTag(r.ref, { name: "v1.0.0", sha: head });
        assert.equal(light.sha, head);
        assert.equal(light.annotation, null);
        const annotated = await s.git.createTag(r.ref, { name: "v1.0.1", sha: head, message: "The version of the paper" });
        assert.equal(annotated.sha, head);
        assert.ok(annotated.annotation && annotated.annotation.sha !== head);
        assert.equal(annotated.annotation?.message, "The version of the paper");
        const tags = (await s.git.listTags(r.ref)).items;
        assert.deepEqual(tags.map((t) => [t.name, t.sha]).sort(), [["v1.0.0", head], ["v1.0.1", head]]);
        assert.equal(await s.git.resolve(r.ref, "v1.0.1"), head);
        await refused(s.git.createTag(r.ref, { name: "v1.0.0", sha: head }), "conflict");
        await s.git.deleteTag(r.ref, "v1.0.0");
        assert.deepEqual((await s.git.listTags(r.ref)).items.map((t) => t.name), ["v1.0.1"]);
      });

      it("resolves a branch, a tag, a full id; an unknown name is not_found", async () => {
        const h = await make();
        const s = anon(h);
        const r = await h.seed({ name: "resolve", files: { "a.txt": "a\n" } });
        const head = await s.git.resolve(r.ref, "main");
        assert.match(head, /^[0-9a-f]{40}$/);
        assert.equal(await s.git.resolve(r.ref, "refs/heads/main"), head);
        assert.equal(await s.git.resolve(r.ref, head), head);
        await user(h).git.createTag(r.ref, { name: "v2", sha: head });
        assert.equal(await s.git.resolve(r.ref, "v2"), head);
        await refused(s.git.resolve(r.ref, "no-such-branch"), "not_found");
      });
    });

    // ─── 3. trees and files ───────────────────────────────────────────────
    describe("trees and files", () => {
      it("lists the root, a sub-tree, and everything recursively", async () => {
        const h = await make();
        const s = anon(h);
        const r = await h.seed({ name: "tree", files: { "README.md": "# r\n", "src/a.py": "print(1)\n", "src/lib/b.py": "x = 2\n", "data/x.csv": "a,b\n" } });
        const root = await s.git.tree(r.ref, "main");
        const top = new Map(root.entries.map((e) => [e.path, e]));
        assert.equal(top.get("src")?.type, "tree");
        assert.equal(top.get("src")?.mode, "040000");
        assert.equal(top.get("README.md")?.type, "blob");
        assert.equal(top.get("README.md")?.size, 4);
        assert.ok(!top.has("src/a.py"));
        const src = await s.git.tree(r.ref, "main", { path: "src" });
        assert.equal(src.sha, top.get("src")?.sha);
        assert.deepEqual(src.entries.map((e) => e.path).sort(), ["src/a.py", "src/lib"]);
        const deep = await s.git.tree(r.ref, "main", { recursive: true });
        const paths = deep.entries.map((e) => e.path);
        for (const p of ["README.md", "src", "src/a.py", "src/lib", "src/lib/b.py", "data/x.csv"]) assert.ok(paths.includes(p), p);
        assert.equal(deep.truncated, false);
        const under = await s.git.tree(r.ref, "main", { path: "src", recursive: true });
        assert.deepEqual(under.entries.map((e) => e.path).sort(), ["src/a.py", "src/lib", "src/lib/b.py"]);
        await refused(s.git.tree(r.ref, "main", { path: "nowhere" }), "not_found");
      });

      it("truncates a recursive listing at the forge's limit", async () => {
        const h = await make();
        const files: Record<string, string> = {};
        for (let i = 0; i < h.treeEntries + 3; i++) files[`f${String(i).padStart(3, "0")}.txt`] = `${i}\n`;
        const r = await h.seed({ name: "big-tree", files });
        const t = await anon(h).git.tree(r.ref, "main", { recursive: true });
        assert.equal(t.truncated, true);
        assert.ok(t.entries.length <= h.treeEntries);
      });

      it("reads text, binary and Git LFS pointers", async () => {
        const h = await make();
        const oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
        const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12345\n`;
        const binary = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3);
        const r = await h.seed({ name: "files", files: { "notes.md": "Methods.\n", "fig.png": binary, "data/raw.h5": pointer } });
        for (const s of [anon(h), user(h)]) {
          const t = await s.git.readFile(r.ref, "main", "notes.md");
          assert.equal(text(t.bytes), "Methods.\n");
          assert.equal(t.size, 9);
          assert.equal(t.binary, false);
          assert.equal(t.lfs, null);
          const bin = await s.git.readFile(r.ref, "main", "fig.png");
          assert.deepEqual([...bin.bytes], [...binary]);
          assert.equal(bin.binary, true);
          const lfs = await s.git.readFile(r.ref, "main", "data/raw.h5");
          assert.deepEqual(lfs.lfs, { oid, size: 12345 });
        }
      });

      it("refuses a file over maxBytes (too_large) and a missing one (not_found)", async () => {
        const h = await make();
        const r = await h.seed({ name: "sizes", files: { "big.txt": "x".repeat(2000) } });
        const s = anon(h);
        await refused(s.git.readFile(r.ref, "main", "big.txt", { maxBytes: 1000 }), "too_large");
        assert.equal((await s.git.readFile(r.ref, "main", "big.txt", { maxBytes: 2000 })).size, 2000);
        await refused(s.git.readFile(r.ref, "main", "missing.txt"), "not_found");
        await refused(s.git.readFile(r.ref, "main", "../etc/passwd"), "invalid");
      });

      it("gives raw addresses without any request", async () => {
        const h = await make();
        const r = await h.seed({ name: "raw", files: { "a.txt": "a\n" } });
        const s = anon(h);
        const head = await s.git.resolve(r.ref, "main");
        const before = s.cost();
        const url = s.git.rawUrl(r.ref, head, "a.txt");
        assert.ok(url === null || /^https?:\/\//.test(url));
        if (has(h, "anonymous", "rawUrls")) assert.ok(url && url.includes(head) && url.endsWith("/a.txt"));
        assert.deepEqual(s.cost(), before);
        assert.throws(() => s.git.rawUrl(r.ref, "main", "a.txt"), (e: unknown) => e instanceof GitBackendError && e.code === "invalid");
      });

      it("names blobs as git does", async () => {
        const h = await make();
        const r = await h.seed({ name: "blob-ids", files: { "hello.txt": "hello world\n" } });
        const f = await anon(h).git.readFile(r.ref, "main", "hello.txt");
        assert.equal(f.sha, "3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
        const entry = (await anon(h).git.tree(r.ref, "main")).entries.find((e) => e.path === "hello.txt");
        assert.equal(entry?.sha, "3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
      });
    });

    // ─── 4. commits ───────────────────────────────────────────────────────
    describe("commits", () => {
      it("puts, deletes, moves and marks executable", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "changes", files: { "a.txt": "a\n", "old.txt": "old\n" } });
        const first = await commit(s, r.ref, "main", [put("run.sh", "#!/bin/sh\necho hi\n", true), put("a.txt", "a2\n"), { op: "delete", path: "old.txt" }]);
        assert.equal(first.branch, "main");
        let tree = new Map((await s.git.tree(r.ref, first.sha, { recursive: true })).entries.map((e) => [e.path, e]));
        assert.equal(tree.get("run.sh")?.mode, "100755");
        assert.equal(tree.get("a.txt")?.mode, "100644");
        assert.ok(!tree.has("old.txt"));
        const blob = tree.get("a.txt")?.sha;
        const second = await commit(s, r.ref, "main", [{ op: "move", from: "a.txt", to: "docs/a.txt" }]);
        assert.deepEqual(second.parents, [first.sha]);
        tree = new Map((await s.git.tree(r.ref, "main", { recursive: true })).entries.map((e) => [e.path, e]));
        assert.ok(!tree.has("a.txt"));
        assert.equal(tree.get("docs/a.txt")?.sha, blob, "a move keeps the blob");
        assert.equal(second.tree, (await s.git.tree(r.ref, "main")).sha);
      });

      it("refuses a stale head (conflict) and leaves the branch as it was", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "stale", files: { "a.txt": "a\n" } });
        const seen = await s.git.resolve(r.ref, "main");
        const moved = await commit(user(h, h.collaborator), r.ref, "main", [put("b.txt", "b\n")]);
        await refused(s.git.createCommit(r.ref, { branch: "main", expectedHead: seen, changes: [put("c.txt", "c\n")], message: "late" }), "conflict");
        assert.equal(await s.git.resolve(r.ref, "main"), moved.sha);
      });

      it("creates a branch with its first commit, an orphan commit, and a commit with two parents", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "shapes", files: { "a.txt": "a\n" } });
        const main = await s.git.resolve(r.ref, "main");
        const feature = await branchWith(s, r.ref, "feature", [put("f.txt", "f\n")]);
        assert.deepEqual(feature.parents, [main]);
        assert.equal(await s.git.resolve(r.ref, "feature"), feature.sha);
        await refused(s.git.createCommit(r.ref, { branch: "feature", expectedHead: null, createFrom: main, changes: [put("g.txt", "g\n")], message: "again" }), "conflict");
        if (has(h, "user", "orphanCommits")) {
          const wiki = await s.git.createCommit(r.ref, { branch: "wiki", expectedHead: null, parents: [], changes: [put("Home.md", "# Wiki\n")], message: "Start the wiki" });
          assert.deepEqual(wiki.parents, []);
          assert.deepEqual((await s.git.tree(r.ref, "wiki")).entries.map((e) => e.path), ["Home.md"]);
        }
        if (has(h, "user", "multiParentCommits")) {
          const mainNow = (await commit(s, r.ref, "main", [put("m.txt", "m\n")])).sha;
          const merged = await s.git.createCommit(r.ref, {
            branch: "feature",
            expectedHead: feature.sha,
            parents: [feature.sha, mainNow],
            changes: [put("m.txt", "m\n")],
            message: "Merge main, conflicts resolved in the browser",
          });
          assert.deepEqual(merged.parents, [feature.sha, mainNow]);
        }
      });

      it("refuses an empty commit unless asked, and paths with .. or .git (before any request)", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "refusals", files: { "a.txt": "a\n" } });
        const head = await s.git.resolve(r.ref, "main");
        await refused(s.git.createCommit(r.ref, { branch: "main", expectedHead: head, changes: [], message: "nothing" }), "invalid");
        const before = s.cost().requests;
        for (const path of ["../x", "a/../b", ".git/config", "src/.GIT/hooks", "", "a//b", "/abs"]) {
          await refused(s.git.createCommit(r.ref, { branch: "main", expectedHead: head, changes: [put(path, "x")], message: "bad" }), "invalid");
        }
        await refused(s.git.createCommit(r.ref, { branch: "main", expectedHead: head, changes: [put("a.txt", "1"), put("a.txt", "2")], message: "twice" }), "invalid");
        assert.equal(s.cost().requests, before);
        const empty = await s.git.createCommit(r.ref, { branch: "main", expectedHead: head, changes: [], message: "an empty commit", allowEmpty: true });
        assert.deepEqual(empty.parents, [head]);
      });

      it("lists commits newest first, in pages without repeats, and by path", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "history", files: { "x.txt": "0\n" } });
        const made: string[] = [];
        for (let i = 1; i <= 4; i++) made.push((await commit(s, r.ref, "main", [put(i % 2 ? "x.txt" : `y${i}.txt`, `${i}\n`)], `change ${i}`)).sha);
        const first = await s.git.commits(r.ref, {}, { perPage: 2 });
        assert.equal(first.items[0].sha, made[3]);
        assert.equal(first.items.length, 2);
        // The seed's two commits (the forge's first commit, then the files) and these four.
        const every = await all((p) => anon(h).git.commits(r.ref, {}, p));
        assert.equal(every.length, 6);
        assert.equal(new Set(every.map((c) => c.sha)).size, 6);
        const onX = await s.git.commits(r.ref, { path: "x.txt" });
        assert.deepEqual(onX.items.map((c) => c.sha), [made[2], made[0], every[4].sha]);
        assert.equal(onX.items[0].message, "change 3");
      });

      it("says what each file of a commit became", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "statuses", files: { "keep.txt": "1\n2\n3\n", "gone.txt": "g\n" } });
        const c = await commit(s, r.ref, "main", [put("new.txt", "n\n"), put("keep.txt", "1\ntwo\n3\n"), { op: "delete", path: "gone.txt" }]);
        const detail = await anon(h).git.commit(r.ref, c.sha);
        const by = new Map(detail.files.items.map((f) => [f.path, f]));
        assert.equal(by.get("new.txt")?.status, "added");
        assert.equal(by.get("keep.txt")?.status, "modified");
        assert.equal(by.get("keep.txt")?.additions, 1);
        assert.equal(by.get("keep.txt")?.deletions, 1);
        assert.match(by.get("keep.txt")?.patch ?? "", /-2\n\+two/);
        assert.equal(by.get("gone.txt")?.status, "removed");
        assert.equal(by.get("gone.txt")?.blob, null);
        assert.equal(detail.stats.additions, 2);
        assert.equal(detail.stats.deletions, 2);
      });

      it("compares: identical, ahead, behind and diverged, with the merge base", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "compare", files: { "a.txt": "a\n" } });
        const base = await s.git.resolve(r.ref, "main");
        const f = await branchWith(s, r.ref, "topic", [put("t.txt", "t\n")]);
        const a = anon(h);
        assert.equal((await a.git.compare(r.ref, "main", "main")).status, "identical");
        const ahead = await a.git.compare(r.ref, "main", "topic");
        assert.equal(ahead.status, "ahead");
        assert.equal(ahead.aheadBy, 1);
        assert.equal(ahead.mergeBase, base);
        assert.deepEqual(ahead.commits.map((c) => c.sha), [f.sha]);
        assert.deepEqual(ahead.files.items.map((x) => x.path), ["t.txt"]);
        assert.equal((await a.git.compare(r.ref, "topic", "main")).status, "behind");
        await commit(s, r.ref, "main", [put("m.txt", "m\n")]);
        const diverged = await a.git.compare(r.ref, "main", "topic");
        assert.equal(diverged.status, "diverged");
        assert.equal(diverged.aheadBy, 1);
        assert.equal(diverged.behindBy, 1);
        assert.equal(diverged.mergeBase, base);
      });

      it("gives a unified diff with the added and removed lines", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "diff", files: { "m.py": "a = 1\nb = 2\nc = 3\n" } });
        await branchWith(s, r.ref, "edit", [put("m.py", "a = 1\nb = 20\nc = 3\n")]);
        const d = await anon(h).git.diff(r.ref, "main", "edit");
        assert.match(d, /^-b = 2$/m);
        assert.match(d, /^\+b = 20$/m);
        assert.match(d, /m\.py/);
        await refused(anon(h).git.diff(r.ref, "main", "edit", { maxBytes: 10 }), "too_large");
      });

      it("never returns an email field, whatever the method", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "privacy", files: { "a.txt": "Signed-off-by: Ada <ada@example.org>\n" } });
        const c = await commit(s, r.ref, "main", [put("b.txt", "b\n")], "Change\n\nSigned-off-by: Ada <ada@example.org>");
        await s.git.createTag(r.ref, { name: "v1", sha: c.sha, message: "tag" });
        const issue = await user(h, h.stranger).issues.create(r.ref, { title: "Question", body: "mail me: someone@example.org" });
        await s.issues.comment(r.ref, issue.number, "ok");
        const f = await branchWith(s, r.ref, "f", [put("c.txt", "c\n")]);
        const pr = await s.pulls.create(r.ref, { title: "PR", head: "f", base: "main" });
        const results: unknown[] = [
          await s.repos.get(r.ref),
          await s.git.commits(r.ref),
          await s.git.commit(r.ref, c.sha),
          await s.git.compare(r.ref, "main", "f"),
          await s.git.listTags(r.ref),
          await s.git.listBranches(r.ref),
          await s.issues.get(r.ref, issue.number),
          await s.issues.comments(r.ref, issue.number),
          await s.issues.timeline(r.ref, issue.number),
          await s.pulls.get(r.ref, pr.number),
          await s.pulls.commits(r.ref, pr.number),
          f,
          h.events(),
        ];
        if (has(h, "user", "blame")) results.push(await s.git.blame(r.ref, "main", "a.txt"));
        assert.deepEqual(emailKeys(results), []);
      });
    });

    // ─── 5. merges ────────────────────────────────────────────────────────
    describe("merges", () => {
      it("merges a branch: up to date, merged with two parents, or a conflict on the same lines", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "merges", files: { "shared.txt": "one\ntwo\nthree\n", "other.txt": "o\n" } });
        const base = await s.git.resolve(r.ref, "main");
        await s.git.createBranch(r.ref, "same", base);
        assert.deepEqual(await s.git.merge(r.ref, { base: "main", head: "same" }), { status: "up_to_date" });
        await branchWith(s, r.ref, "side", [put("side.txt", "s\n")]);
        const onMain = await commit(s, r.ref, "main", [put("other.txt", "o2\n")]);
        const merged = await s.git.merge(r.ref, { base: "main", head: "side", message: "Merge side", expectedBaseHead: onMain.sha });
        assert.equal(merged.status, "merged");
        const m = merged.status === "merged" ? merged.sha : "";
        const detail = await s.git.commit(r.ref, m);
        assert.equal(detail.parents.length, 2);
        assert.equal(detail.parents[0], onMain.sha);
        const files = new Set((await s.git.tree(r.ref, "main")).entries.map((e) => e.path));
        assert.ok(files.has("side.txt") && files.has("other.txt"));
        await refused(s.git.merge(r.ref, { base: "main", head: "side", expectedBaseHead: onMain.sha }), "conflict");
        await branchWith(s, r.ref, "clash", [put("shared.txt", "one\nTWO (theirs)\nthree\n")]);
        await commit(s, r.ref, "main", [put("shared.txt", "one\nTWO (ours)\nthree\n")]);
        await refused(s.git.merge(r.ref, { base: "main", head: "clash" }), "conflict");
      });
    });

    // ─── 6. blame and search ──────────────────────────────────────────────
    describe("blame and search", () => {
      it("blames every line once, naming the right commits; unsupported with a fallback where absent", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "blame", files: { "m.py": "a = 1\nb = 2\nc = 3\n" } });
        const first = await s.git.resolve(r.ref, "main");
        const second = (await commit(s, r.ref, "main", [put("m.py", "a = 1\nb = 20\nc = 3\nd = 4\n")])).sha;
        for (const [session, kind] of [[s, "user"], [anon(h), "anonymous"]] as const) {
          if (has(h, kind, "blame")) {
            const ranges = await session.git.blame(r.ref, "main", "m.py");
            const owner: string[] = [];
            for (const x of ranges) for (let l = x.startLine; l <= x.endLine; l++) {
              assert.equal(owner[l - 1], undefined, `line ${l} twice`);
              owner[l - 1] = x.commit.sha;
            }
            assert.deepEqual(owner, [first, second, first, second]);
          } else {
            await refused(session.git.blame(r.ref, "main", "m.py"), "unsupported", (e) => assert.ok(e.fallbackUrl));
          }
        }
      });

      it("searches code; unsupported with a fallback where absent", async () => {
        const h = await make();
        const r = await h.seed({ name: "search", files: { "a.py": "def fit_model(x):\n    return x\n", "b.py": "print('hello')\n" } });
        for (const [session, kind] of [[user(h), "user"], [anon(h), "anonymous"]] as const) {
          if (has(h, kind, "searchCode")) {
            const hits = await session.git.search(r.ref, "fit_model");
            assert.deepEqual(hits.items.map((x) => x.path), ["a.py"]);
            assert.ok(hits.items[0].fragments.some((f) => f.includes("fit_model")));
          } else {
            await refused(session.git.search(r.ref, "fit_model"), "unsupported", (e) => assert.ok(e.fallbackUrl));
          }
        }
      });
    });

    // ─── 7. pull requests ─────────────────────────────────────────────────
    describe("pull requests", () => {
      it("opens pull requests numbered with the issues, and lists them by state, base and head", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "pulls", files: { "a.txt": "a\n" } });
        const issue = await s.issues.create(r.ref, { title: "First" });
        await branchWith(s, r.ref, "one", [put("one.txt", "1\n")]);
        await branchWith(s, r.ref, "two", [put("two.txt", "2\n")]);
        const p1 = await s.pulls.create(r.ref, { title: "One", head: "one", base: "main", body: "The first change" });
        const p2 = await s.pulls.create(r.ref, { title: "Two", head: "two", base: "main" });
        assert.equal(p1.number, issue.number + 1);
        assert.equal(p2.number, issue.number + 2);
        assert.equal(p1.state, "open");
        assert.equal(p1.head.ref, "one");
        assert.equal(p1.base.ref, "main");
        await refused(s.pulls.create(r.ref, { title: "Again", head: "one", base: "main" }), "conflict");
        await s.pulls.update(r.ref, p2.number, { state: "closed" });
        assert.deepEqual((await s.pulls.list(r.ref)).items.map((p) => p.number), [p1.number]);
        assert.deepEqual((await s.pulls.list(r.ref, { state: "closed" })).items.map((p) => p.number), [p2.number]);
        assert.equal((await s.pulls.list(r.ref, { state: "all" })).items.length, 2);
        assert.deepEqual((await s.pulls.list(r.ref, { state: "all", head: `${h.owner.login}:two` })).items.map((p) => p.number), [p2.number]);
        assert.equal((await s.pulls.list(r.ref, { base: "nothing-here" })).items.length, 0);
      });

      it("lists a pull request's files and commits", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "pull-files", files: { "a.txt": "a\n" } });
        const c1 = await branchWith(s, r.ref, "work", [put("x.txt", "x\n")]);
        const c2 = await commit(s, r.ref, "work", [put("a.txt", "a2\n")]);
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        assert.deepEqual((await s.pulls.commits(r.ref, pr.number)).items.map((c) => c.sha), [c1.sha, c2.sha]);
        const files = (await anon(h).pulls.files(r.ref, pr.number)).items;
        assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [["a.txt", "modified"], ["x.txt", "added"]]);
      });

      it("merges by merge commit, squash and rebase, to the same final tree", async () => {
        const h = await make();
        const s = user(h);
        for (const method of ["merge", "squash", "rebase"] as const) {
          const r = await h.seed({ name: `by-${method}`, files: { "a.txt": "a\n" } });
          const base = await s.git.resolve(r.ref, "main");
          await branchWith(s, r.ref, "work", [put("x.txt", "x\n")]);
          const head = (await commit(s, r.ref, "work", [put("y.txt", "y\n")])).sha;
          const pr = await s.pulls.create(r.ref, { title: `By ${method}`, head: "work", base: "main" });
          const { sha } = await s.pulls.merge(r.ref, pr.number, { method, expectedHead: head });
          const tip = await s.git.commit(r.ref, sha);
          assert.equal(await s.git.resolve(r.ref, "main"), sha);
          if (method === "merge") assert.deepEqual(tip.parents, [base, head]);
          if (method === "squash") assert.deepEqual(tip.parents, [base]);
          if (method === "rebase") {
            assert.equal(tip.parents.length, 1);
            assert.equal((await s.git.compare(r.ref, base, "main")).aheadBy, 2);
          }
          assert.equal(tip.tree, (await s.git.commit(r.ref, head)).tree, `${method}: the final tree`);
          const done = await s.pulls.get(r.ref, pr.number);
          assert.equal(done.merged, true);
          assert.equal(done.state, "closed");
          assert.equal(done.mergeCommit, sha);
        }
      });

      it("refuses a merge whose head moved (conflict) or whose paths clash (not_mergeable)", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "refused-merges", files: { "a.txt": "one\ntwo\n" } });
        const seen = (await branchWith(s, r.ref, "work", [put("a.txt", "one\nTWO\n")])).sha;
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        const moved = (await commit(s, r.ref, "work", [put("b.txt", "b\n")])).sha;
        await refused(s.pulls.merge(r.ref, pr.number, { method: "merge", expectedHead: seen }), "conflict");
        await commit(s, r.ref, "main", [put("a.txt", "one\n2 (main)\n")]);
        assert.equal((await s.pulls.get(r.ref, pr.number)).mergeable !== true, true);
        await refused(s.pulls.merge(r.ref, pr.number, { method: "merge", expectedHead: moved }), "not_mergeable");
        await refused(user(h, h.stranger).pulls.merge(r.ref, pr.number, { method: "merge", expectedHead: moved }), "forbidden");
      });

      it("closes and reopens; toggles the draft", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "draft", files: { "a.txt": "a\n" } });
        await branchWith(s, r.ref, "work", [put("x.txt", "x\n")]);
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main", draft: true });
        assert.equal(pr.draft, true);
        assert.equal((await s.pulls.update(r.ref, pr.number, { state: "closed" })).state, "closed");
        assert.equal((await s.pulls.update(r.ref, pr.number, { state: "open", title: "Work, again" })).title, "Work, again");
        if (has(h, "user", "draftToggle")) {
          assert.equal((await s.pulls.setDraft(r.ref, pr.number, false)).draft, false);
          assert.equal((await s.pulls.setDraft(r.ref, pr.number, true)).draft, true);
        }
        await refused(anon(h).pulls.setDraft(r.ref, pr.number, false), "unauthorized");
      });

      it("takes reviews: approval, a change request, comments on lines; threads resolve", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "reviews", files: { "m.py": "a = 1\nb = 2\n" } });
        await branchWith(s, r.ref, "work", [put("m.py", "a = 1\nb = 3\nc = 4\n")]);
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        await refused(s.pulls.review(r.ref, pr.number, { event: "APPROVE" }), "invalid");
        const peer = user(h, h.collaborator);
        const changes = await peer.pulls.review(r.ref, pr.number, {
          event: "REQUEST_CHANGES",
          body: "Section 2.3 says b = 2",
          comments: [{ path: "m.py", line: 2, body: "The paper uses b = 2" }, { path: "m.py", line: 3, body: "```suggestion\nc = 5\n```" }],
        });
        assert.equal(changes.state, "CHANGES_REQUESTED");
        const approval = await peer.pulls.review(r.ref, pr.number, { event: "APPROVE", body: "Fine now" });
        assert.equal(approval.state, "APPROVED");
        const note = await user(h, h.stranger).pulls.review(r.ref, pr.number, { event: "COMMENT", body: "A reader's note" });
        assert.equal(note.state, "COMMENTED");
        assert.deepEqual((await anon(h).pulls.reviews(r.ref, pr.number)).items.map((x) => x.state), ["CHANGES_REQUESTED", "APPROVED", "COMMENTED"]);
        const comments = (await s.pulls.comments(r.ref, pr.number)).items;
        assert.equal(comments.length, 2);
        const reply = await s.pulls.reply(r.ref, pr.number, comments[0].id, "Fixed in the next commit");
        assert.equal(reply.inReplyTo, comments[0].id);
        await refused(peer.pulls.review(r.ref, pr.number, { event: "COMMENT", comments: [{ path: "not-in-the-diff.py", line: 1, body: "?" }] }), "invalid");
        if (has(h, "user", "reviewThreads")) {
          const threads = (await s.pulls.threads(r.ref, pr.number)).items;
          assert.equal(threads.length, 2);
          const first = threads.find((t) => t.line === 2) ?? threads[0];
          assert.equal(first.comments.length, 2);
          assert.equal((await s.pulls.resolveThread(r.ref, first.id, true)).resolved, true);
          assert.equal((await s.pulls.resolveThread(r.ref, first.id, false)).resolved, false);
        }
        if (!has(h, "anonymous", "reviewThreads")) await refused(anon(h).pulls.threads(r.ref, pr.number), "unsupported", (e) => assert.ok(e.fallbackUrl));
      });

      it("requests reviewers among the collaborators", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "reviewers", files: { "a.txt": "a\n" } });
        await branchWith(s, r.ref, "work", [put("x.txt", "x\n")]);
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        const asked = await s.pulls.requestReviewers(r.ref, pr.number, [h.collaborator.login]);
        assert.deepEqual(asked.requestedReviewers.map((l) => l.toLowerCase()), [h.collaborator.login.toLowerCase()]);
        await refused(s.pulls.requestReviewers(r.ref, pr.number, [h.stranger.login]), "invalid");
        assert.deepEqual((await s.pulls.removeReviewers(r.ref, pr.number, [h.collaborator.login])).requestedReviewers, []);
      });

      it("updates a pull request's branch with its base", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "update-branch", files: { "a.txt": "a\n" } });
        const head = (await branchWith(s, r.ref, "work", [put("x.txt", "x\n")])).sha;
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        const mainNow = (await commit(s, r.ref, "main", [put("m.txt", "m\n")])).sha;
        await refused(s.pulls.updateBranch(r.ref, pr.number, mainNow), "conflict");
        await s.pulls.updateBranch(r.ref, pr.number, head);
        const updated = await s.pulls.get(r.ref, pr.number);
        assert.notEqual(updated.head.sha, head);
        assert.deepEqual((await s.git.commit(r.ref, updated.head.sha)).parents, [head, mainNow]);
      });

      it("switches auto-merge on and off", async () => {
        const h = await make();
        if (!has(h, "user", "autoMerge")) return;
        const s = user(h);
        const r = await h.seed({ name: "auto-merge", files: { "a.txt": "a\n" } });
        await s.repos.update(r.ref, { features: { autoMerge: true } });
        await branchWith(s, r.ref, "work", [put("x.txt", "x\n")]);
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        assert.equal((await s.pulls.autoMerge(r.ref, pr.number, "squash")).autoMerge, "squash");
        assert.equal((await s.pulls.autoMerge(r.ref, pr.number, null)).autoMerge, null);
      });

      it("reverts a merged pull request with a new one whose merge restores the tree", async () => {
        const h = await make();
        if (!has(h, "user", "revertPullRequest")) return;
        const s = user(h);
        const r = await h.seed({ name: "revert", files: { "a.txt": "a\n" } });
        const before = (await s.git.commit(r.ref, "main")).tree;
        const head = (await branchWith(s, r.ref, "work", [put("x.txt", "x\n"), put("a.txt", "A\n")])).sha;
        const pr = await s.pulls.create(r.ref, { title: "Work", head: "work", base: "main" });
        await s.pulls.merge(r.ref, pr.number, { method: "merge", expectedHead: head });
        const back = await s.pulls.revert(r.ref, pr.number);
        assert.notEqual(back.number, pr.number);
        assert.match(back.title, /Revert/);
        const { sha } = await s.pulls.merge(r.ref, back.number, { method: "squash", expectedHead: back.head.sha });
        assert.equal((await s.git.commit(r.ref, sha)).tree, before);
      });

      it("closes the issues a merged pull request fixes", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "fixes", files: { "a.txt": "a\n" } });
        const bug = await user(h, h.stranger).issues.create(r.ref, { title: "Wrong constant in eq. 3" });
        const other = await s.issues.create(r.ref, { title: "Unrelated" });
        const head = (await branchWith(s, r.ref, "fix", [put("a.txt", "fixed\n")])).sha;
        const pr = await s.pulls.create(r.ref, { title: "Fix the constant", head: "fix", base: "main", body: `Fixes #${bug.number}` });
        await s.pulls.merge(r.ref, pr.number, { method: "squash", expectedHead: head });
        const closed = await s.issues.get(r.ref, bug.number);
        assert.equal(closed.state, "closed");
        assert.equal(closed.stateReason, "completed");
        assert.equal((await s.issues.get(r.ref, other.number)).state, "open");
      });
    });

    // ─── 8. issues ────────────────────────────────────────────────────────
    describe("issues", () => {
      it("creates, updates, closes with a reason and reopens", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "issues" });
        const reader = user(h, h.stranger);
        const i = await reader.issues.create(r.ref, { title: "Results differ from Table 2", body: "Run with seed 42" });
        assert.equal(i.state, "open");
        assert.equal(i.author.login?.toLowerCase(), h.stranger.login.toLowerCase());
        assert.equal(i.isPullRequest, false);
        assert.equal((await reader.issues.update(r.ref, i.number, { title: "Results differ from Table 2 (seed 42)" })).title, "Results differ from Table 2 (seed 42)");
        await refused(user(h, h.collaborator).issues.create(r.ref, { title: "" }), "invalid");
        const closed = await s.issues.update(r.ref, i.number, { state: "closed", stateReason: "not_planned" });
        assert.equal(closed.state, "closed");
        assert.equal(closed.stateReason, "not_planned");
        const reopened = await s.issues.update(r.ref, i.number, { state: "open" });
        assert.equal(reopened.state, "open");
        await refused(user(h, h.collaborator).issues.update(r.ref, 9999, { title: "x" }), "not_found");
      });

      it("keeps labels and milestones, and assigns people", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "labels" });
        assert.deepEqual(await s.issues.createLabel(r.ref, { name: "reproduction", color: "0E8A16", description: "A reproduction report" }), { name: "reproduction", color: "0e8a16", description: "A reproduction report" });
        await refused(s.issues.createLabel(r.ref, { name: "reproduction", color: "000000", description: "" }), "conflict");
        assert.equal((await s.issues.updateLabel(r.ref, "reproduction", { color: "ff0000" })).color, "ff0000");
        const m = await s.issues.createMilestone(r.ref, { title: "Revision 1", dueOn: "2026-12-01T00:00:00Z" });
        const i = await s.issues.create(r.ref, { title: "Figure 3", labels: ["reproduction"], milestone: m.number, assignees: [h.collaborator.login] });
        assert.deepEqual(i.labels, ["reproduction"]);
        assert.equal(i.milestone, m.number);
        assert.deepEqual(i.assignees.map((x) => x.toLowerCase()), [h.collaborator.login.toLowerCase()]);
        assert.equal((await s.issues.milestones(r.ref)).items[0].openIssues, 1);
        assert.equal((await s.issues.updateMilestone(r.ref, m.number, { state: "closed" })).state, "closed");
        assert.deepEqual((await s.issues.list(r.ref, { labels: ["reproduction"] })).items.map((x) => x.number), [i.number]);
        assert.deepEqual((await s.issues.list(r.ref, { assignee: h.collaborator.login })).items.map((x) => x.number), [i.number]);
        await s.issues.update(r.ref, i.number, { assignees: [] });
        assert.deepEqual((await s.issues.get(r.ref, i.number)).assignees, []);
        await s.issues.deleteLabel(r.ref, "reproduction");
        assert.deepEqual((await s.issues.get(r.ref, i.number)).labels, []);
        await s.issues.deleteMilestone(r.ref, m.number);
        assert.equal((await s.issues.get(r.ref, i.number)).milestone, null);
        await refused(user(h, h.stranger).issues.createLabel(r.ref, { name: "spam", color: "000000", description: "" }), "forbidden");
      });

      it("takes comments, edits and deletions, reactions and their removal", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "comments" });
        const i = await s.issues.create(r.ref, { title: "Discussion" });
        const reader = user(h, h.stranger);
        const c = await reader.issues.comment(r.ref, i.number, "Which version of the data?");
        assert.equal((await reader.issues.editComment(r.ref, c.id, "Which version of the dataset?")).body, "Which version of the dataset?");
        const answer = await s.issues.comment(r.ref, i.number, "Version 2 of the dataset.");
        await refused(reader.issues.editComment(r.ref, answer.id, "rewritten"), "forbidden");
        await s.issues.react(r.ref, { issue: i.number }, "+1");
        await reader.issues.react(r.ref, { issue: i.number }, "+1");
        await reader.issues.react(r.ref, { comment: c.id }, "heart");
        assert.deepEqual((await s.issues.get(r.ref, i.number)).reactions, { "+1": 2 });
        assert.deepEqual((await s.issues.comments(r.ref, i.number)).items[0].reactions, { heart: 1 });
        await reader.issues.unreact(r.ref, { issue: i.number }, "+1");
        assert.deepEqual((await s.issues.get(r.ref, i.number)).reactions, { "+1": 1 });
        assert.equal((await s.issues.get(r.ref, i.number)).comments, 2);
        await reader.issues.deleteComment(r.ref, c.id);
        assert.deepEqual((await s.issues.comments(r.ref, i.number)).items.map((x) => x.id), [answer.id]);
      });

      it("locks and unlocks a conversation", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "locks" });
        const i = await s.issues.create(r.ref, { title: "Heated" });
        await s.issues.lock(r.ref, i.number, "too heated");
        const locked = await s.issues.get(r.ref, i.number);
        assert.equal(locked.locked, true);
        assert.equal(locked.lockReason, "too heated");
        await refused(user(h, h.stranger).issues.comment(r.ref, i.number, "but"), "forbidden");
        await s.issues.comment(r.ref, i.number, "Locked for now.");
        await s.issues.unlock(r.ref, i.number);
        await user(h, h.stranger).issues.comment(r.ref, i.number, "Thanks");
      });

      it("links sub-issues and dependencies", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "tracking" });
        const parent = await s.issues.create(r.ref, { title: "Reproduce the paper" });
        const a = await s.issues.create(r.ref, { title: "Figure 1" });
        const bb = await s.issues.create(r.ref, { title: "Figure 2" });
        if (has(h, "user", "subIssues")) {
          await s.issues.addSubIssue(r.ref, parent.number, a.number);
          await s.issues.addSubIssue(r.ref, parent.number, bb.number);
          await refused(s.issues.addSubIssue(r.ref, a.number, parent.number), "invalid");
          await s.issues.update(r.ref, a.number, { state: "closed" });
          assert.deepEqual((await anon(h).issues.subIssues(r.ref, parent.number)).items.map((x) => x.number), [a.number, bb.number]);
          assert.deepEqual((await s.issues.get(r.ref, parent.number)).subIssues, { total: 2, completed: 1 });
          await s.issues.removeSubIssue(r.ref, parent.number, bb.number);
          assert.equal((await s.issues.subIssues(r.ref, parent.number)).items.length, 1);
        }
        if (has(h, "user", "issueDependencies")) {
          await s.issues.addBlockedBy(r.ref, bb.number, a.number);
          assert.deepEqual((await s.issues.blockedBy(r.ref, bb.number)).items.map((x) => x.number), [a.number]);
          await s.issues.removeBlockedBy(r.ref, bb.number, a.number);
          assert.deepEqual((await s.issues.blockedBy(r.ref, bb.number)).items, []);
        }
      });

      it("transfers an issue, which gets a new number in its new repository", async () => {
        const h = await make();
        if (!has(h, "user", "transferIssue")) return;
        const s = user(h);
        const from = await h.seed({ name: "from" });
        const to = await h.seed({ name: "to" });
        await s.issues.create(to.ref, { title: "Already there" });
        const i = await s.issues.create(from.ref, { title: "Belongs elsewhere", body: "Details" });
        const moved = await s.issues.transfer(from.ref, i.number, to.ref);
        assert.equal(moved.title, "Belongs elsewhere");
        assert.equal(moved.number, 2);
        assert.equal((await s.issues.get(to.ref, moved.number)).body, "Details");
      });

      it("pins three issues at most", async () => {
        const h = await make();
        if (!has(h, "user", "pinIssue")) return;
        const s = user(h);
        const r = await h.seed({ name: "pins" });
        const issues = [];
        for (let n = 0; n < 4; n++) issues.push(await s.issues.create(r.ref, { title: `Pinned ${n}` }));
        for (const i of issues.slice(0, 3)) await s.issues.pin(r.ref, i.number, true);
        await refused(s.issues.pin(r.ref, issues[3].number, true), "invalid");
        await s.issues.pin(r.ref, issues[0].number, false);
        await s.issues.pin(r.ref, issues[3].number, true);
      });

      it("records a cross-reference when another issue mentions #N", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "timeline" });
        const i = await s.issues.create(r.ref, { title: "Original report" });
        const other = await user(h, h.stranger).issues.create(r.ref, { title: "Same here", body: `Looks like #${i.number}` });
        const events = (await anon(h).issues.timeline(r.ref, i.number)).items;
        const x = events.find((e) => e.kind === "cross-referenced");
        assert.ok(x, "a cross-reference");
        assert.match(x?.subject ?? "", new RegExp(`#${other.number}$`));
      });

      it("lists issues without the pull requests unless asked, in pages", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "listing", files: { "a.txt": "a\n" } });
        for (let n = 0; n < 5; n++) await s.issues.create(r.ref, { title: `Issue ${n}` });
        await branchWith(s, r.ref, "work", [put("x.txt", "x\n")]);
        const pr = await s.pulls.create(r.ref, { title: "A pull request", head: "work", base: "main" });
        const issues = await all((p) => anon(h).issues.list(r.ref, {}, p));
        assert.equal(issues.length, 5);
        assert.ok(issues.every((i) => !i.isPullRequest));
        assert.equal(new Set(issues.map((i) => i.number)).size, 5);
        const both = await all((p) => anon(h).issues.list(r.ref, { includePulls: true }, p), 100);
        assert.ok(both.some((i) => i.number === pr.number && i.isPullRequest));
        assert.ok((await s.issues.search(r.ref, "Issue 3")).items.some((i) => i.title === "Issue 3"));
        await refused(anon(h).issues.list(r.ref, {}, { cursor: "https://evil.example/next" }), "invalid");
      });
    });

    // ─── 9. releases ──────────────────────────────────────────────────────
    describe("releases", () => {
      it("publishes a release with a new tag at a target, then updates it", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "releases", files: { "a.txt": "a\n" } });
        const head = await s.git.resolve(r.ref, "main");
        const rel = await s.releases.create(r.ref, { tagName: "v1.0.0", target: "main", name: "Version of the paper", body: "As submitted" });
        assert.equal(rel.tagName, "v1.0.0");
        assert.equal(rel.draft, false);
        assert.ok(rel.publishedAt);
        assert.equal(await s.git.resolve(r.ref, "v1.0.0"), head);
        assert.equal((await anon(h).releases.byTag(r.ref, "v1.0.0")).id, rel.id);
        assert.equal((await anon(h).releases.latest(r.ref))?.id, rel.id);
        assert.equal((await s.releases.update(r.ref, rel.id, { body: "As published" })).body, "As published");
        await refused(s.releases.create(r.ref, { tagName: "v1.0.0" }), "conflict");
        await refused(user(h, h.stranger).releases.create(r.ref, { tagName: "v9" }), "forbidden");
      });

      it("generates notes that name the merged pull requests", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "notes", files: { "a.txt": "a\n" } });
        await s.releases.create(r.ref, { tagName: "v1" });
        const head = (await branchWith(s, r.ref, "work", [put("x.txt", "x\n")])).sha;
        const pr = await s.pulls.create(r.ref, { title: "Add the sensitivity analysis", head: "work", base: "main" });
        await s.pulls.merge(r.ref, pr.number, { method: "merge", expectedHead: head });
        const notes = await s.releases.generateNotes(r.ref, { tagName: "v2", target: "main", previousTagName: "v1" });
        assert.match(notes.body, /Add the sensitivity analysis/);
        assert.match(notes.body, new RegExp(`/pull/${pr.number}`));
      });

      it("hides drafts from anonymous readers", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "drafts", files: { "a.txt": "a\n" } });
        const draft = await s.releases.create(r.ref, { tagName: "v0.1", draft: true });
        assert.equal(draft.draft, true);
        assert.deepEqual((await anon(h).releases.list(r.ref)).items, []);
        await refused(anon(h).releases.get(r.ref, draft.id), "not_found");
        assert.equal(await anon(h).releases.latest(r.ref), null);
        assert.equal((await s.releases.list(r.ref)).items.length, 1);
        const published = await s.releases.update(r.ref, draft.id, { draft: false });
        assert.equal(published.draft, false);
        assert.equal((await anon(h).releases.list(r.ref)).items.length, 1);
      });

      it("uploads assets: over the limit is too_large, a second name is a conflict; deletes them", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "assets", files: { "a.txt": "a\n" } });
        const rel = await s.releases.create(r.ref, { tagName: "v1" });
        await refused(
          s.releases.uploadAsset(r.ref, rel.id, { name: "huge.zip", contentType: "application/zip", size: h.releaseAssetBytes + 1, body: new Uint8Array(0) }),
          "too_large",
        );
        const data = b("x,y\n1,2\n");
        const asset = await s.releases.uploadAsset(r.ref, rel.id, { name: "results.csv", label: "Results", contentType: "text/csv", size: data.length, body: data });
        assert.equal(asset.size, data.length);
        assert.equal(asset.name, "results.csv");
        await refused(s.releases.uploadAsset(r.ref, rel.id, { name: "results.csv", contentType: "text/csv", size: data.length, body: data }), "conflict");
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(b("streamed "));
            ctrl.enqueue(b("bytes"));
            ctrl.close();
          },
        });
        await s.releases.uploadAsset(r.ref, rel.id, { name: "notes.txt", contentType: "text/plain", size: 14, body: stream });
        assert.deepEqual((await anon(h).releases.assets(r.ref, rel.id)).items.map((a) => a.name).sort(), ["notes.txt", "results.csv"]);
        await s.releases.deleteAsset(r.ref, asset.id);
        assert.deepEqual((await s.releases.assets(r.ref, rel.id)).items.map((a) => a.name), ["notes.txt"]);
      });

      it("deletes a release and keeps its tag", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "delete-release", files: { "a.txt": "a\n" } });
        const rel = await s.releases.create(r.ref, { tagName: "v1" });
        await s.releases.delete(r.ref, rel.id);
        await refused(s.releases.get(r.ref, rel.id), "not_found");
        assert.equal(await s.git.resolve(r.ref, "v1"), await s.git.resolve(r.ref, "main"));
      });
    });

    // ─── 10. checks ───────────────────────────────────────────────────────
    describe("checks", () => {
      it("lets the installation create and update a check run, and reads it back with the statuses", async () => {
        const h = await make();
        const r = await h.seed({ name: "checks", files: { "a.txt": "a\n" } });
        const head = await user(h).git.resolve(r.ref, "main");
        const app = inst(h);
        const run = await app.checks.create(r.ref, { name: "Tracing map (registry)", headSha: head, status: "in_progress", detailsUrl: "https://registry.example/maps/1" });
        assert.equal(run.status, "in_progress");
        const done = await app.checks.update(r.ref, run.id, {
          conclusion: "neutral",
          output: { title: "2 traced lines changed", summary: "Section 2.3 ↔ m.py:10-12", annotations: [{ path: "a.txt", startLine: 1, endLine: 1, level: "notice", message: "Traced by the map" }] },
        });
        assert.equal(done.status, "completed");
        assert.equal(done.conclusion, "neutral");
        assert.equal(done.output.annotations, 1);
        const runs = (await anon(h).checks.runs(r.ref, head)).items;
        assert.deepEqual(runs.map((x) => [x.id, x.conclusion]), [[run.id, "neutral"]]);
        await h.setStatus(r.ref, head, "ci/tests", "success");
        const status = await anon(h).checks.status(r.ref, "main");
        assert.equal(status.state, "success");
        assert.deepEqual(status.statuses.map((x) => x.context), ["ci/tests"]);
      });

      it("refuses check runs to user sessions and every other write to installations", async () => {
        const h = await make();
        const r = await h.seed({ name: "app-rule", files: { "a.txt": "a\n" } });
        const head = await user(h).git.resolve(r.ref, "main");
        await refused(user(h).checks.create(r.ref, { name: "Mine", headSha: head }), "forbidden");
        await refused(inst(h).issues.create(r.ref, { title: "From the App" }), "forbidden", (e) => assert.match(e.message, /only post check runs/));
        await refused(inst(h).git.createCommit(r.ref, { branch: "main", expectedHead: head, changes: [put("x", "x")], message: "x" }), "forbidden");
        await refused(anon(h).checks.create(r.ref, { name: "Anonymous", headSha: head }), "unauthorized");
        assert.equal((await inst(h).repos.get(r.ref)).key.id, r.key.id);
      });
    });

    // ─── 11. events ───────────────────────────────────────────────────────
    describe("events", () => {
      it("records the events the forge would deliver", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "events", files: { "a.txt": "a\n" } });
        h.events();
        const kinds = async (f: () => Promise<unknown>) => {
          await f();
          return h.events().map((e) => (e.kind === "ref" || e.kind === "repository" || e.kind === "pull_request" || e.kind === "release" ? `${e.kind}:${e.action}` : e.kind));
        };
        assert.deepEqual(await kinds(() => commit(s, r.ref, "main", [put("b.txt", "b\n")])), ["push"]);
        const push = await (async () => {
          await commit(s, r.ref, "main", [put("c.txt", "c\n")]);
          return h.events()[0];
        })();
        assert.equal(push.kind, "push");
        if (push.kind === "push") {
          assert.equal(push.ref, "refs/heads/main");
          assert.deepEqual(push.commits.at(-1)?.added, ["c.txt"]);
          assert.equal(push.repo.key.id, r.key.id);
        }
        const main = await s.git.resolve(r.ref, "main");
        assert.deepEqual(await kinds(() => s.git.createBranch(r.ref, "topic", main)), ["ref:created", "push"]);
        assert.deepEqual(await kinds(() => s.repos.update(r.ref, { name: "events-renamed" })), ["repository:renamed"]);
        const ref = { ...r.ref, name: "events-renamed" };
        const head = (await commit(s, ref, "topic", [put("t.txt", "t\n")])).sha;
        h.events();
        assert.deepEqual(await kinds(() => s.pulls.create(ref, { title: "Topic", head: "topic", base: "main" })), ["pull_request:opened"]);
        const merged = await kinds(() => s.pulls.merge(ref, 1, { method: "merge", expectedHead: head }));
        assert.ok(merged.includes("push") && merged.includes("pull_request:closed"), merged.join());
        const released = await kinds(() => s.releases.create(ref, { tagName: "v1" }));
        assert.ok(released.includes("release:published"), released.join());
        assert.deepEqual(await kinds(() => s.repos.update(ref, { archived: true })), ["repository:archived"]);
      });

      it("delivers signed events that verify and parse; a tampered body fails", async () => {
        const h = await make();
        const r = await h.seed({ name: "deliveries", files: { "a.txt": "a\n" } });
        await commit(user(h), r.ref, "main", [put("b.txt", "b\n")]);
        const event = h.events().find((e) => e.kind === "push");
        assert.ok(event);
        const { headers, body } = await h.deliver(event as T.ForgeEvent);
        assert.equal(await h.backend.webhooks.verify(headers, body, h.webhookSecret), true);
        assert.deepEqual(h.backend.webhooks.parse(headers, body), event);
        const tampered = body.slice();
        tampered[tampered.length - 2] ^= 1;
        assert.equal(await h.backend.webhooks.verify(headers, tampered, h.webhookSecret), false);
        assert.equal(await h.backend.webhooks.verify(headers, body, "another secret"), false);
        assert.throws(() => h.backend.webhooks.parse(headers, b("not json")), (e: unknown) => e instanceof GitBackendError && e.code === "invalid");
      });
    });

    // ─── 12. authorization ────────────────────────────────────────────────
    describe("authorization", () => {
      it("authorizes one action: the state and challenge travel, the verifier and redirect are checked, a code works once, revocation holds", async () => {
        const h = await make();
        const auth = h.backend.auth;
        assert.ok(auth);
        if (!auth) return;
        const verifier = "a-verifier-of-at-least-43-characters-0123456789abcdef";
        const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", b(verifier)))))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        const state = "state-of-this-action-0123456789";
        const redirectUri = "https://registry.example/forge/authorized/";
        const url = auth.authorizeUrl({ state, codeChallenge: challenge, redirectUri });
        const u = new URL(url);
        assert.equal(u.searchParams.get("state"), state);
        assert.equal(u.searchParams.get("code_challenge"), challenge);
        assert.equal(u.searchParams.get("code_challenge_method"), "S256");
        assert.equal(u.searchParams.get("scope"), null);
        const { code, state: back } = await h.authorize(url, h.owner.login);
        assert.equal(back, state);
        await refused(auth.exchange({ code, codeVerifier: `${verifier}-wrong`, redirectUri }), "unauthorized");
        await refused(auth.exchange({ code, codeVerifier: verifier, redirectUri: "https://elsewhere.example/cb" }), "unauthorized");
        const token = await auth.exchange({ code, codeVerifier: verifier, redirectUri });
        assert.ok(token.token);
        assert.ok(token.expiresAt === null || token.expiresAt > h.now());
        await refused(auth.exchange({ code, codeVerifier: verifier, redirectUri }), "unauthorized");
        const me = await auth.whoAmI(token.token);
        assert.equal(me.login.toLowerCase(), h.owner.login.toLowerCase());
        const s = h.backend.session({ kind: "user", token: token.token });
        await s.repos.create({ name: "authorized-action", visibility: "public" });
        await auth.revoke(token.token);
        await refused(auth.whoAmI(token.token), "unauthorized");
        await refused(s.repos.create({ name: "after-revocation", visibility: "public" }), "unauthorized");
        const installs = await auth.installations(h.owner.token);
        assert.ok(installs.items.some((i) => i.id === h.installationId));
        const repos = await auth.installationRepositories(h.owner.token, h.installationId);
        assert.ok(repos.items.some((x) => x.ref.name === "authorized-action" && x.permission === "admin"));
        assert.match(auth.installUrl(state), /installations\/new\?state=/);
      });
    });

    // ─── 13. errors and costs ─────────────────────────────────────────────
    describe("errors and costs", () => {
      it("rejects only with GitBackendErrors whose messages carry no token", async () => {
        const h = await make();
        const r = await h.seed({ name: "errors", files: { "a.txt": "a\n" } });
        const tokens = [h.owner.token, h.collaborator.token, h.stranger.token];
        const failures: Promise<unknown>[] = [
          user(h, h.stranger).repos.update(r.ref, { description: "x" }),
          user(h).repos.get({ forge: r.ref.forge, owner: h.owner.login, name: "nothing-here" }),
          user(h).git.readFile(r.ref, "main", "missing"),
          user(h).git.createCommit(r.ref, { branch: "main", expectedHead: "0".repeat(40), changes: [put("x", "x")], message: "stale" }),
          anon(h).repos.create({ name: "x", visibility: "public" }),
          h.backend.session({ kind: "user", token: "not-a-real-token-0123456789" }).repos.get(r.ref),
        ];
        for (const f of failures) {
          let caught: unknown = null;
          try {
            await f;
          } catch (e) {
            caught = e;
          }
          assert.ok(caught instanceof GitBackendError, String(caught));
          assert.ok(GIT_ERROR_CODES.includes(caught.code));
          for (const t of [...tokens, "not-a-real-token-0123456789"]) {
            assert.ok(!caught.message.includes(t), "a token in a message");
            assert.ok(!JSON.stringify({ ...caught }).includes(t), "a token in an error's fields");
          }
        }
      });

      it("says how long to wait when rate limited, with the forge's page for an anonymous reader", async () => {
        const h = await make();
        const r = await h.seed({ name: "limited", files: { "a.txt": "a\n" } });
        h.limit("anonymous", 1, h.now() + 120);
        const a = anon(h);
        await a.repos.get(r.ref);
        const e = await refused(a.repos.get(r.ref), "rate_limited");
        assert.ok(e.retryAfter !== null && e.retryAfter >= 1 && e.retryAfter <= 120);
        assert.equal(e.limit, "primary");
        assert.ok(e.fallbackUrl && e.fallbackUrl.startsWith("http"));
        await user(h).repos.get(r.ref);
      });

      it("costs one request for a commit of 1 file or of 20, and no write for reads", async () => {
        const h = await make();
        const s = user(h);
        const r = await h.seed({ name: "costs", files: { "a.txt": "a\n" } });
        let before = s.cost().requests;
        await commit(s, r.ref, "main", [put("one.txt", "1\n")]);
        const one = s.cost().requests - before - 1;
        const many: T.FileChange[] = [];
        for (let n = 0; n < 20; n++) many.push(put(`many/${n}.txt`, `${n}\n`));
        before = s.cost().requests;
        await commit(s, r.ref, "main", many);
        const twenty = s.cost().requests - before - 1;
        assert.equal(one, twenty);
        assert.ok(twenty <= 3, `${twenty} requests`);
        const reader = user(h, h.stranger);
        await reader.repos.get(r.ref);
        await reader.git.tree(r.ref, "main", { recursive: true });
        await reader.git.readFile(r.ref, "main", "a.txt");
        await reader.git.commits(r.ref);
        await reader.issues.list(r.ref);
        await reader.pulls.list(r.ref);
        await reader.releases.list(r.ref);
        assert.equal(reader.cost().writes, 0);
        assert.ok(reader.cost().requests >= 7);
      });
    });
  });
}
