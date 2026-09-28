"""The website's CI catalogue (tests/fixtures/public-catalog) is what the exporter writes
today: regenerate it with `uv run python tools/make_fixture.py` when the export changes."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402


def _load(folder: Path) -> dict:
    out = {}
    for f in sorted(folder.rglob("*.json")):
        d = json.loads(f.read_text())
        if f.name == "catalog.json":
            d.pop("generated_at", None)
        out[str(f.relative_to(folder))] = d
    return out


def test_the_fixture_catalogue_is_up_to_date(tmp_path):
    fresh = make_fixture.build(tmp_path / "public-catalog")
    assert _load(fresh) == _load(make_fixture.OUT)


def test_the_fixture_is_public_and_copies_no_unlicensed_code():
    catalog = json.loads((make_fixture.OUT / "catalog.json").read_text())
    assert catalog["public"] is True
    text = "".join(f.read_text() for f in (make_fixture.OUT / "scripts").glob("*.json"))
    assert "disp('run')" not in text and "band_power" in text


def _everything() -> str:
    return "\n".join(f.read_text() for f in sorted(make_fixture.OUT.rglob("*.json")))


def test_the_off_topic_paper_appears_nowhere():
    text = _everything().lower()
    for trace in make_fixture.OFF_TOPIC.values():
        assert trace.lower() not in text, trace


def test_the_fixture_exercises_every_page_of_the_site():
    catalog = json.loads((make_fixture.OUT / "catalog.json").read_text())
    pages = {a["status"] for a in catalog["articles"] if a["page"]}
    assert {"code_verified", "on_request", "data_only"} <= pages
    assert [a["status"] for a in catalog["articles"] if not a["page"]] == ["none"]
    entities = make_fixture.OUT / "entities"
    for name in ("authors", "journals", "institutions", "tools", "datasets"):
        assert json.loads((entities / f"{name}.json").read_text()), name
    authors = json.loads((entities / "authors.json").read_text())
    assert {a["orcid"] for a in authors} == {make_fixture.ADA, make_fixture.BEN}
    assert json.loads((entities / "categories.json").read_text())["facets"]
    lookup = {doi: e for f in (make_fixture.OUT / "lookup").glob("*.json") for doi, e in json.loads(f.read_text()).items()}
    assert lookup["10.5555/oscr.fixture.5"] == ["none", "2026-09-25"]
    assert len(lookup["10.5555/oscr.fixture.4"]) == 3, "a paper with a page: its page's name"


def test_the_fixture_holds_no_email_address():
    # A BibTeX entry starts with "@article{": not an address.
    assert "@" not in re.sub(r"@(?:article|misc)\{", "", _everything()).replace("/@", "")


def _pages() -> dict:
    return {i: e for f in sorted((make_fixture.OUT / "papers").glob("*.json")) for i, e in json.loads(f.read_text()).items()}


def test_the_fixture_exercises_every_section_of_a_paper_page():
    catalog = json.loads((make_fixture.OUT / "catalog.json").read_text())
    pages = _pages()
    assert set(pages) == {a["id"] for a in catalog["articles"] if a["page"]}
    assert all(isinstance(a["page_lot"], int) for a in catalog["articles"] if a["page"])
    one, two, three, four = (pages[f"doi:10.5555/oscr.fixture.{n}"] for n in (1, 2, 3, 4))
    # An open license: the abstract and the statements in full; closed ones: facts only.
    assert one["overview"]["open"] and one["overview"]["abstract"].startswith("A synthetic abstract")
    assert [s["kind"] for s in one["availability"]["statements"]] == ["code", "data"]
    assert all(s.keys() == {"kind"} for s in two["availability"]["statements"] + three["availability"]["statements"])
    assert two["overview"]["abstract"] == "" and two["overview"]["has_abstract"]
    assert two["availability"]["on_request"]["data"] and three["availability"]["on_request"]["code"]
    assert four["availability"]["statements"][0]["text"].startswith("The invented recordings")
    # Code: features and checks; notices; versions with a real change; the validated map.
    facts = one["code"]["github.com/oscr-fixture/eeg-analysis"]
    assert facts["features"]["env_files"] == ["requirements.txt"] and len(facts["checks"]) == 2
    assert [n["kind"] for n in one["overview"]["notices"]] == ["correction"]
    assert [n["kind"] for n in two["overview"]["notices"]] == ["retraction"]
    assert [v["version"] for v in one["versions"]] == [2, 1]          # 3 changed texts only
    assert {c["field"] for c in one["versions"][0]["changes"]} == {"volume", "keywords", "funding", "references",
                                                                    "integrity"}
    assert one["map"]["status"] == "validated" and one["map"]["json_url"].endswith("tracing-map.json?download=1")
    assert one["cite"]["map"] and one["cite"]["paper"]["bibtex"].startswith("@article{fixture2026")
    assert two["map"]["status"] == "proposed" and four["map"]["status"] == "none"
    assert [s["slug"] for s in one["similar"]] == ["doi_10.5555_oscr.fixture.4", "doi_10.5555_oscr.fixture.2",
                                                   "doi_10.5555_oscr.fixture.3"]


def test_nothing_private_reaches_the_fixture():
    text = _everything().lower()
    for secret in make_fixture.SECRETS:
        assert secret.lower() not in text, secret
