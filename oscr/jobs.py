"""Phase 6: what the site's readers ask of the registry, and the Mac's answers
(docs/CONTRIBUTIONS.md).

The Worker records every request in the D1 community database, a submission, a correction, a
map's validation, a claim, a removal request, with a row in `jobs`. The Mac polls `jobs` (the
rows after the last one it saw: `WHERE id > ?`, no index), does the work here, and writes the
outcome into the request's own row, which the reader's pages show:

- `submission`: the DOI harvested by the harvester's single-DOI path (`oscr doi`,
  harvest.scan_article), the submitter's code links verified (their license read from the
  repository), the matches counted, and a draft written back for the submitter to review;
- `publish`: the submitter's links applied to the record (as corrections, `link_edit`), the
  paper aligned, a new version. A submitter who is not among the paper's authors waits for the
  owner (`oscr submissions`);
- `edit`: a verified author's or a maintainer's corrections of the record's links, applied with
  their provenance (their ORCID iD or GitHub login, kept on the Mac) as a new version, which
  the page's Versions section shows as "a correction by a verified author";
- `validation`: the map the page showed (its digest), validated with the author's ORCID iD
  (zenodo.validate: proof `orcid`, or `test` when the site signs in with ORCID's sandbox), then
  deposited on Zenodo, the sandbox unless the settings say `OSCR_ZENODO_INSTANCE=zenodo`
  (zenodo.deposit_map), and its DOI written back;
- `claim` and `report`: decided by the automatic moderator's rules (oscr/moderation.py, since
  2026-09-29: no human moderator is on duty), or left for the owner, 30 days at most, who decides
  with `oscr claims` and `oscr reports` and may reverse what the rules did. A claim accepted writes
  the role into D1; a removal accepted withdraws from every public output what it names: the whole
  record (`article.withdrawn`), or only the copies of its scripts, of one repository, of one file, or
  its tracing map (`withheld`, catalog.withheld). A removal asked for personal data that waits for
  the owner is never closed by the rules: the GDPR gives the owner one month to answer it;
- `rights`: a data-rights request (the page /data-rights/, oscr/rights.py): access, erasure or
  objection answered at once for an account signed in with its ORCID iD, an account deleted; what the
  Mac cannot prove waits for the owner (`oscr rights`) with its legal deadline, never closed unanswered.

**State.** `data/community/state.db`, with the facts push's: each job's status, attempts and what
the owner needs to see (`job`), the last job seen per target (`job_cursor`). The rows written
count in the facts push's daily budget (`community_budget`: 10,000 by default), so the two never
spend more than their share of D1's 100,000 rows a day together.

**Cost in D1.** A poll reads the new jobs (none when nothing is new), the requests they name and
their accounts, by key: a few rows per request. An answer writes one row (two for a claim
accepted: the claim and the role).

    oscr jobs poll --local|--remote      read the new requests, answer them
    oscr jobs status                     what waits, what was done, the rows written today
    oscr claims list|accept|refuse …     the claims that wait for the owner
    oscr reports list|accept|reject …    the removal requests
    oscr submissions list|accept|refuse …  the submissions published by someone who is not an author
    oscr rights list|done|refuse|erase …   the data-rights requests the Mac could not answer by itself
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from . import catalog, community, db, entities, links, moderation, rights, zenodo
from .community import D1, literal

#: A job that failed this many times is given up, and the reader told.
MAX_ATTEMPTS = 5
#: Jobs read per poll.
BATCH = 100
#: The request's table, per kind of job.
TABLES: dict[str, str] = {"submission": "submissions", "publish": "submissions", "edit": "edits",
                          "validation": "validations", "claim": "claims", "report": "reports", "rights": "rights"}
#: Roles of a link, as the site names them → as the harvester does.
ROLES: dict[str, str] = {"code": "code", "data": "data", "tool": "third_party_tool"}

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS job (
    target      TEXT NOT NULL,              -- local | remote
    id          INTEGER NOT NULL,           -- jobs.id in D1
    kind        TEXT NOT NULL,
    ref         INTEGER NOT NULL,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'new',   -- new | done | owner | failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    detail      TEXT NOT NULL DEFAULT '{}',    -- what the owner needs to decide
    message     TEXT NOT NULL DEFAULT '',
    updated_at  REAL NOT NULL,
    PRIMARY KEY (target, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS job_cursor (
    target   TEXT PRIMARY KEY,
    last_id  INTEGER NOT NULL
);
"""


def open_state(path: Any) -> sqlite3.Connection:
    """The facts push's state file, with the jobs' tables and the moderator's (oscr/moderation.py)."""
    state = community.open_state(path)
    state.executescript(STATE_SCHEMA)
    moderation.ensure_schema(state)
    return state


def words(text: str, most: int = 1000) -> str:
    """A message for a reader: no contact detail, no at sign (the D1 schema refuses one)."""
    return re.sub(r"\s+", " ", entities.strip_contacts(text or "").replace("@", " ")).strip()[:most]


# ---------------------------------------------------------------------------------------
# What the harvester does for the jobs.

class Harvester(Protocol):
    def harvest(self, con: sqlite3.Connection, doi: str) -> str:
        """Read the paper of `doi` (text, links, verification, enrichment); its id."""

    def verify(self, con: sqlite3.Connection, link: links.Link, article_id: str) -> None:
        """Verify a repository (state, commit, license, files) and describe it."""

    def conclude(self, con: sqlite3.Connection, article_id: str) -> str:
        """The paper's status, after its links changed."""

    def align(self, con: sqlite3.Connection, article_id: str, repos: list[str] | None = None, *,
              save: bool = True) -> int | None:
        """The paper ↔ code matches: saved (its code links), or only counted (`repos`)."""


class MacHarvester:
    """The harvester's own functions (oscr/harvest.py), with its client and options."""

    def __init__(self, client: Any, opts: Any) -> None:
        self.client, self.opts = client, opts

    def harvest(self, con: sqlite3.Connection, doi: str) -> str:
        from . import harvest
        from .sources import europepmc
        art = europepmc.by_doi(self.client, doi)
        if art is None:
            art = europepmc.EpmcArticle(id=europepmc.identifier(doi.lower(), ""), doi=doi.lower(), source="doi")
        harvest.scan_article(con, self.client, art, self.opts)
        con.commit()
        return art.id

    def verify(self, con: sqlite3.Connection, link: links.Link, article_id: str) -> None:
        from . import enrich, harvest
        con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind) VALUES (?,?,?,?)",
                    (link.repo, link.url, link.host, link.kind))
        con.commit()
        if not self.opts.verify:
            return            # `--no-verify`: the repository waits for the harvester's next verification
        a = con.execute("SELECT doi, title FROM article WHERE id = ?", (article_id,)).fetchone()
        db.save_repository(con, link.repo, harvest._verify_one(self.client, link, dict(a) if a else {}, self.opts))
        enrich.repository_facts(con, link.repo)
        con.commit()

    def conclude(self, con: sqlite3.Connection, article_id: str) -> str:
        from . import harvest
        return harvest.conclude(con, article_id, self.opts)

    def align(self, con: sqlite3.Connection, article_id: str, repos: list[str] | None = None, *,
              save: bool = True) -> int | None:
        from . import align, harvest
        from .sources import europepmc
        try:
            if save:
                n = harvest.align_article(con, self.client, article_id)
                con.commit()
                return n
            a = con.execute("SELECT fulltext_id, pmcid FROM article WHERE id = ?", (article_id,)).fetchone()
            fulltext = (a["fulltext_id"] or a["pmcid"]) if a else ""
            marks = ",".join("?" * len(repos or []))
            files = [dict(repo=f["repo"], path=f["path"], language=f["language"], text=f["text"]) for f in con.execute(
                f"SELECT repo, path, language, text FROM file WHERE repo IN ({marks}) AND kind = 'script' "
                "AND text IS NOT NULL", tuple(repos or []))] if repos else []
            if not files:
                return 0
            if not fulltext:
                return None
            xml = europepmc.fulltext(self.client, fulltext)
            return len(align.align(xml, files)) if xml else None
        except Exception:        # matches are a bonus: never a failed job
            con.rollback()
            return None


# ---------------------------------------------------------------------------------------
# The runner.

@dataclass
class Outcome:
    """What a job ends in: `done` (answered), `owner` (waits for the owner's decision), `retry`
    (the Mac could not do it now), `failed` (given up). `sql`: what D1 is told."""
    status: str
    sql: list[str] = field(default_factory=list)
    message: str = ""
    detail: dict[str, Any] = field(default_factory=dict)
    #: Whether a `retry` counts as an attempt: not when the Mac itself is not ready (no token).
    counts: bool = True


@dataclass
class Runner:
    con: sqlite3.Connection
    d1: D1
    state: sqlite3.Connection
    harvester: Harvester
    #: The Zenodo instance of the deposits: the sandbox while the platform is built (CLAUDE.md).
    instance: str = "sandbox"
    zenodo_community: str = "oscr"
    platform: str = "Open Scientific Code Registry (OSCR)"
    #: Zenodo's client for an instance, with the Mac's token for it (keychain).
    invenio: Callable[[str], zenodo.Invenio] = lambda instance: zenodo.Invenio(instance, api_token=zenodo.token(instance))
    #: Rows written a day, the facts push's included (community.DAILY_BUDGET).
    budget: int = community.DAILY_BUDGET
    report: Callable[[str], None] = print
    now: Callable[[], float] = time.time
    #: What the moderator's rules may look up (ORCID records, forge owners): nothing by default.
    evidence: Any = field(default_factory=moderation.NoEvidence)

    @property
    def target(self) -> str:
        return self.d1.target

    def budget_left(self) -> int:
        return self.budget - community.budget_spent(self.state, self.target, community.utc_day(self.now()))


def _stamp(runner: Runner) -> int:
    return int(runner.now())


def actor(user: dict[str, Any] | None) -> str:
    """Who, in a version's provenance: the ORCID iD, else the GitHub login (public handles)."""
    if user and user.get("orcid"):
        return f"orcid:{user['orcid']}"
    if user and user.get("github_login"):
        return f"github:{user['github_login']}"
    return f"user:{(user or {}).get('id', '')}"


def _handles(user: dict[str, Any] | None) -> dict[str, str]:
    return {"name": (user or {}).get("display_name") or "", "orcid": (user or {}).get("orcid") or "",
            "github": (user or {}).get("github_login") or ""}


def _paper(con: sqlite3.Connection, article_id: str) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone()


def _out_of_scope(a: sqlite3.Row | None) -> str:
    """Why a paper cannot take a contribution, in words; "" when it can."""
    if a is None:
        return "This paper is not in the registry."
    if a["withdrawn"]:
        return "This record was removed from the site."
    if a["on_topic"] == "no":
        return "This paper is outside the registry's scope (neuroscience): it stays off the site."
    return ""


# ---------------------------------------------------------------------------------------
# Corrections of a record's links, and its versions.

def record_links(con: sqlite3.Connection, article_id: str) -> None:
    """The record's last version keeps its links: a version recording them (the harvester's)
    when it does not yet, so that a person's correction shows what it changed."""
    last = con.execute("SELECT snapshot FROM version WHERE entity = 'article' AND entity_id = ? ORDER BY version DESC "
                       "LIMIT 1", (article_id,)).fetchone()
    snapshot = json.loads(last["snapshot"]) if last else {}
    if "code" not in snapshot or "data" not in snapshot:
        db.save_version(con, "article", article_id, {**snapshot, **db.links_snapshot(con, article_id)})


def apply_changes(runner: Runner, article_id: str, changes: list[dict[str, Any]], *, source: str, who: str,
                  ref: str) -> tuple[int | None, list[str], list[str]]:
    """A person's changes of a record's links: kept (`link_edit`, so that the next scan keeps
    them), applied, the added repositories verified, the paper concluded again, and a new
    version with its provenance. Returns (the version, what was applied, what was left aside)."""
    con = runner.con
    record_links(con, article_id)
    current = {r["repo"]: r["role"] for r in con.execute("SELECT repo, role FROM link WHERE article_id = ?", (article_id,))}
    now = runner.now()
    applied: list[str] = []
    skipped: list[str] = []
    verify: list[links.Link] = []
    for c in changes:
        op = c.get("op")
        if op == "add":
            link = links.normalize(str(c.get("url") or ""))
            role = ROLES.get(str(c.get("role")), "")
            if link is None or role not in ("code", "data"):
                skipped.append(f"{c.get('url')}: not a link the registry reads")
                continue
            if current.get(link.repo) == role:
                skipped.append(f"{link.repo}: already there")
                continue
            con.execute("INSERT OR REPLACE INTO link_edit (article_id, repo, op, url, host, kind, role, source, actor, ref, "
                        "created_at) VALUES (?, ?, 'add', ?, ?, ?, ?, ?, ?, ?, ?)",
                        (article_id, link.repo, link.url, link.host, link.kind, role, source, who, ref, now))
            if role == "code" or link.kind in ("forge", "archive", "execution"):
                verify.append(link)
            applied.append(f"{link.repo} added ({role})")
        elif op in ("remove", "role"):
            repo = str(c.get("repo") or "").lower()
            if repo not in current:
                skipped.append(f"{repo}: not a link of this record")
                continue
            role = ROLES.get(str(c.get("role")), "") if op == "role" else ""
            if op == "role" and (not role or current[repo] == role):
                skipped.append(f"{repo}: already {role or 'so'}")
                continue
            con.execute("INSERT OR REPLACE INTO link_edit (article_id, repo, op, role, source, actor, ref, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (article_id, repo, op, role, source, who, ref, now))
            applied.append(f"{repo} removed" if op == "remove" else f"{repo}: now {role.replace('_', ' ')}")
        else:
            skipped.append(f"a change the registry does not know ({op})")
    if not applied:
        return None, applied, skipped
    db.apply_link_edits(con, article_id)
    con.commit()
    for link in verify:
        runner.harvester.verify(con, link, article_id)
    runner.harvester.conclude(con, article_id)
    last = con.execute("SELECT snapshot FROM version WHERE entity = 'article' AND entity_id = ? ORDER BY version DESC "
                       "LIMIT 1", (article_id,)).fetchone()
    snapshot = {**(json.loads(last["snapshot"]) if last else {}), **db.links_snapshot(con, article_id)}
    version = db.save_version(con, "article", article_id, snapshot, actor=f"{source}:{who}")
    db.record_provenance(con, "article", article_id, {"links.code": source, "links.data": source}, ref=who, at=now)
    con.commit()
    return version, applied, skipped


# ---------------------------------------------------------------------------------------
# Submissions.

def _submitted(row: dict[str, Any]) -> list[links.Link]:
    out = []
    for url in json.loads(row.get("code_urls") or "[]"):
        link = links.normalize(str(url))
        if link is not None and link.repo not in {x.repo for x in out}:
            out.append(link)
    return out


def _is_author(runner: Runner, article_id: str, user: dict[str, Any] | None) -> bool:
    """The submitter's ORCID iD is among the paper's authors, or the owner made them one."""
    orcid = (user or {}).get("orcid") or ""
    if orcid and runner.con.execute("SELECT 1 FROM paper_author WHERE article_id = ? AND orcid = ?",
                                    (article_id, orcid)).fetchone():
        return True
    if not user:
        return False
    return bool(runner.d1.query(
        f"SELECT 1 AS yes FROM roles WHERE user_id = {literal(user['id'])} AND role = 'verified_author' "
        f"AND scope_kind = 'paper' AND scope_id = {literal(article_id)}"))


def draft_of(con: sqlite3.Connection, article_id: str, submitted: list[links.Link], pairs: int | None) -> dict[str, Any]:
    """What the submitter reviews: the record as it would be published, the paper, the code
    links it cites and the ones given, each as verified (state, license, scripts), the map."""
    a = _paper(con, article_id)
    assert a is not None
    found = {r["repo"]: r for r in con.execute("SELECT * FROM link WHERE article_id = ? AND role IN ('code', 'data')",
                                               (article_id,))}
    given = {x.repo: x for x in submitted}
    rows = []
    for repo in sorted(set(found) | set(given)):
        link, x = found.get(repo), given.get(repo)
        d = con.execute("SELECT * FROM repository WHERE repo = ?", (repo,)).fetchone()
        rows.append({
            "key": repo, "url": (link["url"] if link else x.url if x else "") or "",
            "role": link["role"] if link else "code",
            "source": "both" if link and x else "paper" if link else "you",
            "state": (d["state"] if d else "") or "unverified", "license": (d["license"] if d else "") or "",
            "redistributable": (d["redistributable"] if d else "") or "unknown",
            "scripts": d["n_scripts"] if d else None, "commit": ((d["commit_id"] if d else "") or "")[:12],
        })
    code = [r for r in rows if r["role"] == "code"]
    files = sum(int(r["scripts"] or 0) for r in code)
    alive = [r for r in code if r["state"] == "alive"]
    status = "code_verified" if alive else "code_found" if code else a["status"]
    notes = []
    if not a["has_fulltext"]:
        notes.append("Europe PMC has no full text of this paper: the registry read its metadata only.")
    if any(r["state"] == "dead" for r in code):
        notes.append("A code link does not answer: check it, or remove it.")
    if any(r["redistributable"] not in ("yes", "with_conditions") for r in alive):
        notes.append("A repository has no license that allows copying its files: the site will link to them at the "
                     "source, without showing their text.")
    return entities.scrub({
        "paper": {"id": article_id, "doi": a["doi"], "title": a["title"], "journal": a["journal"],
                  "published": a["published"], "status": status, "page": bool(code) or a["status"] in ("on_request", "data_only"),
                  "slug": catalog.slug(article_id)},
        "links": rows,
        "map": {"repositories": len(code), "files": files, "pairs": pairs},
        "notes": notes,
    })


def run_submission(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    if row is None or row["status"] != "queued":
        return Outcome("done", message="nothing to do: the submission is not queued")
    con = runner.con
    submitted = _submitted(row)
    try:
        article_id = runner.harvester.harvest(con, row["doi"])
    except Exception as e:  # Europe PMC or a forge down: try again at the next poll
        return Outcome("retry", message=f"the paper could not be read: {type(e).__name__}: {e}"[:300])
    a = _paper(con, article_id)
    why = _out_of_scope(a)
    t = _stamp(runner)
    guard = f"id = {literal(row['id'])} AND status = 'queued' AND updated_at = {literal(row['updated_at'])}"
    if why:
        return Outcome("done", [f"UPDATE submissions SET status = 'refused', paper_id = {literal(article_id)}, "
                                f"message = {literal(words(why))}, updated_at = {t} WHERE {guard}"], message=why)
    for link in submitted:
        if not con.execute("SELECT 1 FROM repository WHERE repo = ? AND verified_at IS NOT NULL", (link.repo,)).fetchone():
            runner.harvester.verify(con, link, article_id)
    code = [r["repo"] for r in con.execute("SELECT repo FROM link WHERE article_id = ? AND role = 'code'", (article_id,))]
    pairs = runner.harvester.align(con, article_id, sorted(set(code) | {x.repo for x in submitted}), save=False)
    draft = draft_of(con, article_id, submitted, pairs)
    author = _is_author(runner, article_id, user)
    # A draft the submitter does not publish is closed after moderation.REVIEW_DAYS: nothing waits forever.
    moderation.unwait(runner.state, runner.target, "submission", int(row["id"]))
    moderation.wait(runner.state, runner.target, "submission", int(row["id"]), float(t), "submission.draft_expired")
    return Outcome("done", [
        f"UPDATE submissions SET status = 'draft', paper_id = {literal(article_id)}, author = {int(author)}, "
        f"draft = {literal(json.dumps(draft, ensure_ascii=False, separators=(',', ':')))}, message = '', "
        f"updated_at = {t} WHERE {guard}"], message=f"draft of {article_id}")


def apply_submission(runner: Runner, row: dict[str, Any], user: dict[str, Any] | None) -> tuple[str, str]:
    """A published submission: its code links on the record (as the submitter's corrections),
    the paper aligned. Returns (status, message) for the submitter."""
    con = runner.con
    article_id = row["paper_id"]
    why = _out_of_scope(_paper(con, article_id))
    if why:
        return "refused", why
    current = {r["repo"]: r["role"] for r in con.execute("SELECT repo, role FROM link WHERE article_id = ?", (article_id,))}
    changes = []
    for link in _submitted(row):
        if link.repo not in current:
            changes.append({"op": "add", "url": link.url, "role": "code"})
        elif current[link.repo] != "code":
            changes.append({"op": "role", "repo": link.repo, "role": "code"})
    version, applied, _ = apply_changes(runner, article_id, changes, source="submitter", who=actor(user),
                                        ref=f"submission:{row['id']}")
    runner.harvester.align(con, article_id, save=True)
    if version:
        return "published", f"Published: {'; '.join(applied)}. The site shows it after its next update."
    return "published", "Published: the record already had these links. The site shows it after its next update."


def run_publish(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    if row is None or row["status"] not in ("publishing", "moderation"):
        return Outcome("done", message="nothing to do: the submission is not being published")
    moderation.unwait(runner.state, runner.target, "submission", int(row["id"]))
    if row["status"] == "moderation":
        # The submitter is not among the paper's authors: the moderator's rules decide.
        return moderation.decide_submission(runner, job, row, user)
    status, message = apply_submission(runner, row, user)
    return Outcome("done", [f"UPDATE submissions SET status = {literal(status)}, message = {literal(words(message))}, "
                            f"updated_at = {_stamp(runner)} WHERE id = {literal(row['id'])} AND status = 'publishing'"],
                   message=message)


# ---------------------------------------------------------------------------------------
# Edits.

def run_edit(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    if row is None or row["status"] != "queued":
        return Outcome("done", message="nothing to do: the correction is not queued")
    t = _stamp(runner)
    where = f"WHERE id = {literal(row['id'])} AND status = 'queued'"
    why = _out_of_scope(_paper(runner.con, row["paper_id"]))
    if why:
        return Outcome("done", [f"UPDATE edits SET status = 'refused', message = {literal(words(why))}, decided_at = {t} {where}"],
                       message=why)
    source = "maintainer" if row["as_role"] == "maintainer" else "author"
    if source == "maintainer" and not moderation.maintainers(runner, row["user_id"]).get(row["repo"]):
        # A contributor of the repository is shown as its maintainer by GitHub's check, but one merged
        # pull request makes one: the rules do not let them change the paper's record (the Worker
        # refuses it too since 2026-09-29; this is for a request recorded before).
        message = moderation.UNTRUSTED_MAINTAINER
        moderation.log(runner.state, runner.target, "edit", int(row["id"]), "edit.untrusted_maintainer", "refused",
                       user_id=row["user_id"], paper=row["paper_id"], detail={"repo": row["repo"]}, now=runner.now())
        return Outcome("done", [f"UPDATE edits SET status = 'refused', message = {literal(words(message))}, decided_at = {t} "
                                f"{where}"], message=message)
    version, applied, skipped = apply_changes(runner, row["paper_id"], json.loads(row["changes"] or "[]"), source=source,
                                              who=actor(user), ref=f"edit:{row['id']}")
    if version is None and not applied:
        message = "Nothing to change: " + "; ".join(skipped) if skipped else "Nothing to change."
        return Outcome("done", [f"UPDATE edits SET status = 'refused', message = {literal(words(message))}, "
                                f"decided_at = {t} {where}"], message=message)
    message = "Applied: " + "; ".join(applied) + (f". Left aside: {'; '.join(skipped)}" if skipped else "") + \
        ". The site shows it after its next update."
    return Outcome("done", [f"UPDATE edits SET status = 'applied', version = {literal(version)}, "
                            f"message = {literal(words(message))}, decided_at = {t} {where}"], message=message)


# ---------------------------------------------------------------------------------------
# Validations.

def author_name(con: sqlite3.Connection, article_id: str, orcid: str, fallback: str = "") -> str:
    """"Family, Given", as Zenodo's creators take it: from the paper's own list of authors, else
    from the name the account gave."""
    r = con.execute("SELECT name, given, family FROM paper_author WHERE article_id = ? AND orcid = ? ORDER BY position",
                    (article_id, orcid)).fetchone()
    if r is not None and r["family"]:
        return f"{r['family']}, {r['given']}".strip()
    name = (r["name"] if r is not None else "") or fallback
    given, _, family = name.strip().rpartition(" ")
    return f"{family}, {given}".strip() if family else f"{orcid}, "


def run_validation(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    if row is None or row["status"] != "queued":
        return Outcome("done", message="nothing to do: the validation is not queued")
    con = runner.con
    article_id = row["paper_id"]
    t = _stamp(runner)
    where = f"WHERE id = {literal(row['id'])} AND status = 'queued'"

    def answer(status: str, message: str, **extra: Any) -> Outcome:
        sets = "".join(f", {k} = {literal(v)}" for k, v in extra.items())
        return Outcome("done" if status != "failed" else "failed",
                       [f"UPDATE validations SET status = {literal(status)}, message = {literal(words(message))}{sets}, "
                        f"decided_at = {t} {where}"], message=message)

    why = _out_of_scope(_paper(con, article_id))
    if why:
        return answer("refused", why)
    if article_id in catalog.withheld(con).maps:
        return answer("refused", "This paper's tracing map was withheld at a removal request: there is no map to validate.")
    try:
        card = zenodo.map_of(con, article_id)
    except zenodo.InvenioError as e:
        return answer("refused", str(e))
    if not card["code"]:
        return answer("refused", "This paper has no code in the registry: it has no map to validate.")
    if zenodo.map_digest(card) != row["map_digest"]:
        return answer("map_changed", "The map changed since the page showed it: reload the paper's page, look at it "
                                     "again, and validate it if it is right.")
    # The proof: the ORCID iD the author signed in with. From ORCID's sandbox, a test, which only
    # Zenodo's sandbox accepts and no public output shows (CLAUDE.md).
    proof = "orcid" if row["proof"] == "orcid" else "test"
    # The paper's own list of authors names them; failing that, the account's name, as it may be public.
    name = author_name(con, article_id, row["orcid"], moderation.public_name((user or {}).get("display_name") or ""))
    inv = runner.invenio(runner.instance)
    try:
        if not inv.can_write:
            return Outcome("retry", message=f"no Zenodo token for {runner.instance} on the Mac "
                                            f"(keychain {zenodo.keychain_service(runner.instance)})", counts=False)
        zenodo.validate(con, article_id, orcid=row["orcid"], name=name, proof=proof, card=card)
        deposit = zenodo.deposit_map(con, inv, article_id, platform=runner.platform, community=runner.zenodo_community,
                                     report=lambda m: runner.report(f"  zenodo: {m}"))
    except zenodo.InvenioError as e:
        if "not validated by an author" in str(e):
            return answer("refused", "This validation is a test (ORCID's sandbox): the real Zenodo does not take it.")
        if job.get("attempts", 0) + 1 >= MAX_ATTEMPTS:
            return answer("failed", f"Zenodo refused the deposit: {e}"[:500])
        return Outcome("retry", message=f"Zenodo: {e}"[:300])
    finally:
        inv.close()
    doi = deposit.get("doi") or ""
    return answer("deposited", f"Deposited on Zenodo{' (sandbox)' if runner.instance == 'sandbox' else ''}"
                               f"{': DOI ' + doi if doi else ''}.", instance=runner.instance, doi=doi,
                  record_url=str(deposit.get("url") or ""))


# ---------------------------------------------------------------------------------------
# Claims and removal requests: the moderator's rules (oscr/moderation.py), and the owner.

def run_claim(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    if row is None or row["status"] != "pending":
        if row is not None:
            moderation.unwait(runner.state, runner.target, "claim", int(row["id"]))
        return Outcome("done", message="nothing to do: the claim is not pending")
    return moderation.decide_claim(runner, job, row, user)


#: What a removal request asks to remove (the page /removal/; D1 migration 0003), in the owner's words.
SCOPES: dict[str, str] = {"record": "the whole record", "scripts": "the copies of the authors' scripts",
                          "repository": "the copies of one repository", "file": "the copy of one file",
                          "map": "the tracing map"}
#: Who asks (a request made before the page says nothing).
REQUESTERS: dict[str, str] = {"author": "an author of the paper", "rights_holder": "the holder of the rights",
                              "named_person": "a person named in the record", "other": "someone else"}


def run_report(runner: Runner, job: dict[str, Any], row: dict[str, Any] | None, user: dict[str, Any] | None) -> Outcome:
    if row is None or row["status"] != "open":
        if row is not None:
            moderation.unwait(runner.state, runner.target, "report", int(row["id"]))
        return Outcome("done", message="nothing to do: the request is not open")
    return moderation.decide_report(runner, job, row, user)


HANDLERS: dict[str, Callable[[Runner, dict[str, Any], dict[str, Any] | None, dict[str, Any] | None], Outcome]] = {
    "submission": run_submission, "publish": run_publish, "edit": run_edit, "validation": run_validation,
    "claim": run_claim, "report": run_report, "rights": rights.run_rights,
}


# ---------------------------------------------------------------------------------------
# The poll.

@dataclass
class Poll:
    new: int = 0
    done: int = 0
    owner: int = 0
    retry: int = 0
    failed: int = 0
    written: int = 0
    #: Jobs left for the next poll: the day's budget is spent.
    deferred: int = 0
    #: Closed by the rules at their deadline, and claims verified when checked again (moderation.sweep).
    closed: int = 0
    verified: int = 0

    def describe(self, target: str) -> str:
        return (f"{target}: {self.new} new request(s); {self.done} answered, {self.owner} for the owner, {self.retry} to "
                f"try again, {self.failed} given up; {self.written} rows written"
                + (f"; {self.closed} closed at their deadline" if self.closed else "")
                + (f"; {self.verified} claim(s) verified on a new check" if self.verified else "")
                + (f"; {self.deferred} wait for tomorrow's budget" if self.deferred else ""))


def _cursor(state: sqlite3.Connection, target: str) -> int:
    r = state.execute("SELECT last_id FROM job_cursor WHERE target = ?", (target,)).fetchone()
    return int(r["last_id"]) if r else 0


def _rows(d1: D1, table: str, ids: set[int]) -> dict[int, dict[str, Any]]:
    if not ids:
        return {}
    return {int(r["id"]): r for r in d1.query(f"SELECT * FROM {table} WHERE id IN ({', '.join(str(int(i)) for i in sorted(ids))})")}


def _users(d1: D1, ids: set[str]) -> dict[str, dict[str, Any]]:
    if not ids:
        return {}
    listed = ", ".join(literal(i) for i in sorted(ids))
    return {r["id"]: r for r in d1.query(f"SELECT id, display_name, orcid, github_login FROM users WHERE id IN ({listed})")}


def _write(runner: Runner, sql: list[str]) -> int:
    if not sql:
        return 0
    rows = runner.d1.run(sql)
    community.spend(runner.state, runner.target, rows, now=runner.now())
    return rows


def _settle(runner: Runner, jobs: list[dict[str, Any]], outcome: Outcome) -> None:
    now = runner.now()
    for j in jobs:
        status = {"retry": "new"}.get(outcome.status, outcome.status)
        runner.state.execute("UPDATE job SET status = ?, attempts = attempts + ?, detail = ?, message = ?, updated_at = ? "
                             "WHERE target = ? AND id = ?",
                             (status, int(outcome.status in ("retry", "failed") and outcome.counts),
                              json.dumps(outcome.detail, ensure_ascii=False), outcome.message[:1000], now,
                              runner.target, j["id"]))
    runner.state.commit()


def poll(runner: Runner) -> Poll:
    """Read the jobs after the last one seen, then answer every job not answered yet, in order,
    within the day's budget. A request asked several times (a claim again, a submission
    corrected twice) is answered once, from its latest state."""
    state, target = runner.state, runner.target
    out = Poll()
    fresh = runner.d1.query(f"SELECT id, kind, ref, user_id, created_at FROM jobs WHERE id > {_cursor(state, target)} "
                            f"ORDER BY id LIMIT {BATCH}")
    now = runner.now()
    for j in fresh:
        state.execute("INSERT OR IGNORE INTO job (target, id, kind, ref, user_id, created_at, updated_at) "
                      "VALUES (?,?,?,?,?,?,?)", (target, int(j["id"]), j["kind"], int(j["ref"]), j["user_id"],
                                                 int(j["created_at"]), now))
    if fresh:
        state.execute("INSERT INTO job_cursor (target, last_id) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET "
                      "last_id = excluded.last_id", (target, max(int(j["id"]) for j in fresh)))
    state.commit()
    out.new = len(fresh)
    # What waited for the owner before the moderator's rules existed goes to the rules once.
    moderation.requeue_undecided(runner)
    waiting = [dict(r) for r in state.execute("SELECT * FROM job WHERE target = ? AND status = 'new' ORDER BY id", (target,))]
    groups: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for j in waiting:
        groups.setdefault((j["kind"], j["ref"]), []).append(j)
    by_table: dict[str, set[int]] = {}
    for kind, ref in groups:
        by_table.setdefault(TABLES[kind], set()).add(ref)
    requests = {table: _rows(runner.d1, table, ids) for table, ids in by_table.items()}
    users = _users(runner.d1, {j["user_id"] for j in waiting})
    for (kind, ref), jobs in sorted(groups.items(), key=lambda g: g[1][-1]["id"]):
        if runner.budget_left() < 3:
            out.deferred += len(jobs)
            continue
        latest = jobs[-1]
        row = requests.get(TABLES[kind], {}).get(ref)
        try:
            outcome = HANDLERS[kind](runner, latest, row, users.get(latest["user_id"]))
        except Exception as e:  # one request never stops the others
            runner.con.rollback()
            outcome = Outcome("retry", message=f"{type(e).__name__}: {e}"[:300])
        if outcome.status == "retry" and outcome.counts and latest["attempts"] + 1 >= MAX_ATTEMPTS:
            # A data-rights request is never closed unanswered: the operator's, with its legal deadline.
            outcome = (rights.hand_over(runner, row, users.get(latest["user_id"]), outcome.message) if kind == "rights"
                       else give_up(kind, ref, outcome.message, _stamp(runner)))
        try:
            out.written += _write(runner, outcome.sql)
        except community.D1Error as e:
            outcome = Outcome("retry", message=f"D1: {e}"[:300])
        _settle(runner, jobs, outcome)
        setattr(out, outcome.status, getattr(out, outcome.status) + len(jobs))
        runner.report(f"  job {latest['id']} ({kind} {ref}): {outcome.status}"
                      + (f", {outcome.message}" if outcome.message else ""))
    # What reached its deadline is closed, the waiting author claims are checked again.
    try:
        swept = moderation.sweep(runner)
    except community.D1Error as e:
        runner.report(f"  the rules' deadlines wait for the next poll (D1: {e})"[:300])
        swept = {"closed": 0, "verified": 0, "written": 0}
    out.closed, out.verified = swept["closed"], swept["verified"]
    out.written += swept["written"]
    return out


def give_up(kind: str, ref: int, why: str, t: int) -> Outcome:
    """A request the Mac could not answer after MAX_ATTEMPTS: the reader is told."""
    message = literal(words(f"The registry could not complete this request: {why}", 500))
    table = TABLES[kind]
    sql = {
        "submissions": f"UPDATE submissions SET status = 'refused', message = {message}, updated_at = {t} WHERE id = {ref} "
                       f"AND status IN ('queued', 'publishing')",
        "edits": f"UPDATE edits SET status = 'refused', message = {message}, decided_at = {t} WHERE id = {ref} AND status = 'queued'",
        "validations": f"UPDATE validations SET status = 'failed', message = {message}, decided_at = {t} WHERE id = {ref} "
                       f"AND status = 'queued'",
    }.get(table)
    return Outcome("failed", [sql] if sql else [], message=f"given up: {why}")


# ---------------------------------------------------------------------------------------
# The owner's decisions.

def waiting(state: sqlite3.Connection, target: str, kinds: tuple[str, ...]) -> list[dict[str, Any]]:
    """What waits for the owner: one item per request (a claim asked twice is one claim), from its
    latest job, oldest request first."""
    marks = ",".join("?" * len(kinds))
    latest: dict[tuple[str, int], dict[str, Any]] = {}
    for r in state.execute(f"SELECT * FROM job WHERE target = ? AND status = 'owner' AND kind IN ({marks}) ORDER BY id",
                           (target, *kinds)):
        latest[(r["kind"], r["ref"])] = {**dict(r), "detail": json.loads(r["detail"] or "{}")}   # keeps its first place
    return list(latest.values())


def _settled(runner: Runner, kinds: tuple[str, ...], ref: int, message: str) -> None:
    marks = ",".join("?" * len(kinds))
    runner.state.execute(f"UPDATE job SET status = 'done', message = ?, updated_at = ? WHERE target = ? AND kind IN ({marks}) "
                         "AND ref = ? AND status IN ('owner', 'new')", (message[:1000], runner.now(), runner.target, *kinds, ref))
    runner.state.commit()


def decide_claim(runner: Runner, claim_id: int, accept: bool, message: str = "") -> str:
    """A pending claim decided by the owner: verified (the role in D1, granted by the owner:
    the automatic verification never takes it back) or rejected. One the moderator's rules closed
    may still be accepted: the owner overrides them."""
    rows = runner.d1.query(f"SELECT * FROM claims WHERE id = {int(claim_id)}")
    if not rows:
        raise SystemExit(f"no claim {claim_id} in the {runner.target} database")
    c = rows[0]
    overridden = accept and c["status"] == "rejected" and c.get("decided_by") == moderation.RULES
    if c["status"] != "pending" and not overridden:
        _settled(runner, ("claim",), claim_id, f"already {c['status']}")
        return f"claim {claim_id} is already {c['status']}"
    t = _stamp(runner)
    said = literal(words(message))
    sql = [f"UPDATE claims SET status = {literal('verified' if accept else 'rejected')}, decided_by = 'owner', "
           f"decided_at = {t}, message = {said} WHERE id = {int(claim_id)} AND status = {literal(c['status'])}"]
    if accept:
        role, kind, scope = ("verified_author", "paper", c["paper_id"]) if c["kind"] == "author" else ("maintainer", "repo", c["repo"])
        sql.append(f"INSERT OR IGNORE INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES "
                   f"({literal(c['user_id'])}, {literal(role)}, {literal(kind)}, {literal(scope)}, 'owner', {t})")
    _write(runner, sql)
    _settled(runner, ("claim",), claim_id, "accepted" if accept else "refused")
    moderation.unwait(runner.state, runner.target, "claim", int(claim_id))
    moderation.log(runner.state, runner.target, "claim", int(claim_id), "owner", "verified" if accept else "rejected",
                   user_id=c["user_id"], paper=c["paper_id"] or c["repo"], detail={"message": message}, now=runner.now())
    target = c["paper_id"] or c["repo"]
    return f"claim {claim_id} ({c['kind']} of {target}): {'accepted' if accept else 'refused'}"


def withhold(con: sqlite3.Connection, scope: str, article_id: str, *, repo: str = "", path: str = "", request: str = "",
             reason: str = "", now: float | None = None) -> None:
    """A removal request accepted for less than the whole record: what it names leaves every public
    output at the next nightly (the `withheld` table, oscr/migrations/0008; catalog.withheld), the
    record stays. 'scripts': the copies of the paper's code; 'repository': one repository's; 'file':
    one file's; 'map': the paper's tracing map."""
    if scope not in ("scripts", "repository", "file", "map"):
        raise ValueError(f"not a scope to withhold: {scope!r}")
    repo, path = (repo, path) if scope == "file" else (repo, "") if scope == "repository" else ("", "")
    if scope in ("repository", "file") and not repo:
        raise ValueError(f"a {scope} withheld names its repository")
    if scope == "file" and not path:
        raise ValueError("a file withheld names its path")
    con.execute("INSERT INTO withheld (scope, article_id, repo, path, request, reason, created_at) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT (scope, article_id, repo, path) DO UPDATE SET request = excluded.request, "
                "reason = excluded.reason", (scope, article_id, repo, path, request, reason, now or time.time()))
    db.log_event(con, "withheld", article=article_id, scope=scope, repo=repo, path=path, request=request, reason=reason)
    con.commit()


def decide_report(runner: Runner, report_id: int, accept: bool, message: str = "") -> str:
    """A removal request decided by the owner: accepted, what it names leaves every public output at
    the next nightly, the whole record (`article.withdrawn`), or only the copies of its scripts, of
    one repository, of one file, or its tracing map (`withhold`); or rejected. The owner's words go
    to the requester's page."""
    rows = runner.d1.query(f"SELECT * FROM reports WHERE id = {int(report_id)}")
    if not rows:
        raise SystemExit(f"no request {report_id} in the {runner.target} database")
    r = rows[0]
    # A request the moderator's rules closed (no one reviewed it in time) may still be accepted.
    overridden = accept and r["status"] == "rejected" and moderation.decided_by_rules(runner.state, runner.target, "report",
                                                                                     int(report_id))
    if r["status"] != "open" and not overridden:
        _settled(runner, ("report",), report_id, f"already {r['status']}")
        return f"request {report_id} is already {r['status']}"
    t = _stamp(runner)
    scope = r.get("scope") or "record"
    if accept:
        known = _paper(runner.con, r["target_id"]) is not None
        moderation.apply_removal(runner, r)
        if not known:
            runner.report(f"  {r['target_id']} is not in this database: nothing to withdraw on the Mac")
    _write(runner, [f"UPDATE reports SET status = {literal('accepted' if accept else 'rejected')}, "
                    f"message = {literal(words(message))}, decided_at = {t} WHERE id = {int(report_id)} "
                    f"AND status = {literal(r['status'])}"])
    _settled(runner, ("report",), report_id, "accepted" if accept else "rejected")
    moderation.unwait(runner.state, runner.target, "report", int(report_id))
    moderation.log(runner.state, runner.target, "report", int(report_id), "owner", "accepted" if accept else "rejected",
                   user_id=r["user_id"], paper=r["target_id"], detail={"scope": scope, "message": message}, now=runner.now())
    what = SCOPES.get(scope, scope) + (f" ({_target(r)})" if scope in ("repository", "file") else "")
    return (f"request {report_id} on {r['target_id']}: "
            + (f"accepted, {what} leaves the site at the next nightly" if accept else "rejected"))


def _target(d: dict[str, Any]) -> str:
    """The repository, or the file in its repository, a removal request names."""
    repo = d.get("scope_repo", d.get("repo")) or ""
    path = d.get("scope_path", d.get("path")) or ""
    return f"{repo}: {path}" if path else repo


def decide_submission(runner: Runner, submission_id: int, accept: bool, message: str = "") -> str:
    """A draft published by someone who is not among the paper's authors: the owner publishes it
    or refuses it, one the moderator's rules refused included (the owner overrides them)."""
    rows = runner.d1.query(f"SELECT * FROM submissions WHERE id = {int(submission_id)}")
    if not rows:
        raise SystemExit(f"no submission {submission_id} in the {runner.target} database")
    s = rows[0]
    overridden = accept and s["status"] == "refused" and moderation.decided_by_rules(runner.state, runner.target, "submission",
                                                                                    int(submission_id))
    if s["status"] != "moderation" and not overridden:
        _settled(runner, ("publish",), submission_id, f"already {s['status']}")
        return f"submission {submission_id} is {s['status']}, not waiting for the owner"
    t = _stamp(runner)
    if accept:
        user = _users(runner.d1, {s["user_id"]}).get(s["user_id"])
        status, said = apply_submission(runner, s, user)
        said = f"{said} {message}".strip()
    else:
        status, said = "refused", message or "The owner did not publish this submission."
    _write(runner, [f"UPDATE submissions SET status = {literal(status)}, message = {literal(words(said))}, "
                    f"updated_at = {t} WHERE id = {int(submission_id)} AND status = {literal(s['status'])}"])
    _settled(runner, ("publish",), submission_id, status)
    moderation.unwait(runner.state, runner.target, "submission", int(submission_id))
    moderation.log(runner.state, runner.target, "submission", int(submission_id), "owner", status, user_id=s["user_id"],
                   paper=s["paper_id"], detail={"message": message}, now=runner.now())
    return f"submission {submission_id} ({s['doi']}): {status}"


def status(state: sqlite3.Connection, now: float | None = None) -> str:
    now = now or time.time()
    lines = []
    for r in state.execute("SELECT target, last_id FROM job_cursor ORDER BY target"):
        lines.append(f"{r['target']}: jobs read up to {r['last_id']}")
    for r in state.execute("SELECT target, kind, status, COUNT(*) AS n FROM job GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"):
        lines.append(f"{r['target']}: {r['kind']} {r['status']}: {r['n']}")
    for r in state.execute("SELECT target, day, rows FROM community_budget ORDER BY day DESC, target LIMIT 4"):
        lines.append(f"{r['target']}: {r['rows']} rows written on {r['day']} (UTC), jobs and facts together")
    moderation.ensure_schema(state)
    for r in state.execute("SELECT target, rule, decision, COUNT(*) AS n FROM moderation_log WHERE at > ? GROUP BY 1, 2, 3 "
                           "ORDER BY 1, 2, 3", (now - moderation.DAY,)):
        lines.append(f"{r['target']}: the moderator's rules in the last 24 hours: {r['rule']} → {r['decision']}: {r['n']}")
    never = ", ".join(literal(r) for r in moderation.NEVER_CLOSE)
    for r in state.execute(f"SELECT target, kind, COUNT(*) AS n, MIN(due) AS due FROM waits WHERE rule NOT IN ({never}) "
                           "GROUP BY 1, 2 ORDER BY 1, 2"):
        lines.append(f"{r['target']}: {r['n']} {r['kind']}(s) waiting, the first closes on {moderation.deadline_words(r['due'])}")
    # What only the operator can answer, about personal data: the GDPR's one month, never closed by the rules.
    legal: dict[str, list[float]] = {}
    for r in state.execute(f"SELECT target, due FROM waits WHERE rule IN ({never})"):
        legal.setdefault(r["target"], []).append(float(r["due"]))
    for r in state.execute("SELECT target, detail FROM job WHERE kind = 'rights' AND status = 'owner'"):
        legal.setdefault(r["target"], []).append(float(json.loads(r["detail"] or "{}").get("due") or 0))
    for target, dues in sorted(legal.items()):
        late = sum(1 for d in dues if d and d < now)
        lines.append(f"{target}: {len(dues)} request(s) about personal data wait for you (GDPR: one month), the first to "
                     f"answer by {moderation.deadline_words(min(dues))}" + (f", {late} OVERDUE" if late else ""))
    return "\n".join(lines) or "no job read yet"


def describe_waiting(items: list[dict[str, Any]], now: float | None = None) -> str:
    """The owner's list, one request per paragraph."""
    now = now or time.time()
    if not items:
        return "nothing waits for you"
    out = []
    for j in items:
        d, who = j["detail"], j["detail"].get("user", {})
        person = ", ".join(x for x in (who.get("name"), who.get("orcid") and f"ORCID {who['orcid']}",
                                       who.get("github") and f"GitHub {who['github']}") if x) or j["user_id"]
        when = time.strftime("%Y-%m-%d %H:%M", time.gmtime(j["created_at"]))
        if j["kind"] == "claim":
            what = f"claim {d['claim']}: {person} as {'author of ' + d['paper_id'] if d['kind'] == 'author' else 'maintainer of ' + d['repo']}"
            said = [d.get("statement", ""), d.get("link", ""), d.get("via") and f"({d['via']})"]
        elif j["kind"] == "report":
            scope = d.get("scope") or "record"
            target = f" ({_target(d)})" if scope in ("repository", "file") else ""
            role = f", as {REQUESTERS.get(d['role'], d['role'])}" if d.get("role") else ""
            verified = " (verified: their ORCID iD is among the paper's authors)" if d.get("author_verified") else ""
            what = (f"request {d['report']}: remove {SCOPES.get(scope, scope)}{target} of {d['paper_id']} ({d['reason']}), "
                    f"from {person}{role}{verified}")
            said = [d.get("details", ""), d.get("evidence_url") and f"evidence: {d['evidence_url']}",
                    "confirmed: the information is accurate, and they read how requests are decided" if d.get("confirmed") else ""]
        else:
            what = f"submission {d['submission']}: {d['doi']} ({d.get('paper_id') or 'not read'}), from {person}"
            said = [", ".join(d.get("code_urls", [])), d.get("note", "")]
        due = d.get("due")
        rule = d.get("rule")
        if d.get("legal") and due:
            late = ", OVERDUE" if due < now else ""
            said.append(f"about personal data: answer it by {moderation.deadline_words(due)} (GDPR: one month); the rules "
                        f"never close it{late}")
        else:
            said.append(f"the rules ({rule}) close it by themselves on {moderation.deadline_words(due)}" if due else "")
        if d.get("guard"):
            said.append(f"not hidden at once: {d['guard']}")
        out.append(f"{what}, {when} UTC\n" + "".join(f"    {x}\n" for x in said if x))
    return "\n".join(out).rstrip()
