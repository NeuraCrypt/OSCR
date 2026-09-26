# La plateforme : le site public (Astro, Cloudflare Pages)

Un site **statique**, construit depuis le catalogue de sortie du ramasseur
(`../donnees/publication`, toujours en mode public), dans le style d'une archive
scientifique :
- **`/`** : le catalogue. Les articles avec le code de leurs auteurs, groupés par jour de
  parution, en liste numérotée (`dl.liste`). Chacun a trois lignes : « Revue », « Code des
  auteurs », « Statut ». La recherche du bandeau filtre la liste (`?q=…&champ=…`).
- **`/article/<id>/`** : la fiche (`.fiche`) avec sa carte de traçage et ses dépôts, et
  l'encart d'accès à droite (`.encart`). La liste des fichiers renvoie chacun à la source.
  Quand la licence le permet, « lire ici » affiche le texte du script dans un `pre`.
- **`/a-propos/`** : les règles.

**Le style** : `src/styles/science.css`, la seule source de style du site, importée une
seule fois dans `src/layouts/Base.astro`. Aucune autre feuille, aucun `<style>` dans les
composants, aucune classe utilitaire. On ne modifie pas `science.css` sans demander d'abord
(voir ../CLAUDE.md).

```bash
npm install
npm run build       # copie le catalogue (scripts/donnees.mjs), puis construit dist/
npm run preview     # http://localhost:4321
npm run deployer    # Cloudflare Pages ; après `npx wrangler login`, une fois
```

La source du catalogue se change avec `CATALOGUE=/chemin npm run build`. Un catalogue généré
sans `--public` est refusé.

## En ligne

Le site est sur **https://code-natif.pages.dev** (projet Cloudflare Pages `code-natif`).

- **Chaque nuit à 4 h 17**, la publication (`scrapper nuit`) le reconstruit avec le catalogue du
  jour et le remet en ligne, tant que `SCRAPPER_CLOUDFLARE_PROJET=code-natif` figure dans
  `~/.config/scrapper/reglages`.
- **Pour le remettre en ligne à la main** : `npm run deployer`.

Le site ne publie que ce que le catalogue public contient déjà. Le texte d'un article n'y est
jamais, et le code sans licence n'y figure qu'en lien.

## Structure

| fichier | rôle |
|---|---|
| `scripts/donnees.mjs` | le catalogue de sortie → `src/data/catalogue.json` et `public/scripts/` |
| `src/lib/catalogue.ts` | les types, les statuts, les niveaux de preuve |
| `src/pages/index.astro` | le catalogue : `h2.jour`, puis `dl.liste` (`dt` numéroté, `dd` avec `.titre` et `.ligne`) |
| `src/pages/article/[slug].astro` | la fiche d'un article : `.fiche` > `.corps` + `.encart` |
| `src/layouts/Base.astro` | le bandeau et sa recherche, le fil d'Ariane, le pied de page ; l'unique import de `science.css` |
| `src/styles/science.css` | le style, tout le style |

Le site ne charge rien d'un tiers : pas de police externe, pas de bibliothèque.

La suite et les limites gratuites de Cloudflare sont décrites dans
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
