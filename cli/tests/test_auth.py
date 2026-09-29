"""Sign-in: GitHub's device flow and the registry's, several accounts, status, token, switch, refresh,
logout; the keychain only (a fake one, a throwaway keychain file, a fake secret-tool, the plain file
when asked); git's credential helper for GitHub's host only; no token in argv or debug output."""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys

import pytest
from fakes import CLIENT_ID, FakeGitHub, FakeOscr

from oscr_cli import ghauth, keyring, oscrauth


@pytest.fixture
def world(run, monkeypatch):
    gh, os_ = FakeGitHub(), FakeOscr()
    run.env.update({"OSCR_HOST": os_.host, "OSCR_GITHUB_WEB": gh.web, "OSCR_GITHUB_API": gh.api})
    run.keyring = keyring.MemoryKeyring()
    who = {"github": "ada-fixture", "oscr": "ada-fixture", "github_action": "approve", "oscr_action": "approve"}

    def gh_sleep(_s):
        if who["github_action"] == "approve":
            gh.approve(who["github"])
        else:
            getattr(gh, who["github_action"])()

    def oscr_sleep(_s):
        if who["oscr_action"] == "approve":
            os_.approve(who["oscr"])
        else:
            getattr(os_, who["oscr_action"])()

    monkeypatch.setattr(ghauth, "sleep", gh_sleep)
    monkeypatch.setattr(oscrauth, "sleep", oscr_sleep)
    yield gh, os_, who
    gh.close()
    os_.close()


def test_login_through_both_device_flows(run, world):
    gh, os_, _ = world
    r = run("auth", "login")
    assert r.code == 0, r.err
    assert "GitHub: signed in as ada-fixture" in r.err and "OSCR: signed in as ada-fixture" in r.err
    assert "enter the code" in r.err and "type the code BCDF-GHJK" in r.err
    items = run.keyring.items
    assert set(items) == {f"github:{gh.base.split('://')[1]}:ada-fixture", f"oscr:{os_.host}:ada-fixture"}
    hosts = json.loads((run.config / "hosts.json").read_text())
    text = json.dumps(hosts)
    assert "ghu_" not in text and "oscr_pat_" not in text and "@" not in text  # no credential, no address in the file
    assert hosts["oscr"][os_.host]["users"]["ada-fixture"]["scopes"] == ["repos:read", "research:read"]
    # the client id came from the registry's /api/v1/cli; the GitHub token never went to the registry
    assert not any((e["auth"] or "").endswith(tuple(t for t in gh.users)) for e in os_.log)
    code_call = next(e for e in gh.log if e["path"] == "/web/login/device/code")
    assert f"client_id={CLIENT_ID}" in code_call["body"].decode() and b"secret" not in code_call["body"]


def test_status_token_switch_logout(run, world):
    gh, os_, who = world
    assert run("auth", "login").code == 0
    who["github"] = who["oscr"] = "bob-fixture"
    assert run("auth", "login").code == 0
    r = run("auth", "status")
    assert r.code == 0
    assert r.out.count("valid") == 4 and "bob-fixture — valid (active" in r.out
    r = run("auth", "status", "--json", "service,user,active,valid")
    rows = json.loads(r.out)
    assert {(x["service"], x["user"], x["active"]) for x in rows} >= {("github", "bob-fixture", True), ("github", "ada-fixture", False)}
    tok = run("auth", "token", "--github").out.strip()
    assert gh.users[tok]["login"] == "bob-fixture"
    assert run("auth", "switch").code == 0
    assert gh.users[run("auth", "token", "--github").out.strip()]["login"] == "ada-fixture"
    assert run("auth", "switch", "--oscr", "--user", "nobody").code == 2
    assert run("auth", "token").code == 2  # which one?
    oscr_tok = run("auth", "token", "--oscr").out.strip()
    assert oscr_tok in os_.tokens
    r = run("auth", "logout", "--oscr")
    assert r.code == 0 and "revoked" in r.err
    assert oscr_tok not in os_.tokens  # the token revoked itself
    assert run("auth", "logout", "--github", "--user", "bob-fixture").code == 0
    assert "8 hours" in run("auth", "logout", "--github").err
    assert run("auth", "token", "--github").code == 4
    r = run("auth", "status", "--github")
    assert "not signed in" in r.err


def test_env_tokens_win_and_a_refused_token_is_said(run, world):
    gh, os_, _ = world
    t = os_.make_token("ada-fixture")
    r = run("auth", "token", "--oscr", env={"OSCR_TOKEN": t})
    assert r.out.strip() == t
    r = run("auth", "status", "--oscr", env={"OSCR_TOKEN": t})
    assert "OSCR_TOKEN" in r.out
    run.keyring.set(f"oscr:{os_.host}:ghost", {"token": "oscr_pat_" + "x" * 43}, "x")
    from oscr_cli.config import Hosts

    h = Hosts(run.config)
    h.add("oscr", os_.host, "ghost", {"scopes": []})
    r = run("auth", "status", "--oscr")
    assert r.code == 1 and "refused" in r.out


def test_refused_expired_and_slowed_device_flows(run, world):
    gh, os_, who = world
    who["github_action"] = "deny"
    r = run("auth", "login", "--github")
    assert r.code == 4 and "refused on GitHub" in r.err
    who["github_action"] = "expire"
    r = run("auth", "login", "--github")
    assert r.code == 4 and "expired" in r.err
    who["oscr_action"] = "deny"
    r = run("auth", "login", "--oscr")
    assert r.code == 4 and "refused" in r.err
    r = run("auth", "login", "--oscr", "--scopes", "repos:read,admin")
    assert r.code == 2 and "not a scope" in r.err
    r = run("auth", "login", "--oscr", "--days", "400")
    assert r.code == 2
    gh.device_disabled = True
    who["github_action"] = "approve"
    r = run("auth", "login", "--github")
    assert r.code == 1 and "Device Flow" in (r.err + r.out)
    assert not run.keyring.items


def test_pages_elsewhere_are_never_opened(run, world):
    gh, os_, _ = world
    gh.verification_host = "https://evil.example"
    r = run("auth", "login", "--github")
    assert r.code == 1 and "another host" in r.err
    os_.page_host = "https://evil.example"
    r = run("auth", "login", "--oscr")
    assert r.code == 1 and "does not open it" in r.err


def test_the_oscr_code_expires_after_15_minutes(run, world, monkeypatch):
    gh, os_, who = world
    who["oscr_action"] = "expire_nothing"
    os_.expire_nothing = lambda: None  # type: ignore[attr-defined]
    clock = {"t": 1_000_000.0}
    monkeypatch.setattr(oscrauth, "now", lambda: clock["t"])
    monkeypatch.setattr(oscrauth, "sleep", lambda s: clock.__setitem__("t", clock["t"] + s))
    r = run("auth", "login", "--oscr")
    assert r.code == 4 and "15 minutes" in r.err
    polls = [e for e in os_.log if e["path"] == "/api/v1/device/token"]
    assert len(polls) <= 15 * 60 // 5  # never faster than every 5 s


def test_github_refresh_and_its_fallback(run, world):
    gh, _, _ = world
    assert run("auth", "login", "--github").code == 0
    old = run("auth", "token", "--github").out.strip()
    r = run("auth", "refresh", "--github")
    assert r.code == 0 and "renewed" in r.err
    new = run("auth", "token", "--github").out.strip()
    assert new != old and gh.users[new]["login"] == "ada-fixture"
    gh.refresh_refused = True
    r = run("auth", "refresh", "--github")
    assert r.code == 0 and "signing in again" in r.err
    # an expired token is renewed before use
    hosts = json.loads((run.config / "hosts.json").read_text())
    ghhost = gh.base.split("://")[1]
    hosts["github"][ghhost]["users"]["ada-fixture"]["expires_at"] = 1
    (run.config / "hosts.json").write_text(json.dumps(hosts))
    gh.refresh_refused = False
    r = run("auth", "token", "--github")
    assert r.code == 0 and r.out.strip() in gh.users


def test_oscr_refresh_revokes_the_previous_token(run, world):
    _, os_, _ = world
    assert run("auth", "login", "--oscr", "--scopes", "repos:read,statuses:write").code == 0
    old = run("auth", "token", "--oscr").out.strip()
    r = run("auth", "refresh", "--oscr")
    assert r.code == 0, r.err
    new = run("auth", "token", "--oscr").out.strip()
    assert new != old and old not in os_.tokens and os_.tokens[new]["scopes"] == ["repos:read", "statuses:write"]


def test_with_token_reads_standard_input(run, world):
    gh, os_, _ = world
    t = os_.make_token("ada-fixture")
    assert run("auth", "login", "--oscr", "--with-token", stdin=t + "\n").code == 0
    assert run("auth", "login", "--oscr", "--with-token", stdin="not a token").code == 2
    assert run("auth", "login", "--with-token", stdin=t).code == 2
    assert run("auth", "login", "--github", "--with-token", stdin=gh.token_of("bob-fixture")).code == 0


def test_no_token_in_debug_output(run, world):
    gh, os_, _ = world
    r = run("auth", "login", "--debug")
    assert r.code == 0
    toks = [v for v in gh.users] + [v for v in os_.tokens]
    for t in toks:
        assert t not in r.err and t not in r.out
    assert "[debug] > POST" in r.err and "device_code" not in r.err.replace("device/code", "")


def test_the_git_credential_helper_serves_githubs_host_only(run, world, tmp_path):
    gh, os_, _ = world
    assert run("auth", "login", "--github").code == 0
    ghhost = gh.base.split("://")[1]
    r = run("auth", "git-credential", "get", stdin=f"protocol=http\nhost={ghhost}\n\n")
    lines = dict(line.split("=", 1) for line in r.out.splitlines())
    assert lines["username"] == "ada-fixture" and lines["password"] in gh.users
    for other in (f"protocol=https\nhost={ghhost}\n\n", "protocol=https\nhost=gitlab.com\n\n", f"protocol=http\nhost={os_.host}\n\n", "protocol=http\nhost=evil.example\n\n"):
        r = run("auth", "git-credential", "get", stdin=other)
        assert r.code == 0 and r.out == "", other
    assert run("auth", "git-credential", "store", stdin="protocol=http\nhost=x\npassword=y\n\n").out == ""
    # the registry's own host is never served, even configured as GitHub's
    r = run("auth", "git-credential", "get", stdin=f"protocol=http\nhost={ghhost}\n\n", env={"OSCR_HOST": ghhost})
    assert r.out == ""
    assert run("auth", "setup-git").code == 0
    cfg = (run.tmp / "gitconfig").read_text()
    assert f'[credential "{gh.web}"]' in cfg and "-m oscr_cli auth git-credential" in cfg
    assert 'helper = \n' in cfg or 'helper = ""' in cfg or "helper =\n" in cfg


def test_the_plain_file_only_when_asked(run, world):
    run.keyring = None
    r = run("auth", "login", "--github", "--insecure-storage")
    assert r.code == 0 and "plain file" in r.err
    f = run.config / "credentials.json"
    assert stat.S_IMODE(os.stat(f).st_mode) == 0o600
    r = run("auth", "token", "--github")  # found in the file again, never in a keychain
    assert r.code == 0 and r.out.strip().startswith("ghu_")
    assert "plain file" in run("auth", "status", "--github", "--offline").out
    assert run("auth", "logout", "--github").code == 0
    assert json.loads(f.read_text()) == {}


def test_the_keychain_commands_never_carry_the_secret_in_argv(monkeypatch):
    calls = []

    class P:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(args, **kw):
        calls.append((args, kw.get("input")))
        return P()

    monkeypatch.setattr(subprocess, "run", fake_run)
    secret = {"token": "ghu_SECRETVALUE123"}
    keyring.MacKeychain().set("github:github.com:ada", secret, "label")
    keyring.SecretService().set("github:github.com:ada", secret, "label")
    for args, stdin in calls:
        assert all("SECRETVALUE" not in a and keyring.encode(secret) not in a for a in args)
        assert keyring.encode(secret) in (stdin or "")


@pytest.mark.skipif(sys.platform != "darwin", reason="the macOS keychain")
def test_a_throwaway_macos_keychain(tmp_path):
    kc = str(tmp_path / "oscr-cli-test.keychain-db")
    before = subprocess.run(["security", "list-keychains", "-d", "user"], capture_output=True, text=True).stdout
    subprocess.run(["security", "create-keychain", "-p", "test-only", kc], check=True, capture_output=True)
    try:
        subprocess.run(["security", "unlock-keychain", "-p", "test-only", kc], check=True, capture_output=True)
        k = keyring.MacKeychain(kc)
        assert k.get("github:example:ada") is None
        k.set("github:example:ada", {"token": "ghu_test", "refresh_token": "ghr_test"}, "oscr-cli test")
        assert k.get("github:example:ada") == {"token": "ghu_test", "refresh_token": "ghr_test"}
        k.set("github:example:ada", {"token": "ghu_new"}, "oscr-cli test")
        assert k.get("github:example:ada") == {"token": "ghu_new"}
        assert k.delete("github:example:ada") and k.get("github:example:ada") is None
    finally:
        subprocess.run(["security", "delete-keychain", kc], capture_output=True)
    after = subprocess.run(["security", "list-keychains", "-d", "user"], capture_output=True, text=True).stdout
    assert before == after  # the person's keychain list untouched


def test_secret_tool_through_a_stand_in(tmp_path, monkeypatch):
    store = tmp_path / "store.json"
    tool = tmp_path / "secret-tool"
    tool.write_text(f"""#!{sys.executable}
import json, sys
p = {str(store)!r}
try: d = json.load(open(p))
except Exception: d = {{}}
op, args = sys.argv[1], sys.argv[2:]
key = "|".join(a for a in args if not a.startswith("--"))
if op == "store": d[key] = sys.stdin.read(); json.dump(d, open(p, "w"))
elif op == "lookup":
    if key not in d: sys.exit(1)
    sys.stdout.write(d[key])
elif op == "clear":
    if key not in d: sys.exit(1)
    del d[key]; json.dump(d, open(p, "w"))
""")
    tool.chmod(0o700)
    s = keyring.SecretService(str(tool))
    s.set("oscr:h:ada", {"token": "oscr_pat_x"}, "label")
    assert s.get("oscr:h:ada") == {"token": "oscr_pat_x"}
    assert "service|oscr-cli|account|oscr:h:ada" in json.loads(store.read_text())
    assert s.delete("oscr:h:ada") and s.get("oscr:h:ada") is None


def test_no_keychain_is_said(monkeypatch, tmp_path):
    from oscr_cli.config import Config
    from oscr_cli.errors import CliError

    monkeypatch.setattr(keyring.sys, "platform", "linux")
    monkeypatch.setattr(keyring.shutil, "which", lambda _n: None)
    with pytest.raises(CliError) as e:
        keyring.choose(Config.load({"OSCR_CONFIG_DIR": str(tmp_path)}), {})
    assert "secret-tool" in e.value.hint
    assert isinstance(keyring.choose(Config.load({"OSCR_CONFIG_DIR": str(tmp_path)}), {}, insecure=True), keyring.FileStore)
