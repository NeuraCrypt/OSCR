"""Tests for oscr.align (paper <-> code alignment, method lexical-v1).

Self-contained: small JATS strings and small code files written here.
"""

import xml.etree.ElementTree as ET

from oscr import align
from oscr.align import METHOD, CodeUnit, Pair, Paragraph, code_units, paper_paragraphs
from oscr.align import align as align_pairs

# ------------------------------------------------------------------ fixtures

MML = "http://www.w3.org/1998/Math/MathML"

JATS = f"""<?xml version="1.0" encoding="UTF-8"?>
<article xmlns:mml="{MML}" xmlns:xlink="http://www.w3.org/1999/xlink">
<front><article-meta><abstract><p>Abstract paragraph, never numbered.</p></abstract></article-meta></front>
<body>
<sec><title>Introduction</title>
<p>Phase-amplitude coupling links slow and fast rhythms; the modulation index and the Hilbert transform
are standard tools (<xref ref-type="bibr" rid="b1">Tort et al., 2010</xref>).</p>
</sec>
<sec><title>Methods</title>
<sec><title>Phase-amplitude coupling</title>
<p>Phase-amplitude coupling was quantified with the modulation index. The LFP was bandpass filtered
between 6 and 12 Hz for theta phase and between 150 and 250 Hz for ripple amplitude with a zero-phase
Butterworth filter (filtfilt). The Hilbert transform gave the instantaneous phase and the amplitude
envelope, and theta phases were binned into 18 phase bins. Significance was assessed against 1000
surrogate shuffles of the ripple envelope.</p>
<p>Spikes were sorted with <italic>Kilosort</italic> and curated manually
<list><list-item><p>nested list item paragraph</p></list-item></list> before analysis
<inline-formula><mml:math><mml:mi>x</mml:mi></mml:math></inline-formula>.</p>
<fig id="f1"><label>Figure 1</label><caption><p>Caption paragraph of figure one.</p></caption></fig>
</sec>
</sec>
<sec><title>Data availability</title>
<p>Code for the modulation index, the Hilbert transform and filtfilt is on GitHub at
https://github.com/example/pac.</p>
</sec>
</body>
<back><ack><p>Back matter paragraph, never numbered.</p></ack></back>
<sub-article><front-stub/><body><p>Sub-article paragraph, never numbered.</p></body></sub-article>
</article>"""

PAC_CODE = '''import numpy as np
from scipy.signal import butter, filtfilt, hilbert


def bandpass(x, fs, band):
    """Zero-phase Butterworth bandpass filter (filtfilt)."""
    b, a = butter(3, np.array(band) / (fs / 2), btype="bandpass")
    return filtfilt(b, a, x)


def modulation_index(lfp, fs, n_bins=18, n_surrogates=1000):
    """Phase-amplitude coupling: modulation index of ripple amplitude by theta phase."""
    theta_phase = np.angle(hilbert(bandpass(lfp, fs, [6, 12])))
    ripple_envelope = np.abs(hilbert(bandpass(lfp, fs, [150, 250])))
    edges = np.linspace(-np.pi, np.pi, n_bins + 1)
    mean_amp = np.array([ripple_envelope[(theta_phase >= lo) & (theta_phase < hi)].mean()
                         for lo, hi in zip(edges[:-1], edges[1:])])
    p = mean_amp / mean_amp.sum()
    mi = (np.log(n_bins) + np.sum(p * np.log(p))) / np.log(n_bins)
    surrogate_mi = [np.random.permutation(ripple_envelope).mean() for _ in range(n_surrogates)]
    return mi, surrogate_mi


def plot_raster(spike_times, ax):
    """Raster of spike times, one row per unit."""
    for row, times in enumerate(spike_times):
        ax.vlines(times, row, row + 0.8)
'''

FILES = [{"repo": "github.com/example/pac", "path": "analysis/pac.py", "language": "Python", "text": PAC_CODE}]


def lines_of(text):
    return text.split("\n")


# --------------------------------------------------------------- paragraphs


def test_paragraphs_follow_body_iter_p_numbering():
    paragraphs = paper_paragraphs(JATS)
    body = ET.fromstring(JATS).find("body")
    expected = list(body.iter("p"))
    assert [p.index for p in paragraphs] == list(range(len(expected)))
    assert len(paragraphs) == 6  # nested list item and caption count; front, back, sub-article do not
    assert paragraphs[3].text == "nested list item paragraph"
    assert paragraphs[4].text == "Caption paragraph of figure one."
    assert all("never numbered" not in p.text for p in paragraphs)


def test_sections_are_joined_titles():
    paragraphs = paper_paragraphs(JATS)
    assert paragraphs[0].section == "Introduction"
    assert paragraphs[1].section == "Methods \u203a Phase-amplitude coupling"
    assert paragraphs[5].section == "Data availability"


def test_paragraph_text_drops_citations_maths_and_nested_paragraphs():
    paragraphs = paper_paragraphs(JATS)
    assert "Tort" not in paragraphs[0].text
    assert "nested list item" not in paragraphs[2].text
    assert paragraphs[2].text.startswith("Spikes were sorted with Kilosort")
    assert "x" not in paragraphs[2].text.split()


def test_missing_body_or_invalid_xml_gives_no_paragraphs():
    assert paper_paragraphs("<article><front/><back><p>x</p></back></article>") == []
    assert paper_paragraphs("<article><body><p>unclosed</body></article>") == []
    # only the root's own <body> counts, not a sub-article's
    only_sub = "<article><sub-article><body><p>inside</p></body></sub-article></article>"
    assert paper_paragraphs(only_sub) == []


def test_paragraph_dataclass_is_frozen():
    p = paper_paragraphs(JATS)[0]
    assert isinstance(p, Paragraph)
    try:
        p.index = 3  # type: ignore[misc]
    except AttributeError:
        pass
    else:
        raise AssertionError("Paragraph should be immutable")


# ---------------------------------------------------------- code segmentation


def test_python_units_are_functions_with_real_lines():
    units = code_units("r", "analysis/pac.py", "Python", PAC_CODE)
    by_symbol = {u.symbol: u for u in units}
    assert {"bandpass", "modulation_index", "plot_raster"} <= set(by_symbol)
    lines = lines_of(PAC_CODE)
    mi = by_symbol["modulation_index"]
    assert lines[mi.start - 1].startswith("def modulation_index")
    assert lines[mi.end - 1].strip() == "return mi, surrogate_mi"
    assert all(isinstance(u, CodeUnit) and u.repo == "r" and u.language == "Python" for u in units)


def test_line_numbers_follow_split_on_newline_only():
    # "\r\n" line ends, a form feed and a lone "\r" inside a comment: str.splitlines()
    # would count extra lines, the website reader (text.split("\n")) does not.
    text = ("import os\r\n"
            "\x0c\r\n"
            "# carriage\rreturn inside a comment\r\n"
            "def first():\r\n"
            "    return 1\r\n"
            "\r\n"
            "\x0c\n"
            "def second():\n"
            "    return 2\n")
    units = {u.symbol: u for u in code_units("r", "x.py", "Python", text)}
    lines = text.split("\n")
    assert len(text.splitlines()) != len(lines) - 1  # the trap this test is about
    first, second = units["first"], units["second"]
    assert (first.start, first.end) == (3, 5)  # the comment right above the def belongs to it
    assert lines[first.start].startswith("def first")
    assert lines[first.end - 1].strip() == "return 1"
    assert (second.start, second.end) == (8, 9)
    assert lines[second.start - 1].startswith("def second")


def test_python_syntax_error_falls_back_to_blocks():
    text = "print 'python 2'\n\ndef f(x):\n    return x\n\nprint f(1)\n"
    units = code_units("r", "old.py", "Python", text)
    assert units and any(u.symbol == "f" for u in units)
    assert all(1 <= u.start <= u.end <= len(lines_of(text)) for u in units)


def test_matlab_functions_and_cells():
    func = ("function out = smooth_rate(x, win)\n% SMOOTH_RATE moving average\nout = movmean(x, win);\nend\n\n"
            "function y = helper(x)\ny = x * 2;\nend\n")
    units = code_units("r", "smooth_rate.m", "MATLAB", func)
    assert [(u.symbol, u.start, u.end) for u in units] == [("smooth_rate", 1, 4), ("helper", 6, 8)]
    script = "%% Load data\nx = load('a.mat');\n\n%% Filter\ny = filtfilt(b, a, x);\n"
    cells = code_units("r", "run.m", "MATLAB", script)
    assert [(u.symbol, u.start, u.end) for u in cells] == [("Load data", 1, 2), ("Filter", 4, 5)]


def test_r_functions_and_rmarkdown_chunks():
    r = "library(lme4)\n\nfit_model <- function(df) {\n  lmer(y ~ x + (1 | id), data = df)\n}\n\nres <- fit_model(d)\n"
    units = code_units("r", "fit.R", "R", r)
    fit = next(u for u in units if u.symbol == "fit_model")
    assert (fit.start, fit.end) == (3, 5)
    rmd = "---\ntitle: x\n---\n\n# Harmonize\n\n```{r harmonize}\ny <- longCombat(d)\n```\n\nText.\n\n```{r}\nplot(y)\n```\n"
    chunks = code_units("r", "a.Rmd", "R", rmd)
    assert [u.symbol for u in chunks] == ["harmonize", "chunk 2"]
    assert chunks[0].start == 5 and lines_of(rmd)[chunks[0].end - 1] == "```"


def test_notebook_cells_carry_their_markdown():
    nb = ("# %% [markdown]\n# ## Load the recordings\n\n# %%\nimport numpy as np\ndata = np.load('x.npy')\n\n"
          "# %%\ndef zscore(x):\n    return (x - x.mean()) / x.std()\n")
    units = code_units("r", "nb.ipynb", "Jupyter", nb)
    assert [(u.symbol, u.start, u.end) for u in units] == [("Load the recordings", 1, 6), ("zscore", 8, 10)]


def test_c_functions_by_brace_matching():
    c = ('#include <stdio.h>\n\n/* integrate one step */\nstatic double step(double v, double dt)\n{\n'
         '    if (v > 0) { return v * dt; }\n    return 0; /* } in comment */\n}\n\n'
         'int main(void) {\n    printf("{");\n    return 0;\n}\n')
    units = {u.symbol: u for u in code_units("r", "sim.cu", "CUDA", c)}
    assert (units["step"].start, units["step"].end) == (3, 8)
    assert (units["main"].start, units["main"].end) == (10, 13)


def test_shell_and_oversized_files():
    sh = "#!/bin/bash\n# preprocessing\nbet in out\n\n# registration\nflirt -in out -ref std\n"
    assert code_units("r", "run.sh", "Shell", sh)
    big = "x = 1\n" * 40000  # 240 KB
    assert code_units("r", "big.py", "Python", big) == []


# -------------------------------------------------------------------- align


def test_align_pairs_methods_paragraph_with_the_function_that_implements_it():
    pairs = align_pairs(JATS, FILES)
    assert pairs, "the methods paragraph should be paired"
    best = pairs[0]
    assert isinstance(best, Pair)
    assert best.pair == 1
    assert best.paragraph == 1
    assert best.section == "Methods \u203a Phase-amplitude coupling"
    assert best.symbol == "modulation_index"
    assert lines_of(PAC_CODE)[best.start_line - 1].startswith("def modulation_index")
    assert 0.5 <= best.score < 1.0
    assert any("6\u201312 Hz" in e or "150\u2013250 Hz" in e for e in best.evidence)


def test_narrative_and_back_matter_paragraphs_are_never_paired():
    paired = {p.paragraph for p in align_pairs(JATS, FILES)}
    assert 0 not in paired  # introduction
    assert 5 not in paired  # data availability


def test_pairs_are_numbered_by_descending_score_and_capped():
    pairs = align_pairs(JATS, FILES + [dict(FILES[0], path="copy/pac_v2.py", text=PAC_CODE + "\n# v2\n")])
    assert [p.pair for p in pairs] == list(range(1, len(pairs) + 1))
    assert [p.score for p in pairs] == sorted((p.score for p in pairs), reverse=True)
    assert align_pairs(JATS, FILES, max_pairs=0) == []
    assert len(align_pairs(JATS, FILES, max_pairs=1)) <= 1


def test_evidence_is_short_terms_not_text():
    for p in align_pairs(JATS, FILES):
        assert 1 <= len(p.evidence) <= 6
        for term in p.evidence:
            assert len(term.split()) <= 4 and len(term) <= 40
        assert round(p.score, 3) == p.score


def test_align_is_deterministic_and_handles_missing_inputs():
    assert align_pairs(JATS, FILES) == align_pairs(JATS, FILES)
    assert align_pairs(JATS, []) == []
    assert align_pairs("<article/>", FILES) == []
    assert align_pairs(JATS, [{"repo": "r", "path": "a.py", "language": "Python", "text": None}]) == []


def test_vendored_and_duplicate_files_are_ignored():
    vendored = [dict(FILES[0], path="lib/python3.12/site-packages/pac/pac.py")]
    assert align_pairs(JATS, vendored) == []
    twice = FILES + [dict(FILES[0], path="analysis/pac_copy.py")]
    assert {p.path for p in align_pairs(JATS, twice)} == {"analysis/pac.py"}


def test_unrelated_code_gives_no_pairs():
    unrelated = [{"repo": "r", "path": "io/export.py", "language": "Python",
                  "text": "import csv\n\ndef export_rows(rows, path):\n    with open(path, 'w') as f:\n"
                          "        csv.writer(f).writerows(rows)\n"}]
    assert align_pairs(JATS, unrelated) == []


def test_method_name():
    assert METHOD == "lexical-v1"
    assert align.MAX_EVIDENCE == 6


# --------------------------------------------------------------- robustness


def test_r_one_line_function_does_not_swallow_the_next_one():
    r = ("f <- function(x) x + 1\ng <- function(y) {\n  y * 2\n}\n"
         "h <- function(a,\n              b)\n{\n  a + b\n}\n")
    units = [(u.symbol, u.start, u.end) for u in code_units("r", "a.R", "R", r)]
    assert units == [("f", 1, 1), ("g", 2, 4), ("h", 5, 9)]


def test_unbalanced_braces_and_minified_lines_stay_fast():
    import time
    never_closes = "int f(int x) {\n  return x;\n" + "".join(f"int g{i}(int y) {{\n" for i in range(3000))
    minified = "function a(){" + "var b=1;" * 20000 + "}\n"
    started = time.perf_counter()
    assert code_units("r", "x.c", "C", never_closes)
    code_units("r", "m.cpp", "C++", minified)
    assert time.perf_counter() - started < 2.0


def test_long_tokens_are_handled_in_linear_time():
    import time
    token = "A" * 60000
    text = f"x = '{token}'\n# {token}@example\n\ndef f():\n    return 1\n"
    started = time.perf_counter()
    align_pairs(JATS, [{"repo": "r", "path": "big.py", "language": "Python", "text": text}])
    assert time.perf_counter() - started < 3.0


def test_jats_may_be_bytes_and_anything_else_gives_nothing():
    assert len(paper_paragraphs(JATS.encode("utf-8"))) == 6
    assert paper_paragraphs(None) == []  # type: ignore[arg-type]
    assert align_pairs(None, FILES) == []  # type: ignore[arg-type]
