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
        db.save_contents(c, repo, "abc123", [
            contents.read("analysis.py", b"print('secret of ' + __name__)\n"),
            contents.read("../../escape.py", b"x = 1\n")])
    c.commit()
    yield c
    c.close()


def _lots(folder):
    lots = {}
    for f in (folder / "scripts").glob("*.json"):
        lots.update(json.loads(f.read_text()))
    return lots


def test_in_public_mode_an_unlicensed_repository_publishes_no_text(con, tmp_path):
    catalog.generate(con, tmp_path / "out", public=True, mirror=tmp_path / "mirror")
    lots = _lots(tmp_path / "out")
    open_files = {f["path"]: f for f in lots["github.com/open/repo"]["files"]}
    assert open_files["analysis.py"]["text"].startswith("print(")
    closed = {f["path"]: f for f in lots["github.com/closed/repo"]["files"]}
    assert all(f["text"] is None for f in closed.values()) and "license" in closed["analysis.py"]["note"]
    assert closed["analysis.py"]["source_url"] == "https://github.com/closed/repo/blob/abc123/analysis.py"
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
    assert all(f["text"] is not None for f in _lots(tmp_path / "out")["github.com/closed/repo"]["files"])
