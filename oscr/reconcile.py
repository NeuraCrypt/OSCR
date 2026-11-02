"""D1 and the Mac's memory of it, compared every night.

`data/d1/state.db` and `data/community/state.db` remember what was sent. If a send is lost on the way
(on 2026-10-30, 1,000 paper_orcid rows of a file were recorded and never arrived), that memory is
wrong and the push never sends those rows again. So each night every pushed table's keys are read
back from D1, in order, by key: a read costs D1 only the rows returned (5,000 at a time, about
210,000 rows of its 5 million free a day). A key recorded as sent and absent from D1 is forgotten
here, and the night's push sends it again, within its budget. A read that fails stops the comparison
of that table: nothing is forgotten on a partial answer.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from . import community, d1

BATCH = 5_000
#: The Mac's memory of each table: its D1 database, its columns, and how its key reads.
SEARCH_TABLES: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    (d1.CATALOG, "oscr_catalog", "papers", ("pid",)),
    (d1.SEARCH, "oscr_search", "paper_fts", ("rowid",)),
)


class CatalogReader(community.WranglerD1):
    """oscr_catalog, which `community.open_d1` does not reach: read through wrangler's login, never written."""

    def __init__(self) -> None:
        self.target, self.website, self.database, self.where = "remote", community.WEBSITE, "oscr_catalog", ["--remote"]

    def run(self, statements: list[str]) -> int:
        raise community.D1Error("oscr_catalog is only read here")


def _open(cfg: dict[str, str], name: str) -> community.D1:
    return CatalogReader() if name == "oscr_catalog" else community.open_d1("remote", settings=cfg, database=name)


def _after(cols: tuple[str, ...], last: dict[str, Any] | None) -> str:
    if last is None:
        return ""
    if len(cols) == 1:
        return f"WHERE {cols[0]} > {community.literal(last[cols[0]])} "
    return f"WHERE ({', '.join(cols)}) > ({', '.join(community.literal(last[c]) for c in cols)}) "


def remote_rows(db: community.D1, table: str, cols: tuple[str, ...], batch: int = BATCH) -> Iterator[dict[str, Any]]:
    """Every key of `table`, read in key order from where the last batch stopped: never an OFFSET,
    which D1 would count as rows read again and again."""
    columns, last = ", ".join(cols), None
    while True:
        rows = db.query(f"SELECT {columns} FROM {table} {_after(cols, last)}ORDER BY {columns} LIMIT {batch}")
        yield from rows
        if len(rows) < batch:
            return
        last = rows[-1]


def search(state: sqlite3.Connection, open_db: Callable[[str], community.D1], batch: int = BATCH) -> dict[str, int]:
    """The search's two tables; returns the keys forgotten, by table."""
    forgotten = {}
    for role, database, table, cols in SEARCH_TABLES:
        held = {str(r[cols[0]]) for r in remote_rows(open_db(database), table, cols, batch)}
        sent = {r[0] for r in state.execute("SELECT key FROM d1_sync WHERE target = 'remote' AND db = ? AND tbl = ?",
                                            (role, table))}
        missing = sent - held
        state.executemany("DELETE FROM d1_sync WHERE target = 'remote' AND db = ? AND tbl = ? AND key = ?",
                          [(role, table, k) for k in missing])
        state.commit()
        forgotten[table] = len(missing)
    return forgotten


def facts(state: sqlite3.Connection, db: community.D1, batch: int = BATCH) -> dict[str, int]:
    """The community facts' three tables; returns the keys forgotten, by table."""
    forgotten = {}
    for table, cols in community.KEYS.items():
        held = {community._key(table, r) for r in remote_rows(db, table, cols, batch)}
        sent = {r[0] for r in state.execute("SELECT key FROM community_sync WHERE target = 'remote' AND tbl = ?", (table,))}
        missing = sent - held
        state.executemany("DELETE FROM community_sync WHERE target = 'remote' AND tbl = ? AND key = ?",
                          [(table, k) for k in missing])
        state.commit()
        forgotten[table] = len(missing)
    return forgotten


def run(cfg: dict[str, str]) -> str:
    """The nightly's step: what the settings push is compared; says what was forgotten."""
    def said(counts: dict[str, int]) -> str:
        return ", ".join(f"{n} {t}" for t, n in counts.items())
    out = []
    if cfg.get("OSCR_D1_PUSH") == "remote":
        state = d1.open_state(Path("data/d1/state.db"))
        try:
            out.append(said(search(state, lambda name: _open(cfg, name))))
        finally:
            state.close()
    if cfg.get("OSCR_COMMUNITY_PUSH") == "remote":
        state = community.open_state(Path("data/community/state.db"))
        try:
            out.append(said(facts(state, community.open_d1("remote", settings=cfg))))
        finally:
            state.close()
    return "reconciled with D1, sent again: " + "; ".join(out)
