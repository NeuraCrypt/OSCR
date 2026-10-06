# Automation and integrations in the registry (night phase 10)

What the registry does on its own and what other services do with it: its checks on every pull
request, which run no code; the researcher's own CI, shown in the registry; commit statuses posted by
outside services; outgoing webhooks for papers and repositories. The public API and its personal
tokens are [API.md](API.md). The decisions: [DECISIONS.md](DECISIONS.md) D10-1 onwards; the plan:
[PLATFORM_PLAN.md](PLATFORM_PLAN.md) §15.6 "Phase 10"; the GitHub side's contract:
[FORGE.md](FORGE.md).

- **No code is ever executed by the registry**, on the Mac or on Cloudflare (D00-11): the checks read
  files as text; the tests run on the researcher's own GitHub Actions, and the registry shows what
  they report.
- **Everything is shown in the registry.** GitHub is reached only as a last resort, said so: a CI
  log, which GitHub gives only to a signed-in person.
- **Until phase 16's content rules**, every write this phase adds answers only to the owner
  (`FORGE_OPEN`): tokens, webhooks, statuses. What phase 16 must cover: D10-14.

## The registry's checks (D10-8, D10-9)

One pure module, `website/worker/forge/checks-core.ts`, shared by the Worker and the reader's browser.
It reads a commit's tree listing and three files as text (the licence, `CITATION.cff`, the README)
and never anything else; nothing is built, installed, imported or run.

| check | passes when | to look at (neutral) | fails (only when the change itself breaks it) |
|---|---|---|---|
| Licence | a licence file at the root, recognised from its text (MIT, Apache-2.0, BSD, GPL, LGPL, AGPL, MPL, EUPL, ISC, Unlicense, CC0, CC BY, CC BY-SA, BSL, Artistic, CeCILL) | none, or one not recognised | the change deletes it |
| Environment | a file that says how the code runs again (`src/lib/environments.ts`: requirements, conda, renv, Julia, a container, a lock file…) | none, or only scripts |, |
| The paper's DOI | the repository linked to its paper in the registry | not linked (a DOI named in CITATION.cff or the README: a note), or no DOI anywhere |, |
| CITATION.cff | present, readable, a title, authors, a DOI | missing, unreadable (a note: no DOI) | the change deletes it or leaves it unusable |
| Tracing maps | every file a map points to still there | at a commit, a file a map points to gone (the map stays valid at its pinned commit) | the change deletes or renames a file a map points to; editing one is a note, with an annotation |
| File sizes | nothing over 50 MiB | files over 50 MiB (data belongs in a data repository, with a DOI) |, |
| README | present, and says how to install or run the code | missing (how to run it missing: a note) |, |

Each finding says what was found and how to resolve it. The conclusion is `failure` only when the
change breaks what a paper relies on, `neutral` when something is missing, `success` otherwise.

### On every pull request (D10-9)

- The App's `pull_request` deliveries, `opened`, `synchronize` (every push), `reopened`,
  `ready_for_review`; drafts and bots' pull requests included, on a public repository the registry
  follows, covered by the installation that sent them (`webhook.ts`), start `pr-checks.ts` in
  `waitUntil`, after the delivery is answered.
- The App's installation token (narrowed to the repository: `read`, then `checks: write`; minted with
  the App's key, kept in memory for its hour) reads the head commit, its tree, three files and the
  changed files (up to 300), and posts **one check run**: an overview, each check's level and reason,
  annotations (50 a request, further ones in more requests), its details page the registry's own view
  of the commit (`/r/<owner>/<name>/checks/<sha>`).
- A head commit whose message ends with GitHub's trailer `skip-checks: true` is not checked.
- **0 D1 rows**: the result lives on GitHub (the check run) and is computed again in the registry's
  view. About 10 GitHub requests, on the installation's own quota.
- Its name on GitHub: `<SITE_NAME>: research checks` when the Worker has `SITE_NAME`, else "Research
  code checks" (the platform's name is never hard-coded).

### At any commit: the Checks view (D10-10)

`/r/<owner>/<name>/checks/<ref>` (the repository's new **Checks** tab; a branch, a tag or a commit),
in the one `/r/` shell, computed in the reader's browser on the reader's own quota:
- the registry's checks (the tree: 1 request; the files raw: not counted);
- **the commits the papers cite** (their tracing maps' pinned commits, from the static shard): each
  a link to the checks at that commit, "checks at the paper's commit";
- **the repository's own tests**, as GitHub reports them: check runs and the combined status (2
  requests), in words; the registry's own check run named as the registry's; the logs stay with GitHub,
  which asks a sign-in to download them, the one link to GitHub, said so;
- **the statuses posted to the registry** (signed in: `GET /api/forge/statuses`, 1 Worker request;
  signed out, a sentence and no request);
- **the tested environments**, read from `.github/workflows/*.yml` as text: the systems, the
  languages' versions of the matrices, the containers, each workflow's triggers and jobs.

A pull request's Checks tab links to the view of its head.

## Commit statuses (D10-11, D10-12)

An outside service, a lab's CI, another forge, a reproduction service, says how a commit of a
repository the registry knows fared: `error`, `failure`, `pending` or `success`, under a context of its
own ("lab-ci/tests"), with a sentence and an https page. D1 `statuses` keeps the latest of each context
on each commit, 20 contexts a commit at most; 2 rows a status (its row, upserted; the action row).

- **With a token** that may `statuses:write`: `POST /api/forge/v1/statuses/post {repo, sha, state,
  context?, description?, target_url?}`.
- **From GitHub Actions, without any secret**: the workflow asks GitHub for its OIDC token with the
  registry's address as the audience (`permissions: id-token: write`; `core.getIDToken(<origin>)`)
  and posts to `POST /api/forge/v1/statuses/actions` with it as the bearer. The Worker checks GitHub's RS256
  signature against its published keys (fetched once an hour; an unknown key fetches them again at
  most once a minute), the issuer (`https://token.actions.githubusercontent.com`), the audience (this
  site), the times, a public repository the registry knows by its id. The status is the repository's
  own, named "GitHub Actions: <workflow>"; its action row's account is the repository
  (`oidc:github:<id>`), so the cap counts per repository. Until phase 16, only the owner's own
  repositories.
- `GET /api/forge/v1/statuses?path=&sha=` (and the site's `GET /api/forge/statuses`) answers them with
  GitHub's combined state (failure when one failed or erred, pending when one waits, success when all
  passed).

## Outgoing webhooks (D10-5 to D10-7)

A person registers a webhook on `/settings/hooks/` (or `POST /api/forge/v1/hooks/write`) on:
- **a paper** (`paper:doi:10.…`): `research_opened`, `research_comment`, `research_closed`,
  `research_reopened`, `code_linked`, `release_tied`, how journals, labs and indexes follow what
  happens to a paper's code;
- **a repository the registry knows** (`repo:<forge>:<id>`): `issue_opened`, `issue_closed`,
  `issue_reopened`, `issue_comment`, `pull_opened`, `pull_closed`, `pull_merged`, `pull_reopened`,
  `pull_review`, `pull_comment`, `release_published`;
- all of them (`*`), or some.

These are the events the in-site inbox shows (`events.ts`): public in the registry. 10 webhooks an
account, 10 on a subject.

**The address** (`hooks-core.ts` `hookUrl`, checked when it is registered and again before every
delivery): https; no user name, password, at sign or fragment; the port 443 or above 1023; never an
IPv4 address of this machine, a private network, link-local (the cloud metadata addresses),
carrier-grade NAT, multicast or reserved; never an IPv6 literal; a name has a dot and no local suffix
(`.local`, `.internal`, `.localhost`, `.lan`, `.home.arpa`…), and no public name that points anywhere
(`nip.io`, `sslip.io`…); never the registry itself. A redirection is never followed (`redirect:
"manual"`: a 3xx is a failure). The Worker resolves no name itself: the delivery leaves from
Cloudflare's network, never from the owner's. Development only, `HOOKS_ALLOW_LOCAL=1` lets http on
localhost and 127.0.0.1 through (the local end-to-end run's receiver); a test keeps it out of
`wrangler.toml`.

**Made, pinged, active.** The registry sends a `ping` at once; the webhook is active once the ping is
answered 2xx (else paused, until a ping is). 4 rows: the hook and its index entry, the ping's
delivery, the action row. Its **secret** (`whsec_…`) is answered once; it is never stored: it is the
HMAC-SHA-256 of the hook's id and `salt` under the server key (`SESSION_KEY`, purpose "hook"). A new
secret is a new salt (1 row + 1). Rotating `SESSION_KEY` changes every webhook's secret: their
owners then rotate them again.

**A delivery.** After the batch that wrote an event, an authorized action (`act.ts`), a research
write (`research.ts`), one of GitHub's deliveries (`webhook.ts`), `queueHooks` runs in `waitUntil`:
the subject's active hooks (the index `hooks_subject`: one query, 0 rows when there are none), the
event row by its key (an event already written by another path is not there twice: D08-6), then one
POST per hook that wants it:
- headers `Content-Type: application/json`, `X-Hook-Event`, `X-Hook-Delivery` (a UUID), `X-Hook-ID`,
  `X-Hub-Signature-256: sha256=<hex>` (the HMAC-SHA-256 of the raw body, GitHub's own scheme, so
  receivers' usual code checks it) and the same as `X-Hook-Signature-256`;
- the body: the event's kind, its subject, its time and `sent_at`, its thread, its title (masked),
  the absolute address of its page in the registry, the repository's path, the paper's DOI, the
  actor's GitHub id and login, never a text, never an address of a person, never an account's id;
- 5 seconds for an answer; tried again after 1 s and 4 s on no answer, a 5xx, 408 or 429; never on
  another 4xx or a 3xx; at most 20 sends a request (the free plan's 50 subrequests are shared with
  GitHub's calls);
- each delivery 1 row in `hook_deliveries` (its status, the time it took, the tries, a few fixed words;
  never the answer's body), counted in the day's 5,000 rows (`gate.ts`); past the cap the delivery is
  made and not logged;
- ten failures in a row pause the webhook (1 row).

No Queues, no Cron Triggers (not in the free plan's budget, §15.4): a delivery that failed three
times waits for its person, who sees the last 7 days of deliveries and **redelivers** an event's (the
payload rebuilt from the event's row: 1 row + 1).

Receivers check the signature first, in constant time (examples on `/developers/#webhooks`).

## What it costs (PLATFORM_PLAN §15.6: ~9,000 requests, ~800 rows written, ~200,000 read a day)

| act | Worker requests | D1 rows written | other |
|---|---|---|---|
| a token made / revoked | 1 | 3 / 3 |, |
| an API call | 1 | 0 (a write: the site's rows; a token's last use: 1 a day) | its route's reads |
| a webhook made | 1 | 4 | 1 subrequest (the ping) |
| an event's deliveries | 0 (inside the request that wrote the event) | 1 a delivery | 1–3 subrequests a hook |
| a commit status | 1 | 2 | (GitHub Actions: GitHub's keys, once an hour) |
| a pull request's check run | 0 (inside GitHub's delivery) | 0 | ~10 GitHub requests, the installation's quota |
| the Checks view | 0 signed out, 1 signed in | 0 | 3 GitHub requests, the reader's quota |

## Integrations (D10-13)

- **The App's own registration** stays the owner's step (ARCHITECTURE.md, "The owner's steps"): the
  permissions it already asks (Checks: write) and the events it already receives (`pull_request`) are
  all the check runs need. For the run's name to carry the platform's name, the Worker gets the
  variable `SITE_NAME` at deployment (D10-9).
- **Slack and Teams** follow GitHub through their own apps; for the registry's own events, a webhook
  to a relay the person runs. The registry has no Marketplace, and third-party apps use personal
  tokens: deferred (D10-13).

## Where the code is

| part | where |
|---|---|
| the checks | `website/worker/forge/checks-core.ts`; the check run `worker/forge/service/pr-checks.ts` (from `webhook.ts`) |
| statuses | `worker/forge/service/statuses.ts`; GitHub Actions' token: `account/jwt.ts` `verifySignature` |
| webhooks | `worker/forge/service/hooks-core.ts`, `hooks.ts`; called by `act.ts`, `research.ts`, `webhook.ts` |
| the rows | `migrations/d1-forge/0009_automation.sql` |
| the pages | `src/pages/settings/hooks.astro`, `src/scripts/hooks.ts`, `src/lib/automation.ts`; the Checks view `src/scripts/repo-checks.ts`, `src/lib/checks-view.ts` |
| the tests | `website/tests/forge-pages/checks-core.test.ts`, `checks-view.test.ts`, `automation.test.ts`; `website/tests/forge-service/pr-checks.test.ts`, `statuses.test.ts`, `hooks.test.ts`; the end-to-end run (`tests/forge-service/e2e.sh`) |
