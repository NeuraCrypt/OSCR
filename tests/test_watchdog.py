"""The watchdog: a hung harvester is restarted, a missed nightly publication is run, never twice."""
import os
from datetime import datetime

from oscr import watchdog

H = 3600


def at(day: int, hour: int, minute: int = 0) -> float:
    """A local time in November 2026 (the deadline is local, like launchd's 04:17)."""
    return datetime(2026, 11, day, hour, minute).timestamp()


def test_a_publication_is_due_when_no_success_came_after_the_last_0417_and_not_right_after_an_attempt():
    now = at(2, 12)
    assert watchdog.nightly_due({}, now)
    assert not watchdog.nightly_due({"success": at(2, 9)}, now)
    assert watchdog.nightly_due({"success": at(1, 23), "attempt": at(1, 23)}, now)
    assert not watchdog.nightly_due({"success": at(1, 23), "attempt": now - 1 * H}, now)
    assert watchdog.nightly_due({"success": at(1, 10), "attempt": now - 4 * H}, now)


def test_a_late_success_does_not_push_the_next_publication_past_a_missed_morning():
    # 2026-10-31/11-01: success at 21:31, the Mac off at 04:17, on again at 09:25: due at once,
    # not 26 hours after the success.
    success = datetime(2026, 10, 31, 21, 31).timestamp()
    assert watchdog.nightly_due({"success": success, "attempt": success}, at(1, 9, 30))
    assert not watchdog.nightly_due({"success": success, "attempt": success}, at(1, 3))


def test_the_watchdog_leaves_launchd_its_own_start():
    state = {"success": at(1, 10), "attempt": at(1, 4, 17)}
    assert not watchdog.nightly_due({"success": at(1, 10)}, at(2, 4, 20))
    assert watchdog.nightly_due({"success": at(1, 10)}, at(2, 4, 50))
    assert not watchdog.nightly_due(state | {"attempt": at(2, 4, 17)}, at(2, 5))


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
    now = at(2, 15)
    os.utime(log, (now - 600, now - 600))
    watchdog.mark("success", now - 5 * H, tmp_path / "state.json")
    started = []
    said = watchdog.run(now, logs=tmp_path, state_path=tmp_path / "state.json",
                        kickstart=lambda label, kill: started.append(label) or "started")
    assert started == []
    assert said.startswith("harvester alive") and "nightly done 5 h ago" in said
