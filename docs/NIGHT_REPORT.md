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
- **Phase 05 (issues) : terminée**, branche `night/phase-05-issues`, poussée (8 commits : les éléments E1 à E6, la clôture en deux parties). Rien fusionné, rien déployé.
  - **Les issues se lisent, s'écrivent, se trient et se ferment dans OSCR** (ta consigne : GitHub est le concurrent). Deux sortes : les issues ordinaires restent des objets de GitHub (lues dans le navigateur du lecteur, sur son quota ; écrites par GitHub en ton nom, une autorisation à la fois, 1 ligne D1) ; les **issues de recherche** sont les objets d'OSCR, dans `oscr_forge`.
  - **Onze nouvelles actions sur les issues de GitHub** : ouvrir (étiquettes, assignés, jalon, type d'une organisation, sous-issue d'une autre), modifier et fermer comme terminée, non prévue ou doublon de #n, rouvrir, étiquettes et assignés ajoutés ou retirés, jalon, type — jusqu'à 25 issues en une seule autorisation —, commenter (modifier, supprimer), réagir, verrouiller avec une raison, épingler, transférer, sous-issues et « bloquée par », créer la branche de l'issue, gérer les étiquettes (les dix de GitHub et trois pour le code de recherche : data, environment, numerical difference, en une autorisation) et les jalons.
  - **Les issues de recherche** : « erreur dans le code », « écart code ↔ article » (un lien de carte de traçage : le paragraphe de l'article, les lignes du fichier à un commit) et « échec de reproduction » (son rapport : résultat, environnement, commit, données, commande, ce que l'article annonce et ce qui est sorti). Chacune appartient à un article (son DOI) et à son code (un dépôt GitHub qu'OSCR connaît comme code de cet article, ou le code hébergé ailleurs : Zenodo, OSF…). Elles se nomment `research#12`. Ouvrir coûte 3 lignes D1, commenter 3, modifier 2 ; `FORGE_OPEN` les garde fermées aux autres que toi ; 20 par compte et par jour.
  - **Une pull request qui ferme une issue de recherche le dit** : « Fixes research#12 » dans son texte, la barre latérale annonce « la fusion dans OSCR ferme research#12 : corrigée dans le code », et la fusion la ferme ainsi, au commit de fusion (seulement celles que son texte nomme, de ce dépôt, vers la branche par défaut). L'auteur d'une issue de recherche peut la copier une fois sur GitHub comme issue ordinaire, avec l'étiquette de son type.
  - **Les pages**, aux adresses de GitHub dans la coquille `/r/` (aucun fichier par issue) et une nouvelle coquille `/research/` (un seul fichier) : la liste mêlant les deux sortes avec les qualificatifs de GitHub et ceux de la recherche (`is:research`, `type:mismatch`, `doi:`, `map-link:14:src/filter.py`, `resolution:`, `outcome:`…) et les actions groupées ; le choix du modèle (les trois formulaires de recherche d'abord, puis les modèles et formulaires du dépôt lus comme GitHub les lit) ; le formulaire (aperçu, **issues semblables** par mots partagés, **suggestions posées par règle** avec leur raison, jamais appliquées sans toi) ; la page d'une issue (la chronologie en mots, les réactions, les cases de la liste de tâches, les réponses enregistrées, le rappel « +1 », toutes les actions de tri) ; étiquettes (un mot et un petit carré de couleur tiré d'une palette de 16, jamais une pastille) et jalons ; la page d'une issue de recherche avec son rapport, sa résolution (corrigée dans le code, article corrigé, pas un écart, échec non reproduit, données disponibles).
  - **La couche recherche** : la section Discussion de la page d'un article liste ses erreurs et écarts, Reproductions ses échecs de reproduction (épinglées d'abord, « problèmes connus ») ; le lecteur Code ↔ Article propose « Signaler un écart » sur chaque correspondance, et la vue du code « Signaler un écart sur ces lignes » : le formulaire arrive rempli avec le paragraphe, le fichier, les lignes et le commit.
  - **Le Mac** : `oscr/forgelayer.py` publie chaque nuit les issues de recherche pour les lecteurs non connectés (64 fichiers au plus, « d'après la nuit dernière »).
  - **Essai de bout en bout** : tout passe (102 vérifications), dont une issue GitHub typée, étiquetée, commentée et fermée comme non prévue ; une issue de recherche ouverte, étiquetée, commentée et fermée avec une résolution ; une autre fermée par la fusion d'une pull request ; une copie sur GitHub ; les écritures d'un autre compte refusées. Captures : `docs/night-screenshots/phase-05/` (40 images, bureau et téléphone, hors connexion et connecté).
  - **Tests à la clôture** : pytest 474 ; ruff propre ; `npm test` 1 112 sous Node 26 et Node 22 ; build 46 pages, 233 fichiers (une nouvelle page : `/research/`) ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 07 (versions, paquets et environnements) : terminée**, branche `night/phase-07-releases`, poussée (10 commits : les éléments E1 à E6, les corrections de E4 après le navigateur, la clôture en trois parties). Rien fusionné, rien déployé.
  - **Les versions (releases) se lisent, se comparent et se font dans OSCR** (ta consigne : GitHub est le concurrent). Les releases, les étiquettes (tags) et leurs fichiers restent des objets de GitHub (lus dans le navigateur du lecteur, sur son quota ; écrits par GitHub en ton nom, une autorisation à la fois) ; ce qui est à OSCR, c'est la couche recherche : **une version du code liée à une version de l'article** (prépublication, manuscrit soumis ou accepté, version publiée, correction), **la carte de traçage versionnée avec elle**, l'archivage **Software Heritage** et le **dépôt Zenodo de la carte validée**, chacun à la demande d'une personne.
  - **Neuf nouvelles actions** : créer une release (brouillon d'abord, ou publiée **au commit exact que la page montrait** : c'est là que pointent les lignes de la carte), la modifier, la publier, la supprimer (l'étiquette reste), lire ses brouillons en ton nom (GitHub ne les montre qu'à qui peut pousser : ils restent dans l'onglet, jamais stockés), la lier à une version de l'article et demander Software Heritage ou Zenodo après coup, créer et supprimer une étiquette, joindre et supprimer un fichier. **Une citation garde son code** : une release publiée garde son étiquette et son commit ; une release liée à un article reste publiée et ne se supprime pas (délier d'abord) ; une étiquette qu'une release ou un article utilise ne se supprime pas ; les releases immuables de GitHub sont respectées et dites en mots.
  - **Le Mac** : la tâche `release` fige la carte de traçage de l'article pour cette version (son empreinte revient dans le lien) ; la tâche `deposit` dépose la carte **validée par un auteur vérifié avec son ORCID** sur Zenodo — nouvelle version de la notice de la carte, l'étiquette comme version, « IsSupplementTo » l'article, « References » le commit de la release ; **le bac à sable** tant que tu n'as pas changé `OSCR_ZENODO_INSTANCE` ; une validation faite avec le bac à sable d'ORCID est un test ; **le code n'est jamais déposé** ; un DOI du bac à sable n'apparaît jamais dans une sortie publique. `archive` nomme l'étiquette pour Software Heritage.
  - **Les pages**, aux adresses de GitHub dans la coquille `/r/` (aucun fichier par release) : la liste (triée par version sémantique, la recherche à l'envoi avec `draft:`, `prerelease:`, `tag:v1`, `created:`, `paper:`, `version:`), la page d'une release (notes, fichiers avec leur **SHA-256 calculé par GitHub**, « vérifier un fichier » que tu as : l'empreinte est calculée dans le navigateur, le fichier ne quitte pas l'ordinateur ; les archives de GitHub et ce que `export-ignore` en retire ; la comparaison avec une autre release ; l'article et sa carte), le formulaire (les versions suivantes proposées avec leur raison, le commit exact, **les notes écrites depuis ce qui a été fusionné**, groupées par `.github/release.yml` comme GitHub, avec une section « Pour l'article » : les liens de carte dont les fichiers ont changé, les issues de recherche corrigées), la dernière, le journal des modifications, les étiquettes ; l'onglet Releases ; **la page de l'article liste les versions de son code**.
  - **Fichiers** : jusqu'à 25 Mio par le Worker, sur une route à part (`POST /api/forge/asset`) : le fichier passe en flux, jamais analysé ni haché par le Worker (ses 10 ms de CPU), sa longueur tenue ; GitHub recalcule le SHA-256 et un fichier différent de celui confirmé est retiré. Le fichier attend dans l'onglet (IndexedDB, 10 minutes) pendant l'autorisation de GitHub. Au-delà : la page de GitHub, ou Zenodo et Hugging Face pour les données, avec la raison.
  - **Environnements** : les fichiers d'environnement (requirements, conda, renv, Project.toml, Dockerfile, devcontainer, pyproject…) lus comme du texte, **jamais exécutés** ; ce qu'ils figent dit en mots (versions exactes, fichiers de verrou, image par empreinte, ce qui est téléchargé à la construction, ce qu'un conteneur de développement lance sur la machine qui l'ouvre) ; Binder et Codespaces en simples liens qui disent qui les fait tourner. **Paquets** : aucun hébergé ; ceux que déclarent les manifestes sont confirmés ou refusés par une personne qui peut pousser, avec le lien du registre et la ligne d'installation à la version déclarée.
  - **Essai de bout en bout** : tout passe (131 vérifications), dont ton ORCID lié, une release publiée avec tes notes et celles de GitHub, liée au manuscrit accepté avec sa carte, Software Heritage et Zenodo demandés (5 lignes D1), puis **le Mac hors ligne avec un faux Zenodo local** (`oscr forge poll --instance sandbox`) : la carte versionnée, le dépôt fait sur le faux bac à sable ; les écritures d'un autre compte refusées. Captures : `docs/night-screenshots/phase-07/` (36 images, bureau et téléphone).
  - **Tests à la clôture** : pytest 482 ; ruff propre ; `npm test` 1 178 sous Node 26 et Node 22 ; build 46 pages, 235 fichiers (aucun par release) ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 08 (social, découverte, notifications et recherche) : terminée**, branche `night/phase-08-social`, poussée (7 commits : les éléments E1 à E5, la clôture en deux parties). Rien fusionné, rien déployé. **Ordre changé à ta demande** : après 07 viennent 08 puis 10 ; la phase 16 passe plus tard. Tout ce que 08 ajoute reste derrière `FORGE_OPEN` (seul ton compte écrit), et D08-17 dit ce que la phase 16 devra couvrir.
  - **Les étoiles, les listes, les abonnements sont à OSCR, jamais à GitHub** : OSCR ne met jamais d'étoile ni ne suit rien sur GitHub. Étoiles sur des dépôts, des articles et des sujets ; listes d'étoiles (32, publiques ou privées) **exportées en références BibTeX et RIS** ; surveiller un dépôt (toute l'activité, « participation et @mentions », sur mesure : issues, pull requests, releases, issues de recherche ; ou ignorer) ou **un article par son DOI** ; suivre une personne, une organisation, et **un auteur du catalogue par son ORCID avant qu'il ait un compte** (le chiffre de contrôle vérifié) ; une revue, un outil, un jeu de données, une catégorie. 2 lignes D1 par écriture ; 300 par compte et par jour, à part des 100 actions autorisées.
  - **Les notifications restent dans le site** (ta décision D5) : aucun e-mail n'est jamais envoyé, aucune adresse demandée. Une ligne par événement, rangée par son sujet (un dépôt ou un article), écrite avec ce qui l'a causé : les issues de recherche, les actions autorisées, et les webhooks de l'App (issues, commentaires, pull requests, releases : le titre et les logins cités, **jamais le texte**) ; **une action et le webhook de GitHub pour le même acte font un seul événement**, quel que soit l'ordre d'arrivée. La boîte de réception est calculée à la lecture depuis ce que tu surveilles et suis (rien n'est écrit par destinataire) : Boîte, Non lus, Enregistrés, Terminés, Lus ; les filtres de GitHub (`repo:`, `org:`, `author:`, `is:`, `reason:`) ; tri par lot, tout marquer lu, filtres enregistrés, se désabonner d'un fil ; la raison dite en mots (mentionné, tu l'as ouvert, tu as participé, tu surveilles le dépôt ou l'article). **Un dépôt devenu privé quitte aussitôt toutes les boîtes.**
  - **Profils** (`/u/<login GitHub ou ORCID>/`, une seule coquille) : nom, bio, pronoms, labo, lieu, fuseau, site et liens (https), statut, épinglés ; une image faite de cases (identicon, aucune image extérieure) ; le README de profil (le dépôt `<login>/<login>`, lu dans le navigateur et rendu par le moteur Markdown d'OSCR) ; des **jalons en mots** (articles avec code, première carte validée, code lié, Software Heritage demandé, issue de recherche ouverte) ; le **calendrier des contributions avec les publications du catalogue** ; l'activité ; un profil privé garde tout pour son propriétaire.
  - **Fil d'actualité et Explorer** : le fil (`/feed/`) montre 14 jours de ce que font les personnes, auteurs, organisations, dépôts et articles suivis, et les nouveaux articles des auteurs suivis ; « voir moins de ceci ». Explorer (`/explore/`, un fichier statique de la nuit) : dépôts et articles les plus étoilés de la semaine, personnes les plus suivies, sujets (une liste choisie avec leurs alias, dans `oscr/social.py`), collections (listes publiques proposées, **acceptées par toi** : `oscr social collections|accept|decline`).
  - **Une seule recherche** : le champ du bandeau a maintenant un type (Articles d'abord et par défaut, Dépôts, Issues, Personnes, Sujets, Commits, Code) ; un DOI tapé seul va à son article. Dépôts, issues de recherche, personnes et sujets : un index FTS5 `forge_fts` dans `oscr_search`, construit par le Mac à partir des **seuls fichiers publics** de la nuit (rien n'entre dans l'index que le site ne montre pas), avec `is:open`, `type:mismatch`, `user:`, `repo:`, `doi:`, `in:title`. Les issues et commits GitHub d'un dépôt : cherchés par le navigateur du lecteur sur son quota, montrés dans OSCR. Le code : la recherche de GitHub exige une connexion GitHub, la page y renvoie en le disant.
  - **Le Mac** : `oscr social layer|search|collections|accept|decline` ; `oscr nightly` écrit la couche sociale après celle de la forge (64 fichiers : compteurs, qui a mis une étoile — seulement les profils publics —, profils publics, et Explorer) et pousse l'index de recherche. **Aucune ligne de compteur n'est jamais écrite** : les compteurs viennent de la nuit.
  - **Essai de bout en bout** : tout passe (161 vérifications), dont une étoile, un auteur suivi par ORCID, un dépôt surveillé, **le commentaire de Bob sur GitHub arrivé par webhook dans la boîte de réception d'Ada** (elle y est mentionnée), marqué lu, l'étoile et l'abonnement de Bob refusés, puis la nuit du Mac et la recherche. Captures : `docs/night-screenshots/phase-08/` (42 images, bureau et téléphone).
  - **Tests à la clôture** : pytest 489 ; ruff propre ; `npm test` 1 225 sous Node 26 et Node 22 ; build 51 pages, 318 fichiers avec la fixture (7 pages et 64 fragments d'auteurs ajoutés ; la nuit en ajoute 65, aucun par personne ni par étoile) ; `check --every-route` ok ; `tsc --strict` propre.
- **Phase 10 (automatisation et intégrations) : terminée**, branche `night/phase-10-automation`, poussée (7 commits : les éléments E1 à E5, la clôture en deux parties). Rien fusionné, rien déployé. Construite avant la phase 16 (ton changement d'ordre) : **tout ce qu'elle écrit reste derrière `FORGE_OPEN`** (toi seul), et D10-14 dit ce que la phase 16 devra couvrir.
  - **Les jetons personnels d'OSCR** (`/settings/tokens/`) : `oscr_pat_…`, 256 bits, **montrés une seule fois** ; OSCR n'en garde que l'empreinte SHA-256. Chaque jeton a ses droits (dix, par domaine : dépôts, issues de recherche, social, notifications, webhooks, statuts), une durée de 1 à 366 jours (30 par défaut, aucun n'est éternel), se révoque à l'instant et s'affiche avec son dernier usage (au jour près). Ils ne servent qu'à l'API d'OSCR, jamais à git (git va chez GitHub avec les jetons de GitHub). Un jeton ne peut ni créer ni lister de jetons : seule la page des réglages le peut.
  - **L'API publique** (`/api/v1/…`) : lecture et écriture, **par jeton seulement** (un cookie de session n'y ouvre rien : il est retiré avant la route, donc pas besoin de jeton CSRF, et toutes les origines sont admises sans identifiants) ; versions datées (`X-Api-Version: 2026-09-29`), identifiant de requête, erreurs en mots avec leur page de documentation, ETag et 304, pagination par `Link`, limites par jeton (60 par minute, 1 000 par jour, comptées en mémoire : aucune ligne écrite par requête), `GET /api/v1/rate_limit`. **Ses routes sont celles du site** (le même code, les mêmes plafonds, les mêmes lignes, le même `FORGE_OPEN`) : dépôts et leurs articles, issues de recherche, étoiles, listes, abonnements, profil, notifications, fil, recherche, webhooks, statuts. La référence (`/developers/`) et la description OpenAPI (`/developers/openapi.json`) sont construites à partir des routes elles-mêmes : un test échoue si elles divergent.
  - **Webhooks sortants** (`/settings/hooks/`) : sur un article (issues de recherche, code lié, release liée) ou un dépôt connu (issues, pull requests, releases) ; **pingés avant d'être actifs** (le destinataire doit répondre 2xx) ; **signés comme ceux de GitHub** (`X-Hub-Signature-256`), avec un secret dérivé de la clé du serveur, **jamais stocké**, montré une fois ; envoyés depuis le Worker juste après l'écriture de l'événement (`waitUntil`), réessayés dans la même requête (après 1 s et 4 s), sans file ni tâche planifiée ; jamais vers un réseau privé, cette machine, un nom local ou OSCR lui-même, aucune redirection suivie ; mis en pause après dix échecs de suite ; livraisons des 7 derniers jours, renvoi à la main, nouveau secret. Ils ne portent que ce que les pages montrent : jamais un texte, jamais une adresse e-mail.
  - **Les vérifications d'OSCR, qui n'exécutent aucun code** : licence (reconnue à son texte), fichier d'environnement, DOI de l'article, `CITATION.cff`, cohérence des cartes de traçage, tailles de fichiers, README ; chaque constat dit pourquoi et comment corriger ; échec seulement quand le changement casse la traçabilité (un fichier pointé par une carte supprimé ou renommé, la licence supprimée, `CITATION.cff` rendu illisible). **Une vérification (check run) est postée sur chaque pull request** par l'App, à chaque poussée, depuis le webhook `pull_request`, avec son jeton d'installation (0 ligne D1) ; le trailer `skip-checks: true` est respecté.
  - **L'onglet Checks d'un dépôt** (`/r/<compte>/<nom>/checks/<ref>`) : les mêmes vérifications à n'importe quel commit, **y compris les commits cités par les articles**, calculées dans le navigateur ; les tests du chercheur tels que GitHub les rapporte (ses GitHub Actions) ; les statuts envoyés à OSCR ; les environnements testés lus dans les workflows, comme du texte. Les journaux de CI restent chez GitHub (il exige une connexion pour les télécharger) : seul lien vers GitHub, et la page dit pourquoi.
  - **Statuts de commit** : un CI de labo ou un service de reproduction poste un statut avec un jeton ; **un workflow GitHub Actions peut le faire avec le jeton OIDC de GitHub, vérifié par le Worker : aucun secret dans le dépôt du chercheur.**
  - **Essai de bout en bout** : tout passe (186 vérifications), dont un jeton créé puis l'API appelée avec, un statut posté, un webhook vers un récepteur local pingé puis recevant un événement (les deux signatures vérifiées), **la vérification d'OSCR postée sur la pull request de Bob depuis son webhook** (0 ligne écrite), le jeton de Bob refusé. Captures : `docs/night-screenshots/phase-10/` (30 images, bureau et téléphone).
  - **Tests à la clôture** : pytest 489 ; ruff propre ; `npm test` 1 296 sous Node 26 et Node 22 ; build 54 pages, 325 fichiers (3 pages et le fichier OpenAPI ajoutés, aucun par jeton ni par webhook) ; `check --every-route` ok ; `tsc --strict` propre.
- **Suite** : **la phase 16 (contenu, abus et règles) attend ton feu vert**, sur la branche `night/phase-16-rules`, créée à partir de `night/phase-10-automation`, sans rien dessus. Elle doit couvrir ce que les phases 08 et 10 ont ajouté (D08-17, D10-14) avant que `FORGE_OPEN` n'ouvre quoi que ce soit.

- **Phase 16 (contenu, abus et règles) : terminée**, branche `night/phase-16-rules`, poussée (9 commits : la fusion de `main`, les éléments E1 à E5, la clôture en trois parties). Rien fusionné dans `main`, rien déployé. C'est le « verrou » : sans lui, rien de ce qu'on écrit dans OSCR ne s'ouvre au public.
  - **D'abord, `main` fusionné dans la nuit** (la page de demande de retrait, le budget de fichiers statiques, le lecteur Code ↔ Article en premier, OpenAlex, les corrections du nightly). Les deux intentions sont gardées. Trois points à savoir : la migration communautaire de la nuit `0003_roles_by_paper.sql` devient **`0004`** (car `main` a déjà une `0003`) ; la page d'import lit maintenant les fragments de recherche DOI à 2 caractères de `main` ; et **le budget de fichiers change de réglage** : `STATIC_PAPERS` passe de 6 000 à **5 700** et `FIXED_FILES_MAX` de 3 000 à **3 600** (même total de 15 000 fichiers). Pourquoi : le côté GitHub ajoute environ 500 fichiers fixes (pages, scripts, fragments de nuit), qui auraient dépassé les 3 000 le jour où le catalogue remplit tous ses fragments. 300 articles, les plus anciens des 6 000, seront donc rendus par le Worker (1 requête par vue) au lieu d'être des fichiers. C'est ta décision si tu préfères autre chose (D16-3).
  - **Signalements** (`/report/`) : n'importe qui signale n'importe quoi du côté GitHub (une personne, un dépôt, une issue de recherche ou un commentaire, une issue, une pull request ou une release de GitHub, une liste, un statut), avec ou sans compte, toujours derrière **Turnstile** (la « case je suis humain » gratuite de Cloudflare), **vérifié côté serveur**. Sans compte, rien n'est gardé sur la personne qui signale. Un signalement pour droit d'auteur demande un compte (pour qu'on puisse lui répondre dans le site, sans email).
  - **Ta file de modération** (`/moderation/`, ton compte seulement) : ignorer un signalement, masquer (un dépôt, une issue ou un commentaire, une issue/pull request/release de GitHub, une liste, un statut, les mots d'un profil), **suspendre un compte** (ses écritures refusées, ses jetons révoqués, ses webhooks mis en pause, son activité masquée même en arrière), rétablir, répondre à un appel. Chaque décision a un avis public sans les mots masqués (`/notices/`).
  - **Masqué veut dire absent** : tout de suite de toutes les réponses du Worker (pages connectées, API, recherche, boîte de réception, fil, webhooks), et des fichiers statiques à la publication de la nuit suivante. Un dépôt masqué laisse une ligne sur la page de son article, pour que la carte de traçage reste expliquée.
  - **Appels et contre-avis** : la personne lit pourquoi sur `/account/moderation/` et peut faire appel une fois (ou un contre-avis pour un retrait pour droit d'auteur). La réponse arrive sur la même page, jamais par email.
  - **Blocages et limites d'interaction** (`/settings/blocked/`) : un blocage est silencieux ; la personne bloquée ne peut plus commenter, réagir, ouvrir des issues ou des pull requests dans tes dépôts, ni te suivre ; ses événements quittent ta boîte. Une limite d'interaction (comptes de plus de 24 h, contributeurs, ou seulement ceux qui gèrent le dépôt) dure de 24 h à 6 mois et finit toute seule.
  - **Règles et confidentialité** : sept pages statiques (`/terms/`, `/acceptable-use/`, `/guidelines/`, `/privacy/`, `/limits/`, `/copyright/`, `/data-rights/`), **toutes des brouillons à relire, marqués comme tels, et qui ne sont pas des conseils juridiques**. La déclaration de confidentialité liste vraiment tout ce qu'OSCR garde, y compris **la collecte privée des coordonnées des auteurs** (email, noms, ORCID, organisation, adresse, affiliation ; seulement dans le jeu de données Hugging Face privé ; jamais affichées ; pas d'email de masse). Les demandes sur les données (accès, portabilité, rectification, effacement, opposition) se font dans le site et sont répondues dans le site, en un mois.
  - **Malwares connus** : OSCR ne copie jamais un fichier dont l'empreinte SHA-256 (une « signature » unique du contenu) est sur une liste de malwares, et masque le dépôt qui en contient un. La liste est un fichier local que **tu** télécharges ; rien n'est exécuté, rien n'est téléchargé par le code.
  - **L'interrupteur `FORGE_OPEN`** : il n'ouvre les écritures à tout le monde **que si Turnstile est configuré**. Sans le secret de Turnstile, poser `FORGE_OPEN=true` n'ouvre rien. Je ne l'ai posé nulle part.
  - **Essai de bout en bout** : 216 vérifications, toutes réussies (dont les nouvelles : signalement puis masquage, blocage, Turnstile réussi avec la clé de test puis raté avec la clé « échoue toujours », limite d'interaction, écriture d'un non-propriétaire refusée sans `FORGE_OPEN` et acceptée avec). Captures : `docs/night-screenshots/phase-16/` (30 images, bureau et téléphone).
  - **Tests à la clôture** : pytest 535 ; ruff propre ; `npm test` 1 401 sous Node 26 et Node 22 ; build 65 pages, 400 fichiers ; `check --every-route` ok, budget tenu ; `check:growth` ok ; `tsc --strict` propre.

- **Phase 14 (la ligne de commande `oscr` pour les chercheurs) : terminée**, branche `night/phase-14-command-line`, poussée (8 commits : les éléments E1 à E6, la clôture en deux parties). Rien fusionné dans `main`, rien déployé, rien publié sur PyPI.
  - **Ce que c'est** : un programme qu'un chercheur tape dans son terminal (la fenêtre de commandes), sur le modèle de `gh`, l'outil en ligne de commande de GitHub. Il relie un dépôt de code à son article, vérifie le dépôt comme OSCR le vérifie, suit les lignes du code jusqu'aux paragraphes des Méthodes, produit une citation, et travaille avec le dépôt GitHub — **en montrant toujours la vue d'OSCR d'abord**, GitHub seulement quand OSCR ne peut pas montrer la chose, avec une phrase qui dit pourquoi.
  - **Deux commandes s'appellent `oscr`** (D14-1) : celle de ton Mac (le « moissonneur », qui récolte les articles ; les tâches launchd la lancent par `.venv/bin/python -m oscr`) **n'a pas changé**. Celle des chercheurs est un paquet à part, dans le dossier `cli/`, avec son propre nom de module Python (`oscr_cli`, jamais `oscr`), et **uniquement la bibliothèque standard de Python** (rien d'autre à installer). Elle s'installe dans un environnement à elle (`pipx` ou `uv tool`, des outils qui isolent un programme Python dans sa propre boîte), jamais dans le `.venv` du dépôt. Dans le dépôt, on la lance par `PYTHONPATH=cli/src .venv/bin/python -m oscr_cli`. Si on tape la commande de l'une dans l'autre, une ligne dit où elle se trouve. Un test de la suite du Mac vérifie que tes points d'entrée et tes tâches launchd n'ont pas bougé.
  - **Se connecter** (`oscr auth login`) donne deux « jetons » (un jeton = un mot de passe temporaire et limité, que le programme envoie à la place de ton vrai mot de passe) :
    - **GitHub**, par le « device flow » de GitHub (le flux « par appareil » : le terminal affiche un code court, tu l'entres sur la page de GitHub, GitHub donne le jeton au terminal). Il suffit de l'identifiant **public** de l'App GitHub d'OSCR ; **ce jeton ne passe jamais par OSCR**. Il dure 8 heures et se renouvelle tout seul.
    - **OSCR**, par un device flow **à nous**, nouveau côté Worker (D14-2) : le terminal affiche l'adresse d'une page du site, `/device/`, et un code de 8 lettres ; sur la page, connecté (ORCID, GitHub ou Google), tu **tapes le code que ton terminal montre** (la page ne le montre jamais : quelqu'un qui t'enverrait le lien ne peut pas te faire approuver d'un simple clic), tu lis ce que le jeton pourra faire et pour combien de jours, tu approuves ou tu refuses. **Demander un code n'écrit rien dans la base** : la demande est « scellée » (signée) avec la clé du serveur `SESSION_KEY`. Seule ta décision écrit une ligne ; le jeton est fabriqué quand le terminal vient le chercher, et OSCR n'en garde que l'empreinte (SHA-256). Un code vit 15 minutes, le terminal demande au plus toutes les 5 secondes. Approuver suit les mêmes règles que faire un jeton sur `/settings/tokens/` : `FORGE_OPEN` (donc toi seul pour l'instant), Turnstile quand il est en place, les plafonds. Une connexion coûte 6 lignes D1 en tout.
    - **Les deux jetons vont uniquement dans le trousseau du système** (le coffre à mots de passe : le trousseau macOS par la commande `security`, le secret passé par l'entrée standard et jamais dans la ligne de commande visible par `ps` ; sous Linux, `secret-tool`). Un simple fichier (droits 0600 : lisible par toi seul) seulement si on le demande, avec un avertissement.
    - `oscr auth status`, `token`, `switch` (plusieurs comptes sur un même ordinateur), `refresh`, `logout` (le jeton OSCR se révoque lui-même par la nouvelle route `POST /api/v1/token/revoke`). `oscr auth setup-git` fait du programme l'« assistant d'identifiants » de git **pour l'hôte de GitHub seulement**, jamais pour celui d'OSCR.
  - **Les commandes propres à OSCR** :
    - `oscr check` : les **mêmes** vérifications que la vérification d'OSCR sur les pull requests (licence, fichier d'environnement, DOI de l'article, `CITATION.cff`, cartes de traçage, gros fichiers, README), sur une copie locale. Les règles du Worker (TypeScript) sont traduites en Python ligne à ligne, et **un même fichier de cas** (`tests/fixtures/checks-cases.json`) oblige les deux à répondre pareil (D14-6). Les fichiers sont **lus comme du texte, jamais exécutés**.
    - `oscr cite` : APA et BibTeX depuis `CITATION.cff` ou `codemeta.json` (comme « Cite this repository » du site), la version et le DOI d'une release, et les identifiants Software Heritage (SWHID) du commit.
    - `oscr trace` : les cartes de traçage d'OSCR retrouvées à n'importe quel commit (mêmes lignes, déplacées, changées, disparues) ; et une carte **proposée** depuis des lignes choisies (`fichier:10-24=3` : lignes 10 à 24, paragraphe 3), gardée comme un fichier avec le code : **OSCR ne sait pas encore recevoir une carte proposée** depuis le terminal (reporté, D14-8).
    - `oscr paper link <DOI>` : ouvre la page du site déjà remplie (`/new/link/` ou les réglages « Papers » du dépôt) ; tu confirmes et GitHub autorise l'action, comme sur le site (D14-7). Aucune nouvelle route d'écriture.
  - **Le côté GitHub** (D14-10), avec **ton propre jeton GitHub**, directement chez GitHub : `repo create` (dépôts publics seulement) / `clone` / `view` / `list` / `sync` / `set-default`, `pr create` (les vérifications d'OSCR tournent d'abord sur le changement) / `list` / `view` / `checkout`, `issue create` (d'OSCR : les issues de recherche) / `list` / `view` / `close`, `release create` / `list` / `view`, `search` (la recherche d'OSCR ; GitHub avec `--github`), `api` (l'API d'OSCR ; GitHub avec `--github`), `browse` (les pages d'OSCR), `run` et `workflow` (résumés de ton intégration continue, la page Checks d'OSCR ; les journaux restent la page de GitHub, dit comme tel).
  - **Sorties** : tableaux alignés dans un terminal, lignes séparées par des tabulations dans un tube (pour `cut`, `awk`) ; `--json` avec des champs, `--jq` (un sous-ensemble du langage jq, écrit avec la bibliothèque standard) et `--template` (un sous-ensemble des gabarits Go) ; couleurs coupables (`NO_COLOR`), couleurs accessibles ; codes de sortie ; `--debug` sans jamais un jeton ; réglages, alias, complétion pour bash, zsh et fish ; un manuel (`oscr help <sujet>` et `docs/CLI.md`).
  - **Sécurité** : tout texte venu du réseau est **nettoyé avant d'être affiché** : les « séquences d'échappement » (des caractères invisibles qui peuvent commander le terminal : effacer l'écran, changer le titre, tromper l'affichage) deviennent visibles et inoffensives (`^[`), comme les caractères qui inversent l'ordre du texte ; les adresses e-mail deviennent `[email hidden]`. git tourne toujours sans « hooks » (des scripts qu'un dépôt peut déclencher) ni moniteur de fichiers. Rien de ce qui est cloné n'est exécuté.
  - **Pour les assistants** : `oscr mcp serve` (le Model Context Protocol : un format standard par lequel un assistant comme Claude appelle des outils) offre les commandes **de lecture** seulement.
  - **Paquet** : prêt pour PyPI (le dépôt public des paquets Python) mais **pas publié** : métadonnées, README pour les chercheurs, version, une « roue » (le fichier d'installation, `.whl`) construite hors ligne et installée dans un environnement jetable à côté de ton `oscr`.
  - **Essai de bout en bout** : 255 vérifications, toutes réussies, dont 39 nouvelles : le programme contre le faux GitHub et `wrangler dev`, les deux connexions approuvées par le banc d'essai (GitHub, puis `/device/` en tant qu'Ada en tapant le code), `check`, `cite`, `trace`, `repo create` puis la liaison à l'article par la page du site, `issue create`, un jeton sans le bon droit, une approbation refusée, un code expiré, MCP, la déconnexion ; les identifiants dans **un trousseau jetable** créé puis supprimé par l'essai (jamais le tien). Captures et transcriptions de terminal : `docs/night-screenshots/phase-14/`.
  - **Captures** (`docs/night-screenshots/phase-14/`) : la page `/device/` déconnectée, en attente (le code tapé), approuvée, puis la liste des jetons avec le jeton « Command line » ; bureau 1280×860 et téléphone 390×844 (8 images), et 10 transcriptions de terminal (`.txt`, sans aucun jeton).
  - **Tests à la clôture** : pytest 539 (dont 4 qui gardent tes points d'entrée intacts) ; ruff propre (dont `cli/`) ; la suite du programme `cli/` 126 ; `npm test` 1 423 sous Node 26 et Node 22 ; build 66 pages, 402 fichiers (1 page de plus) ; `check --every-route` ok, budget tenu ; `check:growth` ok ; `tsc --strict` propre ; essai de bout en bout 255 vérifications, toutes réussies.

- **Phase 11 (sécurité et qualité) : terminée**, branche `night/phase-11-security`, poussée (6 commits : un par élément, plus la clôture). Rien fusionné dans `main`, rien déployé, rien envoyé dehors. Détail : `docs/SECURITY_QUALITY.md`, décisions D11-1 à D11-9 et D11-n.
  - **La règle d'or** (D11-1, qui reprend D00-11) : **aucun code d'un utilisateur ne tourne jamais**. Ton Mac lit les fichiers comme du texte, il n'exécute jamais un fichier de dépendances, ne « résout » rien, n'installe rien, ne lance aucun analyseur. Le serveur (le Worker) non plus : il montre ce que l'intégration continue du chercheur (ses tests automatiques) a trouvé. L'analyse tourne sur ton Mac, qui pousse des « faits » vers la base `oscr_forge` ; le serveur ne fait aucune requête pour l'analyse.
  - **Le graphe des dépendances** (E1) : ton Mac lit les fichiers qui disent de quoi le code a besoin pour tourner (requirements, pyproject, Pipfile, conda pour Python ; DESCRIPTION et renv pour R ; Project et Manifest pour Julia ; package.json et ses fichiers de verrou pour JavaScript ; les actions GitHub) et en fait une liste : chaque dépendance avec son écosystème, sa version exacte quand un fichier de verrou la fige, la fourchette demandée, son rôle (exécution, développement…), si elle est directe ou amenée par une autre, et dans quels fichiers elle apparaît (le bouton « montrer les chemins »). Deux instantanés : la branche par défaut, et chaque commit qu'une carte de traçage d'un article épingle. Un nouvel onglet « Sécurité » le montre, avec recherche et filtres.
  - **Les alertes de vulnérabilité et de logiciel malveillant** (E2) : ton Mac interroge **OSV** (osv.dev), une base publique et gratuite, **sans clé**, en un seul envoi pour plusieurs paquets. Seuls des noms de paquets publics sortent, jamais ton code. La gravité vient du score CVSS ; un paquet malveillant (identifiant `MAL-`) est signalé ; une alerte retirée est classée sans suite automatiquement. **Pendant la nuit, le programme n'appelle jamais le vrai OSV** : il parle à un faux OSV local (comme le faux GitHub). Un responsable du dépôt peut écarter une alerte, la rouvrir, l'attribuer (bouton), et cette décision est gardée **à part** des faits, pour qu'un nouveau calcul ne l'efface pas. OSCR **montre** les pull requests de Dependabot (le robot de GitHub) mais **n'en ouvre jamais** (règle de l'AUP).
  - **La recherche de secrets après le push** (E3) : GitHub refuse un push qui contient un secret (une clé, un mot de passe) ; les push ne passent pas par OSCR, donc OSCR ne peut pas refuser. Après coup, il **signale sans jamais bloquer** : il relit les fichiers déjà enregistrés et dit « ligne 12 de config.py : un jeton GitHub », **sans jamais garder la valeur** (seulement un indice court, le reste caché). Formes connues de jetons, « paires » génériques (marquées « supposition »), motifs personnalisés avec un essai à blanc, exclusions, conseils pour corriger.
  - **L'analyse de code** (E4) : l'intégration continue du chercheur lance **son propre** analyseur et envoie le résultat au format SARIF par l'API à jeton (nouveau droit `security:write`) ; OSCR l'affiche et **ne lance aucun analyseur**.
  - **Le signalement privé de vulnérabilités** (E5) : un rapporteur prévient les responsables du dépôt **en privé** ; un fil de discussion privé, des collaborateurs, des crédits, un brouillon d'avis, la publication ou le retrait. **Privé par construction** : jamais dans une sortie publique, ni la couche statique, ni la recherche, ni un fil, ni un webhook ; seuls le rapporteur, un collaborateur nommé et un responsable peuvent le lire, jusqu'à la publication.
  - **L'export SBOM et la compatibilité des licences** (E6) : un SBOM (une « nomenclature logicielle » : la liste de ce qui compose le logiciel) au format **SPDX**, construit **dans ton navigateur** à partir du graphe (rien de ton code n'est envoyé) ; une table de compatibilité des licences libres courantes et une politique (listes « autorisé »/« interdit »), un conflit dit en mots, jamais un blocage. Les licences des dépendances ne sont **pas** récupérées ce soir (pas de réseau) : comptées « inconnues », jamais devinées.
  - **Essai de bout en bout** (étape 9, `e2e-security.ts` contre un faux OSV) : montre le graphe, lève une alerte OSV **et l'écarte**, montre une alerte de secret qui ne bloque pas, reçoit un fichier SARIF et le montre, dépose un rapport de vulnérabilité privé et le publie, et fournit les données du SBOM. Toutes les vérifications réussies.
  - **Captures** (`docs/night-screenshots/phase-11/`) : l'onglet Sécurité connecté (en haut, les dépendances, le signalement privé), bureau 1280×860 et téléphone 390×844, contre le faux GitHub et `wrangler dev`, toute adresse extérieure refusée.
  - **Tests à la clôture** : pytest 585 ; ruff propre ; `npm test` 1 465 sous Node 26 ; build 66 pages, `check --every-route` ok, budget tenu ; essai de bout en bout, toutes les vérifications réussies.

- **Suite** : **la phase 09 (organisations, équipes, droits et comptes) attend ton feu vert**, sur la branche `night/phase-09-organizations`, créée à partir de `night/phase-11-security`, sans rien dessus.

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

35. **À faire au moment de fusionner** : appliquer les deux nouvelles migrations (`npx wrangler d1 migrations apply oscr_forge --remote` et `… oscr_community --remote`, ou relancer `sh tools/setup_cloudflare.sh`) : `0003_pulls.sql` (les dix sortes d'actions) et `0004_roles_by_paper.sql` (un index pour trouver les auteurs vérifiés d'un article).
36. **Auteurs de l'article suggérés comme relecteurs** (D04-10) : leur identifiant GitHub est montré seulement aux personnes qui gèrent le dépôt (propriétaire, mainteneur, qui l'a lié) ou qui ont écrit un des articles ; jamais hors connexion ni dans un fichier statique. Si tu préfères que chaque auteur l'accepte d'abord, c'est à changer.
37. **Le garde des cartes de traçage vit dans OSCR** (D04-12) : la vérification que l'App posterait sur GitHub (« tracing-map links touched ») est reportée ; les liens touchés sont montrés dans les pages d'OSCR.
38. **Un commit sans droit d'écriture sur le dépôt est tenté, et GitHub décide** (D04-6) : c'est le cas d'un mainteneur qui applique une suggestion ou résout un conflit sur la branche d'un fork (« Allow edits by maintainers ») ; un refus de GitHub est dit, avec l'offre de proposer depuis un fork.
39. **Les méthodes de fusion permises** (D04-4) : l'API anonyme ne dit pas lesquelles le dépôt autorise ; les trois sont proposées et un refus de GitHub est dit en mots.
40. **Résoudre une conversation** (D04-9) : GitHub ne donne cet état qu'en GraphQL authentifié ; OSCR sait résoudre ou rouvrir, mais ne montre pas l'état aux lecteurs.
41. **À tester avec la vraie App** : qu'un jeton utilisateur de l'App puisse committer sur la branche d'un fork dont la pull request autorise les mainteneurs ; `resolveReviewThread` et `revertPullRequest` avec ce jeton ; `merge-upstream` ; le message de GitHub quand une méthode de fusion n'est pas permise (405) ; la file de GitHub des « suggested changes » quand la même ligne a plusieurs suggestions.

**Phase 05, à relire (décisions prises, D05-1 à D05-19) :**

42. **À faire au moment de fusionner** : appliquer les deux nouvelles migrations de `oscr_forge` (`npx wrangler d1 migrations apply oscr_forge --remote`, ou relancer `sh tools/setup_cloudflare.sh`) : `0004_issues.sql` (les onze sortes d'actions) et `0005_research.sql` (les tables des issues de recherche et leur index). Tant qu'elle n'est pas appliquée, le Mac publie simplement « aucune issue de recherche ».
43. **Les issues de recherche sont les objets d'OSCR** (D05-2) : une seule numérotation pour tout le registre (`research#12`), jamais une issue GitHub avec une étiquette ; une copie sur GitHub seulement à la demande de leur auteur, une fois (D05-14).
44. **Qui trie une issue de recherche** (D05-12) : les auteurs vérifiés de l'article, les mainteneurs du code, la personne qui gère le dépôt dans OSCR (qui l'a lié ou créé, ou son propriétaire), les modérateurs. Si tu veux réserver le tri aux auteurs de l'article, c'est à changer.
45. **La table `reproduction_reports` prévue au plan n'existait pas** (D05-11) : le rapport de reproduction est porté par l'issue « échec de reproduction » elle-même (une ligne) ; les reproductions réussies attendent l'espace par article de la phase 06.
46. **Une fusion faite directement sur GitHub ne ferme pas d'issue de recherche** (D05-13) : seule la fusion faite dans OSCR le fait ; la page propose « Fermer : corrigée dans le code ». Le chemin par webhook est reporté.
47. **Un texte qui contient une adresse e-mail ne se modifie pas dans OSCR** (D05-15) : il n'est jamais montré en clair, et une copie masquée réécrite perdrait l'adresse ; la page le dit et renvoie « à la source ».
48. **À tester avec la vraie App** : les types d'issues d'une organisation (`type` en REST) ; épingler et transférer (GraphQL) ; sous-issues et dépendances (`sub_issues`, `dependencies/blocked_by`) avec un jeton utilisateur de l'App ; la réponse de GitHub quand un type est demandé sur un dépôt personnel.

**Phase 07, à relire (décisions prises, D07-1 à D07-20) :**

49. **À faire au moment de fusionner** : appliquer les deux nouvelles migrations de `oscr_forge` (`npx wrangler d1 migrations apply oscr_forge --remote`, ou relancer `sh tools/setup_cloudflare.sh`) : `0006_releases.sql` (le lien release ↔ version de l'article, les tâches `release` et `deposit` du Mac) et `0007_packages.sql` (les paquets confirmés). Sans elles, `GET /api/forge/repo` répond 503 (ses nouvelles lectures).
50. **Zenodo** : le dépôt d'une carte avec sa release suit `OSCR_ZENODO_INSTANCE` de tes réglages du Mac (le bac à sable sinon) ; `oscr forge poll --instance` le fixe à la main. Vérifie qu'il vaut `sandbox` tant que tu n'as pas décidé de passer au vrai Zenodo. Le jeton reste celui du trousseau (`org.oscr.zenodo-sandbox`).
51. **Qui dépose** (D07-5) : seul un auteur vérifié de l'article avec son ORCID lié demande le DOI de la carte d'une release (vérifié par le Worker, puis par le Mac) ; un mainteneur du code ne suffit pas. Un DOI pour le code lui-même reste l'intégration Zenodo de GitHub, à la main de l'auteur, hors d'OSCR.
52. **Une citation garde son code** (D07-3) : publiée, une release ne change plus d'étiquette ni de commit dans OSCR ; liée à un article, elle ne redevient pas brouillon et ne se supprime pas avant d'être déliée. C'est plus strict que GitHub (qui le permet sans les releases immuables) : dis-le si tu préfères suivre GitHub.
53. **Brouillons** (D07-7) : lus en ton nom (une autorisation), gardés dans l'onglet seulement ; OSCR ne garde aucun brouillon. Un jeton gardé en session (ta décision n° 6) permettrait de les montrer sans cet aller-retour.
54. **Paquets** (D07-15) : le plan voulait que le Mac lise les manifestes à chaque commit synchronisé ; c'est le navigateur du lecteur qui les lit et les propose (gratuit), une personne qui peut pousser confirme. La lecture des métadonnées des registres (versions, dates) par le Mac est reportée.
55. **À tester avec la vraie App** : `POST uploads.github.com/…/assets` avec le jeton utilisateur de l'App et un corps en flux de longueur fixe (`FixedLengthStream` de workerd) ; le champ `digest` des fichiers ; `generate_release_notes` et `make_latest` ; le refus de GitHub sur une release immuable (le texte de l'erreur 422) ; la permission Contents (écriture) suffit aux releases et aux étiquettes.

**Phase 08, à relire (décisions prises, D08-1 à D08-18) :**

56. **À faire au moment de fusionner** : appliquer les migrations `0008_social.sql` d'`oscr_forge` et `0002_forge.sql` d'`oscr_search` (`npx wrangler d1 migrations apply oscr_forge --remote` et `… oscr_search --remote`, ou relancer `sh tools/setup_cloudflare.sh`, qui les applique toutes). La couche sociale de la nuit suit `OSCR_FORGE_PUSH=remote` ; l'index de recherche du côté GitHub suit en plus `OSCR_D1_PUSH=remote` (et `OSCR_D1_SEARCH_ID` dans les réglages pour passer par l'API REST, sinon la connexion de wrangler).
57. **Budget D1 (D08-18)** : mesuré, le social écrit environ 2 700 lignes par jour aux volumes du plan (le plan en comptait 1 200) : 2 par étoile ou abonnement, et les événements des actions et des webhooks. Avec les phases précédentes, le côté GitHub atteint son plafond de 5 000 lignes par jour, qui répond « quota » plutôt que de dépasser. **Ta décision C3** (20 000 lignes) le lève.
58. **Collections** (D08-14) : une liste publique proposée par son propriétaire ne va sur Explorer que si tu l'acceptes (`oscr social accept --remote --handle <login> --list <n>`) ; `oscr social collections --remote` liste celles qui attendent.
59. **Sujets choisis** (D08-14) : la liste des sujets mis en avant (EEG, MEG, IRMf, neuroimagerie, électrophysiologie, tri de potentiels, imagerie calcique, connectomique, neurosciences computationnelles, interfaces cerveau-machine, reproductibilité, cartes de traçage) et leurs alias sont dans `oscr/social.py` (`FEATURED_TOPICS`, `TOPIC_ALIASES`) : à revoir si tu veux d'autres sujets.
60. **Mentions** (D08-8) : une @mention n'arrive dans la boîte de quelqu'un que s'il surveille le dépôt ou l'article, ou suit le fil ; au-delà, il faudrait une ligne D1 par mention (reporté).
61. **Profils** (D08-12) : une personne est nommée par son login GitHub ou son ORCID, jamais par l'identifiant de son compte ; un profil privé cache son activité, ses étoiles, ses listes et ses abonnements. Le calendrier ne compte que ce qui est fait dans OSCR (issues, pull requests, relectures, releases, issues de recherche), pas les étoiles ni les abonnements.
62. **Ce que la phase 16 devra couvrir** (D08-17) : modération des profils, des listes et des titres d'événements ; comptes masqués rétroactivement (étoiles, abonnements, événements, fichiers de la nuit, recherche) ; blocage ; signalement d'un profil ou d'une liste ; plafonds revus avec Turnstile ; la purge des événements de plus de 3 mois ; la déclaration de confidentialité des données sociales.

**Phase 10, à relire (décisions prises, D10-1 à D10-17) :**

63. **À faire au moment de fusionner** : appliquer la migration `0009_automation.sql` d'`oscr_forge` (`npx wrangler d1 migrations apply oscr_forge --remote`, ou relancer `sh tools/setup_cloudflare.sh`) : les jetons, les webhooks et leurs livraisons, les statuts, et `actions` reconstruite avec les sortes `token`, `hook`, `status`.
64. **Le nom de la vérification sur GitHub** (D10-9) : « <SITE_NAME>: research checks » si le Worker reçoit la variable `SITE_NAME` au déploiement (par exemple `npx wrangler deploy --var SITE_NAME:OSCR`), sinon « Research code checks » : le nom de la plateforme n'est jamais écrit en dur. L'App a déjà les droits et l'événement qu'il faut (Checks en écriture, `pull_request`).
65. **Limites de l'API** (D10-4) : comptées dans la mémoire de chaque isolat du Worker (gratuit, aucune ligne D1) : c'est un plafond par isolat, pas un compte global exact. Cloudflare propose une liaison de limitation de débit (`ratelimit`) : **vérifie qu'elle est gratuite sur le plan Free** avant de la lier sous le nom `API_LIMITER` (le code la consulte si elle existe ; elle n'est pas dans `wrangler.toml`).
66. **Secrets des webhooks** (D10-6) : dérivés de `SESSION_KEY`. Si tu changes un jour `SESSION_KEY`, tous les secrets de webhook changent : leurs propriétaires devront en demander un nouveau (« New secret »).
67. **Jetons** (D10-1) : préfixe `oscr_pat_` (un identifiant technique, comme les cookies `__Host-oscr_*`) pour que les scanners de secrets (dont celui de GitHub) reconnaissent un jeton qui fuit. Tu peux demander à GitHub d'inscrire ce motif à son programme de partenaires du secret scanning une fois le site public (démarche à toi).
68. **GitHub Actions sans secret** (D10-12) : un workflow poste un statut avec le jeton OIDC de GitHub (audience : l'adresse du site) ; jusqu'à la phase 16, seulement pour les dépôts dont tu es le propriétaire. Exemple de workflow sur `/developers/#statuses`.
69. **Aucune file ni tâche planifiée** (D10-7) : une livraison de webhook échouée trois fois attend que son propriétaire la renvoie. Le Mac pourrait les renvoyer, mais il ne contacte jamais les services des gens (choix pris : non).
70. **Ce qui est reporté** (D10-13) : les applications tierces autorisées sur l'API d'OSCR (OAuth avec OSCR comme fournisseur), la Marketplace, Slack et Teams (un webhook vers un relais que la personne héberge le fait déjà), le device flow d'OSCR (phase 14), le renvoi automatique, les webhooks d'organisation (phase 09), les événements du Mac (carte proposée, validée, signalée, rétractation) pour les webhooks, relancer la CI depuis OSCR, les checks requis, le badge de statut.
71. **Ce que la phase 16 devra couvrir** (D10-14) : abus (adresses de webhooks — Turnstile à la création, plafond de pings —, contextes et descriptions des statuts, noms de jetons, requêtes à jeton invalide), rétention (livraisons au-delà de 7 jours, statuts, jetons expirés), compte masqué ou bloqué (jetons révoqués, webhooks en pause, statuts masqués), déclaration de confidentialité (jetons, adresses de webhooks telles que données, journal des livraisons, statuts publics), et `FORGE_OPEN`.
72. **Coût mesuré** (D10-15) : un jeton créé ou révoqué 3 lignes ; un webhook créé 4 ; une livraison 1 ; un statut 2 ; une lecture d'API 0 (le dernier usage d'un jeton : 1 par jour) ; une vérification de pull request 0. Bien sous les 800 lignes par jour prévues pour la phase.

**Phase 16, tes étapes, dans l'ordre (avant toute ouverture au public) :**

73. **Créer le widget Turnstile** (gratuit) : tableau de bord Cloudflare → Turnstile → « Add widget ». Nom : le nom du site. Domaine (hostname) : `oscr.yannbellec-b.workers.dev` (plus tard ton domaine). Mode : « Managed ». Tu obtiens deux valeurs : la **clé de site** (publique : elle va dans les pages) et la **clé secrète** (secrète : elle ne va que dans Cloudflare).
74. **Lancer `sh tools/setup_cloudflare.sh`** : la nouvelle **étape 9** demande la clé secrète sans l'afficher (elle devient le secret Cloudflare `TURNSTILE_SECRET_KEY`), puis la clé de site, qu'elle écrit dans tes réglages du Mac (`OSCR_TURNSTILE_SITE_KEY`, dans `~/.config/oscr/settings`) : le build de la nuit la met dans les formulaires. Un build à la main : `TURNSTILE_SITE_KEY=<la clé de site> npm run deploy` dans `website/`.
75. **Appliquer les migrations au moment de fusionner** : `npx wrangler d1 migrations apply oscr_forge --remote` (la nouvelle `0010_moderation.sql` : signalements, modération, blocages, limites, demandes sur les données) et `npx wrangler d1 migrations apply oscr_community --remote` (`0003_removal_requests.sql` de `main` si elle n'y est pas déjà, puis `0004_roles_by_paper.sql`, l'ancienne `0003` de la nuit renumérotée). Ou relancer le script d'installation.
76. **Relire les brouillons** des pages de règles (`/terms/`, `/acceptable-use/`, `/guidelines/`, `/privacy/`, `/limits/`, `/copyright/`, `/data-rights/`) : ce sont des brouillons, **pas des conseils juridiques**. Il reste des blancs entre crochets que toi seul peux remplir : ton nom et ton adresse postale (le responsable du traitement), la garantie de chaque service hors Union européenne (clauses contractuelles types, ou Data Privacy Framework s'il est certifié), la limite de responsabilité et le droit applicable, le délai du contre-avis (le brouillon dit 14 jours). Une fois une page relue, enlève son avis « brouillon » (`<PolicyDraft …/>`) et note la date dans `docs/POLICIES.md`. Idéalement, fais relire par quelqu'un qui connaît le droit (RGPD, droit d'auteur).
77. **La liste des malwares** : télécharge-la toi-même, par exemple la liste des empreintes SHA-256 de MalwareBazaar (abuse.ch ; vérifie sur bazaar.abuse.ch l'adresse exacte de l'export et sa licence, je n'ai rien pu contacter cette nuit) : `mkdir -p data/malware && curl -fsSL https://bazaar.abuse.ch/export/txt/sha256/full/ -o data/malware/sha256.zip && unzip -p data/malware/sha256.zip > data/malware/sha256.txt` (dans le checkout de production). Puis `oscr malware status` (combien d'empreintes) et `oscr malware scan --remote` (retire le texte des fichiers déjà copiés qui sont listés, masque les dépôts qui en contiennent). La nuit le refait ensuite tout seule avant l'export. À refaire de temps en temps pour mettre la liste à jour.
78. **Déployer, puis vérifier** avant d'ouvrir : un signalement sans compte sur `/report/` (la case Turnstile doit apparaître), sa présence dans `/moderation/`, un commentaire de recherche derrière la case, ta page `/account/moderation/`.
79. **Ouvrir le côté GitHub** : seulement après 73 à 78. `cd website && npx wrangler secret put FORGE_OPEN` puis taper `true` (un secret Cloudflare survit aux déploiements ; ne le mets jamais dans `wrangler.toml`). Vérifier qu'un autre compte (un deuxième compte GitHub de test) peut ouvrir une issue de recherche et que tes limites s'appliquent. Pour refermer : `npx wrangler secret delete FORGE_OPEN`.
80. **Ce que j'ai décidé pour toi (à relire)** : seuls **toi** modères (le rôle « moderator » viendra plus tard, D16-4) ; un dépôt masqué garde ses issues de recherche (elles sont la conversation de l'article, D16-5) ; un signalement pour droit d'auteur demande un compte (D16-14 et E5) ; les étoiles et abonnements ne demandent pas Turnstile (leurs plafonds suffisent, D16-14) ; la rétention (événements 3 mois, livraisons de webhooks 7 jours, jetons expirés 30 jours, signalements décidés 1 an, demandes répondues 3 ans, D16-16).
81. **Le budget de fichiers** (D16-3) : `STATIC_PAPERS` 5 700 au lieu de 6 000 (voir le résumé). Si tu préfères garder 6 000, il faudrait moins de fichiers de scripts ou de fragments du côté GitHub.

**Phase 14, tes étapes, dans l'ordre :**

82. **Un réglage oublié dans ton `~/.gitconfig` à retirer** (D14-16) : pendant l'écriture des tests, un essai de `oscr auth setup-git` a écrit, par erreur, deux lignes dans ton fichier de configuration git personnel : une section `[credential "http://127.0.0.1:56038/web"]` (un « assistant d'identifiants » pour une adresse de test sur ta machine, qui n'existe plus). C'est **sans effet** (git ne l'utilise que pour cette adresse locale morte), mais c'est à toi de l'enlever : je n'ai pas eu le droit de modifier ce fichier personnel. Une seule commande : `git config --global --remove-section 'credential.http://127.0.0.1:56038/web'`. La cause est corrigée (chaque appel à git passe par l'environnement du programme, et les tests donnent à tout un dossier personnel jetable).
83. **Activer le « Device Flow » de l'App GitHub** (s'il ne l'est pas) : sur GitHub → Settings (réglages) → Developer settings → GitHub Apps → l'App d'OSCR → « General » → cocher **« Enable Device Flow »** → « Save changes ». Sans cela, `oscr auth login` répond que l'App n'autorise pas encore le flux par appareil. Rien d'autre n'est nécessaire : le programme n'utilise que l'identifiant public de l'App (le « Client ID », déjà dans les secrets Cloudflare `GITHUB_APP_CLIENT_ID` ; le Worker le donne au programme par `GET /api/v1/cli`). **Aucun secret de l'App ne va dans le programme.**
84. **Vérifier le renouvellement du jeton GitHub** (D14-4) : l'option « Expire user authorization tokens » de l'App (même page) donne des jetons de 8 heures avec un jeton de renouvellement. Le programme renouvelle avec l'identifiant public seul, ce que GitHub permet pour le flux par appareil d'après sa documentation telle que je la connais ; je n'ai pas pu l'essayer contre le vrai GitHub. Si GitHub refuse, le programme refait simplement le flux par appareil. Test : `oscr auth login --github`, puis `oscr auth refresh --github`.
85. **Au moment de fusionner** : appliquer la migration `0011_device.sql` d'`oscr_forge` (`cd website && npx wrangler d1 migrations apply oscr_forge --remote`, ou relancer `sh tools/setup_cloudflare.sh`). Elle crée la table `device_grants` (une ligne par décision sur `/device/`). Puis déployer ; la nuit, le Mac efface ces lignes le lendemain de leur expiration (`oscr forge retention`, déjà dans le nightly).
86. **Essayer en vrai** après le déploiement : `pipx install ./cli` (depuis une copie du dépôt), `oscr auth login`, approuver sur `/device/` (tu es le propriétaire, donc autorisé même avec `FORGE_OPEN` non posé), `oscr auth status`, `oscr check` dans une copie d'un dépôt lié, puis `oscr auth logout`.
87. **Publier sur PyPI** (quand tu veux ; c'est un contact avec l'extérieur, donc le tien) :
    1. **Choisir le nom** du paquet : `oscr-cli` est provisoire (vérifie sur pypi.org qu'il est libre ; le nom de la commande tapée reste `oscr`). Le changer dans `cli/pyproject.toml` (`name = "…"`) si tu en veux un autre.
    2. **Créer un compte PyPI** (gratuit) sur pypi.org, activer la double authentification, puis créer un **jeton d'API** (Account settings → API tokens). Le garder dans ton trousseau (par exemple `security add-generic-password -s org.oscr.pypi -a "$USER" -w`), jamais dans le dépôt.
    3. **Construire** : `cd cli && uv build` (fabrique `dist/*.whl` et `dist/*.tar.gz` ; `dist/` est ignoré par git).
    4. **Essayer d'abord sur TestPyPI** (le bac à sable de PyPI) : `uv publish --publish-url https://test.pypi.org/legacy/ --token "$(security find-generic-password -s org.oscr.pypi-test -w)"` avec un jeton de TestPyPI, puis `pipx install --index-url https://test.pypi.org/simple/ oscr-cli`.
    5. **Publier** : `uv publish --token "$(security find-generic-password -s org.oscr.pypi -w)"`.
    6. Plus tard, une « Trusted Publisher » (publication de confiance) depuis GitHub Actions évite tout jeton : PyPI → ton projet → Publishing.
88. **Ce que j'ai décidé pour toi (à relire)** : les droits par défaut d'un jeton du terminal (`repos:read`, `research:read`, 90 jours ; les autres sur demande, D14-2) ; les cartes proposées restent des fichiers tant qu'OSCR ne sait pas les recevoir (D14-8) ; `GITHUB_TOKEN` n'est pas lu par le programme (sur ton Mac, c'est celui du moissonneur ; `GH_TOKEN` et `OSCR_GITHUB_TOKEN` le sont, D14-3) ; les alias ne lancent jamais un shell (D14-13).

**Phase 11, tes étapes, dans l'ordre :**

89. **Lancer l'analyse de sécurité, avec le réseau cette fois** (quand tu veux) : `oscr security scan --remote` (ou `--local` pour le `wrangler dev`). C'est ce qui appelle le **vrai** OSV (osv.dev, gratuit, sans clé) : pendant la nuit, le programme n'a parlé qu'à un faux OSV. Rien de ton code ne sort ; seuls des noms de paquets publics. `oscr security status` dit ce que la base contient ; `oscr security sbom --repo owner/name` écrit un fichier SPDX.
90. **La migration 0012** (`migrations/d1-forge/0012_security.sql`) crée six tables dans `oscr_forge` et reconstruit les genres de la table `actions`. Elle s'applique au prochain `oscr forge` ou au déploiement, en même temps que la 0011 (phase 14), **quand tu ouvriras le côté GitHub**. Rien de tout cela n'est en ligne tant que tu ne fusionnes pas et ne déploies pas.
91. **Réglages facultatifs** : `OSV_API_URL` ne sert qu'aux essais (pour viser un faux OSV) ; en vrai, ne pose rien. `OSCR_SECRETS_CONFIG` peut nommer un fichier JSON avec tes exclusions de chemins et tes motifs de secrets personnalisés (`{"exclude": […], "custom": [{"name", "regex"}]}`). Une politique de licences (listes « autorisé »/« interdit ») n'est pas encore un réglage : à ajouter si tu veux l'utiliser.
92. **Ce que j'ai décidé pour toi (à relire)** : OSV interrogé sans clé, un faux pendant la nuit (D11-4) ; la décision humaine sur une alerte gardée à part des faits (D11-5) ; la recherche de secrets signale et ne bloque jamais, sans garder la valeur (D11-6) ; les avis de vulnérabilité privés, jamais publics avant publication (D11-8) ; les licences des dépendances non récupérées ce soir (inconnues, jamais devinées, D11-9) ; les **avis de recherche** (une erreur de code qui change un résultat publié, reliée aux articles) sont **reportés** (D11-n), de même que le « start setup » d'un `SECURITY.md`.

## 3. Décisions prises

Voir [`docs/DECISIONS.md`](DECISIONS.md) (entrées D00-1 à D00-16, puis D01-1 à D01-29 pour la phase 01 : les dix du plan, et dix-neuf prises en construisant ; D02-1 à D02-19 pour la phase 02, décrites dans [`docs/CODE_NAVIGATION.md`](CODE_NAVIGATION.md) ; D03-1 à D03-19 pour la phase 03, décrites dans [`docs/WEB_EDITING.md`](WEB_EDITING.md) ; D04-1 à D04-19 pour la phase 04, décrites dans [`docs/PULL_REQUESTS.md`](PULL_REQUESTS.md) ; D05-1 à D05-19 pour la phase 05, décrites dans [`docs/ISSUES.md`](ISSUES.md) ; D07-1 à D07-20 pour la phase 07, décrites dans [`docs/RELEASES.md`](RELEASES.md) ; D08-1 à D08-18 pour la phase 08, décrites dans [`docs/SOCIAL.md`](SOCIAL.md) ; D10-1 à D10-17 pour la phase 10, décrites dans [`docs/API.md`](API.md) et [`docs/AUTOMATION.md`](AUTOMATION.md)).

Phase 16 : entrées **D16-1 à D16-21** (la fusion de `main`, le budget de fichiers, les signalements, le masquage, la suspension, les appels, les blocages, les limites, Turnstile, l'interrupteur, la rétention, les pages de règles, les demandes sur les données, les malwares, ce qui est reporté, l'essai de bout en bout et la revue de sécurité). Le contrat : [`docs/MODERATION.md`](MODERATION.md) ; les pages : [`docs/POLICIES.md`](POLICIES.md).

Phase 14 : entrées **D14-1 à D14-16** (les deux commandes `oscr`, les deux connexions, le trousseau, les sorties, les commandes propres à OSCR et celles de GitHub, MCP, le paquet, ce qui est reporté). Le manuel : [`docs/CLI.md`](CLI.md).

Phase 11 : entrées **D11-1 à D11-9** et **D11-n** (l'analyse sur le Mac et rien d'exécuté, le graphe des dépendances, OSV sans clé et un faux la nuit, la décision humaine à part, la recherche de secrets qui signale sans bloquer, SARIF sans analyseur, les avis privés par construction, le SBOM et les licences, ce que la phase 16 doit couvrir et ce qui est reporté). Le détail : [`docs/SECURITY_QUALITY.md`](SECURITY_QUALITY.md).

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

**Phase 05 :**

40. **Reporté** : les pièces jointes (les vérifications de la phase 16 d'abord : le Mac les inspecte, Hugging Face les stocke) ; les issues semblables calculées la nuit par le modèle local (seules les semblables par mots existent) ; les vues enregistrées, le tableau de bord des issues et les abonnements (boîte de réception de la phase 08) ; les champs d'issue et les types propres à un labo (phase 09) ; les projets (phase 06) ; masquer un commentaire GitHub et le commentaire épinglé (GraphQL, pas encore de méthode `GitBackend`) ; l'historique des modifications avec le texte de chaque révision ; les réactions sur les issues de recherche ; supprimer une issue ; archiver une étiquette (pas d'API) ; marquer « contesté » le lien de carte d'un écart ouvert (prochaine étape du Mac) ; le parent d'une sous-issue dans sa barre latérale (REST ne le dit pas) ; « Suivie par » pour les tâches.
41. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490 et 9491 (wrangler dev, faux GitHub, simulateurs de connexion) et Chrome headless sur 9390 ; tout est arrêté. Le port 8790 (ton tableau de bord) n'a pas été touché.
42. **Un incident, sans suite** : pendant la première série de captures, la page du lecteur Code ↔ Article a fait une requête GET vers Europe PMC (l'identifiant fictif `PMC0000001` de la fixture ; réponse 500). Le navigateur de test bloque depuis toute adresse extérieure (Europe PMC, Hugging Face, doi.org, GitHub), et la série a été refaite ainsi.

**Phase 07 :**

43. **Reporté** : la vérification des attestations de GitHub (`gh release verify`, Sigstore) — la page de GitHub en attendant ; « vérifier un fichier » compare déjà un fichier local au SHA-256 de GitHub ; la lecture des manifestes par le Mac à chaque commit et les métadonnées des registres ; les déploiements tels que GitHub les enregistre (pas de méthode `GitBackend`) ; la discussion et les réactions d'une release (phases 06, 08) ; suivre les releases (boîte de réception de la phase 08) ; `oscr release upload` et `verify-asset` (phase 14) ; la release qui a livré un correctif dans la section « Development » d'une issue ; les flux Atom (ceux de GitHub, liés avec la raison).
44. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490 et 9491 (wrangler dev, faux GitHub, simulateurs) et Chrome headless sur 9390 ; tout est arrêté. Au début de la phase, des `wrangler dev` orphelins des phases précédentes tournaient encore dans le worktree de nuit (lancés la veille à 21 h 56, 22 h 05 et 22 h 08, et relancés à chaque modification de fichier) : je les ai arrêtés. Le port 8790 (ton tableau de bord) n'a pas été touché.
45. **Captures** : la couche statique des captures a été produite depuis l'état de l'essai de bout en bout (`oscr forge layer --local` vers une copie de la fixture dans le brouillon), pour montrer les cartes versionnées et les paquets ; rien de cela n'est commité.
46. **Réglage lu, pas affiché** : pour que l'essai ne puisse jamais joindre le vrai Zenodo quels que soient tes réglages, le poll du Mac reçoit `--instance sandbox` et l'adresse du faux Zenodo ; je n'ai lu que le nom des clés de `~/.config/oscr/settings`, pas leurs valeurs.

**Phase 08 :**

47. **Reporté** : les @mentions hors de ce qu'on surveille ; le fil des revues, outils, jeux de données et catégories suivis (les abonnements sont gardés et listés) ; les tableaux de bord d'organisation et de dépôt, les recommandations « Pour toi », les « good first issues », les tendances par langage ou par contributions, les sujets GitHub des dépôts, le financement (`FUNDING.yml`, subventions et financeurs du catalogue) ; une page listant qui a mis une étoile (les fichiers de la nuit en gardent 100, les pages montrent les compteurs) ; l'index du code d'OSCR (`oscr_code`, une cinquième base D1 : ta décision), les recherches enregistrées et récentes, le formulaire avancé des nouveaux types ; la purge des événements de plus de 3 mois ; la fin d'un statut et l'ordre des épinglés dans le formulaire (l'API les prend) ; une reproduction confirmée par quelqu'un d'autre comme jalon (aucune reproduction n'est encore enregistrée).
48. **Coût mesuré, au-dessus du plan** (D08-18) : les issues de recherche écrivent maintenant 5 lignes à l'ouverture (3 avant), 4 ou 5 par commentaire (3), 3 à la fermeture (2) ; chaque action autorisée sur un dépôt connu, 1 ligne par événement (et 1 pour un fil suivi). Les tests et l'essai de bout en bout des phases précédentes ont été mis à jour en le disant, jamais affaiblis.
49. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490 et 9491 (wrangler dev, faux GitHub, simulateurs) et Chrome headless sur 9390 ; tout est arrêté. Aucun `wrangler dev` orphelin au début de la phase. Le port 8790 (ton tableau de bord) n'a pas été touché.
50. **Captures** : quelques événements (une pull request et une release de Bob, un commentaire de recherche) ont été ajoutés directement dans la base D1 locale de l'essai pour remplir la boîte de réception, puis la couche sociale et l'index ont été produits depuis cet état vers une copie de la fixture dans le brouillon ; rien de cela n'est commité. Le README de profil n'apparaît pas dans les captures (le faux GitHub n'a pas de dépôt `ada-fixture/ada-fixture`).
51. **Un point hérité** : une installation de l'App créée après la liaison d'un dépôt ne marque pas ce dépôt « installé » (seul `installation_repositories` le fait) ; les événements n'en souffrent pas (un seul événement par acte), mais l'état affiché du miroir peut rester « sans App » jusqu'au passage du Mac.

**Phase 10 :**

52. **Reporté** : voir le point 70 (D10-13). L'inventaire comptait 430 fonctionnalités pour cette phase ; celles qui portent sur les objets de GitHub (son API REST, ses webhooks, ses Actions) restent à GitHub par la décision de stockage ; les endpoints des phases à venir (09, 06, 12, 13) viendront avec elles, sur ce cadre.
53. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490, 9491 et 9492 (wrangler dev, faux GitHub, simulateurs, récepteur de webhooks) et Chrome headless sur 9390, toute adresse extérieure bloquée ; tout est arrêté. Le port 8790 (ton tableau de bord) n'a pas été touché. L'App de l'essai a une clé RSA jetable, créée par le script dans son dossier temporaire et effacée avec lui.
54. **Captures** : le jeton affiché une fois est masqué avant la capture (jamais un jeton dans une image) ; les jetons de test créés pendant les captures ne vivent que dans la base locale de l'essai, effacée ensuite.
55. **Non vérifiable sans la vraie App** : la création d'un check run avec un jeton d'installation limité à un dépôt et à `checks: write` ; la lecture de l'arbre d'une pull request venant d'un fork avec ce jeton ; les réclamations exactes du jeton OIDC de GitHub Actions (`repository_visibility` notamment) ; la liaison `ratelimit` de Cloudflare.

**Phase 16 :**

56. **Reporté** (D16-20) : les modérateurs par rôle ; Turnstile sur les rafales d'étoiles et d'abonnements ; fermer les contributions ouvertes d'une personne bloquée ; masquer un par un les commentaires des issues de GitHub (le fil entier peut être masqué) ; la rétention des statuts de commits disparus (il faudrait demander à GitHub) ; la publication des règles sous CC0 ; l'export et la suppression de compte en libre-service (phase 09) ; les signalements de snippets (phase 13). L'inventaire comptait environ 240 fonctionnalités pour cette phase : le cœur est fait, le reste est listé là.
57. **Serveurs de test** : l'essai de bout en bout et les captures ont tourné sur 8791, 9490, 9491 et 9492 (wrangler dev, faux GitHub, simulateurs, récepteur) et Chrome headless sur 9390, avec toutes les adresses extérieures refusées (Turnstile ne se charge donc pas sur les captures : le formulaire le dit en mots). Tout est arrêté. Le port 8790 (ton tableau de bord) n'a pas été touché.
58. **Turnstile en vrai** : je n'ai jamais contacté Cloudflare. Les tests utilisent les clés de test documentées par Cloudflare, contre un faux `siteverify` sur la machine. Le vrai widget sera vérifié à l'étape 78.
59. **Un bug trouvé pendant l'essai** : l'appel à `siteverify` utilisait `redirect: "error"`, que les Workers refusent ; corrigé en `redirect: "manual"`. Sans l'essai de bout en bout, la vérification aurait toujours échoué en production.

**Phase 14 :**

60. **Reporté** (D14-13) : les langages jq et gabarits Go complets (variables, `reduce`…), le Markdown mis en forme dans le terminal, un paginateur, les extensions ; recevoir une carte proposée dans OSCR ; `repo fork/archive/rename/delete`, `pr review/merge`, l'édition et les commentaires d'issues, `release upload/download/verify`, `discussion`, `project`, `snippet`, les imports avec `--mirror` et LFS, le blame local ; OAuth avec OSCR comme fournisseur pour d'autres applications. Environ 60 des 198 fonctions de la phase sont faites ; les autres sont listées là.
61. **Linux** : le trousseau Linux (`secret-tool`) est testé par un remplaçant, pas par un vrai « Secret Service » (je n'ai qu'un Mac).
62. **Un premier essai de bout en bout s'est arrêté sans message** à l'étape 8 (code de sortie 1, aucune ligne) ; relancé à l'identique avec la trace du shell, il est passé entièrement (255 vérifications), et de nouveau pour les captures. Je n'ai pas pu reproduire l'arrêt : à surveiller si l'essai est relancé.
63. **Serveurs de test** : les mêmes ports que les phases précédentes (8791, 9490 à 9492, Chrome headless sur 9390, toute adresse extérieure refusée), tous arrêtés à la fin.

**Phase 11 :**

64. **Reporté** (D11-n) : les **avis de recherche** (une erreur de code qui change un résultat publié, reliée aux articles et aux releases qui citent les versions touchées) ; le « start setup » d'un `SECURITY.md` (un commit modèle) ; les licences des dépendances récupérées chez les registres de paquets ; la classification fine d'OSV au-delà des deux règles de base ; les motifs de secrets personnalisés côté serveur (ce soir, ta configuration locale). L'inventaire comptait 212 fonctions ; les six éléments livrés en couvrent le cœur.
65. **Le faux OSV** : pendant la nuit, le client OSV n'a parlé qu'à un faux serveur local (`tests/forge/fake-osv-server.ts`), jamais au vrai osv.dev. Le vrai appel, c'est ton étape 89.
66. **Les licences des dépendances** ne sont pas récupérées : sans réseau dans la poussée des faits, elles sont comptées « inconnues ». La compatibilité porte donc surtout sur la licence du dépôt et la politique ; la table de compatibilité, elle, est complète et testée.
67. **Serveurs de test** : les mêmes ports (8791, 9490 à 9492) plus le faux OSV sur 9493, et Chrome headless sur 9390 ; toute adresse extérieure refusée ; tous arrêtés à la fin. Le port 8790 n'a pas été touché.

## 5. Branches, dans l'ordre de fusion

1. `night/phase-00-research` : terminée et poussée.
2. `night/phase-01-git-hosting` : terminée et poussée (construite sur la précédente).
3. `night/phase-02-code-navigation` : terminée et poussée (construite sur la précédente).
4. `night/phase-03-web-editing` : terminée et poussée (construite sur la précédente).
5. `night/phase-04-pull-requests` : terminée et poussée (construite sur la précédente).
6. `night/phase-05-issues` : terminée et poussée (construite sur la précédente).
7. `night/phase-07-releases` : terminée et poussée (construite sur la précédente).
8. `night/phase-08-social` : terminée et poussée (construite sur `night/phase-07-releases`).
9. `night/phase-10-automation` : terminée et poussée (construite sur `night/phase-08-social`).
10. `night/phase-16-rules` : terminée et poussée (construite sur `night/phase-10-automation`, avec `main` fusionné dedans).
11. `night/phase-14-command-line` : terminée et poussée (construite sur `night/phase-16-rules`).
12. `night/phase-11-security` : terminée et poussée (construite sur `night/phase-14-command-line`).
13. `night/phase-09-organizations` : créée à partir de `night/phase-11-security`, poussée, vide : **la phase 09 (organisations, équipes, droits et comptes) attend ton feu vert**.
14. `night/phase-16-content-rules` : créée plus tôt à partir de `night/phase-07-releases`, vide, remplacée par `night/phase-16-rules` (je ne l'ai pas supprimée).

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
- Phase 05, dans le même esprit :
  - la liste : `ul.issue-list` et `li.issue-row` (l'état et le type dits en mots, `.issue-state`, `.issue-type`, `.issue-flag` ; une issue épinglée marquée d'un filet à gauche, jamais une pastille), `.issue-bulk` ;
  - les étiquettes : `.label` et `.label-mark[data-color]` (un petit carré de couleur devant le mot, seize couleurs nommées, jamais un attribut `style`), `ul.label-list`, `ul.milestone-list`, `ul.template-list`, `section.template-problems` ;
  - le formulaire : `section.issue-form` et ses champs (`.form-field`, `.form-markdown`, `details.issue-meta`, `fieldset.issue-labels`), `.similar`, `p.rule-suggestion` ;
  - la page d'une issue : `p.comment-actions`, `p.reactions` et `.reaction`, `.edit-box`, `section.task-panel` et `ul.task-list`, `.completions`, `ul.sub-issues`, `#issue-actions` ;
  - l'onglet courant d'un dépôt en gras (`nav.tabs a[aria-current="page"]`) ;
  - leurs réglages pour le téléphone.
- Phase 07, dans le même esprit :
  - la liste : `ul.release-list` et `li.release-row` ; les états en mots, `.states` et `.state.ok` / `.state.warning` (« Latest », « Pre-release », « Draft », « Immutable », jamais une pastille) ;
  - la page d'une release : `.release-head`, `section.release-notes`, `table.assets` (les fichiers et leur SHA-256), `code.digest`, `.tie` (le lien à la version de l'article, filet à gauche), `form.release-research`, `ul.release-toc` (la table des matières dans la barre latérale), `section.asset-form` ;
  - le formulaire : `section.release-form` et son `fieldset.release-research` ;
  - les étiquettes : `table.tags` ; la page de l'article : `ul.release-ties` ;
  - l'environnement : `section.env-panel`, `ul.env-files`, `ul.env-checks` (chaque constat dans son ton), `ul.env-elsewhere`, `ul.env-packages`, `code.install` ;
  - leurs réglages pour le téléphone.
- Phase 08, dans le même esprit :
  - Étoile, Surveiller, Suivre : `.social-actions` (de simples boutons avec leurs compteurs en mots, jamais un badge), `details.lists-menu`, `fieldset.custom-watch` ; `p.explain` pour les phrases d'explication ;
  - la boîte de réception : `ul.notices` et `li.notice` (un fil non lu en gras avec un filet à gauche), `h2.notice-group`, `form.notice-filter`, `p.notice-bulk`, `ul.watching`, `section.notice-settings` ;
  - les étoiles et les listes : `ul.stars`, `section.star-list`, `form.list-form`, `p.star-filters` ;
  - le profil : `.profile-head`, `table.identicon` (des cases, une teinte parmi huit par classe : ni image ni attribut `style`), `form.profile-form`, `table.calendar` (le niveau de chaque jour par classe, un point pour une publication) dans `.calendar-scroll`, `ul.milestones`, `ul.timeline`, `ul.pinned` ;
  - le fil et Explorer : `ul.feed`, `ul.topics` ; la recherche : `ol.results`, `form.search-form` ;
  - le bandeau : son formulaire de recherche passe à la ligne sur téléphone (le type et le champ) ;
  - leurs réglages pour le téléphone.
- Phase 10, dans le même esprit :
  - les réglages : `div.choices` (un groupe de choix tracé par un script, son titre en paragraphe `p.legend`, comme `fieldset.choices`) ; `table.tokens` et `table.deliveries` (sur le modèle de `table.branches`) ; `ul.hooks` et `p.hook-actions` ; le jeton ou le secret montré une fois dans `.confirm` avec `pre.commands` ;
  - l'onglet Checks : `section.checks-report`, `section.checks-ci`, `section.checks-posted`, `section.checks-env`, `ul.findings` (chaque constat dans son ton, `.ok` ou `.warning`, et `.fix` pour la façon de corriger) ;
  - la référence de l'API : `section.api-route` ; `table.scopes` et `table.errors` ;
  - leurs réglages pour le téléphone (les tableaux défilent dans la colonne).
- Phase 16, dans le même esprit :
  - `.human-check` (la place de la case Turnstile, pour que le formulaire ne saute pas quand elle apparaît) ;
  - `p.moderated` (une ligne « masqué par la modération », avec un filet à gauche, jamais un badge) ;
  - `table.queue` (la file de modération, les blocages, les avis ; les mots des gens avec leurs retours à la ligne ; la date sur une seule ligne), `form.lookup` ;
  - `.draft-notice` (l'avis « brouillon » en tête des pages de règles) et `.policy` (leurs sections, listes de définitions et tableaux) ;
  - les liens du pied de page ne se coupent plus au milieu sur téléphone ;
  - leurs réglages pour le téléphone (les tableaux défilent dans la colonne).
- Phase 14, dans le même esprit :
  - `input.device-code` (le champ où l'on tape le code du terminal sur `/device/` : la police du code, les lettres espacées, en majuscules, assez large sur téléphone) ;
  - `.panel dl.settings dd ul` (la liste des droits demandés dans le panneau de la demande).

## 7. Phase 09 (organisations, équipes, droits et comptes)

Ce que la nuit a construit, en mots simples. Une organisation, ici, c'est un labo, un groupe ou un
projet sur le registre : ses membres, leurs rôles, leurs droits de recherche, des équipes, une
présentation publique et une autre réservée aux membres, des dépôts épinglés, et un journal des
actions. L'organisation GitHub d'un labo est **reliée, pas remplacée** : les droits d'écriture sur
ses dépôts restent à GitHub, et le registre ne demande jamais d'écrire chez GitHub.

Tout est nouveau dans la base `oscr_forge` (migration `migrations/d1-forge/0013_organizations.sql`,
9 tables). Détails : `docs/ORGANIZATIONS.md`, décisions D09-1 à D09-8.

### Ce qui marche

- **Créer une organisation**, sa présentation (publique et réservée aux membres), ses réglages, la
  renommer, l'archiver, la supprimer (en douceur, le nom reste pris). La présentation réservée aux
  membres et une liste de membres privée sont **refusées à qui n'est pas membre**.
- **Les membres** : inviter (l'invitation a une date de fin), accepter ou refuser, retirer (une liste
  de ce que le départ change est renvoyée), réintégrer, changer le rôle (propriétaire, modérateur,
  membre) et les **droits de recherche** (proposer, signaler ou valider une carte de traçage ; relier
  une version logicielle à une version d'article). Le dernier propriétaire est protégé. Les **équipes**
  (créer, ajouter un membre, retirer, supprimer), avec visibilité et imbrication. La liste des membres
  s'exporte en CSV.
- **Le journal des actions** par organisation (filtres, recherche de texte, export CSV ou JSON), et un
  aperçu de sécurité (les alertes de la phase 11 sur les dépôts épinglés).
- **La sécurité du compte** : voir ses sessions et en fermer une ou toutes les autres (la session est
  vraiment effacée) ; voir ses identités de connexion et en délier une (jamais la dernière) ; des
  **passkeys** (WebAuthn) pour le mode sudo (une étape de plus, pas la première connexion). Le Worker
  vérifie lui-même la clé, avec WebCrypto seulement : aucune bibliothèque en plus, rien de payant, et
  seule la clé **publique** est gardée. Un journal de sécurité personnel, exportable en CSV.

### Ce que Yann doit faire (ou savoir)

- **Rien de payant, rien de nouveau à configurer pour les passkeys.** La vérification se fait dans le
  Worker (WebCrypto). Le `rpId` (le domaine de la clé) est le domaine du site : `openscicode.org` en
  production, `localhost` en local. Aucun service externe n'est appelé.
- **Appliquer la migration 0013** (comme les autres) avant toute ouverture : `oscr` / wrangler
  `d1 migrations apply` sur `oscr_forge`. La nuit ne déploie rien.
- **Les écritures d'organisation, d'équipe et de rôle s'ouvrent au public avec le reste**, à la phase
  16, quand `FORGE_OPEN` est mis et que le secret Turnstile est présent (D16-13). D'ici là, seul le
  propriétaire du registre peut créer et gérer une organisation. Les gestes d'un membre sur son
  **propre** compte (accepter une invitation, se rendre privé, partir, fermer une session, délier une
  identité, ajouter ou utiliser une passkey) ne passent pas par `FORGE_OPEN` : on peut toujours
  sécuriser son compte.
- **Vérifier le domaine d'une organisation** : le propriétaire publie un enregistrement DNS TXT (la
  valeur `domain_proof` affichée). La vérification réelle du DNS tournera **sur le Mac** (il a le
  réseau), jamais depuis le Worker (coût zéro). Ce branchement est **différé** (D09-8) : pour l'instant
  le domaine reste « en attente ».
- **Aucune adresse e-mail** n'est demandée, montrée ni gardée ; aucune écriture GitHub ; aucun code
  d'utilisateur n'est exécuté.

### Ce qui est reporté (noté, pas fait cette nuit, D09-8)

La page publique statique d'une organisation (`/org/<handle>/`) et ses fragments ; les règles montrées
telles que GitHub les applique (rulesets, protection de branche) ; les identifiants sous politiques
d'organisation (durée de vie, approbation) ; l'imbrication fine des équipes et l'auto-affectation des
relectures ; le **cycle de vie du compte** (changer de nom d'utilisateur avec redirection, un
successeur, la remise d'un labo, fusionner deux comptes, le compte d'une personne décédée ; l'export
et la suppression du compte existent déjà via les droits de la phase 16) ; le branchement des droits
de recherche à chaque route de recherche du dépôt concerné.

### Vérifications à la clôture

pytest 585 ; ruff propre ; `npm test` 1 494 ; la construction et `check --every-route` passent, dans
le budget de fichiers ; le bout-en-bout complet passe (code 0), y compris l'étape 10 de la phase 09
(`e2e-organizations.ts` : créer une organisation, inviter puis retirer un membre, poser un droit de
recherche, une présentation réservée aux membres refusée puis montrée, enregistrer et utiliser une
passkey avec une vraie clé ES256, fermer une session, exporter le journal). Captures d'écran dans
`docs/night-screenshots/phase-09/` (bureau 1280x860 et téléphone 390x844).

### `science.css`

Aucun ajout : les deux pages (`/organizations/` et `/account/security/`) réutilisent les classes
existantes (`.listing`, `.summary`, `.warning`, `.ok`, `.plain`, `.muted`, `.field`).

## 8. Phase 06 (discussions, wiki et projets)

Ce que la nuit a construit, en mots simples. Trois façons d'échanger et de s'organiser autour d'un
article et de son code, toutes **propres à OSCR** (le registre les garde chez lui, pas chez GitHub ;
c'est la règle D00-6). Tout est écrit derrière `FORGE_OPEN` (l'interrupteur qui n'ouvre l'écriture
qu'au propriétaire tant que la phase 16 n'est pas en place). Le registre **n'écrit jamais chez GitHub
de sa propre initiative**. Le détail est dans `docs/DISCUSSIONS.md`, les décisions D06-1 à D06-6.

### Ce qui marche

- **Les discussions.** Un **espace** de discussion par article (repéré par son DOI, même quand le code
  est ailleurs), par dépôt, et par organisation. Dans un espace, jusqu'à **25 catégories**, chacune
  avec un format : discussion ouverte, annonce (seul un responsable en ouvre une), question-réponse
  (« qa » : on peut marquer la bonne réponse), ou sondage. Une discussion a un titre, un texte, une
  catégorie, des étiquettes, des votes « pour » (upvotes), un verrou, une épingle, et une frise des
  événements. Les responsables d'un espace (les auteurs vérifiés de l'article, les mainteneurs du
  dépôt, les propriétaires de l'organisation, les modérateurs du registre) marquent la réponse,
  étiquettent, verrouillent, épinglent, déplacent, masquent et suppriment. Un commentaire masqué par un
  responsable : son texte disparaît pour tout le monde sauf son auteur et toi (le propriétaire). Chaque
  vote n'est compté qu'une fois. La limite d'un commentaire est **65 536 caractères**.
- **Le wiki.** GitHub ne donne pas d'interface pour ses propres wikis : alors le wiki d'OSCR, ce sont
  des pages Markdown (du texte simple mis en forme) sur une **branche `wiki`** du dépôt, modifiées par
  **un commit autorisé** (le modèle de la phase 03 : ton jeton utilisé une seule fois, jamais gardé ;
  c'est GitHub qui signe le commit, et toi l'auteur). La première page crée la branche ; les suivantes
  s'ajoutent dessus. L'historique, une version, la comparaison et le retour en arrière se lisent chez
  GitHub, dans le navigateur (zéro requête du Worker).
- **Les projets.** Des tableaux de suivi (comme les Projects de GitHub), à toi ou à une organisation.
  Leurs **éléments** sont des issues, des pull requests, des brouillons, et surtout des objets de
  recherche propres à OSCR : des **articles**, des **cartes de traçage** et des **rapports de
  reproduction**. Leurs **champs** sont intégrés (Titre, Statut), personnalisés (texte, nombre, date,
  choix unique, itération) et de recherche (article, état d'une carte, résultat d'une reproduction).
  Vues table, tableau (board) et feuille de route. La valeur d'un champ tient dans la ligne de
  l'élément : changer un champ, c'est **une seule ligne** écrite, pas une par case. Limites : 5 000
  éléments et 50 champs par projet.

### Ce que Yann doit faire (ou savoir)

- **Rien de payant, rien de nouveau à configurer.** Aucun service externe appelé. Aucune adresse
  e-mail demandée, montrée ni gardée (le registre masque chaque adresse dans les textes). Aucun code
  d'utilisateur exécuté. Aucune écriture chez GitHub décidée par le registre.
- **Appliquer les migrations 0014, 0015 et 0016** sur `oscr_forge` (comme les autres) avant toute
  ouverture : elles créent les tables des discussions et des projets, et ajoutent la sorte d'action
  `wiki_edit`. La nuit ne déploie rien et ne fusionne rien dans `main`.
- **Les écritures (discussions, projets, wiki) s'ouvrent au public avec le reste**, à la phase 16,
  quand `FORGE_OPEN` est mis **et** que le secret Turnstile est présent. D'ici là, seul ton compte peut
  écrire.
- **Attention, nouveau : du texte public écrit par les lecteurs.** Voir la note ci-dessous.

### Attention : premier texte public écrit par les lecteurs (réconciliation phase 16, D06-6)

Jusqu'ici, on pouvait dire « aucun texte libre d'un lecteur n'est public, donc pas de modèle de langage
pour modérer ». **Ça change avec la phase 06** : les discussions, les projets et le wiki sont le
**premier texte public écrit par les lecteurs**. Ce qui protège déjà, tout de suite : **Turnstile**
(la case « je ne suis pas un robot », vérifiée côté serveur) sur les formulaires d'écriture ; les
**quotas par compte** et le budget de lignes du jour ; les **blocages et limites d'interaction** d'un
espace de dépôt ; le **masquage des adresses e-mail** et le nettoyage des caractères invisibles sur
chaque texte ; la **limite de 65 536 caractères** ; et le **masquage / la suppression par un
responsable** (via les colonnes propres aux objets). Ce qui **reste à faire quand la phase 06
fusionnera** (c'est noté, pas fait cette nuit) : étendre la **file de modération du propriétaire et les
signalements publics** (les listes `REPORT_KINDS`/`HIDDEN_KINDS`, les contrôles des tables `moderation`
et `content_reports`, `hidden.ts`, le retrait statique côté Mac `oscr/moderation.py`,
`src/lib/moderation.ts`, le fixture partagé) aux sortes `discussion` et `discussion_comment` ; faire
que l'export statique de nuit, la recherche, le fil et les webhooks **laissent de côté** le contenu
masqué ; et mettre à jour la phrase « aucun texte libre d'un lecteur n'est public » dans CLAUDE.md et
`/policies/moderation/`. **Aucun modérateur par modèle de langage n'est ajouté** : aucun modèle gratuit
ne tient de façon fiable sur le plan gratuit ; ce sont les règles, Turnstile, le masquage et les
quotas qui font le travail. Tout ce qui demanderait un service payant est signalé, pas construit.

### Ce qui est reporté (noté, pas fait cette nuit, D06-5)

Les pages du site (Astro) et les scripts du navigateur pour les discussions, les projets et le wiki
(le service, le schéma, les actions et les quotas sont faits et testés) ; la gestion fine des
catégories au-delà de celles par défaut ; une issue transformée en discussion et l'inverse ; une
discussion par release ; les filtres de recherche ; les routes d'API publique pour les discussions et
les projets ; itérations, feuille de route, graphiques d'analyse, modèles, mises à jour de statut et
export de vue pour les projets ; les fragments statiques de nuit côté Mac (et le retrait de modération
de D06-6).

### Vérifications à la clôture

pytest 585 ; ruff propre ; `npm test` 1 533 ; la construction et `check --every-route` passent, dans le
budget de fichiers ; le bout-en-bout complet passe (chaque test, y compris l'étape 11 de la phase 06 :
une discussion d'article ouverte par un auteur vérifié, une réponse postée, votée et marquée, un
commentaire masqué puis invisible pour Bob, Turnstile qui passe puis qui refuse, un projet avec un
article en élément, une page de wiki commitée puis modifiée). Captures d'écran dans
`docs/night-screenshots/phase-06/` (bureau 1280x860 et téléphone 390x844 ; aperçus fidèles au style du
site, les pages Astro étant reportées, D06-5).

### `science.css`

Aucun ajout : les aperçus réutilisent les classes existantes (`.masthead`, `.breadcrumb`, `.record`,
`.sidebar`, `nav.tabs`, `dl.listing`, `.line`, `.label`, `.ok`, `.warning`). Les pages réelles, quand
elles seront construites, ajouteront leurs règles dans `science.css`, dans son esprit (pas de pastille,
pas de majuscule décorative, pas de tiret cadratin).

## 9. Phase 12 (statistiques des dépôts)

Construit sur `night/phase-06-discussions`, pas fusionné, pas déployé. Toute écriture du registre
derrière `FORGE_OPEN` ; rien du code d'un utilisateur n'est exécuté ; aucune adresse e-mail nulle part.
Détail : [`docs/STATISTICS.md`](STATISTICS.md), décisions D12-1 à D12-5.

L'idée simple : l'onglet « Insights » d'un dépôt montre ses chiffres. GitHub est le concurrent, alors
le registre **dessine lui-même** chaque graphique (du SVG écrit à la main, jamais une bibliothèque de
graphiques, jamais une image de GitHub). Chaque graphique est **aussi un tableau**, avec un bouton pour
télécharger le CSV (le tableau en texte) et le PNG (l'image, fabriquée dans le navigateur).

### Ce qui marche

- **Les graphiques du navigateur** : l'activité des commits, la participation, la fréquence du code et
  les contributeurs sont lus **dans le navigateur du lecteur, directement chez GitHub**, sur le quota du
  lecteur (0 requête pour le Worker et pour le Mac). GitHub répond « 202 » (pas encore prêt) le temps de
  calculer ; la page réessaie, puis le dit en mots.
- **« Utilisé par »** : combien d'**articles** et de dépôts dépendent d'un dépôt. L'angle recherche :
  on compte un **article**, pas seulement un dépôt. Un dépôt P est « utilisé par » un dépôt D quand le
  graphe des dépendances de D nomme un paquet que P publie ; chaque article lié à D compte alors. Calculé
  sur le Mac (`oscr usedby`), servi par `GET /api/forge/stats`, lecture par clé (jamais un balayage).
- **Le trafic (mainteneurs seulement)** : vues de page et visites par jour (14 jours) et par semaine
  (104 semaines), sites référents, pages populaires. **Rien que des totaux** : jamais un compte de
  visiteurs uniques, jamais rien par personne. Refusé à qui n'est pas mainteneur du dépôt (403), donc ça
  ne fuite ni dans les pages statiques, ni dans la recherche, ni dans un flux, ni dans un webhook, ni
  dans l'API.
- **Le profil de communauté** : les fichiers de santé que GitHub vérifie (README, licence, code de
  conduite, contribution, politique de sécurité) PLUS ce dont le code d'un article a besoin (une licence
  qui autorise le partage, un `CITATION.cff`, un article lié avec une carte de traçage) ; une note par
  point et un score.
- **Les marques de recherche** sur les graphiques (un commit qu'un article ou une carte cite) et
  l'historique des étoiles du registre : ce sont les faits du registre, pas de GitHub.

### Ce que Yann doit faire (ou savoir)

- **Le jeton Cloudflare pour le trafic** : pour que la vue « Trafic » marche en vrai, il faut un jeton
  **en lecture seule** que **toi seul** crées, dans le tableau de bord Cloudflare :
  - un **API token** avec la seule permission **Account Analytics : Read** (lecture seule, aucun droit
    d'écriture, aucun autre périmètre) ;
  - range-le dans le trousseau du Mac sous le nom **`org.oscr.cloudflare-analytics`** (comme les autres
    jetons : `security python -c` ou la commande `security add-generic-password`), et pose-le comme
    **secret Cloudflare** du Worker via `sh tools/setup_cloudflare.sh` (le script te le demande, ne
    l'affiche jamais, ne l'écrit dans aucun fichier) ;
  - pose aussi, à côté, `CLOUDFLARE_ACCOUNT_ID` (l'identifiant de ton compte, public) et
    `CLOUDFLARE_ANALYTICS_SITE_TAG` (l'étiquette du site dans Web Analytics).
  - Le code **ne lit, n'affiche et ne crée jamais** ce jeton : il s'en sert seulement pour autoriser la
    requête. Tant que le jeton n'est pas posé, la vue « Trafic » dit en mots qu'elle n'est pas activée.
  - **Coût** : lire l'analytics Cloudflare entre dans l'analytics incluse du plan Workers (gratuit à ce
    volume). Si un jour le volume demandait un palier payant, c'est signalé avant d'être activé, jamais
    mis en route en silence ; la vue retombe sur « pas activée ».
- **La nuit, rien n'a touché Cloudflare** : l'essai de bout en bout a utilisé une **fausse** source
  d'analytics sur la machine (`tests/forge/fake-cf-analytics-server.ts`), jamais le vrai Cloudflare.
- **Le pousseur du Mac** : `oscr usedby scan` calcule « Utilisé par », l'historique des étoiles et les
  marques des articles, et écrit seulement pour les dépôts dont les chiffres ont changé, dans le budget
  du pousseur. À ajouter à la passe nocturne (à côté de `oscr security`).
- **La migration** : `migrations/d1-forge/0017_statistics.sql` (trois tables : `repo_stats`,
  `repo_dependents`, `repo_marks`). À appliquer avec les autres quand la phase sera fusionnée.
- **Lecture connectée** : `GET /api/forge/stats` et `/api/forge/traffic` demandent d'être connecté (les
  faits « Utilisé par » sont publics, mais la lecture reste hors de la page déconnectée, comme pour la
  sécurité) ; les graphiques GitHub, eux, marchent déconnecté.

### Ce qui est reporté (noté, pas fait cette nuit, D12-5)

Le graphe de réseau (les branches dessinées) et l'arbre/activité des forks ; les marques pour les
**tags** liés à une version d'article ou à un DOI, et les marques placées à la date propre de chaque
commit cité (cette nuit, une marque d'article est posée à la date de publication de l'article) ; le
compteur « Utilisé par » dans les pages statiques pour les lecteurs déconnectés ; les analyses des
discussions, les mesures d'intégration continue, les analyses de règles, les analyses de recherche d'un
laboratoire, et le rapport de transparence de la modération (des comptes seulement). Chaque report est
additif : un élément plus tard ajoute une section ou un fait du Mac, jamais un fichier par dépôt.

### Vérifications à la clôture

Toute la suite verte : pytest 592, ruff propre, `npm test` 1 558 ; la construction et `check
--every-route` dans le budget. L'essai de bout en bout étendu (étape 12, `e2e-statistics.ts`, une fausse
source Cloudflare) et l'ensemble a réussi (sortie 0) : « Utilisé par » compte un article, le graphique
montre une marque de recherche, Ada (mainteneuse) voit un trafic en totaux sans visiteur unique, Bob
(non-mainteneur) est refusé (403), la liste de contrôle reflète un dépôt complet et un dépôt vide.
Captures d'écran dans `docs/night-screenshots/phase-12/` (bureau 1280×860 et téléphone 390×844, contre
un serveur local, toute adresse extérieure bloquée ; le port 8790 n'a pas été touché).

### `science.css`

Ajouts dans l'esprit de la feuille (une seule source de style) : les jetons de couleur des graphiques
sur `:root` (`--series-1..6`, `--chart-add`, `--chart-del`, `--mark-*`), puis `.insights`, `figure.chart`
et ses `.line/.area/.col/.bar/.mark`, `.chart-legend`, `table.chart-table`, `.chart-downloads`,
`.checklist`. Les formes SVG ne portent que la géométrie ; la couleur vient de ces classes (pas de
pastille, pas de majuscule décorative, pas de tiret cadratin).
