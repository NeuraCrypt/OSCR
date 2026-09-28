// The contract (contract.ts) on the in-memory double, and what is the double's own: git's object
// ids, its hooks (injected failures, rate limits), its costs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitBackendError } from "../../worker/forge/errors.ts";
import { blobId, utf8 } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Harness, type Person, runContract } from "./contract.ts";
import { EMPTY_TREE, ObjectStore } from "./gitobjects.ts";
import { MemoryBackend } from "./memory.ts";

const SECRET = "memory-webhook-secret";
const TREE_ENTRIES = 8;
const ASSET_BYTES = 1024;

async function harness(): Promise<Harness> {
  const backend = new MemoryBackend({ limits: { treeEntries: TREE_ENTRIES, releaseAssetBytes: ASSET_BYTES } });
  const person = (login: string): Person => ({ login, token: backend.addUser(login).token() });
  const owner = person("ada-owner");
  const collaborator = person("bo-collaborator");
  const stranger = person("cy-stranger");
  const installationId = backend.install(owner.login);
  backend.events();
  return {
    backend,
    owner,
    collaborator,
    stranger,
    installationId,
    webhookSecret: SECRET,
    treeEntries: TREE_ENTRIES,
    releaseAssetBytes: ASSET_BYTES,
    now: () => backend.now(),
    async seed(spec) {
      const who = spec.as ?? owner;
      const s = backend.session({ kind: "user", token: who.token });
      const repo = await s.repos.create({ name: spec.name, visibility: "public", autoInit: true, description: spec.description });
      const files = Object.entries(spec.files ?? {});
      if (files.length) {
        const head = await s.git.resolve(repo.ref, "main");
        const changes: T.FileChange[] = files.map(([path, c]) => ({ op: "put", path, content: typeof c === "string" ? utf8(c) : c }));
        await s.git.createCommit(repo.ref, { branch: "main", expectedHead: head, changes, message: "Add the files" });
      }
      backend.grant(repo.ref, collaborator.login, "write");
      return s.repos.get(repo.ref);
    },
    grant: async (repo, login, permission) => backend.grant(repo, login, permission),
    acceptTransfer: async (key) => backend.acceptTransfer(key.id),
    authorize: async (url, login) => backend.authorize(url, login),
    events: () => backend.events(),
    deliver: (event) => backend.deliver(event, SECRET),
    setStatus: async (repo, sha, context, state) => backend.setStatus(repo, sha, context, state),
    limit: (kind, remaining, resetAt) => backend.limit(kind, remaining, resetAt),
  };
}

runContract("the in-memory double", harness);

describe("the in-memory double's own behaviour", () => {
  it("computes git's object ids", async () => {
    const store = new ObjectStore();
    assert.equal(await store.putTree([]), EMPTY_TREE);
    assert.equal(await store.putBlob(utf8("hello world\n")), "3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
    assert.equal(await blobId(new Uint8Array(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    // One file "hello.txt" (100644) holding "hello world\n", as `git mktree` names it; and a
    // commit of it (ids computed independently, with Python's hashlib).
    const tree = await store.putTree([{ name: "hello.txt", mode: "100644", sha: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad" }]);
    assert.equal(tree, "68aba62e560c0ebc3396e8ae9335232cd93a3f60");
    const ada = { name: "ada", login: "ada", id: "1" };
    const commit = await store.putCommit({ tree, parents: [], author: ada, committer: ada, authoredAt: 1_790_596_800, committedAt: 1_790_596_800, message: "First\n", verified: true });
    assert.equal(commit, "32181ecdc616e6e54e7f26439ea368b64c7a39c9");
    // A tree sorts "a.b" before the directory "a" (compared as "a/"), as git does.
    const dir = await store.putTree([{ name: "x", mode: "100644", sha: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad" }]);
    const mixed = await store.putTree([
      { name: "a", mode: "040000", sha: dir },
      { name: "a.b", mode: "100644", sha: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad" },
    ]);
    assert.deepEqual(store.tree(mixed)?.entries.map((e) => e.name), ["a.b", "a"]);
  });

  it("fails a method once when told, and counts nothing for anonymous raw reads", async () => {
    const h = await harness();
    const r = await h.seed({ name: "hooks", files: { "a.txt": "a\n" } });
    const b = h.backend as MemoryBackend;
    b.failNext("git.readFile", "unavailable");
    const s = b.session({ kind: "user", token: h.owner.token });
    await assert.rejects(s.git.readFile(r.ref, "main", "a.txt"), (e: unknown) => e instanceof GitBackendError && e.code === "unavailable");
    assert.equal((await s.git.readFile(r.ref, "main", "a.txt")).size, 2);
    const a = b.session({ kind: "anonymous" });
    await a.git.readFile(r.ref, "main", "a.txt");
    assert.deepEqual(a.cost(), { requests: 0, writes: 0, graphql: 0, mints: 0 });
    await a.repos.get(r.ref);
    assert.equal(a.cost().requests, 1);
  });

  it("mints an installation token once an hour, and counts the GraphQL methods", async () => {
    const h = await harness();
    const r = await h.seed({ name: "mints", files: { "a.txt": "a\n" } });
    const b = h.backend as MemoryBackend;
    const i = b.session({ kind: "installation", installationId: h.installationId });
    await i.repos.get(r.ref);
    await i.repos.get(r.ref);
    assert.deepEqual(i.cost(), { requests: 3, writes: 0, graphql: 0, mints: 1 });
    const s = b.session({ kind: "user", token: h.owner.token });
    await s.git.blame(r.ref, "main", "a.txt");
    assert.equal(s.cost().graphql, 1);
  });

  it("follows a renamed repository's old path, and refuses a suspended installation", async () => {
    const h = await harness();
    const r = await h.seed({ name: "old-name" });
    const b = h.backend as MemoryBackend;
    const s = b.session({ kind: "user", token: h.owner.token });
    await s.repos.update(r.ref, { name: "new-name" });
    assert.equal((await s.repos.get(r.ref)).ref.name, "new-name");
    (b.installations.get(h.installationId) as { suspended: boolean }).suspended = true;
    await assert.rejects(b.session({ kind: "installation", installationId: h.installationId }).repos.get(r.ref), (e: unknown) => e instanceof GitBackendError && e.code === "unauthorized");
  });
});
