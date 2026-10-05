# Accounts (Phase 5)

Sign-in with ORCID, GitHub and Google; sessions; roles; the automatic verification of authors
and maintainers. Built on branch `phase-5`, tested locally only. **Nothing here is deployed,
and nothing remote exists yet:** the steps marked **[owner]** are the owner's to run, when the
owner decides (decision D4: the owner creates the applications, ORCID sandbox first).

| piece | where |
|---|---|
| the community database, `oscr_community` (binding `COMMUNITY`) | `migrations/d1-community/0001_accounts.sql` |
| the facts the verifications need, pushed by the Mac | `oscr/community.py`, `oscr community build\|push --local` |
| the Worker's code: `/api/auth/*`, `/api/account/*` | `website/worker/account/` (`handleAccount`) |
| the account page | `website/src/pages/account.astro`, `website/src/scripts/account.ts` |
| the tests | `tests/test_community.py`, `website/tests/account/` |
| local development | `[env.local]` of `website/wrangler.toml`, `website/.dev.vars.example` |

Cost: **zero**. ORCID's public API and sign-in are free for non-commercial use, which OSCR is;
GitHub OAuth Apps and Google's OpenID Connect sign-in are free; D1 and the Worker stay within
Cloudflare's free plan (figures below).

## What is kept, and what never is

- **No email address, anywhere.** ORCID and Google are asked for the `openid` scope only (no
  `email`, no `profile`); GitHub for no scope at all (public information only). GitHub's `/user`
  answer may carry the account's public address: only `id`, `login` and `name` are read. A name
  that contains an address loses it (`cleanName`), and the schema refuses an at sign in a name.
  Notifications will stay in the site (decision D5).
- **No provider token.** The access token is used during the callback (GitHub's `/user`, the
  maintainer checks), then dropped. A maintainer check asks GitHub again for a fresh one.
- **No session id.** The cookie holds a random 256-bit id; D1 holds its SHA-256.
- **What is kept:** the name a provider gives (ORCID's public name, GitHub's name or login;
  Google gives none with `openid` alone), the public handles (ORCID iD, GitHub login), the
  providers' subject ids, the roles, the claims with their evidence (the GitHub login and id,
  and how the check succeeded), and per session a short hint ("Firefox on macOS").

## The database: `oscr_community`

Schema: `migrations/d1-community/0001_accounts.sql`. Times are Unix seconds.

| table | columns | written by |
|---|---|---|
| `users` | `id` (random, `u_…`), `display_name` (no at sign), `orcid`, `github_login`, `created_at` | Worker |
| `identities` | `provider` (orcid, github, google), `subject`, `user_id`, `linked_at`; key (provider, subject) | Worker |
| `sessions` | `id_hash` (SHA-256 of the cookie's id), `user_id`, `created_at`, `expires_at`, `last_seen_at`, `user_agent_hint` | Worker |
| `roles` | `user_id`, `role` (member, verified_author, maintainer, moderator, admin), `scope_kind` (paper, repo, '' for global), `scope_id`, `granted_by` (system or a user id), `granted_at` | Worker |
| `claims` | `id`, `user_id`, `kind` (author, maintainer), `paper_id` or `repo`, `evidence` (JSON), `status` (pending, verified, rejected), `created_at`, `decided_by`, `decided_at` | Worker |
| `paper_orcid` | `orcid`, `paper_id`, `slug`, `title`; key (orcid, paper_id) | the Mac |
| `repo_owner` | `repo` (the Mac's key, `github.com/owner/name`), `host`, `owner` | the Mac |

- `member` is implied for every user: it is not stored (one row written less per account).
- **Every index costs a write**, so there are three, each for a query that would otherwise read
  a whole table:
  - `identities_user` (identities by user): the account page's list, and the "one identity per
    provider" check. One more row per identity linked.
  - `sessions_user` (sessions by user): a sign-in deletes the user's expired sessions; a later
    "sign out everywhere" deletes all. One more row when a session is created; the hourly and
    daily updates do not touch it.
  - `claims_user_target`, unique (user, kind, paper, repo): one claim per target (a new request
    updates it) and the account page's list. One more row per claim created.
- The tables keyed by text are `WITHOUT ROWID` (a rowid table would add a hidden unique index,
  one more row per insert); `claims` uses its rowid (`INTEGER PRIMARY KEY`, no AUTOINCREMENT).
  `roles`, `paper_orcid` and `repo_owner` are read by their key's prefix: no index. Phase 6 needed
  no index "verified authors of a paper" either: all its queries read a person's own roles.

## The facts: `oscr community`

`oscr/community.py` builds from the Mac's database:

- `paper_orcid`: the ORCID iDs (with a valid check digit) of the authors of the papers that
  have a page (decisions D2 and D7: authors' code, code on request, data only; never an
  off-topic paper), from `paper_author`, the public metadata the paper page shows — never from
  the private contact table; with the page's slug and the title (contact details stripped).
- `repo_owner`: the owners of those papers' code repositories, on the forges whose addresses
  name an owner (github.com, gitlab.com and GitLab instances, bitbucket.org, codeberg.org,
  gin.g-node.org, gitee.com, framagit.org). A Zenodo or OSF record has no owner: it is not there.

It pushes **deltas only**: the state file `data/community/state.db` keeps a hash of every row
pushed (`community_sync`); a push sends the new and changed rows and deletes the rows that left,
deletions first, within a daily budget (default 10,000 rows, `--budget`; see "The free plan").

```sh
oscr community build --local      # the delta as SQL files, data/community/local-<time>/NNN-oscr_community.sql
oscr community push --local       # the same, applied to the local D1 of `wrangler dev`, then recorded
oscr community push --remote      # the same, to the Cloudflare database (Phase 6)
oscr community status             # what each target holds, the rows written per day
```

`--remote` goes the way of the catalogue's `oscr d1 push --remote`: the REST API when
`OSCR_D1_ACCOUNT_ID`, `OSCR_D1_COMMUNITY_ID` (settings) and the keychain's token
(`org.oscr.cloudflare-d1`) are there, otherwise `wrangler d1 execute oscr_community --remote
--file` under wrangler's own login. `oscr nightly` pushes there once `OSCR_COMMUNITY_PUSH=remote` is
in the settings. Phase 6 adds a third table, `paper_repo` (which forge repository is the code of
which paper: its maintainers may correct that record), and counts the Mac's answers to the site's
requests (`oscr jobs`) in the same daily budget ([CONTRIBUTIONS.md](CONTRIBUTIONS.md)).

## The routes

All under `/api/`, answered by the Worker's code (`run_worker_first = ["/api/*"]`); every answer
has `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

| route | what | answer |
|---|---|---|
| `GET /api/auth/{orcid,github,google}/start?return=/path/` | starts a sign-in; `return`: a path of this site, its query kept (`/removal/?paper=doi%3A…`, 2026-09-29), never another site, an API route, a fragment or a backslash (`http.ts`, `returnPath`) | 302 to the provider, and the flow cookie |
| `GET /api/auth/{orcid,github,google}/callback` | the provider's return | 302 to the page (after its own query, `&signed_in=<p>`), `?signed_in=<p>`, `?linked=<p>`, `?maintainer=verified\|pending\|rejected\|unavailable&repo=…` or `?error=<code>&provider=<p>` |
| `GET /api/account/me` | the account | 200 `{signed_in: false, available, providers}` or the account (below) |
| `POST /api/account/signout` | ends the session | 200 `{signed_in: false}`, the cookie cleared |
| `POST /api/account/authorship` | the author verification, again | 200 `{granted, revoked, papers}`; 409 `no_orcid` |
| `POST /api/account/maintainer` `{"repo": "…"}` | a maintainer claim | 200 `{status: "redirect", url}` (a GitHub check), 200 `{status: "verified", already: true}`, 202 `{status: "pending", claim}` (not GitHub); 400 `bad_repo`, 404 `unknown_repo`, 429 `too_many_claims` |

Signed in, `/api/account/me` answers:

```json
{
  "signed_in": true, "available": true,
  "user": {"display_name": "Ada Fixture", "created_at": "2026-09-27T20:10:13.000Z"},
  "handles": {"orcid": "0000-0000-0000-001X", "github": "ada-fixture"},
  "identities": [{"provider": "orcid", "label": "ORCID", "handle": "0000-0000-0000-001X",
                  "url": "https://orcid.org/0000-0000-0000-001X", "linked_at": "…"}],
  "providers": [{"name": "google", "label": "Google", "linked": false, "start": "/api/auth/google/start?return=/account/"}],
  "roles": [{"role": "member", "scope_kind": "", "scope_id": "", "automatic": true, "granted_at": "…"},
            {"role": "verified_author", "scope_kind": "paper", "scope_id": "doi:10.5555/oscr.fixture.1", "automatic": true, "granted_at": "…"}],
  "papers": [{"id": "doi:10.5555/oscr.fixture.1", "doi": "10.5555/oscr.fixture.1", "title": "…", "url": "/paper/doi_10.5555_oscr.fixture.1/"}],
  "repositories": [{"repo": "github.com/oscr-fixture/eeg-analysis", "url": "https://github.com/oscr-fixture/eeg-analysis"}],
  "claims": [{"id": 1, "kind": "maintainer", "repo": "github.com/oscr-fixture/eeg-analysis", "paper_id": "",
              "status": "verified", "via": "contributor", "created_at": "…", "decided_at": "…"}],
  "csrf": "…"
}
```

Error answers are `{"error": {"code", "message"}}`: `signed_out` (401), `bad_origin`,
`bad_csrf` (403), `not_configured`, `unavailable`, `quota`, `unavailable_provider` (503).

## How it works

**Sign-in.** Authorization code flow, the same for the three providers:

1. `start` makes a `state`, a PKCE verifier and, for ORCID and Google, a nonce (32 random bytes
   each). They go into the flow cookie `__Host-oscr_flow` (10 minutes, HMAC-signed with the
   server key); the provider receives the state, the verifier's SHA-256 (`S256`) and the nonce.
2. `callback` needs the flow cookie, its signature, and the same state (constant-time), else
   `expired`: a callback cannot be forged or replayed from another browser (login CSRF).
3. The code is exchanged server to server, with the client secret and the verifier.
4. ORCID and Google: the ID token is verified with WebCrypto, RS256 only, against the
   provider's published keys (fetched once per isolate and hour, again for an unknown key id):
   issuer, audience (and authorized party), expiry, issue time, and the nonce. ORCID's `sub` must
   be an ORCID iD with a valid check digit, and match the token answer's `orcid`. GitHub: `GET
   /user` with the token.
5. The identity finds its account, or a new one is made. **A flow started while signed in links
   the identity to that account** — only if the same session is still there at the callback,
   and never an identity another account holds (`identity_in_use`), nor a second one of a
   provider (`provider_already_linked`). A flow started signed out never links.
6. A new session: a new random id, the browser's previous session deleted. Then the author
   verification (below), and the redirect back.

PKCE with ORCID: ORCID does not document it; RFC 6749 §3.1 and §3.2 have servers ignore
unknown parameters, so the flow works either way, protected then by the client secret, the state
and the nonce. `ORCID_PKCE=off` stops sending it should the server ever refuse it.

**Sessions.** `__Host-oscr_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`, 30
days (`Max-Age=2592000`). D1 keeps only the id's SHA-256. The expiry slides at most once a day
(the cookie is then sent again); `last_seen_at` moves at most once an hour. Signing out deletes
the row. A sign-in deletes the user's expired sessions. Since Phase 6, a second cookie goes with
it, `__Host-oscr_signed_in=1` (not `HttpOnly`: the pages read it; it grants nothing): a paper's page
asks the Worker only when it is there, so a signed-out reader's page view costs no request.

**CSRF.** Every state-changing route is a POST under `/api/account/`, and needs: the session;
`X-CSRF-Token`, an HMAC of the session's id hash under the server key (bound to the session,
stored nowhere, new at each sign-in; `/me` gives it to the page); an `Origin` equal to the site's
(and `Sec-Fetch-Site: same-origin` when the browser sends it). A GET never changes anything.

**Author verification**, automatic: at every sign-in of an account with an ORCID iD, and on
request (`POST /api/account/authorship`, "Check my papers again"), the account's
`verified_author` roles become exactly the papers `paper_orcid` lists for its iD — two
statements whatever the number of papers. A role a moderator grants is never touched.

**Maintainer verification**, on request (`POST /api/account/maintainer`): the repository must
be in `repo_owner`.

- On GitHub, the Worker needs a fresh token of the person's GitHub account (it keeps none): the
  answer is a redirect through GitHub, immediate once the application is authorized, linking the
  GitHub account on the way if the account had none (and refusing another one than the linked
  one, `other_github_account`). The callback then checks, stopping at the first yes, with the
  person's token (their 5,000 requests an hour, not the Worker's shared 60): the login is the
  owner in `repo_owner` (no request); a public member of the owning organization (`GET
  /orgs/{owner}/public_members/{login}`, 204); a public contributor (`GET
  /repos/{owner}/{name}/contributors?per_page=100`); when that list is full or refused, a commit
  of the login (`GET /repos/{owner}/{name}/commits?author={login}&per_page=1`). Three API
  requests at most, plus the token exchange and `/user`. Yes: the `maintainer` role and a
  verified claim with its evidence. No: a pending claim. GitHub unavailable: nothing is decided.
- Elsewhere (GitLab, Codeberg…): a pending claim at once. Moderation comes with Phase 7.
- At most 20 claims pending per account.

**The page's own headers** (`website/public/_headers`): `/account/` may not be framed
(`X-Frame-Options: DENY`, `frame-ancestors 'none'`) and runs this site's files only
(`Content-Security-Policy`, `script-src 'self'`); it has no inline script or style.

## The free plan

**D1 writes, as local D1 counts them** (`ACCOUNT_DEV_METRICS=1`, `tests/account/e2e.sh`; D1
counts one more row for each index an insert touches):

| action | rows written |
|---|---|
| first sign-in, GitHub or Google (the user, the identity and its index entry, the session and its index entry) | 5 |
| first sign-in, ORCID, author of *n* papers | 5 + *n* (7 with 2 papers) |
| returning sign-in (the session and its index entry; papers unchanged) | 2 (+1 per paper verified or revoked, +1 if the browser had an older session, +1 if the GitHub login changed) |
| linking another provider (the identity and its index entry, the account's handle) | 3 (+ *n* for ORCID) |
| an active session's upkeep (`last_seen_at`, the daily slide) | at most 1 an hour |
| `GET /api/account/me`, a check that changes nothing | 0 |
| sign-out | 1 |
| maintainer claim: verified / pending | 3 / 3 (since Phase 6, a pending claim also writes its job for the owner) |

Rows read: 15 for `/api/account/me`, 16 for a first ORCID sign-in, 17 for a returning one.

**The share of the day.** D1's free plan writes 100,000 rows a day for the whole account. Proposed:
the catalogue's projection (Phase 3) 80,000, this facts push 10,000, the Worker's own writes the
remaining 10,000 — some 2,000 new accounts or 5,000 returning sign-ins a day. The facts' first
load at the full neuro stock (150–270k ORCID-paper pairs) then takes two to four weeks of pushes;
after that, only deltas.

**Worker requests.** A sign-in costs 3 of the 100,000 a day (start, callback, the page's `/me`);
the page itself is a static asset (free). A maintainer check costs 3 too.

**CPU**, measured in Node (V8, as workerd): an RS256 verification 0.05 ms once the keys are
fetched, an HMAC or a SHA-256 0.02 ms; a whole GitHub sign-in (start, callback, `/me`, the mock
provider and the test database included) 0.9 ms. Far under the 10 ms of the free plan.

**Subrequests** (50 allowed): a sign-in makes 1–3 (the token exchange; the keys, once per isolate
and hour; GitHub's `/user`); a maintainer check at most 5.

## The owner's steps [owner]

Every step costs nothing. None is needed for the local tests.

### 1. ORCID (sandbox first, then production)

1. **Sandbox.** Create an account on https://sandbox.orcid.org with an address at
   `@mailinator.com` (the sandbox only sends mail there; verify it on mailinator.com).
2. https://sandbox.orcid.org/developer-tools → "Register for the free ORCID public API":
   - name: the platform's name (`SITE_NAME`); website: https://oscr.yannbellec-b.workers.dev;
     description: "Sign-in of authors to the registry, to validate their papers' records."
   - **redirect URIs**, exactly:
     - `https://oscr.yannbellec-b.workers.dev/api/auth/orcid/callback`
     - `http://localhost:8787/api/auth/orcid/callback` (local development; the sandbox accepts
       http on localhost, production does not)
3. Keep the **client id** (`APP-…`) and the **client secret**.
4. **Production**, when the owner decides: the same at https://orcid.org/developer-tools with a
   real ORCID account (https redirect URI only), then `ORCID_ISSUER=https://orcid.org`. The
   public API is free for non-commercial use.
5. Scope: `openid` (the Worker asks for nothing else).

### 2. GitHub (an OAuth App; one callback address each, hence two)

1. https://github.com/settings/developers (or the organization's settings) → "OAuth Apps" →
   "New OAuth App":
   - name: `SITE_NAME`; homepage: https://oscr.yannbellec-b.workers.dev
   - **authorization callback URL**: `https://oscr.yannbellec-b.workers.dev/api/auth/github/callback`
   - "Enable Device Flow": no.
2. "Generate a new client secret"; keep the **client id** and the **secret**.
3. A second OAuth App for local development, callback
   `http://localhost:8787/api/auth/github/callback`: its values go to `website/.dev.vars` only.
4. Scope: none. The Worker asks for none (public information only), never `user:email`. PKCE
   (S256) is supported by GitHub since July 2025.

### 3. Google (Google Cloud Console)

1. https://console.cloud.google.com → a new project (no billing account is needed).
2. "Google Auth Platform" (formerly "OAuth consent screen"):
   - **Branding**: the app name (`SITE_NAME`), a user support address (Google shows it on the
     consent screen: a dedicated address is best), the home page
     https://oscr.yannbellec-b.workers.dev, the developer contact.
   - **Audience**: External. While "Testing", only the listed test users can sign in; "Publish
     app" when ready: with the `openid` scope alone, no verification is required.
   - **Data access**: the scope `openid` only (not `email`, not `profile`).
3. **Clients** → "Create client" → "Web application"; **authorized redirect URIs**, exactly:
   - `https://oscr.yannbellec-b.workers.dev/api/auth/google/callback`
   - `http://localhost:8787/api/auth/google/callback`
4. Keep the **client id** (`….apps.googleusercontent.com`) and the **client secret**: Google shows
   the secret only once, when the client is created.

### 4. The Cloudflare secrets

`sh tools/setup_cloudflare.sh` (from the repository's root) does this step and the next: it makes
`SESSION_KEY` itself and asks for the six values, one by one, without showing them. By hand:

From `website/`, the owner's own terminal (each command asks for the value; none is ever written
to a file of the repository):

```sh
openssl rand -base64 48                        # the server key: paste it into the next command
npx wrangler secret put SESSION_KEY
npx wrangler secret put ORCID_CLIENT_ID
npx wrangler secret put ORCID_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

`ORCID_ISSUER` is not secret: the sandbox is the default; for production, `[vars]
ORCID_ISSUER = "https://orcid.org"` in `wrangler.toml` (or one more `secret put`). Note that
`wrangler secret put` deploys the Worker's current version with the new secret: run these when
the Worker with the accounts is to go live. A provider whose id or secret is missing is simply not
offered ("not set up yet"); so is everything while `SESSION_KEY` or the database is missing.

Changing `SESSION_KEY` ends every sign-in in progress and invalidates the CSRF tokens (the pages
reload them); the sessions themselves stay valid.

### 5. The database

```sh
cd website
npx wrangler d1 create oscr_community        # prints the database id
# then in wrangler.toml, the COMMUNITY block below ("Integration"), with that id
npx wrangler d1 migrations apply oscr_community --remote
```

Then the facts: `oscr community push --remote`, and every night with `OSCR_COMMUNITY_PUSH=remote`
in the settings.

## Local development

```sh
cd website && npm ci
cp .dev.vars.example .dev.vars        # then the DEVELOPMENT applications' values (gitignored)
CATALOG_DIR=../tests/fixtures/public-catalog npm run build
cd .. && uv run python tools/make_fixture.py --database data/fixture.db
uv run oscr --db data/fixture.db community push --local   # the migration, then the facts, into the local D1
cd website && npx wrangler dev --env local   # http://localhost:8787/account/
```

**Tests.** `npm test` (in `website/`: node:test with Node's own TypeScript support and
node:sqlite, no dependency; 63 tests for the accounts, 135 with the search's and the contributions')
and `uv run pytest -q tests/test_community.py`.

**Local end-to-end run.** `sh tests/account/e2e.sh` (in `website/`, after the build): a throwaway
local D1 with the fixture's facts, the mock providers (`tests/account/mock-server.ts`: ORCID,
GitHub and Google with a key pair made at start), `wrangler dev` with development values only,
then `tests/account/e2e.ts`: sign-in with each provider, linking, author and maintainer
verification, CSRF refusals, sign-out, and D1's count of rows written per step.

## Integration with the site's Worker (Phase 3)

Done. The Worker's entry, `website/worker/index.ts`, routes `/api/auth/*` and `/api/account/*`
to `handleAccount` (its `ROUTES` table; a path under those prefixes the accounts do not know is
a 404), and its `Env` extends the accounts' (`worker/env.ts`). Both prefixes are already under
`run_worker_first = ["/api/*"]`.

`website/wrangler.toml` holds the `COMMUNITY` block, commented like the search's until the
owner creates the database (step 5 above), and the local one under `[env.local]`:

```toml
[[d1_databases]]
binding = "COMMUNITY"
database_name = "oscr_community"
database_id = "<the id printed by npx wrangler d1 create oscr_community>"
migrations_dir = "../migrations/d1-community"
```

Until it is bound, `/api/account/me` answers `{"signed_in": false, "available": false}` and the
account page says that signing in is not set up yet; the rest of the site deploys as before.

## Limits and what comes next

- No account deletion, no unlinking, no "sign out everywhere" yet (the index is there).
- Maintainer claims only for forge repositories (Zenodo, OSF… have no owner in their address).
  Author claims by hand (a paper whose metadata lacks the iD) are built (Phase 6); pending claims
  are decided by the owner (`oscr claims`) until the moderation of Phase 7.
- A renamed or transferred GitHub repository keeps the owner the Mac recorded until the Mac
  re-reads it.
- No rate limit per account or address yet beyond the 20 pending claims (Turnstile, and limits
  stored in D1, come with the public forms).
- The owner's steps above. (The remote push of the facts is built: Phase 6.)

## Account security and lifecycle (night phase 09)

The account security page, `/account/security/`, and its routes (`website/worker/forge/service/
account-security.ts`, `webauthn.ts`; full detail in `docs/ORGANIZATIONS.md`):

- **Sessions**: a person lists the browsers signed in (the `sessions` table, `account/session.ts`),
  with the current one flagged, and revokes one or all the others. Revoking is a true delete of the
  session row, so its cookie is then worth nothing. Not gated by FORGE_OPEN; the `security` cap applies.
- **Identities**: ORCID, GitHub and Google are listed; a person may unlink one, never the last.
- **Passkeys (WebAuthn)**: a step up for sensitive actions (sudo mode), not the first sign-in. The
  Worker verifies a registration and an assertion itself with WebCrypto only (no dependency, nothing
  paid) and keeps only a PUBLIC key (ES256 or RS256). Origin, challenge, rpId and the sign counter are
  checked; the challenge lives in a server-signed cookie, never in D1. Sudo mode lasts 600 seconds.
- **The personal security log** records each event and exports as CSV. No email address is read or
  stored anywhere; security messages stay in the site.

Account EXPORT and DELETION are the phase 16 data-rights self-service; the rest of the account
lifecycle (a username change with the old handle redirecting, a successor, moving work to an
organization, merging two accounts, a deceased user's account) is deferred (D09-8).
