-- The forge database, part 4: issues (night phase 05). See docs/ISSUES.md and docs/DECISIONS.md
-- D05-*.
--
-- Eleven new kinds of authorized action, each ONE act made by GitHub as the person (D00-4):
-- 'issue_open', 'issue_edit', 'issue_comment', 'issue_react', 'issue_lock', 'issue_pin',
-- 'issue_transfer', 'issue_relation', 'issue_branch', 'issue_labels', 'issue_milestone'
-- (website/worker/forge/service/act-issues.ts). Each writes the action row only (1 row). Ordinary
-- issues, their comments, labels and milestones are GitHub's objects (D00-6): no title, body,
-- comment or label of theirs reaches D1.
--
-- SQLite cannot change a CHECK in place: `actions` is rebuilt with the same columns, key and
-- rules, and the kinds added to its list (website/worker/forge/service/types.ts ACTION_KINDS lists
-- the same, in the same order: a test compares the effective schema with it). The rows are copied
-- as they are. Still no index (D01-11).

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
                     'issue_milestone')),
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
