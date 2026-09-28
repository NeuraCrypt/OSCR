"""Phase 3, the search: the D1 projection (oscr/d1.py) on synthetic databases. The generated SQL
is applied to SQLite databases built from the real D1 migrations (migrations/d1/), then
searched the way the Worker searches them (website/worker/search.ts)."""
import json
import re
import sqlite3
from pathlib import Path

import pytest

from oscr import cli, d1, db

ROOT = Path(__file__).resolve().parents[1]
T0 = 1_790_000_000.0      # 2026-09-21


def fts5_ready() -> bool:
    try:
        c = sqlite3.connect(":memory:")
        c.execute("CREATE VIRTUAL TABLE t USING fts5(a, b UNINDEXED, content='', contentless_delete=1, "
                  "contentless_unindexed=1)")
        return True
    except sqlite3.Error:
        return False


needs_fts5 = pytest.mark.skipif(not fts5_ready(), reason="this SQLite has no FTS5 contentless_unindexed (3.47+)")


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "mac.db")
    yield c
    c.close()


@pytest.fixture
def state():
    s = d1.open_state(":memory:")
    yield s
    s.close()


def paper(con, n: int, status: str = "code_verified", *, on_topic: str = "yes", published: str = "2026-09-01",
          license: str = "cc by", abstract: str = "", title: str | None = None, journal: str = "Journal of Tests",
          scanned: bool = True) -> str:
    aid = f"doi:10.5555/test.{n}"
    db.save_article(con, {"id": aid, "doi": f"10.5555/test.{n}", "title": title or f"Paper {n} on EEG",
                          "journal": journal, "published": published, "license": license,
                          "authors": ["A Author", "B Author"]})
    if scanned:
        db.mark_scanned(con, aid, has_fulltext=True, has_statement=True, code_on_request=False, data_on_request=False,
                        families=[], methods=[])
    con.execute("UPDATE article SET status = ?, on_topic = ?, abstract = ?, scanned_at = ?, type = 'research-article', "
                "cited_by_count = ?, is_open_access = 1 WHERE id = ?",
                (status, on_topic, abstract, T0 + n if scanned else None, n, aid))
    return aid


def code(con, aid: str, repo: str, *, license: str = "MIT", languages: dict | None = None, tools=()) -> None:
    con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind, state, license, languages) "
                "VALUES (?, ?, 'github.com', 'git', 'alive', ?, ?)",
                (repo, f"https://{repo}", license, json.dumps(languages or {"Python": 3})))
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                "VALUES (?, ?, ?, 'github.com', 'git', 'code', 'high', 'text:availability')", (aid, repo, f"https://{repo}"))
    for t in tools:
        con.execute("INSERT OR IGNORE INTO tool (id, name) VALUES (?, ?)", (t.lower(), t))
        con.execute("INSERT OR IGNORE INTO repo_tool (repo, tool_id, evidence) VALUES (?, ?, 3)", (repo, t.lower()))


def category(con, aid: str, facet: str, value: str, confidence: float = 0.9, ambiguous: int = 0) -> None:
    con.execute("INSERT INTO paper_category (article_id, facet, value, confidence, method, ambiguous) "
                "VALUES (?, ?, ?, ?, 'rule', ?)", (aid, facet, value, confidence, ambiguous))


def d1_databases() -> dict[str, sqlite3.Connection]:
    out = {}
    for role in (d1.CATALOG, d1.SEARCH):
        c = sqlite3.connect(":memory:")
        for f in sorted((d1.MIGRATIONS / role).glob("*.sql")):
            c.executescript(f.read_text())
        out[role] = c
    return out


def push_to(dbs: dict[str, sqlite3.Connection], plan: d1.Plan, state, *, now: float | None = None) -> None:
    """What `oscr d1 push` does, with in-memory SQLite databases standing for D1."""
    for chunk in d1.chunks(plan):
        dbs[chunk.db].executescript(chunk.sql)
        d1.record(state, plan.target, chunk, sum(s.rows for s in chunk.statements), now=now)


def sql_of(plan: d1.Plan) -> str:
    return "\n".join(s.sql for s in plan.statements)


# ---------------------------------------------------------------------------------------


def test_scope_is_the_papers_with_a_page_and_on_topic(con, state):
    keep = [paper(con, 1, "code_verified"), paper(con, 2, "on_request", on_topic=""), paper(con, 3, "data_only"),
            paper(con, 4, "code_dead")]
    paper(con, 5, "none")
    paper(con, 6, "code_verified", on_topic="no")            # off-topic: stays on the Mac (D7)
    paper(con, 7, "data_only", on_topic="no")
    paper(con, 8, "code_found", scanned=False)
    paper(con, 9, "no_fulltext")
    proj = d1.project(con, state)
    assert sorted(p.article_id for p in proj.papers.values()) == sorted(keep)


def test_keys_follow_the_publication_date_and_stay(con, state):
    a = paper(con, 1, published="2026-09-21")
    b = paper(con, 2, published="2026-09-21")
    c = paper(con, 3, published="2026-09")
    e = paper(con, 4, published="2026")
    f = paper(con, 5, published="")
    pids = {p.article_id: p.pid for p in d1.project(con, state).papers.values()}
    assert pids == {a: 2026092100000, b: 2026092100001, c: 2026090000000, e: 2026000000000, f: 0}
    assert {p.article_id: p.pid for p in d1.project(con, state).papers.values()} == pids
    # A new date, a new key; the old one is never given to another paper.
    con.execute("UPDATE article SET published = '2025-01-02' WHERE id = ?", (a,))
    g = paper(con, 6, published="2026-09-21")
    pids2 = {p.article_id: p.pid for p in d1.project(con, state).papers.values()}
    assert pids2[a] == 2025010200000
    assert pids2[g] == 2026092100002


def test_no_address_and_no_closed_abstract_leave(con, state):
    a = paper(con, 1, license="cc by-nc-nd", abstract="CLOSEDABSTRACTWORDS about spikes",
              title="Spikes (correspondence: bob.smith@uni.example.edu)")
    b = paper(con, 2, license="cc by 4.0", abstract="OPENABSTRACTWORDS about oscillations")
    for aid in (a, b):
        con.execute("INSERT INTO paper_author (article_id, position, name, affiliations) VALUES (?, 1, ?, ?)",
                    (aid, "Ada Lovelace ada@lab.example.org", json.dumps(["Lab, Univ. Electronic address: x@y.org"])))
    plan = d1.build(con, state)
    everything = sql_of(plan)
    assert "CLOSEDABSTRACTWORDS" not in everything
    assert re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", everything) is None
    assert "Ada Lovelace" in everything
    # An open abstract is indexed (oscr_search) but is never a result row (oscr_catalog).
    search = "\n".join(s.sql for s in plan.statements if s.db == d1.SEARCH)
    catalog = "\n".join(s.sql for s in plan.statements if s.db == d1.CATALOG)
    assert "OPENABSTRACTWORDS" in search
    assert "OPENABSTRACTWORDS" not in catalog


@needs_fts5
def test_the_databases_answer_as_the_worker_asks(con, state):
    a = paper(con, 1, published="2026-09-21", abstract="alpha oscillations in the hippocampus", journal="NeuroImage")
    code(con, a, "github.com/lab/eeg-tools", languages={"Python": 4, "MATLAB": 1}, tools=["MNE-Python"])
    category(con, a, "modality", "eeg")
    category(con, a, "modality", "fmri", confidence=0.4)                  # too weak: not shown, not filtered
    b = paper(con, 2, "on_request", published="2025-03", journal="Neuroimage")
    category(con, b, "modality", "fmri")
    c = paper(con, 3, "data_only", published="2024-01-05", journal="NeuroImage", license="cc by-nc-nd",
              abstract="hippocampus closed")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                "VALUES (?, 'openneuro:ds000117', 'https://openneuro.org/datasets/ds000117', 'openneuro.org', 'data', "
                "'data', 'high', 'text:availability')", (c,))
    con.execute("INSERT INTO alignment (article_id, pair, paragraph, repo, path, start_line, end_line, score, method, "
                "computed_at) VALUES (?, 1, 3, 'github.com/lab/eeg-tools', 'a.py', 1, 9, 0.9, 'lexical-v1', 0)", (a,))
    dbs = d1_databases()
    plan = d1.build(con, state)
    push_to(dbs, plan, state)
    pid = {p.article_id: p.pid for p in d1.project(con, state).papers.values()}

    def match(expression: str) -> list[int]:
        return [r[0] for r in dbs[d1.SEARCH].execute(
            "SELECT rowid FROM paper_fts WHERE paper_fts MATCH ? ORDER BY rowid DESC", (expression,))]

    token = d1.facet_token
    assert match(f'{{facets}} : "{token("mo", "eeg")}"') == [pid[a]]
    assert match(f'{{facets}} : "{token("mo", "fmri")}"') == [pid[b]]
    assert match(f'{{facets}} : "{token("to", "mne-python")}"') == [pid[a]]          # case-insensitive
    assert match(f'{{facets}} : "{token("jo", "neuroimage")}"') == [pid[a], pid[b], pid[c]]
    assert match(f'{{facets}} : "{token("st", "on_request")}"') == [pid[b]]
    assert match(f'{{facets}} : "{token("ds", "OpenNeuro")}"') == [pid[c]]
    assert match(f'{{facets}} : "{token("al", "yes")}"') == [pid[a]]
    assert match(f'{{facets}} : "{token("la", "matlab")}"') == [pid[a]]
    assert match(f'{{facets}} : "{d1.ALL_TOKEN}"') == [pid[a], pid[b], pid[c]]
    assert match('{title keywords mesh authors journal repos tools ids abstract} : "hippocampus"') == [pid[a]]
    assert match('{ids} : "ds000117"') == [pid[c]]
    assert match('{repos} : "eeg-tools"') == [pid[a]]
    # The key is the date: newest first is the rowid order, a year a key range.
    assert [r[0] for r in dbs[d1.SEARCH].execute(
        "SELECT rowid FROM paper_fts WHERE paper_fts MATCH ? AND rowid BETWEEN ? AND ?",
        (f'{{facets}} : "{d1.ALL_TOKEN}"', 20250000 * d1.KEY_DAY, 20259999 * d1.KEY_DAY + 99_999))] == [pid[b]]

    fx = json.loads(dbs[d1.SEARCH].execute("SELECT fx FROM paper_fts WHERE rowid = ?", (pid[a],)).fetchone()[0])
    assert fx[0] == 1                                                   # cited_by_count
    pairs = set(zip(fx[1::2], fx[2::2], strict=True))
    assert {("st", "code_verified"), ("yr", "2026"), ("mo", "eeg"), ("to", "MNE-Python"), ("la", "MATLAB"),
            ("la", "Python"), ("ho", "github.com"), ("cl", "MIT"), ("li", "CC BY"), ("al", "yes"),
            ("jo", "NeuroImage"), ("ty", "research-article"), ("oa", "yes")} <= pairs
    assert ("mo", "fmri") not in pairs

    doc = json.loads(dbs[d1.CATALOG].execute("SELECT doc FROM papers WHERE pid = ?", (pid[a],)).fetchone()[0])
    assert doc == {"slug": "doi_10.5555_test.1", "doi": "10.5555/test.1", "title": "Paper 1 on EEG",
                   "journal": "NeuroImage", "published": "2026-09-21", "status": "code_verified",
                   "code": [{"name": "lab/eeg-tools", "url": "https://github.com/lab/eeg-tools", "license": "MIT"}],
                   "data": 0, "files": 0, "pairs": 1, "cited": 1}
    counts = {(f, v): n for f, v, n in dbs[d1.CATALOG].execute("SELECT facet, value, papers FROM facet_counts")}
    assert counts[("journal", "NeuroImage")] == 3                       # one spelling for one journal
    assert counts[("modality", "eeg")] == 1 and counts[("status", "on_request")] == 1
    assert dbs[d1.CATALOG].execute("SELECT value FROM meta WHERE name = 'papers'").fetchone()[0] == "3"
    # The citation sort without a query reads the index.
    plan_sql = dbs[d1.CATALOG].execute("EXPLAIN QUERY PLAN SELECT pid, doc FROM papers "
                                       "ORDER BY cited_by_count DESC, pid DESC LIMIT 20").fetchall()
    assert "papers_cited" in str(plan_sql)


@needs_fts5
def test_only_the_rows_that_changed_are_pushed(con, state):
    ids = [paper(con, n) for n in range(1, 6)]
    dbs = d1_databases()
    first = d1.build(con, state, now=T0)
    assert (first.new, first.changed, first.deleted) == (5, 0, 0)
    push_to(dbs, first, state, now=T0)
    assert d1.build(con, state, now=T0 + 60).statements == []          # nothing changed: nothing sent
    con.execute("UPDATE article SET title = 'A new title' WHERE id = ?", (ids[2],))
    again = d1.build(con, state, now=T0 + 120)
    assert (again.new, again.changed) == (0, 1)
    assert sorted((s.db, s.table) for s in again.statements) == [
        ("catalog", "meta"), ("catalog", "papers"), ("search", "paper_fts")]    # + meta.updated_at
    push_to(dbs, again, state)
    assert dbs[d1.CATALOG].execute("SELECT count(*) FROM papers WHERE title = 'A new title'").fetchone()[0] == 1
    # A local and a remote target keep their own state.
    assert len(d1.build(con, state, "remote").statements) > len(first.statements) - 5


@needs_fts5
def test_papers_leaving_the_scope_are_deleted(con, state):
    a, b, c = paper(con, 1), paper(con, 2, "on_request"), paper(con, 3)
    dbs = d1_databases()
    push_to(dbs, d1.build(con, state), state)
    con.execute("UPDATE article SET on_topic = 'no' WHERE id = ?", (a,))      # judged off-topic (D7)
    con.execute("UPDATE article SET status = 'none' WHERE id = ?", (b,))      # no page any more (D2)
    plan = d1.build(con, state)
    assert plan.deleted == 2
    assert {s.sql.split(" WHERE")[0] for s in plan.statements if s.hash is None} >= {
        "DELETE FROM papers", "DELETE FROM paper_fts"}
    # Deletions leave the index before anything else is written.
    first = d1.chunks(plan)[0]
    assert first.db == d1.SEARCH and all(s.hash is None for s in first.statements)
    push_to(dbs, plan, state)
    assert dbs[d1.CATALOG].execute("SELECT id FROM papers").fetchall() == [(c,)]
    assert len(dbs[d1.SEARCH].execute("SELECT rowid FROM paper_fts WHERE paper_fts MATCH 'eeg'").fetchall()) == 1
    assert dbs[d1.CATALOG].execute("SELECT value FROM meta WHERE name = 'papers'").fetchone()[0] == "1"
    assert d1.build(con, state).statements == []


@needs_fts5
def test_the_daily_budget_stops_between_two_papers(con, state):
    for n in range(1, 11):
        paper(con, n, published=f"2026-09-{n:02d}")
    dbs = d1_databases()
    per_paper = d1.WRITE_COST[(d1.CATALOG, "papers")] + d1.WRITE_COST[(d1.SEARCH, "paper_fts")]
    budget = d1.SUMMARY_RESERVE + 3 * per_paper
    day1 = T0
    plan = d1.build(con, state, budget=budget, now=day1)
    assert (plan.new, plan.deferred) == (3, 7)
    assert not plan.complete
    # Whole papers only, the most recent first.
    papers = sorted(int(s.key) for s in plan.statements if s.table == "papers")
    fts = sorted(int(s.key) for s in plan.statements if s.table == "paper_fts")
    assert papers == fts == [2026090800000, 2026090900000, 2026091000000]
    push_to(dbs, plan, state, now=day1)
    # The counts describe what D1 holds: three papers.
    assert dbs[d1.CATALOG].execute("SELECT value FROM meta WHERE name = 'papers'").fetchone()[0] == "3"
    assert d1.budget_spent(state, "local", d1.utc_day(day1)) == plan.rows
    # The same day, the budget is spent: nothing more.
    later = d1.build(con, state, budget=budget, now=day1 + 60)
    assert later.statements == [] and later.deferred == 7
    # The next day, the rest.
    day2 = day1 + 86_400
    rest = d1.build(con, state, budget=d1.DAILY_BUDGET, now=day2)
    assert (rest.new, rest.deferred) == (7, 0)
    push_to(dbs, rest, state, now=day2)
    assert dbs[d1.CATALOG].execute("SELECT count(*) FROM papers").fetchone()[0] == 10
    assert dbs[d1.CATALOG].execute("SELECT value FROM meta WHERE name = 'papers'").fetchone()[0] == "10"


def test_the_facet_table_is_the_websites(con):
    ts = (ROOT / "website" / "src" / "lib" / "facets.ts").read_text()
    table = [(m[0], m[1], int(m[2])) for m in re.findall(r'\{ param: "(\w+)", code: "(\w+)", label: "[^"]*", top: (\d+) \}', ts)]
    assert table == list(d1.FACETS)
    assert re.search(r'ALL_TOKEN = "(\w+)"', ts)[1] == d1.ALL_TOKEN
    # The same test vectors as website/tests/search.test.ts.
    assert d1.facet_token("mo", "eeg") == "zzmo135b0779d467"
    assert d1.facet_token("jo", "  NeuroImage ") == d1.facet_token("jo", "neuroimage")
    assert d1.normalize_value("Ｃ／Ｃ＋＋  Code") == "c/c++ code"


def test_literals_carry_any_text():
    assert d1.literal("O'Neil; DROP TABLE papers; --") == "'O''Neil; DROP TABLE papers; --'"
    assert d1.literal("a\x00b") == "'ab'"
    assert d1.literal(None) == "NULL" and d1.literal(True) == "1" and d1.literal(3) == "3"
    assert d1.literal(float("nan")) == "NULL"
    c = sqlite3.connect(":memory:")
    c.executescript((d1.MIGRATIONS / "catalog" / "0001_catalog.sql").read_text())
    text = "line one;\nline 'two'; -- not a comment\n\"three\""
    row = d1.Row(d1.CATALOG, "meta", "x", {"name": "x", "value": text})
    c.executescript(d1.upsert(row))
    c.executescript(d1.upsert(row))                                   # an upsert, again
    assert c.execute("SELECT value FROM meta").fetchall() == [(text,)]


def test_families_and_names():
    assert d1.article_license("cc by-nc-nd") == "CC BY-NC-ND"
    assert d1.article_license("cc by 4.0") == "CC BY"
    assert d1.article_license("CC0") == "CC0"
    assert d1.article_license("") == ""
    assert [d1.code_license(x) for x in ("MIT", "GPL-3.0", "gpl", "AGPL-3.0", "CC-BY-NC-SA-4.0", "", "other-open")] == [
        "MIT", "GPL", "GPL", "GPL", "CC BY-NC-SA", "none", "other"]
    assert d1.short_name("github.com/lab/eegtools", "https://github.com/Lab/EEGTools") == "Lab/EEGTools"
    assert d1.short_name("zenodo:123", "https://zenodo.org/records/123") == "Zenodo 123"
    assert d1.day_key("2026-09-21") == 20260921 and d1.day_key("x") == 0
    assert d1.clean("&lt;i&gt;PIK3CA&lt;/i&gt;-related, p < 0.05 and q > 1") == "PIK3CA-related, p < 0.05 and q > 1"
    assert d1.clean("Ca<sup>2+</sup> imaging<br/>in vivo") == "Ca2+ imaging in vivo"


def test_sql_files_and_the_cli(con, tmp_path, capsys):
    for n in range(1, 4):
        paper(con, n)
    con.commit()
    cli.main(["--db", str(tmp_path / "mac.db"), "d1", "build", "--state", str(tmp_path / "state.db"),
              "--sql-dir", str(tmp_path / "sql")])
    out = capsys.readouterr().out
    assert re.search(r"local: \d+ statements, ~\d+ rows written of 80000 left today; papers: 3 new", out)
    files = sorted((tmp_path / "sql").glob("local-*/*.sql"))
    assert [f.name for f in files] == ["001-oscr_catalog.sql", "002-oscr_search.sql"]
    assert files[1].read_text().count("INSERT OR REPLACE INTO paper_fts") == 3
    cli.main(["--db", str(tmp_path / "mac.db"), "d1", "status", "--state", str(tmp_path / "state.db")])
    assert "nothing pushed yet" in capsys.readouterr().out


@needs_fts5
def test_reset_sends_everything_again(con, state):
    for n in range(1, 4):
        paper(con, n)
    push_to(d1_databases(), d1.build(con, state), state)
    assert d1.build(con, state).statements == []
    assert d1.forget(state, "local") > 0
    again = d1.build(con, state)
    assert again.new == 3
    assert {s.key for s in again.statements if s.table == "papers"} == {
        str(p.pid) for p in d1.project(con, state).papers.values()}           # the same keys


def test_without_a_token_the_remote_push_goes_through_wranglers_login(con, state, tmp_path, monkeypatch):
    for n in range(1, 4):
        paper(con, n)
    con.commit()
    calls = []
    monkeypatch.setattr(d1, "remote_token", lambda: "")
    monkeypatch.setattr(d1, "_run", lambda cmd, cwd: calls.append(cmd) or "")
    plan = d1.push(con, state, "remote", folder=tmp_path / "sql", settings={}, report=lambda _: None)
    assert calls and all(c[:4] == ["npx", "wrangler", "d1", "execute"] and "--remote" in c and "--file" in c
                         for c in calls)
    assert {c[4] for c in calls} == {"oscr_catalog", "oscr_search"}
    assert plan.applied == len(plan.statements) and plan.written > 0
    assert d1.build(con, state, "remote").statements == []          # recorded: nothing left to send
    assert not list((tmp_path / "sql").glob("remote-*/*.sql"))       # applied: the files are not kept


def test_the_night_pushes_the_search_once_the_settings_say_so(tmp_path, monkeypatch, capsys):
    from oscr import catalog
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(catalog, "generate", lambda con, out, public: out)
    monkeypatch.setattr(d1, "command", lambda con, action, **kw: calls.append((action, kw["target"])) or "pushed")
    for settings, pushes in (({}, []), ({"OSCR_D1_PUSH": "remote"}, [("push", "remote")])):
        calls.clear()
        monkeypatch.setattr(cli, "settings", lambda s=settings: dict(s))
        cli.main(["--db", str(tmp_path / "mac.db"), "nightly", "--out", str(tmp_path / "out")])
        assert calls == pushes
    assert "search (D1): pushed" in capsys.readouterr().out
