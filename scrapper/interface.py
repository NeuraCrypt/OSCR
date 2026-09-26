"""L'interface : le tableau de la base, et rien d'autre.

Un petit serveur, bibliothèque standard seulement, qui LIT la base en direct —
pas besoin de régénérer quoi que ce soit : ce que le passage de la nuit a
écrit est là au rechargement. Il n'écoute que sur 127.0.0.1 (la machine
elle-même) et n'offre aucune écriture.

    GET /                         la page
    GET /api/etat                 les comptes
    GET /api/articles?q=&tous=&offset=&n=
    GET /api/scripts?article=     les fichiers des dépôts d'un article (sans texte)
    GET /api/fichier?depot=&chemin=   le texte d'un fichier

Sur la machine de l'utilisateur, tout le texte des scripts est lisible, licence
ou non : c'est sa base privée. Ce qui se PUBLIE (site, Hugging Face) suit la
règle des licences de `tableau.py`.
"""
from __future__ import annotations

import json
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .tableau import url_fichier

PAGE = Path(__file__).parent / "interface.html"
STATUTS_CODE = ("code_verifie", "code_trouve", "code_vide", "code_mort")
PAR_PAGE_MAX = 500


def _lecture(base: Path) -> sqlite3.Connection:
    """Une connexion en LECTURE SEULE : le passage de la nuit peut écrire en même temps."""
    con = sqlite3.connect(f"file:{base}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def etat(con: sqlite3.Connection) -> dict[str, Any]:
    q = lambda sql: con.execute(sql).fetchone()[0]  # noqa: E731
    return {
        "articles": q("SELECT COUNT(*) FROM article WHERE scanne_le IS NOT NULL"),
        "avec_code": q("SELECT COUNT(*) FROM article WHERE statut IN ('code_verifie','code_trouve',"
                       "'code_vide','code_mort')"),
        "depots": q("SELECT COUNT(DISTINCT norme) FROM lien WHERE role = 'code'"),
        "scripts": q("SELECT COUNT(*) FROM fichier WHERE genre = 'script'"),
        "maj": q("SELECT MAX(scanne_le) FROM article"),
        # Où en est la remontée du stock : le mois en cours, par domaine.
        "stock": {r[0].split(":", 1)[1]: r[1] for r in con.execute(
            "SELECT source, valeur FROM curseur WHERE source LIKE 'rattrapage:%'")},
    }


def articles(con: sqlite3.Connection, recherche: str, tous: bool, offset: int, n: int) -> dict[str, Any]:
    conditions, params = ["a.scanne_le IS NOT NULL"], []
    if not tous:
        conditions.append(f"a.statut IN ({','.join('?' * len(STATUTS_CODE))})")
        params += STATUTS_CODE
    if recherche:
        motif = f"%{recherche}%"
        conditions.append("(a.titre LIKE ? OR a.doi LIKE ? OR a.revue LIKE ? OR EXISTS "
                          "(SELECT 1 FROM lien l WHERE l.article_id = a.id AND l.role = 'code' "
                          "AND l.norme LIKE ?))")
        params += [motif] * 4
    where = " AND ".join(conditions)
    total = con.execute(f"SELECT COUNT(*) FROM article a WHERE {where}", params).fetchone()[0]
    lignes = []
    for a in con.execute(f"SELECT a.id, a.doi, a.titre, a.revue, a.date_pub, a.statut FROM article a "
                         f"WHERE {where} ORDER BY a.date_pub DESC, a.id LIMIT ? OFFSET ?",
                         [*params, n, offset]):
        code = [dict(r) for r in con.execute(
            "SELECT l.norme, l.url, d.etat, d.licence, "
            "(SELECT COUNT(*) FROM fichier f WHERE f.depot = l.norme AND f.genre != 'note') AS n "
            "FROM lien l LEFT JOIN depot d ON d.norme = l.norme "
            "WHERE l.article_id = ? AND l.role = 'code' ORDER BY l.norme", (a["id"],))]
        for c in code:
            if not c["url"].startswith("http"):
                c["url"] = (f"https://doi.org/{c['norme'][4:]}" if c["norme"].startswith("doi:")
                            else url_fichier({"norme": c["norme"], "url": c["url"]}, ""))
        lignes.append({"id": a["id"], "doi": a["doi"], "titre": a["titre"], "revue": a["revue"],
                       "date": a["date_pub"], "statut": a["statut"], "code": code})
    return {"total": total, "lignes": lignes}


def scripts(con: sqlite3.Connection, article_id: str) -> dict[str, Any]:
    depots = []
    for d in con.execute("SELECT d.* FROM lien l JOIN depot d ON d.norme = l.norme "
                         "WHERE l.article_id = ? AND l.role = 'code' ORDER BY d.norme", (article_id,)):
        fichiers = [{"c": f["chemin"], "l": f["langage"], "n": f["lignes"], "g": f["genre"],
                     "lisible": bool(f["texte"]), "note": f["note"],
                     "src": url_fichier(d, f["chemin"]) if f["genre"] != "note" else ""}
                    for f in con.execute("SELECT chemin, langage, lignes, genre, note, "
                                         "texte IS NOT NULL AS texte FROM fichier WHERE depot = ? "
                                         "ORDER BY genre DESC, chemin", (d["norme"],))]
        depots.append({"depot": d["norme"], "url": d["url"], "licence": d["licence"],
                       "version": d["commit_"], "fichiers": fichiers})
    return {"depots": depots}


def fichier(con: sqlite3.Connection, depot: str, chemin: str) -> dict[str, Any] | None:
    f = con.execute("SELECT * FROM fichier WHERE depot = ? AND chemin = ?", (depot, chemin)).fetchone()
    d = con.execute("SELECT * FROM depot WHERE norme = ?", (depot,)).fetchone()
    if f is None or d is None:
        return None
    return {"c": f["chemin"], "l": f["langage"], "n": f["lignes"], "texte": f["texte"],
            "note": f["note"], "x": f["tronque"], "src": url_fichier(d, f["chemin"])}


def gestionnaire(base: Path) -> type[BaseHTTPRequestHandler]:
    class Gestionnaire(BaseHTTPRequestHandler):
        server_version = "scrapper"

        def log_message(self, *args: Any) -> None:  # le terminal reste propre
            return

        def _envoyer(self, statut: int, corps: bytes, type_: str) -> None:
            self.send_response(statut)
            self.send_header("Content-Type", type_)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(corps)

        def _json(self, donnees: Any, statut: int = 200) -> None:
            self._envoyer(statut, json.dumps(donnees, ensure_ascii=False).encode(),
                          "application/json; charset=utf-8")

        def do_GET(self) -> None:  # noqa: N802
            u = urlsplit(self.path)
            p = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path in ("/", "/index.html"):
                self._envoyer(200, PAGE.read_bytes(), "text/html; charset=utf-8")
                return
            if not base.exists():
                self._json({"erreur": "la base n'existe pas encore : lancez un premier passage"}, 503)
                return
            try:
                con = _lecture(base)
            except sqlite3.Error as e:
                self._json({"erreur": str(e)}, 503)
                return
            try:
                if u.path == "/api/etat":
                    self._json(etat(con))
                elif u.path == "/api/articles":
                    n = max(1, min(PAR_PAGE_MAX, int(p.get("n", "100") or 100)))
                    self._json(articles(con, p.get("q", "").strip(), p.get("tous") == "1",
                                        max(0, int(p.get("offset", "0") or 0)), n))
                elif u.path == "/api/scripts":
                    self._json(scripts(con, p.get("article", "")))
                elif u.path == "/api/fichier":
                    f = fichier(con, p.get("depot", ""), p.get("chemin", ""))
                    self._json(f if f else {"erreur": "fichier inconnu"}, 200 if f else 404)
                else:
                    self._json({"erreur": "introuvable"}, 404)
            except (sqlite3.Error, ValueError) as e:
                self._json({"erreur": str(e)}, 500)
            finally:
                con.close()

    return Gestionnaire


def servir(base: Path, port: int = 8790, hote: str = "127.0.0.1") -> None:
    serveur = ThreadingHTTPServer((hote, port), gestionnaire(base))
    print(f"Interface : http://{hote}:{port}  (base : {base}) — Ctrl+C pour arrêter", flush=True)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        serveur.server_close()
