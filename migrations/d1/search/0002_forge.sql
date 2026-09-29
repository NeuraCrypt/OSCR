-- Cloudflare D1 database `oscr_search`, part 2: the GitHub side's search (night phase 08). See
-- docs/SOCIAL.md "Search" and docs/DECISIONS.md D08-*.
--
-- ONE full-text index for the registry's own objects besides the papers: the repositories it knows
-- (the forge layer's public entries: a repository hidden, private, waiting for deletion or deleted is
-- never in it), the research issues, the people whose profile is public, the topics. Pushed by the Mac
-- from the night's PUBLIC static files (oscr/social.py `search_docs`, `push_search`): nothing reaches
-- this index that the static site does not already show. Read by /api/search?type=… (website/worker/
-- forge-search.ts); papers stay in paper_fts (0001).
--
-- - Contentless (content=''), rows replaced or deleted without their old values
--   (contentless_delete=1), the UNINDEXED `fx` stored (contentless_unindexed=1): the JSON a result
--   shows (its words and its address), already public.
-- - `kind`: the filters as tokens — "zzk" + the type (repository, issue, person, topic), "zzkall" in
--   every row, "zzs" + a research issue's state, "zzt" + its type; a filter is a MATCH on this
--   column, as paper_fts's facets.
-- - Ranking: bm25 over title, text, ids (the kind and fx weigh nothing).
CREATE VIRTUAL TABLE forge_fts USING fts5(
    title, text, ids, kind,
    fx UNINDEXED,
    content = '', contentless_delete = 1, contentless_unindexed = 1,
    tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO forge_fts (forge_fts, rank) VALUES ('rank', 'bm25(10.0, 2.0, 8.0, 0.0, 0.0)');
