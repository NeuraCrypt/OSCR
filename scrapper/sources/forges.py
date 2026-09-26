"""La recherche À L'ENVERS : les dépôts qui citent l'article, sans que l'article les cite.

**Pourquoi.** Un auteur publie souvent son code APRÈS l'article, ou oublie de
le citer ; mais il écrit le DOI dans le README pour qu'on cite son article.
Mesuré le 25/09/2026 : pour eLife 10.7554/eLife.100605, la recherche GitHub
« DOI dans le README » rend exactement les deux dépôts des auteurs ; pour
MEG-SCANS, le dépôt de l'auteur et deux miroirs de données. Pour des articles
de la semaine, rien encore — le README n'est pas à jour. Cette voie sert
surtout les articles ANCIENS.

**Le piège.** Un README qui cite le DOI peut être celui des auteurs, une
réimplémentation par d'autres, ou une liste de lecture (« awesome-… »). On ne
dit « code des auteurs » que si le COMPTE porte le nom d'un auteur ; sinon le
dépôt est gardé comme « inconnu », visible dans la fiche, jamais compté.

**Le débit.** L'API de recherche accorde 10 requêtes/minute sans jeton, 30
avec. Elle n'est donc appelée par défaut que si `GITHUB_TOKEN` existe (GitHub
Actions le fournit), ou sur demande (`--recherche-github`).

Hugging Face ne couvre que les articles arXiv : pour eux, la page d'article
(`/api/papers/<id>`) nomme parfois le dépôt GitHub.
"""
from __future__ import annotations

import re
import unicodedata

from ..jats import Occurrence
from ..reseau import Client

#: Les dépôts-listes : ils citent cent articles, aucun n'est le leur.
_LISTES = re.compile(r"awesome|reading|paper[-_ ]?list|papers$|survey|curated|collection"
                     r"|bibliograph|resources|literature|citations?", re.I)


def _plat(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower())
                   if c.isalnum() and not unicodedata.combining(c))


def compte_d_auteur(compte: str, auteurs: list[str]) -> str:
    """Le nom d'auteur que porte le compte (« schmidtfa » → « Schmidt »), ou ''."""
    c = _plat(compte)
    for a in auteurs:
        n = _plat(a)
        if len(n) >= 4 and n in c:
            return a
    return ""


def occurrences_github(client: Client, doi: str, auteurs: list[str]) -> list[Occurrence]:
    if not doi:
        return []
    r = client.get("https://api.github.com/search/repositories",
                   params={"q": f'"{doi}" in:readme', "per_page": "20"}, ttl_s=7 * 86400)
    if not r.ok:
        return []
    occs = []
    for d in (r.json() or {}).get("items", []):
        nom, desc = d.get("full_name", ""), d.get("description") or ""
        if _LISTES.search(d.get("name", "")) or _LISTES.search(desc[:60]):
            continue
        auteur = compte_d_auteur(d.get("owner", {}).get("login", ""), auteurs)
        phrase = (f"Le README de {nom} cite le DOI de l'article"
                  + (f" ; le compte porte le nom de l'auteur {auteur}" if auteur else ""))
        occs.append(Occurrence(d.get("html_url", f"https://github.com/{nom}"), phrase,
                               ("GitHub",), "metadonnees",
                               "github:readme" + (":propre" if auteur else "")))
    return occs


def arxiv_de(doi: str) -> str:
    m = re.match(r"10\.48550/arxiv\.(.+)$", doi or "", re.I)
    return m.group(1) if m else ""


def occurrences_huggingface(client: Client, arxiv: str) -> list[Occurrence]:
    if not arxiv:
        return []
    r = client.get(f"https://huggingface.co/api/papers/{arxiv}", ttl_s=7 * 86400)
    if not r.ok:
        return []
    d = r.json() or {}
    depot = d.get("githubRepo") or ""
    if not depot:
        return []
    return [Occurrence(depot, f"La page Hugging Face de l'article (arXiv {arxiv}) nomme ce dépôt",
                       ("Hugging Face",), "metadonnees", "hf:papier:propre")]
