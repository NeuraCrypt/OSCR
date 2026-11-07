"""A small, self-contained history of publication cycles, for the menu-bar monitor.

Kept in its own SQLite file (``data/state/cycles.db``), separate from the catalogue, so recording
progress never touches ``oscr.db``. A *cycle* is one run of ``oscr nightly`` (or a manual publish);
each cycle has ordered *steps* (export, build, deploy, ...). Every step and cycle stores its start,
end and status, so the monitor can show the current state and a full history.

Crash detection is the point of ``reap()``: a cycle row stores the PID of the process that created
it, and ``reap()`` marks as ``crashed`` any cycle still ``running`` whose process is gone. A silent
crash therefore becomes visible (status ``crashed``) instead of a cycle that looks stuck forever.
Stdlib only.
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

#: One file next to the other run-state, never inside the catalogue database.
DB = Path(__file__).resolve().parents[1] / "data" / "state" / "cycles.db"

#: The canonical steps of a publication, in order (informative; any name may be recorded).
STEPS = ("preflight", "export", "forge", "dataset", "deploy", "reconcile", "search", "community", "scripts", "contacts")
#: Under this, a "cycle" was a test's (they once wrote here): `tidy` marks it `test`, the monitors skip it.
TEST_SECONDS = 1.0
#: 2026-10-29 19:10: from then on the tests have their own folder, and a short cycle is a real one.
TESTS_ISOLATED = 1793319000.0
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _db() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode = WAL")
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS cycle(
            id INTEGER PRIMARY KEY, kind TEXT, started REAL, finished REAL,
            status TEXT, pid INTEGER, detail TEXT);
        CREATE TABLE IF NOT EXISTS step(
            id INTEGER PRIMARY KEY, cycle_id INTEGER, name TEXT, started REAL,
            finished REAL, status TEXT, detail TEXT);
        CREATE TABLE IF NOT EXISTS measure(
            cycle_id INTEGER, name TEXT, value REAL, PRIMARY KEY (cycle_id, name));
        """
    )
    return con


def _readable(detail: str) -> str:
    """The end of an error, where wrangler says what happened, without its colours."""
    return _ANSI.sub("", detail).strip()[-500:]


def start_cycle(kind: str = "nightly") -> int:
    with _db() as con:
        cur = con.execute(
            "INSERT INTO cycle(kind, started, status, pid) VALUES (?, ?, 'running', ?)",
            (kind, time.time(), os.getpid()),
        )
        return int(cur.lastrowid)


def finish_cycle(cycle_id: int, ok: bool = True, detail: str = "") -> None:
    with _db() as con:
        con.execute(
            "UPDATE cycle SET finished = ?, status = ?, detail = ? WHERE id = ?",
            (time.time(), "ok" if ok else "failed", _readable(detail), cycle_id),
        )


def measure(cycle_id: int, name: str, value: float | None) -> None:
    """One figure of a cycle, for the trend (oscr/nighttrend.py): the site's files, the largest one,
    the free space of both disks, what was sent to Cloudflare. None: not known, nothing recorded."""
    if value is None:
        return
    with _db() as con:
        con.execute("INSERT OR REPLACE INTO measure(cycle_id, name, value) VALUES (?, ?, ?)",
                    (cycle_id, name, float(value)))


def measures(cycle_ids: list[int]) -> dict[int, dict[str, float]]:
    out: dict[int, dict[str, float]] = {}
    if not cycle_ids:
        return out
    with _db() as con:
        for r in con.execute(f"SELECT cycle_id, name, value FROM measure WHERE cycle_id IN ({','.join('?' * len(cycle_ids))})",
                             cycle_ids):
            out.setdefault(r["cycle_id"], {})[r["name"]] = r["value"]
    return out


def skip_if_overrun(night_start: float, now: float | None = None) -> str:
    """When the cycle still running began before `night_start` (today's 04:17), that night's own run
    was not started (launchd does not start a job that is running): say it once, as a `skipped`
    cycle, so that it shows; the watchdog starts the night when the running cycle ends. Returns what
    was recorded, or ""."""
    now = time.time() if now is None else now
    with _db() as con:
        running = con.execute("SELECT id, started FROM cycle WHERE status = 'running' AND kind != 'test' "
                              "ORDER BY id DESC LIMIT 1").fetchone()
        if not running or running["started"] >= night_start or now < night_start:
            return ""
        if con.execute("SELECT 1 FROM cycle WHERE kind = 'skipped' AND started >= ?", (night_start,)).fetchone():
            return ""
        detail = (f"skipped: previous cycle running (cycle {running['id']}, begun "
                  f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(running['started']))}); the watchdog starts "
                  "this night when it ends")
        con.execute("INSERT INTO cycle(kind, started, finished, status, pid, detail) VALUES ('skipped', ?, ?, 'skipped', ?, ?)",
                    (now, now, os.getpid(), detail))
        return detail


def plan_steps(cycle_id: int, names: list[str]) -> None:
    """The steps this cycle means to run: what a crash leaves `pending` is known, and resumed."""
    with _db() as con:
        con.executemany("INSERT INTO step(cycle_id, name, status) VALUES (?, ?, 'pending')",
                        [(cycle_id, n) for n in names])


def start_step(cycle_id: int, name: str) -> int:
    with _db() as con:
        row = con.execute("SELECT id FROM step WHERE cycle_id = ? AND name = ? AND status = 'pending'",
                          (cycle_id, name)).fetchone()
        if row:
            con.execute("UPDATE step SET started = ?, status = 'running' WHERE id = ?", (time.time(), row["id"]))
            return int(row["id"])
        cur = con.execute(
            "INSERT INTO step(cycle_id, name, started, status) VALUES (?, ?, ?, 'running')",
            (cycle_id, name, time.time()),
        )
        return int(cur.lastrowid)


def finish_step(step_id: int, ok: bool = True, detail: str = "") -> None:
    with _db() as con:
        con.execute(
            "UPDATE step SET finished = ?, status = ?, detail = ? WHERE id = ?",
            (time.time(), "ok" if ok else "failed", _readable(detail), step_id),
        )


@contextmanager
def step(cycle_id: int, name: str):
    """Record one step: ``ok`` if the block returns, ``failed`` (with the error) if it raises."""
    sid = start_step(cycle_id, name)
    try:
        yield
    except BaseException as e:  # noqa: BLE001 - we re-raise; we only want to record the failure
        finish_step(sid, ok=False, detail=repr(e))
        raise
    else:
        finish_step(sid, ok=True)


def _alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def reap() -> int:
    """Mark as ``crashed`` every running cycle whose process is gone. Returns how many."""
    n = 0
    with _db() as con:
        for row in con.execute("SELECT id, pid FROM cycle WHERE status = 'running'").fetchall():
            if not _alive(row["pid"]):
                con.execute("UPDATE cycle SET status = 'crashed', finished = ? WHERE id = ?",
                            (time.time(), row["id"]))
                con.execute("UPDATE step SET status = 'crashed', finished = ? "
                            "WHERE cycle_id = ? AND status IN ('running', 'pending')", (time.time(), row["id"]))
                n += 1
    return n


def current() -> dict | None:
    """The latest cycle with its steps (crashes reaped first), or None if none yet."""
    reap()
    with _db() as con:
        c = con.execute("SELECT * FROM cycle WHERE kind NOT IN ('test', 'skipped', 'missed') ORDER BY id DESC LIMIT 1").fetchone()
        if not c:
            return None
        steps = con.execute("SELECT * FROM step WHERE cycle_id = ? ORDER BY id", (c["id"],)).fetchall()
        return {"cycle": dict(c), "steps": [dict(s) for s in steps]}


def history(limit: int = 30) -> list[dict]:
    """The most recent cycles, newest first (crashes reaped first)."""
    reap()
    with _db() as con:
        return [dict(r) for r in con.execute(
            "SELECT * FROM cycle WHERE kind != 'test' ORDER BY id DESC LIMIT ?", (int(limit),)).fetchall()]


#: The cycles a night's resumption looks at: those begun since its 04:17, and the one still going then
#: (begun the evening before, 2026-11-05 20:32 to 2026-11-06 10:23): its failed step is resumed unless a
#: later cycle did it again (the steps are read in order, the latest state wins).
_WINDOW = "(c.started >= ? OR c.finished >= ? OR c.status = 'running') AND c.kind NOT IN ('test', 'skipped', 'missed')"


def pending(since: float) -> tuple[bool, list[str]]:
    """Since `since`: whether the export succeeded, and the steps whose last state is not `ok`, in order."""
    reap()
    with _db() as con:
        rows = con.execute(f"SELECT s.name, s.status FROM step s JOIN cycle c ON c.id = s.cycle_id "
                           f"WHERE {_WINDOW} ORDER BY s.id", (since, since)).fetchall()
    last = {r["name"]: r["status"] for r in rows}
    return last.get("export") == "ok", [n for n, status in last.items() if status != "ok" and n != "preflight"]


def export_begun(since: float) -> float | None:
    """When the export that `pending(since)` counts began: what a resumption publishes."""
    with _db() as con:
        row = con.execute(f"SELECT s.started FROM step s JOIN cycle c ON c.id = s.cycle_id WHERE {_WINDOW} "
                          "AND s.name = 'export' AND s.status = 'ok' ORDER BY s.id DESC LIMIT 1", (since, since)).fetchone()
    return float(row["started"]) if row else None


def failures(since: float) -> list[str]:
    """Since `since`: each step whose last state is not `ok`, with its exact message."""
    reap()
    with _db() as con:
        rows = con.execute(f"SELECT s.name, s.status, s.detail FROM step s JOIN cycle c ON c.id = s.cycle_id "
                           f"WHERE {_WINDOW} ORDER BY s.id", (since, since)).fetchall()
    last = {r["name"]: r for r in rows}
    exported = "export" in last and last["export"]["status"] == "ok"
    return [f"{n}: {r['detail'] or r['status']}" for n, r in last.items()
            if r["status"] != "ok" and not (exported and n == "preflight")]


def note_missed(night_start: float, next_start: float, now: float | None = None) -> str:
    """The night from `night_start` to `next_start` began no publication at all (2026-11-06: the night
    before ran over 04:17 and nothing started after it): recorded once as a `missed` cycle, and said.
    Returns what was recorded, or "". Nothing is said before this file knows an earlier night."""
    now = time.time() if now is None else now
    with _db() as con:
        if not con.execute("SELECT 1 FROM cycle WHERE started < ? AND kind NOT IN ('test', 'skipped', 'missed')",
                           (night_start,)).fetchone():
            return ""
        if con.execute("SELECT 1 FROM cycle WHERE started >= ? AND started < ? AND kind IN ('nightly', 'resume')",
                       (night_start, next_start)).fetchone():
            return ""
        if con.execute("SELECT 1 FROM cycle WHERE kind = 'missed' AND started = ?", (night_start,)).fetchone():
            return ""
        detail = (f"missed: no publication began for the night of "
                  f"{time.strftime('%Y-%m-%d', time.localtime(night_start))} (04:17 to 04:17)")
        con.execute("INSERT INTO cycle(kind, started, finished, status, pid, detail) VALUES ('missed', ?, ?, 'skipped', ?, ?)",
                    (night_start, now, os.getpid(), detail))
        return detail


def failed_cycles(since: float) -> int:
    reap()
    with _db() as con:
        return con.execute("SELECT COUNT(*) FROM cycle WHERE started >= ? AND kind != 'test' "
                           "AND status IN ('failed', 'crashed')", (since,)).fetchone()[0]


def tidy() -> int:
    """Mark `test` the zero-second cycles tests once wrote here; a copy of the file (`cycles.db.bak`) is
    made the first time. Nothing is deleted, and running it again changes nothing. Returns how many."""
    where = f"kind != 'test' AND finished IS NOT NULL AND finished - started < ? AND started < {TESTS_ISOLATED}"
    with _db() as con:
        found = con.execute(f"SELECT COUNT(*) FROM cycle WHERE {where}", (TEST_SECONDS,)).fetchone()[0]
    if not found:
        return 0
    backup = DB.with_suffix(".db.bak")
    if not backup.exists():
        with _db() as con:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        shutil.copy2(DB, backup)
    with _db() as con:
        return con.execute(f"UPDATE cycle SET kind = 'test' WHERE {where}", (TEST_SECONDS,)).rowcount
