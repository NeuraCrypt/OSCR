"""The website's CI catalogue (tests/fixtures/public-catalog) is what the exporter writes
today: regenerate it with `uv run python tools/make_fixture.py` when the export changes."""
import json
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
    assert lookup["10.5555/oscr.fixture.5"] == {"status": "none", "read_on": "2026-09-25"}
    assert "slug" in lookup["10.5555/oscr.fixture.4"]


def test_the_fixture_holds_no_email_address():
    assert "@" not in _everything().replace("/@", "")
