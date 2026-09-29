# Open Scientific Code Registry (OSCR): the project's rules

## The owner's rules

- **Zero cost.** If a feature does not fit the free tiers, flag it and propose an
  alternative instead of building it.
- **No secret in the code**: tokens go in the macOS keychain or in Cloudflare secrets.
- **No email address or other non-public personal data is displayed.** The website hides
  every email address, including those in the authors' code (`catalog.mask_emails`).
- **The authors' contact details are collected, privately** (decided 2026-09-27): email,
  given and family names, ORCID, organization, address and affiliation of each author,
  linked to the paper and its DOI (`oscr/contacts.py`, table `contact`). They go only to
  the **private** Hugging Face dataset `OpenScientificCodeRegistry/Private`; the publisher
  refuses a dataset that is not private. Never on the site, never in a public output
  (`catalog.public_db` drops the table). No mass email to the authors.
- **Merge and deploy without waiting for the owner's approval, and ask the owner only the
  minimum** (decided 2026-09-28: « fusionne sans me demander, attends pas mon accord »,
  « dis-moi le minimum nécessaire »). Still one commit per phase, on a dedicated branch.
  What only the owner can do (accounts, keys, a Cloudflare step the permissions refuse to
  Claude) goes into a step-by-step tutorial or a script the owner runs
  (`tools/setup_cloudflare.sh`).
- **Style: `science.css` only.** A component that needs a new style gets its rule added to
  `science.css` (no other style source), without waiting for approval since 2026-09-28.
- **The platform's name lives in one configuration variable, `SITE_NAME`**; never hard-code
  it.

## The owner's decisions of 2026-09-27 (Phase 0)

- **Availability statements**: their full text only under an open license (CC BY, CC0,
  CC BY-SA, CC BY-NC); otherwise a short summary and a link.
- **Pages** only for papers with code, "on request" and "data only"; any other paper read is
  found by a DOI lookup.
- **Search**: SQLite FTS5 in D1. A search runs only when the form is submitted (never as you
  type). When the daily quota is spent, a clear message says so. Plan B: a static index on
  Hugging Face.
- **Sign-in**: the owner creates the ORCID (sandbox first), GitHub and Google applications.
- **Notifications**: in the site only. No email.
- **Classification**: rules first, a local model only for the ambiguous cases, compared
  beforehand on a sample the owner labels by hand. **The model uses the GPU only between
  01:00 and 07:00.**
- **Scope**: harvest broadly, filter by classification. Off-topic papers stay on the Mac,
  out of the site and out of the statistics.
- **Address**: the free `workers.dev` address while building; a domain before the public
  launch.
- **Hosting**: Cloudflare Workers (the site as static assets, the dynamic routes as the
  Worker's code), not Pages. Site: https://oscr.yannbellec-b.workers.dev
- **OpenAlex**: the owner creates the key; it goes in the keychain.

## DOIs and Zenodo

- DOIs are assigned through **Zenodo** (free), **only for tracing maps validated by an
  author**. Never for automatically generated records.
- The DOI is on the **map** (links + metadata), not on the author's code. That code is never
  redeposited.
- Relations:
  - `IsSupplementTo` points to the paper's DOI;
  - `References` points to the code repository.
- Creators: the author who validates (with their **ORCID**) + the platform.
- The **Zenodo sandbox** (sandbox.zenodo.org) for all development.
- A **Zenodo community** gathers the maps (`oscr`).
- **No paid service.**

In the code: `oscr/zenodo.py`. A test validation (`proof = 'test'`) is accepted by the
sandbox only; the public database does not export it.

## Script copies (decided 2026-09-26, index settled 2026-09-27)

OSCR keeps copies of the authors' scripts, stored this way (measurements, projection and
license audit: `docs/SCRIPT_STORAGE.md`; code: `oscr/scriptstore.py`, `oscr scripts …`):

1. **Deduplication** by content digest (SHA-256 of the text): each unique file is stored once.
2. **zstd compression** (Parquet page compression, level 19).
3. **Parquet blocks** (`blocks/NNNNN.parquet`): one row per unique file (sha256, language,
   size, lines, content), 64 rows per row group, 64 KiB pages, rows sorted by language then
   size, ~30 MB per block. **A published block never changes**: new files go into new blocks.
4. **No index in D1.** The positions (block, row) are written into the static pages at
   build time, and **one manifest per repository** (`manifests/<xx>/<repository>.json`:
   commit, license, and for each file its digest, block and row) serves the pages rendered
   on demand.
5. The blocks and manifests go to the Hugging Face dataset
   **`OpenScientificCodeRegistry/Database`**, incrementally (`oscr scripts publish`, and
   every night). The reader reads the row it needs in the browser, with HTTP range requests
   (hyparquet).

- **Only verified licenses leave the Mac.** A file is published when its repository's
  license allows redistribution AND is confirmed by the repository's own license file (for
  an archive without one: by its record). A license inferred from a README sentence,
  "other-open" without a license file, or no license: the file stays on the Mac, and the
  site links to it at the source, at the verified commit.
- The scripts dataset is published **only once the license filter is applied and verified**:
  done on 2026-09-27 (`oscr scripts audit`; figures in `docs/SCRIPT_STORAGE.md`). Any change
  to the filter is audited again before the next publication.

## Accounts (Phase 5)

Sign-in with ORCID, GitHub and Google in the Worker's code (`website/worker/account/`, D1
database `oscr_community`, `docs/ACCOUNTS.md`):

- **No email address is asked for, read or stored**: ORCID and Google `openid` only, GitHub no
  scope; notifications stay in the site (D5).
- A provider's token is used during the sign-in's callback only, **never stored**; D1 keeps a
  session's SHA-256, never its id.
- Client ids and secrets and the server key (`SESSION_KEY`) are **Cloudflare secrets**, or
  `website/.dev.vars` locally (gitignored).
- **ORCID sandbox** until the owner sets `ORCID_ISSUER=https://orcid.org`.
- The databases, the server key and the six sign-in values are set by the owner with
  `sh tools/setup_cloudflare.sh` (it asks for each value, never shows it, never writes it to a
  file).
- The facts the verifications read (`paper_orcid`, `repo_owner`, `paper_repo`) come from the Mac
  (`oscr community`, pushed nightly once `OSCR_COMMUNITY_PUSH=remote`); the Worker never writes them.

## Contributions (Phase 6)

What signed-in readers ask of the registry (`website/worker/contributions/`, `oscr/jobs.py`,
`docs/CONTRIBUTIONS.md`). The Worker checks and records (a row and a `jobs` row in D1
`oscr_community`); the Mac polls (`oscr jobs poll`) and answers into the request's row.

- **Submission**: a DOI and 1–5 code links, checked at once in the Worker (the DOI is registered,
  each link answers, and points to a place the registry knows: the Worker fetches nothing else).
  The license is the Mac's to read. The Mac harvests the paper into a draft; the submitter reviews,
  corrects, publishes — at once when their ORCID iD is among the paper's authors, otherwise after
  the owner's decision (`oscr submissions`). An off-topic paper stays out (D7).
- **Edition**: a record's links only (code, data, tools), never markup, by a verified author of the
  paper or a maintainer of its code (their own repository). Every correction is a new version
  (`link_edit`, kept across rescans); who made it stays on the Mac — the pages say its role only.
- **Validation**: a verified author, with the ORCID iD of their linked identity, validates the map
  the page showed (its digest; a map that changed since is not deposited). Deposit on the **Zenodo
  sandbox** unless `OSCR_ZENODO_INSTANCE=zenodo`. While sign-in uses ORCID's sandbox, a validation
  is recorded as a test (`proof = 'test'`), never exported.
- **Badge**: one static image (`/badge.svg`, no file per paper) and snippets; the author opens the
  pull request in GitHub's own editor. No write permission is ever asked of GitHub.
- **Takedown**: one page, `/removal/?paper=…`, linked from every record (signed in until Turnstile):
  who asks, what (the record, the scripts' copies, a repository, a file, the tracing map), why, a
  justification without an email address, two confirmations, a review before sending. Decided by the
  owner (`oscr reports`); accepted, it leaves every public output at the next nightly — the record
  (`article.withdrawn`) or only what it names (`withheld`).
- Manual author claims and claims GitHub cannot settle: decided by the owner (`oscr claims`) until
  Phase 7's moderation.
- **Costs**: a request writes 3 D1 rows, an answer 1 (in the facts push's daily budget); per-account
  daily limits are counted from the rows; a signed-out reader's page view asks the Worker nothing
  (the `__Host-oscr_signed_in` hint cookie). No email address in any form: the texts lose theirs.

## The website's file budget (decided 2026-09-28)

A Worker serves at most 20,000 static files per version; the site stays under 15,000 whatever
the catalogue's size (`website/src/lib/shards.ts`, held by `npm run check`; docs/PLATFORM_PLAN.md §6):

- **No file per entity.** An author, journal, institution, tool or dataset is one shell page per
  type, served for `/author/<orcid>/` and the like by a rewrite of `public/_redirects` (free, no
  Worker request), and rendered in the browser from `/records/<type>/NN.json` (a fixed number of
  shards per type, `SHARDS`: 2,304 files for the five types and the papers). The lists
  (`/authors/`, …) link to every entity.
- **Papers**: a static page (and reader) for the `STATIC_PAPERS` (6,000) most recent; the others
  are rendered by the Worker from `/records/paper/NN.json` (one Worker request a view, no D1 row),
  with a reduced page that says what it leaves out and keeps the Contribute section (claim,
  correction, removal request). Every request no file answers runs the Worker
  (`not_found_handling = "none"`), which serves the 404 page itself.
- **The DOI lookup**: 256 shards (`oscr/entities.py` LOOKUP_HEX, `/lookup/NN.json`).
- **The lists and the sitemap** (2026-09-29): the list of every paper by date, `/list/` (100 a page,
  `LIST_PAGES_MAX` = 200 pages at most), and the sitemap's shards (`SITEMAP_SHARDS` = 32 at most) are
  in `FIXED_FILES_MAX`, raised to 3,500; a paper's page is one file since the reader is on it, so
  `STATIC_PAPERS` + `FIXED_FILES_MAX` = 9,500 stays under the 15,000 margin.
- A new kind of page adds a fixed number of files, never one per paper or per entity.

## Information pages (the launch, 2026-09-29)

About, Help (an index and 13 guides), Policies (an index and 8 policies), Privacy, Brand, Labs and
Taxonomy, on the model of arXiv's info site, in the site's own words (`website/src/pages/`, their
menus in `website/src/lib/info.ts`, the layout `src/components/Info.astro`):

- **Every statement is true of the code and the docs**: a feature, a number, a partner or a promise
  that does not exist is never written. What exists only on unmerged branches (the night branches)
  is named on Labs only, marked "in development". Figures come from the build's export.
- **A footer on every page** (`Base.astro`): About, Help, Policies, Privacy, Brand, Labs, Taxonomy,
  Limits, the source. The masthead stays compact, with the owner's logo (`public/brand/`, made by
  `tools/make_logo_assets.py`; its alt is `SITE_NAME`).
- **`OPERATOR_NAME` and `OPERATOR_ADDRESS`** (`website/src/config.ts`, next to `SITE_NAME`, or at
  build time) name the operator on `/privacy/` and `/policies/terms/`. Empty, the pages say that they
  are published before the launch, and `npm run check` prints a launch warning (never a failure).
- **Privacy** lists every personal datum, the private collection of authors' contact details
  included; a change to what the registry keeps changes `/privacy/` in the same commit.
- `/policies/code/` and `/policies/moderation/` are written with the code reader: the pages link to
  them through `pageExists` (a link once the page exists, its name until then).
- **The home page** shows the latest days, whole, up to `HOME_PAPERS` (100) papers with code; every
  paper with a page is in `/list/` (100 a page, `LIST_PAGES_MAX` pages at most); the sitemap
  (`/sitemap.xml`, `SITEMAP_SHARDS` shards of 50,000) and `robots.txt` list and guard the rest.
  `npm run check` fails when a paper with a page is linked from no static page or missing from the
  sitemap.
- **Headers**: a site-wide block first in `public/_headers` (nosniff, referrer, permissions, a
  strict policy, HSTS without `includeSubDomains` or `preload`); a page that needs more removes the
  site's policy (`! Content-Security-Policy`) and sets its own. `worker/pages.ts` gives its pages the
  same; `npm run check` holds every inline script and style to its page's policy.

## The website's style (website/)

- `website/src/styles/science.css` is the **only** source of style of the site. It is
  imported **once**, in the main layout (`src/layouts/Base.astro`).
- **No other style**:
  - no other CSS file;
  - no `<style>` in the components;
  - no `style` attribute;
  - no utility classes;
  - neither Tailwind nor a component library.
- As the header of `science.css` says: no dark theme by default, no pills, no decorative
  uppercase.
- A style need that `science.css` does not cover gets a rule there, never a workaround in a
  component.
- The markup follows the classes of `science.css`:
  - the masthead (`.masthead`, with the site's name and its search) and the breadcrumb
    (`.breadcrumb`);
  - the catalogue: one `h2.day` per publication day, then a `dl.listing`.
    - `dt`: `.num`, the identifier, the links.
    - `dd`: `.title`, then `.line` rows with a `.label`: "Journal", "Authors' code",
      "Status".
  - the page of a paper: `.record`, with its `.body` and the `.sidebar` on the right; its
    sections are a `nav.tabs` > `ul` > `li` > `a` bar under the title (`li.later` for the
    sections that open with sign-in).
  - a status is said in words (`.ok`, `.warning`), never with a pill.
  - a highlighted term: `mark` or `.highlight`.
  - the Code ↔ Paper reader: `.compare` holds two `.pane` (the paper, the code), each with
    a `header` and its content; the code's lines are an `ol.lines`, one `li` per line; a
    paragraph and the lines that match it share one class of `.pair-1` to `.pair-6`; the
    selected pair is marked `.is-active` on both sides.

## Already in force

- Neither the PDF nor the full text of a paper leaves: the site links to it by its DOI. Its
  abstract and its availability statements are shown in full only under an open license
  (decision D1; otherwise a summary and a link). The sentences that decided a link's verdict
  stay in the private database.
- A file whose license does not allow redistribution is never published: its text stays
  on the Mac (see "Script copies").
- No mass email to the authors: they come to us.
- The Hugging Face dataset `opsecsystems/oscr-catalog` stays **private** until decided
  otherwise.
- The tokens never go into the repository nor into the settings. They stay in the macOS
  keychain: `org.oscr.huggingface`, `org.oscr.zenodo-sandbox`, `org.oscr.zenodo`,
  `org.oscr.github` (read-only on public repositories; `GITHUB_TOKEN` wins when set),
  `org.oscr.openalex`, and `org.oscr.cloudflare-d1` if the owner ever makes one: without it,
  the search's push goes through wrangler's own login, like the deployment. The sign-in's
  secrets are Cloudflare secrets.
- The search's databases get the day's changes every night once `OSCR_D1_PUSH=remote` is in
  the settings (`oscr nightly`, within `OSCR_D1_BUDGET`, 80,000 rows by default).
- Commits: one per phase, on a dedicated branch; no other commit without being asked.
