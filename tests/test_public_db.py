"""The public database is built row by row into an empty database (2026-11-07), no longer as a
full copy of oscr.db stripped and compacted (two extra copies of a 32 GB database filled the Mac's
disk on 2026-11-05). Same tables, same rows, same rowids, same indexes as the old way: the old way is
kept here, word for word, as the reference, and both run on the same database."""
import json
import shutil
import sqlite3
import time
from pathlib import Path

import pytest

from oscr import catalog, db

from test_catalog_source import _world


def _reference_public_db(con: sqlite3.Connection, path: Path, report=lambda m: None) -> None:
    """A copy of the database without the excerpts of the papers' text, and without the
    text of scripts whose license forbids republishing. The log (dates, requests,
    counts) stays: it quotes no paper. `report` gets one timestamped line per sub-step, so the
    nightly's log says where the time goes."""
    started = time.monotonic()

    def step(what: str) -> None:
        report(f"{time.strftime('%Y-%m-%d %H:%M:%S')} public db (+{(time.monotonic() - started) / 60:.1f} min): {what}")

    tmp = path.with_suffix(".tmp")
    if tmp.exists():
        tmp.unlink()
    target = sqlite3.connect(tmp)
    con.commit()
    step("backup")
    con.backup(target)
    # This .tmp is disposable: it is rebuilt from scratch on every run and only moved into place
    # at the very end, so durability WHILE building it does not matter. Turning the rollback journal
    # and the fsyncs off makes the strip below (tens of DELETEs over a multi-GB copy) take minutes
    # instead of hours; a crash just means the next run rebuilds the .tmp. The single-file journal
    # mode sql.js / Datasette Lite expect is restored at the end, before the VACUUM.
    target.execute("PRAGMA synchronous = OFF")
    target.execute("PRAGMA journal_mode = OFF")
    step("excerpts")
    target.execute("UPDATE link SET excerpt = ''")
    # Off-topic papers stay on the Mac (D7), with everything attached to them; so do the records
    # withdrawn at someone's request (Phase 6, `oscr reports accept`).
    off = "SELECT id FROM article WHERE on_topic = 'no' OR withdrawn != ''"
    for (table,) in target.execute("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS "
                                   "(SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'article_id')").fetchall():
        step(f"off-topic rows of {table}")
        target.execute(f"DELETE FROM {table} WHERE article_id IN ({off})")
    step("off-topic provenance, log and papers")
    target.execute(f"DELETE FROM field_provenance WHERE entity = 'article' AND entity_id IN ({off})")
    target.execute(f"DELETE FROM log WHERE json_valid(details) AND json_extract(details, '$.article') IN ({off})")
    target.execute(f"DELETE FROM article WHERE id IN ({off})")
    # What accepted removal requests withhold while the record stays (0008): the copies of a
    # paper's scripts, of a repository or of a file (their text, as an unlicensed one), and a
    # paper's tracing map (its matches, its validations, its DOI). The table itself stays on the Mac.
    step("withheld")
    held = catalog.withheld(target)
    target.executemany("UPDATE file SET text = NULL, note = ? WHERE repo = ?", [(catalog.NOTE_WITHHELD, r) for r in held.repos])
    target.executemany("UPDATE file SET text = NULL, note = ? WHERE repo = ? AND path = ?",
                       [(catalog.NOTE_WITHHELD, r, p) for r, p in held.files])
    for table in ("alignment", "validation", "card_doi"):
        target.executemany(f"DELETE FROM {table} WHERE article_id = ?", [(a,) for a in held.maps])
    target.execute("DROP TABLE IF EXISTS withheld")
    # What only off-topic papers (or nothing) pointed at goes too: repositories, their files
    # and facts, datasets, people and funders no paper in scope names.
    step("orphan repositories")
    target.execute("DELETE FROM repository WHERE repo NOT IN (SELECT repo FROM link)")
    for table in ("file", "alive_check", "repo_feature", "repo_tool", "script_manifest"):
        if target.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
            step(f"orphan rows of {table}")
            target.execute(f"DELETE FROM {table} WHERE repo NOT IN (SELECT repo FROM repository)")
    step("orphan datasets, authors, funders, journals")
    target.execute("DELETE FROM dataset WHERE id NOT IN (SELECT dataset_id FROM paper_dataset)")
    target.execute("DELETE FROM author WHERE orcid NOT IN (SELECT orcid FROM paper_author)")
    target.execute("DELETE FROM funder WHERE id NOT IN (SELECT funder_id FROM grant_award)")
    target.execute("DELETE FROM journal WHERE id NOT IN (SELECT journal_id FROM article)")
    # OpenAlex's institutions and topics that no paper in scope names (paper_author.ror holds ROR
    # ids, or {"id": …} objects: both are found by the id's text).
    step("orphan institutions")
    catalog._drop_unnamed_institutions(target)
    step("orphan topics, abstracts, raw records")
    target.execute("DELETE FROM topic WHERE id NOT IN (SELECT topic_id FROM paper_topic)")
    # No text of a paper leaves: abstracts, the raw Europe PMC records, the history of the
    # enriched records; availability statements only under an open license (D1).
    target.execute("UPDATE article SET abstract = ''")
    target.execute("DROP TABLE IF EXISTS epmc_record")
    # The OpenAlex records as kept (their raw affiliation strings are the publishers' text): what
    # may leave of them is in `article`, `paper_author`, `institution`, `paper_topic`, `paper_work`.
    target.execute("DROP TABLE IF EXISTS openalex_record")
    target.execute("DROP TABLE IF EXISTS version")
    step("closed statements, test validations, provenance")
    closed = [r[0] for r in target.execute("SELECT id, license FROM article").fetchall()
              if not catalog.statement_is_publishable(r[1])]
    target.executemany("UPDATE statement SET text = '' WHERE article_id = ?", [(i,) for i in closed])
    # Development tests (test validations, sandbox DOIs) never leave.
    target.execute("DELETE FROM validation WHERE proof != 'orcid'")
    target.execute("DELETE FROM card_doi WHERE instance != 'zenodo'")
    # Who corrected a record (Phase 6) stays on the Mac: the corrections themselves are the links,
    # and the pages say "a correction by a verified author", never who.
    target.execute("DROP TABLE IF EXISTS link_edit")
    target.execute("UPDATE field_provenance SET source_ref = '' WHERE source IN ('author', 'maintainer', 'submitter')")
    # The licence audit's rule (`catalog.copyable`): a license that allows redistribution, verified by the
    # repository's own license file or its record.
    step("unlicensed file text")
    target.execute(
        "UPDATE file SET text = NULL, note = ? WHERE repo IN "
        "(SELECT repo FROM repository WHERE redistributable NOT IN ('yes', 'with_conditions'))",
        (catalog.NOTE_LICENSE,))
    step("unverified licences")
    unverified = [r["repo"] for r in con.execute("SELECT * FROM repository WHERE redistributable IN ('yes', 'with_conditions')")
                  if not catalog.copyable(con, r)]
    target.executemany("UPDATE file SET text = NULL, note = ? WHERE repo = ? AND text IS NOT NULL",
                       [(catalog.NOTE_UNVERIFIED, r) for r in unverified])
    # The authors' contact details are private: they go to the private dataset only
    # (oscr/contacts.py), never into a public output. Email addresses in the scripts' text
    # are hidden, as on the site.
    target.execute("DROP TABLE IF EXISTS contact")
    # Nor who asked not to be kept (their ORCID iD, their addresses' digests: oscr/contacts.py, migration 9).
    target.execute("DROP TABLE IF EXISTS contact_suppressed")
    step("email masking")
    last = 0
    while batch := target.execute("SELECT rowid, text FROM file WHERE rowid > ? AND text LIKE '%@%' ORDER BY rowid LIMIT ?",
                                  (last, catalog.MASK_BATCH)).fetchall():
        target.executemany("UPDATE file SET text = ? WHERE rowid = ?", [(catalog.mask_emails(t), rid) for rid, t in batch])
        last = batch[-1][0]
    target.commit()
    # Back to a single-file database (no -wal) for sql.js / Datasette Lite, then compact it (the
    # strip removed most rows). synchronous stays OFF: this is still the disposable build copy.
    target.execute("PRAGMA journal_mode = DELETE")
    step("vacuum")
    target.execute("VACUUM")
    target.close()
    shutil.move(tmp, path)
    step("done")


def _put(con, table, n, **values):
    """One row of : the given values, and a distinct value for every other column that needs one."""
    cols = {r[1]: r for r in con.execute(f"PRAGMA table_info({table})")}
    row = {}
    for name, r in cols.items():
        if name in values:
            row[name] = values[name]
        elif r[3] and r[4] is None or r[5]:
            row[name] = n if "INT" in (r[2] or "").upper() else f"v{n}"
    marks = ",".join("?" * len(row))
    try:
        con.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({marks})", list(row.values()))
        return True
    except sqlite3.IntegrityError:
        return False


def _rich(tmp_path):
    con = _world(tmp_path)
    con.execute("PRAGMA foreign_keys = OFF")
    con.execute("INSERT INTO article (id, doi, title, source, scanned_at, on_topic, updated_at, license, abstract) VALUES "
                "('doi:10.1/off', '10.1/off', 'Off', 'test', 1, 'no', 1, 'cc by', 'an abstract'), "
                "('doi:10.1/gone', '10.1/gone', 'Gone', 'test', 1, '', 1, 'cc by-nd', 'x'), "
                "('doi:10.1/open', '10.1/open', 'Open', 'test', 1, '', 1, 'cc by 4.0', 'y'), "
                "('doi:10.1/shut', '10.1/shut', 'Shut', 'test', 1, '', 1, 'all rights reserved', 'z')")
    con.execute("UPDATE article SET withdrawn = 'asked' WHERE id = 'doi:10.1/gone'")
    con.execute("UPDATE article SET abstract = 'text of the paper', license = 'cc by-nd' WHERE id = 'doi:10.1/a'")
    con.execute("UPDATE link SET excerpt = 'a quoted sentence'")
    n = 1000
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
    for t in tables:
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({t})")]
        for art in ("doi:10.1/a", "doi:10.1/off", "doi:10.1/gone", "doi:10.1/open", "doi:10.1/shut", None):
            n += 1
            extra = {"article_id": art} if "article_id" in cols else {}
            if t == "validation":
                for proof in ("orcid", "test", None):
                    n += 1
                    _put(con, t, n, **extra, proof=proof)
                continue
            if t == "card_doi":
                for inst in ("zenodo", "sandbox"):
                    n += 1
                    _put(con, t, n, **extra, instance=inst)
                continue
            if t == "statement":
                _put(con, t, n, **extra, text="Code is at github.com/lab/code")
                continue
            _put(con, t, n, **extra)
            if "article_id" not in cols:
                break
    # The repository side: an orphan repository and its file, a named and an orphan dataset, author,
    # funder, journal, topic, institution.
    con.execute("INSERT INTO repository (repo, url, host, kind, state, redistributable) VALUES "
                "('github.com/x/orphan', 'u', 'github.com', 'forge', 'alive', 'yes')")
    con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, digest, text) VALUES "
                "('github.com/x/orphan', 'a.py', 'v', 'Python', 'script', 1, 1, '', 'me@x.org')")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES "
                "('doi:10.1/open', 'github.com/lab/open', 'u', 'github.com', 'forge', 'code', 'high', 't'), "
                "('doi:10.1/off', 'github.com/x/offrepo', 'u', 'github.com', 'forge', 'code', 'high', 't')")
    con.execute("INSERT INTO repository (repo, url, host, kind, state, redistributable) VALUES "
                "('github.com/x/offrepo', 'u', 'github.com', 'forge', 'alive', 'yes')")
    con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, digest, text) VALUES "
                "('github.com/lab/open', 'mail.py', 'v', 'Python', 'script', 1, 1, '', 'x = 1'), "
                "('github.com/x/unverified', 'u.py', 'v', 'Python', 'script', 1, 1, '', 'u = 1'), "
                "('github.com/x/unverified', 'none.bin', 'v', 'Python', 'script', 1, 1, '', NULL)")
    con.execute("INSERT INTO repository (repo, url, host, kind, state, license, redistributable) VALUES "
                "('github.com/x/unverified', 'u', 'github.com', 'forge', 'alive', 'MIT', 'yes')")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES "
                "('doi:10.1/open', 'github.com/x/unverified', 'u', 'github.com', 'forge', 'code', 'high', 't')")
    con.execute("UPDATE file SET text = text || ' contact: someone@lab.org' WHERE text IS NOT NULL AND path != 'LICENSE'")
    for t, col in (("paper_dataset", "dataset_id"), ("paper_author", "orcid"), ("grant_award", "funder_id"),
                   ("paper_topic", "topic_id")):
        if t in tables:
            con.execute(f"UPDATE {t} SET {col} = 'named' WHERE article_id = 'doi:10.1/open'")
    for t, col in (("dataset", "id"), ("author", "orcid"), ("funder", "id"), ("topic", "id"), ("journal", "id")):
        if t in tables:
            n += 1
            _put(con, t, n, **{col: "named"})
            n += 1
            _put(con, t, n, **{col: "orphan"})
    con.execute("UPDATE article SET journal_id = 'named' WHERE id = 'doi:10.1/open'")
    if "paper_author" in tables:
        con.execute("""UPDATE paper_author SET ror = '["https://ror.org/01a"]' WHERE article_id = 'doi:10.1/open'""")
        n += 1
        _put(con, "institution", n, id="https://ror.org/01a")
        n += 1
        _put(con, "institution", n, id="https://ror.org/99z")
    # Removal requests: a file, a repository, a map, a paper's scripts; the private things.
    con.execute("DELETE FROM withheld")
    for i, (scope, art, repo, path) in enumerate([("file", "doi:10.1/a", "github.com/lab/open", "ok.py"),
                                                   ("map", "doi:10.1/open", "", ""), ("scripts", "doi:10.1/off", "", ""),
                                                   ("repository", "doi:10.1/a", "github.com/x/orphan", "")]):
        assert _put(con, "withheld", 9000 + i, scope=scope, article_id=art, repo=repo, path=path)
    for i, details in enumerate([json.dumps({"article": "doi:10.1/off"}), json.dumps({"article": "doi:10.1/open"}), "not json"]):
        assert _put(con, "log", 9100 + i, details=details)
    for i, (eid, source, ref) in enumerate([("doi:10.1/off", "crossref", "r"), ("doi:10.1/open", "author", "orcid:1"),
                                            ("doi:10.1/open", "crossref", "kept")]):
        assert _put(con, "field_provenance", 9200 + i, entity="article", entity_id=eid, source=source, source_ref=ref)
    con.commit()
    con.execute("PRAGMA foreign_keys = ON")
    return con


def _dump(path):
    pub = sqlite3.connect(path)
    master = sorted(pub.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall(), key=str)
    rows = {}
    for (t, sql) in pub.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'").fetchall():
        # The columns, an INTEGER PRIMARY KEY included; not the hidden rowid of the other tables, which
        # the old way's VACUUM kept for some tables and renumbered for others (the new way keeps it).
        rows[t] = sorted(pub.execute(f'SELECT * FROM "{t}"').fetchall(), key=repr)
    meta = (pub.execute("PRAGMA user_version").fetchone(), pub.execute("PRAGMA journal_mode").fetchone(),
            pub.execute("PRAGMA page_size").fetchone())
    pub.close()
    return master, rows, meta


def test_the_row_by_row_build_gives_what_the_full_copy_gave(tmp_path):
    con = _rich(tmp_path)
    _reference_public_db(con, tmp_path / "old.db")
    catalog.public_db(con, tmp_path / "new.db", report=lambda m: None)
    old, new = _dump(tmp_path / "old.db"), _dump(tmp_path / "new.db")
    assert new[0] == old[0]                       # the same tables and indexes, created the same way
    assert set(new[1]) == set(old[1])
    for table in old[1]:
        assert new[1][table] == old[1][table], table
    assert new[2] == old[2]
    # The test world is not empty where it matters.
    for table in ("article", "link", "file", "statement", "validation", "card_doi", "log", "field_provenance",
                  "repository", "paper_author"):
        assert old[1][table], table
    # What must never leave, by both ways.
    names = {r[1] for r in new[0]}
    assert not names & {"contact", "contact_suppressed", "withheld", "epmc_record", "openalex_record", "link_edit", "version"}
    texts = [r for r in new[1]["file"] if any(isinstance(v, str) and "someone@lab.org" in v for v in r)]
    assert texts == []
    files = {r[0]: r[1:] for r in sqlite3.connect(tmp_path / "new.db").execute("SELECT path, text, note FROM file")}
    assert files["mail.py"][0] == "x = 1 contact: [email hidden]"
    assert files["u.py"] == (None, catalog.NOTE_UNVERIFIED) and files["ok.py"] == (None, catalog.NOTE_WITHHELD)
    assert files["run.py"] == (None, catalog.NOTE_LICENSE)
    assert not (tmp_path / "new.tmp").exists()
    # Each row keeps the rowid it has on the Mac.
    mac = dict(con.execute("SELECT id, rowid FROM article").fetchall())
    assert dict(sqlite3.connect(tmp_path / "new.db").execute("SELECT id, rowid FROM article").fetchall()) == {
        k: v for k, v in mac.items() if k not in ("doi:10.1/off", "doi:10.1/gone")}


def test_the_source_is_never_written_and_leftovers_are_removed(tmp_path):
    con = _rich(tmp_path)
    before = con.execute("SELECT COUNT(*) FROM article").fetchone()[0], con.execute("SELECT COUNT(*) FROM contact").fetchone()[0]
    (tmp_path / "new.tmp").write_bytes(b"a dead run's leftover")
    (tmp_path / "new.tmp-journal").write_bytes(b"x")
    lines = []
    catalog.public_db(con, tmp_path / "new.db", report=lines.append)
    assert (con.execute("SELECT COUNT(*) FROM article").fetchone()[0], con.execute("SELECT COUNT(*) FROM contact").fetchone()[0]) == before
    assert not (tmp_path / "new.tmp-journal").exists()
    steps = [line.split(": ", 1)[1] for line in lines]
    assert steps[0] == "schema" and steps[-1] == "done" and "vacuum" not in steps
    assert sqlite3.connect(tmp_path / "new.db").execute("PRAGMA integrity_check").fetchone()[0] == "ok"
