"""Publier la bibliothèque sur un jeu de données Hugging Face.

**Ce qui part.** Trois tables que la visionneuse de Hugging Face affiche et
interroge en SQL — `articles.csv`, `depots.csv`, `scripts.jsonl` (un script par
ligne, avec son texte) —, la base `bibliotheque_publique.db` et, si on le
donne, le miroir des scripts en fichiers. Une fiche `README.md` déclare les
trois tables à la visionneuse.

**En clair, pas compressé.** Hugging Face (xet) découpe les fichiers en
morceaux et n'envoie que ceux qu'il n'a pas déjà. Le 26/09/2026, 53 Mo publiés
n'ont fait partir que ~8 Mo, en 13 minutes, sur une ligne montante de
~25 Ko/s. Un fichier compressé changerait en entier à chaque ajout, et
repartirait en entier chaque nuit.

**Ce qui ne part pas.** Le texte d'un script dont la licence n'autorise pas la
republication : `scripts.jsonl` vient du tableau en mode `--public`, qui l'a
déjà retiré. Ni le plein texte des articles, ni les phrases qui ont fait juger
un lien.

**Le jeton.** `HF_TOKEN` s'il est défini (sur GitHub Actions, un secret du
dépôt), sinon celui que `huggingface_hub` garde à son emplacement standard
(`~/.cache/huggingface/token`, lisible par son seul propriétaire). Jamais dans
le dépôt ni dans un fichier de configuration. `--essai` prépare le dossier et
dit ce qui partirait, sans rien envoyer.

**Privé par défaut.** Un jeu créé par ce module l'est en PRIVÉ : le rendre
public est une décision, prise sur la page du jeu le jour où un site le lira.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

#: Le site public (Astro), à côté du paquet.
PLATEFORME = Path(__file__).resolve().parents[1] / "plateforme"

CARTE = """---
license: other
pretty_name: Bibliothèque du code natif — neurosciences
tags:
- neuroscience
- code
- reproducibility
configs:
- config_name: scripts
  data_files: scripts.jsonl
- config_name: articles
  data_files: articles.csv
- config_name: depots
  data_files: depots.csv
---

# Bibliothèque du code natif — neurosciences

Le code publié par les auteurs d'articles de neurosciences, trouvé dans le texte
des articles et dans leurs métadonnées, puis vérifié à la source.

- `articles` : un article par ligne, son statut (code vérifié, sur demande, aucun…).
- `depots` : chaque dépôt de code des auteurs, sa licence, son commit, ses scripts.
- `scripts` : le texte de chaque script, **seulement** quand la licence du dépôt
  en permet la republication. Chaque ligne porte sa licence et un lien vers le
  fichier à la source, au commit vérifié : **la source fait foi**.
- `bibliotheque_publique.db` : la base SQLite complète, sans les phrases des
  articles ni le texte des dépôts sans licence — pour un site ou un service.

Mis à jour le {date}. Produit par le ramasseur `scrapper`.
"""


def preparer(site: Path, miroir: Path | None) -> Path:
    """Le dossier tel qu'il partira."""
    d = Path(tempfile.mkdtemp(prefix="hf_"))
    for nom in ("articles.csv", "depots.csv", "scripts.jsonl", "bibliotheque_publique.db"):
        if (site / nom).exists():
            shutil.copy2(site / nom, d / nom)
    if miroir is not None and miroir.exists():
        shutil.copytree(miroir, d / "scripts")
    (d / "README.md").write_text(CARTE.replace("{date}", time.strftime("%d/%m/%Y", time.gmtime())))
    return d


def publier(site: Path, depot_hf: str, *, miroir: Path | None = None, essai: bool = False,
            prive: bool = True) -> str:
    # Un tableau généré SANS --public porte le texte des scripts sans licence :
    # il ne part pas.
    etat = site / "donnees.json"
    if not etat.exists() or not json.loads(etat.read_text()).get("public"):
        raise SystemExit(f"{site} n'a pas été généré en mode public : "
                         f"`scrapper --public --site {site} tableau` d'abord.")
    dossier = preparer(site, miroir)
    fichiers = sorted(str(p.relative_to(dossier)) for p in dossier.rglob("*") if p.is_file())
    taille = sum((dossier / f).stat().st_size for f in fichiers)
    resume = f"{len(fichiers)} fichiers, {taille / 1e6:.1f} Mo → huggingface.co/datasets/{depot_hf}"
    if essai:
        return f"(essai, rien n'est envoyé) {resume} — dossier préparé : {dossier}"
    try:
        from huggingface_hub import HfApi, get_token
    except ImportError as e:
        raise SystemExit("huggingface_hub manque : uv sync") from e
    jeton = os.environ.get("HF_TOKEN", "").strip() or get_token()
    if not jeton:
        raise SystemExit("Aucun jeton Hugging Face : `hf auth login`, ou HF_TOKEN "
                         "(secret GitHub sur Actions).")
    api = HfApi(token=jeton)
    api.create_repo(depot_hf, repo_type="dataset", private=prive, exist_ok=True)
    api.upload_folder(folder_path=str(dossier), repo_id=depot_hf, repo_type="dataset",
                      commit_message=f"Passage du {time.strftime('%Y-%m-%d', time.gmtime())}",
                      delete_patterns=["scripts/**"] if miroir is not None else None)
    shutil.rmtree(dossier, ignore_errors=True)
    return resume


def deployer_cloudflare(catalogue: Path, projet: str, plateforme: Path = PLATEFORME) -> str:
    """Reconstruire le site depuis le catalogue de sortie (`catalogue`, en mode
    public) et l'envoyer sur Cloudflare Pages, en envoi direct : ni dépôt git ni
    construction chez Cloudflare. Il faut avoir fait `npx wrangler login` une
    fois dans `plateforme/` ; wrangler garde et renouvelle lui-même sa connexion."""
    env = {**os.environ, "CATALOGUE": str(catalogue.resolve())}
    etapes = [] if (plateforme / "node_modules").exists() else [["npm", "install", "--no-audit", "--no-fund"]]
    etapes += [["npm", "run", "build"],
               ["npx", "wrangler", "pages", "deploy", "dist", "--project-name", projet,
                "--branch", "main", "--commit-dirty=true"]]
    sortie = ""
    for etape in etapes:
        r = subprocess.run(etape, cwd=plateforme, env=env, capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            raise RuntimeError(f"{' '.join(etape[:4])} a échoué : " + (r.stderr or r.stdout).strip()[-600:])
        sortie = r.stdout
    url = re.search(r"https://[\w.-]+\.pages\.dev\S*", sortie)
    return f"site en ligne : {url.group(0) if url else projet}"
