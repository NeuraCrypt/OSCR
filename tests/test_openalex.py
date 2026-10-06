"""OpenAlex (oscr/sources/openalex.py): parsing, what it may add to a record, the key, the budget.

The two works in tests/fixtures/openalex/ are real OpenAlex answers (2026-09-28, `select` as
the harvester asks, lists trimmed): a Genome Research paper with a bioRxiv preprint, funders and
awards, and a Frontiers editorial whose authors belong to institutions of three countries. The
JATS and Europe PMC records below are invented around their authors' names.
"""
import copy
import json
import sqlite3
from pathlib import Path

import httpx
import pytest

from oscr import biblio, catalog, db, enrich, entities, harvest, net, paperpage
from oscr.sources import openalex

FIXTURES = Path(__file__).parent / "fixtures" / "openalex"
GENOME = json.loads((FIXTURES / "W_genome_research.json").read_text())
EDITORIAL = json.loads((FIXTURES / "W_frontiers_editorial.json").read_text())
#: The editorial as if its publisher had deposited the ORCID iDs of its first and last authors
#: (it deposited none: OpenAlex's iDs there come from its author profiles).
DEPOSITED = copy.deepcopy(EDITORIAL)
for _n in (0, 2):
    DEPOSITED["authorships"][_n]["raw_orcid"] = DEPOSITED["authorships"][_n]["author"]["orcid"]
#: A key no test may leak: into a URL, the cache, the log, an error message.
KEY = "oa-test-key-6f3c9a"
DAY = 86_400.0
T0 = 1_790_337_600.0      # 2026-09-25 12:00 UTC


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "oa.db")
    yield c
    c.close()


def paper(con, doi: str, *, status: str = "code_verified", on_topic: str = "yes", pmid: str = "") -> str:
    aid = f"doi:{doi}" if doi else f"pmid:{pmid}"
    db.save_article(con, {"id": aid, "doi": doi, "pmid": pmid, "title": "T", "published": "2026-09-01"})
    db.mark_scanned(con, aid, has_fulltext=True, has_statement=True, code_on_request=False, data_on_request=False,
                    families=[], methods=[])
    con.execute("UPDATE article SET status = ?, on_topic = ? WHERE id = ?", (status, on_topic, aid))
    return aid


class Fake:
    """OpenAlex behind a MockTransport: answers from `works` by DOI, or a scripted status."""

    def __init__(self, works=None, statuses=(), headers=None):
        self.works = works or {}
        self.statuses = list(statuses)
        self.headers = headers or {"x-ratelimit-cost-usd": "0", "x-ratelimit-remaining-usd": "1",
                                   "x-ratelimit-reset": "3600"}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.statuses:
            status = self.statuses.pop(0)
            if status != 200:
                return httpx.Response(status, headers=self.headers, json={"error": "scripted"})
        doi = request.url.path.split("/works/doi:", 1)[-1].lower()
        w = self.works.get(doi)
        if w is None:
            return httpx.Response(404, headers=self.headers, json={"error": "not found"})
        return httpx.Response(200, headers=self.headers, json=w)


def client_for(fake: Fake, cache: net.Cache | None = None) -> net.Client:
    c = net.Client(cache)
    c._http = httpx.Client(transport=httpx.MockTransport(fake))
    return c


@pytest.fixture
def no_wait(monkeypatch):
    monkeypatch.setitem(net.INTERVALS, net.OPENALEX_HOST, 0.0)
    monkeypatch.setattr(openalex.time, "sleep", lambda s: None)
    monkeypatch.setattr(net.time, "sleep", lambda s: None)


# ---------------------------------------------------------------------------------------
# Parsing.

def test_a_work_is_parsed_into_oscr_shapes():
    oa = openalex.parse(GENOME)
    assert oa["openalex_id"] == "W4404144294" and oa["doi"] == "10.1101/gr.280394.124"
    assert (oa["volume"], oa["issue"], oa["pages"], oa["language"]) == ("36", "9", "1825-1835", "en")
    assert oa["publisher"] == "Cold Spring Harbor Laboratory Press"
    assert (oa["cited_by_count"], oa["references_count"], oa["is_oa"]) == (7, 50, True)
    assert oa["oa_status"] == "green" and oa["oa_url"].startswith("https://doi.org/10.1101/2024.11.06")
    # The bioRxiv version is a preprint; PubMed and PubMed Central are not.
    assert oa["preprint"] == {"id": "doi:10.1101/2024.11.06.621353", "url": "https://doi.org/10.1101/2024.11.06.621353",
                              "server": "bioRxiv"}
    assert oa["referenced_works"] == ["W15569989", "W2008627757", "W2010921681"]
    assert oa["related_works"] == ["W3145419749", "W3038565614"]
    primary = oa["topics"][0]
    assert primary["primary"] and primary["id"] == "T10222" and primary["field"] == "Biochemistry, Genetics and Molecular Biology"
    assert (primary["subfield"], primary["domain"]) == ("Molecular Biology", "Life Sciences")
    # Awards go to their funder; a funder is named by its ROR id.
    nih = next(f for f in oa["funding"] if f["funder"] == "National Institutes of Health")
    assert nih == {"funder": "National Institutes of Health", "funder_id": "01cwqze88", "awards": ["1r03od034499-01"]}
    last = oa["authors"][-1]
    assert (last["name"], last["orcid"], last["openalex_id"], last["corresponding"]) == \
        ("Katherine S. Pollard", "0000-0002-9870-6196", "A5005062415", True)
    assert last["institutions"] == ["038321296", "043mz5j54", "02qenvm24"]
    ucsf = next(i for i in oa["institutions"] if i["id"] == "043mz5j54")
    assert ucsf == {"id": "043mz5j54", "name": "University of California, San Francisco", "country": "US",
                    "type": "education", "openalex_id": "I180670191"}


def test_an_affiliation_is_paired_with_its_own_institution():
    oa = openalex.parse(EDITORIAL)
    hamburg = oa["authors"][1]
    # One affiliation, two institutions (the medical center and its university, OpenAlex's lineage).
    assert hamburg["affiliations"] == [{"text": "Institute of Computational Neuroscience, University Medical Center "
                                                "Hamburg-Eppendorf, Hamburg, Germany", "ror": ["00g30e956", "01zgy1s35"]}]
    names = {i["id"]: i["name"] for i in oa["institutions"]}
    placed = openalex.place([hamburg["affiliations"][0]["text"]], hamburg, names)
    assert placed == [{"id": "00g30e956", "aff": None}, {"id": "01zgy1s35", "aff": 0}]
    assert {i["country"] for i in oa["institutions"]} == {"US", "DE", "IR"}
    assert oa["preprint"] is None and oa["funding"] == [] and oa["oa_status"] == "gold"


def test_no_email_address_survives_parsing():
    w = copy.deepcopy(EDITORIAL)
    aff = w["authorships"][0]["affiliations"][0]
    aff["raw_affiliation_string"] += ". Electronic address: someone@example.org"
    w["authorships"][0]["raw_affiliation_strings"] = [aff["raw_affiliation_string"]]
    text = json.dumps(openalex.parse(w))
    assert "@" not in text and "someone" not in text
    assert "Amirkabir University of Technology" in text


def test_preprints_on_arxiv_and_the_paper_itself():
    w = copy.deepcopy(EDITORIAL)
    w["locations"].append({"id": "doi:10.48550/arxiv.2501.01234", "landing_page_url": "https://arxiv.org/abs/2501.01234v2",
                           "raw_type": "posted-content", "source": {"display_name": "arXiv (Cornell University)",
                                                                     "type": "repository"}})
    assert openalex.parse(w)["preprint"] == {"id": "arxiv:2501.01234", "url": "https://arxiv.org/abs/2501.01234",
                                             "server": "arXiv"}
    own = copy.deepcopy(EDITORIAL)
    own["locations"][0]["raw_type"] = "posted-content"          # the paper's own DOI is not its preprint
    assert openalex.parse(own)["preprint"] is None


def test_ids_are_short():
    assert openalex.short_id("https://openalex.org/W4412991288") == "W4412991288"
    assert openalex.short_id("https://openalex.org/subfields/2805") == "2805"
    assert openalex.short_id("https://openalex.org/F4320306164") == "F4320306164"
    assert openalex.short_id(None) == ""


# ---------------------------------------------------------------------------------------
# What OpenAlex may add to a record.

def jats_authors(corresponding: int | None = None) -> list[dict]:
    names = [("Golnaz", "Baghdadi", "Biomedical Engineering Department, Amirkabir University of Technology "
                                    "(Tehran Polytechnic), Tehran, Iran"),
             ("Fatemeh", "Hadaeghi", "Institute of Computational Neuroscience, University Medical Center "
                                     "Hamburg-Eppendorf, Hamburg, Germany"),
             ("Chella", "Kamarajan", "Department of Psychiatry and Behavioral Sciences, SUNY Downstate Health "
                                     "Sciences University, Brooklyn, NY, United States")]
    return [{"position": n, "name": f"{g} {f}", "given": g, "family": f, "orcid": "",
             "corresponding": n == corresponding, "affiliations": [aff], "ror": []}
            for n, (g, f, aff) in enumerate(names, 1)]


def test_openalex_fills_what_the_paper_left_empty_and_nothing_else():
    rec = biblio.empty()
    rec["authors"] = jats_authors(corresponding=3)
    rec["provenance"] = {"authors": "jats"}
    openalex.complete_authors(rec, openalex.parse(DEPOSITED))
    a1, a2, a3 = rec["authors"]
    assert (a1["orcid"], a1["openalex_id"]) == ("0000-0002-6977-5029", "A5032305636")
    # An ORCID iD of OpenAlex's author profile only, not deposited with the paper: not given.
    assert (a2["orcid"], a2["openalex_id"], a3["orcid"]) == ("", "A5001991567", "0000-0003-2291-6880")
    assert a1["ror"] == [{"id": "04gzbav43", "aff": 0}]
    assert a2["ror"] == [{"id": "00g30e956", "aff": None}, {"id": "01zgy1s35", "aff": 0}]
    # The paper names its corresponding author: OpenAlex's is not added.
    assert [a["corresponding"] for a in rec["authors"]] == [False, False, True]
    assert rec["provenance"] == {"authors": "jats", "authors.openalex_id": "openalex", "authors.orcid": "openalex",
                                 "authors.ror": "openalex"}
    # Without a corresponding author in the paper, OpenAlex's is taken.
    rec = biblio.empty()
    rec["authors"] = jats_authors()
    openalex.complete_authors(rec, openalex.parse(EDITORIAL))
    assert [a["corresponding"] for a in rec["authors"]] == [True, False, False]
    assert rec["provenance"]["authors.corresponding"] == "openalex"


def test_an_orcid_the_paper_gives_is_kept_and_a_different_person_is_not_merged():
    rec = biblio.empty()
    rec["authors"] = jats_authors()
    rec["authors"][0]["orcid"] = "0000-0002-1825-0097"      # the paper's own, not OpenAlex's
    rec["authors"][2]["family"] = "Someone Else"
    rec["provenance"] = {"authors": "jats", "authors.orcid": "epmc"}
    w = copy.deepcopy(DEPOSITED)
    w["authorships"][1]["raw_orcid"] = w["authorships"][1]["author"]["orcid"]
    openalex.complete_authors(rec, openalex.parse(w))
    assert rec["authors"][0]["orcid"] == "0000-0002-1825-0097" and rec["authors"][0].get("openalex_id") is None
    assert rec["authors"][1]["orcid"] == "0000-0002-3870-798X"
    assert rec["authors"][2]["orcid"] == "" and not rec["authors"][2]["ror"]
    assert rec["provenance"]["authors.orcid"] == "epmc+openalex"


def test_the_merge_keeps_europe_pmc_and_the_jats_above_openalex():
    epmc = biblio.empty()
    epmc["cited_by_count"] = 3
    epmc["is_open_access"] = True
    epmc["funding"] = [{"funder": "Invented Council", "funder_id": "", "awards": ["IC-1"]}]
    epmc = biblio._finish(epmc, "epmc")
    rec = biblio.merge(epmc, openalex.record(openalex.parse(GENOME)))
    assert rec["cited_by_count"] == 3 and rec["provenance"]["cited_by_count"] == "epmc"
    assert rec["funding"] == [{"funder": "Invented Council", "funder_id": "", "awards": ["IC-1"]}]
    assert (rec["volume"], rec["pages"], rec["provenance"]["volume"]) == ("36", "1825-1835", "openalex")
    assert rec["journal"]["publisher"] == "Cold Spring Harbor Laboratory Press"
    assert rec["provenance"]["journal.publisher"] == "openalex"
    # Europe PMC without a count: OpenAlex's.
    rec = biblio.merge(biblio._finish(biblio.empty(), "epmc"), openalex.record(openalex.parse(GENOME)))
    assert rec["cited_by_count"] == 7 and rec["provenance"]["cited_by_count"] == "openalex"
    assert rec["references_count"] == 50 and len(rec["funding"]) == 7


JATS = """<article xmlns:xlink="http://www.w3.org/1999/xlink" article-type="editorial" xml:lang="en"><front>
<journal-meta><journal-title-group><journal-title>Frontiers in Systems Neuroscience</journal-title></journal-title-group>
</journal-meta><article-meta><title-group><article-title>An invented editorial</article-title></title-group>
<contrib-group>
<contrib contrib-type="author"><name><surname>Baghdadi</surname><given-names>Golnaz</given-names></name><xref ref-type="aff" rid="a1"/></contrib>
<contrib contrib-type="author"><name><surname>Hadaeghi</surname><given-names>Fatemeh</given-names></name><xref ref-type="aff" rid="a2"/></contrib>
<contrib contrib-type="author"><name><surname>Kamarajan</surname><given-names>Chella</given-names></name><xref ref-type="aff" rid="a3"/></contrib>
<aff id="a1">Biomedical Engineering Department, Amirkabir University of Technology (Tehran Polytechnic), Tehran, Iran</aff>
<aff id="a2">Institute of Computational Neuroscience, University Medical Center Hamburg-Eppendorf, Hamburg, Germany</aff>
<aff id="a3">Department of Psychiatry and Behavioral Sciences, SUNY Downstate Health Sciences University, Brooklyn, NY, United States</aff>
</contrib-group><volume>19</volume></article-meta></front><body><p>Invented.</p></body></article>"""


def test_the_enrichment_merges_a_kept_record_with_its_provenance(con):
    aid = paper(con, "10.3389/fnsys.2025.1495018")
    openalex.store(con, aid, openalex.parse(DEPOSITED), now=T0)
    enrich.enrich_article(con, aid, xml=JATS, core={"citedByCount": "", "isOpenAccess": "Y"}, now=T0 + 1)
    a = con.execute("SELECT * FROM article WHERE id = ?", (aid,)).fetchone()
    assert (a["openalex_id"], a["oa_status"], a["cited_by_count"], a["references_count"]) == ("W4407382357", "gold", 15, 28)
    prov = {r["field"]: (r["source"], r["source_ref"]) for r in con.execute(
        "SELECT field, source, source_ref FROM field_provenance WHERE entity_id = ?", (aid,))}
    assert prov["cited_by_count"] == ("openalex", "W4407382357")
    assert prov["is_open_access"][0] == "epmc" and prov["volume"][0] == "jats"
    assert prov["authors.ror"] == ("openalex", "W4407382357") and prov["topics"] == ("openalex", "W4407382357")
    authors = con.execute("SELECT * FROM paper_author WHERE article_id = ? ORDER BY position", (aid,)).fetchall()
    assert [r["openalex_id"] for r in authors] == ["A5032305636", "A5001991567", "A5077384411"]
    assert json.loads(authors[2]["ror"]) == [{"id": "0041qmd21", "aff": 0}]
    assert con.execute("SELECT name, country, type FROM institution WHERE id = '01zgy1s35'").fetchone()[:] == \
        ("University Medical Center Hamburg-Eppendorf", "DE", "healthcare")
    assert con.execute("SELECT openalex_id FROM author WHERE orcid = '0000-0003-2291-6880'").fetchone()[0] == "A5077384411"
    assert con.execute("SELECT topic_id FROM paper_topic WHERE article_id = ? AND is_primary = 1", (aid,)).fetchone()[0] \
        == "T10429"
    assert con.execute("SELECT COUNT(*) FROM paper_work WHERE article_id = ? AND relation = 'referenced'",
                       (aid,)).fetchone()[0] == 3
    # Enriched again (a rescan): the same record, nothing lost, no new version.
    versions = con.execute("SELECT COUNT(*) FROM version").fetchone()[0]
    enrich.enrich_article(con, aid, xml=JATS, core={"citedByCount": "", "isOpenAccess": "Y"}, now=T0 + 2)
    assert json.loads(con.execute("SELECT ror FROM paper_author WHERE article_id = ? AND position = 3",
                                  (aid,)).fetchone()[0]) == [{"id": "0041qmd21", "aff": 0}]
    assert con.execute("SELECT COUNT(*) FROM version").fetchone()[0] == versions


def test_openalex_never_replaces_a_value_a_higher_source_gave(con):
    aid = paper(con, "10.3389/fnsys.2025.1495018")
    con.execute("UPDATE article SET preprint_id = 'doi:10.1101/by.europe.pmc', preprint_url = 'https://doi.org/x' "
                "WHERE id = ?", (aid,))
    db.record_provenance(con, "article", aid, {"preprint": "epmc"}, at=T0)
    w = copy.deepcopy(GENOME)
    w["doi"] = "https://doi.org/10.3389/fnsys.2025.1495018"
    openalex.store(con, aid, openalex.parse(w), now=T0)
    assert con.execute("SELECT preprint_id FROM article WHERE id = ?", (aid,)).fetchone()[0] == "doi:10.1101/by.europe.pmc"
    assert con.execute("SELECT source FROM field_provenance WHERE entity_id = ? AND field = 'preprint'",
                       (aid,)).fetchone()[0] == "epmc"
    assert con.execute("SELECT oa_status FROM article WHERE id = ?", (aid,)).fetchone()[0] == "green"
    # The owner's label stays above the enrichment, OpenAlex's included (D6).
    con.execute("INSERT INTO paper_category (article_id, facet, value, confidence, method) "
                "VALUES (?, 'on_topic', 'no', 1, 'owner')", (aid,))
    enrich.enrich_article(con, aid, xml=JATS, now=T0 + 1)
    assert con.execute("SELECT on_topic FROM article WHERE id = ?", (aid,)).fetchone()[0] == "no"


# ---------------------------------------------------------------------------------------
# The key, the budget, a 429.

def test_the_key_goes_in_a_header_to_openalex_only_and_nowhere_else(con, tmp_path, monkeypatch, no_wait):
    monkeypatch.setenv("OPENALEX_API_KEY", KEY)
    fake = Fake({"10.3389/fnsys.2025.1495018": EDITORIAL})
    cache = net.Cache(tmp_path / "cache")
    client = client_for(fake, cache)
    aid = paper(con, "10.3389/fnsys.2025.1495018")
    assert openalex.fetch(con, client, aid, openalex.Budget(con)) == openalex.FOUND
    request = fake.requests[0]
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert KEY not in str(request.url) and "api_key" not in str(request.url)
    # The other hosts never get it.
    assert client._headers("www.ebi.ac.uk") == {} and client._headers("api.crossref.org") == {}
    # A cached answer of the same client, an error, an outage: no key anywhere.
    client.get(f"{openalex.BASE}/works/W4407382357", ttl_s=3600)
    fake.statuses = [500, 500, 500, 500]
    with pytest.raises(net.Unavailable) as failed:
        openalex.work(client, openalex.Budget(con), doi="10.3389/fnsys.2025.1495018")
    assert KEY not in str(failed.value)
    down = net.Client(cache)
    down._http = httpx.Client(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("down", request=r))))
    with pytest.raises(net.Outage) as outage:
        openalex.work(down, openalex.Budget(con), doi="10.3389/fnsys.2025.1495018")
    assert KEY not in str(outage.value)
    paper(con, "10.5555/failing")
    assert "1 errors" in enrich.openalex_pass(con, client_for(Fake(statuses=[503] * 4)))
    assert "503" in con.execute("SELECT details FROM log WHERE event = 'openalex_error'").fetchone()[0]
    con.commit()
    files = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert any(p.parent.parent.name == "cache" for p in files)
    for p in files:
        assert KEY.encode() not in p.read_bytes(), p


def test_without_a_key_openalex_is_not_called(con):
    paper(con, "10.3389/fnsys.2025.1495018")
    fake = Fake({"10.3389/fnsys.2025.1495018": EDITORIAL})
    assert "no API key" in enrich.openalex_pass(con, client_for(fake))
    assert fake.requests == [] and harvest.Options().openalex is False


def test_the_budget_counts_what_openalex_says_and_resets_at_midnight_utc(con):
    now = [T0]
    budget = openalex.Budget(con, clock=lambda: now[0])
    r = net.Response("u", 200, "{}", headers={"x-ratelimit-cost-usd": "0", "x-ratelimit-remaining-usd": "0.98"})
    budget.record(r)
    budget.record(net.Response("u", 404, "", headers={}))
    s = budget.state()
    assert (s["calls"], s["cost_usd"], s["remaining_usd"]) == (2, 0.0, 0.98)
    budget.check("single")
    # A paid call is refused when the credit left is the reserve; free ones go on.
    budget.record(net.Response("u", 200, "{}", headers={"x-ratelimit-cost-usd": "0.0001",
                                                        "x-ratelimit-remaining-usd": "0.04"}))
    with pytest.raises(openalex.Paused):
        budget.check("list")
    budget.check("single")
    now[0] = openalex.next_reset(T0) + 1
    assert budget.state()["calls"] == 0


def test_a_429_backs_off_once_then_stops_openalex_for_the_day(con, monkeypatch, no_wait):
    monkeypatch.setenv("OPENALEX_API_KEY", KEY)
    for n in range(4):
        paper(con, f"10.5555/oa.{n}")
    fake = Fake({"10.5555/oa.0": EDITORIAL, "10.5555/oa.1": EDITORIAL}, statuses=[200, 429, 200, 429, 429],
                headers={"x-ratelimit-remaining-usd": "0.5", "x-ratelimit-reset": "7200"})
    client = client_for(fake)
    out = enrich.openalex_pass(con, client)
    # Paper 1: a 429, a pause, then its answer; paper 2: two 429s, OpenAlex stops, 2 papers left.
    assert "2 papers found" in out and "2 left" in out and "429" in out
    assert len(fake.requests) == 5
    until = openalex.Budget(con).state()["paused_until"]
    assert until > T0
    # Paused: the next pass calls nothing, and says why.
    out = enrich.openalex_pass(con, client)
    assert len(fake.requests) == 5 and "paused until" in out
    # A scan goes on without it.
    harvest._openalex_quietly(con, client, "doi:10.5555/oa.3")
    assert len(fake.requests) == 5
    assert con.execute("SELECT COUNT(*) FROM log WHERE event = 'openalex_error'").fetchone()[0] == 0


def test_the_pass_resumes_and_asks_again_only_when_due(con, monkeypatch, no_wait):
    monkeypatch.setenv("OPENALEX_API_KEY", KEY)
    known = paper(con, "10.3389/fnsys.2025.1495018")
    unknown = paper(con, "10.5555/not.yet")
    off = paper(con, "10.5555/off", on_topic="no")
    by_pmid = paper(con, "", pmid="12345")
    fake = Fake({"10.3389/fnsys.2025.1495018": EDITORIAL})
    client = client_for(fake)
    # Papers with a page first, off-topic papers last.
    assert enrich.openalex_pending(con) == [(known, True), (unknown, True), (by_pmid, True), (off, True)]
    out = enrich.openalex_pass(con, client, maximum=2)
    assert "1 papers found, 1 not in OpenAlex" in out
    # The rest next time; the paper OpenAlex did not know waits a week.
    enrich.openalex_pass(con, client)
    asked = [str(r.url) for r in fake.requests]
    assert sum("not.yet" in u for u in asked) == 1 and any("/works/pmid:12345" in u for u in asked)
    assert enrich.openalex_pending(con) == []
    status = dict(con.execute("SELECT article_id, status FROM openalex_record").fetchall())
    assert status == {known: "found", unknown: "missing", off: "missing", by_pmid: "missing"}
    later = T0 + 30 * DAY
    assert {a for a, ask in enrich.openalex_pending(con, now=later) if ask} == {unknown, off, by_pmid}
    # --all: every paper asked more than 20 hours ago.
    assert {a for a, _ in enrich.openalex_pending(con, everything=True, now=later)} == {known, unknown, off, by_pmid}
    # A paper whose record came but whose enrichment failed is taken up without asking again.
    con.execute("UPDATE article SET enriched_at = NULL WHERE id = ?", (known,))
    assert enrich.openalex_pending(con) == [(known, False)]
    # A record kept is not lost when OpenAlex stops knowing the paper.
    openalex.store(con, known, None, now=later)
    assert con.execute("SELECT status FROM openalex_record WHERE article_id = ?", (known,)).fetchone()[0] == "found"


# ---------------------------------------------------------------------------------------
# The schema, the public outputs.

def test_a_version_6_database_is_migrated_to_openalex_and_keeps_its_rows(tmp_path, monkeypatch):
    early = tmp_path / "migrations"
    early.mkdir()
    for f in sorted(db.MIGRATIONS.glob("000[4-6]_*.sql")):
        (early / f.name).write_text(f.read_text())
    monkeypatch.setattr(db, "MIGRATIONS", early)
    old = db.open_db(tmp_path / "six.db")
    assert old.execute("SELECT value FROM meta WHERE name = 'schema_version'").fetchone()[0] == "6"
    old.execute("INSERT INTO article (id, doi, title, updated_at) VALUES ('doi:10.1/a', '10.1/a', 'T', 0)")
    old.execute("INSERT INTO paper_author (article_id, position, name, ror) VALUES ('doi:10.1/a', 1, 'A', '[\"0abcdef23\"]')")
    old.commit()
    old.close()
    monkeypatch.undo()
    con = db.open_db(tmp_path / "six.db")
    assert int(con.execute("SELECT value FROM meta WHERE name = 'schema_version'").fetchone()[0]) == db.SCHEMA_VERSION >= 7
    assert con.execute("SELECT openalex_id, oa_status, preprint_id FROM article").fetchone()[:] == ("", "", "")
    assert con.execute("SELECT name, ror, openalex_id FROM paper_author").fetchone()[:] == ("A", '["0abcdef23"]', "")
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"openalex_record", "institution", "topic", "paper_topic", "paper_work"} <= tables
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO openalex_record (article_id, status, fetched_at, checked_at) "
                    "VALUES ('doi:10.1/a', 'maybe', 0, 0)")


def test_what_openalex_adds_reaches_the_pages_and_nothing_private_leaves(con, tmp_path):
    aid = paper(con, "10.3389/fnsys.2025.1495018")
    off = paper(con, "10.1101/gr.280394.124", on_topic="no")
    openalex.store(con, aid, openalex.parse(EDITORIAL), now=T0)
    openalex.store(con, off, openalex.parse(GENOME), now=T0)
    enrich.enrich_article(con, aid, xml=JATS, now=T0 + 1)
    enrich.enrich_article(con, off, now=T0 + 1)
    con.execute("UPDATE article SET on_topic = 'no' WHERE id = ?", (off,))
    db.log_event(con, "openalex_error", article=off, error="x")
    con.commit()
    out = tmp_path / "public"
    catalog.generate(con, out, public=True)
    institutions = {i["id"]: i for i in json.loads((out / "entities" / "institutions.json").read_text())}
    assert institutions["01zgy1s35"]["name"] == "University Medical Center Hamburg-Eppendorf"
    assert (institutions["01zgy1s35"]["country"], institutions["04gzbav43"]["country"]) == ("DE", "IR")
    # The off-topic paper's institutions (UCSF, Gladstone…) appear nowhere (D7).
    assert "043mz5j54" not in institutions
    page = next(iter(json.loads(p.read_text()) for p in (out / "papers").glob("*.json")))[aid]["overview"]
    assert page["topic"]["name"] == "EEG and Brain-Computer Interfaces" and page["oa_status"] == "gold"
    assert page["openalex_id"] == "W4407382357" and page["cited_by_source"] == "OpenAlex"
    assert [i["ror"] for i in page["institutions"]] == ["04gzbav43", "00g30e956", "01zgy1s35", "0041qmd21"]
    assert [a["ror"] for a in page["affiliations"]] == ["04gzbav43", "01zgy1s35", "0041qmd21"]
    public = sqlite3.connect(out / "oscr_public.db")
    tables = {r[0] for r in public.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "openalex_record" not in tables
    assert public.execute("SELECT COUNT(*) FROM institution WHERE id = '043mz5j54'").fetchone()[0] == 0
    assert public.execute("SELECT COUNT(*) FROM institution").fetchone()[0] == 4
    for table, column in (("field_provenance", "entity_id"), ("paper_work", "article_id"), ("paper_topic", "article_id")):
        assert public.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", (off,)).fetchone()[0] == 0, table
    assert public.execute("SELECT COUNT(*) FROM log WHERE details LIKE ?", (f"%{off}%",)).fetchone()[0] == 0
    assert public.execute("SELECT COUNT(*) FROM topic WHERE id = 'T10222'").fetchone()[0] == 0
    everything = "".join(p.read_text() for p in out.rglob("*.json"))
    assert "@" not in "".join(json.dumps(page)) and "Gladstone" not in everything
    public.close()
    # entities' naming by ROR id, in the page's affiliations too.
    assert entities.ror_pairs('[{"id": "01zgy1s35", "aff": 0}, {"id": "00g30e956", "aff": null}]', '["x"]') == \
        (["01zgy1s35", "00g30e956"], [("01zgy1s35", 0)])
    assert paperpage.OA_STATUSES[1] == "gold"


# ---------------------------------------------------------------------------------------
# Where the harvester calls it.

def test_a_scanned_paper_is_looked_up_before_its_enrichment(con, monkeypatch, no_wait):
    monkeypatch.setenv("OPENALEX_API_KEY", KEY)
    aid = paper(con, "10.3389/fnsys.2025.1495018")
    client = client_for(Fake({"10.3389/fnsys.2025.1495018": DEPOSITED}))
    assert harvest.Options().openalex is True
    harvest._openalex_quietly(con, client, aid)
    harvest._enrich_quietly(con, aid, JATS, None)
    assert con.execute("SELECT openalex_id, cited_by_count FROM article WHERE id = ?", (aid,)).fetchone()[:] == \
        ("W4407382357", 15)
    # OpenAlex failing costs the scan nothing: logged, the next round asks again.
    other = paper(con, "10.5555/down")
    harvest._openalex_quietly(con, client_for(Fake(statuses=[500] * 4)), other)
    assert con.execute("SELECT COUNT(*) FROM openalex_record WHERE article_id = ?", (other,)).fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM log WHERE event = 'openalex_error'").fetchone()[0] == 1


def test_the_watch_asks_openalex_again_in_its_daily_round(tmp_path, monkeypatch):
    con = db.open_db(tmp_path / "w.db")
    calls = []
    monkeypatch.setattr(harvest, "run_pass", lambda *a, **k: calls.append("news") or harvest.Tally())
    monkeypatch.setattr(harvest, "reverify", lambda *a, **k: calls.append("reverify") or 0)
    monkeypatch.setattr(harvest, "align_pending", lambda *a, **k: calls.append("align") or 0)
    monkeypatch.setattr(harvest, "backfill", lambda *a, **k: calls.append("stock") or harvest.Tally())
    monkeypatch.setattr(enrich, "openalex_pass", lambda *a, **k: calls.append("openalex") or "OpenAlex: done")
    monkeypatch.setattr(harvest.time, "sleep", lambda s: None)
    harvest.watch(con, net.Client(offline=True), "neuro", harvest.Options(openalex=True), iterations=2,
                  report=lambda _: None)
    assert calls == ["news", "reverify", "align", "openalex", "stock", "stock"]
    calls.clear()
    harvest.watch(db.open_db(tmp_path / "x.db"), net.Client(offline=True), "neuro", harvest.Options(openalex=False),
                  iterations=1, report=lambda _: None)
    assert "openalex" not in calls


def test_the_key_comes_from_the_environment_else_the_keychain(monkeypatch):
    monkeypatch.setattr(net, "_keychain_openalex_key", lambda: "from-keychain")
    assert net.openalex_key() == "from-keychain"
    monkeypatch.setenv("OPENALEX_API_KEY", " from-env ")
    assert net.openalex_key() == "from-env"
    assert net.Client(None)._headers(net.OPENALEX_HOST) == {"Authorization": "Bearer from-env"}
