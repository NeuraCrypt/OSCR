"""Trouver le code d'un article : rassembler les liens, juger leur rôle, un verdict par dépôt.

Un même dépôt revient souvent plusieurs fois dans un article — dans les
Méthodes, dans la section de disponibilité, dans les références. Chaque
occurrence est jugée seule (`role.juger`), puis les verdicts d'un même dépôt
sont réunis : on garde l'occurrence la plus probante, et on compte les autres.

Le résultat est une liste de `Candidat` : un dépôt normé, son rôle, sa
confiance, l'endroit où il a été trouvé, et les raisons du verdict.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import jats, liens, role

#: Les extensions d'un fichier de SCRIPT joint en matériel supplémentaire.
EXT_SCRIPT = re.compile(r"\.(m|py|r|ipynb|jl|c|cpp|h|java|js|sh|rmd|mlx)$", re.I)
#: Une archive jointe n'est du code que si sa légende le dit (« Source code 1 »).
EXT_ARCHIVE = re.compile(r"\.(zip|tar|gz|tgz|7z|rar)$", re.I)
# « function » n'en fait pas partie : « response function » est dans mille
# légendes de figures. Mesuré sur l'étalon Zenodo (25/09/2026) : des .docx,
# .xlsx, .eps et .png y passaient pour du code.
LEGENDE_CODE = re.compile(r"\b(source )?codes?\b|\bscripts?\b|\bmatlab\b|\bpython\b"
                          r"|\bnotebooks?\b|\bsoftware\b|\btoolbox\b", re.I)

#: Ordre de préférence des lieux quand deux verdicts se valent.
_PRIORITE_LIEU = {"disponibilite": 0, "tableau": 1, "corps": 2, "supplementaire": 3,
                  "references": 4, "notes": 5, "annexe": 6, "fond": 7, "remerciements": 8}


@dataclass
class Candidat:
    lien: liens.Lien
    role: str
    confiance: str
    ecart: float
    trouve_par: str                       # texte:<lieu> | crossref | datacite | github …
    extrait: str = ""                     # la phrase — usage interne, jamais publiée
    section: str = ""
    raisons: list[str] = field(default_factory=list)
    scores: dict[str, float] = field(default_factory=dict)
    occurrences: int = 1


@dataclass
class Bilan:
    """Ce que le texte d'un article dit de son code."""

    candidats: list[Candidat] = field(default_factory=list)
    code_sur_demande: bool = False
    donnees_sur_demande: bool = False
    a_une_declaration: bool = False
    declarations: list[str] = field(default_factory=list)   # usage interne


def _juger_tout(occurrences: list[jats.Occurrence], auteurs: list[str], titre: str,
                origine: str, par_norme: dict[str, list[Candidat]]) -> None:
    for occ in occurrences:
        lien = liens.normaliser(occ.url)
        if lien is None:
            continue
        if not _retenir(lien, occ):
            continue
        j = role.juger(occ, lien, auteurs, titre)
        trouve_par = f"{origine}:{occ.lieu}" if origine == "texte" else occ.type_section.removesuffix(":propre") or origine
        c = Candidat(lien, j.role, j.confiance, j.ecart, trouve_par,
                     occ.phrase, occ.titre_proche, j.raisons, j.scores)
        par_norme.setdefault(lien.norme, []).append(c)


def _meilleurs(par_norme: dict[str, list[Candidat]]) -> list[Candidat]:
    sortie = []
    for cs in par_norme.values():
        cs.sort(key=lambda c: (c.role == "inconnu", -max(c.scores.values(), default=0),
                               _PRIORITE_LIEU.get(c.trouve_par.split(":")[-1], 9)))
        cs[0].occurrences = len(cs)
        sortie.append(cs[0])
    return sortie


def depuis_les_metadonnees(occurrences: list[jats.Occurrence], auteurs: list[str],
                           titre: str) -> list[Candidat]:
    """Les dépôts que Crossref et DataCite rattachent à l'article."""
    par_norme: dict[str, list[Candidat]] = {}
    _juger_tout(occurrences, auteurs, titre, "metadonnees", par_norme)
    return _meilleurs(par_norme)


def fusionner(a: list[Candidat], b: list[Candidat]) -> list[Candidat]:
    """Réunir deux listes de candidats : un même dépôt garde son meilleur verdict.

    Sauf un cas : une voie dit « code », une autre « données » pour la MÊME
    archive. Les deux sont vraies — l'archive contient les deux —, et c'est le
    code qu'on cherche. Sur eLife 10.7554/elife.92344, le texte dit « the
    source code, are deposited in Dryad » et DataCite type le dépôt Dryad
    « Dataset » : le plus haut score (DataCite, 3,3 contre 2,8) écrasait le
    texte, et la bibliothèque perdait le code (étalon Zenodo, 25/09/2026).
    """
    par_norme: dict[str, list[Candidat]] = {}
    for c in a + b:
        par_norme.setdefault(c.lien.norme, []).append(c)
    fus = []
    for cs in par_norme.values():
        total = sum(c.occurrences for c in cs)
        codes = [c for c in cs if c.role == "code"]
        m = _meilleurs({"_": codes or cs})[0]
        autres = [c.trouve_par for c in cs if c.role == "donnees" and c is not m]
        if codes and autres:
            m.raisons = m.raisons + [f"la même archive est aussi déclarée « données » ({autres[0]})"]
        m.occurrences = total
        fus.append(m)
    return fus


def depuis_le_texte(texte: jats.TexteArticle) -> Bilan:
    """Tous les dépôts que l'article cite, avec leur rôle."""
    par_norme: dict[str, list[Candidat]] = {}
    _juger_tout(texte.occurrences, texte.auteurs, texte.titre, "texte", par_norme)

    for fichier, legende in texte.supplementaires:
        nom = fichier.rsplit("/", 1)[-1]
        if not nom:
            continue
        if EXT_SCRIPT.search(nom) or (EXT_ARCHIVE.search(nom) and LEGENDE_CODE.search(legende)):
            ident = texte.pmcid or texte.doi
            lien = liens.Lien(nom, f"supp:{ident}/{nom}", "supplementaire",
                              "supplementaire", identifiant=nom)
            occ = jats.Occurrence(nom, legende[:600], ("Supplementary material",),
                                  "supplementaire", texte_lien=nom)
            j = role.juger(occ, lien, texte.auteurs)
            par_norme.setdefault(lien.norme, []).append(
                Candidat(lien, j.role, j.confiance, j.ecart, "texte:supplementaire",
                         legende[:600], "Supplementary material", j.raisons, j.scores))

    bilan = Bilan(candidats=_meilleurs(par_norme))

    for d in texte.declarations:
        bilan.a_une_declaration = True
        bilan.declarations.append(f"{d.titre} : {d.texte}"[:2000])
        for phrase in re.split(r"(?<=[.!?])\s+", d.texte):
            if role.SUR_DEMANDE.search(phrase):
                if role.NOMS_CODE.search(phrase):
                    bilan.code_sur_demande = True
                if role.NOMS_DONNEES.search(phrase):
                    bilan.donnees_sur_demande = True
    return bilan


def _retenir(lien: liens.Lien, occ: jats.Occurrence) -> bool:
    """Un lien `autre` (site de laboratoire, page d'éditeur) n'est gardé que si
    sa phrase parle de code : sinon on garderait chaque licence Creative
    Commons et chaque page d'accueil de revue."""
    if lien.genre != "autre":
        return True
    if re.search(r"creativecommons|orcid\.org|ror\.org|clinicaltrials|doi\.org"
                 r"|crossref|pubmed|scholar\.google|elsevier|springer|wiley|frontiersin"
                 r"|mdpi|plos|nature\.com|sciencedirect|biorxiv|medrxiv|arxiv\.org|acs\.org|rsc\.org"
                 r"|tandfonline|sagepub|oup\.com|cell\.com|science\.org|pnas\.org|jneurosci\.org"
                 r"|elifesciences|ieee\.org|iop\.org|aps\.org|karger|thieme|jamanetwork|bmj\.com"
                 r"|cambridge\.org|annualreviews|physiology\.org|jstage", lien.hote):
        return False
    return bool(role.NOMS_CODE_FORTS.search(occ.phrase) and role.VERBES_DISPO.search(occ.phrase))
