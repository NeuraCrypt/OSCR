"""Retractions, corrections and expressions of concern, from the Retraction Watch data.

Crossref bought the Retraction Watch database in 2023 and publishes it openly: one CSV,
updated every working day, at gitlab.com/crossref/retraction-watch-data (67 MB on
2026-09-26). One download a week, kept on the Mac, and every paper is looked up locally
by its DOI: no request per paper (the free-tier research of 2026-09-26 recommended this
over the Crossref API, whose list queries allow 1–3 requests a second).
"""
from __future__ import annotations

import csv
import time
from pathlib import Path
from typing import Any

import httpx

URL = "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv"
#: Retraction Watch's `RetractionNature` → the kinds of `integrity_notice`.
KINDS = {"retraction": "retraction", "correction": "correction", "expression of concern": "concern",
         "reinstatement": "reinstatement"}
MAX_AGE_S = 7 * 86400


def refresh(folder: Path, *, max_age_s: float = MAX_AGE_S, timeout_s: float = 300) -> Path:
    """The local copy of the CSV, downloaded again when older than a week (and only if it
    changed: the ETag of the last download is kept next to it)."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    path, etag_file = folder / "retraction_watch.csv", folder / "retraction_watch.etag"
    if path.exists() and time.time() - path.stat().st_mtime < max_age_s:
        return path
    headers = {"If-None-Match": etag_file.read_text().strip()} if path.exists() and etag_file.exists() else {}
    tmp = path.with_suffix(".tmp")
    with httpx.stream("GET", URL, headers=headers, timeout=timeout_s, follow_redirects=True) as r:
        if r.status_code == 304:
            path.touch()
            return path
        r.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
        etag = r.headers.get("etag", "")
    tmp.replace(path)
    if etag:
        etag_file.write_text(etag)
    return path


def _doi(value: str) -> str:
    v = (value or "").strip().lower()
    return "" if v in ("", "unavailable", "0") else v.removeprefix("https://doi.org/")


_INDEX: dict[str, Any] = {"mtime": None, "path": None, "notices": {}}


def notices(csv_path: Path) -> dict[str, list[dict[str, str]]]:
    """DOI of the original paper → its notices: kind, the notice's DOI, date, reasons.
    Read once per process, again when the file changes."""
    csv_path = Path(csv_path)
    mtime = csv_path.stat().st_mtime
    if _INDEX["path"] == csv_path and _INDEX["mtime"] == mtime:
        return _INDEX["notices"]
    out: dict[str, list[dict[str, str]]] = {}
    with csv_path.open(newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            doi = _doi(row.get("OriginalPaperDOI", ""))
            kind = KINDS.get((row.get("RetractionNature") or "").strip().lower())
            if not doi or not kind:
                continue
            out.setdefault(doi, []).append({
                "kind": kind, "id": _doi(row.get("RetractionDOI", "")) or f"rw:{row.get('Record ID', '')}",
                "date": (row.get("RetractionDate") or "").split(" ")[0],
                "reasons": "; ".join(r.strip().lstrip("+") for r in (row.get("Reason") or "").split(";") if r.strip()),
                "source": "retraction-watch"})
    _INDEX.update(mtime=mtime, path=csv_path, notices=out)
    return out
