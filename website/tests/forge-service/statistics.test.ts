// The repository-statistics read (night phase 12, E3: worker/forge/service/statistics.ts):
// - GET /api/forge/stats returns the Mac's "Used by" counts and sample, the research marks and the
//   star history, by a key range (never a scan);
// - a hidden or unknown repository answers 404; signed out, 401.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const HEAD = "a".repeat(40);

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

async function signIn(who?: { id: number; login: string; name: string }): Promise<{ b: ForgeBrowser }> {
  if (who) w.mock.who.github = who;
  const b = w.browser();
  await b.signIn("github");
  return { b };
}

function stats(repoId: string, papers: number, repos: number, stars: [number, number][]): void {
  w.forge.sqlite
    .prepare("INSERT OR REPLACE INTO repo_stats (forge, repo_id, usedby_papers, usedby_repos, stars, computed_at) VALUES ('memory', ?, ?, ?, ?, ?)")
    .run(repoId, papers, repos, JSON.stringify(stars), T0);
}

function dependent(repoId: string, kind: string, key: string, o: Partial<{ via: string; owner: string; name: string; slug: string; title: string }> = {}): void {
  w.forge.sqlite
    .prepare("INSERT INTO repo_dependents (forge, repo_id, dep_kind, dep_ref, via, owner, name, slug, title, computed_at) VALUES ('memory', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(repoId, kind, key, o.via ?? "", o.owner ?? "", o.name ?? "", o.slug ?? "", o.title ?? "", T0);
}

function mark(repoId: string, kind: string, ref: string, t: number, label: string): void {
  w.forge.sqlite
    .prepare("INSERT INTO repo_marks (forge, repo_id, kind, ref, t, label, computed_at) VALUES ('memory', ?, ?, ?, ?, ?, ?)")
    .run(repoId, kind, ref, t, label, T0);
}

describe("GET /api/forge/stats", () => {
  test("the Mac's Used-by counts and sample, the marks and the star history", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "toolkit", mode: "public", head: HEAD }, T0 - 86_400);
    stats("101", 2, 1, [[1700000000, 1], [1700086400, 3]]);
    dependent("101", "paper", "doi:10.1/x", { via: "PyPI:toolkit", slug: "x-slug", title: "A study" });
    dependent("101", "repo", "202", { via: "PyPI:toolkit", owner: "bob", name: "study" });
    mark("101", "paper", "doi:10.1/x", 1700000000, "A study (doi:10.1/x)");
    const { b } = await signIn();
    const res = await b.fetch("/api/forge/stats?id=memory:101");
    assert.equal(res.status, 200);
    const j = await body(res);
    assert.equal(j.usedBy.papers, 2);
    assert.equal(j.usedBy.repos, 1);
    assert.equal(j.usedBy.dependents.length, 2);
    const paper = j.usedBy.dependents.find((d: Json) => d.kind === "paper");
    assert.equal(paper.doi, "doi:10.1/x");
    assert.equal(paper.slug, "x-slug");
    assert.equal(paper.via, "PyPI:toolkit");
    const repo = j.usedBy.dependents.find((d: Json) => d.kind === "repo");
    assert.equal(repo.owner, "bob");
    assert.equal(j.marks.length, 1);
    assert.equal(j.marks[0].kind, "paper");
    assert.equal(j.marks[0].t, 1700000000);
    assert.deepEqual(j.stars, [{ t: 1700000000, v: 1 }, { t: 1700086400, v: 3 }]);
  });

  test("a repository with no statistics yet answers with empty counts", async () => {
    await seed.repo(w.forge, { repoId: "103", ownerLogin: "ada", name: "fresh", mode: "public", head: HEAD }, T0 - 86_400);
    const { b } = await signIn();
    const res = await b.fetch("/api/forge/stats?id=memory:103");
    assert.equal(res.status, 200);
    const j = await body(res);
    assert.equal(j.usedBy.papers, 0);
    assert.equal(j.usedBy.repos, 0);
    assert.deepEqual(j.usedBy.dependents, []);
    assert.deepEqual(j.stars, []);
  });

  test("an unknown repository is 404", async () => {
    const { b } = await signIn();
    const res = await b.fetch("/api/forge/stats?id=memory:999");
    assert.equal(res.status, 404);
  });

  test("signed out, it asks to sign in (401)", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "toolkit", mode: "public", head: HEAD }, T0 - 86_400);
    const res = await w.browser().fetch("/api/forge/stats?id=memory:101");
    assert.equal(res.status, 401);
  });
});
