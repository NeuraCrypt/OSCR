"""``oscr repo``: a repository, the registry's view of it first (D14-10). The GitHub side talks to GitHub
with the person's own token (create, list, view's GitHub part, sync of a fork); git runs on the person's
machine with its hooks off (clone, sync of a clone)."""
from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

from .. import github, gitlocal, trace
from ..context import DEFAULT_REPO_KEY
from ..errors import CliError, UsageError
from ..output import add_format_flags, ago, emit
from ..parsing import command, group
from ..sanitize import clean_line, shown
from .common import ask, page
from .registry import layer, link_paper, maps_of, normal_doi

NAME = "repo"
GROUP = "github"

VIEW_FIELDS = ["owner", "name", "description", "page", "registry", "papers", "maps", "default_branch", "license", "visibility", "pushed_at", "github_url"]
LIST_FIELDS = ["name", "description", "page", "registry", "visibility", "pushed_at"]


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
        raise UsageError(f"“{clean_line(args.target)}” is not a repository: write owner/name.")
    ctx.git.config_set(top, DEFAULT_REPO_KEY, r.full if r.host == ctx.config.github_host else f"{r.host}/{r.full}")
    ctx.io.say(f"This clone's commands now go to {r.full}.")
    return 0


def _named(ctx: Any, args: argparse.Namespace) -> gitlocal.RepoName:
    if getattr(args, "target", None):
        r = gitlocal.parse_repo(args.target, ctx.config.github_host)
        if r is None:
            raise UsageError(f"“{clean_line(args.target)}” is not a repository: write owner/name.")
        return r
    return ctx.repo()


# ── create ──


def _create(ctx: Any, args: argparse.Namespace) -> int:
    if args.private:
        raise UsageError("The registry holds public repositories only (research code, open to its readers): make a private one on GitHub itself.")
    name = args.name or ask(ctx, "The repository's name", flag="NAME")
    if not re.match(r"^[A-Za-z0-9._-]{1,100}$", name) or name in (".", ".."):
        raise UsageError("A repository's name is letters, digits, . - and _ (100 at most).")
    doi = normal_doi(args.paper) if args.paper else None
    body: dict[str, Any] = {"name": name, "private": False, "auto_init": bool(args.add_readme or args.license or args.gitignore)}
    for k, v in (("description", args.description), ("homepage", args.homepage or (f"https://doi.org/{doi}" if doi else None)),
                 ("license_template", args.license), ("gitignore_template", args.gitignore)):
        if v:
            body[k] = v
    made = github.call(ctx, "POST", "/user/repos", body=body).body or {}
    full = str(made.get("full_name") or "")
    repo = gitlocal.parse_repo(full, ctx.config.github_host)
    if repo is None:
        raise CliError("GitHub's answer does not name the repository it made.")
    ctx.io.say(f"Made {repo.full} on GitHub, public, with your own GitHub account.")
    ctx.io.print(page(ctx, repo))
    if doi:
        ctx.io.say(f"Next, attach it to {doi} in {ctx.config.site_name}:")
        link_paper(ctx, doi, repo, no_browser=args.no_browser)
    else:
        ctx.io.say(f"To attach it to its paper in {ctx.config.site_name}: oscr paper link <DOI> -R {repo.full}")
    if args.clone:
        _clone_into(ctx, repo, None)
    return 0


# ── clone ──


def _git_url(ctx: Any, repo: gitlocal.RepoName) -> str:
    base = (ctx.config.get("git_url") or ctx.config.github_web).rstrip("/")
    if ctx.config.get("git_protocol") == "ssh" and not ctx.config.get("git_url"):
        return f"git@{ctx.config.github_host}:{repo.owner}/{repo.name}.git"
    return f"{base}/{repo.owner}/{repo.name}.git"


def _clone_into(ctx: Any, repo: gitlocal.RepoName, directory: str | None) -> Path:
    target = Path(directory) if directory else ctx.cwd / repo.name
    if not target.is_absolute():
        target = ctx.cwd / target
    if target.exists() and any(target.iterdir()):
        raise UsageError(f"{target} exists and is not empty.")
    url = _git_url(ctx, repo)
    ctx.io.say(f"Cloning {repo.full} from {clean_line(url)} (git, straight from GitHub; hooks off)…")
    ctx.git.run(["clone", "--quiet", url, str(target)], cwd=ctx.cwd, network=True)
    ctx.git.run(["config", "--local", DEFAULT_REPO_KEY, repo.full], cwd=target)
    return target


def _clone(ctx: Any, args: argparse.Namespace) -> int:
    repo = _named(ctx, args)
    target = _clone_into(ctx, repo, args.directory)
    try:
        info = github.get(ctx, f"/repos/{repo.owner}/{repo.name}")
    except CliError:
        info = {}
    parent = (info.get("parent") or {}).get("full_name") if isinstance(info, dict) else None
    if parent:
        pr = gitlocal.parse_repo(str(parent), ctx.config.github_host)
        if pr:
            ctx.git.run(["remote", "add", "upstream", _git_url(ctx, pr)], cwd=target, check=False)
            ctx.io.say(f"It is a fork of {pr.full}: its remote `upstream` points there.")
    ctx.io.say(f"Cloned into {target}. Its page: {page(ctx, repo)}")
    return 0


# ── view, list ──


def _view(ctx: Any, args: argparse.Namespace) -> int:
    repo = _named(ctx, args)
    if args.web:
        ctx.browse(page(ctx, repo))
        return 0
    view = layer(ctx, repo)
    maps = maps_of(ctx, repo)
    try:
        info = github.get(ctx, f"/repos/{repo.owner}/{repo.name}")
    except CliError as e:
        info = {}
        ctx.io.warn(f"GitHub's side could not be read ({e.message}).")
    data = {
        "owner": repo.owner, "name": repo.name, "description": info.get("description") or "", "page": page(ctx, repo),
        "registry": "linked" if view["known"] else ("in the catalogue" if view["entry"] else "not linked"),
        "papers": view["papers"], "maps": len(maps), "default_branch": info.get("default_branch"),
        "license": (info.get("license") or {}).get("spdx_id"), "visibility": info.get("visibility"), "pushed_at": info.get("pushed_at"),
        "github_url": info.get("html_url"),
    }

    def human() -> None:
        io = ctx.io
        io.print(io.style(repo.full, "bold") + (f", {shown(data['description'])}" if data["description"] else ""))
        io.print(f"  {ctx.config.site_name}: {data['registry']}; " + (f"papers {', '.join(data['papers'])}" if data["papers"] else "no paper linked")
                 + f"; {data['maps']} tracing map{'s' if data['maps'] != 1 else ''}  ({view['source']})")
        io.print(f"  page: {data['page']}")
        if info:
            io.print(f"  GitHub: {data['visibility'] or '?'}, default branch {shown(data['default_branch'])}, licence {shown(data['license'] or 'none recognised')}, "
                     f"last push {ago(data['pushed_at'])}")
        if not data["papers"]:
            io.say("Attach it to its paper: oscr paper link <DOI>")

    emit(ctx.io, args, data, human)
    return 0


def _list(ctx: Any, args: argparse.Namespace) -> int:
    if args.owner:
        items = github.pages(ctx, f"/users/{args.owner}/repos", {"type": "owner", "sort": "pushed"}, limit=args.limit)
    else:
        items = github.pages(ctx, "/user/repos", {"visibility": "public", "affiliation": "owner", "sort": "pushed"}, limit=args.limit)
    items = [x for x in items if not x.get("private")]
    shards: dict[str, dict[str, Any]] = {}
    rows = []
    for x in items:
        r = gitlocal.parse_repo(str(x.get("full_name")), ctx.config.github_host)
        if r is None:
            continue
        s = trace.shard_of(r.owner, r.name)
        if s not in shards and not args.offline:
            from .registry import _static

            shards[s] = _static(ctx, f"/forge/layer/{s}.json") or {}
        entry = (shards.get(s) or {}).get(r.full.lower())
        state = "not linked" if not isinstance(entry, dict) else ("linked" if entry.get("mode") not in (None, "catalogue") else "in the catalogue")
        rows.append({"name": r.full, "description": x.get("description") or "", "page": page(ctx, r), "registry": state,
                     "visibility": x.get("visibility") or "public", "pushed_at": x.get("pushed_at")})

    def human() -> None:
        if not rows:
            ctx.io.say("No public repository.")
            return
        ctx.io.table([(r["name"], r["registry"], shown(r["description"]), ago(r["pushed_at"])) for r in rows], headers=("repository", ctx.config.site_name, "description", "pushed"))

    emit(ctx.io, args, rows, human)
    return 0


# ── sync ──


def _sync(ctx: Any, args: argparse.Namespace) -> int:
    if args.target:
        repo = _named(ctx, args)
        body = {"branch": args.branch} if args.branch else {"branch": (github.get(ctx, f"/repos/{repo.owner}/{repo.name}") or {}).get("default_branch", "main")}
        out = github.call(ctx, "POST", f"/repos/{repo.owner}/{repo.name}/merge-upstream", body=body).body or {}
        ctx.io.say(f"{repo.full}: {shown(out.get('message') or 'synced with its parent')} (GitHub did it, as you).")
        return 0
    top = ctx.git.toplevel(ctx.cwd)
    if top is None:
        raise UsageError("Run it in a clone (it fast-forwards the current branch), or name a fork: oscr repo sync OWNER/NAME.")
    branch = ctx.git.current_branch(top)
    if not branch:
        raise UsageError("The clone is on no branch (a detached HEAD): check a branch out first.")
    ctx.git.run(["fetch", "--quiet", "--all", "--prune"], cwd=top, network=True)
    upstream = ctx.git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd=top, check=False).stdout.strip()
    if not upstream:
        raise UsageError(f"{branch} follows no remote branch: git branch --set-upstream-to origin/{branch}")
    p = ctx.git.run(["merge", "--ff-only", "--quiet", upstream], cwd=top, check=False)
    if p.returncode != 0:
        raise CliError(f"{branch} and {upstream} have both moved: the tool fast-forwards only (merge or rebase them yourself).")
    ctx.io.say(f"{branch} is at {upstream} ({ctx.git.head(top)[:12]}).")
    return 0


def register(sub: Any) -> None:
    _, rs = group(sub, "repo", help="a repository: the registry's view, then GitHub's",
                  examples_=["oscr repo view", "oscr repo view --web", "oscr repo create eeg-analysis --license mit --paper 10.5555/oscr.fixture.1", "oscr repo clone lab/eeg-analysis"])
    p = command(rs, "create", help="make a public repository on GitHub (as you), then attach it to its paper", handler=_create,
                examples_=["oscr repo create eeg-analysis --description 'EEG preprocessing' --license mit --add-readme", "oscr repo create tool --paper 10.1234/abcd --clone"])
    p.add_argument("name", nargs="?", metavar="NAME")
    p.add_argument("-d", "--description", default=None)
    p.add_argument("--homepage", default=None, help="its address (default with --paper: the paper's DOI)")
    p.add_argument("--license", default=None, metavar="KEY", help="a licence of GitHub's templates: mit, apache-2.0, bsd-3-clause, gpl-3.0…")
    p.add_argument("--gitignore", default=None, metavar="TEMPLATE", help="a .gitignore of GitHub's templates: Python, R, Julia…")
    p.add_argument("--add-readme", action="store_true", help="start it with a README")
    p.add_argument("--paper", default=None, metavar="DOI", help="the paper it carries out: the registry's page to link it opens next")
    p.add_argument("--private", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--clone", action="store_true", help="clone it here after")
    p.add_argument("--no-browser", action="store_true", help="print the registry's page instead of opening it")

    p = command(rs, "clone", help="clone a repository (git, straight from GitHub, hooks off)", handler=_clone,
                examples_=["oscr repo clone lab/eeg-analysis", "oscr repo clone lab/eeg-analysis work/eeg"])
    p.add_argument("target", metavar="OWNER/NAME")
    p.add_argument("directory", nargs="?")

    p = command(rs, "view", help="the registry's view of a repository (papers, maps), then GitHub's", handler=_view,
                examples_=["oscr repo view", "oscr repo view lab/eeg-analysis --json papers,maps", "oscr repo view --web"])
    p.add_argument("target", nargs="?", metavar="OWNER/NAME")
    p.add_argument("-w", "--web", action="store_true", help="open the registry's page")
    add_format_flags(p, VIEW_FIELDS)

    p = command(rs, "list", help="your public repositories on GitHub (or an owner's), and whether the registry links them", handler=_list,
                examples_=["oscr repo list", "oscr repo list lab --limit 50 --json name,registry"])
    p.add_argument("owner", nargs="?")
    p.add_argument("-L", "--limit", type=int, default=30)
    p.add_argument("--offline", action="store_true", help="do not read the registry's layer")
    add_format_flags(p, LIST_FIELDS)

    p = command(rs, "sync", help="fast-forward this clone's branch from its remote, or a fork on GitHub from its parent", handler=_sync,
                examples_=["oscr repo sync", "oscr repo sync ada/eeg-analysis --branch main"])
    p.add_argument("target", nargs="?", metavar="OWNER/NAME")
    p.add_argument("-b", "--branch", default=None)

    p = command(rs, "set-default", help="the repository this clone's commands go to", handler=_set_default,
                examples_=["oscr repo set-default lab/eeg-analysis", "oscr repo set-default --view", "oscr repo set-default --unset"])
    p.add_argument("target", nargs="?", metavar="OWNER/NAME")
    p.add_argument("--view", action="store_true", help="print the default")
    p.add_argument("--unset", action="store_true", help="remove the default")
