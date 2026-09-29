# The forge service: the contract of the GitHub side (night phase 01)

The "GitHub" side of OSCR: hosting, versioning and evolving research code, linked to papers.
Phase 02's code views (the registry's own viewer, history, Markdown, tracing maps, notebooks,
search) are described in [CODE_NAVIGATION.md](CODE_NAVIGATION.md), phase 03's editor and web commits
(the action `commit`) in [WEB_EDITING.md](WEB_EDITING.md), phase 04's forks and pull requests (ten
action kinds, the pull request pages, conflicts resolved in the browser) in
[PULL_REQUESTS.md](PULL_REQUESTS.md). This
page is the contract the parts of phase 01 build on: the routes, the authorized actions and their
payloads, the rows each writes, the caps, the switch `FORGE_OPEN`, the pages, the static layer,
the Mac's jobs and the budget. The decisions behind it: [DECISIONS.md](DECISIONS.md) D00-1 to
D00-16 (the storage) and D01-1 onwards (this phase); the architecture:
[ARCHITECTURE.md](ARCHITECTURE.md), "Git hosting".

**In one paragraph.** OSCR hosts no Git repository (D00-1). Repositories live in each
researcher's own GitHub account, created and acted on by OSCR's GitHub App with that person's
consent, one authorization per action, as that person, with the token used once and revoked
(D00-2, D00-4). The mirror mode is the same machinery on a repository the researcher already has.
Git goes straight to github.com with GitHub's own credentials (D00-3). Readers' browsers read
public repositories on their own GitHub quota (D00-5). OSCR keeps only its layer: the
repositories it knows, their papers, the paths tracing maps point to, in the D1 database
`oscr_forge` (binding `FORGE`), and on the Mac.

## Where the code is

| part | where |
|---|---|
| the forge-neutral interface, the GitHub adapter, the test double | `website/worker/forge/` (`gitbackend.ts`, `github/`), `website/tests/forge/` (phase 00) |
| the forge service | `website/worker/forge/service/`: `index.ts` (routes), `types.ts` (the contract's types), `caps.ts`, `gate.ts`, `store.ts`, `http.ts`, `backend.ts`, `actions.ts` (the registry); the routes `start.ts`, `act.ts`, `webhook.ts`, `read.ts`; the actions `act-*.ts` |
| the database | `migrations/d1-forge/0001_forge.sql` |
| the pages | `website/src/pages/new/`, `repositories.astro`, `forge/authorized.astro`, `r/index.astro`, `hosting/`; their scripts in `src/scripts/`; the shared library `src/lib/forge.ts` |
| the Mac | `oscr/forgejobs.py` (jobs, mirrors), `oscr/forgelayer.py` (traced paths, static layer); `oscr/community.py` reaches `oscr_forge` (`open_d1(target, database="oscr_forge")`) |
| the setup | `tools/setup_cloudflare.sh` (the database, the App's secrets), `tools/bind_d1.py` |
| the tests' world | `website/tests/forge-service/world.ts` (`forgeWorld`, `seed`), `d1.ts` (the database over node:sqlite, D1's billing, the query plans' scans); `tests/conftest.py` (`forge_d1`) |

## Routes

Every answer is JSON with `Cache-Control: no-store` (and the accounts' headers: nosniff,
no-referrer, noindex). A failure is `{"error": {"code", "message", …}}`, the message in plain words.
Before its handler, every route gets, in order: its path (another under `/api/forge/` is 404), its
method (405, with `Allow`), `FORGE` bound (else 503 `not_configured`), and for a signed-in route
the accounts set up (`COMMUNITY` and `SESSION_KEY`, else 503 `not_configured`).

| route | who | body → answer | D1 | built by |
|---|---|---|---|---|
| `POST /api/forge/start` | signed in; Origin and CSRF (`account/guard.ts` `signedIn`) | `{kind, repo, branch, expectedHead, digest, back, install?}` (≤ 8 KiB) → `{location}` | reads only (caps) | E1 |
| `POST /api/forge/act` | signed in; Origin and CSRF | `{code, state, payload}` (payload ≤ 1 MiB) → `{result, sentence}` | the action row + the spec's rows, one batch | E1 |
| `POST /api/forge/webhook` | GitHub (HMAC-SHA-256, `GITHUB_APP_WEBHOOK_SECRET`); not gated by `FORGE_OPEN` | the delivery (≤ 1 MiB, else 413 before hashing) → `{ok, stored}` | ≤ 2 rows: a one-row change with its delivery row, a two-row change without it (D01-24) | E3 |
| `GET /api/forge/repo?id=<forge>:<id>` or `?path=<owner>/<name>` | signed in | OSCR's layer for one repository; phase 04: `reviewers`, the linked papers' verified authors by GitHub login, to the people who manage the repository or authored a paper (D04-10) | ~10 read, 0 written | E6 |
| `GET /api/forge/mine` | signed in | "Your repositories", paged by name, `?mode=`, `?template=` | the account's repositories | E6 |

`start`'s body (`src/lib/forge.ts` `apiStart` builds it):
- `kind`: an action kind (below);
- `repo`: `{forge, id}` or `{forge, owner, name}`, or null (create, generate);
- `branch`, `expectedHead`: the branch the action is about and the head the page saw (a 40-hex id),
  or null;
- `digest`: SHA-256 (hex) of the payload's exact text (`JSON.stringify(payload)`), which the page
  keeps in sessionStorage and posts to `act` after GitHub;
- `back`: a path of this site to come back to (never another site, never `/api/`);
- `install`: go through the App's installation page first (the mirror mode).

### One authorized action (D00-4; the design's §10.2)

1. The page shows the sentence the person confirms (`.confirm`), computes the payload's digest,
   and posts `start`.
2. `start` checks the kind and its target (`spec.checkTarget`), `mayWrite` on the GitHub identity
   linked to the account, and the daily caps (reading only). It signs the flow cookie
   `__Host-oscr_forge` (HMAC purpose "forge", 10 minutes, HttpOnly, Secure, SameSite=Lax: state,
   PKCE verifier, the declared action and its digest, the session's hash, the return page).
   Nothing is written. It answers `{location}`: GitHub's authorization page, or the App's
   installation page.
3. GitHub sends the browser back to the static page `/forge/authorized/`, which takes `code` and
   `state` out of the address bar and posts them with the payload to `act`. Back from the App's
   installation page with an action waiting, the page declares the same action again (the
   declaration is kept in the tab with the payload) and goes through the ordinary authorization,
   with PKCE: a code from the installation page is never posted (D01-20).
4. `act` opens the cookie (signature, expiry, state, session), checks the payload's digest,
   validates the payload (`spec.validate`), exchanges the code, asks GitHub who authorized, and
   requires that GitHub account to be the one linked to the signed-in account (linked now if
   nobody has it; 409 `identity_conflict` if another account has). Then `mayWrite` and the caps
   again, the global cap (`gate.ts` `globalCap`), `spec.perform` as the person, `spec.check` on
   GitHub's answer, and ONE batch: the action row and the spec's writes. The cookie is cleared;
   the token is revoked in `waitUntil` on every path after the exchange, failures included. The
   token is never stored, logged, put in a cookie, an error or an answer.
5. `conflict` (the branch moved) answers 409 with `offer: "new_branch"`.

## Action kinds

`types.ts` `ACTION_KINDS`; the migration's CHECK on `actions.kind` lists the same (tests compare
them). Each kind has one spec (`ActionSpec`), registered by the file `actions.ts` names:

```ts
interface ActionSpec<P, R> {
  kind: ActionKind;
  needsRepo: boolean;                         // acts on a repository OSCR knows (a repos row)
  checkTarget?(target): ForgeProblem | null;  // at start, on the declared target
  validate(payload): P | ForgeProblem;        // everything checked before any request
  describe(parsed): string;                   // the sentence the page confirms
  perform(ctx): Promise<{ result, writes: Write[], repo?, outcome? }>;
  check(result, parsed, ctx): boolean;        // GitHub's answer is what was authorized
}
```

The rules every spec keeps:
- `perform` acts on `ctx.repo` and `ctx.target` (what the page declared at start), never on a
  repository the payload names otherwise, as the person (`ctx.session`);
- it returns its D1 rows as `Write`s (`store.ts`: the statement and the rows D1 bills for it,
  index entries included) and never executes a write; nothing is recorded before `check` passed;
- the action row's `rows` is 1 + the rows of its writes;
- no token, email address or Git object ever goes into a row or an answer.

| kind | file (element) | repo | payload | rows written, the action row included | cap |
|---|---|---|---|---|---|
| `create` | act-create.ts (E2) | none | `{name, description?, homepage?, readme?, gitignore?, license?, defaultBranch?, template?, features?, papers?: DOI[]}` | repos 2 + 1 per paper + job `link` 1 + action 1 (≤ 6 with one paper) | creations |
| `generate` | act-create.ts (E2) | none | `{template: {owner, name}, owner, name, description?, includeAllBranches?, papers?}` | as `create` | creations |
| `link` | act-link.ts (E3) | by path | `{papers?: DOI[]}` | repos 2 + 1 per paper + installation 1 when new + job 1 + action 1 | links |
| `papers` | act-link.ts (E3) | known | `{add?: DOI[], remove?: DOI[]}` | 1 per paper + action 1 | – |
| `rename` | act-settings.ts (E4) | known | `{name}` | repos 2 (the path moves) + action 1 | – |
| `edit` | act-settings.ts (E4) | known | `{description?, homepage?}` | action 1 | – |
| `topics` | act-settings.ts (E4) | known | `{topics: string[]}` | action 1 | – |
| `features` | act-settings.ts (E4) | known | `{issues?, wiki?, autoMerge?, deleteBranchOnMerge?}` | action 1 | – |
| `template` | act-settings.ts (E4) | known | `{template: boolean}` | repos 1 + action 1 | – |
| `default_branch` | act-settings.ts (E4) | known | `{branch}` | repos 1 + action 1 | – |
| `archive`, `unarchive` | act-settings.ts (E4) | known | `{}` | repos 1 + action 1 | – |
| `transfer` | act-settings.ts (E4) | known | `{newOwner, newName?}` | repos 0–2 + action 1 (`pending` until accepted) | – |
| `branch_create` | act-refs.ts (E4) | known | `{name, from}` (a branch, a tag or a commit) | action 1 | – |
| `branch_rename` | act-refs.ts (E4) | known | `{from, to}` | repos 0–1 (the default branch) + action 1 | – |
| `branch_delete` | act-refs.ts (E4) | known | `{name}` (never the default branch) | action 1 | – |
| `autolink_create` | act-autolinks.ts (E5) | known | `{keyPrefix, urlTemplate, isAlphanumeric?}` | action 1 | – |
| `autolink_delete` | act-autolinks.ts (E5) | known | `{id}` | action 1 | – |
| `delete_request` | act-delete.ts (E4) | known | `{confirmName: "owner/name" as typed, maps: the count shown}` | repos 1 + job `delete_due` 1 + action 1 | – |
| `restore` | act-delete.ts (E4) | known | `{}` | repos 1 + action 1 | – |
| `delete_final` | act-delete.ts (E4) | known | `{confirmName}` (only in `pending_deletion`) | repos 1 + action 1 | – |
| `software_heritage` | act-delete.ts (E4) | known | `{}` | job `archive` 1 + action 1 | – |
| `commit` (phase 03) | act-commit.ts | any public repository the person may write to (or fork: `propose`); start's `branch` and `expectedHead` required | `{branch, base, newBranch?, propose?, mergeParent?, message, description?, coAuthors?: [{login, id}], signOff?, changes: [{op: "put", path, text \| base64, executable?} \| {op: "delete", path} \| {op: "move", from, to}]}` (≤ 100 changes, ≤ 1 MiB; phase 04: `mergeParent` makes a merge commit with two parents, its changes possibly none; without write and without `propose`, GitHub decides: a maintainer's edit of a fork's pull request branch) | action 1 | – |
| `fork` (phase 04) | act-forks.ts | the repository forked (any public one) | `{owner?, name?, defaultBranchOnly?}` | action 1 | – |
| `fork_sync` (phase 04) | act-forks.ts | the fork | `{branch}` (GitHub's merge-upstream; a conflict leaves it) | action 1 | – |
| `pull_open` (phase 04) | act-pulls.ts | the base repository; start's `branch` = the base | `{base, head ("branch" or "owner:branch"), title, body?, draft?, maintainerCanModify?, reviewers?: logins}` | action 1 | – |
| `pull_edit` (phase 04) | act-pulls.ts | the base repository | `{number \| numbers (≤ 25, close or reopen only), title?, body?, base?, state?, draft?, reviewers?: {add?, remove?}, autoMerge?: method \| null, headBranch?: "delete" \| "restore"}` | action 1 | – |
| `pull_review` (phase 04) | act-pulls.ts | the base repository | `{number, commit, event: COMMENT \| APPROVE \| REQUEST_CHANGES, body?, comments?: [{path, line, side?, startLine?, startSide?, body}] (≤ 100)}` (the author may not approve their own) | action 1 | – |
| `pull_comment` (phase 04) | act-pulls.ts | the base repository | `{number, body, replyTo?: a review comment's id}` | action 1 | – |
| `pull_thread` (phase 04) | act-pulls.ts | the base repository | `{number, comment: the conversation's first comment id, resolved}` | action 1 | – |
| `pull_merge` (phase 04) | act-pulls.ts | the base repository; start's `expectedHead` = `head` | `{number, method: merge \| squash \| rebase, head, title?, message?, deleteBranch?}` (a head that moved: 409 offer reload; GitHub's refusal: 409 offer conflicts) | action 1 | – |
| `pull_update` (phase 04) | act-pulls.ts | the base repository | `{number, head}` | action 1 | – |
| `pull_revert` (phase 04) | act-pulls.ts | the base repository | `{number}` (a merged one; GitHub opens the revert) | action 1 | – |

A paper is a DOI (`10.…`), stored as `doi:10.…` in lower case, as `oscr_community`'s paper ids.
Its status is `linked` when the person is a verified author of the paper or a maintainer of the
repository (`oscr_community.roles`), `proposed` otherwise. Every action counts toward the 100
authorized actions an account may make in 24 hours.

## The rows of `oscr_forge`

`migrations/d1-forge/0001_forge.sql` (and `0002_commit.sql`, phase 03, and `0003_pulls.sql`, phase
04: `actions` rebuilt with the kinds `commit`, then `fork` … `pull_revert`): WITHOUT ROWID where the key is text, one index in the whole
database (`repos_path`), Unix seconds, no email, token or Git object column, public repositories
only.

| table | key | what | written by |
|---|---|---|---|
| `repos` | (forge, repo_id); index `repos_path` (forge, owner_login, name) | a repository OSCR knows: mode `created`/`installed`/`public`, installation, default branch, head and `head_at`, template flag, state `active`/`archived`/`pending_deletion`/`hidden`/`deleted`/`gone`, `delete_after`, `linked_by` | the Worker; the Mac's answers (heads, renames, states) |
| `repo_papers` | (forge, repo_id, paper_id) | a repository's papers, `linked` or `proposed` | the Worker |
| `installations` | (forge, id) | where the App is installed | the Worker (webhooks) |
| `traced_paths` | (forge, repo_id, path, paper_id) | the files tracing maps point to, the pinned commit, the number of line ranges | the Mac |
| `actions` | (day, user_id, at, nonce) | one row per authorized action: kind, repository, the GitHub account's numeric id, outcome, rows written | the Worker |
| `deliveries` | (day, delivery) | one row per webhook delivery handled: event, rows written | the Worker |
| `jobs` | id (the rowid) | the Mac's work: `link`, `push`, `archive`, `delete_due` (`not_before`), `reconcile`; the Mac's answer in the row (`done_at`, `outcome`, `message`) | the Worker; the Mac answers |

- A repository made private on GitHub leaves OSCR: state `hidden`, its owner and name blanked
  (D00-14); nothing finds it by path.
- A repository's path is stored in lower case; the pages show GitHub's own case.
- `store.ts` builds every statement. Reads go by key or by `repos_path`, never a scan: the tests'
  fake database records the query plans (`d1.ts` `scans`) and the tests assert none.
- "Your repositories" (`/api/forge/mine`) lists the repositories OSCR knows in the reader's own
  GitHub account (the prefix (forge, owner_login) of `repos_path`, the login of the reader's linked
  GitHub identity), by name (D01-13).
- The jobs a repository's page shows as pending are read from the table's last rows (a bounded
  tail of the rowid, `pendingJobsOf`).

## Caps (`service/caps.ts`, `service/gate.ts`)

| cap | value | why |
|---|---|---|
| `ACTION_PAYLOAD_BYTES` | 1 MiB | the Worker parses and rebuilds the JSON within its 10 ms of CPU (0.6–2.8 ms measured at 1 MiB) |
| `ASSET_UPLOAD_BYTES` | 25 MiB | release assets streamed raw; larger: GitHub's release page |
| `WEBHOOK_BYTES` | 1 MiB | the HMAC and the parse fit 10 ms; larger: 413, the Mac's polling catches up |
| `COMMIT_FILES` | 100 | files in one web commit (phase 03) |
| `PR_FILES_CHECKED` | 300 | files OSCR's pull-request check reads (phase 04) |
| `FORGE_ROWS_PER_DAY` | 5,000 | the forge service's D1 writes in a UTC day, inside the Worker's 10,000, until the owner confirms C3 |
| per account, 24 hours | 100 authorized actions, 10 repositories created, 20 linked | abuse, and the rows |
| `GRACE_SECONDS` | 30 days | a deletion's grace period (D00-10) |
| `FLOW_SECONDS` | 10 minutes | the flow cookie |

- **Counted from the rows, with no counter row** (D01-11). The per-account caps read the account's
  action rows of the last 24 hours: two key ranges, (yesterday, user) and (today, user). Over a cap:
  429 `too_many`, the cap in words.
- **The global cap** reads the `rows` of today's action and delivery rows: one key range of each,
  at most 5,000 rows each (every row counts at least itself). It is asked once per authorized
  action, at `act`, just before anything is written (D01-12). A webhook writes at most 2 rows and
  does not ask; its rows count in the total the next action sees. Over the cap: 503 `quota` with
  `Retry-After` until 00:00 UTC.
- **D1's own quota** (the account's 100,000 rows written, 5 M read a day): 503 `quota`, like the
  search and the contributions.

## FORGE_OPEN (D01-1)

- **Unset (the default, and until phase 16's content rules are merged): the write routes answer
  only to the owner**, the GitHub account whose numeric id is `FORGE_OWNER_GITHUB_ID`. Everyone
  else gets 403 `forge_closed`: "The GitHub side opens to the public with its content rules; until
  then, only the owner of the registry can act here."
- It is checked at `start` (the GitHub identity linked to the signed-in account) and at `act`
  (the account GitHub says authorized the action).
- `FORGE_OWNER_GITHUB_ID` unset or not a number: closed to everyone.
- `FORGE_OPEN=true` opens the write routes to every signed-in account. The setup script never sets
  it.
- Webhooks and the signed-in reads are not gated.

## Errors

GitBackend's codes (`website/worker/forge/errors.ts`) become answers in `http.ts`, one sentence
per code, never the forge's own message (a wrong request keeps its detail, redacted):

| code | status | extra |
|---|---|---|
| `invalid` | 400 | the detail |
| `unauthorized` | 401 | |
| `forbidden` | 403 | |
| `not_found` | 404 | |
| `conflict` | 409 | `offer: "new_branch"` |
| `not_mergeable`, `archived` | 409 | |
| `gone` | 410 | |
| `too_large` | 413 | |
| `rate_limited` | 429 | `retryAfter`, `Retry-After` |
| `unsupported` | 501 | `fallbackUrl`: GitHub's page that can do it |
| `unavailable` | 503 | |

The service's own codes: `not_configured` (503), `method_not_allowed` (405), `not_found` (404),
`forge_closed` (403), `too_many` (429), `quota` (503), `unavailable` (503), `not_built` (501, the
stubs until their elements are built), and the ones E1 adds (`identity_conflict` 409, `bad_state`,
`bad_digest`, `too_large` 413…). `redact` removes anything token-shaped from every log line.

## The pages

Static pages (the Worker's assets), `science.css` only, the platform's name from
`src/config.ts`; the scripts are files (no inline script: the pages' Content-Security-Policy in
`public/_headers` forbids it).

| page | what | element |
|---|---|---|
| `/new/` | create a repository (empty, from a template; pre-filled from URL parameters) | E2 |
| `/new/link/` | link an existing repository (the mirror mode) | E3 |
| `/new/import/` | imports on the researcher's machine | E12 |
| `/repositories/` | "Your repositories" (signed out: a sentence, no Worker request) | E6 |
| `/forge/authorized/` | the callback of one authorized action (`Referrer-Policy: no-referrer`) | E1 |
| `/r/<owner>/<name>/edit/…`, `new/…`, `upload/…`, `delete/…` | phase 03's editing views (the same shell; [WEB_EDITING.md](WEB_EDITING.md)) | phase 03 |
| `/r/<owner>/<name>/`, `…/settings/`, `…/branches/` | the repository pages: ONE shell, `/r/index.html`, serves them all (`public/_redirects`: `/r/* /r/ 200`); it reads GitHub's anonymous API and raw files on the reader's quota (its CSP allows `api.github.com` and `raw.githubusercontent.com`) | E7, E8 |
| `/hosting/`, `/hosting/limits/`, `/hosting/large-files/`, `/hosting/git/`, `/hosting/history/`, `/hosting/tokens/` | the guides | E11 |
| `/hosting/import/`, `/hosting/leave/` | importing, and the exit path | E12 |

- The URL scheme is `src/lib/forge.ts` (`parseRepoPath`, `repoPath`); phase 02 may add views under
  `/r/` and keeps these (D01-5).
- Git's links are GitHub's (`cloneCommands`: https, partial `--filter=blob:none`, shallow
  `--depth 1`; `zipUrl`, `desktopUrl`, `codespacesUrl`), never one of the registry's (D00-3).
- `tokenTemplateUrl`: GitHub's pre-filled fine-grained token page (the repository's owner, Contents
  write, 30 days, a name from the repository); the person picks the one repository there. OSCR
  issues no git token.
- The shell hands `mountSettings(root, repo)` and `mountBranches(root, repo)` a `ShellRepo`
  (`src/lib/forge.ts`).
- The styles of phase 01 (all in `science.css`): `.repo-head`, `p.status-line`, `.setup`,
  `pre.commands` and `button.copy`, `fieldset.choices` with `.explain`, `.limits`,
  `section.danger`, `table.branches`, `dl.settings`, `.panel` (`details.panel`), `.confirm`.

## The static layer (signed-out readers)

- `oscr/forgelayer.py` writes at most 64 shards, `<export>/forge/layer/NN.json`; the build copies
  them to `/forge/layer/NN.json` (`scripts/data.mjs`) and `npm run check` checks them.
- NN = the first byte of SHA-256 of `owner/name` in lower case, mod 64, two digits
  (`layerShard`; both sides are checked against `tests/fixtures/forge-shards.json`).
- A shard is an object keyed by `owner/name` in lower case:
  `{forge, id, mode, state, head, head_at, last_seen, papers: [{doi, slug, title}], maps, …}`.
  `mode` is `catalogue` for a repository the catalogue links but nobody linked (read only), or
  `created`, `installed`, `public`.
- Hidden, waiting-for-deletion, deleted and private repositories are left out, and the build drops
  them again, with every entry not in its own shard. No email address (the build scrubs, the check
  refuses).

## The Mac's jobs

`oscr/forgejobs.py` (E9), read-only toward the forges (`oscr/forge.py`): never a user token,
never the App's key, never users' code.

| job | written by | the Mac |
|---|---|---|
| `link` | a creation or a link | verifies the repository, adds it to its papers' records through the Phase 6 path (license, script copies for verified licenses only, alignment) |
| `push` | a webhook's push to a repository with traced paths | re-verifies the head; marks the maps' commits still reachable or not |
| `archive` | `software_heritage` (on a person's demand only, D00-15) | asks Software Heritage to archive the repository |
| `delete_due` | `delete_request`, from `not_before` | after the grace period, a repository still waiting is hidden; the deletion on GitHub stays the researcher's own act (D00-10) |
| `reconcile` | the Mac itself, or a webhook | follows renames and transfers by id; a vanished repository becomes `gone` |

- The commands: `oscr forge poll|mirrors|layer|status --local|--remote`.
- With `OSCR_FORGE_PUSH=<target>` in the settings, `oscr jobs poll` also polls the forge jobs of
  that target.
- With `OSCR_FORGE_PUSH=remote`, `oscr nightly` also reads the public mirrors' heads and writes the
  static layer, between the public export and the deployment. Each failure is recorded like the
  others.
- The rows the Mac writes count in the facts push's budget (`OSCR_COMMUNITY_BUDGET`, 10,000 a day).
- The REST path needs `OSCR_D1_FORGE_ID` beside `OSCR_D1_ACCOUNT_ID`; without them, wrangler's own
  login.

## Budget (PLATFORM_PLAN.md §15.4)

Phase 01's share of a day at ~3,000 repositories: **~900 Worker requests, ~1,300 D1 rows written,
~5,000 rows read, ~1,000 of the Mac's rows**.
- 20 creations: 2 requests and ≤ 6 rows each;
- ~60 renames, archives, links and deletions: 2 requests and 1–3 rows each;
- ~700 webhooks: 1 request and ≤ 2 rows each;
- signed-out repository pages: 0 requests (the shell, GitHub's anonymous API, the static layer);
- the global cap's check reads today's action and delivery rows once per action (D01-12: to
  measure; the alternative is in that entry).

## Secrets and the owner's steps

Set by `sh tools/setup_cloudflare.sh` (nothing shown, nothing written to a file): the database
`oscr_forge` (created, bound, migrated), `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY` (read from the
path of GitHub's `.pem` file), `GITHUB_APP_SLUG` and `FORGE_OWNER_GITHUB_ID` (public values, stored
as secrets so that a deployment never wipes them, D01-2). `FORGE_OPEN` is never set. Registering
the App first: [ARCHITECTURE.md](ARCHITECTURE.md), "The owner's steps".

## Local end-to-end run

```sh
cd website && npm ci
SITE_PORT=8791 MOCK_PORT=9491 FAKE_PORT=9490 sh tests/forge-service/e2e.sh   # KEEP=1 keeps the servers
```

It makes a throwaway local D1 (the fixture's facts in `oscr_community`, `oscr_forge`'s
migrations), starts the sign-in mocks (`tests/account/mock-server.ts`) and the fake GitHub over
HTTP (`tests/forge/fake-github-server.ts`: `/api`, `/web` for github.com's authorization and
installation pages, `/raw`, with CORS; `POST /control {"login"}` names who approves,
`{"offline": true}` makes it fail), builds the site with `FORGE_GITHUB_*_URL` pointing at it, and
runs `wrangler dev --env local` with development values only (`FORGE_OPEN` unset,
`FORGE_OWNER_GITHUB_ID` the fake's Ada). `tests/forge-service/e2e.ts` then signs in, creates and
links repositories through real redirects, changes settings, branches and autolinks, makes web
commits (phase 03: an edit, a branch that moved refused, a new branch, a move), sends signed
webhooks, and checks the rows written and `FORGE_OPEN`'s refusal. The fake also answers GitHub's
`/users/{login}`, `/licenses/{key}` and `/codes_of_conduct/{key}` (the editor's co-authors and
templates), and `…/forks` and `…/merge-upstream` (phase 04). Phase 04's checks: the pull request
pages are the shell; a pull request opened, a line comment with a suggestion, the suggestion
applied as a commit on its branch, a merge at a head that moved refused, the merge (squash, the
branch deleted), a second pull request refused on its conflict, another account's fork and comment
refused (`FORGE_OPEN`). The fake starts with a CODEOWNERS file, an issue, and Bob's pull request from
his fork, reviewed with a suggestion (`tests/forge/fake-github-seed.ts` `seedPulls`). A test browser that shows the
`/r/` pages against the fake needs the Content-Security-Policy bypassed for them (it allows
GitHub's own hosts, not the fake's): the screenshots in `docs/night-screenshots/phase-01/` were
taken so, in headless Chrome only.

Locally (`wrangler dev --env local`): `FORGE` is bound to a local database
(`00000000-0000-4000-8000-00000000f09e`; `npx wrangler d1 migrations apply oscr_forge --local
--env local`), and the App's values go in the gitignored `website/.dev.vars`, with
`FORGE_GITHUB_*_URL` pointing at the fake GitHub (`website/tests/forge/fake-github.ts`).
