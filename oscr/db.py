"""The database: one SQLite file, the harvester's only memory.

**Why SQLite.** One file that can be copied, versioned and published: it fits a free
host (a GitHub repository, a Hugging Face dataset) as well as the Mac, and Datasette
opens it as is.

**The tables that matter.**

- `article`: a scanned paper, identified by its DOI (or its PMCID);
- `link`: every repository it cites, with its ROLE (authors' code, data, third-party
  tool) and the reasons for the verdict;
- `repository`: what verification found at the end of the link — alive or dead,
  commit, license, number of scripts;
- `file`: the TEXT of each repository's scripts, at the verified commit;
- `script`: the LIBRARY. One row per paper, origin and repository, with its LEVEL
  of evidence. The origin is `native` today; `generated` and `author` are foreseen
  by the schema;
- `alignment`: which paragraph of the paper matches which lines of the code (the
  Code ↔ Paper reader);
- `validation` and `card_doi`: tracing maps validated by an author, and their DOI.

**Levels of evidence**: `found` (the paper cites the link), `alive` (the link
answers), `inventoried` (the file list and the commit are known), `imported` (a
snapshot is kept, with its digest).

The excerpt of the sentence that made a link's verdict is kept for review and is
NEVER exported: a literal quotation of the paper has nothing to do in a public
library.
"""
from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

#: The schema written by SCHEMA below; every later change is a numbered file in
#: oscr/migrations/ (NNNN_name.sql), applied once, in order, when the database opens.
BASE_VERSION = 3
MIGRATIONS = Path(__file__).with_name("migrations")
SCHEMA_VERSION = max([BASE_VERSION, *(int(f.name[:4]) for f in MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql"))])

STATUSES: tuple[str, ...] = (
    "code_verified",     # an authors' repository, alive, inventoried
    "code_found",        # an authors' code link, not verified yet
    "code_empty",        # the repository answers but holds no recognized script
    "code_dead",         # the code link no longer answers
    "on_request",        # the paper says "available on request"
    "data_only",         # data links, no code
    "none",              # nothing
    "no_fulltext",       # no full text: only the metadata spoke
    "to_scan",
)
LEVELS: tuple[str, ...] = ("found", "alive", "inventoried", "imported")
ORIGINS: tuple[str, ...] = ("native", "generated", "author")

SCHEMA = """
CREATE TABLE IF NOT EXISTS article (
    id               TEXT PRIMARY KEY,
    doi              TEXT NOT NULL DEFAULT '',
    pmid             TEXT NOT NULL DEFAULT '',
    pmcid            TEXT NOT NULL DEFAULT '',
    fulltext_id      TEXT NOT NULL DEFAULT '',
    title            TEXT NOT NULL DEFAULT '',
    authors          TEXT NOT NULL DEFAULT '[]',
    journal          TEXT NOT NULL DEFAULT '',
    published        TEXT NOT NULL DEFAULT '',
    license          TEXT NOT NULL DEFAULT '',
    source           TEXT NOT NULL DEFAULT '',
    has_fulltext     INTEGER NOT NULL DEFAULT 0,
    has_statement    INTEGER NOT NULL DEFAULT 0,
    code_on_request  INTEGER NOT NULL DEFAULT 0,
    data_on_request  INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'to_scan',
    families         TEXT NOT NULL DEFAULT '[]',
    methods          TEXT NOT NULL DEFAULT '[]',
    scanned_at       REAL,
    updated_at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS i_article_status ON article(status);
CREATE INDEX IF NOT EXISTS i_article_published ON article(published);

CREATE TABLE IF NOT EXISTS link (
    article_id   TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    repo         TEXT NOT NULL,
    url          TEXT NOT NULL,
    host         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    role         TEXT NOT NULL,
    confidence   TEXT NOT NULL,
    margin       REAL NOT NULL DEFAULT 0,
    found_by     TEXT NOT NULL,
    section      TEXT NOT NULL DEFAULT '',
    reasons      TEXT NOT NULL DEFAULT '[]',
    excerpt      TEXT NOT NULL DEFAULT '',
    occurrences  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (article_id, repo)
);
CREATE INDEX IF NOT EXISTS i_link_repo ON link(repo);

CREATE TABLE IF NOT EXISTS repository (
    repo             TEXT PRIMARY KEY,
    url              TEXT NOT NULL,
    host             TEXT NOT NULL,
    kind             TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'unverified',
    http_status      INTEGER,
    resource_type    TEXT NOT NULL DEFAULT '',
    license          TEXT NOT NULL DEFAULT '',
    redistributable  TEXT NOT NULL DEFAULT 'unknown',
    commit_id        TEXT NOT NULL DEFAULT '',
    commit_date      TEXT NOT NULL DEFAULT '',
    n_files          INTEGER,
    n_scripts        INTEGER,
    languages        TEXT NOT NULL DEFAULT '{}',
    files            TEXT NOT NULL DEFAULT '[]',
    stars            INTEGER,
    created          TEXT NOT NULL DEFAULT '',
    cites_article    TEXT NOT NULL DEFAULT '',
    swh_archived     INTEGER,
    linked_to        TEXT NOT NULL DEFAULT '',
    error            TEXT NOT NULL DEFAULT '',
    verified_at      REAL,
    scripts_read     INTEGER,
    CHECK (state IN ('unverified', 'alive', 'dead', 'unreachable', 'unverifiable'))
);

CREATE TABLE IF NOT EXISTS script (
    article_id   TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    origin       TEXT NOT NULL,
    repo         TEXT NOT NULL,
    level        TEXT NOT NULL,
    commit_id    TEXT NOT NULL DEFAULT '',
    path         TEXT NOT NULL DEFAULT '',
    digest       TEXT NOT NULL DEFAULT '',
    imported_at  REAL,
    PRIMARY KEY (article_id, origin, repo),
    CHECK (origin IN ('native', 'generated', 'author')),
    CHECK (level IN ('found', 'alive', 'inventoried', 'imported'))
);

-- The TEXT of each repository's scripts, as at the verified commit. A repository
-- re-verified at another commit replaces its rows. `text` is NULL when the file is
-- binary or could not be fetched; `note` says why.
CREATE TABLE IF NOT EXISTS file (
    repo        TEXT NOT NULL,
    path        TEXT NOT NULL,
    version     TEXT NOT NULL DEFAULT '',
    language    TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'script',
    size        INTEGER,
    lines       INTEGER,
    digest      TEXT NOT NULL DEFAULT '',
    text        TEXT,
    truncated   INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    fetched_at  REAL,
    PRIMARY KEY (repo, path),
    CHECK (kind IN ('script', 'doc', 'note'))
);

-- Paper ↔ code matches for the Code ↔ Paper reader. `paragraph` is the index of a
-- <p> among all <p> under the JATS <body>, in document order: the reader's browser
-- computes the same index from the same Europe PMC XML. `evidence` holds only
-- short technical terms, never sentences of the paper.
CREATE TABLE IF NOT EXISTS alignment (
    article_id   TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    pair         INTEGER NOT NULL,
    paragraph    INTEGER NOT NULL,
    section      TEXT NOT NULL DEFAULT '',
    repo         TEXT NOT NULL,
    path         TEXT NOT NULL,
    start_line   INTEGER NOT NULL,
    end_line     INTEGER NOT NULL,
    symbol       TEXT NOT NULL DEFAULT '',
    score        REAL NOT NULL,
    evidence     TEXT NOT NULL DEFAULT '[]',
    method       TEXT NOT NULL,
    computed_at  REAL NOT NULL,
    PRIMARY KEY (article_id, pair)
);

CREATE TABLE IF NOT EXISTS cursor (
    source      TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS log (
    t        REAL NOT NULL,
    event    TEXT NOT NULL,
    details  TEXT NOT NULL DEFAULT '{}'
);

-- A tracing map validated by one of the paper's authors (ORCID). The map kept is the
-- one they saw. Only a validated map gets a DOI (see CLAUDE.md and zenodo.py).
-- Proof "test": development only, accepted by the Zenodo sandbox alone.
CREATE TABLE IF NOT EXISTS validation (
    article_id    TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    orcid         TEXT NOT NULL,
    name          TEXT NOT NULL,
    proof         TEXT NOT NULL CHECK (proof IN ('orcid', 'test')),
    validated_at  REAL NOT NULL,
    card          TEXT NOT NULL,
    PRIMARY KEY (article_id, orcid)
);

-- The Zenodo DOI of a validated map, per instance (sandbox or zenodo).
CREATE TABLE IF NOT EXISTS card_doi (
    article_id    TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    instance      TEXT NOT NULL,
    record_id     TEXT NOT NULL,
    doi           TEXT NOT NULL DEFAULT '',
    concept_doi   TEXT NOT NULL DEFAULT '',
    deposited_at  REAL NOT NULL,
    PRIMARY KEY (article_id, instance)
);

CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def open_db(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    # WAL: on the Mac, the harvester writes continuously while the dashboard and the
    # nightly publication read; in WAL mode none of them blocks the others. What
    # LEAVES this machine (catalog.public_db) goes back to a single file.
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous = NORMAL")  # safe in WAL mode, and fewer writes
    con.executescript(SCHEMA)
    con.execute("INSERT OR IGNORE INTO meta VALUES ('schema_version', ?)", (str(BASE_VERSION),))
    con.commit()
    migrate(con)
    return con


def migrate(con: sqlite3.Connection) -> list[str]:
    """Apply the migrations the database has not seen, each in its own transaction: a
    failed migration leaves the database at the previous version. Returns their names."""
    current = int(con.execute("SELECT value FROM meta WHERE name = 'schema_version'").fetchone()[0])
    done = []
    for f in sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        n = int(f.name[:4])
        if n <= current:
            continue
        try:
            con.executescript("BEGIN;\n" + f.read_text() +
                              f"\nUPDATE meta SET value = '{n}' WHERE name = 'schema_version';\nCOMMIT;")
        except sqlite3.Error:
            con.rollback()
            raise
        done.append(f.name)
        current = n
    return done


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)


def save_article(con: sqlite3.Connection, a: dict[str, Any]) -> None:
    """Create or complete a paper. An empty field never erases a filled one."""
    now = time.time()
    seen = con.execute("SELECT * FROM article WHERE id = ?", (a["id"],)).fetchone()
    fields = ("doi", "pmid", "pmcid", "fulltext_id", "title", "journal", "published", "license", "source")
    if seen is None:
        con.execute(
            f"INSERT INTO article (id, {', '.join(fields)}, authors, updated_at) "
            f"VALUES (?, {', '.join('?' * len(fields))}, ?, ?)",
            (a["id"], *(a.get(f, "") or "" for f in fields), _j(a.get("authors", [])), now))
        return
    update = {f: a[f] for f in fields if a.get(f) and not seen[f]}
    if a.get("authors") and seen["authors"] == "[]":
        update["authors"] = _j(a["authors"])
    if update:
        assignments = ", ".join(f"{f} = ?" for f in update)
        con.execute(f"UPDATE article SET {assignments}, updated_at = ? WHERE id = ?",
                    (*update.values(), now, a["id"]))


def mark_scanned(con: sqlite3.Connection, article_id: str, *, has_fulltext: bool,
                 has_statement: bool, code_on_request: bool, data_on_request: bool,
                 families: list[str], methods: list[str]) -> None:
    con.execute(
        "UPDATE article SET has_fulltext=?, has_statement=?, code_on_request=?, data_on_request=?, "
        "families=?, methods=?, scanned_at=?, updated_at=? WHERE id=?",
        (int(has_fulltext), int(has_statement), int(code_on_request), int(data_on_request),
         _j(families), _j(methods), time.time(), time.time(), article_id))


def replace_links(con: sqlite3.Connection, article_id: str, candidates: Iterable[Any]) -> None:
    """A paper's links are those of its LATEST scan: replaced, never stacked."""
    con.execute("DELETE FROM link WHERE article_id = ?", (article_id,))
    for c in candidates:
        con.execute(
            "INSERT OR REPLACE INTO link (article_id, repo, url, host, kind, role, confidence, margin, "
            "found_by, section, reasons, excerpt, occurrences) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (article_id, c.link.repo, c.link.url, c.link.host, c.link.kind, c.role, c.confidence,
             c.margin, c.found_by, c.section[:200], _j(c.reasons), c.excerpt[:1000], c.occurrences))
        con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind) VALUES (?,?,?,?)",
                    (c.link.repo, c.link.url, c.link.host, c.link.kind))


def save_repository(con: sqlite3.Connection, repo: str, record: dict[str, Any]) -> None:
    """Store a verification record; its keys are `repository` columns (repos.verify)."""
    record = dict(record)
    if "state" in record:
        # A new verdict replaces the whole state: the error of an earlier failed attempt
        # must not survive a successful one.
        record.setdefault("error", "")
    contents = record.pop("_contents", None)
    if contents is not None:
        save_contents(con, repo, record.get("commit_id", "") or "", contents)
        record["scripts_read"] = sum(1 for c in contents if c["kind"] == "script" and c["text"])
    columns = [k for k in record if k != "repo"]
    values = [(_j(v) if isinstance(v, (dict, list)) else v) for v in (record[k] for k in columns)]
    assignments = ", ".join(f"{c} = ?" for c in columns)
    now = time.time()
    con.execute(f"UPDATE repository SET {assignments}, verified_at = ? WHERE repo = ?",
                (*values, now, repo))
    if "state" in record:
        # Every verdict is kept, not only the last one: a repository's history of answers.
        con.execute("INSERT OR REPLACE INTO alive_check (repo, checked_at, state, http_status, error) "
                    "VALUES (?, ?, ?, ?, ?)", (repo, now, record["state"], record.get("http_status"),
                                               record.get("error", "")))


def save_contents(con: sqlite3.Connection, repo: str, version: str,
                  contents: list[dict[str, Any]]) -> None:
    """Replace a repository's script texts with those of its latest verification."""
    con.execute("DELETE FROM file WHERE repo = ?", (repo,))
    now = time.time()
    for c in contents:
        con.execute(
            "INSERT OR REPLACE INTO file (repo, path, version, language, kind, size, lines, digest, "
            "text, truncated, note, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (repo, c["path"], version, c.get("language", ""), c.get("kind", "script"), c.get("size"),
             c.get("lines"), c.get("digest", ""), c.get("text"), int(c.get("truncated", 0)),
             c.get("note", ""), now))


def save_alignment(con: sqlite3.Connection, article_id: str, pairs: Iterable[Any], method: str) -> int:
    """Replace a paper's matches with the latest computation (align.Pair objects)."""
    con.execute("DELETE FROM alignment WHERE article_id = ?", (article_id,))
    now, n = time.time(), 0
    for p in pairs:
        con.execute(
            "INSERT INTO alignment (article_id, pair, paragraph, section, repo, path, start_line, end_line, "
            "symbol, score, evidence, method, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (article_id, p.pair, p.paragraph, p.section[:300], p.repo, p.path, p.start_line, p.end_line,
             p.symbol[:200], p.score, _j(list(p.evidence)), method, now))
        n += 1
    return n


def cursor(con: sqlite3.Connection, source: str, default: str = "") -> str:
    r = con.execute("SELECT value FROM cursor WHERE source = ?", (source,)).fetchone()
    return r["value"] if r else default


def set_cursor(con: sqlite3.Connection, source: str, value: str) -> None:
    con.execute("INSERT OR REPLACE INTO cursor VALUES (?,?,?)", (source, value, time.time()))


def log_event(con: sqlite3.Connection, event: str, **details: Any) -> None:
    con.execute("INSERT INTO log VALUES (?,?,?)", (time.time(), event, _j(details)))


def record_provenance(con: sqlite3.Connection, entity: str, entity_id: str, sources: dict[str, str],
                      ref: str = "", at: float | None = None) -> None:
    """Where each enriched value of a record came from (`field → source`), and when."""
    at = at or time.time()
    con.executemany("INSERT OR REPLACE INTO field_provenance (entity, entity_id, field, source, source_ref, "
                    "fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
                    [(entity, entity_id, f, s, ref, at) for f, s in sources.items() if s])


def save_version(con: sqlite3.Connection, entity: str, entity_id: str, snapshot: dict[str, Any],
                 actor: str = "harvester") -> int | None:
    """Keep `snapshot` as a new version of the record when it differs from the last one,
    with what changed (`field → [before, after]`). Returns the new version, or None."""
    last = con.execute("SELECT version, snapshot FROM version WHERE entity = ? AND entity_id = ? "
                       "ORDER BY version DESC LIMIT 1", (entity, entity_id)).fetchone()
    before = json.loads(last["snapshot"]) if last else {}
    if last and before == snapshot:
        return None
    diff = {k: [before.get(k), snapshot.get(k)] for k in sorted(set(before) | set(snapshot))
            if before.get(k) != snapshot.get(k)}
    n = (last["version"] if last else 0) + 1
    con.execute("INSERT INTO version (entity, entity_id, version, created_at, actor, snapshot, diff) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)", (entity, entity_id, n, time.time(), actor, _j(snapshot), _j(diff)))
    return n
