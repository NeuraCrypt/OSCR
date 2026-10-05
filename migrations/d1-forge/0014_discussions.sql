-- The forge database, part 14: discussions (night phase 06). See docs/DISCUSSIONS.md and
-- docs/DECISIONS.md D06-*.
--
-- Discussions are OSCR's own objects (D00-6), not GitHub's: a space per paper (keyed by its DOI,
-- even when the code is hosted elsewhere, the Discussion section reserved since phase 04), per
-- repository, and per organization. Their model is the research issues' (0005_research.sql): a pure
-- core (discussions-core.ts), the routes that read and write them (discussions.ts), the per-account
-- caps counted from the action rows each write adds (gate.ts). GitHub has no API for a discussion;
-- OSCR keeps them here and never posts them on GitHub.
--
-- Public free text (CLAUDE.md, the phase-16 reconciliation note): discussions are OSCR's FIRST
-- public, user-written free text. What protects them now: Turnstile on the write forms, the
-- per-account caps, the blocks and interaction limits (mayInteract), email masking (maskEmails:
-- oscr_forge holds no address), control characters stripped, the 65,536-character comment limit, and
-- triagers' hide/redact/delete through the `hidden` and `state` columns here. The central
-- owner-moderation queue and public reporting (the `moderation` and `content_reports` CHECKs,
-- hidden.ts, the Mac's oscr/moderation.py static drop, src/lib/moderation.ts) must be extended to
-- the kinds `discussion` and `discussion_comment` when phase 06 merges (D06-6).
--
-- What it never holds: no email address, no token, nothing of a paper's text (the reader shows it,
-- under the paper's licence).
--
-- Times are Unix seconds.

-- A space's settings: its categories (up to 25), each {slug, name, format, emoji, description}. A
-- space is created when its first discussion opens (its default categories), and its categories are
-- edited by the space's maintainers (a paper's verified authors, a repository's maintainers, the
-- registry's moderators). `space` is "paper:doi:10.…", "repo:<forge>:<id>" or "org:<handle>".
CREATE TABLE discussion_spaces (
    space        TEXT PRIMARY KEY
                 CHECK (length(space) BETWEEN 5 AND 260 AND space = lower(space) AND instr(space, '@') = 0),
    space_kind   TEXT NOT NULL CHECK (space_kind IN ('paper', 'repo', 'org')),
    categories   TEXT NOT NULL DEFAULT '[]'
                 CHECK (json_valid(categories) AND json_type(categories) = 'array' AND json_array_length(categories) <= 25),
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE discussions (
    id             INTEGER PRIMARY KEY,           -- "discussion#<id>", one numbering for the registry
    space          TEXT NOT NULL
                   CHECK (length(space) BETWEEN 5 AND 260 AND space = lower(space) AND instr(space, '@') = 0),
    space_kind     TEXT NOT NULL CHECK (space_kind IN ('paper', 'repo', 'org')),
    -- The space resolved, so a read keys by what it has (a paper's DOI, a repository's id).
    paper_id       TEXT NOT NULL DEFAULT ''
                   CHECK (paper_id = '' OR (substr(paper_id, 1, 7) = 'doi:10.' AND paper_id = lower(paper_id) AND length(paper_id) <= 210)),
    forge          TEXT NOT NULL DEFAULT '' CHECK (forge IN ('', 'github', 'memory')),
    repo_id        TEXT NOT NULL DEFAULT '' CHECK (repo_id NOT GLOB '*[^0-9]*'),
    category       TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 50 AND category = lower(category)),
    -- The category's format: a plain thread, an announcement (maintainers only), a question (answers
    -- and the answered state), or a poll (its options and their counts in `poll`).
    format         TEXT NOT NULL CHECK (format IN ('open', 'announcement', 'qa', 'poll')),
    title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
    body           TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 65536),
    -- A poll: {"options":[{"text":…,"votes":N}], "closes_at":N|null, "voters":N}. Empty otherwise.
    poll           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(poll) AND json_type(poll) = 'object' AND length(poll) <= 8192),
    labels         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND json_type(labels) = 'array' AND json_array_length(labels) <= 10),
    state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    close_reason   TEXT NOT NULL DEFAULT '' CHECK (close_reason IN ('', 'resolved', 'outdated', 'duplicate', 'off-topic', 'spam')),
    -- The comment number marked as the answer of a question (qa), or NULL. 0 is never used.
    answered       INTEGER CHECK (answered IS NULL OR answered >= 1),
    upvotes        INTEGER NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
    locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    lock_reason    TEXT NOT NULL DEFAULT '' CHECK (lock_reason IN ('', 'off-topic', 'too heated', 'resolved', 'spam')),
    pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    -- A triager hid the whole discussion: its reason, else ''. The read routes drop it for everyone
    -- but its author and the registry's moderators (like a hidden comment keeps its text for them).
    hidden         TEXT NOT NULL DEFAULT '' CHECK (hidden IN ('', 'spam', 'abuse', 'off-topic', 'outdated', 'duplicate', 'resolved', 'low-quality')),
    author_id      TEXT NOT NULL,                  -- oscr_community users.id: never answered, never exported
    author         TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via     TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role    TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    comments       INTEGER NOT NULL DEFAULT 0 CHECK (comments BETWEEN 0 AND 5000),
    -- The timeline's last 100 events (closed, reopened, renamed, recategorized, answered, unanswered,
    -- labeled, locked, pinned, transferred): as research issues keep them.
    events         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(events) AND json_type(events) = 'array'),
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    closed_at      INTEGER,
    CHECK ((space_kind = 'paper') = (paper_id != '')),
    CHECK ((space_kind = 'repo') = (forge != '')),
    CHECK ((forge = '') = (repo_id = '')),
    CHECK ((state = 'closed') = (close_reason != '')),
    CHECK (format = 'qa' OR answered IS NULL),
    CHECK (format = 'poll' OR poll = '{}')
);
-- A space's discussions, newest first (one read, by the key's prefix): the space's page, the pinned.
CREATE INDEX discussions_space ON discussions(space, id);

-- A discussion's comments, in order: `n` is the discussion's count after it (discussions.ts writes
-- both in one batch). Read by the key's prefix: no index. A deleted comment keeps its row, empty, so
-- the numbering holds; a hidden one keeps its text for who may open it. A comment may be upvoted and,
-- in a question, marked as the answer (the discussion's `answered`).
CREATE TABLE discussion_comments (
    discussion_id  INTEGER NOT NULL,
    n              INTEGER NOT NULL CHECK (n BETWEEN 1 AND 5000),
    author_id      TEXT NOT NULL,
    author         TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via     TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role    TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    body           TEXT NOT NULL CHECK (length(body) <= 65536),
    upvotes        INTEGER NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
    -- A reply to another comment of the same discussion (its number), or NULL for a top-level comment.
    reply_to       INTEGER CHECK (reply_to IS NULL OR reply_to >= 1),
    created_at     INTEGER NOT NULL,
    edited_at      INTEGER,
    deleted        INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    hidden         TEXT NOT NULL DEFAULT '' CHECK (hidden IN ('', 'spam', 'abuse', 'off-topic', 'outdated', 'duplicate', 'resolved', 'low-quality')),
    PRIMARY KEY (discussion_id, n),
    CHECK (deleted = 0 OR body = '')
) WITHOUT ROWID;

-- Who voted what: a reader's upvote on a discussion or a comment, and their poll choice (kept so a
-- vote is counted once and can be taken back). `ref` is "<id>" (the discussion), "<id>#<n>" (a
-- comment) or "<id>poll" (a poll). The count on the row is the truth the pages read; this table
-- stops a second vote. Read by its key only.
CREATE TABLE discussion_votes (
    ref          TEXT NOT NULL CHECK (length(ref) <= 32),
    user_id      TEXT NOT NULL,
    choice       INTEGER NOT NULL DEFAULT 0,        -- a poll option's index, else 0
    at           INTEGER NOT NULL,
    PRIMARY KEY (ref, user_id)
) WITHOUT ROWID;

-- `actions` rebuilt with phase 06's registry-native kinds (types.ts ROW_KINDS; the foundation test
-- compares the effective schema with them): the discussion kinds ('discussion_open',
-- 'discussion_comment', 'discussion_edit', 'discussion_vote') and the project kinds ('project_create',
-- 'project_edit', 'project_item', 'project_field') are the registry's own writes, logged the same way
-- so the caps count them (gate.ts). The project tables are 0015_projects.sql; 'wiki_edit' (an
-- authorized GitHub commit) comes with its own migration, 0016_wiki.sql.
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
                     'tag_delete', 'asset_upload', 'asset_delete', 'package_confirm',
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
