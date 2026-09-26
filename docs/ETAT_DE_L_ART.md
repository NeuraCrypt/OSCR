# Hébergements, sources et outils pour ramasser le code natif des articles

*25/09/2026. Trois recherches indépendantes (hébergement, sources vérifiées en
direct, outils et littérature), plus nos propres mesures. Chaque chiffre porte
sa provenance : **[mesuré]** ici, **[vérifié]** sur la page officielle ou par
un appel réel le 25/09/2026, **[non vérifié]** sinon.*

---

## En une page

- **Hébergement gratuit : oui, pour le ramasseur** (pas pour le pipeline de
  génération, qui a besoin du GPU). La combinaison sans carte bancaire qui
  tient : **GitHub Actions** (le passage quotidien) + **une Release GitHub**
  (la base SQLite entre deux passages) + **GitHub Pages** (le tableau public,
  et la base allégée lisible par Datasette Lite). Fichiers prêts :
  `.github/workflows/tourner.yml`.
- **Sur le Mac : une veille continue** (`launchd`, priorité *Background*),
  plus une publication de nuit vers Hugging Face. Mesuré : 40 à 45 Mo de
  mémoire, ~5 % d'un cœur en plein travail, aucun GPU. Fichiers :
  `outils/fr.scrapper.{veille,interface,publier}.plist`, posés par
  `outils/installer_mac.sh`.
- **La source d'articles : Europe PMC** (gratuit, sans clé, plein texte JATS).
  Pour un rattrapage massif des anciens articles : **le seau PMC Open Access
  sur AWS**, lisible sans compte.
- **Trouver le code : cinq voies**, toutes codées sauf la dernière. Par ordre
  de rendement mesuré : le texte de l'article (section de disponibilité,
  références) ; la recherche GitHub « DOI dans le README » ; les fiches Zenodo,
  OSF, figshare ; Crossref et DataCite ; les registres de neurosciences (à
  faire).
- **Ce qui ne marche plus ou coûte** : Papers with Code est éteint depuis le
  24/07/2025 ; OpenAlex facture à l'usage ; Hugging Face ne donne plus de
  calcul gratuit (Spaces Docker réservés aux offres payantes) ; Code Ocean
  refuse les robots.

---

## 1. Ce que nous avons mesuré

| mesure | résultat | provenance |
|---|---|---|
| articles EEG/MEG 2025 en accès libre avec le code des auteurs | **23 à 24 sur 99** (~24 %) | [mesuré], corpus de l'étude de viabilité |
| mêmes articles qui ne disent que « sur demande » | 4 sur 99 (10 le disent, dont 6 publient quand même un lien) | [mesuré] |
| articles récents (15-25/09/2026, électrophysiologie) avec code | **7 sur 18** | [mesuré], jamais vus pendant le réglage |
| articles « neuro » du 1-2/06/2016 avec code | **0 sur 60** (et aucun lien d'hébergeur de code dans leur XML) | [mesuré] |
| justesse des verdicts « code des auteurs », à la relecture | 27/28 sur le corpus de réglage ; **10/11 sur les articles neufs**, la seule erreur (une URL malformée) corrigée | [mesuré], lu à la main |
| dépôts de code vérifiés vivants | 40 sur 40 ; 6 déjà archivés chez Software Heritage | [mesuré] |
| coût d'un passage de 99 articles | 158 s au premier passage, 58 s ensuite (cache) ; 64 Mo max ; ~20 s de calcul | [mesuré] `/usr/bin/time -l` |
| l'index de recherche d'Europe PMC sous-déclare les liens de code | facteur **2,4** : il faut lire le XML | [mesuré] dans l'étude de viabilité |
| **rappel, étalon indépendant** : 150 articles de 11 revues neuro dont un logiciel Zenodo déclare lui-même se rattacher ; 142 paires où un créateur du logiciel est auteur de l'article | voir ci-dessous | [mesuré], `outils/etalon_zenodo.py` |
| … le TEXTE SEUL retrouve ce dépôt précis | **73 sur 102 articles au plein texte lisible (72 %)** ; 51 % sur tous les articles | [mesuré], passage sans aucune métadonnée |
| … le texte seul trouve au moins un code des auteurs | **97 articles sur 110 au texte lisible (88 %)** | [mesuré] |
| … avec toutes les voies (texte, Crossref, DataCite, archives) | 142 sur 142, 149 articles sur 150. **En partie circulaire** : DataCite lit les relations Zenodo qui ont fait l'étalon | [mesuré] |

**Ce que le texte ne peut pas voir** (les 29 dépôts précis ratés au texte
lisible) : 25 fois l'article donne un AUTRE code de ses auteurs, que le
ramasseur trouve ; 9 fois ni ce dépôt ni aucun lien dans le texte (une citation
de jeu de données sans DOI) ; 1 fois « sur GitHub » sans lien. Pour ceux-là,
seules les métadonnées répondent.

**Ce que l'étalon a appris** (chaque point verrouillé par un test) :
- Dryad range le CODE d'un jeu de données dans un logiciel Zenodo compagnon
  (« Data from: … », relation `isSourceOf`) : Dryad est une archive mixte, et
  sa vérification cherche ce compagnon ;
- quand DataCite dit « données » et le texte « code » pour la même archive,
  les deux sont vrais : on garde le code ;
- eLife cite ses jeux « générés » par une `element-citation` dans la
  déclaration, et un DOI Dryad y perd parfois son point ;
- un titre de section se lit au plus près (« Software availability » sous
  « Materials and methods ») ;
- « sample data » accompagne un logiciel, il n'en fait pas un jeu de données ;
- un fichier joint `.zip` n'est pas un nom de domaine.

**Ce que la lecture a appris** (dix pièges, chacun verrouillé par un test) :
une référence non balisée (« Schmidt F. ECG_1f_memory ») ; un logiciel cité
avec sa version (« Iso2Mesh … downloaded from ») ; « we » et « used » trop
larges ; « repository » qui range des données ; les liens PubMed/PMC ; le point
après une URL avalé ; le lien seul entre parenthèses ; la déclaration PLOS en
`custom-meta` ; l'appel de référence collé au DOI (`zenodo.15795242` + « 93 ») ;
le DOI de préimpression PsyArXiv lu comme un projet OSF. Puis, à la
vérification : un jeu BIDS de 2 141 fichiers promu « code » pour 3 scripts ; un
ZIP compté comme zéro script ; un projet OSF rangé en sous-composants ; un
dépôt annoncé mais vide.

---

## 2. Hébergement

### 2.1 Le tableau

✅ adapté · ⚠️ possible avec réserve · ❌ inadapté. Chiffres [vérifié] sauf
mention.

| offre | gratuit | ce qui mord pour ce profil | verdict |
|---|---|---|---|
| **GitHub Actions, dépôt public** | minutes gratuites ; job ≤ 6 h ; cron ≥ 5 min | cron retardé aux heures pleines ; **désactivé après 60 jours sans activité** (un commit du workflow compte en pratique, [non vérifié] officiellement) ; CGU : usage lié au projet | ✅ |
| GitHub Actions, dépôt privé | 2 000 min/mois | 1 h/jour ≈ 1 800 min : de justesse | ⚠️ |
| **GitHub Releases** | fichier < 2 Gio, taille totale et bande passante illimitées | pas d'en-tête CORS : illisible par le navigateur | ✅ stockage de la base |
| **GitHub Pages** | 1 Go, 100 Go/mois (souple), CORS `*` | interdit pour un service commercial | ✅ vitrine |
| Dépôt git | fichier bloqué au-delà de 100 Mio | ne jamais y commiter la base | ⚠️ fiches JSON seulement |
| Cache Actions | 10 Go par dépôt | purgé après 7 jours sans lecture : pas une sauvegarde | ⚠️ |
| Hugging Face Spaces | Static Spaces seulement | **Spaces Gradio/Docker réservés aux offres payantes (2026)** : ni git ni cron | ❌ calcul, ✅ statique |
| **Hugging Face, jeux de données** | stockage public « best-effort » ; visionneuse + console SQL DuckDB | pas une base qu'on réécrit sans cesse (super-squash conseillé) | ✅ vitrine de données |
| HF Jobs (planifiés) | payant : 0,01 $/h en CPU, ~0,30 $/mois | crédits requis | ⚠️ quasi gratuit |
| GitLab CI | 400 min/mois | ~13 min/jour au plus | ⚠️ |
| Codeberg (Woodpecker, Forgejo Actions) | sur demande, bénévoles, « open alpha » | licences libres seulement | ⚠️ |
| Cloudflare Workers | 10 ms de CPU par cron | aucun scan possible ; bon DÉCLENCHEUR de `workflow_dispatch` | ⚠️ |
| Cloudflare D1 / R2 / Pages | 5 Go / 10 Go / 25 Mio par fichier | D1 : 100 k écritures/jour | ⚠️ |
| Vercel Hobby | 1 cron/jour, ± 59 min | fonction sans git | ❌ |
| Netlify | fonctions planifiées de 30 s | trop court | ❌ |
| Deno Deploy | Classic fermé le 20/07/2026 | — | ❌ |
| Render / Railway / Fly.io / Koyeb | pas de cron gratuit / essai / plus de gratuit / plus de calcul gratuit | — | ❌ |
| Northflank | 2 cron jobs, carte vérifiée [non vérifié en détail] | « not for production » | ⚠️ |
| Google Cloud | VM e2-micro, 1 Go de sortie/mois | carte obligatoire | ⚠️ |
| AWS | crédits 6 mois depuis le 15/07/2025 | compte fermé ensuite sans passage payant | ⚠️ |
| Oracle Always Free | 2 OCPU / 12 Go | **reprend les VM inactives** : exactement notre profil | ❌ |
| Azure | Container Apps jobs dans l'offre gratuite | carte [non vérifié] | ⚠️ |
| Modal | 30 $/mois offerts ; notre coût estimé 0,5 à 1,7 $/mois | carte [non vérifié] | ✅/⚠️ |
| PythonAnywhere | **plus de tâche planifiée gratuite depuis le 15/01/2026** ; internet en liste blanche | — | ❌ |
| Streamlit Community Cloud | veille après 12 h | pas d'ordonnanceur | ❌ |
| Datasette Lite | lit une base servie avec CORS (GitHub Pages l'est) | — | ✅ |
| Turso / Neon / Supabase / MotherDuck | 5 Go / 0,5 Go / pause / 10 Go | — | ⚠️ |
| Tailscale Funnel / Cloudflare Quick Tunnel / ngrok | exposer le Mac | bêta / tests seulement / 1 Go par mois | ⚠️ inutile si Pages |

### 2.2 Trois architectures à coût nul

**A. Tout GitHub (recommandée, aucune carte).**
- Le workflow `tourner.yml` récupère la base depuis la Release `etat`, lance
  `scrapper tourner`, renvoie la base à la Release, commite
  `bibliotheque/` et publie `site/` sur Pages.
- Casse si :
  - rien n'est commité pendant 60 jours ;
  - GitHub retarde ou saute un passage (le suivant rattrape, le curseur est idempotent) ;
  - GitHub juge l'usage étranger au projet (zone grise des CGU).

**B. Le Mac calcule, GitHub expose.**
- La tâche de fond tourne sur le Mac, puis un `git push` envoie `site/` vers
  Pages. Aucun serveur ni tunnel sur le Mac.
- Casse si :
  - le disque externe n'est pas monté ;
  - le Mac manque de mémoire (déjà en swap).

**C. Actions + Hugging Face.**
- Comme A, mais la base et les exports Parquet/CSV vont dans un jeu de données
  HF. La visionneuse HF devient la vitrine publique, avec requêtes SQL
  partageables.
- Casse si :
  - HF change encore sa politique de stockage ;
  - on ne commite plus sur GitHub : les envois vers HF ne comptent pas comme activité.

### 2.3 Le Mac, au plus léger

- **Les réglages** : `ProcessType=Background`, `LowPriorityIO`,
  `LowPriorityBackgroundIO`, `Nice 15`, `StartCalendarInterval` (toutes ces
  clés sont reconnues par macOS 26.4.1, [vérifié] `man launchd.plist`).
- **Si le Mac dort à l'heure prévue**, la publication manquée est lancée au
  réveil ; la veille, elle, s'arrête avec le Mac et reprend au réveil.
- **Deux pièges macOS, vus le 26/09/2026 :**
  - launchd n'ouvre aucun journal sur le disque externe : la tâche meurt avant
    de démarrer, code 78 ;
  - `/bin/zsh` lancé par launchd ne peut pas lire un script posé sur ce disque :
    code 127.

  En revanche, Python lancé par launchd, et ce qu'il lance (git), y lisent et y
  écrivent. D'où : journaux dans `~/Library/Logs/scrapper`, Python lancé
  directement, réglages lus par Python.
- **`taskpolicy -b`** bride aussi le réseau : le passage serait plus lent. Nous ne l'avons pas mis.
- **Rien n'est installé tant qu'on ne lance pas** `outils/installer_mac.sh`
  (installé le 26/09/2026).

---

## 3. Sources d'articles

| source | accès | apport | état [vérifié] |
|---|---|---|---|
| **Europe PMC REST** | sans clé ; ~1,4 req/s tenues | recherche par période ; plein texte JATS des articles en accès libre et d'une partie des préimpressions | ✅ utilisée |
| **PMC Open Access sur AWS** | `s3://pmc-oa-opendata`, sans compte | chaque article versionné (`PMC…​.1/…​.xml`, `.json`) ; inventaire quotidien | ✅ **pour le rattrapage massif** (à coder) |
| bioRxiv API | `/pubs` marche ; **`/details` rend un corps vide** | nouveau préfixe DOI `10.64898` (55 % des récents) | ⚠️ JATS via le site, avec un 429 fréquent |
| Crossref | sans clé ; 5 req/s (10 en « pool poli ») | références et relations, même pour les articles fermés | ✅ utilisée sans plein texte |
| OpenAlex | **facturé à l'usage depuis 2026** (0,10 $/jour sans clé) | classification « Neuroscience » par sujet | ⚠️ pas utilisée |
| Semantic Scholar | quota partagé sans clé | pas de liens de code | ❌ |
| arXiv + Hugging Face Papers | sans compte | `githubRepo` des pages d'articles, **arXiv seulement** | ✅ utilisée pour les DOI arXiv |

## 4. Sources de liens article → code

| voie | rendement mesuré ou vérifié | codée ? |
|---|---|---|
| **Texte JATS** : section de disponibilité, tableau des ressources, références signées par les auteurs, matériel supplémentaire | l'essentiel des 24 % | ✅ |
| **GitHub « DOI dans le README »** | eLife.100605 → exactement les 2 dépôts des auteurs. Sur nos 177 articles [mesuré] : **aucun code d'auteur de plus que le texte**, 5 dépôts trouvés et tous bien écartés (3 miroirs de données OpenNeuro, 2 réutilisations d'étudiants) ; 168 requêtes, 18 min sans jeton. Utile surtout sans plein texte | ✅ (défaut : avec un jeton) |
| **Fiches Zenodo / OSF / figshare** | type de ressource (software/dataset), fichiers, licence, dépôt GitHub source | ✅ |
| Software Heritage | archivé ou non ; « Save Code Now » possible | ✅ lecture ; archivage en option à coder |
| Crossref (références, relations) | eLife type ses logiciels (`"type": "software"`) | ✅ sans plein texte |
| DataCite `relatedIdentifiers` | précis quand déclaré, souvent muet | ✅ |
| OpenAIRE ScholeXplorer v3 (`/v3/Links?sourcePid=DOI&targetType=Software`) | relations souvent « cites » : un outil cité, pas le code propre | ❌ à essayer |
| Europe PMC Annotations | DOI Zenodo/JOSS annotés par section ; **aucune URL GitHub** | ❌ |
| **ModelDB** (`modeldb.science/api/v1/models/<id>` → article PMID/DOI → `github.com/ModelDBRepository/<id>`) | 1 931 modèles de neurosciences computationnelles | ❌ **à coder : index inverse** |
| G-Node GIN (`datacite.yml` : `IsSupplementTo` DOI) | dépôts neuro avec DOI | ❌ à coder |
| NeuroLibre (21 articles), ReScience C (223, dont 33 en neuro computationnelle), CODECHECK (132, peu de neuro) | code lié par construction | ❌ **étalons de rappel** |
| DANDI, OpenNeuro | données ; articles liés, pas de code | ❌ |
| SciCrunch RRID (`scicrunch.org/resolver/RRID:SCR_….json`) | l'URL du dépôt d'un OUTIL cité | ❌ utile pour la liste d'outils tiers |
| Code Ocean | **403 à tout robot** | ⚠️ marqué « non vérifiable » |
| Papers with Code | éteint le 24/07/2025 ; archive figée sur HF | ❌ (couverture ML) |

## 5. Outils d'extraction, et ce que la littérature en dit

Performances publiées **[non vérifié]** sauf mention.

| outil | ce qu'il fait | pour nous |
|---|---|---|
| ODDPub (R) | regex données/code ouverts ; Charité | ses dictionnaires, à porter si besoin |
| rtransparent (R, PLOS Biol 2021) | indicateurs de partage sur XML PMC | étalon de comparaison |
| Softcite / GROBID software-mentions | mentions de logiciels, **créé / utilisé / partagé** | le bon classifieur si un jour il faut du ML (Java, lourd) |
| SoMeSci, CZI Software Mentions (67 M mentions, CC0) | étalons et liste d'outils populaires | liste d'exclusion des outils tiers |
| DataSeer / PLOS Open Science Indicators | indicateurs code/données des articles PLOS | étalon pour PLOS |
| PyMuPDF (AGPL), pypdf (BSD), pdfplumber (MIT) [vérifié, versions de 2026] | liens des PDF (annotations) | pour les articles sans XML (à coder) |
| GROBID (Apache-2.0) | TEI avec `<ref type="url">` | idem, service Java |

**Heuristiques publiées pour séparer le code propre de l'outil tiers**, toutes
reprises ici :
- la section et la formulation (« our code » contre « using X ») ;
- le lien dans les deux sens (le README cite l'article) ;
- la fiche Zenodo (`isSupplementTo`, type « software ») ;
- la date de création et les étoiles du dépôt ;
- le compte au nom d'un auteur.

## 6. Bibliothèques Python

[vérifié] sur PyPI et GitHub le 25/09/2026.

- **Retenues ici, à dessein** : `httpx` seul. Le cache, la politesse, la
  lecture JATS (`xml.etree`) et SQLite sont écrits sans dépendance, pour
  tourner partout.
- **Utiles si le projet grandit** :
  - `lxml` (JATS rapide) ;
  - `huggingface_hub` 2.0 (`paper_info`, `list_papers`) ;
  - `githubkit` ou `PyGithub` ;
  - `python-gitlab` ;
  - `oaipmh-scythe` (le successeur actif de Sickle) ;
  - `requests-cache` ou `hishel` ;
  - `tenacity` ;
  - `RapidFuzz` (noms d'auteurs contre comptes) ;
  - `idutils` (valide DOI, SWHID, RRID) ;
  - `sqlite-utils`, `datasette`, `duckdb`.
- **Dormantes, à éviter** : `pdfx` (archivée), `papermage`, `unpywall`,
  `Sickle`, `backoff`, `cffconvert`, `osfclient`.

## 7. Ce qui reste à faire, par rendement attendu

1. **Rattrapage des années passées** par le seau PMC sur AWS, plutôt que par
   des milliers de requêtes Europe PMC.
2. **Index inverse ModelDB et GIN** : du code de neurosciences computationnelles
   lié à son article par construction.
3. **Élargir l'étalon de rappel.** Celui de Zenodo est fait (§1). Il reste à
   ajouter NeuroLibre, ReScience C (neuro computationnelle) et CODECHECK, et
   surtout des articles FERMÉS, où seules les métadonnées parlent.
4. **Articles sans XML** : liens des PDF (pypdf/pdfplumber), pour les revues
   fermées dont on a le PDF.
5. **Archivage Software Heritage** (« Save Code Now ») des dépôts trouvés, en
   option. C'est une action vers un service tiers, donc à activer
   explicitement.
