"""Scrapper : le ramasseur du code natif des articles de neurosciences.

Pour un article, trouver où son code est référencé — dans son propre texte,
dans ses métadonnées, sur les forges —, vérifier que ce code existe, l'importer
dans la bibliothèque et en tenir le tableau.

La bibliothèque est pensée pour la suite : chaque script y porte une ORIGINE
(`natif` aujourd'hui ; `genere` et `auteur` le jour où les scripts générés et
les corrections d'auteurs arriveront). Rien de ces deux-là n'est codé ici.
"""

__version__ = "0.1.0"
