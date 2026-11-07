"""The nights' trend, for the local dashboard (oscr/dashboard.py, `/api/trend`) and the watchdog.

From 2026-10-29 to 2026-11-04 a night went from 376 to 833 minutes, one step after another growing
with the stock, and nothing said so until a night ran over the next. Here, night by night: each
step's duration (data/state/cycles.db), and the figures the nightly records at its end (`measure`):
the site's files and the largest of them against Cloudflare's 25 MiB, the free space of both disks,
what was sent to Cloudflare. And a warning when a night lasts over `LONG_NIGHT_S`, or when the
nights grew `RISING_NIGHTS` times in a row.
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import cycles

#: A night longer than this is said: the night has until the next 04:17, and steps grow every night.
LONG_NIGHT_S = 6 * 3600
#: Nights that grew this many times in a row are said, even under LONG_NIGHT_S.
RISING_NIGHTS = 7
#: Cloudflare's limit for one static asset.
ASSET_LIMIT = 25 * 2**20


def site_files(dist: Path) -> tuple[int, int, str]:
    """The files of the built site (links to the scripts' lots followed), the largest one's size and
    its path. (0, 0, "") when there is no build."""
    count, largest, name = 0, 0, ""
    if not dist.is_dir():
        return count, largest, name
    for root, _dirs, files in os.walk(dist):
        for f in files:
            try:
                size = os.stat(os.path.join(root, f)).st_size
            except OSError:
                continue
            count += 1
            if size > largest:
                largest, name = size, os.path.relpath(os.path.join(root, f), dist)
    return count, largest, name


def free_space(website: Path, data: Path = Path("data")) -> tuple[int | None, int | None]:
    """Free bytes on the internal disk (data/) and on the external one (where website/public points)."""
    internal = shutil.disk_usage(data if data.exists() else ".").free
    public = website / "public"
    external = shutil.disk_usage(os.path.realpath(public)).free if public.is_symlink() and public.exists() else None
    return internal, external


def record(cycle_id: int, website: Path, deploy: dict[str, float] | None = None) -> None:
    """The night's figures, at its end (any failure here is the nightly's to ignore)."""
    count, largest, _name = site_files(website / "dist")
    internal, external = free_space(website)
    for name, value in (("site_files", count or None), ("largest_file", largest or None),
                        ("free_internal", internal), ("free_external", external),
                        *(((f"deploy_{k}", v) for k, v in (deploy or {}).items()))):
        cycles.measure(cycle_id, name, value)


def nights(limit: int = 30) -> list[dict[str, Any]]:
    """The last `limit` publications (nightly or resumption), oldest first: start, minutes, status,
    each step's minutes, and their figures."""
    rows = [r for r in cycles.history(limit * 3) if r["kind"] in ("nightly", "resume")][:limit]
    rows.reverse()
    figures = cycles.measures([r["id"] for r in rows])
    with cycles._db() as con:
        steps = {}
        for r in rows:
            steps[r["id"]] = {s["name"]: round((s["finished"] - s["started"]) / 60, 1)
                              for s in con.execute("SELECT name, started, finished FROM step WHERE cycle_id = ? "
                                                   "AND started IS NOT NULL AND finished IS NOT NULL ORDER BY id", (r["id"],))}
    return [{"id": r["id"], "kind": r["kind"], "status": r["status"],
             "day": time.strftime("%Y-%m-%d %H:%M", time.localtime(r["started"])),
             "minutes": round(((r["finished"] or time.time()) - r["started"]) / 60, 1),
             "steps": steps[r["id"]], "figures": figures.get(r["id"], {})} for r in rows]


def warning(rows: list[dict[str, Any]] | None = None) -> str:
    """What the trend says, in words, or "": the last full night over LONG_NIGHT_S, or nights that
    grew RISING_NIGHTS times in a row (full nights that reached their end, preflight refusals aside)."""
    rows = nights() if rows is None else rows
    full = [r for r in rows if r["kind"] == "nightly" and r["status"] in ("ok", "failed") and "export" in r["steps"]]
    said = []
    if full and full[-1]["minutes"] * 60 > LONG_NIGHT_S:
        said.append(f"the last night lasted {full[-1]['minutes'] / 60:.1f} h, over {LONG_NIGHT_S / 3600:.0f} h")
    last = [r["minutes"] for r in full[-(RISING_NIGHTS + 1):]]
    if len(last) == RISING_NIGHTS + 1 and all(b > a for a, b in zip(last, last[1:])):
        said.append(f"the nights grew {RISING_NIGHTS} times in a row ({last[0]:.0f} to {last[-1]:.0f} min)")
    return "; ".join(said)


def report() -> dict[str, Any]:
    rows = nights()
    return {"nights": rows, "warning": warning(rows), "long_night_s": LONG_NIGHT_S,
            "rising_nights": RISING_NIGHTS, "asset_limit": ASSET_LIMIT}
