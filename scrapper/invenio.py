"""Zenodo (InvenioRDM) : les DOI des CARTES DE TRAÇAGE validées par un auteur.

Zenodo tourne sur InvenioRDM, hébergé gratuitement par le CERN. Son bac à
sable (sandbox.zenodo.org) a la même API, des DOI factices, et sert à TOUT le
développement : c'est l'instance par défaut ici, la vraie se demande
explicitement (`--instance zenodo`).

**Les règles** (voir CLAUDE.md) :
- un DOI seulement pour une carte de traçage VALIDÉE PAR UN AUTEUR, jamais pour
  une fiche générée automatiquement ;
- le DOI porte sur la carte (liens + métadonnées), pas sur le code : le code
  des auteurs n'est jamais redéposé, la carte le RÉFÉRENCE ;
- relations : `IsSupplementTo` → DOI de l'article, `References` → dépôt du code ;
- créateurs : l'auteur qui valide, avec son ORCID, et la plateforme ;
- les cartes sont réunies dans une communauté Zenodo ;
- aucun service payant.

**La carte** (`carte.json`) dit, pour un article : où est son code (dépôt,
commit, licence), ce qu'on y a trouvé (les fichiers, leur empreinte) et comment
on l'a trouvé. Elle ne contient ni le texte de l'article ni le code. Sa version
0.1 ne relie que l'article à ses dépôts ; l'alignement passage ↔ fichier ou
fonction viendra s'y ajouter.

**La validation** vient de l'auteur. Sur la plateforme, il se connectera avec
son ORCID (preuve `orcid`). En développement, `scrapper zenodo valider` enregistre
une validation d'ESSAI, que la vraie instance refuse.

**Le jeton** vient de `ZENODO_SANDBOX_TOKEN` (ou `ZENODO_TOKEN`) s'il est
défini, sinon du trousseau macOS (service `fr.scrapper.zenodo-bac-a-sable` ou
`fr.scrapper.zenodo`). Jamais d'un fichier du dépôt ni des réglages.
"""
from __future__ import annotations

import html
import json
import os
import re
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx

from .reseau import AGENT

INSTANCES: dict[str, str] = {
    "bac-a-sable": "https://sandbox.zenodo.org",
    "zenodo": "https://zenodo.org",
}
#: Le format natif d'InvenioRDM ; sans lui, Zenodo rend son ancien format.
NATIF = {"Accept": "application/vnd.inveniordm.v1+json"}
#: Zenodo accepte 60 requêtes/minute d'un invité, davantage avec un jeton.
INTERVALLE_S = 1.1
FORMAT_CARTE = "carte-de-tracage/0.1"
#: Preuves de validation : `orcid` (l'auteur s'est connecté avec son ORCID sur
#: la plateforme) ; `essai` (développement, bac à sable seulement).
PREUVES = ("orcid", "essai")

AIDE_JETON = ("Aucun jeton pour {instance}. Crée-le sur {base}/account/settings/applications/tokens/new/ "
              "(cocher deposit:write et deposit:actions), "
              "puis range-le dans le trousseau sans le coller nulle part :\n"
              "  security add-generic-password -s {service} -a \"$USER\" -w")


class ErreurInvenio(RuntimeError):
    pass


def service_trousseau(instance: str) -> str:
    return "fr.scrapper.zenodo" + ("-bac-a-sable" if instance == "bac-a-sable" else "")


def jeton(instance: str) -> str:
    """Le jeton de `instance`, ou "" s'il n'y en a pas."""
    variable = "ZENODO_SANDBOX_TOKEN" if instance == "bac-a-sable" else "ZENODO_TOKEN"
    if os.environ.get(variable, "").strip():
        return os.environ[variable].strip()
    try:
        r = subprocess.run(["security", "find-generic-password", "-s", service_trousseau(instance), "-w"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def orcid_valide(orcid: str) -> bool:
    """Un ORCID bien formé, clé de contrôle comprise (ISO 7064 MOD 11-2)."""
    if not re.fullmatch(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", orcid or ""):
        return False
    chiffres = orcid.replace("-", "")
    total = 0
    for c in chiffres[:-1]:
        total = (total + int(c)) * 2
    cle = (12 - total % 11) % 11
    return chiffres[-1] == ("X" if cle == 10 else str(cle))


class Invenio:
    """Un client de l'API REST d'InvenioRDM, poli (un peu plus d'une seconde
    entre deux requêtes), dans le format natif."""

    def __init__(self, instance: str = "bac-a-sable", *, jeton_: str = "",
                 transport: httpx.BaseTransport | None = None) -> None:
        if instance not in INSTANCES:
            raise ErreurInvenio(f"instance inconnue : {instance} ({', '.join(INSTANCES)})")
        self.instance = instance
        self.base = INSTANCES[instance]
        entetes = {"User-Agent": AGENT, **NATIF}
        if jeton_:
            entetes["Authorization"] = f"Bearer {jeton_}"
        self.ecrit = bool(jeton_)
        self._http = httpx.Client(base_url=self.base, headers=entetes, timeout=120,
                                  follow_redirects=True, transport=transport)
        self._dernier = 0.0

    def fermer(self) -> None:
        self._http.close()

    def _requete(self, methode: str, chemin: str, **kw: Any) -> httpx.Response:
        attente = self._dernier + INTERVALLE_S - time.monotonic()
        if attente > 0:
            time.sleep(attente)
        self._dernier = time.monotonic()
        r = self._http.request(methode, chemin, **kw)
        if r.status_code >= 400:
            try:
                d = r.json()
                detail = str(d.get("message", "")) + "".join(
                    f" | {e.get('field')}: {' '.join(map(str, e.get('messages', [])))}"
                    for e in d.get("errors", []) if isinstance(e, dict))
            except ValueError:
                detail = r.text[:200]
            raise ErreurInvenio(f"{methode} {chemin} : HTTP {r.status_code} — {detail}")
        return r

    def _json(self, methode: str, chemin: str, **kw: Any) -> dict[str, Any]:
        r = self._requete(methode, chemin, **kw)
        return r.json() if r.content else {}

    def _exiger_jeton(self) -> None:
        if not self.ecrit:
            raise ErreurInvenio(AIDE_JETON.format(instance=self.instance, base=self.base,
                                                  service=service_trousseau(self.instance)))

    # ── lire (sans jeton) ────────────────────────────────────────────────

    def fiches(self, q: str = "", *, communaute: str | None = None) -> Iterator[dict[str, Any]]:
        """Toutes les fiches d'une recherche, ou d'une communauté, page après page."""
        chemin = f"/api/communities/{communaute}/records" if communaute else "/api/records"
        # Zenodo : 25 fiches par page sans jeton, 100 avec.
        taille = 100 if self.ecrit else 25
        page = 1
        while True:
            d = self._json("GET", chemin, params={"q": q, "size": taille, "page": page, "sort": "newest"})
            hits = d.get("hits", {}).get("hits", [])
            yield from hits
            total = d.get("hits", {}).get("total", 0)
            # L'index d'InvenioRDM ne pagine pas au-delà de 10 000 résultats.
            if not hits or page * taille >= min(total, 10_000):
                return
            page += 1

    def liees_a(self, doi: str) -> list[dict[str, Any]]:
        """Les fiches qui se déclarent liées à ce DOI : le logiciel qu'un auteur
        a déjà archivé pour son article, par exemple, que la carte référencera."""
        return list(self.fiches(f'metadata.related_identifiers.identifier:"{doi}"'))

    def communaute(self, slug: str) -> dict[str, Any] | None:
        try:
            return self._json("GET", f"/api/communities/{slug}")
        except ErreurInvenio as e:
            if "HTTP 404" in str(e):
                return None
            raise

    # ── écrire (jeton) ───────────────────────────────────────────────────

    def creer_communaute(self, slug: str, titre: str, description: str) -> dict[str, Any]:
        self._exiger_jeton()
        return self._json("POST", "/api/communities", json={
            "slug": slug,
            "access": {"visibility": "public", "member_policy": "closed", "record_policy": "closed"},
            "metadata": {"title": titre, "description": description, "type": {"id": "project"}}})

    def brouillon(self, contenu: dict[str, Any]) -> dict[str, Any]:
        self._exiger_jeton()
        return self._json("POST", "/api/records", json=contenu)

    def nouvelle_version(self, recid: str, contenu: dict[str, Any]) -> dict[str, Any]:
        """Le brouillon d'une nouvelle version de `recid` (même DOI de concept),
        sans fichiers, avec le contenu du jour."""
        self._exiger_jeton()
        d = self._json("POST", f"/api/records/{recid}/versions")
        return {**d, **self._json("PUT", f"/api/records/{d['id']}/draft", json=contenu)}

    def deposer(self, recid: str, nom: str, octets: bytes) -> None:
        self._json("POST", f"/api/records/{recid}/draft/files", json=[{"key": nom}])
        self._requete("PUT", f"/api/records/{recid}/draft/files/{nom}/content", content=octets,
                      headers={"Content-Type": "application/octet-stream"})
        self._json("POST", f"/api/records/{recid}/draft/files/{nom}/commit")

    def publier(self, recid: str) -> dict[str, Any]:
        return self._json("POST", f"/api/records/{recid}/draft/actions/publish")

    def publier_dans(self, recid: str, communaute_id: str, message: str) -> dict[str, Any]:
        """Publier un brouillon DANS une communauté : la demande d'inclusion,
        puis son acceptation (le jeton est celui de la plateforme, propriétaire
        de la communauté). Rend la fiche publiée."""
        self._json("PUT", f"/api/records/{recid}/draft/review",
                   json={"receiver": {"community": communaute_id}, "type": "community-submission"})
        demande = self._json("POST", f"/api/records/{recid}/draft/actions/submit-review",
                             json={"payload": {"content": message, "format": "html"}})
        self._json("POST", f"/api/requests/{demande['id']}/actions/accept",
                   json={"payload": {"content": "Carte validée par son auteur.", "format": "html"}})
        return self._json("GET", f"/api/records/{recid}")


# ── la carte ─────────────────────────────────────────────────────────────

def carte_de(con: sqlite3.Connection, article_id: str) -> dict[str, Any]:
    """La carte de traçage d'un article, telle que le ramasseur la PROPOSE."""
    a = con.execute("SELECT * FROM article WHERE id = ?", (article_id,)).fetchone()
    if a is None:
        raise ErreurInvenio(f"article inconnu : {article_id}")
    code = []
    for l in con.execute(
            "SELECT l.norme, l.url, l.trouve_par, l.section, d.etat, d.licence, d.commit_, d.date_commit, "
            "d.type_ressource, d.archive_swh FROM lien l LEFT JOIN depot d ON d.norme = l.norme "
            "WHERE l.article_id = ? AND l.role = 'code' ORDER BY l.norme", (article_id,)):
        niveau = con.execute("SELECT niveau FROM script WHERE article_id = ? AND norme = ? AND origine = 'natif'",
                             (article_id, l["norme"])).fetchone()
        fichiers = [{"chemin": f["chemin"], "langage": f["langage"], "empreinte": f["empreinte"]}
                    for f in con.execute("SELECT chemin, langage, empreinte FROM fichier WHERE depot = ? "
                                         "AND genre = 'script' ORDER BY chemin", (l["norme"],))]
        code.append({
            "depot": l["norme"], "url": l["url"], "etat": l["etat"] or "a_verifier",
            "licence": l["licence"] or "", "commit": l["commit_"] or "", "date_commit": l["date_commit"] or "",
            "type": l["type_ressource"] or "", "archive_software_heritage": bool(l["archive_swh"]),
            "niveau": niveau["niveau"] if niveau else "trouve",
            "trouve_par": l["trouve_par"], "section": l["section"],
            "fichiers": fichiers,
        })
    return {
        "format": FORMAT_CARTE,
        "article": {"doi": a["doi"], "titre": a["titre"], "revue": a["revue"], "date": a["date_pub"],
                    "auteurs": json.loads(a["auteurs"] or "[]")},
        "code": code,
        # L'alignement passage de l'article ↔ fichier ou fonction : à venir.
        "alignements": [],
        "proposee": {"par": "scrapper", "le": time.strftime("%Y-%m-%d")},
    }


def valider(con: sqlite3.Connection, article_id: str, *, orcid: str, nom: str, preuve: str,
            carte: dict[str, Any] | None = None) -> dict[str, Any]:
    """Enregistrer la validation d'une carte par un de ses auteurs. La carte
    gardée est celle que l'auteur a VUE (et corrigée, le cas échéant) : c'est
    elle, et non l'état de la base au moment du dépôt, qui recevra un DOI."""
    if preuve not in PREUVES:
        raise ErreurInvenio(f"preuve inconnue : {preuve}")
    if not orcid_valide(orcid):
        raise ErreurInvenio(f"ORCID invalide : {orcid}")
    if "," not in nom:
        raise ErreurInvenio("le nom s'écrit « Nom, Prénom »")
    carte = carte or carte_de(con, article_id)
    if not carte["code"]:
        raise ErreurInvenio("carte sans aucun dépôt de code : rien à valider")
    carte = {**carte, "validee": {"par": nom, "orcid": orcid, "le": time.strftime("%Y-%m-%d"), "preuve": preuve}}
    con.execute("INSERT OR REPLACE INTO validation (article_id, orcid, nom, preuve, valide_le, carte) "
                "VALUES (?,?,?,?,?,?)", (article_id, orcid, nom, preuve, time.time(),
                                         json.dumps(carte, ensure_ascii=False)))
    con.commit()
    return carte


def _reference(c: dict[str, Any]) -> dict[str, Any]:
    """`References` → le dépôt du code : son DOI s'il en a un, son adresse
    au commit validé sinon."""
    if c["depot"].startswith("zenodo:"):
        return {"identifier": f"10.5281/zenodo.{c['depot'].split(':', 1)[1]}", "scheme": "doi",
                "relation_type": {"id": "references"}, "resource_type": {"id": "software"}}
    if c["depot"].startswith("doi:"):
        return {"identifier": c["depot"][4:], "scheme": "doi",
                "relation_type": {"id": "references"}, "resource_type": {"id": "software"}}
    url = c["url"]
    if c["commit"] and re.match(r"https://(github\.com|gitlab\.com|codeberg\.org)/[^/]+/[^/]+/?$", url):
        url = url.rstrip("/") + f"/tree/{c['commit']}"
    return {"identifier": url, "scheme": "url",
            "relation_type": {"id": "references"}, "resource_type": {"id": "software"}}


def _createur(nom: str, orcid: str) -> dict[str, Any]:
    famille, _, prenom = (x.strip() for x in nom.partition(","))
    return {"person_or_org": {"type": "personal", "family_name": famille, "given_name": prenom,
                              "identifiers": [{"scheme": "orcid", "identifier": orcid}]}}


def contenu_depot(carte: dict[str, Any], validations: list[sqlite3.Row], *,
                  plateforme: str) -> dict[str, Any]:
    """La fiche Zenodo de la carte (format InvenioRDM)."""
    art = carte["article"]
    date = time.strftime("%Y-%m-%d")
    depots = "".join(f"<li><a href=\"{html.escape(c['url'])}\">{html.escape(c['depot'])}</a>"
                     f"{' @ ' + html.escape(c['commit'][:12]) if c['commit'] else ''}"
                     f"{' — ' + html.escape(c['licence']) if c['licence'] else ''}</li>" for c in carte["code"])
    description = (
        f"<p>Code tracing map for the article <em>{html.escape(art['titre'])}</em> "
        f"(doi:{html.escape(art['doi'])}), validated by its author.</p>"
        f"<p>The map links the article to the code its authors published:</p><ul>{depots}</ul>"
        "<p>This record holds the map only (<code>carte.json</code>: links and metadata). "
        "The code itself is not redeposited: it stays in the repositories referenced above.</p>")
    return {
        "access": {"record": "public", "files": "public"},
        "files": {"enabled": True},
        "metadata": {
            "resource_type": {"id": "dataset"},
            "title": f"Code tracing map: {art['titre']}"[:250],
            "publication_date": date,
            "version": f"{FORMAT_CARTE.split('/')[1]}-{date}",
            "creators": [_createur(v["nom"], v["orcid"]) for v in validations]
                        + [{"person_or_org": {"type": "organizational", "name": plateforme}}],
            "description": description,
            "publisher": "Zenodo",
            "rights": [{"id": "cc0-1.0"}],
            "subjects": [{"subject": s} for s in ("code tracing map", "research software",
                                                   "reproducibility", "neuroscience")],
            "related_identifiers": (
                [{"identifier": art["doi"], "scheme": "doi", "relation_type": {"id": "issupplementto"},
                  "resource_type": {"id": "publication-article"}}]
                + [_reference(c) for c in carte["code"]]),
        },
    }


def deposer_carte(con: sqlite3.Connection, inv: Invenio, article_id: str, *, plateforme: str,
                  communaute: str = "", essai: bool = False,
                  rapport: Callable[[str], None] = print) -> dict[str, Any]:
    """Donner un DOI à la carte VALIDÉE d'un article : une fiche neuve la
    première fois, une nouvelle version (même DOI de concept) ensuite."""
    validations = con.execute("SELECT * FROM validation WHERE article_id = ? ORDER BY valide_le",
                              (article_id,)).fetchall()
    if inv.instance != "bac-a-sable":
        # Le vrai Zenodo ne voit que les validations d'auteurs connectés par
        # ORCID : un essai fait dans le bac à sable sur le même article ne
        # compte pas, et ne bloque pas non plus la vraie validation.
        validations = [v for v in validations if v["preuve"] == "orcid"]
    if not validations:
        raise ErreurInvenio("carte non validée par un auteur (ORCID) : pas de DOI (règle du projet)")
    carte = json.loads(validations[-1]["carte"])
    contenu = contenu_depot(carte, validations, plateforme=plateforme)
    octets = json.dumps(carte, ensure_ascii=False, indent=1).encode()
    deja = con.execute("SELECT * FROM carte_zenodo WHERE article_id = ? AND instance = ?",
                       (article_id, inv.instance)).fetchone()
    rapport(f"{'nouvelle version de ' + deja['recid'] if deja else 'fiche neuve'} sur {inv.base} : "
            f"carte.json ({len(octets)} octets), {len(contenu['metadata']['related_identifiers'])} relations")
    if essai:
        return {"essai": True, "contenu": contenu, "carte": carte}
    inv._exiger_jeton()
    brouillon = inv.nouvelle_version(deja["recid"], contenu) if deja else inv.brouillon(contenu)
    inv.deposer(brouillon["id"], "carte.json", octets)
    if communaute and not deja:
        c = inv.communaute(communaute)
        if c is None:
            raise ErreurInvenio(f"communauté introuvable sur {inv.base} : {communaute}")
        publiee = inv.publier_dans(brouillon["id"], c["id"], f"Carte de traçage de doi:{carte['article']['doi']}")
    else:
        # Une nouvelle version reste dans la communauté de la première.
        publiee = inv.publier(brouillon["id"])
    pids = publiee.get("pids") or {}
    doi = (pids.get("doi") or {}).get("identifier", "")
    concept = (((publiee.get("parent") or {}).get("pids") or {}).get("doi") or {}).get("identifier", "")
    con.execute("INSERT OR REPLACE INTO carte_zenodo (article_id, instance, recid, doi, doi_concept, depose_le) "
                "VALUES (?,?,?,?,?,?)", (article_id, inv.instance, str(publiee["id"]), doi, concept, time.time()))
    con.commit()
    return {"id": publiee["id"], "doi": doi, "doi_concept": concept,
            "url": (publiee.get("links") or {}).get("self_html", "")}
