"""The registry's links where researchers already read (docs/BADGE_OUTREACH.md): the files each partner
reads, rebuilt every night into `data/outreach/`, for the owner to send or to point a partner to. One
function per partner, and the Software Heritage step, off unless the owner turns it on.

- `scilite`: Europe PMC Annotations, one JSON object per article (their submission format: `src`,
  `id`, `provider`, `anns`). Each annotation is anchored on the code link itself, as the paper writes
  it, never on the sentence around it (CLAUDE.md: the sentences that decided a link's verdict stay
  private), and only for a paper whose licence lets its statement be shown (catalog.
  statement_is_publishable: CC BY, CC0, CC BY-SA, CC BY-NC).
- `scholix`: the paper-to-software links as Scholix records (JSON), for OpenAIRE's ScholeXplorer.
- `mixnmatch`: the papers with a page as a Mix'n'match catalogue (id, name, description), for the
  Wikidata identifier the owner proposes. Nothing is written to Wikidata.
- `journals`: one CSV per journal the owner writes to (DOI, the paper's page), for the letters.
- `swh`: Software Heritage's "Save code now" for the public repositories linked from a paper with a
  page, never archived or not asked for in 90 days, anonymous, a few a night, stopping at the first
  refusal or spent rate limit. Off unless `OSCR_SWH=1` (the owner's decision; CLAUDE.md says Software
  Heritage is asked on a person's request until the owner changes it).

Nothing here writes to an author's repository, sends a message or names a person: no author, no
email address, no excerpt leaves. A repository or a paper a removal request withheld is left out."""
from __future__ import annotations

import csv
import gzip
import io
import json
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

from . import catalog
from .entities import PAGES_SQL
from .linkfeeds import clean_ids

#: The journals the owner writes to, by the name the records give (a prefix, case ignored).
JOURNALS: dict[str, tuple[str, ...]] = {
    "elife": ("elife",),
    "eneuro": ("eneuro",),
    "plos-computational-biology": ("plos computational biology", "plos comput"),
    "imaging-neuroscience": ("imaging neuroscience",),
    "frontiers": ("frontiers in ",),
}

#: Software Heritage's save request for a git repository, and how often one repository is asked.
SWH_SAVE = "https://archive.softwareheritage.org/api/1/origin/save/git/url/{url}/"
SWH_AGAIN_DAYS = 90
SWH_PER_NIGHT = 10

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _text(s: str | None) -> str:
    return " ".join(_CONTROL.sub(" ", s or "").split())


def _page(origin: str, article_id: str) -> str:
    return f"{origin.rstrip('/')}/paper/{catalog.slug(article_id)}/"


def _pages(con: sqlite3.Connection) -> list[sqlite3.Row]:
    return con.execute(f"SELECT id, doi, pmid, pmcid, title, journal, license FROM article WHERE id IN ({PAGES_SQL}) "
                       "ORDER BY id").fetchall()


def _code_links(con: sqlite3.Connection) -> dict[str, list[sqlite3.Row]]:
    held = catalog.withheld(con)
    out: dict[str, list[sqlite3.Row]] = {}
    for r in con.execute(f"SELECT l.article_id, l.repo, l.url, l.section, l.excerpt, r.url AS repo_url, r.state, r.kind, "
                         f"r.swh_archived FROM link l LEFT JOIN repository r ON r.repo = l.repo "
                         f"WHERE l.role = 'code' AND l.article_id IN ({PAGES_SQL}) ORDER BY l.article_id, l.repo"):
        if r["repo"] in held.repos:
            continue
        out.setdefault(r["article_id"], []).append(r)
    return out


def exact_in(excerpt: str, url: str) -> str:
    """The code link as the paper writes it, found in its sentence: the address, with or without its
    scheme or a trailing slash, case kept as written. "" when the sentence does not hold it."""
    bare = re.sub(r"^https?://", "", url).rstrip("/")
    for candidate in (url, url.rstrip("/"), bare, re.sub(r"^www\.", "", bare)):
        if not candidate:
            continue
        i = excerpt.lower().find(candidate.lower())
        if i >= 0:
            return excerpt[i:i + len(candidate)]
    return ""


def scilite(con: sqlite3.Connection, origin: str, name: str) -> list[dict]:
    """Europe PMC Annotations: per article with a PMCID and an open licence, its code links."""
    links = _code_links(con)
    out = []
    for a in _pages(con):
        _, _, pmcid = clean_ids(a["doi"], a["pmid"], a["pmcid"])
        if not pmcid or not catalog.statement_is_publishable(a["license"] or ""):
            continue
        anns = []
        for l in links.get(a["id"], []):
            exact = exact_in(l["excerpt"] or "", l["url"])
            if exact and "@" not in exact:
                anns.append({"exact": exact, "section": _text(l["section"])[:80],
                             "tags": [{"name": f"Code verified on {name}", "uri": _page(origin, a["id"])}],
                             "type": "Code"})
        if anns:
            out.append({"src": "PMC", "id": pmcid, "provider": name, "anns": anns})
    return out


def scholix(con: sqlite3.Connection, origin: str, name: str) -> list[dict]:
    """The paper-to-software links as Scholix records: the paper (its DOI) IsSupplementedBy the code."""
    links = _code_links(con)
    out = []
    for a in _pages(con):
        doi, _, _ = clean_ids(a["doi"], a["pmid"], a["pmcid"])
        if not doi:
            continue
        for l in links.get(a["id"], []):
            url = l["repo_url"] or l["url"]
            if not url.startswith("https://") or "@" in url:
                continue
            out.append({
                "LinkPublicationDate": "",
                "LinkProvider": [{"Name": name, "Identifier": [{"ID": origin, "IDScheme": "url"}]}],
                "RelationshipType": {"Name": "IsSupplementedBy", "SubType": "", "SubTypeSchema": ""},
                "LicenseURL": "",
                "Source": {"Identifier": [{"ID": doi, "IDScheme": "doi", "IDURL": f"https://doi.org/{doi}"}],
                           "Type": {"Name": "literature"}},
                "Target": {"Identifier": [{"ID": url, "IDScheme": "url", "IDURL": url}], "Type": {"Name": "software"}},
                "LinkPage": _page(origin, a["id"]),
            })
    return out


def mixnmatch(con: sqlite3.Connection) -> str:
    """The Mix'n'match catalogue: tab-separated id, name, description (the DOI), one paper a line."""
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="\t", lineterminator="\n")
    w.writerow(["id", "name", "desc"])
    for a in _pages(con):
        doi, _, _ = clean_ids(a["doi"], a["pmid"], a["pmcid"])
        w.writerow([catalog.slug(a["id"]), _text(a["title"])[:250], f"doi:{doi}" if doi else ""])
    return buf.getvalue()


def journals(con: sqlite3.Connection, origin: str) -> dict[str, str]:
    """One CSV per journal of JOURNALS: the DOI and the page of each of its papers with code."""
    links = _code_links(con)
    rows: dict[str, list[tuple[str, str]]] = {k: [] for k in JOURNALS}
    for a in _pages(con):
        if a["id"] not in links:
            continue
        j = (a["journal"] or "").lower()
        doi, _, _ = clean_ids(a["doi"], a["pmid"], a["pmcid"])
        for key, prefixes in JOURNALS.items():
            if doi and any(j.startswith(p) for p in prefixes):
                rows[key].append((doi, _page(origin, a["id"])))
    out = {}
    for key, items in rows.items():
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(["doi", "page"])
        w.writerows(items)
        out[key] = buf.getvalue()
    return out


def write(con: sqlite3.Connection, folder: Path, cfg: dict[str, str]) -> str:
    """Every partner's file, in `folder`; a line of counts."""
    origin = cfg.get("OSCR_SITE_URL", "https://openscicode.org/").rstrip("/")
    name = cfg.get("OSCR_PLATFORM_NAME", "OSCR")
    folder.mkdir(parents=True, exist_ok=True)
    ann = scilite(con, origin, name)
    with gzip.open(folder / "scilite-annotations.jsonl.gz", "wt", encoding="utf-8") as f:
        for item in ann:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    links = scholix(con, origin, name)
    with gzip.open(folder / "scholix.json.gz", "wt", encoding="utf-8") as f:
        json.dump(links, f, ensure_ascii=False)
    (folder / "mixnmatch.tsv").write_text(mixnmatch(con), encoding="utf-8")
    jdir = folder / "journals"
    jdir.mkdir(exist_ok=True)
    counts = []
    for key, text in journals(con, origin).items():
        (jdir / f"{key}.csv").write_text(text, encoding="utf-8")
        counts.append(f"{key} {text.count(chr(10)) - 1}")
    return (f"Europe PMC annotations: {len(ann)} papers, {sum(len(a['anns']) for a in ann)} code links; "
            f"Scholix: {len(links)} links; Mix'n'match: {mixnmatch(con).count(chr(10)) - 1} papers; journals: {', '.join(counts)}")


# ── Software Heritage ──────────────────────────────────────────────────────────────────────────

def swh_candidates(con: sqlite3.Connection, asked: dict[str, float], now: float) -> list[str]:
    """The git repositories to ask Software Heritage to save: alive, public forge repositories linked
    from a paper with a page, not archived yet, not withheld, not asked for in SWH_AGAIN_DAYS."""
    held = catalog.withheld(con)
    out = []
    for r in con.execute(f"SELECT DISTINCT r.repo, r.url FROM repository r JOIN link l ON l.repo = r.repo "
                         f"WHERE l.role = 'code' AND r.state = 'alive' AND r.kind = 'forge' AND coalesce(r.swh_archived, 0) = 0 "
                         f"AND l.article_id IN ({PAGES_SQL}) ORDER BY r.repo"):
        repo, url = r[0], r[1]
        if repo in held.repos or not url.startswith("https://") or "@" in url:
            continue
        if repo in asked and now - asked[repo] < SWH_AGAIN_DAYS * 86_400:
            continue
        out.append(url)
    return out


Opener = Callable[[urllib.request.Request], "urllib.response.addinfourl"]


def swh_save(con: sqlite3.Connection, folder: Path, cfg: dict[str, str], *, opener: Opener | None = None,
             now: float | None = None) -> str:
    """Asks Software Heritage to save a few repositories (OSCR_SWH=1 only), anonymously, stopping at
    the first refusal or when the rate limit is spent. What was asked is kept in `swh-asked.json`."""
    if cfg.get("OSCR_SWH", "") != "1":
        return "Software Heritage: off (OSCR_SWH=1 turns it on)"
    now = time.time() if now is None else now
    state = folder / "swh-asked.json"
    asked: dict[str, float] = json.loads(state.read_text()) if state.is_file() else {}
    per_night = int(cfg.get("OSCR_SWH_PER_NIGHT", str(SWH_PER_NIGHT)) or SWH_PER_NIGHT)
    by_url = {r[1]: r[0] for r in con.execute("SELECT repo, url FROM repository")}
    opener = opener or urllib.request.urlopen
    sent = 0
    stop = ""
    for url in swh_candidates(con, asked, now)[:per_night]:
        req = urllib.request.Request(SWH_SAVE.format(url=urllib.parse.quote(url, safe=":/")), method="POST",
                                     headers={"User-Agent": "oscr (+https://openscicode.org)"})
        try:
            with opener(req) as res:
                remaining = res.headers.get("X-RateLimit-Remaining")
        except urllib.error.HTTPError as e:
            stop = f"stopped: HTTP {e.code}"
            break
        except (urllib.error.URLError, TimeoutError) as e:
            stop = f"stopped: {type(e).__name__}"
            break
        asked[by_url.get(url, url)] = now
        sent += 1
        if remaining is not None and remaining.isdigit() and int(remaining) <= 1:
            stop = "stopped: rate limit spent"
            break
    folder.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(asked, sort_keys=True))
    return f"Software Heritage: {sent} save requests" + (f" ({stop})" if stop else "")
