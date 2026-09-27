"""The website's navigation (Phase 2): the people, journals, institutions, tools, datasets
and categories behind the papers, and the DOI lookup.

`generate` writes, next to `catalog.json` and in public mode only:

- `entities/authors.json`, `journals.json`, `institutions.json`, `tools.json`,
  `datasets.json`: one entry per entity, the entities with the most papers first;
- `entities/categories.json`: facet → value → papers;
- `lookup/NNN.json`: the DOI lookup, one shard per first 3 hex characters of the SHA-1 of
  the lowercased DOI (4,096 shards at most, only the non-empty ones written).

It also tells `catalog.json`, for each paper, whether it has a page and, when it has one,
which authors, journal, tools and datasets its page links to.

**Only the papers with a page count** (the owner's decisions D2 and D7): the authors' code
(verified, found, empty or dead), code on request, or data only, and never an off-topic
paper. The lookup covers every in-scope paper read, with or without a page; an off-topic
paper stays on the Mac, out of the lookup too.

**A person is merged across papers by ORCID iD only.** Names alone cannot be merged
reliably: an author without a valid ORCID iD stays a name on the pages of their papers.

**No email address, and no other contact detail, ever.** Every string written here goes
through `strip_contacts`, and each file is checked once more just before it is written.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from . import catalog, enrich

#: The statuses of the papers that have a page (D2); off-topic papers never do (D7).
PAGE_STATUSES: tuple[str, ...] = ("code_verified", "code_found", "code_empty", "code_dead", "on_request",
                                  "data_only")
#: Among them, the papers with their authors' code.
CODE_STATUSES: tuple[str, ...] = ("code_verified", "code_found", "code_empty", "code_dead")
#: A category decided by the rules is shown from this confidence on, when it is not
#: ambiguous. The owner's labels and a model's are always shown.
MIN_CONFIDENCE: float = 0.6
#: Facets that are not categories to browse: `on_topic` only decides whether a paper is
#: published at all (D7).
HIDDEN_FACETS: tuple[str, ...] = ("on_topic",)
#: The facets in the order the site shows them; any other facet comes after, by name.
FACET_ORDER: tuple[str, ...] = ("modality", "organism", "population", "subfield")
#: The lookup's shards: the first LOOKUP_HEX hex characters of sha1(DOI), 16**3 = 4,096.
LOOKUP_HEX: int = 3

ENTITY_FILES: tuple[str, ...] = ("authors", "journals", "institutions", "tools", "datasets", "categories")

_IN = ", ".join(f"'{s}'" for s in PAGE_STATUSES)
#: The ids of the papers that have a page, as an SQL subquery.
PAGES_SQL = f"SELECT id FROM article WHERE {catalog.IN_SCOPE} AND status IN ({_IN})"

# ---------------------------------------------------------------------------------------
# Contact details: removed from every string that leaves.

_EMAIL = re.compile(
    r"(?:mailto:\s*)?[\w.!#$%&'*+/=?^`{|}~-]+"               # the local part
    r"\s*(?:@|＠|[\[({]\s*at\s*[\])}])\s*"                     # @, ＠, [at], (at), {at}
    r"[\w-]+(?:\s*(?:\.|[\[({]\s*dot\s*[\])}])\s*[\w-]+)+",    # a domain with at least one dot
    re.IGNORECASE)
#: Anything else with an at sign between two word characters ("name@host"); an at sign
#: between spaces ("Lab @ Univ") is prose, and a URL's "/@scope" is not an address.
_AT = re.compile(r"[\w.+-]*\w[@＠]\w[\w.-]*")
_PHONE = re.compile(r"\b(?:tel(?:ephone)?|phone|fax|mobile)\.?\s*(?:no\.?|number)?\s*[:：]?\s*\+?\d[\d\s().\-/]{5,}\d",
                    re.IGNORECASE)
#: What introduced a contact detail, once the detail is gone.
_LABEL = re.compile(r"\b(?:electronic\s+address(?:es)?|e-?\s?mails?(?:\s+address(?:es)?)?|contact|"
                    r"correspondence(?:\s+to)?)\s*[:：]?(?=\s*(?:[,;.)\]}>]|$))", re.IGNORECASE)


def strip_contacts(text: str) -> str:
    """The text without any email address or telephone number: "Dept of X, Univ Y.
    Electronic address: a.b@y.org" → "Dept of X, Univ Y". A text without any is returned
    unchanged."""
    if not text:
        return text
    out = _PHONE.sub(" ", _AT.sub(" ", _EMAIL.sub(" ", text)))
    if out == text:
        return text
    out = _LABEL.sub(" ", out)
    out = re.sub(r"[<(\[{]\s*[>)\]}]", " ", out)            # brackets left empty
    out = re.sub(r"\s+([,;.:])", r"\1", out)
    out = re.sub(r"([,;:])(?:\s*[,;:.])+", r"\1", out)
    return re.sub(r"\s{2,}", " ", out).strip(" \t\n,;:.-–—")


def has_contact(text: str) -> bool:
    return bool(_EMAIL.search(text) or _AT.search(text) or _PHONE.search(text))


def scrub(value: Any) -> Any:
    """`strip_contacts` over every string of a JSON value, keys included."""
    if isinstance(value, str):
        return strip_contacts(value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {strip_contacts(k): scrub(v) for k, v in value.items()}
    return value


# ---------------------------------------------------------------------------------------
# Identifiers.

_ORCID = re.compile(r"\s*(?:https?://(?:www\.)?orcid\.org/)?(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dX])\s*/?\s*",
                    re.IGNORECASE)
_ROR = re.compile(r"\s*(?:https?://(?:www\.)?ror\.org/)?(0[a-z0-9]{6}\d{2})\s*/?\s*", re.IGNORECASE)
_FACET = re.compile(r"[a-z][a-z0-9_-]{0,40}")


def orcid(value: str) -> str:
    """The ORCID iD in `value` ("0000-0002-1825-0097", or its https://orcid.org/ form), as
    "0000-0002-1825-0097"; "" when there is none or its check digit is wrong (ISO 7064 11,2)."""
    m = _ORCID.fullmatch(value or "")
    if not m:
        return ""
    digits = "".join(m.groups()).upper()
    total = 0
    for d in digits[:-1]:
        total = (total + int(d)) * 2
    check = (12 - total % 11) % 11
    if digits[-1] != ("X" if check == 10 else str(check)):
        return ""
    return "-".join(m.groups()).upper()


def ror(value: str) -> str:
    """The ROR id in `value` ("03yrm5c26", or its https://ror.org/ form), lowercased; "" if none."""
    m = _ROR.fullmatch(value or "")
    return m.group(1).lower() if m else ""


def normalize_doi(value: str) -> str:
    """"https://doi.org/10.1234/ABC" or "doi:10.1234/abc" → "10.1234/abc"; "" if not a DOI."""
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", (value or "").strip(), flags=re.IGNORECASE)
    doi = doi.strip().lower()
    return doi if re.fullmatch(r"10\.\d{3,9}/\S+", doi) else ""


def lookup_shard(doi: str) -> str:
    """The lookup shard of a normalized DOI: the first hex characters of its SHA-1."""
    return hashlib.sha1(doi.encode("utf-8")).hexdigest()[:LOOKUP_HEX]


def url_slug(text: str, taken: set[str]) -> str:
    """A name for a URL, unique among `taken` (which it joins): "issn:1234-567X" →
    "issn-1234-567x", "openneuro:ds000117" → "openneuro-ds000117"."""
    s = re.sub(r"[^a-z0-9._-]+", "-", text.lower()).strip("._-")[:100].strip("._-")
    if not s or s in taken:
        s = f"{s or 'x'}-{hashlib.sha1(text.encode('utf-8')).hexdigest()[:8]}"
    taken.add(s)
    return s


def _title_key(title: str) -> str:
    """A journal title as enrich._journal_id normalizes it for a `title:` id."""
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def _text(value: Any, *keys: str) -> str:
    """A string, or the first string of an object under `keys` ({"name": …}, {"id": …})."""
    if isinstance(value, dict):
        value = next((value[k] for k in keys if isinstance(value.get(k), str)), "")
    return value if isinstance(value, str) else ""


def _strings(raw: str | None) -> list[str]:
    """A JSON list of affiliations (strings, or objects with a name), cleaned of contact
    details and blanks."""
    out: list[str] = []
    for v in _json_list(raw):
        s = re.sub(r"\s+", " ", strip_contacts(_text(v, "name", "text", "affiliation", "institution"))).strip()
        if s and s not in out:
            out.append(s)
    return out


def _web(url: str | None) -> str:
    return url if url and re.match(r"https?://", url, re.IGNORECASE) else ""


def _day(t: float | None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t)) if t else ""


# ---------------------------------------------------------------------------------------
# The export.

class _Papers:
    """The papers with a page, and what every entity says about them."""

    def __init__(self, con: sqlite3.Connection) -> None:
        self.rows = {r["id"]: r for r in con.execute(
            f"SELECT id, doi, title, authors, journal, journal_id, published, status, scanned_at FROM article "
            f"WHERE {catalog.IN_SCOPE} AND status IN ({_IN})")}
        self.slug = {i: catalog.slug(i) for i in self.rows}
        self.with_code = {i for i, r in self.rows.items() if r["status"] in CODE_STATUSES}
        # Most recent first: publication date, then when it was read.
        self.when = {i: (r["published"] or "", r["scanned_at"] or 0.0, i) for i, r in self.rows.items()}

    def slugs(self, ids: set[str] | list[str]) -> list[str]:
        """The pages of these papers, the most recent first."""
        return [self.slug[i] for i in sorted(set(ids), key=lambda i: self.when[i], reverse=True)]

    def counts(self, ids: set[str]) -> dict[str, int]:
        return {"papers": len(ids), "with_code": len(ids & self.with_code)}


def _by_count(entries: list[dict[str, Any]], name: str, key: str = "id") -> list[dict[str, Any]]:
    """The entities with the most papers first, then by name."""
    return sorted(entries, key=lambda e: (-e["counts"]["papers"], str(e[name]).casefold(), e[key]))


def _people(con: sqlite3.Connection, p: _Papers, tools_of: dict[str, list[str]]
            ) -> tuple[dict[str, list[dict[str, str]]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Each paper's authors in order (name, ORCID iD or ""), the authors with an ORCID iD,
    and the institutions (ROR ids) of the authors' affiliations."""
    rows: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in con.execute(f"SELECT * FROM paper_author WHERE article_id IN ({PAGES_SQL}) ORDER BY article_id, position"):
        rows[r["article_id"]].append(r)
    registered = {r["orcid"]: r["name"] for r in con.execute("SELECT orcid, name FROM author")}

    def name_of(r: sqlite3.Row) -> str:
        name = r["name"] or " ".join(x for x in (r["given"], r["family"]) if x)
        return re.sub(r"\s+", " ", strip_contacts(name)).strip()

    listed: dict[str, list[dict[str, str]]] = {}
    people: dict[str, dict[str, Any]] = {}
    places: dict[str, dict[str, Any]] = {}
    for aid in p.rows:
        if aid not in rows:
            # Not enriched yet: the names the harvester kept, without ORCID iDs.
            try:
                names = json.loads(p.rows[aid]["authors"] or "[]")
            except ValueError:
                names = []
            clean = (re.sub(r"\s+", " ", strip_contacts(str(n))).strip() for n in names if isinstance(n, str))
            listed[aid] = [{"name": n, "orcid": ""} for n in clean if n]
            continue
        listed[aid] = []
        when = p.when[aid]
        for r in rows[aid]:
            name, oid = name_of(r), orcid(r["orcid"])
            if name or oid:
                listed[aid].append({"name": name or strip_contacts(registered.get(oid, "")) or oid, "orcid": oid})
            affiliations = _strings(r["affiliations"])
            rors = [x for x in (ror(_text(v, "id", "ror")) for v in _json_list(r["ror"])) if x]
            if oid:
                e = people.setdefault(oid, {"papers": set(), "rors": {}, "named": None, "placed": None})
                e["papers"].add(aid)
                if name and (e["named"] is None or when > e["named"][0]):
                    e["named"] = (when, name, (r["given"] or "").strip(), (r["family"] or "").strip())
                if affiliations and (e["placed"] is None or when > e["placed"][0]):
                    e["placed"] = (when, affiliations)
                for x in rors:
                    e["rors"][x] = max(e["rors"].get(x, when), when)
            # An institution's name: the affiliation written most often with its ROR id.
            pairs = (list(zip(rors, affiliations, strict=True)) if len(rors) == len(affiliations)
                     else [(x, a) for x in rors for a in affiliations])
            for x in rors:
                inst = places.setdefault(x, {"papers": set(), "authors": set(), "names": Counter()})
                inst["papers"].add(aid)
                if oid:
                    inst["authors"].add(oid)
            for x, a in pairs:
                places[x]["names"][a] += 1

    authors = []
    for oid, e in people.items():
        _, name, given, family = e["named"] or (None, strip_contacts(registered.get(oid, "")) or oid, "", "")
        used = Counter(t for aid in e["papers"] for t in tools_of.get(aid, []))
        authors.append({
            "orcid": oid, "name": name, "given": given, "family": family,
            "papers": p.slugs(e["papers"]),
            "affiliations": e["placed"][1] if e["placed"] else [],
            "institutions": [x for x, _ in sorted(e["rors"].items(), key=lambda kv: kv[1], reverse=True)],
            "tools": [t for t, _ in sorted(used.items(), key=lambda kv: (-kv[1], kv[0]))],
            "counts": p.counts(e["papers"]),
        })
    institutions = []
    for x, inst in places.items():
        names = sorted(inst["names"].items(), key=lambda kv: (-kv[1], len(kv[0]), kv[0]))
        institutions.append({
            "id": x, "name": names[0][0] if names else f"ROR {x}",
            "papers": p.slugs(inst["papers"]), "authors": sorted(inst["authors"]),
            "counts": p.counts(inst["papers"]),
        })
    return listed, _by_count(authors, "name", "orcid"), _by_count(institutions, "name")


def _json_list(raw: str | None) -> list[Any]:
    try:
        v = json.loads(raw or "[]")
    except ValueError:
        return []
    return v if isinstance(v, list) else [v]


def _journals(con: sqlite3.Connection, p: _Papers) -> tuple[dict[str, str], list[dict[str, Any]]]:
    """Each paper's journal id, and the journals of the papers with a page, with "N papers
    with code out of M read" (M: the in-scope papers read in that journal).

    A paper not enriched yet has no `journal_id`: it joins the journal whose title is the
    same, else a `title:` journal, as the enrichment names them."""
    table = {r["id"]: r for r in con.execute("SELECT * FROM journal")}
    by_title: dict[str, set[str]] = defaultdict(set)
    for jid, r in table.items():
        by_title[_title_key(r["title"])].add(jid)

    def resolve(journal_id: str, title: str) -> str:
        if journal_id:
            return journal_id
        key = _title_key(title)
        if not key:
            return ""
        same = by_title.get(key, set())
        return next(iter(same)) if len(same) == 1 else f"title:{key}"

    read: Counter[str] = Counter()
    papers: dict[str, set[str]] = defaultdict(set)
    titles: dict[str, Counter[str]] = defaultdict(Counter)
    journal_of: dict[str, str] = {}
    for r in con.execute(f"SELECT id, journal, journal_id FROM article WHERE {catalog.IN_SCOPE}"):
        jid = resolve(r["journal_id"] or "", r["journal"] or "")
        if not jid:
            continue
        read[jid] += 1
        if r["id"] in p.rows:
            papers[jid].add(r["id"])
            journal_of[r["id"]] = jid
            if r["journal"]:
                titles[jid][r["journal"].strip()] += 1
    taken: set[str] = set()
    journals = []
    for jid in sorted(papers):
        j = table.get(jid)
        title = (j["title"] if j is not None else "") or (titles[jid].most_common(1)[0][0] if titles[jid] else jid)
        journals.append({
            "id": jid, "slug": url_slug(jid, taken), "title": title,
            "issn": (j["issn"] if j is not None else "") or "", "eissn": (j["eissn"] if j is not None else "") or "",
            "publisher": (j["publisher"] if j is not None else "") or "",
            "papers": p.slugs(papers[jid]), "counts": {**p.counts(papers[jid]), "read": read[jid]},
        })
    return journal_of, _by_count(journals, "title")


def _tools(con: sqlite3.Connection, p: _Papers) -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
    """The tools detected in the authors' code of the papers with a page: each paper's
    tools, and each tool's repositories and papers."""
    known = {r["id"]: r for r in con.execute("SELECT * FROM tool")}
    urls = {r["repo"]: r["url"] for r in con.execute("SELECT repo, url FROM repository")}
    tools_of: dict[str, set[str]] = defaultdict(set)
    repos: dict[str, dict[str, int]] = defaultdict(dict)
    papers: dict[str, set[str]] = defaultdict(set)
    for r in con.execute(f"SELECT l.article_id, t.repo, t.tool_id, t.evidence FROM repo_tool t "
                         f"JOIN link l ON l.repo = t.repo AND l.role = 'code' WHERE l.article_id IN ({PAGES_SQL})"):
        tools_of[r["article_id"]].add(r["tool_id"])
        papers[r["tool_id"]].add(r["article_id"])
        repos[r["tool_id"]][r["repo"]] = max(repos[r["tool_id"]].get(r["repo"], 0), r["evidence"] or 0)
    url_of = lambda repo: _web(urls.get(repo)) or (f"https://doi.org/{repo[4:]}" if repo.startswith("doi:") else "")
    taken: set[str] = set()
    tools = []
    for tid in sorted(papers):
        t = known.get(tid)
        tools.append({
            "id": tid, "slug": url_slug(tid, taken), "name": (t["name"] if t is not None else "") or tid,
            "kind": (t["kind"] if t is not None else "") or "",
            "homepage": _web(t["homepage"] if t is not None else ""), "rrid": (t["rrid"] if t is not None else "") or "",
            "repositories": [{"repo": repo, "url": url_of(repo), "evidence": n}
                             for repo, n in sorted(repos[tid].items(), key=lambda kv: (-kv[1], kv[0]))],
            "papers": p.slugs(papers[tid]),
            "counts": {**p.counts(papers[tid]), "repositories": len(repos[tid])},
        })
    return {aid: sorted(ts) for aid, ts in tools_of.items()}, _by_count(tools, "name")


def _datasets(con: sqlite3.Connection, p: _Papers) -> tuple[dict[str, list[str]], list[dict[str, Any]]]:
    """The datasets cited by the papers with a page (`dataset`, `paper_dataset`). A paper not
    enriched yet counts through its data links, under the same ids (enrich.link_datasets)."""
    known = {r["id"]: r for r in con.execute("SELECT * FROM dataset")}
    link_url: dict[str, str] = {}
    cited: dict[str, set[str]] = defaultdict(set)
    for r in con.execute(f"SELECT article_id, repo, url FROM link WHERE role = 'data' AND article_id IN ({PAGES_SQL})"):
        ident = enrich.dataset_id(r["repo"], r["url"] or "")
        if ident is None:          # a database's root, with no accession: not a dataset
            continue
        cited[ident[0]].add(r["article_id"])
        link_url.setdefault(ident[0], ident[1])
    for r in con.execute(f"SELECT article_id, dataset_id FROM paper_dataset WHERE article_id IN ({PAGES_SQL})"):
        cited[r["dataset_id"]].add(r["article_id"])
    taken: set[str] = set()
    datasets = []
    datasets_of: dict[str, set[str]] = defaultdict(set)
    for did in sorted(cited):
        if has_contact(did):   # a "dataset" that is an address: never
            continue
        d = known.get(did)
        url = (_web(d["url"] if d is not None else "") or _web(link_url.get(did))
               or (f"https://doi.org/{did[4:]}" if did.startswith("doi:") else ""))
        datasets.append({
            "id": did, "slug": url_slug(did, taken),
            "repository": (d["repository"] if d is not None else "") or enrich.data_repository(did),
            "url": url, "title": (d["title"] if d is not None else "") or "",
            "license": (d["license"] if d is not None else "") or "",
            "papers": p.slugs(cited[did]), "counts": p.counts(cited[did]),
        })
        for aid in cited[did]:
            datasets_of[aid].add(did)
    return {aid: sorted(ds) for aid, ds in datasets_of.items()}, _by_count(datasets, "title")


def _kept(rows: list[sqlite3.Row]) -> set[str]:
    """The values of one facet of one paper that are shown. The owner's labels win over
    everything, a model's over the rules (it is only asked when they are ambiguous), and a
    rule's value counts from MIN_CONFIDENCE on, when it is not ambiguous."""
    owner = {r["value"] for r in rows if r["method"] == "owner"}
    if owner:
        return owner
    model = {r["value"] for r in rows if (r["method"] or "").startswith("model:")}
    if model:
        return model
    return {r["value"] for r in rows
            if r["method"] == "rule" and (r["confidence"] or 0) >= MIN_CONFIDENCE and not r["ambiguous"]}


def _category_name(facet: str, value: str) -> str:
    """The display name of a category value ("structural_mri" → "Structural MRI / diffusion"),
    from the classification's vocabulary; the value itself when the vocabulary lacks it."""
    from . import classify
    spec = classify.VOCABULARY.get("facets", {}).get(facet, {})
    return next((x.get("name") or value for x in spec.get("values", []) if x.get("value") == value), value)


def _categories(con: sqlite3.Connection, p: _Papers) -> dict[str, Any]:
    hidden = ", ".join(f"'{f}'" for f in HIDDEN_FACETS)
    by: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for r in con.execute(f"SELECT * FROM paper_category WHERE article_id IN ({PAGES_SQL}) AND facet NOT IN ({hidden})"):
        if _FACET.fullmatch(r["facet"] or ""):
            by[(r["article_id"], r["facet"])].append(r)
    values: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for (aid, facet), rows in by.items():
        for v in _kept(rows):
            v = re.sub(r"\s+", " ", v or "").strip()
            if v:
                values[facet][v].add(aid)
    order = lambda f: (FACET_ORDER.index(f) if f in FACET_ORDER else len(FACET_ORDER), f)
    facets: dict[str, dict[str, Any]] = {}
    for facet in sorted(values, key=order):
        taken: set[str] = set()
        slugs = {v: url_slug(v, taken) for v in sorted(values[facet])}
        facets[facet] = {v: {"slug": slugs[v], "name": _category_name(facet, v), "counts": p.counts(ids),
                             "papers": p.slugs(ids)}
                         for v, ids in sorted(values[facet].items(), key=lambda kv: (-len(kv[1]), kv[0].casefold()))}
    return {"min_confidence": MIN_CONFIDENCE, "facets": facets}


def lookup(con: sqlite3.Connection, slugs: dict[str, str]) -> dict[str, dict[str, dict[str, str]]]:
    """Every in-scope paper read, by DOI, split into shards: DOI → status, the day it was
    read, and its page when it has one. Off-topic papers are not there (D7)."""
    shards: dict[str, dict[str, dict[str, str]]] = defaultdict(dict)
    for r in con.execute(f"SELECT id, doi, status, scanned_at FROM article WHERE {catalog.IN_SCOPE} AND doi != '' "
                         f"ORDER BY scanned_at, id"):
        doi = normalize_doi(r["doi"])
        if not doi:
            continue
        entry = {"status": r["status"], "read_on": _day(r["scanned_at"])}
        if r["id"] in slugs:
            entry["slug"] = slugs[r["id"]]
        shard = shards[lookup_shard(doi)]
        if "slug" in shard.get(doi, {}) and "slug" not in entry:
            continue    # two records of one DOI: the one with a page answers
        shard[doi] = entry
    return {k: dict(sorted(v.items())) for k, v in sorted(shards.items())}


def _write(path: Path, data: Any, *, check: bool = True) -> None:
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if check and has_contact(text):
        raise ValueError(f"{path.name}: a contact detail is still there; nothing is written")
    path.write_text(text)


def generate(con: sqlite3.Connection, folder: Path, articles: list[dict[str, Any]]) -> dict[str, int]:
    """Write `entities/` and `lookup/` into `folder`, and tell each paper of `articles`
    (catalog.json's) whether it has a page and, if so, its authors, journal, tools and
    datasets. Returns the number of entries of each file, and of lookup shards."""
    p = _Papers(con)
    tools_of, tools = _tools(con, p)
    listed, authors, institutions = _people(con, p, tools_of)
    journal_of, journals = _journals(con, p)
    datasets_of, datasets = _datasets(con, p)
    files = {"authors": authors, "journals": journals, "institutions": institutions, "tools": tools,
             "datasets": datasets, "categories": _categories(con, p)}

    out = folder / "entities"
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.json"):
        old.unlink()
    for name, data in files.items():
        _write(out / f"{name}.json", scrub(data))

    shards = lookup(con, p.slug)
    (folder / "lookup").mkdir(parents=True, exist_ok=True)
    for old in (folder / "lookup").glob("*.json"):
        old.unlink()
    for name, entries in shards.items():
        # DOIs, statuses, days and page names: no personal data to look for.
        _write(folder / "lookup" / f"{name}.json", entries, check=False)

    for a in articles:
        a["page"] = a["id"] in p.rows
        if a["page"]:
            a["authors"] = scrub(listed.get(a["id"], []))
            a["journal_id"] = journal_of.get(a["id"], "")
            a["tools"] = tools_of.get(a["id"], [])
            a["datasets"] = datasets_of.get(a["id"], [])
    counts = {name: len(data) for name, data in files.items() if isinstance(data, list)}
    counts["categories"] = sum(len(values) for values in files["categories"]["facets"].values())
    return {**counts, "lookup_shards": len(shards)}
