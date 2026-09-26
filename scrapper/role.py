"""Le rôle d'un lien : le code des auteurs, leurs données, ou un outil qu'ils ont employé.

**Le piège qui impose ce module.** Sur les deux liens GitHub d'`eeg-neurostream`,
l'un est le code des auteurs, l'autre le jeu de données d'un autre laboratoire.
Et un article de Méthodes cite couramment le dépôt de MNE-Python ou d'EEGLAB :
compter ces liens comme « code natif » remplirait la bibliothèque des mêmes dix
boîtes à outils, et le tableau dirait que tout le monde publie son code.

**Comment il juge.** Trois rôles sont notés ensemble, chacun par des indices
LISIBLES — aucun modèle, aucun poids appris :

- l'a priori de l'hôte (GitHub → code, OpenNeuro → données, PyPI → outil) ;
- la phrase : un nom de code (« code », « scripts », « notebooks ») avec un
  verbe de mise à disposition (« available », « deposited ») ; un marqueur de
  propriété (« our », « this study », « to reproduce ») ; un marqueur d'outil
  (« using », « implemented in », « toolbox », un numéro de version) ; le nom
  d'une boîte à outils connue juste avant le lien ;
- le lieu : une section « Code availability », une ligne « This paper » du
  tableau des ressources, une référence dont les auteurs sont ceux de l'article.

Chaque indice qui a joué est gardé dans `raisons` : un verdict se relit, et un
verdict faux se corrige en nommant l'indice qui a trompé — pas en retouchant un
seuil à l'aveugle.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

from . import liens
from .jats import Occurrence
from .liens import Lien

ROLES: tuple[str, ...] = ("code", "donnees", "outil_tiers", "inconnu")

#: En deçà de ce score, aucun rôle n'est affirmé.
SEUIL: float = 1.5

#: L'a priori de chaque genre d'hôte.
A_PRIORI: dict[str, dict[str, float]] = {
    "forge": {"code": 1.0},
    "execution": {"code": 2.0},
    "modele": {"code": 2.0},
    "archive": {"code": 0.3, "donnees": 0.3},
    "paquet": {"outil_tiers": 1.5},
    "donnees": {"donnees": 2.5},
    "doc": {"outil_tiers": 0.8},
    "supplementaire": {"code": 1.0},
    "autre": {},
}

# « repository » n'en fait pas partie : « the public repository Zenodo » range
# des données aussi souvent que du code (mesuré sur PMC12748784).
NOMS_CODE = re.compile(
    r"\b(codes?|scripts?|source[- ]?codes?|notebooks?|implementations?|pipelines?"
    r"|software|programs?|routines?|functions|toolbox(?:es)?|packages?|utilit(?:y|ies)"
    r"|matlab|python|jupyter|analysis code|simulation code|model code)\b", re.I)
#: « codes » qui ne sont PAS du logiciel : « accession codes 9D8G and 9D6P »
#: (Protein Data Bank, août 2026), « PDB code », « ICD codes », et en
#: neurosciences « population code », « rate code », « neural code ».
CODES_QUI_NE_SONT_PAS_DU_CODE = re.compile(
    r"\b(accession|pdb|entry|identifier|id|icd|zip|postal|bar|colou?r|genetic|neural|population"
    r"|rate|temporal|place|predictive|sparse|efficient|ethical|access)[- ]codes?\b"
    r"|\bcodes? of (conduct|practice|ethics)\b|\bcoding (scheme|system|manual)s?\b", re.I)

#: Les données qui ACCOMPAGNENT un logiciel ne font pas du lien un dépôt de
#: données : « downloaded, along with a manual, helper utilities, and sample
#: data » décrit FingeRNAt, un logiciel (PMC de pcbi.1009783, étalon Zenodo).
DONNEES_ACCESSOIRES = re.compile(
    r"\b(sample|example|test|demo|toy|tutorial|synthetic)\s+(data(?:sets?)?|recordings?)\b", re.I)
NOMS_CODE_FORTS = re.compile(
    r"\b(codes?|scripts?|source[- ]?codes?|notebooks?|analysis pipeline"
    r"|custom (?:matlab |python |r )?(?:code|scripts?|software|functions))\b", re.I)
NOMS_DONNEES = re.compile(
    r"\b(data(?:sets?)?|database|recordings?|raw data|images?|scans|stimuli"
    r"|materials?|corpus|measurements|participant data|behavio(?:u)?ral data)\b", re.I)
VERBES_DISPO = re.compile(
    r"\b(available|accessible|accessed|deposited|shared|provided|released|hosted"
    r"|published|archived|downloaded|obtained|found|openly|freely|publicly|uploaded"
    r"|stored|submitted)\b", re.I)
# Un « we » nu ne dit rien de la propriété d'un lien : « We computed the DCC
# using the edgeofpy package (lien) » cite un outil (PMC12640546). Il faut un
# verbe de création ou de mise à disposition.
PROPRE = re.compile(
    r"\b(our|we (?:provide|release|share|make|have made|developed|wrote|created"
    r"|implemented|publish|deposit)|this (?:study|paper|work|article|manuscript|project|analysis)"
    r"|the (?:present|current) (?:study|work|paper)|in-house|custom|developed (?:for|in)"
    r"|written (?:for|in)|to reproduce|reproduc(?:e|ing|ible|tion)|replicat(?:e|ion)"
    r"|supporting (?:the )?(?:findings|results)|used (?:in|for|to generate) (?:this|the (?:present|current))"
    r"|all (?:analyses|analysis|code|scripts))\b", re.I)
# « used » nu non plus : « the data used for this paper » (PMC12748784).
OUTIL = re.compile(
    r"\b(using|with the|implemented (?:in|with|using)|performed (?:in|with|using)"
    r"|carried out (?:in|with|using)|conducted (?:in|with|using)|processed (?:in|with|using)"
    r"|analy[sz]ed (?:in|with|using)|created with|provided by|developed by|via|by means of"
    r"|toolbox|plug-?in|library|package|open-source|version|v\d+\.\d+|RRID"
    r"|downloaded (?:\S+ ){0,4}from)\b", re.I)
#: Un paquet NOMMÉ en minuscules : « from the ppm R package, available on
#: GitHub (lien) » (PMC12645806) — la phrase décrit l'emploi d'un paquet.
PAQUET_NOMME = re.compile(
    r"\b(?:the|from the|using the|with the|in the)\s+[\w.\-]+\s+(?:R |Python |MATLAB |Julia )?"
    r"(?:package|toolbox|library|module|plugin|plug-in)\b", re.I)
#: Une citation auteur-année : « (Fang and Boas 2009b », « Gramfort et al., 2013 ».
CITATION = re.compile(r"([A-Z][A-Za-zÀ-ÿ'\-]+)(?: et al\.?| and [A-Z][A-Za-zÀ-ÿ'\-]+| & [A-Z][A-Za-zÀ-ÿ'\-]+)?,?\s+(?:19|20)\d{2}[a-z]?\b")
#: Un NOM D'OUTIL juste avant le lien : « NeuroPycon (lien) », « mTRF-Toolbox9
#: (lien) ». On ne retient que les noms qui ont la forme d'un nom de logiciel —
#: majuscule interne, chiffre ou trait d'union —, pas « Code (lien) ».
NOM_OUTIL_AVANT = re.compile(
    r"(?<![\w-])([A-Za-z]*[A-Z][a-z0-9]*[A-Z0-9\-][\w\-+.]*)(?:\s+(?:software|toolbox|package"
    r"|library|toolkit|plugin|app))?\s*\d*\s*[:(\[]?\s*$")
#: Les hôtes eux-mêmes ne sont pas des outils : « on GitHub (lien) ».
_HOTES_NOMMES = frozenset({"GitHub", "GitLab", "Zenodo", "OSF", "OpenNeuro", "DataDryad",
                           "BitBucket", "Bitbucket", "CodeOcean", "FigShare", "Figshare",
                           "HuggingFace", "PhysioNet", "DANDI", "OpenfMRI", "ModelDB"})
SUR_DEMANDE = re.compile(
    r"(upon|on|by|at) (?:a )?(?:reasonable |written |justified )?request"
    r"|available (?:from|through|by contacting|via) the (?:corresponding|first|senior|last|lead) author"
    r"|contact(?:ing)? the (?:corresponding|first|senior|last) author"
    r"|can be requested|will be (?:made )?available (?:upon|on|after)", re.I)
CE_PAPIER = re.compile(r"\bthis (?:paper|study|work|article)\b", re.I)

#: Boîtes à outils de neurosciences et de calcul que les articles CITENT. Un
#: lien juste après l'un de ces noms est presque toujours l'outil, pas le code
#: des auteurs.
OUTILS_CONNUS: tuple[str, ...] = (
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
_OUTILS_RE = re.compile(r"(?<![\w-])(" + "|".join(sorted(map(re.escape, OUTILS_CONNUS),
                                                         key=len, reverse=True)) + r")(?![\w-])")

#: Dépôts d'outils publics : l'organisation seule suffit à conclure.
ORGS_OUTILS: frozenset[str] = frozenset({
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

#: Dépôts d'outils tenus par une personne : on nomme le dépôt, pas le compte,
#: car le même compte porte aussi le code de ses articles.
DEPOTS_OUTILS: frozenset[str] = frozenset({
    "github.com/raphaelvallat/yasa", "github.com/raphaelvallat/pingouin",
    "github.com/raphaelvallat/antropy", "github.com/sappelhoff/pyprep",
    "github.com/mwaskom/seaborn",
    "github.com/cbrnr/mnelab", "github.com/cbrnr/sleepecg",
    "github.com/pierreablin/picard", "github.com/alexandrebarachant/pyriemann",
    "github.com/nbara/python-meegkit", "github.com/mattjj/pyhsmm",
    "github.com/bbci/bbci_public", "github.com/aestrivex/bctpy",
})


@dataclass
class Jugement:
    role: str
    confiance: str                       # forte | moyenne | faible
    ecart: float                         # meilleur score − second
    scores: dict[str, float] = field(default_factory=dict)
    raisons: list[str] = field(default_factory=list)
    sur_demande: bool = False


def _sans_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s)
                   if not unicodedata.combining(c)).lower()


def auteurs_communs(a: tuple[str, ...] | list[str], b: list[str],
                    texte_ref: str = "") -> list[str]:
    """Les noms de famille communs, sans accents ni casse.

    Quand la référence n'est pas balisée (« Schmidt F. ECG_1f_memory. »,
    « Yu, Q. & Liu, Y. »), on cherche les noms de l'article SUIVIS D'INITIALES
    en tête de référence : un nom court comme « He » n'est retenu que sous la
    forme « He B. », jamais comme pronom.
    """
    bb = {_sans_accents(x) for x in b if len(x) > 1}
    communs = [x for x in a if _sans_accents(x) in bb]
    if communs or not texte_ref:
        return communs
    tete = texte_ref[:160]
    for nom in b:
        if len(nom) < 2:
            continue
        if re.search(rf"(?<![\w-]){re.escape(nom)}(?:,\s*|\s+)(?:[A-Z]\.?-?\s*){{1,3}}(?=[\s,.;&]|$)",
                     tete):
            communs.append(nom)
    return communs


_VIDES = frozenset({"with", "from", "that", "this", "their", "using", "during", "between",
                    "into", "through", "under", "over", "which", "these", "those", "study",
                    "analysis", "effects", "effect", "based", "role", "evidence"})


def meme_titre(titre_article: str, texte_ref: str) -> bool:
    """La référence porte-t-elle le titre de l'article ? C'est alors son archive
    (« Trait anxiety is associated with … (version 1.0). Zenodo »)."""
    mots = {m for m in re.findall(r"[a-z]{4,}", _sans_accents(titre_article)) if m not in _VIDES}
    if len(mots) < 3:
        return False
    ref = set(re.findall(r"[a-z]{4,}", _sans_accents(texte_ref)))
    return len(mots & ref) / len(mots) >= 0.7


def segment(phrase: str, ancre: str) -> str:
    """La part de la phrase qui parle de CE lien.

    Une phrase à plusieurs liens en distribue les noms : « The raw data are
    available at (osf), and the analysis code at (github) ». Le segment d'un
    lien va de la fin du lien précédent à la première coupure (virgule,
    point-virgule, « and ») après lui. Un segment sans aucun nom — la queue
    d'une énumération, « … on GitHub at: (A) & (B) » — hérite du début de la
    phrase, qui porte le nom commun.
    """
    i = phrase.find(ancre) if ancre else -1
    if i < 0:
        return phrase
    fin_lien = i + len(ancre)
    autres = [(m.start(), m.end()) for m in liens.URL_TEXTE.finditer(phrase)
              if not (m.start() <= i < m.end() or i <= m.start() < fin_lien)]
    autres += [(m.start(), m.end()) for m in liens.DOI_TEXTE.finditer(phrase)
               if not (m.start() <= i < m.end() or i <= m.start() < fin_lien)
               and not any(a <= m.start() < b for a, b in autres)]
    if not autres:
        return phrase
    debut = max([b for a, b in autres if b <= i], default=0)
    suivant = min([a for a, b in autres if a >= fin_lien], default=len(phrase))
    coupe = re.search(r"[,;]|\band\b|\bwhile\b|\bwhereas\b", phrase[fin_lien:suivant])
    fin = fin_lien + coupe.start() if coupe else suivant
    seg = phrase[debut:fin]
    if not (NOMS_CODE.search(seg) or NOMS_DONNEES.search(seg)):
        seg = phrase[:fin]
    return seg


def _proche_avant(phrase: str, ancre: str, motif: re.Pattern[str],
                  fenetre: int = 70) -> str:
    """Le dernier nom qui précède le lien dans la même proposition."""
    i = phrase.find(ancre) if ancre else -1
    if i < 0:
        return ""
    avant = phrase[max(0, i - fenetre):i]
    # Une proposition s'arrête à un point-virgule ou à « and » + nouveau sujet.
    avant = re.split(r";|\band (?:the )?(?=\w+ (?:is|are|were|was|can)\b)", avant)[-1]
    trouve = list(motif.finditer(avant))
    return trouve[-1].group(0) if trouve else ""


def juger(occ: Occurrence, lien: Lien, auteurs_article: list[str],
          titre_article: str = "") -> Jugement:
    s = {"code": 0.0, "donnees": 0.0, "outil_tiers": 0.0}
    r: list[str] = []

    def ajoute(role: str, v: float, pourquoi: str) -> None:
        s[role] += v
        r.append(f"{role}{v:+.1f} {pourquoi}")

    for role, v in A_PRIORI.get(lien.genre, {}).items():
        ajoute(role, v, f"hôte {lien.hote} ({lien.genre})")

    phrase = occ.phrase
    ancre = occ.texte_lien or occ.url
    if ancre not in phrase and occ.url in phrase:
        ancre = occ.url
    titres = " / ".join(occ.sections)
    # Les indices de la phrase se lisent sur le SEGMENT du lien : dans une
    # phrase à deux liens, chacun a ses noms.
    seg = segment(phrase, ancre) if occ.lieu != "references" else phrase
    seg = CODES_QUI_NE_SONT_PAS_DU_CODE.sub(lambda m: "_" * len(m.group(0)), seg)
    code_nom = NOMS_CODE.search(seg)
    code_fort = NOMS_CODE_FORTS.search(seg)
    donnees_nom = NOMS_DONNEES.search(DONNEES_ACCESSOIRES.sub(" ", seg))
    dispo = VERBES_DISPO.search(seg)
    propre = PROPRE.search(seg)

    # ─── les dépôts d'outils connus ────────────────────────────────────────
    if lien.proprietaire.lower() in ORGS_OUTILS or lien.norme in DEPOTS_OUTILS:
        ajoute("outil_tiers", 4.0, f"dépôt d'un outil public ({lien.norme})")
    avant = phrase[:max(0, phrase.find(ancre))] if ancre in phrase else ""
    outil_nomme = _OUTILS_RE.findall(avant[-60:])
    if outil_nomme and not (code_fort and propre):
        ajoute("outil_tiers", 2.5, f"outil nommé juste avant : {outil_nomme[-1]}")
    elif occ.lieu != "references" and not propre:
        nom = NOM_OUTIL_AVANT.search(avant[-80:])
        if nom and nom.group(1) not in _HOTES_NOMMES:
            ajoute("outil_tiers", 1.5, f"nom de logiciel juste avant : {nom.group(1)}")
        paquet = PAQUET_NOMME.search(seg)
        if paquet and not re.search(r"\bour\b", paquet.group(0), re.I):
            ajoute("outil_tiers", 2.0, f"paquet nommé « {paquet.group(0)} »")
    if occ.lieu != "references":
        cites = [c for c in CITATION.findall(seg)
                 if c not in ("Table", "Figure", "Fig", "Version")]
        etrangers = [c for c in cites if not auteurs_communs([c], auteurs_article)]
        if etrangers and not propre and lien.genre not in ("donnees",):
            ajoute("outil_tiers", 1.0, f"la phrase cite d'autres auteurs ({etrangers[0]})")

    # ─── le lieu ───────────────────────────────────────────────────────────
    if occ.lieu == "disponibilite":
        # Le titre le PLUS PROCHE, pas le chemin : « Software availability »
        # rangé sous « Materials and methods » passait pour une section mixte.
        proche = occ.titre_proche
        parle_code = re.search(r"\bcodes?\b|software|scripts?", proche, re.I)
        parle_donnees = re.search(r"\bdata\b|materials?", proche, re.I)
        if parle_code and parle_donnees:
            ajoute("code", 0.75, f"section mixte « {occ.titre_proche[:50]} »")
            ajoute("donnees", 0.75, f"section mixte « {occ.titre_proche[:50]} »")
        elif parle_code:
            ajoute("code", 1.5, f"section « {occ.titre_proche[:50]} »")
        elif parle_donnees:
            ajoute("donnees", 0.5, f"section « {occ.titre_proche[:50]} »")
    elif occ.lieu == "references":
        communs = auteurs_communs(occ.ref_auteurs, auteurs_article, phrase)
        propre_ref = bool(communs) or (titre_article and meme_titre(titre_article, phrase))
        genre_ref = re.search(r"\[(?:computer )?(software|code|data ?set|dataset)\]", phrase, re.I)
        dit_donnees = bool((genre_ref and "data" in genre_ref.group(1).lower())
                           or (re.search(r"\b(data ?sets?|database|recordings|data from"
                                         r"|digital repository)\b", phrase, re.I)
                               and not re.search(r"\b(codes?|scripts?|software)\b", phrase, re.I)))
        if propre_ref:
            cible = "donnees" if (dit_donnees or lien.genre == "donnees") else "code"
            qui = ", ".join(communs[:2]) if communs else "titre de l'article"
            ajoute(cible, 2.5, f"référence signée par les auteurs ({qui})")
        else:
            cible = "donnees" if (lien.genre == "donnees" or dit_donnees) else "outil_tiers"
            ajoute(cible, 2.0, "référence à un travail d'autres auteurs")
    elif occ.lieu == "tableau":
        if CE_PAPIER.search(phrase):
            cible = "code" if (code_nom or lien.genre in ("forge", "execution")) and not (
                donnees_nom and not code_nom) else "donnees"
            ajoute(cible, 3.0, "ligne « This paper » du tableau des ressources")
        elif re.search(r"software|algorithm|toolbox", phrase + " " + titres, re.I):
            ajoute("outil_tiers", 2.0, "ligne logicielle du tableau des ressources")
    elif occ.lieu == "metadonnees":
        # Une relation déposée par l'éditeur ou l'auteur : « is-supplemented-by »
        # chez Crossref, un logiciel DataCite qui déclare l'article.
        if occ.type_section.endswith(":propre"):
            donnees = ("Dataset" in occ.type_section or lien.genre == "donnees")
            ajoute("donnees" if donnees else "code", 3.0,
                   f"métadonnée déposée ({occ.type_section.removesuffix(':propre')})")
        elif occ.type_section == "github:readme":
            # Un README qui cite l'article, sous un compte étranger aux auteurs :
            # peut-être une réimplémentation. Gardé, jamais compté comme natif.
            r.append("inconnu : le README cite l'article, le compte n'est pas celui d'un auteur")
    elif occ.lieu == "remerciements":
        ajoute("outil_tiers", 0.5, "cité dans les remerciements")
    elif occ.lieu == "supplementaire":
        ajoute("code", 0.5, "matériel supplémentaire")

    # ─── la phrase ─────────────────────────────────────────────────────────
    if occ.lieu != "references":
        if code_fort and dispo:
            ajoute("code", 2.0, f"« {code_fort.group(0)} » + « {dispo.group(0)} »")
        elif code_nom and dispo and not outil_nomme:
            ajoute("code", 1.0, f"« {code_nom.group(0)} » + « {dispo.group(0)} »")
        if propre and (code_nom or lien.genre in ("forge", "execution", "modele")):
            ajoute("code", 1.5, f"marqueur de propriété « {propre.group(0)} »")
        if donnees_nom and dispo and not code_nom:
            ajoute("donnees", 2.0, f"« {donnees_nom.group(0)} » + « {dispo.group(0)} », sans code")
        proche_code = _proche_avant(CODES_QUI_NE_SONT_PAS_DU_CODE.sub(
            lambda m: "_" * len(m.group(0)), phrase), ancre, NOMS_CODE)
        proche_donnees = _proche_avant(DONNEES_ACCESSOIRES.sub(
            lambda m: "_" * len(m.group(0)), phrase), ancre, NOMS_DONNEES)
        if proche_code and proche_donnees:
            i_c = phrase.rfind(proche_code, 0, max(0, phrase.find(ancre)))
            i_d = phrase.rfind(proche_donnees, 0, max(0, phrase.find(ancre)))
            if i_d > i_c:
                ajoute("donnees", 1.5, f"le nom le plus proche est « {proche_donnees} »")
            else:
                ajoute("code", 1.5, f"le nom le plus proche est « {proche_code} »")
        elif proche_code:
            ajoute("code", 0.5, f"« {proche_code} » juste avant")
        elif proche_donnees:
            ajoute("donnees", 1.0, f"« {proche_donnees} » juste avant")
        outil = OUTIL.search(seg)
        if outil and not propre and not (code_fort and dispo):
            ajoute("outil_tiers", 1.5, f"marqueur d'emploi « {outil.group(0)} »")

    if lien.genre == "forge" and not lien.depot:
        s["code"] -= 0.5
        r.append("code-0.5 compte sans dépôt précis")

    classement = sorted(s.items(), key=lambda kv: kv[1], reverse=True)
    (meilleur, v1), (_, v2) = classement[0], classement[1]
    ecart = round(v1 - v2, 2)
    if v1 < SEUIL or ecart <= 0:
        role = "inconnu"
    else:
        role = meilleur
    confiance = ("forte" if v1 >= 3.5 and ecart >= 2.0 else
                 "moyenne" if v1 >= 2.0 and ecart >= 1.0 else "faible")
    return Jugement(role, confiance, ecart, {k: round(v, 2) for k, v in s.items()}, r,
                    bool(SUR_DEMANDE.search(phrase)))
