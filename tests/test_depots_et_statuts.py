"""La vérification et la conclusion, sans réseau : une base temporaire, des fiches
de dépôt écrites à la main, et les règles qui en tirent le statut."""
import json

import pytest

from scrapper import base, depots, liens, tourner, trouver


def test_les_licences():
    assert depots.licence_de("Permission is hereby granted, free of charge, to any person") == "MIT"
    assert depots.licence_de("Redistribution and use in source and binary forms ... Neither the name") \
        == "BSD-3-Clause"
    assert depots.licence_de("GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007") == "GPL-3.0"
    assert depots.licence_de("Attribution-NonCommercial-ShareAlike 4.0 International") == "CC-BY-NC-SA-4.0"
    assert depots.redistribuable("MIT") == "oui"
    assert depots.redistribuable("CC-BY-NC-SA-4.0") == "sous_conditions"
    assert depots.redistribuable("") == "non"


def test_un_zip_seul_rend_le_compte_de_scripts_inconnu():
    f = depots._inventaire(["vignetteAnalysis.zip"])
    assert f["nb_scripts"] is None


def test_un_jeu_bids_est_reconnu():
    fichiers = ["dataset_description.json", "participants.tsv", "code/convert.py",
                "sub-01/eeg/sub-01_eeg.set"]
    assert depots._inventaire(fichiers)["type_ressource"] == "bids"


@pytest.fixture
def con(tmp_path):
    c = base.ouvrir(tmp_path / "b.db")
    yield c
    c.close()


def _article_avec(con, tmp_path, url, role, fiche_depot):
    art = {"id": "doi:10.1/x", "doi": "10.1/x", "titre": "T", "date_pub": "2026-09-01"}
    base.enregistrer_article(con, art)
    lien = liens.normaliser(url)
    c = trouver.Candidat(lien, role, "forte", 3.0, "texte:disponibilite", "…", "Code availability")
    base.remplacer_liens(con, art["id"], [c])
    base.marquer_scan(con, art["id"], plein_texte=True, a_declaration=True, code_sur_demande=False,
                      donnees_sur_demande=False, familles=[], methodes=[])
    if fiche_depot:
        base.enregistrer_depot(con, lien.norme, fiche_depot)
    opts = tourner.Options(biblio=tmp_path / "bib", verifier=False)
    return tourner.conclure(con, art["id"], opts), con.execute(
        "SELECT role, raisons FROM lien").fetchone()


def test_un_depot_de_donnees_plein_de_scripts_porte_du_code(con, tmp_path):
    statut, l = _article_avec(con, tmp_path, "https://github.com/a/b", "donnees",
                              {"etat": "vivant", "nb_fichiers": 60, "nb_scripts": 51})
    assert statut == "code_verifie" and l["role"] == "code"


def test_un_jeu_bids_n_est_pas_promu(con, tmp_path):
    statut, l = _article_avec(con, tmp_path, "https://github.com/a/b", "donnees",
                              {"etat": "vivant", "nb_fichiers": 2141, "nb_scripts": 3,
                               "type_ressource": "bids"})
    assert statut == "donnees_seules" and l["role"] == "donnees"


def test_un_depot_sans_script(con, tmp_path):
    statut, _ = _article_avec(con, tmp_path, "https://github.com/a/b", "code",
                              {"etat": "vivant", "nb_fichiers": 2, "nb_scripts": 0})
    assert statut == "code_vide"


def test_un_lien_mort(con, tmp_path):
    statut, _ = _article_avec(con, tmp_path, "https://github.com/a/b", "code", {"etat": "mort"})
    assert statut == "code_mort"


def test_une_archive_software_est_du_code(con, tmp_path):
    statut, l = _article_avec(con, tmp_path, "https://doi.org/10.5281/zenodo.5", "inconnu",
                              {"etat": "vivant", "type_ressource": "software", "nb_fichiers": 1,
                               "nb_scripts": None})
    assert statut == "code_verifie" and "software" in json.loads(l["raisons"])[-1]


def test_la_source_github_d_une_archive_zenodo_survit_a_un_nouveau_scan(con, tmp_path):
    from scrapper.reseau import Client
    art = {"id": "doi:10.1/z", "doi": "10.1/z", "titre": "T", "date_pub": "2026-09-01"}
    base.enregistrer_article(con, art)
    z = liens.normaliser("https://doi.org/10.5281/zenodo.5")
    base.remplacer_liens(con, art["id"], [trouver.Candidat(z, "code", "forte", 3.0,
                                                           "texte:disponibilite", "…")])
    # Les deux fiches sont fraîches : aucune requête ne part (client hors ligne).
    base.enregistrer_depot(con, "zenodo:5", {"etat": "vivant", "type_ressource": "software",
                                             "lie_a": "https://github.com/a/b/tree/v1.0"})
    con.execute("INSERT OR IGNORE INTO depot (norme, url, hote, genre) VALUES "
                "('github.com/a/b', 'https://github.com/a/b', 'github.com', 'forge')")
    base.enregistrer_depot(con, "github.com/a/b", {"etat": "vivant", "nb_fichiers": 4, "nb_scripts": 3})
    tourner.verifier_article(con, Client(hors_ligne=True), art["id"], tourner.Options(biblio=tmp_path))
    roles = dict(con.execute("SELECT norme, role FROM lien WHERE article_id = ?", (art["id"],)).fetchall())
    assert roles == {"zenodo:5": "code", "github.com/a/b": "code"}


def test_la_base_publique_ne_garde_aucun_extrait(con, tmp_path):
    import sqlite3

    from scrapper import tableau
    _article_avec(con, tmp_path, "https://github.com/a/b", "code",
                  {"etat": "vivant", "nb_fichiers": 3, "nb_scripts": 2})
    assert con.execute("SELECT extrait FROM lien").fetchone()[0] == "…"
    tableau.generer(con, tmp_path / "site")
    pub = sqlite3.connect(tmp_path / "site" / "bibliotheque_publique.db")
    assert pub.execute("SELECT COUNT(*) FROM lien WHERE extrait != ''").fetchone()[0] == 0
    page = (tmp_path / "site" / "index.html").read_text()
    assert "…" not in page.split('id="donnees">')[1].split("</script>")[0]


def test_la_fiche_de_la_bibliotheque_ne_publie_pas_l_extrait(con, tmp_path):
    _article_avec(con, tmp_path, "https://github.com/a/b", "code",
                  {"etat": "vivant", "nb_fichiers": 3, "nb_scripts": 2, "fichiers": ["a.py", "b.m", "R"]})
    fiche = json.loads((tmp_path / "bib" / "doi_10.1_x" / "fiche.json").read_text())
    assert "extrait" not in json.dumps(fiche)
    manifeste = json.loads((tmp_path / "bib" / "doi_10.1_x" / "natif" / "github.com_a_b.json").read_text())
    assert manifeste["scripts"] == ["a.py", "b.m"]
