"""Les liens : reconnaître une adresse, la ramener à son dépôt, dire ce qu'elle héberge.

**Pourquoi normaliser.** Le même dépôt s'écrit de dix façons dans les articles :
`https://github.com/Owner/Repo`, `github.com/owner/repo.git`,
`https://github.com/owner/repo/tree/main/analysis`, un lien Binder ou Colab qui
pointe dessus, un DOI Zenodo de sa version publiée. Compter ces dix écritures
comme dix codes gonflerait la bibliothèque et fausserait le tableau : chaque
lien est ramené à une forme NORMÉE (`github.com/owner/repo`, `zenodo:123`), qui
est la clé de tout le reste.

**Pourquoi un GENRE d'hôte.** Un lien ne dit pas ce qu'il porte, mais son hôte
le dit souvent : GitHub porte du code, OpenNeuro des données, PyPI un paquet
publié — presque toujours un outil tiers. Zenodo, OSF et figshare portent les
deux : pour eux le genre reste `archive`, et c'est leur fiche (type de
ressource) qui tranchera à la vérification.

Le genre n'est qu'un a priori. Le RÔLE du lien dans l'article — le code des
auteurs, leurs données, ou un outil qu'ils ont utilisé — se décide dans
`role.py`, à partir de la phrase qui le porte.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote, urlsplit

#: Les genres d'hôte, du plus au moins probablement « du code ».
GENRES: tuple[str, ...] = ("forge", "execution", "modele", "archive", "paquet",
                           "donnees", "doc", "autre")

#: Forges git : un dépôt y est du code, au moins en intention.
FORGES: frozenset[str] = frozenset({
    "github.com", "gitlab.com", "bitbucket.org", "codeberg.org",
    "gin.g-node.org", "gitee.com", "framagit.org", "sourceforge.net",
    "git.sr.ht", "huggingface.co",
})

#: Hôtes de données seulement, en neurosciences et au-delà.
DONNEES: frozenset[str] = frozenset({
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

#: Registres de paquets publiés : le lien y nomme presque toujours un outil.
PAQUETS: frozenset[str] = frozenset({
    "pypi.org", "pypi.python.org", "cran.r-project.org", "bioconductor.org",
    "anaconda.org", "conda-forge.org", "www.npmjs.com", "juliahub.com",
    "mathworks.com", "www.mathworks.com",
})

#: Où l'on EXÉCUTE du code : le lien y mène à un calcul, souvent adossé à GitHub.
EXECUTION: frozenset[str] = frozenset({
    "codeocean.com", "colab.research.google.com", "mybinder.org",
    "kaggle.com", "www.kaggle.com", "nbviewer.org", "nbviewer.jupyter.org",
    "hub.docker.com",
})

#: Les modèles de neurosciences computationnelles ont leurs propres registres.
MODELES: frozenset[str] = frozenset({
    "modeldb.science", "senselab.med.yale.edu", "modeldb.yale.edu",
    "opensourcebrain.org", "www.opensourcebrain.org", "v2.opensourcebrain.org",
})

#: Archives génériques : code OU données, la fiche tranche.
ARCHIVES: frozenset[str] = frozenset({
    "zenodo.org", "osf.io", "figshare.com", "archive.softwareheritage.org",
})

#: Préfixes DOI des archives et entrepôts. Un DOI d'article publié n'est pas un
#: lien de code : seuls ces préfixes-là sont retenus.
PREFIXES_DOI: dict[str, tuple[str, str]] = {
    "10.5281": ("zenodo", "archive"),
    "10.17605": ("osf", "archive"),
    "10.6084": ("figshare", "archive"),
    "10.24433": ("codeocean", "execution"),
    "10.12751": ("gin", "forge"),
    "10.18112": ("openneuro", "donnees"),
    "10.48324": ("dandi", "donnees"),
    # Dryad range les données chez lui et le CODE dans un logiciel Zenodo
    # compagnon (« Data from: … », relation isSourceOf) : une archive mixte.
    # En « données », 6 des 10 ratés de l'étalon Zenodo (25/09/2026).
    "10.5061": ("dryad", "archive"),
    "10.7910": ("dataverse", "donnees"),
    "10.13026": ("physionet", "donnees"),
    "10.17632": ("mendeley", "donnees"),
    "10.25493": ("ebrains", "donnees"),
    "10.6080": ("crcns", "donnees"),
    "10.7303": ("synapse", "donnees"),
}

#: Les hôtes d'ARTICLES : un lien vers eux n'est ni du code ni des données
#: (« https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4469089/ » dans une
#: référence). Les données de NCBI (GEO, SRA) sont reconnues avant.
_ARTICLES = re.compile(
    r"(^|\.)(pubmed\.ncbi\.nlm\.nih\.gov|europepmc\.org|pmc\.ncbi\.nlm\.nih\.gov"
    r"|scholar\.google\.[a-z.]+|semanticscholar\.org|researchgate\.net|jstor\.org"
    r"|biorxiv\.org|medrxiv\.org|arxiv\.org|psyarxiv\.com)$")

#: Chemins GitHub qui ne sont pas des comptes : `github.com/features/...`.
_GITHUB_RESERVES: frozenset[str] = frozenset({
    "about", "features", "topics", "orgs", "marketplace", "sponsors", "settings",
    "login", "join", "pricing", "site", "apps", "collections", "explore",
    "search", "trending", "notifications", "enterprise", "security", "readme",
    "customer-stories", "contact", "events", "team", "users", "codespaces",
    "copilot", "education", "resources", "solutions", "discussions",
})

#: Une URL dans du texte libre. Les articles écrivent aussi `github.com/x/y`
#: sans schéma : la seconde branche les rattrape pour les hôtes connus.
URL_TEXTE = re.compile(
    r"(?:https?://|ftp://|www\.)[^\s<>\"'{}|\\^`]+"
    # Pas après une barre : « 10.31234/osf.io/4cgxh » est le DOI d'une
    # préimpression PsyArXiv, pas un projet OSF (PMC12557530).
    r"|(?<![/\w.@-])(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|osf\.io"
    r"|zenodo\.org|gin\.g-node\.org|figshare\.com|codeocean\.com"
    r"|huggingface\.co|modeldb\.science|sourceforge\.net)/[^\s<>\"'{}|\\^`]+",
    re.I)

#: Un DOI d'archive écrit en clair, sans lien.
DOI_TEXTE = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>,;]+)", re.I)

#: Un identifiant Software Heritage.
SWHID = re.compile(r"\bswh:1:(?:cnt|dir|rev|rel|snp):[0-9a-f]{40}\b", re.I)

_FIN = ".,;:!?'\"»”’)]}>*"


@dataclass(frozen=True)
class Lien:
    """Une adresse reconnue. `norme` est la clé : deux liens de même norme
    désignent le même dépôt."""

    url: str
    norme: str
    hote: str
    genre: str
    proprietaire: str = ""
    depot: str = ""
    identifiant: str = ""

    @property
    def est_depot_git(self) -> bool:
        """Un dépôt qu'on peut interroger par le protocole git lui-même."""
        return (self.genre == "forge" and bool(self.depot)
                and self.hote not in ("sourceforge.net",))

    @property
    def url_git(self) -> str:
        if self.hote == "huggingface.co":
            return "https://huggingface.co/" + self.norme.split("/", 1)[1]
        return f"https://{self.norme}"


def nettoyer(url: str) -> str:
    """Ôter la ponctuation de fin de phrase et les parenthèses orphelines."""
    u = unquote(url.strip()).replace("​", "").replace("&amp;", "&")
    u = re.sub(r"\s+", "", u)
    while u and u[-1] in _FIN:
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


def normaliser(url: str) -> Lien | None:
    """Ramener une adresse à son dépôt. `None` si ce n'est pas une adresse."""
    u = nettoyer(url)
    if u.startswith("10."):
        return _de_doi(u, u)
    try:
        s = urlsplit(u)
    except ValueError:
        return None
    hote = (s.hostname or "").lower()
    # Un nom d'hôte, pas une requête collée derrière « https:// » :
    # « https://journal=advsci&title=…&doi=10.1002 » passait pour un site.
    if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}", hote):
        return None
    if hote.endswith(".safelinks.protection.outlook.com"):
        # Une adresse recopiée d'un courriel Outlook : la vraie est dans `url=`,
        # et le reste porte l'adresse électronique du destinataire (vu dans
        # 10.1038/s42003-026-10957-8, qui cite ainsi son dépôt GitHub).
        interne = parse_qs(s.query).get("url", [""])[0]
        return normaliser(interne) if interne.startswith("http") else None
    if hote.startswith("www.") and hote[4:] in FORGES | ARCHIVES:
        hote = hote[4:]
    parts = [p for p in s.path.split("/") if p]
    if _ARTICLES.search(hote) or (hote.endswith("ncbi.nlm.nih.gov") and parts
                                  and parts[0] in ("pmc", "pubmed", "nuccore", "protein",
                                                   "gene", "mesh", "books", "nlmcatalog")):
        return None
    if hote == "archive.softwareheritage.org" and "origin=" in u:
        # Une archive Software Heritage nomme son ORIGINE : c'est le même dépôt
        # que le lien GitHub de la phrase voisine (PMC12490856, PMC12629594).
        origine = re.search(r"origin=([^;&\s]+)", u)
        swhid = SWHID.search(u)
        if origine:
            l = normaliser(origine.group(1))
            if l is not None:
                return Lien(u, l.norme, l.hote, l.genre, l.proprietaire, l.depot,
                            swhid.group(0) if swhid else l.identifiant)

    if hote in ("doi.org", "dx.doi.org") and parts:
        return _de_doi("/".join(parts), u)
    if hote == "github.com":
        return _github(u, parts)
    if hote == "gist.github.com" and len(parts) >= 2:
        return Lien(u, f"gist.github.com/{parts[-1].lower()}", hote, "forge",
                    parts[0], parts[-1])
    if hote == "raw.githubusercontent.com" and len(parts) >= 2:
        return _github(u, parts[:2])
    if hote.endswith(".github.io"):
        # Une page de projet : la documentation d'un dépôt de même nom.
        proprio = hote.split(".")[0]
        return Lien(u, f"{hote}/{parts[0].lower()}" if parts else hote, hote,
                    "doc", proprio, parts[0] if parts else "")
    if hote == "colab.research.google.com" and len(parts) >= 3 and parts[0] == "github":
        return _github(u, parts[1:3])
    if hote == "mybinder.org" and len(parts) >= 4 and parts[:2] == ["v2", "gh"]:
        return _github(u, parts[2:4])
    if hote == "gitlab.com" or hote.startswith("gitlab.") or ".gitlab." in hote:
        return _gitlab(u, hote, parts)
    if hote in ("bitbucket.org", "codeberg.org", "gin.g-node.org", "gitee.com",
                "framagit.org", "git.sr.ht") and len(parts) >= 2:
        proprio, depot = parts[0], _sans_git(parts[1])
        return Lien(u, f"{hote}/{proprio.lower()}/{depot.lower()}", hote, "forge",
                    proprio, depot)
    if hote == "huggingface.co" and parts:
        return _huggingface(u, parts)
    if hote == "sourceforge.net" and len(parts) >= 2 and parts[0] == "projects":
        return Lien(u, f"sourceforge.net/{parts[1].lower()}", hote, "forge",
                    "", parts[1])
    if hote == "zenodo.org":
        return _zenodo(u, parts, s.query)
    if hote == "osf.io":
        return _osf(u, parts)
    if hote == "figshare.com" or hote.endswith(".figshare.com"):
        return _figshare(u, hote, parts)
    if hote == "codeocean.com" and len(parts) >= 2 and parts[0] == "capsule":
        return Lien(u, f"codeocean:{parts[1]}", hote, "execution",
                    identifiant=parts[1])
    if hote in MODELES:
        return _modeldb(u, hote, parts, s.query)
    if hote == "datadryad.org":
        m = re.search(r"(10\.5061/dryad\.[a-z0-9]+)", unquote(u), re.I)
        if m:
            return _de_doi(m.group(1), u)
        if parts:
            return Lien(u, "datadryad.org/" + "/".join(parts[:3]).lower(), hote, "archive")
        return None
    if hote in ("openneuro.org",) and "datasets" in parts:
        ds = parts[parts.index("datasets") + 1] if parts.index("datasets") + 1 < len(parts) else ""
        return Lien(u, f"openneuro:{ds.lower()}", hote, "donnees", identifiant=ds)
    if hote in ("dandiarchive.org", "gui.dandiarchive.org") and "dandiset" in parts:
        i = parts.index("dandiset") + 1
        ds = parts[i] if i < len(parts) else ""
        return Lien(u, f"dandi:{ds}", hote, "donnees", identifiant=ds)
    if hote == "archive.softwareheritage.org" or SWHID.search(u):
        m = SWHID.search(u)
        return Lien(u, f"swh:{m.group(0).lower() if m else s.path}", hote,
                    "archive", identifiant=m.group(0) if m else "")
    return _generique(u, hote, parts)


def _sans_git(nom: str) -> str:
    return nom[:-4] if nom.lower().endswith(".git") else nom


#: Comptes GitHub qui ne servent que des MIROIRS DE DONNÉES : les jeux BIDS de
#: NEMAR et d'OpenNeuro y sont des dépôts git, sans être du code.
MIROIRS_DONNEES: frozenset[str] = frozenset({
    "nemardatasets", "openneurodatasets", "openneuroderivatives", "openneuro-datasets",
})


def _github(u: str, parts: list[str]) -> Lien | None:
    if not parts or parts[0].lower() in _GITHUB_RESERVES:
        return None
    proprio = parts[0]
    if len(parts) == 1:
        # Un compte ou une organisation, sans dépôt : un indice faible.
        return Lien(u, f"github.com/{proprio.lower()}", "github.com", "forge",
                    proprio, "")
    depot = _sans_git(parts[1])
    genre = "donnees" if proprio.lower() in MIROIRS_DONNEES else "forge"
    return Lien(u, f"github.com/{proprio.lower()}/{depot.lower()}", "github.com",
                genre, proprio, depot)


def _gitlab(u: str, hote: str, parts: list[str]) -> Lien | None:
    if "-" in parts:
        parts = parts[:parts.index("-")]
    if hote.endswith(".gitlab.io"):
        return Lien(u, hote + ("/" + parts[0].lower() if parts else ""), hote,
                    "doc", hote.split(".")[0], parts[0] if parts else "")
    if len(parts) < 2:
        return Lien(u, f"{hote}/{'/'.join(parts).lower()}", hote, "forge",
                    parts[0] if parts else "", "")
    chemin = "/".join(parts[:-1] + [_sans_git(parts[-1])])
    return Lien(u, f"{hote}/{chemin.lower()}", hote, "forge", parts[0],
                _sans_git(parts[-1]), identifiant=chemin)


def _huggingface(u: str, parts: list[str]) -> Lien | None:
    if parts[0] in ("datasets", "spaces") and len(parts) >= 3:
        genre = "donnees" if parts[0] == "datasets" else "forge"
        return Lien(u, f"huggingface.co/{parts[0]}/{parts[1].lower()}/{parts[2].lower()}",
                    "huggingface.co", genre, parts[1], parts[2])
    if parts[0] in ("papers", "docs", "blog", "models", "learn") or len(parts) < 2:
        return None
    return Lien(u, f"huggingface.co/{parts[0].lower()}/{parts[1].lower()}",
                "huggingface.co", "forge", parts[0], parts[1])


def _zenodo(u: str, parts: list[str], query: str) -> Lien | None:
    if len(parts) >= 2 and parts[0] in ("record", "records", "deposit", "uploads"):
        rid = re.sub(r"\D.*", "", parts[1])
        if rid:
            return Lien(u, f"zenodo:{rid}", "zenodo.org", "archive", identifiant=rid)
    if len(parts) >= 3 and parts[0] == "doi":
        return _de_doi("/".join(parts[1:]), u)
    if "communities" in parts:
        return Lien(u, "zenodo.org/communities/" + parts[-1].lower(), "zenodo.org",
                    "donnees")
    return None


def _osf(u: str, parts: list[str]) -> Lien | None:
    if not parts:
        return None
    if parts[0] == "preprints":
        return None  # une préimpression est un article, pas du code
    if parts[0] == "view":
        return None  # page de réunion
    guid = parts[0].lower()
    if not re.fullmatch(r"[a-z0-9]{5}", guid):
        return None
    return Lien(u, f"osf:{guid}", "osf.io", "archive", identifiant=guid)


def _figshare(u: str, hote: str, parts: list[str]) -> Lien | None:
    if "collections" in parts:
        ident = next((p for p in reversed(parts) if p.isdigit()), "")
        return Lien(u, f"figshare:c{ident}", hote, "donnees", identifiant=ident)
    ident = next((p for p in reversed(parts) if p.isdigit()), "")
    if not ident:
        return None
    return Lien(u, f"figshare:{ident}", "figshare.com", "archive", identifiant=ident)


def _modeldb(u: str, hote: str, parts: list[str], query: str) -> Lien | None:
    if "opensourcebrain" in hote:
        ident = parts[-1] if parts else ""
        return Lien(u, f"osb:{ident.lower()}", hote, "modele", identifiant=ident)
    q = parse_qs(query)
    ident = (q.get("model") or q.get("Model") or [""])[0]
    if not ident:
        ident = next((p for p in parts if p.isdigit()), "")
    if not ident:
        return None
    return Lien(u, f"modeldb:{ident}", "modeldb.science", "modele", identifiant=ident)


def _de_doi(doi: str, u: str) -> Lien | None:
    doi = nettoyer(doi).removeprefix("https://")
    doi = re.sub(r"^(https?://)?(dx\.)?doi\.org/", "", doi, flags=re.I)
    # « 10.5061/dryadgf1vhhmqx » : le point manque dans le XML même (PMC9754634).
    doi = re.sub(r"^10\.5061/dryad\.?", "10.5061/dryad.", doi, flags=re.I)
    prefixe = doi.split("/", 1)[0]
    if prefixe not in PREFIXES_DOI:
        return None
    nom, genre = PREFIXES_DOI[prefixe]
    suffixe = doi.split("/", 1)[1] if "/" in doi else ""
    if nom == "zenodo":
        # « 10.5281/zenodo3840534 » : le point manque chez l'éditeur (PMC12680202).
        m = re.search(r"zenodo\.?(\d+)", suffixe, re.I)
        if m:
            return Lien(u, f"zenodo:{m.group(1)}", "zenodo.org", "archive",
                        identifiant=m.group(1))
    if nom == "osf":
        m = re.search(r"osf\.io/([a-z0-9]{5})", suffixe, re.I)
        if m:
            return Lien(u, f"osf:{m.group(1).lower()}", "osf.io", "archive",
                        identifiant=m.group(1).lower())
    if nom == "figshare":
        m = re.search(r"figshare\.(\d+)", suffixe, re.I)
        if m:
            return Lien(u, f"figshare:{m.group(1)}", "figshare.com", "archive",
                        identifiant=m.group(1))
    if nom == "codeocean":
        m = re.search(r"co\.(\d+)", suffixe, re.I)
        ident = m.group(1) if m else suffixe
        return Lien(u, f"codeocean:{ident}", "codeocean.com", "execution",
                    identifiant=ident)
    return Lien(u, f"doi:{doi.lower()}", f"doi:{nom}", genre, identifiant=doi)


def _generique(u: str, hote: str, parts: list[str]) -> Lien | None:
    chemin = "/".join(parts[:2]).lower()
    base = hote[4:] if hote.startswith("www.") else hote
    for ensemble, genre in ((DONNEES, "donnees"), (PAQUETS, "paquet"),
                            (EXECUTION, "execution")):
        for cle in ensemble:
            if "/" in cle:
                h, p = cle.split("/", 1)
                if base == h and chemin.startswith(p):
                    return Lien(u, f"{base}/{chemin}", hote, genre)
            elif base == cle or base.endswith("." + cle) or hote == cle:
                # La page d'accueil d'un entrepôt (« such as OpenNeuro
                # (https://openneuro.org) ») n'est pas un jeu de données.
                if not parts:
                    return None
                return Lien(u, f"{base}/{chemin}", hote, genre)
    if base.endswith(".readthedocs.io") or base.endswith(".readthedocs.org"):
        return Lien(u, base, hote, "doc")
    return Lien(u, f"{base}/{chemin}".rstrip("/"), hote, "autre")


def dans_le_texte(texte: str) -> list[str]:
    """Les URL, DOI d'archive et identifiants SWH écrits en clair dans un texte."""
    trouve = [m.group(0) for m in URL_TEXTE.finditer(texte)]
    for m in DOI_TEXTE.finditer(texte):
        doi = m.group(1)
        if doi.split("/", 1)[0] in PREFIXES_DOI and not any(doi in t for t in trouve):
            trouve.append(doi)
    trouve += [m.group(0) for m in SWHID.finditer(texte)]
    return trouve
