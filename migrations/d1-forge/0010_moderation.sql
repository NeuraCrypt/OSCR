-- The forge database, part 10: content, abuse and rules (night phase 16). See docs/MODERATION.md,
-- docs/POLICIES.md and docs/DECISIONS.md D16-*.
--
-- - `content_reports`: what anyone reports of the GitHub side as the registry shows it (a person, a
--   repository, a research issue or comment, a GitHub issue, pull request or release, a star list, a
--   commit status; a snippet once phase 13 builds them), with or without an account, behind
--   Turnstile. The owner reads the open ones in the moderation queue (/moderation/).
-- - `moderation`: what the owner (or, for known malware, the registry itself) hid, and why: one row
--   per hidden thing, kept once restored for the record and the public notice; a person's appeal or
--   counter-notice rides on the row it answers.
-- - `blocks`: who a person blocked (silent: the blocked person is never told).
-- - `interaction_limits`: a repository's or an account's limit on who may interact, until a time.
-- - `rights_requests`: a person's request to exercise a data right (access, portability,
--   rectification, erasure, objection), answered in the site.
-- - `research_comments` rebuilt with the hide reason 'low-quality' (GitHub's seventh).
-- - `actions` rebuilt with the kinds `report`, `moderate`, `appeal`, `block`, `limit`, `rights`
--   (types.ts MODERATION_KINDS), so that the per-account caps and the day's rows count these writes.
--
-- What each write costs (D08-18: the GitHub side is at its 5,000-row cap; this phase's share is ~200
-- rows a day, PLATFORM_PLAN §15.4):
-- - a report: its row, its entry in the open reports' index, the action row (3);
-- - a decision of the owner: the moderation row and its person's index entry (2), the reports it
--   closes (1 each, their open entries dropped: 2 each), the action row (1); hiding an account also
--   pauses its webhooks and revokes its tokens (1 each: a few);
-- - an appeal: the moderation row changed (1), its entry in the queue (a `content_reports` row and its
--   open entry: 2), the action row (1);
-- - a block or an unblock: its row and the action row (2); an interaction limit: 2;
-- - a data-rights request: its row, its entry in the open requests' index, the action row (3).
--
-- One index at most per table, as in every migration of oscr_forge (tests/test_forge_schema.py): a
-- person's own rows are found by the key's prefix, the owner's queues by one partial index each.
--
-- What it never holds: no email address (every text is masked before it is written, and the CHECKs
-- refuse an at sign), no IP address, no token. A reporter without an account is '' and nothing else.
--
-- Times are Unix seconds; a day is the UTC day number, `at / 86400`.

-- A report. `target` is the thing as the pages name it (moderation-core.ts `readTarget`): "person:github:<id>",
-- "person:orcid:<iD>", "repo:<forge>:<id>", "research:<n>", "research:<n>#<c>" (a comment),
-- "issue:<forge>:<repo id>#<n>", "pull:<forge>:<repo id>#<n>", "release:<forge>:<repo id>/<tag>",
-- "list:<person>/<list id>" (the person as "github:<id>" or "orcid:<iD>"), "status:<forge>:<repo id>:<sha>:<context>", "snippet:<id>". `label` is the words the
-- queue shows (a title, a handle), masked.
CREATE TABLE content_reports (
    id          INTEGER PRIMARY KEY,               -- the rowid: the report's number
    day         INTEGER NOT NULL,                  -- at / 86400
    at          INTEGER NOT NULL,
    reporter    TEXT NOT NULL DEFAULT '',          -- oscr_community users.id, '' without an account: never answered
    kind        TEXT NOT NULL CHECK (kind IN ('person', 'repo', 'research', 'comment', 'issue', 'pull', 'release', 'list', 'status', 'snippet')),
    -- An appeal of a decision, or a counter-notice to a copyright takedown, waits in the same queue:
    -- its reason says so, its target is the decision's, its details the person's words.
    target      TEXT NOT NULL CHECK (length(target) BETWEEN 5 AND 400 AND instr(target, '@') = 0),
    label       TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200 AND instr(label, '@') = 0),
    reason      TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'private_information', 'malware', 'copyright',
                                                'impersonation', 'misinformation', 'unlawful', 'other',
                                                'appeal', 'counter_notice')),
    details     TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000 AND instr(details, '@') = 0),
    state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'actioned', 'dismissed')),
    decided_at  INTEGER,
    CHECK (day = CAST(at / 86400 AS INTEGER)),
    CHECK ((state = 'open') = (decided_at IS NULL))
);
-- The moderation queue: the open reports of the last year, by day (a range, never a scan), and those
-- of one target when a decision closes them. Only open reports are in it: one more row written when a
-- report is made, one when it is decided (it leaves the index).
CREATE INDEX content_reports_open ON content_reports(day, id) WHERE state = 'open';

-- What is hidden, keyed by (kind, ref), the reference a read looks it up by:
--   account   the account's users.id              (target "person:github:<id>" or "person:orcid:<iD>")
--   github    a hidden account's GitHub numeric id (its GitHub events, from webhooks; written with it)
--   repo      "<forge>:<repo id>"                  (target "repo:<forge>:<id>")
--   research  "<n>"                                (target "research:<n>")
--   comment   "<n>#<c>"                            (target "research:<n>#<c>")
--   issue     "<forge>:<repo id>#<n>"              (a GitHub issue the registry shows)
--   pull      "<forge>:<repo id>#<n>"
--   release   "<forge>:<repo id>/<tag>"
--   profile   the account's users.id               (the profile's words only, not the account)
--   list      "<users.id>/<list id>"
--   status    "<forge>:<repo id>:<sha>:<context>"
-- `state` 'restored' keeps the row (its notice says it was restored). `owner_user` is the person the
-- thing is theirs (their page "What of mine is hidden", their appeal): never answered.
CREATE TABLE moderation (
    kind         TEXT NOT NULL CHECK (kind IN ('account', 'github', 'repo', 'research', 'comment', 'issue', 'pull',
                                               'release', 'profile', 'list', 'status')),
    ref          TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 400),
    target       TEXT NOT NULL CHECK (length(target) BETWEEN 5 AND 400 AND instr(target, '@') = 0),
    label        TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200 AND instr(label, '@') = 0),
    state        TEXT NOT NULL CHECK (state IN ('hidden', 'restored')),
    reason       TEXT NOT NULL CHECK (reason IN ('spam', 'abuse', 'private_information', 'malware', 'copyright',
                                                 'impersonation', 'misinformation', 'unlawful', 'low_quality', 'other')),
    -- Public, redacted words for the notices page (/notices/): what was done and why, never who
    -- asked, never the hidden words themselves.
    notice       TEXT NOT NULL DEFAULT '' CHECK (length(notice) <= 1000 AND instr(notice, '@') = 0),
    -- The owner's words for the person whose thing it is, shown on their page (never sent).
    message      TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 1000 AND instr(message, '@') = 0),
    owner_user   TEXT NOT NULL DEFAULT '',
    by_whom      TEXT NOT NULL CHECK (by_whom IN ('owner', 'moderator', 'registry')),
    report_id    INTEGER,
    -- The person's answer: an appeal, or a counter-notice to a copyright takedown (with its statements).
    appeal       TEXT NOT NULL DEFAULT '' CHECK (appeal IN ('', 'open', 'accepted', 'rejected')),
    appeal_kind  TEXT NOT NULL DEFAULT '' CHECK (appeal_kind IN ('', 'appeal', 'counter_notice')),
    appeal_text  TEXT NOT NULL DEFAULT '' CHECK (length(appeal_text) <= 2000 AND instr(appeal_text, '@') = 0),
    appeal_at    INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (kind, ref),
    CHECK ((appeal = '') = (appeal_kind = '')),
    CHECK (appeal = '' OR appeal_at IS NOT NULL)
) WITHOUT ROWID;
-- A person's hidden things (their page): one more row written when a row is made. The open appeals
-- wait in the reports' queue (`content_reports`, reason 'appeal' or 'counter_notice').
CREATE INDEX moderation_owner ON moderation(owner_user) WHERE owner_user != '';

-- A block: `user_id` blocked `blocked` (both users.id, never answered). `blocked_github` is the blocked
-- account's GitHub numeric id when it has one, so that its GitHub events (from webhooks) leave the
-- blocker's inbox too. `ref` names the block on the blocker's page (the person's "github:<id>" or
-- "orcid:<iD>", or a random "anon:…" for an account without a public handle); `label` is how the
-- blocked person was named when blocked (a login, an ORCID iD, a name); `note` the blocker's own words.
CREATE TABLE blocks (
    user_id         TEXT NOT NULL,
    blocked         TEXT NOT NULL,
    ref             TEXT NOT NULL CHECK (length(ref) BETWEEN 5 AND 40 AND instr(ref, '@') = 0),
    blocked_github  TEXT NOT NULL DEFAULT '' CHECK (blocked_github NOT GLOB '*[^0-9]*'),
    label           TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100 AND instr(label, '@') = 0),
    note            TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 300 AND instr(note, '@') = 0),
    at              INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked),
    CHECK (user_id != blocked)
) WITHOUT ROWID;

-- An interaction limit, until a time: on one repository ("repo:<forge>:<id>"), or on every repository an
-- account manages ("account:<users.id>"). `level` says who may still interact: 'existing_users'
-- (accounts older than 24 hours), 'contributors' (the papers' verified authors, the code's maintainers
-- and the people who manage the repository), 'managers' (only the people who manage it). The stricter
-- of a repository's and its managers' accounts' limits applies.
CREATE TABLE interaction_limits (
    scope    TEXT NOT NULL CHECK (length(scope) BETWEEN 6 AND 120 AND (substr(scope, 1, 5) = 'repo:' OR substr(scope, 1, 8) = 'account:')),
    level    TEXT NOT NULL CHECK (level IN ('existing_users', 'contributors', 'managers')),
    until    INTEGER NOT NULL,
    by_user  TEXT NOT NULL,
    at       INTEGER NOT NULL,
    PRIMARY KEY (scope),
    CHECK (until > at)
) WITHOUT ROWID;

-- A data-rights request (the privacy statement, /data-rights/): signed in, so the account is the proof
-- of identity (ORCID, GitHub or Google); answered in the site, on the person's page, never by email.
CREATE TABLE rights_requests (
    user_id      TEXT NOT NULL,                    -- oscr_community users.id: never answered
    id           TEXT NOT NULL CHECK (length(id) = 12),   -- random: the request's public name
    at           INTEGER NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('access', 'portability', 'rectification', 'erasure', 'objection', 'restriction')),
    details      TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000 AND instr(details, '@') = 0),
    state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'refused')),
    answer       TEXT NOT NULL DEFAULT '' CHECK (length(answer) <= 2000 AND instr(answer, '@') = 0),
    answered_at  INTEGER,
    PRIMARY KEY (user_id, id),
    CHECK ((state = 'open') = (answered_at IS NULL))
) WITHOUT ROWID;
-- The owner's queue (the open ones, by time; answered by (at, id)): one more row when a request is
-- made, one when it is answered. A person's own requests are the key's prefix.
CREATE INDEX rights_requests_open ON rights_requests(at, id) WHERE state = 'open';

-- `research_comments` rebuilt with GitHub's seventh reason to hide a comment, 'low_quality' (a
-- maintainer's hide, phase 05's research.ts; the owner's moderation is the `moderation` table's).
CREATE TABLE research_comments_next (
    issue_id     INTEGER NOT NULL,
    n            INTEGER NOT NULL CHECK (n BETWEEN 1 AND 2500),
    author_id    TEXT NOT NULL,
    author       TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via   TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    author_role  TEXT NOT NULL DEFAULT '' CHECK (author_role IN ('', 'verified_author', 'maintainer')),
    body         TEXT NOT NULL CHECK (length(body) <= 65536),
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    hidden       TEXT NOT NULL DEFAULT '' CHECK (hidden IN ('', 'spam', 'abuse', 'off-topic', 'outdated', 'duplicate', 'resolved', 'low-quality')),
    PRIMARY KEY (issue_id, n),
    CHECK (deleted = 0 OR body = '')
) WITHOUT ROWID;

INSERT INTO research_comments_next SELECT issue_id, n, author_id, author, author_via, author_role, body, created_at, edited_at, deleted, hidden
    FROM research_comments;

DROP TABLE research_comments;

ALTER TABLE research_comments_next RENAME TO research_comments;

-- `actions` rebuilt with the moderation kinds (types.ts ACTION_KINDS, RESEARCH_KINDS, SOCIAL_KINDS,
-- AUTOMATION_KINDS, then MODERATION_KINDS, in order). A report made without an account has
-- `user_id` '': the day's anonymous reports are one key range.
CREATE TABLE actions_next (
    day          INTEGER NOT NULL,                 -- at / 86400
    user_id      TEXT NOT NULL,                    -- oscr_community users.id ('' for a report without an account)
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
                     'limit', 'rights')),
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
