"""Phase 2, navigation: the entities and the DOI lookup of the public export
(oscr/entities.py), on synthetic databases."""
import hashlib
import json
import re
from pathlib import Path

import pytest

from oscr import catalog, db, entities, find, links

ADA, BEN, OFF = "0000-0000-0000-001X", "0000-0000-0000-0028", "0000-0000-0000-0036"   # invented, valid
T0 = 1_790_000_000.0      # 2026-09-21, a fixed "read on" day


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "e.db")
    yield c
    c.close()


def paper(con, n: int, status: str, *, on_topic: str = "yes", journal: str = "Journal of Tests",
          journal_id: str = "", published: str = "2026-09-01", doi: str | None = None, scanned: bool = True,
          names: tuple[str, ...] = ("A Author", "B Author")) -> str:
    doi = doi if doi is not None else f"10.5555/test.{n}"
    aid = f"doi:{doi.lower()}" if doi else f"pmcid:PMC{n}"
    db.save_article(con, {"id": aid, "doi": doi, "title": f"Paper {n}", "journal": journal, "published": published,
                          "authors": list(names)})
    if scanned:
        db.mark_scanned(con, aid, has_fulltext=True, has_statement=True, code_on_request=status == "on_request",
                        data_on_request=False, families=[], methods=[])
    con.execute("UPDATE article SET status = ?, on_topic = ?, journal_id = ?, scanned_at = ? WHERE id = ?",
                (status, on_topic, journal_id, T0 + n if scanned else None, aid))
    return aid


def author(con, aid: str, position: int, name: str, orcid: str = "", affiliations=(), ror=()) -> None:
    con.execute("INSERT INTO paper_author (article_id, position, name, orcid, affiliations, ror) VALUES (?,?,?,?,?,?)",
                (aid, position, name, orcid, json.dumps(list(affiliations)), json.dumps(list(ror))))
    if orcid:
        con.execute("INSERT OR REPLACE INTO author (orcid, name) VALUES (?, ?)", (orcid, name))


def code(con, aid: str, url: str) -> str:
    link = links.normalize(url)
    db.replace_links(con, aid, [find.Candidate(link, "code", "high", 3.0, "text:availability", "", "Code")])
    return link.repo


def data(con, aid: str, url: str) -> str:
    link = links.normalize(url)
    db.replace_links(con, aid, [find.Candidate(link, "data", "high", 3.0, "text:availability", "", "Data")])
    return link.repo


def export(con, folder: Path) -> dict:
    con.commit()
    catalog.generate(con, folder, public=True)
    return json.loads((folder / "catalog.json").read_text())


def load(folder: Path, name: str):
    return json.loads((folder / "entities" / f"{name}.json").read_text())


def everything(folder: Path) -> str:
    """What this export writes: the papers of catalog.json (with their new keys), the
    entities and the lookup. (The catalogue's `repositories` list is the exporter's own.)"""
    files = [*sorted((folder / "entities").glob("*.json")), *sorted((folder / "lookup").glob("*.json"))]
    papers = json.loads((folder / "catalog.json").read_text())["articles"]
    return "\n".join([json.dumps(papers, ensure_ascii=False), *(f.read_text() for f in files)])


def test_only_the_papers_of_decision_d2_have_a_page(con, tmp_path):
    ids = {s: paper(con, n, s) for n, s in enumerate(entities.PAGE_STATUSES + ("none", "no_fulltext"), 1)}
    off = paper(con, 20, "code_verified", on_topic="no")
    unclassified = paper(con, 21, "data_only", on_topic="")
    unread = paper(con, 22, "code_verified", scanned=False)
    for aid in [*ids.values(), off, unclassified, unread]:
        author(con, aid, 1, f"Author of {aid}", ADA)
    cat = export(con, tmp_path)
    page = {a["id"]: a["page"] for a in cat["articles"]}
    assert {i for i, has in page.items() if has} == {*(ids[s] for s in entities.PAGE_STATUSES), unclassified}
    assert page[ids["none"]] is False and page[ids["no_fulltext"]] is False
    assert off not in page and unread not in page            # out of the catalogue altogether
    ada = load(tmp_path, "authors")[0]
    assert ada["counts"] == {"papers": 7, "with_code": 4}
    assert set(ada["papers"]) == {catalog.slug(i) for i, has in page.items() if has}
    # Keys that were already there are unchanged; the new ones only on papers with a page.
    first = next(a for a in cat["articles"] if a["id"] == ids["code_verified"])
    assert {"id", "slug", "doi", "status", "code", "data_links", "card", "alignment"} <= first.keys()
    assert {"authors", "journal_id", "tools", "datasets"} <= first.keys()
    assert "authors" not in next(a for a in cat["articles"] if a["id"] == ids["none"])


def test_an_off_topic_paper_appears_nowhere(con, tmp_path):
    kept = paper(con, 1, "code_verified", journal="Kept Journal")
    off = paper(con, 2, "code_verified", on_topic="no", journal="Journal Of Elsewhere", doi="10.5555/OFF.TOPIC")
    author(con, kept, 1, "Ada Kept", ADA)
    author(con, off, 1, "Otto Offtopic", OFF, ["Institute of Elsewhere"], ["https://ror.org/0elsewh00"])
    code(con, kept, "https://github.com/test/kept")
    repo = code(con, off, "https://github.com/test/elsewhere")
    con.execute("INSERT INTO tool (id, name) VALUES ('elsewheretool', 'Elsewhere Tool'), ('numpy', 'NumPy')")
    con.execute("INSERT INTO repo_tool (repo, tool_id, evidence) VALUES (?, 'elsewheretool', 3), (?, 'numpy', 1), "
                "('github.com/test/kept', 'numpy', 2)", (repo, repo))
    con.execute("INSERT INTO dataset (id, repository, title) VALUES ('openneuro:ds000999', 'OpenNeuro', 'Elsewhere data')")
    con.execute("INSERT INTO paper_dataset (article_id, dataset_id) VALUES (?, 'openneuro:ds000999')", (off,))
    con.execute("INSERT INTO paper_category (article_id, facet, value, confidence) VALUES (?, 'modality', "
                "'elsewhere-imaging', 0.9)", (off,))
    export(con, tmp_path)
    text = everything(tmp_path).lower()
    for trace in ("off.topic", "otto", OFF.lower(), "elsewhere", "0elsewh00", "ds000999"):
        assert trace not in text, trace
    tools = {t["id"]: t for t in load(tmp_path, "tools")}
    assert set(tools) == {"numpy"} and tools["numpy"]["counts"] == {"papers": 1, "with_code": 1, "repositories": 1}
    assert [j["title"] for j in load(tmp_path, "journals")] == ["Kept Journal"]


EMAILS = ("ada.fixture@example.org", "b.author@lab.example.edu", "someone＠example.org", "x [at] example [dot] org")
EMAIL_LIKE = re.compile(r"[\w.+-]+\s*(?:@|＠|\[at\])\s*[\w-]+(?:\.|\s*\[dot\]\s*)\w+", re.IGNORECASE)


def test_no_email_address_in_any_output(con, tmp_path):
    a = paper(con, 1, "code_verified", names=("Ada Fixture <ada.fixture@example.org>",))
    b = paper(con, 2, "data_only", journal="Journal of Tests")
    author(con, a, 1, "Ada Fixture <ada.fixture@example.org>", ADA,
           ["Dept of Tests, Univ of Fixtures. Electronic address: ada.fixture@example.org",
            "Lab of Mail; E-mail: someone＠example.org; Tel: +1 555 010 0199"], ["https://ror.org/0fixtur00"])
    author(con, a, 2, "Ben x [at] example [dot] org Example", BEN)
    author(con, b, 1, "Cleo NoOrcid, cleo@example.org", "")
    repo = code(con, a, "https://github.com/test/emails")
    con.execute("INSERT INTO tool (id, name, homepage) VALUES ('t', 'Tool by t@example.org', 'mailto:t@example.org')")
    con.execute("INSERT INTO repo_tool (repo, tool_id) VALUES (?, 't')", (repo,))
    con.execute("INSERT INTO dataset (id, repository, title, url) VALUES ('openneuro:ds000001', 'OpenNeuro', "
                "'Recordings, contact b.author@lab.example.edu', 'https://openneuro.org/datasets/ds000001')")
    con.execute("INSERT INTO paper_dataset (article_id, dataset_id) VALUES (?, 'openneuro:ds000001')", (b,))
    con.execute("INSERT INTO journal (id, title, publisher) VALUES ('title:journal of tests', "
                "'Journal of Tests, b.author@lab.example.edu', 'Press (press@example.org)')")
    export(con, tmp_path)
    text = everything(tmp_path)
    assert not EMAIL_LIKE.search(text), EMAIL_LIKE.search(text)
    assert "010 0199" not in text           # the telephone number went with the address
    people = {p["orcid"]: p for p in load(tmp_path, "authors")}
    assert people[ADA]["name"] == "Ada Fixture"
    assert people[ADA]["affiliations"] == ["Dept of Tests, Univ of Fixtures", "Lab of Mail"]
    assert people[BEN]["name"] == "Ben Example"
    assert load(tmp_path, "datasets")[0]["title"] == "Recordings"
    tool = load(tmp_path, "tools")[0]
    assert tool["name"] == "Tool by" and tool["homepage"] == ""
    journal = load(tmp_path, "journals")[0]
    assert (journal["title"], journal["publisher"]) == ("Journal of Tests", "Press")


@pytest.mark.parametrize("text, expected", [
    ("Dept of X, Univ Y. Electronic address: a.b@y.org", "Dept of X, Univ Y"),
    ("Ada Fixture <ada@example.org>", "Ada Fixture"),
    ("a (at) example (dot) org, Lab", "Lab"),
    ("mailto:x@y.org", ""),
    ("Neuro@Home Lab", "Lab"),
    ("Correspondence: jane.doe@uni.edu", ""),
    ("Univ Z; Fax: +33 1 23 45 67 80", "Univ Z"),
    ("Brain Lab @ University of X", "Brain Lab @ University of X"),    # prose, not an address
    ("https://www.npmjs.com/package/@scope/tool", "https://www.npmjs.com/package/@scope/tool"),
    ("Telomere 123456 lab", "Telomere 123456 lab"),
    ("Plain affiliation, no contact.", "Plain affiliation, no contact."),
])
def test_contact_details_are_stripped(text, expected):
    assert entities.strip_contacts(text) == expected


def test_authors_without_a_valid_orcid_have_no_page(con, tmp_path):
    a = paper(con, 1, "code_verified")
    author(con, a, 1, "Ada Fixture", f"https://orcid.org/{ADA.lower()}")   # the URL form, a lowercase x
    author(con, a, 2, "Cleo NoOrcid")
    author(con, a, 3, "Dan Typo", "0000-0000-0000-0029")                    # wrong check digit
    b = paper(con, 2, "on_request", names=("Eve Unenriched", "Fred Unenriched"))    # no paper_author rows
    cat = export(con, tmp_path)
    assert [p["orcid"] for p in load(tmp_path, "authors")] == [ADA]
    listed = {x["id"]: x["authors"] for x in cat["articles"]}
    assert listed[a] == [{"name": "Ada Fixture", "orcid": ADA}, {"name": "Cleo NoOrcid", "orcid": ""},
                         {"name": "Dan Typo", "orcid": ""}]
    assert listed[b] == [{"name": "Eve Unenriched", "orcid": ""}, {"name": "Fred Unenriched", "orcid": ""}]


def test_an_author_gets_their_latest_affiliations_their_papers_and_their_tools(con, tmp_path):
    old = paper(con, 1, "code_verified", published="2026-01-10")
    new = paper(con, 2, "code_dead", published="2026-09-10")
    other = paper(con, 3, "data_only", published="2026-05-01")
    author(con, old, 1, "A. Fixture", ADA, ["Old Institute"], ["0oldins00"])
    author(con, new, 2, "Ada Fixture", ADA, ["New Institute", "Second Place"])
    author(con, other, 1, "Ada Fixture", ADA)
    con.execute("INSERT INTO tool (id, name) VALUES ('mne', 'MNE-Python'), ('numpy', 'NumPy')")
    for aid, url, tools in ((old, "https://github.com/test/old", ("mne", "numpy")),
                            (new, "https://github.com/test/new", ("numpy",))):
        repo = code(con, aid, url)
        con.executemany("INSERT INTO repo_tool (repo, tool_id) VALUES (?, ?)", [(repo, t) for t in tools])
    export(con, tmp_path)
    ada = load(tmp_path, "authors")[0]
    assert ada["name"] == "Ada Fixture"
    assert ada["papers"] == [catalog.slug(new), catalog.slug(other), catalog.slug(old)]
    assert ada["affiliations"] == ["New Institute", "Second Place"]
    assert ada["institutions"] == ["0oldins00"]
    assert ada["tools"] == ["numpy", "mne"]
    assert ada["counts"] == {"papers": 3, "with_code": 2}


def test_categories_keep_the_owner_models_and_confident_rules(con, tmp_path):
    a, b, c = (paper(con, n, "code_verified") for n in (1, 2, 3))
    rows = [
        (a, "modality", "EEG", 0.6, "rule", 0),            # at the threshold: kept
        (a, "modality", "MEG", 0.59, "rule", 0),           # below: dropped
        (a, "organism", "mouse", 0.95, "rule", 1),         # ambiguous: dropped
        (a, "organism", "human", 0.3, "model:qwen", 0),    # a model's answer: kept
        (a, "on_topic", "yes", 1.0, "rule", 0),            # not a category to browse
        (b, "modality", "EEG", 0.9, "rule", 0),            # the owner said otherwise: dropped
        (b, "modality", "fMRI", 0.0, "owner", 0),          # the owner's label: kept
        (c, "subfield", "cognitive neuroscience", 0.8, "rule", 0),
        (c, "modality", "EEG", 0.99, "journal", 0),        # an unknown method: dropped
    ]
    con.executemany("INSERT INTO paper_category (article_id, facet, value, confidence, method, ambiguous) "
                    "VALUES (?,?,?,?,?,?)", rows)
    export(con, tmp_path)
    cats = load(tmp_path, "categories")
    assert cats["min_confidence"] == entities.MIN_CONFIDENCE == 0.6
    shown = {f: {v: e["papers"] for v, e in values.items()} for f, values in cats["facets"].items()}
    assert shown == {"modality": {"EEG": [catalog.slug(a)], "fMRI": [catalog.slug(b)]},
                     "organism": {"human": [catalog.slug(a)]},
                     "subfield": {"cognitive neuroscience": [catalog.slug(c)]}}
    assert list(cats["facets"]) == ["modality", "organism", "subfield"]
    assert cats["facets"]["subfield"]["cognitive neuroscience"]["slug"] == "cognitive-neuroscience"
    assert cats["facets"]["modality"]["EEG"]["counts"] == {"papers": 1, "with_code": 1}


def test_the_lookup_holds_every_in_scope_paper_read_in_shards(con, tmp_path):
    with_page = paper(con, 1, "code_verified", doi="10.5555/UPPER.Case")
    without = paper(con, 2, "none")
    no_text = paper(con, 3, "no_fulltext")
    off = paper(con, 4, "code_verified", on_topic="no")
    paper(con, 5, "code_verified", scanned=False)
    paper(con, 6, "none", doi="")                     # no DOI: nothing to look up
    export(con, tmp_path)
    found = {}
    for f in (tmp_path / "lookup").glob("*.json"):
        assert re.fullmatch(r"[0-9a-f]{3}\.json", f.name)
        shard = json.loads(f.read_text())
        assert shard, "only the non-empty shards are written"
        for doi, entry in shard.items():
            assert hashlib.sha1(doi.encode()).hexdigest()[:3] == f.stem
            found[doi] = entry
    assert found == {
        "10.5555/upper.case": {"status": "code_verified", "read_on": "2026-09-21", "slug": catalog.slug(with_page)},
        "10.5555/test.2": {"status": "none", "read_on": "2026-09-21"},
        "10.5555/test.3": {"status": "no_fulltext", "read_on": "2026-09-21"},
    }
    assert without and no_text and off
    # A paper that leaves the lookup takes its shard with it when the shard empties.
    before = {f.name for f in (tmp_path / "lookup").glob("*.json")}
    con.execute("UPDATE article SET on_topic = 'no' WHERE id = ?", (without,))
    export(con, tmp_path)
    after = {f.name for f in (tmp_path / "lookup").glob("*.json")}
    assert before - after == {f"{entities.lookup_shard('10.5555/test.2')}.json"}


def test_journals_count_papers_with_code_out_of_papers_read(con, tmp_path):
    con.execute("INSERT INTO journal (id, title, issn, eissn, publisher) VALUES "
                "('issn:1234-5679', 'Journal of Tests', '1234-5679', '2345-6789', 'Test Press')")
    j = dict(journal="Journal of Tests", journal_id="issn:1234-5679")
    ids = [paper(con, 1, "code_verified", **j), paper(con, 2, "on_request", **j), paper(con, 3, "none", **j),
           paper(con, 4, "code_empty", journal="JOURNAL OF TESTS"),        # not enriched: joins by title
           paper(con, 5, "code_verified", on_topic="no", **j)]                # off-topic: not counted
    paper(con, 6, "none", journal="Journal Without Pages")
    paper(con, 7, "data_only", journal="Another Journal")
    cat = export(con, tmp_path)
    journals = {x["id"]: x for x in load(tmp_path, "journals")}
    assert set(journals) == {"issn:1234-5679", "title:another journal"}
    t = journals["issn:1234-5679"]
    assert (t["title"], t["issn"], t["eissn"], t["publisher"], t["slug"]) == \
        ("Journal of Tests", "1234-5679", "2345-6789", "Test Press", "issn-1234-5679")
    assert t["counts"] == {"papers": 3, "with_code": 2, "read": 4}
    assert set(t["papers"]) == {catalog.slug(i) for i in (ids[0], ids[1], ids[3])}
    assert journals["title:another journal"]["counts"] == {"papers": 1, "with_code": 0, "read": 1}
    assert journals["title:another journal"]["slug"] == "title-another-journal"
    assert {a["id"]: a.get("journal_id") for a in cat["articles"]}[ids[3]] == "issn:1234-5679"


def test_tools_and_datasets_list_their_repositories_and_papers(con, tmp_path):
    a = paper(con, 1, "code_verified")
    b = paper(con, 2, "data_only")
    repo = code(con, a, "https://github.com/test/analysis")
    con.execute("INSERT INTO tool (id, name, kind, homepage, rrid) VALUES "
                "('mne', 'MNE-Python', 'library', 'https://mne.tools', 'RRID:SCR_005972')")
    con.execute("INSERT INTO repo_tool (repo, tool_id, evidence) VALUES (?, 'mne', 4), (?, 'unlisted', 1)", (repo, repo))
    # A dataset the enrichment already described, and a data link it has not seen yet.
    con.execute("INSERT INTO dataset (id, repository, url, title, license) VALUES ('openneuro:ds000117', "
                "'OpenNeuro', 'https://openneuro.org/datasets/ds000117', 'Multimodal faces', 'CC0')")
    con.execute("INSERT INTO paper_dataset (article_id, dataset_id) VALUES (?, 'openneuro:ds000117')", (b,))
    data(con, b, "https://dandiarchive.org/dandiset/000001")
    cat = export(con, tmp_path)
    tools = {t["id"]: t for t in load(tmp_path, "tools")}
    assert tools["mne"] == {"id": "mne", "slug": "mne", "name": "MNE-Python", "kind": "library",
                            "homepage": "https://mne.tools", "rrid": "RRID:SCR_005972",
                            "repositories": [{"repo": repo, "url": "https://github.com/test/analysis", "evidence": 4}],
                            "papers": [catalog.slug(a)], "counts": {"papers": 1, "with_code": 1, "repositories": 1}}
    assert tools["unlisted"]["name"] == "unlisted"
    sets = {d["id"]: d for d in load(tmp_path, "datasets")}
    assert sets["openneuro:ds000117"]["slug"] == "openneuro-ds000117"
    assert sets["openneuro:ds000117"]["license"] == "CC0"
    dandi = next(d for i, d in sets.items() if i.startswith("dandi:"))
    assert dandi["repository"] == "DANDI" and dandi["url"].startswith("https://dandiarchive.org/")
    by_id = {x["id"]: x for x in cat["articles"]}
    assert by_id[a]["tools"] == ["mne", "unlisted"] and by_id[a]["datasets"] == []
    assert by_id[b]["datasets"] == sorted(sets)


def test_institutions_are_named_after_their_most_frequent_affiliation(con, tmp_path):
    a, b, c = (paper(con, n, "code_verified") for n in (1, 2, 3))
    author(con, a, 1, "Ada", ADA, ["Dept of X, Fixture University"], ["https://ror.org/0fixtur00"])
    author(con, b, 1, "Ben", BEN, ["Fixture University", "Other Place"], ["0fixtur00", "0otherp00"])
    # Affiliations and ROR ids written as objects are read too.
    author(con, c, 1, "Cleo", "", [{"name": "Fixture University"}], [{"id": "https://ror.org/0FIXTUR00"}])
    export(con, tmp_path)
    places = {i["id"]: i for i in load(tmp_path, "institutions")}
    assert set(places) == {"0fixtur00", "0otherp00"}
    assert places["0fixtur00"]["name"] == "Fixture University"
    assert places["0fixtur00"]["authors"] == [ADA, BEN]
    assert places["0fixtur00"]["counts"] == {"papers": 3, "with_code": 3}
    assert places["0otherp00"]["name"] == "Other Place"


def test_nothing_is_written_outside_public_mode(con, tmp_path):
    paper(con, 1, "code_verified")
    con.commit()
    catalog.generate(con, tmp_path, public=False)
    assert not (tmp_path / "entities").exists() and not (tmp_path / "lookup").exists()
    assert "page" not in json.loads((tmp_path / "catalog.json").read_text())["articles"][0]


def test_identifiers():
    assert entities.orcid("0000-0002-1825-0097") == "0000-0002-1825-0097"
    assert entities.orcid("https://orcid.org/0000-0002-1825-0097/") == "0000-0002-1825-0097"
    assert entities.orcid("0000-0002-1825-0098") == ""
    assert entities.orcid("https://sandbox.orcid.org/0000-0002-1825-0097") == ""
    assert entities.ror("https://ror.org/03yrm5c26") == "03yrm5c26"
    assert entities.normalize_doi("https://doi.org/10.5555/ABC") == "10.5555/abc"
    assert entities.normalize_doi("doi:10.5555/x") == "10.5555/x" and entities.normalize_doi("11.1/x") == ""
    taken: set[str] = set()
    assert entities.url_slug("issn:1234-567X", taken) == "issn-1234-567x"
    assert entities.url_slug("ISSN 1234 567X", taken).startswith("issn-1234-567x-")    # never twice the same
    assert entities.url_slug("..", taken) not in ("", ".", "..")
