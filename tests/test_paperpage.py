"""Phase 4, the full page of a paper: what oscr/paperpage.py writes into papers/NN.json, on
synthetic databases. Above all, what must never leave: a paper's texts under a closed license
(decision D1), an email address, anything of an off-topic paper (D7), the texts' digests and
the raw values kept by the versions, the Zenodo sandbox's tests."""
import json
from pathlib import Path

import pytest

from oscr import catalog, db, entities, find, links, paperpage

ADA, BEN, OFF = "0000-0000-0000-001X", "0000-0000-0000-0028", "0000-0000-0000-0036"   # invented, valid
T0 = 1_790_000_000.0      # 2026-09-21


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "p.db")
    yield c
    c.close()


def paper(con, n: int, status: str = "code_verified", *, license: str = "cc by", on_topic: str = "yes",
          abstract: str = "", published: str = "2026-09-01") -> str:
    aid = f"doi:10.5555/page.{n}"
    db.save_article(con, {"id": aid, "doi": f"10.5555/page.{n}", "title": f"Paper {n}", "journal": "Journal of Tests",
                          "published": published, "license": license, "authors": ["A Author"]})
    db.mark_scanned(con, aid, has_fulltext=True, has_statement=True, code_on_request=False, data_on_request=False,
                    families=[], methods=[])
    con.execute("UPDATE article SET status = ?, on_topic = ?, abstract = ?, scanned_at = ? WHERE id = ?",
                (status, on_topic, abstract, T0 + n, aid))
    return aid


def author(con, aid: str, position: int, name: str, orcid: str = "", affiliations=(), given: str = "",
           family: str = "") -> None:
    con.execute("INSERT INTO paper_author (article_id, position, name, given, family, orcid, affiliations) "
                "VALUES (?,?,?,?,?,?,?)", (aid, position, name, given, family, orcid, json.dumps(list(affiliations))))
    if orcid:
        con.execute("INSERT OR REPLACE INTO author (orcid, name) VALUES (?, ?)", (orcid, name))


def statement(con, aid: str, kind: str, text: str, title: str = "Availability") -> None:
    con.execute("INSERT INTO statement (article_id, kind, title, text) VALUES (?,?,?,?)", (aid, kind, title, text))


def links_of(con, aid: str, *found: tuple[str, str, str]) -> None:
    """(url, role, found_by), a paper's links, replaced all at once like a scan. A DOI is a
    data link to an invented DOI, as tools/make_fixture.py writes one."""
    def link(url: str) -> links.Link:
        if url.startswith("https://doi.org/"):
            return links.Link(url=url, repo=f"doi:{url[16:]}", host="doi.org", kind="data")
        return links.normalize(url)
    db.replace_links(con, aid, [find.Candidate(link(url), role, "high", 3.0, by, "", "Availability")
                                for url, role, by in found])


def export(con, folder: Path) -> dict:
    con.commit()
    catalog.generate(con, folder, public=True)
    return {i: e for f in sorted((folder / "papers").glob("*.json")) for i, e in json.loads(f.read_text()).items()}


def everything(folder: Path) -> str:
    """Every text file of the export, and the public database's bytes."""
    texts = [f.read_text() for f in sorted(folder.rglob("*")) if f.suffix in (".json", ".csv", ".jsonl")]
    return "\n".join(texts) + (folder / "oscr_public.db").read_bytes().decode("utf-8", "replace")


# ---------------------------------------------------------------------------------------
# What must never leave.

CLOSED = ("cc by-nc-nd", "CC BY-ND 4.0", "", "all rights reserved", "elsevier user license")
OPEN = ("cc by", "CC-BY-4.0", "cc0", "cc by-sa", "cc by-nc")


def test_no_abstract_nor_statement_text_under_a_closed_license(con, tmp_path):
    ids = {}
    for n, lic in enumerate(CLOSED + OPEN, 1):
        aid = ids[lic] = paper(con, n, license=lic, abstract=f"Abstract sentence number {n} of the paper.")
        statement(con, aid, "data", f"Data statement sentence number {n}, at https://doi.org/10.5555/data.{n}.")
        statement(con, aid, "code", f"Code statement sentence number {n}.")
    pages = export(con, tmp_path)
    text = everything(tmp_path)
    for n, lic in enumerate(CLOSED + OPEN, 1):
        page = pages[ids[lic]]
        if lic in CLOSED:
            for sentence in (f"Abstract sentence number {n} ", f"Data statement sentence number {n},",
                             f"Code statement sentence number {n}."):
                assert sentence not in text, (lic, sentence)
            assert page["overview"]["abstract"] == "" and page["overview"]["has_abstract"]
            assert page["availability"]["statements"] == [{"kind": "code"}, {"kind": "data"}]
            assert not page["overview"]["open"] and not page["availability"]["open"]
        else:
            assert page["overview"]["abstract"] == f"Abstract sentence number {n} of the paper."
            assert [s["text"] for s in page["availability"]["statements"]] == [
                f"Code statement sentence number {n}.", f"Data statement sentence number {n}, at "
                f"https://doi.org/10.5555/data.{n}."]


def test_no_email_address_leaves_a_paper_page(con, tmp_path):
    aid = paper(con, 1, abstract="We measured it. Correspondence: a.b@lab.example.org")
    statement(con, aid, "data", "Data are available from x.y@example.edu or at https://doi.org/10.5555/d.1.")
    author(con, aid, 1, "Ada Fixture", ADA, ["Dept of Tests, Univ X. Electronic address: ada@example.org"],
           given="Ada", family="Fixture")
    author(con, aid, 2, "someone＠example.org", "")
    con.execute("INSERT INTO funder (id, name) VALUES ('name:f', 'Fund (contact: fund@example.org)')")
    con.execute("INSERT INTO grant_award (article_id, funder_id, award) VALUES (?, 'name:f', 'A-1')", (aid,))
    con.execute("INSERT INTO paper_subject (article_id, scheme, term) VALUES (?, 'keyword', 'x [at] example [dot] org')",
                (aid,))
    con.execute("INSERT INTO paper_rrid (article_id, rrid, kind, name) VALUES (?, 'RRID:SCR_1', 'SCR', 'mail@x.org')",
                (aid,))
    pages = export(con, tmp_path)
    lots = "".join(f.read_text() for f in (tmp_path / "papers").glob("*.json"))
    assert not entities.has_contact(lots)
    for address in ("a.b@lab", "x.y@example", "ada@example", "someone＠", "fund@example", "mail@x.org", "[at]"):
        assert address not in lots, address
    page = pages[aid]
    assert page["overview"]["abstract"] == "We measured it"                # what remains, without the address
    assert page["overview"]["affiliations"] == [{"name": "Dept of Tests, Univ X", "ror": ""}]
    assert "https://doi.org/10.5555/d.1" in page["availability"]["statements"][0]["text"]


def test_an_off_topic_paper_leaves_nothing(con, tmp_path):
    kept = paper(con, 1, abstract="The kept abstract.")
    off = paper(con, 2, on_topic="no", abstract="Offtopic abstract text.")
    for aid in (kept, off):
        author(con, aid, 1, "Ada Fixture", ADA)
        links_of(con, aid, (f"https://github.com/test/repo{aid[-1]}", "code", "text:availability"),
                 ("https://doi.org/10.5555/shared.data", "data", "text:availability"))
        con.execute("INSERT INTO paper_reference (article_id, position, doi) VALUES (?, 1, '10.5555/shared.ref')", (aid,))
    statement(con, off, "data", "Offtopic statement text.")
    author(con, off, 2, "Otto Offtopic", OFF)
    con.execute("INSERT INTO integrity_notice (article_id, kind, notice_id, source) VALUES (?, 'retraction', "
                "'10.5555/offtopic.notice', 'retraction-watch')", (off,))
    db.save_version(con, "article", off, {"type": "research-article", "keywords": ["offtopic keyword"]})
    pages = export(con, tmp_path)
    assert set(pages) == {kept}
    lots = "".join(f.read_text() for f in (tmp_path / "papers").glob("*.json")).lower()
    for trace in ("offtopic", "otto", OFF.lower(), "page.2", "page_2", "repo2"):
        assert trace not in lots, trace
    assert pages[kept]["similar"] == []                     # the off-topic paper is nobody's neighbour


def test_versions_leave_only_public_facts(con, tmp_path):
    aid = paper(con, 1)
    base = {"type": "research-article", "volume": "1", "abstract": "0123456789abcdef",
            "statements": [["data", "fedcba9876543210"]], "categories": {"on_topic": ["yes"], "modality": ["rawvalue"]},
            "authors": [("Ada Fixture", ADA)], "keywords": ["one"], "future_field": "secretfuture"}
    db.save_version(con, "article", aid, base)
    # The harvester stored the same record again (tuples read back as lists): no real change.
    con.execute("INSERT INTO version (entity, entity_id, version, created_at, actor, snapshot, diff) VALUES "
                "('article', ?, 2, ?, 'harvester', ?, '{}')", (aid, T0, json.dumps(base)))
    db.save_version(con, "article", aid, {**base, "abstract": "a1b2c3d4e5f60718"})          # texts only
    db.save_version(con, "article", aid, {**base, "abstract": "a1b2c3d4e5f60718", "volume": "2",
                                          "keywords": ["one", "two"], "journal": {"title": "J", "secret": "hidden"},
                                          "authors": [("Ada Fixture", ADA), ("Ben Example", BEN)]})
    versions = export(con, tmp_path)[aid]["versions"]
    assert [v["version"] for v in versions] == [4, 1]
    assert versions[1]["first"] and not versions[0]["first"]
    assert versions[0]["changes"] == [
        {"field": "journal.title", "before": "", "after": "J"},
        {"field": "volume", "before": "1", "after": "2"},
        {"field": "authors", "added": [f"Ben Example ({BEN})"], "removed": [], "n_added": 1, "n_removed": 0},
        {"field": "keywords", "added": ["two"], "removed": [], "n_added": 1, "n_removed": 0}]
    text = everything(tmp_path)
    for secret in ("0123456789abcdef", "fedcba9876543210", "a1b2c3d4e5f60718", "rawvalue", "secretfuture", "hidden"):
        assert secret not in text, secret


def test_only_an_orcid_validation_and_a_zenodo_doi_leave(con, tmp_path):
    aid = paper(con, 1, abstract="An abstract.")
    links_of(con, aid, ("https://github.com/test/repo", "code", "text:availability"))
    con.execute("INSERT INTO validation (article_id, orcid, name, proof, validated_at, card) VALUES "
                "(?, '0000-0002-1825-0097', 'Carberry, Josiah', 'test', ?, '{}')", (aid, T0))
    con.execute("INSERT INTO card_doi (article_id, instance, record_id, doi, concept_doi, deposited_at) VALUES "
                "(?, 'sandbox', '609607', '10.5072/zenodo.609607', '10.5072/zenodo.609606', ?)", (aid, T0))
    page = export(con, tmp_path)[aid]
    assert page["map"]["status"] == "proposed" and page["map"]["doi"] == "" and page["cite"]["map"] is None
    lots = "".join(f.read_text() for f in (tmp_path / "papers").glob("*.json"))
    assert "Carberry" not in lots and "10.5072" not in lots and "609607" not in lots
    # Then an author validates it with her ORCID, and the map gets a DOI on Zenodo.
    con.execute("INSERT INTO validation (article_id, orcid, name, proof, validated_at, card) VALUES "
                "(?, ?, 'Fixture, Ada', 'orcid', ?, '{}')", (aid, ADA, T0))
    con.execute("INSERT INTO card_doi (article_id, instance, record_id, doi, concept_doi, deposited_at) VALUES "
                "(?, 'zenodo', '12345', '10.5281/zenodo.12345', '10.5281/zenodo.12344', ?)", (aid, T0))
    page = export(con, tmp_path)[aid]
    assert page["map"]["status"] == "validated" and page["map"]["validated_by"] == [
        {"name": "Fixture, Ada", "orcid": ADA, "on": "2026-09-21"}]
    assert page["map"]["json_url"] == "https://zenodo.org/records/12345/files/tracing-map.json?download=1"
    assert "Carberry" not in (tmp_path / "papers").joinpath(f"{catalog.lot_of(aid):02d}.json").read_text()
    cite = page["cite"]["map"]
    assert cite["csl"]["author"] == [{"family": "Fixture", "given": "Ada"}, {"literal": paperpage.PLATFORM}]
    assert cite["apa"].startswith("Fixture, A., & {platform}. (2026). Code tracing map: Paper 1 (Version 0.1-")
    assert "author = {Fixture, Ada and {{platform}}}" in cite["bibtex"]


def test_retraction_watch_reasons_stay_on_the_mac(con, tmp_path):
    aid = paper(con, 1)
    con.executemany("INSERT INTO integrity_notice (article_id, kind, notice_id, source, date, reasons) VALUES "
                    "(?,?,?,?,?,?)", [(aid, "retraction", "10.5555/notice.1", "retraction-watch", "2026-09-02",
                                       "Invented reason; Another invented reason"),
                                      (aid, "comment", "42685012", "MED", "", ""),
                                      (aid, "correction", "rw:1234", "retraction-watch", "", "")])
    notices = export(con, tmp_path)[aid]["overview"]["notices"]
    assert notices == [
        {"kind": "retraction", "id": "10.5555/notice.1", "date": "2026-09-02", "source": "Retraction Watch",
         "url": "https://doi.org/10.5555/notice.1"},
        {"kind": "correction", "id": "", "date": "", "source": "Retraction Watch", "url": ""},
        {"kind": "comment", "id": "42685012", "date": "", "source": "Europe PMC",
         "url": "https://europepmc.org/article/MED/42685012"}]
    assert "Invented reason" not in "".join(f.read_text() for f in (tmp_path / "papers").glob("*.json"))


# ---------------------------------------------------------------------------------------
# What the sections say.

def test_availability_under_a_closed_license_is_facts(con, tmp_path):
    aid = paper(con, 1, license="cc by-nc-nd")
    links_of(con, aid, ("https://github.com/test/code", "code", "text:availability"),
             ("https://openneuro.org/datasets/ds000117", "data", "text:availability"),
             ("https://doi.org/10.5555/elsewhere", "data", "text:body"))
    con.execute("UPDATE article SET data_on_request = 1 WHERE id = ?", (aid,))
    statement(con, aid, "code_and_data", "A statement that must not leave.")
    page = export(con, tmp_path)[aid]
    assert page["availability"] == {
        "open": False, "statements": [{"kind": "code_and_data"}], "on_request": {"code": False, "data": True},
        "points_to": {"code": ["github.com/test/code"],
                      "data": [{"dataset": "openneuro:ds000117", "repository": "OpenNeuro"}]}}
    assert [(d["dataset"], d["where"]) for d in page["data"]] == [
        ("doi:10.5555/elsewhere", "the text, “Availability”"), ("openneuro:ds000117", "“Availability”")]


def test_a_code_and_data_statement_made_of_the_others_is_left_out(con, tmp_path):
    aid = paper(con, 1)
    statement(con, aid, "data", "Data are at X.", "DATA AVAILABILITY:")
    statement(con, aid, "code", "Code is at Y.", "Code availability")
    statement(con, aid, "code_and_data", "Data are at X.\n\nCode is at Y.", "Data and code availability")
    statement(con, aid, "code_and_data", "Something else as well.", "Availability of materials")
    kept = export(con, tmp_path)[aid]["availability"]["statements"]
    assert [(s["kind"], s["title"]) for s in kept] == [
        ("code", "Code availability"), ("data", "Data availability"), ("code_and_data", "Availability of materials")]


def test_the_overview_record(con, tmp_path):
    aid = paper(con, 1, abstract="First paragraph\nwrapped.\n\nSecond one.")
    con.execute("UPDATE article SET type = 'research-article', volume = '12', issue = '3', pages = '101-110', "
                "received = '2026-05-02', pmid = '123', cited_by_count = 4, references_count = 30 WHERE id = ?", (aid,))
    author(con, aid, 1, "Ada Fixture", ADA, ["Univ A", "Univ B"], given="Ada", family="Fixture")
    author(con, aid, 2, "Ben Example", "0000-0000-0000-0029", ["Univ B"])                  # a wrong check digit
    con.executemany("INSERT INTO paper_subject (article_id, scheme, term, major) VALUES (?,?,?,?)",
                    [(aid, "mesh", "Brain", 0), (aid, "mesh", "Hippocampus", 1), (aid, "keyword", "EEG", 0)])
    con.execute("INSERT INTO funder (id, name) VALUES ('10.13039/100000001', 'National Science Foundation')")
    con.executemany("INSERT INTO grant_award (article_id, funder_id, award) VALUES (?, '10.13039/100000001', ?)",
                    [(aid, "B-2"), (aid, " B-2 "), (aid, "")])
    con.executemany("INSERT INTO paper_rrid (article_id, rrid, kind, name) VALUES (?,?,?,?)",
                    [(aid, "RRID:SCR_002823", "SCR", "FieldTrip"),
                     (aid, "RRID:AB_143165", "AB", "Goat anti-Rabbit IgG (H + L) Cross-Adsorbed Secondary Antibody"),
                     (aid, "not an rrid", "", "")])
    o = export(con, tmp_path)[aid]["overview"]
    assert o["abstract"] == "First paragraph wrapped.\n\nSecond one."
    assert o["authors"] == [{"name": "Ada Fixture", "orcid": ADA, "affiliations": [1, 2]},
                            {"name": "Ben Example", "orcid": "", "affiliations": [2]}]
    assert o["affiliations"] == [{"name": "Univ A", "ror": ""}, {"name": "Univ B", "ror": ""}]
    assert o["mesh"] == [{"term": "Hippocampus", "major": True}, {"term": "Brain", "major": False}]
    assert o["funding"] == [{"funder": "National Science Foundation", "url": "https://doi.org/10.13039/100000001",
                             "awards": ["B-2"]}]
    assert o["rrids"] == [{"rrid": "RRID:AB_143165", "kind": "AB", "name": ""},        # a sentence: left out
                          {"rrid": "RRID:SCR_002823", "kind": "SCR", "name": "FieldTrip"}]
    assert (o["volume"], o["issue"], o["pages"], o["pmid"], o["cited_by"], o["references"]) == (
        "12", "3", "101-110", "123", 4, 30)
    assert o["dates"]["received"] == "2026-05-02"


def test_the_code_section_facts(con, tmp_path):
    aid = paper(con, 1)
    links_of(con, aid, ("https://github.com/test/repo", "code", "text:availability"))
    db.save_repository(con, "github.com/test/repo", {"state": "dead", "http_status": 404,
                                                     "error": "fatal: an error text that stays on the Mac"})
    con.execute("UPDATE alive_check SET checked_at = ?", (T0,))
    db.save_repository(con, "github.com/test/repo", {"state": "alive", "http_status": 200, "commit_date": "2026-08-01"})
    con.execute("INSERT INTO repo_feature (repo, n_notebooks, has_readme, has_citation_cff, has_license_file, "
                "env_files, has_tests, has_ci, has_docs, computed_at) VALUES ('github.com/test/repo', 2, 1, 0, 1, "
                "'[\"environment.yml\"]', 1, 0, NULL, 0)")
    con.execute("INSERT INTO repo_tool (repo, tool_id, evidence, via) VALUES ('github.com/test/repo', 'mne', 3, 'import'), "
                "('github.com/test/repo', 'numpy', 7, 'import')")
    facts = export(con, tmp_path)[aid]["code"]["github.com/test/repo"]
    assert facts["features"] == {"readme": True, "citation_cff": False, "license_file": True,
                                 "env_files": ["environment.yml"], "tests": True, "ci": False, "docs": None,
                                 "notebooks": 2}
    assert [t["id"] for t in facts["tools"]] == ["numpy", "mne"]
    assert [(c["state"], c["http"]) for c in facts["checks"]] == [("alive", 200), ("dead", 404)]
    assert facts["checks"][1]["on"] == "2026-09-21" and facts["commit_date"] == "2026-08-01"
    assert "an error text" not in (tmp_path / "papers").joinpath(f"{catalog.lot_of(aid):02d}.json").read_text()


# ---------------------------------------------------------------------------------------
# Citations.

def test_the_citation_formats(con, tmp_path):
    aid = paper(con, 1, published="2026-09-07")
    con.execute("UPDATE article SET title = 'Sleep & memory: 100% of R_1 {braces}.', volume = '15', issue = '2', "
                "pages = '101-110', pmid = '42', pmcid = 'PMC7', type = 'research-article', language = 'en', "
                "journal_id = 'issn:1234-5678' WHERE id = ?", (aid,))
    con.execute("INSERT INTO journal (id, title, issn, publisher, nlm_ta) VALUES ('issn:1234-5678', 'Journal of Tests', "
                "'1234-5678', 'Test Press', 'J Tests')")
    author(con, aid, 1, "Jean-Pierre Émile", "", given="Jean-Pierre", family="Émile")
    author(con, aid, 2, "Justin D Shin", "", given="Justin D", family="Shin")
    author(con, aid, 3, "The ADNI Consortium", "")
    c = export(con, tmp_path)[aid]["cite"]["paper"]
    assert c["apa"] == ("Émile, J.-P., Shin, J. D., & The ADNI Consortium. (2026). Sleep & memory: 100% of R_1 "
                        "{braces}. Journal of Tests, 15(2), 101-110. https://doi.org/10.5555/page.1")
    assert c["bibtex"].splitlines() == [
        "@article{emile2026sleep,",
        "  author = {Émile, Jean-Pierre and Shin, Justin D and {The ADNI Consortium}},",
        r"  title = {{Sleep \& memory: 100\% of R\_1 \{braces\}}},",
        "  journal = {Journal of Tests},", "  year = {2026},", "  month = sep,", "  volume = {15},",
        "  number = {2},", "  pages = {101--110},", "  publisher = {Test Press},", "  issn = {1234-5678},",
        "  doi = {10.5555/page.1},", "  url = {https://doi.org/10.5555/page.1},", "  pmid = {42},",
        "  pmcid = {PMC7}", "}"]
    assert c["ris"].splitlines()[:5] == ["TY  - JOUR", "AU  - Émile, Jean-Pierre", "AU  - Shin, Justin D",
                                         "AU  - The ADNI Consortium", "TI  - Sleep & memory: 100% of R_1 {braces}"]
    assert {"DA  - 2026/09/07", "SP  - 101", "EP  - 110", "J2  - J Tests", "ER  - "} <= set(c["ris"].splitlines())
    assert c["csl"]["author"][2] == {"literal": "The ADNI Consortium"}
    assert c["csl"]["issued"] == {"date-parts": [[2026, 9, 7]]} and c["csl"]["type"] == "article-journal"
    assert (c["csl"]["container-title"], c["csl"]["page"], c["csl"]["PMCID"]) == ("Journal of Tests", "101-110", "PMC7")


def test_apa_lists_twenty_authors_then_the_last():
    names = [f"Author{i}, A." for i in range(1, 25)]
    assert paperpage._apa_authors(names[:2]) == "Author1, A., & Author2, A."
    assert paperpage._apa_authors(names[:20]).endswith("Author19, A., & Author20, A.")
    long = paperpage._apa_authors(names)
    assert long.startswith("Author1, A., ") and long.endswith("Author19, A., . . . Author24, A.")
    assert "Author20," not in long


# ---------------------------------------------------------------------------------------
# Similar papers.

def test_similar_papers_rank_by_what_they_share():
    n = 40
    features = {f"p{i}": {"tool": set(), "dataset": set(), "category": {"human"}, "reference": set(), "author": set()}
                for i in range(n)}
    features["p0"]["tool"] = {"fieldtrip", "numpy"}
    features["p0"]["reference"] = {"r1", "r2", "r3"}
    features["p1"]["tool"] = {"fieldtrip"}                  # a rare tool, and three references
    features["p1"]["reference"] = {"r1", "r2", "r3"}
    features["p2"]["tool"] = {"numpy"}                      # a common tool only
    for i in range(3, 30):
        features[f"p{i}"]["tool"] = {"numpy"}
    features["p3"]["author"] = {ADA}
    features["p0"]["author"] = {ADA}
    names = {("tool", "fieldtrip"): "FieldTrip", ("tool", "numpy"): "NumPy", ("category", "human"): "human",
             ("author", ADA): "Ada Fixture"}
    order = {p: (0, p) for p in features}
    out = paperpage.similar(features, names, order)
    ranked = [s["id"] for s in out["p0"]]
    assert ranked[:2] == ["p1", "p3"] and len(ranked) <= paperpage.MAX_SIMILAR
    # "human", which every paper has, counts a little but explains nothing: it is not named.
    assert out["p0"][0]["reasons"] == "shares FieldTrip, 3 references"
    assert out["p0"][1]["reasons"] == "shares author Ada Fixture"
    # Sharing only what most papers have is not being similar.
    assert out["p39"] == []
