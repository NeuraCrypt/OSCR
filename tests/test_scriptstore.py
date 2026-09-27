"""The script store: only verified licenses leave, each unique text once, blocks that
never change, one manifest per repository."""
import json

import pyarrow.parquet as pq
import pytest

from oscr import db, scriptstore

MIT = "MIT License\n\nCopyright (c) 2026 A. Author\n\nPermission is hereby granted, free of charge, to any person"
GPL3 = ("GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007\n...\n 13. Use with the GNU Affero General "
        "Public License.")


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "s.db")
    yield c
    c.close()


def repo(con, name, *, kind="forge", license="", redistributable="no", files=()):
    host = name.split("/")[0] if "/" in name else "zenodo.org"
    con.execute("INSERT INTO repository (repo, url, host, kind, state, license, redistributable, commit_id) "
                "VALUES (?, ?, ?, ?, 'alive', ?, ?, 'abc123')",
                (name, f"https://{name}", host, kind, license, redistributable))
    for path, text in files:
        con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, text) "
                    "VALUES (?, ?, 'abc123', ?, 'script', ?, ?, ?)",
                    (name, path, "Python" if path.endswith(".py") else "Text", len(text), text.count("\n") + 1, text))
    con.commit()


def test_only_licenses_confirmed_by_a_license_file_or_a_record_are_published(con, tmp_path):
    repo(con, "github.com/a/mit", license="MIT", redistributable="yes",
         files=[("LICENSE", MIT), ("run.py", "print('a')\n")])
    # A license inferred from a README sentence: not confirmed, the files stay home.
    repo(con, "github.com/b/readme-only", license="MIT", redistributable="yes", files=[("x.py", "x = 1\n")])
    repo(con, "github.com/c/none", files=[("y.py", "y = 2\n")])
    # An archive: its record's license is enough when it holds no license file.
    repo(con, "zenodo:5", kind="archive", license="CC-BY-4.0", redistributable="yes",
         files=[("pkg-1.0/z.py", "z = 3\n")])
    # "other-open" without a license file is not confirmed.
    repo(con, "zenodo:6", kind="archive", license="other-open", redistributable="yes", files=[("w.py", "w = 4\n")])
    out = scriptstore.build(con, tmp_path / "store")
    manifests = sorted(p for p in out["written"] if p.startswith("manifests/"))
    assert [json.loads((tmp_path / "store" / p).read_text())["repository"] for p in manifests] \
        == sorted(["github.com/a/mit", "zenodo:5"], key=lambda r: scriptstore.manifest_path(r))
    table = pq.read_table(tmp_path / "store" / out["blocks"][0])
    assert sorted(table.column("content").to_pylist()) == sorted([MIT, "print('a')\n", "z = 3\n"])


def test_the_license_published_is_the_one_the_license_file_names(con, tmp_path):
    repo(con, "github.com/a/gpl", license="AGPL-3.0", redistributable="yes",
         files=[("LICENSE", GPL3), ("m.py", "m = 1\n")])
    out = scriptstore.build(con, tmp_path / "store")
    doc = json.loads((tmp_path / "store" / scriptstore.manifest_path("github.com/a/gpl")).read_text())
    assert doc["license"] == "GPL-3.0" and doc["license_confirmed_by"] == "license file LICENSE"
    assert out["repositories"] == 1


def test_a_text_is_stored_once_and_found_again_by_its_position(con, tmp_path):
    shared = "import numpy as np\n"
    repo(con, "github.com/a/one", license="MIT", redistributable="yes",
         files=[("LICENSE", MIT), ("a.py", shared)])
    repo(con, "github.com/b/two", license="MIT", redistributable="yes",
         files=[("LICENSE", MIT), ("b.py", shared)])
    out = scriptstore.build(con, tmp_path / "store")
    assert out["new_files"] == 2          # the shared script and the shared LICENSE, once each
    doc = json.loads((tmp_path / "store" / scriptstore.manifest_path("github.com/b/two")).read_text())
    entry = next(f for f in doc["files"] if f["path"] == "b.py")
    table = pq.read_table(tmp_path / "store" / f"blocks/{entry['block']:05d}.parquet")
    assert table.column("content")[entry["row"]].as_py() == shared
    assert table.column("sha256")[entry["row"]].as_py() == entry["sha256"]


def test_blocks_hold_64_rows_per_group_and_are_never_rewritten(con, tmp_path):
    files = [("LICENSE", MIT)] + [(f"s{i:03d}.py", f"value = {i}\n") for i in range(150)]
    repo(con, "github.com/a/many", license="MIT", redistributable="yes", files=files)
    first = scriptstore.build(con, tmp_path / "store")
    block = tmp_path / "store" / first["blocks"][0]
    meta = pq.ParquetFile(block).metadata
    assert meta.num_rows == 151 and meta.num_row_groups == 3
    before = block.read_bytes()
    # Nothing new: nothing is written again.
    again = scriptstore.build(con, tmp_path / "store")
    assert again["written"] == [] and again["new_files"] == 0
    # A new file: a new block, the old one untouched; the manifest is rewritten.
    con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, text) "
                "VALUES ('github.com/a/many', 'new.py', 'abc123', 'Python', 'script', 8, 1, 'new = 1\n')")
    con.commit()
    third = scriptstore.build(con, tmp_path / "store")
    assert third["blocks"] == ["blocks/00002.parquet"] and block.read_bytes() == before
    assert scriptstore.manifest_path("github.com/a/many") in third["written"]


def test_a_repository_that_loses_its_license_loses_its_manifest(con, tmp_path):
    repo(con, "github.com/a/gone", license="MIT", redistributable="yes",
         files=[("LICENSE", MIT), ("g.py", "g = 1\n")])
    scriptstore.build(con, tmp_path / "store")
    con.execute("DELETE FROM file WHERE repo = 'github.com/a/gone' AND path = 'LICENSE'")
    con.execute("UPDATE repository SET license = '', redistributable = 'no' WHERE repo = 'github.com/a/gone'")
    con.commit()
    out = scriptstore.build(con, tmp_path / "store")
    assert out["withdrawn"] == [scriptstore.manifest_path("github.com/a/gone")]
    assert not (tmp_path / "store" / out["withdrawn"][0]).exists()


def test_the_audit_says_what_stays_home_and_why(con):
    repo(con, "github.com/a/mit", license="MIT", redistributable="yes", files=[("LICENSE", MIT), ("r.py", "r\n")])
    repo(con, "github.com/b/none", files=[("n.py", "n\n")])
    repo(con, "zenodo:6", kind="archive", license="other-open", redistributable="yes", files=[("w.py", "w\n")])
    a = scriptstore.audit(con)
    assert a["published"] == {"MIT (license file)": {"repositories": 1, "files": 2}}
    assert a["held"]["no license"] == {"repositories": 1, "files": 1}
    assert a["held"]["'other-open' not confirmed by a license file"] == {"repositories": 1, "files": 1}


def test_what_is_not_published_yet_is_sent_by_the_next_upload(con, tmp_path):
    repo(con, "github.com/a/mit", license="MIT", redistributable="yes", files=[("LICENSE", MIT), ("p.py", "p\n")])
    scriptstore.build(con, tmp_path / "store")
    send, remove = scriptstore.pending(con)
    assert send == ["blocks/00001.parquet", scriptstore.manifest_path("github.com/a/mit")] and remove == []
    # A build that writes nothing new leaves the pending uploads pending.
    scriptstore.build(con, tmp_path / "store")
    assert scriptstore.pending(con)[0] == send
    assert scriptstore.publish(con, tmp_path / "store", "x/y", platform="P", dry_run=True) \
        == "dry run: 4 files to send, 0 to remove → x/y"
    card = (tmp_path / "store" / "README.md").read_text()
    assert "license: other" in card and "| MIT | 1 |" in card


def test_the_dataset_token_comes_from_the_environment_or_the_keychain(monkeypatch):
    monkeypatch.setenv("OSCR_HF_TOKEN", "  from-env  ")
    assert scriptstore.token() == "from-env"
    monkeypatch.delenv("OSCR_HF_TOKEN")
    monkeypatch.setattr(scriptstore.subprocess, "run",
                        lambda *a, **k: scriptstore.subprocess.CompletedProcess(a, 44, stdout="", stderr=""))
    assert scriptstore.token() is None     # not in the keychain: the default login
