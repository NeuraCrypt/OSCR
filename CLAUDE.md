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
- **Papers**: a static page (and reader) for the `STATIC_PAPERS` (5,700 since the GitHub side's
  fixed files, D16-3; 6,000 before) most recent; the others
  are rendered by the Worker from `/records/paper/NN.json` (one Worker request a view, no D1 row),
  with a reduced page that says what it leaves out and keeps the Contribute section (claim,
  correction, removal request). Every request no file answers runs the Worker
  (`not_found_handling = "none"`), which serves the 404 page itself.
- **The DOI lookup**: 256 shards (`oscr/entities.py` LOOKUP_HEX, `/lookup/NN.json`).
- A new kind of page adds a fixed number of files, never one per paper or per entity.

## Git hosting (night phase 01)

The GitHub side (`website/worker/forge/`, D1 `oscr_forge`, `oscr/forgejobs.py`,
`oscr/forgelayer.py`; the contract: `docs/FORGE.md`; decisions D00-*, D01-* in `docs/DECISIONS.md`):

- **OSCR hosts no Git repository**: repositories live in the researcher's own GitHub account. Git
  goes straight to github.com with GitHub's own credentials: no git proxy, no git token issued by
  OSCR.
- **Every write is the person's own**, one authorized action at a time (`/api/forge/start`, GitHub,
  `/api/forge/act`): the user token is used for that action, revoked, and never stored, logged or
  answered. The App's installation token only posts OSCR's check runs and reads after a webhook.
- **`FORGE_OPEN` stays unset until phase 16's content rules are merged**: the write routes then
  answer only to `FORGE_OWNER_GITHUB_ID`. Never set it without the owner.
- **`oscr_forge` holds public repositories only**, and no email address, token or Git object; a
  repository made private leaves OSCR (hidden, its name blanked). Its writes are capped in code
  (5,000 rows a day; 100 actions, 10 creations, 20 links per account a day), counted from the rows,
  with no counter row; every read goes by key or index, never a scan.
- **Deletion**: 30 days of grace in OSCR; the deletion on GitHub is only the researcher's own fresh
  authorization, never a timer or OSCR's token. **Software Heritage** only on a person's request.
- The App's secrets are **Cloudflare secrets** set by `tools/setup_cloudflare.sh` (the private key
  read from GitHub's `.pem` file). The Mac never writes to a forge and never runs users' code.
- Repository pages are static (`/r/*`, one shell): signed out, they ask the Worker nothing.
  Webhooks: ≤ 1 MiB, the signature checked in constant time, allowlisted events, ≤ 2 rows each.
- Their styles are in `science.css`: `.repo-head`, `p.status-line`, `.setup`, `pre.commands`,
  `fieldset.choices`, `.limits`, `section.danger`, `table.branches`, `dl.settings`, `.panel`,
  `.confirm`.

## Content rules (night phase 16)

The lock before the GitHub side opens (`docs/MODERATION.md`, `docs/POLICIES.md`, D16-*):

- **Anyone reports** what the GitHub side shows (`/report/`), with or without an account, always
  behind **Turnstile verified server-side**; a copyright notice needs an account. **The owner alone
  decides** (`/moderation/`, the account whose linked GitHub id is `FORGE_OWNER_GITHUB_ID`): hide,
  suspend, restore, answer an appeal; a public notice without the hidden words (`/notices/`).
- **Hidden means absent** from every Worker answer at once (`hidden.ts`) and from every static file
  at the next nightly (`oscr/moderation.py`). A suspended account's writes stop, its tokens are
  revoked, its webhooks paused.
- **Blocks are silent**; interaction limits end by themselves; both are checked at `start` and in the
  registry's own writes.
- **`FORGE_OPEN` opens nothing without Turnstile's secret** (`gate.ts` `forgeOpen`). Never set it,
  nor `TURNSTILE_SECRET_KEY`, in wrangler.toml or a committed file; tests use Cloudflare's documented
  test keys only, against a local stand-in (`TURNSTILE_VERIFY_URL`, this machine only).
- **Known malware**: a file whose SHA-256 is on the owner's local list is never copied; the Mac
  hashes and compares, never runs, never fetches (`oscr/malware.py`).
- **The rules and privacy pages are drafts** until the owner reviews them; the privacy statement must
  stay true to what the code holds (the private contact details included). Data-rights requests are
  answered in the site, never by email.
- Each phase that adds an object brings its report target, its hiding in `hidden.ts` and the Mac,
  and its line in the privacy statement.
- Their styles are in `science.css`: `.human-check`, `p.moderated`, `table.queue`, `form.lookup`,
  `.draft-notice`, `.policy`.
- **Night phase 06 changes "no free text of a reader is public".** Discussions, projects and the wiki
  are OSCR's first public, user-written free text. Turnstile, the caps, blocks and interaction limits,
  email masking, the 65,536-character limit and triager hide/redact/delete are in force now; when
  phase 06 merges, `REPORT_KINDS`/`HIDDEN_KINDS`, the `moderation` and `content_reports` CHECKs,
  `hidden.ts`, `oscr/moderation.py`, `src/lib/moderation.ts` and the shared fixture must cover
  `discussion` and `discussion_comment`, and this statement must be updated (D06-6). No
  language-model moderator: rules, Turnstile, hiding and caps carry the load.

## Discussions, wiki and projects (night phase 06)

OSCR's own conversation, knowledge and planning surfaces (`docs/DISCUSSIONS.md`, D06-*), on the
research-issue model (D00-6). All behind `FORGE_OPEN`; OSCR never writes to GitHub on its own.

- **Discussions** (`discussions-core.ts`, `discussions.ts`, `0014_discussions.sql`): a space per paper
  (keyed by its DOI, its verified authors maintain it), per repository and per organization; up to 25
  categories with formats (open, announcement, qa, poll); comments (65,536 chars), upvotes, polls, the
  answered state, labels, close with a reason, lock, pin, transfer, the timeline. Votes counted once
  (`discussion_votes`). Turnstile on open and comment; blocks and limits via `mayInteract`; email
  masking on every text.
- **The wiki** (`act-wiki.ts`, `0016_wiki.sql`): Markdown pages on a `wiki` branch, edited through the
  phase-03 one-authorized-commit model (`wiki_edit`); the first page makes the branch (`createFrom`),
  later pages commit with `expectedHead`; history, a revision, compare and revert are reads of GitHub
  in the browser. Content committed verbatim; masked only when displayed.
- **Projects** (`projects-core.ts`, `projects.ts`, `0015_projects.sql`): owned by a person or an
  organization; items are issues, pull requests, drafts, papers, tracing maps and reproduction
  reports; built-in, custom and research fields (paper, map state, reproduction outcome); table, board
  and roadmap views; a field value in the item row (one row a change); caps 5,000 items, 50 fields.
- **Caps** (`caps.ts`): `discussions` (20, with actions), `votes` (200, own), `projects` (10, with
  actions), `project_edits` (300, own). Comments and edits count toward the 100 authorized actions.
- **Public free text**: see the phase-16 note above and D06-6.

## The command line (night phase 14)

The researchers' `oscr` (`cli/`, `docs/CLI.md`, D14-*):

- **Two commands are named `oscr`.** The harvester's (the root's `oscr` package, `.venv/bin/python -m
  oscr` in launchd) never changes for the researchers' one. The researchers' is `cli/` with the import
  package `oscr_cli`, the standard library only, installed in an environment of its own; never
  `pip install` it into the repository's `.venv`. Here it runs as `PYTHONPATH=cli/src .venv/bin/python -m
  oscr_cli`. Its settings are `~/.config/oscr-cli/`, its keychain service `oscr-cli`: never
  `~/.config/oscr/settings` nor `org.oscr.*`.
- **Its credentials live in the system's keychain only** (macOS `security -i`, the secret on standard
  input; Linux `secret-tool`); a 0600 file only when the person asks. No token in argv, logs or
  `--debug`. GitHub's token comes from GitHub's device flow with the App's public client id and never
  reaches the registry; the git credential helper answers GitHub's host only.
- **The registry's sign-in writes no row until a person decides**: codes sealed with `SESSION_KEY`,
  approved on `/device/` by typing the terminal's code (Origin, CSRF, FORGE_OPEN, Turnstile), the token
  made when collected. `DEVICE_CODE_SECONDS` is development only, never in wrangler.toml.
- **It never runs what it reads**: `oscr check` and `oscr trace` read files as text from git's object
  store; git always runs with `core.hooksPath` at the null device and `core.fsmonitor=false`. Its checks
  are the Worker's, held to `tests/fixtures/checks-cases.json` (regenerate with
  `website/scripts/checks-cases.ts` after a change of `checks-core.ts`, then make the port follow).
- **The registry's view first**: every command gives the registry's page; GitHub's only when the
  registry cannot show the thing, said why. Every text from the network is cleaned before it is shown.
- **Its tests never reach the outside nor the owner's files**: fakes on 127.0.0.1, a fake or throwaway
  keychain (an autouse guard refuses the system's), a throwaway HOME and `GIT_CONFIG_GLOBAL`:
  `cd cli && ../.venv/bin/python -m pytest -q && ../.venv/bin/ruff check src tests`.
- Its page's styles are in `science.css`: `input.device-code`.

## Security and quality (night phase 11)

Full detail in [docs/SECURITY_QUALITY.md](docs/SECURITY_QUALITY.md); decisions D11-1 to D11-9.

- **Nothing of a user's code ever runs** (D00-11): the Mac reads files as text, never executes a
  manifest, resolves, installs or runs an analyser; the Worker shows what the researcher's CI reported.
  The analysis runs on the Mac (0 Worker requests) and pushes facts to `oscr_forge`.
- **The dependency graph** (`oscr/depgraph.py`): Python, R, Julia, JavaScript, conda and GitHub Actions,
  at the default branch and at each commit a paper's map pins (`repo_deps`).
- **Vulnerability and malware alerts** from OSV without a key (`oscr/osv.py`, batch, CVSS severity,
  `MAL-` malware, auto-triage); the night build uses a fake, never the real OSV (`security_alerts` kind
  `osv`, the decision in `alert_triage`). OSCR shows Dependabot and never opens a pull request (AUP).
- **The secrets scan** reports and never blocks (`oscr/secretscan.py`): over the files already stored,
  the value never kept (`security_alerts` kind `secret`).
- **Code scanning**: the CI uploads SARIF 2.1.0 through the token API (`security:write`); OSCR runs no
  analyser (`security_alerts` kind `sarif`).
- **Private vulnerability reporting** (`advisories`, `advisory_posts`): private by construction, never
  in a public output, the static layer, the search, a feed or a webhook; a read is refused to anyone
  but the reporter, a named collaborator and a manager, until published.
- **SBOM** (SPDX 2.3, `oscr/sbom.py`, built in the browser from the graph) and **licence compatibility**
  (a table for the common open licences and a policy; dependency licences not fetched: unknown, never
  guessed; `repo_licences`).
- Every write is behind `FORGE_OPEN`; the migration is `migrations/d1-forge/0012_security.sql` (six
  tables, the `actions` kinds rebuilt with `SECURITY_KINDS`; caps `triage`, `scanning`, `advisory`).
  The command line: `oscr security scan|status|sbom`. Styles in `science.css` (`.security-*`,
  `ul.alerts`, `dl.deps`, `form.dep-filter`, `.advisory-*`).

## Organizations and accounts (night phase 09)

Full detail in [docs/ORGANIZATIONS.md](docs/ORGANIZATIONS.md); decisions D09-1 to D09-8. All in
`oscr_forge`, migration `migrations/d1-forge/0013_organizations.sql`.

- **Organizations** are OSCR's own layer over a lab, a group or a project (create, profile with a
  public and a members-only README, settings, pinned repositories, a verified-domain claim, an
  announcement banner, rename, archive, soft delete). A lab's GitHub organization is **linked, not
  replaced**: git rights stay GitHub's, and nothing here asks GitHub for a write.
- **Membership, roles, research permissions, teams**: invite (with an expiry), accept, decline,
  remove (with a leaving checklist), reinstate, roles (owner, moderator, member), research permissions
  (`propose_map`, `flag_map`, `validate_map`, `tie_release`) on a membership, own-visibility, teams
  (visibility, nesting). The last owner is protected.
- **Private membership and the members-only README are private by construction**: refused to a
  non-member; no static shard carries them (the static org page is deferred).
- **Account security**: sessions (list, revoke one or all the others; a true delete), identities
  (link list, unlink but never the last), **passkeys (WebAuthn)** for sudo mode verified in the Worker
  with WebCrypto only (no dependency, nothing paid; only a public key kept; origin, challenge, rpId
  and the sign counter checked), the personal security log (with a CSV export).
- The owner's and managers' writes are behind `FORGE_OPEN`; a person's own writes (answer an
  invitation, set visibility, leave, revoke a session, unlink an identity, add or use a passkey) are
  not. New `actions` kinds `org`, `member`, `team`, `passkey`, `session`, `identity`; caps `orgs`,
  `security`. No email anywhere. Pages `/organizations/` and `/account/security/` (science.css only).

## Repository statistics (night phase 12)

Full detail in [docs/STATISTICS.md](docs/STATISTICS.md); decisions D12-1 to D12-5. The Insights tab of
a `/r/` page, migration `migrations/d1-forge/0017_statistics.sql`.

- **GitHub is the competitor**: every statistic is drawn in the registry's own inline-SVG charts
  (`src/lib/stats-view.ts`), never a chart library and never a GitHub image; each chart is also a table
  with a CSV and a PNG. What GitHub can compute (Pulse, contributors, commit activity, code frequency)
  the reader's browser reads straight from GitHub, on the reader's quota, 0 Worker and 0 Mac requests
  (D12-1); a 202 is retried, a spent rate limit degrades to a sentence.
- **"Used by" counts a paper, not only a repository** (D12-2): a repository P is used by a repository D
  when D's dependency graph names a package P publishes, and every paper linked to D counts. Computed on
  the Mac (`oscr usedby`, `oscr/usedby.py`), served by `GET /api/forge/stats` by a key range, signed in.
- **Traffic is aggregate-only and maintainer-only** (D12-3): page views and visits, referrers and
  pages, refused to anyone but the repository's maintainers (so it never reaches the static layer, the
  search, a feed, a webhook or the API), **never a unique-visitor count and nothing per person**. Read
  from Cloudflare with a **read-only** token the owner keeps in the keychain
  (`org.oscr.cloudflare-analytics`), a Cloudflare secret the code never reads, prints or creates; unset,
  the view says traffic is not enabled; a local fake in the night build.
- **The research marks** a chart overlays (a commit a paper or a map cites), the star history and the
  community research checklist (a reusable licence, a `CITATION.cff`, a linked paper with a tracing map)
  are the registry's own facts. SVG joined the view tree; colour comes from `science.css` (D12-4). All
  reads signed in; no email; nothing of a user's code run.

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
