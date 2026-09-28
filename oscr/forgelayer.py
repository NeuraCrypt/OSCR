"""The GitHub side (night phase 01), on the Mac: the traced paths in D1 ``oscr_forge`` and OSCR's
static layer for the repository pages (docs/FORGE.md, "The static layer").

**The traced paths** (``push_traced``). The files the tracing maps point to: for each paper with a
page and each file of a GitHub repository its Code ↔ Paper matches name (``alignment``), the
paper, the path, the commit the map is pinned to (the file's verified version, else the
repository's verified commit) and how many line ranges. They are keyed by the forge's durable id,
so a rename or a transfer never breaks them: each catalogue repository is resolved once through
``oscr/forge.py`` (``repo``, read only, the Mac's own read-only token) and the answer cached in the
state (``forgelayer_ids``). They are pushed into ``traced_paths`` as deltas, as oscr/community.py
pushes its facts: a hash of every row pushed per target (``forgelayer_sync``), deletions first,
then new rows, then changed ones, within the daily budget the facts push shares
(``community_budget``); the rest goes next time. ``traced_paths`` is WITHOUT ROWID without an
index: a statement writes one row.

**The static layer** (``write``). OSCR's layer for signed-out readers, at most 64 shards
``<out>/forge/layer/NN.json``, NN = the first byte of SHA-256 of "owner/name" in lower case, mod 64
(``shard``; website/src/lib/forge.ts ``layerShard`` is the same, both checked against
tests/fixtures/forge-shards.json). A shard is an object keyed by "owner/name" in lower case::

    {"forge": "github", "id": "123" | null,
     "mode": "catalogue" | "created" | "installed" | "public",
     "state": "active" | "archived" | "gone",
     "head": sha | null, "head_at": s | null, "last_seen": s | null,
     "papers": [{"doi", "slug" | null, "title" | null, "status": "linked" | "proposed" | null}],
     "maps": papers with a tracing map on it, "paths": files those maps point to,
     "unreachable": [{"commit", "found_at", "papers": [{"doi", "reader" | null}], "swh" | null}]}

- ``catalogue``: a GitHub repository the catalogue links as a paper's code but nobody linked in
  OSCR (read only). The catalogue's GitHub repositories come in this way at 0 D1 rows: the mirror
  mode brings in the code the catalogue already links (D01-6).
- ``created``, ``installed``, ``public``: the repositories of ``oscr_forge.repos`` (read when ``d1``
  is given: two key-ordered reads of ``repos`` and ``repo_papers``, a few thousand rows read a
  night, nothing written), merged with the catalogue's entry of the same id.
- Left out: a repository waiting for deletion, hidden (made private), deleted, or that the Mac's
  resolution saw private; its catalogue entry too (matched by id and by path).
- ``unreachable``: the pinned commits a ``push`` or ``reconcile`` job found no longer at the
  source (oscr/forgejobs.py's ``forge_commit`` in the shared state, or ``mark_commits``; the
  latest answer per commit wins), with the reader of the licensed script
  copies (only when the repository's license lets them be published, CLAUDE.md "Only verified
  licenses leave the Mac") and the Software Heritage link when the repository is archived there
  (the harvester's ``repository.swh_archived``, or a save request oscr/forgejobs.py saw succeed).
- Titles go through ``entities.strip_contacts`` and every string through ``entities.scrub``: no
  email address. A paper withdrawn or off-topic on the Mac is never listed.
- Every one of the 64 shards is written, ``{}`` when empty: a reader's page never asks for a file
  that is not there. The shards are built in memory, then each replaces its file: nothing is
  written outside ``<out>/forge/layer/``. When ``d1`` fails to answer, the 64 shards are written
  empty and the error raised: a layer that could not be checked against D1's hidden and deleted
  repositories is never published (the nightly records the failure and still deploys).

    oscr forge layer --local|--remote   the traced paths pushed, then the shards written
    oscr forge status                   what each target holds, the ids, the last runs
    oscr nightly                        calls ``write`` between the public export and the
                                        deployment when OSCR_FORGE_PUSH=remote (it pushes the
                                        traced paths first, in the shared state and budget)
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from . import catalog, community, entities
from . import forge as forges

#: The actions of ``oscr forge`` this module answers.
ACTIONS: tuple[str, ...] = ("layer", "status")
#: Shards of the static layer: /forge/layer/00.json … /forge/layer/63.json.
SHARDS = 64
#: The layer's folder under the public export.
LAYER = Path("forge") / "layer"
#: The forge of the catalogue's repositories that come into the layer.
FORGE = "github"
HOST = "github.com"
#: The state shared with ``oscr community``, ``oscr jobs`` and ``oscr forge poll`` (the nightly's).
STATE_FOLDER = Path("data") / "community"
#: Repositories resolved at most per run (the Mac's token has 5,000 requests an hour).
MAX_RESOLVE = 500
#: A repository not found is asked again after this many days (it may come back public).
RETRY_DAYS = 30
#: Statements per D1 call (as oscr/community.py's REST push).
CHUNK = community.REMOTE_STATEMENTS
#: Rows read per page of ``repos`` and ``repo_papers``.
PAGE = 1_000
MAX_TITLE = 300
MODES: tuple[str, ...] = ("catalogue", "created", "installed", "public")
#: The states of oscr_forge.repos that keep a repository out of every public output.
LEFT_OUT: frozenset[str] = frozenset({"pending_deletion", "hidden", "deleted"})
KEY_COLUMNS: tuple[str, ...] = ("forge", "repo_id", "path", "paper_id")
SEGMENT = re.compile(r"^(?!\.+$)[a-z0-9._-]{1,100}$")
SHA = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SWH = "https://archive.softwareheritage.org/swh:1:rev:"

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS forgelayer_ids (
    repo         TEXT PRIMARY KEY,         -- the catalogue's key, github.com/<owner>/<name>, lower case
    forge        TEXT NOT NULL,
    repo_id      TEXT NOT NULL DEFAULT '', -- the forge's durable id; '' when not found
    owner        TEXT NOT NULL DEFAULT '', -- the path the forge answered with (a rename is followed)
    name         TEXT NOT NULL DEFAULT '',
    visibility   TEXT NOT NULL DEFAULT '',
    archived     INTEGER NOT NULL DEFAULT 0,
    outcome      TEXT NOT NULL,            -- found, or the forge's error code (not_found, gone, …)
    resolved_at  REAL NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forgelayer_sync (
    target     TEXT NOT NULL,              -- local | remote
    key        TEXT NOT NULL,              -- JSON [forge, repo_id, path, paper_id]
    hash       TEXT NOT NULL,
    pushed_at  REAL NOT NULL,
    PRIMARY KEY (target, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forgelayer_lost (
    forge       TEXT NOT NULL,
    repo_id     TEXT NOT NULL,
    commit_sha  TEXT NOT NULL,
    found_at    REAL NOT NULL,
    by          TEXT NOT NULL DEFAULT '',  -- push | reconcile
    PRIMARY KEY (forge, repo_id, commit_sha)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS forgelayer_run (
    at       REAL NOT NULL,
    what     TEXT NOT NULL,                -- push:<target> | layer
    summary  TEXT NOT NULL
);
"""


class NotBuilt(RuntimeError):
    """Kept for the callers that name it (oscr/cli.py's tests): this module is built."""


class LayerError(RuntimeError):
    """The layer could not be made complete: the shards were written empty."""


def open_state(folder: Path | str) -> sqlite3.Connection:
    """The shared state (``<folder>/state.db``, oscr/community.py's), with this module's tables."""
    state = community.open_state(Path(folder) / "state.db")
    prepare(state)
    return state


def prepare(state: sqlite3.Connection) -> sqlite3.Connection:
    state.row_factory = sqlite3.Row
    state.executescript(STATE_SCHEMA)
    return state


def shard(owner: str, name: str) -> str:
    """The shard of "owner/name": the first byte of SHA-256 of it in lower case (UTF-8), mod 64."""
    return f"{hashlib.sha256(f'{owner}/{name}'.lower().encode('utf-8')).digest()[0] % SHARDS:02d}"


def split(repo: str) -> tuple[str, str] | None:
    """("owner", "name") in lower case for "github.com/Owner/Name"; None otherwise."""
    parts = repo.lower().split("/")
    if len(parts) != 3 or parts[0] != HOST or not SEGMENT.match(parts[1]) or not SEGMENT.match(parts[2]) \
            or parts[2].endswith(".git"):
        return None
    return parts[1], parts[2]


def _title(text: str | None) -> str | None:
    t = re.sub(r"\s+", " ", entities.strip_contacts(text or "")).strip()
    if not t:
        return None
    return t if len(t) <= MAX_TITLE else t[:MAX_TITLE - 1].rstrip() + "…"


def _seconds(value: Any) -> int | None:
    """Unix seconds from a number or an ISO 8601 date; None when there is none."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _sha(value: str | None) -> str | None:
    v = (value or "").strip().lower()
    return v if SHA.match(v) else None


# ---------------------------------------------------------------------------------------
# What the Mac knows: the catalogue's GitHub repositories, their papers and their traced paths.

@dataclass
class Paper:
    id: str
    doi: str
    slug: str
    title: str | None


@dataclass
class Repo:
    """A GitHub repository the catalogue links as the code of papers with a page."""
    repo: str                 # github.com/<owner>/<name>, lower case
    owner: str
    name: str
    papers: dict[str, Paper] = field(default_factory=dict)
    head: str | None = None
    head_at: int | None = None
    last_seen: int | None = None
    dead: bool = False
    publishable: bool = False
    swh: bool = False


def _pages(con: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    return {r["id"]: r for r in con.execute(f"SELECT id, doi, title FROM article WHERE id IN ({entities.PAGES_SQL})")}


def catalogue(con: sqlite3.Connection) -> dict[str, Repo]:
    """The catalogue's GitHub code repositories of papers with a page, by key."""
    pages = _pages(con)
    repos: dict[str, Repo] = {}
    for r in con.execute(f"SELECT article_id, repo FROM link WHERE role = 'code' AND article_id IN ({entities.PAGES_SQL}) "
                         f"ORDER BY repo, article_id"):
        named = split(r["repo"])
        if named is None:
            continue
        key = r["repo"].lower()
        entry = repos.setdefault(key, Repo(key, *named))
        a = pages[r["article_id"]]
        entry.papers[a["id"]] = Paper(a["id"], a["doi"] or "", catalog.slug(a["id"]), _title(a["title"]))
    for r in con.execute("SELECT repo, state, redistributable, commit_id, commit_date, swh_archived, verified_at "
                         "FROM repository WHERE lower(repo) LIKE 'github.com/%'"):
        entry = repos.get(r["repo"].lower())
        if entry is None:
            continue
        entry.head, entry.head_at = _sha(r["commit_id"]), _seconds(r["commit_date"])
        entry.last_seen = _seconds(r["verified_at"])
        entry.dead = r["state"] == "dead"
        entry.publishable = (r["redistributable"] or "") in catalog.PUBLISHABLE
        entry.swh = bool(r["swh_archived"])
    return repos


@dataclass(frozen=True)
class Traced:
    """One row of ``traced_paths``, and the catalogue repository it came from."""
    repo: str
    forge: str
    repo_id: str
    path: str
    paper_id: str
    commit_sha: str
    ranges: int

    @property
    def values(self) -> dict[str, Any]:
        return {"forge": self.forge, "repo_id": self.repo_id, "path": self.path, "paper_id": self.paper_id,
                "commit_sha": self.commit_sha, "ranges": self.ranges}

    @property
    def key(self) -> str:
        return json.dumps([self.forge, self.repo_id, self.path, self.paper_id], ensure_ascii=False)

    @property
    def hash(self) -> str:
        text = json.dumps(["traced_paths", self.values], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def ids(state: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    """The resolutions cached in the state, by catalogue key."""
    prepare(state)
    return {r["repo"]: r for r in state.execute("SELECT * FROM forgelayer_ids")}


def traced(con: sqlite3.Connection, state: sqlite3.Connection) -> dict[str, Traced]:
    """The rows ``traced_paths`` must hold: the resolved public GitHub repositories' files that the
    matches of papers with a page point to, at a pinned commit."""
    known = {k: r for k, r in ids(state).items() if r["outcome"] == "found" and r["repo_id"]
             and r["visibility"] == "public"}
    versions: dict[tuple[str, str], str | None] = {
        (r["repo"].lower(), r["path"]): _sha(r["version"])
        for r in con.execute("SELECT repo, path, version FROM file WHERE lower(repo) LIKE 'github.com/%'")}
    commits = {r["repo"].lower(): _sha(r["commit_id"])
               for r in con.execute("SELECT repo, commit_id FROM repository WHERE lower(repo) LIKE 'github.com/%'")}
    out: dict[str, Traced] = {}
    for r in con.execute(f"SELECT article_id, lower(repo) AS repo, path, COUNT(*) AS ranges FROM alignment "
                         f"WHERE article_id IN ({entities.PAGES_SQL}) AND lower(repo) LIKE 'github.com/%' "
                         f"GROUP BY article_id, lower(repo), path ORDER BY 2, 3, 1"):
        found = known.get(r["repo"])
        paper = r["article_id"]
        if found is None or split(r["repo"]) is None or not paper.startswith(("doi:", "pmci")):
            continue
        commit = versions.get((r["repo"], r["path"])) or commits.get(r["repo"])
        try:
            path = forges.check_path(r["path"])
        except forges.ForgeError:
            continue
        if commit is None:
            continue          # no pinned commit: not a map a reader can follow
        row = Traced(r["repo"], found["forge"], found["repo_id"], path, paper, commit, int(r["ranges"]))
        out[row.key] = row
    return out


# ---------------------------------------------------------------------------------------
# The forge's durable ids, resolved once.

@dataclass
class Resolved:
    asked: int = 0
    found: int = 0
    missing: int = 0
    #: Left for the next run: the per-run limit, or the forge asked to wait.
    left: int = 0
    stopped: str = ""


def resolve_ids(con: sqlite3.Connection, state: sqlite3.Connection, reader: forges.ForgeReader | None = None, *,
                limit: int = MAX_RESOLVE, now: float | None = None) -> Resolved:
    """Each catalogue GitHub repository not resolved yet (or not found more than RETRY_DAYS ago)
    asked once of the forge, read only, and cached. A quota spent or a forge down stops the run:
    the rest waits for the next one."""
    t = now if now is not None else time.time()
    cached = ids(state)
    todo = [key for key in sorted(catalogue(con))
            if key not in cached or (cached[key]["outcome"] != "found"
                                     and cached[key]["resolved_at"] < t - RETRY_DAYS * 86_400)]
    done = Resolved(left=len(todo))
    if not todo:
        return done
    reader = reader if reader is not None else forges.GitHubReader()
    for key in todo[:limit]:
        owner, name = key.split("/")[1:]
        done.asked += 1
        try:
            info = reader.repo(forges.RepoRef(FORGE, owner, name))
        except forges.ForgeError as e:
            if e.code in ("rate_limited", "unavailable", "unauthorized"):
                done.stopped = f"{e.code}: {e}"
                done.asked -= 1
                break
            state.execute("INSERT OR REPLACE INTO forgelayer_ids (repo, forge, outcome, resolved_at) VALUES (?,?,?,?)",
                          (key, FORGE, e.code, t))
            done.missing += 1
        else:
            state.execute("INSERT OR REPLACE INTO forgelayer_ids (repo, forge, repo_id, owner, name, visibility, archived, "
                          "outcome, resolved_at) VALUES (?,?,?,?,?,?,?,?,?)",
                          (key, FORGE, info.key.id, info.ref.owner.lower(), info.ref.name.lower(), info.visibility,
                           int(info.archived), "found", t))
            done.found += 1
        state.commit()
    done.left = len(todo) - done.found - done.missing
    return done


# ---------------------------------------------------------------------------------------
# The commits no longer at the source: what oscr/forgejobs.py's push and reconcile jobs found.

def mark_commits(state: sqlite3.Connection, forge: str, repo_id: str, reachable: dict[str, bool], *,
                 by: str = "push", now: float | None = None) -> int:
    """Record, for pinned commits of one repository, whether the forge still has them: an
    unreachable one enters the layer's ``unreachable`` list, a reachable one leaves it. Returns the
    commits now recorded as unreachable for that repository."""
    prepare(state)
    t = now if now is not None else time.time()
    for sha, ok in reachable.items():
        commit = _sha(sha)
        if commit is None:
            continue
        if ok:
            state.execute("DELETE FROM forgelayer_lost WHERE forge = ? AND repo_id = ? AND commit_sha = ?",
                          (forge, repo_id, commit))
        else:
            state.execute("INSERT OR IGNORE INTO forgelayer_lost (forge, repo_id, commit_sha, found_at, by) "
                          "VALUES (?,?,?,?,?)", (forge, repo_id, commit, t, by))
    state.commit()
    return state.execute("SELECT COUNT(*) FROM forgelayer_lost WHERE forge = ? AND repo_id = ?",
                         (forge, repo_id)).fetchone()[0]


def pinned(con: sqlite3.Connection, state: sqlite3.Connection) -> dict[tuple[str, str], set[str]]:
    """The commits the maps are pinned to, by (forge, repo id): what a push job re-checks."""
    out: dict[tuple[str, str], set[str]] = defaultdict(set)
    for row in traced(con, state).values():
        out[(row.forge, row.repo_id)].add(row.commit_sha)
    return dict(out)


# ---------------------------------------------------------------------------------------
# The push of the traced paths, as deltas.

@dataclass
class Plan:
    target: str
    statements: list[tuple[str, str | None, str]] = field(default_factory=list)   # (key, hash or None, sql)
    new: int = 0
    changed: int = 0
    deleted: int = 0
    deferred: int = 0
    budget_left: int = 0
    held: int = 0
    applied: int = 0
    written: int = 0
    resolved: Resolved = field(default_factory=Resolved)

    @property
    def complete(self) -> bool:
        return self.deferred == 0

    def describe(self) -> str:
        r = self.resolved
        ids_said = f"{r.found} ids resolved, {r.missing} not found" + (f", {r.left} left" if r.left else "") + (
            f" ({r.stopped})" if r.stopped else "")
        return (f"traced paths, {self.target}: {len(self.statements)} statements of {self.budget_left} rows left today; "
                f"{self.new} new, {self.changed} changed, {self.deleted} deleted, {self.deferred} left for the next "
                f"push; D1 then holds {self.held}; {ids_said}")


def _upsert(row: Traced) -> str:
    v = row.values
    return (f"INSERT INTO traced_paths ({', '.join(v)}) VALUES ({', '.join(community.literal(x) for x in v.values())}) "
            f"ON CONFLICT ({', '.join(KEY_COLUMNS)}) DO UPDATE SET commit_sha = excluded.commit_sha, "
            f"ranges = excluded.ranges;")


def _delete(key: str) -> str:
    values = json.loads(key)
    where = " AND ".join(f"{c} = {community.literal(v)}" for c, v in zip(KEY_COLUMNS, values, strict=True))
    return f"DELETE FROM traced_paths WHERE {where};"


def build(con: sqlite3.Connection, state: sqlite3.Connection, target: str, *,
          budget: int = community.DAILY_BUDGET, now: float | None = None) -> Plan:
    """What the next push of the traced paths to ``target`` sends, within what is left of today's
    shared budget: deletions first, then new rows, then changed ones."""
    prepare(state)
    wanted = traced(con, state)
    synced = {r["key"]: r["hash"] for r in state.execute("SELECT key, hash FROM forgelayer_sync WHERE target = ?",
                                                          (target,))}
    plan = Plan(target, budget_left=max(0, budget - community.budget_spent(state, target, community.utc_day(now))))
    todo: list[tuple[str, tuple[str, str | None, str]]] = [
        ("deleted", (key, None, _delete(key))) for key in sorted(synced) if key not in wanted]
    new, changed = [], []
    for key, row in sorted(wanted.items()):
        before = synced.get(key)
        if before == row.hash:
            continue
        (new if before is None else changed).append(("new" if before is None else "changed", (key, row.hash, _upsert(row))))
    todo += new + changed
    for kind, statement in todo:
        if plan.deferred or len(plan.statements) + 1 > plan.budget_left:
            plan.deferred += 1
            continue
        plan.statements.append(statement)
        setattr(plan, kind, getattr(plan, kind) + 1)
    after = dict(synced)
    for key, digest, _ in plan.statements:
        if digest is None:
            after.pop(key, None)
        else:
            after[key] = digest
    plan.held = len(after)
    return plan


def push_traced(con: sqlite3.Connection, d1: community.D1, state: sqlite3.Connection, target: str, *,
                budget: int = community.DAILY_BUDGET, reader: forges.ForgeReader | None = None,
                now: float | None = None, report: Callable[[str], None] = print) -> Plan:
    """Resolve the ids still unknown, then send the delta of ``traced_paths`` to ``d1`` part by part,
    recording each part D1 accepted (its rows count in the shared day's budget). A failed part
    stops the push: what was accepted stays recorded, the rest goes next time (D1Error raised)."""
    prepare(state)
    resolved = resolve_ids(con, state, reader, now=now)
    plan = build(con, state, target, budget=budget, now=now)
    plan.resolved = resolved
    report(plan.describe())
    t = now if now is not None else time.time()
    try:
        for i in range(0, len(plan.statements), CHUNK):
            part = plan.statements[i:i + CHUNK]
            rows = d1.run([sql for _, _, sql in part])
            for key, digest, _ in part:
                if digest is None:
                    state.execute("DELETE FROM forgelayer_sync WHERE target = ? AND key = ?", (target, key))
                else:
                    state.execute("INSERT OR REPLACE INTO forgelayer_sync (target, key, hash, pushed_at) VALUES (?,?,?,?)",
                                  (target, key, digest, t))
            community.spend(state, target, rows, now=now)      # commits
            plan.applied += len(part)
            plan.written += rows
    finally:
        state.execute("INSERT INTO forgelayer_run (at, what, summary) VALUES (?, ?, ?)",
                      (t, f"push:{target}", f"{plan.applied} statements applied, {plan.written} rows written; "
                                            + plan.describe()))
        state.commit()
    return plan


# ---------------------------------------------------------------------------------------
# The static layer.

def _forge_rows(d1: community.D1, table: str, columns: str) -> list[dict[str, Any]]:
    """Every GitHub row of ``table``, read in key order, a page at a time (no scan of other forges)."""
    rows: list[dict[str, Any]] = []
    keys = ("repo_id",) if table == "repos" else ("repo_id", "paper_id")
    after: tuple[str, ...] = ("",) * len(keys)
    while True:
        # The key's order: (repo_id) > (a), or (repo_id, paper_id) > (a, b).
        ranges = [" AND ".join([*(f"{k} = {community.literal(after[j])}" for j, k in enumerate(keys[:i])),
                                f"{keys[i]} > {community.literal(after[i])}"]) for i in range(len(keys))]
        where = f"forge = 'github' AND ({' OR '.join(f'({r})' for r in ranges)})"
        page = d1.query(f"SELECT {columns} FROM {table} WHERE {where} ORDER BY {', '.join(keys)} LIMIT {PAGE}")
        rows += page
        if len(page) < PAGE:
            return rows
        after = tuple(str(page[-1][k]) for k in keys)


def _papers(entries: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [entries[k] for k in sorted(entries)]


def layer(con: sqlite3.Connection, d1: community.D1 | None, state: sqlite3.Connection | None) -> tuple[dict[str, dict[str, Any]], int]:
    """The layer's entries by "owner/name", and how many repositories were left out."""
    cat = catalogue(con)
    known = ids(state) if state is not None else {}
    wanted = traced(con, state) if state is not None else {}
    lost = _lost(state, d1.target if d1 is not None else None)
    archived_ids = _archived(state, d1.target if d1 is not None else None)
    # What the Mac knows of every paper: off-topic and withdrawn ones are never listed.
    pages = _pages(con)
    out_of_scope = {r["id"] for r in con.execute(f"SELECT id FROM article WHERE NOT ({catalog.IN_SCOPE})")}
    in_scope_titles = {r["id"]: r for r in con.execute(f"SELECT id, doi, title FROM article WHERE {catalog.IN_SCOPE}")}
    # Maps and paths per catalogue repository, from the Mac's own matches (0 D1 rows read).
    maps: dict[str, set[str]] = defaultdict(set)
    paths: dict[str, set[str]] = defaultdict(set)
    for r in con.execute(f"SELECT DISTINCT article_id, lower(repo) AS repo, path FROM alignment "
                         f"WHERE article_id IN ({entities.PAGES_SQL}) AND lower(repo) LIKE 'github.com/%'"):
        maps[r["repo"]].add(r["article_id"])
        paths[r["repo"]].add(r["path"])
    pins: dict[tuple[str, str], dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for row in wanted.values():
        pins[(row.forge, row.repo_id)][row.commit_sha].add(row.paper_id)

    def unreachable(repo_id: str | None, entry: Repo | None) -> list[dict[str, Any]]:
        if not repo_id:
            return []
        items = []
        for sha, found_at in lost.get((FORGE, repo_id), []):
            pinned_by = sorted(pins.get((FORGE, repo_id), {}).get(sha, set()))
            if not pinned_by and entry is not None and entry.head == sha:
                pinned_by = sorted(entry.papers)
            papers = []
            for paper_id in pinned_by:
                a = pages.get(paper_id)
                if a is None:
                    continue
                reader = f"/paper/{catalog.slug(paper_id)}/code/" if entry is not None and entry.publishable else None
                papers.append({"doi": a["doi"] or "", "reader": reader})
            swh = (entry is not None and entry.swh) or repo_id in archived_ids
            items.append({"commit": sha, "found_at": int(found_at), "papers": papers,
                          "swh": f"{SWH}{sha}" if swh and len(sha) == 40 else None})
        return items

    entries: dict[str, dict[str, Any]] = {}
    excluded_ids: set[str] = set()
    excluded_paths: dict[str, str] = {}    # "owner/name" → the id D1 keeps out
    left: set[str] = set()                 # the repositories left out, by id (or by path when unknown)
    by_id: dict[str, str] = {}             # a catalogue repository's id → its key
    for key in cat:
        r = known.get(key)
        if r is not None and r["outcome"] == "found" and r["repo_id"]:
            by_id[r["repo_id"]] = key
    d1_repos: list[dict[str, Any]] = []
    d1_papers: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if d1 is not None:
        try:
            d1_repos = _forge_rows(d1, "repos", "repo_id, owner_login, name, mode, state, head, head_at, updated_at")
            for p in _forge_rows(d1, "repo_papers", "repo_id, paper_id, status"):
                d1_papers[p["repo_id"]].append(p)
        except community.D1Error as e:
            raise LayerError(f"D1 did not answer ({e})") from None
    for r in d1_repos:
        if r["state"] in LEFT_OUT or r["mode"] not in MODES:
            excluded_ids.add(r["repo_id"])
            if r["owner_login"] and r["name"]:
                excluded_paths[f"{r['owner_login']}/{r['name']}".lower()] = r["repo_id"]
    taken: set[str] = set()
    # 1. The repositories OSCR knows in D1, merged with the catalogue's entry of the same id.
    for r in d1_repos:
        path = f"{r['owner_login']}/{r['name']}".lower()
        if r["repo_id"] in excluded_ids or split(f"{HOST}/{path}") is None:
            if r["state"] in LEFT_OUT:
                left.add(f"id:{r['repo_id']}")
            continue
        cat_key = by_id.get(r["repo_id"])
        entry = cat.get(cat_key) if cat_key else None
        papers: dict[str, dict[str, Any]] = {}
        if entry is not None:
            for p in entry.papers.values():
                papers[p.id] = {"doi": p.doi, "slug": p.slug, "title": p.title, "status": None}
        for p in d1_papers.get(r["repo_id"], []):
            paper_id = p["paper_id"]
            if paper_id in out_of_scope:
                continue
            a = in_scope_titles.get(paper_id)
            papers[paper_id] = {"doi": (a["doi"] if a is not None and a["doi"] else paper_id.removeprefix("doi:")),
                                "slug": catalog.slug(paper_id) if paper_id in pages else None,
                                "title": _title(a["title"]) if a is not None else None,
                                "status": p["status"] if p["status"] in ("linked", "proposed") else None}
        seen = [x for x in (_seconds(r["updated_at"]), entry.last_seen if entry else None) if x]
        entries[path] = {
            "forge": FORGE, "id": r["repo_id"], "mode": r["mode"], "state": r["state"],
            "head": _sha(r["head"]) or (entry.head if entry else None),
            "head_at": _seconds(r["head_at"]) or (entry.head_at if entry else None),
            "last_seen": max(seen) if seen else None,
            "papers": _papers(papers),
            "maps": len(maps.get(cat_key, ())) if cat_key else 0,
            "paths": len(paths.get(cat_key, ())) if cat_key else 0,
            "unreachable": unreachable(r["repo_id"], entry),
        }
        taken.add(path)
        if cat_key:
            taken.add(cat_key.split("/", 1)[1])
    # 2. The catalogue's own: read only, nobody linked them.
    for key, entry in sorted(cat.items()):
        r = known.get(key)
        repo_id = r["repo_id"] if r is not None and r["outcome"] == "found" and r["repo_id"] else None
        path = f"{r['owner']}/{r['name']}" if repo_id and r["owner"] and r["name"] else f"{entry.owner}/{entry.name}"
        held = excluded_paths.get(path) or excluded_paths.get(key.split("/", 1)[1])
        if (repo_id and repo_id in excluded_ids) or held \
                or (r is not None and r["outcome"] == "found" and r["visibility"] != "public"):
            left.add(f"id:{repo_id or held}" if repo_id or held else f"path:{path}")
            continue
        if path in taken or key.split("/", 1)[1] in taken or split(f"{HOST}/{path}") is None:
            continue
        gone = entry.dead or (r is not None and r["outcome"] in ("not_found", "gone"))
        state_word = "gone" if gone else "archived" if r is not None and r["archived"] else "active"
        entries[path] = {
            "forge": FORGE, "id": repo_id, "mode": "catalogue", "state": state_word,
            "head": entry.head, "head_at": entry.head_at, "last_seen": entry.last_seen,
            "papers": _papers({p.id: {"doi": p.doi, "slug": p.slug, "title": p.title, "status": None}
                               for p in entry.papers.values()}),
            "maps": len(maps.get(key, ())), "paths": len(paths.get(key, ())),
            "unreachable": unreachable(repo_id, entry),
        }
        taken.add(path)
    return {k: entities.scrub(v) for k, v in entries.items()}, len(left)


def _table(state: sqlite3.Connection, name: str) -> bool:
    return state.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def _lost(state: sqlite3.Connection | None, target: str | None) -> dict[tuple[str, str], list[tuple[str, float]]]:
    """The pinned commits no longer at the source, by (forge, repo id): (sha, when it was found).
    Two records say it: ``mark_commits`` (``forgelayer_lost``) and oscr/forgejobs.py's push and
    reconcile jobs (``forge_commit``, the answers for ``target``; every target's when there is no
    D1). For each commit the latest record wins: a commit found again leaves the list."""
    if state is None:
        return {}
    latest: dict[tuple[str, str, str], tuple[float, bool]] = {}

    def see(forge: str, repo_id: str, sha: str, at: float, reachable: bool) -> None:
        commit = _sha(sha)
        if commit is None:
            return
        k = (forge, repo_id, commit)
        if k not in latest or at >= latest[k][0]:
            latest[k] = (float(at), reachable)

    for r in state.execute("SELECT forge, repo_id, commit_sha, found_at FROM forgelayer_lost"):
        see(r["forge"], r["repo_id"], r["commit_sha"], r["found_at"], False)
    if _table(state, "forge_commit"):
        where, args = ("WHERE target = ?", (target,)) if target else ("", ())
        for r in state.execute(f"SELECT forge, repo_id, sha, reachable, checked_at FROM forge_commit {where}", args):
            see(r["forge"], r["repo_id"], r["sha"], r["checked_at"], bool(r["reachable"]))
    out: dict[tuple[str, str], list[tuple[str, float]]] = defaultdict(list)
    for (forge, repo_id, sha), (at, reachable) in sorted(latest.items()):
        if not reachable:
            out[(forge, repo_id)].append((sha, at))
    return dict(out)


def _archived(state: sqlite3.Connection | None, target: str | None) -> set[str]:
    """The GitHub repositories (by id) Software Heritage says it archived, from the answers
    oscr/forgejobs.py recorded (``forge_archive``, task succeeded)."""
    if state is None or not _table(state, "forge_archive"):
        return set()
    where, args = ("AND target = ?", (target,)) if target else ("", ())
    return {r["repo_id"] for r in state.execute(
        f"SELECT DISTINCT repo_id FROM forge_archive WHERE forge = ? AND task_status = 'succeeded' {where}",
        (FORGE, *args))}


def shards(entries: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The 64 shards, "00" to "63", each an object keyed by "owner/name" (sorted)."""
    out: dict[str, dict[str, Any]] = {f"{n:02d}": {} for n in range(SHARDS)}
    for key in sorted(entries):
        owner, name = key.split("/")
        out[shard(owner, name)][key] = entries[key]
    return out


def _write_shards(out: Path, content: dict[str, dict[str, Any]]) -> Path:
    folder = out / LAYER
    folder.mkdir(parents=True, exist_ok=True)
    for n, entries in content.items():
        tmp = folder / f"{n}.json.tmp"
        tmp.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
        tmp.replace(folder / f"{n}.json")
    return folder


def write(con: sqlite3.Connection, d1: community.D1 | None, out: Path, *, state: sqlite3.Connection | None = None,
          push: bool | None = None, budget: int | None = None, reader: forges.ForgeReader | None = None,
          now: float | None = None, report: Callable[[str], None] = print) -> str:
    """The nightly hook: the 64 shards under ``out/forge/layer/``, from the Mac's database and,
    when ``d1`` (oscr_forge, oscr/community.py ``open_d1``) is given, OSCR's rows. Without
    ``state`` (the nightly), the shared state of data/community is used, and with ``d1`` the traced
    paths are pushed first, within the settings' budget (OSCR_COMMUNITY_BUDGET). Returns what it
    did, in words."""
    opened = None
    if state is None:
        if d1 is not None:
            state = opened = open_state(STATE_FOLDER)
        elif (STATE_FOLDER / "state.db").exists():
            state = opened = open_state(STATE_FOLDER)
    else:
        prepare(state)
    try:
        said = []
        if d1 is not None and (push if push is not None else opened is not None) and state is not None:
            if budget is None:
                from .cli import settings
                budget = int(settings().get("OSCR_COMMUNITY_BUDGET", str(community.DAILY_BUDGET)))
            plan = push_traced(con, d1, state, d1.target, budget=budget, reader=reader, now=now, report=report)
            said.append(f"traced paths: {plan.applied} statements applied, {plan.written} rows written"
                        + ("" if plan.complete else f", {plan.deferred} wait for tomorrow's budget"))
        try:
            entries, left_out = layer(con, d1, state)
        except LayerError:
            _write_shards(out, {f"{n:02d}": {} for n in range(SHARDS)})
            raise
        folder = _write_shards(out, shards(entries))
        catalogue_only = sum(1 for e in entries.values() if e["mode"] == "catalogue")
        summary = (f"{len(entries)} repositories in {SHARDS} shards ({catalogue_only} from the catalogue only, "
                   f"{len(entries) - catalogue_only} linked through OSCR; {left_out} left out: waiting for deletion, "
                   f"hidden, deleted or private) → {folder}")
        if state is not None:
            state.execute("INSERT INTO forgelayer_run (at, what, summary) VALUES (?, 'layer', ?)",
                          (now if now is not None else time.time(), summary))
            state.commit()
        return "; ".join([*said, summary])
    finally:
        if opened is not None:
            opened.close()


# ---------------------------------------------------------------------------------------
# The command line.

def status(state: sqlite3.Connection) -> str:
    prepare(state)
    lines = []
    for r in state.execute("SELECT target, COUNT(*) AS n FROM forgelayer_sync GROUP BY target ORDER BY target"):
        lines.append(f"{r['target']}: oscr_forge.traced_paths: {r['n']} rows")
    for r in state.execute("SELECT outcome, COUNT(*) AS n FROM forgelayer_ids GROUP BY outcome ORDER BY outcome"):
        lines.append(f"catalogue repositories {r['outcome'].replace('_', ' ')}: {r['n']}")
    lost = state.execute("SELECT COUNT(*) FROM forgelayer_lost").fetchone()[0]
    if lost:
        lines.append(f"pinned commits no longer at the source: {lost}")
    for r in state.execute("SELECT * FROM forgelayer_run ORDER BY at DESC LIMIT 3"):
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(r["at"]))
        lines.append(f"{r['what']} {when}: {r['summary']}")
    return "\n".join(lines) or "forge layer: nothing pushed or written yet"


def command(con: sqlite3.Connection, action: str, *, target: str | None, folder: Path, out: Path,
            budget: int | None = None, settings: dict[str, str] | None = None,
            persist_to: Path | None = None, report: Callable[[str], None] = print,
            reader: forges.ForgeReader | None = None, now: float | None = None) -> str:
    """``oscr forge layer|status``: its answer in words. ``out`` is the public export's folder."""
    if action not in ACTIONS:
        raise SystemExit(f"forge {action}: not an action of the layer ({', '.join(ACTIONS)})")
    state = open_state(folder)
    try:
        if action == "status":
            return status(state)
        if target not in ("local", "remote"):
            raise SystemExit("forge layer: add --local (the local D1 of `wrangler dev`) or --remote "
                             "(the Cloudflare database oscr_forge)")
        try:
            d1 = community.open_d1(target, settings=settings, persist_to=persist_to, database="oscr_forge")
            plan = push_traced(con, d1, state, target, budget=community.DAILY_BUDGET if budget is None else budget,
                               reader=reader, now=now, report=report)
            said = write(con, d1, out, state=state, push=False, now=now, report=report)
        except (community.D1Error, LayerError) as e:
            raise SystemExit(f"forge layer ({target}): {e}. Is oscr_forge migrated? "
                             f"npx wrangler d1 migrations apply oscr_forge --{target}"
                             + (" --env local" if target == "local" else "")) from None
        return (f"{target}: {plan.applied} statements applied, {plan.written} rows written"
                + ("" if plan.complete else f"; {plan.deferred} wait for tomorrow's budget") + f"\n{said}")
    finally:
        state.close()
