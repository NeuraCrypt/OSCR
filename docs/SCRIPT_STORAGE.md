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

Everything else stays on the Mac, and the site links to the source at the verified commit:
- a license inferred from a README sentence;
- "other-open" without a license file;
- no license.

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
