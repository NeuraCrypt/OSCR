"""The Mac's own watchdog: the harvester and the nightly publication start again by themselves.

launchd already restarts the harvester when it exits (KeepAlive) and runs every job again at the
session's start. Two failures it cannot see are caught here, by `oscr watchdog`, which launchd runs
every ten minutes (org.oscr.watchdog):

- the harvester **hangs** without exiting: its log has not moved for `HARVESTER_IDLE_S`, so it is
  killed and started again (`launchctl kickstart -k`);
- the nightly publication **did not run**: the Mac was off or asleep at 04:17, or it failed. When the
  last success is older than `NIGHTLY_DUE_S` and no attempt started within `NIGHTLY_RETRY_S`, the
  nightly job is started now. launchd never runs a second copy of a job that is running, and the
  nightly holds a lock, so two publications never overlap.

The nightly records its attempts and successes in `data/state/nightly.json`, its steps in
`data/state/cycles.db`. When today's export succeeded and steps are left (a failure, a crash), the
same job does those only (oscr/nightly.py), up to `len(RESUME_GAPS_S)` times a day, `RESUME_GAPS_S`
apart. A night still failing after all that is said once (`alert`, a macOS notification) and stays
on the dashboard (`failure`); otherwise, silence.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import IO

from . import cycles

#: Read at each call, not bound as defaults, so the tests can point them elsewhere (tests/conftest.py).
STATE = Path("data/state/nightly.json")
LOCK = Path("data/state/nightly.lock")
LOGS = Path.home() / "Library" / "Logs" / "oscr"

#: The harvester logs each pass (every half hour at most): two hours of silence is a hang.
HARVESTER_IDLE_S = 2 * 3600
#: The nightly's local start (org.oscr.nightly's StartCalendarInterval): a publication is due when no
#: success came after the last one. Not "a day since the last success": a late success (21:31 on
#: 2026-10-31) then pushed the next due time past a morning the Mac was off at 04:17 (2026-11-01).
NIGHTLY_AT = (4, 17)
#: Leave launchd its own start: the deadline counts for the watchdog this long after 04:17.
NIGHTLY_GRACE_S = 30 * 60
#: After an attempt that did not succeed, wait this long before trying again.
NIGHTLY_RETRY_S = 3 * 3600


#: After a day's failed step: wait this long before the first, second and third resumption.
RESUME_GAPS_S = (3600, 3 * 3600, 6 * 3600)
#: A preflight refused (a disk to mount, the network): no attempt was made, try again this soon.
BLOCKED_RETRY_S = 30 * 60
#: Whole runs failed in a day (nothing exported) before the night is said to have failed.
FAILED_RUNS = 3


def read_state(path: Path | None = None) -> dict[str, float]:
    path = STATE if path is None else path
    try:
        return {k: float(v) for k, v in json.loads(path.read_text()).items()}
    except (OSError, ValueError, AttributeError):
        return {}


def _write_state(state: dict[str, float], path: Path | None = None) -> None:
    path = STATE if path is None else path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, path)


def mark(event: str, now: float | None = None, path: Path | None = None) -> None:
    """Record the nightly's `attempt` or `success` (a time), or `published` (the papers sent)."""
    state = read_state(path)
    state[event] = time.time() if now is None else now
    _write_state(state, path)


#: A catalogue below this share of the last published one is not published (a broken or empty export,
#: as on 2026-10-30 when a test published an empty catalogue: the site, D1 and Hugging Face emptied).
MIN_SHARE_OF_LAST = 0.5


def refuse_to_publish(articles: int, path: Path | None = None) -> str:
    """Why the nightly must send nothing, or "": a catalogue with no paper, or with fewer than half
    the papers of the last one published (`published` in the nightly's state)."""
    last = int(read_state(path).get("published", 0))
    if articles <= 0:
        return "the catalogue has no paper: nothing is published"
    if last and articles < MIN_SHARE_OF_LAST * last:
        return (f"the catalogue has {articles} papers, under {MIN_SHARE_OF_LAST:.0%} of the {last} last published: "
                "nothing is published")
    return ""


def acquire_lock(path: Path | None = None) -> IO[str] | None:
    """The nightly's lock, held while the returned file stays open (until the process ends);
    None when another publication holds it."""
    path = LOCK if path is None else path
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    return f


def last_start(now: float) -> float:
    """The last local `NIGHTLY_AT` at or before `now`, as a time: the night's day begins there."""
    day = datetime.fromtimestamp(now).replace(hour=NIGHTLY_AT[0], minute=NIGHTLY_AT[1], second=0, microsecond=0)
    return day.timestamp() if day.timestamp() <= now else (day - timedelta(days=1)).timestamp()


def last_deadline(now: float) -> float:
    """The last local `NIGHTLY_AT` plus the grace at or before `now`, as a time."""
    deadline = last_start(now) + NIGHTLY_GRACE_S
    return deadline if deadline <= now else last_start(last_start(now) - 1) + NIGHTLY_GRACE_S


def nightly_due(state: dict[str, float], now: float) -> bool:
    if state.get("success", 0) >= last_deadline(now):
        return False
    if now - state.get("blocked", 0) < BLOCKED_RETRY_S:
        return False
    return now - state.get("attempt", 0) >= NIGHTLY_RETRY_S


def count_resume(start: float, path: Path | None = None) -> None:
    """One more resumption of the night that began at `start`."""
    state = read_state(path)
    state["resumes"] = resumes_of(state, start) + 1
    state["resume_for"] = start
    _write_state(state, path)


def resumes_of(state: dict[str, float], start: float) -> int:
    return int(state.get("resumes", 0)) if state.get("resume_for") == start else 0


def resume_due(state: dict[str, float], now: float) -> bool:
    n = resumes_of(state, last_start(now))
    return n < len(RESUME_GAPS_S) and now - state.get("attempt", 0) >= RESUME_GAPS_S[n]


def locked(path: Path | None = None) -> bool:
    """Whether a publication holds the lock now."""
    lock = acquire_lock(path)
    if lock is None:
        return True
    lock.close()
    return False


def failure(now: float | None = None, path: Path | None = None) -> str:
    """Today's failed night, in words, once every relaunch is spent; "" otherwise."""
    now = time.time() if now is None else now
    state, start = read_state(path), last_start(now)
    exported, left = cycles.pending(start)
    spent = (exported and left and resumes_of(state, start) >= len(RESUME_GAPS_S)) or (not exported and cycles.failed_cycles(start) >= FAILED_RUNS)
    return "; ".join(cycles.failures(start)) if spent else ""


def alert(message: str) -> None:
    """A macOS notification. The text is a separate argument: nothing in it is run."""
    subprocess.run(["/usr/bin/osascript", "-e", "on run argv", "-e",
                    'display notification (item 1 of argv) with title "OSCR: publication failed"', "-e", "end run",
                    message[:300]], capture_output=True, text=True, timeout=30)


def harvester_hung(log: Path, now: float) -> bool:
    try:
        return now - log.stat().st_mtime > HARVESTER_IDLE_S
    except OSError:
        return False                    # no log yet: nothing to judge


def _kickstart(label: str, *, kill: bool) -> str:
    target = f"gui/{os.getuid()}/{label}"
    r = subprocess.run(["launchctl", "kickstart", *(["-k"] if kill else []), target],
                       capture_output=True, text=True, timeout=60)
    return "started" if r.returncode == 0 else f"not started ({(r.stderr or r.stdout).strip()[:120]})"


def run(now: float | None = None, *, logs: Path = LOGS, state_path: Path | None = None,
        kickstart: Callable[..., str] = _kickstart, notify: Callable[[str], None] = alert) -> str:
    """One round: say what was checked and what was started."""
    now = time.time() if now is None else now
    said = []
    if harvester_hung(logs / "harvester.log", now):
        said.append(f"harvester silent for over {HARVESTER_IDLE_S // 3600} h: {kickstart('org.oscr.harvester', kill=True)}")
    else:
        said.append("harvester alive")
    state = read_state(state_path)
    start = last_start(now)
    exported, left = cycles.pending(start)
    if locked():
        said.append("nightly running")
    elif exported and left and resume_due(state, now):
        said.append(f"nightly resumes {', '.join(left)}: {kickstart('org.oscr.nightly', kill=False)}")
    elif not (exported and left) and nightly_due(state, now):
        said.append(f"nightly due (last success {_ago(state.get('success'), now)}): "
                    f"{kickstart('org.oscr.nightly', kill=False)}")
    elif (failed := failure(now, state_path)):
        if state.get("alerted") != start:
            notify(failed)
            mark("alerted", start, state_path)
        said.append(f"nightly failed: {failed}")
    else:
        said.append(f"nightly done {_ago(state.get('success'), now)}")
    return "; ".join(said)


def _ago(t: float | None, now: float) -> str:
    if not t:
        return "never"
    h = (now - t) / 3600
    return f"{h:.0f} h ago" if h >= 1 else f"{(now - t) / 60:.0f} min ago"
