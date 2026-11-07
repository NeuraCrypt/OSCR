"""A passing network error is sent again (30 s, 2 min, 10 min); a definitive one never."""
import subprocess
import time

import pytest

from oscr import community, d1, publish, retry

AUTH = RuntimeError("wrangler failed: /import failed. Authentication error [code: 10000]")


@pytest.fixture
def waits(monkeypatch):
    seen = []
    monkeypatch.setattr(retry, "sleep", seen.append)
    return seen


def failing(times, error, result="sent"):
    calls = []

    def send():
        calls.append(1)
        if len(calls) <= times:
            raise error
        return result
    return send, calls


@pytest.mark.parametrize("error", [
    AUTH, RuntimeError("403 Forbidden"), RuntimeError("429 Too Many Requests"), RuntimeError("502 Bad Gateway"),
    RuntimeError("fetch failed: ECONNRESET"), TimeoutError("read"), ConnectionResetError("cut"),
    subprocess.TimeoutExpired(["wrangler"], 600)])
def test_passing_errors_are_sent_again_with_growing_waits(error, waits):
    send, calls = failing(3, error)
    assert retry.call(send, "x", report=lambda m: None) == "sent"
    assert len(calls) == 4 and waits == [30, 120, 600]


@pytest.mark.parametrize("error", [
    RuntimeError("Asset too large: scripts/07.json is over 25 MiB"), RuntimeError("401 but the quota is spent"),
    RuntimeError("Private storage limit reached"), RuntimeError("no such table: papers"), ValueError("a bug")])
def test_definitive_errors_are_raised_at_once(error, waits):
    send, calls = failing(9, error)
    with pytest.raises(type(error)):
        retry.call(send, "x", report=lambda m: None)
    assert len(calls) == 1 and waits == []


def test_it_gives_up_after_the_last_wait(waits):
    send, calls = failing(9, AUTH)
    with pytest.raises(RuntimeError):
        retry.call(send, "x", report=lambda m: None)
    assert len(calls) == 4


def fake_run(answers, calls):
    def run(cmd, **kw):
        calls.append(cmd)
        code, out, err = answers.pop(0) if answers else (0, "ok", "")
        return subprocess.CompletedProcess(cmd, code, out, err)
    return run


def test_d1_import_is_sent_again_after_an_authentication_error(monkeypatch, tmp_path, waits):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run([(1, "", "Authentication error [code: 10000]")], calls))
    chunk = d1.Chunk(db=d1.CATALOG, path=tmp_path / "a.sql", statements=[])
    assert retry.call(lambda: d1.apply_remote_wrangler(chunk, tmp_path), "D1") == 0
    assert len(calls) == 2 and waits == [30]


def test_a_community_read_through_wrangler_is_sent_again(monkeypatch, tmp_path, waits):
    calls = []
    answers = [(1, "", "503 Service Unavailable"), (0, '[{"results": [{"n": 1}]}]', "")]
    monkeypatch.setattr(subprocess, "run", fake_run(answers, calls))
    assert community.WranglerD1("remote", tmp_path).query("SELECT 1 n") == [{"n": 1}]
    assert len(calls) == 2


def test_wrangler_deploy_is_sent_again_but_not_an_asset_too_large(monkeypatch, tmp_path, waits):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run([(1, "", "fetch failed")], calls))
    env = {}
    assert publish._deploy(["npx", "wrangler", "deploy"], tmp_path, env).returncode == 0
    assert waits == [30] and len(calls) == 2
    monkeypatch.setattr(subprocess, "run", fake_run([(1, "", "Asset too large")], calls := []))
    with pytest.raises(RuntimeError):
        publish._deploy(["npx", "wrangler", "deploy"], tmp_path, env)
    assert len(calls) == 1


class FakeApi:
    """A fake Hugging Face: the first uploads fail, as `failures` says."""

    def __init__(self, failures):
        self.failures, self.uploads = list(failures), 0

    def upload_folder(self, **kw):
        self.uploads += 1
        if self.failures:
            raise self.failures.pop(0)


def test_a_hugging_face_upload_is_sent_again_on_a_server_error(waits):
    api = FakeApi([RuntimeError("500 Server Error"), RuntimeError("504 Gateway Time-out")])
    retry.call(lambda: api.upload_folder(), "Hugging Face", report=lambda m: None)
    assert api.uploads == 3 and waits == [30, 120]


def test_each_deploy_try_says_its_assets_and_its_time_in_the_log(monkeypatch, tmp_path, capsys):
    found = "Found 412 new or modified static assets to upload"
    answers = [(1, found, "401 Unauthorized"), (0, "Found 7 new or modified static assets to upload", "")]
    monkeypatch.setattr(subprocess, "run", fake_run(answers, []))
    publish._deploy(["npx", "wrangler", "deploy"], tmp_path, {})
    out = capsys.readouterr().out
    assert "try 1: Found 412 new or modified static assets" in out and "try 2: Found 7 new" in out
    # A failed try says why, with the end of what wrangler wrote (2026-11-07: until then only the count).
    assert "try 1: Found 412 new or modified static assets, 0.0 min, failed (exit 1); its last lines:\n    401 Unauthorized" in out
    assert "try 2: Found 7 new or modified static assets, 0.0 min\n" in out


def test_a_deploy_try_stopped_at_the_limit_says_its_last_lines(monkeypatch, tmp_path, capsys):
    def stopped(*a, **k):
        raise subprocess.TimeoutExpired(a[0], 5400, output=b"Found 750 new or modified static assets to upload\nUploading 700/750",
                                        stderr=b"")
    monkeypatch.setattr(subprocess, "run", stopped)
    monkeypatch.setattr(publish, "DEPLOY_ATTEMPTS", 1)
    with pytest.raises(subprocess.TimeoutExpired):
        publish._deploy(["npx", "wrangler", "deploy"], tmp_path, {})
    out = capsys.readouterr().out
    assert "try 1: Found 750 new or modified static assets, stopped after" in out and "Uploading 700/750" in out


def test_the_deploy_has_one_set_of_tries_and_a_run_at_its_limit_resumes(monkeypatch, tmp_path, capsys):
    """2026-11-06: retry.call around the deploy's own loop made up to 24 runs (36 hours). Now the loop
    is the only one: a run stopped at its limit is followed by another (Cloudflare kept what it got),
    a passing error too, DEPLOY_ATTEMPTS at most."""
    def stopped(left):
        def run(*a, **k):
            raise subprocess.TimeoutExpired(a[0], 5400, output=f"Found {left} new or modified static assets to upload".encode())
        return run
    answers = iter([stopped(7887), stopped(750), (1, "", "fetch failed"), (0, "Found 41 new or modified static assets to upload", "")])

    def run(cmd, **k):
        a = next(answers)
        if callable(a):
            return a(cmd, **k)
        return subprocess.CompletedProcess(cmd, a[0], a[1], a[2])
    monkeypatch.setattr(subprocess, "run", run)
    assert publish._deploy(["npx", "wrangler", "deploy"], tmp_path, {}).returncode == 0
    monkeypatch.setattr(subprocess, "run", stopped(100))
    with pytest.raises(subprocess.TimeoutExpired):
        publish._deploy(["npx", "wrangler", "deploy"], tmp_path, {})        # no progress: stops at try 2
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, "", "fetch failed"))
    with pytest.raises(RuntimeError, match="fetch failed"):
        publish._deploy(["npx", "wrangler", "deploy"], tmp_path, {})
    out = capsys.readouterr().out
    assert out.count("try 6:") == 1 and "try 7:" not in out


def test_the_deploy_starts_no_run_past_the_nights_end(monkeypatch, tmp_path):
    monkeypatch.setattr(subprocess, "run", lambda cmd, **k: pytest.fail("a run started"))
    with pytest.raises(RuntimeError, match="no time left"):
        publish._deploy(["npx", "wrangler", "deploy"], tmp_path, {}, until=time.time() + 30)
