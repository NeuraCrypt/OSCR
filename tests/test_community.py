"""The community projector (oscr/community.py): the facts the sign-in verifies, pushed as deltas
into the D1 community database, locally or to Cloudflare. The Mac database is the fixture's
synthetic one (tools/make_fixture.py), plus a few cases of its own; the SQL is applied to an
SQLite database made from the real D1 migrations."""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402

from oscr import cli, community, db, find, links  # noqa: E402

MIGRATIONS = sorted((ROOT / "migrations" / "d1-community").glob("[0-9][0-9][0-9][0-9]_*.sql"))
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
    for migration in MIGRATIONS:
        d1.executescript(migration.read_text())
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
    # Which paper each repository is the code of (Phase 6: its maintainers may correct that record).
    assert {(r.values["repo"], r.values["paper_id"]) for r in f["paper_repo"].values()} == {
        ("github.com/oscr-fixture/eeg-analysis", PAPER_1), ("github.com/oscr-fixture/unlicensed", PAPER_2),
        ("gitlab.com/synthetic-group/sub/eeg-tools", PAPER_1)}


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
    assert (plan.new, plan.changed, plan.deleted, plan.deferred) == (11, 0, 0, 0)
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
    assert (plan.new, plan.changed, plan.deleted) == (1, 2, 3), plan.describe()
    # Deletions go first: the page is gone before anything else is sent.
    assert [s.hash is None for s in plan.statements[:3]] == [True, True, True]
    files = community.write(plan, tmp_path / "out2", now=0)
    _apply(d1, files)
    for _, statements in files:
        community.record(state, "local", statements, len(statements), now=0)
    rows = d1.execute("SELECT orcid, paper_id, title FROM paper_orcid ORDER BY 1, 2").fetchall()
    assert (BEN, PAPER_2, "A synthetic study whose code has no license") not in rows
    assert (JOSIAH, PAPER_1, "Alzheimer's synthetic study, renamed") in rows
    assert d1.execute("SELECT COUNT(*) FROM repo_owner WHERE repo = 'github.com/oscr-fixture/unlicensed'").fetchone()[0] == 0
    assert d1.execute("SELECT COUNT(*) FROM paper_repo WHERE paper_id = ?", (PAPER_2,)).fetchone()[0] == 0
    assert community.build(con, state, "local", now=0).statements == []


def test_a_push_stops_at_the_days_budget_and_goes_on_the_next_day(tmp_path):
    con = _mac(tmp_path)
    state = community.open_state(":memory:")
    day1, day2 = 1_790_337_600.0, 1_790_337_600.0 + 86_400
    plan = community.build(con, state, "local", budget=3, now=day1)
    assert len(plan.statements) == 3 and plan.deferred == 8 and not plan.complete
    community.record(state, "local", plan.statements, plan.rows, now=day1)
    assert community.build(con, state, "local", budget=3, now=day1).statements == []   # spent for today
    plan = community.build(con, state, "local", budget=3, now=day2)
    assert len(plan.statements) == 3 and plan.deferred == 5
    # The job runner's rows (oscr/jobs.py) count in the same day.
    community.spend(state, "local", 2, now=day2 + 60)
    assert community.budget_spent(state, "local", community.utc_day(day2)) == 2
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
    assert (plan.applied, plan.written, plan.complete) == (5, 5, True)
    assert d1.execute("SELECT COUNT(*) FROM paper_orcid").fetchone()[0] + \
        d1.execute("SELECT COUNT(*) FROM repo_owner").fetchone()[0] == 8
    assert d1.execute("SELECT COUNT(*) FROM paper_repo").fetchone()[0] == 3
    with pytest.raises(community.PushError, match="unknown target"):
        community.push(con, state, "elsewhere", folder=tmp_path / "out", apply=lambda p: None, migrate=lambda: None)


def test_without_a_token_the_remote_push_goes_through_wranglers_login(tmp_path, monkeypatch):
    con = _mac(tmp_path)
    state = community.open_state(tmp_path / "state.db")
    calls = []
    monkeypatch.setattr(community, "_wrangler", lambda args, website: calls.append(args) or "")
    plan = community.push(con, state, "remote", folder=tmp_path / "sql", settings={}, report=lambda _: None)
    assert calls and all(c[:3] == ["d1", "execute", "oscr_community"] and "--remote" in c and "--file" in c
                         and "--local" not in c for c in calls)
    assert plan.applied == len(plan.statements) == 11 and plan.written == 11
    assert community.build(con, state, "remote").statements == []          # recorded: nothing left to send
    assert community.build(con, state, "local").new == 11                  # each target has its own state
    assert not list((tmp_path / "sql").glob("remote-*/*.sql"))              # applied: the files are not kept


def test_with_a_token_the_remote_push_goes_through_the_rest_api(tmp_path, monkeypatch):
    from oscr import d1 as search
    con = _mac(tmp_path)
    state = community.open_state(tmp_path / "state.db")
    monkeypatch.setattr(search, "remote_token", lambda: "test-token")
    monkeypatch.setattr(community, "_wrangler", lambda *a: pytest.fail("wrangler, with a token"))
    target = _d1()
    posted = []

    class Answer:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    def post(url, headers, json, timeout):
        posted.append((url, headers["Authorization"]))
        results = []
        for sql in [x for x in json["sql"].split(";\n") if x.strip()]:
            before = target.total_changes
            target.execute(sql)
            results.append({"results": [], "success": True, "meta": {"rows_written": target.total_changes - before}})
        return Answer({"success": True, "result": results})

    settings = {"OSCR_D1_ACCOUNT_ID": "acc", "OSCR_D1_COMMUNITY_ID": "db-community"}
    plan = community.push(con, state, "remote", folder=tmp_path / "sql", settings=settings, post=post, report=lambda _: None)
    assert posted == [("https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db-community/query", "Bearer test-token")]
    assert (plan.applied, plan.written) == (11, 11)
    assert target.execute("SELECT COUNT(*) FROM paper_orcid").fetchone()[0] == 5


def test_the_night_pushes_the_facts_once_the_settings_say_so(tmp_path, monkeypatch, capsys):
    from oscr import catalog
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(catalog, "generate", lambda con, out, public: out)
    monkeypatch.setattr(community, "command", lambda con, action, **kw: calls.append((action, kw["target"])) or "pushed")
    for settings, pushes in (({}, []), ({"OSCR_COMMUNITY_PUSH": "remote"}, [("push", "remote")])):
        calls.clear()
        monkeypatch.setattr(cli, "settings", lambda s=settings: dict(s))
        cli.main(["--db", str(tmp_path / "mac.db"), "nightly", "--out", str(tmp_path / "out")])
        assert calls == pushes
    assert "community (D1): pushed" in capsys.readouterr().out


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
    assert "9 new" in out and "oscr_community.sql" in out
    sql = next(folder.glob("local-*/001-oscr_community.sql")).read_text()
    assert "INSERT INTO paper_orcid" in sql and "INSERT INTO repo_owner" in sql and "INSERT INTO paper_repo" in sql
    with pytest.raises(SystemExit, match="--local"):
        cli.main(["--db", str(mac), "community", "push", "--folder", str(folder)])
    assert cli.main(["--db", str(mac), "community", "status", "--folder", str(folder)]) == 0
    assert "nothing pushed yet" in capsys.readouterr().out
