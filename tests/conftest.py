"""What every test shares: none reads the Mac's keychain (a token or a key the owner stored there
would change what the harvester does, and a test must never send it anywhere)."""
import pytest

from oscr import net


@pytest.fixture(autouse=True)
def no_keychain_github_token(monkeypatch):
    monkeypatch.setattr(net, "_keychain_github_token", lambda: "")


@pytest.fixture(autouse=True)
def no_keychain_openalex_key(monkeypatch):
    monkeypatch.setattr(net, "_keychain_openalex_key", lambda: "")
    monkeypatch.delenv("OPENALEX_API_KEY", raising=False)
