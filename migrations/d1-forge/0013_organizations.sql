-- The forge database, part 13: organizations, teams, roles, the audit log, and account security
-- (night phase 09). See docs/ORGANIZATIONS.md, docs/ACCOUNTS.md, docs/FORGE.md and D09-*.
--
-- Every table here is written by the Worker (service/organizations.ts, members.ts, audit.ts,
-- account-security.ts, webauthn.ts), gated by FORGE_OPEN (owner only until phase 16), and counted
-- against the forge service's daily row share. The Mac never reads or writes these tables; the facts
-- push never exports them.
--
-- What they never hold: no email address (every text that could carry one is CHECKed for '@'), no
-- token, no secret, no password, no private key, no user code. A passkey keeps only a PUBLIC key.
-- A lab's GitHub organization is LINKED, not replaced: git rights on its repositories stay GitHub's;
-- these tables carry OSCR's own layer only.
--
-- Private membership and the members-only README are PRIVATE by construction: they are never put in
-- a public output, the static layer, the search, a feed or a webhook, and a read of them is refused
-- to anyone who is not a member (service/organizations.ts, members.ts).
--
-- Times are Unix seconds; a day is at / 86400. WITHOUT ROWID where the key is text; a secondary index
-- exists only where a read would otherwise scan, and says why and what it costs.

-- An organization (a lab, a group, a department, an institution, a project). Keyed by a random id;
-- the handle (a lowercased slug) is its public address /org/<handle>/, unique through its one index.
CREATE TABLE organizations (
    id              TEXT PRIMARY KEY,                 -- "o_" + 16 base64url
    handle          TEXT NOT NULL CHECK (length(handle) BETWEEN 1 AND 39 AND handle NOT GLOB '*[^a-z0-9-]*'),
    display_name    TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 100 AND instr(display_name, '@') = 0),
    kind            TEXT NOT NULL DEFAULT 'lab' CHECK (kind IN ('lab', 'group', 'department', 'institution', 'project', 'other')),
    ror             TEXT NOT NULL DEFAULT '' CHECK (length(ror) <= 40 AND instr(ror, '@') = 0),
    bio             TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 2000 AND instr(bio, '@') = 0),
    readme_public   TEXT NOT NULL DEFAULT '' CHECK (length(readme_public) <= 16384),
    readme_members  TEXT NOT NULL DEFAULT '' CHECK (length(readme_members) <= 16384),
    picture         TEXT NOT NULL DEFAULT '' CHECK (length(picture) <= 300 AND instr(picture, '@') = 0),
    banner          TEXT NOT NULL DEFAULT '' CHECK (length(banner) <= 500 AND instr(banner, '@') = 0),
    pinned          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(pinned) AND length(pinned) <= 2000),
    domain          TEXT NOT NULL DEFAULT '' CHECK (length(domain) <= 253 AND instr(domain, '@') = 0),
    domain_proof    TEXT NOT NULL DEFAULT '' CHECK (length(domain_proof) <= 80),
    domain_verified INTEGER NOT NULL DEFAULT 0 CHECK (domain_verified IN (0, 1)),
    members_private INTEGER NOT NULL DEFAULT 0 CHECK (members_private IN (0, 1)),
    state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
    created_by      TEXT NOT NULL,                    -- oscr_community users.id: never answered
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
) WITHOUT ROWID;
-- The page /org/<handle>/ resolves the handle; a create checks it is free. One index, one more row
-- written per organization created or renamed (a few, rarely).
CREATE UNIQUE INDEX organizations_handle ON organizations(handle);

-- Membership: a person's role in an organization and their research permissions. A key range per
-- organization (the member list), and, through its index, a person's organizations.
CREATE TABLE org_members (
    org_id    TEXT NOT NULL,
    user_id   TEXT NOT NULL,                          -- oscr_community users.id
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
    private   INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),   -- this member's own visibility
    perms     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(perms) AND length(perms) <= 500),
    added_by  TEXT NOT NULL DEFAULT '',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, user_id)
) WITHOUT ROWID;
-- A person's organizations (the account page, and the permission checks of routes on an org's
-- repository). One more row written per membership change.
CREATE INDEX org_members_user ON org_members(user_id);

-- An invitation to join, with an expiry. A key range per organization; through its index, a
-- person's pending invitations.
CREATE TABLE org_invitations (
    org_id     TEXT NOT NULL,
    id         TEXT NOT NULL,                         -- random 12 base64url within the organization
    invitee    TEXT NOT NULL,                         -- oscr_community users.id invited
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
    perms      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(perms) AND length(perms) <= 500),
    state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    invited_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, id)
) WITHOUT ROWID;
-- A person's invitations (the account page). One more row written per invitation.
CREATE INDEX org_invitations_invitee ON org_invitations(invitee);

-- A team within an organization (visibility, nesting). A key range per organization.
CREATE TABLE teams (
    org_id      TEXT NOT NULL,
    id          TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 39 AND id NOT GLOB '*[^a-z0-9-]*'),
    name        TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 100 AND instr(name, '@') = 0),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500 AND instr(description, '@') = 0),
    visibility  TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible', 'secret')),
    parent      TEXT NOT NULL DEFAULT '',             -- a team id within the organization, '' at the top
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (org_id, id)
) WITHOUT ROWID;

-- A team's members and their team role. A key range per team (within the organization).
CREATE TABLE team_members (
    org_id    TEXT NOT NULL,
    team_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    team_role TEXT NOT NULL DEFAULT 'member' CHECK (team_role IN ('maintainer', 'member')),
    added_at  INTEGER NOT NULL,
    PRIMARY KEY (org_id, team_id, user_id)
) WITHOUT ROWID;

-- The audit log of OSCR's actions on an organization (phase 01's action log, per organization): one
-- row per org-scoped write, written in the same batch as its action row. Read as a key range
-- (org_id), newest first (the index walked backward on `at`): never a scan. `actor` is a handle, never
-- an id that answers; `detail` is a small JSON of what changed, with no email address.
CREATE TABLE org_audit (
    org_id  TEXT NOT NULL,
    at      INTEGER NOT NULL,
    nonce   TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 64),
    actor   TEXT NOT NULL DEFAULT '' CHECK (length(actor) <= 100 AND instr(actor, '@') = 0),
    event   TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 60),
    target  TEXT NOT NULL DEFAULT '' CHECK (length(target) <= 200 AND instr(target, '@') = 0),
    detail  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 2000),
    PRIMARY KEY (org_id, at, nonce)
) WITHOUT ROWID;

-- A passkey / security key (WebAuthn), for sudo mode (a step up while already signed in): the Worker
-- verifies an assertion with WebCrypto only. Only the PUBLIC key is kept (a COSE key as JSON), never a
-- private key, never a secret. A key range per account (the owner is the signed-in person, so an
-- assertion is looked up by (user_id, cred_id): never a scan, no index).
CREATE TABLE webauthn_credentials (
    user_id    TEXT NOT NULL,                         -- oscr_community users.id
    cred_id    TEXT NOT NULL CHECK (length(cred_id) BETWEEN 1 AND 400),   -- base64url of the credential id
    cose       TEXT NOT NULL CHECK (length(cose) <= 2000),                -- the COSE public key as JSON (x, y or n, e); no private material
    alg        INTEGER NOT NULL CHECK (alg IN (-7, -257)),                 -- COSE: -7 ES256, -257 RS256
    sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
    label      TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 60 AND instr(label, '@') = 0),
    transports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports) AND length(transports) <= 200),
    backed_up  INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
    created_at INTEGER NOT NULL,
    last_used  INTEGER,
    PRIMARY KEY (user_id, cred_id)
) WITHOUT ROWID;

-- The personal security log (passkey added or removed, a session revoked, an identity unlinked, sudo
-- entered). A key range per account, newest first. `detail` is a small JSON with no email address.
CREATE TABLE security_log (
    user_id TEXT NOT NULL,
    at      INTEGER NOT NULL,
    nonce   TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 64),
    event   TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 60),
    detail  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 1000),
    PRIMARY KEY (user_id, at, nonce)
) WITHOUT ROWID;

-- Sudo mode: a short-lived marker that this session re-authenticated recently (a passkey assertion).
-- Keyed by the session's SHA-256 (the same hash the session cookie carries): a key read, never a scan.
CREATE TABLE sudo_sessions (
    session_hash TEXT PRIMARY KEY,                    -- hex SHA-256 of the session cookie's id
    user_id      TEXT NOT NULL,
    until        INTEGER NOT NULL
) WITHOUT ROWID;

-- `actions` rebuilt with phase 09's kinds (types.ts ACTION_KINDS, RESEARCH_KINDS, SOCIAL_KINDS,
-- AUTOMATION_KINDS, MODERATION_KINDS, SECURITY_KINDS, then ORG_KINDS, in order).
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
                     'advisory_edit', 'org', 'member', 'team', 'passkey', 'session', 'identity')),
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
