# Script storage

Decided by the owner on 2026-09-26; measured the same day on the private database
(17,095 files with text, 459 repositories, 327 papers with the authors' code).

## The decision

Decided by the owner on 2026-09-26; the index was settled on 2026-09-27.

1. **Deduplication** by content digest (SHA-256 of the text). Each unique file is stored
   once.
2. **zstd compression**: Parquet page compression, level 19.
3. **Parquet blocks** (`blocks/NNNNN.parquet`). One row per unique file: `sha256`,
   `language`, `size`, `lines`, `content`.
   - 64 rows per row group and 64 KiB pages; rows sorted by language, then size.
   - ~30 MB per block.
   - **A published block never changes**: new files go into new blocks.
4. **No index in D1.**
   - The positions (block, row) are written into the static pages at build time.
   - **One manifest per repository** (`manifests/<xx>/<repository>.json`) serves the pages
     rendered on demand. It holds the commit, the license and how it was confirmed, and for
     each file its path, digest, block and row.
5. **The Hugging Face dataset `OpenScientificCodeRegistry/Database`** holds the blocks and
   manifests, added incrementally (`oscr scripts publish`, then every night). The script
   reader reads the row it needs **in the browser**, with HTTP range requests (hyparquet).

**Only verified licenses leave the Mac** (`oscr/scriptstore.py`). A file is published when
its repository's license allows redistribution **and** is confirmed:
- for a git repository, by its root license file;
- for an archive (Zenodo, figshare…), by a license file of the archive, or else by the
  license of its record.

The license published is the one that file or record names.

Everything else stays on the Mac, and the site shows it from its source (below) or links to it
there, at the verified commit:
- a license inferred from a README sentence;
- "other-open" without a license file;
- no license.

Since 2026-09-29 the site's lots of scripts and the public database apply the same audited filter
(`catalog.copyable`, which calls `scriptstore.verified_license`). Until then they took the recorded
license alone: on the production database of 2026-09-29, 67 repositories and 7,761 files were
copied to the site without a verified license (34 MIT and 16 CC BY on forges without a recognized
license file, 5 CC BY archives, 5 "other-open" archives, a few more). They are now held back like
the others, and shown from their source.

## Shown from the source (decided 2026-09-29)

The owner wants the scripts without a redistributable license displayed too, **without any copy**.
A reader's browser fetches such a file itself, from where its authors published it, at the version
the registry verified, checks it, and shows it in the registry's own reader, with its colors, line
numbers, tree and matches with the paper. The registry keeps and publishes no copy: no text in the
site's lots, in the public database, or in the Hugging Face dataset. The public page
`/policies/code/` explains it to readers and authors.

**Only facts leave the Mac** (`catalog.script_lots`): for each readable file of a held-back
repository, its path, language, kind, lines, `size` and `sha256` (the file's `digest` column: the
SHA-256 of its **bytes**, computed when it was read — for a notebook too, whose text the Mac keeps by
cells), and for the repository `source` = `{via, url, at}` from `catalog.source_of`: where a browser
fetches a file (a template with `{path}`, `{file}` or `{sha256}`), and the pinned version (a commit,
a Zenodo record). The tracing maps' line numbers were public already.

| host | the browser fetches | pinned by |
|---|---|---|
| github.com | `raw.githubusercontent.com/<owner>/<name>/<commit>/<path>` | commit |
| gitlab.com | its API, `…/repository/files/<path>/raw?ref=<commit>` | commit |
| bitbucket.org | `bitbucket.org/<owner>/<name>/raw/<commit>/<path>` | commit |
| codeberg.org | its API, `…/raw/<path>?ref=<commit>` | commit |
| huggingface.co | `huggingface.co/<repo, its case kept>/raw/<commit>/<path>` | commit |
| zenodo.org | `zenodo.org/api/records/<id>/files/<file>/content`, a file of the record itself | the record (a published record's files never change) |
| any other forge (a GitLab of its own, Framagit, GIN…), a file inside a Zenodo archive | Software Heritage, `archive.softwareheritage.org/api/1/content/sha256:<digest>/raw/` | the digest itself |
| OSF, PMC's supplementary files | nothing: their answers carry no `Access-Control-Allow-Origin` | — |

Checked read-only on 2026-09-29 with `curl -sI -H "Origin: https://oscr.yannbellec-b.workers.dev"`:
every host above answers a simple GET with `Access-Control-Allow-Origin` (`*`, or the site's origin
for Hugging Face and figshare's downloads); GitHub refuses a preflight (a `Range` header), so the
browser sends none; the self-hosted GitLabs tried (Inria, Framagit) answer too, but each would need
its own line in the Content-Security-Policy, so they go through Software Heritage. OSF's API and
files and PMC's bucket send no CORS header. A repository the Mac's last check found dead is not
fetched (not even from Software Heritage: the authors withdrew it).

**In the browser** (`website/src/lib/source.ts`, used by `src/scripts/reader.ts`):
1. the address is filled from the template and must name one of `SOURCE_ORIGINS` over https,
   without credentials, with no `..` in the path; the paper page's `connect-src` lists exactly those
   origins (`public/_headers`, `worker/pages.ts`; a test holds the three together);
2. a simple GET: no cookie (`credentials: "omit"`), no header of its own, no referrer (the page's
   `Referrer-Policy: same-origin`), 20 seconds, at most **1 MB** (the `size` fact first, then
   `Content-Length`, then the bytes as they arrive);
3. the SHA-256 of the bytes (`crypto.subtle`) must be the `sha256` fact, else nothing is shown and no
   pair is drawn;
4. a binary file (a `.mlx`, a NUL byte in the first 8,000) is refused, as `contents.read` does;
5. the bytes are decoded as `contents.decode` does (UTF-8 without its byte-order mark, else
   Windows-1252, else Latin-1), a notebook turned into cells as `contents.notebook_to_text` does, and
   the email addresses masked by `maskEmails`, a port of `catalog.mask_emails` (Python's `\w` as
   Unicode's letters and numbers, its final `\b` as a lookahead); the cases of
   `tests/fixtures/mask_emails.json` are the Python version's, and both test suites read them;
6. the file is shown, with a notice in the pane's header: "Shown from GitHub at commit abc1234,
   where its authors published it. OSCR keeps no copy: this repository has no license that allows
   redistribution. Rights remain with its authors. How this works · Request its removal".

A digest that differs, an HTTP error, no answer, a file too large or not text: the reader says which,
in words, lists the file's matches as links to the lines at the source, and draws none. The "Raw"
button opens the file at its source; nothing is downloaded from the registry.

**Removals still win.** A repository or a file withheld at a removal request (`catalog.withheld`) gets
no `sha256` and no `source`: it is neither offered nor fetched, and the reader says it was withheld.
A record withdrawn leaves every output, its facts included.

**Both renderers.** The static paper pages hold the Code ↔ Paper reader, which does all this. The
reduced page of an older paper (rendered by the Worker) has no reader, for copies or not: it says,
per repository, whether copies are kept, withheld, or not kept for its license (with a link to
`/policies/code/`), and links to the source, as before.

**The file budget** does not move: the facts ride in the existing `scripts/NN.json` lots (about 90
bytes per file) and in each static page's reader data; no file per repository is added
(`npm run check -- --every-route` and `npm run check:growth`: 112 → 2,673 files, unchanged).

**The licence audit.** The copy filter is unchanged: showing from the source copies nothing, so no new
audit is needed (`tests/test_scriptstore.py`, the audit's own tests, and
`tests/test_catalog_source.py::test_the_copy_filter_is_the_audited_one` pass). What changed on
2026-09-29 is that the site's lots and the public database now apply that same audited filter.

### What becomes viewable (production database, 2026-09-29, read-only)

Files of the authors' code that the Mac read as text, in repositories linked to papers in scope,
held back from copies (not verified for redistribution), by host and by how the browser gets them.
The copies (a verified license) are 2,120 repositories and 129,038 files.

| host | repositories | files | how |
|---|---|---|---|
| github.com | 1,452 | 76,991 | GitHub, at the commit |
| github.com | 161 | 444 | not fetched: over 1 MB (mostly notebooks with their outputs) |
| osf.io | 345 | 4,126 | not fetched: OSF sends no CORS header |
| framagit.org | 1 | 2,000 | Software Heritage |
| zenodo.org | 17 | 792 | Software Heritage (files inside the record's archive) |
| zenodo.org | 4 | 5 | Zenodo, the record's own files |
| zenodo.org | 4 | 5 | not fetched: over 1 MB |
| bitbucket.org | 5 | 312 | Bitbucket, at the commit |
| 15 self-hosted GitLabs (Bremen, ESRF, Inria, ETH, ICFO, Graz, Bochum, IIT…) | 25 | 646 | Software Heritage (13 more files over 1 MB not fetched) |
| supplementary (PMC) | 28 | 184 | not fetched: PMC's bucket sends no CORS header |
| gitlab.com | 6 | 64 | GitLab, at the commit (1 file over 1 MB) |
| codeberg.org | 1 | 36 | Codeberg, at the commit |
| huggingface.co | 9 (+1) | 28 (+1) | Hugging Face, at the commit (1 through Software Heritage) |

In all: **77,436 files** fetched from their own host at the pinned version, **3,439** through
Software Heritage — found there for 9 of 20 repositories sampled at random (2026-09-29), so roughly
half of those will show and the others will say "no longer serves it" —, and **4,773** not fetched
(4,126 on OSF, 184 of PMC, 463 over 1 MB), which the reader links to at their source.

## The license audit (2026-09-27)

`oscr scripts audit` reports what would leave and why the rest stays.

**First, a detection bug.** Before the audit, license detection took the first signature
of its list that matched anywhere in the text. A license names others in passing: section
13 of the GPL-3.0 names the GNU Affero GPL, and the GPLs name the Lesser GPL. The fix:
the license whose signature comes first in the text wins. The database was then relabelled
from the stored license files:

| recorded | corrected | repositories |
|---|---|---|
| AGPL-3.0 | GPL-3.0 | 35 |
| LGPL-2.1 | GPL-2.0 | 3 |
| other | MIT | 3 |
| other | GPL-3.0 | 1 |

**Result.**
- **Published: 285 repositories, 13,832 files.** Their licenses:
  - MIT: 135 repositories;
  - GPL-3.0: 41;
  - CC BY 4.0: 48 (6 by a license file, 42 by the record);
  - Apache-2.0: 19;
  - BSD-3-Clause: 13;
  - CC0: 7;
  - GPL-2.0: 5;
  - BSD-2-Clause, AGPL-3.0, LGPL-3.0, CC BY-SA: a few each;
  - CC BY-NC(-SA/-ND): 6, for non-commercial reuse only, as the dataset card says.
- **Held on the Mac: 231 repositories, 6,137 files:**
  - no license: 205;
  - a license file not recognized as open: 5;
  - a license known only from a README sentence: 16;
  - "other-open" without a license file: 2;
  - other unconfirmed labels: 3.
- **Seven repositories are published under a license other than the one recorded**, the
  one their own license file names. For example, Zenodo archives recorded as CC BY 4.0 hold
  code with an MIT license file.

**First build** (2026-09-27): 1 block of **12,203 unique files (19.8 MB, 191 row groups)**
and 286 manifests, 23 MB in all.

## What deduplication and compression save

| stage | files | size | vs raw |
|---|---|---|---|
| raw text (UTF-8) | 17,095 | 154.7 MB | 1× |
| deduplicated | 14,990 | 131.0 MB | −15% |
| zstd 3, each file alone | 14,990 | 36.4 MB | 4.2× smaller |
| zstd 19, each file alone | 14,990 | 32.9 MB | 4.7× |
| zstd 19 + trained dictionary (110 KB), each file alone | 14,990 | 28.4 MB | 5.4× |
| **Parquet, zstd 19 page compression, 64 rows per row group** | 14,990 | **25.6 MB** | **6.0×** |
| Parquet, zstd 19, 1,024 rows per row group | 14,990 | 21.7 MB | 7.1× |
| one zstd 19 stream of everything (lower bound, no random access) | 14,990 | 19.7 MB | 7.9× |

**Deduplication.** 1,337 unique files appear in several repositories. The largest savings
come from:
- the same `LICENSE` text in 26 repositories;
- jQuery shipped in 5 repositories;
- the NIfTI toolbox (`view_nii.m`) copied into 3 repositories;
- one repository with 7 copies of the same C++ file.

The share of duplicates grows with the corpus, since the same toolboxes are copied again and
again. The projection below keeps today's rate, so it errs on the high side.

**Compression.** Compressing each file alone takes 29% more space than Parquet's page
compression with 64-row groups, which compresses neighbouring files together. Rows are sorted by language, then by size, so
similar files sit side by side.

## What a reader downloads to show one script

Measured with hyparquet 1.31.1 and hyparquet-compressors 1.1.2. Every read below is an
HTTP range request.

| row group | total size | first read of a block (footer) | **per script shown** |
|---|---|---|---|
| 32 rows | 27.0 MB | 148 KB | 38 KB |
| **64 rows** | **25.6 MB** | **77 KB** | **78 KB** |
| 128 rows | 24.4 MB | ≤ 64 KB | 146 KB |
| 256 rows | 23.4 MB | ≤ 64 KB | 316 KB |
| 1,024 rows | 21.7 MB | ≤ 64 KB | 1.19 MB |
| 4,096 rows | 21.7 MB | ≤ 64 KB | 3.9 MB |

hyparquet reads the whole content column of the row group that holds the requested row, so
the row group size sets the cost of a view.

**Chosen layout:**
- zstd level 19 page compression;
- **64 rows per row group** and 64 KiB pages;
- blocks of about 25–50 MB, so that a block's footer stays under ~150 KB;
- rows sorted by language, then by size.

The layout costs 18% more storage than large row groups, and a script view downloads 78 KB
instead of 1.2 MB.

**Checked on Hugging Face (2026-09-26).** A dataset file answers range requests (206) with
`Access-Control-Allow-Origin` at each redirect and on the final response. A browser page on
another site can therefore read it directly.

## Projection for the whole neuro stock

The stock is ~42,000 papers with the authors' code (range 30–55k; see `PLATFORM_PLAN.md` §2).

| per paper with code (measured) | today (327 papers) | full stock: 42k (30–55k) papers |
|---|---|---|
| raw text: 473 KB | 155 MB | 19.9 GB (14–26) |
| **stored (dedup + Parquet zstd 19, 64-row groups): 78 KB** | **25.6 MB** | **3.3 GB (2.3–4.3)** |
| public share (licenses that allow redistribution: 70% of the bytes) | 17.9 MB | **2.3 GB (1.6–3.0)** |
| manifests: one per repository | 286 | ~40–60k |

## The free tiers

**Hugging Face.** Public storage is free ("best-effort"). The documentation asks for
responsible use "beyond the first few gigabytes". A public dataset of ~2.3 GB, growing by
~0.4 GB a year (~6,000 new papers with code), stays within that.
- Recommended limits: under 100k files per repository and under 10k per folder. Blocks of
  25–50 MB give fewer than 150 files.
- Daily commits of new blocks are fine; the history can be squashed if it grows.

**D1.** Not used for the scripts (decision of 2026-09-27). The (block, row) positions go
into the static pages at build time; the pages rendered on demand read the repository's
manifest from Hugging Face. So the 100,000-writes-a-day budget, which the backfill would
have filled, is not touched.

**The uplink.** Measured on 2026-09-26: the first Cloudflare deployment sent 143 MB in 159 s,
~0.9 MB/s. A task at launchd's background priority is throttled by macOS: the nightly Hugging
Face upload measured ~25 KB/s.
- During the backfill: ~100 MB of new blocks a day, ~70 MB of them public. That is 1–2
  minutes of upload at normal priority, or ~45 minutes at background priority.
- Afterwards: a few MB a day.

**The browser.**
- hyparquet with a zstd decoder (fzstd) adds 62 KB minified (21 KB gzipped), on the reader
  page only.
- A script view costs no Worker request: one or two range requests to Hugging Face (the
  position comes with the page, or from the repository's manifest). The block's footer is
  fetched once and then comes from the browser cache.

## Reproduce

The scripts are in the session scratchpad and will move to `tools/` with the
implementation:
- `measure.py` computes the size figures (Python, `zstandard`, `pyarrow`);
- `readcost.mjs` computes the read figures (Node, hyparquet).
