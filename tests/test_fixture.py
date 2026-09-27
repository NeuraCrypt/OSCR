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
