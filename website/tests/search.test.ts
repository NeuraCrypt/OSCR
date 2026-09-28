// The search API (worker/search.ts, worker/index.ts): the parameters it accepts, the SQL it
// builds, what it answers, on the two databases built from the real migrations.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { FACETS, facetToken, normalizeValue } from "../src/lib/facets.ts";
import { handleSearch } from "../worker/api.ts";
import worker from "../worker/index.ts";
import {
  BadRequest, canonicalSearch, classify, dayKey, MAX_PAGE, plan, readQuery, runSearch, toCsv, toJson, WINDOW,
} from "../worker/search.ts";
import { addPaper, addSummary, databases, fakeD1, type FakeD1, NO_FTS5 } from "./d1.ts";

const query = (qs: string) => readQuery(new URLSearchParams(qs));
const ctx = { waitUntil: () => undefined };

describe("the facet tokens", () => {
  it("are the ones oscr/d1.py writes (the same test vector on both sides)", async () => {
    assert.equal(await facetToken("mo", "eeg"), "zzmo135b0779d467");
    assert.equal(await facetToken("jo", "  NeuroImage "), await facetToken("jo", "neuroimage"));
    assert.equal(normalizeValue("Ｃ／Ｃ＋＋  Code"), "c/c++ code");
  });

  it("have a unique code and parameter per facet", () => {
    assert.equal(new Set(FACETS.map((f) => f.code)).size, FACETS.length);
    assert.equal(new Set(FACETS.map((f) => f.param)).size, FACETS.length);
    for (const f of FACETS) assert.match(f.code, /^[a-z]{2}$/);
  });
});

describe("the parameters", () => {
  it("are read, and defaulted", () => {
    const q = query("q=eeg&modality=eeg&modality=meg&tool=MNE-Python&from=2020&to=2021-06&sort=cited&page=3&size=10");
    assert.deepEqual(q.filters, [["modality", ["eeg", "meg"]], ["tool", ["MNE-Python"]]]);
    assert.equal(q.from, "2020");
    assert.equal(q.page, 3);
    assert.deepEqual(query("").filters, []);
    assert.equal(query("").page, 1);
    assert.equal(query("").size, 20);
    assert.equal(query("").sort, "");
  });

  it("are refused when wrong, with a reason", () => {
    for (const bad of ["page=0", `page=${MAX_PAGE + 1}`, "page=x", "size=500", "sort=random", "format=xml", "from=20", "to=2020-13",
      "from=2021&to=2020", `status=${"x".repeat(201)}`, Array.from({ length: 21 }, (_, i) => `tool=t${i}`).join("&")]) {
      assert.throws(() => query(bad), BadRequest, bad);
    }
  });

  it("ignore unknown parameters and have one canonical form", () => {
    const a = query("tool=b&tool=a&q=eeg&utm=1&modality=x");
    const b = query("modality=x&q=eeg&tool=a&tool=b");
    assert.equal(canonicalSearch(a), canonicalSearch(b));
    assert.equal(canonicalSearch(a), "q=eeg&modality=x&tool=a&tool=b");
  });
});

describe("dates", () => {
  it("become key ranges that include partial dates", () => {
    assert.equal(dayKey("2020", false), 20200000);
    assert.equal(dayKey("2020", true), 20209999);
    assert.equal(dayKey("2020-03", true), 20200399);
    assert.equal(dayKey("2020-03-05", false), 20200305);
  });
});

describe("the plan", () => {
  it("combines the words, the filters and the dates into one MATCH", async () => {
    const p = await plan(query("q=eeg&modality=eeg&modality=meg&status=code_verified&from=2020"));
    const [mo1, mo2, st] = await Promise.all([facetToken("mo", "eeg"), facetToken("mo", "meg"), facetToken("st", "code_verified")]);
    // Filters come in the order of FACETS: status before modality.
    assert.equal(p.match, `({title keywords mesh authors journal repos tools ids abstract} : "eeg") AND {facets} : ("${st}") AND {facets} : ("${mo1}" OR "${mo2}")`);
    assert.deepEqual(p.range, [20200000 * 100000, 99_999_999 * 100_000 + 99_999]);
    assert.equal(p.sort, "relevance");
  });

  it("has nothing to match for the empty query, and sorts by date without words", async () => {
    assert.equal((await plan(query(""))).match, null);
    assert.equal((await plan(query(""))).sort, "newest");
    const dates = await plan(query("from=2020&to=2020"));
    assert.equal(dates.match, '{facets} : "zzall"');
    const filters = await plan(query("status=on_request&sort=relevance"));
    assert.equal(filters.sort, "newest");
    assert.match(filters.notices[0], /sorted by date/);
    assert.equal((await plan(query("q=-meg"))).sort, "newest");
  });
});

describe("a search", { skip: NO_FTS5 }, () => {
  let dbs: ReturnType<typeof databases>;
  let env: { CATALOG: FakeD1; SEARCH: FakeD1 };
  beforeEach(async () => {
    dbs = databases();
    env = { CATALOG: fakeD1(dbs.catalog), SEARCH: fakeD1(dbs.search) };
    await addPaper(dbs, { pid: 2026092100001, title: "EEG alpha waves in working memory", facets: { modality: ["eeg"] }, tools: ["MNE-Python"], cited: 3 });
    await addPaper(dbs, { pid: 2026091500001, title: "MEG and EEG source imaging", facets: { modality: ["meg", "eeg"] }, cited: 12 });
    await addPaper(dbs, { pid: 2025060100001, title: "fMRI of memory in Zürich", status: "on_request", facets: { modality: ["fmri"] }, abstract: "a hippocampus study" });
    await addPaper(dbs, { pid: 2024000000001, title: "A data-only EEG dataset", status: "data_only", facets: { modality: ["eeg"] }, cited: 40 });
    addSummary(dbs.catalog, { status: [["code_verified", 2], ["on_request", 1], ["data_only", 1]], year: [["2026", 2], ["2025", 1], ["2024", 1]] }, 4);
  });
  const results = (json: string) => JSON.parse(json).results.map((d: { slug: string }) => d.slug);

  it("ranks by relevance, counts the facets over every result, and costs two queries", async () => {
    const out = await runSearch(env, query("q=eeg"));
    const body = JSON.parse(toJson(out));
    assert.deepEqual(body.results.map((d: { title: string }) => d.title).sort(), [
      "A data-only EEG dataset", "EEG alpha waves in working memory", "MEG and EEG source imaging"]);
    assert.equal(body.total, 3);
    assert.equal(body.complete, true);
    assert.equal(body.facets_scope, "results");
    assert.deepEqual(body.facets.modality, [["eeg", 3], ["meg", 1]]);
    assert.deepEqual(body.facets.year, [["2026", 2], ["2024", 1]]);       // years: the newest first
    assert.equal(body.cost.queries, 2);
    assert.equal(env.SEARCH.sql.length, 1);
    assert.match(env.SEARCH.sql[0], /ORDER BY rank LIMIT 501$/);
    assert.equal(body.query.sort, "relevance");
  });

  it("filters by facets (case-insensitive), dates and exclusions", async () => {
    assert.deepEqual(results(toJson(await runSearch(env, query("modality=EEG&sort=oldest")))), ["paper-2024000000001", "paper-2026091500001", "paper-2026092100001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("q=eeg&modality=meg")))), ["paper-2026091500001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("q=eeg -meg&from=2026")))), ["paper-2026092100001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("from=2025&to=2025-12")))), ["paper-2025060100001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("tool=mne-python")))), ["paper-2026092100001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("status=on_request&status=data_only")))), ["paper-2025060100001", "paper-2024000000001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("q=hippocampus")))), ["paper-2025060100001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("q=nothing-like-this")))), []);
  });

  it("sorts by citations and by date", async () => {
    assert.deepEqual(results(toJson(await runSearch(env, query("q=eeg&sort=cited")))), ["paper-2024000000001", "paper-2026091500001", "paper-2026092100001"]);
    assert.deepEqual(results(toJson(await runSearch(env, query("q=eeg&sort=newest")))), ["paper-2026092100001", "paper-2026091500001", "paper-2024000000001"]);
  });

  it("pages", async () => {
    const page2 = JSON.parse(toJson(await runSearch(env, query("modality=eeg&size=2&page=2"))));
    assert.deepEqual(page2.results.map((d: { slug: string }) => d.slug), ["paper-2024000000001"]);
    assert.equal(page2.pages, 2);
  });

  it("answers the empty query from the catalogue and its precomputed counts", async () => {
    const body = JSON.parse(toJson(await runSearch(env, query(""))));
    assert.equal(body.total, 4);
    assert.equal(body.facets_scope, "catalogue");
    assert.deepEqual(body.facets.status, [["code_verified", 2], ["data_only", 1], ["on_request", 1]]);
    assert.equal(env.SEARCH.sql.length, 0);
    assert.equal(body.cost.queries, 3);
    assert.deepEqual(body.results.map((d: { slug: string }) => d.slug)[0], "paper-2026092100001");
    const cited = JSON.parse(toJson(await runSearch(env, query("sort=cited"))));
    assert.deepEqual(cited.results.map((d: { slug: string }) => d.slug)[0], "paper-2024000000001");
    assert.match(env.CATALOG.sql.join("\n"), /ORDER BY cited_by_count DESC, pid DESC/);
  });

  it("never returns an abstract", async () => {
    const body = JSON.parse(toJson(await runSearch(env, query("q=hippocampus"))));
    assert.equal(body.results.length, 1);                      // found through its abstract…
    assert.doesNotMatch(JSON.stringify(body.results), /hippocampus/);   // …which is never returned
    assert.doesNotMatch(JSON.stringify(body), /a hippocampus study/);
  });

  it("exports the window as CSV and JSON, without facets", async () => {
    const out = await runSearch(env, query("q=eeg&format=csv&sort=newest"));
    const csv = toCsv(out, "https://example.org");
    const lines = csv.trim().split("\r\n");
    assert.equal(lines[0], "doi,title,journal,published,status,page,code_repositories,code_licenses,datasets,cited_by_count");
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^10\.5555\/2026092100001,EEG alpha waves in working memory,Journal of Tests,2026-09-21,code_verified,https:\/\/example.org\/paper\/paper-2026092100001\/,https:\/\/github.com\/lab\/2026092100001,MIT,0,3$/);
    assert.deepEqual(out.meta.facets, {});
  });

  it("keeps spreadsheet formulas out of the CSV", async () => {
    await addPaper(dbs, { pid: 2026092200001, title: '=HYPERLINK("x"), with "quotes"' });
    const csv = toCsv(await runSearch(env, query("q=hyperlink&format=csv")), "https://example.org");
    assert.match(csv, /,"'=HYPERLINK\(""x""\), with ""quotes""",/);
  });

  it("is bounded: past the window, the total is a lower bound and the counts are the window's", async () => {
    for (let i = 0; i < WINDOW + 5; i += 1) {
      await addPaper(dbs, { pid: 2023010100000 + i, title: `Bulk paper ${i} on oscillations`, facets: { modality: ["eeg"] } });
    }
    const body = JSON.parse(toJson(await runSearch(env, query("q=oscillations"))));
    assert.equal(body.total, WINDOW);
    assert.equal(body.complete, false);
    assert.equal(body.facets_scope, "window");
    assert.equal(body.facets.modality[0][1], WINDOW);
    assert.equal(body.pages, WINDOW / 20);                       // the pages stop at the window
    // Most cited, without words: among the most recent results (every rank is 0), and said so.
    const cited = JSON.parse(toJson(await runSearch(env, query("modality=eeg&sort=cited"))));
    assert.match(cited.notices.join(" "), /500 most recent results/);
    assert.match(env.SEARCH.sql.at(-1)!, /ORDER BY rowid DESC LIMIT 501$/);
    // The last page of the window, then past it: nothing more is read, and the reader is told.
    const last = JSON.parse(toJson(await runSearch(env, query("q=oscillations&page=25&sort=newest"))));
    assert.equal(last.results.length, 20);
    assert.equal(last.cost.queries, 2);
    const past = JSON.parse(toJson(await runSearch(env, query("q=oscillations&page=26&sort=newest"))));
    assert.equal(past.results.length, 0);
    assert.equal(past.cost.queries, 1);
    assert.match(past.notices.join(" "), /Only the first 500 results/);
    const empty = JSON.parse(toJson(await runSearch(env, query("page=26"))));
    assert.equal(empty.results.length, 0);
    assert.match(empty.notices.join(" "), /Only the first 500 results/);
  });

  it("keeps a row whose facet values cannot be read, without its values", async () => {
    dbs.search.prepare("UPDATE paper_fts SET fx = 'not json' WHERE rowid = 2026091500001").run();
    const body = JSON.parse(toJson(await runSearch(env, query("q=eeg"))));
    assert.equal(body.total, 3);
    assert.deepEqual(body.facets.modality, [["eeg", 2]]);
  });

  it("skips a paper the catalogue does not have yet", async () => {
    dbs.catalog.prepare("DELETE FROM papers WHERE pid = 2026091500001").run();
    assert.deepEqual(results(toJson(await runSearch(env, query("modality=meg")))), []);
  });
});

describe("the Worker", { skip: NO_FTS5 }, () => {
  const request = (qs: string, init?: RequestInit) => new Request(`https://oscr.example/api/search?${qs}`, init);

  it("answers JSON, cacheable", async () => {
    const dbs = databases();
    await addPaper(dbs, { pid: 2026092100001, title: "EEG study" });
    const res = await handleSearch(request("q=eeg"), { CATALOG: fakeD1(dbs.catalog), SEARCH: fakeD1(dbs.search) }, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=600");
    assert.match(res.headers.get("X-Search-Cost") ?? "", /^queries=2; rows_read=\d+$/);
    assert.equal((await res.json()).results[0].title, "EEG study");
  });

  it("says in JSON what went wrong: the quota, an outage, a wrong request, no databases", async () => {
    const dbs = databases();
    const env = { CATALOG: fakeD1(dbs.catalog), SEARCH: fakeD1(dbs.search) };
    env.SEARCH.failWith = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
    let res = await handleSearch(request("q=eeg"), env, ctx);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "quota");
    assert.ok(Number(res.headers.get("Retry-After")) > 0);
    assert.equal(res.headers.get("Cache-Control"), "no-store");

    env.SEARCH.failWith = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";
    assert.equal((await (await handleSearch(request("q=eeg"), env, ctx)).json()).error.code, "unavailable");

    env.SEARCH.failWith = "D1_ERROR: fts5: syntax error near \"\"";
    res = await handleSearch(request("q=eeg"), env, ctx);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "bad_query");

    res = await handleSearch(request("page=501"), env, ctx);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /page/);

    res = await handleSearch(request("q=eeg"), {}, ctx);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "not_configured");

    res = await handleSearch(request("q=eeg"), { ...env, SEARCH_SIMULATE_FAILURE: "quota" }, ctx);
    assert.equal((await res.json()).error.code, "quota");

    res = await handleSearch(request("q=eeg", { method: "POST" }), env, ctx);
    assert.equal(res.status, 405);
  });

  it("routes /api/search, with or without its slash, and nothing else", async () => {
    const res = await worker.fetch(new Request("https://oscr.example/api/other"), {}, ctx);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
    for (const path of ["/api/search?q=x", "/api/search/?q=x"]) {
      const routed = await worker.fetch(new Request(`https://oscr.example${path}`), {}, ctx);
      assert.equal((await routed.json()).error.code, "not_configured", path);     // the search, without databases
    }
    assert.equal((await worker.fetch(new Request("https://oscr.example/api/searches"), {}, ctx)).status, 404);
  });

  it("classifies D1's errors", () => {
    assert.equal(classify(new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit.")), "quota");
    assert.equal(classify(new Error("fts5: syntax error near \"x\"")), "bad_query");
    assert.equal(classify(new Error("Network connection lost.")), "unavailable");
  });
});
