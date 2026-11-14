"""Block identifiers (oscr/blocks.py, docs/PLAN_BLOCK_IDS.md): computed from the paper's DOI, the
SWHID of the file's verified content and the lines; recorded and never deleted (current, superseded,
withdrawn); written on the matches, in the DOI lookup's shards and in the tracing map (format 0.2),
never from a withheld file."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import make_fixture  # noqa: E402

from oscr import blocks, catalog, entities, zenodo  # noqa: E402

P1 = "doi:10.5555/oscr.fixture.1"
EEG = "github.com/oscr-fixture/eeg-analysis"


@pytest.fixture
def con(tmp_path):
    return make_fixture.database(tmp_path / "mac.db")


def _swhid(text: str) -> str:
    data = text.encode()
    return "swh:1:cnt:" + hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def test_the_identifier_is_computed_from_the_doi_the_content_and_the_lines():
    swhid = _swhid("print(1)\n")
    a = blocks.block_id("10.5555/X", swhid, 6, 10)
    assert a == blocks.block_id("10.5555/x", swhid, 6, 10)                  # the DOI in any case
    assert blocks.ID_RE.match(a) and len(a) == len("oscr:b:") + 13 + 2
    assert a != blocks.block_id("10.5555/x", swhid, 6, 11)
    assert a != blocks.block_id("10.5555/y", swhid, 6, 10)
    assert a != blocks.block_id("10.5555/x", _swhid("print(2)\n"), 6, 10)
    # Written by a person: lower case, an O for a zero, an L for a one; a wrong check is refused.
    assert blocks.normalize(a.lower()) == a and blocks.normalize(a.upper()) == a
    body = a[len("oscr:b:"):-2]
    if "0" in body:
        assert blocks.normalize(a.replace("0", "o")) == a
    wrong = a[:-1] + ("0" if a[-1] != "0" else "1")
    assert blocks.normalize(wrong) == ""
    # One character changed in the body: the check character says so.
    swapped = a[:7] + ("1" if a[7] != "1" else "2") + a[8:]
    assert blocks.normalize(swapped) == ""
    assert blocks.normalize("10.5555/x") == "" and blocks.normalize("") == ""


def test_the_check_character_is_iso_7064_mod_37_36():
    # The check of a body read as the check of the same body plus its check: the hybrid system ends at 1.
    for body in ("0000000000000", "ZZZZZZZZZZZZZ", "7K3M9QX2PD4TA"):
        c = blocks.check_char(body)
        m, p = 36, 36
        for ch in body + c:
            s = (p + int(ch, 36)) % m or m
            p = (s * 2) % (m + 1)
        assert s == 1


def test_sync_records_the_blocks_once_and_writes_them_on_the_matches(con):
    pairs = blocks.sync(con, now=1000.0)
    assert set(k for k, _ in pairs) == {P1} and len(set(pairs.values())) == 2
    again = blocks.sync(con, now=2000.0)
    assert again == pairs
    rows = {r["id"]: r for r in con.execute("SELECT * FROM code_block")}
    assert len(rows) == 2 and {r["status"] for r in rows.values()} == {"current"}
    assert {r["first_seen"] for r in rows.values()} == {1000.0} and {r["last_seen"] for r in rows.values()} == {2000.0}
    one = rows[pairs[(P1, 1)]]
    text = con.execute("SELECT text FROM file WHERE repo = ? AND path = ?", (EEG, one["path"])).fetchone()[0]
    assert one["swhid"] == _swhid(text)
    assert one["id"] == blocks.block_id("10.5555/oscr.fixture.1", one["swhid"], one["start_line"], one["end_line"])
    lots = catalog.alignment_lots(con, pairs)
    assert {p["block"] for lot in lots.values() for e in lot.values() for p in e["pairs"]} == set(pairs.values())


def test_a_block_whose_lines_moved_is_superseded_by_the_one_that_overlaps_it(con):
    pairs = blocks.sync(con, now=1000.0)
    old = pairs[(P1, 1)]
    con.execute("UPDATE alignment SET start_line = 7, end_line = 11 WHERE article_id = ? AND pair = 1", (P1,))
    pairs = blocks.sync(con, now=2000.0)
    new = pairs[(P1, 1)]
    assert new != old
    row = con.execute("SELECT status, superseded_by FROM code_block WHERE id = ?", (old,)).fetchone()
    assert tuple(row) == ("superseded", new)
    # It comes back: current again.
    con.execute("UPDATE alignment SET start_line = 6, end_line = 10 WHERE article_id = ? AND pair = 1", (P1,))
    blocks.sync(con, now=3000.0)
    assert tuple(con.execute("SELECT status, superseded_by FROM code_block WHERE id = ?", (old,)).fetchone()) == ("current", None)
    assert con.execute("SELECT COUNT(*) FROM code_block").fetchone()[0] == 3


def test_a_withheld_file_or_map_withdraws_its_blocks_and_nothing_is_deleted(con):
    pairs = blocks.sync(con, now=1000.0)
    path = con.execute("SELECT path FROM code_block WHERE id = ?", (pairs[(P1, 2)],)).fetchone()[0]
    con.execute("INSERT INTO withheld (scope, article_id, repo, path, request, created_at) VALUES ('file', ?, ?, ?, 'test', 1)",
                (P1, EEG, path))
    after = blocks.sync(con, now=2000.0)
    assert (P1, 2) not in after
    assert con.execute("SELECT status FROM code_block WHERE id = ?", (pairs[(P1, 2)],)).fetchone()[0] == "withdrawn"
    # Its public entry keeps only the paper: no file, lines nor content.
    entry = blocks.lookup_entries(con, {P1: "doi_10.5555_oscr.fixture.1"})[pairs[(P1, 2)]]
    assert entry == {"status": "withdrawn", "doi": "10.5555/oscr.fixture.1", "since": "1970-01-01",
                     "page": "doi_10.5555_oscr.fixture.1"}
    assert con.execute("SELECT COUNT(*) FROM code_block").fetchone()[0] == 2


def test_a_file_without_a_verified_swhid_gets_no_identifier(con):
    con.execute("UPDATE file SET digest = ? WHERE repo = ?", ("0" * 64, EEG))
    assert blocks.sync(con, now=1.0) == {}
    assert con.execute("SELECT COUNT(*) FROM code_block").fetchone()[0] == 0


def test_a_collision_stops_without_writing(con):
    pairs = blocks.sync(con, now=1.0)
    con.execute("UPDATE code_block SET swhid = 'swh:1:cnt:' || substr('0000000000000000000000000000000000000000', 1, 40) "
                "WHERE id = ?", (pairs[(P1, 1)],))
    con.commit()
    with pytest.raises(blocks.CollisionError):
        blocks.sync(con, now=2.0)
    assert con.execute("SELECT MAX(last_seen) FROM code_block").fetchone()[0] == 1.0


def test_the_blocks_are_in_the_lookup_shards_each_in_the_shard_of_its_sha1(con):
    pairs = blocks.sync(con, now=1000.0)
    shards = entities.lookup(con, {P1: "doi_10.5555_oscr.fixture.1"})
    for bid in set(pairs.values()):
        e = shards[entities.lookup_shard(bid)][bid]
        assert e["status"] == "current" and e["doi"] == "10.5555/oscr.fixture.1" and e["page"] == "doi_10.5555_oscr.fixture.1"
        assert e["repo"] == EEG and e["swhid"].startswith("swh:1:cnt:") and e["method"] == "lexical-v1"
        assert len(e["lines"]) == 2 and e["paragraphs"] and e["origin"] == "machine"
    # The DOIs are still there, as before.
    assert shards[entities.lookup_shard("10.5555/oscr.fixture.1")]["10.5555/oscr.fixture.1"][0]


def test_the_map_names_its_blocks_in_format_0_2_and_a_map_validated_before_keeps_its_own(con):
    pairs = blocks.sync(con, now=1000.0)
    card = zenodo.map_of(con, P1)
    assert card["format"] == "tracing-map/0.2"
    assert [a["block"] for a in card["alignments"]] == [pairs[(P1, 1)], pairs[(P1, 2)]]
    assert zenodo.format_version(card) == "0.2"
    old = {**card, "format": "tracing-map/0.1"}
    assert zenodo.format_version(json.dumps(old)) == "0.1"
    assert zenodo.format_version(None) == "0.2"
    # The digest is over what the map holds: a 0.1 map's digest is the one its author validated.
    assert zenodo.map_digest(old) != zenodo.map_digest(card)


def test_describe(con):
    pairs = blocks.sync(con, now=1000.0)
    out = blocks.describe(con, pairs[(P1, 1)].lower())
    assert out.startswith(pairs[(P1, 1)] + " (current") and "SWHID: swh:1:cnt:" in out
    assert "not a block identifier" in blocks.describe(con, "oscr:b:nope")
