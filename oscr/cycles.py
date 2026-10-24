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
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

#: One file next to the other run-state, never inside the catalogue database.
DB = Path(__file__).resolve().parents[1] / "data" / "state" / "cycles.db"

#: The canonical steps of a publication, in order (informative; any name may be recorded).
STEPS = ("export", "build", "deploy", "search", "dataset")


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
            (time.time(), "ok" if ok else "failed", detail[:500], cycle_id),
        )


def start_step(cycle_id: int, name: str) -> int:
    with _db() as con:
        cur = con.execute(
            "INSERT INTO step(cycle_id, name, started, status) VALUES (?, ?, ?, 'running')",
            (cycle_id, name, time.time()),
        )
        return int(cur.lastrowid)


def finish_step(step_id: int, ok: bool = True, detail: str = "") -> None:
    with _db() as con:
        con.execute(
            "UPDATE step SET finished = ?, status = ?, detail = ? WHERE id = ?",
            (time.time(), "ok" if ok else "failed", detail[:500], step_id),
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
                            "WHERE cycle_id = ? AND status = 'running'", (time.time(), row["id"]))
                n += 1
    return n


def current() -> dict | None:
    """The latest cycle with its steps (crashes reaped first), or None if none yet."""
    reap()
    with _db() as con:
        c = con.execute("SELECT * FROM cycle ORDER BY id DESC LIMIT 1").fetchone()
        if not c:
            return None
        steps = con.execute("SELECT * FROM step WHERE cycle_id = ? ORDER BY id", (c["id"],)).fetchall()
        return {"cycle": dict(c), "steps": [dict(s) for s in steps]}


def history(limit: int = 30) -> list[dict]:
    """The most recent cycles, newest first (crashes reaped first)."""
    reap()
    with _db() as con:
        return [dict(r) for r in con.execute(
            "SELECT * FROM cycle ORDER BY id DESC LIMIT ?", (int(limit),)).fetchall()]
