-- The forge database, part 11: the command line's sign-in (night phase 14). See docs/API.md "The
-- command line's sign-in", docs/CLI.md and docs/DECISIONS.md D14-2.
--
-- `device_grants`: a person's decision on a device code, and nothing before it. The code itself is
-- written nowhere: the registry seals the request (its scopes, life, name, expiry and a random nonce)
-- with the server key (SESSION_KEY) and hands it to the command line; the approval page reads the
-- sealed request back and checks its seal. So a code nobody approves costs no row, and a stranger
-- asking for codes writes nothing.
--
-- - `ref` is the SHA-256 (hex) of "device\n" and the request's nonce: the only thing the command line's
--   polls and the approval page share. No code, token or secret is kept.
-- - `day` is the UTC day the code expires (at most 15 minutes after it was made): the key's first part,
--   so that the Mac's retention deletes the past days by a key range (oscr/retention.py).
-- - `state`: approved (the token is made when the command line collects it: no secret at rest),
--   denied, or collected (a code opens one token, once).
--
-- What it costs: an approval or a refusal 1 row (and its action row); the collection 1 (and the token's
-- 2, and its action row); the Mac's retention 1, a day later.
--
-- Times are Unix seconds; a day is the UTC day number, `at / 86400`.

CREATE TABLE device_grants (
    day           INTEGER NOT NULL,
    ref           TEXT NOT NULL CHECK (length(ref) = 64 AND ref NOT GLOB '*[^0-9a-f]*'),
    user_id       TEXT NOT NULL,                  -- oscr_community users.id: never answered
    scopes        TEXT NOT NULL CHECK (length(scopes) BETWEEN 1 AND 300),
    days          INTEGER NOT NULL CHECK (days BETWEEN 1 AND 366),
    name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND instr(name, '@') = 0),
    state         TEXT NOT NULL CHECK (state IN ('approved', 'denied', 'collected')),
    decided_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    collected_at  INTEGER,
    PRIMARY KEY (day, ref)
) WITHOUT ROWID;
