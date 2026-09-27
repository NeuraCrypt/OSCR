"""oscr.repofeatures: features of a file list, tools of the stored scripts. Synthetic inputs only."""
import json
from collections import Counter

from oscr import repofeatures as rf


def tools_of(*files):
    """{tool: via} for (path, text) pairs; the language comes from the extension."""
    return {d["tool"]: d["via"] for d in rf.detect_tools([(p, "", t) for p, t in files])}


# ─── the vocabulary ───────────────────────────────────────────────────────────

def test_the_vocabulary_loads_and_has_no_conflict():
    tools = rf.vocabulary()
    assert 150 <= len(tools) <= 250
    assert rf.check_vocabulary(tools) == []
    keys = {"id", "name", "kind", "languages", "python", "r", "matlab", "julia", "shell",
            "homepage", "rrid"}
    assert all(keys <= set(t) for t in tools)
    assert all(t["rrid"] == "" or t["rrid"].startswith("RRID:SCR_") for t in tools)


def test_ids_are_unique_and_no_import_name_points_to_two_tools():
    tools = rf.vocabulary()
    ids = [t["id"] for t in tools]
    assert len(ids) == len(set(ids))
    for language in ("python", "r", "julia", "matlab", "shell"):
        owners = Counter(n for t in tools for n in t[language])
        assert [n for n, c in owners.items() if c > 1] == [], language


def test_the_vocabulary_covers_the_neuroscience_tools_of_the_mission():
    ids = {t["id"] for t in rf.vocabulary()}
    for tid in ("mne", "fieldtrip", "eeglab", "spm", "brainstorm", "nilearn", "nibabel", "nipype",
                "fsl", "freesurfer", "afni", "ants", "mrtrix3", "fmriprep", "dipy", "brian2",
                "neuron", "nest", "netpyne", "tvb", "suite2p", "caiman", "deeplabcut", "sleap",
                "spikeinterface", "kilosort", "phy", "nwb", "neo", "elephant", "spyking-circus",
                "mountainsort", "bycycle", "specparam", "yasa", "pyriemann", "braindecode", "moabb",
                "psychopy", "psychtoolbox", "chronux", "conn", "brainiak", "nltools", "brainspace",
                "abagen", "neuromaps", "netneurotools", "bct", "hcp-pipelines", "dpabi", "gift",
                "numpy", "scipy", "pandas", "scikit-learn", "pytorch", "lme4", "ggplot2", "seurat"):
        assert tid in ids, tid


def test_a_conflicting_vocabulary_is_reported():
    base = {"name": "x", "kind": "library", "languages": ["Python"], "r": [], "matlab": [],
            "julia": [], "shell": [], "packages": [], "files": [], "homepage": "", "rrid": ""}
    problems = rf.check_vocabulary([
        dict(base, id="alpha", python=["shared"]),
        dict(base, id="beta", python=["shared"]),
        dict(base, id="beta", python=["other"]),
        dict(base, id="gamma", python=["g"], kind="plugin", rrid="SCR_1"),
    ])
    text = " ".join(problems)
    assert "'shared'" in text and "duplicate id 'beta'" in text
    assert "kind 'plugin'" in text and "malformed RRID" in text


def test_the_shape_rules_point_to_tools_of_the_vocabulary():
    ids = {t["id"] for t in rf.vocabulary()}
    assert all(tool in ids for _, tool in rf._M_PATTERNS)


# ─── Python ───────────────────────────────────────────────────────────────────

def test_python_imports_are_read_with_ast():
    code = ("import numpy as np\nimport mne.io as mio\nfrom sklearn.linear_model import Ridge\n"
            "from nipype.interfaces import fsl\ntry:\n    import nilearn\nexcept ImportError:\n    pass\n")
    found = rf.detect_tools([("analysis/run.py", "Python", code)])
    by_tool = {d["tool"]: d for d in found}
    assert set(by_tool) == {"numpy", "mne", "scikit-learn", "nipype", "fsl", "nilearn"}
    assert all(d["via"] == "import" and d["detected_by"] == "ast" for d in found)


def test_a_python_comment_string_or_docstring_is_not_an_import():
    code = ('"""Usage:\n    import mne\n"""\n# import nilearn\nmessage = "import seaborn"\n'
            "print(message)\n")
    assert tools_of(("x.py", code)) == {}


def test_a_python_file_that_does_not_parse_falls_back_to_lines():
    code = ('"""Old code.\nimport mne\n"""\nimport nibabel as nib, numpy\n'
            'from scipy import io  # import pandas\nprint "Python 2"\n')
    found = rf.detect_tools([("old.py", "Python", code)])
    assert {d["tool"] for d in found} == {"nibabel", "numpy", "scipy"}
    assert all(d["detected_by"] == "regex" for d in found)


def test_python_shell_commands_rpy2_and_environment_variables():
    code = ("import os, subprocess as sp\nfrom rpy2.robjects.packages import importr\n"
            "lme4 = importr('lme4')\n"
            "sp.run(['fslmaths', 'in', '-bin', 'out'])\n"
            "os.system(f\"recon-all -s {subject} -all\")\n"
            "cmd = 'antsRegistrationSyN.sh -d 3 -f ' + fixed\nos.system(cmd)\n"
            "home = os.environ['FREESURFER_HOME']\nprint('fslmaths is not run here')\n")
    found = tools_of(("pipeline.py", code))
    assert found == {"rpy2": "import", "lme4": "import", "fsl": "call", "freesurfer": "call",
                     "ants": "call"}


def test_a_local_module_named_like_a_tool_is_the_repository_s_own():
    main = ("model/run.py", "Python", "from neuron import Neuron\n")
    assert rf.detect_tools([main]) and rf.detect_tools([main])[0]["tool"] == "neuron"
    assert rf.detect_tools([main, ("model/neuron.py", "Python", "class Neuron: pass\n")]) == []
    # inside a package, imports are absolute: the module named like the library imports it
    package = [("seg/__init__.py", "Python", ""),
               ("seg/cellpose.py", "Python", "from cellpose import models\n")]
    assert [d["tool"] for d in rf.detect_tools(package)] == ["cellpose"]


# ─── notebooks and R Markdown ─────────────────────────────────────────────────

def test_a_notebook_reads_its_code_cells_only():
    nb = {"metadata": {"kernelspec": {"language": "python"}}, "cells": [
        {"cell_type": "markdown", "source": ["import nilearn\n"]},
        {"cell_type": "code", "source": ["%matplotlib inline\n", "import mne\n", "!fslmaths a -bin b\n"]},
        {"cell_type": "code", "source": "%%bash\nbet in.nii out.nii\n"},
        {"cell_type": "code", "source": "%%R\nlibrary(lme4)\n"},
        {"cell_type": "code", "source": "%pip install seaborn\nx = np.mean?\n"},
    ]}
    assert tools_of(("demo.ipynb", json.dumps(nb))) == {
        "mne": "import", "fsl": "call", "lme4": "import", "seaborn": "file"}


def test_a_notebook_stored_as_text_by_cells_and_an_r_kernel():
    stored = ("# %%\nimport scanpy as sc\n\n# %% [markdown]\n# import mne\n\n"
              "# %%\n!pip install anndata\n")
    assert tools_of(("x.ipynb", stored)) == {"scanpy": "import", "anndata": "file"}
    r_nb = {"metadata": {"kernelspec": {"language": "R"}},
            "cells": [{"cell_type": "code", "source": "library(ggplot2)\n"}]}
    assert tools_of(("r.ipynb", json.dumps(r_nb))) == {"ggplot2": "import"}


def test_r_markdown_reads_its_chunks():
    rmd = ("---\ntitle: x\n---\nWe used library(psych) in prose.\n\n```{r setup}\nlibrary(brms)\n```\n\n"
           "```{python}\nimport pandas\n```\n")
    assert tools_of(("report.Rmd", rmd)) == {"brms": "import", "pandas": "import"}
    # written on Windows
    assert tools_of(("report.Rmd", rmd.replace("\n", "\r\n"))) == {"brms": "import", "pandas": "import"}
    matlab = "%{\r\nft_freqanalysis(cfg)\r\n%}\r\nft_defaults\r\n"
    assert tools_of(("x.m", matlab)) == {"fieldtrip": "call"}


# ─── R ────────────────────────────────────────────────────────────────────────

def test_r_packages_loaded_in_every_usual_way():
    code = ('library(lme4)\nrequire("ggplot2")\nrequireNamespace("brms", quietly = TRUE)\n'
            "d <- dplyr::filter(d, x > 1)\npacman::p_load(afex, emmeans)\n"
            'pkgs <- c("mgcv", "glmmTMB")\ninvisible(lapply(pkgs, library, character.only = TRUE))\n'
            'install.packages("data.table")\n'
            "for (p in extra) library(p, character.only = TRUE)\n")
    assert tools_of(("analysis.R", code)) == {
        "lme4": "import", "ggplot2": "import", "brms": "import", "tidyverse": "import",
        "afex": "import", "emmeans": "import", "mgcv": "import", "glmmtmb": "import",
        "data-table": "file"}


def test_an_r_comment_or_string_is_not_a_package():
    code = ('# library(Seurat)\nmsg <- "library(psych) and car::Anova"\ncat(msg)  # psych::alpha\n')
    assert tools_of(("x.R", code)) == {}


def test_r_calls_a_shell_program():
    code = 'system(paste("fslmaths", img, "-bin", out))\nSys.getenv("FSLDIR")\n'
    assert tools_of(("run.R", code)) == {"fsl": "call"}


# ─── MATLAB ───────────────────────────────────────────────────────────────────

def test_matlab_toolboxes_by_function_name_and_prefix():
    code = """ft_defaults;
cfg = []; cfg.dataset = 'x.ds';
data = ft_preprocessing(cfg);
EEG = pop_loadset('filename', 's01.set');
eeglab nogui
spm('defaults', 'fmri');
matlabbatch{1}.spm.stats.fmri_spec.dir = {out};
sFiles = bst_process('CallProcess', 'process_import_data_time', [], []);
[S, f] = mtspectrumc(x, params);
Screen('Flip', w); [down, t] = KbCheck;
t0 = GetSecs;
conn_batch(BATCH);
[b, a] = butter(4, 0.1); y = filtfilt(b, a, x);
[h, p] = ttest2(g1, g2);
m = circ_mean(phases);
"""
    assert tools_of(("pipeline.m", code)) == {
        t: "call" for t in ("fieldtrip", "eeglab", "spm", "brainstorm", "chronux", "psychtoolbox",
                            "conn", "matlab-signal", "matlab-statistics", "circstat")}


def test_matlab_comments_strings_variables_and_fields_are_not_calls():
    code = """% ft_preprocessing(cfg) was used before
%{
data = ft_freqanalysis(cfg);
%}
disp('next: ft_timelockanalysis and pop_loadset');
x = y'; z = x' * 2; % pop_epoch
pop_size = 50;
children = zeros(pop_size, 1);
best = pop_size(1);
s.ft_data = 1; v = s.ft_data;
conn_matrix = corrcoef(ts); w = conn_matrix(1, 2);
plot(t, circ_r, 'r')
process_data(x);
function out = spm_local_helper(x)
out = x;
end
"""
    assert tools_of(("clean.m", code)) == {}


def test_a_mathworks_function_the_repository_defines_is_its_own():
    main = ("main.m", "MATLAB", "a = hilbert(x);\nm = circ_mean(phases);\n")
    assert tools_of(("main.m", main[2])) == {"matlab-signal": "call", "circstat": "call"}
    own = [main, ("utils/hilbert.m", "MATLAB", "function y = hilbert(x)\ny = x;\n"),
           ("circstat/circ_mean.m", "MATLAB", "function m = circ_mean(a)\nm = a;\n")]
    assert {d["tool"] for d in rf.detect_tools(own)} == {"circstat"}  # a copied toolbox still counts


def test_matlab_shell_escapes_run_programs():
    code = "cmd = sprintf('bet %s %s -f 0.3', in, out);\nsystem(cmd);\n[s, r] = unix('mri_convert a.mgz a.nii');\n"
    assert tools_of(("prep.m", code)) == {"fsl": "call", "freesurfer": "call"}


# ─── Julia ────────────────────────────────────────────────────────────────────

def test_julia_using_and_import():
    code = ('using Flux, Statistics\nimport DifferentialEquations: solve\n# using Turing\n'
            '"""\n    using Makie\n"""\nf(x) = x\n')
    assert tools_of(("model.jl", code)) == {"flux-jl": "import", "differentialequations-jl": "import"}


# ─── Shell ────────────────────────────────────────────────────────────────────

def test_shell_programs_at_command_position():
    code = """#!/bin/bash
# bet is FSL's brain extraction
echo "bet is run below; recon-all later"
source ${FSLDIR}/etc/fslconf/fsl.sh
fslmaths in -bin out && N=$(fslnvols img)
for s in 01 02; do recon-all -s sub-$s -all; done
3dDeconvolve -input x.nii
nohup antsRegistrationSyN.sh -d 3 -f a -m b &
singularity exec -B /data:/data fsl.sif bet in out
docker run --rm -v $PWD:/data nipreps/fmriprep:23.1.0 /data /out participant
mrconvert dwi.mif dwi.nii
find . -name '*.nii' -exec mriqc {} \\;
"""
    assert tools_of(("run.sh", code)) == {
        t: "call" for t in ("fsl", "freesurfer", "afni", "ants", "fmriprep", "mrtrix3", "mriqc")}


def test_a_shell_word_in_a_comment_or_string_is_not_a_command():
    code = '#!/bin/sh\n# fslmaths in out\necho "bet" \'recon-all\'\nprintf "%s\\n" fast\n'
    assert tools_of(("x.sh", code)) == {}


def test_a_template_placeholder_is_a_word_and_a_brace_group_holds_commands():
    template = ('import subprocess\ncmd = """nibs -w {work_dir} {bids_dir} fmriprep {out_dir} '
                'participant""".format(**paths)\nsubprocess.Popen(cmd, shell=True)\n')
    assert tools_of(("run.py", template)) == {}
    assert tools_of(("x.sh", "[ -f a ] || { fslmaths a -bin b; exit 1; }\n")) == {"fsl": "call"}


def test_shell_installs_and_modules_are_declarations():
    code = "module load fsl/6.0.4 ants\npip install --upgrade nilearn 'mne>=1.4'\n"
    assert tools_of(("setup_env.sh", code)) == {
        "fsl": "file", "ants": "file", "nilearn": "file", "mne": "file"}


# ─── dependency and container files ───────────────────────────────────────────

def test_requirements_and_conda_environments():
    req = ("numpy>=1.20\nscikit-learn==1.0  # models\n# mne\n-r base.txt\n"
           "git+https://github.com/fooof-tools/fooof.git\nopencv-python-headless\n")
    env = ("name: x\nchannels:\n  - mrtrix3\n  - conda-forge\ndependencies:\n  - python=3.11\n"
           "  - pytorch\n  - conda-forge::mne\n  - r-lme4\n  - pip:\n    - nilearn==0.10\n")
    assert tools_of(("requirements.txt", req)) == {
        "numpy": "file", "scikit-learn": "file", "specparam": "file", "opencv": "file"}
    assert tools_of(("environment.yml", env)) == {
        "pytorch": "file", "mne": "file", "lme4": "file", "nilearn": "file"}


def test_dockerfiles_and_other_manifests():
    docker = ("FROM nipreps/fmriprep:23.1.0 AS base\n# RUN pip install seaborn\n"
              "RUN apt-get update && apt-get install -y fsl-core \\\n    && pip install mne nilearn\n"
              "ENV FREESURFER_HOME=/opt/freesurfer\n")
    assert tools_of(("Dockerfile", docker)) == {
        "fmriprep": "file", "fsl": "file", "mne": "file", "nilearn": "file", "freesurfer": "file"}
    assert tools_of(("DESCRIPTION", "Package: x\nImports:\n    lme4 (>= 1.1),\n    ggplot2\nSuggests: testthat\n")) == {
        "lme4": "file", "ggplot2": "file"}
    assert tools_of(("pyproject.toml", '[project]\ndependencies = ["numpy>=1.2", "nibabel"]\n'
                                       '[project.optional-dependencies]\nviz = ["seaborn"]\n')) == {
        "numpy": "file", "nibabel": "file", "seaborn": "file"}
    assert tools_of(("setup.py", "from setuptools import setup\nsetup(install_requires=['scipy', 'pandas>=1'])\n")) == {
        "scipy": "file", "pandas": "file"}
    assert tools_of(("Project.toml", '[deps]\nFlux = "587475ba-b771-5e3f-ad9e-33799f191a9c"\n')) == {
        "flux-jl": "file"}
    assert tools_of(("containers/fsl.def", "Bootstrap: docker\nFrom: brainlife/fsl:6.0.4\n%post\n    pip install dipy\n")) == {
        "fsl": "file", "dipy": "file"}


def test_a_file_type_that_belongs_to_a_tool():
    assert tools_of(("model/cell.hoc", "")) == {"neuron": "file"}
    assert tools_of(("mech/kdr.mod", "NEURON {\n    SUFFIX kdr\n}\n")) == {"neuron": "file"}
    assert tools_of(("go.mod", "module example.com/x\n")) == {}
    assert tools_of(("ampl/model.mod", "var x >= 0;\n")) == {}
    assert tools_of(("model.stan", "data { int N; }\n")) == {"stan": "file"}


# ─── the output ───────────────────────────────────────────────────────────────

def test_the_output_is_sorted_by_evidence_with_examples_and_the_main_route():
    files = [(f"src/m{i}.py", "Python", "import numpy\nimport pandas\n") for i in range(5)]
    files += [("a/b/c/deep.py", "Python", "import numpy\n"), ("requirements.txt", "", "numpy\nmne\n")]
    found = rf.detect_tools(files)
    assert [d["tool"] for d in found] == ["numpy", "pandas", "mne"]
    numpy = found[0]
    assert numpy["evidence"] == 7 and numpy["via"] == "import"
    assert numpy["examples"] == ["src/m0.py", "src/m1.py", "src/m2.py"]
    assert found[2] == {"tool": "mne", "evidence": 1, "via": "file", "examples": ["requirements.txt"],
                        "detected_by": "regex"}
    assert rf.detect_tools([]) == [] and rf.detect_tools([("x.py", "Python", None)]) == []


# ─── features ─────────────────────────────────────────────────────────────────

KEYS = {"n_files", "n_notebooks", "has_readme", "has_citation_cff", "has_license_file",
        "env_files", "has_tests", "has_ci", "has_docs", "data_like"}


def test_features_of_a_well_kept_repository():
    paths = ["README.md", "LICENSE", "CITATION.cff", "requirements.txt", "environment.yml",
             "Dockerfile", "setup.py", "src/pkg/__init__.py", "src/pkg/core.py",
             "tests/test_core.py", ".github/workflows/ci.yml", "docs/index.rst",
             "notebooks/demo.ipynb", "notebooks/.ipynb_checkpoints/demo-checkpoint.ipynb",
             "analysis/report.Rmd", "data/sub-01.mat", "data/sub-02.nii.gz", "data/table.csv",
             "__MACOSX/._README.md"]
    f = rf.features(paths)
    assert set(f) == KEYS
    assert f["n_files"] == 19 and f["n_notebooks"] == 2
    assert f["has_readme"] and f["has_citation_cff"] and f["has_license_file"]
    assert f["env_files"] == ["Dockerfile", "environment.yml", "requirements.txt", "setup.py"]
    assert f["has_tests"] and f["has_ci"] and f["has_docs"]
    assert f["data_like"] == round(3 / 17, 3)


def test_features_of_nothing():
    assert rf.features([]) == {
        "n_files": 0, "n_notebooks": 0, "has_readme": False, "has_citation_cff": False,
        "has_license_file": False, "env_files": [], "has_tests": False, "has_ci": False,
        "has_docs": False, "data_like": 0.0}


def test_features_are_not_fooled_by_look_alikes():
    f = rf.features(["main.m", "data/test/img01.png", "src/README.md", "sub/.github/workflows/ci.yml",
                     "singularity.md", "node_modules/x/test/a.js", "node_modules/x/Dockerfile",
                     "lib/libtiff.def", "docs.txt"])
    assert not (f["has_readme"] or f["has_tests"] or f["has_ci"] or f["has_docs"])
    assert f["env_files"] == []


def test_features_under_a_wrapper_folder_or_inside_an_archive():
    wrapped = rf.features(["proj-main/README.md", "proj-main/.github/workflows/test.yml",
                           "proj-main/LICENSES/MIT.txt", "proj-main/code/run.py"])
    assert wrapped["has_readme"] and wrapped["has_ci"] and wrapped["has_license_file"]
    archive = rf.features(["code.zip/README.txt", "code.zip/analysis.R", "data.csv"])
    assert archive["has_readme"] and archive["data_like"] == round(1 / 3, 3)


def test_features_know_each_ecosystem():
    f = rf.features(["DESCRIPTION", "renv.lock", "man/fit.Rd", "tests/testthat/test-fit.R",
                     "Project.toml", "Manifest.toml", "docker-compose.yml",
                     ".devcontainer/devcontainer.json", "Singularity", "containers/fsl.def",
                     "binder/apt.txt", "matlab/FilterTest.m", "mkdocs.yml", "live.mlx", "paper.qmd",
                     "requirements/dev.txt"])
    assert f["env_files"] == ["DESCRIPTION", "docker-compose.yml", "Manifest.toml", "Project.toml",
                              "renv.lock", "Singularity", ".devcontainer/devcontainer.json",
                              "binder/apt.txt", "containers/fsl.def", "requirements/dev.txt"]
    assert f["has_tests"] and f["has_docs"] and f["n_notebooks"] == 2
    assert rf.features(["tests/testthat/test-fit.R"])["has_tests"]
    assert rf.features(["isoquant_tests/run_barcode_check.py"])["has_tests"]


def test_a_test_by_its_name_only_takes_a_suite():
    # a statistical test, a train/test split, an evaluation on the test set
    for alone in (["utils/DeLong_test.py"], ["train_test.py"], ["test_dataset_model.py"],
                  ["analysis/BinomTest.m"]):
        assert not rf.features(alone + ["main.py"])["has_tests"], alone
    suite = ["src/FilterTest.m", "src/ReaderTest.m", "src/MontageTest.m"]
    assert rf.features(suite)["has_tests"]
    assert rf.features(["test_io.py", "test_model.py", "test_plots.py"])["has_tests"]
