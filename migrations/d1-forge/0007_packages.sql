-- The forge database, part 7: the packages a repository publishes (night phase 07). See
-- docs/RELEASES.md "Packages" and docs/DECISIONS.md D07-*.
--
-- OSCR hosts no package (GitHub Packages as a service is excluded: storage, bandwidth, and files the
-- registry cannot vet). A repository's manifests declare its packages (pyproject.toml, DESCRIPTION,
-- Project.toml, package.json, a conda recipe): the release and environment pages read them in the
-- reader's browser, as text, and propose them; a person who may push confirms or declines each one,
-- one authorized action (act-packages.ts `package_confirm`), and the registry keeps that word here:
-- the registry and the name at their public registry (PyPI, CRAN, conda-forge, Julia's General
-- registry, npm), the version the manifest said, the file that said it. The Mac publishes the
-- confirmed ones in the static layer (oscr/forgelayer.py); the package itself stays at its registry.
--
-- What each write costs: 1 row (the table is its key), with the action row. No index: a repository's
-- packages are read by the key's prefix.

CREATE TABLE repo_packages (
    forge      TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id    TEXT NOT NULL CHECK (length(repo_id) BETWEEN 1 AND 100),
    registry   TEXT NOT NULL CHECK (registry IN ('pypi', 'cran', 'conda-forge', 'julia', 'npm')),
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 214 AND instr(name, ' ') = 0 AND instr(name, char(10)) = 0),
    status     TEXT NOT NULL CHECK (status IN ('confirmed', 'declined')),
    version    TEXT NOT NULL DEFAULT '' CHECK (length(version) <= 40),
    source     TEXT NOT NULL DEFAULT '' CHECK (length(source) <= 500),   -- the manifest's path
    by_user    TEXT NOT NULL,                      -- oscr_community users.id: never answered, never exported
    at         INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, registry, name)
) WITHOUT ROWID;

-- `actions` rebuilt with the kind `package_confirm` (types.ts ACTION_KINDS, then RESEARCH_KINDS, in order).
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
