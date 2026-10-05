// The public read API (worker/v1/index.ts, wired in worker/index.ts): its routes, the envelope,
// the CORS and cache headers, the error model, and that it reads the static /data/ files. The data
// is mocked (hand-built assets with the right shard names), so the test needs no build.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import worker from "../worker/index.ts";
import { handleV1 } from "../worker/v1/index.ts";
import type { Assets } from "../worker/pages.ts";
import { lookupShard, shardOf, SHARDS } from "../src/lib/shards.ts";
import { REPO_SHARDS } from "../src/lib/apispec.ts";
import { addPaper, databases, fakeD1, NO_FTS5 } from "./d1.ts";

const ctx = { waitUntil: () => undefined };
const ORIGIN = "https://openscicode.org";
const get = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);

const DOI = "10.5555/oscr.fixture.1";
const SLUG = "doi_10.5555_oscr.fixture.1";
const ORCID = "0000-0000-0000-0028";
const REPO = "github.com/oscr-fixture/eeg-analysis";

/** The static files the Worker reads, keyed by their real shard names. */
async function files(): Promise<Record<string, string>> {
  return {
    "/api/index.html": "<!doctype html><title>API: OSCR</title><main><h1>API</h1></main>",
    "/data/stats.json": JSON.stringify({ generated_at: "2026-09-30T01:40:53Z", scope: {}, figures: { articles: 5, with_code: 2 } }),
    [`/lookup/${await lookupShard(DOI)}.json`]: JSON.stringify({ [DOI]: ["code_verified", "2026-09-20", SLUG] }),
    [`/lookup/${await lookupShard("10.5555/nopage")}.json`]: JSON.stringify({ "10.5555/nopage": ["none", "2026-09-20"] }),
    [`/data/papers/${await shardOf(SLUG, SHARDS.paper)}.json`]: JSON.stringify({ [SLUG]: { slug: SLUG, doi: DOI, title: "A paper", code: [] } }),
    [`/records/author/${await shardOf(ORCID, SHARDS.author)}.json`]: JSON.stringify({
      entities: { [ORCID]: { name: "Ben Example", papers: [SLUG], counts: { papers: 1, with_code: 1 } } },
      rows: { [SLUG]: { doi: DOI, title: "A paper" } },
    }),
    "/data/entities/head/authors.json": JSON.stringify({
      total: 2,
      items: [
        { orcid: ORCID, name: "Ben Example" },
        { orcid: "0000-0000-0000-001X", name: "Ada Second" },
      ],
    }),
    [`/data/repos/${await shardOf(REPO, REPO_SHARDS)}.json`]: JSON.stringify({ [REPO]: { repo: REPO, host: "github.com", license: "MIT", papers: [] } }),
  };
}

/** An ASSETS binding over a map of files, with html_handling's /x.html → /x redirect. */
function assets(map: Record<string, string>): Assets {
  return {
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith("/")) {
        const idx = map[`${path}index.html`];
        return idx === undefined ? new Response(null, { status: 404 }) : new Response(idx, { status: 200 });
      }
      const file = map[path];
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file, { status: 200 });
    },
  };
}

let env: { ASSETS: Assets };
beforeEach(async () => {
  env = { ASSETS: assets(await files()) };
});

const body = async (res: Response) => JSON.parse(await res.text());

describe("the API routing and CORS", () => {
  it("serves the index with the version, links and open CORS", async () => {
    const res = await worker.fetch(get("/api/v1/"), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(res.headers.get("Cache-Control") ?? "", /max-age=600/);
    const j = await body(res);
    assert.equal(j.oscr_api, "v1");
    assert.ok(Array.isArray(j.endpoints) && j.endpoints.length > 5);
    assert.ok(j.openapi.endsWith("/api/v1/openapi.json"));
  });

  it("answers a preflight OPTIONS with 204 and the CORS headers", async () => {
    const res = await worker.fetch(get("/api/v1/stats", { method: "OPTIONS" }), env, ctx);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
  });

  it("refuses a method that is not GET or HEAD", async () => {
    const res = await worker.fetch(get("/api/v1/stats", { method: "POST" }), env, ctx);
    assert.equal(res.status, 405);
    assert.equal((await body(res)).error, "method_not_allowed");
  });

  it("returns the documented error shape for an unknown endpoint", async () => {
    const res = await worker.fetch(get("/api/v1/nothing"), env, ctx);
    assert.equal(res.status, 404);
    const j = await body(res);
    assert.equal(j.error, "not_found");
    assert.ok(j.message && j.documentation_url.endsWith("/help/api/"));
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  it("leaves the site's own /api/search error shape untouched", async () => {
    // worker/index.ts still routes /api/nothing to the JSON 404 with {error:{code}}.
    const res = await worker.fetch(get("/api/nothing"), env, ctx);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "not_found");
  });
});

describe("the OpenAPI and stats endpoints", () => {
  it("serves an OpenAPI document with this origin as the server", async () => {
    const res = await handleV1(get("/api/v1/openapi.json"), env as never, ctx);
    const j = await body(res);
    assert.equal(j.openapi, "3.1.0");
    assert.equal(j.servers[0].url, `${ORIGIN}/api/v1`);
  });

  it("serves the figures from /data/stats.json", async () => {
    const res = await handleV1(get("/api/v1/stats"), env as never, ctx);
    const j = await body(res);
    assert.equal(j.figures.articles, 5);
    assert.equal(j.source, "/data/stats.json");
  });
});

describe("the paper endpoint", () => {
  it("resolves a URL-encoded DOI in the path", async () => {
    const res = await handleV1(get(`/api/v1/paper/${encodeURIComponent(DOI)}`), env as never, ctx);
    assert.equal(res.status, 200);
    assert.equal((await body(res)).paper.slug, SLUG);
  });

  it("resolves a DOI given as ?doi= (slashes and all)", async () => {
    const res = await handleV1(get(`/api/v1/paper?doi=${DOI}`), env as never, ctx);
    assert.equal((await body(res)).paper.doi, DOI);
  });

  it("resolves an unencoded DOI left in the path", async () => {
    const res = await handleV1(get(`/api/v1/paper/${DOI}`), env as never, ctx);
    assert.equal((await body(res)).paper.slug, SLUG);
  });

  it("says a read paper has no page, without a record", async () => {
    const res = await handleV1(get("/api/v1/paper?doi=10.5555/nopage"), env as never, ctx);
    const j = await body(res);
    assert.equal(res.status, 200);
    assert.equal(j.page, false);
    assert.ok(!j.paper);
  });

  it("404s a DOI the registry does not know, and 400s a non-DOI", async () => {
    assert.equal((await handleV1(get("/api/v1/paper?doi=10.9999/absent"), env as never, ctx)).status, 404);
    assert.equal((await handleV1(get("/api/v1/paper?doi=not-a-doi"), env as never, ctx)).status, 400);
  });
});

describe("the entity and list endpoints", () => {
  it("returns one author from its record shard, with the papers' rows", async () => {
    const res = await handleV1(get(`/api/v1/author/${ORCID}`), env as never, ctx);
    const j = await body(res);
    assert.equal(res.status, 200);
    assert.equal(j.entity.name, "Ben Example");
    assert.equal(j.key, ORCID);
    assert.ok(j.papers[SLUG]);
  });

  it("404s an unknown author and 400s an impossible key", async () => {
    assert.equal((await handleV1(get("/api/v1/author/0000-0000-0000-9999"), env as never, ctx)).status, 404);
    assert.equal((await handleV1(get("/api/v1/author/has%2Fslash"), env as never, ctx)).status, 400);
  });

  it("paginates a list and points to the bulk file", async () => {
    const res = await handleV1(get("/api/v1/authors?size=1&page=2"), env as never, ctx);
    const j = await body(res);
    assert.equal(j.total, 2);
    assert.equal(j.items.length, 1);
    assert.equal(j.page, 2);
    assert.ok(j.bulk.endsWith("/data/entities/authors.json"));
    assert.equal(j.next, null);
  });
});

describe("the repository endpoint", () => {
  it("returns a repository by host/owner/name", async () => {
    const res = await handleV1(get(`/api/v1/repository/${REPO}`), env as never, ctx);
    const j = await body(res);
    assert.equal(res.status, 200);
    assert.equal(j.repository.repo, REPO);
  });

  it("400s an incomplete repository path and 404s an unknown one", async () => {
    assert.equal((await handleV1(get("/api/v1/repository/github.com"), env as never, ctx)).status, 400);
    assert.equal((await handleV1(get("/api/v1/repository/github.com/x/absent"), env as never, ctx)).status, 404);
  });
});

describe("the search endpoint", () => {
  it("503s not_configured without the databases, and 400s a bad query", async () => {
    assert.equal((await handleV1(get("/api/v1/search?q=eeg"), env as never, ctx)).status, 503);
    assert.equal((await handleV1(get("/api/v1/search?page=0"), env as never, ctx)).status, 400);
  });

  it("wraps the search's JSON in the API envelope when the databases answer", { skip: NO_FTS5 }, async () => {
    const dbs = databases();
    await addPaper(dbs, { pid: 2026092100001, title: "EEG alpha waves", facets: { modality: ["eeg"] }, cited: 3 });
    const withDb = { ASSETS: env.ASSETS, CATALOG: fakeD1(dbs.catalog), SEARCH: fakeD1(dbs.search) };
    const res = await handleV1(get("/api/v1/search?q=eeg"), withDb as never, ctx);
    assert.equal(res.status, 200);
    const j = await body(res);
    assert.equal(j.oscr_api, "v1");
    assert.equal(j.quota, true);
    assert.ok(Array.isArray(j.results));
  });
});

describe("the human API page", () => {
  it("is served by the Worker at /api/ from the static asset", async () => {
    const res = await worker.fetch(get("/api/"), env, ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
    assert.match(await res.text(), /<h1>API<\/h1>/);
  });
});
