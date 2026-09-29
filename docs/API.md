# The public API (night phase 10)

The registry's public API: read and write its own layer — repositories and their papers, research
issues, stars, lists and follows, notifications, outgoing webhooks, commit statuses — from a script, a
notebook, a lab's CI or another service. This page is for its users; the site's own reference is
`/developers/` (built from the Worker's routes), and the machine's description is
`/developers/openapi.json` (OpenAPI 3.1, built from the same routes: `website/scripts/openapi.ts`, a
test keeps the file equal to the routes). The decisions: [DECISIONS.md](DECISIONS.md) D10-1 onwards;
the automation around it (webhooks, statuses, checks): [AUTOMATION.md](AUTOMATION.md); the GitHub
side's contract: [FORGE.md](FORGE.md).

GitHub's own objects (commits, files, issues, pull requests, releases) stay GitHub's: GitHub's API
serves them, with GitHub's tokens. The registry's API serves what the registry adds. It never runs
code.

**Until phase 16's content rules are merged, only the registry's owner can make a token**
(`FORGE_OPEN`, D01-1): the API's reads and writes are the owner's until then.

## Authentication

- A **personal token** is made on `/settings/tokens/` (signed in, with the session's CSRF token):
  `oscr_pat_` and 43 base64url characters (256 random bits). It is shown **once**; the registry keeps
  only its SHA-256 (`api_tokens.digest`).
- Send it as `Authorization: Bearer oscr_pat_…` (`token oscr_pat_…` is read too).
- A token is **scoped** (below), **expires** after 1 to 366 days (30 by default; none lives for ever),
  can be **revoked** at once (its row deleted), and is listed with its **last use** (to the day). An
  account holds 20 at most.
- A token never makes or lists tokens: that is the settings page only, so a leaked token cannot give
  itself a successor.
- The API reads **no cookie**: the request reaches the route without its Cookie header. A browser's
  session never acts through the API, which therefore needs no CSRF token and answers any Origin (CORS
  `*`, no credentials).
- Every answer names the token's scopes (`X-Token-Scopes`), the scope the route needs
  (`X-Accepted-Scopes`) and the token's expiry (`X-Token-Expires`).

```sh
curl -H "Authorization: Bearer $TOKEN" https://<the site>/api/v1/user
```

### Scopes

A write grants the read of its area.

| scope | what it allows |
|---|---|
| `repos:read` | the registry's layer over repositories: their papers, their state, the commit statuses posted to it |
| `research:read` | research issues and their comments |
| `research:write` | open, comment on, edit, close and reopen research issues, as you |
| `social:read` | your stars, lists and follows, people's public profiles, your feed |
| `social:write` | star, list, follow and watch, change your profile, as you |
| `notifications:read` | your notifications (the registry's own inbox) |
| `notifications:write` | mark notifications read, done, saved; unsubscribe |
| `hooks:read` | your outgoing webhooks and their deliveries |
| `hooks:write` | make, change, test, redeliver and delete your webhooks |
| `statuses:write` | post commit statuses on the repositories the registry knows |

## Rate limits

- Per token: **60 requests a minute and 1,000 a day**. Every answer carries `X-RateLimit-Limit`,
  `X-RateLimit-Remaining`, `X-RateLimit-Used`, `X-RateLimit-Reset` (Unix seconds, the next 00:00 UTC)
  and `X-RateLimit-Resource: core`; past a limit, **429** `rate_limited` with `Retry-After`.
- `GET /api/v1/rate_limit` says where a token stands and is never counted; a **304** is given back.
- Writes also count toward the account's daily caps, as on the site (100 authorized actions and
  research writes, 300 social writes, 500 notification changes, 50 token and webhook changes, 300
  commit statuses), and toward the GitHub side's 5,000 rows a day.
- The counts live in the Worker isolate's memory (free, and no row written per request: D08-18), so
  they are a ceiling per isolate, not an exact global count (D10-4). When the registry's day of Worker
  requests is spent, every `/api/*` answers 429 until 00:00 UTC; the pages stay up.

## Pagination and conditional requests

- A list with more pages answers `Link: <…>; rel="next"` and a `next` field (the cursor: `?after=`).
- Every GET answer carries a weak `ETag` (the SHA-256 of its body); `If-None-Match` with it answers
  `304 Not Modified`, not counted against the rate limit.
- `HEAD` answers a GET's headers without its body.

## Errors

```json
{
  "error": {
    "code": "insufficient_scope",
    "message": "This token may not do this: it needs the scope social:read. Make a token with it in your settings.",
    "request_id": "u2Hn0cZ3VwQy8pKe",
    "documentation_url": "https://<the site>/developers/#errors"
  }
}
```

The request's id is also in `X-Request-Id`. The codes: `requires_authentication` (401, no token),
`bad_credentials` (401: not a token, revoked, account gone), `token_expired` (401),
`insufficient_scope` (403), `forge_closed` (403: `FORGE_OPEN`), `bad_payload` (400),
`unsupported_version` (400), `not_found` (404), `method_not_allowed` (405, with `Allow`), `too_large`
(413), `too_many` (429: an account's daily cap), `rate_limited` (429), `quota` (503: the day's rows
spent), `unavailable` (503), and the codes of the site's own routes (FORGE.md "Errors").

## Versions and breaking changes

The API is versioned by date. `X-Api-Version: 2026-09-29` pins a version; without it, the current one.
A version the API does not have is 400 `unsupported_version`. A breaking change adds a new date; the
previous version keeps answering as it did until its end, announced on `/developers/#changes`.

| version | since | changes |
|---|---|---|
| `2026-09-29` | the first | — |

## The routes

Under `/api/v1`. A POST takes JSON (`Content-Type: application/json`, 16 KiB at most for most
routes). The routes marked "the site's" run the site's own handler, with the person the token names
in place of a session (`who.ts`): the same payloads, validation, `FORGE_OPEN`, caps and rows as the
site's pages ([SOCIAL.md](SOCIAL.md), [ISSUES.md](ISSUES.md), [FORGE.md](FORGE.md)).

| route | scope | what |
|---|---|---|
| `GET /api/v1` | none (no token) | the index: version, routes, scopes |
| `GET /api/v1/user` | any | whose token this is (GitHub login, ORCID iD), its scopes and expiry |
| `GET /api/v1/rate_limit` | any | the token's use of its limits (never counted) |
| `GET /api/v1/search?q=&type=` | any | the site's search (papers, repositories, research issues, people, topics) |
| `GET /api/v1/repos?path=<owner>/<name>` or `?id=<forge>:<id>` | `repos:read` | the site's: the registry's layer over one repository |
| `GET /api/v1/repos/mine?after=&limit=&mode=&template=` | `repos:read` | the site's: your repositories the registry knows, paged by name |
| `GET /api/v1/research?id=` or `?paper=<doi>[&paper=…][&repo=<forge>:<id>]` | `research:read` | the site's: one research issue, or a paper's |
| `POST /api/v1/research/open` | `research:write` | the site's: `{paper, repo \| code, type, title, body?, commit?, path?, lines?, paragraph?, section?, report?, labels?}` → 201 `{id, page}` |
| `POST /api/v1/research/comment` | `research:write` | the site's: a comment, its edit, deletion or hiding |
| `POST /api/v1/research/edit` | `research:write` | the site's: title, text, close with a resolution, reopen, labels, lock, pin |
| `GET /api/v1/social?s=…` | `social:read` | the site's: your star, lists and follow of ≤ 20 subjects |
| `GET /api/v1/social/mine` | `social:read` | the site's: your stars, lists, follows, profile |
| `GET /api/v1/social/person?github=` or `?orcid=` | `social:read` | the site's: a person's public profile |
| `POST /api/v1/social/star`, `/follow`, `/list`, `/profile` | `social:write` | the site's: 2 rows each |
| `GET /api/v1/social/feed`, `/social/activity` | `social:read` | the site's: the feed, a person's activity |
| `GET /api/v1/notifications` | `notifications:read` | the site's: the inbox, computed now |
| `POST /api/v1/notifications/mark` | `notifications:write` | the site's: `{op, threads?, settings?}` |
| `GET /api/v1/hooks` | `hooks:read` | your webhooks, the events a subject offers |
| `GET /api/v1/hooks/deliveries?id=` | `hooks:read` | one webhook's deliveries of the last 7 days |
| `POST /api/v1/hooks/write` | `hooks:write` | `{op: create \| update \| ping \| redeliver \| rotate \| delete, …}` (AUTOMATION.md) |
| `GET /api/v1/statuses?path=&sha=` | `repos:read` | a commit's statuses posted to the registry, combined |
| `POST /api/v1/statuses/post` | `statuses:write` | `{repo, sha, state, context?, description?, target_url?}` → 201 |
| `POST /api/v1/statuses/actions` | GitHub Actions' OIDC token | the same body, from a workflow, without a registry token (AUTOMATION.md) |

Examples:

```sh
# Star a paper.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"subject": "paper:doi:10.1234/eeg.2026", "label": "EEG filters", "on": true}' \
  https://<the site>/api/v1/social/star

# Your unread notifications, only when they changed.
curl -H "Authorization: Bearer $TOKEN" -H 'If-None-Match: W/"…"' https://<the site>/api/v1/notifications

# A commit status from a lab's CI.
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"repo": "owner/name", "sha": "<40 characters>", "state": "success", "context": "lab-ci/tests"}' \
  https://<the site>/api/v1/statuses/post
```

## What it costs (PLATFORM_PLAN §15.6: ~8,000 requests a day for the API)

- One Worker request per call; the rows its route reads, by key; the rows its writes write (the same
  as the site's); a token's last use, 1 row at most once a day.
- No row is written to count requests (D10-4).

## Where the code is

| part | where |
|---|---|
| the router (CORS, versions, request ids, errors, ETag, Link, scopes, rate limits) | `website/worker/forge/service/api.ts` |
| tokens: what they are, their rows; the site's routes | `tokens-core.ts`, `tokens.ts` |
| a token on a request, the rate limits | `bearer.ts` |
| the person, from a token or a session | `who.ts` |
| the OpenAPI description | `openapi.ts`, `website/scripts/openapi.ts`, `website/public/developers/openapi.json` |
| the pages | `website/src/pages/settings/tokens.astro`, `developers/index.astro`; `src/scripts/tokens.ts`; `src/lib/automation.ts` |
| the tests | `website/tests/forge-service/tokens.test.ts`, `api.test.ts` |
