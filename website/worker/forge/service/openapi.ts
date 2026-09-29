// The OpenAPI description of the public API (night phase 10, E2), built from the routes themselves
// (api.ts API_ROUTES: their method, scope, words, parameters and bodies), so that the published file
// never drifts from the Worker: `node --experimental-strip-types scripts/openapi.ts` writes
// public/developers/openapi.json, and a test (tests/forge-service/api.test.ts) compares the file with
// this function's output. No server address in it: the paths are relative to the site that serves it.

import { API_PREFIX, API_ROUTES, API_VERSION, API_VERSIONS, EXPOSED } from "./api.ts";
import { SCOPE_WORDS, SCOPES } from "./tokens-core.ts";

type J = Record<string, unknown>;

const errorRef = { $ref: "#/components/responses/Error" };

export function openApi(): J {
  const paths: J = {};
  for (const [path, route] of Object.entries(API_ROUTES)) {
    const op: J = {
      summary: route.words,
      operationId: `${route.method.toLowerCase()}${path.slice(API_PREFIX.length).replace(/\/(\w)/g, (_, c: string) => c.toUpperCase()).replace(/[^A-Za-z]/g, "") || "Index"}`,
      "x-scope": route.scope,
      security: route.tokenless ? [] : [{ token: [] }],
      parameters: [
        { $ref: "#/components/parameters/ApiVersion" },
        ...(route.params ?? []).map((p) => ({ name: p.name, in: "query", required: !!p.required, description: p.words, schema: { type: "string" } })),
      ],
      responses: {
        [route.method === "POST" ? "2XX" : "200"]: { description: "The answer, JSON.", content: { "application/json": { schema: { type: "object" } } } },
        ...(route.method === "GET" && !route.tokenless ? { "304": { description: "Not modified: the ETag sent in If-None-Match still holds (not counted against the rate limit)." } } : {}),
        "400": errorRef,
        "401": errorRef,
        "403": errorRef,
        "404": errorRef,
        "429": errorRef,
        "503": errorRef,
      },
    };
    if (route.body) {
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: Object.fromEntries(Object.entries(route.body).map(([k, words]) => [k, { description: words }])),
              required: Object.entries(route.body).filter(([, words]) => words.includes("(required)")).map(([k]) => k),
            },
          },
        },
      };
    }
    paths[path] = { [route.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "The registry's public API",
      version: API_VERSION,
      description:
        "Read and write the registry's own layer (repositories and their papers, research issues, stars, follows, notifications, outgoing webhooks, commit statuses) with a personal token. GitHub's own objects stay GitHub's: its API serves them. The reference, with examples: /developers/.",
    },
    servers: [{ url: "/" }],
    "x-versions": API_VERSIONS,
    "x-scopes": Object.fromEntries(SCOPES.map((s) => [s, SCOPE_WORDS[s]])),
    security: [{ token: [] }],
    components: {
      securitySchemes: {
        token: { type: "http", scheme: "bearer", description: "A personal token of the registry (oscr_pat_…), made on /settings/tokens/: scoped, expiring, revocable." },
      },
      parameters: {
        ApiVersion: { name: "X-Api-Version", in: "header", required: false, description: `The version asked, a date (${API_VERSIONS.join(", ")}); none: the current one.`, schema: { type: "string" } },
      },
      responses: {
        Error: {
          description: "A refusal in words.",
          headers: Object.fromEntries(EXPOSED.filter((h) => h.startsWith("X-") || h === "Retry-After").map((h) => [h, { schema: { type: "string" } }])),
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      message: { type: "string" },
                      request_id: { type: "string" },
                      documentation_url: { type: "string" },
                    },
                    required: ["code", "message", "request_id"],
                  },
                },
              },
            },
          },
        },
      },
    },
    paths,
  };
}
