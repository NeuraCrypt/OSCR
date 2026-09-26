"""Le tableau : la bibliothèque rendue lisible, rangée comme le catalogue.

Trois vues, comme le catalogue méthode → bibliothèque de stat_bruteforce se
lit par famille et par niveau de preuve :

- ARTICLES : chaque article, son statut, le code de ses auteurs avec son
  niveau de preuve (trouvé → vivant → inventorié → importé) ;
- PAR FAMILLE : pour chaque famille de méthodes du catalogue, combien
  d'articles la nomment et combien publient leur code ;
- DÉPÔTS : chaque dépôt de code natif, sa licence, ses scripts, son archive.

**Ce qui sort, et pour qui.** `site/index.html` est une page autonome (les
données sont dedans) qu'un hébergement statique sert telle quelle — GitHub
Pages, un Space statique Hugging Face. `site/artefact.html` est la même page
sans l'enveloppe du document. Les exports `articles.csv`, `depots.csv` et
`donnees.json` se chargent dans la visionneuse d'un jeu Hugging Face, et
`bibliotheque_publique.db` s'ouvre dans Datasette ou Datasette Lite.

Aucun extrait du texte des articles ne sort d'ici : la colonne `extrait`
reste dans la base privée.
"""
from __future__ import annotations

import csv
import hashlib
import json
import shutil
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import methodes

GABARIT = Path(__file__).parent / "gabarit_tableau.html"

#: Le texte des scripts est servi en LOTS, chargés à la demande par le volet :
#: la page reste légère, et un hébergement statique (GitHub Pages, un Space
#: statique, un artefact à 255 fichiers au plus) les sert tels quels.
N_LOTS: int = 32

#: Les licences sous lesquelles on republie le texte d'un script. Sans licence,
#: un code est « tous droits réservés » : on le montre à la source, pas ici.
PUBLIABLES: frozenset[str] = frozenset({"oui", "sous_conditions"})

NOTE_LICENCE = ("La licence de ce dépôt ne permet pas d'en republier le texte : "
                "lisez-le à la source.")
NOTE_SANS_LICENCE = ("Ce dépôt n'a pas de licence : ses auteurs gardent tous leurs droits. "
                     "Lisez-le à la source.")


def lot_de(norme: str) -> int:
    return int(hashlib.sha1(norme.encode()).hexdigest()[:8], 16) % N_LOTS


def url_fichier(d: sqlite3.Row | dict, chemin: str) -> str:
    """Le fichier à la source, au commit vérifié quand la forge le permet."""
    norme, url = d["norme"], d["url"]
    commit = (d["commit_"] or "HEAD") if "commit_" in d.keys() else "HEAD"
    parts = norme.split("/")
    c = quote(chemin)
    if norme.startswith("github.com/") and len(parts) >= 3:
        return f"https://github.com/{parts[1]}/{parts[2]}/blob/{commit}/{c}"
    if (norme.startswith("gitlab.") or ".gitlab." in parts[0]) and len(parts) >= 3:
        return f"https://{norme}/-/blob/{commit}/{c}"
    if parts[0] in ("codeberg.org", "gin.g-node.org", "framagit.org", "gitee.com") and len(parts) >= 3:
        return f"https://{parts[0]}/{parts[1]}/{parts[2]}/src/commit/{commit}/{c}"
    if parts[0] == "bitbucket.org" and len(parts) >= 3:
        return f"https://bitbucket.org/{parts[1]}/{parts[2]}/src/{commit}/{c}"
    if parts[0] == "huggingface.co":
        return f"https://huggingface.co/{'/'.join(parts[1:])}/blob/{commit}/{c}"
    if norme.startswith("zenodo:"):
        return f"https://zenodo.org/records/{norme.split(':', 1)[1]}"
    if norme.startswith("osf:"):
        return f"https://osf.io/{norme.split(':', 1)[1]}/files"
    if norme.startswith("figshare:"):
        return f"https://figshare.com/articles/{norme.split(':', 1)[1]}"
    if norme.startswith("supp:"):
        pmcid, _, nom = norme[5:].partition("/")
        return f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.1/{quote(nom)}"
    return url

_STATUTS_CODE = ("code_verifie", "code_trouve", "code_vide", "code_mort")


def _ou(trouve_par: str, section: str) -> str:
    """Où le lien a été vu, en mots de lecteur."""
    lieu = trouve_par.split(":", 1)[-1] if trouve_par.startswith("texte:") else trouve_par
    s = f"« {section[:48]} »" if section else ""
    return {
        "disponibilite": s or "déclaration de disponibilité",
        "corps": f"le texte, {s}" if s else "le texte",
        "references": "les références",
        "tableau": "le tableau des ressources",
        "supplementaire": "le matériel supplémentaire",
        "notes": "les notes",
        "annexe": "l'annexe",
        "remerciements": "les remerciements",
        "fond": s or "la fin de l'article",
        "crossref:reference": "les références déposées chez Crossref",
        "zenodo:source": "la fiche de l'archive Zenodo",
        "dryad:logiciel": "le logiciel Zenodo compagnon du jeu Dryad",
        "github:readme": "un README GitHub qui cite l'article",
    }.get(lieu, "DataCite" if lieu.startswith("datacite") else
          "Crossref" if lieu.startswith("crossref") else lieu)


def chiffres(con: sqlite3.Connection) -> dict[str, Any]:
    q = lambda sql, *p: con.execute(sql, p).fetchone()[0]  # noqa: E731
    statuts = {r["statut"]: r["n"] for r in con.execute(
        "SELECT statut, COUNT(*) AS n FROM article WHERE scanne_le IS NOT NULL GROUP BY statut")}
    code_vivants = "SELECT DISTINCT l.norme FROM lien l JOIN depot d ON d.norme = l.norme " \
                   "WHERE l.role = 'code' AND d.etat = ?"
    return {
        "articles": q("SELECT COUNT(*) FROM article WHERE scanne_le IS NOT NULL"),
        "plein_texte": q("SELECT COUNT(*) FROM article WHERE plein_texte = 1"),
        "avec_code": sum(statuts.get(s, 0) for s in _STATUTS_CODE),
        "code_verifie": statuts.get("code_verifie", 0),
        "sur_demande": statuts.get("sur_demande", 0),
        "code_sur_demande_mentionne": q("SELECT COUNT(*) FROM article WHERE code_sur_demande = 1"),
        "depots_code": q("SELECT COUNT(DISTINCT norme) FROM lien WHERE role = 'code'"),
        "depots_code_vivants": len(con.execute(code_vivants, ("vivant",)).fetchall()),
        "depots_code_morts": len(con.execute(code_vivants, ("mort",)).fetchall()),
        "depots_archives": q("SELECT COUNT(DISTINCT d.norme) FROM depot d JOIN lien l ON l.norme = d.norme "
                             "WHERE l.role = 'code' AND d.archive_swh = 1"),
        "scripts": q("SELECT COALESCE(SUM(nb_scripts), 0) FROM depot WHERE norme IN "
                     "(SELECT norme FROM lien WHERE role = 'code')"),
        "statuts": statuts,
    }


def donnees(con: sqlite3.Connection) -> dict[str, Any]:
    c = chiffres(con)
    # Combien de fichiers de chaque dépôt ont un texte dans la base (scripts et docs).
    lus = {r["depot"]: r["n"] for r in con.execute(
        "SELECT depot, COUNT(*) AS n FROM fichier WHERE genre != 'note' GROUP BY depot")}
    niveaux = {(r["article_id"], r["norme"]): r["niveau"]
               for r in con.execute("SELECT article_id, norme, niveau FROM script WHERE origine='natif'")}
    depots = {r["norme"]: r for r in con.execute("SELECT * FROM depot")}
    liens_par_article: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for l in con.execute("SELECT * FROM lien"):
        liens_par_article[l["article_id"]].append(l)

    # Les cartes validées par un auteur (ORCID) et leur DOI Zenodo : seulement
    # la vraie instance, jamais les essais du bac à sable (CLAUDE.md).
    valideurs: dict[str, list[dict[str, str]]] = defaultdict(list)
    for v in con.execute("SELECT article_id, nom, orcid FROM validation WHERE preuve = 'orcid' ORDER BY valide_le"):
        valideurs[v["article_id"]].append({"nom": v["nom"], "orcid": v["orcid"]})
    dois_cartes = {r["article_id"]: {"doi": r["doi"], "doi_concept": r["doi_concept"]}
                   for r in con.execute("SELECT * FROM carte_zenodo WHERE instance = 'zenodo'")}

    articles = []
    for a in con.execute("SELECT * FROM article WHERE scanne_le IS NOT NULL ORDER BY date_pub DESC"):
        code = []
        n_donnees = 0
        for l in liens_par_article.get(a["id"], []):
            if l["role"] == "donnees":
                n_donnees += 1
            if l["role"] != "code":
                continue
            d = depots.get(l["norme"])
            code.append({
                "norme": l["norme"], "url": l["url"] if l["url"].startswith("http") else
                (f"https://doi.org/{l['norme'][4:]}" if l["norme"].startswith("doi:") else
                 url_fichier(d, "") if d is not None and l["norme"].startswith("supp:") else l["url"]),
                "hote": l["hote"], "niveau": niveaux.get((a["id"], l["norme"]), "trouve"),
                "lot": lot_de(l["norme"]), "lus": lus.get(l["norme"], 0),
                "etat": d["etat"] if d else "a_verifier",
                "licence": (d["licence"] if d else "") or "",
                "redistribuable": d["redistribuable"] if d else "inconnu",
                "scripts": d["nb_scripts"] if d else None,
                "langages": json.loads(d["langages"] or "{}") if d else {},
                "type": (d["type_ressource"] if d else "") or "",
                "swh": d["archive_swh"] if d else None,
                "inventorie": bool(d and d["nb_fichiers"] is not None),
                "commit": (d["commit_"] if d else "") or "",
                "ou": _ou(l["trouve_par"], l["section"]),
            })
        articles.append({
            "id": a["id"], "doi": a["doi"], "titre": a["titre"], "revue": a["revue"],
            "date": a["date_pub"], "statut": a["statut"], "familles": json.loads(a["familles"]),
            "donnees": n_donnees, "code": code,
            "carte": ({"validee_par": valideurs.get(a["id"], []), **dois_cartes.get(a["id"], {})}
                      if a["id"] in valideurs or a["id"] in dois_cartes else None),
        })

    familles = _familles(con, articles)
    liste_depots = _depots(con, depots, niveaux)
    for d in liste_depots:
        d["lot"] = lot_de(d["norme"])
        d["lus"] = lus.get(d["norme"], 0)
    dates = [a["date"] for a in articles if a["date"]]
    sources = sorted({r["source"].split(":")[0] for r in con.execute(
        "SELECT DISTINCT source FROM article WHERE scanne_le IS NOT NULL")})
    perimetre = {
        "sources": "Europe PMC, Crossref, DataCite" if "europepmc" in sources else
                   ("corpus local, DataCite" if sources else "—"),
        "debut": min(dates) if dates else "", "fin": max(dates) if dates else "",
        "requete": "; ".join(_passages(con)),
    }
    return {"genere_le": time.strftime("%d/%m/%Y à %H:%M UTC", time.gmtime()),
            "perimetre": perimetre, "chiffres": c, "articles": articles,
            "familles": familles, "depots": liste_depots}


def _passages(con: sqlite3.Connection) -> list[str]:
    """Ce qui a été scanné, dit comme un lecteur le dirait, un passage par ligne
    distincte : « electrophysiologie, 2026-09-15 → 2026-09-25 »."""
    vus: dict[str, None] = {}
    for r in con.execute("SELECT evenement, details FROM journal "
                         "WHERE evenement IN ('scan', 'passage', 'dossier') ORDER BY t"):
        d = json.loads(r["details"])
        if r["evenement"] == "dossier":
            vus[f"dossier {d.get('chemin', '')}"] = None
        else:
            fin = d.get("jusqua") or "aujourd'hui"
            vus[f"{d.get('domaine', '')}, {d.get('depuis', '')} → {fin}"] = None
    return list(vus)


def _familles(con: sqlite3.Connection, articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    famille_de = {nom: fam for nom, fam, _ in methodes.catalogue()}
    au_catalogue = Counter(famille_de.values())
    par_famille: dict[str, dict[str, Any]] = {}
    methodes_articles = {r["id"]: json.loads(r["methodes"]) for r in con.execute(
        "SELECT id, methodes FROM article WHERE scanne_le IS NOT NULL")}
    for a in articles:
        for fam in a["familles"]:
            f = par_famille.setdefault(fam, {"famille": fam, "articles": 0, "avec_code": 0,
                                             "methodes": Counter(), "exemples": []})
            f["articles"] += 1
            if a["statut"] in _STATUTS_CODE:
                f["avec_code"] += 1
            for m in methodes_articles.get(a["id"], []):
                if famille_de.get(m) == fam:
                    f["methodes"][m] += 1
            if a["statut"] == "code_verifie":
                for c in a["code"]:
                    if c["etat"] == "vivant" and c["scripts"]:
                        f["exemples"].append((c["scripts"], c["norme"], c["url"]))
    sortie = []
    for f in sorted(par_famille.values(), key=lambda f: -f["articles"]):
        vus, ex = set(), []
        for _, norme, url in sorted(f["exemples"], reverse=True):
            if norme not in vus:
                vus.add(norme)
                ex.append({"norme": norme, "url": url})
            if len(ex) == 3:
                break
        sortie.append({"famille": f["famille"], "methodes_catalogue": au_catalogue.get(f["famille"], 0),
                       "articles": f["articles"], "avec_code": f["avec_code"],
                       "methodes": [[m, n] for m, n in f["methodes"].most_common(3)],
                       "exemples": ex})
    return sortie


def _depots(con: sqlite3.Connection, depots: dict[str, sqlite3.Row],
            niveaux: dict[tuple[str, str], str]) -> list[dict[str, Any]]:
    ordre = ["trouve", "vivant", "inventorie", "importe"]
    compte: Counter[str] = Counter()
    niveau_max: dict[str, str] = {}
    for r in con.execute("SELECT article_id, norme FROM lien WHERE role = 'code'"):
        compte[r["norme"]] += 1
        n = niveaux.get((r["article_id"], r["norme"]), "trouve")
        if ordre.index(n) >= ordre.index(niveau_max.get(r["norme"], "trouve")):
            niveau_max[r["norme"]] = n
    sortie = []
    for norme, n in compte.most_common():
        d = depots.get(norme)
        if d is None:
            continue
        sortie.append({
            "norme": norme, "url": d["url"] if d["url"].startswith("http") else
            (f"https://doi.org/{norme[4:]}" if norme.startswith("doi:") else d["url"]),
            "hote": d["hote"], "etat": d["etat"], "licence": d["licence"] or "",
            "scripts": d["nb_scripts"], "langages": json.loads(d["langages"] or "{}"),
            "commit": d["commit_"] or "", "date_commit": d["date_commit"] or "",
            "swh": d["archive_swh"], "articles": n, "niveau": niveau_max.get(norme, "trouve"),
            "type": d["type_ressource"] or "", "inventorie": d["nb_fichiers"] is not None,
        })
    return sortie


def lots_de_scripts(con: sqlite3.Connection, public: bool) -> dict[int, dict[str, Any]]:
    """Le texte des scripts, dépôt par dépôt, réparti en lots.

    En mode `public`, le texte d'un dépôt dont la licence ne permet pas la
    republication est RETIRÉ : le volet montre la liste des fichiers et un lien
    vers chacun, à la source, au commit vérifié.
    """
    lots: dict[int, dict[str, Any]] = defaultdict(dict)
    depots = {r["norme"]: r for r in con.execute("SELECT * FROM depot")}
    for norme in [r["depot"] for r in con.execute("SELECT DISTINCT depot FROM fichier")]:
        d = depots.get(norme)
        if d is None:
            continue
        ouvert = (not public) or d["redistribuable"] in PUBLIABLES
        note_retrait = NOTE_SANS_LICENCE if not d["licence"] else NOTE_LICENCE
        fichiers = []
        for f in con.execute("SELECT * FROM fichier WHERE depot = ? ORDER BY genre DESC, chemin",
                             (norme,)):
            texte, note = (f["texte"], f["note"]) if ouvert else (None, note_retrait)
            if texte and "�" in texte:
                # Le caractère « � » est déjà dans l'ORIGINAL (« S�ren », dans
                # legendflex.m) : la base le garde tel quel, l'export le dit.
                texte = texte.replace("�", "?")
                note = (note + " ; " if note else "") + "caractère illisible dans l'original, remplacé par « ? »"
            fichiers.append({
                "c": f["chemin"], "l": f["langage"], "g": f["genre"], "n": f["lignes"],
                "t": texte, "x": f["tronque"], "note": note,
                "src": url_fichier(d, f["chemin"]) if f["genre"] != "note" else ""})
        lots[lot_de(norme)][norme] = {
            "depot": norme, "version": d["commit_"] or "", "licence": d["licence"] or "",
            "publie": ouvert, "fichiers": fichiers}
    return lots


def generer(con: sqlite3.Connection, dossier: Path, *, public: bool = False,
            miroir: Path | None = None) -> Path:
    """Écrire la page, ses lots de scripts, ses exports, la base publique — et,
    si demandé, le miroir des scripts republiables. Rend le chemin de la page."""
    d = donnees(con)
    d["public"] = public
    lots = lots_de_scripts(con, public)
    (dossier / "scripts").mkdir(parents=True, exist_ok=True)
    for vieux in (dossier / "scripts").glob("*.json"):
        vieux.unlink()
    for n, contenu in lots.items():
        (dossier / "scripts" / f"{n:02d}.json").write_text(
            json.dumps(contenu, ensure_ascii=False, separators=(",", ":")))
    _jsonl_scripts(lots, dossier / "scripts.jsonl")
    if miroir is not None:
        _miroir(con, lots, miroir)
    brut = json.dumps(d, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    fragment = GABARIT.read_text().replace("/*__DONNEES__*/", brut)
    dossier.mkdir(parents=True, exist_ok=True)
    (dossier / "artefact.html").write_text(fragment)
    coupe = fragment.index('<div class="page">')
    page = ('<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            + fragment[:coupe] + "</head>\n<body>\n" + fragment[coupe:] + "\n</body>\n</html>\n")
    (dossier / "index.html").write_text(page)
    (dossier / "donnees.json").write_text(json.dumps(d, ensure_ascii=False, indent=1))
    _csv_articles(con, dossier / "articles.csv")
    _csv_depots(con, dossier / "depots.csv")
    _base_publique(con, dossier / "bibliotheque_publique.db")
    return dossier / "index.html"


def _csv_articles(con: sqlite3.Connection, chemin: Path) -> None:
    with chemin.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "doi", "pmid", "pmcid", "titre", "revue", "date_pub", "licence_article",
                    "statut", "code_sur_demande", "familles", "depots_code", "licences_code", "scripts"])
        for a in con.execute("SELECT * FROM article WHERE scanne_le IS NOT NULL ORDER BY date_pub DESC"):
            code = con.execute("SELECT l.norme, d.licence, d.nb_scripts FROM lien l LEFT JOIN depot d "
                               "ON d.norme = l.norme WHERE l.article_id = ? AND l.role = 'code'",
                               (a["id"],)).fetchall()
            w.writerow([a["id"], a["doi"], a["pmid"], a["pmcid"], a["titre"], a["revue"],
                        a["date_pub"], a["licence"], a["statut"], a["code_sur_demande"],
                        "; ".join(json.loads(a["familles"])), " ".join(c["norme"] for c in code),
                        " ".join(sorted({c["licence"] for c in code if c["licence"]})),
                        sum(c["nb_scripts"] or 0 for c in code)])


def _csv_depots(con: sqlite3.Connection, chemin: Path) -> None:
    with chemin.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["norme", "url", "hote", "etat", "type_ressource", "licence", "redistribuable",
                    "commit", "date_commit", "nb_fichiers", "nb_scripts", "langages", "archive_swh",
                    "articles"])
        for d in con.execute(
                "SELECT d.*, COUNT(l.article_id) AS n FROM depot d JOIN lien l ON l.norme = d.norme "
                "WHERE l.role = 'code' GROUP BY d.norme ORDER BY n DESC, d.norme"):
            w.writerow([d["norme"], d["url"], d["hote"], d["etat"], d["type_ressource"], d["licence"],
                        d["redistribuable"], d["commit_"], d["date_commit"], d["nb_fichiers"],
                        d["nb_scripts"], d["langages"], d["archive_swh"], d["n"]])


def _jsonl_scripts(lots: dict[int, dict[str, Any]], chemin: Path) -> None:
    """Un script par ligne — le format qu'un jeu Hugging Face affiche et interroge."""
    with chemin.open("w") as f:
        for contenu in lots.values():
            for depot in contenu.values():
                for fi in depot["fichiers"]:
                    if fi["t"] is None:
                        continue
                    f.write(json.dumps({"depot": depot["depot"], "version": depot["version"],
                                        "licence": depot["licence"], "chemin": fi["c"],
                                        "langage": fi["l"], "genre": fi["g"], "lignes": fi["n"],
                                        "source": fi["src"], "texte": fi["t"]},
                                       ensure_ascii=False) + "\n")


def _miroir(con: sqlite3.Connection, lots: dict[int, dict[str, Any]], racine: Path) -> None:
    """Recopier les scripts REPUBLIABLES en fichiers : `racine/<dépôt>/<chemin>`,
    avec la licence du dépôt et un `SOURCE.json` (origine, commit, licence).

    C'est la forme qu'un dépôt GitHub public versionne : un diff lisible par
    passage, et l'attribution que les licences exigent, à côté du code.
    """
    from .importer import slug
    if racine.exists():
        shutil.rmtree(racine)
    racine.mkdir(parents=True)
    depots = {r["norme"]: r for r in con.execute("SELECT * FROM depot")}
    for contenu in lots.values():
        for norme, depot in contenu.items():
            d = depots.get(norme)
            if d is None or d["redistribuable"] not in PUBLIABLES:
                continue
            base = racine / slug(norme)
            for fi in depot["fichiers"]:
                if fi["t"] is None or fi["c"] == "…":
                    continue
                # Un chemin vient d'un dépôt ou d'un zip étranger : jamais absolu,
                # jamais « .. », et la cible doit rester DANS le dossier du dépôt.
                relatif = Path(fi["c"].lstrip("/\\"))
                if relatif.is_absolute() or ".." in relatif.parts:
                    continue
                cible = base / relatif
                if not cible.resolve().is_relative_to(base.resolve()):
                    continue
                cible.parent.mkdir(parents=True, exist_ok=True)
                cible.write_text(fi["t"])
            if base.exists():
                (base / "SOURCE.json").write_text(json.dumps(
                    {"depot": norme, "url": d["url"], "commit": d["commit_"], "licence": d["licence"],
                     "recopie_le": time.strftime("%Y-%m-%d", time.gmtime()),
                     "avertissement": "Copie du code publié par les auteurs, sous sa licence d'origine. "
                                      "La source fait foi."}, ensure_ascii=False, indent=1))


def _base_publique(con: sqlite3.Connection, chemin: Path) -> None:
    """Une copie de la base sans les extraits de texte des articles, et sans le
    texte des scripts dont la licence interdit la republication. C'est aussi elle
    que le passage GitHub garde d'un jour à l'autre : le journal (dates,
    requêtes, comptes) y reste, il ne cite aucun article."""
    tmp = chemin.with_suffix(".tmp")
    if tmp.exists():
        tmp.unlink()
    cible = sqlite3.connect(tmp)
    con.commit()
    con.backup(cible)
    # La copie hérite du mode WAL de la base de travail : on la remet en UN
    # fichier, lisible tel quel par sql.js ou Datasette Lite.
    cible.execute("PRAGMA journal_mode = DELETE")
    cible.execute("UPDATE lien SET extrait = ''")
    # Les essais de développement (validations d'essai, DOI du bac à sable) ne sortent pas.
    cible.execute("DELETE FROM validation WHERE preuve != 'orcid'")
    cible.execute("DELETE FROM carte_zenodo WHERE instance != 'zenodo'")
    cible.execute(
        "UPDATE fichier SET texte = NULL, note = ? WHERE depot IN "
        "(SELECT norme FROM depot WHERE redistribuable NOT IN ('oui', 'sous_conditions'))",
        (NOTE_LICENCE,))
    cible.commit()
    cible.execute("VACUUM")
    cible.close()
    shutil.move(tmp, chemin)
