-- The forge database, part 1: Git hosting and the mirror mode (night phase 01). D1 database
-- `oscr_forge`, bound to the Worker as FORGE. See docs/FORGE.md (the contract: routes, actions,
-- rows, caps), docs/ARCHITECTURE.md "Git hosting" and docs/DECISIONS.md D00-12, D01-*.
--
-- OSCR hosts no Git repository (D00-1, D00-2): repositories live in each researcher's own GitHub
-- account. This database holds only OSCR's own layer over them:
-- - `repos`: the repositories OSCR knows, by the forge's durable id, public only (D00-14);
-- - `repo_papers`: which paper DOIs each one is attached to;
-- - `installations`: where OSCR's GitHub App is installed (the mirror mode's webhooks);
-- - `traced_paths`: the files tracing maps point to, pushed by the Mac (oscr/forgelayer.py);
-- - `actions`: one row per authorized action (the audit, and the daily caps);
-- - `deliveries`: one row per webhook delivery (redeliveries, and the daily cap);
-- - `jobs`: what the Mac must look at (oscr/forgejobs.py).
--
-- What it never holds:
-- - no email address (GitBackend's types have no field for one, and the CHECKs refuse an at sign
--   in the names);
-- - no token of any kind (a person's token is used for one action, then revoked: D00-4);
-- - no Git object (commits, trees, files stay on the forge: D00-6);
-- - no private repository: its name is never stored, and a repository made private leaves OSCR
--   (state 'hidden', its name blanked).
--
-- Written by two parties: the Worker (repos, repo_papers, installations, actions, deliveries,
-- jobs) and the Mac (traced_paths, and the answers of the jobs: heads, renames, states). The Mac
-- never writes actions or deliveries.
--
-- What each write costs. D1's free plan writes 100,000 rows a day for the whole account; the
-- forge service caps its own writes at 5,000 a day in code (website/worker/forge/service/caps.ts,
-- FORGE_ROWS_PER_DAY), counted from `actions.rows` and `deliveries.rows`, with no counter row. An
-- index adds one row written to every write that touches its columns, so:
-- - the tables keyed by text are WITHOUT ROWID: the primary key is the table itself;
-- - `jobs` is keyed by an INTEGER PRIMARY KEY, which is the rowid (no AUTOINCREMENT);
-- - one index in the whole database, `repos_path`, which the pages need to find a repository by
--   the path people type.
-- The daily counts read key ranges: `actions` and `deliveries` start their keys with the UTC day
-- (D01-11), so "an account's last 24 hours" is two ranges and "today's rows" one range each.
--
-- Forges: 'github', and 'memory', the test double's (website/tests/forge/memory.ts; the Worker's
-- production backend is GitHub's, so no production row has it). 'gitlab', 'forgejo' and
-- 'cloudflare' are reserved (D00-13): a later migration widens the CHECKs.
--
-- Times are Unix seconds; a day is the UTC day number, `at / 86400` (D1's own day).

-- A repository OSCR knows: created through OSCR, linked by a person (the mirror mode), in its own
-- forge account. Keyed by the forge's durable id, which survives renames and transfers; the path
-- (`owner_login`, `name`) follows them (webhooks, the Mac's `reconcile` job).
CREATE TABLE repos (
    forge            TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    repo_id          TEXT NOT NULL                 -- the forge's durable id (GitHub: the numeric id, as text)
                     CHECK (length(repo_id) BETWEEN 1 AND 100),
    owner_id         TEXT NOT NULL,                -- the owning account's durable id
    owner_login      TEXT NOT NULL                 -- lower case; '' only once hidden
                     CHECK (owner_login = lower(owner_login) AND length(owner_login) <= 100 AND instr(owner_login, '@') = 0),
    name             TEXT NOT NULL                 -- lower case; '' only once hidden (D00-14)
                     CHECK (name = lower(name) AND length(name) <= 100 AND instr(name, '@') = 0),
    mode             TEXT NOT NULL CHECK (mode IN ('created', 'installed', 'public')),
    installation_id  TEXT,                         -- the App's installation on it; NULL when 'public'
    default_branch   TEXT,                         -- as last seen; NULL for an empty repository
    head             TEXT                          -- the default branch's head, as last seen
                     CHECK (head IS NULL OR length(head) IN (40, 64)),
    head_at          INTEGER,                      -- when the forge says it was pushed (older news is ignored)
    template         INTEGER NOT NULL DEFAULT 0 CHECK (template IN (0, 1)),   -- a template repository
    state            TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active', 'archived', 'pending_deletion', 'hidden', 'deleted', 'gone')),
    delete_after     INTEGER,                      -- end of OSCR's grace period (D00-10)
    linked_by        TEXT NOT NULL,                -- oscr_community users.id (no foreign key across databases)
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id),
    CHECK (state = 'hidden' OR (owner_login != '' AND name != '')),
    CHECK (mode != 'public' OR installation_id IS NULL),
    CHECK (mode != 'installed' OR installation_id IS NOT NULL),
    CHECK (state != 'pending_deletion' OR delete_after IS NOT NULL)
) WITHOUT ROWID;
-- A repository by the path people type (/r/<owner>/<name>/, GET /api/forge/repo?path=), and an
-- account's repositories by the key's prefix ("Your repositories": the reader's own GitHub
-- account; an installation's account when it is removed). One more row written when a repository
-- is inserted, renamed or transferred; none when only its head, mode or state changes.
CREATE INDEX repos_path ON repos(forge, owner_login, name);

-- A repository attached to a paper: 'linked' when the person who attached it is a verified author
-- of the paper or a maintainer of the repository (oscr_community roles), 'proposed' otherwise.
-- Read by repository, the key's prefix: no index. The papers' own pages list their repositories
-- from the Mac's static layer (oscr/forgelayer.py), not from here.
CREATE TABLE repo_papers (
    forge     TEXT NOT NULL,
    repo_id   TEXT NOT NULL,
    paper_id  TEXT NOT NULL                        -- "doi:10.…", lower case, as oscr_community's paper ids
              CHECK (substr(paper_id, 1, 7) = 'doi:10.' AND paper_id = lower(paper_id) AND length(paper_id) <= 204),
    status    TEXT NOT NULL CHECK (status IN ('linked', 'proposed')),
    by_user   TEXT NOT NULL,                       -- oscr_community users.id
    at        INTEGER NOT NULL,
    PRIMARY KEY (forge, repo_id, paper_id)
) WITHOUT ROWID;

-- Where OSCR's GitHub App is installed, as its webhooks say (`installation`,
-- `installation_repositories`). The account's login is public; its repositories are found by
-- `repos_path`'s prefix (an installation belongs to one account).
CREATE TABLE installations (
    forge          TEXT NOT NULL CHECK (forge IN ('github', 'memory')),
    id             TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 40),
    account_id     TEXT NOT NULL,
    account_login  TEXT NOT NULL CHECK (account_login = lower(account_login) AND instr(account_login, '@') = 0),
    account_type   TEXT NOT NULL CHECK (account_type IN ('user', 'organization')),
    selection      TEXT NOT NULL CHECK (selection IN ('all', 'selected')),
    suspended      INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (forge, id)
) WITHOUT ROWID;

-- The files tracing maps point to, pushed by the Mac as deltas (oscr/forgelayer.py): the
-- repository, the path, the paper, the commit the map is pinned to, and how many line ranges.
-- The deletion page shows how many maps and paths point to a repository. Read by repository,
-- the key's prefix: no index.
CREATE TABLE traced_paths (
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    path        TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
    paper_id    TEXT NOT NULL CHECK (substr(paper_id, 1, 4) IN ('doi:', 'pmci')),
    commit_sha  TEXT NOT NULL CHECK (length(commit_sha) IN (40, 64) AND commit_sha = lower(commit_sha)),
    ranges      INTEGER NOT NULL CHECK (ranges >= 0),
    PRIMARY KEY (forge, repo_id, path, paper_id)
) WITHOUT ROWID;

-- One row per authorized action (D00-4): the audit, and what the daily caps count. `rows` is what
-- the action wrote in D1, its own row included. Keyed by the UTC day first: an account's last 24
-- hours are two ranges of the key, (yesterday, user) and (today, user), and today's rows of every
-- account one range (the global cap). No index.
CREATE TABLE actions (
    day          INTEGER NOT NULL,                 -- at / 86400
    user_id      TEXT NOT NULL,                    -- oscr_community users.id
    at           INTEGER NOT NULL,
    nonce        TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 64),
    kind         TEXT NOT NULL CHECK (kind IN (
                     'create', 'generate', 'link', 'papers', 'rename', 'edit', 'topics', 'features',
                     'template', 'default_branch', 'archive', 'unarchive', 'transfer', 'branch_create',
                     'branch_rename', 'branch_delete', 'autolink_create', 'autolink_delete',
                     'delete_request', 'restore', 'delete_final', 'software_heritage')),
    forge        TEXT NOT NULL DEFAULT '',
    repo_id      TEXT NOT NULL DEFAULT '',
    github_user  TEXT NOT NULL DEFAULT ''          -- the GitHub account that acted: its numeric id
                 CHECK (github_user NOT GLOB '*[^0-9]*'),
    outcome      TEXT NOT NULL CHECK (outcome IN ('done', 'pending', 'failed')),
    rows         INTEGER NOT NULL CHECK (rows BETWEEN 0 AND 1000),
    PRIMARY KEY (day, user_id, at, nonce),
    CHECK (day = CAST(at / 86400 AS INTEGER))
) WITHOUT ROWID;

-- One row per webhook delivery handled: a redelivery (same id: GitHub lets its sender redeliver
-- the last 3 days) writes nothing, and `rows` counts in the global cap. Keyed by the UTC day
-- first: the redelivery check reads (day, delivery) for the last four days; today's rows are one
-- range. No index.
CREATE TABLE deliveries (
    day       INTEGER NOT NULL,                    -- at / 86400
    delivery  TEXT NOT NULL CHECK (length(delivery) BETWEEN 1 AND 100),   -- the forge's delivery id
    at        INTEGER NOT NULL,
    event     TEXT NOT NULL DEFAULT '' CHECK (length(event) <= 40),      -- the event kind, for logs
    rows      INTEGER NOT NULL CHECK (rows BETWEEN 0 AND 1000),
    PRIMARY KEY (day, delivery),
    CHECK (day = CAST(at / 86400 AS INTEGER))
) WITHOUT ROWID;

-- What the Mac must look at, in order (oscr/forgejobs.py): a repository just linked or created
-- (`link`), a push to a repository with traced paths (`push`), a Software Heritage request on a
-- person's demand (`archive`, D00-15), a grace period to check once over (`delete_due`, from
-- `not_before`), a repository to follow by id (`reconcile`). Append-only: the Mac reads the rows
-- after the last one it saw (`WHERE id > ?`, the rowid's own order: no index), as oscr_community's
-- jobs; rows are never deleted, so an id is never given twice. The Mac answers a job in its own
-- row (`done_at`, `outcome`, `message`: one row written), which a repository's page reads from the
-- table's last rows (a bounded tail of the rowid, never a scan).
CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY,               -- the rowid: the order the Mac reads them in
    kind        TEXT NOT NULL CHECK (kind IN ('link', 'push', 'archive', 'delete_due', 'reconcile')),
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    ref         TEXT NOT NULL DEFAULT '',          -- a branch, a commit: what the job is about
    user_id     TEXT NOT NULL DEFAULT '',          -- who asked ('' for a webhook's job)
    created_at  INTEGER NOT NULL,
    not_before  INTEGER,                           -- delete_due: the end of the grace period
    done_at     INTEGER,                           -- written by the Mac; NULL while it waits
    outcome     TEXT NOT NULL DEFAULT '' CHECK (outcome IN ('', 'done', 'failed', 'skipped')),
    message     TEXT NOT NULL DEFAULT ''           -- the Mac's words for the person, plain text
                CHECK (length(message) <= 300 AND instr(message, '@') = 0),
    CHECK (kind != 'delete_due' OR not_before IS NOT NULL),
    CHECK ((done_at IS NULL) = (outcome = ''))
);
