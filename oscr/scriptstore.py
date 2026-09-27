"""The authors' scripts on Hugging Face: deduplicated, zstd, Parquet blocks, one manifest
per repository (decided on 2026-09-26: CLAUDE.md, docs/SCRIPT_STORAGE.md).

- **Blocks** (`blocks/NNNNN.parquet`): one row per unique file, keyed by the SHA-256 of
  its text: `sha256`, `language`, `size`, `lines`, `content`. Parquet page compression
  zstd level 19, 64 rows per row group and 64 KiB pages, so that a browser reading one
  script by HTTP range requests downloads ~78 KB. Rows are sorted by language, then
  size: similar files compress together. **A published block never changes**: a new
  file goes into a new block.
- **Manifests** (`manifests/<xx>/<repository>.json`): per repository, its commit, its
  license and, for each file, the digest and the (block, row) that hold its text. The
  website writes these positions into its static pages at build time; pages rendered
  on demand read the manifest.
- **Only verified licenses leave the Mac.** A file is published when the license of its
  repository allows redistribution AND is confirmed:
  - for a git repository, by its root license file;
  - for an archive (Zenodo, figshare, …), by a license file of the archive, or else by the
    license of its record;
  - a license inferred from a README sentence, "other-open" without a license file, or
    no license: the file stays on the Mac.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from . import repos

FORMAT = "oscr-script-manifest/1"
#: Parquet layout, measured on 2026-09-26 (docs/SCRIPT_STORAGE.md).
ROWS_PER_GROUP = 64
PAGE_BYTES = 64 * 1024
ZSTD_LEVEL = 19
#: Raw text per block: ~6× smaller once compressed, i.e. blocks of ~30 MB.
RAW_BYTES_PER_BLOCK = 192 * 1024 * 1024

OPEN = frozenset(repos._OPEN)
CONDITIONS = frozenset(repos._CONDITIONS)
_LICENSE_FILE = re.compile(r"(?i)^(licen[cs]e|copying|copyright)(\.\w+)?$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS script_blob (
    sha256     TEXT PRIMARY KEY,
    block      INTEGER NOT NULL,
    row        INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    language   TEXT NOT NULL DEFAULT '',
    stored_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS script_block (
    block         INTEGER PRIMARY KEY,
    rows          INTEGER NOT NULL,
    bytes         INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    created_at    REAL NOT NULL,
    published_at  REAL
);
CREATE TABLE IF NOT EXISTS script_manifest (
    repo          TEXT PRIMARY KEY,
    path          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    written_at    REAL NOT NULL,
    published_at  REAL,
    withdrawn_at  REAL
);
"""


def ensure_schema(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)


def text_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def manifest_path(repo: str) -> str:
    shard = hashlib.sha1(repo.encode()).hexdigest()[:2]
    return f"manifests/{shard}/{re.sub(r'[^A-Za-z0-9._-]+', '__', repo)}.json"


def _license_files(con: sqlite3.Connection, repo: str, kind: str) -> list[sqlite3.Row]:
    """The repository's license files: at its root for a git repository; at the root or
    one folder down for an archive (a release zip holds `name-v1.0/LICENSE`)."""
    depth = 0 if kind == "forge" else 1
    rows = con.execute("SELECT path, text FROM file WHERE repo = ? AND text IS NOT NULL AND text != '' "
                       "ORDER BY length(path), path", (repo,)).fetchall()
    return [r for r in rows if r["path"].count("/") <= depth and _LICENSE_FILE.match(r["path"].rsplit("/", 1)[-1])]


def verified_license(con: sqlite3.Connection, repo: sqlite3.Row) -> tuple[str, str] | None:
    """(SPDX id, how it was confirmed) when the files may be published, else None."""
    files = _license_files(con, repo["repo"], repo["kind"])
    if files:
        spdx = repos.license_of(files[0]["text"])
        return (spdx, f"license file {files[0]['path']}") if spdx in OPEN | CONDITIONS else None
    if repo["kind"] == "archive" and repo["license"] in OPEN | CONDITIONS:
        return repo["license"], "license of the archive's record"
    return None


def audit(con: sqlite3.Connection) -> dict[str, Any]:
    """What would leave the Mac, and why the rest stays."""
    out: dict[str, Any] = {"published": {}, "held": {}, "mismatch": []}
    rows = con.execute("SELECT r.*, COUNT(f.path) AS n FROM repository r JOIN file f ON f.repo = r.repo "
                       "WHERE f.text IS NOT NULL AND f.text != '' GROUP BY r.repo").fetchall()
    for r in rows:
        v = verified_license(con, r)
        if v:
            key = f"{v[0]} ({'license file' if v[1].startswith('license file') else 'record'})"
            bucket = out["published"]
            if v[0] != r["license"]:
                out["mismatch"].append({"repo": r["repo"], "recorded": r["license"], "verified": v[0]})
        else:
            reason = ("no license" if not r["license"] else
                      "license file not recognized as open" if _license_files(con, r["repo"], r["kind"]) else
                      f"'{r['license']}' not confirmed by a license file")
            key, bucket = reason, out["held"]
        b = bucket.setdefault(key, {"repositories": 0, "files": 0})
        b["repositories"] += 1
        b["files"] += r["n"]
    return out


def _publishable(con: sqlite3.Connection) -> Iterable[tuple[sqlite3.Row, tuple[str, str], list[sqlite3.Row]]]:
    for r in con.execute("SELECT * FROM repository WHERE redistributable IN ('yes', 'with_conditions') "
                         "ORDER BY repo").fetchall():
        v = verified_license(con, r)
        if not v:
            continue
        files = con.execute("SELECT path, version, language, lines, truncated, text FROM file WHERE repo = ? "
                            "AND text IS NOT NULL AND text != '' ORDER BY path", (r["repo"],)).fetchall()
        if files:
            yield r, v, files


def _write_block(path: Path, rows: list[tuple[str, str, int, int, str]]) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq
    table = pa.table({
        "sha256": [r[0] for r in rows],
        "language": [r[1] for r in rows],
        "size": pa.array([r[2] for r in rows], pa.int32()),
        "lines": pa.array([r[3] for r in rows], pa.int32()),
        "content": [r[4] for r in rows],
    })
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    pq.write_table(table, tmp, compression="zstd", compression_level=ZSTD_LEVEL,
                   row_group_size=ROWS_PER_GROUP, data_page_size=PAGE_BYTES,
                   use_dictionary=["language"], write_page_index=True, write_statistics=["size"])
    tmp.replace(path)


def build(con: sqlite3.Connection, folder: Path, *, now: float | None = None) -> dict[str, Any]:
    """Add the new unique files as new blocks, and (re)write the manifests that changed.
    Returns what was written, relative to `folder`: only those files are to be sent."""
    ensure_schema(con)
    now = now or time.time()
    folder = Path(folder)
    publishable = list(_publishable(con))
    known = {r[0] for r in con.execute("SELECT sha256 FROM script_blob")}
    new: dict[str, tuple[str, str, int, int, str]] = {}
    for _, _, files in publishable:
        for f in files:
            h = text_digest(f["text"])
            if h not in known and h not in new:
                b = f["text"].encode("utf-8")
                new[h] = (h, f["language"] or "", len(b), f["text"].count("\n") + (not f["text"].endswith("\n")), f["text"])
    written: list[str] = []
    rows = sorted(new.values(), key=lambda r: (r[1], r[2], r[0]))
    block = (con.execute("SELECT MAX(block) FROM script_block").fetchone()[0] or 0)
    start = 0
    while start < len(rows):
        size, end = 0, start
        while end < len(rows) and (end == start or size + rows[end][2] <= RAW_BYTES_PER_BLOCK):
            size += rows[end][2]
            end += 1
        block += 1
        chunk = rows[start:end]
        rel = f"blocks/{block:05d}.parquet"
        _write_block(folder / rel, chunk)
        data = (folder / rel).read_bytes()
        con.execute("INSERT INTO script_block (block, rows, bytes, sha256, created_at) VALUES (?,?,?,?,?)",
                    (block, len(chunk), len(data), hashlib.sha256(data).hexdigest(), now))
        con.executemany("INSERT INTO script_blob (sha256, block, row, size, language, stored_at) VALUES (?,?,?,?,?,?)",
                        [(r[0], block, i, r[2], r[1], now) for i, r in enumerate(chunk)])
        written.append(rel)
        start = end
    place = {r["sha256"]: (r["block"], r["row"]) for r in con.execute("SELECT sha256, block, row FROM script_blob")}
    manifests = 0
    current = set()
    for r, (spdx, how), files in publishable:
        current.add(r["repo"])
        entries = []
        for f in files:
            h = text_digest(f["text"])
            b, row = place[h]
            entries.append({"path": f["path"], "sha256": h, "language": f["language"] or "",
                            "lines": f["lines"], "truncated": bool(f["truncated"]), "block": b, "row": row})
        doc = {"format": FORMAT, "repository": r["repo"], "url": r["url"], "host": r["host"],
               "commit": r["commit_id"] or (files[0]["version"] or ""), "license": spdx,
               "license_confirmed_by": how, "redistribution": repos.redistributable(spdx), "files": entries}
        data = json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=False).encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        rel = manifest_path(r["repo"])
        seen = con.execute("SELECT sha256, withdrawn_at FROM script_manifest WHERE repo = ?", (r["repo"],)).fetchone()
        if seen and seen["sha256"] == digest and not seen["withdrawn_at"] and (folder / rel).exists():
            continue
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_bytes(data)
        con.execute("INSERT INTO script_manifest (repo, path, sha256, written_at) VALUES (?,?,?,?) "
                    "ON CONFLICT(repo) DO UPDATE SET sha256 = excluded.sha256, written_at = excluded.written_at, "
                    "published_at = NULL, withdrawn_at = NULL", (r["repo"], rel, digest, now))
        written.append(rel)
        manifests += 1
    # A repository that is no longer publishable (its license changed) loses its manifest.
    withdrawn = [r["path"] for r in con.execute("SELECT repo, path FROM script_manifest WHERE withdrawn_at IS NULL")
                 if r["repo"] not in current]
    for rel in withdrawn:
        con.execute("UPDATE script_manifest SET withdrawn_at = ?, published_at = NULL WHERE path = ?", (now, rel))
        (folder / rel).unlink(missing_ok=True)
    con.commit()
    return {"blocks": [w for w in written if w.startswith("blocks/")], "new_files": len(rows),
            "manifests": manifests, "withdrawn": withdrawn, "written": written,
            "repositories": len(publishable)}


def card(con: sqlite3.Connection, platform: str) -> str:
    """The dataset card: what the files are, and under which licenses."""
    n_files, n_bytes = con.execute("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM script_blob").fetchone()
    n_repos = con.execute("SELECT COUNT(*) FROM script_manifest WHERE withdrawn_at IS NULL").fetchone()[0]
    n_blocks = con.execute("SELECT COUNT(*) FROM script_block").fetchone()[0]
    licenses: dict[str, int] = {}
    for r in con.execute("SELECT r.license, COUNT(*) FROM script_manifest m JOIN repository r ON r.repo = m.repo "
                         "WHERE m.withdrawn_at IS NULL GROUP BY 1 ORDER BY 2 DESC"):
        licenses[r[0]] = r[1]
    rows = "\n".join(f"| {k} | {v} |" for k, v in licenses.items())
    return f"""---
license: other
license_name: per-file
license_link: LICENSE.md
pretty_name: {platform} scripts
tags:
- neuroscience
- research-software
- code
- reproducibility
configs:
- config_name: scripts
  data_files: blocks/*.parquet
---

# {platform}: the authors' scripts

The code published by the authors of open-access neuroscience papers, as found and
verified by {platform}. Each file is here exactly as it is at the source, at the verified
commit, **under the license of its repository**.

- **{n_files:,} unique files** ({n_bytes / 1e6:,.0f} MB of text) from **{n_repos:,} repositories**,
  in {n_blocks} Parquet block(s).
- **Only files whose repository's license allows redistribution**, confirmed by the
  repository's own license file (or, for an archive without one, by its record). Files
  without such a license are never copied here: {platform} links to them at the source.
- No text of any paper.

## Layout

- `blocks/NNNNN.parquet`: one row per unique file (SHA-256 of its text):
  `sha256`, `language`, `size`, `lines`, `content`. zstd page compression, 64 rows per
  row group: a single file can be read with HTTP range requests (for example with
  hyparquet in a browser). A published block never changes; new files go into new
  blocks.
- `manifests/<xx>/<repository>.json`: per repository, its URL, commit and license, and
  for each file its path, digest, and the (block, row) holding its text.

## Licenses

Each file keeps the license of its repository, given in the repository's manifest
(`license`, `license_confirmed_by`). Repositories by license:

| license | repositories |
|---|---|
{rows}

Files under a non-commercial license (CC BY-NC…) may only be reused non-commercially.

## Takedown

An author who wants a file removed: open an issue at
https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR-/issues.
"""


LICENSE_NOTE = """# Licenses

This dataset has no license of its own. Every file keeps the license of the repository
it comes from, recorded in that repository's manifest (`manifests/…/<repository>.json`,
fields `license` and `license_confirmed_by`), with the repository's URL and commit.
"""


def pending(con: sqlite3.Connection) -> tuple[list[str], list[str]]:
    """What the dataset does not have yet: the unpublished blocks and manifests, and the
    manifests to remove. Built from the database, so a failed upload is simply sent again
    by the next one."""
    ensure_schema(con)
    send = [f"blocks/{r[0]:05d}.parquet" for r in
            con.execute("SELECT block FROM script_block WHERE published_at IS NULL ORDER BY block")]
    send += [r[0] for r in con.execute("SELECT path FROM script_manifest WHERE published_at IS NULL "
                                       "AND withdrawn_at IS NULL ORDER BY path")]
    remove = [r[0] for r in con.execute("SELECT path FROM script_manifest WHERE published_at IS NULL "
                                        "AND withdrawn_at IS NOT NULL ORDER BY path")]
    return send, remove


#: The macOS keychain entry of the Hugging Face token allowed to write to the scripts'
#: dataset, which belongs to an organization that the owner's own login may not reach.
#: Never in a file of the project nor in the settings (CLAUDE.md).
KEYCHAIN_SERVICE = "org.oscr.huggingface"


def token() -> str | None:
    """The token for the scripts' dataset: $OSCR_HF_TOKEN, else the keychain entry, else
    None (the default Hugging Face login)."""
    if os.environ.get("OSCR_HF_TOKEN", "").strip():
        return os.environ["OSCR_HF_TOKEN"].strip()
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (r.stdout.strip() or None) if r.returncode == 0 else None


def publish(con: sqlite3.Connection, folder: Path, dataset: str, *, platform: str,
            dry_run: bool = False) -> str:
    """Send what the dataset does not have yet (and the card), remove withdrawn manifests.
    Published blocks are never sent again."""
    folder = Path(folder)
    send, remove = pending(con)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "README.md").write_text(card(con, platform))
    (folder / "LICENSE.md").write_text(LICENSE_NOTE)
    send += ["README.md", "LICENSE.md"]
    if dry_run:
        return f"dry run: {len(send)} files to send, {len(remove)} to remove → {dataset}"
    from huggingface_hub import HfApi
    HfApi(token=token()).upload_folder(
        folder_path=str(folder), repo_id=dataset, repo_type="dataset", allow_patterns=send,
        delete_patterns=remove or None,
        commit_message=f"Scripts of {time.strftime('%Y-%m-%d', time.gmtime())}: "
                       f"{sum(1 for w in send if w.startswith('blocks/'))} new block(s), "
                       f"{sum(1 for w in send if w.startswith('manifests/'))} manifest(s), {len(remove)} removed")
    now = time.time()
    con.execute("UPDATE script_block SET published_at = ? WHERE published_at IS NULL", (now,))
    con.execute("UPDATE script_manifest SET published_at = ? WHERE published_at IS NULL", (now,))
    con.commit()
    return f"{len(send)} files sent, {len(remove)} removed → huggingface.co/datasets/{dataset}"
