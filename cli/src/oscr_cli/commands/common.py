"""What the GitHub-side commands share: the registry's page of a thing first (D14-10), bodies from a
flag, a file, standard input or the person's editor, questions asked only in a terminal."""
from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from ..errors import UsageError
from ..gitlocal import RepoName


def page(ctx: Any, repo: RepoName, suffix: str = "") -> str:
    """The registry's page of a repository's thing (its /r/ shell reads GitHub in the reader's browser)."""
    return ctx.site_url(f"/r/{quote(repo.owner)}/{quote(repo.name)}/{suffix}")


def github_page(ctx: Any, repo: RepoName, suffix: str = "") -> str:
    return f"{ctx.config.github_web}/{repo.owner}/{repo.name}{'/' + suffix if suffix else ''}"


def show_github(ctx: Any, url: str, why: str) -> None:
    """GitHub's own page, only when the registry cannot show the thing, with the reason."""
    ctx.io.say(f"GitHub's page, because {why}:")
    ctx.io.print(url)


def ask(ctx: Any, question: str, *, default: str = "", flag: str) -> str:
    """A value asked in a terminal; elsewhere (a pipe, OSCR_PROMPT=disabled) the flag is needed."""
    if not ctx.io.prompt:
        raise UsageError(f"{question} is needed: add {flag} (the tool asks only in a terminal).")
    ctx.io.err.write(f"? {question}{f' [{default}]' if default else ''}: ")
    ctx.io.err.flush()
    line = ctx.io.inp.readline()
    value = line.strip() or default
    if not value:
        raise UsageError(f"{question} is needed.")
    return value


def editor(ctx: Any, template: str = "") -> str:
    """The person's own editor ($OSCR_EDITOR, the setting, $VISUAL, $EDITOR, vi) on a temporary file.
    It is the person's program, never anything read from the network or a repository."""
    cmd = ctx.config.get("editor") or ctx.env.get("VISUAL") or ctx.env.get("EDITOR") or "vi"
    fd, name = tempfile.mkstemp(prefix="oscr-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(template)
        subprocess.run([*shlex.split(cmd), name], check=False)
        text = Path(name).read_text(encoding="utf-8")
    finally:
        Path(name).unlink(missing_ok=True)
    lines = [x for x in text.splitlines() if not x.startswith("<!-- oscr:")]
    return "\n".join(lines).strip()


def body_flags(p: argparse.ArgumentParser, what: str) -> None:
    g = p.add_mutually_exclusive_group()
    g.add_argument("-b", "--body", default=None, help=f"the {what}'s text")
    g.add_argument("-F", "--body-file", default=None, help=f"the {what}'s text from a file (- for standard input)")
    g.add_argument("-e", "--editor", action="store_true", help="write it in your editor")


def body_of(ctx: Any, args: argparse.Namespace, what: str) -> str:
    if args.body is not None:
        return args.body
    if args.body_file:
        if args.body_file == "-":
            return ctx.io.inp.read()
        try:
            return Path(args.body_file).read_text(encoding="utf-8")
        except OSError as e:
            raise UsageError(f"{args.body_file} cannot be read ({e.strerror}).") from e
    if args.editor:
        return editor(ctx, f"<!-- oscr: the {what}'s text, in Markdown; lines like this one are dropped -->\n")
    if ctx.io.prompt:
        ctx.io.err.write(f"? The {what}'s text (end with an empty line; --editor for your editor):\n")
        lines = []
        for line in ctx.io.inp:
            if not line.strip():
                break
            lines.append(line.rstrip("\n"))
        return "\n".join(lines)
    return ""
