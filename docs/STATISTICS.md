# Repository statistics (night phase 12)

How the registry shows a repository's statistics, on the Insights tab of a `/r/` page. The guiding
rule: **GitHub is the competitor**, so every statistic is drawn in the registry's own charts (inline
SVG), never a chart library and never a GitHub image. What GitHub can compute, the reader's browser
reads straight from GitHub (0 Worker and 0 Mac requests). What only the registry has (who depends on
the code, the research marks, the star history, the privacy-respecting traffic) is computed on the
Mac or read from Cloudflare with a read-only token, and shown by the registry.

## The Insights tab

`/r/<owner>/<name>/insights/` (the view `insights`, the tab "Insights"). The client is
`website/src/scripts/repo-insights.ts`; the charts are pure functions in
`website/src/lib/stats-view.ts` (tested in `website/tests/forge-pages/stats-view.test.ts`); the
community checklist is `website/src/lib/community-view.ts`.

Sections, in order:

1. **Community profile** (E5): the health files GitHub checks for (README, licence, code of conduct,
   contributing, security policy) read in the browser from GitHub's `community/profile` endpoint, AND
   what a paper's code needs (a licence that lets the code be shared, a `CITATION.cff` with a DOI, a
   paper linked with a tracing map, from OSCR's layer). A score and a research note per item.
2. **Used by** (E2/E3): how many papers and repositories depend on this one, with a bounded sample.
3. **Traffic** (E4): aggregate page views and visits, referrers and popular pages; maintainers only.
4. **Commit activity, Participation, Code frequency, Contributors** (E1/E2): read from GitHub's
   statistics API in the browser.
5. **Star history** (E3): the registry's own stars over time.

Every chart is **also a table**, folded under "The numbers", with a **CSV** download and a **PNG**
download (the PNG is rasterised from the live SVG in the browser, colours inlined, so nothing of the
page leaves). The charts carry geometry only; colour is set by `science.css`'s `.chart` classes, so a
chart reads the same wherever the theme goes (D12-4).

## What the browser reads from GitHub (0 Worker/Mac requests)

`repo-insights.ts` reads these from GitHub directly, on the reader's own quota (D12-1):

- `GET /repos/{o}/{r}/stats/commit_activity` (weekly commits, 52 weeks);
- `GET /repos/{o}/{r}/stats/participation` (everyone vs the owner, 52 weeks);
- `GET /repos/{o}/{r}/stats/code_frequency` (additions and deletions per week);
- `GET /repos/{o}/{r}/stats/contributors` (top contributors; GitHub counts include merge commits,
  said in words rather than guessed);
- `GET /repos/{o}/{r}/community/profile` and a `contents` read of `CITATION.cff` and `SECURITY.md`.

GitHub answers **202 with no body** while it computes a statistic; each read retries a few times and
then says "the source is still computing". A spent anonymous rate limit degrades to a sentence.

## What the registry computes (OSCR's own facts)

`GET /api/forge/stats?id=<forge>:<id>` (`worker/forge/service/statistics.ts`) serves, signed in, by a
key range (never a scan):

- **Used by**: `repo_stats` (the counts and the star series), `repo_dependents` (a bounded sample,
  papers before repositories). The research angle (D12-2) is that a **paper** counts: a repository P
  is used by a repository D when D's dependency graph (`repo_deps`) names a package P publishes
  (`repo_packages`, confirmed), and every paper linked to D then counts as a paper that uses P.
- **Research marks**: `repo_marks`, overlaid on the time-series charts (a commit a paper or a map
  cites, placed at the paper's publication day; a tag tied to a paper version or a DOI).
- **Star history**: the registry's own stars (`stars`, phase 08) aggregated per day.

The Mac computes these (`oscr usedby scan`, `oscr/usedby.py`): a reverse index over every repository's
dependency graph and confirmed packages, the paper links, the star events, and the paper dates from
the catalogue for the marks. It writes only for the repositories whose numbers changed, within the
facts push's daily budget. Migration `migrations/d1-forge/0017_statistics.sql`.

## Privacy-respecting traffic (maintainers only)

`GET /api/forge/traffic?id=…` (`worker/forge/service/traffic.ts`), signed in and **refused to anyone
but the people who maintain the repository** (403), so the traffic never reaches the static layer, the
search, a feed, a webhook or the public API. It is **aggregate only** (D12-3): page views and visits
per day (14 days) and per week (104 weeks), referring sites and popular pages. There is **no
unique-visitor count and nothing per person**: the query never asks Cloudflare for `uniques`, and the
parser drops anything it does not expect.

It is read from Cloudflare's GraphQL analytics with a **READ-ONLY token** the owner creates (Account
Analytics: Read) and keeps in the keychain (`org.oscr.cloudflare-analytics`), set as a Cloudflare
secret. The code never reads, prints or creates it; it only passes it as the request's bearer. Unset
(or no account id / site tag): the view says traffic is not enabled. Development and the tests use a
local stand-in (`CLOUDFLARE_ANALYTICS_URL`, `deps.analyticsFetch`); the end-to-end run's fake is
`website/tests/forge/fake-cf-analytics-server.ts`.

## Budget and cost

- The GitHub charts cost the Worker and the Mac nothing (read in the browser).
- The Mac writes ~1,000 rows a night (the repositories whose counts changed); the Worker reads by key
  or key range, never a counter row and never a scan.
- Maintainer traffic is ~300 reads a day, each one Cloudflare analytics call. Reading Cloudflare's
  analytics is free on the Workers Free plan's included analytics; if a future volume needs a paid
  tier, that is flagged to the owner before it is turned on, and the view falls back to "not enabled".

## Deferred (D12-5)

- The network graph (branches drawn for the reader) and the forks tree/activity view.
- Research marks for **tags** tied to a paper version or a DOI, and marks resolved from each cited
  commit's own date (tonight a paper mark sits at the paper's publication day).
- The static-layer "Used by" counter for signed-out readers (today the facts are signed in).
- Discussion insights, CI metrics as GitHub reports, rule insights, lab research insights for an
  organization, and transparency reporting of moderation (counts only).
