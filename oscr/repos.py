"""Verifying a repository: does it still exist, what does it hold, under which license.

**Why git rather than the GitHub API.** The anonymous API grants 60 requests
per hour: a pass over 200 papers exhausts it. The git protocol has no such
ceiling and speaks to EVERY forge the same way — GitHub, GitLab, Codeberg,
G-Node GIN, Hugging Face. Two commands are enough:

    git ls-remote <url> HEAD                         does the repository exist? its commit
    git clone --filter=blob:none --depth 1 --no-checkout
                                                     the list of files, without
                                                     their content (a few KB)

then `git show HEAD:LICENSE` and `git show HEAD:README.md` fetch only those two
files. With a token (`GITHUB_TOKEN`), the API adds the stars and the creation
date — useful to recognize a long-established public tool.

**Archives** (Zenodo, OSF, figshare) have an open API that gives the TYPE of
the resource — software or dataset —, its files and its license. It is what
decides when the paper only says "available at Zenodo".

**What is not kept.** The clone is deleted after reading. Links rot (5.4% per
year in biomedical informatics): the lasting remedy is the Software Heritage
archive, which is QUERIED here (read only). Requesting an archival ("Save Code
Now") is an action towards a third-party service: it is an option, never a
default.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from .links import Link
from .net import Client

#: SCRIPT extensions, and the language they denote. `.m` is MATLAB: in
#: neuroscience, Objective-C does not come up.
SCRIPT_EXTENSIONS: dict[str, str] = {
    ".py": "Python", ".ipynb": "Jupyter", ".m": "MATLAB", ".mlx": "MATLAB",
    ".r": "R", ".rmd": "R", ".qmd": "Quarto", ".jl": "Julia", ".c": "C", ".cpp": "C++",
    ".cc": "C++", ".h": "C/C++", ".cu": "CUDA", ".f90": "Fortran", ".java": "Java",
    ".js": "JavaScript", ".ts": "TypeScript", ".sh": "Shell", ".bash": "Shell",
    ".do": "Stata", ".sas": "SAS", ".sps": "SPSS", ".nb": "Mathematica", ".wl": "Mathematica",
    ".hoc": "NEURON", ".mod": "NEURON", ".nest": "NEST", ".go": "Go", ".rs": "Rust",
    ".scala": "Scala", ".pl": "Perl", ".stan": "Stan", ".jags": "JAGS", ".bug": "BUGS",
}

#: Beyond this, the full list of files is not kept (data repositories).
MAX_FILES_KEPT: int = 3000

GIT_TIMEOUT_S: int = 120


# ─── licenses ───────────────────────────────────────────────────────────────

_SIGNATURES: tuple[tuple[str, str], ...] = (
    (r"GNU AFFERO GENERAL PUBLIC LICENSE", "AGPL-3.0"),
    (r"GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3", "LGPL-3.0"),
    (r"GNU LESSER GENERAL PUBLIC LICENSE|GNU LIBRARY GENERAL PUBLIC", "LGPL-2.1"),
    (r"GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3", "GPL-3.0"),
    (r"GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 2", "GPL-2.0"),
    (r"Apache License[\s\S]{0,100}Version 2\.0", "Apache-2.0"),
    (r"Mozilla Public License[\s\S]{0,50}2\.0", "MPL-2.0"),
    (r"Permission is hereby granted, free of charge", "MIT"),
    (r"Redistribution and use in source and binary forms[\s\S]*Neither the name", "BSD-3-Clause"),
    (r"Redistribution and use in source and binary forms", "BSD-2-Clause"),
    (r"Permission to use, copy, modify, and/?or distribute this software for any purpose", "ISC"),
    (r"This is free and unencumbered software released into the public domain", "Unlicense"),
    (r"CC0 1\.0|Creative Commons Zero|CC0-1\.0", "CC0-1.0"),
    (r"Attribution-NonCommercial-ShareAlike", "CC-BY-NC-SA-4.0"),
    (r"Attribution-NonCommercial-NoDerivatives|Attribution-NonCommercial-NoDerivs", "CC-BY-NC-ND-4.0"),
    (r"Attribution-NonCommercial", "CC-BY-NC-4.0"),
    (r"Attribution-ShareAlike 4\.0", "CC-BY-SA-4.0"),
    (r"Attribution 4\.0 International", "CC-BY-4.0"),
    (r"CeCILL", "CECILL-2.1"),
    (r"European Union Public Licen[cs]e|EUPL", "EUPL-1.2"),
    (r"Artistic License", "Artistic-2.0"),
    (r"Boost Software License", "BSL-1.0"),
)

#: The licenses that allow redistributing a copy, as is.
_OPEN = {"MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "Unlicense",
         "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "GPL-2.0", "GPL-3.0", "LGPL-2.1",
         "LGPL-3.0", "AGPL-3.0", "MPL-2.0", "CECILL-2.1", "EUPL-1.2", "Artistic-2.0",
         "BSL-1.0", "Zlib", "0BSD", "BSD-3-Clause-Clear", "Python-2.0"}
_CONDITIONS = {"CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0", "CC-BY-ND-4.0"}

#: Zenodo/figshare/OSF licenses → SPDX.
_LICENSE_ALIASES: dict[str, str] = {
    "mit": "MIT", "mit-license": "MIT", "bsd-3-clause": "BSD-3-Clause", "bsd-license": "BSD-3-Clause",
    "bsd-2-clause": "BSD-2-Clause", "apache-2.0": "Apache-2.0", "apache2.0": "Apache-2.0",
    "gpl-3.0": "GPL-3.0", "gpl-3.0-only": "GPL-3.0", "gpl-3.0-or-later": "GPL-3.0",
    "gpl-2.0": "GPL-2.0", "gpl-2.0-only": "GPL-2.0", "gpl-2.0-or-later": "GPL-2.0",
    "lgpl-3.0": "LGPL-3.0", "lgpl-2.1": "LGPL-2.1", "agpl-3.0": "AGPL-3.0",
    "mpl-2.0": "MPL-2.0", "cc-by-4.0": "CC-BY-4.0", "cc-by-sa-4.0": "CC-BY-SA-4.0",
    "cc0-1.0": "CC0-1.0", "cc-zero": "CC0-1.0", "cc-by-nc-4.0": "CC-BY-NC-4.0",
    "cc-by-nc-sa-4.0": "CC-BY-NC-SA-4.0", "cc-by-nc-nd-4.0": "CC-BY-NC-ND-4.0",
    "cc-by-nd-4.0": "CC-BY-ND-4.0", "unlicense": "Unlicense", "isc": "ISC",
    "cc by 4.0": "CC-BY-4.0", "cc0": "CC0-1.0", "cc0 1.0 universal": "CC0-1.0",
    "cc-by": "CC-BY-4.0", "cc by": "CC-BY-4.0", "no license": "", "other-open": "other-open",
}


def license_of(text: str) -> str:
    """The SPDX id of a LICENSE file: the license whose signature comes FIRST in the text.

    A license names others in passing: section 13 of the GPL-3.0 names the GNU Affero
    General Public License, and the GPLs name the Lesser (Library) GPL. Taking the first
    signature of the list that matched anywhere labeled 38 GPL-3.0 repositories AGPL-3.0
    (seen 2026-09-27). On a tie, the more specific signature, listed first, wins."""
    best: tuple[int, str] | None = None
    for pattern, spdx in _SIGNATURES:
        m = re.search(pattern, text, re.I)
        if m and (best is None or m.start() < best[0]):
            best = (m.start(), spdx)
    if best:
        return best[1]
    return "other" if text.strip() else ""


def normalize_license(name: str) -> str:
    n = (name or "").strip()
    if not n:
        return ""
    return _LICENSE_ALIASES.get(n.lower(), _LICENSE_ALIASES.get(n.lower().replace(" ", "-"), n))


def redistributable(spdx: str) -> str:
    """yes | with_conditions | no | unknown — to decide on a snapshot."""
    if not spdx:
        return "no"           # no license: all rights reserved, link only
    if spdx in _OPEN or spdx == "other-open":
        return "yes"
    if spdx in _CONDITIONS:
        return "with_conditions"
    return "unknown"


# ─── quotas ─────────────────────────────────────────────────────────────────

#: Until when a service is set aside because its hourly quota is exhausted.
#: Software Heritage (120 anonymous req/h) and OSF (~100 req/h) run dry fast on
#: a shared GitHub Actions machine; waiting for their reset would block the
#: whole pass. We do without them, and the repository is verified again at the
#: next pass.
_PAUSED: dict[str, float] = {}


def _paused(service: str) -> bool:
    return time.time() < _PAUSED.get(service, 0.0)


def _quota_exhausted(service: str, r: Any) -> bool:
    """If the response says "quota exhausted", set the service aside until its
    reset (or for one hour)."""
    exhausted = r.status == 429 or (r.status == 403 and r.headers.get("x-ratelimit-remaining") == "0")
    if exhausted:
        reset = r.headers.get("x-ratelimit-reset", "")
        until = float(reset) if reset.isdigit() and float(reset) > time.time() else time.time() + 3600
        _PAUSED[service] = min(until, time.time() + 3600)
    return exhausted


# ─── git ────────────────────────────────────────────────────────────────────

def _auth_github() -> list[str]:
    """With a token (GitHub Actions provides one), clones from github.com
    authenticate: anonymous clones are rate-limited more harshly there since
    2025-05-08. The token goes in a header, never in the URL nor in error
    messages."""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        return []
    import base64
    b64 = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    return ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {b64}"]


def _git(args: list[str], cwd: Path | None = None, timeout: int = GIT_TIMEOUT_S) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="false", SSH_ASKPASS="false",
               GIT_LFS_SKIP_SMUDGE="1")
    # No credential helper, and a credential prompt fails on the spot: a missing
    # repository must neither open a macOS keychain prompt nor send a dummy
    # credential to the server.
    return subprocess.run(["git", "-c", "credential.helper=", "-c", "core.askPass=false",
                           *_auth_github(), *args],
                          cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
                          # A byte that is not UTF-8 in a path or a file (0xb5, a Latin-1 "µ",
                          # in github.com/snu-list/chi_sepnet) must not make the repository
                          # look unreachable.
                          encoding="utf-8", errors="replace")


def _network_outage(stderr: str) -> bool:
    return bool(re.search(r"Could not resolve host|timed out|Connection (refused|reset)"
                          r"|Failed to connect|SSL|HTTP 5\d\d|The requested URL returned error: 5",
                          stderr, re.I))


def _extract_scripts(d: Path, files: list[str]) -> list[dict[str, Any]]:
    """Bring down ONLY the scripts, the README and the license of the commit.

    The clone is partial (no content); `sparse-checkout` restricts the working
    copy to patterns, and `checkout` then fetches only those files, in a single
    batch. Measured on schmidtfa/cardiac_1_f: 53 scripts in 1.5 s, without any of
    the repository's data.
    """
    from . import contents
    wanted = [f for f in files if contents.is_script(f) or contents.is_doc(f)]
    if not wanted:
        return []
    extensions = sorted({os.path.splitext(f)[1].lower() for f in wanted if contents.is_script(f)})
    patterns = [f"*{e}" for e in extensions] + [f"*{e.upper()}" for e in extensions if e != e.upper()]
    patterns += [f"/{f}" for f in wanted if contents.is_doc(f)]
    _git(["sparse-checkout", "set", "--no-cone", *patterns], cwd=d, timeout=120)
    c = _git(["checkout", "-q", "HEAD"], cwd=d, timeout=600)
    if c.returncode != 0:
        return [{"path": "…", "language": "", "kind": "note", "size": 0, "digest": "",
                 "text": None, "truncated": 0, "lines": None,
                 "note": "extraction failed: " + c.stderr.strip()[:150]}]
    return contents.from_folder(d, wanted)


def verify_git(link: Link, article: dict[str, Any] | None, folder: Path,
               client: Client | None = None, *, with_contents: bool = True) -> dict[str, Any]:
    url = link.git_url
    record: dict[str, Any] = {"state": "unverified"}
    try:
        r = _git(["ls-remote", "--symref", url, "HEAD"], timeout=45)
    except subprocess.TimeoutExpired:
        return {"state": "unreachable", "error": "ls-remote: timed out"}
    if r.returncode != 0:
        if _network_outage(r.stderr):
            return {"state": "unreachable", "error": r.stderr.strip()[:300]}
        # Missing, or private: the forge does not tell them apart, and neither do we.
        return {"state": "dead", "error": r.stderr.strip()[:300]}
    sha = next((l.split()[0] for l in r.stdout.splitlines() if l.endswith("\tHEAD")
                and not l.startswith("ref:")), "")
    record.update(state="alive", commit_id=sha)
    if not sha:
        record.update(n_files=0, n_scripts=0, error="empty repository")
        return record

    folder.mkdir(parents=True, exist_ok=True)
    clone = Path(tempfile.mkdtemp(prefix="clone_", dir=folder))
    try:
        c = _git(["clone", "--quiet", "--filter=blob:none", "--depth", "1", "--no-checkout",
                  url, str(clone / "d")])
        if c.returncode != 0:
            shutil.rmtree(clone, ignore_errors=True)
            clone.mkdir(parents=True, exist_ok=True)
            c = _git(["clone", "--quiet", "--depth", "1", "--no-checkout", url, str(clone / "d")],
                     timeout=240)
        if c.returncode != 0:
            record["error"] = "clone: " + c.stderr.strip()[:250]
            return record
        d = clone / "d"
        files = [f for f in _git(["ls-tree", "-r", "--name-only", "HEAD"], cwd=d).stdout.splitlines() if f]
        record.update(_inventory(files))
        record["commit_date"] = _git(["log", "-1", "--format=%cI"], cwd=d).stdout.strip()
        root = [f for f in files if "/" not in f]
        lic = next((f for f in root if re.match(r"(?i)^(licen[cs]e|copying|copyright)(\.\w+)?$", f)), "")
        if lic:
            text = _git(["show", f"HEAD:{lic}"], cwd=d, timeout=60).stdout
            record["license"] = license_of(text)
        else:
            record["license"] = ""
        readme = next((f for f in root if re.match(r"(?i)^readme(\.\w+)?$", f)), "")
        if readme and article:
            text = _git(["show", f"HEAD:{readme}"], cwd=d, timeout=60).stdout
            record["cites_article"] = cites_article(text, article)
            if not record.get("license"):
                m = re.search(r"(?i)licen[cs]e[^\n]{0,80}\b(MIT|BSD|Apache|GPL|GNU|CC[- ]BY|CC0)", text)
                if m:
                    record["license"] = normalize_license(m.group(1)) or m.group(1)
        if with_contents:
            record["_contents"] = _extract_scripts(d, files)
    except subprocess.TimeoutExpired:
        record["error"] = "clone: timed out"
    finally:
        shutil.rmtree(clone, ignore_errors=True)
    record["redistributable"] = redistributable(record.get("license", ""))
    if client is not None and link.host == "github.com" and os.environ.get("GITHUB_TOKEN"):
        record.update(_github_api(client, link))
    return record


_ARCHIVES = (".zip", ".tar", ".tar.gz", ".tgz", ".7z", ".rar", ".gz", ".bz2", ".xz")


def _inventory(files: list[str]) -> dict[str, Any]:
    """Count the scripts. Two cases where the count does not tell the truth:

    - a ZIP with no script beside it (`vignetteAnalysis.zip` on OSF): the code
      may be inside, we do not know — `n_scripts` is `None`;
    - a BIDS dataset (`dataset_description.json`, `sub-XX` folders): its few
      conversion scripts do not make it a code repository
      (`nemardatasets/on007524`: 3 scripts out of 2,141 files).
    """
    languages: Counter[str] = Counter()
    scripts = []
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext in SCRIPT_EXTENSIONS:
            languages[SCRIPT_EXTENSIONS[ext]] += 1
            scripts.append(f)
    compressed = sum(f.lower().endswith(_ARCHIVES) for f in files)
    record: dict[str, Any] = {
        "n_files": len(files),
        "n_scripts": None if (not scripts and compressed) else len(scripts),
        "languages": dict(languages.most_common()),
        "files": files[:MAX_FILES_KEPT]}
    if "dataset_description.json" in files or sum(f.startswith("sub-") for f in files) >= 3:
        record["resource_type"] = "bids"
    return record


def cites_article(readme: str, article: dict[str, Any]) -> str:
    """Does the README cite the paper? `doi`, `title`, or nothing."""
    doi = (article.get("doi") or "").lower()
    low = readme.lower()
    if doi and doi in low:
        return "doi"
    title = article.get("title") or ""
    words = {w for w in re.findall(r"[a-z]{5,}", title.lower())}
    if len(words) >= 4 and len(words & set(re.findall(r"[a-z]{5,}", low))) / len(words) >= 0.75:
        return "title"
    return ""


def _github_api(client: Client, link: Link) -> dict[str, Any]:
    r = client.get(f"https://api.github.com/repos/{link.owner}/{link.name}", ttl_s=7 * 86400)
    if not r.ok:
        return {}
    d = r.json()
    extra = {"stars": d.get("stargazers_count"), "created": (d.get("created_at") or "")[:10]}
    spdx = ((d.get("license") or {}).get("spdx_id") or "")
    if spdx and spdx != "NOASSERTION":
        extra["license"] = spdx
        extra["redistributable"] = redistributable(spdx)
    return extra


# ─── archives: Zenodo, OSF, figshare ───────────────────────────────────────

#: A zip whose name says code ("SmartERD-v1.0.0.zip", "…-main.zip",
#: "analysis_code.zip"): downloaded even in a data archive.
_CODE_ZIP = re.compile(r"code|script|src|analys|software|toolbox|pipeline|-main\b|-master\b"
                       r"|v?\d+\.\d+(\.\d+)?\.zip$", re.I)
MAX_REMOTE_SCRIPT: int = 5_000_000


def _remote_contents(client: Client, files: list[tuple[str, str, int | None]],
                     resource_type: str) -> list[dict[str, Any]]:
    """Download the scripts of an archive, and its code zips.

    `files`: (name, download URL, size). A zip is only opened if the archive
    calls itself "software", if its name says code, or if it is alone: a data
    archive of several GB has nothing to teach us.
    """
    from . import contents
    out: list[dict[str, Any]] = []
    zips = [f for f in files if f[0].lower().endswith(".zip")]
    budget = contents.MAX_ARCHIVE * 2
    for name, url, size in files:
        if not url or budget <= 0:
            continue
        low = name.lower()
        if contents.is_script(name) or contents.is_doc(name):
            if size and size > MAX_REMOTE_SCRIPT:
                continue
            b = client.download(url, MAX_REMOTE_SCRIPT)
            if b is not None:
                budget -= len(b)
                out.append(contents.read(name, b))
        elif low.endswith(".zip") and (not size or size <= contents.MAX_ARCHIVE) and (
                resource_type == "software" or _CODE_ZIP.search(name) or len(zips) == 1):
            got = _remote_zip(client, url)
            if got is None:
                continue
            extracted, size_read = got
            budget -= size_read
            for f in extracted:
                if len(zips) > 1 and f["path"] != "…":
                    f["path"] = f"{name}/{f['path']}"
                out.append(f)
    return out


def _remote_zip(client: Client, url: str) -> tuple[list[dict[str, Any]], int] | None:
    """The scripts of a remote archive, read through the disk and not through
    memory. Returns (files, archive size), or None if nothing arrived."""
    from . import contents
    archive = client.download_archive(url, contents.MAX_ARCHIVE)
    if archive is None:
        return None
    with archive:
        size = archive.seek(0, 2)
        archive.seek(0)
        return (contents.from_zip(archive), size) if size else None


def verify_zenodo(client: Client, link: Link, *, with_contents: bool = True) -> dict[str, Any]:
    r = client.get(f"https://zenodo.org/api/records/{link.identifier}", ttl_s=7 * 86400)
    if r.status == 404:
        r = client.get(f"https://zenodo.org/api/records/{link.identifier}/versions/latest",
                       ttl_s=7 * 86400)
    if r.status in (404, 410):
        return {"state": "dead", "http_status": r.status}
    if not r.ok:
        return {"state": "unreachable", "http_status": r.status}
    d = r.json() or {}
    m = d.get("metadata", {})
    files = d.get("files") or []
    if isinstance(files, dict):
        files = list((files.get("entries") or {}).values())
    names = [f.get("key") or f.get("filename") or "" for f in files]
    lic = m.get("license") or {}
    spdx = normalize_license(lic.get("id", "") if isinstance(lic, dict) else str(lic))
    linked = next((ri.get("identifier", "") for ri in m.get("related_identifiers", [])
                   if re.search(r"github\.com|gitlab\.com", str(ri.get("identifier", "")), re.I)), "")
    record = {"state": "alive", "http_status": r.status,
              "resource_type": (m.get("resource_type") or {}).get("type", ""),
              "license": spdx, "redistributable": redistributable(spdx),
              "created": (d.get("created") or "")[:10], "linked_to": linked}
    record.update(_inventory(names))
    # A GitHub release published by the Zenodo integration is ONE zip of the repository.
    if record["n_scripts"] == 0 and any(n.lower().endswith((".zip", ".tar.gz")) for n in names) \
            and record["resource_type"] == "software":
        record["n_scripts"] = None
    if with_contents:
        record["_contents"] = _remote_contents(
            client, [(f.get("key") or f.get("filename") or "", (f.get("links") or {}).get("self", ""),
                      f.get("size")) for f in files], record["resource_type"])
    return record


def verify_osf(client: Client, link: Link, *, with_contents: bool = True) -> dict[str, Any]:
    if _paused("osf"):
        return {"state": "unreachable", "error": "OSF quota reached: verified again at the next pass"}
    vol = parse_qs(urlsplit(link.url).query).get("view_only", [""])[0]
    p = {"view_only": vol} if vol else None
    r = client.get(f"https://api.osf.io/v2/guids/{link.identifier}/", params=p, ttl_s=7 * 86400,
                   patient=False)
    if _quota_exhausted("osf", r):
        return {"state": "unreachable", "error": "OSF quota reached: verified again at the next pass"}
    if r.status in (404, 410):
        return {"state": "dead", "http_status": r.status}
    if r.status in (401, 403):
        return {"state": "unreachable", "http_status": r.status, "error": "private project"}
    if not r.ok:
        return {"state": "unreachable", "http_status": r.status}
    d = (r.json() or {}).get("data", {})
    typ = d.get("type", "")
    att = d.get("attributes", {})
    record: dict[str, Any] = {"state": "alive", "http_status": r.status,
                              "resource_type": f"osf-{att.get('category') or typ}",
                              "created": (att.get("date_created") or "")[:10]}
    if typ == "files":
        record.update(_inventory([att.get("name", "")]))
        return record
    if typ not in ("nodes", "registrations"):
        return record
    # An OSF project keeps its files with several PROVIDERS (osfstorage, a
    # connected GitHub or Drive) and often in child COMPONENTS: osf:a5m7q showed
    # no file at the root of its osfstorage.
    names: list[str] = []
    downloadable: list[tuple[str, str, int | None]] = []
    budget = [12]

    def list_files(url: str, prefix: str = "") -> None:
        to_visit = [url]
        while to_visit and budget[0] > 0:
            u = to_visit.pop(0)
            budget[0] -= 1
            rr = client.get(u, params=dict(p or {}, **{"page[size]": "100"}), ttl_s=7 * 86400)
            if not rr.ok:
                return
            for f in (rr.json() or {}).get("data", []):
                a = f.get("attributes", {})
                following = ((f.get("relationships", {}).get("files", {})
                              .get("links", {}).get("related", {})).get("href"))
                if a.get("kind") == "folder" or f.get("type") == "files" and a.get("provider") and not a.get("kind"):
                    if following:
                        to_visit.append(following)
                elif a.get("kind") == "file":
                    name = prefix + a.get("materialized_path", a.get("name", "")).strip("/")
                    names.append(name)
                    downloadable.append((name, (f.get("links") or {}).get("download", ""),
                                         a.get("size")))

    list_files(f"https://api.osf.io/v2/{typ}/{link.identifier}/files/")
    if not names and budget[0] > 0:
        rr = client.get(f"https://api.osf.io/v2/{typ}/{link.identifier}/children/", params=p,
                        ttl_s=7 * 86400)
        for child in ((rr.json() or {}).get("data", []) if rr.ok else [])[:4]:
            list_files(f"https://api.osf.io/v2/nodes/{child['id']}/files/", f"{child['id']}/")
    record.update(_inventory(names))
    if with_contents:
        if vol:
            downloadable = [(n, u + ("&" if "?" in u else "?") + f"view_only={vol}", s)
                            for n, u, s in downloadable if u]
        record["_contents"] = _remote_contents(client, downloadable, record["resource_type"])
    return record


def verify_figshare(client: Client, link: Link, *, with_contents: bool = True) -> dict[str, Any]:
    r = client.get(f"https://api.figshare.com/v2/articles/{link.identifier}", ttl_s=7 * 86400)
    if r.status in (404, 410):
        return {"state": "dead", "http_status": r.status}
    if not r.ok:
        return {"state": "unreachable", "http_status": r.status}
    d = r.json() or {}
    spdx = normalize_license((d.get("license") or {}).get("name", ""))
    record = {"state": "alive", "http_status": r.status,
              "resource_type": d.get("defined_type_name", ""),
              "license": spdx, "redistributable": redistributable(spdx),
              "created": (d.get("created_date") or "")[:10]}
    record.update(_inventory([f.get("name", "") for f in d.get("files", [])]))
    if with_contents:
        record["_contents"] = _remote_contents(
            client, [(f.get("name", ""), f.get("download_url", ""), f.get("size"))
                     for f in d.get("files", [])], record["resource_type"])
    return record


def verify_supplementary(client: Client, link: Link, *, with_contents: bool = True
                         ) -> dict[str, Any]:
    """A file attached to the paper (eLife's "Source code 1").

    The PMC Open Access bucket on AWS serves every attached file without an
    account: `pmc-oa-opendata.s3.amazonaws.com/PMC<id>.<version>/<file>`
    (checked 2026-09-25 on PMC11563573.1/elife-98759-code1.zip).
    """
    from . import contents
    m = re.match(r"supp:(PMC\d+)/(.+)$", link.repo, re.I)
    if not m:
        return {"state": "unverifiable", "error": "attached file without a PMCID"}
    pmcid, name = m.group(1).upper(), m.group(2)
    for version in (1, 2, 3):
        url = f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.{version}/{quote(name)}"
        r = client.get(url, method="HEAD")
        if r.status == 200:
            break
    else:
        return {"state": "unverifiable", "error": "missing from the PMC Open Access bucket"}
    record: dict[str, Any] = {"state": "alive", "http_status": 200, "resource_type": "attached file"}
    record.update(_inventory([name]))
    if with_contents:
        if name.lower().endswith(".zip"):
            got = _remote_zip(client, url)
            record["_contents"] = got[0] if got else []
            if got:
                record.update(_inventory([f["path"] for f in record["_contents"] if f["path"] != "…"]))
        elif contents.is_script(name):
            b = client.download(url, MAX_REMOTE_SCRIPT)
            record["_contents"] = [contents.read(name, b)] if b else []
    return record


def verify_dryad(client: Client, link: Link) -> dict[str, Any]:
    """A Dryad DOI: does it answer? And which Zenodo software comes with it?

    Dryad deposits the CODE of a dataset in a Zenodo record of type "software"
    that declares itself `isSourceOf` the Dryad DOI (checked 2026-09-25:
    zenodo:14946966 → 10.5061/dryad.v41ns1s70, a zip
    "Llano-Lab-Analysis-Program-main"). It is found by a Zenodo search on the
    DOI, and attached as the source.
    """
    record = verify_http(client, f"https://doi.org/{link.identifier}")
    r = client.get("https://zenodo.org/api/records", params={
        "q": f'related.identifier:"{link.identifier}" AND resource_type.type:software',
        "size": "5"}, ttl_s=7 * 86400)
    if r.ok:
        hits = ((r.json() or {}).get("hits") or {}).get("hits") or []
        if hits:
            record["linked_to"] = f"https://zenodo.org/records/{hits[0]['id']}"
            record["resource_type"] = "dryad+software"
    return record


def verify_http(client: Client, url: str) -> dict[str, Any]:
    """Does the link answer? HEAD, then a bounded GET if the server refuses HEAD."""
    r = client.get(url, method="HEAD")
    if r.status in (400, 403, 405, 501) or r.status == 0:
        r = client.get(url, headers={"Range": "bytes=0-2048"})
    if r.status in (200, 206) or 300 <= r.status < 400:
        return {"state": "alive", "http_status": r.status}
    if r.status in (404, 410):
        return {"state": "dead", "http_status": r.status}
    return {"state": "unreachable", "http_status": r.status, "error": r.text[:200]}


def swh_archived(client: Client, origin_url: str) -> int | None:
    """1 if Software Heritage has archived this origin, 0 if not, None if we do not know."""
    if _paused("swh"):
        return None
    r = client.get(f"https://archive.softwareheritage.org/api/1/origin/{quote(origin_url, safe=':/')}/get/",
                   ttl_s=30 * 86400, patient=False)
    if _quota_exhausted("swh", r):
        return None
    if r.ok:
        return 1
    if r.status == 404:
        return 0
    return None


def verify(client: Client, link: Link, article: dict[str, Any] | None, clones_folder: Path,
           *, swh: bool = True, with_contents: bool = True) -> dict[str, Any]:
    """Route to the right verification for the host. With `with_contents`, the
    record also carries `_contents`: the text of the scripts, for the `file`
    table."""
    if link.is_git_repo:
        record = verify_git(link, article, clones_folder, client, with_contents=with_contents)
        if swh and record.get("state") in ("alive", "dead"):
            record["swh_archived"] = swh_archived(client, link.git_url)
        return record
    if link.repo.startswith("zenodo:"):
        return verify_zenodo(client, link, with_contents=with_contents)
    if link.repo.startswith("osf:"):
        return verify_osf(client, link, with_contents=with_contents)
    if link.repo.startswith("figshare:") and link.identifier.isdigit():
        return verify_figshare(client, link, with_contents=with_contents)
    if link.kind == "supplementary":
        return verify_supplementary(client, link, with_contents=with_contents)
    if link.repo.startswith("codeocean:"):
        # Code Ocean answers 403 to every robot, robots.txt included (checked
        # 2026-09-25): it can be neither confirmed nor refuted. Say so.
        return {"state": "unverifiable", "error": "Code Ocean refuses robots (403)"}
    if link.repo.startswith("swh:"):
        return {"state": "alive", "swh_archived": 1}
    if link.repo.startswith("doi:10.5061/dryad"):
        return verify_dryad(client, link)
    if link.repo.startswith("doi:"):
        return verify_http(client, f"https://doi.org/{link.identifier}")
    return verify_http(client, link.url)
