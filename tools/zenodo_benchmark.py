"""Measure the harvester's RECALL on a benchmark it did not build.

**The benchmark.** Software deposited on Zenodo that ITSELF declares a relation to a
paper (`related_identifiers`), in neuroscience journals. For those papers we know code
exists without having read the paper: a truth independent of the harvester.

**The trap.** Software that "isCitedBy" a paper may be a tool the paper CITES (MNE, a
statistics package), not its authors' code. Only software with a Zenodo creator who is
also an author of the paper counts as NATIVE code; the rest is counted apart.

Two steps:

    uv run python tools/zenodo_benchmark.py build    # → data/benchmark/zenodo.json + dois.txt
    uv run oscr --db data/benchmark/oscr.db --out data/benchmark/export \
        --library data/benchmark/library doi --file data/benchmark/dois.txt
    uv run python tools/zenodo_benchmark.py measure data/benchmark/oscr.db
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oscr.net import Cache, Client  # noqa: E402

BENCHMARK = ROOT / "data" / "benchmark" / "zenodo.json"
DOIS = ROOT / "data" / "benchmark" / "dois.txt"

#: DOI prefixes of neuroscience journals (and eLife, largely neuro).
PREFIXES: tuple[str, ...] = (
    r"10.7554", r"10.1523", r"10.1016\/j.neuroimage", r"10.1162\/imag", r"10.1162\/netn",
    r"10.1093\/cercor", r"10.1038\/s41593", r"10.1016\/j.neuron", r"10.1371\/journal.pcbi",
    r"10.1002\/hbm", r"10.1111\/ejn",
)
#: Zenodo refuses (HTTP 400) more than 25 results per page to guests.
PER_PAGE: int = 25
PAGES: int = 2


def _flat(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower())
                   if c.isalpha() and not unicodedata.combining(c))


def build(client: Client) -> None:
    benchmark: dict[str, dict] = {}
    for p in PREFIXES:
        plain = p.replace("\\", "")
        n, total, records = 0, 0, []
        for page in range(1, PAGES + 1):
            r = client.get("https://zenodo.org/api/records", params={
                "q": f"resource_type.type:software AND related.identifier:{p}*",
                "size": str(PER_PAGE), "page": str(page), "sort": "mostrecent"}, ttl_s=7 * 86400)
            if not r.ok:
                print(f"  {plain}: HTTP {r.status}")
                break
            hits = (r.json() or {}).get("hits", {})
            total = hits.get("total")
            records += hits.get("hits", [])
            if len(hits.get("hits", [])) < PER_PAGE:
                break
        for rec in records:
            m = rec.get("metadata", {})
            creators = [c.get("name", "").split(",")[0].strip() for c in m.get("creators", [])]
            source = next((x["identifier"] for x in m.get("related_identifiers", [])
                           if re.search(r"github\.com|gitlab\.com", x.get("identifier", ""))), "")
            for x in m.get("related_identifiers", []):
                ident = x.get("identifier", "").lower()
                ident = re.sub(r"^https?://(dx\.)?doi\.org/", "", ident)
                if not ident.startswith(plain.lower()):
                    continue
                # eLife versions the DOIs of reviewed preprints: …eLife.93063.3 → …eLife.93063
                ident = re.sub(r"^(10\.7554/elife\.\d+)\.\d+$", r"\1", ident)
                e = benchmark.setdefault(ident, {"doi": ident, "software": []})
                e["software"].append({"zenodo": str(rec["id"]), "relation": x.get("relation", ""),
                                      "creators": creators, "source": source, "title": m.get("title", "")[:120]})
                n += 1
        print(f"  {plain}: {total} software records in all, {n} links kept")
    BENCHMARK.parent.mkdir(parents=True, exist_ok=True)
    BENCHMARK.write_text(json.dumps(list(benchmark.values()), ensure_ascii=False, indent=1))
    DOIS.write_text("\n".join(benchmark) + "\n")
    print(f"{len(benchmark)} papers → {DOIS}")


def _concept(client: Client, ident: str) -> str:
    """A Zenodo software record has one version per release and a common CONCEPT id:
    11389725 and 11389726 are the same software. Concepts are compared, not versions."""
    r = client.get(f"https://zenodo.org/api/records/{ident}", ttl_s=30 * 86400)
    if not r.ok:
        return ident
    return str((r.json() or {}).get("conceptrecid") or ident)


WITH_DATACITE = True


def measure(db_path: Path) -> None:
    benchmark = json.loads(BENCHMARK.read_text())
    client = Client(Cache(ROOT / "data" / "cache"))
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows: dict[str, list[dict]] = {"native": [], "cited": []}
    for e in benchmark:
        a = con.execute("SELECT * FROM article WHERE doi = ?", (e["doi"],)).fetchone()
        if a is None:
            continue
        # Europe PMC writes "Witteveen O", "Thanh Hoang Nhat L": every word but the
        # final initials.
        authors = {_flat(t) for n in json.loads(a["authors"]) if n
                   for t in (n.split()[:-1] or n.split()) if len(t) > 1}
        every = {r["repo"]: r for r in con.execute(
            "SELECT l.repo, l.found_by, r.linked_to FROM link l LEFT JOIN repository r ON r.repo = l.repo "
            "WHERE l.article_id = ? AND l.role = 'code'", (a["id"],))}
        # DataCite reads the SAME Zenodo relations that built the benchmark: what it finds
        # is half circular. The recall is also measured without it.
        code = every if WITH_DATACITE else {n: r for n, r in every.items()
                                            if not r["found_by"].startswith("datacite")}
        for n in list(code):
            if n.startswith("zenodo:"):
                code[f"zenodo-concept:{_concept(client, n.split(':', 1)[1])}"] = code[n]
        for sw in e["software"]:
            # Zenodo writes "Family, Given" OR "Given Family": every word counts ("Olivier
            # Witteveen" missed "Witteveen O" — 73 pairs misfiled).
            creators = {_flat(t) for c in sw["creators"] for t in re.split(r"[\s,.]+", c) if len(t) > 1}
            own = bool(authors & creators)
            targets = {f"zenodo:{sw['zenodo']}", f"zenodo-concept:{_concept(client, sw['zenodo'])}"}
            if sw["source"]:
                m = re.search(r"github\.com/([^/]+)/([^/#?]+)", sw["source"])
                if m:
                    targets.add(f"github.com/{m.group(1).lower()}/{m.group(2).lower().removesuffix('.git')}")
            same = bool(targets & set(code)) or any(
                (r["linked_to"] or "").lower().find(t.split(":", 1)[-1]) >= 0 for r in code.values()
                for t in targets if t.startswith("github.com"))
            rows["native" if own else "cited"].append({
                "doi": e["doi"], "status": a["status"], "has_fulltext": a["has_fulltext"],
                "some_code": bool(code), "same_repository": same, "relation": sw["relation"],
                "zenodo": sw["zenodo"]})
    for kind, rs in rows.items():
        if not rs:
            continue
        n = len(rs)
        some = sum(r["some_code"] for r in rs)
        same = sum(r["same_repository"] for r in rs)
        with_text = [r for r in rs if r["has_fulltext"]]
        print(f"\n{kind.upper()} ({'Zenodo creator = author' if kind == 'native' else 'no common creator'})"
              f": {n} paper↔software pairs")
        print(f"  the paper gets at least one authors' code: {some}/{n} ({100 * some / n:.0f}%)")
        print(f"  the harvester finds THAT repository (Zenodo or its GitHub source): {same}/{n} ({100 * same / n:.0f}%)")
        if with_text:
            t = sum(r["same_repository"] for r in with_text)
            print(f"  … among the {len(with_text)} papers with a readable full text: {t} ({100 * t / len(with_text):.0f}%)")
        for r in [r for r in rs if not r["same_repository"]][:12]:
            print(f"    missed: {r['doi']} zenodo:{r['zenodo']} ({r['relation']}) status={r['status']} "
                  f"fulltext={r['has_fulltext']}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["build"]:
        build(Client(Cache(ROOT / "data" / "cache")))
    elif sys.argv[1:2] == ["measure"]:
        db_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data" / "oscr.db"
        print("== every path")
        measure(db_path)
        WITH_DATACITE = False
        print("\n== without DataCite (the text, Crossref, the archive records)")
        measure(db_path)
    else:
        print(__doc__)
