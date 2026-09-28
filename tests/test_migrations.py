"""Numbered migrations, applied once, in order, each in its own transaction."""
import sqlite3

import pytest

from oscr import db


def test_a_new_database_is_at_the_latest_version(tmp_path):
    con = db.open_db(tmp_path / "n.db")
    assert int(con.execute("SELECT value FROM meta WHERE name = 'schema_version'").fetchone()[0]) == db.SCHEMA_VERSION
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"paper_author", "paper_category", "field_provenance", "version", "alive_check", "repo_tool"} <= tables


def test_a_version_3_database_is_migrated_and_keeps_its_rows(tmp_path):
    path = tmp_path / "old.db"
    raw = sqlite3.connect(path)
    raw.executescript(db.SCHEMA)
    raw.execute("INSERT INTO meta VALUES ('schema_version', '3')")
    raw.execute("INSERT INTO article (id, doi, title, updated_at) VALUES ('doi:10.1/a', '10.1/a', 'T', 0)")
    raw.execute("INSERT INTO repository (repo, url, host, kind, state, verified_at) "
                "VALUES ('github.com/a/b', 'https://github.com/a/b', 'github.com', 'forge', 'alive', 5.0)")
    raw.commit()
    raw.close()
    con = db.open_db(path)
    assert con.execute("SELECT title, type, on_topic FROM article").fetchone()[:] == ("T", "", "")
    assert con.execute("SELECT repo, state FROM alive_check").fetchone()[:] == ("github.com/a/b", "alive")
    assert db.migrate(con) == []          # nothing left to apply


def test_a_failed_migration_leaves_the_previous_version(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "f.db")
    folder = tmp_path / "migrations"
    folder.mkdir()
    (folder / "9001_bad.sql").write_text("CREATE TABLE t9001 (x INTEGER);\nTHIS IS NOT SQL;\n")
    monkeypatch.setattr(db, "MIGRATIONS", folder)
    with pytest.raises(sqlite3.Error):
        db.migrate(con)
    assert int(con.execute("SELECT value FROM meta WHERE name = 'schema_version'").fetchone()[0]) == db.SCHEMA_VERSION
    assert con.execute("SELECT name FROM sqlite_master WHERE name = 't9001'").fetchone() is None


def test_every_verdict_on_a_repository_is_kept(tmp_path):
    con = db.open_db(tmp_path / "h.db")
    con.execute("INSERT INTO repository (repo, url, host, kind) VALUES ('github.com/a/b', 'u', 'github.com', 'forge')")
    db.save_repository(con, "github.com/a/b", {"state": "unreachable", "error": "clone: timed out"})
    db.save_repository(con, "github.com/a/b", {"state": "alive", "http_status": 200})
    assert [r[0] for r in con.execute("SELECT state FROM alive_check ORDER BY checked_at")] == ["unreachable", "alive"]


def test_a_record_gets_a_new_version_only_when_it_changes(tmp_path):
    con = db.open_db(tmp_path / "v.db")
    assert db.save_version(con, "article", "doi:10.1/a", {"type": "research-article", "volume": "3"}) == 1
    assert db.save_version(con, "article", "doi:10.1/a", {"type": "research-article", "volume": "3"}) is None
    assert db.save_version(con, "article", "doi:10.1/a", {"type": "research-article", "volume": "4"}) == 2
    diff = con.execute("SELECT diff FROM version WHERE version = 2").fetchone()[0]
    assert diff == '{"volume": ["3", "4"]}'
    # The same record again, its pairs as tuples (enrich._snapshot): read back as lists, no change.
    authors = {"type": "research-article", "volume": "4", "authors": [("Ada Fixture", "0000-0000-0000-001X")]}
    assert db.save_version(con, "article", "doi:10.1/a", authors) == 3
    assert db.save_version(con, "article", "doi:10.1/a", authors) is None


def test_provenance_says_where_each_value_came_from(tmp_path):
    con = db.open_db(tmp_path / "p.db")
    db.record_provenance(con, "article", "doi:10.1/a", {"abstract": "jats", "mesh": "epmc", "issue": ""})
    rows = dict(con.execute("SELECT field, source FROM field_provenance").fetchall())
    assert rows == {"abstract": "jats", "mesh": "epmc"}
