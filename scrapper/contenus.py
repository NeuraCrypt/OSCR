"""Le texte des scripts : ce qu'on garde de chaque dépôt, lisible tel quel.

**Pourquoi le texte et pas l'archive.** La bibliothèque se LIT : un chercheur
ouvre le volet d'un article, choisit un script, le lit. Le texte se range dans
la base, se cherche, se compare au script généré depuis l'article. Une archive
se télécharge et s'ouvre ailleurs.

**Ce qu'on garde.** Les scripts (les extensions de `depots.SCRIPTS`), plus le
README et la LICENCE de la racine — sans la licence, on ne saurait pas si le
texte peut être republié. Un notebook Jupyter devient du texte « par cellules »
(le format percent de jupytext) : ses sorties, images comprises, pèsent souvent
cent fois son code et ne se lisent pas.

**Ce qu'on refuse, et on le dit.** Un fichier binaire (un `.mlx` est un zip) ;
un texte de plus de 200 Ko est coupé (`tronque`) ; au-delà de 2 000 fichiers ou
30 Mo par dépôt, on s'arrête. Chaque refus laisse une `note` : le volet dit
pourquoi un script n'a pas de texte, il ne le montre pas vide.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
from pathlib import Path
from typing import IO, Any

from .depots import SCRIPTS

#: Un texte plus long est coupé : 200 Ko, c'est ~5 000 lignes de code.
MAX_TEXTE: int = 200_000
MAX_FICHIERS: int = 2000
MAX_TOTAL: int = 30_000_000
#: Une archive plus grosse n'est pas téléchargée (un zip de code pèse rarement 60 Mo).
MAX_ARCHIVE: int = 60_000_000

_DOCS = re.compile(r"(?i)^(readme|licen[cs]e|copying)(\.(md|txt|rst|markdown))?$")
_ARCHIVES = (".zip",)


def est_script(chemin: str) -> bool:
    return os.path.splitext(chemin)[1].lower() in SCRIPTS


def est_doc(chemin: str) -> bool:
    """Le README et la licence de la RACINE (d'un dépôt ou d'une archive)."""
    return "/" not in chemin.strip("/") and bool(_DOCS.match(chemin.strip("/")))


def langage(chemin: str) -> str:
    if est_doc(chemin):
        return "Licence" if re.match(r"(?i)^(licen|copying)", chemin) else "Texte"
    return SCRIPTS.get(os.path.splitext(chemin)[1].lower(), "")


def notebook_en_texte(brut: str) -> str:
    """Un .ipynb en texte par cellules, sans les sorties."""
    try:
        nb = json.loads(brut)
    except ValueError:
        return brut
    morceaux = []
    for cellule in nb.get("cells", []):
        source = cellule.get("source", "")
        source = "".join(source) if isinstance(source, list) else str(source)
        if cellule.get("cell_type") == "markdown":
            morceaux.append("# %% [markdown]\n" + "\n".join("# " + l for l in source.splitlines()))
        elif cellule.get("cell_type") == "code":
            morceaux.append("# %%\n" + source)
    return "\n\n".join(morceaux) + "\n"


def decoder(octets: bytes) -> str:
    """UTF-8, sinon Windows-1252, sinon Latin-1 — jamais le caractère « � ».

    Beaucoup de scripts MATLAB sont écrits sous Windows : leurs accents
    (« % Données filtrées ») ne sont pas de l'UTF-8. Les décoder en UTF-8 avec
    remplacement les abîmait, et l'outil de publication refusait le lot.
    """
    for codage in ("utf-8-sig", "cp1252"):
        try:
            return octets.decode(codage)
        except UnicodeDecodeError:
            continue
    return octets.decode("latin-1")


def lire(chemin: str, octets: bytes) -> dict[str, Any]:
    """Un fichier → sa ligne de la table `fichier`."""
    fiche: dict[str, Any] = {
        "chemin": chemin, "langage": langage(chemin),
        "genre": "doc" if est_doc(chemin) else "script", "taille": len(octets),
        "empreinte": hashlib.sha256(octets).hexdigest(), "texte": None, "tronque": 0,
        "note": "", "lignes": None}
    if chemin.lower().endswith(".mlx") or b"\x00" in octets[:8000]:
        fiche["note"] = "fichier binaire : lisible seulement à la source"
        return fiche
    texte = decoder(octets)
    if chemin.lower().endswith(".ipynb"):
        texte = notebook_en_texte(texte)
    if len(texte) > MAX_TEXTE:
        texte = texte[:MAX_TEXTE]
        fiche["tronque"] = 1
        fiche["note"] = f"coupé à {MAX_TEXTE // 1000} Ko"
    fiche["texte"] = texte
    fiche["lignes"] = texte.count("\n") + (0 if texte.endswith("\n") else 1)
    return fiche


def depuis_dossier(racine: Path, chemins: list[str]) -> list[dict[str, Any]]:
    """Les scripts d'une copie de travail (un dépôt git extrait)."""
    sortie, total = [], 0
    for c in chemins:
        if len(sortie) >= MAX_FICHIERS or total >= MAX_TOTAL:
            sortie.append(_arret(len(chemins) - len(sortie)))
            break
        p = racine / c
        if not p.is_file():
            continue
        octets = p.read_bytes()
        total += len(octets)
        sortie.append(lire(c, octets))
    return sortie


def depuis_zip(source: bytes | IO[bytes]) -> list[dict[str, Any]]:
    """Les scripts d'une archive zip — une version GitHub déposée sur Zenodo,
    le « Source code 1 » d'un article eLife —, en octets ou en fichier ouvert.
    Le dossier de tête commun (`owner-repo-v1.0/`) est retiré des chemins."""
    try:
        z = zipfile.ZipFile(io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else source)
    except zipfile.BadZipFile:
        return []
    noms = [i.filename for i in z.infolist() if not i.is_dir()]
    tete = os.path.commonprefix([n.split("/")[0] + "/" for n in noms]) if len(noms) > 1 else ""
    if tete and not all(n.startswith(tete) for n in noms):
        tete = ""
    sortie, total = [], 0
    for info in z.infolist():
        if info.is_dir() or "__MACOSX/" in info.filename:
            continue
        chemin = info.filename[len(tete):] if tete else info.filename
        if not (est_script(chemin) or est_doc(chemin)):
            continue
        if len(sortie) >= MAX_FICHIERS or total >= MAX_TOTAL:
            sortie.append(_arret(0))
            break
        if info.file_size > MAX_TOTAL:
            continue
        with z.open(info) as f:
            b = f.read()
        total += len(b)
        sortie.append(lire(chemin, b))
    return sortie


def _arret(restants: int) -> dict[str, Any]:
    return {"chemin": "…", "langage": "", "genre": "note", "taille": 0, "empreinte": "",
            "texte": None, "tronque": 0, "lignes": None,
            "note": "limite du dépôt atteinte (2 000 fichiers ou 30 Mo) : la suite est à la source"
                    + (f" ({restants} fichiers)" if restants else "")}
