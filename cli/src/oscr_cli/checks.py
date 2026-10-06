"""The registry's checks on a local clone (``oscr check``; D10-8, D14-6): the same rules as the Worker's
``website/worker/forge/checks-core.ts`` and the environment files of ``website/src/lib/environments.ts``,
ported line for line. ``tests/fixtures/checks-cases.json`` holds the cases both implementations must
answer alike (website/tests/forge-pages/checks-parity.test.ts, cli/tests/test_registry.py): a change of
the rules changes both, or a test fails.

They read a tree's listing and three files (the licence, CITATION.cff, the README) **as text**: nothing
of the repository is built, installed, imported or run, here or anywhere in the registry.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from .citation import citation_of_cff, doi_of, parse_yaml
from .sanitize import mask_emails

# ── environment files (src/lib/environments.ts `environmentFiles`) ──

KIND_WORDS: dict[str, str] = {
    "pip": "pip's requirements",
    "conda": "a conda environment",
    "renv": "R's renv lock file",
    "julia-project": "a Julia project",
    "julia-manifest": "Julia's manifest (every version pinned)",
    "docker": "a container image's recipe (Dockerfile)",
    "devcontainer": "a development container",
    "pyproject": "a Python project (pyproject.toml)",
    "setupcfg": "a Python project (setup.cfg)",
    "r-description": "an R package (DESCRIPTION)",
    "lock": "a lock file (every version pinned)",
    "runtime": "Binder's runtime (runtime.txt)",
    "apt": "system packages (apt.txt)",
    "script": "a script",
    "npm": "a Node.js package (package.json)",
    "conda-recipe": "a conda recipe (meta.yaml)",
}
_DIRS = ("", "binder/", ".binder/", ".devcontainer/")
_ORDER = ["conda", "pip", "lock", "renv", "r-description", "julia-project", "julia-manifest", "pyproject", "setupcfg", "npm",
          "conda-recipe", "docker", "devcontainer", "runtime", "apt", "script"]


def _kind(name: str, d: str) -> str | None:
    if re.match(r"^requirements([-_.][\w-]+)?\.txt$", name, re.I | re.A) or name == "requirements.in":
        return "pip"
    if re.match(r"^environment\.ya?ml$", name, re.I):
        return "conda"
    if name == "renv.lock":
        return "renv"
    if name in ("Project.toml", "JuliaProject.toml"):
        return "julia-project"
    if name in ("Manifest.toml", "JuliaManifest.toml"):
        return "julia-manifest"
    if re.match(r"^(Dockerfile|Containerfile)(\.[\w-]+)?$", name, re.A):
        return "docker"
    if name in ("devcontainer.json", ".devcontainer.json"):
        return "devcontainer"
    if name == "pyproject.toml":
        return "pyproject"
    if name == "setup.cfg":
        return "setupcfg"
    if name == "DESCRIPTION" and d == "":
        return "r-description"
    if re.match(r"^(Pipfile\.lock|poetry\.lock|uv\.lock|conda-lock\.ya?ml|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|pdm\.lock)$", name):
        return "lock"
    if name == "runtime.txt":
        return "runtime"
    if name == "apt.txt":
        return "apt"
    if re.match(r"^(setup\.py|install\.R|postBuild|start|Makefile)$", name):
        return "script"
    if name == "package.json" and d == "":
        return "npm"
    if name == "meta.yaml":
        return "conda-recipe"
    return None


def environment_files(paths: list[str]) -> list[dict[str, str]]:
    """The environment files among a tree's paths, in a stable order."""
    out: list[dict[str, str]] = []
    for path in paths:
        slash = path.rfind("/")
        d = "" if slash < 0 else path[: slash + 1]
        name = path[slash + 1:]
        if d not in _DIRS and not (d.startswith(".devcontainer/") and name == "devcontainer.json") and d not in ("recipe/", "conda.recipe/"):
            continue
        k = _kind(name, d)
        if k and not any(f["path"] == path for f in out):
            out.append({"path": path, "kind": k})
    # JavaScript's sort compares the paths as UTF-16 strings; the kinds' order first.
    return sorted(out, key=lambda f: (_ORDER.index(f["kind"]), f["path"].encode("utf-16-be")))


# ── the checks (worker/forge/checks-core.ts) ──

CHECK_IDS = ("licence", "environment", "doi", "citation", "map", "sizes", "readme")
CHECK_WORDS = {
    "licence": "Licence",
    "environment": "Environment",
    "doi": "The paper's DOI",
    "citation": "CITATION.cff",
    "map": "Tracing maps",
    "sizes": "File sizes",
    "readme": "README",
}
LEVEL_WORDS = {"failure": "Failed", "warning": "To look at", "notice": "Note", "ok": "Passed"}
LARGE_FILE_BYTES = 50 * 2**20
CHECK_TEXT_BYTES = 256 * 1024

_LICENCE_FILE = re.compile(r"^(licen[cs]e|copying|unlicense)(\.(md|txt|rst))?$", re.I)
_README_FILE = re.compile(r"^readme(\.(md|markdown|rst|txt|org|adoc))?$", re.I)
_DOI_IN_TEXT = re.compile(r'\b10\.\d{4,9}/[^\s"<>)\]]+', re.A)
_HOW_TO_RUN = re.compile(r"\b(install|installation|usage|getting started|requirements|how to run|quick ?start|reproduc)", re.I | re.A)


@dataclass
class Annotation:
    path: str
    line: int
    level: str
    title: str
    message: str


@dataclass
class Finding:
    id: str
    level: str
    words: str
    fix: str
    annotations: list[Annotation] = field(default_factory=list)


@dataclass
class Report:
    conclusion: str
    title: str
    summary: str
    findings: list[Finding]
    annotations: list[Annotation]

    def as_json(self) -> dict[str, Any]:
        return asdict(self)


def _root(paths: list[str], pattern: re.Pattern[str]) -> str | None:
    return next((p for p in paths if "/" not in p and pattern.match(p)), None)


def check_files(paths: list[str]) -> dict[str, str | None]:
    """The files the checks read at a commit: the licence, CITATION.cff, the README."""
    return {"licence": _root(paths, _LICENCE_FILE), "citation": "CITATION.cff" if "CITATION.cff" in paths else None, "readme": _root(paths, _README_FILE)}


def licence_of(text: str) -> str | None:
    """A licence recognised from its text (its SPDX id), or None. The first 4 KiB decide."""
    t = re.sub(r"\s+", " ", text[:4096]).lower()

    def has(*words: str) -> bool:
        return all(w in t for w in words)

    if has("apache license", "version 2.0"):
        return "Apache-2.0"
    if has("mozilla public license", "2.0"):
        return "MPL-2.0"
    if has("gnu affero general public license", "version 3"):
        return "AGPL-3.0"
    if has("gnu lesser general public license", "version 3"):
        return "LGPL-3.0"
    if has("gnu lesser general public license", "version 2.1"):
        return "LGPL-2.1"
    if has("gnu general public license", "version 3"):
        return "GPL-3.0"
    if has("gnu general public license", "version 2"):
        return "GPL-2.0"
    if has("european union public licence"):
        return "EUPL-1.2"
    if has("permission is hereby granted, free of charge"):
        return "MIT"
    if has("redistribution and use in source and binary forms"):
        return "BSD-3-Clause" if has("neither the name") or has("names of its contributors") else "BSD-2-Clause"
    if has("permission to use, copy, modify, and/or distribute this software"):
        return "ISC"
    if has("this is free and unencumbered software released into the public domain"):
        return "Unlicense"
    if has("cc0 1.0 universal"):
        return "CC0-1.0"
    if has("attribution-sharealike 4.0 international"):
        return "CC-BY-SA-4.0"
    if has("attribution 4.0 international"):
        return "CC-BY-4.0"
    if has("boost software license"):
        return "BSL-1.0"
    if has("artistic license 2.0"):
        return "Artistic-2.0"
    if has("cecill"):
        return "CECILL-2.1"
    return None


def _changes(x: dict[str, Any]) -> list[dict[str, Any]]:
    ch = x.get("change")
    return list(ch.get("files") or []) if ch else []


def _licence_check(x: dict[str, Any], files: dict[str, str | None]) -> Finding:
    removed = next((f for f in _changes(x) if f["status"] == "removed" and _LICENCE_FILE.match(f["path"]) and "/" not in f["path"]), None)
    if removed:
        return Finding("licence", "failure", f"This change deletes the licence file {removed['path']}: without it, nobody may reuse the code.",
                       "Keep the licence file, or replace it with another open licence in the same change.")
    lic = files["licence"]
    if not lic:
        return Finding("licence", "warning", "No licence file: others may read the code but not reuse it, and the registry keeps no copy of its scripts.",
                       "Add a LICENSE file with an open licence (MIT, Apache-2.0, BSD-3-Clause, GPL-3.0…).")
    text = x["texts"].get(lic)
    spdx = licence_of(text) if text else None
    if not spdx:
        return Finding("licence", "warning", f"The licence file {lic} names no licence the registry recognises.",
                       "Use a standard licence's text as it is, so that people and tools recognise it.",
                       [Annotation(lic, 1, "warning", "Licence not recognised", "This text is not a standard licence the registry recognises.")] if text else [])
    return Finding("licence", "ok", f"{spdx}, in {lic}.", "")


def _environment_check(paths: list[str]) -> Finding:
    env = environment_files(paths)
    main = [f for f in env if f["kind"] != "script"]
    if not main:
        words = (f"Only scripts say how the code runs ({', '.join(f['path'] for f in env)}): no file lists its dependencies."
                 if env else "No file says how the code runs again: its dependencies and their versions are unknown.")
        return Finding("environment", "warning", words,
                       "Add an environment file: requirements.txt, environment.yml, renv.lock, Project.toml, a Dockerfile… with versions pinned.")
    words = ", ".join(f"{f['path']} ({KIND_WORDS[f['kind']]})" for f in main[:4])
    more = f", and {len(main) - 4} more" if len(main) > 4 else ""
    return Finding("environment", "ok", f"{words}{more}.", "")


def _doi_check(x: dict[str, Any], files: dict[str, str | None]) -> Finding:
    papers = x.get("papers") or []
    if papers:
        which = "its paper" if len(papers) == 1 else f"{len(papers)} papers"
        return Finding("doi", "ok", f"Linked in the registry to {which}: {', '.join(papers[:3])}.", "")
    named = None
    for p in (files["citation"], files["readme"]):
        t = x["texts"].get(p) if p else None
        m = _DOI_IN_TEXT.search(t) if t else None
        if m:
            named = m.group(0)
            break
    if named:
        return Finding("doi", "notice", f"A DOI is named ({re.sub(r'[.,;]+$', '', named)}), but the repository is not linked to its paper in the registry.",
                       "Link the repository to its paper (the repository's page, Papers), so that the paper's readers find its code.")
    return Finding("doi", "warning", "No paper is linked, and no DOI is named: readers cannot tell which paper this code belongs to.",
                   "Link the repository to its paper in the registry, or name the paper's DOI in CITATION.cff or the README.")


def _citation_check(x: dict[str, Any], files: dict[str, str | None]) -> Finding:
    changed = next((f for f in _changes(x) if f["path"] == "CITATION.cff" and f["status"] in ("modified", "added", "changed")), None)
    if not files["citation"]:
        removed = next((f for f in _changes(x) if f["path"] == "CITATION.cff" and f["status"] == "removed"), None)
        if removed:
            return Finding("citation", "failure", "This change deletes CITATION.cff: the repository no longer says how to cite it.", "Keep CITATION.cff.")
        return Finding("citation", "warning", "No CITATION.cff: GitHub, Zenodo and reference managers cannot say how to cite this code.",
                       "Add a CITATION.cff with its title, authors (with their ORCID iDs) and the paper's DOI (the registry's editor writes one from the paper).")
    text = x["texts"].get(files["citation"])
    if text is None:
        return Finding("citation", "notice", "CITATION.cff could not be read.", "")
    try:
        top = parse_yaml(text)
        version = str(top["cff-version"]) if isinstance(top, dict) and isinstance(top.get("cff-version"), str) else ""
    except (RecursionError, ValueError):
        version = ""
    cff = citation_of_cff(text)
    if not cff or not version:
        words = "CITATION.cff has no cff-version, or is not readable as YAML." if not version else "CITATION.cff has no title or no author."
        level = "failure" if changed else "warning"
        said = f"This change leaves CITATION.cff unusable: {words[0].lower()}{words[1:]}" if changed else words
        return Finding("citation", level, said, "Write cff-version, message, title and authors (the Citation File Format 1.2.0).",
                       [Annotation("CITATION.cff", 1, level, "CITATION.cff", words)])
    doi = cff.work.doi or cff.software.doi or doi_of(text)
    title = mask_emails(cff.work.title)[:120]
    if not doi:
        return Finding("citation", "notice", f"CITATION.cff cites “{title}”, without a DOI.", "Add the paper's DOI (doi:, or a preferred-citation with its DOI).",
                       [Annotation("CITATION.cff", 1, "notice", "No DOI", "The citation names no DOI.")])
    return Finding("citation", "ok", f"CITATION.cff cites “{title}” ({doi}).", "")


def _map_check(x: dict[str, Any], paths: set[str]) -> Finding:
    traced = x.get("traced") or []
    if not traced:
        return Finding("map", "ok", "No tracing map points to this repository yet.", "")
    by_path: dict[str, list[dict[str, str]]] = {}
    for t in traced:
        by_path.setdefault(t["path"], []).append({"paper": t["paper"], "commit": t["commit"]})
    annotations: list[Annotation] = []
    failures: list[str] = []
    notices: list[str] = []
    gone: list[str] = []

    def papers_of(p: str) -> str:
        return ", ".join(dict.fromkeys(m["paper"] for m in by_path.get(p, [])))

    if x.get("change"):
        for f in x["change"]["files"]:
            frm = (f.get("previousPath") or f["path"]) if f["status"] == "renamed" else f["path"]
            if frm not in by_path:
                continue
            if f["status"] in ("removed", "renamed"):
                how = "deleted" if f["status"] == "removed" else f"renamed to {f['path']}"
                failures.append(f"{frm} ({papers_of(frm)}) is {how}")
            elif f["status"] in ("modified", "changed"):
                notices.append(frm)
                commit = (by_path.get(frm) or [{}])[0].get("commit", "")[:7]
                annotations.append(Annotation(f["path"], 1, "notice", "Traced by a paper",
                                              f"A tracing map of {papers_of(frm)} points to this file, pinned to commit {commit}: the map stays valid there; after this change, its author may want a new version."))
    elif not x.get("truncated"):
        gone = [p for p in by_path if p not in paths]
    if failures:
        which = "a file" if len(failures) == 1 else "files"
        return Finding("map", "failure", f"A tracing map points to {which} this change takes away: {'; '.join(failures)}.",
                       "Keep the file where the map points, or ask the map's author to trace the new place first (the map stays valid at its pinned commit).", annotations)
    if gone:
        which = "a file" if len(gone) == 1 else f"{len(gone)} files"
        return Finding("map", "warning", f"Tracing maps point to {which} this commit no longer has: {', '.join(gone[:5])}. The maps stay valid at their pinned commits.",
                       "Nothing is broken for the paper; its authors may trace the code's new place in a new version of the map.")
    if notices:
        which = "a file" if len(notices) == 1 else f"{len(notices)} files"
        return Finding("map", "notice", f"This change touches {which} a tracing map points to: {', '.join(notices[:5])}.",
                       "The maps stay valid at their pinned commits; the paper's authors may want to review this change.", annotations)
    return Finding("map", "ok", f"Every file the tracing maps point to is still here ({len(by_path)}).", "")


def _sizes_check(x: dict[str, Any]) -> Finding:
    big = [e for e in x["entries"] if e["type"] == "blob" and (e.get("size") or 0) > LARGE_FILE_BYTES]
    if not big:
        return Finding("sizes", "ok", "No file over 50 MiB.", "")

    def mib(n: int) -> str:
        return f"{_js_round(n / 2**20)} MiB"

    which = "A file weighs" if len(big) == 1 else f"{len(big)} files weigh"
    listed = ", ".join("{} ({})".format(e["path"], mib(e.get("size") or 0)) for e in big[:5])
    return Finding("sizes", "warning", f"{which} over 50 MiB: {listed}.",
                   "Put data and archives in a data repository with a DOI (Zenodo, OSF, a field's own), and link it from the README.")


def _js_round(v: float) -> int:
    """JavaScript's Math.round: halves go up."""
    import math

    return math.floor(v + 0.5)


def _readme_check(x: dict[str, Any], files: dict[str, str | None]) -> Finding:
    readme = files["readme"]
    if not readme:
        return Finding("readme", "warning", "No README: nothing says what the code does, nor how to run it.",
                       "Add a README: what the code does, the paper it belongs to, how to install and run it.")
    text = x["texts"].get(readme)
    if not text:
        return Finding("readme", "ok", f"README: {readme}.", "")
    if not _HOW_TO_RUN.search(text):
        return Finding("readme", "notice", f"The README ({readme}) does not say how to install or run the code.",
                       "Add a section on installing and running it, to reproduce the paper's results.",
                       [Annotation(readme, 1, "notice", "How to run it", "No section on installing or running the code.")])
    return Finding("readme", "ok", f"README: {readme}, with how to run the code.", "")


def run_checks(x: dict[str, Any]) -> Report:
    """The checks at a commit (and, with ``change``, of a change). ``x`` has checks-core.ts's CheckInput
    shape: entries [{path, type, size}], truncated, texts {path: text|None}, papers [DOI], traced
    [{path, paper, commit}], change {files: [{path, previousPath, status}], truncated} or None."""
    paths = [e["path"] for e in x["entries"] if e["type"] == "blob"]
    files = check_files(paths)
    findings = [
        _licence_check(x, files),
        _environment_check(paths),
        _doi_check(x, files),
        _citation_check(x, files),
        _map_check(x, set(paths)),
        _sizes_check(x),
        _readme_check(x, files),
    ]

    def count(level: str) -> int:
        return sum(1 for f in findings if f.level == level)

    failed, warned = count("failure"), count("warning")
    conclusion = "failure" if failed else ("neutral" if warned else "success")
    passed = count("ok") + count("notice")
    if failed:
        title = f"{failed} {'check fails' if failed == 1 else 'checks fail'}: {', '.join(CHECK_WORDS[f.id].lower() for f in findings if f.level == 'failure')}"
    elif warned:
        title = f"{passed} passed, {warned} to look at"
    else:
        title = f"All {len(findings)} checks passed"
    lines = [f"- **{CHECK_WORDS[f.id]}** — {LEVEL_WORDS[f.level]}. {f.words}{' ' + f.fix if f.fix else ''}" for f in findings]
    notes = []
    if x.get("truncated"):
        notes.append("The forge cut the tree's listing: files beyond it were not looked at.")
    if (x.get("change") or {}).get("truncated"):
        notes.append("The change has more files than the registry reads: the tracing maps were checked against the first ones.")
    summary = "\n".join(["These checks read the repository's files as text; they never run its code.", "", *lines, *(["", *notes] if notes else [])])
    annotations = [Annotation(a.path, a.line, a.level, a.title, mask_emails(a.message)) for f in findings for a in f.annotations]
    return Report(conclusion, title, mask_emails(summary), findings, annotations)
