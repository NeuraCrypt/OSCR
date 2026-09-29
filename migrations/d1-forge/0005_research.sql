-- The forge database, part 5: research issues (night phase 05). See docs/ISSUES.md and
-- docs/DECISIONS.md D05-*.
--
-- The registry's own issues (D00-6): "code error", "code–paper mismatch" (one tracing-map link: the
-- paper's paragraph and the lines at a commit) and "reproduction failure" (its reproduction report:
-- the outcome, the environment, the commit, the data, the command, what was expected and what was
-- seen). They belong to a paper (its DOI) and to its code: a GitHub repository the registry knows
-- as that paper's code, or the code's address elsewhere (Zenodo, OSF…). Ordinary issues stay on
-- GitHub (act-issues.ts); a research issue is copied there as an ordinary issue only when its
-- author asks, one at a time (`github_number`).
--
-- What each write costs (website/worker/forge/service/research.ts): a new issue writes its row, its
-- index entry and the action row (3 rows); a comment its row (the comments' key holds the issue:
-- no index), the issue's count and the action row (3); a change of the issue its row and the action
-- row (2). The action rows count the per-account caps and the day's 5,000 (gate.ts), as every
-- authorized action does: `actions` is rebuilt with the research kinds.
--
-- What it never holds: no email address (the Worker masks every text before it is stored), no
-- token, nothing of a paper's text (a paragraph is its number; the reader shows the text, under
-- the paper's licence).
--
-- Times are Unix seconds.

CREATE TABLE research_issues (
    id             INTEGER PRIMARY KEY,           -- the rowid: "research#<id>", one numbering for the registry
    paper_id       TEXT NOT NULL                  -- "doi:10.…", lower case
                   CHECK (length(paper_id) BETWEEN 11 AND 210 AND substr(paper_id, 1, 7) = 'doi:10.' AND paper_id = lower(paper_id)),
    forge          TEXT NOT NULL DEFAULT '' CHECK (forge IN ('', 'github', 'memory')),
    repo_id        TEXT NOT NULL DEFAULT '' CHECK (repo_id NOT GLOB '*[^0-9]*'),
    repo_path      TEXT NOT NULL DEFAULT ''       -- "owner/name", lower case, as the registry knew it
                   CHECK (length(repo_path) <= 201 AND repo_path = lower(repo_path)),
    code_url       TEXT NOT NULL DEFAULT ''       -- code hosted elsewhere: a place the registry recognizes
                   CHECK (length(code_url) <= 300 AND (code_url = '' OR substr(code_url, 1, 8) = 'https://')),
    type           TEXT NOT NULL CHECK (type IN ('code_error', 'mismatch', 'reproduction')),
    title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
    body           TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 65536),
    -- Where in the code, and where in the paper (a mismatch names both: its tracing-map link).
    commit_sha     TEXT NOT NULL DEFAULT ''
                   CHECK (commit_sha = '' OR (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*')),
    path           TEXT NOT NULL DEFAULT '' CHECK (length(path) <= 500),
    start_line     INTEGER CHECK (start_line IS NULL OR start_line >= 1),
    end_line       INTEGER CHECK (end_line IS NULL OR end_line >= start_line),
    paragraph      INTEGER CHECK (paragraph IS NULL OR paragraph >= 1),
    section        TEXT NOT NULL DEFAULT '' CHECK (length(section) <= 200),
    -- A reproduction failure's report: {outcome, environment, datasets, command, expected, observed,
    -- figure}, the texts masked (research.ts `readReport`).
    report         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(report) AND json_type(report) = 'object' AND length(report) <= 16384),
    labels         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND json_type(labels) = 'array' AND json_array_length(labels) <= 10),
    state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    close_reason   TEXT NOT NULL DEFAULT '' CHECK (close_reason IN ('', 'completed', 'not_planned', 'duplicate')),
    resolution     TEXT NOT NULL DEFAULT ''
                   CHECK (resolution IN ('', 'fixed_in_code', 'paper_corrected', 'not_a_mismatch', 'cannot_reproduce', 'data_available')),
    resolution_ref TEXT NOT NULL DEFAULT '' CHECK (length(resolution_ref) <= 300),
    locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    lock_reason    TEXT NOT NULL DEFAULT '' CHECK (lock_reason IN ('', 'off-topic', 'too heated', 'resolved', 'spam')),
    pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    github_number  INTEGER CHECK (github_number IS NULL OR github_number >= 1),
    author_id      TEXT NOT NULL,                  -- oscr_community users.id: never answered, never exported
    author         TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via     TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role    TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    comments       INTEGER NOT NULL DEFAULT 0 CHECK (comments BETWEEN 0 AND 2500),
    -- The timeline's events (closed, reopened, renamed, labelled, locked, pinned, copied): the last
    -- 100, as GitHub caps an edit history.
    events         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events) AND json_type(events) = 'array'),
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    closed_at      INTEGER,
    CHECK ((forge = '') = (repo_id = '')),
    CHECK (repo_id != '' OR code_url != ''),
    CHECK ((state = 'closed') = (close_reason != '')),
    CHECK (state = 'closed' OR resolution = ''),
    CHECK (type != 'mismatch' OR (path != '' AND start_line IS NOT NULL AND paragraph IS NOT NULL)),
    CHECK ((start_line IS NULL) = (end_line IS NULL))
);
-- A paper's research issues, newest first: the paper's page, a repository's list (its papers, each a
-- range), the three pinned of a paper. One more row written per issue; none when it changes (neither
-- column moves).
CREATE INDEX research_paper ON research_issues(paper_id, id);

-- A research issue's comments, in order: `n` is the issue's count after it (research.ts writes both
-- in one batch). Read by the key's prefix: no index. A deleted comment keeps its row, empty, so the
-- numbering holds; a hidden one keeps its text for who opens it.
CREATE TABLE research_comments (
    issue_id     INTEGER NOT NULL,
    n            INTEGER NOT NULL CHECK (n BETWEEN 1 AND 2500),
    author_id    TEXT NOT NULL,
    author       TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via   TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role  TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    body         TEXT NOT NULL CHECK (length(body) <= 65536),
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    hidden       TEXT NOT NULL DEFAULT '' CHECK (hidden IN ('', 'spam', 'abuse', 'off-topic', 'outdated', 'duplicate', 'resolved')),
    PRIMARY KEY (issue_id, n),
    CHECK (deleted = 0 OR body = '')
) WITHOUT ROWID;

-- `actions` rebuilt with the kinds (types.ts ACTION_KINDS, then RESEARCH_KINDS, in order: a test
-- compares the effective schema with them): 'research_copy' is an authorized action on GitHub
-- (act-research.ts); 'research_open', 'research_comment' and 'research_edit' are the registry's own
-- writes, logged the same way so that the caps count them.
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
                     'issue_milestone', 'research_copy', 'research_open', 'research_comment',
                     'research_edit')),
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
