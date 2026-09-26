"""Links: recognize an address, reduce it to its repository, say what it hosts.

**Why normalize.** The same repository is written ten ways in papers:
`https://github.com/Owner/Repo`, `github.com/owner/repo.git`,
`https://github.com/owner/repo/tree/main/analysis`, a Binder or Colab link that
points to it, a Zenodo DOI of its published release. Counting these ten
spellings as ten codes would inflate the library and skew the catalog: every
link is reduced to a NORMALIZED form (`github.com/owner/repo`, `zenodo:123`),
which is the key to everything else.

**Why a host KIND.** A link does not say what it carries, but its host often
does: GitHub carries code, OpenNeuro data, PyPI a published package — almost
always a third-party tool. Zenodo, OSF and figshare carry both: for them the
kind stays `archive`, and their record (resource type) decides at verification.

The kind is only a prior. The ROLE of the link in the paper — the authors'
code, their data, or a tool they used — is decided in `role.py`, from the
sentence that carries it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlsplit

#: Host kinds, from the most to the least likely to be "code".
KINDS: tuple[str, ...] = ("forge", "execution", "model", "archive", "package",
                          "data", "doc", "other")

#: Git forges: a repository there is code, at least in intent.
FORGES: frozenset[str] = frozenset({
    "github.com", "gitlab.com", "bitbucket.org", "codeberg.org",
    "gin.g-node.org", "gitee.com", "framagit.org", "sourceforge.net",
    "git.sr.ht", "huggingface.co",
})

#: Data-only hosts, in neuroscience and beyond.
DATA_HOSTS: frozenset[str] = frozenset({
    "openneuro.org", "dandiarchive.org", "gui.dandiarchive.org",
    "physionet.org", "neurovault.org", "crcns.org",
    "data.mendeley.com", "dataverse.harvard.edu", "brainlife.io",
    "humanconnectome.org", "db.humanconnectome.org", "openfmri.org",
    "legacy.openfmri.org",
    "search.kg.ebrains.eu", "kg.ebrains.eu", "data-proxy.ebrains.eu",
    "ncbi.nlm.nih.gov/geo", "ncbi.nlm.nih.gov/sra", "ncbi.nlm.nih.gov/bioproject",
    "ebi.ac.uk/arrayexpress", "ebi.ac.uk/biostudies", "bbci.de", "bnci-horizon-2020.eu",
    "eegdatasets.org", "nemar.org", "zenodo.org/communities",
    "neuromorpho.org", "portal.brain-map.org", "allenbrainatlas.org",
    "ukbiobank.ac.uk", "abide.io", "fcon_1000.projects.nitrc.org",
    "kaggle.com/datasets", "archive.ics.uci.edu", "synapse.org",
    "figshare.com/collections", "rcsb.org", "wwpdb.org", "pdbj.org", "emdataresource.org",
    "ebi.ac.uk/pdbe", "ebi.ac.uk/emdb", "alphafold.ebi.ac.uk", "uniprot.org",
})

#: Registries of published packages: a link there almost always names a tool.
PACKAGE_HOSTS: frozenset[str] = frozenset({
    "pypi.org", "pypi.python.org", "cran.r-project.org", "bioconductor.org",
    "anaconda.org", "conda-forge.org", "www.npmjs.com", "juliahub.com",
    "mathworks.com", "www.mathworks.com",
})

#: Where code is RUN: the link leads to a computation, often backed by GitHub.
EXECUTION_HOSTS: frozenset[str] = frozenset({
    "codeocean.com", "colab.research.google.com", "mybinder.org",
    "kaggle.com", "www.kaggle.com", "nbviewer.org", "nbviewer.jupyter.org",
    "hub.docker.com",
})

#: Computational neuroscience models have their own registries.
MODEL_HOSTS: frozenset[str] = frozenset({
    "modeldb.science", "senselab.med.yale.edu", "modeldb.yale.edu",
    "opensourcebrain.org", "www.opensourcebrain.org", "v2.opensourcebrain.org",
})

#: Generic archives: code OR data, the record decides.
ARCHIVE_HOSTS: frozenset[str] = frozenset({
    "zenodo.org", "osf.io", "figshare.com", "archive.softwareheritage.org",
})

#: DOI prefixes of archives and repositories. The DOI of a published paper is
#: not a code link: only these prefixes are kept.
DOI_PREFIXES: dict[str, tuple[str, str]] = {
    "10.5281": ("zenodo", "archive"),
    "10.17605": ("osf", "archive"),
    "10.6084": ("figshare", "archive"),
    "10.24433": ("codeocean", "execution"),
    "10.12751": ("gin", "forge"),
    "10.18112": ("openneuro", "data"),
    "10.48324": ("dandi", "data"),
    # Dryad keeps the data itself and the CODE in a companion Zenodo software
    # record ("Data from: …", isSourceOf relation): a mixed archive. As "data",
    # it caused 6 of the 10 misses of the Zenodo benchmark (2026-09-25).
    "10.5061": ("dryad", "archive"),
    "10.7910": ("dataverse", "data"),
    "10.13026": ("physionet", "data"),
    "10.17632": ("mendeley", "data"),
    "10.25493": ("ebrains", "data"),
    "10.6080": ("crcns", "data"),
    "10.7303": ("synapse", "data"),
}

#: Hosts of PAPERS: a link to them is neither code nor data
#: ("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4469089/" in a reference).
#: NCBI's data (GEO, SRA) are recognized before.
_ARTICLE_HOSTS = re.compile(
    r"(^|\.)(pubmed\.ncbi\.nlm\.nih\.gov|europepmc\.org|pmc\.ncbi\.nlm\.nih\.gov"
    r"|scholar\.google\.[a-z.]+|semanticscholar\.org|researchgate\.net|jstor\.org"
    r"|biorxiv\.org|medrxiv\.org|arxiv\.org|psyarxiv\.com)$")

#: GitHub paths that are not accounts: `github.com/features/...`.
_GITHUB_RESERVED: frozenset[str] = frozenset({
    "about", "features", "topics", "orgs", "marketplace", "sponsors", "settings",
    "login", "join", "pricing", "site", "apps", "collections", "explore",
    "search", "trending", "notifications", "enterprise", "security", "readme",
    "customer-stories", "contact", "events", "team", "users", "codespaces",
    "copilot", "education", "resources", "solutions", "discussions",
})

#: A URL in free text. Papers also write `github.com/x/y` without a scheme: the
#: second branch catches those for known hosts.
URL_IN_TEXT = re.compile(
    r"(?:https?://|ftp://|www\.)[^\s<>\"'{}|\\^`]+"
    # Not after a slash: "10.31234/osf.io/4cgxh" is the DOI of a PsyArXiv
    # preprint, not an OSF project (PMC12557530).
    r"|(?<![/\w.@-])(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|osf\.io"
    r"|zenodo\.org|gin\.g-node\.org|figshare\.com|codeocean\.com"
    r"|huggingface\.co|modeldb\.science|sourceforge\.net)/[^\s<>\"'{}|\\^`]+",
    re.I)

#: An archive DOI written out in plain text, without a link.
DOI_IN_TEXT = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>,;]+)", re.I)

#: A Software Heritage identifier.
SWHID = re.compile(r"\bswh:1:(?:cnt|dir|rev|rel|snp):[0-9a-f]{40}\b", re.I)

_TRAILING = ".,;:!?'\"»”’)]}>*"

#: Typography inside an address: Wiley's XML writes the hyphens of a URL as U+2010
#: ("github.com/aswendt\u2010lab/AIDAmri", 35 repositories in September 2026), which made
#: a second, dead repository next to the real one. Hyphens become ASCII; soft hyphens and
#: zero-width characters go.
_INVISIBLE = str.maketrans({"\u2010": "-", "\u2011": "-", "\u00ad": None, "\u200b": None,
                            "\u200c": None, "\u200d": None, "\u2060": None, "\ufeff": None})


@dataclass(frozen=True)
class Link:
    """A recognized address. `repo` is the key: two links with the same `repo`
    designate the same repository."""

    url: str
    repo: str
    host: str
    kind: str
    owner: str = ""
    name: str = ""
    identifier: str = ""

    @property
    def is_git_repo(self) -> bool:
        """A repository that can be queried through the git protocol itself."""
        return (self.kind == "forge" and bool(self.name)
                and self.host not in ("sourceforge.net",))

    @property
    def git_url(self) -> str:
        if self.host == "huggingface.co":
            return "https://huggingface.co/" + self.repo.split("/", 1)[1]
        return f"https://{self.repo}"


def clean(url: str) -> str:
    """Strip end-of-sentence punctuation and unmatched brackets."""
    u = unquote(url.strip()).translate(_INVISIBLE).replace("&amp;", "&")
    u = re.sub(r"\s+", "", u)
    while u and u[-1] in _TRAILING:
        if u[-1] == ")" and u.count("(") >= u.count(")"):
            break
        if u[-1] == "]" and u.count("[") >= u.count("]"):
            break
        u = u[:-1]
    if u.lower().startswith("www."):
        u = "https://" + u
    elif not re.match(r"^[a-z][a-z0-9+.-]*://", u, re.I) and not u.startswith("10."):
        u = "https://" + u
    return u


def normalize(url: str) -> Link | None:
    """Reduce an address to its repository. `None` if it is not an address."""
    u = clean(url)
    if u.startswith("10."):
        return _from_doi(u, u)
    try:
        s = urlsplit(u)
    except ValueError:
        return None
    host = (s.hostname or "").lower()
    # A host name, not a query glued behind "https://":
    # "https://journal=advsci&title=…&doi=10.1002" passed for a website.
    if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}", host):
        return None
    if host.endswith(".safelinks.protection.outlook.com"):
        # An address copied from an Outlook email: the real one is in `url=`,
        # and the rest carries the recipient's email address (seen in
        # 10.1038/s42003-026-10957-8, which cites its GitHub repository that way).
        inner = parse_qs(s.query).get("url", [""])[0]
        return normalize(inner) if inner.startswith("http") else None
    if host.startswith("www.") and host[4:] in FORGES | ARCHIVE_HOSTS:
        host = host[4:]
    parts = [p for p in s.path.split("/") if p]
    if _ARTICLE_HOSTS.search(host) or (host.endswith("ncbi.nlm.nih.gov") and parts
                                       and parts[0] in ("pmc", "pubmed", "nuccore", "protein",
                                                        "gene", "mesh", "books", "nlmcatalog")):
        return None
    if host == "archive.softwareheritage.org" and "origin=" in u:
        # A Software Heritage archive names its ORIGIN: it is the same repository
        # as the GitHub link of the neighboring sentence (PMC12490856, PMC12629594).
        origin = re.search(r"origin=([^;&\s]+)", u)
        swhid = SWHID.search(u)
        if origin:
            o = normalize(origin.group(1))
            if o is not None:
                return Link(u, o.repo, o.host, o.kind, o.owner, o.name,
                            swhid.group(0) if swhid else o.identifier)

    if host in ("doi.org", "dx.doi.org") and parts:
        return _from_doi("/".join(parts), u)
    if host == "github.com":
        return _github(u, parts)
    if host == "gist.github.com" and len(parts) >= 2:
        return Link(u, f"gist.github.com/{parts[-1].lower()}", host, "forge",
                    parts[0], parts[-1])
    if host == "raw.githubusercontent.com" and len(parts) >= 2:
        return _github(u, parts[:2])
    if host.endswith(".github.io"):
        # A project page: the documentation of a repository of the same name.
        owner = host.split(".")[0]
        return Link(u, f"{host}/{parts[0].lower()}" if parts else host, host,
                    "doc", owner, parts[0] if parts else "")
    if host == "colab.research.google.com" and len(parts) >= 3 and parts[0] == "github":
        return _github(u, parts[1:3])
    if host == "mybinder.org" and len(parts) >= 4 and parts[:2] == ["v2", "gh"]:
        return _github(u, parts[2:4])
    if host == "gitlab.com" or host.startswith("gitlab.") or ".gitlab." in host:
        return _gitlab(u, host, parts)
    if host in ("bitbucket.org", "codeberg.org", "gin.g-node.org", "gitee.com",
                "framagit.org", "git.sr.ht") and len(parts) >= 2:
        owner, name = parts[0], _strip_git(parts[1])
        return Link(u, f"{host}/{owner.lower()}/{name.lower()}", host, "forge",
                    owner, name)
    if host == "huggingface.co" and parts:
        return _huggingface(u, parts)
    if host == "sourceforge.net" and len(parts) >= 2 and parts[0] == "projects":
        return Link(u, f"sourceforge.net/{parts[1].lower()}", host, "forge",
                    "", parts[1])
    if host == "zenodo.org":
        return _zenodo(u, parts, s.query)
    if host == "osf.io":
        return _osf(u, parts)
    if host == "figshare.com" or host.endswith(".figshare.com"):
        return _figshare(u, host, parts)
    if host == "codeocean.com" and len(parts) >= 2 and parts[0] == "capsule":
        return Link(u, f"codeocean:{parts[1]}", host, "execution",
                    identifier=parts[1])
    if host in MODEL_HOSTS:
        return _modeldb(u, host, parts, s.query)
    if host == "datadryad.org":
        m = re.search(r"(10\.5061/dryad\.[a-z0-9]+)", unquote(u), re.I)
        if m:
            return _from_doi(m.group(1), u)
        if parts:
            return Link(u, "datadryad.org/" + "/".join(parts[:3]).lower(), host, "archive")
        return None
    if host in ("openneuro.org",) and "datasets" in parts:
        ds = parts[parts.index("datasets") + 1] if parts.index("datasets") + 1 < len(parts) else ""
        return Link(u, f"openneuro:{ds.lower()}", host, "data", identifier=ds)
    if host in ("dandiarchive.org", "gui.dandiarchive.org") and "dandiset" in parts:
        i = parts.index("dandiset") + 1
        ds = parts[i] if i < len(parts) else ""
        return Link(u, f"dandi:{ds}", host, "data", identifier=ds)
    if host == "archive.softwareheritage.org" or SWHID.search(u):
        m = SWHID.search(u)
        return Link(u, f"swh:{m.group(0).lower() if m else s.path}", host,
                    "archive", identifier=m.group(0) if m else "")
    return _generic(u, host, parts)


def _strip_git(name: str) -> str:
    return name[:-4] if name.lower().endswith(".git") else name


#: GitHub accounts that only serve DATA MIRRORS: the BIDS datasets of NEMAR
#: and OpenNeuro are git repositories there, without being code.
DATA_MIRRORS: frozenset[str] = frozenset({
    "nemardatasets", "openneurodatasets", "openneuroderivatives", "openneuro-datasets",
})


def _github(u: str, parts: list[str]) -> Link | None:
    if not parts or parts[0].lower() in _GITHUB_RESERVED:
        return None
    owner = parts[0]
    if len(parts) == 1:
        # An account or an organization, without a repository: a weak clue.
        return Link(u, f"github.com/{owner.lower()}", "github.com", "forge",
                    owner, "")
    name = _strip_git(parts[1])
    kind = "data" if owner.lower() in DATA_MIRRORS else "forge"
    return Link(u, f"github.com/{owner.lower()}/{name.lower()}", "github.com",
                kind, owner, name)


def _gitlab(u: str, host: str, parts: list[str]) -> Link | None:
    if "-" in parts:
        parts = parts[:parts.index("-")]
    if host.endswith(".gitlab.io"):
        return Link(u, host + ("/" + parts[0].lower() if parts else ""), host,
                    "doc", host.split(".")[0], parts[0] if parts else "")
    if len(parts) < 2:
        return Link(u, f"{host}/{'/'.join(parts).lower()}", host, "forge",
                    parts[0] if parts else "", "")
    path = "/".join(parts[:-1] + [_strip_git(parts[-1])])
    return Link(u, f"{host}/{path.lower()}", host, "forge", parts[0],
                _strip_git(parts[-1]), identifier=path)


def _huggingface(u: str, parts: list[str]) -> Link | None:
    if parts[0] in ("datasets", "spaces") and len(parts) >= 3:
        kind = "data" if parts[0] == "datasets" else "forge"
        return Link(u, f"huggingface.co/{parts[0]}/{parts[1].lower()}/{parts[2].lower()}",
                    "huggingface.co", kind, parts[1], parts[2])
    if parts[0] in ("papers", "docs", "blog", "models", "learn") or len(parts) < 2:
        return None
    return Link(u, f"huggingface.co/{parts[0].lower()}/{parts[1].lower()}",
                "huggingface.co", "forge", parts[0], parts[1])


def _zenodo(u: str, parts: list[str], query: str) -> Link | None:
    if len(parts) >= 2 and parts[0] in ("record", "records", "deposit", "uploads"):
        rid = re.sub(r"\D.*", "", parts[1])
        if rid:
            return Link(u, f"zenodo:{rid}", "zenodo.org", "archive", identifier=rid)
    if len(parts) >= 3 and parts[0] == "doi":
        return _from_doi("/".join(parts[1:]), u)
    if "communities" in parts:
        return Link(u, "zenodo.org/communities/" + parts[-1].lower(), "zenodo.org",
                    "data")
    return None


def _osf(u: str, parts: list[str]) -> Link | None:
    if not parts:
        return None
    if parts[0] == "preprints":
        return None  # a preprint is a paper, not code
    if parts[0] == "view":
        return None  # a meeting page
    guid = parts[0].lower()
    if not re.fullmatch(r"[a-z0-9]{5}", guid):
        return None
    return Link(u, f"osf:{guid}", "osf.io", "archive", identifier=guid)


def _figshare(u: str, host: str, parts: list[str]) -> Link | None:
    if "collections" in parts:
        ident = next((p for p in reversed(parts) if p.isdigit()), "")
        return Link(u, f"figshare:c{ident}", host, "data", identifier=ident)
    ident = next((p for p in reversed(parts) if p.isdigit()), "")
    if not ident:
        return None
    return Link(u, f"figshare:{ident}", "figshare.com", "archive", identifier=ident)


def _modeldb(u: str, host: str, parts: list[str], query: str) -> Link | None:
    if "opensourcebrain" in host:
        ident = parts[-1] if parts else ""
        return Link(u, f"osb:{ident.lower()}", host, "model", identifier=ident)
    q = parse_qs(query)
    ident = (q.get("model") or q.get("Model") or [""])[0]
    if not ident:
        ident = next((p for p in parts if p.isdigit()), "")
    if not ident:
        return None
    return Link(u, f"modeldb:{ident}", "modeldb.science", "model", identifier=ident)


def _from_doi(doi: str, u: str) -> Link | None:
    doi = clean(doi).removeprefix("https://")
    doi = re.sub(r"^(https?://)?(dx\.)?doi\.org/", "", doi, flags=re.I)
    # "10.5061/dryadgf1vhhmqx": the dot is missing in the XML itself (PMC9754634).
    doi = re.sub(r"^10\.5061/dryad\.?", "10.5061/dryad.", doi, flags=re.I)
    prefix = doi.split("/", 1)[0]
    if prefix not in DOI_PREFIXES:
        return None
    name, kind = DOI_PREFIXES[prefix]
    suffix = doi.split("/", 1)[1] if "/" in doi else ""
    if name == "zenodo":
        # "10.5281/zenodo3840534": the dot is missing at the publisher's (PMC12680202).
        m = re.search(r"zenodo\.?(\d+)", suffix, re.I)
        if m:
            return Link(u, f"zenodo:{m.group(1)}", "zenodo.org", "archive",
                        identifier=m.group(1))
    if name == "osf":
        m = re.search(r"osf\.io/([a-z0-9]{5})", suffix, re.I)
        if m:
            return Link(u, f"osf:{m.group(1).lower()}", "osf.io", "archive",
                        identifier=m.group(1).lower())
    if name == "figshare":
        m = re.search(r"figshare\.(\d+)", suffix, re.I)
        if m:
            return Link(u, f"figshare:{m.group(1)}", "figshare.com", "archive",
                        identifier=m.group(1))
    if name == "codeocean":
        m = re.search(r"co\.(\d+)", suffix, re.I)
        ident = m.group(1) if m else suffix
        return Link(u, f"codeocean:{ident}", "codeocean.com", "execution",
                    identifier=ident)
    return Link(u, f"doi:{doi.lower()}", f"doi:{name}", kind, identifier=doi)


def _generic(u: str, host: str, parts: list[str]) -> Link | None:
    path = "/".join(parts[:2]).lower()
    base = host[4:] if host.startswith("www.") else host
    for hosts, kind in ((DATA_HOSTS, "data"), (PACKAGE_HOSTS, "package"),
                        (EXECUTION_HOSTS, "execution")):
        for key in hosts:
            if "/" in key:
                h, p = key.split("/", 1)
                if base == h and path.startswith(p):
                    return Link(u, f"{base}/{path}", host, kind)
            elif base == key or base.endswith("." + key) or host == key:
                # The home page of a repository ("such as OpenNeuro
                # (https://openneuro.org)") is not a dataset.
                if not parts:
                    return None
                return Link(u, f"{base}/{path}", host, kind)
    if base.endswith(".readthedocs.io") or base.endswith(".readthedocs.org"):
        return Link(u, base, host, "doc")
    return Link(u, f"{base}/{path}".rstrip("/"), host, "other")


def in_text(text: str) -> list[str]:
    """The URLs, archive DOIs and SWH identifiers written out in a text."""
    found = [m.group(0) for m in URL_IN_TEXT.finditer(text)]
    for m in DOI_IN_TEXT.finditer(text):
        doi = m.group(1)
        if doi.split("/", 1)[0] in DOI_PREFIXES and not any(doi in t for t in found):
            found.append(doi)
    found += [m.group(0) for m in SWHID.finditer(text)]
    return found
