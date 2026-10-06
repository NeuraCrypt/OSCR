"""The website's CI catalogue: a tiny, entirely synthetic public export.

    uv run python tools/make_fixture.py            # → tests/fixtures/public-catalog/
    uv run python tools/make_fixture.py --database data/fixture.db   # the synthetic database only

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

Every section of a paper's page too (Phase 4): an open-license paper with its abstract and
statements, closed-license ones whose texts must stay out, versions with a real change (and
one that only changed texts), a map validated by an author with its DOI next to sandbox
tests that must stay out, integrity notices, repository features and checks, funders,
references shared between papers. SECRETS lists what must never reach the export.

And what OpenAlex adds: institutions named, with their country and type (one of them reached
only through OpenAlex's placing of an author), a topic, an open-access status, a preprint and a
citation count whose source the page names.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oscr import catalog, db, enrich, find, links  # noqa: E402
from oscr.align import METHOD  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "public-catalog"
KEEP = ("catalog.json", "scripts", "alignments", "entities", "lookup", "papers")
COMMIT = "0" * 40
#: When every fixture paper was read (2026-09-25 12:00 UTC): the lookup says it, and it
#: must not change from one build to the next.
READ_AT = 1_790_337_600.0
JOURNAL = "issn:0000-0019"
ADA, BEN, OTTO = "0000-0000-0000-001X", "0000-0000-0000-0028", "0000-0000-0000-0036"
#: A validation made in the Zenodo sandbox, for tests: it never leaves (CLAUDE.md).
TESTER = "0000-0000-0000-0044"
DAY = 86_400.0
FIXTURE_UNIVERSITY = "https://ror.org/0fixtur00"
#: The paper that must appear nowhere on the site (D7), and what belongs to it alone.
OFF_TOPIC = {"doi": "10.5555/oscr.fixture.9", "title": "An off-topic synthetic study that must appear nowhere",
             "journal": "Journal of Elsewhere", "orcid": OTTO, "author": "Otto Offtopic", "ror": "0elsewh00",
             "dataset": "doi:10.5555/oscr.fixture.data.9", "category": "off-topic imaging",
             "abstract": "An off-topic abstract that must appear nowhere",
             "statement": "An off-topic statement that must appear nowhere",
             "notice": "10.5555/oscr.fixture.offtopic.notice",
             "topic": "An off-topic synthetic topic that must appear nowhere", "openalex": "W0000000009"}
#: A second institution, reached only through OpenAlex's placing of an author (invented ROR id).
SECOND_INSTITUTE = "0synthe00"
#: Texts and facts that must never reach the export: the abstract and statements of papers
#: under a closed license, the digests kept by the versions, a classification's raw value,
#: Retraction Watch's reasons, a sandbox test's validator and DOI.
SECRETS = ("A closed abstract that must never reach the site",
           "Closed statement: the data of this study are available on request",
           "Closed statement: the code of this study",
           "Closed statement: code available on request",
           "0123456789abcdef", "fedcba9876543210", "00112233aabbccdd", "a1b2c3d4e5f60718",
           "raw-rule-value-never-shown", "Falsified invented figure", "Tester, Theo", TESTER,
           "10.5072/zenodo.999")
REFS = [f"10.5555/oscr.fixture.ref.{i}" for i in (1, 2, 3)]
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


def _code(con, article_id: str, url: str, record: dict, contents: list[dict], data: tuple[str, ...] = ()) -> None:
    """A code link (and data links to invented DOIs), as a scan and a verification write them."""
    link = links.normalize(url)
    found = [find.Candidate(link, "code", "high", 3.0, "text:availability", "", "Code availability")]
    for doi in data:
        found.append(find.Candidate(links.Link(url=f"https://doi.org/{doi}", repo=f"doi:{doi}", host="doi.org",
                                               kind="data"), "data", "high", 3.0, "text:availability", "",
                                    "Data availability"))
    db.replace_links(con, article_id, found)
    db.save_repository(con, link.repo, {**record, "_contents": contents})
    enrich.link_datasets(con, article_id)


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


def _record(con, article_id: str, *, abstract: str = "", statements: tuple[tuple[str, str, str], ...] = (),
            **fields) -> None:
    """What the enrichment writes: the article's fields, its abstract and statements (kind,
    title, text)."""
    if fields:
        con.execute(f"UPDATE article SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                    (*fields.values(), article_id))
    con.execute("UPDATE article SET abstract = ? WHERE id = ?", (abstract, article_id))
    con.executemany("INSERT INTO statement (article_id, kind, title, text) VALUES (?,?,?,?)",
                    [(article_id, *st) for st in statements])


def _versions(con, article_id: str, snapshots: list[tuple[float, dict]]) -> None:
    """The record's versions, at fixed times (db.save_version would stamp them now)."""
    for n, (t, snapshot) in enumerate(snapshots, 1):
        con.execute("INSERT INTO version (entity, entity_id, version, created_at, actor, snapshot, diff) "
                    "VALUES ('article', ?, ?, ?, 'harvester', ?, '{}')", (article_id, n, t, json.dumps(snapshot)))


def _checks(con, repo: str, checks: list[tuple[float, str, int | None]]) -> None:
    """A repository's availability checks, at fixed times."""
    con.execute("DELETE FROM alive_check WHERE repo = ?", (repo,))
    con.executemany("INSERT INTO alive_check (repo, checked_at, state, http_status, error) VALUES (?,?,?,?,'')",
                    [(repo, *c) for c in checks])
    con.execute("UPDATE repository SET verified_at = ? WHERE repo = ?", (max(c[0] for c in checks), repo))


def database(path: Path) -> sqlite3.Connection:
    """The synthetic Mac database behind the fixture: the papers, their authors and code. The
    community projector's tests and the accounts' end-to-end run start from it too."""
    con = db.open_db(path)
    # 1. A paper with licensed code and two paper ↔ code pairs.
    a = _paper(con, 1, "A synthetic EEG study for the OSCR build test")
    _code(con, a, "https://github.com/oscr-fixture/eeg-analysis",
          {"state": "alive", "http_status": 200, "license": "MIT", "redistributable": "yes",
           "commit_id": COMMIT, "commit_date": "2026-09-20T12:00:00+00:00", "n_files": 3, "n_scripts": 2,
           "languages": {"Python": 2}, "files": ["LICENSE", "analysis.py", "plot.py"]},
          [{"path": p, "language": lang, "kind": kind, "size": len(t), "lines": t.count("\n") + 1, "digest": "",
            "text": t} for p, lang, kind, t in (("LICENSE", "License", "doc", MIT),
                                                ("analysis.py", "Python", "script", ANALYSIS),
                                                ("plot.py", "Python", "script", PLOT))],
          data=("10.5555/oscr.fixture.data.1",))
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
                    data_on_request=True, families=[], methods=[])
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
    _phase4(con, a, b, c, d, x)
    _openalex(con, a, b, d, x)
    con.execute("UPDATE article SET scanned_at = ?", (READ_AT,))
    con.commit()
    return con


def build(out: Path = OUT) -> Path:
    tmp = out.parent / (out.name + ".building")
    shutil.rmtree(tmp, ignore_errors=True)
    con = database(tmp / "fixture.db")
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
    _site_status(out)
    return out


def _site_status(out: Path) -> None:
    """The /status page's fixture data (night phase 15): deterministic availability over 90 days,
    with two incidents, so the built page renders the enabled state in the tests. The real file is
    written by the Mac's own outbound checks (oscr/sitestatus.py); here it is synthesised."""
    from datetime import UTC, datetime

    from oscr import sitestatus

    now = int(datetime(2026, 10, 5, 12, 0, tzinfo=UTC).timestamp())
    base = datetime(2026, 10, 5, tzinfo=UTC).timestamp()
    checks = []
    for d in range(89, -1, -1):
        for h in range(0, 24, 2):  # 12 checks a day
            t = int(base - d * 86400 + h * 3600)
            ok = True
            if d == 7 and h in (6, 8, 10):  # a one-hour outage, seven days ago
                ok = False
            if d == 20 and h in (14, 16):  # a partial day, twenty days ago
                ok = False
            checks.append(sitestatus.Check(t=t, ok=ok, status=200 if ok else 503, ms=12.0 if ok else 0.0))
    sitestatus.write_status(out / "site-status.json", sitestatus.build(checks, now=now))


def _phase4(con, a: str, b: str, c: str, d: str, x: str) -> None:
    """What each section of a paper's page shows (oscr/paperpage.py)."""
    code_statement = ("code", "Code availability",
                      "The analysis code is at https://github.com/oscr-fixture/eeg-analysis, under the MIT license.")
    data_statement = ("data", "DATA AVAILABILITY",
                      "The invented recordings are at https://doi.org/10.5555/oscr.fixture.data.1.")
    # 1: an open license (CC BY): its abstract and statements are shown in full.
    _record(con, a, abstract="A synthetic abstract, written for the OSCR build test.\n\nIts second paragraph says "
                             "that the band power of an invented EEG recording was measured.",
            statements=(code_statement, data_statement,
                        ("code_and_data", "Data and code availability", f"{data_statement[2]}\n\n{code_statement[2]}")),
            type="research-article", language="en", volume="12", issue="3", pages="101-110", received="2026-05-02",
            accepted="2026-08-30", published_online="2026-09-21", cited_by_count=4, references_count=3)
    # 2: a closed license (CC BY-NC-ND): only facts about its texts.
    _record(con, b, abstract="A closed abstract that must never reach the site.",
            statements=(("data", "Data availability", "Closed statement: the data of this study are available on "
                                                      "request from the authors."),
                        ("code", "Code availability", "Closed statement: the code of this study is at "
                                                      "https://github.com/oscr-fixture/unlicensed.")),
            license="CC BY-NC-ND 4.0", type="research-article", language="en", cited_by_count=0, references_count=2)
    # 3: no license at all, code on request.
    _record(con, c, statements=(("code", "Code availability", "Closed statement: code available on request."),),
            license="", type="brief-report")
    # 4: data only, under CC BY: its data statement in full.
    _record(con, d, statements=(("data", "Data availability statement",
                                 "The invented recordings are deposited at https://doi.org/10.5555/oscr.fixture.data.1."),),
            type="data-paper", language="en", references_count=1)
    # 9: off-topic — none of it may leave.
    _record(con, x, abstract=OFF_TOPIC["abstract"], statements=(("data", "Data availability", OFF_TOPIC["statement"]),))
    con.execute("INSERT INTO integrity_notice (article_id, kind, notice_id, source, date, reasons) VALUES "
                "(?, 'retraction', ?, 'retraction-watch', '2026-09-25', '')", (x, OFF_TOPIC["notice"]))

    # Keywords, MeSH, a journal's subject, funding, an RRID, references (shared: similar papers).
    con.executemany("INSERT INTO paper_subject (article_id, scheme, term, major) VALUES (?,?,?,?)",
                    [(a, "keyword", "synthetic EEG", 0), (a, "keyword", "alpha band", 0),
                     (a, "mesh", "Electroencephalography", 1), (a, "mesh", "Humans", 0), (a, "subject", "Neuroscience", 0)])
    con.execute("INSERT INTO funder (id, name) VALUES ('name:fixture foundation for synthetic research', "
                "'Fixture Foundation for Synthetic Research')")
    con.executemany("INSERT INTO grant_award (article_id, funder_id, award) VALUES (?, "
                    "'name:fixture foundation for synthetic research', ?)", [(a, "FX-0001"), (a, "FX-0002"), (b, "")])
    con.execute("INSERT INTO paper_rrid (article_id, rrid, kind, name) VALUES (?, 'RRID:SCR_008633', 'SCR', 'NumPy')", (a,))
    con.executemany("INSERT INTO paper_reference (article_id, position, doi) VALUES (?,?,?)",
                    [(a, 1, REFS[0]), (a, 2, REFS[1]), (a, 3, REFS[2]), (b, 1, REFS[0]), (b, 2, REFS[1]),
                     (d, 1, REFS[2]), (x, 1, REFS[0])])

    # Integrity notices: a correction (Retraction Watch, whose reasons stay on the Mac) and a
    # retraction.
    con.executemany("INSERT INTO integrity_notice (article_id, kind, notice_id, source, date, reasons) VALUES "
                    "(?,?,?,?,?,?)",
                    [(a, "correction", "10.5555/oscr.fixture.correction.1", "retraction-watch", "2026-09-24",
                      "Falsified invented figure"),
                     (b, "retraction", "10.5555/oscr.fixture.retraction.2", "retraction-watch", "2026-09-26", "")])

    # The repositories: what they hold, and every check at a fixed time.
    eeg, unlicensed = "github.com/oscr-fixture/eeg-analysis", "github.com/oscr-fixture/unlicensed"
    con.execute("INSERT INTO repo_feature (repo, n_notebooks, has_readme, has_citation_cff, has_license_file, env_files, "
                "has_tests, has_ci, has_docs, data_like, computed_at) VALUES (?, 0, 0, 0, 1, '[\"requirements.txt\"]', "
                "1, 0, 0, 0.0, ?)", (eeg, READ_AT))
    _checks(con, eeg, [(READ_AT - 5 * DAY, "alive", 200), (READ_AT, "alive", 200)])
    _checks(con, unlicensed, [(READ_AT - 7 * DAY, "unreachable", 503), (READ_AT, "alive", 200)])

    # Versions: paper 1 changed once in public facts, then only in texts and categories (not
    # listed); paper 2 has its first record only. The digests and raw values must not leave.
    first = {"type": "research-article", "language": "en", "volume": "11", "issue": "3", "pages": "101-110",
             "journal": {"title": "Journal of Synthetic Fixtures", "issn": "0000-0019", "eissn": "0000-0027",
                         "publisher": "OSCR Fixture Press", "nlm_ta": ""},
             "dates": {"received": "2026-05-02", "accepted": "2026-08-30", "epub": "2026-09-21", "ppub": "",
                       "collection": "", "first_publication": "2026-09-21"},
             "abstract": "0123456789abcdef",
             "authors": [["Ada Fixture", ADA], ["Ben Example", BEN], ["Cleo Nameless", ""]],
             "keywords": ["synthetic EEG"], "mesh": ["Electroencephalography", "Humans"],
             "funding": [["Fixture Foundation for Synthetic Research", ["FX-0001"]]], "references": 2,
             "rrids": ["RRID:SCR_008633"], "statements": [["code", "fedcba9876543210"], ["data", "00112233aabbccdd"]],
             "integrity": [], "categories": {"on_topic": ["yes"], "modality": ["EEG", "raw-rule-value-never-shown"]}}
    second = {**first, "volume": "12", "keywords": ["synthetic EEG", "alpha band"],
              "funding": [["Fixture Foundation for Synthetic Research", ["FX-0001", "FX-0002"]]], "references": 3,
              "integrity": [["correction", "10.5555/oscr.fixture.correction.1"]], "abstract": "a1b2c3d4e5f60718"}
    third = {**second, "abstract": "fedcba9876543210", "categories": {"on_topic": ["yes"], "modality": ["EEG"]}}
    _versions(con, a, [(READ_AT - 3 * DAY, first), (READ_AT - DAY, second), (READ_AT, third)])
    _versions(con, b, [(READ_AT - DAY, {"type": "research-article", "abstract": "a1b2c3d4e5f60718",
                                        "statements": [["data", "00112233aabbccdd"]],
                                        "authors": [["Ben Example", BEN], ["Dan Nameless", ""]]})])

    # Paper 1's map, validated by one of its authors with her ORCID, and its DOI on Zenodo;
    # beside them, a sandbox test and its DOI, which never leave.
    con.executemany("INSERT INTO validation (article_id, orcid, name, proof, validated_at, card) VALUES (?,?,?,?,?,'{}')",
                    [(a, ADA, "Fixture, Ada", "orcid", READ_AT - DAY), (a, TESTER, "Tester, Theo", "test", READ_AT - DAY)])
    con.executemany("INSERT INTO card_doi (article_id, instance, record_id, doi, concept_doi, deposited_at) "
                    "VALUES (?,?,?,?,?,?)",
                    [(a, "zenodo", "1000001", "10.5555/oscr.fixture.map.1", "10.5555/oscr.fixture.map.0", READ_AT),
                     (a, "sandbox", "999", "10.5072/zenodo.999", "10.5072/zenodo.998", READ_AT)])


def _openalex(con, a: str, b: str, d: str, x: str) -> None:
    """What OpenAlex adds (sources/openalex.py), with invented ids in OpenAlex's forms."""
    con.executemany("INSERT INTO institution (id, name, country, type, openalex_id) VALUES (?,?,?,?,?)",
                    [("0fixtur00", "Fixture University", "NL", "education", "I0000000001"),
                     (SECOND_INSTITUTE, "Second Synthetic Institute", "DE", "facility", "I0000000002"),
                     (OFF_TOPIC["ror"], "Institute of Elsewhere", "US", "education", "I0000000009")])
    # Paper 4's first author as OpenAlex places them: each ROR id with the affiliation it is.
    con.execute("UPDATE paper_author SET ror = ?, openalex_id = 'A0000000002' WHERE article_id = ? AND position = 1",
                (json.dumps([{"id": "0fixtur00", "aff": 0}, {"id": SECOND_INSTITUTE, "aff": 1}]), d))
    con.execute("UPDATE article SET openalex_id = 'W0000000001', oa_status = 'gold', oa_url = ?, preprint_id = ?, "
                "preprint_url = ? WHERE id = ?",
                ("https://doi.org/10.5555/oscr.fixture.1", "doi:10.5555/oscr.fixture.preprint.1",
                 "https://doi.org/10.5555/oscr.fixture.preprint.1", a))
    con.execute("UPDATE article SET openalex_id = 'W0000000002', oa_status = 'hybrid' WHERE id = ?", (b,))
    con.execute("UPDATE article SET openalex_id = ? WHERE id = ?", (OFF_TOPIC["openalex"], x))
    con.executemany("INSERT INTO topic (id, name, subfield_id, subfield, field_id, field, domain_id, domain) "
                    "VALUES (?, ?, '2805', 'Cognitive Neuroscience', '28', 'Neuroscience', '1', 'Life Sciences')",
                    [("T00001", "Synthetic EEG methods"), ("T00009", OFF_TOPIC["topic"])])
    con.executemany("INSERT INTO paper_topic (article_id, topic_id, score, is_primary) VALUES (?, ?, 0.99, 1)",
                    [(a, "T00001"), (x, "T00009")])
    con.executemany("INSERT INTO field_provenance (entity, entity_id, field, source, source_ref, fetched_at) "
                    "VALUES ('article', ?, ?, ?, ?, ?)",
                    [(a, "cited_by_count", "epmc", "PMC0000001", READ_AT), (b, "cited_by_count", "openalex",
                                                                            "W0000000002", READ_AT),
                     (x, "topics", "openalex", OFF_TOPIC["openalex"], READ_AT)])


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--database":
        # Only the synthetic Mac database (for `oscr --db <it> community push --local`).
        database(Path(sys.argv[2])).close()
        print(f"fixture database → {sys.argv[2]}")
    else:
        print(f"fixture catalogue → {build()}")
