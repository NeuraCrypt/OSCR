"""The command tree's parts: a parser that raises instead of exiting, ``--help`` on every command with
its examples, the flags every command shares."""
from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from typing import Any, TextIO

from .errors import UsageError


class HelpShown(Exception):
    """``--help`` printed its page: the command ends with exit code 0."""


class Parser(argparse.ArgumentParser):
    #: Where help pages go (main sets it to the run's standard output).
    stream: TextIO | None = None

    def error(self, message: str) -> None:  # type: ignore[override]
        raise UsageError(f"{message}", hint=f"Run `{self.prog} --help` for how to use it.")

    def exit(self, status: int = 0, message: str | None = None) -> None:  # type: ignore[override]
        if message:
            (Parser.stream or sys.stderr).write(message)
        if status:
            raise UsageError(message or "usage error")
        raise HelpShown()

    def _print_message(self, message: str, file: Any = None) -> None:
        if message:
            (Parser.stream or sys.stdout).write(message)


class Formatter(argparse.RawDescriptionHelpFormatter):
    def __init__(self, prog: str) -> None:
        super().__init__(prog, max_help_position=30, width=100)


def common_flags() -> argparse.ArgumentParser:
    """The flags every command takes after its name (their defaults never hide the root's)."""
    p = argparse.ArgumentParser(add_help=False)
    g = p.add_argument_group("shared")
    g.add_argument("--debug", action="store_true", default=argparse.SUPPRESS, help="say each request made (never a token)")
    g.add_argument("--color", choices=("auto", "always", "never"), default=argparse.SUPPRESS, help="colours: auto (a terminal), always, never")
    return p


COMMON = common_flags()

Handler = Callable[[Any, argparse.Namespace], int | None]


def examples(lines: Sequence[str]) -> str:
    return "examples:\n" + "\n".join(f"  {line}" for line in lines) if lines else ""


def command(
    sub: Any,
    name: str,
    *,
    help: str,
    description: str = "",
    examples_: Sequence[str] = (),
    handler: Handler | None = None,
    aliases: Sequence[str] = (),
    repo: bool = False,
) -> argparse.ArgumentParser:
    """A command (or a group) under ``sub``, with its page and examples."""
    p = sub.add_parser(
        name,
        help=help,
        description=description or help,
        epilog=examples(examples_),
        formatter_class=Formatter,
        parents=[COMMON],
        aliases=list(aliases),
    )
    if repo:
        p.add_argument("-R", "--repo", metavar="[HOST/]OWNER/NAME", default=argparse.SUPPRESS, help="the repository (else the current clone's; oscr help repository)")
    if handler is not None:
        p.set_defaults(handler=handler)
    return p


def group(sub: Any, name: str, *, help: str, description: str = "", examples_: Sequence[str] = (), aliases: Sequence[str] = ()) -> tuple[argparse.ArgumentParser, Any]:
    """A group of commands (``oscr repo …``): its parser and its sub-commands' collection."""
    p = command(sub, name, help=help, description=description, examples_=examples_, aliases=aliases)
    s = p.add_subparsers(dest=f"{name}_command", metavar="<command>", parser_class=Parser)
    p.set_defaults(handler=None, group_parser=p)
    return p, s
