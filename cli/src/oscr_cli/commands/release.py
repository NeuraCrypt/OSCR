"""``oscr release``: releases, made and read on GitHub with the person's own token; the registry's page of
each is where it is tied to a paper's version and its map (D07-2)."""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .. import github
from ..output import add_format_flags, ago, emit
from ..parsing import command, group
from ..sanitize import shown
from .common import page

NAME = "release"
GROUP = "github"

FIELDS = ["tag", "name", "draft", "prerelease", "published_at", "author", "page", "body"]


def _row(ctx: Any, repo: Any, x: dict[str, Any]) -> dict[str, Any]:
    tag = str(x.get("tag_name") or "")
    return {"tag": tag, "name": x.get("name") or tag, "draft": bool(x.get("draft")), "prerelease": bool(x.get("prerelease")),
            "published_at": x.get("published_at"), "author": (x.get("author") or {}).get("login"),
            "page": page(ctx, repo, f"releases/tag/{quote(tag, safe='')}"), "body": x.get("body") or ""}


def _create(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    notes = args.notes
    if args.notes_file:
        notes = ctx.io.inp.read() if args.notes_file == "-" else Path(args.notes_file).read_text(encoding="utf-8")
    body: dict[str, Any] = {"tag_name": args.tag, "name": args.title or args.tag, "body": notes or "", "draft": args.draft, "prerelease": args.prerelease,
                            "generate_release_notes": bool(args.generate_notes)}
    if args.target:
        body["target_commitish"] = args.target
    made = github.call(ctx, "POST", f"/repos/{repo.owner}/{repo.name}/releases", body=body).body or {}
    row = _row(ctx, repo, made)
    ctx.io.say(f"Made the release {shown(row['tag'])}{' (a draft)' if row['draft'] else ''} on {repo.full} (GitHub made it, as you). "
               f"On its page, tie it to the paper's version and its tracing map.")
    ctx.io.print(row["page"])
    return 0


def _list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    rows = [_row(ctx, repo, x) for x in github.pages(ctx, f"/repos/{repo.owner}/{repo.name}/releases", limit=args.limit)]

    def human() -> None:
        if not rows:
            ctx.io.say(f"No release on {repo.full}.")
            return
        ctx.io.table([(shown(r["tag"]), shown(r["name"]), "draft" if r["draft"] else ("pre-release" if r["prerelease"] else "published"), ago(r["published_at"])) for r in rows])

    emit(ctx.io, args, rows, human)
    return 0


def _view(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    if args.web:
        ctx.browse(page(ctx, repo, f"releases/tag/{quote(args.tag, safe='')}"))
        return 0
    x = github.get(ctx, f"/repos/{repo.owner}/{repo.name}/releases/tags/{quote(args.tag, safe='')}")
    row = _row(ctx, repo, x)

    def human() -> None:
        io = ctx.io
        io.print(io.style(f"{shown(row['name'])} ({shown(row['tag'])})", "bold"))
        state = "draft" if row["draft"] else ("pre-release" if row["prerelease"] else f"published {ago(row['published_at'])}")
        io.print(f"  {state}; by {shown(row['author'])}")
        io.print(f"  page: {row['page']}")
        if row["body"]:
            io.print("")
            io.print(shown(row["body"]))

    emit(ctx.io, args, row, human)
    return 0


def register(sub: Any) -> None:
    _, s = group(sub, "release", help="releases: make, list, read", examples_=["oscr release create v1.0.0 --title 'As published' --notes-file CHANGES.md", "oscr release list"])
    p = command(s, "create", help="make a release (GitHub makes it, as you); tie it to the paper on its page", handler=_create, repo=True,
                examples_=["oscr release create v1.0.0 --generate-notes", "oscr release create v1.1.0 --draft --notes 'Fixes the filter'"])
    p.add_argument("tag")
    p.add_argument("-t", "--title", default=None)
    g = p.add_mutually_exclusive_group()
    g.add_argument("-n", "--notes", default=None)
    g.add_argument("-F", "--notes-file", default=None, help="the notes from a file (- for standard input)")
    p.add_argument("--generate-notes", action="store_true", help="GitHub writes the notes from the merged pull requests")
    p.add_argument("-d", "--draft", action="store_true")
    p.add_argument("-p", "--prerelease", action="store_true")
    p.add_argument("--target", default=None, help="the branch or commit the tag is made at")
    p = command(s, "list", help="the repository's releases", handler=_list, repo=True, examples_=["oscr release list --json tag,published_at"])
    p.add_argument("-L", "--limit", type=int, default=30)
    add_format_flags(p, FIELDS)
    p = command(s, "view", help="one release (its page on the registry with --web)", handler=_view, repo=True, examples_=["oscr release view v1.0.0"])
    p.add_argument("tag")
    p.add_argument("-w", "--web", action="store_true")
    add_format_flags(p, FIELDS)
