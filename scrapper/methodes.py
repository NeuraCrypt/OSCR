"""Les méthodes d'un article, reconnues par le catalogue de stat_bruteforce.

Le tableau se range comme le catalogue méthode → bibliothèque : par FAMILLE
(Prétraitement, Spectre et temps-fréquence, Connectivité…). Chaque méthode du
catalogue porte le motif qui la reconnaît dans une phrase ; on les passe sur
les Méthodes de l'article (tout le corps quand l'article n'a pas de section
Méthodes reconnaissable).

Ce que ça permet : pour une méthode donnée, retrouver les articles dont le
code natif l'implémente — des implémentations de RÉFÉRENCE, écrites par les
auteurs mêmes.

Le vocabulaire est une copie figée (`vocabulaire/catalogue_methodes.json`),
rafraîchie par `outils/exporter_catalogue.py`.
"""
from __future__ import annotations

import functools
import json
import re
from pathlib import Path

FICHIER = Path(__file__).parent / "vocabulaire" / "catalogue_methodes.json"


@functools.lru_cache(maxsize=1)
def catalogue() -> tuple[tuple[str, str, re.Pattern[str]], ...]:
    """(méthode, famille, motif compilé) pour chaque méthode du catalogue."""
    if not FICHIER.exists():
        return ()
    d = json.loads(FICHIER.read_text())
    sortie = []
    for m in d.get("methodes", []):
        try:
            sortie.append((m["methode"], m["famille"], re.compile(m["motif"], re.I)))
        except re.error:
            continue
    return tuple(sortie)


def reconnaitre(texte: str) -> tuple[list[str], list[str]]:
    """(familles, méthodes) nommées dans le texte, par ordre d'apparition au catalogue."""
    if not texte:
        return [], []
    methodes, familles = [], []
    for nom, famille, motif in catalogue():
        if motif.search(texte):
            methodes.append(nom)
            if famille not in familles:
                familles.append(famille)
    return familles, methodes
