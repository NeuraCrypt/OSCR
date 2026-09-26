# Scrapper : le ramasseur du code natif

Pour un article de neurosciences, récent ou ancien : trouver où son code est
référencé, vérifier que ce code existe, l'importer dans la bibliothèque, et en
tenir le tableau.

Il a quatre voies de recherche :
- le texte de l'article : section de disponibilité, tableau des ressources, références signées par les auteurs, matériel supplémentaire ;
- ses métadonnées : Crossref, DataCite ;
- les forges : un README GitHub qui cite le DOI, la page Hugging Face d'un article arXiv ;
- les archives : Zenodo, OSF, figshare, Software Heritage.

C'est la première brique d'une bibliothèque de scripts pour la littérature
neuro. Chaque script y porte une **origine** : `natif` (le code des auteurs,
ramassé ici), `genere` et `auteur`. Ces deux dernières sont prévues par le
schéma et ne sont pas codées.

## Ce qu'il produit

| où | quoi |
|---|---|
| `site/index.html` | le tableau, autonome (données comprises) : par article, par famille de méthodes, par dépôt |
| `site/articles.csv`, `depots.csv`, `donnees.json` | les exports, lisibles par la visionneuse d'un jeu Hugging Face |
| `site/bibliotheque_publique.db` | la base sans aucun extrait de texte, pour Datasette ou Datasette Lite |
| `bibliotheque/<article>/fiche.json` | la fiche de l'article : liens, rôles, raisons, statut (pour un dépôt GitHub ; la veille du Mac ne l'écrit pas, la base fait foi) |
| `bibliotheque/<article>/natif/<dépôt>.json` | le manifeste du code des auteurs : commit, licence, fichiers, scripts |
| `donnees/bibliotheque.db` | la base de travail (privée : elle garde les phrases qui ont fait juger chaque lien) |

## Les scripts, en texte

À la vérification, le ramasseur rapatrie le **texte** des scripts de chaque
dépôt dans la base interne (table `fichier` : dépôt, chemin, commit, langage,
lignes, empreinte, texte). Il ne prend que les scripts, le README et la licence,
jamais les données :
- git : clone partiel puis extraction limitée aux scripts ;
- Zenodo, OSF, figshare : fichiers et zips de code ;
- fichiers joints aux articles : seau PMC sur Amazon.

Les notebooks deviennent du code par cellules, sans leurs sorties.

Dans le tableau, la colonne **Scripts** ouvre un volet. On y choisit un
fichier, on le lit en couleur avec ses numéros de ligne, on le copie, ou on
l'ouvre à la source, au commit vérifié.

**Ce qui est publié dépend de la licence du dépôt.** En mode `--public` (le
site, GitHub, Hugging Face), seul le texte d'un dépôt sous licence libre est
recopié. Un dépôt sans licence reste « tous droits réservés » : le volet liste
ses fichiers et renvoie vers chacun à la source. La base privée, elle, garde
tout.

| hébergement | où vont les scripts |
|---|---|
| le Mac | `donnees/bibliotheque.db` (privée, tout le texte) |
| GitHub | `scripts/<dépôt>/…` commité à chaque passage, avec la licence et un `SOURCE.json` ; le site sert les lots `site/scripts/*.json` |
| Hugging Face | `scrapper --public --miroir scripts publier-hf <utilisateur>/<jeu>` : `scripts.jsonl` (lisible dans la visionneuse), les tables, le miroir |

Mesuré le 26/09/2026 sur la bibliothèque (42 dépôts) :
- 1 401 scripts en texte, 11 Mo, en 3 minutes ;
- 19 dépôts republiables (936 scripts) ;
- 23 sans licence, à lire à la source (473 scripts).

## Les niveaux de preuve

Chaque dépôt a un **niveau de preuve**, comme un gabarit du catalogue est
exécuté ou seulement documenté :
- **trouvé** : l'article cite le lien ;
- **vivant** : le lien répond ;
- **inventorié** : fichiers listés, scripts comptés, commit relevé ;
- **importé** : une copie est gardée, seulement si la licence le permet.

## Ce qu'il vaut, mesuré le 25/09/2026

- **Relecture** : 10 verdicts « code des auteurs » justes sur 11, sur des
  articles jamais vus pendant le réglage. La seule erreur, une URL malformée,
  est corrigée.
- **Rappel** (`outils/etalon_zenodo.py`), mesuré sur un étalon indépendant :
  150 articles de 11 revues neuro dont un logiciel Zenodo déclare se
  rattacher.
  - Le texte seul retrouve le dépôt précis des auteurs pour **72 %** des
    articles au texte lisible, et au moins un code des auteurs pour **88 %**.
  - Avec les métadonnées, 149 articles sur 150 (en partie circulaire).
- **Proportions trouvées** :
  - EEG/MEG 2025 : ~24 % des articles publient leur code ;
  - électrophysiologie de septembre 2026 : 7 sur 18 ;
  - « neuro » de juin 2016 : 0 sur 60.
- **Coût** : 40 à 45 Mo de mémoire, ~5 % d'un cœur, ~2,4 s par article au
  premier passage (surtout de l'attente réseau). Aucun GPU.

Le détail, les hébergements possibles et les outils existants :
[docs/ETAT_DE_L_ART.md](docs/ETAT_DE_L_ART.md). La cadence mesurée
(~1 500 articles/heure par passage) et tous les hébergements gratuits
comparés : [docs/HEBERGEMENT_ET_CADENCE.md](docs/HEBERGEMENT_ET_CADENCE.md).

Pour rattraper le stock (614 336 articles neuro en accès libre), mois par mois
dans un budget de temps, avec reprise automatique au passage suivant :

```bash
uv run scrapper rattraper --domaine neuro --heures 2
```

## Démarrer sur le Mac, en tâche de fond

```bash
/Volumes/Expansion/Scrapper/outils/installer_mac.sh
```

Il installe trois tâches `launchd`, les démarre, et vérifie qu'elles tournent.
Le relancer met l'installation à jour sans toucher aux données.

- **`fr.scrapper.veille`** : le ramasseur, **en continu**, en priorité basse
  (`scrapper veiller`). Il fait trois choses :
  - toutes les heures, il lit les articles parus depuis son dernier passage ;
  - une fois par jour, il revérifie les dépôts périmés ou restés inaccessibles ;
  - le reste du temps, il remonte le stock par tranches de 30 minutes, mois
    par mois jusqu'en 2000, et reprend là où il s'est arrêté.

  Quand le stock est fini, il dort. Une coupure réseau le fait attendre,
  2 minutes puis jusqu'à une heure, sans rien conclure pendant la coupure. Il
  se relance seul après 24 h, après un redémarrage du Mac, ou quand on
  rebranche le disque.
- **`fr.scrapper.interface`** : le tableau sur **http://127.0.0.1:8790**, dans
  n'importe quel navigateur de ce Mac, et de ce Mac seulement. La page lit la
  base en direct et ses comptes avancent toutes les minutes. Elle affiche la
  date, le DOI, le titre, le statut, le dépôt, la licence et les scripts ; un
  clic sur « N › » ouvre les scripts à lire.
- **`fr.scrapper.publier`** : chaque nuit à 4 h 17, **seulement la
  publication** (`scrapper nuit`). Elle produit le tableau publiable dans
  `donnees/publication`, puis envoie le catalogue sur Hugging Face. Si le Mac
  dort à cette heure-là, elle part au réveil.

**Ce que ça coûte au Mac**, mesuré le 26/09/2026 sur 5 minutes de veille. Elle
passe l'essentiel de son temps à attendre le réseau, par politesse envers les
services (0,75 s entre deux requêtes à Europe PMC) :
- **processeur** : 1,4 % d'un cœur en moyenne, sur les cœurs d'efficacité
  (`ProcessType Background`, `Nice 15`, entrées-sorties bridées) ;
- **mémoire** : 40 à 60 Mo. Les archives zip passent désormais par le disque
  et non par la mémoire ;
- **Mac** : aucun GPU, et elle n'empêche pas le Mac de dormir. S'il dort, elle
  dort avec lui et reprend au réveil ;
- **disque** : ~125 Ko de cache par article. Pour les 614 336 articles neuro,
  cela fait ~75 Go, sur un disque de 18 To.

**Discrétion ou vitesse** : le réglage `SCRAPPER_PRIORITE`.
- **`fond`** (par défaut) : macOS bride aussi le RÉSEAU d'une tâche de fond.
  Le débit descendant mesuré est divisé par 3 et chaque requête est plus lente.
  Au rythme mesuré le 26/09 (~250 articles/heure, Europe PMC renvoyant alors
  des erreurs 503), le stock neuro prendrait 2 à 3 mois.
- **`normale`** : le réseau n'est plus bridé, et le processeur reste en
  dernier servi (`Nice 15`). Au premier plan, on a mesuré ~1 500
  articles/heure (300 articles d'août 2026), soit ~3 semaines pour le stock.

On change la ligne dans `~/.config/scrapper/reglages`, puis on relance
l'installateur. Les nouveautés (~200 articles/jour) sont suivies dans les deux
cas.

**La publication** a publié 53 Mo le 26/09 en 13 minutes, mais n'en a envoyé
que ~8. Hugging Face (xet) découpe les fichiers en morceaux et ne reçoit que
ceux qu'il n'a pas : chaque nuit ne part que ce qui a changé. Le débit montant
de cette ligne (~25 Ko/s) reste la limite, d'où l'heure : 4 h 17.

| où | quoi |
|---|---|
| `~/Library/Logs/scrapper/veille.log` | une ligne par passage, les pannes (`tail -f`) |
| `~/Library/Logs/scrapper/publication.log` | la publication de la nuit |
| `~/Library/Logs/scrapper/interface.log` | le serveur du tableau |
| `~/.config/scrapper/reglages` | domaine, cadence, jeu Hugging Face |

Les journaux ne sont pas sur le disque externe : launchd refuse d'y ouvrir un
fichier, et la tâche meurt avant de démarrer (code 78). Pour la même raison,
launchd lance Python directement et non un script shell (code 127) : Python
lit lui-même les réglages.

```bash
launchctl bootout gui/$(id -u)/fr.scrapper.veille                                   # mettre la veille en pause
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/fr.scrapper.veille.plist     # la reprendre
launchctl kickstart gui/$(id -u)/fr.scrapper.publier                                 # publier tout de suite
/Volumes/Expansion/Scrapper/outils/installer_mac.sh --retirer                        # tout retirer (les données restent)
```

**La base est partagée sans se bloquer.** Elle est en mode WAL, si bien que
la veille écrit pendant que l'interface et la publication lisent. Ce qui sort
(`bibliotheque_publique.db`) est remis en un seul fichier.

**Le catalogue en ligne** est le jeu Hugging Face
`opsecsystems/bibliotheque-code-natif`, créé **privé**. Il contient :
- `articles.csv`, `depots.csv` ;
- `scripts.jsonl` : le texte des scripts sous licence libre ;
- `bibliotheque_publique.db` : la base SQLite sans extraits.

La publication de la nuit le met à jour. Elle refuse d'envoyer un tableau
généré sans `--public`. Le jeton vit à l'emplacement standard de Hugging Face
(`~/.cache/huggingface/token`), jamais dans ce dépôt. Un futur site le lira par
`https://huggingface.co/datasets/opsecsystems/bibliotheque-code-natif/resolve/main/<fichier>` :
- une fois le jeu rendu public ;
- ou avant, avec un jeton côté serveur.

## Démarrer, pas à pas

Le tutoriel complet est dans [docs/DEMARRAGE.md](docs/DEMARRAGE.md). Il couvre :
- la vérification de ce qui tourne ;
- les réglages du Mac ;
- Hugging Face, le bac à sable Zenodo et Cloudflare Pages ;
- la sauvegarde du code et le dépannage.

## La plateforme et les DOI

Le squelette du projet public est décrit dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
et ses règles dans [CLAUDE.md](CLAUDE.md).

- **Le site** : [plateforme/](plateforme/), en Astro pour Cloudflare Pages (gratuit). Il est
  construit depuis le catalogue de sortie (`donnees/publication`). Chaque article y a sa
  **carte de traçage** : les liens entre l'article et le dépôt de son code.
- **Les DOI** passent par Zenodo, gratuit, avec le **bac à sable** pour tout le développement.
  Ils ne vont qu'aux cartes **validées par un auteur** (ORCID). Le DOI porte sur la carte,
  jamais sur le code, qu'on ne redépose pas.

```bash
uv run scrapper zenodo carte 10.7554/elife.106554        # la carte proposée
uv run scrapper zenodo communaute --creer                # la communauté (bac à sable, jeton requis)
uv run scrapper zenodo deposer 10.7554/elife.106554      # refusé tant qu'aucun auteur n'a validé
```

Le jeton Zenodo se range dans le trousseau macOS, sans le coller nulle part :
`security add-generic-password -s fr.scrapper.zenodo-bac-a-sable -a "$USER" -w`.

## Lancer à la main

```bash
uv sync
uv run scrapper tourner                          # passage incrémental (7 jours la 1re fois)
uv run scrapper veiller                          # en continu, comme la tâche du Mac (Ctrl-C l'arrête)
uv run scrapper nuit --jeu ''                    # le tableau publiable seul, sans envoi
uv run scrapper scanner --domaine electrophysiologie --depuis 2026-09-01
uv run scrapper scanner --depuis 2016-01-01 --jusqua 2016-12-31 --max 500
uv run scrapper doi 10.7554/eLife.100605         # des articles précis
uv run scrapper dossier donnees/corpus_essai     # des JATS déjà sur le disque
uv run scrapper etat                             # les chiffres
uv run pytest
```

**Domaines** :
- `neuro` : large, par défaut ;
- `electrophysiologie` : EEG/MEG/iEEG ;
- ou n'importe quelle requête Europe PMC.

**Options utiles** :
- `--recherche-github` : cherche les README qui citent le DOI. C'est automatique si `GITHUB_TOKEN` existe ; sans jeton, 10 requêtes par minute ;
- `--instantanes` : archive les dépôts dont la licence le permet ;
- `--reverifier` ;
- `--sans-verifier`.

**Variables** :
- `GITHUB_TOKEN` : facultatif ;
- `SCRAPPER_CONTACT` : une adresse pour le « pool poli » de Crossref. Aucune n'est envoyée si elle n'est pas donnée.

## Héberger

**Gratuit, sans carte bancaire : GitHub.** `.github/workflows/tourner.yml`
fait le passage tous les jours à 4 h 17 UTC, garde la base dans la Release
`etat`, commite `bibliotheque/` et publie `site/` sur GitHub Pages. À faire
une fois :
1. pousser ce dossier dans un dépôt **public** ;
2. activer Réglages → Pages → Source : *GitHub Actions*.

**Sur le Mac, en continu** : voir plus haut. Le Mac garde son GPU pour Ollama.

## Les règles

- **Ni le PDF ni le texte d'un article** ne sortent d'ici : un lien DOI, rien
  d'autre. Les phrases qui font juger un lien restent dans la base privée.
- **Un dépôt sans licence reste un lien et un commit**, jamais une copie.
- **Aucun courriel.** Le jour où les auteurs seront sollicités, ce sera par un
  formulaire où ils viennent eux-mêmes (voir l'étude de viabilité de
  stat_bruteforce, `docs/BIBLIOTHEQUE_VIABILITE.md`).
- **Politesse** : un intervalle minimal par service, un cache sur disque, pas
  de requête répétée.

## Le code

| module | rôle |
|---|---|
| `sources/europepmc.py` | les articles et leur JATS |
| `jats.py` | chaque lien de l'article, avec sa phrase et sa section |
| `liens.py` | ramener un lien à son dépôt (`github.com/o/r`, `zenodo:123`…) et à son genre d'hôte |
| `role.py` | code des auteurs, données, ou outil tiers ; chaque indice est gardé dans `raisons` |
| `trouver.py` | un verdict par dépôt |
| `sources/metadonnees.py`, `sources/forges.py` | Crossref, DataCite, GitHub, Hugging Face |
| `depots.py` | vérifier : `git ls-remote`, clone partiel sans contenu, API Zenodo/OSF/figshare, Software Heritage |
| `tourner.py` | le passage ; ce que la vérification corrige ; le statut |
| `methodes.py` | les familles de méthodes du catalogue de stat_bruteforce (`outils/exporter_catalogue.py`) |
| `importer.py`, `tableau.py`, `base.py` | la bibliothèque, le tableau, la base |
| `invenio.py` | Zenodo (InvenioRDM) : la carte de traçage, sa validation par un auteur, son DOI |
| `interface.py` | le tableau local, http://127.0.0.1:8790 |
