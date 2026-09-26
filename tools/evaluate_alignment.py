"""Run the paper <-> code alignment engine on a dataset and print what it pairs.

Usage:
    .venv/bin/python tools/evaluate_alignment.py [DATASET_DIR] [--article ID ...] [--context]

DATASET_DIR holds one JSON file per article: {"article_id", "doi", "pmcid",
"title", "jats", "files": [{"repo", "path", "language", "text"}]}. It
defaults to $OSCR_ALIGNMENT_DATASET, else to data/alignment_dataset, the set assembled on
2026-09-26 (25 articles).

For each article the script prints every pair with its evidence, then summary
statistics: pairs per article, how the scores spread, and the engine's time
per article. --context also prints the start of each paragraph and of each
code range, to judge pairs by hand; that output is for local review only
(OSCR never republishes article text).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oscr.align import METHOD, align, code_units, paper_paragraphs  # noqa: E402

#: The 25 hand-checked papers (their paragraphs and code): local only, under data/, since
#: the paragraphs are article text, which is never published.
DEFAULT_DATASET = str(Path(__file__).resolve().parents[1] / "data" / "alignment_dataset")


def load_articles(folder: Path, only: set[str]) -> list[tuple[str, dict]]:
    articles = []
    for path in sorted(folder.glob("*.json")):
        if only and path.stem not in only:
            continue
        with path.open(encoding="utf-8") as f:
            articles.append((path.stem, json.load(f)))
    return articles


def short(text: str, width: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= width else text[: width - 1] + "…"


def print_article(name: str, article: dict, context: bool) -> tuple[int, float, list[float], Counter[str]]:
    files = article.get("files", [])
    jats = article.get("jats", "")
    started = time.perf_counter()
    pairs = align(jats, files)
    elapsed = time.perf_counter() - started
    paragraphs = paper_paragraphs(jats)
    n_units = sum(len(code_units(f["repo"], f["path"], f["language"], f["text"])) for f in files)
    languages = Counter(f["language"] for f in files)
    print(f"== {name}  {article.get('pmcid', '')}  {short(article.get('title', ''), 80)}")
    print(f"   {len(paragraphs)} paragraphs, {len(files)} files ({', '.join(f'{k} {v}' for k, v in languages.most_common())}), "
          f"{n_units} code units -> {len(pairs)} pairs in {elapsed:.2f} s")
    texts = {(f["repo"], f["path"]): f["text"] for f in files}
    paired_languages: Counter[str] = Counter()
    by_path = {(f["repo"], f["path"]): f["language"] for f in files}
    for p in pairs:
        symbol = f" ({p.symbol})" if p.symbol else ""
        print(f"   #{p.pair:<2} {p.score:.3f}  [{p.paragraph}] {short(p.section, 60)}")
        print(f"        -> {p.path}:{p.start_line}-{p.end_line}{symbol}")
        print(f"        evidence: {', '.join(p.evidence)}")
        paired_languages[by_path.get((p.repo, p.path), "?")] += 1
        if context:
            print(f"        paragraph: {short(paragraphs[p.paragraph].text, 160)}")
            lines = texts[(p.repo, p.path)].split("\n")[p.start_line - 1 : p.end_line]
            for line in [ln for ln in lines if ln.strip()][:4]:
                print(f"        | {short(line, 110)}")
    print()
    return len(pairs), elapsed, [p.score for p in pairs], paired_languages


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("dataset", nargs="?", default=os.environ.get("OSCR_ALIGNMENT_DATASET", DEFAULT_DATASET))
    parser.add_argument("--article", action="append", default=[], help="article file stem, e.g. 05 (repeatable)")
    parser.add_argument("--context", action="store_true", help="also print paragraph and code excerpts (local review)")
    args = parser.parse_args()

    folder = Path(args.dataset)
    articles = load_articles(folder, set(args.article))
    if not articles:
        sys.exit(f"no article JSON found in {folder}")

    print(f"alignment method {METHOD} on {len(articles)} articles from {folder}\n")
    counts: list[int] = []
    times: list[float] = []
    scores: list[float] = []
    languages: Counter[str] = Counter()
    for name, article in articles:
        n, elapsed, article_scores, paired = print_article(name, article, args.context)
        counts.append(n)
        times.append(elapsed)
        scores.extend(article_scores)
        languages.update(paired)

    print("== summary")
    print(f"   articles: {len(counts)}, pairs: {sum(counts)}, articles without pairs: {sum(1 for c in counts if c == 0)}")
    print(f"   pairs per article: min {min(counts)}, median {statistics.median(counts):g}, "
          f"mean {statistics.mean(counts):.1f}, max {max(counts)}")
    print("   per article: " + ", ".join(f"{name} {c}" for (name, _), c in zip(articles, counts)))
    if scores:
        quartiles = statistics.quantiles(scores, n=4, method="inclusive") if len(scores) > 1 else [scores[0]] * 3
        print(f"   scores: min {min(scores):.3f}, quartiles {', '.join(f'{q:.3f}' for q in quartiles)}, max {max(scores):.3f}")
        print("   paired code by language: " + ", ".join(f"{k} {v}" for k, v in languages.most_common()))
    print(f"   time per article: mean {statistics.mean(times):.2f} s, median {statistics.median(times):.2f} s, "
          f"max {max(times):.2f} s, total {sum(times):.1f} s")


if __name__ == "__main__":
    main()
