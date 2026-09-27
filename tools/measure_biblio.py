"""Measure what `oscr.biblio.from_jats` reads from the cached JATS full texts.

Usage:
    .venv/bin/python tools/measure_biblio.py [--cache DIR] [--limit N]

The cache is read, never written: each full text is a file whose sibling `.meta` JSON holds its
`url` (ending in `/fullTextXML`) and its `status`. DIR defaults to $OSCR_CACHE, else to
data/cache.

Prints, for each field of the record (and each key of `journal` and `dates`), the share of papers
where it is non-empty: over all texts, then per JATS flavour (a normal `<back>`; the back matter
in the body; front matter only). Then a few shares inside the fields (authors with an ORCID,
references with a DOI…), the most frequent values of `type` and `license`, and the parsing time.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oscr import biblio  # noqa: E402

DEFAULT_CACHE = os.environ.get("OSCR_CACHE") or str(Path(__file__).resolve().parents[1] / "data" / "cache")
FLAVOURS = ("back", "body", "front")
FLAVOUR_NAMES = {"back": "normal <back>", "body": "back matter in <body>", "front": "front only"}


def full_texts(cache: Path) -> list[Path]:
    """The cached full texts: the files whose `.meta` URL ends in /fullTextXML."""
    paths = []
    for meta in sorted(cache.glob("*/*.meta")):
        try:
            m = json.loads(meta.read_text())
        except (OSError, ValueError):
            continue
        body = meta.with_suffix("")
        if str(m.get("url", "")).endswith("/fullTextXML") and m.get("status") == 200 and body.exists():
            paths.append(body)
    return paths


def flavour(xml: str) -> str:
    """Where the back matter sits. Sub-articles (reviews, responses) do not count."""
    main = xml.split("<sub-article", 1)[0]
    if re.search(r"<back[\s>]", main):
        return "back"
    return "body" if re.search(r"<body[\s>]", main) else "front"


def filled(record: dict) -> list[str]:
    """The names of the non-empty fields of a record; `journal` and `dates` key by key."""
    names = [k for k in biblio.SCALARS + biblio.LISTS if not biblio._is_empty(record[k])]
    for group in ("journal", "dates"):
        names += [f"{group}.{k}" for k, v in record[group].items() if not biblio._is_empty(v)]
    return names


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    paths = full_texts(Path(args.cache))
    if args.limit:
        paths = paths[:args.limit]
    if not paths:
        sys.exit(f"no cached full text under {args.cache}")

    papers = Counter()                       # per flavour
    counts = {f: Counter() for f in FLAVOURS}
    inner = Counter()
    types, licenses, kinds = Counter(), Counter(), Counter()
    errors: list[tuple[str, str]] = []
    slowest: list[tuple[float, str]] = []
    parse_s = 0.0
    for path in paths:
        xml = path.read_text(encoding="utf-8", errors="replace")
        t = time.perf_counter()
        try:
            record = biblio.from_jats(xml)
        except Exception as e:  # noqa: BLE001 — a measurement reports failures, it does not stop
            errors.append((path.name, repr(e)))
            continue
        dt = time.perf_counter() - t
        parse_s += dt
        slowest = sorted(slowest + [(dt, path.name)], reverse=True)[:3]
        f = flavour(xml)
        papers[f] += 1
        counts[f].update(filled(record))
        types[record["type"] or "(none)"] += 1
        licenses[record["license"] or "(none)"] += 1
        kinds.update({s["kind"] for s in record["statements"]})
        authors = record["authors"]
        inner["authors"] += len(authors)
        inner["authors with an ORCID"] += sum(1 for a in authors if a["orcid"])
        inner["authors with an affiliation"] += sum(1 for a in authors if a["affiliations"])
        inner["authors with a ROR id"] += sum(1 for a in authors if a["ror"])
        inner["papers with authors"] += bool(authors)
        inner["papers with a corresponding author"] += any(a["corresponding"] for a in authors)
        inner["references"] += record["references_count"] or 0
        inner["references with a DOI"] += sum(1 for r in record["references"] if r["doi"])
        inner["references with a PMID"] += sum(1 for r in record["references"] if r["pmid"])
        inner["papers with funding"] += bool(record["funding"])
        inner["papers with an award number"] += any(x["awards"] for x in record["funding"])
        inner["papers with a funder id"] += any(x["funder_id"] for x in record["funding"])

    n = sum(papers.values())
    print(f"{n} cached full texts ({len(errors)} errors) — "
          + ", ".join(f"{FLAVOUR_NAMES[f]} {papers[f]} ({papers[f] / n:.0%})" for f in FLAVOURS))
    print(f"parsing: {parse_s:.1f} s in total, {1000 * parse_s / max(n, 1):.1f} ms per text; "
          "slowest " + ", ".join(f"{name[:12]} {1000 * dt:.0f} ms" for dt, name in slowest))
    print()
    header = f"{'field':<26}{'all':>7}" + "".join(f"{f:>8}" for f in FLAVOURS)
    print(header)
    print("-" * len(header))
    fields = [k for k in biblio.SCALARS] + [f"journal.{k}" for k in biblio.JOURNAL_KEYS] \
        + [f"dates.{k}" for k in biblio.DATE_KEYS] + list(biblio.LISTS)
    for field in fields:
        total = sum(counts[f][field] for f in FLAVOURS)
        cells = "".join(f"{counts[f][field] / papers[f]:>8.0%}" if papers[f] else f"{'-':>8}"
                        for f in FLAVOURS)
        print(f"{field:<26}{total / n:>7.0%}{cells}")
    print()
    print("inside the fields")
    for num, den in (("authors with an ORCID", "authors"), ("authors with an affiliation", "authors"),
                     ("authors with a ROR id", "authors"),
                     ("papers with a corresponding author", "papers with authors"),
                     ("references with a DOI", "references"), ("references with a PMID", "references"),
                     ("papers with an award number", "papers with funding"),
                     ("papers with a funder id", "papers with funding")):
        print(f"  {num:<36} {inner[num] / max(inner[den], 1):>5.0%}  ({inner[num]:,} / {inner[den]:,} {den})")
    print("  statements by kind: " + ", ".join(f"{k} {v} ({v / n:.0%} of texts)" for k, v in kinds.most_common()))
    print("  type: " + ", ".join(f"{k} {v}" for k, v in types.most_common(12)))
    print("  license: " + ", ".join(f"{k} {v}" for k, v in licenses.most_common(10)))
    for name, error in errors[:10]:
        print(f"  error {name}: {error}")


if __name__ == "__main__":
    main()
