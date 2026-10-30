"""What every test shares: none reads the Mac's keychain (a token or a key the owner stored there
would change what the harvester does, and a test must never send it anywhere). And the GitHub
side's D1 database (night phase 01): `forge_d1`, an SQLite database made from migrations/d1-forge/,
behind the Mac's D1 interface (oscr/community.py SqliteD1), for the tests of oscr/forgejobs.py and
oscr/forgelayer.py."""
import sqlite3
from pathlib import Path

import pytest

from oscr import community, cycles, net, watchdog

FORGE_MIGRATIONS = sorted((Path(__file__).resolve().parents[1] / "migrations" / "d1-forge").glob("[0-9][0-9][0-9][0-9]_*.sql"))


#: The Mac's real run-state: the publications' cycles, the nightly's attempts and its lock. No test
#: may touch them (they once filled cycles.db with zero-second "nightlies" the dashboard showed).
REAL_STATE = [cycles.DB, *(Path(__file__).resolve().parents[1] / p for p in (watchdog.STATE, watchdog.LOCK))]


def state_fingerprint() -> list[tuple[int, int] | None]:
    return [(p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else None for p in REAL_STATE]


@pytest.fixture(autouse=True)
def isolated_run_state(tmp_path_factory, monkeypatch):
    """Every test records its cycles, attempts and lock in its own folder (beside its tmp_path, which
    some tests expect empty)."""
    state = tmp_path_factory.mktemp("run-state")
    monkeypatch.setattr(cycles, "DB", state / "cycles.db")
    monkeypatch.setattr(watchdog, "STATE", state / "nightly.json")
    monkeypatch.setattr(watchdog, "LOCK", state / "nightly.lock")


#: The credentials and accounts a real upload would use. On 2026-10-30 a test ran `oscr nightly` with the
#: Mac's settings and published an empty catalogue (the site, D1 and Hugging Face).
SECRET_ENV = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "GITHUB_TOKEN")
#: Commands that publish or reach an account: a test fakes them, it never runs them.
SENDING_COMMANDS = ("npx", "npm", "wrangler", "hf", "huggingface-cli", "gh")


class RealSendAttempted(AssertionError):
    pass


@pytest.fixture(autouse=True)
def no_real_settings_or_sends(tmp_path_factory, monkeypatch):
    """Every test runs with an empty home: no settings file (so no dataset, no Cloudflare project, no
    D1 push), no Hugging Face or wrangler login, no token in the environment. A command that would
    publish, and a Hugging Face upload, fail the test unless the test fakes them itself."""
    import subprocess

    from oscr import cli
    home = tmp_path_factory.mktemp("home")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HF_HOME", str(home / ".cache" / "huggingface"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    for name in SECRET_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(cli, "SETTINGS", home / ".config" / "oscr" / "settings")

    class GuardedPopen(subprocess.Popen):
        def __init__(self, args, *a, **kw):
            argv = [args] if isinstance(args, (str, bytes, Path)) else list(args)
            if argv and Path(str(argv[0]).split()[0]).name in SENDING_COMMANDS:
                raise RealSendAttempted(f"a test ran {' '.join(map(str, argv[:4]))} for real")
            super().__init__(args, *a, **kw)
    monkeypatch.setattr(subprocess, "Popen", GuardedPopen)   # subprocess.run starts its commands through it
    try:
        import huggingface_hub
    except ImportError:
        return
    for method in ("upload_folder", "upload_file", "create_commit", "create_repo", "delete_file", "delete_folder",
                   "super_squash_history"):
        if hasattr(huggingface_hub.HfApi, method):
            monkeypatch.setattr(huggingface_hub.HfApi, method, lambda self, *a, _m=method, **kw: (_ for _ in ()).throw(
                RealSendAttempted(f"a test called HfApi.{_m} for real")))


@pytest.fixture(autouse=True, scope="session")
def real_run_state_untouched():
    """Fails the run (an error at the session's end) when a test wrote the Mac's real run-state."""
    before = state_fingerprint()
    yield
    assert state_fingerprint() == before, f"a test wrote the real run-state: {REAL_STATE}"


@pytest.fixture(autouse=True)
def no_keychain_github_token(monkeypatch):
    monkeypatch.setattr(net, "_keychain_github_token", lambda: "")


@pytest.fixture(autouse=True)
def no_keychain_openalex_key(monkeypatch):
    monkeypatch.setattr(net, "_keychain_openalex_key", lambda: "")
    monkeypatch.delenv("OPENALEX_API_KEY", raising=False)


def forge_database() -> sqlite3.Connection:
    """A fresh oscr_forge, in memory, at the schema of its migrations (in order)."""
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA foreign_keys = ON")
    for migration in FORGE_MIGRATIONS:
        con.executescript(migration.read_text())
    return con


@pytest.fixture
def forge_d1() -> community.SqliteD1:
    """The oscr_forge database as the Mac reaches it (`query`, `run`), target 'local'; its SQLite
    connection is `forge_d1.con`."""
    return community.SqliteD1(forge_database())
