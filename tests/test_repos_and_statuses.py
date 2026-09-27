"""Verification and conclusion, without network: a temporary database, repository
records written by hand, and the rules that derive the status from them."""
import json
import sqlite3

import pytest

from oscr import catalog, db, find, harvest, links, repos
from oscr.net import Client


def test_licenses():
    assert repos.license_of("Permission is hereby granted, free of charge, to any person") == "MIT"
    assert repos.license_of("Redistribution and use in source and binary forms ... Neither the name") == "BSD-3-Clause"
    assert repos.license_of("GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007") == "GPL-3.0"
    assert repos.license_of("Attribution-NonCommercial-ShareAlike 4.0 International") == "CC-BY-NC-SA-4.0"
    assert repos.redistributable("MIT") == "yes"
    assert repos.redistributable("CC-BY-NC-SA-4.0") == "with_conditions"
    assert repos.redistributable("") == "no"


def test_a_license_is_the_one_its_title_names_not_one_it_mentions():
    gpl3 = ("GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007\n ...\n 13. Use with the GNU Affero "
            "General Public License.\n ... use the GNU Lesser General Public License instead of this License.")
    agpl3 = "GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007\n ... the GNU General Public License"
    gpl2 = ("GNU GENERAL PUBLIC LICENSE\n Version 2, June 1991\n ... covered by the GNU Library General "
            "Public License instead.")
    lgpl3 = "GNU LESSER GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007\n ... the GNU General Public License"
    lgpl21 = "GNU LESSER GENERAL PUBLIC LICENSE\n Version 2.1, February 1999"
    assert [repos.license_of(t) for t in (gpl3, agpl3, gpl2, lgpl3, lgpl21)] == [
        "GPL-3.0", "AGPL-3.0", "GPL-2.0", "LGPL-3.0", "LGPL-2.1"]


def test_a_lone_zip_leaves_the_script_count_unknown():
    assert repos._inventory(["vignetteAnalysis.zip"])["n_scripts"] is None


def test_a_bids_dataset_is_recognized():
    files = ["dataset_description.json", "participants.tsv", "code/convert.py", "sub-01/eeg/sub-01_eeg.set"]
    assert repos._inventory(files)["resource_type"] == "bids"


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "b.db")
    yield c
    c.close()


def _paper_with(con, tmp_path, url, role, record, excerpt="…"):
    art = {"id": "doi:10.1/x", "doi": "10.1/x", "title": "T", "published": "2026-09-01"}
    db.save_article(con, art)
    link = links.normalize(url)
    c = find.Candidate(link, role, "high", 3.0, "text:availability", excerpt, "Code availability")
    db.replace_links(con, art["id"], [c])
    db.mark_scanned(con, art["id"], has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    if record:
        db.save_repository(con, link.repo, record)
    opts = harvest.Options(library=tmp_path / "lib", verify=False)
    return harvest.conclude(con, art["id"], opts), con.execute("SELECT role, reasons FROM link").fetchone()


def test_a_data_repository_full_of_scripts_carries_code(con, tmp_path):
    status, l = _paper_with(con, tmp_path, "https://github.com/a/b", "data",
                            {"state": "alive", "n_files": 60, "n_scripts": 51})
    assert status == "code_verified" and l["role"] == "code"


def test_a_bids_dataset_is_not_promoted(con, tmp_path):
    status, l = _paper_with(con, tmp_path, "https://github.com/a/b", "data",
                            {"state": "alive", "n_files": 2141, "n_scripts": 3, "resource_type": "bids"})
    assert status == "data_only" and l["role"] == "data"


def test_a_repository_without_a_script(con, tmp_path):
    status, _ = _paper_with(con, tmp_path, "https://github.com/a/b", "code",
                            {"state": "alive", "n_files": 2, "n_scripts": 0})
    assert status == "code_empty"


def test_a_dead_link(con, tmp_path):
    status, _ = _paper_with(con, tmp_path, "https://github.com/a/b", "code", {"state": "dead"})
    assert status == "code_dead"


def test_a_software_archive_is_code(con, tmp_path):
    status, l = _paper_with(con, tmp_path, "https://doi.org/10.5281/zenodo.5", "unknown",
                            {"state": "alive", "resource_type": "software", "n_files": 1, "n_scripts": None})
    assert status == "code_verified" and "software" in json.loads(l["reasons"])[-1]


def test_the_github_source_of_a_zenodo_archive_survives_a_new_scan(con, tmp_path):
    art = {"id": "doi:10.1/z", "doi": "10.1/z", "title": "T", "published": "2026-09-01"}
    db.save_article(con, art)
    z = links.normalize("https://doi.org/10.5281/zenodo.5")
    db.replace_links(con, art["id"], [find.Candidate(z, "code", "high", 3.0, "text:availability", "…")])
    # Both records are fresh: no request leaves (offline client).
    db.save_repository(con, "zenodo:5", {"state": "alive", "resource_type": "software",
                                         "linked_to": "https://github.com/a/b/tree/v1.0"})
    con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind) VALUES "
                "('github.com/a/b', 'https://github.com/a/b', 'github.com', 'forge')")
    db.save_repository(con, "github.com/a/b", {"state": "alive", "n_files": 4, "n_scripts": 3})
    harvest.verify_article(con, Client(offline=True), art["id"], harvest.Options(library=tmp_path))
    roles = dict(con.execute("SELECT repo, role FROM link WHERE article_id = ?", (art["id"],)).fetchall())
    assert roles == {"zenodo:5": "code", "github.com/a/b": "code"}


def test_the_public_outputs_keep_no_excerpt(con, tmp_path):
    _paper_with(con, tmp_path, "https://github.com/a/b", "code",
                {"state": "alive", "n_files": 3, "n_scripts": 2}, excerpt="SECRET SENTENCE OF THE PAPER")
    assert con.execute("SELECT excerpt FROM link").fetchone()[0] == "SECRET SENTENCE OF THE PAPER"
    catalog.generate(con, tmp_path / "out")
    pub = sqlite3.connect(tmp_path / "out" / "oscr_public.db")
    assert pub.execute("SELECT COUNT(*) FROM link WHERE excerpt != ''").fetchone()[0] == 0
    for name in ("catalog.json", "articles.csv", "repositories.csv"):
        assert "SECRET SENTENCE" not in (tmp_path / "out" / name).read_text()


def test_the_library_record_does_not_publish_the_excerpt(con, tmp_path):
    _paper_with(con, tmp_path, "https://github.com/a/b", "code",
                {"state": "alive", "n_files": 3, "n_scripts": 2, "files": ["a.py", "b.m", "R"]},
                excerpt="SECRET SENTENCE OF THE PAPER")
    folder = tmp_path / "lib" / "doi_10.1_x"
    record = json.loads((folder / "record.json").read_text())
    assert "SECRET SENTENCE" not in json.dumps(record) and "excerpt" not in json.dumps(record)
    manifest = json.loads((folder / "native" / "github.com_a_b.json").read_text())
    assert manifest["scripts"] == ["a.py", "b.m"]


def test_git_output_that_is_not_utf8_does_not_break_verification(tmp_path):
    repo = tmp_path / "r"
    repo.mkdir()
    (repo / "notes.txt").write_bytes(b"sigma = 5 \xb5V\n")
    for args in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.org",
                                                "commit", "-q", "-m", "x"]):
        assert repos._git(args, cwd=repo).returncode == 0
    out = repos._git(["cat-file", "-p", "HEAD:notes.txt"], cwd=repo)
    assert out.returncode == 0 and out.stdout.startswith("sigma = 5 ")


def test_a_successful_verification_clears_the_error_of_an_earlier_attempt(con):
    con.execute("INSERT INTO repository (repo, url, host, kind) VALUES "
                "('github.com/a/b', 'https://github.com/a/b', 'github.com', 'forge')")
    db.save_repository(con, "github.com/a/b", {"state": "unreachable", "error": "clone: timed out"})
    db.save_repository(con, "github.com/a/b", {"state": "alive", "n_files": 3, "n_scripts": 2})
    assert tuple(con.execute("SELECT state, error FROM repository").fetchone()) == ("alive", "")
