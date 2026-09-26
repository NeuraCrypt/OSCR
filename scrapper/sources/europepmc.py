"""Europe PMC : la porte d'entrée des articles, et leur plein texte JATS.

**Pourquoi elle.** Gratuite, sans clé, sans quota documenté ; 1,4 requête/s
tenues sans étranglement ; pagination par `cursorMark` ; le plein texte JATS de
tout article en accès libre de PMC, et de préimpressions (bioRxiv, medRxiv).
L'OAI-PMH d'Europe PMC, lui, rend 404 et 403 (mesuré le 25/09/2026) : on ne
s'en sert pas.

**Récents ou anciens.** La même requête prend une plage de dates de première
publication : le passage quotidien avance son curseur de date, un rattrapage
remonte les années.

**Pas de présélection « a du code ».** L'index sous-déclare les liens de code
d'un facteur 2,4 : on lit le XML de chaque article, sans filtrer d'avance.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator

from ..reseau import Client, Panne, passagere

BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"

#: Les périmètres prêts à l'emploi. `neuro` est large (1 885 articles en accès
#: libre du 1er au 25/09/2026) ; `electrophysiologie` est le cœur EEG/MEG du
#: banc de stat_bruteforce (165 sur la même période).
DOMAINES: dict[str, str] = {
    "electrophysiologie": (
        'TITLE_ABS:(EEG OR MEG OR iEEG OR ECoG OR SEEG OR electroencephalograph* '
        'OR magnetoencephalograph* OR "intracranial EEG" OR "event-related potential" '
        'OR "local field potential" OR "spike sorting" OR fNIRS OR "brain-computer interface")'),
    "neuro": (
        'TITLE_ABS:(EEG OR MEG OR fMRI OR iEEG OR ECoG OR SEEG OR electroencephalograph* '
        'OR magnetoencephalograph* OR "functional magnetic resonance" OR "intracranial EEG" '
        'OR "local field potential" OR "spike sorting" OR "calcium imaging" OR electrophysiolog* '
        'OR "brain-computer interface" OR "event-related potential" OR neuroimaging OR fNIRS '
        'OR "transcranial magnetic stimulation" OR "deep brain stimulation" '
        'OR "neural oscillations" OR connectome OR "diffusion MRI" OR neuron OR neurons '
        'OR neural OR cortex OR cortical OR hippocamp* OR brain)'),
}

#: Les filtres qui garantissent un plein texte lisible.
FILTRE_PLEIN_TEXTE = "OPEN_ACCESS:y AND HAS_FT:y AND IN_EPMC:y"


@dataclass
class ArticleEPMC:
    id: str
    doi: str = ""
    pmid: str = ""
    pmcid: str = ""
    id_texte: str = ""           # ce qu'on passe à /fullTextXML (PMCID ou PPR…)
    titre: str = ""
    auteurs: list[str] = field(default_factory=list)
    revue: str = ""
    date_pub: str = ""
    licence: str = ""
    source: str = "europepmc"

    def en_dict(self) -> dict:
        return {"id": self.id, "doi": self.doi, "pmid": self.pmid, "pmcid": self.pmcid,
                "titre": self.titre, "auteurs": self.auteurs, "revue": self.revue,
                "date_pub": self.date_pub, "licence": self.licence, "source": self.source}


def identifiant(doi: str, pmcid: str, autre: str = "") -> str:
    """La clé d'un article : son DOI, à défaut son PMCID, à défaut l'id Europe PMC."""
    if doi:
        return f"doi:{doi.lower()}"
    if pmcid:
        return f"pmcid:{pmcid.upper()}"
    return f"epmc:{autre}"


def _article(r: dict) -> ArticleEPMC:
    doi = (r.get("doi") or "").lower()
    pmcid = r.get("pmcid") or ""
    textes = (r.get("fullTextIdList") or {}).get("fullTextId") or []
    id_texte = pmcid or (textes[0] if textes else "")
    revue = ((r.get("journalInfo") or {}).get("journal") or {}).get("title", "")
    if not revue and r.get("source") == "PPR":
        revue = (r.get("bookOrReportDetails") or {}).get("publisher", "") + " (préimpression)"
    auteurs = [a.get("fullName", "") for a in ((r.get("authorList") or {}).get("author") or [])
               if a.get("fullName")]
    return ArticleEPMC(
        id=identifiant(doi, pmcid, f"{r.get('source', '')}:{r.get('id', '')}"),
        doi=doi, pmid=r.get("pmid") or "", pmcid=pmcid, id_texte=id_texte,
        titre=(r.get("title") or "").strip(), auteurs=auteurs, revue=revue,
        date_pub=r.get("firstPublicationDate") or "", licence=(r.get("license") or "").lower())


def requete(domaine_ou_requete: str, depuis: str, jusqua: str, *,
            plein_texte: bool = True) -> str:
    base = DOMAINES.get(domaine_ou_requete, domaine_ou_requete)
    q = f"({base}) AND FIRST_PDATE:[{depuis} TO {jusqua}]"
    return f"{q} AND {FILTRE_PLEIN_TEXTE}" if plein_texte else q


def rechercher(client: Client, q: str, *, curseur: str = "*", taille: int = 100
               ) -> tuple[list[ArticleEPMC], str, int]:
    """Une page de résultats. Rend (articles, curseur suivant, total)."""
    r = client.get(f"{BASE}/search", params={
        "query": q, "format": "json", "pageSize": str(taille), "cursorMark": curseur,
        "resultType": "core", "sort": "FIRST_PDATE_D asc"})
    if not r.ok:
        erreur = Panne if passagere(r.statut) else RuntimeError
        raise erreur(f"Europe PMC /search : HTTP {r.statut} — {r.texte[:200]}")
    d = r.json()
    arts = [_article(x) for x in d.get("resultList", {}).get("result", [])]
    return arts, d.get("nextCursorMark", ""), int(d.get("hitCount", 0))


def parcourir(client: Client, q: str, *, maximum: int | None = None) -> Iterator[ArticleEPMC]:
    """Tous les articles d'une requête, page après page."""
    curseur, rendus = "*", 0
    while True:
        arts, suivant, _ = rechercher(client, q, curseur=curseur)
        for a in arts:
            yield a
            rendus += 1
            if maximum is not None and rendus >= maximum:
                return
        if not arts or not suivant or suivant == curseur:
            return
        curseur = suivant


def par_doi(client: Client, doi: str) -> ArticleEPMC | None:
    """Un article connu par son DOI (pour scanner une liste donnée à la main)."""
    r = client.get(f"{BASE}/search", params={
        "query": f'DOI:"{doi}"', "format": "json", "pageSize": "1", "resultType": "core"},
        ttl_s=7 * 86400)
    if not r.ok:
        return None
    res = r.json().get("resultList", {}).get("result", [])
    return _article(res[0]) if res else None


def plein_texte(client: Client, id_texte: str) -> str | None:
    """Le JATS d'un article. Gardé en cache pour toujours : il ne change pas."""
    if not id_texte:
        return None
    r = client.get(f"{BASE}/{id_texte}/fullTextXML", ttl_s=float("inf"))
    if passagere(r.statut):
        # Une coupure (le Mac qui se réveille, le Wi-Fi) n'est pas une réponse :
        # rendre None classerait l'article « sans texte », et il serait sauté
        # pour toujours.
        raise Panne(f"Europe PMC fullTextXML {id_texte} : {r.statut or r.texte[:120]}")
    return r.texte if r.ok and r.texte.lstrip().startswith("<") else None
