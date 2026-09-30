"""The local dashboard: the database's table, and nothing else.

A small server, standard library only, which READS the database live, nothing to
regenerate: what the harvester wrote is there at the next reload. It listens on
127.0.0.1 only (the machine itself) and offers no write.

    GET /                          the page
    GET /api/stats                 the counts
    GET /api/enrichment            how much of the Phase 1 enrichment is filled
    GET /api/articles?q=&all=&offset=&n=
    GET /api/scripts?article=      the files of a paper's repositories (without text)
    GET /api/file?repo=&path=      the text of a file

On the owner's machine, the text of every script is readable, licensed or not: it is
their private database. What gets PUBLISHED (website, Hugging Face) follows the license
rule of `catalog.py`.
"""
from __future__ import annotations

import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .catalog import file_url

PAGE = Path(__file__).parent / "dashboard.html"
CODE_STATUSES = ("code_verified", "code_found", "code_empty", "code_dead")
MAX_PER_PAGE = 500


def _read_only(db_path: Path) -> sqlite3.Connection:
    """A READ-ONLY connection: the harvester may write at the same time."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def stats(con: sqlite3.Connection) -> dict[str, Any]:
    q = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "articles": q("SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL"),
        "with_code": q("SELECT COUNT(*) FROM article WHERE status IN ('code_verified','code_found',"
                       "'code_empty','code_dead')"),
        "repositories": q("SELECT COUNT(DISTINCT repo) FROM link WHERE role = 'code'"),
        "scripts": q("SELECT COUNT(*) FROM file WHERE kind = 'script'"),
        "aligned": q("SELECT COUNT(DISTINCT article_id) FROM alignment"),
        "updated": q("SELECT MAX(scanned_at) FROM article"),
        # Where the backfill of the stock stands: the month in progress, per domain.
        "backfill": {r[0].split(":", 1)[1]: r[1] for r in con.execute(
            "SELECT source, value FROM cursor WHERE source LIKE 'backfill:%'")},
    }


def articles(con: sqlite3.Connection, search: str, all_articles: bool, offset: int, n: int) -> dict[str, Any]:
    conditions, params = ["a.scanned_at IS NOT NULL"], []
    if not all_articles:
        conditions.append(f"a.status IN ({','.join('?' * len(CODE_STATUSES))})")
        params += CODE_STATUSES
    if search:
        pattern = f"%{search}%"
        conditions.append("(a.title LIKE ? OR a.doi LIKE ? OR a.journal LIKE ? OR EXISTS "
                          "(SELECT 1 FROM link l WHERE l.article_id = a.id AND l.role = 'code' "
                          "AND l.repo LIKE ?))")
        params += [pattern] * 4
    where = " AND ".join(conditions)
    total = con.execute(f"SELECT COUNT(*) FROM article a WHERE {where}", params).fetchone()[0]
    rows = []
    for a in con.execute(f"SELECT a.id, a.doi, a.title, a.journal, a.published, a.status FROM article a "
                         f"WHERE {where} ORDER BY a.published DESC, a.id LIMIT ? OFFSET ?",
                         [*params, n, offset]):
        code = [dict(r) for r in con.execute(
            "SELECT l.repo, l.url, r.state, r.license, "
            "(SELECT COUNT(*) FROM file f WHERE f.repo = l.repo AND f.kind != 'note') AS n "
            "FROM link l LEFT JOIN repository r ON r.repo = l.repo "
            "WHERE l.article_id = ? AND l.role = 'code' ORDER BY l.repo", (a["id"],))]
        for c in code:
            if not c["url"].startswith("http"):
                c["url"] = (f"https://doi.org/{c['repo'][4:]}" if c["repo"].startswith("doi:")
                            else file_url({"repo": c["repo"], "url": c["url"]}, ""))
        pairs = con.execute("SELECT COUNT(*) FROM alignment WHERE article_id = ?", (a["id"],)).fetchone()[0]
        rows.append({"id": a["id"], "doi": a["doi"], "title": a["title"], "journal": a["journal"],
                     "published": a["published"], "status": a["status"], "code": code, "pairs": pairs})
    return {"total": total, "rows": rows}


def scripts(con: sqlite3.Connection, article_id: str) -> dict[str, Any]:
    repos = []
    for d in con.execute("SELECT r.* FROM link l JOIN repository r ON r.repo = l.repo "
                         "WHERE l.article_id = ? AND l.role = 'code' ORDER BY r.repo", (article_id,)):
        files = [{"path": f["path"], "language": f["language"], "lines": f["lines"], "kind": f["kind"],
                  "readable": bool(f["text"]), "note": f["note"],
                  "source_url": file_url(d, f["path"]) if f["kind"] != "note" else ""}
                 for f in con.execute("SELECT path, language, lines, kind, note, text IS NOT NULL AS text "
                                      "FROM file WHERE repo = ? ORDER BY kind DESC, path", (d["repo"],))]
        repos.append({"repo": d["repo"], "url": d["url"], "license": d["license"],
                      "commit": d["commit_id"], "files": files})
    return {"repositories": repos}


def file(con: sqlite3.Connection, repo: str, path: str) -> dict[str, Any] | None:
    f = con.execute("SELECT * FROM file WHERE repo = ? AND path = ?", (repo, path)).fetchone()
    d = con.execute("SELECT * FROM repository WHERE repo = ?", (repo,)).fetchone()
    if f is None or d is None:
        return None
    return {"path": f["path"], "language": f["language"], "lines": f["lines"], "text": f["text"],
            "note": f["note"], "truncated": f["truncated"], "source_url": file_url(d, f["path"])}


def handler(db_path: Path) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "oscr"

        def log_message(self, *args: Any) -> None:  # keeps the log clean
            return

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, data: Any, status: int = 200) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def do_GET(self) -> None:  # noqa: N802
            u = urlsplit(self.path)
            p = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path in ("/", "/index.html"):
                self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
                return
            if not db_path.exists():
                self._json({"error": "the database does not exist yet: run a first pass"}, 503)
                return
            try:
                con = _read_only(db_path)
            except sqlite3.Error as e:
                self._json({"error": str(e)}, 503)
                return
            try:
                if u.path == "/api/stats":
                    self._json(stats(con))
                elif u.path == "/api/enrichment":
                    from .enrich import coverage
                    self._json(coverage(con))
                elif u.path == "/api/articles":
                    n = max(1, min(MAX_PER_PAGE, int(p.get("n", "100") or 100)))
                    self._json(articles(con, p.get("q", "").strip(), p.get("all") == "1",
                                        max(0, int(p.get("offset", "0") or 0)), n))
                elif u.path == "/api/scripts":
                    self._json(scripts(con, p.get("article", "")))
                elif u.path == "/api/file":
                    f = file(con, p.get("repo", ""), p.get("path", ""))
                    self._json(f if f else {"error": "unknown file"}, 200 if f else 404)
                else:
                    self._json({"error": "not found"}, 404)
            except (sqlite3.Error, ValueError) as e:
                self._json({"error": str(e)}, 500)
            finally:
                con.close()

    return Handler


def serve(db_path: Path, port: int = 8790, host: str = "127.0.0.1") -> None:
    server = ThreadingHTTPServer((host, port), handler(db_path))
    print(f"Dashboard: http://{host}:{port}  (database: {db_path}), Ctrl+C to stop", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
