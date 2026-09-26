# Démarrer et relier la bibliothèque du code natif

Tout ce qu'il faut faire, dans l'ordre. Les commandes se tapent dans le Terminal du Mac.

## Où on en est (26/09/2026)

| brique | état |
|---|---|
| **Le ramasseur** (veille continue) | ✅ tourne depuis le 26/09 |
| **L'interface locale** | ✅ http://127.0.0.1:8790 |
| **La publication de nuit** (Hugging Face) | ✅ connectée par `hf auth login` (OAuth, renouvelé seul) |
| **Le site public** (Cloudflare Pages) | ✅ en ligne sur https://code-natif.pages.dev, remis à jour chaque nuit |
| **Les DOI des cartes** (Zenodo) | ✅ bac à sable relié, communauté `code-natif-neurosciences` créée, un dépôt d'essai fait |
| **Le code** | ✅ sur https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR- |
| **La validation par les auteurs** (ORCID) | ❌ pas encore construite ; sans elle, pas de vrai DOI |

Les étapes ci-dessous disent comment chaque brique a été reliée, pour la refaire sur une
autre machine ou après une panne.

## Étape 1 : vérifier que le ramasseur tourne (2 min)

```bash
launchctl list | grep scrapper
```

Trois lignes doivent apparaître :
- `fr.scrapper.veille` et `fr.scrapper.interface` ont un numéro (un PID) dans la première colonne ;
- `fr.scrapper.publier` a un tiret : elle ne tourne qu'à 4 h 17.

Un `78` ou un `127` dans la deuxième colonne signale une panne : voir « En cas de problème ».

```bash
tail -f ~/Library/Logs/scrapper/veille.log      # la veille, en direct (Ctrl-C pour quitter)
open http://127.0.0.1:8790                       # le tableau
```

## Étape 2 : régler le Mac pour qu'il tourne sans toi (5 min)

Ces réglages de macOS sont les tiens ; je n'y touche pas.

- **Réglages Système → Énergie** :
  - activer « Empêcher la suspension automatique lorsque l'écran est éteint » ; sinon, la veille s'arrête quand le Mac dort ;
  - activer « Démarrer automatiquement après une panne de courant ».
- **Après un redémarrage**, les tâches repartent quand tu ouvres ta session. Tant que personne n'est connecté, elles attendent.
  - L'ouverture de session automatique (Utilisateurs et groupes) évite cette attente, mais elle est impossible avec FileVault.
- **Le disque Expansion** doit rester branché. Débranché, la veille s'arrête ; rebranché, elle repart seule.

## Étape 3 : Hugging Face, remplacer le jeton (5 min)

L'ancien jeton est passé dans une conversation : il faut le remplacer.

1. Sur huggingface.co, ouvre **Settings → Access Tokens → Create new token**.
   - Choisis *Fine-grained*, avec le droit d'écriture sur les dépôts de ton espace.
   - Nomme-le `scrapper-mac`.
2. Dans le Terminal, lance la commande ci-dessous. Elle ouvre le navigateur pour te connecter, ou te demande de coller le jeton (il reste invisible). Ne mets jamais le jeton dans la commande elle-même : il resterait dans l'historique du Terminal.
   ```bash
   /Volumes/Expansion/Scrapper/.venv/bin/hf auth login --force
   ```
3. Sur le site, supprime l'ancien jeton `reproductible`.
4. Teste en lançant la publication tout de suite :
   ```bash
   launchctl kickstart gui/$(id -u)/fr.scrapper.publier
   tail -f ~/Library/Logs/scrapper/publication.log
   ```
   Le journal doit finir par une ligne `… fichiers, … Mo → huggingface.co/datasets/opsecsystems/bibliotheque-code-natif`.

Le jeu reste **privé**. Le rendre public est une décision à prendre sur sa page Hugging Face.

## Étape 4 : Zenodo, le bac à sable (10 min)

Tout le développement se fait sur **sandbox.zenodo.org** : les DOI y sont factices (préfixe `10.5072`).

1. Crée un compte sur https://sandbox.zenodo.org : courriel, GitHub ou ORCID.
2. Crée un jeton : menu à ton nom → **Applications → Personal access tokens → New token**.
   - Nom : `scrapper`.
   - Coche `deposit:write` et `deposit:actions`.
   - Clique sur **Create**, puis copie le jeton.
3. Range le jeton dans le trousseau du Mac. Colle-le deux fois quand on te le demande (il reste invisible). Ne le colle nulle part ailleurs, ni dans un fichier ni dans une conversation.
   ```bash
   security add-generic-password -s fr.scrapper.zenodo-bac-a-sable -a "$USER" -w
   ```
4. Crée la communauté :
   ```bash
   cd /Volumes/Expansion/Scrapper
   uv run scrapper zenodo communaute --creer
   ```
   Si Zenodo refuse, crée-la à la main sur https://sandbox.zenodo.org/communities-new avec l'identifiant `code-natif-neurosciences`.
5. Essaie toute la chaîne avec Josiah Carberry, le chercheur fictif qu'ORCID fournit pour les essais :
   ```bash
   uv run scrapper zenodo carte 10.7554/elife.106554          # la carte proposée
   uv run scrapper zenodo valider 10.7554/elife.106554 --orcid 0000-0002-1825-0097 --nom "Carberry, Josiah"
   uv run scrapper zenodo deposer 10.7554/elife.106554 --essai  # la fiche, sans rien envoyer
   uv run scrapper zenodo deposer 10.7554/elife.106554          # le vrai envoi, sur le bac à sable
   ```
   La dernière commande rend un DOI `10.5072/zenodo.…` et l'adresse de la fiche, rangée dans la communauté.

   Cette validation d'essai reste dans ta base, marquée « essai ». Elle ne sort jamais dans les exports, et le vrai Zenodo l'ignore.

## Étape 5 : Cloudflare Pages, mettre le site en ligne (10 min)

**D'abord, une décision** : une fois déployé, le site est **public**. Il ne montre que le catalogue public :
- les liens vers les articles et leurs dépôts ;
- le texte des scripts sous licence libre ;
- aucun texte d'article.

1. Crée un compte gratuit sur https://dash.cloudflare.com, si tu n'en as pas.
2. Connecte-toi. Le navigateur s'ouvre ; clique sur **Allow**.
   ```bash
   cd /Volumes/Expansion/Scrapper/plateforme
   npx wrangler login
   ```
3. Crée le projet. Si le nom est pris, choisis-en un autre, et remplace `code-natif` dans le script `deployer` de `package.json`.
   ```bash
   npx wrangler pages project create code-natif --production-branch main
   ```
4. Mets le site en ligne :
   ```bash
   npm run deployer
   ```
   Le site est alors sur https://code-natif.pages.dev.
5. **Chaque nuit, automatiquement** : dans `~/.config/scrapper/reglages`, mets `SCRAPPER_CLOUDFLARE_PROJET=code-natif`.
   - À 4 h 17, après Hugging Face, le site est reconstruit avec le catalogue du jour et remis en ligne.
   - Wrangler garde et renouvelle lui-même sa connexion.
   - Pour tester tout de suite : `launchctl kickstart gui/$(id -u)/fr.scrapper.publier`.

Un nom de domaine serait le seul coût possible (~10 €/an). Il n'est pas nécessaire : l'adresse `.pages.dev` est gratuite.

## Étape 6 : sauvegarder le code (5 min)

Aujourd'hui, le code n'existe que sur le disque Expansion, sans aucun commit.

Le code est sur https://github.com/yannbellec/Open-Scientific-Code-Registry-OSCR- (dépôt
**public**). Il est envoyé par SSH, avec la clé du Mac.

- **Ce qui n'y entre jamais** : les données (`donnees/`), les sorties générées (`bibliotheque/`,
  `scripts/`, `site/`), l'environnement Python, les modules du site, les jetons.
- **L'identité des commits** est l'adresse « noreply » de GitHub, pas ton courriel.
- **Envoyer les changements suivants** :
  ```bash
  cd /Volumes/Expansion/Scrapper
  git add -A
  git commit -m "…"
  git push
  ```

**La base privée** (`donnees/bibliotheque.db`) n'est pas dans git. On peut la reconstruire, mais cela prend des semaines de ramassage. Copie-la de temps en temps ; cette commande est sûre même pendant que la veille écrit :

```bash
sqlite3 /Volumes/Expansion/Scrapper/donnees/bibliotheque.db ".backup '$HOME/bibliotheque-sauvegarde.db'"
```

## Au quotidien

Il n'y a rien à faire :
- la veille ramasse en continu : les nouveautés toutes les heures, le stock le reste du temps ;
- à 4 h 17, la publication envoie le catalogue sur Hugging Face, et sur le site si c'est réglé.

| pour | commande |
|---|---|
| voir où en est la veille | le haut de http://127.0.0.1:8790 (« stock : … en cours »), ou `tail -f ~/Library/Logs/scrapper/veille.log` |
| mettre la veille en pause | `launchctl bootout gui/$(id -u)/fr.scrapper.veille` |
| la reprendre | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/fr.scrapper.veille.plist` |
| publier tout de suite | `launchctl kickstart gui/$(id -u)/fr.scrapper.publier` |
| appliquer un réglage modifié | `/Volumes/Expansion/Scrapper/outils/installer_mac.sh` (les données restent) |
| tout retirer | `/Volumes/Expansion/Scrapper/outils/installer_mac.sh --retirer` (les données restent) |

Les réglages sont dans `~/.config/scrapper/reglages`.

| réglage | valeur | effet |
|---|---|---|
| `SCRAPPER_DOMAINE` | `neuro` | le périmètre des articles |
| `SCRAPPER_PRIORITE` | `fond` ou `normale` | discret ou ~3 fois plus rapide ; relancer l'installateur après changement |
| `SCRAPPER_HF_DATASET` | `opsecsystems/bibliotheque-code-natif` | le jeu Hugging Face (vide : pas d'envoi) |
| `SCRAPPER_CLOUDFLARE_PROJET` | vide ou `code-natif` | la mise en ligne du site chaque nuit |
| `SCRAPPER_ZENODO_INSTANCE` | `bac-a-sable` | `zenodo` seulement quand les vraies validations existeront |
| `SCRAPPER_ZENODO_COMMUNAUTE` | `code-natif-neurosciences` | la communauté des cartes |

## En cas de problème

| symptôme | cause probable | que faire |
|---|---|---|
| l'interface ne répond pas | le disque est débranché, ou la tâche est arrêtée | `launchctl list \| grep scrapper`, puis `tail ~/Library/Logs/scrapper/interface.log` |
| `78` dans `launchctl list` | un journal placé sur le disque externe | relancer l'installateur (il met les journaux dans `~/Library/Logs`) |
| `127` dans `launchctl list` | un script shell lancé par launchd sur le disque externe | relancer l'installateur (il lance Python directement) |
| `! Panne …` dans `veille.log` | un service en panne ou le réseau coupé | rien : elle réessaie seule, de 2 minutes à 1 heure |
| `Hugging Face : …` dans `publication.log` | un jeton absent ou expiré | refaire l'étape 3 |
| `Cloudflare : …` dans `publication.log` | la connexion de wrangler a expiré | `cd plateforme && npx wrangler login` |
| `Aucun jeton pour bac-a-sable` | le jeton Zenodo n'est pas au trousseau | refaire l'étape 4.3 |

## Ce qui n'existe pas encore

- **La validation par les auteurs** : un auteur se connecte avec son ORCID sur le site, revoit sa carte, la valide ou la corrige.
  - ORCID offre gratuitement la connexion (API publique ; l'inscription se fait sur orcid.org/developer-tools).
  - La validation passera par une Pages Function et D1 chez Cloudflare. Le Mac la relèvera et déposera la carte sur Zenodo.
  - **Sans elle, aucun vrai DOI n'est possible** : c'est voulu (CLAUDE.md).
- **La recherche** sur le site : D1 et son index plein texte.
- **L'alignement code ↔ article**, calculé sur le Mac : GROBID pour le texte, tree-sitter pour le code, un modèle local.

L'architecture et les limites gratuites sont décrites dans [ARCHITECTURE.md](ARCHITECTURE.md).
