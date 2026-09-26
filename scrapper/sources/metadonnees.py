"""Les liens que portent les MÉTADONNÉES : Crossref et DataCite, sans lire l'article.

**Pourquoi ils comptent.** Pour un article sans plein texte ouvert — la
majorité de la littérature ancienne —, le texte ne dira rien. Mais l'éditeur
dépose souvent la liste des RÉFÉRENCES chez Crossref, et eLife y type même ses
logiciels (`"type": "software"`, auteur, titre, archive Software Heritage).
Mesuré le 25/09/2026 : sur eLife 10.7554/elife.100605, les deux dépôts de code
des auteurs et leur jeu de données y sont, avec le nom de l'auteur.

DataCite dit l'inverse : quel logiciel ou jeu de données DÉCLARE se rapporter à
l'article (`relatedIdentifiers`). Précis quand l'auteur l'a déclaré, muet sinon
— sur 3 articles à code Zenodo, 1 seule déclaration, et c'était un jeu de
données.

Les deux rendent des `Occurrence` comme le texte : le même juge (`role.py`) les
tranche, avec le lieu `references` ou `metadonnees`.
"""
from __future__ import annotations

import json
import re

from ..jats import Occurrence
from ..reseau import Client

CROSSREF = "https://api.crossref.org/works/"
DATACITE = "https://api.datacite.org/dois"

#: Ce qui, dans une référence, trahit un dépôt de code ou de données.
_INDICES = re.compile(r"zenodo|github|gitlab|bitbucket|osf\.io|figshare|softwareheritage"
                      r"|swh:1:|codeocean|openneuro|dryad|10\.5281|10\.17605|10\.6084"
                      r"|10\.24433|10\.18112|modeldb|gin\.g-node", re.I)

#: Les relations Crossref qui désignent un matériel propre à l'article.
_RELATIONS_PROPRES = ("is-supplemented-by", "has-related-material", "is-derived-from",
                      "requires", "is-documented-by")


def crossref(client: Client, doi: str) -> dict:
    r = client.get(CROSSREF + doi, ttl_s=30 * 86400)
    if not r.ok:
        return {}
    return (r.json() or {}).get("message", {})


def auteurs_crossref(message: dict) -> list[str]:
    return [a["family"] for a in message.get("author", []) if a.get("family")]


def occurrences_crossref(message: dict) -> list[Occurrence]:
    """Les références et relations Crossref qui pointent vers un dépôt."""
    occs: list[Occurrence] = []
    for rel, cibles in (message.get("relation") or {}).items():
        for c in cibles:
            ident = c.get("id", "")
            if not ident or c.get("id-type") not in ("doi", "uri", "url"):
                continue
            url = ident if c.get("id-type") != "doi" else f"https://doi.org/{ident}"
            propre = rel in _RELATIONS_PROPRES
            occs.append(Occurrence(url, f"relation Crossref « {rel} »", ("Crossref",),
                                   "metadonnees", f"crossref:{rel}" + (":propre" if propre else "")))
    for ref in message.get("reference") or []:
        brut = json.dumps(ref, ensure_ascii=False)
        if not _INDICES.search(brut):
            continue
        texte = ref.get("unstructured") or " ".join(
            str(ref.get(k, "")) for k in ("author", "year", "article-title", "volume-title"))
        if ref.get("type"):
            texte += f" [{ref['type']}]"
        urls = []
        if ref.get("DOI"):
            urls.append(f"https://doi.org/{ref['DOI']}")
        urls += re.findall(r"https?://[^\s\"<>]+|swh:1:\w{3}:[0-9a-f]{40}[^\s\"<>]*", texte)
        auteurs = tuple(a for a in [ref.get("author", "")] if a)
        for u in dict.fromkeys(urls):
            occs.append(Occurrence(u, texte[:600], ("References (Crossref)",), "references",
                                   "crossref:reference", ref_auteurs=auteurs,
                                   ref_annee=str(ref.get("year", ""))))
    return occs


def occurrences_datacite(client: Client, doi: str) -> list[Occurrence]:
    """Les objets DataCite (logiciels, jeux de données) qui déclarent l'article."""
    r = client.get(DATACITE, params={
        "query": f'relatedIdentifiers.relatedIdentifier:"{doi}"', "page[size]": "25"},
        ttl_s=7 * 86400)
    if not r.ok:
        return []
    occs = []
    for x in (r.json() or {}).get("data", []):
        a = x.get("attributes", {})
        genre = (a.get("types") or {}).get("resourceTypeGeneral", "")
        if genre not in ("Software", "Dataset", "ComputationalNotebook", "Workflow", "Model"):
            continue
        titre = ((a.get("titles") or [{}])[0]).get("title", "")
        rel = next((ri.get("relationType", "") for ri in a.get("relatedIdentifiers", [])
                    if doi.lower() in str(ri.get("relatedIdentifier", "")).lower()), "")
        phrase = f"DataCite : {genre} « {titre[:120]} » ({rel} l'article)"
        occs.append(Occurrence(f"https://doi.org/{x['id']}", phrase, ("DataCite",),
                               "metadonnees", f"datacite:{genre}:propre"))
        # Le logiciel archivé nomme souvent le dépôt GitHub d'où il vient.
        for ri in a.get("relatedIdentifiers", []):
            cible = str(ri.get("relatedIdentifier", ""))
            if re.search(r"github\.com|gitlab\.com", cible, re.I):
                occs.append(Occurrence(cible, phrase + f" — source {ri.get('relationType', '')}",
                                       ("DataCite",), "metadonnees", f"datacite:{genre}:propre"))
    return occs
