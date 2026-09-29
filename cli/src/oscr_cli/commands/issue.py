"""``oscr issue``: GitHub's issues, made and read with the person's own token, and the registry's research
issues (a code error, a code–paper mismatch, a reproduction failure: D05-2), made through its API with
the registry's token. Each is shown with the registry's page (D14-10)."""
from __future__ import annotations

import argparse
from typing import Any

from .. import github, oscr_api
from ..errors import UsageError
from ..output import add_format_flags, ago, emit
from ..parsing import command, group
from ..sanitize import shown
from .common import ask, body_flags, body_of, page
from .registry import layer, normal_doi

NAME = "issue"
GROUP = "github"

FIELDS = ["number", "title", "state", "state_reason", "author", "labels", "comments", "page", "updated_at", "body"]
RESEARCH_TYPES = ("code_error", "mismatch", "reproduction")


def _row(ctx: Any, repo: Any, x: dict[str, Any]) -> dict[str, Any]:
    return {"number": x.get("number"), "title": x.get("title") or "", "state": x.get("state"), "state_reason": x.get("state_reason"),
            "author": (x.get("user") or {}).get("login"), "labels": [lb.get("name") for lb in x.get("labels") or [] if isinstance(lb, dict)],
            "comments": x.get("comments", 0), "page": page(ctx, repo, f"issues/{x.get('number')}"), "updated_at": x.get("updated_at"), "body": x.get("body") or ""}


def _me(ctx: Any) -> str:
    me = github.get(ctx, "/user") or {}
    return str(me.get("login") or "")


def _create(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    title = args.title or ask(ctx, "The issue's title", flag="--title")
    body = body_of(ctx, args, "issue")
    if args.research:
        if not args.paper:
            raise UsageError("A research issue is about a paper and its code: add --paper DOI.")
        view = layer(ctx, repo)
        entry = view["entry"] or {}
        rid = str(entry.get("id") or "")
        payload: dict[str, Any] = {"paper": normal_doi(args.paper), "type": args.research, "title": title, "body": body}
        if rid.isdigit():
            payload["repo"] = {"forge": "github", "id": rid, "path": repo.full}
        else:
            payload["code"] = f"https://github.com/{repo.full}"
        if args.commit:
            payload["commit"] = ctx.git.head(ctx.git.toplevel(ctx.cwd) or ctx.cwd, args.commit) if len(args.commit) != 40 else args.commit
        if args.path:
            payload["path"] = args.path
        if args.lines:
            a, _, b = args.lines.partition("-")
            if not a.isdigit() or (b and not b.isdigit()):
                raise UsageError("--lines is START-END, from line 1.")
            payload["lines"] = {"start": int(a), "end": int(b or a)}
        if args.paragraph is not None:
            payload["paragraph"] = args.paragraph
        if args.research == "reproduction":
            if not args.observed:
                raise UsageError("A reproduction failure says what came out: add --observed (and --expected, --command, --environment).")
            payload["report"] = {"outcome": args.outcome, "observed": args.observed, "expected": args.expected or "", "command": args.ran or "",
                                 "environment": args.environment or ""}
        made = oscr_api.post(ctx, "/research/open", payload) or {}
        ctx.io.say(f"Opened research issue {made.get('id')} on {payload['paper']} in {ctx.config.site_name}.")
        ctx.io.print(ctx.site_url(str(made.get("page") or f"/research/{made.get('id')}/")))
        return 0
    body_json: dict[str, Any] = {"title": title, "body": body}
    if args.label:
        body_json["labels"] = args.label
    if args.assignee:
        body_json["assignees"] = [_me(ctx) if a == "@me" else a for a in args.assignee]
    made = github.call(ctx, "POST", f"/repos/{repo.owner}/{repo.name}/issues", body=body_json).body or {}
    ctx.io.say(f"Opened issue #{made.get('number')} on {repo.full} (GitHub made it, as you).")
    ctx.io.print(page(ctx, repo, f"issues/{made.get('number')}"))
    return 0


def _list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    params: dict[str, Any] = {"state": args.state}
    if args.label:
        params["labels"] = ",".join(args.label)
    if args.assignee:
        params["assignee"] = _me(ctx) if args.assignee == "@me" else args.assignee
    if args.author:
        params["creator"] = _me(ctx) if args.author == "@me" else args.author
    items = github.pages(ctx, f"/repos/{repo.owner}/{repo.name}/issues", params, limit=args.limit)
    rows = [_row(ctx, repo, x) for x in items if "pull_request" not in x]

    def human() -> None:
        if not rows:
            ctx.io.say(f"No issue on {repo.full} ({args.state}).")
            return
        ctx.io.table([(f"#{r['number']}", shown(r["title"]), ", ".join(shown(x) for x in r["labels"]), ago(r["updated_at"])) for r in rows])

    emit(ctx.io, args, rows, human)
    return 0


def _view(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    if args.web:
        ctx.browse(page(ctx, repo, f"issues/{args.number}"))
        return 0
    x = github.get(ctx, f"/repos/{repo.owner}/{repo.name}/issues/{args.number}")
    row = _row(ctx, repo, x)

    def human() -> None:
        io = ctx.io
        io.print(io.style(f"#{row['number']} {shown(row['title'])}", "bold"))
        reason = f" ({row['state_reason']})" if row["state_reason"] else ""
        io.print(f"  {row['state']}{reason}; by {shown(row['author'])}; {row['comments']} comment{'s' if row['comments'] != 1 else ''}; updated {ago(row['updated_at'])}")
        if row["labels"]:
            io.print(f"  labels: {', '.join(shown(x) for x in row['labels'])}")
        io.print(f"  page: {row['page']}")
        if row["body"]:
            io.print("")
            io.print(shown(row["body"]))

    emit(ctx.io, args, row, human)
    return 0


def _close(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    if args.comment:
        github.call(ctx, "POST", f"/repos/{repo.owner}/{repo.name}/issues/{args.number}/comments", body={"body": args.comment})
    github.call(ctx, "PATCH", f"/repos/{repo.owner}/{repo.name}/issues/{args.number}", body={"state": "closed", "state_reason": args.reason})
    ctx.io.say(f"Closed #{args.number} on {repo.full} as {args.reason.replace('_', ' ')} (GitHub did it, as you).")
    ctx.io.print(page(ctx, repo, f"issues/{args.number}"))
    return 0


def register(sub: Any) -> None:
    _, s = group(sub, "issue", help="issues: GitHub's, and the registry's research issues",
                 examples_=["oscr issue create --title 'The filter differs from Methods' --research mismatch --paper 10.5555/oscr.fixture.1",
                            "oscr issue list --assignee @me", "oscr issue close 4 --reason not_planned"])
    p = command(s, "create", help="open an issue (GitHub's), or a research issue in the registry (--research)", handler=_create, repo=True,
                examples_=["oscr issue create --title 'Crash on empty epochs' --body-file bug.md --label bug",
                           "oscr issue create --research reproduction --paper 10.1234/abcd --title 'Figure 3 differs' --body 'With seed 1…'"])
    p.add_argument("-t", "--title", default=None)
    body_flags(p, "issue")
    p.add_argument("-l", "--label", action="append", default=[])
    p.add_argument("-a", "--assignee", action="append", default=[], help="a login, or @me")
    p.add_argument("--research", choices=RESEARCH_TYPES, default=None, help="a research issue of the registry, of this type")
    p.add_argument("--paper", default=None, metavar="DOI", help="the paper a research issue is about")
    p.add_argument("--commit", default=None, help="the commit a research issue is about")
    p.add_argument("--path", default=None, help="the file a research issue is about")
    p.add_argument("--lines", default=None, metavar="START-END", help="its lines")
    p.add_argument("--paragraph", type=int, default=None, help="the paper's paragraph (a mismatch names it)")
    p.add_argument("--outcome", choices=("failed", "partially"), default="failed", help="a reproduction: not reproduced, or partly")
    p.add_argument("--observed", default=None, help="a reproduction: what came out")
    p.add_argument("--expected", default=None, help="a reproduction: what the paper reports")
    p.add_argument("--command", dest="ran", default=None, help="a reproduction: what was run")
    p.add_argument("--environment", default=None, help="a reproduction: where (the system, the versions)")
    p = command(s, "list", help="the repository's issues (not its pull requests)", handler=_list, repo=True,
                examples_=["oscr issue list", "oscr issue list --state all --label bug --json number,title"])
    p.add_argument("-s", "--state", choices=("open", "closed", "all"), default="open")
    p.add_argument("-l", "--label", action="append", default=[])
    p.add_argument("-a", "--assignee", default=None, help="a login, or @me")
    p.add_argument("-A", "--author", default=None, help="a login, or @me")
    p.add_argument("-L", "--limit", type=int, default=30)
    add_format_flags(p, FIELDS)
    p = command(s, "view", help="one issue (its page on the registry with --web)", handler=_view, repo=True, examples_=["oscr issue view 4", "oscr issue view 4 --web"])
    p.add_argument("number", type=int)
    p.add_argument("-w", "--web", action="store_true")
    add_format_flags(p, FIELDS)
    p = command(s, "close", help="close an issue, completed or not planned", handler=_close, repo=True,
                examples_=["oscr issue close 4", "oscr issue close 4 --reason not_planned --comment 'Out of scope'"])
    p.add_argument("number", type=int)
    p.add_argument("-r", "--reason", choices=("completed", "not_planned"), default="completed")
    p.add_argument("-c", "--comment", default=None)
