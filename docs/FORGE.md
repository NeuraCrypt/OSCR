# The forge service: the contract of the GitHub side (night phase 01)

The "GitHub" side of OSCR: hosting, versioning and evolving research code, linked to papers.
Phase 02's code views (the registry's own viewer, history, Markdown, tracing maps, notebooks,
search) are described in [CODE_NAVIGATION.md](CODE_NAVIGATION.md), phase 03's editor and web commits
(the action `commit`) in [WEB_EDITING.md](WEB_EDITING.md), phase 04's forks and pull requests (ten
action kinds, the pull request pages, conflicts resolved in the browser) in
[PULL_REQUESTS.md](PULL_REQUESTS.md), phase 05's issues (eleven action kinds on GitHub's issues, the
registry's own research issues and their routes, the issue pages, the `/research/` shell) in
[ISSUES.md](ISSUES.md), phase 07's releases, packages and environments (ten action kinds, the file
route, the tie of a release to a paper's version, the Mac's `release` and `deposit` jobs, the release
pages) in [RELEASES.md](RELEASES.md), phase 08's social layer (stars, lists, follows and watch levels,
profiles, the events and the in-site inbox, the feed, Explore, the search of the registry's objects) in
[SOCIAL.md](SOCIAL.md), phase 10's public API and personal tokens in [API.md](API.md) and its checks,
commit statuses and outgoing webhooks in [AUTOMATION.md](AUTOMATION.md). This
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
| `POST /api/forge/asset` | signed in; Origin and CSRF; `FORGE_OPEN` | phase 07: the completion of `asset_upload` in headers (`X-Forge-Code`, `X-Forge-State`, `X-Forge-Payload` base64url), the file as the body (`Content-Length` ≤ 25 MiB, required, held; streamed, never parsed) → `{result, sentence}` | the action row | phase 07 |
| `POST /api/forge/webhook` | GitHub (HMAC-SHA-256, `GITHUB_APP_WEBHOOK_SECRET`); not gated by `FORGE_OPEN` | the delivery (≤ 1 MiB, else 413 before hashing) → `{ok, stored}` | ≤ 2 rows: a one-row change with its delivery row, a two-row change without it (D01-24) | E3 |
| `GET /api/forge/repo?id=<forge>:<id>` or `?path=<owner>/<name>` | signed in | OSCR's layer for one repository; phase 04: `reviewers`, the linked papers' verified authors by GitHub login, to the people who manage the repository or authored a paper (D04-10); phase 07: `releaseTies` (the releases tied to a paper's version), `answered` (the Mac's words for its releases), `packages` (confirmed or declined) | ~10 read (+ the ties and the jobs' tail), 0 written | E6 |
| `GET /api/forge/mine` | signed in | "Your repositories", paged by name, `?mode=`, `?template=` | the account's repositories | E6 |
| `GET /api/forge/research` | signed in | phase 05: one research issue (`?id=`: the issue, its comments, what the reader may do), or the research issues of 1–10 papers (`?paper=`, `&repo=<forge>:<id>`) | ≤ ~1,000 read, 0 written | phase 05 |
| `POST /api/forge/research/open` | signed in; Origin and CSRF; `FORGE_OPEN` | a new research issue (`{paper, repo \| code, type, title, …}`) → `{id, page}` (201) | 3 rows: the row, its index entry, the action row | phase 05 |
| `POST /api/forge/research/comment` | signed in; Origin and CSRF; `FORGE_OPEN` | a comment, its edit, its deletion or hiding | 3 rows for a comment, 2 otherwise | phase 05 |
| `POST /api/forge/research/edit` | signed in; Origin and CSRF; `FORGE_OPEN` | title, text, close with a reason and a research resolution, reopen, labels, lock, pin | 2 rows | phase 05 |
| `GET /api/forge/social`, `…/social/mine`, `…/social/person`, `…/social/inbox`, `…/social/feed`, `…/social/activity` | signed in | phase 08: the buttons' state, the reader's own stars, lists, follows and profile, a person's public profile, the in-site notifications (computed on read), the feed, a person's activity ([SOCIAL.md](SOCIAL.md)) | reads by the person's key, 0 written | phase 08 |
| `POST /api/forge/social/star`, `…/follow`, `…/list`, `…/profile`, `…/notices` | signed in; Origin and CSRF; `FORGE_OPEN` | phase 08: a star, a follow or watch level, a star list, the profile, notifications' states | 2 rows each (a notices change: 1 per thread + 1) | phase 08 |
| `GET /api/forge/tokens` | signed in | phase 10: the reader's personal tokens (never a token, never a digest), the scopes in words ([API.md](API.md)) | the account's tokens (index `api_tokens_user`), 0 written | phase 10 |
| `POST /api/forge/tokens/write` | signed in; Origin and CSRF; `FORGE_OPEN` to make one (never to revoke) | `{op: "create", name, scopes, days}` → the token, answered once (201); `{op: "revoke", id}` | 3 rows each | phase 10 |
| `GET /api/forge/hooks`, `…/hooks/deliveries?id=` | signed in | phase 10: the reader's outgoing webhooks, a hook's deliveries of the last 7 days ([AUTOMATION.md](AUTOMATION.md)) | by the person's key, 0 written | phase 10 |
| `POST /api/forge/hooks/write` | signed in; Origin and CSRF; `FORGE_OPEN` (never to pause or delete) | `{op: create \| update \| ping \| redeliver \| rotate \| delete, …}`: made after a ping, its secret answered once | 4 rows to make one; 2–3 otherwise; each delivery 1 | phase 10 |
| `GET /api/forge/statuses?path=&sha=` | signed in | phase 10: a commit's statuses posted by outside services, combined | the commit's statuses, 0 written | phase 10 |
| `/api/v1`, `/api/v1/*` | a personal token (bearer; no cookie is read) | phase 10: the public API over the same handlers ([API.md](API.md)); `POST /api/v1/statuses/post` and `/statuses/actions` (GitHub Actions' OIDC token) post commit statuses | the routes' own rows; a status 2 | phase 10 |
| `POST /api/forge/report` | anyone: signed in (Origin and CSRF) or not (Origin); always Turnstile; not gated by `FORGE_OPEN` | phase 16: `{target, reason, details, label, turnstile}` → `{id, sentence}` (201); a copyright notice needs an account ([MODERATION.md](MODERATION.md)) | 3 rows | phase 16 |
| `GET /api/forge/moderation` | the owner | phase 16: the queue (open reports, appeals, data-rights requests); `?target=` one thing's state | by index, 0 written | phase 16 |
| `POST /api/forge/moderation/decide` | the owner; Origin and CSRF | phase 16: `{op: dismiss \| hide \| restore \| appeal, …}` | 2–6 rows (+ a suspended account's tokens and hooks) | phase 16 |
| `GET /api/forge/moderation/mine` | signed in (a suspended account too) | phase 16: what of the reader's is hidden, their appeals, their data-rights requests and answers | by index, 0 written | phase 16 |
| `POST /api/forge/appeal` | signed in (a suspended account too); Origin and CSRF; the human check | phase 16: an appeal or a counter-notice | 4 rows | phase 16 |
| `GET /api/forge/blocks`, `POST /api/forge/blocks/write` | signed in; Origin and CSRF; `FORGE_OPEN` to write | phase 16: the reader's blocks and account-wide limit; block (silent), unblock | 2 rows | phase 16 |
| `GET /api/forge/limits?repo=`, `POST /api/forge/limits/write` | signed in; Origin and CSRF; `FORGE_OPEN`; a manager of the repository | phase 16: a repository's interaction limit; set or lift one | 2 rows | phase 16 |
| `POST /api/forge/rights`, `POST /api/forge/rights/answer` | signed in (a suspended account too), the human check; the answer: the owner | phase 16: a data-rights request; its answer, read on the person's page | 3 rows; 2 | phase 16 |

Phase 16 adds checks, not rows, to earlier routes ([MODERATION.md](MODERATION.md)): a suspended account's
writes are refused (403 `suspended`, `who.ts` and `start`); on a repository, opening, commenting,
reacting and reviewing meet its managers' blocks and interaction limits (403 `blocked`, `limited`, at
`start` and in the research routes); research issues and new comments, profiles, star lists' names,
tokens and webhooks pass the human check (Turnstile, `requireHuman`); every read drops what moderation
hid (`hidden.ts`: the research reads, people, activity, inbox, feed, webhooks and their redelivery,
statuses, the repository's layer — 410 for a hidden repository, `moderatedThreads` for its hidden
GitHub threads —, the search).

Phase 10 adds work, not rows, to earlier routes: after the batch that wrote an event (`act.ts`,
`research.ts`, `webhook.ts`), its outgoing webhooks are delivered in `waitUntil` (1 row a delivery,
AUTOMATION.md); a `pull_request` delivery (`opened`, `synchronize`, `reopened`, `ready_for_review`) on a
repository the registry follows posts the registry's check run with the installation token, in
`waitUntil` (0 rows, D10-9).

Phase 08 adds rows to earlier routes: a research issue opened also writes its event and the author's
follow of the thread (5 rows), a comment its event (4, or 5 for a first comment on the thread), a close
or reopen its event (3); every authorized action on a repository the registry knows writes its events
(an issue or pull request opened, commented, reviewed, closed, merged; a release published; code linked
to a paper; a release tied to one: 1 row each, and 1 for a thread newly followed); a webhook's
`issues`, `issue_comment`, `pull_request` and `release` deliveries write one event with their delivery
row (2). An action and GitHub's webhook for the same act make one event (SOCIAL.md, D08-6).

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
| `issue_open` (phase 05) | act-issues.ts | the repository | `{title, body?, labels?, assignees?, milestone?, type?, parent?}` | action 1 | – |
| `issue_edit` (phase 05) | act-issues.ts | the repository | `{number \| numbers (≤ 25; ≤ 15 with labels or assignees), title?, body?, state?, reason?: completed \| not_planned \| duplicate, duplicateOf?, labels?: {add, remove}, assignees?: {add, remove}, milestone?, type?}` | action 1 | – |
| `issue_comment` (phase 05) | act-issues.ts | the repository | `{number, body}` \| `{number, comment, body}` \| `{number, comment, delete: true}` | action 1 | – |
| `issue_react` (phase 05) | act-issues.ts | the repository | `{number, comment?, reaction, remove?}` | action 1 | – |
| `issue_lock`, `issue_pin` (phase 05) | act-issues.ts | the repository | `{number, locked, reason?}`, `{number, pinned}` | action 1 | – |
| `issue_transfer` (phase 05) | act-issues.ts | the repository | `{number, to}` (a repository of the same account) | action 1 | – |
| `issue_relation` (phase 05) | act-issues.ts | the repository | `{number, sub?: {add \| remove}, blockedBy?: {add \| remove}}` | action 1 | – |
| `issue_branch` (phase 05) | act-issues.ts | the repository | `{number, name ("<n>-…"), from}` | action 1 | – |
| `issue_labels`, `issue_milestone` (phase 05) | act-issues.ts | the repository | `{create?, update?, delete?}` (≤ 25); `{title, …}` \| `{number, …}` \| `{number, delete}` | action 1 | – |
| `research_copy` (phase 05) | act-research.ts | the research issue's repository | `{id}` (its author, once) | research issue 1 + action 1 | – |
| `pull_merge` + `closes` (phase 05) | act-pulls.ts | the base repository | `…, closes?: research numbers (≤ 5)`: those the pull request's text says it fixes, about this repository, into the default branch | 1 per research issue + action 1 | – |
| `research_open`, `research_comment`, `research_edit` (phase 05) | research.ts | — | not authorized actions: the registry's own routes above, logged in `actions` so that the caps count them | 3, 3 or 2 with the action row | research issues opened: 20 |
| `release_create` (phase 07) | act-releases.ts | the repository | `{tag, target (full commit id), name?, body?, draft?, prerelease?, latest?: "true" \| "false" \| "legacy", generateNotes?, paper?: {doi, version, label?}, map?, archive?, deposit?}` | action 1 + tie 1 + a job each (`release` when published and tied, `archive`, `deposit`): ≤ 5 | – |
| `release_edit` (phase 07) | act-releases.ts | the repository | `{id, tag?, target? (a draft's), name?, body?, draft?, prerelease?, latest?}` | action 1 + a `release` job per tie when it publishes | – |
| `release_delete`, `release_drafts` (phase 07) | act-releases.ts | the repository | `{id, confirm: its tag}`; `{}` | action 1 | – |
| `release_research` (phase 07) | act-releases.ts | the repository | `{tag, paper?: {doi, version, label?} \| untie?: doi, map?, archive?, deposit?: doi}` | action 1 + the tie + the jobs asked | – |
| `tag_create`, `tag_delete` (phase 07) | act-releases.ts | the repository | `{name, target, message?}`; `{name, confirm}` | action 1 | – |
| `asset_upload`, `asset_delete` (phase 07) | act-releases.ts | the repository | `{release, name, label?, size, sha256, contentType}` + the file (`POST /api/forge/asset` only); `{release, id, confirm: its name}` | action 1 | – |
| `package_confirm` (phase 07) | act-packages.ts | the repository | `{registry, name, version?, source?, confirm}` | package 1 + action 1 | – |

A paper is a DOI (`10.…`), stored as `doi:10.…` in lower case, as `oscr_community`'s paper ids.
Its status is `linked` when the person is a verified author of the paper or a maintainer of the
repository (`oscr_community.roles`), `proposed` otherwise. Every action counts toward the 100
authorized actions an account may make in 24 hours.

## The rows of `oscr_forge`

`migrations/d1-forge/0001_forge.sql` (and `0002_commit.sql`, phase 03, `0003_pulls.sql`, phase
04, `0004_issues.sql` and `0005_research.sql`, phase 05, `0006_releases.sql` and
`0007_packages.sql`, phase 07: `actions` rebuilt with the kinds `commit`, then `fork` … `pull_revert`,
then `issue_open` … `issue_milestone`, then `research_copy`, then `release_create` … `asset_delete`
and `package_confirm`, then the research writes, then phase 08's social kinds and phase 10's `token`,
`hook`, `status`; `jobs` rebuilt with `release`, `deposit`, `paper_id` and `proof`): WITHOUT ROWID where
the key is text, four indexes in the whole database (`repos_path`, phase 05's `research_paper`, phase
10's `api_tokens_user` and `hooks_subject`), Unix seconds, no email, token or Git object column (a
token's digest, a webhook's salt), public repositories only.

| table | key | what | written by |
|---|---|---|---|
| `repos` | (forge, repo_id); index `repos_path` (forge, owner_login, name) | a repository OSCR knows: mode `created`/`installed`/`public`, installation, default branch, head and `head_at`, template flag, state `active`/`archived`/`pending_deletion`/`hidden`/`deleted`/`gone`, `delete_after`, `linked_by` | the Worker; the Mac's answers (heads, renames, states) |
| `repo_papers` | (forge, repo_id, paper_id) | a repository's papers, `linked` or `proposed` | the Worker |
| `installations` | (forge, id) | where the App is installed | the Worker (webhooks) |
| `traced_paths` | (forge, repo_id, path, paper_id) | the files tracing maps point to, the pinned commit, the number of line ranges | the Mac |
| `actions` | (day, user_id, at, nonce) | one row per authorized action: kind, repository, the GitHub account's numeric id, outcome, rows written | the Worker |
| `deliveries` | (day, delivery) | one row per webhook delivery handled: event, rows written | the Worker |
| `jobs` | id (the rowid) | the Mac's work: `link`, `push`, `archive` (phase 07: a release's tag in `ref`), `delete_due` (`not_before`), `reconcile`; phase 07's `release` (the map versioned with a release) and `deposit` (its validated map on Zenodo), each naming its paper (`paper_id`), a deposit the ORCID the author signed in with (`proof`); the Mac's answer in the row (`done_at`, `outcome`, `message`) | the Worker; the Mac answers |
| `research_issues` | id (the rowid: `research#<id>`); index `research_paper` (paper_id, id) | phase 05: a research issue — the paper, the repository (by id and path) or the code's address elsewhere, the type, title and text (masked), the tracing-map link (commit, path, lines, paragraph, section), the reproduction report (JSON), labels, state, GitHub's close reason and the research resolution, lock, pin, the GitHub copy's number, the author as named (and their user id, never answered), the comments' count, the last 100 events | the Worker |
| `research_comments` | (issue_id, n) | phase 05: a research issue's comments in order; a deleted one keeps its row, empty; a hidden one its reason | the Worker |
| `release_papers` | (forge, repo_id, tag, paper_id) | phase 07: a release tied to a version of a paper: the release's id, the repository's path, the version and its label, the commit the tag named, the digest of the map the person saw (the Mac answers the version's), `linked` or `proposed`, who (never answered) | the Worker; the Mac answers the digest |
| `repo_packages` | (forge, repo_id, registry, name) | phase 07: a package the manifests declare, confirmed or declined by a person who may push: the version and the manifest they said | the Worker |
| `stars`, `star_lists`, `star_list_items`, `follows`, `events`, `notice_state`, `notice_marks`, `profiles` | the person's key; an event (subject, at, nonce) | phase 08 (`0008_social.sql`, no index): the social layer ([SOCIAL.md](SOCIAL.md)); `actions` rebuilt with the social kinds and a `subject` | the Worker; the Mac reads them each night, and decides collections |
| `api_tokens` | digest (the token's SHA-256); index `api_tokens_user` (user_id) | phase 10 (`0009_automation.sql`): a personal token's public id, name, scopes, expiry, day of last use — never the token ([API.md](API.md)) | the Worker |
| `hooks` | (user_id, id); index `hooks_subject` (subject) | phase 10: an outgoing webhook: its subject, address, events, whether active, the salt its secret is derived from — never the secret | the Worker |
| `hook_deliveries` | (day, hook_id, at, guid) | phase 10: a delivery: the event's key, the answer's status, the time, the tries, a few fixed words — never the answer's body | the Worker |
| `statuses` | (forge, repo_id, sha, context) | phase 10: a commit status posted by an outside service (a token, or GitHub Actions' OIDC token) | the Worker |

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
| per account, 24 hours | 100 authorized actions (the research writes included), 10 repositories created, 20 linked, 20 research issues opened; phase 08: 300 social writes and 500 notification changes, counted apart from the 100; phase 10: 50 token and webhook changes and 300 commit statuses (a repository's GitHub Actions: 300 of its own), apart too | abuse, and the rows |
| phase 10 | 20 tokens and 10 webhooks an account, 10 webhooks a subject, 20 contexts a commit; the API's 60 requests a minute and 1,000 a day per token (the isolate's count, D10-4); 20 webhook sends a request | abuse, the free plan's subrequests |
| `GRACE_SECONDS` | 30 days | a deletion's grace period (D00-10) |
| `FLOW_SECONDS` | 10 minutes | the flow cookie |
| phase 16, per account, 24 hours | 20 reports (50 a day without an account, all together), 500 moderation decisions (the owner), 5 appeals, 100 block changes (1,000 blocks kept), 20 limit changes, 3 data-rights requests (3 waiting at most); each apart from the 100 | abuse, and the rows |
| phase 16 | 20 wrong API tokens a minute from one address, then refused before any read (the isolate's memory) | a bad token costs a read |

- **Counted from the rows, with no counter row** (D01-11). The per-account caps read the account's
  action rows of the last 24 hours: two key ranges, (yesterday, user) and (today, user). Over a cap:
  429 `too_many`, the cap in words.
- **The global cap** reads the `rows` of today's action and delivery rows, and (phase 10) counts
  today's outgoing webhook deliveries: one key range of each,
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
- `FORGE_OPEN=true` opens the write routes to every signed-in account — **night phase 16: only with
  the content rules in force** (`gate.ts` `forgeOpen`: Turnstile's secret `TURNSTILE_SECRET_KEY` set).
  Without it, `FORGE_OPEN=true` opens nothing. The setup script never sets it; the owner's steps to
  open are in [MODERATION.md](MODERATION.md) "Opening the GitHub side".
- Webhooks and the signed-in reads are not gated. Reports, appeals and data-rights requests are open
  whatever the switch says (phase 16).

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
| `/research/<n>`, `/research/new`, `/research/?paper=` | phase 05: the research issues, ONE shell (`/research/* /research/ 200`), its CSP this site only ([ISSUES.md](ISSUES.md)) | phase 05 |
| `/r/<owner>/<name>/releases/…`, `…/tags/`, `…/environment/…` | phase 07: the releases, a release, the form, the latest, the changelog, a file, the tags, the environment ([RELEASES.md](RELEASES.md)); the same shell | phase 07 |
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
- Phase 05: an entry's `research` lists its research issues' summaries (the newest 200), and 64 more
  shards, `/forge/research/NN.json` (NN = the issue's number mod 64), hold each research issue whole
  (`{"<n>": {"issue", "comments"}}`), as of last night, for signed-out readers.
- Phase 07: an entry's `releases` lists its releases tied to papers (the paper, the version, the commit,
  the map the Mac versioned with it, a real Zenodo's DOI — never a sandbox's), its `packages` the
  confirmed ones, and each listed paper with code its map's digest (`map`).

## The Mac's jobs

`oscr/forgejobs.py` (E9), read-only toward the forges (`oscr/forge.py`): never a user token,
never the App's key, never users' code.

| job | written by | the Mac |
|---|---|---|
| `link` | a creation or a link | verifies the repository, adds it to its papers' records through the Phase 6 path (license, script copies for verified licenses only, alignment) |
| `push` | a webhook's push to a repository with traced paths | re-verifies the head; marks the maps' commits still reachable or not |
| `archive` | `software_heritage` (on a person's demand only, D00-15); phase 07: a release's (`ref` its tag) | asks Software Heritage to archive the repository |
| `release` | phase 07: a release tied to a paper's version, published | freezes the paper's tracing map for the release (`forge_map_version` in its state), answers its digest into the tie |
| `deposit` | phase 07: the author's request (a verified author with an ORCID iD) | checks the role, the ORCID iD and the map's digest again, then deposits the map with the release on Zenodo (the sandbox unless `OSCR_ZENODO_INSTANCE=zenodo`; `oscr forge poll --instance`) |
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
as secrets so that a deployment never wipes them, D01-2); phase 16: `TURNSTILE_SECRET_KEY`, and the
public site key into the Mac's settings (`OSCR_TURNSTILE_SITE_KEY`). `FORGE_OPEN` is never set. Registering
the App first: [ARCHITECTURE.md](ARCHITECTURE.md), "The owner's steps".

## Local end-to-end run

```sh
cd website && npm ci
SITE_PORT=8791 MOCK_PORT=9491 FAKE_PORT=9490 RECEIVER_PORT=9492 sh tests/forge-service/e2e.sh   # KEEP=1 keeps the servers
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
refused (`FORGE_OPEN`). Phase 05's checks: the issue pages and the research shell are static; a
typed GitHub issue opened, labelled, commented and closed as not planned; a research issue opened,
labelled, commented and closed with a resolution (3, 2, 3 and 2 rows); a second one closed by the
merge of a pull request that says "Fixes research#N"; a copy on GitHub; another account's issue and
research issue refused. The fake also starts with labels, a milestone and issues
(`seedIssues`). Phase 07's checks: the release pages are the shell; Ada's ORCID iD linked; a release
published with her notes and GitHub's, tied to the accepted manuscript with its map, Software Heritage
and Zenodo asked (5 rows); the same tag refused; a tag a release uses kept, a scratch tag made and
deleted; the seeded draft read as Ada; a package confirmed; Bob's release and file refused; then the
Mac's `oscr forge poll --local --instance sandbox`, offline, its Zenodo the mock sandbox
(`OSCR_ZENODO_SANDBOX_URL`), and the checks of its answers (the map versioned with the release, the
deposit made on the mock: a new version of the map's record, the tag as its version, the code not
deposited). The fake also starts with releases (`seedReleases`). The fake starts with a CODEOWNERS file, an issue, and Bob's pull request from
his fork, reviewed with a suggestion (`tests/forge/fake-github-seed.ts` `seedPulls`). Phase 08's checks:
the social pages are static; Ada stars the repository, follows an author by ORCID iD before an account,
watches the repository and writes her profile (2 rows each); Bob's comment on GitHub, delivered by the
App's webhook, is one event row with its delivery row and a notification in Ada's inbox (she is
mentioned), which she marks read (2 rows); Bob's star and follow are refused; then the Mac's night on
the local databases (`oscr forge layer`, `oscr social layer`, `oscr social search`, `oscr_search`
migrated) and the search of repositories, research issues and people, and the static social shards
(`e2e.ts after-social`). Phase 10's checks: the tokens, webhooks, reference and Checks pages are static;
Ada makes a personal token (3 rows, answered once, listed without it), calls the public API with it
(her cookie alone opens nothing; an ETag's 304; a scope refused), posts a commit status (2 rows);
a webhook to a local receiver (`RECEIVER_PORT`, `HOOKS_ALLOW_LOCAL=1` for the local Worker only) is
pinged and then delivered GitHub's issue comment as an event, both signatures checked by the
receiver, an address on a private network refused; the App installed on the fixture's organization
(the fake's `POST /control/install`, a throwaway App key made by the run) posts the registry's check
run on Bob's pull request from its `synchronize` delivery, with 0 rows; Bob's token refused. Phase 16's
checks (`tests/forge-service/e2e-rules.ts`, with the Worker started again by `start_worker` on the same
state): a report without an account behind Turnstile (Cloudflare's test secrets against the mock's
`/turnstile/siteverify`), the owner's queue, a comment hidden for others; `FORGE_OPEN=true`: a
non-owner's research issue under the caps, the human check, a block (a comment and a reaction
refused), an interaction limit; the always-failing test secret. 216 checks in all. A test browser that shows the
`/r/` pages against the fake needs the Content-Security-Policy bypassed for them (it allows
GitHub's own hosts, not the fake's): the screenshots in `docs/night-screenshots/phase-01/` were
taken so, in headless Chrome only.

Locally (`wrangler dev --env local`): `FORGE` is bound to a local database
(`00000000-0000-4000-8000-00000000f09e`; `npx wrangler d1 migrations apply oscr_forge --local
--env local`), and the App's values go in the gitignored `website/.dev.vars`, with
`FORGE_GITHUB_*_URL` pointing at the fake GitHub (`website/tests/forge/fake-github.ts`).
