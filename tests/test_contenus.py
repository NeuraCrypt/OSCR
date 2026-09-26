import io
import json
import sqlite3
import zipfile

import pytest

from scrapper import base, contenus, tableau


def test_un_notebook_devient_du_texte_par_cellules_sans_ses_sorties():
    nb = {"cells": [
        {"cell_type": "markdown", "source": ["# Analyse\n", "Filtrage 1-40 Hz"]},
        {"cell_type": "code", "source": "import mne\nraw.filter(1, 40)",
         "outputs": [{"data": {"image/png": "A" * 50000}}]}]}
    f = contenus.lire("analyse.ipynb", json.dumps(nb).encode())
    assert f["langage"] == "Jupyter" and "raw.filter(1, 40)" in f["texte"]
    assert "AAAA" not in f["texte"] and "# %% [markdown]" in f["texte"]


def test_un_script_matlab_ecrit_sous_windows_garde_ses_accents():
    f = contenus.lire("filtre.m", "% Données filtrées à 40 Hz\n".encode("cp1252"))
    assert f["texte"] == "% Données filtrées à 40 Hz\n" and "�" not in f["texte"]


def test_un_binaire_n_a_pas_de_texte_mais_une_note():
    f = contenus.lire("live.mlx", b"PK\x03\x04\x00\x00binaire")
    assert f["texte"] is None and "binaire" in f["note"]


def test_un_texte_trop_long_est_coupe_et_le_dit():
    f = contenus.lire("gros.py", b"x = 1\n" * 100_000)
    assert f["tronque"] == 1 and len(f["texte"]) == contenus.MAX_TEXTE


def test_un_zip_de_version_github_perd_son_dossier_de_tete():
    tampon = io.BytesIO()
    with zipfile.ZipFile(tampon, "w") as z:
        z.writestr("SmartERD-v1.0.0/README.md", "# SmartERD")
        z.writestr("SmartERD-v1.0.0/src/erd.py", "def erd(x):\n    return x\n")
        z.writestr("SmartERD-v1.0.0/data/sujet01.fif", "données")
    fichiers = {f["chemin"]: f for f in contenus.depuis_zip(tampon.getvalue())}
    assert set(fichiers) == {"README.md", "src/erd.py"}
    assert fichiers["README.md"]["genre"] == "doc" and fichiers["src/erd.py"]["genre"] == "script"


@pytest.fixture
def con(tmp_path):
    c = base.ouvrir(tmp_path / "b.db")
    for norme, licence, redis in (("github.com/libre/depot", "MIT", "oui"),
                                  ("github.com/ferme/depot", "", "non")):
        c.execute("INSERT INTO depot (norme, url, hote, genre, etat, licence, redistribuable, commit_) "
                  "VALUES (?, ?, 'github.com', 'forge', 'vivant', ?, ?, 'abc123')",
                  (norme, f"https://{norme}", licence, redis))
        base.enregistrer_contenus(c, norme, "abc123", [
            contenus.lire("analyse.py", b"print('secret de ' + __name__)\n"),
            contenus.lire("../../evasion.py", b"x = 1\n")])
    c.commit()
    yield c
    c.close()


def test_en_mode_public_un_depot_sans_licence_ne_publie_aucun_texte(con, tmp_path):
    tableau.generer(con, tmp_path / "site", public=True, miroir=tmp_path / "miroir")
    lots = {}
    for f in (tmp_path / "site" / "scripts").glob("*.json"):
        lots.update(json.loads(f.read_text()))
    libre = {f["c"]: f for f in lots["github.com/libre/depot"]["fichiers"]}
    assert libre["analyse.py"]["t"].startswith("print(")
    ferme = {f["c"]: f for f in lots["github.com/ferme/depot"]["fichiers"]}
    assert all(f["t"] is None for f in ferme.values()) and "licence" in ferme["analyse.py"]["note"]
    assert ferme["analyse.py"]["src"] == "https://github.com/ferme/depot/blob/abc123/analyse.py"
    lignes = (tmp_path / "site" / "scripts.jsonl").read_text().splitlines()
    assert {json.loads(l)["depot"] for l in lignes} == {"github.com/libre/depot"}
    pub = sqlite3.connect(tmp_path / "site" / "bibliotheque_publique.db")
    assert pub.execute("SELECT COUNT(*) FROM fichier WHERE depot = 'github.com/ferme/depot' "
                       "AND texte IS NOT NULL").fetchone()[0] == 0


def test_le_miroir_ne_recopie_que_le_republiable_et_jamais_hors_de_son_dossier(con, tmp_path):
    tableau.generer(con, tmp_path / "site", public=True, miroir=tmp_path / "miroir")
    ecrits = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*.py"))
    assert ecrits == ["miroir/github.com_libre_depot/analyse.py"]
    source = json.loads((tmp_path / "miroir" / "github.com_libre_depot" / "SOURCE.json").read_text())
    assert source["licence"] == "MIT" and source["commit"] == "abc123"


def test_le_jeu_hugging_face_declare_ses_trois_tables_et_n_envoie_rien_en_essai(con, tmp_path):
    from scrapper import publier
    tableau.generer(con, tmp_path / "site", public=True, miroir=tmp_path / "miroir")
    dossier = publier.preparer(tmp_path / "site", tmp_path / "miroir")
    carte = (dossier / "README.md").read_text()
    assert "data_files: scripts.jsonl" in carte and "data_files: articles.csv" in carte
    assert (dossier / "scripts" / "github.com_libre_depot" / "analyse.py").exists()
    assert not (dossier / "scripts" / "github.com_ferme_depot").exists()
    assert "rien n'est envoyé" in publier.publier(tmp_path / "site", "u/jeu", essai=True)


def test_hors_mode_public_tout_le_texte_reste_lisible(con, tmp_path):
    tableau.generer(con, tmp_path / "site", public=False)
    lots = {}
    for f in (tmp_path / "site" / "scripts").glob("*.json"):
        lots.update(json.loads(f.read_text()))
    assert all(f["t"] is not None for f in lots["github.com/ferme/depot"]["fichiers"])
