"""The dashboard reads the database live, read-only, on the machine alone."""
import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from oscr import contents, dashboard, db


@pytest.fixture
def server(tmp_path):
    path = tmp_path / "b.db"
    con = db.open_db(path)
    db.save_article(con, {"id": "doi:10.1/x", "doi": "10.1/x", "title": "Alpha waves",
                          "journal": "J Neuro", "published": "2026-09-01"})
    con.execute("UPDATE article SET scanned_at = 1, status = 'code_verified' WHERE id = 'doi:10.1/x'")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                "VALUES ('doi:10.1/x', 'github.com/lab/alpha', 'https://github.com/lab/alpha', "
                "'github.com', 'forge', 'code', 'high', 'text:availability')")
    con.execute("INSERT INTO repository (repo, url, host, kind, state, license, commit_id) VALUES "
                "('github.com/lab/alpha', 'https://github.com/lab/alpha', 'github.com', 'forge', "
                "'alive', '', 'abc123')")
    db.save_contents(con, "github.com/lab/alpha", "abc123", [contents.read("filter.py", b"import mne\n")])
    con.commit()
    con.close()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.handler(path))
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def get(url):
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read())


def test_the_table_shows_the_paper_its_repository_and_its_scripts(server):
    r = get(server + "/api/articles?n=10")
    assert r["total"] == 1
    a = r["rows"][0]
    assert a["doi"] == "10.1/x" and a["code"][0]["repo"] == "github.com/lab/alpha" and a["code"][0]["n"] == 1
    s = get(server + "/api/scripts?article=doi:10.1/x")
    f = s["repositories"][0]["files"][0]
    assert f["path"] == "filter.py" and f["readable"] is True
    assert f["source_url"] == "https://github.com/lab/alpha/blob/abc123/filter.py"
    t = get(server + "/api/file?repo=github.com/lab/alpha&path=filter.py")
    assert t["text"] == "import mne\n"


def test_search_filters_and_the_page_is_served(server):
    assert get(server + "/api/articles?q=nonexistent")["total"] == 0
    assert get(server + "/api/articles?q=alpha")["total"] == 1
    with urllib.request.urlopen(server + "/") as r:
        assert b"<title>OSCR dashboard</title>" in r.read()


def test_the_dashboard_never_writes(server, tmp_path):
    before = (tmp_path / "b.db").stat().st_mtime
    get(server + "/api/stats")
    get(server + "/api/articles")
    assert (tmp_path / "b.db").stat().st_mtime == before
