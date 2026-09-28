// Branches as authorized actions (night phase 01, E4; act-refs.ts): created from a branch, a tag or
// a commit; renamed (the default branch's row follows; a name already there is 409); deleted,
// never the default branch (refused before any request to GitHub).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { REF_ACTIONS } from "../../worker/forge/service/act-refs.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import type { RepoRow } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeCounts } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const session = () => w.backend.session({ kind: "user", token: w.ada.token() });
const branches = (id: string) => [...(w.backend.repos.get(id)?.branches.keys() ?? [])].sort();
const row = (id: string) => w.forge.sqlite.prepare("SELECT * FROM repos WHERE repo_id = ?").get(id) as unknown as RepoRow;
const on = (id: string, kind: StartInput["kind"], payload: unknown): StartInput => ({ kind, repo: { forge: "memory", id }, payload, back: "/r/ada-fixture/eeg/branches/" });

async function known(): Promise<string> {
  const info = await session().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  await seed.repo(w.forge, { repoId: info.key.id, ownerId: info.owner.id, ownerLogin: ADA_LOGIN, name: "eeg", mode: "created", defaultBranch: "main" });
  return info.key.id;
}

describe("branches", () => {
  test("created from a branch, a tag and a commit; only the action row here", async () => {
    const b = await signIn(w);
    const id = await known();
    const head = await session().git.resolve(REF, "main");
    await session().git.createTag(REF, { name: "v1.0", sha: head });
    w.forge.reset();
    for (const [name, from] of [["from-branch", "main"], ["from-tag", "v1.0"], ["from-commit", head]]) {
      const run = await authorize(w, b, on(id, "branch_create", { name, from }));
      assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
      assert.equal(run.actBody?.result.sha, head);
    }
    assert.deepEqual(branches(id), ["from-branch", "from-commit", "from-tag", "main"]);
    assert.equal(w.forge.totals.written, 3);
    assert.equal(forgeCounts(w.forge).repos, 1);
    // Refused before GitHub: not a branch name.
    assert.equal((await authorize(w, b, on(id, "branch_create", { name: "a..b", from: "main" }))).act?.status, 400);
  });

  test("renamed: the default branch's row follows; onto a branch that exists, 409", async () => {
    const b = await signIn(w);
    const id = await known();
    await authorize(w, b, on(id, "branch_create", { name: "draft", from: "main" }));
    const run = await authorize(w, b, on(id, "branch_rename", { from: "main", to: "trunk" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.deepEqual(branches(id), ["draft", "trunk"]);
    assert.equal(row(id).default_branch, "trunk");
    assert.match(run.actBody?.result.notes[0], /stays the default branch/);
    const clash = await authorize(w, b, on(id, "branch_rename", { from: "draft", to: "trunk" }));
    assert.equal(clash.act?.status, 409);
    assert.deepEqual(branches(id), ["draft", "trunk"]);
  });

  test("deleted, never the default branch: refused before any request to GitHub", async () => {
    const b = await signIn(w);
    const id = await known();
    await authorize(w, b, on(id, "branch_create", { name: "old", from: "main" }));
    // Every session the service opens on the double: none for the default branch.
    const sessions: ReturnType<typeof w.backend.session>[] = [];
    const open = w.backend.session.bind(w.backend);
    w.backend.session = (credential) => {
      const s = open(credential);
      sessions.push(s);
      return s;
    };
    const refused = await authorize(w, b, on(id, "branch_delete", { name: "main" }));
    assert.equal(refused.act?.status, 400);
    assert.equal(refused.actBody?.error.code, "default_branch");
    assert.ok(sessions.every((s) => s.cost().requests === 0));
    assert.deepEqual(branches(id), ["main", "old"]);
    const run = await authorize(w, b, on(id, "branch_delete", { name: "old" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.deepEqual(branches(id), ["main"]);
  });

  test("the three kinds are registered", () => {
    assert.deepEqual(REF_ACTIONS.map((s) => s.kind), ["branch_create", "branch_rename", "branch_delete"]);
    for (const s of REF_ACTIONS) assert.equal(ACTIONS.get(s.kind), s);
  });
});
