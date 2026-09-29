"""Data rights (oscr/rights.py; the page /data-rights/): every right, answered by `oscr jobs poll` in
the safe direction — access, erasure and objection for an account signed in with its ORCID iD, the
account deleted; the rest handed to the operator with its legal deadline, never closed unanswered. The
contact details' suppression list (oscr/contacts.py), which the collection and the private dataset
honour, and the private dataset's history rewritten after an erasure (a mocked HfApi: never Hugging
Face). D1 is an SQLite database made from the real migrations."""
import calendar
import hashlib
import json
import sqlite3
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests"))

from test_jobs import ADA, BEN, P1, P2, T, World  # noqa: E402

from oscr import catalog, contacts, jobs, moderation, rights  # noqa: E402

DAY = moderation.DAY
ADA_MAIL = "ada.fixture@fixture-university.edu"
BEN_MAIL = "ben.example@fixture-university.edu"


class Clock:
    def __init__(self, t: float):
        self.t = t

    def __call__(self) -> float:
        return self.t


def _row(position, name, orcid, email, organization="Fixture University", address="1 Synapse Street, Lyon, France"):
    given, _, family = name.rpartition(" ")
    return {"position": position, "given": given, "family": family, "name": name, "orcid": orcid, "email": email,
            "organization": organization, "address": address, "affiliation": f"{organization}, {address}",
            "corresponding": position == 1, "source": "jats"}


@pytest.fixture
def w(tmp_path):
    world = World(tmp_path)
    world.user("u_ada", "Ada Fixture", orcid=ADA)
    world.user("u_ben", "Ben Example", github="ben-example")
    world.user("u_eve", "Eve Stranger")
    world.clock = Clock(T)
    world.runner.now = world.clock
    # What the papers publish of their authors (oscr/contacts.py): Ada with her iD on paper 1; on paper 2
    # without it, but with her address and her family name; Otto, another author, shares that address.
    contacts.write(world.mac, P1, [_row(1, "Ada Fixture", ADA, ADA_MAIL), _row(2, "Ben Example", BEN, BEN_MAIL),
                                   _row(3, "Cleo Nameless", "", "cleo.nameless@fixture-university.edu")], T)
    contacts.write(world.mac, P2, [_row(1, "Ada Fixture", "", ADA_MAIL), _row(2, "Otto Other", "", ADA_MAIL),
                                   _row(3, "Ben Example", BEN, BEN_MAIL)], T)
    world.mac.commit()
    return world


def ask(w, kind, user="u_ada", orcid=ADA, proof="orcid", details="", at=None) -> int:
    t = int(at if at is not None else w.clock())
    return w.request("rights", "rights", {"user_id": user, "kind": kind, "details": details, "orcid": orcid,
                                          "proof": proof if orcid else "", "created_at": t,
                                          "due_at": int(rights.one_month_after(t))})


def held(w, orcid=None):
    sql = "SELECT article_id, position, name, orcid, email FROM contact"
    return sorted(tuple(r) for r in w.mac.execute(sql + (" WHERE orcid = ?" if orcid else ""), (orcid,) if orcid else ()))


def every_text(con):
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    return "\n".join(str(v) for t in tables for r in con.execute(f"SELECT * FROM {t}") for v in tuple(r) if isinstance(v, str))


# ---------------------------------------------------------------------------------------
# The legal deadline.

def test_the_legal_deadline_is_one_calendar_month_later():
    def stamp(s):
        return calendar.timegm(time.strptime(s, "%Y-%m-%d"))

    def day(t):
        return time.strftime("%Y-%m-%d", time.gmtime(t))

    assert day(rights.one_month_after(stamp("2026-09-29"))) == "2026-10-29"
    assert day(rights.one_month_after(stamp("2026-01-31"))) == "2026-02-28"
    assert day(rights.one_month_after(stamp("2028-01-31"))) == "2028-02-29"
    assert day(rights.one_month_after(stamp("2026-12-15"))) == "2027-01-15"
    fixture = json.loads((ROOT / "tests" / "fixtures" / "one_month.json").read_text())
    for case in fixture:
        assert day(rights.one_month_after(stamp(case["from"]))) == case["due"], case


# ---------------------------------------------------------------------------------------
# Access.

def test_access_with_an_orcid_id_answers_field_by_field_with_the_addresses_masked(w):
    rid = ask(w, "access")
    out = w.poll()
    assert (out.done, out.owner, out.written) == (1, 0, 1)
    row = w.row("rights", rid)
    assert row["status"] == "done" and row["decided_at"] == T
    assert row["message"].startswith("Answered: the registry keeps 2 row(s) of contact details under your ORCID iD, from 2 paper(s)")
    answer = json.loads(row["answer"])
    assert answer["matched"] == "orcid" and answer["orcid"] == ADA
    c = answer["contacts"]
    assert (c["rows"], c["papers"], c["emails"], c["more"], c["suppressed"]) == (2, 2, 1, 0, False)
    first = c["listed"][0]
    assert first["paper"]["id"] == P1 and first["tied_by"] == "orcid" and first["fields"]["email"] == "a…e at fixture-university.edu"
    assert first["fields"]["organization"] == "Fixture University" and first["fields"]["address"].startswith("1 Synapse")
    assert c["listed"][1]["paper"]["id"] == P2 and c["listed"][1]["tied_by"] == "address"
    # Never another author's row, never an address in full, never an at sign in D1.
    assert "Ben Example" not in row["answer"] and "Otto" not in row["answer"] and "Cleo" not in row["answer"]
    assert ADA_MAIL not in every_text(w.d1con) and "@" not in row["answer"]
    assert answer["authorship"]["papers"] >= 1 and any(p["id"] == P1 for p in answer["authorship"]["listed"])
    assert answer["operator"]["requests"]["kept"] == 1
    assert moderation.entries(w.state, "local", ("rights",))[-1]["rule"] == "rights.access"


def test_access_from_orcid_s_sandbox_shows_no_contact_detail(w):
    rid = ask(w, "access", proof="orcid-sandbox")
    w.poll()
    row = w.row("rights", rid)
    assert row["status"] == "done" and "sandbox" in row["message"]
    answer = json.loads(row["answer"])
    assert answer["matched"] == "sandbox" and "contacts" not in answer
    assert "fixture-university" not in row["answer"]


def test_a_github_account_is_not_matched_and_waits_for_the_operator(w):
    """Ben's display name is an author's name on both papers: it proves nothing, and nothing of the
    contact rows reaches his request."""
    rid = ask(w, "access", user="u_ben", orcid="")
    out = w.poll()
    assert out.owner == 1
    row = w.row("rights", rid)
    assert row["status"] == "waiting" and row["decided_at"] is None
    assert "Your account has no ORCID iD" in row["message"] and "by 26 October 2026" in row["message"]
    answer = json.loads(row["answer"])
    assert answer["matched"] == "none" and "contacts" not in answer and "authorship" not in answer
    assert "fixture-university" not in row["answer"] and BEN not in row["answer"]
    listed = rights.describe_waiting(jobs.waiting(w.state, "local", ("rights",)), now=T)
    assert f"data-rights request {rid}: access, from Ben Example, GitHub ben-example — answer by 26 October 2026" in listed
    assert "30 day(s) left" in listed
    # An erasure too: the rows stay until the operator looks.
    eid = ask(w, "erasure", user="u_ben", orcid="")
    w.poll()
    assert w.row("rights", eid)["status"] == "waiting"
    assert held(w, BEN) != []


def test_someone_asking_for_another_person_s_data_is_refused(w):
    """A request whose iD is not its account's own (Ada's account naming Ben's iD) is refused, and
    answers nothing about anyone."""
    rid = ask(w, "access", user="u_ada", orcid=BEN)
    eid = ask(w, "erasure", user="u_eve", orcid=BEN)
    w.poll()
    for r in (rid, eid):
        row = w.row("rights", r)
        assert row["status"] == "refused" and row["message"].startswith("Refused: the ORCID iD this request names is not")
        assert json.loads(row["answer"]) == {}
    assert held(w, BEN) != []            # nothing erased
    assert contacts.suppressed(w.mac) == (set(), set())


# ---------------------------------------------------------------------------------------
# Erasure and objection.

@pytest.mark.parametrize("kind", ["erasure", "objection"])
def test_erasure_and_objection_delete_the_rows_and_suppress_the_person(w, kind):
    rid = ask(w, kind)
    w.poll()
    row = w.row("rights", rid)
    assert row["status"] == "done"
    assert row["message"].startswith("Done: 2 row(s) of contact details about you, from 2 paper(s), are erased")
    assert "next nightly publication" in row["message"] and "rewrites its history" in row["message"]
    assert json.loads(row["answer"])["erased"] == {"rows": 2, "papers": 2, "emails": 1, "blanked": 1, "suppressed": True,
                                                   "right": kind}
    # Ada's rows are gone; Otto's row stays, without her address; Ben's and Cleo's are untouched.
    assert held(w, ADA) == []
    assert (P2, 2, "Otto Other", "", "") in held(w)
    assert (P1, 2, "Ben Example", BEN, BEN_MAIL) in held(w)
    assert not any(ADA_MAIL == r[4] for r in held(w))
    orcids, digests = contacts.suppressed(w.mac)
    assert orcids == {ADA} and digests == {contacts.email_digest(ADA_MAIL)}
    assert ADA_MAIL not in every_text(w.mac)
    assert contacts.pending_publication(w.mac) == 2
    # A later reading of the papers never collects her again (contacts.write honours the list).
    contacts.write(w.mac, P1, [_row(1, "Ada Fixture", ADA, ADA_MAIL), _row(2, "Ben Example", BEN, BEN_MAIL)], T + DAY)
    contacts.write(w.mac, "doi:10.5555/oscr.fixture.3", [_row(1, "A. Fixture", "", ADA_MAIL.upper())], T + DAY)
    assert held(w, ADA) == [] and not any(r[4].lower() == ADA_MAIL for r in held(w))
    # Nor does the private dataset's table, whatever the database holds.
    w.mac.execute("INSERT INTO contact (article_id, position, email, name, orcid, found_at) VALUES (?, 9, ?, 'Ada', ?, ?)",
                  (P1, ADA_MAIL, ADA, T))
    assert not any(r["orcid"] == ADA or r["email"] == ADA_MAIL for r in contacts.table(w.mac))


def test_an_erasure_rewrites_the_private_dataset_s_history_at_its_next_publication(w, tmp_path, monkeypatch):
    calls = []

    class FakeApi:
        """Hugging Face as contacts.publish sees it: never reached for real."""

        def __init__(self, token=None):
            pass

        def dataset_info(self, repo):
            return SimpleNamespace(private=True)

        def upload_folder(self, **kw):
            calls.append(("upload", kw["repo_id"]))

        def super_squash_history(self, repo_id, *, repo_type=None, commit_message=None, branch=None):
            calls.append(("squash", repo_id, repo_type))

        def list_lfs_files(self, repo_id, *, repo_type=None):
            current = hashlib.sha256((tmp_path / "p" / "contacts.parquet").read_bytes()).hexdigest()
            return [SimpleNamespace(oid=current, file_oid="f0", filename="contacts.parquet"),
                    SimpleNamespace(oid="old1", file_oid="f1", filename="contacts.parquet"),
                    SimpleNamespace(oid="old2", file_oid="f2", filename="contacts.parquet")]

        def permanently_delete_lfs_files(self, repo_id, lfs_files, *, rewrite_history=True, repo_type=None):
            calls.append(("delete", repo_id, sorted(f.oid for f in lfs_files), rewrite_history, repo_type))

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "HfApi", FakeApi)
    monkeypatch.setattr("oscr.scriptstore.token", lambda: None)
    # No erasure yet: an ordinary publication, the history untouched.
    contacts.publish(w.mac, tmp_path / "p", "Org/Private")
    assert calls == [("upload", "Org/Private")]
    calls.clear()
    ask(w, "erasure")
    w.poll()
    assert "history would be rewritten" in contacts.publish(w.mac, tmp_path / "p", "Org/Private", dry_run=True)
    assert calls == []
    said = contacts.publish(w.mac, tmp_path / "p", "Org/Private", now=T + DAY)
    assert calls == [("upload", "Org/Private"), ("squash", "Org/Private", "dataset"),
                     ("delete", "Org/Private", ["old1", "old2"], True, "dataset")]
    assert "history rewritten, 2 earlier file(s) deleted" in said
    assert contacts.pending_publication(w.mac) == 0
    import pyarrow.parquet as pq
    sent = pq.read_table(tmp_path / "p" / "contacts.parquet").to_pylist()
    assert sent and not any(r["orcid"] == ADA or r["email"] == ADA_MAIL for r in sent)
    # The next night, nothing pending: no rewriting.
    calls.clear()
    contacts.publish(w.mac, tmp_path / "p", "Org/Private")
    assert calls == [("upload", "Org/Private")]


def test_the_history_is_not_purged_when_the_current_file_cannot_be_recognized(w, tmp_path, monkeypatch):
    deleted = []

    class FakeApi:
        def __init__(self, token=None):
            pass

        def dataset_info(self, repo):
            return SimpleNamespace(private=True)

        def upload_folder(self, **kw):
            pass

        def super_squash_history(self, repo_id, **kw):
            pass

        def list_lfs_files(self, repo_id, **kw):
            return [SimpleNamespace(oid="x", file_oid="y", filename="contacts.parquet")]

        def permanently_delete_lfs_files(self, *a, **kw):
            deleted.append(a)

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "HfApi", FakeApi)
    monkeypatch.setattr("oscr.scriptstore.token", lambda: None)
    ask(w, "objection")
    w.poll()
    with pytest.raises(SystemExit, match="were NOT deleted"):
        contacts.publish(w.mac, tmp_path / "p", "Org/Private")
    assert deleted == [] and contacts.pending_publication(w.mac) == 2      # tried again at the next publication


def test_the_public_catalogue_holds_no_contact_and_no_suppression_list(w, tmp_path):
    """The owner's other dataset (opsecsystems/oscr-catalog) is the public export (catalog.public_db):
    it holds neither the contact rows nor who asked not to be kept."""
    ask(w, "erasure")
    w.poll()
    catalog.public_db(w.mac, tmp_path / "public.db")
    pub = sqlite3.connect(tmp_path / "public.db")
    names = {r[0] for r in pub.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "contact" not in names and "contact_suppressed" not in names
    assert BEN_MAIL not in every_text(pub) and contacts.email_digest(ADA_MAIL) not in every_text(pub)


def test_a_backup_copy_is_brought_in_line_with_the_suppression_list(w, tmp_path):
    backup = tmp_path / "backup.db"
    w.mac.commit()
    w.mac.execute(f"VACUUM INTO '{backup}'")
    ask(w, "erasure")
    w.poll()
    copy = sqlite3.connect(backup)
    assert copy.execute("SELECT COUNT(*) FROM contact WHERE orcid = ?", (ADA,)).fetchone()[0] == 1
    assert contacts.apply_suppression(copy, contacts.suppressed(w.mac)) >= 3
    assert copy.execute("SELECT COUNT(*) FROM contact WHERE orcid = ? OR email = ?", (ADA, ADA_MAIL)).fetchone()[0] == 0
    assert copy.execute("SELECT COUNT(*) FROM contact WHERE name = 'Otto Other'").fetchone()[0] == 1


# ---------------------------------------------------------------------------------------
# What waits for the operator: never closed unanswered.

def test_a_rectification_waits_for_the_operator_and_is_never_closed(w):
    rid = ask(w, "rectification", details="My affiliation is now the Institute of Invented Methods.")
    assert w.poll().owner == 1
    row = w.row("rights", rid)
    assert row["status"] == "waiting" and "never closed unanswered" in row["message"]
    # Forty days of polls: still waiting, flagged overdue for the operator.
    for day in range(1, 41):
        w.clock.t = T + day * DAY
        w.poll()
    assert w.row("rights", rid)["status"] == "waiting"
    listed = rights.describe_waiting(jobs.waiting(w.state, "local", ("rights",)), now=w.clock.t)
    assert f"data-rights request {rid}: rectification" in listed and "OVERDUE by 10 day(s)" in listed
    assert "their words: My affiliation is now the Institute of Invented Methods." in listed
    assert "1 request(s) about personal data wait for you" in jobs.status(w.state, now=w.clock.t)
    assert "1 OVERDUE" in jobs.status(w.state, now=w.clock.t)
    with pytest.raises(SystemExit, match="say why"):
        rights.decide(w.runner, rid, "refuse")
    assert rights.decide(w.runner, rid, "done", "Corrected: your affiliation reads so now.").endswith("done")
    row = w.row("rights", rid)
    assert (row["status"], row["message"]) == ("done", "Corrected: your affiliation reads so now.")
    assert jobs.waiting(w.state, "local", ("rights",)) == []


def test_the_operator_refuses_with_reasons_and_the_right_to_complain(w):
    rid = ask(w, "rectification", details="Please change my family name in the paper itself.")
    w.poll()
    rights.decide(w.runner, rid, "refuse", "The registry keeps what the paper publishes; the paper's publisher corrects it.")
    row = w.row("rights", rid)
    assert row["status"] == "refused" and row["message"].endswith(
        "You may lodge a complaint with the data protection authority of the country where you live or work.")


def test_the_operator_erases_the_rows_found_for_an_account_without_an_orcid_id(w):
    rid = ask(w, "erasure", user="u_ben", orcid="")
    w.poll()
    said = rights.decide(w.runner, rid, "erase", rows=[(P1, 2), (P2, 3)])
    assert said.endswith("done")
    assert held(w, BEN) == []
    assert BEN in contacts.suppressed(w.mac)[0]
    assert w.row("rights", rid)["message"].startswith("Done: 2 row(s) of contact details about you, from 2 paper(s)")


def test_a_request_the_machine_fails_to_answer_goes_to_the_operator_never_closed(w, monkeypatch):
    def broken(*a, **kw):
        raise RuntimeError("the database is locked")

    monkeypatch.setattr(rights, "access", broken)
    rid = ask(w, "access")
    for _ in range(jobs.MAX_ATTEMPTS):
        w.poll()
    row = w.row("rights", rid)
    assert row["status"] == "waiting" and "could not complete this request by itself" in row["message"]
    assert w.state.execute("SELECT status FROM job WHERE kind = 'rights'").fetchone()[0] == "owner"


# ---------------------------------------------------------------------------------------
# The account deleted.

def test_the_account_is_deleted_and_the_mac_names_it_by_its_number_only(w):
    w.d1con.execute("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('github', '5150001', 'u_ben', ?)", (T,))
    w.d1con.execute("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('h1', 'u_ben', ?, ?, ?)",
                    (T, T + 30 * DAY, T))
    w.d1con.execute("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES "
                    "('u_ben', 'maintainer', 'repo', 'github.com/oscr-fixture/unlicensed', 'system', ?)", (T,))
    report = w.request("reports", "report", {"user_id": "u_ben", "target_kind": "paper", "target_id": P1, "reason": "other",
                                             "details": "An old request that the operator decided already.", "status": "rejected",
                                             "created_at": T})
    w.d1con.execute("INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('h2', 'u_ada', ?, ?, ?)",
                    (T, T + 30 * DAY, T))
    w.d1con.commit()
    w.mac.execute("INSERT INTO link_edit (article_id, repo, op, source, actor, ref, created_at) VALUES "
                  "(?, 'github.com/oscr-fixture/unlicensed', 'remove', 'maintainer', 'github:ben-example', 'edit:7', ?)", (P2, T))
    w.mac.execute("INSERT INTO version (entity, entity_id, version, created_at, actor, snapshot) VALUES "
                  "('article', ?, 99, ?, 'maintainer:github:ben-example', '{}')", (P2, T))
    w.mac.commit()
    w.state.execute("UPDATE job SET detail = ? WHERE ref = ?", (json.dumps({"user": {"name": "Ben Example"}}), report))
    w.state.commit()
    rid = ask(w, "account", user="u_ben", orcid="")
    out = w.poll()
    assert out.done >= 1 and out.written >= 6
    for table in ("users", "identities", "sessions", "roles", "reports", "rights"):
        column = "id" if table == "users" else "user_id"
        assert w.d1con.execute(f"SELECT COUNT(*) FROM {table} WHERE {column} = 'u_ben'").fetchone()[0] == 0, table
    # Ada's account and session are untouched; the queue keeps its rows (a kind, a number, a time).
    assert w.d1con.execute("SELECT COUNT(*) FROM sessions WHERE user_id = 'u_ada'").fetchone()[0] == 1
    assert w.d1con.execute("SELECT COUNT(*) FROM jobs WHERE user_id = 'u_ben'").fetchone()[0] == 2
    assert w.d1con.execute("SELECT COUNT(*) FROM rights WHERE id = ?", (rid,)).fetchone()[0] == 0
    # On the Mac: the account's number instead of its handles, no text of its requests.
    assert w.mac.execute("SELECT actor FROM link_edit WHERE ref = 'edit:7'").fetchone()[0] == "user:u_ben"
    assert w.mac.execute("SELECT actor FROM version WHERE version = 99").fetchone()[0] == "maintainer:user:u_ben"
    assert "Ben Example" not in "".join(r[0] for r in w.state.execute("SELECT detail FROM job"))
    entry = moderation.entries(w.state, "local", ("rights",))[-1]
    assert (entry["rule"], entry["decision"], entry["user_id"]) == ("rights.account", "deleted", "u_ben")


# ---------------------------------------------------------------------------------------
# A removal asked for personal data.

def _report(w, reason, at=T, paper=P1):
    return w.request("reports", "report", {"user_id": "u_eve", "target_kind": "paper", "target_id": paper, "reason": reason,
                                           "details": "This record shows my personal data without my consent.",
                                           "requester_role": "named_person", "scope": "record", "confirmed": 1,
                                           "created_at": at})


def test_a_removal_asked_for_personal_data_waits_for_the_operator_and_is_never_closed(w):
    personal = _report(w, "personal_data")
    w.poll()
    assert w.row("reports", personal)["status"] == "open"
    listed = jobs.describe_waiting(jobs.waiting(w.state, "local", ("report",)))
    assert "about personal data: answer it by 26 October 2026 (GDPR: one month); the rules never close it" in listed
    for day in (31, 45, 90):
        w.clock.t = T + day * DAY
        w.poll()
    assert w.row("reports", personal)["status"] == "open"
    assert "OVERDUE" in jobs.describe_waiting(jobs.waiting(w.state, "local", ("report",)), now=w.clock.t)
    assert "1 OVERDUE" in jobs.status(w.state, now=w.clock.t)


def test_a_removal_for_another_reason_still_closes_after_30_days(w):
    rid = _report(w, "other")
    w.poll()
    w.clock.t = T + 31 * DAY
    w.poll()
    assert w.row("reports", rid)["status"] == "rejected"


def test_a_personal_data_request_recorded_before_the_rule_is_kept_open(w):
    rid = _report(w, "personal_data")
    w.poll()
    # As the state was before this rule: an ordinary review, closed at 30 days.
    w.state.execute("UPDATE waits SET rule = 'report.review', due = ? WHERE ref = ?", (T + 30 * DAY, rid))
    w.state.commit()
    w.clock.t = T + 31 * DAY
    w.poll()
    assert w.row("reports", rid)["status"] == "open"
    rule = w.state.execute("SELECT rule FROM waits WHERE ref = ?", (rid,)).fetchone()[0]
    assert rule == "report.personal_data"
