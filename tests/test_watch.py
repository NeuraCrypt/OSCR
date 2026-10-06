"""The Mac's continuous watch: it chains new papers, re-verification and the stock,
survives outages without concluding anything while they last, and shares the database
with the dashboard and the nightly publication."""
import io
import sqlite3
import zipfile

import httpx
import pytest

from oscr import catalog, contents, db, harvest, publish
from oscr.net import Client, Outage, Response, Unavailable
from oscr.sources import europepmc


class Recorder:
    """Replaces the watch's steps and records their order."""

    def __init__(self, monkeypatch, outages=0):
        self.calls, self.outages, self.naps = [], outages, []
        monkeypatch.setattr(harvest, "run_pass", self._run_pass)
        monkeypatch.setattr(harvest, "reverify", lambda *a, **k: self.calls.append("reverify") or 0)
        monkeypatch.setattr(harvest, "align_pending", lambda *a, **k: self.calls.append("align") or 0)
        monkeypatch.setattr(harvest, "backfill", lambda *a, **k: self.calls.append("stock") or harvest.Tally())
        monkeypatch.setattr(harvest.time, "sleep", self.naps.append)

    def _run_pass(self, *a, **k):
        if self.outages:
            self.outages -= 1
            raise Outage("network down")
        self.calls.append("news")
        return harvest.Tally()


def test_the_watch_chains_news_reverification_alignment_and_stock(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    r = Recorder(monkeypatch)
    harvest.watch(con, Client(offline=True), "neuro", harvest.Options(), iterations=2, report=lambda _: None)
    # News and re-verification (with the pending alignments) once, the stock at every round.
    assert r.calls == ["news", "reverify", "align", "stock", "stock"]


def test_once_the_stock_is_done_the_watch_sleeps(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    db.set_cursor(con, "backfill:neuro", "1999-12")
    assert harvest.backfill_done(con, "neuro", 2000)
    r = Recorder(monkeypatch)
    harvest.watch(con, Client(offline=True), "neuro", harvest.Options(), iterations=1, idle_s=900,
                  report=lambda _: None)
    assert "stock" not in r.calls and r.naps == [900]


def test_an_outage_makes_it_wait_then_resume(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    r = Recorder(monkeypatch, outages=2)
    messages = []
    harvest.watch(con, Client(offline=True), "neuro", harvest.Options(), iterations=3, report=messages.append)
    assert r.naps == [120, 240]            # 2 min, then 4 min
    assert r.calls[0] == "news"            # then the work resumes
    assert any("Outage" in m for m in messages)


def test_a_lasting_outage_stops_the_watch_so_that_launchd_restarts_it(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    Recorder(monkeypatch, outages=100)
    with pytest.raises(Outage):
        harvest.watch(con, Client(offline=True), "neuro", harvest.Options(), iterations=50, report=lambda _: None)


def test_the_watch_hands_back_control_after_its_duration(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    r = Recorder(monkeypatch)
    harvest.watch(con, Client(offline=True), "neuro", harvest.Options(), max_duration_s=0, report=lambda _: None)
    assert r.calls == []


def test_an_error_page_fits_on_one_line_in_the_log(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    Recorder(monkeypatch)
    monkeypatch.setattr(harvest, "run_pass", lambda *a, **k: (_ for _ in ()).throw(Outage(
        "Europe PMC /search: HTTP 503, <html>\n<head><title>503 Service Temporarily Unavailable"
        "</title></head>\n<body><hr><center>nginx</cente")))
    messages = []
    harvest.watch(con, Client(offline=True), "neuro", harvest.Options(), iterations=1, report=messages.append)
    assert len(messages) == 1 and "\n" not in messages[0]
    assert messages[0].endswith(" ! Outage: Europe PMC /search: HTTP 503, "
                                "503 Service Temporarily Unavailable nginx, resuming in 2 min")


class DownClient:
    def __init__(self, status):
        self.status = status

    def get(self, url, **kw):
        return Response(url, self.status, "network outage: ConnectError" if self.status == 0 else "")


def test_a_paper_read_during_an_outage_is_not_marked_without_full_text():
    with pytest.raises(Outage):
        europepmc.fulltext(DownClient(0), "PMC123")
    with pytest.raises(Outage):
        europepmc.fulltext(DownClient(503), "PMC123")
    # A 404, on the other hand, is an answer: the paper has no full text.
    assert europepmc.fulltext(DownClient(404), "PMC123") is None


def test_an_outage_stops_the_pass_without_marking_the_paper(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    art = europepmc.EpmcArticle(id="pmcid:PMC1", doi="10.1/x", pmcid="PMC1", source="PMC", fulltext_id="PMC1")
    monkeypatch.setattr(europepmc, "iterate", lambda *a, **k: iter([art]))
    monkeypatch.setattr(europepmc, "fulltext", lambda *a: (_ for _ in ()).throw(Outage("down")))
    with pytest.raises(Outage):
        harvest.scan_query(con, Client(offline=True), "q", harvest.Options(library=tmp_path), report=lambda _: None)
    row = con.execute("SELECT scanned_at FROM article WHERE id = 'pmcid:PMC1'").fetchone()
    assert row is None or row["scanned_at"] is None   # it will be read again


def test_reverification_only_takes_up_code_repositories_to_review(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "b.db")
    for art, repo, role, kind, state in [
        ("a1", "github.com/a/code", "code", "forge", "unreachable"),
        ("a2", "github.com/b/tool", "third_party_tool", "forge", "unreachable"),
        ("a3", "doi:10.1/data", "data", "data", "unverified"),
        ("a4", "github.com/d/fresh", "code", "forge", "alive"),
    ]:
        con.execute("INSERT INTO article (id, updated_at) VALUES (?, 0)", (art,))
        con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                    "VALUES (?,?,?,?,?,?,'high','text')", (art, repo, f"https://{repo}", "", kind, role))
        con.execute("INSERT INTO repository (repo, url, host, kind, state, verified_at) VALUES (?,?,?,?,?,?)",
                    (repo, f"https://{repo}", "", kind, state, harvest.time.time()))
    seen = []
    monkeypatch.setattr(harvest, "verify_article", lambda con, c, i, o: seen.append(i) or 0)
    monkeypatch.setattr(harvest, "conclude", lambda *a: "")
    assert harvest.reverify(con, Client(offline=True), harvest.Options(records=False)) == 1
    assert seen == ["a1"]


def test_the_working_database_is_wal_and_the_public_copy_a_single_file(tmp_path):
    con = db.open_db(tmp_path / "b.db")
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    # The dashboard reads while a write is in progress: nobody waits.
    con.execute("INSERT INTO article (id, title, updated_at) VALUES ('x', 'before', 0)")
    con.commit()
    con.execute("UPDATE article SET title = 'during' WHERE id = 'x'")
    reader = sqlite3.connect(f"file:{tmp_path / 'b.db'}?mode=ro", uri=True, timeout=0.1)
    assert reader.execute("SELECT title FROM article").fetchone()[0] == "before"
    con.commit()
    catalog.public_db(con, tmp_path / "pub.db")
    header = (tmp_path / "pub.db").read_bytes()[:20]
    assert (header[18], header[19]) == (1, 1)      # rollback-journal mode: a single file
    assert not (tmp_path / "pub.db-wal").exists()


def test_a_private_catalogue_never_leaves_for_hugging_face(tmp_path):
    con = db.open_db(tmp_path / "b.db")
    catalog.generate(con, tmp_path / "out", public=False)
    with pytest.raises(SystemExit, match="public mode"):
        publish.publish_hf(tmp_path / "out", "user/dataset", dry_run=True)
    catalog.generate(con, tmp_path / "out", public=True)
    assert "dry run" in publish.publish_hf(tmp_path / "out", "user/dataset", dry_run=True)


def _zip(noise_bytes: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as z:
        z.writestr("repo-v1/analysis.py", "print('ok')\n")
        z.writestr("repo-v1/noise.bin", b"\0" * noise_bytes)
    return buffer.getvalue()


def test_an_archive_goes_through_the_disk_and_is_read(tmp_path):
    body = _zip(3_000_000)
    client = Client()
    client._http = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, content=body)))
    client._wait = lambda *a: None
    with client.download_archive("https://zenodo.org/f.zip", 10_000_000) as f:
        assert f._rolled                        # beyond 1 MB: on disk
        files = contents.from_zip(f)
    assert [x["path"] for x in files] == ["analysis.py"]
    # Too big: abandoned on the way, nothing is returned.
    assert client.download_archive("https://zenodo.org/f.zip", 1_000_000) is None


def test_the_mac_settings_are_read_without_a_shell(tmp_path):
    from oscr import cli
    f = tmp_path / "settings"
    f.write_text("# comment\nOSCR_DOMAIN=electrophysiology\n# (unused) OSCR_OLD=6\nOSCR_HF_DATASET=\"user/dataset\"\n")
    assert cli.settings(f) == {"OSCR_DOMAIN": "electrophysiology", "OSCR_HF_DATASET": "user/dataset"}
    assert cli.settings(tmp_path / "missing") == {}


class OneBrokenDocument:
    """Europe PMC answers, except for one full text."""

    def get(self, url, **kw):
        if url.endswith("/PMC9/fullTextXML"):
            return Response(url, 500, "")
        return Response(url, 200, "{}" if "/search" in url else "<article/>")


def test_one_broken_document_is_not_an_outage(tmp_path):
    with pytest.raises(Unavailable):
        europepmc.fulltext(OneBrokenDocument(), "PMC9")
    con = db.open_db(tmp_path / "b.db")
    art = europepmc.EpmcArticle(id="pmcid:PMC9", doi="10.1/y", pmcid="PMC9", source="PMC", fulltext_id="PMC9")
    status = harvest.scan_article(con, OneBrokenDocument(), art,
                                  harvest.Options(library=tmp_path, verify=False, metadata=False, records=False))
    assert status == "no_fulltext"
    assert con.execute("SELECT COUNT(*) FROM log WHERE event = 'fulltext_unavailable'").fetchone()[0] == 1
