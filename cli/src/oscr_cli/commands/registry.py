"""The registry's own commands (D14-7 to D14-9, D14-6): ``oscr paper``, ``oscr trace``, ``oscr cite``,
``oscr check``. They read the clone's files as text (``git show``, ``git ls-tree``) and never run them."""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .. import __version__, checks, citation, oscr_api, trace
from ..errors import AuthError, CheckFailed, CliError, UsageError
from ..gitlocal import RepoName
from ..output import add_format_flags, emit
from ..parsing import command, group
from ..sanitize import clean, clean_line, shown

NAME = "paper"
GROUP = "registry"

DOI = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)?(10\.\d{4,9}/[^\s\"<>@]{1,190})$", re.I)


def normal_doi(text: str) -> str:
    m = DOI.match(text.strip())
    if not m:
        raise UsageError(f"“{clean_line(text)}” is not a DOI: write it as 10.1234/abcd (doi: and doi.org forms are read too).")
    return m.group(1).lower()


def _top(ctx: Any) -> Path:
    top = ctx.git.toplevel(ctx.cwd)
    if top is None:
        raise UsageError("Run this inside a clone of the repository (git clone, or oscr repo clone).")
    return top


def _static(ctx: Any, path: str) -> Any:
    """One of the registry's static files (no token, no Worker request), or None when it is not there."""
    try:
        res = ctx.http.request("GET", ctx.config.base_url() + path, ok=(404,))
    except CliError:
        return None
    return res.body if res.status == 200 else None


def layer(ctx: Any, repo: RepoName, *, offline: bool = False) -> dict[str, Any]:
    """The registry's view of a repository: {known, papers [DOI], source}. Signed in: the API's live
    layer; else last night's static shard."""
    if offline:
        return {"known": None, "papers": [], "source": "offline", "entry": None}
    try:
        res = oscr_api.call(ctx, "GET", "/repos", params={"path": repo.full}, ok=(404, 410))
        if res.status == 200 and isinstance(res.body, dict):
            papers = [str(p.get("doi", "")).lower() for p in res.body.get("papers") or [] if p.get("doi")]
            return {"known": True, "papers": papers, "source": "the registry, now", "entry": res.body}
        if res.status in (404, 410):
            return {"known": False, "papers": [], "source": "the registry, now", "entry": None}
    except AuthError:
        pass
    except CliError as e:
        ctx.io.warn(f"The registry's live view could not be read ({e.message}); last night's is used.")
    entry = (_static(ctx, f"/forge/layer/{trace.shard_of(repo.owner, repo.name)}.json") or {}).get(repo.full.lower())
    if not isinstance(entry, dict):
        return {"known": False, "papers": [], "source": "last night's layer", "entry": None}
    papers = [str(p.get("doi", "")).lower() for p in entry.get("papers") or [] if isinstance(p, dict) and p.get("doi")]
    return {"known": entry.get("mode") not in (None, "catalogue"), "papers": papers, "source": "last night's layer", "entry": entry}


def maps_of(ctx: Any, repo: RepoName) -> list[dict[str, Any]]:
    """The tracing maps the registry holds for the repository (its static shard)."""
    data = _static(ctx, f"/forge/traced/{trace.shard_of(repo.owner, repo.name)}.json") or {}
    maps = data.get(repo.full.lower()) if isinstance(data, dict) else None
    return [m for m in maps or [] if isinstance(m, dict) and trace.OBJECT_ID.match(str(m.get("commit", "")))]


# ── oscr paper ──


def _paper_link(ctx: Any, args: argparse.Namespace) -> int:
    return link_paper(ctx, normal_doi(args.doi), ctx.repo(), no_browser=args.no_browser)


def link_paper(ctx: Any, doi: str, repo: RepoName, *, no_browser: bool = False) -> int:
    """The site's own write path for a paper link (D01-7): its page opened, pre-filled; the person confirms
    and authorizes the one action on GitHub."""
    if repo.host != ctx.config.github_host:
        raise UsageError(f"{repo.host} is not GitHub: the registry links GitHub repositories (D00-16).")
    view = layer(ctx, repo)
    site = ctx.config.site_name
    if doi in view["papers"]:
        ctx.io.say(f"{repo.full} is linked to {doi} already ({view['source']}).")
        ctx.io.print(ctx.site_url(f"/r/{repo.owner}/{repo.name}/"))
        return 0
    if view["known"]:
        url = ctx.site_url(f"/r/{quote(repo.owner)}/{quote(repo.name)}/settings/?paper={quote(doi, safe='/')}")
        what = f"{site} knows {repo.full}: its settings page opens with {doi} in “Add”."
    else:
        url = ctx.site_url(f"/new/link/?repo={quote(repo.full, safe='/')}&paper={quote(doi, safe='/')}")
        what = f"{repo.full} is not linked in {site} yet: the page that links it opens, with {doi}."
    ctx.io.say(what)
    ctx.io.say("Confirm there, then GitHub asks you to authorize this one action: the registry never writes as you without it, "
               "and GitHub checks that you administer or maintain the repository.")
    if no_browser:
        ctx.io.print(url)
    else:
        ctx.browse(url)
    return 0


PAPER_FIELDS = ["doi", "status", "title", "page"]


def _paper_list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    view = layer(ctx, repo, offline=args.offline)
    entry = view["entry"] or {}
    rows = []
    for p in entry.get("papers") or []:
        if not isinstance(p, dict) or not p.get("doi"):
            continue
        slug = p.get("slug")
        rows.append({"doi": p.get("doi"), "status": p.get("status") or "catalogue", "title": p.get("title") or "",
                     "page": ctx.site_url(f"/paper/{slug}/") if slug else f"https://doi.org/{p.get('doi')}"})

    def human() -> None:
        if not rows:
            ctx.io.say(f"No paper is linked to {repo.full} ({view['source']}). `oscr paper link <DOI>` links one.")
            return
        ctx.io.table([(r["doi"], r["status"], shown(r["title"]), r["page"]) for r in rows], headers=("doi", "status", "title", "page"))
        ctx.io.say(f"From {view['source']}.")

    emit(ctx.io, args, rows, human)
    return 0


# ── oscr trace ──

MAP_FIELDS = ["paper", "title", "doi", "commit", "validated", "mapDoi", "pairs"]


def _trace_list(ctx: Any, args: argparse.Namespace) -> int:
    repo = ctx.repo()
    maps = maps_of(ctx, repo)

    def human() -> None:
        if not maps:
            ctx.io.say(f"No tracing map points to {repo.full} in the registry yet.")
            return
        for m in maps:
            state = "validated" + (f", map DOI {m.get('mapDoi')}" if m.get("mapDoi") else "") if m.get("validated") else "proposed"
            ctx.io.print(f"{ctx.io.style(shown(m.get('doi')), 'bold')}  {shown(m.get('title'))}")
            ctx.io.print(f"  pinned at {str(m.get('commit'))[:12]} — {state}; {len(m.get('pairs') or [])} links")
            for p in m.get("pairs") or []:
                ctx.io.print(f"    {shown(p.get('path'))}:{p.get('start')}–{p.get('end')}  ↔  {shown(p.get('section'))} ¶{p.get('paragraph')}")

    emit(ctx.io, args, maps, human)
    return 0


CHECKED_FIELDS = ["doi", "commit", "at", "pairs", "failures"]


def _trace_check(ctx: Any, args: argparse.Namespace) -> int:
    top = _top(ctx)
    at = ctx.git.head(top, args.commit or "HEAD")
    if args.file:
        try:
            data = json.loads(Path(args.file).read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise UsageError(f"{args.file} is not a map file ({e}).") from e
        maps = [{"doi": (data.get("paper") or {}).get("doi", ""), "title": (data.get("paper") or {}).get("title", ""), "commit": data.get("commit", ""), "pairs": data.get("pairs") or []}]
    else:
        repo = ctx.repo()
        maps = maps_of(ctx, repo)
        if args.paper:
            doi = normal_doi(args.paper)
            maps = [m for m in maps if str(m.get("doi", "")).lower() == doi]
        if not maps:
            ctx.io.say(f"No tracing map of {repo.full} in the registry{' for this paper' if args.paper else ''}: nothing to check.")
            return 0
    results = []
    for m in maps:
        commit = str(m.get("commit", ""))
        if not trace.OBJECT_ID.match(commit):
            raise UsageError("A map's commit is a full commit id.")
        pairs = [trace.check_pair(ctx.git, top, commit, at, p) for p in m.get("pairs") or []]
        results.append({"doi": m.get("doi"), "title": m.get("title", ""), "commit": commit, "at": at, "pairs": pairs,
                        "failures": sum(1 for p in pairs if trace.LEVEL_OF[p["how"]] == "failure")})

    def human() -> None:
        for r in results:
            ctx.io.print(f"{ctx.io.style(shown(r['doi']), 'bold')}  {shown(r['title'])}")
            ctx.io.print(f"  the map is pinned at {r['commit'][:12]}; checked at {at[:12]}")
            for p in r["pairs"]:
                level = trace.LEVEL_OF[p["how"]]
                word = {"ok": "same", "notice": "found", "warning": "changed", "failure": "broken"}[level]
                ctx.io.print(f"  {ctx.io.style(word.ljust(7), level)} {shown(p['path'])}:{p['start']}–{p['end']}  {shown(p['words'])}")
        total = sum(r["failures"] for r in results)
        ctx.io.say("A map stays valid at its pinned commit; a change only asks its authors for a new version. "
                   + (f"{total} link{'s' if total != 1 else ''} cannot be found at this commit." if total else "Every link is found at this commit."))

    emit(ctx.io, args, results, human)
    if any(r["failures"] for r in results):
        raise CheckFailed("Some of the map's lines are gone at this commit (see above).")
    return 0


def _location(ctx: Any, top: Path, text: str, default_commit: str) -> dict[str, Any]:
    """LOCATION[=PARAGRAPH]: a permalink, PATH:START-END or PATH#LSTART-LEND."""
    paragraph = None
    body = text
    m = re.match(r"^(.*)=(\d{1,5})$", text)
    if m:
        body, paragraph = m.group(1), int(m.group(2))
    point = trace.parse_permalink(body, web=ctx.config.github_web, sites=(ctx.config.base_url(),))
    if point:
        if not point.lines:
            raise UsageError(f"{clean_line(body)} names no lines: select them on the page (the #L10-L24 part).")
        return {"path": point.path, "start": point.lines[0], "end": point.lines[1], "commit": point.commit, "paragraph": paragraph, "repo": f"{point.owner}/{point.name}"}
    m = re.match(r"^([^:#\s]+)(?::(\d{1,7})(?:-(\d{1,7}))?|#L(\d{1,7})(?:-L(\d{1,7}))?)$", body)
    if not m:
        raise UsageError(f"“{clean_line(text)}” is not a place: write PATH:10-24, PATH#L10-L24 or a permalink, then =PARAGRAPH if you like.")
    path = m.group(1)
    if path.startswith("/") or any(s in ("", ".", "..") for s in path.split("/")):
        raise UsageError(f"{clean_line(path)} is not a path inside the repository.")
    a = int(m.group(2) or m.group(4))
    b = int(m.group(3) or m.group(5) or a)
    if a < 1 or b < 1:
        raise UsageError("Lines start at 1.")
    return {"path": path, "start": min(a, b), "end": max(a, b), "commit": default_commit, "paragraph": paragraph, "repo": None}


def _trace_propose(ctx: Any, args: argparse.Namespace) -> int:
    top = _top(ctx)
    doi = normal_doi(args.doi)
    repo = ctx.repo(required=False)
    commit = ctx.git.head(top, args.commit or "HEAD")
    pairs = []
    for n, loc in enumerate(args.locations, 1):
        p = _location(ctx, top, loc, commit)
        if p["commit"] != commit:
            raise UsageError(f"Every link of a map is at one commit: {clean_line(loc)} is at {p['commit'][:12]}, the map at {commit[:12]} (--commit).")
        if repo and p["repo"] and p["repo"].lower() != repo.full.lower():
            raise UsageError(f"{clean_line(loc)} is in {p['repo']}, not in {repo.full}.")
        text = ctx.git.read_text(top, commit, p["path"], max_bytes=4 * 2**20)
        if text is None:
            raise UsageError(f"{clean_line(p['path'])} is not in commit {commit[:12]}.")
        lines = trace.split_lines(text)
        if p["end"] > len(lines):
            raise UsageError(f"{clean_line(p['path'])} has {len(lines)} lines at {commit[:12]}: {p['start']}–{p['end']} is past its end.")
        pair = {"pair": n, "path": p["path"], "start": p["start"], "end": p["end"], "section": args.section or "", "paragraph": p["paragraph"],
                "symbol": trace.symbol_of(lines[p["start"] - 1:p["end"]])}
        if repo:
            pair["permalink"] = f"{ctx.config.github_web}/{repo.owner}/{repo.name}/blob/{commit}/{quote(p['path'])}#L{p['start']}-L{p['end']}"
            pair["registry"] = ctx.site_url(f"/r/{repo.owner}/{repo.name}/blob/{commit}/{quote(p['path'])}#L{p['start']}-L{p['end']}")
        pairs.append(pair)
    pushed = ctx.git.run(["branch", "-r", "--contains", commit], cwd=top, check=False).stdout.strip()
    proposal = {
        "about": "A tracing map proposed from the command line (oscr trace propose): lines of the code at one commit, and the "
                 "paper's paragraphs they carry out. The registry's own maps are made and validated on its site.",
        "paper": {"doi": doi},
        "repository": repo.full if repo else None,
        "commit": commit,
        "method": "proposed-cli",
        "validated": False,
        "pairs": pairs,
        "made_with": f"oscr-cli {__version__}",
    }
    text = json.dumps(proposal, indent=2, ensure_ascii=False) + "\n"
    target: Path | None = Path(args.output) if args.output else (top / ".oscr" / "maps" / f"{re.sub(r'[^a-z0-9._-]', '_', doi)}.json" if args.write else None)
    if target:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        ctx.io.say(f"Written: {target}")
    else:
        ctx.io.write(text)
    if not pushed:
        ctx.io.warn(f"Commit {commit[:12]} is on no remote branch: push it first, so that readers can open the lines a map points to.")
    ctx.io.say(f"{ctx.config.site_name} does not receive proposed maps from the command line yet (D14-8): keep this file with your code, "
               "or cite its links in a research issue on the paper; `oscr trace check --file` checks it at any commit.")
    return 0


# ── oscr cite ──

CITE_FIELDS = ["apa", "bibtex", "source", "preferred", "doi", "swhid", "work", "software"]


def doi_in_notes(text: str) -> str | None:
    """The DOI a release's notes name: a Zenodo deposit's first (its badge), else the first DOI, without
    the brackets and punctuation around it."""
    for pattern in (r"10\.5281/zenodo\.\d+", r'10\.\d{4,9}/[^\s"<>()\[\]]+'):
        m = re.search(pattern, text, re.I | re.A)
        if m:
            return re.sub(r"[.,;:]+$", "", m.group(0)).lower()
    return None


def _citation_texts(ctx: Any, args: argparse.Namespace, top: Path | None) -> dict[str, str | None]:
    """CITATION.cff and codemeta.json: a file named, at a commit, or in the working tree (else HEAD)."""
    if args.file:
        f = Path(args.file)
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            raise UsageError(f"{args.file} cannot be read ({e.strerror}).") from e
        return {"codemeta.json" if f.suffix == ".json" else "CITATION.cff": text}
    out: dict[str, str | None] = {}
    for name in ("CITATION.cff", "codemeta.json"):
        if top is None:
            p = ctx.cwd / name
            out[name] = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else None
        elif args.rev:
            out[name] = ctx.git.read_text(top, args.rev, name)
        else:
            p = top / name
            out[name] = p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ctx.git.read_text(top, "HEAD", name)
    return out


def _cite(ctx: Any, args: argparse.Namespace) -> int:
    top = ctx.git.toplevel(ctx.cwd)
    text_of = _citation_texts(ctx, args, top)
    cit = citation.citation_of_cff(text_of.get("CITATION.cff") or "") if text_of.get("CITATION.cff") else None
    if cit is None and text_of.get("codemeta.json"):
        cit = citation.citation_of_codemeta(text_of["codemeta.json"] or "")
    if cit is None:
        raise CliError("No usable CITATION.cff or codemeta.json here (a title and at least one author).",
                       hint="The registry's editor writes a CITATION.cff from the paper (the repository's page, Add a file); `oscr check` says what is missing.")
    work = cit.software if args.software else cit.work
    swhid = None
    commit = None
    if top is not None:
        commit = ctx.git.head(top, args.rev or "HEAD")
    if args.release:
        repo = ctx.repo()
        from .. import github

        rel = github.call(ctx, "GET", f"/repos/{repo.owner}/{repo.name}/releases/tags/{quote(args.release, safe='')}", anonymous_ok=True).body or {}
        found = doi_in_notes(str(rel.get("body") or ""))
        work = cit.software
        work.version = args.release.lstrip("v") if re.match(r"^v\d", args.release) else args.release
        if found:
            work.doi = found
        else:
            ctx.io.warn(f"The release {clean_line(args.release)} names no DOI (a Zenodo deposit's badge, for example): the software's own is used.")
    if args.doi:
        work = cit.software if not args.release else work
        work.doi = normal_doi(args.doi)
    if args.swhid:
        if commit is None:
            raise UsageError("--swhid reads the commit of a clone: run it inside one.")
        tree = ctx.git.run(["rev-parse", f"{commit}^{{tree}}"], cwd=top).stdout.strip()
        repo = ctx.repo(required=False)
        origin = f";origin={ctx.config.github_web}/{repo.owner}/{repo.name}" if repo else ""
        swhid = {"revision": f"swh:1:rev:{commit}{origin}", "directory": f"swh:1:dir:{tree}{origin}"}
    data = {
        "apa": citation.apa(work),
        "bibtex": citation.bibtex(work),
        "source": cit.source,
        "preferred": cit.preferred and not args.software and not args.release,
        "doi": work.doi,
        "swhid": swhid,
        "work": asdict(work),
        "software": asdict(cit.software),
    }

    def human() -> None:
        fmt = args.format
        if fmt in ("apa", "all"):
            ctx.io.print(clean(data["apa"]))
        if fmt == "all":
            ctx.io.print("")
        if fmt in ("bibtex", "all"):
            ctx.io.print(clean(data["bibtex"]))
        if swhid:
            ctx.io.print("")
            ctx.io.print(f"Software Heritage identifiers of commit {commit[:12] if commit else ''}:")
            ctx.io.print(f"  {swhid['revision']}")
            ctx.io.print(f"  {swhid['directory']}")
            ctx.io.say("They resolve once Software Heritage has archived this commit (the repository's page asks it, on request).")
        if data["preferred"] and fmt != "bibtex":
            ctx.io.say(f"This cites the paper, as {cit.source} prefers; --software cites the code itself.")

    emit(ctx.io, args, data, human)
    return 0


# ── oscr check ──

CHECK_FIELDS = ["conclusion", "title", "summary", "findings", "annotations", "commit", "papers_from"]
_STATUS = {"A": "added", "M": "modified", "D": "removed", "R": "renamed", "C": "copied", "T": "changed"}


def _check(ctx: Any, args: argparse.Namespace) -> int:
    top = _top(ctx)
    rev = ctx.git.head(top, args.rev or "HEAD")
    listing = ctx.git.tree(top, rev)
    entries = [{"path": p, "type": t, "size": s} for p, t, s in listing]
    paths = [p for p, t, _ in listing if t == "blob"]
    texts: dict[str, str | None] = {}
    for p in checks.check_files(paths).values():
        if p:
            texts[p] = ctx.git.read_text(top, rev, p, max_bytes=checks.CHECK_TEXT_BYTES)
    papers: list[str] = []
    traced: list[dict[str, str]] = []
    source = "not asked (--offline)"
    repo = ctx.repo(required=False)
    if repo and not args.offline:
        view = layer(ctx, repo)
        papers, source = view["papers"], view["source"]
        for m in maps_of(ctx, repo):
            for p in m.get("pairs") or []:
                traced.append({"path": str(p.get("path")), "paper": str(m.get("doi")), "commit": str(m.get("commit"))})
    elif not repo:
        source = "no GitHub remote: the registry was not asked"
    change = None
    if args.base:
        base = ctx.git.head(top, args.base)
        out = ctx.git.run(["diff", "--name-status", "-M", "-z", base, rev], cwd=top).stdout.split("\0")
        files = []
        i = 0
        while i < len(out) and out[i]:
            code = out[i][0]
            if code in ("R", "C"):
                files.append({"path": out[i + 2], "previousPath": out[i + 1], "status": _STATUS[code]})
                i += 3
            else:
                files.append({"path": out[i + 1], "previousPath": None, "status": _STATUS.get(code, "changed")})
                i += 2
        change = {"files": files[:checks_pr_files()], "truncated": len(files) > checks_pr_files()}
    report = checks.run_checks({"entries": entries, "truncated": False, "texts": texts, "papers": papers, "traced": traced, "change": change})
    data = {**report.as_json(), "commit": rev, "papers_from": source}
    dirty = ctx.git.run(["status", "--porcelain", "--untracked-files=no"], cwd=top, check=False).stdout.strip()

    def human() -> None:
        style = {"failure": "failure", "neutral": "warning", "success": "ok"}[report.conclusion]
        ctx.io.print(ctx.io.style(report.title, style))
        for f in report.findings:
            word = checks.LEVEL_WORDS[f.level]
            ctx.io.print(f"  {ctx.io.style(word.ljust(10), f.level if f.level != 'notice' else 'muted')} {checks.CHECK_WORDS[f.id]}: {shown(f.words)}")
            if f.fix:
                ctx.io.print(f"  {' ' * 10} {shown(f.fix)}")
        ctx.io.say(f"Read as text at {rev[:12]}{' (against ' + args.base + ')' if args.base else ''}; nothing was run. The papers and maps: {source}."
                   + (" Uncommitted changes are not checked: commit them first." if dirty else ""))

    emit(ctx.io, args, data, human)
    if report.conclusion == "failure":
        raise CheckFailed(report.title)
    return 0


def checks_pr_files() -> int:
    """The files of a change the checks read (the Worker's PR_FILES_CHECKED)."""
    return 300


# ── the tree ──


def register(sub: Any) -> None:
    _, ps = group(sub, "paper", help="the papers a repository carries out: link one, list them",
                  examples_=["oscr paper link 10.5555/oscr.fixture.1", "oscr paper list"])
    p = command(ps, "link", help="attach this repository to a paper (the site's page, then GitHub's authorization)", handler=_paper_link, repo=True,
                examples_=["oscr paper link 10.5555/oscr.fixture.1", "oscr paper link https://doi.org/10.1234/abcd -R lab/eeg --no-browser"])
    p.add_argument("doi", metavar="DOI")
    p.add_argument("--no-browser", action="store_true", help="print the page's address instead of opening it")
    p = command(ps, "list", help="the papers the registry links to this repository", handler=_paper_list, repo=True,
                examples_=["oscr paper list", "oscr paper list --json doi,status"])
    p.add_argument("--offline", action="store_true", help=argparse.SUPPRESS)
    add_format_flags(p, PAPER_FIELDS)

    _, ts = group(sub, "trace", help="tracing maps: the registry's, checked at a commit; a map proposed from selected lines",
                  examples_=["oscr trace list", "oscr trace check", "oscr trace propose 10.5555/oscr.fixture.1 analysis.py:6-10=3 --section Methods"])
    p = command(ts, "list", help="the maps the registry holds for this repository", handler=_trace_list, repo=True, examples_=["oscr trace list --json doi,commit"])
    add_format_flags(p, MAP_FIELDS)
    p = command(ts, "check", help="find each map's lines at a commit of this clone (same, moved, changed, gone)", handler=_trace_check, repo=True,
                examples_=["oscr trace check", "oscr trace check --commit v2.0 --paper 10.5555/oscr.fixture.1", "oscr trace check --file .oscr/maps/10.5555_oscr.fixture.1.json"])
    p.add_argument("--commit", default=None, help="the commit to check at (default HEAD)")
    p.add_argument("--paper", default=None, metavar="DOI", help="only this paper's map")
    p.add_argument("--file", default=None, help="a proposed map's file (oscr trace propose) instead of the registry's")
    add_format_flags(p, CHECKED_FIELDS)
    p = command(ts, "propose", help="a map from lines selected at a commit: PATH:10-24, PATH#L10-L24 or a permalink, =PARAGRAPH", handler=_trace_propose, repo=True,
                examples_=["oscr trace propose 10.5555/oscr.fixture.1 analysis/preprocess.py:3-4=2 --section 'Methods › Filtering'",
                           "oscr trace propose 10.1234/abcd 'https://github.com/lab/eeg/blob/<sha>/a.py#L6-L10=3' --write"])
    p.add_argument("doi", metavar="DOI")
    p.add_argument("locations", nargs="+", metavar="LOCATION[=PARAGRAPH]")
    p.add_argument("--commit", default=None, help="the commit of the lines (default HEAD)")
    p.add_argument("--section", default="", help="the paper's section heading the paragraphs are in")
    p.add_argument("--write", action="store_true", help="write .oscr/maps/<doi>.json in the clone")
    p.add_argument("--output", default=None, help="write the map to this file")

    p = command(sub, "cite", help="a citation of this repository from CITATION.cff (or codemeta.json): APA, BibTeX, a release's DOI, a SWHID", handler=_cite, repo=True,
                examples_=["oscr cite", "oscr cite --format bibtex > refs.bib", "oscr cite --release v1.2.0", "oscr cite --software --swhid", "oscr cite --json apa,doi"])
    p.add_argument("--format", choices=("apa", "bibtex", "all"), default="all", help="the citation's format (default: both)")
    p.add_argument("--software", action="store_true", help="cite the software itself, not the paper the file prefers")
    p.add_argument("--rev", default=None, help="read the files at this commit (default: the working tree)")
    p.add_argument("--file", default=None, help="a CITATION.cff or codemeta.json elsewhere")
    p.add_argument("--doi", default=None, help="the software's DOI to cite (a release's deposit)")
    p.add_argument("--release", default=None, metavar="TAG", help="cite this release: its version, and the DOI its notes name")
    p.add_argument("--swhid", action="store_true", help="add the commit's Software Heritage identifiers")
    add_format_flags(p, CITE_FIELDS)

    p = command(sub, "check", help="the registry's checks on this clone: licence, environment, DOI, CITATION.cff, maps, sizes, README", handler=_check, repo=True,
                examples_=["oscr check", "oscr check --base main", "oscr check --rev v1.0 --json conclusion,findings", "oscr check --offline"])
    p.add_argument("--rev", default=None, help="the commit to check (default HEAD)")
    p.add_argument("--base", default=None, help="check the change from this commit, as the registry checks a pull request")
    p.add_argument("--offline", action="store_true", help="ask the registry nothing (no papers, no maps)")
    add_format_flags(p, CHECK_FIELDS)

