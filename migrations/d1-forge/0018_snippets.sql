-- The forge database, part 18: snippets (night phase 13). See docs/SNIPPETS.md and
-- docs/DECISIONS.md D13-*.
--
-- Snippets are OSCR's gists. Their FILES live in a `snippets` repository in the researcher's own
-- GitHub account, one folder per snippet, created and revised through authorized commits
-- (act-snippet.ts, the phase-03 model): OSCR never asks for the Gists permission (D00-14) and never
-- writes to GitHub itself. Reading a snippet's files is reading GitHub (0 requests, in the browser).
--
-- A snippet's RECORD lives here: a numeric id (the reference moderation already expects,
-- `snippet:<id>`: moderation-core.ts RE.snippet), the owner, the git location (the `snippets` repo
-- and the folder) and the revision committed, the visibility, the title and description, a MANIFEST
-- of the files (path, language, size, lines; never the content, never git text, the row budget),
-- an optional paper passage (a DOI and a Methods paragraph, shown BESIDE the maps, never a map,
-- never given a DOI: D13-*), the counts, and who wrote it. Its model is the discussions'
-- (0014_discussions.sql): comments and stars are OSCR-native writes (snippets.ts), the per-account
-- caps counted from the action rows each adds (gate.ts, caps.ts `snippets`).
--
-- Public free text (CLAUDE.md, the phase-16 reconciliation note): a snippet's description, its
-- comments and the content shown are OSCR's public, user-written free text. What protects them:
-- Turnstile on the write forms, the per-account caps, the blocks and interaction limits
-- (mayInteract), email masking (maskEmails: oscr_forge holds no address), control characters
-- stripped, the 65,536-character comment limit, and triagers' hide/delete through the `hidden` and
-- `deleted` columns here. The central owner-moderation queue and public reporting must be extended
-- to the kinds `snippet` and `snippet_comment` when phase 16 reconciles (D13-n; content_reports
-- already lists `snippet`; the `moderation` and data-rights CHECKs do not yet).
--
-- What it never holds: no email address, no token, nothing of the files' text (the browser shows it
-- from GitHub, at the pinned revision).
--
-- Times are Unix seconds.

CREATE TABLE snippets (
    id             INTEGER PRIMARY KEY,           -- "snippet:<id>", one numbering for the registry
    owner_id       TEXT NOT NULL,                 -- oscr_community users.id: never answered, never exported
    owner_login    TEXT NOT NULL                  -- the GitHub account the `snippets` repo is in (lower)
                   CHECK (owner_login = lower(owner_login) AND length(owner_login) BETWEEN 1 AND 100 AND instr(owner_login, '@') = 0),
    forge          TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id        TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*' AND length(repo_id) BETWEEN 1 AND 100),
    folder         TEXT NOT NULL                  -- the snippet's folder in the `snippets` repository
                   CHECK (folder = lower(folder) AND folder GLOB '[a-z0-9]*' AND folder NOT GLOB '*[^a-z0-9-]*' AND length(folder) BETWEEN 1 AND 60),
    revision       TEXT NOT NULL CHECK (length(revision) IN (40, 64)),  -- the commit the record points at
    visibility     TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
    title          TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description    TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4096),
    -- The files, as a manifest only: [{"path":…,"language":…,"size":N,"lines":N}]. Never the content.
    files          TEXT NOT NULL DEFAULT '[]'
                   CHECK (json_valid(files) AND json_type(files) = 'array' AND json_array_length(files) BETWEEN 1 AND 20 AND length(files) <= 16384),
    -- The paper passage the snippet is about (D13-*): a DOI and a Methods paragraph, with lines at
    -- the revision. Shown BESIDE the maps, never a map, never given a DOI. All empty when none.
    paper_id       TEXT NOT NULL DEFAULT ''
                   CHECK (paper_id = '' OR (substr(paper_id, 1, 7) = 'doi:10.' AND paper_id = lower(paper_id) AND length(paper_id) <= 210)),
    section        TEXT NOT NULL DEFAULT '' CHECK (length(section) <= 200 AND instr(section, char(10)) = 0),
    paragraph      INTEGER CHECK (paragraph IS NULL OR paragraph >= 1),
    start_line     INTEGER CHECK (start_line IS NULL OR start_line >= 1),
    end_line       INTEGER CHECK (end_line IS NULL OR (start_line IS NOT NULL AND end_line >= start_line)),
    stars          INTEGER NOT NULL DEFAULT 0 CHECK (stars >= 0),
    comments       INTEGER NOT NULL DEFAULT 0 CHECK (comments BETWEEN 0 AND 5000),
    forks          INTEGER NOT NULL DEFAULT 0 CHECK (forks >= 0),
    -- The snippet this one was forked from (its id), or NULL for an original.
    forked_from    INTEGER CHECK (forked_from IS NULL OR forked_from >= 1),
    comments_off   INTEGER NOT NULL DEFAULT 0 CHECK (comments_off IN (0, 1)),
    -- A triager (the owner of the snippet, or a moderator) hid the whole snippet: its reason, else ''.
    -- The read routes drop it for everyone but its author and the moderators.
    hidden         TEXT NOT NULL DEFAULT '' CHECK (hidden IN ('', 'spam', 'abuse', 'off-topic', 'outdated', 'duplicate', 'resolved', 'low-quality')),
    author         TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via     TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role    TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    -- The public handle (`/snippet/<owner>/<folder>/`) and the git-location uniqueness: one account has
    -- a single `snippets` repository, so (owner_login, folder) is the folder's key. A UNIQUE constraint
    -- (an auto-index, not an index of its own: the one-index-per-table rule). It serves the handle read
    -- and a person's snippets (its prefix on owner_login), by key, never a scan.
    UNIQUE (owner_login, folder),
    CHECK (paragraph IS NULL OR paper_id != ''),
    CHECK (section = '' OR paper_id != '')
);
-- Discover: public snippets, newest first (unlisted ones are never here: a key range on the one index,
-- never a scan). The read also filters hidden = '' on the rows it finds. The only index of the table.
CREATE INDEX snippets_discover ON snippets(visibility, id);

-- A snippet's comments, in order: `n` is the snippet's count after it (snippets.ts writes both in one
-- batch), read by the key's prefix (no index). A deleted comment keeps its row, empty, so the
-- numbering holds; a hidden one keeps its text for who may open it (its author, the owner, a
-- moderator). `history` keeps the prior bodies of an edited comment (the last 20), so an edit has a
-- history (D13-*).
CREATE TABLE snippet_comments (
    snippet_id     INTEGER NOT NULL,
    n              INTEGER NOT NULL CHECK (n BETWEEN 1 AND 5000),
    author_id      TEXT NOT NULL,
    author         TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via     TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role    TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    body           TEXT NOT NULL CHECK (length(body) <= 65536),
    reply_to       INTEGER CHECK (reply_to IS NULL OR reply_to >= 1),
    history        TEXT NOT NULL DEFAULT '[]'
                   CHECK (json_valid(history) AND json_type(history) = 'array' AND json_array_length(history) <= 20 AND length(history) <= 262144),
    created_at     INTEGER NOT NULL,
    edited_at      INTEGER,
    deleted        INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    hidden         TEXT NOT NULL DEFAULT '' CHECK (hidden IN ('', 'spam', 'abuse', 'off-topic', 'outdated', 'duplicate', 'resolved', 'low-quality')),
    PRIMARY KEY (snippet_id, n),
    CHECK (deleted = 0 OR body = '')
) WITHOUT ROWID;

-- Who starred what: a reader's star of a snippet (kept so it is counted once and can be taken back;
-- the count on the snippet row is the truth the pages read). Read by its key, and by the snippet's
-- prefix for the stargazers list.
CREATE TABLE snippet_stars (
    snippet_id     INTEGER NOT NULL,
    user_id        TEXT NOT NULL,
    starrer        TEXT NOT NULL CHECK (length(starrer) BETWEEN 1 AND 100 AND instr(starrer, '@') = 0),
    starrer_via    TEXT NOT NULL CHECK (starrer_via IN ('github', 'orcid', 'name')),
    at             INTEGER NOT NULL,
    PRIMARY KEY (snippet_id, user_id)
) WITHOUT ROWID;

-- `actions` rebuilt with phase 13's kinds (types.ts ROW_KINDS; the foundation test compares the
-- effective schema with them): the authorized commits 'snippet_create', 'snippet_revise' and
-- 'snippet_fork' (ACTION_KINDS, after 'wiki_edit'), and the registry-native 'snippet_edit',
-- 'snippet_comment' and 'snippet_star' (SNIPPET_KINDS, at the end), logged the same way so the caps
-- count them (gate.ts).
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
                     'snippet_create', 'snippet_revise', 'snippet_fork',
                     'research_open', 'research_comment', 'research_edit', 'star', 'star_list',
                     'follow', 'notice', 'profile', 'token', 'hook', 'status', 'report', 'moderate',
                     'appeal', 'block', 'limit', 'rights', 'security_alert', 'sarif', 'advisory_open',
                     'advisory_post', 'advisory_edit', 'org', 'member', 'team', 'passkey', 'session',
                     'identity', 'discussion_open', 'discussion_comment', 'discussion_edit',
                     'discussion_vote', 'project_create', 'project_edit', 'project_item',
                     'project_field', 'snippet_edit', 'snippet_comment', 'snippet_star')),
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
