"""The social layer's static files (night phase 08, E3; oscr/social.py): counts without a count row,
public profiles only, no account id, no private list, no hidden repository, no email address."""
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from conftest import forge_database

from oscr import community, social

ROOT = Path(__file__).resolve().parents[1]
COMMUNITY_MIGRATIONS = sorted((ROOT / "migrations" / "d1-community").glob("[0-9][0-9][0-9][0-9]_*.sql"))
NOW = 1_790_596_800
PAPER = "paper:doi:10.1234/eeg.2026"
CARBERRY = "0000-0002-1825-0097"


def community_d1() -> community.SqliteD1:
    con = sqlite3.connect(":memory:")
    for m in COMMUNITY_MIGRATIONS:
        con.executescript(m.read_text())
    return community.SqliteD1(con)


@pytest.fixture
def world(forge_d1):
    people = community_d1()
    people.run([
        "INSERT INTO users (id, display_name, orcid, github_login, created_at) VALUES ('u_ada', 'Ada', NULL, 'Ada-Fixture', 1)",
        "INSERT INTO users (id, display_name, orcid, github_login, created_at) VALUES ('u_bob', 'Bob', NULL, 'bob-fixture', 1)",
        f"INSERT INTO users (id, display_name, orcid, github_login, created_at) VALUES ('u_jo', 'Josiah', '{CARBERRY}', NULL, 1)",
        "INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('github', '9', 'u_ada', 1)",
        "INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('github', '77', 'u_bob', 1)",
        f"INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('orcid', '{CARBERRY}', 'u_jo', 1)",
    ])
    f = forge_d1
    f.run([
        "INSERT INTO repos (forge, repo_id, owner_id, owner_login, name, mode, state, linked_by, created_at, updated_at) "
        "VALUES ('github', '101', '5', 'lab', 'eeg', 'public', 'active', 'u_ada', 1, 1)",
        "INSERT INTO repos (forge, repo_id, owner_id, owner_login, name, mode, state, linked_by, created_at, updated_at) "
        "VALUES ('github', '102', '5', '', '', 'public', 'hidden', 'u_ada', 1, 1)",
        f"INSERT INTO stars (user_id, subject, label, at) VALUES ('u_ada', 'repo:github:101', 'mine', {NOW - 100})",
        f"INSERT INTO stars (user_id, subject, label, at) VALUES ('u_bob', 'repo:github:101', 'x', {NOW - 10 * 86400})",
        f"INSERT INTO stars (user_id, subject, label, at) VALUES ('u_bob', 'repo:github:102', 'secret-name', {NOW - 100})",
        f"INSERT INTO stars (user_id, subject, label, at) VALUES ('u_ada', '{PAPER}', '', {NOW - 50})",
        f"INSERT INTO stars (user_id, subject, label, at) VALUES ('u_ada', 'topic:electroencephalography', '', {NOW - 50})",
        f"INSERT INTO follows (user_id, target, level, at) VALUES ('u_bob', 'github:9', 'all', {NOW - 60})",
        f"INSERT INTO follows (user_id, target, level, at) VALUES ('u_ada', 'orcid:{CARBERRY}', 'all', {NOW - 60})",
        f"INSERT INTO follows (user_id, target, level, at) VALUES ('u_ada', 'orcid:0000-0001-5109-3700', 'all', {NOW - 60})",
        f"INSERT INTO follows (user_id, target, level, at) VALUES ('u_ada', 'repo:github:101', 'participating', {NOW - 60})",
        f"INSERT INTO follows (user_id, target, level, auto, at) VALUES ('u_ada', 'thread:{PAPER}#research:1', 'all', 1, {NOW - 60})",
        f"INSERT INTO follows (user_id, target, level, at) VALUES ('u_ada', 'owner:github:lab', 'all', {NOW - 60})",
        f"INSERT INTO star_lists (user_id, list_id, name, description, public, collection, at) VALUES ('u_ada', 1, 'EEG code', 'Mail ada@example.org', 1, 'accepted', {NOW})",
        f"INSERT INTO star_lists (user_id, list_id, name, description, public, collection, at) VALUES ('u_ada', 2, 'Hidden', '', 0, '', {NOW})",
        f"INSERT INTO star_list_items (user_id, subject, list_id, at) VALUES ('u_ada', 'repo:github:101', 1, {NOW})",
        f"INSERT INTO star_list_items (user_id, subject, list_id, at) VALUES ('u_ada', '{PAPER}', 2, {NOW})",
        f"INSERT INTO profiles (user_id, name, bio, website, links, pinned, private, at) VALUES ('u_ada', 'Ada Fixture', 'EEG, ada@example.org', "
        f"'https://ada.example.org', '[\"https://lab.example.org\", \"javascript:x\"]', '[\"repo:github:101\"]', 0, {NOW})",
        f"INSERT INTO profiles (user_id, name, private, at) VALUES ('u_bob', 'Bob', 1, {NOW})",
    ])
    return f, people


def test_counts_people_and_what_never_leaves(world):
    forge, people = world
    entries, explore = social.build(forge, people, names={PAPER: "An EEG paper"}, now=NOW)
    repo = entries["repo:github:101"]
    assert repo["stars"] == 2 and repo["watchers"] == 1 and repo["name"] == "lab/eeg"
    # Stargazers: public profiles only (Bob's is private).
    assert repo["stargazers"] == ["ada-fixture"]
    assert "repo:github:102" not in entries
    assert entries[PAPER]["name"] == "An EEG paper"
    assert entries["topic:electroencephalography"]["stars"] == 1
    ada = entries["person:ada-fixture"]
    assert ada["followers"] == 1
    assert ada["profile"]["bio"] == "EEG, [email hidden]"
    assert ada["profile"]["links"] == ["https://lab.example.org"]
    assert [x["name"] for x in ada["lists"]] == ["EEG code"]
    assert "orcid:0000-0002-1825-0097" in ada["follows"] and "owner:github:lab" in ada["follows"]
    assert not any(f.startswith("thread:") for f in ada["follows"])
    assert entries["person:bob-fixture"] == {"handles": {"github": "bob-fixture", "orcid": None}, "followers": 0, "private": True}
    # A catalogue author followed by ORCID iD before an account: their followers only.
    assert entries["person:0000-0001-5109-3700"] == {"followers": 1, "account": False}
    assert entries["person:0000-0002-1825-0097"]["followers"] == 1
    assert entries["owner:github:lab"] == {"followers": 1}
    text = json.dumps([entries, explore])
    for secret in ("u_ada", "u_bob", "u_jo", "ada@example.org", "secret-name", "Hidden", "javascript"):
        assert secret not in text, secret


def test_explore_trending_topics_and_collections(world):
    forge, people = world
    _, explore = social.build(forge, people, names={PAPER: "An EEG paper"}, now=NOW)
    assert [r["name"] for r in explore["repositories"]] == ["lab/eeg"]
    assert explore["repositories"][0]["week"] == 1 and explore["repositories"][0]["stars"] == 2
    assert explore["papers"][0]["title"] == "An EEG paper"
    # Bob follows Ada and Ada follows Josiah this week: both profiles are public.
    assert explore["people"] == [{"handle": CARBERRY, "week": 1}, {"handle": "ada-fixture", "week": 1}]
    eeg = next(t for t in explore["topics"] if t["name"] == "eeg")
    assert eeg["featured"] and eeg["stars"] == 1 and "electroencephalography" in eeg["aliases"]
    assert explore["collections"] == [{"name": "EEG code", "description": "Mail [email hidden]", "by": "ada-fixture",
                                       "items": [{"subject": "repo:github:101", "name": "lab/eeg"}]}]


def test_the_files_and_the_shards(world, tmp_path):
    forge, people = world
    said = social.write(forge, people, tmp_path, now=NOW)
    folder = tmp_path / "social"
    assert len(list(folder.glob("[0-9][0-9].json"))) == 64
    assert "64 shards" in said
    for n in range(64):
        for key in json.loads((folder / f"{n:02d}.json").read_text()):
            assert hashlib.sha256(key.encode()).digest()[0] % 64 == n
    assert json.loads((folder / "explore.json").read_text())["collections"]
    # Without the databases: empty files, so that the pages say "nothing yet".
    empty = tmp_path / "empty"
    social.write(None, None, empty, now=NOW)
    assert json.loads((empty / "social" / "00.json").read_text()) == {}
    fixture = json.loads((ROOT / "tests" / "fixtures" / "social-shards.json").read_text())
    for key, n in fixture["pairs"]:
        assert social.shard(key) == n, key


def test_the_owner_accepts_or_declines_a_collection(world):
    forge, people = world
    forge.run(["UPDATE star_lists SET collection = 'proposed' WHERE list_id = 1"])
    assert [x["name"] for x in social.proposed(forge)] == ["EEG code"]
    assert social.decide(forge, people, "Ada-Fixture", 1, accept=True) == "Ada-Fixture's list 1: accepted"
    assert forge.query("SELECT collection FROM star_lists WHERE list_id = 1")[0]["collection"] == "accepted"
    with pytest.raises(social.SocialError):
        social.decide(forge, people, "ada-fixture", 2, accept=True)
    with pytest.raises(social.SocialError):
        social.decide(forge, people, "nobody", 1, accept=True)


def test_reads_every_page_in_key_order():
    d1 = community.SqliteD1(forge_database())
    d1.run([f"INSERT INTO stars (user_id, subject, label, at) VALUES ('u{i:04d}', 'topic:t{i % 7}', '', {i})" for i in range(2_500)])
    got = social.rows(d1, "stars", "user_id, subject", ("user_id", "subject"))
    assert len(got) == 2_500 and got == sorted(got, key=lambda r: (r["user_id"], r["subject"]))
