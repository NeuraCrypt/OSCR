"""Security and quality facts on the Mac (night phase 11; oscr/security.py). The forge reader is the
in-memory double; the D1 is the SQLite oscr_forge of the fixture. Nothing reaches the network."""
from __future__ import annotations

from oscr import community, forge, security

T = 1_790_596_800


def seed_repo(d1, *, repo_id="101", owner="ada", name="eeg", head="a" * 40):
    d1.run([f"INSERT INTO repos (forge, repo_id, owner_id, owner_login, name, mode, linked_by, created_at, updated_at, state, head) "
            f"VALUES ('github', {community.literal(repo_id)}, '7', {community.literal(owner)}, {community.literal(name)}, "
            f"'public', 'u', {T}, {T}, 'active', {community.literal(head)})"])


def memory_repo(files, *, owner="ada", name="eeg", id="101", sha="a" * 40):
    r = forge.MemoryReader()
    r.add(owner, name, id=id, files={p: t.encode() for p, t in files.items()}, sha=sha)
    return r


def test_read_manifests_only_reads_manifests():
    reader = memory_repo({"requirements.txt": "numpy==1.26.0\n", "README.md": "hi", "src/app.py": "x=1"})
    ref = forge.RepoRef("memory", "ada", "eeg")
    files = security.read_manifests(reader, ref, "a" * 40)
    assert set(files) == {"requirements.txt"}
    # README.md and the source file were never read.
    assert not any(c[0] == "read" and c[1][2] in ("README.md", "src/app.py") for c in reader.calls)


def test_scan_deps_builds_the_graph():
    reader = memory_repo({"requirements.txt": "numpy==1.26.0\nscipy>=1.10\n",
                          "package.json": '{"dependencies": {"d3": "^7"}}'})
    nodes = security.scan_deps(reader, forge.RepoRef("memory", "ada", "eeg"), "a" * 40)
    names = {n.name for n in nodes}
    assert names == {"numpy", "scipy", "d3"}


def test_deps_statements_replace(forge_d1):
    from oscr import depgraph
    nodes = [depgraph.Node("PyPI", "numpy", version="1.26.0", constraint="==1.26.0", pinned=True,
                           direct=True, sources=["requirements.txt"])]
    forge_d1.run(security.deps_statements("github", "101", "default", nodes, "a" * 40, T))
    rows = forge_d1.query("SELECT ecosystem, name, version, pinned, sources FROM repo_deps")
    assert rows == [{"ecosystem": "PyPI", "name": "numpy", "version": "1.26.0", "pinned": 1,
                     "sources": '["requirements.txt"]'}]
    # A second push replaces the snapshot (no duplicate, no stale row).
    forge_d1.run(security.deps_statements("github", "101", "default", [], "a" * 40, T))
    assert forge_d1.query("SELECT count(*) AS n FROM repo_deps")[0]["n"] == 0


def test_command_scans_default_and_cited(forge_d1, tmp_path, monkeypatch):
    seed_repo(forge_d1, head="a" * 40)
    forge_d1.run([f"INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) "
                  f"VALUES ('github', '101', 'run.py', 'doi:10.1/x', {community.literal('b' * 40)}, 1)"])
    reader = forge.MemoryReader()
    reader.add("ada", "eeg", id="101", sha="a" * 40,
               files={"requirements.txt": b"numpy==1.26.0\n"})
    reader.push("101", "main", "b" * 40, {"requirements.txt": b"numpy==1.25.0\n"})
    monkeypatch.setattr(community, "open_d1", lambda *a, **k: forge_d1)
    monkeypatch.setattr(security.forge, "reader", lambda f: reader)
    out = security.command(None, "scan", target="local", folder=tmp_path, now=T)
    assert "scanned 1 repositories" in out
    default = forge_d1.query("SELECT version FROM repo_deps WHERE snapshot = 'default'")
    cited = forge_d1.query("SELECT version FROM repo_deps WHERE snapshot = 'cited'")
    assert default == [{"version": "1.26.0"}] and cited == [{"version": "1.25.0"}]
    # The budget ledger was charged.
    state = community.open_state(tmp_path / "state.db")
    assert community.budget_spent(state, "local", community.utc_day(T)) >= 2


def test_command_status(forge_d1, tmp_path, monkeypatch):
    monkeypatch.setattr(community, "open_d1", lambda *a, **k: forge_d1)
    assert "no dependency facts" in security.command(None, "status", target="local", folder=tmp_path, now=T)
    forge_d1.run(security.deps_statements("github", "101", "default",
                 [__import__("oscr.depgraph", fromlist=["Node"]).Node("PyPI", "numpy")], "", T))
    assert "1 dependency rows over 1 repositories" in security.command(None, "status", target="local", folder=tmp_path, now=T)


def test_command_budget_stops(forge_d1, tmp_path, monkeypatch):
    seed_repo(forge_d1)
    reader = memory_repo({"requirements.txt": "numpy==1.26.0\n"})
    monkeypatch.setattr(community, "open_d1", lambda *a, **k: forge_d1)
    monkeypatch.setattr(security.forge, "reader", lambda f: reader)
    said: list[str] = []
    out = security.command(None, "scan", target="local", folder=tmp_path, budget=0, now=T, report=said.append)
    assert "scanned 0 repositories" in out
    assert any("budget" in m for m in said)
    assert forge_d1.query("SELECT count(*) AS n FROM repo_deps")[0]["n"] == 0
