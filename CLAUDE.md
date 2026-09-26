# Open Scientific Code Registry (OSCR): the project's rules

## The owner's rules

- **Zero cost.** If a feature does not fit the free tiers, flag it and propose an
  alternative instead of building it.
- **No secret in the code**: tokens go in the macOS keychain or in Cloudflare secrets.
- **No email address or other non-public personal data is displayed.**
- **Nothing is deployed without the owner's approval.** One commit per phase, on a
  dedicated branch.
- **Style: `science.css` only.** A component that needs a new style gets a proposed
  addition to `science.css`, and waits for approval.
- **The platform's name lives in one configuration variable, `SITE_NAME`**; never hard-code
  it.

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

## Script copies (decided 2026-09-26)

OSCR keeps copies of the authors' scripts, stored this way (measurements and projection:
`docs/SCRIPT_STORAGE.md`):

1. **Deduplication** by content digest (SHA-256): each unique file is stored once.
2. **zstd compression.**
3. **Parquet blocks**: one row per unique file (digest, compressed content, size, language),
   split into blocks; plus an **index table in D1** (repository, commit, path → digest,
   block, position).
4. The blocks go to a **public Hugging Face dataset**, added incrementally (new blocks only;
   a published block never changes). The script reader reads the row it needs in the
   browser, with HTTP range requests (hyparquet).

- **Only files whose license allows redistribution** go to the public dataset. The others
  stay on the Mac, with their metadata (not their text) in D1; the site links to the source
  at the verified commit.
- Layout: zstd level 19 page compression, 64 rows per row group, 64 KiB pages, rows sorted
  by language then size, blocks of 25–50 MB (a script view downloads ~78 KB).
- The D1 index is pushed within the free write budget: the Mac queues it and sends at most
  ~50,000 rows a day.

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
- No commit without being asked.
