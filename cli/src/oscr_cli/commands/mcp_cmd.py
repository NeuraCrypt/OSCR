"""``oscr mcp``: the tool's read commands for an assistant (the Model Context Protocol, over stdio)."""
from __future__ import annotations

from typing import Any

from .. import mcp
from ..parsing import command, group

NAME = "mcp"
GROUP = "settings"


def register(sub: Any) -> None:
    _, s = group(sub, "mcp", help="the read commands as an MCP server, for an assistant (JSON-RPC over stdio)",
                 examples_=["oscr mcp serve", "oscr mcp tools"])
    command(s, "serve", help="serve JSON-RPC 2.0 on standard input and output (read-only tools)", handler=mcp.serve,
            examples_=['{"mcpServers": {"oscr": {"command": "oscr", "args": ["mcp", "serve"]}}}   (an assistant\'s configuration)'])
    command(s, "tools", help="the tools it offers", handler=mcp.tools, examples_=["oscr mcp tools"])
