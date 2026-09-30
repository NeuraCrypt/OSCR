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

The nightly records its attempts and successes in `data/state/nightly.json`.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import IO

STATE = Path("data/state/nightly.json")
LOCK = Path("data/state/nightly.lock")
LOGS = Path.home() / "Library" / "Logs" / "oscr"

#: The harvester logs each pass (every half hour at most): two hours of silence is a hang.
HARVESTER_IDLE_S = 2 * 3600
#: A publication is due when the last success is older than this (a day and some slack).
NIGHTLY_DUE_S = 26 * 3600
#: After an attempt that did not succeed, wait this long before trying again.
NIGHTLY_RETRY_S = 3 * 3600


def read_state(path: Path = STATE) -> dict[str, float]:
    try:
        return {k: float(v) for k, v in json.loads(path.read_text()).items()}
    except (OSError, ValueError, AttributeError):
        return {}


def _write_state(state: dict[str, float], path: Path = STATE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, path)


def mark(event: str, now: float | None = None, path: Path = STATE) -> None:
    """Record the nightly's `attempt` or `success`."""
    state = read_state(path)
    state[event] = time.time() if now is None else now
    _write_state(state, path)


def acquire_lock(path: Path = LOCK) -> IO[str] | None:
    """The nightly's lock, held while the returned file stays open (until the process ends);
    None when another publication holds it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    return f


def nightly_due(state: dict[str, float], now: float) -> bool:
    if now - state.get("success", 0) < NIGHTLY_DUE_S:
        return False
    return now - state.get("attempt", 0) >= NIGHTLY_RETRY_S


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


def run(now: float | None = None, *, logs: Path = LOGS, state_path: Path = STATE,
        kickstart: Callable[..., str] = _kickstart) -> str:
    """One round: say what was checked and what was started."""
    now = time.time() if now is None else now
    said = []
    if harvester_hung(logs / "harvester.log", now):
        said.append(f"harvester silent for over {HARVESTER_IDLE_S // 3600} h: {kickstart('org.oscr.harvester', kill=True)}")
    else:
        said.append("harvester alive")
    state = read_state(state_path)
    if nightly_due(state, now):
        said.append(f"nightly due (last success {_ago(state.get('success'), now)}): "
                    f"{kickstart('org.oscr.nightly', kill=False)}")
    else:
        said.append(f"nightly done {_ago(state.get('success'), now)}")
    return "; ".join(said)


def _ago(t: float | None, now: float) -> str:
    if not t:
        return "never"
    h = (now - t) / 3600
    return f"{h:.0f} h ago" if h >= 1 else f"{(now - t) / 60:.0f} min ago"
