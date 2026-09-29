"""The public catalogue: the library made readable, and nothing that must stay private.

What `generate` writes into its folder (the nightly job uses `data/public/`), in public
mode:

- `catalog.json`: every paper, its status and its authors' code with the level of
  evidence (found → alive → inventoried → imported), the method families, the
  repositories — the website is built from it;
- `scripts/NN.json`: the TEXT of the scripts, repository by repository, in lots loaded
  on demand by the reader; for a repository whose license does not allow copying it, only
  facts (each file's digest and size, and where a reader's browser fetches it at the pinned
  version: "shown from the source", `source_of`);
- `alignments/NN.json`: the paper ↔ code matches of each paper, for the reader;
- in public mode, `entities/`, `lookup/` (oscr/entities.py) and `papers/NN.json`, the
  sections of each paper's page (oscr/paperpage.py);
- `articles.csv`, `repositories.csv`, `scripts.jsonl`, `alignments.jsonl`: the tables a
  Hugging Face dataset viewer displays and queries;
- `oscr_public.db`: the SQLite database without excerpts, for Datasette or a service.

**What never leaves.** No excerpt of a paper's text (the `excerpt` column stays in the
private database), and in public mode no text of a script whose license does not allow
republishing it: the reader lists those files and links each one at the source, at the
verified commit. Development tests (test validations, sandbox DOIs) never leave either.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import sqlite3
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from . import methods

#: Script texts and matches are served in LOTS, loaded on demand: the pages stay light,
#: and a static host serves them as they are.
#: Lots of the scripts' text and of the matches: a Workers static asset may not exceed
#: 25 MiB. 32 lots reached 30 MiB with 4,226 papers (2026-09-27); 128 reached 25.5 MiB on
#: 2026-09-29, so 256, and a text budget per lot (below) that holds whatever the stock.
N_LOTS: int = 256
#: At most this much text per repository on the site: beyond it, files are listed with a
#: link to the source. One toolbox (1,714 files, 23.6 MB of text) filled a lot by itself.
#: The Hugging Face copy of the scripts keeps everything.
MAX_SITE_TEXT_PER_REPO: int = 8_000_000
#: At most this much text in one lot of the site: past it, the lot's further files are listed
#: with a link to the source, like a repository past its own budget. Characters, not bytes: 16
#: million keep a lot under the 25 MiB limit with JSON's overhead and multi-byte characters.
MAX_SITE_TEXT_PER_LOT: int = 16_000_000

#: The licenses under which a script's text is republished. Without a license, code is
#: "all rights reserved": it is shown at the source, not here.
PUBLISHABLE: frozenset[str] = frozenset({"yes", "with_conditions"})

NOTE_LICENSE = "This repository's license does not allow republishing its text: read it at the source."
NOTE_NO_LICENSE = "This repository has no license: its authors keep all rights. Read it at the source."
NOTE_WITHHELD = "Withheld from this site at a removal request: read it at the source."

#: "Shown from the source" (decided 2026-09-29, docs/SCRIPT_STORAGE.md): a file whose license does
#: not allow copying it is never copied, but a reader's browser may fetch it ITSELF from where its
#: authors published it, at the pinned version (a commit, a Zenodo record), check its SHA-256
#: against `file.digest` (the Mac's digest of the same bytes) and show it. Only facts leave the Mac:
#: the path, language, size, lines, digest, the pinned version, and where the browser fetches it.
#: A file past this size is not fetched.
SOURCE_MAX_BYTES: int = 1_000_000
#: Where a reader's browser fetches such a file: each answers a page of another site (CORS) with one
#: file at an immutable version. `{path}` is the file's path with its slashes kept, `{file}` the path
#: with its slashes encoded, `{sha256}` its digest; each part is percent-encoded by the reader. The
#: site's Content-Security-Policy allows these origins only (website/src/lib/source.ts, SOURCE_ORIGINS).
SOURCE_TEMPLATES: dict[str, str] = {
    "github": "https://raw.githubusercontent.com/{owner}/{name}/{commit}/{path}",
    "gitlab": "https://gitlab.com/api/v4/projects/{project}/repository/files/{file}/raw?ref={commit}",
    "bitbucket": "https://bitbucket.org/{owner}/{name}/raw/{commit}/{path}",
    "codeberg": "https://codeberg.org/api/v1/repos/{owner}/{name}/raw/{path}?ref={commit}",
    "huggingface": "https://huggingface.co/{hf}/raw/{commit}/{path}",
    "zenodo": "https://zenodo.org/api/records/{record}/files/{file}/content",
    # Software Heritage keeps every file it archived under its SHA-256: the same bytes, whatever the
    # forge (a GitLab of its own, Framagit, a file inside a Zenodo archive), and a version that
    # cannot change.
    "swh": "https://archive.softwareheritage.org/api/1/content/sha256:{sha256}/raw/",
}
_COMMIT = re.compile(r"[0-9a-f]{40}")
_SEGMENT = re.compile(r"[A-Za-z0-9._-]{1,100}")


def _hf_repo(url: str, key: str) -> str:
    """The Hugging Face repository in its address, its case kept ('Owner/name', 'spaces/Owner/name',
    'datasets/Owner/name'): the site answers the lowercased key with a redirect."""
    parts = [p for p in urlsplit(url).path.split("/") if p]
    n = 3 if parts and parts[0] in ("spaces", "datasets") else 2
    repo = "/".join(parts[:n]) if len(parts) >= n else ""
    ok = repo and all(_SEGMENT.fullmatch(p) for p in parts[:n]) and f"huggingface.co/{repo}".lower() == key.lower()
    return repo if ok else ""


def source_of(d: sqlite3.Row | dict) -> dict[str, str]:
    """Where a reader's browser fetches the files of a repository whose license does not allow
    copying them: {"via", "url" (a template), "at" (the pinned version)}, or {"via": "", "why"} when
    it cannot (the site then links to the source). Files outside the via's reach (a file inside a
    Zenodo archive) are fetched from Software Heritage by their digest (`file_via`)."""
    repo, host, kind = d["repo"], d["host"], d["kind"]
    commit = (d["commit_id"] or "").lower()
    parts = repo.split("/")
    if d["state"] == "dead":
        return {"via": "", "why": "dead"}
    if kind == "forge":
        if not _COMMIT.fullmatch(commit):
            return {"via": "", "why": "no_commit"}
        owner_name = len(parts) == 3 and all(_SEGMENT.fullmatch(p) for p in parts[1:])
        fill = {"owner": quote(parts[1], safe="") if owner_name else "", "name": quote(parts[-1], safe="") if owner_name else "",
                "commit": commit}
        if host == "github.com" and owner_name:
            return {"via": "github", "url": SOURCE_TEMPLATES["github"].format(**fill, path="{path}"), "at": commit}
        if host == "gitlab.com" and len(parts) >= 3 and all(_SEGMENT.fullmatch(p) for p in parts[1:]):
            project = quote("/".join(parts[1:]), safe="")
            return {"via": "gitlab", "url": SOURCE_TEMPLATES["gitlab"].format(project=project, commit=commit, file="{file}"),
                    "at": commit}
        if host == "bitbucket.org" and owner_name:
            return {"via": "bitbucket", "url": SOURCE_TEMPLATES["bitbucket"].format(**fill, path="{path}"), "at": commit}
        if host == "codeberg.org" and owner_name:
            return {"via": "codeberg", "url": SOURCE_TEMPLATES["codeberg"].format(**fill, path="{path}"), "at": commit}
        if host == "huggingface.co":
            hf = _hf_repo(d["url"] or "", repo)
            if hf:
                return {"via": "huggingface", "url": SOURCE_TEMPLATES["huggingface"].format(hf=hf, commit=commit, path="{path}"),
                        "at": commit}
        # Another forge (a GitLab of its own, Framagit, GIN…): its pages do not all let another site
        # read them; Software Heritage does, by digest.
        return {"via": "swh", "url": SOURCE_TEMPLATES["swh"], "at": commit}
    if repo.startswith("zenodo:") and repo.split(":", 1)[1].isdigit():
        record = repo.split(":", 1)[1]
        return {"via": "zenodo", "url": SOURCE_TEMPLATES["zenodo"].format(record=record, file="{file}"), "at": record}
    if repo.startswith("osf:"):
        return {"via": "", "why": "osf"}
    if repo.startswith("supp:"):
        return {"via": "", "why": "pmc"}
    return {"via": "", "why": "host"}


def file_via(source: dict[str, str], path: str, listed: set[str]) -> str:
    """"" when a file is fetched the repository's way; "swh" when only Software Heritage can give it
    (a file inside an archive of a Zenodo record, which lists the archive, not the file)."""
    if source.get("via") == "zenodo" and path not in listed:
        return "swh"
    return ""

_CODE_STATUSES = ("code_verified", "code_found", "code_empty", "code_dead")


@dataclass(frozen=True)
class Withheld:
    """What accepted removal requests withhold from the public outputs while the records stay
    (oscr/migrations/0008_withheld.sql, `oscr reports accept`): the repositories whose copies leave,
    single files, and the papers whose tracing map leaves."""
    repos: frozenset[str] = frozenset()
    files: frozenset[tuple[str, str]] = frozenset()
    maps: frozenset[str] = frozenset()

    def text_withheld(self, repo: str, path: str) -> bool:
        return repo in self.repos or (repo, path) in self.files


def withheld(con: sqlite3.Connection) -> Withheld:
    """The copies and maps withheld: 'scripts' names every code repository of its paper (those linked
    later included), 'repository' one repository, 'file' one file, 'map' a paper's tracing map."""
    try:
        rows = con.execute("SELECT scope, article_id, repo, path FROM withheld").fetchall()
    except sqlite3.OperationalError:          # a database before migration 8
        return Withheld()
    repos = {r[2] for r in rows if r[0] == "repository"}
    papers = [r[1] for r in rows if r[0] == "scripts"]
    if papers:
        marks = ",".join("?" * len(papers))
        repos |= {r[0] for r in con.execute(f"SELECT DISTINCT repo FROM link WHERE role = 'code' AND article_id IN ({marks})",
                                             papers)}
    return Withheld(repos=frozenset(repos), files=frozenset((r[2], r[3]) for r in rows if r[0] == "file"),
                    maps=frozenset(r[1] for r in rows if r[0] == "map"))


def lot_of(key: str) -> int:
    return int(hashlib.sha1(key.encode()).hexdigest()[:8], 16) % N_LOTS


def slug(article_id: str) -> str:
    """The same folder name as the library (library.slug), and the website's URL."""
    return re.sub(r"[^a-z0-9._-]+", "_", article_id.lower()).strip("_")[:120]


def file_url(d: sqlite3.Row | dict, path: str) -> str:
    """The file at the source, at the verified commit when the forge allows it."""
    repo, url = d["repo"], d["url"]
    commit = (d["commit_id"] or "HEAD") if "commit_id" in d.keys() else "HEAD"
    parts = repo.split("/")
    p = quote(path)
    if repo.startswith("github.com/") and len(parts) >= 3:
        return f"https://github.com/{parts[1]}/{parts[2]}/blob/{commit}/{p}"
    if (repo.startswith("gitlab.") or ".gitlab." in parts[0]) and len(parts) >= 3:
        return f"https://{repo}/-/blob/{commit}/{p}"
    if parts[0] in ("codeberg.org", "gin.g-node.org", "framagit.org", "gitee.com") and len(parts) >= 3:
        return f"https://{parts[0]}/{parts[1]}/{parts[2]}/src/commit/{commit}/{p}"
    if parts[0] == "bitbucket.org" and len(parts) >= 3:
        return f"https://bitbucket.org/{parts[1]}/{parts[2]}/src/{commit}/{p}"
    if parts[0] == "huggingface.co":
        return f"https://huggingface.co/{'/'.join(parts[1:])}/blob/{commit}/{p}"
    if repo.startswith("zenodo:"):
        return f"https://zenodo.org/records/{repo.split(':', 1)[1]}"
    if repo.startswith("osf:"):
        return f"https://osf.io/{repo.split(':', 1)[1]}/files"
    if repo.startswith("figshare:"):
        return f"https://figshare.com/articles/{repo.split(':', 1)[1]}"
    if repo.startswith("supp:"):
        pmcid, _, name = repo[5:].partition("/")
        return f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.1/{quote(name)}"
    return url


def _where(found_by: str, section: str) -> str:
    """Where the link was seen, in a reader's words."""
    location = found_by.split(":", 1)[-1] if found_by.startswith("text:") else found_by
    s = f"“{section[:48]}”" if section else ""
    return {
        "availability": s or "the availability statement",
        "body": f"the text, {s}" if s else "the text",
        "references": "the references",
        "table": "the resources table",
        "supplementary": "the supplementary material",
        "notes": "the notes",
        "appendix": "the appendix",
        "acknowledgements": "the acknowledgements",
        "back": s or "the end of the paper",
        "crossref:reference": "the references deposited at Crossref",
        "zenodo:source": "the Zenodo archive record",
        "dryad:software": "the Zenodo software companion of the Dryad dataset",
        "github:readme": "a GitHub README citing the paper",
    }.get(location, "DataCite" if location.startswith("datacite") else
          "Crossref" if location.startswith("crossref") else location)


#: The article types whose code rate is meaningful: primary research. Reviews, conference
#: abstracts, case reports, corrections and editorials are counted apart (measured on
#: 2026-09-26: 17.4% of research articles have the authors' code, 0.9% of reviews, 0% of
#: the 262 conference abstracts).
RESEARCH_TYPES: tuple[str, ...] = ("research-article", "brief-report", "methods-article", "data-paper",
                                   "rapid-communication", "short-report")
#: A paper the classification judged off-topic stays on the Mac: out of the site and out
#: of the statistics (owner's decision D7). Unclassified papers ('') count. So does a record
#: withdrawn at someone's request, once the owner accepted it (Phase 6, `oscr reports`).
IN_SCOPE = "scanned_at IS NOT NULL AND on_topic != 'no' AND withdrawn = ''"
#: The links, repositories and matches that may leave: those of papers in scope. A
#: repository cited only by off-topic papers stays on the Mac with them (D7).
IN_SCOPE_IDS = f"SELECT id FROM article WHERE {IN_SCOPE}"
PUBLIC_REPOS = f"SELECT DISTINCT repo FROM link WHERE article_id IN ({IN_SCOPE_IDS})"
#: Licenses under which a paper's availability statements may be shown in full (owner's
#: decision D1); under any other, a short summary and a link.
OPEN_ARTICLE_LICENSES: tuple[str, ...] = ("cc by", "cc-by", "cc0", "cc by-sa", "cc-by-sa", "cc by-nc", "cc-by-nc")


def statement_is_publishable(article_license: str) -> bool:
    """D1: CC BY, CC0, CC BY-SA, CC BY-NC (any version); not the -ND variants."""
    lic = (article_license or "").lower().replace("_", "-").strip()
    if "nd" in re.split(r"[\s/.-]+", lic):
        return False
    return any(lic.startswith(o) for o in OPEN_ARTICLE_LICENSES)


def figures(con: sqlite3.Connection) -> dict[str, Any]:
    q = lambda sql, *p: con.execute(sql, p).fetchone()[0]  # noqa: E731
    statuses = {r["status"]: r["n"] for r in con.execute(
        f"SELECT status, COUNT(*) AS n FROM article WHERE {IN_SCOPE} GROUP BY status")}
    code_in_state = ("SELECT DISTINCT l.repo FROM link l JOIN repository r ON r.repo = l.repo "
                     f"WHERE l.role = 'code' AND r.state = ? AND l.article_id IN ({IN_SCOPE_IDS})")
    research = ",".join(f"'{t}'" for t in RESEARCH_TYPES)
    code = ",".join(f"'{s}'" for s in _CODE_STATUSES)
    return {
        "articles": q(f"SELECT COUNT(*) FROM article WHERE {IN_SCOPE}"),
        "fulltext": q(f"SELECT COUNT(*) FROM article WHERE {IN_SCOPE} AND has_fulltext = 1"),
        "research_articles": q(f"SELECT COUNT(*) FROM article WHERE {IN_SCOPE} AND type IN ({research})"),
        "research_with_code": q(f"SELECT COUNT(*) FROM article WHERE {IN_SCOPE} AND type IN ({research}) "
                                f"AND status IN ({code})"),
        "by_type": {r[0] or "unknown": r[1] for r in con.execute(
            f"SELECT type, COUNT(*) FROM article WHERE {IN_SCOPE} GROUP BY type ORDER BY 2 DESC")},
        "with_code": sum(statuses.get(s, 0) for s in _CODE_STATUSES),
        "code_verified": statuses.get("code_verified", 0),
        "on_request": statuses.get("on_request", 0),
        "code_on_request_mentioned": q(f"SELECT COUNT(*) FROM article WHERE {IN_SCOPE} AND code_on_request = 1"),
        "repos_code": q(f"SELECT COUNT(DISTINCT repo) FROM link WHERE role = 'code' AND article_id IN ({IN_SCOPE_IDS})"),
        "repos_code_alive": len(con.execute(code_in_state, ("alive",)).fetchall()),
        "repos_code_dead": len(con.execute(code_in_state, ("dead",)).fetchall()),
        "repos_archived": q("SELECT COUNT(DISTINCT r.repo) FROM repository r JOIN link l ON l.repo = r.repo "
                            f"WHERE l.role = 'code' AND r.swh_archived = 1 AND l.article_id IN ({IN_SCOPE_IDS})"),
        "scripts": q("SELECT COALESCE(SUM(n_scripts), 0) FROM repository WHERE repo IN "
                     f"(SELECT repo FROM link WHERE role = 'code' AND article_id IN ({IN_SCOPE_IDS}))"),
        "scripts_read": q(f"SELECT COUNT(*) FROM file WHERE kind = 'script' AND text IS NOT NULL "
                          f"AND repo IN ({PUBLIC_REPOS})"),
        "alignments": q(f"SELECT COUNT(*) FROM alignment WHERE article_id IN ({IN_SCOPE_IDS})"),
        "aligned_papers": q(f"SELECT COUNT(DISTINCT article_id) FROM alignment WHERE article_id IN ({IN_SCOPE_IDS})"),
        "statuses": statuses,
    }


def catalog_data(con: sqlite3.Connection) -> dict[str, Any]:
    fig = figures(con)
    # How many files of each repository have a text in the database (scripts and docs).
    read = {r["repo"]: r["n"] for r in con.execute(
        "SELECT repo, COUNT(*) AS n FROM file WHERE kind != 'note' GROUP BY repo")}
    levels = {(r["article_id"], r["repo"]): r["level"]
              for r in con.execute("SELECT article_id, repo, level FROM script WHERE origin = 'native'")}
    repos = {r["repo"]: r for r in con.execute("SELECT * FROM repository")}
    links_by_article: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for l in con.execute("SELECT * FROM link"):
        links_by_article[l["article_id"]].append(l)
    aligned = {r["article_id"]: (r["n"], r["method"]) for r in con.execute(
        "SELECT article_id, COUNT(*) AS n, MAX(method) AS method FROM alignment GROUP BY article_id")}

    # Maps validated by an author (ORCID) and their Zenodo DOI: only the real instance,
    # never the sandbox tests (CLAUDE.md).
    validators: dict[str, list[dict[str, str]]] = defaultdict(list)
    for v in con.execute("SELECT article_id, name, orcid FROM validation WHERE proof = 'orcid' "
                         "ORDER BY validated_at"):
        validators[v["article_id"]].append({"name": v["name"], "orcid": v["orcid"]})
    card_dois = {r["article_id"]: {"doi": r["doi"], "concept_doi": r["concept_doi"]}
                 for r in con.execute("SELECT * FROM card_doi WHERE instance = 'zenodo'")}
    # A tracing map withheld at a removal request: neither its validation, nor its DOI, nor its
    # matches (the paper's record stays).
    maps_withheld = withheld(con).maps

    articles = []
    for a in con.execute(f"SELECT * FROM article WHERE {IN_SCOPE} ORDER BY published DESC"):
        code = []
        n_data = 0
        for l in links_by_article.get(a["id"], []):
            if l["role"] == "data":
                n_data += 1
            if l["role"] != "code":
                continue
            d = repos.get(l["repo"])
            code.append({
                "repo": l["repo"], "url": l["url"] if l["url"].startswith("http") else
                (f"https://doi.org/{l['repo'][4:]}" if l["repo"].startswith("doi:") else
                 file_url(d, "") if d is not None and l["repo"].startswith("supp:") else l["url"]),
                "host": l["host"], "level": levels.get((a["id"], l["repo"]), "found"),
                "lot": lot_of(l["repo"]), "files_read": read.get(l["repo"], 0),
                "state": d["state"] if d else "unverified",
                "license": (d["license"] if d else "") or "",
                "redistributable": d["redistributable"] if d else "unknown",
                "scripts": d["n_scripts"] if d else None,
                "languages": json.loads(d["languages"] or "{}") if d else {},
                "type": (d["resource_type"] if d else "") or "",
                "swh": d["swh_archived"] if d else None,
                "inventoried": bool(d and d["n_files"] is not None),
                "commit": (d["commit_id"] if d else "") or "",
                "where": _where(l["found_by"], l["section"]),
            })
        n_pairs, method = aligned.get(a["id"], (0, "")) if a["id"] not in maps_withheld else (0, "")
        articles.append({
            "id": a["id"], "slug": slug(a["id"]), "doi": a["doi"], "pmcid": a["pmcid"],
            "fulltext_id": a["fulltext_id"] or a["pmcid"], "title": a["title"], "journal": a["journal"],
            "published": a["published"], "status": a["status"], "families": json.loads(a["families"]),
            "data_links": n_data, "code": code,
            "card": ({"validated_by": validators.get(a["id"], []), **card_dois.get(a["id"], {})}
                     if (a["id"] in validators or a["id"] in card_dois) and a["id"] not in maps_withheld else None),
            "alignment": ({"lot": lot_of(a["id"]), "pairs": n_pairs, "method": method} if n_pairs else None),
            # Said only when true: the pages then say the map is withheld, not missing.
            **({"map_withheld": True} if a["id"] in maps_withheld else {}),
        })

    families = _families(con, articles)
    repositories = _repositories(con, repos, levels)
    for d in repositories:
        d["lot"] = lot_of(d["repo"])
        d["files_read"] = read.get(d["repo"], 0)
    dates = [a["published"] for a in articles if a["published"]]
    sources = sorted({r["source"].split(":")[0] for r in con.execute(
        "SELECT DISTINCT source FROM article WHERE scanned_at IS NOT NULL")})
    scope = {
        "sources": "Europe PMC, Crossref, DataCite" if "europepmc" in sources else
                   ("local corpus, DataCite" if sources else "—"),
        "from": min(dates) if dates else "", "to": max(dates) if dates else "",
        "queries": "; ".join(_passes(con)),
    }
    return {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scope": scope, "figures": fig, "articles": articles,
            "families": families, "repositories": repositories}


def _passes(con: sqlite3.Connection) -> list[str]:
    """What was scanned, the way a reader would say it, one distinct pass per line:
    "electrophysiology, 2026-09-15 → 2026-09-25"."""
    seen: dict[str, None] = {}
    for r in con.execute("SELECT event, details FROM log WHERE event IN ('scan', 'pass', 'folder') ORDER BY t"):
        d = json.loads(r["details"])
        if r["event"] == "folder":
            seen[f"folder {d.get('path', '')}"] = None
        else:
            seen[f"{d.get('domain', '')}, {d.get('since', '')} → {d.get('until') or 'today'}"] = None
    return list(seen)


def _families(con: sqlite3.Connection, articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    family_of = {name: fam for name, fam, _ in methods.catalog()}
    in_catalog = Counter(family_of.values())
    by_family: dict[str, dict[str, Any]] = {}
    article_methods = {r["id"]: json.loads(r["methods"]) for r in con.execute(
        "SELECT id, methods FROM article WHERE scanned_at IS NOT NULL")}
    for a in articles:
        for fam in a["families"]:
            f = by_family.setdefault(fam, {"family": fam, "articles": 0, "with_code": 0,
                                           "methods": Counter(), "examples": []})
            f["articles"] += 1
            if a["status"] in _CODE_STATUSES:
                f["with_code"] += 1
            for m in article_methods.get(a["id"], []):
                if family_of.get(m) == fam:
                    f["methods"][m] += 1
            if a["status"] == "code_verified":
                for c in a["code"]:
                    if c["state"] == "alive" and c["scripts"]:
                        f["examples"].append((c["scripts"], c["repo"], c["url"]))
    out = []
    for f in sorted(by_family.values(), key=lambda f: -f["articles"]):
        seen, examples = set(), []
        for _, repo, url in sorted(f["examples"], reverse=True):
            if repo not in seen:
                seen.add(repo)
                examples.append({"repo": repo, "url": url})
            if len(examples) == 3:
                break
        out.append({"family": f["family"], "catalog_methods": in_catalog.get(f["family"], 0),
                    "articles": f["articles"], "with_code": f["with_code"],
                    "methods": [[m, n] for m, n in f["methods"].most_common(3)],
                    "examples": examples})
    return out


def _repositories(con: sqlite3.Connection, repos: dict[str, sqlite3.Row],
                  levels: dict[tuple[str, str], str]) -> list[dict[str, Any]]:
    order = ["found", "alive", "inventoried", "imported"]
    count: Counter[str] = Counter()
    best_level: dict[str, str] = {}
    for r in con.execute(f"SELECT article_id, repo FROM link WHERE role = 'code' AND article_id IN ({IN_SCOPE_IDS})"):
        count[r["repo"]] += 1
        level = levels.get((r["article_id"], r["repo"]), "found")
        if order.index(level) >= order.index(best_level.get(r["repo"], "found")):
            best_level[r["repo"]] = level
    out = []
    for repo, n in count.most_common():
        d = repos.get(repo)
        if d is None:
            continue
        out.append({
            "repo": repo, "url": d["url"] if d["url"].startswith("http") else
            (f"https://doi.org/{repo[4:]}" if repo.startswith("doi:") else d["url"]),
            "host": d["host"], "state": d["state"], "license": d["license"] or "",
            "scripts": d["n_scripts"], "languages": json.loads(d["languages"] or "{}"),
            "commit": d["commit_id"] or "", "commit_date": d["commit_date"] or "",
            "swh": d["swh_archived"], "articles": n, "level": best_level.get(repo, "found"),
            "type": d["resource_type"] or "", "inventoried": d["n_files"] is not None,
        })
    return out


#: An email address in a script, as the public site would show it: the owner's rule is that
#: no email address is displayed (they are collected privately, see `oscr/contacts.py`). Not
#: a git remote ("git@github.com:lab/repo.git"), not a decorator ("@property").
_EMAIL_IN_TEXT = re.compile(r"(?<![\w.+%-])(?!git@)[\w.+%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
EMAIL_MASK = "[email hidden]"


def mask_emails(text: str) -> str:
    """The same text, every email address replaced by EMAIL_MASK (lines are kept as they are,
    so the reader's line numbers and the paper ↔ code matches still hold)."""
    return _EMAIL_IN_TEXT.sub(EMAIL_MASK, text) if "@" in text else text


def script_lots(con: sqlite3.Connection, public: bool) -> dict[int, dict[str, Any]]:
    """The scripts' text, repository by repository, split into lots.

    In `public` mode, the text of a repository whose license does not allow
    republishing is REMOVED: the reader shows the file list and a link to each file at
    the source, at the verified commit. For such a repository, the entry says where a reader's
    browser may fetch each file itself (`source`, catalog.source_of) and each file's facts: its
    digest (`sha256`, of its bytes) and size — never its text. What a removal request withheld
    gets neither: it is not fetched.
    """
    lots: dict[int, dict[str, Any]] = defaultdict(dict)
    lot_shown: dict[int, int] = defaultdict(int)
    repos = {r["repo"]: r for r in con.execute("SELECT * FROM repository")}
    # The copies withheld at a removal request leave the public outputs, like an unlicensed text.
    held = withheld(con) if public else Withheld()
    for repo in [r["repo"] for r in con.execute(f"SELECT DISTINCT repo FROM file WHERE repo IN ({PUBLIC_REPOS})")]:
        d = repos.get(repo)
        if d is None:
            continue
        published = (not public) or (d["redistributable"] in PUBLISHABLE and repo not in held.repos)
        withdrawn_note = NOTE_WITHHELD if repo in held.repos else NOTE_NO_LICENSE if not d["license"] else NOTE_LICENSE
        # Shown from the source: a repository held back for its license only (not one withheld).
        source = source_of(d) if not published and repo not in held.repos else None
        try:
            listed = set(json.loads(d["files"] or "[]")) if source and source.get("via") == "zenodo" else set()
        except ValueError:
            listed = set()
        files = []
        shown = 0
        lot = lot_of(repo)
        for f in con.execute("SELECT * FROM file WHERE repo = ? ORDER BY kind DESC, path", (repo,)):
            text, note = (f["text"], f["note"]) if published else (None, withdrawn_note)
            facts: dict[str, Any] = {}
            if (source is not None and f["kind"] != "note" and f["text"] is not None and (repo, f["path"]) not in held.files
                    and re.fullmatch(r"[0-9a-f]{64}", f["digest"] or "")):
                facts = {"sha256": f["digest"], "size": f["size"]}
                via = file_via(source, f["path"], listed) if source.get("via") else ""
                if via:
                    facts["via"] = via
            if published and (repo, f["path"]) in held.files:
                text, note = None, NOTE_WITHHELD
            if not published and (repo, f["path"]) in held.files:
                note = NOTE_WITHHELD
            if public and text:
                shown += len(text)
                if shown > MAX_SITE_TEXT_PER_REPO:
                    text, note = None, "too large a repository to show every file here: read it at the source"
                elif lot_shown[lot] + len(text) > MAX_SITE_TEXT_PER_LOT:
                    text, note = None, "too much text in this part of the site to show every file here: read it at the source"
                else:
                    lot_shown[lot] += len(text)
            if text and "�" in text:
                # The replacement character is already in the ORIGINAL ("S�ren" in
                # legendflex.m): the database keeps it as is, the export says so.
                text = text.replace("�", "?")
                note = (note + "; " if note else "") + 'unreadable character in the original, replaced by "?"'
            if public and text and "@" in text:
                masked = mask_emails(text)
                if masked != text:
                    text = masked
                    note = (note + "; " if note else "") + "email addresses hidden (read the original at the source)"
            files.append({
                "path": f["path"], "language": f["language"], "kind": f["kind"], "lines": f["lines"],
                "text": text, "truncated": bool(f["truncated"]), "note": note,
                "source_url": file_url(d, f["path"]) if f["kind"] != "note" else "", **facts})
        entry = {"repo": repo, "commit": d["commit_id"] or "", "license": d["license"] or "",
                 "published": published, "files": files}
        if source is not None:
            entry["redistributable"] = d["redistributable"]
            entry["source"] = source
        lots[lot][repo] = entry
    return lots


def alignment_lots(con: sqlite3.Connection) -> dict[int, dict[str, Any]]:
    """Each paper's matches, keyed by paper id and split into lots by paper id."""
    lots: dict[int, dict[str, Any]] = defaultdict(dict)
    fulltext = {r["id"]: (r["fulltext_id"] or r["pmcid"]) for r in con.execute(
        "SELECT id, fulltext_id, pmcid FROM article WHERE id IN (SELECT article_id FROM alignment)")}
    maps_withheld = withheld(con).maps
    for r in con.execute(f"SELECT * FROM alignment WHERE article_id IN ({IN_SCOPE_IDS}) ORDER BY article_id, pair"):
        if r["article_id"] in maps_withheld:
            continue            # a tracing map withheld at a removal request: its matches too
        entry = lots[lot_of(r["article_id"])].setdefault(
            r["article_id"], {"method": r["method"], "fulltext_id": fulltext.get(r["article_id"], ""), "pairs": []})
        entry["pairs"].append({
            "pair": r["pair"], "paragraph": r["paragraph"], "section": r["section"], "repo": r["repo"],
            "path": r["path"], "start_line": r["start_line"], "end_line": r["end_line"],
            "symbol": r["symbol"], "score": r["score"], "evidence": json.loads(r["evidence"] or "[]")})
    return lots


def generate(con: sqlite3.Connection, folder: Path, *, public: bool = False, mirror: Path | None = None) -> Path:
    """Write the catalogue, its lots, its tables and the public database — and, when
    asked, the mirror of the republishable scripts. Returns the path of catalog.json."""
    folder.mkdir(parents=True, exist_ok=True)
    d = catalog_data(con)
    d["public"] = public
    for name, lots in (("scripts", script_lots(con, public)), ("alignments", alignment_lots(con))):
        (folder / name).mkdir(parents=True, exist_ok=True)
        for old in (folder / name).glob("*.json"):
            old.unlink()
        for n, content in lots.items():
            (folder / name / f"{n:02d}.json").write_text(json.dumps(content, ensure_ascii=False, separators=(",", ":")))
        if name == "scripts":
            _scripts_jsonl(lots, folder / "scripts.jsonl")
            if mirror is not None:
                _mirror(con, lots, mirror)
        else:
            _alignments_jsonl(con, lots, folder / "alignments.jsonl")
    if public:
        # The website's navigation: entities/, lookup/, and each paper's page and its links;
        # then the sections of each paper's page, papers/NN.json (Phase 4).
        from . import entities, paperpage
        entities.generate(con, folder, d["articles"])
        paperpage.generate(con, folder, d["articles"])
    (folder / "catalog.json").write_text(json.dumps(d, ensure_ascii=False, indent=1))
    _articles_csv(con, folder / "articles.csv")
    _repositories_csv(con, folder / "repositories.csv")
    public_db(con, folder / "oscr_public.db")
    return folder / "catalog.json"


def _articles_csv(con: sqlite3.Connection, path: Path) -> None:
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "doi", "pmid", "pmcid", "title", "journal", "published", "article_license",
                    "status", "code_on_request", "families", "code_repositories", "code_licenses", "scripts"])
        for a in con.execute(f"SELECT * FROM article WHERE {IN_SCOPE} ORDER BY published DESC"):
            code = con.execute("SELECT l.repo, r.license, r.n_scripts FROM link l LEFT JOIN repository r "
                               "ON r.repo = l.repo WHERE l.article_id = ? AND l.role = 'code'", (a["id"],)).fetchall()
            w.writerow([a["id"], a["doi"], a["pmid"], a["pmcid"], a["title"], a["journal"], a["published"],
                        a["license"], a["status"], a["code_on_request"], "; ".join(json.loads(a["families"])),
                        " ".join(c["repo"] for c in code), " ".join(sorted({c["license"] for c in code if c["license"]})),
                        sum(c["n_scripts"] or 0 for c in code)])


def _repositories_csv(con: sqlite3.Connection, path: Path) -> None:
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["repo", "url", "host", "state", "resource_type", "license", "redistributable", "commit",
                    "commit_date", "n_files", "n_scripts", "languages", "swh_archived", "articles"])
        for d in con.execute(
                "SELECT r.*, COUNT(l.article_id) AS n FROM repository r JOIN link l ON l.repo = r.repo "
                f"WHERE l.role = 'code' AND l.article_id IN ({IN_SCOPE_IDS}) GROUP BY r.repo ORDER BY n DESC, r.repo"):
            w.writerow([d["repo"], d["url"], d["host"], d["state"], d["resource_type"], d["license"],
                        d["redistributable"], d["commit_id"], d["commit_date"], d["n_files"], d["n_scripts"],
                        d["languages"], d["swh_archived"], d["n"]])


def _scripts_jsonl(lots: dict[int, dict[str, Any]], path: Path) -> None:
    """One script per line — the format a Hugging Face dataset displays and queries."""
    with path.open("w") as f:
        for content in lots.values():
            for repo in content.values():
                for fi in repo["files"]:
                    if fi["text"] is None:
                        continue
                    f.write(json.dumps({"repo": repo["repo"], "commit": repo["commit"], "license": repo["license"],
                                        "path": fi["path"], "language": fi["language"], "kind": fi["kind"],
                                        "lines": fi["lines"], "source_url": fi["source_url"], "text": fi["text"]},
                                       ensure_ascii=False) + "\n")


def _alignments_jsonl(con: sqlite3.Connection, lots: dict[int, dict[str, Any]], path: Path) -> None:
    """One match per line, with the paper's DOI: paragraph numbers and short evidence
    terms only, never the paper's text."""
    dois = {r["id"]: r["doi"] for r in con.execute("SELECT id, doi FROM article")}
    with path.open("w") as f:
        for content in lots.values():
            for article_id, entry in content.items():
                for p in entry["pairs"]:
                    f.write(json.dumps({"article_id": article_id, "doi": dois.get(article_id, ""),
                                        "method": entry["method"], **p}, ensure_ascii=False) + "\n")


def _mirror(con: sqlite3.Connection, lots: dict[int, dict[str, Any]], root: Path) -> None:
    """Copy the REPUBLISHABLE scripts as files: `root/<repository>/<path>`, with the
    repository's license and a `SOURCE.json` (origin, commit, license).

    That is the shape a public GitHub repository versions: one readable diff per pass,
    and the attribution the licenses require, next to the code.
    """
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    repos = {r["repo"]: r for r in con.execute("SELECT * FROM repository")}
    for content in lots.values():
        for repo, entry in content.items():
            d = repos.get(repo)
            if d is None or d["redistributable"] not in PUBLISHABLE:
                continue
            base = root / slug(repo)
            for fi in entry["files"]:
                if fi["text"] is None or fi["path"] == "…":
                    continue
                # A path comes from a foreign repository or zip: never absolute, never
                # "..", and the target must stay INSIDE the repository's folder.
                relative = Path(fi["path"].lstrip("/\\"))
                if relative.is_absolute() or ".." in relative.parts:
                    continue
                target = base / relative
                if not target.resolve().is_relative_to(base.resolve()):
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(fi["text"])
            if base.exists():
                (base / "SOURCE.json").write_text(json.dumps(
                    {"repo": repo, "url": d["url"], "commit": d["commit_id"], "license": d["license"],
                     "copied_on": time.strftime("%Y-%m-%d", time.gmtime()),
                     "notice": "Copy of the code published by the authors, under its original license. "
                               "The source always prevails."}, ensure_ascii=False, indent=1))


def public_db(con: sqlite3.Connection, path: Path) -> None:
    """A copy of the database without the excerpts of the papers' text, and without the
    text of scripts whose license forbids republishing. The log (dates, requests,
    counts) stays: it quotes no paper."""
    tmp = path.with_suffix(".tmp")
    if tmp.exists():
        tmp.unlink()
    target = sqlite3.connect(tmp)
    con.commit()
    con.backup(target)
    # The copy inherits the working database's WAL mode: back to ONE file, readable as
    # is by sql.js or Datasette Lite.
    target.execute("PRAGMA journal_mode = DELETE")
    target.execute("UPDATE link SET excerpt = ''")
    # Off-topic papers stay on the Mac (D7), with everything attached to them; so do the records
    # withdrawn at someone's request (Phase 6, `oscr reports accept`).
    off = "SELECT id FROM article WHERE on_topic = 'no' OR withdrawn != ''"
    for (table,) in target.execute("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS "
                                   "(SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'article_id')").fetchall():
        target.execute(f"DELETE FROM {table} WHERE article_id IN ({off})")
    target.execute(f"DELETE FROM field_provenance WHERE entity = 'article' AND entity_id IN ({off})")
    target.execute(f"DELETE FROM log WHERE json_valid(details) AND json_extract(details, '$.article') IN ({off})")
    target.execute(f"DELETE FROM article WHERE id IN ({off})")
    # What accepted removal requests withhold while the record stays (0008): the copies of a
    # paper's scripts, of a repository or of a file (their text, as an unlicensed one), and a
    # paper's tracing map (its matches, its validations, its DOI). The table itself stays on the Mac.
    held = withheld(target)
    target.executemany("UPDATE file SET text = NULL, note = ? WHERE repo = ?", [(NOTE_WITHHELD, r) for r in held.repos])
    target.executemany("UPDATE file SET text = NULL, note = ? WHERE repo = ? AND path = ?",
                       [(NOTE_WITHHELD, r, p) for r, p in held.files])
    for table in ("alignment", "validation", "card_doi"):
        target.executemany(f"DELETE FROM {table} WHERE article_id = ?", [(a,) for a in held.maps])
    target.execute("DROP TABLE IF EXISTS withheld")
    # What only off-topic papers (or nothing) pointed at goes too: repositories, their files
    # and facts, datasets, people and funders no paper in scope names.
    target.execute("DELETE FROM repository WHERE repo NOT IN (SELECT repo FROM link)")
    for table in ("file", "alive_check", "repo_feature", "repo_tool", "script_manifest"):
        if target.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
            target.execute(f"DELETE FROM {table} WHERE repo NOT IN (SELECT repo FROM repository)")
    target.execute("DELETE FROM dataset WHERE id NOT IN (SELECT dataset_id FROM paper_dataset)")
    target.execute("DELETE FROM author WHERE orcid NOT IN (SELECT orcid FROM paper_author)")
    target.execute("DELETE FROM funder WHERE id NOT IN (SELECT funder_id FROM grant_award)")
    target.execute("DELETE FROM journal WHERE id NOT IN (SELECT journal_id FROM article)")
    # OpenAlex's institutions and topics that no paper in scope names (paper_author.ror holds ROR
    # ids, or {"id": …} objects: both are found by the id's text).
    target.execute("DELETE FROM institution WHERE NOT EXISTS (SELECT 1 FROM paper_author p "
                   "WHERE instr(p.ror, '\"' || institution.id || '\"') > 0)")
    target.execute("DELETE FROM topic WHERE id NOT IN (SELECT topic_id FROM paper_topic)")
    # No text of a paper leaves: abstracts, the raw Europe PMC records, the history of the
    # enriched records; availability statements only under an open license (D1).
    target.execute("UPDATE article SET abstract = ''")
    target.execute("DROP TABLE IF EXISTS epmc_record")
    # The OpenAlex records as kept (their raw affiliation strings are the publishers' text): what
    # may leave of them is in `article`, `paper_author`, `institution`, `paper_topic`, `paper_work`.
    target.execute("DROP TABLE IF EXISTS openalex_record")
    target.execute("DROP TABLE IF EXISTS version")
    closed = [r[0] for r in target.execute("SELECT id, license FROM article").fetchall()
              if not statement_is_publishable(r[1])]
    target.executemany("UPDATE statement SET text = '' WHERE article_id = ?", [(i,) for i in closed])
    # Development tests (test validations, sandbox DOIs) never leave.
    target.execute("DELETE FROM validation WHERE proof != 'orcid'")
    target.execute("DELETE FROM card_doi WHERE instance != 'zenodo'")
    # Who corrected a record (Phase 6) stays on the Mac: the corrections themselves are the links,
    # and the pages say "a correction by a verified author", never who.
    target.execute("DROP TABLE IF EXISTS link_edit")
    target.execute("UPDATE field_provenance SET source_ref = '' WHERE source IN ('author', 'maintainer', 'submitter')")
    target.execute(
        "UPDATE file SET text = NULL, note = ? WHERE repo IN "
        "(SELECT repo FROM repository WHERE redistributable NOT IN ('yes', 'with_conditions'))",
        (NOTE_LICENSE,))
    # The authors' contact details are private: they go to the private dataset only
    # (oscr/contacts.py), never into a public output. Email addresses in the scripts' text
    # are hidden, as on the site.
    target.execute("DROP TABLE IF EXISTS contact")
    target.executemany("UPDATE file SET text = ? WHERE rowid = ?",
                       [(mask_emails(t), rid) for rid, t in
                        target.execute("SELECT rowid, text FROM file WHERE text LIKE '%@%'").fetchall()])
    target.commit()
    target.execute("VACUUM")
    target.close()
    shutil.move(tmp, path)
