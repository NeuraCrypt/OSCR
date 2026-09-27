-- Phase 1: the paper's bibliographic record, its people, money, references, notices and
-- categories; what a repository holds (features, tools) and the history of its checks;
-- where every enriched value came from, and each record's versions. See
-- docs/PLATFORM_PLAN.md §4. The Mac keeps everything; Cloudflare D1 gets a projection.

ALTER TABLE article ADD COLUMN type              TEXT NOT NULL DEFAULT '';   -- JATS article-type
ALTER TABLE article ADD COLUMN language          TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN abstract          TEXT NOT NULL DEFAULT '';   -- private: article text
ALTER TABLE article ADD COLUMN volume            TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN issue             TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN pages             TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN journal_id        TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN received          TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN accepted          TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN published_online  TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN published_print   TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN cited_by_count    INTEGER;
ALTER TABLE article ADD COLUMN is_open_access    INTEGER;
ALTER TABLE article ADD COLUMN references_count  INTEGER;
-- 'yes' | 'no' | '' (not classified): an off-topic paper stays on the Mac, out of the site
-- and of the statistics (owner's decision D7).
ALTER TABLE article ADD COLUMN on_topic          TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN enriched_at       REAL;
ALTER TABLE article ADD COLUMN classified_at     REAL;

CREATE INDEX IF NOT EXISTS article_type ON article(type);
CREATE INDEX IF NOT EXISTS article_on_topic ON article(on_topic);
CREATE INDEX IF NOT EXISTS article_journal ON article(journal_id);

-- The Europe PMC `core` result of a paper, as received: every pass gets it, now it is kept.
CREATE TABLE IF NOT EXISTS epmc_record (
    article_id  TEXT PRIMARY KEY REFERENCES article(id) ON DELETE CASCADE,
    json        TEXT NOT NULL,
    fetched_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
    id         TEXT PRIMARY KEY,          -- issn:XXXX-XXXX, else title:<normalized title>
    title      TEXT NOT NULL DEFAULT '',
    issn       TEXT NOT NULL DEFAULT '',
    eissn      TEXT NOT NULL DEFAULT '',
    publisher  TEXT NOT NULL DEFAULT '',
    nlm_ta     TEXT NOT NULL DEFAULT ''
);

-- A person is only merged across papers by ORCID; otherwise it stays a name on a paper.
CREATE TABLE IF NOT EXISTS author (
    orcid  TEXT PRIMARY KEY,
    name   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS paper_author (
    article_id     TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,
    name           TEXT NOT NULL DEFAULT '',
    given          TEXT NOT NULL DEFAULT '',
    family         TEXT NOT NULL DEFAULT '',
    orcid          TEXT NOT NULL DEFAULT '',
    corresponding  INTEGER NOT NULL DEFAULT 0,  -- the name only: never an email address
    affiliations   TEXT NOT NULL DEFAULT '[]',
    ror            TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (article_id, position)
);
CREATE INDEX IF NOT EXISTS paper_author_orcid ON paper_author(orcid);

CREATE TABLE IF NOT EXISTS funder (
    id    TEXT PRIMARY KEY,               -- the Crossref Funder / ROR id, else name:<normalized name>
    name  TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS grant_award (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    funder_id   TEXT NOT NULL,
    award       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (article_id, funder_id, award)
);
CREATE INDEX IF NOT EXISTS grant_award_funder ON grant_award(funder_id);

-- Keywords, MeSH terms and the journal's subject headings of a paper.
CREATE TABLE IF NOT EXISTS paper_subject (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    scheme      TEXT NOT NULL,             -- keyword | mesh | subject
    term        TEXT NOT NULL,
    major       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (article_id, scheme, term)
);
CREATE INDEX IF NOT EXISTS paper_subject_term ON paper_subject(scheme, term);

CREATE TABLE IF NOT EXISTS paper_reference (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    doi         TEXT NOT NULL DEFAULT '',
    pmid        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (article_id, position)
);
CREATE INDEX IF NOT EXISTS paper_reference_doi ON paper_reference(doi);

CREATE TABLE IF NOT EXISTS paper_rrid (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    rrid        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (article_id, rrid)
);

-- The code / data availability statements, private: published in full only under an open
-- license (owner's decision D1).
CREATE TABLE IF NOT EXISTS statement (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,             -- code | data | code_and_data
    title       TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (article_id, kind, title)
);

-- Retractions, corrections, expressions of concern.
CREATE TABLE IF NOT EXISTS integrity_notice (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,             -- retraction | correction | concern | reinstatement | comment
    notice_id   TEXT NOT NULL DEFAULT '',  -- the notice's DOI, else its record id
    source      TEXT NOT NULL DEFAULT '',  -- epmc | retraction-watch
    date        TEXT NOT NULL DEFAULT '',
    reasons     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (article_id, kind, notice_id)
);

-- Datasets cited by a paper (OpenNeuro, DANDI, NeuroVault, OSF, figshare, Zenodo, GIN…).
CREATE TABLE IF NOT EXISTS dataset (
    id          TEXT PRIMARY KEY,          -- the normalized link key: openneuro:ds000117, dandi:000001…
    repository  TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    license     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS paper_dataset (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    dataset_id  TEXT NOT NULL REFERENCES dataset(id),
    relation    TEXT NOT NULL DEFAULT 'cited',
    found_by    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (article_id, dataset_id)
);

-- What a repository holds, from its file list and its stored scripts.
CREATE TABLE IF NOT EXISTS repo_feature (
    repo              TEXT PRIMARY KEY REFERENCES repository(repo) ON DELETE CASCADE,
    n_notebooks       INTEGER,
    has_readme        INTEGER,
    has_citation_cff  INTEGER,
    has_license_file  INTEGER,
    env_files         TEXT NOT NULL DEFAULT '[]',
    has_tests         INTEGER,
    has_ci            INTEGER,
    has_docs          INTEGER,
    data_like         REAL,
    computed_at       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tool (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT '',
    languages  TEXT NOT NULL DEFAULT '[]',
    homepage   TEXT NOT NULL DEFAULT '',
    rrid       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS repo_tool (
    repo      TEXT NOT NULL REFERENCES repository(repo) ON DELETE CASCADE,
    tool_id   TEXT NOT NULL,
    evidence  INTEGER NOT NULL DEFAULT 0,
    via       TEXT NOT NULL DEFAULT '',
    examples  TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (repo, tool_id)
);
CREATE INDEX IF NOT EXISTS repo_tool_tool ON repo_tool(tool_id);

-- Every verification of a repository, not only the last one.
CREATE TABLE IF NOT EXISTS alive_check (
    repo         TEXT NOT NULL,
    checked_at   REAL NOT NULL,
    state        TEXT NOT NULL,
    http_status  INTEGER,
    error        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (repo, checked_at)
);

-- Categories (owner's decisions D6 and D7): rules first, a local model for the ambiguous
-- cases, the owner's own labels above both.
CREATE TABLE IF NOT EXISTS paper_category (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    facet       TEXT NOT NULL,             -- on_topic | modality | organism | population | subfield
    value       TEXT NOT NULL,
    confidence  REAL NOT NULL DEFAULT 0,
    method      TEXT NOT NULL DEFAULT 'rule',  -- rule | model:<name> | owner
    reasons     TEXT NOT NULL DEFAULT '[]',
    ambiguous   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (article_id, facet, value, method)
);
CREATE INDEX IF NOT EXISTS paper_category_value ON paper_category(facet, value);

-- Where an enriched value came from, and when.
CREATE TABLE IF NOT EXISTS field_provenance (
    entity      TEXT NOT NULL,             -- article | repository
    entity_id   TEXT NOT NULL,
    field       TEXT NOT NULL,
    source      TEXT NOT NULL,             -- jats | epmc | git | files | rule | model | owner …
    source_ref  TEXT NOT NULL DEFAULT '',
    fetched_at  REAL NOT NULL,
    PRIMARY KEY (entity, entity_id, field)
);

-- Each change of an enriched record, with the whole record and what changed.
CREATE TABLE IF NOT EXISTS version (
    entity      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    created_at  REAL NOT NULL,
    actor       TEXT NOT NULL DEFAULT 'harvester',
    snapshot    TEXT NOT NULL,
    diff        TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (entity, entity_id, version)
);

-- The history starts with the last verification each repository already had.
INSERT OR IGNORE INTO alive_check (repo, checked_at, state, http_status, error)
    SELECT repo, verified_at, state, http_status, error FROM repository WHERE verified_at IS NOT NULL;
