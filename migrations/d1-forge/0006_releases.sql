-- The forge database, part 6: releases (night phase 07). See docs/RELEASES.md and
-- docs/DECISIONS.md D07-*.
--
-- Releases and tags are GitHub's objects (D00-6): the registry reads them in the reader's browser and
-- writes them as the person, one authorized action each (website/worker/forge/service/act-releases.ts),
-- and keeps none of their text. What the registry keeps is its own layer over them:
-- - `release_papers`: a release tied to a version of a paper (a preprint, the submitted or accepted
--   manuscript, the version of record, a correction), with the commit its tag named and the digest of
--   the tracing map the person saw (oscr/zenodo.py `map_digest`). One row per (release, paper);
-- - `jobs` gains two kinds for the Mac (oscr/forgejobs.py): `release`, the paper's tracing map
--   versioned with the release (frozen for the tag's commit, its digest checked), and `deposit`, the
--   release's validated map deposited on Zenodo at its author's request (the sandbox unless the owner
--   switches; never the code: CLAUDE.md). A Software Heritage request for a release is an `archive`
--   job whose `ref` is the tag. A job about one paper names it (`paper_id`).
--
-- What each write costs: a release tied to a paper writes the tie (1 row) and its `release` job
-- (1), with the action row; a Software Heritage request or a deposit one job each. No index: a
-- repository's ties are read by the key's prefix (forge, repo_id); a paper's releases reach its page
-- through the Mac's static layer (oscr/forgelayer.py), not from here.
--
-- What it never holds: no release title or notes, no asset, no email address (a version's label is
-- checked for an at sign), no token.
--
-- Times are Unix seconds.

CREATE TABLE release_papers (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (length(repo_id) BETWEEN 1 AND 100),
    tag          TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 255),   -- the release's tag, as GitHub names it
    paper_id     TEXT NOT NULL                     -- "doi:10.…", lower case
                 CHECK (length(paper_id) BETWEEN 11 AND 210 AND substr(paper_id, 1, 7) = 'doi:10.' AND paper_id = lower(paper_id)),
    release_id   TEXT NOT NULL DEFAULT '' CHECK (release_id NOT GLOB '*[^0-9]*'),   -- GitHub's id of the release
    repo_path    TEXT NOT NULL DEFAULT ''          -- "owner/name", lower case, as the registry knew it
                 CHECK (length(repo_path) <= 201 AND repo_path = lower(repo_path)),
    version      TEXT NOT NULL CHECK (version IN ('preprint', 'submitted', 'accepted', 'published', 'correction')),
    label        TEXT NOT NULL DEFAULT ''          -- the person's words: "bioRxiv v2", "revision 1"
                 CHECK (length(label) <= 80 AND instr(label, '@') = 0),
    commit_sha   TEXT NOT NULL DEFAULT ''          -- the commit the tag named when tied ('' for a draft's new tag)
                 CHECK (commit_sha = '' OR (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*')),
    map_digest   TEXT NOT NULL DEFAULT ''          -- the tracing map the person saw; the Mac confirms it
                 CHECK (map_digest = '' OR (length(map_digest) = 64 AND map_digest NOT GLOB '*[^0-9a-f]*')),
    status       TEXT NOT NULL CHECK (status IN ('linked', 'proposed')),
    by_user      TEXT NOT NULL,                    -- oscr_community users.id: never answered, never exported
    at           INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, tag, paper_id)
) WITHOUT ROWID;

-- `jobs` rebuilt with the kinds `release` and `deposit`, and `paper_id`. The ids are kept (the Mac
-- reads the rows after the last one it saw, by the rowid).
CREATE TABLE jobs_next (
    id          INTEGER PRIMARY KEY,               -- the rowid: the order the Mac reads them in
    kind        TEXT NOT NULL CHECK (kind IN ('link', 'push', 'archive', 'delete_due', 'reconcile', 'release', 'deposit')),
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    ref         TEXT NOT NULL DEFAULT '',          -- a branch, a commit, a tag: what the job is about
    user_id     TEXT NOT NULL DEFAULT '',          -- who asked ('' for a webhook's job)
    created_at  INTEGER NOT NULL,
    not_before  INTEGER,                           -- delete_due: the end of the grace period
    done_at     INTEGER,                           -- written by the Mac; NULL while it waits
    outcome     TEXT NOT NULL DEFAULT '' CHECK (outcome IN ('', 'done', 'failed', 'skipped')),
    message     TEXT NOT NULL DEFAULT ''           -- the Mac's words for the person, plain text
                CHECK (length(message) <= 300 AND instr(message, '@') = 0),
    paper_id    TEXT NOT NULL DEFAULT ''           -- phase 07: the paper a `release` or `deposit` job is about
                CHECK (paper_id = '' OR (substr(paper_id, 1, 7) = 'doi:10.' AND paper_id = lower(paper_id) AND length(paper_id) <= 210)),
    CHECK (kind != 'delete_due' OR not_before IS NOT NULL),
    CHECK ((done_at IS NULL) = (outcome = '')),
    CHECK (kind NOT IN ('release', 'deposit') OR (ref != '' AND paper_id != ''))
);

INSERT INTO jobs_next (id, kind, forge, repo_id, ref, user_id, created_at, not_before, done_at, outcome, message)
    SELECT id, kind, forge, repo_id, ref, user_id, created_at, not_before, done_at, outcome, message FROM jobs;

DROP TABLE jobs;

ALTER TABLE jobs_next RENAME TO jobs;

-- `actions` rebuilt with the kinds of phase 07 (types.ts ACTION_KINDS, then RESEARCH_KINDS, in order:
-- a test compares the effective schema with them).
CREATE TABLE actions_next (
    day          INTEGER NOT NULL,                 -- at / 86400
    user_id      TEXT NOT NULL,                    -- oscr_community users.id
    at           INTEGER NOT NULL,
    nonce        TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 64),
    kind         TEXT NOT NULL CHECK (kind IN (
                     'create', 'generate', 'link', 'papers', 'rename', 'edit', 'topics', 'features',
                     'template', 'default_branch', 'archive', 'unarchive', 'transfer', 'branch_create',
                     'branch_rename', 'branch_delete', 'autolink_create', 'autolink_delete',
                     'delete_request', 'restore', 'delete_final', 'software_heritage', 'commit',
                     'fork', 'fork_sync', 'pull_open', 'pull_edit', 'pull_review', 'pull_comment',
                     'pull_thread', 'pull_merge', 'pull_update', 'pull_revert', 'issue_open',
                     'issue_edit', 'issue_comment', 'issue_react', 'issue_lock', 'issue_pin',
                     'issue_transfer', 'issue_relation', 'issue_branch', 'issue_labels',
                     'issue_milestone', 'research_copy', 'release_create', 'release_edit',
                     'release_delete', 'release_drafts', 'release_research', 'tag_create',
                     'tag_delete', 'asset_upload', 'asset_delete', 'research_open',
                     'research_comment', 'research_edit')),
    forge        TEXT NOT NULL DEFAULT '',
    repo_id      TEXT NOT NULL DEFAULT '',
    github_user  TEXT NOT NULL DEFAULT ''          -- the GitHub account that acted: its numeric id
                 CHECK (github_user NOT GLOB '*[^0-9]*'),
    outcome      TEXT NOT NULL CHECK (outcome IN ('done', 'pending', 'failed')),
    rows         INTEGER NOT NULL CHECK (rows BETWEEN 0 AND 1000),
    PRIMARY KEY (day, user_id, at, nonce),
    CHECK (day = CAST(at / 86400 AS INTEGER))
) WITHOUT ROWID;

INSERT INTO actions_next (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows)
    SELECT day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows FROM actions;

DROP TABLE actions;

ALTER TABLE actions_next RENAME TO actions;
