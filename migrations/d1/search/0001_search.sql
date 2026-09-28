-- Cloudflare D1 database `oscr_search` (binding SEARCH): the full-text index of the papers of
-- oscr_catalog.papers, one row each, under the same key (rowid = pid). A database of its own,
-- because a D1 database that holds an FTS5 table cannot be exported. Pushed by `oscr d1 push`
-- (oscr/d1.py); read by the Worker's /api/search (website/worker/).
--
-- - Contentless (content=''): the text is indexed, not stored. An abstract is indexed only
--   when the paper's license is CC BY, CC0, CC BY-SA or CC BY-NC (decision D1's rule), and a
--   search never returns abstract text nor a snippet of it.
-- - contentless_delete=1: a row is replaced or deleted without its old values.
-- - contentless_unindexed=1: the UNINDEXED column `fx` is stored, so it can be read back.
--
-- The columns:
-- - title … abstract: the text a query searches;
-- - facets: the filters, as tokens: "zz" + a 2-letter facet code + the first 12 hexadecimal
--   characters of the SHA-1 of the normalized value (oscr/d1.py, website/src/lib/facets.ts),
--   plus "zzall" in every row. A filter is a MATCH on this column: no index table, no row
--   written per filter value, and D1 reads only the matching rows;
-- - fx: JSON [cited_by_count, code, value, code, value…], the facet values the Worker counts
--   over a window of results.
--
-- Ranking: bm25, weighted per column, in the order of the columns above. The title and the
-- identifiers weigh most, the abstract least, the filter tokens and fx nothing. A query sorts
-- with `ORDER BY rank`, which uses these weights (and costs D1 only the rows returned).
CREATE VIRTUAL TABLE paper_fts USING fts5(
    title, keywords, mesh, authors, journal, repos, tools, ids, abstract,
    facets,
    fx UNINDEXED,
    content = '', contentless_delete = 1, contentless_unindexed = 1,
    tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO paper_fts (paper_fts, rank) VALUES ('rank', 'bm25(10.0, 5.0, 4.0, 3.0, 2.0, 3.0, 3.0, 8.0, 1.0, 0.0, 0.0)');
