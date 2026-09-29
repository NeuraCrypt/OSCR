"""``oscr``: the researchers' command line (docs/CLI.md).

The entry point: aliases expanded, the command tree built and read, the context made, the command run,
its errors said in words with their exit codes (``oscr help exit-codes``).
"""
from __future__ import annotations

import os
import re
import shlex
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, TextIO

from . import __version__, manual
from .commands import GROUPS, MODULES
from .config import Config
from .context import Context
from .errors import INTERRUPTED, OK, USAGE, CliError, UsageError
from .http import Http, Opener, redact
from .output import IO
from .parsing import Formatter, HelpShown, Parser
from .sanitize import clean

#: The harvester's admin commands (the Mac's own `oscr`, D14-1): said, never run here.
HARVESTER_COMMANDS = frozenset({
    "watch", "nightly", "align", "zenodo", "scan", "doi", "folder", "reverify", "export", "dashboard",
    "stats", "scripts", "enrich", "labels", "d1", "community", "jobs", "claims", "reports", "submissions",
    "forge", "social", "malware", "backfill", "contacts", "publish-hf",
})


def build_parser(site_name: str) -> Parser:
    p = Parser(
        prog="oscr",
        description=manual.overview(site_name),
        epilog=manual.root_epilog(),
        formatter_class=Formatter,
        add_help=True,
    )
    p.add_argument("--version", action="version", version=f"oscr {__version__}")
    p.add_argument("--debug", action="store_true", default=False, help="say each request made (never a token); also OSCR_DEBUG=1")
    p.add_argument("--color", choices=("auto", "always", "never"), default=None, help="colours: auto (a terminal), always, never")
    sub = p.add_subparsers(dest="command", metavar="<command>", parser_class=Parser)
    for module in MODULES:
        module.register(sub)
    p.set_defaults(handler=None, group_parser=p)
    return p


def expand_alias(argv: list[str], aliases: Mapping[str, str], builtins: set[str]) -> list[str]:
    """An alias's expansion in place of its name; ``$1``, ``$2``… take the next arguments. Aliases never
    run a shell (D14-13)."""
    if not argv or argv[0] in builtins or argv[0] not in aliases:
        return argv
    words = shlex.split(aliases[argv[0]])
    rest = argv[1:]
    used: set[int] = set()
    out: list[str] = []
    for w in words:
        def sub(m: re.Match[str]) -> str:
            i = int(m.group(1))
            used.add(i)
            return rest[i - 1] if i - 1 < len(rest) else ""

        out.append(re.sub(r"\$(\d+)", sub, w))
    return out + [a for i, a in enumerate(rest, 1) if i not in used]


def _in_harvester_checkout(cwd: Path) -> bool:
    """Whether ``cwd`` is inside the harvester's repository (its root has ``oscr/cli.py``)."""
    for d in (cwd, *cwd.parents):
        if (d / "oscr" / "cli.py").is_file() and (d / "pyproject.toml").is_file():
            try:
                return 'name = "oscr"' in (d / "pyproject.toml").read_text(encoding="utf-8")
            except OSError:
                return False
    return False


def main(
    argv: Sequence[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    stdin: TextIO | None = None,
    cwd: Path | None = None,
    opener: Opener | None = None,
    keyring: Any = None,
) -> int:
    env = dict(os.environ if env is None else env)
    args_list = list(sys.argv[1:] if argv is None else argv)
    err = stderr if stderr is not None else sys.stderr
    out = stdout if stdout is not None else sys.stdout
    here = Path(cwd or os.getcwd())
    try:
        config = Config.load(env)
    except CliError as e:
        err.write(f"error: {e.message}\n")
        return e.code
    io = IO(stdout=out, stderr=err, stdin=stdin, env=env, color=config.get("color"), accessible=config.flag("accessible_colors"),
            spinner=config.flag("spinner"), prompt=config.get("prompt") == "enabled")
    Parser.stream = out
    parser = build_parser(config.site_name)
    builtins = set(parser._subparsers._group_actions[0].choices)  # type: ignore[union-attr]
    args_list = expand_alias(args_list, config.aliases(), builtins)

    if args_list and args_list[0] in HARVESTER_COMMANDS and args_list[0] not in builtins:
        err.write(
            f"error: `{clean(args_list[0])}` is a command of the registry's harvester, not of this tool.\n"
            "This `oscr` is the researchers' command line. On the registry's own Mac, the harvester runs as\n"
            f"  .venv/bin/python -m oscr {clean(args_list[0])}\n"
            "from the repository's root (docs/CLI.md, \"Two commands named oscr\").\n"
        )
        return USAGE

    try:
        args = parser.parse_args(args_list)
    except HelpShown:
        return OK
    except UsageError as e:
        err.write(f"error: {clean(e.message)}\n")
        if e.hint:
            err.write(f"{e.hint}\n")
        return e.code

    if args.color:
        io.color = io._decide_color(args.color)
    debug = bool(getattr(args, "debug", False)) or env.get("OSCR_DEBUG", "") not in ("", "0")
    http = Http(debug=err if debug else None, opener=opener) if opener else Http(debug=err if debug else None)
    ctx = Context(io=io, config=config, env=env, cwd=here, http=http, args=args, keyring=keyring)
    handler = getattr(args, "handler", None)
    if handler is None:
        target = getattr(args, "group_parser", parser)
        target.print_help()
        if target is parser and _in_harvester_checkout(here):
            err.write("\nNote: this is the researchers' `oscr`; the harvester's commands run as `.venv/bin/python -m oscr …` here.\n")
        return OK
    try:
        code = handler(ctx, args)
        out.flush()
        return OK if code is None else int(code)
    except HelpShown:
        return OK
    except CliError as e:
        err.write(f"error: {clean(redact(e.message))}\n")
        if e.hint:
            err.write(f"{clean(e.hint)}\n")
        return e.code
    except KeyboardInterrupt:
        err.write("\ninterrupted\n")
        return INTERRUPTED
    except BrokenPipeError:
        return OK


def group_names() -> dict[str, list[str]]:
    return {g: [m.NAME for m in MODULES if m.GROUP == g] for g in GROUPS}


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

