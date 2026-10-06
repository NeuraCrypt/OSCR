"""The GitHub side (night phase 01), on the Mac: the forge jobs and the polling of public mirrors
(docs/FORGE.md, "The Mac's jobs").

The Worker records in the D1 forge database (`oscr_forge`) what the Mac must look at, with a row
in `jobs`. The Mac polls `jobs` (the rows after the last one it saw: `WHERE id > ?`, the rowid's
own order, no index), does the work here, and answers each job in its own row (`done_at`,
`outcome`, `message`: one row written), which the repository's page shows:

- `link`: a repository just created or linked. The forge says it by its durable id
  (`repo_by_id`: public, its default branch, its head); then each paper it is linked to that the
  catalogue knows gets it as a code link through Phase 6's own path (`jobs.apply_changes`, with the
  linker's role as its provenance: `author` or `maintainer`, from D1 community's roles or the
  paper's own list of authors). The harvester's verification, license reading, script copies
  (only verified licenses leave the Mac, oscr/scriptstore.py) and alignment follow, as for a
  submission. A paper only `proposed` (the linker is neither an author nor a maintainer) is left
  for the paper's authors;
- `push`: a push to a repository with traced paths or script copies. Its head is read again (the
  harvester verifies it again when it moved), and every commit a tracing map is pinned to is
  checked: still at the source, or not (kept in the state, `forge_commit`, for the static layer);
- `archive`: a Software Heritage "Save Code Now" request for the repository's address, only
  because a person asked for it (D00-15, D01-7), and Software Heritage's answer, recorded (night
  phase 07: a release's request names its tag in `ref`; the save takes the repository's tags with it);
- `release` (night phase 07): a release tied to a version of a paper was published. The paper's
  tracing map is versioned with it: the map as the Mac holds it now (`zenodo.map_of`, links and
  metadata, never the paper's text nor the code) is frozen for (the repository, the tag, the paper),
  with the release's commit and the commit the map's lines are at, in the state (`forge_map_version`),
  and its digest answered into the tie (`release_papers.map_digest`, one row), the static layer
  (oscr/forgelayer.py) shows it on the release's page;
- `deposit` (night phase 07): the release's tracing map deposited on Zenodo, because a verified
  author of the paper asked for it with their ORCID iD (CLAUDE.md: a DOI only for a map an author
  validated; never the code, which the record references). The role and the ORCID iD are read again
  from oscr_community, the map's digest must still be the one the author saw, then Phase 6's own
  `zenodo.validate` and `zenodo.deposit_map`, with the release (its tag as the version, its commit
  referenced), on Zenodo's sandbox unless the settings say `OSCR_ZENODO_INSTANCE=zenodo`. A deposit
  from ORCID's sandbox (`proof`) is a test, which only Zenodo's sandbox takes;
- `delete_due`: nothing before `not_before`; then a repository still waiting for its deletion
  is hidden (D01-8). The deletion on GitHub stays the researcher's own act (D00-10); the dashboard
  shows the due date (in-site notifications come with phase 08);
- `reconcile`: the repository followed by its id through renames and transfers (its `owner_login`
  and `name`); one the forge no longer has is `gone`, one no longer public is hidden (D00-14).

**Mirrors.** `mirrors` reads the heads of the `public` repositories (and of the `installed` ones
not heard from in a week) by conditional requests, their ETags kept in the state (a 304 costs no
quota and writes nothing), or by `git ls-remote` when the REST quota is spent; one row written per
changed head.

**What it never does.** Read-only toward the forges (oscr/forge.py readers, with the Mac's own
read-only token; git hardened as forge.py does it: `forge.GIT_FLAGS`, `forge.git_env`): never a
user token, never the GitHub App's key, never users' code (nothing is built, installed or run;
this module reads no file at all: the harvester's verification does, as for every repository).
No email address goes into a row: messages go through `jobs.words`, and the schema refuses an at
sign in `jobs.message`.

**State.** `data/community/state.db`, with the facts push's and the community jobs': each forge
job's status and attempts (`forge_job`), the last one seen per target (`forge_cursor`), the heads'
ETags (`forge_etag`), the pinned commits checked (`forge_commit`) and Software Heritage's answers
(`forge_archive`). The rows written count in the facts push's daily budget (`community.spend`:
10,000 by default for everything the Mac writes to D1), and a job that failed MAX_ATTEMPTS times
is given up, as oscr/jobs.py does.

**Cost in D1.** A poll reads the new jobs and, per job, its repository and its papers, by key; a
job's answer writes one row (two when a repository is renamed, hidden or gone). The mirrors read
the repositories the jobs named (each repository OSCR knows came with a `link` job), by key, 100
per query, never a pass over `repos`, and write one row per changed head.

    oscr forge poll --local|--remote      the forge jobs
    oscr forge mirrors --local|--remote   the public mirrors' heads
    oscr forge status                     what was done, the rows written today
    oscr jobs poll --remote               also polls the forge jobs when OSCR_FORGE_PUSH=remote
    oscr nightly                          calls `mirrors` when OSCR_FORGE_PUSH=remote
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, overload
from urllib.parse import quote, urlsplit

import httpx

from . import community, jobs, links, net, zenodo
from . import forge as forges
from .community import D1, literal
from .forge import ForgeError, ForgeReader, RepoInfo, RepoKey, RepoRef

#: The actions of `oscr forge` this module answers.
ACTIONS: tuple[str, ...] = ("poll", "mirrors", "status")
#: The kinds of `oscr_forge.jobs` (the migration's CHECK).
KINDS: tuple[str, ...] = ("link", "push", "archive", "delete_due", "reconcile", "release", "deposit")
#: A job that failed this many times is given up, and the person told (as oscr/jobs.py).
MAX_ATTEMPTS = jobs.MAX_ATTEMPTS
#: Jobs read per poll.
BATCH = 100
#: Rows the Mac writes to D1 a day, everything together (the facts push's budget).
DAILY_BUDGET = community.DAILY_BUDGET
#: An `installed` repository not heard from (webhooks) for this long is polled like a public one.
QUIET_S = 7 * 86400
#: Rows a job may write at most (a rename: the repository, its index entry, the answer), kept in
#: hand before it starts.
JOB_ROWS = 4
#: Software Heritage's "Save Code Now" for a git origin (anonymous; D00-15).
SWH_SAVE = "https://archive.softwareheritage.org/api/1/origin/save/git/url/{url}/"
#: What a repository's state means, for the person.
STATE_WORDS: dict[str, str] = {
    "active": "active", "archived": "archived", "pending_deletion": "waiting for its deletion",
    "hidden": "hidden from OSCR", "deleted": "deleted", "gone": "no longer on the forge",
}

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS forge_job (
    target      TEXT NOT NULL,              -- local | remote
    id          INTEGER NOT NULL,           -- oscr_forge jobs.id
    kind        TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    ref         TEXT NOT NULL DEFAULT '',
    user_id     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    not_before  INTEGER,
    status      TEXT NOT NULL DEFAULT 'new',   -- new | done | skipped | failed
    attempts    INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    updated_at  REAL NOT NULL,
    paper_id    TEXT NOT NULL DEFAULT '',      -- phase 07: a release's or a deposit's paper
    proof       TEXT NOT NULL DEFAULT '',      -- phase 07: a deposit's ORCID (orcid | orcid-sandbox)
    PRIMARY KEY (target, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_cursor (
    target   TEXT PRIMARY KEY,
    last_id  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS forge_repo (
    target      TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,              -- a repository some job named: the mirrors read it by key
    learned_at  REAL NOT NULL,
    PRIMARY KEY (target, forge, repo_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_etag (
    target      TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    branch      TEXT NOT NULL,
    sha         TEXT NOT NULL,
    etag        TEXT NOT NULL DEFAULT '',
    checked_at  REAL NOT NULL,
    PRIMARY KEY (target, forge, repo_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_commit (
    target      TEXT NOT NULL,
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    sha         TEXT NOT NULL,
    reachable   INTEGER NOT NULL,           -- 1: still at the source; 0: no longer
    checked_at  REAL NOT NULL,
    PRIMARY KEY (target, forge, repo_id, sha)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_map_version (
    target       TEXT NOT NULL,
    forge        TEXT NOT NULL,
    repo_id      TEXT NOT NULL,
    tag          TEXT NOT NULL,             -- the release's tag
    paper_id     TEXT NOT NULL,
    release_commit TEXT NOT NULL DEFAULT '',   -- the commit the tag names
    map_commit   TEXT NOT NULL DEFAULT '',  -- the commit the map's lines of this repository are at
    digest       TEXT NOT NULL,             -- zenodo.map_digest of the frozen map
    pairs        INTEGER NOT NULL DEFAULT 0,   -- its paragraph ↔ lines pairs in this repository
    card         TEXT NOT NULL,             -- the frozen map (links and metadata: no paper text, no code)
    frozen_at    REAL NOT NULL,
    instance     TEXT NOT NULL DEFAULT '',  -- a deposit's Zenodo instance (sandbox | zenodo)
    doi          TEXT NOT NULL DEFAULT '',
    record_url   TEXT NOT NULL DEFAULT '',
    deposited_at REAL,
    PRIMARY KEY (target, forge, repo_id, tag, paper_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forge_archive (
    target          TEXT NOT NULL,
    job_id          INTEGER NOT NULL,
    forge           TEXT NOT NULL,
    repo_id         TEXT NOT NULL,
    url             TEXT NOT NULL,
    at              REAL NOT NULL,
    http_status     INTEGER NOT NULL,
    request_status  TEXT NOT NULL DEFAULT '',
    task_status     TEXT NOT NULL DEFAULT '',
    request_id      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (target, job_id)
) WITHOUT ROWID;
"""


class NotBuilt(RuntimeError):
    """Kept from the foundation's stub; nothing raises it since element E9 was built."""


def open_state(path: Any) -> sqlite3.Connection:
    """The facts push's state file, with the community jobs' tables and the forge's (a state made
    before night phase 07 gains its two columns)."""
    state = jobs.open_state(path)
    state.executescript(STATE_SCHEMA)
    have = {r[1] for r in state.execute("PRAGMA table_info(forge_job)")}
    for column in ("paper_id", "proof"):
        if column not in have:
            state.execute(f"ALTER TABLE forge_job ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
    state.commit()
    return state


def words(text: str, most: int = 300) -> str:
    """A message for a person, as D1 takes it: no contact detail, no at sign, 300 characters."""
    return jobs.words(text, most)


# ---------------------------------------------------------------------------------------
# The runner.

@dataclass
class Outcome:
    """What a job ends in: `done`, `skipped` (nothing to do), `failed` (given up or refused),
    `retry` (the Mac could not do it now), `wait` (a grace period not over). `sql`: what D1 is
    told besides the job's answer."""
    status: str
    sql: list[str] = field(default_factory=list)
    message: str = ""
    #: Whether a `retry` counts as an attempt: not when a quota is spent.
    counts: bool = True


def _swh_post(client: net.Client) -> Callable[[str], net.Response]:
    """One anonymous POST to Software Heritage with the Mac's network client (its pause between
    requests to a host, its User-Agent, no token: `net.Client` sends GitHub's token to
    api.github.com only), its answer kept: `Client.get` drops the body of anything but a GET."""
    def post(url: str) -> net.Response:
        if client.offline:
            return net.Response(url=url, status=0, text="")
        host = urlsplit(url).hostname or ""
        client._wait(host, url)
        client.requests[host] = client.requests.get(host, 0) + 1
        try:
            r = client._http.request("POST", url, headers=client._headers(host))
        except httpx.TransportError:
            return net.Response(url=url, status=0, text="")
        return net.Response(url=str(r.url), status=r.status_code, text=r.text[:100_000],
                            headers={k.lower(): v for k, v in r.headers.items()})
    return post


@dataclass
class Runner:
    #: The harvester's database (the catalogue).
    con: sqlite3.Connection
    #: D1 `oscr_forge`.
    d1: D1
    state: sqlite3.Connection
    harvester: jobs.Harvester
    #: D1 `oscr_community`, for the linker's roles and public handles; None: roles are not
    #: confirmed, and nothing is applied to the papers.
    community: D1 | None = None
    #: The read-only reader of a forge (forge.reader; tests: a MemoryReader).
    readers: Callable[[str], ForgeReader] = forges.reader
    #: A POST to Software Heritage (the network client; tests: a fake). None: no archive request.
    post: Callable[[str], net.Response] | None = None
    #: How git runs (`git ls-remote` only; tests: a fake).
    git: Callable[..., subprocess.CompletedProcess] = subprocess.run
    #: Rows written a day, the facts push's and the community jobs' included.
    budget: int = DAILY_BUDGET
    report: Callable[[str], None] = print
    now: Callable[[], float] = time.time
    #: The Zenodo instance of a release's deposit: the sandbox while the platform is built
    #: (CLAUDE.md); `OSCR_ZENODO_INSTANCE=zenodo` in the settings for the real one.
    instance: str = "sandbox"
    zenodo_community: str = "oscr"
    platform: str = "Open Scientific Code Registry (OSCR)"
    #: Zenodo's client for an instance, with the Mac's token for it (keychain; tests: a fake).
    invenio: Callable[[str], zenodo.Invenio] = lambda instance: zenodo.Invenio(instance, api_token=zenodo.token(instance))
    _readers: dict[str, ForgeReader] = field(default_factory=dict, repr=False)

    @property
    def target(self) -> str:
        return self.d1.target

    def budget_left(self) -> int:
        return self.budget - community.budget_spent(self.state, self.target, community.utc_day(self.now()))

    def reader(self, forge: str) -> ForgeReader:
        if forge not in self._readers:
            self._readers[forge] = self.readers(forge)
        return self._readers[forge]

    def phase6(self) -> jobs.Runner:
        """The community job runner's view, for Phase 6's path (`jobs.apply_changes`)."""
        return jobs.Runner(self.con, self.community or self.d1, self.state, self.harvester, budget=self.budget,
                           report=self.report, now=self.now)


def _t(runner: Runner) -> int:
    return int(runner.now())


def _write(runner: Runner, sql: list[str]) -> int:
    if not sql:
        return 0
    rows = runner.d1.run(sql)
    community.spend(runner.state, runner.target, rows, now=runner.now())
    return rows


def _where(forge: str, repo_id: str) -> str:
    return f"forge = {literal(forge)} AND repo_id = {literal(repo_id)}"


def _repo(runner: Runner, forge: str, repo_id: str) -> dict[str, Any] | None:
    rows = runner.d1.query("SELECT forge, repo_id, owner_login, name, mode, state, default_branch, head, head_at, "
                           f"delete_after, linked_by, updated_at FROM repos WHERE {_where(forge, repo_id)}")
    return rows[0] if rows else None


def _path(row: dict[str, Any]) -> str:
    return f"{row['owner_login']}/{row['name']}"


def _short(sha: str | None) -> str:
    return (sha or "")[:12]


def _unknown() -> Outcome:
    return Outcome("skipped", message="OSCR does not know this repository (its link was undone).")


# ---------------------------------------------------------------------------------------
# Renames, transfers, vanished repositories (`reconcile`, and the mirrors when a path fails).

def follow(runner: Runner, row: dict[str, Any]) -> tuple[list[str], str, RepoInfo | None]:
    """The repository asked by its id: (what D1 is told, in words, what the forge says). A rename
    or a transfer moves its path; one the forge no longer has is `gone`; one no longer public is
    hidden, its name blanked (D00-14)."""
    t = _t(runner)
    where = _where(row["forge"], row["repo_id"])
    try:
        info = runner.reader(row["forge"]).repo_by_id(RepoKey(row["forge"], row["repo_id"]))
    except ForgeError as e:
        if e.code not in ("not_found", "gone"):
            raise
        return ([f"UPDATE repos SET state = 'gone', updated_at = {t} WHERE {where} AND state NOT IN ('gone', 'deleted')"],
                f"The forge no longer has {_path(row)}: OSCR marks it gone. Its tracing maps keep their licensed "
                f"script copies.", None)
    if info.visibility != "public":
        return ([f"UPDATE repos SET state = 'hidden', owner_login = '', name = '', updated_at = {t} WHERE {where} "
                 f"AND state != 'hidden'"],
                "The repository is no longer public: it leaves OSCR (hidden).", None)
    owner, name = info.ref.owner.lower(), info.ref.name.lower()
    sets, said = [], []
    if (owner, name) != (row["owner_login"], row["name"]):
        sets += [f"owner_login = {literal(owner)}", f"name = {literal(name)}"]
        said.append(f"{_path(row)} is now {owner}/{name}")
    if info.default_branch != row["default_branch"]:
        sets.append(f"default_branch = {literal(info.default_branch)}")
        said.append(f"its default branch is {info.default_branch or 'none (empty)'}")
    if not sets:
        return [], f"{_path(row)}: unchanged.", info
    return ([f"UPDATE repos SET {', '.join(sets)}, updated_at = {t} WHERE {where} AND state != 'hidden'"],
            "Followed by its id: " + "; ".join(said) + ".", info)


def run_reconcile(runner: Runner, job: dict[str, Any]) -> Outcome:
    row = _repo(runner, job["forge"], job["repo_id"])
    if row is None:
        return _unknown()
    if row["state"] in ("hidden", "deleted", "gone"):
        return Outcome("skipped", message=f"The repository is {STATE_WORDS[row['state']]}: nothing to follow.")
    sql, said, _ = follow(runner, row)
    return Outcome("done", sql, said)


# ---------------------------------------------------------------------------------------
# A repository linked or created: its papers get it through Phase 6's path.

def _roles(runner: Runner, papers: list[dict[str, Any]], repo_key: str) -> dict[tuple[str, str], tuple[str, str]]:
    """(user, paper) → (the provenance's source, who), for the papers the linker may attach it
    to: `author` (a verified author of the paper in D1 community, or their ORCID iD among the
    paper's authors on the Mac), `maintainer` (of the repository). Public handles only."""
    ids = sorted({p["by_user"] for p in papers if p["by_user"]})
    if not ids or runner.community is None:
        return {}
    listed = ", ".join(literal(i) for i in ids)
    users = {r["id"]: r for r in runner.community.query(
        f"SELECT id, display_name, orcid, github_login FROM users WHERE id IN ({listed})")}
    held = {(r["user_id"], r["role"], r["scope_id"]) for r in runner.community.query(
        f"SELECT user_id, role, scope_id FROM roles WHERE user_id IN ({listed}) "
        f"AND role IN ('verified_author', 'maintainer')")}
    out: dict[tuple[str, str], tuple[str, str]] = {}
    for p in papers:
        uid, pid = p["by_user"], p["paper_id"]
        user = users.get(uid)
        if user is None:
            continue
        orcid = user.get("orcid") or ""
        if (uid, "verified_author", pid) in held or (orcid and runner.con.execute(
                "SELECT 1 FROM paper_author WHERE article_id = ? AND orcid = ?", (pid, orcid)).fetchone()):
            out[(uid, pid)] = ("author", jobs.actor(user))
        elif (uid, "maintainer", repo_key) in held:
            out[(uid, pid)] = ("maintainer", jobs.actor(user))
    return out


def _aside(a: sqlite3.Row | None) -> str:
    """Why a paper cannot take the link, in a few words; "" when it can."""
    if a is None:
        return "not in the registry"
    if a["withdrawn"]:
        return "removed from the site"
    if a["on_topic"] == "no":
        return "outside the registry's scope"
    return ""


def run_link(runner: Runner, job: dict[str, Any]) -> Outcome:
    row = _repo(runner, job["forge"], job["repo_id"])
    if row is None:
        return _unknown()
    if row["state"] not in ("active", "archived"):
        return Outcome("skipped", message=f"The repository is {STATE_WORDS[row['state']]}: nothing to verify.")
    reader = runner.reader(row["forge"])
    try:
        info = reader.repo_by_id(RepoKey(row["forge"], row["repo_id"]))
    except ForgeError as e:
        if e.code in ("not_found", "gone"):
            return Outcome("failed", message="The forge does not show this repository (deleted, or not public).")
        raise
    if info.visibility != "public":
        return Outcome("failed", message="The repository is not public: OSCR keeps public repositories only.")
    head = None
    if info.default_branch:
        try:
            head = reader.head(info.ref, info.default_branch)
        except ForgeError as e:
            if e.code != "not_found":
                raise
    link = links.normalize(info.web_url)
    if link is None or link.kind != "forge":
        return Outcome("failed", message="The registry does not read links to this forge yet.")
    papers = runner.d1.query(f"SELECT paper_id, status, by_user FROM repo_papers WHERE "
                             f"{_where(row['forge'], row['repo_id'])} ORDER BY paper_id")
    sources = _roles(runner, [p for p in papers if p["status"] == "linked"], link.repo)
    con, phase6 = runner.con, runner.phase6()
    added, already, aside = [], [], []
    for p in papers:
        pid = p["paper_id"]
        if p["status"] != "linked":
            aside.append(f"{pid} (proposed: for its authors)")
            continue
        why = _aside(con.execute("SELECT withdrawn, on_topic FROM article WHERE id = ?", (pid,)).fetchone())
        if why:
            aside.append(f"{pid} ({why})")
            continue
        source = sources.get((p["by_user"], pid))
        if source is None:
            aside.append(f"{pid} (the linker's role is not confirmed)")
            continue
        current = con.execute("SELECT role FROM link WHERE article_id = ? AND repo = ?", (pid, link.repo)).fetchone()
        if current is not None and current["role"] == "code":
            already.append(pid)
            if not con.execute("SELECT 1 FROM repository WHERE repo = ? AND verified_at IS NOT NULL",
                               (link.repo,)).fetchone():
                runner.harvester.verify(con, link, pid)   # an earlier attempt stopped before it
            continue
        change = ({"op": "add", "url": link.url, "role": "code"} if current is None
                  else {"op": "role", "repo": link.repo, "role": "code"})
        version, applied, _ = jobs.apply_changes(phase6, pid, [change], source=source[0], who=source[1],
                                                 ref=f"forge-job:{job['id']}")
        if applied:
            runner.harvester.align(con, pid, save=True)
            added.append(pid)
    state = f"at {_short(head.sha)} on {head.branch}" if head else "empty for now"
    said = [f"Verified {info.ref.owner}/{info.ref.name} ({state})."]
    if added:
        said.append(f"Added as code to {', '.join(added)}; the site shows it after its next update.")
    if already:
        said.append(f"Already on {', '.join(already)}.")
    if aside:
        said.append(f"Left aside: {', '.join(aside)}.")
    if not papers:
        said.append("No paper is attached to it yet.")
    return Outcome("done", message=" ".join(said))


# ---------------------------------------------------------------------------------------
# A push: the head again, and the commits the maps are pinned to.

def commits(state: sqlite3.Connection, target: str, forge: str, repo_id: str) -> dict[str, bool]:
    """The pinned commits last checked: sha → still at the source (for the static layer)."""
    return {r["sha"]: bool(r["reachable"]) for r in state.execute(
        "SELECT sha, reachable FROM forge_commit WHERE target = ? AND forge = ? AND repo_id = ?", (target, forge, repo_id))}


def run_push(runner: Runner, job: dict[str, Any]) -> Outcome:
    row = _repo(runner, job["forge"], job["repo_id"])
    if row is None:
        return _unknown()
    if row["state"] not in ("active", "archived"):
        return Outcome("skipped", message=f"The repository is {STATE_WORDS[row['state']]}: nothing to check.")
    reader = runner.reader(row["forge"])
    try:
        info = reader.repo_by_id(RepoKey(row["forge"], row["repo_id"]))
    except ForgeError as e:
        if e.code in ("not_found", "gone"):
            return Outcome("skipped", message="The forge does not show this repository: it will be followed by its id.")
        raise
    link = links.normalize(info.web_url)
    key = link.repo if link else ""
    pinned = sorted({r["commit_sha"] for r in runner.d1.query(
        f"SELECT DISTINCT commit_sha FROM traced_paths WHERE {_where(row['forge'], row['repo_id'])}")})
    known = runner.con.execute("SELECT commit_id FROM repository WHERE repo = ?", (key,)).fetchone() if key else None
    copies = bool(key and runner.con.execute("SELECT 1 FROM file WHERE repo = ? AND text IS NOT NULL LIMIT 1",
                                             (key,)).fetchone())
    if not pinned and not copies:
        return Outcome("skipped", message="No tracing map or script copy points to this repository: nothing to check.")
    head = reader.head(info.ref, info.default_branch) if info.default_branch else None
    now = runner.now()
    gone = []
    for sha in pinned:
        there = reader.has_commit(info.ref, sha)
        runner.state.execute("INSERT OR REPLACE INTO forge_commit (target, forge, repo_id, sha, reachable, checked_at) "
                             "VALUES (?,?,?,?,?,?)", (runner.target, row["forge"], row["repo_id"], sha, int(there), now))
        if not there:
            gone.append(_short(sha))
    runner.state.commit()
    said = [f"Head {_short(head.sha)} on {head.branch}." if head else "The repository is empty."]
    if link and known is not None and head and known["commit_id"] != head.sha:
        article = runner.con.execute("SELECT article_id FROM link WHERE repo = ? ORDER BY article_id LIMIT 1",
                                     (key,)).fetchone()
        if article is not None:
            runner.harvester.verify(runner.con, link, article["article_id"])
            said.append("Verified again at its new head.")
    if pinned:
        said.append(f"{len(pinned) - len(gone)} of {len(pinned)} pinned commit(s) still at the source"
                    + (f"; no longer at the source: {', '.join(gone)}" if gone else "") + ".")
    return Outcome("done", message=" ".join(said))


# ---------------------------------------------------------------------------------------
# Software Heritage, on a person's request only (D00-15).

def swh_url(origin: str) -> str:
    return SWH_SAVE.format(url=quote(origin, safe=":/"))


def run_archive(runner: Runner, job: dict[str, Any]) -> Outcome:
    row = _repo(runner, job["forge"], job["repo_id"])
    if row is None:
        return _unknown()
    if row["state"] in ("hidden", "deleted", "gone"):
        return Outcome("skipped", message=f"The repository is {STATE_WORDS[row['state']]}: nothing to archive.")
    if runner.post is None:
        return Outcome("retry", message="this Mac sends no request to Software Heritage", counts=False)
    try:
        info = runner.reader(row["forge"]).repo_by_id(RepoKey(row["forge"], row["repo_id"]))
    except ForgeError as e:
        if e.code in ("not_found", "gone"):
            return Outcome("failed", message="The forge does not show this repository: Software Heritage cannot save it.")
        raise
    if info.visibility != "public":
        return Outcome("failed", message="The repository is not public: Software Heritage saves public code only.")
    r = runner.post(swh_url(info.web_url))
    if r.status == 0 or r.status == 429 or r.status >= 500:
        return Outcome("retry", message=f"Software Heritage did not take the request now ({r.status})",
                       counts=r.status != 429)
    try:
        answer = r.json() if r.text else {}
    except ValueError:
        answer = {}
    answer = answer if isinstance(answer, dict) else {}
    request, task = str(answer.get("save_request_status") or ""), str(answer.get("save_task_status") or "")
    ident = str(answer.get("id") or "")
    runner.state.execute("INSERT OR REPLACE INTO forge_archive (target, job_id, forge, repo_id, url, at, http_status, "
                         "request_status, task_status, request_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (runner.target, int(job["id"]), row["forge"], row["repo_id"], info.web_url, runner.now(),
                          r.status, request[:40], task[:40], ident[:40]))
    runner.state.commit()
    if not r.ok or request == "rejected":
        return Outcome("failed", message=f"Software Heritage refused to save {info.ref.owner}/{info.ref.name} "
                                         f"({request or r.status}).")
    detail = ", ".join(x for x in (request, task and f"task {task}", ident and f"request {ident}") if x)
    tag = f", its tag {job['ref']} with it" if job.get("ref") else ""
    return Outcome("done", message=f"Software Heritage took the request to save {info.ref.owner}/{info.ref.name}{tag}"
                                   + (f" ({detail})" if detail else "") + ".")


# ---------------------------------------------------------------------------------------
# The end of a grace period (D01-8).

def run_delete_due(runner: Runner, job: dict[str, Any]) -> Outcome:
    t = _t(runner)
    if job["not_before"] is not None and t < int(job["not_before"]):
        return Outcome("wait")
    row = _repo(runner, job["forge"], job["repo_id"])
    if row is None:
        return _unknown()
    if row["state"] != "pending_deletion":
        return Outcome("skipped", message="Restored before the end of its grace period: nothing to do.")
    if row["delete_after"] is not None and int(row["delete_after"]) > t:
        return Outcome("skipped", message="A later deletion request sets another date: this one is over.")
    return Outcome("done", [f"UPDATE repos SET state = 'hidden', updated_at = {t} WHERE "
                            f"{_where(row['forge'], row['repo_id'])} AND state = 'pending_deletion' "
                            f"AND (delete_after IS NULL OR delete_after <= {t})"],
                   message="The grace period ended: the repository is hidden from OSCR. Deleting it on GitHub stays "
                           "your own act, from its page.")


# ---------------------------------------------------------------------------------------
# Releases (night phase 07): the tracing map versioned with a release; its Zenodo deposit.

def _tie(runner: Runner, job: dict[str, Any]) -> dict[str, Any] | None:
    """The release's tie to the job's paper (release_papers, by its key), or None."""
    rows = runner.d1.query(f"SELECT * FROM release_papers WHERE {_where(job['forge'], job['repo_id'])} "
                           f"AND tag = {literal(job['ref'])} AND paper_id = {literal(job.get('paper_id') or '')}")
    return rows[0] if rows else None


def _frozen(card: dict[str, Any], tie: dict[str, Any]) -> tuple[str, int]:
    """The commit the map's lines of the tied repository are at, and how many pairs point there."""
    repo = f"github.com/{tie['repo_path']}".lower()
    commit = next((c.get("commit") or "" for c in card.get("code") or [] if str(c.get("repo", "")).lower() == repo), "")
    pairs = sum(1 for a in card.get("alignments") or [] if str(a.get("repo", "")).lower() == repo)
    return commit, pairs


def _release_block(tie: dict[str, Any], forge: str) -> dict[str, Any]:
    """What the frozen map says of the release it goes with (its repository's address, never a person)."""
    return {"repo": f"https://github.com/{tie['repo_path']}" if forge in ("github", "memory") else tie["repo_path"],
            "tag": tie["tag"], "commit": tie.get("commit_sha") or "", "version": tie.get("version") or "",
            "label": tie.get("label") or ""}


def _keep_version(runner: Runner, job: dict[str, Any], tie: dict[str, Any], card: dict[str, Any], digest: str,
                  **deposit: Any) -> None:
    map_commit, pairs = _frozen(card, tie)
    frozen = {**card, "release": _release_block(tie, job["forge"])}
    old = runner.state.execute("SELECT * FROM forge_map_version WHERE target = ? AND forge = ? AND repo_id = ? AND tag = ? "
                               "AND paper_id = ?", (runner.target, job["forge"], job["repo_id"], job["ref"],
                                                    tie["paper_id"])).fetchone()
    kept = {k: old[k] for k in ("instance", "doi", "record_url", "deposited_at")} if old is not None else {}
    kept.update(deposit)
    runner.state.execute(
        "INSERT OR REPLACE INTO forge_map_version (target, forge, repo_id, tag, paper_id, release_commit, map_commit, "
        "digest, pairs, card, frozen_at, instance, doi, record_url, deposited_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (runner.target, job["forge"], job["repo_id"], job["ref"], tie["paper_id"], tie.get("commit_sha") or "",
         map_commit, digest, pairs, json.dumps(frozen, ensure_ascii=False, sort_keys=True), runner.now(),
         kept.get("instance") or "", kept.get("doi") or "", kept.get("record_url") or "", kept.get("deposited_at")))
    runner.state.commit()


def run_release(runner: Runner, job: dict[str, Any]) -> Outcome:
    tie = _tie(runner, job)
    if tie is None:
        return Outcome("skipped", message=f"The release {job['ref']} is no longer tied to {job.get('paper_id')}: "
                                          f"nothing to version.")
    paper_id = tie["paper_id"]
    why = jobs._out_of_scope(jobs._paper(runner.con, paper_id))
    if why:
        return Outcome("skipped", message=why)
    try:
        card = zenodo.map_of(runner.con, paper_id)
    except zenodo.InvenioError as e:
        return Outcome("failed", message=str(e))
    if not card["code"]:
        return Outcome("skipped", message="This paper has no code in the registry yet: it has no tracing map to version.")
    digest = zenodo.map_digest(card)
    _keep_version(runner, job, tie, card, digest)
    map_commit, pairs = _frozen(card, tie)
    said = [f"The tracing map of {paper_id} is versioned with the release {job['ref']}: digest {digest[:12]}, "
            f"{pairs} paragraph–line pair{'s' if pairs != 1 else ''} in this repository."]
    release_commit = tie.get("commit_sha") or ""
    if map_commit and release_commit and map_commit != release_commit:
        said.append(f"Its lines are at commit {_short(map_commit)}, the release at {_short(release_commit)}.")
    if tie.get("map_digest") and tie["map_digest"] != digest:
        said.append("The map changed since the page showed it: the release keeps the map as it is now.")
    where = (f"{_where(job['forge'], job['repo_id'])} AND tag = {literal(job['ref'])} AND paper_id = {literal(paper_id)} "
             f"AND map_digest != {literal(digest)}")
    return Outcome("done", [f"UPDATE release_papers SET map_digest = {literal(digest)} WHERE {where}"], " ".join(said))


def run_deposit(runner: Runner, job: dict[str, Any]) -> Outcome:
    tie = _tie(runner, job)
    if tie is None:
        return Outcome("skipped", message=f"The release {job['ref']} is no longer tied to {job.get('paper_id')}: "
                                          f"nothing to deposit.")
    if runner.community is None:
        return Outcome("retry", message="the author's role cannot be confirmed without oscr_community", counts=False)
    paper_id, uid = tie["paper_id"], job.get("user_id") or ""
    held = runner.community.query(f"SELECT 1 AS x FROM roles WHERE user_id = {literal(uid)} AND role = 'verified_author' "
                                  f"AND scope_kind = 'paper' AND scope_id = {literal(paper_id)}")
    if not held:
        return Outcome("failed", message=f"Only a verified author of {paper_id} asks for the deposit of its map: "
                                         f"the role is not held (any more).")
    ids = runner.community.query(f"SELECT subject FROM identities WHERE user_id = {literal(uid)} AND provider = 'orcid'")
    orcid = str(ids[0]["subject"]) if ids else ""
    if not zenodo.orcid_is_valid(orcid):
        return Outcome("failed", message="No ORCID iD is linked to the account any more: the map is validated with it.")
    users = runner.community.query(f"SELECT display_name FROM users WHERE id = {literal(uid)}")
    why = jobs._out_of_scope(jobs._paper(runner.con, paper_id))
    if why:
        return Outcome("failed", message=why)
    try:
        card = zenodo.map_of(runner.con, paper_id)
    except zenodo.InvenioError as e:
        return Outcome("failed", message=str(e))
    if not card["code"]:
        return Outcome("failed", message="This paper has no code in the registry: it has no map to deposit.")
    digest = zenodo.map_digest(card)
    if tie.get("map_digest") and tie["map_digest"] != digest:
        return Outcome("failed", message="The map changed since you validated it: look at it again on the release's "
                                         "page, then ask for the deposit again.")
    # From ORCID's sandbox, a test, which only Zenodo's sandbox takes and no public output shows (CLAUDE.md).
    proof = "orcid" if job.get("proof") == "orcid" else "test"
    name = jobs.author_name(runner.con, paper_id, orcid, (users[0]["display_name"] if users else "") or "")
    inv = runner.invenio(runner.instance)
    try:
        if not inv.can_write:
            return Outcome("retry", message=f"no Zenodo token for {runner.instance} on the Mac "
                                            f"(keychain {zenodo.keychain_service(runner.instance)})", counts=False)
        release_card = {**card, "release": _release_block(tie, job["forge"])}
        zenodo.validate(runner.con, paper_id, orcid=orcid, name=name, proof=proof, card=release_card)
        deposit = zenodo.deposit_map(runner.con, inv, paper_id, platform=runner.platform, community=runner.zenodo_community,
                                     report=lambda m: runner.report(f"  zenodo: {m}"))
    except zenodo.InvenioError as e:
        if "not validated by an author" in str(e):
            return Outcome("failed", message="This validation is a test (ORCID's sandbox): the real Zenodo does not take it.")
        if job.get("attempts", 0) + 1 >= MAX_ATTEMPTS:
            return Outcome("failed", message=f"Zenodo refused the deposit: {e}"[:300])
        return Outcome("retry", message=f"Zenodo: {e}"[:300])
    finally:
        inv.close()
    doi = str(deposit.get("doi") or "")
    _keep_version(runner, job, tie, card, digest, instance=runner.instance, doi=doi,
                  record_url=str(deposit.get("url") or ""), deposited_at=runner.now())
    where = f"on Zenodo{' (sandbox)' if runner.instance == 'sandbox' else ''}"
    return Outcome("done", message=f"The tracing map of {paper_id}, with the release {job['ref']}, is deposited {where}"
                                   + (f": DOI {doi}." if doi else "."))


HANDLERS: dict[str, Callable[[Runner, dict[str, Any]], Outcome]] = {
    "link": run_link, "push": run_push, "archive": run_archive, "delete_due": run_delete_due,
    "reconcile": run_reconcile, "release": run_release, "deposit": run_deposit,
}


# ---------------------------------------------------------------------------------------
# The poll.

@dataclass
class Poll:
    new: int = 0
    done: int = 0
    skipped: int = 0
    failed: int = 0
    retry: int = 0
    #: delete_due jobs whose grace period is not over.
    wait: int = 0
    written: int = 0
    #: Jobs left for the next poll: the day's budget is spent.
    deferred: int = 0

    def describe(self, target: str) -> str:
        return (f"{target}: {self.new} new forge job(s); {self.done} done, {self.skipped} with nothing to do, "
                f"{self.wait} waiting for their date, {self.retry} to try again, {self.failed} given up; "
                f"{self.written} rows written"
                + (f"; {self.deferred} wait for tomorrow's budget" if self.deferred else ""))


def _cursor(state: sqlite3.Connection, target: str) -> int:
    r = state.execute("SELECT last_id FROM forge_cursor WHERE target = ?", (target,)).fetchone()
    return int(r["last_id"]) if r else 0


def answer(job_id: int, status: str, message: str, t: int) -> str:
    """The job's answer, in its own row: one row written."""
    return (f"UPDATE jobs SET done_at = {t}, outcome = {literal(status)}, message = {literal(words(message))} "
            f"WHERE id = {int(job_id)} AND done_at IS NULL")


def ingest(runner: Runner) -> int:
    """The jobs after the last one seen (`WHERE id > ?`, the rowid's order), kept in the state as
    work to do, and the repositories they name, which the mirrors read by key (no pass over
    `repos`). Returns how many were read."""
    state, target = runner.state, runner.target
    columns = "id, kind, forge, repo_id, ref, user_id, created_at, not_before, done_at"
    where = f"WHERE id > {_cursor(state, target)} ORDER BY id LIMIT {BATCH}"
    try:
        fresh = runner.d1.query(f"SELECT {columns}, paper_id, proof FROM jobs {where}")
    except (community.D1Error, sqlite3.Error) as e:
        if "no such column" not in str(e):
            raise
        fresh = runner.d1.query(f"SELECT {columns} FROM jobs {where}")   # oscr_forge before its migration 0006
    now = runner.now()
    for j in fresh:
        state.execute("INSERT OR IGNORE INTO forge_repo (target, forge, repo_id, learned_at) VALUES (?,?,?,?)",
                      (target, j["forge"], j["repo_id"], now))
        if j["kind"] not in HANDLERS:
            continue
        state.execute("INSERT OR IGNORE INTO forge_job (target, id, kind, forge, repo_id, ref, user_id, created_at, "
                      "not_before, status, updated_at, paper_id, proof) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (target, int(j["id"]), j["kind"], j["forge"], j["repo_id"], j["ref"] or "", j["user_id"] or "",
                       int(j["created_at"]), j["not_before"], "new" if j["done_at"] is None else "done", now,
                       j.get("paper_id") or "", j.get("proof") or ""))
    if fresh:
        state.execute("INSERT INTO forge_cursor (target, last_id) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET "
                      "last_id = excluded.last_id", (target, max(int(j["id"]) for j in fresh)))
    state.commit()
    return len(fresh)


def poll(runner: Runner) -> Poll:
    """Read the jobs after the last one seen, then answer every job not answered yet, in order,
    within the day's budget."""
    state, target = runner.state, runner.target
    out = Poll(new=ingest(runner))
    now = runner.now()
    waiting = [dict(r) for r in state.execute("SELECT * FROM forge_job WHERE target = ? AND status = 'new' ORDER BY id",
                                              (target,))]
    for job in waiting:
        if job["kind"] == "delete_due" and job["not_before"] is not None and now < int(job["not_before"]):
            out.wait += 1          # nothing read, nothing written before the date
            continue
        if runner.budget_left() < JOB_ROWS:
            out.deferred += 1
            continue
        try:
            outcome = HANDLERS[job["kind"]](runner, job)
        except ForgeError as e:
            outcome = Outcome("retry", message=f"the forge: {e}", counts=e.code != "rate_limited")
        except Exception as e:  # one job never stops the others
            runner.con.rollback()
            outcome = Outcome("retry", message=f"{type(e).__name__}: {e}")
        if outcome.status == "retry" and outcome.counts and job["attempts"] + 1 >= MAX_ATTEMPTS:
            outcome = Outcome("failed", message=f"OSCR could not complete this: {outcome.message}")
        if outcome.status in ("done", "skipped", "failed"):
            try:
                out.written += _write(runner, [*outcome.sql, answer(job["id"], outcome.status, outcome.message,
                                                                    _t(runner))])
            except community.D1Error as e:
                outcome = Outcome("retry", message=f"D1: {e}")
        _settle(runner, job, outcome)
        setattr(out, outcome.status, getattr(out, outcome.status) + 1)
        if outcome.status != "wait":
            runner.report(f"  forge job {job['id']} ({job['kind']} {job['forge']}:{job['repo_id']}): {outcome.status}"
                          + (f", {words(outcome.message, 1000)}" if outcome.message else ""))
    return out


def _settle(runner: Runner, job: dict[str, Any], outcome: Outcome) -> None:
    status = {"retry": "new", "wait": "new"}.get(outcome.status, outcome.status)
    runner.state.execute("UPDATE forge_job SET status = ?, attempts = attempts + ?, message = ?, updated_at = ? "
                         "WHERE target = ? AND id = ?",
                         (status, int(outcome.status in ("retry", "failed") and outcome.counts),
                          words(outcome.message, 1000), runner.now(), runner.target, job["id"]))
    runner.state.commit()


# ---------------------------------------------------------------------------------------
# The public mirrors' heads.

@dataclass
class Mirrors:
    checked: int = 0
    unchanged: int = 0
    changed: int = 0
    #: Renamed, transferred, gone or hidden, found when their path failed.
    followed: int = 0
    #: Read with `git ls-remote` (the REST quota spent).
    by_git: int = 0
    errors: int = 0
    written: int = 0
    deferred: int = 0

    def describe(self, target: str) -> str:
        return (f"{target}: {self.checked} mirror(s) checked; {self.changed} head(s) changed, {self.unchanged} "
                f"unchanged, {self.followed} followed by id, {self.errors} not read; {self.written} rows written"
                + (f"; {self.by_git} read with git ls-remote" if self.by_git else "")
                + (f"; {self.deferred} wait for tomorrow's budget" if self.deferred else ""))


def ls_remote(runner: Runner, ref: RepoRef, branch: str | None) -> str:
    """A head through the git protocol (no REST quota), git hardened as oscr/forge.py; GitHub
    only, anonymously (public repositories: no token rides along)."""
    if ref.forge != "github":
        raise ForgeError("unsupported", "git ls-remote reads GitHub's repositories only")
    forges.check_ref(ref)
    url = f"https://github.com/{quote(ref.owner, safe='')}/{quote(ref.name, safe='')}.git"
    pattern = f"refs/heads/{forges.check_branch(branch)}" if branch else "HEAD"
    try:
        env = {k: v for k, v in forges.git_env().items() if k not in ("GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS_TOKEN")}
        env["GIT_ASKPASS"] = "false"
        p = runner.git(["git", *forges.GIT_FLAGS, "ls-remote", url, pattern], env=env, capture_output=True,
                       text=True, timeout=forges.GIT_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ForgeError("unavailable", "git did not answer") from e
    if p.returncode != 0:
        err = str(p.stderr or "")
        if re.search(r"not found|does not exist|Authentication failed|could not read Username|terminal prompts disabled",
                     err, re.I):
            raise ForgeError("not_found", "the repository: not found (or not public)")
        raise ForgeError("unavailable", "git ls-remote failed")
    for line in str(p.stdout or "").splitlines():
        sha, _, name = line.partition("\t")
        if name.strip() == pattern:
            return forges.check_sha(sha.strip())
    raise ForgeError("not_found", "no such branch")


def _candidates(runner: Runner) -> list[dict[str, Any]]:
    """The repositories whose heads the Mac polls: those the jobs named (every repository OSCR
    knows was created or linked with a `link` job), read by key, 100 at a time."""
    while ingest(runner) == BATCH:
        pass
    quiet = _t(runner) - QUIET_S
    known: dict[str, list[str]] = {}
    for r in runner.state.execute("SELECT forge, repo_id FROM forge_repo WHERE target = ? ORDER BY forge, repo_id",
                                  (runner.target,)):
        known.setdefault(r["forge"], []).append(r["repo_id"])
    out = []
    for forge, ids in known.items():
        for i in range(0, len(ids), BATCH):
            listed = ", ".join(literal(x) for x in ids[i:i + BATCH])
            out += runner.d1.query("SELECT forge, repo_id, owner_login, name, mode, state, default_branch, head, "
                                   f"head_at, updated_at FROM repos WHERE forge = {literal(forge)} AND repo_id IN "
                                   f"({listed})")
    return sorted((r for r in out if r["state"] in ("active", "archived") and (
        r["mode"] == "public" or (r["mode"] == "installed" and int(r["updated_at"]) < quiet))),
        key=lambda r: (r["forge"], r["repo_id"]))


def heads(runner: Runner) -> Mirrors:
    """The heads of the public mirrors (and of the installed repositories not heard from in a
    week): a conditional request with the ETag last seen (a 304 writes nothing), else `git
    ls-remote` once the REST quota is spent; one row per changed head."""
    out = Mirrors()
    state, target = runner.state, runner.target
    rows = _candidates(runner)
    git_only: set[str] = set()
    for i, row in enumerate(rows):
        if runner.budget_left() < JOB_ROWS:
            out.deferred = len(rows) - i
            break
        out.checked += 1
        forge, repo_id, branch = row["forge"], row["repo_id"], row["default_branch"]
        ref = RepoRef(forge, row["owner_login"], row["name"])
        seen = state.execute("SELECT branch, sha, etag FROM forge_etag WHERE target = ? AND forge = ? AND repo_id = ?",
                             (target, forge, repo_id)).fetchone()
        etag = seen["etag"] if seen and seen["etag"] and seen["sha"] == row["head"] and seen["branch"] == branch else None
        sha, new_etag, used = None, "", branch
        try:
            if forge in git_only:
                raise ForgeError("rate_limited", "the REST quota is spent")
            h = runner.reader(forge).head(ref, branch, etag)
            if h is None:
                out.unchanged += 1
                continue
            sha, new_etag, used = h.sha, h.etag or "", h.branch
        except ForgeError as e:
            try:
                if e.code == "rate_limited" and forge == "github":
                    git_only.add(forge)
                    sha = ls_remote(runner, ref, branch)
                    out.by_git += 1
                elif e.code in ("not_found", "gone"):
                    sql, said, _ = follow(runner, row)
                    out.written += _write(runner, sql)
                    out.followed += bool(sql)
                    runner.report(f"  mirror {forge}:{repo_id}: {said}")
                    continue
                else:
                    raise
            except (ForgeError, community.D1Error) as e2:
                out.errors += 1
                runner.report(f"  mirror {forge}:{repo_id}: not read ({words(str(e2), 200)})")
                continue
        state.execute("INSERT OR REPLACE INTO forge_etag (target, forge, repo_id, branch, sha, etag, checked_at) "
                      "VALUES (?,?,?,?,?,?,?)", (target, forge, repo_id, used or "", sha, new_etag, runner.now()))
        state.commit()
        if sha == row["head"]:
            out.unchanged += 1
            continue
        t = _t(runner)
        sets = f"head = {literal(sha)}, head_at = {t}, updated_at = {t}"
        if used and used != branch:
            sets += f", default_branch = {literal(used)}"
        try:
            n = _write(runner, [f"UPDATE repos SET {sets} WHERE {_where(forge, repo_id)} AND (head IS NULL OR head != "
                                f"{literal(sha)}) AND (head_at IS NULL OR head_at <= {t})"])
        except community.D1Error as e:
            out.errors += 1
            runner.report(f"  mirror {forge}:{repo_id}: D1 {words(str(e), 200)}")
            continue
        out.written += n
        out.changed += bool(n)
        runner.report(f"  mirror {forge}:{repo_id}: head {_short(row['head']) or 'none'} → {_short(sha)}")
    return out


# ---------------------------------------------------------------------------------------
# The command line, and the hooks of `oscr jobs poll` and `oscr nightly`.

def status(state: sqlite3.Connection) -> str:
    lines = []
    for r in state.execute("SELECT target, last_id FROM forge_cursor ORDER BY target"):
        lines.append(f"{r['target']}: forge jobs read up to {r['last_id']}")
    for r in state.execute("SELECT target, kind, status, COUNT(*) AS n FROM forge_job GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"):
        lines.append(f"{r['target']}: forge {r['kind']} {r['status']}: {r['n']}")
    for r in state.execute("SELECT target, COUNT(*) AS n, MAX(checked_at) AS last FROM forge_etag GROUP BY 1 ORDER BY 1"):
        lines.append(f"{r['target']}: {r['n']} mirror head(s) known, last read "
                     f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(r['last']))} UTC")
    for r in state.execute("SELECT target, SUM(1 - reachable) AS lost, COUNT(*) AS n FROM forge_commit GROUP BY 1 "
                           "ORDER BY 1"):
        lines.append(f"{r['target']}: {r['n']} pinned commit(s) checked, {r['lost']} no longer at the source")
    for r in state.execute("SELECT target, day, rows FROM community_budget ORDER BY day DESC, target LIMIT 4"):
        lines.append(f"{r['target']}: {r['rows']} rows written on {r['day']} (UTC), facts, jobs and forge together")
    return "\n".join(lines) or "no forge job read yet"


def _check(con: Any, target: str | None) -> None:
    """Before anything is opened: a target, and the harvester's database."""
    if target not in ("local", "remote"):
        raise SystemExit("oscr forge: add --local (the local D1 of `wrangler dev`) or --remote (the Cloudflare "
                         "database oscr_forge)")
    if not isinstance(con, sqlite3.Connection):
        raise TypeError("oscr forge: the harvester's database is needed")


def _open(con: sqlite3.Connection, state: sqlite3.Connection, *, target: str | None, budget: int | None,
          settings: dict[str, str] | None, persist_to: Path | None, client: Any, report: Callable[[str], None],
          opts: Any = None, readers: Callable[[str], ForgeReader] | None = None,
          post: Callable[[str], net.Response] | None = None, instance: str | None = None) -> Runner:
    """The runner of `oscr forge poll|mirrors` on `target`: D1 oscr_forge and oscr_community, the
    harvester's own functions, GitHub's read-only reader with the Mac's client."""
    _check(con, target)
    from . import harvest
    cfg = settings or {}
    client = client if client is not None else net.Client()
    d1 = community.open_d1(target, settings=cfg, persist_to=persist_to, database="oscr_forge")
    people = community.open_d1(target, settings=cfg, persist_to=persist_to)
    if budget is None:
        budget = int(cfg.get("OSCR_COMMUNITY_BUDGET", str(community.DAILY_BUDGET)))
    readers = readers or (lambda f: forges.GitHubReader(client) if f == "github" else forges.reader(f))
    instance = instance or cfg.get("OSCR_ZENODO_INSTANCE", "sandbox")
    if instance not in zenodo.INSTANCES:
        raise SystemExit(f"OSCR_ZENODO_INSTANCE: sandbox or zenodo, not {instance!r}")
    return Runner(con, d1, state, jobs.MacHarvester(client, opts or harvest.Options(records=False)), community=people,
                  readers=readers, post=post or _swh_post(client), budget=budget, report=report, instance=instance,
                  zenodo_community=cfg.get("OSCR_ZENODO_COMMUNITY", "oscr"),
                  platform=cfg.get("OSCR_PLATFORM_NAME", "Open Scientific Code Registry (OSCR)"))


def command(con: sqlite3.Connection, action: str, *, target: str | None, folder: Path,
            budget: int | None = None, settings: dict[str, str] | None = None,
            persist_to: Path | None = None, client: Any = None,
            report: Callable[[str], None] = print, **extra: Any) -> str:
    """`oscr forge poll|mirrors|status`: its answer in words. `folder` holds the state shared
    with `oscr community` and `oscr jobs` (data/community/state.db). `extra`: `opts` (the
    harvester's options), `readers`, `post` (what the tests inject)."""
    if action not in ACTIONS:
        raise SystemExit(f"oscr forge {action}: poll, mirrors or status")
    if action != "status":
        _check(con, target)
    state = open_state(Path(folder) / "state.db")
    try:
        if action == "status":
            return status(state)
        runner = _open(con, state, target=target, budget=budget, settings=settings, persist_to=persist_to,
                       client=client, report=report, **extra)
        try:
            if action == "poll":
                return "forge jobs, " + poll(runner).describe(runner.target)
            return "forge mirrors, " + heads(runner).describe(runner.target)
        except community.D1Error as e:
            raise SystemExit(f"D1 ({target}): {e}") from None
    finally:
        state.close()


@overload
def mirrors(runner: Runner) -> Mirrors: ...


@overload
def mirrors(runner: sqlite3.Connection, *, target: str, folder: Path, budget: int | None = None,
            settings: dict[str, str] | None = None, client: Any = None,
            report: Callable[[str], None] = print, **extra: Any) -> str: ...


def mirrors(runner: Runner | sqlite3.Connection, *, target: str | None = None, folder: Path | None = None,
            budget: int | None = None, settings: dict[str, str] | None = None, client: Any = None,
            report: Callable[[str], None] = print, **extra: Any) -> Mirrors | str:
    """The public mirrors' heads. With a Runner: the counts (`heads`). With the harvester's
    database: the nightly hook (`oscr nightly` with OSCR_FORGE_PUSH=remote), its answer in words."""
    if isinstance(runner, Runner):
        return heads(runner)
    return command(runner, "mirrors", target=target, folder=Path(folder or "data/community"), budget=budget,
                   settings=settings, client=client, report=report, **extra)


def archive_answers(state: sqlite3.Connection, target: str) -> list[dict[str, Any]]:
    """Software Heritage's answers, newest first (what `status` and the tests read)."""
    return [dict(r) for r in state.execute("SELECT * FROM forge_archive WHERE target = ? ORDER BY at DESC, job_id DESC",
                                           (target,))]


def map_versions(state: sqlite3.Connection, target: str) -> list[dict[str, Any]]:
    """The tracing maps versioned with releases, for `target` (what the static layer and the tests
    read), by repository, tag and paper."""
    if not state.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'forge_map_version'").fetchone():
        return []
    return [dict(r) for r in state.execute("SELECT * FROM forge_map_version WHERE target = ? ORDER BY forge, repo_id, tag, "
                                           "paper_id", (target,))]
