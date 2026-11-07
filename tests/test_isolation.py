"""No test writes the Mac's real data/: each runs in its own working directory (tests/conftest.py),
so a relative path the code writes, like nightly's Path("data/outreach"), lands there."""
from pathlib import Path

import conftest


def test_a_test_runs_outside_the_repository():
    assert not Path.cwd().resolve().is_relative_to(conftest.ROOT)


def test_a_relative_write_lands_in_the_tests_own_folder():
    target = Path("data/outreach/mixnmatch.tsv")
    target.parent.mkdir(parents=True)
    target.write_text("id\tname\tdesc\n")
    assert target.resolve().is_relative_to(Path.cwd().resolve())
    assert not target.resolve().is_relative_to(conftest.ROOT)
