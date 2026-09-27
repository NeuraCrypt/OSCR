"""The website's CI catalogue: a tiny, entirely synthetic public export.

    uv run python tools/make_fixture.py            # → tests/fixtures/public-catalog/

Three invented papers (DOIs under 10.5555, the prefix Crossref reserves for tests), two
invented repositories and a few lines of invented code: nothing is copied from a real
paper or a real repository, so the fixture carries no license question. The export is
the real one (`catalog.generate`, public mode), so the CI builds the website from exactly
what `oscr nightly` writes; `tests/test_fixture.py` checks that it stays in step.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oscr import catalog, db, find, links  # noqa: E402
from oscr.align import METHOD  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "public-catalog"
KEEP = ("catalog.json", "scripts", "alignments")
COMMIT = "0" * 40
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
