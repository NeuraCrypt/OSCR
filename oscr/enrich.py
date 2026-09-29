"""Phase 1: a paper's record beyond its links — bibliography, people, money, subjects,
references, notices, datasets, categories — and what its repositories hold.

Everything here is computed from what the Mac already has: the full text cached forever
(JATS), the Europe PMC `core` result (kept since Phase 1), the paper's OpenAlex work (kept since
the owner's key, `sources/openalex.py`), the stored file lists and scripts. The sources are merged
in that order of authority — JATS, then Europe PMC, then OpenAlex — so OpenAlex only fills what
the other two left empty. Each value records where it came from (`field_provenance`) and each
change of a record is kept (`version`). Nothing here sends a paper's text anywhere: the public
export strips abstracts and closed-license statements (catalog.public_db).
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx

from . import db
from .net import Outage, Unavailable

#: A data link's key → the repository's name, for the `dataset` table.
_DATA_REPOSITORIES: tuple[tuple[str, str], ...] = (
    ("openneuro:", "OpenNeuro"), ("dandi:", "DANDI"), ("neurovault:", "NeuroVault"), ("gin:", "GIN"),
    ("zenodo:", "Zenodo"), ("figshare:", "figshare"), ("osf:", "OSF"), ("doi:10.5061/", "Dryad"),
    ("doi:10.5281/", "Zenodo"), ("doi:10.6084/", "figshare"), ("doi:10.17605/", "OSF"),
    ("doi:10.18112/openneuro", "OpenNeuro"), ("doi:10.48324/dandi", "DANDI"), ("doi:10.12751/g-node", "GIN"),
    ("geo:", "NCBI GEO"), ("sra:", "NCBI SRA"), ("bioproject:", "NCBI BioProject"),
    ("arrayexpress:", "ArrayExpress"), ("biostudies:", "BioStudies"), ("pride:", "PRIDE"), ("ega:", "EGA"),
    ("ncbi.nlm.nih.gov", "NCBI"), ("physionet.org", "PhysioNet"), ("rcsb.org", "PDB"), ("ebi.ac.uk", "EMBL-EBI"),
    ("uniprot.org", "UniProt"), ("kaggle.com", "Kaggle"), ("humanconnectome.org", "Human Connectome Project"),
    ("synapse.org", "Synapse"), ("data.mendeley.com", "Mendeley Data"), ("ukbiobank.ac.uk", "UK Biobank"),
    ("crcns.org", "CRCNS"), ("portal.brain-map.org", "Allen Brain Map"), ("huggingface.co", "Hugging Face"),
    ("doi:", "DOI"),
)


#: Datasets of the big databases are named by their accession, which the link key does not
#: hold: every GEO series was keyed "ncbi.nlm.nih.gov/geo/query" (92 links on 2026-09-27),
#: the accession being in the query string. (pattern, prefix, canonical URL)
_ACCESSIONS: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (re.compile(r"\b(G(?:SE|SM|PL|DS)\d{3,})\b", re.I), "geo", "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={}"),
    (re.compile(r"\b((?:SRP|SRR|SRX|SRS|ERP|ERR|DRP|DRR)\d{5,})\b", re.I), "sra", "https://www.ncbi.nlm.nih.gov/sra/{}"),
    (re.compile(r"\b(PRJ(?:NA|EB|DB)\d+)\b", re.I), "bioproject", "https://www.ncbi.nlm.nih.gov/bioproject/{}"),
    (re.compile(r"\b(E-[A-Z]{4}-\d+)\b", re.I), "arrayexpress", "https://www.ebi.ac.uk/biostudies/arrayexpress/studies/{}"),
    (re.compile(r"\b(S-[A-Z]{4,}\d+)\b", re.I), "biostudies", "https://www.ebi.ac.uk/biostudies/studies/{}"),
    (re.compile(r"\b(PXD\d{6})\b", re.I), "pride", "https://www.ebi.ac.uk/pride/archive/projects/{}"),
    (re.compile(r"\b(EGA[SD]\d{11})\b", re.I), "ega", "https://ega-archive.org/{}"),
)
#: The root of a database, without an accession: not a dataset.
_GENERIC_DATA_KEYS = ("ncbi.nlm.nih.gov/geo", "ncbi.nlm.nih.gov/sra", "ncbi.nlm.nih.gov/bioproject",
                      "ebi.ac.uk/biostudies", "ebi.ac.uk/arrayexpress", "ebi.ac.uk/pride", "ebi.ac.uk/ena")


def dataset_id(key: str, url: str = "") -> tuple[str, str] | None:
    """(the dataset's id, its URL) for a data link: the accession for the big databases
    (`geo:GSE157827`), else the link's key; None for a database's root, with no accession."""
    for pattern, prefix, canonical in _ACCESSIONS:
        m = pattern.search(f"{key} {url}")
        if m:
            accession = m.group(1).upper()
            return f"{prefix}:{accession}", (url if accession.lower() in url.lower() else canonical.format(accession))
    k = key.lower().rstrip("/")
    if any(k == g or k.startswith(g + "/") for g in _GENERIC_DATA_KEYS):
        return None
    return key, url


def data_repository(key: str) -> str:
    """The name of the repository that holds a dataset, from its normalized link key."""
    k = key.lower()
    host = k.split("/")[0]
    return next((name for prefix, name in _DATA_REPOSITORIES
                 if k.startswith(prefix) or (":" not in prefix and host.endswith(prefix))),
                k.split(":")[0].split("/")[0])


def link_datasets(con: sqlite3.Connection, article_id: str) -> int:
    """The paper's data links, as datasets: one `dataset` row per dataset, one
    `paper_dataset` row per paper citing it. Returns the number linked."""
    rows = con.execute("SELECT repo, url, found_by FROM link WHERE article_id = ? AND role = 'data'",
                       (article_id,)).fetchall()
    con.execute("DELETE FROM paper_dataset WHERE article_id = ?", (article_id,))
    linked = 0
    for r in rows:
        ident = dataset_id(r["repo"], r["url"] or "")
        if ident is None:
            continue
        did, url = ident
        con.execute("INSERT INTO dataset (id, repository, url) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE "
                    "SET url = CASE WHEN dataset.url = '' THEN excluded.url ELSE dataset.url END",
                    (did, data_repository(did), url))
        con.execute("INSERT OR IGNORE INTO paper_dataset (article_id, dataset_id, relation, found_by) "
                    "VALUES (?, ?, 'cited', ?)", (article_id, did, r["found_by"] or ""))
        linked += 1
    return linked


def coverage(con: sqlite3.Connection) -> dict[str, Any]:
    """How much of the enrichment is filled, over the papers read: for the dashboard."""
    q = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
    n = q("SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL") or 1
    share = lambda sql: round(100 * q(sql) / n, 1)  # noqa: E731
    return {
        "papers": n,
        "enriched": share("SELECT COUNT(*) FROM article WHERE enriched_at IS NOT NULL"),
        "type": share("SELECT COUNT(*) FROM article WHERE type != ''"),
        "abstract": share("SELECT COUNT(*) FROM article WHERE abstract != ''"),
        "authors": share("SELECT COUNT(DISTINCT article_id) FROM paper_author"),
        "orcid": share("SELECT COUNT(DISTINCT article_id) FROM paper_author WHERE orcid != ''"),
        "keywords": share("SELECT COUNT(DISTINCT article_id) FROM paper_subject WHERE scheme = 'keyword'"),
        "mesh": share("SELECT COUNT(DISTINCT article_id) FROM paper_subject WHERE scheme = 'mesh'"),
        "funding": share("SELECT COUNT(DISTINCT article_id) FROM grant_award"),
        "references": share("SELECT COUNT(DISTINCT article_id) FROM paper_reference"),
        "rrids": share("SELECT COUNT(DISTINCT article_id) FROM paper_rrid"),
        "statements": share("SELECT COUNT(DISTINCT article_id) FROM statement"),
        "notices": share("SELECT COUNT(DISTINCT article_id) FROM integrity_notice"),
        "datasets": share("SELECT COUNT(DISTINCT article_id) FROM paper_dataset"),
        "classified": share("SELECT COUNT(*) FROM article WHERE classified_at IS NOT NULL"),
        "openalex": share("SELECT COUNT(*) FROM openalex_record WHERE status = 'found' AND article_id IN "
                          "(SELECT id FROM article WHERE scanned_at IS NOT NULL)"),
        "institutions_ror": share("SELECT COUNT(DISTINCT article_id) FROM paper_author WHERE ror NOT IN ('', '[]')"),
        "topics": share("SELECT COUNT(DISTINCT article_id) FROM paper_topic"),
        "oa_status": share("SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL AND oa_status != ''"),
        "citations": share("SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL AND cited_by_count IS NOT NULL"),
        "preprints": share("SELECT COUNT(*) FROM article WHERE scanned_at IS NOT NULL AND preprint_id != ''"),
        "off_topic": q("SELECT COUNT(*) FROM article WHERE on_topic = 'no'"),
        "repositories_with_features": q("SELECT COUNT(*) FROM repo_feature"),
        "repositories_with_tools": q("SELECT COUNT(DISTINCT repo) FROM repo_tool"),
    }


def _journal_id(j: dict[str, str], title: str) -> str:
    issn = (j.get("issn") or j.get("eissn") or "").strip().upper()
    if issn:
        return f"issn:{issn}"
    t = re.sub(r"[^a-z0-9]+", " ", (j.get("title") or title or "").lower()).strip()
    return f"title:{t}" if t else ""


def _snapshot(rec: dict[str, Any], categories: dict[str, Any]) -> dict[str, Any]:
    """What a version keeps of the record: the facts, not the texts (digests of those)."""
    digest = lambda s: hashlib.sha256(s.encode()).hexdigest()[:16] if s else ""  # noqa: E731
    return {
        "type": rec.get("type", ""), "language": rec.get("language", ""), "volume": rec.get("volume", ""),
        "issue": rec.get("issue", ""), "pages": rec.get("pages", ""), "journal": rec.get("journal", {}),
        "dates": rec.get("dates", {}), "abstract": digest(rec.get("abstract", "")),
        "authors": [(a.get("name"), a.get("orcid")) for a in rec.get("authors", [])],
        "keywords": rec.get("keywords", []), "mesh": [m.get("term") for m in rec.get("mesh", [])],
        "funding": [(f.get("funder"), f.get("awards")) for f in rec.get("funding", [])],
        "references": len(rec.get("references", [])), "rrids": [r.get("rrid") for r in rec.get("rrids", [])],
        "statements": [(s.get("kind"), digest(s.get("text", ""))) for s in rec.get("statements", [])],
        "integrity": [(i.get("kind"), i.get("id")) for i in rec.get("integrity", [])],
        "categories": {f: sorted(v.get("value") for v in c.get("values", [])) for f, c in categories.items()},
    }


def _write_record(con: sqlite3.Connection, article_id: str, a: sqlite3.Row, rec: dict[str, Any], now: float) -> None:
    j = rec.get("journal") or {}
    jid = _journal_id(j, a["journal"])
    if jid:
        con.execute("INSERT INTO journal (id, title, issn, eissn, publisher, nlm_ta) VALUES (?,?,?,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET title = COALESCE(NULLIF(excluded.title, ''), journal.title), "
                    "publisher = COALESCE(NULLIF(excluded.publisher, ''), journal.publisher), "
                    "nlm_ta = COALESCE(NULLIF(excluded.nlm_ta, ''), journal.nlm_ta)",
                    (jid, j.get("title") or a["journal"] or "", j.get("issn", ""), j.get("eissn", ""),
                     j.get("publisher", ""), j.get("nlm_ta", "")))
    d = rec.get("dates") or {}
    con.execute("UPDATE article SET type = ?, language = ?, abstract = ?, volume = ?, issue = ?, pages = ?, "
                "journal_id = ?, received = ?, accepted = ?, published_online = ?, published_print = ?, "
                "cited_by_count = ?, is_open_access = ?, references_count = ?, enriched_at = ? WHERE id = ?",
                (rec.get("type", ""), rec.get("language", ""), rec.get("abstract", ""), rec.get("volume", ""),
                 rec.get("issue", ""), rec.get("pages", ""), jid, d.get("received", ""), d.get("accepted", ""),
                 d.get("epub", "") or d.get("first_publication", ""), d.get("ppub", ""),
                 rec.get("cited_by_count"), None if rec.get("is_open_access") is None else int(rec["is_open_access"]),
                 rec.get("references_count") if rec.get("references_count") is not None else len(rec.get("references", [])),
                 now, article_id))
    for table in ("paper_author", "grant_award", "paper_subject", "paper_reference", "paper_rrid", "statement",
                  "integrity_notice"):
        con.execute(f"DELETE FROM {table} WHERE article_id = ?", (article_id,))
    for au in rec.get("authors", []):
        con.execute("INSERT OR REPLACE INTO paper_author (article_id, position, name, given, family, orcid, "
                    "corresponding, affiliations, ror, openalex_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (article_id, au.get("position"), au.get("name", ""), au.get("given", ""), au.get("family", ""),
                     au.get("orcid", ""), int(bool(au.get("corresponding"))),
                     json.dumps(au.get("affiliations", []), ensure_ascii=False), json.dumps(au.get("ror", [])),
                     au.get("openalex_id", "")))
        if au.get("orcid"):
            con.execute("INSERT INTO author (orcid, name, openalex_id) VALUES (?, ?, ?) ON CONFLICT(orcid) DO UPDATE "
                        "SET name = COALESCE(NULLIF(excluded.name, ''), author.name), "
                        "openalex_id = COALESCE(NULLIF(excluded.openalex_id, ''), author.openalex_id)",
                        (au["orcid"], au.get("name", ""), au.get("openalex_id", "")))
    for f in rec.get("funding", []):
        name = (f.get("funder") or "").strip()
        fid = f.get("funder_id") or (f"name:{re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()}" if name else "")
        if not fid:
            continue
        con.execute("INSERT INTO funder (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "name = COALESCE(NULLIF(excluded.name, ''), funder.name)", (fid, name))
        for award in f.get("awards") or [""]:
            con.execute("INSERT OR IGNORE INTO grant_award (article_id, funder_id, award) VALUES (?,?,?)",
                        (article_id, fid, award or ""))
    subjects = [("keyword", k, 0) for k in rec.get("keywords", [])]
    subjects += [("mesh", m.get("term", ""), int(bool(m.get("major")))) for m in rec.get("mesh", [])]
    subjects += [("subject", s, 0) for s in rec.get("subjects", [])]
    con.executemany("INSERT OR IGNORE INTO paper_subject (article_id, scheme, term, major) VALUES (?,?,?,?)",
                    [(article_id, sch, t.strip(), m) for sch, t, m in subjects if t and t.strip()])
    con.executemany("INSERT OR IGNORE INTO paper_reference (article_id, position, doi, pmid) VALUES (?,?,?,?)",
                    [(article_id, i, (r.get("doi") or "").lower(), r.get("pmid") or "")
                     for i, r in enumerate(rec.get("references", []), 1) if r.get("doi") or r.get("pmid")])
    con.executemany("INSERT OR IGNORE INTO paper_rrid (article_id, rrid, kind, name) VALUES (?,?,?,?)",
                    [(article_id, r.get("rrid", ""), r.get("kind", ""), r.get("name", ""))
                     for r in rec.get("rrids", []) if r.get("rrid")])
    con.executemany("INSERT OR REPLACE INTO statement (article_id, kind, title, text) VALUES (?,?,?,?)",
                    [(article_id, s.get("kind", ""), s.get("title", ""), s.get("text", ""))
                     for s in rec.get("statements", []) if s.get("text")])
    con.executemany("INSERT OR IGNORE INTO integrity_notice (article_id, kind, notice_id, source, date, reasons) "
                    "VALUES (?,?,?,?,?,?)",
                    [(article_id, n.get("kind", ""), n.get("id", ""),
                      # Europe PMC names the record's own source ("MED", "PMC"): the notice came from Europe PMC.
                      n["source"] if n.get("source") == "retraction-watch" else "epmc", n.get("date", ""),
                      n.get("reasons", "")) for n in rec.get("integrity", [])])


#: The Retraction Watch CSV (sources/retractions.py), refreshed weekly by the backfill and
#: the watch; papers are looked up in it by DOI when it is there.
RETRACTIONS_CSV = Path("data/retraction-watch/retraction_watch.csv")


def _retraction_notices(doi: str) -> list[dict[str, str]]:
    from .sources import retractions
    if not doi or not RETRACTIONS_CSV.exists():
        return []
    return retractions.notices(RETRACTIONS_CSV).get(doi.lower(), [])


def _classify(con: sqlite3.Connection, article_id: str, a: sqlite3.Row, rec: dict[str, Any], now: float) -> dict:
    from . import classify
    result = classify.classify({
        "title": a["title"], "abstract": rec.get("abstract", ""), "keywords": rec.get("keywords", []),
        "mesh": [m.get("term", "") for m in rec.get("mesh", [])], "journal": a["journal"],
        "subjects": rec.get("subjects", []), "families": json.loads(a["families"] or "[]"),
        "type": rec.get("type", "")})
    con.execute("DELETE FROM paper_category WHERE article_id = ? AND method = 'rule'", (article_id,))
    for facet, c in result.items():
        for v in c.get("values", []):
            con.execute("INSERT OR REPLACE INTO paper_category (article_id, facet, value, confidence, method, "
                        "reasons, ambiguous) VALUES (?,?,?,?, 'rule', ?, ?)",
                        (article_id, facet, v.get("value", ""), float(v.get("confidence", 0)),
                         json.dumps(v.get("reasons", []), ensure_ascii=False), int(bool(c.get("ambiguous")))))
    # The owner's own label wins over the rules (D6); a model's, later, over ambiguous rules.
    owner = con.execute("SELECT value FROM paper_category WHERE article_id = ? AND facet = 'on_topic' "
                        "AND method = 'owner'", (article_id,)).fetchone()
    on_topic = owner[0] if owner else ("yes" if classify.is_publishable(result) else "no")
    con.execute("UPDATE article SET on_topic = ?, classified_at = ? WHERE id = ?", (on_topic, now, article_id))
    return result


def repository_facts(con: sqlite3.Connection, repo: str, now: float | None = None) -> bool:
    """A repository's features and tools, from its file list and stored scripts; computed
    again only when it was verified since. Returns whether anything was computed."""
    from . import repofeatures
    now = now or time.time()
    r = con.execute("SELECT files, verified_at FROM repository WHERE repo = ?", (repo,)).fetchone()
    if r is None:
        return False
    seen = con.execute("SELECT computed_at FROM repo_feature WHERE repo = ?", (repo,)).fetchone()
    if seen and (r["verified_at"] or 0) <= seen["computed_at"]:
        return False
    paths = json.loads(r["files"] or "[]")
    stored = con.execute("SELECT path, language, text FROM file WHERE repo = ? AND text IS NOT NULL", (repo,)).fetchall()
    if not paths:
        paths = [s["path"] for s in stored]
    f = repofeatures.features(paths)
    con.execute("INSERT OR REPLACE INTO repo_feature (repo, n_notebooks, has_readme, has_citation_cff, "
                "has_license_file, env_files, has_tests, has_ci, has_docs, data_like, computed_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (repo, f.get("n_notebooks"), int(bool(f.get("has_readme"))), int(bool(f.get("has_citation_cff"))),
                 int(bool(f.get("has_license_file"))), json.dumps(f.get("env_files", [])),
                 int(bool(f.get("has_tests"))), int(bool(f.get("has_ci"))), int(bool(f.get("has_docs"))),
                 f.get("data_like"), now))
    tools = repofeatures.detect_tools([(s["path"], s["language"] or "", s["text"]) for s in stored])
    con.execute("DELETE FROM repo_tool WHERE repo = ?", (repo,))
    con.executemany("INSERT OR REPLACE INTO repo_tool (repo, tool_id, evidence, via, examples) VALUES (?,?,?,?,?)",
                    [(repo, t["tool"], t.get("evidence", 0), t.get("via", ""), json.dumps(t.get("examples", [])))
                     for t in tools])
    record_tools(con)
    return True


_TOOLS_RECORDED = False


def record_tools(con: sqlite3.Connection) -> None:
    """The tools vocabulary, as the `tool` table (once per process)."""
    global _TOOLS_RECORDED
    if _TOOLS_RECORDED:
        return
    from . import repofeatures
    vocabulary = repofeatures.vocabulary() if hasattr(repofeatures, "vocabulary") else []
    con.executemany("INSERT OR REPLACE INTO tool (id, name, kind, languages, homepage, rrid) VALUES (?,?,?,?,?,?)",
                    [(t["id"], t.get("name", t["id"]), t.get("kind", ""), json.dumps(t.get("languages", [])),
                      t.get("homepage", ""), t.get("rrid", "")) for t in vocabulary])
    _TOOLS_RECORDED = True


def enrich_article(con: sqlite3.Connection, article_id: str, *, xml: str | None = None,
                   core: dict[str, Any] | None = None, client: Any = None, now: float | None = None) -> dict[str, Any]:
    """Build a paper's enriched record from the cached full text (`xml`, else fetched from
    the cache through `client`), its Europe PMC `core` result (`core`, else the one kept in
    `epmc_record`) and its OpenAlex work when one is kept (`openalex_record`: never fetched
    here); classify it; describe its code repositories."""
    from . import biblio
    from .sources import europepmc, openalex
    now = now or time.time()
    a = con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone()
    if a is None:
        raise KeyError(article_id)
    if xml is None and client is not None and (a["fulltext_id"] or a["pmcid"]):
        try:
            xml = europepmc.fulltext(client, a["fulltext_id"] or a["pmcid"])
        except Unavailable:
            xml = None
    if core is None:
        row = con.execute("SELECT json FROM epmc_record WHERE article_id = ?", (article_id,)).fetchone()
        core = json.loads(row[0]) if row else None
    oa = openalex.load(con, article_id)
    parts = (([biblio.from_jats(xml)] if xml else []) + ([biblio.from_epmc(core)] if core else [])
             + ([openalex.record(oa)] if oa else []))
    rec = biblio.merge(*parts) if parts else {}
    if rec and oa:
        openalex.complete_authors(rec, oa)
    rw = _retraction_notices(a["doi"])
    if rw:
        rec = dict(rec) if rec else {}
        seen = {(n.get("kind"), n.get("id")) for n in rec.get("integrity", [])}
        rec["integrity"] = [*rec.get("integrity", []), *(n for n in rw if (n["kind"], n["id"]) not in seen)]
        rec.setdefault("provenance", {})["integrity"] = rec.get("provenance", {}).get("integrity") or "retraction-watch"
    if rec:
        _write_record(con, article_id, a, rec, now)
        sources = rec.get("provenance", {})
        own = {f: s for f, s in sources.items() if openalex.SOURCE not in s.split("+")}
        db.record_provenance(con, "article", article_id, own, ref=a["fulltext_id"] or a["pmcid"] or "", at=now)
        db.record_provenance(con, "article", article_id, {f: s for f, s in sources.items() if f not in own},
                             ref=(oa or {}).get("openalex_id", ""), at=now)
    link_datasets(con, article_id)
    # The authors' contact details, private (oscr/contacts.py): from the same full text and
    # Europe PMC record, into the `contact` table only.
    from . import contacts
    contacts.write(con, article_id, contacts.merge(contacts.from_jats(xml) if xml else [],
                                                   contacts.from_epmc(core) if core else []), now)
    categories = _classify(con, article_id, a, rec, now)
    # The links' keys too (Phase 6): a person's correction of them is a version of the record.
    db.save_version(con, "article", article_id, {**_snapshot(rec, categories), **db.links_snapshot(con, article_id)})
    repos = [r[0] for r in con.execute("SELECT DISTINCT repo FROM link WHERE article_id = ? AND role = 'code'",
                                       (article_id,))]
    described = sum(repository_facts(con, r, now) for r in repos)
    return {"record": bool(rec), "on_topic": con.execute("SELECT on_topic FROM article WHERE id = ?",
                                                        (article_id,)).fetchone()[0],
            "repositories": described}


def fetch_epmc_records(con: sqlite3.Connection, client: Any, *, report: Any = print) -> int:
    """The Europe PMC `core` results of the papers read before Phase 1 (100 per request)."""
    from .sources import europepmc
    rows = con.execute("SELECT id, pmcid FROM article WHERE scanned_at IS NOT NULL AND pmcid != '' AND id NOT IN "
                       "(SELECT article_id FROM epmc_record)").fetchall()
    by_pmcid = {r["pmcid"].upper(): r["id"] for r in rows}
    done = 0
    pmcids = sorted(by_pmcid)
    for i in range(0, len(pmcids), 500):
        found = europepmc.by_pmcids(client, pmcids[i:i + 500])
        now = time.time()
        con.executemany("INSERT OR REPLACE INTO epmc_record (article_id, json, fetched_at) VALUES (?, ?, ?)",
                        [(by_pmcid[p], json.dumps(r, ensure_ascii=False), now) for p, r in found.items() if p in by_pmcid])
        con.commit()
        done += len(found)
        report(f"  … {done}/{len(pmcids)} Europe PMC records")
    return done


#: The papers' order for OpenAlex: those with a page first (decision D2), then those in scope,
#: the most recent first; off-topic papers last (they stay on the Mac, D7).
_OPENALEX_ORDER = ("CASE WHEN a.on_topic = 'no' OR a.withdrawn != '' THEN 2 WHEN a.status IN ('code_verified', "
                   "'code_found', 'code_empty', 'code_dead', 'on_request', 'data_only') THEN 0 ELSE 1 END, "
                   "a.published DESC, a.id")


def openalex_pending(con: sqlite3.Connection, *, everything: bool = False, now: float | None = None
                     ) -> list[tuple[str, bool]]:
    """The papers the OpenAlex pass takes, in order, each with whether OpenAlex must be asked
    (False: its record is kept, but the paper was not enriched with it yet — an interrupted
    pass). Asked: the papers never asked, those OpenAlex did not know RETRY_MISSING_DAYS ago,
    and with `everything` all the others asked more than 20 hours ago (so an interrupted
    `--all` resumes where it stopped)."""
    from .sources import openalex
    now = now or time.time()
    retry = now - openalex.RETRY_MISSING_DAYS * 86400
    again = now - 20 * 3600
    out = []
    for r in con.execute(
            "SELECT a.id, a.enriched_at, o.status, o.fetched_at, o.checked_at FROM article a "
            "LEFT JOIN openalex_record o ON o.article_id = a.id "
            f"WHERE a.scanned_at IS NOT NULL AND (a.doi != '' OR a.pmid != '') ORDER BY {_OPENALEX_ORDER}"):
        if r["status"] is None or (r["status"] == openalex.MISSING and r["checked_at"] < retry):
            out.append((r["id"], True))
        elif everything and r["checked_at"] < again:
            out.append((r["id"], True))
        elif r["status"] == openalex.FOUND and (r["enriched_at"] is None or r["enriched_at"] < r["fetched_at"]):
            out.append((r["id"], False))
    return out


def openalex_pass(con: sqlite3.Connection, client: Any, *, everything: bool = False, maximum: int | None = None,
                  deadline: float | None = None, report: Any = print) -> str:
    """Look the papers read up in OpenAlex, one free call each (by DOI, else PMID), keep what it
    says, and enrich each paper found again with it (`enrich_article`, from the cached full text).
    Resumable: every paper is committed on its own, and the next pass takes up what is left
    (`openalex_pending`). Stops for the day on a 429 or when the credit is spent (only free
    calls are made), on a network outage, or at `deadline`."""
    from .sources import openalex
    if not openalex.available():
        return "OpenAlex: no API key (keychain org.oscr.openalex, or OPENALEX_API_KEY): nothing done"
    budget = openalex.Budget(con)
    todo = openalex_pending(con, everything=everything)
    todo = todo[:maximum] if maximum else todo
    counts = {"found": 0, "missing": 0, "applied": 0, "errors": 0}
    stopped = ""
    left = 0
    t0 = time.time()
    for i, (article_id, ask) in enumerate(todo, 1):
        if i > 1 and (i - 1) % 100 == 0:
            report(f"  … {i - 1}/{len(todo)} papers: {counts['found']} found, {counts['missing']} not in OpenAlex, "
                   f"{counts['applied']} enriched, {counts['errors']} errors; {budget.summary()} "
                   f"({time.time() - t0:.0f} s)")
        if deadline is not None and time.time() >= deadline:
            stopped, left = "time slice over", len(todo) - i + 1
            break
        if ask:
            try:
                status = openalex.fetch(con, client, article_id, budget)
            except openalex.Paused as e:
                stopped, left = str(e), len(todo) - i + 1
                break
            except Outage as e:
                stopped, left = f"network outage: {e}", len(todo) - i + 1
                break
            except Unavailable as e:
                counts["errors"] += 1
                db.log_event(con, "openalex_error", article=article_id, error=str(e)[:300])
                con.commit()
                continue
            con.commit()
            counts[status] += 1
            if status != openalex.FOUND:
                continue
        try:
            enrich_article(con, article_id, client=client)
            con.commit()
            counts["applied"] += 1
        except Exception as e:  # one paper never stops the pass; its record waits for the next one
            con.rollback()
            counts["errors"] += 1
            db.log_event(con, "enrich_error", article=article_id, error=f"{type(e).__name__}: {e}"[:300])
            con.commit()
    con.commit()
    db.log_event(con, "openalex", **counts, stopped=stopped)
    con.commit()
    return (f"OpenAlex: {counts['found']} papers found, {counts['missing']} not in OpenAlex, {counts['applied']} "
            f"enriched, {counts['errors']} errors, {left} left"
            f"{' — stopped: ' + stopped if stopped else ''}; {budget.summary()} ({time.time() - t0:.0f} s)")


def backfill(con: sqlite3.Connection, client: Any, *, everything: bool = False, epmc: bool = False,
             maximum: int | None = None, report: Any = print) -> str:
    """Enrich the papers already read, from the cache: those never enriched, or all of them."""
    from .sources import retractions
    try:
        retractions.refresh(RETRACTIONS_CSV.parent)
    except httpx.HTTPError as e:  # the notices wait for the next run; the rest goes on
        report(f"  ! Retraction Watch data not refreshed: {e}")
    fetched = fetch_epmc_records(con, client, report=report) if epmc else 0
    where = "scanned_at IS NOT NULL" + ("" if everything else " AND enriched_at IS NULL")
    ids = [r[0] for r in con.execute(f"SELECT id FROM article WHERE {where} ORDER BY published DESC")]
    ids = ids[:maximum] if maximum else ids
    done = errors = 0
    t0 = time.time()
    for i, article_id in enumerate(ids, 1):
        try:
            enrich_article(con, article_id, client=client)
            done += 1
        except Exception as e:  # one paper never stops the backfill
            con.rollback()
            errors += 1
            db.log_event(con, "enrich_error", article=article_id, error=f"{type(e).__name__}: {e}"[:300])
        if i % 100 == 0:
            con.commit()
            report(f"  … {i}/{len(ids)} papers ({time.time() - t0:.0f} s)")
    con.commit()
    return (f"{done} papers enriched, {errors} errors, {fetched} Europe PMC records fetched "
            f"({time.time() - t0:.0f} s)")


def import_owner_labels(con: sqlite3.Connection, csv_path: Path) -> dict[str, int]:
    """The owner's labels from the annotation file (data/annotation/sample.csv): they win over
    the rules and any model (D6), and `on_topic` decides whether a paper leaves (D7).
    "?" (unsure) and empty cells are skipped; "-" means "no value" for the facet."""
    import csv

    from . import classify
    now = time.time()
    counts = {"papers": 0, "labels": 0, "skipped": 0}
    with Path(csv_path).open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            article_id = (row.get("id") or "").strip()
            if not article_id or not con.execute("SELECT 1 FROM article WHERE id = ?", (article_id,)).fetchone():
                continue
            labelled = False
            for facet in classify.FACETS:
                raw = (row.get(facet) or "").strip()
                if not raw or raw == classify.UNSURE:
                    continue
                values = classify.normalize_values(facet, [v.strip() for v in raw.split(classify.SEPARATOR.strip())])
                if values is None:
                    counts["skipped"] += 1
                    continue
                con.execute("DELETE FROM paper_category WHERE article_id = ? AND facet = ? AND method = 'owner'",
                            (article_id, facet))
                for v in values:
                    con.execute("INSERT OR REPLACE INTO paper_category (article_id, facet, value, confidence, method, "
                                "reasons, ambiguous) VALUES (?, ?, ?, 1.0, 'owner', '[\"owner label\"]', 0)",
                                (article_id, facet, v))
                    counts["labels"] += 1
                if facet == "on_topic" and values:
                    con.execute("UPDATE article SET on_topic = ?, classified_at = ? WHERE id = ?",
                                (values[0], now, article_id))
                labelled = True
            counts["papers"] += labelled
    con.commit()
    return counts
