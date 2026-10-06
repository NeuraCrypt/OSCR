"""The data behind the static /status page (night phase 15): 90 days of availability and the
incidents, from the Mac's OWN outbound checks of the site every five minutes. Nothing on the Mac
listens; the Mac reaches out, so a Worker outage never hides itself.

Zero cost, no new dependency: the standard library only (``urllib``). The page that reads this is
static, so it changes only when the site is next deployed; it says when it was built.

**The outbound checks are the owner's step.** This module builds the mechanism and is tested against
a fake getter; it never contacts the outside on its own. The owner turns on the real checks with a
launchd job (or the watchdog) that runs ``oscr status check`` every five minutes, then
``oscr status build`` before each deploy. Until then, ``oscr status init`` writes a placeholder that
says the checks are not enabled yet.

Everything here is pure except ``default_getter`` (the real HTTP request) and the file writes.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

CHECK_INTERVAL_S = 300  # every five minutes
CHECKS_PER_DAY = 24 * 60 * 60 // CHECK_INTERVAL_S  # 288
WINDOW_DAYS = 90
# Below this fraction of the day's checks succeeding, the day reads as "down"; at full, "up"; in
# between, "partial".
DOWN_BELOW = 0.5

# A getter answers (status_code, elapsed_ms) or raises. The real one lives below; the tests pass a
# fake, so no test ever reaches the network.
Getter = Callable[[str], "tuple[int, float]"]


@dataclass(frozen=True)
class Check:
    t: int  # Unix seconds, UTC
    ok: bool
    status: int  # 0 when the request raised
    ms: float


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(int(ts), tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _day(ts: float) -> str:
    return datetime.fromtimestamp(int(ts), tz=UTC).strftime("%Y-%m-%d")


def default_getter(url: str, timeout: float = 10.0) -> tuple[int, float]:
    """One real GET of the site (owner-run only). Not used by any test."""
    import urllib.request

    start = time.monotonic()
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": "oscr-status/1"})
    with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (our own site, https)
        status = int(getattr(res, "status", 0) or 0)
        res.read(1)  # touch the body, then let it close
    return status, (time.monotonic() - start) * 1000.0


def run_check(url: str, now: float | None = None, get: Getter = default_getter) -> Check:
    """Check the site once. A status in [200, 400) is up; a raised error is down (status 0)."""
    when = int(now if now is not None else time.time())
    try:
        status, ms = get(url)
        return Check(t=when, ok=200 <= status < 400, status=status, ms=round(ms, 1))
    except Exception:  # noqa: BLE001 — any failure to reach the site is an outage, recorded as one
        return Check(t=when, ok=False, status=0, ms=0.0)


def append_check(store: Path, check: Check) -> None:
    """Append one check to the raw store (one JSON object per line)."""
    store.parent.mkdir(parents=True, exist_ok=True)
    with store.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": check.t, "ok": check.ok, "status": check.status, "ms": check.ms}) + "\n")


def load_checks(store: Path) -> list[Check]:
    """Read the raw store, skipping any unreadable line."""
    if not store.exists():
        return []
    out: list[Check] = []
    for line in store.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            out.append(Check(t=int(d["t"]), ok=bool(d["ok"]), status=int(d.get("status", 0)), ms=float(d.get("ms", 0.0))))
        except (ValueError, KeyError, TypeError):
            continue
    return out


def _state(ok: int, checks: int) -> str:
    if checks == 0:
        return "none"
    if ok == checks:
        return "up"
    if ok / checks < DOWN_BELOW:
        return "down"
    return "partial"


def aggregate(checks: Iterable[Check], now: float, window_days: int = WINDOW_DAYS) -> dict:
    """The per-day availability over the window ending today (UTC), and the incidents. Pure."""
    by_day: dict[str, list[Check]] = defaultdict(list)
    for c in checks:
        by_day[_day(c.t)].append(c)

    today = datetime.fromtimestamp(int(now), tz=UTC).date()
    days = []
    total = ok_total = 0
    for i in range(window_days - 1, -1, -1):
        day = today.fromordinal(today.toordinal() - i).strftime("%Y-%m-%d")
        cs = by_day.get(day, [])
        ok = sum(1 for c in cs if c.ok)
        days.append({"date": day, "checks": len(cs), "ok": ok, "state": _state(ok, len(cs)),
                     "uptime": round(ok / len(cs), 4) if cs else None})
        total += len(cs)
        ok_total += ok

    incidents = _incidents(sorted(checks, key=lambda c: c.t), today, window_days)
    overall = round(ok_total / total, 4) if total else None
    return {"days": days, "incidents": incidents, "total_checks": total, "ok_checks": ok_total, "overall_uptime": overall}


def _incidents(checks: list[Check], today, window_days: int) -> list[dict]:
    """A maximal run of consecutive failed checks is one incident (within the window)."""
    first_day = today.fromordinal(today.toordinal() - (window_days - 1))
    incidents: list[dict] = []
    run: list[Check] = []

    def flush() -> None:
        if not run:
            return
        start, end = run[0], run[-1]
        if datetime.fromtimestamp(start.t, tz=UTC).date() < first_day:
            return
        incidents.append({
            "start": _iso(start.t),
            "end": _iso(end.t),
            "checks": len(run),
            "title": "The site did not answer" if all(c.status == 0 for c in run) else "The site answered with errors",
        })

    for c in checks:
        if c.ok:
            flush()
            run = []
        else:
            run.append(c)
    flush()
    return incidents


def build(checks: Iterable[Check], now: float | None = None, window_days: int = WINDOW_DAYS) -> dict:
    """The status JSON the site reads, from the raw checks."""
    when = now if now is not None else time.time()
    agg = aggregate(list(checks), when, window_days)
    return {
        "enabled": True,
        "generated_at": _iso(when),
        "window_days": window_days,
        "checks_per_day": CHECKS_PER_DAY,
        "interval_seconds": CHECK_INTERVAL_S,
        **agg,
    }


def empty(now: float | None = None, window_days: int = WINDOW_DAYS) -> dict:
    """The placeholder before the owner enables the real checks: the page says so."""
    when = now if now is not None else time.time()
    return {
        "enabled": False,
        "generated_at": _iso(when),
        "window_days": window_days,
        "checks_per_day": CHECKS_PER_DAY,
        "interval_seconds": CHECK_INTERVAL_S,
        "days": [],
        "incidents": [],
        "total_checks": 0,
        "ok_checks": 0,
        "overall_uptime": None,
    }


def write_status(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def command(action: str, export: Path, store: Path, url: str, window_days: int = WINDOW_DAYS,
            get: Getter = default_getter, now: float | None = None) -> str:
    """The `oscr status` command. `check` is the only one that reaches the outside, and only the
    owner's launchd job runs it; `init` and `build` touch files only."""
    out = export / "site-status.json"
    if action == "init":
        write_status(out, empty(now, window_days))
        return f"wrote a placeholder (checks not enabled yet) to {out}"
    if action == "check":
        c = run_check(url, now=now, get=get)
        append_check(store, c)
        return f"{_iso(c.t)} {url} {'up' if c.ok else 'down'} (status {c.status}, {c.ms:g} ms) → {store}"
    if action == "build":
        data = build(load_checks(store), now, window_days)
        write_status(out, data)
        up = "no checks yet" if data["overall_uptime"] is None else f"{data['overall_uptime'] * 100:.2f}% over {window_days} days"
        return f"wrote {out}: {up}, {len(data['incidents'])} incident(s)"
    raise ValueError(f"unknown action: {action}")
