-- The community database, part 1: accounts (Phase 5). D1 database `oscr_community`, bound to the
-- Worker as COMMUNITY. See docs/ACCOUNTS.md and docs/PLATFORM_PLAN.md §4 ("Community [U]"), §8.
--
-- What it never holds:
-- - no email address, in any table: notifications stay in the site (decision D5), and the sign-in
--   asks the providers for none (ORCID and Google: scope `openid` only; GitHub: no scope);
-- - no OAuth token: the Worker uses a provider's token during the sign-in's callback, then drops it;
-- - no session id: only its SHA-256.
--
-- Written by two parties: the Worker (users, identities, sessions, roles, claims) and the Mac
-- (`oscr community push`: paper_orcid, repo_owner, the facts the verifications need). The Worker
-- never writes the facts; the Mac never writes the accounts.
--
-- What each write costs. D1's free plan writes 100,000 rows a day for the whole account (the
-- catalogue's projection included), and an index adds one row written to every write that
-- touches its columns. Hence:
-- - the tables keyed by text are WITHOUT ROWID: the primary key is the table itself, where a
--   rowid table would add a hidden unique index, one more row written for every insert;
-- - `claims` is keyed by an INTEGER PRIMARY KEY, which is the rowid: no index either, and no
--   AUTOINCREMENT (it writes to sqlite_sequence on every insert);
-- - an index exists only where a query of the Worker would otherwise read a whole table; each
--   one says why, and what it costs.
-- The Worker's writes per sign-in are counted in docs/ACCOUNTS.md.
--
-- Times are Unix seconds.

-- A person with an account. Every user is a `member`: that role is implied, not stored.
CREATE TABLE users (
    id            TEXT PRIMARY KEY,                -- random, 128 bits ("u_" + base64url)
    display_name  TEXT NOT NULL DEFAULT ''         -- the name a provider gave, if any; never an address
                  CHECK (length(display_name) <= 200 AND instr(display_name, '@') = 0),
    orcid         TEXT                             -- public handle: the ORCID iD, once linked
                  -- (D1 refuses a GLOB pattern over 50 bytes: the shape is checked piece by piece)
                  CHECK (orcid IS NULL OR (length(orcid) = 19 AND substr(orcid, 5, 1) = '-' AND substr(orcid, 10, 1) = '-'
                         AND substr(orcid, 15, 1) = '-' AND replace(orcid, '-', '') NOT GLOB '*[^0-9X]*')),
    github_login  TEXT,                            -- public handle: the GitHub login, refreshed at each GitHub sign-in
    created_at    INTEGER NOT NULL
) WITHOUT ROWID;

-- A provider's account linked to a user: at most one per provider and user (checked by the
-- Worker), and never two users for one provider's account (the key).
CREATE TABLE identities (
    provider   TEXT NOT NULL CHECK (provider IN ('orcid', 'github', 'google')),
    subject    TEXT NOT NULL,       -- ORCID: the iD (OIDC `sub`); Google: its opaque `sub`; GitHub: the numeric user id
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    linked_at  INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
) WITHOUT ROWID;
-- A user's identities: the account page lists them, and linking checks that the user has none of
-- that provider yet. Without it, both would read the whole table. One more row written per
-- identity linked: a few per user, once.
CREATE INDEX identities_user ON identities(user_id);

-- A signed-in browser. Its cookie holds a random 256-bit id; only the id's SHA-256 is here.
CREATE TABLE sessions (
    id_hash          TEXT PRIMARY KEY,             -- hex SHA-256 of the cookie's id
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL,
    expires_at       INTEGER NOT NULL,             -- 30 days on; slides at most once a day
    last_seen_at     INTEGER NOT NULL,             -- updated at most once an hour
    user_agent_hint  TEXT NOT NULL DEFAULT ''      -- short ("Firefox on macOS"), never the full string
                     CHECK (length(user_agent_hint) <= 40)
) WITHOUT ROWID;
-- A user's sessions: a sign-in deletes that user's expired ones, and a later "sign out
-- everywhere" all of them, without reading the table. One more row written when a session is
-- created or deleted; the hourly and daily updates do not touch it.
CREATE INDEX sessions_user ON sessions(user_id);

-- What a user may do beyond being a member. `verified_author` is scoped to a paper, `maintainer`
-- to a repository; `moderator` and `admin` are global (granted by hand, Phase 7).
CREATE TABLE roles (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('member', 'verified_author', 'maintainer', 'moderator', 'admin')),
    scope_kind  TEXT NOT NULL DEFAULT '' CHECK (scope_kind IN ('', 'paper', 'repo')),
    scope_id    TEXT NOT NULL DEFAULT '',          -- the paper ("doi:10.…", "pmcid:PMC…") or the repository ("github.com/o/r")
    granted_by  TEXT NOT NULL,                     -- 'system' (an automatic verification) or the granting user's id
    granted_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, role, scope_kind, scope_id),
    CHECK ((scope_kind = '') = (scope_id = '')),
    CHECK (role != 'verified_author' OR scope_kind = 'paper'),
    CHECK (role != 'maintainer' OR scope_kind = 'repo')
) WITHOUT ROWID;
-- No index: the Worker reads a user's roles by the key's prefix. "The verified authors of a
-- paper" (Phase 6) will need (scope_kind, scope_id): its index comes with the query.

-- A request to be recognized as an author of a paper or a maintainer of a repository: verified
-- automatically when the evidence allows it, otherwise pending, for the moderators (Phase 7).
CREATE TABLE claims (
    id          INTEGER PRIMARY KEY,               -- the rowid
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('author', 'maintainer')),
    paper_id    TEXT NOT NULL DEFAULT '',          -- kind 'author'
    repo        TEXT NOT NULL DEFAULT '',          -- kind 'maintainer'
    evidence    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence)),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
    created_at  INTEGER NOT NULL,
    decided_by  TEXT NOT NULL DEFAULT '',          -- 'system', a moderator's user id; '' while pending
    decided_at  INTEGER,
    CHECK ((kind = 'author' AND paper_id != '' AND repo = '') OR (kind = 'maintainer' AND repo != '' AND paper_id = ''))
);
-- One claim per user and target (a new request updates it), and the account page's list of a
-- user's claims. One more row written when a claim is created; none when only its status changes.
CREATE UNIQUE INDEX claims_user_target ON claims(user_id, kind, paper_id, repo);

-- The facts, pushed by the Mac (oscr/community.py), never written by the Worker.

-- The ORCID iDs of the authors of the papers that have a page (decisions D2 and D7), as the
-- papers' metadata gives them. A signed-in ORCID iD found here makes a verified author of that
-- paper. Read by ORCID iD, the key's prefix: no index. `slug` and `title` let the account page
-- link to the paper's page.
CREATE TABLE paper_orcid (
    orcid     TEXT NOT NULL,                       -- "0000-0002-1825-0097"
    paper_id  TEXT NOT NULL,                       -- the Mac's paper id: "doi:10.…", "pmcid:PMC…"
    slug      TEXT NOT NULL,                       -- its page: /paper/<slug>/
    title     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (orcid, paper_id)
) WITHOUT ROWID;

-- The owners of the code repositories of those papers, on the forges whose addresses name an
-- owner (github.com/<owner>/<name>, gitlab.com/<group>/…). Read by repository, the key.
CREATE TABLE repo_owner (
    repo   TEXT PRIMARY KEY,                       -- the Mac's normalized key: "github.com/owner/name"
    host   TEXT NOT NULL,                          -- "github.com"
    owner  TEXT NOT NULL                           -- "owner", lowercased as in the key
) WITHOUT ROWID;
