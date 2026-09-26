"""Each case is an error actually met on 2026-09-25, or a real way of writing the
same repository."""
from oscr import links


def repo(u):
    l = links.normalize(u)
    return l.repo if l else None


def test_a_github_repository_has_a_single_normal_form():
    forms = ["https://github.com/Owner/Repo", "github.com/owner/repo.git",
             "https://github.com/owner/repo/tree/main/analysis", "https://github.com/owner/repo).",
             "https://colab.research.google.com/github/owner/repo/blob/main/a.ipynb",
             "https://mybinder.org/v2/gh/owner/repo/HEAD",
             "https://raw.githubusercontent.com/owner/repo/HEAD/README.md"]
    assert {repo(f) for f in forms} == {"github.com/owner/repo"}


def test_typographic_hyphens_are_the_same_repository():
    # Wiley writes URL hyphens as U+2010 (10.1111/ejn.70660: its only code link looked dead).
    assert repo("https://github.com/multisensory\u2010lab/msl_ccep_stg2occ.") == "github.com/multisensory-lab/msl_ccep_stg2occ"
    assert repo("https://doi.org/10.12751/g\u2010node.pmvtz1") == "doi:10.12751/g-node.pmvtz1"
    assert repo("https://github.com/owner/re\u00adpo") == repo("https://github.com/owner/re\u200bpo") == "github.com/owner/repo"
    assert links.normalize("https://github.com/Aswendt\u2010Lab/AIDAmri").url == "https://github.com/Aswendt-Lab/AIDAmri"


def test_a_software_heritage_archive_joins_its_github_repository():
    u = ("https://archive.softwareheritage.org/swh:1:dir:32ae41fd26bf4d5f6c313bdb29b738e0d0730cf8"
         ";origin=https://github.com/schmidtfa/ecg_1f_memory;visit=swh:1:snp:88a436")
    l = links.normalize(u)
    assert l.repo == "github.com/schmidtfa/ecg_1f_memory"
    assert l.identifier.startswith("swh:1:dir:")


def test_links_to_papers_are_neither_code_nor_data():
    for u in ["https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4469089/",
              "https://pubmed.ncbi.nlm.nih.gov/27623516/",
              "https://www.ncbi.nlm.nih.gov/nuccore/R81071",
              "https://www.biorxiv.org/content/10.1101/2022.11.07.515423"]:
        assert links.normalize(u) is None, u


def test_an_osf_preprint_doi_is_not_an_osf_project():
    text = "Levy R. (2018). CogSci 40. 10.31234/osf.io/4cgxh."
    assert not any((links.normalize(u) or links.Link("", "", "", "other")).repo == "osf:4cgxh"
                   for u in links.in_text(text))


def test_a_zenodo_doi_without_its_dot_is_recognized():
    assert repo("10.5281/zenodo3840534") == "zenodo:3840534"
    assert repo("https://doi.org/10.5281/zenodo.17534724") == "zenodo:17534724"


def test_a_query_glued_behind_the_scheme_is_not_a_host():
    assert links.normalize("https://journal=AdvSci&title=x&volume=12&doi=10.1002/advs.2") is None


def test_data_mirrors_are_data():
    assert links.normalize("https://github.com/nemarDatasets/on006468").kind == "data"


def test_the_home_page_of_a_repository_is_not_a_dataset():
    assert links.normalize("https://openneuro.org") is None
    assert repo("https://openneuro.org/datasets/ds006468/versions/1.1.1") == "openneuro:ds006468"


def test_dryad_is_a_mixed_archive():
    # The code of a Dryad dataset lives in a companion Zenodo software record (benchmark, 2026-09-25).
    for u in ["https://doi.org/10.5061/dryad.v41ns1s70", "10.5061/dryad.v41ns1s70",
              "https://datadryad.org/stash/dataset/doi:10.5061/dryad.v41ns1s70"]:
        l = links.normalize(u)
        assert (l.repo, l.kind) == ("doi:10.5061/dryad.v41ns1s70", "archive"), u


def test_archives_and_forges():
    assert repo("https://osf.io/65dca/?view_only=88e1") == "osf:65dca"
    assert repo("https://doi.org/10.17605/OSF.IO/MRZ89") == "osf:mrz89"
    assert repo("https://figshare.com/articles/software/x/30462994") == "figshare:30462994"
    assert repo("https://codeberg.org/Max/2026_beta.git") == "codeberg.org/max/2026_beta"
    assert repo("https://gitlab.com/grp/sub/project/-/tree/main") == "gitlab.com/grp/sub/project"
    assert repo("https://senselab.med.yale.edu/ModelDB/showmodel.cshtml?model=87284") == "modeldb:87284"


def test_an_outlook_safelinks_link_yields_the_real_address_without_the_email():
    l = links.normalize("https://eur01.safelinks.protection.outlook.com/?url=https://github.com/Raghumoy/"
                        "Cochlin_manuscript.git&data=05|02|someone@example.org|2b10f|0|&sdata=r4q%3D&reserved=0")
    assert l is not None and l.repo == "github.com/raghumoy/cochlin_manuscript"
    assert "safelinks" not in l.url and "@" not in l.url
