"""La ligne de commande du ramasseur.

    scrapper tourner                       le passage quotidien (incrémental)
    scrapper veiller                       en continu : nouveautés, stock, revérifications
    scrapper nuit                          la publication : tableau public, puis Hugging Face
    scrapper zenodo carte 10.xxx/yyy       la carte de traçage proposée d'un article
    scrapper zenodo deposer 10.xxx/yyy     son DOI Zenodo, si un auteur l'a validée (bac à sable)
    scrapper scanner --depuis 2015-01-01 --jusqua 2015-12-31 --max 500
    scrapper doi 10.7554/eLife.100605 10.1038/s41597-025-06397-4
    scrapper dossier donnees/corpus_essai  des JATS déjà sur le disque
    scrapper verifier                      revérifier les dépôts périmés
    scrapper tableau                       régénérer site/ (tableau + exports)
    scrapper etat                          les chiffres de la bibliothèque
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from datetime import date
from pathlib import Path

from . import base, tableau, tourner
from .reseau import Cache, Client
from .sources import europepmc


REGLAGES = Path.home() / ".config" / "scrapper" / "reglages"


def reglages(chemin: Path = REGLAGES) -> dict[str, str]:
    """Les réglages de l'installation Mac (`CLE=valeur`, `#` pour commenter).

    Python les lit lui-même : launchd ne peut pas lancer de script shell posé
    sur le disque externe (macOS refuse à /bin/zsh d'ouvrir le fichier, code
    127), alors qu'il laisse Python, et ce que Python lance, y lire et écrire."""
    sortie: dict[str, str] = {}
    try:
        lignes = chemin.read_text().splitlines()
    except OSError:
        return sortie
    for ligne in lignes:
        ligne = ligne.strip()
        if ligne and not ligne.startswith("#") and "=" in ligne:
            cle, valeur = ligne.split("=", 1)
            sortie[cle.strip()] = valeur.strip().strip("\"'")
    return sortie


def _options(a: argparse.Namespace) -> tourner.Options:
    return tourner.Options(base=Path(a.base), cache=Path(a.cache), clones=Path(a.clones),
                           biblio=Path(a.biblio), verifier=not a.sans_verifier,
                           metadonnees=not a.sans_metadonnees, swh=not a.sans_swh,
                           instantanes=a.instantanes,
                           reverifier_apres_j=0 if a.reverifier else 30, contenus=not a.sans_contenus,
                           fiches=not a.sans_fiches,
                           recherche_github=a.recherche_github or bool(os.environ.get("GITHUB_TOKEN")))


def _zenodo(con, a: argparse.Namespace) -> None:
    """Les cartes de traçage et leurs DOI (règles : CLAUDE.md, invenio.py)."""
    from . import invenio
    inv = invenio.Invenio(a.instance, jeton_=invenio.jeton(a.instance))
    try:
        article_id = None
        if a.action in ("carte", "valider", "deposer"):
            if not a.doi:
                raise SystemExit(f"zenodo {a.action} : le DOI de l'article manque")
            ligne = con.execute("SELECT id FROM article WHERE lower(doi) = lower(?)", (a.doi,)).fetchone()
            if ligne is None:
                raise SystemExit(f"{a.doi} n'est pas dans la base : `scrapper doi {a.doi}` d'abord")
            article_id = ligne["id"]
        if a.action == "carte":
            print(json.dumps(invenio.carte_de(con, article_id), ensure_ascii=False, indent=1))
        elif a.action == "valider":
            # Pour le DÉVELOPPEMENT : une validation d'essai, que seul le bac à
            # sable accepte. La vraie viendra de l'auteur, connecté par ORCID.
            carte = invenio.valider(con, article_id, orcid=a.orcid, nom=a.nom, preuve="essai")
            print(f"carte validée (essai) par {a.nom} ({a.orcid}) : {len(carte['code'])} dépôt(s)")
        elif a.action == "deposer":
            r = invenio.deposer_carte(con, inv, article_id, plateforme=a.plateforme,
                                      communaute=a.communaute, essai=a.essai)
            print(json.dumps(r, ensure_ascii=False, indent=1))
        elif a.action == "communaute":
            c = inv.communaute(a.communaute)
            if c is None and a.creer:
                c = inv.creer_communaute(
                    a.communaute, f"{a.plateforme} — neurosciences",
                    "Cartes de traçage code ↔ article, validées par leurs auteurs. Chaque carte relie un "
                    "article (IsSupplementTo) au dépôt de son code (References), sans redéposer le code.")
            print(f"{inv.base}/communities/{a.communaute}" + ("" if c else " : n'existe pas (--creer)"))
        elif a.action == "lies":
            for f in inv.liees_a(a.doi or ""):
                print(f["id"], (f.get("metadata") or {}).get("title", ""), (f.get("links") or {}).get("self_html", ""))
    except invenio.ErreurInvenio as e:
        raise SystemExit(str(e)) from None
    finally:
        inv.fermer()


def main(argv: list[str] | None = None) -> int:
    regl = reglages()
    p = argparse.ArgumentParser(prog="scrapper", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default="donnees/bibliotheque.db")
    p.add_argument("--cache", default="donnees/cache")
    p.add_argument("--clones", default="donnees/clones")
    p.add_argument("--biblio", default="bibliotheque")
    p.add_argument("--site", default="site")
    p.add_argument("--sans-verifier", action="store_true", help="ne pas interroger les dépôts")
    p.add_argument("--sans-metadonnees", action="store_true", help="ni Crossref ni DataCite")
    p.add_argument("--sans-swh", action="store_true", help="ne pas interroger Software Heritage")
    p.add_argument("--instantanes", action="store_true",
                   help="archiver les dépôts dont la licence le permet")
    p.add_argument("--reverifier", action="store_true",
                   help="revérifier tous les dépôts, même vérifiés récemment")
    p.add_argument("--sans-contenus", action="store_true",
                   help="ne pas rapatrier le texte des scripts")
    p.add_argument("--public", action="store_true",
                   help="tableau publiable : seuls les scripts dont la licence le permet y ont leur texte")
    p.add_argument("--miroir", default="",
                   help="recopier les scripts republiables dans ce dossier (pour un dépôt GitHub public)")
    p.add_argument("--recherche-github", action="store_true",
                   help="chercher les README qui citent le DOI (10/min sans jeton)")
    p.add_argument("--hors-ligne", action="store_true", help="le cache seulement")
    p.add_argument("--sans-fiches", action="store_true",
                   help="ne pas écrire bibliotheque/<article>/fiche.json (la base fait foi)")
    sp = p.add_subparsers(dest="commande", required=True)

    t = sp.add_parser("tourner", help="passage incrémental depuis le dernier curseur")
    t.add_argument("--domaine", default="neuro", help="neuro | electrophysiologie | une requête")
    t.add_argument("--jours", type=int, default=7, help="premier passage : tant de jours en arrière")
    t.add_argument("--max", type=int, default=None)

    s = sp.add_parser("scanner", help="scanner une plage de dates")
    s.add_argument("--domaine", default="neuro")
    s.add_argument("--depuis", required=True)
    s.add_argument("--jusqua", default=date.today().isoformat())
    s.add_argument("--max", type=int, default=None)
    s.add_argument("--rescanner", action="store_true", help="relire les articles déjà vus")

    # Par défaut, ce que disent les réglages (~/.config/scrapper/reglages).
    ve = sp.add_parser("veiller", help="tourner en continu : nouveautés chaque heure, le stock entre deux")
    ve.add_argument("--domaine", default=regl.get("SCRAPPER_DOMAINE", "neuro"))
    ve.add_argument("--nouveautes-minutes", type=float, default=regl.get("SCRAPPER_NOUVEAUTES_MINUTES", "60"))
    ve.add_argument("--tranche-minutes", type=float, default=regl.get("SCRAPPER_TRANCHE_MINUTES", "30"))
    ve.add_argument("--repos-minutes", type=float, default=15, help="sieste quand le stock est fini")
    ve.add_argument("--jusqu-en", type=int, default=regl.get("SCRAPPER_JUSQU_EN", "2000"))
    ve.add_argument("--heures-max", type=float, default=24,
                    help="rendre la main après tant d'heures (launchd relance un processus neuf)")

    r = sp.add_parser("rattraper", help="remonter le stock, mois par mois, dans un budget de temps")
    r.add_argument("--domaine", default="neuro")
    r.add_argument("--heures", type=float, default=1.0, help="budget de temps de ce passage")
    r.add_argument("--jusqu-en", type=int, default=2000, help="l'année la plus ancienne à remonter")

    d = sp.add_parser("doi", help="scanner des articles connus par leur DOI")
    d.add_argument("dois", nargs="*")
    d.add_argument("--fichier", help="un DOI par ligne")

    dos = sp.add_parser("dossier", help="scanner des fichiers JATS locaux")
    dos.add_argument("chemin")

    v = sp.add_parser("verifier", help="revérifier les dépôts périmés ou inaccessibles")
    v.add_argument("--max", type=int, default=None)

    sp.add_parser("tableau", help="régénérer le tableau et les exports")

    sv = sp.add_parser("serveur", help="l'interface : le tableau de la base (http://127.0.0.1:8790)")
    sv.add_argument("--port", type=int, default=8790)

    hf = sp.add_parser("publier-hf", help="publier le tableau et les scripts sur un jeu Hugging Face")
    hf.add_argument("depot_hf", help="identifiant du jeu, ex. : utilisateur/code-natif-neuro")
    hf.add_argument("--essai", action="store_true", help="préparer sans rien envoyer")
    sp.add_parser("etat", help="les chiffres de la bibliothèque")

    ze = sp.add_parser("zenodo", help="cartes de traçage : validation d'auteur, DOI Zenodo (bac à sable par défaut)")
    ze.add_argument("action", choices=["carte", "valider", "deposer", "communaute", "lies"])
    ze.add_argument("doi", nargs="?", help="le DOI de l'article")
    ze.add_argument("--instance", choices=["bac-a-sable", "zenodo"],
                    default=regl.get("SCRAPPER_ZENODO_INSTANCE", "bac-a-sable"))
    ze.add_argument("--communaute", default=regl.get("SCRAPPER_ZENODO_COMMUNAUTE", "code-natif-neurosciences"))
    ze.add_argument("--plateforme", default=regl.get("SCRAPPER_PLATEFORME", "Bibliothèque du code natif"))
    ze.add_argument("--orcid", default="", help="valider : l'ORCID de l'auteur")
    ze.add_argument("--nom", default="", help="valider : « Nom, Prénom »")
    ze.add_argument("--creer", action="store_true", help="communaute : la créer si elle n'existe pas")
    ze.add_argument("--essai", action="store_true", help="deposer : montrer la fiche sans rien envoyer")

    nu = sp.add_parser("nuit", help="la publication : tableau public, puis le jeu Hugging Face")
    nu.add_argument("--dossier", default="donnees/publication",
                    help="dossier à part, jamais généré qu'en mode public")
    nu.add_argument("--jeu", default=regl.get("SCRAPPER_HF_DATASET", ""),
                    help="compte/jeu Hugging Face (vide : ne rien envoyer)")
    nu.add_argument("--cloudflare", default=regl.get("SCRAPPER_CLOUDFLARE_PROJET", ""),
                    help="projet Cloudflare Pages à reconstruire et mettre en ligne (vide : aucun)")

    a = p.parse_args(argv)
    if a.commande == "serveur":
        from . import interface
        base.ouvrir(a.base).close()  # crée ou met à jour le schéma, puis lecture seule
        interface.servir(Path(a.base), a.port)
        return 0
    opts = _options(a)
    con = base.ouvrir(opts.base)
    client = Client(Cache(opts.cache), hors_ligne=a.hors_ligne)
    t0 = time.time()
    try:
        if a.commande == "tourner":
            c = tourner.tourner(con, client, a.domaine, opts, jours_initiaux=a.jours, maximum=a.max)
            print(c)
        elif a.commande == "veiller":
            # Sans le scan GitHub « à l'envers » (2 s par article, rien de plus
            # que le texte sur les articles en accès libre), sauf demande.
            opts.recherche_github = a.recherche_github
            # launchd arrête par SIGTERM : le traduire en sortie propre, pour
            # que les clones temporaires soient nettoyés et la base refermée.
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            print(f"{time.strftime('%Y-%m-%d %H:%M')} veille « {a.domaine} » : nouveautés toutes les "
                  f"{a.nouveautes_minutes:g} min, stock par tranches de {a.tranche_minutes:g} min "
                  f"jusqu'en {a.jusqu_en}", flush=True)
            tourner.veiller(con, client, a.domaine, opts, nouveautes_s=a.nouveautes_minutes * 60,
                            tranche_s=a.tranche_minutes * 60, repos_s=a.repos_minutes * 60,
                            jusqu_en=a.jusqu_en, duree_max_s=a.heures_max * 3600,
                            rapport=lambda m: print(m, flush=True))
        elif a.commande == "rattraper":
            # La recherche GitHub « à l'envers » coûte 2 s par article avec un
            # jeton (30/min) et n'a rien trouvé de plus que le texte sur 177
            # articles en accès libre : dans le stock, seulement si demandée.
            opts.recherche_github = a.recherche_github
            c = tourner.rattraper(con, client, a.domaine, opts, duree_max_s=a.heures * 3600,
                                  jusqu_en=a.jusqu_en)
            print(c, "(budget épuisé, reprise au prochain passage)" if c.interrompu else "")
        elif a.commande == "scanner":
            q = europepmc.requete(a.domaine, a.depuis, a.jusqua)
            _, _, total = europepmc.rechercher(client, q, taille=1)
            print(f"{total} articles pour « {a.domaine} » du {a.depuis} au {a.jusqua}")
            c = tourner.scanner_requete(con, client, q, opts, maximum=a.max,
                                        deja="rescanner" if a.rescanner else "sauter")
            base.journaliser(con, "scan", domaine=a.domaine, depuis=a.depuis, jusqua=a.jusqua,
                             articles=c.articles, total=total)
            print(c)
        elif a.commande == "doi":
            dois = list(a.dois)
            if a.fichier:
                dois += [l.strip() for l in Path(a.fichier).read_text().splitlines() if l.strip()]
            for doi in dois:
                art = europepmc.par_doi(client, doi)
                if art is None:
                    art = europepmc.ArticleEPMC(id=europepmc.identifiant(doi.lower(), ""),
                                                doi=doi.lower(), source="doi")
                print(f"{doi} → {tourner.scanner_article(con, client, art, opts)}")
        elif a.commande == "dossier":
            c = tourner.scanner_dossier(con, client, Path(a.chemin), opts)
            base.journaliser(con, "dossier", chemin=Path(a.chemin).name, articles=c.articles)
            print(c)
        elif a.commande == "nuit":
            heure = lambda: time.strftime("%Y-%m-%d %H:%M")  # noqa: E731
            dossier = Path(a.dossier)
            print(f"{heure()} tableau publiable → {tableau.generer(con, dossier, public=True)}", flush=True)
            from . import publier
            # Chaque envoi est tenté pour lui-même : Hugging Face en panne
            # n'empêche pas le site de se mettre à jour, et inversement.
            erreurs = []
            if a.jeu:
                try:
                    print(f"{heure()} {publier.publier(dossier, a.jeu)}", flush=True)
                except (Exception, SystemExit) as e:
                    erreurs.append(f"Hugging Face : {e}")
            if a.cloudflare:
                try:
                    print(f"{heure()} {publier.deployer_cloudflare(dossier, a.cloudflare)}", flush=True)
                except (Exception, SystemExit) as e:
                    erreurs.append(f"Cloudflare : {e}")
            if erreurs:
                raise SystemExit("\n".join(erreurs))
        elif a.commande == "zenodo":
            _zenodo(con, a)
        elif a.commande == "verifier":
            print(f"{tourner.reverifier(con, client, opts, maximum=a.max)} articles revérifiés")
        if a.commande in ("tourner", "scanner", "rattraper", "doi", "dossier", "verifier", "tableau"):
            chemin = tableau.generer(con, Path(a.site), public=a.public,
                                     miroir=Path(a.miroir) if a.miroir else None)
            print(f"tableau → {chemin}")
        if a.commande == "publier-hf":
            from . import publier
            print(publier.publier(Path(a.site), a.depot_hf, essai=a.essai,
                                  miroir=Path(a.miroir) if a.miroir else None))
        if a.commande == "etat":
            print(json.dumps(tableau.chiffres(con), ensure_ascii=False, indent=1))
    finally:
        con.commit()
        con.close()
        client.fermer()
    print(f"({time.time() - t0:.0f} s, requêtes : {client.compteur})", file=sys.stderr)
    return 0
