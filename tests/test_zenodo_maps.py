"""Tracing maps and their Zenodo DOIs: the rules of CLAUDE.md, checked against a fake
InvenioRDM server."""
import json
import time

import httpx
import pytest

from oscr import catalog, db, publish, zenodo


@pytest.fixture
def con(tmp_path):
    con = db.open_db(tmp_path / "b.db")
    con.execute("INSERT INTO article (id, doi, title, journal, published, authors, scanned_at, updated_at) "
                "VALUES ('doi:10.1/art', '10.1/art', 'A paper', 'A journal', '2026-09-01', '[\"Carberry\"]', 1, 1)")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by, section, excerpt) "
                "VALUES ('doi:10.1/art', 'github.com/lab/code', 'https://github.com/lab/code', 'github.com', "
                "'forge', 'code', 'high', 'text:availability', 'Code availability', 'A sentence of the paper.')")
    con.execute("INSERT INTO repository (repo, url, host, kind, state, license, commit_id) VALUES "
                "('github.com/lab/code', 'https://github.com/lab/code', 'github.com', 'forge', 'alive', "
                "'MIT', 'abc123def4567890')")
    con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, digest, text) "
                "VALUES ('github.com/lab/code', 'analysis.py', 'abc123', 'Python', 'script', 12, 1, 'e1', 'print(1)')")
    con.execute("INSERT INTO alignment (article_id, pair, paragraph, section, repo, path, start_line, end_line, "
                "symbol, score, evidence, method, computed_at) VALUES ('doi:10.1/art', 1, 7, 'Methods', "
                "'github.com/lab/code', 'analysis.py', 1, 1, '', 0.9, '[\"print\"]', 'lexical-v1', 1)")
    con.commit()
    return con


def test_the_orcid_check_digit():
    assert zenodo.orcid_is_valid("0000-0002-1825-0097")        # Josiah Carberry, ORCID's test researcher
    assert zenodo.orcid_is_valid("0000-0002-1694-233X")        # an "X" check digit
    assert not zenodo.orcid_is_valid("0000-0002-1825-0098")
    assert not zenodo.orcid_is_valid("2-1825-0097")


def test_the_map_links_the_paper_to_its_code_without_text_or_code(con):
    card = zenodo.map_of(con, "doi:10.1/art")
    assert card["paper"]["doi"] == "10.1/art" and card["format"] == "tracing-map/0.1"
    (c,) = card["code"]
    assert (c["repo"], c["commit"], c["license"]) == ("github.com/lab/code", "abc123def4567890", "MIT")
    assert c["files"] == [{"path": "analysis.py", "language": "Python", "digest": "e1"}]
    assert card["alignments"][0]["paragraph"] == 7 and card["alignments"][0]["evidence"] == ["print"]
    raw = json.dumps(card)
    assert "sentence" not in raw and "print(1)" not in raw   # neither the paper nor the code


def test_a_validation_requires_an_orcid_and_a_name(con):
    with pytest.raises(zenodo.InvenioError, match="ORCID"):
        zenodo.validate(con, "doi:10.1/art", orcid="0000-0000-0000-0000", name="Carberry, Josiah", proof="test")
    with pytest.raises(zenodo.InvenioError, match="Family, Given"):
        zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1825-0097", name="Josiah Carberry", proof="test")


def test_the_zenodo_record_follows_the_rules(con):
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1825-0097", name="Carberry, Josiah", proof="test")
    validations = con.execute("SELECT * FROM validation").fetchall()
    card = json.loads(validations[0]["card"])
    m = zenodo.deposit_payload(card, validations, platform="The platform")["metadata"]
    relations = {(r["relation_type"]["id"], r["identifier"]) for r in m["related_identifiers"]}
    assert relations == {("issupplementto", "10.1/art"),
                         ("references", "https://github.com/lab/code/tree/abc123def4567890")}
    author, platform = m["creators"]
    assert author["person_or_org"]["identifiers"] == [{"scheme": "orcid", "identifier": "0000-0002-1825-0097"}]
    assert author["person_or_org"]["family_name"] == "Carberry"
    assert platform["person_or_org"] == {"type": "organizational", "name": "The platform"}


def test_a_zenodo_repository_is_referenced_by_its_doi():
    ref = zenodo._reference({"repo": "zenodo:123", "url": "https://doi.org/10.5281/zenodo.123", "commit": ""})
    assert (ref["scheme"], ref["identifier"], ref["relation_type"]["id"]) == ("doi", "10.5281/zenodo.123", "references")


class FakeZenodo:
    """A pocket InvenioRDM: records every call and answers what is needed."""

    def __init__(self):
        self.calls = []
        self.n = 0

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path, m = req.url.path, req.method
        self.calls.append(f"{m} {path}")
        assert req.headers["authorization"] == "Bearer test-token"
        if m == "POST" and path == "/api/records":
            self.n += 1
            return httpx.Response(201, json={"id": f"r{self.n}"})
        if m == "POST" and path.endswith("/versions"):
            self.n += 1
            return httpx.Response(201, json={"id": f"r{self.n}"})
        if m == "PUT" and path.endswith("/draft"):
            return httpx.Response(200, json={"id": path.split("/")[3]})
        if m == "PUT" and path.endswith("/content"):
            card = json.loads(req.content)
            assert card["validated"]["orcid"] == "0000-0002-1825-0097"
            return httpx.Response(200, json={})
        if m == "GET" and path.startswith("/api/communities/"):
            return httpx.Response(200, json={"id": "community-uuid", "slug": "maps"})
        if path.endswith("/submit-review"):
            return httpx.Response(200, json={"id": "request-1"})
        if path.endswith("/actions/publish") or (m == "GET" and path.startswith("/api/records/")):
            rid = path.split("/")[3]
            return httpx.Response(202, json={"id": rid, "pids": {"doi": {"identifier": f"10.5072/zenodo.{rid}"}},
                                             "parent": {"pids": {"doi": {"identifier": "10.5072/zenodo.concept"}}},
                                             "links": {"self_html": f"https://sandbox.zenodo.org/records/{rid}"}})
        return httpx.Response(200, json={})


def _inv(fake):
    inv = zenodo.Invenio("sandbox", api_token="test-token", transport=httpx.MockTransport(fake))
    zenodo.INTERVAL_S = 0
    return inv


def test_no_doi_without_an_author_validation(con):
    fake = FakeZenodo()
    with pytest.raises(zenodo.InvenioError, match="not validated"):
        zenodo.deposit_map(con, _inv(fake), "doi:10.1/art", platform="P")
    assert fake.calls == []


def test_a_test_validation_never_goes_to_the_real_zenodo(con):
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1825-0097", name="Carberry, Josiah", proof="test")
    real = zenodo.Invenio("zenodo", api_token="test-token", transport=httpx.MockTransport(FakeZenodo()))
    with pytest.raises(zenodo.InvenioError, match="ORCID"):
        zenodo.deposit_map(con, real, "doi:10.1/art", platform="P", dry_run=True)
    # An author's real validation, later, goes through despite the test left in the
    # database, and the test does not appear among the creators.
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1694-233X", name="Author, An", proof="orcid")
    r = zenodo.deposit_map(con, real, "doi:10.1/art", platform="P", dry_run=True)
    names = [c["person_or_org"].get("family_name") for c in r["content"]["metadata"]["creators"]]
    assert names == ["Author", None]


def test_the_validated_map_gets_its_doi_in_the_community_then_versions(con):
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1825-0097", name="Carberry, Josiah", proof="test")
    fake = FakeZenodo()
    r = zenodo.deposit_map(con, _inv(fake), "doi:10.1/art", platform="P", community="maps")
    assert r["doi"] == "10.5072/zenodo.r1"
    assert fake.calls == [
        "POST /api/records",
        "POST /api/records/r1/draft/files", "PUT /api/records/r1/draft/files/tracing-map.json/content",
        "POST /api/records/r1/draft/files/tracing-map.json/commit",
        "GET /api/communities/maps",
        "PUT /api/records/r1/draft/review", "POST /api/records/r1/draft/actions/submit-review",
        "POST /api/requests/request-1/actions/accept", "GET /api/records/r1",
    ]
    # A corrected map: a new version, under the same concept DOI.
    fake.calls.clear()
    r = zenodo.deposit_map(con, _inv(fake), "doi:10.1/art", platform="P", community="maps")
    assert fake.calls[0] == "POST /api/records/r1/versions" and fake.calls[-1].endswith("/actions/publish")
    assert r["concept_doi"] == "10.5072/zenodo.concept"


def test_tests_never_leave_in_the_public_database(con, tmp_path):
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1825-0097", name="Carberry, Josiah", proof="test")
    con.execute("INSERT INTO card_doi VALUES ('doi:10.1/art', 'sandbox', 'r1', '10.5072/x', '', ?)", (time.time(),))
    con.commit()
    catalog.public_db(con, tmp_path / "pub.db")
    pub = db.open_db(tmp_path / "pub.db")
    assert pub.execute("SELECT count(*) FROM validation").fetchone()[0] == 0
    assert pub.execute("SELECT count(*) FROM card_doi").fetchone()[0] == 0


def test_the_catalogue_only_shows_maps_validated_with_orcid(con):
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1825-0097", name="Carberry, Josiah", proof="test")
    assert catalog.catalog_data(con)["articles"][0]["card"] is None       # a test is not shown
    zenodo.validate(con, "doi:10.1/art", orcid="0000-0002-1694-233X", name="Author, An", proof="orcid")
    con.execute("INSERT INTO card_doi VALUES ('doi:10.1/art', 'zenodo', '7', '10.5281/zenodo.7', "
                "'10.5281/zenodo.6', ?)", (time.time(),))
    card = catalog.catalog_data(con)["articles"][0]["card"]
    assert card["doi"] == "10.5281/zenodo.7"
    assert card["validated_by"] == [{"name": "Author, An", "orcid": "0000-0002-1694-233X"}]


def test_the_catalogue_exports_the_matches_for_the_reader(con, tmp_path):
    catalog.generate(con, tmp_path / "out", public=True)
    data = json.loads((tmp_path / "out" / "catalog.json").read_text())
    a = data["articles"][0]
    assert a["alignment"] == {"lot": catalog.lot_of("doi:10.1/art"), "pairs": 1, "method": "lexical-v1"}
    lot = json.loads((tmp_path / "out" / "alignments" / f"{a['alignment']['lot']:02d}.json").read_text())
    pair = lot["doi:10.1/art"]["pairs"][0]
    assert (pair["paragraph"], pair["path"], pair["start_line"]) == (7, "analysis.py", 1)
    line = json.loads((tmp_path / "out" / "alignments.jsonl").read_text().splitlines()[0])
    assert line["doi"] == "10.1/art" and "sentence" not in json.dumps(line)


def test_the_night_rebuilds_the_website_and_puts_it_online(tmp_path, monkeypatch):
    (tmp_path / "node_modules").mkdir()
    calls = []

    def fake_run(step, cwd, env, **kw):
        calls.append((step[:3], env["CATALOG_DIR"]))
        import subprocess
        return subprocess.CompletedProcess(step, 0, stdout="Uploaded oscr (3.1 sec)\nDeployed oscr triggers\n"
                                           "  https://oscr.example.workers.dev\n", stderr="")
    monkeypatch.setattr(publish.subprocess, "run", fake_run)
    r = publish.deploy_cloudflare(tmp_path / "pub", "oscr", website=tmp_path)
    assert r == "website online: https://oscr.example.workers.dev"
    assert [s for s, _ in calls] == [["npm", "run", "build"], ["npx", "wrangler", "deploy"]]
    assert calls[0][1] == str((tmp_path / "pub").resolve())
