"""What D1 lost is noticed and sent again; the Mac's memory never trusts a broken read."""
import sqlite3

import pytest

from oscr import community, d1, reconcile


@pytest.fixture
def remote():
    con = sqlite3.connect(":memory:")
    con.executescript("""
        CREATE TABLE paper_orcid (orcid TEXT, paper_id TEXT, slug TEXT DEFAULT '', title TEXT DEFAULT '',
                                  PRIMARY KEY (orcid, paper_id)) WITHOUT ROWID;
        CREATE TABLE repo_owner (repo TEXT PRIMARY KEY, host TEXT DEFAULT '', owner TEXT DEFAULT '') WITHOUT ROWID;
        CREATE TABLE paper_repo (repo TEXT, paper_id TEXT, PRIMARY KEY (repo, paper_id)) WITHOUT ROWID;
        CREATE TABLE papers (pid INTEGER PRIMARY KEY);
        CREATE TABLE paper_fts (rowid_ INTEGER);
    """)
    return community.SqliteD1(con, "remote")


def community_state(tmp_path):
    return community.open_state(tmp_path / "state.db")


def sent(state, table, keys):
    state.executemany("INSERT INTO community_sync (target, tbl, key, hash, pushed_at) VALUES ('remote', ?, ?, 'h', 1)",
                      [(table, k) for k in keys])
    state.commit()


def test_keys_recorded_but_absent_from_d1_are_forgotten_to_be_sent_again(remote, tmp_path):
    state = community_state(tmp_path)
    arrived = [(f"0000-{i:04}", f"doi:{i}") for i in range(7)]
    remote.run([f"INSERT INTO paper_orcid (orcid, paper_id) VALUES ('{o}', '{p}')" for o, p in arrived])
    keys = [community._key("paper_orcid", {"orcid": o, "paper_id": p}) for o, p in arrived]
    lost = community._key("paper_orcid", {"orcid": "9999-0001", "paper_id": "doi:it's lost"})
    sent(state, "paper_orcid", [*keys, lost])
    assert reconcile.facts(state, remote, batch=3)["paper_orcid"] == 1
    assert {r[0] for r in state.execute("SELECT key FROM community_sync")} == set(keys)
    assert reconcile.facts(state, remote, batch=3)["paper_orcid"] == 0


def test_a_key_only_d1_holds_is_left_alone(remote, tmp_path):
    state = community_state(tmp_path)
    remote.run(["INSERT INTO repo_owner (repo) VALUES ('github.com/a/b')"])
    assert reconcile.facts(state, remote) == {"paper_orcid": 0, "repo_owner": 0, "paper_repo": 0}


class Broken(community.D1):
    """D1 answers one batch, then fails: as a spent retry would."""

    def __init__(self):
        self.calls = 0

    def query(self, sql):
        self.calls += 1
        if self.calls > 1:
            raise community.D1Error("D1 is down")
        return [{"orcid": "a", "paper_id": "b"}, {"orcid": "c", "paper_id": "d"}]


def test_a_read_that_fails_forgets_nothing(tmp_path):
    state = community_state(tmp_path)
    sent(state, "paper_orcid", ['["x", "y"]'])
    with pytest.raises(community.D1Error):
        reconcile.facts(state, Broken(), batch=2)
    assert state.execute("SELECT COUNT(*) FROM community_sync").fetchone()[0] == 1


def test_reads_go_by_key_never_by_offset():
    seen = []

    class Reader(community.D1):
        def query(self, sql):
            seen.append(sql)
            return [{"orcid": "o'1", "paper_id": "p"}] if len(seen) == 1 else []
    assert len(list(reconcile.remote_rows(Reader(), "paper_orcid", ("orcid", "paper_id"), batch=1))) == 1
    assert "OFFSET" not in " ".join(seen)
    assert "WHERE (orcid, paper_id) > ('o''1', 'p')" in seen[1]


def test_the_search_tables_are_compared_on_their_own_keys(tmp_path):
    state = d1.open_state(tmp_path / "state.db")
    state.executemany("INSERT INTO d1_sync VALUES ('remote', ?, ?, ?, 'h', 1)",
                      [(d1.CATALOG, "papers", "1"), (d1.CATALOG, "papers", "2"), (d1.SEARCH, "paper_fts", "1"),
                       (d1.CATALOG, "meta", "papers")])
    state.commit()

    class Held(community.D1):
        def __init__(self, column, keys):
            self.column, self.keys = column, keys

        def query(self, sql):
            return [{self.column: k} for k in self.keys]
    dbs = {"oscr_catalog": Held("pid", [1]), "oscr_search": Held("rowid", [1])}
    assert reconcile.search(state, dbs.__getitem__) == {"papers": 1, "paper_fts": 0}
    assert sorted(r[0] for r in state.execute("SELECT key FROM d1_sync")) == ["1", "1", "papers"]
