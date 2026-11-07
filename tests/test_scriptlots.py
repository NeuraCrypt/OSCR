"""The scripts' text lots keep their files for good (oscr/scriptlots.py, 2026-11-07): a full lot is
never written again, so it is never sent to Cloudflare again."""
from __future__ import annotations

import json
import os

from oscr import scriptlots
from oscr.scriptlots import Store


def entry(text: str) -> dict:
    return {"text": text, "language": "Python", "lines": 1, "truncated": False}


def sha(n: int) -> str:
    return f"{n:064x}"


def texts(*ns: int, size: int = 10) -> dict:
    return {sha(n): entry(str(n) * size) for n in ns}


def lot_files(store: Store) -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text()) for p in store.lots.glob("*.json")}


def test_a_new_store_fills_lot_00_and_a_known_file_keeps_its_lot(tmp_path):
    store = Store.at(tmp_path / "s")
    place, said = store.update(texts(1, 2, 3))
    assert set(place.values()) == {"00"} and "3 new files in 1 new lot" in said
    place2, said2 = store.update(texts(1, 2, 3, 4))
    assert place2 == {**place, sha(4): "00"} and "1 new files in 0 new lot" in said2
    assert set(lot_files(store)["00"]) == {sha(1), sha(2), sha(3), sha(4)}


def test_a_full_lot_is_closed_and_never_written_again(tmp_path):
    store = Store.at(tmp_path / "s")
    one = scriptlots._entry_bytes(sha(1), texts(1, size=100)[sha(1)])
    target = 2 + 3 * one                                   # three files a lot
    store.update(texts(*range(1, 7), size=100), target=target)
    assert {k: len(v) for k, v in lot_files(store).items()} == {"00": 3, "01": 3}
    closed = store.path("00")
    before = (closed.stat().st_mtime_ns, closed.read_bytes())
    os.utime(closed, ns=(1, 1))
    place, said = store.update(texts(*range(1, 9), size=100), target=target)
    assert closed.stat().st_mtime_ns == 1 and closed.read_bytes() == before[1]   # not touched
    assert place[sha(7)] == "02" and place[sha(8)] == "02"                       # 01 was full too
    assert "2 new files in 1 new lot" in said and "1 lot(s) written" in said
    for p in store.lots.glob("*.json"):
        assert p.stat().st_size <= target


def test_a_removed_file_rewrites_only_its_own_lot(tmp_path):
    store = Store.at(tmp_path / "s")
    one = scriptlots._entry_bytes(sha(1), texts(1, size=100)[sha(1)])
    store.update(texts(*range(1, 7), size=100), target=2 + 3 * one)
    os.utime(store.path("01"), ns=(1, 1))
    place, said = store.update({k: v for k, v in texts(*range(1, 7), size=100).items() if k != sha(2)},
                               target=2 + 3 * one)
    assert sha(2) not in place and sha(2) not in lot_files(store)["00"]
    assert store.path("01").stat().st_mtime_ns == 1 and "1 removed" in said


def test_a_changed_entry_rewrites_its_lot_where_it_is(tmp_path):
    """The shown text of a known file changes (the email masking): it stays in its lot, rewritten."""
    store = Store.at(tmp_path / "s")
    store.update({sha(1): entry("me@lab.org")})
    place, _ = store.update({sha(1): entry("[email hidden]")})
    assert place == {sha(1): "00"} and lot_files(store)["00"][sha(1)]["text"] == "[email hidden]"


def test_an_emptied_lot_leaves_and_its_number_is_never_given_again(tmp_path):
    store = Store.at(tmp_path / "s")
    one = scriptlots._entry_bytes(sha(1), texts(1, size=100)[sha(1)])
    target = 2 + one
    store.update(texts(1, 2, size=100), target=target)                    # 00 and 01, one file each
    store.update(texts(1, size=100), target=target)                       # 01 emptied
    assert set(lot_files(store)) == {"00"} and store.names() == ["00"]
    place, _ = store.update(texts(1, 3, size=100), target=target)
    assert place[sha(3)] == "02"


def test_adopt_freezes_the_lots_online_and_new_files_follow_them(tmp_path):
    """The migration: the lots the build read are moved into the store as they are, all closed;
    nothing is renumbered, a new file goes after the highest."""
    old = tmp_path / "public" / "scripts"
    old.mkdir(parents=True)
    (old / "05.json").write_text(json.dumps({sha(5): entry("five")}, separators=(",", ":")))
    (old / "1023.json").write_text(json.dumps({sha(9): entry("nine")}, separators=(",", ":")))
    frozen = (old / "1023.json").read_bytes()
    store = Store.at(tmp_path / "script-lots")
    assert store.adopt(old) == 2
    assert not old.exists() and (store.lots / "1023.json").read_bytes() == frozen
    place, _ = store.update({sha(5): entry("five"), sha(9): entry("nine"), sha(10): entry("ten")})
    assert place == {sha(5): "05", sha(9): "1023", sha(10): "1024"}
    assert (store.lots / "1023.json").read_bytes() == frozen
    assert store.adopt(old) == 0                                          # once only


def test_link_into_gives_dist_one_link_per_lot_and_nothing_else(tmp_path):
    store = Store.at(tmp_path / "s")
    store.update(texts(1, 2))
    dist = tmp_path / "dist" / "scripts"
    dist.mkdir(parents=True)
    (dist / "00.json").write_text("an old copy")                          # what a build left
    (dist / "77.json").write_text("{}")
    assert scriptlots.link_into(store, dist) == 1
    assert sorted(p.name for p in dist.iterdir()) == ["00.json"]
    assert (dist / "00.json").is_symlink() and json.loads((dist / "00.json").read_text()) == lot_files(store)["00"]


def test_the_site_store_is_beside_website_public(tmp_path):
    heavy = tmp_path / "Expansion" / "website" / "public"
    heavy.mkdir(parents=True)
    website = tmp_path / "repo" / "website"
    website.mkdir(parents=True)
    (website / "public").symlink_to(heavy)
    from conftest import REAL_SITE_STORE
    store = REAL_SITE_STORE(website, {})
    assert store.lots == heavy.resolve().parent / "script-lots" / "lots"
    assert REAL_SITE_STORE(website, {"OSCR_SCRIPT_LOTS": str(tmp_path / "x")}).index == tmp_path / "x" / "index.db"


def test_the_export_writes_its_lots_to_the_store_and_frees_the_old_copies(tmp_path):
    """With the nightly's store, the export keeps no lot of its own (the 8.4 GB of `data/public/scripts`
    on 2026-11-07), writes `scripts.jsonl` to the heavy folder with a link beside the catalogue, and
    each file's `text_lot` is a lot of the store; a second export writes no lot again."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    import make_fixture

    from oscr import catalog

    con = make_fixture.database(tmp_path / "fixture.db")
    out = tmp_path / "public"
    (out / "scripts").mkdir(parents=True)
    (out / "scripts" / "00.json").write_text("{}")                       # the copy of the time before
    store, heavy = Store.at(tmp_path / "Expansion" / "script-lots"), tmp_path / "Expansion" / "bulk"
    catalog.generate(con, out, public=True, lots=store, heavy=heavy)
    assert not (out / "scripts").exists()
    assert (out / "scripts.jsonl").is_symlink() and (heavy / "scripts.jsonl").stat().st_size > 0
    lots = lot_files(store)
    for p in (out / "scriptmeta").glob("*.json"):
        for repo in json.loads(p.read_text()).values():
            for f in repo["files"]:
                if "sha256" in f:
                    assert f["sha256"] in lots[f["text_lot"]]
    for p in store.lots.glob("*.json"):
        os.utime(p, ns=(1, 1))
    catalog.generate(con, out, public=True, lots=store, heavy=heavy)
    assert all(p.stat().st_mtime_ns == 1 for p in store.lots.glob("*.json"))


def test_a_file_that_merely_left_the_export_stays_and_its_lot_does_not_change(tmp_path):
    """A repository read again at a newer commit drops its old files from the export: they stay in
    their lot, unseen, so the lot is not sent again. Only what must not be shown (`remove`) leaves."""
    store = Store.at(tmp_path / "s")
    store.update(texts(1, 2))
    os.utime(store.path("00"), ns=(1, 1))
    place, said = store.update(texts(1), remove=set())
    assert store.path("00").stat().st_mtime_ns == 1 and "0 removed" in said and sha(2) in lot_files(store)["00"]
    place, said = store.update(texts(1), remove={sha(2)})
    assert sha(2) not in lot_files(store)["00"] and "1 removed" in said
