"""The harvest: scan papers, verify their repositories, conclude, import, align.

A paper goes through five steps, each written to the database before the next — an
interrupted pass resumes where it stopped:

1. READ. The JATS full text (Europe PMC), else nothing; always the DataCite
   metadata; Crossref when there is no text.
2. JUDGE. Every link gets a role (`role.py`) and the best verdict per repository
   is kept (`find.py`).
3. VERIFY. Repositories that may hold code are queried (`repos.py`) — once per
   repository, re-verified every 30 days.
4. CONCLUDE. Verification may correct the text, and says so: a "data" repository
   holding 50 Python scripts carries code; a Zenodo "dataset" record without a
   single script does not. Then the paper's status and its library rows.
5. ALIGN. For a paper whose code text is stored, which paragraph matches which
   lines (`align.py`), for the Code ↔ Paper reader.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from . import db, find, jats, library, links, methods, repos
from .net import Client, Outage, Unavailable
from .sources import europepmc, forges, metadata


@dataclass
class Options:
    db: Path = Path("data/oscr.db")
    cache: Path = Path("data/cache")
    clones: Path = Path("data/clones")
    library: Path = Path("library")
    verify: bool = True
    metadata: bool = True
    swh: bool = True
    snapshots: bool = False
    #: Fetch the TEXT of the scripts into the `file` table (the reader, the exports).
    contents: bool = True
    #: The GitHub "DOI in README" search: 10 requests/min without a token, 30 with
    #: one. By default, only when a token is there.
    github_search: bool = field(default_factory=lambda: bool(os.environ.get("GITHUB_TOKEN")))
    reverify_after_days: int = 30
    #: Promotion threshold: a "data" repository holding at least this many scripts,
    #: and at least 20% scripts among its files, carries code.
    scripts_to_promote: int = 5
    #: Write `library/<paper>/record.json`, for a GitHub repository that versions the
    #: library. The Mac's harvester does without: the database is the reference, and
    #: 600,000 one-file folders would help nobody.
    records: bool = True
    #: Compute the paper ↔ code matches of papers whose code text is stored.
    align: bool = True
    #: Phase 1: build the paper's enriched record (bibliography, people, subjects,
    #: categories, datasets) and describe its repositories (features, tools).
    enrich: bool = True


@dataclass
class Tally:
    articles: int = 0
    with_code: int = 0
    verified: int = 0
    errors: int = 0
    statuses: dict[str, int] = field(default_factory=dict)
    #: The pass stopped on its deadline, not at the end of the query.
    interrupted: bool = False

    def __str__(self) -> str:
        s = ", ".join(f"{k} {v}" for k, v in sorted(self.statuses.items(), key=lambda kv: -kv[1]))
        return (f"{self.articles} papers, {self.with_code} with the authors' code, "
                f"{self.verified} repositories verified, {self.errors} errors — {s}")


def _family_names(authors: list[str]) -> list[str]:
    """"Smith J" → "Smith" (Europe PMC writes `fullName` that way)."""
    out = []
    for a in authors:
        parts = a.replace(",", " ").split()
        if len(parts) >= 2 and re.fullmatch(r"[A-Z]{1,3}", parts[-1]):
            out.append(" ".join(parts[:-1]))
        elif parts:
            out.append(parts[0])
    return out


def scan_article(con: sqlite3.Connection, client: Client, art: europepmc.EpmcArticle,
                 opts: Options, xml: str | None = None, tally: Tally | None = None) -> str:
    db.save_article(con, art.as_dict())
    # Never hold the database's write lock across a network call: the nightly publication
    # and the enrichment write too, and waited in vain behind a Zenodo rate-limit pause
    # ("database is locked", 2026-09-27).
    con.commit()
    if xml is None and art.fulltext_id:
        try:
            xml = europepmc.fulltext(client, art.fulltext_id)
        except Unavailable as e:
            # Logged, so that `oscr doi` can take the paper up again once the document is fixed.
            db.log_event(con, "fulltext_unavailable", article=art.id, error=str(e))
    families: list[str] = []
    names: list[str] = []
    if xml:
        text = jats.parse(xml)
        findings = find.from_text(text)
        authors = text.authors or _family_names(art.authors)
        title = text.title or art.title
        families, names = methods.recognize(text.methods)
        if not art.doi and text.doi:
            art.doi = text.doi
    else:
        findings = find.Findings()
        authors = _family_names(art.authors)
        title = art.title
    if opts.metadata and art.doi:
        mentions = metadata.datacite_mentions(client, art.doi)
        if not xml:
            msg = metadata.crossref(client, art.doi)
            mentions += metadata.crossref_mentions(msg)
            authors = authors or metadata.crossref_authors(msg)
            title = title or " ".join(msg.get("title", []))
        if opts.github_search:
            mentions += forges.github_mentions(client, art.doi, authors)
        mentions += forges.huggingface_mentions(client, forges.arxiv_id(art.doi))
        if mentions:
            findings.candidates = find.merge(
                findings.candidates, find.from_metadata(mentions, authors, title))
    db.replace_links(con, art.id, findings.candidates)
    db.mark_scanned(con, art.id, has_fulltext=bool(xml), has_statement=findings.has_statement,
                    code_on_request=findings.code_on_request,
                    data_on_request=findings.data_on_request, families=families, methods=names)
    con.commit()
    if opts.verify:
        n = verify_article(con, client, art.id, opts)
        if tally is not None:
            tally.verified += n
    status = conclude(con, art.id, opts)
    if art.core:
        # The `core` result every pass receives: kept since Phase 1 (MeSH, grants, ORCIDs…).
        con.execute("INSERT OR REPLACE INTO epmc_record (article_id, json, fetched_at) VALUES (?, ?, ?)",
                    (art.id, json.dumps(art.core, ensure_ascii=False), time.time()))
    con.commit()
    if opts.align and xml and status.startswith("code_"):
        _align_quietly(con, client, art.id, xml)
    if opts.enrich:
        _enrich_quietly(con, art.id, xml, art.core or None)
    return status


def _enrich_quietly(con: sqlite3.Connection, article_id: str, xml: str | None, core: dict | None) -> None:
    """The enriched record is a bonus: a failure is logged, it never costs the paper its scan."""
    from . import enrich
    try:
        enrich.enrich_article(con, article_id, xml=xml, core=core)
        con.commit()
    except Exception as e:
        con.rollback()
        db.log_event(con, "enrich_error", article=article_id, error=f"{type(e).__name__}: {e}"[:300])
        con.commit()


def _should_verify(role: str, kind: str) -> bool:
    """What may hold the authors' code is verified; third-party tools are not."""
    if role == "third_party_tool":
        return False
    if role == "code":
        return True
    return kind in ("forge", "archive", "execution", "model")


def verify_article(con: sqlite3.Connection, client: Client, article_id: str, opts: Options) -> int:
    a = dict(con.execute("SELECT doi, title FROM article WHERE id = ?", (article_id,)).fetchone())
    done = 0
    rows = con.execute("SELECT l.*, r.verified_at, r.state FROM link l JOIN repository r "
                       "ON r.repo = l.repo WHERE l.article_id = ?", (article_id,)).fetchall()
    for l in rows:
        if not _should_verify(l["role"], l["kind"]):
            continue
        if not _fresh(l, opts):
            # An attached file ("elife-98759-code1.zip") is not an address: once
            # normalized, ".zip" passed for a domain and was queried 8 times in vain.
            link = None if l["kind"] == "supplementary" else links.normalize(l["url"])
            if link is None:
                link = links.Link(l["url"], l["repo"], l["host"], l["kind"],
                                  identifier=l["repo"].split("/", 1)[-1])
            db.save_repository(con, l["repo"], _verify_one(client, link, a, opts))
            con.commit()      # before the next network call (see scan_article)
            done += 1
        # The Zenodo record names the GitHub repository the archive comes from: it is
        # added with the same role at EVERY reading of the paper — whether the record
        # was just verified or not. Added only at verification time, a new scan lost
        # it (measured 2026-09-25).
        d = con.execute("SELECT linked_to FROM repository WHERE repo = ?", (l["repo"],)).fetchone()
        source = (d["linked_to"] if d else "") or ""
        source_link = links.normalize(source) if source else None
        # The source of an archive: the GitHub of a Zenodo record, or the companion
        # Zenodo software of a Dryad DOI.
        if source_link and source_link.repo != l["repo"] and (
                source_link.is_git_repo or source_link.repo.startswith("zenodo:")):
            if not con.execute("SELECT 1 FROM link WHERE article_id=? AND repo=?",
                               (article_id, source_link.repo)).fetchone():
                con.execute(
                    "INSERT INTO link (article_id, repo, url, host, kind, role, confidence, margin, "
                    "found_by, section, reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (article_id, source_link.repo, source_link.url, source_link.host, source_link.kind,
                     l["role"], l["confidence"], l["margin"],
                     "dryad:software" if l["repo"].startswith("doi:10.5061/dryad") else "zenodo:source",
                     l["section"], json.dumps([f"source declared by the record of {l['repo']}"],
                                              ensure_ascii=False)))
                con.execute("INSERT OR IGNORE INTO repository (repo, url, host, kind) VALUES (?,?,?,?)",
                            (source_link.repo, source_link.url, source_link.host, source_link.kind))
            ds = con.execute("SELECT verified_at, state FROM repository WHERE repo = ?",
                             (source_link.repo,)).fetchone()
            if not _fresh(ds, opts):
                db.save_repository(con, source_link.repo, _verify_one(client, source_link, a, opts))
                done += 1
        con.commit()
    return done


def _fresh(row: sqlite3.Row | None, opts: Options) -> bool:
    """Verified less than `reverify_after_days` days ago, and not failing."""
    return bool(row is not None and row["verified_at"]
                and time.time() - row["verified_at"] < opts.reverify_after_days * 86400
                and row["state"] not in ("unreachable", "unverified"))


def _verify_one(client: Client, link: links.Link, article: dict[str, Any], opts: Options) -> dict[str, Any]:
    try:
        return repos.verify(client, link, article, opts.clones, swh=opts.swh, with_contents=opts.contents)
    except Exception as e:  # a failed verification must not kill the pass
        return {"state": "unreachable", "error": f"{type(e).__name__}: {e}"[:300]}


def _adjust(con: sqlite3.Connection, article_id: str, l: sqlite3.Row, d: sqlite3.Row | None,
            opts: Options, published: str) -> str:
    """What verification changes to the role read in the text. Returns the final role."""
    role = l["role"]
    if d is None or d["state"] != "alive":
        return role
    new, why = role, ""
    n = d["n_scripts"]
    n_files = d["n_files"] or 0
    # A code repository means scripts AND a real share of scripts: a BIDS dataset of
    # 2,141 files carrying 3 conversion scripts is not one.
    many = (n or 0) >= opts.scripts_to_promote and ((n or 0) >= 20 or (n or 0) / max(1, n_files) >= 0.2)
    if role in ("data", "unknown") and l["kind"] == "forge" and many and d["resource_type"] != "bids":
        new, why = "code", f"code+ the repository holds {n} scripts out of {n_files} files"
    elif role in ("data", "unknown") and d["resource_type"] == "software":
        new, why = "code", 'code+ the archive record says "software"'
    elif role == "code" and d["resource_type"] in ("dataset", "osf-data") and n == 0:
        new, why = "data", "data+ the archive is a dataset without a single script"
    elif role == "code" and d["resource_type"] == "bids" and (n or 0) < 20:
        new, why = "data", f"data+ the repository is a BIDS dataset ({n or 0} scripts)"
    elif role == "code" and (d["stars"] or 0) >= 500 and d["created"] and published \
            and d["created"] < _one_year_before(published) and d["cites_article"] == "":
        new, why = "third_party_tool", (f"third_party_tool+ {d['stars']} stars, created on "
                                        f"{d['created']}, long before the paper")
    if new != role:
        reasons = json.loads(l["reasons"] or "[]") + [why]
        con.execute("UPDATE link SET role=?, reasons=? WHERE article_id=? AND repo=?",
                    (new, json.dumps(reasons, ensure_ascii=False), article_id, l["repo"]))
    return new


def _one_year_before(published: str) -> str:
    try:
        return (date.fromisoformat(published[:10]) - timedelta(days=365)).isoformat()
    except ValueError:
        return ""


def conclude(con: sqlite3.Connection, article_id: str, opts: Options) -> str:
    a = con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone()
    rows = con.execute("SELECT * FROM link WHERE article_id = ?", (article_id,)).fetchall()
    code: list[tuple[sqlite3.Row, sqlite3.Row | None]] = []
    has_data = False
    for l in rows:
        d = con.execute("SELECT * FROM repository WHERE repo = ?", (l["repo"],)).fetchone()
        role = _adjust(con, article_id, l, d, opts, a["published"])
        if role == "code":
            code.append((l, d))
        elif role == "data":
            has_data = True

    con.execute("DELETE FROM script WHERE article_id = ? AND origin = 'native'", (article_id,))
    states = []
    for l, d in code:
        state = d["state"] if d is not None else "unverified"
        # Alive but without a single recognized script (`megabtaufdg`: a README and an
        # extension-less file): the repository exists, the announced code is not there
        # yet. A ZIP (unknown count) or a "software" record pass.
        if state == "alive" and d is not None and d["n_scripts"] == 0 \
                and d["resource_type"] != "software" and l["kind"] not in ("execution", "model"):
            state = "empty"
        states.append(state)
        if state in ("alive", "empty") and d["n_files"] is not None:
            level = "inventoried"
        elif state in ("alive", "empty"):
            level = "alive"
        else:
            level = "found"
        con.execute("INSERT INTO script (article_id, origin, repo, level, commit_id) "
                    "VALUES (?, 'native', ?, ?, ?)",
                    (article_id, l["repo"], level, (d["commit_id"] if d is not None else "") or ""))

    if any(s == "alive" for s in states):
        status = "code_verified"
    elif any(s in ("unverified", "unverifiable", "unreachable") for s in states):
        status = "code_found"
    elif any(s == "empty" for s in states):
        status = "code_empty"
    elif states:
        status = "code_dead"
    elif a["code_on_request"]:
        status = "on_request"
    elif has_data:
        status = "data_only"
    elif not a["has_fulltext"]:
        status = "no_fulltext"
    else:
        status = "none"
    con.execute("UPDATE article SET status = ?, updated_at = ? WHERE id = ?", (status, time.time(), article_id))
    if opts.snapshots:
        for l, d in code:
            if d is not None and d["state"] == "alive":
                link = links.normalize(l["url"])
                if link is not None and link.is_git_repo:
                    library.snapshot(con, article_id, l["repo"], link.git_url, opts.library, opts.clones)
    if opts.records:
        library.write_record(con, article_id, opts.library)
    return status


def align_article(con: sqlite3.Connection, client: Client, article_id: str, *,
                  xml: str | None = None) -> int:
    """Compute the paper ↔ code matches of a paper whose code text is stored. The full
    text comes from the cache (kept forever) unless given. Returns the number of pairs."""
    from . import align
    files = [dict(repo=f["repo"], path=f["path"], language=f["language"], text=f["text"]) for f in con.execute(
        "SELECT DISTINCT f.repo, f.path, f.language, f.text FROM file f JOIN link l ON l.repo = f.repo "
        "WHERE l.article_id = ? AND l.role = 'code' AND f.kind = 'script' AND f.text IS NOT NULL",
        (article_id,))]
    if not files:
        con.execute("DELETE FROM alignment WHERE article_id = ?", (article_id,))
        return 0
    if xml is None:
        a = con.execute("SELECT fulltext_id, pmcid FROM article WHERE id = ?", (article_id,)).fetchone()
        fulltext_id = (a["fulltext_id"] or a["pmcid"]) if a else ""
        xml = europepmc.fulltext(client, fulltext_id) if fulltext_id else None
    if not xml:
        return 0
    return db.save_alignment(con, article_id, align.align(xml, files), align.METHOD)


def _align_quietly(con: sqlite3.Connection, client: Client, article_id: str, xml: str | None = None) -> None:
    """Matches are a bonus: a failure is logged, it never costs the paper its scan."""
    try:
        align_article(con, client, article_id, xml=xml)
        con.commit()
    except Outage:
        raise
    except Exception as e:
        con.rollback()
        db.log_event(con, "alignment_error", article=article_id, error=f"{type(e).__name__}: {e}"[:300])
        con.commit()


def align_pending(con: sqlite3.Connection, client: Client, *, force: bool = False,
                  deadline: float | None = None, report: Callable[[str], None] = print) -> int:
    """Compute the matches of papers with stored code text that have none yet — or
    that were computed by another method, or all of them with `force`."""
    from . import align
    ids = [r["id"] for r in con.execute(
        "SELECT a.id FROM article a WHERE a.status LIKE 'code_%' AND EXISTS (SELECT 1 FROM link l "
        "JOIN file f ON f.repo = l.repo WHERE l.article_id = a.id AND l.role = 'code' AND f.kind = 'script' "
        "AND f.text IS NOT NULL) AND (? OR NOT EXISTS (SELECT 1 FROM alignment x WHERE x.article_id = a.id "
        "AND x.method = ?)) ORDER BY a.published DESC", (int(force), align.METHOD))]
    done = 0
    for i in ids:
        if deadline is not None and time.time() >= deadline:
            break
        _align_quietly(con, client, i)
        done += 1
        if done % 25 == 0:
            report(f"  … {done} papers aligned")
    return done


def scan_query(con: sqlite3.Connection, client: Client, q: str, opts: Options, *,
               maximum: int | None = None, already: str = "skip", deadline: float | None = None,
               report: Callable[[str], None] = print) -> Tally:
    """Scan every paper of a Europe PMC query — or until `deadline` (a timestamp), so
    that a scheduled pass hands back control on time."""
    tally = Tally()
    for art in europepmc.iterate(client, q, maximum=maximum):
        if deadline is not None and time.time() >= deadline:
            tally.interrupted = True
            break
        seen = con.execute("SELECT scanned_at FROM article WHERE id = ?", (art.id,)).fetchone()
        if seen and seen["scanned_at"] and already == "skip":
            continue
        try:
            status = scan_article(con, client, art, opts, tally=tally)
        except Outage:
            # The network, not the paper: stop the pass instead of failing it paper
            # by paper (each would cost 4 attempts).
            con.rollback()
            raise
        except Exception as e:
            tally.errors += 1
            db.log_event(con, "article_error", article=art.id, error=f"{type(e).__name__}: {e}")
            con.commit()
            report(f"  ! {art.id}: {type(e).__name__}: {e}")
            continue
        tally.articles += 1
        tally.statuses[status] = tally.statuses.get(status, 0) + 1
        if status.startswith("code_"):
            tally.with_code += 1
        if tally.articles % 25 == 0:
            report(f"  … {tally}")
    return tally


def run_pass(con: sqlite3.Connection, client: Client, domain: str, opts: Options, *,
             initial_days: int = 7, maximum: int | None = None,
             report: Callable[[str], None] = print) -> Tally:
    """The incremental pass: from the last date seen until today.

    The cursor is the first-publication date of the last pass; the pass restarts
    three days BEFORE it, because Europe PMC indexes with a few days of delay and a
    paper already seen is skipped at no cost.
    """
    key = f"europepmc:{domain}"
    today = date.today()
    since = db.cursor(con, key, (today - timedelta(days=initial_days)).isoformat())
    since = (date.fromisoformat(since) - timedelta(days=3)).isoformat()
    q = europepmc.query(domain, since, today.isoformat())
    report(f"Europe PMC \"{domain}\" from {since} to {today.isoformat()}")
    tally = scan_query(con, client, q, opts, maximum=maximum, report=report)
    db.set_cursor(con, key, today.isoformat())
    db.log_event(con, "pass", domain=domain, since=since, articles=tally.articles,
                 with_code=tally.with_code, errors=tally.errors, requests=client.requests)
    con.commit()
    return tally


def _previous_month(month: str) -> str:
    y, m = map(int, month.split("-"))
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def _month_bounds(month: str) -> tuple[str, str]:
    y, m = map(int, month.split("-"))
    end = date(y + (m == 12), 1 if m == 12 else m + 1, 1) - timedelta(days=1)
    return f"{month}-01", end.isoformat()


def backfill(con: sqlite3.Connection, client: Client, domain: str, opts: Options, *,
             max_duration_s: float, back_to: int = 2000,
             report: Callable[[str], None] = print) -> Tally:
    """The BACKFILL of the stock: walk back into the past, month by month, within a
    time budget.

    The daily pass follows the flow (~200 neuro papers a day in 2025); the stock holds
    614,336 open-access neuro papers (measured 2026-09-26). It is taken in slices: each
    pass gives at most `max_duration_s` to the past, starting from the most recent
    month not done, and notes where it stopped (cursor `backfill:<domain>`). An
    interrupted month resumes at the next pass; its papers already read are skipped at
    no cost.
    """
    key = f"backfill:{domain}"
    today = date.today()
    # The CURRENT month, not the previous one: the new-papers pass only goes back 7
    # days, and the beginning of the month fell between the two. Papers already read
    # by the new-papers pass are skipped at no cost.
    month = db.cursor(con, key, f"{today.year}-{today.month:02d}")
    deadline = time.time() + max_duration_s
    total = Tally()
    while month >= f"{back_to}-01" and time.time() < deadline:
        start, end = _month_bounds(month)
        # Noted from the start: the dashboard shows the month in progress.
        db.set_cursor(con, key, month)
        con.commit()
        report(f"Backfill \"{domain}\": {month}")
        t = scan_query(con, client, europepmc.query(domain, start, end), opts, deadline=deadline, report=report)
        total.articles += t.articles
        total.with_code += t.with_code
        total.verified += t.verified
        total.errors += t.errors
        for k, v in t.statuses.items():
            total.statuses[k] = total.statuses.get(k, 0) + v
        if t.interrupted:
            total.interrupted = True
            break
        month = _previous_month(month)
        db.set_cursor(con, key, month)
        con.commit()
    db.log_event(con, "backfill", domain=domain, until=month, articles=total.articles,
                 with_code=total.with_code, errors=total.errors, done=month < f"{back_to}-01")
    con.commit()
    return total


def backfill_done(con: sqlite3.Connection, domain: str, back_to: int) -> bool:
    month = db.cursor(con, f"backfill:{domain}", "")
    return bool(month) and month < f"{back_to}-01"


def reverify(con: sqlite3.Connection, client: Client, opts: Options, *,
             maximum: int | None = None, deadline: float | None = None) -> int:
    """Re-verify the code repositories that are stale (more than `reverify_after_days`
    days) or were left unreachable — an outage during verification must not leave them
    failing forever. Returns the number of papers taken up again."""
    ids = [r["id"] for r in con.execute(
        "SELECT DISTINCT l.article_id AS id FROM link l JOIN repository r ON r.repo = l.repo "
        "WHERE l.role != 'third_party_tool' AND (l.role = 'code' OR l.kind IN "
        "('forge', 'archive', 'execution', 'model')) "
        "AND (r.state IN ('unverified', 'unreachable') OR r.verified_at < ?)",
        (time.time() - opts.reverify_after_days * 86400,))]
    done = 0
    for i in ids[: maximum or None]:
        if deadline is not None and time.time() >= deadline:
            break
        verify_article(con, client, i, opts)
        status = conclude(con, i, opts)
        con.commit()
        if opts.align and status.startswith("code_"):
            _align_quietly(con, client, i)
        done += 1
    return done


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M")


def watch(con: sqlite3.Connection, client: Client, domain: str, opts: Options, *,
          news_s: float = 3600, slice_s: float = 1800, idle_s: float = 900,
          reverification_s: float = 86400, back_to: int = 2000,
          max_duration_s: float | None = None, iterations: int | None = None,
          report: Callable[[str], None] = print) -> None:
    """The WATCH: the harvester running continuously, on a machine with no quota of hours.

    A loop, which launchd files as a background task:

    - every `news_s`: the papers published since the last pass;
    - once per `reverification_s`: the stale or unreachable code repositories, then the
      papers whose matches are missing, each within a time slice;
    - in between: a `slice_s` slice of the stock, month by month into the past, resumed
      where the previous one stopped;
    - once the stock is done: an `idle_s` nap between two looks at the new papers. The
      process then does almost nothing.

    An outage (network down, Mac waking up, overloaded server) does not stop the watch:
    it waits, from 2 minutes to 1 hour, and resumes; after two hours of outages it stops
    and launchd starts a fresh one. Nothing is lost when it stops: each paper is written
    in its own transaction, and the cursors say where to resume. After `max_duration_s`
    it hands back control (launchd restarts it): a Python process's memory does not
    swell over weeks.
    """
    start = time.time()
    last_news = 0.0
    outages = 0
    rounds = 0
    errors_only = lambda m: m.startswith("  !") and report(m)  # noqa: E731 — errors only
    while iterations is None or rounds < iterations:
        if max_duration_s is not None and time.time() - start >= max_duration_s:
            report(f"{_now()} end of cycle ({max_duration_s / 3600:.0f} h): launchd restarts the watch")
            return
        rounds += 1
        try:
            if time.time() - last_news >= news_s:
                client.requests.clear()
                t = run_pass(con, client, domain, opts, report=errors_only)
                last_news = time.time()
                report(f"{_now()} new papers: {t}")
            if time.time() - float(db.cursor(con, "watch:reverification", "0")) >= reverification_s:
                n = reverify(con, client, opts, deadline=time.time() + slice_s)
                aligned = align_pending(con, client, deadline=time.time() + slice_s,
                                        report=lambda _: None) if opts.align else 0
                db.set_cursor(con, "watch:reverification", str(time.time()))
                con.commit()
                report(f"{_now()} re-verification: {n} papers taken up again, {aligned} aligned")
            if backfill_done(con, domain, back_to):
                time.sleep(idle_s)
            else:
                client.requests.clear()
                t = backfill(con, client, domain, opts, max_duration_s=slice_s, back_to=back_to,
                             report=errors_only)
                month = db.cursor(con, f"backfill:{domain}", "")
                report(f"{_now()} stock (resuming at {month}): {t}")
            outages = 0
        except Exception as e:  # an outage must not kill the watch…
            try:
                con.rollback()
            except sqlite3.Error:
                pass
            outages += 1
            # An nginx error page fits on one line once its tags are removed.
            brief = " ".join(re.sub(r"<[^>]*(>|$)", " ", str(e)).split())[:160]
            if outages > 6:
                # …unless it lasts two hours (the disk unplugged, a defect): a fresh
                # process, restarted by launchd, starts clean.
                report(f"{_now()} ! {outages} outages in a row, stopping: {type(e).__name__}: {brief}")
                raise
            wait = min(3600, 60 * 2 ** outages)
            report(f"{_now()} ! {type(e).__name__}: {brief} — resuming in {wait // 60:.0f} min")
            time.sleep(wait)


def scan_folder(con: sqlite3.Connection, client: Client, folder: Path, opts: Options,
                report: Callable[[str], None] = print) -> Tally:
    """Scan JATS files already on disk (test corpus, benchmark)."""
    tally = Tally()
    for f in sorted(Path(folder).glob("*.xml")):
        xml = f.read_text()
        t = jats.parse(xml)
        pmcid = t.pmcid or (f.stem if f.stem.upper().startswith("PMC") else "")
        art = europepmc.EpmcArticle(id=europepmc.identifier(t.doi, pmcid, f.stem), doi=t.doi, pmcid=pmcid,
                                    fulltext_id=pmcid, title=t.title, published=t.year, source=f"file:{f.name}")
        status = scan_article(con, client, art, opts, xml=xml, tally=tally)
        tally.articles += 1
        tally.statuses[status] = tally.statuses.get(status, 0) + 1
        tally.with_code += status.startswith("code_")
    return tally
