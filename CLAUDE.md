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
- **Nothing is deployed without the owner's approval.** One commit per phase, on a
  dedicated branch.
- **Style: `science.css` only.** A component that needs a new style gets a proposed
  addition to `science.css`, and waits for approval.
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

## Accounts (Phase 5: built on its branch, not deployed)

Sign-in with ORCID, GitHub and Google in the Worker's code (`website/worker/account/`, D1
database `oscr_community`, `docs/ACCOUNTS.md`):

- **No email address is asked for, read or stored**: ORCID and Google `openid` only, GitHub no
  scope; notifications stay in the site (D5).
- A provider's token is used during the sign-in's callback only, **never stored**; D1 keeps a
  session's SHA-256, never its id.
- Client ids and secrets and the server key (`SESSION_KEY`) are **Cloudflare secrets**, or
  `website/.dev.vars` locally (gitignored).
- **ORCID sandbox** until the owner sets `ORCID_ISSUER=https://orcid.org`.
- The facts the verifications read (`paper_orcid`, `repo_owner`) come from the Mac
  (`oscr community`); the Worker never writes them.

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
- **Do not modify `science.css` without asking first.** A style need that it does not cover
  is reported; it is not worked around.
- The markup follows the classes of `science.css`:
  - the masthead (`.masthead`, with the site's name and its search) and the breadcrumb
    (`.breadcrumb`);
  - the catalogue: one `h2.day` per publication day, then a `dl.listing`.
    - `dt`: `.num`, the identifier, the links.
    - `dd`: `.title`, then `.line` rows with a `.label`: "Journal", "Authors' code",
      "Status".
  - the page of a paper: `.record`, with its `.body` and the `.sidebar` on the right.
  - a status is said in words (`.ok`, `.warning`), never with a pill.
  - a highlighted term: `mark` or `.highlight`.
  - the Code ↔ Paper reader: `.compare` holds two `.pane` (the paper, the code), each with
    a `header` and its content; the code's lines are an `ol.lines`, one `li` per line; a
    paragraph and the lines that match it share one class of `.pair-1` to `.pair-6`; the
    selected pair is marked `.is-active` on both sides.

## Already in force

- Neither the PDF nor the text of a paper leaves. Only the DOI link is published. The
  sentences that decided a link's verdict stay in the private database.
- A file whose license does not allow redistribution is never published: its text stays
  on the Mac (see "Script copies").
- No mass email to the authors: they come to us.
- The Hugging Face dataset `opsecsystems/oscr-catalog` stays **private** until decided
  otherwise.
- The tokens (Hugging Face, Zenodo) never go into the repository nor into the settings.
  They stay at their standard location or in the macOS keychain (`org.oscr.zenodo-sandbox`,
  `org.oscr.zenodo`).
- Commits: one per phase, on a dedicated branch; no other commit without being asked.
