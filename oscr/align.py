"""Paper <-> code alignment for OSCR: which paragraph goes with which lines.

Method ``lexical-v1``. Paragraphs of the JATS ``<body>`` and units of the
authors' code (functions, notebook cells, script blocks) are both turned into
bags of technical terms: word stems and two-word phrases, compound
identifiers, numeric constants and ranges, tool names, figure numbers. A
candidate pair scores the sum, over the terms it shares, of the term's rarity
among the article's paragraphs times its rarity among the code units, so a
shared generic word weighs almost nothing while a shared rare constant or
function name weighs a lot. A pair is kept only when several distinct terms
agree (one of them more specific than a single word), when paragraph and unit
rank each other near the top, and when the score clears a threshold set by
reading pairs by hand (25 articles, 2026-09-26). Everything else is dropped:
a wrong highlight costs the reader more than a missing one.

Standard library only, deterministic, no network. Paragraph text is used for
matching only; the exported evidence is a handful of short technical terms,
never a span of the article.
"""

from __future__ import annotations

import ast
import math
import re
import unicodedata
import warnings
from collections import Counter, defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from xml.parsers import expat

METHOD = "lexical-v1"

# ----------------------------------------------------------------- data model


@dataclass(frozen=True)
class Paragraph:
    """One ``<p>`` of the JATS ``<body>``, numbered as the browser numbers it."""

    index: int
    section: str
    text: str


@dataclass(frozen=True)
class CodeUnit:
    """A contiguous line range of one code file (function, cell or block)."""

    repo: str
    path: str
    language: str
    start: int
    end: int
    symbol: str


@dataclass(frozen=True)
class Pair:
    """A paragraph and the code lines that implement what it describes."""

    pair: int
    paragraph: int
    section: str
    repo: str
    path: str
    start_line: int
    end_line: int
    symbol: str
    score: float
    evidence: tuple[str, ...]


# ------------------------------------------------------------------- limits

MAX_FILE_BYTES = 200 * 1024  # bigger files are data dumps or generated code
MAX_UNITS = 400  # per article; keeps scoring well under a second
MAX_UNIT_LINES = 150  # longer definitions are cut into blocks
BLOCK_LINES = 60  # target size of script blocks without structure
MAX_EVIDENCE = 6

# Not the authors' code, or a copy of it.
_SKIP_PATH = re.compile(
    r"(?:^|/)(?:site-packages|node_modules|vendor|vendored|third[_-]?party|external|externals|extern|"
    r"\.ipynb_checkpoints|__pycache__|\.git|dist|build|deps|"
    # well-known toolboxes copied into analysis repositories
    r"surfstat|fieldtrip[^/]*|eeglab[^/]*|spm\d*|chronux[^/]*|circstat[^/]*|bct|export_fig|npy-matlab|gifti[^/]*|"
    r"nifti_?tools?|cbrewer\d?|brewermap|shadederrorbar|violinplot|boundedline|matlab2tikz|jsonlab|"
    r"nearestneighbour|tm_?align)(?:/|$)|-checkpoint\.\w+$",
    re.I,
)
# The authors' code, but not what a paragraph describes.
_AUXILIARY_PATH = re.compile(
    r"(?:^|/)(?:tests?|testing|docs?|benchmarks?|old_?code|archived?(?:_code)?|deprecated|backups?|tmp)/|"
    r"(?:^|/)test_[^/]*$|_tests?\.\w+$|(?:^|/)(?:conftest|setup)\.py$",
    re.I,
)

# ------------------------------------------------------------ normalisation

_TRANSLATE = {ord(c): "-" for c in "\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d"}
_TRANSLATE.update(
    {
        ord("\u00d7"): " x ",
        ord("\u03bc"): "u",
        ord("\u00b5"): "u",
        ord("\u2032"): "'",
        ord("\u2018"): "'",
        ord("\u2019"): "'",
        ord("\u201c"): '"',
        ord("\u201d"): '"',
        ord("\u00b1"): " ",
        ord("\u2264"): " ",
        ord("\u2265"): " ",
        ord("\u00b0"): " deg ",
    }
)
_URL_RE = re.compile(r"(?:https?://|www\.)\S+|\b10\.\d{4,9}/\S+", re.I)  # literal prefixes: linear time


def _norm(s: str) -> str:
    """NFKC plus ASCII dashes, so "6\u201312 Hz" and "6-12 Hz" tokenise alike."""
    return unicodedata.normalize("NFKC", s).translate(_TRANSLATE)


# --------------------------------------------------------------- vocabulary

_STOP = frozenset(
    """
a about above according across actually after afterwards again against all almost alone along already also
although always am among amongst an and another any anyhow anyone anything anyway anywhere are around as at
back be became because become becomes becoming been before beforehand behind being below beside besides between
beyond both but by can cannot could did do does doing done down due during each either else elsewhere enough
especially etc even ever every everyone everything everywhere except few for former formerly from further
furthermore had has have having he hence her here hereby herein hers herself him himself his how however i ie
if in indeed into is it its itself just last latter least less let like likely made mainly make makes making
many may me meanwhile might more moreover most mostly much must my myself namely neither never nevertheless
next no nobody none noone nor not nothing now nowhere of off often on once one only onto or other others
otherwise our ours ourselves out over overall own per perhaps please quite rather re really regarding same
see seem seemed seems several she should since so some somehow someone something sometime sometimes somewhere
still such than that the their theirs them themselves then thence there thereafter thereby therefore therein
thereupon these they this those though through throughout thru thus to together too toward towards under
unless until up upon us very via was we well were what whatever when whence whenever where whereafter whereas
whereby wherein whereupon wherever whether which while whither who whoever whole whom whose why will with
within without would yet you your yours yourself yourselves
eg al et vs versus fig figs figure figures table tables supplementary suppl extended panel panels section
sections equation eq eqs ref refs appendix
use used uses using usage based performed perform performing obtained obtain applied apply applying described
describe previously following follow follows followed shown show shows showed showing seen given give gives
first second third fourth fifth two three four five six seven eight nine ten twenty hundred thousand million
various similar respectively total new found observed study studies present presented current currently
approach approaches method methods result results analysis analyses data dataset datasets
included include includes including consisted consist consists contain contains containing additionally
finally briefly specifically particular particularly namely order addition example examples case cases
number numbers value values mean means average averaged time times different difference differences
significant significantly calculated calculate computed compute estimated estimate measure measured
set sets type types level levels effect effects condition conditions group groups able
""".split()
)

# Identifiers that say nothing about what a unit does.
_CODE_STOP = frozenset(
    """
def class return if elif else for while in is not and or import from as with try except finally raise pass break
continue lambda yield global nonlocal assert del true false none null nan inf self cls print len range enumerate
zip list dict set tuple str int float bool open type isinstance append extend items keys values format join split
strip replace sorted min max sum abs round map any all super object main args kwargs argv argparse parser np numpy
pd pandas plt matplotlib pyplot sns seaborn os sys re json glob math time datetime pathlib path paths shutil pickle
copy random warnings tqdm logging collections itertools functools subprocess function end elseif switch case
otherwise persistent catch disp fprintf sprintf num2str str2num str2double zeros ones size length numel isempty
isfield isnan find cell cellfun arrayfun struct fieldnames load save figure subplot plot hold on off xlabel ylabel
zlabel title legend axis get gca gcf clear clc close tic toc squeeze reshape repmat cat horzcat vertcat floor ceil
sqrt exp log nargin nargout varargin varargout exist strcmp strcmpi strcat fullfile fileparts addpath dir mat eval
library require source c paste paste0 nrow ncol names colnames rownames which apply sapply lapply vapply mapply
invisible stop warning message na tibble mutate select group_by summarise summarize arrange ungroup rename pull
left_join inner_join bind_rows bind_cols ggplot aes theme labs int double char void const static include define
unsigned long short auto sizeof nullptr std vector printf malloc free inline template typename namespace using
public private protected virtual override new delete this echo then fi do done export cd ls rm mkdir cp mv exit
tmp temp val vals var vars res ret out output outputs inp input inputs idx ind inds index indices ii jj kk xx yy
""".split()
)

# Frequent in both prose and code, informative in neither.
_GENERIC = frozenset(
    """
get set load save read write plot file dir path name num count list tmp temp new old init run main test util
utils helper helpers df arr array mat vec val value res out output input info idx index str string int float
print return true false none null nan def self obj object item key dict config cfg args kwargs len size shape
type fig ax axes color colour label title legend xlabel ylabel font fontsize linewidth figsize dpi show savefig
subplot subplots tight layout grid line lines marker markersize xlim ylim xticks yticks ticks cmap colorbar
csv txt mat npy png pdf svg jpg html json xlsx xls fname filename filepath folder directory
jds ii jj kk i j k n m x y z a b t e f g h l p q r s u v w
http https www com org net edu io github gitlab bitbucket doi htm url uri email src lib
th st nd rd tif tiff ome czi dcm lif nd2 nii mgz h5 hdf5 zarr npz yaml yml jpeg bmp gif wise code codes
""".split()
)

# Everyday English: shared by a paragraph and a docstring by chance far more
# often than technical terms, so these weigh 0.3 and never count as evidence.
_COMMON = frozenset(
    """
accept access accompany account achieve acquire act action actual add addition address adequate adjust adopt
advance advantage affect agree aim allow alter alternative amount apparent appear application appropriate
approximate argue arise arrange aspect assess assign assist associate assume assumption attempt attention
author automatic available avoid aware bad balance basic basis bear become begin behalf believe belong benefit
best better big bottom brief bring broad build call capture care carry category cause center central certain
chance change character check choice choose claim clear close collect combine come comment common community
compare comparison complete comprehensive concept concern conclude conclusion conduct confirm consequence
consider considerable consistent constant constitute construct context continue contribute contribution
convenient convert core correct correspond cost count course cover create criterion critical currently custom
deal decide decision define degree demonstrate depend derive describe design desire detail determine develop
development difficult direct discuss discussion display distinct document draw drive drop due early easy
effective effort element else emerge employ enable encounter end enhance enough ensure enter entire entry
environment equal equivalent essential establish evaluate eventual evidence exact examine exceed except
exclude exhibit exist expect experience explain explicit explore express extend extent extra face fact fail
fall familiar far feel final fine finish fix focus form forward framework free frequent full further gain
general generate get give goal good great ground grow guide half hand handle happen hard help high highlight
hold idea identical identify ignore illustrate immediate impact implement implication imply importance
important improve improvement include increase indeed independent indicate individual influence inform
information initial insight instance instead intend interest interesting introduce investigate involve issue
item keep key kind know knowledge lack large last late later lead learn least leave left length less let lie
light like likely limit limitation line link list little live local long look lose lot low lower main maintain
major make manage manner manual manuscript many matter maximum meet member mention middle might mind minimum
minor miss mode modify moment more most move much multiple natural near nearly necessary need negative new
next nice normally notable note notice novel numerous obvious occasion occur offer old open operate operation
opportunity option order organize original otherwise outcome outline overview own paper part partial
particular pass past pay people percent percentage perfect permit person perspective pick piece place plan
play point poor portion possibility possible potential powerful practical practice precise prefer prepare
presence present preserve prevent previous primary principle prior probably problem procedure proceed
produce program progress project promote proper proportion propose protect prove provide publish pull purpose
push put question quick quite raise random range rapid rare rather reach read ready real reality realize
reason receive recent recognize recommend record reduce refer reflect regard regular relate relation
relationship relative release relevant rely remain remove repeat replace report represent request require
requirement research researcher reserve resource respect respective rest restrict reveal review right role
rough rule run safe satisfy save say scale scenario scheme scope search secondary select send sense separate
series serve set share short side sign simple simply single site situation slight slow small solution solve
sort source special specific specify spend stable stage stand standard start state statement stay step still
stop store strategy strong subject subsequent substantial succeed success successful such suffice sufficient
suggest suggestion suit suitable summary supply support suppose sure system take talk target task team
technique tell tend term text theory thing think throughout top topic total toward treat trend true try turn
typical ultimate under understand unique unit update upper use useful user usual valid variety various verify
version view want way whole wide wish work world worth write wrong year
red green blue yellow purple orange black white gray grey cyan magenta pink brown dark light colour color
colored coloured shade shaded dashed dotted solid bold italic inset panel top bottom upper lower middle
processing process finding findings control sample samples structural distribution higher pattern mechanism
future rate region extract statistical contrast image factor underlying material normalize normalized spatial
parameter interpretation visualization visualize driven align aligned software large larger experiment
experimental stability direction area feature response acquisition dependent detect detected integrate
integrated positive analyze analyzed complex visual yield observation vary fully differ known comparable
highly greater multi incorporate taken challenging absence institute university accurate methodology
simultaneous simultaneously robust constrain comprise approve spanning despite funding quantitative exclusion
distinguish combination heterogeneous primarily broad earlier mark extension measurement screening induce
sequential highest ability facilitate leverage notably resolve divide inspection recovery severe pool
replicate diverse adapt period unlike content conventional retain meaningful inclusion summarize systematic
publicly exceed description evaluate evaluation assess assessment perform performance obtain apply
applied compute computed calculate calculated estimate estimated measure measured define defined
represent representation correspond corresponding consider considered result resulting generate generated
annotate annotated format default clean cleaned merge merged interpolate interpolated correct corrected
eliminate reduction decrease decreased increase increased convergence converge column decompose decomposed
coordinate coordinates reference registration register entire subject participant session trial group
function package script pair version toolbox
""".split()
)

_IRREGULAR = {
    "stimuli": "stimulus",
    "indices": "index",
    "matrices": "matrix",
    "vertices": "vertex",
    "analyses": "analysis",
    "hypotheses": "hypothesis",
    "criteria": "criterion",
    "spectra": "spectrum",
    "maxima": "maximum",
    "minima": "minimum",
    "nuclei": "nucleus",
    "foci": "focus",
    "mice": "mouse",
}

# Code abbreviations whose long form is what papers write.
_ABBREV = {
    "amp": "amplitude", "amps": "amplitude", "freq": "frequency", "freqs": "frequency", "corr": "correlation",
    "corrs": "correlation", "coh": "coherence", "perm": "permutation", "perms": "permutation",
    "nperm": "permutation", "thresh": "threshold", "thr": "threshold", "filt": "filter", "spk": "spike",
    "spks": "spike", "stim": "stimulus", "stims": "stimulus", "resp": "response", "avg": "average", "img": "image",
    "imgs": "image", "seg": "segmentation", "vel": "velocity", "pos": "position", "dur": "duration",
    "env": "envelope", "ctx": "cortex", "hpc": "hippocampus", "hipp": "hippocampus", "hippo": "hippocampus",
    "acc": "accuracy", "prob": "probability", "probs": "probability", "dist": "distance", "conn": "connectivity",
    "sim": "simulation", "sims": "simulation", "param": "parameter", "params": "parameter",
    "norm": "normalization", "vol": "volume", "vols": "volume", "diff": "difference", "rec": "recording",
    "sess": "session", "subj": "subject", "subjs": "subject", "trl": "trial", "chan": "channel",
    "chans": "channel", "elec": "electrode", "behav": "behavior", "cond": "condition", "conds": "condition",
    "pred": "prediction", "preds": "prediction", "feat": "feature", "feats": "feature", "clf": "classifier",
    "mdl": "model", "boot": "bootstrap", "nboot": "bootstrap", "evt": "event", "evts": "event",
    "rip": "ripple", "rips": "ripple", "spectro": "spectrogram", "psd": "power spectral density",
    "lr": "learning rate",
}

# display name, pattern in the paper, pattern in code
_TOOL_TABLE: tuple[tuple[str, str, str], ...] = (
    ("FieldTrip", r"\bfield\s?trip\b", r"\bft_[a-z]\w*|\bfieldtrip\b"),
    ("EEGLAB", r"\beeglab\b", r"\beeglab\b|\bpop_[a-z]\w*"),
    ("MNE", r"\bmne\b", r"\bmne\b"),
    ("SPM", r"\bspm\s?(?:8|12)?\b", r"\bspm_[a-z]\w*|\bspm(?:8|12)\b"),
    ("FSL", r"\bfsl\b", r"\bfsl[a-z]*\b|\bflirt\b|\bfnirt\b"),
    ("FreeSurfer", r"\bfree\s?surfer\b", r"\bfreesurfer\b|\brecon-all\b|\bmri_[a-z]\w*"),
    ("AFNI", r"\bafni\b", r"\bafni\b|\b3d(?:Deconvolve|Skullstrip|volreg|Tproject|Automask|calc)\b"),
    ("ANTs", r"\bants(?:py)?\b", r"\bants[A-Z]\w*|\bantspy\b|\bants\.[a-z]"),
    ("fMRIPrep", r"\bfmriprep\b", r"\bfmriprep\b"),
    ("nilearn", r"\bnilearn\b", r"\bnilearn\b"),
    ("nibabel", r"\bnibabel\b", r"\bnibabel\b"),
    ("Kilosort", r"\bkilosort\d?\b", r"\bkilosort\d?\b"),
    ("Suite2p", r"\bsuite2p\b", r"\bsuite2p\b"),
    ("CaImAn", r"\bcaiman\b", r"\bcaiman\b"),
    ("DeepLabCut", r"\bdeep\s?lab\s?cut\b", r"\bdeeplabcut\b"),
    ("scikit-learn", r"\bscikit-?learn\b|\bsklearn\b", r"\bsklearn\b"),
    ("statsmodels", r"\bstatsmodels\b", r"\bstatsmodels\b"),
    ("lme4", r"\blme4\b", r"\blme4\b|\bg?lmer\s*\("),
    ("nlme", r"\bnlme\b", r"\bnlme\b"),
    ("PyTorch", r"\bpytorch\b", r"\btorch\.\w"),
    ("TensorFlow", r"\btensorflow\b", r"\btensorflow\b|\btf\.keras\b"),
    ("Keras", r"\bkeras\b", r"\bkeras\b"),
    ("timm", r"\btimm\b", r"\btimm\.\w"),
    ("Snakemake", r"\bsnakemake\b", r"\bsnakemake\b"),
    ("ComBat", r"\bcombat\b", r"\bcombat\b|\bneurocombat\b|\bneuroharmonize\b|\bharmonizationlearn\b"),
    ("Brian2", r"\bbrian\s?2\b", r"\bbrian2\b"),
    ("Chronux", r"\bchronux\b", r"\bchronux\b|\bmtspecgramc\b|\bcohgramc\b"),
    ("CircStat", r"\bcircstat\b", r"\bcirc_[a-z]\w*"),
    ("Seurat", r"\bseurat\b", r"\bseurat\b|\bcreateseuratobject\b"),
    ("Scanpy", r"\bscanpy\b", r"\bscanpy\b|\bsc\.(?:pp|tl|pl)\.\w"),
    ("DESeq2", r"\bdeseq2\b", r"\bdeseq2?\b|\bdeseqdataset"),
    ("limma", r"\blimma\b", r"\blimma\b|\blmfit\b|\bebayes\b"),
    ("Foldseek", r"\bfoldseek\b", r"\bfoldseek\b"),
    ("AlphaFold", r"\balpha\s?fold\d?\b", r"\balphafold\d?\b"),
    ("Cellpose", r"\bcellpose\b", r"\bcellpose\b"),
    ("StarDist", r"\bstardist\b", r"\bstardist\b"),
    ("OpenCV", r"\bopencv\b", r"\bcv2\.\w"),
    ("scikit-image", r"\bscikit-?image\b|\bskimage\b", r"\bskimage\b"),
    ("NetworkX", r"\bnetworkx\b", r"\bnetworkx\b|\bnx\.[a-z]"),
    ("Brainstorm", r"\bbrainstorm\b", r"\bbst_[a-z]\w*"),
    ("DIPY", r"\bdipy\b", r"\bdipy\b"),
    ("MRtrix", r"\bmrtrix\d?\b", r"\bmrtrix\d?\b|\btckgen\b|\bdwi2fod\b"),
    ("PyMC", r"\bpymc\d?\b", r"\bpymc\d?\b"),
    ("brms", r"\bbrms\b", r"\bbrms\b|\bbrm\s*\("),
    ("emmeans", r"\bemmeans\b", r"\bemmeans\b"),
    ("betareg", r"\bbetareg\b", r"\bbetareg\b"),
    ("Optuna", r"\boptuna\b", r"\boptuna\b"),
    ("XGBoost", r"\bxgboost\b", r"\bxgboost\b|\bxgb\.\w"),
    ("SHAP", r"\bshap\b", r"\bshap\b"),
    ("UMAP", r"\bumap\b", r"\bumap\b"),
    ("t-SNE", r"\bt-?sne\b", r"\btsne\b"),
)
_TOOLS_PAPER = tuple((name, re.compile(pat, re.I)) for name, pat, _ in _TOOL_TABLE)
_TOOLS_CODE = tuple((name, re.compile(pat, re.I)) for name, _, pat in _TOOL_TABLE)


def _stem(word: str) -> str:
    """Light suffix stripping plus truncation: plural, -ing, -ed, final -e.

    Enough to meet "filtered"/"filtering"/"filter" or "spikes"/"spiking"
    without a dictionary; truncation at 7 letters joins "correlation" and
    "correlated" but keeps "position" and "positive" apart.
    """
    w = _IRREGULAR.get(word, word)
    if len(w) <= 3 or not w.isalpha():
        return w
    if w.endswith("ies") and len(w) > 4:
        w = w[:-3] + "y"
    elif w.endswith(("sses", "shes", "ches", "xes", "zes")):
        w = w[:-2]
    elif w.endswith("s") and not w.endswith(("ss", "us", "is")):
        w = w[:-1]
    if w.endswith("ly") and len(w) >= 7:
        w = w[:-2]  # randomly -> random, manually -> manual
    for suffix in ("ing", "ed"):
        if w.endswith(suffix) and len(w) - len(suffix) >= 3:
            w = w[: -len(suffix)]
            if len(w) > 3 and w[-1] == w[-2] and w[-1] not in "lsz":
                w = w[:-1]
            break
    if len(w) > 3 and w.endswith("e"):
        w = w[:-1]
    return w[:7]


_STOP_STEMS = frozenset(_stem(w) for w in _STOP | _GENERIC)
_COMMON_STEMS = frozenset(_stem(w) for w in _COMMON)


def _keep(word: str) -> str | None:
    """Stem of a content word, or None for stop words and noise."""
    if len(word) < 2 or word in _STOP or word in _GENERIC or word.isdigit():
        return None
    stem = _stem(word)
    if stem in _STOP_STEMS or len(stem) < 2:
        return None
    return stem


# EEG 10-20 electrode labels (F3, FP1, Cz): channel lists match by enumeration.
_ELECTRODE_RE = re.compile(r"(?:fp|af|f|fc|ft|c|cp|tp|t|p|po|o|i|a)(?:z|\d{1,2})")


def _everyday(stem: str) -> bool:
    return stem in _COMMON_STEMS or bool(_ELECTRODE_RE.fullmatch(stem))


def _term_prior(key: str) -> float:
    """Everyday words, electrode labels and phrases made only of them weigh 0.3."""
    kind, value = key[0], key[2:]
    if kind == "w":
        return 0.3 if _everyday(value) else 1.0
    if kind == "b":
        first, _, second = value.partition(" ")
        return 0.3 if _everyday(first) and _everyday(second) else 1.0
    return 1.0


# ------------------------------------------------------------------ numbers

_ROUND_NUMBERS = frozenset(
    {0.5, 0.1, 0.05, 0.01, 0.001, 0.25, 0.75, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 12, 15, 16, 20,
     24, 25, 30, 32, 40, 50, 60, 64, 70, 80, 90, 99, 100, 120, 128, 150, 180, 200, 250, 256, 300, 360, 400,
     500, 512, 1000, 1024, 2000, 5000, 10000}
)


def _canon(value: float) -> str:
    if value == int(value) and abs(value) < 1e12:
        return str(int(value))
    return f"{value:.6g}"


def _number_weight(value: float) -> float:
    """Prior informativeness of a shared constant: 1-10 say nothing, 0.05 little."""
    if value == int(value):
        if 0 <= value <= 10:
            return 0.0
        if 1900 <= value <= 2035:
            return 0.2
    if value in _ROUND_NUMBERS:
        return 0.4
    if value == int(value) and value < 100:
        return 0.5
    return 1.0


_UNIT = (
    r"(?:khz|mhz|hz|msec|ms|secs?|seconds?|s|minutes?|mins?|hours?|hrs?|h|days?|mm|cm|um|nm|mv|uv|db|%|deg|degrees?|"
    r"mt|t|kg|mg|ml|ul|px|pixels?|voxels?|epochs?|bins?|trials?|permutations?|iterations?|folds?|samples?|"
    r"components?|clusters?|neurons?|subjects?|participants|seeds?|runs|repetitions|shuffles|bootstraps?|"
    r"resamples|features|layers|units|dimensions|channels|electrodes|frames|fps|steps|images|patients|animals|"
    r"sessions|cycles|points|classes|nodes|regions|parcels|rois|times)(?![a-z])"
)
_NUM = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+"
_PROSE_RE = re.compile(
    rf"(?P<sci>(?P<mant>{_NUM})\s*x\s*10\s*\^?\s*(?P<exp>-?\s*\d+))"
    rf"|(?P<between>between\s+(?P<blo>{_NUM})\s*(?P<bu1>{_UNIT})?\s+and\s+(?P<bhi>{_NUM})\s*(?P<bu2>{_UNIT})?)"
    rf"|(?P<range>(?P<lo>{_NUM})\s*(?P<ru1>{_UNIT})?\s*(?:-|to)\s*(?P<hi>{_NUM})(?:\s*(?P<ru2>{_UNIT}))?)"
    rf"|(?P<num>(?:{_NUM})(?:e-?\d+)?)(?:\s*(?P<unit>{_UNIT}))?"
    r"|(?P<word>[a-z][a-z0-9]*(?:[_.][a-z0-9]+)*)"
    r"|(?P<brk>[.,;:()\[\]{}!?\"=<>|/+*])",
    re.I,
)


def _to_float(s: str) -> float | None:
    try:
        v = float(s.replace(",", ""))
    except ValueError:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return abs(v)


def _conversions(value: float, unit: str | None) -> list[float]:
    """Same quantity in the other units code tends to use (kHz->Hz, ms<->s, %->ratio)."""
    out = [value]
    u = (unit or "").lower()
    if u == "khz":
        out.append(value * 1000)
    elif u in ("ms", "msec"):
        out.append(value / 1000)
    elif u in ("s", "sec", "secs", "second", "seconds"):
        out.append(value * 1000)
    elif u in ("min", "mins", "minute", "minutes"):
        out.append(value * 60)
    elif u == "%":
        out.append(value / 100)
    return out


# ------------------------------------------------------------------ features
#
# A feature key is "<kind>:<value>". Kinds: w word stem, b two stems in a row,
# i compound identifier, n number, r numeric range, t tool, f figure number.

_KIND_WEIGHT = {"w": 1.0, "b": 1.2, "i": 2.0, "n": 1.0, "r": 2.0, "t": 1.0, "f": 0.8}


@dataclass
class _Bag:
    """Features of one paragraph or unit, with a readable form for evidence."""

    feats: dict[str, float] = field(default_factory=dict)  # key -> prior weight
    surface: dict[str, str] = field(default_factory=dict)
    unitful: set[str] = field(default_factory=set)  # numbers written with a unit
    seq: list[str | None] = field(default_factory=list)  # stems in order, None at breaks
    words: list[str] = field(default_factory=list)  # surface word per seq slot
    scale: float = 1.0  # weight of the source being read (see _code_features)

    def add(self, key: str, surface: str, weight: float = 1.0) -> None:
        weight *= self.scale
        if weight <= 0:
            return
        if weight > self.feats.get(key, 0.0):
            self.feats[key] = weight
        self.surface.setdefault(key, surface)

    def add_run(self, run: list[tuple[str, str]]) -> None:
        """Adjacent content words (stem, surface): unigrams and bigrams."""
        for i, (stem, surf) in enumerate(run):
            self.add("w:" + stem, surf)
            if i:
                prev_stem, prev_surf = run[i - 1]
                if prev_stem != stem:
                    self.add(f"b:{prev_stem} {stem}", f"{prev_surf} {surf}")
        self.seq.extend(s for s, _ in run)
        self.words.extend(w for _, w in run)
        self.seq.append(None)
        self.words.append("")


_CAMEL_RE = re.compile(r"[A-Z]+\d*(?=[A-Z][a-z])|[A-Z]?[a-z]+\d*|[A-Z]+\d*|\d+")


def _split_ident(ident: str) -> list[str]:
    """snake_case and camelCase parts, lowercased ("allPSI_mean" -> all, psi, mean)."""
    parts: list[str] = []
    for chunk in ident.split("_"):
        if not chunk:
            continue
        if chunk.islower() or chunk.isupper() or chunk.isdigit():
            parts.append(chunk.lower())
        else:
            parts.extend(p.lower() for p in _CAMEL_RE.findall(chunk))
    return parts


def _is_compound(ident: str) -> bool:
    """Several words glued together, or letters and digits mixed (resnet50)."""
    return len(_split_ident(ident)) >= 2 or bool(re.search(r"[a-z]\d|\d[a-z]", ident, re.I))


def _camel(word: str) -> bool:
    # "[A-Z]{2}" rather than "{2,}": same matches, but linear on long capital runs
    return bool(re.search(r"[a-z][A-Z]|[A-Z]{2}[a-z]{2}", word))


_CITED_NAME_RE = re.compile(r"\b[A-Z][\w'-]+(?:\s+(?:and|&)\s+[A-Z][\w'-]+)?\s+et\s+al\b\.?|\bet\s+al\b\.?")


def _prose_features(bag: _Bag, text: str, *, code_side: bool = False) -> None:
    """Words, numbers with units and ranges of natural-language text.

    Stop words break phrases, so a two-word feature always joins words that
    touch in the text, and evidence phrases are real phrases.
    """
    text = _URL_RE.sub(" ", _norm(text))
    text = re.sub(r"(?<=\d)\s*x\s*(?=\d)", " x ", text)
    text = _CITED_NAME_RE.sub(" ", text)
    run: list[tuple[str, str]] = []

    def prior(weight: float) -> float:
        if code_side:  # the paper side says how telling a number is; code only says it is there
            return 1.0 if weight > 0 else 0.0
        return weight

    def flush() -> None:
        bag.add_run(run)
        run.clear()

    def push(word: str, surface: str) -> None:
        stem = _keep(word)
        if stem is None:
            flush()
        else:
            run.append((stem, surface))

    for m in _PROSE_RE.finditer(text):
        kind = m.lastgroup
        if kind == "word":
            raw = m.group("word")
            if "." in raw or "_" in raw:
                flush()
                pieces = [p for p in re.split(r"[._]", raw) if p]
                if (len(raw) >= 5 and len(pieces) >= 2 and max(len(p) for p in pieces) >= 3
                        and not any(p.lower() in _STOP for p in pieces)):
                    bag.add("i:" + raw.lower(), raw)
                for piece in pieces:
                    for part in (_split_ident(piece) if code_side else [piece.lower()]):
                        push(part, part)
                flush()
                continue
            if len(raw) >= 4 and (_camel(raw) or re.search(r"[a-z]\d+[a-z]", raw, re.I)):
                bag.add("i:" + raw.lower(), raw)  # a cited identifier or product name (RobustICA, suite2p)
            if code_side and _camel(raw):
                for part in _split_ident(raw):
                    push(part, part)
                continue
            push(raw.lower(), raw)
            continue
        flush()
        if kind == "brk":
            continue
        if kind == "sci":
            mant = _to_float(m.group("mant"))
            exp = re.sub(r"\s", "", m.group("exp"))
            if mant is not None:
                try:
                    value = mant * 10 ** int(exp)
                except (ValueError, OverflowError):
                    continue
                bag.add("n:" + _canon(value), m.group(0), prior(_number_weight(value)))
        elif kind in ("between", "range"):
            b = kind == "between"
            lo = _to_float(m.group("blo" if b else "lo"))
            hi = _to_float(m.group("bhi" if b else "hi"))
            unit = m.group("bu2" if b else "ru2") or m.group("bu1" if b else "ru1")
            if lo is None or hi is None:
                continue
            if lo < hi:
                small = lo == int(lo) and hi == int(hi) and hi <= 10
                range_prior = 0.3 if small else 1.0 if unit else 0.7
                shown = f"{_canon(lo)}\u2013{_canon(hi)}" + (f" {unit}" if unit else "")
                for a, c in zip(_conversions(lo, unit), _conversions(hi, unit)):
                    bag.add(f"r:{_canon(a)}-{_canon(c)}", shown, prior(range_prior))
            for v in (lo, hi):
                for c in _conversions(v, unit):
                    key = "n:" + _canon(c)
                    bag.add(key, _canon(v) + (f" {unit}" if unit else ""), prior(_number_weight(c) * (0.8 if unit else 0.4)))
                    if unit:
                        bag.unitful.add(key)
        elif kind == "num":
            value = _to_float(m.group("num"))
            if value is None:
                continue
            unit = m.group("unit")
            for c in _conversions(value, unit):
                key = "n:" + _canon(c)
                bag.add(key, m.group(0).strip(), prior(_number_weight(c) * (1.0 if unit else 0.5)))
                if unit:
                    bag.unitful.add(key)
    flush()


def _tool_features(bag: _Bag, text: str, table: tuple[tuple[str, re.Pattern[str]], ...]) -> None:
    for name, pattern in table:
        if pattern.search(text):
            bag.add("t:" + name.lower(), name)


_FIG_XREF_RE = re.compile(r"^\s*fig(?:ure)?s?\.?\s*(\d{1,2})(?!\d)", re.I)


def _figure_number(label: str) -> int | None:
    """Main-figure number of "Figure 3E" or "Fig. 2"; None for supplementary ones."""
    label = _norm(label)
    if re.search(r"supp|extended|appendix|\bS\d", label, re.I) and not re.search(
        r"figure\s+\d+\s*-\s*figure supplement", label, re.I
    ):
        return None
    m = _FIG_XREF_RE.match(label)
    return int(m.group(1)) if m else None


def _path_figures(path: str) -> list[int]:
    """Figure numbers written in a path: Figure3/, Fig4_x.ipynb, plot_fig_2.py."""
    found: list[int] = []
    for component in re.split(r"[/\\]", path):
        parts = _split_ident(re.sub(r"[^A-Za-z0-9_]", "_", component))
        for i, part in enumerate(parts):
            m = re.fullmatch(r"fig(?:ure)?(\d{1,2})", part)
            number = int(m.group(1)) if m else None
            if number is None and part in ("fig", "figure") and i + 1 < len(parts) and parts[i + 1].isdigit():
                number = int(parts[i + 1])
            if number is None:
                continue
            before = parts[i - 1] if i else ""
            if before in ("supp", "supplementary", "suppl", "si", "extended", "sup", "s"):
                continue
            found.append(number)
    return found


# ----------------------------------------------------------------- JATS side


class _Node:
    __slots__ = ("name", "attrs", "kids", "parent")

    def __init__(self, name: str, attrs: dict[str, str], parent: _Node | None) -> None:
        self.name = name
        self.attrs = attrs
        self.kids: list[_Node | str] = []
        self.parent = parent


def _parse_xml(xml: str) -> _Node | None:
    """Tree with qualified names ("p", "mml:math"), no namespace processing.

    DOM's getElementsByTagName in an XML document matches the qualified
    name, so keeping names as written is what makes the numbering identical
    to the browser's, whatever namespaces the document declares.
    """
    doc = _Node("#document", {}, None)
    stack = [doc]
    parser = expat.ParserCreate()
    parser.buffer_text = True

    def start(name: str, attrs: dict[str, str]) -> None:
        node = _Node(name, attrs, stack[-1])
        stack[-1].kids.append(node)
        stack.append(node)

    def end(_name: str) -> None:
        stack.pop()

    def chars(data: str) -> None:
        stack[-1].kids.append(data)

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = chars
    if not isinstance(xml, (str, bytes)):
        return None
    try:
        parser.Parse(xml, True)
    except (expat.ExpatError, ValueError, IndexError):
        return None
    return doc


def _descendants(node: _Node) -> Iterator[_Node]:
    """Elements below ``node`` in document order (pre-order), like the DOM."""
    stack = [k for k in reversed(node.kids) if isinstance(k, _Node)]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(k for k in reversed(current.kids) if isinstance(k, _Node))


_TEXT_SKIP = frozenset(
    {"p", "tex-math", "alternatives", "disp-formula", "inline-formula", "table-wrap", "fig", "graphic",
     "inline-graphic", "media", "fn", "alt-text", "object-id", "supplementary-material", "disp-formula-group"}
)
_INLINE = frozenset(
    {"italic", "bold", "sup", "sub", "sc", "underline", "monospace", "named-content", "styled-content", "xref",
     "ext-link", "uri", "email", "roman", "sans-serif", "overline", "strike", "abbrev", "span", "x"}
)


def _node_text(node: _Node, figs: list[int] | None = None, code: list[str] | None = None) -> str:
    """Readable text of an element, without nested paragraphs, maths or citations.

    Iterative, so a pathologically deep document cannot exhaust the stack.
    """
    out: list[str] = []
    stack: list[_Node | str] = list(reversed(node.kids))
    while stack:
        kid = stack.pop()
        if isinstance(kid, str):
            out.append(kid)
            continue
        name = kid.name
        if name in _TEXT_SKIP or name.endswith("math"):
            out.append(" ")
            continue
        if name == "xref":
            ref_type = kid.attrs.get("ref-type", "")
            if ref_type == "bibr":
                continue
            if ref_type == "fig" and figs is not None:
                number = _figure_number(_node_text(kid))
                if number is not None:
                    figs.append(number)
        if name == "monospace" and code is not None:
            code.append(_node_text(kid))
        if name in _INLINE:
            stack.extend(reversed(kid.kids))
        else:
            out.append(" ")
            stack.append(" ")  # emitted after the children
            stack.extend(reversed(kid.kids))
    return " ".join("".join(out).split())


_EXCLUDED_ANCESTORS = frozenset(
    {"fn", "fn-group", "table-wrap-foot", "supplementary-material", "ref-list", "ref", "ack", "glossary", "def-list",
     "td", "th", "notes", "author-notes", "bio", "front-stub", "sub-article"}
)
_SEC_EXCLUDE = re.compile(
    r"acknowledg|funding|financial support|author(?:s|'s|s')?\s+contribution|contributors?\b|"
    r"competing|conflicts? of interest|declaration|disclosure|availability|data sharing|lead contact|"
    r"supplementary|supplemental|supporting information|associated data|^references?$|bibliography|footnote|"
    r"abbreviation|ethic|institutional review|informed consent|consent for publication|peer review|source data|"
    r"additional (?:information|files)|author information|reporting summary|key resources table|"
    r"inclusion and diversity|materials? and correspondence",
    re.I,
)
_SEC_NARRATIVE = re.compile(
    r"^(?:introduction|background|discussion(?: and conclusions?)?|conclusions?|concluding remarks|"
    r"limitations?(?: of (?:the|this) study)?|outlook|future (?:work|directions)|significance(?: statement)?|"
    r"summary|related work|main|graphical (?:overview|abstract)|highlights|perspectives?|research in context|"
    r"evidence before this study|added value of this study|implications of all the available evidence)$",
    re.I,
)
_SEC_METHODS = re.compile(
    r"method|material|procedure|protocol|experiment|implementation|algorithm|model|simulat|analys|statistic|"
    r"preprocess|processing|acquisition|recording|pipeline|software|dataset|training|evaluation|setup|workflow|"
    r"quantif|measure|detection|estimation|segmentation|classification|computation|architecture|tool|rule|"
    r"snakefile|helper",
    re.I,
)


def _clean_title(title: str) -> str:
    """Drop section numbering ("2.3.", "IV.") and trailing punctuation."""
    title = re.sub(r"^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+", "", title)
    return title.strip(" .:\u2019\u2018'")


def _paragraph_weight(titles: list[str], ancestors: list[str], body_has_sections: bool) -> float:
    """How much a paragraph may describe code; 0 keeps it out of matching.

    Methods-like sections weigh 1, results 0.8, captions less; narrative
    sections (introduction, discussion) and back matter never match: they
    name methods without describing what the code does.
    """
    if any(a in _EXCLUDED_ANCESTORS for a in ancestors):
        return 0.0
    if any(_SEC_EXCLUDE.search(_clean_title(t)) for t in titles):
        return 0.0
    if not titles and body_has_sections and "caption" not in ancestors:
        return 0.0  # untitled text before the first section is the introduction
    top = _clean_title(titles[0]) if titles else ""
    if top and _SEC_NARRATIVE.match(top):
        return 0.0
    if re.search(r"result", top, re.I):
        weight = 0.8
    elif _SEC_METHODS.search(top) or any(_SEC_METHODS.search(t) for t in titles[1:]):
        weight = 1.0
    else:
        weight = 0.9
    if "caption" in ancestors:
        weight *= 0.75 if "fig" in ancestors else 0.5
    return weight


@dataclass
class _Para:
    paragraph: Paragraph
    weight: float
    bag: _Bag
    title_keys: frozenset[str]


def _paper(jats_xml: str, features: bool = True) -> list[_Para]:
    """All body paragraphs, with their matching features unless ``features`` is False."""
    doc = _parse_xml(jats_xml)
    if doc is None:
        return []
    root = next((k for k in doc.kids if isinstance(k, _Node)), None)
    body = next((k for k in root.kids if isinstance(k, _Node) and k.name == "body"), None) if root else None
    if body is None:  # sub-article bodies are never read: the reader uses the root's own <body>
        return []
    body_has_sections = any(isinstance(k, _Node) and k.name == "sec" for k in body.kids)
    title_cache: dict[int, str] = {}
    records: list[_Para] = []
    for index, p in enumerate([n for n in _descendants(body) if n.name == "p"]):
        titles: list[str] = []
        ancestors: list[str] = []
        fig_label: int | None = None
        node = p.parent
        while node is not None and node is not body:
            ancestors.append(node.name)
            if node.name == "sec":
                key = id(node)
                if key not in title_cache:
                    title = next((k for k in node.kids if isinstance(k, _Node) and k.name == "title"), None)
                    title_cache[key] = _node_text(title) if title is not None else ""
                if title_cache[key]:
                    titles.append(title_cache[key])
            elif node.name == "fig" and fig_label is None:
                label = next((k for k in node.kids if isinstance(k, _Node) and k.name == "label"), None)
                if label is not None:
                    fig_label = _figure_number(_node_text(label))
            node = node.parent
        titles.reverse()
        figs: list[int] = []
        code_terms: list[str] = []
        text = _node_text(p, figs, code_terms)
        paragraph = Paragraph(index=index, section=" \u203a ".join(titles), text=text)
        weight = _paragraph_weight(titles, ancestors, body_has_sections) if len(text) >= 40 else 0.0
        bag = _Bag()
        title_keys: frozenset[str] = frozenset()
        if features and len(text) >= 40:  # every paragraph informs term rarity; weighted ones are matched
            _prose_features(bag, text)
            _tool_features(bag, text, _TOOLS_PAPER)
            for term in code_terms:
                term = term.strip()
                if 4 <= len(term) <= 60 and " " not in term:
                    bag.add("i:" + term.lower(), term)
            if fig_label is not None and "caption" in ancestors:
                figs.append(fig_label)
            for number in dict.fromkeys(figs):
                bag.add(f"f:{number}", f"Figure {number}")
            if titles:
                title_bag = _Bag()
                _prose_features(title_bag, _clean_title(titles[-1]))
                title_keys = frozenset(k for k in title_bag.feats if k[0] in "wb")
                for key in sorted(title_keys):
                    if key not in bag.feats:
                        bag.add(key, title_bag.surface[key], 0.5)
        records.append(_Para(paragraph, weight, bag, title_keys))
    return records


def paper_paragraphs(jats_xml: str) -> list[Paragraph]:
    """Every ``<p>`` under the root element's direct ``<body>`` child, in
    document order (``body.iter("p")``).

    Index i is the position in that list, as the website reader computes it
    on the same Europe PMC XML; captions, list items and table notes are
    numbered too even though some never take part in matching.
    """
    return [record.paragraph for record in _paper(jats_xml, features=False)]


# ---------------------------------------------------------------- code side


@dataclass
class _Seg:
    start: int  # 1-based inclusive
    end: int
    symbol: str


def _family(language: str, path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    lang = (language or "").lower()
    if ext == "ipynb" or lang == "jupyter":
        return "notebook"
    if ext in ("rmd", "qmd") or lang == "quarto":
        return "chunks"
    if ext == "m" or lang == "matlab":
        return "matlab"
    if ext == "r" or lang == "r":
        return "r"
    if ext in ("py", "pyw", "smk") or lang == "python" or name == "Snakefile":
        return "python"
    if ext in ("c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cu", "cuh") or lang in ("c", "c++", "c/c++", "cuda"):
        return "c"
    if ext in ("sh", "bash", "zsh", "ksh") or lang == "shell":
        return "shell"
    return "generic"


def _lines_of(text: str) -> list[str]:
    """Lines numbered exactly as the website reader numbers them.

    The reader (and the harvester's line counts) split on "\\n" only, so a
    lone "\\r", a form feed or any other character str.splitlines() would
    treat as a break must not start a line here. Carriage returns are blanked
    inside lines so that ``ast`` (which reads "\\r" as a newline) keeps the
    same numbering.
    """
    lines = [line.replace("\r", " ") for line in text.split("\n")]
    if len(lines) > 1 and lines[-1] == "":
        lines.pop()
    return lines


def _blank(line: str) -> bool:
    return not line.strip()


def _comment_line(line: str, family: str) -> bool:
    s = line.lstrip()
    if family == "matlab":
        return s.startswith("%")
    if family == "c":
        return s.startswith(("//", "/*", "*"))
    return s.startswith("#")


def _trim(lines: list[str], start: int, end: int) -> tuple[int, int] | None:
    """Shrink [start, end] (1-based) to drop blank lines at both ends."""
    while start <= end and _blank(lines[start - 1]):
        start += 1
    while end >= start and _blank(lines[end - 1]):
        end -= 1
    return (start, end) if start <= end else None


def _blocks(lines: list[str], start: int, end: int, family: str, symbol: str = "") -> list[_Seg]:
    """Cut an unstructured stretch into blocks at comment headers or blank lines.

    Preferred cut: a blank line followed by a comment (a section header in
    most research scripts); else the blank line nearest the target size;
    else a hard cut.
    """
    span = _trim(lines, start, end)
    if span is None:
        return []
    start, end = span
    segs: list[_Seg] = []
    cur = start
    while cur <= end:
        if end - cur + 1 <= BLOCK_LINES * 3 // 2:
            segs.append(_Seg(cur, end, symbol))
            break
        lo, hi = cur + BLOCK_LINES // 3, min(end, cur + BLOCK_LINES * 3 // 2)
        cut = None
        for i in range(lo, hi + 1):  # i: 1-based line that would start the next block
            if _blank(lines[i - 2]) and not _blank(lines[i - 1]) and _comment_line(lines[i - 1], family):
                cut = i
                if i - cur >= BLOCK_LINES * 2 // 3:
                    break
        if cut is None:
            blanks = [i for i in range(lo, hi + 1) if _blank(lines[i - 1])]
            cut = min(blanks, key=lambda i: abs(i - (cur + BLOCK_LINES))) + 1 if blanks else cur + BLOCK_LINES
        span = _trim(lines, cur, cut - 1)
        if span:
            segs.append(_Seg(span[0], span[1], symbol))
        cur = cut
    return segs


def _attach_comments_above(lines: list[str], start: int, floor: int, family: str) -> int:
    """Move a definition's start up over the comment lines right above it."""
    i = start
    while i - 1 >= max(floor, 1) and _comment_line(lines[i - 2], family):
        i -= 1
    return i


def _parse_python(source: str) -> ast.Module | None:
    """``ast.parse`` without the SyntaxWarnings the authors' code may trigger."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return ast.parse(source)
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None


def _decorated_start(node: ast.AST) -> int:
    start = getattr(node, "lineno", 1)
    for decorator in getattr(node, "decorator_list", ()) or ():
        start = min(start, decorator.lineno)
    return start


def _python_segments(lines: list[str], offset: int = 0) -> list[_Seg] | None:
    """Top-level functions and classes by ``ast``; module code as blocks.

    ``offset`` shifts line numbers when ``lines`` is a notebook cell.
    """
    tree = _parse_python("\n".join(lines))
    if tree is None:
        return None
    segs: list[_Seg] = []
    pending: list[tuple[int, int]] = []  # module-level statements waiting to become blocks

    def floor() -> int:
        return segs[-1].end + 1 if segs else 1

    def flush() -> None:
        if pending:
            lo = _attach_comments_above(lines, pending[0][0], floor(), "python")
            segs.extend(_blocks(lines, lo, pending[-1][1], "python"))
            pending.clear()

    for node in tree.body:
        start, end = _decorated_start(node), node.end_lineno or node.lineno
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            flush()
            start = _attach_comments_above(lines, start, floor(), "python")
            if end - start + 1 > MAX_UNIT_LINES:
                segs.extend(_split_python_def(lines, node, start, end))
            else:
                segs.append(_Seg(start, end, node.name))
            continue
        if pending and start - pending[-1][1] > 1:
            gap = lines[pending[-1][1] : start - 1]
            if any(_blank(g) for g in gap) and any(_comment_line(g, "python") for g in gap):
                flush()  # a commented header after a blank line opens a new block
        pending.append((start, end))
    flush()
    if offset:
        segs = [_Seg(s.start + offset, s.end + offset, s.symbol) for s in segs]
    return segs


def _split_python_def(lines: list[str], node: ast.AST, start: int, end: int) -> list[_Seg]:
    """A long class becomes its methods; a long function becomes blocks."""
    name = getattr(node, "name", "")
    if not isinstance(node, ast.ClassDef):
        return _blocks(lines, start, end, "python", name)
    segs: list[_Seg] = []
    cursor = start
    for item in node.body:
        if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        item_start = _attach_comments_above(lines, _decorated_start(item), cursor, "python")
        item_end = item.end_lineno or item.lineno
        span = _trim(lines, cursor, item_start - 1) if item_start > cursor else None
        if span and span[1] - span[0] >= 2:
            segs.append(_Seg(span[0], span[1], name))
        symbol = f"{name}.{item.name}"
        if item_end - item_start + 1 > MAX_UNIT_LINES:
            segs.extend(_blocks(lines, item_start, item_end, "python", symbol))
        else:
            segs.append(_Seg(item_start, item_end, symbol))
        cursor = item_end + 1
    span = _trim(lines, cursor, end) if cursor <= end else None
    if span and span[1] - span[0] >= 2:
        segs.append(_Seg(span[0], span[1], name))
    return segs or [_Seg(start, end, name)]


def _regex_python_segments(lines: list[str]) -> list[_Seg]:
    """Fallback for code ``ast`` cannot parse (Python 2, Snakefiles)."""
    rx = re.compile(r"^(?:def|class|rule|checkpoint)\s+(\w+)")
    starts = [(i + 1, m.group(1)) for i, line in enumerate(lines) for m in [rx.match(line)] if m]
    segs: list[_Seg] = []
    cursor = 1
    for k, (s, name) in enumerate(starts):
        if s > cursor:
            segs.extend(_blocks(lines, cursor, s - 1, "python"))
        end = starts[k + 1][0] - 1 if k + 1 < len(starts) else len(lines)
        for j in range(s + 1, end + 1):  # a definition ends at the next unindented code line
            line = lines[j - 1]
            if line.strip() and not line[0].isspace() and not line.lstrip().startswith("#"):
                end = j - 1
                break
        span = _trim(lines, s, end)
        if span:
            if span[1] - span[0] + 1 > MAX_UNIT_LINES:
                segs.extend(_blocks(lines, span[0], span[1], "python", name))
            else:
                segs.append(_Seg(span[0], span[1], name))
            cursor = span[1] + 1
        else:
            cursor = s + 1
    if cursor <= len(lines):
        segs.extend(_blocks(lines, cursor, len(lines), "python"))
    return segs


_MATLAB_FUNC = re.compile(r"^\s*function\b(?:\s*(?:\[[^\]]*\]|\w+)\s*=)?\s*([A-Za-z]\w*(?:\.\w+)?)")


def _cells(lines: list[str], start: int, end: int, family: str, marker: str, symbol: str = "") -> list[_Seg]:
    """Split at cell markers (``%%``, ``# %%``); long cells become blocks."""
    rx = re.compile(marker)
    bounds = [i for i in range(start, end + 1) if rx.match(lines[i - 1])]
    if not bounds or bounds[0] != start:
        bounds.insert(0, start)
    segs: list[_Seg] = []
    for k, lo in enumerate(bounds):
        hi = bounds[k + 1] - 1 if k + 1 < len(bounds) else end
        span = _trim(lines, lo, hi)
        if not span:
            continue
        head = lines[span[0] - 1]
        title = rx.sub("", head, count=1).strip(" %#-=*") if rx.match(head) else ""
        name = symbol or title[:60].strip()
        if span[1] - span[0] + 1 > MAX_UNIT_LINES:
            segs.extend(_blocks(lines, span[0], span[1], family, name))
        else:
            segs.append(_Seg(span[0], span[1], name))
    return segs


def _matlab_segments(lines: list[str]) -> list[_Seg]:
    """Functions (to the next ``function`` line) and ``%%`` cells of scripts."""
    starts = [(i + 1, m.group(1)) for i, line in enumerate(lines) for m in [_MATLAB_FUNC.match(line)] if m]
    segs: list[_Seg] = []
    script_end = starts[0][0] - 1 if starts else len(lines)
    if script_end >= 1:
        segs.extend(_cells(lines, 1, script_end, "matlab", r"^\s*%%"))
    for k, (line_no, name) in enumerate(starts):
        end = starts[k + 1][0] - 1 if k + 1 < len(starts) else len(lines)
        span = _trim(lines, line_no, end)
        if not span:
            continue
        if span[1] - span[0] + 1 > MAX_UNIT_LINES:
            segs.extend(_cells(lines, span[0], span[1], "matlab", r"^\s*%%", name))
        else:
            segs.append(_Seg(span[0], span[1], name))
    return segs


BRACE_OPEN_LINES = 8  # a definition's "{" must come within this many lines
BRACE_SCAN_LINES = 3000  # longest definition followed; beyond, braces are unbalanced


def _brace_end(lines: list[str], line_no: int, family: str) -> int | None:
    """Line of the brace closing the first ``{`` found within BRACE_OPEN_LINES
    of ``line_no``; None when no brace opens there, 0 when it never closes."""
    depth = 0
    opened = False
    in_block_comment = False
    for i in range(line_no - 1, min(len(lines), line_no - 1 + BRACE_SCAN_LINES)):
        if not opened and i - (line_no - 1) >= BRACE_OPEN_LINES:
            return None
        line = lines[i]
        j = 0
        quote = ""
        while j < len(line):
            ch = line[j]
            if in_block_comment:
                if line.startswith("*/", j):
                    in_block_comment = False
                    j += 2
                else:
                    j += 1
                continue
            if quote:
                if ch == "\\":
                    j += 2
                    continue
                if ch == quote:
                    quote = ""
                j += 1
                continue
            if family == "c" and line.startswith("/*", j):
                in_block_comment = True
                j += 2
                continue
            if family == "c" and line.startswith("//", j):
                break
            if family in ("r", "shell") and ch == "#":
                break
            if ch in "\"'" and not (ch == "'" and family in ("c", "shell") and j and line[j - 1].isalnum()):
                quote = ch
            elif ch == "{":
                depth += 1
                opened = True
            elif ch == "}":
                depth -= 1
                if opened and depth == 0:
                    return i + 1
            j += 1
    return 0 if opened else None


_R_FUNC = re.compile(r"^([A-Za-z.][\w.]*)\s*(?:<-|=|<<-)\s*function\s*\(")
_C_FUNC = re.compile(
    r"^(?!\s)(?!(?:if|for|while|switch|return|else|do|case|typedef|using|namespace|#)\b)"
    r"[\w:<>,\*&~\s\[\]]*?\b([A-Za-z_~][\w~]*(?:::[A-Za-z_~][\w~]*)*)\s*\("
)
_C_TYPE = re.compile(r"^(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)[^;]*$")
_SHELL_FUNC = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?\s*$|^\s*function\s+([A-Za-z_][\w-]*)\s*\{?\s*$")
_C_KEYWORDS = frozenset({"if", "for", "while", "switch", "return", "sizeof", "else", "do", "case", "catch"})


def _braced_segments(lines: list[str], family: str) -> list[_Seg]:
    """Brace-delimited definitions (R functions, C/C++/CUDA functions and
    types, shell functions); code between them becomes blocks."""
    defs: list[_Seg] = []
    i, n = 1, len(lines)
    while i <= n:
        line = lines[i - 1]
        name = None
        if len(line) > 400:  # minified or generated line: no definition starts here
            pass
        elif family == "r":
            m = _R_FUNC.match(line)
            name = m.group(1) if m else None
        elif family == "c":
            m = _C_TYPE.match(line) or _C_FUNC.match(line)
            if m and not line.rstrip().endswith(";"):
                name = m.group(1).split("::")[-1]
                window = " ".join(lines[i - 1 : i - 1 + BRACE_OPEN_LINES])
                brace, semi = window.find("{"), window.find(";")
                if name in _C_KEYWORDS or brace < 0 or 0 <= semi < brace:
                    name = None
        elif family == "shell":
            m = _SHELL_FUNC.match(line)
            name = (m.group(1) or m.group(2)) if m else None
        if name:
            if family == "r" and "{" not in line[m.end() :] and re.search(r"\)\s*[^\s#{]", line[m.end() :]):
                end: int | None = i  # one-line body after the signature: f <- function(x) x + 1
            else:
                end = _brace_end(lines, i, family)
            if end == 0:
                break  # a brace that never closes: the rest is cut into plain blocks
            if end is None and family == "r":
                end = i  # no braces at all
            if end is not None and end >= i:
                start = _attach_comments_above(lines, i, defs[-1].end + 1 if defs else 1, family)
                defs.append(_Seg(start, end, name))
                i = end + 1
                continue
        i += 1
    segs: list[_Seg] = []
    cursor = 1
    for d in defs:
        if d.start > cursor:
            segs.extend(_blocks(lines, cursor, d.start - 1, family))
        if d.end - d.start + 1 > MAX_UNIT_LINES:
            segs.extend(_blocks(lines, d.start, d.end, family, d.symbol))
        else:
            segs.append(d)
        cursor = d.end + 1
    if cursor <= n:
        segs.extend(_blocks(lines, cursor, n, family))
    return segs


def _heading(lines: list[str], commented: bool = False) -> str:
    """Last Markdown heading (or bold line) of a prose stretch, as a cell name.

    ``commented``: notebook markdown arrives as comments ("# ## Title").
    """
    title = ""
    for raw in lines:
        s = raw.strip()
        if commented:
            if not s.startswith("#"):
                continue
            s = s[1:].strip()
        m = re.match(r"^#{1,6}\s+(.+)$", s) or re.match(r"^\*\*([^*].*?)\*\*:?$", s)
        if m:
            candidate = re.sub(r"[*_`\[\]{}]|\(.*?\)", "", m.group(1)).strip(" -:.")
            if candidate and not set(candidate) <= set("-=#* "):
                title = candidate
    return title[:60].strip()


def _single_definition(code_lines: list[str]) -> str:
    """Name of the only top-level def/class of a cell, if it has exactly one."""
    tree = _parse_python("\n".join(code_lines))
    if tree is None:
        return ""
    defs = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    return defs[0] if len(defs) == 1 else ""


def _notebook_segments(lines: list[str]) -> list[_Seg]:
    """Percent-format notebook: each code cell with the markdown just before it."""
    marks = [i + 1 for i, line in enumerate(lines) if line.startswith("# %%")]
    if not marks:
        return _python_segments(lines) or _blocks(lines, 1, len(lines), "python")
    if marks[0] != 1:
        marks.insert(0, 1)
    segs: list[_Seg] = []
    md_start: int | None = None
    md_lines: list[str] = []
    for number, lo in enumerate(marks, start=1):
        hi = marks[number] - 1 if number < len(marks) else len(lines)
        if "[markdown]" in lines[lo - 1]:
            md_start = lo if md_start is None else md_start
            md_lines.extend(lines[lo - 1 : hi])
            continue
        body_start = lo + 1 if lines[lo - 1].startswith("# %%") else lo
        code_lines = [("#" + ln if ln.lstrip().startswith(("!", "%")) else ln) for ln in lines[body_start - 1 : hi]]
        if not any(ln.strip() and not ln.lstrip().startswith("#") for ln in code_lines):
            continue  # empty cell or shell/magic commands only; its markdown goes to the next cell
        span = _trim(lines, md_start if md_start is not None else lo, hi)
        name = _single_definition(code_lines) or _heading(md_lines, commented=True) or f"cell {number}"
        md_start, md_lines = None, []
        if not span:
            continue
        if span[1] - span[0] + 1 <= MAX_UNIT_LINES:
            segs.append(_Seg(span[0], span[1], name))
            continue
        inner = _python_segments(code_lines, offset=body_start - 1)
        if inner:
            inner[0] = _Seg(span[0], inner[0].end, inner[0].symbol)  # keep the markdown with the first piece
            segs.extend(_Seg(s.start, s.end, s.symbol or name) for s in inner)
        else:
            segs.extend(_blocks(lines, span[0], span[1], "python", name))
    return segs


_CHUNK_OPEN = re.compile(r"^\s*```+\s*\{\s*([A-Za-z]+)\s*,?\s*([^}]*)\}")
_CHUNK_CLOSE = re.compile(r"^\s*```+\s*$")


def _chunk_segments(lines: list[str]) -> tuple[list[_Seg], list[bool]]:
    """R Markdown / Quarto: each chunk with the prose just before it.

    Also returns which lines are prose, so that their words are read as text.
    """
    prose = [True] * len(lines)
    segs: list[_Seg] = []
    prose_start = 1
    if lines and lines[0].strip() == "---":  # YAML header: metadata, not the prose of a chunk
        for j in range(1, len(lines)):
            if lines[j].strip() in ("---", "..."):
                prose_start = j + 2
                break
    i, number = 0, 0
    while i < len(lines):
        m = _CHUNK_OPEN.match(lines[i])
        if not m:
            i += 1
            continue
        prose[i] = False
        j = i + 1
        while j < len(lines) and not _CHUNK_CLOSE.match(lines[j]):
            prose[j] = False
            j += 1
        if j < len(lines):
            prose[j] = False
        number += 1
        opts = [o.strip() for o in m.group(2).split(",") if o.strip()]
        label = opts[0].strip("'\" ") if opts and "=" not in opts[0] else ""
        for o in opts:
            if not label and o.replace(" ", "").startswith("label="):
                label = o.split("=", 1)[1].strip("'\" ")
        name = label or _heading(lines[prose_start - 1 : i]) or f"chunk {number}"
        if any(ln.strip() for ln in lines[i + 1 : j]):
            span = _trim(lines, prose_start, min(j + 1, len(lines)))
            if span:
                if span[1] - span[0] + 1 > MAX_UNIT_LINES:
                    segs.extend(_blocks(lines, span[0], span[1], "r", name))
                else:
                    segs.append(_Seg(span[0], span[1], name))
            prose_start = j + 2
        i = j + 1
    return segs, prose


def _segments(lines: list[str], family: str) -> tuple[list[_Seg], list[bool] | None]:
    if family == "python":
        segs = _python_segments(lines)
        return (segs if segs is not None else _regex_python_segments(lines)), None
    if family == "notebook":
        return _notebook_segments(lines), None
    if family == "chunks":
        return _chunk_segments(lines)
    if family == "matlab":
        return _matlab_segments(lines), None
    if family in ("r", "c", "shell"):
        return _braced_segments(lines, family), None
    return _blocks(lines, 1, len(lines), family), None


def code_units(repo: str, path: str, language: str, text: str) -> list[CodeUnit]:
    """Split one file into units: definitions where the language has them,
    cells for notebooks and literate scripts, blocks of ~60 lines otherwise.

    Line numbers are 1-based and inclusive, counted like ``text.split("\\n")``
    (the website reader's rule; never ``splitlines()``). Files over 200 KiB
    give no units.
    """
    if not text or len(text.encode("utf-8", "replace")) > MAX_FILE_BYTES:
        return []
    segs, _ = _segments(_lines_of(text), _family(language, path))
    return [CodeUnit(repo, path, language, s.start, s.end, s.symbol) for s in segs]


# ------------------------------------------------------------ code features

_LEX = {
    "hash": re.compile(
        r"(?P<str3>[rRbBuUfF]{0,2}(?:'''[\s\S]*?'''|\"\"\"[\s\S]*?\"\"\"))"
        r"|(?P<str>[rRbBuUfF]{0,2}(?:\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'))"
        r"|(?P<com>\#[^\n]*)"
    ),
    "matlab": re.compile(
        r"(?P<com3>^[ \t]*%\{[ \t]*\n[\s\S]*?^[ \t]*%\}[ \t]*$)"
        r"|(?P<com>%[^\n]*)"
        r"|(?P<str>\"(?:\"\"|[^\"\n])*\")"
        r"|(?P<sq>'(?:''|[^'\n])*')",
        re.M,
    ),
    "c": re.compile(
        r"(?P<com3>/\*[\s\S]*?\*/)"
        r"|(?P<com>//[^\n]*)"
        r"|(?P<str>\"(?:\\.|[^\"\\\n])*\")"
        r"|(?P<chr>'(?:\\.|[^'\\\n]){1,2}')"
    ),
}


def _lex(text: str, family: str) -> tuple[str, list[str], list[str]]:
    """Separate code from comments and string literals."""
    kind = "matlab" if family == "matlab" else "c" if family == "c" else "hash"
    rx = _LEX[kind]
    code: list[str] = []
    comments: list[str] = []
    strings: list[str] = []
    pos = 0
    while True:
        m = rx.search(text, pos)
        if m is None:
            code.append(text[pos:])
            break
        group = m.lastgroup
        before = text[m.start() - 1] if m.start() else ""
        if group == "sq" and (before.isalnum() or before in "_)]}.'"):
            code.append(text[pos : m.start() + 1])  # MATLAB transpose, not a string
            pos = m.start() + 1
            continue
        code.append(text[pos : m.start()])
        code.append(" ")
        body = m.group(0)
        if group in ("com", "com3"):
            comments.append(body.lstrip(" \t#%/*").rstrip("*/%} \t"))
        elif group == "str3":
            comments.append(body.lstrip("rRbBuUfF").strip("'\""))  # docstrings describe the code like comments
        elif group != "chr":
            strings.append(body.lstrip("rRbBuUfF").strip("'\""))
        pos = m.end()
    return "".join(code), comments, strings


_IMPORT_LINE = re.compile(
    r"^\s*(?:import\s+[\w.]|from\s+[\w.]+\s+import\b|library\s*\(|require\s*\(|requireNamespace\s*\(|"
    r"suppressPackageStartupMessages\s*\(|p_load\s*\(|pacman::|install\.packages|#\s*include\b|addpath\s*\(|"
    r"[!%]\s*(?:pip|conda|apt|matplotlib|load_ext|autoreload|cd\b)|source\s*\(|module\s+load\b)"
)
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
_CODE_NUM_RE = re.compile(r"(?<![\w.])(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?(?!\w)")
_NUMBER = r"-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_CODE_RANGE_RE = re.compile(rf"(?:[\[\(]|\bc\()\s*({_NUMBER})\s*[,;\s]\s*({_NUMBER})\s*[\]\)]")


def _strip_imports(lines: list[str]) -> tuple[list[str], int]:
    """Blank out import/install lines (importing a library says little about
    the unit that imports it); also count the substantive code lines left."""
    kept: list[str] = []
    substantive = 0
    in_paren = 0
    for line in lines:
        if in_paren:
            in_paren = max(in_paren + line.count("(") - line.count(")"), 0)
            kept.append("")
            continue
        if _IMPORT_LINE.match(line):
            if line.lstrip().startswith(("from", "import")):
                in_paren = max(line.count("(") - line.count(")"), 0)
            kept.append("")
            continue
        kept.append(line)
        s = line.strip()
        if s and not s.startswith(("#", "%", "//", "```")):
            substantive += 1
    return kept, substantive


_CITATION_LINE = re.compile(r"\bet al\b|\bdoi\b|\(\s*(?:19|20)\d\d[a-z]?\s*\)|please cite|\bcitation\b|^\s*references?\s*:?\s*$", re.I)
SECONDARY = 0.5  # weight of literate prose and help strings, next to code and its comments


def _prose_lines(text: str) -> str:
    """Comment or string text without bibliographic lines (a cited paper's title
    shares the article's vocabulary without describing the unit)."""
    return "\n".join(line for line in text.split("\n") if not _CITATION_LINE.search(line))


def _code_features(bag: _Bag, lines: list[str], family: str, prose_mask: list[bool] | None) -> int:
    """Identifiers, literals, comments and strings of one unit.

    Code and its comments are first-hand descriptions of what the unit does
    and weigh 1. Literate prose (notebook markdown, R Markdown text) and long
    string literals (argparse help, messages) weigh SECONDARY: they often
    restate the paper around code that does something narrower.
    Returns the number of substantive code lines (0: imports or prose only).
    """
    lex_family = family
    if prose_mask is not None:  # literate script: prose lines are text, the rest is code
        prose = [re.sub(r"^\s*# ?", "", ln) if family == "notebook" else ln
                 for ln, is_prose in zip(lines, prose_mask) if is_prose and not ln.startswith("# %%")]
        bag.scale = SECONDARY
        _prose_features(bag, _prose_lines("\n".join(prose)), code_side=True)
        bag.scale = 1.0
        lines = [ln if not is_prose and not ln.lstrip().startswith("```") else "" for ln, is_prose in zip(lines, prose_mask)]
        lex_family = "hash" if family == "chunks" else family
    kept, substantive = _strip_imports(lines)
    code, comments, strings = _lex("\n".join(kept), lex_family)
    for text in comments:
        if not text.startswith("%%"):
            _prose_features(bag, _prose_lines(text), code_side=True)
    for text in strings:
        if len(text) > 1:
            bag.scale = SECONDARY if len(text.split()) >= 5 else 1.0
            _prose_features(bag, _prose_lines(text), code_side=True)
            bag.scale = 1.0
    for m in _CODE_RANGE_RE.finditer(code):
        lo, hi = _to_float(m.group(1)), _to_float(m.group(2))
        if lo is not None and hi is not None and lo < hi:
            bag.add(f"r:{_canon(lo)}-{_canon(hi)}", f"[{m.group(1)} {m.group(2)}]")
    for m in _CODE_NUM_RE.finditer(code):
        value = _to_float(m.group(0))
        if value is not None and _number_weight(value) > 0:
            bag.add("n:" + _canon(value), m.group(0))
    for m in _IDENT_RE.finditer(code):
        dotted = m.group(0)
        pieces = dotted.split(".")
        if len(pieces) > 1 and len(dotted) >= 6:
            bag.add("i:" + dotted.lower(), dotted)
        for ident in pieces:
            if ident.lower() in _CODE_STOP or len(ident) < 2:
                continue
            if len(ident) >= 4 and _is_compound(ident):
                bag.add("i:" + ident.lower(), ident)
            run: list[tuple[str, str]] = []
            for part in _split_ident(ident):
                expansion = _ABBREV.get(part)
                words = expansion.split() if expansion else [part]
                for word in words:
                    stem = _keep(word)
                    if stem is None:
                        bag.add_run(run)
                        run = []
                    else:
                        run.append((stem, word))
            bag.add_run(run)
    _tool_features(bag, code + "\n" + "\n".join(comments), _TOOLS_CODE)
    return substantive


@dataclass
class _Unit:
    unit: CodeUnit
    file_id: int
    bag: _Bag


def _path_bag(path: str) -> _Bag:
    """Words of the directory and file names: authors name files after analyses."""
    bag = _Bag()
    for component in re.split(r"[/\\]", re.sub(r"\.[A-Za-z0-9]+$", "", path)):
        component = re.sub(r"\.(zip|tar|gz|tgz)$", "", component, flags=re.I)
        run: list[tuple[str, str]] = []
        for part in _split_ident(re.sub(r"[^A-Za-z0-9_]", "_", component)):
            stem = None if part.isdigit() else _keep(part)
            if stem is None:
                bag.add_run(run)
                run = []
            else:
                run.append((stem, part))
        bag.add_run(run)
    for number in _path_figures(path):
        bag.add(f"f:{number}", f"Figure {number}")
    return bag


def _markdown_mask(lines: list[str]) -> list[bool]:
    """Lines of a percent-format notebook that belong to markdown cells."""
    mask: list[bool] = []
    in_markdown = False
    for line in lines:
        if line.startswith("# %%"):
            in_markdown = "[markdown]" in line
        mask.append(in_markdown)
    return mask


def _code(files: list[dict]) -> tuple[list[_Unit], list[_Bag]]:
    """Units of all matchable files, with their features, and one path bag per file."""
    units: list[_Unit] = []
    path_bags: list[_Bag] = []
    seen: set[str] = set()
    for f in files:
        text, path = f.get("text"), str(f.get("path", ""))
        if not isinstance(text, str) or not text.strip() or _SKIP_PATH.search(path) or _AUXILIARY_PATH.search(path):
            continue
        if len(text.encode("utf-8", "replace")) > MAX_FILE_BYTES:
            continue
        digest = " ".join(text.split())
        if digest in seen:  # identical copies would split the votes
            continue
        seen.add(digest)
        repo, language = str(f.get("repo", "")), str(f.get("language", ""))
        family = _family(language, path)
        lines = _lines_of(text)
        segs, prose_mask = _segments(lines, family)
        if family == "notebook":
            prose_mask = _markdown_mask(lines)
        file_id = len(path_bags)
        path_bags.append(_path_bag(path))
        for seg in segs:
            bag = _Bag()
            mask = prose_mask[seg.start - 1 : seg.end] if prose_mask is not None else None
            if _code_features(bag, lines[seg.start - 1 : seg.end], family, mask) == 0:
                continue  # imports, magics, comments or prose only: nothing a paragraph could describe
            units.append(_Unit(CodeUnit(repo, path, language, seg.start, seg.end, seg.symbol), file_id, bag))
    if len(units) > MAX_UNITS:
        # Keep the units with the most distinct features: past 400 units an
        # article's code is mostly boilerplate, and thin units carry the least evidence.
        ranked = sorted(range(len(units)), key=lambda k: (-len(units[k].bag.feats), k))[:MAX_UNITS]
        units = [units[k] for k in sorted(ranked)]
    return units, path_bags


# ------------------------------------------------------------------ scoring

# Calibrated on 117 hand-labelled candidate pairs from 25 articles (2026-09-26).
# The decision value is the raw score (sum of shared-term contributions, see
# _candidates) plus one point per specific piece of evidence (_specific_items):
# a shared phrase, identifier, tool, range or number with a unit is worth
# about as much as the whole bag of shared words.
MIN_SCORE = 2.0  # least raw score
MIN_EVIDENCE = 3.0  # least independent shared terms, see _evidence_strength
ACCEPT = 4.8  # least decision value; labelled pairs above it: 58 of 59 correct or plausible
FULL_TERM = 0.5  # a term contributing this much counts as one full piece of evidence
SPECIFIC_MIN = 0.3  # least contribution of a piece of specific evidence
PER_PARAGRAPH = 2
PER_UNIT = 2
UNIT_RANK = 3  # a paragraph must be among the unit's three best paragraphs


def _idf(df: int, n: int) -> float:
    """Rarity in [0, ~1]: 1 for a term seen once, ~0 for one seen everywhere."""
    if df <= 0 or n <= 1:
        return 0.0
    return max(0.0, math.log((n + 1) / (df + 0.5)) / math.log(n + 1))


@dataclass
class _Candidate:
    para: int  # position in the paragraph list
    unit: int  # position in the unit list
    raw: float
    terms: list[tuple[float, str]]  # (contribution, feature key)


def _candidates(paras: list[_Para], units: list[_Unit], path_bags: list[_Bag]) -> list[_Candidate]:
    """Every (paragraph, unit) sharing a term, with each term's contribution.

    contribution = kind weight x priors x rarity among paragraphs x rarity
    among units, x1.5 when the file name carries the term too, x1.25 when the
    paragraph's section title does. A term found only in the file name
    counts at 0.8 x its rarity among file names.
    """
    eligible = [k for k, p in enumerate(paras) if p.weight > 0 and p.bag.feats]
    described = [p for p in paras if p.bag.feats]
    df_p: Counter[str] = Counter()
    for p in described:  # rarity over the whole body: intro and discussion reuse the topic words
        df_p.update(p.bag.feats.keys())
    df_u: Counter[str] = Counter()
    postings: dict[str, list[int]] = defaultdict(list)
    for k, u in enumerate(units):
        df_u.update(u.bag.feats.keys())
        for key in u.bag.feats:
            postings[key].append(k)
    df_f: Counter[str] = Counter()
    path_postings: dict[str, list[int]] = defaultdict(list)
    for fid, bag in enumerate(path_bags):
        df_f.update(bag.feats.keys())
        for key in bag.feats:
            path_postings[key].append(fid)
    units_of_file: dict[int, list[int]] = defaultdict(list)
    for k, u in enumerate(units):
        units_of_file[u.file_id].append(k)
    n_p, n_u, n_f = len(described), len(units), len(path_bags)
    out: list[_Candidate] = []
    for pk in eligible:
        para = paras[pk]
        acc: dict[int, float] = defaultdict(float)
        terms: dict[int, list[tuple[float, str]]] = defaultdict(list)
        for key, prior in para.bag.feats.items():
            w_p = _idf(df_p[key], n_p)
            if w_p <= 0.05:
                continue
            base = _KIND_WEIGHT[key[0]] * prior * _term_prior(key) * w_p
            if key in para.title_keys:
                base *= 1.25
            w_u = _idf(df_u[key], n_u)
            if w_u > 0.05:
                for uk in postings.get(key, ()):
                    contribution = base * w_u * units[uk].bag.feats[key]
                    if key in path_bags[units[uk].file_id].feats:
                        contribution *= 1.5
                    acc[uk] += contribution
                    terms[uk].append((contribution, key))
            w_f = _idf(df_f[key], n_f)
            if w_f > 0.05 and key[0] in "wbf":
                for fid in path_postings.get(key, ()):
                    for uk in units_of_file[fid]:
                        if key not in units[uk].bag.feats:
                            contribution = base * w_f * 0.8
                            acc[uk] += contribution
                            terms[uk].append((contribution, key))
        for uk in acc:
            shared = _count_tokens_once(terms[uk])
            out.append(_Candidate(pk, uk, sum(c for c, _ in shared) * para.weight, shared))
    return out


def _count_tokens_once(terms: list[tuple[float, str]]) -> list[tuple[float, str]]:
    """Discount the words and phrases an identifier or tool is made of.

    "MIG_N2Treat" in both texts matches as an identifier, a phrase and two
    words; that is one piece of evidence, so its parts keep a quarter of
    their weight when the whole matched.
    """
    wholes = [key[2:] for _, key in terms if key[0] in "it"]
    if not wholes:
        return terms
    # A tool and an identifier spelling the same name (FieldTrip) are one term too.
    best: dict[str, float] = {}
    for contribution, key in terms:
        if key[0] in "it":
            name = re.sub(r"[^a-z0-9]", "", key[2:])
            best[name] = max(best.get(name, 0.0), contribution)
    kept_whole: set[str] = set()
    parts: set[str] = set()
    for whole in wholes:
        for piece in re.split(r"[._\-]", whole):
            parts.update(_stem(p) for p in _split_ident(piece) if p)
        parts.add(_stem(re.sub(r"[^a-z0-9]", "", whole)))
    out: list[tuple[float, str]] = []
    for contribution, key in terms:
        kind, value = key[0], key[2:]
        if kind in "it":
            name = re.sub(r"[^a-z0-9]", "", value)
            if name in kept_whole or contribution < best[name]:
                contribution *= 0.25
            else:
                kept_whole.add(name)
        elif (kind == "w" and value in parts) or (kind == "b" and all(v in parts for v in value.split(" "))):
            contribution *= 0.25
        out.append((contribution, key))
    return out


def _evidence_strength(para: _Para, terms: list[tuple[float, str]]) -> float:
    """How much independent evidence agrees.

    Each distinct term counts min(1, contribution / FULL_TERM), so three
    solid terms reach 3 while a handful of faint ones do not; a phrase counts
    only as a bonus over its words, numbers without a unit at most 1 in all.
    """
    per_key: dict[str, float] = {}
    for contribution, key in terms:
        if _term_prior(key) == 1.0:
            per_key[key] = per_key.get(key, 0.0) + contribution
    strength = 0.0
    bare_numbers = 0.0
    for key, contribution in per_key.items():
        kind = key[0]
        credit = min(1.0, contribution / FULL_TERM)
        if kind == "b":
            strength += 0.25 * credit
        elif kind == "f":
            strength += 0.5 * credit
        elif kind == "n" and key not in para.bag.unitful:
            bare_numbers += 0.5 * credit
        else:  # word, identifier, tool, range, number with a unit
            strength += credit
    return strength + min(bare_numbers, 1.0)


def _specific_items(para: _Para, terms: list[tuple[float, str]]) -> int:
    """Distinct pieces of evidence more specific than a single word.

    A phrase (a chain of matched two-word features, as the paragraph writes
    it) counts once however long; a compound identifier counts unless a
    counted phrase already spells it; tools, numeric ranges and numbers
    written with a unit count once each. Each must contribute at least
    SPECIFIC_MIN: a faint coincidence is not evidence.
    """
    per_key: dict[str, float] = {}
    for contribution, key in terms:
        if _term_prior(key) == 1.0:
            per_key[key] = per_key.get(key, 0.0) + contribution
    matched = {key[2:] for key in per_key if key[0] == "b"}
    phrases: list[frozenset[str]] = []
    seq = para.bag.seq
    i = 0
    while i < len(seq) - 1:
        a, b = seq[i], seq[i + 1]
        if a is None or b is None or f"{a} {b}" not in matched:
            i += 1
            continue
        j = i + 1
        while j + 1 < len(seq) and seq[j + 1] is not None and f"{seq[j]} {seq[j + 1]}" in matched:
            j += 1
        stems = [x for x in seq[i : j + 1] if x]
        weight = sum(per_key.get(f"b:{x} {y}", 0.0) for x, y in zip(stems, stems[1:]))
        group = frozenset(stems)
        if weight >= SPECIFIC_MIN and not any(group <= other or other <= group for other in phrases):
            phrases.append(group)
        i = j + 1
    covered = set().union(*phrases) if phrases else set()
    strong = [(key[0], key[2:]) for key, contribution in per_key.items() if contribution >= SPECIFIC_MIN]
    endpoints = {end for kind, value in strong if kind == "r" for end in value.split("-", 1)}
    names: set[str] = set()
    count = len(phrases)
    for kind, value in sorted(strong):  # identifiers ("i") before tools ("t")
        if kind == "i":
            stems = {_stem(p) for piece in re.split(r"[._]", value) for p in _split_ident(piece) if p}
            if stems and stems <= covered:
                continue  # the phrase already counted spells it
            names.add(_flat(value))
            count += 1
        elif kind == "t":
            count += _flat(value) not in names
        elif kind == "r":
            count += 1
        elif kind == "n" and f"n:{value}" in para.bag.unitful and value not in endpoints:
            count += 1
    return count


def _flat(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _evidence(para: _Para, unit: _Unit, terms: list[tuple[float, str]]) -> tuple[str, ...]:
    """Up to six short shared terms, most specific first, never a sentence.

    Phrases are read in the paragraph (at most three words), identifiers
    as the code spells them; a term already said by a longer one, or the
    same term in another form ("lym.EC" / "lym EC", "loss" / "losses"), is
    not repeated.
    """
    by_key: dict[str, float] = {}
    for contribution, key in terms:
        by_key[key] = by_key.get(key, 0.0) + contribution
    bigrams = {k[2:] for k in by_key if k[0] == "b"}
    items: list[tuple[float, str, frozenset[str]]] = []
    seq, words = para.bag.seq, para.bag.words
    i = 0
    while i < len(seq) - 1:
        a, b = seq[i], seq[i + 1]
        if a is None or b is None or f"{a} {b}" not in bigrams:
            i += 1
            continue
        j = i + 1
        while j - i < 2 and j + 1 < len(seq) and seq[j + 1] is not None and f"{seq[j]} {seq[j + 1]}" in bigrams:
            j += 1
        stems = [s for s in seq[i : j + 1] if s]
        score = sum(by_key.get(f"w:{s}", 0.0) for s in set(stems))
        score += sum(by_key.get(f"b:{x} {y}", 0.0) for x, y in zip(stems, stems[1:]))
        if not all(_everyday(s) for s in stems):
            items.append((score * 1.5, " ".join(words[i : j + 1]), frozenset(stems)))
        i = j + 1
    bonus = {"i": 2.0, "t": 2.0, "r": 2.0, "n": 1.5, "w": 1.0, "f": 0.4}
    for key, contribution in by_key.items():
        kind, value = key[0], key[2:]
        if kind == "b" or _term_prior(key) < 1.0 or (kind == "n" and key not in para.bag.unitful):
            continue
        if kind == "i":
            shown = unit.bag.surface.get(key) or para.bag.surface.get(key, value)
            stems = frozenset(_stem(p) for piece in re.split(r"[._\-]", value) for p in _split_ident(piece) if p)
        else:
            shown = para.bag.surface.get(key, value)
            stems = frozenset({value})
        items.append((contribution * bonus[kind], shown, stems))
    items.sort(key=lambda t: (-t[0], t[1]))
    chosen: list[tuple[str, frozenset[str]]] = []
    for _score, shown, stems in items:
        shown = " ".join(shown.split()[:4])[:40].strip()
        flat = _flat(shown)
        if not flat or any(flat in _flat(c) or stems <= c_stems for c, c_stems in chosen):
            continue
        # a longer form of a term already chosen replaces it
        chosen = [(c, c_stems) for c, c_stems in chosen if not (_flat(c) in flat or c_stems < stems)]
        chosen.append((shown, stems))
        if len(chosen) == MAX_EVIDENCE:
            break
    return tuple(c for c, _ in chosen)


def _select(
    paras: list[_Para], units: list[_Unit], cands: list[_Candidate], max_pairs: int
) -> list[tuple[_Candidate, float]]:
    """Threshold, mutual rank and diversity: few pairs, each well supported.

    Returns (candidate, decision value) best first. A paragraph gets at most
    one unit per file: a second block of the same function or notebook adds
    a highlight, not information.
    """
    by_para: dict[int, list[_Candidate]] = defaultdict(list)
    by_unit: dict[int, list[_Candidate]] = defaultdict(list)
    for c in cands:
        by_para[c.para].append(c)
        by_unit[c.unit].append(c)
    rank_in_para: dict[tuple[int, int], int] = {}
    for lst in by_para.values():
        lst.sort(key=lambda c: (-c.raw, c.unit))
        rank_in_para.update(((c.para, c.unit), r) for r, c in enumerate(lst))
    rank_in_unit: dict[tuple[int, int], int] = {}
    for lst in by_unit.values():
        lst.sort(key=lambda c: (-c.raw, c.para))
        rank_in_unit.update(((c.para, c.unit), r) for r, c in enumerate(lst))
    kept: list[tuple[_Candidate, float]] = []
    for c in cands:
        if c.raw < MIN_SCORE or rank_in_para[(c.para, c.unit)] >= PER_PARAGRAPH:
            continue
        if rank_in_unit[(c.para, c.unit)] >= UNIT_RANK:
            continue
        if _evidence_strength(paras[c.para], c.terms) < MIN_EVIDENCE:
            continue
        decision = c.raw + _specific_items(paras[c.para], c.terms)
        if decision >= ACCEPT:
            kept.append((c, decision))
    kept.sort(key=lambda cd: (-cd[1], paras[cd[0].para].paragraph.index, cd[0].unit))
    per_para: Counter[int] = Counter()
    per_unit: Counter[int] = Counter()
    para_files: set[tuple[int, int]] = set()
    chosen: list[tuple[_Candidate, float]] = []
    for c, decision in kept:
        file_key = (c.para, units[c.unit].file_id)
        if per_para[c.para] >= PER_PARAGRAPH or per_unit[c.unit] >= PER_UNIT or file_key in para_files:
            continue
        chosen.append((c, decision))
        per_para[c.para] += 1
        per_unit[c.unit] += 1
        para_files.add(file_key)
        if len(chosen) >= max_pairs:
            break
    return chosen


def align(jats_xml: str, files: list[dict], *, max_pairs: int = 40) -> list[Pair]:
    """Pairs (paragraph, code lines) that describe the same thing, best first.

    ``files`` holds dicts with "repo", "path", "language" and "text". A pair
    needs a raw score of at least MIN_SCORE, evidence from at least
    MIN_EVIDENCE distinct shared terms including a specific one, and the
    paragraph and unit must rank each other near the top; at most
    PER_PARAGRAPH units per paragraph and PER_UNIT paragraphs per unit.
    The score is 1 - 2^(-decision / ACCEPT): 0.5 at the acceptance
    threshold, rising towards 1 with more and more specific shared evidence.
    """
    if max_pairs <= 0:
        return []
    paras = _paper(jats_xml)
    if not any(p.weight > 0 for p in paras):
        return []
    units, path_bags = _code(files)
    if not units:
        return []
    cands = _candidates(paras, units, path_bags)
    pairs: list[Pair] = []
    for n, (c, decision) in enumerate(_select(paras, units, cands, max_pairs), start=1):
        para, unit = paras[c.para], units[c.unit]
        pairs.append(
            Pair(
                pair=n,
                paragraph=para.paragraph.index,
                section=para.paragraph.section,
                repo=unit.unit.repo,
                path=unit.unit.path,
                start_line=unit.unit.start,
                end_line=unit.unit.end,
                symbol=unit.unit.symbol,
                score=round(1.0 - 2.0 ** (-decision / ACCEPT), 3),
                evidence=_evidence(para, unit, c.terms),
            )
        )
    return pairs
