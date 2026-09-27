"""The website's CI catalogue: a tiny, entirely synthetic public export.

    uv run python tools/make_fixture.py            # → tests/fixtures/public-catalog/

Invented papers (DOIs under 10.5555, the prefix Crossref reserves for tests), two invented
repositories and a few lines of invented code: nothing is copied from a real paper or a
real repository, so the fixture carries no license question. The export is the real one
(`catalog.generate`, public mode), so the CI builds the website from exactly what
`oscr nightly` writes; `tests/test_fixture.py` checks that it stays in step.

Every page of the site has something to show: papers with code, "on request" and "data
only"; a journal; authors with an ORCID iD (invented, in the 0000-0000 block ORCID never
issues) and without; an institution (a ROR id with letters ROR never uses); tools; a
dataset; categories, including values the export must leave out; a paper read without
code, found only by the DOI lookup; and an off-topic paper that must appear nowhere.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oscr import catalog, db, enrich, find, links  # noqa: E402
from oscr.align import METHOD  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "public-catalog"
KEEP = ("catalog.json", "scripts", "alignments", "entities", "lookup")
COMMIT = "0" * 40
#: When every fixture paper was read (2026-09-25 12:00 UTC): the lookup says it, and it
#: must not change from one build to the next.
READ_AT = 1_790_337_600.0
JOURNAL = "issn:0000-0019"
ADA, BEN, OTTO = "0000-0000-0000-001X", "0000-0000-0000-0028", "0000-0000-0000-0036"
FIXTURE_UNIVERSITY = "https://ror.org/0fixtur00"
#: The paper that must appear nowhere on the site (D7), and what belongs to it alone.
OFF_TOPIC = {"doi": "10.5555/oscr.fixture.9", "title": "An off-topic synthetic study that must appear nowhere",
             "journal": "Journal of Elsewhere", "orcid": OTTO, "author": "Otto Offtopic", "ror": "0elsewh00",
             "dataset": "doi:10.5555/oscr.fixture.data.9", "category": "off-topic imaging"}
MIT = ("MIT License\n\nCopyright (c) 2026 The OSCR fixture\n\nPermission is hereby granted, free of charge, "
       "to any person obtaining a copy of this software, to deal in the Software without restriction.\n")
ANALYSIS = "\n".join([
    '"""Band power of a synthetic EEG recording (invented for the OSCR build test)."""',
    "import numpy as np",
    "from scipy.signal import welch",
    "",
    "",
    "def band_power(signal, fs=250.0, band=(8.0, 12.0)):",
    '    """Mean Welch power in `band` (Hz)."""',
    "    freqs, psd = welch(signal, fs=fs, nperseg=512)",
    "    keep = (freqs >= band[0]) & (freqs <= band[1])",
    "    return float(np.mean(psd[keep]))",
    "",
])
PLOT = "import matplotlib.pyplot as plt\n\n\ndef show(values):\n    plt.plot(values)\n    plt.show()\n"


def _paper(con, n: int, title: str, **extra) -> str:
    art = {"id": f"doi:10.5555/oscr.fixture.{n}", "doi": f"10.5555/oscr.fixture.{n}", "pmcid": f"PMC000000{n}",
           "fulltext_id": f"PMC000000{n}", "title": title, "journal": "Journal of Synthetic Fixtures",
           "published": f"2026-09-2{n}", "license": "CC-BY-4.0", "source": "PMC",
           "authors": ["Fixture A", "Example B"], **extra}
    db.save_article(con, art)
    return art["id"]


def _code(con, article_id: str, url: str, record: dict, contents: list[dict]) -> None:
    link = links.normalize(url)
    db.replace_links(con, article_id, [find.Candidate(link, "code", "high", 3.0, "text:availability",
                                                      "", "Code availability")])
    db.save_repository(con, link.repo, {**record, "_contents": contents})


def _data(con, article_id: str, doi: str) -> str:
    """A data link to an invented DOI, turned into a dataset as the enrichment does."""
    link = links.Link(url=f"https://doi.org/{doi}", repo=f"doi:{doi}", host="doi.org", kind="data")
    db.replace_links(con, article_id, [find.Candidate(link, "data", "high", 3.0, "text:availability",
                                                      "", "Data availability")])
    enrich.link_datasets(con, article_id)
    return link.repo


def _authors(con, article_id: str, people: list[tuple[str, str, list[str], list[str]]]) -> None:
    """(name, ORCID iD or "", affiliations, ROR ids), in order, as the enrichment writes them."""
    for position, (name, orcid, affiliations, rors) in enumerate(people, 1):
        given, _, family = name.rpartition(" ")
        con.execute("INSERT INTO paper_author (article_id, position, name, given, family, orcid, affiliations, ror) "
                    "VALUES (?,?,?,?,?,?,?,?)", (article_id, position, name, given, family, orcid,
                                                 json.dumps(affiliations), json.dumps(rors)))
        if orcid:
            con.execute("INSERT OR REPLACE INTO author (orcid, name) VALUES (?, ?)", (orcid, name))


def _categories(con, article_id: str, values: list[tuple[str, str, float, str, int]]) -> None:
    """(facet, value, confidence, method, ambiguous)."""
    con.executemany("INSERT INTO paper_category (article_id, facet, value, confidence, method, ambiguous) "
                    "VALUES (?,?,?,?,?,?)", [(article_id, *v) for v in values])


def build(out: Path = OUT) -> Path:
    tmp = out.parent / (out.name + ".building")
    shutil.rmtree(tmp, ignore_errors=True)
    con = db.open_db(tmp / "fixture.db")
    # 1. A paper with licensed code and two paper ↔ code pairs.
    a = _paper(con, 1, "A synthetic EEG study for the OSCR build test")
    _code(con, a, "https://github.com/oscr-fixture/eeg-analysis",
          {"state": "alive", "http_status": 200, "license": "MIT", "redistributable": "yes",
           "commit_id": COMMIT, "commit_date": "2026-09-20T12:00:00+00:00", "n_files": 3, "n_scripts": 2,
           "languages": {"Python": 2}, "files": ["LICENSE", "analysis.py", "plot.py"]},
          [{"path": p, "language": lang, "kind": kind, "size": len(t), "lines": t.count("\n") + 1, "digest": "",
            "text": t} for p, lang, kind, t in (("LICENSE", "License", "doc", MIT),
                                                ("analysis.py", "Python", "script", ANALYSIS),
                                                ("plot.py", "Python", "script", PLOT))])
    db.mark_scanned(con, a, has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=["Spectral & time-frequency"], methods=["Welch PSD"])
    con.execute("UPDATE article SET status = 'code_verified' WHERE id = ?", (a,))
    con.executemany("INSERT INTO alignment (article_id, pair, paragraph, section, repo, path, start_line, "
                    "end_line, symbol, score, evidence, method, computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(a, 1, 3, "Methods › Spectral analysis", "github.com/oscr-fixture/eeg-analysis",
                      "analysis.py", 6, 10, "band_power", 0.8, '["band power", "Welch", "8–12 Hz"]', METHOD, 0.0),
                     (a, 2, 5, "Results", "github.com/oscr-fixture/eeg-analysis", "plot.py", 4, 6, "show", 0.6,
                      '["plot"]', METHOD, 0.0)])
    # 2. A paper whose code has no license: listed, linked, never copied.
    b = _paper(con, 2, "A synthetic study whose code has no license")
    _code(con, b, "https://github.com/oscr-fixture/unlicensed",
          {"state": "alive", "http_status": 200, "license": "", "redistributable": "no", "commit_id": COMMIT,
           "n_files": 1, "n_scripts": 1, "languages": {"MATLAB": 1}, "files": ["run.m"]},
          [{"path": "run.m", "language": "MATLAB", "kind": "script", "size": 12, "lines": 1, "digest": "",
            "text": "disp('run')\n"}])
    db.mark_scanned(con, b, has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    con.execute("UPDATE article SET status = 'code_verified' WHERE id = ?", (b,))
    # 3. A paper whose code is "available on request".
    c = _paper(con, 3, "A synthetic study with code on request")
    db.mark_scanned(con, c, has_fulltext=True, has_statement=True, code_on_request=True,
                    data_on_request=False, families=[], methods=[])
    con.execute("UPDATE article SET status = 'on_request' WHERE id = ?", (c,))
    # 4. A paper that shares its data only.
    d = _paper(con, 4, "A synthetic study that shares its data only")
    _data(con, d, "10.5555/oscr.fixture.data.1")
    con.execute("UPDATE dataset SET title = 'Synthetic EEG recordings for the OSCR build test', license = 'CC0-1.0' "
                "WHERE id = 'doi:10.5555/oscr.fixture.data.1'")
    db.mark_scanned(con, d, has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    con.execute("UPDATE article SET status = 'data_only' WHERE id = ?", (d,))
    # 5. A paper read where no code was found: no page, only the DOI lookup knows it.
    e = _paper(con, 5, "A synthetic study where no code was found")
    db.mark_scanned(con, e, has_fulltext=True, has_statement=False, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    con.execute("UPDATE article SET status = 'none' WHERE id = ?", (e,))
    # 9. An off-topic paper (D7), with its own author, institution, journal, dataset and
    # category: none of it may reach the site, the lookup included.
    x = _paper(con, 9, OFF_TOPIC["title"], journal=OFF_TOPIC["journal"], published="2026-09-24")
    _data(con, x, OFF_TOPIC["dataset"][4:])
    db.mark_scanned(con, x, has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    con.execute("UPDATE article SET status = 'data_only', on_topic = 'no' WHERE id = ?", (x,))
    _authors(con, x, [(OFF_TOPIC["author"], OTTO, ["Institute of Elsewhere"], [OFF_TOPIC["ror"]])])
    _categories(con, x, [("modality", OFF_TOPIC["category"], 0.9, "rule", 0), ("on_topic", "no", 0.9, "rule", 0)])

    # The enrichment of Phase 1: journal, authors, tools, categories.
    con.execute("INSERT INTO journal (id, title, issn, eissn, publisher) VALUES (?, 'Journal of Synthetic Fixtures', "
                "'0000-0019', '0000-0027', 'OSCR Fixture Press')", (JOURNAL,))
    # Paper 3 has no journal id (nor a classification) yet: it joins its journal by title.
    con.executemany("UPDATE article SET journal_id = ?, on_topic = 'yes' WHERE id = ?", [(JOURNAL, i) for i in (a, b, d, e)])
    uni = ["Fixture University"]
    _authors(con, a, [("Ada Fixture", ADA, ["Department of Synthetic Neuroscience, Fixture University"],
                       [FIXTURE_UNIVERSITY]),
                      ("Ben Example", BEN, uni, [FIXTURE_UNIVERSITY]), ("Cleo Nameless", "", uni, [FIXTURE_UNIVERSITY])])
    _authors(con, b, [("Ben Example", BEN, uni, [FIXTURE_UNIVERSITY]), ("Dan Nameless", "", [], [])])
    # An email address in an affiliation: the export strips it.
    _authors(con, c, [("Ada Fixture", ADA, ["Department of Synthetic Neuroscience, Fixture University. "
                                            "Electronic address: ada.fixture@example.org"], [FIXTURE_UNIVERSITY])])
    _authors(con, d, [("Ben Example", BEN, ["Institute of Invented Methods, Fixture University",
                                            "Second Synthetic Institute"], [FIXTURE_UNIVERSITY]),
                      ("Eve Nameless", "", [], [])])
    con.executemany("INSERT INTO tool (id, name, kind, languages, homepage, rrid) VALUES (?, ?, 'library', "
                    "'[\"Python\"]', ?, ?)",
                    [("numpy", "NumPy", "https://numpy.org", "RRID:SCR_008633"),
                     ("scipy", "SciPy", "https://scipy.org", ""),
                     ("matplotlib", "Matplotlib", "https://matplotlib.org", "")])
    con.executemany("INSERT INTO repo_tool (repo, tool_id, evidence, via) VALUES "
                    "('github.com/oscr-fixture/eeg-analysis', ?, 1, 'import')", [("numpy",), ("scipy",), ("matplotlib",)])
    _categories(con, a, [("modality", "EEG", 0.9, "rule", 0), ("organism", "human", 0.8, "rule", 0),
                         ("subfield", "cognitive neuroscience", 0.7, "model:fixture", 0)])
    _categories(con, b, [("modality", "EEG", 0.7, "rule", 0),
                         ("organism", "rat", 0.9, "rule", 1)])                # ambiguous: left out
    _categories(con, c, [("modality", "MEG", 1.0, "owner", 0),
                         ("organism", "mouse", 0.4, "rule", 0)])              # not confident enough: left out
    _categories(con, d, [("modality", "EEG", 0.95, "rule", 0), ("organism", "human", 1.0, "owner", 0)])
    con.execute("UPDATE article SET scanned_at = ?", (READ_AT,))
    con.commit()
    catalog.generate(con, tmp / "export", public=True)
    con.close()
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for name in KEEP:
        src = tmp / "export" / name
        if src.is_dir():
            shutil.copytree(src, out / name)
        elif src.exists():
            shutil.copy2(src, out / name)
    shutil.rmtree(tmp, ignore_errors=True)
    return out


if __name__ == "__main__":
    print(f"fixture catalogue → {build()}")
