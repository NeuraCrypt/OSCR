-- The authors' contact details (owner's decision of 2026-09-27): email, given and family
-- names, organization, address and affiliation of each author of a paper, as published in
-- the paper itself (JATS) and in its Europe PMC record. PRIVATE: kept on the Mac and sent
-- only to the private Hugging Face dataset OpenScientificCodeRegistry/Private
-- (oscr/contacts.py refuses a dataset that is not private); never displayed, never in a
-- public output (catalog.public_db drops this table).
CREATE TABLE IF NOT EXISTS contact (
    article_id     TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL DEFAULT 0,   -- the author's rank on the paper; 0: an address no author claims
    email          TEXT NOT NULL DEFAULT '',
    given          TEXT NOT NULL DEFAULT '',
    family         TEXT NOT NULL DEFAULT '',
    name           TEXT NOT NULL DEFAULT '',
    orcid          TEXT NOT NULL DEFAULT '',
    organization   TEXT NOT NULL DEFAULT '',
    address        TEXT NOT NULL DEFAULT '',
    affiliation    TEXT NOT NULL DEFAULT '',
    corresponding  INTEGER NOT NULL DEFAULT 0,
    source         TEXT NOT NULL DEFAULT '',     -- jats | epmc | jats+epmc
    found_at       REAL NOT NULL,
    PRIMARY KEY (article_id, position, email)
);
CREATE INDEX IF NOT EXISTS contact_email ON contact(email);
CREATE INDEX IF NOT EXISTS contact_orcid ON contact(orcid);
