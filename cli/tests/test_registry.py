"""The registry's own commands: the checks and citations the site's TypeScript answers (one file of cases,
two implementations), permalinks and shards read as the site and the Mac read them, `oscr check`,
`oscr cite`, `oscr trace`, `oscr paper link`; files read as text, never run."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from conftest import git
from fakes import FakeGitHub, FakeOscr

from oscr_cli import checks, citation, keyring, trace
from oscr_cli.sanitize import mask_emails

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


# ── one reading on both sides ──


def test_checks_and_citations_answer_as_the_site():
    cases = json.loads((FIXTURES / "checks-cases.json").read_text())
    for c in cases["checks"]:
        assert checks.run_checks(c["input"]).as_json() == c["expected"], c["name"]
    for e in cases["environments"]:
        assert checks.environment_files(e["paths"]) == e["expected"]
    for c in cases["citations"]:
        cit = citation.citation_of_cff(c["text"]) if c["kind"] == "cff" else citation.citation_of_codemeta(c["text"])
        if c["expected"] is None:
            assert cit is None, c["name"]
            continue
        assert cit is not None, c["name"]
        assert cit.as_json() == c["expected"]["citation"], c["name"]
        assert citation.apa(cit.work) == c["expected"]["apa"], c["name"]
        assert citation.bibtex(cit.work) == c["expected"]["bibtex"], c["name"]
        assert citation.apa(cit.software) == c["expected"]["softwareApa"], c["name"]
        assert citation.bibtex(cit.software) == c["expected"]["softwareBibtex"], c["name"]
    said = json.dumps([c["expected"] for c in cases["citations"] if c["expected"]])
    assert mask_emails(said) == said and "example.org" not in said  # no address in any answer


def test_permalinks_as_the_site_and_the_mac_read_them():
    data = json.loads((FIXTURES / "permalinks.json").read_text())
    for c in data["cases"]:
        p = trace.parse_permalink(c["url"], web=data["web"], sites=tuple(data["sites"]))
        want = c["point"]
        if want is None:
            assert p is None, c["url"]
        else:
            assert p is not None, c["url"]
            assert (p.owner, p.name, p.commit, p.path) == (want["owner"], want["name"], want["commit"], want["path"]), c["url"]
            assert (None if p.lines is None else {"start": p.lines[0], "end": p.lines[1]}) == want["lines"], c["url"]


def test_shards_as_the_site_and_the_mac_compute_them():
    for key, shard in json.loads((FIXTURES / "forge-shards.json").read_text())["pairs"]:
        owner, name = key.split("/")
        assert trace.shard_of(owner, name) == shard, key


def test_lines_found_again_the_sites_way():
    old = ["a", "def f(x):", "    return x", "b"]
    assert trace.relocate(old, old, 2, 3) == (2, 3)
    assert trace.relocate(old, ["new", "", "def f(x):", "    return x"], 2, 3) == (3, 4)
    assert trace.relocate(old, ["def f(y):", "    return y"], 2, 3) is None
    assert trace.relocate(["", ""], ["", ""], 1, 2) is None
    assert trace.locate_by_symbol(["x", "def f(y):", "  pass"], 5, 6, "f") == (2, 3)
    assert trace.locate_by_symbol(["f <- function(a) {"], 1, 1, "f") == (1, 1)
    assert trace.locate_by_symbol(["nothing"], 1, 1, "f") is None
    assert trace.symbol_of(["", "def band_power(x):"]) == "band_power"


# ── the commands ──


@pytest.fixture
def site(run):
    os_, gh = FakeOscr(), FakeGitHub()
    run.env.update({"OSCR_HOST": os_.host, "OSCR_GITHUB_WEB": "https://github.com", "OSCR_GITHUB_API": gh.api})
    run.keyring = keyring.MemoryKeyring()
    yield os_, gh
    os_.close()
    gh.close()


def _repo_files(clone: Path) -> None:
    (clone / "CITATION.cff").write_text(
        "cff-version: 1.2.0\nmessage: cite the paper\ntitle: eeg-analysis\nauthors:\n  - family-names: Lovelace\n    given-names: Ada\n"
        "preferred-citation:\n  type: article\n  title: A synthetic EEG study\n  journal: eLife\n  year: '2026'\n  doi: 10.5555/oscr.fixture.1\n"
        "  authors:\n    - family-names: Lovelace\n      given-names: Ada\n")
    git(clone, "add", "-A")
    git(clone, "commit", "-q", "-m", "Cite")


def test_check_offline_and_a_change_that_breaks_traceability(run, clone):
    _repo_files(clone)
    r = run("check", "--offline", cwd=clone)
    assert r.code == 0, r.err
    assert "All 7 checks passed" in r.out or "passed" in r.out
    assert "nothing was run" in r.err
    base = git(clone, "rev-parse", "HEAD").strip()
    git(clone, "rm", "-q", "LICENSE")
    git(clone, "commit", "-q", "-m", "Drop the licence")
    r = run("check", "--offline", "--base", base, cwd=clone)
    assert r.code == 3
    assert "deletes the licence file LICENSE" in r.out
    r = run("check", "--offline", "--json", "conclusion,commit", cwd=clone)
    data = json.loads(r.out)
    assert data["conclusion"] == "neutral" and len(data["commit"]) == 40
    r = run("check", "--offline", "--json", "conclusion", "--jq", ".conclusion", "--base", base, cwd=clone)
    assert r.code == 3 and r.out.strip() == "failure"


def test_check_reads_the_registrys_layer_and_maps(run, clone, site):
    os_, _ = site
    _repo_files(clone)
    shard = trace.shard_of("oscr-fixture", "eeg-analysis")
    head = git(clone, "rev-parse", "HEAD").strip()
    os_.files[f"/forge/layer/{shard}.json"] = {"oscr-fixture/eeg-analysis": {"mode": "public", "papers": [{"doi": "10.5555/oscr.fixture.1", "status": "linked", "slug": "x", "title": "T"}]}}
    os_.files[f"/forge/traced/{shard}.json"] = {"oscr-fixture/eeg-analysis": [{"paper": "x", "title": "T", "doi": "10.5555/oscr.fixture.1", "commit": head, "validated": False, "mapDoi": None,
                                                                            "pairs": [{"pair": 1, "path": "analysis/gone.py", "start": 1, "end": 2, "section": "M", "paragraph": 3, "symbol": ""}]}]}
    r = run("check", cwd=clone)
    assert r.code == 0, r.err
    assert "Linked in the registry to its paper: 10.5555/oscr.fixture.1" in r.out
    assert "no longer has: analysis/gone.py" in r.out
    assert "last night's layer" in r.err
    # Signed in: the live layer, with the token (repos:read), never a GitHub token.
    t = os_.make_token("ada-fixture")
    os_.repos["oscr-fixture/eeg-analysis"] = {"papers": [{"doi": "10.1/live"}]}
    r = run("check", cwd=clone, env={"OSCR_TOKEN": t})
    assert "10.1/live" in r.out and "the registry, now" in r.err
    assert all((e["auth"] or "").endswith(t) for e in os_.log if e["path"] == "/api/v1/repos")


def test_the_repository_is_read_never_run(run, clone):
    marker = clone.parent / "ran.txt"
    (clone / "setup.py").write_text(f"open({str(marker)!r}, 'w').write('ran')\n")
    (clone / "Makefile").write_text(f"all:\n\ttouch {marker}\n")
    (clone / "conftest.py").write_text(f"open({str(marker)!r}, 'w').write('ran')\n")
    git(clone, "add", "-A")
    git(clone, "commit", "-q", "-m", "Scripts")
    hook = clone / ".git" / "hooks" / "post-checkout"
    hook.write_text(f"#!/bin/sh\ntouch {marker}\n")
    hook.chmod(0o755)
    for argv in (("check", "--offline"), ("cite",), ("trace", "propose", "10.1234/x", "setup.py:1"), ("trace", "check", "--file", str(clone / "none.json"))):
        run(*argv, cwd=clone)
    assert not marker.exists()


def test_no_module_of_the_tool_runs_code_it_reads():
    src = (ROOT / "cli" / "src" / "oscr_cli")
    for f in src.rglob("*.py"):
        text = f.read_text()
        for bad in ("runpy", "importlib", "os.system", "os.popen", "shell=True", "pickle", "marshal"):
            assert bad not in text, f"{f.name}: {bad}"
        assert not re.search(r"(?<![.\w])(eval|exec|compile|__import__)\(", text), f.name
        for m in re.finditer(r"subprocess\.run\(\[([^\]]*)", text):
            # git; the keychain's own programs; and the person's own browser and editor, from their settings.
            assert m.group(1).split(",")[0].strip() in ('"git"', '"security"', "self.program", "*shlex.split(setting)", "*shlex.split(cmd)"), f"{f.name}: {m.group(0)}"


def test_cite(run, clone, site):
    _, gh = site
    _repo_files(clone)
    r = run("cite", cwd=clone)
    assert r.code == 0
    assert "Lovelace, A. (2026). A synthetic EEG study. eLife. https://doi.org/10.5555/oscr.fixture.1" in r.out
    assert "@article{Lovelace_A_2026," in r.out
    assert "cites the paper" in r.err
    r = run("cite", "--software", "--format", "apa", cwd=clone)
    assert r.out.strip() == "Lovelace, A. (n.d.). eeg-analysis [Computer software]."
    r = run("cite", "--software", "--doi", "doi:10.5281/ZENODO.42", "--format", "bibtex", cwd=clone)
    assert "doi = {10.5281/zenodo.42}" in r.out and r.out.startswith("@software{")
    r = run("cite", "--swhid", "--json", "swhid", cwd=clone)
    head = git(clone, "rev-parse", "HEAD").strip()
    assert json.loads(r.out)["swhid"]["revision"] == f"swh:1:rev:{head};origin=https://github.com/oscr-fixture/eeg-analysis"
    gh.on("GET", "/api/repos/oscr-fixture/eeg-analysis/releases/tags/v1.2.0", lambda req: (200, {"tag_name": "v1.2.0", "body": "[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.777.svg)](https://doi.org/10.5281/zenodo.777)"}), first=True)
    r = run("cite", "--release", "v1.2.0", "--format", "apa", cwd=clone)
    assert r.code == 0, r.err
    assert r.out.strip() == "Lovelace, A. (n.d.). eeg-analysis (Version 1.2.0) [Computer software]. https://doi.org/10.5281/zenodo.777"
    (clone / "codemeta.json").write_text(json.dumps({"name": "tool", "author": [{"givenName": "Ada", "familyName": "Lovelace", "email": "ada@example.org"}]}))
    r = run("cite", "--file", str(clone / "codemeta.json"), "--format", "apa")
    assert r.out.strip() == "Lovelace, A. (n.d.). tool [Computer software]." and "@" not in r.out
    (clone / "CITATION.cff").write_text("title: nobody\n")
    (clone / "codemeta.json").unlink()
    r = run("cite", cwd=clone)
    assert r.code == 1 and "No usable CITATION.cff" in r.err


def test_trace_propose_then_check_at_later_commits(run, clone):
    r = run("trace", "propose", "doi:10.5555/OSCR.fixture.1", "analysis/preprocess.py:4-5=3", "README.md#L1=1", "--section", "Methods › Filtering", "--write", cwd=clone)
    assert r.code == 0, r.err
    f = clone / ".oscr" / "maps" / "10.5555_oscr.fixture.1.json"
    m = json.loads(f.read_text())
    head = git(clone, "rev-parse", "HEAD").strip()
    assert m["commit"] == head and m["paper"]["doi"] == "10.5555/oscr.fixture.1"
    assert m["pairs"][0] == {"pair": 1, "path": "analysis/preprocess.py", "start": 4, "end": 5, "section": "Methods › Filtering", "paragraph": 3, "symbol": "bandpass",
                             "permalink": f"https://github.com/oscr-fixture/eeg-analysis/blob/{head}/analysis/preprocess.py#L4-L5",
                             "registry": f"https://oscr.yannbellec-b.workers.dev/r/oscr-fixture/eeg-analysis/blob/{head}/analysis/preprocess.py#L4-L5"}
    assert "on no remote branch" in r.err
    # Moved: two lines added above.
    p = clone / "analysis" / "preprocess.py"
    p.write_text("# a comment\n# another\n" + p.read_text())
    git(clone, "commit", "-q", "-am", "Comments")
    r = run("trace", "check", "--file", str(f), cwd=clone)
    assert r.code == 0, r.out + r.err
    assert "moved to 6–7" in r.out
    # Gone: the file deleted.
    git(clone, "rm", "-q", "analysis/preprocess.py")
    git(clone, "commit", "-q", "-m", "Remove")
    r = run("trace", "check", "--file", str(f), "--json", "failures", cwd=clone)
    assert r.code == 3 and json.loads(r.out)[0]["failures"] == 1
    # At its own commit, the same.
    r = run("trace", "check", "--file", str(f), "--commit", head, cwd=clone)
    assert r.code == 0 and "at the map's own commit" in r.out


def test_trace_propose_refuses_in_words(run, clone):
    head = git(clone, "rev-parse", "HEAD").strip()
    for loc, words in (("analysis/preprocess.py:40-50", "past its end"), ("nope.py:1", "not in commit"), ("../x.py:1", "not a path"), ("a file", "not a place"),
                       (f"https://github.com/other/repo/blob/{head}/a.py#L1", "not in oscr-fixture/eeg-analysis"),
                       ("https://github.com/oscr-fixture/eeg-analysis/blob/main/a.py#L1", "not a place"),
                       (f"https://github.com/oscr-fixture/eeg-analysis/blob/{'0' * 40}/a.py#L1", "Every link of a map is at one commit")):
        r = run("trace", "propose", "10.1234/x", loc, cwd=clone)
        assert r.code == 2 and words in r.err, (loc, r.err)
    assert run("trace", "propose", "not-a-doi", "README.md:1", cwd=clone).code == 2


def test_trace_list_and_check_the_registrys_maps(run, clone, site):
    os_, _ = site
    head = git(clone, "rev-parse", "HEAD").strip()
    shard = trace.shard_of("oscr-fixture", "eeg-analysis")
    os_.files[f"/forge/traced/{shard}.json"] = {"oscr-fixture/eeg-analysis": [
        {"paper": "x", "title": "A synthetic EEG study\x1b[2J", "doi": "10.5555/oscr.fixture.1", "commit": head, "validated": True, "mapDoi": "10.5281/zenodo.9",
         "pairs": [{"pair": 1, "path": "analysis/preprocess.py", "start": 4, "end": 5, "section": "Methods", "paragraph": 3, "symbol": "bandpass"}]}]}
    r = run("trace", "list", cwd=clone)
    assert "validated, map DOI 10.5281/zenodo.9" in r.out and "\x1b" not in r.out and "^[[2J" in r.out
    r = run("trace", "check", "--paper", "10.5555/oscr.fixture.1", cwd=clone)
    assert r.code == 0 and "same" in r.out
    assert "nothing to check" in run("trace", "check", "--paper", "10.1234/other", cwd=clone).err


def test_paper_link_opens_the_sites_own_write_path(run, clone, site):
    os_, _ = site
    r = run("paper", "link", "https://doi.org/10.5555/OSCR.fixture.1", "--no-browser", cwd=clone)
    assert r.code == 0, r.err
    assert r.out.strip() == f"http://{os_.host}/new/link/?repo=oscr-fixture/eeg-analysis&paper=10.5555/oscr.fixture.1"
    assert "authorize this one action" in r.err
    shard = trace.shard_of("oscr-fixture", "eeg-analysis")
    os_.files[f"/forge/layer/{shard}.json"] = {"oscr-fixture/eeg-analysis": {"mode": "installed", "papers": []}}
    r = run("paper", "link", "10.1234/abcd", cwd=clone)
    assert r.out.strip() == f"http://{os_.host}/r/oscr-fixture/eeg-analysis/settings/?paper=10.1234/abcd"
    os_.files[f"/forge/layer/{shard}.json"] = {"oscr-fixture/eeg-analysis": {"mode": "installed", "papers": [{"doi": "10.1234/abcd", "status": "linked", "slug": "p"}]}}
    r = run("paper", "link", "10.1234/ABCD", cwd=clone)
    assert "linked to 10.1234/abcd already" in r.err
    r = run("paper", "list", "--json", "doi,status,page", cwd=clone)
    assert json.loads(r.out) == [{"doi": "10.1234/abcd", "status": "linked", "page": f"http://{os_.host}/paper/p/"}]
    assert run("paper", "link", "10.1234/x", "-R", "gitlab.com/a/b").code == 2
