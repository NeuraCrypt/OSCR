"""oscr.classify: the classification rules (D6, D7), the GPU window, and the annotation tools.

Every paper here is INVENTED: made-up titles and abstracts, never text from a real paper.
No model is called: tools/compare_models.py is tested on its metrics, its parsing and its
refusals only.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from datetime import UTC, datetime, timedelta
from datetime import time as dtime
from pathlib import Path

import pytest

from oscr import classify as C

ROOT = Path(__file__).resolve().parents[1]


def _tool(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


sample_tool = _tool("make_annotation_sample")
cm = _tool("compare_models")


def values(result: dict, facet: str) -> list[str]:
    return [v["value"] for v in result[facet]["values"]]


def settled(result: dict, facet: str) -> list[str]:
    f = result[facet]
    assert not f["ambiguous"], (facet, f)
    return [v["value"] for v in f["values"]]


# --------------------------------------------------------------------------------------
# Synthetic papers
# --------------------------------------------------------------------------------------

EEG_STUDY = {
    "title": "Frontal theta during an invented rule-switching game: an EEG study",
    "abstract": ("Switching between rules is thought to engage the frontal cortex. Here we recorded "
                 "64-channel EEG in 40 healthy adult participants while they played an invented "
                 "rule-switching game. EEG theta power rose after each switch, and the EEG effect "
                 "scaled with reaction times across participants."),
    "keywords": ["EEG", "cognitive control"],
    "journal": "Journal of Imaginary Neuroscience",
    "type": "research-article",
}
GNN_PAPER = {
    "title": "A graph neural network predicts the tensile strength of recycled polymers",
    "abstract": ("We trained a graph neural network on 12,000 simulated polymer structures. A "
                 "convolutional neural network baseline was outperformed by 8%. The model "
                 "generalizes to unseen polymer composites and alloys."),
    "keywords": ["graph neural network", "polymers"],
    "journal": "Journal of Polymer Informatics",
    "type": "research-article",
}
BONE_PAPER = {
    "title": "Cortical bone thickness of the femur after an invented hip arthroplasty",
    "abstract": ("Femoral cortical bone was measured in 50 patients before and after surgery. "
                 "Cortical bone thickness fell by 6% and two periprosthetic fractures occurred."),
    "journal": "Journal of Orthopaedic Fiction",
    "type": "research-article",
}
SURVEY_PAPER = {
    "title": "Stress, anxiety and depression among university students: a cross-sectional survey",
    "abstract": ("We surveyed 900 university students with an online questionnaire on anxiety, "
                 "depression and perceived stress. Anxiety was reported by 31% of students and "
                 "depression by 22%; students with part-time jobs reported more anxiety."),
    "journal": "Journal of Campus Life",
    "type": "research-article",
}
PASSING_MENTION = {
    "title": "Lipid rafts in the membranes of an invented yeast strain",
    "abstract": ("Similar rafts may also exist in the brain. We isolated membranes from an invented "
                 "yeast strain and measured their lipid composition by chromatography. Raft "
                 "fractions held twice as much ergosterol as the rest of the membrane."),
    "journal": "Journal of Yeast Fiction",
    "type": "research-article",
}
FMRI_STUDY = {
    "title": "Reward anticipation in a fictional lottery: a functional MRI study",
    "abstract": ("Here we used functional magnetic resonance imaging (fMRI) in 30 volunteers. The "
                 "BOLD signal of the ventral striatum rose during anticipation, and fMRI responses "
                 "predicted choices. All MRI data were acquired on one scanner."),
    "type": "research-article",
}
SEEG_STUDY = {
    "title": "High-gamma responses to invented words in stereo-EEG recordings",
    "abstract": ("We recorded stereo-EEG from depth electrodes in 12 patients with drug-resistant "
                 "epilepsy. High-gamma activity in the temporal cortex followed invented words, and "
                 "the SEEG responses were strongest in the superior temporal gyrus."),
    "type": "research-article",
}
PATCH_STUDY = {
    "title": "Whole-cell patch-clamp recordings of an invented interneuron type in mouse slices",
    "abstract": ("We made whole-cell patch-clamp recordings from invented interneurons in acute "
                 "hippocampal slices of adult mice. The cells fired at 80 Hz and showed large "
                 "IPSCs after stimulation; in mice lacking a made-up gene, IPSCs were halved."),
    "type": "research-article",
}
IPSC_STUDY = {
    "title": "Human iPSC-derived astrocytes secrete an invented factor",
    "abstract": ("We differentiated human iPSC lines into astrocytes and measured an invented "
                 "factor in the medium. The iPSC-derived astrocytes secreted three times more "
                 "factor than fibroblasts did."),
    "type": "research-article",
}
IMAGING_STUDY = {
    "title": "Two-photon calcium imaging of invented place cells in mice",
    "abstract": ("We imaged GCaMP6s in hippocampal CA1 of head-fixed mice running in virtual "
                 "reality. Two-photon calcium imaging revealed that 30% of neurons were place "
                 "cells, and calcium transients sharpened with learning."),
    "type": "research-article",
}
PSYCHOPHYSICS_STUDY = {
    "title": "Visual crowding of invented letters: a psychophysics study",
    "abstract": ("Here, 24 adult participants identified invented letters flanked by distractors. "
                 "Reaction times and accuracy were measured in a psychophysics paradigm; "
                 "crowding grew with eccentricity in every participant."),
    "type": "research-article",
}
MODEL_STUDY = {
    "title": "A spiking network model of an invented working-memory task",
    "abstract": ("We present a computational model of working memory. Simulations of a spiking "
                 "network model with 10,000 integrate-and-fire neurons reproduce persistent "
                 "activity, and the simulations predict a new form of attractor dynamics."),
    "type": "research-article",
}
CASE_REPORT = {
    "title": "Focal seizures after eating an invented fruit: a case report",
    "abstract": ("A 34-year-old man presented with focal seizures two hours after eating an "
                 "invented fruit. EEG showed temporal spikes; the seizures stopped with an "
                 "antiseizure drug and the epilepsy did not recur."),
    "type": "case-report",
}
LTD_STUDY = {
    "title": "Long-term depression at invented synapses in rat hippocampal slices",
    "abstract": ("We induced long-term depression at invented synapses in hippocampal slices of "
                 "rats. Long-term depression required an invented receptor, and synaptic "
                 "depression of transmission lasted two hours."),
    "type": "research-article",
}
AD_STUDY = {
    "title": "Amyloid PET in patients with Alzheimer's disease and healthy controls",
    "abstract": ("We scanned 60 patients with Alzheimer's disease and 40 healthy controls with "
                 "amyloid PET. Amyloid burden was higher in patients with Alzheimer's disease and "
                 "tracked their memory scores."),
    "type": "research-article",
}
WORM_STUDY = {
    "title": "Chemotaxis toward an invented odor in C. elegans",
    "abstract": ("We tracked C. elegans worms on plates with an invented odor. Mutant C. elegans "
                 "lacking a made-up receptor crawled away from the odor."),
    "type": "research-article",
}
TOOLBOX_PAPER = {
    "title": "An open-source toolbox for invented EEG artifacts",
    "abstract": ("We present a new open-source toolbox that removes invented artifacts from EEG. "
                 "The software is written in Python, and its pipeline was validated on simulated "
                 "EEG and on a public dataset."),
    "type": "methods-article",
}


# --------------------------------------------------------------------------------------
# on_topic and D7
# --------------------------------------------------------------------------------------

def test_neuroscience_paper_is_on_topic():
    r = C.classify(EEG_STUDY)
    assert settled(r, "on_topic") == ["yes"]
    assert r["on_topic"]["values"][0]["confidence"] >= C.ON_TOPIC_DECIDE
    assert any(reason.startswith("title: ") for reason in r["on_topic"]["values"][0]["reasons"])
    assert C.is_publishable(r)


@pytest.mark.parametrize("paper", [GNN_PAPER, BONE_PAPER], ids=["neural network", "cortical bone"])
def test_off_topic_papers_are_detected(paper):
    r = C.classify(paper)
    assert settled(r, "on_topic") == ["no"]
    assert not C.is_publishable(r)
    assert C.needs_model(r) == []          # off-topic with confidence: no model is asked


def test_the_masked_phrase_is_given_as_a_reason():
    reasons = C.classify(GNN_PAPER)["on_topic"]["values"][0]["reasons"]
    assert any("graph neural network" in r.lower() and "machine learning" in r for r in reasons)


def test_questionnaire_psychology_without_neural_measures_leans_off_topic():
    r = C.classify(SURVEY_PAPER)
    assert values(r, "on_topic") == ["no"]


def test_a_neuroscience_word_in_passing_is_not_enough():
    r = C.classify(PASSING_MENTION)
    v = r["on_topic"]["values"][0]
    assert v["value"] == "no" or r["on_topic"]["ambiguous"]
    assert any("passing" in reason for reason in v["reasons"] + ["passing"])


def test_is_publishable_follows_the_threshold():
    def result(value, confidence):
        return {"on_topic": {"values": [{"value": value, "confidence": confidence, "reasons": []}],
                             "ambiguous": confidence < C.ON_TOPIC_DECIDE}}
    assert not C.is_publishable(result("no", 0.9))
    assert C.is_publishable(result("no", 0.6))          # an uncertain "no" waits for the model
    assert C.is_publishable(result("yes", 0.99))
    assert not C.is_publishable(result("no", 0.6), threshold=0.5)
    assert C.is_publishable({})


# --------------------------------------------------------------------------------------
# modality
# --------------------------------------------------------------------------------------

def test_modality_rules():
    assert settled(C.classify(EEG_STUDY), "modality") == ["eeg"]
    assert "intracellular" in settled(C.classify(PATCH_STUDY), "modality")
    assert "optical" in settled(C.classify(IMAGING_STUDY), "modality")


def test_an_fmri_study_that_says_mri_is_not_structural_mri():
    assert settled(C.classify(FMRI_STUDY), "modality") == ["fmri"]


def test_stereo_eeg_is_intracranial_not_scalp_eeg():
    modality = settled(C.classify(SEEG_STUDY), "modality")
    assert "ieeg" in modality and "eeg" not in modality


def test_ipsc_is_not_an_inhibitory_current():
    assert "intracellular" not in values(C.classify(IPSC_STUDY), "modality")


def test_behavior_only_and_modeling_only_without_neural_data():
    assert settled(C.classify(PSYCHOPHYSICS_STUDY), "modality") == ["behavior"]
    r = C.classify(MODEL_STUDY)
    assert settled(r, "modality") == ["modeling"]
    assert settled(r, "organism") == ["none"]
    assert settled(r, "population") == []            # no subjects: not applicable
    assert "population=-" in C.explain(r)


def test_behavior_is_dropped_when_neural_data_is_found():
    assert "behavior" not in values(C.classify(EEG_STUDY), "modality")


# --------------------------------------------------------------------------------------
# organism, population, subfield
# --------------------------------------------------------------------------------------

def test_organism_rules():
    assert settled(C.classify(EEG_STUDY), "organism") == ["human"]
    assert settled(C.classify(PATCH_STUDY), "organism") == ["mouse"]
    assert settled(C.classify(LTD_STUDY), "organism") == ["rat"]
    assert settled(C.classify(WORM_STUDY), "organism") == ["c_elegans"]
    assert settled(C.classify(CASE_REPORT), "organism") == ["human"]


def test_population_rules():
    assert settled(C.classify(CASE_REPORT), "population") == ["epilepsy"]
    assert settled(C.classify(EEG_STUDY), "population") == ["healthy"]
    assert "alzheimers" in settled(C.classify(AD_STUDY), "population")


def test_healthy_controls_do_not_make_a_healthy_population():
    assert "healthy" not in values(C.classify(AD_STUDY), "population")


def test_long_term_depression_is_not_the_disease():
    assert "depression" not in values(C.classify(LTD_STUDY), "population")


def test_subfield_rules():
    assert settled(C.classify(CASE_REPORT), "subfield") == ["clinical"]
    assert settled(C.classify(TOOLBOX_PAPER), "subfield") == ["methods"]
    assert settled(C.classify(MODEL_STUDY), "subfield") == ["computational"]


# --------------------------------------------------------------------------------------
# Ambiguity
# --------------------------------------------------------------------------------------

def test_an_empty_paper_is_ambiguous_everywhere():
    r = C.classify({})
    assert all(r[f]["ambiguous"] for f in C.FACETS)
    assert r["on_topic"]["values"][0]["confidence"] == 0.5
    assert len(r["on_topic"]["values"]) == 1


def test_a_modality_named_once_is_left_to_the_model():
    r = C.classify({
        "title": "Sleep pressure in an invented rodent",
        "abstract": ("We deprived invented rodents of sleep for six hours and weighed them. "
                     "They lost 3% of their weight, and one EEG was taken at the end."),
    })
    assert r["modality"]["ambiguous"]
    eeg = [v for v in r["modality"]["values"] if v["value"] == "eeg"]
    assert eeg and eeg[0]["confidence"] < C.DECIDE
    assert "modality" in C.needs_model(r)


def test_values_that_exclude_each_other_make_a_facet_ambiguous():
    r = C.classify({
        "title": "Reaction times and a questionnaire in an invented reading task",
        "abstract": ("Adults read invented words while reaction times were measured with a "
                     "questionnaire on reading habits; eye tracking recorded their saccades, and "
                     "an EEG was recorded twice."),
    })
    assert values(r, "modality")                     # candidates are listed for the model
    assert r["modality"]["ambiguous"]


def test_close_single_valued_candidates_are_ambiguous():
    close = C._single({"clinical": (4.0, 0.8, ["a"]), "cellular": (3.8, 0.78, ["b"])})
    assert close["ambiguous"] and [v["value"] for v in close["values"]] == ["clinical", "cellular"]
    clear = C._single({"clinical": (6.0, 0.9, ["a"]), "cellular": (1.0, 0.33, ["b"])})
    assert not clear["ambiguous"] and [v["value"] for v in clear["values"]] == ["clinical"]
    assert C._single({})["ambiguous"]


def test_settled_facets_list_only_claimed_values():
    for paper in (EEG_STUDY, PATCH_STUDY, CASE_REPORT, AD_STUDY, IMAGING_STUDY):
        r = C.classify(paper)
        for facet in C.FACETS:
            if not r[facet]["ambiguous"]:
                assert all(v["confidence"] >= C.DECIDE for v in r[facet]["values"]), facet


def test_every_reason_names_its_field():
    fields = ("title", "abstract", "keywords", "mesh", "subjects", "journal", "type", "families",
              "methods", "rule", "against", "model")
    r = C.classify(CASE_REPORT)
    for facet in C.FACETS:
        for v in r[facet]["values"]:
            for reason in v["reasons"]:
                assert reason.split(":")[0] in fields, reason


def test_explain_is_one_line_with_every_facet():
    line = C.explain(C.classify(SEEG_STUDY))
    assert "\n" not in line
    assert all(f"{facet}" in line for facet in C.FACETS)


def test_combine_settles_the_ambiguous_facets_with_the_model():
    r = C.classify({"title": "An invented observation in the brain", "abstract": "Something was seen once."})
    assert "subfield" in C.needs_model(r)
    combined = C.combine(r, {"on_topic": "yes", "modality": ["EEG"], "organism": ["mice"],
                             "population": [], "subfield": "Cellular / molecular"}, model="m")
    for facet in C.needs_model(r):
        assert not combined[facet]["ambiguous"]
    assert values(combined, "subfield") == ["cellular"]
    assert combined["subfield"]["values"][0]["reasons"] == ["model: m"]
    rows = list(C.paper_category_rows("doi:10.0000/x", combined))
    assert ("doi:10.0000/x", "subfield.cellular", "subfield", C.MODEL_CONFIDENCE, "model") in rows


def test_typographic_hyphens_are_read_as_hyphens():
    r = C.classify({"title": "Differentiation of SH\u2010SY5Y cells into invented neurons",
                    "abstract": "SH\u2010SY5Y cells were grown for a week."})
    assert "human" in values(r, "organism")


# --------------------------------------------------------------------------------------
# The GPU window
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("hour, minute, inside", [(0, 59, False), (1, 0, True), (6, 59, True),
                                                  (7, 0, False), (12, 0, False), (23, 59, False)])
def test_gpu_window_edges(hour, minute, inside):
    assert C.within_gpu_window(dtime(hour, minute)) is inside
    assert C.within_gpu_window(datetime(2026, 9, 27, hour, minute)) is inside


def test_gpu_window_seconds_left():
    assert C.gpu_window_seconds_left(dtime(6, 59)) == 60.0
    assert C.gpu_window_seconds_left(dtime(1, 0)) == 6 * 3600.0
    assert C.gpu_window_seconds_left(dtime(7, 0)) == 0.0


def test_gpu_window_uses_the_local_clock_for_aware_times():
    local = datetime(2026, 9, 27, 3, 0).astimezone()          # 03:00 here
    utc = local.astimezone(UTC)
    assert C.within_gpu_window(utc)
    assert not C.within_gpu_window(utc + timedelta(hours=5))


# --------------------------------------------------------------------------------------
# The vocabulary
# --------------------------------------------------------------------------------------

def test_vocabulary_is_consistent():
    assert list(C.FACETS) == ["on_topic", "modality", "organism", "population", "subfield"]
    assert C.FACETS["on_topic"] == ("yes", "no")
    assert [f for f, multi in C.MULTI.items() if multi] == ["modality", "organism", "population"]
    assert len(C.FACETS["modality"]) == 15 and len(C.FACETS["organism"]) == 9
    assert len(C.FACETS["population"]) == 15 and len(C.FACETS["subfield"]) == 7
    ids = set()
    for facet, spec in C.VOCABULARY["facets"].items():
        assert spec["definition"] and spec["name"]
        seen: dict[str, str] = {}
        for v in spec["values"]:
            assert re.fullmatch(r"[a-z][a-z_]*", v["value"]), v["value"]
            assert v["id"] == f"{facet}.{v['value']}" and v["id"] not in ids
            ids.add(v["id"])
            assert v["definition"] and 2 <= len(v["examples"]) <= 3
            for name in [v["value"], v["name"], *v.get("aliases", [])]:
                key = C._key(name)
                assert seen.setdefault(key, v["value"]) == v["value"], (facet, name)
    assert C.SEPARATOR == "; " and C.UNSURE == "?" and C.NOT_APPLICABLE == "-"


def test_every_rule_value_is_in_the_vocabulary():
    for facet, rules in C.RULES.items():
        for rule in rules:
            assert rule.value in C.FACETS[facet] or rule.value.startswith("_") \
                or (facet == "on_topic" and rule.value == "mind"), (facet, rule.value)
    for facet, value, _, _ in C.TYPE_HINTS:
        assert value in C.FACETS[facet]


def test_the_annotation_guide_lists_every_value():
    guide = (ROOT / "docs" / "ANNOTATION.md").read_text(encoding="utf-8")
    for facet, allowed in C.FACETS.items():
        assert f"`{facet}`" in guide
        for value in allowed:
            assert f"`{value}`" in guide, (facet, value)


def test_category_rows_cover_the_vocabulary():
    rows = list(C.category_rows())
    assert ("modality", None, "Modality", 0) in rows
    assert ("modality.eeg", "modality", "EEG", 1) in rows
    assert len(rows) == len(C.FACETS) + sum(len(v) for v in C.FACETS.values())


@pytest.mark.parametrize("facet, text, value", [
    ("population", "Alzheimer's / dementia", "alzheimers"), ("population", "AD", "alzheimers"),
    ("population", "Alzheimer\u2019s", "alzheimers"), ("modality", "EEG", "eeg"),
    ("modality", "structural MRI / diffusion", "structural_mri"), ("organism", "fly", "drosophila"),
    ("organism", "Non-human primate", "nhp"), ("on_topic", "Yes", "yes"),
    ("subfield", "clinical / translational", "clinical"), ("modality", "?", None),
    ("modality", "ultrasound imaging", None)])
def test_values_as_people_write_them(facet, text, value):
    assert C.normalize_value(facet, text) == value


def test_normalize_values():
    assert C.normalize_values("modality", ["EEG", "eeg", "MEG"]) == ["eeg", "meg"]
    assert C.normalize_values("population", []) == []
    assert C.normalize_values("population", "-") == []
    assert C.normalize_values("subfield", ["cellular", "clinical"]) == ["cellular"]
    assert C.normalize_values("modality", ["telepathy"]) is None


# --------------------------------------------------------------------------------------
# From a JATS full text
# --------------------------------------------------------------------------------------

JATS = """<?xml version="1.0"?>
<article article-type="research-article" xmlns:xlink="http://www.w3.org/1999/xlink">
<front><journal-meta><journal-title-group><journal-title>Journal of Invented Brains</journal-title>
</journal-title-group></journal-meta>
<article-meta>
<article-categories><subj-group subj-group-type="heading"><subject>Neuroscience</subject>
<subj-group><subject>Cognitive Neuroscience</subject></subj-group></subj-group></article-categories>
<title-group><article-title>Invented <italic>theta</italic> bursts in SH&#x2010;SY5Y cells</article-title></title-group>
<abstract><sec><title>Background</title><p>Theta bursts are invented.</p></sec>
<sec><title>Methods</title><p>We used [<sup>18</sup>F]FDG PET.</p></sec></abstract>
<abstract abstract-type="graphical"><p>A drawing.</p></abstract>
<kwd-group><kwd>EEG</kwd><kwd>theta</kwd></kwd-group>
<kwd-group xml:lang="fr"><kwd>thêta</kwd></kwd-group>
</article-meta></front><body><p>Body text.</p></body></article>"""


def test_paper_from_jats():
    paper = C.paper_from_jats(JATS)
    assert paper["type"] == "research-article"
    assert paper["journal"] == "Journal of Invented Brains"
    assert paper["title"] == "Invented theta bursts in SH\u2010SY5Y cells"
    assert paper["abstract"] == "Background: Theta bursts are invented. Methods: We used [18F]FDG PET."
    assert paper["keywords"] == ["EEG", "theta"]
    assert paper["subjects"] == ["Neuroscience", "Cognitive Neuroscience"]
    assert "pet_spect" in values(C.classify(paper), "modality")
    assert C.paper_from_jats("<article><front>") == {}
    assert C.paper_from_jats("") == {}


def test_background_sentences_weigh_less():
    salience = C._salience("Background: EEG is old. Methods: We recorded EEG.")
    assert [w for _, w in salience] == [0.5, 1.0]
    plain = C._salience("EEG was invented long ago. It is cheap. Here we recorded EEG in mice. "
                        "It worked well.")
    assert [w for _, w in plain] == [0.5, 0.5, 1.0, 1.0]


# --------------------------------------------------------------------------------------
# The annotation files
# --------------------------------------------------------------------------------------

def test_csv_writer_has_a_bom_quotes_every_field_and_round_trips(tmp_path):
    path = tmp_path / "sample.csv"
    rows = [{"id": "doi:10.0000/a", "title": 'A "quoted", comma title', "keywords": ["EEG", "théta"],
             "abstract": "Line one\nline two", "on_topic": ""},
            {"id": "doi:10.0000/b", "title": "Plain", "keywords": [], "abstract": "", "on_topic": ""}]
    columns = ("id", "title", "keywords", "abstract", "on_topic")
    sample_tool.write_csv(path, columns, rows)
    raw = path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    assert text.startswith('"id","title","keywords","abstract","on_topic"\r\n')
    assert '"A ""quoted"", comma title"' in text and '"EEG; théta"' in text
    back = sample_tool.read_csv(path)
    assert back[0]["title"] == 'A "quoted", comma title'
    assert back[0]["abstract"] == "Line one\nline two"
    assert back[0]["keywords"] == "EEG; théta"
    assert back[1]["on_topic"] == ""


def test_sample_rows_leave_the_owners_columns_empty():
    paper = {"id": "doi:10.0000/x", "doi": "10.0000/x", "journal": "J", "year": "2026",
             "type": "research-article", "title": "T", "keywords": ["a", "b"],
             "abstract": "word " * 600}
    row = sample_tool.sample_row(paper)
    assert all(row[c] == "" for c in sample_tool.OWNER_COLUMNS)
    assert row["url"] == "https://doi.org/10.0000/x"
    assert sample_tool.paper_url({"id": "pmcid:PMC123", "pmcid": "PMC123"}) == \
        "https://europepmc.org/article/PMC/123"
    assert sample_tool.paper_url({"id": "epmc:MED:42"}) == "https://europepmc.org/article/MED/42"
    assert len(row["abstract"]) <= sample_tool.ABSTRACT_MAX and row["abstract"].endswith("…")
    assert list(sample_tool.SAMPLE_COLUMNS[-6:]) == ["on_topic", "modality", "organism",
                                                     "population", "subfield", "notes"]


def test_predictions_are_written_apart():
    row = sample_tool.prediction_row("doi:10.0000/x", C.classify(MODEL_STUDY))
    assert row["modality"] == ["modeling"] and row["modality_ambiguous"] == "no"
    assert row["population"] == C.NOT_APPLICABLE
    assert set(sample_tool.PREDICTION_COLUMNS) >= set(row)


def _population_of_papers(n: int = 400) -> tuple[list[dict], list[dict]]:
    types = ["research-article"] * 6 + ["review-article", "abstract", "case-report", "editorial",
                                        "correction", "methods-article", ""]
    papers, results = [], []
    for i in range(n):
        papers.append({"id": f"p{i}", "journal": f"J{i % 100}", "year": "2026" if i % 10 else "2016",
                       "status": "code_verified" if i % 7 == 0 else "none",
                       "type": types[i % len(types)]})
        value = "no" if i % 9 == 0 else "yes"
        confidence = 0.6 if i % 11 == 0 else 0.9
        results.append({"on_topic": {"values": [{"value": value, "confidence": confidence}],
                                     "ambiguous": confidence < C.ON_TOPIC_DECIDE}})
    return papers, results


def test_stratified_sample_is_deterministic_and_covers_the_strata():
    papers, results = _population_of_papers()
    first = sample_tool.stratified_sample(papers, results, size=150, seed=7)
    assert first == sample_tool.stratified_sample(papers, results, size=150, seed=7)
    assert first != sample_tool.stratified_sample(papers, results, size=150, seed=8)
    assert len(first) == len(set(first)) == 150
    counts = sample_tool.composition(papers, results, first)
    assert counts["rules"]["off-topic"] >= 25 and counts["rules"]["ambiguous"] >= 25
    assert counts["code"]["with code"] >= 40
    assert counts["year"]["2016"] >= sample_tool.YEAR_MINIMUM
    assert counts["type"]["case report"] >= 10 and counts["type"]["notice"] >= 4
    journals = [papers[i]["journal"] for i in first]
    assert max(journals.count(j) for j in set(journals)) <= sample_tool.PER_JOURNAL


def test_a_started_sample_is_not_overwritten(tmp_path):
    path = tmp_path / "sample.csv"
    sample_tool.write_csv(path, sample_tool.SAMPLE_COLUMNS, [{"id": "a", "on_topic": ""}])
    assert not sample_tool.owner_started(path)
    sample_tool.write_csv(path, sample_tool.SAMPLE_COLUMNS, [{"id": "a", "on_topic": "yes"}])
    assert sample_tool.owner_started(path)


# --------------------------------------------------------------------------------------
# tools/compare_models.py: metrics, parsing, refusals (no model is called)
# --------------------------------------------------------------------------------------

def test_parse_cell():
    assert cm.parse_cell("modality", "eeg; fmri") == cm.Label("value", ["eeg", "fmri"], "eeg; fmri")
    assert cm.parse_cell("modality", "EEG, MEG").values == ["eeg", "meg"]
    assert cm.parse_cell("modality", "extracellular electrophysiology (units, LFP)").values == ["extracellular"]
    assert cm.parse_cell("organism", "mouse; ?").status == "unsure"
    assert cm.parse_cell("organism", "  ").status == "empty"
    assert cm.parse_cell("population", "-") == cm.Label("value", [], "-")
    assert cm.parse_cell("on_topic", "-").status == "invalid"
    assert cm.parse_cell("subfield", "cellular; clinical").status == "invalid"
    assert cm.parse_cell("modality", "telepathy").status == "invalid"


def test_accuracy_and_binary_precision_recall():
    pairs = [("yes", "yes"), ("no", "no"), ("no", "yes"), ("yes", None)]
    assert cm.accuracy(pairs) == 0.5
    assert cm.accuracy([]) is None
    assert cm.binary_pr(pairs, "no") == (1.0, 0.5)
    assert cm.binary_pr(pairs, "yes") == (0.5, 0.5)
    assert cm.binary_pr([("yes", "yes")], "no") == (None, None)


def test_micro_f1():
    pairs = [({"eeg"}, {"eeg", "fmri"}), ({"meg", "fmri"}, {"meg"}), (set(), set())]
    precision, recall, f1 = cm.micro_prf(pairs)
    assert precision == pytest.approx(2 / 3) and recall == pytest.approx(2 / 3)
    assert f1 == pytest.approx(2 / 3)
    assert cm.micro_prf([(set(), set())]) == (None, None, None)
    assert cm.micro_prf([({"eeg"}, {"meg"})]) == (0.0, 0.0, 0.0)


def test_rules_plus_model_only_on_ambiguous_facets():
    rules = {"on_topic": ["yes"], "modality": None, "organism": ["mouse"], "population": None,
             "subfield": ["cellular"]}
    ambiguous = {"on_topic": False, "modality": True, "organism": False, "population": True,
                 "subfield": False}
    model = {"on_topic": ["no"], "modality": ["histology"], "organism": ["rat"],
             "population": ["healthy"], "subfield": ["systems"]}
    out = cm.combine(rules, ambiguous, model)
    assert out == {"on_topic": ["yes"], "modality": ["histology"], "organism": ["mouse"],
                   "population": ["healthy"], "subfield": ["cellular"]}
    off = dict(rules, on_topic=["no"])
    assert cm.combine(off, ambiguous, model) == off           # off-topic: the model is not asked


def test_evaluate_scores_only_labelled_papers():
    labels = cm.load_labels([
        {"id": "a", "on_topic": "yes", "modality": "eeg", "organism": "human", "population": "healthy",
         "subfield": "cognitive"},
        {"id": "b", "on_topic": "no", "modality": "", "organism": "?", "population": "-",
         "subfield": "-"},
    ])
    predictions = {"a": {"on_topic": ["yes"], "modality": ["eeg", "fmri"], "organism": ["human"],
                         "population": None, "subfield": ["cognitive"]},
                   "b": {"on_topic": ["yes"], "modality": None, "organism": None,
                         "population": ["healthy"], "subfield": None}}
    scores = cm.evaluate(labels, predictions)
    assert scores["on_topic"]["accuracy"] == 0.5 and scores["on_topic"]["no_recall"] == 0.0
    assert scores["modality"]["n"] == 1 and scores["modality"]["precision"] == 0.5
    assert scores["organism"]["n"] == 1                      # "?" is not scored
    assert scores["population"]["n"] == 2 and scores["population"]["precision"] == 0.0
    assert scores["subfield"]["n"] == 1 and scores["subfield"]["accuracy"] == 1.0


def test_parse_answer():
    answer, valid = cm.parse_answer(json.dumps({"on_topic": "yes", "modality": ["eeg"],
                                                "organism": ["human"], "population": [],
                                                "subfield": "cognitive"}))
    assert valid and answer["modality"] == ["eeg"] and answer["population"] == []
    answer, valid = cm.parse_answer('thinking... {"on_topic": "maybe"}')
    assert not valid and answer["on_topic"] is None
    assert cm.parse_answer("not json") == ({f: None for f in C.FACETS}, False)


def test_schema_and_prompt_follow_the_vocabulary():
    schema = cm.schema()
    assert schema["required"] == list(C.FACETS)
    assert schema["properties"]["modality"]["items"]["enum"] == list(C.FACETS["modality"])
    assert schema["properties"]["subfield"]["enum"] == list(C.FACETS["subfield"])
    prompt = cm.system_prompt()
    assert all(f"- {v}:" in prompt for values in C.FACETS.values() for v in values)
    assert re.fullmatch(r"[0-9a-f]{10}", cm.prompt_version())
    assert cm.run_path(Path("runs"), "qwen3.6:27b", "v", "doi:10.1/x").parent == Path("runs/qwen3.6_27b/v")
    assert cm.think_setting("gpt-oss:20b", {}) == "low"
    assert cm.think_setting("qwen3.6:27b", {}) is False
    assert cm.think_setting("gemma4:12b", {}) is None
    assert cm.think_setting("gemma4:12b", cm.parse_think(["gemma4:12b=high"])) == "high"


def _annotation_folder(tmp_path: Path, labelled: int, total: int = 10) -> Path:
    rows = []
    for i in range(total):
        rows.append({"id": f"p{i}", "title": f"Invented paper {i}",
                     "on_topic": ("yes" if i % 2 else "no") if i < labelled else "",
                     "modality": "eeg" if i < labelled else ""})
    sample_tool.write_csv(tmp_path / "sample.csv", sample_tool.SAMPLE_COLUMNS, rows)
    predictions = [{"id": f"p{i}", "on_topic": ["yes"], "on_topic_ambiguous": "no",
                    "modality": ["eeg"], "modality_ambiguous": "yes"} for i in range(total)]
    sample_tool.write_csv(tmp_path / "rules_predictions.csv", sample_tool.PREDICTION_COLUMNS, predictions)
    return tmp_path


def test_compare_refuses_while_the_owner_columns_are_mostly_empty(tmp_path, capsys):
    folder = _annotation_folder(tmp_path, labelled=3)
    assert cm.main(["--dir", str(folder), "--report-only"]) == 2
    assert "mostly empty" in capsys.readouterr().out


def test_compare_refuses_outside_the_gpu_window(tmp_path, capsys, monkeypatch):
    folder = _annotation_folder(tmp_path, labelled=10)
    monkeypatch.setattr(cm.C, "within_gpu_window", lambda now=None: False)

    def no_model(*args, **kwargs):
        raise AssertionError("no model may be called outside the window")

    monkeypatch.setattr(cm.Ollama, "chat", no_model)
    assert cm.main(["--dir", str(folder)]) == 2
    assert "Outside the GPU window" in capsys.readouterr().out


def test_compare_report_from_cached_answers(tmp_path, capsys):
    folder = _annotation_folder(tmp_path, labelled=10)
    version = cm.prompt_version()
    for i in range(10):
        cm.save(cm.run_path(folder / "model_runs", "fake:1b", version, f"p{i}"), {
            "answer": {"on_topic": ["no" if i % 2 == 0 else "yes"], "modality": ["eeg"],
                       "organism": None, "population": None, "subfield": None},
            "valid": True, "total_duration": 2e9, "eval_count": 50, "eval_duration": 1e9,
            "prompt_eval_count": 900, "prompt_eval_duration": 5e8})
    assert cm.main(["--dir", str(folder), "--report-only", "--models", "fake:1b"]) == 0
    out = capsys.readouterr().out
    assert "| rules |" in out and "| fake:1b alone | 100% |" in out and "| rules + fake:1b |" in out
    assert "| fake:1b | 10 | 0 | 2.0, 2.0 | 50.0 | 1800.0 | 10,800 |" in out
    saved = json.loads((folder / "comparison.json").read_text())
    assert saved["scores"]["rules"]["on_topic"]["accuracy"] == 0.5


def _fake_ollama(calls: list[dict]):
    import httpx

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        if not body["messages"]:                                   # an unload request
            return httpx.Response(200, json={"done_reason": "unload"})
        if "think" in body:
            return httpx.Response(400, json={"error": "this model does not support thinking"})
        answer = {"on_topic": "yes", "modality": ["eeg"], "organism": ["human"], "population": [],
                  "subfield": "cognitive"}
        return httpx.Response(200, json={
            "message": {"role": "assistant", "content": json.dumps(answer)}, "done_reason": "stop",
            "total_duration": 3e9, "load_duration": 1e9, "eval_count": 40, "eval_duration": 1e9,
            "prompt_eval_count": 800, "prompt_eval_duration": 4e8})

    client = cm.Ollama("http://ollama.invalid")
    client.http = httpx.Client(transport=httpx.MockTransport(handler))
    return client


def test_run_model_caches_answers_and_unloads(tmp_path):
    calls: list[dict] = []
    client = _fake_ollama(calls)
    papers = [{"id": "p1", "title": "An invented EEG paper", "abstract": "We recorded EEG."}]
    assert cm.run_model(client, "fake:1b", papers, tmp_path, "v1", think="low", anytime=True) == "done"
    saved = json.loads(cm.run_path(tmp_path, "fake:1b", "v1", "p1").read_text())
    assert saved["valid"] and saved["answer"]["modality"] == ["eeg"]
    chats = [c for c in calls if c["messages"]]
    assert chats[0]["think"] == "low" and "think" not in chats[1]     # retried without it
    assert chats[1]["options"]["temperature"] == 0 and chats[1]["format"] == cm.schema()
    assert calls[-1] == {"model": "fake:1b", "messages": [], "keep_alive": 0}
    assert cm.speed({"p1": saved})["seconds_mean"] == 2.0            # loading excluded
    calls.clear()
    cm.run_model(client, "fake:1b", papers, tmp_path, "v1", think=None, anytime=True)
    assert not [c for c in calls if c["messages"]]                    # resumed: nothing asked again


def test_run_model_stops_at_the_end_of_the_window(tmp_path, monkeypatch):
    calls: list[dict] = []
    client = _fake_ollama(calls)
    monkeypatch.setattr(cm.C, "gpu_window_seconds_left", lambda now=None: 10.0)
    papers = [{"id": "p1", "title": "An invented paper"}]
    assert cm.run_model(client, "fake:1b", papers, tmp_path, "v1", think=None, anytime=False) == "window"
    assert not [c for c in calls if c["messages"]]
    assert calls == [{"model": "fake:1b", "messages": [], "keep_alive": 0}]   # unloaded all the same


def test_an_incomplete_run_is_marked(tmp_path, capsys):
    folder = _annotation_folder(tmp_path, labelled=10)
    cm.save(cm.run_path(folder / "model_runs", "fake:1b", cm.prompt_version(), "p0"), {
        "answer": {f: None for f in C.FACETS}, "valid": False})
    assert cm.main(["--dir", str(folder), "--report-only", "--models", "fake:1b"]) == 0
    assert "fake:1b alone (incomplete: 1/10)" in capsys.readouterr().out
    assert cm.asks_model({"on_topic": ["no"]}, {"on_topic": False, "modality": True}) is False
    assert cm.asks_model({"on_topic": ["yes"]}, {"on_topic": False, "modality": True}) is True
