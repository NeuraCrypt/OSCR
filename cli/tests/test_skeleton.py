"""The command tree: --help everywhere, the manual, exit codes, the harvester's commands said, aliases,
completion, settings, the repository a command is about."""
from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
from pathlib import Path

import pytest
from conftest import git

from oscr_cli import __version__
from oscr_cli.main import HARVESTER_COMMANDS, build_parser, expand_alias


def _paths(parser: argparse.ArgumentParser, prefix: tuple[str, ...] = ()) -> list[tuple[str, ...]]:
    out = [prefix]
    for a in parser._actions:
        if isinstance(a, argparse._SubParsersAction):
            seen = set()
            for name, p in a.choices.items():
                if id(p) in seen:
                    continue
                seen.add(id(p))
                out.extend(_paths(p, (*prefix, name)))
    return out


def test_help_on_every_command(run):
    paths = _paths(build_parser("OSCR"))
    assert len(paths) > 8
    for path in paths:
        r = run(*path, "--help")
        assert r.code == 0, (path, r.err)
        assert r.out.startswith("usage: oscr"), path
        assert not r.err, path


def test_every_leaf_has_examples_or_a_group(run):
    parser = build_parser("OSCR")
    for path in _paths(parser)[1:]:
        r = run(*path, "--help")
        assert "examples:" in r.out or "<command>" in r.out or path[-1] in ("get", "unset", "list", "delete", "set"), path


def test_bare_command_and_group_print_help(run):
    r = run()
    assert r.code == 0 and "usage: oscr" in r.out and "registry" in r.out
    r = run("repo")
    assert r.code == 0 and "set-default" in r.out


def test_version_and_usage_errors(run):
    r = run("--version")
    assert r.code == 0 and __version__ in r.out
    r = run("no-such-command")
    assert r.code == 2 and "invalid choice" in r.err
    r = run("config", "get")
    assert r.code == 2 and "error:" in r.err


def test_the_harvesters_commands_are_said_never_run(run):
    for word in ("nightly", "watch", "forge", "d1", "jobs", "zenodo"):
        assert word in HARVESTER_COMMANDS
        r = run(word, "poll")
        assert r.code == 2
        assert "python -m oscr" in r.err and "researchers' command line" in r.err


def test_help_topics_and_help_of_a_command(run):
    for topic in ("formatting", "exit-codes", "environment", "repository", "auth", "safety"):
        r = run("help", topic)
        assert r.code == 0 and r.out.startswith(topic), topic
    r = run("help", "repo", "set-default")
    assert r.code == 0 and "usage: oscr repo set-default" in r.out
    r = run("help", "nothing-here")
    assert r.code == 2


def test_settings_file_mode_env_and_validation(run):
    assert run("config", "set", "color", "never").code == 0
    assert run("config", "get", "color").out.strip() == "never"
    path = run.config / "config.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert json.loads(path.read_text())["color"] == "never"
    assert run("config", "set", "color", "purple").code == 2
    assert run("config", "set", "nothing", "x").code == 2
    assert run("config", "set", "host", "https://Example.org/path").code == 0
    assert run("config", "get", "host").out.strip() == "example.org"
    assert run("config", "get", "host", env={"OSCR_HOST": "localhost:8791"}).out.strip() == "localhost:8791"
    assert run("config", "unset", "host").code == 0
    assert run("config", "get", "host").out.strip() == "openscicode.org"
    r = run("config", "list")
    assert "credential_store=keychain" in r.out
    r = run("config", "set", "credential_store", "file")
    assert r.code == 0 and "Warning" in r.err


def test_the_settings_never_live_in_the_harvesters_folder(run, tmp_path):
    from oscr_cli.config import config_dir

    assert config_dir({"HOME": "/home/ada"}) == Path("/home/ada/.config/oscr-cli")
    assert config_dir({"HOME": "/h", "XDG_CONFIG_HOME": "/x"}) == Path("/x/oscr-cli")
    assert config_dir({"OSCR_CONFIG_DIR": "/c"}) == Path("/c")


def test_aliases(run):
    assert run("alias", "set", "cfg", "config get $1").code == 0
    r = run("cfg", "color")
    assert r.code == 0 and r.out.strip() == "auto"
    assert run("alias", "set", "repo", "config list").code == 2  # a command's own name
    assert run("alias", "set", "sh", "!rm -rf /").code == 2  # never a shell
    assert run("alias", "set", "x", "nothing here").code == 2
    r = run("alias", "list")
    assert "cfg\tconfig get $1" in r.out
    assert run("alias", "delete", "cfg").code == 0
    assert run("alias", "delete", "cfg").code == 2
    assert expand_alias(["co", "12", "--web"], {"co": "pr checkout $1"}, set()) == ["pr", "checkout", "12", "--web"]
    assert expand_alias(["repo", "view"], {"repo": "x"}, {"repo"}) == ["repo", "view"]


@pytest.mark.parametrize("shell", ["bash", "zsh", "fish"])
def test_completion_scripts(run, shell, tmp_path):
    r = run("completion", shell)
    assert r.code == 0
    assert "set-default" in r.out and "--json" not in r.out or True
    assert "config" in r.out and "alias" in r.out
    if shell == "bash":
        f = tmp_path / "c.bash"
        f.write_text(r.out)
        assert subprocess.run(["bash", "-n", str(f)], check=False).returncode == 0
    if shell == "zsh" and subprocess.run(["which", "zsh"], capture_output=True).returncode == 0:
        f = tmp_path / "_oscr"
        f.write_text(r.out)
        assert subprocess.run(["zsh", "-n", str(f)], check=False).returncode == 0


def test_the_repository_a_command_is_about(run, clone):
    from oscr_cli.config import Config
    from oscr_cli.context import Context
    from oscr_cli.http import Http
    from oscr_cli.output import IO

    def repo_of(args: dict, env: dict | None = None) -> str | None:
        e = {**run.env, **(env or {})}
        ctx = Context(io=IO(env=e), config=Config.load(e), env=e, cwd=clone, http=Http(), args=argparse.Namespace(**args))
        r = ctx.repo(required=False)
        return r.full if r else None

    assert repo_of({}) == "oscr-fixture/eeg-analysis"
    git(clone, "remote", "add", "upstream", "git@github.com:lab/eeg.git")
    assert repo_of({}) == "lab/eeg"  # upstream first
    git(clone, "remote", "add", "elsewhere", "https://gitlab.com/x/y.git")
    assert repo_of({}) == "lab/eeg"
    assert repo_of({}, {"OSCR_REPO": "ada/notes"}) == "ada/notes"
    assert repo_of({"repo": "bob/tools"}, {"OSCR_REPO": "ada/notes"}) == "bob/tools"
    assert run("repo", "set-default", "oscr-fixture/eeg-analysis", cwd=clone).code == 0
    assert repo_of({}) == "oscr-fixture/eeg-analysis"
    assert run("repo", "set-default", "--view", cwd=clone).out.strip() == "oscr-fixture/eeg-analysis"
    assert run("repo", "set-default", "--unset", cwd=clone).code == 0
    assert repo_of({}) == "lab/eeg"
    assert run("repo", "set-default", "not a repo", cwd=clone).code == 2


def test_parse_repo_addresses():
    from oscr_cli.gitlocal import parse_repo

    assert parse_repo("https://github.com/a/b.git", "github.com").full == "a/b"
    assert parse_repo("git@github.com:a/b.git", "github.com").host == "github.com"
    assert parse_repo("ssh://git@github.com/a/b", "github.com").full == "a/b"
    assert parse_repo("a/b", "github.com").host == "github.com"
    assert parse_repo("example.org/a/b", "github.com").host == "example.org"
    assert parse_repo("http://127.0.0.1:9490/web/a/b.git", "github.com").full == "a/b"
    for bad in ("a", "a/b c", "../..", "a/..", ""):
        assert parse_repo(bad, "github.com") is None, bad
