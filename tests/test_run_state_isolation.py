"""The tests never write the Mac's real run-state (data/state/cycles.db, nightly.json, nightly.lock):
tests/conftest.py points them to each test's own folder."""
import sqlite3
from pathlib import Path

from conftest import REAL_STATE, state_fingerprint

from oscr import cli, cycles, watchdog


def test_a_publication_recorded_by_a_test_stays_in_its_folder(tmp_path):
    before = state_fingerprint()
    cid = cycles.start_cycle("nightly")
    with cycles.step(cid, "export"):
        pass
    watchdog.mark("attempt")
    lock = watchdog.acquire_lock()
    assert lock is not None
    lock.close()
    assert state_fingerprint() == before
    for p in (cycles.DB, watchdog.STATE, watchdog.LOCK):
        assert p.exists() and p.resolve() not in REAL_STATE



def test_a_test_has_no_settings_and_cannot_send(tmp_path):
    import os
    import subprocess

    import pytest
    from conftest import RealSendAttempted

    from oscr import cli
    assert cli.settings() == {} and Path(os.environ["HOME"]) in cli.SETTINGS.parents
    assert Path(os.environ["HOME"]).resolve() != Path.home().resolve() or "pytest" in os.environ["HOME"]
    assert not os.environ.get("HF_TOKEN") and not os.environ.get("CLOUDFLARE_API_TOKEN")
    for argv in (["npx", "wrangler", "deploy"], ["npm", "run", "build"], ["/opt/homebrew/bin/npx", "wrangler"], "npx wrangler d1"):
        with pytest.raises(RealSendAttempted):
            subprocess.run(argv, capture_output=True, shell=isinstance(argv, str))
    huggingface_hub = pytest.importorskip("huggingface_hub")
    with pytest.raises(RealSendAttempted):
        huggingface_hub.HfApi(token="x").upload_folder(folder_path=str(tmp_path), repo_id="a/b", repo_type="dataset")
    assert subprocess.run(["true"]).returncode == 0          # other commands still run


def test_the_nightly_publishes_nothing_from_an_empty_catalogue(tmp_path, monkeypatch):
    """The guard of 2026-10-30: an empty catalogue (or one under half the last published) sends
    nothing, and the cycle says why. Settings ask for every upload; each is a fake that must not run."""
    import pytest

    from oscr import publish
    sent = []
    monkeypatch.setattr(cli, "settings", lambda: {"OSCR_D1_PUSH": "remote", "OSCR_COMMUNITY_PUSH": "remote",
                                                  "OSCR_SCRIPTS_DATASET": "x/y", "OSCR_CONTACTS_DATASET": "x/z"})
    monkeypatch.setattr(publish, "publish_hf", lambda *a, **k: sent.append("hf"))
    monkeypatch.setattr(publish, "deploy_cloudflare", lambda *a, **k: sent.append("cloudflare"))
    with pytest.raises(SystemExit, match="no paper"):
        cli.main(["--db", str(tmp_path / "oscr.db"), "--no-records", "nightly", "--out", str(tmp_path / "out"),
                  "--dataset", "x/catalog", "--cloudflare", "oscr"])
    assert sent == []
    con = sqlite3.connect(cycles.DB)
    assert con.execute("SELECT status, detail FROM cycle").fetchall() == [("failed", "the catalogue has no paper: nothing is published")]


def test_a_catalogue_under_half_the_last_one_is_refused():
    watchdog.mark("published", 1000)
    assert watchdog.refuse_to_publish(1000) == "" and watchdog.refuse_to_publish(500) == ""
    assert "under 50%" in watchdog.refuse_to_publish(499)
    assert "no paper" in watchdog.refuse_to_publish(0)
