-- The forge database, part 16: the wiki action (night phase 06). See docs/DISCUSSIONS.md and
-- docs/DECISIONS.md D06-*.
--
-- The wiki is versioned by git (D00-6): Markdown pages on a `wiki` branch of the repository, edited
-- through the phase-03 one-authorized-commit model (act-wiki.ts). GitHub offers no API for its own
-- wikis, so there is no new table: a wiki commit is an authorized action like any other, recorded by
-- its action row only (the file contents stay on GitHub, never in D1). This migration adds the
-- 'wiki_edit' kind to `actions` (types.ts ACTION_KINDS, now the last column rebuild the foundation
-- test compares with ROW_KINDS). 'wiki_edit' sits at the end of the GitHub action kinds, before the
-- registry's own research, social, moderation, organization, discussion and project kinds.

CREATE TABLE actions_next (
    day          INTEGER NOT NULL,
    user_id      TEXT NOT NULL,
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
                     'tag_delete', 'asset_upload', 'asset_delete', 'package_confirm', 'wiki_edit',
                     'research_open', 'research_comment', 'research_edit', 'star', 'star_list',
                     'follow', 'notice', 'profile', 'token', 'hook', 'status', 'report', 'moderate',
                     'appeal', 'block', 'limit', 'rights', 'security_alert', 'sarif', 'advisory_open',
                     'advisory_post', 'advisory_edit', 'org', 'member', 'team', 'passkey', 'session',
                     'identity', 'discussion_open', 'discussion_comment', 'discussion_edit',
                     'discussion_vote', 'project_create', 'project_edit', 'project_item',
                     'project_field')),
    forge        TEXT NOT NULL DEFAULT '',
    repo_id      TEXT NOT NULL DEFAULT '',
    github_user  TEXT NOT NULL DEFAULT ''
                 CHECK (github_user NOT GLOB '*[^0-9]*'),
    outcome      TEXT NOT NULL CHECK (outcome IN ('done', 'pending', 'failed')),
    rows         INTEGER NOT NULL CHECK (rows BETWEEN 0 AND 1000),
    subject      TEXT NOT NULL DEFAULT '' CHECK (length(subject) <= 342),
    PRIMARY KEY (day, user_id, at, nonce),
    CHECK (day = CAST(at / 86400 AS INTEGER))
) WITHOUT ROWID;

INSERT INTO actions_next (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows, subject)
    SELECT day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows, subject FROM actions;

DROP TABLE actions;

ALTER TABLE actions_next RENAME TO actions;
