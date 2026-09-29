-- The community database, part 3: the removal request made whole (the page /removal/, 2026-09-29).
-- D1 database `oscr_community`. See docs/CONTRIBUTIONS.md, "Request a removal".
--
-- A request now says who asks (an author of the paper, verified or not; the holder of the rights; a
-- person named in the record; someone else), what to remove (the whole record; only the copies of
-- the authors' scripts; one repository's copies; one file; the tracing map), why (copyright or
-- license, personal data, wrongly attributed or not the requester's work, a retracted paper, an
-- incorrect record, another reason), a justification of 30 to 2,000 characters, an optional https
-- link to evidence, and the requester's two confirmations (the information is accurate; a moderator
-- reviews every request). The Worker checks all of it (worker/contributions/index.ts, with the rules
-- of src/lib/removal.ts); the CHECKs below are the database's own guard.
--
-- The table is made again: SQLite cannot change a CHECK in place, and `reason` takes two new values.
-- The rows are copied as they are: a request made before this migration keeps its reason (among
-- them 'author_request', which the Worker no longer takes), is about the whole record (`scope`
-- 'record', what it asked), and says neither who asked (`requester_role` '') nor any confirmation
-- (`confirmed` 0). Its id stays: `jobs.ref` names it.
--
-- What it costs stays the same: one index (the account's list, a paper page's state, one request per
-- account and record, the daily limit), so a new request writes 3 rows (the row, its index entry,
-- its job) and a request completed while it is open 2 (the row, the job).
--
-- The rename of a table in D1 keeps foreign keys checked at the end of the migration, not at each
-- statement: nothing references `reports` (a job names it without a foreign key), and `reports`
-- references `users`, whose rows do not change.
PRAGMA defer_foreign_keys = true;

CREATE TABLE reports_new (
    id               INTEGER PRIMARY KEY,           -- the rowid: the request's number, kept
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_kind      TEXT NOT NULL CHECK (target_kind IN ('paper')),
    target_id        TEXT NOT NULL CHECK (length(target_id) BETWEEN 5 AND 250),
    -- Why. 'author_request' is a request made before this migration only.
    reason           TEXT NOT NULL
                     CHECK (reason IN ('copyright', 'personal_data', 'not_my_work', 'retracted', 'incorrect', 'other',
                                       'author_request')),
    -- The justification: plain text, no email address (the Worker refuses one, the CHECK an at sign).
    details          TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000 AND instr(details, '@') = 0),
    -- Who asks: '' for a request made before this migration.
    requester_role   TEXT NOT NULL DEFAULT ''
                     CHECK (requester_role IN ('', 'author', 'rights_holder', 'named_person', 'other')),
    -- 1 when the account was a verified author of the paper when it asked (its ORCID iD among the
    -- paper's authors, Phase 5's `roles`), which only an author's request can be.
    author_verified  INTEGER NOT NULL DEFAULT 0 CHECK (author_verified IN (0, 1)),
    -- What to remove, and which repository (github.com/owner/name, zenodo:123…) or file.
    scope            TEXT NOT NULL DEFAULT 'record'
                     CHECK (scope IN ('record', 'scripts', 'repository', 'file', 'map')),
    scope_repo       TEXT NOT NULL DEFAULT '' CHECK (length(scope_repo) <= 250),
    scope_path       TEXT NOT NULL DEFAULT '' CHECK (length(scope_path) <= 1000),
    -- A web page that supports the request: https only, never an address with an at sign.
    evidence_url     TEXT NOT NULL DEFAULT ''
                     CHECK (evidence_url = '' OR (length(evidence_url) <= 300 AND substr(evidence_url, 1, 8) = 'https://'
                                                  AND instr(evidence_url, '@') = 0)),
    -- 1: the requester confirmed that the information is accurate and that a moderator reviews it.
    confirmed        INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
    message          TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    created_at       INTEGER NOT NULL,
    -- When the requester last completed it while it was open (NULL: never).
    updated_at       INTEGER,
    decided_at       INTEGER,
    CHECK (author_verified = 0 OR requester_role = 'author'),
    CHECK (CASE scope
             WHEN 'repository' THEN scope_repo != '' AND scope_path = ''
             WHEN 'file' THEN scope_repo != '' AND scope_path != ''
             ELSE scope_repo = '' AND scope_path = ''
           END)
);

INSERT INTO reports_new (id, user_id, target_kind, target_id, reason, details, status, message, created_at, decided_at)
    SELECT id, user_id, target_kind, target_id, reason, details, status, message, created_at, decided_at FROM reports;

DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;

-- One request per account and record (asking again while it is open completes it), the account
-- page's list, a paper page's state, and the daily limit. One more row written per request.
CREATE UNIQUE INDEX reports_user_target ON reports(user_id, target_kind, target_id);
