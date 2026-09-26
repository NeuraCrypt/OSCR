"""The links carried by METADATA: Crossref and DataCite, without reading the paper.

**Why they matter.** For a paper without an open full text — most of the older
literature — the text will say nothing. But the publisher often deposits the
list of REFERENCES with Crossref, and eLife even types its software there
(`"type": "software"`, author, title, Software Heritage archive). Measured
2026-09-25: for eLife 10.7554/elife.100605, the authors' two code repositories
and their dataset are there, with the author's name.

DataCite says the reverse: which software or dataset DECLARES itself related
to the paper (`relatedIdentifiers`). Precise when the author declared it,
silent otherwise — out of 3 papers with code on Zenodo, a single declaration,
and it was a dataset.

Both return `Mention`s like the text does: the same judge (`role.py`) decides
them, with the location `references` or `metadata`.
"""
from __future__ import annotations

import json
import re

from ..jats import Mention
from ..net import Client

CROSSREF = "https://api.crossref.org/works/"
DATACITE = "https://api.datacite.org/dois"

#: What, in a reference, gives away a code or data repository.
_CUES = re.compile(r"zenodo|github|gitlab|bitbucket|osf\.io|figshare|softwareheritage"
                   r"|swh:1:|codeocean|openneuro|dryad|10\.5281|10\.17605|10\.6084"
                   r"|10\.24433|10\.18112|modeldb|gin\.g-node", re.I)

#: The Crossref relations that designate material belonging to the paper itself.
_OWN_RELATIONS = ("is-supplemented-by", "has-related-material", "is-derived-from",
                  "requires", "is-documented-by")


def crossref(client: Client, doi: str) -> dict:
    r = client.get(CROSSREF + doi, ttl_s=30 * 86400)
    if not r.ok:
        return {}
    return (r.json() or {}).get("message", {})


def crossref_authors(message: dict) -> list[str]:
    return [a["family"] for a in message.get("author", []) if a.get("family")]


def crossref_mentions(message: dict) -> list[Mention]:
    """The Crossref references and relations that point to a repository."""
    mentions: list[Mention] = []
    for rel, targets in (message.get("relation") or {}).items():
        for t in targets:
            ident = t.get("id", "")
            if not ident or t.get("id-type") not in ("doi", "uri", "url"):
                continue
            url = ident if t.get("id-type") != "doi" else f"https://doi.org/{ident}"
            own = rel in _OWN_RELATIONS
            mentions.append(Mention(url, f"Crossref relation '{rel}'", ("Crossref",),
                                    "metadata", f"crossref:{rel}" + (":own" if own else "")))
    for ref in message.get("reference") or []:
        raw = json.dumps(ref, ensure_ascii=False)
        if not _CUES.search(raw):
            continue
        text = ref.get("unstructured") or " ".join(
            str(ref.get(k, "")) for k in ("author", "year", "article-title", "volume-title"))
        if ref.get("type"):
            text += f" [{ref['type']}]"
        urls = []
        if ref.get("DOI"):
            urls.append(f"https://doi.org/{ref['DOI']}")
        urls += re.findall(r"https?://[^\s\"<>]+|swh:1:\w{3}:[0-9a-f]{40}[^\s\"<>]*", text)
        authors = tuple(a for a in [ref.get("author", "")] if a)
        for u in dict.fromkeys(urls):
            mentions.append(Mention(u, text[:600], ("References (Crossref)",), "references",
                                    "crossref:reference", ref_authors=authors,
                                    ref_year=str(ref.get("year", ""))))
    return mentions


def datacite_mentions(client: Client, doi: str) -> list[Mention]:
    """The DataCite objects (software, datasets) that declare the paper."""
    r = client.get(DATACITE, params={
        "query": f'relatedIdentifiers.relatedIdentifier:"{doi}"', "page[size]": "25"},
        ttl_s=7 * 86400)
    if not r.ok:
        return []
    mentions = []
    for x in (r.json() or {}).get("data", []):
        a = x.get("attributes", {})
        kind = (a.get("types") or {}).get("resourceTypeGeneral", "")
        if kind not in ("Software", "Dataset", "ComputationalNotebook", "Workflow", "Model"):
            continue
        title = ((a.get("titles") or [{}])[0]).get("title", "")
        rel = next((ri.get("relationType", "") for ri in a.get("relatedIdentifiers", [])
                    if doi.lower() in str(ri.get("relatedIdentifier", "")).lower()), "")
        sentence = f"DataCite: {kind} '{title[:120]}' ({rel} the paper)"
        mentions.append(Mention(f"https://doi.org/{x['id']}", sentence, ("DataCite",),
                                "metadata", f"datacite:{kind}:own"))
        # Archived software often names the GitHub repository it comes from.
        for ri in a.get("relatedIdentifiers", []):
            target = str(ri.get("relatedIdentifier", ""))
            if re.search(r"github\.com|gitlab\.com", target, re.I):
                mentions.append(Mention(target, sentence + f" — source {ri.get('relationType', '')}",
                                        ("DataCite",), "metadata", f"datacite:{kind}:own"))
    return mentions
