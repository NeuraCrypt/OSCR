"""Importer dans la bibliothèque : une fiche par article, un manifeste par dépôt natif.

**La forme de la bibliothèque**, pensée pour la suite du projet :

    bibliotheque/<article>/fiche.json            l'article, ses liens, son statut
    bibliotheque/<article>/natif/<depot>.json    le code des auteurs : commit,
                                                 licence, fichiers, scripts
    bibliotheque/<article>/genere/               (à venir) scripts de stat_bruteforce
    bibliotheque/<article>/auteur/               (à venir) corrections d'auteurs

Ce sont des fichiers JSON : ils se versionnent, se publient tels quels sur un
jeu Hugging Face ou un dépôt GitHub, et se lisent sans le ramasseur.

**L'instantané** (option `--instantanes`) garde une archive du dépôt au commit
vérifié, avec son empreinte SHA-256 — la parade au pourrissement des liens. Il
n'est pris que si la licence autorise la redistribution (`redistribuable =
oui`) : un dépôt sans licence reste un LIEN et un commit, jamais une copie.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path
from typing import Any

from . import depots

TAILLE_MAX_INSTANTANE_MO: int = 200


def slug(texte: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "_", texte.lower()).strip("_")[:120]


def ecrire_fiche(con: sqlite3.Connection, article_id: str, racine: Path) -> Path:
    a = dict(con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone())
    liens = [dict(r) for r in con.execute(
        "SELECT l.norme, l.url, l.hote, l.genre, l.role, l.confiance, l.trouve_par, l.section, "
        "l.raisons, l.occurrences, d.etat, d.type_ressource, d.licence, d.redistribuable, "
        "d.commit_, d.date_commit, d.nb_fichiers, d.nb_scripts, d.langages, d.archive_swh, "
        "d.cite_article, d.lie_a, d.etoiles, d.cree_le, d.verifie_le "
        "FROM lien l LEFT JOIN depot d ON d.norme = l.norme WHERE l.article_id = ? "
        "ORDER BY l.role, l.norme", (article_id,))]
    for l in liens:
        for k in ("raisons", "langages"):
            if isinstance(l.get(k), str):
                l[k] = json.loads(l[k] or ("[]" if k == "raisons" else "{}"))
    dossier = racine / slug(article_id)
    fiche = {
        "article": {k: a[k] for k in ("id", "doi", "pmid", "pmcid", "titre", "revue",
                                      "date_pub", "licence", "source")},
        "auteurs": json.loads(a["auteurs"]),
        "statut": a["statut"],
        "code_sur_demande": bool(a["code_sur_demande"]),
        "familles": json.loads(a["familles"]),
        "methodes": json.loads(a["methodes"]),
        "liens": liens,
        "scripts": {"natif": [l["norme"] for l in liens if l["role"] == "code"],
                    "genere": [], "auteur": []},
        "ecrit_le": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    dossier.mkdir(parents=True, exist_ok=True)
    (dossier / "fiche.json").write_text(json.dumps(fiche, ensure_ascii=False, indent=1))
    for l in liens:
        if l["role"] != "code" or l.get("etat") != "vivant":
            continue
        d = con.execute("SELECT * FROM depot WHERE norme = ?", (l["norme"],)).fetchone()
        manifeste = {k: d[k] for k in d.keys() if k not in ("fichiers", "langages", "erreur")}
        manifeste["langages"] = json.loads(d["langages"] or "{}")
        fichiers = json.loads(d["fichiers"] or "[]")
        manifeste["scripts"] = [f for f in fichiers
                                if Path(f).suffix.lower() in depots.SCRIPTS][:2000]
        manifeste["fichiers"] = fichiers
        (dossier / "natif").mkdir(exist_ok=True)
        (dossier / "natif" / f"{slug(l['norme'])}.json").write_text(
            json.dumps(manifeste, ensure_ascii=False, indent=1))
    return dossier


def instantane(con: sqlite3.Connection, article_id: str, norme: str, url_git: str,
               racine: Path, clones: Path) -> str:
    """Archiver le dépôt au commit vérifié. Rend le chemin, ou '' si refusé."""
    d = con.execute("SELECT * FROM depot WHERE norme = ?", (norme,)).fetchone()
    if d is None or d["etat"] != "vivant" or d["redistribuable"] != "oui" or not d["commit_"]:
        return ""
    cible = racine / slug(article_id) / "natif" / "instantane"
    cible.mkdir(parents=True, exist_ok=True)
    archive = cible / f"{slug(norme)}@{d['commit_'][:12]}.tar.gz"
    if not archive.exists():
        clones.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix="inst_", dir=clones))
        try:
            c = depots._git(["clone", "--quiet", "--depth", "1", url_git, str(tmp / "d")], delai=600)
            if c.returncode != 0:
                return ""
            taille = sum(f.stat().st_size for f in (tmp / "d").rglob("*") if f.is_file())
            if taille > TAILLE_MAX_INSTANTANE_MO * 1e6:
                return ""
            depots._git(["archive", "--format=tar.gz", "-o", str(archive), "HEAD"], cwd=tmp / "d")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    if not archive.exists():
        return ""
    empreinte = hashlib.sha256(archive.read_bytes()).hexdigest()
    con.execute("UPDATE script SET niveau='importe', chemin=?, empreinte=?, importe_le=? "
                "WHERE article_id=? AND origine='natif' AND norme=?",
                (str(archive.relative_to(racine)), empreinte, time.time(), article_id, norme))
    return str(archive)
