"""Security and quality facts, computed on the Mac (night phase 11; docs/SECURITY_QUALITY.md).

This module reads the repositories the registry knows (the ``repos`` rows of the GitHub side's D1
database ``oscr_forge``), reads their environment files as **text** through the read-only forge
reader (oscr/forge.py: a hardened, partial, shallow clone; nothing is built, installed or run), and
pushes facts to ``oscr_forge``:

- **the dependency graph** (E1, oscr/depgraph.py): one ``repo_deps`` row per dependency, at the
  default branch's head and at each commit a paper's tracing map pins.

Later elements (the OSV alerts, the secrets scan, the licence compatibility) add their own scan and
push here, the same way.

Nothing here runs a manifest or a resolver, opens a socket to analyse, or keeps a secret's value.
Every write counts against the facts push's daily budget (``community_budget``), like the rest of the
Mac's facts (oscr/forgelayer.py).
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from . import community, depgraph, forge

#: The most of one manifest the reader fetches (a lock file can be large; the graph needs its text).
MANIFEST_BYTES = 400_000
#: The most manifest files read in one repository (a monorepo can hold many).
MAX_MANIFESTS = 60
#: The most dependency rows kept per repository per snapshot (bounds the day's rows).
MAX_DEPS = 600
#: Statements sent to D1 in one call (as the rest of the facts push).
CHUNK = community.REMOTE_STATEMENTS


@dataclass
class Repo:
    forge: str
    repo_id: str
    owner: str
    name: str
    head: str


def active_repos(d1: community.D1) -> list[Repo]:
    """The public GitHub repositories the registry follows, with a known head."""
    rows = d1.query("SELECT forge, repo_id, owner_login, name, head FROM repos "
                    "WHERE forge = 'github' AND state = 'active' AND head IS NOT NULL AND head != '' "
                    "ORDER BY forge, repo_id")
    return [Repo(r["forge"], r["repo_id"], r["owner_login"], r["name"], r["head"]) for r in rows]


def cited_commits(d1: community.D1, forge_name: str, repo_id: str) -> list[str]:
    """The commits a paper's tracing map pins for this repository (the 'cited' snapshots)."""
    rows = d1.query(f"SELECT DISTINCT commit_sha FROM traced_paths WHERE forge = {community.literal(forge_name)} "
                    f"AND repo_id = {community.literal(repo_id)} ORDER BY commit_sha")
    return [r["commit_sha"] for r in rows if r["commit_sha"]]


def read_manifests(reader: forge.ForgeReader, ref: forge.RepoRef, sha: str) -> dict[str, str]:
    """The environment files of a commit, as text. Reads nothing it cannot parse as a manifest; caps
    the number of files and each file's size. A file it cannot fetch is skipped, never fatal."""
    try:
        paths = [p for p in reader.files(ref, sha) if depgraph.is_manifest(p)]
    except forge.ForgeError:
        return {}
    files: dict[str, str] = {}
    for path in sorted(paths)[:MAX_MANIFESTS]:
        try:
            data = reader.read(ref, sha, path, max_bytes=MANIFEST_BYTES)
        except forge.ForgeError:
            continue
        files[path] = data.decode("utf-8", "replace")
    return files


def scan_deps(reader: forge.ForgeReader, ref: forge.RepoRef, sha: str) -> list[depgraph.Node]:
    """The dependency graph of a commit (default or cited)."""
    return depgraph.graph(read_manifests(reader, ref, sha))[:MAX_DEPS]


def deps_statements(forge_name: str, repo_id: str, snapshot: str, nodes: list[depgraph.Node],
                    commit_sha: str, now: int) -> list[str]:
    """SQL that replaces a repository's dependency rows for one snapshot (delete then insert)."""
    out = [f"DELETE FROM repo_deps WHERE forge = {community.literal(forge_name)} "
           f"AND repo_id = {community.literal(repo_id)} AND snapshot = {community.literal(snapshot)};"]
    for n in nodes:
        values = {
            "forge": forge_name, "repo_id": repo_id, "snapshot": snapshot, "ecosystem": n.ecosystem,
            "name": n.name[:214], "version": n.version[:100], "req": n.constraint[:200], "scope": n.scope,
            "direct": 1 if n.direct else 0, "pinned": 1 if n.pinned else 0,
            "sources": json.dumps(n.sources[:20], ensure_ascii=False)[:2000],
            "commit_sha": commit_sha, "computed_at": now,
        }
        cols = ", ".join(values)
        vals = ", ".join(community.literal(v) for v in values.values())
        out.append(f"INSERT INTO repo_deps ({cols}) VALUES ({vals});")
    return out


def _flush(d1: community.D1, statements: list[str], state: sqlite3.Connection, target: str,
           now: int) -> int:
    """Send statements in chunks, counting the rows against the day's budget."""
    written = 0
    for i in range(0, len(statements), CHUNK):
        chunk = statements[i:i + CHUNK]
        n = d1.run(chunk)
        written += n
        if state is not None and target:
            community.spend(state, target, n, now=now)
    return written


def command(con: sqlite3.Connection | None, action: str, *, target: str | None,
            folder: Path = Path("data") / "community", budget: int = community.DAILY_BUDGET,
            settings: dict | None = None, persist_to: Path | None = None,
            reader: forge.ForgeReader | None = None, now: float | None = None,
            report=lambda _m: None) -> str:
    """`oscr security <action>`.

    - ``scan``: read each known repository's environment files (default branch and cited commits),
      compute the dependency graph, and push ``repo_deps`` to ``oscr_forge`` within the day's budget.
    - ``status``: what the database holds.
    """
    t = int(time.time() if now is None else now)
    d1 = community.open_d1(target, settings=settings or {}, persist_to=persist_to, database="oscr_forge")
    if action == "status":
        rows = d1.query("SELECT snapshot, count(*) AS n FROM repo_deps GROUP BY snapshot")
        n = sum(r["n"] for r in rows)
        repos = d1.query("SELECT count(DISTINCT repo_id) AS r FROM repo_deps")[0]["r"]
        return f"security: {n} dependency rows over {repos} repositories" if n else "security: no dependency facts yet"
    if action != "scan":
        raise SystemExit(f"security: unknown action {action!r} (scan, status)")

    reader = reader if reader is not None else forge.reader("github")
    state = community.open_state((folder if folder else Path("data") / "community") / "state.db")
    spent = community.budget_spent(state, target or "local", community.utc_day(t))
    left = max(0, budget - spent)
    repos = active_repos(d1)
    done = depped = 0
    for repo in repos:
        if left <= 0:
            report(f"security: the day's budget ({budget}) is spent; {len(repos) - done} repositories left for tomorrow")
            break
        ref = forge.RepoRef(repo.forge, repo.owner, repo.name)
        statements: list[str] = []
        try:
            default = scan_deps(reader, ref, repo.head)
        except forge.ForgeError as e:
            report(f"security: {repo.owner}/{repo.name}: {e}")
            done += 1
            continue
        statements += deps_statements(repo.forge, repo.repo_id, "default", default, repo.head, t)
        for sha in cited_commits(d1, repo.forge, repo.repo_id):
            if sha == repo.head:
                continue
            try:
                cited = scan_deps(reader, ref, sha)
            except forge.ForgeError:
                continue
            statements += deps_statements(repo.forge, repo.repo_id, "cited", cited, sha, t)
        if len(statements) > left:
            report(f"security: the day's budget ({budget}) is spent; {len(repos) - done} repositories left for tomorrow")
            break
        written = _flush(d1, statements, state, target or "local", t)
        left -= written
        done += 1
        depped += len(default)
    state.close()
    return f"security: scanned {done} repositories, {depped} direct-and-transitive dependencies at their heads"
