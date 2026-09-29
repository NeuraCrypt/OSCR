"""Git on the person's own machine, run as a subprocess (D14-1; docs/CLI.md "Safety").

- Every call passes ``-c core.hooksPath=<the null device>``: no hook of a repository ever runs (a
  cloned tree's own hooks are not cloned by git, and a person's templates are not asked either).
- Nothing read from a repository is ever executed by this tool: files are read as text
  (``git show``, ``git ls-files``, ``git ls-tree``), never imported, built or run.
- ``GIT_TERMINAL_PROMPT=0`` for the calls that reach the network from the tool (clone, fetch): a
  missing credential is said, never asked in the middle of a command's output.
- The person's own git configuration (their name, their commit address) is theirs: this module never
  reads nor writes ``user.email``.
"""
from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .errors import CliError

NULL_HOOKS = ["-c", f"core.hooksPath={os.devnull}"]


class GitError(CliError):
    pass


class Git:
    """git, run with the context's environment (never another's): the person's own configuration, or a
    test's throwaway one (GIT_CONFIG_GLOBAL)."""

    def __init__(self, env: Mapping[str, str]):
        self.env = dict(env)

    def run(self, args: Sequence[str], *, cwd: Path | str | None = None, check: bool = True, input: str | None = None, network: bool = False) -> subprocess.CompletedProcess[str]:
        """``git -c core.hooksPath=/dev/null <args>``, its output captured as text."""
        e = dict(self.env)
        if network:
            e["GIT_TERMINAL_PROMPT"] = "0"
        try:
            p = subprocess.run(["git", *NULL_HOOKS, *args], cwd=cwd, env=e, capture_output=True, text=True, input=input, check=False)
        except FileNotFoundError as err:
            raise GitError("git is not installed, or not on PATH: install it first (https://git-scm.com).") from err
        if check and p.returncode != 0:
            words = (p.stderr or p.stdout).strip().splitlines()
            raise GitError(f"git {args[0]} failed: {words[-1] if words else 'exit ' + str(p.returncode)}")
        return p

    def toplevel(self, cwd: Path) -> Path | None:
        p = self.run(["rev-parse", "--show-toplevel"], cwd=cwd, check=False)
        return Path(p.stdout.strip()) if p.returncode == 0 and p.stdout.strip() else None

    def remotes(self, cwd: Path) -> list[tuple[str, str]]:
        """The repository's remotes, (name, fetch address), in git's order."""
        p = self.run(["remote", "-v"], cwd=cwd, check=False)
        out: list[tuple[str, str]] = []
        for line in p.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[2] == "(fetch)" and (parts[0], parts[1]) not in out:
                out.append((parts[0], parts[1]))
        return out

    def config_get(self, cwd: Path, key: str) -> str | None:
        p = self.run(["config", "--local", "--get", key], cwd=cwd, check=False)
        return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None

    def config_set(self, cwd: Path, key: str, value: str) -> None:
        self.run(["config", "--local", key, value], cwd=cwd)

    def head(self, cwd: Path, rev: str = "HEAD") -> str:
        return self.run(["rev-parse", "--verify", f"{rev}^{{commit}}"], cwd=cwd).stdout.strip()

    def current_branch(self, cwd: Path) -> str | None:
        p = self.run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd=cwd, check=False)
        return p.stdout.strip() or None

    def tree(self, cwd: Path, rev: str) -> list[tuple[str, str, int | None]]:
        """The files at ``rev``: (path, type, size), read from git's object store, never the working tree."""
        p = self.run(["ls-tree", "-r", "-l", "-z", rev], cwd=cwd)
        out: list[tuple[str, str, int | None]] = []
        for rec in p.stdout.split("\0"):
            if not rec:
                continue
            meta, _, path = rec.partition("\t")
            f = meta.split()
            if len(f) >= 4:
                size = int(f[3]) if f[3].isdigit() else None
                out.append((path, f[1], size))
        return out

    def read_text(self, cwd: Path, rev: str, path: str, max_bytes: int = 256 * 1024) -> str | None:
        """A file's text at ``rev`` (``git show``), cut at ``max_bytes``; None when it is not there."""
        p = subprocess.run(["git", *NULL_HOOKS, "show", f"{rev}:{path}"], cwd=cwd, env=self.env, capture_output=True, check=False)
        if p.returncode != 0:
            return None
        return p.stdout[:max_bytes].decode("utf-8", "replace")

    def has_commit(self, cwd: Path, rev: str) -> bool:
        return self.run(["cat-file", "-e", f"{rev}^{{commit}}"], cwd=cwd, check=False).returncode == 0


@dataclass(frozen=True)
class RepoName:
    host: str
    owner: str
    name: str

    @property
    def full(self) -> str:
        return f"{self.owner}/{self.name}"


_SEGMENT = re.compile(r"^[A-Za-z0-9._-]{1,100}$")


def parse_repo(text: str, default_host: str) -> RepoName | None:
    """``owner/name``, ``host/owner/name``, or a remote's address (https, ssh, scp-like) → the repository."""
    t = text.strip()
    host = default_host
    m = re.match(r"^(?:https?|ssh|git)://(?:[^@/]+@)?([^/:]+(?::\d+)?)/(.+)$", t)
    if m:
        host, path = m.group(1).lower(), m.group(2)
    else:
        m = re.match(r"^[^@/\s]+@([^:/\s]+):(.+)$", t)  # git@github.com:owner/name.git
        if m:
            host, path = m.group(1).lower(), m.group(2)
        else:
            path = t
            parts = t.split("/")
            if len(parts) == 3:
                host, path = parts[0].lower(), "/".join(parts[1:])
    parts = [p for p in path.split("/") if p]
    # An address through the fake GitHub or a proxy may carry a prefix (…/web/owner/name): the last two.
    if len(parts) < 2:
        return None
    owner, name = parts[-2], re.sub(r"\.git$", "", parts[-1])
    if not (_SEGMENT.match(owner) and _SEGMENT.match(name)) or name in (".", ".."):
        return None
    return RepoName(host, owner, name)
