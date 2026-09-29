"""A removal request decided by the owner (`oscr reports`, oscr/jobs.py) and what each scope takes out
of the public outputs (catalog.withheld: the site's lots of scripts, catalog.json, the pages' data, the
public database, the search's rows, the Hugging Face scripts dataset), while the record stays. The
fixture's paper 1 has its code on GitHub (MIT: its three files are copied), two matches, and a map
validated by an author with its DOI; paper 2's code has no license (listed, never copied)."""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests"))

from test_jobs import P1, P2, UNLICENSED, World  # noqa: E402

from oscr import catalog, cli, community, d1, db, jobs, scriptstore  # noqa: E402

EEG = "github.com/oscr-fixture/eeg-analysis"
T = 1_790_424_000


@pytest.fixture
def w(tmp_path):
    world = World(tmp_path)
    world.user("u_ada", "Ada Fixture", orcid="0000-0000-0000-001X")
    world.user("u_ben", "Ben Example", github="ben-example")
    return world


def ask(w, **values) -> int:
    """A removal request as the Worker records it from the page /removal/: by default one the
    moderator's rules leave to the owner (someone the registry cannot verify, for a reason that hides
    nothing at once: tests/test_moderation.py has the rules), so that the owner decides each scope."""
    row = {"user_id": "u_ben", "target_kind": "paper", "target_id": P1, "reason": "other",
           "details": "This record reproduces material under an agreement that does not allow it.",
           "requester_role": "other", "author_verified": 0, "scope": "record", "confirmed": 1, "created_at": T}
    return w.request("reports", "report", {**row, **values})


def export(w, tmp_path) -> dict:
    """The public export (as `oscr nightly` writes it) and the public database."""
    folder = tmp_path / "public"
    catalog.generate(w.mac, folder, public=True)
    lots = {}
    for f in (folder / "scripts").glob("*.json"):
        lots.update(json.loads(f.read_text()))
    papers = {}
    for f in (folder / "papers").glob("*.json"):
        papers.update(json.loads(f.read_text()))
    return {"catalog": json.loads((folder / "catalog.json").read_text()), "lots": lots, "papers": papers,
            "alignments": {k: v for f in (folder / "alignments").glob("*.json") for k, v in json.loads(f.read_text()).items()},
            "db": sqlite3.connect(folder / "oscr_public.db")}


def texts(lots: dict, repo: str) -> dict[str, str | None]:
    return {f["path"]: f["text"] for f in lots[repo]["files"]}


def article(out: dict, article_id: str) -> dict:
    return next(a for a in out["catalog"]["articles"] if a["id"] == article_id)


# ---------------------------------------------------------------------------------------
# The owner's list, and decisions.

def test_the_owners_list_says_who_asks_what_and_why(w):
    ask(w, scope="file", scope_repo=EEG, scope_path="plot.py", evidence_url="https://lab.example/notice", reason="incorrect",
        requester_role="rights_holder")
    ask(w, user_id="u_ben", target_id=P2, requester_role="named_person", author_verified=0, scope="map", reason="personal_data",
        details="The record names me in a way I did not agree to, see the notice.")
    assert w.poll().owner == 2
    listed = jobs.describe_waiting(jobs.waiting(w.state, "local", ("report",)))
    assert ("request 1: remove the copy of one file (github.com/oscr-fixture/eeg-analysis: plot.py) of doi:10.5555/oscr.fixture.1 "
            "(incorrect), from Ben Example, GitHub ben-example, as the holder of the rights") in listed
    assert "    evidence: https://lab.example/notice" in listed
    assert "    confirmed: the information is accurate, and they read how requests are decided" in listed
    assert "    the rules (report.review) close it by themselves on 26 October 2026" in listed
    assert ("request 2: remove the tracing map of doi:10.5555/oscr.fixture.2 (personal_data), from Ben Example, GitHub ben-example, "
            "as a person named in the record") in listed


def test_the_command_line_lists_and_accepts_a_scope(w, tmp_path, monkeypatch, capsys):
    rid = ask(w, scope="repository", scope_repo=EEG)
    monkeypatch.setattr(community, "open_d1", lambda target, **kw: w.d1)
    monkeypatch.setattr(jobs, "MacHarvester", lambda client, opts: w.harvester)
    monkeypatch.setattr(cli, "settings", lambda: {})
    base = ["--db", str(tmp_path / "mac.db"), "--cache", str(tmp_path / "cache")]      # the world's database
    folder = ["--folder", str(tmp_path / "community")]
    assert cli.main([*base, "jobs", "poll", "--local", *folder]) == 0
    capsys.readouterr()
    assert cli.main([*base, "reports", "list", *folder]) == 0
    assert f"request {rid}: remove the copies of one repository ({EEG}) of {P1}" in capsys.readouterr().out
    assert cli.main([*base, "reports", "accept", str(rid), "--local", "--message", "Withheld.", *folder]) == 0
    assert f"accepted — the copies of one repository ({EEG}) leaves the site at the next nightly" in capsys.readouterr().out
    assert [tuple(r) for r in w.mac.execute("SELECT scope, article_id, repo, path, request FROM withheld")] == [
        ("repository", P1, EEG, "", f"local:{rid}")]
    assert w.row("reports", rid)["status"] == "accepted" and w.row("reports", rid)["message"] == "Withheld."


def test_a_rejected_request_withholds_nothing(w, tmp_path):
    rid = ask(w, scope="scripts")
    w.poll()
    jobs.decide_report(w.runner, rid, False, "The code is under MIT: its copy is allowed.")
    assert w.row("reports", rid)["status"] == "rejected"
    assert catalog.withheld(w.mac) == catalog.Withheld()
    out = export(w, tmp_path)
    assert all(t for t in texts(out["lots"], EEG).values())


def test_what_the_owner_is_told_is_checked(w):
    for scope, values in (("repository", {}), ("file", {"repo": EEG}), ("everything", {})):
        with pytest.raises(ValueError):
            jobs.withhold(w.mac, scope, P1, **values)


# ---------------------------------------------------------------------------------------
# Each scope, in the public export.

def test_the_copies_of_the_papers_scripts(w, tmp_path):
    rid = ask(w, scope="scripts")
    w.poll()
    assert "the copies of the authors' scripts leaves the site" in jobs.decide_report(w.runner, rid, True)
    out = export(w, tmp_path)
    # The site's lots: the files listed with their link to the source, no text.
    entry = out["lots"][EEG]
    assert entry["published"] is False
    assert set(texts(out["lots"], EEG).values()) == {None}
    assert {f["note"] for f in entry["files"]} == {catalog.NOTE_WITHHELD}
    assert all(f["source_url"].startswith("https://github.com/oscr-fixture/eeg-analysis/blob/") for f in entry["files"])
    # The record stays, its map and its matches too.
    a = article(out, P1)
    assert a["code"][0]["repo"] == EEG and a["card"] and a["alignment"]["pairs"] == 2
    assert out["papers"][P1]["map"]["status"] == "validated"
    # The public database: no text; the table of what is withheld stays on the Mac.
    assert out["db"].execute("SELECT COUNT(*) FROM file WHERE repo = ? AND text IS NOT NULL", (EEG,)).fetchone()[0] == 0
    assert out["db"].execute("SELECT COUNT(*) FROM article WHERE id = ?", (P1,)).fetchone()[0] == 1
    assert out["db"].execute("SELECT name FROM sqlite_master WHERE name = 'withheld'").fetchone() is None
    # Hugging Face: the repository is not published (its manifest is withdrawn at the next build).
    assert EEG not in {r["repo"] for r, _, _ in scriptstore._publishable(w.mac)}


def test_one_repositorys_copies(w, tmp_path):
    rid = ask(w, scope="repository", scope_repo=EEG)
    w.poll()
    jobs.decide_report(w.runner, rid, True)
    assert [tuple(r) for r in w.mac.execute("SELECT scope, repo, request, reason FROM withheld")] == [
        ("repository", EEG, f"local:{rid}", "other")]
    out = export(w, tmp_path)
    assert set(texts(out["lots"], EEG).values()) == {None}
    assert out["db"].execute("SELECT DISTINCT note FROM file WHERE repo = ?", (EEG,)).fetchall() == [(catalog.NOTE_WITHHELD,)]
    # Another paper's repository is not touched (it was never copied: no license).
    assert out["lots"][UNLICENSED]["files"][0]["note"] == catalog.NOTE_NO_LICENSE


def test_one_file(w, tmp_path):
    rid = ask(w, scope="file", scope_repo=EEG, scope_path="plot.py")
    w.poll()
    jobs.decide_report(w.runner, rid, True)
    out = export(w, tmp_path)
    shown = texts(out["lots"], EEG)
    assert shown["plot.py"] is None and shown["analysis.py"] and shown["LICENSE"]
    assert out["lots"][EEG]["published"] is True
    assert next(f for f in out["lots"][EEG]["files"] if f["path"] == "plot.py")["note"] == catalog.NOTE_WITHHELD
    assert dict(out["db"].execute("SELECT path, text IS NULL FROM file WHERE repo = ?", (EEG,)).fetchall()) == {
        "LICENSE": 0, "analysis.py": 0, "plot.py": 1}
    published = next(files for r, _, files in scriptstore._publishable(w.mac) if r["repo"] == EEG)
    assert [f["path"] for f in published] == ["LICENSE", "analysis.py"]
    # The matches on that file stay: a paragraph number and line numbers, never its text.
    assert article(out, P1)["alignment"]["pairs"] == 2


def test_the_tracing_map(w, tmp_path):
    rid = ask(w, scope="map", reason="not_my_work")
    w.poll()
    assert "the tracing map leaves the site" in jobs.decide_report(w.runner, rid, True, "Hidden.")
    out = export(w, tmp_path)
    a = article(out, P1)
    assert a["card"] is None and a["alignment"] is None and a["map_withheld"] is True
    assert P1 not in out["alignments"]
    m = out["papers"][P1]["map"]
    assert (m["status"], m["digest"], m["validated_by"], m["doi"], m["pairs"]) == ("withheld", "", [], "", 0)
    assert out["papers"][P1]["cite"]["map"] is None
    # The public database: neither the matches, nor the validation, nor the DOI.
    for table in ("alignment", "validation", "card_doi"):
        assert out["db"].execute(f"SELECT COUNT(*) FROM {table} WHERE article_id = ?", (P1,)).fetchone()[0] == 0, table
    # The copies stay; the other papers keep what they have.
    assert all(texts(out["lots"], EEG).values())
    assert "map_withheld" not in article(out, P2)
    # The search's rows: no match, no map DOI.
    state = d1.open_state(tmp_path / "d1.db")
    row = next(r for p in d1.project(w.mac, state).papers.values() if p.article_id == P1 for r in p.rows if r.table == "papers")
    assert row.values["has_alignment"] == 0 and "map" not in json.loads(row.values["doc"])
    # A validation that comes anyway is refused, in words.
    vid = w.request("validations", "validation", {"user_id": "u_ada", "paper_id": P1, "orcid": "0000-0000-0000-001X",
                                                   "proof": "orcid-sandbox", "map_digest": "ab" * 32, "created_at": T})
    w.poll()
    assert w.row("validations", vid)["status"] == "refused"
    assert "withheld" in w.row("validations", vid)["message"]


def test_a_request_made_before_the_page_is_about_the_whole_record(w, tmp_path):
    rid = w.request("reports", "report", {"user_id": "u_ben", "target_kind": "paper", "target_id": P2,
                                           "reason": "author_request", "created_at": T})
    w.poll()
    assert "the whole record leaves the site" in jobs.decide_report(w.runner, rid, True)
    assert w.mac.execute("SELECT withdrawn FROM article WHERE id = ?", (P2,)).fetchone()[0].endswith(f"request {rid} (author_request)")
    assert catalog.withheld(w.mac) == catalog.Withheld()
    out = export(w, tmp_path)
    assert P2 not in {a["id"] for a in out["catalog"]["articles"]}


def test_a_version_7_database_gets_the_table_of_what_is_withheld(tmp_path, monkeypatch):
    early = tmp_path / "migrations"
    early.mkdir()
    for f in sorted(db.MIGRATIONS.glob("000[4-7]_*.sql")):
        (early / f.name).write_text(f.read_text())
    monkeypatch.setattr(db, "MIGRATIONS", early)
    old = db.open_db(tmp_path / "seven.db")
    assert catalog.withheld(old) == catalog.Withheld()          # before the table: nothing withheld
    old.execute("INSERT INTO article (id, doi, title, updated_at) VALUES ('doi:10.1/a', '10.1/a', 'T', 0)")
    old.commit()
    old.close()
    monkeypatch.undo()
    con = db.open_db(tmp_path / "seven.db")
    assert int(con.execute("SELECT value FROM meta WHERE name = 'schema_version'").fetchone()[0]) == db.SCHEMA_VERSION >= 8
    assert con.execute("SELECT title FROM article").fetchone()[0] == "T"
    jobs.withhold(con, "map", "doi:10.1/a", request="remote:1", reason="retracted", now=T)
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO withheld (scope, article_id, repo, created_at) VALUES ('map', 'doi:10.1/a', 'github.com/a/b', 0)")
    assert catalog.withheld(con).maps == frozenset({"doi:10.1/a"})
