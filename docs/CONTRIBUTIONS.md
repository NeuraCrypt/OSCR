# Contributions (Phase 6)

What a signed-in reader asks of the registry, submit a paper and its code, claim a paper, correct a
record, validate a tracing map, add the badge, request a removal, use their data rights, and how the
Mac answers: by the automatic moderator's published rules (there is no human moderator on duty), the
owner deciding only what the rules leave. Live since 2026-09-28; the data rights since 2026-09-29.
The steps marked **[owner]** are at the end.

| piece | where |
|---|---|
| the tables (D1 `oscr_community`, migrations 2, 3 and 4) | `migrations/d1-community/0002_contributions.sql`; `0003_removal_requests.sql` (the removal request made whole, 2026-09-29); `0004_data_rights.sql` (the data-rights requests, and `jobs` taking their kind, 2026-09-29) |
| the routes (the Worker's code) | `website/worker/contributions/` (`handleContributions`), `website/worker/rights/` (`handleRights`: the data rights), `website/worker/account/guard.ts` (session, CSRF, Origin: shared with the accounts) |
| the pages | `/submit/` (`src/pages/submit.astro`, `src/scripts/submit.ts`); `/removal/` (`src/pages/removal.astro`, `src/scripts/removal.ts`; its rules, shared with the Worker: `src/lib/removal.ts`); a paper's Contribute section (`src/components/paper/Contribute.astro`, `src/scripts/paper-actions.ts`); the account page (`src/pages/account.astro`, `src/scripts/account.ts`); the badge (`src/pages/badge.svg.ts`); `/data-rights/` (`src/pages/data-rights.astro`, `src/scripts/data-rights.ts`; its rules, shared with the Worker: `src/lib/rights.ts`) |
| the Mac's side | `oscr/jobs.py` (`oscr jobs`, `oscr claims`, `oscr reports`, `oscr submissions`); `oscr/migrations/0006_contributions.sql` (`link_edit`, `article.withdrawn`); `oscr/migrations/0008_withheld.sql` (`withheld`: a removal narrower than a record) and `catalog.withheld`; `oscr/moderation.py` (the automatic moderator); `oscr/rights.py` (`oscr rights`: the data rights) and `oscr/contacts.py` with `oscr/migrations/0009_contact_suppressed.sql` (the suppression list); `oscr/community.py` (the `paper_repo` facts, the remote push, D1 read and written) |
| the tests | `tests/test_jobs.py`, `tests/test_removals.py`, `tests/test_moderation.py`, `tests/test_rights.py`, `tests/test_community.py`; `website/tests/contributions/` (`removal.test.ts`, `moderation.test.ts`, `rights.test.ts`); the local end-to-end run `website/tests/account/e2e.sh`, with the removal page in a headless Chrome (`tests/contributions/removal-e2e.ts`) |

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
(or the owner made them one), publication is immediate; otherwise the moderator's rules decide
("Moderation", below): published when each link is proven the paper's, else it waits for the owner
(`oscr submissions`), 30 days at most. Published, the links become the submitter's corrections of the record, and a new
version. An off-topic paper (D7) is refused, in words.

**Claim** (a paper's Contribute section). Phase 5 already makes a verified author of anyone whose
ORCID iD the paper's metadata lists. Anyone else says why they are an author (a statement, an
optional web page): a pending claim, which the moderator's rules verify when Crossref's automatic
update put the paper in the claimant's ORCID record ("Moderation", below); otherwise it waits for the
owner, who accepts it (`oscr claims accept`: the `verified_author` role, granted by the owner, which
the automatic verification never takes back) or refuses it, with a word the claimant reads, 30 days
at most, then the rules close it. Phase 5's maintainer claims that GitHub cannot settle join the same
queue.

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
records the validation as `test`, which only Zenodo's sandbox accepts, and which no public output
shows (`catalog.public_db`, `catalog.json`).

**The badge** (a verified author or a maintainer of the paper's code). One static image,
`/badge.svg` (a flat rectangle, the platform's name from `SITE_NAME`: no file per paper, the site
holds at most 20,000), and three snippets that link it to the paper's page, Markdown,
reStructuredText, HTML, each with a Copy button. **Proposing it on GitHub** needs no permission: a
link opens the README of each GitHub repository of the paper (`/blob/HEAD/<README>`, the name read
from the repository's file list) or the repository itself when it has none; the author edits it in
GitHub's own editor and opens the pull request themselves, explicit consent by construction. The
one-click pull request (the author's own GitHub authorization, a token used once) is **not built**:
it needs the `public_repo` scope, which gives write access to every public repository of the
person, for a gain of two clicks.

**Request a removal** (the page `/removal/?paper=<the registry's id or a DOI>`, since 2026-09-29;
signed in until Turnstile comes with Phase 7). One static page for every record, linked from each
paper's page (its sidebar's "Request removal", its Contribute section) and from the page rendered on
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
  authors' scripts; one repository's copies; one file; the tracing map, a repository and a file are
  chosen among the paper's own. Why: copyright or license, personal data, wrongly attributed or not my
  work, a retracted paper, an incorrect record (the page suggests the correction flow first, and links
  to it, but allows the request), another reason. A **justification** of 30 to 2,000 characters,
  refused with a clear message when it holds an email address (or an at sign). An optional **evidence
  link**, https only. **Two confirmations**: the information is accurate; the requester understands how
  requests are decided (the moderation policy, `/policies/moderation/`) and what can follow.
- **Review, then send.** The page checks the request with the Worker's own rules (`src/lib/removal.ts`),
  then shows a summary of everything; **nothing is sent before "Confirm and send"**. The receipt gives
  the request's number, its status (open), what the rules will do with it (`report.expected`) and when a
  decision takes effect.
- **Revisited**, the page shows the request: open (it may be completed: what is sent replaces it, and
  it keeps its number), accepted or refused, with the decision's words (the rules' or the owner's). One
  request per account and record; a refused one is asked again only in a way the rules decide at once.
- **The rules decide** ("Moderation", below): a verified author's request is applied at once, a trusted
  maintainer's for their own code too, copies are hidden at once for copyright or personal data; the
  rest waits for the owner (`oscr reports list`, `oscr reports accept|reject <n> [--message "…"]`), 30
  days at most, or, asked for personal data, until the owner answers it, within one month (never closed
  unanswered). Accepted, what the request names leaves every public output **at the next nightly
  publication** (04:17, the Mac's local time), while the Mac keeps everything:
  - the whole record: `article.withdrawn` says when and why; the record leaves the site, the lookup,
    the search's D1, the community facts and the open data, like an off-topic paper;
  - the copies of the paper's scripts, of one repository or of one file (`withheld`, migration 8): their
    text leaves the site's lots of scripts, the public database and the Hugging Face scripts dataset
    (at its next build, a repository withheld loses its manifest, a file its entry). Unlike a file held back
    for its license, which the reader's browser shows from its source, a withheld file is **neither copied nor
    shown from its source**: it stays listed, with its link to the source at the verified commit and the note
    "Withheld from this site at a removal request: read it at the source", and nothing fetches it;
  - the tracing map: its Map section says it is withheld, with neither digest (nothing to validate: a
    validation that comes anyway is refused, in words), nor matches, nor validations, nor DOI on the
    site, in the open data and in the search's rows.

  Rejected, nothing changes; the requester reads the decision's words either way. The owner may reverse
  what the rules applied (`oscr reports reverse <n>`): what was withheld or withdrawn comes back.

## Moderation: the automatic moderator (decided 2026-09-29)

There is no human moderator on duty. So that nothing waits forever and nothing harmful is published
unchecked, `oscr jobs poll` (the Mac, every ten minutes) decides by published rules
(`oscr/moderation.py`; the public page `/policies/moderation/`), in the safe direction: **hiding is
automatic when in doubt, publishing needs a verified identity or checks that pass.** The owner's
commands keep working: they decide what waits, override a rule's refusal (`accept`) and reverse what a
rule did (`reverse`).

### Where a reader's input reaches a public output (the inventory)

| input | public output | the rule |
|---|---|---|
| a submission's code links (1–5, places the registry knows) | the record's links, once published | an author's: published; anyone else's: published only when each link is proven the paper's by what the submitter cannot forge (below), else it waits for the owner |
| a submission's note, a correction's note, a claim's statement and link, a removal's justification and evidence | **none**: read by the owner only (no email address: the Worker strips them, the schema refuses an at sign) | n/a |
| a correction of a record's links | the record's links, a new version ("a correction by a verified author") | only a verified author of the paper, or a trusted maintainer of its code for their own repository, its owner or a public member of its organization on GitHub, or made one by the owner; not a mere contributor (the Worker refuses, the Mac too: `edit.untrusted_maintainer`); applied by the Mac |
| a map's validation | the map's DOI on Zenodo (the sandbox by default), the validator's name and ORCID iD on the paper's page (real ORCID only) | only a verified author with an ORCID identity; the name is the paper's own list of authors', else the account's through `public_name` (no address, no link) |
| an author claim | the role that allows corrections, validations and removals applied at once | verified when the paper lists the ORCID iD, or when Crossref's automatic update put the paper in the claimant's ORCID record (never a work the claimant added, by hand or through a search wizard); else closed after 30 days |
| a maintainer claim | the maintainer role | GitHub checks it at once (the Worker, Phase 5); otherwise closed after 30 days. A contributor gets the role, but the rules trust only an owner or an organization member for what changes a record or removes at once |
| a removal request | hides: the record, copies (and their display from the source), the map | below |
| the badge | a static image, no input | n/a |
| an account's display name (from its provider) | only as a map's creator on Zenodo, when the paper does not list the validator | `public_name` |

**No free text a reader types reaches a public page**, so no language model is used (Workers AI or
other): the rules above suffice. Should a public free text ever be added, it would go through the
same kind of filter first, and hold the text when unsure.

### The rules

| request | rule (in the log) | what happens | written to D1 |
|---|---|---|---|
| removal, from a verified author of the paper (a `verified_author` role, or the account's ORCID iD among the paper's authors on the Mac: the Worker's `author_verified` flag alone is not trusted) | `report.verified_author` | applied at once, whatever it names | 1 row |
| removal of copies (a repository, a file, "the scripts") by a trusted maintainer of that code (owner or public organization member on GitHub, as the maintainer claim's `via` keeps it, or made one by the owner) | `report.maintainer` | applied at once, to the repositories they maintain; a contributor's request follows the rules for anyone | 1 |
| removal of copies for copyright or personal data, by anyone else | `report.hide_at_once` | hidden at once (`withheld`), the request accepted with words that say the operator may restore it. **Guards**: at most 3 an account and 30 in all per 24 hours; not when the same justification (case, accents and punctuation aside) came with 3 requests in 7 days; not when the owner refused or reversed this request before. A guard sends it to the review | 1 |
| any other removal (a whole record, a map, another reason, a guard) | `report.review` → `report.expired` | waits for the owner, nothing hidden; after 30 days, closed without removal (`rejected`), with how to ask again | 0, then 1 |
| the same, asked for personal data | `report.personal_data` | waits for the owner, nothing hidden, **never closed by the rules**: a request under the GDPR, which the owner answers within one month (`moderation.one_month_after`); the owner's list and `oscr jobs status` flag it with its deadline, and OVERDUE past it. A request recorded before this rule, found by the sweep, gets it instead of being closed | 0, then 1 |
| a submission published by a non-author (`moderation`) | `submission.corroborated` / `submission.review` → `submission.expired` | published when each link is proven the paper's by what the submitter cannot forge: the paper itself cites it (a `link` whose `found_by` is the text, `text:…`, or the publisher's Crossref metadata, `crossref:…`; or the source repository an archive the paper cites names, `zenodo:source`), or its owner is proven an author (an author's public ORCID record links to the GitHub account: `MacEvidence`; or an account that is a verified author of the paper and a trusted maintainer of the repository: `owner_role_proof`). **Not proof**, since the submitter can write them: a README citing the paper (`repository.cites_article`), a GitHub display name, a DataCite record declaring the paper (anyone can deposit one). Otherwise it waits for the owner (the submitter told why, in its row's message), and 30 days later is refused with how to ask again | 1, and 1 |
| a draft not published | `submission.draft_expired` | refused after 30 days; correcting it makes a new draft (and a new deadline) | 1 |
| an author claim | `claim.paper_metadata`, `claim.crossref_orcid`; else `claim.review` → `claim.expired` | verified when the paper lists the ORCID iD, or the ORCID record holds the paper as Crossref's automatic update added it (client `0000-0001-9884-1913`, on no one's behalf: `crossref_listed`), not a work the claimant added, nor one a search wizard added (Crossref Metadata Search, Scopus, Europe PMC: they carry an assertion origin); the role granted by `rules`, which the sign-in's sync never revokes; else checked again each day, and closed after 30 days (`rejected`, `decided_by = 'rules'`) | 2 (claim and role), or 1 |
| a maintainer claim GitHub did not settle | `claim.maintainer_review` → `claim.expired` | closed after 30 days with how to be checked again | 1 |
| a correction as a maintainer who is only a contributor (one recorded before the Worker refused it) | `edit.untrusted_maintainer` | refused, with why | 1 |

The site says what will happen: `src/lib/moderation.ts` holds the same base rules for a removal
(`reportPath`: both test suites read `tests/fixtures/moderation_rules.json`), and the Worker answers
`report.expected` = `{rule, outcome, words, deadline}` (the requester's roles read in one query, and the
verified maintainer claims when it holds a maintainer role, for how GitHub showed it), shown on the
receipt and the request's page; the guards are the Mac's alone. A submission's answer carries
`expected.words` too (`SUBMISSION_WORDS`: what proves a link, what does not). The fixture also holds
the submission cases (`submissionPath` / `submission_path`) and the maintainer cases
(`maintainerTrusted` / `trusted_maintainer`).

**What a requester could forge, and does not count** (reviewed 2026-09-29): a README citing the paper,
a GitHub display name, a DataCite record declaring the paper, a paper added to one's own ORCID record
(by hand or through a search wizard), being a contributor of a repository (one merged pull request).
None of them publishes, verifies or removes anything by itself. The harvester itself still keeps the
code a DataCite record declares for a paper (`datacite:…`, its discovery), as before: that is its
recall, not a reader's request, and the owner's to decide.

**Asking again.** A removal request refused (by the rules or the owner) may be asked again only in a
way the rules decide at once (as a verified author, as a maintainer of the named code, or for the
copies for copyright or personal data): the Worker reopens the same row (`reopenReport`: open, its
time now, so that its 30 days and the day's limit count from it; 2 rows). An author claim closed by the
rules (`decided_by = 'rules'`) is pending again when claimed again, its time now; a maintainer claim too
when checked again. What the owner decided stays decided.

**Where it runs.** On the Mac, in `oscr jobs poll`: each new request goes to the rules instead of the
owner's list; the requests the owner's list held before the rules go through them once; then `sweep`
closes what reached its deadline and checks the waiting author claims again (one D1 read of the rows by
id). The state is the job runner's (`data/community/state.db`): `moderation_log` (every automatic and
owner decision: when, which request, which rule, what, the details the guards need) and `waits`
(what waits, since when, until when, when to check again). The Worker decides nothing: it checks and
records as before, and tells the requester what the rules will do. **Retention**: each sweep deletes
the log's entries older than 12 months (`LOG_RETENTION_DAYS`) and the job runner's requests settled that
long ago, with their texts (`moderation.purge`); what still waits is kept, however old.

**The owner's commands.**

```sh
oscr reports list [--auto-log [--days N]]     # what waits for you, or what the rules decided (with each rule)
oscr reports accept|reject <n> [--message "…"] --remote   # decide what waits; `accept` also overrides a rule's closing
oscr reports reverse <n> [--message "…"] --remote         # undo what the rules applied: withheld copies or a withdrawn record come back
oscr claims list|accept|refuse|reverse <n> …    # `accept` a claim the rules closed; `reverse` one they verified (the role taken back)
oscr submissions list|accept|refuse|reverse <n> …   # `accept` one the rules refused; `reverse` one they published (its links leave)
oscr jobs status                                # includes the rules' decisions of the last 24 hours and what waits
```

**Budgets.** An automatic decision writes what an owner's decision writes (1 row; a verified claim 2),
within the facts push's day (`community_budget`); the sweep stops when fewer than 3 rows are left, like
the poll. The Worker writes as before (a request 3 rows; a reopening 2); the per-account daily limits
stay, and a reopened request counts in them. The lookups (`MacEvidence`: ORCID's public API, GitHub's
with the Mac's read-only token) cost a few requests per decision, cached a day; a failed lookup is
no evidence, never a failed job.

## Data rights (2026-09-29)

A signed-in person uses their rights under the GDPR on one page, `/data-rights/`, reached from `/privacy/`,
the account page and the removal page. It says what the registry may hold about them (their account,
their requests, the contact details kept privately when they are a paper's author, their name in the
published records), shows what the site's database holds about the account (`GET /api/rights`, with a
JSON copy made in the browser), and takes one right at a time, access, erasure, objection,
rectification, the account's deletion, with optional words (no email address: refused, and the Worker
strips any), one confirmation and a receipt that says what happens and by when. The Worker records it
(`rights`, migration 4: 3 rows with its job) with the account's own ORCID iD and which ORCID proved it,
never an iD the form names, and its legal deadline (`due_at`, one month: `src/lib/moderation.ts`
`oneMonthAfter`, the same as `moderation.one_month_after`, both tested on `tests/fixtures/one_month.json`).

The Mac answers it in `oscr jobs poll` (`oscr/rights.py`), in the safe direction:

| right | who asks | what happens | written |
|---|---|---|---|
| access | an account with an ORCID iD proved by orcid.org | answered at once (`rights.access`): the contact rows under that iD (and the rows without an iD that carry one of its addresses under the same family name), field by field, each address masked; the papers whose metadata list the iD; what the operator's computer keeps about the account (the log's entries, the requests' state, the corrections attributed to it). At most 80 rows listed, the answer at most 55,000 characters | 1 |
| access | an iD from ORCID's sandbox | the account's part only: the sandbox's iDs are tests, so no contact detail is shown to them | 1 |
| access | no ORCID iD (GitHub, Google) | the account's part at once; the contact details cannot be matched (a name, a login or a display name proves nothing): the request **waits for the owner**, flagged with its deadline | 1 |
| erasure, objection | an account with an ORCID iD (either ORCID) | `contacts.forget`: the rows are deleted (as above; another author's row that shares one of the addresses loses the address only); the iD and the SHA-256 of each address join `contact_suppressed` (Mac migration 9), which `contacts.write` honours when a paper is read again and `contacts.table` when the private dataset is built; that dataset's next publication rewrites its history (below). Erasure and objection have the same effect | 1 |
| erasure, objection | no ORCID iD | waits for the owner (`oscr rights erase <n> --row <paper>:<position>` for the rows found, or `--orcid`) | 1 |
| rectification | anyone | waits for the owner (`oscr rights done <n> --message "…"` once corrected by hand, or `refuse` with the reasons) | 1 |
| account | anyone | the account's rows deleted from D1, the account last (sessions, identities, roles, claims, submissions, edits, validations, reports, rights); on the Mac, its ORCID iD or GitHub login in `link_edit`, `field_provenance` and `version` replaced by `user:<its random id>`, the texts of its requests dropped from the job runner's state. What stays: the log (pseudonymous, 12 months), the `jobs` rows (a kind, a number, the random id, a time), what its requests changed in the public records, a validated map's DOI on Zenodo; D1's point-in-time recovery keeps 7 days of earlier states | its rows, about 2 each |
| any | an iD that is not the account's own ORCID identity | refused (`rights.identity`), with nothing answered | 1 |

**Never closed unanswered.** What waits for the owner is never put among the `waits` the sweep closes: it
stays `waiting`, in the owner's list (`oscr rights list`: the deadline, the days left, OVERDUE past it;
`oscr jobs status` counts them), until the owner answers (`done`, `refuse`, which adds the right to
complain to a data protection authority, `erase`). A request the Mac failed to answer after its five
attempts goes to the owner the same way (`rights.hand_over`), never refused. A removal request asked for
personal data that the rules cannot decide follows the same rule (`report.personal_data`).

**The email address, shown to its owner?** Decided: **masked** (`rights.mask_email`: `j…e at domain`).
The GDPR gives the person their own data, and CLAUDE.md's rule is about public display, but the only way
from the Mac to the person's page is the site's D1 database, which holds no email address anywhere (every
text column refuses an at sign), keeps 7 days of earlier states, and is Cloudflare's to host. The address
is the one the paper publishes: the answer names the paper and where it was read (its full text, its
Europe PMC record), where the person reads it in full. The same answer holds every other field in full.

**The private dataset.** A Hugging Face dataset is a git repository: every earlier `contacts.parquet`
stays in its history. So `contacts.publish`, when an erasure or an objection came since its last
publication (`contact_suppressed.published_at` empty), uploads the new file, then squashes the history
(`HfApi.super_squash_history`: the earlier commits cannot be retrieved), then deletes for good every
stored file that is not the current one (`list_lfs_files`, `permanently_delete_lfs_files`); it refuses to
delete anything when it cannot recognize the current file among them (the next publication tries again),
and only then marks the entries published. The other private dataset, `opsecsystems/oscr-catalog`, is the
public export (`catalog.public_db`, generated in public mode): it holds neither the contact rows nor the
suppression list (both dropped), so there is nothing to rewrite there.

## The tables (`migrations/d1-community/0002_contributions.sql`, `0003_removal_requests.sql`, `0004_data_rights.sql`)

Times are Unix seconds. No email address anywhere: the free texts lose theirs in the Worker
(`contributions/text.ts`) and the CHECKs refuse an at sign. The tables keyed by a number use their
rowid (no AUTOINCREMENT, which writes `sqlite_sequence` at every insert); **each index says the
query that needs it**, each one costs a row written per insert.

| table | what | index, and why |
|---|---|---|
| `submissions` | the DOI, 1–5 code links, a note, the Worker's checks, the status (`queued`, `draft`, `publishing`, `moderation`, `published`, `refused`), the revisions, the Mac's paper id, author flag, draft and words | `submissions_user_doi` UNIQUE (user, DOI): one submission per account and DOI; the account page's list; the daily limit |
| `jobs` | one row per request the Mac must see: kind, the request's id, who, when. Append-only | none: the Mac reads `WHERE id > <last seen>`, the rowid's order |
| `edits` | a correction: the paper, as author or maintainer (and the repository), 1–10 changes (JSON), a note, status (`queued`, `applied`, `refused`), the version made, the Mac's words | `edits_user` (user, created_at): the account page's list, a paper page's state, the daily limit (a range: only the last day is read) |
| `validations` | the paper, the ORCID iD, the proof (`orcid`, `orcid-sandbox`), the map's digest, status (`queued`, `deposited`, `map_changed`, `refused`, `failed`), the Zenodo instance, DOI and record | `validations_user` (user, created_at): the same three reads |
| `reports` | a removal request: the paper, the reason (`copyright`, `personal_data`, `not_my_work`, `retracted`, `incorrect`, `other`; `author_request` for a request made before migration 3), the justification (`details`), who asks (`requester_role`: `author`, `rights_holder`, `named_person`, `other`; '' before migration 3) and `author_verified`, the scope (`record`, `scripts`, `repository`, `file`, `map`) with `scope_repo` and `scope_path`, `evidence_url` (https only), `confirmed`, status (`open`, `accepted`, `rejected`), the owner's words, `updated_at` (completed while open) | `reports_user_target` UNIQUE (user, kind, paper): one request per account and record; the list; the limit. Migration 3 makes the table again (a CHECK cannot change in place), the rows copied as they are |
| `claims` (Phase 5) | + `message`: the owner's words on a decided claim | Phase 5's `claims_user_target` serves the author claims too |
| `rights` (migration 4) | a data-rights request: the right (`access`, `erasure`, `objection`, `rectification`, `account`), the person's words (`details`, no at sign), the ORCID iD of the account's ORCID identity and which ORCID proved it (`proof`: `orcid`, `orcid-sandbox`, ''), status (`open`, `waiting`, `done`, `refused`), the Mac's `answer` (JSON, at most 60,000 characters, no at sign), its words, `due_at` (the legal deadline: one month) | `rights_user` (user, created_at): the page's list, the one open request per right, the daily limit. Migration 4 also makes `jobs` again, so that it takes the kind `rights` (a CHECK cannot change in place), its rows and ids kept |
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
| `GET /api/rights` | anyone | 200 `{signed_in: false, available}`; or `{signed_in: true, user, handles, orcid: {orcid, proof}, held: {identities, sessions, roles, requests}, requests, limits, csrf}`: what the site's database holds about the account, and its data-rights requests with their answers (20, newest first) |
| `POST /api/rights` `{kind, details, confirm}` | signed in | 202 `{status: "open", request}` (with `expected`: what happens, by when); 400 `bad_kind`, `email_in_text`, `long_details`, `short_details` (a rectification says what), `not_confirmed` (each with `field`); 409 `already_open` (one open request per right, with it); 429 `too_many` (5 a day) |
| `POST /api/reports` `{paper_id, role, scope, repo, path, reason, details, evidence_url, confirm_accurate, confirm_review}` | signed in | 202 `{status: "open", report}`; 200 `{status: "open", updated: true, report}` (completed while open); 400 `bad_paper`, `bad_role`, `bad_scope`, `no_code` (a scope but the record on a paper without code), `unknown_repo`, `unknown_file`, `bad_file`, `bad_reason`, `email_in_text`, `short_details`, `long_details`, `bad_evidence`, `not_confirmed` (each with `field`, the form's field); 404 `unknown_paper` (no page); 409 `already_decided`; 429; 503 `unavailable` (the Worker without its assets) |

A removal request's `report` is `{id, paper_id, url, removal_url, role, author_verified, scope, repo,
path, reason, details, evidence_url, confirmed, status, message, created_at, updated_at, decided_at}`.
The Worker checks it all (`src/lib/removal.ts`, `checkRequest`, the page's own rules) against the
paper's facts, which it reads from the site's own files through its `ASSETS` binding, the top of the
static page (it stops reading once the facts are read: a few kilobytes), else the record rendered on
demand, free: no request counted, no D1 row.

A change is `{"op": "add", "url", "role": "code"|"data"}`, `{"op": "remove", "repo"}` or `{"op":
"role", "repo", "role": "code"|"data"|"tool"}`, a link named by the registry's key
(`github.com/owner/name`, `zenodo:123`, `doi:10.…`). Errors as the accounts': `{"error": {"code",
"message"}}`; `signed_out` (401), `bad_origin`, `bad_csrf` (403), `not_configured`, `quota`,
`unavailable` (503). A paper's id: `doi:<lowercase DOI>`, `pmcid:PMC…`; whether it has a page is the
Mac's to say.

**Daily limits per account** (24 hours, counted from the account's rows through the indexes above:
no counter, no write of their own): 10 submissions, 20 corrections, 10 validations, 10 removal
requests, 10 author claims (and 20 claims pending at once, Phase 5's), 5 data-rights requests (and one
open request per right).

**The hint cookie.** `__Host-oscr_signed_in=1` (no `HttpOnly`, readable by the pages; set, extended
and cleared with the session cookie; it grants nothing). A paper's page asks the Worker only when
it is there: **a signed-out reader's page view costs no Worker request.**

**The pages' headers** (`website/public/_headers`): `/submit/` and `/paper/:slug/` (one segment: the
Code ↔ Paper reader keeps its own rules) get the account page's `Content-Security-Policy`
(`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`…) and `X-Frame-Options: DENY`; a
paper's page also connects to Europe PMC and NCBI (the paper's text) and, since 2026-09-29, to the
places a file of the authors' code is shown from (`src/lib/source.ts`, SOURCE_ORIGINS:
docs/SCRIPT_STORAGE.md, "Shown from the source").
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
oscr rights list [--auto-log]          # the data-rights requests that wait for you, each with its legal deadline
oscr rights done|refuse <n> --message "…" --local|--remote        # your answer (a refusal says why)
oscr rights erase <n> --orcid <iD> | --row <paper>:<position> … --local|--remote   # the rows you found, then done
oscr contacts suppress-in --file <backup.db>   # the suppression list applied to a backup copy of the database
oscr community push --remote           # the facts, paper_repo included (nightly with OSCR_COMMUNITY_PUSH=remote)
```

- **Reaching D1** (`community.open_d1`): `--local`, the local D1 of `wrangler dev --env local`
  (`--persist-to` for another state folder); `--remote`, the REST API when `OSCR_D1_ACCOUNT_ID`,
  `OSCR_D1_COMMUNITY_ID` and the keychain's token (`org.oscr.cloudflare-d1`, or
  `CLOUDFLARE_D1_TOKEN`) are there, otherwise `wrangler d1 execute oscr_community --remote` under
  wrangler's own login, the same two paths as the search's push (`oscr/d1.py`).
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
| removal request (the page /removal/): new / completed while open (the requester's roles read once, 2026-09-29) | 3 / 2 | 9 / 11 |
| removal request asked again after a refusal (reopened; not measured, by construction) | 2 | n/a |
| data-rights request (the row, its index entry, the job; not measured, by construction) | 3 | n/a |
| the page `/data-rights/`, signed in (`GET /api/rights`; not measured) | 0 | n/a |
| the Mac's answer to a data-rights request / an account deleted | 1 / its rows and their index entries (about 2 per row) | n/a |
| publication of a draft (the row, the job) | 2 | 8 |
| revision of a draft (the row, the job; not measured, by construction) | 2 | n/a |
| the account page's lists (`GET /api/contributions`) | 0 | 7 |
| Phase 5's maintainer claim left pending (now with its job) | 3 (was 2) | 16 |
| the Mac's answer to a request / a claim accepted (claim and role) | 1 / 2 | n/a |

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
`/data-rights/` 0 signed out, 1 signed in (`/api/rights`) and 1 per request; each form 1.

**CPU** (10 ms a request): measured in V8 (Node) with the test database and the mocked places
included, a submission with five links 0.47 ms, a correction with ten changes 0.30 ms, a validation
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
- A data-rights request keeps no email address either: its answer masks every address (`j…e at
  domain`), and the D1 CHECKs refuse an at sign in it. After an erasure, the Mac keeps the ORCID iD and
  the SHA-256 of each address found with it (`contact_suppressed`), never the address.

## The owner's steps [owner]

Done on 2026-09-28 (Phase 6 is live): steps 1, 2 and 4 below. Step 5 is the owner's, whenever a
request comes. They stay here for a reinstallation:

1. **The database's new tables**: `sh tools/setup_cloudflare.sh` again (it applies the migrations of
   the three databases, `migrations/d1-community/0002_contributions.sql` included, and changes nothing
   else), before deploying the Worker with Phase 6.
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
7. **The data rights (2026-09-29)**: the database's migration 4, **before** deploying the Worker that
   serves `/api/rights`: `cd website && npx wrangler d1 migrations apply oscr_community --remote` (it
   makes `jobs` again with its rows and ids, and adds `rights`). The Mac's migration 9
   (`contact_suppressed`) applies itself when `oscr` next opens the database. Then, whenever the list
   waits for you: `oscr rights list`. The copies of the database made by hand before a migration
   (`data/backups/`) are not edited by an erasure: `oscr contacts suppress-in --file <copy>` applies the
   list to one, or delete the copies you no longer need.

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
  and comes back, is refused an email address, reviews, goes back, confirms; the Mac's poll applies it (a
  verified author's request: `report.verified_author`) and withholds the file's copy and only it; the page
  and the account page show the request accepted with the rules' words. `SCREENS=<folder>` saves the pages at 1280×860 and
  390×844.

## Limits and what comes next

- The one-click pull request of the badge is not built (see "The badge").
- Moderation is automatic (above, since 2026-09-29), with the owner's commands to decide, override and
  reverse; a moderation interface in the site comes with Phase 7. No global daily cap on the Worker's
  writes, no Turnstile yet.
- A correction changes links only (code, data, tools): the bibliographic record comes from the
  paper's own metadata.
- A draft's matches need the paper's full text (Europe PMC): without it, they come after
  publication, when the harvester aligns the paper.
- A record withdrawn, or a copy or a map withheld, by a removal request comes back when the owner
  reverses the request (`oscr reports reverse <n>`).
- A removal request is one per account and record: completed while it is open; once refused, asked
  again only in a way the rules decide at once (above); the owner may still act by hand. A request names at most one repository or one
  file; a file past the 5,000 listed per repository is named in the justification, with its repository.
- A copy already published on Hugging Face stays in its Parquet block (a published block never
  changes): the manifest that points to it is withdrawn, so no reader finds it. A tracing map deposited
  on Zenodo keeps its DOI there (a DOI is permanent); the site no longer shows it.
- The page reads a static paper's facts from its HTML: a paper page restructured without them fails
  `npm run check`.
- The README link uses `HEAD` (GitHub's default branch); the Mac does not record the branch's name.
