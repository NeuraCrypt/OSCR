"""Phase 5, accounts: the facts the sign-in's verifications need, projected from the Mac's
database into the D1 community database (`oscr_community`, schema: migrations/d1-community/),
pushed as deltas.

- `paper_orcid`: the ORCID iDs of the authors of the papers that have a page (the owner's
  decisions D2 and D7), with the page's slug and the paper's title. A reader who signs in with
  one of these ORCID iDs becomes a verified author of that paper (website/worker/account/).
- `repo_owner`: the owners of the code repositories of those papers, on the forges whose
  addresses name an owner (github.com/<owner>/<name>, gitlab.com/<group>/…). A GitHub account
  that owns the repository, belongs publicly to the owning organization or contributed to it
  becomes its maintainer.

**Public facts only.** An ORCID iD comes from the paper's own metadata (`paper_author`, as the
site shows it on the paper's page), never from the private contact table; it is kept only
with a valid check digit. Titles go through `entities.strip_contacts`. Nothing about the
accounts flows back here.

**Deltas only.** The state file (`data/community/state.db`, not the harvester's database,
which the public export copies) keeps a hash of every row pushed to each target
(`community_sync`): a push sends the rows that changed, deletes the rows that left, and records
each file once the target accepted it.

**Budget.** D1's free plan writes 100,000 rows a day for the whole account, the catalogue's
projection (oscr/d1.py, Phase 3) and the Worker's own writes included. This push spends at most
`budget` rows a day (default 10,000; `community_budget` keeps the count): deletions first, then
new rows, then changed ones; the rest goes next time. Both tables are WITHOUT ROWID with no
other index, so a statement writes one row.

**Targets.** `local` only: the local D1 of `wrangler dev` (`wrangler d1 execute --local
--file`). The remote database waits for the owner's approval (docs/ACCOUNTS.md).

    oscr community build --local     the delta as SQL files, sent nowhere
    oscr community push --local      the same, applied to the local D1, then recorded
    oscr community status            what each target holds, and the rows written per day
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import catalog, entities

DATABASE = "oscr_community"
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations" / "d1-community"
WEBSITE = ROOT / "website"
#: How `wrangler` finds the local database: the site's `[env.local]` (website/wrangler.toml),
#: whose persisted state (website/.wrangler/state) `wrangler dev --env local` reads.
WRANGLER_LOCAL: tuple[str, ...] = ("--env", "local")

#: Rows a day for this push; D1's free plan writes 100,000 for the whole account.
DAILY_BUDGET = 10_000
#: Statements per file for `wrangler d1 execute --file`.
FILE_STATEMENTS = 1_000
#: The forges whose repository keys read <host>/<owner>/<name>: the owner is in the address.
FORGES: frozenset[str] = frozenset({
    "github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "gin.g-node.org", "gitee.com", "framagit.org",
})
#: A title is cut to this length: the account page lists titles, never whole abstracts.
MAX_TITLE = 500
#: The tables, and their key columns.
KEYS: dict[str, tuple[str, ...]] = {"paper_orcid": ("orcid", "paper_id"), "repo_owner": ("repo",)}

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS community_sync (
    target     TEXT NOT NULL,          -- local (remote: once the owner approves it)
    tbl        TEXT NOT NULL,          -- paper_orcid | repo_owner
    key        TEXT NOT NULL,
    hash       TEXT NOT NULL,
    pushed_at  REAL NOT NULL,
    PRIMARY KEY (target, tbl, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS community_budget (
    target  TEXT NOT NULL,
    day     TEXT NOT NULL,             -- the UTC day, as D1 counts it
    rows    INTEGER NOT NULL,
    PRIMARY KEY (target, day)
);
CREATE TABLE IF NOT EXISTS community_push (
    target      TEXT NOT NULL,
    at          REAL NOT NULL,
    statements  INTEGER NOT NULL,
    rows        INTEGER NOT NULL,
    complete    INTEGER NOT NULL,
    summary     TEXT NOT NULL
);
"""


def open_state(path: Path | str) -> sqlite3.Connection:
    """The push's own state: hashes of the rows pushed, rows written per day, the pushes."""
    path = Path(path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(STATE_SCHEMA)
    return con


# ---------------------------------------------------------------------------------------
# The facts.

@dataclass(frozen=True)
class Row:
    table: str
    key: str
    values: dict[str, Any]

    @property
    def hash(self) -> str:
        text = json.dumps([self.table, self.values], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]


def _key(table: str, values: dict[str, Any]) -> str:
    cols = KEYS[table]
    return values[cols[0]] if len(cols) == 1 else json.dumps([values[c] for c in cols], ensure_ascii=False)


def _title(text: str | None) -> str:
    t = re.sub(r"\s+", " ", entities.strip_contacts(text or "")).strip()
    return t if len(t) <= MAX_TITLE else t[:MAX_TITLE - 1].rstrip() + "…"


def owner_of(repo: str) -> tuple[str, str] | None:
    """("github.com", "owner") for "github.com/owner/name"; None when the key names no owner
    (a Zenodo record, an OSF project, an account without a repository)."""
    parts = repo.split("/")
    if len(parts) < 3 or not parts[1] or not parts[2]:
        return None
    host = parts[0].lower()
    # A self-hosted GitLab (gitlab.<institution>), as oscr/links.py recognizes one; never the
    # pages of a GitLab site (*.gitlab.io), which are documentation.
    gitlab = host.startswith("gitlab.") or (".gitlab." in host and not host.endswith(".gitlab.io"))
    if host not in FORGES and not gitlab:
        return None
    return host, parts[1].lower()


def facts(con: sqlite3.Connection) -> dict[str, dict[str, Row]]:
    """The rows D1 must hold: table → key → row."""
    out: dict[str, dict[str, Row]] = {table: {} for table in KEYS}
    for r in con.execute(f"SELECT pa.orcid, a.id, a.title FROM paper_author pa JOIN article a ON a.id = pa.article_id "
                         f"WHERE pa.orcid != '' AND a.id IN ({entities.PAGES_SQL}) ORDER BY a.id, pa.position"):
        orcid = entities.orcid(r["orcid"])
        if not orcid:
            continue          # no valid check digit: a typo in the metadata, not an identity
        values = {"orcid": orcid, "paper_id": r["id"], "slug": catalog.slug(r["id"]), "title": _title(r["title"])}
        row = Row("paper_orcid", _key("paper_orcid", values), values)
        out["paper_orcid"].setdefault(row.key, row)
    for r in con.execute(f"SELECT DISTINCT repo FROM link WHERE role = 'code' AND article_id IN ({entities.PAGES_SQL}) "
                         f"ORDER BY repo"):
        owned = owner_of(r["repo"])
        if owned is None:
            continue
        values = {"repo": r["repo"].lower(), "host": owned[0], "owner": owned[1]}
        out["repo_owner"].setdefault(values["repo"], Row("repo_owner", values["repo"], values))
    return out


# ---------------------------------------------------------------------------------------
# SQL.

def literal(value: Any) -> str:
    """An SQL literal: the files carry their values, as `wrangler d1 execute --file` takes them."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value) if math.isfinite(value) else "NULL"
    return "'" + str(value).replace("\x00", "").replace("'", "''") + "'"


def upsert(row: Row) -> str:
    cols = list(row.values)
    keys = KEYS[row.table]
    sets = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in keys)
    values = ", ".join(literal(row.values[c]) for c in cols)
    return (f"INSERT INTO {row.table} ({', '.join(cols)}) VALUES ({values}) "
            f"ON CONFLICT ({', '.join(keys)}) DO UPDATE SET {sets};")


def delete(table: str, key: str) -> str:
    cols = KEYS[table]
    values = [key] if len(cols) == 1 else json.loads(key)
    where = " AND ".join(f"{c} = {literal(v)}" for c, v in zip(cols, values, strict=True))
    return f"DELETE FROM {table} WHERE {where};"


@dataclass
class Statement:
    table: str
    key: str
    #: None for a deletion.
    hash: str | None
    sql: str
    #: Rows D1 counts as written: WITHOUT ROWID tables without a secondary index write one.
    rows: int = 1


@dataclass
class Plan:
    target: str
    statements: list[Statement] = field(default_factory=list)
    new: int = 0
    changed: int = 0
    deleted: int = 0
    #: Statements left for the next push: the day's budget is spent.
    deferred: int = 0
    budget_left: int = 0
    held: dict[str, int] = field(default_factory=dict)
    #: After a push: the statements the target accepted, and the rows written.
    applied: int = 0
    written: int = 0

    @property
    def rows(self) -> int:
        return sum(s.rows for s in self.statements)

    @property
    def complete(self) -> bool:
        return self.deferred == 0

    def describe(self) -> str:
        held = ", ".join(f"{n} {t}" for t, n in sorted(self.held.items()))
        return (f"{self.target}: {len(self.statements)} statements, ~{self.rows} rows written of {self.budget_left} "
                f"left today; {self.new} new, {self.changed} changed, {self.deleted} deleted, {self.deferred} left "
                f"for the next push; D1 then holds {held or 'nothing'}")


def utc_day(t: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t if t is not None else time.time()))


def budget_spent(state: sqlite3.Connection, target: str, day: str) -> int:
    r = state.execute("SELECT rows FROM community_budget WHERE target = ? AND day = ?", (target, day)).fetchone()
    return r["rows"] if r else 0


def build(con: sqlite3.Connection, state: sqlite3.Connection, target: str = "local", *,
          budget: int = DAILY_BUDGET, now: float | None = None) -> Plan:
    """What the next push to `target` sends: the rows that changed, within what is left of
    today's budget."""
    wanted = facts(con)
    synced: dict[tuple[str, str], str] = {
        (r["tbl"], r["key"]): r["hash"]
        for r in state.execute("SELECT tbl, key, hash FROM community_sync WHERE target = ?", (target,))}
    plan = Plan(target, budget_left=max(0, budget - budget_spent(state, target, utc_day(now))))
    todo: list[tuple[str, Statement]] = []
    # 1. What left: a paper without a page any more, an author removed, a repository no longer cited.
    for table, key in sorted(k for k in synced if k[1] not in wanted.get(k[0], {})):
        todo.append(("deleted", Statement(table, key, None, delete(table, key))))
    # 2. What is new, 3. what changed.
    new, changed = [], []
    for table in KEYS:
        for key, row in sorted(wanted[table].items()):
            before = synced.get((table, key))
            if before == row.hash:
                continue
            (new if before is None else changed).append(("new" if before is None else "changed",
                                                         Statement(table, key, row.hash, upsert(row))))
    todo += new + changed
    used = 0
    for kind, s in todo:
        if plan.deferred or used + s.rows > plan.budget_left:
            plan.deferred += 1        # the rest waits, in the same order
            continue
        used += s.rows
        plan.statements.append(s)
        setattr(plan, kind, getattr(plan, kind) + 1)
    after = dict(synced)
    for s in plan.statements:
        if s.hash is None:
            after.pop((s.table, s.key), None)
        else:
            after[(s.table, s.key)] = s.hash
    plan.held = {table: sum(1 for (t, _) in after if t == table) for table in KEYS}
    return plan


# ---------------------------------------------------------------------------------------
# Files, and what the target accepted.

def chunks(plan: Plan, size: int | None = None) -> list[list[Statement]]:
    size = size or FILE_STATEMENTS
    return [plan.statements[i:i + size] for i in range(0, len(plan.statements), size)]


def write(plan: Plan, folder: Path, *, now: float | None = None) -> list[tuple[Path, list[Statement]]]:
    """The plan as SQL files: `<folder>/<target>-<time>/NNN-oscr_community.sql`."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now if now is not None else time.time()))
    out = folder / f"{plan.target}-{stamp}"
    out.mkdir(parents=True, exist_ok=True)
    files = []
    for i, part in enumerate(chunks(plan), 1):
        path = out / f"{i:03d}-{DATABASE}.sql"
        path.write_text("\n".join(s.sql for s in part) + "\n", encoding="utf-8")
        files.append((path, part))
    return files


def record(state: sqlite3.Connection, target: str, statements: list[Statement], rows_written: int, *,
           now: float | None = None) -> None:
    """Statements the target accepted: their rows are now known there, and today's budget spent."""
    t = now if now is not None else time.time()
    for s in statements:
        if s.hash is None:
            state.execute("DELETE FROM community_sync WHERE target = ? AND tbl = ? AND key = ?", (target, s.table, s.key))
        else:
            state.execute("INSERT OR REPLACE INTO community_sync (target, tbl, key, hash, pushed_at) VALUES (?,?,?,?,?)",
                          (target, s.table, s.key, s.hash, t))
    state.execute("INSERT INTO community_budget (target, day, rows) VALUES (?, ?, ?) ON CONFLICT (target, day) "
                  "DO UPDATE SET rows = rows + excluded.rows", (target, utc_day(t), rows_written))
    state.commit()


class PushError(RuntimeError):
    pass


def _wrangler(args: list[str], website: Path) -> str:
    cmd = ["npx", "wrangler", *args]
    r = subprocess.run(cmd, cwd=website, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise PushError(f"{' '.join(cmd[:6])} failed: " + (r.stderr or r.stdout).strip()[-800:])
    return r.stdout


def migrate_local(website: Path = WEBSITE, config: tuple[str, ...] = WRANGLER_LOCAL) -> None:
    """The local D1 at the schema of migrations/d1-community/."""
    _wrangler(["d1", "migrations", "apply", DATABASE, "--local", *config], website)


def apply_local(path: Path, website: Path = WEBSITE, config: tuple[str, ...] = WRANGLER_LOCAL) -> None:
    """One file into the local D1: `wrangler d1 execute oscr_community --local --file`."""
    _wrangler(["d1", "execute", DATABASE, "--local", *config, "--file", str(path.resolve()), "--yes"], website)


def push(con: sqlite3.Connection, state: sqlite3.Connection, target: str, *, folder: Path,
         budget: int = DAILY_BUDGET, website: Path = WEBSITE,
         apply: Callable[[Path], None] | None = None, migrate: Callable[[], None] | None = None,
         report: Callable[[str], None] = print) -> Plan:
    """Build the delta, apply it file by file, record each file the target accepted. A failed
    file stops the push: what was accepted stays recorded, the rest goes next time."""
    if target != "local":
        raise PushError("only the local D1 exists until the owner approves the remote one (docs/ACCOUNTS.md)")
    plan = build(con, state, target, budget=budget)
    report(plan.describe())
    started, done, written = time.time(), 0, 0
    files = write(plan, folder)
    (migrate or (lambda: migrate_local(website)))()
    send = apply or (lambda p: apply_local(p, website))
    try:
        for path, statements in files:
            send(path)
            rows = sum(s.rows for s in statements)
            record(state, target, statements, rows)
            done += len(statements)
            written += rows
    finally:
        state.execute("INSERT INTO community_push (target, at, statements, rows, complete, summary) VALUES (?,?,?,?,?,?)",
                      (target, started, done, written, int(plan.complete and done == len(plan.statements)),
                       plan.describe()))
        state.commit()
    plan.applied, plan.written = done, written
    return plan


def status(state: sqlite3.Connection) -> str:
    lines = []
    for r in state.execute("SELECT target, tbl, COUNT(*) AS n FROM community_sync GROUP BY 1, 2 ORDER BY 1, 2"):
        lines.append(f"{r['target']}: {DATABASE}.{r['tbl']}: {r['n']} rows")
    for r in state.execute("SELECT target, day, rows FROM community_budget ORDER BY day DESC, target LIMIT 6"):
        lines.append(f"{r['target']}: {r['rows']} rows written on {r['day']} (UTC)")
    for r in state.execute("SELECT * FROM community_push ORDER BY at DESC LIMIT 3"):
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(r["at"]))
        lines.append(f"push {when}: {r['summary']}")
    return "\n".join(lines) or "nothing pushed yet"


def command(con: sqlite3.Connection, action: str, *, local: bool, folder: Path,
            budget: int | None = None) -> str:
    """`oscr community build|push --local`, `oscr community status`."""
    state = open_state(folder / "state.db")
    try:
        if action == "status":
            return status(state)
        if not local:
            raise SystemExit(f"community {action}: add --local (the remote database waits for the owner's "
                             f"approval, docs/ACCOUNTS.md)")
        if action == "build":
            plan = build(con, state, "local", budget=DAILY_BUDGET if budget is None else budget)
            files = write(plan, folder)
            return plan.describe() + "".join(f"\n  {path}" for path, _ in files)
        try:
            plan = push(con, state, "local", folder=folder, budget=DAILY_BUDGET if budget is None else budget)
        except PushError as e:
            raise SystemExit(str(e)) from None
        return f"local: {plan.applied} statements applied, {plan.written} rows written" + (
            "" if plan.complete else f"; {plan.deferred} wait for tomorrow's budget")
    finally:
        state.close()
