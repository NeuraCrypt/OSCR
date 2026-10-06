"""The /status page's data (night phase 15, oscr/sitestatus.py): the per-day availability and the
incidents, aggregated from the Mac's own outbound checks. No test reaches the network: the check
uses a fake getter. The mechanism is built; the real checks are the owner's launchd step."""
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from oscr import sitestatus
from oscr.sitestatus import Check

# A fixed "now": 2026-10-05 12:00 UTC.
NOW = int(datetime(2026, 10, 5, 12, 0, tzinfo=UTC).timestamp())
DAY = 86_400


def at(day_offset: int, hour: int = 0) -> int:
    """A timestamp `day_offset` days before today, at `hour` UTC."""
    base = datetime(2026, 10, 5, tzinfo=UTC).timestamp()
    return int(base - day_offset * DAY + hour * 3600)


def test_run_check_reads_a_fake_getter_up_and_down():
    up = sitestatus.run_check("https://example.test/", now=NOW, get=lambda u: (200, 12.3))
    assert up.ok and up.status == 200 and up.ms == 12.3
    redirect = sitestatus.run_check("https://example.test/", now=NOW, get=lambda u: (301, 5.0))
    assert redirect.ok  # [200, 400) is up
    err = sitestatus.run_check("https://example.test/", now=NOW, get=lambda u: (503, 1.0))
    assert not err.ok and err.status == 503

    def boom(_url):
        raise OSError("no route to host")

    raised = sitestatus.run_check("https://example.test/", now=NOW, get=boom)
    assert not raised.ok and raised.status == 0


def test_aggregate_gives_one_cell_per_day_over_the_window():
    checks = [Check(t=at(0, h), ok=True, status=200, ms=10.0) for h in range(0, 24, 2)]
    agg = sitestatus.aggregate(checks, NOW, window_days=90)
    assert len(agg["days"]) == 90
    # The last day is today and is fully up; the earlier days have no check ("none").
    today = agg["days"][-1]
    assert today["date"] == "2026-10-05"
    assert today["state"] == "up" and today["uptime"] == 1.0
    assert agg["days"][0]["state"] == "none" and agg["days"][0]["uptime"] is None
    assert agg["overall_uptime"] == 1.0


def test_a_partial_and_a_down_day():
    # Yesterday: 6 up, 4 down → partial. Two days ago: 1 up, 9 down → down.
    checks = []
    for i in range(6):
        checks.append(Check(t=at(1, i), ok=True, status=200, ms=1.0))
    for i in range(6, 10):
        checks.append(Check(t=at(1, i), ok=False, status=500, ms=1.0))
    checks.append(Check(t=at(2, 0), ok=True, status=200, ms=1.0))
    for i in range(1, 10):
        checks.append(Check(t=at(2, i), ok=False, status=0, ms=0.0))
    agg = sitestatus.aggregate(checks, NOW, window_days=90)
    by_date = {d["date"]: d for d in agg["days"]}
    assert by_date["2026-10-04"]["state"] == "partial"
    assert by_date["2026-10-03"]["state"] == "down"


def test_incidents_are_runs_of_consecutive_failures():
    checks = [
        Check(t=at(1, 0), ok=True, status=200, ms=1.0),
        Check(t=at(1, 1), ok=False, status=0, ms=0.0),
        Check(t=at(1, 2), ok=False, status=0, ms=0.0),
        Check(t=at(1, 3), ok=True, status=200, ms=1.0),
        Check(t=at(1, 4), ok=False, status=500, ms=1.0),
    ]
    agg = sitestatus.aggregate(checks, NOW, window_days=90)
    assert len(agg["incidents"]) == 2
    first = agg["incidents"][0]
    assert first["checks"] == 2 and first["title"] == "The site did not answer"
    assert agg["incidents"][1]["title"] == "The site answered with errors"


def test_an_incident_older_than_the_window_is_dropped():
    checks = [Check(t=at(200, 0), ok=False, status=0, ms=0.0)]
    agg = sitestatus.aggregate(checks, NOW, window_days=90)
    assert agg["incidents"] == []


def test_build_and_empty_shapes():
    full = sitestatus.build([Check(t=at(0, 0), ok=True, status=200, ms=1.0)], now=NOW)
    assert full["enabled"] is True
    assert full["window_days"] == 90 and full["checks_per_day"] == 288
    assert full["generated_at"] == "2026-10-05T12:00:00Z"
    placeholder = sitestatus.empty(now=NOW)
    assert placeholder["enabled"] is False
    assert placeholder["days"] == [] and placeholder["overall_uptime"] is None


def test_store_round_trips(tmp_path: Path):
    store = tmp_path / "status" / "checks.jsonl"
    sitestatus.append_check(store, Check(t=at(0, 0), ok=True, status=200, ms=1.0))
    sitestatus.append_check(store, Check(t=at(0, 1), ok=False, status=0, ms=0.0))
    (store).write_text(store.read_text() + "not json\n")  # a bad line is skipped
    loaded = sitestatus.load_checks(store)
    assert len(loaded) == 2 and loaded[0].ok and not loaded[1].ok


def test_command_init_check_build(tmp_path: Path):
    export = tmp_path / "public"
    store = tmp_path / "status" / "checks.jsonl"
    msg = sitestatus.command("init", export=export, store=store, url="https://x.test/", now=NOW)
    assert "placeholder" in msg
    data = json.loads((export / "site-status.json").read_text())
    assert data["enabled"] is False

    # One check with a fake getter (never the network), then build.
    sitestatus.command("check", export=export, store=store, url="https://x.test/", now=NOW, get=lambda u: (200, 9.0))
    out = sitestatus.command("build", export=export, store=store, url="https://x.test/", now=NOW)
    assert "1 incident" not in out  # the one check was up
    built = json.loads((export / "site-status.json").read_text())
    assert built["enabled"] is True and built["total_checks"] == 1 and built["ok_checks"] == 1


def test_command_rejects_an_unknown_action(tmp_path: Path):
    with pytest.raises(ValueError):
        sitestatus.command("nonsense", export=tmp_path, store=tmp_path / "s.jsonl", url="https://x.test/")
