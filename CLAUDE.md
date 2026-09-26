# Bibliothèque du code natif : les règles du projet

## DOI et Zenodo

- On attribue des DOI via **Zenodo** (gratuit), **uniquement pour les cartes de
  traçage validées par un auteur**. Jamais pour les fiches générées
  automatiquement.
- Le DOI porte sur la **carte** (liens + métadonnées), pas sur le code de
  l'auteur. On ne redépose jamais ce code.
- Relations :
  - `IsSupplementTo` pointe vers le DOI du papier ;
  - `References` pointe vers le dépôt du code.
- Créateurs : l'auteur qui valide (avec son **ORCID**) + la plateforme.
- **Bac à sable Zenodo** (sandbox.zenodo.org) pour tout le développement.
- Une **communauté Zenodo** réunit les cartes.
- **Aucun service payant.**

Dans le code : `scrapper/invenio.py`. Une validation d'essai (`preuve = 'essai'`)
n'est acceptée que par le bac à sable ; la base publique ne l'exporte pas.

## Le style du site (plateforme/)

- `plateforme/src/styles/science.css` est la **seule** source de style du site. Elle est importée
  **une seule fois**, dans le layout principal (`src/layouts/Base.astro`).
- **Aucun autre style** :
  - pas d'autre fichier CSS ;
  - pas de `<style>` dans les composants ;
  - pas d'attribut `style` ;
  - pas de classes utilitaires ;
  - ni Tailwind, ni bibliothèque de composants.
- Comme le dit l'en-tête de `science.css` : pas de thème sombre par défaut, pas de pastilles,
  pas de majuscules décoratives.
- **Ne pas modifier `science.css` sans demander d'abord.** Un besoin de style qu'elle ne couvre
  pas se signale ; on ne le contourne pas.
- Le balisage suit les classes de `science.css` :
  - le catalogue : un `h2.jour` par jour de parution, puis une `dl.liste`.
    - `dt` : `.num`, l'identifiant, les liens.
    - `dd` : `.titre`, puis des `.ligne` à `.etiquette` : « Revue », « Code des auteurs », « Statut ».
  - la page d'un article : `.fiche`, avec `.corps` et l'`.encart` à droite.
  - un statut se dit en texte (`.ok`, `.alerte`), jamais en pastille.

## Déjà en vigueur

- Ni le PDF ni le texte d'un article ne sortent. Seul le lien DOI est publié.
  Les phrases qui font juger un lien restent dans la base privée.
- Un dépôt sans licence reste un lien et un commit, jamais une copie.
- Aucun courriel de masse aux auteurs : ce sont eux qui viennent.
- Le jeu Hugging Face `opsecsystems/bibliotheque-code-natif` reste **privé**
  tant que ce n'est pas décidé.
- Les jetons (Hugging Face, Zenodo) ne vont jamais dans le dépôt ni dans les
  réglages. Ils restent à l'emplacement standard ou dans le trousseau macOS.
- Pas de commit sans demande.
