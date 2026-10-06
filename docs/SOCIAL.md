# Social, discovery, notifications and search in the registry (night phase 08)

The GitHub side's social layer: stars and star lists, watching repositories and papers, following
people, authors (by ORCID iD, before they have an account) and organizations, profiles, the in-site
notifications, the activity feed, a person's contributions, Explore, and one search across the
registry. Everything is shown in the registry; GitHub is its competitor, reached only as a last
resort, through an "at the source" link after a sentence that says why (GitHub's own code search,
which needs a GitHub sign-in).

- **The registry's own, never GitHub's.** OSCR never stars, follows or watches anything on GitHub (the
  plan's AUP §4): every star, list, follow, watch level, profile and notification state is a row of
  D1 `oscr_forge`, each one a person's own act, signed in, one write at a time.
- **Notifications stay in the site** (the owner's decision D5): no email is ever sent, and no email
  address is asked for, shown or stored. The inbox is computed when its reader opens it, from what
  they watch and follow (fanned out on read): nothing is written per recipient.
- **Until phase 16's content rules**, every write answers only to the owner (`FORGE_OPEN`, D01-1);
  signed-in readers may read. Phase 16 runs after this phase (the owner's order change of 2026-09-29):
  what it must cover of this phase is D08-17.

The decisions: [DECISIONS.md](DECISIONS.md) D08-1 to D08-18; the phase's plan:
[PLATFORM_PLAN.md](PLATFORM_PLAN.md) §15.6 "Phase 08"; the GitHub side's contract:
[FORGE.md](FORGE.md); the papers' search it joins: [SEARCH.md](SEARCH.md).

**In one paragraph.** The Worker writes the rows (`website/worker/forge/service/social.ts`,
`inbox.ts`, `events.ts`; `migrations/d1-forge/0008_social.sql`) and never counts them: each night
the Mac reads them and publishes static shards, counts, stargazers, public profiles, the Explore
page, that a signed-out reader's pages read, asking the Worker nothing (`oscr/social.py`). Events
(an issue commented, a pull request merged, a research issue opened, a release tied to a paper) are
ONE row each, keyed by their subject (a repository or a paper), written with what caused them: the
registry's research routes, the authorized actions, and the App's webhooks. The pages are
`/notifications/`, `/stars/`, `/feed/`, `/explore/` and ONE shell for every person, `/u/<GitHub login
or ORCID iD>/`; Star, Watch and Follow sit on a repository's page, a paper's page and an author's
page. The search gains repositories, research issues, people and topics beside the papers, from an
FTS5 index the Mac builds from the night's public files.

## What one stars, watches and follows (D08-2, D08-3)

| what | stored as | where |
|---|---|---|
| a star | `repo:<forge>:<id>` (the durable id: a rename keeps it), `paper:doi:10.…`, `topic:<name>` | `stars` |
| a list's entry | the same subjects, in one of the person's 32 lists (public or private) | `star_lists`, `star_list_items` |
| a watched repository | `repo:<forge>:<id>`, level `all`, `participating`, `custom` (issues, pulls, releases, research) or `ignore` | `follows` |
| a watched paper | `paper:doi:10.…` (new code, a release tied, research issues) | `follows` |
| a person | `github:<numeric id>` | `follows` |
| a catalogue author | `orcid:<iD>`, its check digit verified, before they have an account | `follows` |
| an organization | `owner:<forge>:<login>` (its repositories the registry knows) | `follows` |
| a journal, tool, dataset, category | `journal:<id>`, `tool:<id>`, `dataset:<id>`, `category:<facet>/<value>` | `follows` |
| a conversation | `thread:<subject>#<thread>`: followed on taking part (`auto`), or unsubscribed (`ignore`) | `follows` |

A label (what the page showed) is the person's own words for their Stars page; the public pages name
each subject from the registry's own data (a repository's path, a paper's title), never from a label.

## Routes

Every route is signed in (`account/guard.ts` `signedIn`); every POST checks the Origin and the CSRF
token, then `FORGE_OPEN`, the account's cap, the day's rows, and writes ONE batch with its action row
(kinds `star`, `star_list`, `follow`, `notice`, `profile`; the action row's `subject` says what). A
write that changes nothing writes nothing. No answer names an account's id.

| route | what | rows written |
|---|---|---|
| `GET /api/forge/social?s=…` | the reader's star, lists and follow of ≤ 20 subjects or targets (the buttons) | 0 |
| `GET /api/forge/social/mine` | the reader's stars, lists (private ones included), follows, profile, caps | 0 |
| `GET /api/forge/social/person?github=<id>` or `?orcid=<iD>` | a person's public profile, lists, stars, follows (none from a private profile), whether the reader follows them; `account: false` for an author without an account | 0 |
| `POST /api/forge/social/star` | `{subject, label, on}` | 2 (unstar: + 1 per list it leaves) |
| `POST /api/forge/social/follow` | `{target, label, level?, events?, on}` | 2 |
| `POST /api/forge/social/list` | `{op: create \| edit \| delete \| add \| remove \| propose, …}` | 2 (delete: + its entries; add of an unstarred subject: 3) |
| `POST /api/forge/social/profile` | name, bio, pronouns, company, location, time zone, website and 4 links (https, no user part), 6 pinned items, status (with an end), busy, private, the profile README shown | 2 |
| `GET /api/forge/social/inbox` | the reader's notifications, computed now | 0 |
| `POST /api/forge/social/notices` | read, unread, done, undone, save, unsave, unsubscribe, subscribe (≤ 25 threads), all read, settings | 1 per thread + 1; all read, settings: 2 |
| `GET /api/forge/social/feed` | the last 14 days of what the reader follows, their follows and settings | 0 |
| `GET /api/forge/social/activity?github=` / `?orcid=` / `?me=1` | a person's contribution calendar (a year), timeline (3 months), milestones in words; nothing from a private profile | 0 |

**Caps** (`caps.ts`, `social-core.ts`): 300 social writes and 500 notification changes per account in
24 hours, counted apart from the 100 authorized actions (a person who stars and reads keeps the right
to act); 3,000 stars, 2,000 follows, 32 lists of 300 entries per account; the day's 5,000 rows of the
GitHub side (`gate.ts`), counted from the action rows as every write.

## Events (D08-5 to D08-7)

ONE row in `events` per event, keyed by `(subject, at, nonce)`: its subject (`repo:<forge>:<id>` or
`paper:doi:10.…`), its kind, its thread (`issue:12`, `pull:3`, `research:7`, `release:v1.0`,
`code:<owner/name>`), its title (masked, 200 characters), a path of this site (never another site's
address: the column's CHECK and the writer refuse `//host` and `/\host`), the actor (their account's
id when they acted in the registry, never answered -, their GitHub id and login), the thread's
author, the GitHub logins its text names (`@login`, ≤ 10), and `ref`, GitHub's object.

| source | events | rows |
|---|---|---|
| research issues (`research.ts`) | opened, commented, closed, reopened, under the paper; the author and each commenter follow the thread | open 5 (was 3), comment 4 or 5 (was 3), close or reopen 3 (was 2) |
| authorized actions (`act.ts`, `events.ts eventsOfAction`) on a repository the registry knows | an issue or pull request opened (+ the thread followed), commented, reviewed, closed, reopened, merged; a release published; code linked to a paper and a release tied to one (under the paper) | + 1 per event, + 1 for a thread newly followed |
| the App's webhooks (`webhook.ts`) | `issues` (opened, closed, reopened), `issue_comment` (created), `pull_request` (opened, reopened, closed, merged), `release` (published) on a public repository the registry follows | 1, with the delivery's row: 2 (D01-24) |

- **The same act seen twice is one event** (D08-6): an action made through the registry, then
  GitHub's webhook for it (or the other way round), name the same GitHub object (`comment:<id>`,
  `issue:<n>:opened`, `pull:<n>:merged`, `release:<tag>`…); each insert is conditional on no event of
  the same subject naming it by the same GitHub account within a day (the key's prefix and a time
  range: never a scan).
- **GitHub's codec** (`github/webhooks.ts`) reads `issues` and `issue_comment`: the number, the title,
  the author, and the logins the text names, never the text itself; an email address is no mention.

## Notifications (D08-8 to D08-10)

The inbox (`inbox.ts computeInbox`), when its reader opens it:
1. the reader's follows (their key): watched repositories at their level, watched papers,
   organizations (their repositories the registry knows, by the index `repos_path`, 30 each), followed
   threads; at most 60 subjects, the most recently followed first (the answer says when some are left
   out);
2. each subject's events of the last 3 months (the key's prefix), 30 at most;
3. a repository that left the registry (made private: hidden, D00-14; deleted; gone) drops its events
   at once: the inbox never names a private repository; a paper's events never name a repository;
4. the reader's own acts are no notification; an unsubscribed thread is silent; the reason: a
   mention, the thread's author, a thread taken part in, a watched repository (at its level, or its
   custom event types), a watched paper, an organization;
5. grouped by thread (GitHub's unit), the newest first, with the reader's states: read and done until
   newer activity, saved kept past the 3 months with the words it showed.

The page (`/notifications/`, `src/scripts/notifications.ts`, `src/lib/social.ts`): the views Inbox,
Unread, Saved, Done, Read; GitHub's filters `repo:`, `org:`, `author:`, `is:read|unread|done|saved|
issue|pr|release|research|paper|repository`, `reason:` and words, applied in the browser (one request
a view); custom filters saved (15); bulk triage (25 at a time); mark all as read; opening a thread
marks it read; what the reader watches and follows, each with Unwatch or Unfollow; the settings
(show what involves me, show what I watch), and the sentence: no email is ever sent.

## The feed, profiles, Explore (D08-11 to D08-14)

- **The feed** (`/feed/`): the last 14 days of the people (their public acts: stars, follows, what
  they did in the registry, with its event), authors by ORCID iD (found once they sign in), the
  organizations, repositories and papers the reader follows; the new papers of the authors followed
  (the catalogue's, from `/social/authors/NN.json`); "See less like this" hides a kind (the settings).
- **Profiles** (`/u/<GitHub login or ORCID iD>/`, ONE shell: `public/_redirects` `/u/* /u/ 200`): the
  person's words, handles (the ORCID iD linked), pronouns, status and busy flag, website and links;
  an identicon (a 5 × 5 table of cells, one of eight hues by class: no image); the profile README (the
  person's `<login>/<login>` repository, read raw in the reader's browser and rendered by the
  registry's own Markdown renderer); pinned items; milestones in words (papers with code in the
  registry, the first map validated, code linked, Software Heritage asked, a research issue opened);
  the contribution calendar of a year with the person's publications from the catalogue (a dot); the
  timeline; public lists, stars and follows; one's own profile edited there. A private profile keeps
  its activity, stars, lists and follows to its owner. Signed out: last night's shard.
- **Explore** (`/explore/`, from `/social/explore.json`: 0 Worker requests): the repositories and
  papers most starred this week, the people most followed (public profiles only), the topics (the
  curated ones, `oscr/social.py FEATURED_TOPICS`, with their aliases; `?topic=<name>`), and the
  collections: public star lists proposed by their owner and accepted by the registry's owner
  (`oscr social collections`, `accept`, `decline`).

## The static files (D08-15)

`oscr/social.py` (`oscr social layer --local|--remote`, and `oscr nightly` with
`OSCR_FORGE_PUSH=remote`, after the forge layer) reads `oscr_forge`'s social tables and
`oscr_community`'s handles in key order, a page at a time, and writes into the export:
- `social/NN.json`, 64 shards (the first byte of the key's SHA-256, mod 64; `src/lib/social.ts`
  `socialShard`, checked on `tests/fixtures/social-shards.json`), keyed by `repo:…`, `paper:doi:…`,
  `topic:…` (stars, watchers, the stargazers whose profile is public, the registry's name),
  `person:<handle>` (a public profile, or `private: true`; an ORCID iD whose person has a GitHub login
  points to their entry), `owner:<forge>:<login>` (followers);
- `social/explore.json`.
The build copies them (`scripts/data.mjs`: well-formed keys in their shard, addresses scrubbed),
`npm run check` checks them, and the site builds `/social/authors/NN.json` (64 shards: an author's
papers by ORCID iD). Never in them: an account's id, a label, a private list, a private profile's
content, a followed thread, a notification state, an event, a hidden repository, an email address. No
count row is ever written.

## Search (D08-16)

- **Papers stay the first type and the default** (the Phase 3 search, unchanged). The masthead gains a
  type: Papers, Repositories, Issues, People, Topics, Commits, Code. A DOI typed alone goes to its
  paper (the DOI lookup).
- **Repositories, research issues, people, topics**: `GET /api/search?type=…&q=…&page=`
  (`website/worker/forge-search.ts`), ONE FTS5 index, `forge_fts` in `oscr_search`
  (`migrations/d1/search/0002_forge.sql`), pushed by the Mac from the night's **public** files only
  (the forge layer, the research shards, the social layer, the Explore page: `oscr/social.py`
  `search_docs`, `push_search`; `oscr social search`; `oscr nightly` with `OSCR_D1_PUSH=remote`),
  incrementally (a DELETE and an INSERT per change, 2,000 a run). The query: words, `"phrases"`,
  `-excluded`, `is:open|closed`, `type:code-error|mismatch|reproduction`, `user:`/`org:`,
  `repo:owner/name`, `doi:`, `in:title`; every term is quoted before FTS5; the type's page and every
  type's count in ONE batch; cached and answered in words like the papers' (the quota first).
- **GitHub's issues and commits of one repository** (`repo:owner/name`): GitHub's search API in the
  reader's browser, on the reader's own quota (10 a minute), shown in the registry with links into its
  own pages. Across every repository the registry knows GitHub cannot be asked (a query holds five
  operators at most): the page says so.
- **Code**: GitHub's code search needs a GitHub sign-in (GitHub's rule): the page carries the query
  there, at the source, and says why. The registry's own code index (`oscr_code`) is deferred.

## What it costs (PLATFORM_PLAN §15.4: ~5,500 requests, ~1,200 rows written, ~200,000 read a day)

- Signed out: 0 Worker requests (the shards, Explore, the profile shell, the counts on the buttons).
- Signed in: 1 request a page (the buttons' state, the inbox, the feed, a profile, the activity);
  each write 1 request.
- Rows written, measured in the tests and the end-to-end run: a star, a follow, a list, a profile, a
  notification's state: 2; a research issue: 5; an authorized action's event: 1 (and 1 for a thread
  newly followed); a webhook's event: 2 with its delivery row. At the plan's volumes (500 stars and
  follows, 200 notification changes, ~700 events a day) that is ~2,700 rows a day, above the plan's
  1,200 (D08-18): with the earlier phases' ~2,600, the GitHub side then reaches its 5,000-row cap,
  which answers `quota` rather than overspend; C3 (20,000) lifts it.
- Rows read: an inbox at most 60 × 30 events (typically a few hundred); a feed at most 30 people's 14
  days and 40 subjects' 20 events; a year's calendar in four key ranges of the person's own actions.
- Search: 5 statements a search (the page and four counts, ≤ 1,001 rows each).
- Files: 7 pages, 64 author shards, and 65 nightly files (`social/`): 136, whatever the number of
  people, stars or follows.

## Security (the phase's self-review)

- **No token stored**: the social routes use none; the webhook's codec keeps no text.
- **CSRF and Origin**: every POST (star, follow, list, profile, notices) goes through `signedIn` with
  `post: true`; the tests refuse another site's Origin and a missing token on each.
- **FORGE_OPEN on every new kind**: `maySocial` asks `mayWrite` before anything is written; the
  end-to-end run refuses Bob's star and follow.
- **No email address**: every text masked before it is stored (`cleanLine`, `maskEmails`); a name
  loses its at signs; a website is https without a user part; events keep a title and logins, never a
  text; the static files are scrubbed again by the build and checked.
- **Nothing private leaks**: the inbox reads the reader's own follows only; a repository made private
  leaves every inbox at once (tested); a paper's events never name a repository; a private profile's
  stars, lists and follows are its owner's; private lists never leave; account ids are never
  answered; the search index is built from the public static files only.
- **No open redirect**: every address a page is given goes through `sitePath` (a path of this site, or
  nothing); the events' URL column refuses `//host`; a saved notification's URL is checked.

## Where the code is

| part | where |
|---|---|
| the tables | `migrations/d1-forge/0008_social.sql` |
| stars, lists, follows, profiles | `website/worker/forge/service/social-core.ts`, `social.ts` |
| events, the inbox, the feed, the activity | `website/worker/forge/service/events.ts`, `inbox.ts`; the writers `research.ts`, `act.ts`, `webhook.ts`; GitHub's codec `website/worker/forge/github/webhooks.ts` |
| the search | `migrations/d1/search/0002_forge.sql`, `website/worker/forge-search.ts`, `api.ts`; `src/lib/search-types.ts`, `src/scripts/search-types.ts` |
| the pages | `src/pages/notifications.astro`, `stars.astro`, `feed.astro`, `explore.astro`, `u/index.astro`, `social/authors/[shard].json.ts`; `src/scripts/notifications.ts`, `stars.ts`, `feed.ts`, `explore.ts`, `profile.ts`, `social-buttons.ts`, `social-client.ts`; `src/lib/social.ts` |
| the Mac | `oscr/social.py`; `oscr social layer|search|collections|accept|decline`; `oscr nightly` |
| the tests | `website/tests/forge-service/social.test.ts`, `inbox.test.ts`; `tests/forge-search.test.ts`; `tests/forge-pages/social.test.ts`, `search-types.test.ts`; `tests/test_social.py`; the end-to-end run's phase 08 checks |

## Deferred

- Mentions outside what the reader watches (a per-person mention index would cost a row per mention).
- The feed's journals, tools, datasets and categories (the follows are kept and listed; the catalogue's
  new papers for them come with a static index of their own).
- The organization and repository dashboards, "For you" recommendations, good first issues, trending
  by language or contributions, GitHub's repository topics (topics are curated and starred ones),
  funding (`FUNDING.yml`, grants and funders from the catalogue).
- A stargazers and watchers page (the shards hold 100 stargazers; the pages show counts).
- The registry's own code index (`oscr_code`, a fifth D1 database: the owner's decision); saved and
  recent searches; the advanced search form for the new types; GitHub's discussions, wikis, snippets
  and packages as search types (with their phases).
- Deleting events older than 3 months (reads are bounded by time; storage grows ~100 MB a year).
- The status's end and the pins' order in the form (the API takes both); private contributions'
  count on the calendar; a confirmed reproduction by someone else as a milestone (no reproduction is
  recorded yet).
