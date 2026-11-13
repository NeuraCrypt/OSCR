-- The operator's correction (2026-11-13, `oscr links add`): a record's links corrected at an
-- author's request made outside the site (an email). Its source is 'operator'; the page says
-- "editor", never who. SQLite cannot change a CHECK in place: the table is rebuilt, its rows kept.
CREATE TABLE link_edit_new (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    repo        TEXT NOT NULL,                 -- the link's key: github.com/o/r, zenodo:123, doi:10.…
    op          TEXT NOT NULL CHECK (op IN ('add', 'remove', 'role')),
    url         TEXT NOT NULL DEFAULT '',      -- op 'add'
    host        TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',      -- ops 'add', 'role': code | data | third_party_tool
    source      TEXT NOT NULL CHECK (source IN ('author', 'maintainer', 'submitter', 'operator')),
    actor       TEXT NOT NULL,                 -- orcid:0000-…, github:<login>, or operator
    ref         TEXT NOT NULL DEFAULT '',      -- the request: edit:12, submission:3, or the operator's note
    created_at  REAL NOT NULL,
    PRIMARY KEY (article_id, repo)
);
INSERT INTO link_edit_new SELECT article_id, repo, op, url, host, kind, role, source, actor, ref, created_at FROM link_edit;
DROP TABLE link_edit;
ALTER TABLE link_edit_new RENAME TO link_edit;
