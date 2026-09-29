-- A removal request accepted for less than a whole record (the page /removal/, `oscr reports accept`,
-- oscr/jobs.py; docs/CONTRIBUTIONS.md "Request a removal"): what leaves every public output, while
-- the record stays. One row per thing withheld:
--
-- - 'scripts': the copies of the paper's code, every repository linked to it as its code (those
--   linked later included);
-- - 'repository': the copies of one repository (`repo`), whichever paper links to it;
-- - 'file': the copy of one file (`repo`, `path`);
-- - 'map': the paper's tracing map: its Map section and its digest, its matches between paragraphs
--   and code, its validations and its Zenodo DOI, on the site and in the open data.
--
-- A copy withheld is a text that no longer leaves the Mac: the site's lots of scripts, the public
-- database, the Hugging Face scripts dataset (catalog.script_lots, catalog.public_db,
-- scriptstore.build). The file keeps its path and its link to the source at the verified commit,
-- like a file whose license does not allow republishing it. A whole record withdrawn is still
-- `article.withdrawn` (0006).
--
-- On the Mac only: catalog.public_db drops the table (the request's number and reason are the
-- owner's; who asked is in D1, never here).
CREATE TABLE IF NOT EXISTS withheld (
    scope       TEXT NOT NULL CHECK (scope IN ('scripts', 'repository', 'file', 'map')),
    article_id  TEXT NOT NULL,                 -- the paper the request named
    repo        TEXT NOT NULL DEFAULT '',      -- 'repository', 'file': github.com/owner/name, zenodo:123…
    path        TEXT NOT NULL DEFAULT '',      -- 'file': its path in the repository
    request     TEXT NOT NULL DEFAULT '',      -- the request on the site: "remote:12" (D1 target, reports.id)
    reason      TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    PRIMARY KEY (scope, article_id, repo, path),
    CHECK (CASE scope
             WHEN 'repository' THEN repo != '' AND path = ''
             WHEN 'file' THEN repo != '' AND path != ''
             ELSE repo = '' AND path = ''
           END)
) WITHOUT ROWID;
