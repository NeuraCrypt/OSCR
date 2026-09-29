# Content, abuse and rules: the contract (night phase 16)

The lock before the GitHub side opens to the public. What people may report, what the owner decides,
what hiding removes, blocks and interaction limits, the human check, the abuse limits, known malware,
retention, and the switch `FORGE_OPEN`. The decisions: [DECISIONS.md](DECISIONS.md) D16-1 to D16-21.
The rules and privacy pages: [POLICIES.md](POLICIES.md). The routes in the forge service's table:
[FORGE.md](FORGE.md).

## Where the code is

| part | where |
|---|---|
| the pure part: targets, reasons, payloads, words | `website/worker/forge/service/moderation-core.ts` |
| reports, the owner's queue and decisions, appeals, a person's page | `…/service/moderation.ts` |
| what the reads drop | `…/service/hidden.ts`, `…/service/hidden-search.ts` |
| blocks and interaction limits | `…/service/blocks.ts`, `…/service/blocks-core.ts` |
| data-rights requests | `…/service/rights.ts` |
| the human check (Turnstile) | `…/service/turnstile.ts`; the widget: `website/src/scripts/human-check.ts` |
| the switch | `…/service/gate.ts` `forgeOpen`, `rulesReady` |
| the tables | `migrations/d1-forge/0010_moderation.sql` |
| the Mac: what the static files drop, the notices | `oscr/moderation.py` (and `oscr/forgelayer.py`, `oscr/social.py`) |
| the Mac: known malware | `oscr/malware.py` (`oscr malware scan\|status`), `oscr/contents.py` |
| the Mac: retention | `oscr/retention.py` (`oscr forge retention`, and the nightly) |
| the pages | `/report/`, `/moderation/`, `/account/moderation/`, `/notices/`, `/settings/blocked/`, `/data-rights/`, and the rules' pages ([POLICIES.md](POLICIES.md)) |

## Reports

Anyone reports anything the GitHub side shows, from the "Report" link beside it (`/report/?target=…`):

| target | names |
|---|---|
| `person:github:<id>`, `person:orcid:<iD>` | a person (their account) |
| `repo:<forge>:<id>` | a repository the registry knows |
| `research:<n>`, `research:<n>#<c>` | a research issue, one of its comments |
| `issue:<forge>:<repo id>#<n>`, `pull:…#<n>`, `release:<forge>:<repo id>/<tag>` | a GitHub issue, pull request or release as the registry shows it |
| `list:<github:id or orcid:iD>/<n>` | a public star list |
| `status:<forge>:<repo id>:<sha>:<context>` | a commit status |
| `snippet:<id>` | reserved until phase 13 (refused: 501) |

The reasons are the acceptable-use policy's: spam, harassment and abuse, private information,
malware, copyright, impersonation, misinformation, unlawful content, another breach (words required).
Without an account, the site's Origin and Turnstile are the proofs; with one, the session and its
CSRF token too. A copyright notice needs an account (its claimant is answered in the site); a report of
private information does not. Nothing about a reporter without an account is kept; the queue says
only whether a reporter had one; texts lose their email addresses. 3 rows a report; 20 a day per
account, 50 a day for all reports without an account.

## The owner's queue and decisions

`/moderation/` (the owner's account only: the linked GitHub id is `FORGE_OWNER_GITHUB_ID`) lists the
open reports, the appeals and counter-notices, the data-rights requests (with the person's handles and
the date due). A decision:

- **dismiss** a report;
- **hide** a thing: a repository (from the registry's pages), a research issue or comment, a GitHub
  issue, pull request or release (from the registry's pages), a star list, a commit status, a
  profile's words, or **suspend** an account (its writes stop — 403 `suspended` —, its tokens are
  revoked, its webhooks paused, and its issues, comments, profile, stars, follows, lists, statuses and
  events are hidden, retroactively); with a reason, a public notice (redacted), words for the person;
- **restore** it (the notice says when); **answer an appeal** (accepted restores it).

Every open report of a thing is answered with its decision. The Phase 6 removal requests of catalogue
records stay the Mac's (`oscr reports`).

## What hiding removes

At once, from every answer of the Worker (`hidden.ts`): the research reads (a hidden issue is 410 for
everyone but its author and the owner; a hidden comment, or one by a suspended account, keeps its place
without its words), people's pages and activity, the inbox and the feed, webhook deliveries and
redeliveries, commit statuses, the repository's layer (410 for a hidden repository but to whoever
manages it and the owner; `moderatedThreads` names its hidden GitHub threads, whose pages then say only
why, and whose lists leave them out), the search (research issues and repositories at once). At the next
nightly, from the static files (`oscr/moderation.py`): the layer, the research shards, the social
shards and Explore, hence the search's index. `forge/moderation.json` carries the public notices
(`/notices/`) and the hidden repositories with their papers (a line on each paper's page, so that its
tracing map stays explained). A research issue about a hidden repository stays: it is its paper's.

## Appeals and counter-notices

The person whose thing is hidden reads why on `/account/moderation/` and may appeal once, or answer a
copyright takedown with a counter-notice (its two statements: good faith, accuracy). The appeal waits
in the owner's queue; the answer is read on the same page. Never by email.

## Blocking

From a profile or a comment ("Block its author"), silent. The blocked person cannot comment on, react
to, or open issues and pull requests in the repositories the blocker manages (who linked or created it
in the registry, and the account that owns it on GitHub), nor comment on the blocker's research issues,
nor follow the blocker; their events and mentions leave the blocker's inbox and feed. The refusal says
only "You cannot take part". A block does not hide what they wrote (that is a report), nor stop them
reading, nor anything on GitHub. `/settings/blocked/` lists the blocks (a ref, the handle, the date, the
blocker's note) and unblocks. 2 rows.

## Interaction limits

On a repository (its managers) or on every repository an account manages: existing users (accounts
older than 24 hours), contributors (the papers' verified authors, the code's maintainers, the
managers), or managers only; for 24 hours, 3 days, 1 week, 1 month or 6 months; the stricter of a
repository's and its managers' accounts' limits applies; a limit ends by itself. Checked where a block
is. 2 rows.

## Turnstile, the human check

Cloudflare Turnstile (free). Verified server-side (`siteverify`, one subrequest a protected send, the
reader's address not sent), on: a report, an appeal, a research issue, a new research comment, a
profile, a star list's name, a personal token, a webhook, a data-rights request. A request of the public
API carries its token (made behind the check) instead. The widget (`human-check.ts`) is drawn by
Cloudflare in its own frame; the pages with such a form allow `challenges.cloudflare.com` in their CSP,
nothing else outside. The site key is public (the build writes it into `<meta
name="turnstile-site-key">`); the secret is a Cloudflare secret. Without the secret, a report cannot be
sent (503) and `FORGE_OPEN` opens nothing.

Tests use Cloudflare's documented test keys only: the secret `1x0000000000000000000000000000000AA`
always passes, `2x0000000000000000000000000000000AA` always fails; the site keys
`1x00000000000000000000AA` (passes) and `2x00000000000000000000AB` (blocks); the dummy token
`XXXX.DUMMY.TOKEN.XXXX`. Their `siteverify` is a stand-in on this machine (`TURNSTILE_VERIFY_URL`,
accepted for 127.0.0.1 and localhost only, never in wrangler.toml).

## Abuse limits

The per-account caps of every phase stand (FORGE.md "Caps"); phase 16 adds reports, appeals, blocks,
limits and data-rights requests, and refuses an address sending 20 wrong API tokens in a minute
before any read. Comments hold 65,536 characters; attachments go through the Worker up to 1 MiB and 100
files (25 MiB a release asset); a text mentions 10 people at most.

## Known malware

Pushes go to GitHub, not through the registry (D00-11): malware cannot be refused at push. The registry
never copies a file whose SHA-256 is on a known-malware list (the harvester keeps its path, size and
digest, a note, and no text), `oscr malware scan` (and the nightly) drops the text of files stored
before and hides the GitHub side's repository holding one (never over the owner's restoring it).
Nothing is ever run. The list is a local file the owner fetches: `data/malware/sha256.txt` (or
`OSCR_MALWARE_LIST`), one SHA-256 a line, `#` comments.

## Retention

Each night (`oscr/retention.py`, `OSCR_RETENTION_BUDGET` rows, 2,000 by default), by key: events and
unsaved notification states past 3 months, webhook deliveries past 7 days and those of deleted hooks,
tokens expired for 30 days, ended interaction limits, reports decided more than a year ago, data-rights
requests answered more than 3 years ago. Moderation decisions are kept (their notices are public).

## Rows (D1, the GitHub side's 5,000 a day)

A report 3; a decision 2–6 (a suspended account's tokens 2 each, hooks 1 each); an appeal 4; a block or
an unblock 2; a limit 2; a data-rights request 3, its answer 2. At the plan's volumes (§15.4), ~200 a
day.

## Opening the GitHub side (the switch)

`FORGE_OPEN="true"` opens the write routes to every signed-in account **only with the content rules in
force** (`forgeOpen`: Turnstile's secret set); otherwise they stay the owner's. The owner's steps, in
order, are in [NIGHT_REPORT.md](NIGHT_REPORT.md): create the Turnstile widget; run
`tools/setup_cloudflare.sh` (step 9: the secret, and the site key into the Mac's settings); apply the
migrations (`oscr_forge` 0010, `oscr_community` 0003 and 0004); deploy; check a report and a research
comment behind the check; review the policy drafts; then set `FORGE_OPEN=true` as a Cloudflare variable
(the dashboard, or `npx wrangler secret put FORGE_OPEN`) — never in wrangler.toml.

## Local end-to-end run

`tests/forge-service/e2e.sh` (FORGE.md "Local end-to-end run") runs phase 16's stages last
(`tests/forge-service/e2e-rules.ts`: `closed`, `open`, `fail`), starting the Worker again for each on the
same state. The screenshots: `docs/night-screenshots/phase-16/`.

## Security review (2026-09-29)

- The moderation routes (queue, decisions, a data-rights answer) check the owner in the Worker, not in
  the page; tested with another account (403 `owner_only`).
- Every POST checks the site's Origin (and `Sec-Fetch-Site`); a signed-in one the session's CSRF token.
- Turnstile is verified server-side, once a token; its stand-in is accepted on this machine only;
  wrangler.toml holds neither the switch nor Turnstile's values (a test says so).
- No email address is asked, shown or stored: every text is masked, a remaining at sign made harmless,
  the CHECKs refuse one; the queue names no reporter and no account id.
- Hidden content is absent from pages, the API (the same handlers), the search, feeds and webhooks;
  fixed during the review: a redelivery of an event hidden since, a private list's existence learned by
  reporting it, a hidden repository named in someone's stars, GitHub threads on the /r/ pages.
- The row budget holds (counted per route in the tests); no scan (the fake D1's plan check).
- No user code is executed: the Worker reads text; the Mac hashes and compares; `oscr/malware.py`
  imports neither a process nor a network library (tested).
