-- Phase 6: what the site's readers change in the Mac's records (oscr/jobs.py, docs/CONTRIBUTIONS.md).

-- A record removed from the site at someone's request, once the owner accepted it
-- (`oscr reports accept`): when and why. The paper stays on the Mac, known to the harvester, but
-- out of every public output, like an off-topic paper (catalog.IN_SCOPE).
ALTER TABLE article ADD COLUMN withdrawn TEXT NOT NULL DEFAULT '';

-- The corrections of a record's links by a person: a verified author of the paper, a maintainer
-- of its code, or its submitter (edits and submissions of the site). One per paper and link, the
-- latest wins. `db.replace_links` applies them after every scan: a person's correction outlives
-- the harvester's next reading of the paper. Private (who changed what): catalog.public_db drops
-- the table; the public pages say only "a correction by a verified author".
CREATE TABLE IF NOT EXISTS link_edit (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    repo        TEXT NOT NULL,                 -- the link's key: github.com/o/r, zenodo:123, doi:10.…
    op          TEXT NOT NULL CHECK (op IN ('add', 'remove', 'role')),
    url         TEXT NOT NULL DEFAULT '',      -- op 'add'
    host        TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',      -- ops 'add', 'role': code | data | third_party_tool
    source      TEXT NOT NULL CHECK (source IN ('author', 'maintainer', 'submitter')),
    actor       TEXT NOT NULL,                 -- orcid:0000-… or github:<login>
    ref         TEXT NOT NULL DEFAULT '',      -- the request on the site: edit:12, submission:3
    created_at  REAL NOT NULL,
    PRIMARY KEY (article_id, repo)
);
