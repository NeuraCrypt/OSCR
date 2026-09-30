"""The role of a link: the authors' code, their data, or a tool they used.

**The trap that calls for this module.** Of the two GitHub links of
`eeg-neurostream`, one is the authors' code, the other another lab's dataset.
And a Methods section routinely cites the MNE-Python or EEGLAB repository:
counting these links as "native code" would fill the library with the same ten
toolboxes, and the catalog would say that everybody publishes their code.

**How it judges.** Three roles are scored together, each by READABLE clues, no
model, no learned weight:

- the host prior (GitHub → code, OpenNeuro → data, PyPI → tool);
- the sentence: a code noun ("code", "scripts", "notebooks") with an
  availability verb ("available", "deposited"); an ownership marker ("our",
  "this study", "to reproduce"); a usage marker ("using", "implemented in",
  "toolbox", a version number); the name of a known toolbox right before the
  link;
- the location: a "Code availability" section, a "This paper" row of the key
  resources table, a reference whose authors are the paper's own.

Every clue that counted is kept in `reasons`: a verdict can be re-read, and a
wrong verdict is fixed by naming the clue that misled it, not by blindly
tweaking a threshold.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from . import links
from .jats import Mention
from .links import Link

ROLES: tuple[str, ...] = ("code", "data", "third_party_tool", "unknown")

#: Below this score, no role is asserted.
THRESHOLD: float = 1.5

#: The prior of each host kind.
PRIOR: dict[str, dict[str, float]] = {
    "forge": {"code": 1.0},
    "execution": {"code": 2.0},
    "model": {"code": 2.0},
    "archive": {"code": 0.3, "data": 0.3},
    "package": {"third_party_tool": 1.5},
    "data": {"data": 2.5},
    "doc": {"third_party_tool": 0.8},
    "supplementary": {"code": 1.0},
    "other": {},
}

# "repository" is not one of them: "the public repository Zenodo" holds data as
# often as code (measured on PMC12748784).
CODE_NOUNS = re.compile(
    r"\b(codes?|scripts?|source[- ]?codes?|notebooks?|implementations?|pipelines?"
    r"|software|programs?|routines?|functions|toolbox(?:es)?|packages?|utilit(?:y|ies)"
    r"|matlab|python|jupyter|analysis code|simulation code|model code)\b", re.I)
#: "codes" that are NOT software: "accession codes 9D8G and 9D6P" (Protein Data
#: Bank, August 2026), "PDB code", "ICD codes", and in neuroscience
#: "population code", "rate code", "neural code".
NON_CODE_CODES = re.compile(
    r"\b(accession|pdb|entry|identifier|id|icd|zip|postal|bar|colou?r|genetic|neural|population"
    r"|rate|temporal|place|predictive|sparse|efficient|ethical|access)[- ]codes?\b"
    r"|\bcodes? of (conduct|practice|ethics)\b|\bcoding (scheme|system|manual)s?\b", re.I)

#: Data that COME WITH a piece of software do not make the link a data
#: repository: "downloaded, along with a manual, helper utilities, and sample
#: data" describes FingeRNAt, a piece of software (the PMC version of
#: pcbi.1009783, Zenodo benchmark).
ANCILLARY_DATA = re.compile(
    r"\b(sample|example|test|demo|toy|tutorial|synthetic)\s+(data(?:sets?)?|recordings?)\b", re.I)
STRONG_CODE_NOUNS = re.compile(
    r"\b(codes?|scripts?|source[- ]?codes?|notebooks?|analysis pipeline"
    r"|custom (?:matlab |python |r )?(?:code|scripts?|software|functions))\b", re.I)
DATA_NOUNS = re.compile(
    r"\b(data(?:sets?)?|database|recordings?|raw data|images?|scans|stimuli"
    r"|materials?|corpus|measurements|participant data|behavio(?:u)?ral data)\b", re.I)
AVAILABILITY_VERBS = re.compile(
    r"\b(available|accessible|accessed|deposited|shared|provided|released|hosted"
    r"|published|archived|downloaded|obtained|found|openly|freely|publicly|uploaded"
    r"|stored|submitted)\b", re.I)
# A bare "we" says nothing about who owns a link: "We computed the DCC using
# the edgeofpy package (link)" cites a tool (PMC12640546). A verb of creation
# or of release is needed.
OWN = re.compile(
    r"\b(our|we (?:provide|release|share|make|have made|developed|wrote|created"
    r"|implemented|publish|deposit)|this (?:study|paper|work|article|manuscript|project|analysis)"
    r"|the (?:present|current) (?:study|work|paper)|in-house|custom|developed (?:for|in)"
    r"|written (?:for|in)|to reproduce|reproduc(?:e|ing|ible|tion)|replicat(?:e|ion)"
    r"|supporting (?:the )?(?:findings|results)|used (?:in|for|to generate) (?:this|the (?:present|current))"
    r"|all (?:analyses|analysis|code|scripts))\b", re.I)
# Nor does a bare "used": "the data used for this paper" (PMC12748784).
TOOL = re.compile(
    r"\b(using|with the|implemented (?:in|with|using)|performed (?:in|with|using)"
    r"|carried out (?:in|with|using)|conducted (?:in|with|using)|processed (?:in|with|using)"
    r"|analy[sz]ed (?:in|with|using)|created with|provided by|developed by|via|by means of"
    r"|toolbox|plug-?in|library|package|open-source|version|v\d+\.\d+|RRID"
    r"|downloaded (?:\S+ ){0,4}from)\b", re.I)
#: A package NAMED in lower case: "from the ppm R package, available on GitHub
#: (link)" (PMC12645806), the sentence describes the use of a package.
NAMED_PACKAGE = re.compile(
    r"\b(?:the|from the|using the|with the|in the)\s+[\w.\-]+\s+(?:R |Python |MATLAB |Julia )?"
    r"(?:package|toolbox|library|module|plugin|plug-in)\b", re.I)
#: An author-year citation: "(Fang and Boas 2009b", "Gramfort et al., 2013".
#: The \u00C0-\u00FF range lets accented author names match.
CITATION = re.compile(r"([A-Z][A-Za-z\u00C0-\u00FF'\-]+)(?: et al\.?| and [A-Z][A-Za-z\u00C0-\u00FF'\-]+"
                      r"| & [A-Z][A-Za-z\u00C0-\u00FF'\-]+)?,?\s+(?:19|20)\d{2}[a-z]?\b")
#: A TOOL NAME right before the link: "NeuroPycon (link)", "mTRF-Toolbox9
#: (link)". Only names shaped like software names are kept, an inner capital,
#: a digit or a hyphen, not "Code (link)".
TOOL_NAME_BEFORE = re.compile(
    r"(?<![\w-])([A-Za-z]*[A-Z][a-z0-9]*[A-Z0-9\-][\w\-+.]*)(?:\s+(?:software|toolbox|package"
    r"|library|toolkit|plugin|app))?\s*\d*\s*[:(\[]?\s*$")
#: Hosts themselves are not tools: "on GitHub (link)".
_NAMED_HOSTS = frozenset({"GitHub", "GitLab", "Zenodo", "OSF", "OpenNeuro", "DataDryad",
                          "BitBucket", "Bitbucket", "CodeOcean", "FigShare", "Figshare",
                          "HuggingFace", "PhysioNet", "DANDI", "OpenfMRI", "ModelDB"})
ON_REQUEST = re.compile(
    r"(upon|on|by|at) (?:a )?(?:reasonable |written |justified )?request"
    r"|available (?:from|through|by contacting|via) the (?:corresponding|first|senior|last|lead) author"
    r"|contact(?:ing)? the (?:corresponding|first|senior|last) author"
    r"|can be requested|will be (?:made )?available (?:upon|on|after)", re.I)
THIS_PAPER = re.compile(r"\bthis (?:paper|study|work|article)\b", re.I)

#: Neuroscience and computing toolboxes that papers CITE. A link right after one
#: of these names is almost always the tool, not the authors' code.
KNOWN_TOOLS: tuple[str, ...] = (
    "EEGLAB", "FieldTrip", "MNE", "MNE-Python", "Brainstorm", "SPM", "SPM12", "FSL",
    "FreeSurfer", "AFNI", "fMRIPrep", "MRIQC", "nilearn", "Nilearn", "nipype",
    "scikit-learn", "sklearn", "PyTorch", "TensorFlow", "Keras", "Kilosort",
    "Suite2p", "suite2p", "DeepLabCut", "CaImAn", "Psychtoolbox", "PsychoPy",
    "jsPsych", "E-Prime", "Presentation", "OpenSesame", "MATLAB", "RStudio",
    "lme4", "JASP", "SPSS", "GraphPad", "BrainVision Analyzer", "LORETA",
    "sLORETA", "eLORETA", "Cartool", "FOOOF", "specparam", "YASA", "NeuroKit",
    "NeuroKit2", "CONN", "DPABI", "DPARSF", "GIFT", "BrainNet Viewer",
    "Connectome Workbench", "ANTs", "MRtrix", "MRtrix3", "DIPY", "QSIPrep",
    "CAT12", "ERPLAB", "LIMO", "Unfold", "autoreject", "PREP", "ICLabel", "MARA",
    "ADJUST", "FASTER", "HAPPE", "Automagic", "BIDS", "LSL", "Lab Streaming Layer",
    "OpenBCI", "pingouin", "Pingouin", "statsmodels", "SciPy", "NumPy", "pandas",
    "seaborn", "matplotlib", "Matplotlib", "Jupyter", "Anaconda", "Docker",
    "Singularity", "HCP", "BrainSuite", "SUMA", "ITK-SNAP", "3D Slicer", "Nibabel",
    "NiBabel", "pyRiemann", "MOABB", "braindecode", "Braindecode", "EEGNet",
    "HDDM", "Stan", "PyMC", "brms", "JAGS", "NEURON", "NEST", "Brian", "Brian2",
    "SpikeInterface", "Phy", "phy", "CellProfiler", "ImageJ", "Fiji", "napari",
    "SLEAP", "Bonsai", "Open Ephys", "Plexon", "Neuralynx", "BESA", "Curry",
    "OSL", "SPM-M/EEG", "SimNIBS", "NeuroElf", "BrainVoyager", "PALM", "TFCE",
    "randomise", "FLIRT", "FEAT", "MELODIC", "ICA-AROMA", "tedana", "fmriprep",
    "Rstudio", "R Core", "Python Software Foundation",
)
_TOOLS_RE = re.compile(r"(?<![\w-])(" + "|".join(sorted(map(re.escape, KNOWN_TOOLS),
                                                        key=len, reverse=True)) + r")(?![\w-])")

#: Repositories of public tools: the organization alone is enough to conclude.
TOOL_ORGS: frozenset[str] = frozenset({
    "mne-tools", "sccn", "fieldtrip", "brainstorm-tools", "spm", "nipy", "nilearn",
    "nipreps", "poldracklab", "scikit-learn", "pytorch", "tensorflow", "keras-team",
    "numpy", "scipy", "pandas-dev", "matplotlib", "statsmodels", "fooof-tools",
    "neurodsp-tools", "deeplabcut", "mouseland", "kwikteam", "spikeinterface",
    "flatironinstitute", "bids-apps", "bids-standard", "psychopy", "psychtoolbox-3",
    "jspsych", "brainiak", "neuralensemble", "neuropsychology", "braindecode",
    "neurotechx", "pyriemann", "autoreject", "nipype", "dipy", "mrtrix3", "antsx",
    "freesurfer", "afni", "rordenlab", "deep-mi", "pennlinc", "ucdavis",
    "unfoldtoolbox", "limo-eeg-toolbox", "labstreaminglayer", "openbci",
    "cosmomvpa", "pymvpa", "cosanlab", "me-ica", "ohba-analysis",
    "neurodatawithoutborders", "catalystneuro", "talmolab", "openneuroorg",
    "dandi", "huggingface", "openai", "jupyter", "conda", "python", "r-lib",
    "tidyverse", "rstudio", "lme4", "stan-dev", "pymc-devs", "open-ephys",
    "simnibs", "neuronsimulator", "nest", "brian-team", "allenswdb",
    "hcp-pipelines", "washington-university", "brainglobe", "cellpose",
    "napari", "imagej", "fiji", "bonsai-rx", "int-brain-lab",
})

#: Repositories of tools kept by one person: the repository is named, not the
#: account, because the same account also holds the code of its papers.
TOOL_REPOS: frozenset[str] = frozenset({
    "github.com/raphaelvallat/yasa", "github.com/raphaelvallat/pingouin",
    "github.com/raphaelvallat/antropy", "github.com/sappelhoff/pyprep",
    "github.com/mwaskom/seaborn",
    "github.com/cbrnr/mnelab", "github.com/cbrnr/sleepecg",
    "github.com/pierreablin/picard", "github.com/alexandrebarachant/pyriemann",
    "github.com/nbara/python-meegkit", "github.com/mattjj/pyhsmm",
    "github.com/bbci/bbci_public", "github.com/aestrivex/bctpy",
})


@dataclass
class Verdict:
    role: str
    confidence: str                      # high | medium | low
    margin: float                        # best score − second best
    scores: dict[str, float] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    on_request: bool = False


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c)).lower()


def shared_authors(a: tuple[str, ...] | list[str], b: list[str],
                   ref_text: str = "") -> list[str]:
    """The surnames in common, ignoring accents and case.

    When the reference is not tagged ("Schmidt F. ECG_1f_memory.",
    "Yu, Q. & Liu, Y."), the paper's names FOLLOWED BY INITIALS are looked for
    at the head of the reference: a short name like "He" is only kept in the
    form "He B.", never as a pronoun.
    """
    bb = {_strip_accents(x) for x in b if len(x) > 1}
    shared = [x for x in a if _strip_accents(x) in bb]
    if shared or not ref_text:
        return shared
    head = ref_text[:160]
    for name in b:
        if len(name) < 2:
            continue
        if re.search(rf"(?<![\w-]){re.escape(name)}(?:,\s*|\s+)(?:[A-Z]\.?-?\s*){{1,3}}(?=[\s,.;&]|$)",
                     head):
            shared.append(name)
    return shared


_STOPWORDS = frozenset({"with", "from", "that", "this", "their", "using", "during", "between",
                        "into", "through", "under", "over", "which", "these", "those", "study",
                        "analysis", "effects", "effect", "based", "role", "evidence"})


def same_title(article_title: str, ref_text: str) -> bool:
    """Does the reference carry the paper's title? Then it is the paper's archive
    ("Trait anxiety is associated with … (version 1.0). Zenodo")."""
    words = {w for w in re.findall(r"[a-z]{4,}", _strip_accents(article_title)) if w not in _STOPWORDS}
    if len(words) < 3:
        return False
    ref = set(re.findall(r"[a-z]{4,}", _strip_accents(ref_text)))
    return len(words & ref) / len(words) >= 0.7


def segment(sentence: str, anchor: str) -> str:
    """The part of the sentence that speaks of THIS link.

    A sentence with several links shares its nouns out: "The raw data are
    available at (osf), and the analysis code at (github)". A link's segment
    runs from the end of the previous link to the first break (comma,
    semicolon, "and") after it. A segment without any noun, the tail of an
    enumeration, "… on GitHub at: (A) & (B)", inherits the start of the
    sentence, which carries the shared noun.
    """
    i = sentence.find(anchor) if anchor else -1
    if i < 0:
        return sentence
    link_end = i + len(anchor)
    others = [(m.start(), m.end()) for m in links.URL_IN_TEXT.finditer(sentence)
              if not (m.start() <= i < m.end() or i <= m.start() < link_end)]
    others += [(m.start(), m.end()) for m in links.DOI_IN_TEXT.finditer(sentence)
               if not (m.start() <= i < m.end() or i <= m.start() < link_end)
               and not any(a <= m.start() < b for a, b in others)]
    if not others:
        return sentence
    start = max([b for a, b in others if b <= i], default=0)
    following = min([a for a, b in others if a >= link_end], default=len(sentence))
    cut = re.search(r"[,;]|\band\b|\bwhile\b|\bwhereas\b", sentence[link_end:following])
    end = link_end + cut.start() if cut else following
    seg = sentence[start:end]
    if not (CODE_NOUNS.search(seg) or DATA_NOUNS.search(seg)):
        seg = sentence[:end]
    return seg


def _near_before(sentence: str, anchor: str, pattern: re.Pattern[str],
                 window: int = 70) -> str:
    """The last noun before the link, within the same clause."""
    i = sentence.find(anchor) if anchor else -1
    if i < 0:
        return ""
    before = sentence[max(0, i - window):i]
    # A clause ends at a semicolon, or at "and" + a new subject.
    before = re.split(r";|\band (?:the )?(?=\w+ (?:is|are|were|was|can)\b)", before)[-1]
    found = list(pattern.finditer(before))
    return found[-1].group(0) if found else ""


def judge(mention: Mention, link: Link, article_authors: list[str],
          article_title: str = "") -> Verdict:
    s = {"code": 0.0, "data": 0.0, "third_party_tool": 0.0}
    r: list[str] = []

    def add(role: str, v: float, why: str) -> None:
        s[role] += v
        r.append(f"{role}{v:+.1f} {why}")

    for role, v in PRIOR.get(link.kind, {}).items():
        add(role, v, f"host {link.host} ({link.kind})")

    sentence = mention.sentence
    anchor = mention.link_text or mention.url
    if anchor not in sentence and mention.url in sentence:
        anchor = mention.url
    titles = " / ".join(mention.sections)
    # The sentence clues are read on the link's SEGMENT: in a sentence with two
    # links, each one has its own nouns.
    seg = segment(sentence, anchor) if mention.location != "references" else sentence
    seg = NON_CODE_CODES.sub(lambda m: "_" * len(m.group(0)), seg)
    code_noun = CODE_NOUNS.search(seg)
    strong_code = STRONG_CODE_NOUNS.search(seg)
    data_noun = DATA_NOUNS.search(ANCILLARY_DATA.sub(" ", seg))
    avail = AVAILABILITY_VERBS.search(seg)
    own = OWN.search(seg)

    # ─── repositories of known tools ──────────────────────────────────────
    if link.owner.lower() in TOOL_ORGS or link.repo in TOOL_REPOS:
        add("third_party_tool", 4.0, f"repository of a public tool ({link.repo})")
    before = sentence[:max(0, sentence.find(anchor))] if anchor in sentence else ""
    named_tool = _TOOLS_RE.findall(before[-60:])
    if named_tool and not (strong_code and own):
        add("third_party_tool", 2.5, f"tool named just before: {named_tool[-1]}")
    elif mention.location != "references" and not own:
        name = TOOL_NAME_BEFORE.search(before[-80:])
        if name and name.group(1) not in _NAMED_HOSTS:
            add("third_party_tool", 1.5, f"software name just before: {name.group(1)}")
        package = NAMED_PACKAGE.search(seg)
        if package and not re.search(r"\bour\b", package.group(0), re.I):
            add("third_party_tool", 2.0, f"named package '{package.group(0)}'")
    if mention.location != "references":
        cited = [c for c in CITATION.findall(seg)
                 if c not in ("Table", "Figure", "Fig", "Version")]
        foreign = [c for c in cited if not shared_authors([c], article_authors)]
        if foreign and not own and link.kind not in ("data",):
            add("third_party_tool", 1.0, f"the sentence cites other authors ({foreign[0]})")

    # ─── the location ─────────────────────────────────────────────────────
    if mention.location == "availability":
        # The NEAREST title, not the path: "Software availability" filed under
        # "Materials and methods" passed for a mixed section.
        nearest = mention.nearest_title
        says_code = re.search(r"\bcodes?\b|software|scripts?", nearest, re.I)
        says_data = re.search(r"\bdata\b|materials?", nearest, re.I)
        if says_code and says_data:
            add("code", 0.75, f"mixed section '{mention.nearest_title[:50]}'")
            add("data", 0.75, f"mixed section '{mention.nearest_title[:50]}'")
        elif says_code:
            add("code", 1.5, f"section '{mention.nearest_title[:50]}'")
        elif says_data:
            add("data", 0.5, f"section '{mention.nearest_title[:50]}'")
    elif mention.location == "references":
        shared = shared_authors(mention.ref_authors, article_authors, sentence)
        own_ref = bool(shared) or (article_title and same_title(article_title, sentence))
        ref_kind = re.search(r"\[(?:computer )?(software|code|data ?set|dataset)\]", sentence, re.I)
        says_data = bool((ref_kind and "data" in ref_kind.group(1).lower())
                         or (re.search(r"\b(data ?sets?|database|recordings|data from"
                                       r"|digital repository)\b", sentence, re.I)
                             and not re.search(r"\b(codes?|scripts?|software)\b", sentence, re.I)))
        if own_ref:
            target = "data" if (says_data or link.kind == "data") else "code"
            who = ", ".join(shared[:2]) if shared else "same title as the paper"
            add(target, 2.5, f"reference signed by the authors ({who})")
        else:
            target = "data" if (link.kind == "data" or says_data) else "third_party_tool"
            add(target, 2.0, "reference to other authors' work")
    elif mention.location == "table":
        if THIS_PAPER.search(sentence):
            target = "code" if (code_noun or link.kind in ("forge", "execution")) and not (
                data_noun and not code_noun) else "data"
            add(target, 3.0, "'This paper' row of the key resources table")
        elif re.search(r"software|algorithm|toolbox", sentence + " " + titles, re.I):
            add("third_party_tool", 2.0, "software row of the key resources table")
    elif mention.location == "metadata":
        # A relation deposited by the publisher or the author: "is-supplemented-by"
        # at Crossref, a piece of DataCite software that declares the paper.
        if mention.section_type.endswith(":own"):
            is_data = ("Dataset" in mention.section_type or link.kind == "data")
            add("data" if is_data else "code", 3.0,
                f"deposited metadata ({mention.section_type.removesuffix(':own')})")
        elif mention.section_type == "github:readme":
            # A README that cites the paper, under an account foreign to the
            # authors: perhaps a reimplementation. Kept, never counted as native.
            r.append("unknown: the README cites the paper, the account is not an author's")
    elif mention.location == "acknowledgements":
        add("third_party_tool", 0.5, "cited in the acknowledgements")
    elif mention.location == "supplementary":
        add("code", 0.5, "supplementary material")

    # ─── the sentence ─────────────────────────────────────────────────────
    if mention.location != "references":
        if strong_code and avail:
            add("code", 2.0, f"'{strong_code.group(0)}' + '{avail.group(0)}'")
        elif code_noun and avail and not named_tool:
            add("code", 1.0, f"'{code_noun.group(0)}' + '{avail.group(0)}'")
        if own and (code_noun or link.kind in ("forge", "execution", "model")):
            add("code", 1.5, f"ownership marker '{own.group(0)}'")
        if data_noun and avail and not code_noun:
            add("data", 2.0, f"'{data_noun.group(0)}' + '{avail.group(0)}', no code noun")
        near_code = _near_before(NON_CODE_CODES.sub(
            lambda m: "_" * len(m.group(0)), sentence), anchor, CODE_NOUNS)
        near_data = _near_before(ANCILLARY_DATA.sub(
            lambda m: "_" * len(m.group(0)), sentence), anchor, DATA_NOUNS)
        if near_code and near_data:
            i_c = sentence.rfind(near_code, 0, max(0, sentence.find(anchor)))
            i_d = sentence.rfind(near_data, 0, max(0, sentence.find(anchor)))
            if i_d > i_c:
                add("data", 1.5, f"the nearest noun is '{near_data}'")
            else:
                add("code", 1.5, f"the nearest noun is '{near_code}'")
        elif near_code:
            add("code", 0.5, f"'{near_code}' just before")
        elif near_data:
            add("data", 1.0, f"'{near_data}' just before")
        tool = TOOL.search(seg)
        if tool and not own and not (strong_code and avail):
            add("third_party_tool", 1.5, f"usage marker '{tool.group(0)}'")

    if link.kind == "forge" and not link.name:
        s["code"] -= 0.5
        r.append("code-0.5 account without a specific repository")

    ranking = sorted(s.items(), key=lambda kv: kv[1], reverse=True)
    (best, v1), (_, v2) = ranking[0], ranking[1]
    margin = round(v1 - v2, 2)
    if v1 < THRESHOLD or margin <= 0:
        role = "unknown"
    else:
        role = best
    confidence = ("high" if v1 >= 3.5 and margin >= 2.0 else
                  "medium" if v1 >= 2.0 and margin >= 1.0 else "low")
    return Verdict(role, confidence, margin, {k: round(v, 2) for k, v in s.items()}, r,
                   bool(ON_REQUEST.search(sentence)))
