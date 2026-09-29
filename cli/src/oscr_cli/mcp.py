"""``oscr mcp serve``: the tool's read commands for an assistant, as a Model Context Protocol server
(JSON-RPC 2.0, one message a line, over standard input and output; D14-11). Standard library only.

Every tool runs the very command a person would (``oscr check --json …``, ``oscr repo view --json …``),
in this process, with the person's own settings and credentials, and answers its JSON: the same rules,
the same cleaning of the network's text, the same refusals. **Only read commands are offered**: no
tool creates, changes, closes or signs anything, opens a browser or asks a question. A tool's failure is
answered as a tool error in words, never as a crash of the server.
"""
from __future__ import annotations

import io
import json
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, TextIO

from . import __version__, site

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

S = {"type": "string"}
I = {"type": "integer"}
B = {"type": "boolean"}


def _obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


REPO = {"type": "string", "description": "owner/name on GitHub"}
PATH = {"type": "string", "description": "a local clone's folder"}

#: name → (description, input schema, argv builder, the JSON fields asked)
TOOLS: dict[str, tuple[str, dict[str, Any], Callable[[dict[str, Any]], list[str]], str | None]] = {
    "repo_view": ("The registry's view of a repository (its papers, its tracing maps, whether it is linked), then GitHub's facts.",
                  _obj({"repo": REPO}, ["repo"]), lambda a: ["repo", "view", a["repo"]],
                  "owner,name,description,page,registry,papers,maps,default_branch,license,visibility,pushed_at"),
    "paper_list": ("The papers the registry links to a repository.", _obj({"repo": REPO}, ["repo"]), lambda a: ["paper", "list", "-R", a["repo"]], "doi,status,title,page"),
    "check": ("The registry's checks on a local clone (licence, environment, the paper's DOI, CITATION.cff, tracing maps, file sizes, README): files read as text, never run.",
              _obj({"path": PATH, "rev": S, "base": {"type": "string", "description": "check the change from this commit, as a pull request"}, "offline": B}, ["path"]),
              lambda a: ["check", *(["--rev", a["rev"]] if a.get("rev") else []), *(["--base", a["base"]] if a.get("base") else []), *(["--offline"] if a.get("offline") else [])],
              "conclusion,title,findings,commit,papers_from"),
    "cite": ("A citation of a local clone from its CITATION.cff or codemeta.json, APA and BibTeX; its commit's Software Heritage identifiers.",
             _obj({"path": PATH, "software": B, "swhid": B}, ["path"]),
             lambda a: ["cite", *(["--software"] if a.get("software") else []), *(["--swhid"] if a.get("swhid") else [])], "apa,bibtex,source,preferred,doi,swhid"),
    "trace_list": ("The tracing maps the registry holds for a repository: the lines of its code that carry out a paper's Methods paragraphs, at a pinned commit.",
                   _obj({"repo": REPO}, ["repo"]), lambda a: ["trace", "list", "-R", a["repo"]], "paper,title,doi,commit,validated,mapDoi,pairs"),
    "trace_check": ("Each tracing map's lines found again at a commit of a local clone: the same, moved, changed or gone.",
                    _obj({"path": PATH, "commit": S, "paper": {"type": "string", "description": "a DOI: only this paper's map"}}, ["path"]),
                    lambda a: ["trace", "check", *(["--commit", a["commit"]] if a.get("commit") else []), *(["--paper", a["paper"]] if a.get("paper") else [])],
                    "doi,commit,at,pairs,failures"),
    "issue_list": ("A repository's issues on GitHub (not its pull requests).", _obj({"repo": REPO, "state": {"enum": ["open", "closed", "all"]}, "limit": I}, ["repo"]),
                   lambda a: ["issue", "list", "-R", a["repo"], "--state", a.get("state", "open"), "--limit", str(a.get("limit", 30))], "number,title,state,labels,page,updated_at"),
    "issue_view": ("One issue of a repository, with its text.", _obj({"repo": REPO, "number": I}, ["repo", "number"]),
                   lambda a: ["issue", "view", str(int(a["number"])), "-R", a["repo"]], "number,title,state,state_reason,author,labels,comments,page,body"),
    "pr_list": ("A repository's pull requests.", _obj({"repo": REPO, "state": {"enum": ["open", "closed", "all"]}, "limit": I}, ["repo"]),
                lambda a: ["pr", "list", "-R", a["repo"], "--state", a.get("state", "open"), "--limit", str(a.get("limit", 30))], "number,title,state,head,base,page,updated_at"),
    "pr_view": ("One pull request, with its text.", _obj({"repo": REPO, "number": I}, ["repo", "number"]),
                lambda a: ["pr", "view", str(int(a["number"])), "-R", a["repo"]], "number,title,state,author,head,base,draft,page,body"),
    "release_list": ("A repository's releases.", _obj({"repo": REPO, "limit": I}, ["repo"]),
                     lambda a: ["release", "list", "-R", a["repo"], "--limit", str(a.get("limit", 30))], "tag,name,draft,prerelease,published_at,page"),
    "run_list": ("A repository's own CI runs (GitHub Actions): their state, and each commit's Checks page on the registry.",
                 _obj({"repo": REPO, "limit": I}, ["repo"]), lambda a: ["run", "list", "-R", a["repo"], "--limit", str(a.get("limit", 20))],
                 "id,name,status,conclusion,branch,sha,created_at,page"),
    "search": ("The registry's search: papers (the default), repositories, research issues, people or topics.",
               _obj({"query": S, "type": {"enum": ["papers", "repositories", "issues", "people", "topics"]}, "limit": I}, ["query"]),
               lambda a: ["search", a["query"], "--type", a.get("type", "papers"), "--limit", str(a.get("limit", 20))], "type,id,title,page"),
}


class Server:
    def __init__(self, *, env: Mapping[str, str], keyring: Any = None, opener: Any = None, cwd: Path | None = None):
        # The tools run without a terminal: no question, no browser, no colour, no spinner.
        self.env = {**env, "OSCR_PROMPT": "disabled", "OSCR_BROWSER": "none", "NO_COLOR": "1", "OSCR_SPINNER_DISABLED": "1"}
        self.env.pop("OSCR_FORCE_TTY", None)
        self.keyring = keyring
        self.opener = opener
        self.cwd = cwd or Path.cwd()
        self.ready = False
        self.site_name = env.get("OSCR_SITE_NAME") or site.SITE_NAME

    def tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        from .main import main

        spec = TOOLS.get(name)
        if spec is None:
            raise KeyError(name)
        _words, schema, build, fields = spec
        missing = [k for k in schema.get("required", []) if k not in arguments]
        unknown = [k for k in arguments if k not in schema["properties"]]
        if missing or unknown:
            return {"content": [{"type": "text", "text": f"Missing {', '.join(missing)}" if missing else f"Unknown {', '.join(unknown)}"}], "isError": True}
        argv = build(arguments)
        if fields:
            argv += ["--json", fields]
        cwd = Path(arguments["path"]).expanduser() if arguments.get("path") else self.cwd
        out, err = io.StringIO(), io.StringIO()
        code = main(argv, env=self.env, stdout=out, stderr=err, stdin=io.StringIO(""), cwd=cwd, keyring=self.keyring, opener=self.opener)
        text = out.getvalue().strip()
        if code not in (0, 3):
            return {"content": [{"type": "text", "text": err.getvalue().strip() or f"oscr {' '.join(argv[:2])} failed ({code})"}], "isError": True}
        try:
            data = json.loads(text) if text else None
        except ValueError:
            data = None
        result: dict[str, Any] = {"content": [{"type": "text", "text": text or err.getvalue().strip()}]}
        if data is not None:
            result["structuredContent"] = data if isinstance(data, dict) else {"items": data}
        return result

    def handle(self, msg: Any) -> dict[str, Any] | None:
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            return _error(msg.get("id") if isinstance(msg, dict) else None, -32600, "Invalid Request")
        method, mid, params = msg["method"], msg.get("id"), msg.get("params") or {}
        notification = "id" not in msg
        try:
            if method == "initialize":
                asked = params.get("protocolVersion")
                version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
                result: Any = {
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "oscr", "version": __version__},
                    "instructions": f"Read-only tools of {self.site_name}'s command line (a registry of research code and its papers): "
                                    "the registry's view of research repositories, its checks and citations of local clones, tracing maps "
                                    "between code and papers, and GitHub's issues, pull requests, releases and CI runs. Nothing is written or run.",
                }
            elif method in ("notifications/initialized", "initialized"):
                self.ready = True
                return None
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": [{"name": n, "description": d, "inputSchema": s, "annotations": {"readOnlyHint": True, "openWorldHint": True}}
                                    for n, (d, s, _b, _f) in TOOLS.items()]}
            elif method == "tools/call":
                name = params.get("name")
                args = params.get("arguments") or {}
                if not isinstance(name, str) or name not in TOOLS or not isinstance(args, dict):
                    return _error(mid, -32602, f"Unknown tool: {str(name)[:60]}")
                result = self.tool(name, args)
            elif notification:
                return None
            else:
                return _error(mid, -32601, f"Method not found: {method[:60]}")
        except Exception as e:  # noqa: BLE001 - a tool's failure is an answer, never the server's end
            return _error(mid, -32603, f"Internal error: {type(e).__name__}")
        return None if notification else {"jsonrpc": "2.0", "id": mid, "result": result}

    def serve(self, inp: TextIO, out: TextIO) -> int:
        for line in inp:
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                reply: Any = _error(None, -32700, "Parse error")
            else:
                if isinstance(msg, list):
                    reply = [r for r in (self.handle(m) for m in msg) if r is not None] or None
                else:
                    reply = self.handle(msg)
            if reply is not None:
                out.write(json.dumps(reply, ensure_ascii=False) + "\n")
                out.flush()
        return 0


def _error(mid: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def serve(ctx: Any, args: Any) -> int:
    if ctx.io.in_tty:
        ctx.io.say("oscr MCP server: JSON-RPC on standard input and output; read-only tools. Ctrl-D to stop.")
    return Server(env=ctx.env, keyring=ctx.keyring, cwd=ctx.cwd).serve(ctx.io.inp if ctx.io.inp is not None else sys.stdin, ctx.io.out)


def tools(ctx: Any, args: Any) -> int:
    ctx.io.table([(n, d) for n, (d, _s, _b, _f) in TOOLS.items()], headers=("tool", "what it answers"))
    return 0
