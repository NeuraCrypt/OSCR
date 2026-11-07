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


def _round(tmp_path, now, **kw):
    log = tmp_path / "harvester.log"
    log.write_text("pass")
    os.utime(log, (now - 600, now - 600))
    notes = []
    said = watchdog.run(now, logs=tmp_path, state_path=tmp_path / "state.json",
                        kickstart=lambda label, kill: "started", notify=notes.append)
    return said, notes


def test_a_night_is_said_failed_from_its_first_failure(tmp_path, monkeypatch):
    """2026-11-05 08:19: "nightly done 14 h ago" was said after two failed cycles; now "failed"."""
    from oscr import cycles
    now = at(5, 8, 20)
    monkeypatch.setattr(watchdog, "locked", lambda: False)
    watchdog.mark("success", at(4, 18), tmp_path / "state.json")
    watchdog.mark("attempt", at(5, 8, 10), tmp_path / "state.json")
    cid = cycles.start_cycle("nightly")
    cycles.finish_step(cycles.start_step(cid, "export"), ok=False, detail="OperationalError('database or disk is full')")
    cycles.finish_cycle(cid, ok=False)
    import sqlite3
    sqlite3.connect(cycles.DB).execute("UPDATE cycle SET started = ?", (at(5, 4, 17),)).connection.commit()
    said, notes = _round(tmp_path, now)
    assert "nightly failed, to be tried again: export: OperationalError('database or disk is full')" in said
    assert "nightly done" not in said


def test_a_night_with_no_publication_begun_is_noted_once_and_notified(tmp_path, monkeypatch):
    """2026-11-06: the night before ran from 20:32 to 10:23, past 04:17; nothing began for the 6th."""
    import sqlite3

    from oscr import cycles
    monkeypatch.setattr(watchdog, "locked", lambda: False)
    cid = cycles.start_cycle("nightly")
    cycles.finish_cycle(cid, ok=True)
    sqlite3.connect(cycles.DB).execute("UPDATE cycle SET started = ?, finished = ?",
                                       (at(5, 20, 32), at(6, 10, 23))).connection.commit()
    watchdog.mark("success", at(6, 10, 23), tmp_path / "state.json")
    said, notes = _round(tmp_path, at(7, 4, 25))
    assert notes == ["missed: no publication began for the night of 2026-11-06 (04:17 to 04:17)"]
    assert notes[0] in said
    said, notes = _round(tmp_path, at(7, 4, 35))
    assert notes == [] and "missed" not in said
