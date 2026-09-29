"""The job runner (oscr/jobs.py): the site's requests read from D1 community and answered — a
submission harvested into a draft and published, a correction applied as a new version with its
provenance, a map validated with the author's ORCID iD and deposited on the Zenodo SANDBOX, claims
and removal requests decided by the owner. D1 is an SQLite database made from the real migrations;
Zenodo is a fake InvenioRDM; the harvester is a fake that never touches the network."""
import json
import sqlite3
import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402

from oscr import catalog, cli, community, db, find, harvest, jobs, links, paperpage, zenodo  # noqa: E402

MIGRATIONS = sorted((ROOT / "migrations" / "d1-community").glob("[0-9][0-9][0-9][0-9]_*.sql"))
ADA, BEN = make_fixture.ADA, make_fixture.BEN
P1, P2, P3 = (f"doi:10.5555/oscr.fixture.{n}" for n in (1, 2, 3))
EEG, UNLICENSED = "github.com/oscr-fixture/eeg-analysis", "github.com/oscr-fixture/unlicensed"
T = 1_790_424_000          # 2026-09-26 12:00 UTC


class FakeHarvester:
    """The harvester's steps, offline: a DOI becomes a paper (its authors given), a repository
    answers (alive, MIT) unless it is `dead`, the matches are counted."""

    def __init__(self):
        self.calls = []
        self.authors = {"10.5555/oscr.fixture.7": [("Ada Fixture", ADA)], "10.5555/oscr.fixture.8": [("Ben Example", BEN)]}
        self.dead = set()
        self.off_topic = set()
        self.fail = 0

    def harvest(self, con, doi):
        self.calls.append(("harvest", doi))
        if self.fail:
            self.fail -= 1
            raise httpx.ConnectError("Europe PMC did not answer")
        article_id = f"doi:{doi}"
        if con.execute("SELECT 1 FROM article WHERE id = ?", (article_id,)).fetchone() is None:
            db.save_article(con, {"id": article_id, "doi": doi, "title": f"A submitted study ({doi})",
                                  "journal": "Journal of Synthetic Fixtures", "published": "2026-09-20"})
            db.mark_scanned(con, article_id, has_fulltext=True, has_statement=False, code_on_request=False,
                            data_on_request=False, families=[], methods=[])
            for position, (name, orcid) in enumerate(self.authors.get(doi, []), 1):
                given, _, family = name.rpartition(" ")
                con.execute("INSERT INTO paper_author (article_id, position, name, given, family, orcid) VALUES "
                            "(?,?,?,?,?,?)", (article_id, position, name, given, family, orcid))
            con.execute("UPDATE article SET status = 'none', on_topic = ? WHERE id = ?",
                        ("no" if doi in self.off_topic else "yes", article_id))
        con.commit()
        return article_id

    def verify(self, con, link, article_id):
        self.calls.append(("verify", link.repo))
        con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind) VALUES (?,?,?,?)",
                    (link.repo, link.url, link.host, link.kind))
        if link.repo in self.dead:
            db.save_repository(con, link.repo, {"state": "dead", "http_status": 404})
        else:
            db.save_repository(con, link.repo, {
                "state": "alive", "http_status": 200, "license": "MIT", "redistributable": "yes", "commit_id": "c" * 40,
                "n_files": 2, "n_scripts": 1, "languages": {"Python": 1}, "files": ["README.md", "main.py"],
                "_contents": [{"path": "main.py", "language": "Python", "kind": "script", "size": 9, "lines": 1,
                               "digest": "d1", "text": "print(1)\n"}]})
        con.commit()

    def conclude(self, con, article_id):
        self.calls.append(("conclude", article_id))
        return harvest.conclude(con, article_id, harvest.Options(records=False, snapshots=False))

    def align(self, con, article_id, repos=None, *, save=True):
        self.calls.append(("align", article_id, save))
        return 2


class FakeZenodo:
    """A pocket InvenioRDM: records every call and what the deposits carried."""

    def __init__(self):
        self.calls, self.drafts, self.maps, self.n = [], [], [], 0

    def __call__(self, req):
        path, m = req.url.path, req.method
        self.calls.append(f"{m} {path}")
        assert req.url.host == "sandbox.zenodo.org"
        assert req.headers["authorization"] == "Bearer test-token"
        if m == "POST" and path == "/api/records":
            self.drafts.append(json.loads(req.content))
            self.n += 1
            return httpx.Response(201, json={"id": f"r{self.n}"})
        if m == "POST" and path.endswith("/versions"):
            self.n += 1
            return httpx.Response(201, json={"id": f"r{self.n}"})
        if m == "PUT" and path.endswith("/draft"):
            self.drafts.append(json.loads(req.content))
            return httpx.Response(200, json={"id": path.split("/")[3]})
        if m == "PUT" and path.endswith("/content"):
            self.maps.append(json.loads(req.content))
            return httpx.Response(200, json={})
        if m == "GET" and path.startswith("/api/communities/"):
            return httpx.Response(200, json={"id": "community-uuid", "slug": "oscr"})
        if path.endswith("/submit-review"):
            return httpx.Response(200, json={"id": "request-1"})
        if path.endswith("/actions/publish") or (m == "GET" and path.startswith("/api/records/")):
            rid = path.split("/")[3]
            return httpx.Response(202, json={"id": rid, "pids": {"doi": {"identifier": f"10.5072/zenodo.{rid}"}},
                                             "parent": {"pids": {"doi": {"identifier": "10.5072/zenodo.concept"}}},
                                             "links": {"self_html": f"https://sandbox.zenodo.org/records/{rid}"}})
        return httpx.Response(200, json={})


class World:
    def __init__(self, tmp_path: Path, token: str = "test-token"):
        self.mac = make_fixture.database(tmp_path / "mac.db")
        self.d1con = sqlite3.connect(":memory:")
        self.d1con.execute("PRAGMA foreign_keys = ON")
        for migration in MIGRATIONS:
            self.d1con.executescript(migration.read_text())
        self.d1 = community.SqliteD1(self.d1con)
        self.state = jobs.open_state(tmp_path / "state.db")
        self.harvester = FakeHarvester()
        self.zenodo = FakeZenodo()
        self.log = []
        zenodo.INTERVAL_S = 0
        self.runner = jobs.Runner(
            self.mac, self.d1, self.state, self.harvester, instance="sandbox", zenodo_community="oscr",
            platform="The platform",
            invenio=lambda instance: zenodo.Invenio(instance, api_token=token, transport=httpx.MockTransport(self.zenodo)),
            report=self.log.append, now=lambda: T)

    # What the Worker writes (website/worker/): accounts, roles, requests and their jobs.
    def user(self, uid: str, name: str, orcid: str | None = None, github: str | None = None) -> str:
        self.d1con.execute("INSERT INTO users (id, display_name, orcid, github_login, created_at) VALUES (?,?,?,?,?)",
                           (uid, name, orcid, github, T))
        if orcid:
            self.d1con.execute("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('orcid', ?, ?, ?)",
                               (orcid, uid, T))
        return uid

    def request(self, table: str, kind: str, values: dict) -> int:
        cols = ", ".join(values)
        rid = self.d1con.execute(f"INSERT INTO {table} ({cols}) VALUES ({', '.join('?' * len(values))})",
                                 tuple(values.values())).lastrowid
        self.job(kind, rid, values["user_id"])
        return rid

    def job(self, kind: str, ref: int, user_id: str) -> None:
        self.d1con.execute("INSERT INTO jobs (kind, ref, user_id, created_at) VALUES (?,?,?,?)", (kind, ref, user_id, T))
        self.d1con.commit()

    def row(self, table: str, rid: int) -> dict:
        self.d1con.row_factory = sqlite3.Row
        return dict(self.d1con.execute(f"SELECT * FROM {table} WHERE id = ?", (rid,)).fetchone())

    def poll(self) -> jobs.Poll:
        return jobs.poll(self.runner)


@pytest.fixture
def w(tmp_path):
    world = World(tmp_path)
    world.user("u_ada", "Ada Fixture", orcid=ADA)
    world.user("u_ben", "Ben Example", github="ben-example")
    return world


def _versions(con, article_id):
    return con.execute("SELECT * FROM version WHERE entity = 'article' AND entity_id = ? ORDER BY version",
                       (article_id,)).fetchall()


# ---------------------------------------------------------------------------------------
# Submissions.

def _submit(w, user="u_ada", doi="10.5555/oscr.fixture.7", urls=("https://github.com/oscr-fixture/new-code",)):
    return w.request("submissions", "submission", {"user_id": user, "doi": doi, "code_urls": json.dumps(list(urls)),
                                                   "created_at": T, "updated_at": T})


def test_a_submission_is_harvested_and_its_draft_written_back(w):
    sid = _submit(w)
    out = w.poll()
    assert (out.new, out.done, out.written) == (1, 1, 1)
    row = w.row("submissions", sid)
    assert (row["status"], row["paper_id"], row["author"]) == ("draft", "doi:10.5555/oscr.fixture.7", 1)
    draft = json.loads(row["draft"])
    assert draft["paper"]["title"] == "A submitted study (10.5555/oscr.fixture.7)"
    assert draft["links"] == [{"key": "github.com/oscr-fixture/new-code", "url": "https://github.com/oscr-fixture/new-code",
                               "role": "code", "source": "you", "state": "alive", "license": "MIT",
                               "redistributable": "yes", "scripts": 1, "commit": "c" * 12}]
    assert draft["map"] == {"repositories": 1, "files": 1, "pairs": 2}
    assert ("harvest", "10.5555/oscr.fixture.7") in w.harvester.calls
    # The submitter's links are verified, not yet on the record.
    assert w.mac.execute("SELECT COUNT(*) FROM link WHERE article_id = ?", ("doi:10.5555/oscr.fixture.7",)).fetchone()[0] == 0
    # Read once: the next poll has nothing new.
    assert w.poll().new == 0
    assert w.state.execute("SELECT status FROM job").fetchone()[0] == "done"
    assert community.budget_spent(w.state, "local", community.utc_day(T)) == 1


def test_a_published_submission_puts_its_links_on_the_record_as_a_new_version(w):
    sid = _submit(w)
    w.poll()
    w.d1con.execute("UPDATE submissions SET status = 'publishing' WHERE id = ?", (sid,))
    w.job("publish", sid, "u_ada")
    out = w.poll()
    assert out.done == 1
    assert w.row("submissions", sid)["status"] == "published"
    paper = "doi:10.5555/oscr.fixture.7"
    link = w.mac.execute("SELECT * FROM link WHERE article_id = ?", (paper,)).fetchone()
    assert (link["repo"], link["role"], link["found_by"]) == ("github.com/oscr-fixture/new-code", "code", "submitter")
    assert w.mac.execute("SELECT status FROM article WHERE id = ?", (paper,)).fetchone()[0] == "code_verified"
    edit = w.mac.execute("SELECT * FROM link_edit WHERE article_id = ?", (paper,)).fetchone()
    assert (edit["op"], edit["source"], edit["actor"], edit["ref"]) == ("add", "submitter", f"orcid:{ADA}", f"submission:{sid}")
    versions = _versions(w.mac, paper)
    assert versions[-1]["actor"] == f"submitter:orcid:{ADA}"
    listed = paperpage.history(versions)
    assert listed[0]["by"] == "submitter"
    assert listed[0]["changes"] == [{"field": "code", "added": ["github.com/oscr-fixture/new-code"], "removed": [],
                                     "n_added": 1, "n_removed": 0}]
    assert ("align", paper, True) in w.harvester.calls


def test_a_draft_published_by_someone_else_waits_for_the_owner_when_nothing_proves_its_links(w):
    """The moderator's rules (tests/test_moderation.py has each): nothing the submitter cannot forge ties
    this link to the paper, so it waits for the owner, 30 days at most, the submitter told why."""
    sid = _submit(w, user="u_ben")
    w.poll()
    assert w.row("submissions", sid)["author"] == 0
    w.d1con.execute("UPDATE submissions SET status = 'moderation' WHERE id = ?", (sid,))
    w.job("publish", sid, "u_ben")
    assert w.poll().owner == 1
    row = w.row("submissions", sid)
    assert row["status"] == "moderation" and row["message"].startswith("Waits for the operator's review, until 26 October 2026")
    listed = jobs.describe_waiting(jobs.waiting(w.state, "local", ("publish",)))
    assert f"submission {sid}: 10.5555/oscr.fixture.7" in listed and "GitHub ben-example" in listed
    assert "the rules (submission.review) close it by themselves on 26 October 2026" in listed
    assert jobs.decide_submission(w.runner, sid, True, "Thank you.").endswith("published")
    row = w.row("submissions", sid)
    assert row["status"] == "published" and "Thank you." in row["message"]
    assert jobs.waiting(w.state, "local", ("publish",)) == []
    # A refusal says so.
    other = _submit(w, user="u_ben", doi="10.5555/oscr.fixture.8")
    w.poll()
    w.d1con.execute("UPDATE submissions SET status = 'moderation' WHERE id = ?", (other,))
    w.d1con.commit()
    jobs.decide_submission(w.runner, other, False, "Not the authors' code.")
    assert (w.row("submissions", other)["status"], w.row("submissions", other)["message"]) == ("refused", "Not the authors' code.")


def test_an_off_topic_paper_is_refused_and_a_failing_harvest_retried_then_given_up(w):
    w.harvester.off_topic.add("10.5555/oscr.fixture.7")
    sid = _submit(w)
    w.poll()
    row = w.row("submissions", sid)
    assert row["status"] == "refused" and "outside the registry's scope" in row["message"]
    w.harvester.fail = 99
    other = _submit(w, doi="10.5555/oscr.fixture.8")
    for attempt in range(1, jobs.MAX_ATTEMPTS):
        out = w.poll()
        assert out.retry == 1, attempt
        assert w.row("submissions", other)["status"] == "queued"
    assert w.poll().failed == 1
    row = w.row("submissions", other)
    assert row["status"] == "refused" and row["message"].startswith("The registry could not complete this request")


# ---------------------------------------------------------------------------------------
# Corrections.

def _edit(w, changes, user="u_ada", paper=P1, as_role="verified_author", repo=""):
    return w.request("edits", "edit", {"user_id": user, "paper_id": paper, "as_role": as_role, "repo": repo,
                                       "changes": json.dumps(changes), "created_at": T})


def test_a_correction_is_applied_as_a_new_version_with_its_provenance(w):
    before = len(_versions(w.mac, P1))
    eid = _edit(w, [{"op": "add", "url": "https://zenodo.org/records/1234567", "key": "zenodo:1234567", "role": "code"},
                    {"op": "role", "repo": "doi:10.5555/oscr.fixture.data.1", "role": "tool"}])
    assert w.poll().done == 1
    row = w.row("edits", eid)
    assert row["status"] == "applied" and row["version"] == before + 2          # the links recorded, then the edit
    assert row["message"].startswith("Applied: zenodo:1234567 added (code); doi:10.5555/oscr.fixture.data.1: now third party tool")
    roles = dict(w.mac.execute("SELECT repo, role FROM link WHERE article_id = ?", (P1,)).fetchall())
    assert roles == {EEG: "code", "zenodo:1234567": "code", "doi:10.5555/oscr.fixture.data.1": "third_party_tool"}
    # Provenance: the person's ORCID iD, on the Mac.
    versions = _versions(w.mac, P1)
    assert versions[-1]["actor"] == f"author:orcid:{ADA}"
    prov = dict(w.mac.execute("SELECT field, source_ref FROM field_provenance WHERE entity = 'article' AND entity_id = ? "
                              "AND source = 'author'", (P1,)).fetchall())
    assert prov == {"links.code": f"orcid:{ADA}", "links.data": f"orcid:{ADA}"}
    # The Versions section: the recording of the links is not a change; the correction is, by its role.
    listed = paperpage.history(versions)
    assert listed[0]["by"] == "author"
    assert {c["field"]: (c.get("added"), c.get("removed")) for c in listed[0]["changes"]} == {
        "code": (["zenodo:1234567"], []), "data": ([], ["doi:10.5555/oscr.fixture.data.1"])}
    assert all(v["by"] != "harvester" or v["version"] <= before for v in listed)
    # The next scan keeps the correction: the harvester finds only its own link.
    found = links.normalize("https://github.com/oscr-fixture/eeg-analysis")
    db.replace_links(w.mac, P1, [find.Candidate(found, "code", "high", 3.0, "text:availability", "", "Code")])
    assert set(dict(w.mac.execute("SELECT repo, role FROM link WHERE article_id = ?", (P1,)).fetchall())) == {EEG, "zenodo:1234567"}


def maintainer(w, user: str, repo: str, via: str = "owner") -> None:
    """A maintainer as the Worker records one after GitHub's check (the role, and the claim that keeps
    how GitHub showed it: owner, org_member, contributor, commit_author)."""
    w.d1con.execute("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES "
                    "(?, 'maintainer', 'repo', ?, 'system', ?)", (user, repo, T))
    w.d1con.execute("INSERT INTO claims (user_id, kind, repo, evidence, status, created_at, decided_by, decided_at) VALUES "
                    "(?, 'maintainer', ?, ?, 'verified', ?, 'system', ?)", (user, repo, json.dumps({"via": via}), T, T))
    w.d1con.commit()


def test_a_maintainer_removes_their_repository_and_the_verification_does_not_overrule_a_role(w):
    maintainer(w, "u_ben", UNLICENSED)
    eid = _edit(w, [{"op": "remove", "repo": UNLICENSED}], user="u_ben", paper=P2, as_role="maintainer", repo=UNLICENSED)
    w.poll()
    assert w.row("edits", eid)["status"] == "applied"
    assert w.mac.execute("SELECT COUNT(*) FROM link WHERE article_id = ?", (P2,)).fetchone()[0] == 0
    assert w.mac.execute("SELECT status FROM article WHERE id = ?", (P2,)).fetchone()[0] != "code_verified"
    assert _versions(w.mac, P2)[-1]["actor"] == "maintainer:github:ben-example"
    # A role a person set stays, whatever the repository holds.
    _edit(w, [{"op": "role", "repo": EEG, "role": "data"}])
    w.poll()
    harvest.conclude(w.mac, P1, harvest.Options(records=False, snapshots=False))
    assert w.mac.execute("SELECT role FROM link WHERE article_id = ? AND repo = ?", (P1, EEG)).fetchone()[0] == "data"


def test_a_correction_that_changes_nothing_is_refused_in_words(w):
    eid = _edit(w, [{"op": "remove", "repo": "github.com/someone/else"}, {"op": "role", "repo": EEG, "role": "code"}])
    w.poll()
    row = w.row("edits", eid)
    assert row["status"] == "refused"
    assert row["message"] == "Nothing to change: github.com/someone/else: not a link of this record; github.com/oscr-fixture/eeg-analysis: already code"


def test_the_public_database_keeps_the_links_not_who_corrected_them(w, tmp_path):
    _edit(w, [{"op": "add", "url": "https://zenodo.org/records/1234567", "role": "code"}])
    w.poll()
    catalog.public_db(w.mac, tmp_path / "public.db")
    public = sqlite3.connect(tmp_path / "public.db")
    assert public.execute("SELECT name FROM sqlite_master WHERE name = 'link_edit'").fetchone() is None
    assert public.execute("SELECT COUNT(*) FROM link WHERE repo = 'zenodo:1234567'").fetchone()[0] == 1
    refs = [r[0] for r in public.execute("SELECT source_ref FROM field_provenance WHERE source = 'author'")]
    assert refs and all(r == "" for r in refs)
    assert ADA not in json.dumps(refs)


# ---------------------------------------------------------------------------------------
# Validations.

def _validate(w, paper=P2, user="u_ben_orcid", orcid=BEN, proof="orcid", digest=None):
    digest = digest or zenodo.map_digest(zenodo.map_of(w.mac, paper))
    return w.request("validations", "validation", {"user_id": user, "paper_id": paper, "orcid": orcid, "proof": proof,
                                                   "map_digest": digest, "created_at": T})


def test_a_validation_deposits_the_map_on_the_sandbox_with_the_authors_orcid(w):
    w.user("u_ben_orcid", "Ben Example", orcid=BEN)
    vid = _validate(w)
    assert w.poll().done == 1
    row = w.row("validations", vid)
    assert (row["status"], row["instance"], row["doi"]) == ("deposited", "sandbox", "10.5072/zenodo.r1")
    assert row["record_url"] == "https://sandbox.zenodo.org/records/r1"
    # The deposit's payload: the validating author, with their ORCID iD, and the platform.
    metadata = w.zenodo.drafts[0]["metadata"]
    author, platform = metadata["creators"]
    assert author["person_or_org"]["identifiers"] == [{"scheme": "orcid", "identifier": BEN}]
    assert (author["person_or_org"]["family_name"], author["person_or_org"]["given_name"]) == ("Example", "Ben")
    assert platform["person_or_org"] == {"type": "organizational", "name": "The platform"}
    relations = {(r["relation_type"]["id"], r["identifier"]) for r in metadata["related_identifiers"]}
    assert ("issupplementto", "10.5555/oscr.fixture.2") in relations
    assert w.zenodo.maps[0]["validated"] == {"by": "Example, Ben", "orcid": BEN, "on": w.zenodo.maps[0]["validated"]["on"],
                                             "proof": "orcid"}
    assert "POST /api/records/r1/draft/actions/submit-review" in w.zenodo.calls        # into the community
    # On the Mac: the validation (proof orcid), the sandbox's DOI — which no public output shows.
    assert w.mac.execute("SELECT proof FROM validation WHERE article_id = ? AND orcid = ?", (P2, BEN)).fetchone()[0] == "orcid"
    assert w.mac.execute("SELECT doi FROM card_doi WHERE article_id = ? AND instance = 'sandbox'", (P2,)).fetchone()[0] == \
        "10.5072/zenodo.r1"
    card = next(a["card"] for a in catalog.catalog_data(w.mac)["articles"] if a["id"] == P2)
    assert card == {"validated_by": [{"name": "Example, Ben", "orcid": BEN}]}          # no sandbox DOI


def test_a_validation_from_orcids_sandbox_is_a_test(w):
    w.user("u_ben_orcid", "Ben Example", orcid=BEN)
    vid = _validate(w, proof="orcid-sandbox")
    w.poll()
    assert w.row("validations", vid)["status"] == "deposited"
    assert w.mac.execute("SELECT proof FROM validation WHERE article_id = ? AND orcid = ?", (P2, BEN)).fetchone()[0] == "test"
    assert w.zenodo.maps[0]["validated"]["proof"] == "test"
    card = next(a["card"] for a in catalog.catalog_data(w.mac)["articles"] if a["id"] == P2)
    assert card is None                                                     # a test never leaves


def test_the_real_zenodo_refuses_a_test(w, tmp_path):
    w.user("u_ben_orcid", "Ben Example", orcid=BEN)
    w.runner.instance = "zenodo"
    w.runner.invenio = lambda instance: zenodo.Invenio(instance, api_token="test-token",
                                                       transport=httpx.MockTransport(lambda r: pytest.fail("no call")))
    vid = _validate(w, proof="orcid-sandbox")
    w.poll()
    row = w.row("validations", vid)
    assert row["status"] == "refused" and "test" in row["message"]


def test_a_map_that_changed_since_the_page_is_not_deposited(w):
    w.user("u_ben_orcid", "Ben Example", orcid=BEN)
    vid = _validate(w, digest="ab" * 32)
    w.poll()
    row = w.row("validations", vid)
    assert row["status"] == "map_changed" and "reload the paper's page" in row["message"]
    assert w.zenodo.calls == []
    assert w.mac.execute("SELECT COUNT(*) FROM validation WHERE article_id = ?", (P2,)).fetchone()[0] == 0


def test_without_a_zenodo_token_the_validation_waits_without_counting_attempts(tmp_path):
    w = World(tmp_path, token="")
    w.user("u_ben_orcid", "Ben Example", orcid=BEN)
    vid = _validate(w)
    for _ in range(jobs.MAX_ATTEMPTS + 2):
        assert w.poll().retry == 1
    assert w.row("validations", vid)["status"] == "queued"
    assert w.state.execute("SELECT attempts FROM job").fetchone()[0] == 0
    assert "no Zenodo token for sandbox" in w.state.execute("SELECT message FROM job").fetchone()[0]


def test_the_page_carries_the_maps_digest(w, tmp_path):
    catalog.generate(w.mac, tmp_path / "export", public=True)
    lots = [json.loads(p.read_text()) for p in (tmp_path / "export" / "papers").glob("*.json")]
    pages = {k: v for lot in lots for k, v in lot.items()}
    assert pages[P1]["map"]["digest"] == zenodo.map_digest(zenodo.map_of(w.mac, P1))
    assert pages[P3]["map"]["digest"] == ""                                  # no code, no map
    assert pages[P1]["code"][EEG]["readme"] == ""                           # the fixture's file list has none
    # The day it is read does not change it.
    card = zenodo.map_of(w.mac, P1)
    assert zenodo.map_digest({**card, "proposed": {"by": "oscr", "on": "1999-01-01"}}) == zenodo.map_digest(card)


# ---------------------------------------------------------------------------------------
# Claims and removal requests.

def _claim(w, user="u_ben", kind="author", paper=P2, repo=""):
    evidence = {"statement": "I am the second author.", "link": "https://lab.example/ben", "github": "ben-example"}
    return w.request("claims", "claim", {"user_id": user, "kind": kind, "paper_id": paper, "repo": repo,
                                         "evidence": json.dumps(evidence), "status": "pending", "created_at": T})


def test_a_claim_waits_for_the_owner_who_grants_the_role(w):
    """Nothing proves it (no ORCID iD): it waits, 30 days at most (tests/test_moderation.py), and the
    owner may decide it meanwhile."""
    cid = _claim(w)
    w.job("claim", cid, "u_ben")                      # asked twice: answered once
    out = w.poll()
    assert (out.new, out.owner) == (2, 2)
    listed = jobs.describe_waiting(jobs.waiting(w.state, "local", ("claim",)))
    assert listed.count(f"claim {cid}: Ben Example, GitHub ben-example as author of {P2}") == 1
    assert "I am the second author." in listed and "https://lab.example/ben" in listed
    assert "the rules (claim.review) close it by themselves on 26 October 2026" in listed
    assert jobs.decide_claim(w.runner, cid, True, "Welcome.") == f"claim {cid} (author of {P2}): accepted"
    row = w.row("claims", cid)
    assert (row["status"], row["decided_by"], row["message"]) == ("verified", "owner", "Welcome.")
    role = w.d1con.execute("SELECT role, scope_kind, scope_id, granted_by FROM roles WHERE user_id = 'u_ben'").fetchone()
    assert tuple(role) == ("verified_author", "paper", P2, "owner")
    assert jobs.waiting(w.state, "local", ("claim",)) == []
    assert jobs.decide_claim(w.runner, cid, False) == f"claim {cid} is already verified"


def test_a_maintainer_claim_refused_says_why(w):
    cid = _claim(w, kind="maintainer", paper="", repo="gitlab.com/lab/tool")
    w.poll()
    jobs.decide_claim(w.runner, cid, False, "Write to us from the lab's page: ben@lab.example.org")
    row = w.row("claims", cid)
    assert row["status"] == "rejected" and "@" not in row["message"]
    assert w.d1con.execute("SELECT COUNT(*) FROM roles").fetchone()[0] == 0


def test_a_removal_accepted_withdraws_the_record_from_every_public_output(w, tmp_path):
    # Ada's ORCID iD is among the paper's authors: the rules apply her request at once.
    rid = w.request("reports", "report", {"user_id": "u_ada", "target_kind": "paper", "target_id": P1,
                                           "reason": "author_request", "details": "Please remove it.", "created_at": T})
    assert (w.poll().done, jobs.waiting(w.state, "local", ("report",))) == (1, [])
    assert w.row("reports", rid)["status"] == "accepted"
    assert w.row("reports", rid)["message"].startswith("Applied at once, as a request from a verified author")
    assert w.mac.execute("SELECT withdrawn FROM article WHERE id = ?", (P1,)).fetchone()[0].endswith(
        f"request {rid} (author_request)")
    assert P1 not in {a["id"] for a in catalog.catalog_data(w.mac)["articles"]}
    catalog.public_db(w.mac, tmp_path / "public.db")
    assert sqlite3.connect(tmp_path / "public.db").execute("SELECT COUNT(*) FROM article WHERE id = ?", (P1,)).fetchone()[0] == 0
    # The facts push forgets it too: its authors are no longer its verified authors.
    assert all(r.values["paper_id"] != P1 for r in community.facts(w.mac)["paper_orcid"].values())
    other = w.request("reports", "report", {"user_id": "u_ben", "target_kind": "paper", "target_id": P2,
                                             "reason": "incorrect", "created_at": T})
    w.poll()
    jobs.decide_report(w.runner, other, False, "The record is correct.")
    assert w.row("reports", other)["status"] == "rejected"


# ---------------------------------------------------------------------------------------
# The poll itself.

def test_the_days_budget_stops_the_answers_and_the_rest_waits(w):
    w.runner.budget = 4
    community.spend(w.state, "local", 1, now=T)             # the facts push's, earlier today
    ids = [_edit(w, [{"op": "remove", "repo": "github.com/x/y"}]) for _ in range(3)]
    out = w.poll()
    assert (out.done, out.deferred, out.written) == (1, 2, 1)
    assert [w.row("edits", i)["status"] for i in ids] == ["refused", "queued", "queued"]
    # The next day, the rest.
    w.runner.now = lambda: T + 86_400
    out = w.poll()
    assert (out.new, out.done, out.deferred) == (0, 2, 0)
    assert [w.row("edits", i)["status"] for i in ids] == ["refused"] * 3


def test_d1_through_wrangler_and_the_rest_api(tmp_path, monkeypatch):
    calls = []
    output = json.dumps([{"results": [{"id": 1, "kind": "claim"}], "success": True, "meta": {"rows_read": 1}}])
    monkeypatch.setattr(community, "_wrangler", lambda args, website: calls.append(args) or output)
    local = community.open_d1("local", persist_to=tmp_path / "state")
    assert local.query("SELECT id, kind FROM jobs") == [{"id": 1, "kind": "claim"}]
    assert calls[0][:3] == ["d1", "execute", "oscr_community"]
    assert "--local" in calls[0] and "--json" in calls[0] and calls[0][calls[0].index("--persist-to") + 1] == str(
        (tmp_path / "state").resolve())
    assert calls[0][calls[0].index("--env") + 1] == "local"
    monkeypatch.setattr(community, "_wrangler", lambda args, website: calls.append(args) or json.dumps(
        [{"results": [], "success": True, "meta": {"rows_written": 2}}]))
    remote = community.open_d1("remote", settings={})
    assert isinstance(remote, community.WranglerD1) and remote.run(["UPDATE claims SET message = 'x' WHERE id = 1"]) == 2
    assert "--remote" in calls[-1] and "--env" not in calls[-1]
    from oscr import d1 as search
    monkeypatch.setattr(search, "remote_token", lambda: "tok")
    rest = community.open_d1("remote", settings={"OSCR_D1_ACCOUNT_ID": "a", "OSCR_D1_COMMUNITY_ID": "b"})
    assert isinstance(rest, community.RestD1)
    with pytest.raises(community.D1Error):
        community._results("⛅️ wrangler: not JSON")


def test_the_command_line_polls_lists_and_decides(tmp_path, monkeypatch, capsys):
    world = World(tmp_path / "w")
    world.user("u_ben", "Ben Example", github="ben-example")
    cid = _claim(world)
    monkeypatch.setattr(community, "open_d1", lambda target, **kw: world.d1)
    monkeypatch.setattr(jobs, "MacHarvester", lambda client, opts: world.harvester)
    monkeypatch.setattr(cli, "settings", lambda: {})
    mac = tmp_path / "mac.db"
    make_fixture.database(mac).close()
    base = ["--db", str(mac), "--cache", str(tmp_path / "cache")]
    folder = ["--folder", str(tmp_path / "community")]
    with pytest.raises(SystemExit, match="--local"):
        cli.main([*base, "jobs", "poll", *folder])
    assert cli.main([*base, "jobs", "poll", "--local", *folder]) == 0
    assert "1 new request(s); 0 answered, 1 for the owner" in capsys.readouterr().out
    assert cli.main([*base, "claims", "list", *folder]) == 0
    assert f"claim {cid}: Ben Example" in capsys.readouterr().out
    assert cli.main([*base, "claims", "accept", str(cid), "--local", "--message", "Welcome.", *folder]) == 0
    assert "accepted" in capsys.readouterr().out
    assert cli.main([*base, "jobs", "status", *folder]) == 0
    assert "local: claim done: 1" in capsys.readouterr().out
