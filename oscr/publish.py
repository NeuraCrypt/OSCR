"""Publish the catalogue: the open dataset on Hugging Face, the website on Cloudflare Pages.

**What leaves for Hugging Face.** The tables its dataset viewer displays and queries in
SQL — `articles.csv`, `repositories.csv`, `scripts.jsonl` (one script per line, with its
text), `alignments.jsonl` (one paper ↔ code match per line) —, the `oscr_public.db`
database and, when given, the mirror of the scripts as files. A `README.md` card declares
the tables to the viewer.

**Plain, not compressed.** Hugging Face (xet) splits files into chunks and uploads only
those it does not have yet. On 2026-09-26, 53 MB published sent only ~8 MB, in 13
minutes, on a ~25 KB/s uplink. A compressed file would change entirely at each addition,
and leave entirely every night.

**What does not leave.** The text of a script whose license does not allow
republishing: `scripts.jsonl` comes from the catalogue in public mode, which already
removed it. Neither the full text of the papers nor the sentences that made a link's
verdict.

**The token.** `HF_TOKEN` when set (on GitHub Actions, a repository secret), else the one
`huggingface_hub` keeps at its standard location (`~/.cache/huggingface/token`, readable
by its owner only). Never in the repository nor in a settings file. `--dry-run` prepares
the folder and says what would leave, without sending anything.

**Private by default.** A dataset created by this module is PRIVATE: making it public is
a decision, taken on the dataset's page the day a website reads it.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

#: The public website (Astro), next to the package.
WEBSITE = Path(__file__).resolve().parents[1] / "website"

TABLES = ("articles.csv", "repositories.csv", "scripts.jsonl", "alignments.jsonl", "oscr_public.db")

CARD = """---
license: cc0-1.0
pretty_name: Open Scientific Code Registry (OSCR) — catalogue
tags:
- neuroscience
- code
- reproducibility
- research-software
configs:
- config_name: scripts
  data_files: scripts.jsonl
- config_name: articles
  data_files: articles.csv
- config_name: repositories
  data_files: repositories.csv
- config_name: alignments
  data_files: alignments.jsonl
---

# Open Scientific Code Registry (OSCR) — catalogue

The code published by the authors of neuroscience papers, found in the papers' text and
metadata, then verified at the source.

- `articles`: one paper per line, with its status (code verified, on request, none…).
- `repositories`: each authors' code repository, its license, commit and scripts.
- `scripts`: the text of each script, **only** when the repository's license allows
  republishing it. Each line carries its license and a link to the file at the source,
  at the verified commit: **the source always prevails**.
- `alignments`: which paragraph of a paper matches which lines of its code — paragraph
  numbers and short technical terms only, never the paper's text.
- `oscr_public.db`: the complete SQLite database, without the papers' sentences nor the
  text of unlicensed repositories — for a website or a service.

The catalogue metadata is CC0-1.0; every script keeps the license of its repository.
Updated on {date} by the OSCR harvester — https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR-
"""


def prepare(site: Path, mirror: Path | None) -> Path:
    """The folder exactly as it will leave."""
    d = Path(tempfile.mkdtemp(prefix="hf_"))
    for name in TABLES:
        if (site / name).exists():
            shutil.copy2(site / name, d / name)
    if mirror is not None and mirror.exists():
        shutil.copytree(mirror, d / "scripts")
    (d / "README.md").write_text(CARD.replace("{date}", time.strftime("%Y-%m-%d", time.gmtime())))
    return d


def publish_hf(site: Path, dataset: str, *, mirror: Path | None = None, dry_run: bool = False,
               private: bool = True) -> str:
    # A catalogue generated WITHOUT --public carries the text of unlicensed scripts: it
    # does not leave.
    state = site / "catalog.json"
    if not state.exists() or not json.loads(state.read_text()).get("public"):
        raise SystemExit(f"{site} was not generated in public mode: run `oscr --public --out {site} export` first.")
    folder = prepare(site, mirror)
    files = sorted(str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file())
    size = sum((folder / f).stat().st_size for f in files)
    summary = f"{len(files)} files, {size / 1e6:.1f} MB → huggingface.co/datasets/{dataset}"
    if dry_run:
        return f"(dry run, nothing sent) {summary} — prepared folder: {folder}"
    try:
        from huggingface_hub import HfApi, get_token
    except ImportError as e:
        raise SystemExit("huggingface_hub is missing: uv sync") from e
    token = os.environ.get("HF_TOKEN", "").strip() or get_token()
    if not token:
        raise SystemExit("No Hugging Face token: `hf auth login`, or HF_TOKEN (a GitHub secret on Actions).")
    api = HfApi(token=token)
    api.create_repo(dataset, repo_type="dataset", private=private, exist_ok=True)
    api.upload_folder(folder_path=str(folder), repo_id=dataset, repo_type="dataset",
                      commit_message=f"Nightly publication of {time.strftime('%Y-%m-%d', time.gmtime())}",
                      delete_patterns=["scripts/**"] if mirror is not None else None)
    shutil.rmtree(folder, ignore_errors=True)
    return summary


def deploy_cloudflare(catalog: Path, project: str, website: Path = WEBSITE) -> str:
    """Rebuild the website from the public catalogue (`catalog`, generated in public
    mode) and put it online as the static assets of a Cloudflare Worker (`project` is the
    Worker's name): no git repository and no build at Cloudflare, and only the files that
    changed are uploaded. `npx wrangler login` must have been done once; wrangler keeps and
    renews its login itself."""
    env = {**os.environ, "CATALOG_DIR": str(catalog.resolve())}
    steps = [] if (website / "node_modules").exists() else [["npm", "install", "--no-audit", "--no-fund"]]
    steps += [["npm", "run", "build"],
              ["npx", "wrangler", "deploy", "--name", project]]
    output = ""
    for step in steps:
        r = subprocess.run(step, cwd=website, env=env, capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            raise RuntimeError(f"{' '.join(step[:4])} failed: " + (r.stderr or r.stdout).strip()[-600:])
        output = r.stdout
    url = re.search(r"https://[\w.-]+\.workers\.dev\S*", output)
    return f"website online: {url.group(0) if url else project}"
