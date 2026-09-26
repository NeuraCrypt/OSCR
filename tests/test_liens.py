"""Chaque cas est une erreur réellement rencontrée le 25/09/2026, ou une forme
d'écriture réelle d'un même dépôt."""
from scrapper import liens


def norme(u):
    l = liens.normaliser(u)
    return l.norme if l else None


def test_un_depot_github_a_une_seule_norme():
    formes = ["https://github.com/Owner/Repo", "github.com/owner/repo.git",
              "https://github.com/owner/repo/tree/main/analysis", "https://github.com/owner/repo).",
              "https://colab.research.google.com/github/owner/repo/blob/main/a.ipynb",
              "https://mybinder.org/v2/gh/owner/repo/HEAD",
              "https://raw.githubusercontent.com/owner/repo/HEAD/README.md"]
    assert {norme(f) for f in formes} == {"github.com/owner/repo"}


def test_une_archive_software_heritage_rejoint_son_depot_github():
    u = ("https://archive.softwareheritage.org/swh:1:dir:32ae41fd26bf4d5f6c313bdb29b738e0d0730cf8"
         ";origin=https://github.com/schmidtfa/ecg_1f_memory;visit=swh:1:snp:88a436")
    l = liens.normaliser(u)
    assert l.norme == "github.com/schmidtfa/ecg_1f_memory"
    assert l.identifiant.startswith("swh:1:dir:")


def test_les_liens_d_articles_ne_sont_ni_code_ni_donnees():
    for u in ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4469089/",
              "https://pubmed.ncbi.nlm.nih.gov/27623516/",
              "https://www.ncbi.nlm.nih.gov/nuccore/R81071",
              "https://www.biorxiv.org/content/10.1101/2022.11.07.515423"]:
        assert liens.normaliser(u) is None, u


def test_un_doi_de_preimpression_osf_n_est_pas_un_projet_osf():
    texte = "Levy R. (2018). CogSci 40. 10.31234/osf.io/4cgxh."
    assert not any((liens.normaliser(u) or liens.Lien("", "", "", "autre")).norme == "osf:4cgxh"
                   for u in liens.dans_le_texte(texte))


def test_un_doi_zenodo_sans_point_est_reconnu():
    assert norme("10.5281/zenodo3840534") == "zenodo:3840534"
    assert norme("https://doi.org/10.5281/zenodo.17534724") == "zenodo:17534724"


def test_une_requete_collee_derriere_le_schema_n_est_pas_un_hote():
    assert liens.normaliser("https://journal=AdvSci&title=x&volume=12&doi=10.1002/advs.2") is None


def test_les_miroirs_de_donnees_sont_des_donnees():
    assert liens.normaliser("https://github.com/nemarDatasets/on006468").genre == "donnees"


def test_la_page_d_accueil_d_un_entrepot_n_est_pas_un_jeu_de_donnees():
    assert liens.normaliser("https://openneuro.org") is None
    assert norme("https://openneuro.org/datasets/ds006468/versions/1.1.1") == "openneuro:ds006468"


def test_dryad_est_une_archive_mixte():
    # Le code d'un jeu Dryad vit dans un logiciel Zenodo compagnon (étalon, 25/09/2026).
    for u in ["https://doi.org/10.5061/dryad.v41ns1s70", "10.5061/dryad.v41ns1s70",
              "https://datadryad.org/stash/dataset/doi:10.5061/dryad.v41ns1s70"]:
        l = liens.normaliser(u)
        assert (l.norme, l.genre) == ("doi:10.5061/dryad.v41ns1s70", "archive"), u


def test_les_archives_et_les_forges():
    assert norme("https://osf.io/65dca/?view_only=88e1") == "osf:65dca"
    assert norme("https://doi.org/10.17605/OSF.IO/MRZ89") == "osf:mrz89"
    assert norme("https://figshare.com/articles/software/x/30462994") == "figshare:30462994"
    assert norme("https://codeberg.org/Max/2026_beta.git") == "codeberg.org/max/2026_beta"
    assert norme("https://gitlab.com/grp/sous/projet/-/tree/main") == "gitlab.com/grp/sous/projet"
    assert norme("https://senselab.med.yale.edu/ModelDB/showmodel.cshtml?model=87284") == "modeldb:87284"


def test_un_lien_outlook_safelinks_rend_la_vraie_adresse_sans_le_courriel():
    l = liens.normaliser("https://eur01.safelinks.protection.outlook.com/?url=https://github.com/Raghumoy/"
                   "Cochlin_manuscript.git&data=05|02|quelqu.un@univ.se|2b10f|0|&sdata=r4q%3D&reserved=0")
    assert l is not None and l.norme == "github.com/raghumoy/cochlin_manuscript"
    assert "safelinks" not in l.url and "@" not in l.url
