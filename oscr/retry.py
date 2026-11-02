"""Sending again what a passing network or Cloudflare error stopped.

On 2026-10-31 one "Authentication error [code: 10000]" from D1's import left a whole night's search
unsent, though the same login worked a moment later. Every network send of the nightly goes through
`call`: a passing error (a refused login, a rate limit, a server error, a timeout, a cut connection)
is tried again after 30 seconds, 2 minutes and 10 minutes. A definitive one (an asset too large, a
spent quota, the storage limit) is raised at once: waiting changes nothing.
"""
from __future__ import annotations

import re
import subprocess
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

#: The waits between tries, in seconds: four tries at most.
DELAYS = (30, 120, 600)

_DEFINITIVE = re.compile(r"too large|quota|storage limit|payload|SQLITE_|no such (table|column)", re.I)
_PASSING = re.compile(r"\b(401|403|408|429|5\d\d)\b|authentication error|code: 10000|unauthorized|forbidden"
                      r"|too many requests|rate.?limit|timed? ?out|connection|network|socket|fetch failed"
                      r"|ECONN\w*|ENOTFOUND|EAI_AGAIN|temporar|unavailable|bad gateway|upload took too long", re.I)

#: Read at each call, so that the tests wait for nothing (tests/conftest.py).
sleep: Callable[[float], None] = time.sleep


def passing(error: BaseException) -> bool:
    """Whether trying again may help: never for a definitive error, whatever else it says."""
    if isinstance(error, (subprocess.TimeoutExpired, TimeoutError, ConnectionError)):
        return True
    text = str(error)
    return not _DEFINITIVE.search(text) and bool(_PASSING.search(text))


def call(send: Callable[[], T], what: str, *, delays: tuple[float, ...] = DELAYS,
         report: Callable[[str], None] = lambda m: print(m, flush=True)) -> T:
    """`send()`, tried again after each of `delays` while it fails with a passing error."""
    for wait in delays:
        try:
            return send()
        except Exception as e:  # noqa: BLE001, a definitive error is raised again just below
            if not passing(e):
                raise
            report(f"{what}: {str(e).strip()[-200:]}; trying again in {wait:g} s")
            sleep(wait)
    return send()
