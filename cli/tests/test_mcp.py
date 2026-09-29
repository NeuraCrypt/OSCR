"""The MCP server: JSON-RPC 2.0 over stdio, the read commands as tools (never a write), each answering the
command's own JSON; errors in JSON-RPC's words."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

from conftest import git

from oscr_cli import mcp

SRC = Path(__file__).resolve().parents[1] / "src"


def _server(run, cwd):
    return mcp.Server(env=run.env, keyring=None, cwd=cwd)


def _talk(server, *messages):
    inp = io.StringIO("".join(json.dumps(m) + "\n" if not isinstance(m, str) else m + "\n" for m in messages))
    out = io.StringIO()
    server.serve(inp, out)
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_the_handshake_and_the_tools(run, clone):
    s = _server(run, clone)
    replies = _talk(s, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 3, "method": "ping"})
    assert [r["id"] for r in replies] == [1, 2, 3]  # the notification got no answer
    assert replies[0]["result"]["protocolVersion"] == "2025-06-18"
    assert replies[0]["result"]["serverInfo"]["name"] == "oscr"
    tools = replies[1]["result"]["tools"]
    names = {t["name"] for t in tools}
    assert {"check", "cite", "repo_view", "trace_check", "issue_list", "search"} <= names
    for t in tools:
        assert t["annotations"]["readOnlyHint"] is True
        assert t["inputSchema"]["type"] == "object"
        assert not any(w in t["name"] for w in ("create", "close", "link", "login", "logout", "delete", "merge", "propose"))
    assert replies[2]["result"] == {}


def test_tools_answer_the_commands_json(run, clone):
    (clone / "CITATION.cff").write_text("cff-version: 1.2.0\ntitle: tool\nauthors:\n  - family-names: Lovelace\n    given-names: Ada\n")
    git(clone, "add", "-A")
    git(clone, "commit", "-q", "-m", "Cite")
    s = _server(run, clone)
    replies = _talk(s, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "check", "arguments": {"path": str(clone), "offline": True}}},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "cite", "arguments": {"path": str(clone)}}},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "check", "arguments": {}}},
                    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nothing", "arguments": {}}},
                    {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "check", "arguments": {"path": str(clone), "rm": True}}})
    check = replies[0]["result"]["structuredContent"]
    assert check["conclusion"] in ("success", "neutral") and len(check["findings"]) == 7
    assert replies[1]["result"]["structuredContent"]["apa"] == "Lovelace, A. (n.d.). tool [Computer software]."
    assert replies[2]["result"]["isError"] is True
    assert replies[3]["error"]["code"] == -32602
    assert replies[4]["result"]["isError"] is True


def test_json_rpcs_errors(run, clone):
    s = _server(run, clone)
    replies = _talk(s, "{not json", {"jsonrpc": "1.0", "id": 1, "method": "x"}, {"jsonrpc": "2.0", "id": 2, "method": "resources/write"},
                    [{"jsonrpc": "2.0", "id": 3, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/cancelled"}])
    assert replies[0]["error"]["code"] == -32700
    assert replies[1]["error"]["code"] == -32600
    assert replies[2]["error"]["code"] == -32601
    assert replies[3] == [{"jsonrpc": "2.0", "id": 3, "result": {}}]


def test_the_real_stdio_loop(run, clone):
    env = {**run.env, "PYTHONPATH": str(SRC)}
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "check", "arguments": {"path": str(clone), "offline": True}}}]
    p = subprocess.run([sys.executable, "-m", "oscr_cli", "mcp", "serve"], input="".join(json.dumps(m) + "\n" for m in msgs),
                       capture_output=True, text=True, env={**os.environ, **env}, cwd=clone, timeout=60)
    assert p.returncode == 0, p.stderr
    lines = [json.loads(x) for x in p.stdout.splitlines()]
    assert lines[0]["result"]["protocolVersion"] == "2024-11-05"
    assert lines[1]["result"]["structuredContent"]["commit"] == git(clone, "rev-parse", "HEAD").strip()
    assert "oscr MCP server" not in p.stdout  # standard output carries JSON-RPC only
