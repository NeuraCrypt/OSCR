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
