"""Europe PMC: the entry point for papers, and their JATS full text.

**Why it.** Free, keyless, with no documented quota; 1.4 requests/s sustained
without throttling; pagination by `cursorMark`; the JATS full text of every
open-access PMC paper, and of preprints (bioRxiv, medRxiv). Europe PMC's
OAI-PMH, on the other hand, returns 404 and 403 (measured 2026-09-25): it is
not used.

**Recent or old.** The same query takes a range of first-publication dates:
the daily pass moves its date cursor forward, a backfill goes back through the
years.

**No "has code" preselection.** The index under-reports code links by a factor
of 2.4: the XML of every paper is read, without filtering ahead of time.
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

from ..net import Client, Outage, Unavailable, is_transient

BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"

#: The ready-made scopes. `neuro` is broad (1,885 open-access papers from
#: 2026-09-01 to 2026-09-25); `electrophysiology` is the EEG/MEG core of the
#: stat_bruteforce benchmark (165 over the same period).
DOMAINS: dict[str, str] = {
    "electrophysiology": (
        'TITLE_ABS:(EEG OR MEG OR iEEG OR ECoG OR SEEG OR electroencephalograph* '
        'OR magnetoencephalograph* OR "intracranial EEG" OR "event-related potential" '
        'OR "local field potential" OR "spike sorting" OR fNIRS OR "brain-computer interface")'),
    "neuro": (
        'TITLE_ABS:(EEG OR MEG OR fMRI OR iEEG OR ECoG OR SEEG OR electroencephalograph* '
        'OR magnetoencephalograph* OR "functional magnetic resonance" OR "intracranial EEG" '
        'OR "local field potential" OR "spike sorting" OR "calcium imaging" OR electrophysiolog* '
        'OR "brain-computer interface" OR "event-related potential" OR neuroimaging OR fNIRS '
        'OR "transcranial magnetic stimulation" OR "deep brain stimulation" '
        'OR "neural oscillations" OR connectome OR "diffusion MRI" OR neuron OR neurons '
        'OR neural OR cortex OR cortical OR hippocamp* OR brain)'),
}

#: The filters that guarantee a readable full text.
FULLTEXT_FILTER = "OPEN_ACCESS:y AND HAS_FT:y AND IN_EPMC:y"


@dataclass
class EpmcArticle:
    id: str
    doi: str = ""
    pmid: str = ""
    pmcid: str = ""
    fulltext_id: str = ""        # what is passed to /fullTextXML (PMCID or PPR…)
    title: str = ""
    authors: list[str] = field(default_factory=list)
    journal: str = ""
    published: str = ""
    license: str = ""
    source: str = "europepmc"
    #: The `core` search result as received (abstract, MeSH, grants, ORCIDs, corrections…):
    #: kept in `epmc_record` since Phase 1, not part of the `article` row.
    core: dict = field(default_factory=dict, repr=False)

    def as_dict(self) -> dict:
        # `fulltext_id` is a column of the `article` table since schema 3: the
        # alignment step fetches the full text again from it.
        return {"id": self.id, "doi": self.doi, "pmid": self.pmid, "pmcid": self.pmcid,
                "fulltext_id": self.fulltext_id, "title": self.title, "authors": self.authors,
                "journal": self.journal, "published": self.published, "license": self.license,
                "source": self.source}


def identifier(doi: str, pmcid: str, other: str = "") -> str:
    """The key of a paper: its DOI, failing that its PMCID, failing that its Europe PMC id."""
    if doi:
        return f"doi:{doi.lower()}"
    if pmcid:
        return f"pmcid:{pmcid.upper()}"
    return f"epmc:{other}"


def _article(r: dict) -> EpmcArticle:
    doi = (r.get("doi") or "").lower()
    pmcid = r.get("pmcid") or ""
    texts = (r.get("fullTextIdList") or {}).get("fullTextId") or []
    fulltext_id = pmcid or (texts[0] if texts else "")
    journal = ((r.get("journalInfo") or {}).get("journal") or {}).get("title", "")
    if not journal and r.get("source") == "PPR":
        journal = (r.get("bookOrReportDetails") or {}).get("publisher", "") + " (preprint)"
    authors = [a.get("fullName", "") for a in ((r.get("authorList") or {}).get("author") or [])
               if a.get("fullName")]
    return EpmcArticle(
        id=identifier(doi, pmcid, f"{r.get('source', '')}:{r.get('id', '')}"),
        doi=doi, pmid=r.get("pmid") or "", pmcid=pmcid, fulltext_id=fulltext_id,
        title=(r.get("title") or "").strip(), authors=authors, journal=journal,
        published=r.get("firstPublicationDate") or "", license=(r.get("license") or "").lower(),
        # A `core` result carries these; a `lite` one does not, and is not worth keeping.
        core=r if ("authorList" in r or "abstractText" in r or "meshHeadingList" in r) else {})


def by_pmcids(client: Client, pmcids: list[str]) -> dict[str, dict]:
    """The `core` results of papers already read, 100 PMCIDs per request: the fields each
    pass receives but did not keep before Phase 1 (MeSH, grants, ORCIDs, corrections…)."""
    out: dict[str, dict] = {}
    for i in range(0, len(pmcids), 100):
        chunk = [p for p in pmcids[i:i + 100] if p]
        if not chunk:
            continue
        r = client.get(f"{BASE}/search", params={
            "query": " OR ".join(f"PMCID:{p}" for p in chunk), "format": "json", "pageSize": "1000",
            "resultType": "core"})
        if is_transient(r.status):
            raise Outage(f"Europe PMC /search: HTTP {r.status}")
        for res in (r.json() or {}).get("resultList", {}).get("result", []) if r.ok else []:
            if res.get("pmcid"):
                out[res["pmcid"].upper()] = res
    return out


def query(domain_or_query: str, since: str, until: str, *,
          fulltext_only: bool = True) -> str:
    base = DOMAINS.get(domain_or_query, domain_or_query)
    q = f"({base}) AND FIRST_PDATE:[{since} TO {until}]"
    return f"{q} AND {FULLTEXT_FILTER}" if fulltext_only else q


def search(client: Client, q: str, *, cursor: str = "*", size: int = 100
           ) -> tuple[list[EpmcArticle], str, int]:
    """One page of results. Returns (papers, next cursor, total)."""
    r = client.get(f"{BASE}/search", params={
        "query": q, "format": "json", "pageSize": str(size), "cursorMark": cursor,
        "resultType": "core", "sort": "FIRST_PDATE_D asc"})
    if not r.ok:
        error = Outage if is_transient(r.status) else RuntimeError
        raise error(f"Europe PMC /search: HTTP {r.status}, {r.text[:200]}")
    d = r.json()
    arts = [_article(x) for x in d.get("resultList", {}).get("result", [])]
    return arts, d.get("nextCursorMark", ""), int(d.get("hitCount", 0))


def iterate(client: Client, q: str, *, maximum: int | None = None) -> Iterator[EpmcArticle]:
    """All the papers of a query, page after page."""
    cursor, returned = "*", 0
    while True:
        arts, following, _ = search(client, q, cursor=cursor)
        for a in arts:
            yield a
            returned += 1
            if maximum is not None and returned >= maximum:
                return
        if not arts or not following or following == cursor:
            return
        cursor = following


def by_doi(client: Client, doi: str) -> EpmcArticle | None:
    """A paper known by its DOI (to scan a list given by hand)."""
    r = client.get(f"{BASE}/search", params={
        "query": f'DOI:"{doi}"', "format": "json", "pageSize": "1", "resultType": "core"},
        ttl_s=7 * 86400)
    if not r.ok:
        return None
    res = r.json().get("resultList", {}).get("result", [])
    return _article(res[0]) if res else None


def _service_answers(client: Client) -> bool:
    """A control request: does Europe PMC answer at all right now?"""
    r = client.get(f"{BASE}/search", params={"query": "PMCID:PMC13592814", "format": "json",
                                              "pageSize": "1", "resultType": "idlist"})
    return r.ok


def fulltext(client: Client, fulltext_id: str) -> str | None:
    """The JATS of a paper. Cached forever: it does not change."""
    if not fulltext_id:
        return None
    r = client.get(f"{BASE}/{fulltext_id}/fullTextXML", ttl_s=float("inf"))
    if is_transient(r.status):
        # An outage (the Mac waking up, the Wi-Fi) is not an answer: returning
        # None would file the paper as "without full text", and it would be
        # skipped forever. But when Europe PMC answers everything else, this one
        # document is broken: waiting for it would stop the harvest for good.
        if r.status and _service_answers(client):
            raise Unavailable(f"Europe PMC fullTextXML {fulltext_id}: {r.status}")
        raise Outage(f"Europe PMC fullTextXML {fulltext_id}: {r.status or r.text[:120]}")
    return r.text if r.ok and r.text.lstrip().startswith("<") else None
