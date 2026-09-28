"""OSCR's layer over the GitHub repositories, on the Mac (oscr/forgelayer.py, night phase 01): the
traced paths pushed as deltas into D1 `oscr_forge`, and the static shards for signed-out readers.
The Mac database is the fixture's synthetic one (tools/make_fixture.py) plus cases of its own; D1
is `forge_d1` (an SQLite database made from migrations/d1-forge/); the forge is
`oscr.forge.MemoryReader`. No network, no git."""
import dataclasses
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402

from oscr import cli, community, forgelayer  # noqa: E402
from oscr import forge as forges  # noqa: E402

PAPER_1, PAPER_2, PAPER_9 = (f"doi:10.5555/oscr.fixture.{n}" for n in (1, 2, 9))
COMMIT = make_fixture.COMMIT
LATER = "1" * 40
#: 2026-09-28 12:00 UTC, and the next day.
T = 1_790_596_800.0
DAY = 86_400.0
EMAIL = re.compile(r"[\w.+-]+\s*(?:@|＠)\s*[\w-]+(?:\.[\w-]+)+")


def _link(con: sqlite3.Connection, article_id: str, url: str, role: str = "code") -> str:
    repo = url.removeprefix("https://").lower()
    con.execute("INSERT OR IGNORE INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                "VALUES (?, ?, ?, 'github.com', 'forge', ?, 'high', 'text')", (article_id, repo, url, role))
    return repo


def _mac(tmp_path: Path) -> sqlite3.Connection:
    """The fixture's database, with: a title carrying an email address, a GitHub repository only the
    catalogue links, one that turned private, a GitLab one (not in the layer), and the off-topic
    paper's GitHub code (never in the layer)."""
    con = make_fixture.database(tmp_path / "mac.db")
    con.execute("UPDATE article SET title = title || ' (correspondence: ada.lovelace@example.org)' WHERE id = ?",
                (PAPER_1,))
    _link(con, PAPER_1, "https://github.com/oscr-fixture/catalogue-only")
    _link(con, PAPER_2, "https://github.com/oscr-fixture/turned-private")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES (?, "
                "'gitlab.com/group/tool', 'https://gitlab.com/group/tool', 'gitlab.com', 'forge', 'code', 'high', 'text')",
                (PAPER_1,))
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES (?, "
                "'github.com/elsewhere/off-topic-code', 'https://github.com/elsewhere/off-topic-code', 'github.com', "
                "'forge', 'code', 'high', 'text')", (PAPER_9,))
    con.commit()
    return con


def _reader() -> forges.MemoryReader:
    reader = forges.MemoryReader()
    for owner, name, ident in (("oscr-fixture", "eeg-analysis", "101"), ("oscr-fixture", "unlicensed", "102"),
                               ("oscr-fixture", "catalogue-only", "103"), ("oscr-fixture", "turned-private", "104")):
        reader.add(owner, name, id=ident, files={"a.py": b"x = 1\n"}, sha=COMMIT)
    private = reader._repos["104"]
    private.info = dataclasses.replace(private.info, visibility="private")
    return reader


def _state() -> sqlite3.Connection:
    return forgelayer.prepare(community.open_state(":memory:"))


def _repo(d1: community.SqliteD1, repo_id: str, owner: str, name: str, *, mode: str = "public",
          state: str = "active", head: str | None = None, installation: str | None = None,
          delete_after: int | None = None) -> None:
    d1.run([f"INSERT INTO repos (forge, repo_id, owner_id, owner_login, name, mode, installation_id, head, head_at, "
            f"state, delete_after, linked_by, created_at, updated_at) VALUES ('github', '{repo_id}', '9', '{owner}', "
            f"'{name}', '{mode}', {community.literal(installation)}, {community.literal(head)}, "
            f"{1_790_500_000 if head else 'NULL'}, '{state}', {community.literal(delete_after)}, 'u1', 1, {int(T)})"])


def _shards(out: Path) -> dict[str, dict]:
    return {p.name: json.loads(p.read_text()) for p in sorted((out / "forge" / "layer").iterdir())}


def _entries(out: Path) -> dict[str, dict]:
    return {k: v for shard in _shards(out).values() for k, v in shard.items()}


# ---------------------------------------------------------------------------------------------
# The shards.

def test_the_shard_numbers_equal_the_fixture_pairs():
    fixture = json.loads((ROOT / "tests" / "fixtures" / "forge-shards.json").read_text())
    for path, expected in fixture["pairs"]:
        owner, name = path.split("/")
        assert forgelayer.shard(owner, name) == expected, path
    # The website's rule, restated: the first byte of SHA-256 of the lower-case path, mod 64.
    assert forgelayer.shard("OSCR-Fixture", "EEG-Analysis") == \
        f"{hashlib.sha256(b'oscr-fixture/eeg-analysis').digest()[0] % 64:02d}"


def test_at_most_64_files_whatever_the_number_of_repositories(tmp_path):
    con = _mac(tmp_path)
    for i in range(1_000):
        _link(con, PAPER_1, f"https://github.com/lab-{i % 37}/pipeline-{i}")
    out = tmp_path / "public"
    said = forgelayer.write(con, None, out, state=_state(), now=T)
    shards = _shards(out)
    assert sorted(shards) == [f"{n:02d}.json" for n in range(64)]
    entries = _entries(out)
    assert len(entries) == 1_000 + 4 and "1004 repositories in 64 shards" in said
    for name, shard in shards.items():
        for key in shard:
            assert f"{forgelayer.shard(*key.split('/'))}.json" == name and key == key.lower()
    # Even with no repository at all: 64 shards, each an empty object.
    empty = tmp_path / "empty"
    forgelayer.write(_bare(tmp_path), None, empty, state=_state())
    assert list(_shards(empty).values()) == [{}] * 64


def _bare(tmp_path: Path) -> sqlite3.Connection:
    """A Mac database without any code link."""
    from oscr import db
    return db.open_db(tmp_path / "bare.db")


def test_output_is_written_only_under_forge_layer(tmp_path):
    con = _mac(tmp_path)
    out = tmp_path / "public"
    out.mkdir()
    forgelayer.write(con, None, out, state=_state(), now=T)
    written = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())
    assert written == [f"forge/layer/{n:02d}.json" for n in range(64)]
    # A second run replaces them in place: nothing left over.
    forgelayer.write(con, None, out, state=_state(), now=T)
    assert sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()) == written


def test_a_catalogue_only_repository_comes_in_with_mode_catalogue_and_its_paper(tmp_path, forge_d1):
    con, state, reader = _mac(tmp_path), _state(), _reader()
    forgelayer.push_traced(con, forge_d1, state, "local", reader=reader, now=T, report=lambda m: None)
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entries = _entries(out)
    e = entries["oscr-fixture/eeg-analysis"]
    assert e["forge"] == "github" and e["id"] == "101" and e["mode"] == "catalogue" and e["state"] == "active"
    # head_at: the fixture's commit date, 2026-09-20 12:00 UTC.
    assert e["head"] == COMMIT and e["head_at"] == 1_789_905_600 and e["last_seen"] == int(make_fixture.READ_AT)
    assert e["papers"] == [{"doi": "10.5555/oscr.fixture.1", "slug": "doi_10.5555_oscr.fixture.1",
                            "title": "A synthetic EEG study for the OSCR build test", "status": None}]
    assert e["maps"] == 1 and e["paths"] == 2 and e["unreachable"] == []
    assert entries["oscr-fixture/catalogue-only"]["mode"] == "catalogue"
    assert entries["oscr-fixture/unlicensed"]["papers"][0]["doi"] == "10.5555/oscr.fixture.2"
    # Not GitLab (the layer is GitHub's), not the off-topic paper's code (D7).
    assert not any(k.startswith(("group/", "elsewhere/")) for k in entries)
    # The catalogue's repositories cost no D1 row: only traced paths were written.
    assert forge_d1.query("SELECT COUNT(*) AS n FROM repos") == [{"n": 0}]


def test_hidden_pending_deleted_and_private_repositories_are_left_out(tmp_path, forge_d1):
    con, state, reader = _mac(tmp_path), _state(), _reader()
    _link(con, PAPER_1, "https://github.com/ada/being-deleted")
    con.commit()
    forgelayer.resolve_ids(con, state, reader, now=T)
    # eeg-analysis (101) was made private: hidden, its name blanked. unlicensed (102) waits for its
    # deletion. A repository created through OSCR, one deleted, one gone, one being deleted by path.
    _repo(forge_d1, "101", "", "", state="hidden")
    _repo(forge_d1, "102", "oscr-fixture", "unlicensed", state="pending_deletion", delete_after=int(T + 30 * DAY))
    _repo(forge_d1, "200", "ada", "compendium", mode="created", head=LATER)
    _repo(forge_d1, "201", "ada", "old", mode="created", state="deleted")
    _repo(forge_d1, "202", "ada", "vanished", mode="installed", installation="7", state="gone")
    _repo(forge_d1, "203", "ada", "being-deleted", state="pending_deletion", delete_after=int(T + DAY))
    forge_d1.run([f"INSERT INTO repo_papers (forge, repo_id, paper_id, status, by_user, at) VALUES "
                  f"('github', '200', '{PAPER_1}', 'linked', 'u1', 1), ('github', '200', '{PAPER_9}', 'linked', 'u1', 1), "
                  f"('github', '200', 'doi:10.9999/unknown', 'proposed', 'u2', 1)"])
    out = tmp_path / "public"
    said = forgelayer.write(con, forge_d1, out, state=state, now=T)
    entries = _entries(out)
    assert sorted(entries) == ["ada/compendium", "ada/vanished", "oscr-fixture/catalogue-only"]
    # Counted once each, by id: hidden (101), waiting (102, 203), deleted (201), private (104); the
    # catalogue's entries of 101, 102 and ada/being-deleted are the same repositories, not more.
    assert "5 left out" in said
    created = entries["ada/compendium"]
    assert created["mode"] == "created" and created["id"] == "200" and created["head"] == LATER
    # Its papers: the one the Mac knows, with its page; one it does not know; never the off-topic one.
    assert created["papers"] == [
        {"doi": "10.5555/oscr.fixture.1", "slug": "doi_10.5555_oscr.fixture.1",
         "title": "A synthetic EEG study for the OSCR build test", "status": "linked"},
        {"doi": "10.9999/unknown", "slug": None, "title": None, "status": "proposed"}]
    assert entries["ada/vanished"]["state"] == "gone" and entries["ada/vanished"]["mode"] == "installed"
    text = json.dumps(_shards(out))
    assert "turned-private" not in text and "eeg-analysis" not in text and "unlicensed" not in text


def test_a_linked_repository_is_merged_with_its_catalogue_entry_under_its_current_path(tmp_path, forge_d1):
    con, state, reader = _mac(tmp_path), _state(), _reader()
    forgelayer.resolve_ids(con, state, reader, now=T)
    # The researcher linked eeg-analysis (id 101) after renaming it.
    _repo(forge_d1, "101", "ada-lab", "eeg-analysis-2", mode="installed", installation="7", head=LATER)
    forge_d1.run([f"INSERT INTO repo_papers (forge, repo_id, paper_id, status, by_user, at) "
                  f"VALUES ('github', '101', '{PAPER_1}', 'linked', 'u1', 1)"])
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entries = _entries(out)
    assert "oscr-fixture/eeg-analysis" not in entries
    e = entries["ada-lab/eeg-analysis-2"]
    assert e["mode"] == "installed" and e["id"] == "101" and e["head"] == LATER and e["maps"] == 1
    assert e["papers"] == [{"doi": "10.5555/oscr.fixture.1", "slug": "doi_10.5555_oscr.fixture.1",
                            "title": "A synthetic EEG study for the OSCR build test", "status": "linked"}]
    assert e["last_seen"] == int(T)


def test_no_email_address_in_any_shard(tmp_path, forge_d1):
    con, state = _mac(tmp_path), _state()
    con.execute("UPDATE article SET title = 'Write to b.c@lab.example.edu or d [at] uni.example.org' WHERE id = ?",
                (PAPER_2,))
    con.commit()
    forgelayer.push_traced(con, forge_d1, state, "local", reader=_reader(), now=T, report=lambda m: None)
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    for name in _shards(out):
        text = (out / "forge" / "layer" / name).read_text()
        assert not EMAIL.search(text) and "@" not in text and "[at]" not in text, name
    assert _entries(out)["oscr-fixture/eeg-analysis"]["papers"][0]["title"] == \
        "A synthetic EEG study for the OSCR build test"


# ---------------------------------------------------------------------------------------------
# The traced paths.

def test_traced_paths_are_pushed_as_deltas(tmp_path, forge_d1):
    con, state, reader = _mac(tmp_path), _state(), _reader()
    quiet = {"report": lambda m: None}
    plan = forgelayer.push_traced(con, forge_d1, state, "local", reader=reader, now=T, **quiet)
    assert (plan.new, plan.changed, plan.deleted, plan.written) == (2, 0, 0, 2)
    rows = forge_d1.query("SELECT * FROM traced_paths ORDER BY path")
    assert rows == [{"forge": "github", "repo_id": "101", "path": p, "paper_id": PAPER_1, "commit_sha": COMMIT, "ranges": 1}
                    for p in ("analysis.py", "plot.py")]
    # Nothing changed: nothing written, and the forge is not asked again for the ids.
    asked = len(reader.calls)
    again = forgelayer.push_traced(con, forge_d1, state, "local", reader=reader, now=T, **quiet)
    assert again.statements == [] and again.written == 0 and len(reader.calls) == asked
    # A second line range on analysis.py: one row changed. The plot's match removed: one row deleted.
    con.execute("INSERT INTO alignment (article_id, pair, paragraph, section, repo, path, start_line, end_line, "
                "symbol, score, evidence, method, computed_at) VALUES (?, 3, 7, 'Methods', "
                "'github.com/oscr-fixture/eeg-analysis', 'analysis.py', 1, 2, '', 0.5, '[]', 'lexical-v1', 0)", (PAPER_1,))
    con.execute("DELETE FROM alignment WHERE article_id = ? AND pair = 2", (PAPER_1,))
    con.commit()
    third = forgelayer.push_traced(con, forge_d1, state, "local", reader=reader, now=T, **quiet)
    assert (third.new, third.changed, third.deleted) == (0, 1, 1)
    assert third.statements[0][2].startswith("DELETE FROM traced_paths")      # deletions first
    assert forge_d1.query("SELECT path, ranges FROM traced_paths") == [{"path": "analysis.py", "ranges": 2}]
    # Each target keeps its own record: a push to another target sends everything.
    other = forgelayer.build(con, state, "remote", now=T)
    assert other.new == 1 and other.deleted == 0
    assert "local: oscr_forge.traced_paths: 1 rows" in forgelayer.status(state)


def test_the_shared_daily_budget_is_respected(tmp_path, forge_d1):
    con, state = _mac(tmp_path), _state()
    quiet = {"report": lambda m: None, "reader": _reader()}
    first = forgelayer.push_traced(con, forge_d1, state, "local", budget=1, now=T, **quiet)
    assert first.written == 1 and first.deferred == 1 and not first.complete
    assert community.budget_spent(state, "local", community.utc_day(T)) == 1
    # The same day: the budget is spent, nothing more.
    assert forgelayer.push_traced(con, forge_d1, state, "local", budget=1, now=T + 60, **quiet).statements == []
    # The next day, the rest.
    nxt = forgelayer.push_traced(con, forge_d1, state, "local", budget=1, now=T + DAY, **quiet)
    assert nxt.written == 1 and nxt.complete
    assert forge_d1.query("SELECT COUNT(*) AS n FROM traced_paths") == [{"n": 2}]
    # The budget is the facts push's: rows it spent count here too.
    fresh = _state()
    community.spend(fresh, "local", 9_999, now=T)
    plan = forgelayer.build(con, fresh, "local", budget=10_000, now=T)
    assert len(plan.statements) == 0 or plan.budget_left == 1
    forgelayer.resolve_ids(con, fresh, _reader(), now=T)
    plan = forgelayer.build(con, fresh, "local", budget=10_000, now=T)
    assert len(plan.statements) == 1 and plan.deferred == 1


def test_a_failed_part_keeps_what_d1_accepted(tmp_path, forge_d1, monkeypatch):
    con, state = _mac(tmp_path), _state()
    monkeypatch.setattr(forgelayer, "CHUNK", 1)
    calls = []

    class Flaky(community.D1):
        target = "local"

        def run(self, statements):
            calls.append(statements)
            if len(calls) == 2:
                raise community.D1Error("D1 is down")
            return forge_d1.run(statements)

    with pytest.raises(community.D1Error):
        forgelayer.push_traced(con, Flaky(), state, "local", reader=_reader(), now=T, report=lambda m: None)
    assert forge_d1.query("SELECT COUNT(*) AS n FROM traced_paths") == [{"n": 1}]
    retry = forgelayer.push_traced(con, forge_d1, state, "local", reader=_reader(), now=T, report=lambda m: None)
    assert retry.new == 1 and forge_d1.query("SELECT COUNT(*) AS n FROM traced_paths") == [{"n": 2}]


def test_ids_are_resolved_once_and_a_spent_quota_stops_the_run(tmp_path):
    con, state = _mac(tmp_path), _state()

    class Limited(forges.MemoryReader):
        def repo(self, ref):
            if ref.name == "eeg-analysis":
                raise forges.ForgeError("rate_limited", "the forge's hourly quota is spent", retry_after=60)
            return super().repo(ref)

    limited = Limited()
    limited.add("oscr-fixture", "catalogue-only", id="103", files={}, sha=COMMIT)
    first = forgelayer.resolve_ids(con, state, limited, now=T)
    # Sorted: catalogue-only first (found), then eeg-analysis stops the run.
    assert (first.found, first.missing, first.stopped.startswith("rate_limited")) == (1, 0, True)
    assert first.left == 3
    reader = _reader()
    second = forgelayer.resolve_ids(con, state, reader, now=T)
    assert second.found == 3 and second.left == 0
    assert [c[1][0].name for c in reader.calls] == ["eeg-analysis", "turned-private", "unlicensed"]
    # A repository not found is cached, and asked again only after RETRY_DAYS.
    _link(con, PAPER_1, "https://github.com/nobody/nothing-here")
    con.commit()
    assert forgelayer.resolve_ids(con, state, reader, now=T).missing == 1
    assert forgelayer.resolve_ids(con, state, reader, now=T + DAY).asked == 0
    assert forgelayer.resolve_ids(con, state, reader, now=T + 31 * DAY).asked == 1
    # Private: never a traced path.
    assert all(row.repo_id != "104" for row in forgelayer.traced(con, state).values())


# ---------------------------------------------------------------------------------------------
# The commits no longer at the source.

def test_a_pinned_commit_no_longer_at_the_source_keeps_its_papers_copies_and_archive(tmp_path, forge_d1):
    con, state = _mac(tmp_path), _state()
    forgelayer.resolve_ids(con, state, _reader(), now=T)
    assert forgelayer.pinned(con, state) == {("github", "101"): {COMMIT}}
    assert forgelayer.mark_commits(state, "github", "101", {COMMIT: False, "not-a-sha": False}, by="push", now=T) == 1
    assert forgelayer.mark_commits(state, "github", "102", {COMMIT: False}, by="reconcile", now=T) == 1
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entries = _entries(out)
    # Licensed (MIT): the script copies' reader. Not archived: no Software Heritage link.
    assert entries["oscr-fixture/eeg-analysis"]["unreachable"] == [
        {"commit": COMMIT, "found_at": int(T), "papers": [{"doi": "10.5555/oscr.fixture.1",
                                                           "reader": "/paper/doi_10.5555_oscr.fixture.1/code/"}],
         "swh": None}]
    # No license: its copies never leave the Mac, so no reader link.
    assert entries["oscr-fixture/unlicensed"]["unreachable"][0]["papers"] == [
        {"doi": "10.5555/oscr.fixture.2", "reader": None}]
    con.execute("UPDATE repository SET swh_archived = 1 WHERE repo = 'github.com/oscr-fixture/eeg-analysis'")
    con.commit()
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    assert _entries(out)["oscr-fixture/eeg-analysis"]["unreachable"][0]["swh"] == \
        f"https://archive.softwareheritage.org/swh:1:rev:{COMMIT}"
    # Found again (a force push undone): it leaves the list.
    assert forgelayer.mark_commits(state, "github", "101", {COMMIT: True}, now=T) == 0
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    assert _entries(out)["oscr-fixture/eeg-analysis"]["unreachable"] == []
    assert "pinned commits no longer at the source: 1" in forgelayer.status(state)


def test_the_jobs_answers_on_pinned_commits_and_archives_reach_the_layer(tmp_path, forge_d1):
    """oscr/forgejobs.py records its push and reconcile answers in ``forge_commit`` and Software
    Heritage's in ``forge_archive`` (the shared state): the layer reads them, the latest answer per
    commit winning, for the D1 target it reads."""
    from oscr import forgejobs
    con, state = _mac(tmp_path), _state()
    state.executescript(forgejobs.STATE_SCHEMA)
    forgelayer.resolve_ids(con, state, _reader(), now=T)
    state.execute("INSERT INTO forge_commit (target, forge, repo_id, sha, reachable, checked_at) VALUES "
                  "('local', 'github', '101', ?, 0, ?), ('remote', 'github', '102', ?, 0, ?)", (COMMIT, T, COMMIT, T))
    state.execute("INSERT INTO forge_archive (target, job_id, forge, repo_id, url, at, http_status, request_status, "
                  "task_status) VALUES ('local', 1, 'github', '101', 'https://github.com/oscr-fixture/eeg-analysis', ?, "
                  "200, 'accepted', 'succeeded')", (T,))
    state.commit()
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entries = _entries(out)
    lost = entries["oscr-fixture/eeg-analysis"]["unreachable"]
    assert [x["commit"] for x in lost] == [COMMIT] and lost[0]["found_at"] == int(T)
    assert lost[0]["swh"] == f"https://archive.softwareheritage.org/swh:1:rev:{COMMIT}"
    # Another target's answers are not this D1's.
    assert entries["oscr-fixture/unlicensed"]["unreachable"] == []
    # Found again later (by either record): it leaves the list.
    state.execute("INSERT OR REPLACE INTO forge_commit (target, forge, repo_id, sha, reachable, checked_at) VALUES "
                  "('local', 'github', '101', ?, 1, ?)", (COMMIT, T + DAY))
    forgelayer.mark_commits(state, "github", "101", {COMMIT: False}, now=T + 2 * DAY)
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    assert _entries(out)["oscr-fixture/eeg-analysis"]["unreachable"][0]["found_at"] == int(T + 2 * DAY)
    forgelayer.mark_commits(state, "github", "101", {COMMIT: True}, now=T + 3 * DAY)
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    assert _entries(out)["oscr-fixture/eeg-analysis"]["unreachable"] == []


# ---------------------------------------------------------------------------------------------
# D1, the command line and the nightly.

def test_d1_is_read_a_page_at_a_time_and_a_failure_publishes_no_stale_layer(tmp_path, forge_d1, monkeypatch):
    con, state = _mac(tmp_path), _state()
    monkeypatch.setattr(forgelayer, "PAGE", 2)
    for i in range(5):
        _repo(forge_d1, f"30{i}", "lab", f"repo-{i}")
        forge_d1.run([f"INSERT INTO repo_papers (forge, repo_id, paper_id, status, by_user, at) VALUES "
                      f"('github', '30{i}', 'doi:10.1/a', 'linked', 'u', 1), ('github', '30{i}', 'doi:10.1/b', 'proposed', 'u', 1)"])
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entries = _entries(out)
    assert all(len(entries[f"lab/repo-{i}"]["papers"]) == 2 for i in range(5))

    class Down(community.D1):
        def query(self, sql):
            raise community.D1Error("D1 answered 503")

    with pytest.raises(forgelayer.LayerError, match="503"):
        forgelayer.write(con, Down(), out, state=state, push=False, now=T)
    assert list(_shards(out).values()) == [{}] * 64


def test_oscr_forge_layer_pushes_then_writes(tmp_path, forge_d1, monkeypatch):
    con = _mac(tmp_path)
    opened = []
    monkeypatch.setattr(community, "open_d1", lambda target, **kw: opened.append((target, kw["database"])) or forge_d1)
    folder, out = tmp_path / "community", tmp_path / "public"
    said = forgelayer.command(con, "layer", target="local", folder=folder, out=out, budget=None, settings={},
                              reader=_reader(), now=T, report=lambda m: None)
    assert opened == [("local", "oscr_forge")]
    assert said.startswith("local: 2 statements applied, 2 rows written") and "in 64 shards" in said
    assert forge_d1.query("SELECT COUNT(*) AS n FROM traced_paths") == [{"n": 2}]
    status = forgelayer.command(con, "status", target=None, folder=folder, out=out)
    assert "local: oscr_forge.traced_paths: 2 rows" in status and "catalogue repositories found: 4" in status
    with pytest.raises(SystemExit, match="--local"):
        forgelayer.command(con, "layer", target=None, folder=folder, out=out)

    class Missing(community.D1):
        def query(self, sql):
            raise community.D1Error("no such table: repos")

        def run(self, statements):
            raise community.D1Error("no such table: traced_paths")

    monkeypatch.setattr(community, "open_d1", lambda target, **kw: Missing())
    with pytest.raises(SystemExit, match="migrations apply oscr_forge"):
        forgelayer.command(con, "layer", target="local", folder=folder, out=out, reader=_reader(), now=T + DAY,
                           report=lambda m: None)


def test_the_nightly_hook_pushes_in_the_shared_state_and_writes_the_shards(tmp_path, forge_d1, monkeypatch):
    con = _mac(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "settings", lambda: {"OSCR_COMMUNITY_BUDGET": "1"})
    out = tmp_path / "public"
    said = forgelayer.write(con, forge_d1, out, reader=_reader(), now=T, report=lambda m: None)
    assert "traced paths: 1 statements applied, 1 rows written, 1 wait for tomorrow's budget" in said
    state = sqlite3.connect(tmp_path / "data" / "community" / "state.db")
    assert state.execute("SELECT rows FROM community_budget").fetchall() == [(1,)]
    assert len(_shards(out)) == 64
    # Without D1 (the local case with nothing configured): the catalogue's layer, nothing pushed.
    said = forgelayer.write(con, None, tmp_path / "local", now=T)
    assert "traced paths" not in said and "oscr-fixture/eeg-analysis" in _entries(tmp_path / "local")
