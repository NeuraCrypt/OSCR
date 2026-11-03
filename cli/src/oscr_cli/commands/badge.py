"""`oscr badge`: the registry's badge for this clone's paper, printed, or written into its README
between two marks (docs/BADGE.md). It writes one file of the clone's working tree and nothing else:
committing and pushing stay the researcher's. Nothing is run, nothing is sent."""
from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from .. import badge
from ..errors import UsageError
from ..output import add_format_flags, emit
from ..parsing import command
from ..sanitize import clean_line
from .registry import layer

GROUP = "registry"
NAME = "badge"

FIELDS = ["doi", "repo", "image", "link", "snippet", "readme", "written"]


def _doi(text: str) -> str:
    """The same rule as the site's badgeDoi: a DOI, lower case, or ""."""
    t = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text.strip(), flags=re.I).strip()
    if "%" in t:
        t = unquote(t)
    t = t.lower()
    return t if re.fullmatch(r"10\.\d{3,9}/\S+", t) else ""


def _readme(top: Path, asked: str | None, fmt: str | None) -> tuple[Path, str]:
    """The README to write, and its markup (from its name unless --format says)."""
    if asked:
        p = (top / asked).resolve()
        if top.resolve() not in p.parents and p != top.resolve():
            raise UsageError("The README must be inside the clone.")
        guess = badge.README_NAMES.get(p.name, "markdown")
        return p, fmt or guess
    for name, kind in badge.README_NAMES.items():
        if (top / name).is_file() and (fmt is None or fmt == kind):
            return top / name, kind
    kind = fmt or "markdown"
    return top / {"markdown": "README.md", "rst": "README.rst", "asciidoc": "README.adoc", "org": "README.org", "html": "README.html"}[kind], kind


def _badge(ctx: Any, args: argparse.Namespace) -> int:
    repo = None
    doi = ""
    if args.doi:
        doi = _doi(args.doi)
        if not doi:
            raise UsageError(f"“{clean_line(args.doi)}” is not a DOI: write 10.1234/abcd.")
    if not doi or args.repo_badge:
        repo = ctx.repo()
    if not doi and not args.repo_badge:
        papers = layer(ctx, repo, offline=args.offline)["papers"]
        if len(papers) == 1:
            doi = papers[0]
        elif len(papers) > 1:
            ctx.io.warn(f"{repo.full} is the code of {len(papers)} papers: its own badge is used (or give one DOI).")
        else:
            ctx.io.warn(f"The registry links no paper to {repo.full} yet: its own badge is used (it says so, and links to the submission form).")
    key = f"{repo.host}/{repo.owner}/{repo.name}".lower() if repo and (args.repo_badge or not doi) else ""
    u = badge.urls(ctx.site_url(""), doi="" if key else doi, repo=key, style=args.style, show=args.show)

    top = ctx.git.toplevel(ctx.cwd) if (args.write or args.remove) else None
    if (args.write or args.remove) and top is None:
        raise UsageError("--write and --remove work in a clone: run them inside the repository.")
    readme_path, fmt = _readme(top, args.readme, args.format) if top is not None else (None, args.format or "markdown")
    text = badge.snippet(fmt, u["image"], u["link"], ctx.config.site_name)
    written = False
    if top is not None and readme_path is not None:
        old = readme_path.read_text(encoding="utf-8") if readme_path.is_file() else ""
        new = badge.remove(old, fmt) if args.remove else badge.insert(old, fmt, text)
        if new != old:
            readme_path.write_text(new, encoding="utf-8")
            written = True
    row = {"doi": "" if key else doi, "repo": key, "image": u["image"], "link": u["link"], "snippet": text,
           "readme": str(readme_path.relative_to(top)) if top is not None and readme_path is not None else "", "written": written}

    def human() -> None:
        if args.remove:
            ctx.io.say(f"The badge was taken out of {row['readme']}." if written else f"{row['readme']} carries no badge between the marks.")
            return
        if top is not None:
            ctx.io.print(text)
            ctx.io.say(f"Written into {row['readme']}, between the marks: review it, then commit and push it yourself."
                        if written else f"{row['readme']} already carries this badge.")
            return
        ctx.io.print(text)
        ctx.io.say(f"Paste it under your README's title, or run `oscr badge --write`. Every form and option: {ctx.site_url('/badge/')}")

    emit(ctx.io, args, row, human)
    return 0


def register(sub: Any) -> None:
    p = command(sub, "badge", help="the registry's badge for this repository's paper: print it, or write it into the README",
                handler=_badge, repo=True,
                examples_=["oscr badge", "oscr badge 10.5555/oscr.fixture.1 --write", "oscr badge --repo-badge --write --format rst",
                           "oscr badge --style large --show doi", "oscr badge --remove"])
    p.add_argument("doi", nargs="?", metavar="DOI", help="the paper (default: the one the registry links to the repository)")
    p.add_argument("--repo-badge", action="store_true", help="the repository's own badge, not the paper's")
    p.add_argument("--format", choices=badge.FORMATS, default=None, help="the markup (default: the README's, else Markdown)")
    p.add_argument("--style", choices=badge.STYLES, default="flat", help="the badge's shape")
    p.add_argument("--show", choices=badge.SHOWS, default="status", help="what the badge says")
    p.add_argument("--write", action="store_true", help="write it into the README, between two marks (replaced next time)")
    p.add_argument("--remove", action="store_true", help="take it out of the README")
    p.add_argument("--readme", default=None, metavar="PATH", help="the README to write (default: the clone's README.md, .rst, .adoc or .org)")
    p.add_argument("--offline", action="store_true", help=argparse.SUPPRESS)
    add_format_flags(p, FIELDS)
