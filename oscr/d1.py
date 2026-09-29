"""Phase 3, the search: the Mac's database projected into Cloudflare D1, pushed as deltas.

Two D1 databases (schemas: `migrations/d1/`; the remote setup: docs/SEARCH.md):

- `oscr_catalog`: `papers`, one row per paper with its filter columns and the `doc` a search
  result shows; `facet_counts`, the counts of the unfiltered view; `meta`;
- `oscr_search`: `paper_fts`, the FTS5 index, in a database of its own because a D1 database
  that holds FTS5 cannot be exported. Its `facets` column holds the filters as tokens, and its
  `fx` column the facet values the Worker counts (website/worker/search.ts).

**Scope.** The papers that have a page (the owner's decision D2: the authors' code, code on
request, data only) and are not off-topic (D7), as `entities.PAGES_SQL` says. A paper that
leaves the scope, off-topic or without a page, is deleted from both databases.

**What never leaves.** No email address nor other contact detail: every string goes through
`entities.strip_contacts`. No abstract of a paper whose license is not open (decision D1's
rule, `catalog.statement_is_publishable`); an open one is indexed, never stored nor returned
(the index is contentless). The `doc` has no abstract, and no sentence of the paper's body.

**Keys.** A paper's key is YYYYMMDD × 100,000 + n, from its publication date (`day_key`): the
index's rowid order is then the date order, and a date range a key range. The keys are kept
in the state file (`d1_pid`), so a paper keeps its key; a new date gives a new key.

**Deltas only.** The state file (`data/d1/state.db`, not the harvester's database, which the
public export copies) keeps a hash of every row pushed to each target (`d1_sync`): a push
sends the rows that changed, deletes the rows that left, and records each file once the
target accepted it.

**Budget.** D1's free plan writes 100,000 rows a day, indexes and FTS5 included, from 00:00
UTC. A push spends at most `budget` rows a day (default 80,000, `d1_budget` keeps the count)
and stops cleanly between two papers: deletions first, then the new papers, the most recent
first, then the changed ones; the rest goes next time. The counts of the unfiltered view
(`facet_counts`, `meta`) come last, from what the databases hold after the push.
"""
from __future__ import annotations

import hashlib
import html
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import time
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import catalog, enrich, entities

CATALOG, SEARCH = "catalog", "search"
#: The D1 databases, by role (wrangler.toml, migrations/d1/<role>/).
DATABASES: dict[str, str] = {CATALOG: "oscr_catalog", SEARCH: "oscr_search"}
ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "migrations" / "d1"
WEBSITE = ROOT / "website"

#: Rows a day; D1's free plan allows 100,000 (docs/SEARCH.md).
DAILY_BUDGET = 80_000
#: Rows D1 counts as written by one upsert, measured on a local D1 (wrangler 4.141, workerd
#: 2026-09-25): a `papers` row and its entry in `papers_cited`; one FTS5 row; one summary row. A
#: deletion counts 1, whatever the table. A remote push counts what D1 answers instead
#: (`meta.rows_written`).
WRITE_COST: dict[tuple[str, str], int] = {
    (CATALOG, "papers"): 2, (SEARCH, "paper_fts"): 1, (CATALOG, "facet_counts"): 1, (CATALOG, "meta"): 1,
}

#: The facets: URL parameter, code, values counted. The same table as website/src/lib/facets.ts
#: (a test checks it).
FACETS: tuple[tuple[str, str, int], ...] = (
    ("status", "st", 12), ("year", "yr", 40), ("modality", "mo", 12), ("organism", "or", 12),
    ("population", "po", 12), ("subfield", "sf", 12), ("tool", "to", 12), ("language", "la", 12),
    ("journal", "jo", 12), ("data", "ds", 12), ("host", "ho", 12), ("code_license", "cl", 12),
    ("type", "ty", 12), ("license", "li", 12), ("matches", "al", 12), ("oa", "oa", 12),
)
CODE: dict[str, str] = {param: code for param, code, _ in FACETS}
#: The token every row of the index carries (facets.ts ALL_TOKEN).
ALL_TOKEN = "zzall"
#: The category facets of `paper_category` that the search filters on.
CATEGORY_FACETS: tuple[str, ...] = ("modality", "organism", "population", "subfield")
#: Rows kept for the summary out of a day's budget: at most every count row replaced, twice.
SUMMARY_RESERVE = 2 * (sum(top for _, _, top in FACETS) + 2)

#: Statements per file for `wrangler d1 execute --file`, and per call of the REST API.
LOCAL_STATEMENTS = 2_000
REMOTE_STATEMENTS = 100
REMOTE_BYTES = 800_000
#: No statement comes close to D1's 100 KB: the text fields are cut to these lengths.
MAX_CHARS: dict[str, int] = {"title": 2_000, "keywords": 8_000, "mesh": 8_000, "authors": 16_000, "journal": 1_000,
                             "repos": 4_000, "tools": 4_000, "ids": 8_000, "abstract": 20_000}
#: The key: YYYYMMDD × KEY_DAY + n.
KEY_DAY = 100_000

STATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS d1_pid (
    article_id  TEXT PRIMARY KEY,
    pid         INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS d1_sync (
    target     TEXT NOT NULL,          -- local | remote
    db         TEXT NOT NULL,          -- catalog | search
    tbl        TEXT NOT NULL,
    key        TEXT NOT NULL,
    hash       TEXT NOT NULL,
    pushed_at  REAL NOT NULL,
    PRIMARY KEY (target, db, tbl, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS d1_budget (
    target  TEXT NOT NULL,
    day     TEXT NOT NULL,             -- the UTC day, as D1 counts it
    rows    INTEGER NOT NULL,
    PRIMARY KEY (target, day)
);
CREATE TABLE IF NOT EXISTS d1_push (
    target       TEXT NOT NULL,
    at           REAL NOT NULL,
    statements   INTEGER NOT NULL,
    rows         INTEGER NOT NULL,
    complete     INTEGER NOT NULL,
    summary      TEXT NOT NULL
);
"""


def open_state(path: Path | str) -> sqlite3.Connection:
    """The push's own state: keys, hashes of the rows pushed, rows written per day."""
    path = Path(path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.executescript(STATE_SCHEMA)
    return con


# ---------------------------------------------------------------------------------------
# Values.

def normalize_value(value: str) -> str:
    """A facet value as it is hashed: NFKC, spaces collapsed, lower case (facets.ts
    normalizeValue)."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip().lower()


def facet_token(code: str, value: str) -> str:
    """The index token of one value of one facet (facets.ts facetToken)."""
    return f"zz{code}{hashlib.sha1(normalize_value(value).encode('utf-8')).hexdigest()[:12]}"


_DATE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?")


def day_key(published: str) -> int:
    """"2026-09-21" → 20260921; "2026-09" → 20260900; "2026" → 20260000; no date → 0."""
    m = _DATE.match(published or "")
    if not m:
        return 0
    return int(m[1]) * 10_000 + int(m[2] or 0) * 100 + int(m[3] or 0)


_TAG = re.compile(r"</?[A-Za-z][\w:.-]*(?:\s[^<>]{0,300})?/?>")
#: Inline markup inside a word ("<i>PIK3CA</i>-related", "Ca<sup>2+</sup>"): removed without a space.
_INLINE_TAG = re.compile(r"</?(?:i|b|u|em|strong|sup|sub|sc|span|italic|bold|underline)(?:\s[^<>]{0,300})?/?>",
                         re.IGNORECASE)


def clean(text: str | None) -> str:
    """Text for the index or a result row: entities decoded, markup removed, contact details
    removed, spaces collapsed."""
    t = _TAG.sub(" ", _INLINE_TAG.sub("", html.unescape(text or "")))
    return re.sub(r"\s+", " ", entities.strip_contacts(t)).strip()


def article_license(value: str) -> str:
    """The family of a paper's license: "cc by-nc-nd" → "CC BY-NC-ND", "cc by 4.0" → "CC BY",
    "cc0" → "CC0"; "" when unknown, "other" otherwise."""
    lic = (value or "").lower().replace("_", "-").strip()
    if not lic:
        return ""
    if lic.startswith("cc0") or "public domain" in lic:
        return "CC0"
    m = re.match(r"cc[\s-]?by((?:[\s-](?:nc|sa|nd))*)", lic)
    if m:
        parts = [p.upper() for p in re.split(r"[\s-]+", m[1]) if p]
        return "CC BY" + ("-" + "-".join(parts) if parts else "")
    return "other"


_CODE_LICENSES: tuple[tuple[str, str], ...] = (
    ("mit", "MIT"), ("apache", "Apache"), ("bsd", "BSD"), ("agpl", "GPL"), ("lgpl", "GPL"), ("gpl", "GPL"),
    ("mpl", "MPL"), ("cc0", "CC0"), ("unlicense", "Unlicense"), ("isc", "ISC"), ("artistic", "Artistic"),
    ("epl", "EPL"), ("zlib", "zlib"),
)


def code_license(value: str) -> str:
    """The family of a repository's license: "GPL-3.0" → "GPL", "CC-BY-4.0" → "CC BY";
    "none" when the repository has none."""
    lic = (value or "").lower().strip()
    if not lic:
        return "none"
    for prefix, family in _CODE_LICENSES:
        if lic.startswith(prefix):
            return family
    if lic.startswith(("cc-by", "cc by")):
        return article_license(lic)
    return "other"


_FORGE = re.compile(r"^(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)/(.+)$")


def short_name(repo: str, url: str) -> str:
    """A repository as one reads it at a glance: "owner/repo", "Zenodo 123", "OSF abcde" (the
    same rule as shortName in website/src/lib/catalog.ts)."""
    m = _FORGE.match(repo)
    if m:
        u = re.match(r"^https?://(?:www\.)?[^/]+/([^?#]+?)(?:\.git)?/?$", url or "")
        return u[1] if u and u[1].lower() == m[1] else m[1]
    z = re.match(r"^(zenodo|osf|figshare):(.+)$", repo)
    if z:
        return f"{ {'zenodo': 'Zenodo', 'osf': 'OSF', 'figshare': 'figshare'}[z[1]] } {z[2]}"
    return repo


def _web(url: str | None) -> str:
    return url if url and re.match(r"https?://", url, re.IGNORECASE) else ""


def _cut(text: str, name: str) -> str:
    limit = MAX_CHARS.get(name, 4_000)
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0]


def _unique(values: Iterable[str]) -> list[str]:
    """The non-empty values, each once (without regard to case), in their order."""
    seen: set[str] = set()
    out = []
    for v in values:
        if v and v.casefold() not in seen:
            seen.add(v.casefold())
            out.append(v)
    return out


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _hash(values: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                        .encode("utf-8")).hexdigest()[:20]


# ---------------------------------------------------------------------------------------
# The projection.

@dataclass
class Row:
    db: str
    table: str
    key: str
    values: dict[str, Any]
    hash: str = ""

    def __post_init__(self) -> None:
        self.hash = self.hash or _hash(self.values)


@dataclass
class Paper:
    pid: int
    article_id: str
    rows: list[Row]
    #: (code, value) pairs, for the counts of the unfiltered view.
    facets: list[tuple[str, str]]


@dataclass
class Projection:
    papers: dict[int, Paper]

    def rows(self) -> Iterator[Row]:
        for p in self.papers.values():
            yield from p.rows


def assign_pids(state: sqlite3.Connection, published: dict[str, str]) -> dict[str, int]:
    """Each paper's key: kept while its day is the same, else a new one in its new day.
    A key is never given to another paper."""
    known = {r["article_id"]: r["pid"] for r in state.execute("SELECT article_id, pid FROM d1_pid")}
    last: dict[int, int] = {}
    for pid in known.values():
        last[pid // KEY_DAY] = max(last.get(pid // KEY_DAY, -1), pid % KEY_DAY)
    out: dict[str, int] = {}
    for aid in sorted(published, key=lambda a: (day_key(published[a]), a)):
        day = day_key(published[aid])
        pid = known.get(aid)
        if pid is None or pid // KEY_DAY != day:
            n = last.get(day, -1) + 1
            if n >= KEY_DAY:
                raise ValueError(f"more than {KEY_DAY} papers on day {day}")
            last[day] = n
            pid = day * KEY_DAY + n
            state.execute("INSERT OR REPLACE INTO d1_pid (article_id, pid) VALUES (?, ?)", (aid, pid))
        out[aid] = pid
    state.commit()
    return out


def _canonical(values: dict[tuple[str, str], Counter[str]]) -> dict[tuple[str, str], str]:
    """For each facet and normalized value, the form written most often ("NeuroImage" rather
    than "Neuroimage"): one value, one spelling, in the counts and in the index."""
    return {k: sorted(forms.items(), key=lambda kv: (-kv[1], kv[0]))[0][0] for k, forms in values.items()}


def project(con: sqlite3.Connection, state: sqlite3.Connection) -> Projection:
    """The rows of both databases for every paper in scope."""
    pages = entities.PAGES_SQL
    articles = {r["id"]: r for r in con.execute(f"SELECT * FROM article WHERE id IN ({pages})")}
    journals = {r["id"]: r for r in con.execute("SELECT * FROM journal")}
    names: dict[str, list[str]] = defaultdict(list)
    rors: dict[str, list[str]] = defaultdict(list)
    for r in con.execute(f"SELECT article_id, name, given, family, ror, affiliations FROM paper_author "
                         f"WHERE article_id IN ({pages}) ORDER BY article_id, position"):
        name = r["name"] or " ".join(x for x in (r["given"], r["family"]) if x)
        name = clean(name)
        if name:
            names[r["article_id"]].append(name)
        rors[r["article_id"]] += entities.ror_pairs(r["ror"], r["affiliations"])[0]
    # OpenAlex's topics (their names, searched like keywords).
    topics: dict[str, list[str]] = defaultdict(list)
    for r in con.execute(f"SELECT p.article_id, t.name FROM paper_topic p JOIN topic t ON t.id = p.topic_id "
                         f"WHERE p.article_id IN ({pages}) ORDER BY p.article_id, p.is_primary DESC, p.topic_id"):
        topics[r["article_id"]].append(clean(r["name"]))
    subjects: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for r in con.execute(f"SELECT article_id, scheme, term FROM paper_subject WHERE article_id IN ({pages})"):
        subjects[r["article_id"]][r["scheme"]].append(clean(r["term"]))
    repos = {r["repo"]: r for r in con.execute(
        f"SELECT * FROM repository WHERE repo IN (SELECT repo FROM link WHERE role = 'code' AND article_id IN ({pages}))")}
    code_links: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for r in con.execute(f"SELECT article_id, repo, url, host FROM link WHERE role = 'code' AND article_id IN ({pages}) "
                         "ORDER BY article_id, repo"):
        code_links[r["article_id"]].append(r)
    files_read = {r[0]: r[1] for r in con.execute("SELECT repo, COUNT(*) FROM file WHERE kind != 'note' GROUP BY repo")}
    known_datasets = {r["id"]: r["repository"] for r in con.execute("SELECT id, repository FROM dataset")}
    datasets: dict[str, set[str]] = defaultdict(set)
    # The same dataset ids as the Datasets pages (enrich.dataset_id: the accession of a GEO or
    # SRA series; a database's root without an accession is not a dataset).
    for r in con.execute(f"SELECT article_id, repo, url FROM link WHERE role = 'data' AND article_id IN ({pages})"):
        ident = enrich.dataset_id(r["repo"], r["url"] or "")
        if ident is not None and not entities.has_contact(ident[0]):
            datasets[r["article_id"]].add(ident[0])
    for r in con.execute(f"SELECT article_id, dataset_id FROM paper_dataset WHERE article_id IN ({pages})"):
        if not entities.has_contact(r[1]):
            datasets[r[0]].add(r[1])
    tools: dict[str, dict[str, str]] = defaultdict(dict)
    for r in con.execute(f"SELECT l.article_id, t.tool_id, o.name FROM repo_tool t "
                         f"JOIN link l ON l.repo = t.repo AND l.role = 'code' LEFT JOIN tool o ON o.id = t.tool_id "
                         f"WHERE l.article_id IN ({pages})"):
        tools[r["article_id"]][r["tool_id"]] = clean(r["name"] or r["tool_id"])
    marks = ", ".join(f"'{f}'" for f in CATEGORY_FACETS)
    categories: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
    for r in con.execute(f"SELECT * FROM paper_category WHERE article_id IN ({pages}) AND facet IN ({marks})"):
        categories[(r["article_id"], r["facet"])].append(r)
    # A tracing map withheld at a removal request (catalog.withheld): neither its matches nor its DOI.
    maps_withheld = catalog.withheld(con).maps
    pairs = {r[0]: r[1] for r in con.execute("SELECT article_id, COUNT(*) FROM alignment GROUP BY article_id")
             if r[0] not in maps_withheld}
    maps = {r[0]: r[1] for r in con.execute("SELECT article_id, doi FROM card_doi WHERE instance = 'zenodo' AND doi != ''")
            if r[0] not in maps_withheld}
    rrids: dict[str, list[str]] = defaultdict(list)
    for r in con.execute(f"SELECT article_id, rrid FROM paper_rrid WHERE article_id IN ({pages})"):
        rrids[r[0]].append(r[1])

    pids = assign_pids(state, {aid: a["published"] or "" for aid, a in articles.items()})

    # First pass: every paper's facet values, so that each value gets one spelling.
    facet_values: dict[str, list[tuple[str, str]]] = {}
    spellings: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    for aid, a in articles.items():
        j = journals.get(a["journal_id"] or "")
        journal = clean((j["title"] if j is not None else "") or a["journal"])
        values: list[tuple[str, str]] = [("st", a["status"])]
        if re.fullmatch(r"\d{4}", (a["published"] or "")[:4]):
            values.append(("yr", a["published"][:4]))
        if a["type"]:
            values.append(("ty", a["type"]))
        if journal:
            values.append(("jo", journal))
        for facet in CATEGORY_FACETS:
            for v in sorted(entities._kept(categories.get((aid, facet), []))):   # the Browse pages' rule
                v = re.sub(r"\s+", " ", v or "").strip()
                if v:
                    values.append((CODE[facet], v))
        for name in sorted(set(tools[aid].values())):
            values.append(("to", name))
        languages: set[str] = set()
        for link in code_links[aid]:
            d = repos.get(link["repo"])
            if d is not None:
                try:
                    languages |= {str(k) for k in json.loads(d["languages"] or "{}")}
                except ValueError:
                    pass
            values.append(("ho", link["host"] or ""))
            values.append(("cl", code_license(d["license"] if d is not None else "")))
        values += [("la", x) for x in sorted(languages)]
        values += [("ds", known_datasets.get(x) or enrich.data_repository(x)) for x in sorted(datasets[aid])]
        if article_license(a["license"]):
            values.append(("li", article_license(a["license"])))
        if pairs.get(aid):
            values.append(("al", "yes"))
        if a["is_open_access"] is not None:
            values.append(("oa", "yes" if a["is_open_access"] else "no"))
        seen: set[tuple[str, str]] = set()
        kept = []
        for code, v in values:
            v = clean(v)
            k = (code, normalize_value(v))
            if v and k not in seen:
                seen.add(k)
                kept.append((code, v))
                spellings[k][v] += 1
        facet_values[aid] = kept
    spelled = _canonical(spellings)

    papers: dict[int, Paper] = {}
    for aid, a in articles.items():
        pid = pids[aid]
        values = [(code, spelled[(code, normalize_value(v))]) for code, v in facet_values[aid]]
        j = journals.get(a["journal_id"] or "")
        journal = clean((j["title"] if j is not None else "") or a["journal"])
        title = clean(a["title"])
        code: list[dict[str, str]] = []
        seen_repos: set[str] = set()
        files = 0
        for link in code_links[aid]:
            if link["repo"] in seen_repos:
                continue
            seen_repos.add(link["repo"])
            d = repos.get(link["repo"])
            url = link["url"] if (link["url"] or "").startswith("http") else (
                f"https://doi.org/{link['repo'][4:]}" if link["repo"].startswith("doi:") else
                catalog.file_url(d, "") if d is not None and link["repo"].startswith("supp:") else link["url"])
            code.append({"name": clean(short_name(link["repo"], _web(url))), "url": _web(url),
                         "license": clean(d["license"] if d is not None else "")})
            files += files_read.get(link["repo"], 0)
        cited = a["cited_by_count"]
        doc: dict[str, Any] = {
            "slug": catalog.slug(aid), "doi": a["doi"], "title": title, "journal": journal,
            "published": a["published"] or "", "status": a["status"], "code": code, "data": len(datasets[aid]),
            "files": files, "pairs": pairs.get(aid, 0), "cited": cited,
        }
        if maps.get(aid):
            doc["map"] = maps[aid]
        doc = entities.scrub(doc)
        languages = sorted({v for c, v in values if c == "la"})
        hosts = sorted({v for c, v in values if c == "ho"})
        paper_row = Row(CATALOG, "papers", str(pid), {
            "pid": pid, "id": aid, "slug": doc["slug"], "doi": a["doi"], "title": title, "journal": journal,
            "journal_id": a["journal_id"] or "", "published": a["published"] or "",
            "year": int(a["published"][:4]) if re.fullmatch(r"\d{4}", (a["published"] or "")[:4]) else None,
            "type": a["type"] or "", "status": a["status"], "oa": a["is_open_access"],
            "license": article_license(a["license"]), "cited_by_count": cited, "has_alignment": int(bool(pairs.get(aid))),
            "languages": _json(languages), "hosts": _json(hosts), "doc": _json(doc),
        })
        s = subjects.get(aid, {})
        if aid in names:
            authors = names[aid]
        else:
            try:
                authors = [clean(str(x)) for x in json.loads(a["authors"] or "[]") if isinstance(x, str)]
            except ValueError:
                authors = []
        ids = [a["doi"], a["pmid"], a["pmcid"], a["openalex_id"], *sorted(datasets[aid]), *rrids.get(aid, []),
               *([j["issn"], j["eissn"]] if j is not None else []), maps.get(aid, ""), *_unique(rors.get(aid, []))]
        text = {
            "title": title,
            "keywords": "; ".join(s.get("keyword", []) + s.get("subject", []) + topics.get(aid, [])),
            "mesh": "; ".join(s.get("mesh", [])),
            "authors": "; ".join(x for x in authors if x),
            "journal": "; ".join(_unique([journal, clean(j["nlm_ta"]) if j is not None else ""])),
            "repos": " ".join(sorted(seen_repos | {c["name"] for c in code})),
            "tools": " ".join(sorted(set(tools[aid]) | set(tools[aid].values()))),
            "ids": " ".join(_unique([clean(x) for x in ids])),
            # D1's rule: an abstract is indexed only under an open license, and never stored.
            "abstract": clean(a["abstract"]) if catalog.statement_is_publishable(a["license"]) else "",
        }
        fts_values: dict[str, Any] = {"rowid": pid, **{k: _cut(v, k) for k, v in text.items()}}
        fts_values["facets"] = " ".join([ALL_TOKEN, *sorted({facet_token(c, v) for c, v in values})])
        fts_values["fx"] = _json([cited or 0, *[x for pair in values for x in pair]])
        papers[pid] = Paper(pid, aid, [paper_row, Row(SEARCH, "paper_fts", str(pid), fts_values)], values)
    return Projection(papers)


# ---------------------------------------------------------------------------------------
# SQL.

def literal(value: Any) -> str:
    """An SQL literal: the generated files carry their values, as `wrangler d1 execute --file`
    and the REST API take them."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value) if math.isfinite(value) else "NULL"
    return "'" + str(value).replace("\x00", "").replace("'", "''") + "'"


_KEYS: dict[str, tuple[str, ...]] = {"papers": ("pid",), "paper_fts": ("rowid",), "facet_counts": ("facet", "rank"),
                                      "meta": ("name",)}


def upsert(row: Row) -> str:
    cols = list(row.values)
    values = ", ".join(literal(row.values[c]) for c in cols)
    if row.table == "paper_fts":
        # A contentless-delete FTS5 table replaces a row by its rowid.
        return f"INSERT OR REPLACE INTO paper_fts ({', '.join(cols)}) VALUES ({values});"
    keys = _KEYS[row.table]
    sets = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in keys)
    return f"INSERT INTO {row.table} ({', '.join(cols)}) VALUES ({values}) ON CONFLICT ({', '.join(keys)}) DO UPDATE SET {sets};"


def delete(db: str, table: str, key: str) -> str:
    if table == "papers":
        return f"DELETE FROM papers WHERE pid = {int(key)};"
    if table == "paper_fts":
        return f"DELETE FROM paper_fts WHERE rowid = {int(key)};"
    if table == "facet_counts":
        facet, rank = json.loads(key)
        return f"DELETE FROM facet_counts WHERE facet = {literal(facet)} AND rank = {int(rank)};"
    return f"DELETE FROM meta WHERE name = {literal(key)};"


@dataclass
class Statement:
    db: str
    table: str
    key: str
    #: None for a deletion.
    hash: str | None
    sql: str

    @property
    def rows(self) -> int:
        return 1 if self.hash is None else WRITE_COST[(self.db, self.table)]


@dataclass
class Plan:
    target: str
    statements: list[Statement] = field(default_factory=list)
    new: int = 0
    changed: int = 0
    deleted: int = 0
    #: Papers left for the next push: the budget is spent.
    deferred: int = 0
    summary: int = 0
    papers_after: int = 0
    budget_left: int = 0
    #: After a push: the statements the target accepted, and the rows written.
    applied: int = 0
    written: int = 0

    @property
    def rows(self) -> int:
        return sum(s.rows for s in self.statements)

    @property
    def complete(self) -> bool:
        return self.deferred == 0

    def describe(self) -> str:
        return (f"{self.target}: {len(self.statements)} statements, ~{self.rows} rows written of {self.budget_left} "
                f"left today; papers: {self.new} new, {self.changed} changed, {self.deleted} deleted, "
                f"{self.deferred} left for the next push; {self.summary} summary rows; "
                f"{self.papers_after} papers in D1 after the push")


def utc_day(t: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t if t is not None else time.time()))


def budget_spent(state: sqlite3.Connection, target: str, day: str) -> int:
    r = state.execute("SELECT rows FROM d1_budget WHERE target = ? AND day = ?", (target, day)).fetchone()
    return r["rows"] if r else 0


def build(con: sqlite3.Connection, state: sqlite3.Connection, target: str = "local", *,
          budget: int = DAILY_BUDGET, now: float | None = None) -> Plan:
    """What the next push to `target` sends: the rows that changed, within what is left of
    today's budget."""
    proj = project(con, state)
    synced: dict[tuple[str, str, str], str] = {
        (r["db"], r["tbl"], r["key"]): r["hash"]
        for r in state.execute("SELECT db, tbl, key, hash FROM d1_sync WHERE target = ?", (target,))}
    plan = Plan(target, budget_left=max(0, budget - budget_spent(state, target, utc_day(now))))
    room = plan.budget_left - SUMMARY_RESERVE
    used = 0

    # 1. The papers that left the scope (D7, D2): first, so they leave the site first.
    paper_tables = ((SEARCH, "paper_fts"), (CATALOG, "papers"))
    gone = sorted({int(k) for (db, tbl, k) in synced if (db, tbl) in paper_tables and int(k) not in proj.papers},
                  reverse=True)
    units: list[tuple[str, list[Statement]]] = []
    for pid in gone:
        units.append(("deleted", [Statement(db, tbl, str(pid), None, delete(db, tbl, str(pid)))
                                  for db, tbl in paper_tables if (db, tbl, str(pid)) in synced]))
    # 2. New papers, the most recent first; 3. changed papers.
    new, changed = [], []
    for pid in sorted(proj.papers, reverse=True):
        rows = [r for r in proj.papers[pid].rows if synced.get((r.db, r.table, r.key)) != r.hash]
        if not rows:
            continue
        unit = [Statement(r.db, r.table, r.key, r.hash, upsert(r)) for r in rows]
        is_new = all((r.db, r.table, r.key) not in synced for r in proj.papers[pid].rows)
        (new if is_new else changed).append(("new" if is_new else "changed", unit))
    units += new + changed

    for kind, unit in units:
        cost = sum(s.rows for s in unit)
        if plan.deferred or used + cost > room:
            # The budget is reached: this paper and every one after it wait for the next push, in
            # the same order (a smaller one never jumps the queue).
            plan.deferred += 1
            continue
        used += cost
        plan.statements += unit
        setattr(plan, kind, getattr(plan, kind) + 1)

    # 4. The summary, from what the databases hold after this push.
    after = dict(synced)
    for s in plan.statements:
        if s.hash is None:
            after.pop((s.db, s.table, s.key), None)
        else:
            after[(s.db, s.table, s.key)] = s.hash
    current = [p for p in proj.papers.values() if all(after.get((r.db, r.table, r.key)) == r.hash for r in p.rows)]
    plan.papers_after = sum(1 for (db, tbl, _) in after if (db, tbl) == (CATALOG, "papers"))
    if plan.budget_left >= SUMMARY_RESERVE:
        summary = summary_rows(current, plan.papers_after, now, changed=bool(plan.statements))
        wanted = {(r.db, r.table, r.key): r for r in summary}
        for db, tbl, key in sorted(synced):
            if (db, tbl) in ((CATALOG, "facet_counts"), (CATALOG, "meta")) and (db, tbl, key) not in wanted:
                if tbl == "meta" and key == "updated_at":
                    continue      # kept: it only changes with a push that changes something
                plan.statements.append(Statement(db, tbl, key, None, delete(db, tbl, key)))
                plan.summary += 1
        for k, r in wanted.items():
            if synced.get(k) != r.hash:
                plan.statements.append(Statement(r.db, r.table, r.key, r.hash, upsert(r)))
                plan.summary += 1
    return plan


def summary_rows(papers: Iterable[Paper], total: int, now: float | None, *, changed: bool) -> list[Row]:
    """The counts of the unfiltered view, over `papers` (those D1 holds, up to date), and the
    number of papers."""
    counts: dict[str, Counter[str]] = defaultdict(Counter)
    for p in papers:
        for code, value in p.facets:
            counts[code][value] += 1
    rows = []
    for param, code, top in FACETS:
        ranked = sorted(counts[code].items(), key=lambda kv: (-kv[1], kv[0]))[:top]
        for rank, (value, n) in enumerate(ranked, 1):
            rows.append(Row(CATALOG, "facet_counts", _json([param, rank]),
                            {"facet": param, "rank": rank, "value": value, "papers": n}))
    rows.append(Row(CATALOG, "meta", "papers", {"name": "papers", "value": str(total)}))
    if changed:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now if now is not None else time.time()))
        rows.append(Row(CATALOG, "meta", "updated_at", {"name": "updated_at", "value": stamp}))
    return rows


# ---------------------------------------------------------------------------------------
# Files, and what the targets accepted.

@dataclass
class Chunk:
    db: str
    statements: list[Statement]
    path: Path | None = None

    @property
    def sql(self) -> str:
        return "\n".join(s.sql for s in self.statements) + "\n"


def chunks(plan: Plan, *, statements: int = LOCAL_STATEMENTS, max_bytes: int = 4_000_000) -> list[Chunk]:
    """The plan in the order the targets take it: deletions from the index first (a paper stops
    being found), then the catalogue, then the index's new rows (a paper is found once its
    result row exists)."""
    phases: list[tuple[str, list[Statement]]] = [
        (SEARCH, [s for s in plan.statements if s.db == SEARCH and s.hash is None]),
        (CATALOG, [s for s in plan.statements if s.db == CATALOG]),
        (SEARCH, [s for s in plan.statements if s.db == SEARCH and s.hash is not None]),
    ]
    out: list[Chunk] = []
    for db, stmts in phases:
        current: list[Statement] = []
        size = 0
        for s in stmts:
            n = len(s.sql.encode("utf-8")) + 1
            if current and (len(current) >= statements or size + n > max_bytes):
                out.append(Chunk(db, current))
                current, size = [], 0
            current.append(s)
            size += n
        if current:
            out.append(Chunk(db, current))
    return out


def write(plan: Plan, folder: Path, *, now: float | None = None) -> list[Chunk]:
    """The plan as SQL files, one per chunk: `<folder>/<target>-<time>/NNN-<database>.sql`."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now if now is not None else time.time()))
    out = folder / f"{plan.target}-{stamp}"
    result = chunks(plan)
    if result:
        out.mkdir(parents=True, exist_ok=True)
    for i, c in enumerate(result, 1):
        c.path = out / f"{i:03d}-{DATABASES[c.db]}.sql"
        c.path.write_text(c.sql, encoding="utf-8")
    return result


def record(state: sqlite3.Connection, target: str, chunk: Chunk, rows_written: int, *, now: float | None = None) -> None:
    """A chunk the target accepted: its rows are now known there, and today's budget spent."""
    t = now if now is not None else time.time()
    for s in chunk.statements:
        if s.hash is None:
            state.execute("DELETE FROM d1_sync WHERE target = ? AND db = ? AND tbl = ? AND key = ?",
                          (target, s.db, s.table, s.key))
        else:
            state.execute("INSERT OR REPLACE INTO d1_sync (target, db, tbl, key, hash, pushed_at) VALUES (?,?,?,?,?,?)",
                          (target, s.db, s.table, s.key, s.hash, t))
    state.execute("INSERT INTO d1_budget (target, day, rows) VALUES (?, ?, ?) ON CONFLICT (target, day) "
                  "DO UPDATE SET rows = rows + excluded.rows", (target, utc_day(t), rows_written))
    state.commit()


# ---------------------------------------------------------------------------------------
# Targets.

class PushError(RuntimeError):
    pass


def _run(cmd: list[str], cwd: Path) -> str:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise PushError(f"{' '.join(cmd[:6])} failed: " + (r.stderr or r.stdout).strip()[-800:])
    return r.stdout


def migrate_local(website: Path = WEBSITE, env: str = "local") -> None:
    """The local D1 databases of `wrangler dev --env local` (website/.wrangler/state), at the
    schema of migrations/d1/."""
    for db in (CATALOG, SEARCH):
        _run(["npx", "wrangler", "d1", "migrations", "apply", DATABASES[db], "--local", "--env", env], website)


def apply_local(chunk: Chunk, website: Path = WEBSITE, env: str = "local") -> int:
    """One file into the local D1 (`wrangler d1 execute --local --file`); returns the rows
    written, as estimated (wrangler does not report them for a file)."""
    assert chunk.path is not None
    _run(["npx", "wrangler", "d1", "execute", DATABASES[chunk.db], "--local", "--env", env,
          "--file", str(chunk.path.resolve()), "--yes"], website)
    return sum(s.rows for s in chunk.statements)


def remote_token() -> str:
    """The Cloudflare API token of the push (D1 edit rights only): CLOUDFLARE_D1_TOKEN, else the
    macOS keychain (`org.oscr.cloudflare-d1`). Never in the repository nor in the settings."""
    if os.environ.get("CLOUDFLARE_D1_TOKEN", "").strip():
        return os.environ["CLOUDFLARE_D1_TOKEN"].strip()
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", "org.oscr.cloudflare-d1", "-w"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def apply_remote(chunk: Chunk, *, account_id: str, database_id: str, token: str,
                 post: Callable[..., Any] | None = None) -> int:
    """One chunk into a Cloudflare D1 database, through the REST API: POST
    /accounts/{account}/d1/database/{database}/query, the statements joined by semicolons (run
    as a batch). Returns the rows written, as D1 counts them (`meta.rows_written`).

    Written for the owner's approval (docs/SEARCH.md); never called by the tests."""
    import httpx
    post = post or httpx.post
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
    r = post(url, headers={"Authorization": f"Bearer {token}"}, json={"sql": chunk.sql}, timeout=120)
    try:
        body = r.json()
    except ValueError:
        raise PushError(f"D1 answered {r.status_code}, not JSON") from None
    if r.status_code != 200 or not body.get("success"):
        raise PushError(f"D1 answered {r.status_code}: {json.dumps(body.get('errors', body))[:600]}")
    return sum(int((res.get("meta") or {}).get("rows_written") or 0) for res in body.get("result", []))


def apply_remote_wrangler(chunk: Chunk, website: Path = WEBSITE) -> int:
    """One file into the Cloudflare database with `wrangler d1 execute --remote --file`, under
    wrangler's own login (`npx wrangler login`, the one the nightly deployment already uses): no
    API token then. The databases are found by name, bound in website/wrangler.toml. Returns the
    rows written, as estimated (wrangler does not report them for a file)."""
    assert chunk.path is not None
    _run(["npx", "wrangler", "d1", "execute", DATABASES[chunk.db], "--remote",
          "--file", str(chunk.path.resolve()), "--yes"], website)
    return sum(s.rows for s in chunk.statements)


def remote_chunks(plan: Plan) -> list[Chunk]:
    """Smaller chunks for the REST API: a call stays well under its limits (30 s, 100 KB per
    statement)."""
    return chunks(plan, statements=REMOTE_STATEMENTS, max_bytes=REMOTE_BYTES)


def push(con: sqlite3.Connection, state: sqlite3.Connection, target: str, *, folder: Path,
         budget: int = DAILY_BUDGET, settings: dict[str, str] | None = None, website: Path = WEBSITE,
         report: Callable[[str], None] = print) -> Plan:
    """Build the delta, send it chunk by chunk, record each chunk the target accepted. A failed
    chunk stops the push: what was accepted stays recorded, the rest goes next time."""
    plan = build(con, state, target, budget=budget)
    report(plan.describe())
    started, written = time.time(), 0
    if target == "local":
        todo = write(plan, folder)
        migrate_local(website)
        send = lambda c: apply_local(c, website)  # noqa: E731
    elif target == "remote":
        cfg = settings or {}
        ids = {CATALOG: cfg.get("OSCR_D1_CATALOG_ID", ""), SEARCH: cfg.get("OSCR_D1_SEARCH_ID", "")}
        account, token = cfg.get("OSCR_D1_ACCOUNT_ID", ""), remote_token()
        if account and all(ids.values()) and token:
            # The REST API: D1 reports the rows each chunk wrote.
            todo = remote_chunks(plan)
            send = lambda c: apply_remote(c, account_id=account, database_id=ids[c.db], token=token)  # noqa: E731
        else:
            # No token: wrangler's own login, as the deployment (docs/SEARCH.md).
            todo = write(plan, folder)
            send = lambda c: apply_remote_wrangler(c, website)  # noqa: E731
    else:
        raise ValueError(f"unknown target {target!r}")
    done = 0
    try:
        for c in todo:
            rows = send(c)
            record(state, target, c, rows)
            written += rows
            done += len(c.statements)
    finally:
        state.execute("INSERT INTO d1_push (target, at, statements, rows, complete, summary) VALUES (?,?,?,?,?,?)",
                      (target, started, done, written, int(plan.complete and done == len(plan.statements)),
                       plan.describe()))
        state.commit()
    plan.applied, plan.written = done, written
    if todo and todo[0].path is not None:
        # Applied: the files of a push through wrangler are not kept (a full push at the full
        # stock is ~400 MB of SQL). A failed push keeps them, and `oscr d1 build` writes them to
        # be read.
        shutil.rmtree(todo[0].path.parent, ignore_errors=True)
    return plan


def status(state: sqlite3.Connection) -> str:
    lines = []
    for r in state.execute("SELECT target, db, tbl, COUNT(*) AS n FROM d1_sync GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"):
        lines.append(f"{r['target']}: {DATABASES.get(r['db'], r['db'])}.{r['tbl']}: {r['n']} rows")
    for r in state.execute("SELECT target, day, rows FROM d1_budget ORDER BY day DESC, target LIMIT 6"):
        lines.append(f"{r['target']}: {r['rows']} rows written on {r['day']} (UTC)")
    for r in state.execute("SELECT * FROM d1_push ORDER BY at DESC LIMIT 3"):
        when = time.strftime("%Y-%m-%d %H:%M", time.localtime(r["at"]))
        lines.append(f"push {when}: {r['summary']}")
    return "\n".join(lines) or "nothing pushed yet"


def forget(state: sqlite3.Connection, target: str) -> int:
    """Forget what `target` holds, after its databases were recreated empty: the next push sends
    every row again. The keys stay. Returns the number of rows forgotten."""
    n = state.execute("DELETE FROM d1_sync WHERE target = ?", (target,)).rowcount
    state.commit()
    return n


def command(con: sqlite3.Connection, action: str, *, target: str, budget: int, state_path: Path, folder: Path,
            settings: dict[str, str] | None = None, reset: bool = False) -> str:
    """`oscr d1 build|push|status [--local|--remote] [--reset]`."""
    state = open_state(state_path)
    try:
        if reset:
            print(f"{target}: {forget(state, target)} rows forgotten; the next push sends everything")
        if action == "status":
            return status(state)
        if action == "build":
            plan = build(con, state, target, budget=budget)
            files = write(plan, folder)
            return plan.describe() + "".join(f"\n  {c.path}" for c in files)
        plan = push(con, state, target, folder=folder, budget=budget, settings=settings)
        return f"{target}: {plan.applied} statements applied, {plan.written} rows written" + (
            "" if plan.complete else f"; {plan.deferred} papers wait for tomorrow's budget")
    finally:
        state.close()
