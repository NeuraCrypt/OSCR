"""The authors' contact details — PRIVATE (owner's decision of 2026-09-27).

For each author of a paper: email, given and family names, ORCID, organization, address and
the full affiliation, linked to the paper and its DOI. They come from what the paper itself
publishes — the JATS full text (contributors, affiliations, correspondence notes) and the
Europe PMC record ("Electronic address: …" in the affiliations) — and serve to cite and to
reach the authors of the code.

**Where they go.** The `contact` table of the database on the Mac, and the Hugging Face
dataset OpenScientificCodeRegistry/Private, **which must be private**: `publish` checks it
before sending anything and refuses otherwise. Never on the website, never in a public
output: `catalog.public_db` drops the table, and the site hides every email address it
would show (`catalog.mask_emails`).

The owner's other rule still holds: no mass email to the authors (CLAUDE.md).
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .jats import _analyze
from .zenodo import orcid_is_valid

DATASET = "OpenScientificCodeRegistry/Private"

#: An address as written in papers, obfuscations included ("jane(at)uni(dot)edu").
_EMAIL = re.compile(
    r"[\w.+'%-]+\s?(?:@|\(at\)|\[at\]|\{at\})\s?[\w-]+(?:\s?(?:\.|\(dot\)|\[dot\])\s?[\w-]+)*"
    r"\s?(?:\.|\(dot\)|\[dot\])\s?[A-Za-z]{2,}\b", re.I)
_LABEL = re.compile(r"(?i)\b(?:e-?mail(?:\s+address(?:es)?)?|electronic\s+address)\s*[:：]?\s*")
_ORCID = re.compile(r"(\d{4})-?(\d{4})-?(\d{4})-?(\d{3}[\dX])", re.I)
#: The words that make an affiliation segment an organization.
_ORGANIZATION = re.compile(
    r"(?i)univers|universit|institut|hospital|h[oô]pital|clinic|college|school|academy|acad[eé]m|"
    r"cent(?:er|re)|laborator|foundation|council|agency|ministry|cnrs|inserm|nih\b|max planck|"
    r"\binc\b|\bltd\b|gmbh|\bcorp|company|society|consortium|charit|polytechn|klinik")


def normalize_email(raw: str) -> str:
    """"Jane.Doe (at) Uni (dot) edu." → "jane.doe@uni.edu"; "" when it is not an address."""
    s = raw.strip().lower()
    s = re.sub(r"\s?(?:\(at\)|\[at\]|\{at\})\s?", "@", s)
    s = re.sub(r"\s?(?:\(dot\)|\[dot\])\s?", ".", s)
    s = re.sub(r"\s+", "", s).strip(".,;:()[]<>\"'")
    if not re.fullmatch(r"[\w.+'%-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}", s):
        return ""
    domain = s.split("@", 1)[1]
    if s.startswith("git@") or s.endswith((".png", ".jpg", ".gif")) or "noreply" in s \
            or re.search(r"(?:^|\.)example\.(?:com|org|net)$", domain):
        return ""
    return s


def emails_in(text: str) -> list[str]:
    out: list[str] = []
    for m in _EMAIL.finditer(text or ""):
        e = normalize_email(m.group(0))
        if e and e not in out:
            out.append(e)
    return out


def _without_emails(text: str) -> str:
    s = _LABEL.sub("", _EMAIL.sub("", text or ""))
    s = re.sub(r"\(\s*\)|\[\s*\]", "", s)
    s = re.sub(r"\s+([,;.])", r"\1", s)
    s = re.sub(r"([,;])\s*([,;.])", r"\1", s)
    return re.sub(r"\s{2,}", " ", s).strip(" ,;.")


def _fold(s: str) -> str:
    s = "".join(ch for ch in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(ch))
    return re.sub(r"[^a-z]", "", s.lower())


def _orcid(text: str) -> str:
    m = _ORCID.search(text or "")
    if not m:
        return ""
    orcid = "-".join(m.groups()).upper()
    return orcid if orcid_is_valid(orcid) else ""


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _text(e: ET.Element | None, skip: tuple[str, ...] = ("label", "sup")) -> str:
    """The text of an element, without its label (the superscript number of an affiliation)."""
    if e is None:
        return ""
    parts: list[str] = []

    def walk(x: ET.Element) -> None:
        if _local(x.tag) in skip:
            if x.tail:
                parts.append(x.tail)
            return
        if x.text:
            parts.append(x.text)
        for child in x:
            walk(child)
        if x is not e and x.tail:
            parts.append(x.tail)

    walk(e)
    return re.sub(r"\s+", " ", "".join(parts)).strip(" ,;")


def _split_affiliation(aff: ET.Element | None, text: str) -> tuple[str, str]:
    """(organization, address) of an affiliation: from its structured parts when the XML
    has them (<institution>, <addr-line>, <city>, <country>…), else from the text."""
    if aff is not None:
        institutions = [_text(i) for i in aff.iter() if _local(i.tag) == "institution"]
        address = [_text(a) for a in aff.iter()
                   if _local(a.tag) in ("addr-line", "city", "state", "postal-code", "country")]
        if institutions or address:
            return ", ".join(x for x in institutions if x), ", ".join(x for x in address if x)
    segments = [s.strip() for s in re.split(r"[,;]", text) if s.strip()]
    if not segments:
        return "", ""
    orgs = [i for i, s in enumerate(segments) if _ORGANIZATION.search(s)]
    last = orgs[-1] if orgs else 0
    return ", ".join(segments[:last + 1]), ", ".join(segments[last + 1:])


def _person(c: ET.Element) -> tuple[str, str, str]:
    name = c.find("name") if c.find("name") is not None else c.find("name-alternatives/name")
    if name is not None:
        given, family = _text(name.find("given-names"), ()), _text(name.find("surname"), ())
        return given, family, " ".join(x for x in (given, family) if x)
    string = c.find("string-name")
    if string is not None:
        full = _text(string, ())
        return "", full.rsplit(" ", 1)[-1] if full else "", full
    collab = _text(c.find("collab"), ())
    return "", "", collab


def _matches(email: str, given: str, family: str) -> bool:
    """Does an address belong to this person? Its local part names them ("jdoe", "jane.doe",
    "doe.j")."""
    local = _fold(email.split("@", 1)[0])
    f, g = _fold(family), _fold(given)
    return bool(f) and len(f) > 2 and (f in local or (g and local == g[0] + f))


def from_jats(xml: str) -> list[dict[str, Any]]:
    """One row per author (and per address, when an author has several; position 0 for an
    address no author could be tied to)."""
    root = _analyze(xml) if isinstance(xml, str) and xml.strip() else None
    art = None if root is None else (root if _local(root.tag) == "article" else
                                     next((e for e in root.iter() if _local(e.tag) == "article"), None))
    meta = art.find("front/article-meta") if art is not None else None
    if meta is None:
        return []
    affs = {a.get("id"): a for a in meta.iter("aff") if a.get("id")}
    notes = {c.get("id"): c for c in meta.iter("corresp") if c.get("id")}
    for fn in (fn for n in meta.findall("author-notes") for fn in n.iter("fn")):
        if fn.get("id"):
            notes.setdefault(fn.get("id"), fn)
    loose = [a for a in meta.findall("aff")]
    people: list[dict[str, Any]] = []
    note_readers: dict[str, list[int]] = {}
    aff_readers: dict[str, list[int]] = {}
    for group in meta.findall("contrib-group"):
        kind = (group.get("content-type") or "").lower()
        if kind and not kind.startswith("author"):
            continue
        for c in group.findall("contrib"):
            if (c.get("contrib-type") or "author").lower() != "author":
                continue
            given, family, name = _person(c)
            if not name:
                continue
            i = len(people)
            aff_ids, note_ids = [], []
            for x in c.iter("xref"):
                for rid in (x.get("rid") or "").split():
                    if rid in affs:
                        aff_ids.append(rid)
                    if rid in notes:
                        note_ids.append(rid)
            elements = [affs[r] for r in aff_ids] + c.findall("aff") or group.findall("aff") or loose
            texts = [_without_emails(_text(a)) for a in elements]
            organization, address = _split_affiliation(elements[0] if elements else None, texts[0] if texts else "")
            orcid = next((_orcid(x.text or "") for x in c.iter("contrib-id")
                          if "orcid" in ((x.get("contrib-id-type") or "") + (x.text or "")).lower()), "")
            own = [e for x in c.iter() if _local(x.tag) == "email" for e in emails_in(_text(x, ()))]
            people.append({"position": i + 1, "given": given, "family": family, "name": name, "orcid": orcid,
                           "organization": organization, "address": address,
                           "affiliation": " | ".join(t for t in texts if t),
                           "corresponding": (c.get("corresp") or "").lower() == "yes" or bool(note_ids),
                           "emails": own})
            for r in note_ids:
                note_readers.setdefault(r, []).append(i)
            for r in aff_ids:
                aff_readers.setdefault(r, []).append(i)
    orphans: list[str] = []

    def assign(addresses: list[str], readers: list[int]) -> None:
        for e in addresses:
            if any(e in p["emails"] for p in people):
                continue
            owners = [i for i in readers if _matches(e, people[i]["given"], people[i]["family"])]
            if not owners and len(readers) == 1:
                owners = readers
            if not owners:
                owners = [i for i, p in enumerate(people) if _matches(e, p["given"], p["family"])]
            if len(owners) == 1:
                people[owners[0]]["emails"].append(e)
            else:
                orphans.append(e)

    for rid, readers in note_readers.items():
        assign(emails_in(_text(notes[rid], ())), readers)
    for rid, readers in aff_readers.items():
        assign(emails_in(_text(affs[rid], ())), readers)
    # Notes no contributor points to ("* Correspondence: Jane Doe, jane@uni.edu"): by name,
    # else to the only corresponding author.
    pointed = set(note_readers)
    corresponding = [i for i, p in enumerate(people) if p["corresponding"]]
    for rid, note in notes.items():
        if rid not in pointed:
            assign(emails_in(_text(note, ())), corresponding if len(corresponding) == 1 else [])
    for note in meta.iter("corresp"):
        if not note.get("id"):
            assign(emails_in(_text(note, ())), corresponding if len(corresponding) == 1 else [])
    rows = []
    for p in people:
        for e in p.pop("emails") or [""]:
            rows.append({**p, "email": e, "source": "jats"})
    rows += [{"position": 0, "given": "", "family": "", "name": "", "orcid": "", "organization": "",
              "address": "", "affiliation": "", "corresponding": True, "email": e, "source": "jats"}
             for e in dict.fromkeys(orphans) if not any(r["email"] == e for r in rows)]
    return rows


def from_epmc(core: dict | None) -> list[dict[str, Any]]:
    """The authors of a Europe PMC `core` record, with the addresses its affiliations give."""
    authors = ((core or {}).get("authorList") or {}).get("author") or []
    rows = []
    for i, a in enumerate(authors if isinstance(authors, list) else [authors], 1):
        if not isinstance(a, dict):
            continue
        given, family = (a.get("firstName") or "").strip(), (a.get("lastName") or "").strip()
        name = " ".join(x for x in (given, family) if x) or (a.get("fullName") or a.get("collectiveName") or "")
        ids = a.get("authorId")
        orcid = next((_orcid(str(x.get("value", ""))) for x in (ids if isinstance(ids, list) else [ids])
                      if isinstance(x, dict) and str(x.get("type", "")).upper() == "ORCID"), "")
        details = ((a.get("authorAffiliationDetailsList") or {}).get("authorAffiliation")) or []
        raw = [str(d.get("affiliation", "")) for d in (details if isinstance(details, list) else [details])
               if isinstance(d, dict)]
        texts = [t for t in (_without_emails(r) for r in raw) if t]
        organization, address = _split_affiliation(None, texts[0] if texts else "")
        emails = [e for r in raw for e in emails_in(r)]
        base = {"position": i, "given": given, "family": family, "name": name, "orcid": orcid,
                "organization": organization, "address": address, "affiliation": " | ".join(texts),
                "corresponding": False, "source": "epmc"}
        rows += [{**base, "email": e} for e in dict.fromkeys(emails)] or [{**base, "email": ""}]
    return rows


def merge(jats: list[dict[str, Any]], epmc: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The JATS rows, completed by Europe PMC's (same position and family name): missing
    addresses, ORCIDs and affiliations; Europe PMC's rows alone when the JATS has none."""
    if not jats:
        return epmc
    out = [dict(r) for r in jats]
    for e in epmc:
        same = [r for r in out if r["position"] == e["position"] and _fold(r["family"]) == _fold(e["family"])]
        if not same:
            continue
        for r in same:
            for key in ("orcid", "organization", "address", "affiliation"):
                if not r[key] and e[key]:
                    r[key] = e[key]
                    r["source"] = "jats+epmc"
        if e["email"] and not any(r["email"] == e["email"] for r in out):
            blank = next((r for r in same if not r["email"]), None)
            if blank is not None:
                blank["email"], blank["source"] = e["email"], "jats+epmc"
            else:
                out.append({**same[0], "email": e["email"], "source": "jats+epmc"})
    return out


def write(con: sqlite3.Connection, article_id: str, rows: list[dict[str, Any]], now: float | None = None) -> int:
    """Replace the paper's contact rows."""
    now = now or time.time()
    con.execute("DELETE FROM contact WHERE article_id = ?", (article_id,))
    con.executemany(
        "INSERT OR REPLACE INTO contact (article_id, position, email, given, family, name, orcid, organization, "
        "address, affiliation, corresponding, source, found_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(article_id, r["position"], r["email"], r["given"], r["family"], r["name"], r["orcid"],
          r["organization"], r["address"], r["affiliation"], int(bool(r["corresponding"])), r["source"], now)
         for r in rows])
    return len(rows)


COLUMNS = ("doi", "article_id", "title", "journal", "published", "position", "given", "family", "name",
           "orcid", "email", "organization", "address", "affiliation", "corresponding", "source")


def table(con: sqlite3.Connection) -> list[dict[str, Any]]:
    """Every contact row with its paper's DOI, title, journal and date."""
    rows = con.execute(
        "SELECT a.doi, c.article_id, a.title, a.journal, a.published, c.position, c.given, c.family, c.name, "
        "c.orcid, c.email, c.organization, c.address, c.affiliation, c.corresponding, c.source "
        "FROM contact c JOIN article a ON a.id = c.article_id ORDER BY a.published DESC, c.article_id, c.position")
    return [dict(zip(COLUMNS, r)) for r in rows]


CARD = """---
license: other
pretty_name: {platform} — authors' contact details (private)
tags:
- private
---

# {platform}: the authors' contact details — PRIVATE

For each author of each paper the registry read: given and family names, ORCID,
organization, address, affiliation and email, with the paper's DOI, title, journal and date
— as published in the paper itself (JATS full text) and in its Europe PMC record.

- **Purpose**: to cite the authors of the code and to reach them about their own work (their
  tracing map, a correction, a takedown). No mass email.
- **Personal data** (GDPR): this dataset must stay **private**. The publisher refuses to send
  it to a dataset that is not. An author may ask for their data to be erased:
  https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR-/issues
- `contacts.parquet`: {rows:,} rows, {papers:,} papers, {emails:,} email addresses
  (generated {date}).
"""


def build(con: sqlite3.Connection, folder: Path, *, platform: str = "OSCR") -> dict[str, int]:
    """Write contacts.parquet and the card into `folder` (a private folder of the Mac)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    rows = table(con)
    data = {c: [r[c] for r in rows] for c in COLUMNS}
    data["corresponding"] = [bool(v) for v in data["corresponding"]]
    pq.write_table(pa.table(data), folder / "contacts.parquet", compression="zstd")
    counts = {"rows": len(rows), "papers": len({r["article_id"] for r in rows}),
              "emails": len({r["email"] for r in rows if r["email"]})}
    (folder / "README.md").write_text(CARD.format(platform=platform, date=time.strftime("%Y-%m-%d"), **counts))
    return counts


def publish(con: sqlite3.Connection, folder: Path, dataset: str = DATASET, *, platform: str = "OSCR",
            dry_run: bool = False) -> str:
    """Build, check that `dataset` is PRIVATE, then send. Refuses a dataset that is public
    (or that cannot be checked)."""
    from huggingface_hub import HfApi

    from .scriptstore import token
    counts = build(con, folder, platform=platform)
    api = HfApi(token=token())
    info = api.dataset_info(dataset)
    if info.private is not True:
        raise SystemExit(f"refusing to send personal data: {dataset} is not a private dataset")
    if dry_run:
        return f"dry run: {counts['rows']} rows ({counts['emails']} emails) ready for {dataset} (private)"
    api.upload_folder(folder_path=str(folder), repo_id=dataset, repo_type="dataset",
                      allow_patterns=["contacts.parquet", "README.md"],
                      commit_message=f"Contacts of {time.strftime('%Y-%m-%d')}: {counts['rows']} rows")
    return f"{counts['rows']} rows ({counts['emails']} emails, {counts['papers']} papers) → {dataset} (private)"


def summary(con: sqlite3.Connection) -> str:
    q = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
    return json.dumps({
        "rows": q("SELECT COUNT(*) FROM contact"),
        "papers": q("SELECT COUNT(DISTINCT article_id) FROM contact"),
        "emails": q("SELECT COUNT(DISTINCT email) FROM contact WHERE email != ''"),
        "authors_with_email": q("SELECT COUNT(*) FROM contact WHERE email != '' AND position > 0"),
        "unclaimed_emails": q("SELECT COUNT(*) FROM contact WHERE position = 0"),
        "with_organization": q("SELECT COUNT(*) FROM contact WHERE organization != ''"),
        "with_address": q("SELECT COUNT(*) FROM contact WHERE address != ''"),
    })
