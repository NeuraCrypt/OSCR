"""Vérifier un dépôt : existe-t-il encore, que contient-il, sous quelle licence.

**Pourquoi git plutôt que l'API GitHub.** L'API anonyme accorde 60 requêtes à
l'heure : un passage de 200 articles l'épuise. Le protocole git, lui, n'a pas
ce plafond et parle à TOUTES les forges de la même façon — GitHub, GitLab,
Codeberg, G-Node GIN, Hugging Face. Deux commandes suffisent :

    git ls-remote <url> HEAD                         le dépôt existe ? son commit
    git clone --filter=blob:none --depth 1 --no-checkout
                                                     la liste des fichiers, sans
                                                     leur contenu (quelques Ko)

puis `git show HEAD:LICENSE` et `git show HEAD:README.md` ne rapatrient que ces
deux fichiers. Avec un jeton (`GITHUB_TOKEN`), l'API ajoute les étoiles et la
date de création — utiles pour reconnaître un outil public installé de longue
date.

**Les archives** (Zenodo, OSF, figshare) ont une API ouverte qui dit le TYPE de
la ressource — logiciel ou jeu de données —, ses fichiers et sa licence. C'est
elle qui tranche quand l'article dit seulement « available at Zenodo ».

**Ce qu'on ne garde pas.** Le clone est effacé après lecture. Le lien pourrit
(5,4 %/an en informatique biomédicale) : la parade durable est l'archive
Software Heritage, qu'on INTERROGE ici (lecture seule). Demander un archivage
(« Save Code Now ») est une action vers un service tiers : c'est une option,
jamais un défaut.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

from .liens import Lien
from .reseau import Client

#: Extensions de SCRIPT, et le langage qu'elles désignent. `.m` est MATLAB :
#: en neurosciences, l'Objective-C ne se rencontre pas.
SCRIPTS: dict[str, str] = {
    ".py": "Python", ".ipynb": "Jupyter", ".m": "MATLAB", ".mlx": "MATLAB",
    ".r": "R", ".rmd": "R", ".qmd": "Quarto", ".jl": "Julia", ".c": "C", ".cpp": "C++",
    ".cc": "C++", ".h": "C/C++", ".cu": "CUDA", ".f90": "Fortran", ".java": "Java",
    ".js": "JavaScript", ".ts": "TypeScript", ".sh": "Shell", ".bash": "Shell",
    ".do": "Stata", ".sas": "SAS", ".sps": "SPSS", ".nb": "Mathematica", ".wl": "Mathematica",
    ".hoc": "NEURON", ".mod": "NEURON", ".nest": "NEST", ".go": "Go", ".rs": "Rust",
    ".scala": "Scala", ".pl": "Perl", ".stan": "Stan", ".jags": "JAGS", ".bug": "BUGS",
}

#: Au-delà, on ne garde pas la liste complète des fichiers (dépôts de données).
MAX_FICHIERS_GARDES: int = 3000

DELAI_GIT_S: int = 120


# ─── licences ───────────────────────────────────────────────────────────────

_SIGNATURES: tuple[tuple[str, str], ...] = (
    (r"GNU AFFERO GENERAL PUBLIC LICENSE", "AGPL-3.0"),
    (r"GNU LESSER GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3", "LGPL-3.0"),
    (r"GNU LESSER GENERAL PUBLIC LICENSE|GNU LIBRARY GENERAL PUBLIC", "LGPL-2.1"),
    (r"GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3", "GPL-3.0"),
    (r"GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 2", "GPL-2.0"),
    (r"Apache License[\s\S]{0,100}Version 2\.0", "Apache-2.0"),
    (r"Mozilla Public License[\s\S]{0,50}2\.0", "MPL-2.0"),
    (r"Permission is hereby granted, free of charge", "MIT"),
    (r"Redistribution and use in source and binary forms[\s\S]*Neither the name", "BSD-3-Clause"),
    (r"Redistribution and use in source and binary forms", "BSD-2-Clause"),
    (r"Permission to use, copy, modify, and/?or distribute this software for any purpose", "ISC"),
    (r"This is free and unencumbered software released into the public domain", "Unlicense"),
    (r"CC0 1\.0|Creative Commons Zero|CC0-1\.0", "CC0-1.0"),
    (r"Attribution-NonCommercial-ShareAlike", "CC-BY-NC-SA-4.0"),
    (r"Attribution-NonCommercial-NoDerivatives|Attribution-NonCommercial-NoDerivs", "CC-BY-NC-ND-4.0"),
    (r"Attribution-NonCommercial", "CC-BY-NC-4.0"),
    (r"Attribution-ShareAlike 4\.0", "CC-BY-SA-4.0"),
    (r"Attribution 4\.0 International", "CC-BY-4.0"),
    (r"CeCILL", "CECILL-2.1"),
    (r"European Union Public Licen[cs]e|EUPL", "EUPL-1.2"),
    (r"Artistic License", "Artistic-2.0"),
    (r"Boost Software License", "BSL-1.0"),
)

#: Les licences qui permettent de redistribuer une copie, telle quelle.
_LIBRES = {"MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "Unlicense",
           "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "GPL-2.0", "GPL-3.0", "LGPL-2.1",
           "LGPL-3.0", "AGPL-3.0", "MPL-2.0", "CECILL-2.1", "EUPL-1.2", "Artistic-2.0",
           "BSL-1.0", "Zlib", "0BSD", "BSD-3-Clause-Clear", "Python-2.0"}
_CONDITIONS = {"CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0", "CC-BY-ND-4.0"}

#: Licences Zenodo/figshare/OSF → SPDX.
_ALIAS_LICENCE: dict[str, str] = {
    "mit": "MIT", "mit-license": "MIT", "bsd-3-clause": "BSD-3-Clause", "bsd-license": "BSD-3-Clause",
    "bsd-2-clause": "BSD-2-Clause", "apache-2.0": "Apache-2.0", "apache2.0": "Apache-2.0",
    "gpl-3.0": "GPL-3.0", "gpl-3.0-only": "GPL-3.0", "gpl-3.0-or-later": "GPL-3.0",
    "gpl-2.0": "GPL-2.0", "gpl-2.0-only": "GPL-2.0", "gpl-2.0-or-later": "GPL-2.0",
    "lgpl-3.0": "LGPL-3.0", "lgpl-2.1": "LGPL-2.1", "agpl-3.0": "AGPL-3.0",
    "mpl-2.0": "MPL-2.0", "cc-by-4.0": "CC-BY-4.0", "cc-by-sa-4.0": "CC-BY-SA-4.0",
    "cc0-1.0": "CC0-1.0", "cc-zero": "CC0-1.0", "cc-by-nc-4.0": "CC-BY-NC-4.0",
    "cc-by-nc-sa-4.0": "CC-BY-NC-SA-4.0", "cc-by-nc-nd-4.0": "CC-BY-NC-ND-4.0",
    "cc-by-nd-4.0": "CC-BY-ND-4.0", "unlicense": "Unlicense", "isc": "ISC",
    "cc by 4.0": "CC-BY-4.0", "cc0": "CC0-1.0", "cc0 1.0 universal": "CC0-1.0",
    "cc-by": "CC-BY-4.0", "cc by": "CC-BY-4.0", "no license": "", "other-open": "autre-ouverte",
}


def licence_de(texte: str) -> str:
    """Le SPDX d'un fichier LICENSE, reconnu à sa phrase signature."""
    for motif, spdx in _SIGNATURES:
        if re.search(motif, texte, re.I):
            return spdx
    return "autre" if texte.strip() else ""


def normaliser_licence(nom: str) -> str:
    n = (nom or "").strip()
    if not n:
        return ""
    return _ALIAS_LICENCE.get(n.lower(), _ALIAS_LICENCE.get(n.lower().replace(" ", "-"), n))


def redistribuable(spdx: str) -> str:
    """oui | sous_conditions | non | inconnu — pour décider d'un instantané."""
    if not spdx:
        return "non"          # pas de licence : tous droits réservés, lien seulement
    if spdx in _LIBRES or spdx == "autre-ouverte":
        return "oui"
    if spdx in _CONDITIONS:
        return "sous_conditions"
    return "inconnu"


# ─── quotas ─────────────────────────────────────────────────────────────────

#: Jusqu'à quand un service est mis de côté parce que son quota horaire est
#: épuisé. Software Heritage (120 req/h anonymes) et OSF (~100 req/h) se
#: vident vite sur une machine partagée de GitHub Actions ; attendre leur
#: remise à zéro bloquerait tout le passage. On s'en passe, et le dépôt sera
#: revérifié au passage suivant.
_EN_PAUSE: dict[str, float] = {}


def _en_pause(service: str) -> bool:
    return time.time() < _EN_PAUSE.get(service, 0.0)


def _quota_epuise(service: str, r: Any) -> bool:
    """Si la réponse dit « quota épuisé », mettre le service de côté jusqu'à sa
    remise à zéro (ou une heure)."""
    epuise = r.statut == 429 or (r.statut == 403 and r.entetes.get("x-ratelimit-remaining") == "0")
    if epuise:
        reset = r.entetes.get("x-ratelimit-reset", "")
        fin = float(reset) if reset.isdigit() and float(reset) > time.time() else time.time() + 3600
        _EN_PAUSE[service] = min(fin, time.time() + 3600)
    return epuise


# ─── git ────────────────────────────────────────────────────────────────────

def _auth_github() -> list[str]:
    """Avec un jeton (GitHub Actions en fournit un), les clones depuis github.com
    s'authentifient : les clones anonymes y sont limités plus durement depuis
    le 08/05/2025. Le jeton passe dans un en-tête, jamais dans l'URL ni dans
    les messages d'erreur."""
    jeton = os.environ.get("GITHUB_TOKEN", "").strip()
    if not jeton:
        return []
    import base64
    b64 = base64.b64encode(f"x-access-token:{jeton}".encode()).decode()
    return ["-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {b64}"]


def _git(args: list[str], cwd: Path | None = None, delai: int = DELAI_GIT_S) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="false", SSH_ASKPASS="false",
               GIT_LFS_SKIP_SMUDGE="1")
    # Aucun assistant d'identifiants, et une demande d'identifiants échoue sur
    # place : un dépôt introuvable ne doit ni ouvrir une invite du trousseau
    # macOS, ni envoyer d'identifiant factice au serveur.
    return subprocess.run(["git", "-c", "credential.helper=", "-c", "core.askPass=false",
                           *_auth_github(), *args],
                          cwd=cwd, env=env, capture_output=True, text=True, timeout=delai)


def _panne_reseau(stderr: str) -> bool:
    return bool(re.search(r"Could not resolve host|timed out|Connection (refused|reset)"
                          r"|Failed to connect|SSL|HTTP 5\d\d|The requested URL returned error: 5",
                          stderr, re.I))


def _extraire_scripts(d: Path, fichiers: list[str]) -> list[dict[str, Any]]:
    """Ne faire descendre QUE les scripts, le README et la licence du commit.

    Le clone est partiel (aucun contenu) ; `sparse-checkout` restreint la copie
    de travail à des motifs, et `checkout` ne rapatrie alors que ces fichiers,
    en un seul lot. Mesuré sur schmidtfa/cardiac_1_f : 53 scripts en 1,5 s,
    sans rien des données du dépôt.
    """
    from . import contenus
    voulus = [f for f in fichiers if contenus.est_script(f) or contenus.est_doc(f)]
    if not voulus:
        return []
    extensions = sorted({os.path.splitext(f)[1].lower() for f in voulus if contenus.est_script(f)})
    motifs = [f"*{e}" for e in extensions] + [f"*{e.upper()}" for e in extensions if e != e.upper()]
    motifs += [f"/{f}" for f in voulus if contenus.est_doc(f)]
    _git(["sparse-checkout", "set", "--no-cone", *motifs], cwd=d, delai=120)
    c = _git(["checkout", "-q", "HEAD"], cwd=d, delai=600)
    if c.returncode != 0:
        return [{"chemin": "…", "langage": "", "genre": "note", "taille": 0, "empreinte": "",
                 "texte": None, "tronque": 0, "lignes": None,
                 "note": "extraction impossible : " + c.stderr.strip()[:150]}]
    return contenus.depuis_dossier(d, voulus)


def verifier_git(lien: Lien, article: dict[str, Any] | None, dossier: Path,
                 client: Client | None = None, *, avec_contenus: bool = True) -> dict[str, Any]:
    url = lien.url_git
    fiche: dict[str, Any] = {"etat": "a_verifier"}
    try:
        r = _git(["ls-remote", "--symref", url, "HEAD"], delai=45)
    except subprocess.TimeoutExpired:
        return {"etat": "inaccessible", "erreur": "ls-remote : délai dépassé"}
    if r.returncode != 0:
        if _panne_reseau(r.stderr):
            return {"etat": "inaccessible", "erreur": r.stderr.strip()[:300]}
        # Introuvable, ou privé : la forge ne distingue pas, et nous non plus.
        return {"etat": "mort", "erreur": r.stderr.strip()[:300]}
    sha = next((l.split()[0] for l in r.stdout.splitlines() if l.endswith("\tHEAD")
                and not l.startswith("ref:")), "")
    fiche.update(etat="vivant", commit_=sha)
    if not sha:
        fiche.update(nb_fichiers=0, nb_scripts=0, erreur="dépôt vide")
        return fiche

    dossier.mkdir(parents=True, exist_ok=True)
    clone = Path(tempfile.mkdtemp(prefix="clone_", dir=dossier))
    try:
        c = _git(["clone", "--quiet", "--filter=blob:none", "--depth", "1", "--no-checkout",
                  url, str(clone / "d")])
        if c.returncode != 0:
            shutil.rmtree(clone, ignore_errors=True)
            clone.mkdir(parents=True, exist_ok=True)
            c = _git(["clone", "--quiet", "--depth", "1", "--no-checkout", url, str(clone / "d")],
                     delai=240)
        if c.returncode != 0:
            fiche["erreur"] = "clone : " + c.stderr.strip()[:250]
            return fiche
        d = clone / "d"
        fichiers = [f for f in _git(["ls-tree", "-r", "--name-only", "HEAD"], cwd=d).stdout.splitlines() if f]
        fiche.update(_inventaire(fichiers))
        fiche["date_commit"] = _git(["log", "-1", "--format=%cI"], cwd=d).stdout.strip()
        racine = [f for f in fichiers if "/" not in f]
        lic = next((f for f in racine if re.match(r"(?i)^(licen[cs]e|copying|copyright)(\.\w+)?$", f)), "")
        if lic:
            texte = _git(["show", f"HEAD:{lic}"], cwd=d, delai=60).stdout
            fiche["licence"] = licence_de(texte)
        else:
            fiche["licence"] = ""
        readme = next((f for f in racine if re.match(r"(?i)^readme(\.\w+)?$", f)), "")
        if readme and article:
            texte = _git(["show", f"HEAD:{readme}"], cwd=d, delai=60).stdout
            fiche["cite_article"] = cite_article(texte, article)
            if not fiche.get("licence"):
                m = re.search(r"(?i)licen[cs]e[^\n]{0,80}\b(MIT|BSD|Apache|GPL|GNU|CC[- ]BY|CC0)", texte)
                if m:
                    fiche["licence"] = normaliser_licence(m.group(1)) or m.group(1)
        if avec_contenus:
            fiche["_contenus"] = _extraire_scripts(d, fichiers)
    except subprocess.TimeoutExpired:
        fiche["erreur"] = "clone : délai dépassé"
    finally:
        shutil.rmtree(clone, ignore_errors=True)
    fiche["redistribuable"] = redistribuable(fiche.get("licence", ""))
    if client is not None and lien.hote == "github.com" and os.environ.get("GITHUB_TOKEN"):
        fiche.update(_api_github(client, lien))
    return fiche


_ARCHIVES = (".zip", ".tar", ".tar.gz", ".tgz", ".7z", ".rar", ".gz", ".bz2", ".xz")


def _inventaire(fichiers: list[str]) -> dict[str, Any]:
    """Compter les scripts. Deux cas où le compte ne dit pas la vérité :

    - un ZIP sans aucun script à côté (`vignetteAnalysis.zip` sur OSF) : le
      code est peut-être dedans, on ne sait pas — `nb_scripts` vaut `None` ;
    - un jeu BIDS (`dataset_description.json`, dossiers `sub-XX`) : ses
      quelques scripts de conversion n'en font pas un dépôt de code
      (`nemardatasets/on007524` : 3 scripts sur 2 141 fichiers).
    """
    langages: Counter[str] = Counter()
    scripts = []
    for f in fichiers:
        ext = os.path.splitext(f)[1].lower()
        if ext in SCRIPTS:
            langages[SCRIPTS[ext]] += 1
            scripts.append(f)
    compresses = sum(f.lower().endswith(_ARCHIVES) for f in fichiers)
    fiche: dict[str, Any] = {
        "nb_fichiers": len(fichiers),
        "nb_scripts": None if (not scripts and compresses) else len(scripts),
        "langages": dict(langages.most_common()),
        "fichiers": fichiers[:MAX_FICHIERS_GARDES]}
    if "dataset_description.json" in fichiers or sum(f.startswith("sub-") for f in fichiers) >= 3:
        fiche["type_ressource"] = "bids"
    return fiche


def cite_article(readme: str, article: dict[str, Any]) -> str:
    """Le README cite-t-il l'article ? `doi`, `titre`, ou rien."""
    doi = (article.get("doi") or "").lower()
    bas = readme.lower()
    if doi and doi in bas:
        return "doi"
    titre = article.get("titre") or ""
    mots = {m for m in re.findall(r"[a-z]{5,}", titre.lower())}
    if len(mots) >= 4 and len(mots & set(re.findall(r"[a-z]{5,}", bas))) / len(mots) >= 0.75:
        return "titre"
    return ""


def _api_github(client: Client, lien: Lien) -> dict[str, Any]:
    r = client.get(f"https://api.github.com/repos/{lien.proprietaire}/{lien.depot}", ttl_s=7 * 86400)
    if not r.ok:
        return {}
    d = r.json()
    extra = {"etoiles": d.get("stargazers_count"), "cree_le": (d.get("created_at") or "")[:10]}
    spdx = ((d.get("license") or {}).get("spdx_id") or "")
    if spdx and spdx != "NOASSERTION":
        extra["licence"] = spdx
        extra["redistribuable"] = redistribuable(spdx)
    return extra


# ─── archives : Zenodo, OSF, figshare ──────────────────────────────────────

#: Un zip dont le nom dit du code (« SmartERD-v1.0.0.zip », « …-main.zip »,
#: « analysis_code.zip ») : téléchargé même dans une archive de données.
_ZIP_DE_CODE = re.compile(r"code|script|src|analys|software|toolbox|pipeline|-main\b|-master\b"
                          r"|v?\d+\.\d+(\.\d+)?\.zip$", re.I)
MAX_SCRIPT_DISTANT: int = 5_000_000


def _contenus_distants(client: Client, fichiers: list[tuple[str, str, int | None]],
                       type_ressource: str) -> list[dict[str, Any]]:
    """Télécharger les scripts d'une archive, et ses zips de code.

    `fichiers` : (nom, url de téléchargement, taille). Un zip n'est ouvert que
    si l'archive se dit « software », si son nom dit du code, ou s'il est seul :
    une archive de données de plusieurs Go n'a rien à nous apprendre.
    """
    from . import contenus
    sortie: list[dict[str, Any]] = []
    zips = [f for f in fichiers if f[0].lower().endswith(".zip")]
    budget = contenus.MAX_ARCHIVE * 2
    for nom, url, taille in fichiers:
        if not url or budget <= 0:
            continue
        bas = nom.lower()
        if contenus.est_script(nom) or contenus.est_doc(nom):
            if taille and taille > MAX_SCRIPT_DISTANT:
                continue
            b = client.telecharger(url, MAX_SCRIPT_DISTANT)
            if b is not None:
                budget -= len(b)
                sortie.append(contenus.lire(nom, b))
        elif bas.endswith(".zip") and (not taille or taille <= contenus.MAX_ARCHIVE) and (
                type_ressource == "software" or _ZIP_DE_CODE.search(nom) or len(zips) == 1):
            lu = _zip_distant(client, url)
            if lu is None:
                continue
            extraits, taille_lue = lu
            budget -= taille_lue
            for f in extraits:
                if len(zips) > 1 and f["chemin"] != "…":
                    f["chemin"] = f"{nom}/{f['chemin']}"
                sortie.append(f)
    return sortie


def _zip_distant(client: Client, url: str) -> tuple[list[dict[str, Any]], int] | None:
    """Les scripts d'une archive distante, lue par le disque et non par la
    mémoire. Rend (fichiers, taille de l'archive), ou None si rien n'est arrivé."""
    from . import contenus
    archive = client.telecharger_archive(url, contenus.MAX_ARCHIVE)
    if archive is None:
        return None
    with archive:
        taille = archive.seek(0, 2)
        archive.seek(0)
        return (contenus.depuis_zip(archive), taille) if taille else None


def verifier_zenodo(client: Client, lien: Lien, *, avec_contenus: bool = True) -> dict[str, Any]:
    r = client.get(f"https://zenodo.org/api/records/{lien.identifiant}", ttl_s=7 * 86400)
    if r.statut == 404:
        r = client.get(f"https://zenodo.org/api/records/{lien.identifiant}/versions/latest",
                       ttl_s=7 * 86400)
    if r.statut in (404, 410):
        return {"etat": "mort", "statut_http": r.statut}
    if not r.ok:
        return {"etat": "inaccessible", "statut_http": r.statut}
    d = r.json() or {}
    m = d.get("metadata", {})
    fichiers = d.get("files") or []
    if isinstance(fichiers, dict):
        fichiers = list((fichiers.get("entries") or {}).values())
    noms = [f.get("key") or f.get("filename") or "" for f in fichiers]
    lic = m.get("license") or {}
    spdx = normaliser_licence(lic.get("id", "") if isinstance(lic, dict) else str(lic))
    lie = next((ri.get("identifier", "") for ri in m.get("related_identifiers", [])
                if re.search(r"github\.com|gitlab\.com", str(ri.get("identifier", "")), re.I)), "")
    fiche = {"etat": "vivant", "statut_http": r.statut,
             "type_ressource": (m.get("resource_type") or {}).get("type", ""),
             "licence": spdx, "redistribuable": redistribuable(spdx),
             "cree_le": (d.get("created") or "")[:10], "lie_a": lie}
    fiche.update(_inventaire(noms))
    # Une archive GitHub publiée par l'intégration Zenodo est UN zip du dépôt.
    if fiche["nb_scripts"] == 0 and any(n.lower().endswith((".zip", ".tar.gz")) for n in noms) \
            and fiche["type_ressource"] == "software":
        fiche["nb_scripts"] = None
    if avec_contenus:
        fiche["_contenus"] = _contenus_distants(
            client, [(f.get("key") or f.get("filename") or "", (f.get("links") or {}).get("self", ""),
                      f.get("size")) for f in fichiers], fiche["type_ressource"])
    return fiche


def verifier_osf(client: Client, lien: Lien, *, avec_contenus: bool = True) -> dict[str, Any]:
    if _en_pause("osf"):
        return {"etat": "inaccessible", "erreur": "quota OSF atteint : revérification au prochain passage"}
    vol = parse_qs(urlsplit(lien.url).query).get("view_only", [""])[0]
    p = {"view_only": vol} if vol else None
    r = client.get(f"https://api.osf.io/v2/guids/{lien.identifiant}/", params=p, ttl_s=7 * 86400,
                   patience=False)
    if _quota_epuise("osf", r):
        return {"etat": "inaccessible", "erreur": "quota OSF atteint : revérification au prochain passage"}
    if r.statut in (404, 410):
        return {"etat": "mort", "statut_http": r.statut}
    if r.statut in (401, 403):
        return {"etat": "inaccessible", "statut_http": r.statut, "erreur": "projet privé"}
    if not r.ok:
        return {"etat": "inaccessible", "statut_http": r.statut}
    d = (r.json() or {}).get("data", {})
    typ = d.get("type", "")
    att = d.get("attributes", {})
    fiche: dict[str, Any] = {"etat": "vivant", "statut_http": r.statut,
                             "type_ressource": f"osf-{att.get('category') or typ}",
                             "cree_le": (att.get("date_created") or "")[:10]}
    if typ == "files":
        fiche.update(_inventaire([att.get("name", "")]))
        return fiche
    if typ not in ("nodes", "registrations"):
        return fiche
    # Un projet OSF range ses fichiers chez plusieurs FOURNISSEURS (osfstorage,
    # un GitHub ou un Drive branchés) et souvent dans des COMPOSANTS enfants :
    # osf:a5m7q ne montrait aucun fichier à la racine de son osfstorage.
    noms: list[str] = []
    telechargeables: list[tuple[str, str, int | None]] = []
    budget = [12]

    def lister(url: str, prefixe: str = "") -> None:
        a_voir = [url]
        while a_voir and budget[0] > 0:
            u = a_voir.pop(0)
            budget[0] -= 1
            rr = client.get(u, params=dict(p or {}, **{"page[size]": "100"}), ttl_s=7 * 86400)
            if not rr.ok:
                return
            for f in (rr.json() or {}).get("data", []):
                a = f.get("attributes", {})
                suite = ((f.get("relationships", {}).get("files", {})
                          .get("links", {}).get("related", {})).get("href"))
                if a.get("kind") == "folder" or f.get("type") == "files" and a.get("provider") and not a.get("kind"):
                    if suite:
                        a_voir.append(suite)
                elif a.get("kind") == "file":
                    nom = prefixe + a.get("materialized_path", a.get("name", "")).strip("/")
                    noms.append(nom)
                    telechargeables.append((nom, (f.get("links") or {}).get("download", ""),
                                            a.get("size")))

    lister(f"https://api.osf.io/v2/{typ}/{lien.identifiant}/files/")
    if not noms and budget[0] > 0:
        rr = client.get(f"https://api.osf.io/v2/{typ}/{lien.identifiant}/children/", params=p,
                        ttl_s=7 * 86400)
        for enfant in ((rr.json() or {}).get("data", []) if rr.ok else [])[:4]:
            lister(f"https://api.osf.io/v2/nodes/{enfant['id']}/files/", f"{enfant['id']}/")
    fiche.update(_inventaire(noms))
    if avec_contenus:
        if vol:
            telechargeables = [(n, u + ("&" if "?" in u else "?") + f"view_only={vol}", t)
                               for n, u, t in telechargeables if u]
        fiche["_contenus"] = _contenus_distants(client, telechargeables, fiche["type_ressource"])
    return fiche


def verifier_figshare(client: Client, lien: Lien, *, avec_contenus: bool = True) -> dict[str, Any]:
    r = client.get(f"https://api.figshare.com/v2/articles/{lien.identifiant}", ttl_s=7 * 86400)
    if r.statut in (404, 410):
        return {"etat": "mort", "statut_http": r.statut}
    if not r.ok:
        return {"etat": "inaccessible", "statut_http": r.statut}
    d = r.json() or {}
    spdx = normaliser_licence((d.get("license") or {}).get("name", ""))
    fiche = {"etat": "vivant", "statut_http": r.statut,
             "type_ressource": d.get("defined_type_name", ""),
             "licence": spdx, "redistribuable": redistribuable(spdx),
             "cree_le": (d.get("created_date") or "")[:10]}
    fiche.update(_inventaire([f.get("name", "") for f in d.get("files", [])]))
    if avec_contenus:
        fiche["_contenus"] = _contenus_distants(
            client, [(f.get("name", ""), f.get("download_url", ""), f.get("size"))
                     for f in d.get("files", [])], fiche["type_ressource"])
    return fiche


def verifier_supplementaire(client: Client, lien: Lien, *, avec_contenus: bool = True
                            ) -> dict[str, Any]:
    """Un fichier joint à l'article (« Source code 1 » d'eLife).

    Le seau PMC Open Access sur AWS sert chaque fichier joint sans compte :
    `pmc-oa-opendata.s3.amazonaws.com/PMC<id>.<version>/<fichier>` (vérifié le
    25/09/2026 sur PMC11563573.1/elife-98759-code1.zip).
    """
    from . import contenus
    m = re.match(r"supp:(PMC\d+)/(.+)$", lien.norme, re.I)
    if not m:
        return {"etat": "non_verifiable", "erreur": "fichier joint sans PMCID"}
    pmcid, nom = m.group(1).upper(), m.group(2)
    for version in (1, 2, 3):
        url = f"https://pmc-oa-opendata.s3.amazonaws.com/{pmcid}.{version}/{quote(nom)}"
        r = client.get(url, methode="HEAD")
        if r.statut == 200:
            break
    else:
        return {"etat": "non_verifiable", "erreur": "absent du seau PMC Open Access"}
    fiche: dict[str, Any] = {"etat": "vivant", "statut_http": 200, "type_ressource": "fichier joint"}
    fiche.update(_inventaire([nom]))
    if avec_contenus:
        if nom.lower().endswith(".zip"):
            lu = _zip_distant(client, url)
            fiche["_contenus"] = lu[0] if lu else []
            if lu:
                fiche.update(_inventaire([f["chemin"] for f in fiche["_contenus"] if f["chemin"] != "…"]))
        elif contenus.est_script(nom):
            b = client.telecharger(url, MAX_SCRIPT_DISTANT)
            fiche["_contenus"] = [contenus.lire(nom, b)] if b else []
    return fiche


def verifier_dryad(client: Client, lien: Lien) -> dict[str, Any]:
    """Un DOI Dryad : il répond ? et quel logiciel Zenodo l'accompagne ?

    Dryad dépose le CODE d'un jeu de données dans un enregistrement Zenodo de
    type « software » qui se déclare `isSourceOf` du DOI Dryad (vérifié le
    25/09/2026 : zenodo:14946966 → 10.5061/dryad.v41ns1s70, un zip
    « Llano-Lab-Analysis-Program-main »). On le retrouve par une recherche
    Zenodo sur le DOI, et on le rattache comme source.
    """
    fiche = verifier_http(client, f"https://doi.org/{lien.identifiant}")
    r = client.get("https://zenodo.org/api/records", params={
        "q": f'related.identifier:"{lien.identifiant}" AND resource_type.type:software',
        "size": "5"}, ttl_s=7 * 86400)
    if r.ok:
        hits = ((r.json() or {}).get("hits") or {}).get("hits") or []
        if hits:
            fiche["lie_a"] = f"https://zenodo.org/records/{hits[0]['id']}"
            fiche["type_ressource"] = "dryad+logiciel"
    return fiche


def verifier_http(client: Client, url: str) -> dict[str, Any]:
    """Le lien répond-il ? HEAD, puis un GET borné si le serveur refuse HEAD."""
    r = client.get(url, methode="HEAD")
    if r.statut in (400, 403, 405, 501) or r.statut == 0:
        r = client.get(url, entetes={"Range": "bytes=0-2048"})
    if r.statut in (200, 206) or 300 <= r.statut < 400:
        return {"etat": "vivant", "statut_http": r.statut}
    if r.statut in (404, 410):
        return {"etat": "mort", "statut_http": r.statut}
    return {"etat": "inaccessible", "statut_http": r.statut, "erreur": r.texte[:200]}


def archive_swh(client: Client, url_origine: str) -> int | None:
    """1 si Software Heritage a archivé cette origine, 0 sinon, None si on ne sait pas."""
    if _en_pause("swh"):
        return None
    r = client.get(f"https://archive.softwareheritage.org/api/1/origin/{quote(url_origine, safe=':/')}/get/",
                   ttl_s=30 * 86400, patience=False)
    if _quota_epuise("swh", r):
        return None
    if r.ok:
        return 1
    if r.statut == 404:
        return 0
    return None


def verifier(client: Client, lien: Lien, article: dict[str, Any] | None, dossier_clones: Path,
             *, swh: bool = True, avec_contenus: bool = True) -> dict[str, Any]:
    """Aiguiller vers la bonne vérification selon l'hôte. Avec `avec_contenus`,
    la fiche porte aussi `_contenus` : le texte des scripts, pour la table
    `fichier`."""
    if lien.est_depot_git:
        fiche = verifier_git(lien, article, dossier_clones, client, avec_contenus=avec_contenus)
        if swh and fiche.get("etat") in ("vivant", "mort"):
            fiche["archive_swh"] = archive_swh(client, lien.url_git)
        return fiche
    if lien.norme.startswith("zenodo:"):
        return verifier_zenodo(client, lien, avec_contenus=avec_contenus)
    if lien.norme.startswith("osf:"):
        return verifier_osf(client, lien, avec_contenus=avec_contenus)
    if lien.norme.startswith("figshare:") and lien.identifiant.isdigit():
        return verifier_figshare(client, lien, avec_contenus=avec_contenus)
    if lien.genre == "supplementaire":
        return verifier_supplementaire(client, lien, avec_contenus=avec_contenus)
    if lien.norme.startswith("codeocean:"):
        # Code Ocean renvoie 403 à tout robot, robots.txt compris (vérifié le
        # 25/09/2026) : on ne peut ni confirmer ni infirmer. Le dire.
        return {"etat": "non_verifiable", "erreur": "Code Ocean refuse les robots (403)"}
    if lien.norme.startswith("swh:"):
        return {"etat": "vivant", "archive_swh": 1}
    if lien.norme.startswith("doi:10.5061/dryad"):
        return verifier_dryad(client, lien)
    if lien.norme.startswith("doi:"):
        return verifier_http(client, f"https://doi.org/{lien.identifiant}")
    return verifier_http(client, lien.url)
