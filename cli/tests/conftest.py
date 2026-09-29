"""The tool's tests: every run in a throwaway configuration folder, with a fake keychain, and never a
network address outside this machine (the fakes in fakes.py listen on 127.0.0.1). Git runs on fixture
repositories made here, hooks off."""
from __future__ import annotations

import io
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from oscr_cli import main as entry


@dataclass
class Result:
    code: int
    out: str
    err: str


class Runner:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.config = tmp / "config"
        self.home = tmp / "home"
        self.home.mkdir(exist_ok=True)
        self.env: dict[str, str] = {
            "OSCR_CONFIG_DIR": str(self.config),
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", ""),
            "OSCR_BROWSER": "none",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": str(tmp / "gitconfig"),
            "GIT_AUTHOR_NAME": "Test",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@invalid",
            "GIT_COMMITTER_EMAIL": "test@invalid",
            "LANG": "C.UTF-8",
        }
        self.keyring: Any = None
        self.opener: Any = None

    def __call__(self, *argv: str, cwd: Path | None = None, stdin: str = "", env: dict[str, str] | None = None, tty: bool = False) -> Result:
        out, err = io.StringIO(), io.StringIO()
        e = dict(self.env)
        if tty:
            e["OSCR_FORCE_TTY"] = "1"
        e.update(env or {})
        code = entry.main(list(argv), env=e, stdout=out, stderr=err, stdin=io.StringIO(stdin), cwd=cwd or self.tmp,
                          opener=self.opener, keyring=self.keyring)
        return Result(code, out.getvalue(), err.getvalue())


@pytest.fixture
def run(tmp_path: Path) -> Runner:
    return Runner(tmp_path)


def git(cwd: Path, *args: str, env: dict[str, str] | None = None) -> str:
    e = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Test", "GIT_COMMITTER_NAME": "Test",
         "GIT_AUTHOR_EMAIL": "test@invalid", "GIT_COMMITTER_EMAIL": "test@invalid", **(env or {})}
    return subprocess.run(["git", "-c", f"core.hooksPath={os.devnull}", *args], cwd=cwd, env=e, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    """A fixture repository: a README, a licence, CITATION.cff, a script; remotes to GitHub."""
    d = tmp_path / "work"
    d.mkdir()
    git(d, "init", "-q", "-b", "main")
    (d / "README.md").write_text("# eeg-analysis\n\nThe code of doi:10.5555/oscr.fixture.1.\n\n## Installation\n\npip install -r requirements.txt\n")
    (d / "LICENSE").write_text("MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n")
    (d / "requirements.txt").write_text("numpy==1.26.4\nscipy==1.13.0\n")
    (d / "analysis").mkdir()
    (d / "analysis" / "preprocess.py").write_text("import numpy as np\n\n\ndef bandpass(x, lo, hi):\n    return x\n")
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", "First")
    git(d, "remote", "add", "origin", "https://github.com/oscr-fixture/eeg-analysis.git")
    return d
