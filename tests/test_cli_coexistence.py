"""Two commands named `oscr` (night phase 14, DECISIONS.md D14-1): the harvester's, which the Mac's launchd
jobs run as `.venv/bin/python -m oscr`, stays exactly as it is; the researchers' is a distribution of its
own in cli/, with its own import package, never installed into the harvester's environment."""
from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_the_harvesters_entry_points_are_unchanged():
    root = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert root["project"]["name"] == "oscr"
    assert root["project"]["scripts"] == {"oscr": "oscr.cli:main"}
    assert root["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == ["oscr"]
    assert root["tool"]["pytest"]["ini_options"]["testpaths"] == ["tests"]
    assert "workspace" not in root.get("tool", {}).get("uv", {})  # cli/ is not a member: `uv sync` never installs it
    for plist in ("org.oscr.harvester.plist", "org.oscr.nightly.plist", "org.oscr.jobs.plist", "org.oscr.dashboard.plist"):
        text = (ROOT / "tools" / plist).read_text()
        assert "<string>@ROOT@/.venv/bin/python</string>\n    <string>-m</string>\n    <string>oscr</string>" in text, plist


def test_the_researchers_tool_is_a_distribution_of_its_own():
    cli = tomllib.loads((ROOT / "cli" / "pyproject.toml").read_text())
    assert cli["project"]["name"] != "oscr"
    assert cli["project"]["scripts"] == {"oscr": "oscr_cli.main:main"}
    assert cli["project"]["dependencies"] == []  # the standard library only
    assert cli["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == ["src/oscr_cli"]
    packages = sorted(p.name for p in (ROOT / "cli" / "src").iterdir() if p.is_dir() and not p.name.startswith((".", "_")))
    assert packages == ["oscr_cli"]
    assert not (ROOT / "cli" / "src" / "oscr").exists()


def test_the_harvester_says_where_a_researchers_command_lives():
    p = subprocess.run([sys.executable, "-m", "oscr", "auth", "login"], cwd=ROOT, capture_output=True, text=True, check=False)
    assert p.returncode == 2
    assert "researchers' `oscr`" in p.stderr and "oscr_cli" in p.stderr
    p = subprocess.run([sys.executable, "-m", "oscr", "forge", "bogus"], cwd=ROOT, capture_output=True, text=True, check=False)
    assert p.returncode == 2 and "researchers'" not in p.stderr


def test_the_harvesters_import_is_the_harvester():
    import oscr
    import oscr.cli

    assert Path(oscr.__file__).resolve().parent == ROOT / "oscr"
    assert callable(oscr.cli.main)
