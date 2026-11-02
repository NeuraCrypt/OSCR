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
        c = con.execute("SELECT * FROM cycle WHERE kind != 'test' ORDER BY id DESC LIMIT 1").fetchone()
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


def pending(since: float) -> tuple[bool, list[str]]:
    """Since `since`: whether the export succeeded, and the steps whose last state is not `ok`, in order."""
    reap()
    with _db() as con:
        rows = con.execute("SELECT s.name, s.status FROM step s JOIN cycle c ON c.id = s.cycle_id "
                           "WHERE c.started >= ? AND c.kind != 'test' ORDER BY s.id", (since,)).fetchall()
    last = {r["name"]: r["status"] for r in rows}
    return last.get("export") == "ok", [n for n, status in last.items() if status != "ok" and n != "preflight"]


def failures(since: float) -> list[str]:
    """Since `since`: each step whose last state is not `ok`, with its exact message."""
    reap()
    with _db() as con:
        rows = con.execute("SELECT s.name, s.status, s.detail FROM step s JOIN cycle c ON c.id = s.cycle_id "
                           "WHERE c.started >= ? AND c.kind != 'test' ORDER BY s.id", (since,)).fetchall()
    last = {r["name"]: r for r in rows}
    exported = "export" in last and last["export"]["status"] == "ok"
    return [f"{n}: {r['detail'] or r['status']}" for n, r in last.items()
            if r["status"] != "ok" and not (exported and n == "preflight")]


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
