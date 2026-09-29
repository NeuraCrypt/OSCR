-- The forge database, part 8: stars, follows, events, notifications and profiles (night phase 08). See
-- docs/SOCIAL.md and docs/DECISIONS.md D08-*.
--
-- OSCR's own social layer: OSCR never stars, follows or watches anything on GitHub (the plan's AUP
-- §4). Every row here is a person's own act, made signed in, in the registry, one write at a time
-- (website/worker/forge/service/social.ts, inbox.ts); FORGE_OPEN gates every write, as every write of
-- the GitHub side, until phase 16's content rules.
--
-- What each write costs (the tables are their keys: NO index in this migration):
-- - a star, a follow, a watch level, a list, a list's entry, a profile: its row and the action row
--   (2 rows); unstarring also removes the entry from the person's lists (1 row each);
-- - an event: ONE row, written with the write that caused it (a research issue, an authorized action
--   on a repository without the App) or by the App's webhook (issues, comments, pull requests,
--   releases), with its delivery row (2, D01-24);
-- - a notification's state (read, saved, done, unsubscribed), per thread: 1 row each, and the action
--   row; "mark all as read": 1 row (notice_marks).
--
-- Notifications are fanned out on READ (the plan's §15.6, phase 08): one event row per event, keyed by
-- its subject (a repository or a paper); the inbox is computed when its reader opens it, from the
-- reader's follows (watched repositories and papers, followed threads, people and organizations) and
-- their states. Nothing is written per recipient.
--
-- Counts (stars of a repository, followers of a person) and the public lists are read by the Mac each
-- night and published as static shards (oscr/social.py: /social/NN.json): a signed-out reader asks the
-- Worker nothing, and no count row is ever written.
--
-- What it never holds: no email address (the Worker masks every text before it is stored; a profile's
-- links are https addresses without a user part), no token, no private repository (a repository made
-- private leaves the registry, D00-14: its events are never answered again), nothing of GitHub's
-- private data.
--
-- Times are Unix seconds. `user_id` is oscr_community's users.id: never answered, never exported.

-- A person's star: a repository ("repo:<forge>:<id>"), a paper ("paper:doi:10.…"), a topic
-- ("topic:<name>"); snippets join with phase 13. `label` is what the page showed when the person
-- starred (their own Stars page shows it without reading anything else); the public pages name each
-- subject from the registry's own data, never from a label.
CREATE TABLE stars (
    user_id  TEXT NOT NULL,
    subject  TEXT NOT NULL CHECK (length(subject) BETWEEN 6 AND 220 AND (
                 substr(subject, 1, 5) = 'repo:' OR substr(subject, 1, 13) = 'paper:doi:10.' OR substr(subject, 1, 6) = 'topic:')),
    label    TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 300),
    at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, subject)
) WITHOUT ROWID;

-- A person's star lists (GitHub's "Lists"): at most 32, public or private. A public list can be
-- proposed as a collection; the owner accepts it (`oscr social collections`), and the Mac publishes it
-- on the Explore page.
CREATE TABLE star_lists (
    user_id      TEXT NOT NULL,
    list_id      INTEGER NOT NULL CHECK (list_id BETWEEN 1 AND 32),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 160),
    public       INTEGER NOT NULL DEFAULT 1 CHECK (public IN (0, 1)),
    collection   TEXT NOT NULL DEFAULT '' CHECK (collection IN ('', 'proposed', 'accepted', 'declined')),
    at           INTEGER NOT NULL,
    PRIMARY KEY (user_id, list_id)
) WITHOUT ROWID;

-- A list's entries: a starred subject in a list (the key holds the subject before the list, so that a
-- button reads the lists of one subject by the key's prefix).
CREATE TABLE star_list_items (
    user_id  TEXT NOT NULL,
    subject  TEXT NOT NULL,
    list_id  INTEGER NOT NULL CHECK (list_id BETWEEN 1 AND 32),
    at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, subject, list_id)
) WITHOUT ROWID;

-- What a person follows: a person on GitHub ("github:<numeric id>"), a catalogue author by ORCID iD
-- ("orcid:<iD>", before they have an account), an organization or a person's repositories
-- ("owner:<forge>:<login>"), a repository they watch ("repo:<forge>:<id>", with a level), a paper
-- by DOI ("paper:doi:10.…"), a journal, a tool, a dataset, a category ("journal:<id>" …), or one
-- thread ("thread:<subject>#<thread>": followed on taking part, `auto` = 1, or unsubscribed:
-- level 'ignore').
CREATE TABLE follows (
    user_id  TEXT NOT NULL,
    target   TEXT NOT NULL CHECK (length(target) BETWEEN 5 AND 300),
    level    TEXT NOT NULL DEFAULT 'all' CHECK (level IN ('all', 'participating', 'ignore', 'custom')),
    events   TEXT NOT NULL DEFAULT '' CHECK (length(events) <= 100),   -- custom: "issues pulls releases research"
    label    TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 300),
    auto     INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
    at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, target)
) WITHOUT ROWID;

-- One event, ONE row, keyed by its subject: a repository ("repo:<forge>:<id>") or a paper
-- ("paper:doi:10.…"). `thread` names the conversation ("issue:12", "pull:3", "research:7",
-- "release:v1.0"); `url` is a path of this site (the registry shows everything: GitHub only as a last
-- resort). The actor: their account's id when they acted in the registry (never answered), their
-- GitHub numeric id and login, or the name the registry shows. `mentions`: the GitHub logins the text
-- names ("@login"), lower case, at most 10.
CREATE TABLE events (
    subject        TEXT NOT NULL CHECK (length(subject) BETWEEN 6 AND 220 AND (substr(subject, 1, 5) = 'repo:' OR substr(subject, 1, 13) = 'paper:doi:10.')),
    at             INTEGER NOT NULL,
    nonce          TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 120),     -- the action's nonce, or "delivery:<GitHub's delivery id>"
    kind           TEXT NOT NULL CHECK (kind IN (
                       'issue_opened', 'issue_closed', 'issue_reopened', 'issue_comment', 'pull_opened',
                       'pull_closed', 'pull_merged', 'pull_reopened', 'pull_review', 'pull_comment',
                       'release_published', 'research_opened', 'research_comment', 'research_closed',
                       'research_reopened', 'code_linked', 'release_tied')),
    thread         TEXT NOT NULL DEFAULT '' CHECK (length(thread) <= 120),
    title          TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
    url            TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 300 AND substr(url, 1, 1) = '/' AND substr(url, 1, 2) != '//'),
    repo_path      TEXT NOT NULL DEFAULT '' CHECK (length(repo_path) <= 201),
    paper_id       TEXT NOT NULL DEFAULT '' CHECK (length(paper_id) <= 210),
    actor_user     TEXT NOT NULL DEFAULT '',
    actor_github   TEXT NOT NULL DEFAULT '' CHECK (actor_github NOT GLOB '*[^0-9]*'),
    actor_name     TEXT NOT NULL DEFAULT '' CHECK (length(actor_name) <= 100 AND instr(actor_name, '@') = 0),
    thread_author  TEXT NOT NULL DEFAULT '' CHECK (length(thread_author) <= 80),
    mentions       TEXT NOT NULL DEFAULT '' CHECK (length(mentions) <= 400 AND instr(mentions, '@') = 0),
    PRIMARY KEY (subject, at, nonce)
) WITHOUT ROWID;

-- A notification's state, per person and thread ("<subject>#<thread>"): read (until newer activity),
-- done (until newer activity), saved (kept past the 3 months of retention, with the words it showed).
CREATE TABLE notice_state (
    user_id  TEXT NOT NULL,
    thread   TEXT NOT NULL CHECK (length(thread) BETWEEN 6 AND 342),
    read_at  INTEGER,
    done_at  INTEGER,
    saved    INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0, 1)),
    title    TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
    url      TEXT NOT NULL DEFAULT '' CHECK (url = '' OR (substr(url, 1, 1) = '/' AND substr(url, 1, 2) != '//' AND length(url) <= 300)),
    at       INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread)
) WITHOUT ROWID;

-- "Mark all as read" (everything before `read_before`), and the notification settings (JSON: what
-- the inbox shows by default, the custom filters). One row per person.
CREATE TABLE notice_marks (
    user_id      TEXT PRIMARY KEY,
    read_before  INTEGER NOT NULL DEFAULT 0,
    settings     TEXT NOT NULL DEFAULT '{}' CHECK (length(settings) <= 4000),
    at           INTEGER NOT NULL
) WITHOUT ROWID;

-- A person's profile, written by that person (the ORCID iD and the GitHub login are their account's,
-- never typed here). `private` hides their activity, stars, lists and follows from everyone else.
CREATE TABLE profiles (
    user_id       TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 100 AND instr(name, '@') = 0),
    bio           TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 300),
    pronouns      TEXT NOT NULL DEFAULT '' CHECK (length(pronouns) <= 40),
    location      TEXT NOT NULL DEFAULT '' CHECK (length(location) <= 100),
    timezone      TEXT NOT NULL DEFAULT '' CHECK (length(timezone) <= 64),
    website       TEXT NOT NULL DEFAULT '' CHECK (website = '' OR (substr(website, 1, 8) = 'https://' AND length(website) <= 200)),
    links         TEXT NOT NULL DEFAULT '[]' CHECK (length(links) <= 1000),
    company       TEXT NOT NULL DEFAULT '' CHECK (length(company) <= 100),
    pinned        TEXT NOT NULL DEFAULT '[]' CHECK (length(pinned) <= 1500),
    status        TEXT NOT NULL DEFAULT '' CHECK (length(status) <= 80),
    status_until  INTEGER,
    busy          INTEGER NOT NULL DEFAULT 0 CHECK (busy IN (0, 1)),
    private       INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
    readme        INTEGER NOT NULL DEFAULT 1 CHECK (readme IN (0, 1)),
    at            INTEGER NOT NULL
) WITHOUT ROWID;

-- `actions` rebuilt with the social kinds (types.ts ACTION_KINDS, then RESEARCH_KINDS, then
-- SOCIAL_KINDS, in order) and a `subject`: what the write was about (a starred subject, a followed
-- target, an event's subject). A person's activity is read from their action rows (their key), and an
-- event from its subject, time and nonce (the action's own).
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
                     'profile')),
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

INSERT INTO actions_next (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows)
    SELECT day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows FROM actions;

DROP TABLE actions;

ALTER TABLE actions_next RENAME TO actions;
