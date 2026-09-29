// The GitHub side's search (night phase 08, E4; worker/forge-search.ts, api.ts): GET /api/search with
// a type (repositories, issues, people, topics) reads forge_fts in oscr_search, as the Mac writes it
// (oscr/social.py push_search); "papers" stays the default. Every term is quoted before FTS5; the
// qualifiers the index knows filter; the counts of every type come in the same batch.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { handleSearch } from "../worker/api.ts";
import { forgeMatch, parseForgeQuery, readForgeQuery, ForgeSearchError } from "../worker/forge-search.ts";
import { databases, fakeD1, NO_FTS5 } from "./d1.ts";

const ctx = { waitUntil: () => undefined };
const request = (qs: string) => new Request(`https://oscr.example/api/search?${qs}`);

function doc(db: DatabaseSync, rowid: number, d: { title: string; text?: string; ids?: string; kind: string; fx: unknown }): void {
  db.prepare("INSERT INTO forge_fts (rowid, title, text, ids, kind, fx) VALUES (?, ?, ?, ?, ?, ?)").run(rowid, d.title, d.text ?? "", d.ids ?? "", d.kind, JSON.stringify(d.fx));
}

describe("the query", () => {
  it("words, phrases, exclusions and the qualifiers the index knows; the rest searched as words, and said", () => {
    const p = parseForgeQuery('eeg "band pass" -meg is:closed type:code-error user:Ada-Fixture doi:10.1234/EEG in:title stars:>5');
    assert.deepEqual(p.words, ["eeg", "stars", "5"]);
    assert.deepEqual(p.phrases, ["band pass"]);
    assert.deepEqual(p.not, ["meg"]);
    assert.deepEqual([p.is, p.researchType, p.owner, p.doi, p.inTitle], ["closed", "code_error", "ada-fixture", "10.1234/eeg", true]);
    assert.deepEqual(p.unused, ["stars:>5"]);
  });

  it("every term is quoted: nothing a reader types is FTS5 syntax", () => {
    const m = forgeMatch("issues", parseForgeQuery('a" OR b NEAR( {kind}:* is:open'));
    assert.equal(m, '{kind} : "zzkissue" AND {title text ids} : "a" AND {title text ids} : "or" AND {title text ids} : "b" AND {title text ids} : "near" AND {title text ids} : "kind" AND {kind} : "zzsopen"');
    assert.equal(forgeMatch("repositories", parseForgeQuery("-x")), '{kind} : "zzkrepository" NOT {title text ids} : "x"');
  });

  it("the parameters: a type, a page within 25, a query within 300 characters", () => {
    assert.equal(readForgeQuery(new URLSearchParams("type=people&q=ada")).type, "people");
    for (const bad of ["type=code", "type=issues&page=26", "type=issues&page=0", `type=issues&q=${"x".repeat(301)}`]) {
      assert.throws(() => readForgeQuery(new URLSearchParams(bad)), ForgeSearchError, bad);
    }
  });
});

describe("GET /api/search?type=…", { skip: NO_FTS5 }, () => {
  let dbs: ReturnType<typeof databases>;
  let env: { CATALOG: ReturnType<typeof fakeD1>; SEARCH: ReturnType<typeof fakeD1> };
  beforeEach(() => {
    dbs = databases();
    env = { CATALOG: fakeD1(dbs.catalog), SEARCH: fakeD1(dbs.search) };
    doc(dbs.search, 1, { title: "lab eeg lab/eeg", text: "Filtering EEG before epoching", ids: "lab/eeg lab eeg 10.1234/eeg.2026", kind: "zzkall zzkrepository", fx: { k: "repository", path: "lab/eeg", url: "/r/lab/eeg/" } });
    doc(dbs.search, 2, { title: "neuro fmri neuro/fmri", text: "An fMRI model", ids: "neuro/fmri neuro fmri", kind: "zzkall zzkrepository", fx: { k: "repository", path: "neuro/fmri", url: "/r/neuro/fmri/" } });
    doc(dbs.search, 3, { title: "Off by one in the epochs", text: "Line 12 epochs", ids: "research 1 10.1234/eeg.2026 lab/eeg", kind: "zzkall zzkissue zzsopen zztcodeerror", fx: { k: "issue", n: 1, url: "/research/1" } });
    doc(dbs.search, 4, { title: "Ada Fixture ada-fixture", text: "EEG methods", ids: "ada-fixture", kind: "zzkall zzkperson", fx: { k: "person", handle: "ada-fixture", url: "/u/ada-fixture/" } });
    doc(dbs.search, 5, { title: "eeg eeg electroencephalography", text: "Electroencephalography", ids: "eeg", kind: "zzkall zzktopic", fx: { k: "topic", name: "eeg", url: "/explore/?topic=eeg" } });
  });

  it("repositories: the matches, and every type's count in the same batch", async () => {
    const res = await handleSearch(request("type=repositories&q=eeg"), env, ctx);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.results.map((r: { path: string }) => r.path), ["lab/eeg"]);
    assert.deepEqual(body.counts, { repositories: 1, issues: 1, people: 1, topics: 1 });
    assert.equal(body.cost.queries, 5);
    assert.match(res.headers.get("Cache-Control") ?? "", /public, max-age=600/);
  });

  it("issues: is:open and type: filter; user: filters repositories by their owner", async () => {
    let body = await (await handleSearch(request("type=issues&q=epochs%20is:open%20type:code-error"), env, ctx)).json();
    assert.deepEqual(body.results.map((r: { n: number }) => r.n), [1]);
    body = await (await handleSearch(request("type=issues&q=epochs%20is:closed"), env, ctx)).json();
    assert.equal(body.results.length, 0);
    body = await (await handleSearch(request("type=repositories&q=user:neuro"), env, ctx)).json();
    assert.deepEqual(body.results.map((r: { path: string }) => r.path), ["neuro/fmri"]);
  });

  it("people and topics; papers stay the default type", async () => {
    let body = await (await handleSearch(request("type=people&q=methods"), env, ctx)).json();
    assert.deepEqual(body.results.map((r: { handle: string }) => r.handle), ["ada-fixture"]);
    body = await (await handleSearch(request("type=topics&q=electroencephalography"), env, ctx)).json();
    assert.deepEqual(body.results.map((r: { name: string }) => r.name), ["eeg"]);
    const papers = await handleSearch(request("q=eeg"), env, ctx);
    assert.equal(papers.status, 200);
    assert.ok(Array.isArray((await papers.json()).results));
  });

  it("the quota and the configuration, in words", async () => {
    const bad = await handleSearch(request("type=snippets&q=x"), env, ctx);
    assert.equal(bad.status, 400);
    const none = await handleSearch(request("type=issues&q=x"), {}, ctx);
    assert.equal((await none.json()).error.code, "not_configured");
    env.SEARCH.failWith = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit.";
    const quota = await handleSearch(request("type=issues&q=x"), env, ctx);
    assert.equal(quota.status, 503);
    assert.equal((await quota.json()).error.code, "quota");
    assert.ok(quota.headers.get("Retry-After"));
  });
});
