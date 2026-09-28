"""The community projector (oscr/community.py): the facts the sign-in verifies, pushed as deltas
into the D1 community database. The Mac database is the fixture's synthetic one
(tools/make_fixture.py), plus a few cases of its own; the SQL is applied to an SQLite database
made from the real D1 migration."""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402

from oscr import cli, community, db, find, links  # noqa: E402

MIGRATION = ROOT / "migrations" / "d1-community" / "0001_accounts.sql"
PAPER_1, PAPER_2, PAPER_3, PAPER_4, PAPER_5 = (f"doi:10.5555/oscr.fixture.{n}" for n in range(1, 6))
ADA, BEN, OTTO = make_fixture.ADA, make_fixture.BEN, make_fixture.OTTO
#: A valid ORCID iD (ORCID's own example) and the same with a wrong check digit.
JOSIAH, TYPO = "0000-0002-1825-0097", "0000-0002-1825-0098"


def _mac(tmp_path: Path) -> sqlite3.Connection:
    """The fixture's database, with what it does not cover: an ORCID iD with a wrong check digit,
    an ORCID iD on a paper without a page, a GitLab repository, a Zenodo record and a GitHub
    data link."""
    con = make_fixture.database(tmp_path / "mac.db")
    con.execute("INSERT INTO paper_author (article_id, position, name, orcid) VALUES (?, 9, 'Typo Person', ?)",
                (PAPER_1, TYPO))
    con.execute("INSERT INTO paper_author (article_id, position, name, orcid) VALUES (?, 1, 'Josiah Nopage', ?)",
                (PAPER_5, JOSIAH))
    extra = [(links.normalize("https://gitlab.com/Synthetic-Group/sub/eeg-tools.git"), "code"),
             (links.normalize("https://zenodo.org/records/1234567"), "code"),
             (links.normalize("https://github.com/oscr-fixture/recordings"), "data")]
    for link, role in extra:
        con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                    "VALUES (?, ?, ?, ?, ?, ?, 'high', 'text')", (PAPER_1, link.repo, link.url, link.host, link.kind, role))
    # The off-topic paper's code: it must not reach D1 (D7).
    off = links.normalize("https://github.com/elsewhere/off-topic-code")
    db.replace_links(con, "doi:10.5555/oscr.fixture.9", [find.Candidate(off, "code", "high", 3.0, "text", "", "Code")])
    con.commit()
    return con


def _d1() -> sqlite3.Connection:
    d1 = sqlite3.connect(":memory:")
    d1.execute("PRAGMA foreign_keys = ON")
    d1.executescript(MIGRATION.read_text())
    return d1


def _apply(d1: sqlite3.Connection, files: list[tuple[Path, list]]) -> None:
    for path, _ in files:
        d1.executescript(path.read_text())


def test_the_facts_are_the_orcid_ids_and_repository_owners_of_the_papers_with_a_page(tmp_path):
    f = community.facts(_mac(tmp_path))
    pairs = {(r.values["orcid"], r.values["paper_id"]) for r in f["paper_orcid"].values()}
    assert pairs == {(ADA, PAPER_1), (BEN, PAPER_1), (BEN, PAPER_2), (ADA, PAPER_3), (BEN, PAPER_4)}
    # Not the off-topic paper's author (D7), not a paper without a page (D2), not a wrong check digit.
    everything = json.dumps([r.values for t in f.values() for r in t.values()])
    assert OTTO not in everything and JOSIAH not in everything and TYPO not in everything
    row = f["paper_orcid"][json.dumps([ADA, PAPER_1])].values
    assert row == {"orcid": ADA, "paper_id": PAPER_1, "slug": "doi_10.5555_oscr.fixture.1",
                   "title": "A synthetic EEG study for the OSCR build test"}
    owners = {r.values["repo"]: (r.values["host"], r.values["owner"]) for r in f["repo_owner"].values()}
    assert owners == {"github.com/oscr-fixture/eeg-analysis": ("github.com", "oscr-fixture"),
                      "github.com/oscr-fixture/unlicensed": ("github.com", "oscr-fixture"),
                      "gitlab.com/synthetic-group/sub/eeg-tools": ("gitlab.com", "synthetic-group")}


def test_an_owner_is_read_only_from_a_forge_address():
    assert community.owner_of("github.com/Owner/Name") == ("github.com", "owner")
    assert community.owner_of("gitlab.inria.fr/team/project") == ("gitlab.inria.fr", "team")
    for key in ("zenodo:123", "github.com/owner", "osf:abcde", "doi:10.5281/zenodo.1", "team.gitlab.io/site/x",
                "example.org/owner/name"):
        assert community.owner_of(key) is None, key


def test_the_sql_builds_the_d1_tables_and_the_next_push_sends_only_what_changed(tmp_path):
    con = _mac(tmp_path)
    state = community.open_state(":memory:")
    d1 = _d1()
    plan = community.build(con, state, "local", now=0)
    assert (plan.new, plan.changed, plan.deleted, plan.deferred) == (8, 0, 0, 0)
    files = community.write(plan, tmp_path / "out", now=0)
    _apply(d1, files)
    for _, statements in files:
        community.record(state, "local", statements, len(statements), now=0)
    assert d1.execute("SELECT COUNT(*) FROM paper_orcid").fetchone()[0] == 5
    assert d1.execute("SELECT owner FROM repo_owner WHERE repo = 'github.com/oscr-fixture/unlicensed'").fetchone() == (
        "oscr-fixture",)
    assert community.build(con, state, "local", now=0).statements == []

    # A title changes, a paper loses its page, an author gains an ORCID iD.
    con.execute("UPDATE article SET title = 'Alzheimer''s synthetic study, renamed' WHERE id = ?", (PAPER_1,))
    con.execute("UPDATE article SET status = 'none' WHERE id = ?", (PAPER_2,))
    con.execute("UPDATE paper_author SET orcid = ? WHERE article_id = ? AND name = 'Cleo Nameless'", (JOSIAH, PAPER_1))
    con.commit()
    plan = community.build(con, state, "local", now=0)
    assert (plan.new, plan.changed, plan.deleted) == (1, 2, 2), plan.describe()
    # Deletions go first: the page is gone before anything else is sent.
    assert [s.hash is None for s in plan.statements[:2]] == [True, True]
    files = community.write(plan, tmp_path / "out2", now=0)
    _apply(d1, files)
    for _, statements in files:
        community.record(state, "local", statements, len(statements), now=0)
    rows = d1.execute("SELECT orcid, paper_id, title FROM paper_orcid ORDER BY 1, 2").fetchall()
    assert (BEN, PAPER_2, "A synthetic study whose code has no license") not in rows
    assert (JOSIAH, PAPER_1, "Alzheimer's synthetic study, renamed") in rows
    assert d1.execute("SELECT COUNT(*) FROM repo_owner WHERE repo = 'github.com/oscr-fixture/unlicensed'").fetchone()[0] == 0
    assert community.build(con, state, "local", now=0).statements == []


def test_a_push_stops_at_the_days_budget_and_goes_on_the_next_day(tmp_path):
    con = _mac(tmp_path)
    state = community.open_state(":memory:")
    day1, day2 = 1_790_337_600.0, 1_790_337_600.0 + 86_400
    plan = community.build(con, state, "local", budget=3, now=day1)
    assert len(plan.statements) == 3 and plan.deferred == 5 and not plan.complete
    community.record(state, "local", plan.statements, plan.rows, now=day1)
    assert community.build(con, state, "local", budget=3, now=day1).statements == []   # spent for today
    plan = community.build(con, state, "local", budget=3, now=day2)
    assert len(plan.statements) == 3 and plan.deferred == 2
    assert "rows written" in community.status(state)


def test_push_records_each_file_the_target_accepted(tmp_path, monkeypatch):
    con = _mac(tmp_path)
    state = community.open_state(tmp_path / "state.db")
    monkeypatch.setattr(community, "FILE_STATEMENTS", 3)
    d1 = _d1()
    sent: list[Path] = []

    def apply(path: Path) -> None:
        if len(sent) == 2:
            raise community.PushError("the local D1 refused the file")
        d1.executescript(path.read_text())
        sent.append(path)

    with pytest.raises(community.PushError):
        community.push(con, state, "local", folder=tmp_path / "out", apply=apply, migrate=lambda: None, report=lambda m: None)
    assert state.execute("SELECT COUNT(*) FROM community_sync").fetchone()[0] == 6
    plan = community.push(con, state, "local", folder=tmp_path / "out", apply=lambda p: d1.executescript(p.read_text()),
                          migrate=lambda: None, report=lambda m: None)
    assert (plan.applied, plan.written, plan.complete) == (2, 2, True)
    assert d1.execute("SELECT COUNT(*) FROM paper_orcid").fetchone()[0] + \
        d1.execute("SELECT COUNT(*) FROM repo_owner").fetchone()[0] == 8
    with pytest.raises(community.PushError, match="owner approves"):
        community.push(con, state, "remote", folder=tmp_path / "out", apply=lambda p: None, migrate=lambda: None)


def test_no_contact_detail_reaches_the_sql(tmp_path):
    con = _mac(tmp_path)
    con.execute("UPDATE article SET title = 'A study (correspondence: ada.fixture@example.org)' WHERE id = ?", (PAPER_1,))
    con.commit()
    plan = community.build(con, community.open_state(":memory:"), "local")
    text = "".join(p.read_text() for p, _ in community.write(plan, tmp_path / "out"))
    assert "@" not in text and "example.org" not in text
    assert "'A study'" in text


def test_the_command_line_builds_the_files_and_wants_local(tmp_path, capsys):
    mac = tmp_path / "mac.db"
    make_fixture.database(mac).close()
    folder = tmp_path / "community"
    assert cli.main(["--db", str(mac), "community", "build", "--local", "--folder", str(folder)]) == 0
    out = capsys.readouterr().out
    assert "7 new" in out and "oscr_community.sql" in out
    sql = next(folder.glob("local-*/001-oscr_community.sql")).read_text()
    assert "INSERT INTO paper_orcid" in sql and "INSERT INTO repo_owner" in sql
    with pytest.raises(SystemExit, match="--local"):
        cli.main(["--db", str(mac), "community", "push", "--folder", str(folder)])
    assert cli.main(["--db", str(mac), "community", "status", "--folder", str(folder)]) == 0
    assert "nothing pushed yet" in capsys.readouterr().out
