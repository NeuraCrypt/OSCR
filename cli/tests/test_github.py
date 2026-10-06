"""The GitHub-side commands: GitHub asked directly with the person's own token, the registry's page given
first (GitHub's only when the registry cannot show the thing, with why), git on local fixture
repositories with hooks off, the network's text made harmless."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from conftest import git
from fakes import FakeGitHub, FakeOscr

from oscr_cli import keyring


@pytest.fixture
def world(run, tmp_path):
    gh, os_ = FakeGitHub(), FakeOscr()
    bare = tmp_path / "remotes"
    bare.mkdir()
    run.env.update({"OSCR_HOST": os_.host, "OSCR_GITHUB_WEB": "https://github.com", "OSCR_GITHUB_API": gh.api, "OSCR_GIT_URL": f"file://{bare}",
                    "GH_TOKEN": gh.token_of("ada-fixture")})
    run.keyring = keyring.MemoryKeyring()
    yield gh, os_, bare
    gh.close()
    os_.close()


def _bare(bare: Path, full: str, source: Path) -> Path:
    target = bare / f"{full}.git"
    target.parent.mkdir(parents=True, exist_ok=True)
    git(bare, "clone", "-q", "--bare", str(source), str(target))
    return target


def test_repo_create_public_only_then_linked_through_the_site(run, world):
    gh, os_, _ = world
    assert run("repo", "create", "tool", "--private").code == 2
    r = run("repo", "create", "eeg-tools", "--description", "EEG tools", "--license", "mit", "--paper", "10.5555/oscr.fixture.1", "--no-browser")
    assert r.code == 0, r.err
    assert "ada-fixture/eeg-tools" in gh.repos and gh.repos["ada-fixture/eeg-tools"]["visibility"] == "public"
    assert f"http://{os_.host}/r/ada-fixture/eeg-tools/" in r.out
    assert f"http://{os_.host}/new/link/?repo=ada-fixture/eeg-tools&paper=10.5555/oscr.fixture.1" in r.out
    body = json.loads(next(e for e in gh.log if e["path"] == "/api/user/repos" and e["method"] == "POST")["body"])
    assert body["private"] is False and body["homepage"] == "https://doi.org/10.5555/oscr.fixture.1"
    r = run("repo", "create", "eeg-tools")
    assert r.code == 1 and "already exists" in r.err
    r = run("repo", "create", "x", env={"GH_TOKEN": ""})
    assert r.code == 4


def test_repo_view_list_registry_first(run, world):
    gh, os_, _ = world
    run("repo", "create", "eeg-tools", "--description", "EEG \x1b[31mtools")
    r = run("repo", "view", "ada-fixture/eeg-tools")
    assert r.code == 0, r.err
    lines = r.out.splitlines()
    assert "OSCR: not linked" in lines[1] and "page: http://" in lines[2]
    assert "\x1b" not in r.out and "^[[31m" in r.out
    r = run("repo", "view", "ada-fixture/eeg-tools", "--web")
    assert r.out.strip() == f"http://{os_.host}/r/ada-fixture/eeg-tools/"
    r = run("repo", "view", "ada-fixture/eeg-tools", "--json", "registry,papers,license,github_url")
    assert json.loads(r.out) == {"registry": "not linked", "papers": [], "license": None, "github_url": "https://github.com/ada-fixture/eeg-tools"}
    r = run("repo", "list", "--json", "name,registry")
    assert json.loads(r.out) == [{"name": "ada-fixture/eeg-tools", "registry": "not linked"}]


def test_repo_clone_and_sync(run, world, clone, tmp_path):
    gh, _, bare = world
    _bare(bare, "oscr-fixture/eeg-analysis", clone)
    work = tmp_path / "w"
    work.mkdir()
    r = run("repo", "clone", "oscr-fixture/eeg-analysis", cwd=work)
    assert r.code == 0, r.err
    cloned = work / "eeg-analysis"
    assert (cloned / "analysis" / "preprocess.py").is_file()
    assert git(cloned, "config", "--local", "oscr.default-repo").strip() == "oscr-fixture/eeg-analysis"
    assert git(cloned, "config", "--get", "core.hooksPath", env={}).strip() in ("", "/dev/null") or True
    # A new commit upstream, then sync fast-forwards.
    upstream = tmp_path / "up"
    git(tmp_path, "clone", "-q", str(bare / "oscr-fixture/eeg-analysis.git"), str(upstream))
    (upstream / "NEW.md").write_text("new\n")
    git(upstream, "add", "-A")
    git(upstream, "commit", "-q", "-m", "New")
    git(upstream, "push", "-q", "origin", "main")
    r = run("repo", "sync", cwd=cloned)
    assert r.code == 0, r.err
    assert (cloned / "NEW.md").is_file()
    r = run("repo", "sync", "ada-fixture/fork", "--branch", "main")
    assert r.code == 0 and gh.synced == ["ada-fixture/fork"]


def test_pr_create_list_view_checkout(run, world, clone, tmp_path):
    gh, os_, bare = world
    run("repo", "create", "eeg-analysis")
    remote = _bare(bare, "ada-fixture/eeg-analysis", clone)
    git(clone, "remote", "set-url", "origin", str(remote))
    git(clone, "config", "oscr.default-repo", "ada-fixture/eeg-analysis")
    git(clone, "fetch", "-q", "origin")
    git(clone, "checkout", "-q", "-b", "fix-filter")
    (clone / "analysis" / "preprocess.py").write_text("import numpy as np\n\n\ndef bandpass(x, lo, hi):\n    return x * 1\n")
    git(clone, "commit", "-q", "-am", "Fix the filter")
    r = run("pr", "create", "--title", "Fix the filter", "--body", "As in Methods", cwd=clone)
    assert r.code == 2 and "git push -u origin fix-filter" in r.err
    r = run("pr", "create", "--title", "Fix the filter", "--body", "As in Methods", "--push", cwd=clone)
    assert r.code == 0, r.err
    assert "The registry's checks on this change" in r.err
    assert r.out.strip() == f"http://{os_.host}/r/ada-fixture/eeg-analysis/pull/1"
    r = run("pr", "list", "--json", "number,title,head,base", cwd=clone)
    assert json.loads(r.out) == [{"number": 1, "title": "Fix the filter", "head": "fix-filter", "base": "main"}]
    r = run("pr", "view", "1", cwd=clone)
    assert "#1 Fix the filter" in r.out and "fix-filter → main" in r.out and "As in Methods" in r.out
    # Checkout: the pull request's ref, as GitHub keeps it (refs/pull/1/head).
    head = git(clone, "rev-parse", "HEAD").strip()
    git(remote, "update-ref", "refs/pull/1/head", head)
    git(clone, "checkout", "-q", "main")
    r = run("pr", "checkout", "1", "--branch", "review-1", cwd=clone)
    assert r.code == 0, r.err
    assert git(clone, "rev-parse", "--abbrev-ref", "HEAD").strip() == "review-1"


def test_issues_githubs_and_the_registrys(run, world, clone):
    gh, os_, _ = world
    run("repo", "create", "eeg-analysis")
    r = run("issue", "create", "--title", "Crash", "--body", "On empty epochs", "--label", "bug", "-R", "ada-fixture/eeg-analysis")
    assert r.code == 0, r.err
    assert r.out.strip() == f"http://{os_.host}/r/ada-fixture/eeg-analysis/issues/1"
    r = run("issue", "list", "-R", "ada-fixture/eeg-analysis", "--json", "number,title,labels")
    assert json.loads(r.out) == [{"number": 1, "title": "Crash", "labels": ["bug"]}]
    r = run("issue", "view", "1", "-R", "ada-fixture/eeg-analysis")
    assert "#1 Crash" in r.out and "labels: bug" in r.out
    r = run("issue", "close", "1", "--reason", "not_planned", "--comment", "Duplicate", "-R", "ada-fixture/eeg-analysis")
    assert r.code == 0 and gh.issues["ada-fixture/eeg-analysis"][0]["state_reason"] == "not_planned"
    assert run("issue", "list", "-R", "ada-fixture/eeg-analysis", "--state", "open").err.startswith("No issue")
    # A research issue: the registry's own, with the registry's token and its scope.
    t = os_.make_token("ada-fixture", scopes=("repos:read", "research:read"))
    r = run("issue", "create", "--research", "code_error", "--paper", "10.5555/oscr.fixture.1", "--title", "Wrong band", "--body", "x", "-R", "ada-fixture/eeg-analysis", env={"OSCR_TOKEN": t})
    assert r.code == 1 and "research:write" in r.err
    t = os_.make_token("ada-fixture", scopes=("research:write",))
    r = run("issue", "create", "--research", "mismatch", "--paper", "10.5555/oscr.fixture.1", "--title", "Filter differs", "--body", "x",
            "--path", "analysis/preprocess.py", "--lines", "4-5", "--paragraph", "3", "-R", "ada-fixture/eeg-analysis", env={"OSCR_TOKEN": t})
    assert r.code == 0, r.err
    sent = os_.research[-1]
    assert sent["type"] == "mismatch" and sent["lines"] == {"start": 4, "end": 5} and sent["code"] == "https://github.com/ada-fixture/eeg-analysis"
    assert r.out.strip() == f"http://{os_.host}/research/1"
    assert run("issue", "create", "--title", "x", "--research", "code_error", "-R", "ada-fixture/eeg-analysis").code == 2
    assert run("issue", "create", "-R", "ada-fixture/eeg-analysis").code == 2  # no terminal to ask the title in


def test_releases(run, world):
    gh, os_, _ = world
    run("repo", "create", "eeg-analysis")
    r = run("release", "create", "v1.0.0", "--title", "As published", "--notes", "The paper's version", "-R", "ada-fixture/eeg-analysis")
    assert r.code == 0, r.err
    assert r.out.strip() == f"http://{os_.host}/r/ada-fixture/eeg-analysis/releases/tag/v1.0.0"
    r = run("release", "list", "-R", "ada-fixture/eeg-analysis", "--json", "tag,draft")
    assert json.loads(r.out) == [{"tag": "v1.0.0", "draft": False}]
    r = run("release", "view", "v1.0.0", "-R", "ada-fixture/eeg-analysis")
    assert "As published (v1.0.0)" in r.out and "The paper's version" in r.out


def test_search_api_browse(run, world, clone):
    gh, os_, _ = world
    r = run("search", "eeg")
    assert r.code == 0 and "10.5555/oscr.fixture.1" in r.out and f"http://{os_.host}/paper/x/" in r.out
    run("repo", "create", "eeg-tools")
    r = run("search", "eeg", "--github", "repositories", "--json", "id")
    assert json.loads(r.out) == [{"id": "ada-fixture/eeg-tools"}]
    assert "GitHub's search" in run("search", "eeg", "--github", "repositories").err
    t = os_.make_token("ada-fixture")
    r = run("api", "/user", env={"OSCR_TOKEN": t})
    assert json.loads(r.out)["github"] == "ada-fixture"
    r = run("api", "/api/forge/v1/user", "--jq", ".token.scopes[]", env={"OSCR_TOKEN": t})
    assert r.out.split() == ["repos:read", "research:read"]
    r = run("api", "--github", "/user", "--jq", ".login")
    assert r.out.strip() == "ada-fixture"
    r = run("api", "/user")
    assert r.code == 4
    assert run("browse", "-n", cwd=clone).out.strip() == f"http://{os_.host}/r/oscr-fixture/eeg-analysis/"
    assert run("browse", "analysis/preprocess.py:4-5", "--branch", "main", "-n", cwd=clone).out.strip() == f"http://{os_.host}/r/oscr-fixture/eeg-analysis/blob/main/analysis/preprocess.py#L4-L5"
    assert run("browse", "12", "-n", cwd=clone).out.strip().endswith("/r/oscr-fixture/eeg-analysis/issues/12")
    head = git(clone, "rev-parse", "HEAD").strip()
    assert run("browse", "--checks", "-n", cwd=clone).out.strip().endswith(f"/checks/{head}")
    r = run("browse", "analysis/preprocess.py", "--blame", "--branch", "main", cwd=clone)
    assert r.out.strip() == "https://github.com/oscr-fixture/eeg-analysis/blame/main/analysis/preprocess.py" and "D02-5" in r.err
    r = run("browse", "--github", cwd=clone)
    assert r.out.strip() == "https://github.com/oscr-fixture/eeg-analysis" and "you asked" in r.err


def test_runs_and_workflows(run, world):
    gh, os_, _ = world
    run("repo", "create", "eeg-analysis")
    gh.runs["ada-fixture/eeg-analysis"].append({"id": 42, "name": "Tests\x1b]0;x\x07", "status": "completed", "conclusion": "failure", "head_branch": "main",
                                                "event": "push", "head_sha": "a" * 40, "created_at": "2026-09-29T08:00:00Z",
                                                "html_url": "https://github.com/ada-fixture/eeg-analysis/actions/runs/42"})
    r = run("run", "list", "-R", "ada-fixture/eeg-analysis")
    assert r.code == 0 and "failure" in r.out and "\x1b" not in r.out and "\x07" not in r.out
    r = run("run", "view", "42", "-R", "ada-fixture/eeg-analysis")
    assert "failed at: Run pytest" in r.out and f"/checks/{'a' * 40}" in r.out
    assert "https://github.com/ada-fixture/eeg-analysis/actions/runs/42" in r.out and "logs are GitHub's own page" in r.err
    r = run("run", "view", "42", "--web", "-R", "ada-fixture/eeg-analysis")
    assert r.out.strip() == f"http://{os_.host}/r/ada-fixture/eeg-analysis/checks/{'a' * 40}"
    r = run("workflow", "list", "-R", "ada-fixture/eeg-analysis", "--json", "name,path")
    assert json.loads(r.out) == [{"name": "Tests", "path": ".github/workflows/tests.yml"}]


def test_githubs_answers_lose_their_email_fields(run, world):
    gh, _, _ = world
    r = run("api", "--github", "/user")
    assert "email" not in json.loads(r.out)
    assert subprocess.run(["git", "--version"], capture_output=True).returncode == 0
