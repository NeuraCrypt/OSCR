// The public read API's shape (src/lib/apispec.ts): its endpoints, the OpenAPI document built
// from them, and the error body. Pure (no catalogue), so it runs under node --test directly; the
// static data the API serves is built from the fixture and checked by scripts/check.mjs on dist/.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  API_BASE, API_DOCS, API_ENTITY_TYPES, apiError, buildOpenapi, ENDPOINTS, LIST_ID,
} from "../src/lib/apispec.ts";

describe("the API spec (apispec.ts)", () => {
  it("has a unique id per endpoint, all GET", () => {
    assert.equal(new Set(ENDPOINTS.map((e) => e.id)).size, ENDPOINTS.length);
    for (const e of ENDPOINTS) assert.equal(e.method, "GET");
  });

  it("builds an OpenAPI 3.1 document whose paths are exactly the endpoints' (no drift)", () => {
    const doc = buildOpenapi("https://openscicode.org") as {
      openapi: string;
      paths: Record<string, { get: { operationId: string } }>;
      servers: { url: string }[];
    };
    assert.equal(doc.openapi, "3.1.0");
    const specPaths = new Set(ENDPOINTS.map((e) => e.path || "/"));
    const docPaths = new Set(Object.keys(doc.paths));
    assert.deepEqual([...docPaths].sort(), [...specPaths].sort());
    assert.equal(doc.servers[0].url, `https://openscicode.org${API_BASE}`);
    for (const e of ENDPOINTS) assert.equal(doc.paths[e.path || "/"].get.operationId, e.id);
  });

  it("documents a path parameter for the DOI, and a query parameter too (slashes in DOIs)", () => {
    const paper = ENDPOINTS.find((e) => e.id === "paper")!;
    assert.ok(paper.params.some((p) => p.in === "path" && p.name === "doi"));
    assert.ok(paper.params.some((p) => p.in === "query" && p.name === "doi"));
  });

  it("marks only the search endpoint as quota-bound", () => {
    const quota = ENDPOINTS.filter((e) => e.quota).map((e) => e.id);
    assert.deepEqual(quota, ["search"]);
  });

  it("names a list endpoint for every entity type", () => {
    for (const t of API_ENTITY_TYPES) assert.ok(ENDPOINTS.some((e) => e.id === LIST_ID[t]), t);
  });

  it("builds a stable error body with the documentation link", () => {
    assert.deepEqual(apiError("not_found", "No such paper.", "https://openscicode.org"), {
      error: "not_found",
      message: "No such paper.",
      documentation_url: `https://openscicode.org${API_DOCS}`,
    });
  });
});
