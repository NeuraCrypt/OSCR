-- Cloudflare D1 database `oscr_catalog` (binding CATALOG): what a search result shows, for the
-- papers that have a page (the owner's decision D2) and are on topic (D7). A projection of the
-- Mac's database, pushed as deltas by `oscr d1 push` (oscr/d1.py); the Mac stays the source of
-- truth. Applied with `wrangler d1 migrations apply oscr_catalog` (docs/SEARCH.md).
--
-- No FTS5 table here: a D1 database that holds one cannot be exported. The full-text index,
-- the filters and the sorts live in `oscr_search` (migrations/d1/search/).
--
-- Every index costs one more row written for each row written (D1's free plan: 100,000 rows
-- written a day, indexes included), so `papers` has a single secondary index, explained below.

CREATE TABLE papers (
    -- The key, shared with oscr_search.paper_fts (its rowid): YYYYMMDD × 100,000 + n, from the
    -- publication date (a partial date counts as its first day: 2026-09 → 20260900), n
    -- numbering the papers of that day. "Newest first" is the key's order, and a date range
    -- is a key range, with no index.
    pid             INTEGER PRIMARY KEY,
    id              TEXT NOT NULL,          -- the Mac's id: doi:… or pmcid:…
    slug            TEXT NOT NULL,          -- the paper's page: /paper/<slug>/
    doi             TEXT NOT NULL,
    title           TEXT NOT NULL,
    journal         TEXT NOT NULL,
    journal_id      TEXT NOT NULL,          -- issn:… or title:…, as the Mac names journals
    published       TEXT NOT NULL,          -- ISO date, possibly partial: 2026-09-21, 2026-09, 2026
    year            INTEGER,
    type            TEXT NOT NULL,          -- JATS article type: research-article, review-article…
    status          TEXT NOT NULL,          -- code_verified, code_found, code_empty, code_dead, on_request, data_only
    oa              INTEGER,                -- open access: 1, 0, or NULL when unknown
    license         TEXT NOT NULL,          -- the paper's license family: CC BY, CC BY-NC… ('' unknown)
    cited_by_count  INTEGER,
    has_alignment   INTEGER NOT NULL,       -- 1 when Code ↔ Paper matches were computed
    languages       TEXT NOT NULL,          -- JSON array: the languages of the authors' code
    hosts           TEXT NOT NULL,          -- JSON array: where the code is (github.com, zenodo.org…)
    doc             TEXT NOT NULL           -- JSON: what a result row shows. Never an abstract, never an address.
);

-- "Most cited" with no query and no filter reads 20 index entries instead of every paper.
-- Every other filter and sort runs in oscr_search: filters are tokens of the full-text index,
-- relevance is its rank, dates are its rowid order. No other index is needed here.
CREATE INDEX papers_cited ON papers (cited_by_count DESC, pid DESC);

-- The facet counts of the unfiltered view (an empty query), exact over the whole catalogue:
-- for each facet, its values with the most papers, `rank` 1 being the largest.
CREATE TABLE facet_counts (
    facet   TEXT NOT NULL,              -- the search parameter: status, year, modality, tool…
    rank    INTEGER NOT NULL,
    value   TEXT NOT NULL,
    papers  INTEGER NOT NULL,
    PRIMARY KEY (facet, rank)
) WITHOUT ROWID;

-- `papers`: how many rows `papers` holds; `updated_at`: the last push (ISO 8601, UTC).
CREATE TABLE meta (
    name   TEXT PRIMARY KEY,
    value  TEXT NOT NULL
) WITHOUT ROWID;
