"""Phase 1 enrichment: datasets from data links, coverage."""
import pytest

from oscr import db, enrich, find, links


@pytest.fixture
def con(tmp_path):
    c = db.open_db(tmp_path / "e.db")
    yield c
    c.close()


def test_a_dataset_is_named_after_its_repository():
    assert enrich.data_repository("openneuro:ds004080") == "OpenNeuro"
    assert enrich.data_repository("doi:10.5061/dryad.abc123") == "Dryad"
    assert enrich.data_repository("ncbi.nlm.nih.gov/geo/query/acc.cgi") == "NCBI"
    assert enrich.data_repository("adknowledgeportal.synapse.org") == "Synapse"
    assert enrich.data_repository("doi:10.9999/x") == "DOI"


def test_data_links_become_datasets_cited_by_the_paper(con):
    db.save_article(con, {"id": "doi:10.1/a", "doi": "10.1/a", "title": "T", "published": "2026-09-01"})
    c = find.Candidate(links.normalize("https://openneuro.org/datasets/ds004080"), "data", "high", 2.0,
                       "text:availability", "", "Data availability")
    db.replace_links(con, "doi:10.1/a", [c])
    assert enrich.link_datasets(con, "doi:10.1/a") == 1
    assert con.execute("SELECT d.repository FROM paper_dataset p JOIN dataset d ON d.id = p.dataset_id").fetchone()[0] \
        == "OpenNeuro"
    db.mark_scanned(con, "doi:10.1/a", has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    assert enrich.coverage(con)["datasets"] == 100.0


def test_the_owners_labels_win_and_decide_what_leaves(con, tmp_path):
    db.save_article(con, {"id": "doi:10.1/b", "doi": "10.1/b", "title": "T", "published": "2026-09-01"})
    con.execute("UPDATE article SET on_topic = 'yes' WHERE id = 'doi:10.1/b'")
    con.commit()
    sample = tmp_path / "sample.csv"
    sample.write_text("﻿id,doi,title,on_topic,modality,organism,population,subfield,notes\n"
                      "doi:10.1/b,10.1/b,T,no,EEG; MEG,human,?,,\n"
                      "doi:10.1/unknown,,U,yes,,,,,\n", encoding="utf-8")
    counts = enrich.import_owner_labels(con, sample)
    assert counts["papers"] == 1
    assert con.execute("SELECT on_topic FROM article WHERE id = 'doi:10.1/b'").fetchone()[0] == "no"
    rows = sorted(tuple(r) for r in con.execute("SELECT facet, value FROM paper_category WHERE method = 'owner'"))
    assert rows == [("modality", "eeg"), ("modality", "meg"), ("on_topic", "no"),
                                        ("organism", "human")]
