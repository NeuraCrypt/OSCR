# Rapport de nuit

Mis à jour au fil de la nuit. La mission est dans `docs/NIGHT_RUN.md`, le journal de reprise dans `docs/NIGHT_PROGRESS.md`.

## 1. Résumé

- **Phase 00 (recherche et architecture) : terminée**, branche `night/phase-00-research`, poussée sur GitHub (rien fusionné dans `main`, rien déployé).
- **Inventaire** (`docs/GITHUB_PARITY.md`) : 5 153 fonctionnalités de GitHub, chacune décidée : 2 413 à reproduire, 1 576 à adapter, 1 164 exclues. 3 989 sont donc à construire, réparties entre les phases 01 à 16 et quelques phases nouvelles.
- **Stockage Git** (`docs/DECISIONS.md`, D00-1 à D00-16) : OSCR n'héberge pas les dépôts lui-même ; ils vivent dans le compte GitHub du chercheur, pilotés par l'App GitHub d'OSCR avec son accord.
- **Plan** (`docs/PLATFORM_PLAN.md` §15) : les phases dans l'ordre d'exécution, avec leur budget gratuit.
- **`GitBackend`** : l'interface neutre vis-à-vis de la forge, l'adaptateur GitHub, un double en mémoire et une suite de contrat (`website/worker/forge/`), plus le côté Mac en lecture seule (`oscr/forge.py`). Pas encore branché dans le Worker (phase 01).
- **Tests à la clôture** : pytest 426 réussis (dont 24 pour `oscr/forge.py`) ; ruff propre ; `npm test` 460 réussis sous Node 26 et sous Node 22 (dont 325 pour `GitBackend`) ; build 31 pages ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 01 (hébergement Git et mode miroir) : terminée**, branche `night/phase-01-git-hosting`, poussée (13 commits : la fondation, les éléments E1 à E12, l'essai de bout en bout). Rien fusionné, rien déployé.
  - **Le service forge dans le Worker** : une action autorisée en deux requêtes (`/api/forge/start`, GitHub, `/api/forge/act`), le jeton de la personne utilisé une fois puis révoqué, jamais gardé ; 22 sortes d'actions (créer, depuis un modèle, lier un dépôt existant, ses articles, les réglages, les branches, les autoliens, la suppression avec 30 jours de grâce, Software Heritage) ; les webhooks (au plus 2 lignes chacun) ; les lectures `/repo` et `/mine`. **`FORGE_OPEN` n'est pas posé : seul ton compte GitHub (`FORGE_OWNER_GITHUB_ID`) peut écrire.**
  - **Les pages** : `/new/` (créer), `/new/link/` (lier), `/new/import/` (importer sur ton ordinateur), `/repositories/` (tes dépôts), `/forge/authorized/` (le retour de GitHub), la coquille `/r/<compte>/<nom>/` (accueil, réglages, branches) et six guides sous `/hosting/`.
  - **Le Mac** : `oscr forge poll|mirrors|layer|status` (les tâches, les têtes des miroirs publics, les chemins tracés, la couche statique).
  - **Essai de bout en bout** local (`website/tests/forge-service/e2e.sh`) : connexion, création, liaison, réglages, branches, autoliens, webhooks signés, refus d'un autre compte : tout passe. Captures : `docs/night-screenshots/phase-01/` (48 images, bureau et téléphone).
  - **Tests à la clôture** : pytest 470 ; ruff propre ; `npm test` 779 sous Node 26 et Node 22 ; build 45 pages ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 02 (navigation dans le code) : terminée**, branche `night/phase-02-code-navigation`, poussée (9 commits : les éléments E1 à E7, les corrections de la revue de sécurité, la clôture). Rien fusionné, rien déployé.
  - **La visionneuse de code d'OSCR, GitHub en dernier recours seulement** (ta consigne du 29/09) : dossiers, fichiers colorés par highlight.js (classes stylées dans `science.css`), gouttière de numéros, indentation exacte, ancres de lignes et de plages dans OSCR, menu de ligne, permaliens, arbre des fichiers, copie, téléchargement ; historique, commits, diffs unifiés et côte à côte, comparaisons, diffs d'images. GitHub n'est proposé que pour ce qu'OSCR ne peut pas montrer (blame, fichier trop gros, licence qui interdit, quota épuisé, recherche d'un gros dépôt), par un lien discret « At the source » après une phrase qui dit pourquoi.
  - **Un seul moteur Markdown** écrit ici (GFM, filtre de balises de GitHub), avec les maths (TeX vers MathML, sans bibliothèque) ; les README sur l'accueil et dans les dossiers.
  - **Les cartes de traçage dans le code** (le cœur recherche) : 64 fragments statiques sans texte d'article ; les lignes liées aux couleurs du lecteur, « expliquer ces lignes » (les paragraphes des Méthodes que la carte relie, sans modèle), « interroger un commit » (les liens de carte que le commit a modifiés) ; permaliens lus pareil par le site et le Mac.
  - **Fichiers riches** : notebooks Jupyter rendus sans jamais être exécutés, tableaux CSV/TSV, SVG, PDF dans le lecteur du navigateur, cartes et modèles 3D décrits en mots, et la vue Docs (GitHub Pages adapté : le Markdown de `docs/` en pages).
  - **À propos** : langages calculés depuis l'arbre (façon Linguist, `.gitattributes` respecté), fichiers communautaires, « Citer ce dépôt » (APA et BibTeX depuis `CITATION.cff` ou `codemeta.json`).
  - **Recherche** : le chercheur de fichiers (touche `t`) et la recherche dans le texte d'un petit dépôt, dans le navigateur, à l'envoi du formulaire.
  - **Coût** : zéro requête Worker et zéro ligne D1 hors connexion ; les fichiers sont lus en brut (hors quota GitHub du lecteur).
  - **Essai de bout en bout** : tout passe, avec les adresses de la phase 02 et le fragment des cartes. Captures : `docs/night-screenshots/phase-02/` (31 images, bureau et téléphone).
  - **Tests à la clôture** : pytest 472 ; ruff propre ; `npm test` 924 sous Node 26 et Node 22 ; build 45 pages, 227 fichiers ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 03 (édition dans le navigateur) : terminée**, branche `night/phase-03-web-editing`, poussée (6 commits : les éléments E1 à E5, la clôture). Rien fusionné, rien déployé.
  - **L'éditeur d'OSCR, pas celui de GitHub** : modifier, créer, renommer, déplacer, supprimer et téléverser des fichiers se fait dans OSCR (`/r/<compte>/<nom>/edit/…`, `new/…`, `upload/…`, `delete/…`, les formes d'adresses de GitHub). L'éditeur ressemble à la visionneuse : ce sont ses propres lignes (couleurs highlight.js, gouttière de numéros, indentation exacte) sous une zone de texte transparente, sans bibliothèque qui injecte des styles (CodeMirror en injecte : refusé par la CSP et par la règle « science.css seulement »). Indentation lue dans `.editorconfig` ou dans le fichier, recherche et remplacement, aller à la ligne, retour à la ligne, annuler/rétablir, renommer et déplacer par le champ du nom, onglets Édition / Aperçu / Modifications, touche `e` depuis la visionneuse.
  - **Le brouillon reste dans le navigateur** du lecteur jusqu'au commit ; si la branche a bougé entre-temps, la page le dit, fusionne à trois voies dans le navigateur quand les deux changements ne se touchent pas, sinon propose une nouvelle branche.
  - **Le commit** : une seule action autorisée (`commit`), faite par GitHub en ton nom avec la tête de branche que la page a lue (si la branche a bougé, refus 409 et rien n'est enregistré) ; message et description, branche courante ou nouvelle branche (la pull request elle-même est pour la phase 04 : la réponse la prépare), proposition depuis une copie (fork) quand GitHub dit que la personne ne peut pas écrire, co-auteurs et « Signed-off-by » avec les adresses no-reply de GitHub (jamais une adresse tapée), 1 ligne D1.
  - **Le lien recherche** : avant le commit, la boîte de dialogue liste les liens de carte de traçage que le changement touche (article, paragraphe des Méthodes, lignes) et choisit alors une nouvelle branche par défaut. Elle avertit aussi d'un secret apparent (jeton, clé), qu'il faut cocher pour continuer.
  - **Téléversements et suppressions** : jusqu'à 100 fichiers et environ 1 Mio par commit via le Worker (au-delà, la page de GitHub, avec la raison) ; les motifs LFS de `.gitattributes` respectés ; un dossier supprimé est d'abord listé ; une image collée dans un Markdown rejoint le même commit à côté du fichier.
  - **Modèles** : licences et codes de conduite (textes de l'API de GitHub, le contact d'un code de conduite remplacé par la page du dépôt dans OSCR, jamais une adresse), `CITATION.cff` depuis l'article lié, README de recherche ; `CITATION.cff`, `codemeta.json` et `.zenodo.json` vérifiés à la frappe ; barre d'outils Markdown, raccourcis, collage de lien et de tableau, commandes `/table`, `/code`, `/details`, `/cite`.
  - **Coût** : éditer ne demande rien au Worker ; un commit coûte 4 requêtes Worker (le plan en comptait 2 : les deux lectures du jeton CSRF viennent du flux de la phase 01) et 1 ligne D1.
  - **Essai de bout en bout** : tout passe, dont un commit à travers le faux GitHub, un refus quand la branche a bougé, une nouvelle branche, un déplacement, et le refus d'un autre compte (`FORGE_OPEN` non posé). Captures : `docs/night-screenshots/phase-03/` (30 images, bureau et téléphone, connecté, jusqu'à la page de retour après un vrai commit).
  - **Tests à la clôture** : pytest 472 ; ruff propre ; `npm test` 983 sous Node 26 et Node 22 ; build 45 pages, 227 fichiers (aucun nouveau) ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 04 (forks et pull requests) : terminée**, branche `night/phase-04-pull-requests`, poussée (7 commits : les éléments E1 à E6, la clôture). Rien fusionné, rien déployé.
  - **Les pull requests se lisent, se relisent et se fusionnent dans OSCR** (ta consigne : GitHub est le concurrent). GitHub garde les pull requests (ce sont ses objets) et fait chaque fork, revue, commit et fusion en ton nom, une autorisation à la fois ; OSCR n'enregistre qu'une ligne D1 par action, jamais un titre, un texte ou un commentaire.
  - **Dix nouvelles actions** : forker, synchroniser un fork, ouvrir une pull request (brouillon, relecteurs, modifications autorisées aux mainteneurs pour un fork), la modifier (titre, description, base, fermer ou rouvrir — jusqu'à 25 d'un coup en une seule autorisation —, brouillon ou prête, relecteurs, fusion automatique, supprimer ou restaurer la branche), relire (Commenter, Approuver, Demander des changements, avec des commentaires sur une ligne ou plusieurs et des suggestions ; l'auteur ne peut pas s'approuver), commenter et répondre, résoudre une conversation, fusionner (commit de fusion, squash ou rebase, à la tête que la page montrait : si un commit arrive entre-temps, rien n'est fusionné), mettre la branche à jour, annuler une pull request fusionnée.
  - **Les pages**, aux adresses de GitHub dans la coquille `/r/` (aucun fichier par pull request) : la liste avec les qualificatifs de GitHub (`is:`, `author:`, `label:`, `review-requested:`, `base:`… avec ET, OU, parenthèses, négation) ; le formulaire de création sous une comparaison (titre tiré de la branche, modèle du dépôt ou **modèle de recherche** — ce qui change, si cela modifie des résultats publiés, l'article, comment c'est vérifié —, aperçu, relecteurs suggérés, mots-clés de fermeture annoncés, le changement en chiffres) ; la page d'une pull request (la conversation, les étiquettes de rôle en mots : auteur, **auteur vérifié de l'article**, propriétaire du code ; la boîte de fusion ; les commits ; les vérifications lues sur GitHub) ; les forks (formulaire, liste, état d'un fork face à l'original avec « Sync fork » et « Contribuer »).
  - **« Files changed » dans la visionneuse d'OSCR** : diffs unifiés et côte à côte de la phase 02, fichiers « vus » gardés dans le navigateur, un clic sur un numéro de ligne pour commenter (maj-clic pour plusieurs lignes), une revue en attente gardée dans le navigateur et envoyée d'un seul coup, les suggestions montrées comme le changement qu'elles font et **appliquées en un commit** sur la branche de la pull request (une ou par lot, les auteurs des suggestions en co-auteurs).
  - **Les conflits se résolvent dans le navigateur** : les trois versions viennent de GitHub, les conflits sont calculés sur l'ordinateur du lecteur, chacun reçoit un choix (un côté, les deux, ou ses propres lignes), puis **un seul commit à deux parents** sur la branche, fait par GitHub en ton nom. Ce qui dépasse (fichier supprimé ou renommé d'un côté, binaire, plus de 100 fichiers ou 1 Mio) est dit, avec les commandes git.
  - **La couche recherche** : chaque pull request dit quels liens de carte de traçage elle touche, fichier par fichier (l'article, le paragraphe des Méthodes, les lignes, et si elles changent) ; les auteurs vérifiés de l'article sont suggérés comme relecteurs (aux seules personnes qui gèrent le code) ; CODEOWNERS est lu comme GitHub le lit.
  - **Essai de bout en bout** : tout passe (77 vérifications), dont ouvrir une pull request, un commentaire de ligne avec une suggestion, la suggestion appliquée, une fusion refusée parce que la tête a bougé, la fusion, un conflit refusé, et le fork et le commentaire d'un autre compte refusés (`FORGE_OPEN` non posé). Captures : `docs/night-screenshots/phase-04/` (28 images, bureau et téléphone, connecté).
  - **Tests à la clôture** : pytest 472 ; ruff propre ; `npm test` 1 036 sous Node 26 et Node 22 ; build 45 pages, 227 fichiers (aucun nouveau) ; `check --every-route` ok ; `tsc --strict` propre.
- **Suite** : phase 05 (issues) sur la branche `night/phase-05-issues`, créée et poussée.

## 2. À valider par Yann

1. **Enregistrer l'App GitHub d'OSCR**, distincte de l'App OAuth de connexion existante (qui garde zéro scope). Avec ton compte, ou une organisation gratuite qui ne contiendra aucun dépôt. Réglages :
   - nom tiré de `SITE_NAME` ;
   - URL de rappel `https://oscr.yannbellec-b.workers.dev/forge/authorized/`, plus une URL de développement locale (jusqu'à 10 sont permises) ;
   - « Request user authorization (OAuth) during installation » activé (GitHub désactive alors la Setup URL, et la page de rappel gère le retour d'une installation) ;
   - URL du webhook `.../api/forge/webhook`, avec un secret ;
   - jetons utilisateur qui expirent : activé ;
   - device flow : activé, pour l'outil en ligne de commande ;
   - installable par n'importe quel compte.
2. **Permissions et événements de l'App** : Metadata en lecture ; Repository creation, Administration, Contents, Pull requests, Issues et Checks en écriture ; Workflows non demandé ; aucune permission de compte (pas d'email). Événements : installation, installation_repositories, push, pull_request, repository, create, delete, release.
3. **Lancer `sh tools/setup_cloudflare.sh`** une fois l'App enregistrée (la phase 01 y a ajouté l'étape 8) : il crée, lie et migre la base D1 `oscr_forge`, puis demande sans rien afficher `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`, le **chemin** du fichier `.pem` de la clé privée (jamais collée ni affichée), le nom public de l'App (`GITHUB_APP_SLUG`) et **ton identifiant GitHub numérique** (`FORGE_OWNER_GITHUB_ID`, lu sur `https://api.github.com/users/<ton login>`, champ `id`). Les deux derniers sont des secrets pour qu'un déploiement ne les efface pas (D01-2). `FORGE_OPEN` n'est jamais posé.
4. **Activer le côté Mac** : ajouter `OSCR_FORGE_PUSH=remote` aux réglages une fois la base créée ; `oscr nightly` lira alors les têtes des miroirs et écrira la couche statique avant le déploiement, et `oscr jobs poll --remote` traitera aussi les tâches de la forge.
5. **Décider C3** : transférer 20 000 lignes D1 par jour des 80 000 de la poussée de recherche vers le côté GitHub, après son premier chargement complet. D'ici là, le service forge est plafonné dans le code à 5 000 lignes par jour, dans les 10 000 du Worker.
6. **Décider si un jeton utilisateur GitHub peut être gardé, chiffré, dans le cookie de session pendant ses 8 heures** : moins d'allers-retours d'autorisation, et blame et recherche de code pour les lecteurs connectés, sur leur propre quota. Sinon, chaque écriture garde sa propre autorisation.
7. **Décider s'il faut activer l'alias de clonage sur le domaine d'OSCR** (un 302 de `.../info/refs` vers github.com ; possible en une seule règle statique `_redirects`), après un clonage et une poussée de test avec identifiants.
8. **Décider si OSCR peut demander par défaut à Software Heritage d'archiver les commits des cartes de traçage validées.** Aujourd'hui il ne fait que l'interroger, et une demande reste l'acte de l'auteur.
9. **Facultatif** : créer un dépôt modèle public de « compendium de recherche » (README, LICENSE, CITATION.cff, fichier d'environnement, workflow de test facultatif sur les runners standard).
10. **Une fois l'App créée, tester** : si une personne déjà autorisée est renvoyée sans invite ; `POST /user/repos` avec le jeton utilisateur de l'App quand l'installation ne couvre que des dépôts choisis ; la plus grosse charge `createCommitOnBranch` que GitHub accepte, et son erreur pour une tête périmée ; la taille réelle des webhooks ; le blame d'un long fichier dans les 10 s de GraphQL. Phase 03 ajoute : un commit depuis l'éditeur sur un dépôt où l'App est installée (et le message de GitHub quand elle ne l'est pas : un jeton d'App ne voit que les dépôts de ses installations) ; « Proposer » depuis un fork tout juste créé (GitHub copie en arrière-plan) ; si l'exigence de « sign-off » des commits web s'applique aussi à `createCommitOnBranch`.
11. **Seulement si tu veux un jour qu'OSCR héberge lui-même les dépôts** (aucune option n'est à la fois gratuite et certaine) : Workers Paid plus R2 (environ 6,35 $ par mois à 100 Go) avec git-on-cloudflare ; Cloudflare Artifacts une fois disponible pour tous (environ 54,50 $ par mois) ; un Forgejo ou GitLab institutionnel sans carte, sous un accord signé ; ou la permission écrite de GitHub au titre de l'AUP §6 (déconseillé). Chacune ajouterait un backend derrière `GitBackend`.

12. **Branche `openalex`** (hors mission de nuit, terminée et poussée, non fusionnée : la nuit interdit de fusionner dans `main`). Enrichissement par OpenAlex :
    - schéma 7, 422 tests ;
    - sur une copie de la base : 95 % des articles ont une institution ROR (contre 11 %), 96 % un thème ; coût 0,0001 $.
    - À faire après fusion : `.venv/bin/python -m oscr enrich --openalex`, environ 4 heures, reprenable.
13. **Urgent avant cette fusion : le budget de fichiers du site.**
    - Avec les pages d'institutions, la construction sur les vraies données donne 16 905 fichiers, au-delà de la marge de 15 000 du contrôle (limite dure de Cloudflare : 20 000).
    - Il faut générer les pages d'entités à la demande, ou baisser `STATIC_MAX`.
14. **Décision prise, à relire** : un ORCID n'est repris d'OpenAlex que s'il a été déposé par l'éditeur. Les profils d'auteurs d'OpenAlex en ajouteraient 54 280, mais OpenAlex fusionne parfois deux personnes, et un ORCID fait d'une personne l'auteur vérifié d'un article.
15. **Ménage** : `.worktrees/openalex/data/dev-copy` (6,4 Go, copie de travail) peut être supprimé. Bug ancien signalé : `IndexError` dans `_shell_word`, `oscr/repofeatures.py`.

**Phase 01, à relire (décisions prises, D01-1 à D01-29) :**

16. **Licence par défaut** (D01-21) : `/new/` présélectionne la licence MIT et explique pourquoi (réutilisation, copies des scripts, archivage) ; « Aucune » reste à un clic. Une adresse qui demande un dépôt vide (import) n'en met pas.
17. **Statut d'un article attaché** (D01-22) : « lié » seulement pour un auteur vérifié de l'article ou un mainteneur du dépôt (rôles d'`oscr_community`) ; sinon « proposé » à ses auteurs. Créer un dépôt n'en fait pas un mainteneur à lui seul.
18. **Webhooks** (D01-24) : un changement de deux lignes (renommage, dépôt devenu privé, poussée vers un dépôt qui a des cartes) s'écrit sans ligne de livraison, idempotent par lui-même ; ces lignes, rares, restent hors du compte global de 5 000 par jour.
19. **Retour d'installation de l'App** (D01-20) : la page redemande l'autorisation ordinaire (avec PKCE) au lieu d'utiliser le code de la page d'installation ; un aller-retour de plus, sur ce seul chemin.
20. **Suppression** (D01-27) : la suppression définitive sur GitHub n'est possible qu'après une demande (pendant les 30 jours, ou après, quand la tâche du Mac a caché le dépôt), et seulement par une nouvelle autorisation de la personne. Aucun minuteur ne supprime.
21. **À tester avec la vraie App** : si GitHub renvoie bien `state` au retour d'installation ; qu'une personne déjà autorisée repasse sans invite ; `POST /user/repos` et `…/generate` avec le jeton utilisateur de l'App ; les réponses réelles de `/repos/{o}/{r}/autolinks` (préfixe en double : 422 `already_exists`).
22. **Facultatif** : une fois le dépôt modèle de compendium créé, poser la variable de build `COMPENDIUM_TEMPLATE=<compte>/<nom>` : `/new/` le proposera (D01-9).

**Phase 02, à relire (décisions prises, D02-1 à D02-19) — aucune action requise de ta part :**

23. **Porte de licence** (D02-7) : sans licence ouverte détectée par GitHub, les fichiers d'un dépôt sont listés mais pas montrés (le README non plus ; l'accueil garde son court extrait de la phase 01), avec un lien « At the source » et une phrase qui invite les auteurs à ajouter une licence.
24. **Moteur Markdown et maths maison** (D02-9) : l'inventaire citait Temml ; le MathML est écrit directement (aucune bibliothèque, aucune feuille de style, aucune police), et une commande TeX inconnue s'affiche telle quelle.
25. **Images d'autres sites** (D02-6) : jamais chargées par la page (pas de proxy) ; un lien qui nomme l'hôte. Les images du dépôt lui-même, y compris ses adresses brutes GitHub, sont lues et affichées.
26. **Fichiers communautaires par défaut** (D02-18) : l'accueil essaie au plus 4 lectures brutes à la racine de `<compte>/.github` (gratuites) plutôt que l'API « community profile » (qui coûterait une requête du quota du lecteur).
27. **Blame** (D02-5) : reste la page de GitHub (elle exige une connexion GitHub), en dernier recours, avec la phrase.
28. **Recherche** (D02-16) : dans le navigateur, pour les dépôts de moins de 300 fichiers et 4 Mo de texte ; au-delà, la recherche de code de GitHub, en dernier recours.

**Phase 03, à relire (décisions prises, D03-1 à D03-19) — aucune action requise de ta part :**

29. **Pas de CodeMirror** (D03-3) : l'inventaire le citait ; il écrit des balises `<style>`, que la CSP (`style-src 'self'`) et la règle « science.css seulement » interdisent. L'éditeur est la visionneuse elle-même sous une zone de texte transparente.
30. **Un commit ne demande pas que le dépôt soit lié à OSCR** (D03-1) : GitHub décide qui peut écrire ; `FORGE_OPEN` restant non posé, toi seul peux committer pour l'instant.
31. **Proposer depuis un fork** (D03-8) : case cochée par défaut, et dite dans la phrase à confirmer ; GitHub crée alors la copie dans le compte de la personne si elle n'a pas le droit d'écrire.
32. **Adresse et signature d'un commit** (D03-9) : celles que GitHub donne aux commits web de la personne (son adresse no-reply si elle garde la sienne privée) ; l'inventaire proposait une adresse no-reply d'OSCR et une signature d'OSCR, écartées puisque GitHub fait et signe le commit (D00-7).
33. **Types de fichiers téléversés non restreints** (D03-12) : rien de téléversé n'est jamais exécuté ni servi comme une page par OSCR ; les motifs LFS sont respectés ; au-delà d'environ 1 Mio, la page de GitHub, avec la raison.
34. **Coût mesuré** (D03-19) : 4 requêtes Worker par commit (le plan en comptait 2), 1 ligne D1.

**Phase 04, à relire (décisions prises, D04-1 à D04-19) :**

35. **À faire au moment de fusionner** : appliquer les deux nouvelles migrations (`npx wrangler d1 migrations apply oscr_forge --remote` et `… oscr_community --remote`, ou relancer `sh tools/setup_cloudflare.sh`) : `0003_pulls.sql` (les dix sortes d'actions) et `0003_roles_by_paper.sql` (un index pour trouver les auteurs vérifiés d'un article).
36. **Auteurs de l'article suggérés comme relecteurs** (D04-10) : leur identifiant GitHub est montré seulement aux personnes qui gèrent le dépôt (propriétaire, mainteneur, qui l'a lié) ou qui ont écrit un des articles ; jamais hors connexion ni dans un fichier statique. Si tu préfères que chaque auteur l'accepte d'abord, c'est à changer.
37. **Le garde des cartes de traçage vit dans OSCR** (D04-12) : la vérification que l'App posterait sur GitHub (« tracing-map links touched ») est reportée ; les liens touchés sont montrés dans les pages d'OSCR.
38. **Un commit sans droit d'écriture sur le dépôt est tenté, et GitHub décide** (D04-6) : c'est le cas d'un mainteneur qui applique une suggestion ou résout un conflit sur la branche d'un fork (« Allow edits by maintainers ») ; un refus de GitHub est dit, avec l'offre de proposer depuis un fork.
39. **Les méthodes de fusion permises** (D04-4) : l'API anonyme ne dit pas lesquelles le dépôt autorise ; les trois sont proposées et un refus de GitHub est dit en mots.
40. **Résoudre une conversation** (D04-9) : GitHub ne donne cet état qu'en GraphQL authentifié ; OSCR sait résoudre ou rouvrir, mais ne montre pas l'état aux lecteurs.
41. **À tester avec la vraie App** : qu'un jeton utilisateur de l'App puisse committer sur la branche d'un fork dont la pull request autorise les mainteneurs ; `resolveReviewThread` et `revertPullRequest` avec ce jeton ; `merge-upstream` ; le message de GitHub quand une méthode de fusion n'est pas permise (405) ; la file de GitHub des « suggested changes » quand la même ligne a plusieurs suggestions.

## 3. Décisions prises

Voir [`docs/DECISIONS.md`](DECISIONS.md) (entrées D00-1 à D00-16, puis D01-1 à D01-29 pour la phase 01 : les dix du plan, et dix-neuf prises en construisant ; D02-1 à D02-19 pour la phase 02, décrites dans [`docs/CODE_NAVIGATION.md`](CODE_NAVIGATION.md) ; D03-1 à D03-19 pour la phase 03, décrites dans [`docs/WEB_EDITING.md`](WEB_EDITING.md) ; D04-1 à D04-19 pour la phase 04, décrites dans [`docs/PULL_REQUESTS.md`](PULL_REQUESTS.md)).

Décision de stockage : aucune option ne permet à OSCR d'héberger lui-même des dépôts Git à coût nul avec une conformité certaine aux conditions des services (D00-1). Les dépôts vivent donc dans le compte GitHub du chercheur, créés et pilotés par l'App GitHub d'OSCR avec son autorisation, une autorisation par action, plus le mode miroir pour les dépôts existants ; OSCR ne garde que sa propre couche (articles, DOI, cartes de traçage, revues) dans une nouvelle base D1 `oscr_forge` et sur le Mac (D00-2).

## 4. Blocages et reports

1. **Comptage** : les tableaux des fichiers de section contiennent 5 153 lignes de fonctionnalités, 5 de moins que les 5 158 annoncées par l'inventaire structuré. Chaque ligne de tableau est dans `GITHUB_PARITY.md`. L'écart ne peut pas être retracé sans les résumés JSON des chercheurs ; causes probables : des résumés d'addenda qui comptaient des éléments écartés, ou des fonctionnalités regroupées dans une même ligne. Les tableaux font référence.
2. **L'exhaustivité n'est pas prouvée** : la boucle des critiques s'est arrêtée à sa limite de quatre tours, et le tour 4 (addendum 4.1) trouvait encore des fonctionnalités. Le fichier le dit en section 1.
3. **31 noms de fonctionnalités reçoivent des décisions différentes selon les sections** (par exemple « Signed tags », « Secret scanning partner program », « Removing sensitive data from history »). Ils sont listés en section 3.4, à trancher par les phases ou par `PLATFORM_PLAN.md` ; l'assemblage n'a changé aucune décision.
4. **Dates** : la date nominale de la nuit (2026-09-29) est postérieure aux dates de lecture notées par les fichiers de section (2026-09-27 et 2026-09-28 ; dernière entrée du changelog : 2026-09-25). Le fichier donne les deux.
5. **Non fait** : les requêtes conditionnelles facultatives (`deps.etags`, conception §11.2). Le navigateur s'appuie sur le cache HTTP ; le lecteur Python utilise bien les ETags pour surveiller les têtes.
6. **Non vérifié tant que l'App n'existe pas** (conception §18) : les types et messages d'erreur GraphQL (par exemple la réponse à un `expectedHeadOid` périmé) et les textes des erreurs 422 sont les formes documentées par GitHub, vérifiées seulement contre des fixtures et le faux GitHub.
7. **Mesures CPU** : faites avec V8 sur le Mac (Node 26 et 22), pas avec workerd. Un JSON de la forme d'un webhook de 5 Mio prendrait 15 à 19 ms à analyser et resérialiser : le plafond de 1 Mio pour les webhooks doit rester.
8. **Dépôt vide** : l'API de GitHub nomme une branche par défaut même pour un dépôt vide ; un dépôt vide montre donc `defaultBranch` à « main » via l'adaptateur, et non null. Le contrat n'exige pas null dans ce cas.
9. **Commits vides** : le chemin de commit GraphQL de l'adaptateur ne refuse que `changes: []` sans `allowEmpty`. Un commit dont les changements laissent l'arbre inchangé est refusé par le double mais enregistré par GitHub.
10. **Limites du double** : il fusionne au niveau des chemins (GitHub fusionne aussi des lignes différentes d'un même fichier), et ses diffs ne détectent pas les renommages. Les deux points sont documentés ; le contrat n'exige que ce que les deux côtés partagent.
11. **`links.parse`** lit une révision d'arbre ou de blob comme un seul segment : un nom de branche contenant « / » est ambigu, comme sur GitHub. Les permaliens des cartes de traçage utilisent des identifiants de commit, donc ne sont pas touchés.
12. **Pas encore branché dans le Worker** (phase 01) : rien dans `worker/index.ts` ni `worker/env.ts` n'importe `forge/`, et `ForgeEnv` vit dans `github/index.ts`. À créer par toi : les secrets Cloudflare `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` et `GITHUB_APP_WEBHOOK_SECRET`, la variable `GITHUB_APP_SLUG`, et la base D1 `oscr_forge`.
13. **Jeton du Mac dans les arguments de git** : `oscr/forge.py` réutilise `repos._auth_github` pour le jeton en lecture seule du Mac lors des appels git. Comme le code de clonage existant, cela place l'en-tête du jeton dans les arguments du processus git.
14. **Lien vers `GITHUB_PARITY.md`** : la nouvelle section d'`ARCHITECTURE.md` pointe vers `docs/GITHUB_PARITY.md`, qui n'existait pas encore dans le worktree au moment de l'écrire. Le lien fonctionne depuis que la phase 00 a commité ce fichier.
15. **Une commande git hors consigne** : au début, un agent a lancé un `git status` en lecture seule dans le worktree de nuit avant de remarquer la consigne « aucune commande git ». Il n'a rien changé, et aucune autre commande git n'a été lancée par cet agent.
16. **Adaptations incompatibles avec la décision de stockage** : certaines adaptations de l'inventaire supposent qu'OSCR héberge lui-même les dépôts, ce que la décision de stockage exclut. Le plan suit la décision de stockage dans chaque cas : le wiki devient une branche `wiki` du dépôt au lieu d'un second dépôt ; le blame est un lien vers GitHub plus le blame local, sans lecture par le Worker ; les snippets ne sont pas des dépôts à part ; le lien de revue par les pairs vers un dépôt privé attend ta décision sur les dépôts privés (D00-14).
17. **Page `/status`** : l'inventaire la voulait rafraîchie depuis les vérifications toutes les cinq minutes, mais les pages statiques ne changent qu'au déploiement. Le plan dit que la page indique quand elle a été construite.
18. **Recherche de code** : celle de l'inventaire (`oscr_code`, recherche plein texte avec le tokenizer trigram) ne peut pas contenir tout le stock de scripts publiés dans une seule base D1 de 500 Mo. Le plan dit qu'elle couvre d'abord les dépôts liés à des articles, et dit ce qu'elle couvre. C'est aussi une cinquième base D1 à créer par toi.
19. **Décisions du plan** : les neuf décisions du plan en §15.7 ne sont pas encore dans `docs/DECISIONS.md`. Chacune doit y être consignée par la phase qui la construit.
20. **Budgets par phase** : ce sont des estimations de planification, calibrées sur la journée de la conception à environ 3 000 dépôts (environ 7 000 requêtes et 2 300 lignes écrites). Elles restent à mesurer.

**Phase 01 :**

21. **Rien de reporté** parmi les éléments du plan. Ce que le plan laisse de côté le reste : les jetons d'API propres à OSCR (phase 10), les dépôts privés (ta décision, D00-14), l'alias de clonage sur le domaine d'OSCR, les imports côté serveur (l'API de GitHub est retirée : les imports se font sur l'ordinateur du chercheur), les gists (phase 13).
22. **Travail partiel repris** : les fichiers laissés par les sessions interrompues (E1, E7, E9, E11, E12) ont été gardés et terminés ; les tests d'E9 et les deux pages de guide d'E12 (`/hosting/import/`, `/hosting/leave/`) ont été écrits. Le test de fondation « tant que ce n'est pas construit » d'E9 a été remplacé par les vrais tests d'E9, et la liste des routes « bouchons » du test de fondation s'est vidée à mesure qu'elles étaient construites (les invariants restent vérifiés).
23. **Commande `tsc`** : le motif `tests/*/*/*.ts` ne correspond à aucun fichier (tsc s'arrête dessus) ; la vérification a tourné sur les mêmes fichiers listés par `find worker tests -maxdepth 3 -name "*.ts"`.
24. **Port 8790** : occupé par le tableau de bord local (`oscr dashboard`), laissé intact ; l'essai de bout en bout a tourné sur 8791, 9490 et 9491, tout arrêté ensuite.
25. **Captures des pages `/r/`** : la politique de sécurité (CSP) de ces pages n'autorise que les adresses de GitHub ; le navigateur de test l'a contournée pour atteindre le faux GitHub local (D01-29). Les en-têtes du site sont inchangés.
26. **Page des branches** : les vues « récentes », « anciennes » et « les tiennes » lisent le dernier commit de chaque branche (une requête par branche, 30 au plus, seulement quand on choisit la vue), sur le quota anonyme du lecteur (60 par heure hors connexion).
27. **Autoliens** : GitHub ne les liste qu'aux administrateurs du dépôt ; la page des réglages permet d'en ajouter et d'en supprimer, et renvoie à la page de GitHub pour la liste.
28. **Non mesuré dans workerd** : le temps CPU des routes de la forge (à mesurer une fois déployé).

**Phase 02 :**

29. **Reporté** (dans le plan, faute de temps ou par choix de sécurité) : lignes collantes et repli du code ; volet des symboles, aller à la définition, références ; recherche dans le fichier ; visionneuse 3D STL ; cartes GeoJSON (il faudrait un service de tuiles) ; dessin des diagrammes Mermaid (styles en ligne interdits par la CSP) ; reStructuredText rendu sur le Mac ; aperçu social ; DOI d'une release dans la citation ; « branches qui contiennent un commit » (pas d'API REST) ; copies identiques (empreintes du stock de scripts) ; diffs rendus de prose et de notebooks ; fichiers `linguist-generated` repliés dans les diffs.
30. **Travail interrompu repris** : `markdown.ts` et `mathml.ts` d'E2, laissés non commités par la session précédente, ont été gardés et terminés (performance bornée sur les textes pathologiques, liens autos, maths « prix », tests).
31. **Espace de travail partagé** : le brouillon de cette session est partagé avec l'agent de la branche `code-first` (qui fait tourner son propre Chrome sur le port 9396) ; mes fichiers étaient dans un sous-dossier, rien de lui n'a été touché. Le faux GitHub sur le port 9492, laissé par une session précédente de la phase 02, a été arrêté à la fin, comme mon Chrome (9390) et mon serveur statique (8793).
32. **Captures** : servies par un petit serveur statique qui applique les en-têtes du site et autorise en plus le faux GitHub local dans `connect-src` (outil de test seulement ; les en-têtes du site sont inchangés, D01-29).
33. **Point de rencontre avec `code-first`** : les classes `.hljs-*`, `ol.lines.code`, `nav.file-tree`, `.pair-1` à `.pair-6` et l'ancre `#pair-N` du lecteur ; `traced.ts` répète `pairClass` de `lines.ts` (qui ne se charge pas dans les tests Node). À la fusion, garder une seule définition.

**Phase 03 :**

34. **Reporté** : saisie automatique des emoji ; aide à l'édition des workflows et de `devcontainer.json` (la licence du schéma SchemaStore est à vérifier avant de l'embarquer) ; co-auteurs choisis parmi les comptes OSCR (ce sont des comptes GitHub aujourd'hui) ; signature des commits par OSCR (GitHub signe les commits web) ; l'avertissement de branche protégée avant le commit (GitHub refuse au commit, en mots, et une nouvelle branche est proposée) ; « Proposer » de la liste communautaire en pull request (phase 04).
35. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490 et 9491 (wrangler dev, faux GitHub, simulateurs de connexion), plus le faux GitHub sur 9492, un serveur statique sur 8793 et Chrome headless sur 9390 ; tout est arrêté. Le port 8790 (ton tableau de bord) et le Chrome 9396 de l'agent `code-first` n'ont pas été touchés. Un `wrangler deploy` lancé depuis le checkout de production (pas par moi) tournait pendant la clôture : laissé intact.
36. **Non vérifiable sans la vraie App** : qu'un jeton utilisateur de l'App puisse committer sur un dépôt où l'App n'est pas installée (GitHub le refuse sans doute : la page le dit alors en mots) ; le délai de copie d'un fork tout neuf avant un commit (la page dit d'attendre une minute) ; l'application de l'exigence de « sign-off » à `createCommitOnBranch`.

**Phase 04 :**

37. **Reporté** : la vérification « liens de carte touchés » postée par l'App sur GitHub (jeton d'installation sur les webhooks `pull_request`) ; le tableau de bord des pull requests avec sa boîte de réception et ses vues enregistrées (la boîte de réception est de la phase 08) ; la fusion d'une pile de pull requests d'un coup ; poser l'étiquette « Alters reported results » (les étiquettes sont de la phase 05 ; la page l'affiche quand elle est posée) ; le ré-ancrage d'une carte après une fusion (le Mac) ; la file de fusion ; archiver une pull request ; les réactions ; la bannière « Compare & pull request » ; les commentaires sur un fichier entier ou sur un commit ; « Update with rebase » ; les diffs riches de notebooks ; les propriétaires du code dans la vue d'un fichier ; rejeter une revue ; relecteurs requis et équipes (phase 09) ; étiquettes, assignés et jalons modifiés depuis la page (phase 05).
38. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490 et 9491 (wrangler dev, faux GitHub, simulateurs de connexion) et Chrome headless sur 9390 ; tout est arrêté. Le port 8790 (ton tableau de bord) n'a pas été touché.
39. **Limites du faux GitHub, corrigées pour cette phase** : il garde désormais la tête d'une pull request après la suppression de sa branche (comme `refs/pull/<n>/head` de GitHub) et permet à un mainteneur de la base de committer sur la branche d'un fork dont la pull request l'autorise. La carte de traçage de la fixture pointe vers un commit fictif (`000…0`) : ses lignes sont retrouvées par le symbole, et le navigateur note une lecture brute 404 sans conséquence.

## 5. Branches, dans l'ordre de fusion

1. `night/phase-00-research` : terminée et poussée.
2. `night/phase-01-git-hosting` : terminée et poussée (construite sur la précédente).
3. `night/phase-02-code-navigation` : terminée et poussée (construite sur la précédente).
4. `night/phase-03-web-editing` : terminée et poussée (construite sur la précédente).
5. `night/phase-04-pull-requests` : terminée et poussée (construite sur la précédente).
6. `night/phase-05-issues` : créée à partir de `night/phase-04-pull-requests`, poussée, à construire.

## 6. Ajouts à `science.css`

- Phase 00 : aucun (elle n'a pas touché au site).
- Phase 01, dans l'esprit du fichier (pas de pastilles, pas de majuscules décoratives, pas de thème sombre, les états dits en mots) :
  - `.repo-head` (la ligne de titre d'un dépôt : compte / nom, et ses faits) ;
  - `p.status-line` (la phrase d'état du miroir) ;
  - `.setup` et `pre.commands`, avec `button.copy` (la mise en route d'un dépôt vide et les blocs de commandes à copier) ;
  - `fieldset.choices` et `.explain` (les listes à choix expliqués : licence, .gitignore, modèle) ;
  - `.limits` (le tableau compact des limites) ;
  - `section.danger` (archiver, transférer, supprimer : un bloc encadré, les conséquences en mots) ;
  - `table.branches`, `dl.settings` (deux colonnes à partir de 641 px), `.panel` (le panneau du bouton Code), `.confirm` (la phrase d'une action à confirmer) ;
  - les champs `input[type="url"]` et `input[type="search"]` des formulaires, comme les champs texte ;
  - leurs réglages pour le téléphone (moins de 641 px).
- Phase 02, dans le même esprit :
  - la visionneuse : `.hljs-*` (les couleurs de highlight.js), `ol.lines.code` (gouttière, lignes choisies), `nav.file-tree`, `p.at-source` (le lien discret vers la source), `.line-menu`, `.code-layout`, les en-têtes de fichier ;
  - l'historique et les diffs : `ol.commit-list`, `section.file-diff`, `table.diff` (unifié et côte à côte), `.image-diff` (côte à côte, balayage, pelure d'oignon en onze pas) ;
  - le rendu Markdown : `.markdown-body` (titres et leur « § », alertes dites en mots, tableaux, listes de tâches, notes, blocs de maths), `details.outline`, `section.readme` ;
  - les cartes de traçage : `li.traced` (barre dans la gouttière), `.traced-note`, `p.traced-explain` ;
  - les fichiers riches : `.notebook` et ses cellules, `table.data` et son filtre, `p.rich-note` ;
  - la vue Docs : `.docs-layout`, `nav.docs-nav` ; l'À propos : `p.languages`, `ul.community`, `details.cite-repo` ;
  - la recherche : `form.finder`, `ol.finder-results`, `form.repo-search`, `ol.search-results` ;
  - leurs réglages pour le téléphone.
- Phase 03, dans le même esprit :
  - l'éditeur : `.editor-surface` et `.editor-stack` (la visionneuse sous une zone de texte transparente, une même police, un même interligne, une même marge), `textarea.editor-input`, les réglages de largeur de tabulation et de retour à la ligne, `.editor-tools`, `.editor-find`, `form.editor-goto`, `.editor-tabs`, `.editor-panel`, `p.editor-status`, `p.editor-foot`, `p.draft-note`, `.edit-head` (le chemin et le champ du nom), `button.primary` ;
  - la boîte de commit : `section.commit-dialog`, `.secret-warning` ;
  - téléversements et suppressions : `.upload-drop`, `table.upload-files`, `ul.delete-files`, `p.editor-extra` ;
  - modèles et aides : `.template-picker`, `.md-toolbar`, `p.metadata-check`, `p.community-missing` ;
  - leurs réglages pour le téléphone.
- Phase 04, dans le même esprit :
  - la liste : `form.pull-filter`, `p.pull-quick`, `ul.pull-list` et `li.pull-row` (l'état dit en un mot avant le titre, `.pull-state`, jamais une pastille), `p.pull-bulk` ;
  - la création : `section.pull-form`, `.pull-preview`, `ul.pull-suggested`, `.pull-summary`, `p.closing`, `textarea.pull-text` ;
  - la page d'une pull request : `.pull-head` et `.pull-number`, `p.merge-status`, `nav.pull-tabs`, `.pull-record`, `.pull-wide`, `.comment` et `p.comment-head` (le rôle en mots), `.review-*`, `.thread` (et `.outdated`, `.pending`), `p.thread-where`, `p.timeline-event`, `section.merge-box`, `.merge-form`, `section.comment-form`, `ul.reviewers`, `p.ask-review` ;
  - « Files changed » : `form.commit-select`, `.review-bar`, `section.review-panel`, `p.file-review`, `td.num.commentable`, les lignes de commentaires sous leurs lignes, `.suggestion`, `.file-traced` ;
  - les conflits : `.conflict`, `pre.conflict-ours`, `pre.conflict-theirs`, `pre.conflict-context`, `section.conflict-guide` ;
  - les forks : `ul.fork-list`, `p.fork-links`, `p.fork-status`, `form.fork-form` ;
  - leurs réglages pour le téléphone.
