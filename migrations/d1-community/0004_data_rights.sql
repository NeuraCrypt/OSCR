-- The community database, part 4: data rights (the page /data-rights/, 2026-09-29). D1 database
-- `oscr_community`. See docs/CONTRIBUTIONS.md, "Data rights", and the page /privacy/.
--
-- A signed-in person asks one right of the EU's General Data Protection Regulation about what the
-- registry holds on them — their account, their requests, and, when they are a paper's author, the
-- contact details the registry keeps privately from the papers (oscr/contacts.py, on the Mac only):
--
-- - 'access': what the registry holds about me (GDPR art. 15);
-- - 'erasure': erase my contact details (art. 17);
-- - 'objection': stop collecting them (art. 21);
-- - 'rectification': correct them, said in a short text (art. 16);
-- - 'account': delete my account (art. 17).
--
-- The Worker checks and records (a row and its job); the Mac answers into the row (oscr/rights.py, in
-- `oscr jobs poll`). A request the Mac cannot answer by itself (rectification; contact details asked
-- by an account without an ORCID iD) waits for the operator ('waiting'), who must answer it within
-- one month (`due_at`, GDPR art. 12(3)): it is never closed unanswered. A deleted account takes its
-- requests with it (ON DELETE CASCADE).
--
-- What it never holds: no email address. `answer` (the access right's answer, written by the Mac)
-- masks the addresses it names; every text refuses an at sign, as the other tables do.
--
-- What it costs: one index (the account's list, its daily limit): a request writes 3 rows (the row,
-- its index entry, its job), an answer 1.
--
-- `jobs` is made again so that it takes the kind 'rights' (SQLite cannot change a CHECK in place): its
-- rows are copied as they are, their ids kept (the Mac reads `WHERE id > <last seen>`). Nothing
-- references `jobs`, and it has no index.
PRAGMA defer_foreign_keys = true;

CREATE TABLE jobs_new (
    id          INTEGER PRIMARY KEY,               -- the rowid: the order the Mac reads them in
    kind        TEXT NOT NULL CHECK (kind IN ('submission', 'publish', 'edit', 'validation', 'claim', 'report', 'rights')),
    ref         INTEGER NOT NULL,                  -- submissions.id, edits.id, validations.id, claims.id, reports.id, rights.id
    user_id     TEXT NOT NULL,                     -- who asked (no foreign key: a job is never deleted)
    created_at  INTEGER NOT NULL
);
INSERT INTO jobs_new (id, kind, ref, user_id, created_at) SELECT id, kind, ref, user_id, created_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE TABLE rights (
    id          INTEGER PRIMARY KEY,               -- the rowid: the request's number (no AUTOINCREMENT)
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('access', 'erasure', 'objection', 'rectification', 'account')),
    -- The person's words: optional, required for a rectification. Plain text, no email address.
    details     TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 1000 AND instr(details, '@') = 0),
    -- The ORCID iD of the account's ORCID identity when it asked ('' without one): the contact details
    -- concerned are the rows with this iD. `proof`: which ORCID signed it in — 'orcid' (orcid.org), or
    -- 'orcid-sandbox' (its sandbox, whose iDs are tests: the Mac shows no contact detail to them).
    orcid       TEXT NOT NULL DEFAULT ''
                CHECK (orcid = '' OR (length(orcid) = 19 AND substr(orcid, 5, 1) = '-' AND substr(orcid, 10, 1) = '-'
                       AND substr(orcid, 15, 1) = '-' AND replace(orcid, '-', '') NOT GLOB '*[^0-9X]*')),
    proof       TEXT NOT NULL DEFAULT '' CHECK (proof IN ('', 'orcid', 'orcid-sandbox')),
    -- open: sent, not answered yet; waiting: the operator answers it, by `due_at`; done: answered or
    -- applied; refused: the operator refused it, with the reasons in `message`.
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'done', 'refused')),
    -- The access right's answer (JSON, written by the Mac): what is held, field by field, addresses masked.
    answer      TEXT NOT NULL DEFAULT '{}'
                CHECK (json_valid(answer) AND length(answer) <= 60000 AND instr(answer, '@') = 0),
    message     TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    created_at  INTEGER NOT NULL,
    -- The legal deadline: one month after the request (GDPR art. 12(3)), computed by the Worker.
    due_at      INTEGER NOT NULL,
    decided_at  INTEGER
);
-- An account's requests, newest first: the page's list, the one open request per right, and the daily
-- limit (a range of the index). One more row written per request; none when the Mac answers it.
CREATE INDEX rights_user ON rights(user_id, created_at);
