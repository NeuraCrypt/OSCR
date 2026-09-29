"""The automatic moderator (decided 2026-09-29): there is no human moderator on duty, so what the
site's readers ask is decided by published rules (the public page /policies/moderation/,
docs/CONTRIBUTIONS.md "Moderation"), in the safe direction — hiding is automatic when in doubt,
publishing needs a verified identity or checks that pass — and nothing waits forever.

Where it runs: the Mac's `oscr jobs poll` (every ten minutes under launchd, `org.oscr.jobs`), which
reads each request as before (oscr/jobs.py) and asks the rules here instead of queueing it for the
owner; the same poll closes what reached its time limit (`sweep`). The Worker only tells the
requester what the rules will do (website/src/lib/moderation.ts, the same base rules: both test
suites read tests/fixtures/moderation_rules.json).

| request | rule | what happens |
|---|---|---|
| removal, from a verified author of the paper | `report.verified_author` | applied at once, whatever it names |
| removal of copies (a repository, a file, the paper's scripts) by a maintainer of that code | `report.maintainer` | applied at once, to the repositories they maintain |
| removal of copies, for copyright or personal data, by anyone else | `report.hide_at_once` | hidden at once, pending the operator's review (who may restore it) — at most 3 an account and 30 in all a day, and not a justification repeated 3 times in 7 days |
| any other removal (a whole record, a tracing map, another reason) | `report.review` | waits for the operator, 30 days at most; then closed without removal, with how to ask again |
| a submission published by someone not among the paper's authors | `submission.corroborated` / `submission.uncorroborated` | published when each code link is in the paper's own text, or its README cites the paper, or its owner is one of its authors; else refused, with the reason and how to ask again |
| a draft not published | `submission.draft_expired` | refused after 30 days (it can be corrected and published again) |
| an author claim | `claim.paper_metadata`, `claim.orcid_record`, `claim.expired` | verified when the paper lists the claimant's ORCID iD, or the claimant's public ORCID record lists the paper (checked again daily); else closed after 30 days, with how to claim again |
| a maintainer claim GitHub did not settle | `claim.expired` | closed after 30 days, with how to be checked again |
| corrections of links, validations of maps | — | already restricted to verified authors and maintainers by the Worker; applied by the Mac |

Every automatic decision is logged with its rule (`moderation_log` in data/community/state.db:
`oscr reports list --auto-log`, and the same for claims and submissions); the owner's commands keep
working, to decide what waits, and to reverse what the rules did (`oscr reports reverse <n>`, `oscr
claims reverse <n>`, `oscr submissions reverse <n>`).

No free text a reader types reaches a public page: notes, statements, justifications and evidence
links are read by the operator only (and lose their email addresses). The one name a reader's account
can put in public — the creator of a tracing map deposited on Zenodo, when the paper does not list
the validator's ORCID iD — goes through `public_name`. So no language model is used.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlsplit

from . import db, links
from .community import literal

if TYPE_CHECKING:
    from .jobs import Outcome, Runner

DAY = 86_400
#: How long a request may wait for the operator before the rules close it.
REVIEW_DAYS = 30
REVIEW_S = REVIEW_DAYS * DAY
#: Automatic hides of copies at the word of someone the registry cannot verify: per account, and in
#: all, in 24 hours. Past them, a request waits for the operator.
HIDE_PER_ACCOUNT = 3
HIDE_PER_DAY = 30
#: The same justification this many times in CAMPAIGN_DAYS: a campaign, which waits for the operator.
CAMPAIGN = 3
CAMPAIGN_DAYS = 7
#: How often a waiting author claim is checked again against the claimant's ORCID record.
CLAIM_RECHECK_S = DAY
#: What a removal request may name besides the whole record and the map: copies of the authors' code.
NARROW = frozenset({"scripts", "repository", "file"})
#: The reasons for which copies are hidden at once, on anyone's word.
HARM = frozenset({"copyright", "personal_data"})
#: Who decides, as the D1 tables and the log say it.
RULES = "rules"
#: Where a person's own link comes from (link.found_by): not the paper's text.
PERSONS = ("submitter", "author", "maintainer", "owner")

SCHEMA = """
CREATE TABLE IF NOT EXISTS moderation_log (
    target    TEXT NOT NULL,            -- local | remote
    at        REAL NOT NULL,
    kind      TEXT NOT NULL,            -- report | submission | claim
    ref       INTEGER NOT NULL,         -- the request's id in D1
    user_id   TEXT NOT NULL DEFAULT '',
    paper     TEXT NOT NULL DEFAULT '',
    rule      TEXT NOT NULL,            -- report.hide_at_once, … ; owner, owner.reversed
    decision  TEXT NOT NULL,            -- accepted | hidden | review | rejected | published | refused | verified | reversed
    detail    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS moderation_log_at ON moderation_log (target, at);
CREATE TABLE IF NOT EXISTS waits (
    target      TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- report | claim | submission
    ref         INTEGER NOT NULL,
    since       REAL NOT NULL,          -- when the wait began (the request's own time)
    due         REAL NOT NULL,          -- when the rules close it
    next_check  REAL NOT NULL DEFAULT 0,
    rule        TEXT NOT NULL,
    PRIMARY KEY (target, kind, ref)
) WITHOUT ROWID;
"""


def ensure_schema(state: sqlite3.Connection) -> None:
    state.executescript(SCHEMA)


# ---------------------------------------------------------------------------------------
# The rules for a removal request (website/src/lib/moderation.ts has the same, for the page).

@dataclass(frozen=True)
class Path:
    rule: str
    outcome: str        # apply | hide | review


def report_path(scope: str, reason: str, author_verified: bool, maintainer: bool) -> Path:
    """What the rules do with a removal request, before the guards: a verified author's is applied,
    a maintainer's of their own code's copies too; copies are hidden at once for copyright or
    personal data; the rest waits for the operator."""
    if author_verified:
        return Path("report.verified_author", "apply")
    if maintainer and scope in NARROW:
        return Path("report.maintainer", "apply")
    if scope in NARROW and reason in HARM:
        return Path("report.hide_at_once", "hide")
    return Path("report.review", "review")


def details_key(text: str) -> str:
    """A justification's fingerprint, so that the same words sent again are recognized: case,
    accents, punctuation and spaces aside."""
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    return hashlib.sha1(t.encode()).hexdigest()[:16] if t else ""


def hide_guard(state: sqlite3.Connection, target: str, user_id: str, details: str, ref: int, now: float) -> str:
    """Why copies must not be hidden at once, in words ("" when they may): the account's or the
    day's automatic hides are spent, the justification is a campaign's, or the operator already said
    no to this request."""
    ensure_schema(state)
    if state.execute("SELECT 1 FROM moderation_log WHERE target = ? AND kind = 'report' AND ref = ? AND rule LIKE 'owner%' "
                     "AND decision IN ('rejected', 'reversed')", (target, ref)).fetchone():
        return "the operator already refused or reversed this request"
    day = now - DAY
    mine = state.execute("SELECT COUNT(*) FROM moderation_log WHERE target = ? AND rule = 'report.hide_at_once' "
                         "AND decision = 'hidden' AND user_id = ? AND at > ?", (target, user_id, day)).fetchone()[0]
    if mine >= HIDE_PER_ACCOUNT:
        return f"this account had {mine} copies hidden at once in the last 24 hours, the most the rules allow"
    everyone = state.execute("SELECT COUNT(*) FROM moderation_log WHERE target = ? AND rule = 'report.hide_at_once' "
                             "AND decision = 'hidden' AND at > ?", (target, day)).fetchone()[0]
    if everyone >= HIDE_PER_DAY:
        return f"{everyone} copies were hidden at once in the last 24 hours, the most the rules allow in a day"
    key = details_key(details)
    if key:
        seen = state.execute("SELECT COUNT(*) FROM moderation_log WHERE target = ? AND kind = 'report' AND at > ? "
                             "AND json_extract(detail, '$.details_key') = ? AND ref != ?",
                             (target, now - CAMPAIGN_DAYS * DAY, key, ref)).fetchone()[0]
        if seen + 1 >= CAMPAIGN:
            return f"the same justification came with {seen + 1} requests in {CAMPAIGN_DAYS} days"
    return ""


# ---------------------------------------------------------------------------------------
# The log, and what waits.

def log(state: sqlite3.Connection, target: str, kind: str, ref: int, rule: str, decision: str, *, user_id: str = "",
        paper: str = "", detail: dict[str, Any] | None = None, now: float | None = None) -> None:
    ensure_schema(state)
    state.execute("INSERT INTO moderation_log (target, at, kind, ref, user_id, paper, rule, decision, detail) "
                  "VALUES (?,?,?,?,?,?,?,?,?)", (target, now if now is not None else time.time(), kind, int(ref), user_id or "",
                                                 paper or "", rule, decision, json.dumps(detail or {}, ensure_ascii=False)))
    state.commit()


def entries(state: sqlite3.Connection, target: str | None = None, kinds: tuple[str, ...] = (),
            since: float = 0) -> list[dict[str, Any]]:
    ensure_schema(state)
    sql = "SELECT * FROM moderation_log WHERE at >= ?"
    args: list[Any] = [since]
    if target:
        sql += " AND target = ?"
        args.append(target)
    if kinds:
        sql += f" AND kind IN ({','.join('?' * len(kinds))})"
        args += list(kinds)
    return [{**dict(r), "detail": json.loads(r["detail"] or "{}")} for r in state.execute(sql + " ORDER BY at, rowid", args)]


def describe_log(items: list[dict[str, Any]]) -> str:
    """The automatic decisions, for the owner's audit: when, what, which rule, the outcome."""
    if not items:
        return "no automatic decision yet"
    out = []
    for e in items:
        when = time.strftime("%Y-%m-%d %H:%M", time.gmtime(e["at"]))
        d = e["detail"]
        said = "; ".join(f"{k}: {v}" for k, v in d.items() if k not in ("details_key",) and v not in ("", None, [], {}))
        out.append(f"{when} UTC  {e['target']} {e['kind']} {e['ref']}  {e['rule']} → {e['decision']}"
                   + (f"  ({e['paper']})" if e["paper"] else "") + (f"\n    {said}" if said else ""))
    return "\n".join(out)


def wait(state: sqlite3.Connection, target: str, kind: str, ref: int, since: float, rule: str, *,
         due: float | None = None, next_check: float = 0) -> float:
    """The request waits (for the operator, or for its author); the rules close it at `due`
    (REVIEW_DAYS after `since` by default). A request already waiting keeps its first deadline.
    Returns the deadline."""
    ensure_schema(state)
    state.execute("INSERT OR IGNORE INTO waits (target, kind, ref, since, due, next_check, rule) VALUES (?,?,?,?,?,?,?)",
                  (target, kind, int(ref), since, due if due is not None else since + REVIEW_S, next_check, rule))
    state.commit()
    return float(state.execute("SELECT due FROM waits WHERE target = ? AND kind = ? AND ref = ?",
                               (target, kind, int(ref))).fetchone()[0])


def unwait(state: sqlite3.Connection, target: str, kind: str, ref: int) -> None:
    ensure_schema(state)
    state.execute("DELETE FROM waits WHERE target = ? AND kind = ? AND ref = ?", (target, kind, int(ref)))
    state.commit()


def deadline_words(due: float) -> str:
    return time.strftime("%-d %B %Y", time.gmtime(due))


# ---------------------------------------------------------------------------------------
# What the Mac may look up: an ORCID record, a forge's owner.

class Evidence(Protocol):
    def orcid_lists_doi(self, orcid: str, doi: str, *, sandbox: bool) -> bool | None:
        """Whether the public ORCID record of `orcid` lists the paper `doi` among its works; None when
        ORCID could not be asked."""

    def owner_is_author(self, con: sqlite3.Connection, article_id: str, repo: str) -> str:
        """Why the owner of `repo` is one of the paper's authors, in words; "" when nothing shows it."""


class NoEvidence:
    """Nothing is looked up: the rules decide from the Mac's own database."""

    def orcid_lists_doi(self, orcid: str, doi: str, *, sandbox: bool) -> bool | None:
        return None

    def owner_is_author(self, con: sqlite3.Connection, article_id: str, repo: str) -> str:
        return ""


def _folded(name: str) -> str:
    t = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    return " ".join(sorted(re.findall(r"[a-z]+", t)))


class MacEvidence:
    """The public ORCID API (no key) and GitHub's (the Mac's read-only token), through the harvester's
    client: a few requests per decision, cached a day."""

    ORCID = "https://pub.orcid.org/v3.0"
    ORCID_SANDBOX = "https://pub.sandbox.orcid.org/v3.0"
    MAX_AUTHORS = 25

    def __init__(self, client: Any) -> None:
        self.client = client

    def _json(self, url: str) -> Any:
        try:
            r = self.client.get(url, headers={"Accept": "application/json"}, ttl_s=DAY)
        except Exception:        # the network: no evidence, never a failed decision
            return None
        return r.json() if r.ok else None

    def orcid_lists_doi(self, orcid: str, doi: str, *, sandbox: bool) -> bool | None:
        if not re.fullmatch(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", orcid or "") or not doi:
            return False
        works = self._json(f"{self.ORCID_SANDBOX if sandbox else self.ORCID}/{orcid}/works")
        if works is None:
            return None
        for group in works.get("group") or []:
            for x in ((group.get("external-ids") or {}).get("external-id") or []):
                if (x.get("external-id-type") or "").lower() == "doi" and \
                        str(x.get("external-id-value") or "").strip().lower() == doi.lower():
                    return True
        return False

    def owner_is_author(self, con: sqlite3.Connection, article_id: str, repo: str) -> str:
        parts = repo.split("/")
        if len(parts) != 3 or parts[0] != "github.com":
            return ""
        owner = parts[1].lower()
        authors = con.execute("SELECT name, orcid FROM paper_author WHERE article_id = ? ORDER BY position",
                              (article_id,)).fetchall()
        # 1. An author's ORCID record links to the owner's GitHub account.
        for a in [a for a in authors if a["orcid"]][: self.MAX_AUTHORS]:
            urls = self._json(f"{self.ORCID}/{a['orcid']}/researcher-urls") or {}
            for u in urls.get("researcher-url") or []:
                address = str((u.get("url") or {}).get("value") or "")
                p = urlsplit(address if "://" in address else f"https://{address}")
                if p.hostname in ("github.com", "www.github.com") and p.path.strip("/").split("/")[0].lower() == owner:
                    return f"the ORCID record of {a['name']}, an author, links to github.com/{parts[1]}"
        # 2. The owner's GitHub profile bears an author's full name.
        profile = self._json(f"https://api.github.com/users/{parts[1]}") or {}
        if profile.get("type") == "User" and profile.get("name"):
            theirs = _folded(profile["name"])
            for a in authors:
                if theirs and len(theirs.split()) >= 2 and theirs == _folded(a["name"]):
                    return f"the GitHub profile of {parts[1]} bears the name of {a['name']}, an author"
        return ""


def public_name(name: str) -> str:
    """A name an account gave (its provider's), as it may appear in public (a tracing map's creator on
    Zenodo): no address, no link, no control character, at most 100 characters, at least two
    letters; "" otherwise."""
    t = unicodedata.normalize("NFC", name or "")
    t = "".join(c for c in t if unicodedata.category(c)[0] != "C")
    if re.search(r"[@＠]|https?:|www\.|\b[\w-]+\.(com|org|net|io|xyz|ru|cn|info|biz|top|site|online|link)\b", t, re.I):
        return ""
    t = re.sub(r"\s+", " ", t).strip()[:100]
    return t if len(re.findall(r"[^\W\d_]", t)) >= 2 else ""


# ---------------------------------------------------------------------------------------
# Decisions. Each returns the job's Outcome (oscr/jobs.py): `done` with what D1 is told, or `owner`
# (waiting for the operator, with its deadline).

def _roles(runner: Runner, user_id: str) -> list[dict[str, Any]]:
    if not user_id:
        return []
    return runner.d1.query(f"SELECT role, scope_kind, scope_id FROM roles WHERE user_id = {literal(user_id)}")


def verified_author(runner: Runner, user: dict[str, Any] | None, paper: str) -> bool:
    """The account is a verified author of the paper: its role (the paper's metadata, a claim
    decided by the rules or the owner), or its ORCID iD among the paper's authors on the Mac."""
    if not user:
        return False
    if any(r["role"] == "verified_author" and r["scope_kind"] == "paper" and r["scope_id"] == paper
           for r in _roles(runner, user["id"])):
        return True
    orcid = user.get("orcid") or ""
    return bool(orcid and runner.con.execute("SELECT 1 FROM paper_author WHERE article_id = ? AND orcid = ?",
                                             (paper, orcid)).fetchone())


def maintained(runner: Runner, user: dict[str, Any] | None, paper: str, scope: str, repo: str) -> list[str]:
    """The repositories of the paper's code named by a request that the account maintains (GitHub's
    check, or the owner's decision): the one named, or for "scripts" every one of the paper's."""
    if not user or scope not in NARROW:
        return []
    mine = {r["scope_id"] for r in _roles(runner, user["id"]) if r["role"] == "maintainer" and r["scope_kind"] == "repo"}
    code = {r[0] for r in runner.con.execute("SELECT repo FROM link WHERE article_id = ? AND role = 'code'", (paper,))}
    named = code if scope == "scripts" else ({repo} & code if code else {repo})
    return sorted(mine & named)


def apply_removal(runner: Runner, r: dict[str, Any], *, repos: list[str] | None = None) -> str:
    """What a removal request names leaves every public output at the next nightly publication:
    the whole record (`article.withdrawn`), or only copies or the map (`withheld`); a maintainer's
    request for "the scripts" withholds the repositories they maintain. Returns it in words."""
    from .jobs import SCOPES, _target, withhold
    con, report_id = runner.con, int(r["id"])
    scope = r.get("scope") or "record"
    paper = r["target_id"]
    request = f"{runner.target}:{report_id}"
    if scope == "record":
        day = time.strftime("%Y-%m-%d", time.gmtime(runner.now()))
        con.execute("UPDATE article SET withdrawn = ? WHERE id = ?", (f"{day}: request {report_id} ({r['reason']})", paper))
        db.log_event(con, "withdrawn", article=paper, request=report_id, reason=r["reason"])
        con.commit()
        return SCOPES["record"]
    if scope == "scripts" and repos:
        for repo in repos:
            withhold(con, "repository", paper, repo=repo, request=request, reason=r["reason"], now=runner.now())
        return f"the copies of {', '.join(repos)}"
    withhold(con, scope, paper, repo=r.get("scope_repo") or "", path=r.get("scope_path") or "", request=request,
             reason=r["reason"], now=runner.now())
    return SCOPES.get(scope, scope) + (f" ({_target(r)})" if scope in ("repository", "file") else "")


APPLIED = ("Applied at once, as a request from {who} is: {what} leaves the site at its next nightly publication. "
           "The registry's rules decided it (see its moderation policy).")
HIDDEN = ("Hidden at once, as every request to remove copies of the authors' code for copyright or personal data is: "
          "{what} leaves the site at its next nightly publication, and is neither copied nor shown from its source. "
          "The operator may review it and restore what the request did not justify.")
EXPIRED_REPORT = ("Closed without removal: no one could review this request within {days} days, and the registry has no "
                  "human moderator on duty. The rules apply at once a request from a verified author of the paper (signed in "
                  "with the ORCID iD it lists) or from a maintainer of its code (checked on GitHub), and hide at once the copies "
                  "of its code for copyright or personal data: ask again that way from this page.")


def decide_report(runner: Runner, job: dict[str, Any], row: dict[str, Any], user: dict[str, Any] | None) -> Outcome:
    """A removal request, open: applied, hidden, or waiting for the operator."""
    from .jobs import REQUESTERS, SCOPES, Outcome, _handles, _stamp, words
    t = _stamp(runner)
    scope = row.get("scope") or "record"
    paper = row["target_id"]
    author = verified_author(runner, user, paper)
    repos = maintained(runner, user, paper, scope, row.get("scope_repo") or "")
    path = report_path(scope, row["reason"], author, bool(repos))
    guard = ""
    if path.outcome == "hide":
        guard = hide_guard(runner.state, runner.target, row["user_id"], row.get("details") or "", int(row["id"]), runner.now())
        if guard:
            path = Path("report.review", "review")
    detail = {"scope": scope, "reason": row["reason"], "role": row.get("requester_role") or "", "author": author,
              "maintains": repos, "details_key": details_key(row.get("details") or ""), "guard": guard}
    if path.outcome in ("apply", "hide"):
        what = apply_removal(runner, row, repos=repos if path.rule == "report.maintainer" and scope == "scripts" else None)
        who = "a verified author of the paper" if path.rule == "report.verified_author" else "a maintainer of its code"
        message = APPLIED.format(who=who, what=what) if path.outcome == "apply" else HIDDEN.format(what=what)
        log(runner.state, runner.target, "report", int(row["id"]), path.rule, "accepted" if path.outcome == "apply" else "hidden",
            user_id=row["user_id"], paper=paper, detail={**detail, "what": what}, now=runner.now())
        unwait(runner.state, runner.target, "report", int(row["id"]))
        return Outcome("done", [f"UPDATE reports SET status = 'accepted', message = {literal(words(message))}, decided_at = {t} "
                                f"WHERE id = {int(row['id'])} AND status = 'open'"], message=f"{path.rule}: {what}")
    first = runner.state.execute("SELECT 1 FROM waits WHERE target = ? AND kind = 'report' AND ref = ?",
                                 (runner.target, int(row["id"]))).fetchone() is None
    due = wait(runner.state, runner.target, "report", int(row["id"]), float(row["created_at"]), path.rule)
    if first:
        log(runner.state, runner.target, "report", int(row["id"]), path.rule, "review", user_id=row["user_id"], paper=paper,
            detail={**detail, "due": due}, now=runner.now())
    return Outcome("owner", message=f"waits for the operator until {deadline_words(due)}" + (f" ({guard})" if guard else ""),
                   detail={"report": row["id"], "paper_id": paper, "reason": row["reason"], "details": row["details"],
                           "role": row.get("requester_role") or "", "author_verified": bool(row.get("author_verified")),
                           "scope": scope, "repo": row.get("scope_repo") or "", "path": row.get("scope_path") or "",
                           "evidence_url": row.get("evidence_url") or "", "confirmed": bool(row.get("confirmed")),
                           "user": _handles(user), "due": due, "rule": path.rule, "guard": guard,
                           "who": REQUESTERS.get(row.get("requester_role") or "", ""), "what": SCOPES.get(scope, scope)})


def corroboration(runner: Runner, article_id: str, link: links.Link) -> str:
    """Why a submitted code link is this paper's, in words; "" when nothing shows it."""
    con = runner.con
    marks = ",".join("?" * len(PERSONS))
    found = con.execute(f"SELECT found_by, section FROM link WHERE article_id = ? AND repo = ? AND found_by NOT IN ({marks})",
                        (article_id, link.repo, *PERSONS)).fetchone()
    if found is not None:
        return "the paper itself cites it"
    d = con.execute("SELECT cites_article FROM repository WHERE repo = ?", (link.repo,)).fetchone()
    if d is not None and (d["cites_article"] or "").strip():
        return "its README cites the paper"
    return runner.evidence.owner_is_author(con, article_id, link.repo)


def decide_submission(runner: Runner, job: dict[str, Any], row: dict[str, Any], user: dict[str, Any] | None) -> Outcome:
    """A draft published by someone the paper does not list among its authors: published when every
    code link is shown to be this paper's; otherwise refused, with why and how to ask again."""
    from .jobs import Outcome, _out_of_scope, _paper, _stamp, _submitted, apply_submission, words
    t = _stamp(runner)
    sid = int(row["id"])
    where = f"WHERE id = {sid} AND status = 'moderation'"
    paper = row["paper_id"]
    a = _paper(runner.con, paper)
    why = _out_of_scope(a)
    if not why and not (a["title"] or "").strip():
        why = "The registry could not read this paper's metadata, so it cannot check the links against it."
    reasons: dict[str, str] = {}
    missing: list[str] = []
    if not why:
        for link in _submitted(row):
            r = corroboration(runner, paper, link)
            if r:
                reasons[link.repo] = r
            else:
                missing.append(link.url)
    if why or missing:
        message = why or (
            f"Not published: the registry could not tie {', '.join(missing)} to this paper — the paper does not cite "
            f"{'it' if len(missing) == 1 else 'them'}, {'its' if len(missing) == 1 else 'their'} README does not cite the paper, "
            "and nothing shows that the owner is one of its authors. To publish it: if you are an author, sign in with the "
            "ORCID iD the paper lists, then publish again (your submission is published at once); or add the paper's DOI to "
            "the repository's README, then correct this submission from your account page and publish it again.")
        log(runner.state, runner.target, "submission", sid, "submission.uncorroborated", "refused", user_id=row["user_id"],
            paper=paper, detail={"missing": missing, "corroborated": reasons, "why": why}, now=runner.now())
        return Outcome("done", [f"UPDATE submissions SET status = 'refused', message = {literal(words(message))}, "
                                f"updated_at = {t} {where}"], message="refused by the rules")
    status, said = apply_submission(runner, row, user)
    message = f"{said} Published by the registry's rules: " + "; ".join(f"{k}: {v}" for k, v in reasons.items()) + "."
    log(runner.state, runner.target, "submission", sid, "submission.corroborated", status, user_id=row["user_id"], paper=paper,
        detail={"corroborated": reasons}, now=runner.now())
    return Outcome("done", [f"UPDATE submissions SET status = {literal(status)}, message = {literal(words(message))}, "
                            f"updated_at = {t} {where}"], message=f"published by the rules ({len(reasons)} link(s))")


VERIFIED_CLAIM = ("Verified by the registry's rules: {why}. You may now correct this paper's record, validate its map and "
                  "have your removal requests applied at once.")
EXPIRED_AUTHOR_CLAIM = ("Closed: in {days} days, nothing could show that you are one of this paper's authors — the paper does not "
                        "list your ORCID iD, and your public ORCID record does not list the paper — and the registry has no human "
                        "moderator on duty. Add the paper to the works of your ORCID record (or sign in with the ORCID iD the paper "
                        "lists), then claim it again: the rules check it at once, and again each day.")
EXPIRED_MAINTAINER_CLAIM = ("Closed: in {days} days, nothing could show that you maintain this repository, and the registry has no "
                            "human moderator on duty. Only GitHub can be checked automatically: once GitHub shows you as its owner, "
                            "a public member of its organization or one of its contributors, ask for the check again from your "
                            "account page.")


def _claim_proof(runner: Runner, row: dict[str, Any], user: dict[str, Any] | None) -> tuple[str, str]:
    """(rule, why) when an author claim is proven; ("", "") otherwise."""
    try:
        evidence = json.loads(row.get("evidence") or "{}")
    except ValueError:
        evidence = {}
    orcid = (user or {}).get("orcid") or evidence.get("orcid") or ""
    paper = row["paper_id"]
    if orcid and runner.con.execute("SELECT 1 FROM paper_author WHERE article_id = ? AND orcid = ?", (paper, orcid)).fetchone():
        return "claim.paper_metadata", "the paper lists your ORCID iD among its authors"
    doi = paper[4:] if paper.startswith("doi:") else ""
    # The iDs of a site signed in with ORCID's sandbox are the sandbox's: their records are looked up there.
    sandbox = evidence.get("orcid_issuer", "sandbox") != "orcid"
    if orcid and doi and runner.evidence.orcid_lists_doi(orcid, doi, sandbox=sandbox):
        return "claim.orcid_record", "your public ORCID record lists this paper among your works"
    return "", ""


def _verify_claim(runner: Runner, row: dict[str, Any], rule: str, why: str) -> Outcome:
    from .jobs import Outcome, _stamp, words
    t = _stamp(runner)
    cid = int(row["id"])
    log(runner.state, runner.target, "claim", cid, rule, "verified", user_id=row["user_id"], paper=row["paper_id"],
        detail={"why": why}, now=runner.now())
    unwait(runner.state, runner.target, "claim", cid)
    return Outcome("done", [
        f"UPDATE claims SET status = 'verified', decided_by = '{RULES}', decided_at = {t}, "
        f"message = {literal(words(VERIFIED_CLAIM.format(why=why)))} WHERE id = {cid} AND status = 'pending'",
        # 'rules', not 'system': the Worker's own verification (paper_orcid) never takes it back.
        f"INSERT OR IGNORE INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES "
        f"({literal(row['user_id'])}, 'verified_author', 'paper', {literal(row['paper_id'])}, '{RULES}', {t})"],
        message=f"{rule}: {why}")


def decide_claim(runner: Runner, job: dict[str, Any], row: dict[str, Any], user: dict[str, Any] | None) -> Outcome:
    """A claim, pending: an author's verified when ORCID shows it, else it waits (checked again each
    day) until its deadline; a maintainer's that GitHub did not settle waits until its deadline."""
    from .jobs import Outcome, _handles
    cid = int(row["id"])
    if row["kind"] == "author":
        rule, why = _claim_proof(runner, row, user)
        if rule:
            return _verify_claim(runner, row, rule, why)
    rule = "claim.review" if row["kind"] == "author" else "claim.maintainer_review"
    first = runner.state.execute("SELECT 1 FROM waits WHERE target = ? AND kind = 'claim' AND ref = ?",
                                 (runner.target, cid)).fetchone() is None
    due = wait(runner.state, runner.target, "claim", cid, float(row["created_at"]), rule,
               next_check=runner.now() + CLAIM_RECHECK_S if row["kind"] == "author" else 0)
    if first:
        log(runner.state, runner.target, "claim", cid, rule, "review", user_id=row["user_id"],
            paper=row["paper_id"] or row["repo"], detail={"due": due}, now=runner.now())
    try:
        evidence = json.loads(row.get("evidence") or "{}")
    except ValueError:
        evidence = {}
    return Outcome("owner", message=f"a claim waits until {deadline_words(due)}",
                   detail={"claim": row["id"], "kind": row["kind"], "paper_id": row["paper_id"], "repo": row["repo"],
                           "statement": evidence.get("statement", ""), "link": evidence.get("link", ""),
                           "via": evidence.get("via") or evidence.get("reason") or "", "user": _handles(user),
                           "due": due, "rule": rule})


# ---------------------------------------------------------------------------------------
# Each poll: what reached its deadline, and the claims to check again.

def requeue_undecided(runner: Runner) -> int:
    """The requests queued for the owner before the rules existed (no wait recorded): back to the
    rules at this poll."""
    ensure_schema(runner.state)
    n = runner.state.execute(
        "UPDATE job SET status = 'new' WHERE target = ? AND status = 'owner' AND kind IN ('report', 'claim', 'publish') "
        "AND NOT EXISTS (SELECT 1 FROM waits w WHERE w.target = job.target AND w.ref = job.ref AND "
        "w.kind = CASE job.kind WHEN 'publish' THEN 'submission' ELSE job.kind END)", (runner.target,)).rowcount
    runner.state.commit()
    return n


TABLE = {"report": "reports", "claim": "claims", "submission": "submissions"}
DRAFT_EXPIRED = ("This draft was not published within {days} days: it is closed. Correct it from your account page (its "
                 "links are kept), and it is read again and comes back as a draft.")


def sweep(runner: Runner) -> dict[str, int]:
    """Close what reached its deadline, and check the waiting author claims again. Each closed
    request writes one row of D1 (in the day's budget); the owner's list loses it."""
    from .jobs import _settled, _stamp, _users, _write, words
    ensure_schema(runner.state)
    now = runner.now()
    out = {"closed": 0, "verified": 0, "written": 0}
    due = [dict(r) for r in runner.state.execute("SELECT * FROM waits WHERE target = ? AND (due <= ? OR (next_check > 0 "
                                                 "AND next_check <= ?)) ORDER BY due", (runner.target, now, now))]
    if not due:
        return out
    rows: dict[tuple[str, int], dict[str, Any]] = {}
    for kind in {w["kind"] for w in due}:
        ids = ", ".join(str(int(w["ref"])) for w in due if w["kind"] == kind)
        for r in runner.d1.query(f"SELECT * FROM {TABLE[kind]} WHERE id IN ({ids})"):
            rows[(kind, int(r["id"]))] = r
    users = _users(runner.d1, {r["user_id"] for r in rows.values()})
    t = _stamp(runner)
    for w in due:
        if runner.budget_left() < 3:
            break
        kind, ref = w["kind"], int(w["ref"])
        row = rows.get((kind, ref))
        settle_kinds = {"report": ("report",), "claim": ("claim",), "submission": ("submission",)}[kind]
        waiting_status = {"report": "open", "claim": "pending", "submission": "draft"}[kind]
        if row is None or row["status"] != waiting_status:
            unwait(runner.state, runner.target, kind, ref)          # decided meanwhile
            continue
        if kind == "claim" and row["kind"] == "author" and w["next_check"] and w["next_check"] <= now:
            rule, why = _claim_proof(runner, row, users.get(row["user_id"]))
            if rule:
                outcome = _verify_claim(runner, row, rule, why)
                out["written"] += _write(runner, outcome.sql)
                _settled(runner, settle_kinds, ref, outcome.message)
                out["verified"] += 1
                continue
            runner.state.execute("UPDATE waits SET next_check = ? WHERE target = ? AND kind = ? AND ref = ?",
                                 (now + CLAIM_RECHECK_S, runner.target, kind, ref))
            runner.state.commit()
        if w["due"] > now:
            continue
        if kind == "report":
            sql = (f"UPDATE reports SET status = 'rejected', message = {literal(words(EXPIRED_REPORT.format(days=REVIEW_DAYS)))}, "
                   f"decided_at = {t} WHERE id = {ref} AND status = 'open'")
            decision = "rejected"
        elif kind == "claim":
            text = (EXPIRED_AUTHOR_CLAIM if row["kind"] == "author" else EXPIRED_MAINTAINER_CLAIM).format(days=REVIEW_DAYS)
            sql = (f"UPDATE claims SET status = 'rejected', decided_by = '{RULES}', decided_at = {t}, "
                   f"message = {literal(words(text))} WHERE id = {ref} AND status = 'pending'")
            decision = "rejected"
        else:
            sql = (f"UPDATE submissions SET status = 'refused', message = {literal(words(DRAFT_EXPIRED.format(days=REVIEW_DAYS)))}, "
                   f"updated_at = {t} WHERE id = {ref} AND status = 'draft' AND updated_at = {int(row['updated_at'])}")
            decision = "refused"
        out["written"] += _write(runner, [sql])
        rule = {"report": "report.expired", "claim": "claim.expired", "submission": "submission.draft_expired"}[kind]
        log(runner.state, runner.target, kind, ref, rule, decision, user_id=row["user_id"],
            paper=row.get("target_id") or row.get("paper_id") or row.get("repo") or "", detail={"since": w["since"]}, now=now)
        unwait(runner.state, runner.target, kind, ref)
        _settled(runner, settle_kinds, ref, f"closed by the rules ({rule})")
        out["closed"] += 1
    return out


# ---------------------------------------------------------------------------------------
# The owner reverses what the rules did.

def reverse_report(runner: Runner, report_id: int, message: str = "") -> str:
    """An accepted removal request, reversed: what it withheld comes back (and the record, when it
    was withdrawn), at the next nightly; the requester reads the owner's words."""
    from .jobs import _stamp, _write, words
    rows = runner.d1.query(f"SELECT * FROM reports WHERE id = {int(report_id)}")
    if not rows:
        raise SystemExit(f"no request {report_id} in the {runner.target} database")
    r = rows[0]
    if r["status"] != "accepted":
        return f"request {report_id} is {r['status']}: only an accepted request is reversed"
    con = runner.con
    back = con.execute("DELETE FROM withheld WHERE request = ?", (f"{runner.target}:{int(report_id)}",)).rowcount
    back += con.execute("UPDATE article SET withdrawn = '' WHERE id = ? AND withdrawn LIKE ?",
                        (r["target_id"], f"%: request {int(report_id)} (%")).rowcount
    db.log_event(con, "reversed", article=r["target_id"], request=int(report_id))
    con.commit()
    said = message or "The operator reviewed this request and restored what it had removed."
    _write(runner, [f"UPDATE reports SET status = 'rejected', message = {literal(words(said))}, decided_at = {_stamp(runner)} "
                    f"WHERE id = {int(report_id)} AND status = 'accepted'"])
    log(runner.state, runner.target, "report", int(report_id), "owner.reversed", "reversed", user_id=r["user_id"],
        paper=r["target_id"], detail={"restored": back}, now=runner.now())
    return f"request {report_id} on {r['target_id']}: reversed — {back} withdrawal(s) undone, back at the next nightly"


def reverse_claim(runner: Runner, claim_id: int, message: str = "") -> str:
    """A claim the rules verified, reversed: the role they granted is taken back."""
    from .jobs import _stamp, _write, words
    rows = runner.d1.query(f"SELECT * FROM claims WHERE id = {int(claim_id)}")
    if not rows:
        raise SystemExit(f"no claim {claim_id} in the {runner.target} database")
    c = rows[0]
    if c["status"] != "verified" or c.get("decided_by") != RULES:
        return f"claim {claim_id} is {c['status']} ({c.get('decided_by') or 'undecided'}): only a claim the rules verified is reversed"
    said = message or "The operator reviewed this claim and did not confirm it."
    t = _stamp(runner)
    _write(runner, [f"UPDATE claims SET status = 'rejected', decided_by = 'owner', decided_at = {t}, message = {literal(words(said))} "
                    f"WHERE id = {int(claim_id)} AND status = 'verified'",
                    f"DELETE FROM roles WHERE user_id = {literal(c['user_id'])} AND role = 'verified_author' AND scope_kind = 'paper' "
                    f"AND scope_id = {literal(c['paper_id'])} AND granted_by = '{RULES}'"])
    log(runner.state, runner.target, "claim", int(claim_id), "owner.reversed", "reversed", user_id=c["user_id"],
        paper=c["paper_id"], now=runner.now())
    return f"claim {claim_id} ({c['paper_id']}): reversed, the role taken back"


def reverse_submission(runner: Runner, submission_id: int, message: str = "") -> str:
    """A submission the rules published, reversed: the links it added leave the record (their
    corrections are deleted, so no later scan brings them back), a new version records it, at the
    next nightly."""
    from .jobs import _stamp, _write, record_links, words
    rows = runner.d1.query(f"SELECT * FROM submissions WHERE id = {int(submission_id)}")
    if not rows:
        raise SystemExit(f"no submission {submission_id} in the {runner.target} database")
    s = rows[0]
    if s["status"] != "published":
        return f"submission {submission_id} is {s['status']}: only a published submission is reversed"
    con, paper, ref = runner.con, s["paper_id"], f"submission:{int(submission_id)}"
    added = [r["repo"] for r in con.execute("SELECT repo FROM link_edit WHERE article_id = ? AND ref = ? AND op = 'add'",
                                            (paper, ref))]
    record_links(con, paper)
    con.execute("DELETE FROM link_edit WHERE article_id = ? AND ref = ?", (paper, ref))
    removed = [r for r in added if con.execute("DELETE FROM link WHERE article_id = ? AND repo = ? AND found_by = 'submitter'",
                                               (paper, r)).rowcount]
    con.commit()
    if removed:
        runner.harvester.conclude(con, paper)
        last = con.execute("SELECT snapshot FROM version WHERE entity = 'article' AND entity_id = ? ORDER BY version DESC LIMIT 1",
                           (paper,)).fetchone()
        db.save_version(con, "article", paper, {**(json.loads(last["snapshot"]) if last else {}), **db.links_snapshot(con, paper)},
                        actor="owner:reversal")
        con.commit()
    said = message or "The operator reviewed this submission and took its links off the record."
    _write(runner, [f"UPDATE submissions SET status = 'refused', message = {literal(words(said))}, updated_at = {_stamp(runner)} "
                    f"WHERE id = {int(submission_id)} AND status = 'published'"])
    log(runner.state, runner.target, "submission", int(submission_id), "owner.reversed", "reversed", user_id=s["user_id"],
        paper=paper, detail={"removed": removed}, now=runner.now())
    return f"submission {submission_id} ({s['doi']}): reversed — {', '.join(removed) + ' removed' if removed else 'no link to remove'}"
