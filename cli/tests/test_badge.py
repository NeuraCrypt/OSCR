"""`oscr badge`: the same addresses and snippets as the site (website/src/lib/badge.ts), and the
README written between two marks, replaced and never added twice; nothing run, nothing sent."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fakes import FakeGitHub, FakeOscr

from oscr_cli import badge, keyring, trace


@pytest.fixture
def site(run):
    os_, gh = FakeOscr(), FakeGitHub()
    run.env.update({"OSCR_HOST": os_.host, "OSCR_GITHUB_WEB": "https://github.com", "OSCR_GITHUB_API": gh.api})
    run.keyring = keyring.MemoryKeyring()
    yield os_, gh
    os_.close()
    gh.close()


def test_addresses_as_the_site_writes_them():
    u = badge.urls("https://openscicode.org/", doi="10.1234/a#b c")
    assert u == {"image": "https://openscicode.org/badge/doi/10.1234/a%23b%20c.svg", "link": "https://openscicode.org/badge/doi/10.1234/a%23b%20c"}
    u = badge.urls("https://openscicode.org", repo="GitHub.com/Lab/EEG", style="large", show="doi")
    assert u["image"] == "https://openscicode.org/badge/repo/github.com/lab/eeg.svg?style=large&show=doi"
    # A DOI that ends as a suffix would: in the query.
    assert badge.urls("https://x.org", doi="10.1/fig.svg")["image"] == "https://x.org/badge/doi.svg?doi=10.1%2Ffig.svg"
    assert badge.snippet("markdown", "I", "L", "OSCR") == "[![OSCR](I)](L)"
    assert badge.snippet("rst", "I", "L", "OSCR") == ".. image:: I\n   :target: L\n   :alt: OSCR"
    assert badge.snippet("html", "I?a&b", "L", "OSCR") == '<a href="L"><img src="I?a&amp;b" alt="OSCR"></a>'


@pytest.mark.parametrize(("fmt", "readme", "after_title"), [
    ("markdown", "# Title\n\nBody.\n", "# Title"),
    ("markdown", "---\nlicense: mit\n---\n\n# Model\n\nBody.\n", "# Model"),
    ("markdown", "Title\n=====\n\nBody.\n", "====="),
    ("rst", "=====\nTitle\n=====\n\nBody.\n", "====="),
    ("asciidoc", "= Title\nAda Lovelace\n\nBody.\n", "Ada Lovelace"),
    ("org", "#+TITLE: T\n* Heading\nBody.\n", "* Heading"),
])
def test_insert_goes_under_the_title_and_is_idempotent(fmt, readme, after_title):
    text = badge.snippet(fmt, "https://x.org/i.svg", "https://x.org/l", "OSCR")
    once = badge.insert(readme, fmt, text)
    start, end = badge.MARKS[fmt]
    lines = once.split("\n")
    assert lines[lines.index(start) - 2] == after_title
    assert badge.insert(once, fmt, text) == once
    newer = badge.insert(once, fmt, text.replace("i.svg", "j.svg"))
    assert newer.count(start) == 1 and "j.svg" in newer and "i.svg" not in newer
    assert "Body." in badge.remove(once, fmt) and start not in badge.remove(once, fmt)
    if fmt == "markdown" and readme.startswith("---"):
        assert once.startswith("---\nlicense: mit\n---")  # never inside a card's YAML


def test_oscr_badge_writes_the_papers_badge_into_the_readme(run, clone, site):
    os_, _ = site
    shard = trace.shard_of("oscr-fixture", "eeg-analysis")
    os_.files[f"/forge/layer/{shard}.json"] = {"oscr-fixture/eeg-analysis": {"mode": "installed", "papers": [{"doi": "10.5555/oscr.fixture.1", "slug": "p"}]}}
    r = run("badge", cwd=clone)
    assert r.code == 0, r.err
    assert r.out.strip() == f"[![OSCR](http://{os_.host}/badge/doi/10.5555/oscr.fixture.1.svg)](http://{os_.host}/badge/doi/10.5555/oscr.fixture.1)"
    assert run("badge", "--write", cwd=clone).code == 0
    text = (clone / "README.md").read_text()
    assert text.startswith("# eeg-analysis\n\n<!-- oscr-badge:start -->\n[![OSCR]") and "## Installation" in text
    r = run("badge", "--write", "--json", "written,readme", cwd=clone)
    assert json.loads(r.out) == {"written": False, "readme": "README.md"}
    r = run("badge", "--repo-badge", "--write", "--style", "large", cwd=clone)
    text = (clone / "README.md").read_text()
    assert text.count("oscr-badge:start") == 1 and "/badge/repo/github.com/oscr-fixture/eeg-analysis.svg?style=large" in text
    assert run("badge", "--remove", cwd=clone).code == 0
    assert "oscr-badge" not in (clone / "README.md").read_text()


def test_oscr_badge_with_a_doi_and_no_paper_known(run, clone, site):
    r = run("badge", "doi:10.1234/ABCD", "--format", "rst", cwd=clone)
    assert r.code == 0 and r.out.startswith(".. image:: ") and "/badge/doi/10.1234/abcd.svg" in r.out
    r = run("badge", "--offline", cwd=clone)
    assert "/badge/repo/github.com/oscr-fixture/eeg-analysis" in r.out and "links no paper" in r.err
    assert run("badge", "not-a-doi", cwd=clone).code == 2
    outside = Path(str(clone) + "-x")
    assert run("badge", "--write", "--readme", "../x.md", cwd=clone).code == 2
    assert not outside.exists()
