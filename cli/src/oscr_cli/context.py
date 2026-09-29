"""What every command receives: where to write, the settings, the network, the keychain, and which
repository it is about (``oscr help repository``)."""
from __future__ import annotations

import os
import shlex
import subprocess
import webbrowser
from argparse import Namespace
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import gitlocal
from .config import Config, Hosts
from .errors import UsageError
from .http import Http
from .output import IO
from .sanitize import clean_line

#: The remotes a repository is found by, in this order, when no default is set.
REMOTE_ORDER = ("upstream", "github", "origin")
DEFAULT_REPO_KEY = "oscr.default-repo"


@dataclass
class Context:
    io: IO
    config: Config
    env: Mapping[str, str]
    cwd: Path
    http: Http
    args: Namespace = field(default_factory=Namespace)
    keyring: Any = None
    _hosts: Hosts | None = None
    _clients: dict[str, Any] = field(default_factory=dict)

    @property
    def git(self) -> gitlocal.Git:
        """git with this run's environment (the person's configuration, or a test's own)."""
        return gitlocal.Git(self.env)

    @property
    def hosts(self) -> Hosts:
        if self._hosts is None:
            self._hosts = Hosts(self.config.dir)
        return self._hosts

    # ── the repository a command is about ──
    def repo(self, *, required: bool = True) -> gitlocal.RepoName | None:
        """``-R owner/name``, else ``$OSCR_REPO``, else the default set by ``oscr repo set-default``,
        else the git remotes (upstream, github, origin, then the others) that point to GitHub."""
        gh_host = self.config.github_host
        asked = getattr(self.args, "repo", None) or self.env.get("OSCR_REPO")
        if asked:
            r = gitlocal.parse_repo(asked, gh_host)
            if not r:
                raise UsageError(f"“{clean_line(asked)}” is not a repository: write owner/name.")
            return r
        top = self.git.toplevel(self.cwd)
        if top is not None:
            saved = self.git.config_get(top, DEFAULT_REPO_KEY)
            if saved:
                r = gitlocal.parse_repo(saved, gh_host)
                if r:
                    return r
            found = []
            for name, url in self.git.remotes(top):
                r = gitlocal.parse_repo(url, gh_host)
                if r and r.host == gh_host:
                    found.append((REMOTE_ORDER.index(name) if name in REMOTE_ORDER else len(REMOTE_ORDER), name, r))
            if found:
                found.sort(key=lambda x: x[0])
                return found[0][2]
        if required:
            raise UsageError("Which repository? Run this inside a clone of a GitHub repository, or add -R owner/name (or set OSCR_REPO).")
        return None

    # ── pages ──
    def browse(self, url: str) -> None:
        """Open a page in the person's browser, or print its address when there is none to open
        (``browser = none``, or no terminal)."""
        setting = self.config.get("browser")
        if setting == "none" or not self.io.out_tty:
            self.io.print(url)
            return
        self.io.say(f"Opening {url} in your browser.")
        if setting:
            # The person's own configured command (their browser), never anything read from the network.
            subprocess.run([*shlex.split(setting), url], check=False)
        elif not webbrowser.open(url):
            self.io.print(url)

    def site_url(self, path: str = "/") -> str:
        return self.config.base_url() + path


def default_env() -> Mapping[str, str]:
    return os.environ
