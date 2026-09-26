"""Les cartes de traçage et leurs DOI Zenodo : les règles de CLAUDE.md, vérifiées
contre un faux serveur InvenioRDM."""
import json
import time

import httpx
import pytest

from scrapper import base, invenio, tableau


@pytest.fixture
def con(tmp_path):
    con = base.ouvrir(tmp_path / "b.db")
    con.execute("INSERT INTO article (id, doi, titre, revue, date_pub, auteurs, scanne_le, modifie_le) "
                "VALUES ('doi:10.1/art', '10.1/art', 'Un article', 'Une revue', '2026-09-01', "
                "'[\"Carberry\"]', 1, 1)")
    con.execute("INSERT INTO lien (article_id, norme, url, hote, genre, role, confiance, trouve_par, section, "
                "extrait) VALUES ('doi:10.1/art', 'github.com/lab/code', 'https://github.com/lab/code', "
                "'github.com', 'forge', 'code', 'haute', 'texte:disponibilite', 'Code availability', "
                "'Une phrase de l article.')")
    con.execute("INSERT INTO depot (norme, url, hote, genre, etat, licence, commit_) VALUES "
                "('github.com/lab/code', 'https://github.com/lab/code', 'github.com', 'forge', 'vivant', "
                "'MIT', 'abc123def4567890')")
    con.execute("INSERT INTO fichier (depot, chemin, version, langage, genre, taille, lignes, empreinte, texte) "
                "VALUES ('github.com/lab/code', 'analyse.py', 'abc123', 'Python', 'script', 12, 1, 'e1', "
                "'print(1)')")
    con.commit()
    return con


def test_la_cle_de_controle_orcid():
    assert invenio.orcid_valide("0000-0002-1825-0097")        # Josiah Carberry, le chercheur d'essai d'ORCID
    assert invenio.orcid_valide("0000-0002-1694-233X")        # une clé « X »
    assert not invenio.orcid_valide("0000-0002-1825-0098")
    assert not invenio.orcid_valide("2-1825-0097")


def test_la_carte_relie_l_article_a_son_code_sans_texte_ni_code(con):
    carte = invenio.carte_de(con, "doi:10.1/art")
    assert carte["article"]["doi"] == "10.1/art"
    (c,) = carte["code"]
    assert (c["depot"], c["commit"], c["licence"]) == ("github.com/lab/code", "abc123def4567890", "MIT")
    assert c["fichiers"] == [{"chemin": "analyse.py", "langage": "Python", "empreinte": "e1"}]
    brut = json.dumps(carte)
    assert "phrase" not in brut and "print(1)" not in brut   # ni l'article ni le code


def test_une_validation_exige_un_orcid_et_un_nom(con):
    with pytest.raises(invenio.ErreurInvenio, match="ORCID"):
        invenio.valider(con, "doi:10.1/art", orcid="0000-0000-0000-0000", nom="Carberry, Josiah", preuve="essai")
    with pytest.raises(invenio.ErreurInvenio, match="Nom, Prénom"):
        invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1825-0097", nom="Josiah Carberry", preuve="essai")


def test_la_fiche_zenodo_suit_les_regles(con):
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1825-0097", nom="Carberry, Josiah", preuve="essai")
    validations = con.execute("SELECT * FROM validation").fetchall()
    carte = json.loads(validations[0]["carte"])
    m = invenio.contenu_depot(carte, validations, plateforme="La plateforme")["metadata"]
    relations = {(r["relation_type"]["id"], r["identifier"]) for r in m["related_identifiers"]}
    assert relations == {("issupplementto", "10.1/art"),
                         ("references", "https://github.com/lab/code/tree/abc123def4567890")}
    auteur, plateforme = m["creators"]
    assert auteur["person_or_org"]["identifiers"] == [{"scheme": "orcid", "identifier": "0000-0002-1825-0097"}]
    assert auteur["person_or_org"]["family_name"] == "Carberry"
    assert plateforme["person_or_org"] == {"type": "organizational", "name": "La plateforme"}


def test_un_depot_zenodo_est_reference_par_son_doi():
    ref = invenio._reference({"depot": "zenodo:123", "url": "https://doi.org/10.5281/zenodo.123", "commit": ""})
    assert (ref["scheme"], ref["identifier"], ref["relation_type"]["id"]) == \
        ("doi", "10.5281/zenodo.123", "references")


class FauxZenodo:
    """Un InvenioRDM de poche : note chaque appel et rend ce qu'il faut."""

    def __init__(self):
        self.appels = []
        self.n = 0

    def __call__(self, req: httpx.Request) -> httpx.Response:
        chemin, m = req.url.path, req.method
        self.appels.append(f"{m} {chemin}")
        assert req.headers["authorization"] == "Bearer jeton-essai"
        if m == "POST" and chemin == "/api/records":
            corps = json.loads(req.content)
            assert [f["key"] for f in corps.get("files", {}).get("entries", [])] == []
            self.n += 1
            return httpx.Response(201, json={"id": f"r{self.n}"})
        if m == "POST" and chemin.endswith("/versions"):
            self.n += 1
            return httpx.Response(201, json={"id": f"r{self.n}"})
        if m == "PUT" and chemin.endswith("/draft"):
            return httpx.Response(200, json={"id": chemin.split("/")[3]})
        if m == "PUT" and chemin.endswith("/content"):
            carte = json.loads(req.content)
            assert carte["validee"]["orcid"] == "0000-0002-1825-0097"
            return httpx.Response(200, json={})
        if m == "GET" and chemin.startswith("/api/communities/"):
            return httpx.Response(200, json={"id": "uuid-communaute", "slug": "cartes"})
        if chemin.endswith("/submit-review"):
            return httpx.Response(200, json={"id": "demande-1"})
        if chemin.endswith("/actions/publish") or (m == "GET" and chemin.startswith("/api/records/")):
            rid = chemin.split("/")[3]
            return httpx.Response(202, json={"id": rid, "pids": {"doi": {"identifier": f"10.5072/zenodo.{rid}"}},
                                             "parent": {"pids": {"doi": {"identifier": "10.5072/zenodo.concept"}}},
                                             "links": {"self_html": f"https://sandbox.zenodo.org/records/{rid}"}})
        return httpx.Response(200, json={})


def _inv(faux):
    inv = invenio.Invenio("bac-a-sable", jeton_="jeton-essai", transport=httpx.MockTransport(faux))
    invenio.INTERVALLE_S = 0
    return inv


def test_pas_de_doi_sans_validation_d_auteur(con):
    faux = FauxZenodo()
    with pytest.raises(invenio.ErreurInvenio, match="non validée"):
        invenio.deposer_carte(con, _inv(faux), "doi:10.1/art", plateforme="P")
    assert faux.appels == []


def test_une_validation_d_essai_ne_va_pas_sur_le_vrai_zenodo(con):
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1825-0097", nom="Carberry, Josiah", preuve="essai")
    vrai = invenio.Invenio("zenodo", jeton_="jeton-essai", transport=httpx.MockTransport(FauxZenodo()))
    with pytest.raises(invenio.ErreurInvenio, match="ORCID"):
        invenio.deposer_carte(con, vrai, "doi:10.1/art", plateforme="P", essai=True)
    # La vraie validation d'un auteur, plus tard, passe malgré l'essai resté en base,
    # et l'essai n'apparaît pas parmi les créateurs.
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1694-233X", nom="Autrice, Une", preuve="orcid")
    r = invenio.deposer_carte(con, vrai, "doi:10.1/art", plateforme="P", essai=True)
    noms = [c["person_or_org"].get("family_name") for c in r["contenu"]["metadata"]["creators"]]
    assert noms == ["Autrice", None]


def test_la_carte_validee_recoit_son_doi_dans_la_communaute_puis_des_versions(con):
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1825-0097", nom="Carberry, Josiah", preuve="essai")
    faux = FauxZenodo()
    r = invenio.deposer_carte(con, _inv(faux), "doi:10.1/art", plateforme="P", communaute="cartes")
    assert r["doi"] == "10.5072/zenodo.r1"
    assert faux.appels == [
        "POST /api/records",
        "POST /api/records/r1/draft/files", "PUT /api/records/r1/draft/files/carte.json/content",
        "POST /api/records/r1/draft/files/carte.json/commit",
        "GET /api/communities/cartes",
        "PUT /api/records/r1/draft/review", "POST /api/records/r1/draft/actions/submit-review",
        "POST /api/requests/demande-1/actions/accept", "GET /api/records/r1",
    ]
    # Une carte corrigée : une nouvelle version, sous le même DOI de concept.
    faux.appels.clear()
    r = invenio.deposer_carte(con, _inv(faux), "doi:10.1/art", plateforme="P", communaute="cartes")
    assert faux.appels[0] == "POST /api/records/r1/versions" and faux.appels[-1].endswith("/actions/publish")
    assert r["doi_concept"] == "10.5072/zenodo.concept"


def test_les_essais_ne_sortent_pas_dans_la_base_publique(con, tmp_path):
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1825-0097", nom="Carberry, Josiah", preuve="essai")
    con.execute("INSERT INTO carte_zenodo VALUES ('doi:10.1/art', 'bac-a-sable', 'r1', '10.5072/x', '', ?)",
                (time.time(),))
    con.commit()
    tableau._base_publique(con, tmp_path / "pub.db")
    pub = base.ouvrir(tmp_path / "pub.db")
    assert pub.execute("SELECT count(*) FROM validation").fetchone()[0] == 0
    assert pub.execute("SELECT count(*) FROM carte_zenodo").fetchone()[0] == 0


def test_le_catalogue_ne_montre_que_les_cartes_validees_par_orcid(con):
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1825-0097", nom="Carberry, Josiah", preuve="essai")
    assert tableau.donnees(con)["articles"][0]["carte"] is None       # un essai ne se montre pas
    invenio.valider(con, "doi:10.1/art", orcid="0000-0002-1694-233X", nom="Autrice, Une", preuve="orcid")
    con.execute("INSERT INTO carte_zenodo VALUES ('doi:10.1/art', 'zenodo', '7', '10.5281/zenodo.7', "
                "'10.5281/zenodo.6', ?)", (time.time(),))
    carte = tableau.donnees(con)["articles"][0]["carte"]
    assert carte["doi"] == "10.5281/zenodo.7"
    assert carte["validee_par"] == [{"nom": "Autrice, Une", "orcid": "0000-0002-1694-233X"}]



def test_la_nuit_reconstruit_et_met_le_site_en_ligne(tmp_path, monkeypatch):
    from scrapper import publier
    (tmp_path / "node_modules").mkdir()
    appels = []

    def faux_run(etape, cwd, env, **kw):
        appels.append((etape[:3], env["CATALOGUE"]))
        import subprocess
        return subprocess.CompletedProcess(etape, 0, stdout="✨ Deployment complete! https://ab12.code-natif.pages.dev\n",
                                           stderr="")
    monkeypatch.setattr(publier.subprocess, "run", faux_run)
    r = publier.deployer_cloudflare(tmp_path / "pub", "code-natif", plateforme=tmp_path)
    assert r == "site en ligne : https://ab12.code-natif.pages.dev"
    assert [e for e, _ in appels] == [["npm", "run", "build"], ["npx", "wrangler", "pages"]]
    assert appels[0][1] == str((tmp_path / "pub").resolve())
