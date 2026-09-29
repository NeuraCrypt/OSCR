# Contributions (Phase 6)

What a signed-in reader asks of the registry — submit a paper and its code, claim a paper, correct a
record, validate a tracing map, add the badge, request a removal — and how the Mac answers. Live since
2026-09-28.
The steps marked **[owner]** are at the end.

| piece | where |
|---|---|
| the tables (D1 `oscr_community`, migrations 2 and 3) | `migrations/d1-community/0002_contributions.sql`; `0003_removal_requests.sql` (the removal request made whole, 2026-09-29) |
| the routes (the Worker's code) | `website/worker/contributions/` (`handleContributions`), `website/worker/account/guard.ts` (session, CSRF, Origin: shared with the accounts) |
| the pages | `/submit/` (`src/pages/submit.astro`, `src/scripts/submit.ts`); `/removal/` (`src/pages/removal.astro`, `src/scripts/removal.ts`; its rules, shared with the Worker: `src/lib/removal.ts`); a paper's Contribute section (`src/components/paper/Contribute.astro`, `src/scripts/paper-actions.ts`); the account page (`src/pages/account.astro`, `src/scripts/account.ts`); the badge (`src/pages/badge.svg.ts`) |
| the Mac's side | `oscr/jobs.py` (`oscr jobs`, `oscr claims`, `oscr reports`, `oscr submissions`); `oscr/migrations/0006_contributions.sql` (`link_edit`, `article.withdrawn`); `oscr/migrations/0008_withheld.sql` (`withheld`: a removal narrower than a record) and `catalog.withheld`; `oscr/community.py` (the `paper_repo` facts, the remote push, D1 read and written) |
| the tests | `tests/test_jobs.py`, `tests/test_removals.py`, `tests/test_community.py`; `website/tests/contributions/` (`removal.test.ts`); the local end-to-end run `website/tests/account/e2e.sh`, with the removal page in a headless Chrome (`tests/contributions/removal-e2e.ts`) |

Cost: **zero**. Everything runs on Cloudflare's free plan (figures below), the Mac, and Zenodo's
sandbox; no paid service, no email.

## The flows

**Submit** (`/submit/`). A DOI and one to five code links. The Worker checks at once, within the
request: the DOI is registered (the DOI proxy's handle API, `https://doi.org/api/handles/<doi>`,
one small JSON answer), each link points to a place the registry knows (a forge, an archive, a data
repository: `worker/contributions/links.ts`, the harvester's rule, `oscr/links.py`) and answers (a
HEAD request, a GET when HEAD is refused, no redirect followed; 404 or 410 refuse the submission, a
timeout or a 5xx is left to the Mac). **The license is the Mac's to read**: it needs a forge's API or
the repository itself, and GitHub gives the Worker's shared addresses 60 requests an hour. The
result: a `submissions` row and a job. The Mac then harvests the DOI (the single-DOI path, `oscr
doi`: `harvest.scan_article`), verifies the submitter's links (commit, license, scripts), counts
the matches with the paper's paragraphs, and writes a **draft** back: the record as it would be
published. The submitter reviews it on the account page, corrects the links (up to ten times: the
Mac reads them again) and publishes it. When the submitter's ORCID iD is among the paper's authors
(or the owner made them one), publication is immediate; otherwise the owner decides (`oscr
submissions`). Published, the links become the submitter's corrections of the record, and a new
version. An off-topic paper (D7) is refused, in words.

**Claim** (a paper's Contribute section). Phase 5 already makes a verified author of anyone whose
ORCID iD the paper's metadata lists. Anyone else says why they are an author (a statement, an
optional web page): a pending claim, which the owner accepts (`oscr claims accept`: the
`verified_author` role, granted by the owner, which the automatic verification never takes back) or
refuses, with a word the claimant reads. Phase 5's maintainer claims that GitHub cannot settle join
the same queue.

**Correct a record** (a verified author of the paper, or a maintainer of one of its code
repositories). Well-defined changes of its links, never markup: add a link (code or data; checked
like a submission's), remove one, say what one is (the authors' code, their data, a tool they used).
A maintainer speaks for their own repository (its role, its removal) and may add links. The Mac
applies the changes as **corrections** (`link_edit`: they outlive every later scan of the paper, and
the verification's own reading of a repository never overrules a person's), verifies the added
repositories, concludes the paper's status again, and stores a **new version** of the record with
its provenance: the person's ORCID iD or GitHub login in `version.actor` and `field_provenance`,
on the Mac only. The page's Versions section says "a correction by a verified author" (or "by a
maintainer of its code"), never who.

**Validate the tracing map** (a verified author of the paper, with an ORCID iD linked). The page
carries the map's digest (`zenodo.map_digest`: SHA-256 of the map as `zenodo.map_of` builds it,
without the day it was proposed); the validation carries it back with the ORCID iD of the account's
ORCID identity. The Mac deposits **that map only**: when the map changed since the page was built,
the validation ends `map_changed` and the author is asked to look again. Then
`zenodo.validate(…, proof=…)` and `zenodo.deposit_map` on **Zenodo's sandbox** (the default
instance; `OSCR_ZENODO_INSTANCE=zenodo` only when the owner decides), with the rules of `CLAUDE.md`:
the author (ORCID iD) and the platform as creators, `IsSupplementTo` the paper, `References` the
code, the `oscr` community. The DOI and the record's address go back to the author.
**The proof**: `orcid` when the site signs in with orcid.org; while it signs in with ORCID's
**sandbox** (the default until `ORCID_ISSUER=https://orcid.org`), the iDs are tests, so the Mac
records the validation as `test` — which only Zenodo's sandbox accepts, and which no public output
shows (`catalog.public_db`, `catalog.json`).

**The badge** (a verified author or a maintainer of the paper's code). One static image,
`/badge.svg` (a flat rectangle, the platform's name from `SITE_NAME`: no file per paper, the site
holds at most 20,000), and three snippets that link it to the paper's page — Markdown,
reStructuredText, HTML — each with a Copy button. **Proposing it on GitHub** needs no permission: a
link opens the README of each GitHub repository of the paper (`/blob/HEAD/<README>`, the name read
from the repository's file list) or the repository itself when it has none; the author edits it in
GitHub's own editor and opens the pull request themselves — explicit consent by construction. The
one-click pull request (the author's own GitHub authorization, a token used once) is **not built**:
it needs the `public_repo` scope, which gives write access to every public repository of the
person, for a gain of two clicks.

**Request a removal** (the page `/removal/?paper=<the registry's id or a DOI>`, since 2026-09-29;
signed in until Turnstile comes with Phase 7). One static page for every record, linked from each
paper's page — its sidebar's "Request removal", its Contribute section — and from the page rendered on
demand; the account page lists the reader's requests with links to them.

- **The paper.** The page names it (title, DOI, authors, its code and whether the site keeps copies of
  it) from files the site already has, with no Worker request: the DOI lookup (`/lookup/NN.json`: read
  without a page, or never read, is said so), then the record of a paper rendered on demand
  (`/records/paper/NN.json`, which now lists each repository's files) or, for a recent paper, the facts
  its static page carries first in its `<main>` (`<script type="application/json" id="paper-facts">`:
  the paper, its authors, its repositories and their files; `npm run check` holds every static page to
  it). No file of its own: the file budget does not move.
- **Sign-in.** Signed out, the page offers ORCID (an author is then recognized at once), GitHub and
  Google; the sign-in comes back to the same `/removal/?paper=…` (the accounts' `return` now keeps a
  path's query, still a path of this site only). Signed in, the page says who reads it.
- **The form.** Who you are: an author of the paper (marked **verified** when the account's ORCID iD is
  among the paper's authors, Phase 5's facts, or the owner granted it), the holder of the rights, a
  person named in the record, someone else. What to remove: the whole record; only the copies of the
  authors' scripts; one repository's copies; one file; the tracing map — a repository and a file are
  chosen among the paper's own. Why: copyright or license, personal data, wrongly attributed or not my
  work, a retracted paper, an incorrect record (the page suggests the correction flow first, and links
  to it, but allows the request), another reason. A **justification** of 30 to 2,000 characters,
  refused with a clear message when it holds an email address (or an at sign). An optional **evidence
  link**, https only. **Two confirmations**: the information is accurate; a moderator reviews every
  request, and what can follow.
- **Review, then send.** The page checks the request with the Worker's own rules (`src/lib/removal.ts`),
  then shows a summary of everything; **nothing is sent before "Confirm and send"**. The receipt gives
  the request's number, its status (open) and when a decision takes effect.
- **Revisited**, the page shows the request: open (it may be completed: what is sent replaces it, and
  it keeps its number), accepted or refused, with the moderator's words. One request per account and
  record; a decided one is not asked again.
- **The owner decides** (`oscr reports list`, `oscr reports accept|reject <n> [--message "…"]`). Accepted,
  what the request names leaves every public output **at the next nightly publication** (04:17, the
  Mac's local time), while the Mac keeps everything:
  - the whole record: `article.withdrawn` says when and why; the record leaves the site, the lookup,
    the search's D1, the community facts and the open data, like an off-topic paper;
  - the copies of the paper's scripts, of one repository or of one file (`withheld`, migration 8): their
    text leaves the site's lots of scripts, the public database and the Hugging Face scripts dataset
    (at its next build, a repository withheld loses its manifest, a file its entry); the files stay listed with their link
    to the source, at the verified commit, and the reader says "withheld at a removal request";
  - the tracing map: its Map section says it is withheld, with neither digest (nothing to validate: a
    validation that comes anyway is refused, in words), nor matches, nor validations, nor DOI on the
    site, in the open data and in the search's rows.

  Rejected, nothing changes; the requester reads the owner's words either way.

## The tables (`migrations/d1-community/0002_contributions.sql`, `0003_removal_requests.sql`)

Times are Unix seconds. No email address anywhere: the free texts lose theirs in the Worker
(`contributions/text.ts`) and the CHECKs refuse an at sign. The tables keyed by a number use their
rowid (no AUTOINCREMENT, which writes `sqlite_sequence` at every insert); **each index says the
query that needs it** — each one costs a row written per insert.

| table | what | index, and why |
|---|---|---|
| `submissions` | the DOI, 1–5 code links, a note, the Worker's checks, the status (`queued`, `draft`, `publishing`, `moderation`, `published`, `refused`), the revisions, the Mac's paper id, author flag, draft and words | `submissions_user_doi` UNIQUE (user, DOI): one submission per account and DOI; the account page's list; the daily limit |
| `jobs` | one row per request the Mac must see: kind, the request's id, who, when. Append-only | none: the Mac reads `WHERE id > <last seen>`, the rowid's order |
| `edits` | a correction: the paper, as author or maintainer (and the repository), 1–10 changes (JSON), a note, status (`queued`, `applied`, `refused`), the version made, the Mac's words | `edits_user` (user, created_at): the account page's list, a paper page's state, the daily limit (a range: only the last day is read) |
| `validations` | the paper, the ORCID iD, the proof (`orcid`, `orcid-sandbox`), the map's digest, status (`queued`, `deposited`, `map_changed`, `refused`, `failed`), the Zenodo instance, DOI and record | `validations_user` (user, created_at): the same three reads |
| `reports` | a removal request: the paper, the reason (`copyright`, `personal_data`, `not_my_work`, `retracted`, `incorrect`, `other`; `author_request` for a request made before migration 3), the justification (`details`), who asks (`requester_role`: `author`, `rights_holder`, `named_person`, `other`; '' before migration 3) and `author_verified`, the scope (`record`, `scripts`, `repository`, `file`, `map`) with `scope_repo` and `scope_path`, `evidence_url` (https only), `confirmed`, status (`open`, `accepted`, `rejected`), the owner's words, `updated_at` (completed while open) | `reports_user_target` UNIQUE (user, kind, paper): one request per account and record; the list; the limit. Migration 3 makes the table again (a CHECK cannot change in place), the rows copied as they are |
| `claims` (Phase 5) | + `message`: the owner's words on a decided claim | Phase 5's `claims_user_target` serves the author claims too |
| `paper_repo` | a fact pushed by the Mac: which forge repository is the code of which paper (a maintainer may then correct that record) | its key (repo, paper), WITHOUT ROWID: the Worker reads it by the whole key |

No index on `roles (scope_kind, scope_id)` ("the verified authors of a paper"): every query of this
phase reads a person's own roles, by the key's prefix. The Mac keeps its own state of the jobs
(`data/community/state.db`: status, attempts, what the owner needs to decide), so a job row is
never updated: the outcome goes into the request's row, the one the reader sees.

## The routes

All under `/api/`, in the `ROUTES` table of `website/worker/index.ts`; every answer is JSON with
`Cache-Control: no-store`. **Every POST needs the session, its CSRF token (`X-CSRF-Token`, which
`/api/account/me` and `/api/contributions/paper` give the page) and the site's `Origin`** (and
`Sec-Fetch-Site: same-origin` when the browser sends it): `account/guard.ts`, the accounts' own.

| route | who | answer |
|---|---|---|
| `GET /api/contributions` | signed in | 200 `{submissions, edits, validations, reports, limits}`, newest first, 50 each |
| `GET /api/contributions/paper?id=<paper>` | anyone | 200 `{signed_in: false}`; or `{signed_in: true, user, author, maintains, claim, validation, report, edits, submission, csrf}` |
| `POST /api/submissions` `{doi, code_urls, note}` | signed in | 201 `{status: "queued", submission}`; 400 `bad_doi`, `no_links`, `too_many_links`, `unknown_place`; 409 `already_submitted`; 422 `unknown_doi`, `dead_links`; 429 `too_many` |
| `POST /api/submissions/<id>/revise` `{code_urls, note}` | its submitter | 200 `{status: "queued", submission}`; 404; 409 `not_revisable`; 422 `dead_links`; 429 `too_many_revisions` |
| `POST /api/submissions/<id>/publish` | its submitter | 200 `{status: "publishing" \| "moderation", submission}`; 404; 409 `not_draft` |
| `POST /api/claims` `{paper_id, statement, link}` | signed in | 202 `{status: "pending", claim}`; 200 `{status: "verified", already: true}` or a decided claim as it is; 400 `bad_paper`, `no_statement`, `bad_link`; 429 `too_many_claims` (20 pending), `too_many` |
| `POST /api/edits` `{paper_id, as, repo, changes, note}` | a verified author, or a maintainer of the paper's code (`as: "maintainer"`) | 202 `{status: "queued", edit}`; 400 `bad_paper`, `no_changes`, `too_many_changes`, `bad_change`, `unknown_place`; 403 `not_author`, `not_allowed`; 422 `dead_links`; 429 |
| `POST /api/validations` `{paper_id, map_digest}` | a verified author with an ORCID iD | 202 `{status: "queued", validation}`; 400 `bad_paper`, `bad_map`; 403 `not_author`; 409 `no_orcid`, `already_queued`, `already_validated`; 429 |
| `POST /api/reports` `{paper_id, role, scope, repo, path, reason, details, evidence_url, confirm_accurate, confirm_review}` | signed in | 202 `{status: "open", report}`; 200 `{status: "open", updated: true, report}` (completed while open); 400 `bad_paper`, `bad_role`, `bad_scope`, `no_code` (a scope but the record on a paper without code), `unknown_repo`, `unknown_file`, `bad_file`, `bad_reason`, `email_in_text`, `short_details`, `long_details`, `bad_evidence`, `not_confirmed` (each with `field`, the form's field); 404 `unknown_paper` (no page); 409 `already_decided`; 429; 503 `unavailable` (the Worker without its assets) |

A removal request's `report` is `{id, paper_id, url, removal_url, role, author_verified, scope, repo,
path, reason, details, evidence_url, confirmed, status, message, created_at, updated_at, decided_at}`.
The Worker checks it all (`src/lib/removal.ts`, `checkRequest`, the page's own rules) against the
paper's facts, which it reads from the site's own files through its `ASSETS` binding — the top of the
static page (it stops reading once the facts are read: a few kilobytes), else the record rendered on
demand — free: no request counted, no D1 row.

A change is `{"op": "add", "url", "role": "code"|"data"}`, `{"op": "remove", "repo"}` or `{"op":
"role", "repo", "role": "code"|"data"|"tool"}`, a link named by the registry's key
(`github.com/owner/name`, `zenodo:123`, `doi:10.…`). Errors as the accounts': `{"error": {"code",
"message"}}`; `signed_out` (401), `bad_origin`, `bad_csrf` (403), `not_configured`, `quota`,
`unavailable` (503). A paper's id: `doi:<lowercase DOI>`, `pmcid:PMC…`; whether it has a page is the
Mac's to say.

**Daily limits per account** (24 hours, counted from the account's rows through the indexes above:
no counter, no write of their own): 10 submissions, 20 corrections, 10 validations, 10 removal
requests, 10 author claims (and 20 claims pending at once, Phase 5's).

**The hint cookie.** `__Host-oscr_signed_in=1` (no `HttpOnly`, readable by the pages; set, extended
and cleared with the session cookie; it grants nothing). A paper's page asks the Worker only when
it is there: **a signed-out reader's page view costs no Worker request.**

**The pages' headers** (`website/public/_headers`): `/submit/` and `/paper/:slug/` (one segment: the
Code ↔ Paper reader keeps its own rules) get the account page's `Content-Security-Policy`
(`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`…) and `X-Frame-Options: DENY`.
Astro writes every page script as a file (`vite.build.assetsInlineLimit: 0`), and `npm run check`
fails on an inline script in those pages.

## The Mac's side (`oscr/jobs.py`)

```sh
oscr jobs poll --local|--remote        # read the new requests, answer them, within the day's budget
oscr jobs status                       # what waits, what was done, the rows written today
oscr claims list                       # the claims that wait for you
oscr claims accept|refuse <n> [--message "…"] --local|--remote
oscr reports list | accept|reject <n> [--message "…"] --local|--remote   # who asks, what, why, the evidence
oscr submissions list | accept|refuse <n> [--message "…"] --local|--remote
oscr community push --remote           # the facts, paper_repo included (nightly with OSCR_COMMUNITY_PUSH=remote)
```

- **Reaching D1** (`community.open_d1`): `--local`, the local D1 of `wrangler dev --env local`
  (`--persist-to` for another state folder); `--remote`, the REST API when `OSCR_D1_ACCOUNT_ID`,
  `OSCR_D1_COMMUNITY_ID` and the keychain's token (`org.oscr.cloudflare-d1`, or
  `CLOUDFLARE_D1_TOKEN`) are there, otherwise `wrangler d1 execute oscr_community --remote` under
  wrangler's own login — the same two paths as the search's push (`oscr/d1.py`).
- **A poll**: the jobs after the last one seen (`job_cursor`), then every job not answered yet, in
  order; a request asked several times (a claim again, a submission corrected twice) is answered
  once, from its latest state. A failure (Europe PMC down, Zenodo refusing) is tried again at the
  next poll, five times, then the reader is told; a missing Zenodo token is not the request's fault
  and never counts as an attempt. One request never stops the others.
- **Budget**: the rows the runner writes count in the facts push's day (`community_budget`,
  `OSCR_COMMUNITY_BUDGET`, 10,000 by default): the facts push gets what the answers left. A poll
  stops cleanly when fewer than 3 rows are left; the rest waits for the next day.
- **Scheduling (proposed, not installed)**: its own launchd task, `tools/org.oscr.jobs.plist`, every
  ten minutes, rather than a step of the harvester's loop, whose slices of the stock last up to 30
  minutes. Cost in D1: 144 polls a day, one query each (the new jobs: a few rows read, none when
  nothing is new), plus the requests and accounts they name, by key; one row written per answer.

## The free plan

**D1 rows written per action, as the local D1 counts them** (`ACCOUNT_DEV_METRICS=1`,
`website/tests/account/e2e.sh`; D1 counts one more row for each index an insert touches):

| action | written | read |
|---|---|---|
| a paper's page, signed in (`GET /api/contributions/paper`) | 0 | 10 |
| submission (the row, its index entry, the job) | 3 | 5 |
| submission refused (already submitted, a DOI not registered, a dead link) | 0 | 3 |
| correction of a record | 3 | 6 |
| validation of a map | 3 | 13 |
| manual author claim: new / asked again | 3 / 2 | 4 / 7 |
| removal request (the page /removal/): new / completed while open | 3 / 2 | 8 / 10 |
| publication of a draft (the row, the job) | 2 | 8 |
| revision of a draft (the row, the job; not measured, by construction) | 2 | — |
| the account page's lists (`GET /api/contributions`) | 0 | 7 |
| Phase 5's maintainer claim left pending (now with its job) | 3 (was 2) | 16 |
| the Mac's answer to a request / a claim accepted (claim and role) | 1 / 2 | — |

Plus the session's upkeep (at most one row an hour, Phase 5). **The share of the day**: the Worker
writes at most 10,000 rows a day (the search's push 80,000, the facts push 10,000 with the Mac's
answers). A request writes 3 rows: ~3,000 requests a day with the accounts' own writes; an account
at its limits writes at most ~180 rows a day. There is no global cap yet (Phase 7's Turnstile and
moderation come first). The facts push adds `paper_repo`: about one row per paper with code on a
forge, once, then deltas.

**Worker requests** (100,000 a day for every dynamic route): a signed-in reader's paper page 1
(`/api/contributions/paper`), a signed-out reader's 0; `/submit/` 1 (`/me`) and 1 per submission;
`/removal/` 0 signed out (the lookup, a record or the top of a static page: static files), 1 signed in
(`/api/contributions/paper`) and 1 per request sent; the account page 2 (`/me`, `/api/contributions`);
each form 1.

**CPU** (10 ms a request): measured in V8 (Node) with the test database and the mocked places
included — a submission with five links 0.47 ms, a correction with ten changes 0.30 ms, a validation
0.27 ms, a paper's page state 0.22 ms, a removal request 0.36 ms (a paper rendered on demand) to 1.0
ms (a static page whose facts list 2,000 files, read in 4 KB chunks, 86 KB of a 1 MB page). **Subrequests** (50): a submission at most 11 (the DOI, then
HEAD and perhaps GET for each of five links, all at once, each stopped after 6 s: waiting costs no
CPU); a correction at most 20 (ten links added); nothing else asks outside.

## What is kept, and what never is

- No email address, asked for, read or stored: the notes, statements and details lose any address
  typed in, and the schema refuses an at sign. No provider token. Nothing of a paper's text.
- What a request keeps: its fields, the account, the Worker's checks, the Mac's answer. A claim's
  evidence adds the account's public handles (ORCID iD, GitHub login).
- Who corrected a record stays on the Mac: `link_edit`, `version.actor`, `field_provenance`'s
  reference. The public database drops `link_edit`, blanks those references, and has no `version`
  table; the pages say "a correction by a verified author".
- A validation from ORCID's sandbox is a test: never in a public output.

## The owner's steps [owner]

Done on 2026-09-28 (Phase 6 is live): steps 1, 2 and 4 below. Step 5 is the owner's, whenever a
request comes. They stay here for a reinstallation:

1. **The database's new tables**: `sh tools/setup_cloudflare.sh` again (it applies the migrations of
   the three databases, `migrations/d1-community/0002_contributions.sql` included, and changes nothing
   else) — before deploying the Worker with Phase 6.
2. **The facts, nightly**: `OSCR_COMMUNITY_PUSH=remote` in `~/.config/oscr/settings` (the push then
   goes through wrangler's login, like the deployment; for the REST API, also `OSCR_D1_ACCOUNT_ID` and
   `OSCR_D1_COMMUNITY_ID`, with the keychain's `org.oscr.cloudflare-d1`).
3. **The Zenodo sandbox's token** in the keychain (`org.oscr.zenodo-sandbox`, probably there since
   Phase 0: `tools/install_mac.sh` says so). Real DOIs only when you decide:
   `OSCR_ZENODO_INSTANCE=zenodo` and the `org.oscr.zenodo` token.
4. **The poller**: add `org.oscr.jobs` to `TASKS` in `tools/install_mac.sh`, then run it again (or
   run `oscr jobs poll --remote` by hand).
5. **Your decisions**: `oscr claims list`, `oscr reports list`, `oscr submissions list`, then
   `accept`/`refuse` (`reject` for reports) with `--remote` and, if you wish, a `--message`.
6. **The removal page (2026-09-29)**: the database's migration 3, **before** deploying the Worker
   that writes its columns: `cd website && npx wrangler d1 migrations apply oscr_community --remote`
   (it makes the `reports` table again, its rows kept; `sh tools/setup_cloudflare.sh` does the same).
   The Mac's migration 8 (`withheld`) applies itself when `oscr` next opens the database.

## Local development and tests

- `npm test` in `website/` (node:test, Node's TypeScript support, node:sqlite; 54 tests for the
  contributions: routes, guards, roles, limits, checks with a mocked `fetch`, privacy; the removal
  request's rules, sign-in, CSRF and Origin, limit and email refusal, with the site's files mocked
  behind `ASSETS`) and `uv run pytest -q tests/test_jobs.py tests/test_removals.py tests/test_community.py`
  (each removal scope in the public export; the runner with a D1 made from the
  migrations, a fake harvester and a fake Zenodo; the corrections as versions; the deposit's payload
  with the author's ORCID iD; the remote facts push).
- **End to end**: `SITE_PORT=8788 MOCK_PORT=9480 sh tests/account/e2e.sh` (in `website/`, after the
  build). One mock server (`tests/account/mock-server.ts`) plays the providers, doi.org and the forges
  (`/checks/`, which `wrangler dev --var CHECKS_URL:…` points at) and the Zenodo sandbox (`/zenodo/`,
  which `OSCR_ZENODO_SANDBOX_URL` points the Mac at; local addresses only). Then
  `tests/contributions/e2e.ts` in three steps, with `oscr jobs poll --local` (offline) and the owner's
  decisions between them: submission → draft → publication by the owner; a correction applied; a map
  deposited on the mock sandbox with the author's ORCID iD; a claim accepted, then that author's
  correction; a removal refused, in words; and D1's count of every write. Then the removal page in a
  real browser (`tests/contributions/removal-e2e.ts`, `tests/contributions/chrome.ts`): a headless Chrome
  (`CDP_PORT`, 9397 by default; `CHROME`, its binary; skipped, and said, without it), every address
  outside the machine blocked (a resolver that finds no other host, a proxy that answers nothing), opens
  `/removal/` without a paper and with a paper that has no page, then signed out, signs in with ORCID
  and comes back, is refused an email address, reviews, goes back, confirms; the owner accepts (`oscr
  reports accept --local`); the Mac withholds the file's copy and only it; the page and the account page
  show the request accepted with the owner's words. `SCREENS=<folder>` saves the pages at 1280×860 and
  390×844.

## Limits and what comes next

- The one-click pull request of the badge is not built (see "The badge").
- Moderation in the site (claims, removals, submissions by non-authors) comes with Phase 7; until
  then, the commands above. No global daily cap on the Worker's writes, no Turnstile yet.
- A correction changes links only (code, data, tools): the bibliographic record comes from the
  paper's own metadata.
- A draft's matches need the paper's full text (Europe PMC): without it, they come after
  publication, when the harvester aligns the paper.
- A record withdrawn by a removal request comes back only by hand (`article.withdrawn = ''`); so does
  a copy or a map withheld (`DELETE FROM withheld WHERE …`).
- A removal request is one per account and record: completed while it is open, it cannot be asked
  again once decided (the owner may still act by hand). A request names at most one repository or one
  file; a file past the 5,000 listed per repository is named in the justification, with its repository.
- A copy already published on Hugging Face stays in its Parquet block (a published block never
  changes): the manifest that points to it is withdrawn, so no reader finds it. A tracing map deposited
  on Zenodo keeps its DOI there (a DOI is permanent); the site no longer shows it.
- The page reads a static paper's facts from its HTML: a paper page restructured without them fails
  `npm run check`.
- The README link uses `HEAD` (GitHub's default branch); the Mac does not record the branch's name.
