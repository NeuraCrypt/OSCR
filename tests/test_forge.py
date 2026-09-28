"""The Mac's read-only view of the forges (oscr/forge.py), on mocks, with no network: the REST
answers of GitHub as error codes, heads with ETags, repositories followed by id, git hardened,
no email address kept, and email masking in parity with the website (tests/fixtures/emails.json)."""
import json
import re
import subprocess
from dataclasses import fields
from pathlib import Path

import pytest

from oscr import catalog, forge, net

FIXTURES = Path(__file__).parent / "fixtures"
EMAIL = "private.person@example.org"
SHA = "3" * 40
REF = forge.RepoRef("github", "ada", "compendium")
NOW = 1_790_596_800


def repo_json(owner="ada", name="compendium", id=5001):
    return {
        "id": id, "node_id": f"R_{id}", "name": name, "full_name": f"{owner}/{name}",
        "owner": {"login": owner, "id": 101, "email": EMAIL, "type": "User"},
        "private": False, "visibility": "public", "archived": False, "default_branch": "main",
        "pushed_at": "2026-09-01T00:00:00Z", "license": {"spdx_id": "MIT"}, "size": 42,
        "html_url": f"https://github.com/{owner}/{name}",
    }


class FakeClient:
    """net.Client's `get`, answering from routes: url → (status, body, headers)."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def get(self, url, *, params=None, ttl_s=None, headers=None, method="GET", patient=True):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), "patient": patient})
        status, body, hdrs = self.routes[url]
        text = body if isinstance(body, str) else json.dumps(body)
        return net.Response(url=url, status=status, text=text, headers={k.lower(): v for k, v in hdrs.items()})


def github(routes, **kw):
    client = FakeClient({f"https://api.github.com{path}": answer for path, answer in routes.items()})
    return forge.GitHubReader(client, clock=lambda: NOW, **kw), client


def test_a_304_is_none_and_costs_nothing():
    r, client = github({"/repos/ada/compendium/branches/main": (304, "", {"ETag": '"x"'})})
    assert r.head(REF, "main", etag='"x"') is None
    call = client.calls[0]
    assert call["headers"]["If-None-Match"] == '"x"'
    assert call["patient"] is False, "a quota is never waited out here"


def test_a_head_has_its_sha_and_etag_and_the_default_branch_is_found():
    r, client = github({
        "/repos/ada/compendium": (200, repo_json(), {}),
        "/repos/ada/compendium/branches/main": (200, {"name": "main", "commit": {"sha": SHA, "commit": {"author": {"email": EMAIL}}}}, {"ETag": 'W/"abc"'}),
    })
    head = r.head(REF)
    assert head == forge.Head("main", SHA, 'W/"abc"')
    assert [c["url"] for c in client.calls] == ["https://api.github.com/repos/ada/compendium",
                                                "https://api.github.com/repos/ada/compendium/branches/main"]
    assert all(c["method"] == "GET" for c in client.calls), "the Mac only reads"


@pytest.mark.parametrize("status, headers, code, retry_after", [
    (404, {}, "not_found", None),
    (401, {}, "unauthorized", None),
    (403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(NOW + 300)}, "rate_limited", 300),
    (429, {"Retry-After": "40"}, "rate_limited", 40),
    (403, {}, "forbidden", None),
    (410, {}, "gone", None),
    (451, {}, "gone", None),
    (502, {}, "unavailable", None),
    (0, {}, "unavailable", None),
    (422, {}, "invalid", None),
])
def test_github_answers_become_the_codes_of_the_website(status, headers, code, retry_after):
    r, _ = github({"/repos/ada/compendium": (status, {"message": "…"}, headers)})
    with pytest.raises(forge.ForgeError) as e:
        r.repo(REF)
    assert e.value.code == code
    assert e.value.retry_after == retry_after


def test_repo_by_id_follows_a_rename_and_a_transfer():
    r, _ = github({"/repositories/5001": (200, repo_json(owner="ada-lab", name="renamed"), {})})
    info = r.repo_by_id(forge.RepoKey("github", "5001"))
    assert info.ref == forge.RepoRef("github", "ada-lab", "renamed")
    assert info.key == forge.RepoKey("github", "5001")
    assert info.license_spdx == "MIT"
    with pytest.raises(forge.ForgeError) as e:
        r.repo_by_id(forge.RepoKey("github", "../x"))
    assert e.value.code == "invalid"


def test_no_email_address_is_kept():
    r, _ = github({"/repos/ada/compendium": (200, repo_json(), {})})
    info = r.repo(REF)
    assert not any("mail" in f.name for f in fields(forge.RepoInfo))
    assert EMAIL not in repr(info)


def test_an_unexpected_answer_is_unavailable():
    r, _ = github({"/repos/ada/compendium": (200, {"unexpected": True}, {})})
    with pytest.raises(forge.ForgeError) as e:
        r.repo(REF)
    assert e.value.code == "unavailable"


def test_has_commit():
    r, _ = github({
        f"/repos/ada/compendium/commits/{SHA}": (200, SHA, {}),
        f"/repos/ada/compendium/commits/{'4' * 40}": (422, {"message": "No commit found for SHA"}, {}),
    })
    assert r.has_commit(REF, SHA) is True
    assert r.has_commit(REF, "4" * 40) is False


def test_names_shas_and_paths_are_checked_before_any_request():
    r, client = github({})
    for call in (lambda: r.repo(forge.RepoRef("github", "../x", "y")),
                 lambda: r.repo(forge.RepoRef("gitlab", "ada", "x")),
                 lambda: r.head(REF, "a..b"),
                 lambda: r.has_commit(REF, "main"),
                 lambda: r.read(REF, SHA, "../etc/passwd"),
                 lambda: r.read(REF, SHA, ".git/config"),
                 lambda: r.files(REF, "abc")):
        with pytest.raises(forge.ForgeError) as e:
            call()
        assert e.value.code == "invalid"
    assert client.calls == []


class FakeGit:
    """subprocess.run for git: records every command and its environment."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, cmd, *, env, capture_output, text, timeout):
        self.calls.append((cmd, env))
        for key, (code, out, err) in self.answers.items():
            if key in cmd:
                return subprocess.CompletedProcess(cmd, code, out, err)
        return subprocess.CompletedProcess(cmd, 0, "" if text else b"", "" if text else b"")


def test_git_is_hardened_and_clones_one_commit_partially(tmp_path):
    git = FakeGit({"ls-tree": (0, "README.md\x00src/model.py\x00", ""), "-s": (0, "12\n", ""),
                   "blob": (0, b"hello world\n", b"")})
    r, _ = github({}, runner=git, workdir=tmp_path)
    assert r.files(REF, SHA) == ["README.md", "src/model.py"]
    assert r.read(REF, SHA, "src/model.py") == b"hello world\n"
    assert r.read(REF, SHA, "README.md", max_bytes=12) == b"hello world\n"
    for cmd, env in git.calls:
        assert cmd[0] == "git"
        flags = cmd[1:1 + len(forge.GIT_FLAGS)]
        assert tuple(flags) == forge.GIT_FLAGS
        for f in ("core.hooksPath=/dev/null", "protocol.allow=never", "protocol.https.allow=always",
                  "submodule.recurse=false", "core.symlinks=false", "credential.helper="):
            assert f in cmd
        assert env["GIT_LFS_SKIP_SMUDGE"] == "1" and env["GIT_TERMINAL_PROMPT"] == "0"
    fetches = [cmd for cmd, _ in git.calls if "fetch" in cmd]
    assert len(fetches) == 1, "one partial clone, reused"
    assert "--filter=blob:none" in fetches[0] and "--depth=1" in fetches[0] and fetches[0][-1] == SHA
    assert "https://github.com/ada/compendium.git" in [a for cmd, _ in git.calls for a in cmd]
    assert not any(a in ("push", "commit", "checkout", "submodule") for cmd, _ in git.calls for a in cmd)
    r.close()
    assert not list(tmp_path.iterdir())


def test_a_file_over_the_cap_is_too_large_and_is_not_read(tmp_path):
    git = FakeGit({"-s": (0, "5000000\n", "")})
    r, _ = github({}, runner=git, workdir=tmp_path)
    with pytest.raises(forge.ForgeError) as e:
        r.read(REF, SHA, "data/big.csv", max_bytes=1_000_000)
    assert e.value.code == "too_large"
    assert not any("blob" in cmd for cmd, _ in git.calls)
    r.close()


def test_git_failures_become_codes(tmp_path):
    git = FakeGit({"fetch": (128, "", "fatal: remote error: upload-pack: not our ref 3333")})
    r, _ = github({}, runner=git, workdir=tmp_path)
    with pytest.raises(forge.ForgeError) as e:
        r.files(REF, SHA)
    assert e.value.code == "not_found"
    git = FakeGit({"fetch": (128, "", "fatal: unable to access: Could not resolve host: github.com")})
    r, _ = github({}, runner=git, workdir=tmp_path)
    with pytest.raises(forge.ForgeError) as e:
        r.files(REF, SHA)
    assert e.value.code == "unavailable"
    assert not list(tmp_path.iterdir()), "a failed clone leaves nothing behind"


def test_the_memory_reader_follows_renames_and_answers_like_a_forge():
    m = forge.MemoryReader()
    ref = m.add("ada", "compendium", id="7", files={"a.py": b"x = 1\n", "big.bin": b"0" * 2000}, sha=SHA)
    head = m.head(ref)
    assert head == forge.Head("main", SHA, f'"{SHA}"')
    assert m.head(ref, etag=head.etag) is None
    m.rename("7", "ada-lab", "renamed")
    assert m.repo_by_id(forge.RepoKey("memory", "7")).ref.name == "renamed"
    assert m.repo(ref).ref.owner == "ada-lab", "the old path redirects"
    assert m.files(ref, SHA) == ["a.py", "big.bin"]
    assert m.read(ref, SHA, "a.py") == b"x = 1\n"
    assert m.has_commit(ref, SHA) and not m.has_commit(ref, "4" * 40)
    with pytest.raises(forge.ForgeError) as e:
        m.read(ref, SHA, "big.bin", max_bytes=1000)
    assert e.value.code == "too_large"
    with pytest.raises(forge.ForgeError) as e:
        m.repo(forge.RepoRef("memory", "nobody", "nothing"))
    assert e.value.code == "not_found"
    m.push("7", "main", "5" * 40, {"a.py": b"x = 2\n"})
    assert m.head(ref, etag=head.etag).sha == "5" * 40


def test_the_codes_are_the_websites():
    source = (Path(__file__).parent.parent / "website" / "worker" / "forge" / "errors.ts").read_text()
    listed = source.split("export const GIT_ERROR_CODES")[1].split("];")[0]
    assert tuple(re.findall(r'"([a-z_]+)"', listed)) == forge.ERROR_CODES
    with pytest.raises(ValueError):
        forge.ForgeError("teapot", "x")


def test_a_reader_per_forge():
    assert isinstance(forge.reader("memory"), forge.MemoryReader)
    assert isinstance(forge.reader("github"), forge.GitHubReader)
    with pytest.raises(forge.ForgeError) as e:
        forge.reader("sourceforge")
    assert e.value.code == "unsupported"


def test_mask_emails_is_the_same_on_the_mac_and_on_the_website():
    cases = json.loads((FIXTURES / "emails.json").read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 20
    for case in cases:
        assert catalog.mask_emails(case["input"]) == case["expected"], case["input"]


# ─── trace points: permalinks (night phase 02, E4) ───────────────────────

def test_parse_permalink_matches_the_website():
    """The same trace points as website/src/lib/traced.ts parsePermalink, case by case."""
    fixture = json.loads((FIXTURES / "permalinks.json").read_text())
    assert len(fixture["cases"]) >= 30
    for case in fixture["cases"]:
        point = forge.parse_permalink(case["url"], web=fixture["web"], sites=tuple(fixture["sites"]))
        assert (point.as_dict() if point else None) == case["point"], case["url"]


def test_parse_permalink_needs_a_commit_id():
    sha = "a" * 40
    assert forge.parse_permalink(f"https://github.com/o/r/blob/{sha}/x.py#L2") == \
        forge.TracePoint("github", "o", "r", sha, "x.py", (2, 2))
    assert forge.parse_permalink("https://github.com/o/r/blob/main/x.py#L2") is None
    assert forge.parse_permalink(f"/r/o/r/blob/{sha}/x.py") == forge.TracePoint("github", "o", "r", sha, "x.py", None)
    assert forge.parse_permalink(None) is None  # type: ignore[arg-type]
