// The public read API's shape, in ONE place: its endpoints, their parameters, and the OpenAPI
// document built from them. No file, no network, no Node: the Worker (worker/v1/), the build
// (src/pages/data/openapi.json.ts), the pages (/api/, /help/api/) and the drift test all import
// this, so the reference and the code can never disagree (a test holds them equal).
//
// The API is free, keyless and read-only (GET and HEAD). Everything it returns is public: the same
// records the site's pages are built from, no email address, no paper full text (every rule of
// CLAUDE.md holds). Heavy data is in static files under /data/ (served by the CDN, free and
// without a rate limit); the Worker adds the conveniences (DOI resolution, search) with CORS and
// cache headers so repeat calls are served from the cache.

/** The version segment of every route. Bumped only for a breaking change (see the guide). */
export const API_VERSION = "v1";
/** The path every route hangs off. */
export const API_BASE = `/api/${API_VERSION}`;
/** Where every error and every page sends the reader for the full reference. */
export const API_DOCS = "/help/api/";
/** The static files the API points to, the "no rate limit" path (served by the CDN). */
export const DATA_BASE = "/data";

/** How many files /data/repos/ holds at most (a power of two; the repositories are far fewer than
 *  the papers). Shared by the build (apidata.ts), the checks (check.mjs, growth.mjs) and the Worker
 *  (worker/v1/), so the shard rule is one rule. */
export const REPO_SHARDS = 128;

/** The other /data/ files besides the paper and repository shards: the six entity lists, the three
 *  bulk exports (articles.csv, repositories.csv, alignments.jsonl), stats.json and openapi.json. */
export const DATA_FIXED_FILES = 11;

/** A parameter of an endpoint, described once for the dispatch, the reference and the pages. */
export type ApiParam = {
  name: string;
  in: "path" | "query";
  required: boolean;
  type: "string" | "integer";
  description: string;
  example?: string;
};

/** One endpoint. `id` keys the Worker's handler (worker/v1/index.ts) and the drift test; `path`
 *  is its OpenAPI template under API_BASE ("" is the index itself). */
export type ApiEndpoint = {
  id: string;
  method: "GET";
  /** The template under API_BASE, with {braces} for path parameters ("" = the API index). */
  path: string;
  summary: string;
  description: string;
  params: ApiParam[];
  /** A ready example path (under API_BASE) for the pages and the reference. */
  example: string;
  /** Whether a call counts against the search's shared daily quota (search only). */
  quota?: boolean;
};

/** Every endpoint of the public read API. The order is the order the reference lists them. */
export const ENDPOINTS: readonly ApiEndpoint[] = [
  {
    id: "index",
    method: "GET",
    path: "",
    summary: "The API index",
    description: "Links to every endpoint and to the OpenAPI document. Start here.",
    params: [],
    example: "",
  },
  {
    id: "openapi",
    method: "GET",
    path: "/openapi.json",
    summary: "The OpenAPI document",
    description: "A machine-readable OpenAPI 3.1 description of every endpoint, generated from the routes themselves.",
    params: [],
    example: "/openapi.json",
  },
  {
    id: "stats",
    method: "GET",
    path: "/stats",
    summary: "The catalogue's figures",
    description: "The counts the site is built from: papers, papers with code, repositories, scripts, matches, and more.",
    params: [],
    example: "/stats",
  },
  {
    id: "paper",
    method: "GET",
    path: "/paper/{doi}",
    summary: "One paper's record",
    description:
      "The record of a paper by its DOI: its code links, repositories, data links, status, tools, categories and a " +
      "matches summary. No PDF and no full text (the paper is linked by its DOI). Email addresses are never shown. " +
      "The DOI contains slashes: give it URL-encoded in the path, or as the ?doi= query parameter.",
    params: [
      { name: "doi", in: "path", required: false, type: "string", description: "The paper's DOI, URL-encoded (or use ?doi=).", example: "10.5555%2Foscr.fixture.1" },
      { name: "doi", in: "query", required: false, type: "string", description: "The paper's DOI, in place of the path (no encoding needed).", example: "10.5555/oscr.fixture.1" },
    ],
    example: "/paper/10.5555%2Foscr.fixture.1",
  },
  {
    id: "search",
    method: "GET",
    path: "/search",
    summary: "Search the catalogue",
    description:
      "Full-text search over the papers, with the same query language and filters as the site's search. This is the " +
      "ONLY endpoint bound by a quota: each call counts against the site's shared daily free database budget, so call " +
      "it sparingly and cache its answers. Everything else (the static files and the dataset) is unlimited.",
    params: [
      { name: "q", in: "query", required: false, type: "string", description: "The query (the search guide's language).", example: "eeg" },
      { name: "type", in: "query", required: false, type: "string", description: "A result type filter (kept for compatibility with the site's form).", example: "" },
      { name: "field", in: "query", required: false, type: "string", description: "A field filter (kept for compatibility with the site's form).", example: "" },
      { name: "page", in: "query", required: false, type: "integer", description: "The page of results (from 1).", example: "1" },
      { name: "size", in: "query", required: false, type: "integer", description: "Results per page (1 to 50).", example: "20" },
    ],
    example: "/search?q=eeg&size=20",
    quota: true,
  },
  {
    id: "authors",
    method: "GET",
    path: "/authors",
    summary: "The authors",
    description: "A page of the authors, and the static file that holds them all (the no-rate-limit bulk path).",
    params: [
      { name: "page", in: "query", required: false, type: "integer", description: "The page (from 1).", example: "1" },
      { name: "size", in: "query", required: false, type: "integer", description: "Items per page (1 to 100).", example: "50" },
    ],
    example: "/authors?size=50",
  },
  {
    id: "journals",
    method: "GET",
    path: "/journals",
    summary: "The journals",
    description: "A page of the journals, and the static file that holds them all.",
    params: [
      { name: "page", in: "query", required: false, type: "integer", description: "The page (from 1).", example: "1" },
      { name: "size", in: "query", required: false, type: "integer", description: "Items per page (1 to 100).", example: "50" },
    ],
    example: "/journals?size=50",
  },
  {
    id: "institutions",
    method: "GET",
    path: "/institutions",
    summary: "The institutions",
    description: "A page of the institutions, and the static file that holds them all.",
    params: [
      { name: "page", in: "query", required: false, type: "integer", description: "The page (from 1).", example: "1" },
      { name: "size", in: "query", required: false, type: "integer", description: "Items per page (1 to 100).", example: "50" },
    ],
    example: "/institutions?size=50",
  },
  {
    id: "tools",
    method: "GET",
    path: "/tools",
    summary: "The tools and libraries",
    description: "A page of the tools, and the static file that holds them all.",
    params: [
      { name: "page", in: "query", required: false, type: "integer", description: "The page (from 1).", example: "1" },
      { name: "size", in: "query", required: false, type: "integer", description: "Items per page (1 to 100).", example: "50" },
    ],
    example: "/tools?size=50",
  },
  {
    id: "datasets",
    method: "GET",
    path: "/datasets",
    summary: "The datasets",
    description: "A page of the datasets, and the static file that holds them all.",
    params: [
      { name: "page", in: "query", required: false, type: "integer", description: "The page (from 1).", example: "1" },
      { name: "size", in: "query", required: false, type: "integer", description: "Items per page (1 to 100).", example: "50" },
    ],
    example: "/datasets?size=50",
  },
  {
    id: "entity",
    method: "GET",
    path: "/{type}/{id}",
    summary: "One author, journal, institution, tool or dataset",
    description:
      "One entity by its key: an ORCID iD for an author, a ROR id for an institution, a slug for a journal, tool or " +
      "dataset. `type` is one of author, journal, institution, tool, dataset (singular). The record lists the papers " +
      "its page lists (the most recent, capped), with a link to search for the rest.",
    params: [
      { name: "type", in: "path", required: true, type: "string", description: "author, journal, institution, tool or dataset.", example: "author" },
      { name: "id", in: "path", required: true, type: "string", description: "The entity's key (ORCID iD, ROR id or slug).", example: "0000-0000-0000-0028" },
    ],
    example: "/author/0000-0000-0000-0028",
  },
  {
    id: "repository",
    method: "GET",
    path: "/repository/{host}/{owner}/{name}",
    summary: "One code repository",
    description:
      "A repository the registry knows, by its host, owner and name (github.com/owner/name): its licence, state, " +
      "pinned commit, file and script counts, languages, and the papers that cite it as their authors' code. The code " +
      "text is never here: read it in the Code to Paper reader on a paper's page, or from the scripts dataset.",
    params: [
      { name: "host", in: "path", required: true, type: "string", description: "The forge host.", example: "github.com" },
      { name: "owner", in: "path", required: true, type: "string", description: "The owner or organisation.", example: "oscr-fixture" },
      { name: "name", in: "path", required: true, type: "string", description: "The repository name.", example: "eeg-analysis" },
    ],
    example: "/repository/github.com/oscr-fixture/eeg-analysis",
  },
] as const;

/** The entity types the list and entity endpoints cover (singular keys). */
export const API_ENTITY_TYPES = ["author", "journal", "institution", "tool", "dataset"] as const;
export type ApiEntityType = (typeof API_ENTITY_TYPES)[number];
/** The list endpoint id of a type (/authors, /journals, …: the plural). */
export const LIST_ID: Readonly<Record<ApiEntityType, string>> = {
  author: "authors",
  journal: "journals",
  institution: "institutions",
  tool: "tools",
  dataset: "datasets",
};

/** The error body every endpoint returns on a failure: a stable, documented shape. */
export type ApiError = { error: string; message: string; documentation_url: string };
export function apiError(code: string, message: string, origin = ""): ApiError {
  return { error: code, message, documentation_url: `${origin}${API_DOCS}` };
}

/** The OpenAPI 3.1 document, built from ENDPOINTS. `origin` names the server ("" for a relative
 *  one). A test asserts that its paths are exactly ENDPOINTS', so the reference never drifts. */
export function buildOpenapi(origin = ""): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const e of ENDPOINTS) {
    const openapiPath = `${API_BASE}${e.path}`;
    const parameters = e.params.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      description: p.description,
      schema: { type: p.type },
      ...(p.example !== undefined ? { example: p.example } : {}),
    }));
    paths[openapiPath] = {
      get: {
        operationId: e.id,
        summary: e.summary,
        description: e.description,
        ...(parameters.length ? { parameters } : {}),
        responses: {
          "200": { description: "The record, as JSON.", content: { "application/json": {} } },
          "404": { description: "No such record.", content: { "application/json": {} } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "OSCR public read API",
      version: API_VERSION,
      description:
        "A free, keyless, read-only API over the Open Scientific Code Registry's catalogue. GET and HEAD only. " +
        "See the guide at " + API_DOCS + " for examples, pagination, the data licence and how to cite OSCR.",
    },
    servers: [{ url: `${origin}${API_BASE}` }],
    paths: Object.fromEntries(Object.entries(paths).map(([k, v]) => [k.slice(API_BASE.length) || "/", v])),
  };
}
