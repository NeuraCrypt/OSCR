"""What every test shares: none reads the Mac's keychain (a token the owner stored there would
change what the harvester does). And the GitHub side's D1 database (night phase 01): `forge_d1`,
an SQLite database made from migrations/d1-forge/, behind the Mac's D1 interface
(oscr/community.py SqliteD1), for the tests of oscr/forgejobs.py and oscr/forgelayer.py."""
import sqlite3
from pathlib import Path

import pytest

from oscr import community, net

FORGE_MIGRATIONS = sorted((Path(__file__).resolve().parents[1] / "migrations" / "d1-forge").glob("[0-9][0-9][0-9][0-9]_*.sql"))


@pytest.fixture(autouse=True)
def no_keychain_github_token(monkeypatch):
    monkeypatch.setattr(net, "_keychain_github_token", lambda: "")


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
