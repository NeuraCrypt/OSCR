from scrapper import jats, trouver

ENTETE = ('<article xmlns:xlink="http://www.w3.org/1999/xlink"><front><article-meta>'
          '<title-group><article-title>Alpha waves in the cortex</article-title></title-group>'
          '<contrib-group><contrib contrib-type="author"><name><surname>Schmidt</surname>'
          '<given-names>F</given-names></name></contrib></contrib-group>')


def article(meta_en_plus="", corps="", fond=""):
    return (ENTETE + meta_en_plus + "</article-meta></front><body>" + corps + "</body><back>"
            + fond + "</back></article>")


def test_la_declaration_plos_en_texte_nu_est_lue():
    # PLOS range la déclaration dans un custom-meta, sans paragraphe (PMC12037073).
    xml = article(meta_en_plus=(
        '<custom-meta-group><custom-meta><meta-name>Data Availability</meta-name><meta-value>'
        'The latest code can be found on GitHub at <ext-link ext-link-type="uri" '
        'xlink:href="https://github.com/LaetitiaG/wavesmodel">https://github.com/LaetitiaG/wavesmodel'
        '</ext-link>.</meta-value></custom-meta></custom-meta-group>'))
    b = trouver.depuis_le_texte(jats.lire(xml))
    code = [c for c in b.candidats if c.role == "code"]
    assert [c.lien.norme for c in code] == ["github.com/laetitiag/wavesmodel"]


def test_l_appel_de_reference_ne_se_colle_pas_au_doi():
    # « zenodo.15795242 » + exposant « 93 » donnait zenodo:1579524293 (PMC12381021).
    xml = article(fond=('<sec><title>Code availability</title><p>The analysis code will be '
                        'released at 10.5281/zenodo.15795242<xref ref-type="bibr">93</xref>.</p></sec>'))
    b = trouver.depuis_le_texte(jats.lire(xml))
    assert [c.lien.norme for c in b.candidats] == ["zenodo:15795242"]


def test_une_phrase_s_arrete_au_point_qui_suit_l_url():
    t = ("The connectomes are publicly available at a repository (https://doi.org/10.5061/dryad.np5hqc00n). "
         "All code used is available at https://github.com/palvalab/vwm.")
    p = jats.phrase_autour(t, "https://doi.org/10.5061/dryad.np5hqc00n")
    assert "All code" not in p


def test_un_lien_seul_entre_parentheses_prend_la_phrase_precedente():
    t = ("Deidentified imaging data are saved in the OSF and are publicly available. "
         "(https://osf.io/pd4h9/files/osfstorage). Other data are on request.")
    p = jats.phrase_autour(t, "https://osf.io/pd4h9/files/osfstorage")
    assert "publicly available" in p


def test_une_accession_fouillee_par_l_editeur_n_est_pas_un_lien():
    xml = article(corps=('<sec><title>Participants</title><p>Approved by the committee '
                         '(MSD-IDREC-<ext-link ext-link-type="gen" xlink:href="R81071">R81071</ext-link>).'
                         '</p></sec>'))
    assert jats.lire(xml).occurrences == []


def test_la_reference_signee_par_les_auteurs_est_leur_code():
    # Référence non balisée, auteur écrit « Nom Initiale » (PMC12490856).
    xml = article(fond=('<ref-list><ref><mixed-citation>Schmidt F. ECG_1f_memory. Software Heritage. 2023 '
                        '<ext-link ext-link-type="uri" xlink:href="https://github.com/schmidtfa/ecg_1f_memory">'
                        'x</ext-link></mixed-citation></ref></ref-list>'))
    b = trouver.depuis_le_texte(jats.lire(xml))
    assert [(c.lien.norme, c.role) for c in b.candidats] == [("github.com/schmidtfa/ecg_1f_memory", "code")]


def test_seuls_les_scripts_et_les_archives_de_code_joints_comptent():
    xml = article(corps=(
        '<sec><title>Supplementary material</title>'
        '<supplementary-material xlink:href="elife-1-code1.zip"><label>Source code 1</label>'
        '<caption><p>MATLAB code to reproduce the figures.</p></caption></supplementary-material>'
        '<supplementary-material xlink:href="elife-1-supp1.docx"><caption><p>Transfer function '
        'estimates for each participant.</p></caption></supplementary-material>'
        '<supplementary-material xlink:href="fig5.eps"><caption><p>Response functions.</p></caption>'
        '</supplementary-material>'
        '<supplementary-material xlink:href="analyse.py"><caption><p>Analysis.</p></caption>'
        '</supplementary-material></sec>'))
    b = trouver.depuis_le_texte(jats.lire(xml))
    assert sorted(c.lien.identifiant for c in b.candidats) == ["analyse.py", "elife-1-code1.zip"]


def test_une_archive_declaree_donnees_ailleurs_garde_le_code_du_texte():
    from scrapper import liens
    from scrapper.jats import Occurrence
    xml = article(fond=('<sec sec-type="data-availability"><title>Data availability</title><p>All '
                        'source data, as well as the source code, are deposited in Dryad '
                        'https://doi.org/10.5061/dryad.s4mw6m9gf.</p></sec>'))
    texte = trouver.depuis_le_texte(jats.lire(xml)).candidats
    meta = trouver.depuis_les_metadonnees(
        [Occurrence("https://doi.org/10.5061/dryad.s4mw6m9gf", "DataCite : Dataset « Data from: x »",
                    ("DataCite",), "metadonnees", "datacite:Dataset:propre")], ["Schmidt"], "T")
    fus = trouver.fusionner(texte, meta)
    assert [(c.lien.norme, c.role) for c in fus] == [("doi:10.5061/dryad.s4mw6m9gf", "code")]
    assert liens.normaliser("10.5061/dryad.s4mw6m9gf").genre == "archive"


def test_le_jeu_genere_cite_dans_la_declaration_est_une_reference_signee():
    # eLife : « The following dataset was generated: » + element-citation (PMC9754634),
    # avec le DOI Dryad sans son point.
    xml = article(fond=(
        '<sec sec-type="data-availability"><title>Data availability</title>'
        '<p>All numerical data have been deposited in Dryad.</p>'
        '<p>The following dataset was generated:</p><p><element-citation publication-type="data">'
        '<person-group person-group-type="author"><name><surname>Schmidt</surname>'
        '<given-names>F</given-names></name></person-group><year>2022</year>'
        '<data-title>Data from: Alpha waves</data-title><source>Dryad Digital Repository</source>'
        '<pub-id pub-id-type="doi">10.5061/dryadgf1vhhmqx</pub-id></element-citation></p></sec>'))
    b = trouver.depuis_le_texte(jats.lire(xml))
    assert [(c.lien.norme, c.role, c.trouve_par) for c in b.candidats] == [
        ("doi:10.5061/dryad.gf1vhhmqx", "donnees", "texte:references")]


def test_code_sur_demande():
    xml = article(fond=('<sec><title>Data and code availability</title><p>The data and code that '
                        'support the findings are available from the corresponding author upon '
                        'reasonable request.</p></sec>'))
    b = trouver.depuis_le_texte(jats.lire(xml))
    assert b.code_sur_demande and b.a_une_declaration and not b.candidats
