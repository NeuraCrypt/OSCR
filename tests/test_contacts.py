"""The authors' contact details: collected from what the paper publishes, kept private,
sent only to a private dataset, never in a public output."""
import sqlite3
from types import SimpleNamespace

import pytest

from oscr import catalog, contacts, db

JATS = """<article article-type="research-article"><front><article-meta>
<contrib-group>
  <contrib contrib-type="author" corresp="yes">
    <contrib-id contrib-id-type="orcid">https://orcid.org/0000-0002-1825-0097</contrib-id>
    <name><surname>Carberry</surname><given-names>Josiah</given-names></name>
    <xref ref-type="aff" rid="a1"/><xref ref-type="corresp" rid="c1"/>
  </contrib>
  <contrib contrib-type="author">
    <name><surname>Doe</surname><given-names>Jane</given-names></name>
    <xref ref-type="aff" rid="a2"/>
    <email>Jane.Doe@Example-Lab.org</email>
  </contrib>
  <contrib contrib-type="author">
    <name><surname>Roe</surname><given-names>Richard</given-names></name>
    <xref ref-type="aff" rid="a2"/>
  </contrib>
</contrib-group>
<aff id="a1"><label>1</label><institution>Department of Psychoceramics</institution>,
  <institution>Brown University</institution>, <addr-line>Providence, RI 02912</addr-line>,
  <country>USA</country></aff>
<aff id="a2"><label>2</label>Neuroscience Unit, Fictional Institute of Brains, 12 Cortex Road,
  Lyon, France. E-mail: rroe (at) fib (dot) fr</aff>
<author-notes><corresp id="c1">* Correspondence: josiah@brown.edu</corresp></author-notes>
</article-meta></front></article>"""

CORE = {"authorList": {"author": [
    {"firstName": "Josiah", "lastName": "Carberry", "fullName": "Carberry J",
     "authorAffiliationDetailsList": {"authorAffiliation": [{"affiliation": "Brown University, USA."}]}},
    {"firstName": "Jane", "lastName": "Doe", "fullName": "Doe J",
     "authorAffiliationDetailsList": {"authorAffiliation": [
         {"affiliation": "Fictional Institute of Brains, Lyon, France. Electronic address: jane.doe@fib.fr."}]}},
    {"firstName": "Richard", "lastName": "Roe", "fullName": "Roe R"}]}}


def test_every_author_with_names_organization_address_and_email():
    rows = contacts.from_jats(JATS)
    by = {(r["position"], r["email"]): r for r in rows}
    josiah = by[(1, "josiah@brown.edu")]
    assert (josiah["given"], josiah["family"], josiah["orcid"]) == ("Josiah", "Carberry", "0000-0002-1825-0097")
    assert josiah["organization"] == "Department of Psychoceramics, Brown University"
    assert josiah["address"] == "Providence, RI 02912, USA" and josiah["corresponding"]
    assert by[(2, "jane.doe@example-lab.org")]["family"] == "Doe"      # her own <email>, lower-cased
    assert contacts.normalize_email("someone@example.org") == ""        # a reserved example domain is not
    # "rroe (at) fib (dot) fr", in the affiliation both Doe and Roe share, belongs to Roe by name.
    roe = by[(3, "rroe@fib.fr")]
    assert roe["organization"] == "Neuroscience Unit, Fictional Institute of Brains"
    assert roe["address"] == "12 Cortex Road, Lyon, France" and "rroe" not in roe["affiliation"]


def test_europe_pmc_completes_the_full_text():
    merged = contacts.merge(contacts.from_jats(JATS), contacts.from_epmc(CORE))
    emails = {(r["position"], r["email"]) for r in merged}
    assert (2, "jane.doe@fib.fr") in emails                 # from "Electronic address: …"
    assert contacts.from_epmc(CORE)[1]["affiliation"] == "Fictional Institute of Brains, Lyon, France"


def _db_with_contacts(tmp_path):
    con = db.open_db(tmp_path / "c.db")
    db.save_article(con, {"id": "doi:10.1/c", "doi": "10.1/c", "title": "T", "published": "2026-09-01"})
    db.mark_scanned(con, "doi:10.1/c", has_fulltext=True, has_statement=True, code_on_request=False,
                    data_on_request=False, families=[], methods=[])
    contacts.write(con, "doi:10.1/c", contacts.merge(contacts.from_jats(JATS), contacts.from_epmc(CORE)))
    con.commit()
    return con


def test_contacts_never_reach_a_public_output(tmp_path):
    con = _db_with_contacts(tmp_path)
    catalog.generate(con, tmp_path / "out", public=True)
    pub = sqlite3.connect(tmp_path / "out" / "oscr_public.db")
    assert pub.execute("SELECT name FROM sqlite_master WHERE name = 'contact'").fetchone() is None
    everything = "".join(p.read_text(errors="ignore") for p in (tmp_path / "out").rglob("*") if p.is_file())
    assert "josiah@brown.edu" not in everything and "rroe@fib.fr" not in everything


def test_the_table_links_each_contact_to_the_paper_and_its_doi(tmp_path):
    con = _db_with_contacts(tmp_path)
    rows = contacts.table(con)
    assert {r["doi"] for r in rows} == {"10.1/c"} and any(r["email"] == "josiah@brown.edu" for r in rows)
    counts = contacts.build(con, tmp_path / "private")
    assert counts["emails"] >= 3 and (tmp_path / "private" / "contacts.parquet").exists()


def test_publishing_refuses_a_dataset_that_is_not_private(tmp_path, monkeypatch):
    con = _db_with_contacts(tmp_path)
    sent = []

    class FakeApi:
        def __init__(self, token=None):
            pass

        def dataset_info(self, repo):
            return SimpleNamespace(private=repo.endswith("Private"))

        def upload_folder(self, **kw):
            sent.append(kw["repo_id"])

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "HfApi", FakeApi)
    monkeypatch.setattr("oscr.scriptstore.token", lambda: None)
    with pytest.raises(SystemExit, match="not a private dataset"):
        contacts.publish(con, tmp_path / "p", "Org/Public")
    assert sent == []
    contacts.publish(con, tmp_path / "p", "Org/Private")
    assert sent == ["Org/Private"]


def test_the_site_hides_email_addresses_in_code():
    code = "% Author: Jane Doe <jane.doe@fib.fr>\nurl = 'git@github.com:lab/repo.git'\n@property\ndef x(): pass\n"
    masked = catalog.mask_emails(code)
    assert "jane.doe@fib.fr" not in masked and catalog.EMAIL_MASK in masked
    assert "git@github.com:lab/repo.git" in masked and "@property" in masked
    assert masked.count("\n") == code.count("\n")


def test_a_huge_repository_shows_only_part_of_its_text_on_the_site(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, "MAX_SITE_TEXT_PER_REPO", 50)
    con = _db_with_contacts(tmp_path)
    con.execute("INSERT INTO repository (repo, url, host, kind, state, license, redistributable) VALUES "
                "('github.com/big/toolbox', 'https://github.com/big/toolbox', 'github.com', 'forge', 'alive', "
                "'MIT', 'yes')")
    con.execute("INSERT INTO link (article_id, repo, url, host, kind, role, confidence, found_by) VALUES "
                "('doi:10.1/c', 'github.com/big/toolbox', 'https://github.com/big/toolbox', 'github.com', 'forge', "
                "'code', 'high', 'text:availability')")
    for i in range(3):
        con.execute("INSERT INTO file (repo, path, version, language, kind, size, lines, text) VALUES "
                    "('github.com/big/toolbox', ?, 'c', 'Python', 'script', 30, 1, ?)", (f"f{i}.py", "x" * 30))
    con.commit()
    lots = catalog.script_lots(con, public=True)
    files = lots[catalog.lot_of("github.com/big/toolbox")]["github.com/big/toolbox"]["files"]
    assert [f["text"] is not None for f in files] == [True, False, False]
    assert "read it at the source" in files[2]["note"]
