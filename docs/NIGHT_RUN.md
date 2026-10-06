# Mission de nuit : faire d'OSCR un vrai mélange d'arXiv et de GitHub

Lis d'abord `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/PLATFORM_PLAN.md`, `docs/SCRIPT_STORAGE.md` et `src/styles/science.css`. Puis lis `docs/NIGHT_PROGRESS.md` s'il existe : c'est ton journal de bord, et tu reprends exactement là où il s'arrête.

OSCR est aujourd'hui la partie « arXiv » : catalogue d'articles, métadonnées, cartes de traçage code ↔ Méthodes, lecteur de scripts. Cette mission ajoute la partie « GitHub » : héberger, versionner, modifier et faire évoluer le code de recherche, avec toutes les fonctions qu'un chercheur trouve sur GitHub, adaptées à la science et reliées aux articles.

**Règle de conservation : on ne retire rien.** Toutes les pages, fonctions, données, tests et décisions existants restent en place et continuent de fonctionner. Tu ajoutes, tu ne remplaces pas.

---

## 1. Règles de fonctionnement autonome (priment sur tout le reste)

Tu travailles seul toute la nuit. **Tu ne t'arrêtes jamais pour me poser une question et tu n'attends jamais de réponse de ma part.** Je dors : aucune question ne recevra de réponse avant demain.

### Comment ne jamais t'arrêter

- **Une décision à prendre ?** Prends-la toi-même, en appliquant dans l'ordre : zéro coût, conformité aux conditions d'utilisation des services, sécurité, simplicité, cohérence avec `CLAUDE.md`. Note la décision et sa justification dans `docs/DECISIONS.md`, puis continue.
- **Un blocage (quota épuisé, service indisponible, test impossible à faire passer, information manquante) ?** Note-le dans `docs/NIGHT_REPORT.md` avec ce que tu as essayé, marque l'élément « reporté », et **passe à l'élément suivant**. Ne reste jamais plus de 45 minutes sur un même problème.
- **Une action qui tombe sous les interdits ci-dessous ?** Ne la fais pas, prépare tout ce qui peut l'être sans la faire (code, configuration, documentation), note-la dans la section « À valider par Yann » du rapport, et continue.
- **Tout est terminé ou reporté ?** Relis le rapport, reprends les éléments reportés avec une nouvelle approche, puis améliore les tests, l'accessibilité et la documentation. Il y a toujours quelque chose d'utile à faire.

### Journal de bord et reprise

Après chaque élément terminé : tests, commit, puis mise à jour de `docs/NIGHT_PROGRESS.md` (phase, élément, état, prochaine étape). Ta session peut être coupée à tout moment (limite d'usage, redémarrage, compaction du contexte). Tu dois pouvoir reprendre en lisant uniquement ce fichier. Quand toutes les phases sont terminées ou reportées, écris la ligne `NIGHT_RUN_COMPLETE` à la fin du journal.

### Interdits absolus (ce ne sont pas des points d'arrêt : tu les contournes et tu continues)

1. **Aucun déploiement** : ni sur le site public, ni sur une adresse de production. Tout se vérifie en local.
2. **Aucune fusion ni aucun push sur `main`.** Tu travailles sur des branches `night/phase-XX-nom`, une par phase, chacune construite sur la précédente. Tu peux pousser ces branches sur GitHub.
3. **Aucune suppression de données** : ni la base réelle, ni les sauvegardes, ni `data/previous-version/`, ni les datasets Hugging Face, ni les communautés Zenodo. Les migrations se testent sur une copie de la base.
4. **Aucun contact avec l'extérieur** : pas d'emails, pas de posts, pas de pull requests ou d'issues sur des dépôts tiers, pas de collecte de contacts.
5. **Aucune manipulation de secrets** : ne lis, n'affiche, ne copie, ne crée et ne révoque aucun jeton. Si une fonction a besoin d'un nouveau secret, code-la pour le lire depuis le trousseau ou les secrets Cloudflare, et note le secret à créer dans « À valider par Yann ».
6. **Aucune dépense** : aucun service payant, aucune offre d'essai demandant une carte bancaire.
7. **Aucune exécution du code des utilisateurs sur le Mac.** Jamais. Le Mac contient la vraie base et les jetons : exécuter du code déposé par un inconnu, ce serait lui donner la machine.
8. **Aucun affaiblissement** : ne désactive, ne supprime et n'assouplis aucun test, aucune vérification de sécurité, aucune règle de `CLAUDE.md`. Les 131 tests existants et tous les nouveaux doivent passer à chaque commit.
9. **Aucun changement de publication** du dataset Hugging Face (il reste privé) ni de la sandbox Zenodo vers le vrai Zenodo.

### Style

`science.css` reste la seule source de style. Tu peux y **ajouter** les styles nécessaires aux nouveaux composants, s'ils respectent les règles de design de `CLAUDE.md` (densité façon archive scientifique, pas de pastilles, pas de majuscules décoratives, pas de thème sombre par défaut, statuts en texte simple). Liste chaque ajout dans le rapport.

---

## 2. Phase 00, Recherche et architecture (à faire en premier, sans me consulter)

### 2.1 Inventaire complet des fonctions de GitHub

Parcours la documentation officielle de GitHub (docs.github.com, section par section) et le journal des nouveautés (github.blog/changelog, douze derniers mois). Produis `docs/GITHUB_PARITY.md` : la liste **exhaustive** des fonctions, regroupées par domaine, avec pour chacune une décision :

- **Reproduire** : on la construit pour OSCR.
- **Adapter** : on la construit sous une forme différente (par exemple à cause du zéro coût), en expliquant laquelle.
- **Exclure** : impossible ou hors sujet, avec la raison (par exemple une fonction qui exige du calcul payant).

La liste des phases ci-dessous est un point de départ : si ton inventaire trouve des fonctions absentes, ajoute-les à la phase qui convient.

### 2.2 Choix du stockage Git

Héberger des dépôts Git avec `push`, `pull` et `clone` compatibles avec le client `git` standard demande un stockage et un serveur Git. Compare au minimum ces options, en vérifiant pour chacune le coût, les limites gratuites **actuelles** et **les conditions d'utilisation** :

- les dépôts Git d'une organisation Hugging Face comme stockage, OSCR servant d'interface et de contrôle d'accès ;
- une organisation GitHub dédiée comme stockage, pilotée par une GitHub App, OSCR servant d'interface ;
- une forge open source (Forgejo) sur une machine virtuelle d'une offre gratuite permanente d'un fournisseur de cloud ;
- un serveur Git sur Cloudflare (Workers, D1), en vérifiant les limites de calcul et de stockage.

Critères, dans l'ordre : **conformité certaine aux conditions d'utilisation** (si un usage n'est pas clairement autorisé, l'option est écartée), zéro coût, compatibilité totale avec `git`, fiabilité, simplicité, réversibilité (pouvoir migrer plus tard). Choisis, écris la décision dans `docs/DECISIONS.md` et `docs/ARCHITECTURE.md`, et construis une couche d'abstraction (`GitBackend`) pour pouvoir changer de stockage sans réécrire le reste.

Quelle que soit l'option retenue, prévois aussi le **mode miroir** : un chercheur relie son dépôt GitHub existant, OSCR le synchronise et ajoute ses propres fonctions par-dessus.

### 2.3 Plan détaillé

Mets à jour `docs/PLATFORM_PLAN.md` avec les phases ci-dessous, complétées par ton inventaire, ordonnées par valeur. Puis attaque la phase 01 sans attendre.

---

## 3. Phases

Chaque fonction est reliée à la recherche quand c'est pertinent : un dépôt est rattaché à un ou plusieurs DOI d'articles, et les cartes de traçage pointent vers des lignes précises à un commit précis.

### Phase 01, Hébergement Git
Création de dépôts (vides, depuis un modèle, par import d'un dépôt GitHub, GitLab ou Zenodo), `clone`, `push`, `pull`, `fetch` en HTTPS avec jetons personnels à portée limitée, branches, tags, branche par défaut, renommage, archivage, transfert, suppression (avec confirmation et délai de grâce), limites de taille, fichiers volumineux (stratégie à la manière de Git LFS, adaptée au stockage retenu), mode miroir GitHub.

### Phase 02, Navigation dans le code
Arborescence, lecteur de fichiers avec coloration, vue brute, historique d'un fichier, `blame`, liste des commits, détail d'un commit, diff unifié et côte à côte, comparaison entre branches, tags et commits, liens permanents vers une ligne ou une plage de lignes (qui alimentent les cartes de traçage), recherche dans le dépôt, statistiques de langages, rendu des README (Markdown, équations, diagrammes Mermaid), notebooks Jupyter, CSV, images, détection de licence, bouton « Citer ce dépôt » depuis `CITATION.cff`, sujets (topics), image de partage.

### Phase 03, Édition dans le navigateur
Modifier, créer, renommer, déplacer, supprimer et téléverser des fichiers, fenêtre de commit (message, branche actuelle ou nouvelle branche avec pull request), aperçu avant enregistrement.

### Phase 04, Forks et pull requests
Fork, pull request depuis une branche ou un fork, brouillons, modèles de description, relecteurs, commentaires sur des lignes, suggestions de modification applicables, approbation ou demande de changements, fil de conversation, état des vérifications, méthodes de fusion (commit de fusion, squash, rebase), détection des conflits et résolution simple dans le navigateur, fusion automatique quand les conditions sont réunies, annulation d'une pull request fusionnée, fermeture et réouverture, liens vers les issues (« fixes #12 »), propriétaires de code (CODEOWNERS), filtres et actions groupées. **Spécificité OSCR** : une pull request qui touche un fichier présent dans une carte de traçage signale les liens concernés, et les auteurs de l'article sont proposés comme relecteurs.

### Phase 05, Issues
Étiquettes, jalons, assignations, modèles et formulaires, sous-issues, types d'issues, réactions, mentions, références croisées, épinglage, verrouillage, transfert, motifs de fermeture, réponses enregistrées, syntaxe de recherche et filtres, actions groupées. **Spécificité OSCR** : types « erreur dans le code », « écart code ↔ article », « échec de reproduction », reliés aux rapports de reproduction existants.

### Phase 06, Discussions, wiki et projets
Discussions par catégories avec réponse acceptée et sondages ; wiki versionné par Git ; projets en tableau, liste et feuille de route, avec champs personnalisés et automatisations simples.

### Phase 07, Versions et releases
Releases avec notes générées automatiquement, fichiers joints (dans les limites du stockage retenu), versionnage sémantique, journal des changements. **Spécificité OSCR** : chaque release peut être rattachée à la version de l'article qu'elle accompagne, sa carte de traçage est versionnée avec elle, et l'archivage Software Heritage est demandé. Le dépôt sur Zenodo avec DOI reste une action déclenchée par l'auteur lui-même, conformément à `CLAUDE.md`.

### Phase 08, Social et découverte
Étoiles et listes d'étoiles, suivi d'un dépôt (notifications dans le site), abonnement à des personnes et à des organisations, profils avec README, graphe de contributions, fil d'activité, page « Explorer », tendances, sujets, collections.

### Phase 09, Organisations, équipes et droits
Organisations (par exemple un labo), équipes, rôles (lecture, tri, écriture, maintenance, administration), collaborateurs et invitations, règles de protection des branches, journal d'audit, jetons personnels à portée limitée, clés SSH et clés de déploiement si le stockage retenu le permet, affichage des signatures de commits vérifiées.

### Phase 10, Automatisation et intégrations
Webhooks, API publique (lecture et écriture, authentifiée, documentée), API de statut et de vérifications pour que des services extérieurs publient des résultats. **Exécution de code (l'équivalent de GitHub Actions)** : jamais sur le Mac ni sur Cloudflare. Adapte-la : les vérifications qui n'exécutent pas le code (licence présente, fichier d'environnement, lien vers le DOI, `CITATION.cff`, cohérence de la carte de traçage) tournent côté OSCR ; pour exécuter des tests, OSCR s'appuie sur l'intégration continue gratuite des dépôts miroirs GitHub et en affiche les résultats.

### Phase 11, Sécurité et qualité
Graphe des dépendances à partir des fichiers d'environnement, alertes de vulnérabilité via une base publique gratuite (par exemple OSV), **détection des secrets à chaque push avec refus du push**, politique de sécurité, signalement privé de vulnérabilités, export SBOM, vérification de compatibilité des licences.

### Phase 12, Statistiques du dépôt
Contributeurs, activité des commits, fréquence du code, forks, graphe du réseau, « utilisé par » (articles et dépôts qui en dépendent), résumé d'activité. Statistiques de visites respectueuses de la vie privée (comptages agrégés, sans suivi individuel).

### Phase 13, Extraits de code
Équivalent des Gists : extraits versionnés, publics, commentables, et pouvant être rattachés à un passage précis d'un article.

### Phase 14, Outil en ligne de commande `oscr`
Une bibliothèque installable (Python, avec `pyproject.toml`), qui fonctionne dans un terminal, sur le modèle de l'outil `gh` : `oscr auth login` (connexion par ORCID ou GitHub via un flux par code d'appareil, jeton rangé dans le trousseau du système), `oscr repo create/clone/fork/view/list/archive`, `oscr pr create/list/view/checkout/review/merge`, `oscr issue create/list/view/close`, `oscr release create/list`, `oscr snippet`, `oscr search`, `oscr api`, `oscr browse`, et des commandes propres à OSCR : `oscr paper link <DOI>`, `oscr trace` (proposer ou vérifier une carte de traçage depuis le terminal), `oscr cite`, `oscr check` (vérification de traçabilité d'un dépôt local). Un assistant d'identification Git pour que `git push` fonctionne avec un jeton OSCR. Tests complets. **Ne la publie pas sur PyPI** (c'est un contact avec l'extérieur) : prépare la publication et note-la dans « À valider par Yann ».

### Phase 15, Confort d'utilisation
Raccourcis clavier, palette de commandes, notifications groupées, accessibilité complète au clavier et au lecteur d'écran, affichage sur téléphone.

### Phase 16, Contenu, abus et règles
Indispensable avant toute ouverture publique de l'hébergement : conditions d'utilisation de l'hébergement, politique de contenu, limites de taille et de fréquence, file de modération des dépôts et des comptes, signalements, procédure de retrait pour atteinte au droit d'auteur, protection contre les comptes de spam (Cloudflare Turnstile), blocage des fichiers exécutables malveillants connus.

---

## 4. Contraintes techniques (inchangées)

- Zéro coût. Limites gratuites de Cloudflare, D1, Hugging Face et de chaque service à respecter et à documenter.
- Schéma de données : migrations versionnées, testées sur une copie de la base.
- Chaque fonction a ses tests. Chaque page est vérifiée sur ordinateur et téléphone (captures dans `docs/night-screenshots/`).
- Aucune adresse email ni donnée personnelle non publique affichée.
- La documentation (`ARCHITECTURE.md`, `CLAUDE.md`, aide utilisateur, documentation de l'API et de la ligne de commande) est mise à jour à chaque phase.

---

## 5. Le rapport du matin

`docs/NIGHT_REPORT.md`, mis à jour au fil de la nuit, contient :

1. **Résumé** : phases terminées, en cours, reportées ; nombre de tests.
2. **À valider par Yann** : tout ce qui demande mon action (fusions, secrets à créer, publication PyPI, déploiements, décisions que tu as prises et que je devrais relire en priorité).
3. **Décisions prises** : renvoi vers `docs/DECISIONS.md`.
4. **Blocages et reports** : ce qui a coincé, ce que tu as essayé, ce que tu proposes.
5. **Branches** : liste des branches `night/…` dans l'ordre de fusion.
6. **Ajouts à `science.css`**.

Commence maintenant par la phase 00.
