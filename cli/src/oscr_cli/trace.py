"""Tracing maps from the terminal (``oscr trace``; D14-8): the maps the registry holds for a repository,
checked against a commit of a local clone; and a map proposed from lines selected at a commit.

- The registry's maps come from its static shards, ``/forge/traced/NN.json`` (NN: the first byte of
  SHA-256 of "owner/name" in lower case, mod 64, as the site's code view reads them): no token, no
  Worker request.
- A map's lines are found again at another commit the site's way (website/src/lib/traced.ts
  ``relocate`` and ``locateBySymbol``, ported): the same lines where they are now, the nearest copy;
  else the map's symbol; else they changed.
- Trace points are read from permalinks as the site and the Mac read them (``parse_permalink``, held
  to tests/fixtures/permalinks.json): an address at a branch is no trace point.
- Files are read with ``git show`` as text. Nothing of the repository is run.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

LAYER_SHARDS = 64
OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SEGMENT = re.compile(r"^(?!\.+$)[A-Za-z0-9._-]{1,100}$")
_LINE_ANCHOR = re.compile(r"^L(\d{1,7})(?:C\d{1,5})?(?:-L(\d{1,7})(?:C\d{1,5})?)?$")
_UNSAFE_URL = re.compile(r"[\s\x00-\x1f\x7f\\]|%(?![0-9A-Fa-f]{2})|%2f", re.IGNORECASE)
_DOT_SEGMENT = re.compile(r"/(?:\.|%2e){1,2}(?=/|$|[?#])", re.IGNORECASE)


def shard_of(owner: str, name: str) -> str:
    """The static shard of a repository: ``"00"`` to ``"63"``."""
    return f"{hashlib.sha256(f'{owner}/{name}'.lower().encode()).digest()[0] % LAYER_SHARDS:02d}"


@dataclass(frozen=True)
class TracePoint:
    owner: str
    name: str
    commit: str
    path: str
    lines: tuple[int, int] | None


def parse_permalink(url: str, *, web: str = "https://github.com", sites: tuple[str, ...] = ()) -> TracePoint | None:
    """A permalink → its trace point, or None (the Mac's ``oscr/forge.py`` reading, ported)."""
    if not isinstance(url, str) or not url or len(url) > 4096 or _UNSAFE_URL.search(url) or _DOT_SEGMENT.search(url):
        return None
    relative = url.startswith("/") and not url.startswith("//")
    if not relative and not re.match(r"^https?://", url, re.IGNORECASE):
        return None
    try:
        u, w = urlsplit(url), urlsplit(web)
        parts = [unquote(p, errors="strict") for p in u.path.split("/")]
    except (ValueError, UnicodeDecodeError):
        return None
    if parts[0] != "":
        return None
    parts = parts[1:]
    host = (u.hostname or "").lower()
    site_hosts = {(urlsplit(s).hostname or "").lower() for s in sites}
    if relative or host in site_hosts:
        if not parts or parts[0] != "r":
            return None
        parts = parts[1:]
    elif host == (w.hostname or "").lower() and (u.port == w.port):
        if u.scheme.lower() != w.scheme.lower():
            return None
        # An address through a prefix (the fake GitHub's /web): the prefix first.
        prefix = [p for p in w.path.split("/") if p]
        if parts[: len(prefix)] != prefix:
            return None
        parts = parts[len(prefix):]
    else:
        return None
    if len(parts) < 5:
        return None
    owner, name, kind, commit, *rest = parts
    if kind != "blob" or not OBJECT_ID.match(commit) or not SEGMENT.match(owner) or not SEGMENT.match(name):
        return None
    if not rest or any(s in ("", ".", "..") or re.search(r"[\x00-\x1f]", s) for s in rest):
        return None
    lines: tuple[int, int] | None = None
    if u.fragment:
        m = _LINE_ANCHOR.match(u.fragment)
        a = int(m.group(1)) if m else 0
        b = int(m.group(2) or m.group(1)) if m else 0
        if not m or a < 1 or b < 1:
            return None
        lines = (min(a, b), max(a, b))
    return TracePoint(owner, re.sub(r"\.git$", "", name, flags=re.IGNORECASE), commit, "/".join(rest), lines)


# ── finding a map's lines again (website/src/lib/traced.ts) ──


def _norm(line: str) -> str:
    return re.sub(r"\s+$", "", line)


def relocate(old: list[str], new: list[str], start: int, end: int) -> tuple[int, int] | None:
    """The map's lines where they are now (the nearest copy), or None when they changed."""
    if start < 1 or end > len(old) or end < start:
        return None
    block = [_norm(x) for x in old[start - 1:end]]
    if all(not x.strip() for x in block):
        return None
    best: int | None = None
    for i in range(0, len(new) - len(block) + 1):
        if _norm(new[i]) != block[0]:
            continue
        if all(_norm(new[i + k]) == block[k] for k in range(1, len(block))) and (best is None or abs(i + 1 - start) < abs(best + 1 - start)):
            best = i
    return None if best is None else (best + 1, best + len(block))


def locate_by_symbol(lines: list[str], start: int, end: int, symbol: str) -> tuple[int, int] | None:
    """Without the map's version: its range where its symbol still stands."""
    sym = re.split(r"[.:]", re.sub(r"\(\)$", "", symbol or ""))[-1]
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,100}$", sym):
        return None
    esc = re.escape(sym)
    word = re.compile(rf"(?<![A-Za-z0-9_]){esc}(?![A-Za-z0-9_])")
    define = re.compile(rf"(?:\b(?:def|function|class|fn|func|sub|subroutine|procedure|module|struct|interface)\s+{esc}(?![A-Za-z0-9_]))|(?:^\s*{esc}\s*(?:<-|=)\s*function\b)", re.I)
    length = end - start
    in_range = end <= len(lines)
    at = next((i + 1 for i, line in enumerate(lines) if define.search(line)), 0)
    if in_range and ((start <= at <= end) or (not at and any(word.search(x) for x in lines[start - 1:end]))):
        return (start, end)
    if at:
        return (at, min(len(lines), at + length))
    return None


def split_lines(text: str) -> list[str]:
    """A file's lines as the site splits them (a final line feed leaves an empty last line)."""
    return text.split("\n")


LEVEL_OF = {"exact": "ok", "moved": "notice", "symbol": "notice", "changed": "warning", "gone": "failure", "broken": "failure", "unread": "warning"}


def check_pair(git: Any, top: Path, map_commit: str, at: str, pair: dict[str, Any]) -> dict[str, Any]:
    """One pair of a map, at the commit ``at``: how its lines are found there."""
    path, start, end = str(pair["path"]), int(pair["start"]), int(pair["end"])
    shown = git.read_text(top, at, path, max_bytes=4 * 2**20)
    base = {"path": path, "start": start, "end": end, "paragraph": pair.get("paragraph"), "section": pair.get("section", ""), "symbol": pair.get("symbol", "")}
    if shown is None:
        return {**base, "how": "gone", "lines": None, "words": f"{path} is not in this commit."}
    new = split_lines(shown)
    if map_commit == at:
        ok = end <= len(new)
        return {**base, "how": "exact" if ok else "broken", "lines": [start, end] if ok else None,
                "words": "at the map's own commit" if ok else f"lines {start}–{end} are past the end of {path} at the map's own commit"}
    old_text = git.read_text(top, map_commit, path, max_bytes=4 * 2**20) if git.has_commit(top, map_commit) else None
    if old_text is not None:
        found = relocate(split_lines(old_text), new, start, end)
        if found:
            how = "exact" if found[0] == start else "moved"
            words = "the same lines, in the same place" if how == "exact" else f"the same lines, moved to {found[0]}–{found[1]}"
            return {**base, "how": how, "lines": list(found), "words": words}
        by_symbol = locate_by_symbol(new, start, end, str(pair.get("symbol") or ""))
        if by_symbol:
            return {**base, "how": "changed", "lines": list(by_symbol), "words": f"the lines changed; its symbol {pair.get('symbol')} is at {by_symbol[0]}–{by_symbol[1]}"}
        return {**base, "how": "changed", "lines": None, "words": "the lines changed, and the map's symbol is not found"}
    by_symbol = locate_by_symbol(new, start, end, str(pair.get("symbol") or ""))
    if by_symbol:
        return {**base, "how": "symbol", "lines": list(by_symbol), "words": f"the map's commit is not in this clone; found by its symbol at {by_symbol[0]}–{by_symbol[1]} (fetch the map's commit to compare the lines)"}
    return {**base, "how": "unread", "lines": None, "words": "the map's commit is not in this clone, and its symbol is not found: fetch it (git fetch) to compare"}


def symbol_of(lines: list[str]) -> str:
    """The name a range defines, read from its text: a def, a function, an assignment of a function."""
    for line in lines:
        m = re.search(r"\b(?:def|function|class|fn|func|sub|subroutine|procedure|module|struct)\s+([A-Za-z_][A-Za-z0-9_]{0,100})", line, re.I)
        if m:
            return m.group(1)
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_.]{0,100})\s*(?:<-|=)\s*function\b", line)
        if m:
            return m.group(1)
    return ""
