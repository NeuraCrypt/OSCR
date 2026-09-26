# Architecture, at $0

The rules that govern everything below are in [CLAUDE.md](../CLAUDE.md):
- Zenodo DOIs only for tracing maps validated by one of the paper's authors;
- no paid service.

## The pieces

| Piece | Where it runs | What it does | Cost |
|---|---|---|---|
| **The harvester** (`oscr watch`) | the Mac Studio, continuously | reads the papers, finds and verifies the code, keeps the scripts' text in the private database (SQLite, WAL) | $0 |
| **The alignment** (`oscr align`) | the Mac; the harvester also runs it once a day for the papers still without pairs | pairs the paper's paragraphs with lines of the authors' code (method `lexical-v1`) and stores the pairs in the `alignment` table | $0 |
| **The local dashboard** (`oscr dashboard`) | the Mac, http://127.0.0.1:8790 | the table of the private database, for the owner only, read-only | $0 |
| **The public catalogue** (`oscr nightly`) | the Mac, at 04:17 | `data/public/` in public mode, then the Hugging Face dataset, then the website | $0 |
| **The website** (`website/`, Astro) | Cloudflare Pages | the public site, built from the public catalogue, with the Code ↔ Paper reader | $0 |
| **The map DOIs** (`oscr zenodo`) | Zenodo (CERN) | a map validated by an author receives a DOI in the community | $0 |

```mermaid
flowchart LR
  EPMC["Europe PMC, Crossref, DataCite, forges"] --> W["watch, on the Mac"]
  W --> B[("private SQLite database")]
  B <--> A["align: lexical-v1"]
  B --> I["local dashboard, port 8790"]
  B --> N["nightly: public catalogue"]
  N --> HF["Hugging Face, private dataset"]
  N --> P["website: Astro on Cloudflare Pages"]
  P -. "planned: the author's ORCID validation" .-> B
  B --> Z["Zenodo: DOI of the validated map"]
  Z --> P
```

The database is in WAL mode: the harvester writes while the dashboard and the nightly job
read, and none of them blocks the others. What leaves the Mac (`oscr_public.db`) is put back
into a single file, with no excerpt of any paper.

## The Code ↔ Paper reader

A page of the website puts a paper and its authors' code side by side.

- **Left, the paper.** Its full text is fetched from Europe PMC (open access, CORS allowed)
  by the reader's browser, never by the site, and shown as plain text. The site never stores
  or serves the text of a paper.
- **Right, the code.** One view is prerendered at build time; the others are fetched on
  demand from the lot of their repository (`/scripts/NN.json`). A script whose license does
  not allow republication is not copied: the reader lists the file and links to it at the
  source, at the verified commit.
- **The pairs** come from `alignments/NN.json`, read at build time. A pair joins paragraph
  number *i* (the index of a `<p>` among all the `<p>` of the JATS `<body>`, in document
  order, which the browser computes the same way) and a line range of one file: the same
  color on both sides. Clicking one side brings the other into view. The build keeps only the
  known fields of a pair and drops any evidence term longer than 60 characters, so no
  sentence of a paper can reach the site.

The website's name is not written in its pages: it comes from `SITE_NAME` (default `OSCR`)
and `SITE_TAGLINE`, set in `website/src/config.ts` or at build time.

## The tracing map

The map (`tracing-map.json`, see `oscr/zenodo.py`) says, for a paper:
- where its code is: repository, commit, license;
- what was found there: the path and digest of each file;
- how it was found;
- which paragraphs match which lines (`alignments`).

It contains neither the text of the paper nor the code.

Its life:
1. **Proposed** by the harvester. It is visible on the website, without a DOI.
2. **Validated** by an author, signed in with their ORCID. The map kept is the one the
   author saw, or corrected.
3. **Deposited** on Zenodo, in the community (`oscr zenodo deposit`). It receives a DOI.
   - Relations: `IsSupplementTo` the paper, `References` the code repository, at the
     validated commit.
   - Creators: the author (ORCID) and the platform.
4. **Corrected** later: a new version, under the same concept DOI.

## What remains to build, in order

1. ~~Deploy the website~~: done on 2026-09-26, https://oscr-2lj.pages.dev, rebuilt every night.
2. **Author validation.** ORCID offers sign-in for free (public API, `/authenticate`
   scope). A Pages Function receives the validation and writes it to D1. The Mac picks it
   up, then deposits the map on Zenodo.
3. **Search**, designed in the platform plan (below).
4. ~~A first paper ↔ code alignment~~: `lexical-v1`, computed on the Mac. Next: GROBID for
   the text, tree-sitter for the code, a local model on the Mac.

## The free limits that matter

Checked on 2026-09-26 in Cloudflare's documentation; the full table, with sources, is in
[PLATFORM_PLAN.md](PLATFORM_PLAN.md) (§2 and Appendix A).

| Service | Limit | Consequence |
|---|---|---|
| Pages | 20,000 files per deployment; 25 MiB per file; 500 builds per month; static requests free and unlimited | one static page per paper holds up to ~15,000 papers with code. Beyond that: pages grouped, or rendered on demand |
| Pages Functions (Workers) | 100,000 requests per day for all dynamic routes, cached or not; 10 ms of CPU per request; 64 MiB per Worker | kept for actions: sign-in, validation, search, API |
| D1 | 500 MB per database, 10 databases; 5 M rows read and 100,000 written per day | the catalogue projection, the script index and the community, pushed as deltas |
| Hugging Face | public datasets free ("best-effort"); byte ranges with CORS | the open data, and the script blocks |
| Zenodo | 50 GB per record; 60 requests per minute without a token | a map weighs a few KB |

**The scripts' text.** Today, 32 lots in `public/scripts/`. Decided on 2026-09-26
([SCRIPT_STORAGE.md](SCRIPT_STORAGE.md)): deduplicated, zstd, Parquet blocks on a public
Hugging Face dataset, read by the reader in the browser with range requests (~78 KB per
script), with an index in D1. Measured: 155 MB of text become 25.6 MB; ~3.3 GB at the full
neuro stock, of which ~2.3 GB are public.

## Planned platform

The platform extension (a normalized D1 catalogue, accounts, search and a community) is
specified in [PLATFORM_PLAN.md](PLATFORM_PLAN.md). Nothing in it is built yet: it awaits the
owner's validation, and each phase will follow the rules of [CLAUDE.md](../CLAUDE.md).

### Search engine

Proposed: **SQLite FTS5 in D1**, not Pagefind. Details and figures are in
[PLATFORM_PLAN.md](PLATFORM_PLAN.md) §7.

**Why not Pagefind.** Pagefind writes one fragment file per indexed record, plus index
chunks, filter files and a start-up file that lists every record.
- A searchable catalogue of 50–90k papers needs ~50–90k files. The limit is 20,000 files per
  Pages deployment, which Pagefind reaches at ~15k records.
- Pagefind has no incremental index, so every rebuild re-uploads most chunks over a home
  uplink (~0.9 MB/s, and ~25 KB/s for a background task).
- Its maintainer calls ~180k pages "probably around the ceiling".
- Everything indexed can be downloaded by anyone.

**Why FTS5.**
- **No files.** Daily updates are small row upserts from the Mac.
- **Full query syntax:** boolean operators, phrases and column filters, with `bm25()` weights
  per column.
- **Indexed sort columns.**
- **Facets:** counts are precomputed nightly for the unfiltered views and exact on filtered
  queries.

It lives in a D1 database of its own, because a D1 database that contains FTS5 tables
cannot be exported.

**The cost to watch.** Every search is a Worker request, even when cached, out of 100,000 a
day for the whole site, plus D1 rows read (5 M a day; how FTS5 lookups count is not
documented, so it will be measured). If that budget gets tight, the fallback costs no
request: a static inverted index published as Parquet blocks on Hugging Face and read by byte
ranges, like the scripts.
