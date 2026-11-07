"""What would make the night fail, said before anything starts: the external disk, the free space, the
network, the logins. Each problem is one sentence, recorded in data/state/cycles.db; the watchdog
tries again soon after (`watchdog.BLOCKED_RETRY_S`), since a disk gets mounted and a network comes back.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
from pathlib import Path

from . import retry

WEBSITE = Path(__file__).resolve().parents[1] / "website"
#: Until 2026-11-06 a fixed 40 GB was asked, a guess: on 2026-11-05 a night passed it and still filled
#: the disk (the old public database was a full copy of oscr.db, then a VACUUM). It is now computed by
#: `needed`, from the files the night writes; MIN_FREE stays the floor when nothing is known yet.
MIN_FREE = 10 * 10**9
#: What is kept free on top of what the night writes (the harvester, the logs, macOS).
MARGIN = 10 * 10**9
HOSTS = ("api.cloudflare.com", "huggingface.co")


def disk(website: Path = WEBSITE) -> str:
    """website/public is a link to the external disk Expansion: the build has nothing to serve without it."""
    public = website / "public"
    if (public / "_headers").exists():
        return ""
    return f"the external disk is not mounted: {public} points to {os.path.realpath(public)}, which is missing"


def _size(path: Path) -> int:
    """Bytes under `path` (a file, or a folder walked without following links), 0 when missing."""
    if path.is_symlink() or not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def needed(out: Path, database: Path = Path("data/oscr.db"), website: Path = WEBSITE,
           export: bool = True) -> tuple[int, str]:
    """What the night writes on this disk, and how it was counted, in words. The export builds the
    public database next to the previous one (catalog.public_db, about the previous one's size: 1.2
    times it), or, the first time, half of oscr.db; the build rewrites website/dist (0.2 times it for
    what grows); MARGIN on top. A resumption after the export (export=False) builds no database."""
    public = _size(out / "oscr_public.db")
    if export:
        db_part = int(public * 1.2) if public else _size(database) // 2
        said_db = (f"public database {public / 1e9:.1f} GB x 1.2" if public
                   else f"no public database yet: half of oscr.db ({_size(database) / 1e9:.1f} GB)")
    else:
        db_part, said_db = 0, "export already done"
    dist = _size(website / "dist")
    need = max(MIN_FREE, db_part + int(dist * 0.2) + MARGIN)
    return need, f"{said_db}, site {dist / 1e9:.1f} GB x 0.2, margin {MARGIN / 1e9:.0f} GB"


def space(path: Path = Path("data"), minimum: int = MIN_FREE, why: str = "") -> str:
    free = shutil.disk_usage(path if path.exists() else ".").free
    if free >= minimum:
        return ""
    return f"{free / 1e9:.0f} GB free on the disk, {minimum / 1e9:.0f} GB are needed" + (f" ({why})" if why else "")


#: Free space kept on the external disk Expansion, where what grows is written (the scripts' lots, the
#: script copies, scripts.jsonl): about 8 GB are written there a night (2026-11-07).
EXPANSION_FREE = 20 * 10**9


def _device(path: Path) -> int:
    return os.stat(path).st_dev


def external_space(website: Path = WEBSITE, data: Path = Path("data"), minimum: int = EXPANSION_FREE,
                   device=_device) -> str:
    """The free space on the disk website/public points to, when it is not the data's own disk."""
    public = website / "public"
    if not public.is_symlink() or not public.exists():
        return ""
    target = Path(os.path.realpath(public))
    here = data if data.exists() else Path(".")
    if device(target) == device(here):
        return ""
    free = shutil.disk_usage(target).free
    if free >= minimum:
        return ""
    return f"{free / 1e9:.0f} GB free on the external disk ({target}), {minimum / 1e9:.0f} GB are needed"


def network(hosts: tuple[str, ...] = HOSTS) -> str:
    down = []
    for host in hosts:
        try:
            socket.create_connection((host, 443), timeout=15).close()
        except OSError:
            down.append(host)
    return f"no network to {', '.join(down)}" if down else ""


def wrangler(website: Path = WEBSITE) -> str:
    def whoami() -> str:
        r = subprocess.run(["npx", "wrangler", "whoami"], cwd=website, capture_output=True, text=True, timeout=120)
        said = f"{r.stdout}\n{r.stderr}"
        if r.returncode != 0 or "not authenticated" in said.lower():
            raise RuntimeError(f"Cloudflare login refused (401): {said.strip()[-200:]}")
        return ""
    try:
        return retry.call(whoami, "wrangler whoami", delays=(30,))
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
        return f"wrangler whoami failed: {e}; run `npx wrangler login` in website/"


def huggingface() -> str:
    from huggingface_hub import HfApi, get_token
    token = os.environ.get("HF_TOKEN", "").strip() or get_token()
    if not token:
        return "no Hugging Face token: run `hf auth login`"
    try:
        retry.call(lambda: HfApi(token=token).whoami(), "Hugging Face whoami", delays=(30,))
    except Exception as e:  # noqa: BLE001, said in words
        return f"Hugging Face token refused: {str(e)[-200:]}"
    return ""


def run(cfg: dict[str, str], dataset: str, cloudflare: str, need: tuple[int, str] | None = None) -> list[str]:
    """The problems, in words; none: the night can start. `need`: the bytes the night will write and
    how they were counted (`needed`); MIN_FREE when not given."""
    cloudflare_used = bool(cloudflare) or "remote" in (cfg.get("OSCR_D1_PUSH"), cfg.get("OSCR_COMMUNITY_PUSH"))
    huggingface_used = bool(dataset or cfg.get("OSCR_SCRIPTS_DATASET") or cfg.get("OSCR_CONTACTS_DATASET"))
    if not cloudflare_used and not huggingface_used:
        return []
    minimum, why = need if need else (MIN_FREE, "")
    checks = [lambda: space(minimum=minimum, why=why), network]
    if cloudflare:
        checks.insert(0, disk)
        checks.insert(1, external_space)
    if cloudflare_used:
        checks.append(wrangler)
    if huggingface_used:
        checks.append(huggingface)
    return [p for p in (c() for c in checks) if p]
