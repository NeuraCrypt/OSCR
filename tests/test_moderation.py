"""The automatic moderator (oscr/moderation.py; the public page /policies/moderation/): every rule, the
deadlines, the guards against abuse, the log the owner audits, and the owner's commands that decide
what waits and reverse what the rules did. D1 is an SQLite database made from the real migrations;
the harvester and the lookups (ORCID, GitHub) are fakes that never touch the network."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests"))

from test_jobs import ADA, BEN, EEG, P1, P2, UNLICENSED, T, World, maintainer  # noqa: E402

from oscr import catalog, cli, community, jobs, moderation  # noqa: E402

DAY = moderation.DAY


class FakeEvidence:
    """What ORCID records and forge owners show, as the tests say."""

    def __init__(self):
        self.works: dict[str, set[str]] = {}
        self.owners: dict[str, str] = {}
        self.asked: list[tuple] = []

    def orcid_lists_doi(self, orcid, doi, *, sandbox):
        self.asked.append(("works", orcid, doi, sandbox))
        return doi in self.works.get(orcid, set())

    def owner_is_author(self, con, article_id, repo):
        self.asked.append(("owner", article_id, repo))
        return self.owners.get(repo, "")


class Clock:
    def __init__(self, t: float):
        self.t = t

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def w(tmp_path):
    world = World(tmp_path)
    world.user("u_ada", "Ada Fixture", orcid=ADA)          # an author of P1 (the paper lists her ORCID iD)
    world.user("u_ben", "Ben Example", github="ben-example")
    world.user("u_eve", "Eve Stranger")
    for n in range(8):
        world.user(f"u_s{n}", f"Stranger {n}")
    world.clock = Clock(T)
    world.runner.now = world.clock
    world.evidence = FakeEvidence()
    world.runner.evidence = world.evidence
    return world


def ask(w, user="u_eve", paper=P1, **values) -> int:
    row = {"user_id": user, "target_kind": "paper", "target_id": paper, "reason": "copyright",
           "details": "This page reproduces my files without my permission, please remove them.",
           "requester_role": "rights_holder", "author_verified": 0, "scope": "record", "confirmed": 1, "created_at": int(w.clock())}
    return w.request("reports", "report", {**row, **values})


def withheld(w):
    return sorted(tuple(r) for r in w.mac.execute("SELECT scope, article_id, repo, path, request FROM withheld"))


def withdrawn(w, paper):
    return w.mac.execute("SELECT withdrawn FROM article WHERE id = ?", (paper,)).fetchone()[0]


def rules(w, kind=None):
    return [(e["kind"], e["ref"], e["rule"], e["decision"]) for e in moderation.entries(w.state, "local", (kind,) if kind else ())]


# ---------------------------------------------------------------------------------------
# The base rules, shared with the site (website/src/lib/moderation.ts reads the same cases).

def test_the_rules_are_the_ones_the_site_announces():
    fixture = json.loads((ROOT / "tests" / "fixtures" / "moderation_rules.json").read_text())
    cases = fixture["cases"]
    assert len(cases) >= 20
    for c in cases:
        path = moderation.report_path(c["scope"], c["reason"], c["author_verified"], c["maintainer"])
        assert (path.rule, path.outcome) == (c["rule"], c["outcome"]), c
    assert {c["outcome"] for c in cases} == {"apply", "hide", "review"}
    for c in fixture["submissions"]:
        path = moderation.submission_path(c["links"])
        assert (path.rule, path.outcome) == (c["rule"], c["outcome"]), c
    # What the submitter can write never publishes: a README citing the paper, a display name.
    forged = [c for c in fixture["submissions"] if any(x.get("readme") or x.get("name") for x in c["links"])
              and not all(x["cited"] or x["owner_author"] for x in c["links"])]
    assert forged and all(c["outcome"] == "review" for c in forged)
    for c in fixture["maintainers"]:
        assert moderation.trusted_maintainer(c["via"], c["decided_by"], c["granted_by"]) is c["trusted"], c


# ---------------------------------------------------------------------------------------
# Removal requests.

def test_a_verified_authors_request_is_applied_at_once_whatever_it_names(w):
    rid = ask(w, user="u_ada", requester_role="author", author_verified=1, reason="other")
    out = w.poll()
    assert (out.done, out.owner, out.written) == (1, 0, 1)
    row = w.row("reports", rid)
    assert row["status"] == "accepted" and row["message"].startswith("Applied at once, as a request from a verified author")
    assert withdrawn(w, P1).endswith(f"request {rid} (other)")
    assert rules(w) == [("report", rid, "report.verified_author", "accepted")]
    assert jobs.waiting(w.state, "local", ("report",)) == []


def test_the_worker_s_flag_alone_is_not_trusted(w):
    """Said verified by the Worker, but the account holds no role and its ORCID iD is not the paper's:
    the rules treat it as anyone's request."""
    rid = ask(w, user="u_ben", requester_role="author", author_verified=1, scope="map", reason="not_my_work")
    assert w.poll().owner == 1
    assert w.row("reports", rid)["status"] == "open"
    assert rules(w) == [("report", rid, "report.review", "review")]


def test_a_maintainers_request_withholds_their_own_code_only(w):
    maintainer(w, "u_ben", EEG, via="org_member")
    one = ask(w, user="u_ben", scope="repository", scope_repo=EEG, reason="other", requester_role="other")
    w.poll()
    assert w.row("reports", one)["status"] == "accepted"
    assert withheld(w) == [("repository", P1, EEG, "", f"local:{one}")]
    # "The scripts" of P2, whose code Ben does not maintain: it waits for the operator.
    other = ask(w, user="u_ben", paper=P2, scope="scripts", reason="other", requester_role="other")
    w.poll()
    assert w.row("reports", other)["status"] == "open"
    assert ("report", other, "report.review", "review") in rules(w)


def test_a_maintainer_asking_for_all_the_scripts_withholds_the_repositories_they_maintain(w):
    maintainer(w, "u_ben", EEG)
    rid = ask(w, user="u_ben", scope="scripts", reason="other", requester_role="other")
    w.poll()
    assert withheld(w) == [("repository", P1, EEG, "", f"local:{rid}")]
    assert "the copies of github.com/oscr-fixture/eeg-analysis" in w.row("reports", rid)["message"]


def test_anyone_s_request_to_remove_copies_for_copyright_hides_them_at_once(w, tmp_path):
    rid = ask(w, scope="file", scope_repo=EEG, scope_path="plot.py")
    w.poll()
    row = w.row("reports", rid)
    assert row["status"] == "accepted" and row["message"].startswith("Hidden at once")
    assert withheld(w) == [("file", P1, EEG, "plot.py", f"local:{rid}")]
    assert rules(w) == [("report", rid, "report.hide_at_once", "hidden")]
    # Neither copied nor shown from the source any more, at the next export.
    lots = catalog.script_lots(w.mac, public=True)
    plot = next(f for f in lots[catalog.lot_of(EEG)][EEG]["files"] if f["path"] == "plot.py")
    assert plot["text"] is None and "sha256" not in plot and plot["note"] == catalog.NOTE_WITHHELD
    # For personal data too; and a file of code held back for its license: no longer fetched.
    other = ask(w, user="u_s1", paper=P2, scope="repository", scope_repo=UNLICENSED, reason="personal_data")
    w.poll()
    assert w.row("reports", other)["status"] == "accepted"
    entry = catalog.script_lots(w.mac, public=True)[catalog.lot_of(UNLICENSED)][UNLICENSED]
    assert "source" not in entry and not any("sha256" in f for f in entry["files"])


def test_a_stranger_asking_to_remove_a_whole_record_hides_nothing_and_waits_thirty_days(w, tmp_path):
    rid = ask(w)                                               # the whole record, for copyright, by a stranger
    out = w.poll()
    assert (out.owner, out.written) == (1, 0)
    assert w.row("reports", rid)["status"] == "open" and withdrawn(w, P1) == ""
    assert withheld(w) == []
    listed = jobs.describe_waiting(jobs.waiting(w.state, "local", ("report",)))
    assert "the rules (report.review) close it by themselves on 26 October 2026" in listed
    # Nothing moves before the deadline...
    w.clock.t = T + 29 * DAY
    assert w.poll().closed == 0 and w.row("reports", rid)["status"] == "open"
    # ...then it is closed without removal, with how to ask again, and leaves the owner's list.
    w.clock.t = T + 30 * DAY + 1
    out = w.poll()
    assert (out.closed, out.written) == (1, 1)
    row = w.row("reports", rid)
    assert row["status"] == "rejected" and row["message"].startswith("Closed without removal")
    assert "verified author" in row["message"] and "@" not in row["message"]
    assert withdrawn(w, P1) == ""
    assert jobs.waiting(w.state, "local", ("report",)) == []
    assert rules(w) == [("report", rid, "report.review", "review"), ("report", rid, "report.expired", "rejected")]


def test_a_tracing_map_and_other_reasons_wait_for_the_operator(w):
    for values in ({"scope": "map"}, {"scope": "file", "scope_repo": EEG, "scope_path": "plot.py", "reason": "incorrect"},
                   {"scope": "scripts", "reason": "not_my_work"}):
        user = f"u_s{len(rules(w))}"
        rid = ask(w, user=user, **values)
        w.poll()
        assert w.row("reports", rid)["status"] == "open", values
    assert withheld(w) == []
    assert {r[2] for r in rules(w)} == {"report.review"}


def test_a_mass_of_requests_from_one_account_hides_three_then_waits(w):
    """One account, one request a paper (the Worker's rule), five papers in a day: three hidden at
    once, the others wait for the operator."""
    papers = [P1, P2, "doi:10.5555/oscr.fixture.3", "doi:10.5555/oscr.fixture.4", "doi:10.5555/oscr.fixture.5"]
    ids = [ask(w, paper=p, scope="scripts", details=f"Paper {n}: these scripts are mine and I never allowed a copy.")
           for n, p in enumerate(papers)]
    w.poll()
    assert [w.row("reports", i)["status"] for i in ids] == ["accepted"] * 3 + ["open"] * 2
    guard = [j["detail"]["guard"] for j in jobs.waiting(w.state, "local", ("report",))]
    assert len(guard) == 2 and all("this account had 3 copies hidden at once" in g for g in guard)
    assert len(withheld(w)) == 3


def test_the_same_justification_from_several_accounts_is_a_campaign(w):
    words = "Remove this, it is copyrighted material that belongs to our company!!"
    ids = [ask(w, user=f"u_s{n}", scope="file", scope_repo=EEG, scope_path="plot.py", details=words) for n in range(4)]
    w.poll()
    assert [w.row("reports", i)["status"] for i in ids] == ["accepted", "accepted", "open", "open"]
    assert "the same justification came with 3 requests" in jobs.waiting(w.state, "local", ("report",))[0]["detail"]["guard"]


def test_a_day_has_a_limit_of_hides_for_everyone(w, monkeypatch):
    monkeypatch.setattr(moderation, "HIDE_PER_DAY", 2)
    ids = [ask(w, user=f"u_s{n}", scope="scripts", details=f"My own words number {n}, the copy is not allowed.") for n in range(3)]
    w.poll()
    assert [w.row("reports", i)["status"] for i in ids] == ["accepted", "accepted", "open"]
    # The next day, it is hidden again.
    w.clock.t = T + DAY + 1
    late = ask(w, user="u_s5", scope="scripts", details="Yet other words of mine, the copy is not allowed here.")
    w.poll()
    assert w.row("reports", late)["status"] == "accepted"


def test_the_operator_decides_what_waits_and_reverses_what_the_rules_did(w, tmp_path, monkeypatch, capsys):
    waiting = ask(w)                                                        # a whole record: waits
    hidden = ask(w, user="u_s1", scope="file", scope_repo=EEG, scope_path="plot.py")
    w.poll()
    monkeypatch.setattr(community, "open_d1", lambda target, **kw: w.d1)
    monkeypatch.setattr(jobs, "MacHarvester", lambda client, opts: w.harvester)
    monkeypatch.setattr(moderation, "MacEvidence", lambda client: w.evidence)
    monkeypatch.setattr(cli, "settings", lambda: {})
    base = ["--db", str(tmp_path / "mac.db"), "--cache", str(tmp_path / "cache")]
    folder = ["--folder", str(tmp_path / "community")]
    w.state.close()
    w.state = w.runner.state = jobs.open_state(tmp_path / "community" / "state.db")
    # The same state, as the command line opens it: the log, the waits.
    for row in ([("local", T, "report", hidden, "u_s1", P1, "report.hide_at_once", "hidden", "{}")]):
        w.state.execute("INSERT INTO moderation_log (target, at, kind, ref, user_id, paper, rule, decision, detail) "
                        "VALUES (?,?,?,?,?,?,?,?,?)", row)
    w.state.commit()
    assert cli.main([*base, "reports", "list", "--auto-log", *folder]) == 0
    assert f"local report {hidden}  report.hide_at_once → hidden" in capsys.readouterr().out
    # Reverse the automatic hide: the copy comes back, the requester reads why.
    assert cli.main([*base, "reports", "reverse", str(hidden), "--local", "--message", "The file is MIT, copying it is allowed.",
                     *folder]) == 0
    assert "reversed, 1 withdrawal(s) undone" in capsys.readouterr().out
    assert withheld(w) == []
    assert (w.row("reports", hidden)["status"], w.row("reports", hidden)["message"]) == (
        "rejected", "The file is MIT, copying it is allowed.")
    # Accept what waits, by hand, as before.
    assert jobs.decide_report(w.runner, waiting, True, "Removed.").endswith("leaves the site at the next nightly")
    assert withdrawn(w, P1).endswith(f"request {waiting} (copyright)")
    kinds = [(e["ref"], e["rule"], e["decision"]) for e in moderation.entries(w.state, "local", ("report",))]
    assert (hidden, "owner.reversed", "reversed") in kinds and (waiting, "owner", "accepted") in kinds


def test_a_request_the_operator_reversed_is_not_hidden_again_by_the_rules(w):
    rid = ask(w, scope="file", scope_repo=EEG, scope_path="plot.py")
    w.poll()
    moderation.reverse_report(w.runner, rid, "Restored.")
    # The requester asks again (the Worker reopens it): it now waits for the operator.
    w.d1con.execute("UPDATE reports SET status = 'open', message = '', decided_at = NULL WHERE id = ?", (rid,))
    w.job("report", rid, "u_eve")
    w.poll()
    assert w.row("reports", rid)["status"] == "open" and withheld(w) == []
    assert "the operator already refused or reversed this request" in jobs.waiting(w.state, "local", ("report",))[0]["detail"]["guard"]


def test_requests_that_waited_for_the_owner_before_the_rules_go_to_them_once(w):
    rid = ask(w, user="u_ada", requester_role="author", author_verified=1, reason="other")
    # As the runner of 2026-09-28 left it: the job waiting for the owner, no rule applied.
    w.state.execute("INSERT INTO job (target, id, kind, ref, user_id, created_at, status, updated_at) VALUES "
                    "('local', 1, 'report', ?, 'u_ada', ?, 'owner', ?)", (rid, T, T))
    w.state.execute("INSERT INTO job_cursor (target, last_id) VALUES ('local', 1)")
    w.state.commit()
    w.poll()
    assert w.row("reports", rid)["status"] == "accepted"
    assert w.poll().new == 0 and rules(w) == [("report", rid, "report.verified_author", "accepted")]


def test_the_days_budget_leaves_the_deadlines_for_the_next_poll(w):
    ids = [ask(w, user=f"u_s{n}") for n in range(3)]
    w.poll()
    w.clock.t = T + 31 * DAY
    w.runner.budget = community.budget_spent(w.state, "local", community.utc_day(w.clock())) + 4
    out = w.poll()
    assert out.closed == 2
    assert [w.row("reports", i)["status"] for i in ids].count("rejected") == 2
    w.runner.budget = 100
    assert w.poll().closed == 1


# ---------------------------------------------------------------------------------------
# Submissions published by someone who is not among the paper's authors.

def _moderated(w, user="u_ben", doi="10.5555/oscr.fixture.7", urls=("https://github.com/oscr-fixture/new-code",)) -> int:
    sid = w.request("submissions", "submission", {"user_id": user, "doi": doi, "code_urls": json.dumps(list(urls)),
                                                  "created_at": T, "updated_at": T})
    w.poll()
    assert w.row("submissions", sid)["status"] == "draft"
    w.d1con.execute("UPDATE submissions SET status = 'moderation' WHERE id = ?", (sid,))
    w.job("publish", sid, user)
    return sid


def test_a_submission_nothing_ties_to_the_paper_waits_for_the_operator_then_closes(w):
    sid = _moderated(w)
    out = w.poll()
    assert (out.done, out.owner, out.written) == (0, 1, 1)
    row = w.row("submissions", sid)
    assert row["status"] == "moderation" and "https://github.com/oscr-fixture/new-code" in row["message"]
    assert "until 26 October 2026" in row["message"] and "anyone can write them" in row["message"]
    assert w.mac.execute("SELECT COUNT(*) FROM link WHERE article_id = 'doi:10.5555/oscr.fixture.7'").fetchone()[0] == 0
    assert rules(w, "submission") == [("submission", sid, "submission.review", "review")]
    assert w.poll().written == 0, "told once"
    w.clock.t = T + 31 * DAY
    assert w.poll().closed == 1
    row = w.row("submissions", sid)
    assert row["status"] == "refused" and row["message"].startswith("Closed without publication")
    assert "sign in with the ORCID iD the paper lists" in row["message"] and "@" not in row["message"]
    assert rules(w, "submission")[-1] == ("submission", sid, "submission.expired", "refused")
    assert jobs.waiting(w.state, "local", ("publish",)) == []


def test_abuse_a_readme_that_cites_the_paper_publishes_nothing(w):
    """An attacker makes a repository whose README cites someone else's paper, then submits it."""
    sid = _moderated(w, urls=("https://github.com/attacker/fake-code",))
    w.mac.execute("UPDATE repository SET cites_article = 'doi' WHERE repo = 'github.com/attacker/fake-code'")
    w.mac.commit()
    w.poll()
    assert w.row("submissions", sid)["status"] == "moderation"
    assert w.mac.execute("SELECT COUNT(*) FROM link WHERE repo = 'github.com/attacker/fake-code' AND role = 'code' "
                         "AND article_id = 'doi:10.5555/oscr.fixture.7'").fetchone()[0] == 0
    # The operator sees it, and why it proves nothing.
    guard = jobs.waiting(w.state, "local", ("publish",))[0]["detail"]["guard"]
    assert "its README cites the paper (anyone can write that)" in guard


def test_abuse_a_github_display_name_that_bears_an_authors_name_publishes_nothing(w):
    """An attacker sets their GitHub display name to an author's ("Ada Fixture"), then submits their
    own repository: the Mac's lookups never read display names."""
    class Client:
        asked: list[str] = []

        def get(self, url, **kw):
            self.asked.append(url)
            body = {"type": "User", "name": "Ada Fixture"} if "api.github.com/users/" in url else {"researcher-url": []}
            return type("R", (), {"ok": True, "json": lambda self: body})()

    w.runner.evidence = moderation.MacEvidence(Client())
    sid = _moderated(w, urls=("https://github.com/ada-impostor/code",))
    w.poll()
    assert w.row("submissions", sid)["status"] == "moderation"
    assert not any("api.github.com" in u for u in Client.asked)
    assert rules(w, "submission") == [("submission", sid, "submission.review", "review")]


@pytest.mark.parametrize("how", ["text", "crossref", "archive", "orcid", "roles"])
def test_a_submission_whose_links_are_proven_the_papers_is_published(w, how):
    repo, paper = "github.com/oscr-fixture/new-code", "doi:10.5555/oscr.fixture.7"
    sid = _moderated(w)
    link = ("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by, reasons) VALUES "
            "(?, ?, ?, ?, ?, 'code', 'high', ?, ?)")
    if how == "text":
        w.mac.execute(link, (paper, repo, "https://github.com/oscr-fixture/new-code", "github.com", "forge", "text:availability", "[]"))
    elif how == "crossref":
        w.mac.execute(link, (paper, repo, "https://github.com/oscr-fixture/new-code", "github.com", "forge",
                             "crossref:is-supplemented-by", "[]"))
    elif how == "archive":
        # The paper cites a Zenodo record, whose record names the GitHub repository it archives.
        w.mac.execute(link, (paper, "zenodo:77", "https://zenodo.org/records/77", "zenodo.org", "archive", "text:availability", "[]"))
        w.mac.execute(link, (paper, repo, "https://github.com/oscr-fixture/new-code", "github.com", "forge", "zenodo:source",
                             json.dumps(["source declared by the record of zenodo:77"])))
    elif how == "orcid":
        w.evidence.owners[repo] = "the ORCID record of Ada Fixture, an author, links to github.com/oscr-fixture"
    else:
        # Ada, a verified author of the paper, is the repository's owner on GitHub.
        w.d1con.execute("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES "
                        "('u_ada', 'verified_author', 'paper', ?, 'system', ?)", (paper, T))
        maintainer(w, "u_ada", repo)
    w.mac.commit()
    w.poll()
    row = w.row("submissions", sid)
    assert row["status"] == "published", row["message"]
    assert "Published by the registry's rules" in row["message"]
    assert rules(w, "submission") == [("submission", sid, "submission.corroborated", "published")]
    if how in ("orcid", "roles"):
        # The operator may take it back: the links leave the record, as a new version.
        assert "reversed" in moderation.reverse_submission(w.runner, sid, "Not the paper's code.")
        assert w.mac.execute("SELECT COUNT(*) FROM link WHERE article_id = ? AND repo = ?", (paper, repo)).fetchone()[0] == 0
        assert w.row("submissions", sid)["status"] == "refused"


@pytest.mark.parametrize("found_by", ["datacite:Software", "github:readme"])
def test_abuse_a_link_only_a_third_partys_record_declares_is_not_the_papers(w, found_by):
    """A DataCite record anyone can deposit (a Zenodo upload saying "supplement to" the paper), a README
    found on GitHub: the harvester keeps what they say, the rules do not take it as the paper's word."""
    repo, paper = "github.com/oscr-fixture/new-code", "doi:10.5555/oscr.fixture.7"
    sid = _moderated(w)
    w.mac.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES "
                  "(?, ?, 'https://github.com/oscr-fixture/new-code', 'github.com', 'forge', 'code', 'high', ?)",
                  (paper, repo, found_by))
    w.mac.commit()
    w.poll()
    assert w.row("submissions", sid)["status"] == "moderation"


def test_a_verified_author_who_only_contributed_to_the_repository_proves_nothing(w):
    repo, paper = "github.com/oscr-fixture/new-code", "doi:10.5555/oscr.fixture.7"
    sid = _moderated(w)
    w.d1con.execute("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES "
                    "('u_ada', 'verified_author', 'paper', ?, 'system', ?)", (paper, T))
    maintainer(w, "u_ada", repo, via="contributor")
    w.poll()
    assert w.row("submissions", sid)["status"] == "moderation"


def test_an_off_topic_submission_is_refused_by_the_rules(w):
    sid = _moderated(w)
    w.mac.execute("UPDATE article SET on_topic = 'no' WHERE id = 'doi:10.5555/oscr.fixture.7'")
    w.mac.commit()
    w.poll()
    assert "outside the registry's scope" in w.row("submissions", sid)["message"]


def test_a_draft_left_unpublished_is_closed_after_thirty_days(w):
    sid = w.request("submissions", "submission", {"user_id": "u_ben", "doi": "10.5555/oscr.fixture.8",
                                                  "code_urls": json.dumps(["https://github.com/oscr-fixture/x"]),
                                                  "created_at": T, "updated_at": T})
    w.poll()
    assert w.row("submissions", sid)["status"] == "draft"
    w.clock.t = T + 31 * DAY
    assert w.poll().closed == 1
    row = w.row("submissions", sid)
    assert row["status"] == "refused" and "was not published within 30 days" in row["message"]
    assert rules(w, "submission") == [("submission", sid, "submission.draft_expired", "refused")]


def test_a_draft_corrected_meanwhile_gets_a_new_deadline(w):
    sid = w.request("submissions", "submission", {"user_id": "u_ben", "doi": "10.5555/oscr.fixture.8",
                                                  "code_urls": json.dumps(["https://github.com/oscr-fixture/x"]),
                                                  "created_at": T, "updated_at": T})
    w.poll()
    w.clock.t = T + 20 * DAY
    w.d1con.execute("UPDATE submissions SET status = 'queued', updated_at = ? WHERE id = ?", (int(w.clock()), sid))
    w.job("submission", sid, "u_ben")
    w.poll()
    w.clock.t = T + 31 * DAY
    assert w.poll().closed == 0 and w.row("submissions", sid)["status"] == "draft"


# ---------------------------------------------------------------------------------------
# Claims.

def _claim(w, user="u_ben", kind="author", paper=P2, repo="", **evidence) -> int:
    ev = {"statement": "I am the second author.", "link": "https://lab.example/ben", **evidence}
    return w.request("claims", "claim", {"user_id": user, "kind": kind, "paper_id": paper, "repo": repo,
                                         "evidence": json.dumps(ev), "status": "pending", "created_at": int(w.clock())})


def test_a_claim_the_papers_metadata_proves_is_verified(w):
    w.user("u_ben2", "Ben Again", orcid=BEN)
    cid = _claim(w, user="u_ben2")
    w.poll()
    row = w.row("claims", cid)
    assert (row["status"], row["decided_by"]) == ("verified", "rules") and "lists your ORCID iD" in row["message"]
    role = w.d1con.execute("SELECT role, scope_id, granted_by FROM roles WHERE user_id = 'u_ben2'").fetchone()
    assert tuple(role) == ("verified_author", P2, "rules")


def test_a_claim_crossref_put_in_the_claimants_orcid_record_is_verified_now_or_on_a_later_check(w):
    w.user("u_new", "New Author", orcid="0000-0000-0000-0052")
    cid = _claim(w, user="u_new", orcid_issuer="orcid")
    assert w.poll().owner == 1
    assert ("works", "0000-0000-0000-0052", "10.5555/oscr.fixture.2", False) in w.evidence.asked
    # The claimant adds the paper to their ORCID record: the next day's check verifies the claim.
    w.evidence.works["0000-0000-0000-0052"] = {"10.5555/oscr.fixture.2"}
    w.clock.t = T + DAY / 2
    assert w.poll().verified == 0
    w.clock.t = T + DAY + 1
    assert w.poll().verified == 1
    assert (w.row("claims", cid)["status"], w.row("claims", cid)["decided_by"]) == ("verified", "rules")
    assert jobs.waiting(w.state, "local", ("claim",)) == []


def test_a_sandbox_ids_record_is_looked_up_in_the_sandbox(w):
    w.user("u_sb", "Sandbox Person", orcid="0000-0000-0000-0060")
    _claim(w, user="u_sb")                                   # no issuer said: the sandbox, the site's default
    w.poll()
    assert ("works", "0000-0000-0000-0060", "10.5555/oscr.fixture.2", True) in w.evidence.asked


def test_an_unproven_claim_is_closed_after_thirty_days_and_the_owner_can_reverse_a_verified_one(w):
    cid = _claim(w)
    w.poll()
    w.clock.t = T + 30 * DAY + 1
    w.poll()
    row = w.row("claims", cid)
    assert (row["status"], row["decided_by"]) == ("rejected", "rules") and "then claim it again" in row["message"]
    w.user("u_ben2", "Ben Again", orcid=BEN)
    other = _claim(w, user="u_ben2")
    w.poll()
    assert "reversed" in moderation.reverse_claim(w.runner, other, "Not this Ben.")
    assert w.d1con.execute("SELECT COUNT(*) FROM roles WHERE user_id = 'u_ben2'").fetchone()[0] == 0
    assert (w.row("claims", other)["status"], w.row("claims", other)["decided_by"]) == ("rejected", "owner")


def test_a_maintainer_claim_github_did_not_settle_is_closed_after_thirty_days(w):
    cid = _claim(w, kind="maintainer", paper="", repo="gitlab.com/lab/tool")
    assert w.poll().owner == 1
    w.clock.t = T + 31 * DAY
    w.poll()
    row = w.row("claims", cid)
    assert row["status"] == "rejected" and "Only GitHub can be checked automatically" in row["message"]
    assert rules(w, "claim") == [("claim", cid, "claim.maintainer_review", "review"), ("claim", cid, "claim.expired", "rejected")]


# ---------------------------------------------------------------------------------------
# What reaches a public page from an account.

@pytest.mark.parametrize("given, kept", [
    ("Ada Lovelace", "Ada Lovelace"),
    ("  José   María  ", "José María"),
    ("Buy pills at cheap-pills.com", ""),
    ("see https://spam.example", ""),
    ("www.spam.example", ""),
    ("name@lab.org", ""),
    ("‮evil‬ Name", "evil Name"),
    ("12345", ""),
    ("A" * 150, "A" * 100),
])
def test_an_accounts_name_is_public_only_when_it_is_a_name(given, kept):
    assert moderation.public_name(given) == kept


def test_corrections_and_validations_are_still_only_verified_peoples(w):
    """The Worker refuses them to anyone else (tests/contributions/routes.test.ts); the Mac applies what
    comes, without a rule of its own — and never logs them as moderated."""
    eid = w.request("edits", "edit", {"user_id": "u_ada", "paper_id": P1, "as_role": "verified_author", "repo": "",
                                      "changes": json.dumps([{"op": "role", "repo": EEG, "role": "tool"}]), "created_at": T})
    w.poll()
    assert w.row("edits", eid)["status"] == "applied"
    assert rules(w) == []


# ---------------------------------------------------------------------------------------
# The owner overrides the rules.

def test_the_owner_may_accept_what_the_rules_refused_or_closed(w):
    # A submission the rules could not prove, then closed after 30 days: published by the owner.
    sid = _moderated(w)
    w.poll()
    w.clock.t = T + 31 * DAY
    w.poll()
    assert w.row("submissions", sid)["status"] == "refused"
    assert jobs.decide_submission(w.runner, sid, True, "We checked it with the authors.").endswith("published")
    assert w.row("submissions", sid)["status"] == "published"
    w.clock.t = T
    # A whole record's removal the rules closed after 30 days: accepted by the owner.
    rid = ask(w)
    w.poll()
    w.clock.t = T + 31 * DAY
    w.poll()
    assert w.row("reports", rid)["status"] == "rejected"
    assert "leaves the site at the next nightly" in jobs.decide_report(w.runner, rid, True, "Removed after review.")
    assert (w.row("reports", rid)["status"], withdrawn(w, P1) != "") == ("accepted", True)
    # A claim the rules closed: verified by the owner, a role the sign-in's sync never takes back.
    cid = _claim(w)
    w.poll()
    w.clock.t = T + 62 * DAY
    w.poll()
    assert w.row("claims", cid)["decided_by"] == "rules"
    jobs.decide_claim(w.runner, cid, True, "Welcome.")
    assert (w.row("claims", cid)["status"], w.row("claims", cid)["decided_by"]) == ("verified", "owner")
    # What the owner refused stays refused: the owner's own no is not overridden by these commands.
    other = ask(w, user="u_s3")
    w.poll()
    jobs.decide_report(w.runner, other, False, "The record is correct.")
    assert jobs.decide_report(w.runner, other, True).endswith("is already rejected")


# ---------------------------------------------------------------------------------------
# What a claimant or a contributor could forge.

def _work(doi: str, **source) -> dict:
    return {"external-ids": {"external-id": [{"external-id-type": "doi", "external-id-value": doi.upper()}]},
            "work-summary": [{"source": source}]}


def test_abuse_a_paper_the_claimant_added_to_their_own_orcid_record_proves_nothing():
    """Anyone can add any paper to their own ORCID record, by hand or through a search wizard: only a
    work Crossref's automatic update added (the publisher deposited the iD with the paper) counts."""
    doi = "10.5555/oscr.fixture.2"
    crossref = {"source-client-id": {"path": moderation.CROSSREF_AUTO_UPDATE}, "source-name": {"value": "Crossref"}}
    cases = [
        ({"source-orcid": {"path": "0000-0000-0000-0052"}, "source-name": {"value": "Mallory"}}, False),      # by hand
        ({"source-client-id": {"path": "0000-0002-3054-1567"}, "source-name": {"value": "Crossref Metadata Search"},
          "assertion-origin-name": {"value": "Mallory"}}, False),                                             # a wizard
        ({"source-client-id": {"path": "0000-0002-5982-8983"}, "source-name": {"value": "Scopus - Elsevier"},
          "assertion-origin-orcid": {"path": "0000-0000-0000-0052"}}, False),
        ({**crossref, "assertion-origin-orcid": {"path": "0000-0000-0000-0052"}}, False),                   # on someone's behalf
        (crossref, True),
    ]
    for source, counts in cases:
        assert moderation.crossref_listed({"group": [_work(doi, **source)]}, doi) is counts, source
    assert moderation.crossref_listed({"group": [_work("10.1/other", **crossref)]}, doi) is False


def test_the_macs_orcid_lookup_reads_only_crossrefs_work(w):
    class Client:
        def get(self, url, **kw):
            works = {"group": [_work("10.5555/oscr.fixture.2", **{"source-orcid": {"path": "0000-0000-0000-0052"}})]}
            return type("R", (), {"ok": True, "json": lambda self: works})()

    w.runner.evidence = moderation.MacEvidence(Client())
    w.user("u_mal", "Mallory", orcid="0000-0000-0000-0052")
    cid = _claim(w, user="u_mal", orcid_issuer="orcid")
    w.poll()
    assert w.row("claims", cid)["status"] == "pending"
    assert w.d1con.execute("SELECT COUNT(*) FROM roles WHERE user_id = 'u_mal'").fetchone()[0] == 0


def test_abuse_a_contributor_is_not_trusted_as_a_maintainer(w):
    """One merged pull request makes a GitHub contributor, whom the Worker's check shows as a maintainer:
    the rules neither apply their removal at once, nor let them change the paper's record."""
    maintainer(w, "u_ben", EEG, via="contributor")
    rid = ask(w, user="u_ben", scope="repository", scope_repo=EEG, reason="other", requester_role="other")
    w.poll()
    assert w.row("reports", rid)["status"] == "open" and withheld(w) == []
    eid = w.request("edits", "edit", {"user_id": "u_ben", "paper_id": P1, "as_role": "maintainer", "repo": EEG,
                                      "changes": json.dumps([{"op": "remove", "repo": EEG}]), "created_at": T})
    w.poll()
    row = w.row("edits", eid)
    assert row["status"] == "refused" and "not as its owner or a public member of its organization" in row["message"]
    assert w.mac.execute("SELECT COUNT(*) FROM link WHERE article_id = ? AND repo = ?", (P1, EEG)).fetchone()[0] == 1
    assert ("edit", eid, "edit.untrusted_maintainer", "refused") in rules(w)
    # The owner of the repository is trusted.
    maintainer(w, "u_eve", EEG, via="owner")
    other = ask(w, user="u_eve", scope="repository", scope_repo=EEG, reason="other", requester_role="other")
    w.poll()
    assert w.row("reports", other)["status"] == "accepted"
