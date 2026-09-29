"""``oscr repo``: a repository, the registry's view of it first (D14-10). The GitHub side's commands
(create, clone, view, list, sync) are in github_repo.py; this module holds the group and its settings
(set-default)."""
from __future__ import annotations

import argparse
from typing import Any

from .. import gitlocal
from ..context import DEFAULT_REPO_KEY
from ..errors import UsageError
from ..parsing import command, group

NAME = "repo"
GROUP = "github"

#: Sub-commands other modules add to the group (github_repo.py).
EXTRA: list[Any] = []


def _set_default(ctx: Any, args: argparse.Namespace) -> int:
    top = ctx.git.toplevel(ctx.cwd)
    if top is None:
        raise UsageError("Run this inside a clone: the default is kept in the clone's own git configuration.")
    if args.view:
        saved = ctx.git.config_get(top, DEFAULT_REPO_KEY)
        if not saved:
            ctx.io.say("No default in this clone: the remotes decide (oscr help repository).")
            return 0
        ctx.io.print(saved)
        return 0
    if args.unset:
        ctx.git.run(["config", "--local", "--unset", DEFAULT_REPO_KEY], cwd=top, check=False)
        ctx.io.say("The default is unset: the remotes decide again.")
        return 0
    if not args.target:
        raise UsageError("Which repository? oscr repo set-default OWNER/NAME")
    r = gitlocal.parse_repo(args.target, ctx.config.github_host)
    if r is None:
        raise UsageError(f"“{args.target}” is not a repository: write owner/name.")
    ctx.git.config_set(top, DEFAULT_REPO_KEY, r.full if r.host == ctx.config.github_host else f"{r.host}/{r.full}")
    ctx.io.say(f"This clone's commands now go to {r.full}.")
    return 0


def register(sub: Any) -> None:
    _, rs = group(
        sub,
        "repo",
        help="a repository: the registry's view, then GitHub's",
        examples_=["oscr repo view", "oscr repo view --web", "oscr repo clone lab/eeg-analysis", "oscr repo set-default lab/eeg-analysis"],
    )
    p = command(rs, "set-default", help="the repository this clone's commands go to", handler=_set_default,
                examples_=["oscr repo set-default lab/eeg-analysis", "oscr repo set-default --view", "oscr repo set-default --unset"])
    p.add_argument("target", nargs="?", metavar="OWNER/NAME")
    p.add_argument("--view", action="store_true", help="print the default")
    p.add_argument("--unset", action="store_true", help="remove the default")
    for add in EXTRA:
        add(rs)
