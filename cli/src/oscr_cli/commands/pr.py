"""``oscr pr``: pull requests, made and read on GitHub with the person's own token; the registry's page of
each (its /r/ shell) is the one given (D14-10). Before a pull request is opened, the registry's checks
run on the change, on this machine, reading files as text."""
from __future__ import annotations

import argparse
from typing import Any

from .. import checks, github
from ..errors import CliError, UsageError
from ..output import add_format_flags, ago, emit
from ..parsing import command, group
from ..sanitize import clean_line, shown
from .common import ask, body_flags, body_of, page

NAME = "pr"
GROUP = "github"

FIELDS = ["number", "title", "state", "author", "head", "base", "draft", "page", "updated_at", "body"]


def _row(ctx: Any, repo: Any, x: dict[str, Any]) -> dict[str, Any]:
    return {"number": x.get("number"), "title": x.get("title") or "", "state": x.get("state"), "author": (x.get("user") or {}).get("login"),
            "head": (x.get("head") or {}).get("ref"), "base": (x.get("base") or {}).get("ref"), "draft": bool(x.get("draft")),
            "page": page(ctx, repo, f"pull/{x.get('number')}"), "updated_at": x.get("updated_at"), "body": x.get("body") or ""}


def _create(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    top = ctx.git.toplevel(ctx.cwd)
    head = args.head or (ctx.git.current_branch(top) if top else None)
    if not head:
        raise UsageError("Which branch? Run it on the branch to propose, or add --head BRANCH.")
    if top and not args.head:
        tracked = ctx.git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd=top, check=False).stdout.strip()
        if not tracked:
            if not args.push:
                raise UsageError(f"{head} is not on GitHub yet: push it first (git push -u origin {head}), or add --push.")
            ctx.git.run(["push", "--quiet", "-u", "origin", head], cwd=top, network=True)
            ctx.io.say(f"Pushed {head} to origin.")
    base = args.base or (github.get(ctx, f"/repos/{repo.owner}/{repo.name}") or {}).get("default_branch") or "main"
    title = args.title or ask(ctx, "The pull request's title", flag="--title")
    body = body_of(ctx, args, "pull request")
    if top and not args.no_checks:
        try:
            base_sha = ctx.git.head(top, f"origin/{base}")
            listing = ctx.git.tree(top, "HEAD")
            paths = [p for p, t, _ in listing if t == "blob"]
            texts = {p: ctx.git.read_text(top, "HEAD", p, max_bytes=checks.CHECK_TEXT_BYTES) for p in checks.check_files(paths).values() if p}
            diff = ctx.git.run(["diff", "--name-status", "-M", base_sha, "HEAD"], cwd=top).stdout.splitlines()
            files = []
            for line in diff:
                parts = line.split("\t")
                code = parts[0][:1]
                status = {"A": "added", "M": "modified", "D": "removed", "R": "renamed"}.get(code, "changed")
                files.append({"path": parts[-1], "previousPath": parts[1] if code == "R" else None, "status": status})
            report = checks.run_checks({"entries": [{"path": p, "type": t, "size": s} for p, t, s in listing], "truncated": False, "texts": texts,
                                        "papers": [], "traced": [], "change": {"files": files, "truncated": False}})
            ctx.io.say(f"The registry's checks on this change (read here, nothing run): {report.title}. `oscr check --base origin/{base}` says more.")
        except CliError:
            pass
    made = github.call(ctx, "POST", f"/repos/{repo.owner}/{repo.name}/pulls",
                       body={"title": title, "body": body, "head": head, "base": base, "draft": bool(args.draft)}).body or {}
    n = made.get("number")
    ctx.io.say(f"Opened pull request #{n} on {repo.full} (GitHub made it, as you).")
    ctx.io.print(page(ctx, repo, f"pull/{n}"))
    return 0


def _list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    items = github.pages(ctx, f"/repos/{repo.owner}/{repo.name}/pulls", {"state": args.state}, limit=args.limit)
    rows = [_row(ctx, repo, x) for x in items if not args.author or (x.get("user") or {}).get("login", "").lower() == args.author.lower()]

    def human() -> None:
        if not rows:
            ctx.io.say(f"No {args.state if args.state != 'all' else ''} pull request on {repo.full}.".replace("  ", " "))
            return
        ctx.io.table([(f"#{r['number']}", shown(r["title"]), f"{r['head']} → {r['base']}", r["author"], ago(r["updated_at"])) for r in rows])

    emit(ctx.io, args, rows, human)
    return 0


def _view(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    if args.web:
        ctx.browse(page(ctx, repo, f"pull/{args.number}"))
        return 0
    x = github.get(ctx, f"/repos/{repo.owner}/{repo.name}/pulls/{args.number}")
    row = _row(ctx, repo, x)

    def human() -> None:
        io = ctx.io
        state = "merged" if x.get("merged") else row["state"]
        io.print(io.style(f"#{row['number']} {shown(row['title'])}", "bold"))
        io.print(f"  {state}{' (draft)' if row['draft'] else ''}; {shown(row['head'])} → {shown(row['base'])}; by {shown(row['author'])}, updated {ago(row['updated_at'])}")
        io.print(f"  page: {row['page']}")
        if row["body"]:
            io.print("")
            io.print(shown(row["body"]))

    emit(ctx.io, args, row, human)
    return 0


def _checkout(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    top = ctx.git.toplevel(ctx.cwd)
    if top is None:
        raise UsageError("Run it inside a clone of the repository.")
    x = github.get(ctx, f"/repos/{repo.owner}/{repo.name}/pulls/{args.number}")
    branch = args.branch or clean_line((x.get("head") or {}).get("ref") or f"pr-{args.number}")
    if not branch or branch.startswith("-") or any(c in branch for c in " ~^:?*[\\"):
        branch = f"pr-{args.number}"
    remote = next((name for name, url in ctx.git.remotes(top) if f"{repo.owner}/{repo.name}".lower() in url.lower()), "origin")
    ctx.git.run(["fetch", "--quiet", remote, f"pull/{args.number}/head:{branch}"], cwd=top, network=True)
    ctx.git.run(["checkout", "--quiet", branch], cwd=top)
    ctx.io.say(f"On {branch}, the head of #{args.number} (hooks off; nothing of it was run). `oscr check --base {(x.get('base') or {}).get('ref') or 'main'}` checks it.")
    return 0


def register(sub: Any) -> None:
    _, s = group(sub, "pr", help="pull requests: open, list, read, check out",
                 examples_=["oscr pr create --title 'Fix the band-pass filter' --body 'As in Methods §2.3'", "oscr pr list", "oscr pr checkout 12"])
    p = command(s, "create", help="open a pull request from this branch (GitHub makes it, as you)", handler=_create, repo=True,
                examples_=["oscr pr create --title 'Fix the filter' --body-file notes.md", "oscr pr create --push --draft --title WIP --body ''"])
    p.add_argument("-t", "--title", default=None)
    body_flags(p, "pull request")
    p.add_argument("-B", "--base", default=None, help="the branch it goes into (default: the repository's default branch)")
    p.add_argument("-H", "--head", default=None, help="the branch it comes from (default: the current branch)")
    p.add_argument("-d", "--draft", action="store_true")
    p.add_argument("--push", action="store_true", help="push the branch first when it is not on GitHub")
    p.add_argument("--no-checks", action="store_true", help="do not run the registry's checks on the change first")
    p = command(s, "list", help="the pull requests of the repository", handler=_list, repo=True,
                examples_=["oscr pr list", "oscr pr list --state all --json number,title,state"])
    p.add_argument("-s", "--state", choices=("open", "closed", "all"), default="open")
    p.add_argument("-A", "--author", default=None)
    p.add_argument("-L", "--limit", type=int, default=30)
    add_format_flags(p, FIELDS)
    p = command(s, "view", help="one pull request (its page on the registry with --web)", handler=_view, repo=True,
                examples_=["oscr pr view 12", "oscr pr view 12 --web"])
    p.add_argument("number", type=int)
    p.add_argument("-w", "--web", action="store_true")
    add_format_flags(p, FIELDS)
    p = command(s, "checkout", help="check a pull request's head out in this clone (hooks off)", handler=_checkout, repo=True,
                examples_=["oscr pr checkout 12", "oscr pr checkout 12 --branch review-12"])
    p.add_argument("number", type=int)
    p.add_argument("-b", "--branch", default=None)
