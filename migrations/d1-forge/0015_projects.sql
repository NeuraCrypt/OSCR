-- The forge database, part 15: projects (night phase 06). See docs/DISCUSSIONS.md and
-- docs/DECISIONS.md D06-*.
--
-- Projects are OSCR's own planning boards (D00-6), owned by a person or an organization. Their items
-- are GitHub's issues and pull requests, free-text drafts, and OSCR's own research objects: papers,
-- tracing maps and reproduction reports. Their fields are built-in (title, status), custom (text,
-- number, date, a single choice, an iteration) and RESEARCH (a paper, a map's state, a reproduction's
-- outcome). The action kinds ('project_create', 'project_edit', 'project_item', 'project_field') were
-- added to `actions` by 0014_discussions.sql so that migration rebuilds the table once.
--
-- The row budget (§15.6): projects are the heaviest writer, so a field's value lives in the item row
-- as JSON (a change of one field is one row, not one row per cell), items are capped at 5,000 and
-- fields at 50, and their edits have a per-account cap of their own (caps.ts `project_edits`), out of
-- the 100 authorized actions a day. No email address ever reaches a row (the Worker masks the free
-- text: titles, drafts, readmes).
--
-- Times are Unix seconds.

CREATE TABLE projects (
    id           INTEGER PRIMARY KEY,               -- "project#<id>", one numbering for the registry
    owner        TEXT NOT NULL                      -- "user:<users.id>" (opaque, case-sensitive) or "org:<handle>" (lower case)
                 CHECK (length(owner) BETWEEN 6 AND 260 AND instr(owner, '@') = 0
                        AND (substr(owner, 1, 5) = 'user:' OR substr(owner, 1, 4) = 'org:')),
    number       INTEGER NOT NULL DEFAULT 0 CHECK (number >= 0),  -- the owner's own numbering (set at create)
    title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
    readme       TEXT NOT NULL DEFAULT '' CHECK (length(readme) <= 65536),
    state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    -- The views: [{id, name, layout:'table'|'board'|'roadmap', groupBy, sortBy, filter}]. Up to 12.
    views        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(views) AND json_type(views) = 'array' AND json_array_length(views) <= 12),
    fields_count INTEGER NOT NULL DEFAULT 0 CHECK (fields_count BETWEEN 0 AND 50),
    items_count  INTEGER NOT NULL DEFAULT 0 CHECK (items_count BETWEEN 0 AND 5000),
    author_id    TEXT NOT NULL,                      -- oscr_community users.id: never answered, never exported
    author       TEXT NOT NULL CHECK (length(author) BETWEEN 1 AND 100 AND instr(author, '@') = 0),
    author_via   TEXT NOT NULL CHECK (author_via IN ('github', 'orcid', 'name')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
-- An owner's projects, newest first (one read by the key's prefix): the owner's projects page.
CREATE INDEX projects_owner ON projects(owner, id);

-- A project's fields. `field_id` is a short slug; a built-in field (title, status) is never deleted.
-- Read by the key's prefix (no index). `data_type` carries the research fields.
CREATE TABLE project_fields (
    project_id   INTEGER NOT NULL,
    field_id     TEXT NOT NULL CHECK (length(field_id) BETWEEN 1 AND 50 AND field_id = lower(field_id)),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND instr(name, '@') = 0),
    data_type    TEXT NOT NULL CHECK (data_type IN ('text', 'number', 'date', 'single_select', 'iteration', 'paper', 'map_state', 'repro_outcome')),
    -- A single_select's options, an iteration's iterations: [{id, name, ...}]. Up to 50.
    options      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options) AND json_type(options) = 'array' AND json_array_length(options) <= 50),
    builtin      INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (project_id, field_id)
) WITHOUT ROWID;

-- A project's items. `item_id` is the registry's own id within the project (its count at insert).
-- `ref` names what it is: an issue/pull ("<forge>:<id>#<n>"), a draft (""), a paper ("doi:10.…"), a
-- map ("doi:10.…" with a digest in `values`), a reproduction report ("research#<id>"). The field
-- values live here as JSON ({field_id: value}): a change of one field rewrites this row (1 row), never
-- a row per cell. Read by the key's prefix (no index).
CREATE TABLE project_items (
    project_id   INTEGER NOT NULL,
    item_id      INTEGER NOT NULL CHECK (item_id BETWEEN 1 AND 5000),
    kind         TEXT NOT NULL CHECK (kind IN ('issue', 'pull', 'draft', 'paper', 'map', 'report')),
    ref          TEXT NOT NULL DEFAULT '' CHECK (length(ref) <= 300 AND instr(ref, '@') = 0),
    title        TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 1024),
    body         TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 65536),  -- a draft's text
    field_values TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_values) AND json_type(field_values) = 'object' AND length(field_values) <= 16384),
    archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    position     INTEGER NOT NULL DEFAULT 0,
    added_by     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (project_id, item_id)
) WITHOUT ROWID;
