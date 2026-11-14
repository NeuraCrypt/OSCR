# Plan : un identifiant unique pour chaque bloc de code relié à un article

Écrit le 13/11/2026. Décisions prises par gg le 14/11 à 00:02 UTC (« go ») : toutes les recommandations de la partie 3.

**Ce qui est fait le 14/11 (branche `block-ids`)** :
- Phases 1, 2 et 3, et l'API de la phase 4 (`/b/<id>.json`) et la carte Zenodo en format 0.2.
- Un changement par rapport au plan : **aucun fichier en plus sur le site**. Les entrées des blocs vont dans les 256 fichiers de lookup qui existent déjà (`/lookup/NN.json`), sous leur propre clé `oscr:b:…`, dans le fichier donné par le SHA-1 de l'identifiant. `/b/<id>` est répondu par le Worker (`worker/block.ts`), pas par des fichiers `blocks/xx.json`.
- `sync` (la création des identifiants) tourne dans l'export de chaque nuit (`catalog.generate`) et par `oscr blocks sync`. Elle ne touche pas au calcul des correspondances (`harvest.align_article`).
- Mesure sur la vraie base le 13/11 : 74 676 blocs couvrent 92 947 des 141 599 correspondances, calculés en 29 secondes. Les autres correspondances n'ont pas de SWHID vérifié (texte tronqué ou réencodé) ou leur article est hors du champ.
- Ce qui reste : enregistrer le préfixe chez identifiers.org (gg), les annotations Europe PMC avec l'identifiant, le compte « blocs » sur `/status`.

## 1. Ce qui existe déjà (vérifié dans le code le 13/11)

**Réponse courte : non, il n'existe pas encore d'identifiant OSCR pour un bloc de code relié à un article.**
Il existe des briques qui s'en approchent :

1. **Le SWHID d'un fichier, avec des lignes** (commit a763e96, 12/11 à 05:57 heure de Chicago).
   - Un **SWHID** (Software Heritage IDentifier) est un identifiant public et normalisé pour un contenu de code. Exemple : `swh:1:cnt:<40 caractères>`.
   - Il est calculé à partir des octets exacts du fichier. C'est le même calcul que `git hash-object`.
   - `oscr/catalog.py` (`content_swhid`) le calcule pendant l'export. Il le fait seulement si le texte gardé est exactement le fichier dont le registre a vérifié le SHA-256.
   - Le lecteur du site (`website/src/lib/swhid.ts`, bouton « Cite ») y ajoute des **qualificatifs** (des précisions collées à l'identifiant) : `origin=` (le dépôt), `anchor=` (le commit), `path=` (le chemin du fichier) et `lines=10-25` (les lignes choisies).
   - Limite 1 : ce SWHID nomme du **code**, pas le **lien entre un passage de l'article et ce code**. L'article n'y figure pas.
   - Limite 2 : il ne s'ouvre dans l'archive de Software Heritage qu'une fois le dépôt archivé.
   - Attention : notre réponse à PREreview du 12/11 (« OSCR ne donne pas son propre identifiant à un bloc de code ») est partie à 05:32, juste avant ce commit. Elle reste vraie pour un identifiant OSCR, mais elle ne parle pas du SWHID.
2. **Les paires article ↔ code** (table `alignment`, méthode `lexical-v1`, fichier `oscr/align.py`).
   - Une paire relie un paragraphe de l'article (son numéro dans le `<body>` du XML JATS) à des lignes d'un fichier (`repo`, `path`, `start_line`, `end_line`, `symbol`).
   - Le 13/11, il y avait **141 573 paires**, sur **22 319 articles**.
   - Leur numéro (`pair`) n'est **pas stable**. À chaque nouveau calcul, `DELETE FROM alignment WHERE article_id = ?` efface toutes les paires de l'article, puis les renumérote à partir de 1 (`oscr/db.py` ligne 396, `oscr/harvest.py` ligne 378). Le numéro 3 d'aujourd'hui peut donc désigner une autre paire demain. On ne peut pas citer ce numéro.
3. **Le lien vers des lignes** : `#L10-L20` sur la page d'un article.
   - Il désigne les lignes du fichier tel qu'il est **aujourd'hui** sur la page. Si le fichier change, le lien montre d'autres lignes.
   - Ce n'est pas un identifiant durable.
4. **Le DOI d'une carte validée** (Zenodo, `oscr/zenodo.py`, tables `validation` et `card_doi`).
   - Un **DOI** est un identifiant permanent, comme ceux des articles.
   - Ici, le DOI est donné à la **carte entière** d'un article (le fichier `tracing-map.json`), seulement quand un auteur l'a validée.
   - Il n'y a qu'une validation et un DOI dans la base, et ce DOI est sur le **sandbox** de Zenodo. Le **sandbox** est un Zenodo d'essai : ses DOI ne sont pas réels.

## 2. Ce que la nouvelle fonction doit faire

Donner à chaque **bloc relié** un identifiant qui a 8 qualités :

1. **Unique** : jamais deux blocs différents avec le même identifiant.
2. **Permanent** : jamais réutilisé, jamais effacé. Même si le bloc n'est plus juste, son identifiant mène à une page qui dit ce qu'il était.
3. **Résoluble** : `https://openscicode.org/b/<id>` ouvre une page lisible par un humain, et `/b/<id>.json` donne les mêmes faits pour une machine.
4. **Recalculable** : n'importe qui peut refaire le calcul à partir des faits publics. C'est un identifiant **déterministe** : les mêmes entrées donnent toujours le même identifiant.
5. **Lié à des identifiants mondiaux** : le DOI de l'article, le SWHID du contenu, le commit et les lignes.
6. **Honnête sur son origine** : il dit si la paire a été proposée par la machine (`lexical-v1`) ou validée par un auteur.
7. **Respectueux des retraits** : un fichier retiré ou masqué (takedown, `withheld`) ne montre plus de code. L'identifiant reste, avec la mention « retiré ».
8. **Sans donnée personnelle** : aucun e-mail, aucun nom d'auteur dans l'identifiant ni dans sa page. Seulement le DOI de l'article et des faits sur le code.

Un **bloc relié**, c'est ces 5 faits ensemble :
- le DOI de l'article ;
- le paragraphe de l'article : son numéro et sa section ;
- le contenu exact du fichier : son SHA-256 et son SWHID ;
- la plage de lignes ;
- le dépôt, le commit et le chemin du fichier.

## 3. Les décisions qui sont à toi (une ligne chacune, avec ma recommandation)

1. **Forme de l'identifiant.** Je recommande `oscr:b:` suivi de 13 caractères en **base32 de Crockford**, puis 1 caractère de contrôle. La base32 de Crockford est un alphabet de 32 signes sans I, L, O ni U, pour éviter les confusions à la lecture. Exemple : `oscr:b:7K3M9QX2PD4TA-K`. Ces 13 caractères portent 65 bits tirés d'un SHA-256 (environ 37 milliards de milliards de valeurs possibles). Avec 10 millions de blocs, le risque que deux blocs tombent sur le même identifiant (une **collision**) reste plus faible qu'une chance sur 100 000. Le caractère de contrôle (ISO 7064 mod 37,36, la méthode qu'utilise ORCID) détecte une faute de frappe.
2. **Ce qui entre dans le calcul.** Je recommande : DOI en minuscules, SWHID du contenu et lignes. Pas le dépôt ni le commit : le même contenu recopié dans un autre dépôt garde ainsi le même identifiant. Le dépôt et le commit restent écrits sur la page du bloc.
3. **Faut-il un DOI par bloc ?** Je recommande **non**. 141 573 DOI, c'est trop. Zenodo crée un dossier par DOI. DataCite demande une adhésion payante. Et cela ferait des milliers de DOI pour des paires que la machine a seulement proposées. Le DOI reste sur la **carte validée** (comme aujourd'hui), et la carte liste les identifiants de ses blocs. Une citation devient « DOI de la carte + identifiant du bloc ».
4. **Faut-il enregistrer le préfixe `oscr` chez identifiers.org / n2t.net ?** Ce sont des services gratuits qui transforment `oscr:b:…` en lien cliquable partout. Je recommande **oui**, mais après la phase 4, quand les pages `/b/` existent. C'est une démarche que toi seul peux faire (création d'un compte, formulaire).
5. **Annoncer la fonction à PREreview (Chad Sansing)** quand elle sera en ligne. Je recommande oui : c'est sa question du 10/11.

## 4. Les phases (une branche et un commit par phase, comme le veut CLAUDE.md)

### Phase 1 : la base du Mac

- Migration `oscr/migrations/0011_code_block.sql`, avec 2 tables :
  - `code_block` (une ligne par identifiant, jamais effacée) : `id`, `article_id`, `doi`, `paragraph`, `section`, `repo`, `commit_id`, `path`, `file_sha256`, `swhid`, `start_line`, `end_line`, `symbol`, `method`, `origin` ('machine' ou 'author'), `status` ('current', 'superseded' ou 'withdrawn'), `superseded_by`, `first_seen`, `last_seen`.
  - `code_block_alignment` (le lien vers la paire du moment) : `article_id`, `pair` → `id`. Elle est refaite à chaque calcul. C'est elle qui absorbe la renumérotation des paires.
- Nouveau module `oscr/blocks.py` :
  - `block_id(doi, swhid, start, end)` : calcule l'identifiant (SHA-256, puis les 65 premiers bits en base32 de Crockford, puis le caractère de contrôle).
  - `mint(con, article_id)` : à lancer juste après chaque nouveau calcul des paires.
    - Pour chaque paire, il calcule l'identifiant. S'il est nouveau, il l'ajoute. S'il existe déjà, il met à jour `last_seen`.
    - Un identifiant qui n'est plus produit passe en `superseded` (remplacé). Son successeur est la paire actuelle du même article et du même fichier dont les lignes se recouvrent le plus. S'il n'y en a aucune, `superseded_by` reste vide.
    - Un fichier `withheld` ou un article `withdrawn` passe ses blocs en `withdrawn`.
  - Une paire sans SWHID (texte tronqué, ou SHA-256 qui ne correspond pas) ne reçoit **pas** d'identifiant. On n'identifie que ce qui a été vérifié.
- Brancher `mint` aux 2 endroits qui recalculent les paires : `harvest.align_article` et `db.py` ligne 396.
- Une collision (même identifiant pour d'autres faits) arrête l'opération avec une erreur claire. On ne change jamais l'identifiant en silence.
- Commande `oscr blocks mint --all` pour remplir la table au départ avec les 141 573 paires, et `oscr blocks show <id>` pour lire un bloc.
- Tests (`tests/test_blocks.py`) :
  - les mêmes faits donnent le même identifiant ;
  - deux nouveaux calculs de suite ne créent rien de nouveau ;
  - des lignes déplacées donnent un nouvel identifiant, et l'ancien devient `superseded` avec le bon successeur ;
  - un retrait donne `withdrawn` ;
  - le caractère de contrôle détecte une faute de frappe ;
  - une collision provoquée arrête l'opération.

### Phase 2 : l'export public

- `oscr/catalog.py` :
  - ajouter l'`id` du bloc à chaque paire exportée pour le lecteur ;
  - écrire les fichiers des blocs : `blocks/<2 premiers caractères>.json`, soit 1 024 fichiers au plus ;
  - mettre la table `code_block` dans la base publique, sans le champ `last_seen` si on veut moins de changements chaque nuit.
- Taille estimée : environ 200 octets par bloc, donc environ 30 Mo pour 141 573 blocs, soit environ 30 ko par fichier. On reste loin des limites de **Cloudflare Pages** (20 000 fichiers, 25 Mo par fichier).
- Règle « pas d'index dans D1 » (CLAUDE.md) : on la respecte. La **D1** est la base de données de Cloudflare. Les blocs sont des fichiers fixes, pas des lignes D1.
- Le dump public et le jeu de données Hugging Face reçoivent la table. Mettre à jour le texte qui décrit le jeu de données.
- Tests : export d'un bloc ; un bloc `withdrawn` sans code ; aucun e-mail (`npm run check:emails` passe).

### Phase 3 : le site

- `website/worker/` : une route `/b/<id>` et `/b/<id>.json`. Le Worker lit le bon fichier `blocks/xx.json` grâce au lien `ASSETS`, comme `badge.ts` le fait déjà. Il contrôle d'abord le caractère de contrôle : un identifiant mal tapé reçoit une réponse 404 qui l'explique.
- La page d'un bloc dit, en mots simples :
  - l'article (titre et DOI) et le paragraphe ;
  - le dépôt, le commit, le chemin et les lignes ;
  - le SWHID qualifié (le texte de `qualifiedSwhid`) ;
  - qui a fait le lien : la machine (`lexical-v1`) ou un auteur ;
  - l'état du bloc : actuel, remplacé (avec un lien vers le successeur) ou retiré ;
  - un bouton pour ouvrir le bloc dans le lecteur.
- Le lecteur (`Reader.astro`, `code-view.ts`, `swhid.ts`) : à côté de chaque passage surligné, montrer l'identifiant du bloc. Le bouton « Cite » donne : identifiant du bloc + DOI de l'article + SWHID qualifié + lien `/b/<id>`.
- Des métadonnées en **JSON-LD** (des données cachées dans la page, lisibles par les moteurs de recherche) au format schema.org `SoftwareSourceCode` : `identifier`, `isBasedOn` (le DOI de l'article) et `codeRepository`.
- Une page d'aide `/help/identifiers/` et une page de règles `/policies/identifiers/`. Elles disent : on ne réutilise jamais un identifiant, on ne l'efface jamais, un bloc remplacé ou retiré garde sa page, et la machine peut se tromper.
- Styles : seulement dans `science.css` (règle de CLAUDE.md).
- Attention : `website/public` est un **lien symbolique** (un raccourci) vers `/Volumes/Expansion/OSCR-heavy/website/public`. Ce dossier est hors du « sparse checkout » de git (git n'y prend qu'une partie du dépôt), et `git merge` a échoué à cause de lui le 13/11. Toute modification de `openapi.json` doit tenir compte de ça.
- Tests vitest : le calcul de l'identifiant en TypeScript donne le même résultat qu'en Python (mêmes exemples des deux côtés) ; la route 404 ; la page d'un bloc retiré.

### Phase 4 : l'API et les partenaires

- API : `GET /api/v1/blocks?doi=…` (les blocs d'un article) et `GET /b/<id>.json`. Mettre à jour `openapi.json` et `docs/API_PUBLIC.md`.
- La carte Zenodo (`tracing-map.json`) passe en version 2. Elle liste les identifiants des blocs.
  - Attention : son empreinte (`map_digest`) change avec la version 2. Une carte déjà validée garde sa version 1 et son empreinte. Sinon, la règle « une carte qui a changé n'est pas déposée » la refuserait.
- Les annotations envoyées à Europe PMC (`oscr outreach`) : chaque annotation porte l'identifiant du bloc et le lien `/b/<id>`.
- Software Heritage : `swh_save` (déjà lancé chaque nuit) archive les dépôts. Ainsi, le SWHID de chaque bloc finit par s'ouvrir dans leur archive.

### Phase 5 : la mise en service

1. Faire une copie de sauvegarde de `data/oscr.db` avant la migration.
2. Lancer `oscr blocks mint --all` en dehors de la publication de la nuit (pas entre 04:00 et 06:00).
3. Ensuite, la publication de la nuit publie les blocs. Ajouter un compte « blocs » dans `/status`.
4. Vérifier au hasard 20 blocs : le SWHID recalculé à la main avec `git hash-object` doit être le même.
5. Toi seul : enregistrer le préfixe `oscr` chez identifiers.org (décision 4).
6. Écrire à PREreview (Chad Sansing) pour annoncer la fonction (décision 5).

## 5. Les risques et leurs parades

- **Le texte gardé n'est pas exactement le fichier** (tronqué, ou réencodé). Le SWHID serait alors faux. Parade : pas d'identifiant sans un SWHID vérifié par le SHA-256 (la règle de `content_swhid` existe déjà).
- **La méthode d'alignement change** (`lexical-v2`). Tous les blocs seraient alors refaits. Parade : la méthode est enregistrée dans chaque bloc, les anciens blocs passent en `superseded` avec un successeur, et aucune page ne disparaît.
- **Une paire proposée par la machine est fausse.** Parade : la page le dit (`origin = machine`). Les auteurs pourront plus tard rejeter une paire depuis le site. Le bloc passe alors en `withdrawn`, avec la raison « rejeté par un auteur ».
- **Un retrait (takedown).** Parade : `withheld` met les blocs en `withdrawn` à la publication suivante. La page reste, sans code.
- **La taille des fichiers publiés grandit avec le registre.** Parade : on découpe par les 2 premiers caractères. On peut passer à 3 caractères (32 768 fichiers) si besoin, mais il faudrait alors regrouper les fichiers pour rester sous 20 000.

## 6. Ce que cela coûte

- 5 phases, donc 5 commits sur des branches dédiées.
- Aucun service payant.
- Pour toi, seulement 2 gestes : enregistrer le préfixe chez identifiers.org, et dire « oui » au mail à PREreview.
