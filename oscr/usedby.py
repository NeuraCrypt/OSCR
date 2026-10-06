"""Repository statistics the registry alone has (night phase 12, E3; docs/STATISTICS.md).

GitHub's own statistics (Pulse, contributors, commits, code frequency) are read by the reader's
browser straight from GitHub (0 Worker and 0 Mac requests, D12-1), so they are not here. This module
computes the parts only OSCR has, and pushes them to ``oscr_forge`` the same way the security facts
are pushed (within the day's budget):

- **"Used by"** (D12-2): the papers and the repositories that depend on a repository. The research
  angle is that a **paper** counts, not only a repository. A repository P is "used by" a repository D
  when D's dependency graph (``repo_deps``) names a package P publishes (``repo_packages``,
  confirmed); every paper linked to D then counts as a paper that uses P. One ``repo_stats`` row holds
  the two counts and the star history; a bounded sample of the dependants is in ``repo_dependents``.
- **The research marks** the insights charts overlay: a commit a paper cites (placed at the paper's
  publication day), kept in ``repo_marks``.
- **The star history**: the registry's own stars over time (``stars``), as a small ``[day, total]``
  series in the ``repo_stats`` row.

The pure functions (``reverse_index``, ``used_by``, the ``*_statements`` builders) are tested in
``tests/test_usedby.py``; ``command`` reads D1 and flushes, like ``oscr security``.
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import UTC
from pathlib import Path

from . import community

#: Statements sent to D1 in one call (as the rest of the facts push).
CHUNK = 50
#: At most this many dependants kept per repository for the "Used by" list (the counts are exact).
SAMPLE = 100
#: At most this many points kept in a star-history series (bounded so the row stays small).
STAR_POINTS = 60

#: A public package registry (repo_packages.registry) mapped to the dependency ecosystem that names
#: it in a dependency graph (repo_deps.ecosystem).
REGISTRY_ECOSYSTEM = {"pypi": "PyPI", "cran": "CRAN", "conda-forge": "conda", "julia": "Julia", "npm": "npm"}


@dataclass(frozen=True)
class Repo:
    forge: str
    repo_id: str
    owner: str
    name: str


@dataclass(frozen=True)
class Paper:
    doi: str
    slug: str
    title: str


@dataclass
class UsedBy:
    papers: dict[str, Paper] = field(default_factory=dict)   # by doi, deduplicated
    repos: dict[str, Repo] = field(default_factory=dict)     # by repo_id, deduplicated
    via: dict[str, str] = field(default_factory=dict)        # dependant key -> "ecosystem:name"


def norm(ecosystem: str, name: str) -> str:
    """A package name normalised for matching: lower case, and for the registries that treat ``-``,
    ``_`` and ``.`` alike (PyPI, conda), those folded to ``-``. npm, CRAN and Julia match on the plain
    lower-case name."""
    key = name.strip().lower()
    if ecosystem in ("PyPI", "conda"):
        for ch in ("_", "."):
            key = key.replace(ch, "-")
    return f"{ecosystem}:{key}"


def reverse_index(deps: list[tuple[str, str, str]]) -> dict[str, set[str]]:
    """Map each normalised package key to the repo_ids whose graph names it.

    ``deps`` is ``(repo_id, ecosystem, name)`` rows (the default-branch snapshot)."""
    index: dict[str, set[str]] = {}
    for repo_id, ecosystem, name in deps:
        index.setdefault(norm(ecosystem, name), set()).add(repo_id)
    return index


def used_by(
    repos: dict[str, Repo],
    packages: list[tuple[str, str, str]],
    deps: list[tuple[str, str, str]],
    papers: dict[str, list[Paper]],
) -> dict[str, UsedBy]:
    """Who depends on each repository.

    - ``repos``: repo_id -> Repo (the active repositories).
    - ``packages``: ``(repo_id, registry, name)`` confirmed packages.
    - ``deps``: ``(repo_id, ecosystem, name)`` default-branch dependencies.
    - ``papers``: repo_id -> the papers linked to that repository.
    """
    index = reverse_index(deps)
    out: dict[str, UsedBy] = {}
    for repo_id, registry, name in packages:
        if repo_id not in repos:
            continue
        ecosystem = REGISTRY_ECOSYSTEM.get(registry)
        if not ecosystem:
            continue
        key = norm(ecosystem, name)
        via = f"{ecosystem}:{name.strip().lower()}"
        dependants = index.get(key, set())
        for dep_repo_id in dependants:
            if dep_repo_id == repo_id:
                continue  # a repository never uses itself
            u = out.setdefault(repo_id, UsedBy())
            if dep_repo_id in repos:
                u.repos.setdefault(dep_repo_id, repos[dep_repo_id])
                u.via.setdefault(f"repo:{dep_repo_id}", via)
            for paper in papers.get(dep_repo_id, []):
                u.papers.setdefault(paper.doi, paper)
                u.via.setdefault(f"paper:{paper.doi}", via)
    return out


# ─── the statements ───────────────────────────────────────────────────────────

def stats_statements(forge: str, repo_id: str, papers: int, repos: int,
                     stars: list[tuple[int, int]], now: int) -> list[str]:
    """One ``repo_stats`` row: the two "Used by" counts and the star history."""
    series = [[day, total] for day, total in stars][-STAR_POINTS:]
    values = {
        "forge": forge, "repo_id": repo_id, "usedby_papers": papers, "usedby_repos": repos,
        "stars": json.dumps(series)[:4000], "computed_at": now,
    }
    cols = ", ".join(values)
    vals = ", ".join(community.literal(v) for v in values.values())
    return [f"INSERT OR REPLACE INTO repo_stats ({cols}) VALUES ({vals});"]


def dependents_statements(forge: str, repo_id: str, u: UsedBy, now: int, sample: int = SAMPLE) -> list[str]:
    """Replace a repository's dependant sample (delete then insert, papers before repositories)."""
    out = [f"DELETE FROM repo_dependents WHERE forge = {community.literal(forge)} "
           f"AND repo_id = {community.literal(repo_id)};"]
    rows: list[dict] = []
    for paper in u.papers.values():
        rows.append({
            "forge": forge, "repo_id": repo_id, "dep_kind": "paper", "dep_ref": paper.doi,
            "via": u.via.get(f"paper:{paper.doi}", "")[:260], "owner": "", "name": "",
            "slug": paper.slug[:300], "title": paper.title[:500], "computed_at": now,
        })
    for dep in u.repos.values():
        rows.append({
            "forge": forge, "repo_id": repo_id, "dep_kind": "repo", "dep_ref": dep.repo_id,
            "via": u.via.get(f"repo:{dep.repo_id}", "")[:260], "owner": dep.owner[:100], "name": dep.name[:100],
            "slug": "", "title": "", "computed_at": now,
        })
    for row in rows[:sample]:
        cols = ", ".join(row)
        vals = ", ".join(community.literal(v) for v in row.values())
        out.append(f"INSERT INTO repo_dependents ({cols}) VALUES ({vals});")
    return out


def marks_statements(forge: str, repo_id: str, marks: list[tuple[str, str, int, str]], now: int) -> list[str]:
    """Replace a repository's research marks (delete then insert). A mark is
    ``(kind, ref, t, label)``; the label is masked for email addresses by the caller."""
    out = [f"DELETE FROM repo_marks WHERE forge = {community.literal(forge)} "
           f"AND repo_id = {community.literal(repo_id)};"]
    for kind, ref, t, label in marks:
        values = {
            "forge": forge, "repo_id": repo_id, "kind": kind, "ref": ref[:300],
            "t": int(t), "label": label[:500], "computed_at": now,
        }
        cols = ", ".join(values)
        vals = ", ".join(community.literal(v) for v in values.values())
        out.append(f"INSERT INTO repo_marks ({cols}) VALUES ({vals});")
    return out


# ─── reading the facts and flushing (oscr usedby) ───────────────────────────────

def _flush(d1: community.D1, statements: list[str], state: sqlite3.Connection | None, target: str, now: int) -> int:
    written = 0
    for i in range(0, len(statements), CHUNK):
        n = d1.run(statements[i:i + CHUNK])
        written += n
        if state is not None and target:
            community.spend(state, target, n, now=now)
    return written


def star_history(rows: list[tuple[str, int]]) -> dict[str, list[tuple[int, int]]]:
    """Cumulative registry stars per repository per day, from ``(subject, at)`` rows whose subject is
    ``repo:<forge>:<id>``. The series is bounded by the caller (STAR_POINTS)."""
    by_repo: dict[str, list[int]] = {}
    for subject, at in rows:
        parts = subject.split(":")
        if len(parts) != 3 or parts[0] != "repo":
            continue
        by_repo.setdefault(parts[2], []).append(int(at))
    out: dict[str, list[tuple[int, int]]] = {}
    for repo_id, times in by_repo.items():
        times.sort()
        series: list[tuple[int, int]] = []
        total = 0
        for at in times:
            total += 1
            day = (at // 86400) * 86400
            if series and series[-1][0] == day:
                series[-1] = (day, total)
            else:
                series.append((day, total))
        out[repo_id] = series
    return out


def command(con: sqlite3.Connection | None, action: str, *, target: str | None,
            folder: Path = Path("data") / "community", budget: int = community.DAILY_BUDGET,
            settings: dict | None = None, persist_to: Path | None = None,
            now: float | None = None, report=lambda _m: None) -> str:
    """`oscr usedby <action>`.

    - ``scan``: compute "Used by", the star history and the paper research marks from the facts
      already in ``oscr_forge`` (and the catalogue, for a paper's slug, title and date), and push the
      three statistics tables within the day's budget.
    - ``status``: what the statistics tables hold.
    """
    t = int(time.time() if now is None else now)
    d1 = community.open_d1(target, settings=settings or {}, persist_to=persist_to, database="oscr_forge")
    if action == "status":
        stats = d1.query("SELECT count(*) AS n FROM repo_stats")[0]["n"]
        deps = d1.query("SELECT count(*) AS n FROM repo_dependents")[0]["n"]
        marks = d1.query("SELECT count(*) AS n FROM repo_marks")[0]["n"]
        return f"usedby: {stats} repositories with statistics, {deps} dependant rows, {marks} research marks"
    if action != "scan":
        raise SystemExit(f"usedby: unknown action {action!r} (scan, status)")

    repos = {r["repo_id"]: Repo(r["forge"], r["repo_id"], r["owner_login"] or "", r["name"] or "")
             for r in d1.query("SELECT forge, repo_id, owner_login, name FROM repos WHERE state = 'active'")}
    packages = [(r["repo_id"], r["registry"], r["name"])
                for r in d1.query("SELECT repo_id, registry, name FROM repo_packages WHERE status = 'confirmed'")]
    deps = [(r["repo_id"], r["ecosystem"], r["name"])
            for r in d1.query("SELECT repo_id, ecosystem, name FROM repo_deps WHERE snapshot = 'default'")]
    links = d1.query("SELECT repo_id, paper_id FROM repo_papers WHERE status = 'linked'")
    papers: dict[str, list[Paper]] = {}
    traced = d1.query("SELECT repo_id, paper_id, commit_sha FROM traced_paths")
    for row in links:
        doi = row["paper_id"]
        slug, title, _ = _paper_meta(con, doi)
        papers.setdefault(row["repo_id"], []).append(Paper(doi, slug, title))

    usage = used_by(repos, packages, deps, papers)
    stars = star_history([(r["subject"], r["at"]) for r in d1.query("SELECT subject, at FROM stars")])
    marks_by_repo = _paper_marks(con, traced)

    state = community.open_state((folder if folder else Path("data") / "community") / "state.db")
    spent = community.budget_spent(state, target or "local", community.utc_day(t))
    left = max(0, budget - spent)
    written = done = 0
    for repo_id, repo in repos.items():
        if left <= 0:
            report(f"usedby: the day's budget ({budget}) is spent; stopping")
            break
        u = usage.get(repo_id, UsedBy())
        statements = stats_statements(repo.forge, repo_id, len(u.papers), len(u.repos), stars.get(repo_id, []), t)
        statements += dependents_statements(repo.forge, repo_id, u, t)
        statements += marks_statements(repo.forge, repo_id, marks_by_repo.get(repo_id, []), t)
        if len(statements) > left:
            report(f"usedby: the day's budget ({budget}) is nearly spent; stopping before {repo.owner}/{repo.name}")
            break
        n = _flush(d1, statements, state, target or "local", t)
        written += n
        left -= n
        done += 1
    return f"usedby: wrote statistics for {done} repositories ({written} rows)"


def _paper_meta(con: sqlite3.Connection | None, doi: str) -> tuple[str, str, int]:
    """A paper's (slug, title, publication day in Unix seconds), best effort from the catalogue; empty
    on any failure (the count is what matters; the page links by DOI lookup when the title is unknown)."""
    if con is None:
        return "", "", 0
    article_id = doi if doi.startswith("doi:") else f"doi:{doi}"
    try:
        from . import catalog
        row = con.execute("SELECT id, title, date FROM article WHERE id = ? OR id = ?",
                           (article_id, article_id.replace("doi:", ""))).fetchone()
        if not row:
            return "", "", 0
        slug = catalog.slug(row[0])
        day = _day_of(row[2]) if len(row) > 2 else 0
        return slug, (row[1] or "")[:500], day
    except sqlite3.Error:
        return "", "", 0
    except Exception:  # noqa: BLE001 - the catalogue is best effort here
        return "", "", 0


def _day_of(value) -> int:
    """A catalogue date (an ISO string or a Unix time) as Unix seconds, or 0."""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    try:
        from datetime import datetime
        text = str(value)[:10]
        return int(datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=UTC).timestamp())
    except (ValueError, TypeError):
        return 0


def _paper_marks(con: sqlite3.Connection | None, traced: list[dict]) -> dict[str, list[tuple[str, str, int, str]]]:
    """One research mark per (repository, paper) the tracing maps point to, placed on the chart at the
    paper's publication day. The label is the paper's title and DOI (no email address to mask: a DOI
    and a title carry none)."""
    out: dict[str, list[tuple[str, str, int, str]]] = {}
    seen: set[tuple[str, str]] = set()
    for row in traced:
        repo_id, doi = row["repo_id"], row["paper_id"]
        if (repo_id, doi) in seen:
            continue
        seen.add((repo_id, doi))
        slug, title, day = _paper_meta(con, doi)
        if not day:
            continue  # without a date the mark cannot be placed on the time axis
        label = f"{title} ({doi})" if title else doi
        out.setdefault(repo_id, []).append(("paper", doi, day, label[:500]))
    return out
