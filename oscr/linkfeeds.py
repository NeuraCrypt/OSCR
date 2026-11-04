"""The reader-side links (docs/BADGE.md, "The sites where papers are read"): one link from each paper
the registry has a page for to that page, on the sites where the paper itself is read, written for
every paper at once and rewritten every night.

- **Europe PMC External Links** (LabsLink, https://europepmc.org/LabsLink): a profile file and links
  files, schema 1.2. A paper is matched by its PMID (`MED`), else its PMCID (`PMC`), else its DOI.
  The links appear under the paper's "External Links" tab.
- **PubMed LinkOut** (https://www.ncbi.nlm.nih.gov/projects/linkout/): a resource file, one `Link`
  per paper with a PMID, its URL whole (the page's address is not a function of the PMID).

Nothing here writes to an author's repository, sends a message or names a person: the files hold
identifiers, titles and the registry's own addresses. The provider ids are given by Europe PMC and
the NCBI when the owner registers (`OSCR_LABSLINK_PROVIDER`, `OSCR_LINKOUT_PROVIDER`); until then
the files are written with id 0, for review. The contact address the profile needs
(`OSCR_LABSLINK_EMAIL`) goes to Europe PMC only, never to the site.

Delivery (`upload`): by FTP, the protocol both services give their providers, once the owner has
the account (`OSCR_LABSLINK_FTP` / `OSCR_LINKOUT_FTP` = `host/folder` and `user`, the password in
the keychain, `org.oscr.labslink` / `org.oscr.linkout`). Unset, nothing is sent and the night says
so in one line. Standard library only.
"""
from __future__ import annotations

import ftplib
import gzip
import re
import sqlite3
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

from . import catalog
from .entities import PAGES_SQL

#: Links per Europe PMC links file: under its documented ceiling (about 100,000 links in 2 MB
#: compressed), with room for long titles.
LABSLINK_PER_FILE = 50_000
#: Links per LinkOut resource file.
LINKOUT_PER_FILE = 50_000
#: The keychain services of the two FTP passwords.
KEYCHAIN = {"labslink": "org.oscr.labslink", "linkout": "org.oscr.linkout"}

_PMID = re.compile(r"^\d{1,9}$")
_PMCID = re.compile(r"^PMC\d{1,9}$")
_DOI = re.compile(r"^10\.\d{4,9}/\S+$")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


@dataclass(frozen=True)
class Paper:
    id: str
    slug: str
    doi: str
    pmid: str
    pmcid: str
    title: str


def clean_ids(doi: str, pmid: str, pmcid: str) -> tuple[str, str, str]:
    """The three identifiers as the services want them, "" when malformed."""
    doi = (doi or "").strip()
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", "", doi, flags=re.I)
    pmid = (pmid or "").strip()
    pmcid = (pmcid or "").strip().upper()
    if pmcid and not pmcid.startswith("PMC"):
        pmcid = "PMC" + pmcid
    return (doi if _DOI.match(doi) else "", pmid if _PMID.match(pmid) else "",
            pmcid if _PMCID.match(pmcid) else "")


def papers(con: sqlite3.Connection) -> list[Paper]:
    """Every paper the site has a page for (entities.PAGES_SQL), sorted by id: the same set the
    sitemap lists. A paper with no usable identifier is left out."""
    rows = con.execute(f"SELECT id, doi, pmid, pmcid, title FROM article WHERE id IN ({PAGES_SQL}) ORDER BY id")
    out = []
    for r in rows:
        doi, pmid, pmcid = clean_ids(r["doi"], r["pmid"], r["pmcid"])
        if doi or pmid or pmcid:
            out.append(Paper(r["id"], catalog.slug(r["id"]), doi, pmid, pmcid,
                             " ".join(_CONTROL.sub(" ", r["title"] or "").split())))
    return out


def page_url(origin: str, p: Paper) -> str:
    return f"{origin.rstrip('/')}/paper/{p.slug}/"


def _chunks(items: list, size: int) -> Iterable[list]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def labslink_profile(provider: int, name: str, description: str, email: str) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<providers>\n  <provider>\n'
            f"    <id>{int(provider)}</id>\n"
            f"    <resourceName>{escape(name)}</resourceName>\n"
            f"    <description>{escape(description)}</description>\n"
            f"    <email>{escape(email)}</email>\n"
            "  </provider>\n</providers>\n")


def labslink_record(p: Paper) -> str:
    """How Europe PMC finds the paper: its PMID, else its PMCID, else its DOI."""
    if p.pmid:
        return f"<record><source>MED</source><id>{p.pmid}</id></record>"
    if p.pmcid:
        return f"<record><source>PMC</source><id>{p.pmcid}</id></record>"
    return f"<doi>{escape(p.doi)}</doi>"


def labslink_links(provider: int, origin: str, items: list[Paper], title: str, image: str = "") -> str:
    img = f"<image>{escape(image)}</image>" if image else ""
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<links>"]
    for p in items:
        lines.append(f'  <link providerId="{int(provider)}"><resource><url>{escape(page_url(origin, p))}</url>'
                     f"<title>{escape(title)}</title>{img}</resource>{labslink_record(p)}</link>")
    lines.append("</links>")
    return "\n".join(lines) + "\n"


def linkout_resources(provider: int, origin: str, items: list[Paper], start: int = 1) -> str:
    """A LinkOut resource file: one Link per paper (PMID only: LinkOut selects PubMed records)."""
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<!DOCTYPE LinkSet PUBLIC "-//NLM//DTD LinkOut 1.0//EN" '
             '"https://www.ncbi.nlm.nih.gov/projects/linkout/doc/LinkOut.dtd">', "<LinkSet>"]
    for n, p in enumerate(items, start):
        lines.append(f"  <Link><LinkId>{n}</LinkId><ProviderId>{int(provider)}</ProviderId>"
                     "<ObjectSelector><Database>PubMed</Database>"
                     f"<ObjectList><ObjId>{p.pmid}</ObjId></ObjectList></ObjectSelector>"
                     f"<ObjectUrl><Base>{escape(page_url(origin, p))}</Base></ObjectUrl></Link>")
    lines.append("</LinkSet>")
    return "\n".join(lines) + "\n"


def write(con: sqlite3.Connection, folder: Path, cfg: dict[str, str]) -> str:
    """Writes every file into `folder` (labslink/ and linkout/, replaced whole) and says how many
    papers each covers."""
    origin = cfg.get("OSCR_SITE_URL", "https://openscicode.org/")
    name = cfg.get("OSCR_PLATFORM_NAME", "OSCR")
    ps = papers(con)
    out = []

    lab = folder / "labslink"
    lab.mkdir(parents=True, exist_ok=True)
    for old in lab.glob("*.xml*"):
        old.unlink()
    provider = int(cfg.get("OSCR_LABSLINK_PROVIDER", "0") or 0)
    (lab / "profile.xml").write_text(labslink_profile(
        provider, name,
        f"{name} shows the code the authors of this paper published, verified at its source, side by side "
        "with the paper's methods. Each link opens the paper's page in the registry.",
        cfg.get("OSCR_LABSLINK_EMAIL", "")), encoding="utf-8")
    title = f"The authors' code, verified, on {name}"
    for i, chunk in enumerate(_chunks(ps, LABSLINK_PER_FILE), 1):
        data = labslink_links(provider, origin, chunk, title).encode("utf-8")
        (lab / f"links-{i:03d}.xml.gz").write_bytes(gzip.compress(data, 9, mtime=0))
    out.append(f"Europe PMC: {len(ps)} papers ({sum(1 for p in ps if p.pmid)} by PMID, "
               f"{sum(1 for p in ps if not p.pmid and p.pmcid)} by PMCID, "
               f"{sum(1 for p in ps if not p.pmid and not p.pmcid)} by DOI)"
               + ("" if provider else "; provider id 0 until Europe PMC gives one (OSCR_LABSLINK_PROVIDER)"))

    lo = folder / "linkout"
    lo.mkdir(parents=True, exist_ok=True)
    for old in lo.glob("*.xml*"):
        old.unlink()
    provider = int(cfg.get("OSCR_LINKOUT_PROVIDER", "0") or 0)
    with_pmid = [p for p in ps if p.pmid]
    for i, chunk in enumerate(_chunks(with_pmid, LINKOUT_PER_FILE), 1):
        start = (i - 1) * LINKOUT_PER_FILE + 1
        (lo / f"resources-{i:03d}.xml").write_text(linkout_resources(provider, origin, chunk, start), encoding="utf-8")
    out.append(f"PubMed LinkOut: {len(with_pmid)} papers with a PMID"
               + ("" if provider else "; provider id 0 until the NCBI gives one (OSCR_LINKOUT_PROVIDER)"))
    return "; ".join(out)


def _password(service: str) -> str:
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", service, "-w"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def upload(folder: Path, cfg: dict[str, str], *, connect=None) -> str:
    """Sends each service's files to its FTP folder, when the owner has set it up; otherwise says
    what is missing. The files are replaced whole each night (the services read the folder)."""
    said = []
    for kind, setting in (("labslink", "OSCR_LABSLINK_FTP"), ("linkout", "OSCR_LINKOUT_FTP")):
        where, user = cfg.get(setting, ""), cfg.get(f"{setting}_USER", "")
        provider = cfg.get("OSCR_LABSLINK_PROVIDER" if kind == "labslink" else "OSCR_LINKOUT_PROVIDER", "")
        if not (where and user and provider):
            said.append(f"{kind}: not sent ({setting}, {setting}_USER and the provider id are not all set)")
            continue
        password = _password(KEYCHAIN[kind])
        if not password:
            said.append(f"{kind}: not sent (no password in the keychain, {KEYCHAIN[kind]})")
            continue
        host, _, remote = where.partition("/")
        files = sorted(p for p in (folder / kind).iterdir() if p.is_file())
        # TLS unless the service only speaks plain FTP (`<setting>_PLAIN=1`).
        opener = connect or (ftplib.FTP if cfg.get(f"{setting}_PLAIN") == "1" else ftplib.FTP_TLS)
        ftp = opener(host, timeout=60)
        try:
            ftp.login(user, password)
            if isinstance(ftp, ftplib.FTP_TLS):
                ftp.prot_p()
            if remote:
                ftp.cwd(remote)
            for p in files:
                with p.open("rb") as f:
                    ftp.storbinary(f"STOR {p.name}", f)
        finally:
            try:
                ftp.quit()
            except (OSError, ftplib.Error):
                ftp.close()
        said.append(f"{kind}: {len(files)} files sent")
    return "; ".join(said)
