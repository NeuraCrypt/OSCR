"""Block identifiers: a citable, permanent identifier for each block of code linked to a paper
(docs/PLAN_BLOCK_IDS.md, decided by the owner on 2026-11-13).

A **block** is what a match of the Code ↔ Paper reader points at: lines of one file of the
authors' code, linked to a paper. The matches themselves (`alignment`) are renumbered every time a
paper is aligned again (`db.save_alignment` deletes and rewrites them), so their numbers are never
cited. A block's identifier is computed instead from three facts that name it anywhere:

- the paper's DOI (lower case);
- the Software Heritage identifier (SWHID) of the file's content, `swh:1:cnt:<sha1_git>`, computed
  from the ORIGINAL bytes whose SHA-256 the registry verified (catalog.content_swhid), never from
  the text the site shows (its email addresses masked);
- the lines.

The same block always gets the same identifier, and anyone can compute it again. Its form:
`oscr:b:` + 13 characters of Crockford's base32 (the first 65 bits of a SHA-256: no I, L, O or U,
so it reads aloud and copies without confusion) + `-` + a check character (ISO 7064 MOD 37,36, the
scheme of ORCID's: a mistyped identifier is recognized, not resolved to another block).

**Never deleted.** `sync` keeps one row per identifier ever given (`code_block`): `current` while
the block is among the matches; `superseded` once it is not, with the block of the same paper and
file that overlaps it most (`superseded_by`); `withdrawn` when its paper left the registry or a
removal request withheld its map or its file. A match whose file has no verified SWHID (a
truncated or re-encoded text, a withheld copy) gets no identifier: only what was verified is named.

`/b/<id>` on the site answers with the block's page (worker/block.ts), from the entries
`lookup_entries` writes into the DOI lookup's shards (oscr/entities.py): no file of its own.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from collections import defaultdict
from typing import Any

#: Crockford's base32: digits and letters but I, L, O and U.
ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PREFIX = "oscr:b:"
#: Characters of an identifier's body: 13 × 5 = 65 bits.
BODY = 13
#: An identifier as the site and the API accept it (the check character is verified apart).
ID_RE = re.compile(r"^oscr:b:([0-9A-HJKMNP-TV-Z]{13})-([0-9A-Z])$")
#: How much of a section title a block's public entry keeps.
SECTION_CHARS = 80


class CollisionError(RuntimeError):
    """Two different blocks would share an identifier: nothing is written."""


def check_char(body: str) -> str:
    """ISO 7064 MOD 37,36 (hybrid system) over the body's characters, read in base 36."""
    m = 36
    p = m
    for c in body:
        s = (p + int(c, 36)) % m or m
        p = (s * 2) % (m + 1)
    return "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[(m + 1 - p) % m]


def block_id(doi: str, swhid: str, start: int, end: int) -> str:
    """The identifier of the lines `start`-`end` of the content `swhid`, linked to the paper `doi`."""
    key = f"{doi.strip().lower()}\n{swhid}\n{int(start)}-{int(end)}".encode()
    n = int.from_bytes(hashlib.sha256(key).digest()[:9], "big") >> (72 - 5 * BODY)
    body = "".join(ALPHABET[(n >> (5 * (BODY - 1 - i))) & 31] for i in range(BODY))
    return f"{PREFIX}{body}-{check_char(body)}"


def normalize(text: str) -> str:
    """An identifier as written by a person ("OSCR:B:7k3m…-k", an O for a zero) → its one form, or
    "" when it is not one (a wrong check character included)."""
    t = (text or "").strip()
    if t.lower().startswith(PREFIX):
        t = t[len(PREFIX):]
    body, _, check = t.upper().partition("-")
    body = body.translate(str.maketrans({"O": "0", "I": "1", "L": "1"}))
    if len(body) != BODY or len(check) != 1 or any(c not in ALPHABET for c in body):
        return ""
    return f"{PREFIX}{body}-{check}" if check_char(body) == check else ""


# ---------------------------------------------------------------------------------------
# The blocks of the matches.

def _swhids(con: sqlite3.Connection) -> Any:
    """`swhid(repo, path)`: the file's content SWHID, "" when its text is not the verified file."""
    from .catalog import content_swhid
    seen: dict[tuple[str, str], str] = {}

    def swhid(repo: str, path: str) -> str:
        if (repo, path) not in seen:
            f = con.execute("SELECT text, digest FROM file WHERE repo = ? AND path = ?", (repo, path)).fetchone()
            seen[(repo, path)] = content_swhid(f["text"], f["digest"] or "") if f else ""
        return seen[(repo, path)]
    return swhid


def current_blocks(con: sqlite3.Connection, article_id: str | None = None) -> tuple[dict[str, dict[str, Any]],
                                                                                    dict[tuple[str, int], str]]:
    """The blocks the matches name now: {id: facts}, and {(paper, match number): id}. Papers out of
    scope, maps and files withheld at a removal request give none."""
    from .catalog import IN_SCOPE_IDS, withheld
    from .entities import normalize_doi
    held = withheld(con)
    swhid = _swhids(con)
    blocks: dict[str, dict[str, Any]] = {}
    pairs: dict[tuple[str, int], str] = {}
    where = "AND al.article_id = ?" if article_id else ""
    rows = con.execute(
        f"SELECT al.*, a.doi, r.commit_id FROM alignment al JOIN article a ON a.id = al.article_id "
        f"LEFT JOIN repository r ON r.repo = al.repo WHERE al.article_id IN ({IN_SCOPE_IDS}) {where} "
        f"ORDER BY al.article_id, al.pair", (article_id,) if article_id else ())
    for r in rows:
        if r["article_id"] in held.maps or r["repo"] in held.repos or (r["repo"], r["path"]) in held.files:
            continue
        doi = normalize_doi(r["doi"] or "")
        content = swhid(r["repo"], r["path"]) if doi else ""
        if not content:
            continue
        bid = block_id(doi, content, r["start_line"], r["end_line"])
        b = blocks.setdefault(bid, {
            "article_id": r["article_id"], "doi": doi, "repo": r["repo"], "commit_id": r["commit_id"] or "",
            "path": r["path"], "swhid": content, "start_line": r["start_line"], "end_line": r["end_line"],
            "symbol": r["symbol"] or "", "paragraphs": [], "method": r["method"]})
        if b["article_id"] != r["article_id"]:
            continue    # two records of one DOI: the first one's matches name the block
        if [r["paragraph"], r["section"] or ""] not in b["paragraphs"]:
            b["paragraphs"].append([r["paragraph"], r["section"] or ""])
        pairs[(r["article_id"], r["pair"])] = bid
    return blocks, pairs


def _overlap(a: dict[str, Any], b: sqlite3.Row | dict[str, Any]) -> int:
    return min(a["end_line"], b["end_line"]) - max(a["start_line"], b["start_line"]) + 1


def sync(con: sqlite3.Connection, now: float | None = None) -> dict[tuple[str, int], str]:
    """Record the blocks the matches name now (`code_block`), keep the others as superseded or
    withdrawn, and return {(paper, match number): id} for the export. Idempotent: run twice, the
    second run changes nothing but `last_seen`."""
    from .catalog import IN_SCOPE_IDS, withheld
    now = time.time() if now is None else now
    blocks, pairs = current_blocks(con)
    known = {r["id"]: r for r in con.execute("SELECT * FROM code_block")}
    for bid, b in blocks.items():
        old = known.get(bid)
        if old is not None and (old["doi"], old["swhid"], old["start_line"], old["end_line"]) != (
                b["doi"], b["swhid"], b["start_line"], b["end_line"]):
            raise CollisionError(f"{bid} already names another block ({old['article_id']} {old['path']})")
    for bid, b in blocks.items():
        values = (b["article_id"], b["doi"], b["repo"], b["commit_id"], b["path"], b["swhid"], b["start_line"],
                  b["end_line"], b["symbol"], json.dumps(b["paragraphs"], ensure_ascii=False), b["method"])
        if bid in known:
            con.execute("UPDATE code_block SET article_id = ?, doi = ?, repo = ?, commit_id = ?, path = ?, swhid = ?, "
                        "start_line = ?, end_line = ?, symbol = ?, paragraphs = ?, method = ?, status = 'current', "
                        "superseded_by = NULL, last_seen = ? WHERE id = ?", (*values, now, bid))
        else:
            con.execute("INSERT INTO code_block (article_id, doi, repo, commit_id, path, swhid, start_line, end_line, "
                        "symbol, paragraphs, method, id, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (*values, bid, now, now))
    gone = [r for bid, r in known.items() if bid not in blocks and r["status"] == "current"]
    if gone:
        held = withheld(con)
        in_scope = {r[0] for r in con.execute(IN_SCOPE_IDS)}
        by_file: dict[tuple[str, str], list[tuple[str, dict[str, Any]]]] = defaultdict(list)
        for bid, b in blocks.items():
            by_file[(b["article_id"], b["path"])].append((bid, b))
        for r in gone:
            if (r["article_id"] not in in_scope or r["article_id"] in held.maps or r["repo"] in held.repos
                    or (r["repo"], r["path"]) in held.files):
                con.execute("UPDATE code_block SET status = 'withdrawn', superseded_by = NULL WHERE id = ?", (r["id"],))
                continue
            near = [(_overlap(b, r), bid) for bid, b in by_file.get((r["article_id"], r["path"]), []) if _overlap(b, r) > 0]
            con.execute("UPDATE code_block SET status = 'superseded', superseded_by = ? WHERE id = ?",
                        (max(near)[1] if near else None, r["id"]))
    con.commit()
    return pairs


# ---------------------------------------------------------------------------------------
# What leaves: the entries of the DOI lookup's shards.

def _day(t: float | None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t)) if t else ""


def entry(r: sqlite3.Row | dict[str, Any], slug: str = "") -> dict[str, Any]:
    """A block's public entry: what its page (/b/<id>) shows. A withdrawn block keeps only its paper
    and the day it was first given: its code, file and lines leave with it. Email addresses that a
    path, a section or a name may hold are masked (catalog.mask_emails)."""
    from .catalog import mask_emails
    e: dict[str, Any] = {"status": r["status"], "doi": r["doi"], "since": _day(r["first_seen"])}
    if slug:
        e["page"] = slug
    if r["status"] == "withdrawn":
        return e
    paragraphs = json.loads(r["paragraphs"] or "[]")
    e.update({
        "repo": r["repo"], "commit": r["commit_id"], "path": mask_emails(r["path"]), "swhid": r["swhid"],
        "lines": [r["start_line"], r["end_line"]], "symbol": mask_emails(r["symbol"] or "")[:200],
        "paragraphs": [[int(p), mask_emails(str(s))[:SECTION_CHARS]] for p, s in paragraphs],
        "method": r["method"], "origin": r["origin"]})
    if r["status"] == "superseded" and r["superseded_by"]:
        e["next"] = r["superseded_by"]
    return e


def lookup_entries(con: sqlite3.Connection, slugs: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Every block ever identified, by identifier, with its public entry (`entry`)."""
    try:
        rows = con.execute("SELECT * FROM code_block ORDER BY id").fetchall()
    except sqlite3.OperationalError:
        return {}
    return {r["id"]: entry(r, slugs.get(r["article_id"], "")) for r in rows}


def describe(con: sqlite3.Connection, text: str) -> str:
    """`oscr blocks show <id>`: a block in a few lines."""
    bid = normalize(text)
    if not bid:
        return f"{text}: not a block identifier (its form or its check character is wrong)"
    r = con.execute("SELECT * FROM code_block WHERE id = ?", (bid,)).fetchone()
    if r is None:
        return f"{bid}: no such block"
    e = entry(r)
    lines = [f"{bid} ({e['status']}, since {e['since']})", f"paper: {e['doi']}"]
    if r["status"] != "withdrawn":
        lines += [f"code: {r['repo']} {r['path']}, lines {r['start_line']} to {r['end_line']}"
                  + (f" at {r['commit_id']}" if r["commit_id"] else ""),
                  f"SWHID: {r['swhid']}", f"paragraphs: {', '.join(str(p) for p, _ in e['paragraphs'])}",
                  f"by: {r['method']} ({r['origin']})"]
        if e.get("next"):
            lines.append(f"replaced by: {e['next']}")
    return "\n".join(lines)
