"""The distribution (D14-12): its metadata, its version in one place, its files; the standard library
only; the build is hatchling's (offline from the local cache: docs/CLI.md "Publishing")."""
from __future__ import annotations

import re
from pathlib import Path

import oscr_cli
from oscr_cli import site

CLI = Path(__file__).resolve().parents[1]


def test_the_metadata_and_the_version():
    text = (CLI / "pyproject.toml").read_text()
    assert re.search(r'^version = "([^"]+)"', text, re.M).group(1) == oscr_cli.__version__
    assert 'name = "openscicode"' in text and "dependencies = []" in text
    assert 'oscr = "oscr_cli.main:main"' in text and 'packages = ["src/oscr_cli"]' in text
    assert 'requires-python = ">=3.10"' in text
    assert (CLI / "README.md").read_text().startswith("# oscr") and (CLI / "LICENSE").is_file()


def test_the_platforms_name_and_host_live_in_one_place():
    src = CLI / "src" / "oscr_cli"
    for f in src.rglob("*.py"):
        if f.name == "site.py":
            continue
        text = f.read_text()
        assert "yannbellec-b.workers.dev" not in text, f.name
        assert "Open Scientific Code Registry" not in text or f.name == "__init__.py", f.name
    assert site.SITE_NAME and site.DEFAULT_HOST


def test_the_standard_library_only():
    import sys

    allowed = set(sys.stdlib_module_names) | {"oscr_cli"}
    for f in (CLI / "src" / "oscr_cli").rglob("*.py"):
        for m in re.finditer(r"^(?:from|import) ([A-Za-z_][A-Za-z0-9_]*)", f.read_text(), re.M):
            assert m.group(1) in allowed or m.group(1) == "__future__", f"{f.name}: {m.group(1)}"
