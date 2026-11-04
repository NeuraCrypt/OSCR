"""The reader-side links (oscr/linkfeeds.py): one link per paper with a page, to Europe PMC and
PubMed, in their own formats, and nothing sent until the owner has set the accounts up."""
from __future__ import annotations

import gzip
import re
import xml.etree.ElementTree as ET

import pytest

from oscr import db, linkfeeds


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "mac.db")
    yield c
    c.close()


def paper(con, n: int, status: str = "code_verified", *, pmid: str = "", pmcid: str = "", on_topic: str = "yes",
          title: str = "") -> str:
    aid = f"doi:10.5555/test.{n}"
    db.save_article(con, {"id": aid, "doi": f"10.5555/test.{n}", "title": title or f"Paper {n} on EEG",
                          "journal": "J", "published": "2026-09-01", "license": "cc by", "authors": ["A"]})
    db.mark_scanned(con, aid, has_fulltext=True, has_statement=True, code_on_request=False, data_on_request=False,
                    families=[], methods=[])
    con.execute("UPDATE article SET status = ?, on_topic = ?, pmid = ?, pmcid = ? WHERE id = ?",
                (status, on_topic, pmid, pmcid, aid))
    return aid


CFG = {"OSCR_SITE_URL": "https://openscicode.org/", "OSCR_PLATFORM_NAME": "OSCR",
       "OSCR_LABSLINK_PROVIDER": "1234", "OSCR_LINKOUT_PROVIDER": "5678", "OSCR_LABSLINK_EMAIL": "x@example.org"}


def test_only_the_papers_with_a_page_and_the_best_identifier(con, tmp_path):
    paper(con, 1, pmid="111", pmcid="PMC9")
    paper(con, 2, pmcid="pmc22")
    paper(con, 3)
    paper(con, 4, status="no_code", pmid="444")          # no page
    paper(con, 5, on_topic="no", pmid="555")              # off-topic: no page (D7)
    paper(con, 6, status="on_request", pmid="666", title="A <b>&\x07 title")
    said = linkfeeds.write(con, tmp_path, CFG)
    assert "Europe PMC: 4 papers (2 by PMID, 1 by PMCID, 1 by DOI)" in said
    assert "PubMed LinkOut: 2 papers with a PMID" in said

    files = sorted((tmp_path / "labslink").glob("links-*.xml.gz"))
    assert [f.name for f in files] == ["links-001.xml.gz"]
    root = ET.fromstring(gzip.decompress(files[0].read_bytes()))
    links = root.findall("link")
    assert {link.get("providerId") for link in links} == {"1234"}
    by_url = {link.find("resource/url").text: link for link in links}
    assert set(by_url) == {f"https://openscicode.org/paper/doi_10.5555_test.{n}/" for n in (1, 2, 3, 6)}
    one = by_url["https://openscicode.org/paper/doi_10.5555_test.1/"]
    assert (one.find("record/source").text, one.find("record/id").text) == ("MED", "111")
    two = by_url["https://openscicode.org/paper/doi_10.5555_test.2/"]
    assert (two.find("record/source").text, two.find("record/id").text) == ("PMC", "PMC22")
    three = by_url["https://openscicode.org/paper/doi_10.5555_test.3/"]
    assert three.find("doi").text == "10.5555/test.3" and three.find("record") is None

    profile = ET.fromstring((tmp_path / "labslink" / "profile.xml").read_text())
    assert profile.find("provider/id").text == "1234"
    assert profile.find("provider/resourceName").text == "OSCR"

    text = (tmp_path / "linkout" / "resources_001.xml").read_text()
    assert text.startswith('<?xml version="1.0"?>\n') and text.isascii()       # LinkOut reads no UTF-8
    lo = ET.fromstring(text.split("\n", 2)[2])
    ids = [(link.find("ObjectSelector/ObjectList/ObjId").text, link.find("ObjectUrl/Base").text)
           for link in lo.findall("Link")]
    assert ids == [("111", "https://openscicode.org/paper/doi_10.5555_test.1/"),
                   ("666", "https://openscicode.org/paper/doi_10.5555_test.6/")]
    assert {link.find("ProviderId").text for link in lo.findall("Link")} == {"5678"}


def test_linkout_s_identity_file_names_and_size(con, tmp_path):
    paper(con, 1, pmid="111", title="Caf\u00e9 \u2192 code")
    linkfeeds.write(con, tmp_path, {**CFG, "OSCR_PLATFORM_FULL_NAME": "Open Scientific Code Registry"})
    names = sorted(p.name for p in (tmp_path / "linkout").iterdir())
    assert names == ["providerinfo.xml", "resources_001.xml"]
    assert all(re.fullmatch(r"[A-Za-z0-9_]+\.xml", n) for n in names)
    info = (tmp_path / "linkout" / "providerinfo.xml").read_text()
    assert info.isascii() and '<!DOCTYPE Provider PUBLIC "-//NLM//DTD LinkOut 1.0//EN"' in info
    p = ET.fromstring(info.split("\n", 2)[2])
    assert (p.find("ProviderId").text, p.find("Name").text, p.find("NameAbbr").text) == ("5678", "Open Scientific Code Registry", "OSCR")
    # A full file stays far under LinkOut's 20 MB.
    many = [linkfeeds.Paper(f"doi:10.5555/x.{n}", f"doi_10.5555_x.{n}" + "_" * 60, "", str(10_000_000 + n), "", "t")
            for n in range(linkfeeds.LINKOUT_PER_FILE)]
    assert len(linkfeeds.linkout_resources(5678, "https://openscicode.org/", many).encode()) < linkfeeds.LINKOUT_MAX_BYTES / 2


def test_identifiers_are_cleaned_and_a_rerun_replaces_the_files(con, tmp_path):
    assert linkfeeds.clean_ids("https://doi.org/10.1234/abc", "12a", "PMC 3") == ("10.1234/abc", "", "")
    assert linkfeeds.clean_ids("10.1/abc", "", "")[0] == ""
    assert linkfeeds.clean_ids("doi:10.1234/x", " 42 ", "77") == ("10.1234/x", "42", "PMC77")
    (tmp_path / "labslink").mkdir()
    (tmp_path / "labslink" / "links-009.xml.gz").write_bytes(b"old")
    paper(con, 1, pmid="1")
    said = linkfeeds.write(con, tmp_path, {})
    assert not (tmp_path / "labslink" / "links-009.xml.gz").exists()
    assert "provider id 0 until Europe PMC gives one" in said


def test_nothing_is_sent_until_the_accounts_are_set(tmp_path):
    (tmp_path / "labslink").mkdir()
    (tmp_path / "linkout").mkdir()

    def refuse(*a, **k):
        raise AssertionError("no connection without the settings")

    said = linkfeeds.upload(tmp_path, {}, connect=refuse)
    assert "labslink: not sent" in said and "linkout: not sent" in said


def test_the_files_go_to_the_ftp_folder(tmp_path, monkeypatch):
    (tmp_path / "labslink").mkdir()
    (tmp_path / "labslink" / "profile.xml").write_text("<providers/>")
    (tmp_path / "labslink" / "links-001.xml.gz").write_bytes(b"x")
    (tmp_path / "linkout").mkdir()
    sent = []

    class Fake:
        def __init__(self, host, timeout):
            sent.append(("host", host))

        def login(self, user, password):
            sent.append(("login", user, password))

        def cwd(self, folder):
            sent.append(("cwd", folder))

        def storbinary(self, command, f):
            sent.append(("stor", command))

        def quit(self):
            pass

    monkeypatch.setattr(linkfeeds, "_password", lambda service: "secret" if service == "org.oscr.labslink" else "")
    said = linkfeeds.upload(tmp_path, {**CFG, "OSCR_LABSLINK_FTP": "ftp.example.org/in", "OSCR_LABSLINK_FTP_USER": "u",
                                       "OSCR_LINKOUT_FTP": "ftp.example.org", "OSCR_LINKOUT_FTP_USER": "v"}, connect=Fake)
    assert sent == [("host", "ftp.example.org"), ("login", "u", "secret"), ("cwd", "in"),
                    ("stor", "STOR links-001.xml.gz"), ("stor", "STOR profile.xml")]
    assert "labslink: 2 files sent" in said and "linkout: not sent (no password" in said


def test_linkout_goes_to_holdings_and_its_obsolete_files_leave(tmp_path, monkeypatch):
    (tmp_path / "labslink").mkdir()
    (tmp_path / "linkout").mkdir()
    (tmp_path / "linkout" / "providerinfo.xml").write_text("<Provider/>")
    (tmp_path / "linkout" / "resources_001.xml").write_text("<LinkSet/>")
    did = []

    class Fake:
        def __init__(self, host, timeout):
            did.append(("host", host))

        def login(self, user, password):
            pass

        def cwd(self, folder):
            did.append(("cwd", folder))

        def storbinary(self, command, f):
            did.append(("stor", command))

        def nlst(self):
            return ["providerinfo.xml", "resources_001.xml", "resources_002.xml"]

        def delete(self, name):
            did.append(("delete", name))

        def quit(self):
            pass

    monkeypatch.setattr(linkfeeds, "_password", lambda service: "secret")
    said = linkfeeds.upload(tmp_path, {**CFG, "OSCR_LINKOUT_FTP_USER": "v"}, connect=Fake)
    assert did == [("host", "FTP-private.ncbi.nlm.nih.gov"), ("cwd", "holdings"), ("stor", "STOR providerinfo.xml"),
                   ("stor", "STOR resources_001.xml"), ("delete", "resources_002.xml")]
    assert "linkout: 2 files sent" in said
