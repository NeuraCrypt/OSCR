# Rapport de nuit

Mis à jour au fil de la nuit. La mission est dans `docs/NIGHT_RUN.md`, le journal de reprise dans `docs/NIGHT_PROGRESS.md`.

## 1. Résumé

- **Phase 00 (recherche et architecture) : terminée**, branche `night/phase-00-research`, poussée sur GitHub (rien fusionné dans `main`, rien déployé).
- **Inventaire** (`docs/GITHUB_PARITY.md`) : 5 153 fonctionnalités de GitHub, chacune décidée : 2 413 à reproduire, 1 576 à adapter, 1 164 exclues. 3 989 sont donc à construire, réparties entre les phases 01 à 16 et quelques phases nouvelles.
- **Stockage Git** (`docs/DECISIONS.md`, D00-1 à D00-16) : OSCR n'héberge pas les dépôts lui-même ; ils vivent dans le compte GitHub du chercheur, pilotés par l'App GitHub d'OSCR avec son accord.
- **Plan** (`docs/PLATFORM_PLAN.md` §15) : les phases dans l'ordre d'exécution, avec leur budget gratuit.
- **`GitBackend`** : l'interface neutre vis-à-vis de la forge, l'adaptateur GitHub, un double en mémoire et une suite de contrat (`website/worker/forge/`), plus le côté Mac en lecture seule (`oscr/forge.py`). Pas encore branché dans le Worker (phase 01).
- **Tests à la clôture** : pytest 426 réussis (dont 24 pour `oscr/forge.py`) ; ruff propre ; `npm test` 460 réussis sous Node 26 et sous Node 22 (dont 325 pour `GitBackend`) ; build 31 pages ; `check --every-route` ok ; `tsc --strict` propre.
- **Suite** : phase 01 (hébergement Git et mode miroir) sur la branche `night/phase-01-git-hosting`.

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
3. **Créer les secrets Cloudflare** avec `tools/setup_cloudflare.sh` (la phase 01 y ajoute les questions) : `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (le PEM de GitHub tel quel ; le code convertit PKCS#1 en PKCS#8) et `GITHUB_APP_WEBHOOK_SECRET`, plus la variable `GITHUB_APP_SLUG`.
4. **Créer la nouvelle base D1 `oscr_forge`** (binding `FORGE`) avec le même script.
5. **Décider C3** : transférer 20 000 lignes D1 par jour des 80 000 de la poussée de recherche vers le côté GitHub, après son premier chargement complet. D'ici là, le service forge est plafonné dans le code à 5 000 lignes par jour, dans les 10 000 du Worker.
6. **Décider si un jeton utilisateur GitHub peut être gardé, chiffré, dans le cookie de session pendant ses 8 heures** : moins d'allers-retours d'autorisation, et blame et recherche de code pour les lecteurs connectés, sur leur propre quota. Sinon, chaque écriture garde sa propre autorisation.
7. **Décider s'il faut activer l'alias de clonage sur le domaine d'OSCR** (un 302 de `.../info/refs` vers github.com ; possible en une seule règle statique `_redirects`), après un clonage et une poussée de test avec identifiants.
8. **Décider si OSCR peut demander par défaut à Software Heritage d'archiver les commits des cartes de traçage validées.** Aujourd'hui il ne fait que l'interroger, et une demande reste l'acte de l'auteur.
9. **Facultatif** : créer un dépôt modèle public de « compendium de recherche » (README, LICENSE, CITATION.cff, fichier d'environnement, workflow de test facultatif sur les runners standard).
10. **Une fois l'App créée, tester** : si une personne déjà autorisée est renvoyée sans invite ; `POST /user/repos` avec le jeton utilisateur de l'App quand l'installation ne couvre que des dépôts choisis ; la plus grosse charge `createCommitOnBranch` que GitHub accepte, et son erreur pour une tête périmée ; la taille réelle des webhooks ; le blame d'un long fichier dans les 10 s de GraphQL.
11. **Seulement si tu veux un jour qu'OSCR héberge lui-même les dépôts** (aucune option n'est à la fois gratuite et certaine) : Workers Paid plus R2 (environ 6,35 $ par mois à 100 Go) avec git-on-cloudflare ; Cloudflare Artifacts une fois disponible pour tous (environ 54,50 $ par mois) ; un Forgejo ou GitLab institutionnel sans carte, sous un accord signé ; ou la permission écrite de GitHub au titre de l'AUP §6 (déconseillé). Chacune ajouterait un backend derrière `GitBackend`.

## 3. Décisions prises

Voir [`docs/DECISIONS.md`](DECISIONS.md) (entrées D00-1 à D00-16).

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

## 5. Branches, dans l'ordre de fusion

1. `night/phase-00-research` : terminée et poussée.
2. `night/phase-01-git-hosting` : créée à partir de `night/phase-00-research`, en cours.

## 6. Ajouts à `science.css`

(aucun : la phase 00 n'a pas touché au site)
