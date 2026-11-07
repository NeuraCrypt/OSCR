"""The nights' trend (oscr/nighttrend.py): each step's duration night by night, the figures of each
night's end, and a warning when a night lasts over 6 hours or the nights grew 7 times in a row."""
from __future__ import annotations

import json
import sqlite3
import threading
import urllib.request

from oscr import cycles, dashboard, nighttrend, publish


def night(start: float, steps: dict[str, float], status: str = "ok", kind: str = "nightly") -> int:
    """A finished cycle that began at `start`, its steps lasting `steps` minutes each, in order."""
    cid = cycles.start_cycle(kind)
    t = start
    con = sqlite3.connect(cycles.DB)
    for name, minutes in steps.items():
        con.execute("INSERT INTO step(cycle_id, name, started, finished, status) VALUES (?, ?, ?, ?, 'ok')",
                    (cid, name, t, t + minutes * 60))
        t += minutes * 60
    con.execute("UPDATE cycle SET started = ?, finished = ?, status = ? WHERE id = ?", (start, t, status, cid))
    con.commit()
    return cid


DAY = 86400.0
T0 = 1_793_000_000.0


def test_each_night_says_its_steps_and_figures_oldest_first():
    first = night(T0, {"export": 94, "dataset": 40, "deploy": 223})
    night(T0 + DAY, {"export": 140, "dataset": 153, "deploy": 90})
    cycles.measure(first, "site_files", 10603)
    cycles.measure(first, "deploy_bytes", None)                     # not known: not recorded
    rows = nighttrend.nights()
    assert [r["steps"] for r in rows] == [{"export": 94.0, "dataset": 40.0, "deploy": 223.0},
                                          {"export": 140.0, "dataset": 153.0, "deploy": 90.0}]
    assert rows[0]["minutes"] == 357.0 and rows[0]["figures"] == {"site_files": 10603.0}


def test_a_night_over_six_hours_is_said():
    night(T0, {"export": 300, "deploy": 431})
    assert nighttrend.warning() == "the last night lasted 12.2 h, over 6 h"
    night(T0 + DAY, {"export": 100, "deploy": 120})
    assert nighttrend.warning() == ""


def test_nights_growing_seven_times_in_a_row_are_said_even_under_six_hours():
    """2026-10-29 to 11-04: 376, 542, 585, 833 minutes; here a slower climb, still under 6 hours."""
    for i in range(8):
        night(T0 + i * DAY, {"export": 100 + 10 * i, "deploy": 50})
    assert nighttrend.warning() == "the nights grew 7 times in a row (150 to 220 min)"
    night(T0 + 8 * DAY, {"export": 90, "deploy": 50})
    assert nighttrend.warning() == ""


def test_a_preflight_refusal_is_no_night_of_the_trend():
    for i in range(8):
        night(T0 + i * DAY, {"export": 100 + 10 * i, "deploy": 50})
        night(T0 + i * DAY + 600, {"preflight": 0}, status="failed")
    assert "grew 7 times" in nighttrend.warning()


def test_the_nights_figures_are_recorded(tmp_path):
    website = tmp_path / "website"
    (website / "dist" / "scripts").mkdir(parents=True)
    (website / "dist" / "index.html").write_text("x" * 10)
    lot = tmp_path / "Expansion" / "1024.json"
    lot.parent.mkdir()
    lot.write_text("y" * 100)
    (website / "dist" / "scripts" / "1024.json").symlink_to(lot)
    (website / "public").symlink_to(tmp_path / "Expansion")
    cid = night(T0, {"export": 1})
    nighttrend.record(cid, website, {"tries": 2, "found": 41, "bytes": 478419717})
    f = cycles.measures([cid])[cid]
    assert f["site_files"] == 2 and f["largest_file"] == 100 and f["deploy_bytes"] == 478419717
    assert f["deploy_found"] == 41 and f["deploy_tries"] == 2 and f["free_internal"] > 0 and f["free_external"] > 0


def test_the_bytes_sent_are_read_from_wranglers_own_logs(tmp_path):
    (tmp_path / "wrangler-2026-11-06_15-32-04_619.log").write_text(
        'Metrics dispatcher: {"assetUploadFileCount":41,"assetUploadTotalBytes":478419717}')
    (tmp_path / "wrangler-2026-11-06_11-24-04_133.log").write_text("✘ [ERROR] Upload took too long.")
    assert publish._uploaded_bytes(0, tmp_path) == 478419717
    assert publish._uploaded_bytes(4_000_000_000, tmp_path) is None


def test_the_dashboard_serves_the_trend(tmp_path):
    night(T0, {"export": 400, "deploy": 10})
    from http.server import ThreadingHTTPServer
    server = ThreadingHTTPServer(("127.0.0.1", 0), dashboard.handler(tmp_path / "none.db"))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/api/trend") as r:
            t = json.loads(r.read())
    finally:
        server.shutdown()
    assert t["nights"][0]["steps"] == {"export": 400.0, "deploy": 10.0} and "over 6 h" in t["warning"]
