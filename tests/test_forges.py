from oscr import links, role
from oscr.jats import Mention
from oscr.sources import forges


def test_the_account_bears_an_author_name():
    assert forges.author_account("schmidtfa", ["Schmidt", "Weisz"]) == "Schmidt"
    assert forges.author_account("tillhabersetzer", ["Habersetzer", "Meyer"]) == "Habersetzer"
    # A short name is no proof: "He" is in "thelab".
    assert forges.author_account("thelab", ["He", "Li"]) == ""


def test_a_foreign_readme_is_not_native_code():
    u = "https://github.com/someone/reimplementation"
    m = Mention(u, "The README of someone/reimplementation cites the paper's DOI",
                ("GitHub",), "metadata", "github:readme")
    assert role.judge(m, links.normalize(u), ["Dupont"]).role == "unknown"


def test_a_readme_of_the_authors_is_native_code():
    u = "https://github.com/schmidtfa/cardiac_1_f"
    m = Mention(u, "The README of schmidtfa/cardiac_1_f cites the paper's DOI; the account "
                   "bears the name of author Schmidt", ("GitHub",), "metadata",
                "github:readme:own")
    assert role.judge(m, links.normalize(u), ["Schmidt"]).role == "code"


def test_arxiv_id():
    assert forges.arxiv_id("10.48550/arXiv.2509.06917") == "2509.06917"
    assert forges.arxiv_id("10.1038/s41597-025-06397-4") == ""
