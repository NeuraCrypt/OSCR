from scrapper import liens, role
from scrapper.jats import Occurrence
from scrapper.sources import forges


def test_le_compte_porte_le_nom_d_un_auteur():
    assert forges.compte_d_auteur("schmidtfa", ["Schmidt", "Weisz"]) == "Schmidt"
    assert forges.compte_d_auteur("tillhabersetzer", ["Habersetzer", "Meyer"]) == "Habersetzer"
    # Un nom court n'est pas une preuve : « He » est dans « thelab ».
    assert forges.compte_d_auteur("thelab", ["He", "Li"]) == ""


def test_un_readme_etranger_n_est_pas_du_code_natif():
    u = "https://github.com/quelquun/reimplementation"
    occ = Occurrence(u, "Le README de quelquun/reimplementation cite le DOI de l'article",
                     ("GitHub",), "metadonnees", "github:readme")
    assert role.juger(occ, liens.normaliser(u), ["Dupont"]).role == "inconnu"


def test_un_readme_des_auteurs_est_du_code_natif():
    u = "https://github.com/schmidtfa/cardiac_1_f"
    occ = Occurrence(u, "Le README de schmidtfa/cardiac_1_f cite le DOI de l'article ; le compte "
                        "porte le nom de l'auteur Schmidt", ("GitHub",), "metadonnees",
                     "github:readme:propre")
    assert role.juger(occ, liens.normaliser(u), ["Schmidt"]).role == "code"


def test_arxiv_de():
    assert forges.arxiv_de("10.48550/arXiv.2509.06917") == "2509.06917"
    assert forges.arxiv_de("10.1038/s41597-025-06397-4") == ""
