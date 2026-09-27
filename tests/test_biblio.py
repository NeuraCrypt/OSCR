"""The bibliographic record (oscr/biblio.py).

Every fixture is invented: minimal JATS and Europe PMC `core` records that mirror the real
structures seen in the cache (2026-09-26), with no sentence from a real paper. The ORCID iDs
are ORCID's own documentation examples; the ROR id and the funder DOI are made up (with a valid
checksum for the ROR id).
"""
import copy
import json

import pytest

from oscr import biblio

NS = ('xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:ali="http://www.niso.org/schemas/ali/1.0/" '
      'xmlns:mml="http://www.w3.org/1998/Math/MathML"')

JOURNAL_META = (
    '<journal-meta><journal-id journal-id-type="nlm-ta">J Invent Neurosci</journal-id>'
    '<journal-title-group><journal-title>Journal of Invented Neuroscience</journal-title>'
    '</journal-title-group><issn pub-type="ppub">1234-5679</issn><issn pub-type="epub">2345-678X</issn>'
    '<publisher><publisher-name>Imaginary Press</publisher-name></publisher></journal-meta>')


def article(meta: str = "", body: str = "", back: str = "", kind: str = "research-article",
            front_extra: str = "", after: str = "") -> str:
    """A minimal paper: `meta` goes inside <article-meta>, after a title."""
    return (f'<article {NS} article-type="{kind}" xml:lang="en"><front>{JOURNAL_META}'
            '<article-meta><title-group><article-title>An invented title</article-title>'
            f'</title-group>{meta}</article-meta>{front_extra}</front>'
            + (f"<body>{body}</body>" if body else "") + (f"<back>{back}</back>" if back else "")
            + after + "</article>")


BACK_FLAVOUR = article(
    meta=(
        '<article-categories><subj-group subj-group-type="heading"><subject>Research Article</subject>'
        '</subj-group><subj-group subj-group-type="Discipline-v3"><subject>Biology and Life Sciences'
        '</subject><subj-group><subject>Neuroscience</subject></subj-group></subj-group></article-categories>'
        '<contrib-group>'
        '<contrib contrib-type="author" corresp="yes"><contrib-id contrib-id-type="orcid" authenticated="true">'
        'https://orcid.org/0000-0002-1825-0097</contrib-id><name><surname>Example</surname>'
        '<given-names>Ada</given-names></name><xref ref-type="aff" rid="a1">1</xref>'
        '<email>ada@example.org</email></contrib>'
        '<contrib contrib-type="author"><contrib-id contrib-id-type="orcid">https://orcid.org/0000-0002-1825-0098'
        '</contrib-id><name><surname>Sample</surname><given-names>Bruno</given-names></name>'
        '<xref ref-type="aff" rid="a1 a2"/></contrib>'
        '<contrib contrib-type="editor"><name><surname>Editor</surname><given-names>Eve</given-names></name></contrib>'
        '<aff id="a1"><label>1</label><institution-wrap><institution-id institution-id-type="ror">'
        'https://ror.org/0abcdef23</institution-id><institution>Institute of Invented Studies</institution>'
        '</institution-wrap>, <city>Nowhere</city>, <country>Utopia</country></aff>'
        '<aff id="a2"><label>2</label>Department of Fiction, Imaginary University, Elsewhere</aff>'
        '</contrib-group>'
        '<author-notes><corresp id="c1">Correspondence: <email>ada@example.org</email></corresp></author-notes>'
        '<pub-date pub-type="epub"><day>14</day><month>3</month><year>2026</year></pub-date>'
        '<pub-date pub-type="ppub"><month>6</month><year>2026</year></pub-date>'
        '<volume>12</volume><issue>3</issue><fpage>101</fpage><lpage>115</lpage>'
        '<history><date date-type="received"><day>2</day><month>1</month><year>2026</year></date>'
        '<date date-type="accepted"><day>20</day><month>2</month><year>2026</year></date></history>'
        '<permissions><license><ali:license_ref>https://creativecommons.org/licenses/by-nc/4.0/</ali:license_ref>'
        '<license-p>An invented license paragraph.</license-p></license></permissions>'
        '<abstract><title>Abstract</title><sec><title>Background</title><p>An invented question.</p></sec>'
        '<sec><title>Results:</title><p>An invented answer about Ca<sup>2+</sup>.</p></sec></abstract>'
        '<abstract abstract-type="graphical"><p>A picture.</p></abstract>'
        '<kwd-group kwd-group-type="author"><kwd>invented rhythm</kwd><kwd>imaginary cortex</kwd></kwd-group>'
        '<kwd-group kwd-group-type="abbreviations"><kwd>IC, imaginary cortex</kwd></kwd-group>'
        '<funding-group><award-group><funding-source xlink:href="https://doi.org/10.13039/501100099999">'
        'Fund for Invented Research</funding-source><award-id>FIR-001</award-id></award-group>'
        '<award-group><funding-source>fund for invented research</funding-source><award-id>FIR-002</award-id>'
        '</award-group></funding-group>'),
    body=('<sec><title>Introduction</title><p>An invented introduction.</p></sec>'
          '<sec sec-type="methods"><title>Methods</title><p>Signals went through PretendSoft '
          '(RRID:SCR_999991).</p></sec>'),
    back=('<ack><p>We thank nobody in particular.</p></ack>'
          '<sec><title>Data availability</title><p>The invented recordings sit in an imaginary archive.</p></sec>'
          '<ref-list><ref id="r1"><element-citation><person-group><name><surname>Doe</surname></name>'
          '</person-group><pub-id pub-id-type="doi">10.5555/Ref.One</pub-id><pub-id pub-id-type="pmid">11111111'
          '</pub-id></element-citation></ref><ref id="r2"><mixed-citation>Roe R. An invented book. Nowhere: '
          'Imaginary Press; 2020.</mixed-citation></ref></ref-list>'))

BODY_FLAVOUR = (
    f'<article {NS} article-type="research-article" xml:lang="en"><front><journal-meta>'
    '<journal-title-group><journal-title>Frontiers of Nowhere</journal-title></journal-title-group>'
    '<publisher><publisher-name>Invented Media</publisher-name></publisher></journal-meta><article-meta>'
    '<title-group><article-title>A pretend title</article-title></title-group>'
    '<contrib-group content-type="author"><contrib><name><surname>Quill</surname><given-names>Iris'
    '</given-names></name><xref ref-type="aff" rid="aff1">1</xref></contrib><contrib><name><surname>Nib'
    '</surname><given-names>Otto</given-names></name><xref ref-type="aff" rid="aff1">1</xref>'
    '<xref rid="fn-c" ref-type="author-notes">*</xref></contrib></contrib-group>'
    '<aff id="aff1"><label>1</label>Laboratory of Pretend Physiology, Invented Institute, Nowhere</aff>'
    '<author-notes><fn id="fn-c"><label>*</label><p>Correspondence: Otto Nib, <email>otto@example.org'
    '</email></p></fn></author-notes>'
    '<pub-date><day>4</day><month>8</month><year>2026</year></pub-date><volume>7</volume>'
    '<fpage>286</fpage><page-range>286–293</page-range>'
    '<permissions><license><license-p>Distributed under the terms of the <ext-link ext-link-type="uri" '
    'xlink:href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution License (CC BY)'
    '</ext-link>.</license-p></license></permissions>'
    '<abstract><p>An invented summary of pretend work.</p><sec sec-type="kwd-group"><p><bold>Keywords:</bold>'
    ' pretend physiology, invented cortex; toy model</p></sec></abstract></article-meta>'
    '<notes notes-type="article-notes"><sec sec-type="history"><p>Received 2026 Mar 14; Revised 2026 Jun 2; '
    'Accepted 2026 Jun 29; Collection date 2026.</p></sec></notes></front><body>'
    '<sec sec-type="associated-data"><title>Associated Data</title><sec sec-type="data-availability-statement">'
    '<title>Data Availability Statement</title><p>The pretend data and the analysis code are in '
    '<ext-link ext-link-type="uri" xlink:href="https://example.org/pretend">our archive</ext-link>.</p>'
    '</sec></sec>'
    '<sec><title>Introduction</title><p>Some invented text.</p></sec>'
    '<sec><title>Funding</title><p>This pretend work had an imaginary grant.</p></sec>'
    '<sec><title>Data availability statement</title><p>The pretend data and the analysis code are in '
    '<ext-link ext-link-type="uri" xlink:href="https://example.org/pretend">our archive</ext-link>.</p></sec>'
    '<sec sec-type="ref-list"><title>References</title><sec><ref-list>'
    '<ref id="B1"><mixed-citation><named-content content-type="citation-string">Doe J. Invented work. '
    'J Nowhere (2020) 1:1.</named-content><ext-link ext-link-type="doi" xlink:href="10.5555/ref.body"/>'
    '<ext-link ext-link-type="pmid" xlink:href="22222222"/></mixed-citation></ref>'
    '<ref id="B2"><mixed-citation><named-content content-type="citation-string">Roe R. Another invented '
    'work. 2021.</named-content></mixed-citation></ref></ref-list></sec></sec></body>'
    '<sub-article article-type="reviewer-report"><front-stub><kwd-group><kwd>Convincing</kwd></kwd-group>'
    '</front-stub><body><ref-list><ref><mixed-citation><pub-id pub-id-type="doi">10.5555/not.the.paper'
    '</pub-id></mixed-citation></ref></ref-list></body></sub-article></article>')

FRONT_ONLY = (
    f'<article {NS} article-type="abstract" xml:lang="en"><front><journal-meta><journal-title-group>'
    '<journal-title>Invented Abstracts</journal-title></journal-title-group></journal-meta><article-meta>'
    '<title-group><article-title>P-123 A pretend poster</article-title></title-group>'
    '<contrib-group><contrib contrib-type="author"><name><surname>Poster</surname><given-names>Pat'
    '</given-names></name></contrib><contrib contrib-type="author"><name><surname>Board</surname>'
    '<given-names>Bea</given-names></name></contrib></contrib-group><aff>Invented Clinic, Nowhere</aff>'
    '<pub-date pub-type="collection"><year>2026</year></pub-date><volume>5</volume><issue>Suppl 1</issue>'
    '<elocation-id>P-123</elocation-id><permissions><license><license-p>This work is licensed under CC0.'
    '</license-p></license></permissions><abstract><p>Background: a pretend question.</p>'
    '<p>Results: a pretend answer.</p></abstract></article-meta></front></article>')

CORE = {
    "id": "99999999", "source": "MED", "pmid": "99999999", "pmcid": "PMC9999999",
    "doi": "10.5555/invented.0001", "title": "An invented title.",
    "authorList": {"author": [
        {"fullName": "Example A", "firstName": "Ada", "lastName": "Example", "initials": "A",
         "authorId": {"type": "ORCID", "value": "0000-0002-1825-0097"},
         "authorAffiliationDetailsList": {"authorAffiliation": [
             {"affiliation": "Institute of Invented Studies, Nowhere, Utopia. "
                             "Electronic address: ada@example.org."}]}},
        {"fullName": "Sample B", "firstName": "Bruno", "lastName": "Sample", "initials": "B",
         "authorId": {"type": "ORCID", "value": "0000-0002-1825-0098"}},
        {"collectiveName": "The Pretend Consortium"}]},
    "journalInfo": {"issue": "3", "volume": "12", "dateOfPublication": "2026 Jun",
                    "monthOfPublication": 6, "yearOfPublication": 2026,
                    "printPublicationDate": "2026-06-01",
                    "journal": {"title": "Journal of invented neuroscience", "medlineAbbreviation":
                                "J Invent Neurosci", "issn": "1234-5679", "essn": "2345-678X"}},
    "pubYear": "2026", "pageInfo": "101-115",
    "abstractText": "<h4>Background</h4>An invented question with <i>italics</i> where p<0.05."
                    "<h4>Results</h4>An invented answer.",
    "language": "eng", "pubModel": "Print-Electronic",
    "pubTypeList": {"pubType": ["Journal Article", "Research Support, Non-U.S. Gov't"]},
    "keywordList": {"keyword": ["invented rhythm", "Imaginary cortex", "imaginary cortex"]},
    "meshHeadingList": {"meshHeading": [
        {"majorTopic_YN": "N", "descriptorName": "Cortex, Invented", "meshQualifierList": {
            "meshQualifier": [{"abbreviation": "PH", "qualifierName": "physiology", "majorTopic_YN": "Y"}]}},
        {"majorTopic_YN": "N", "descriptorName": "Mice"}]},
    "grantsList": {"grant": [
        {"agency": "Fund for Invented Research", "grantId": "FIR-001", "orderIn": 0},
        {"agency": "Fund for Invented Research", "grantId": "FIR-002, FIR-003", "orderIn": 0},
        {"agency": "Imaginary Council", "orderIn": 0}]},
    "commentCorrectionList": {"commentCorrection": [
        {"id": "88888888", "source": "MED", "type": "Retraction in", "orderIn": 1,
         "reference": "J Invent Neurosci. 2026;12(4):1. doi: 10.5555/notice.1."},
        {"id": "77777777", "source": "MED", "type": "Erratum in", "orderIn": 2},
        {"id": "66666666", "source": "MED", "type": "Expression of concern in", "orderIn": 3},
        {"id": "55555555", "source": "MED", "type": "Comment in", "orderIn": 4},
        {"id": "PPR000001", "source": "PPR", "type": "Preprint in", "orderIn": 10002},
        {"id": "44444444", "source": "MED", "type": "Erratum for", "orderIn": 5},
        {"id": "33333333", "source": "MED", "type": "Update of", "orderIn": 6}]},
    "isOpenAccess": "Y", "citedByCount": 7, "license": "cc by-nc-nd",
    "electronicPublicationDate": "2026-03-14", "firstPublicationDate": "2026-03-14",
}


def jats(meta: str = "", body: str = "", back: str = "") -> dict:
    return biblio.from_jats(article(meta=meta, body=body, back=back))


# ─── the three JATS flavours ────────────────────────────────────────────────

def test_the_flavour_with_a_back():
    r = biblio.from_jats(BACK_FLAVOUR)
    assert (r["type"], r["language"]) == ("research-article", "en")
    assert r["abstract"] == ("Background: An invented question.\n\n"
                             "Results: An invented answer about Ca2+.")
    assert (r["volume"], r["issue"], r["pages"]) == ("12", "3", "101-115")
    assert r["license"] == "CC-BY-NC-4.0"
    assert r["journal"] == {"title": "Journal of Invented Neuroscience", "issn": "1234-5679",
                            "eissn": "2345-678X", "publisher": "Imaginary Press",
                            "nlm_ta": "J Invent Neurosci"}
    assert r["dates"] == {"received": "2026-01-02", "accepted": "2026-02-20", "epub": "2026-03-14",
                          "ppub": "2026-06", "collection": "", "first_publication": ""}
    assert r["keywords"] == ["invented rhythm", "imaginary cortex"]
    assert r["subjects"] == ["Biology and Life Sciences", "Neuroscience"]
    assert [a["name"] for a in r["authors"]] == ["Ada Example", "Bruno Sample"]    # no editor
    ada, bruno = r["authors"]
    assert (ada["position"], ada["given"], ada["family"]) == (1, "Ada", "Example")
    assert ada["affiliations"] == ["Institute of Invented Studies, Nowhere, Utopia"]
    assert ada["ror"] == ["0abcdef23"]
    assert bruno["affiliations"] == ["Institute of Invented Studies, Nowhere, Utopia",
                                     "Department of Fiction, Imaginary University, Elsewhere"]
    assert r["references"] == [{"doi": "10.5555/ref.one", "pmid": "11111111"}]
    assert r["references_count"] == 2
    assert r["rrids"] == [{"rrid": "RRID:SCR_999991", "kind": "SCR", "name": "Signals went through PretendSoft"}]
    assert r["statements"] == [{"kind": "data", "title": "Data availability",
                                "text": "The invented recordings sit in an imaginary archive."}]
    assert (r["cited_by_count"], r["is_open_access"], r["mesh"], r["integrity"]) == (None, None, [], [])


def test_the_flavour_without_a_back():
    r = biblio.from_jats(BODY_FLAVOUR)
    assert r["abstract"] == "An invented summary of pretend work."
    assert r["keywords"] == ["pretend physiology", "invented cortex", "toy model"]
    assert r["dates"] == {"received": "2026-03-14", "accepted": "2026-06-29", "epub": "2026-08-04",
                          "ppub": "", "collection": "2026", "first_publication": ""}
    assert r["pages"] == "286-293"
    assert r["license"] == "CC-BY-4.0"
    assert r["journal"] == {"title": "Frontiers of Nowhere", "issn": "", "eissn": "",
                            "publisher": "Invented Media", "nlm_ta": ""}
    # The reviewer report's reference is not the paper's.
    assert r["references"] == [{"doi": "10.5555/ref.body", "pmid": "22222222"}]
    assert r["references_count"] == 2
    # PMC's "Associated Data" copy and the section itself: one statement. The address hidden
    # behind "our archive" is kept.
    assert r["statements"] == [{
        "kind": "code_and_data", "title": "Data Availability Statement",
        "text": "The pretend data and the analysis code are in our archive (https://example.org/pretend)."}]
    assert r["funding"] == []


def test_front_matter_only():
    r = biblio.from_jats(FRONT_ONLY)
    assert r["type"] == "abstract"
    assert r["abstract"] == "Background: a pretend question.\n\nResults: a pretend answer."
    assert (r["pages"], r["issue"], r["license"]) == ("P-123", "Suppl 1", "CC0-1.0")
    assert r["dates"]["collection"] == "2026"
    assert (r["references"], r["references_count"], r["statements"]) == ([], None, [])
    # An <aff> that nobody points to belongs to every author.
    assert [a["affiliations"] for a in r["authors"]] == [["Invented Clinic, Nowhere"]] * 2
    assert "references" not in r["provenance"]


def test_every_key_is_always_present():
    for r in (biblio.empty(), biblio.from_jats(""), biblio.from_jats("<article><front>"),
              biblio.from_jats("not xml at all"), biblio.from_epmc({}), biblio.from_epmc(None),
              biblio.merge(), biblio.from_jats(FRONT_ONLY), biblio.from_epmc(CORE)):
        assert tuple(r) == biblio.FIELDS
        assert tuple(r["journal"]) == biblio.JOURNAL_KEYS
        assert tuple(r["dates"]) == biblio.DATE_KEYS
    blank = biblio.from_jats("not xml at all")
    assert blank == biblio.empty()
    assert biblio.from_jats(FRONT_ONLY.encode()) == biblio.from_jats(FRONT_ONLY)
    assert biblio.from_jats(None) == biblio.empty()
    assert (blank["cited_by_count"], blank["is_open_access"], blank["references_count"]) == (None, None, None)


# ─── authors ────────────────────────────────────────────────────────────────

def test_the_orcid_check_digit():
    assert biblio._orcid("https://orcid.org/0000-0002-1825-0097") == "0000-0002-1825-0097"
    assert biblio._orcid("0000000218250097") == "0000-0002-1825-0097"
    assert biblio._orcid("http://orcid.org/0000-0002-1694-233x") == "0000-0002-1694-233X"   # X = 10
    assert biblio._orcid("0000-0001-5109-3700") == "0000-0001-5109-3700"
    assert biblio._orcid("0000-0002-1825-0098") == ""        # wrong check digit
    assert biblio._orcid("0000-0002-1825-009") == ""
    assert biblio._orcid("") == ""
    r = biblio.from_jats(BACK_FLAVOUR)
    assert [a["orcid"] for a in r["authors"]] == ["0000-0002-1825-0097", ""]
    e = biblio.from_epmc(CORE)
    assert [a["orcid"] for a in e["authors"]] == ["0000-0002-1825-0097", "", ""]


def test_corresponding_authors():
    def people(extra_contribs: str, notes: str) -> list[bool]:
        r = jats(meta=f"<contrib-group>{extra_contribs}</contrib-group><author-notes>{notes}</author-notes>")
        return [a["corresponding"] for a in r["authors"]]

    contribs = (
        '<contrib contrib-type="author" corresp="yes"><name><surname>One</surname><given-names>Ann'
        '</given-names></name></contrib>'
        '<contrib contrib-type="author"><name><surname>Two</surname><given-names>Ben</given-names></name>'
        '<xref ref-type="corresp" rid="c1">*</xref></contrib>'
        '<contrib contrib-type="author"><name><surname>Three</surname><given-names>Cy</given-names></name>'
        '<xref ref-type="author-notes" rid="n1">†</xref></contrib>'
        '<contrib contrib-type="author"><name><surname>Four</surname><given-names>Di</given-names></name>'
        '<xref ref-type="fn" rid="n2">‡</xref></contrib>')
    notes = ('<corresp id="c1">* Invented address</corresp>'
             '<fn id="n1"><p>† Correspondence: Cy Three</p></fn>'
             '<fn id="n2"><p>‡ These authors contributed equally.</p></fn>')
    assert people(contribs, notes) == [True, True, True, False]
    # No pointer at all: a note that writes the full name (not a longer name that ends like it).
    plain = ('<contrib contrib-type="author"><name><surname>Liu</surname><given-names>Li</given-names>'
             '</name></contrib><contrib contrib-type="author"><name><surname>Ocio-Moliner</surname>'
             '<given-names>Mika</given-names></name></contrib>')
    assert people(plain, "<corresp>Correspondence to: Mika Ocio−Moliner and Guangli Liu</corresp>") \
        == [False, True]


def test_no_email_address_is_ever_stored():
    xml = article(
        meta=('<contrib-group><contrib contrib-type="author"><name><surname>Mailer</surname>'
              '<given-names>Max</given-names></name><email>max@example.org</email><xref ref-type="aff" '
              'rid="m1"/></contrib><aff id="m1">Invented Institute, Nowhere. E-mail: max@example.org</aff>'
              '</contrib-group><aff id="m2">Pretend Lab, Elsewhere <email>lab@example.org</email></aff>'
              '<author-notes><corresp>Correspondence: <email>max@example.org</email></corresp></author-notes>'
              '<abstract><p>An invented abstract; write to max@example.org for more.</p></abstract>'),
        back=('<sec><title>Data availability</title><p>Requests to pretend.author@example.org or '
              'data(at)example(dot)org, or <ext-link xlink:href="mailto:max@example.org">max@example.org'
              '</ext-link>.</p></sec>'))
    r = biblio.from_jats(xml)
    e = biblio.from_epmc(CORE)
    for record in (r, e, biblio.merge(r, e)):
        dumped = json.dumps(record)
        assert "@" not in dumped and "example.org" not in dumped and "(at)" not in dumped
    assert r["authors"][0]["affiliations"] == ["Invented Institute, Nowhere"]
    assert e["authors"][0]["affiliations"] == ["Institute of Invented Studies, Nowhere, Utopia"]
    assert r["statements"][0]["text"].startswith("Requests to")
    assert r["abstract"] == "An invented abstract; write to for more."
    # A record made by hand goes through the same filter when merged.
    hand = {"abstract": "Ask max@example.org.", "provenance": {"abstract": "jats"}}
    assert biblio.merge(hand)["abstract"] == "Ask."


def test_what_looks_like_an_address_but_is_not_one():
    # A git remote is a code address; "3M" is not a footnote number.
    r = jats(meta=('<contrib-group><contrib contrib-type="author"><name><surname>Corp</surname>'
                   '<given-names>Cy</given-names></name></contrib><aff>3M Pretend Company, Nowhere</aff>'
                   '</contrib-group>'),
             back=('<sec><title>Code availability</title><p>Clone git@github.com:pretend/toy.git to run '
                   'the pretend analysis.</p></sec>'))
    assert r["statements"][0]["text"] == "Clone git@github.com:pretend/toy.git to run the pretend analysis."
    assert r["authors"][0]["affiliations"] == ["3M Pretend Company, Nowhere"]


# ─── funding ────────────────────────────────────────────────────────────────

def test_funders_merge_on_their_name_or_their_id():
    r = biblio.from_jats(BACK_FLAVOUR)
    assert r["funding"] == [{"funder": "Fund for Invented Research", "funder_id": "10.13039/501100099999",
                             "awards": ["FIR-001", "FIR-002"]}]
    r = jats(meta=(
        '<funding-group><award-group><funding-source><institution-wrap><institution-id '
        'institution-id-type="FundRef">501100088888</institution-id><institution>Imaginary Council (IC)'
        '</institution></institution-wrap></funding-source><award-id>IC-1; IC-2</award-id></award-group>'
        '<award-group><funding-source><institution-wrap><institution-id institution-id-type="FundRef">'
        'http://dx.doi.org/10.13039/501100088888</institution-id><institution>The Imaginary Council of Nowhere'
        '</institution></institution-wrap></funding-source><award-id>IC-3</award-id></award-group>'
        '<award-group><funding-source><institution-wrap><institution-id institution-id-type="ROR">'
        'https://ror.org/0abcdef23</institution-id><institution>Institute of Invented Studies</institution>'
        '</institution-wrap></funding-source></award-group>'
        '<award-group><award-id>ORPHAN-9</award-id></award-group></funding-group>'))
    assert r["funding"] == [
        {"funder": "Imaginary Council (IC)", "funder_id": "10.13039/501100088888",
         "awards": ["IC-1", "IC-2", "IC-3"]},
        {"funder": "Institute of Invented Studies", "funder_id": "0abcdef23", "awards": []},
        {"funder": "", "funder_id": "", "awards": ["ORPHAN-9"]}]
    e = biblio.from_epmc(CORE)
    assert e["funding"] == [
        {"funder": "Fund for Invented Research", "funder_id": "", "awards": ["FIR-001", "FIR-002", "FIR-003"]},
        {"funder": "Imaginary Council", "funder_id": "", "awards": []}]


def test_funders_tagged_in_the_text_when_the_front_has_none():
    r = jats(back=(
        '<sec><title>Funding</title><p>Supported by the <funding-source id="f1">Pretend Foundation'
        '</funding-source> (<award-id rid="f1">PF-9</award-id>) and <funding-source id="f2">the '
        'Imaginary Council</funding-source>, grants <award-id rid="f2">IC-1</award-id> and '
        '<award-id>IC-2</award-id>.</p><p>Also by the <funding-source>Imaginary Council</funding-source> '
        '(<award-id>IC-3</award-id>).</p></sec>'))
    assert r["funding"] == [{"funder": "Pretend Foundation", "funder_id": "", "awards": ["PF-9"]},
                            {"funder": "Imaginary Council", "funder_id": "",
                             "awards": ["IC-1", "IC-2", "IC-3"]}]


# ─── references, RRIDs ──────────────────────────────────────────────────────

def test_a_ref_list_deep_inside_the_body():
    r = jats(body=(
        '<sec><title>Main</title><p>Invented.</p><sec><title>References</title><ref-list>'
        '<ref><mixed-citation>Doe J. A work. doi:10.5555/in.text.</mixed-citation></ref>'
        '<ref><mixed-citation>Roe R. Another. <ext-link xlink:href="https://pubmed.ncbi.nlm.nih.gov/3333333/">'
        'PubMed</ext-link></mixed-citation></ref>'
        '<ref><mixed-citation>Poe P. A third (doi: 10.5555/(sici)x).</mixed-citation></ref>'
        '<ref><mixed-citation>Doe J. A work. doi:10.5555/in.text.</mixed-citation></ref>'
        '</ref-list></sec></sec>'))
    assert r["references"] == [{"doi": "10.5555/in.text", "pmid": ""}, {"doi": "", "pmid": "3333333"},
                               {"doi": "10.5555/(sici)x", "pmid": ""}]
    assert r["references_count"] == 4


def test_rrids():
    long_lead = "An invented and deliberately long sentence that goes on and on about nothing at all " * 2
    r = jats(body=(
        '<sec><title>Methods</title>'
        '<p>Images went through PretendSoft (RRID:SCR_999991), ToyLab (RRID: SCR_999992) and FakeView '
        '(RRID:SCR_999991).</p>'
        '<p>Mice were kept. Pretend mice (Imaginary Lab, stock 000000, RRID:IMSR_JAX:000000) were used. '
        'Antibody anti-Pretend (1:500, RRID:AB_1234567).</p>'
        f'<p>{long_lead}RRID:SCR_999993.</p>'
        '<table-wrap><table><tr><th>Resource</th><th>Source</th><th>Identifier</th></tr>'
        '<tr><td>Rabbit anti-Invented</td><td>Imaginary Vendor</td><td>Cat# 1; RRID:AB_7654321</td></tr>'
        '<tr><td>Pretend plasmid</td><td>Invented Repository</td><td>RRID:Addgene_12345</td></tr></table>'
        '</table-wrap></sec>'))
    got = {x["rrid"]: (x["kind"], x["name"]) for x in r["rrids"]}
    assert got["RRID:SCR_999991"] == ("SCR", "Images went through PretendSoft")
    assert got["RRID:SCR_999992"] == ("SCR", "ToyLab")
    assert got["RRID:IMSR_JAX:000000"] == ("IMSR", "Pretend mice")
    assert got["RRID:AB_1234567"] == ("AB", "Antibody anti-Pretend")
    assert got["RRID:AB_7654321"] == ("AB", "Rabbit anti-Invented")
    assert got["RRID:Addgene_12345"] == ("Addgene", "Pretend plasmid")
    name = got["RRID:SCR_999993"][1]
    assert 0 < len(name) <= 80 and long_lead.strip().endswith(name)
    assert len(r["rrids"]) == 7                   # SCR_999991 twice in the text, once here


def test_rrids_of_a_table_whose_first_column_is_the_type():
    # eLife's key resources table: type, designation, source, identifiers.
    r = jats(body=(
        '<sec><title>Key resources</title><table-wrap><table><thead><tr><th>Reagent type (species) or '
        'resource</th><th>Designation</th><th>Source or reference</th><th>Identifiers</th></tr></thead><tbody>'
        '<tr><td>Antibody</td><td>anti-Pretend (rabbit)</td><td>Imaginary Vendor</td><td>RRID:AB_1111111</td></tr>'
        '<tr><td>Software, algorithm</td><td>ToyLab</td><td>Invented</td><td>RRID:SCR_999994</td></tr>'
        '</tbody></table></table-wrap></sec>'))
    assert [(x["rrid"], x["name"]) for x in r["rrids"]] == [
        ("RRID:AB_1111111", "anti-Pretend (rabbit)"), ("RRID:SCR_999994", "ToyLab")]


def test_keywords_packed_in_one_element():
    r = jats(meta=('<kwd-group><kwd>Keywords: pretend sleep; toy rhythm</kwd><kwd>poly I:C</kwd>'
                   '<kwd>Toy rhythm</kwd></kwd-group>'))
    assert r["keywords"] == ["pretend sleep", "toy rhythm", "poly I:C"]


def test_no_telephone_number_in_affiliations():
    r = jats(meta=('<contrib-group><contrib contrib-type="author"><name><surname>Ring</surname><given-names>Ro'
                   '</given-names></name></contrib><aff>Invented Institute, Nowhere 12345, Utopia; Tel.: '
                   '+99-12-345-678</aff><aff>Pretend Lab, 10 Toy Street, Elsewhere, +99 12 3456 7890, '
                   '+99 12 3456 7891</aff></contrib-group>'))
    assert r["authors"][0]["affiliations"] == ["Invented Institute, Nowhere 12345, Utopia",
                                               "Pretend Lab, 10 Toy Street, Elsewhere"]


# ─── availability statements ────────────────────────────────────────────────

def test_statements_under_various_titles():
    def sec(title: str, text: str, inner: str = "") -> str:
        return f"<sec><title>{title}</title><p>{text}</p>{inner}</sec>"

    r = jats(
        meta=('<abstract><sec><title>Motivation</title><p>An invented need.</p></sec><sec><title>Availability '
              'and implementation</title><p>The pretend tool is free.</p></sec></abstract>'
              '<custom-meta-group><custom-meta><meta-name>Data Availability</meta-name><meta-value>All pretend '
              'data are within the paper.</meta-value></custom-meta></custom-meta-group>'),
        body=(sec("Introduction", "Invented.", sec("Open science", "An invented history of sharing data and code."))
              + sec("Bioavailability of pretend compounds", "Invented data about absorption.")
              + sec("5.3. Recommendation 3: choose the model by data availability", "Invented advice on data.")
              + sec("Code availability", "The pretend scripts are online.")),
        back=(sec("Data and code availability", "Invented data and code are shared.")
              + sec("Software availability", "The pretend package is online.")
              + sec("Availability of data and materials", "The invented data are available on request.")
              + '<sec><title>Resource availability</title>'
              + sec("Lead contact", "Requests go to the lead contact.")
              + sec("Materials availability", "No new reagents were made.")
              + sec("Data and code availability", "Pretend recordings and analysis scripts are shared.")
              + "</sec>"
              + '<notes notes-type="data-availability"><p>Invented data sit in a pretend archive.</p></notes>'))
    got = [(s["kind"], s["title"]) for s in r["statements"]]
    assert got == [
        ("data", "Data Availability"),
        ("code", "Availability and implementation"),
        ("code", "Code availability"),
        ("code_and_data", "Data and code availability"),
        ("code", "Software availability"),
        ("data", "Availability of data and materials"),
        ("code_and_data", "Data and code availability"),
        ("data", "Data availability"),
    ]
    assert r["statements"][-2]["text"] == "Pretend recordings and analysis scripts are shared."


def test_a_statement_with_subsections_keeps_their_titles():
    r = jats(back=('<sec sec-type="data-availability"><title>Data availability</title>'
                   '<sec><title>Recordings</title><p>Invented files.</p></sec>'
                   '<sec><title>Code:</title><p>Pretend scripts.</p></sec></sec>'))
    assert r["statements"] == [{"kind": "code_and_data", "title": "Data availability",
                                "text": "Recordings: Invented files.\n\nCode: Pretend scripts."}]


# ─── licenses and dates ─────────────────────────────────────────────────────

@pytest.mark.parametrize("license_xml, expected", [
    ('<license xlink:href="http://creativecommons.org/licenses/by-nc-sa/3.0"><license-p>x</license-p></license>',
     "CC-BY-NC-SA-3.0"),
    ('<license><license-p>See https://creativecommons.org/publicdomain/zero/1.0/This text.</license-p></license>',
     "CC0-1.0"),
    ('<license><license-p>Under a Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International '
     'License.</license-p></license>', "CC-BY-NC-ND-4.0"),
    ('<license><license-p>Under the Creative Commons Attribution License (CC BY). Commercial use is fine.'
     '</license-p></license>', "CC-BY-4.0"),
    ('<license><license-p>This article is licensed under CC-BY-NC 4.0</license-p></license>', "CC-BY-NC-4.0"),
    ('<license><license-p>Under the Creative Commons Attribution-Noncommercial-Share Alike 3.0 Unported '
     'License.</license-p></license>', "CC-BY-NC-SA-3.0"),
    ('<license><license-p>Readers may use this pretend work for research only.</license-p></license>', "other"),
    ("", ""),
])
def test_license_spellings(license_xml, expected):
    assert jats(meta=f"<permissions>{license_xml}</permissions>")["license"] == expected


def test_epmc_licenses():
    assert [biblio._license_id(x) for x in ("cc by", "cc by-nc", "cc by-nc-sa", "cc0", "", "odd")] \
        == ["CC-BY-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC0-1.0", "", "other"]


def test_partial_dates():
    assert biblio._iso("2026", "Jun") == "2026-06"
    assert biblio._iso("2026", "", "12") == "2026"
    assert biblio._iso("2026", "2", "30") == "2026-02"          # no such day
    assert biblio._iso("26", "2", "3") == ""
    r = jats(meta='<pub-date date-type="pub" publication-format="print" iso-8601-date="2026-05"><year>2026</year>'
                  '</pub-date><pub-date pub-type="epub-ppub"><season>Spring</season><year>2025</year></pub-date>')
    assert (r["dates"]["ppub"], r["dates"]["epub"]) == ("2026-05", "2025")


# ─── E: the Europe PMC record ───────────────────────────────────────────────

def test_the_europe_pmc_record():
    e = biblio.from_epmc(CORE)
    assert (e["type"], e["language"]) == ("research-article", "en")
    assert e["abstract"] == ("Background: An invented question with italics where p<0.05.\n\n"
                             "Results: An invented answer.")
    assert (e["volume"], e["issue"], e["pages"]) == ("12", "3", "101-115")
    assert (e["cited_by_count"], e["is_open_access"], e["license"]) == (7, True, "CC-BY-NC-ND-4.0")
    assert e["journal"] == {"title": "Journal of invented neuroscience", "issn": "1234-5679",
                            "eissn": "2345-678X", "publisher": "", "nlm_ta": "J Invent Neurosci"}
    # "2026 Jun", not the made-up day of printPublicationDate.
    assert e["dates"] == {"received": "", "accepted": "", "epub": "2026-03-14", "ppub": "2026-06",
                          "collection": "", "first_publication": "2026-03-14"}
    assert e["keywords"] == ["invented rhythm", "Imaginary cortex"]
    assert e["mesh"] == [{"term": "Cortex, Invented", "major": True, "qualifiers": ["physiology"]},
                         {"term": "Mice", "major": False, "qualifiers": []}]
    assert [(a["position"], a["name"], a["given"], a["family"]) for a in e["authors"]] == [
        (1, "Ada Example", "Ada", "Example"), (2, "Bruno Sample", "Bruno", "Sample"),
        (3, "The Pretend Consortium", "", "")]
    assert not any(a["corresponding"] for a in e["authors"])
    assert (e["references"], e["references_count"], e["statements"], e["subjects"]) == ([], None, [], [])
    assert e["integrity"] == [
        {"kind": "retraction", "id": "88888888", "source": "MED", "relation": "Retraction in",
         "doi": "10.5555/notice.1"},
        {"kind": "correction", "id": "77777777", "source": "MED", "relation": "Erratum in", "doi": ""},
        {"kind": "concern", "id": "66666666", "source": "MED", "relation": "Expression of concern in", "doi": ""},
        {"kind": "comment", "id": "55555555", "source": "MED", "relation": "Comment in", "doi": ""}]
    assert set(e["provenance"].values()) == {"epmc"}


@pytest.mark.parametrize("types, expected", [
    (["research-article", "Journal Article"], "research-article"),     # the JATS type first
    (["Published Erratum", "correction"], "correction"),
    (["Retraction of Publication", "Journal Article"], "retraction"),
    (["Expression of Concern"], "expression-of-concern"),
    (["Review", "Journal Article"], "review-article"),
    (["Systematic Review", "Meta-Analysis", "Journal Article"], "systematic-review"),
    (["Case Reports", "Journal Article"], "case-report"),
    (["Retracted Publication", "Journal Article"], "research-article"),
    (["Randomized Controlled Trial"], "research-article"),
    (["Preprint"], "preprint"),
    (["other"], "other"),
    ([], ""),
])
def test_europe_pmc_types(types, expected):
    assert biblio.from_epmc({"pubTypeList": {"pubType": types}})["type"] == expected


def test_a_notice_keeps_what_it_is_about():
    notice = {"pubTypeList": {"pubType": ["Retraction of Publication"]}, "commentCorrectionList": {
        "commentCorrection": [{"id": "12121212", "source": "MED", "type": "Retraction of"},
                              {"id": "13131313", "source": "MED", "type": "Comment on"}]}}
    assert biblio.from_epmc(notice)["integrity"] == [
        {"kind": "retraction", "id": "12121212", "source": "MED", "relation": "Retraction of", "doi": ""}]


def test_europe_pmc_preprints_and_electronic_journals():
    preprint = biblio.from_epmc({
        "source": "PPR", "id": "PPR000001", "pubTypeList": {"pubType": ["Preprint"]},
        "bookOrReportDetails": {"publisher": "Pretend Rxiv", "yearOfPublication": 2026},
        "license": "cc by", "isOpenAccess": "N", "citedByCount": 0, "firstPublicationDate": "2026-09-03",
        "authorList": {"author": [{"fullName": "Doe J", "firstName": "Jo", "lastName": "Doe",
                                   "authorAffiliationDetailsList": {"authorAffiliation": [
                                       {"affiliation": "Centre for Pretending, , ,"}]}}]}})
    assert (preprint["type"], preprint["journal"]["publisher"], preprint["license"]) == \
        ("preprint", "Pretend Rxiv", "CC-BY-4.0")
    assert (preprint["cited_by_count"], preprint["is_open_access"]) == (0, False)
    assert preprint["authors"][0]["affiliations"] == ["Centre for Pretending"]
    online = biblio.from_epmc({"pubModel": "Electronic-eCollection", "journalInfo": {
        "dateOfPublication": "2022 Nov-Dec", "journal": {"title": "x"}}})
    assert online["dates"]["collection"] == "2022-11"
    blank = biblio.from_epmc({"journalInfo": {"dateOfPublication": " ", "monthOfPublication": 0,
                                              "yearOfPublication": 0}})
    assert blank["dates"] == biblio.empty()["dates"]


# ─── merge ──────────────────────────────────────────────────────────────────

def test_merge_keeps_the_first_non_empty_value_and_says_where_it_came_from():
    j = biblio.from_jats(BODY_FLAVOUR)
    e = biblio.from_epmc(dict(CORE, authorList={"author": [
        {"firstName": "Iris", "lastName": "Quill", "authorId": {"type": "ORCID", "value": "0000-0002-1825-0097"}},
        {"firstName": "O.", "lastName": "Nib", "authorId": {"type": "ORCID", "value": "0000-0001-5109-3700"}}]}))
    before = copy.deepcopy((j, e))
    m = biblio.merge(j, e)
    assert (j, e) == before                                   # the inputs are not modified
    assert tuple(m) == biblio.FIELDS
    assert m["abstract"] == j["abstract"] and m["provenance"]["abstract"] == "jats"
    assert m["mesh"] == e["mesh"] and m["provenance"]["mesh"] == "epmc"
    assert (m["cited_by_count"], m["provenance"]["cited_by_count"]) == (7, "epmc")
    # `journal` and `dates`: key by key, dotted provenance.
    assert m["journal"] == {"title": "Frontiers of Nowhere", "issn": "1234-5679", "eissn": "2345-678X",
                            "publisher": "Invented Media", "nlm_ta": "J Invent Neurosci"}
    assert (m["provenance"]["journal.title"], m["provenance"]["journal.issn"]) == ("jats", "epmc")
    assert m["dates"]["received"] == "2026-03-14" and m["provenance"]["dates.received"] == "jats"
    assert m["dates"]["first_publication"] == "2026-03-14"
    assert m["provenance"]["dates.first_publication"] == "epmc"
    assert "journal" not in m["provenance"] and "dates" not in m["provenance"]
    # The authors come from the JATS; their missing ORCIDs from Europe PMC.
    assert [(a["name"], a["orcid"], a["corresponding"]) for a in m["authors"]] == [
        ("Iris Quill", "0000-0002-1825-0097", False), ("Otto Nib", "0000-0001-5109-3700", True)]
    assert (m["provenance"]["authors"], m["provenance"]["authors.orcid"]) == ("jats", "epmc")
    # The other order gives the other source.
    assert biblio.merge(e, j)["abstract"] == e["abstract"]
    assert biblio.merge(e, j)["provenance"]["abstract"] == "epmc"


def test_merge_details():
    j = biblio.from_jats(BACK_FLAVOUR)
    e = biblio.from_epmc(dict(CORE, isOpenAccess="N", citedByCount=0))
    m = biblio.merge(j, e)
    # False and 0 are answers, not blanks.
    assert (m["is_open_access"], m["cited_by_count"]) == (False, 0)
    # An ORCID is never taken from another person, nor used twice.
    other = {"authors": [{"given": "Bruno", "family": "Sampler", "orcid": "0000-0001-5109-3700"}],
             "provenance": {"authors": "epmc"}}
    assert biblio.merge(j, other)["authors"][1]["orcid"] == ""
    assert "authors.orcid" not in biblio.merge(j, other)["provenance"]
    twin = {"authors": [{"given": "Ada", "family": "Example", "orcid": "0000-0002-1825-0097"},
                        {"given": "Bruno", "family": "Sample", "orcid": "0000-0002-1825-0097"}]}
    assert biblio.merge(j, twin)["authors"][1]["orcid"] == ""
    # Merging a merged record keeps its provenance.
    again = biblio.merge(m, biblio.empty())
    assert again == m
    assert biblio.merge() == biblio.empty()
