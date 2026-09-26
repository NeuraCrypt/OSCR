# Cadence de scraping et hébergements gratuits

*26/09/2026. La cadence vient de mesures faites ici [mesuré]. Les offres ont été
vérifiées le 25-26/09/2026 sur les pages officielles par trois recherches
indépendantes [vérifié] ; [non vérifié] marque ce qui n'a pas pu l'être. Les
offres changent vite : Oracle a divisé son gratuit par deux en juin 2026 sans
préavis.*

---

## 1. La cadence

### Ce qu'un passage fait, mesuré

Mesure sur 300 articles « neuro » d'août 2026, chaîne complète : texte,
jugement, DataCite, vérification des dépôts, récupération des scripts [mesuré].

| mesure | valeur |
|---|---|
| temps par article | **2,4 s** (720 s pour 300) |
| débit d'un seul passage | **~1 500 articles/heure**, ~5 000 fichiers de scripts/heure |
| articles avec le code des auteurs | 31 sur 300 (10 %) ; 71 dépôts vérifiés ; 1 004 fichiers rapatriés |
| machine | ~5 % d'un cœur, 280 Mo de mémoire au plus (zips), aucun GPU |
| ce qui limite | la politesse envers les API (Europe PMC et DataCite à chaque article), pas la machine |

Avec la recherche GitHub « DOI dans le README » (jeton, 30 requêtes/min), le
coût monte à ~4,5 s par article. Elle n'a rien trouvé de plus que le texte sur
177 articles en accès libre : elle reste active pour le passage quotidien et
coupée pour le rattrapage.

### Ce qu'il y a à traiter

Europe PMC, articles en accès libre avec texte intégral [mesuré] :

| périmètre | stock total | 2025 |
|---|---|---|
| neuro (large) | **614 336** | 73 225 (~200 par jour) |
| électrophysiologie (EEG/MEG/iEEG…) | **45 738** | 6 313 (~17 par jour) |

### Ce que ça donne

| où | flux quotidien (neuro) | rattrapage du stock neuro | stock électrophysiologie |
|---|---|---|---|
| **GitHub Actions**, 1 passage par jour + 1,5 h de rattrapage (réglage par défaut) | ~8 min | ~2 250 articles par jour, **~9 mois** | **~20 jours** |
| GitHub Actions, 4,5 h de rattrapage par jour (`RATTRAPAGE_HEURES=4.5`) | idem | ~6 750 par jour, **~3 mois** | ~7 jours |
| **Mac en tâche de fond**, jour et nuit | quelques minutes | ~36 000 par jour, **~17 jours** | **~1,5 jour** |
| Runner GitHub installé sur le Mac (GitHub planifie, le Mac exécute) | idem Mac | idem Mac, jobs de 5 jours au plus | idem |

### Ce qui borne vraiment la cadence : les quotas des API

[vérifié]. Sur les machines partagées de GitHub, un quota « par adresse IP » est
partagé avec d'autres utilisateurs, donc imprévisible.

| API | limite | ce que fait le ramasseur |
|---|---|---|
| Europe PMC | aucune chiffrée ; les conditions de l'EBI bloquent l'usage qui gêne les autres | 1,3 requête/s (sous les ~3/s jugés polis) |
| DataCite | 3 000 requêtes par 5 min et par IP | 2/s |
| Crossref | public : 5/s et 1 concurrente ; « poli » (contact déclaré) : 10/s | seulement sans texte intégral |
| Zenodo | invité : 60/min et **2 000/h** | espacé à 2 000/h |
| **Software Heritage** | **120/h anonyme** : c'est le goulot | quota épuisé → mis de côté jusqu'à la remise à zéro, l'état d'archive reste « inconnu » |
| **OSF** | ~100/h anonyme | quota épuisé → dépôt revérifié au passage suivant |
| GitHub API | 60/h anonyme, 1 000/h avec le jeton d'Actions | utilisée seulement avec un jeton |
| clones git de github.com | durcis pour l'anonyme depuis le 08/05/2025 | authentifiés par le jeton d'Actions quand il existe |
| seau PMC sur AWS | aucune publiée | fichiers joints ; piste pour le texte intégral en masse |

Pour aller au-delà de ~1 500 articles/h, il faudrait trois choses :
- lire les textes intégraux dans le seau PMC plutôt qu'appeler Europe PMC ;
- des jetons Software Heritage et OSF ;
- du parallélisme API par API.

La recherche estime alors ~5 000 à 10 000 articles/h. Mais sur GitHub, les
conditions d'utilisation proscrivent la « charge disproportionnée » : le gros
rattrapage a sa place sur le Mac ou sur un runner auto-hébergé.

---

## 2. Où le faire tourner gratuitement

✅ adapté · ⚠️ possible avec réserve · ❌ inadapté.

### Les options qui marchent

| offre | ce qui est gratuit | réserves | verdict |
|---|---|---|---|
| **GitHub Actions** (dépôt public) | minutes illimitées, jobs de 6 h, 20 simultanés, cron ≥ 5 min, `git` et internet libres, sans carte | tâche planifiée coupée après 60 jours sans activité ; retards en heure pleine ; conditions d'utilisation : usage lié au projet, pas de charge disproportionnée (zone grise pour du scraping) | ✅ |
| **Runner auto-hébergé sur le Mac** | GitHub planifie et publie, le Mac exécute : jobs jusqu'à 5 jours, l'IP du Mac, aucune minute GitHub consommée | le Mac doit être allumé ; installer le runner est une configuration permanente | ✅ |
| **Le Mac seul** (`outils/installer_mac.sh`) | illimité : une veille continue, ~5 % d'un cœur, 40 à 45 Mo, pas de GPU ; publication de nuit sur Hugging Face | le site, lui, doit être publié ailleurs (Pages) | ✅ installé |
| **Modal** (Starter) | **30 $ de calcul offerts chaque mois** (~1 900 h à ¼ de cœur), 5 crons, volumes persistants ; chercheurs : jusqu'à 10 000 $ | carte [non vérifié] ; la base SQLite doit être copiée depuis le volume réseau | ✅ |
| **Google Cloud e2-micro** | VM gratuite sans échéance, 30 Go de disque, cron | **carte bancaire obligatoire** ; régions US ; **1 Go sortant par mois**, donc le site publié ailleurs | ✅ |
| **Oracle Cloud Always Free** | VM Ampere **2 OCPU / 12 Go** (divisée par deux le 15/06/2026), 200 Go de disque, **10 To sortants/mois** | **reprend les VM inactives** (CPU, réseau et mémoire < 20 % sur 7 jours) : exactement notre profil ; « out of capacity » ; carte réputée exigée | ⚠️ |
| **Serv00** | 3 Go, 512 Mo, **cron + SSH + Python**, sans carte | FreeBSD ; connexion obligatoire tous les 90 jours ; conditions d'utilisation [non vérifié] | ⚠️ |
| **Kaggle** (notebooks CPU planifiés) | une exécution par jour au plus, 12 h par session, sans carte | internet après vérification du téléphone ; persistance bricolée ; conditions hors data science [non vérifié] | ⚠️ |
| Northflank (sandbox) | 2 cron jobs gratuits | taille, disque, carte [non vérifié] | ⚠️ |
| Azure Container Apps (jobs) | 180 000 vCPU-s par mois | carte, ou Azure for Students (100 $ sans carte) | ⚠️ |
| alwaysdata (gratuit) | 1 Go, 256 Mo, ¼ de CPU | cron et SSH [non vérifié] ; 1 Go vite plein | ⚠️ |
| GitLab CI | 400 min/mois, jobs de 3 h | ~13 min par jour : le flux électrophysiologie seulement | ⚠️ |

### Les impasses (et pourquoi)

- **Hugging Face Spaces** : créer un Space Docker ou Gradio exige désormais PRO ; gratuit, il ne reste que le statique.
- **Render** : pas de cron gratuit, disque éphémère.
- **Railway** : 1 $ par mois après l'essai.
- **Koyeb** : racheté par Mistral le 17/02/2026, carte exigée.
- **Fly.io** : plus de gratuit, carte exigée.
- **Choreo, Zeabur** : plus de gratuit hébergé.
- **Leapcell** : 15 min par exécution, pas de disque.
- **Databricks Free** : internet sortant en liste blanche.
- **PythonAnywhere** : plus de tâche planifiée gratuite depuis le 15/01/2026, internet en liste blanche.
- **AWS** : plan gratuit de 6 mois, puis compte fermé.
- **EUserv** : IPv6 seul, frais de prolongation.
- **Glitch** : fermé le 08/07/2025.
- **Cirrus CI** : fermé le 01/06/2026.
- **Azure Pipelines** : projets publics retirés.
- **Bitbucket** : 50 min par mois.
- **Vercel, Netlify, Cloudflare Workers, Apps Script, Pipedream** : pas de `git`, exécutions trop courtes ou trop peu de CPU.

### Pistes académiques en France

- **IFB Biosphère** : cloud gratuit pour les laboratoires de sciences de la vie ; il faut un compte et un groupe actif.
- **France Grilles FG-Cloud** : cloud IaaS gratuit pour un laboratoire, par l'organisation virtuelle de France Grilles.
- **Programme chercheurs de Modal** : crédits sur dossier.

Toutes passent par un laboratoire.

---

## 3. Où publier le site et les données

| rôle | choix | limite qui mord en premier |
|---|---|---|
| le site (tableau + lots de scripts) | **GitHub Pages** | 1 Go de site, 100 Go/mois (souples) |
| le site, au-delà de 1 Go | **Cloudflare Pages** | 20 000 fichiers, 25 Mio par fichier |
| les données consultables | **jeu Hugging Face** (visionneuse + console SQL) | stockage public « best-effort », 10 000 fichiers par dossier, quelques milliers de commits |
| l'archive durable, avec DOI | **Zenodo** (instantané mensuel, 50 Go par enregistrement) + **Software Heritage** (code) | — |

À écarter pour le site :
- **Netlify** : 15 crédits par déploiement, soit ~20 déploiements par mois ;
- **Azure Static Web Apps** : 250 Mo ;
- **Firebase** : 10 Go/mois, puis site coupé ;
- **Surge** : pas de CORS en gratuit ;
- **Neocities** : 1 Go ;
- **Amplify** : 6 mois.

---

## 4. La combinaison conseillée

1. **GitHub** : un dépôt public, le passage quotidien sur Actions, le site sur
   Pages, la base dans la Release.
2. **Le stock**, rattrapé une fois pour toutes :
   - soit sur le Mac (~17 jours pour tout le neuro, ~1,5 jour pour l'électrophysiologie) ;
   - soit par un runner GitHub installé sur le Mac ;
   - soit par tranches de 1,5 à 4,5 h par jour sur Actions.
3. **Hugging Face** pour montrer les données, **Zenodo** chaque mois pour l'archive.
4. **En secours** : Modal (crédits mensuels) ou Google Cloud e2-micro, si le Mac
   ne doit plus servir.

Sources principales :
- GitHub : [limites](https://docs.github.com/en/actions/reference/limits), [conditions d'utilisation](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [clones anonymes](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/) ;
- clouds : [Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Google Cloud](https://docs.cloud.google.com/free/docs/free-cloud-features), [Modal](https://modal.com/pricing), [Serv00](https://www.serv00.com/) ;
- Hugging Face : [Spaces](https://huggingface.co/docs/hub/spaces-overview), [stockage](https://huggingface.co/docs/hub/storage-limits) ;
- API : [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/), [DataCite](https://support.datacite.org/docs/is-there-a-rate-limit-for-making-requests-against-the-datacite-apis), [Zenodo](https://developers.zenodo.org/), [seau PMC](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/) ;
- sites : [Cloudflare Pages](https://developers.cloudflare.com/pages/platform/limits/), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
