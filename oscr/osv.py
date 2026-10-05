"""Vulnerability and malware alerts from OSV (night phase 11, E2; docs/SECURITY_QUALITY.md).

OSV (osv.dev) is a free, public, open database of known vulnerabilities and malicious packages. The
Mac queries it, without a key, with the **batch** endpoint (one request for many packages), and the
details endpoint for each advisory it has not seen. Nothing is run, nothing of the code is sent: only
a package's name, ecosystem and version leave, which are public facts.

What it reads back, per advisory: the id (and any CVE aliases), a summary, the severity (from the
CVSS vector when OSV gives one), and whether it is a **malicious package** advisory (OpenSSF's
malicious-packages feed: ids that begin with ``MAL-``). It marks an advisory **withdrawn** when OSV
says so, and a dependency's advisory **development-scope** when the dependency is only a dev or test
one.

**Auto-triage** (rules, never a model): a withdrawn advisory is dismissed as a false positive; a
development-scope advisory is labelled so the maintainer can tell it apart. The maintainer decides
the rest in the Security tab (dismiss, reopen, assign), stored apart from these facts.

During the night build the client never calls the real OSV: it is given a ``post`` callable (a fake
server or fixtures), exactly as the fake GitHub stands in for GitHub. The real calls happen only when
the owner runs ``oscr security scan`` with the network.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

#: OSV's base URL. A development run points OSV_API_URL at a local fake; the owner's real runs use
#: this. The client is given a `post`; this is only the default address for building one.
API_URL = "https://api.osv.dev"
BATCH_PATH = "/v1/querybatch"
VULN_PATH = "/v1/vulns/"
#: Packages asked for in one batch request.
BATCH = 100

#: The dependency-graph ecosystems that OSV covers, mapped to OSV's own names. conda and Julia are
#: not covered (left out, not guessed); GitHub Actions is, under this name.
ECOSYSTEM = {
    "PyPI": "PyPI",
    "npm": "npm",
    "CRAN": "CRAN",
    "Actions": "GitHub Actions",
}


class Response(Protocol):
    status: int
    text: str

    def json(self) -> object: ...


#: A POST of a JSON body that answers a Response (net.Client.post_json, or a fake).
Post = Callable[[str, object], Response]


@dataclass
class Advisory:
    id: str
    summary: str = ""
    severity: str = "unknown"      # critical | high | moderate | low | unknown
    aliases: list[str] = field(default_factory=list)
    malware: bool = False
    withdrawn: bool = False

    @property
    def cve(self) -> str:
        return next((a for a in self.aliases if a.startswith("CVE-")), "")


@dataclass
class Alert:
    """One advisory affecting one dependency at its version."""
    ecosystem: str                  # the dependency graph's ecosystem (PyPI, npm, ...)
    package: str
    version: str
    advisory: Advisory
    dev_scope: bool = False
    #: Set by auto-triage: 'false_positive' for a withdrawn advisory, '' otherwise.
    auto_dismiss: str = ""


# CVSS base-score bands (the common 0-10 scale): the words OSV's consumers use.
def severity_from_score(score: float) -> str:
    if score >= 9.0:
        return "critical"
    if score >= 7.0:
        return "high"
    if score >= 4.0:
        return "moderate"
    if score > 0.0:
        return "low"
    return "unknown"


def _cvss_score(vector: str) -> float:
    """A rough base score from a CVSS v3 vector, enough to band the severity without a library.
    OSV also gives a database_specific severity; this is the fallback."""
    # A real score needs the full CVSS formula; OSV usually gives the score directly (below). This
    # maps the few vectors that carry no score to a band by their impact metrics.
    parts = dict(p.split(":", 1) for p in vector.split("/") if ":" in p)
    high = sum(1 for m in ("C", "I", "A") if parts.get(m) == "H")
    if parts.get("PR") == "N" and parts.get("AV") == "N" and high >= 2:
        return 9.0
    if high >= 2:
        return 7.5
    if high == 1:
        return 5.0
    return 2.0


def parse_advisory(data: dict) -> Advisory:
    """One OSV advisory record into the fields the registry keeps (no code, no long prose)."""
    adv = Advisory(id=str(data.get("id", "")))
    adv.summary = str(data.get("summary") or data.get("details", ""))[:2000]
    adv.aliases = [str(a) for a in data.get("aliases", []) if isinstance(a, str)]
    adv.withdrawn = bool(data.get("withdrawn"))
    adv.malware = adv.id.startswith("MAL-") or any(a.startswith("MAL-") for a in adv.aliases) \
        or "malicious" in adv.summary.lower()
    score = 0.0
    best = ""
    for s in data.get("severity", []) or []:
        value = str(s.get("score", ""))
        kind = str(s.get("type", ""))
        if kind in ("CVSS_V3", "CVSS_V4") and value.startswith("CVSS:"):
            score = max(score, _cvss_score(value))
        else:
            try:
                score = max(score, float(value))
            except ValueError:
                best = value.lower()
    if score > 0:
        adv.severity = severity_from_score(score)
    elif best in ("critical", "high", "moderate", "medium", "low"):
        adv.severity = "moderate" if best == "medium" else best
    elif adv.malware:
        adv.severity = "critical"
    return adv


@dataclass
class Query:
    ecosystem: str      # the dependency graph's name
    package: str
    version: str
    dev_scope: bool = False


def query_batch(post: Post, queries: list[Query], *, base: str = API_URL) -> dict[str, list[str]]:
    """The advisory ids affecting each (package, version), by a stable key "ecosystem\\npackage\\nversion".
    One batch request per BATCH queries. Unknown ecosystems are skipped (never guessed)."""
    out: dict[str, list[str]] = {}
    covered = [q for q in queries if q.ecosystem in ECOSYSTEM and q.version]
    for i in range(0, len(covered), BATCH):
        chunk = covered[i:i + BATCH]
        body = {"queries": [{"package": {"name": q.package, "ecosystem": ECOSYSTEM[q.ecosystem]},
                             "version": q.version} for q in chunk]}
        r = post(base + BATCH_PATH, body)
        if r.status != 200:
            continue
        results = (r.json() or {}).get("results", []) if isinstance(r.json(), dict) else []
        for q, result in zip(chunk, results):
            ids = [str(v.get("id")) for v in (result or {}).get("vulns", []) if v.get("id")]
            if ids:
                out[f"{q.ecosystem}\n{q.package}\n{q.version}"] = ids
    return out


def fetch_advisory(post: Post, vuln_id: str, *, base: str = API_URL,
                   get: Callable[[str], Response] | None = None) -> Advisory | None:
    """One advisory's details. OSV serves it at GET /v1/vulns/{id}; when only a `post` is available
    (the batch fake), the batch results may already carry the record (see `alerts_from`)."""
    if get is None:
        return None
    r = get(base + VULN_PATH + vuln_id)
    if r.status != 200:
        return None
    data = r.json()
    return parse_advisory(data) if isinstance(data, dict) else None


def auto_triage(alert: Alert) -> Alert:
    """Rules, in the safe direction: a withdrawn advisory is a false positive; a development-scope
    one keeps its label. Never dismisses a live advisory on its own."""
    if alert.advisory.withdrawn:
        alert.auto_dismiss = "false_positive"
    return alert


def alerts_from(ids_by_key: dict[str, list[str]], advisories: dict[str, Advisory],
                dev_scope: dict[str, bool] | None = None) -> list[Alert]:
    """Join the batch's ids with the advisory details into alerts, applying auto-triage."""
    dev_scope = dev_scope or {}
    out: list[Alert] = []
    for key, ids in ids_by_key.items():
        ecosystem, package, version = key.split("\n", 2)
        for vuln_id in ids:
            adv = advisories.get(vuln_id)
            if adv is None:
                continue
            out.append(auto_triage(Alert(ecosystem, package, version, adv,
                                         dev_scope=dev_scope.get(key, False))))
    return out
