"""Data rights (2026-09-29): what a signed-in person asks about the data the registry holds on them,
under the EU's General Data Protection Regulation, the page /data-rights/, the D1 table `rights`
(migrations/d1-community/0004_data_rights.sql), answered here by `oscr jobs poll` (oscr/jobs.py). There
is no human moderator on duty, so the Mac answers by itself what it can prove, in the safe direction,
and hands the rest to the operator with its legal deadline: a request is never closed unanswered.

| right | who | what the Mac does |
|---|---|---|
| access | an account with an ORCID iD signed in with orcid.org | answers at once, field by field: the contact details kept under that iD (addresses masked), the papers that list it, what the operator's computer keeps about the account |
| access | an account signed in with ORCID's sandbox (test iDs), or without an ORCID iD | answers what concerns the account; no contact detail is shown: the sandbox's iDs prove nothing, and a GitHub or Google account cannot be matched to an author; without an iD, it waits for the operator |
| erasure, objection | an account with an ORCID iD | the rows with that iD are deleted (and the rows without an iD that carry one of its addresses under the same family name); the iD and the addresses' digests join the suppression list, which the collection honours; the private dataset loses them at its next publication, its history rewritten (oscr/contacts.py) |
| erasure, objection | an account without an ORCID iD | waits for the operator (`oscr rights erase`) |
| rectification | anyone | waits for the operator |
| account | anyone | the account's rows deleted from D1 (sessions, identities, roles, claims, requests, the account); on the Mac, its handles replaced by its random number in the records' history, and the texts of its requests dropped from the job runner's state |

**Identity.** The contact details that concern a person are the rows whose ORCID iD is the account's
own: the iD of the ORCID identity the person signed in with (the Worker records it with the request,
and the Mac checks it again against the account's identity). Nothing else ties a row to a person for
sure: a name, a GitHub login or a display name never does.

**The email address.** The site's database holds no email address (every text column refuses an at
sign). So the access answer shows each address masked, its first and last characters, and its domain
, and says where it was read: the paper itself, which publishes it in full. That keeps the promise that
no address is displayed or stored in the site, and the person can still recognize theirs.

    oscr rights list                              what waits for the operator, with the legal deadline
    oscr rights done|refuse <n> --message "…"      the operator's answer
    oscr rights erase <n> --orcid <iD> | --row <paper>:<position> …   the operator's erasure
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from typing import TYPE_CHECKING, Any

from . import contacts, moderation
from .community import literal

if TYPE_CHECKING:
    from .jobs import Outcome, Runner

KINDS = ("access", "erasure", "objection", "rectification", "account")
#: The access answer's contact rows and papers listed in full (the rest is counted): the answer is one
#: D1 row, and one SQL statement (100 kB at most).
MAX_LISTED = 80
#: The answer's size, in bytes (the D1 CHECK: 60,000).
MAX_ANSWER = 55_000
#: When the private dataset is published again (tools/org.oscr.nightly.plist), in words.
NIGHTLY = "04:17"
ORCID = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")


#: The legal deadline of a request made at a time (GDPR art. 12(3), "within one month").
one_month_after = moderation.one_month_after


def day_words(t: float) -> str:
    return time.strftime("%-d %B %Y", time.gmtime(t))


def mask_email(email: str) -> str:
    """An address as the access answer shows it: "j…e at fib.fr", never the address, never an at sign."""
    local, _, domain = (email or "").partition("@")
    if not local or not domain:
        return ""
    shown = local[0] + "…" + (local[-1] if len(local) > 2 else "")
    return f"{shown} at {domain}"


def _clean(value: Any) -> Any:
    """What may go into D1: no at sign anywhere (every text column refuses one)."""
    if isinstance(value, str):
        return value.replace("@", " at ")
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _json(value: Any) -> str:
    return json.dumps(_clean(value), ensure_ascii=False, separators=(",", ":"))


def _date(t: float | None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t)) if t else ""


# ---------------------------------------------------------------------------------------
# What the registry holds about a person, on the Mac.

def contact_answer(con: sqlite3.Connection, orcid: str) -> dict[str, Any]:
    """The contact details kept under an ORCID iD, field by field, addresses masked."""
    rows = contacts.holds(con, orcid)
    items = [{"paper": {"id": r["article_id"], "doi": r["doi"], "title": r["title"][:300]},
              "position": r["position"], "tied_by": r["tied_by"], "source": r["source"], "found": _date(r["found_at"]),
              "fields": {"given": r["given"], "family": r["family"], "name": r["name"], "orcid": r["orcid"],
                         "email": mask_email(r["email"]), "organization": r["organization"][:300],
                         "address": r["address"][:300], "affiliation": r["affiliation"][:500],
                         "corresponding": r["corresponding"]}}
             for r in rows]
    orcids, _ = contacts.suppressed(con)
    return {"rows": len(rows), "papers": len({r["article_id"] for r in rows}), "listed": items[:MAX_LISTED],
            "more": max(0, len(items) - MAX_LISTED), "emails": len({r["email"] for r in rows if r["email"]}),
            "suppressed": orcid.upper() in orcids}


def authorship_answer(con: sqlite3.Connection, orcid: str) -> dict[str, Any]:
    """The papers whose public metadata list the iD among their authors (what their pages show)."""
    rows = con.execute("SELECT a.id, a.doi, a.title FROM paper_author p JOIN article a ON a.id = p.article_id WHERE p.orcid = ? "
                       "ORDER BY a.published DESC, a.id", (orcid,)).fetchall()
    seen: dict[str, dict[str, str]] = {}
    for r in rows:
        seen.setdefault(r[0], {"id": r[0], "doi": r[1] or "", "title": (r[2] or "")[:300]})
    papers = list(seen.values())
    return {"papers": len(papers), "listed": papers[:MAX_LISTED], "more": max(0, len(papers) - MAX_LISTED)}


def handles(user: dict[str, Any] | None) -> list[str]:
    """How the Mac's records name an account: its ORCID iD, its GitHub login (jobs.actor)."""
    out = []
    if user and user.get("orcid"):
        out.append(f"orcid:{user['orcid']}")
    if user and user.get("github_login"):
        out.append(f"github:{user['github_login']}")
    return out


def operator_answer(runner: Runner, user: dict[str, Any] | None, user_id: str) -> dict[str, Any]:
    """What the operator's computer keeps about an account: the moderator's log, the job runner's state,
    the corrections the records' history attributes to it."""
    state, con = runner.state, runner.con
    moderation.ensure_schema(state)
    log = state.execute("SELECT COUNT(*), MIN(at), MAX(at) FROM moderation_log WHERE target = ? AND user_id = ?",
                        (runner.target, user_id)).fetchone()
    rules = {r[0]: r[1] for r in state.execute("SELECT rule, COUNT(*) FROM moderation_log WHERE target = ? AND user_id = ? "
                                               "GROUP BY rule ORDER BY rule", (runner.target, user_id))}
    jobs_ = state.execute("SELECT COUNT(*), SUM(status = 'owner') FROM job WHERE target = ? AND user_id = ?",
                          (runner.target, user_id)).fetchone()
    names = handles(user)
    marks = ",".join("?" * len(names))
    corrections = con.execute(f"SELECT COUNT(DISTINCT article_id) FROM link_edit WHERE actor IN ({marks})",
                              names).fetchone()[0] if names else 0
    return {"log": {"entries": log[0] or 0, "first": _date(log[1]), "last": _date(log[2]), "rules": rules},
            "requests": {"kept": jobs_[0] or 0, "waiting": jobs_[1] or 0},
            "corrections": {"records": corrections}}


def answer_json(answer: dict[str, Any]) -> str:
    """The answer as it fits one D1 row: fewer rows listed until it does."""
    text = _json(answer)
    while len(text.encode()) > MAX_ANSWER:
        shrunk = False
        for part in ("contacts", "authorship"):
            listed = (answer.get(part) or {}).get("listed") or []
            if len(listed) > 5:
                keep = len(listed) // 2
                answer[part]["more"] = answer[part].get("more", 0) + len(listed) - keep
                answer[part]["listed"] = listed[:keep]
                shrunk = True
        if not shrunk:
            answer.pop("authorship", None)
            answer["contacts"] = {k: v for k, v in (answer.get("contacts") or {}).items() if k != "listed"}
            text = _json(answer)
            break
        text = _json(answer)
    return text


# ---------------------------------------------------------------------------------------
# The answers.

MISMATCH = ("Refused: the ORCID iD this request names is not the one your account signed in with. The registry answers "
            "about your own iD only. Sign in with your ORCID iD, then ask again from this page.")
NO_ORCID = ("Your account has no ORCID iD, so the registry cannot tell by itself which authors' contact details are yours: "
            "a name, a GitHub login or a Google account proves nothing. The operator answers it by {due}. Faster: link "
            "your ORCID iD from your account page, then ask again: the answer is then automatic.")
SANDBOX = ("You signed in with ORCID's sandbox, whose iDs are tests: the registry shows no contact detail to them. Once the "
           "site signs in with orcid.org, ask again.")
WAITING_RECTIFICATION = ("The operator corrects it by {due} at the latest (one month, as the GDPR requires), and answers "
                         "here. There is no human moderator on duty at the moment, but this request is never closed "
                         "unanswered.")
HANDED_OVER = ("The registry's machine could not complete this request by itself ({why}). The operator does, by {due} at the "
               "latest (one month, as the GDPR requires), and answers here: it is never closed unanswered.")


def _update(row: dict[str, Any], t: int, status: str, message: str, answer: str | None = None) -> str:
    sets = f"status = {literal(status)}, message = {literal(words(message))}"
    if answer is not None:
        sets += f", answer = {literal(answer)}"
    if status in ("done", "refused"):
        sets += f", decided_at = {t}"
    return f"UPDATE rights SET {sets} WHERE id = {int(row['id'])} AND status IN ('open', 'waiting')"


def words(text: str) -> str:
    from .jobs import words as jobs_words
    return jobs_words(text)


def _due(row: dict[str, Any]) -> float:
    return float(row.get("due_at") or one_month_after(float(row["created_at"])))


def _waiting(runner: Runner, row: dict[str, Any], user: dict[str, Any] | None, message: str, why: str,
             answer: str | None = None) -> Outcome:
    """The request waits for the operator, flagged with its legal deadline; never closed by the rules."""
    from .jobs import Outcome, _handles, _stamp
    due = _due(row)
    moderation.log(runner.state, runner.target, "rights", int(row["id"]), f"rights.{row['kind']}", "waiting",
                   user_id=row["user_id"], detail={"why": why, "due": due}, now=runner.now())
    return Outcome("owner", [_update(row, _stamp(runner), "waiting", message, answer)],
                   message=f"waits for the operator until {day_words(due)} (the legal deadline): {why}",
                   detail={"rights": row["id"], "kind": row["kind"], "details": row.get("details") or "",
                           "orcid": row.get("orcid") or "", "proof": row.get("proof") or "", "user": _handles(user),
                           "due": due, "legal": True, "why": why})


def _done(runner: Runner, row: dict[str, Any], rule: str, message: str, answer: str | None = None,
          detail: dict[str, Any] | None = None) -> Outcome:
    from .jobs import Outcome, _stamp
    moderation.log(runner.state, runner.target, "rights", int(row["id"]), rule, "done", user_id=row["user_id"],
                   detail=detail or {}, now=runner.now())
    return Outcome("done", [_update(row, _stamp(runner), "done", message, answer)], message=f"{rule}: done")


def account_orcid(runner: Runner, user_id: str) -> str:
    """The iD of the account's ORCID identity, as D1 holds it now ("" without one)."""
    rows = runner.d1.query(f"SELECT subject FROM identities WHERE user_id = {literal(user_id)} AND provider = 'orcid'")
    return str(rows[0]["subject"]) if rows else ""


def run_rights(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    """A data-rights request, open: answered, applied, or handed to the operator with its deadline."""
    from .jobs import Outcome
    if row is None:
        return Outcome("done", message="nothing to do: the request is gone (its account was deleted)")
    if row["status"] != "open":
        return Outcome("done", message=f"nothing to do: the request is {row['status']}")
    orcid = (row.get("orcid") or "").upper()
    if orcid and (not ORCID.match(orcid) or account_orcid(runner, row["user_id"]).upper() != orcid):
        # The Worker records the account's own iD: one that is not (anymore) proves nothing.
        from .jobs import _stamp
        moderation.log(runner.state, runner.target, "rights", int(row["id"]), "rights.identity", "refused",
                       user_id=row["user_id"], detail={"kind": row["kind"]}, now=runner.now())
        return Outcome("done", [_update(row, _stamp(runner), "refused", MISMATCH)], message="refused: not the account's iD")
    kind = row["kind"]
    if kind == "account":
        return delete_account(runner, row, user)
    if kind == "rectification":
        return _waiting(runner, row, user, WAITING_RECTIFICATION.format(due=day_words(_due(row))), "a rectification")
    if kind == "access":
        return access(runner, row, user, orcid)
    if kind in ("erasure", "objection"):
        if not orcid:
            return _waiting(runner, row, user, NO_ORCID.format(due=day_words(_due(row))), "no ORCID iD")
        return erase(runner, row, orcid)
    return _waiting(runner, row, user, HANDED_OVER.format(why="a right it does not know", due=day_words(_due(row))),
                    f"unknown kind {kind!r}")


def access(runner: Runner, row: dict[str, Any], user: dict[str, Any] | None, orcid: str) -> Outcome:
    trusted = bool(orcid) and row.get("proof") == "orcid"
    answer: dict[str, Any] = {"version": 1, "answered_at": int(runner.now()), "orcid": orcid,
                              "matched": "orcid" if trusted else "sandbox" if orcid else "none",
                              "operator": operator_answer(runner, user, row["user_id"]),
                              "nightly": NIGHTLY}
    if orcid:
        answer["authorship"] = authorship_answer(runner.con, orcid)
    if trusted:
        answer["contacts"] = contact_answer(runner.con, orcid)
        c = answer["contacts"]
        message = (f"Answered: the registry keeps {c['rows']} row(s) of contact details under your ORCID iD, from "
                   f"{c['papers']} paper(s), shown below field by field (addresses masked: each is printed in full in the "
                   f"paper it comes from)." if c["rows"] else
                   "Answered: the registry keeps no contact details under your ORCID iD. What it holds about your account "
                   "is shown below.")
        return _done(runner, row, "rights.access", message, answer_json(answer), {"rows": c["rows"]})
    if orcid:
        return _done(runner, row, "rights.access", "Answered, for your account. " + SANDBOX, answer_json(answer),
                     {"sandbox": True})
    return _waiting(runner, row, user, "What concerns your account is shown below. " + NO_ORCID.format(due=day_words(_due(row))),
                    "no ORCID iD: the contact details cannot be matched automatically", answer_json(answer))


def erase(runner: Runner, row: dict[str, Any], orcid: str) -> Outcome:
    request = f"{runner.target}:{int(row['id'])}"
    n = contacts.forget(runner.con, orcid, request=request, now=runner.now())
    held = (f"{n['rows']} row(s) of contact details about you, from {n['papers']} paper(s), are erased"
            if n["rows"] else "The registry kept no contact details under your ORCID iD")
    what = "objection" if row["kind"] == "objection" else "erasure"
    message = (f"Done: {held}. Your ORCID iD" + (f" and {n['emails']} address(es) found with it (kept as fingerprints, never "
               f"as addresses)" if n["emails"] else "") + " are on the list of people whose contact details the registry "
               f"never collects again. The private copy on Hugging Face loses them at the next nightly publication "
               f"({NIGHTLY}, the registry's local time), which rewrites its history so that no earlier version keeps them.")
    answer = {"version": 1, "answered_at": int(runner.now()), "orcid": orcid, "matched": "orcid",
              "erased": {"rows": n["rows"], "papers": n["papers"], "emails": n["emails"], "blanked": n["blanked"],
                         "suppressed": True, "right": what}, "nightly": NIGHTLY}
    return _done(runner, row, f"rights.{row['kind']}", message, answer_json(answer),
                 {"rows": n["rows"], "papers": n["papers"]})


# ---------------------------------------------------------------------------------------
# The account deleted.

#: The account's rows, table by table, in the order they are deleted (the account last); each with the
#: rows D1 counts per row deleted (the row, and one per index entry).
ACCOUNT_TABLES: tuple[tuple[str, int], ...] = (
    ("sessions", 2), ("identities", 2), ("roles", 1), ("claims", 2), ("submissions", 2), ("edits", 2),
    ("validations", 2), ("reports", 2), ("rights", 2),
)
DELETED = ("Your account is deleted, with its sessions, its linked identities, its roles, its claims and every request it "
           "made. What the registry keeps, and why: see its privacy page.")


def delete_account(runner: Runner, row: dict[str, Any], user: dict[str, Any] | None) -> Outcome:
    """The account's rows deleted from D1, the account last; on the Mac, the records' history names it by
    its random number instead of its handles, and the job runner's state drops the texts of its
    requests. What stays: the moderator's log (pseudonymous, 12 months), the queue's rows in D1 (a kind,
    a number, the account's random number and a time: they name no one once the account is gone), what
    the account's requests changed in the public records, and the validations it deposited on Zenodo
    (public, and permanent as a DOI is)."""
    from .jobs import Outcome
    uid = row["user_id"]
    counts = runner.d1.query("SELECT " + ", ".join(f"(SELECT COUNT(*) FROM {t} WHERE user_id = {literal(uid)}) AS {t}"
                                                   for t, _ in ACCOUNT_TABLES))
    counted = {t: int((counts[0] if counts else {}).get(t) or 0) for t, _ in ACCOUNT_TABLES}
    needed = 2 + sum(counted[t] * w for t, w in ACCOUNT_TABLES)
    if runner.budget_left() < needed + 3:
        return Outcome("retry", message=f"the day's D1 budget is short for this account ({needed} rows): tomorrow",
                       counts=False)
    pseudonymize(runner, user, uid)
    moderation.log(runner.state, runner.target, "rights", int(row["id"]), "rights.account", "deleted", user_id=uid,
                   detail={"rows": counted}, now=runner.now())
    sql = [f"DELETE FROM {t} WHERE user_id = {literal(uid)}" for t, _ in ACCOUNT_TABLES]
    sql.append(f"DELETE FROM users WHERE id = {literal(uid)}")
    return Outcome("done", sql, message=f"rights.account: the account and {sum(counted.values())} row(s) deleted")


def pseudonymize(runner: Runner, user: dict[str, Any] | None, user_id: str) -> None:
    """On the Mac: who made a correction (the records' history, `link_edit`, `field_provenance`) is now the
    account's random number, not its ORCID iD or GitHub login; the job runner's state keeps no text of its
    requests."""
    con, name = runner.con, f"user:{user_id}"
    for handle in handles(user):
        con.execute("UPDATE link_edit SET actor = ? WHERE actor = ?", (name, handle))
        con.execute("UPDATE field_provenance SET source_ref = ? WHERE source_ref = ?", (name, handle))
        con.execute("UPDATE version SET actor = substr(actor, 1, length(actor) - length(?)) || ? WHERE actor LIKE ?",
                    (handle, name, f"%:{handle}"))
    con.commit()
    runner.state.execute("UPDATE job SET detail = '{}' WHERE target = ? AND user_id = ?", (runner.target, user_id))
    runner.state.commit()


# ---------------------------------------------------------------------------------------
# The operator.

def hand_over(runner: Runner, row: dict[str, Any] | None, user: dict[str, Any] | None, why: str) -> Outcome:
    """A request the Mac failed to answer, after its attempts: the operator's, never closed."""
    from .jobs import Outcome
    if row is None or row.get("status") != "open":
        return Outcome("done", message=f"given up, nothing open: {why}")
    return _waiting(runner, row, user, HANDED_OVER.format(why=why[:200], due=day_words(_due(row))), f"failed: {why[:200]}")


def decide(runner: Runner, request_id: int, verb: str, message: str = "", *, orcid: str = "",
           rows: list[tuple[str, int]] | None = None) -> str:
    """The operator's answer to a request: `done` (with their words), `refuse` (with the reasons: the
    person is told they may complain to their data protection authority), or `erase` (the rows of an
    iD, or the rows the operator found, then done)."""
    from .jobs import _settled, _stamp, _write
    found = runner.d1.query(f"SELECT * FROM rights WHERE id = {int(request_id)}")
    if not found:
        raise SystemExit(f"no data-rights request {request_id} in the {runner.target} database")
    r = found[0]
    if r["status"] not in ("open", "waiting"):
        _settled(runner, ("rights",), request_id, f"already {r['status']}")
        return f"request {request_id} is already {r['status']}"
    if verb == "refuse" and not message.strip():
        raise SystemExit("rights refuse: say why, with --message (the person reads it)")
    said = message.strip()
    if verb == "erase":
        if orcid:
            if not ORCID.match(orcid.upper()):
                raise SystemExit(f"not an ORCID iD: {orcid}")
            n = contacts.forget(runner.con, orcid.upper(), request=f"owner:{runner.target}:{request_id}", now=runner.now())
        elif rows:
            n = contacts.forget_rows(runner.con, rows, request=f"owner:{runner.target}:{request_id}", now=runner.now())
        else:
            raise SystemExit("rights erase: --orcid <iD>, or --row <paper>:<position> for each row found")
        said = (f"Done: {n['rows']} row(s) of contact details about you, from {n['papers']} paper(s), are erased, and never "
                f"collected again; the private copy on Hugging Face loses them at the next nightly publication, its history "
                f"rewritten. " + said).strip()
    elif verb == "refuse":
        said = f"{said} You may lodge a complaint with the data protection authority of the country where you live or work."
    elif not said:
        said = "Answered by the operator."
    status = "refused" if verb == "refuse" else "done"
    t = _stamp(runner)
    _write(runner, [f"UPDATE rights SET status = {literal(status)}, message = {literal(words(said))}, decided_at = {t} "
                    f"WHERE id = {int(request_id)} AND status IN ('open', 'waiting')"])
    _settled(runner, ("rights",), request_id, status)
    moderation.log(runner.state, runner.target, "rights", int(request_id), "owner", status, user_id=r["user_id"],
                   detail={"kind": r["kind"], "verb": verb}, now=runner.now())
    return f"data-rights request {request_id} ({r['kind']}): {status}"


def describe_waiting(items: list[dict[str, Any]], now: float | None = None) -> str:
    """The operator's list: each request with its legal deadline, the late ones first."""
    if not items:
        return "no data-rights request waits for you"
    now = now or time.time()
    out = []
    for j in sorted(items, key=lambda j: j["detail"].get("due") or 0):
        d = j["detail"]
        who = d.get("user", {})
        person = ", ".join(x for x in (who.get("name"), who.get("orcid") and f"ORCID {who['orcid']}",
                                       who.get("github") and f"GitHub {who['github']}") if x) or j["user_id"]
        due = float(d.get("due") or 0)
        left = math.ceil((due - now) / 86_400)
        flag = f"OVERDUE by {-left} day(s)" if due and due < now else f"{left} day(s) left"
        lines = [f"data-rights request {d.get('rights')}: {d.get('kind')}, from {person}, answer by {day_words(due)} "
                 f"(GDPR, one month): {flag}",
                 f"    why it waits: {d.get('why', '')}"]
        if d.get("details"):
            lines.append(f"    their words: {d['details']}")
        if d.get("orcid"):
            lines.append(f"    their ORCID iD: {d['orcid']} ({d.get('proof') or 'no proof'})")
        out.append("\n".join(lines))
    return "\n".join(out)
