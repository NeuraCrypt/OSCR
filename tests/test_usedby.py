"""The "Used by" computation and its statements (night phase 12, E3; oscr/usedby.py)."""
from __future__ import annotations

from oscr import usedby
from oscr.usedby import Paper, Repo


def test_norm_folds_pypi_separators_and_case():
    assert usedby.norm("PyPI", "NumPy") == "PyPI:numpy"
    assert usedby.norm("PyPI", "scikit_learn") == "PyPI:scikit-learn"
    assert usedby.norm("conda", "foo.bar") == "conda:foo-bar"
    # npm matches on the plain lower-case name (no separator folding).
    assert usedby.norm("npm", "my_pkg") == "npm:my_pkg"


def _fixture():
    repos = {
        "1": Repo("github", "1", "ada", "toolkit"),     # publishes PyPI:toolkit
        "2": Repo("github", "2", "bob", "study"),        # depends on toolkit, has a paper
        "3": Repo("github", "3", "cat", "other"),        # depends on toolkit, no paper
    }
    packages = [("1", "pypi", "toolkit")]
    deps = [
        ("2", "PyPI", "Toolkit"),     # case-insensitive match
        ("3", "PyPI", "toolkit"),
        ("1", "PyPI", "numpy"),       # the publisher's own deps, irrelevant
    ]
    papers = {"2": [Paper("doi:10.1/x", "x-slug", "A study")]}
    return repos, packages, deps, papers


def test_used_by_counts_papers_and_repos_excluding_self():
    repos, packages, deps, papers = _fixture()
    usage = usedby.used_by(repos, packages, deps, papers)
    assert set(usage) == {"1"}
    u = usage["1"]
    assert set(u.repos) == {"2", "3"}        # two repositories depend on the toolkit
    assert set(u.papers) == {"doi:10.1/x"}   # one paper uses it (the research angle)
    assert u.via["repo:2"] == "PyPI:toolkit"
    assert u.via["paper:doi:10.1/x"] == "PyPI:toolkit"


def test_a_repository_never_uses_itself():
    repos = {"1": Repo("github", "1", "ada", "toolkit")}
    usage = usedby.used_by(repos, [("1", "pypi", "toolkit")], [("1", "PyPI", "toolkit")], {})
    assert usage == {}


def test_stats_statements_carry_counts_and_a_bounded_star_series():
    stars = [(day, n) for n, day in enumerate(range(0, usedby.STAR_POINTS + 10), start=1)]
    out = usedby.stats_statements("github", "1", 3, 5, stars, now=100)
    assert len(out) == 1 and out[0].startswith("INSERT OR REPLACE INTO repo_stats")
    body = out[0]
    assert "3" in body and "5" in body
    # The series is bounded to STAR_POINTS points: each inner [day, total] pair opens one '['.
    inner_points = body.count("[") - 1
    assert inner_points == usedby.STAR_POINTS


def test_dependents_statements_put_papers_before_repos_and_cap_the_sample():
    repos, packages, deps, papers = _fixture()
    usage = usedby.used_by(repos, packages, deps, papers)
    out = usedby.dependents_statements("github", "1", usage["1"], now=1, sample=100)
    assert out[0].startswith("DELETE FROM repo_dependents")
    inserts = [s for s in out if s.startswith("INSERT")]
    assert "'paper'" in inserts[0]          # the paper dependant is written first
    assert any("'repo'" in s for s in inserts)
    capped = usedby.dependents_statements("github", "1", usage["1"], now=1, sample=1)
    assert len([s for s in capped if s.startswith("INSERT")]) == 1


def test_marks_statements_replace_and_insert():
    out = usedby.marks_statements("github", "1", [("paper", "doi:10.1/x", 1700, "A study (doi:10.1/x)")], now=9)
    assert out[0].startswith("DELETE FROM repo_marks")
    assert out[1].startswith("INSERT INTO repo_marks")
    assert "1700" in out[1]


def test_star_history_is_cumulative_per_day():
    rows = [
        ("repo:github:1", 10),
        ("repo:github:1", 100_000),       # a later day
        ("repo:github:1", 100_010),       # same day as the previous
        ("paper:doi:10.1/x", 5),          # not a repository: ignored
    ]
    hist = usedby.star_history(rows)
    assert "1" in hist
    series = hist["1"]
    assert series[-1][1] == 3             # three stars total by the last day
    assert len(series) == 2               # two distinct days
