"""Zenodo (InvenioRDM): DOIs for TRACING MAPS validated by an author.

Zenodo runs on InvenioRDM, hosted for free by CERN. Its sandbox (sandbox.zenodo.org) has
the same API and fake DOIs, and is used for ALL development: it is the default instance
here; the real one must be asked for explicitly (`--instance zenodo`).

**The rules** (see CLAUDE.md):
- a DOI only for a tracing map VALIDATED BY AN AUTHOR, never for a machine-generated one;
- the DOI is on the map (links + metadata), not on the code: the authors' code is never
  redeposited, the map REFERENCES it;
- relations: `IsSupplementTo` → the paper's DOI, `References` → the code repository;
- creators: the validating author, with their ORCID, and the platform;
- the maps are gathered in a Zenodo community;
- no paid service.

**The map** (`tracing-map.json`) says, for a paper: where its code is (repository,
commit, license), what was found there (the files and their digests), how it was found,
and which paragraph of the paper matches which lines of the code. It holds neither the
paper's text nor the code.

**The validation** comes from an author. On the website, they will sign in with their
ORCID (proof `orcid`). In development, `oscr zenodo validate` records a TEST validation,
which the real instance ignores.

**The token** comes from `ZENODO_SANDBOX_TOKEN` (or `ZENODO_TOKEN`) when set, else from
the macOS keychain (service `org.oscr.zenodo-sandbox` or `org.oscr.zenodo`). Never from a
file of the repository nor from the settings.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sqlite3
import subprocess
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx

from .net import USER_AGENT

INSTANCES: dict[str, str] = {
    "sandbox": "https://sandbox.zenodo.org",
    "zenodo": "https://zenodo.org",
}
#: InvenioRDM's native format; without it, Zenodo answers in its legacy format.
NATIVE = {"Accept": "application/vnd.inveniordm.v1+json"}
#: Zenodo accepts 60 requests/minute from a guest, more with a token.
INTERVAL_S = 1.1
MAP_FORMAT = "tracing-map/0.1"
MAP_FILE = "tracing-map.json"
#: Validation proofs: `orcid` (the author signed in with their ORCID on the website);
#: `test` (development, sandbox only).
PROOFS = ("orcid", "test")

TOKEN_HELP = ("No token for {instance}. Create one at {base}/account/settings/applications/tokens/new/ "
              "(tick deposit:write and deposit:actions), then store it in the keychain without pasting "
              "it anywhere else:\n"
              "  security add-generic-password -U -s {service} -a \"$USER\" -w")


class InvenioError(RuntimeError):
    pass


def sandbox_mock() -> str:
    """Development only: `OSCR_ZENODO_SANDBOX_URL`, a mock of the sandbox on this machine (the local
    end-to-end run of website/tests/account/e2e.sh), http://127.0.0.1 or localhost only; "" otherwise.
    It never replaces the real Zenodo."""
    url = os.environ.get("OSCR_ZENODO_SANDBOX_URL", "").strip().rstrip("/")
    return url if re.match(r"http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)", url) else ""


def keychain_service(instance: str) -> str:
    return "org.oscr.zenodo" + ("-sandbox" if instance == "sandbox" else "")


def token(instance: str) -> str:
    """The token of `instance`, or "" when there is none."""
    variable = "ZENODO_SANDBOX_TOKEN" if instance == "sandbox" else "ZENODO_TOKEN"
    if os.environ.get(variable, "").strip():
        return os.environ[variable].strip()
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", keychain_service(instance), "-w"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def orcid_is_valid(orcid: str) -> bool:
    """A well-formed ORCID, check digit included (ISO 7064 MOD 11-2)."""
    if not re.fullmatch(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", orcid or ""):
        return False
    digits = orcid.replace("-", "")
    total = 0
    for c in digits[:-1]:
        total = (total + int(c)) * 2
    check = (12 - total % 11) % 11
    return digits[-1] == ("X" if check == 10 else str(check))


class Invenio:
    """A client of the InvenioRDM REST API, polite (a little more than one second
    between two requests), in the native format."""

    def __init__(self, instance: str = "sandbox", *, api_token: str = "",
                 transport: httpx.BaseTransport | None = None) -> None:
        if instance not in INSTANCES:
            raise InvenioError(f"unknown instance: {instance} ({', '.join(INSTANCES)})")
        self.instance = instance
        self.base = sandbox_mock() if instance == "sandbox" and sandbox_mock() else INSTANCES[instance]
        headers = {"User-Agent": USER_AGENT, **NATIVE}
        if api_token:
            headers["Authorization"] = f"Bearer {api_token}"
        self.can_write = bool(api_token)
        self._http = httpx.Client(base_url=self.base, headers=headers, timeout=120,
                                  follow_redirects=True, transport=transport)
        self._last = 0.0

    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        wait = self._last + INTERVAL_S - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        r = self._http.request(method, path, **kw)
        if r.status_code >= 400:
            try:
                d = r.json()
                detail = str(d.get("message", "")) + "".join(
                    f" | {e.get('field')}: {' '.join(map(str, e.get('messages', [])))}"
                    for e in d.get("errors", []) if isinstance(e, dict))
            except ValueError:
                detail = r.text[:200]
            raise InvenioError(f"{method} {path}: HTTP {r.status_code} — {detail}")
        return r

    def _json(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        r = self._request(method, path, **kw)
        return r.json() if r.content else {}

    def require_token(self) -> None:
        if not self.can_write:
            raise InvenioError(TOKEN_HELP.format(instance=self.instance, base=self.base,
                                                 service=keychain_service(self.instance)))

    # ── read (no token) ──────────────────────────────────────────────────

    def records(self, q: str = "", *, community: str | None = None) -> Iterator[dict[str, Any]]:
        """Every record of a search, or of a community, page after page."""
        path = f"/api/communities/{community}/records" if community else "/api/records"
        # Zenodo: 25 records per page without a token, 100 with one.
        size = 100 if self.can_write else 25
        page = 1
        while True:
            d = self._json("GET", path, params={"q": q, "size": size, "page": page, "sort": "newest"})
            hits = d.get("hits", {}).get("hits", [])
            yield from hits
            total = d.get("hits", {}).get("total", 0)
            # InvenioRDM's index does not paginate beyond 10,000 results.
            if not hits or page * size >= min(total, 10_000):
                return
            page += 1

    def linked_to(self, doi: str) -> list[dict[str, Any]]:
        """The records that declare themselves related to this DOI: the software an
        author already archived for their paper, for instance, which the map will reference."""
        return list(self.records(f'metadata.related_identifiers.identifier:"{doi}"'))

    def community(self, slug: str) -> dict[str, Any] | None:
        try:
            return self._json("GET", f"/api/communities/{slug}")
        except InvenioError as e:
            if "HTTP 404" in str(e):
                return None
            raise

    # ── write (token) ────────────────────────────────────────────────────

    def create_community(self, slug: str, title: str, description: str) -> dict[str, Any]:
        self.require_token()
        return self._json("POST", "/api/communities", json={
            "slug": slug,
            "access": {"visibility": "public", "member_policy": "closed", "record_policy": "closed"},
            "metadata": {"title": title, "description": description, "type": {"id": "project"}}})

    def draft(self, content: dict[str, Any]) -> dict[str, Any]:
        self.require_token()
        return self._json("POST", "/api/records", json=content)

    def new_version(self, record_id: str, content: dict[str, Any]) -> dict[str, Any]:
        """The draft of a new version of `record_id` (same concept DOI), without files,
        with today's content."""
        self.require_token()
        d = self._json("POST", f"/api/records/{record_id}/versions")
        return {**d, **self._json("PUT", f"/api/records/{d['id']}/draft", json=content)}

    def upload(self, record_id: str, name: str, data: bytes) -> None:
        self._json("POST", f"/api/records/{record_id}/draft/files", json=[{"key": name}])
        self._request("PUT", f"/api/records/{record_id}/draft/files/{name}/content", content=data,
                      headers={"Content-Type": "application/octet-stream"})
        self._json("POST", f"/api/records/{record_id}/draft/files/{name}/commit")

    def publish(self, record_id: str) -> dict[str, Any]:
        return self._json("POST", f"/api/records/{record_id}/draft/actions/publish")

    def publish_in(self, record_id: str, community_id: str, message: str) -> dict[str, Any]:
        """Publish a draft INTO a community: the inclusion request, then its acceptance
        (the token is the platform's, owner of the community). Returns the published record."""
        self._json("PUT", f"/api/records/{record_id}/draft/review",
                   json={"receiver": {"community": community_id}, "type": "community-submission"})
        request = self._json("POST", f"/api/records/{record_id}/draft/actions/submit-review",
                             json={"payload": {"content": message, "format": "html"}})
        self._json("POST", f"/api/requests/{request['id']}/actions/accept",
                   json={"payload": {"content": "Tracing map validated by its author.", "format": "html"}})
        return self._json("GET", f"/api/records/{record_id}")


# ── the map ──────────────────────────────────────────────────────────────

def map_of(con: sqlite3.Connection, article_id: str) -> dict[str, Any]:
    """The tracing map of a paper, as the harvester PROPOSES it."""
    a = con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone()
    if a is None:
        raise InvenioError(f"unknown paper: {article_id}")
    code = []
    for l in con.execute(
            "SELECT l.repo, l.url, l.found_by, l.section, r.state, r.license, r.commit_id, r.commit_date, "
            "r.resource_type, r.swh_archived FROM link l LEFT JOIN repository r ON r.repo = l.repo "
            "WHERE l.article_id = ? AND l.role = 'code' ORDER BY l.repo", (article_id,)):
        level = con.execute("SELECT level FROM script WHERE article_id = ? AND repo = ? AND origin = 'native'",
                            (article_id, l["repo"])).fetchone()
        files = [{"path": f["path"], "language": f["language"], "digest": f["digest"]}
                 for f in con.execute("SELECT path, language, digest FROM file WHERE repo = ? "
                                      "AND kind = 'script' ORDER BY path", (l["repo"],))]
        code.append({
            "repo": l["repo"], "url": l["url"], "state": l["state"] or "unverified",
            "license": l["license"] or "", "commit": l["commit_id"] or "", "commit_date": l["commit_date"] or "",
            "type": l["resource_type"] or "", "software_heritage_archived": bool(l["swh_archived"]),
            "level": level["level"] if level else "found",
            "found_by": l["found_by"], "section": l["section"],
            "files": files,
        })
    alignments = [{"paragraph": p["paragraph"], "section": p["section"], "repo": p["repo"], "path": p["path"],
                   "start_line": p["start_line"], "end_line": p["end_line"], "symbol": p["symbol"],
                   "score": p["score"], "evidence": json.loads(p["evidence"] or "[]"), "method": p["method"]}
                  for p in con.execute("SELECT * FROM alignment WHERE article_id = ? ORDER BY pair", (article_id,))]
    return {
        "format": MAP_FORMAT,
        "paper": {"doi": a["doi"], "title": a["title"], "journal": a["journal"], "published": a["published"],
                  "authors": json.loads(a["authors"] or "[]")},
        "code": code,
        # Paragraph numbers are positions among the <p> under the Europe PMC JATS <body>.
        "alignments": alignments,
        "proposed": {"by": "oscr", "on": time.strftime("%Y-%m-%d")},
    }


def map_digest(card: dict[str, Any]) -> str:
    """The SHA-256 of a map's content, as the paper's page shows it: without the day it was
    proposed nor who validated it. The page carries it; a validation from the site brings it
    back (Phase 6, oscr/jobs.py), and the Mac deposits the map only if it is still that one."""
    content = {k: v for k, v in card.items() if k not in ("proposed", "validated")}
    text = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate(con: sqlite3.Connection, article_id: str, *, orcid: str, name: str, proof: str,
             card: dict[str, Any] | None = None) -> dict[str, Any]:
    """Record the validation of a map by one of the paper's authors. The map kept is the
    one the author SAW (and corrected, if need be): it is that map, and not the state of
    the database at deposit time, that will receive a DOI."""
    if proof not in PROOFS:
        raise InvenioError(f"unknown proof: {proof}")
    if not orcid_is_valid(orcid):
        raise InvenioError(f"invalid ORCID: {orcid}")
    if "," not in name:
        raise InvenioError('the name is written "Family, Given"')
    card = card or map_of(con, article_id)
    if not card["code"]:
        raise InvenioError("map without any code repository: nothing to validate")
    card = {**card, "validated": {"by": name, "orcid": orcid, "on": time.strftime("%Y-%m-%d"), "proof": proof}}
    con.execute("INSERT OR REPLACE INTO validation (article_id, orcid, name, proof, validated_at, card) "
                "VALUES (?,?,?,?,?,?)",
                (article_id, orcid, name, proof, time.time(), json.dumps(card, ensure_ascii=False)))
    con.commit()
    return card


def _reference(c: dict[str, Any]) -> dict[str, Any]:
    """`References` → the code repository: its DOI when it has one, else its address at
    the validated commit."""
    if c["repo"].startswith("zenodo:"):
        return {"identifier": f"10.5281/zenodo.{c['repo'].split(':', 1)[1]}", "scheme": "doi",
                "relation_type": {"id": "references"}, "resource_type": {"id": "software"}}
    if c["repo"].startswith("doi:"):
        return {"identifier": c["repo"][4:], "scheme": "doi",
                "relation_type": {"id": "references"}, "resource_type": {"id": "software"}}
    url = c["url"]
    if c["commit"] and re.match(r"https://(github\.com|gitlab\.com|codeberg\.org)/[^/]+/[^/]+/?$", url):
        url = url.rstrip("/") + f"/tree/{c['commit']}"
    return {"identifier": url, "scheme": "url",
            "relation_type": {"id": "references"}, "resource_type": {"id": "software"}}


def _creator(name: str, orcid: str) -> dict[str, Any]:
    family, _, given = (x.strip() for x in name.partition(","))
    return {"person_or_org": {"type": "personal", "family_name": family, "given_name": given,
                              "identifiers": [{"scheme": "orcid", "identifier": orcid}]}}


def deposit_payload(card: dict[str, Any], validations: list[sqlite3.Row], *, platform: str) -> dict[str, Any]:
    """The Zenodo record of the map (InvenioRDM format)."""
    paper = card["paper"]
    today = time.strftime("%Y-%m-%d")
    repos = "".join(f"<li><a href=\"{html.escape(c['url'])}\">{html.escape(c['repo'])}</a>"
                    f"{' @ ' + html.escape(c['commit'][:12]) if c['commit'] else ''}"
                    f"{' — ' + html.escape(c['license']) if c['license'] else ''}</li>" for c in card["code"])
    n_pairs = len(card.get("alignments") or [])
    description = (
        f"<p>Code tracing map for the paper <em>{html.escape(paper['title'])}</em> "
        f"(doi:{html.escape(paper['doi'])}), validated by its author.</p>"
        f"<p>The map links the paper to the code its authors published:</p><ul>{repos}</ul>"
        + (f"<p>It also lists {n_pairs} matches between paragraphs of the paper and lines of the code.</p>"
           if n_pairs else "")
        + f"<p>This record holds the map only (<code>{MAP_FILE}</code>: links and metadata). "
        "The code itself is not redeposited: it stays in the repositories referenced above.</p>")
    return {
        "access": {"record": "public", "files": "public"},
        "files": {"enabled": True},
        "metadata": {
            "resource_type": {"id": "dataset"},
            "title": f"Code tracing map: {paper['title']}"[:250],
            "publication_date": today,
            "version": f"{MAP_FORMAT.split('/')[1]}-{today}",
            "creators": [_creator(v["name"], v["orcid"]) for v in validations]
                        + [{"person_or_org": {"type": "organizational", "name": platform}}],
            "description": description,
            "publisher": "Zenodo",
            "rights": [{"id": "cc0-1.0"}],
            "subjects": [{"subject": s} for s in ("code tracing map", "research software",
                                                   "reproducibility", "neuroscience")],
            "related_identifiers": (
                [{"identifier": paper["doi"], "scheme": "doi", "relation_type": {"id": "issupplementto"},
                  "resource_type": {"id": "publication-article"}}]
                + [_reference(c) for c in card["code"]]),
        },
    }


def deposit_map(con: sqlite3.Connection, inv: Invenio, article_id: str, *, platform: str,
                community: str = "", dry_run: bool = False,
                report: Callable[[str], None] = print) -> dict[str, Any]:
    """Give a DOI to the VALIDATED map of a paper: a new record the first time, a new
    version (same concept DOI) afterwards."""
    validations = con.execute("SELECT * FROM validation WHERE article_id = ? ORDER BY validated_at",
                              (article_id,)).fetchall()
    if inv.instance != "sandbox":
        # The real Zenodo only sees validations by authors signed in with ORCID: a test
        # made in the sandbox on the same paper does not count, and does not block the
        # real validation either.
        validations = [v for v in validations if v["proof"] == "orcid"]
    if not validations:
        raise InvenioError("map not validated by an author (ORCID): no DOI (project rule)")
    card = json.loads(validations[-1]["card"])
    content = deposit_payload(card, validations, platform=platform)
    data = json.dumps(card, ensure_ascii=False, indent=1).encode()
    previous = con.execute("SELECT * FROM card_doi WHERE article_id = ? AND instance = ?",
                           (article_id, inv.instance)).fetchone()
    report(f"{'new version of ' + previous['record_id'] if previous else 'new record'} on {inv.base}: "
           f"{MAP_FILE} ({len(data)} bytes), {len(content['metadata']['related_identifiers'])} relations")
    if dry_run:
        return {"dry_run": True, "content": content, "card": card}
    inv.require_token()
    draft = inv.new_version(previous["record_id"], content) if previous else inv.draft(content)
    inv.upload(draft["id"], MAP_FILE, data)
    if community and not previous:
        c = inv.community(community)
        if c is None:
            raise InvenioError(f"community not found on {inv.base}: {community}")
        published = inv.publish_in(draft["id"], c["id"], f"Tracing map of doi:{card['paper']['doi']}")
    else:
        # A new version stays in the community of the first one.
        published = inv.publish(draft["id"])
    pids = published.get("pids") or {}
    doi = (pids.get("doi") or {}).get("identifier", "")
    concept = (((published.get("parent") or {}).get("pids") or {}).get("doi") or {}).get("identifier", "")
    con.execute("INSERT OR REPLACE INTO card_doi (article_id, instance, record_id, doi, concept_doi, deposited_at) "
                "VALUES (?,?,?,?,?,?)", (article_id, inv.instance, str(published["id"]), doi, concept, time.time()))
    con.commit()
    return {"id": published["id"], "doi": doi, "concept_doi": concept,
            "url": (published.get("links") or {}).get("self_html", "")}
