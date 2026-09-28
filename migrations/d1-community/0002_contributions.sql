-- The community database, part 2: contributions (Phase 6). D1 database `oscr_community`, bound to
-- the Worker as COMMUNITY. See docs/CONTRIBUTIONS.md and docs/PLATFORM_PLAN.md §4, §9.
--
-- What a signed-in reader asks of the registry, and what the Mac answers:
-- - `submissions`: a paper (its DOI) and its code links, checked at once by the Worker, then
--   harvested by the Mac, which writes a draft back for the submitter to review and publish;
-- - `edits`: a correction of a record's links by a verified author of the paper or a maintainer
--   of its code, applied by the Mac as a new version of the record;
-- - `validations`: a verified author validates the paper's tracing map; the Mac deposits it on
--   Zenodo (the sandbox while the platform is built) and writes the DOI back;
-- - `reports`: a request to remove a record, decided by the owner (`oscr reports`);
-- - manual author claims go to Phase 5's `claims` (kind 'author'), decided by the owner
--   (`oscr claims`);
-- - `jobs`: one row per request the Mac must look at, in the order they came.
--
-- What it never holds: no email address (the free texts lose theirs in the Worker, and the
-- CHECKs refuse an at sign), no provider token, nothing of a paper's text.
--
-- What each write costs. D1's free plan writes 100,000 rows a day for the whole account; the
-- Worker's share is 10,000 (docs/CONTRIBUTIONS.md). An index adds one row written to every insert
-- that touches it, so each table has at most one, and each says which query needs it. The tables
-- keyed by a number use their rowid (`INTEGER PRIMARY KEY`, no AUTOINCREMENT: it writes to
-- sqlite_sequence on every insert). A new request writes its row, its index entry and its job:
-- 3 rows; a change of status writes 1.
--
-- The per-account daily limits are counted from these rows, through the index each table has
-- for the account page's list: no counter of their own, no write of their own.
--
-- Times are Unix seconds.

-- A paper submitted with its code: the DOI and one to five code links, as the Worker recognized
-- and checked them (`checks`: the DOI resolved, each link answered). The Mac harvests the DOI,
-- verifies the links (their license included) and writes `draft` back; the submitter reviews it,
-- corrects the links (`revisions`) and publishes it. Publication is immediate when the
-- submitter's ORCID iD is among the paper's authors (`author`, set by the Mac); otherwise the
-- owner decides (`moderation`).
CREATE TABLE submissions (
    id          INTEGER PRIMARY KEY,               -- the rowid
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doi         TEXT NOT NULL                      -- "10.1234/abcd", lower case
                CHECK (length(doi) BETWEEN 7 AND 200 AND substr(doi, 1, 3) = '10.' AND doi = lower(doi)),
    code_urls   TEXT NOT NULL                      -- JSON array of the links, as recognized (https://…)
                CHECK (json_valid(code_urls) AND json_type(code_urls) = 'array'
                       AND json_array_length(code_urls) BETWEEN 1 AND 5),
    note        TEXT NOT NULL DEFAULT ''           -- the submitter's words for the owner, plain text
                CHECK (length(note) <= 1000 AND instr(note, '@') = 0),
    checks      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checks)),
    status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'draft', 'publishing', 'moderation', 'published', 'refused')),
    revisions   INTEGER NOT NULL DEFAULT 0 CHECK (revisions BETWEEN 0 AND 10),
    paper_id    TEXT NOT NULL DEFAULT '',          -- the Mac's id of the paper, once harvested
    author      INTEGER NOT NULL DEFAULT 0 CHECK (author IN (0, 1)),
    draft       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(draft)),                 -- written by the Mac
    message     TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
-- One submission per account and DOI, the account page's list, and the daily limit (the
-- account's rows, read through the index). One more row written per submission; none when its
-- status or draft changes (neither column is in the index).
CREATE UNIQUE INDEX submissions_user_doi ON submissions(user_id, doi);

-- What the Mac must look at, in order: a submission to harvest or to publish, an edit to apply, a
-- map to deposit, a claim or a report for the owner. Append-only: the Mac reads the rows after the
-- last one it saw (`WHERE id > ?`, the rowid's own order: no index), keeps their state on its side
-- (data/community/state.db), and writes the outcome into the row the reader sees (`ref`). Rows are
-- never deleted, so an id is never given twice, and D1 commits one write at a time, so a job the
-- Mac has not seen never gets an id below one it has.
CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY,               -- the rowid: the order the Mac reads them in
    kind        TEXT NOT NULL CHECK (kind IN ('submission', 'publish', 'edit', 'validation', 'claim', 'report')),
    ref         INTEGER NOT NULL,                  -- submissions.id, edits.id, validations.id, claims.id, reports.id
    user_id     TEXT NOT NULL,                     -- who asked (no foreign key: a job is never deleted)
    created_at  INTEGER NOT NULL
);

-- A correction of a record, proposed by a verified author of the paper or a maintainer of one of
-- its code repositories: well-defined changes of its links, never free-form markup. `changes` is a
-- JSON array of {"op": "add", "url", "role": "code"|"data"}, {"op": "remove", "repo"},
-- {"op": "role", "repo", "role": "code"|"data"|"tool"}. The Mac applies it with its provenance
-- (the person's ORCID iD or GitHub login) as a new version of the record (`version`).
CREATE TABLE edits (
    id          INTEGER PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paper_id    TEXT NOT NULL CHECK (length(paper_id) BETWEEN 5 AND 250),
    as_role     TEXT NOT NULL CHECK (as_role IN ('verified_author', 'maintainer')),
    repo        TEXT NOT NULL DEFAULT '',          -- as a maintainer: the repository they maintain
    changes     TEXT NOT NULL
                CHECK (json_valid(changes) AND json_type(changes) = 'array'
                       AND json_array_length(changes) BETWEEN 1 AND 10),
    note        TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500 AND instr(note, '@') = 0),
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'applied', 'refused')),
    version     INTEGER,                           -- the record's version the edit made
    message     TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    CHECK ((as_role = 'maintainer') = (repo != ''))
);
-- An account's edits, newest first: the account page's list, a paper page's state, and the daily
-- limit (a range of the index: only the last day's entries are read). One more row written per
-- edit.
CREATE INDEX edits_user ON edits(user_id, created_at);

-- A tracing map validated by a verified author of its paper, with the ORCID iD of their linked
-- identity (oscr/zenodo.py). `proof` says which ORCID signed them in: 'orcid' (orcid.org), or
-- 'orcid-sandbox' (sandbox.orcid.org, while the platform is built: the Mac records such a
-- validation as a test, which only the Zenodo sandbox accepts and no public output shows).
-- `map_digest` is the SHA-256 of the map the page showed them (zenodo.map_digest): the Mac
-- deposits that map, and only that one (`map_changed` otherwise). `instance`: the Zenodo the Mac
-- deposited on, the sandbox while the platform is built.
CREATE TABLE validations (
    id          INTEGER PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    paper_id    TEXT NOT NULL CHECK (length(paper_id) BETWEEN 5 AND 250),
    orcid       TEXT NOT NULL                      -- the shape is checked piece by piece (D1: GLOB ≤ 50 bytes)
                CHECK (length(orcid) = 19 AND substr(orcid, 5, 1) = '-' AND substr(orcid, 10, 1) = '-'
                       AND substr(orcid, 15, 1) = '-' AND replace(orcid, '-', '') NOT GLOB '*[^0-9X]*'),
    proof       TEXT NOT NULL CHECK (proof IN ('orcid', 'orcid-sandbox')),
    map_digest  TEXT NOT NULL CHECK (length(map_digest) = 64 AND map_digest NOT GLOB '*[^0-9a-f]*'),
    status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'deposited', 'map_changed', 'refused', 'failed')),
    instance    TEXT NOT NULL DEFAULT '' CHECK (instance IN ('', 'sandbox', 'zenodo')),
    doi         TEXT NOT NULL DEFAULT '',
    record_url  TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER
);
-- An account's validations, newest first: the account page, a paper page's state, and the daily
-- limit. One more row written per validation.
CREATE INDEX validations_user ON validations(user_id, created_at);

-- A request to remove a record from the site, decided by the owner (`oscr reports`; moderation
-- in the site comes with Phase 7). Sign-in is required until Turnstile (Phase 7).
CREATE TABLE reports (
    id           INTEGER PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_kind  TEXT NOT NULL CHECK (target_kind IN ('paper')),
    target_id    TEXT NOT NULL CHECK (length(target_id) BETWEEN 5 AND 250),
    reason       TEXT NOT NULL
                 CHECK (reason IN ('author_request', 'copyright', 'personal_data', 'incorrect', 'other')),
    details      TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000 AND instr(details, '@') = 0),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
    message      TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    created_at   INTEGER NOT NULL,
    decided_at   INTEGER
);
-- One request per account and record (asking again while it is open updates it), the account
-- page's list, a paper page's state, and the daily limit. One more row written per request.
CREATE UNIQUE INDEX reports_user_target ON reports(user_id, target_kind, target_id);

-- The owner's words on a claim they decided (Phase 5's table; author claims by hand are Phase 6's).
ALTER TABLE claims ADD COLUMN message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0);

-- A fact pushed by the Mac (oscr/community.py), never written by the Worker: the code
-- repositories of each paper with a page, on the forges whose addresses name an owner (the ones
-- `repo_owner` holds). A maintainer of the repository may correct the paper's record. Read by
-- its whole key: no index.
CREATE TABLE paper_repo (
    repo      TEXT NOT NULL,                       -- "github.com/owner/name", as in repo_owner
    paper_id  TEXT NOT NULL,                       -- "doi:10.…"
    PRIMARY KEY (repo, paper_id)
) WITHOUT ROWID;

-- No index on roles(scope_kind, scope_id), "the verified authors of a paper": every query of this
-- phase reads a person's own roles, by the key's prefix.
