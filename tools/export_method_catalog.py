"""Export stat_bruteforce's method catalogue to `oscr/vocabulary/method_catalog.json`.

**Why a copy and not an import.** The harvester must run on a free host, without the
stat_bruteforce repository and its environments. The catalogue — each method's name, its
FAMILY and the pattern that recognizes it in a sentence — is frozen in a versioned JSON,
refreshed when the catalogue grows.

**Families.** A method already in the vocabulary keeps its family (they were curated
from the catalogue's own sections). A new method is filed by the words of its name; one
that no word files goes to "Other methods", and the export says so.

Run it with stat_bruteforce's Python:

    ~/stat_bruteforce/multimodal_env/bin/python tools/export_method_catalog.py
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

SBF = Path.home() / "stat_bruteforce"
OUTPUT = Path(__file__).resolve().parents[1] / "oscr" / "vocabulary" / "method_catalog.json"

#: For a new method: a word of its name → its family.
FAMILY_WORDS: tuple[tuple[str, str], ...] = (
    (r"heart rate|emg|saccade|blink|pupil|respiration|line length|teager|burst suppression"
     r"|kurtosis|skewness", "Physiology & signal measures"),
    (r"spindle", "Spectral & time-frequency"),
    (r"phase locking", "Connectivity"),
    (r"diffusion tensor", "fMRI & imaging"),
    (r"t-test|comparison|fisher|mcnemar|bland|kaplan|survival", "Statistics"),
    (r"principal component|independent component|partial least|umap|t-sne|mixture",
     "Smoothing, state filtering, decompositions"),
    (r"k-means|clustering|discriminant|perceptron|representational similarity", "Machine learning"),
    (r"spike|psth|isi|firing|calcium|dff|deconv", "Single-unit activity, calcium imaging"),
    (r"glm|hrf|bold|fmri|voxel|fwhm|motion|roi|seed|slice|realign|normali[sz]", "fMRI & imaging"),
    (r"beamform|lcmv|dics|loreta|dipole|inverse|source|leadfield|forward", "Source localization"),
    (r"graph|degree|clustering_coef|modularity|efficien|small_world|centrality|path_length", "Graphs"),
    (r"entropy|lempel|fractal|higuchi|dfa|hurst|lyapunov|complexity|katz|petrosian", "Complexity"),
    (r"coheren|pli|plv|connectiv|granger|pdc|dtf|aec|transfer|mutual|synchron|pac|coupling", "Connectivity"),
    (r"erp|evoked|p300|n400|n170|mmn|latency|gfp|microstate|peak", "Evoked potentials"),
    (r"fft|psd|welch|power|spectr|wavelet|morlet|hilbert|multitaper|stft|erd|ers|itc|band|fooof|aperiodic|oscill",
     "Spectral & time-frequency"),
    (r"svm|lda|knn|forest|boost|cross|cnn|lstm|eegnet|csp|riemann|logistic|classif|decod|mvpa|neural|regressor|xgb|train",
     "Machine learning"),
    (r"ttest|t_test|anova|wilcoxon|mann|permutation|fdr|bonferroni|mixed|regression|correlat|bootstrap|cohen|chi"
     r"|kruskal|friedman|bayes|statist|effect", "Statistics"),
    (r"smooth|kalman|pca|emd|ssa|nmf|decompos|savgol|filter_state|hmm", "Smoothing, state filtering, decompositions"),
    (r"filter|notch|refer|ica|artifact|artefact|epoch|baseline|interpol|resampl|detrend|asr|reject|clean|zscore|normal",
     "Preprocessing"),
)


def main() -> int:
    sys.path.insert(0, str(SBF))
    from sbf.transcrire.gabarits import GABARITS  # noqa: E402  (stat_bruteforce's own module names)

    known: dict[str, str] = {}
    if OUTPUT.exists():
        known = {m["method"]: m["family"] for m in json.loads(OUTPUT.read_text()).get("methods", [])}
    out, count = [], Counter()
    for g in GABARITS:
        family = known.get(g.methode) or next(
            (fam for pattern, fam in FAMILY_WORDS if re.search(pattern, g.methode, re.I)), "Other methods")
        count[family] += 1
        out.append({"method": g.methode, "family": family, "pattern": g.motif, "corpus_articles": g.articles})
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"source": "stat_bruteforce sbf/transcrire/gabarits*.py", "methods": out},
                                 ensure_ascii=False, indent=1))
    print(f"{len(out)} methods → {OUTPUT}")
    for family, n in count.most_common():
        print(f"  {n:4d}  {family}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
