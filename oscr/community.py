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
- `paper_repo` (Phase 6): which of those repositories is the code of which paper. A maintainer
  of the repository may correct the paper's record (website/worker/contributions/).

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

**Targets.** `local`: the local D1 of `wrangler dev` (`wrangler d1 execute --local --file`).
`remote`: the Cloudflare database, as `oscr d1 push --remote` reaches the search's — through
the REST API when a token (`CLOUDFLARE_D1_TOKEN` or the keychain's `org.oscr.cloudflare-d1`)
and the ids (`OSCR_D1_ACCOUNT_ID`, `OSCR_D1_COMMUNITY_ID` in the settings) are there, otherwise
with `wrangler d1 execute oscr_community --remote --file` under wrangler's own login. `oscr
nightly` pushes there once `OSCR_COMMUNITY_PUSH=remote` is in the settings.

    oscr community build --local     the delta as SQL files, sent nowhere
    oscr community push --local      the same, applied to the local D1, then recorded
    oscr community push --remote     the same, to the Cloudflare database
    oscr community status            what each target holds, and the rows written per day

**The database, read and written** (`D1`, `open_d1`): the job runner (oscr/jobs.py, Phase 6)
reads the requests of the site's readers and writes the outcomes back through the same two
paths, and counts its rows in the same daily budget. The same paths reach the GitHub side's
database, `oscr_forge` (night phase 01; migrations/d1-forge/, docs/FORGE.md), for
oscr/forgejobs.py and oscr/forgelayer.py: `open_d1(target, database="oscr_forge")`, with
`OSCR_D1_FORGE_ID` in the settings for the REST API. The default stays `oscr_community`.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import sqlite3
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import catalog, entities

DATABASE = "oscr_community"
#: The D1 databases the Mac reads and writes, each with the settings key of its id for the REST API
#: (the account id is OSCR_D1_ACCOUNT_ID for both). `oscr_forge`: the GitHub side (night phase 01).
DATABASES: dict[str, str] = {"oscr_community": "OSCR_D1_COMMUNITY_ID", "oscr_forge": "OSCR_D1_FORGE_ID"}
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
KEYS: dict[str, tuple[str, ...]] = {"paper_orcid": ("orcid", "paper_id"), "repo_owner": ("repo",),
                                    "paper_repo": ("repo", "paper_id")}
#: Statements per call of the REST API: a call stays well under its limits (30 s, 100 KB).
REMOTE_STATEMENTS = 100

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS community_sync (
    target     TEXT NOT NULL,          -- local | remote
    tbl        TEXT NOT NULL,          -- paper_orcid | repo_owner | paper_repo
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
    for r in con.execute(f"SELECT DISTINCT article_id, repo FROM link WHERE role = 'code' AND article_id IN "
                         f"({entities.PAGES_SQL}) ORDER BY repo, article_id"):
        owned = owner_of(r["repo"])
        if owned is None:
            continue
        values = {"repo": r["repo"].lower(), "host": owned[0], "owner": owned[1]}
        out["repo_owner"].setdefault(values["repo"], Row("repo_owner", values["repo"], values))
        pair = {"repo": values["repo"], "paper_id": r["article_id"]}
        row = Row("paper_repo", _key("paper_repo", pair), pair)
        out["paper_repo"].setdefault(row.key, row)
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
    # A table of keys only (paper_repo) has nothing to update.
    action = f"DO UPDATE SET {sets}" if sets else "DO NOTHING"
    return f"INSERT INTO {row.table} ({', '.join(cols)}) VALUES ({values}) ON CONFLICT ({', '.join(keys)}) {action};"


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
    #: Rows D1 counts as written: the tables are WITHOUT ROWID without a secondary index.
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


def database_name(database: str) -> str:
    """`database` when the Mac may reach it (DATABASES), else D1Error."""
    if database not in DATABASES:
        raise D1Error(f"unknown D1 database {database!r}: {' or '.join(DATABASES)}")
    return database


def migrate_local(website: Path = WEBSITE, config: tuple[str, ...] = WRANGLER_LOCAL, database: str = DATABASE) -> None:
    """The local D1 at the schema of its migrations (migrations/d1-community/, or d1-forge/)."""
    _wrangler(["d1", "migrations", "apply", database_name(database), "--local", *config], website)


def apply_local(path: Path, website: Path = WEBSITE, config: tuple[str, ...] = WRANGLER_LOCAL,
                database: str = DATABASE) -> None:
    """One file into the local D1: `wrangler d1 execute oscr_community --local --file`."""
    _wrangler(["d1", "execute", database_name(database), "--local", *config, "--file", str(path.resolve()), "--yes"],
              website)


def apply_remote_wrangler(path: Path, website: Path = WEBSITE, database: str = DATABASE) -> None:
    """One file into the Cloudflare database, under wrangler's own login (`npx wrangler login`,
    the one the deployment uses): no API token then. The database is found by name, bound in
    website/wrangler.toml by the owner's tools/setup_cloudflare.sh, which also applies the
    migrations."""
    _wrangler(["d1", "execute", database_name(database), "--remote", "--file", str(path.resolve()), "--yes"], website)


def rest_url(account_id: str, database_id: str) -> str:
    return f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"


def apply_rest(sql: str, *, account_id: str, database_id: str, token: str, post: Callable[..., Any] | None = None) -> list[dict[str, Any]]:
    """Statements into the Cloudflare database through the REST API (POST .../query, run as a
    batch). Returns D1's result of each statement: their rows and `meta.rows_written`."""
    import httpx
    post = post or httpx.post
    r = post(rest_url(account_id, database_id), headers={"Authorization": f"Bearer {token}"}, json={"sql": sql}, timeout=120)
    try:
        body = r.json()
    except ValueError:
        raise PushError(f"D1 answered {r.status_code}, not JSON") from None
    if r.status_code != 200 or not body.get("success"):
        raise PushError(f"D1 answered {r.status_code}: {json.dumps(body.get('errors', body))[:600]}")
    return list(body.get("result") or [])


def remote_settings(settings: dict[str, str] | None, database: str = DATABASE) -> tuple[str, str, str]:
    """The REST API's account id, database id and token, or empty strings: then wrangler's login.
    The database's id is OSCR_D1_COMMUNITY_ID, or OSCR_D1_FORGE_ID for `oscr_forge`."""
    from . import d1
    cfg = settings or {}
    account, ident = cfg.get("OSCR_D1_ACCOUNT_ID", ""), cfg.get(DATABASES[database_name(database)], "")
    return (account, ident, d1.remote_token()) if account and ident else ("", "", "")


def push(con: sqlite3.Connection, state: sqlite3.Connection, target: str, *, folder: Path,
         budget: int = DAILY_BUDGET, website: Path = WEBSITE,
         apply: Callable[[Path], None] | None = None, migrate: Callable[[], None] | None = None,
         settings: dict[str, str] | None = None, post: Callable[..., Any] | None = None,
         report: Callable[[str], None] = print) -> Plan:
    """Build the delta, apply it part by part, record each part the target accepted. A failed
    part stops the push: what was accepted stays recorded, the rest goes next time.

    `local`: SQL files into the local D1 (the migrations first). `remote`: the REST API when its
    ids and token are there (D1 then reports the rows written), else SQL files through wrangler's
    login; the remote migrations are the owner's setup's (tools/setup_cloudflare.sh)."""
    if target not in ("local", "remote"):
        raise PushError(f"unknown target {target!r}: local or remote")
    plan = build(con, state, target, budget=budget)
    report(plan.describe())
    parts: list[tuple[Path | None, list[Statement]]]
    send: Callable[[Path | None, list[Statement]], int | None]
    account, database, token = remote_settings(settings) if target == "remote" else ("", "", "")
    if target == "local":
        parts = list(write(plan, folder))
        (migrate or (lambda: migrate_local(website)))()
        local = apply or (lambda p: apply_local(p, website))

        def send(path: Path | None, _: list[Statement]) -> int | None:
            local(path)           # wrangler does not report the rows of a file: counted from the plan
            return None
    elif account and database and token:
        parts = [(None, part) for part in chunks(plan, REMOTE_STATEMENTS)]

        def send(_: Path | None, statements: list[Statement]) -> int | None:
            results = apply_rest("\n".join(s.sql for s in statements), account_id=account, database_id=database,
                                 token=token, post=post)
            return sum(int((res.get("meta") or {}).get("rows_written") or 0) for res in results)
    else:
        parts = list(write(plan, folder))
        remote = apply or (lambda p: apply_remote_wrangler(p, website))

        def send(path: Path | None, _: list[Statement]) -> int | None:
            remote(path)
            return None
    started, done, written = time.time(), 0, 0
    try:
        for path, statements in parts:
            reported = send(path, statements)
            rows = reported if reported is not None else sum(s.rows for s in statements)
            record(state, target, statements, rows)
            done += len(statements)
            written += rows
    finally:
        state.execute("INSERT INTO community_push (target, at, statements, rows, complete, summary) VALUES (?,?,?,?,?,?)",
                      (target, started, done, written, int(plan.complete and done == len(plan.statements)),
                       plan.describe()))
        state.commit()
    plan.applied, plan.written = done, written
    if target == "remote" and parts and parts[0][0] is not None:
        # Applied: the files of a remote push are not kept (a failed push keeps them).
        shutil.rmtree(parts[0][0].parent, ignore_errors=True)
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


def command(con: sqlite3.Connection, action: str, *, target: str | None, folder: Path,
            budget: int | None = None, settings: dict[str, str] | None = None) -> str:
    """`oscr community build|push --local|--remote`, `oscr community status`."""
    state = open_state(folder / "state.db")
    try:
        if action == "status":
            return status(state)
        if target not in ("local", "remote"):
            raise SystemExit(f"community {action}: add --local (the local D1 of `wrangler dev`) or --remote "
                             f"(the Cloudflare database, docs/ACCOUNTS.md)")
        days_budget = DAILY_BUDGET if budget is None else budget
        if action == "build":
            plan = build(con, state, target, budget=days_budget)
            files = write(plan, folder)
            return plan.describe() + "".join(f"\n  {path}" for path, _ in files)
        try:
            plan = push(con, state, target, folder=folder, budget=days_budget, settings=settings)
        except PushError as e:
            raise SystemExit(str(e)) from None
        return f"{target}: {plan.applied} statements applied, {plan.written} rows written" + (
            "" if plan.complete else f"; {plan.deferred} wait for tomorrow's budget")
    finally:
        state.close()


# ---------------------------------------------------------------------------------------
# The database, read and written by the job runner (oscr/jobs.py).

class D1Error(RuntimeError):
    pass


class D1:
    """The community database as the Mac reaches it: SQL in (the values as literals, see
    `literal`), rows out. `run` returns the rows written, as D1 counts them when it says."""

    target = "local"

    def query(self, sql: str) -> list[dict[str, Any]]:
        raise NotImplementedError

    def run(self, statements: list[str]) -> int:
        raise NotImplementedError


class SqliteD1(D1):
    """An SQLite database made from the D1 migrations: the tests' D1."""

    def __init__(self, con: sqlite3.Connection, target: str = "local") -> None:
        self.con, self.target = con, target
        self.con.row_factory = sqlite3.Row

    def query(self, sql: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.con.execute(sql).fetchall()]

    def run(self, statements: list[str]) -> int:
        before = self.con.total_changes
        try:
            self.con.execute("BEGIN")
            for sql in statements:
                self.con.execute(sql)
            self.con.execute("COMMIT")
        except sqlite3.Error as e:
            self.con.execute("ROLLBACK")
            raise D1Error(str(e)) from None
        return self.con.total_changes - before


def _results(stdout: str) -> list[dict[str, Any]]:
    """wrangler's `--json` output: one result per statement."""
    start = stdout.find("[")
    try:
        data = json.loads(stdout[start:]) if start >= 0 else None
    except ValueError:
        data = None
    if not isinstance(data, list):
        raise D1Error(f"wrangler did not answer in JSON: {stdout.strip()[:300]}")
    return [d for d in data if isinstance(d, dict)]


class WranglerD1(D1):
    """Through wrangler: the local D1 of `wrangler dev --env local` (or the state folder given,
    `--persist-to`), or the Cloudflare database under wrangler's own login. `database`:
    oscr_community (the default) or oscr_forge."""

    def __init__(self, target: str, website: Path = WEBSITE, persist_to: Path | None = None,
                 database: str = DATABASE) -> None:
        self.target, self.website, self.database = target, website, database_name(database)
        where = ["--local", *WRANGLER_LOCAL] if target == "local" else ["--remote"]
        if persist_to is not None:
            where += ["--persist-to", str(Path(persist_to).resolve())]
        self.where = where

    def _execute(self, sql: str) -> list[dict[str, Any]]:
        try:
            return _results(_wrangler(["d1", "execute", self.database, *self.where, "--json", "--yes", "--command", sql],
                                      self.website))
        except PushError as e:
            raise D1Error(str(e)) from None

    def query(self, sql: str) -> list[dict[str, Any]]:
        results = self._execute(sql)
        return [dict(r) for r in (results[0].get("results") or [])] if results else []

    def run(self, statements: list[str]) -> int:
        if not statements:
            return 0
        results = self._execute("\n".join(s.rstrip(";") + ";" for s in statements))
        written = [int((r.get("meta") or {}).get("rows_written") or 0) for r in results]
        return sum(written) if any(written) else len(statements)


class RestD1(D1):
    """Through Cloudflare's REST API, with the push's token (D1 edit rights only)."""

    target = "remote"

    def __init__(self, account_id: str, database_id: str, token: str, post: Callable[..., Any] | None = None) -> None:
        self.account_id, self.database_id, self.token, self.post = account_id, database_id, token, post

    def _execute(self, sql: str) -> list[dict[str, Any]]:
        try:
            return apply_rest(sql, account_id=self.account_id, database_id=self.database_id, token=self.token,
                              post=self.post)
        except PushError as e:
            raise D1Error(str(e)) from None

    def query(self, sql: str) -> list[dict[str, Any]]:
        results = self._execute(sql)
        return [dict(r) for r in (results[0].get("results") or [])] if results else []

    def run(self, statements: list[str]) -> int:
        if not statements:
            return 0
        results = self._execute("\n".join(s.rstrip(";") + ";" for s in statements))
        return sum(int((r.get("meta") or {}).get("rows_written") or 0) for r in results)


def open_d1(target: str, *, settings: dict[str, str] | None = None, website: Path = WEBSITE,
            persist_to: Path | None = None, database: str = DATABASE) -> D1:
    """The community database of `target` (or `database`, oscr_forge): local through wrangler;
    remote through the REST API when its ids and token are there, else through wrangler's login."""
    database_name(database)
    if target == "local":
        return WranglerD1("local", website, persist_to, database=database)
    if target != "remote":
        raise D1Error(f"unknown target {target!r}: local or remote")
    account, ident, token = remote_settings(settings, database)
    if account and ident and token:
        return RestD1(account, ident, token)
    return WranglerD1("remote", website, database=database)


def spend(state: sqlite3.Connection, target: str, rows: int, *, now: float | None = None) -> None:
    """Rows written to `target` outside a push (the job runner's): counted in the same day."""
    state.execute("INSERT INTO community_budget (target, day, rows) VALUES (?, ?, ?) ON CONFLICT (target, day) "
                  "DO UPDATE SET rows = rows + excluded.rows", (target, utc_day(now), rows))
    state.commit()
