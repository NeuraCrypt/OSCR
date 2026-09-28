"""The full page of a paper (Phase 4): what its sections show beyond `catalog.json`.

`generate` writes `papers/NN.json` into the public export, next to `alignments/NN.json`: one
lot in `catalog.N_LOTS`, keyed by paper id, for the papers with a page only (the owner's
decisions D2 and D7). The website reads the lots when it is built: they add no file to the
site. A paper's entry holds its sections:

- `overview`: the bibliographic record — type, language, volume, issue, pages, dates,
  license, the authors in order with their affiliations, keywords, MeSH, journal subjects,
  funding, citation count, references, RRIDs, integrity notices — and the abstract, **only
  under an open license** (D1's rule: `catalog.statement_is_publishable`);
- `code`: each code repository's commit date, sizes, features (README, CITATION.cff,
  environment files, tests, CI, notebooks), tools, and the history of its availability
  checks (the last MAX_CHECKS);
- `availability`: the code and data availability statements in full under an open
  license; under any other, only facts — which kinds of statement, what they point to,
  "on request" — and never a quotation;
- `data`: the data links, with the dataset each one names and where it was found;
- `map`: the tracing map — what it holds, whether an author validated it (ORCID), and once
  deposited, its DOI and its JSON on Zenodo; and its digest (`zenodo.map_digest`), which a
  verified author's validation carries back (Phase 6: the Mac deposits the map the page showed);
- `versions`: the history of the record as a diff of public facts. Only VERSION_FIELDS
  leave: the digests of texts (abstract, statements), the classification's raw values and
  any field added later stay on the Mac. A version made by a person's correction (Phase 6)
  says so, by their role only (`by`: author, maintainer, submitter), never who;
- `cite`: the paper's citation in BibTeX, RIS, an APA-like text and CSL-JSON, and its
  map's once it has a DOI. The platform, a creator of the map, is written PLATFORM: the
  website puts its name (`SITE_NAME`) there;
- `similar`: up to MAX_SIMILAR papers with a page, ranked by the tools, categories,
  datasets, cited references and authors they share, with the reasons in words.

**No email address, and no other contact detail.** Every string goes through
`entities.scrub`, and each lot is checked once more before it is written.
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import catalog, enrich, entities, zenodo

#: The last availability checks of a repository shown on the page.
MAX_CHECKS: int = 20
#: Similar papers per page.
MAX_SIMILAR: int = 10
#: A feature shared by more papers than this (a category like "human") is too common to
#: find candidates with; it still counts in the score of the candidates found otherwise.
MAX_POSTING: int = 300
#: The candidates of a paper scored in full: those that the rarer features found first.
MAX_CANDIDATES: int = 200
#: What sharing one feature of each kind weighs, before its rarity (idf).
WEIGHTS: dict[str, float] = {"author": 3.0, "dataset": 3.0, "tool": 2.0, "reference": 1.0, "category": 1.0}
#: Below this score, two papers are not called similar.
MIN_SCORE: float = 2.0
#: A feature more than this share of the papers have (a category like "human") explains
#: nothing: it counts, a little, but it is not named in the reasons nor used to find
#: candidates.
COMMON: float = 0.5
#: The items of one list shown for one version (the rest is counted).
MAX_ITEMS: int = 30
#: The facts of a record's versions that leave, and the keys of those that are objects.
#: Everything else in a snapshot stays on the Mac: the digests of the abstract and of the
#: availability statements, the classification's raw values (`categories`, including
#: `on_topic`), and any field a later version of the enrichment adds.
VERSION_FIELDS: tuple[str, ...] = ("type", "language", "journal", "volume", "issue", "pages", "dates", "authors",
                                   "keywords", "mesh", "funding", "references", "rrids", "integrity", "code", "data")
#: Facts the versions record since a later phase (the links' keys, Phase 6): a version is not
#: said to change them when the one before did not record them yet.
LATER_FIELDS: frozenset[str] = frozenset({"code", "data"})
#: Who made a version, from its actor: the harvester, or a person's correction by their role
#: (oscr/jobs.py writes "author:orcid:…", "maintainer:github:…", "submitter:…"; never shown).
BY_ROLE: dict[str, str] = {"author": "author", "maintainer": "maintainer", "submitter": "submitter"}
VERSION_KEYS: dict[str, tuple[str, ...]] = {
    "journal": ("title", "issn", "eissn", "publisher", "nlm_ta"),
    "dates": ("received", "accepted", "epub", "ppub", "collection", "first_publication"),
}
#: The name of the platform in the map's citation, filled in by the website (SITE_NAME).
PLATFORM: str = "{platform}"
#: An RRID's name comes from the paper's text: shown only when it is a short label.
MAX_RRID_NAME: int = 40

_NOTICE_SOURCES = {"retraction-watch": "Retraction Watch", "epmc": "Europe PMC", "med": "Europe PMC",
                   "pmc": "Europe PMC"}
_AVAILABILITY = "text:availability"


# ---------------------------------------------------------------------------------------
# Small helpers.

def _clean(value: Any) -> str:
    """A one-line string, without contact details."""
    return re.sub(r"\s+", " ", entities.strip_contacts(str(value or ""))).strip()


def _text_block(value: str) -> str:
    """A text of several paragraphs (an abstract, a statement): blank lines between the
    paragraphs, single spaces inside them."""
    paragraphs = [re.sub(r"[ \t\r\f\v]*\n[ \t\r\f\v]*", " ", p) for p in re.split(r"\n\s*\n", value or "")]
    return "\n\n".join(re.sub(r"\s+", " ", p).strip() for p in paragraphs if p.strip())


def _url(value: str) -> str:
    """A web address, or an identifier made into one (a bare DOI); "" otherwise."""
    value = (value or "").strip()
    if re.match(r"https?://", value, re.IGNORECASE):
        return value
    if re.match(r"10\.\d{3,9}/\S+$", value):
        return f"https://doi.org/{value}"
    return ""


def _people_name(r: sqlite3.Row) -> str:
    return _clean(r["name"] or " ".join(x for x in (r["given"], r["family"]) if x))


# ---------------------------------------------------------------------------------------
# Overview.

def _notice_url(notice_id: str) -> str:
    """Where a notice can be read: its DOI, else its Europe PMC record (a PubMed id, a PMCID)."""
    nid = notice_id.strip()
    if re.fullmatch(r"10\.\d{3,9}/\S+", nid):
        return f"https://doi.org/{nid}"
    if re.fullmatch(r"\d{1,9}", nid):
        return f"https://europepmc.org/article/MED/{nid}"
    if re.fullmatch(r"PMC\d+", nid, re.IGNORECASE):
        return f"https://europepmc.org/article/PMC/{nid.upper()}"
    return ""


def _notices(rows: list[sqlite3.Row]) -> list[dict[str, str]]:
    """Retractions, corrections, expressions of concern, reinstatements and comments: the
    kind, the notice and its date, from Retraction Watch or Europe PMC. Retraction Watch's
    reasons stay on the Mac: the notice itself is the evidence."""
    order = {"retraction": 0, "concern": 1, "correction": 2, "reinstatement": 3, "comment": 4}
    out = []
    for r in sorted(rows, key=lambda r: (order.get(r["kind"], 9), r["date"] or "", r["notice_id"])):
        nid = _clean(r["notice_id"])
        out.append({"kind": r["kind"], "id": "" if nid.startswith("rw:") else nid, "date": r["date"] or "",
                    "source": _NOTICE_SOURCES.get((r["source"] or "").lower(), r["source"] or ""),
                    "url": _notice_url(nid)})
    return out


def _funding(rows: list[sqlite3.Row], names: dict[str, str]) -> list[dict[str, Any]]:
    """Grants by funder, in the order the funders first appear."""
    by: dict[str, list[str]] = {}
    for r in rows:
        awards = by.setdefault(r["funder_id"], [])
        award = _clean(r["award"])
        if award and award not in awards:
            awards.append(award)
    out = []
    for fid, awards in by.items():
        name = _clean(names.get(fid) or (fid[5:] if fid.startswith("name:") else fid))
        # A Crossref Funder Registry DOI or a ROR id makes a link; a name alone does not.
        link = (f"https://doi.org/{fid}" if fid.startswith("10.13039/") else
                f"https://ror.org/{fid}" if entities.ror(fid) else "")
        if name:
            out.append({"funder": name, "url": link, "awards": awards})
    return out


def _overview(r: sqlite3.Row, authors: list[sqlite3.Row], grants: list[sqlite3.Row], funders: dict[str, str],
              subjects: list[sqlite3.Row], rrids: list[sqlite3.Row], notices: list[sqlite3.Row]) -> dict[str, Any]:
    license_ = (r["license"] or "").strip()
    open_ = catalog.statement_is_publishable(license_)
    affiliations: list[dict[str, str]] = []
    number: dict[str, int] = {}
    people = []
    for a in authors:
        name, oid = _people_name(a), entities.orcid(a["orcid"])
        if not name and not oid:
            continue
        places = entities._strings(a["affiliations"])
        rors = [x for x in (entities.ror(entities._text(v, "id", "ror")) for v in entities._json_list(a["ror"])) if x]
        numbers = []
        for i, place in enumerate(places):
            ror = rors[i] if len(rors) == len(places) else ""
            if place not in number:
                number[place] = len(affiliations) + 1
                affiliations.append({"name": place, "ror": ror})
            elif ror and not affiliations[number[place] - 1]["ror"]:
                affiliations[number[place] - 1]["ror"] = ror
            numbers.append(number[place])
        people.append({"name": name or oid, "orcid": oid, "affiliations": numbers})
    by_scheme: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for s in subjects:
        by_scheme[s["scheme"]].append(s)
    return {
        "type": r["type"] or "", "language": r["language"] or "",
        "volume": _clean(r["volume"]), "issue": _clean(r["issue"]), "pages": _clean(r["pages"]),
        "dates": {"received": r["received"] or "", "accepted": r["accepted"] or "",
                  "online": r["published_online"] or "", "print": r["published_print"] or ""},
        "pmid": r["pmid"] or "",
        "license": license_, "open": open_,
        "has_abstract": bool((r["abstract"] or "").strip()),
        # D1's rule for the abstract too: it is article text.
        "abstract": _text_block(entities.strip_contacts(r["abstract"] or "")) if open_ else "",
        "authors": people, "affiliations": affiliations,
        "keywords": [_clean(s["term"]) for s in by_scheme["keyword"]],
        "mesh": [{"term": _clean(s["term"]), "major": bool(s["major"])}
                 for s in sorted(by_scheme["mesh"], key=lambda s: (not s["major"], s["term"].casefold()))],
        "subjects": [_clean(s["term"]) for s in by_scheme["subject"]],
        "funding": _funding(grants, funders),
        "cited_by": r["cited_by_count"], "references": r["references_count"],
        "rrids": [{"rrid": x["rrid"], "kind": x["kind"] or "",
                   "name": _clean(x["name"]) if len(_clean(x["name"])) <= MAX_RRID_NAME else ""}
                  for x in sorted(rrids, key=lambda x: x["rrid"]) if re.fullmatch(r"RRID:[A-Za-z]+_\S+", x["rrid"])],
        "notices": _notices(notices),
    }


# ---------------------------------------------------------------------------------------
# Code, availability, data.

def _features(f: sqlite3.Row | None) -> dict[str, Any] | None:
    if f is None:
        return None
    flag = lambda v: None if v is None else bool(v)  # noqa: E731
    return {"readme": flag(f["has_readme"]), "citation_cff": flag(f["has_citation_cff"]),
            "license_file": flag(f["has_license_file"]),
            "env_files": [_clean(e) for e in entities._json_list(f["env_files"]) if isinstance(e, str)][:12],
            "tests": flag(f["has_tests"]), "ci": flag(f["has_ci"]), "docs": flag(f["has_docs"]),
            "notebooks": f["n_notebooks"]}


def _repository(d: sqlite3.Row | None, feature: sqlite3.Row | None, tools: list[sqlite3.Row],
                checks: list[sqlite3.Row], scripts: int) -> dict[str, Any]:
    """What the Code section adds to catalog.json's entry of a repository. The text of a
    failed check (a forge's error page, git's messages) stays on the Mac: the state and the
    HTTP status say it."""
    return {
        "commit_date": (d["commit_date"] if d is not None else "") or "",
        "readme": _readme(d),
        "files": d["n_files"] if d is not None else None,
        "scripts_listed": scripts,
        "created": (d["created"] if d is not None else "") or "",
        "verified_on": entities._day(d["verified_at"]) if d is not None else "",
        "features": _features(feature),
        "tools": [{"id": t["tool_id"], "files": t["evidence"] or 0, "via": t["via"] or ""}
                  for t in sorted(tools, key=lambda t: (-(t["evidence"] or 0), t["tool_id"]))],
        "checks": [{"on": entities._day(c["checked_at"]), "state": c["state"], "http": c["http_status"]}
                   for c in sorted(checks, key=lambda c: -c["checked_at"])[:MAX_CHECKS]],
    }


_README = re.compile(r"(?i)^readme(\.[\w-]+)?$")


def _readme(d: sqlite3.Row | None) -> str:
    """The path of a repository's README at its root, from its file list ("README.md"): where
    the badge of a verified author goes (Phase 6). "" when there is none, or no list."""
    if d is None:
        return ""
    names = [f for f in entities._json_list(d["files"]) if isinstance(f, str) and "/" not in f and _README.match(f)]
    return sorted(names, key=lambda f: (not f.lower().endswith(".md"), f))[0] if names else ""


def _paragraphs(text: str) -> set[str]:
    return {re.sub(r"\s+", " ", p).strip().casefold() for p in re.split(r"\n\s*\n", text or "") if p.strip()}


def _statements(rows: list[sqlite3.Row]) -> list[sqlite3.Row]:
    """The statements worth showing: a code or a data statement first; a text another one
    already holds, or a "code and data" statement made of theirs, is left out."""
    kept: list[sqlite3.Row] = []
    for s in sorted(rows, key=lambda s: (s["kind"] == "code_and_data", -len(s["text"] or ""), s["title"])):
        text = re.sub(r"\s+", " ", s["text"] or "").strip().casefold()
        if not text:
            continue
        if any(text in re.sub(r"\s+", " ", k["text"]).strip().casefold() for k in kept):
            continue
        covered = set().union(*(_paragraphs(k["text"]) for k in kept)) if kept else set()
        if s["kind"] == "code_and_data" and _paragraphs(s["text"]) <= covered:
            continue
        kept.append(s)
    return sorted(kept, key=lambda s: ({"code": 0, "data": 1}.get(s["kind"], 2), s["title"]))


def _title(title: str) -> str:
    """A statement's heading as the paper wrote it, without its decorative capitals
    ("DATA AVAILABILITY" → "Data availability") nor its final colon."""
    t = _clean(title).rstrip(" :.")
    return t[:1] + t[1:].lower() if t.isupper() else t


def _availability(r: sqlite3.Row, statements: list[sqlite3.Row], links: list[sqlite3.Row]) -> dict[str, Any]:
    """D1: the statements' text only under an open license; otherwise the facts about them."""
    open_ = catalog.statement_is_publishable(r["license"] or "")
    kept = _statements(statements)
    said = [link for link in links if link["found_by"] == _AVAILABILITY]
    data: list[dict[str, str]] = []
    for link in said:
        if link["role"] != "data":
            continue
        ident = enrich.dataset_id(link["repo"], link["url"] or "")
        key = ident[0] if ident else link["repo"]
        named = {"dataset": ident[0] if ident else "", "repository": enrich.data_repository(key)}
        if named not in data:
            data.append(named)
    return {
        "open": open_,
        "statements": [{"kind": s["kind"], "title": _title(s["title"]),
                        "text": _text_block(entities.strip_contacts(s["text"]))} if open_ else {"kind": s["kind"]}
                       for s in kept],
        "on_request": {"code": bool(r["code_on_request"]), "data": bool(r["data_on_request"])},
        "points_to": {"code": sorted({link["repo"] for link in said if link["role"] == "code"}), "data": data},
    }


def _heading(section: str, most: int = 48) -> str:
    """A section's heading cut at a word, as catalog._where shows at most `most` characters
    of it: "Registration between CA3 μCT volume and the…", not "…and the Alle"."""
    section = _clean(section)
    if len(section) <= most:
        return section
    return section[:most - 1].rsplit(" ", 1)[0].rstrip(" ,;:.-–—") + "…"


def _data_links(links: list[sqlite3.Row]) -> list[dict[str, str]]:
    out = []
    for link in sorted(links, key=lambda x: x["repo"]):
        if link["role"] != "data":
            continue
        ident = enrich.dataset_id(link["repo"], link["url"] or "")
        url = _url(link["url"]) or (f"https://doi.org/{link['repo'][4:]}" if link["repo"].startswith("doi:") else "")
        out.append({"repo": link["repo"], "url": url, "dataset": ident[0] if ident else "",
                    "repository": enrich.data_repository(ident[0] if ident else link["repo"]),
                    "where": catalog._where(link["found_by"], _heading(link["section"]))})
    return out


# ---------------------------------------------------------------------------------------
# The tracing map.

def _map(article: dict[str, Any], validations: list[sqlite3.Row], deposit: sqlite3.Row | None,
         files: int, pairs: int, method: str, digest: str = "") -> dict[str, Any]:
    """What the map holds, and where it stands: proposed by the harvester, or validated by
    an author with their ORCID (the only proof that leaves, as in catalog.json) and, once
    deposited on Zenodo (never the sandbox), its DOI and its JSON. `digest`: the map's
    (zenodo.map_digest), which a validation from the page carries back."""
    record = str(deposit["record_id"]) if deposit is not None else ""
    return {
        "status": "validated" if validations else "proposed" if article["code"] else "none",
        "repositories": len(article["code"]), "files": files, "pairs": pairs, "method": method,
        "digest": digest,
        "validated_by": [{"name": _clean(v["name"]), "orcid": entities.orcid(v["orcid"]),
                          "on": entities._day(v["validated_at"])} for v in validations],
        "doi": (deposit["doi"] if deposit is not None else "") or "",
        "concept_doi": (deposit["concept_doi"] if deposit is not None else "") or "",
        "deposited_on": entities._day(deposit["deposited_at"]) if deposit is not None else "",
        "record_url": f"https://zenodo.org/records/{record}" if record.isdigit() else "",
        "json_url": f"https://zenodo.org/records/{record}/files/{zenodo.MAP_FILE}?download=1" if record.isdigit() else "",
    }


# ---------------------------------------------------------------------------------------
# Versions: a readable diff of public facts.

def _item(field: str, value: Any) -> str:
    """One element of a list field, in words."""
    if field == "authors" and isinstance(value, (list, tuple)) and value:
        name, oid = _clean(value[0]), entities.orcid(str(value[1] or "")) if len(value) > 1 else ""
        return f"{name} ({oid})" if name and oid else name or oid
    if field == "funding" and isinstance(value, (list, tuple)) and value:
        awards = [_clean(x) for x in (value[1] if len(value) > 1 and isinstance(value[1], list) else []) if x]
        return f"{_clean(value[0])}: {', '.join(awards)}" if awards else _clean(value[0])
    if field == "integrity" and isinstance(value, (list, tuple)):
        return " ".join(_clean(x) for x in value if x)
    if isinstance(value, dict):
        return _clean(value.get("name") or value.get("term") or "")
    return _clean(value)[:200]


def _scalar(value: Any) -> Any:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else _clean(value)


def _changes(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for field in VERSION_FIELDS:
        if field in LATER_FIELDS and before and field not in before:
            continue          # recorded for the first time: not a change of the record
        b, a = before.get(field), after.get(field)
        if field in VERSION_KEYS:
            b, a = (b if isinstance(b, dict) else {}), (a if isinstance(a, dict) else {})
            for key in VERSION_KEYS[field]:
                bv, av = _clean(b.get(key)), _clean(a.get(key))
                if bv != av:
                    changes.append({"field": f"{field}.{key}", "before": bv, "after": av})
        elif isinstance(a, list) or isinstance(b, list):
            bi = [x for x in (_item(field, v) for v in (b if isinstance(b, list) else [])) if x]
            ai = [x for x in (_item(field, v) for v in (a if isinstance(a, list) else [])) if x]
            added = [x for x in ai if x not in set(bi)]
            removed = [x for x in bi if x not in set(ai)]
            if added or removed:
                changes.append({"field": field, "added": added[:MAX_ITEMS], "removed": removed[:MAX_ITEMS],
                                "n_added": len(added), "n_removed": len(removed)})
            elif ai != bi:
                changes.append({"field": field, "reordered": True})
        elif _scalar(b) != _scalar(a) and (b not in (None, "") or a not in (None, "")):
            changes.append({"field": field, "before": _scalar(b) if b is not None else "",
                            "after": _scalar(a) if a is not None else ""})
    return changes


def history(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    """The versions of a record, newest first, each with what changed in its PUBLIC facts.
    A version that changed nothing public (a text, the classification) is not listed, and
    the texts' digests never leave. The snapshots are compared as JSON, so a version the
    harvester stored with no real change (lists read back as lists, not tuples) has none."""
    out: list[dict[str, Any]] = []
    before: dict[str, Any] = {}
    for i, r in enumerate(sorted(rows, key=lambda r: r["version"])):
        try:
            snapshot = json.loads(r["snapshot"] or "{}")
        except ValueError:
            continue
        if not isinstance(snapshot, dict):
            continue
        public = {k: snapshot[k] for k in VERSION_FIELDS if k in snapshot}
        changes = _changes(before, public)
        if changes:
            actor = str(r["actor"] or "harvester")
            by = "harvester" if actor == "harvester" else BY_ROLE.get(actor.split(":", 1)[0], "editor")
            out.append({"version": r["version"], "date": entities._day(r["created_at"]), "by": by,
                        "first": i == 0, "changes": changes})
        before = public
    return out[::-1]


# ---------------------------------------------------------------------------------------
# Citations.

_STOP = frozenset("a an and are as at by for from in is of on or the to with".split())
_BIBTEX = str.maketrans({"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "&": r"\&", "%": r"\%", "$": r"\$",
                         "#": r"\#", "_": r"\_", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"})
_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")


def _ascii(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def _bib(s: str) -> str:
    return (s or "").translate(_BIBTEX)


def _date_parts(day: str) -> list[int]:
    """"2026-09-07" → [2026, 9, 7]; a month or a year alone gives fewer parts."""
    m = re.match(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", day or "")
    return [int(x) for x in m.groups() if x] if m else []


def _initials(given: str) -> str:
    """"Justin D" → "J. D."; "Jean-Pierre" → "J.-P."."""
    out = []
    for word in given.split():
        parts = [p for p in word.split("-") if p]
        if parts:
            out.append("-".join(f"{p[0]}." for p in parts))
    return " ".join(out)


def _creators(rows: list[sqlite3.Row], names: list[str]) -> list[dict[str, str]]:
    """The authors for a citation: family and given names when the record has them, the
    name as written otherwise (a consortium, a paper not enriched yet)."""
    out = []
    for r in rows:
        family, given = _clean(r["family"]), _clean(r["given"])
        if family:
            out.append({"family": family, "given": given} if given else {"family": family})
        elif _people_name(r):
            out.append({"literal": _people_name(r)})
    if not out:
        out = [{"literal": n} for n in (_clean(x) for x in names) if n]
    return out


def _bib_name(p: dict[str, str]) -> str:
    if "literal" in p:
        return "{" + _bib(p["literal"]) + "}"
    return f"{_bib(p['family'])}, {_bib(p['given'])}" if p.get("given") else _bib(p["family"])


def _apa_name(p: dict[str, str]) -> str:
    if "literal" in p:
        return p["literal"]
    initials = _initials(p.get("given", ""))
    return f"{p['family']}, {initials}" if initials else p["family"]


def _apa_authors(names: list[str]) -> str:
    """APA 7: up to 20 authors, then the first 19, an ellipsis and the last."""
    if len(names) <= 1:
        return "".join(names)
    if len(names) <= 20:
        return ", ".join(names[:-1]) + ", & " + names[-1]
    return ", ".join(names[:19]) + ", . . . " + names[-1]


def _key(people: list[dict[str, str]], year: str, title: str) -> str:
    first = people[0] if people else {}
    family = re.sub(r"[^a-z0-9]", "", _ascii(first.get("family") or first.get("literal") or "")) or "anonymous"
    word = next((w for w in re.findall(r"[a-z0-9]+", _ascii(title)) if w not in _STOP), "")
    return f"{family[:30]}{year}{word[:20]}"


def _bibtex(kind: str, key: str, fields: list[tuple[str, str]]) -> str:
    """An entry; each value in braces, but the `month` macro (`sep`) as it is."""
    body = ",\n".join(f"  {name} = {value}" if name == "month" else f"  {name} = {{{value}}}"
                      for name, value in fields if value)
    return f"@{kind}{{{key},\n{body}\n}}"


def _ris(kind: str, fields: list[tuple[str, str]]) -> str:
    lines = [f"TY  - {kind}"] + [f"{tag}  - {value}" for tag, value in fields if value] + ["ER  - "]
    return "\n".join(lines)


def _sentence(s: str) -> str:
    return s if s.endswith((".", "?", "!")) else f"{s}."


def cite_paper(r: sqlite3.Row, authors: list[sqlite3.Row], journal: sqlite3.Row | None,
               names: list[str]) -> dict[str, Any]:
    """The paper's citation: BibTeX, RIS, an APA-like text and CSL-JSON, from its record."""
    people = _creators(authors, names)
    title = _clean(r["title"]).rstrip(".")
    container = _clean(r["journal"]) or _clean(journal["title"] if journal is not None else "")
    short = _clean(journal["nlm_ta"] if journal is not None else "")
    issn = _clean((journal["issn"] or journal["eissn"]) if journal is not None else "")
    publisher = _clean(journal["publisher"] if journal is not None else "")
    parts = _date_parts(r["published"] or r["published_online"] or "")
    year = str(parts[0]) if parts else ""
    month = _MONTHS[parts[1] - 1] if len(parts) > 1 and 1 <= parts[1] <= 12 else ""
    volume, issue, pages = _clean(r["volume"]), _clean(r["issue"]), _clean(r["pages"])
    first_page, _, last_page = pages.partition("-")
    doi = (r["doi"] or "").strip()
    url = f"https://doi.org/{doi}" if doi else ""
    csl: dict[str, Any] = {"id": doi or r["id"], "type": "article" if r["type"] == "preprint" else "article-journal",
                           "title": title, "container-title": container, "author": people}
    for k, v in (("container-title-short", short), ("volume", volume), ("issue", issue), ("page", pages),
                 ("DOI", doi), ("PMID", r["pmid"]), ("PMCID", r["pmcid"]), ("ISSN", issn),
                 ("publisher", publisher), ("URL", url), ("language", r["language"])):
        if v:
            csl[k] = v
    if parts:
        csl["issued"] = {"date-parts": [parts]}
    if not container:
        del csl["container-title"]

    bibtex = _bibtex("article", _key(people, year, title), [
        ("author", " and ".join(_bib_name(p) for p in people)), ("title", "{" + _bib(title) + "}"),
        ("journal", _bib(container)), ("year", year), ("month", month),
        ("volume", _bib(volume)), ("number", _bib(issue)), ("pages", _bib(pages).replace("-", "--")),
        ("publisher", _bib(publisher)), ("issn", issn), ("doi", doi), ("url", url),
        ("pmid", r["pmid"] or ""), ("pmcid", r["pmcid"] or "")])
    ris = _ris("JOUR", [*(("AU", f"{p['family']}, {p['given']}" if p.get("given") else p.get("family")
                           or p.get("literal", "")) for p in people),
                        ("TI", title), ("T2", container), ("J2", short), ("PY", year),
                        ("DA", "/".join(f"{x:02d}" if i else str(x) for i, x in enumerate(parts))),
                        ("VL", volume), ("IS", issue), ("SP", first_page), ("EP", last_page), ("SN", issn),
                        ("PB", publisher), ("DO", doi), ("UR", url), ("LA", r["language"] or "")])
    where = container
    if volume:
        where += f", {volume}" + (f"({issue})" if issue else "")
    if pages:
        where += f", {pages}"
    apa = " ".join(x for x in (
        (_sentence(_apa_authors([_apa_name(p) for p in people])) if people else ""),
        f"({year or 'n.d.'}).", _sentence(title), _sentence(where) if where else "", url) if x)
    return {"apa": apa, "bibtex": bibtex, "ris": ris, "csl": csl}


def cite_map(paper_title: str, validations: list[sqlite3.Row], deposit: sqlite3.Row) -> dict[str, Any]:
    """The citation of a map deposited on Zenodo, as its record names it: the validating
    authors, then the platform (PLATFORM, filled in by the website)."""
    people = []
    for v in validations:
        family, _, given = (x.strip() for x in _clean(v["name"]).partition(","))
        people.append({"family": family, "given": given} if given else {"family": family})
    day = entities._day(deposit["deposited_at"])
    parts = _date_parts(day)
    year = str(parts[0]) if parts else ""
    title = f"Code tracing map: {_clean(paper_title)}"[:250]
    version = f"{zenodo.MAP_FORMAT.split('/')[1]}-{day}" if day else ""
    doi = (deposit["doi"] or "").strip()
    url = f"https://doi.org/{doi}" if doi else ""
    csl: dict[str, Any] = {"id": doi, "type": "dataset", "title": title,
                           "author": [*people, {"literal": PLATFORM}], "publisher": "Zenodo"}
    for k, v in (("version", version), ("DOI", doi), ("URL", url)):
        if v:
            csl[k] = v
    if parts:
        csl["issued"] = {"date-parts": [parts]}
    bibtex = _bibtex("misc", _key(people, year, "map"), [
        ("author", " and ".join([*(_bib_name(p) for p in people), "{" + PLATFORM + "}"])),
        ("title", "{" + _bib(title) + "}"), ("year", year), ("publisher", "Zenodo"), ("version", _bib(version)),
        ("doi", doi), ("url", url)])
    ris = _ris("DATA", [*(("AU", f"{p['family']}, {p['given']}" if p.get("given") else p["family"]) for p in people),
                        ("AU", PLATFORM), ("TI", title), ("PY", year), ("PB", "Zenodo"), ("ET", version),
                        ("DO", doi), ("UR", url)])
    names = [*(_apa_name(p) for p in people), PLATFORM]
    apa = " ".join(x for x in (_sentence(_apa_authors(names)), f"({year or 'n.d.'}).",
                                f"{title}" + (f" (Version {version})" if version else "") + " [Data set].",
                                "Zenodo.", url) if x)
    return {"apa": apa, "bibtex": bibtex, "ris": ris, "csl": csl}


# ---------------------------------------------------------------------------------------
# Similar papers.

def similar(features: dict[str, dict[str, set[str]]], names: dict[tuple[str, str], str],
            order: dict[str, tuple[Any, ...]]) -> dict[str, list[dict[str, Any]]]:
    """For each paper, the papers that share the most with it: `features[paper][kind]` is
    a set of keys (tool ids, dataset ids, category values, cited DOIs, ORCID iDs). A shared
    key weighs WEIGHTS[kind] times its rarity, log(1 + papers / papers having it)."""
    postings: dict[tuple[str, str], set[str]] = defaultdict(set)
    for pid, kinds in features.items():
        for kind, keys in kinds.items():
            for k in keys:
                postings[(kind, k)].add(pid)
    n = len(features)
    idf = {key: math.log(1 + n / len(ps)) for key, ps in postings.items()}
    common = {key for key, ps in postings.items() if len(ps) > max(COMMON * n, 2)}
    out: dict[str, list[dict[str, Any]]] = {}
    for pid, kinds in features.items():
        partial: dict[str, float] = defaultdict(float)
        for kind, keys in kinds.items():
            for k in keys:
                ps = postings[(kind, k)]
                if 1 < len(ps) <= MAX_POSTING and (kind, k) not in common:
                    for other in ps:
                        partial[other] += WEIGHTS[kind] * idf[(kind, k)]
        partial.pop(pid, None)
        best = sorted(partial, key=lambda c: (-partial[c], order[c]))[:MAX_CANDIDATES]
        scored = []
        for c in best:
            shared = {kind: kinds[kind] & features[c].get(kind, set()) for kind in kinds}
            score = sum(WEIGHTS[kind] * idf[(kind, k)] for kind, keys in shared.items() for k in keys)
            if score >= MIN_SCORE:
                scored.append((score, c, shared))
        scored.sort(key=lambda x: (-x[0], order[x[1]]))
        out[pid] = [{"id": c, "score": round(score, 2),
                     "reasons": _reasons({kind: {k for k in keys if (kind, k) not in common}
                                          for kind, keys in shared.items()}, idf, names)}
                    for score, c, shared in scored[:MAX_SIMILAR]]
    return out


def _reasons(shared: dict[str, set[str]], idf: dict[tuple[str, str], float],
             names: dict[tuple[str, str], str]) -> str:
    """"shares FieldTrip, EEG, 3 references": the rarest shared things first."""
    def named(kind: str, most: int, one: str, many: str) -> list[str]:
        keys = sorted(shared.get(kind, ()), key=lambda k: (-idf[(kind, k)], names.get((kind, k), k).casefold()))
        words = [names.get((kind, k), k) for k in keys[:most]]
        if len(keys) > most:
            rest = len(keys) - most
            words.append(f"{rest} other {one if rest == 1 else many}")
        return words
    parts = (named("tool", 3, "tool", "tools") + named("dataset", 2, "dataset", "datasets")
             + named("category", 3, "category", "categories"))
    refs = len(shared.get("reference", ()))
    if refs:
        parts.append(f"{refs} reference{'' if refs == 1 else 's'}")
    people = sorted(shared.get("author", ()))
    if len(people) == 1:
        parts.append(f"author {names.get(('author', people[0]), people[0])}")
    elif people:
        parts.append(f"{len(people)} authors")
    return "shares " + ", ".join(parts)


def _dataset_label(did: str, known: dict[str, sqlite3.Row]) -> str:
    """The dataset's title when it has one, else "OpenNeuro ds000117"."""
    d = known.get(did)
    title = _clean(d["title"] if d is not None else "")
    if title:
        return title if len(title) <= 60 else title[:59].rstrip() + "…"
    repository = (d["repository"] if d is not None else "") or enrich.data_repository(did)
    accession = re.sub(r"^[a-z0-9-]+:", "", did, flags=re.IGNORECASE)
    return _clean(f"{repository} {accession}" if repository and accession != did else did)


# ---------------------------------------------------------------------------------------
# The export.

def _grouped(con: sqlite3.Connection, sql: str, key: str = "article_id") -> dict[str, list[sqlite3.Row]]:
    out: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in con.execute(sql):
        out[r[key]].append(r)
    return out


def generate(con: sqlite3.Connection, folder: Path, articles: list[dict[str, Any]]) -> dict[str, int]:
    """Write `papers/NN.json` into `folder` for the papers of `articles` (catalog.json's,
    after entities.generate) that have a page, and tell each of them its lot (`page_lot`).
    Returns counts: papers, lots, versions listed, similar links."""
    pages = {a["id"]: a for a in articles if a.get("page")}
    pages_sql = entities.PAGES_SQL
    rows = {r["id"]: r for r in con.execute(f"SELECT * FROM article WHERE id IN ({pages_sql})")}
    pages = {i: a for i, a in pages.items() if i in rows}
    authors = _grouped(con, f"SELECT * FROM paper_author WHERE article_id IN ({pages_sql}) ORDER BY article_id, position")
    grants = _grouped(con, f"SELECT * FROM grant_award WHERE article_id IN ({pages_sql}) ORDER BY article_id, rowid")
    funders = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM funder")}
    subjects = _grouped(con, f"SELECT * FROM paper_subject WHERE article_id IN ({pages_sql}) ORDER BY article_id, rowid")
    rrids = _grouped(con, f"SELECT * FROM paper_rrid WHERE article_id IN ({pages_sql})")
    notices = _grouped(con, f"SELECT * FROM integrity_notice WHERE article_id IN ({pages_sql})")
    statements = _grouped(con, f"SELECT * FROM statement WHERE article_id IN ({pages_sql})")
    links = _grouped(con, f"SELECT * FROM link WHERE article_id IN ({pages_sql}) ORDER BY article_id, repo")
    versions = _grouped(con, f"SELECT * FROM version WHERE entity = 'article' AND entity_id IN ({pages_sql})",
                        "entity_id")
    journals = {r["id"]: r for r in con.execute("SELECT * FROM journal")}
    code_repos = {link["repo"] for ls in links.values() for link in ls if link["role"] == "code"}
    repos = {r["repo"]: r for r in con.execute("SELECT * FROM repository") if r["repo"] in code_repos}
    features = {r["repo"]: r for r in con.execute("SELECT * FROM repo_feature") if r["repo"] in code_repos}
    tools = _grouped(con, "SELECT * FROM repo_tool", "repo")
    checks = _grouped(con, "SELECT * FROM alive_check", "repo")
    scripts = {r["repo"]: r["n"] for r in con.execute(
        "SELECT repo, COUNT(*) AS n FROM file WHERE kind = 'script' GROUP BY repo")}
    pairs = {r["article_id"]: (r["n"], r["method"]) for r in con.execute(
        f"SELECT article_id, COUNT(*) AS n, MAX(method) AS method FROM alignment WHERE article_id IN ({pages_sql}) "
        "GROUP BY article_id")}
    # Only a validation by an author signed in with ORCID, and only a DOI of the real Zenodo:
    # the sandbox's tests never leave (CLAUDE.md), as in catalog.json.
    validations = _grouped(con, f"SELECT * FROM validation WHERE proof = 'orcid' AND article_id IN ({pages_sql}) "
                                "ORDER BY validated_at")
    deposits = {r["article_id"]: r for r in con.execute("SELECT * FROM card_doi WHERE instance = 'zenodo'")}

    # Similar papers: what each paper with a page has that another may share.
    p = entities._Papers(con)
    by_slug = {catalog.slug(i): i for i in pages}
    category_names: dict[tuple[str, str], str] = {}
    categories: dict[str, set[str]] = defaultdict(set)
    for facet, values in entities._categories(con, p)["facets"].items():
        for value, v in values.items():
            category_names[("category", f"{facet}:{value}")] = _clean(v.get("name") or value)
            for s in v["papers"]:
                if s in by_slug:
                    categories[by_slug[s]].add(f"{facet}:{value}")
    references: dict[str, set[str]] = defaultdict(set)
    for r in con.execute(f"SELECT article_id, doi FROM paper_reference WHERE doi != '' AND article_id IN ({pages_sql})"):
        references[r["article_id"]].add(r["doi"].lower())
    tool_names = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM tool")}
    known_datasets = {r["id"]: r for r in con.execute("SELECT * FROM dataset")}
    names: dict[tuple[str, str], str] = dict(category_names)
    feats: dict[str, dict[str, set[str]]] = {}
    for aid, a in pages.items():
        people = {x["orcid"] for x in a.get("authors") or [] if x.get("orcid")}
        for x in a.get("authors") or []:
            if x.get("orcid"):
                names.setdefault(("author", x["orcid"]), _clean(x["name"]))
        for t in a.get("tools") or []:
            names.setdefault(("tool", t), _clean(tool_names.get(t) or t))
        for d in a.get("datasets") or []:
            names.setdefault(("dataset", d), _dataset_label(d, known_datasets))
        feats[aid] = {"tool": set(a.get("tools") or []), "dataset": set(a.get("datasets") or []),
                      "category": categories.get(aid, set()), "reference": references.get(aid, set()),
                      "author": people}
    # The most recent first on a tie, then by page name: the same order every night.
    order = {aid: (tuple(-x for x in _date_parts(a.get("published") or "")) or (0,), catalog.slug(aid))
             for aid, a in pages.items()}
    close = similar(feats, names, order)

    lots: dict[int, dict[str, Any]] = defaultdict(dict)
    counts = {"papers": 0, "versions": 0, "similar": 0}
    for aid, a in pages.items():
        r = rows[aid]
        n_pairs, method = pairs.get(aid, (0, ""))
        code_links = [link for link in links.get(aid, []) if link["role"] == "code"]
        deposit = deposits.get(aid) if validations.get(aid) else None
        entry = {
            "overview": _overview(r, authors.get(aid, []), grants.get(aid, []), funders, subjects.get(aid, []),
                                  rrids.get(aid, []), notices.get(aid, [])),
            "code": {link["repo"]: _repository(repos.get(link["repo"]), features.get(link["repo"]),
                                               tools.get(link["repo"], []), checks.get(link["repo"], []),
                                               scripts.get(link["repo"], 0)) for link in code_links},
            "availability": _availability(r, statements.get(aid, []), links.get(aid, [])),
            "data": _data_links(links.get(aid, [])),
            "map": _map(a, validations.get(aid, []), deposit,
                        sum(scripts.get(link["repo"], 0) for link in code_links), n_pairs, method,
                        zenodo.map_digest(zenodo.map_of(con, aid)) if code_links else ""),
            "versions": history(versions.get(aid, [])),
            "cite": {"paper": cite_paper(r, authors.get(aid, []), journals.get(r["journal_id"] or ""),
                                         [x["name"] for x in a.get("authors") or []]),
                     "map": cite_map(r["title"], validations[aid], deposit)
                     if deposit is not None and deposit["doi"] else None},
            "similar": [{"slug": catalog.slug(s["id"]), "score": s["score"], "reasons": s["reasons"]}
                        for s in close.get(aid, [])],
        }
        n = catalog.lot_of(aid)
        lots[n][aid] = entities.scrub(entry)
        a["page_lot"] = n
        counts["papers"] += 1
        counts["versions"] += len(entry["versions"])
        counts["similar"] += len(entry["similar"])

    out = folder / "papers"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json"):
        old.unlink()
    for n, content in sorted(lots.items()):
        entities._write(out / f"{n:02d}.json", dict(sorted(content.items())))
    return {**counts, "lots": len(lots)}
