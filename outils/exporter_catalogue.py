"""Exporter le catalogue de méthodes de stat_bruteforce vers `scrapper/vocabulaire/`.

**Pourquoi une copie et pas un import.** Le ramasseur doit tourner sur un
hébergement gratuit, sans le dépôt stat_bruteforce ni ses environnements. On
fige donc le catalogue — le nom de chaque méthode, sa FAMILLE et le motif qui la
reconnaît dans une phrase — dans un JSON versionné, et on le rafraîchit quand
le catalogue grandit.

Les familles sont celles du catalogue lui-même : les titres de section de
`gabarits_neuro.py` (Prétraitement, Spectre et temps-fréquence, Potentiels
évoqués…). Les gabarits écrits hors de ces sections (`gabarits.py`,
`gabarits_neuro2.py`) sont rangés par les mots de leur nom ; ceux qu'aucun mot
ne range vont dans « Autres méthodes », et l'export le dit.

À lancer avec le Python de stat_bruteforce :

    ~/stat_bruteforce/multimodal_env/bin/python outils/exporter_catalogue.py
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

SBF = Path.home() / "stat_bruteforce"
SORTIE = Path(__file__).resolve().parents[1] / "scrapper" / "vocabulaire" / "catalogue_methodes.json"

#: Pour les gabarits hors section : un mot du nom de la méthode → sa famille.
MOTS_FAMILLE: tuple[tuple[str, str], ...] = (
    (r"heart rate|emg|saccade|blink|pupil|respiration|line length|teager|burst suppression"
     r"|kurtosis|skewness", "Physiologie et mesures du signal"),
    (r"spindle", "Spectre et temps-fréquence"),
    (r"phase locking", "Connectivité"),
    (r"diffusion tensor", "IRMf et imagerie"),
    (r"t-test|comparison|fisher|mcnemar|bland|kaplan|survival", "Statistiques"),
    (r"principal component|independent component|partial least|umap|t-sne|mixture",
     "Lissage, filtrage d'état, décompositions"),
    (r"k-means|clustering|discriminant|perceptron|representational similarity", "Apprentissage"),
    (r"spike|psth|isi|firing|calcium|dff|deconv", "Activité unitaire, imagerie calcique"),
    (r"glm|hrf|bold|fmri|voxel|fwhm|motion|roi|seed|slice|realign|normali[sz]", "IRMf et imagerie"),
    (r"beamform|lcmv|dics|loreta|dipole|inverse|source|leadfield|forward", "Sources"),
    (r"graph|degree|clustering_coef|modularity|efficien|small_world|centrality|path_length", "Graphes"),
    (r"entropy|lempel|fractal|higuchi|dfa|hurst|lyapunov|complexity|katz|petrosian", "Complexité"),
    (r"coheren|pli|plv|connectiv|granger|pdc|dtf|aec|transfer|mutual|synchron|pac|coupling", "Connectivité"),
    (r"erp|evoked|p300|n400|n170|mmn|latency|gfp|microstate|peak", "Potentiels évoqués"),
    (r"fft|psd|welch|power|spectr|wavelet|morlet|hilbert|multitaper|stft|erd|ers|itc|band|fooof|aperiodic|oscill", "Spectre et temps-fréquence"),
    (r"svm|lda|knn|forest|boost|cross|cnn|lstm|eegnet|csp|riemann|logistic|classif|decod|mvpa|neural|regressor|xgb|train", "Apprentissage"),
    (r"ttest|t_test|anova|wilcoxon|mann|permutation|fdr|bonferroni|mixed|regression|correlat|bootstrap|cohen|chi|kruskal|friedman|bayes|statist|effect", "Statistiques"),
    (r"smooth|kalman|pca|emd|ssa|nmf|decompos|savgol|filter_state|hmm", "Lissage, filtrage d'état, décompositions"),
    (r"filter|notch|refer|ica|artifact|artefact|epoch|baseline|interpol|resampl|detrend|asr|reject|clean|zscore|normal", "Prétraitement"),
)


def familles_par_section(source: Path) -> dict[str, str]:
    """`{méthode: famille}` d'après les titres de section `# ====` du fichier."""
    lignes = source.read_text().splitlines()
    famille, vu = "", {}
    for i, l in enumerate(lignes):
        # Un titre de famille est ENCADRÉ par deux lignes `# ====` ; le
        # commentaire qui suit le cadre n'en est pas un.
        if re.match(r"^\s*# =+", l) and i + 2 < len(lignes) and re.match(r"^\s*# =+", lignes[i + 2]):
            m = re.match(r"^\s*# ([A-ZÉÈÀ][^=]+?)\s*$", lignes[i + 1])
            if m:
                famille = m.group(1).strip()
        m = re.search(r'Gabarit\(\s*"([^"]+)"', l)
        if m and famille:
            vu[m.group(1)] = famille
    return vu


def main() -> int:
    sys.path.insert(0, str(SBF))
    from sbf.transcrire.gabarits import GABARITS  # noqa: E402

    par_section: dict[str, str] = {}
    for f in ("gabarits.py", "gabarits_neuro.py", "gabarits_neuro2.py"):
        par_section.update(familles_par_section(SBF / "sbf" / "transcrire" / f))
    sortie, compte = [], Counter()
    for g in GABARITS:
        famille = par_section.get(g.methode, "")
        if not famille:
            famille = next((fam for motif, fam in MOTS_FAMILLE
                            if re.search(motif, g.methode, re.I)), "Autres méthodes")
        compte[famille] += 1
        sortie.append({"methode": g.methode, "famille": famille, "motif": g.motif,
                       "articles_corpus": g.articles})
    SORTIE.parent.mkdir(parents=True, exist_ok=True)
    SORTIE.write_text(json.dumps({"source": "stat_bruteforce sbf/transcrire/gabarits*.py",
                                  "methodes": sortie}, ensure_ascii=False, indent=1))
    print(f"{len(sortie)} méthodes → {SORTIE}")
    for fam, n in compte.most_common():
        print(f"  {n:4d}  {fam}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
