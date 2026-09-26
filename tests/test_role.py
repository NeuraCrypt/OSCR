"""Le rôle d'un lien, sur des phrases de la forme de celles relues le 25/09/2026."""
from scrapper import liens, role
from scrapper.jats import Occurrence

AUTEURS = ["Dupont", "Martin"]


def juge(phrase, url, lieu="corps", sections=("Methods",), **kw):
    occ = Occurrence(url, phrase, sections, lieu, **kw)
    return role.juger(occ, liens.normaliser(url), AUTEURS).role


def test_le_code_des_auteurs_dans_la_section_de_disponibilite():
    u = "https://github.com/lab/projet"
    assert juge(f"The code used in this study is available at {u}.", u, "disponibilite",
                ("Code availability",)) == "code"


def test_github_nomme_n_est_pas_un_outil():
    u = "https://github.com/gemmaferu/review"
    assert juge(f"The code used for plotting results is freely available on GitHub: {u}.", u,
                "disponibilite", ("Data availability",)) == "code"


def test_une_boite_a_outils_citee_est_un_outil():
    u = "https://github.com/sccn/eeglab"
    assert juge(f"Data were processed using the EEGLAB toolbox ({u}).", u) == "outil_tiers"


def test_un_logiciel_telecharge_et_cite_a_d_autres_auteurs():
    u = "https://github.com/fangq/iso2mesh"
    p = (f"A head mesh was created with the Iso2Mesh software (Fang and Boas 2009; version 1.9.6 "
         f"downloaded from {u}).")
    assert juge(p, u) == "outil_tiers"


def test_we_ne_fait_pas_la_propriete():
    u = "https://github.com/jnobyrne/edgeofpy"
    assert juge(f"We computed the coefficient using the edgeofpy Python package ({u}).", u) == "outil_tiers"


def test_un_paquet_nomme_est_un_outil():
    u = "https://github.com/pmcharrison/ppm"
    p = f"The model was implemented using a function from the ppm R package, available on GitHub ({u})."
    assert juge(p, u) == "outil_tiers"


def test_un_nom_de_logiciel_juste_avant_le_lien():
    u = "https://github.com/neuropycon"
    p = f"These steps were performed with a pipeline provided by NeuroPycon ({u}), a Python package."
    assert juge(p, u) == "outil_tiers"


def test_des_donnees_dans_un_entrepot_ne_sont_pas_du_code():
    u = "https://doi.org/10.5281/zenodo.17534399"
    assert juge(f"The empirical data used for this paper are available in the public repository "
                f"Zenodo ({u}).", u, "disponibilite", ("Data availability",)) == "donnees"


def test_le_nom_le_plus_proche_departage_une_phrase_mixte():
    osf, gh = "https://osf.io/abcde/", "https://github.com/lab/analyse"
    p = f"The raw data are available at {osf}, and the analysis code is available at {gh}."
    assert juge(p, osf, "disponibilite", ("Data and code availability",)) == "donnees"
    assert juge(p, gh, "disponibilite", ("Data and code availability",)) == "code"


def test_references_propres_outils_et_donnees_d_autres():
    z = "https://doi.org/10.5281/zenodo.111"
    assert juge("Dupont A, Martin B. Code for alpha analysis. Zenodo. 2024.", z, "references",
                ("References",)) == "code"
    assert juge("Larson E, et al. MNE-Python. Zenodo. 2024.", z, "references",
                ("References",)) == "outil_tiers"
    assert juge("Riegel J, Schuller A. MEG attention dataset using musicians. 2024.", z,
                "references", ("References",)) == "donnees"


def test_la_reference_qui_porte_le_titre_de_l_article_est_son_archive():
    occ = Occurrence("https://doi.org/10.5281/zenodo.222",
                     "Yu Q, Liu Y. Trait anxiety is associated with reduced reward-related replay at "
                     "rest (version 1.0). Zenodo.", ("References",), "references")
    j = role.juger(occ, liens.normaliser(occ.url), ["Autre"],
                   "Trait anxiety is associated with reduced reward-related replay at rest")
    assert j.role == "code"


def test_un_logiciel_livre_avec_des_donnees_d_exemple_reste_du_code():
    u = "https://github.com/n-szulc/fingeRNAt"
    p = (f"It can be downloaded, along with a manual, collection of helper utilities, and sample "
         f"data from {u}.")
    assert juge(p, u, "disponibilite", ("Materials and methods", "Software availability")) == "code"


def test_le_titre_le_plus_proche_decide_de_la_section():
    u = "https://github.com/lab/outil"
    occ = Occurrence(u, f"Available at {u}.", ("Materials and methods", "Software availability"),
                     "disponibilite")
    raisons = role.juger(occ, liens.normaliser(u), AUTEURS).raisons
    assert any("section « Software availability »" in r for r in raisons)
    assert not any("section mixte" in r for r in raisons)


def test_sur_demande():
    assert role.SUR_DEMANDE.search("available from the corresponding author upon reasonable request")
    assert not role.SUR_DEMANDE.search("available at https://github.com/a/b")
