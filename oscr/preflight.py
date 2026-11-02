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
#: The export, the build and the Hugging Face copy need this much (bytes).
MIN_FREE = 40 * 10**9
HOSTS = ("api.cloudflare.com", "huggingface.co")


def disk(website: Path = WEBSITE) -> str:
    """website/public is a link to the external disk Expansion: the build has nothing to serve without it."""
    public = website / "public"
    if (public / "_headers").exists():
        return ""
    return f"the external disk is not mounted: {public} points to {os.path.realpath(public)}, which is missing"


def space(path: Path = Path("data"), minimum: int = MIN_FREE) -> str:
    free = shutil.disk_usage(path if path.exists() else ".").free
    return "" if free >= minimum else f"{free / 1e9:.0f} GB free on the disk, {minimum / 1e9:.0f} GB are needed"


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


def run(cfg: dict[str, str], dataset: str, cloudflare: str) -> list[str]:
    """The problems, in words; none: the night can start."""
    cloudflare_used = bool(cloudflare) or "remote" in (cfg.get("OSCR_D1_PUSH"), cfg.get("OSCR_COMMUNITY_PUSH"))
    huggingface_used = bool(dataset or cfg.get("OSCR_SCRIPTS_DATASET") or cfg.get("OSCR_CONTACTS_DATASET"))
    if not cloudflare_used and not huggingface_used:
        return []
    checks = [space, network]
    if cloudflare:
        checks.insert(0, disk)
    if cloudflare_used:
        checks.append(wrangler)
    if huggingface_used:
        checks.append(huggingface)
    return [p for p in (c() for c in checks) if p]
