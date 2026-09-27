"""Measure oscr.repofeatures on a copy of the database: repository features and tools used.

Usage:
    .venv/bin/python tools/measure_repofeatures.py [DB] [--top N] [--sample N] [--seed S]

DB is a copy of the harvester's database, opened read-only; it defaults to
$OSCR_SNAPSHOT_DB, else to data/dev/oscr-snapshot.db.

The script prints:

1. `features()` over every repository whose list of paths is known: how many have a README,
   a CITATION.cff, a license file, environment files, tests, CI, docs, notebooks, and how
   much of their content looks like data;
2. `detect_tools()` over every repository with stored scripts: the most used tools, the
   routes and methods of the detections, how many tools a repository uses, and the
   repositories where none was found (with their languages, to see why);
3. random samples of (repository, tool) detections — all routes, then calls and
   declarations only — with the lines that name the tool in the first example file, to be
   judged by hand. Those lines are the authors' code: the output is for local review only.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oscr.repofeatures import detect_tools, features, vocabulary  # noqa: E402

DEFAULT_DB = os.environ.get("OSCR_SNAPSHOT_DB") or str(
    Path(__file__).resolve().parents[1] / "data" / "dev" / "oscr-snapshot.db")

#: Hosts whose list of paths is a git tree; the others list a record's files (often zips).
FORGES = ("github.com", "gitlab.com", "codeberg.org", "gin.g-node.org", "huggingface.co",
          "bitbucket.org")

FLAGS = ("has_readme", "has_citation_cff", "has_license_file", "env_files", "has_tests",
         "has_ci", "has_docs", "n_notebooks")


def pct(n: int, total: int) -> str:
    return f"{n:5d}  {100 * n / total:5.1f}%" if total else f"{n:5d}"


def open_db(path: str) -> sqlite3.Connection:
    if not Path(path).exists():
        sys.exit(f"no database at {path}")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def is_forge(host: str) -> bool:
    return host in FORGES or host.startswith("gitlab.")


def measure_features(con: sqlite3.Connection, stored_paths: dict[str, list[str]]) -> None:
    rows = con.execute("SELECT repo, host, files FROM repository WHERE files != '[]'").fetchall()
    groups: dict[str, list[dict]] = defaultdict(list)
    env_names: Counter[str] = Counter()
    for repo, host, files in rows:
        paths = json.loads(files)
        f = features(paths)
        groups["all"].append(f)
        groups["forges" if is_forge(host) else "archives"].append(f)
        if not is_forge(host) and repo in stored_paths:
            groups["archives, with the paths of their stored files"].append(
                features(paths + stored_paths[repo]))
        env_names.update({p.rsplit("/", 1)[-1] for p in f["env_files"]})
    print("1. features() over the repositories whose list of paths is known\n")
    for name, fs in groups.items():
        n = len(fs)
        print(f"   {name}: {n} repositories")
        for flag in FLAGS:
            count = sum(1 for f in fs if f[flag])
            print(f"     {flag:18s} {pct(count, n)}")
        data = [f["data_like"] for f in fs]
        mostly_data = sum(1 for d in data if d >= 0.5)
        print(f"     {'data_like mean':18s} {sum(data) / n:.3f}   (>= 0.5: {pct(mostly_data, n).strip()})")
        print(f"     {'files (median)':18s} {sorted(f['n_files'] for f in fs)[n // 2]}")
        print()
    print("   environment files, by name:", ", ".join(f"{k} {v}" for k, v in env_names.most_common(15)))
    print()


def load_scripts(con: sqlite3.Connection) -> dict[str, list[tuple[str, str, str]]]:
    by_repo: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
    for repo, path, language, text in con.execute(
            "SELECT repo, path, language, text FROM file WHERE kind = 'script' ORDER BY repo, path"):
        by_repo[repo].append((path, language, text))
    return by_repo


def measure_tools(con: sqlite3.Connection, scripts: dict[str, list[tuple[str, str, str]]],
                  top: int) -> dict[str, list[dict]]:
    started = time.perf_counter()
    results = {repo: detect_tools(files) for repo, files in scripts.items()}
    elapsed = time.perf_counter() - started
    n_files = sum(len(f) for f in scripts.values())
    print(f"2. detect_tools() over {len(results)} repositories with stored scripts "
          f"({n_files} files, {elapsed:.1f} s)\n")
    names = {t["id"]: t["name"] for t in vocabulary()}
    repos_per_tool: Counter[str] = Counter()
    via: dict[str, Counter[str]] = defaultdict(Counter)
    routes: Counter[str] = Counter()
    methods: Counter[str] = Counter()
    for found in results.values():
        for d in found:
            repos_per_tool[d["tool"]] += 1
            via[d["tool"]][d["via"]] += 1
            routes[d["via"]] += 1
            methods[d["detected_by"]] += 1
    detections = sum(routes.values())
    print(f"   {detections} (repository, tool) detections, {len(repos_per_tool)} distinct tools "
          f"of the {len(names)} in the vocabulary")
    print("   routes: " + ", ".join(f"{r} {n}" for r, n in routes.most_common())
          + "; methods: " + ", ".join(f"{m} {n}" for m, n in methods.most_common()))
    print(f"\n   top {top} tools (repositories, and the route of their detections)")
    for rank, (tool, n) in enumerate(repos_per_tool.most_common(top), 1):
        routes_of = ", ".join(f"{r} {c}" for r, c in via[tool].most_common())
        print(f"   {rank:3d}. {names[tool]:42s} {n:4d}   ({routes_of})")
    sizes = Counter(min(len(f), 11) for f in results.values())
    buckets = [("0", [0]), ("1-2", [1, 2]), ("3-5", [3, 4, 5]), ("6-10", range(6, 11)), (">10", [11])]
    print("\n   tools per repository: " + ", ".join(
        f"{label}: {sum(sizes[k] for k in keys)}" for label, keys in buckets))
    none = sorted(repo for repo, found in results.items() if not found)
    print(f"\n   repositories with no tool detected: {pct(len(none), len(results)).strip()}")
    for repo in none:
        langs = Counter(language or "?" for _, language, _ in scripts[repo])
        print(f"     {repo:70s} {', '.join(f'{k} {v}' for k, v in langs.most_common(4))}")
    # the paths that were not stored (no text) still say something by their type
    added: Counter[str] = Counter()
    for repo, files_json in con.execute("SELECT repo, files FROM repository WHERE files != '[]'"):
        stored = {p for p, _, _ in scripts.get(repo, [])}
        others = [(p, "", "") for p in json.loads(files_json) if p not in stored]
        if not others:
            continue
        before = {d["tool"] for d in results.get(repo, [])}
        after = {d["tool"] for d in detect_tools(scripts.get(repo, []) + others)}
        added.update(after - before)
    print(f"\n   with the repositories' other paths added (no text): +{sum(added.values())} detections"
          + (": " + ", ".join(f"{names[t]} {n}" for t, n in added.most_common()) if added else ""))
    print()
    return results


def names_of(tool: dict) -> list[str]:
    names = []
    for key in ("python", "r", "julia", "matlab", "shell", "packages"):
        for n in tool[key]:
            names.append(n.rstrip("*").lstrip("$"))
    return [n for n in names if n]


def evidence_lines(text: str, words: list[str], limit: int = 2) -> list[str]:
    pattern = re.compile(r"(?<![\w.])(?:" + "|".join(re.escape(w) for w in words) + r")")
    lines = [line.strip() for line in (text or "").splitlines() if pattern.search(line)]
    code = [line for line in lines if not line.startswith(("#", "%", "//"))]
    return [line[:160] for line in (code or lines)[:limit]]


def sample(results: dict[str, list[dict]], scripts: dict[str, list[tuple[str, str, str]]],
           n: int, seed: int, routes: tuple[str, ...], title: str) -> None:
    tools = {t["id"]: t for t in vocabulary()}
    pairs = sorted((repo, d["tool"]) for repo, found in results.items() for d in found
                   if d["via"] in routes)
    chosen = random.Random(seed).sample(pairs, min(n, len(pairs)))
    print(f"{title}: {len(chosen)} random detections of {len(pairs)} (seed {seed}), "
          f"to judge by hand\n")
    for k, (repo, tid) in enumerate(chosen, 1):
        d = next(x for x in results[repo] if x["tool"] == tid)
        path = d["examples"][0]
        text = next((t for p, _, t in scripts[repo] if p == path), "") or ""
        print(f"   {k:2d}. {repo}  →  {tools[tid]['name']}  ({d['via']}, {d['evidence']} files, "
              f"{d['detected_by']})")
        print(f"       {path}")
        for line in evidence_lines(text, names_of(tools[tid])) or ["(no line names it: the file type)"]:
            print(f"         | {line}")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("db", nargs="?", default=DEFAULT_DB)
    parser.add_argument("--top", type=int, default=40)
    parser.add_argument("--sample", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260926)
    args = parser.parse_args()
    con = open_db(args.db)
    scripts = load_scripts(con)
    stored_paths = {repo: [p for p, _, _ in files] for repo, files in scripts.items()}
    measure_features(con, stored_paths)
    results = measure_tools(con, scripts, args.top)
    sample(results, scripts, args.sample, args.seed, ("import", "call", "file"), "3a. all routes")
    # imports are the easy case: the calls and the declarations are where mistakes hide
    sample(results, scripts, args.sample, args.seed, ("call", "file"), "3b. calls and declarations only")


if __name__ == "__main__":
    main()
