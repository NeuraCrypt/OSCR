"""What moderation hid, in the Mac's public files (night phase 16; oscr/moderation.py): the forge layer
says only that a repository is hidden and why, the research shards leave out a hidden issue and the
words of a hidden comment, the social layer leaves out a suspended account (its stars no longer count),
a hidden profile's words and a hidden list; forge/moderation.json carries the public notices (never the
hidden words, never who reported) and the hidden repositories with their papers."""
import json
import sys
from pathlib import Path

from test_forgelayer import PAPER_1, T, _entries, _mac, _reader, _repo, _research, _state
from test_social import NOW, world  # noqa: F401  (a fixture)

from oscr import community, forgelayer, moderation, social

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))


def _hide(d1: community.SqliteD1, kind: str, ref: str, target: str, reason: str = "spam", *, state: str = "hidden",
          notice: str = "", at: int = int(T)) -> None:
    d1.run([f"INSERT INTO moderation (kind, ref, target, label, state, reason, notice, by_whom, created_at, updated_at) VALUES "
            f"({community.literal(kind)}, {community.literal(ref)}, {community.literal(target)}, 'a secret label', "
            f"{community.literal(state)}, {community.literal(reason)}, {community.literal(notice)}, 'owner', {at}, {at})"])


def test_read_and_the_public_notices_never_carry_the_hidden_words(forge_d1):
    _hide(forge_d1, "account", "u_spam", "person:github:9")
    _hide(forge_d1, "github", "9", "person:github:9")
    _hide(forge_d1, "repo", "github:101", "repo:github:101", "malware", notice="A repository holding known malware was hidden.")
    _hide(forge_d1, "comment", "3#2", "research:3#2", "abuse")
    _hide(forge_d1, "research", "4", "research:4", "private_information", state="restored")
    h = moderation.read(forge_d1)
    assert h.accounts == {"u_spam"} and h.github == {"9"} and set(h.repos) == {"github:101"}
    assert h.comments == {(3, 2): "harassment, threats or abuse"} and h.research == set()
    notes = moderation.notices(h)
    assert len(notes) == 4, "the GitHub account's row is its account's own"
    text = json.dumps(notes)
    assert "a secret label" not in text and "u_spam" not in text and "github:101" not in text
    assert {n["state"] for n in notes} == {"hidden", "restored"}
    assert moderation.read(None).rows == []


def test_a_hidden_repository_says_only_why_and_its_papers_learn_it(tmp_path, forge_d1):
    con, state, reader = _mac(tmp_path), _state(), _reader()
    forgelayer.resolve_ids(con, state, reader, now=T)
    _repo(forge_d1, "101", "oscr-fixture", "eeg-analysis")
    forge_d1.run(["INSERT INTO repo_papers (forge, repo_id, paper_id, status, by_user, at) VALUES ('github', '101', 'doi:10.5555/oscr.fixture.1', 'linked', 'u', 1)"])
    _research(forge_d1, 1, PAPER_1)
    _hide(forge_d1, "repo", "github:101", "repo:github:101", "malware")
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entry = _entries(out)["oscr-fixture/eeg-analysis"]
    assert entry == {"moderated": {"words": "malware or a harmful file", "since": int(T)}}
    exported = json.loads((out / "forge" / "moderation.json").read_text())
    assert exported["repos"]["oscr-fixture/eeg-analysis"]["papers"] == ["10.5555/oscr.fixture.1"]
    assert exported["notices"][0]["what"] == "a repository"
    # Its research issues leave with it.
    assert not any(json.loads(p.read_text()) for p in (out / "forge" / "research").iterdir())


def test_research_shards_leave_out_hidden_issues_and_the_words_of_hidden_comments(tmp_path, forge_d1):
    con, state = _mac(tmp_path), _state()
    _research(forge_d1, 1, PAPER_1, repo=None, path="", start_line=None, end_line=None, paragraph=None, type="code_error")
    _research(forge_d1, 2, PAPER_1, repo=None, path="", start_line=None, end_line=None, paragraph=None, type="code_error")
    _research(forge_d1, 3, PAPER_1, repo=None, path="", start_line=None, end_line=None, paragraph=None, type="code_error", author_id="u_spam")
    forge_d1.run(["INSERT INTO research_comments (issue_id, n, author_id, author, author_via, body, created_at) VALUES "
                  "(1, 1, 'u_ok', 'bob', 'github', 'A private address: 12 rue X', 1), (1, 2, 'u_spam', 'spammer', 'github', 'Buy now', 2), "
                  "(1, 3, 'u_ok', 'bob', 'github', 'Fine words', 3)"])
    _hide(forge_d1, "research", "2", "research:2")
    _hide(forge_d1, "comment", "1#1", "research:1#1", "private_information")
    _hide(forge_d1, "account", "u_spam", "person:github:9")
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    shards = {k: v for p in (out / "forge" / "research").iterdir() for k, v in json.loads(p.read_text()).items()}
    assert sorted(shards) == ["1"], "a hidden issue, and one by a suspended account, are left out"
    comments = shards["1"]["comments"]
    assert [c["body"] for c in comments] == ["", "", "Fine words"]
    assert comments[0]["moderated"]["words"].startswith("private information")
    assert "suspended" in comments[1]["moderated"]["words"]
    assert "12 rue X" not in json.dumps(shards) and "Buy now" not in json.dumps(shards)


def test_the_social_layer_leaves_out_a_suspended_account_a_hidden_profile_and_a_hidden_list(world):  # noqa: F811
    forge, people = world
    _hide(forge, "account", "u_bob", "person:github:77")
    _hide(forge, "profile", "u_ada", "person:github:9", "impersonation")
    _hide(forge, "list", "u_ada/1", "list:github:9/1")
    entries, explore = social.build(forge, people, now=NOW)
    assert entries["repo:github:101"]["stars"] == 1, "Bob's star no longer counts"
    assert "person:bob-fixture" not in entries
    ada = entries["person:ada-fixture"]
    assert ada["profile"]["name"] == "" and ada["profile"]["bio"] == "" and ada["profile"]["website"] == ""
    assert ada["lists"] == [] and explore["collections"] == []
    assert ada["followers"] == 0, "Bob followed Ada: his follow no longer counts"


def test_a_hidden_github_thread_is_named_in_its_repository_entry(tmp_path, forge_d1):
    con, state, reader = _mac(tmp_path), _state(), _reader()
    forgelayer.resolve_ids(con, state, reader, now=T)
    _repo(forge_d1, "101", "oscr-fixture", "eeg-analysis")
    _hide(forge_d1, "issue", "github:101#4", "issue:github:101#4", "spam")
    _hide(forge_d1, "release", "github:101/v1.0", "release:github:101/v1.0", "malware")
    _hide(forge_d1, "pull", "github:101#9", "pull:github:101#9", "spam", state="restored")
    out = tmp_path / "public"
    forgelayer.write(con, forge_d1, out, state=state, now=T)
    entry = _entries(out)["oscr-fixture/eeg-analysis"]
    assert entry["moderated_threads"] == {"issue:4": "spam or advertising", "release:v1.0": "malware or a harmful file"}
    assert entry["mode"] == "public", "the repository itself stays shown"
