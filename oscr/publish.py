"""Publish the catalogue: the open dataset on Hugging Face, the website on Cloudflare Pages.

**What leaves for Hugging Face.** The tables its dataset viewer displays and queries in
SQL, `articles.csv`, `repositories.csv`, `scripts.jsonl` (one script per line, with its
text), `alignments.jsonl` (one paper ↔ code match per line), the `oscr_public.db`
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

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from . import retry

#: The public website (Astro), next to the package.
WEBSITE = Path(__file__).resolve().parents[1] / "website"

TABLES = ("articles.csv", "repositories.csv", "scripts.jsonl", "alignments.jsonl", "oscr_public.db")

CARD = """---
license: cc0-1.0
pretty_name: Open Scientific Code Registry (OSCR), catalogue
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

# Open Scientific Code Registry (OSCR), catalogue

The code published by the authors of neuroscience papers, found in the papers' text and
metadata, then verified at the source.

- `articles`: one paper per line, with its status (code verified, on request, none…).
- `repositories`: each authors' code repository, its license, commit and scripts.
- `scripts`: the text of each script, **only** when the repository's license allows
  republishing it. Each line carries its license and a link to the file at the source,
  at the verified commit: **the source always prevails**.
- `alignments`: which paragraph of a paper matches which lines of its code, paragraph
  numbers and short technical terms only, never the paper's text.
- `oscr_public.db`: the complete SQLite database, without the papers' sentences nor the
  text of unlicensed repositories, for a website or a service.

The catalogue metadata is CC0-1.0; every script keeps the license of its repository.
Updated on {date} by the OSCR harvester, https://github.com/NeuraCrypt/OSCR
"""


def prepare(site: Path, mirror: Path | None) -> Path:
    """The folder exactly as it will leave: a LINK to each table, not a copy (until 2026-11-07 the
    21.7 GB of tables were copied into a temporary folder of the internal disk every night). The
    upload reads through a link to a file (`upload_folder` keeps what `Path.is_file()` says)."""
    d = Path(tempfile.mkdtemp(prefix="hf_"))
    for name in TABLES:
        if (site / name).exists():
            (d / name).symlink_to((site / name).resolve())
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
        return f"(dry run, nothing sent) {summary}, prepared folder: {folder}"
    try:
        from huggingface_hub import HfApi, get_token
    except ImportError as e:
        raise SystemExit("huggingface_hub is missing: uv sync") from e
    token = os.environ.get("HF_TOKEN", "").strip() or get_token()
    if not token:
        raise SystemExit("No Hugging Face token: `hf auth login`, or HF_TOKEN (a GitHub secret on Actions).")
    api = HfApi(token=token)
    retry.call(lambda: api.create_repo(dataset, repo_type="dataset", private=private, exist_ok=True), "Hugging Face")
    try:
        def upload() -> None:
            api.upload_folder(folder_path=str(folder), repo_id=dataset, repo_type="dataset",
                              commit_message=f"Nightly publication of {time.strftime('%Y-%m-%d', time.gmtime())}",
                              delete_patterns=["scripts/**"] if mirror is not None else None)
        try:
            retry.call(upload, "Hugging Face upload")
        except Exception as e:  # noqa: BLE001, the storage limit is tried again, once, after freeing the old nights
            if "storage limit" not in str(e).lower():
                raise
            keep_only_head(api, dataset)
            retry.call(upload, "Hugging Face upload")
        freed = retry.call(lambda: keep_only_head(api, dataset), "Hugging Face history")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    return summary + (f", {freed / 1e9:.1f} GB of earlier nights freed" if freed else "")


def keep_only_head(api, dataset: str) -> int:
    """Keep only the latest night on Hugging Face. Every night replaces the whole catalogue
    (`oscr_public.db`, `scripts.jsonl`: gigabytes) and each night stayed in the dataset's history:
    20 nights filled the account's free private storage (2026-10-26, "Private storage limit
    reached", 91.6 GB stored for 12.4 GB in use). The catalogue is rebuilt from the Mac's database
    every night, so its history is worth nothing: squashed to the current commit, then every stored
    file the current commit does not use deleted for good (a squashed history no longer points to
    them, but the storage keeps them until they are deleted; the method of
    `contacts.forget_history`). Deletes nothing when a current file is not among the stored ones.
    Returns the bytes freed."""
    api.super_squash_history(repo_id=dataset, repo_type="dataset",
                             commit_message=f"Catalogue of {time.strftime('%Y-%m-%d', time.gmtime())}")
    current = {s.lfs.sha256 for s in api.dataset_info(dataset, files_metadata=True).siblings if s.lfs}
    stored = list(api.list_lfs_files(dataset, repo_type="dataset"))
    if not current <= {f.file_oid for f in stored}:
        return 0  # not recognized: nothing deleted, the squash alone loses nothing of the current night
    stale = [f for f in stored if f.file_oid not in current]
    if stale:
        api.permanently_delete_lfs_files(dataset, stale, repo_type="dataset", rewrite_history=True)
    return sum(f.size for f in stale)


#: Written into node_modules after `npm ci`: the digest of the package-lock.json installed.
INSTALLED_LOCK = ".oscr-lock-sha256"


def _lock_digest(website: Path) -> str:
    lock = website / "package-lock.json"
    return hashlib.sha256(lock.read_bytes()).hexdigest() if lock.exists() else ""


def _installed_lock(website: Path) -> str | None:
    """The digest of the package-lock.json that node_modules was installed from, or None: then
    `npm ci` runs before the build, so that a merge that changes the dependencies (Svelte came
    with Phase 3) is installed rather than found missing by the build."""
    try:
        return (website / "node_modules" / INSTALLED_LOCK).read_text().strip()
    except OSError:
        return None


#: Written beside dist/ after a build: what it was built from. A resumption that finds the same does
#: not build again (46 minutes to 2 hours).
BUILT = ".oscr-built"


def _built_key(catalog: Path, website: Path) -> str:
    """The export and the code a build reads, or "" when they cannot be told."""
    try:
        export = (catalog / "catalog.json").stat()
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=website, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return f"{export.st_mtime_ns} {export.st_size} {head.stdout.strip()}" if head.returncode == 0 else ""


def _built(website: Path) -> str:
    try:
        return (website / BUILT).read_text()
    except OSError:
        return ""


#: How many times `wrangler deploy` runs at most, every cause together (no other try around it).
DEPLOY_ATTEMPTS = 6
#: Of those, how many may follow an expired upload token: wrangler's upload session lasts about an
#: hour, after which every bucket is answered "401 Unauthorized" and the deploy fails. A new run
#: opens a new session and sends only the assets Cloudflare does not have yet.
EXPIRED_RETRIES = 4
_EXPIRED = re.compile(r"\b401\b|Unauthorized|expired", re.I)
_ASSETS_LEFT = re.compile(r"Found (\d+) new or modified static assets to upload")


def _assets_left(text: str) -> int | None:
    """How many assets the run had to upload (wrangler's "Found N new or modified ..."), or None."""
    found = _ASSETS_LEFT.findall(text)
    return int(found[-1]) if found else None


#: `npm run build` took from 46 minutes to 2 hours on the whole stock, and went over 90 minutes on
#: 2026-10-30 (the night failed): allow it 3 hours.
BUILD_TIMEOUT_S = 3 * 3600


def _run_once(step: list[str], website: Path, env: dict, *, until: float | None = None) -> subprocess.CompletedProcess:
    # The site is large (the scripts' copies, the public API's static data): the build and the
    # upload of the day's changes can take well over half an hour, so allow 90 minutes a step,
    # and BUILD_TIMEOUT_S for the build; never past `until` (the night's end).
    timeout = BUILD_TIMEOUT_S if step[:3] == ["npm", "run", "build"] else 5400
    if until is not None:
        timeout = min(timeout, until - time.time())
        if timeout < 60:
            raise RuntimeError(f"{' '.join(step[:4])}: no time left in the night")
    r = subprocess.run(step, cwd=website, env=env, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(step[:4])} failed: " + (r.stderr or r.stdout).strip()[-600:])
    return r


_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _text(out: str | bytes | None) -> str:
    """A subprocess output as text (a timeout gives the partial output as bytes)."""
    if out is None:
        return ""
    return out.decode("utf-8", "replace") if isinstance(out, bytes) else out


def _tail(out: str | bytes | None, lines: int = 30) -> str:
    """The last `lines` lines of an output, without colours, indented: why a try of wrangler failed,
    in the nightly's log (until 2026-11-06 only the count and the duration were written)."""
    kept = [ln for ln in _ANSI.sub("", _text(out)).strip().splitlines() if ln.strip()][-lines:]
    return "\n".join(f"    {ln}" for ln in kept) or "    (no output)"


def _deploy(step: list[str], website: Path, env: dict, *, until: float | None = None) -> subprocess.CompletedProcess:
    """`wrangler deploy`, run again (never rebuilt) when Cloudflare cuts the upload short or a passing
    error stops it: Cloudflare keeps what was already sent, so each run resumes. DEPLOY_ATTEMPTS runs
    in all, the only tries (until 2026-11-07 `retry.call` wrapped this loop: up to 24 runs, 36 hours):
    "Upload took too long", a run stopped at its limit, a passing error (retry.passing), and an expired
    upload token as long as each run leaves fewer assets to send than the one before. `until` (a
    `time.time()`): no run starts, and none goes on, past it."""
    expired, left = 0, None
    for attempt in range(1, DEPLOY_ATTEMPTS + 1):
        started = time.monotonic()
        limit = 5400.0 if until is None else min(5400.0, until - time.time())
        if limit < 60:
            raise RuntimeError(f"{' '.join(step[:4])}: no time left in the night for try {attempt}")
        try:
            r = subprocess.run(step, cwd=website, env=env, capture_output=True, text=True, timeout=limit)
        except subprocess.TimeoutExpired as e:
            partial = f"{_text(e.stdout)}\n{_text(e.stderr)}"
            count = _assets_left(partial)
            print(f"wrangler deploy, try {attempt}: "
                  f"{'no count given' if count is None else f'Found {count} new or modified static assets'}, "
                  f"stopped after {(time.monotonic() - started) / 60:.1f} min (its {limit / 60:.0f}-minute limit); its last lines:\n"
                  f"{_tail(partial)}", flush=True)
            if attempt == DEPLOY_ATTEMPTS or (left is not None and count is not None and count >= left):
                raise
            left = count if count is not None else left
            continue        # Cloudflare kept what was sent: the next run resumes from there
        seen = f"{r.stdout}\n{r.stderr}"
        count = _assets_left(seen)
        print(f"wrangler deploy, try {attempt}: "
              f"{'no count given' if count is None else f'Found {count} new or modified static assets'}, "
              f"{(time.monotonic() - started) / 60:.1f} min"
              + ("" if r.returncode == 0 else f", failed (exit {r.returncode}); its last lines:\n{_tail(r.stderr or r.stdout)}"),
              flush=True)
        if r.returncode == 0:
            return r
        err = (r.stderr or r.stdout).strip()
        error = RuntimeError(f"{' '.join(step[:4])} failed: " + err[-600:])
        if attempt == DEPLOY_ATTEMPTS:
            raise error
        if "Upload took too long" in err:
            left = count if count is not None else left
            continue        # Cloudflare kept the uploaded assets; the next attempt resumes from there.
        if _EXPIRED.search(err):
            if expired < EXPIRED_RETRIES and (left is None or count is None or count < left):
                expired, left = expired + 1, count
                continue
            raise error
        if retry.passing(error):
            retry.sleep(retry.DELAYS[0])
            continue
        raise error
    raise RuntimeError(f"{' '.join(step[:4])}: {DEPLOY_ATTEMPTS} tries")


def deploy_cloudflare(catalog: Path, project: str, website: Path = WEBSITE, lots: Any = None,
                      until: float | None = None) -> str:
    """Rebuild the website from the public catalogue (`catalog`, generated in public
    mode) and put it online as the static assets of a Cloudflare Worker (`project` is the
    Worker's name): no git repository and no build at Cloudflare, and only the files that
    changed are uploaded. `npx wrangler login` must have been done once; wrangler keeps and
    renews its login itself.

    `lots` (a `scriptlots.Store`): the scripts' text lots, kept outside the site's sources; the build
    reads them there (SCRIPT_LOTS_DIR) and does not copy them, and `dist/scripts/` gets one link per
    lot before `wrangler deploy`, which sends only the lots Cloudflare does not have yet."""
    env = {**os.environ, "CATALOG_DIR": str(catalog.resolve())}
    if lots is not None:
        env["SCRIPT_LOTS_DIR"] = str(lots.lots.resolve())
    # Night phase 16: Turnstile's public site key, for the forms' human check (tools/setup_cloudflare.sh).
    from .cli import settings
    site_key = settings().get("OSCR_TURNSTILE_SITE_KEY", "")
    if site_key and "TURNSTILE_SITE_KEY" not in env:
        env["TURNSTILE_SITE_KEY"] = site_key
    lock = _lock_digest(website)
    steps = [] if _installed_lock(website) == lock else [["npm", "ci", "--no-audit", "--no-fund"]]
    built = _built_key(catalog, website)
    if not (built and _built(website) == built and (website / "dist").is_dir()):
        steps += [["npm", "run", "build"]]
    # No email address goes online (CLAUDE.md): the built site is checked before every deployment,
    # and a file that holds one stops it (website/scripts/check-emails.mjs).
    steps += [["npm", "run", "check:emails"]]
    steps += [["npx", "wrangler", "deploy", "--name", project]]
    output = ""
    for step in steps:
        if step[:2] == ["npm", "run"] and step[2] == "check:emails" and lots is not None:
            from . import scriptlots
            scriptlots.link_into(lots, website / "dist" / "scripts")
        if step[:2] == ["npx", "wrangler"]:
            r = _deploy(step, website, env, until=until)
        else:
            r = _run_once(step, website, env, until=until)
        output = r.stdout
        if step[:2] == ["npm", "ci"]:
            (website / "node_modules" / INSTALLED_LOCK).write_text(lock)
        if step[:3] == ["npm", "run", "build"] and built:
            (website / BUILT).write_text(built)
    url = re.search(r"https://[\w.-]+\.workers\.dev\S*", output)
    return f"website online: {url.group(0) if url else project}"
