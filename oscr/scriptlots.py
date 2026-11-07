"""The scripts' TEXT lots of the website (`/scripts/<lot>.json`), which no longer change once full.

Until 2026-11-07 a file's lot was its SHA-256 modulo 1,024 (`catalog.text_lot_of`): every night's
new files (tens of thousands) fell into every lot, so all 1,024 lots (8.4 GB) changed and were sent
to Cloudflare again, at about 1 MB/s, in three or four runs of `wrangler deploy` (4 to 7 hours).

Now a file keeps the lot it was first written to, for good. A persistent table (`index.db`, SQLite)
says which lot holds which SHA-256. New files go to the OPEN lot (the highest number) until it
reaches `LOT_TARGET` bytes, then a new lot is opened. A full (closed) lot is never written again,
with one rare, accepted exception: a file that must leave (a removal request, `withheld`) or whose
shown text changed (the email masking) rewrites the one lot that holds it.

The lots and the table live together in one folder (`Store`). For the nightly it is on the external
disk Expansion, beside `website/public` (`site_store`): what grows goes there, and that disk is
written at night only, once, the open lot and the new ones (a few hundred MB). The site's build
does not copy the lots into `dist/`: `link_into` puts one link per lot in `dist/scripts/`, which
`wrangler deploy` reads through (checked on 2026-11-07: `fs.readdir(..., {recursive: true})` and
`fs.stat` follow a link to a file).

Migration (`adopt`): the 1,024 lots online are frozen as they are, the table is filled from them
and nothing is renumbered; new files go to lot 1024 and on. The reader needs no change: it reads
each file's lot from the facts (`text_lot`).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: A lot's JSON is closed once it reaches this many bytes: under Cloudflare's 25 MiB per asset, with
#: room for one more file of the size the harvester keeps.
LOT_TARGET = 24 * 2**20
#: The folder of the lots beside website/public (on Expansion when public points there).
STORE_NAME = "script-lots"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS member(
    sha256 TEXT PRIMARY KEY,
    lot    TEXT NOT NULL,
    entry  TEXT NOT NULL            -- sha1 of the entry as written: a change rewrites the lot
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lot(
    name       TEXT PRIMARY KEY,
    number     INTEGER NOT NULL UNIQUE,
    bytes      INTEGER NOT NULL,
    files      INTEGER NOT NULL,
    closed     INTEGER NOT NULL,
    written_at REAL
);
CREATE INDEX IF NOT EXISTS member_lot ON member(lot);
"""


def _dump(lot: dict[str, Any]) -> str:
    return json.dumps(lot, ensure_ascii=False, separators=(",", ":"))


def _entry_bytes(sha: str, entry: dict[str, Any]) -> int:
    """What one more entry adds to a lot's JSON: `"sha":{...}` and its comma."""
    return len(json.dumps(sha).encode()) + 1 + len(_dump(entry).encode()) + 1


def _entry_digest(entry: dict[str, Any]) -> str:
    return hashlib.sha1(_dump(entry).encode()).hexdigest()


@dataclass(frozen=True)
class Store:
    """The lots (`<name>.json` in `lots`) and their table (`index`)."""
    lots: Path
    index: Path

    @classmethod
    def at(cls, base: Path) -> Store:
        """One folder holding both: `base/lots/` and `base/index.db` (the nightly's)."""
        return cls(base / "lots", base / "index.db")

    def path(self, name: str) -> Path:
        return self.lots / f"{name}.json"

    def _db(self) -> sqlite3.Connection:
        self.index.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(self.index, timeout=60)
        con.executescript(_SCHEMA)
        return con

    def adopt(self, old: Path | None) -> int:
        """Bring the lots already online into the store, once, as they are: from `old` (the folder
        the build read them from) when the store has none, by renaming it (same disk) or by copying
        it. Then fill the table from the lots found, every one closed. Returns how many lots."""
        self.lots.parent.mkdir(parents=True, exist_ok=True)
        has_lots = self.lots.is_dir() and any(self.lots.glob("*.json"))
        if not has_lots and old is not None and old.is_dir() and not old.is_symlink() and any(old.glob("*.json")):
            if self.lots.exists():
                self.lots.rmdir()       # an empty folder left by an earlier run
            try:
                os.rename(old, self.lots)
            except OSError:             # another disk: copied, then the old one removed
                shutil.copytree(old, self.lots)
                shutil.rmtree(old)
        self.lots.mkdir(parents=True, exist_ok=True)
        with self._db() as con:
            if con.execute("SELECT COUNT(*) FROM lot").fetchone()[0]:
                return 0
            n = 0
            for p in sorted(self.lots.glob("*.json"), key=lambda q: (len(q.stem), q.stem)):
                if not p.stem.isdigit():
                    continue
                content = json.loads(p.read_text())
                con.executemany("INSERT OR REPLACE INTO member(sha256, lot, entry) VALUES (?, ?, ?)",
                                [(sha, p.stem, _entry_digest(e)) for sha, e in content.items()])
                con.execute("INSERT INTO lot(name, number, bytes, files, closed, written_at) VALUES (?, ?, ?, ?, 1, ?)",
                            (p.stem, int(p.stem), p.stat().st_size, len(content), p.stat().st_mtime))
                n += 1
            return n

    def update(self, texts: dict[str, dict[str, Any]], *, remove: set[str] | None = None,
               now: float | None = None, target: int = LOT_TARGET) -> tuple[dict[str, str], str]:
        """Write the texts to show (`{sha256: entry}`, every file the site shows) into the lots:
        a known file stays where it is, a new one goes to the open lot, a file whose entry changed
        rewrites its own lot. A known file no longer shown leaves its lot only when it is in `remove`
        (what must not be shown: a removal request, a withdrawn or off-topic paper's code); one that
        merely left the export (a repository read again at a newer commit) stays, unseen, so that
        its lot does not change. `remove` None: every file no longer shown leaves.
        Returns `{sha256: lot name}` and a summary."""
        now = time.time() if now is None else now
        self.lots.mkdir(parents=True, exist_ok=True)
        with self._db() as con:
            known = {sha: (lot, digest) for sha, lot, digest in con.execute("SELECT sha256, lot, entry FROM member")}
            lots = {name: {"number": number, "bytes": size, "files": files, "closed": bool(closed)}
                    for name, number, size, files, closed in con.execute(
                        "SELECT name, number, bytes, files, closed FROM lot")}
        place: dict[str, str] = {}
        changed: dict[str, dict[str, dict[str, Any] | None]] = {}   # lot -> {sha: new entry, or None: leaves}
        fresh = []
        for sha, entry in texts.items():
            if sha in known:
                lot, digest = known[sha]
                place[sha] = lot
                if digest != _entry_digest(entry):
                    changed.setdefault(lot, {})[sha] = entry
            else:
                fresh.append(sha)
        for sha, (lot, _digest) in known.items():
            if sha not in texts and (remove is None or sha in remove):
                changed.setdefault(lot, {})[sha] = None
        # The open lot: the highest number, unless it is closed (then a new one).
        top = max(lots.values(), key=lambda v: v["number"], default=None)
        open_name = next((n for n, v in lots.items() if v is top), None) if top and not top["closed"] else None
        next_number = (top["number"] + 1) if top else 0
        contents: dict[str, dict[str, Any]] = {}

        def content(name: str) -> dict[str, Any]:
            if name not in contents:
                p = self.path(name)
                contents[name] = json.loads(p.read_text()) if p.exists() else {}
            return contents[name]

        for name, edits in changed.items():
            c = content(name)
            for sha, entry in edits.items():
                if entry is None:
                    c.pop(sha, None)
                else:
                    c[sha] = entry
        added = 0
        new_lots = []
        if fresh:
            size = len(_dump(content(open_name)).encode()) if open_name else 0
            for sha in sorted(fresh):
                entry = texts[sha]
                grow = _entry_bytes(sha, entry)
                if open_name is None or (size + grow > target and content(open_name)):
                    if open_name is not None:
                        lots[open_name]["closed"] = True
                    open_name = f"{next_number:02d}"
                    next_number += 1
                    lots[open_name] = {"number": int(open_name), "bytes": 0, "files": 0, "closed": False}
                    contents[open_name] = {}
                    new_lots.append(open_name)
                    size = 2
                content(open_name)[sha] = entry
                place[sha] = open_name
                size += grow
                added += 1
        # Write what changed: each file replaced at once (written beside, then renamed).
        written = []
        for name, c in contents.items():
            if name not in changed and name != open_name and name not in new_lots:
                continue
            p = self.path(name)
            if not c:
                # Emptied (its files all left): no file, and its number is never given again.
                p.unlink(missing_ok=True)
                lots[name].update(bytes=0, files=0, closed=True)
                written.append(name)
                continue
            text = _dump(c)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(text)
            os.replace(tmp, p)
            lots[name].update(bytes=len(text.encode()), files=len(c))
            written.append(name)
        with self._db() as con:
            for edits in changed.values():
                for sha, entry in edits.items():
                    if entry is None:
                        con.execute("DELETE FROM member WHERE sha256 = ?", (sha,))
                    else:
                        con.execute("UPDATE member SET entry = ? WHERE sha256 = ?", (_entry_digest(entry), sha))
            con.executemany("INSERT OR REPLACE INTO member(sha256, lot, entry) VALUES (?, ?, ?)",
                            [(sha, place[sha], _entry_digest(texts[sha])) for sha in fresh])
            for name, v in lots.items():
                con.execute("INSERT INTO lot(name, number, bytes, files, closed, written_at) VALUES (?, ?, ?, ?, ?, ?) "
                            "ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, files = excluded.files, "
                            "closed = excluded.closed, written_at = CASE WHEN ? THEN excluded.written_at ELSE written_at END",
                            (name, v["number"], v["bytes"], v["files"], int(v["closed"]), now, name in written))
        removed = sum(1 for e in changed.values() for x in e.values() if x is None)
        summary = (f"script lots: {added} new files in {len(new_lots)} new lot(s), {removed} removed, "
                   f"{len(written)} lot(s) written of {sum(1 for v in lots.values() if v['files'])}")
        return place, summary

    def names(self) -> list[str]:
        with self._db() as con:
            return [r[0] for r in con.execute("SELECT name FROM lot WHERE files > 0 ORDER BY number")]

    def largest(self) -> int:
        with self._db() as con:
            return int(con.execute("SELECT COALESCE(MAX(bytes), 0) FROM lot").fetchone()[0])


def site_store(website: Path, cfg: dict[str, str] | None = None) -> Store:
    """The nightly's store: `OSCR_SCRIPT_LOTS` when set, otherwise beside website/public, so on the
    external disk when public points there."""
    chosen = (cfg or {}).get("OSCR_SCRIPT_LOTS", "").strip()
    return Store.at(Path(chosen) if chosen else (website / "public").resolve().parent / STORE_NAME)


def link_into(store: Store, folder: Path, names: Iterable[str] | None = None) -> int:
    """`folder` (dist/scripts) holds one link per lot of the store and nothing else: what the build
    left there (a copy of an older lot) is replaced, a lot that left is unlinked. Returns how many."""
    want = {f"{n}.json" for n in (store.names() if names is None else names)}
    folder.mkdir(parents=True, exist_ok=True)
    for p in folder.iterdir():
        if p.name not in want or not p.is_symlink():
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
    for name in want:
        link = folder / name
        if not link.is_symlink():
            link.symlink_to((store.lots / name).resolve())
    return len(want)


def heavy_folder(website: Path, cfg: dict[str, str] | None = None) -> Path | None:
    """Where the nightly writes `scripts.jsonl` (7.6 GB on 2026-11-07, rewritten each night):
    `OSCR_HEAVY_DIR` when set, otherwise `data/public` on the external disk when website/public points
    there; None (beside the catalogue) when it does not."""
    chosen = (cfg or {}).get("OSCR_HEAVY_DIR", "").strip()
    if chosen:
        return Path(chosen)
    public = website / "public"
    return public.resolve().parent.parent / "data" / "public" if public.is_symlink() else None
