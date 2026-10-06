"""The GitHub side's jobs on the Mac (night phase 01, oscr/forgejobs.py; docs/FORGE.md "The Mac's
jobs"): each kind of job read from D1 `oscr_forge` and answered in its own row, a repository linked
to its papers through Phase 6's path, the pinned commits checked after a push, Software Heritage
asked on request only, the end of a grace period, renames and vanished repositories followed by
id, and the public mirrors' heads by conditional requests (a 304 writes nothing).

D1 is SQLite made from the real migrations (`forge_d1`, and oscr_community for the linker's
roles); the forge is the in-memory reader dressed as GitHub; Software Heritage and git are fakes.
Nothing here touches the network or runs git."""
import json
import sqlite3
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from conftest import forge_database

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402

from oscr import community, db, forge, forgejobs, net  # noqa: E402
from oscr.forge import ForgeError, RepoKey, RepoRef  # noqa: E402

COMMUNITY_MIGRATIONS = sorted((ROOT / "migrations" / "d1-community").glob("[0-9][0-9][0-9][0-9]_*.sql"))
ADA, BEN = make_fixture.ADA, make_fixture.BEN
P1, P2, P9 = "doi:10.5555/oscr.fixture.1", "doi:10.5555/oscr.fixture.2", "doi:10.5555/oscr.fixture.9"
T = 1_790_596_800          # 2026-09-28 12:00 UTC
DAY = 86_400
SHA_A, SHA_B, SHA_C = "a" * 40, "b" * 40, "c" * 40
NEW = "github.com/oscr-fixture/new-code"


class GitHubMemory(forge.MemoryReader):
    """The in-memory forge, dressed as GitHub: the same repositories under the forge `github`,
    at github.com addresses (the registry's links read those). `limited`: the REST quota spent."""

    def __init__(self) -> None:
        super().__init__()
        self.limited = False

    def _dress(self, id: str) -> None:
        r = self._repos[id]
        i = r.info
        r.info = replace(i, key=RepoKey("github", id), ref=RepoRef("github", i.ref.owner, i.ref.name),
                         web_url=f"https://github.com/{i.ref.owner}/{i.ref.name}")

    def add(self, owner, name, *, id, **kw):
        super().add(owner, name, id=id, **kw)
        self._dress(id)
        return self._repos[id].info.ref

    def rename(self, id, owner, name):
        super().rename(id, owner, name)
        self._dress(id)

    def hide(self, id: str) -> None:
        r = self._repos[id]
        r.info = replace(r.info, visibility="private")

    def vanish(self, id: str) -> None:
        self._repos.pop(id)
        self._paths = {k: v for k, v in self._paths.items() if v != id}

    def repo_by_id(self, key):
        self.calls.append(("repo_by_id", (key,)))
        if key.forge != "github" or key.id not in self._repos:
            raise ForgeError("not_found", "no such repository")
        return self._repos[key.id].info

    def head(self, ref, branch=None, etag=None):
        if self.limited:
            self.calls.append(("head", (ref, branch, etag)))
            raise ForgeError("rate_limited", "the REST quota is spent")
        return super().head(ref, branch, etag)


class FakeHarvester:
    """The harvester's steps, offline: a verified repository (MIT, redistributable) and its one
    script, as the real verification records them."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def harvest(self, con, doi):
        raise AssertionError("a forge job never harvests a paper")

    def verify(self, con, link, article_id):
        self.calls.append(("verify", link.repo, article_id))
        con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind) VALUES (?,?,?,?)",
                    (link.repo, link.url, link.host, link.kind))
        db.save_repository(con, link.repo, {
            "state": "alive", "http_status": 200, "license": "MIT", "redistributable": "yes", "commit_id": SHA_A,
            "n_files": 1, "n_scripts": 1, "languages": {"Python": 1}, "files": ["main.py"]})
        con.commit()

    def conclude(self, con, article_id):
        self.calls.append(("conclude", article_id))

    def align(self, con, article_id, repos=None, *, save=True):
        self.calls.append(("align", article_id, save))
        return 0


class World:
    def __init__(self, tmp_path: Path) -> None:
        self.mac = make_fixture.database(tmp_path / "mac.db")
        self.forge = community.SqliteD1(forge_database())
        people = sqlite3.connect(":memory:")
        for migration in COMMUNITY_MIGRATIONS:
            people.executescript(migration.read_text())
        self.people = community.SqliteD1(people)
        self.state = forgejobs.open_state(tmp_path / "state.db")
        self.reader = GitHubMemory()
        self.harvester = FakeHarvester()
        self.swh: list[str] = []
        self.swh_answer = net.Response(url="", status=200, text=json.dumps(
            {"save_request_status": "accepted", "save_task_status": "pending", "id": 77}))
        self.git: list[tuple[list[str], dict]] = []
        self.git_out = ""
        self.log: list[str] = []
        self.t = T
        self.runner = forgejobs.Runner(self.mac, self.forge, self.state, self.harvester, community=self.people,
                                       readers=lambda f: self.reader, post=self.post, git=self.run_git,
                                       budget=10_000, report=self.log.append, now=lambda: self.t)
        self.person("u_ada", "Ada Fixture", orcid=ADA)
        self.person("u_otto", "Otto Other", github="otto-other")

    def post(self, url: str) -> net.Response:
        self.swh.append(url)
        return replace(self.swh_answer, url=url)

    def run_git(self, args, **kw):
        self.git.append((args, kw))
        return subprocess.CompletedProcess(args, 0, stdout=self.git_out, stderr="")

    # oscr_community, as the Worker writes it.
    def person(self, uid: str, name: str, orcid: str | None = None, github: str | None = None) -> None:
        self.people.con.execute("INSERT INTO users (id, display_name, orcid, github_login, created_at) VALUES "
                                "(?,?,?,?,?)", (uid, name, orcid, github, T))
        self.people.con.commit()

    def role(self, uid: str, role: str, scope: str) -> None:
        kind = "repo" if role == "maintainer" else "paper"
        self.people.con.execute("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_at, granted_by) "
                                "VALUES (?,?,?,?,?,?)", (uid, role, kind, scope, T, "system"))
        self.people.con.commit()

    # oscr_forge, as the Worker writes it.
    def repo(self, id: str, owner: str, name: str, *, mode: str = "public", state: str = "active",
             head: str | None = None, branch: str | None = "main", delete_after: int | None = None,
             updated_at: int = T) -> None:
        self.forge.con.execute(
            "INSERT INTO repos (forge, repo_id, owner_id, owner_login, name, mode, installation_id, default_branch, "
            "head, head_at, state, delete_after, linked_by, created_at, updated_at) VALUES "
            "('github',?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (id, "900", owner, name, mode, "4242" if mode == "installed" else None, branch, head,
             T if head else None, state, delete_after, "u_ada", T, updated_at))
        self.forge.con.commit()

    def paper(self, id: str, paper: str, *, status: str = "linked", by: str = "u_ada") -> None:
        self.forge.con.execute("INSERT INTO repo_papers (forge, repo_id, paper_id, status, by_user, at) VALUES "
                               "('github',?,?,?,?,?)", (id, paper, status, by, T))
        self.forge.con.commit()

    def job(self, kind: str, repo_id: str, *, not_before: int | None = None, user: str = "u_ada") -> int:
        jid = self.forge.con.execute("INSERT INTO jobs (kind, forge, repo_id, user_id, created_at, not_before) VALUES "
                                     "(?, 'github', ?, ?, ?, ?)", (kind, repo_id, user, T, not_before)).lastrowid
        self.forge.con.commit()
        return int(jid)

    def answer(self, job_id: int) -> dict:
        return dict(self.forge.con.execute("SELECT done_at, outcome, message FROM jobs WHERE id = ?",
                                           (job_id,)).fetchone())

    def row(self, id: str) -> dict:
        return dict(self.forge.con.execute("SELECT * FROM repos WHERE forge = 'github' AND repo_id = ?",
                                           (id,)).fetchone())

    def poll(self) -> tuple[forgejobs.Poll, int]:
        """A poll, and the rows it wrote to oscr_forge."""
        before = self.forge.con.total_changes
        out = forgejobs.poll(self.runner)
        return out, self.forge.con.total_changes - before

    def heads(self) -> tuple[forgejobs.Mirrors, int]:
        before = self.forge.con.total_changes
        out = forgejobs.mirrors(self.runner)
        return out, self.forge.con.total_changes - before


@pytest.fixture
def w(tmp_path):
    return World(tmp_path)


def _every_text(con: sqlite3.Connection) -> str:
    out = []
    for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
        for row in con.execute(f"SELECT * FROM {table}"):
            out += [str(v) for v in row]
    return "\n".join(out)


# ---------------------------------------------------------------------------------------------
# link: a repository created or linked, its papers given it through Phase 6's path.

def test_a_link_job_adds_the_repository_to_its_papers_through_phase_6_and_answers_in_one_row(w):
    w.reader.add("oscr-fixture", "new-code", id="501", files={"main.py": b"print(1)\n"}, sha=SHA_A, license_spdx="MIT")
    w.repo("501", "oscr-fixture", "new-code", mode="created")
    w.paper("501", P1)                          # Ada is among P1's authors (her ORCID iD)
    w.paper("501", P2, status="proposed")       # proposed: left to the paper's authors
    w.paper("501", P9)                          # outside the registry's scope
    job = w.job("link", "501")
    out, written = w.poll()
    assert (out.new, out.done, written) == (1, 1, 1)
    said = w.answer(job)
    assert said["outcome"] == "done" and said["done_at"] == T
    assert said["message"].startswith("Verified oscr-fixture/new-code (at aaaaaaaaaaaa on main).")
    assert f"Added as code to {P1}" in said["message"]
    assert f"{P2} (proposed: for its authors)" in said["message"]
    assert f"{P9} (outside the registry's scope)" in said["message"]
    # Phase 6's path: the link on the record, as a new version with its provenance, verified, aligned.
    assert w.mac.execute("SELECT role FROM link WHERE article_id = ? AND repo = ?", (P1, NEW)).fetchone()["role"] == "code"
    assert w.mac.execute("SELECT 1 FROM link WHERE article_id = ? AND repo = ?", (P2, NEW)).fetchone() is None
    edit = w.mac.execute("SELECT * FROM link_edit WHERE article_id = ? AND repo = ?", (P1, NEW)).fetchone()
    assert edit is not None
    assert ("verify", NEW, P1) in w.harvester.calls and ("align", P1, True) in w.harvester.calls
    # The job itself reads no file of the repository: copies are the harvester's (verified licences only).
    assert not [c for c in w.reader.calls if c[0] in ("files", "read")]
    # Polled again: nothing new, nothing written.
    again, written = w.poll()
    assert (again.new, again.done, written) == (0, 0, 0)


def test_a_link_job_leaves_aside_a_paper_whose_linker_has_no_confirmed_role(w):
    w.reader.add("oscr-fixture", "new-code", id="501", files={}, sha=SHA_A)
    w.repo("501", "oscr-fixture", "new-code", mode="created")
    w.paper("501", P1, by="u_otto")             # Otto is neither an author of P1 nor a maintainer
    job = w.job("link", "501", user="u_otto")
    w.poll()
    assert "(the linker's role is not confirmed)" in w.answer(job)["message"]
    assert w.mac.execute("SELECT 1 FROM link WHERE article_id = ? AND repo = ?", (P1, NEW)).fetchone() is None
    # A maintainer of the repository may attach it.
    w.role("u_otto", "maintainer", NEW)
    job = w.job("link", "501", user="u_otto")
    w.poll()
    assert f"Added as code to {P1}" in w.answer(job)["message"]


def test_a_link_job_refuses_a_repository_that_is_not_public_or_unknown(w):
    w.reader.add("oscr-fixture", "secret", id="502", files={}, sha=SHA_A)
    w.reader.hide("502")
    w.repo("502", "oscr-fixture", "secret", mode="created")
    refused = w.job("link", "502")
    unknown = w.job("link", "999")
    out, written = w.poll()
    assert (out.failed, out.skipped, written) == (1, 1, 2)
    assert w.answer(refused)["outcome"] == "failed"
    assert "not public" in w.answer(refused)["message"]
    assert w.answer(unknown)["outcome"] == "skipped"


# ---------------------------------------------------------------------------------------------
# push: the head again, and the commits the tracing maps are pinned to.

def test_a_push_job_checks_the_pinned_commits_and_records_them_for_the_layer(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={"a.py": b"x"}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    for path, sha in (("a.py", SHA_A), ("b.py", SHA_B)):
        w.forge.con.execute("INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) VALUES "
                            "('github', '101', ?, ?, ?, 1)", (path, P1, sha))
    w.forge.con.commit()
    job = w.job("push", "101")
    out, written = w.poll()
    assert (out.done, written) == (1, 1)
    said = w.answer(job)["message"]
    assert "Head aaaaaaaaaaaa on main." in said
    assert "1 of 2 pinned commit(s) still at the source; no longer at the source: bbbbbbbbbbbb." in said
    assert forgejobs.commits(w.state, "local", "github", "101") == {SHA_A: True, SHA_B: False}
    # Nothing pinned and no script copy: nothing to check.
    w.reader.add("lab", "plain", id="102", files={}, sha=SHA_C)
    w.repo("102", "lab", "plain")
    job = w.job("push", "102")
    w.poll()
    assert w.answer(job)["outcome"] == "skipped"


# ---------------------------------------------------------------------------------------------
# archive: Software Heritage, on a person's request only.

def test_an_archive_job_asks_software_heritage_once_and_records_its_answer(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    job = w.job("archive", "101")
    out, written = w.poll()
    assert (out.done, written) == (1, 1)
    assert w.swh == ["https://archive.softwareheritage.org/api/1/origin/save/git/url/"
                     "https://github.com/oscr-fixture/eeg-analysis/"]
    assert "Software Heritage took the request" in w.answer(job)["message"]
    [answer] = forgejobs.archive_answers(w.state, "local")
    assert (answer["http_status"], answer["request_status"], answer["task_status"], answer["request_id"]) == \
        (200, "accepted", "pending", "77")
    # Asked once: polling again sends nothing.
    w.poll()
    assert len(w.swh) == 1


def test_software_heritage_busy_or_not_asked_is_tried_again_later(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    w.swh_answer = net.Response(url="", status=429, text="")
    job = w.job("archive", "101")
    out, written = w.poll()
    assert (out.retry, written) == (1, 0)
    assert w.answer(job)["outcome"] == ""
    # A rate limit does not count as an attempt.
    assert w.state.execute("SELECT attempts FROM forge_job WHERE id = ?", (job,)).fetchone()["attempts"] == 0
    # A Mac that sends no request to Software Heritage leaves the job waiting.
    w.runner.post = None
    out, written = w.poll()
    assert (out.retry, written, len(w.swh)) == (1, 0, 1)


def test_an_archive_job_for_a_release_names_its_tag(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    jid = w.forge.con.execute("INSERT INTO jobs (kind, forge, repo_id, ref, user_id, created_at) VALUES "
                              "('archive', 'github', '101', 'v1.0.0', 'u_ada', ?)", (T,)).lastrowid
    w.forge.con.commit()
    w.poll()
    assert "its tag v1.0.0 with it" in w.answer(jid)["message"]


# ---------------------------------------------------------------------------------------------
# release and deposit (night phase 07): the map versioned with a release; its Zenodo deposit.

EEG = "github.com/oscr-fixture/eeg-analysis"


def _tie(w, *, tag="v1.0.0", paper=P1, digest="", commit=SHA_A, version="accepted"):
    w.forge.con.execute("INSERT INTO release_papers (forge, repo_id, tag, paper_id, release_id, repo_path, version, label, "
                        "commit_sha, map_digest, status, by_user, at) VALUES ('github', '101', ?, ?, '9001', "
                        "'oscr-fixture/eeg-analysis', ?, 'revision 2', ?, ?, 'linked', 'u_ada', ?)",
                        (tag, paper, version, commit, digest, T))
    w.forge.con.commit()


def _release_job(w, kind, *, tag="v1.0.0", paper=P1, proof="", user="u_ada") -> int:
    jid = w.forge.con.execute("INSERT INTO jobs (kind, forge, repo_id, ref, user_id, created_at, paper_id, proof) VALUES "
                              "(?, 'github', '101', ?, ?, ?, ?, ?)", (kind, tag, user, T, paper, proof)).lastrowid
    w.forge.con.commit()
    return int(jid)


def _digest(w, paper=P1):
    from oscr import zenodo
    return zenodo.map_digest(zenodo.map_of(w.mac, paper))


def test_a_release_job_versions_the_papers_map_with_the_release_and_answers_its_digest(w):
    _tie(w)
    job = _release_job(w, "release")
    out, written = w.poll()
    assert (out.done, written) == (1, 2)          # the tie's digest, the answer
    said = w.answer(job)["message"]
    digest = _digest(w)
    assert said.startswith(f"The tracing map of {P1} is versioned with the release v1.0.0: digest {digest[:12]}, 2 ")
    # The fixture's map points to lines at another commit than the release's: said.
    assert "the release at aaaaaaaaaaaa" in said
    tie = w.forge.con.execute("SELECT map_digest FROM release_papers WHERE tag = 'v1.0.0'").fetchone()
    assert tie["map_digest"] == digest
    [v] = forgejobs.map_versions(w.state, "local")
    assert (v["tag"], v["paper_id"], v["digest"], v["pairs"], v["release_commit"]) == ("v1.0.0", P1, digest, 2, SHA_A)
    card = json.loads(v["card"])
    assert card["release"] == {"repo": "https://github.com/oscr-fixture/eeg-analysis", "tag": "v1.0.0", "commit": SHA_A,
                               "version": "accepted", "label": "revision 2"}
    # Links and metadata: neither the paper's text nor the code.
    assert "abstract" not in card["paper"] and not any("content" in f for c in card["code"] for f in c["files"])
    # Asked again: the same map, nothing more to write.
    again = _release_job(w, "release")
    out, written = w.poll()
    assert written == 1 and w.answer(again)["outcome"] == "done"


def test_a_release_job_says_when_the_map_changed_since_the_page_and_skips_an_untied_or_off_topic_paper(w):
    _tie(w, digest="f" * 64)
    job = _release_job(w, "release")
    w.poll()
    assert "The map changed since the page showed it" in w.answer(job)["message"]
    untied = _release_job(w, "release", tag="v9")
    w.poll()
    assert w.answer(untied)["outcome"] == "skipped"
    _tie(w, tag="v2", paper=P9)
    off = _release_job(w, "release", tag="v2", paper=P9)
    w.poll()
    assert w.answer(off)["outcome"] == "skipped"
    assert "scope" in w.answer(off)["message"]


def _author(w, uid="u_ada", orcid=ADA):
    w.role(uid, "verified_author", P1)
    w.people.con.execute("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('orcid', ?, ?, ?)",
                         (orcid, uid, T))
    w.people.con.commit()


def _zenodo(w, token="test-token"):
    import httpx
    from test_jobs import FakeZenodo

    from oscr import zenodo
    fake = FakeZenodo()
    zenodo.INTERVAL_S = 0
    w.runner.invenio = lambda instance: zenodo.Invenio(instance, api_token=token, transport=httpx.MockTransport(fake))
    return fake


def test_a_deposit_job_deposits_the_release_map_on_the_sandbox_as_a_test_with_the_release(w):
    fake = _zenodo(w)
    _author(w)
    _tie(w, digest=_digest(w))
    job = _release_job(w, "deposit", proof="orcid-sandbox")
    out, written = w.poll()
    assert (out.done, written) == (1, 1)
    said = w.answer(job)["message"]
    assert said == f"The tracing map of {P1}, with the release v1.0.0, is deposited on Zenodo (sandbox): DOI 10.5072/zenodo.r1."
    # Phase 6's own validation: the author's ORCID iD, as a test (ORCID's sandbox), which only the sandbox takes.
    v = w.mac.execute("SELECT orcid, proof, name FROM validation WHERE article_id = ?", (P1,)).fetchone()
    assert (v["orcid"], v["proof"], v["name"]) == (ADA, "test", "Fixture, Ada")
    metadata = fake.drafts[0]["metadata"]
    assert metadata["version"] == "v1.0.0"
    assert metadata["title"].endswith("(release v1.0.0)")
    related = {(r["identifier"], r["relation_type"]["id"]) for r in metadata["related_identifiers"]}
    assert ("10.5555/oscr.fixture.1", "issupplementto") in related
    assert (f"https://github.com/oscr-fixture/eeg-analysis/tree/{SHA_A}", "references") in related
    assert "the accepted manuscript" in metadata["description"] and "never" not in metadata["description"].lower()
    creators = [c["person_or_org"] for c in metadata["creators"]]
    assert {"scheme": "orcid", "identifier": ADA} in [i for c in creators for i in c.get("identifiers", [])]
    assert creators[-1] == {"type": "organizational", "name": "Open Scientific Code Registry (OSCR)"}
    # The map itself is the deposited file; the code is never redeposited.
    assert fake.maps and fake.maps[0]["release"]["tag"] == "v1.0.0"
    [kept] = forgejobs.map_versions(w.state, "local")
    assert (kept["instance"], kept["doi"]) == ("sandbox", "10.5072/zenodo.r1")


def test_a_deposit_job_refuses_without_the_authors_role_their_orcid_or_the_map_they_saw(w):
    fake = _zenodo(w)
    _tie(w, digest=_digest(w))
    norole = _release_job(w, "deposit", proof="orcid-sandbox")
    w.poll()
    assert w.answer(norole)["outcome"] == "failed" and "verified author" in w.answer(norole)["message"]
    w.role("u_ada", "verified_author", P1)
    noorcid = _release_job(w, "deposit", proof="orcid-sandbox")
    w.poll()
    assert w.answer(noorcid)["outcome"] == "failed" and "ORCID" in w.answer(noorcid)["message"]
    w.people.con.execute("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('orcid', ?, 'u_ada', ?)", (ADA, T))
    w.people.con.commit()
    w.forge.con.execute("UPDATE release_papers SET map_digest = ?", ("e" * 64,))
    w.forge.con.commit()
    changed = _release_job(w, "deposit", proof="orcid-sandbox")
    w.poll()
    assert w.answer(changed)["outcome"] == "failed" and "The map changed" in w.answer(changed)["message"]
    assert fake.calls == []
    # No token on the Mac: waits, without counting an attempt.
    w.forge.con.execute("UPDATE release_papers SET map_digest = ?", (_digest(w),))
    w.forge.con.commit()
    _zenodo(w, token="")
    waiting = _release_job(w, "deposit", proof="orcid-sandbox")
    out, _ = w.poll()
    assert out.retry == 1 and w.answer(waiting)["outcome"] == ""
    assert w.state.execute("SELECT attempts FROM forge_job WHERE id = ?", (waiting,)).fetchone()["attempts"] == 0


# ---------------------------------------------------------------------------------------------
# delete_due: the end of a grace period hides; the deletion stays the researcher's.

def test_delete_due_does_nothing_before_its_date_and_hides_after_it(w):
    w.repo("101", "oscr-fixture", "eeg-analysis", state="pending_deletion", delete_after=T + 30 * DAY)
    job = w.job("delete_due", "101", not_before=T + 30 * DAY)
    out, written = w.poll()
    assert (out.wait, written) == (1, 0)
    assert w.reader.calls == []
    assert w.row("101")["state"] == "pending_deletion"
    w.t = T + 30 * DAY
    out, written = w.poll()
    assert (out.done, written) == (1, 2)          # the repository hidden, and the answer
    assert w.row("101")["state"] == "hidden"
    assert "Deleting it on GitHub stays your own act" in w.answer(job)["message"]
    # Restored before the date: nothing to do.
    w.repo("102", "lab", "restored")
    job = w.job("delete_due", "102", not_before=T)
    out, written = w.poll()
    assert (out.skipped, written) == (1, 1)
    assert w.row("102")["state"] == "active"


# ---------------------------------------------------------------------------------------------
# reconcile, and a repository followed by its id.

def test_reconcile_follows_a_rename_by_id_and_marks_a_vanished_repository_gone(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    w.reader.rename("101", "New-Lab", "EEG-Study")
    job = w.job("reconcile", "101")
    out, written = w.poll()
    assert (out.done, written) == (1, 2)
    row = w.row("101")
    assert (row["owner_login"], row["name"]) == ("new-lab", "eeg-study")
    assert "oscr-fixture/eeg-analysis is now new-lab/eeg-study" in w.answer(job)["message"]
    # Gone from the forge.
    w.reader.vanish("101")
    job = w.job("reconcile", "101")
    w.poll()
    assert w.row("101")["state"] == "gone"
    assert "no longer has" in w.answer(job)["message"]
    # No longer public: hidden, its name blanked.
    w.reader.add("lab", "private-now", id="103", files={}, sha=SHA_A)
    w.repo("103", "lab", "private-now")
    w.reader.hide("103")
    w.job("reconcile", "103")
    w.poll()
    row = w.row("103")
    assert (row["state"], row["owner_login"], row["name"]) == ("hidden", "", "")


# ---------------------------------------------------------------------------------------------
# The public mirrors' heads.

def test_the_mirrors_read_heads_by_etag_and_write_one_row_per_changed_head(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    w.job("link", "101")                          # every repository OSCR knows came with a job
    first, written = w.heads()
    assert (first.checked, first.unchanged, first.changed, written) == (1, 1, 0, 0)
    # The second read carries the ETag: GitHub's 304 costs nothing and writes nothing.
    second, written = w.heads()
    assert (second.unchanged, written) == (1, 0)
    assert w.reader.calls[-1] == ("head", (RepoRef("github", "oscr-fixture", "eeg-analysis"), "main", f'"{SHA_A}"'))
    # A push: one row.
    w.reader.push("101", "main", SHA_B, {})
    w.t = T + 60
    third, written = w.heads()
    assert (third.changed, written) == (1, 1)
    row = w.row("101")
    assert (row["head"], row["head_at"]) == (SHA_B, T + 60)


def test_the_mirrors_leave_out_installed_repositories_heard_from_this_week(w):
    w.reader.add("lab", "installed", id="201", files={}, sha=SHA_A)
    w.reader.add("lab", "quiet", id="202", files={}, sha=SHA_A)
    w.repo("201", "lab", "installed", mode="installed", head=SHA_A)
    w.repo("202", "lab", "quiet", mode="installed", head=SHA_A, updated_at=T - 8 * DAY)
    w.job("link", "201")
    w.job("link", "202")
    out, _ = w.heads()
    assert out.checked == 1
    assert {c[1][0].name for c in w.reader.calls if c[0] == "head"} == {"quiet"}


def test_the_rest_quota_spent_the_heads_are_read_with_git_ls_remote_without_any_token(w, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "must-not-ride-along")
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    w.job("link", "101")
    w.reader.limited = True
    w.git_out = f"{SHA_C}\trefs/heads/main\n"
    out, written = w.heads()
    assert (out.by_git, out.changed, written) == (1, 1, 1)
    assert w.row("101")["head"] == SHA_C
    [(args, kw)] = w.git
    assert args[0] == "git" and args[-3:] == ["ls-remote", "https://github.com/oscr-fixture/eeg-analysis.git",
                                              "refs/heads/main"]
    assert all(flag in args for flag in forge.GIT_FLAGS)
    assert "GITHUB_TOKEN" not in kw["env"] and "must-not-ride-along" not in json.dumps(kw["env"])
    assert kw["env"]["GIT_ASKPASS"] == "false"


def test_the_mirrors_follow_a_repository_whose_path_no_longer_answers(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    w.job("link", "101")
    w.reader.vanish("101")
    out, written = w.heads()
    assert (out.followed, written) == (1, 1)
    assert w.row("101")["state"] == "gone"


# ---------------------------------------------------------------------------------------------
# The budget, the attempts, what no row holds.

def test_the_days_budget_stops_the_run_and_the_jobs_wait_for_tomorrow(w):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    job = w.job("reconcile", "101")
    community.spend(w.state, "local", 10_000 - forgejobs.JOB_ROWS + 1, now=T)
    w.state.commit()
    out, written = w.poll()
    assert (out.deferred, out.done, written) == (1, 0, 0)
    assert w.answer(job)["outcome"] == ""
    w.t = T + DAY
    out, written = w.poll()
    assert (out.done, written) == (1, 1)
    # The mirrors stop too.
    community.spend(w.state, "local", 10_000, now=w.t)
    w.state.commit()
    mirrors, written = w.heads()
    assert (mirrors.deferred, mirrors.checked, written) == (1, 0, 0)


def test_a_failing_forge_is_tried_again_then_given_up_in_words(w, monkeypatch):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)

    def down(key):
        raise ForgeError("unavailable", "GitHub is down")

    monkeypatch.setattr(w.reader, "repo_by_id", down)
    job = w.job("reconcile", "101")
    for _ in range(forgejobs.MAX_ATTEMPTS - 1):
        out, written = w.poll()
        assert (out.retry, written) == (1, 0)
    out, written = w.poll()
    assert (out.failed, written) == (1, 1)
    said = w.answer(job)
    assert said["outcome"] == "failed" and "could not complete this" in said["message"]


def test_no_email_address_reaches_a_row(w, monkeypatch):
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)

    def down(key):
        raise ForgeError("unavailable", "write to ada.fixture@example.org for access")

    monkeypatch.setattr(w.reader, "repo_by_id", down)
    monkeypatch.setattr(forgejobs, "MAX_ATTEMPTS", 1)
    job = w.job("reconcile", "101")
    w.poll()
    assert w.answer(job)["outcome"] == "failed"
    assert "@" not in _every_text(w.forge.con) and "example.org" not in _every_text(w.forge.con)
    assert "@" not in forgejobs.words("mail ada@example.org")


# ---------------------------------------------------------------------------------------------
# The command line.

def test_the_command_polls_reads_the_mirrors_and_says_its_status(w, tmp_path, monkeypatch):
    opened = []

    def open_d1(target, **kw):
        opened.append((target, kw.get("database", "oscr_community")))
        return w.forge if kw.get("database") == "oscr_forge" else w.people

    monkeypatch.setattr(community, "open_d1", open_d1)
    folder = tmp_path / "community"
    folder.mkdir()
    w.reader.add("oscr-fixture", "eeg-analysis", id="101", files={}, sha=SHA_A)
    w.repo("101", "oscr-fixture", "eeg-analysis", head=SHA_A)
    w.job("reconcile", "101")
    common = {"folder": folder, "readers": lambda f: w.reader, "post": w.post, "report": w.log.append}
    with pytest.raises(SystemExit, match="--local"):
        forgejobs.command(w.mac, "poll", target=None, **common)
    with pytest.raises(SystemExit, match="poll, mirrors or status"):
        forgejobs.command(w.mac, "push", target="local", **common)
    said = forgejobs.command(w.mac, "poll", target="local", **common)
    assert said.startswith("forge jobs, local: 1 new forge job(s); 1 done")
    assert ("local", "oscr_forge") in opened and ("local", "oscr_community") in opened
    said = forgejobs.mirrors(w.mac, target="local", folder=folder, readers=lambda f: w.reader, post=w.post,
                             report=w.log.append)
    assert said.startswith("forge mirrors, local: 1 mirror(s) checked")
    status = forgejobs.command(w.mac, "status", target=None, folder=folder)
    assert "local: forge jobs read up to 1" in status and "local: forge reconcile done: 1" in status
