"""Shown from the source (decided 2026-09-29, docs/SCRIPT_STORAGE.md): a file whose license does not
allow copying it is never copied, no text in the site's lots, the public database or the Hugging Face
dataset, but the export publishes its facts (digest, size, lines, the pinned version) and where a
reader's browser fetches it itself (catalog.source_of). What a removal request withheld gets none. And
the email addresses of a text are masked the same way here and in the reader's browser: one fixture
(tests/fixtures/mask_emails.json), read by this file and by website/tests/source.test.ts."""
import json
import sqlite3
from pathlib import Path

import pytest

from oscr import catalog, db, jobs, scriptstore

ROOT = Path(__file__).resolve().parents[1]
SHA = "a" * 40
DIGEST = "b" * 64
MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n"


def repo(**kw) -> dict:
    base = {"repo": "github.com/lab/code", "url": "https://github.com/Lab/Code", "host": "github.com", "kind": "forge",
            "state": "alive", "commit_id": SHA, "files": "[]"}
    return {**base, **kw}


# ---------------------------------------------------------------------------------------
# Email addresses: the Python version and its TypeScript port read the same cases.

def test_the_masking_fixture_is_the_python_versions_own():
    fixture = json.loads((ROOT / "tests" / "fixtures" / "mask_emails.json").read_text())
    assert fixture["mask"] == catalog.EMAIL_MASK
    assert len(fixture["cases"]) >= 25
    for case in fixture["cases"]:
        assert catalog.mask_emails(case["text"]) == case["masked"], case["name"]
        assert case["masked"].count("\n") == case["text"].count("\n"), case["name"]
    masked = {c["name"]: c["masked"] for c in fixture["cases"]}
    assert "[email hidden]" in masked["an address in a comment"]
    assert masked["a git remote stays"] == "url = 'git@github.com:lab/repo.git'\n"


# ---------------------------------------------------------------------------------------
# Where a browser fetches a file, host by host.

@pytest.mark.parametrize("row, via, url", [
    (repo(), "github", f"https://raw.githubusercontent.com/lab/code/{SHA}/{{path}}"),
    (repo(repo="gitlab.com/group/sub/proj", host="gitlab.com", url="https://gitlab.com/Group/Sub/Proj"), "gitlab",
     f"https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/repository/files/{{file}}/raw?ref={SHA}"),
    (repo(repo="bitbucket.org/lab/code", host="bitbucket.org"), "bitbucket", f"https://bitbucket.org/lab/code/raw/{SHA}/{{path}}"),
    (repo(repo="codeberg.org/lab/code", host="codeberg.org"), "codeberg",
     f"https://codeberg.org/api/v1/repos/lab/code/raw/{{path}}?ref={SHA}"),
    (repo(repo="huggingface.co/spaces/joana/app", host="huggingface.co", url="https://huggingface.co/spaces/Joana/App"),
     "huggingface", f"https://huggingface.co/spaces/Joana/App/raw/{SHA}/{{path}}"),
    (repo(repo="huggingface.co/lab/model", host="huggingface.co", url="https://huggingface.co/Lab/Model/tree/main"),
     "huggingface", f"https://huggingface.co/Lab/Model/raw/{SHA}/{{path}}"),
    # Another forge, or an address that does not name the repository: Software Heritage, by digest.
    (repo(repo="gitlab.inria.fr/team/tool", host="gitlab.inria.fr"), "swh",
     "https://archive.softwareheritage.org/api/1/content/sha256:{sha256}/raw/"),
    (repo(repo="huggingface.co/lab/model", host="huggingface.co", url="https://huggingface.co/Other/Thing"), "swh",
     "https://archive.softwareheritage.org/api/1/content/sha256:{sha256}/raw/"),
    (repo(repo="zenodo:123", host="zenodo.org", kind="archive", commit_id=""), "zenodo",
     "https://zenodo.org/api/records/123/files/{file}/content"),
])
def test_where_a_browser_fetches_a_file_at_its_pinned_version(row, via, url):
    source = catalog.source_of(row)
    assert (source["via"], source["url"]) == (via, url)
    assert source["at"] == ("123" if via == "zenodo" else SHA)
    origin = url.split("/", 3)[:3]
    assert "/".join(origin) in {"https://raw.githubusercontent.com", "https://gitlab.com", "https://bitbucket.org",
                                "https://codeberg.org", "https://huggingface.co", "https://zenodo.org",
                                "https://archive.softwareheritage.org"}


@pytest.mark.parametrize("row, why", [
    (repo(commit_id=""), "no_commit"),
    (repo(commit_id="HEAD"), "no_commit"),
    (repo(state="dead"), "dead"),
    (repo(repo="osf:abcde", host="osf.io", kind="archive"), "osf"),
    (repo(repo="supp:PMC1/code.py", host="supplementary", kind="supplementary"), "pmc"),
    (repo(repo="www.kaggle.com/x/y", host="www.kaggle.com", kind="execution"), "host"),
])
def test_a_repository_the_browser_cannot_fetch_says_why(row, why):
    assert catalog.source_of(row) == {"via": "", "why": why}


def test_an_odd_name_is_never_put_into_an_address():
    # A key with characters a forge never uses is fetched from Software Heritage, by digest only.
    assert catalog.source_of(repo(repo="github.com/la b/c?d"))["via"] == "swh"


def test_a_file_inside_a_zenodo_archive_comes_from_software_heritage():
    source = catalog.source_of(repo(repo="zenodo:9", host="zenodo.org", kind="archive"))
    assert catalog.file_via(source, "analysis.py", {"analysis.py", "data.csv"}) == ""
    assert catalog.file_via(source, "src/model.py", {"lab/code-v1.0.zip"}) == "swh"


# ---------------------------------------------------------------------------------------
# The export.

def _world(tmp_path: Path) -> sqlite3.Connection:
    con = db.open_db(tmp_path / "mac.db")
    con.execute("INSERT INTO article (id, doi, title, source, scanned_at, on_topic, updated_at) VALUES "
                "('doi:10.1/a', '10.1/a', 'A paper', 'test', 1, '', 1)")
    rows = [("github.com/lab/code", "https://github.com/Lab/Code", "github.com", "forge", "", "no", SHA),
            ("github.com/lab/open", "https://github.com/lab/open", "github.com", "forge", "MIT", "yes", SHA),
            ("osf:abcde", "https://osf.io/abcde", "osf.io", "archive", "", "unknown", "")]
    for r, url, host, kind, lic, red, commit in rows:
        con.execute("INSERT INTO repository (repo, url, host, kind, state, license, redistributable, commit_id) "
                    "VALUES (?,?,?,?, 'alive', ?,?,?)", (r, url, host, kind, lic, red, commit))
        con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES "
                    "('doi:10.1/a', ?, ?, ?, ?, 'code', 'high', 'text:availability')", (r, url, host, kind))
    files = [("github.com/lab/code", "run.py", "print('hi')  # me@lab.org\n", DIGEST, 30),
             ("github.com/lab/code", "big.py", "x = 1\n", "c" * 64, catalog.SOURCE_MAX_BYTES + 1),
             ("github.com/lab/code", "old.py", "y = 2\n", "", 6),
             ("github.com/lab/code", "fig.mlx", None, "d" * 64, 99),
             ("github.com/lab/open", "ok.py", "z = 3\n", "e" * 64, 6),
             ("github.com/lab/open", "LICENSE", MIT, "", len(MIT)),
             ("osf:abcde", "an.R", "a <- 1\n", "f" * 64, 7)]
    for r, path, text, digest, size in files:
        con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, digest, text, note) "
                    "VALUES (?,?,?, 'Python', 'script', ?, 1, ?, ?, ?)",
                    (r, path, SHA, size, digest, text, "" if text else "binary file: readable only at the source"))
    con.commit()
    return con


def _entry(lots: dict, key: str) -> dict:
    return lots[catalog.lot_of(key)][key]


def test_an_unlicensed_repository_is_shown_from_oscrs_own_copy(tmp_path):
    """Since 2026-09-29 the licence no longer gates DISPLAY: every file is shown from OSCR's own
    copy, its text keyed by its SHA-256 in a digest lot (`text_lot`). Email addresses are masked, a
    removal request still withholds, and `copyable` (False here) is kept only for the bulk outputs.
    A source is still exported, as a fallback for when a digest lot lacks a file."""
    con = _world(tmp_path)
    lots = catalog.script_lots(con, public=True)
    shown = _entry(lots, "github.com/lab/code")
    assert shown["published"] is True and shown["copyable"] is False and shown["redistributable"] == "no"
    assert shown["source"] == {"via": "github", "url": f"https://raw.githubusercontent.com/lab/code/{SHA}/{{path}}", "at": SHA}
    files = {f["path"]: f for f in shown["files"]}
    # run.py: shown from OSCR's copy, its email masked; its digest keys the text lot.
    assert files["run.py"]["text"] == "print('hi')  # [email hidden]\n"
    assert (files["run.py"]["sha256"], files["run.py"]["size"], files["run.py"]["lines"]) == (DIGEST, 30, 1)
    assert files["run.py"]["text_lot"] == f"{catalog.lot_of(DIGEST):02d}"
    assert "email addresses hidden" in files["run.py"]["note"] and "me@lab.org" not in json.dumps(lots)
    # big.py past SOURCE_MAX_BYTES is stored too, every file is shown.
    assert files["big.py"]["text"] == "x = 1\n" and files["big.py"]["sha256"] == "c" * 64
    # A binary file has no text; a file read before digests were kept keeps its text but no lot key.
    assert files["fig.mlx"]["text"] is None and "sha256" not in files["fig.mlx"]
    assert files["old.py"]["text"] == "y = 2\n" and "sha256" not in files["old.py"]
    # A verified, copyable repository: same text, and it leaves as a copy too.
    copied = _entry(lots, "github.com/lab/open")
    assert copied["published"] is True and copied["copyable"] is True
    assert {f["path"]: f["text"] for f in copied["files"]}["ok.py"] == "z = 3\n"
    # OSF: shown from OSCR's copy, with the fallback reason the browser cannot fetch it.
    osf = _entry(lots, "osf:abcde")
    assert osf["source"] == {"via": "", "why": "osf"}
    assert osf["files"][0]["sha256"] == "f" * 64 and osf["files"][0]["text"] == "a <- 1\n"


def test_what_a_removal_request_withheld_is_neither_listed_as_fetchable_nor_fetched(tmp_path):
    con = _world(tmp_path)
    jobs.withhold(con, "file", "doi:10.1/a", repo="github.com/lab/code", path="run.py", request="local:1")
    lots = catalog.script_lots(con, public=True)
    files = {f["path"]: f for f in _entry(lots, "github.com/lab/code")["files"]}
    assert "sha256" not in files["run.py"] and files["run.py"]["note"] == catalog.NOTE_WITHHELD
    assert files["big.py"]["sha256"] == "c" * 64
    jobs.withhold(con, "repository", "doi:10.1/a", repo="github.com/lab/code", request="local:2")
    entry = _entry(catalog.script_lots(con, public=True), "github.com/lab/code")
    assert "source" not in entry and not any("sha256" in f for f in entry["files"])
    assert {f["note"] for f in entry["files"]} == {catalog.NOTE_WITHHELD}
    # The whole record: nothing of it leaves.
    con.execute("UPDATE article SET withdrawn = 'x' WHERE id = 'doi:10.1/a'")
    con.commit()
    assert catalog.script_lots(con, public=True) == {}


def test_the_private_export_is_unchanged(tmp_path):
    con = _world(tmp_path)
    entry = _entry(catalog.script_lots(con, public=False), "github.com/lab/code")
    assert entry["published"] is True and "source" not in entry
    assert next(f for f in entry["files"] if f["path"] == "run.py")["text"].startswith("print")


def test_the_copy_filter_is_the_audited_one(tmp_path):
    """The licence audit's rule (CLAUDE.md, "Script copies"): showing from the source copies
    nothing, so what leaves the Mac as a copy is what the audited filter lets out
    (scriptstore.verified_license), unchanged. The Hugging Face blocks hold the licensed repository
    only, the public database no text of the others."""
    con = _world(tmp_path)
    assert [r["repo"] for r, _, _ in scriptstore._publishable(con)] == ["github.com/lab/open"]
    catalog.public_db(con, tmp_path / "public.db")
    pub = sqlite3.connect(tmp_path / "public.db")
    assert pub.execute("SELECT repo, path FROM file WHERE text IS NOT NULL ORDER BY path").fetchall() == [
        ("github.com/lab/open", "LICENSE"), ("github.com/lab/open", "ok.py")]


def test_a_license_its_repository_does_not_confirm_is_not_copied_in_bulk(tmp_path):
    """A license known from a README's sentence (recorded 'MIT', no license file): the site's reader
    still SHOWS it from OSCR's own copy (the licence no longer gates display), but it does not leave
    as a redistributable COPY, neither the public database nor the Hugging Face dataset, until its
    own license file confirms it (2026-09-29, `copyable`)."""
    con = _world(tmp_path)
    con.execute("UPDATE repository SET license = 'MIT', redistributable = 'yes' WHERE repo = 'github.com/lab/code'")
    con.commit()
    entry = _entry(catalog.script_lots(con, public=True), "github.com/lab/code")
    # Shown from OSCR's copy, but not copyable in bulk (no license file yet).
    assert entry["published"] is True and entry["copyable"] is False
    files = {f["path"]: f for f in entry["files"]}
    assert files["run.py"]["text"] == "print('hi')  # [email hidden]\n" and files["run.py"]["sha256"] == DIGEST
    assert "github.com/lab/code" not in {r["repo"] for r, _, _ in scriptstore._publishable(con)}
    catalog.public_db(con, tmp_path / "public.db")
    pub = sqlite3.connect(tmp_path / "public.db")
    assert pub.execute("SELECT COUNT(*) FROM file WHERE repo = 'github.com/lab/code' AND text IS NOT NULL").fetchone()[0] == 0
    assert pub.execute("SELECT note FROM file WHERE path = 'run.py'").fetchone()[0] == catalog.NOTE_UNVERIFIED
    # Its license file arrives: it becomes copyable, and leaves in bulk too.
    con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, digest, text) VALUES "
                "('github.com/lab/code', 'LICENSE', ?, 'License', 'doc', 80, 3, '', ?)", (SHA, MIT))
    con.commit()
    entry = _entry(catalog.script_lots(con, public=True), "github.com/lab/code")
    assert entry["published"] is True and entry["copyable"] is True
    assert "github.com/lab/code" in {r["repo"] for r, _, _ in scriptstore._publishable(con)}
    # The facts are there: digest, size, lines, the pinned version.
    assert pub.execute("SELECT digest, size, lines, version FROM file WHERE path = 'run.py'").fetchone() == (DIGEST, 30, 1, SHA)
