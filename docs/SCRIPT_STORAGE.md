# Script storage

Decided by the owner on 2026-09-26; measured the same day on the private database
(17,095 files with text, 459 repositories, 327 papers with the authors' code).

## The decision

OSCR keeps copies of the authors' scripts:

1. **Deduplication** by content digest (SHA-256). Each unique file is stored once.
2. **zstd compression.**
3. **Parquet blocks.** One row per unique file: digest, compressed content, size, language.
   Blocks are split by size. An **index table in D1** maps
   (repository, commit, path) → (digest, block, position).
4. **A public Hugging Face dataset** holds the blocks, added incrementally: new blocks only,
   and a published block never changes. The script reader reads the row it needs **in the
   browser**, with HTTP range requests (hyparquet).

Only files whose license allows redistribution go to the public dataset. The others stay on
the Mac. Their metadata goes to D1, but not their text, and the site links to the source at
the verified commit.

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
| D1 index: 52 rows | 17,095 rows | 2.2 M rows (1.6–2.9 M) |

## The free tiers

**Hugging Face.** Public storage is free ("best-effort"). The documentation asks for
responsible use "beyond the first few gigabytes". A public dataset of ~2.3 GB, growing by
~0.4 GB a year (~6,000 new papers with code), stays within that.
- Recommended limits: under 100k files per repository and under 10k per folder. Blocks of
  25–50 MB give fewer than 150 files.
- Daily commits of new blocks are fine; the history can be squashed if it grows.

**D1.**
- **Storage.** Stored WITHOUT ROWID, one row per (repository, commit, path) with integer keys
  takes ~70 bytes, so ~150 MB at full scale. That fits in a D1 database of its own (500 MB
  per database, 10 databases).
- **Writes.** One write per row: no secondary index, and upserts with `ON CONFLICT DO UPDATE`.
- ⚠️ **The daily write limit (100,000 rows) does not keep up with the start of the backfill.**
  - The backfill reads ~18,000 papers a day. In 2025–2026 that is up to ~2,000 papers with
    code, so ~100,000 index rows a day: the whole D1 budget.
  - **Proposal:** the Mac queues the index rows and pushes at most ~50,000 a day. The script
    reader then lags behind the catalogue during the first weeks of the backfill.
  - The backlog, 2.2 M rows at 50,000 a day, clears in ~45 days, about the length of the
    backfill.
  - Afterwards, ~150 new papers with code a day means ~8,000 rows a day.
- **Fallback if the budget gets tight:** one D1 row per repository and commit, holding the
  file manifest as compressed JSON. That is ~60,000 rows in all instead of 2.2 M. The cost
  is that searching file paths in SQL is lost.
- **Reads:** one primary-key lookup per script view.

**The uplink.** Measured on 2026-09-26: the first Cloudflare deployment sent 143 MB in 159 s,
~0.9 MB/s. A task at launchd's background priority is throttled by macOS: the nightly Hugging
Face upload measured ~25 KB/s.
- During the backfill: ~100 MB of new blocks a day, ~70 MB of them public. That is 1–2
  minutes of upload at normal priority, or ~45 minutes at background priority.
- Afterwards: a few MB a day.

**The browser.**
- hyparquet with a zstd decoder (fzstd) adds 62 KB minified (21 KB gzipped), on the reader
  page only.
- A script view costs one D1 lookup, which is one Worker request, plus one or two range
  requests to Hugging Face. The block's footer is fetched once and then comes from the
  browser cache.

## Reproduce

The scripts are in the session scratchpad and will move to `tools/` with the
implementation:
- `measure.py` computes the size figures (Python, `zstandard`, `pyarrow`);
- `readcost.mjs` computes the read figures (Node, hyparquet).
