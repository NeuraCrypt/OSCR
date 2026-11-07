"""The night repairs itself: only what failed is done again, a broken start is said in words, the
tests' old cycles are set aside, and a night that stays failed is said once."""
import os
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path

import conftest
import pytest

from oscr import catalog, cli, cycles, d1, nightly, preflight, publish, watchdog


def today(hour, minute=0):
    return datetime.now().replace(hour=hour, minute=minute, second=0, microsecond=0).timestamp()


@pytest.fixture
def night(tmp_path, monkeypatch):
    """A Mac with every upload asked for, each a fake that records its name."""
    sent, broken = [], set()

    def fake(name):
        def send(*a, **k):
            sent.append(name)
            if name in broken:
                raise RuntimeError(f"{name}: Authentication error [code: 10000]")
            return f"{name} done"
        return send
    monkeypatch.setattr(cli, "settings", lambda: {"OSCR_D1_PUSH": "remote"})
    monkeypatch.setattr(catalog, "generate", lambda *a, **k: sent.append("export") or "out")
    monkeypatch.setattr(watchdog, "refuse_to_publish", lambda articles: "")
    monkeypatch.setattr(publish, "publish_hf", fake("dataset"))
    monkeypatch.setattr(publish, "deploy_cloudflare", fake("deploy"))
    monkeypatch.setattr(d1, "command", fake("search"))
    # The day's start in the past of these runs, whatever the hour of the test.
    monkeypatch.setattr(watchdog, "last_start", lambda now: time.time() - 3600)
    args = ["--db", str(tmp_path / "oscr.db"), "--no-records", "nightly", "--out", str(tmp_path / "out"),
            "--dataset", "x/y", "--cloudflare", "oscr"]
    return sent, broken, args


def test_the_next_run_does_only_what_failed_on_the_export_already_made(night):
    sent, broken, args = night
    broken.add("search")
    with pytest.raises(SystemExit, match="Search"):
        cli.main(args)
    assert sent == ["export", "dataset", "deploy", "search"]
    sent.clear()
    broken.clear()
    assert cli.main(args) == 0
    assert sent == ["search"]
    assert cycles.pending(0) == (True, [])
    assert watchdog.read_state()["resumes"] == 1


def test_a_crash_leaves_its_remaining_steps_to_resume(night, monkeypatch):
    sent, broken, args = night
    cid = cycles.start_cycle("nightly")
    cycles.plan_steps(cid, ["export", "dataset", "deploy", "search"])
    for name in ("export", "dataset"):
        cycles.finish_step(cycles.start_step(cid, name), ok=True)
    sqlite3.connect(cycles.DB).execute("UPDATE cycle SET pid = 999999").connection.commit()
    assert cli.main(args) == 0
    assert sent == ["deploy", "search"]


def test_resume_says_so_when_nothing_is_left(night, capsys):
    sent, broken, args = night
    assert cli.main([*args, "--resume"]) == 0
    assert sent == [] and "nothing to resume" in capsys.readouterr().out


def test_a_refused_preflight_starts_nothing_and_is_recorded(night, monkeypatch):
    sent, broken, args = night
    monkeypatch.setattr(preflight, "run", lambda *a, **kw: ["the external disk is not mounted"])
    with pytest.raises(SystemExit, match="external disk"):
        cli.main(args)
    assert sent == []
    con = sqlite3.connect(cycles.DB)
    assert con.execute("SELECT name, status, detail FROM step").fetchall() == [
        ("preflight", "failed", "the external disk is not mounted")]
    state = watchdog.read_state()
    assert "attempt" not in state and "blocked" in state
    now = state["blocked"]
    assert not watchdog.nightly_due(state, now + 60) and watchdog.nightly_due(state, now + 31 * 60)
    # It passes later: the whole night runs, and the old refusal no longer counts.
    monkeypatch.setattr(preflight, "run", lambda *a, **kw: [])
    assert cli.main(args) == 0
    assert sent[0] == "export" and cycles.pending(0) == (True, [])


def test_the_real_checks_say_what_is_wrong_in_words(tmp_path, monkeypatch):
    assert "not mounted" in preflight.disk(tmp_path)
    (tmp_path / "public").mkdir()
    (tmp_path / "public" / "_headers").write_text("")
    assert preflight.disk(tmp_path) == ""
    assert "GB are needed" in preflight.space(tmp_path, minimum=10**18)
    assert preflight.space(tmp_path, minimum=1) == ""
    monkeypatch.setattr(preflight.socket, "create_connection", lambda *a, **k: (_ for _ in ()).throw(OSError("down")))
    assert "no network" in preflight.network(("a.example",))
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "You are not authenticated.", ""))
    assert "wrangler whoami failed" in preflight.wrangler(tmp_path)
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "You are logged in", ""))
    assert preflight.wrangler(tmp_path) == ""
    assert conftest.REAL_PREFLIGHT({}, "", "") == []       # nothing to send: nothing to check


def test_the_tests_old_cycles_are_set_aside_once_with_a_copy():
    real = cycles.start_cycle("nightly")
    fake = cycles.start_cycle("nightly")
    con = sqlite3.connect(cycles.DB)
    con.execute("UPDATE cycle SET started = 100, finished = 7000 WHERE id = ?", (real,))
    con.execute("UPDATE cycle SET started = 100, finished = 100.001, status = 'ok' WHERE id = ?", (fake,))
    con.commit()
    assert cycles.tidy() == 1
    backup = cycles.DB.with_suffix(".db.bak")
    assert backup.exists()
    assert sqlite3.connect(backup).execute("SELECT COUNT(*) FROM cycle WHERE kind = 'test'").fetchone() == (0,)
    assert cycles.tidy() == 0
    assert [c["id"] for c in cycles.history()] == [real]
    assert cycles.current()["cycle"]["id"] == real


def resumable(left="search", detail="Authentication error"):
    cid = cycles.start_cycle("nightly")
    cycles.finish_step(cycles.start_step(cid, "export"), ok=True)
    cycles.finish_step(cycles.start_step(cid, left), ok=False, detail=detail)
    cycles.finish_cycle(cid, ok=False, detail=detail)


def round_at(now, tmp_path, notes):
    (tmp_path / "harvester.log").write_text("pass")
    os.utime(tmp_path / "harvester.log", (now, now))
    started = []
    said = watchdog.run(now, logs=tmp_path, kickstart=lambda label, kill: started.append(label) or "started",
                        notify=notes.append)
    return said, started


def test_the_watchdog_resumes_with_growing_gaps_then_says_it_once(tmp_path, monkeypatch):
    now = time.time()
    start = now - 20 * 3600
    monkeypatch.setattr(watchdog, "last_start", lambda t: start)
    monkeypatch.setattr(cycles, "reap", lambda: 0)
    resumable()
    notes = []
    for resumes, gap in enumerate(watchdog.RESUME_GAPS_S):
        watchdog.mark("attempt", now)
        watchdog.mark("resumes", resumes)
        watchdog.mark("resume_for", start)
        assert round_at(now + gap - 60, tmp_path, notes)[1] == []
        said, started = round_at(now + gap + 60, tmp_path, notes)
        assert started == ["org.oscr.nightly"] and "resumes search" in said
    watchdog.mark("resumes", len(watchdog.RESUME_GAPS_S))
    assert round_at(now + 7 * 3600, tmp_path, notes)[1] == []
    round_at(now + 8 * 3600, tmp_path, notes)
    assert notes == ["search: Authentication error"]
    assert watchdog.failure(now) == "search: Authentication error"


def test_three_failed_runs_are_said_and_a_good_night_is_silent(tmp_path, monkeypatch):
    now = time.time()
    monkeypatch.setattr(watchdog, "last_start", lambda t: now - 3600)
    assert watchdog.failure(now) == ""
    for _ in range(watchdog.FAILED_RUNS):
        cid = cycles.start_cycle("nightly")
        cycles.finish_step(cycles.start_step(cid, "preflight"), ok=False, detail="the disk")
        cycles.finish_cycle(cid, ok=False, detail="the disk")
    assert watchdog.failure(now) == "preflight: the disk"


def test_the_watchdog_says_a_running_publication_and_starts_nothing(tmp_path):
    lock = watchdog.acquire_lock()
    notes = []
    said, started = round_at(time.time(), tmp_path, notes)
    lock.close()
    assert "nightly running" in said and started == []


def test_a_resumption_does_not_build_again_when_dist_is_up_to_date(tmp_path, monkeypatch):
    calls = []

    def run(cmd, **k):
        calls.append(cmd[:3])
        out = "abc123\n" if cmd[0] == "git" else "https://oscr.x.workers.dev"
        return subprocess.CompletedProcess(cmd, 0, out, "")
    monkeypatch.setattr(subprocess, "run", run)
    export = tmp_path / "public"
    export.mkdir()
    (export / "catalog.json").write_text("{}")
    site = tmp_path / "website"
    (site / "dist").mkdir(parents=True)
    (site / "node_modules").mkdir()
    (site / "node_modules" / publish.INSTALLED_LOCK).write_text("")
    publish.deploy_cloudflare(export, "oscr", site)
    assert ["npm", "run", "build"] in calls
    calls.clear()
    publish.deploy_cloudflare(export, "oscr", site)
    assert ["npm", "run", "build"] not in calls and ["npx", "wrangler", "deploy"] in calls
    (export / "catalog.json").write_text('{"a": 1}')
    calls.clear()
    publish.deploy_cloudflare(export, "oscr", site)
    assert ["npm", "run", "build"] in calls


def test_the_steps_are_those_the_settings_ask_for():
    assert nightly.planned({}, "", "") == ["export", "linkfeeds", "outreach", "swh"]
    assert nightly.planned({"OSCR_LINKFEEDS": "0", "OSCR_OUTREACH": "0", "OSCR_SWH": "0"}, "", "") == ["export"]
    assert nightly.planned({"OSCR_D1_PUSH": "remote", "OSCR_CONTACTS_DATASET": "a/b"}, "x/y", "oscr") == [
        "export", "dataset", "deploy", "linkfeeds", "outreach", "swh", "reconcile", "search", "contacts"]



def test_the_shared_layout_carries_no_date_of_the_catalogue():
    """Every page uses it: a date there changed all 10,000 pages every night, and each was sent again."""
    layout = (Path(__file__).resolve().parents[1] / "website" / "src" / "layouts" / "Base.astro").read_text()
    assert "generated_at" not in layout and "generatedInWords" not in layout


def test_the_night_ends_half_an_hour_before_the_next_0417():
    end = conftest.REAL_NIGHT_END(today(4, 17) + 1)
    assert datetime.fromtimestamp(end).strftime("%H:%M") == "03:47" and end - today(4, 17) > 23 * 3600
    assert conftest.REAL_NIGHT_END(today(20, 32)) - today(20, 32) < 8 * 3600     # a late start: 7 h 15


def test_a_step_past_its_limit_stops_the_night_cleanly(night, monkeypatch):
    """2026-11-02: no limit for the whole night; a step that runs over now stops the night, its cycle
    failed with the reason in words, what was not run left pending for a resumption."""
    sent, broken, args = night
    monkeypatch.setattr(nightly, "STEP_LIMITS_S", {**nightly.STEP_LIMITS_S, "dataset": 0.2})
    monkeypatch.setattr(publish, "publish_hf", lambda *a, **k: (sent.append("dataset"), time.sleep(5)))
    started = time.monotonic()
    with pytest.raises(SystemExit, match="night too long: step dataset stopped after 0 min"):
        cli.main(args)
    assert time.monotonic() - started < 4 and sent == ["export", "dataset"]
    last = cycles.history(1)[0]
    assert last["status"] == "failed" and "night too long: step dataset" in last["detail"]
    exported, left = cycles.pending(0)
    assert exported and left[:2] == ["dataset", "deploy"] and "search" in left


def test_the_night_never_goes_past_its_end(night, monkeypatch):
    sent, broken, args = night
    monkeypatch.setattr(nightly, "night_end", lambda now: now + 0.3)
    monkeypatch.setattr(publish, "publish_hf", lambda *a, **k: time.sleep(5))
    with pytest.raises(SystemExit, match="the night must end by"):
        cli.main(args)


def test_a_resumption_does_not_start_when_the_0417_run_is_near(night, monkeypatch, capsys):
    sent, broken, args = night
    broken.add("search")
    with pytest.raises(SystemExit):
        cli.main(args)
    sent.clear()
    monkeypatch.setattr(nightly, "night_end", lambda now: now + 60)
    assert cli.main(args) == 0 and sent == [] and "the 04:17 run is near" in capsys.readouterr().out
