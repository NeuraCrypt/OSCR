"""The GitHub side's D1 database, oscr_forge (night phase 01; migrations/d1-forge/, docs/FORGE.md),
and how the Mac reaches it: the migration's conventions (one index at most per table, WITHOUT
ROWID where the key is text, Unix seconds, no email, token, secret or password column), the shard
numbers of the static layer, `open_d1(database="oscr_forge")`, and the command line's hooks
(`oscr forge`, `oscr jobs poll`, `oscr nightly`)."""
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import FORGE_MIGRATIONS, forge_database

from oscr import catalog, cli, community, forgejobs, forgelayer, jobs, publish, social

ROOT = Path(__file__).resolve().parents[1]
TABLES = {"repos", "repo_papers", "installations", "traced_paths", "actions", "deliveries", "jobs",
          "research_issues", "research_comments", "release_papers", "repo_packages",
          # Phase 08: the social layer (0008_social.sql).
          "stars", "star_lists", "star_list_items", "follows", "events", "notice_state", "notice_marks",
          "profiles"}
T = 1_790_596_800


def _tables(con: sqlite3.Connection) -> dict[str, str]:
    return {name: sql for name, sql in con.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table'")}


def test_the_migration_applies_and_holds_the_nineteen_tables(forge_d1):
    assert FORGE_MIGRATIONS and FORGE_MIGRATIONS[0].name == "0001_forge.sql"
    assert set(_tables(forge_d1.con)) == TABLES
    # The Mac's interface: rows in, rows out.
    assert forge_d1.run(["INSERT INTO jobs (kind, forge, repo_id, created_at) VALUES ('link', 'github', '101', 1)"]) == 1
    assert forge_d1.query("SELECT id, kind, done_at, outcome FROM jobs") == [
        {"id": 1, "kind": "link", "done_at": None, "outcome": ""}]


def test_at_most_one_index_per_table_and_without_rowid_where_the_key_is_text():
    con = forge_database()
    indexes = con.execute("SELECT tbl_name, name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").fetchall()
    per_table: dict[str, list[str]] = {}
    for table, name in indexes:
        per_table.setdefault(table, []).append(name)
    assert all(len(names) <= 1 for names in per_table.values()), per_table
    assert per_table == {"repos": ["repos_path"], "research_issues": ["research_paper"]}
    # No hidden autoindex either: a text key is the table itself.
    assert con.execute("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND sql IS NULL AND name NOT LIKE 'sqlite_autoindex_%'").fetchone()[0] == 0
    for name, sql in _tables(con).items():
        pk = [r for r in con.execute(f"PRAGMA table_info({name})") if r[5]]
        integer_rowid = len(pk) == 1 and pk[0][2].upper() == "INTEGER"
        assert integer_rowid or "WITHOUT ROWID" in sql, name
        assert "AUTOINCREMENT" not in sql.upper(), name


def test_no_column_for_an_email_a_token_a_secret_a_password_or_a_git_object():
    con = forge_database()
    for table in _tables(con):
        for _, column, kind, *_ in con.execute(f"PRAGMA table_info({table})"):
            low = column.lower()
            for word in ("email", "mail", "token", "secret", "password", "passwd", "key", "blob", "tree", "content"):
                assert word not in low, f"{table}.{column}"
            if low.endswith("_at") or low in ("at", "delete_after", "not_before"):
                assert kind.upper() == "INTEGER", f"{table}.{column}: Unix seconds"


def test_the_checks_refuse_an_address_an_unknown_forge_and_a_private_name(forge_d1):
    con = forge_d1.con

    def insert(**over):
        row = {"forge": "github", "repo_id": "101", "owner_id": "7", "owner_login": "ada", "name": "eeg", "mode": "public",
               "installation_id": None, "linked_by": "u_ada", "created_at": T, "updated_at": T, "state": "active"}
        row.update(over)
        con.execute(f"INSERT INTO repos ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))

    for bad in [{"owner_login": "a@b.org"}, {"name": "Upper"}, {"forge": "gitlab"}, {"mode": "private"},
                {"mode": "installed"}, {"state": "pending_deletion"}, {"name": ""}, {"head": "abc"}]:
        with pytest.raises(sqlite3.IntegrityError):
            insert(**bad)
    insert(state="hidden", owner_login="", name="")          # made private on GitHub: no name kept
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO repo_papers VALUES ('github', '101', 'pmcid:PMC1', 'linked', 'u', 1)")
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO actions (day, user_id, at, nonce, kind, outcome, rows) VALUES (1, 'u', ?, 'nonce-123', 'create', 'done', 1)", (T,))
    con.execute("INSERT INTO actions (day, user_id, at, nonce, kind, outcome, rows) VALUES (?, 'u', ?, 'nonce-123', 'create', 'done', 6)", (T // 86400, T))
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO jobs (kind, forge, repo_id, created_at) VALUES ('delete_due', 'github', '101', 1)")
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("INSERT INTO jobs (kind, forge, repo_id, created_at, message) VALUES ('link', 'github', '101', 1, 'a@b.org')")


def test_the_action_kinds_are_the_workers():
    """The migrations' CHECK on actions.kind (as the last one that rebuilt the table leaves it: 0008,
    phase 08's social layer) lists website/worker/forge/service/types.ts ACTION_KINDS, then its
    RESEARCH_KINDS and SOCIAL_KINDS (the registry's own writes, logged like the actions)."""
    sql = forge_database().execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'actions'").fetchone()[0]
    assert "WITHOUT ROWID" in sql
    start = sql.index("kind         TEXT NOT NULL CHECK (kind IN (")
    in_sql = re.findall(r"'([a-z_]+)'", sql[start:sql.index("))", start)])
    types = (ROOT / "website" / "worker" / "forge" / "service" / "types.ts").read_text()
    start = types.index("export const ACTION_KINDS = [")
    in_ts = re.findall(r'"([a-z_]+)"', types[start:types.index("] as const", start)])
    start = types.index("export const RESEARCH_KINDS = [")
    in_ts += re.findall(r'"([a-z_]+)"', types[start:types.index("] as const", start)])
    start = types.index("export const SOCIAL_KINDS = [")
    in_ts += re.findall(r'"([a-z_]+)"', types[start:types.index("] as const", start)])
    assert in_sql == in_ts
    assert len(in_sql) == 63 and len(set(in_sql)) == 63


def test_the_layer_shards_are_sha256_mod_64():
    """The pairs the website's layerShard and oscr/forgelayer.py must both give."""
    fixture = json.loads((ROOT / "tests" / "fixtures" / "forge-shards.json").read_text())
    assert len(fixture["pairs"]) >= 10
    for path, shard in fixture["pairs"]:
        assert f"{hashlib.sha256(path.lower().encode()).digest()[0] % 64:02d}" == shard, path


def test_open_d1_reaches_oscr_forge_through_wrangler_and_the_rest_api(tmp_path, monkeypatch):
    calls = []
    output = json.dumps([{"results": [{"id": 1}], "success": True, "meta": {"rows_read": 1}}])
    monkeypatch.setattr(community, "_wrangler", lambda args, website: calls.append(args) or output)
    local = community.open_d1("local", database="oscr_forge", persist_to=tmp_path / "state")
    assert local.query("SELECT id FROM jobs") == [{"id": 1}]
    assert calls[-1][:3] == ["d1", "execute", "oscr_forge"]
    assert calls[-1][calls[-1].index("--env") + 1] == "local" and "--local" in calls[-1]
    assert calls[-1][calls[-1].index("--persist-to") + 1] == str((tmp_path / "state").resolve())
    remote = community.open_d1("remote", settings={}, database="oscr_forge")
    remote.query("SELECT 1")
    assert calls[-1][:3] == ["d1", "execute", "oscr_forge"] and "--remote" in calls[-1] and "--env" not in calls[-1]
    # The default is unchanged: oscr_community.
    community.open_d1("local").query("SELECT 1")
    assert calls[-1][:3] == ["d1", "execute", "oscr_community"]
    # The REST API needs the forge's own id: the community's is not enough.
    from oscr import d1 as search
    monkeypatch.setattr(search, "remote_token", lambda: "tok")
    both = {"OSCR_D1_ACCOUNT_ID": "acc", "OSCR_D1_COMMUNITY_ID": "comm"}
    assert isinstance(community.open_d1("remote", settings=both, database="oscr_forge"), community.WranglerD1)
    rest = community.open_d1("remote", settings={**both, "OSCR_D1_FORGE_ID": "forge-id"}, database="oscr_forge")
    assert isinstance(rest, community.RestD1) and rest.database_id == "forge-id"
    assert community.open_d1("remote", settings=both).database_id == "comm"
    assert community.remote_settings({**both, "OSCR_D1_FORGE_ID": "f"}, "oscr_forge") == ("acc", "f", "tok")
    with pytest.raises(community.D1Error):
        community.open_d1("local", database="oscr_catalog")
    community.migrate_local(database="oscr_forge")
    assert calls[-1][:4] == ["d1", "migrations", "apply", "oscr_forge"]
    community.apply_remote_wrangler(tmp_path / "x.sql", database="oscr_forge")
    assert calls[-1][:3] == ["d1", "execute", "oscr_forge"] and "--remote" in calls[-1]


# ---------------------------------------------------------------------------------------------
# The command line.

@pytest.fixture
def base(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "settings", lambda: {})
    return ["--db", str(tmp_path / "mac.db"), "--cache", str(tmp_path / "cache")]


def test_oscr_forge_dispatches_to_the_jobs_and_the_layer(base, tmp_path, monkeypatch, capsys):
    seen = []
    monkeypatch.setattr(forgejobs, "command", lambda con, action, **kw: seen.append(("jobs", action, kw)) or f"jobs {action}")
    monkeypatch.setattr(forgelayer, "command", lambda con, action, **kw: seen.append(("layer", action, kw)) or f"layer {action}")
    with pytest.raises(SystemExit, match="--local"):
        cli.main([*base, "forge", "poll"])
    assert cli.main([*base, "forge", "poll", "--local", "--folder", str(tmp_path / "state")]) == 0
    assert seen[-1][:2] == ("jobs", "poll") and seen[-1][2]["target"] == "local"
    assert seen[-1][2]["folder"] == tmp_path / "state" and seen[-1][2]["budget"] == 10_000
    assert cli.main([*base, "forge", "mirrors", "--remote"]) == 0
    assert seen[-1][:2] == ("jobs", "mirrors") and seen[-1][2]["target"] == "remote"
    assert cli.main([*base, "forge", "layer", "--remote", "--export", str(tmp_path / "public")]) == 0
    assert seen[-1][:2] == ("layer", "layer") and seen[-1][2]["out"] == tmp_path / "public"
    assert cli.main([*base, "forge", "status"]) == 0
    assert [s[:2] for s in seen[-2:]] == [("jobs", "status"), ("layer", "status")]
    assert "jobs status\nlayer status" in capsys.readouterr().out


def _fake_jobs(monkeypatch):
    monkeypatch.setattr(community, "open_d1", lambda target, **kw: SimpleNamespace(target=target))
    monkeypatch.setattr(jobs, "MacHarvester", lambda client, opts: None)
    monkeypatch.setattr(jobs, "Runner", lambda *a, **kw: None)
    monkeypatch.setattr(jobs, "poll", lambda runner: SimpleNamespace(describe=lambda target: f"community {target}: nothing new"))


def test_jobs_poll_also_polls_the_forge_jobs_when_the_settings_name_that_target(base, tmp_path, monkeypatch, capsys):
    _fake_jobs(monkeypatch)
    polled = []
    monkeypatch.setattr(forgejobs, "command", lambda con, action, **kw: polled.append((action, kw["target"])) or "forge: 2 jobs")
    folder = ["--folder", str(tmp_path / "community")]
    assert cli.main([*base, "jobs", "poll", "--local", *folder]) == 0
    assert polled == [] and "forge" not in capsys.readouterr().out
    monkeypatch.setattr(cli, "settings", lambda: {"OSCR_FORGE_PUSH": "remote"})
    assert cli.main([*base, "jobs", "poll", "--local", *folder]) == 0
    assert polled == []
    assert cli.main([*base, "jobs", "poll", "--remote", *folder]) == 0
    assert polled == [("poll", "remote")]
    assert "community remote: nothing new\nforge: 2 jobs" in capsys.readouterr().out
    # A failure of the forge's poll is said; the community's answers stand.
    monkeypatch.setattr(forgejobs, "command", lambda con, action, **kw: (_ for _ in ()).throw(RuntimeError("D1 is down")))
    assert cli.main([*base, "jobs", "poll", "--remote", *folder]) == 0
    assert "forge jobs: D1 is down" in capsys.readouterr().out


def test_nightly_reads_the_mirrors_and_writes_the_layer_between_the_export_and_the_deployment(base, tmp_path, monkeypatch):
    order = []
    monkeypatch.setattr(catalog, "generate", lambda con, out, public=False, **kw: order.append("export") or out)
    monkeypatch.setattr(publish, "deploy_cloudflare", lambda out, project: order.append("deploy") or "online")
    monkeypatch.setattr(forgejobs, "mirrors", lambda con, **kw: order.append(("mirrors", kw["target"])) or "2 heads changed")
    monkeypatch.setattr(forgelayer, "write", lambda con, d1, out: order.append(("layer", d1.database, out)) or "64 shards")
    # Night phase 08: the social layer, after the forge's (oscr/social.py).
    monkeypatch.setattr(social, "write", lambda forge, people, out, con=None: order.append(("social", forge.database, people.database, out)) or "64 shards")
    monkeypatch.setattr(community, "open_d1", lambda target, **kw: SimpleNamespace(database=kw.get("database")))
    out = tmp_path / "public"
    monkeypatch.setattr(cli, "settings", lambda: {})
    assert cli.main([*base, "nightly", "--out", str(out), "--cloudflare", "oscr"]) == 0
    assert order == ["export", "deploy"]
    order.clear()
    monkeypatch.setattr(cli, "settings", lambda: {"OSCR_FORGE_PUSH": "remote"})
    assert cli.main([*base, "nightly", "--out", str(out), "--cloudflare", "oscr"]) == 0
    assert order == ["export", ("mirrors", "remote"), ("layer", "oscr_forge", out), ("social", "oscr_forge", None, out), "deploy"]
    # Each failure is recorded like the others, and the deployment still happens.
    order.clear()
    monkeypatch.setattr(forgejobs, "mirrors", lambda con, **kw: (_ for _ in ()).throw(RuntimeError("GitHub is down")))
    monkeypatch.setattr(forgelayer, "write", lambda con, d1, out: (_ for _ in ()).throw(forgelayer.NotBuilt("not built yet")))
    monkeypatch.setattr(social, "write", lambda forge, people, out, con=None: (_ for _ in ()).throw(social.SocialError("not migrated")))
    with pytest.raises(SystemExit) as failed:
        cli.main([*base, "nightly", "--out", str(out), "--cloudflare", "oscr"])
    assert "Forge mirrors: GitHub is down" in str(failed.value) and "Forge layer: not built yet" in str(failed.value)
    assert "Social layer: not migrated" in str(failed.value)
    assert order == ["export", "deploy"]


def test_the_job_kinds_are_the_macs():
    """The CHECK on jobs.kind, as migration 0006 (night phase 07) leaves it, lists oscr/forgejobs.py
    KINDS, which the Mac answers, and website/worker/forge/service/types.ts JOB_KINDS."""
    sql = forge_database().execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").fetchone()[0]
    start = sql.index("kind        TEXT NOT NULL CHECK (kind IN (")
    in_sql = re.findall(r"'([a-z_]+)'", sql[start:sql.index("))", start)])
    assert tuple(in_sql) == forgejobs.KINDS == tuple(forgejobs.HANDLERS)
    types = (ROOT / "website" / "worker" / "forge" / "service" / "types.ts").read_text()
    start = types.index("export const JOB_KINDS")
    assert re.findall(r'"([a-z_]+)"', types[start:types.index("];", start)]) == in_sql
