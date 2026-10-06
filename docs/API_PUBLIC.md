# The public read API

A free, keyless, read-only API over OSCR's catalogue. No account, no token, no sign-up: every route
answers a plain `GET` (and `HEAD`) and returns JSON, with CORS open to any origin. It returns only
facts (no PDF, no paper full text, no email address), the same records the pages are built from.

- **Overview page** (for readers): `/api/`
- **Guide** (curl, Python, R): `/help/api/`
- **Machine description**: `/api/v1/openapi.json` (live, this origin) and `/data/openapi.json` (static)

## Design: zero cost

Absolute zero cost (CLAUDE.md). The heavy data is static, served by Cloudflare's CDN (free, no rate
limit); the Worker is a thin convenience layer, and the only quota-bound endpoint is the search.

- **Static data** under `/data/`, built at site build time (`website/src/pages/data/`, shaped by
  `website/src/lib/apidata.ts`). A fixed number of files whatever the catalogue size, held by
  `npm run check` and `npm run check:growth`.
- **The Worker** (`website/worker/v1/index.ts`) resolves a DOI through the existing DOI lookup, reads
  the right static file through its `ASSETS` binding (free, not counted as a request), reshapes it
  into the envelope, and sets `Cache-Control: public, max-age=600`. On a custom domain a repeat call
  is served from the cache.
- Power users skip the Worker: every answer names the static `source` (or `bulk`) file it came from.

## Conventions

- **Methods**: `GET`, `HEAD`. `OPTIONS` returns `204` with the CORS headers (preflight). Anything
  else is `405`.
- **CORS**: `Access-Control-Allow-Origin: *`, methods `GET, HEAD, OPTIONS`, no credentials.
- **Envelope**: every answer is `{ "oscr_api": "v1", "self": "<url>", ...payload }`.
- **Errors**: `{ "error": "<code>", "message": "...", "documentation_url": "<site>/help/api/" }`.
  Status codes: `400` (`bad_doi`, `bad_key`, `bad_repository`, `bad_query`), `404` (`not_found`),
  `405` (`method_not_allowed`), `503` (`quota`, `unavailable`, `not_configured`). This is distinct
  from the site's own `/api/search`, which keeps `{ error: { code, message } }` unchanged.
- **Caching**: data answers carry `Cache-Control: public, max-age=600`; errors are `no-store`.

## Endpoints

All under `/api/v1`. The routes and the OpenAPI document share one source,
`website/src/lib/apispec.ts` (`ENDPOINTS`, `buildOpenapi`); a test and `check.mjs` hold them equal.

| Route | What | Data source |
|---|---|---|
| `GET /` | the index (links to every endpoint and the OpenAPI doc) | in code |
| `GET /openapi.json` | the OpenAPI 3.1 document, this origin as server | built from the routes |
| `GET /stats` | the catalogue's figures | `/data/stats.json` |
| `GET /paper/{doi}` | one paper's record | `/lookup/NN.json` to the slug, then `/data/papers/NN.json` |
| `GET /search` | full-text search (the one quota-bound endpoint) | D1 (wraps the site's search) |
| `GET /{authors\|journals\|institutions\|tools\|datasets}` | a list, paginated + the bulk file | `/data/entities/<type>.json` |
| `GET /{type}/{id}` | one entity by key | `/records/<type>/NN.json` (the site's own shard) |
| `GET /repository/{host}/{owner}/{name}` | one repository | `/data/repos/NN.json` |

- **DOI**: contains slashes. Give it URL-encoded in the path (`/paper/10.5555%2Fabcd`) or as
  `?doi=10.5555/abcd`. Matched case-insensitively, with or without a `https://doi.org/` prefix. A
  DOI that is read but has no page returns `{ page: false, status, day_read }` (no record).
- **Entity key**: an ORCID iD for an author, a ROR id for an institution, a slug otherwise
  (`keyOf` normalizes it: authors upper-cased, the rest lower-cased).
- **Pagination**: `page` (from 1), `size` (1 to 100, default 50). The answer carries `total`,
  `pages`, `next` and the `bulk` file (the whole list, unlimited).

## Bulk downloads

Under `/data/` (static, free, no rate limit, rebuilt nightly):

| File | What | Fixture size | Production size (flagged) |
|---|---|---|---|
| `articles.csv` | one row per paper | small | ~17 MB (under the 25 MiB asset limit) |
| `repositories.csv` | one row per repository | small | ~1.9 MB |
| `alignments.jsonl` | one object per aligned paper | small | ~17 MB |
| `entities/<type>.json` | the full entity lists | small | ~32 MB total across the types |
| `papers/NN.json`, `repos/NN.json` | sharded records | small | bounded (256 + 128 files) |

The authors' scripts (their text) are the separate public Hugging Face dataset
`OpenScientificCodeRegistry/Database` (see `docs/SCRIPT_STORAGE.md`, `/help/data/`).

**Not served**: a single full catalogue dump (the whole database in one file). The production
`data/public/oscr_public.db` is ~4.4 GB, `catalog.json` ~53 MB and `scripts.jsonl` ~2.6 GB, all over
the Worker's 25 MiB asset limit. `oscr public-export` writes the small public dump folder locally for
the owner. **Owner decision**: whether to publish a public *catalogue* dataset on Hugging Face (the
catalogue without the private `contact` table) is the operator's to make and publish nightly; nothing
here publishes it.

## The `/api/v1/` namespace, and the night forge (resolved at reconciliation)

The night "forge" branch planned an authenticated, token-based read/write layer that also lived
under `/api/v1/`. This keyless read API owns `/api/v1/`. The reconciliation (the `reconcile` branch)
resolved the overlap so the two never collide:

- the keyless read API **keeps `/api/v1/`**; a token is **never required to read** the catalogue;
- the forge's token API was **moved to `/api/forge/v1/`** (its one source, `API_PREFIX` in
  `website/worker/forge/service/api.ts`, plus its OpenAPI, the `/developers/` reference, the CLI and
  every forge test), and it **requires a token** (`401` without one);
- the forge's own OpenAPI document and the `/developers/` page describe `/api/forge/v1/`; this public
  API's OpenAPI (`/data/openapi.json`, `/api/v1/openapi.json`) still describes `/api/v1/`.

The forge routes stay behind `FORGE_OPEN` (unset), so the token API is dormant until the owner opens
the GitHub side. `CLAUDE.md` and `docs/RECONCILE_NOTES.md` record the decision.

## Rules honoured

- No email address (the records are email-free at build; `check.mjs` scans every `/data/*.json`).
- No PDF, no paper full text (a paper is linked by its DOI).
- A withdrawn paper is already absent from the catalogue; a withheld map carries no DOI; a file held
  back for its licence is never copied (its text is not in these files).
- The file budget holds whatever the catalogue size (fixed number of `/data/` files).
