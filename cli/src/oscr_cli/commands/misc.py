"""``oscr search``, ``oscr api``, ``oscr browse``, ``oscr run``, ``oscr workflow`` (D14-10): the registry
first — its search, its API, its pages, its Checks view — and GitHub's only for what only GitHub holds
(its code search, its API with --github, its blame and CI logs), each time said why."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .. import github, jq, oscr_api, template
from ..errors import AuthError, UsageError
from ..http import HttpError
from ..output import add_format_flags, ago, emit
from ..parsing import command, group
from ..sanitize import clean, shown
from .common import github_page, page, show_github

NAME = "search"
GROUP = "github"

SEARCH_TYPES = ("papers", "repositories", "issues", "people", "topics")
SEARCH_FIELDS = ["type", "id", "title", "page"]


# ── search ──


def _hit(kind: str, doc: dict[str, Any], ctx: Any) -> dict[str, Any]:
    ident = doc.get("doi") or doc.get("path") or doc.get("full_name") or doc.get("login") or doc.get("name") or doc.get("id") or ""
    title = doc.get("title") or doc.get("description") or doc.get("name") or doc.get("login") or ""
    link = doc.get("page") or doc.get("url") or doc.get("html_url") or ""
    if isinstance(link, str) and link.startswith("/"):
        link = ctx.site_url(link)
    return {"type": kind, "id": str(ident), "title": str(title), "page": str(link)}


def _search(ctx: Any, args: argparse.Namespace) -> int:
    q = " ".join(args.query).strip()
    if not q:
        raise UsageError("Search what? oscr search 'band power'")
    rows: list[dict[str, Any]] = []
    if args.github:
        path = {"repositories": "/search/repositories", "issues": "/search/issues", "code": "/search/code"}[args.github]
        res = github.call(ctx, "GET", path, params={"q": q, "per_page": min(100, args.limit)}, anonymous_ok=True).body or {}
        for x in (res.get("items") or [])[: args.limit]:
            rows.append({"type": f"github {args.github}", "id": str(x.get("full_name") or x.get("number") or x.get("path") or ""),
                         "title": str(x.get("description") or x.get("title") or x.get("name") or ""), "page": str(x.get("html_url") or "")})
        why = "the registry does not index GitHub's code and everything on GitHub (--github)"
        source = f"GitHub's search, because {why}"
    else:
        params = {"q": q, "type": args.type}
        try:
            body = oscr_api.call(ctx, "GET", "/search", params=params).body or {}
            source = f"{ctx.config.site_name}'s search"
        except AuthError:
            res = ctx.http.request("GET", ctx.config.base_url() + "/api/search?" + "&".join(f"{k}={quote(str(v))}" for k, v in params.items()))
            body = res.body or {}
            source = f"{ctx.config.site_name}'s search"
        for doc in (body.get("results") or [])[: args.limit]:
            if isinstance(doc, dict):
                rows.append(_hit(args.type, doc, ctx))

    def human() -> None:
        if not rows:
            ctx.io.say(f"Nothing found ({source}).")
            return
        ctx.io.table([(r["id"], shown(r["title"]), r["page"]) for r in rows])
        ctx.io.say(f"From {source}.")

    emit(ctx.io, args, rows, human)
    return 0


# ── api ──


def _typed(value: str) -> Any:
    if value in ("true", "false"):
        return value == "true"
    if value == "null":
        return None
    if re.match(r"^-?\d{1,15}$", value):
        return int(value)
    if value.startswith("@"):
        return Path(value[1:]).read_text(encoding="utf-8")
    return value


def _api(ctx: Any, args: argparse.Namespace) -> int:
    fields: dict[str, Any] = {}
    for f in args.raw_field:
        k, sep, v = f.partition("=")
        if not sep or not k:
            raise UsageError(f"-f takes key=value, not “{f}”.")
        fields[k] = v
    for f in args.field:
        k, sep, v = f.partition("=")
        if not sep or not k:
            raise UsageError(f"-F takes key=value, not “{f}”.")
        fields[k] = _typed(v)
    method = (args.method or ("POST" if fields or args.input else "GET")).upper()
    body: Any = None
    if args.input:
        text = ctx.io.inp.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        try:
            body = json.loads(text)
        except ValueError as e:
            raise UsageError(f"--input is not JSON ({e}).") from e
    elif fields and method != "GET":
        body = fields
    params = fields if method == "GET" and fields else None
    path = args.path if args.path.startswith("/") else "/" + args.path
    try:
        if args.github:
            res = github.call(ctx, method, path, params=params, body=body, anonymous_ok=True)
        else:
            sub = path[len("/api/v1"):] if path.startswith("/api/v1") else path
            res = oscr_api.call(ctx, method, sub or "", params=params, body=body)
    except HttpError as e:
        ctx.io.print(json.dumps(e.body, indent=2, ensure_ascii=False) if e.body is not None else "")
        raise
    if args.include:
        ctx.io.print(f"HTTP {res.status}")
        for k, v in res.headers.items():
            if k.lower() not in ("set-cookie", "authorization"):
                ctx.io.print(f"{k}: {v}")
        ctx.io.print("")
    data = res.body
    if data is None:
        ctx.io.print(clean(res.text))
        return 0
    if args.jq is not None:
        for v in jq.run(args.jq, data):
            ctx.io.print(clean(v) if isinstance(v, str) else json.dumps(v, ensure_ascii=False))
    elif args.template is not None:
        ctx.io.write(clean(template.render(args.template, data, color=ctx.io.color)))
    else:
        ctx.io.print(json.dumps(data, indent=2 if ctx.io.out_tty else None, ensure_ascii=False))
    return 0


# ── browse ──


def _browse(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    ref = args.commit or args.branch
    if args.commit == "":
        top = ctx.git.toplevel(ctx.cwd)
        ref = ctx.git.head(top) if top else None
    suffix = ""
    gh_suffix = ""
    loc = args.location
    if args.settings:
        suffix = "settings/"
    elif args.issues:
        suffix = "issues"
    elif args.pulls:
        suffix = "pulls"
    elif args.releases:
        suffix = "releases"
    elif args.checks:
        top = ctx.git.toplevel(ctx.cwd)
        suffix = f"checks/{quote(ref or (ctx.git.head(top) if top else 'HEAD'), safe='')}"
    elif loc and re.match(r"^\d{1,9}$", loc):
        suffix = f"issues/{loc}"
        gh_suffix = f"issues/{loc}"
    elif loc and re.match(r"^[0-9a-f]{7,64}$", loc):
        suffix = f"commit/{loc}"
        gh_suffix = f"commit/{loc}"
    elif loc:
        m = re.match(r"^(.+?)(?::(\d{1,7})(?:-(\d{1,7}))?)?$", loc)
        path, a, b = (m.group(1), m.group(2), m.group(3)) if m else (loc, None, None)
        if path.startswith("/") or any(s in ("", ".", "..") for s in path.split("/")):
            raise UsageError(f"{path} is not a path inside the repository.")
        branch = ref or (github.get(ctx, f"/repos/{repo.owner}/{repo.name}").get("default_branch") if not args.blame else None) or "HEAD"
        anchor = f"#L{a}" + (f"-L{b}" if b else "") if a else ""
        suffix = f"blob/{quote(branch, safe='/')}/{quote(path)}{anchor}"
        gh_suffix = f"{'blame' if args.blame else 'blob'}/{quote(branch, safe='/')}/{quote(path)}{anchor}"
    elif ref:
        suffix = f"tree/{quote(ref, safe='/')}"
        gh_suffix = suffix
    if args.blame:
        if not loc:
            raise UsageError("Blame a file: oscr browse PATH --blame (or `git blame PATH` here, on your machine).")
        show_github(ctx, github_page(ctx, repo, gh_suffix), "a file's blame is GitHub's own page (the registry does not compute it, D02-5); `git blame` does it here too")
        return 0
    if args.github:
        show_github(ctx, github_page(ctx, repo, gh_suffix), "you asked for it (--github)")
        return 0
    url = page(ctx, repo, suffix)
    if args.no_browser:
        ctx.io.print(url)
    else:
        ctx.browse(url)
    return 0


# ── run, workflow ──

RUN_FIELDS = ["id", "name", "status", "conclusion", "branch", "event", "sha", "created_at", "page", "github_url"]


def _run_row(ctx: Any, repo: Any, x: dict[str, Any]) -> dict[str, Any]:
    sha = str(x.get("head_sha") or "")
    return {"id": x.get("id"), "name": x.get("name") or x.get("display_title") or "", "status": x.get("status"), "conclusion": x.get("conclusion"),
            "branch": x.get("head_branch"), "event": x.get("event"), "sha": sha, "created_at": x.get("created_at"),
            "page": page(ctx, repo, f"checks/{sha}") if sha else "", "github_url": x.get("html_url") or ""}


def _state(r: dict[str, Any]) -> tuple[str, str]:
    if r["status"] != "completed":
        return (str(r["status"] or "queued").replace("_", " "), "warning")
    c = str(r["conclusion"] or "")
    return (c.replace("_", " ") or "completed", {"success": "ok", "failure": "failure", "cancelled": "muted", "skipped": "muted"}.get(c, "warning"))


def _run_list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    params: dict[str, Any] = {"per_page": min(100, args.limit)}
    if args.branch:
        params["branch"] = args.branch
    body = github.call(ctx, "GET", f"/repos/{repo.owner}/{repo.name}/actions/runs", params=params, anonymous_ok=True).body or {}
    rows = [_run_row(ctx, repo, x) for x in (body.get("workflow_runs") or [])[: args.limit]]
    if args.workflow:
        rows = [r for r in rows if str(r["name"]).lower() == args.workflow.lower()]

    def human() -> None:
        if not rows:
            ctx.io.say(f"No run of {repo.full}'s own CI (GitHub Actions).")
            return
        out = []
        for r in rows:
            word, style = _state(r)
            out.append((word, shown(r["name"]), shown(r["branch"]), shown(r["event"]), ago(r["created_at"]), str(r["id"])))
        ctx.io.table(out, headers=("state", "workflow", "branch", "event", "started", "id"))
        ctx.io.say(f"The repository's own CI, on GitHub Actions. Each commit's checks, the registry's included: {page(ctx, repo, 'checks/<commit>')}")

    emit(ctx.io, args, rows, human)
    return 0


def _run_view(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    x = github.call(ctx, "GET", f"/repos/{repo.owner}/{repo.name}/actions/runs/{args.id}", anonymous_ok=True).body or {}
    row = _run_row(ctx, repo, x)
    if args.web:
        ctx.browse(row["page"] or page(ctx, repo))
        return 0
    jobs = (github.call(ctx, "GET", f"/repos/{repo.owner}/{repo.name}/actions/runs/{args.id}/jobs", anonymous_ok=True).body or {}).get("jobs") or []
    row["jobs"] = [{"name": j.get("name"), "conclusion": j.get("conclusion"), "failed_steps": [s.get("name") for s in j.get("steps") or [] if s.get("conclusion") == "failure"]} for j in jobs]

    def human() -> None:
        word, style = _state(row)
        ctx.io.print(ctx.io.style(f"{shown(row['name'])}: {word}", style))
        ctx.io.print(f"  {shown(row['event'])} on {shown(row['branch'])} at {row['sha'][:12]}, {ago(row['created_at'])}")
        for j in row["jobs"]:
            ctx.io.print(f"  job {shown(j['name'])}: {shown(j['conclusion'] or 'running')}" + (f" — failed at: {', '.join(shown(s) for s in j['failed_steps'])}" if j["failed_steps"] else ""))
        ctx.io.print(f"  checks of this commit: {row['page']}")
        show_github(ctx, row["github_url"], "the run's logs are GitHub's own page (downloading them needs a GitHub sign-in, D10-10)")

    emit(ctx.io, args, row, human)
    return 0


def _workflow_list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    body = github.call(ctx, "GET", f"/repos/{repo.owner}/{repo.name}/actions/workflows", anonymous_ok=True).body or {}
    rows = [{"name": w.get("name"), "state": w.get("state"), "path": w.get("path"), "id": w.get("id")} for w in body.get("workflows") or []]

    def human() -> None:
        if not rows:
            ctx.io.say(f"{repo.full} has no GitHub Actions workflow.")
            return
        ctx.io.table([(shown(r["name"]), shown(r["state"]), shown(r["path"])) for r in rows], headers=("workflow", "state", "file"))
        ctx.io.say("The registry reads the environments they test on each commit's Checks page (oscr browse --checks).")

    emit(ctx.io, args, rows, human)
    return 0


def register(sub: Any) -> None:
    p = command(sub, "search", help="the registry's search (papers, repositories, research issues, people, topics); GitHub's with --github", handler=_search,
                examples_=["oscr search 'band power' ", "oscr search eeg --type repositories", "oscr search 'filter' --github code"])
    p.add_argument("query", nargs="+")
    p.add_argument("--type", choices=SEARCH_TYPES, default="papers")
    p.add_argument("--github", choices=("repositories", "issues", "code"), default=None, help="GitHub's own search instead, for what only it indexes")
    p.add_argument("-L", "--limit", type=int, default=20)
    add_format_flags(p, SEARCH_FIELDS)

    p = command(sub, "api", help="a request to the registry's API (/api/v1), or GitHub's with --github; the JSON answer", handler=_api,
                examples_=["oscr api /user", "oscr api /repos -f path=lab/eeg-analysis --jq .papers", "oscr api --github /repos/lab/eeg-analysis/releases --jq '.[].tag_name'",
                           "oscr api -X POST /social/star -F on=true -f subject=paper:doi:10.5555/oscr.fixture.1"])
    p.add_argument("path")
    p.add_argument("-X", "--method", default=None)
    p.add_argument("-f", "--raw-field", action="append", default=[], metavar="KEY=VALUE", help="a string field (a query parameter for GET)")
    p.add_argument("-F", "--field", action="append", default=[], metavar="KEY=VALUE", help="a typed field: true, false, null, numbers, @file")
    p.add_argument("--input", default=None, help="the JSON body from a file (- for standard input)")
    p.add_argument("--github", action="store_true", help="GitHub's API, with your GitHub token")
    p.add_argument("-i", "--include", action="store_true", help="print the answer's status and headers")
    p.add_argument("-q", "--jq", default=None)
    p.add_argument("-t", "--template", default=None)

    p = command(sub, "browse", help="open the registry's page of the repository, a file, a line, an issue, a commit", handler=_browse, repo=True,
                examples_=["oscr browse", "oscr browse analysis/preprocess.py:4-5 --commit", "oscr browse 12", "oscr browse --checks", "oscr browse src/a.py --blame"])
    p.add_argument("location", nargs="?", metavar="PATH[:LINE] | NUMBER | COMMIT")
    p.add_argument("-b", "--branch", default=None)
    p.add_argument("-c", "--commit", nargs="?", const="", default=None, help="at this commit (alone: the clone's HEAD)")
    p.add_argument("-s", "--settings", action="store_true")
    p.add_argument("--issues", action="store_true")
    p.add_argument("--pulls", action="store_true")
    p.add_argument("--releases", action="store_true")
    p.add_argument("--checks", action="store_true", help="the checks of a commit: the registry's, the repository's own CI, the statuses")
    p.add_argument("--blame", action="store_true", help="GitHub's blame page of a file (the registry has none)")
    p.add_argument("--github", action="store_true", help="GitHub's page instead")
    p.add_argument("-n", "--no-browser", action="store_true", help="print the address")

    _, rs = group(sub, "run", help="the repository's own CI runs (GitHub Actions): summaries and links",
                  examples_=["oscr run list", "oscr run view 123456"])
    p = command(rs, "list", help="the latest runs", handler=_run_list, repo=True, examples_=["oscr run list --branch main --limit 5"])
    p.add_argument("-L", "--limit", type=int, default=20)
    p.add_argument("-b", "--branch", default=None)
    p.add_argument("-w", "--workflow", default=None)
    add_format_flags(p, RUN_FIELDS)
    p = command(rs, "view", help="one run: its jobs, the steps that failed; its commit's checks on the registry", handler=_run_view, repo=True,
                examples_=["oscr run view 123456", "oscr run view 123456 --web"])
    p.add_argument("id", type=int)
    p.add_argument("-w", "--web", action="store_true", help="open the commit's Checks page on the registry")
    add_format_flags(p, RUN_FIELDS + ["jobs"])
    _, ws = group(sub, "workflow", help="the repository's GitHub Actions workflows", examples_=["oscr workflow list"])
    p = command(ws, "list", help="its workflows and their state", handler=_workflow_list, repo=True, examples_=["oscr workflow list --json name,path"])
    add_format_flags(p, ["name", "state", "path", "id"])

