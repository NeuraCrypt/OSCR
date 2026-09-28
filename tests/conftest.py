"""What every test shares: none reads the Mac's keychain (a token the owner stored there would
change what the harvester does)."""
import pytest

from oscr import net


@pytest.fixture(autouse=True)
def no_keychain_github_token(monkeypatch):
    monkeypatch.setattr(net, "_keychain_github_token", lambda: "")
