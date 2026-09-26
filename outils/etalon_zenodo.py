"""Mesurer le RAPPEL du ramasseur sur un étalon qu'il n'a pas construit.

**L'étalon.** Des logiciels déposés sur Zenodo qui déclarent EUX-MÊMES se
rattacher à un article (`related_identifiers`), dans des revues de
neurosciences. Pour ces articles on sait que du code existe, sans avoir lu
l'article : c'est une vérité indépendante du ramasseur.

**Le piège.** Un logiciel qui « isCitedBy » un article peut être un outil que
l'article CITE (MNE, un paquet de statistiques), pas le code de ses auteurs.
On ne garde comme code NATIF que les logiciels dont un créateur Zenodo est
aussi auteur de l'article ; le reste est compté à part.

Deux temps :

    uv run python outils/etalon_zenodo.py construire   # → donnees/etalon_zenodo.json + dois
    uv run scrapper --base donnees/etalon.db --site donnees/site_etalon \
        --biblio donnees/biblio_etalon doi --fichier donnees/etalon_dois.txt
    uv run python outils/etalon_zenodo.py mesurer donnees/etalon.db
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

from scrapper.reseau import Cache, Client

RACINE = Path(__file__).resolve().parents[1]
ETALON = RACINE / "donnees" / "etalon_zenodo.json"
DOIS = RACINE / "donnees" / "etalon_dois.txt"

#: Préfixes DOI de revues de neurosciences (et eLife, en bonne part neuro).
PREFIXES: tuple[str, ...] = (
    r"10.7554", r"10.1523", r"10.1016\/j.neuroimage", r"10.1162\/imag", r"10.1162\/netn",
    r"10.1093\/cercor", r"10.1038\/s41593", r"10.1016\/j.neuron", r"10.1371\/journal.pcbi",
    r"10.1002\/hbm", r"10.1111\/ejn",
)
#: Zenodo refuse (HTTP 400) plus de 25 résultats par page aux invités.
PAR_PAGE: int = 25
PAGES: int = 2


def _plat(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower())
                   if c.isalpha() and not unicodedata.combining(c))


def construire(client: Client) -> None:
    etalon: dict[str, dict] = {}
    for p in PREFIXES:
        clair = p.replace("\\", "")
        n, total, recs = 0, 0, []
        for page in range(1, PAGES + 1):
            r = client.get("https://zenodo.org/api/records", params={
                "q": f"resource_type.type:software AND related.identifier:{p}*",
                "size": str(PAR_PAGE), "page": str(page), "sort": "mostrecent"}, ttl_s=7 * 86400)
            if not r.ok:
                print(f"  {clair} : HTTP {r.statut}")
                break
            hits = (r.json() or {}).get("hits", {})
            total = hits.get("total")
            recs += hits.get("hits", [])
            if len(hits.get("hits", [])) < PAR_PAGE:
                break
        for rec in recs:
            m = rec.get("metadata", {})
            createurs = [c.get("name", "").split(",")[0].strip() for c in m.get("creators", [])]
            source = next((x["identifier"] for x in m.get("related_identifiers", [])
                           if re.search(r"github\.com|gitlab\.com", x.get("identifier", ""))), "")
            for x in m.get("related_identifiers", []):
                ident = x.get("identifier", "").lower()
                ident = re.sub(r"^https?://(dx\.)?doi\.org/", "", ident)
                if not ident.startswith(clair.lower()):
                    continue
                # eLife versionne ses DOI d'articles relus : …eLife.93063.3 → …eLife.93063
                ident = re.sub(r"^(10\.7554/elife\.\d+)\.\d+$", r"\1", ident)
                e = etalon.setdefault(ident, {"doi": ident, "logiciels": []})
                e["logiciels"].append({"zenodo": str(rec["id"]), "relation": x.get("relation", ""),
                                       "createurs": createurs, "source": source,
                                       "titre": m.get("title", "")[:120]})
                n += 1
        print(f"  {clair} : {total} logiciels au total, {n} liens gardés")
    ETALON.write_text(json.dumps(list(etalon.values()), ensure_ascii=False, indent=1))
    DOIS.write_text("\n".join(etalon) + "\n")
    print(f"{len(etalon)} articles → {DOIS}")


def _concept(client: Client, ident: str) -> str:
    """Un logiciel Zenodo a une version par publication et un identifiant de
    CONCEPT commun : 11389725 et 11389726 sont le même logiciel. On compare
    les concepts, pas les versions."""
    r = client.get(f"https://zenodo.org/api/records/{ident}", ttl_s=30 * 86400)
    if not r.ok:
        return ident
    return str((r.json() or {}).get("conceptrecid") or ident)


AVEC_DATACITE = True


def mesurer(base: Path) -> None:
    etalon = json.loads(ETALON.read_text())
    client = Client(Cache(RACINE / "donnees" / "cache"))
    con = sqlite3.connect(base)
    con.row_factory = sqlite3.Row
    lignes = {"natif": [], "cite": []}
    for e in etalon:
        a = con.execute("SELECT * FROM article WHERE doi = ?", (e["doi"],)).fetchone()
        if a is None:
            continue
        # Europe PMC écrit « Witteveen O », « Thanh Hoang Nhat L » : tous les
        # mots sauf les initiales finales.
        auteurs = {_plat(t) for n in json.loads(a["auteurs"]) if n
                   for t in (n.split()[:-1] or n.split()) if len(t) > 1}
        tous = {r["norme"]: r for r in con.execute(
            "SELECT l.norme, l.trouve_par, d.lie_a FROM lien l LEFT JOIN depot d ON d.norme = l.norme "
            "WHERE l.article_id = ? AND l.role = 'code'", (a["id"],))}
        # DataCite lit les MÊMES relations Zenodo que celles qui ont fait
        # l'étalon : ce qu'il trouve est à moitié circulaire. On mesure aussi
        # sans lui.
        code = tous if AVEC_DATACITE else {n: r for n, r in tous.items()
                                          if not r["trouve_par"].startswith("datacite")}
        for n in list(code):
            if n.startswith("zenodo:"):
                code[f"zenodo-concept:{_concept(client, n.split(':', 1)[1])}"] = code[n]
        for lg in e["logiciels"]:
            # Zenodo écrit « Nom, Prénom » OU « Prénom Nom » : chaque mot compte
            # (« Olivier Witteveen » manquait « Witteveen O » — 73 paires mal rangées).
            createurs = {_plat(t) for c in lg["createurs"] for t in re.split(r"[\s,.]+", c)
                         if len(t) > 1}
            propre = bool(auteurs & createurs)
            cibles = {f"zenodo:{lg['zenodo']}", f"zenodo-concept:{_concept(client, lg['zenodo'])}"}
            if lg["source"]:
                m = re.search(r"github\.com/([^/]+)/([^/#?]+)", lg["source"])
                if m:
                    cibles.add(f"github.com/{m.group(1).lower()}/{m.group(2).lower().removesuffix('.git')}")
            meme = bool(cibles & set(code)) or any(
                (r["lie_a"] or "").lower().find(c.split(":", 1)[-1]) >= 0 for r in code.values()
                for c in cibles if c.startswith("github.com"))
            lignes["natif" if propre else "cite"].append({
                "doi": e["doi"], "statut": a["statut"], "plein_texte": a["plein_texte"],
                "un_code": bool(code), "meme_depot": meme, "relation": lg["relation"],
                "zenodo": lg["zenodo"]})
    for genre, ls in lignes.items():
        if not ls:
            continue
        n = len(ls)
        un = sum(l["un_code"] for l in ls)
        meme = sum(l["meme_depot"] for l in ls)
        texte = [l for l in ls if l["plein_texte"]]
        print(f"\n{genre.upper()} ({'créateur Zenodo = auteur' if genre == 'natif' else 'aucun créateur commun'})"
              f" : {n} paires article↔logiciel")
        print(f"  l'article reçoit au moins un code des auteurs : {un}/{n} ({100 * un / n:.0f} %)")
        print(f"  le ramasseur retrouve CE dépôt (Zenodo ou sa source GitHub) : {meme}/{n} ({100 * meme / n:.0f} %)")
        if texte:
            tm = sum(l["meme_depot"] for l in texte)
            print(f"  … parmi les {len(texte)} articles au plein texte lisible : {tm} ({100 * tm / len(texte):.0f} %)")
        rates = [l for l in ls if not l["meme_depot"]][:12]
        for l in rates:
            print(f"    raté : {l['doi']} zenodo:{l['zenodo']} ({l['relation']}) statut={l['statut']} "
                  f"texte={l['plein_texte']}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["construire"]:
        construire(Client(Cache(RACINE / "donnees" / "cache")))
    elif sys.argv[1:2] == ["mesurer"]:
        base = Path(sys.argv[2]) if len(sys.argv) > 2 else RACINE / "donnees" / "bibliotheque.db"
        print("== toutes les voies")
        mesurer(base)
        AVEC_DATACITE = False
        print("\n== sans DataCite (le texte, Crossref, les fiches d'archives)")
        mesurer(base)
    else:
        print(__doc__)
