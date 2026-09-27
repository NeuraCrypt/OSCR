"""Build the owner's annotation sample (decision D6), and measure the classification rules.

Usage:
    .venv/bin/python tools/make_annotation_sample.py [--db DB] [--cache DIR] [--out DIR]
                                                     [--size 150] [--seed 20260927] [--force]
    .venv/bin/python tools/make_annotation_sample.py --measure-only [--examples]

It reads a database (read-only) and the cached full texts, runs `oscr.classify` over every
paper, prints the measurement (the distribution of each facet, the share left ambiguous,
the off-topic count), then writes to `--out` (default: data/annotation/):

- `sample.csv`: the stratified sample the owner labels by hand. Columns: id, doi, url,
  journal, year, type, title, keywords, abstract (plain text, at most 1,500 characters),
  then the owner's EMPTY columns: on_topic, modality, organism, population, subfield,
  notes. UTF-8 with a byte-order mark, commas, every field quoted: it opens cleanly in
  Numbers and Excel. The rows are in random order.
- `rules_predictions.csv`: what the rules say for the same papers, kept apart so that the
  owner's labels are not biased by them (`tools/compare_models.py` compares both later).
- `inputs.jsonl`: the complete inputs of `classify` for the sample (full abstracts): what
  the local models are given.

**These files hold titles and abstracts: they stay on the Mac, under data/ (never
versioned).** An existing sample that the owner has started to fill is never overwritten
(`--force` to replace it anyway). `--examples` also prints 15 titles judged off-topic and
15 borderline ones, for a review in the terminal only.
"""
from __future__ import annotations

import argparse
import collections
import csv
import html
import json
import random
import re
import sqlite3
import sys
from collections.abc import Iterable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oscr import classify as C  # noqa: E402
from oscr.net import Cache  # noqa: E402
from oscr.sources.europepmc import BASE  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "oscr.db"
DEFAULT_CACHE = ROOT / "data" / "cache"
DEFAULT_OUT = ROOT / "data" / "annotation"

SEED = 20260927
SIZE = 150
ABSTRACT_MAX = 1500
#: No journal gives more papers than this to the sample.
PER_JOURNAL = 3

#: The columns of the owner's file: first what to read, then what to fill.
PAPER_COLUMNS = ("id", "doi", "url", "journal", "year", "type", "title", "keywords", "abstract")
OWNER_COLUMNS = ("on_topic", "modality", "organism", "population", "subfield", "notes")
SAMPLE_COLUMNS = PAPER_COLUMNS + OWNER_COLUMNS

#: A paper "with code": the authors' repository was found (whatever its state).
CODE_STATUSES = frozenset({"code_verified", "code_found", "code_empty", "code_dead"})

#: The JATS article types, grouped for the stratification.
TYPE_GROUPS: dict[str, str] = {
    "research-article": "research", "review-article": "review", "systematic-review": "review",
    "abstract": "conference abstract", "meeting-report": "conference abstract",
    "case-report": "case report", "case-study": "case report",
    "brief-report": "short", "letter": "short", "article-commentary": "short",
    "editorial": "short", "discussion": "short", "reply": "short",
    "correction": "notice", "retraction": "notice", "addendum": "notice",
    "methods-article": "methods or data", "data-paper": "methods or data",
}

#: The minimum number of papers of each kind in the sample (a paper counts for all its kinds).
QUOTAS: dict[tuple[str, str], int] = {
    ("rules", "off-topic"): 25,
    ("rules", "ambiguous"): 25,
    ("code", "with code"): 40,
    ("type", "review"): 15,
    ("type", "conference abstract"): 10,
    ("type", "case report"): 10,
    ("type", "short"): 6,
    ("type", "notice"): 4,
    ("type", "methods or data"): 4,
    ("type", "other or unknown"): 4,
}
#: Each year other than the most frequent one gets at least this many papers.
YEAR_MINIMUM = 4


# --------------------------------------------------------------------------------------
# Reading the papers
# --------------------------------------------------------------------------------------

def _plain_title(title: str) -> str:
    """A database title, whose inline markup is HTML-escaped ("&lt;i&gt;Prevotella&lt;/i&gt;")."""
    text = html.unescape(html.unescape(title or ""))
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text)).strip()


def load_papers(db: Path, cache: Path) -> list[dict]:
    """Every paper of the database, with what `classify` reads: from the cached JATS full
    text when there is one, from the database otherwise. The database is opened read-only."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, doi, pmcid, fulltext_id, title, journal, published, status, families, methods"
        " FROM article ORDER BY id").fetchall()
    con.close()
    store = Cache(cache)
    papers = []
    for r in rows:
        jats: dict = {}
        if r["fulltext_id"]:
            hit = store.read(f"{BASE}/{r['fulltext_id']}/fullTextXML", None)
            if hit is not None and hit.text.lstrip().startswith("<"):
                jats = C.paper_from_jats(hit.text)
        papers.append({
            "id": r["id"], "doi": r["doi"], "pmcid": r["pmcid"], "status": r["status"],
            "year": (r["published"] or "")[:4],
            "title": jats.get("title") or _plain_title(r["title"]),
            "abstract": jats.get("abstract", ""),
            "keywords": jats.get("keywords", []),
            "subjects": jats.get("subjects", []),
            "journal": r["journal"] or jats.get("journal", ""),
            "type": jats.get("type", ""),
            "families": json.loads(r["families"] or "[]"),
            "methods": json.loads(r["methods"] or "[]"),
            "has_text": bool(jats),
        })
    return papers


def classifier_input(paper: dict) -> dict:
    keys = ("title", "abstract", "keywords", "subjects", "journal", "type", "families", "methods")
    return {k: paper.get(k) for k in keys}


# --------------------------------------------------------------------------------------
# The sample
# --------------------------------------------------------------------------------------

def rules_class(result: dict) -> str:
    on_topic = result["on_topic"]
    if on_topic["ambiguous"]:
        return "ambiguous"
    return "off-topic" if on_topic["values"][0]["value"] == "no" else "on-topic"


def kinds(paper: dict, result: dict) -> set[tuple[str, str]]:
    """The strata a paper belongs to."""
    return {
        ("rules", rules_class(result)),
        ("code", "with code" if paper.get("status") in CODE_STATUSES else "without code"),
        ("type", TYPE_GROUPS.get(paper.get("type", ""), "other or unknown")),
        ("year", paper.get("year") or "unknown"),
    }


def stratified_sample(papers: list[dict], results: list[dict], size: int = SIZE,
                      seed: int = SEED, per_journal: int = PER_JOURNAL) -> list[int]:
    """Indexes of `size` papers: first the quotas (rarest first), then the years other than
    the main one, then random papers; never more than `per_journal` from one journal.
    Deterministic for a given seed."""
    rng = random.Random(seed)
    order = list(range(len(papers)))
    rng.shuffle(order)
    tags = [kinds(p, r) for p, r in zip(papers, results)]
    journals: collections.Counter[str] = collections.Counter()
    chosen: list[int] = []
    taken: set[int] = set()

    def take(i: int) -> bool:
        journal = (papers[i].get("journal") or "?").lower()
        if i in taken or journals[journal] >= per_journal or len(chosen) >= size:
            return False
        chosen.append(i)
        taken.add(i)
        journals[journal] += 1
        return True

    years = collections.Counter(p.get("year") or "unknown" for p in papers)
    main_year = years.most_common(1)[0][0] if years else ""
    quotas = dict(QUOTAS)
    for year in years:
        if year != main_year:
            quotas[("year", year)] = min(YEAR_MINIMUM, years[year])
    available = collections.Counter(t for ts in tags for t in ts)
    for kind in sorted(quotas, key=lambda k: available[k]):
        have = sum(1 for i in chosen if kind in tags[i])
        for i in order:
            if have >= quotas[kind]:
                break
            if kind in tags[i] and take(i):
                have += 1
    for i in order:
        if len(chosen) >= size:
            break
        take(i)
    rng.shuffle(chosen)         # the owner reads them in random order, not by stratum
    return chosen


def composition(papers: list[dict], results: list[dict], chosen: Iterable[int]) -> dict[str, dict[str, int]]:
    """What the sample holds, per stratum, plus its number of journals."""
    out: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    chosen = list(chosen)
    for i in chosen:
        for dimension, value in kinds(papers[i], results[i]):
            out[dimension][value] += 1
        out["article type"][papers[i].get("type") or "unknown"] += 1
    result = {k: dict(sorted(v.items(), key=lambda x: -x[1])) for k, v in out.items()}
    result["journals"] = {"distinct": len({(papers[i].get("journal") or "?").lower() for i in chosen})}
    return result


# --------------------------------------------------------------------------------------
# The files
# --------------------------------------------------------------------------------------

def write_csv(path: Path, columns: Iterable[str], rows: Iterable[dict]) -> None:
    """A CSV that opens cleanly in Numbers and Excel: UTF-8 with a byte-order mark, commas,
    every field quoted, CRLF line ends. Written next to it, then renamed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    columns = list(columns)
    with tmp.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, quoting=csv.QUOTE_ALL, lineterminator="\r\n",
                                extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({c: _cell(row.get(c, "")) for c in columns})
    tmp.replace(path)


def read_csv(path: Path) -> list[dict[str, str]]:
    """The rows of a CSV written by `write_csv` (or saved again by Numbers or Excel)."""
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return C.SEPARATOR.join(str(v) for v in value)
    return str(value)


def shorten(text: str, limit: int = ABSTRACT_MAX) -> str:
    """At most `limit` characters, cut at a word boundary, marked with an ellipsis."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    if " " in cut[limit // 2:]:
        cut = cut[:cut.rfind(" ")]
    return cut.rstrip(" ,;:") + "…"


def paper_url(paper: dict) -> str:
    if paper.get("doi"):
        return f"https://doi.org/{paper['doi']}"
    if paper.get("pmcid"):
        return f"https://europepmc.org/article/PMC/{paper['pmcid'].removeprefix('PMC')}"
    source, _, ext = str(paper.get("id", "")).removeprefix("epmc:").partition(":")
    if str(paper.get("id", "")).startswith("epmc:") and ext:
        return f"https://europepmc.org/article/{source}/{ext}"      # e.g. a PubMed-only record
    return ""


def sample_row(paper: dict) -> dict:
    return {
        "id": paper["id"], "doi": paper.get("doi", ""), "url": paper_url(paper),
        "journal": paper.get("journal", ""), "year": paper.get("year", ""),
        "type": paper.get("type", ""), "title": paper.get("title", ""),
        "keywords": paper.get("keywords", []), "abstract": shorten(paper.get("abstract", "")),
        # The owner's columns stay empty: pre-filling them would bias the evaluation.
        **{c: "" for c in OWNER_COLUMNS},
    }


PREDICTION_COLUMNS = ("id", "publishable") + tuple(
    f"{facet}{suffix}" for facet in C.FACETS
    for suffix in ("", "_confidence", "_ambiguous", "_candidates", "_reasons"))


def prediction_row(paper_id: str, result: dict) -> dict:
    """What the rules answer: `<facet>` holds the values they claim (confidence at least
    `classify.DECIDE`, "-" for not applicable), `<facet>_ambiguous` whether they leave the
    facet to the model, `<facet>_candidates` everything they considered."""
    row: dict = {"id": paper_id, "publishable": "yes" if C.is_publishable(result) else "no"}
    for facet in C.FACETS:
        f = result[facet]
        claimed = C.decided(result, facet)
        confidence = {v["value"]: v["confidence"] for v in f["values"]}
        not_applicable = not f["values"] and not f["ambiguous"]
        row[facet] = C.NOT_APPLICABLE if not_applicable else claimed
        row[f"{facet}_confidence"] = [f"{confidence[v]:.2f}" for v in claimed]
        row[f"{facet}_ambiguous"] = "yes" if f["ambiguous"] else "no"
        row[f"{facet}_candidates"] = [f"{v['value']} {v['confidence']:.2f}" for v in f["values"]]
        row[f"{facet}_reasons"] = " | ".join(r for v in f["values"][:2] for r in v["reasons"][:3])
    return row


def owner_started(path: Path) -> bool:
    """True when the owner has written anything in an existing sample."""
    if not path.exists():
        return False
    return any((row.get(c) or "").strip() for row in read_csv(path) for c in OWNER_COLUMNS)


# --------------------------------------------------------------------------------------
# The measurement
# --------------------------------------------------------------------------------------

def measure(papers: list[dict], results: list[dict], examples: bool, seed: int = SEED) -> None:
    n = len(results)
    publishable = [r for r in results if C.is_publishable(r)]
    print(f"Papers classified: {n} ({sum(p['has_text'] for p in papers)} with a cached full text)")
    classes = collections.Counter(rules_class(r) for r in results)
    print(f"on_topic: {classes['on-topic']} on-topic, {classes['off-topic']} off-topic "
          f"(kept out of the site: {n - len(publishable)}), {classes['ambiguous']} ambiguous")
    for facet in C.FACETS:
        ambiguous = sum(r[facet]["ambiguous"] for r in results)
        ambiguous_pub = sum(r[facet]["ambiguous"] for r in publishable)
        counts: collections.Counter[str] = collections.Counter()
        for r in publishable:
            f = r[facet]
            if f["ambiguous"]:
                continue
            if not f["values"]:
                counts[C.NOT_APPLICABLE] += 1
            for v in f["values"]:
                counts[v["value"]] += 1
        print(f"\n{facet}: ambiguous {ambiguous}/{n} ({ambiguous / n:.0%}); among the "
              f"publishable papers {ambiguous_pub}/{len(publishable)} "
              f"({ambiguous_pub / max(1, len(publishable)):.0%})")
        print("  settled values (publishable papers): " +
              ", ".join(f"{v} {c}" for v, c in counts.most_common()))
    any_ambiguous = sum(1 for r in results if any(r[f]["ambiguous"] for f in C.FACETS))
    needs = sum(1 for r in results if C.needs_model(r))
    print(f"\nPapers with at least one ambiguous facet: {any_ambiguous}/{n} ({any_ambiguous / n:.0%}); "
          f"papers a model would be asked about: {needs}/{n} ({needs / n:.0%})")
    if not examples:
        return
    rng = random.Random(seed)
    off = [p["title"] for p, r in zip(papers, results) if rules_class(r) == "off-topic"]
    border = [p["title"] for p, r in zip(papers, results) if rules_class(r) == "ambiguous"]
    print("\n15 titles judged off-topic (terminal only):")
    for t in rng.sample(off, min(15, len(off))):
        print(f"  - {t}")
    print("\n15 borderline titles (on_topic ambiguous; terminal only):")
    for t in rng.sample(border, min(15, len(border))):
        print(f"  - {t}")


# --------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="database, opened read-only")
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE, help="the cached full texts")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="where the annotation files go")
    ap.add_argument("--size", type=int, default=SIZE)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--measure-only", action="store_true", help="print the measurement, write nothing")
    ap.add_argument("--examples", action="store_true",
                    help="also print 15 off-topic and 15 borderline titles (terminal only)")
    ap.add_argument("--force", action="store_true", help="replace a sample the owner has started")
    a = ap.parse_args(argv)

    papers = load_papers(a.db, a.cache)
    results = [C.classify(classifier_input(p)) for p in papers]
    measure(papers, results, a.examples, a.seed)
    if a.measure_only:
        return 0
    sample_path = a.out / "sample.csv"
    if owner_started(sample_path) and not a.force:
        print(f"\n{sample_path} already holds the owner's labels: not overwritten (--force to replace it).")
        return 1
    chosen = stratified_sample(papers, results, a.size, a.seed)
    write_csv(sample_path, SAMPLE_COLUMNS, (sample_row(papers[i]) for i in chosen))
    write_csv(a.out / "rules_predictions.csv", PREDICTION_COLUMNS,
              (prediction_row(papers[i]["id"], results[i]) for i in chosen))
    with (a.out / "inputs.jsonl").open("w", encoding="utf-8") as f:
        for i in chosen:
            f.write(json.dumps({"id": papers[i]["id"], **classifier_input(papers[i])},
                               ensure_ascii=False) + "\n")
    print(f"\nSample of {len(chosen)} papers written to {a.out} (seed {a.seed}):")
    for dimension, counts in composition(papers, results, chosen).items():
        print(f"  {dimension}: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
