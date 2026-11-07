"""The night of 2026-11-05 (the Mac's disk full, a fixed 40 GB check, a 04:17 swallowed by a run still
going): a dead export's leftovers are freed before the space is counted, the space asked is computed
from the files the night writes, and a run begun before 04:17 does not count as that night's."""
from datetime import datetime

from oscr import catalog, cycles, nightly, preflight, watchdog

H = 3600


def at(day: int, hour: int, minute: int = 0) -> float:
    return datetime(2026, 11, day, hour, minute).timestamp()


def test_a_dead_exports_leftovers_are_removed_and_counted(tmp_path):
    (tmp_path / "oscr_public.tmp").write_bytes(b"x" * 1000)
    (tmp_path / "oscr_public.tmp-journal").write_bytes(b"x" * 10)
    (tmp_path / "oscr_public.db").write_bytes(b"kept")
    assert catalog.remove_public_db_leftovers(tmp_path) == 1010
    assert sorted(p.name for p in tmp_path.iterdir()) == ["oscr_public.db"]
    assert catalog.remove_public_db_leftovers(tmp_path) == 0


def test_the_space_asked_is_what_the_night_writes_plus_a_margin(tmp_path):
    out, site = tmp_path / "public", tmp_path / "website"
    (site / "dist").mkdir(parents=True)
    (site / "dist" / "index.html").write_bytes(b"x" * 10**6)
    out.mkdir()
    database = tmp_path / "oscr.db"
    database.write_bytes(b"x" * 4 * 10**6)
    need, why = preflight.needed(out, database, site)
    assert need == preflight.MARGIN + 2 * 10**6 + int(10**6 * 0.2)       # half of oscr.db the first time
    assert "half of oscr.db" in why
    (out / "oscr_public.db").write_bytes(b"x" * 10**6)
    need, why = preflight.needed(out, database, site)
    assert need == preflight.MARGIN + int(10**6 * 1.2) + int(10**6 * 0.2)
    assert "public database 0.0 GB x 1.2" in why and "margin 10 GB" in why
    need, why = preflight.needed(out, database, site, export=False)       # a resumption builds no database
    assert need == preflight.MARGIN + int(10**6 * 0.2) and "export already done" in why
    said = preflight.space(tmp_path, minimum=10**18, why=why)
    assert "GB are needed (export already done" in said


def test_the_nightly_frees_the_leftovers_before_its_preflight(tmp_path, monkeypatch, capsys):
    out = tmp_path / "public"
    out.mkdir()
    (out / "oscr_public.tmp").write_bytes(b"x" * 5000)
    seen = {}

    def preflight_run(cfg, dataset, cloudflare, need=None):
        seen["leftover"] = (out / "oscr_public.tmp").exists()
        seen["need"] = need
        return ["1 GB free on the disk, 30 GB are needed"]
    monkeypatch.setattr(preflight, "run", preflight_run)
    try:
        nightly.run(None, None, {}, out=out, dataset="", cloudflare="x")
    except SystemExit as e:
        assert "preflight" in str(e)
    assert seen["leftover"] is False and seen["need"][0] >= preflight.MARGIN
    assert "removed the leftovers of a dead export" in capsys.readouterr().out


def test_a_run_begun_before_0417_does_not_count_as_that_nights():
    # 2026-11-05 at 20:32 a catch-up began; it ended 2026-11-06 at 10:23, after that night's 04:17.
    late = {"success": at(6, 10, 23), "success_begun": at(5, 20, 32), "attempt": at(5, 20, 32)}
    assert watchdog.nightly_due(late, at(6, 10, 33))
    # Begun after 04:17 (the 04:17 run itself, or a catch-up that morning): that night is done.
    assert not watchdog.nightly_due(late | {"success_begun": at(6, 4, 17)}, at(6, 10, 33))
    assert not watchdog.nightly_due(late | {"success_begun": at(6, 8, 49)}, at(6, 16))
    # Before 04:47 the night before still counts, as launchd's own start is left alone.
    assert not watchdog.nightly_due({"success": at(5, 14), "success_begun": at(5, 4, 17)}, at(6, 4, 20))
    # A success recorded before success_begun existed counts as before.
    assert not watchdog.nightly_due({"success": at(6, 10, 23)}, at(6, 11))


def test_a_0417_swallowed_by_a_running_cycle_is_said_once(monkeypatch):
    running = cycles.start_cycle("nightly")
    con = cycles._db()
    with con:
        con.execute("UPDATE cycle SET started = ? WHERE id = ?", (at(5, 20, 32), running))
    assert cycles.skip_if_overrun(at(6, 4, 17), at(6, 4, 27)).startswith("skipped: previous cycle running")
    assert cycles.skip_if_overrun(at(6, 4, 17), at(6, 4, 37)) == ""          # once
    assert cycles.skip_if_overrun(at(5, 4, 17), at(5, 21)) == ""             # begun after that 04:17
    rows = cycles._db().execute("SELECT kind, status, detail FROM cycle WHERE kind = 'skipped'").fetchall()
    assert len(rows) == 1 and rows[0]["status"] == "skipped" and f"cycle {running}" in rows[0]["detail"]
    assert cycles.current()["cycle"]["id"] == running                          # the dashboard still shows it
