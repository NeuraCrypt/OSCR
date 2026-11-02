"""A passing network error is sent again (30 s, 2 min, 10 min); a definitive one never."""
import subprocess

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
    monkeypatch.setattr(publish, "DEPLOY_ATTEMPTS", 1)
    env = {}
    assert retry.call(lambda: publish._deploy(["npx", "wrangler", "deploy"], tmp_path, env), "deploy").returncode == 0
    assert waits == [30]
    monkeypatch.setattr(subprocess, "run", fake_run([(1, "", "Asset too large")], calls := []))
    with pytest.raises(RuntimeError):
        retry.call(lambda: publish._deploy(["npx", "wrangler", "deploy"], tmp_path, env), "deploy")
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
    assert out.count(" min\n") == 2
