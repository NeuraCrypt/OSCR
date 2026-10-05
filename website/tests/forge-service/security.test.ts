// The Security read (night phase 11, E1: worker/forge/service/security.ts):
// - GET /api/forge/security returns the dependency graph the Mac wrote (repo_deps), both snapshots,
//   with the view's summary, by a key range (never a scan);
// - a hidden or unknown repository answers 404; signed out, 401.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const HEAD = "a".repeat(40);
const CITED = "b".repeat(40);

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

async function signIn(): Promise<ForgeBrowser> {
  const b = w.browser();
  await b.signIn("github");
  return b;
}

function dep(repoId: string, snapshot: string, eco: string, name: string, o: Partial<{ version: string; req: string; scope: string; direct: number; pinned: number; sources: string; commit: string }> = {}): void {
  w.forge.sqlite
    .prepare("INSERT INTO repo_deps (forge, repo_id, snapshot, ecosystem, name, version, req, scope, direct, pinned, sources, commit_sha, computed_at) "
      + "VALUES ('memory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(repoId, snapshot, eco, name, o.version ?? "", o.req ?? "", o.scope ?? "runtime", o.direct ?? 1, o.pinned ?? 0, o.sources ?? "[]", o.commit ?? "", T0);
}

describe("GET /api/forge/security", () => {
  test("the dependency graph the Mac wrote, both snapshots, with its summary", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD }, T0 - 86_400);
    dep("101", "default", "PyPI", "numpy", { version: "1.26.0", req: "==1.26.0", pinned: 1, sources: '["requirements.txt"]' });
    dep("101", "default", "PyPI", "scipy", { req: ">=1.10", direct: 0 });
    dep("101", "default", "npm", "d3", { req: "^7", sources: '["package.json"]' });
    dep("101", "cited", "PyPI", "numpy", { version: "1.25.0", pinned: 1, commit: CITED });
    const b = await signIn();
    w.forge.reset();
    const res = await b.fetch("/api/forge/security?id=memory:101");
    assert.equal(res.status, 200);
    const j = await body(res);
    assert.equal(j.repo.name, "eeg");
    assert.equal(j.dependencies.default.length, 3);
    assert.equal(j.dependencies.cited.length, 1);
    const numpy = j.dependencies.default.find((d: Json) => d.name === "numpy");
    assert.equal(numpy.version, "1.26.0");
    assert.deepEqual(numpy.sources, ["requirements.txt"]);
    assert.equal(numpy.pinned, true);
    assert.deepEqual(j.dependencies.summary, { total: 3, direct: 2, transitive: 1, pinned: 1, ecosystems: { PyPI: 2, npm: 1 } });
    // No whole-table scan of the forge database.
    assert.deepEqual(w.forge.scans, []);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  test("an unknown repository is 404", async () => {
    const b = await signIn();
    assert.equal((await b.fetch("/api/forge/security?id=memory:999")).status, 404);
  });

  test("signed out is 401", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    assert.equal((await w.browser().fetch("/api/forge/security?id=memory:101")).status, 401);
  });

  test("a bad target is 400", async () => {
    const b = await signIn();
    assert.equal((await b.fetch("/api/forge/security")).status, 400);
  });
});
