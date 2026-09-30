-- Phase 1, OpenAlex (oscr/sources/openalex.py): each paper's OpenAlex work, looked up by its DOI
-- (a free call), and what only OpenAlex knows, the institutions of the authors (ROR ids,
-- countries), the open-access status, a linked preprint, the topics, the referenced and
-- related works. What OpenAlex adds to fields the paper's own text or Europe PMC already fill
-- (ORCID iDs, corresponding authors, funders, citation count…) goes into the existing tables,
-- only where they said nothing, with `field_provenance` source 'openalex'.

-- The OpenAlex work of a paper, in OSCR's shapes (openalex.parse), without its lists of works
-- (in paper_work). 'missing': OpenAlex did not know the paper when asked (`checked_at`); a new
-- paper appears there a few days after its publication, so it is asked again a week later.
CREATE TABLE IF NOT EXISTS openalex_record (
    article_id   TEXT PRIMARY KEY REFERENCES article(id) ON DELETE CASCADE,
    openalex_id  TEXT NOT NULL DEFAULT '',          -- W4412991288
    status       TEXT NOT NULL CHECK (status IN ('found', 'missing')),
    json         TEXT NOT NULL DEFAULT '',
    fetched_at   REAL NOT NULL,                     -- when this record was received
    checked_at   REAL NOT NULL                      -- when OpenAlex was last asked
);
CREATE INDEX IF NOT EXISTS openalex_record_status ON openalex_record(status, checked_at);

ALTER TABLE article ADD COLUMN openalex_id   TEXT NOT NULL DEFAULT '';
-- OpenAlex's (Unpaywall's) open-access status: diamond | gold | hybrid | bronze | green | closed.
ALTER TABLE article ADD COLUMN oa_status     TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN oa_url        TEXT NOT NULL DEFAULT '';
-- A preprint of the paper: doi:10.1101/2024.11.06.621353, arxiv:2101.00001, osf.io/5fehs.
ALTER TABLE article ADD COLUMN preprint_id   TEXT NOT NULL DEFAULT '';
ALTER TABLE article ADD COLUMN preprint_url  TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS article_openalex ON article(openalex_id);

-- An author's OpenAlex id on a paper (A5083456461): OpenAlex's own disambiguation, kept as a
-- fact; a person is still merged across papers by ORCID iD only.
ALTER TABLE paper_author ADD COLUMN openalex_id TEXT NOT NULL DEFAULT '';
ALTER TABLE author ADD COLUMN openalex_id TEXT NOT NULL DEFAULT '';

-- An institution, by ROR id (bare: 00pd74e08), as OpenAlex names it. paper_author.ror lists an
-- author's; each element is a ROR id, or {"id": ROR id, "aff": the index of the affiliation it
-- is in the author's list, or null}.
CREATE TABLE IF NOT EXISTS institution (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    country      TEXT NOT NULL DEFAULT '',          -- ISO 3166-1 alpha-2
    type         TEXT NOT NULL DEFAULT '',          -- education | healthcare | facility | company …
    openalex_id  TEXT NOT NULL DEFAULT ''
);

-- OpenAlex's topics (T10581), with their subfield, field and domain.
CREATE TABLE IF NOT EXISTS topic (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    subfield_id  TEXT NOT NULL DEFAULT '',
    subfield     TEXT NOT NULL DEFAULT '',
    field_id     TEXT NOT NULL DEFAULT '',
    field        TEXT NOT NULL DEFAULT '',
    domain_id    TEXT NOT NULL DEFAULT '',
    domain       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS paper_topic (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    topic_id    TEXT NOT NULL,
    score       REAL,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (article_id, topic_id)
);
CREATE INDEX IF NOT EXISTS paper_topic_topic ON paper_topic(topic_id);

-- The works a paper cites, and those OpenAlex calls related, by OpenAlex id. The paper's own
-- references with their DOIs stay in paper_reference (JATS).
CREATE TABLE IF NOT EXISTS paper_work (
    article_id  TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    relation    TEXT NOT NULL CHECK (relation IN ('referenced', 'related')),
    work_id     TEXT NOT NULL,
    position    INTEGER NOT NULL,
    PRIMARY KEY (article_id, relation, work_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS paper_work_work ON paper_work(work_id);
