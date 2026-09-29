"""OpenAlex: what a paper's other records lack — the institutions of its authors (ROR ids,
countries), its open-access status, its topics, citations, references and related works.

**The key.** OpenAlex needs a free API key since 2026-02-13; the owner created one (decision
D10). It comes from the macOS keychain (`org.oscr.openalex`) or OPENALEX_API_KEY
(`net.openalex_key`), and travels in the `Authorization` header that `net.Client` adds for
api.openalex.org — never in a URL: the cache is keyed by URL, the logs print URLs, and error
messages quote them.

**The budget.** $1 of free credit a day, reset at midnight UTC. One work looked up by its DOI
costs nothing (measured 2026-09-28: `x-ratelimit-cost-usd: 0`); a list or filter call costs
$0.0001, a search $0.001. So OSCR only looks works up one at a time, by DOI (else PMID), a few a
second (`net.INTERVALS`; OpenAlex allows 100). `Budget` keeps each UTC day's calls and spending
in the database (cursor `openalex:budget`), from what OpenAlex answers (`x-ratelimit-cost-usd`,
`x-ratelimit-remaining-usd`), and stops before the credit runs out. A 429 — the day's budget
spent, or too many requests a second — gets one pause and one more try; a second one stops
every OpenAlex call until the reset.

**What is kept.** `parse` turns a work into OSCR's shapes. `store` keeps it in `openalex_record`
(without its lists of works) and writes what only OpenAlex knows: the work's id, its
open-access status and link, a linked preprint, the institutions (ROR), the topics, the
referenced and related works. `record` and `complete_authors` add the rest to a paper's record
during the enrichment (`enrich.enrich_article`), only where the paper's own text (JATS) and
Europe PMC said nothing: ORCID iDs, the ROR ids of the authors' institutions, the corresponding
authors, the funders, the citation count, the open-access flag, the number of references, the
language, volume, issue, pages and publisher. OpenAlex never replaces a value another source
gave (`may_write`).

**Whose ORCID iD.** An author gets an ORCID iD from OpenAlex only when the publisher deposited
it for that authorship (`raw_orcid`): the iD of OpenAlex's author profile comes from its
disambiguation, which merges people wrongly at times, and an ORCID iD on a paper makes its
holder a verified author of it (sign-in, corrections, map validation). The profile's iD only
helps to recognize the author among the paper's.

**No email address.** OpenAlex publishes none, but its raw affiliation strings are the
publishers' text: they are scrubbed like every other string (`biblio._scrub`).
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

from .. import biblio, db
from ..net import Client, Outage, Response, Unavailable

BASE = "https://api.openalex.org"
SOURCE = "openalex"
FOUND, MISSING = "found", "missing"

#: The fields asked for (`select`): what `parse` reads, nothing else — neither the abstract
#: (article text) nor the machine-made concepts and keywords.
SELECT: tuple[str, ...] = (
    "id", "doi", "language", "primary_location", "type", "open_access", "authorships", "cited_by_count",
    "biblio", "is_retracted", "primary_topic", "topics", "locations", "funders", "awards",
    "referenced_works_count", "referenced_works", "related_works")

#: What a call costs, in US dollars (help.openalex.org, 2026-09-28), when OpenAlex does not say.
COSTS: dict[str, float] = {"single": 0.0, "list": 0.0001, "search": 0.001}
#: The free credit of a day, and what is left untouched of it.
DAILY_USD: float = 1.0
RESERVE_USD: float = 0.05
#: A paper OpenAlex does not know yet (a new paper appears there a few days after its
#: publication) is looked up again after this many days.
RETRY_MISSING_DAYS: float = 7
#: A second 429 in a row stops OpenAlex until the reset; the first one waits this long at most.
BACKOFF_S: float = 30.0

#: Sources a value may come from that OpenAlex never replaces: the owner, the people who
#: correct a record, the paper's own text, Europe PMC, Retraction Watch, Crossref.
ABOVE_OPENALEX: frozenset[str] = frozenset({"owner", "author", "maintainer", "submitter", "jats", "epmc",
                                            "retraction-watch", "crossref"})


class Paused(RuntimeError):
    """OpenAlex's calls wait for the next reset (midnight UTC): the day's credit is spent, or
    OpenAlex said 429 twice."""


# ---------------------------------------------------------------------------------------
# The budget.

def _utc_day(t: float) -> str:
    return datetime.fromtimestamp(t, UTC).strftime("%Y-%m-%d")


def next_reset(t: float) -> float:
    """The next midnight UTC after `t`."""
    day = datetime.fromtimestamp(t, UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return (day + timedelta(days=1)).timestamp()


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


class Budget:
    """Each UTC day's OpenAlex calls and spending, kept in the database (`cursor`), and the
    pause after a 429. The caller commits."""

    KEY = "openalex:budget"

    def __init__(self, con: sqlite3.Connection, *, limit_usd: float = DAILY_USD, reserve_usd: float = RESERVE_USD,
                 clock: Any = time.time) -> None:
        self.con, self.limit, self.reserve, self.clock = con, limit_usd, reserve_usd, clock

    def state(self) -> dict[str, Any]:
        now = self.clock()
        try:
            s = json.loads(db.cursor(self.con, self.KEY, "{}"))
        except ValueError:
            s = {}
        if s.get("day") != _utc_day(now):
            s = {"day": _utc_day(now), "calls": 0, "cost_usd": 0.0, "remaining_usd": None,
                 "paused_until": s.get("paused_until", 0) if s.get("paused_until", 0) > now else 0,
                 "why": s.get("why", "") if s.get("paused_until", 0) > now else ""}
        return s

    def _save(self, s: dict[str, Any]) -> None:
        db.set_cursor(self.con, self.KEY, json.dumps(s))

    def check(self, kind: str = "single") -> None:
        """Raise Paused when OpenAlex must not be called now."""
        s = self.state()
        now = self.clock()
        if s["paused_until"] > now:
            until = datetime.fromtimestamp(s["paused_until"], UTC).strftime("%Y-%m-%d %H:%M UTC")
            raise Paused(f"OpenAlex paused until {until}: {s['why']}")
        left = s["remaining_usd"] if s["remaining_usd"] is not None else self.limit - s["cost_usd"]
        if COSTS.get(kind, 0.0) > 0 and left - COSTS[kind] < self.reserve:
            raise Paused(f"OpenAlex: ${left:.4f} of the day's credit left, kept in reserve")

    def record(self, r: Response, kind: str = "single") -> None:
        """Count a call, from OpenAlex's own figures when it gives them. The credit left decides
        the paid calls (`check`); the free ones go on until OpenAlex says 429."""
        s = self.state()
        s["calls"] += 1
        cost = _number(r.headers.get("x-ratelimit-cost-usd"))
        s["cost_usd"] = round(s["cost_usd"] + (COSTS.get(kind, 0.0) if cost is None else cost), 6)
        remaining = _number(r.headers.get("x-ratelimit-remaining-usd"))
        if remaining is not None:
            s["remaining_usd"] = remaining
        self._save(s)

    def pause(self, r: Response | None, why: str) -> None:
        s = self.state()
        s.update(self._until(r), why=why)
        self._save(s)

    def _until(self, r: Response | None) -> dict[str, float]:
        now = self.clock()
        reset = _number(r.headers.get("x-ratelimit-reset")) if r is not None else None
        return {"paused_until": now + reset if reset and reset > 0 else next_reset(now)}

    def summary(self) -> str:
        s = self.state()
        left = f", ${s['remaining_usd']:.2f} of credit left" if s["remaining_usd"] is not None else ""
        return f"{s['calls']} OpenAlex calls today (UTC), ${s['cost_usd']:.4f} spent{left}"


# ---------------------------------------------------------------------------------------
# The API.

def available() -> bool:
    """Whether the owner's key is there (without it, OpenAlex is not called at all)."""
    from ..net import openalex_key
    return bool(openalex_key())


def _lookup_url(doi: str = "", pmid: str = "") -> str:
    if doi:
        return f"{BASE}/works/doi:{quote(doi, safe='/()')}"
    return f"{BASE}/works/pmid:{quote(pmid, safe='')}"


def work(client: Client, budget: Budget, *, doi: str = "", pmid: str = "") -> dict | None:
    """One work, looked up by its DOI (else its PMID): a free call. None when OpenAlex does not
    know it. Raises Paused (no call now), Outage (the network), Unavailable (OpenAlex failed)."""
    if not doi and not pmid:
        return None
    url = _lookup_url(doi, pmid)
    for attempt in range(2):
        budget.check("single")
        r = client.get(url, params={"select": ",".join(SELECT)}, patient=False)
        if r.status == 0:
            raise Outage(f"OpenAlex: {r.text[:200]}")
        budget.record(r)
        if r.status == 429:
            remaining = _number(r.headers.get("x-ratelimit-remaining-usd"))
            if attempt == 0 and (remaining is None or remaining >= budget.reserve):
                # Too many requests a second, not the day's credit: one pause, one more try.
                time.sleep(min(BACKOFF_S, _number(r.headers.get("retry-after")) or 5.0))
                continue
            budget.pause(r, "OpenAlex answered 429 Too Many Requests")
            raise Paused("OpenAlex answered 429 Too Many Requests: no more calls until the reset")
        if r.status in (404, 410) or (400 <= r.status < 500 and r.status not in (401, 403)):
            return None          # not in OpenAlex (yet), or an identifier it cannot read
        if r.status in (401, 403):
            raise Unavailable(f"OpenAlex refused the key ({r.status})")
        if not r.ok:
            raise Unavailable(f"OpenAlex answered {r.status}")
        try:
            w = r.json()
        except ValueError:
            raise Unavailable("OpenAlex answered something that is not JSON") from None
        return w if isinstance(w, dict) and w.get("id") else None
    return None


# ---------------------------------------------------------------------------------------
# Parsing: a work → OSCR's shapes.

_ID = re.compile(r"(?:https?://openalex\.org/)?(?:[a-z_]+/)?([A-Za-z]?\d+)$")


def short_id(value: Any) -> str:
    """"https://openalex.org/W4412991288" → "W4412991288"; "https://openalex.org/fields/28" → "28"."""
    m = _ID.search(value.strip()) if isinstance(value, str) else None
    return m.group(1).upper() if m else ""


def _s(value: Any) -> str:
    return biblio._squash(str(value)) if isinstance(value, (str, int, float)) else ""


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


#: Preprint servers, by the name OpenAlex gives their source.
_PREPRINT_SOURCE = re.compile(r"arxiv|biorxiv|medrxiv|chemrxiv|psyarxiv|research\s*square|ssrn|preprints|"
                              r"\bpreprint", re.I)
_ARXIV = re.compile(r"arxiv\.org/(?:abs|pdf)/([a-z\-]+/\d{7}|\d{4}\.\d{4,5})|10\.48550/arxiv\.(\d{4}\.\d{4,5})", re.I)


def _server(name: str) -> str:
    """"bioRxiv (Cold Spring Harbor Laboratory)" → "bioRxiv"."""
    return re.sub(r"\s*\([^)]*\)\s*$", "", name).strip() or name


def _preprint(w: dict, own_doi: str) -> dict[str, str] | None:
    """A preprint of the paper among the work's locations: its id, address and server."""
    for loc in _list(w.get("locations")):
        loc = _dict(loc)
        source = _dict(loc.get("source"))
        name = _s(source.get("display_name"))
        if (loc.get("raw_type") or "").lower() != "posted-content" and not _PREPRINT_SOURCE.search(name):
            continue
        lid, url = _s(loc.get("id")), _s(loc.get("landing_page_url"))
        doi = biblio._doi(lid[4:]) if lid.startswith("doi:") else biblio._doi(url)
        if doi and doi == own_doi:
            continue
        m = _ARXIV.search(f"{url} {doi}")
        if m:
            arxiv = m.group(1) or m.group(2)
            return {"id": f"arxiv:{arxiv}", "url": f"https://arxiv.org/abs/{arxiv}", "server": "arXiv"}
        if doi:
            return {"id": f"doi:{doi}", "url": f"https://doi.org/{doi}", "server": _server(name)}
        if re.match(r"https?://", url) and "pubmed" not in url and "ncbi.nlm.nih.gov" not in url:
            return {"id": re.sub(r"^https?://(?:www\.)?", "", url).rstrip("/"), "url": url, "server": _server(name)}
    return None


def _institution(inst: dict) -> dict[str, str] | None:
    ror = biblio._ror(_s(inst.get("ror")))
    if not ror:
        return None
    return {"id": ror, "name": _s(inst.get("display_name")), "country": _s(inst.get("country_code")).upper(),
            "type": _s(inst.get("type")), "openalex_id": short_id(inst.get("id"))}


def _authors(w: dict) -> tuple[list[dict], dict[str, dict[str, str]]]:
    """The authorships in order, and the institutions with a ROR id, by ROR id."""
    institutions: dict[str, dict[str, str]] = {}
    authors = []
    for position, a in enumerate(_list(w.get("authorships")), 1):
        a = _dict(a)
        person = _dict(a.get("author"))
        by_openalex: dict[str, str] = {}
        rors: list[str] = []
        for inst in _list(a.get("institutions")):
            entry = _institution(_dict(inst))
            if entry is None:
                continue
            institutions.setdefault(entry["id"], entry)
            if entry["openalex_id"]:
                by_openalex[entry["openalex_id"]] = entry["id"]
            if entry["id"] not in rors:
                rors.append(entry["id"])
        affiliations = []
        for aff in _list(a.get("affiliations")):
            aff = _dict(aff)
            text = biblio._tidy_affiliation(_s(aff.get("raw_affiliation_string")))
            ids = [by_openalex[short_id(x)] for x in _list(aff.get("institution_ids")) if short_id(x) in by_openalex]
            if text and not any(x["text"] == text for x in affiliations):
                affiliations.append({"text": text, "ror": biblio._unique(ids)})
        if not affiliations:
            for raw in _list(a.get("raw_affiliation_strings")):
                text = biblio._tidy_affiliation(_s(raw))
                if text and not any(x["text"] == text for x in affiliations):
                    affiliations.append({"text": text, "ror": []})
        name = _s(person.get("display_name")) or _s(a.get("raw_author_name"))
        if not name:
            continue
        authors.append({
            "position": position, "name": name, "raw_name": _s(a.get("raw_author_name")),
            # The ORCID iD the publisher deposited for this authorship, the only one given to an
            # author: it decides who is a verified author (community.py). The iD of OpenAlex's
            # author profile, which its disambiguation may have merged wrongly, only helps to
            # recognize the author.
            "orcid": biblio._orcid(_s(a.get("raw_orcid"))), "profile_orcid": biblio._orcid(_s(person.get("orcid"))),
            "openalex_id": short_id(person.get("id")),
            "corresponding": bool(a.get("is_corresponding")), "institutions": rors, "affiliations": affiliations,
        })
    return authors, institutions


def _topics(w: dict) -> list[dict[str, Any]]:
    primary = short_id(_dict(w.get("primary_topic")).get("id"))
    topics = _list(w.get("topics")) or ([w["primary_topic"]] if isinstance(w.get("primary_topic"), dict) else [])
    out = []
    for t in topics:
        t = _dict(t)
        tid = short_id(t.get("id"))
        if not tid or not _s(t.get("display_name")) or any(x["id"] == tid for x in out):
            continue
        score = t.get("score")
        entry: dict[str, Any] = {"id": tid, "name": _s(t.get("display_name")), "primary": tid == primary,
                                 "score": round(float(score), 4) if isinstance(score, (int, float)) else None}
        for level in ("subfield", "field", "domain"):
            part = _dict(t.get(level))
            entry[level], entry[f"{level}_id"] = _s(part.get("display_name")), short_id(part.get("id"))
        out.append(entry)
    return sorted(out, key=lambda x: not x["primary"])


def _funding(w: dict) -> list[dict]:
    awards: dict[str, list[str]] = defaultdict(list)
    names: dict[str, str] = {}
    for aw in _list(w.get("awards")):
        aw = _dict(aw)
        # Award numbers as OpenAlex split them out of acknowledgements: "-15-IDEX-01" is cut.
        fid, award = short_id(aw.get("funder_id")), _s(aw.get("funder_award_id")).strip(" -–‐‑,;:.")
        names.setdefault(fid, _s(aw.get("funder_display_name")))
        if len(award) >= 3:
            awards[fid].append(award)
    entries = []
    for f in _list(w.get("funders")):
        f = _dict(f)
        fid = short_id(f.get("id"))
        name = _s(f.get("display_name")) or names.get(fid, "")
        entries.append({"funder": name, "funder_id": biblio._ror(_s(f.get("ror"))),
                        "awards": biblio._unique(awards.pop(fid, []))})
    for fid, ids in awards.items():                 # an award whose funder the list lacks
        entries.append({"funder": names.get(fid, ""), "funder_id": "", "awards": biblio._unique(ids)})
    return biblio._merge_funders([e for e in entries if e["funder"]])


def _pages(b: dict) -> str:
    first, last = _s(b.get("first_page")), _s(b.get("last_page"))
    return f"{first}-{last}" if first and last and first != last else first


def parse(w: dict) -> dict[str, Any]:
    """A work in OSCR's shapes (every string scrubbed of email addresses)."""
    w = _dict(w)
    doi = biblio._doi(_s(w.get("doi")))
    oa = _dict(w.get("open_access"))
    source = _dict(_dict(w.get("primary_location")).get("source"))
    b = _dict(w.get("biblio"))
    authors, institutions = _authors(w)
    count = w.get("cited_by_count")
    refs = w.get("referenced_works_count")
    return biblio._scrub({
        "openalex_id": short_id(w.get("id")), "doi": doi, "type": _s(w.get("type")),
        "language": biblio._language(w.get("language")),
        "volume": _s(b.get("volume")), "issue": _s(b.get("issue")), "pages": _pages(b),
        "publisher": _s(source.get("host_organization_name")) if source.get("type") == "journal" else "",
        "cited_by_count": count if isinstance(count, int) else None,
        # 0 means "no reference known to OpenAlex", not a paper without references.
        "references_count": refs if isinstance(refs, int) and refs > 0 else None,
        "is_oa": oa.get("is_oa") if isinstance(oa.get("is_oa"), bool) else None,
        "oa_status": _s(oa.get("oa_status")).lower(),
        "oa_url": _s(oa.get("oa_url")) if re.match(r"https?://", _s(oa.get("oa_url"))) else "",
        "retracted": bool(w.get("is_retracted")),
        "preprint": _preprint(w, doi),
        "authors": authors, "institutions": sorted(institutions.values(), key=lambda i: i["id"]),
        "topics": _topics(w), "funding": _funding(w),
        "referenced_works": [x for x in (short_id(v) for v in _list(w.get("referenced_works"))) if x],
        "related_works": [x for x in (short_id(v) for v in _list(w.get("related_works"))) if x],
    })


# ---------------------------------------------------------------------------------------
# The record: what OpenAlex adds to the paper's own (biblio.merge's third source).

def record(oa: dict[str, Any]) -> dict:
    """The work as a biblio record, to merge after the JATS and Europe PMC ones: its scalars,
    its publisher and funders. Its authors are not there: `complete_authors` adds what
    OpenAlex knows of them to the authors the paper itself lists."""
    rec = biblio.empty()
    for key in ("language", "volume", "issue", "pages", "cited_by_count", "references_count"):
        if oa.get(key) not in (None, ""):
            rec[key] = oa[key]
    rec["is_open_access"] = oa.get("is_oa")
    rec["journal"]["publisher"] = oa.get("publisher") or ""
    rec["funding"] = [dict(f) for f in oa.get("funding") or []]
    return biblio._finish(rec, SOURCE)


def _words(s: str) -> set[str]:
    return {w for w in biblio._fold(s).split() if len(w) > 1}


def _similar(a: str, b: str) -> float:
    """How much of the shorter of two affiliations the other one holds (0–1)."""
    x, y = _words(a), _words(b)
    return len(x & y) / min(len(x), len(y)) if x and y else 0.0


def _same_person(a: dict, o: dict) -> bool:
    """The same author: the same ORCID iD, or the family name among the words of OpenAlex's name
    and, when the given name is known, its initial among the other words."""
    theirs = o.get("orcid") or o.get("profile_orcid")
    if a.get("orcid") and theirs:
        return a["orcid"] in (o.get("orcid"), o.get("profile_orcid"))
    family = biblio._fold(a.get("family") or "") or " ".join(biblio._fold(a.get("name") or "").split()[-1:])
    if not family:
        return False
    given = biblio._fold(a.get("given") or "")
    for name in (o.get("name"), o.get("raw_name")):
        words = f" {biblio._fold(name or '')} "
        if f" {family} " in words:
            rest = words.replace(f" {family} ", " ").split()
            if not given or not rest or any(w[0] == given[0] for w in rest):
                return True
    return False


def pair_authors(authors: list[dict], others: list[dict]) -> dict[int, dict]:
    """Each author of the paper's list (index) → the same author in OpenAlex's: the same ORCID
    iD, else the same person at the same place, else the only one of that name."""
    pairs: dict[int, int] = {}
    taken: set[int] = set()
    by_orcid = {x: k for k, o in reversed(list(enumerate(others)))
                for x in (o.get("profile_orcid"), o.get("orcid")) if x}
    for i, a in enumerate(authors):
        k = by_orcid.get(a.get("orcid") or "")
        if k is not None and k not in taken:
            pairs[i] = k
            taken.add(k)
    for i, a in enumerate(authors):
        if i not in pairs and i < len(others) and i not in taken and _same_person(a, others[i]):
            pairs[i] = i
            taken.add(i)
    for i, a in enumerate(authors):
        if i in pairs:
            continue
        found = [k for k, o in enumerate(others) if k not in taken and _same_person(a, o)]
        if len(found) == 1:
            pairs[i] = found[0]
            taken.add(found[0])
    return {i: others[k] for i, k in pairs.items()}


def place(affiliations: list[str], o: dict, names: dict[str, str]) -> list[dict[str, Any]]:
    """The ROR ids of an OpenAlex author, each with the index of the paper's affiliation it is
    (`aff`), or None when none of them is it: [{"id": "00pd74e08", "aff": 0}]."""
    out: list[dict[str, Any]] = [{"id": r, "aff": None} for r in o.get("institutions") or []]
    if not out:
        return out
    by_id = {e["id"]: e for e in out}
    theirs = o.get("affiliations") or []
    for j, text in enumerate(affiliations):
        scored = sorted(((_similar(text, x["text"]), n) for n, x in enumerate(theirs) if x.get("ror")), reverse=True)
        if scored and scored[0][0] >= 0.6:
            candidates = theirs[scored[0][1]]["ror"]
        elif len(affiliations) == 1 and len(theirs) <= 1 and len(out) == 1:
            candidates = [out[0]["id"]]    # one affiliation on each side, one institution
        else:
            continue
        free = [r for r in candidates if r in by_id and by_id[r]["aff"] is None]
        if free:
            best = max(free, key=lambda r: (_similar(text, names.get(r, "")), -free.index(r)))
            by_id[best]["aff"] = j
    return out


def complete_authors(rec: dict, oa: dict[str, Any]) -> dict:
    """Add to the paper's authors what OpenAlex knows and the paper's own record lacks: the ORCID
    iDs, the ROR ids of their institutions, the corresponding authors (only when the paper names
    none), their OpenAlex ids. A paper that lists no author takes OpenAlex's list. Records where
    each came from in `rec["provenance"]`."""
    others = oa.get("authors") or []
    if not others:
        return rec
    names = {i["id"]: i.get("name", "") for i in oa.get("institutions") or []}
    provenance = rec.setdefault("provenance", {})
    authors = rec.get("authors") or []
    if not authors:
        rec["authors"] = [{
            "position": n, "name": o["name"], "given": "", "family": "", "orcid": o.get("orcid", ""),
            "corresponding": bool(o.get("corresponding")), "openalex_id": o.get("openalex_id", ""),
            "affiliations": [x["text"] for x in o.get("affiliations") or []],
            "ror": place([x["text"] for x in o.get("affiliations") or []], o, names),
        } for n, o in enumerate(others, 1)]
        provenance["authors"] = SOURCE
        return rec
    used = {a["orcid"] for a in authors if a.get("orcid")}
    named = any(a.get("corresponding") for a in authors)
    filled: set[str] = set()
    for i, o in pair_authors(authors, others).items():
        a = authors[i]
        if o.get("openalex_id"):
            a["openalex_id"] = o["openalex_id"]
            filled.add("openalex_id")
        if not a.get("orcid") and o.get("orcid") and o["orcid"] not in used:
            a["orcid"] = o["orcid"]
            used.add(o["orcid"])
            filled.add("orcid")
        if not a.get("ror") and o.get("institutions"):
            a["ror"] = place(a.get("affiliations") or [], o, names)
            filled.add("ror")
        if not named and o.get("corresponding"):
            a["corresponding"] = True
            filled.add("corresponding")
    for part in sorted(filled):
        key = f"authors.{part}"
        before = provenance.get(key, "")
        provenance[key] = f"{before}+{SOURCE}" if before and SOURCE not in before.split("+") else before or SOURCE
    return rec


# ---------------------------------------------------------------------------------------
# The database.

#: The article's fields that only OpenAlex fills today, and their columns.
_ARTICLE_FIELDS: dict[str, tuple[str, ...]] = {
    "openalex_id": ("openalex_id",), "oa_status": ("oa_status",), "oa_url": ("oa_url",),
    "preprint": ("preprint_id", "preprint_url")}
#: Provenance keys of what `store` writes.
_STORED = ("openalex_id", "oa_status", "oa_url", "preprint", "institutions", "topics", "referenced_works",
           "related_works")


def may_write(con: sqlite3.Connection, article_id: str, field: str) -> bool:
    """Whether OpenAlex may set an article's field: never over a value that a source above it
    gave (the owner, a person's correction, the JATS, Europe PMC…)."""
    r = con.execute("SELECT source FROM field_provenance WHERE entity = 'article' AND entity_id = ? AND field = ?",
                    (article_id, field)).fetchone()
    return r is None or not (set(r[0].split("+")) & ABOVE_OPENALEX)


def store(con: sqlite3.Connection, article_id: str, oa: dict[str, Any] | None, now: float | None = None) -> None:
    """Keep what OpenAlex said about a paper: its record (`openalex_record`, without the lists of
    works, which go to `paper_work`), and what only OpenAlex knows. None: OpenAlex does not know
    the paper — noted, so that it is asked again only after RETRY_MISSING_DAYS; a record kept
    earlier stays."""
    now = now or time.time()
    if oa is None:
        seen = con.execute("SELECT status FROM openalex_record WHERE article_id = ?", (article_id,)).fetchone()
        if seen is not None and seen[0] == FOUND:
            con.execute("UPDATE openalex_record SET checked_at = ? WHERE article_id = ?", (now, article_id))
        else:
            con.execute("INSERT OR REPLACE INTO openalex_record (article_id, openalex_id, status, json, fetched_at, "
                        "checked_at) VALUES (?, '', ?, '', ?, ?)", (article_id, MISSING, now, now))
        return
    kept = {k: v for k, v in oa.items() if k not in ("referenced_works", "related_works")}
    con.execute("INSERT OR REPLACE INTO openalex_record (article_id, openalex_id, status, json, fetched_at, checked_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (article_id, oa["openalex_id"], FOUND, json.dumps(kept, ensure_ascii=False, separators=(",", ":")),
                 now, now))
    preprint = oa.get("preprint") or {}
    values = {"openalex_id": (oa["openalex_id"],), "oa_status": (oa.get("oa_status", ""),),
              "oa_url": (oa.get("oa_url", ""),), "preprint": (preprint.get("id", ""), preprint.get("url", ""))}
    for field, columns in _ARTICLE_FIELDS.items():
        if may_write(con, article_id, field):
            con.execute(f"UPDATE article SET {', '.join(f'{c} = ?' for c in columns)} WHERE id = ?",
                        (*values[field], article_id))
    for i in oa.get("institutions") or []:
        con.execute("INSERT INTO institution (id, name, country, type, openalex_id) VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(id) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), institution.name), "
                    "country = COALESCE(NULLIF(excluded.country, ''), institution.country), "
                    "type = COALESCE(NULLIF(excluded.type, ''), institution.type), "
                    "openalex_id = COALESCE(NULLIF(excluded.openalex_id, ''), institution.openalex_id)",
                    (i["id"], i.get("name", ""), i.get("country", ""), i.get("type", ""), i.get("openalex_id", "")))
    con.execute("DELETE FROM paper_topic WHERE article_id = ?", (article_id,))
    for t in oa.get("topics") or []:
        con.execute("INSERT INTO topic (id, name, subfield_id, subfield, field_id, field, domain_id, domain) "
                    "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, "
                    "subfield_id = excluded.subfield_id, subfield = excluded.subfield, field_id = excluded.field_id, "
                    "field = excluded.field, domain_id = excluded.domain_id, domain = excluded.domain",
                    (t["id"], t["name"], t.get("subfield_id", ""), t.get("subfield", ""), t.get("field_id", ""),
                     t.get("field", ""), t.get("domain_id", ""), t.get("domain", "")))
        con.execute("INSERT OR REPLACE INTO paper_topic (article_id, topic_id, score, is_primary) VALUES (?,?,?,?)",
                    (article_id, t["id"], t.get("score"), int(bool(t.get("primary")))))
    con.execute("DELETE FROM paper_work WHERE article_id = ?", (article_id,))
    for relation in ("referenced_works", "related_works"):
        con.executemany("INSERT OR IGNORE INTO paper_work (article_id, relation, work_id, position) VALUES (?,?,?,?)",
                        [(article_id, relation.split("_")[0], wid, n) for n, wid in enumerate(oa.get(relation) or [], 1)])
    con.execute(f"DELETE FROM field_provenance WHERE entity = 'article' AND entity_id = ? AND source = ? "
                f"AND field IN ({', '.join('?' * len(_STORED))})", (article_id, SOURCE, *_STORED))
    present = {"openalex_id": oa["openalex_id"], "oa_status": oa.get("oa_status"), "oa_url": oa.get("oa_url"),
               "preprint": preprint, "institutions": oa.get("institutions"), "topics": oa.get("topics"),
               "referenced_works": oa.get("referenced_works"), "related_works": oa.get("related_works")}
    db.record_provenance(con, "article", article_id,
                         {f: SOURCE for f, v in present.items() if v and (f not in _ARTICLE_FIELDS or
                                                                          may_write(con, article_id, f))},
                         ref=oa["openalex_id"], at=now)


def load(con: sqlite3.Connection, article_id: str) -> dict[str, Any] | None:
    """The OpenAlex record kept for a paper, or None."""
    r = con.execute("SELECT json FROM openalex_record WHERE article_id = ? AND status = ?",
                    (article_id, FOUND)).fetchone()
    if r is None or not r[0]:
        return None
    try:
        return json.loads(r[0])
    except ValueError:
        return None


def fetch(con: sqlite3.Connection, client: Client, article_id: str, budget: Budget, now: float | None = None) -> str:
    """Look a paper up in OpenAlex (by DOI, else PMID) and keep the answer: FOUND or MISSING.
    Raises Paused, Outage or Unavailable (nothing is kept then)."""
    a = con.execute("SELECT doi, pmid FROM article WHERE id = ?", (article_id,)).fetchone()
    if a is None:
        raise KeyError(article_id)
    doi = biblio._doi(a["doi"] or "")
    found = work(client, budget, doi=doi, pmid="" if doi else biblio._pmid(a["pmid"] or ""))
    oa = parse(found) if found else None
    store(con, article_id, oa, now)
    return FOUND if oa else MISSING
