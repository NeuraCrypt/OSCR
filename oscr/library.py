"""Importing into the library: one record per paper, one manifest per native repository.

**The shape of the library**, designed for what comes next in the project:

    library/<article>/record.json                the paper, its links, its status
    library/<article>/native/<repo>.json         the authors' code: commit,
                                                 license, files, scripts
    library/<article>/generated/                 (to come) scripts from stat_bruteforce
    library/<article>/author/                    (to come) authors' corrections

These are JSON files: they can be versioned, published as they are on a
Hugging Face dataset or a GitHub repository, and read without the harvester.

**The snapshot** (option `--snapshots`) keeps an archive of the repository at
the verified commit, with its SHA-256 digest — the remedy against link rot. It
is only taken if the license allows redistribution (`redistributable =
yes`): a repository without a license remains a LINK and a commit, never a copy.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path

from . import repos

MAX_SNAPSHOT_MB: int = 200


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "_", text.lower()).strip("_")[:120]


def write_record(con: sqlite3.Connection, article_id: str, root: Path) -> Path:
    a = dict(con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone())
    links = [dict(r) for r in con.execute(
        "SELECT l.repo, l.url, l.host, l.kind, l.role, l.confidence, l.found_by, l.section, "
        "l.reasons, l.occurrences, r.state, r.resource_type, r.license, r.redistributable, "
        "r.commit_id, r.commit_date, r.n_files, r.n_scripts, r.languages, r.swh_archived, "
        "r.cites_article, r.linked_to, r.stars, r.created, r.verified_at "
        "FROM link l LEFT JOIN repository r ON r.repo = l.repo WHERE l.article_id = ? "
        "ORDER BY l.role, l.repo", (article_id,))]
    for l in links:
        for k in ("reasons", "languages"):
            if isinstance(l.get(k), str):
                l[k] = json.loads(l[k] or ("[]" if k == "reasons" else "{}"))
    folder = root / slug(article_id)
    record = {
        "article": {k: a[k] for k in ("id", "doi", "pmid", "pmcid", "title", "journal",
                                      "published", "license", "source")},
        "authors": json.loads(a["authors"]),
        "status": a["status"],
        "code_on_request": bool(a["code_on_request"]),
        "families": json.loads(a["families"]),
        "methods": json.loads(a["methods"]),
        "links": links,
        "scripts": {"native": [l["repo"] for l in links if l["role"] == "code"],
                    "generated": [], "author": []},
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "record.json").write_text(json.dumps(record, ensure_ascii=False, indent=1))
    for l in links:
        if l["role"] != "code" or l.get("state") != "alive":
            continue
        d = con.execute("SELECT * FROM repository WHERE repo = ?", (l["repo"],)).fetchone()
        manifest = {k: d[k] for k in d.keys() if k not in ("files", "languages", "error")}
        manifest["languages"] = json.loads(d["languages"] or "{}")
        files = json.loads(d["files"] or "[]")
        manifest["scripts"] = [f for f in files
                               if Path(f).suffix.lower() in repos.SCRIPT_EXTENSIONS][:2000]
        manifest["files"] = files
        (folder / "native").mkdir(exist_ok=True)
        (folder / "native" / f"{slug(l['repo'])}.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1))
    return folder


def snapshot(con: sqlite3.Connection, article_id: str, repo: str, git_url: str,
             root: Path, clones: Path) -> str:
    """Archive the repository at the verified commit. Returns the path, or '' if refused."""
    d = con.execute("SELECT * FROM repository WHERE repo = ?", (repo,)).fetchone()
    if d is None or d["state"] != "alive" or d["redistributable"] != "yes" or not d["commit_id"]:
        return ""
    target = root / slug(article_id) / "native" / "snapshot"
    target.mkdir(parents=True, exist_ok=True)
    archive = target / f"{slug(repo)}@{d['commit_id'][:12]}.tar.gz"
    if not archive.exists():
        clones.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix="snap_", dir=clones))
        try:
            c = repos._git(["clone", "--quiet", "--depth", "1", git_url, str(tmp / "d")], timeout=600)
            if c.returncode != 0:
                return ""
            size = sum(f.stat().st_size for f in (tmp / "d").rglob("*") if f.is_file())
            if size > MAX_SNAPSHOT_MB * 1e6:
                return ""
            repos._git(["archive", "--format=tar.gz", "-o", str(archive), "HEAD"], cwd=tmp / "d")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    if not archive.exists():
        return ""
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    con.execute("UPDATE script SET level='imported', path=?, digest=?, imported_at=? "
                "WHERE article_id=? AND origin='native' AND repo=?",
                (str(archive.relative_to(root)), digest, time.time(), article_id, repo))
    return str(archive)
