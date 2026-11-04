"""The partners' files (oscr/outreach.py): the code link alone (never its sentence), the open licences
only, what a removal request withheld left out, and Software Heritage asked unless turned off, a few
at a time, stopping at the first refusal."""
from __future__ import annotations

import gzip
import io
import json
import urllib.error

import pytest

from oscr import db, outreach


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "mac.db")
    yield c
    c.close()


def paper(con, n: int, *, licence: str = "cc by", pmcid: str = "", journal: str = "eLife") -> str:
    aid = f"doi:10.5555/test.{n}"
    db.save_article(con, {"id": aid, "doi": f"10.5555/test.{n}", "title": f"Paper {n}", "journal": journal,
                          "published": "2026-09-01", "license": licence, "authors": ["A"]})
    db.mark_scanned(con, aid, has_fulltext=True, has_statement=True, code_on_request=False, data_on_request=False,
                    families=[], methods=[])
    con.execute("UPDATE article SET status = 'code_verified', on_topic = 'yes', pmcid = ? WHERE id = ?", (pmcid, aid))
    return aid


def code(con, aid: str, repo: str, url: str, excerpt: str, *, archived: int | None = None) -> None:
    con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind, state, swh_archived) VALUES (?, ?, 'github.com', 'forge', 'alive', ?)",
                (repo, url, archived))
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by, section, excerpt) "
                "VALUES (?, ?, ?, 'github.com', 'forge', 'code', 'high', 'text', 'Code availability', ?)", (aid, repo, url, excerpt))


CFG = {"OSCR_SITE_URL": "https://openscicode.org/", "OSCR_PLATFORM_NAME": "OSCR"}
SENTENCE = "The private sentence: our analysis code is at github.com/Lab/Tool and we thank the reviewers."


def test_the_annotations_carry_the_code_link_only_and_only_under_an_open_licence(con, tmp_path):
    a1 = paper(con, 1, pmcid="PMC1")
    code(con, a1, "github.com/lab/tool", "https://github.com/Lab/Tool", SENTENCE)
    a2 = paper(con, 2, pmcid="PMC2", licence="cc by-nc-nd")
    code(con, a2, "github.com/lab/other", "https://github.com/Lab/Other", "code at https://github.com/Lab/Other")
    said = outreach.write(con, tmp_path, CFG)
    assert said.startswith("Europe PMC annotations: 1 papers, 1 code links")
    lines = gzip.decompress((tmp_path / "scilite-annotations.jsonl.gz").read_bytes()).decode().splitlines()
    one = json.loads(lines[0])
    assert (one["src"], one["id"], one["provider"]) == ("PMC", "PMC1", "OSCR")
    assert one["anns"][0]["exact"] == "github.com/Lab/Tool"
    assert one["anns"][0]["tags"][0]["uri"] == "https://openscicode.org/paper/doi_10.5555_test.1/"
    everything = "\n".join(lines) + (tmp_path / "mixnmatch.tsv").read_text()
    assert "private sentence" not in everything and "reviewers" not in everything


def test_scholix_mixnmatch_and_the_journals(con, tmp_path):
    a1 = paper(con, 1, journal="eLife")
    code(con, a1, "github.com/lab/tool", "https://github.com/Lab/Tool", SENTENCE)
    paper(con, 3, journal="Frontiers in Neuroscience")
    outreach.write(con, tmp_path, CFG)
    links = json.loads(gzip.decompress((tmp_path / "scholix.json.gz").read_bytes()))
    assert links[0]["Source"]["Identifier"][0]["ID"] == "10.5555/test.1"
    assert links[0]["RelationshipType"]["Name"] == "IsSupplementedBy"
    assert links[0]["Target"]["Identifier"][0]["ID"] == "https://github.com/Lab/Tool"
    assert (tmp_path / "mixnmatch.tsv").read_text().splitlines()[0] == "id\tname\tdesc"
    assert (tmp_path / "journals" / "elife.csv").read_text().splitlines()[1] == \
        "10.5555/test.1,https://openscicode.org/paper/doi_10.5555_test.1/"
    assert (tmp_path / "journals" / "frontiers.csv").read_text().splitlines() == ["doi,page"]   # no code


def test_a_withheld_repository_leaves_every_file(con, tmp_path):
    a1 = paper(con, 1, pmcid="PMC1")
    code(con, a1, "github.com/lab/tool", "https://github.com/Lab/Tool", SENTENCE)
    con.execute("INSERT INTO withheld (scope, article_id, repo, path, created_at) VALUES ('repository', ?, 'github.com/lab/tool', '', 0)", (a1,))
    said = outreach.write(con, tmp_path, CFG)
    assert "Europe PMC annotations: 0 papers" in said and "Scholix: 0 links" in said
    assert outreach.swh_candidates(con, {}, 0) == []


class _Res:
    def __init__(self, remaining: str):
        self.headers = {"X-RateLimit-Remaining": remaining}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_software_heritage_on_by_default_off_with_0_a_few_and_never_twice(con, tmp_path):
    for n in range(4):
        a = paper(con, n)
        code(con, a, f"github.com/lab/t{n}", f"https://github.com/lab/t{n}", "x", archived=1 if n == 3 else None)
    calls = []

    def opener(req):
        calls.append(req.full_url)
        return _Res("50")

    assert "off" in outreach.swh_save(con, tmp_path, {"OSCR_SWH": "0"}, opener=opener)
    assert calls == []
    said = outreach.swh_save(con, tmp_path, {"OSCR_SWH": "1", "OSCR_SWH_PER_NIGHT": "2"}, opener=opener, now=1_000_000)
    assert said == "Software Heritage: 2 save requests"
    assert calls == ["https://archive.softwareheritage.org/api/1/origin/save/git/url/https://github.com/lab/t0/",
                     "https://archive.softwareheritage.org/api/1/origin/save/git/url/https://github.com/lab/t1/"]
    outreach.swh_save(con, tmp_path, {"OSCR_SWH": "1"}, opener=opener, now=1_000_100)
    assert calls[2:] == ["https://archive.softwareheritage.org/api/1/origin/save/git/url/https://github.com/lab/t2/"]


def test_software_heritage_stops_at_the_first_refusal(con, tmp_path):
    for n in range(3):
        code(con, paper(con, n), f"github.com/lab/t{n}", f"https://github.com/lab/t{n}", "x")

    def opener(req):
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, io.BytesIO(b""))

    assert outreach.swh_save(con, tmp_path, {"OSCR_SWH": "1"}, opener=opener) == "Software Heritage: 0 save requests (stopped: HTTP 429)"
