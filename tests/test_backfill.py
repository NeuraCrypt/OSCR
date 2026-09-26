import time

from oscr import db, harvest
from oscr.net import Client


def test_months_walk_back_and_have_bounds():
    assert harvest._previous_month("2026-01") == "2025-12"
    assert harvest._previous_month("2026-03") == "2026-02"
    assert harvest._month_bounds("2024-02") == ("2024-02-01", "2024-02-29")
    assert harvest._month_bounds("2025-12") == ("2025-12-01", "2025-12-31")


def test_a_spent_budget_hands_back_control_without_moving_the_cursor(tmp_path):
    # Deadline already passed: no month is started, the cursor does not move, and no
    # request leaves (offline client).
    con = db.open_db(tmp_path / "b.db")
    db.set_cursor(con, "backfill:neuro", "2019-06")
    t = harvest.backfill(con, Client(offline=True), "neuro", harvest.Options(library=tmp_path),
                         max_duration_s=-1, report=lambda _: None)
    assert t.articles == 0
    assert db.cursor(con, "backfill:neuro") == "2019-06"


def test_the_backfill_stops_at_the_requested_year(tmp_path):
    con = db.open_db(tmp_path / "b.db")
    db.set_cursor(con, "backfill:neuro", "1999-12")
    start = time.time()
    harvest.backfill(con, Client(offline=True), "neuro", harvest.Options(library=tmp_path),
                     max_duration_s=60, back_to=2000, report=lambda _: None)
    assert time.time() - start < 5


def test_the_current_month_is_noted_from_its_start(tmp_path, monkeypatch):
    # The dashboard must show the month the watch is walking through, not wait for its end.
    con = db.open_db(tmp_path / "b.db")
    db.set_cursor(con, "backfill:neuro", "2019-06")
    seen = []

    def scan(con, client, q, opts, **k):
        seen.append(db.cursor(con, "backfill:neuro"))
        return harvest.Tally(interrupted=True)
    monkeypatch.setattr(harvest, "scan_query", scan)
    harvest.backfill(con, Client(offline=True), "neuro", harvest.Options(library=tmp_path),
                     max_duration_s=60, report=lambda _: None)
    assert seen == ["2019-06"] and db.cursor(con, "backfill:neuro") == "2019-06"
