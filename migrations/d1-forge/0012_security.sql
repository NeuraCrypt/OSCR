-- The forge database, part 12: security and quality (night phase 11). See docs/SECURITY_QUALITY.md,
-- docs/FORGE.md and docs/DECISIONS.md D11-*.
--
-- All of these are PUBLIC-repository facts, except the private vulnerability reports (advisories,
-- advisory_posts), which are private by construction: they are never put in a public output, the
-- static layer, the search, a feed or a webhook, and a read is refused to anyone but the reporter,
-- the repository's maintainers and the collaborators the report names (service/advisory.ts).
--
-- Nothing here holds an email address, a token, a secret or a password, nor any user code. The Mac
-- reads files as text and never runs them (D00-11); OSCR runs no analyser on users' code. A secret
-- found is recorded by kind, path and line with the value hidden, never the value. OSV is queried by
-- the Mac without a key; the alert rows carry the advisory id and the severity, not the code.
--
-- Times are Unix seconds; a day is at / 86400. WITHOUT ROWID where the key is text; no secondary
-- index (every read is a key or a key range on the primary key).

-- The dependency graph (E1), one row per dependency, written by the Mac (oscr security). `snapshot`
-- is 'default' (the default branch's head) or 'cited' (the commit a paper's tracing map pins). The
-- version is an exact one when a lock file pins it; `req` is the declared range as written; `scope`
-- says runtime, build, optional, dev or actions; `direct` is 1 when a manifest names it (not only a
-- lock file); `sources` is the JSON array of the files it appears in (for the view's "show paths").
CREATE TABLE repo_deps (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*'),
    snapshot     TEXT NOT NULL CHECK (snapshot IN ('default', 'cited')),
    ecosystem    TEXT NOT NULL CHECK (ecosystem IN ('PyPI', 'npm', 'CRAN', 'Julia', 'conda', 'Actions')),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 214),
    version      TEXT NOT NULL DEFAULT '' CHECK (length(version) <= 100),
    req          TEXT NOT NULL DEFAULT '' CHECK (length(req) <= 200),
    scope        TEXT NOT NULL DEFAULT 'runtime' CHECK (scope IN ('runtime', 'build', 'optional', 'dev', 'actions')),
    direct       INTEGER NOT NULL DEFAULT 1 CHECK (direct IN (0, 1)),
    pinned       INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    sources      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND length(sources) <= 2000),
    commit_sha   TEXT NOT NULL DEFAULT ''
                 CHECK (commit_sha = '' OR (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*')),
    computed_at  INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, snapshot, ecosystem, name)
) WITHOUT ROWID;

-- The vulnerability, malware, secret and code-scanning alerts (E2, E3, E4). One row per finding.
-- `kind` is 'osv' (a vulnerability or malware advisory from OSV, written by the Mac), 'secret' (a
-- secret found after the push, written by the Mac, reports never blocks: D00-11) or 'sarif' (a code
-- scanning result the researcher's CI uploaded through the API, written by the Worker). `ref` is a
-- stable id within (repo, kind): the advisory id and the package for OSV, the path, line and kind for
-- a secret, the rule and location for SARIF. Nothing holds a secret's value (only a short hidden
-- hint in `summary`), a token, or any code. The human decision (dismiss, reopen, assign, label) is in
-- `alert_triage`, so the Mac re-pushing a finding never clobbers it.
CREATE TABLE security_alerts (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*'),
    kind         TEXT NOT NULL CHECK (kind IN ('osv', 'secret', 'sarif')),
    ref          TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 300),
    severity     TEXT NOT NULL DEFAULT 'unknown' CHECK (severity IN ('critical', 'high', 'moderate', 'low', 'unknown')),
    summary      TEXT NOT NULL DEFAULT '' CHECK (length(summary) <= 2000),
    detail       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 16384),
    ecosystem    TEXT NOT NULL DEFAULT '' CHECK (length(ecosystem) <= 40),
    package      TEXT NOT NULL DEFAULT '' CHECK (length(package) <= 214),
    version      TEXT NOT NULL DEFAULT '' CHECK (length(version) <= 100),
    advisory     TEXT NOT NULL DEFAULT '' CHECK (length(advisory) <= 100),
    path         TEXT NOT NULL DEFAULT '' CHECK (length(path) <= 4096),
    line         INTEGER CHECK (line IS NULL OR line >= 1),
    dev_scope    INTEGER NOT NULL DEFAULT 0 CHECK (dev_scope IN (0, 1)),
    commit_sha   TEXT NOT NULL DEFAULT ''
                 CHECK (commit_sha = '' OR (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^0-9a-f]*')),
    source       TEXT NOT NULL DEFAULT 'mac' CHECK (source IN ('mac', 'ci')),
    found_at     INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, kind, ref)
) WITHOUT ROWID;

-- The human decision on an alert (dismiss, reopen, assign, label), kept apart from the Mac's facts so
-- a re-push of an alert never clobbers it. Written by the Worker (service/security.ts), gated by
-- FORGE_OPEN, by a person who manages the repository. The `assignee` is an OSCR handle, never an
-- email; `labels` is a JSON array (e.g. ["development-scope"]).
CREATE TABLE alert_triage (
    forge        TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id      TEXT NOT NULL CHECK (repo_id NOT GLOB '*[^0-9]*'),
    kind         TEXT NOT NULL CHECK (kind IN ('osv', 'secret', 'sarif')),
    ref          TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 300),
    state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'dismissed')),
    reason       TEXT NOT NULL DEFAULT '' CHECK (reason IN ('', 'fixed', 'no_bandwidth', 'tolerable', 'false_positive', 'used_in_tests', 'wont_fix', 'revoked')),
    assignee     TEXT NOT NULL DEFAULT '' CHECK (length(assignee) <= 100 AND instr(assignee, '@') = 0),
    note         TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
    labels       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND length(labels) <= 300),
    by_user      TEXT NOT NULL DEFAULT '',          -- oscr_community users.id: never answered
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, kind, ref)
) WITHOUT ROWID;

-- `actions` rebuilt with the security kinds (types.ts ACTION_KINDS, RESEARCH_KINDS, SOCIAL_KINDS,
-- AUTOMATION_KINDS, MODERATION_KINDS, then SECURITY_KINDS, in order).
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
                     'tag_delete', 'asset_upload', 'asset_delete', 'package_confirm', 'research_open',
                     'research_comment', 'research_edit', 'star', 'star_list', 'follow', 'notice',
                     'profile', 'token', 'hook', 'status', 'report', 'moderate', 'appeal', 'block',
                     'limit', 'rights', 'security_alert', 'sarif', 'advisory_open', 'advisory_post',
                     'advisory_edit')),
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
