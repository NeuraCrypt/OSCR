"""The watchdog: a hung harvester is restarted, a missed nightly publication is run, never twice."""
import os

from oscr import watchdog

H = 3600


def test_a_publication_is_due_after_a_day_without_success_and_not_right_after_an_attempt():
    now = 1_000_000.0
    assert watchdog.nightly_due({}, now)
    assert not watchdog.nightly_due({"success": now - 20 * H}, now)
    assert watchdog.nightly_due({"success": now - 27 * H, "attempt": now - 27 * H}, now)
    assert not watchdog.nightly_due({"success": now - 27 * H, "attempt": now - 1 * H}, now)
    assert watchdog.nightly_due({"success": now - 50 * H, "attempt": now - 4 * H}, now)


def test_marks_are_kept_and_a_broken_state_counts_as_none(tmp_path):
    p = tmp_path / "nightly.json"
    watchdog.mark("attempt", 10.0, p)
    watchdog.mark("success", 20.0, p)
    assert watchdog.read_state(p) == {"attempt": 10.0, "success": 20.0}
    p.write_text("{not json")
    assert watchdog.read_state(p) == {}


def test_only_one_publication_holds_the_lock(tmp_path):
    first = watchdog.acquire_lock(tmp_path / "n.lock")
    assert first is not None
    assert watchdog.acquire_lock(tmp_path / "n.lock") is None
    first.close()
    again = watchdog.acquire_lock(tmp_path / "n.lock")
    assert again is not None
    again.close()


def test_a_round_restarts_a_silent_harvester_and_starts_a_missed_nightly(tmp_path):
    log = tmp_path / "harvester.log"
    log.write_text("pass")
    now = 2_000_000.0
    os.utime(log, (now - 3 * H, now - 3 * H))
    started = []
    said = watchdog.run(now, logs=tmp_path, state_path=tmp_path / "state.json",
                        kickstart=lambda label, kill: started.append((label, kill)) or "started")
    assert started == [("org.oscr.harvester", True), ("org.oscr.nightly", False)]
    assert "harvester silent" in said and "nightly due" in said


def test_a_round_leaves_a_live_harvester_and_a_fresh_publication_alone(tmp_path):
    log = tmp_path / "harvester.log"
    log.write_text("pass")
    now = 2_000_000.0
    os.utime(log, (now - 600, now - 600))
    watchdog.mark("success", now - 5 * H, tmp_path / "state.json")
    started = []
    said = watchdog.run(now, logs=tmp_path, state_path=tmp_path / "state.json",
                        kickstart=lambda label, kill: started.append(label) or "started")
    assert started == []
    assert said.startswith("harvester alive") and "nightly done 5 h ago" in said
