"""tools/make_figures.py draws the README figures from a database in the English schema.

The database here is synthetic and small enough to count by hand, and is created with the
harvester's own schema (`oscr.db.open_db`): a change of schema that the figures do not
follow fails here, not in the README.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from oscr import db as oscr_db

TOOL = Path(__file__).resolve().parents[1] / "tools" / "make_figures.py"
_spec = importlib.util.spec_from_file_location("make_figures", TOOL)
mf = importlib.util.module_from_spec(_spec)
sys.modules["make_figures"] = mf
_spec.loader.exec_module(mf)

SVG = "{http://www.w3.org/2000/svg}"

# (id, published, status, has_fulltext, scanned)
ARTICLES = [
    ("a1", "2024-03-01", "code_verified", 1, True),
    ("a2", "2024-07-15", "none", 1, True),
    ("a3", "2025-01-10", "code_verified", 1, True),
    ("a4", "2025-02-11", "code_found", 1, True),
    ("a5", "2025-05-05", "data_only", 1, True),
    ("a6", "2026-09-01", "code_dead", 1, True),
    ("a7", "2026-09-02", "on_request", 0, True),
    ("a8", "2026-09-03", "code_empty", 1, True),
    ("a9", "", "no_fulltext", 0, True),           # read, but undated
    ("a10", "2022-06-01", "none", 1, True),       # 2023 stays empty: a gap in the years
    ("a11", "2026-09-04", "to_scan", 0, False),   # not read yet: counted nowhere
]
# (article, repo, host, role)
LINKS = [
    ("a1", "github.com/lab/alpha", "github.com", "code"),
    ("a1", "zenodo:123", "zenodo.org", "code"),
    ("a3", "github.com/lab/alpha", "github.com", "code"),   # the same repository again
    ("a3", "osf:abcde", "osf.io", "code"),
    ("a4", "gitlab.inria.fr/team/beta", "gitlab.inria.fr", "code"),
    ("a4", "people.example.edu/x", "people.example.edu", "code"),
    ("a6", "github.com/lab/dead", "github.com", "code"),
    ("a8", "supp:PMC1/code.zip", "supplementary", "code"),
    ("a8", "doi:10.5061/dryad.x", "doi:dryad", "code"),
    ("a5", "openneuro:ds1", "openneuro.org", "data"),
    ("a2", "github.com/mne-tools/mne-python", "github.com", "third_party_tool"),
]
# (repo, state, license, redistributable)
REPOSITORIES = [
    ("github.com/lab/alpha", "alive", "MIT", "yes"),
    ("zenodo:123", "alive", "CC-BY-4.0", "yes"),
    ("osf:abcde", "alive", "", "unknown"),
    ("gitlab.inria.fr/team/beta", "unverified", "", "unknown"),
    ("github.com/lab/dead", "dead", "", "unknown"),
    ("supp:PMC1/code.zip", "alive", "", "no"),
    ("doi:10.5061/dryad.x", "alive", "CC0-1.0", "yes"),
    ("people.example.edu/x", "alive", "LicenseRef-A&B<1>", "with_conditions"),
    ("openneuro:ds1", "alive", "CC0-1.0", "yes"),
    ("github.com/mne-tools/mne-python", "alive", "BSD-3-Clause", "yes"),
]
# (article, origin, repo, level)
SCRIPTS = [
    ("a1", "native", "github.com/lab/alpha", "inventoried"),
    ("a3", "native", "github.com/lab/alpha", "imported"),     # the best level of a repository counts
    ("a1", "native", "zenodo:123", "inventoried"),
    ("a3", "native", "osf:abcde", "alive"),
    ("a4", "native", "gitlab.inria.fr/team/beta", "found"),
    ("a4", "native", "people.example.edu/x", "alive"),
    ("a6", "native", "github.com/lab/dead", "found"),
    ("a8", "native", "supp:PMC1/code.zip", "inventoried"),
    ("a8", "native", "doi:10.5061/dryad.x", "alive"),
    ("a1", "generated", "github.com/lab/generated", "imported"),  # not the authors' code
]
# (repo, path, language, kind, text)
FILES = [
    ("github.com/lab/alpha", "preprocess.py", "Python", "script", "import mne  # band-pass, µV\n"),
    ("github.com/lab/alpha", "analysis.m", "MATLAB", "script", "x = filtfilt(b, a, y);\n"),
    ("github.com/lab/alpha", "README.md", "Text", "doc", "# Alpha\n"),
    ("github.com/lab/alpha", "LICENSE", "License", "doc", "MIT License\n"),
    ("zenodo:123", "stats.R", "R", "script", "t.test(a, b)\n"),
    ("zenodo:123", "figures.ipynb", "Jupyter", "script", "# %% cell 1\nplot(x)\n"),
    ("zenodo:123", "model.mat", "MATLAB", "script", None),       # no text: not kept
    ("supp:PMC1/code.zip", "run.py", "Python", "script", "print('run')\n"),
    ("supp:PMC1/code.zip", "mystery.xyz", "", "script", "??\n"),
    ("openneuro:ds1", "helper.py", "Python", "script", "pass\n"),  # a data repository
]
KEPT = [f[4] for f in FILES if f[3] == "script" and f[4] is not None and f[0] != "openneuro:ds1"]


def make_db(path: Path, *, rows: bool = True) -> Path:
    con = oscr_db.open_db(path)
    if rows:
        for aid, published, status, fulltext, scanned in ARTICLES:
            con.execute("INSERT INTO article (id, published, status, has_fulltext, scanned_at, updated_at) "
                        "VALUES (?,?,?,?,?,0)", (aid, published, status, fulltext, 1.0 if scanned else None))
        con.executemany("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                        "VALUES (?,?,'https://example.org',?,'forge',?,'high','text:availability')", LINKS)
        con.executemany("INSERT INTO repository (repo, url, host, kind, state, license, redistributable) "
                        "VALUES (?,'https://example.org','example.org','forge',?,?,?)", REPOSITORIES)
        con.executemany("INSERT INTO script (article_id, origin, repo, level) VALUES (?,?,?,?)", SCRIPTS)
        con.executemany("INSERT INTO file (repo, path, language, kind, text) VALUES (?,?,?,?,?)", FILES)
    con.commit()
    con.close()
    return path


@pytest.fixture
def db(tmp_path: Path) -> Path:
    return make_db(tmp_path / "oscr.db")


def test_the_numbers(db):
    d = mf.collect(db)
    assert (d.papers_read, d.fulltext, d.with_code, d.verified) == (10, 8, 5, 2)
    # 8 distinct code repositories, 6 of them alive; the data and tool links do not count.
    assert (d.repositories, d.alive) == (8, 6)
    assert d.scripts == 6
    assert d.script_bytes == sum(len(t.encode()) for t in KEPT)
    assert d.hosts == [("GitHub", 2), ("Dryad", 1), ("GitLab", 1), ("OSF", 1),
                       ("Supplementary files", 1), ("Zenodo", 1), ("Other", 1)]
    assert d.years == [(2022, 1, 0), (2024, 2, 1), (2025, 3, 1), (2026, 3, 0)]
    assert d.undated == 1
    assert d.languages == [("Python", 2), ("Jupyter", 1), ("MATLAB", 1), ("R", 1), ("Unknown", 1)]
    assert d.licenses == [("Not determined", 0, 3), ("CC-BY-4.0", 1, 0), ("CC0-1.0", 1, 0),
                          ("LicenseRef-A&B<1>", 1, 0), ("MIT", 1, 0), ("No license", 0, 1)]
    assert d.ladder == [("found", 8), ("alive", 6), ("inventoried", 3), ("imported", 1)]


def test_every_figure_twice_valid_and_accessible(db, tmp_path):
    out = tmp_path / "figures"
    assert mf.main(["--db", str(db), "--out", str(out), "--date", "2026-09-26"]) == 0
    names = sorted(p.name for p in out.iterdir())
    assert names == sorted([f"{f}-{t}.svg" for f in mf.FIGURES for t in ("light", "dark")] + ["figures.json"])
    for path in out.glob("*.svg"):
        root = ET.parse(path).getroot()
        assert root.tag == f"{SVG}svg"
        assert root.get("role") == "img" and root.get("viewBox")
        title, desc = root.find(f"{SVG}title"), root.find(f"{SVG}desc")
        assert title is not None and title.text and desc is not None and desc.text
        assert "2026-09-26" in desc.text
        drawn = " ".join(t.text or "" for t in root.iter(f"{SVG}text"))
        assert "None" not in drawn and "nan" not in drawn and "No data yet" not in drawn
        assert "href" not in path.read_text()  # self-contained: nothing external
    licenses = ET.parse(out / "licenses-light.svg").getroot()
    assert "LicenseRef-A&B<1>" in [t.text for t in licenses.iter(f"{SVG}text")]  # escaped, then read back
    table = json.loads((out / "figures.json").read_text())
    assert table["generated"] == "2026-09-26" and table["database"] == "oscr.db"
    assert table["kpis"]["papers_read"] == 10 and table["undated_papers"] == 1
    assert table["ladder"][-1] == {"level": "imported", "repositories": 1}


def test_light_and_dark_differ_only_in_color(db, tmp_path):
    mf.main(["--db", str(db), "--out", str(tmp_path), "--date", "2026-09-26"])
    for name in mf.FIGURES:
        light = ET.parse(tmp_path / f"{name}-light.svg").getroot()
        dark = ET.parse(tmp_path / f"{name}-dark.svg").getroot()
        assert [e.tag for e in light.iter()] == [e.tag for e in dark.iter()]
        assert [e.text for e in light.iter(f"{SVG}text")] == [e.text for e in dark.iter(f"{SVG}text")]
        assert mf.LIGHT.background in ET.tostring(light, encoding="unicode")
        assert mf.DARK.background in ET.tostring(dark, encoding="unicode")


def test_the_database_is_only_read(db, tmp_path):
    before = hashlib.sha256(db.read_bytes()).hexdigest()
    mf.main(["--db", str(db), "--out", str(tmp_path / "f"), "--date", "2026-09-26"])
    assert hashlib.sha256(db.read_bytes()).hexdigest() == before
    with pytest.raises(sqlite3.OperationalError):
        mf.open_readonly(db).execute("DELETE FROM article")


def test_an_empty_database_draws_placeholders(tmp_path):
    db = make_db(tmp_path / "empty.db", rows=False)
    mf.main(["--db", str(db), "--out", str(tmp_path / "f"), "--date", "2026-09-26"])
    for name in ("hosts", "years", "languages", "licenses", "ladder"):
        assert "No data yet" in (tmp_path / "f" / f"{name}-light.svg").read_text()
    kpis = ET.parse(tmp_path / "f" / "kpis-dark.svg").getroot()
    assert "0" in [t.text for t in kpis.iter(f"{SVG}text")]


def test_another_schema_is_refused(tmp_path):
    other = tmp_path / "other.db"
    con = sqlite3.connect(other)
    con.execute("CREATE TABLE article (id TEXT, date TEXT, state TEXT)")  # none of the expected columns
    con.close()
    with pytest.raises(SystemExit, match="English schema"):
        mf.collect(other)
    with pytest.raises(SystemExit, match="no database"):
        mf.collect(tmp_path / "missing.db")


def test_helpers():
    assert mf.nice_ticks(1871) == [0, 500, 1000, 1500, 2000]
    assert mf.nice_ticks(3) == [0, 1, 2, 3]
    assert mf.nice_ticks(0) == [0, 1]
    assert (mf.pct(0, 60), mf.pct(1, 1000), mf.pct(999, 1000), mf.pct(225, 2028), mf.pct(1, 0)) == \
        ("0%", "<1%", ">99%", "11%", "–")
    counts = {f"L{i}": 10 - i for i in range(9)} | {"Other": 5}
    assert mf.fold(counts) == [(f"L{i}", 10 - i) for i in range(7)] + [("Other", 3 + 2 + 5)]
    assert mf.host_label("www.github.com", "github.com/a/b") == "GitHub"
    assert mf.host_label("gitlab.inria.fr", "gitlab.inria.fr/a/b") == "GitLab"
    assert mf.host_label("doi:gin", "doi:10.12751/g-node.x") == "G-Node GIN"
    assert mf.host_label("anything", "supp:PMC1/x.zip") == "Supplementary files"
    assert mf.license_label("", "no") == "No license" and mf.license_label("", "unknown") == "Not determined"
    assert mf.clip("A very long license name indeed", 12.5, 60).endswith("…")
