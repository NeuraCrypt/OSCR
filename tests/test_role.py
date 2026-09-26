"""The role of a link, on sentences shaped like those reviewed on 2026-09-25."""
from oscr import links, role
from oscr.jats import Mention

AUTHORS = ["Dupont", "Martin"]


def judge(sentence, url, location="body", sections=("Methods",), **kw):
    m = Mention(url, sentence, sections, location, **kw)
    return role.judge(m, links.normalize(url), AUTHORS).role


def test_the_authors_code_in_the_availability_section():
    u = "https://github.com/lab/project"
    assert judge(f"The code used in this study is available at {u}.", u, "availability",
                 ("Code availability",)) == "code"


def test_a_named_github_is_not_a_tool():
    u = "https://github.com/gemmaferu/review"
    assert judge(f"The code used for plotting results is freely available on GitHub: {u}.", u,
                 "availability", ("Data availability",)) == "code"


def test_a_cited_toolbox_is_a_tool():
    u = "https://github.com/sccn/eeglab"
    assert judge(f"Data were processed using the EEGLAB toolbox ({u}).", u) == "third_party_tool"


def test_downloaded_software_cited_to_other_authors():
    u = "https://github.com/fangq/iso2mesh"
    s = (f"A head mesh was created with the Iso2Mesh software (Fang and Boas 2009; version 1.9.6 "
         f"downloaded from {u}).")
    assert judge(s, u) == "third_party_tool"


def test_we_does_not_make_ownership():
    u = "https://github.com/jnobyrne/edgeofpy"
    assert judge(f"We computed the coefficient using the edgeofpy Python package ({u}).", u) == "third_party_tool"


def test_a_named_package_is_a_tool():
    u = "https://github.com/pmcharrison/ppm"
    s = f"The model was implemented using a function from the ppm R package, available on GitHub ({u})."
    assert judge(s, u) == "third_party_tool"


def test_a_software_name_right_before_the_link():
    u = "https://github.com/neuropycon"
    s = f"These steps were performed with a pipeline provided by NeuroPycon ({u}), a Python package."
    assert judge(s, u) == "third_party_tool"


def test_data_in_a_repository_are_not_code():
    u = "https://doi.org/10.5281/zenodo.17534399"
    assert judge(f"The empirical data used for this paper are available in the public repository "
                 f"Zenodo ({u}).", u, "availability", ("Data availability",)) == "data"


def test_the_nearest_noun_settles_a_mixed_sentence():
    osf, gh = "https://osf.io/abcde/", "https://github.com/lab/analysis"
    s = f"The raw data are available at {osf}, and the analysis code is available at {gh}."
    assert judge(s, osf, "availability", ("Data and code availability",)) == "data"
    assert judge(s, gh, "availability", ("Data and code availability",)) == "code"


def test_own_references_tools_and_other_authors_data():
    z = "https://doi.org/10.5281/zenodo.111"
    assert judge("Dupont A, Martin B. Code for alpha analysis. Zenodo. 2024.", z, "references",
                 ("References",)) == "code"
    assert judge("Larson E, et al. MNE-Python. Zenodo. 2024.", z, "references",
                 ("References",)) == "third_party_tool"
    assert judge("Riegel J, Schuller A. MEG attention dataset using musicians. 2024.", z,
                 "references", ("References",)) == "data"


def test_the_reference_that_carries_the_paper_title_is_its_archive():
    m = Mention("https://doi.org/10.5281/zenodo.222",
                "Yu Q, Liu Y. Trait anxiety is associated with reduced reward-related replay at "
                "rest (version 1.0). Zenodo.", ("References",), "references")
    v = role.judge(m, links.normalize(m.url), ["Other"],
                   "Trait anxiety is associated with reduced reward-related replay at rest")
    assert v.role == "code"


def test_software_shipped_with_sample_data_stays_code():
    u = "https://github.com/n-szulc/fingeRNAt"
    s = (f"It can be downloaded, along with a manual, collection of helper utilities, and sample "
         f"data from {u}.")
    assert judge(s, u, "availability", ("Materials and methods", "Software availability")) == "code"


def test_the_nearest_title_decides_the_section():
    u = "https://github.com/lab/tool"
    m = Mention(u, f"Available at {u}.", ("Materials and methods", "Software availability"),
                "availability")
    reasons = role.judge(m, links.normalize(u), AUTHORS).reasons
    assert any("section 'Software availability'" in r for r in reasons)
    assert not any("mixed section" in r for r in reasons)


def test_on_request():
    assert role.ON_REQUEST.search("available from the corresponding author upon reasonable request")
    assert not role.ON_REQUEST.search("available at https://github.com/a/b")
