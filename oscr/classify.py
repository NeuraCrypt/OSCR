"""A paper's classification: on topic or not, modality, organism, population, subfield.

**What for.** The harvest is broad on purpose: the Europe PMC "neuro" query matches any
paper whose title or abstract says "brain", "neural" or "cortical" once, which brings in
graph neural networks, cortical bone and questionnaire surveys. The owner decided to
harvest broadly and filter by classification (D7, 2026-09-27): a paper judged off-topic
stays on the Mac, out of the site and out of the statistics (`is_publishable`). The other
facets feed the navigation (the `categories` and `paper_categories` tables, Phase 2).

**Rules first, a local model for the rest (D6).** Weighted regular expressions run over the
title (strongest), the keywords, the MeSH terms, the subjects, the abstract and the journal
title; the JATS article type and the method families add weak hints. Every reason names
the field and the term that fired ("title: 'EEG'"). Precision comes first: when the rules
find nothing, or when two values compete with close weights, the facet is marked
`ambiguous` and goes to a local model instead of a guess. That model may use the GPU only
between 01:00 and 07:00 local time (`within_gpu_window`); `tools/compare_models.py`
compares candidate models against the owner's hand labels before one is chosen.

**The result.** `classify(paper)` returns, for each facet of `FACETS`::

    {"values": [{"value": "eeg", "confidence": 0.88, "reasons": ["title: 'EEG'", ...]}],
     "ambiguous": False}

- `on_topic` always carries exactly one value, "yes" or "no": the side the evidence leans
  to, with its confidence; it is ambiguous below `ON_TOPIC_DECIDE`.
- For the other facets, a facet that is NOT ambiguous lists only values claimed with a
  confidence of at least `DECIDE`: they can be used as they are. An ambiguous facet lists
  its candidates, strong and weak, for whoever settles it (the model, or a person).
- `population` may be empty and not ambiguous: no subjects at all (pure theory, a
  simulation), what the annotation file writes "-".

The vocabulary (values, names, definitions, examples) is `vocabulary/categories.json`;
docs/ANNOTATION.md is the guide the owner labels with.
"""
from __future__ import annotations

import functools
import json
import math
import re
import xml.etree.ElementTree as ET
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime
from datetime import time as dtime
from pathlib import Path

from .jats import _analyze

VOCABULARY_FILE = Path(__file__).parent / "vocabulary" / "categories.json"


def _load_vocabulary() -> dict:
    return json.loads(VOCABULARY_FILE.read_text(encoding="utf-8"))


VOCABULARY: dict = _load_vocabulary()

#: The allowed values of each facet, in the vocabulary's order.
FACETS: dict[str, tuple[str, ...]] = {
    facet: tuple(v["value"] for v in spec["values"])
    for facet, spec in VOCABULARY["facets"].items()}

#: Whether a facet takes several values (modality, organism, population) or one.
MULTI: dict[str, bool] = {facet: bool(spec["multi"]) for facet, spec in VOCABULARY["facets"].items()}

#: How the annotation file writes several values, "not sure", and "not applicable".
SEPARATOR: str = VOCABULARY["conventions"]["separator"]
UNSURE: str = VOCABULARY["conventions"]["unsure"]
NOT_APPLICABLE: str = VOCABULARY["conventions"]["not_applicable"]

#: A value is claimed from this confidence on.
DECIDE: float = 0.5
#: Below this confidence a candidate is noise and is not reported. Between FLOOR and DECIDE
#: it is "borderline": listed only when its facet is ambiguous, never claimed.
FLOOR: float = 0.35
#: Single-valued facets: ambiguous when the runner-up's score reaches this share of the
#: winner's.
CLOSE: float = 0.75
#: `on_topic` is ambiguous below this confidence.
ON_TOPIC_DECIDE: float = 0.75
#: `is_publishable` keeps a paper out when it is off-topic with at least this confidence (D7).
OFF_TOPIC_THRESHOLD: float = 0.75
#: The confidence given to a local model's answer by `combine` (the model gives none).
MODEL_CONFIDENCE: float = 0.8

#: The hours a local model may use the GPU (D6): from 01:00 included to 07:00 excluded.
GPU_WINDOW: tuple[dtime, dtime] = (dtime(1, 0), dtime(7, 0))

#: How much a term counts, by where it is found: the title says what the paper is about;
#: an abstract also speaks of background and of other people's work.
FIELD_WEIGHT: dict[str, float] = {
    "title": 3.0, "keywords": 2.5, "mesh": 2.5, "subjects": 1.5, "abstract": 1.2,
    "journal": 2.0, "type": 1.0, "families": 0.6, "methods": 0.6}
#: The most one field can give a value: a long abstract must not outweigh everything.
FIELD_CAP: dict[str, float] = {
    "title": 4.5, "keywords": 4.0, "mesh": 4.0, "subjects": 2.5, "abstract": 3.0,
    "journal": 2.5, "type": 2.5, "families": 1.0, "methods": 1.0}
#: The fields a text rule reads unless it says otherwise.
TEXT_FIELDS: tuple[str, ...] = ("title", "keywords", "mesh", "subjects", "abstract")
#: A score of SCALE gives a confidence of 0.63; 2 x SCALE, 0.86.
SCALE: float = 2.5
#: on_topic: the score margin (yes minus no) that makes a confidence of 0.73.
ON_TOPIC_TEMPERATURE: float = 1.5
#: on_topic: the most that "the mind without neural measures" weighs against a paper.
MIND_CAP: float = 2.0


# --------------------------------------------------------------------------------------
# The rules
# --------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Rule:
    facet: str
    value: str
    weight: float
    pattern: re.Pattern[str]
    fields: tuple[str, ...] = TEXT_FIELDS
    note: str = ""


@dataclass(frozen=True)
class Mask:
    """A phrase that looks like evidence and is not ("cortical bone", "graph neural
    network"). It is blanked out before the rules of `facets` read the text; when
    `off_topic` is set, each occurrence also counts toward on_topic = "no"."""

    facets: frozenset[str]
    pattern: re.Pattern[str]
    off_topic: float = 0.0
    note: str = ""


def _re(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.I)


def _table(facet: str, rows: Iterable[tuple], fields: tuple[str, ...] = TEXT_FIELDS,
           note: str = "") -> list[Rule]:
    return [Rule(facet, value, weight, _re(pattern), fields, note)
            for value, weight, pattern in rows]


_ALL = frozenset({"on_topic", "modality", "organism", "population", "subfield"})

MASKS: tuple[Mask, ...] = (
    # "neural" and "neurons" of machine learning: the main source of off-topic papers.
    Mask(frozenset({"on_topic"}), _re(
        r"\b(?:(?:artificial|convolutional|deep|recurrent|graph|feed-?forward|physics-informed"
        r"|bayesian|residual|siamese|generative|probabilistic|hypergraph|heterogeneous|temporal"
        r"|spatio-?temporal|quantum|attention-based|multi-?layer|shallow|fully[- ]connected"
        r"|backpropagation|interpretable|message[- ]passing|hierarchical|implicit)[- ])*"
        r"neural[- ]networks?\b|\bneural (?:operators?|architecture search|radiance fields?"
        r"|ODEs?|nets?|machine translation|representations? (?:of|for) (?:images?|signals?))\b"
        r"|\b(?:G|C|D|R|A|B|Q)NNs?\b|\bGCNs?\b|\badaptive neural (?:control\w*|networks?)\b"
        r"|\bimplicit neural\b"),
        0.6, "machine learning"),
    Mask(frozenset({"on_topic"}), _re(r"\bspiking neural networks?\b|\bSNNs?\b"), 0.3,
         "spiking neural network"),
    Mask(frozenset({"on_topic"}), _re(
        r"\b(?:hidden|output|input|artificial) (?:layer )?neurons?\b"
        r"|\bneurons? (?:in|of) the (?:hidden|output|input) layers?\b"), 0.3, "machine learning"),
    Mask(frozenset({"on_topic"}), _re(
        r"\bbrainstorm(?:ing|ed|s)\b|\bbrain drain\b|\bbrain-?inspired\b"
        r"|\bbrain-?like (?:computing|intelligence|chips?|computers?|hardware)\b"), 0.5,
         "not the brain"),
    # "cortex" and "cortical" outside the brain: bone, kidney, adrenal gland, plant, cell.
    Mask(frozenset({"on_topic", "modality", "subfield"}), _re(
        r"\bcortical (?:bone|screws?|windows?|shell|plates?|porosity|breach|erosion|perforation"
        r"|fragments?|microtubules|actin|tension|granules?|cytoskeleton|flow|rotation|stiffness"
        r"|contractility|collecting ducts?|tubules?|cysts?|thickness of the (?:femur|tibia"
        r"|mandible|bone|radius))\b|\b(?:bone|femoral|tibial|mandibular|vertebral|renal"
        r"|kidney|adrenal|thymic|thymus|root|stem|lens|hair|ovarian|oocyte|egg|cell|cellular"
        r"|lymph node) cort(?:ex|ices)\b|\badrenocortic\w*|\bcorticomedullary\b|\brenal cortical\b"),
        0.8, "cortex outside the brain"),
    # Machine-learning homonyms of the mind's vocabulary.
    Mask(frozenset({"on_topic", "subfield"}), _re(
        r"\b(?:machine|deep|federated|transfer|contrastive|self-supervised|supervised"
        r"|unsupervised|representation|ensemble|few-shot|zero-shot|active|multi-task|meta)"
        r"[- ]learning\b|\battention (?:mechanisms?|modules?|layers?|weights|maps?|heads?)\b"
        r"|\bself-attention\b|\bmulti-head attention\b|\bcross-attention\b|\battention-based\b"
        r"|\blong short-term memory\b|\bLSTM\b|\blarge language models?\b|\blanguage models?\b"
        r"|\bmemory (?:usage|footprint|bandwidth|consumption)\b|\bshape[- ]memory\b"
        r"|\bmemory (?:T|B) cells?\b|\bimmunological memory\b|\bcognitive (?:radio|computing)\b"),
        0.0),
    Mask(frozenset({"on_topic", "population"}), _re(r"\bstroke volume\b|\bheat ?stroke\b"),
         0.3, "not a brain stroke"),
    Mask(_ALL, _re(r"\bdendritic cells?\b"), 0.3, "immune dendritic cells"),
    Mask(frozenset({"population", "on_topic"}), _re(
        r"\b(?:long|short)[- ]term depression\b|\b(?:cortical )?spreading depression\b"
        r"|\b(?:synaptic|respiratory|paired[- ]pulse|freezing[- ]point|myocardial) depression\b"
        r"|\bdepression of (?:synaptic|transmission|the)\b"), 0.0),
    Mask(frozenset({"population", "organism"}), _re(
        r"\b(?:double|single|triple)[- ]blind(?:ed)?\b|\bblinded\b|\bblinding\b"), 0.0),
    Mask(frozenset({"population", "on_topic"}), _re(
        r"\btumou?r necrosis factor\w*|\btumou?r suppressors?\b"), 0.0),
)

# on_topic ------------------------------------------------------------------------------

#: The nervous system itself: anatomy, cells, chemistry, measures, interventions, diseases.
_NERVOUS = [
    ("yes", 1.0, r"\bbrains?\b|\bneurons?\b|\bneuronal\b|\bcerebr\w*|\bcerebell\w*"
                 r"|\bneuro(?!tic|sis|spora|morphic|endocrine (?:tumou?r|neoplas|carcinoma|cancer))[a-z]{3,}"),
    ("yes", 0.8, r"\bneural\b|\bnervous\b"),
    ("yes", 1.0, r"\bcort(?:ex|ices|ical)\b|\bneocort\w*|\bcortico(?:spinal|striatal|thalamic|bulbar"
                 r"|cortical|limbic|fugal|petal|motor|trigeminal|nuclear|tropin-releasing)\w*"
                 r"|\bhippocamp\w*|\bamygdal\w*|\bthalam\w*|\bhypothalam\w*|\bstriat(?:um|al)\b"
                 r"|\bbasal ganglia\b|\bbrain ?stem\b|\bspinal cord\b|\bsubstantia nigra\b"
                 r"|\bdentate gyrus\b|\bentorhinal\b|\bprefrontal\b|\bcingulate\b|\binsula\b"
                 r"|\bnucleus accumbens\b|\bventral tegmental\b|\blocus coeruleus\b"
                 r"|\bolfactory bulbs?\b|\bcolliculus\b|\bclaustrum\b|\bputamen\b|\bcaudate\b"
                 r"|\bpallid\w*|\bsubthalamic\b|\bsuprachiasmatic\b|\bpituitary\b"),
    ("yes", 0.8, r"\bretina\w*|\bphotoreceptors?\b|\bcochlea\w*|\bvestibular\b|\bolfact\w*"
                 r"|\bgustatory\b|\bsomatosensory\b|\bauditory\b|\bvisual (?:cortex|system|pathways?"
                 r"|processing|perception|stimul\w*)\b|\boptic nerve\b|\b(?:odorant|olfactory|taste"
                 r"|gustatory) receptors?\b|\bchemosensory\b|\bmechanosens\w*|\bmechanoreceptors?\b"
                 r"|\bvag(?:al|ally|us)\b|\boxytocin\w*|\bvasopressin\w*|\bmelatonin\b"
                 r"|\bnocicept\w*|\bhyperalges\w*|\ballodyni\w*"),
    ("yes", 0.5, r"\bpain\b|\banalges\w*"),
    ("yes", 1.0, r"\b(?:functional|structural|effective|brain|neural|cortical) connectivity\b"
                 r"|\bbrain (?:networks?|regions?|activity|structure|function|health|age|maps?|states?)\b"
                 r"|\bneural (?:activity|correlates|circuits?|dynamics|responses?|mechanisms?|coding)\b"),
    ("yes", 1.0, r"\bsynap\w*|\baxon\w*|\bdendrites?\b|\bdendritic (?:spines?|arbor\w*|integration"
                 r"|branch\w*|trees?|morphology)\b|\bmyelin\w*|\bglia\w*|\bastrocyt\w*|\bmicroglia\w*"
                 r"|\boligodendro\w*|\bschwann cells?\b|\binterneurons?\b|\bmotoneurons?\b"
                 r"|\bpyramidal (?:cells?|neurons?)\b|\bpurkinje\b|\bnerves?\b|\bganglion cells?\b"
                 r"|\b(?:dorsal root|trigeminal|sympathetic|enteric|basal) gangli(?:on|a)\b"
                 r"|\bblood[- ]brain barrier\b|\bcerebrospinal\b"),
    ("yes", 0.7, r"\bdopamin\w*|\bserotonin\w*|\bGABA\w*|\bglutamatergic\b|\bacetylcholine\w*"
                 r"|\bcholinergic\b|\bnoradrenerg\w*|\bnorepinephrine\b|\bneurotransmi\w*"
                 r"|\bendocannabinoid\w*|\bBDNF\b|\bNMDA\w*|\bAMPA\b|\bopioid receptors?\b"),
    ("yes", 1.2, r"\bEEG\b|\biEEG\b|\bECoG\b|\bSEEG\b|electroencephalog\w*|magnetoencephalog\w*"
                 r"|electrocorticog\w*|\bevent[- ]related potentials?\b|\bERPs?\b|\bfMRI\b"
                 r"|\bfunctional (?:magnetic resonance|MRI)\b|\bfNIRS\b|\belectrophysiolog\w*"
                 r"|\bpatch[- ]clamp\w*|\bcalcium imaging\b|\btwo[- ]photon\b|\bspike sorting\b"
                 r"|\blocal field potentials?\b|\bsingle[- ]units?\b|\boptogenetic\w*"
                 r"|\bchemogenetic\w*|\bDREADDs?\b|(?-i:\bMEG\b)|\btractograph\w*"
                 r"|\bdiffusion tensor\b|\bconnectom\w*|\bpolysomnogra\w*"),
    ("yes", 1.0, r"\btranscranial\b|\b(?:r?TMS|tDCS|tACS|DBS|VNS)\b|\bvagus nerve\b"
                 r"|\bneuromodulat\w*|\bneurostimulat\w*|\bbrain[- ](?:computer|machine) interfaces?\b"
                 r"|\bBCIs?\b|\bneuroprosthe\w*|\belectroconvulsive\b"),
    ("yes", 1.0, r"\bepilep\w*|\bseizures?\b|\balzheimer\w*|\bdementias?\b|\bparkinson\w*"
                 r"|\bhuntington\w*|\bamyotrophic lateral sclerosis\b|\bmotor neuron diseases?\b"
                 r"|\bmultiple sclerosis\b|(?<!heat )\bstrokes?\b|\bcerebrovascular\b"
                 r"|\bintracerebral\b|\bsubarachnoid\b|\btraumatic brain injur\w*|\bconcussi\w*"
                 r"|\bmigraines?\b|\bheadaches?\b|\bneuropath\w*|\bataxi\w*|\bdystoni\w*"
                 r"|\btremors?\b|\bmyasthen\w*|\bguillain\b|\bencephal\w*|\bmening\w*"
                 r"|\bgliomas?\b|\bglioblastom\w*|\bmedulloblastom\w*|\bastrocytom\w*"
                 r"|\bependymom\w*|\bhydroceph\w*|\bcerebral palsy\b|\bautis\w*|\bADHD\b"
                 r"|\battention[- ]deficit\b|\btourette\w*|\bnarcolep\w*|\bdelirium\b|\bcoma\b"
                 r"|\bconsciousness\b|\bdyslexi\w*|\baphasi\w*|\bapraxi\w*|\bamnesi\w*"
                 r"|\bspasticity\b|\bradiculopath\w*|\bmyelopath\w*|\bleukodystroph\w*|\bprion\w*"
                 r"|\btauopath\w*|\bsynucleinopath\w*|\bamyloid[- ]?(?:β|beta|plaques?|PET)\b"
                 r"|\bAβ\b|\b(?:α|alpha)-synuclein\b|\bnystagmus\b|\bvertigo\b|\btinnitus\b"
                 r"|\bspina bifida\b|\bneural tube\b|\bcraniotom\w*|\bintracranial\b"),
    # Tumors of the nervous system, and cancers once they reach it: neuro-oncology.
    ("yes", 1.5, r"\bbrain (?:metasta\w*|tumou?rs?|cancers?|neoplasms?|lesions?)\b"
                 r"|\b(?:intracranial|cerebral|CNS|leptomeningeal|spinal|intraspinal) metasta\w*"
                 r"|\bintraspinal\b|\bleptomening\w*|\bschwannom\w*|\bneurofibrom\w*|\bpineal\w*"
                 r"|\bneurocritical\b|\bparaneoplastic\b|\bcranial irradiation\b|\bwhole[- ]brain"
                 r" radiotherapy\b|\bWBRT\b|\bradiosurg\w*|\bchoroid plexus\b"),
]
#: The mind: counts as neuroscience only together with neural measures.
_MIND = [
    ("mind", 0.8, r"\bschizophren\w*|\bpsychos[ie]s\b|\bpsychotic\b|\bdepress(?:ion|ive)\b"
                  r"|\bantidepress\w*|\bbipolar disorder\b|\bmania\b|\bmanic\b|\banxiety\b"
                  r"|\bPTSD\b|\bpost-?traumatic stress\b|\bobsessive[- ]compulsive\b|\bOCD\b"
                  r"|\bmental (?:health|illness\w*|disorders?)\b|\bpsychiatr\w*|\bsuicid\w*"
                  r"|\beating disorders?\b|\banorexia nervosa\b|\bbulimi\w*|\baddict\w*"
                  r"|\bsubstance use\b|\balcohol use\b|\bgambling\b|\bneuroticism\b|\bneurotic\b"
                  r"|\bpersonality\b|\bpsycholog\w*|\bpsychotherap\w*|\bmindfulness\b"
                  r"|\bwell-?being\b|\bloneliness\b|\bburnout\b|\bresilience\b"),
    ("mind", 0.5, r"\bcogniti\w*|\bmemory\b|\battention(?:al)?\b|\bemotion\w*|\bperception\b"
                  r"|\bperceptual\b|\bdecision[- ]making\b|\blanguage\b|\breading\b|\blearning\b"
                  r"|\bbehavio(?:u)?r\w*|\bmood\b|\bpsychological stress\b|\bperceived stress\b"
                  r"|\bsleep\b|\bexecutive functions?\b|\bintelligence\b|\bmotivation\w*"),
]
#: Fields of research that are not neuroscience when they are the subject of the paper.
_OFF_TOPIC = [
    ("no", 0.9, r"\bneuromorphic\b|\bmemristor\w*|\bartificial synap\w*|\bsynaptic transistors?\b"
                r"|\breservoir computing\b|\bliquid state machines?\b|\bspintronic\w*"
                r"|\bsemiconductor\w*|\bthin[- ]films?\b|\bperovskite\w*|\bnanowires?\b"
                r"|\bphotonic\b|\bintegrated circuits?\b|\b(?:flexible|stretchable|printed) electronics\b"
                r"|\btransfer printing\b"),
    ("no", 0.8, r"\bintrusion detection\b|\binternet of things\b|\bIoT\b|\bsmart homes?\b"
                r"|\brecommend(?:er|ation) systems?\b|\bautonomous (?:driving|vehicles?)\b"
                r"|\bremote sensing\b|\bcyber\w*|\bblockchain\b|\bnatural language processing\b"
                r"|\bchatbots?\b|\bdialogue systems?\b|\bsentiment analysis\b|\btraffic\b"
                r"|\bpower (?:grids?|systems?)\b|\bfault diagnosis\b|\bstock (?:prices?|markets?)\b"
                r"|\bintent classification\b"),
    ("no", 0.6, r"\bnanomaterials?\b|\bpolymer\w*|\bcatalys\w*|\belectrochemi\w*|\balloys?\b"
                r"|\bcomposites?\b|\badsorption\b|\bsolvents?\b|\bsonochemi\w*|\bdensity functional\b"
                r"|\bforce fields?\b|\bcrystal\w*|\bmetal-organic\b|\bfluid dynamics\b"
                r"|\btopology optimi[sz]ation\b|\belastomer\w*|\bholotomograph\w*|\bBrillouin\b"),
    ("no", 0.8, r"\bplants?\b|\barabidopsis\b|\bleaf\b|\bleaves\b|\bcrops?\b|\brice\b|\bmaize\b"
                r"|\bwheat\b|\bsoybeans?\b|\bphotosynth\w*|\bpollen\b|\bpollinat\w*|\bseedlings?\b"
                r"|\bsoils?\b|\bforests?\b|\binvasive species\b|\bfisher(?:y|ies)\b|\baquaculture\b"
                r"|\blivestock\b|\bpoultry\b|\bbroilers?\b|\bdairy\b|\bcattle\b|\bfood\b"
                r"|\bflavonoids?\b|\bpolysaccharides?\b|\bfermentat\w*|\bfungal\b|\bfungi\b"),
    ("no", 0.8, r"\bfractures?\b|\bfemor\w*|\bfemur\b|\btibi\w*|\bfibula\w*|\bhumer\w*|\bacetabul\w*"
                r"|\barthroplast\w*|\bosteo\w*|\borthop(?:a)?edic\w*|\bbone (?:mineral|density|loss"
                r"|metabolism|marrow|healing|mass|remodel\w*)\b|\bintramedullary\b|\bdental\b"
                r"|\bteeth\b|\btooth\b|\bperiodont\w*|\bmandib\w*|\bmaxill\w*|\bcartilage\b"
                r"|\bosteoarthritis\b|\btendons?\b|\bligaments?\b"),
    ("no", 0.6, r"\bcardiac\b|\bcardio\w*|\bheart\b|\batrial\b|\barrhythm\w*|\bmyocard\w*"
                r"|\bcoronary\b|\baort\w*|\b(?:left|right) ventric\w*|\bventricular (?:arrhythm\w*"
                r"|tachycard\w*|fibrill\w*|function|dysfunction|remodel\w*|ejection|hypertroph\w*)"
                r"|(?<!intracranial )\bhypertension\b|\batherosclero\w*"),
    # Organs outside the nervous system (their cancers are counted once, by the next rule).
    ("no", 0.6, r"(?:\brenal|\bkidneys?|\bnephr\w*+|\bhepat\w*+|\bliver|\bintestin\w*+|\bcolitis"
                r"|\bcrohn\w*+|\bgastr\w*+|\bpancrea\w*+|\blungs?|\bpulmonar\w*+|\basthma\w*+|\bCOPD"
                r"|\bbronch\w*+|\bskin|\bdermat\w*+|\bwounds?|\bpsoria\w*+|\bovar\w*+|\buter\w*+"
                r"|\bplacent\w*+|\bsperm\w*+|\btestic\w*+|\btestis|\bIVF|\bsarcopeni\w*+|\bobesity"
                r"|\bdiabet\w*+|\bophthalm\w*+|\bcornea\w*+|\bcataract\w*+|\bembryo (?:selection"
                r"|transfer|culture))\b(?! (?:cancers?|carcinomas?|tumou?rs?|adenocarcinomas?))"),
    ("no", 1.0, r"\b(?:breast|lung|colorectal|colon|gastric|hepatocellular|liver|ovarian|cervical"
                r"|prostate|pancreatic|bladder|renal cell|thyroid|o?esophageal|head and neck"
                r"|endometrial|skin|oral|nasopharyngeal|small-cell lung|non-small-cell lung)"
                r" (?:cancers?|carcinomas?|tumou?rs?|adenocarcinomas?)\b|\bleuk(?:a)?emi\w*"
                r"|\blymphom\w*|\bmyelom\w*|\bmelanom\w*|\bsarcom\w*"
                r"|\bneuroendocrine (?:tumou?rs?|neoplasms?|carcinomas?|cancers?)\b"),
    ("no", 0.5, r"\bchemoradi\w*|\bradiotherapy\b|\bimmunotherapy\b|\bPD-L?1\b|\bchemotherapy\b"
                r"|\bvirus\w*|\bviral\b|\bbacteri\w*|\bantimicrobial\w*|\bantibiotic\w*"
                r"|\bmalaria\b|\btuberculo\w*|\bsepsis\b|\bpneumonia\b|\bvaccin\w*|\bpathogen\w*"
                r"|\bparasit\w*"),
    ("no", 0.6, r"\bstudents?\b|\bteach\w*|\bcurricul\w*|\beducation\w*|\bschools?\b|\bclassrooms?\b"
                r"|\bundergraduates?\b|\bpedagog\w*|\be-learning\b|\bPISA\b|\bnursing\b|\bnurses?\b"
                r"|\bworkforce\b|\bemployment\b|\bworkplace\b|\boccupational\b|\bvocational\b"
                r"|\bjob\b|\beconomic\w*|\bcost-effectiveness\b|\bpolicy\b|\bpolicies\b"),
    ("no", 0.6, r"\bsurveys?\b|\bquestionnaires?\b|\bself-report\w*|\bcross-sectional\b"
                r"|\bprevalence\b|\battitudes?\b|\bperceptions? of\b|\bqualitative\b|\binterviews?\b"
                r"|\bfocus groups?\b|\bcaregiv\w*|\bquality of life\b|\bpsychometric\w*"
                r"|\bscale (?:development|validation)\b"),
    ("no", 0.4, r"\bveterinar\w*|\bcanine\b|\bfeline\b|\bequine\b"),
]
_JOURNAL_NEURO = (
    r"neuro|brain|cereb|cortex|hippocampus|epilep|seizure|alzheimer|dementia|parkinson"
    r"|movement disorders|stroke|headache|cephalalgia|\bpain\b|\bsleep\b|\bglia\b|synapse"
    r"|neuron|spinal|nerve|cognit|psychophysiol|\bvision\b|hearing|audiol|neural|consciousness"
    r"|psychopharmacol|\bCNS\b|nervous|multiple sclerosis|brain stimulation|imaging neuroscience"
    r"|human brain mapping|\bmind\b|\bbehavioral brain")
_JOURNAL_MIND = r"psychiatr|psycholog|\bmental\b|\bschizophrenia\b|\baddict|\bdepress|\bautism"
_JOURNAL_OFF = (
    r"bioinformatic|chemi(?:cal|stry)|\bmaterials?\b|\bnano|polymer|physics|photonic|\benergy\b"
    r"|catalys|environment|ecolog|\bplant|botan|agricult|\bfood\b|nutri|dairy|veterinar|dental"
    r"|dentistry|orthop|\bbone\b|\bjoint|cardi|\bheart\b|hypertens|arrhythm|europace|kidney"
    r"|nephro|renal|hepat|liver|gastro|endoscop|dermat|\bskin\b|wound|obstet|gyn(?:a)?ec"
    r"|reprod|fertil|urolog|oncolog|cancer|tumor|leuk(?:a)?emia|ha?ematol|\bblood\b|\blung\b"
    r"|pulmon|thorac|respir|infect|microbio|virolog|immun|rheumat|allerg|sensors|engineering"
    r"|computing|computer|robot|big data|informatics|mathemat|statistic|econom|education"
    r"|teaching|nursing|occupational|\bsports?\b|ultrason|molecular modeling|\bmolecular informatics")

ON_TOPIC_RULES: list[Rule] = (
    _table("on_topic", _NERVOUS) + _table("on_topic", _MIND) + _table("on_topic", _OFF_TOPIC)
    + _table("on_topic", [("yes", 1.0, _JOURNAL_NEURO)], ("journal",), "neuroscience journal")
    + _table("on_topic", [("mind", 0.6, _JOURNAL_MIND)], ("journal",), "psychology or psychiatry journal")
    + _table("on_topic", [("no", 0.8, _JOURNAL_OFF)], ("journal",), "journal outside neuroscience")
    + _table("on_topic", [("no", 0.5, r"\bphysical sciences\b|\bchemistry\b|\bphysics\b"
                                      r"|\bmaterials? science\b|\bengineering and technology\b"
                                      r"|\bcomputer and information sciences\b|\becology\b"
                                      r"|\bplant (?:science|biology)\b|\bagricultur\w*"
                                      r"|\bearth sciences\b|\beconomics\b")],
             ("subjects",), "subject outside neuroscience"))

# modality ------------------------------------------------------------------------------

_MODALITY = [
    ("eeg", 1.0, r"(?<!intracranial )(?<!stereo-)(?<!stereo )(?<!depth )(?<!stereotactic )"
                 r"(?<!scalp and intracranial )\bEEG\b|(?<!intracranial )(?<!stereo-)(?<!stereo )"
                 r"\belectroencephalogra\w*|\bscalp (?:EEG|recordings?|electrodes?)\b"),
    ("eeg", 0.9, r"\bevent[- ]related potentials?\b|\bERPs?\b|\bmismatch negativity\b|\bMMN\b"
                 r"|\bP300\b|\bN400\b|\bN170\b|\bP3[ab]?(?= (?:amplitude|component|latency))"
                 r"|\berror[- ]related negativity\b|\bsteady[- ]state (?:visual |auditory |somatosensory )?"
                 r"evoked (?:potentials?|responses?)\b|\bSSVEPs?\b|\b(?:visual|auditory|somatosensory)"
                 r" evoked potentials?\b|\bVEPs?\b|\bAEPs?\b|\bSSEPs?\b|\bqEEG\b|\baEEG\b"
                 r"|\bamplitude-integrated EEG\b"),
    ("eeg", 0.7, r"\bpolysomnogra\w*|\bPSG\b|\bsleep spindles?\b|\bmicrostates?\b"),
    ("eeg", 0.3, r"\b(?:alpha|theta|gamma|beta|delta) (?:power|oscillations?|rhythms?|band|activity)\b"),
    ("meg", 1.0, r"(?-i:\bMEG\b)|\bmagnetoencephalogra\w*|\boptically[- ]pumped magnetometers?\b"
                 r"|\bOPM-MEG\b"),
    ("fmri", 1.0, r"\bfMRI\b|\bfunctional (?:magnetic resonance|MRI|MR imaging|neuroimaging)\b"
                  r"|(?-i:\bBOLD\b)|\bblood[- ]oxygen(?:ation)?[- ]level[- ]dependent\b|\brs-?fMRI\b"
                  r"|\bresting[- ]state functional\b"),
    # Connectivity words: fMRI, unless the paper is an EEG, MEG, fNIRS or iEEG study.
    ("_fc", 0.5, r"\bresting[- ]state (?:networks?|connectivity)\b|\bdefault[- ]mode network\b"
                  r"|\bfunctional connectivity\b|\bsalience network\b|\bamplitude of low[- ]frequency"
                  r" fluctuations?\b|\bALFF\b|\bReHo\b|\bregional homogeneity\b|\bnetwork homogeneity\b"),
    ("structural_mri", 1.0, r"\bdiffusion[- ](?:tensor|weighted|MRI|imaging|kurtosis|spectrum)\b"
                            r"|\bDTI\b|\bDWI\b|\bDKI\b|\bNODDI\b|\btractograph\w*|\bfractional anisotropy\b"
                            r"|\bwhite[- ]matter (?:hyperintensit\w*|tracts?|integrity|microstructure"
                            r"|lesions?)\b|\bvoxel[- ]based morphometry\b|\bVBM\b|\bcortical thickness\b"
                            r"|\bgr[ae]y[- ]matter (?:volume|density|atrophy)\b|\bT[12][- ]weighted\b"
                            r"|\bFLAIR\b|\bsusceptibility[- ]weighted\b|\bSWI\b"
                            r"|\bmagnetic resonance spectroscopy\b|(?-i:\bMRS\b)"
                            r"|\bquantitative susceptibility mapping\b|\bQSM\b|\barterial spin label\w*"
                            r"|\bmorphometr\w*|\bbrain (?:volumes?|atrophy|age)\b|\bhippocampal"
                            r" (?:volumes?|atrophy)\b|\blesion (?:load|volumes?)\b|\bmyelin water\b"
                            r"|\bMP-?RAGE\b|\bstructural (?:MRI|magnetic resonance|imaging|connectivity)\b"),
    # Generic MRI mentions: structural MRI only when the paper is not an fMRI study.
    ("_mri", 0.8, r"(?<!functional )(?<!functional-)\bMRI\b|(?<!functional )\bmagnetic resonance"
                  r" imaging\b|\bMR imaging\b|\bMR scans?\b"),
    ("pet_spect", 1.0, r"(?-i:\bPET\b)|\bpositron[- ]emission\b|(?-i:\bSPECT\b)"
                       r"|\bsingle[- ]photon emission\b|\bDaT[- ]?(?:SPECT|scan)\b|\bDaTscan\b"
                       r"|(?-i:\bFDG\b)|\bfluorodeoxyglucose\b|\bPiB\b|\bflorbetapir\b"
                       r"|\bflortaucipir\b|\bflorbetaben\b|\bflutemetamol\b|\bradioligands?\b"
                       r"|\bradiotracers?\b|\[\s*1[18]\s*[CF]\s*\]|\b1[18][CF]-"),
    ("fnirs", 1.0, r"\bf?NIRS\b|\bnear[- ]infrared spectroscopy\b|\bdiffuse optical tomography\b"
                   r"|\bHD-DOT\b"),
    ("ieeg", 1.0, r"\biEEG\b|\bECoG\b|\belectrocorticogra\w*|\bSEEG\b|\bstereo-?(?:electro)?"
                  r"encephalogra\w*|\bstereo-?EEG\b|\bstereotactic EEG\b|\bintracranial"
                  r" (?:EEG|electroencephalogra\w*|recordings?|electrodes?|electrophysiolog\w*"
                  r"|neural recordings?)\b|\bdepth electrodes?\b|\bsubdural (?:grids?|electrodes?"
                  r"|strips?)\b"),
    ("extracellular", 1.0, r"\bsingle[- ]units?\b|\bsingle[- ]neuron recordings?\b|\bmulti-?units?\b"
                           r"|\bspike[- ]sorting\b|\blocal field potentials?\b|\bLFPs?\b|\bNeuropixels\b"
                           r"|\bsilicon probes?\b|\btetrodes?\b|\bmicro-?electrode arrays?\b"
                           r"|\bmulti-?electrode arrays?\b|\bMEAs?\b|\bextracellular (?:recordings?"
                           r"|electrophysiolog\w*|potentials?|spikes?|field potentials?)\b"
                           r"|\bin vivo electrophysiolog\w*|\bunit (?:activity|recordings?)\b"
                           r"|\bUtah arrays?\b|\bmicrowires?\b"),
    ("extracellular", 0.4, r"\bplace cells?\b|\bgrid cells?\b|\bhead[- ]direction cells?\b"
                           r"|\bsharp[- ]wave ripples?\b|\bfiring rates?\b|\bspike trains?\b"
                           r"|\bspiking activity\b"),
    ("intracellular", 1.0, r"\bpatch[- ]clamp\w*|\bwhole[- ]cell (?:patch|recordings?|configuration"
                           r"|currents?|voltage|current[- ]clamp|mode)\b|\bvoltage[- ]clamp\w*"
                           r"|\bcurrent[- ]clamp\w*|\bintracellular recordings?\b"
                           r"|\bsharp (?:micro)?electrodes?\b|\bdynamic clamp\b|\bTEVC\b"
                           r"|(?-i:\b[ms]?[EI]PSCs?\b|\b[EI]PSPs?\b)|\bslice electrophysiolog\w*"),
    ("intracellular", 0.5, r"(?<!mitochondrial )\bmembrane potentials?\b|\binput resistance\b"
                           r"|\baction potential (?:firing|threshold|waveforms?)\b"),
    ("optical", 1.0, r"\bcalcium imaging\b|\bCa2\+ imaging\b|\btwo[- ]photon\b|\b2-?photon\b"
                     r"|\bmulti-?photon\b|\bthree[- ]photon\b|\bj?GCaMP\w*|\bjRGECO\w*"
                     r"|\bvoltage imaging\b|\bgenetically[- ]encoded (?:calcium|voltage|dopamine"
                     r"|glutamate|neurotransmitter) (?:indicators?|sensors?)\b|\bGEVIs?\b|\bGECIs?\b"
                     r"|\bfib(?:er|re) photometry\b|\bphotometry\b|\bwide-?field (?:calcium )?imaging\b"
                     r"|\bmesoscop\w* imaging\b|\bminiscopes?\b|\bmicroendoscop\w*"
                     r"|\bintrinsic (?:signal|optical) imaging\b|\biGluSnFR\w*|\bdLight\w*"
                     r"|\bvoltage[- ]sensitive dyes?\b"),
    ("optical", 0.5, r"\bcalcium (?:transients|dynamics|responses|signals?)\b"),
    ("behavior", 1.0, r"\bpsychophysic\w*|\breaction times?\b|\bresponse times?\b|\beye[- ]?tracking\b"
                      r"|\beye movements?\b|\bsaccad\w*|\bbehavio(?:u)?ral (?:tasks?|experiments?"
                      r"|paradigms?|tests?|testing|assays?|performance|data|measures?)\b"
                      r"|\bwater maze\b|\bopen[- ]field\b|\belevated plus[- ]maze\b|\b[YT]-maze\b"
                      r"|\bnovel object recognition\b|\bfear conditioning\b|\brotarod\b"
                      r"|\bforced swim\w*|\btail suspension\b|\bsucrose preference\b"
                      r"|\bsocial interaction test\b|\bpre-?pulse inhibition\b|\bmarble burying\b"
                      r"|\bBarnes maze\b|\bradial arm maze\b|\bneuropsychological (?:tests?|testing"
                      r"|assessments?|batter(?:y|ies)|performance)\b|\bcognitive (?:tests?|testing"
                      r"|assessments?|batter(?:y|ies)|performance|tasks?|scores?)\b|\bmini-mental\b"
                      r"|\bMMSE\b|\bMoCA\b|\bquestionnaires?\b|\bself-report\w*|\bsurveys?\b"
                      r"|\brating scales?\b|\bpsychometric\w*|\bonline experiments?\b"
                      r"|\bvisual search\b|\bdual[- ]task\b|\bgo/no-?go\b|\bstroop\b|\bn-back\b"
                      r"|\bflanker\b|\bbehavio(?:u)?ral (?:analysis|phenotyp\w*)\b"),
    # Clinical rating scales: behavior too (when nothing neural is measured).
    ("behavior", 0.8, r"\b(?:MDS-)?UPDRS\b|\bEDSS\b|\bNIHSS\b|\bPANSS\b|\bHAM-?[AD]\b|\bMADRS\b"
                      r"|\bBDI(?:-II)?\b|\bPHQ-?9\b|\bGAD-?7\b|\bADAS-?Cog\b|\bY-?BOCS\b"
                      r"|\bneuropsychological\b|\bcognitive function(?:ing)?\b"),
    ("modeling", 1.0, r"\bcomputational models?\b|\bcomputational modell?ing\b|\bsimulations?\b"
                      r"|\bsimulated\b|\bin silico\b|\bmean[- ]field\b|\bneural (?:mass|field) models?\b"
                      r"|\bspiking (?:neural )?network models?\b|\bnetwork models?\b"
                      r"|\bbiophysical(?:ly)?(?:[- ]detailed)? models?\b|\bHodgkin[- ]Huxley\b"
                      r"|\bintegrate[- ]and[- ]fire\b|\bdynamical systems?\b|\btheoretical (?:models?"
                      r"|framework|analysis|study)\b|\bnormative (?:models?|theory|account)\b"
                      r"|\bBayesian (?:observer|models?)\b|\bmathematical models?\b"
                      r"|\bnumerical (?:simulations?|models?)\b|\battractor (?:networks?|dynamics"
                      r"|models?)\b"),
    ("omics", 1.0, r"\btranscriptom\w*|\bRNA[- ]?seq\w*|\bsingle[- ](?:cell|nucleus|nuclei)"
                   r" (?:RNA|transcriptom\w*|sequencing|multiomics|ATAC)\w*|\bsc(?:RNA|ATAC)-?seq\b"
                   r"|\bsnRNA-?seq\b|\bproteom\w*|\bmetabolom\w*|\blipidom\w*|\bGWAS\b"
                   r"|\bgenome-wide\b|\bexome\b|\bwhole[- ]genome\b|\bepigenom\w*|\bmethylom\w*"
                   r"|\bDNA methylation\b|\bpolygenic\b|\bmendelian randomi[sz]ation\b"
                   r"|\bATAC-?seq\b|\bChIP-?seq\b|\bmicroarrays?\b|\bgene expression profil\w*"
                   r"|\bmulti-?omic\w*|\bsequencing\b|\bgenotyp\w*|\bheritabilit\w*|\bSNPs?\b"
                   r"|\b(?:pathogenic|de novo|missense|nonsense|frameshift|splice[- ]site|biallelic"
                   r"|heterozygous|homozygous) (?:variants?|mutations?)\b|\bgenetic (?:variants?"
                   r"|testing|analys[ie]s|architecture|risk)\b"),
    ("histology", 1.0, r"\bhistolog\w*|\bhistopatholog\w*|\bimmunohistochem\w*|\bIHC\b"
                       r"|\bimmunofluorescen\w*|\bimmunostain\w*|\bimmunolabel\w*|\bconfocal\b"
                       r"|\belectron microscop\w*|\bcryo-?EM\b|\bcryo-?electron\b|\bstereolog\w*"
                       r"|\bNissl\b|\bGolgi(?:-Cox)? stain\w*|\bhematoxylin\b|\bH&E\b|\bLuxol\b"
                       r"|\btissue clearing\b|\bCLARITY\b|\biDISCO\b|\blight[- ]sheet\b"
                       r"|\bexpansion microscopy\b|\bneuropatholog\w*|\bpost-?mortem\b|\bautops\w*"
                       r"|\bmicroscop\w*|\bin situ hybridi[sz]ation\b|\bRNAscope\b|(?-i:\bFISH\b)"
                       r"|\bstaining\b|\bSholl\b|\bdendritic spines?\b|\bspine density\b|\bTUNEL\b"),
    ("other", 0.8, r"\bwestern blot\w*|\bELISA\b|\bqPCR\b|\bRT-?qPCR\b|\bRT-PCR\b|\bflow cytometr\w*"
                   r"|\b(?:plasma|serum|blood|CSF|cerebrospinal fluid) (?:biomarkers?|levels?"
                   r"|concentrations?|samples?)\b|\bneurofilament light\b|\bNfL\b|\bGFAP\b"
                   r"|\bp-?tau\s?-?\d+\b|\bs?EMG\b|\belectromyogra\w*|\bmotor evoked potentials?\b"
                   r"|\bMEPs?\b|\br?TMS\b|\btranscranial magnetic stimulation\b|\btDCS\b"
                   r"|\btranscranial (?:direct|alternating) current\b|\bultrasound\b"
                   r"|\bultrasonograph\w*|\bdoppler\b|\bcomputed tomography\b|(?<!PET/)(?<!PET-)\bCT\b"
                   r"|\bangiograph\w*|\boptical coherence tomography\b|\bOCT\b|\bfundus\b"
                   r"|\belectroretinogra\w*|\bheart rate variability\b|\bHRV\b|\bECG\b"
                   r"|\belectrocardiogra\w*|\bpupillometr\w*|\bactigraph\w*|\baccelerometer\w*"
                   r"|\bwearables?\b|\bmedical records?\b|\belectronic health records?\b"
                   r"|\bchart review\b|\bnerve conduction\b|\bgait analysis\b|\bkinematic\w*"
                   r"|\bmotion capture\b|\bimmunoblot\w*|\bLuminex\b|\bSimoa\b|\bmass spectrometry\b"
                   r"|\bmultiplex (?:immuno)?assays?\b|\bretrospective (?:cohort|study|analysis|review)\b"),
]
#: The values that are data. "behavior" and "modeling" are what is left when none is found.
DATA_MODALITIES: frozenset[str] = frozenset(FACETS["modality"]) - {"behavior", "modeling"}

MODALITY_RULES: list[Rule] = (
    _table("modality", _MODALITY)
    + _table("modality", [("eeg", 0.5, r"ERP averaging|EEG microstates"),
                          ("optical", 0.6, r"calcium imaging"),
                          ("structural_mri", 0.5, r"diffusion tensor metrics")],
             ("methods",), "method found in the text")
    + _table("modality", [("eeg", 0.4, r"Evoked potentials")], ("families",), "method family"))

# organism ------------------------------------------------------------------------------

#: Who is studied is said plainly and seldom in passing: one mention outside the background
#: sentences is enough (weight 1.5), unlike a modality or a disease.
_ORGANISM = [
    ("human", 1.5, r"\bhumans?\b|\bparticipants?\b|\bvolunteers?\b|\bpeople\b"
                   r"|\bmen\b|\bwomen\b|\bchildren\b|\badolescents?\b|\binfants?\b|\bneonates?\b"
                   r"|\bnewborns?\b|\btoddlers?\b|\b(?:older|young|younger|healthy) adults\b"
                   r"|\belderly\b|\bhealthy controls?\b|\bhuman (?:brain|cortex|tissue|iPSCs?"
                   r"|induced pluripotent|organoids?|neurons?|subjects?|participants?|cells?"
                   r"|samples?|post-?mortem)\b|\bhiPSC\w*|\bcase reports?\b|\bcase series\b"
                   r"|\bclinical trials?\b|\brandomi[sz]ed (?:controlled )?(?:clinical )?trials?\b"
                   r"|\bveterans?\b|\bathletes?\b|\bUK Biobank\b|\bHuman Connectome Project\b"
                   r"|\bADNI\b|\byears? old\b|\byear-old\b|\bboys?\b|\bgirls?\b|\bmothers?\b"),
    ("human", 0.8, r"\bindividuals\b|\badults\b|\bcohorts?\b|\btwins?\b|\bstudents?\b|\bpersons?\b"
                   r"|\bpopulation-based\b|\bhospital\w*|\bsurvivors?\b|\bSH-?SY5Y\b|\biPSCs?\b"),
    ("human", 1.1, r"\bpatients?\b"),
    ("human", 0.5, r"\bsubjects\b"),
    ("mouse", 1.5, r"\bmice\b|\bmouse\b|\bmurine\b|\bC57BL\w*|\bBALB/c\b|\b5xFAD\b|\bAPP/PS1\b"
                   r"|\b3xTg\w*|\bP301S\b|\bTg2576\b|\bSOD1[- ]?G93A\b|\bR6/2\b|\bHT-?22\b|\bBV-?2\b"
                   r"|\bNeuro-?2a\b|\bN2a\b"),
    ("rat", 1.5, r"\brats?\b|\bSprague[- ]Dawley\b|\bWistar\b|\bLong[- ]Evans\b|\bFischer 344\b"
                 r"|\bPC-?12\b"),
    ("nhp", 1.5, r"\bnon-?human primates?\b|\bNHPs?\b|\bmacaques?\b|\brhesus\b|\bmonkeys?\b"
                 r"|\bmarmosets?\b|\bMacaca\b|\bbaboons?\b|\bchimpanzees?\b|\bcapuchins?\b"),
    ("zebrafish", 1.5, r"\bzebra ?fish\b|\bDanio rerio\b"),
    ("drosophila", 1.5, r"\bDrosophila\b|\bfruit ?fl(?:y|ies)\b"),
    ("c_elegans", 1.5, r"\bC\. ?elegans\b|\bCaenorhabditis\b"),
    ("other", 1.5, r"\bcats?\b|\bkittens?\b|\bdogs?\b|\bpuppies\b|\bpigs?\b|\bpiglets?\b|\bminipigs?\b"
                   r"|\bsheep\b|\blambs?\b|\bferrets?\b|\bbirds?\b|\bsongbirds?\b|\bzebra finch\w*"
                   r"|\bcanar(?:y|ies)\b|\bchicks?\b|\bchickens\b|\bpigeons?\b|\bowls?\b|\bbats?\b"
                   r"|\boctop(?:us|uses|i)\b|\bcephalopods?\b|\bXenopus\b|\bfrogs?\b|\btadpoles?\b"
                   r"|\blampreys?\b|\bleech(?:es)?\b|\bAplysia\b|\bcrickets?\b|\blocusts?\b"
                   r"|\bhoney ?bees?\b|\bbees\b|\bants\b|\bcockroach\w*|\bmoths?\b|\bbutterfl(?:y|ies)\b"
                   r"|\bplanarians?\b|\bhorses\b|\bcows\b|\bcattle\b|\bgoats\b|\brabbits\b|\bgerbils?\b"
                   r"|\bguinea pigs?\b|\bhamsters?\b|\bvoles?\b|\btree shrews?\b|\bturtles?\b"
                   r"|\blizards?\b|\breptiles?\b|\bsalamanders?\b|\baxolotls?\b|\bNematostella\b"
                   r"|\bjellyfish\b|\bkillifish\b|\bmedaka\b|\bsticklebacks?\b|\bcichlids?\b"
                   r"|\bgoldfish\b|\btrout\b|\bsalmon\b|\bcrabs?\b|\bcrayfish\b|\blobsters?\b"
                   r"|\bsnails?\b|\bmollus\w*|\bdeer\b|\bdolphins?\b|\bwhales?\b|\belephants?\b"
                   r"|\bflatworms?\b|\binsects?\b|\bdogs\b|\bcanine\b|\bfeline\b|\bequine\b|\bovine\b"
                   r"|\bavian\b|\bgrouper\b|\bmullets?\b|\bfishes\b"),
    ("none", 1.0, r"\bin silico\b|\bsimulations?\b|\bsimulated\b|\bsynthetic (?:data|signals?"
                  r"|datasets?)\b|\bcomputational models?\b|\btheoretical\b|\bmodel neurons?\b"
                  r"|\bnetwork models?\b|\bneural mass\b|\bmean[- ]field\b|\bnumerical\b"),
]
ORGANISM_RULES: list[Rule] = _table("organism", _ORGANISM)

# population ----------------------------------------------------------------------------

_POPULATION = [
    ("healthy", 1.0, r"\bhealthy (?:volunteers?|participants?|adults?|subjects?|individuals|humans?"
                     r"|young(?:er)? adults?|older adults?|elderly|children|infants?|people|men"
                     r"|women|population|aging|ageing|cohort)\b|\bneurotypical\b"
                     r"|\bwild[- ]type (?:mice|rats|animals|zebrafish|flies)\b"
                     r"|\bnon-?clinical (?:sample|population)\b|\bgeneral population\b"
                     r"|\bcognitively (?:normal|unimpaired|healthy)\b|\btypically developing\b"),
    ("epilepsy", 1.0, r"\bepilep\w*|\bseizures?\b|\bictal\b|\binterictal\b|\bstatus epilepticus\b"
                      r"|\banti-?(?:seizure|epileptic|convulsant)\w*|\bDravet\b|\bLennox[- ]Gastaut\b"
                      r"|\binfantile spasms\b|\bWest syndrome\b|\bfocal cortical dysplasia\b|\bSUDEP\b"
                      r"|\bpentylenetetrazol\w*|\bkain(?:ate|ic acid)[- ](?:induced|model)\b"
                      r"|\bpilocarpine[- ](?:induced|model)\b|\bhippocampal sclerosis\b"),
    ("alzheimers", 1.0, r"\balzheimer\w*|\bdementias?\b|\bmild cognitive impairment\b|\bMCI\b"
                        r"|\bamyloid[- ]?(?:β|beta|plaques?|PET|pathology|deposition|burden|positiv\w*)"
                        r"|\bAβ\w*|\btau (?:pathology|tangles|PET|aggregat\w*|propagation|spreading"
                        r"|seeding)\b|\bp-?tau\w*|\btauopath\w*|\bneurofibrillary tangles?\b"
                        r"|\bfrontotemporal (?:dementia|lobar degeneration)\b|\bFTD\b|\bFTLD\b"
                        r"|\bLewy bod(?:y|ies)\b|\bDLB\b|\bAPOE\w*|\bAPP/PS1\b|\b5xFAD\b|\b3xTg\w*"
                        r"|\bTg2576\b|\bP301S\b|\bADRD\b"),
    ("alzheimers", 0.5, r"\bcognitive (?:decline|impairment)\b|\bneurocognitive disorders?\b"),
    ("parkinsons", 1.0, r"\bparkinson\w*|\bMPTP\b|\b6-?OHDA\b|\b6-hydroxydopamine\b|\brotenone\b"
                        r"|\b(?:α|alpha)-synuclein\b|\bsynucleinopath\w*|\blevodopa\b|\bL-?DOPA\b"
                        r"|\bdopaminergic (?:neuron|cell)s? (?:loss|degeneration|death)\b|\bLRRK2\b"
                        r"|\bPINK1\b|\bbradykinesi\w*|\bfreezing of gait\b"),
    ("stroke", 1.0, r"\bstrokes?\b|\bcerebral isch(?:a)?emi\w*|\bisch(?:a)?emic (?:stroke|brain"
                    r"|injury|penumbra)\b|\bmiddle cerebral artery occlusion\b|\bMCAO\b"
                    r"|\bthrombectomy\b|\bthromboly\w*|\balteplase\b|\btenecteplase\b"
                    r"|\bintracerebral h(?:a)?emorrhage\b|\bICH\b|\bsubarachnoid h(?:a)?emorrhage\b"
                    r"|\bSAH\b|\b(?:intracranial|cerebral|brain) aneurysms?\b|\bcerebrovascular\b"
                    r"|\bsmall vessel disease\b|\bwhite matter hyperintensit\w*|\blacunar\b"
                    r"|\btransient isch(?:a)?emic attacks?\b|\b(?:cerebral|brain) infarct\w*"
                    r"|\bpost-?stroke\b|\bmoyamoya\b|\barteriovenous malformations?\b"
                    r"|\bcerebral venous (?:sinus )?thrombosis\b|\bvascular (?:dementia|cognitive"
                    r" impairment)\b"),
    ("schizophrenia", 1.0, r"\bschizophren\w*|\bpsychos[ie]s\b|\bpsychotic\b|\bschizoaffective\b"
                           r"|\bclinical high[- ]risk (?:for|of) psychosis\b|\bPANSS\b"),
    ("schizophrenia", 0.5, r"\bantipsychotic\w*|\bclozapine\b|\bhallucinations?\b|\bdelusions?\b"),
    ("depression", 1.0, r"\bdepression\b(?! of\b)|\bdepressive\b|\bdepressed (?:patients?|individuals"
                        r"|mood|adolescents?|people|participants?)\b|\bantidepress\w*|\bMDD\b"
                        r"|\bmajor depressive\b|\btreatment[- ]resistant depression\b|\bTRD\b"
                        r"|\bHAM-?D\b|\bPHQ-?9\b"),
    ("bipolar", 1.0, r"\bbipolar (?:disorders?|depression|I\b|II\b|affective|patients?|spectrum)"
                     r"|\bmania\b|\bmanic\b|\bhypomani\w*|\bmood stabili[sz]ers?\b"),
    ("autism", 1.0, r"\bautis\w*|\bAsperger\w*|\bShank3\b|\bCNTNAP2\b|\bBTBR\b"),
    ("autism", 0.6, r"\bASD\b"),
    ("adhd", 1.0, r"\bADHD\b|\battention[- ]deficit(?:/| |-)?(?:hyperactivity)?(?: disorder)?\b"
                  r"|\bhyperkinetic disorder\b|\bmethylphenidate\b|\batomoxetine\b"
                  r"|\blisdexamfetamine\b"),
    ("multiple_sclerosis", 1.0, r"\bmultiple sclerosis\b|\b(?:RR|SP|PP)MS\b|\b(?:patients|people"
                                r"|persons|individuals) with MS\b|\bpwMS\b|\bexperimental autoimmune"
                                r" encephalomyelitis\b|\bEAE\b|\bcuprizone\b|\bECTRIMS\b"),
    ("multiple_sclerosis", 0.5, r"\bdemyelinat\w*|\bremyelinat\w*|\bocrelizumab\b|\bnatalizumab\b"
                                r"|\bfingolimod\b|\bsiponimod\b|\bofatumumab\b|\bteriflunomide\b"),
    ("tbi", 1.0, r"\btraumatic brain injur\w*|\bTBI\b|\bmTBI\b|\bconcussi\w*|\bhead (?:injur\w*"
                 r"|trauma|impacts?)\b|\bblast[- ](?:exposure|injur\w*|induced)\b|\bcontrolled"
                 r" cortical impact\b|\bfluid percussion\b|\bchronic traumatic encephalopathy\b"
                 r"|\bweight[- ]drop\b|\bpost-?concussi\w*|\bdiffuse axonal injury\b"),
    ("pain", 1.0, r"\bpain\w*|\bnocicept\w*|\banalges\w*|\bhyperalges\w*|\ballodyni\w*"
                  r"|\bmigraines?\b|\bheadaches?\b|\bneuralgi\w*|\bfibromyalgi\w*|\bneuropathic\b"
                  r"|\bcomplex regional pain\b|\bCRPS\b|\bsciatica\b|\bdysmenorrh\w*"),
    ("pain", 0.5, r"\bopioids?\b"),
    ("sleep", 1.0, r"\binsomni\w*|\bsleep (?:disorders?|disturbances?|apn(?:o)?ea|disordered"
                   r" breathing|problems|complaints|fragmentation)\b|\bobstructive sleep apn(?:o)?ea\b"
                   r"|\bOSA\b|\bnarcolep\w*|\bhypersomni\w*|\brestless legs\b|\bREM sleep"
                   r" behavio(?:u)?r disorder\b|\bRBD\b|\bcircadian rhythm (?:sleep[- ]wake )?"
                   r"disorders?\b|\bparasomni\w*|\bsleepwalking\b|\bshift work disorder\b"),
    ("other_condition", 1.0, r"\bgliomas?\b|\bglioblastom\w*|\bGBM\b|\bmedulloblastom\w*"
                             r"|\bastrocytom\w*|\bependymom\w*|\bmeningiom\w*|\bbrain (?:tumou?rs?"
                             r"|metasta\w*|cancer)\b|\bneuroblastom\w*|\bamyotrophic lateral"
                             r" sclerosis\b|\bALS\b|\bmotor neuron diseases?\b|\bhuntington\w*"
                             r"|\bspinocerebellar\b|\bataxi\w*|\bdystoni\w*|\bessential tremor\b"
                             r"|\bneuropath(?:y|ies)\b|\bpolyneuropath\w*|\bCharcot[- ]Marie[- ]Tooth\b"
                             r"|\bspinal cord injur\w*|\bspinal muscular atroph\w*|\bmyasthen\w*"
                             r"|\bGuillain\w*|\bmuscular dystroph\w*|\bmyopath\w*|\bneuromyelitis"
                             r" optica\b|\bNMOSD\b|\bMOGAD\b|\bencephalitis\b|\bmeningitis\b"
                             r"|\bencephalopath\w*|\bdelirium\b|\bcoma\b|\bdisorders? of consciousness\b"
                             r"|\bhydroceph\w*|\bcerebral palsy\b|\banxiety disorders?\b|\bPTSD\b"
                             r"|\bpost-?traumatic stress\b|\bobsessive[- ]compulsive\b|\bOCD\b"
                             r"|\baddict\w*|\bsubstance use\b|\balcohol (?:use|dependence|abuse)\b"
                             r"|\bcocaine\b|\bmethamphetamine\b|\bopioid use\b|\beating disorders?\b"
                             r"|\banorexia nervosa\b|\bbulimi\w*|\bTourette\w*|\btic disorders?\b"
                             r"|\bRett\b|\bAngelman\b|\bFragile X\b|\bDown syndrome\b|\btrisomy 21\b"
                             r"|\bintellectual disabilit\w*|\bneurodevelopmental disorders?\b"
                             r"|\bdyslexi\w*|\bhearing loss\b|\btinnitus\b|\bdeaf\w*|\bblindness\b"
                             r"|\bglaucoma\b|\bretinopath\w*|\bmacular degeneration\b|\bamblyopi\w*"
                             r"|\bCOVID-?19\b|\bSARS-CoV-2\b|\bhypoxic[- ]isch(?:a)?emic\b"
                             r"|\bprion\w*|\bCreutzfeldt\b|\bleukodystroph\w*|\bcancers?\b"
                             r"|\btumou?rs?\b|\bcarcinomas?\b|\bmetasta\w*|\bsepsis\b"),
    ("other_condition", 0.5, r"\banxiety\b|\bHIV\b|\bdiabet\w*|\bobesity\b|\bhypertension\b"
                             r"|\binfections?\b|\bpreterm\b|\bautoimmune\b|\bsmoking\b|\bchemotherapy\b"
                             r"|\bneurodegenerat\w*"),
    # Not a condition by itself: it only says that one is studied, which rules out
    # "healthy" and, when no known condition is named, points to "other condition".
    ("_condition", 1.0, r"\bpatients?\b|\bsyndromes?\b|\bdisorders?\b|\bdiseases?\b|\binjur(?:y|ies)\b"
                        r"|\blesions?\b|\bdeficits?\b|\bimpairments?\b|\bmodels? of\b|\bdysfunction\b"
                        r"|\bpatholog\w*|\bclinical\b"),
    # Living subjects (not cells): what "healthy" is said of, when no condition is named.
    ("_subjects", 1.0, r"\bparticipants?\b|\bvolunteers?\b|\bpeople\b|\badults\b|\bchildren\b"
                       r"|\badolescents?\b|\binfants?\b|\bsubjects\b|\bindividuals\b|\bmen\b|\bwomen\b"
                       r"|\bmice\b|\brats\b|\bmonkeys?\b|\bmacaques?\b|\bmarmosets?\b|\banimals\b"
                       r"|\blarvae\b|\bflies\b|\bworms\b|\bin vivo\b|\bbehaving\b|\bwild[- ]type\b"),
]
POPULATION_RULES: list[Rule] = (
    _table("population", _POPULATION)
    + _table("population", [(v, w, p) for v, w, p in _POPULATION if not v.startswith("_")],
             ("journal",), "journal")
    + _table("population", [("other_condition", 1.0, r"neuro-?oncolog")], ("journal",), "journal"))

# subfield ------------------------------------------------------------------------------

_SUBFIELD = [
    ("cognitive", 1.0, r"\bcogniti(?:on|ve (?:neuroscience|processes|processing|control|functions?"
                       r"|load|flexibility|maps?))\b|\bworking memory\b|\bepisodic memory\b"
                       r"|\bmemory (?:encoding|retrieval|consolidation|formation)\b|\bperception\b"
                       r"|\bperceptual\b|\bspeech\b|\bdecision[- ]making\b|\bemotion\w*"
                       r"|\bconsciousness\b|\bsocial cognition\b|\btheory of mind\b"
                       r"|\bexecutive (?:function|control)\w*|\binhibitory control\b"
                       r"|\breward (?:processing|learning|anticipation)\b|\bprediction errors?\b"
                       r"|\bpredictive (?:coding|processing)\b|\bmental imagery\b|\bmetacogniti\w*"
                       r"|\bface (?:perception|processing|recognition)\b|\bvisual (?:attention"
                       r"|search|perception|awareness)\b|\bmultisensory\b|\bspatial navigation\b"
                       r"|\bserial dependence\b|\bentrainment\b"),
    ("cognitive", 0.5, r"\battention(?:al)?\b|\bmemory\b|\blanguage\b|\breading\b|\blearning\b"
                       r"|\bdecisions?\b|\bmusic\w*|\btasks?\b|\bparticipants\b"),
    ("systems", 1.0, r"\bcircuits?\b|\bneural (?:coding|codes?|representations?|dynamics|populations?"
                     r"|ensembles?)\b|\bpopulation (?:activity|coding|dynamics)\b|\bneuronal"
                     r" (?:ensembles?|populations?|dynamics)\b|\bplace cells?\b|\bgrid cells?\b"
                     r"|\bhead[- ]direction\b|\bsharp[- ]wave ripples?\b|\btheta (?:sequences|sweeps"
                     r"|phase)\b|\bsensorimotor\b|\bmotor control\b|\b(?:motor|visual|auditory"
                     r"|somatosensory|barrel|piriform|entorhinal|prefrontal) cortex\b"
                     r"|\bthalamocortical\b|\bcorticostriatal\b|\boptogenetic\w*|\bchemogenetic\w*"
                     r"|\bbrain[- ]wide\b|\bwhole[- ]brain (?:activity|imaging|dynamics)\b"
                     r"|\blaminar\b|\breceptive fields?\b|\btuning\b"),
    ("systems", 0.4, r"\boscillat\w*|\bsynchron\w*|\bconnectivity\b|\bnetworks?\b|\bprojections?\b"
                     r"|\bneuromodulat\w*"),
    ("clinical", 1.0, r"\bpatients?\b|\bclinical\w*|\bdiagnos\w*|\bprognos\w*|\btreatments?\b"
                      r"|\btherap(?:y|ies)\b|\btrials?\b|\brandomi[sz]ed\b|\bretrospective\w*"
                      r"|\bprospective\w*|\boutcomes?\b|\bbiomarkers?\b|\bscreening\b|\bsurg\w*"
                      r"|\bcase reports?\b|\bcase series\b|\befficacy\b|\badverse events?\b"
                      r"|\bmortality\b|\brisk factors?\b|\bprevalence\b|\bincidence\b|\bsymptoms?\b"
                      r"|\bdrug-resistant\b|\brefractory\b|\brehabilitat\w*|\btranslational\b"),
    ("clinical", 0.5, r"\bmanagement\b|\bsafety\b|\bsurvival\b|\bintervention\w*|\bguidelines?\b"
                      r"|\bpreclinical\b|\bneuroprotect\w*|\btherapeutic\w*|\bhospital\w*"),
    ("computational", 1.0, r"\bcomputational (?:models?|modell?ing|neuroscience|framework|account"
                           r"|theory)\b|\bsimulations?\b|\bsimulated\b|\btheor(?:y|ies|etical)\b"
                           r"|\bnormative\b|\bmean[- ]field\b|\bneural (?:mass|field)\b|\bspiking"
                           r" (?:neural )?networks?\b|\bnetwork models?\b|\bbiophysical models?\b"
                           r"|\bHodgkin[- ]Huxley\b|\bintegrate[- ]and[- ]fire\b|\bdynamical systems?\b"
                           r"|\battractor\w*|\bBayesian (?:observer|inference|brain|models?)\b"
                           r"|\breinforcement learning\b|\bdrift[- ]diffusion\b|\bmathematical models?\b"
                           r"|\bin silico\b|\brecurrent neural networks?\b|\bcanonical computation\b"),
    ("developmental", 1.0, r"\bneurodevelopment\w*|\bdevelopmental\b|\binfan(?:ts?|cy)\b|\bneonat\w*"
                           r"|\bnewborns?\b|\bpreterm\b|\bchildhood\b|\badolescen\w*|\bembryo\w*"
                           r"|\bfetal\b|\bfoetal\b|\bprenatal\b|\bpostnatal\b|\bperinatal\b"
                           r"|\bneurogenesis\b|\bneural (?:crest|tube|progenitors?|stem cells?)\b"
                           r"|\bcritical periods?\b|\bearly[- ]life\b|\bjuvenile\b|\bpuberty\b"
                           r"|\bmaturation\b|\bdevelopment of the (?:brain|cortex|nervous)\b"),
    ("developmental", 0.4, r"\bchildren\b|\bdevelopment\b|\bprogenitors?\b|\bmigration\b"
                           r"|\borganoids?\b|\bdifferentiation\b"),
    ("cellular", 1.0, r"\bmolecular\b|\bcellular\b|\bsynap(?:se|ses|tic)\b|\breceptors?\b|\bion channels?\b"
                      r"|\bsignal(?:l)?ing pathways?\b|\bgene expression\b|\bmRNA\b|\bmicroRNA\w*"
                      r"|\bmiR-\d+|\btranscription factors?\b|\bphosphorylat\w*|\bkinases?\b"
                      r"|\bmitochondri\w*|\bautophag\w*|\bapoptosis\b|\bferroptosis\b|\bpyroptosis\b"
                      r"|\boxidative stress\b|\bneuroinflamm\w*|\bcytokines?\b|\bastrocyt\w*"
                      r"|\bmicroglia\w*|\boligodendrocyt\w*|\bmyelin\w*|\bin vitro\b|\bcultured\b"
                      r"|\biPSCs?\b|\binduced pluripotent\b|\bknock-?(?:out|down|in)\b|\bCRISPR\b"
                      r"|\boverexpress\w*|\bexosomes?\b|\bextracellular vesicles?\b|\blysosom\w*"
                      r"|\bubiquitin\w*|\bproteasom\w*|\bLTP\b|\blong-term potentiation\b"
                      r"|\bneurotransmitter release\b|\bchannels?\b|\bproteins?\b|\bgenes?\b"),
    ("cellular", 0.4, r"\bcells?\b|\bpathways?\b|\bsignal(?:l)?ing\b|\binflammat\w*|\bexcitability\b"
                      r"|\bplasticity\b|\binhibitors?\b|\bagonists?\b|\bantagonists?\b"
                      r"|\baggregat\w*|\bmechanisms?\b"),
    ("methods", 1.0, r"\btoolbox\w*|\bsoftware\b|\bpipelines?\b|\bopen[- ]source\b|\bpackages?\b"
                     r"|\bdatasets?\b|\bdata ?bases?\b|\batlas(?:es)?\b|\bbenchmark\w*"
                     r"|\bweb (?:servers?|tools?|applications?|platforms?)\b|\bwe (?:present|introduce"
                     r"|propose|develop(?:ed)?|describe) (?:a|an) (?:new|novel|open|fast|scalable"
                     r"|automated|flexible|unified|general)\b|\bnovel (?:method|approach|technique"
                     r"|tool|framework|algorithm|device|system|pipeline|platform)s?\b|\bextension\b"
                     r"|\bplugin\b|\bstandardi[sz]ed\b|\bdata (?:descriptor|paper|standard)s?\b"),
    ("methods", 0.4, r"\bmethods?\b|\bmethodolog\w*|\bframeworks?\b|\balgorithms?\b|\bplatforms?\b"
                     r"|\bvalidation\b|\breliability\b|\breproducibility\b|\bprotocols?\b|\bhardware\b"
                     r"|\bdevices?\b|\belectrodes?\b|\bprobes?\b|\bsensors?\b|\bautomated\b"
                     r"|\bsegmentation\b|\bquality control\b|\bdenoising\b|\bpreprocessing\b"
                     r"|\bartifact (?:removal|correction|rejection)\b|\bPython\b|\bMATLAB\b"
                     r"|\bfeasibility\b|\baccuracy\b"),
]
_JOURNAL_SUBFIELD = [
    ("methods", 1.0, r"methods|scientific data|data in brief|software|bioinformatics|\btools?\b"),
    ("clinical", 0.6, r"clinical|\bclinic\b|case reports|\bneurology\b|\bpsychiatry\b|epilepsia"
                      r"|\bstroke\b|neurosurg|\bJAMA\b|\blancet\b|\bmedicine\b|therapeutics|cureus"),
    ("cellular", 0.6, r"neurochem|\bglia\b|molecular|\bcells?\b|cellular|biochem"),
    ("cognitive", 0.6, r"cognit|psycholog|\bcortex\b|\bvision\b|perception|language|memory"),
    ("computational", 0.8, r"computational|neural computation|\btheoretical\b"),
    ("developmental", 0.8, r"development"),
    ("systems", 0.4, r"neurophysiol|\bneuron\b|\bneuroscience\b"),
]
SUBFIELD_RULES: list[Rule] = (
    _table("subfield", _SUBFIELD)
    + _table("subfield", _JOURNAL_SUBFIELD, ("journal",), "journal"))

# The JATS article type ----------------------------------------------------------------

#: (facet, value, weight, article types): a hint from the kind of paper.
TYPE_HINTS: tuple[tuple[str, str, float, frozenset[str]], ...] = (
    ("subfield", "clinical", 2.5, frozenset({"case-report", "case-study"})),
    ("organism", "human", 1.5, frozenset({"case-report", "case-study"})),
    ("subfield", "methods", 2.5, frozenset({"methods-article", "data-paper"})),
)

RULES: dict[str, list[Rule]] = {
    "on_topic": ON_TOPIC_RULES, "modality": MODALITY_RULES, "organism": ORGANISM_RULES,
    "population": POPULATION_RULES, "subfield": SUBFIELD_RULES}


# --------------------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Evidence:
    field: str
    term: str
    count: int
    score: float
    note: str = ""

    def reason(self) -> str:
        times = f" ×{self.count}" if self.count > 1 else ""
        note = f" ({self.note})" if self.note else ""
        return f"{self.field}: '{self.term}'{times}{note}"


#: Typographic hyphens and spaces that publishers use instead of the ASCII ones ("SH‐SY5Y").
_TYPOGRAPHY = str.maketrans({
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
    "\u2212": "-", "\ufe63": "-", "\uff0d": "-",
    "\u00a0": " ", "\u2009": " ", "\u202f": " ", "\u2019": "'"})


def _clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value).translate(_TYPOGRAPHY)).strip()


def _text_fields(paper: dict) -> dict[str, str]:
    """The paper's fields as texts; lists are joined with a separator that no rule spans."""
    out: dict[str, str] = {}
    for name in ("title", "abstract", "journal", "type"):
        out[name] = _clean(paper.get(name) or "")
    for name in ("keywords", "mesh", "subjects", "families", "methods"):
        value = paper.get(name) or []
        if isinstance(value, str):
            value = [value]
        out[name] = " ; ".join(_clean(v) for v in value if v)
    return out


#: The labels of a structured abstract that open its background, and those that close it.
_BACKGROUND_LABEL = re.compile(
    r"^(?:abstract\W+)?(?:background|introduction|objectives?|aims?|purpose|context|rationale"
    r"|importance|significance|motivation)s?\b\s*[:.]?", re.I)
_OTHER_LABEL = re.compile(
    r"^(?:abstract\W+)?(?:methods?|design|setting|participants|patients|subjects|measurements"
    r"|interventions?"
    r"|results?|findings|main (?:outcomes?|results)|conclusions?|interpretation|discussion"
    r"|materials and methods|study design|observations)\b\s*[:.]?", re.I)
#: A sentence where the authors speak of their own work.
_OWN_WORK = re.compile(
    r"\b(?:here|herein|in this (?:study|work|paper|review|article|report|trial)|the (?:present|current)"
    r" (?:study|work|report)|this (?:study|work|paper|review|report|trial)|we|our)\b"
    r"|\b(?:was|were) (?:\w+ly )?(?:recorded|measured|evaluated|assessed|analy[sz]ed|performed"
    r"|conducted|used|isolated|collected|included|enrolled|recruited|obtained|examined"
    r"|investigated|tested|compared|acquired|scanned|imaged|treated|administered|randomi[sz]ed"
    r"|studied|characteri[sz]ed|identified|quantified|applied|trained|exposed|injected"
    r"|implanted|sampled|screened|genotyped|sequenced|followed|developed|designed)\b", re.I)
#: A sentence ends at a stop followed by a capital (or an opening bracket).
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\[])")


def _salience(abstract: str) -> list[tuple[int, float]]:
    """(start offset, weight) of each sentence of the abstract. Background sentences weigh
    0.5: a modality or a disease named there is often other people's work."""
    starts = [0] + [m.end() for m in _SENTENCE_END.finditer(abstract)]
    sentences = [abstract[a:b] for a, b in zip(starts, starts[1:] + [len(abstract)])]
    weights = [1.0] * len(sentences)
    if any(_BACKGROUND_LABEL.match(s) or _OTHER_LABEL.match(s) for s in sentences):
        background = False
        for i, s in enumerate(sentences):
            if _BACKGROUND_LABEL.match(s):
                background = True
            elif _OTHER_LABEL.match(s):
                background = False
            if background:
                weights[i] = 0.5
    else:
        # The sentences before the first one about the authors' own work are background
        # ("... remains unclear. Here, we recorded ...").
        own = next((i for i, s in enumerate(sentences) if _OWN_WORK.search(s)), None)
        if own is not None and 1 <= own <= max(1, len(sentences) // 2):
            weights[:own] = [0.5] * own
        elif own is None and len(sentences) >= 4:
            weights[0] = 0.5
    return list(zip(starts, weights))


def _weight_at(salience: list[tuple[int, float]], position: int) -> float:
    weight = 1.0
    for start, w in salience:
        if start > position:
            break
        weight = w
    return weight


def _repeat(amount: float) -> float:
    """A term said three times in an abstract is the paper's own; once, maybe background."""
    return amount if amount <= 1.0 else min(2.0, 1.0 + 0.5 * (amount - 1.0))


def _masked(fields: dict[str, str], facet: str) -> dict[str, str]:
    """The fields with the facet's masks blanked out (same length: offsets stay valid)."""
    out = dict(fields)
    for mask in MASKS:
        if facet in mask.facets:
            for name, text in out.items():
                if text:
                    out[name] = mask.pattern.sub(lambda m: " " * len(m.group(0)), text)
    return out


def _amount(field: str, positions: list[int], salience: list[tuple[int, float]]) -> float:
    """How much the matches of one rule in one field count before the field's weight."""
    if field != "abstract":
        return 1.0
    return _repeat(sum(_weight_at(salience, p) for p in positions))


def _collect(facet: str, fields: dict[str, str],
             salience: list[tuple[int, float]]) -> dict[str, list[Evidence]]:
    """Every rule of the facet over every field it reads, capped per field and value."""
    found: dict[str, list[Evidence]] = {}
    for rule in RULES[facet]:
        for name in rule.fields:
            text = fields.get(name, "")
            if not text:
                continue
            matches = list(rule.pattern.finditer(text))
            if not matches:
                continue
            term = re.sub(r"\s+", " ", matches[0].group(0)).strip()[:40]
            amount = _amount(name, [m.start() for m in matches], salience)
            found.setdefault(rule.value, []).append(
                Evidence(name, term, len(matches), FIELD_WEIGHT[name] * rule.weight * amount,
                         rule.note))
    for value, items in found.items():
        found[value] = _cap(items)
    return found


def _cap(items: list[Evidence]) -> list[Evidence]:
    """No field gives a value more than its cap: the excess is trimmed from the weakest."""
    out: list[Evidence] = []
    by_field: dict[str, list[Evidence]] = {}
    for e in items:
        by_field.setdefault(e.field, []).append(e)
    for name, group in by_field.items():
        room = FIELD_CAP.get(name, 3.0)
        for e in sorted(group, key=lambda x: -x.score):
            if room <= 0:
                break
            kept = min(e.score, room)
            room -= kept
            out.append(Evidence(e.field, e.term, e.count, kept, e.note))
    return sorted(out, key=lambda x: -x.score)


def _score(items: list[Evidence] | None) -> float:
    return sum(e.score for e in items or [])


def _confidence(score: float) -> float:
    return round(min(0.97, 1.0 - math.exp(-score / SCALE)), 2)


def _reasons(items: list[Evidence] | None, limit: int = 4) -> list[str]:
    return [e.reason() for e in (items or [])[:limit]]


def _entry(value: str, confidence: float, reasons: list[str]) -> dict:
    return {"value": value, "confidence": round(confidence, 2), "reasons": reasons}


def _multi(candidates: dict[str, tuple[float, list[str]]], conflict: bool = False) -> dict:
    """A multi-valued facet. Settled: the claimed values only (a weak extra candidate is
    simply not claimed). Ambiguous when nothing is claimed, or when values that exclude
    each other compete (`conflict`): then every candidate is listed for whoever settles it."""
    kept = sorted(((v, c, r) for v, (c, r) in candidates.items() if c >= FLOOR),
                  key=lambda x: (-x[1], FACETS_ORDER.get(x[0], 99)))
    decided = [x for x in kept if x[1] >= DECIDE]
    if decided and not conflict:
        return {"values": [_entry(v, c, r) for v, c, r in decided], "ambiguous": False}
    return {"values": [_entry(v, c, r) for v, c, r in kept], "ambiguous": True}


def _single(candidates: dict[str, tuple[float, float, list[str]]]) -> dict:
    """A single-valued facet: one value, unless the runner-up is close (then candidates)."""
    ranked = sorted(((v, s, c, r) for v, (s, c, r) in candidates.items() if c >= FLOOR),
                    key=lambda x: (-x[1], FACETS_ORDER.get(x[0], 99)))
    if not ranked:
        return {"values": [], "ambiguous": True}
    top = ranked[0]
    close = len(ranked) > 1 and ranked[1][1] >= CLOSE * top[1]
    if top[2] >= DECIDE and not close:
        return {"values": [_entry(top[0], top[2], top[3])], "ambiguous": False}
    return {"values": [_entry(v, c, r) for v, _, c, r in ranked[:3]], "ambiguous": True}


FACETS_ORDER: dict[str, int] = {v: i for values in FACETS.values() for i, v in enumerate(values)}


def _type_hints(paper_type: str, facet: str) -> dict[str, list[Evidence]]:
    out: dict[str, list[Evidence]] = {}
    for f, value, weight, types in TYPE_HINTS:
        if f == facet and paper_type in types:
            out.setdefault(value, []).append(Evidence("type", paper_type, 1, weight))
    return out


def _merge(a: dict[str, list[Evidence]], b: dict[str, list[Evidence]]) -> dict[str, list[Evidence]]:
    out = {k: list(v) for k, v in a.items()}
    for k, v in b.items():
        out.setdefault(k, []).extend(v)
        out[k].sort(key=lambda x: -x.score)
    return out


# --------------------------------------------------------------------------------------
# The facets
# --------------------------------------------------------------------------------------

def _on_topic(fields: dict[str, str], salience: list[tuple[int, float]]) -> dict:
    found = _collect("on_topic", _masked(fields, "on_topic"), salience)
    # What the masks removed counts against: "graph neural network", "cortical bone".
    against_masks: list[Evidence] = []
    for mask in MASKS:
        if "on_topic" in mask.facets and mask.off_topic:
            for name in TEXT_FIELDS:
                matches = list(mask.pattern.finditer(fields.get(name, "")))
                if matches:
                    amount = _amount(name, [m.start() for m in matches], salience)
                    against_masks.append(Evidence(
                        name, _clean(matches[0].group(0))[:40], len(matches),
                        FIELD_WEIGHT[name] * mask.off_topic * amount, mask.note))
    yes = found.get("yes", [])
    no = found.get("no", []) + against_masks
    if any(e.field == "journal" for e in yes):
        # "Neuro-oncology advances" is a neuroscience journal, not an oncology one.
        no = [e for e in no if e.field != "journal"]
    no = _cap(no)
    mind = found.get("mind", [])
    s_yes, s_no, s_mind = _score(yes), _score(no), _score(mind)
    extra: list[Evidence] = []
    # The mind without neural measures is not neuroscience (the owner's definition); a
    # borderline the owner's labels will calibrate, so it never weighs more than MIND_CAP.
    if s_mind > s_yes:
        extra.append(Evidence("rule", "mind without neural measures", 1,
                              min(MIND_CAP, 0.5 * (s_mind - s_yes))))
    # A neuroscience word said once in passing is how most off-topic papers entered the
    # harvest ("... may also affect the brain").
    if s_yes == 0 and s_mind == 0 and (fields.get("title") or fields.get("abstract")):
        extra.append(Evidence("rule", "no neuroscience term", 1,
                              2.0 if fields.get("abstract") else 1.0))
    elif 0 < s_yes <= 1.5 and all(e.field == "abstract" for e in yes):
        extra.append(Evidence("rule", "neuroscience terms only in passing", 1, 1.5))
    s_no += _score(extra)
    no = sorted(no + extra, key=lambda x: -x.score)
    p_yes = 1.0 / (1.0 + math.exp(-(s_yes - s_no) / ON_TOPIC_TEMPERATURE))
    if p_yes >= 0.5:
        value, confidence, pro, con = "yes", p_yes, yes, no
    else:
        value, confidence, pro, con = "no", 1.0 - p_yes, no, yes
    reasons = _reasons(pro, 4) + ["against: " + r for r in _reasons(con, 2)]
    confidence = round(min(confidence, 0.99), 2)
    return {"values": [_entry(value, confidence, reasons or ["no evidence either way"])],
            "ambiguous": confidence < ON_TOPIC_DECIDE}


def _candidates(found: dict[str, list[Evidence]]) -> dict[str, tuple[float, list[str]]]:
    return {v: (_confidence(_score(items)), _reasons(items)) for v, items in found.items()}


def _exclusive(candidates: dict[str, tuple[float, list[str]]], derived: str,
               others: float, note: str) -> bool:
    """A value that excludes the others ("behavior only", "none (in silico)", "healthy"),
    against the best of the others. Returns True when both are strong enough to conflict."""
    if derived not in candidates:
        return False
    confidence, reasons = candidates[derived]
    if others >= DECIDE:
        del candidates[derived]
        return False
    if others >= FLOOR:
        return confidence >= DECIDE
    candidates[derived] = (confidence, reasons + [f"rule: {note}"])
    return False


def _modality(fields: dict[str, str], salience: list[tuple[int, float]]) -> dict:
    found = _collect("modality", _masked(fields, "modality"), salience)
    # A generic "MRI" is structural MRI, unless the paper is an fMRI study that also says MRI.
    generic = found.pop("_mri", [])
    if generic and _confidence(_score(found.get("fmri"))) < DECIDE:
        found["structural_mri"] = _cap(found.get("structural_mri", []) + generic)
    connectivity = found.pop("_fc", [])
    if connectivity and not any(_confidence(_score(found.get(v))) >= DECIDE
                                for v in ("eeg", "meg", "fnirs", "ieeg", "extracellular")):
        found["fmri"] = _cap(found.get("fmri", []) + connectivity)
    candidates = _candidates(found)
    data = max((c for v, (c, _) in candidates.items() if v in DATA_MODALITIES), default=0.0)
    conflict = _exclusive(candidates, "behavior", data, "no neural recording or imaging found")
    conflict |= _exclusive(candidates, "modeling", data, "no data modality found")
    both = [candidates.get(v, (0.0, []))[0] >= DECIDE for v in ("behavior", "modeling")]
    return _multi(candidates, conflict or all(both))


def _organism(fields: dict[str, str], salience: list[tuple[int, float]], paper_type: str,
              modeling: bool) -> dict:
    found = _merge(_collect("organism", _masked(fields, "organism"), salience),
                   _type_hints(paper_type, "organism"))
    candidates = _candidates(found)
    real = max((c for v, (c, _) in candidates.items() if v != "none"), default=0.0)
    if modeling and real < FLOOR:
        confidence, reasons = candidates.get("none", (0.0, []))
        candidates["none"] = (max(confidence, 0.6), reasons + ["rule: modeling, no organism named"])
    conflict = _exclusive(candidates, "none", real, "no organism named")
    return _multi(candidates, conflict)


def _population(fields: dict[str, str], salience: list[tuple[int, float]], organism: dict) -> dict:
    found = _collect("population", _masked(fields, "population"), salience)
    generic = found.pop("_condition", [])
    generic_score = _score(generic)
    living = _score(found.pop("_subjects", []))
    candidates = _candidates(found)
    best = max((c for v, (c, _) in candidates.items() if v != "healthy"), default=0.0)
    organisms = {e["value"]: e["confidence"] for e in organism["values"]
                 if e["confidence"] >= DECIDE}
    if set(organisms) == {"none"} and not organism["ambiguous"] and best < FLOOR \
            and "healthy" not in candidates:
        return {"values": [], "ambiguous": False}          # no subjects: not applicable
    subjects = [v for v in organisms if v != "none"] if living >= 1.2 else []
    if best < FLOOR:
        healthy, reasons = candidates.get("healthy", (0.0, []))
        if generic_score >= 3.0 and healthy < DECIDE:
            # A condition is studied, but none that the rules know: "other condition", to check.
            candidates["other_condition"] = (
                0.45, _reasons(generic, 2) + ["rule: a condition is studied, none recognized"])
        elif subjects and generic_score < 1.0:
            candidates["healthy"] = (max(healthy, 0.55),
                                     reasons + [f"rule: {subjects[0]} subjects, no condition named"])
        elif subjects and healthy < DECIDE:
            candidates["healthy"] = (max(healthy, 0.4),
                                     reasons + [f"rule: {subjects[0]} subjects, no condition named",
                                                "against: " + _reasons(generic, 1)[0]])
    conflict = _exclusive(candidates, "healthy", best, "no condition named")
    return _multi(candidates, conflict)


def _subfield(fields: dict[str, str], salience: list[tuple[int, float]], paper_type: str) -> dict:
    found = _merge(_collect("subfield", _masked(fields, "subfield"), salience),
                   _type_hints(paper_type, "subfield"))
    candidates = {}
    for value, items in found.items():
        s = _score(items)
        candidates[value] = (s, _confidence(s), _reasons(items))
    return _single(candidates)


# --------------------------------------------------------------------------------------
# The public API
# --------------------------------------------------------------------------------------

def classify(paper: dict) -> dict:
    """The five facets of a paper, each with its values, their confidence and the reasons.

    `paper` keys, all optional: "title", "abstract", "keywords" (list), "mesh" (list),
    "journal", "subjects" (list), "families" (method families), "methods" (method names),
    "type" (the JATS article type)."""
    fields = _text_fields(paper)
    paper_type = fields.pop("type", "").lower()
    salience = _salience(fields.get("abstract", ""))
    modality = _modality(fields, salience)
    modeling = not modality["ambiguous"] and any(e["value"] == "modeling" for e in modality["values"])
    organism = _organism(fields, salience, paper_type, modeling)
    return {
        "on_topic": _on_topic(fields, salience),
        "modality": modality,
        "organism": organism,
        "population": _population(fields, salience, organism),
        "subfield": _subfield(fields, salience, paper_type),
    }


def is_publishable(result: dict, threshold: float = OFF_TOPIC_THRESHOLD) -> bool:
    """False when the paper is off-topic with a confidence of at least `threshold` (D7):
    it stays on the Mac, out of the site and out of the statistics. An uncertain "no"
    stays publishable until the model or a person settles it."""
    values = (result.get("on_topic") or {}).get("values") or []
    if not values:
        return True
    v = values[0]
    return not (v.get("value") == "no" and float(v.get("confidence", 0.0)) >= threshold)


def explain(result: dict) -> str:
    """One line for the logs: each facet's values with their confidence; "?" marks an
    ambiguous facet, "-" a facet without values that is not ambiguous (not applicable)."""
    parts = []
    for facet in FACETS:
        f = result.get(facet) or {}
        values = f.get("values") or []
        mark = "?" if f.get("ambiguous") else ""
        if values:
            shown = ", ".join(f"{v['value']} {v['confidence']:.2f}" for v in values[:3])
        else:
            shown = "?" if f.get("ambiguous") else NOT_APPLICABLE
        parts.append(f"{facet}{mark}={shown}")
    top = ((result.get("on_topic") or {}).get("values") or [{}])[0].get("reasons") or []
    return " | ".join(parts) + (f" [{top[0]}]" if top else "")


def decided(result: dict, facet: str) -> list[str]:
    """The values the rules claim for a facet (confidence at least `DECIDE`), whatever the
    ambiguity: what "rules alone" answers when it must answer."""
    values = (result.get(facet) or {}).get("values") or []
    if not MULTI.get(facet, True):
        return [values[0]["value"]] if values and values[0]["confidence"] >= DECIDE else []
    return [v["value"] for v in values if v["confidence"] >= DECIDE]


def needs_model(result: dict) -> list[str]:
    """The facets to ask a local model about (D6). None when the rules already say, with
    confidence, that the paper is off-topic: it stays on the Mac anyway."""
    on_topic = result.get("on_topic") or {}
    values = on_topic.get("values") or []
    if values and values[0]["value"] == "no" and not on_topic.get("ambiguous"):
        return []
    return [facet for facet in FACETS if (result.get(facet) or {}).get("ambiguous")]


def combine(result: dict, answer: dict, model: str = "model",
            facets: Iterable[str] | None = None) -> dict:
    """The rules' result, with the facets they left ambiguous settled by a model's answer
    (`answer`: {facet: value or list of values}, as `tools/compare_models.py` receives it).
    Unknown values are dropped; the model's values get `MODEL_CONFIDENCE`."""
    out = {facet: dict(result.get(facet) or {}) for facet in FACETS}
    targets = list(facets) if facets is not None else needs_model(result)
    for facet in targets:
        if facet not in answer:
            continue
        values = normalize_values(facet, answer[facet])
        if values is None:
            continue
        out[facet] = {"values": [_entry(v, MODEL_CONFIDENCE, [f"model: {model}"]) for v in values],
                      "ambiguous": False}
    return out


# Values as people write them ------------------------------------------------------------

def _key(text: str) -> str:
    text = text.replace("\u2019", "'").lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


@functools.lru_cache(maxsize=1)
def _aliases() -> dict[str, dict[str, str]]:
    table: dict[str, dict[str, str]] = {}
    for facet, spec in VOCABULARY["facets"].items():
        t = table.setdefault(facet, {})
        for v in spec["values"]:
            for name in [v["value"], v["name"], v["id"], *v.get("aliases", [])]:
                t.setdefault(_key(name), v["value"])
    return table


def normalize_value(facet: str, text: str) -> str | None:
    """The vocabulary value that `text` names ("Alzheimer's / dementia", "AD", "alzheimers"
    all give "alzheimers"), or None."""
    if facet not in FACETS or not isinstance(text, str):
        return None
    return _aliases()[facet].get(_key(text))


def normalize_values(facet: str, raw: object) -> list[str] | None:
    """A model's or a person's answer for a facet as a list of vocabulary values; None when
    nothing in it is usable. An empty list means "no value" (not applicable)."""
    items = raw if isinstance(raw, list) else [raw]
    out: list[str] = []
    for item in items:
        if item is None:
            continue
        value = normalize_value(facet, str(item))
        if value is not None and value not in out:
            out.append(value)
    if not out and any(str(i).strip() not in ("", NOT_APPLICABLE) for i in items if i is not None):
        return None
    if not MULTI[facet]:
        return out[:1] if out else None
    return out


# The categories tables ------------------------------------------------------------------

def category_rows() -> Iterator[tuple[str, str | None, str, int]]:
    """Rows (id, parent_id, name, level) of the `categories` table (PLATFORM_PLAN §4)."""
    for facet, spec in VOCABULARY["facets"].items():
        yield facet, None, spec["name"], 0
        for v in spec["values"]:
            yield v["id"], facet, v["name"], 1


def paper_category_rows(paper_id: str, result: dict) -> Iterator[tuple[str, str, str, float, str]]:
    """Rows (paper_id, category_id, facet, confidence, method) of `paper_categories`: the
    values of the facets that are settled (not ambiguous), by the rules or by a model."""
    ids = {(facet, v["value"]): v["id"] for facet, spec in VOCABULARY["facets"].items()
           for v in spec["values"]}
    for facet in FACETS:
        f = result.get(facet) or {}
        if f.get("ambiguous"):
            continue
        for v in f.get("values") or []:
            method = "model" if any(r.startswith("model:") for r in v["reasons"]) else "rule"
            yield paper_id, ids[(facet, v["value"])], facet, v["confidence"], method


# --------------------------------------------------------------------------------------
# The GPU window (D6)
# --------------------------------------------------------------------------------------

def _clock(now: datetime | dtime | None) -> dtime:
    if now is None:
        return datetime.now().time()
    if isinstance(now, datetime):
        if now.tzinfo is not None:
            now = now.astimezone()      # the local time of this machine
        return now.time()
    return now


def within_gpu_window(now: datetime | dtime | None = None) -> bool:
    """True from 01:00 (included) to 07:00 (excluded), local time: the only hours a local
    model may use the GPU (D6). `now` defaults to the current local time."""
    start, end = GPU_WINDOW
    return start <= _clock(now) < end


def gpu_window_seconds_left(now: datetime | dtime | None = None) -> float:
    """Seconds until the GPU window closes; 0 outside it."""
    t = _clock(now)
    if not within_gpu_window(t):
        return 0.0
    end = GPU_WINDOW[1]
    return float((end.hour - t.hour) * 3600 + (end.minute - t.minute) * 60 - t.second) \
        - t.microsecond / 1e6


# --------------------------------------------------------------------------------------
# From a JATS full text
# --------------------------------------------------------------------------------------

_BLOCK = frozenset({"p", "sec", "title", "list-item", "label", "caption", "td", "th", "tr",
                    "list", "def-item", "term", "def", "disp-quote"})


def _plain(e: ET.Element | None) -> str:
    """The text of an element; inline markup (<sup>18</sup>F) is joined, blocks are spaced."""
    if e is None:
        return ""
    parts: list[str] = []

    def walk(x: ET.Element) -> None:
        if _tag(x.tag) == "title" and x is not e:
            # A section title of a structured abstract reads "Background:", which is how
            # `classify` finds the background sentences.
            title = _plain(x)
            parts.append(f" {title}{'' if not title or title[-1] in '.:?!' else ':'} ")
            return
        block = _tag(x.tag) in _BLOCK
        if block:
            parts.append(" ")
        if x.text:
            parts.append(x.text)
        for child in x:
            walk(child)
            if child.tail:
                parts.append(child.tail)
        if block:
            parts.append(" ")

    walk(e)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _tag(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


_XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"


def paper_from_jats(xml: str) -> dict:
    """What `classify` reads, from a JATS full text: title, abstract, keywords, subjects,
    journal and article type. A broken XML gives an empty dict."""
    root = _analyze(xml) if xml else None
    if root is None:
        return {}
    article = root if _tag(root.tag) == "article" else root.find(".//article")
    article = article if article is not None else root
    meta = root.find(".//front/article-meta")
    journal = root.find(".//front/journal-meta")
    out: dict = {"type": article.get("article-type", ""),
                 "journal": _plain(journal.find(".//journal-title")) if journal is not None else ""}
    if meta is None:
        return out
    out["title"] = _plain(meta.find("title-group/article-title"))
    abstracts = meta.findall("abstract")
    main = [a for a in abstracts if not a.get("abstract-type")] or abstracts
    out["abstract"] = _plain(main[0]) if main else ""
    keywords: list[str] = []
    for group in meta.findall("kwd-group"):
        if group.get(_XML_LANG, "en").lower()[:2] not in ("en", ""):
            continue
        for k in group.findall("kwd"):
            text = _plain(k)
            if text and text not in keywords:
                keywords.append(text)
    out["keywords"] = keywords
    subjects: list[str] = []
    categories = meta.find("article-categories")
    if categories is not None:
        for s in categories.iter():
            if _tag(s.tag) == "subject":
                text = _plain(s)
                if text and text not in subjects:
                    subjects.append(text)
    out["subjects"] = subjects
    return out
