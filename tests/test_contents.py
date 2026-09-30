import io
import json
import sqlite3
import zipfile

import pytest

from oscr import catalog, contents, db


def test_a_notebook_becomes_text_by_cells_without_its_outputs():
    nb = {"cells": [
        {"cell_type": "markdown", "source": ["# Analysis\n", "Filtering 1-40 Hz"]},
        {"cell_type": "code", "source": "import mne\nraw.filter(1, 40)",
         "outputs": [{"data": {"image/png": "A" * 50000}}]}]}
    f = contents.read("analysis.ipynb", json.dumps(nb).encode())
    assert f["language"] == "Jupyter" and "raw.filter(1, 40)" in f["text"]
    assert "AAAA" not in f["text"] and "# %% [markdown]" in f["text"]


def test_a_matlab_script_written_on_windows_keeps_its_accents():
    f = contents.read("filter.m", "% Data from the café, filtered by Søren at 40 Hz\n".encode("cp1252"))
    assert f["text"] == "% Data from the café, filtered by Søren at 40 Hz\n" and "�" not in f["text"]


def test_a_binary_has_no_text_but_a_note():
    f = contents.read("live.mlx", b"PK\x03\x04\x00\x00binary")
    assert f["text"] is None and "binary" in f["note"].lower()


def test_a_text_too_long_is_cut_and_says_so():
    f = contents.read("big.py", b"x = 1\n" * 100_000)
    assert f["truncated"] and len(f["text"]) == contents.MAX_TEXT


def test_a_github_release_zip_loses_its_top_folder():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("SmartERD-v1.0.0/README.md", "# SmartERD")
        z.writestr("SmartERD-v1.0.0/src/erd.py", "def erd(x):\n    return x\n")
        z.writestr("SmartERD-v1.0.0/data/subject01.fif", "data")
    files = {f["path"]: f for f in contents.from_zip(buffer.getvalue())}
    assert set(files) == {"README.md", "src/erd.py"}
    assert files["README.md"]["kind"] == "doc" and files["src/erd.py"]["kind"] == "script"


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "b.db")
    for repo, license_, redistributable in (("github.com/open/repo", "MIT", "yes"),
                                            ("github.com/closed/repo", "", "no")):
        c.execute("INSERT INTO repository (repo, url, host, kind, state, license, redistributable, commit_id) "
                  "VALUES (?, ?, 'github.com', 'forge', 'alive', ?, ?, 'abc123')",
                  (repo, f"https://{repo}", license_, redistributable))
        # The open repository's license is confirmed by its own license file (scriptstore.verified_license).
        licensed = [contents.read("LICENSE", b"MIT License\n\nPermission is hereby granted, free of charge.\n")] \
            if redistributable == "yes" else []
        db.save_contents(c, repo, "abc123", [
            contents.read("analysis.py", b"print('secret of ' + __name__)\n"),
            contents.read("../../escape.py", b"x = 1\n"), *licensed])
    # Both repositories are the code of a paper in scope: only those reach the export (D7).
    db.save_article(c, {"id": "doi:10.1/p", "doi": "10.1/p", "title": "P", "published": "2026-09-01"})
    db.mark_scanned(c, "doi:10.1/p", has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    for repo in ("github.com/open/repo", "github.com/closed/repo"):
        c.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) "
                  "VALUES ('doi:10.1/p', ?, ?, 'github.com', 'forge', 'code', 'high', 'text:availability')",
                  (repo, f"https://{repo}"))
    c.commit()
    yield c
    c.close()


def _meta(folder):
    """The per-repository FACTS (scriptmeta/NN.json, keyed by repository), the site is built from."""
    meta = {}
    for f in (folder / "scriptmeta").glob("*.json"):
        meta.update(json.loads(f.read_text()))
    return meta


def _texts(folder):
    """The scripts' text (scripts/NN.json, keyed by sha256, deduplicated)."""
    texts = {}
    for f in (folder / "scripts").glob("*.json"):
        for sha, e in json.loads(f.read_text()).items():
            texts[sha] = e["text"]
    return texts


def test_in_public_mode_every_repository_is_shown_but_only_licensed_ones_leave_in_bulk(con, tmp_path):
    catalog.generate(con, tmp_path / "out", public=True, mirror=tmp_path / "mirror")
    meta, texts = _meta(tmp_path / "out"), _texts(tmp_path / "out")
    # Both repositories are shown from OSCR's own copy: the text lives in a digest lot, by sha256.
    open_files = {f["path"]: f for f in meta["github.com/open/repo"]["files"]}
    assert texts[open_files["analysis.py"]["sha256"]].startswith("print(")
    closed = {f["path"]: f for f in meta["github.com/closed/repo"]["files"]}
    assert texts[closed["analysis.py"]["sha256"]].startswith("print(")               # the unlicensed one too
    assert closed["analysis.py"]["source_url"] == "https://github.com/closed/repo/blob/abc123/analysis.py"
    # The very same file in both repositories is stored ONCE (deduplicated by sha256).
    assert open_files["analysis.py"]["sha256"] == closed["analysis.py"]["sha256"]
    # But only the licensed repository leaves as a redistributable COPY (scripts.jsonl, the mirror,
    # the public database) — the licence still gates the bulk outputs.
    lines = (tmp_path / "out" / "scripts.jsonl").read_text().splitlines()
    assert {json.loads(l)["repo"] for l in lines} == {"github.com/open/repo"}
    pub = sqlite3.connect(tmp_path / "out" / "oscr_public.db")
    assert pub.execute("SELECT COUNT(*) FROM file WHERE repo = 'github.com/closed/repo' "
                       "AND text IS NOT NULL").fetchone()[0] == 0


def test_the_mirror_only_copies_what_may_be_republished_and_never_outside_its_folder(con, tmp_path):
    catalog.generate(con, tmp_path / "out", public=True, mirror=tmp_path / "mirror")
    written = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*.py"))
    assert written == ["mirror/github.com_open_repo/analysis.py"]
    source = json.loads((tmp_path / "mirror" / "github.com_open_repo" / "SOURCE.json").read_text())
    assert source["license"] == "MIT" and source["commit"] == "abc123"


def test_the_hugging_face_dataset_declares_its_tables_and_sends_nothing_in_a_dry_run(con, tmp_path):
    from oscr import publish
    catalog.generate(con, tmp_path / "out", public=True, mirror=tmp_path / "mirror")
    folder = publish.prepare(tmp_path / "out", tmp_path / "mirror")
    card = (folder / "README.md").read_text()
    assert "data_files: scripts.jsonl" in card and "data_files: articles.csv" in card
    assert "data_files: alignments.jsonl" in card
    assert (folder / "scripts" / "github.com_open_repo" / "analysis.py").exists()
    assert not (folder / "scripts" / "github.com_closed_repo").exists()
    assert "nothing sent" in publish.publish_hf(tmp_path / "out", "u/dataset", dry_run=True)


def test_outside_public_mode_all_the_text_stays_readable(con, tmp_path):
    catalog.generate(con, tmp_path / "out", public=False)
    meta, texts = _meta(tmp_path / "out"), _texts(tmp_path / "out")
    files = [f for f in meta["github.com/closed/repo"]["files"] if f["kind"] != "note"]
    assert files and all(texts.get(f.get("sha256")) is not None for f in files)
