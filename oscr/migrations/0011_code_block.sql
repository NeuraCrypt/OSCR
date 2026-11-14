-- Block identifiers (2026-11-13, docs/PLAN_BLOCK_IDS.md, oscr/blocks.py): one row per identifier the
-- registry ever gave to a block of code linked to a paper, never deleted. An identifier is computed
-- from the paper's DOI, the Software Heritage identifier (SWHID) of the file's content and the lines,
-- so the same block always gets the same one; the matches (`alignment`) are renumbered at every
-- computation, so their numbers are never cited. `status`: 'current' (the block is among the
-- matches now), 'superseded' (no longer: `superseded_by` names the block that replaced it, if any),
-- 'withdrawn' (its paper left the registry, or a removal request withheld its map or its file).
-- `paragraphs`: JSON [[paragraph, section], ...], the paragraphs of the paper the block was matched
-- to (one block may serve several).
CREATE TABLE IF NOT EXISTS code_block (
    id             TEXT PRIMARY KEY,
    article_id     TEXT NOT NULL,
    doi            TEXT NOT NULL,
    repo           TEXT NOT NULL,
    commit_id      TEXT NOT NULL DEFAULT '',
    path           TEXT NOT NULL,
    swhid          TEXT NOT NULL,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    symbol         TEXT NOT NULL DEFAULT '',
    paragraphs     TEXT NOT NULL DEFAULT '[]',
    method         TEXT NOT NULL,
    origin         TEXT NOT NULL DEFAULT 'machine' CHECK (origin IN ('machine', 'author')),
    status         TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded', 'withdrawn')),
    superseded_by  TEXT,
    first_seen     REAL NOT NULL,
    last_seen      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS i_code_block_article ON code_block(article_id);
