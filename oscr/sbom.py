"""SBOM export (SPDX) and licence compatibility (night phase 11, E6; docs/SECURITY_QUALITY.md).

A **Software Bill of Materials** lists what a piece of software is made of. OSCR builds an **SPDX**
one (the ISO standard, SPDX 2.3) from the dependency graph it computed (oscr/depgraph.py), in two
shapes: a JSON document and the tag-value text. It is computed on the Mac, from facts already read; no
code runs.

**Licence compatibility**: whether a dependency's licence lets its code be used inside a repository
under the repository's own licence. OSCR knows a small compatibility table for the common open
licences (permissive, weak and strong copyleft, the Creative Commons ones, public domain), and applies
a **licence policy** (an allow list and a deny list the owner may set). A clash (for example GPL code
pulled into a permissive repository, or a denied licence) is said in words, never as a blocking error:
the registry informs, the authors decide.

Dependency licences are not fetched from package registries tonight (no network); a dependency whose
licence the manifests do not state is ``NOASSERTION`` in the SBOM and "unknown" in the summary.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import depgraph

SPDX_VERSION = "SPDX-2.3"
DATA_LICENSE = "CC0-1.0"

# The ecosystem's SPDX "purl" type and how a package reference reads.
PURL_TYPE = {"PyPI": "pypi", "npm": "npm", "CRAN": "cran", "Julia": "julia", "conda": "conda", "Actions": "github"}


# ---------------------------------------------------------------------------
# Licence compatibility.

#: Licence families, for the compatibility rule.
PERMISSIVE = {"MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "Zlib", "Unlicense", "0BSD", "PSF-2.0"}
PUBLIC_DOMAIN = {"CC0-1.0", "Unlicense", "0BSD"}
WEAK_COPYLEFT = {"LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "MPL-2.0", "EPL-2.0"}
STRONG_COPYLEFT = {"GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later"}
CREATIVE = {"CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC0-1.0"}

#: Normalise the common short spellings to SPDX ids.
_ALIASES = {
    "mit": "MIT", "apache2": "Apache-2.0", "apache-2": "Apache-2.0", "apache 2.0": "Apache-2.0",
    "bsd": "BSD-3-Clause", "bsd-3": "BSD-3-Clause", "bsd3": "BSD-3-Clause", "bsd-2": "BSD-2-Clause",
    "gpl2": "GPL-2.0-only", "gplv2": "GPL-2.0-only", "gpl-2.0": "GPL-2.0-only",
    "gpl3": "GPL-3.0-only", "gplv3": "GPL-3.0-only", "gpl-3.0": "GPL-3.0-only", "gpl": "GPL-3.0-only",
    "lgpl": "LGPL-3.0-only", "agpl": "AGPL-3.0-only", "agpl3": "AGPL-3.0-only",
    "mpl": "MPL-2.0", "mpl2": "MPL-2.0", "cc0": "CC0-1.0", "cc-by": "CC-BY-4.0", "public domain": "CC0-1.0",
}


def normalise_licence(text: str) -> str:
    """A declared licence into an SPDX id when it is one the registry knows, else the text trimmed
    (or '' / 'NOASSERTION')."""
    if not text:
        return ""
    t = text.strip()
    if t.upper() == "NOASSERTION":
        return "NOASSERTION"
    # Already an SPDX id the tables list.
    for group in (PERMISSIVE, WEAK_COPYLEFT, STRONG_COPYLEFT, CREATIVE, PUBLIC_DOMAIN):
        if t in group:
            return t
    key = re.sub(r"\s+", " ", t.lower()).strip().rstrip(".")
    return _ALIASES.get(key, t)


def _family(spdx: str) -> str:
    if spdx in STRONG_COPYLEFT:
        return "strong"
    if spdx in WEAK_COPYLEFT:
        return "weak"
    if spdx in PERMISSIVE or spdx in PUBLIC_DOMAIN:
        return "permissive"
    if spdx in CREATIVE:
        return "creative"
    return "unknown"


def compatible(repo_licence: str, dep_licence: str) -> bool | None:
    """Whether code under ``dep_licence`` may be used inside a repository under ``repo_licence``.
    None when either licence is unknown (a verdict is never guessed). The rule, in plain terms:

    - permissive and public-domain code goes anywhere;
    - weak copyleft (LGPL, MPL) is fine in anything that is not more permissive than it demands; the
      registry treats it as compatible with copyleft repositories and flags it for a permissive one;
    - strong copyleft (GPL, AGPL) is compatible only with a copyleft repository of the same strength
      or stronger.
    """
    r, d = normalise_licence(repo_licence), normalise_licence(dep_licence)
    if not r or r == "NOASSERTION" or not d or d == "NOASSERTION":
        return None
    df, rf = _family(d), _family(r)
    if df == "unknown" or rf == "unknown":
        return None
    if df in ("permissive",):
        return True
    if df == "weak":
        return rf in ("weak", "strong", "creative") or r in STRONG_COPYLEFT or r in WEAK_COPYLEFT
    if df == "strong":
        gpl3 = {"GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later"}
        gpl2 = {"GPL-2.0-only", "GPL-2.0-or-later"}
        # A strong-copyleft dependency fits only a repository under a compatible strong licence.
        if d in {"AGPL-3.0-only", "AGPL-3.0-or-later"}:
            return r in {"AGPL-3.0-only", "AGPL-3.0-or-later"}
        if d in {"GPL-3.0-only", "GPL-3.0-or-later"}:
            return r in gpl3
        if d == "GPL-2.0-or-later":
            return r in gpl2 or r in gpl3
        if d == "GPL-2.0-only":
            return r in gpl2
        return r in STRONG_COPYLEFT
    if df == "creative":
        return rf == "creative"
    return None


@dataclass
class Policy:
    """The owner's (or an organization's) licence policy: an allow list (only these pass) and a deny
    list (these never pass). Empty allow list: every licence is allowed unless denied."""
    allow: frozenset[str] = frozenset()
    deny: frozenset[str] = frozenset()

    def verdict(self, spdx: str) -> str:
        s = normalise_licence(spdx)
        if s in self.deny:
            return "denied"
        if self.allow and s not in self.allow:
            return "not_allowed"
        return "allowed"


def licence_summary(repo_licence: str, deps: list[tuple[str, str]], policy: Policy | None = None) -> dict:
    """A summary over the dependencies whose licence is known: how many are compatible with the
    repository's licence, how many clash, how many the policy denies, how many are unknown.

    ``deps`` is a list of (name, declared licence)."""
    policy = policy or Policy()
    compatible_n = clash = denied = unknown = 0
    clashes: list[dict] = []
    for name, lic in deps:
        verdict = compatible(repo_licence, lic)
        pol = policy.verdict(lic) if normalise_licence(lic) not in ("", "NOASSERTION") else "allowed"
        if pol != "allowed":
            denied += 1
            clashes.append({"name": name, "licence": normalise_licence(lic), "why": pol})
        elif verdict is None:
            unknown += 1
        elif verdict:
            compatible_n += 1
        else:
            clash += 1
            clashes.append({"name": name, "licence": normalise_licence(lic), "why": "incompatible"})
    return {
        "repo_licence": normalise_licence(repo_licence),
        "known": compatible_n + clash + denied,
        "compatible": compatible_n, "incompatible": clash, "denied": denied, "unknown": unknown,
        "clashes": clashes[:50],
    }


# ---------------------------------------------------------------------------
# SPDX.

def _spdx_id(prefix: str, name: str) -> str:
    return "SPDXRef-" + prefix + "-" + re.sub(r"[^A-Za-z0-9.-]+", "-", name).strip("-")


def spdx_document(name: str, namespace: str, nodes: list[depgraph.Node], *,
                  repo_licence: str = "", created: str = "2026-10-05T00:00:00Z") -> dict:
    """An SPDX 2.3 JSON document: the repository as the root package, one package per dependency,
    with a purl external reference and the version when a lock file pinned it. A licence not stated
    is NOASSERTION (never invented)."""
    root_id = _spdx_id("Package", name or "repository")
    packages = [{
        "SPDXID": root_id,
        "name": name or "repository",
        "downloadLocation": "NOASSERTION",
        "licenseConcluded": normalise_licence(repo_licence) or "NOASSERTION",
        "licenseDeclared": normalise_licence(repo_licence) or "NOASSERTION",
        "copyrightText": "NOASSERTION",
    }]
    relationships = [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": root_id}]
    seen: set[str] = set()
    for n in nodes:
        sid = _spdx_id("Package", f"{n.ecosystem}-{n.name}-{n.version or 'x'}")
        if sid in seen:
            continue
        seen.add(sid)
        pkg = {
            "SPDXID": sid,
            "name": n.name,
            "versionInfo": n.version or "NOASSERTION",
            "downloadLocation": "NOASSERTION",
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
        }
        purl = PURL_TYPE.get(n.ecosystem)
        if purl:
            ref = f"pkg:{purl}/{n.name}" + (f"@{n.version}" if n.version else "")
            pkg["externalRefs"] = [{"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl", "referenceLocator": ref}]
        packages.append(pkg)
        relationships.append({"spdxElementId": root_id, "relationshipType": "DEPENDS_ON", "relatedSpdxElement": sid})
    return {
        "spdxVersion": SPDX_VERSION,
        "dataLicense": DATA_LICENSE,
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": name or "repository",
        "documentNamespace": namespace,
        "creationInfo": {"created": created, "creators": ["Tool: oscr-security"]},
        "packages": packages,
        "relationships": relationships,
    }


def spdx_tag_value(doc: dict) -> str:
    """The tag-value serialisation of an SPDX document (the other standard shape)."""
    lines = [
        f"SPDXVersion: {doc['spdxVersion']}",
        f"DataLicense: {doc['dataLicense']}",
        f"SPDXID: {doc['SPDXID']}",
        f"DocumentName: {doc['name']}",
        f"DocumentNamespace: {doc['documentNamespace']}",
        f"Creator: {doc['creationInfo']['creators'][0]}",
        f"Created: {doc['creationInfo']['created']}",
        "",
    ]
    for p in doc["packages"]:
        lines.append(f"PackageName: {p['name']}")
        lines.append(f"SPDXID: {p['SPDXID']}")
        if p.get("versionInfo"):
            lines.append(f"PackageVersion: {p['versionInfo']}")
        lines.append(f"PackageDownloadLocation: {p['downloadLocation']}")
        lines.append(f"PackageLicenseConcluded: {p['licenseConcluded']}")
        lines.append(f"PackageLicenseDeclared: {p['licenseDeclared']}")
        for ref in p.get("externalRefs", []):
            lines.append(f"ExternalRef: {ref['referenceCategory']} {ref['referenceType']} {ref['referenceLocator']}")
        lines.append("")
    for rel in doc["relationships"]:
        lines.append(f"Relationship: {rel['spdxElementId']} {rel['relationshipType']} {rel['relatedSpdxElement']}")
    return "\n".join(lines) + "\n"


def to_json(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=1)
