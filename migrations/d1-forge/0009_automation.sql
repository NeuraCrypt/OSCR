-- The forge database, part 9: automation and integrations (night phase 10). See docs/API.md,
-- docs/AUTOMATION.md and docs/DECISIONS.md D10-*.
--
-- - `api_tokens`: the registry's own personal tokens, for its public API (/api/v1/*) only, never for
--   git (git goes to GitHub with GitHub's tokens, D00-3). Only the SHA-256 of a token is kept: the
--   token itself is shown once, when it is made, and never again (a 256-bit random value needs no salt
--   nor slow hash: nobody can guess it from its digest).
-- - `hooks`: outgoing webhooks a person registers on a repository or a paper; `hook_deliveries`: what
--   each delivery did (its status, never the answer's body). A hook's secret is never stored either:
--   it is derived from the server key and the hook's `salt` (docs/AUTOMATION.md), so this database
--   alone signs nothing.
-- - `statuses`: the commit statuses outside services post with a token (a lab's CI, a reproduction
--   service): the latest of each context on each commit.
-- - `actions` rebuilt with the kinds `token`, `hook` and `status` (types.ts AUTOMATION_KINDS), so that
--   the per-account caps and the day's rows count these writes.
--
-- What each write costs (D08-18: the GitHub side is at its 5,000-row cap, so this phase writes little):
-- - a token made: its row and its index entry, and the action row (3); revoked: 2 + 1; its last use is
--   written at most once a day (1 row, only when the day changed);
-- - a hook made: its row and its index entry, the ping's delivery row, the action row (4); a change
--   (events, pause, secret rotated) 1 + 1; a delivery 1 (its row in hook_deliveries, counted in the
--   day's rows: gate.ts);
-- - a status: its row and the action row (2).
--
-- What it never holds: no token (a digest), no secret (a salt), no email address (every text is
-- masked before it is written, and the CHECKs refuse an at sign where a text is short), no answer's
-- body from a hook's receiver (its status code and a few fixed words only).
--
-- Times are Unix seconds; a day is the UTC day number, `at / 86400`.

-- A personal token of the registry. `id` is its public name (16 base64url characters, shown in lists
-- and in the answers' headers); `digest` the SHA-256 (hex) of the whole token, the key a request is
-- found by. `scopes` is a space-separated list of `area:read|write` (tokens-core.ts SCOPES).
CREATE TABLE api_tokens (
    digest         TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    id             TEXT NOT NULL CHECK (length(id) = 16),
    user_id        TEXT NOT NULL,                  -- oscr_community users.id: never answered
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND instr(name, '@') = 0),
    scopes         TEXT NOT NULL CHECK (length(scopes) BETWEEN 1 AND 300),
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    last_used_day  INTEGER,                        -- the UTC day of its last use; NULL: never used
    PRIMARY KEY (digest),
    CHECK (expires_at > created_at)
) WITHOUT ROWID;
-- A person's tokens (their settings page): one more row written when a token is made or revoked,
-- none when only its last use changes.
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- An outgoing webhook: a repository ("repo:<forge>:<id>") or a paper ("paper:doi:10.…"), the address
-- the registry posts to (https; checked against private networks and loopback before every delivery),
-- the events it wants ('*' or a space-separated list of events.ts EVENT_KINDS), whether it is active
-- (a hook is active once its ping got a 2xx answer, and stays so until its owner pauses it or ten
-- deliveries in a row fail).
CREATE TABLE hooks (
    user_id     TEXT NOT NULL,                     -- oscr_community users.id: never answered
    id          TEXT NOT NULL CHECK (length(id) = 16),
    subject     TEXT NOT NULL CHECK (length(subject) BETWEEN 6 AND 220 AND (substr(subject, 1, 5) = 'repo:' OR substr(subject, 1, 13) = 'paper:doi:10.')),
    url         TEXT NOT NULL CHECK (length(url) BETWEEN 10 AND 500 AND instr(url, '@') = 0),
    events      TEXT NOT NULL DEFAULT '*' CHECK (length(events) BETWEEN 1 AND 400),
    active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    salt        TEXT NOT NULL CHECK (length(salt) = 16),   -- the secret's derivation (never the secret)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
) WITHOUT ROWID;
-- The hooks of a subject, read once for every event written: one more row written when a hook is made
-- or deleted, none when it is paused, resumed, or its secret rotated.
CREATE INDEX hooks_subject ON hooks(subject);

-- One delivery of a hook: its ping, an event, a redelivery. Keyed by the UTC day first, like `actions`
-- and `deliveries`: today's rows are one range (the day's global count), a hook's recent deliveries
-- a few key ranges (a week). The event is named by its key in `events` (subject, at, nonce), so a
-- redelivery rebuilds the same payload; nothing of the receiver's answer is kept but its status code,
-- the time it took and a few fixed words.
CREATE TABLE hook_deliveries (
    day          INTEGER NOT NULL,                 -- at / 86400
    hook_id      TEXT NOT NULL CHECK (length(hook_id) = 16),
    at           INTEGER NOT NULL,
    guid         TEXT NOT NULL CHECK (length(guid) = 36),   -- the delivery's id, sent in its headers
    event        TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 40),
    ev_subject   TEXT NOT NULL DEFAULT '' CHECK (length(ev_subject) <= 220),
    ev_at        INTEGER NOT NULL DEFAULT 0,
    ev_nonce     TEXT NOT NULL DEFAULT '' CHECK (length(ev_nonce) <= 120),
    status       INTEGER NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 599),   -- 0: no answer
    ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
    attempts     INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 5),
    ms           INTEGER NOT NULL DEFAULT 0 CHECK (ms >= 0),
    words        TEXT NOT NULL DEFAULT '' CHECK (length(words) <= 120 AND instr(words, '@') = 0),
    redelivery   INTEGER NOT NULL DEFAULT 0 CHECK (redelivery IN (0, 1)),
    PRIMARY KEY (day, hook_id, at, guid),
    CHECK (day = CAST(at / 86400 AS INTEGER))
) WITHOUT ROWID;

-- A commit status posted by an outside service, on a commit of a repository the registry knows: the
-- latest of each `context` (a service's name for its check) on each commit, as GitHub keeps them. A
-- commit holds at most 20 contexts (statuses.ts). `via`: 'token' (a person's token) or 'oidc'
-- (GitHub Actions' own OIDC token, verified by the Worker: no secret in the repository).
CREATE TABLE statuses (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL,
    sha          TEXT NOT NULL CHECK (length(sha) IN (40, 64) AND sha NOT GLOB '*[^0-9a-f]*'),
    context      TEXT NOT NULL CHECK (length(context) BETWEEN 1 AND 100 AND instr(context, '@') = 0),
    state        TEXT NOT NULL CHECK (state IN ('error', 'failure', 'pending', 'success')),
    description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 140 AND instr(description, '@') = 0),
    target_url   TEXT NOT NULL DEFAULT '' CHECK (target_url = '' OR (substr(target_url, 1, 8) = 'https://' AND length(target_url) <= 500 AND instr(target_url, '@') = 0)),
    by_user      TEXT NOT NULL DEFAULT '',         -- oscr_community users.id ('' for GitHub Actions' OIDC): never answered
    by_name      TEXT NOT NULL DEFAULT '' CHECK (length(by_name) <= 100 AND instr(by_name, '@') = 0),   -- a GitHub login, an ORCID iD, or "GitHub Actions: <workflow>"
    via          TEXT NOT NULL CHECK (via IN ('token', 'oidc')),
    at           INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, sha, context)
) WITHOUT ROWID;

-- `actions` rebuilt with the automation kinds (types.ts ACTION_KINDS, RESEARCH_KINDS, SOCIAL_KINDS,
-- then AUTOMATION_KINDS, in order).
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
                     'tag_delete', 'asset_upload', 'asset_delete', 'package_confirm', 'research_open',
                     'research_comment', 'research_edit', 'star', 'star_list', 'follow', 'notice',
                     'profile', 'token', 'hook', 'status')),
    forge        TEXT NOT NULL DEFAULT '',
    repo_id      TEXT NOT NULL DEFAULT '',
    github_user  TEXT NOT NULL DEFAULT ''          -- the GitHub account that acted: its numeric id
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
