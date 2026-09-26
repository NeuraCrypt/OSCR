"""Le passage : scanner des articles, vérifier leurs dépôts, conclure, importer.

Un article passe par quatre temps, chacun écrit dans la base avant le suivant
— un passage interrompu reprend là où il s'est arrêté :

1. LIRE. Le plein texte JATS (Europe PMC), sinon rien ; toujours les
   métadonnées DataCite ; Crossref quand il n'y a pas de texte.
2. JUGER. Chaque lien reçoit un rôle (`role.py`) et le meilleur verdict par
   dépôt est gardé (`trouver.py`).
3. VÉRIFIER. Les dépôts susceptibles de porter du code sont interrogés
   (`depots.py`) — une seule fois par dépôt, revérifiés tous les 30 jours.
4. CONCLURE. La vérification peut corriger le texte, et le dit : un dépôt
   « de données » qui contient 50 scripts Python porte du code ; une fiche
   Zenodo « dataset » sans aucun script n'en porte pas. Puis le statut de
   l'article, les lignes de la bibliothèque, la fiche JSON.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

from . import base, depots, importer, jats, liens, methodes, trouver
from .reseau import Client, Panne
from .sources import europepmc, forges, metadonnees


@dataclass
class Options:
    base: Path = Path("donnees/bibliotheque.db")
    cache: Path = Path("donnees/cache")
    clones: Path = Path("donnees/clones")
    biblio: Path = Path("bibliotheque")
    verifier: bool = True
    metadonnees: bool = True
    swh: bool = True
    instantanes: bool = False
    #: Rapatrier le TEXTE des scripts dans la table `fichier` (le volet « Scripts »).
    contenus: bool = True
    #: La recherche GitHub « DOI dans le README » : 10 requêtes/min sans jeton,
    #: 30 avec. Par défaut, seulement quand un jeton est là.
    recherche_github: bool = field(default_factory=lambda: bool(os.environ.get("GITHUB_TOKEN")))
    reverifier_apres_j: int = 30
    #: Seuil de promotion : un dépôt « de données » qui contient au moins tant
    #: de scripts, et au moins 20 % de scripts parmi ses fichiers, porte du code.
    scripts_pour_promouvoir: int = 5
    #: Écrire `bibliotheque/<article>/fiche.json`, pour un dépôt GitHub qui
    #: versionne la bibliothèque. La veille du Mac s'en passe : la base fait
    #: foi, et 600 000 dossiers d'une fiche n'aideraient personne.
    fiches: bool = True


@dataclass
class Compte:
    articles: int = 0
    avec_code: int = 0
    verifies: int = 0
    erreurs: int = 0
    statuts: dict[str, int] = field(default_factory=dict)
    #: Le passage s'est arrêté sur son échéance, pas au bout de la requête.
    interrompu: bool = False

    def __str__(self) -> str:
        s = ", ".join(f"{k} {v}" for k, v in sorted(self.statuts.items(), key=lambda kv: -kv[1]))
        return (f"{self.articles} articles, {self.avec_code} avec code des auteurs, "
                f"{self.verifies} dépôts vérifiés, {self.erreurs} erreurs — {s}")


def _noms_de_famille(auteurs: list[str]) -> list[str]:
    """« Smith J » → « Smith » (Europe PMC écrit `fullName` ainsi)."""
    sortie = []
    for a in auteurs:
        parts = a.replace(",", " ").split()
        if len(parts) >= 2 and re.fullmatch(r"[A-Z]{1,3}", parts[-1]):
            sortie.append(" ".join(parts[:-1]))
        elif parts:
            sortie.append(parts[0])
    return sortie


def scanner_article(con: sqlite3.Connection, client: Client, art: europepmc.ArticleEPMC,
                    opts: Options, xml: str | None = None, compte: Compte | None = None) -> str:
    base.enregistrer_article(con, art.en_dict())
    if xml is None and art.id_texte:
        xml = europepmc.plein_texte(client, art.id_texte)
    familles: list[str] = []
    noms: list[str] = []
    if xml:
        texte = jats.lire(xml)
        bilan = trouver.depuis_le_texte(texte)
        auteurs = texte.auteurs or _noms_de_famille(art.auteurs)
        titre = texte.titre or art.titre
        familles, noms = methodes.reconnaitre(texte.methodes)
        if not art.doi and texte.doi:
            art.doi = texte.doi
    else:
        bilan = trouver.Bilan()
        auteurs = _noms_de_famille(art.auteurs)
        titre = art.titre
    if opts.metadonnees and art.doi:
        occs = metadonnees.occurrences_datacite(client, art.doi)
        if not xml:
            msg = metadonnees.crossref(client, art.doi)
            occs += metadonnees.occurrences_crossref(msg)
            auteurs = auteurs or metadonnees.auteurs_crossref(msg)
            titre = titre or " ".join(msg.get("title", []))
        if opts.recherche_github:
            occs += forges.occurrences_github(client, art.doi, auteurs)
        occs += forges.occurrences_huggingface(client, forges.arxiv_de(art.doi))
        if occs:
            bilan.candidats = trouver.fusionner(
                bilan.candidats, trouver.depuis_les_metadonnees(occs, auteurs, titre))
    base.remplacer_liens(con, art.id, bilan.candidats)
    base.marquer_scan(con, art.id, plein_texte=bool(xml), a_declaration=bilan.a_une_declaration,
                      code_sur_demande=bilan.code_sur_demande,
                      donnees_sur_demande=bilan.donnees_sur_demande,
                      familles=familles, methodes=noms)
    con.commit()
    if opts.verifier:
        n = verifier_article(con, client, art.id, opts)
        if compte is not None:
            compte.verifies += n
    statut = conclure(con, art.id, opts)
    con.commit()
    return statut


def _a_verifier(role: str, genre: str) -> bool:
    """On vérifie ce qui peut porter le code des auteurs, pas les outils tiers."""
    if role == "outil_tiers":
        return False
    if role == "code":
        return True
    return genre in ("forge", "archive", "execution", "modele")


def verifier_article(con: sqlite3.Connection, client: Client, article_id: str,
                     opts: Options) -> int:
    a = dict(con.execute("SELECT doi, titre FROM article WHERE id = ?", (article_id,)).fetchone())
    faits = 0
    lignes = con.execute("SELECT l.*, d.verifie_le, d.etat FROM lien l JOIN depot d "
                         "ON d.norme = l.norme WHERE l.article_id = ?", (article_id,)).fetchall()
    for l in lignes:
        if not _a_verifier(l["role"], l["genre"]):
            continue
        if not _frais(l, opts):
            # Un fichier joint (« elife-98759-code1.zip ») n'est pas une adresse :
            # normalisé, « .zip » passait pour un domaine, interrogé 8 fois en vain.
            lien = None if l["genre"] == "supplementaire" else liens.normaliser(l["url"])
            if lien is None:
                lien = liens.Lien(l["url"], l["norme"], l["hote"], l["genre"],
                                  identifiant=l["norme"].split("/", 1)[-1])
            base.enregistrer_depot(con, l["norme"], _verifier_un(client, lien, a, opts))
            faits += 1
        # La fiche Zenodo nomme le dépôt GitHub d'où vient l'archive : on
        # l'ajoute avec le même rôle, à CHAQUE lecture de l'article — que la
        # fiche vienne d'être vérifiée ou non. Ajouté seulement au moment de
        # la vérification, un nouveau scan le perdait (mesuré le 25/09/2026).
        d = con.execute("SELECT lie_a FROM depot WHERE norme = ?", (l["norme"],)).fetchone()
        source = (d["lie_a"] if d else "") or ""
        lien_source = liens.normaliser(source) if source else None
        # La source d'une archive : le GitHub d'une fiche Zenodo, ou le
        # logiciel Zenodo compagnon d'un DOI Dryad.
        if lien_source and lien_source.norme != l["norme"] and (
                lien_source.est_depot_git or lien_source.norme.startswith("zenodo:")):
            if not con.execute("SELECT 1 FROM lien WHERE article_id=? AND norme=?",
                               (article_id, lien_source.norme)).fetchone():
                con.execute(
                    "INSERT INTO lien (article_id, norme, url, hote, genre, role, confiance, ecart, "
                    "trouve_par, section, raisons) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (article_id, lien_source.norme, lien_source.url, lien_source.hote,
                     lien_source.genre, l["role"], l["confiance"], l["ecart"],
                     "dryad:logiciel" if l["norme"].startswith("doi:10.5061/dryad") else "zenodo:source",
                     l["section"], json.dumps([f"source déclarée par la fiche de {l['norme']}"],
                                              ensure_ascii=False)))
                con.execute("INSERT OR IGNORE INTO depot (norme, url, hote, genre) VALUES (?,?,?,?)",
                            (lien_source.norme, lien_source.url, lien_source.hote, lien_source.genre))
            ds = con.execute("SELECT verifie_le, etat FROM depot WHERE norme = ?",
                             (lien_source.norme,)).fetchone()
            if not _frais(ds, opts):
                base.enregistrer_depot(con, lien_source.norme,
                                       _verifier_un(client, lien_source, a, opts))
                faits += 1
        con.commit()
    return faits


def _frais(ligne: sqlite3.Row | None, opts: Options) -> bool:
    """Vérifié il y a moins de `reverifier_apres_j` jours, et pas en panne."""
    return bool(ligne is not None and ligne["verifie_le"]
                and time.time() - ligne["verifie_le"] < opts.reverifier_apres_j * 86400
                and ligne["etat"] not in ("inaccessible", "a_verifier"))


def _verifier_un(client: Client, lien: liens.Lien, article: dict[str, Any],
                 opts: Options) -> dict[str, Any]:
    try:
        return depots.verifier(client, lien, article, opts.clones, swh=opts.swh,
                               avec_contenus=opts.contenus)
    except Exception as e:  # une vérification ratée ne doit pas tuer le passage
        return {"etat": "inaccessible", "erreur": f"{type(e).__name__}: {e}"[:300]}


def _ajuster(con: sqlite3.Connection, article_id: str, l: sqlite3.Row, d: sqlite3.Row | None,
             opts: Options, date_pub: str) -> str:
    """Ce que la vérification change au rôle du texte. Rend le rôle final."""
    role = l["role"]
    if d is None or d["etat"] != "vivant":
        return role
    nouveau, pourquoi = role, ""
    nb = d["nb_scripts"]
    fichiers = d["nb_fichiers"] or 0
    # Un dépôt de code, c'est des scripts ET une part réelle de scripts : un
    # jeu BIDS de 2 141 fichiers qui porte 3 scripts de conversion n'en est pas un.
    beaucoup = (nb or 0) >= opts.scripts_pour_promouvoir and (
        (nb or 0) >= 20 or (nb or 0) / max(1, fichiers) >= 0.2)
    if role in ("donnees", "inconnu") and l["genre"] == "forge" and beaucoup \
            and d["type_ressource"] != "bids":
        nouveau, pourquoi = "code", f"code+ le dépôt contient {nb} scripts sur {fichiers} fichiers"
    elif role in ("donnees", "inconnu") and d["type_ressource"] == "software":
        nouveau, pourquoi = "code", "code+ la fiche de l'archive dit « software »"
    elif role == "code" and d["type_ressource"] in ("dataset", "osf-data") and nb == 0:
        nouveau, pourquoi = "donnees", "donnees+ l'archive est un jeu de données sans aucun script"
    elif role == "code" and d["type_ressource"] == "bids" and (nb or 0) < 20:
        nouveau, pourquoi = "donnees", f"donnees+ le dépôt est un jeu BIDS ({nb or 0} scripts)"
    elif role == "code" and (d["etoiles"] or 0) >= 500 and d["cree_le"] and date_pub \
            and d["cree_le"] < _moins_un_an(date_pub) and d["cite_article"] == "":
        nouveau, pourquoi = "outil_tiers", (f"outil_tiers+ {d['etoiles']} étoiles, créé le "
                                            f"{d['cree_le']}, bien avant l'article")
    if nouveau != role:
        raisons = json.loads(l["raisons"] or "[]") + [pourquoi]
        con.execute("UPDATE lien SET role=?, raisons=? WHERE article_id=? AND norme=?",
                    (nouveau, json.dumps(raisons, ensure_ascii=False), article_id, l["norme"]))
    return nouveau


def _moins_un_an(date_pub: str) -> str:
    try:
        return (date.fromisoformat(date_pub[:10]) - timedelta(days=365)).isoformat()
    except ValueError:
        return ""


def conclure(con: sqlite3.Connection, article_id: str, opts: Options) -> str:
    a = con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone()
    lignes = con.execute("SELECT * FROM lien WHERE article_id = ?", (article_id,)).fetchall()
    codes: list[tuple[sqlite3.Row, sqlite3.Row | None]] = []
    a_des_donnees = False
    for l in lignes:
        d = con.execute("SELECT * FROM depot WHERE norme = ?", (l["norme"],)).fetchone()
        role = _ajuster(con, article_id, l, d, opts, a["date_pub"])
        if role == "code":
            codes.append((l, d))
        elif role == "donnees":
            a_des_donnees = True

    con.execute("DELETE FROM script WHERE article_id = ? AND origine = 'natif'", (article_id,))
    etats = []
    for l, d in codes:
        etat = d["etat"] if d is not None else "a_verifier"
        # Vivant mais sans aucun script reconnu (`megabtaufdg` : un README et
        # un fichier sans extension) : le dépôt existe, le code annoncé n'y est
        # pas encore. Un ZIP (compte inconnu) ou une fiche « software » passent.
        if etat == "vivant" and d is not None and d["nb_scripts"] == 0 \
                and d["type_ressource"] != "software" and l["genre"] not in ("execution", "modele"):
            etat = "vide"
        etats.append(etat)
        if etat in ("vivant", "vide") and d["nb_fichiers"] is not None:
            niveau = "inventorie"
        elif etat in ("vivant", "vide"):
            niveau = "vivant"
        else:
            niveau = "trouve"
        con.execute("INSERT INTO script (article_id, origine, norme, niveau, commit_) "
                    "VALUES (?, 'natif', ?, ?, ?)",
                    (article_id, l["norme"], niveau, (d["commit_"] if d is not None else "") or ""))

    if any(e == "vivant" for e in etats):
        statut = "code_verifie"
    elif any(e in ("a_verifier", "non_verifiable", "inaccessible") for e in etats):
        statut = "code_trouve"
    elif any(e == "vide" for e in etats):
        statut = "code_vide"
    elif etats:
        statut = "code_mort"
    elif a["code_sur_demande"]:
        statut = "sur_demande"
    elif a_des_donnees:
        statut = "donnees_seules"
    elif not a["plein_texte"]:
        statut = "sans_texte"
    else:
        statut = "aucun"
    con.execute("UPDATE article SET statut = ?, modifie_le = ? WHERE id = ?",
                (statut, time.time(), article_id))
    if opts.instantanes:
        for l, d in codes:
            if d is not None and d["etat"] == "vivant":
                lien = liens.normaliser(l["url"])
                if lien is not None and lien.est_depot_git:
                    importer.instantane(con, article_id, l["norme"], lien.url_git,
                                        opts.biblio, opts.clones)
    if opts.fiches:
        importer.ecrire_fiche(con, article_id, opts.biblio)
    return statut


def scanner_requete(con: sqlite3.Connection, client: Client, q: str, opts: Options, *,
                    maximum: int | None = None, deja: str = "sauter",
                    echeance: float | None = None,
                    rapport: Callable[[str], None] = print) -> Compte:
    """Scanner tous les articles d'une requête Europe PMC — ou jusqu'à `echeance`
    (horodatage), pour qu'un passage planifié rende la main à l'heure."""
    compte = Compte()
    for art in europepmc.parcourir(client, q, maximum=maximum):
        if echeance is not None and time.time() >= echeance:
            compte.interrompu = True
            break
        vu = con.execute("SELECT scanne_le FROM article WHERE id = ?", (art.id,)).fetchone()
        if vu and vu["scanne_le"] and deja == "sauter":
            continue
        try:
            statut = scanner_article(con, client, art, opts, compte=compte)
        except Panne:
            # Le réseau, pas l'article : on arrête le passage au lieu de
            # l'échouer article par article (chacun coûterait 4 essais).
            con.rollback()
            raise
        except Exception as e:
            compte.erreurs += 1
            base.journaliser(con, "erreur_article", article=art.id, erreur=f"{type(e).__name__}: {e}")
            con.commit()
            rapport(f"  ! {art.id} : {type(e).__name__}: {e}")
            continue
        compte.articles += 1
        compte.statuts[statut] = compte.statuts.get(statut, 0) + 1
        if statut.startswith("code_"):
            compte.avec_code += 1
        if compte.articles % 25 == 0:
            rapport(f"  … {compte}")
    return compte


def tourner(con: sqlite3.Connection, client: Client, domaine: str, opts: Options, *,
            jours_initiaux: int = 7, maximum: int | None = None,
            rapport: Callable[[str], None] = print) -> Compte:
    """Le passage incrémental : de la dernière date vue jusqu'à aujourd'hui.

    Le curseur est la date de première publication du dernier passage ; on
    repart de la VEILLE, parce qu'Europe PMC indexe avec quelques jours de
    retard et qu'un article déjà vu est sauté sans coût.
    """
    cle = f"europepmc:{domaine}"
    aujourdhui = date.today()
    depuis = base.curseur(con, cle, (aujourdhui - timedelta(days=jours_initiaux)).isoformat())
    depuis = (date.fromisoformat(depuis) - timedelta(days=3)).isoformat()
    q = europepmc.requete(domaine, depuis, aujourdhui.isoformat())
    rapport(f"Europe PMC « {domaine} » du {depuis} au {aujourdhui.isoformat()}")
    compte = scanner_requete(con, client, q, opts, maximum=maximum, rapport=rapport)
    base.poser_curseur(con, cle, aujourdhui.isoformat())
    base.journaliser(con, "passage", domaine=domaine, depuis=depuis, articles=compte.articles,
                     avec_code=compte.avec_code, erreurs=compte.erreurs, requetes=client.compteur)
    con.commit()
    return compte


def _mois_precedent(mois: str) -> str:
    a, m = map(int, mois.split("-"))
    return f"{a - 1}-12" if m == 1 else f"{a}-{m - 1:02d}"


def _bornes(mois: str) -> tuple[str, str]:
    a, m = map(int, mois.split("-"))
    fin = date(a + (m == 12), 1 if m == 12 else m + 1, 1) - timedelta(days=1)
    return f"{mois}-01", fin.isoformat()


def rattraper(con: sqlite3.Connection, client: Client, domaine: str, opts: Options, *,
              duree_max_s: float, jusqu_en: int = 2000,
              rapport: Callable[[str], None] = print) -> Compte:
    """Le RATTRAPAGE du stock : remonter le passé, mois par mois, dans un budget de temps.

    Le passage quotidien suit le flux (~200 articles neuro par jour en 2025) ;
    le stock, lui, compte 614 336 articles neuro en accès libre (mesuré le
    26/09/2026). On le prend par tranches : chaque passage consacre au plus
    `duree_max_s` au passé, en partant du mois le plus récent non traité, et
    note où il s'est arrêté (curseur `rattrapage:<domaine>`). Un mois
    interrompu est repris au passage suivant ; ses articles déjà lus sont
    sautés sans coût.
    """
    cle = f"rattrapage:{domaine}"
    aujourdhui = date.today()
    # Le mois EN COURS, pas le précédent : les nouveautés ne remontent que de
    # 7 jours, et le début du mois tombait entre les deux. Les articles déjà
    # lus par les nouveautés sont sautés sans coût.
    defaut = f"{aujourdhui.year}-{aujourdhui.month:02d}"
    mois = base.curseur(con, cle, defaut)
    echeance = time.time() + duree_max_s
    total = Compte()
    while mois >= f"{jusqu_en}-01" and time.time() < echeance:
        debut, fin = _bornes(mois)
        # Noté dès le début : l'interface montre le mois en cours.
        base.poser_curseur(con, cle, mois)
        con.commit()
        rapport(f"Rattrapage « {domaine} » : {mois}")
        c = scanner_requete(con, client, europepmc.requete(domaine, debut, fin), opts,
                            echeance=echeance, rapport=rapport)
        total.articles += c.articles
        total.avec_code += c.avec_code
        total.verifies += c.verifies
        total.erreurs += c.erreurs
        for k, v in c.statuts.items():
            total.statuts[k] = total.statuts.get(k, 0) + v
        if c.interrompu:
            total.interrompu = True
            break
        mois = _mois_precedent(mois)
        base.poser_curseur(con, cle, mois)
        con.commit()
    base.journaliser(con, "rattrapage", domaine=domaine, jusqu_a=mois, articles=total.articles,
                     avec_code=total.avec_code, erreurs=total.erreurs, termine=mois < f"{jusqu_en}-01")
    con.commit()
    return total


def stock_termine(con: sqlite3.Connection, domaine: str, jusqu_en: int) -> bool:
    mois = base.curseur(con, f"rattrapage:{domaine}", "")
    return bool(mois) and mois < f"{jusqu_en}-01"


def reverifier(con: sqlite3.Connection, client: Client, opts: Options, *,
               maximum: int | None = None, echeance: float | None = None) -> int:
    """Revérifier les dépôts de code périmés (plus de `reverifier_apres_j`
    jours) ou restés inaccessibles — une coupure pendant la vérification ne
    doit pas les laisser en panne pour toujours. Rend le nombre d'articles repris."""
    ids = [r["id"] for r in con.execute(
        "SELECT DISTINCT l.article_id AS id FROM lien l JOIN depot d ON d.norme = l.norme "
        "WHERE l.role != 'outil_tiers' AND (l.role = 'code' OR l.genre IN "
        "('forge', 'archive', 'execution', 'modele')) "
        "AND (d.etat IN ('a_verifier', 'inaccessible') OR d.verifie_le < ?)",
        (time.time() - opts.reverifier_apres_j * 86400,))]
    faits = 0
    for i in ids[: maximum or None]:
        if echeance is not None and time.time() >= echeance:
            break
        verifier_article(con, client, i, opts)
        conclure(con, i, opts)
        con.commit()
        faits += 1
    return faits


def _heure() -> str:
    return time.strftime("%Y-%m-%d %H:%M")


def veiller(con: sqlite3.Connection, client: Client, domaine: str, opts: Options, *,
            nouveautes_s: float = 3600, tranche_s: float = 1800, repos_s: float = 900,
            reverification_s: float = 86400, jusqu_en: int = 2000,
            duree_max_s: float | None = None, iterations: int | None = None,
            rapport: Callable[[str], None] = print) -> None:
    """La VEILLE : le ramasseur en continu, sur une machine qui n'a pas de quota d'heures.

    Une boucle, que launchd range en tâche de fond :

    - toutes les `nouveautes_s` : les articles parus depuis le dernier passage ;
    - une fois par `reverification_s` : les dépôts de code périmés ou restés
      inaccessibles, dans une tranche de temps ;
    - entre deux : une tranche de `tranche_s` du stock, mois par mois vers le
      passé, reprise là où la précédente s'est arrêtée ;
    - le stock épuisé : une sieste de `repos_s` entre deux coups d'œil aux
      nouveautés. Le processus ne fait alors presque rien.

    Une panne (réseau coupé, Mac qui se réveille, serveur saturé) n'arrête pas
    la veille : elle attend, de 2 minutes à 1 heure, et reprend ; au bout de
    deux heures de pannes, elle s'arrête et launchd en relance une neuve. Rien ne se
    perd à l'arrêt : chaque article est écrit dans sa propre transaction, et
    les curseurs disent où reprendre. Après `duree_max_s`, elle rend la main
    (launchd la relance) : la mémoire d'un processus Python ne gonfle pas sur
    des semaines.
    """
    debut = time.time()
    derniere_nouveaute = 0.0
    pannes = 0
    tours = 0
    erreurs = lambda m: m.startswith("  !") and rapport(m)  # noqa: E731 — les erreurs seulement
    while iterations is None or tours < iterations:
        if duree_max_s is not None and time.time() - debut >= duree_max_s:
            rapport(f"{_heure()} fin de cycle ({duree_max_s / 3600:.0f} h) : relance par launchd")
            return
        tours += 1
        try:
            if time.time() - derniere_nouveaute >= nouveautes_s:
                client.compteur.clear()
                c = tourner(con, client, domaine, opts, rapport=erreurs)
                derniere_nouveaute = time.time()
                rapport(f"{_heure()} nouveautés : {c}")
            if time.time() - float(base.curseur(con, "veille:reverification", "0")) >= reverification_s:
                n = reverifier(con, client, opts, echeance=time.time() + tranche_s)
                base.poser_curseur(con, "veille:reverification", str(time.time()))
                con.commit()
                rapport(f"{_heure()} revérification : {n} articles repris")
            if stock_termine(con, domaine, jusqu_en):
                time.sleep(repos_s)
            else:
                client.compteur.clear()
                c = rattraper(con, client, domaine, opts, duree_max_s=tranche_s, jusqu_en=jusqu_en,
                              rapport=erreurs)
                mois = base.curseur(con, f"rattrapage:{domaine}", "")
                rapport(f"{_heure()} stock (reprise en {mois}) : {c}")
            pannes = 0
        except Exception as e:  # une panne ne doit pas tuer la veille…
            try:
                con.rollback()
            except sqlite3.Error:
                pass
            pannes += 1
            # Une page d'erreur nginx tient en une ligne une fois ses balises ôtées.
            bref = " ".join(re.sub(r"<[^>]*(>|$)", " ", str(e)).split())[:160]
            if pannes > 6:
                # …sauf si elle dure deux heures (le disque débranché, un
                # défaut) : un processus neuf, relancé par launchd, repart propre.
                rapport(f"{_heure()} ! {pannes} pannes de suite, arrêt : {type(e).__name__}: {bref}")
                raise
            attente = min(3600, 60 * 2 ** pannes)
            rapport(f"{_heure()} ! {type(e).__name__}: {bref} — reprise dans {attente // 60:.0f} min")
            time.sleep(attente)


def scanner_dossier(con: sqlite3.Connection, client: Client, dossier: Path, opts: Options,
                    rapport: Callable[[str], None] = print) -> Compte:
    """Scanner des fichiers JATS déjà sur le disque (corpus d'essai, banc)."""
    compte = Compte()
    for f in sorted(Path(dossier).glob("*.xml")):
        xml = f.read_text()
        t = jats.lire(xml)
        pmcid = t.pmcid or (f.stem if f.stem.upper().startswith("PMC") else "")
        art = europepmc.ArticleEPMC(id=europepmc.identifiant(t.doi, pmcid, f.stem), doi=t.doi,
                                    pmcid=pmcid, titre=t.titre, date_pub=t.annee,
                                    source=f"fichier:{f.name}")
        statut = scanner_article(con, client, art, opts, xml=xml, compte=compte)
        compte.articles += 1
        compte.statuts[statut] = compte.statuts.get(statut, 0) + 1
        compte.avec_code += statut.startswith("code_")
    return compte
