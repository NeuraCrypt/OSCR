from oscr import find, jats

HEADER = ('<article xmlns:xlink="http://www.w3.org/1999/xlink"><front><article-meta>'
          '<title-group><article-title>Alpha waves in the cortex</article-title></title-group>'
          '<contrib-group><contrib contrib-type="author"><name><surname>Schmidt</surname>'
          '<given-names>F</given-names></name></contrib></contrib-group>')


def article(extra_meta="", body="", back=""):
    return (HEADER + extra_meta + "</article-meta></front><body>" + body + "</body><back>"
            + back + "</back></article>")


def test_the_plos_statement_in_bare_text_is_read():
    # PLOS files the statement in a custom-meta, without a paragraph (PMC12037073).
    xml = article(extra_meta=(
        '<custom-meta-group><custom-meta><meta-name>Data Availability</meta-name><meta-value>'
        'The latest code can be found on GitHub at <ext-link ext-link-type="uri" '
        'xlink:href="https://github.com/LaetitiaG/wavesmodel">https://github.com/LaetitiaG/wavesmodel'
        '</ext-link>.</meta-value></custom-meta></custom-meta-group>'))
    f = find.from_text(jats.parse(xml))
    code = [c for c in f.candidates if c.role == "code"]
    assert [c.link.repo for c in code] == ["github.com/laetitiag/wavesmodel"]


def test_the_reference_call_does_not_stick_to_the_doi():
    # "zenodo.15795242" + superscript "93" gave zenodo:1579524293 (PMC12381021).
    xml = article(back=('<sec><title>Code availability</title><p>The analysis code will be '
                        'released at 10.5281/zenodo.15795242<xref ref-type="bibr">93</xref>.</p></sec>'))
    f = find.from_text(jats.parse(xml))
    assert [c.link.repo for c in f.candidates] == ["zenodo:15795242"]


def test_a_sentence_stops_at_the_full_stop_after_the_url():
    t = ("The connectomes are publicly available at a repository (https://doi.org/10.5061/dryad.np5hqc00n). "
         "All code used is available at https://github.com/palvalab/vwm.")
    s = jats.sentence_around(t, "https://doi.org/10.5061/dryad.np5hqc00n")
    assert "All code" not in s


def test_a_link_alone_in_parentheses_takes_the_previous_sentence():
    t = ("Deidentified imaging data are saved in the OSF and are publicly available. "
         "(https://osf.io/pd4h9/files/osfstorage). Other data are on request.")
    s = jats.sentence_around(t, "https://osf.io/pd4h9/files/osfstorage")
    assert "publicly available" in s


def test_an_accession_tagged_by_the_publisher_is_not_a_link():
    xml = article(body=('<sec><title>Participants</title><p>Approved by the committee '
                        '(MSD-IDREC-<ext-link ext-link-type="gen" xlink:href="R81071">R81071</ext-link>).'
                        '</p></sec>'))
    assert jats.parse(xml).mentions == []


def test_the_reference_signed_by_the_authors_is_their_code():
    # Untagged reference, author written as "Surname Initial" (PMC12490856).
    xml = article(back=('<ref-list><ref><mixed-citation>Schmidt F. ECG_1f_memory. Software Heritage. 2023 '
                        '<ext-link ext-link-type="uri" xlink:href="https://github.com/schmidtfa/ecg_1f_memory">'
                        'x</ext-link></mixed-citation></ref></ref-list>'))
    f = find.from_text(jats.parse(xml))
    assert [(c.link.repo, c.role) for c in f.candidates] == [("github.com/schmidtfa/ecg_1f_memory", "code")]


def test_only_attached_scripts_and_code_archives_count():
    xml = article(body=(
        '<sec><title>Supplementary material</title>'
        '<supplementary-material xlink:href="elife-1-code1.zip"><label>Source code 1</label>'
        '<caption><p>MATLAB code to reproduce the figures.</p></caption></supplementary-material>'
        '<supplementary-material xlink:href="elife-1-supp1.docx"><caption><p>Transfer function '
        'estimates for each participant.</p></caption></supplementary-material>'
        '<supplementary-material xlink:href="fig5.eps"><caption><p>Response functions.</p></caption>'
        '</supplementary-material>'
        '<supplementary-material xlink:href="analysis.py"><caption><p>Analysis.</p></caption>'
        '</supplementary-material></sec>'))
    f = find.from_text(jats.parse(xml))
    assert sorted(c.link.identifier for c in f.candidates) == ["analysis.py", "elife-1-code1.zip"]


def test_an_archive_declared_as_data_elsewhere_keeps_the_code_of_the_text():
    from oscr import links
    from oscr.jats import Mention
    xml = article(back=('<sec sec-type="data-availability"><title>Data availability</title><p>All '
                        'source data, as well as the source code, are deposited in Dryad '
                        'https://doi.org/10.5061/dryad.s4mw6m9gf.</p></sec>'))
    text = find.from_text(jats.parse(xml)).candidates
    meta = find.from_metadata(
        [Mention("https://doi.org/10.5061/dryad.s4mw6m9gf", "DataCite: Dataset 'Data from: x'",
                 ("DataCite",), "metadata", "datacite:Dataset:own")], ["Schmidt"], "T")
    merged = find.merge(text, meta)
    assert [(c.link.repo, c.role) for c in merged] == [("doi:10.5061/dryad.s4mw6m9gf", "code")]
    assert links.normalize("10.5061/dryad.s4mw6m9gf").kind == "archive"


def test_the_generated_dataset_cited_in_the_statement_is_a_signed_reference():
    # eLife: "The following dataset was generated:" + element-citation (PMC9754634),
    # with the Dryad DOI missing its dot.
    xml = article(back=(
        '<sec sec-type="data-availability"><title>Data availability</title>'
        '<p>All numerical data have been deposited in Dryad.</p>'
        '<p>The following dataset was generated:</p><p><element-citation publication-type="data">'
        '<person-group person-group-type="author"><name><surname>Schmidt</surname>'
        '<given-names>F</given-names></name></person-group><year>2022</year>'
        '<data-title>Data from: Alpha waves</data-title><source>Dryad Digital Repository</source>'
        '<pub-id pub-id-type="doi">10.5061/dryadgf1vhhmqx</pub-id></element-citation></p></sec>'))
    f = find.from_text(jats.parse(xml))
    assert [(c.link.repo, c.role, c.found_by) for c in f.candidates] == [
        ("doi:10.5061/dryad.gf1vhhmqx", "data", "text:references")]


def test_code_on_request():
    xml = article(back=('<sec><title>Data and code availability</title><p>The data and code that '
                        'support the findings are available from the corresponding author upon '
                        'reasonable request.</p></sec>'))
    f = find.from_text(jats.parse(xml))
    assert f.code_on_request and f.has_statement and not f.candidates
