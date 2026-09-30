-- Data rights (2026-09-29, the page /data-rights/, oscr/rights.py): the authors whose contact details
-- the registry must never collect again, one who asked for their erasure, or objected to their
-- keeping. contacts.write drops what matches before it stores a paper's rows, and contacts.table
-- (the rows of the private dataset) drops it too. Private: catalog.public_db drops this table.
--
-- `kind` 'orcid': the ORCID iD itself (public: the one way to recognize the person in a paper's
-- metadata); 'email': the SHA-256 of an address found with that iD (contacts.email_digest), never
-- the address. `request`: the request that asked ("remote:12", the D1 target and rights.id), or
-- 'owner'. `published_at`: when the private dataset on Hugging Face was published again without them,
-- its history rewritten (contacts.publish); NULL until then.
CREATE TABLE IF NOT EXISTS contact_suppressed (
    kind          TEXT NOT NULL CHECK (kind IN ('orcid', 'email')),
    value         TEXT NOT NULL,
    since         REAL NOT NULL,
    request       TEXT NOT NULL DEFAULT '',
    published_at  REAL,
    PRIMARY KEY (kind, value)
);
