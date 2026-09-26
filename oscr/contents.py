"""The text of scripts: what is kept of each repository, readable as is.

**Why the text and not the archive.** The library is meant to be READ: a
researcher opens a paper's panel, picks a script, reads it. Text goes into the
database, can be searched, and compared with the script generated from the
paper. An archive is downloaded and opened elsewhere.

**What is kept.** Scripts (the extensions of `repos.SCRIPT_EXTENSIONS`), plus
the README and the LICENSE at the root — without the license, we would not know
whether the text may be republished. A Jupyter notebook becomes text "by cells"
(jupytext's percent format): its outputs, images included, often weigh a
hundred times its code and cannot be read.

**What is refused, and said so.** A binary file (an `.mlx` is a zip); a text
over 200 KB is cut (`truncated`); beyond 2,000 files or 30 MB per repository,
we stop. Every refusal leaves a `note`: the panel says why a script has no
text, it does not show it empty.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
from pathlib import Path
from typing import IO, Any

from .repos import SCRIPT_EXTENSIONS

#: A longer text is cut: 200 KB is ~5,000 lines of code.
MAX_TEXT: int = 200_000
MAX_FILES: int = 2000
MAX_TOTAL: int = 30_000_000
#: A bigger archive is not downloaded (a code zip rarely weighs 60 MB).
MAX_ARCHIVE: int = 60_000_000

_DOCS = re.compile(r"(?i)^(readme|licen[cs]e|copying)(\.(md|txt|rst|markdown))?$")
_ARCHIVES = (".zip",)


def is_script(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in SCRIPT_EXTENSIONS


def is_doc(path: str) -> bool:
    """The README and the license at the ROOT (of a repository or of an archive)."""
    return "/" not in path.strip("/") and bool(_DOCS.match(path.strip("/")))


def language(path: str) -> str:
    if is_doc(path):
        return "License" if re.match(r"(?i)^(licen|copying)", path) else "Text"
    return SCRIPT_EXTENSIONS.get(os.path.splitext(path)[1].lower(), "")


def notebook_to_text(raw: str) -> str:
    """An .ipynb as text by cells, without the outputs."""
    try:
        nb = json.loads(raw)
    except ValueError:
        return raw
    pieces = []
    for cell in nb.get("cells", []):
        source = cell.get("source", "")
        source = "".join(source) if isinstance(source, list) else str(source)
        if cell.get("cell_type") == "markdown":
            pieces.append("# %% [markdown]\n" + "\n".join("# " + l for l in source.splitlines()))
        elif cell.get("cell_type") == "code":
            pieces.append("# %%\n" + source)
    return "\n\n".join(pieces) + "\n"


def decode(data: bytes) -> str:
    """UTF-8, else Windows-1252, else Latin-1 — never the U+FFFD replacement character.

    Many MATLAB scripts are written on Windows: their accented comments are not
    UTF-8. Decoding them as UTF-8 with replacement damaged them, and the
    publishing tool rejected the batch.
    """
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def read(path: str, data: bytes) -> dict[str, Any]:
    """A file → its row of the `file` table."""
    record: dict[str, Any] = {
        "path": path, "language": language(path),
        "kind": "doc" if is_doc(path) else "script", "size": len(data),
        "digest": hashlib.sha256(data).hexdigest(), "text": None, "truncated": 0,
        "note": "", "lines": None}
    if path.lower().endswith(".mlx") or b"\x00" in data[:8000]:
        record["note"] = "binary file: readable only at the source"
        return record
    text = decode(data)
    if path.lower().endswith(".ipynb"):
        text = notebook_to_text(text)
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
        record["truncated"] = 1
        record["note"] = f"cut at {MAX_TEXT // 1000} KB"
    record["text"] = text
    record["lines"] = text.count("\n") + (0 if text.endswith("\n") else 1)
    return record


def from_folder(root: Path, paths: list[str]) -> list[dict[str, Any]]:
    """The scripts of a working copy (a checked-out git repository)."""
    out, total = [], 0
    for p in paths:
        if len(out) >= MAX_FILES or total >= MAX_TOTAL:
            out.append(_stop_note(len(paths) - len(out)))
            break
        f = root / p
        if not f.is_file():
            continue
        data = f.read_bytes()
        total += len(data)
        out.append(read(p, data))
    return out


def from_zip(source: bytes | IO[bytes]) -> list[dict[str, Any]]:
    """The scripts of a zip archive — a GitHub release deposited on Zenodo, the
    "Source code 1" of an eLife paper —, as bytes or as an open file. The common
    top folder (`owner-repo-v1.0/`) is removed from the paths."""
    try:
        z = zipfile.ZipFile(io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else source)
    except zipfile.BadZipFile:
        return []
    names = [i.filename for i in z.infolist() if not i.is_dir()]
    top = os.path.commonprefix([n.split("/")[0] + "/" for n in names]) if len(names) > 1 else ""
    if top and not all(n.startswith(top) for n in names):
        top = ""
    out, total = [], 0
    for info in z.infolist():
        if info.is_dir() or "__MACOSX/" in info.filename:
            continue
        path = info.filename[len(top):] if top else info.filename
        if not (is_script(path) or is_doc(path)):
            continue
        if len(out) >= MAX_FILES or total >= MAX_TOTAL:
            out.append(_stop_note(0))
            break
        if info.file_size > MAX_TOTAL:
            continue
        with z.open(info) as f:
            b = f.read()
        total += len(b)
        out.append(read(path, b))
    return out


def _stop_note(remaining: int) -> dict[str, Any]:
    return {"path": "…", "language": "", "kind": "note", "size": 0, "digest": "",
            "text": None, "truncated": 0, "lines": None,
            "note": "repository limit reached (2,000 files or 30 MB): the rest is at the source"
                    + (f" ({remaining} files)" if remaining else "")}
