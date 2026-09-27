"""What a repository's files say about it: its features, and the tools its scripts use.

Two functions, no request, no clone:

- `features(paths)` reads the repository's list of paths, nothing else: README,
  CITATION.cff, license file, environment files, tests, CI, documentation, notebooks, and
  the share of files that look like data rather than code.
- `detect_tools(files)` reads the stored scripts, `(path, language, text)`, and names the
  libraries, toolboxes and programs they use, against the vocabulary
  `vocabulary/tools.json` (id, name, kind, the names that call it in each language,
  homepage, and an RRID checked on the SciCrunch resolver).

**How a tool is recognized.**

- Python: `import x`, `from x import y` — parsed with `ast`; a file that does not parse
  (Python 2, a stray `?`) falls back to a regular expression on its lines, outside
  comments and docstrings. Also `importlib.import_module("x")`, rpy2's `importr("x")`
  (an R package), shell commands run through `os.system` / `subprocess`, and the
  environment variables of a program (`os.environ["FSLDIR"]`).
- Notebooks: the code cells — of the JSON `.ipynb`, or of the text by cells that
  `oscr.contents` stores — in the kernel's language; `!cmd` lines and `%%bash` cells are
  shell, `%%R` cells are R. R Markdown and Quarto: the ```` ```{r} ```` / ```` ```{python} ````
  chunks.
- R: `library(x)`, `require(x)`, `requireNamespace("x")`, `x::f`, `p_load(...)`, the
  `lapply(pkgs, library, character.only = TRUE)` idiom, roxygen `@import`, `system("...")`.
- MATLAB: calls to a toolbox's functions, by name or prefix (`ft_*`, `pop_*`, `spm_*`,
  `bst_*`…), and SPM batches (`matlabbatch{1}.spm.…`). An identifier assigned in the file
  (a variable), a struct field or the file's own functions is not a call; nor is a
  MathWorks function the repository defines itself. Generic prefixes are not used:
  `conn_*` and `process_*` name variables as often as CONN's and Brainstorm's functions,
  so CONN is known by its function names, and Brainstorm by `bst_*`.
- Julia: `using X`, `import X`.
- Shell: the command word of each simple command (`fslmaths`, `recon-all`, `3dDeconvolve`,
  `antsRegistration`, `mrconvert`, `fmriprep`…), behind `sudo`, `singularity exec` and
  the like; environment variables (`$FSLDIR`); container images (`nipreps/fmriprep`).
- Dependency and container files: requirements, conda environments, `pyproject.toml`,
  `setup.py`, `setup.cfg`, `DESCRIPTION`, Julia's `Project.toml`, Dockerfiles, compose
  files, Apptainer/Singularity definitions, Binder's `apt.txt`.
- The file's type itself: a `.hoc` or NMODL `.mod` file is NEURON, a `.stan` file Stan…

Comments are dropped and string literals set aside before matching, so a tool named in a
comment or a message does not count. A module beside a script (`neuron.py` next to
`run.py`) is the repository's own, not the tool of that name.

Each detection says how it was found (`via`): `import` (the code loads the package),
`call` (it calls a toolbox function or runs the program), `file` (a dependency or
container file declares it, or the file's type belongs to the tool).

**What is not claimed.** The regular expressions do not resolve scopes: a MATLAB variable
loaded from a `.mat` file and indexed like a call, a shell word in a `case` label, an
array of command names can still be taken for the tool. The vocabulary decides what can
be found at all: a tool outside it is not reported.
"""
from __future__ import annotations

import ast
import configparser
import fnmatch
import functools
import json
import os
import re
import tomllib
import warnings
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .repos import SCRIPT_EXTENSIONS

VOCABULARY_FILE = Path(__file__).parent / "vocabulary" / "tools.json"

#: The routes of a detection, strongest first.
ROUTES: tuple[str, ...] = ("import", "call", "file")
_RANK = {r: i for i, r in enumerate(ROUTES)}

#: Counted as notebooks: Jupyter, R Markdown, Quarto, MATLAB live scripts, Mathematica.
NOTEBOOK_EXTENSIONS: tuple[str, ...] = (".ipynb", ".rmd", ".qmd", ".mlx", ".nb")

#: Longer texts are read up to this length (the stored texts are cut at 200 KB anyway).
MAX_TEXT: int = 2_000_000

_KINDS = {"library", "toolbox", "software"}
_LISTS = ("languages", "python", "r", "matlab", "julia", "shell", "packages", "files")


# ═══ Features of a list of paths ═══════════════════════════════════════════════

#: Never counted, anywhere (archives' and editors' debris).
_JUNK_DIRS = {"__macosx", ".git", "__pycache__", ".ipynb_checkpoints"}
_JUNK_FILES = {".ds_store", "thumbs.db", "desktop.ini"}
#: Other people's code: not the authors' tests, docs or environment.
_VENDORED_DIRS = {"node_modules", "bower_components", "site-packages", ".venv", "venv",
                  "vendor", "third_party", "thirdparty", "3rdparty", "external", "externals",
                  "extern"}

_README = re.compile(r"(?i)^read[-_ ]?me(\.[\w-]+)*$")
_LICENSE = re.compile(r"(?i)^(un)?licen[cs]es?([._-][\w.-]*)?$|^copying([._-][\w.-]*)?$")
_DOC_EXTENSIONS = (".md", ".txt", ".rst", ".html", ".pdf", ".markdown", ".org", ".adoc")

_ENV_NAMES = {
    "pyproject.toml", "setup.py", "setup.cfg", "pipfile", "pipfile.lock", "poetry.lock",
    "uv.lock", "pdm.lock", "pixi.toml", "pixi.lock", "conda-lock.yml", "renv.lock",
    "packrat.lock", "install.r", "project.toml", "juliaproject.toml", "manifest.toml",
    "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
    "dockerfile", "flake.nix", "shell.nix", "spack.yaml"}
_ENV_PATTERNS = re.compile(
    r"(?i)^(requirements[\w.-]*\.(txt|in)|constraints[\w.-]*\.txt"
    r"|(environment|conda)[\w.-]*\.ya?ml|env\.ya?ml"
    r"|dockerfile\.[\w.-]+|[\w.-]+\.dockerfile)$")
_BINDER_NAMES = {"apt.txt", "runtime.txt", "postbuild"}
_CONTAINER_DIRS = re.compile(r"(?i)^(singularity|apptainer|containers?|definitions?|recipes?)$")

_TEST_DIR = re.compile(r"(?i)^(tests?|testthat|__tests__|unittests?|[\w-]+[_-]tests)$")
_TEST_RUNNER = re.compile(r"^(conftest\.py|pytest\.ini|.+\.(test|spec)\.[jt]sx?|.+_test\.go)$")
#: A test by its name only. In research code `DeLong_test.py`, `train_test.py`,
#: `test_model.py` (on the test set) or `BinomTest.m` are as often a statistical test or an
#: evaluation as a unit test: it takes a suite of them.
_TEST_NAME = re.compile(r"^(test_.+\.py|.+_test\.py|.+Tests?\.m)$")
MIN_NAMED_TESTS: int = 3
_CODE_EXTENSIONS = set(SCRIPT_EXTENSIONS) | {".pyx", ".hpp", ".cxx", ".jsx", ".tsx", ".bats"}

_CI_NAMES = {".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "jenkinsfile",
             "appveyor.yml", ".appveyor.yml", "bitbucket-pipelines.yml", ".drone.yml",
             ".woodpecker.yml"}
_CI_DIRS = {".circleci", ".buildkite", ".woodpecker"}

_DOC_DIRS = {"docs", "doc", "documentation", "vignettes"}
_DOC_NAMES = {"mkdocs.yml", "mkdocs.yaml", ".readthedocs.yml", ".readthedocs.yaml", "_quarto.yml"}

#: Scientific data formats, recordings, model weights: data rather than code.
_DATA_EXTENSIONS = frozenset("""
.mat .csv .tsv .nii .mgz .mgh .gii .dcm .ima .img .hdr .nrrd .nhdr .mnc .trk .tck .bval .bvec
.bvals .bvecs .edf .bdf .gdf .set .fdt .fif .vhdr .vmrk .eeg .cnt .xdf .sqd .con .mef .nirs
.snirf .h5 .hdf5 .hdf .he5 .nwb .nc .zarr .mda .abf .atf .smr .smrx .plx .pl2 .nev .ns1 .ns2
.ns3 .ns4 .ns5 .ns6 .continuous .spikes .events .rhd .rhs .kwik .kwd .kwx .ncs .nse .ntt .nvt
.nex .nex5 .npy .npz .pkl .pickle .joblib .parquet .feather .arrow .xlsx .xls .ods .sav .dta
.rds .rdata .rda .jld .jld2 .dat .bin .raw .tif .tiff .avi .mp4 .mov .mkv .wav .flac .ogg .pt
.pth .ckpt .onnx .safetensors .pb .keras .tflite .h5ad .loom .mtx .bam .sam .cram .bai .vcf
.bcf .bed .bedgraph .bw .bigwig .fastq .fq .fasta .fa .fna .gtf .gff .gff3 .pdb .cif .mmcif
.sdf .mol2 .xyz .dcd .xtc .trr .edat .edat2 .edat3 .textgrid .ply .obj .stl .vtk .vtp
""".split())
_COMPRESSED = (".gz", ".bz2", ".xz", ".zst")

_ARCHIVE_MEMBER = re.compile(r"(?i)^(.+?\.(?:zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|7z|rar))/(.+)$")


def features(paths: list[str]) -> dict[str, Any]:
    """The facts a repository's list of paths gives, without reading any file.

    Every key is always present:

    - `n_files`, `n_notebooks` (the NOTEBOOK_EXTENSIONS, checkpoints excluded);
    - `has_readme`, `has_citation_cff`, `has_license_file` (`LICENSE`, `COPYING`…, or a
      `LICENSES/` folder), at the root;
    - `env_files`: the dependency, environment and container files, shallowest first;
    - `has_tests`: a test folder holding code, a test runner's file (`conftest.py`,
      `pytest.ini`, `*.test.js`…), or MIN_NAMED_TESTS files named like tests (`test_*.py`,
      `*_test.py`, `*Test.m`) — one or two are as often a statistical test or an
      evaluation on the test set;
    - `has_ci`: `.github/workflows/*.yml`, `.gitlab-ci.yml`, `.travis.yml`, `.circleci/`…;
    - `has_docs`: a `docs/` or `doc/` folder, `mkdocs.yml`, R's `.Rd` pages, `vignettes/`;
    - `data_like`: the share of files in a data format (`.mat`, `.nii.gz`, `.edf`, `.csv`…).

    "At the root" means the repository's root, the single folder that holds everything
    (an archive's `project-main/`), or the root of an archive member (`code.zip/…`).
    Vendored folders (`node_modules/`, `third_party/`, `external/`…) do not make the
    authors' tests, docs or environment.
    """
    clean = _clean_paths(paths)
    kept = [p for p in clean if not _is_junk(p)]
    own = [p for p in kept if not _is_vendored(p)]
    roots = _roots(kept)

    def at_root(p: str) -> bool:
        return _parent(p) in roots

    readme = citation = license_file = tests = ci = docs = False
    env_files: list[str] = []
    notebooks = named_tests = 0
    for p in own:
        parts = p.split("/")
        base, low = parts[-1], parts[-1].lower()
        dirs = [d.lower() for d in parts[:-1]]
        ext = _extension(low)
        if ext in NOTEBOOK_EXTENSIONS:
            notebooks += 1
        if at_root(p):
            readme = readme or bool(_README.match(base))
            citation = citation or low == "citation.cff"
            license_file = license_file or bool(_LICENSE.match(base))
            ci = ci or low in _CI_NAMES
        if _is_env_file(p, base, low, dirs, roots):
            env_files.append(p)
        if _TEST_RUNNER.match(base) or ext in _CODE_EXTENSIONS and any(_TEST_DIR.match(d) for d in dirs):
            tests = True
        elif _TEST_NAME.match(base):
            named_tests += 1
        docs = docs or low in _DOC_NAMES or ext == ".rd" or any(d in _DOC_DIRS for d in dirs)
        if len(parts) >= 2:
            top = _relative_to_root(p, roots).split("/")
            ci = ci or (len(top) >= 3 and top[:2] == [".github", "workflows"]
                        and low.endswith((".yml", ".yaml"))) or top[0].lower() in _CI_DIRS
            license_file = license_file or top[0].lower() == "licenses"
    data = sum(1 for p in kept if _extension(p.lower()) in _DATA_EXTENSIONS)
    return {
        "n_files": len(clean),
        "n_notebooks": notebooks,
        "has_readme": readme,
        "has_citation_cff": citation,
        "has_license_file": license_file,
        "env_files": sorted(env_files, key=lambda p: (p.count("/"), p.lower())),
        "has_tests": tests or named_tests >= MIN_NAMED_TESTS,
        "has_ci": ci,
        "has_docs": docs,
        "data_like": round(data / len(kept), 3) if kept else 0.0,
    }


def _clean_paths(paths: Iterable[str] | None) -> list[str]:
    seen: set[str] = set()
    out = []
    for p in paths or ():
        if not isinstance(p, str):
            continue
        p = p.strip().replace("\\", "/")
        while p.startswith("./"):
            p = p[2:]
        p = p.lstrip("/")
        if not p or p.endswith("/") or p == "…" or p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _is_junk(path: str) -> bool:
    parts = path.lower().split("/")
    return parts[-1] in _JUNK_FILES or any(d in _JUNK_DIRS for d in parts[:-1])


def _is_vendored(path: str) -> bool:
    return any(d in _VENDORED_DIRS for d in path.lower().split("/")[:-1])


def _extension(name: str) -> str:
    """`.nii` for `x.nii.gz`: the extension under a compression suffix."""
    base = name.rsplit("/", 1)[-1]
    for c in _COMPRESSED:
        if base.endswith(c):
            base = base[: -len(c)]
            break
    return os.path.splitext(base)[1]


def _parent(path: str) -> str:
    return path.rsplit("/", 1)[0] + "/" if "/" in path else ""


def _roots(paths: list[str]) -> set[str]:
    roots = {""}

    def wrapper(prefix: str, members: list[str]) -> None:
        tops = {m.split("/", 1)[0] for m in members}
        if len(tops) == 1 and all("/" in m for m in members):
            roots.add(prefix + tops.pop() + "/")

    if paths:
        wrapper("", paths)
    members: dict[str, list[str]] = defaultdict(list)
    for p in paths:
        m = _ARCHIVE_MEMBER.match(p)
        if m:
            members[m.group(1) + "/"].append(m.group(2))
    for prefix, ms in members.items():
        roots.add(prefix)
        wrapper(prefix, ms)
    return roots


def _relative_to_root(path: str, roots: set[str]) -> str:
    """The path under the longest root that holds it (every path is under "")."""
    best = max((r for r in roots if path.startswith(r)), key=len)
    return path[len(best):]


def _is_env_file(path: str, base: str, low: str, dirs: list[str], roots: set[str]) -> bool:
    if low in _ENV_NAMES or base == "DESCRIPTION" or _ENV_PATTERNS.match(low):
        return True
    if dirs and dirs[-1] == "requirements" and low.endswith((".txt", ".in")):
        return True
    if ".devcontainer" in dirs:
        return True
    if (low in ("singularity", "apptainer")
            or re.match(r"^(singularity|apptainer)\.[\w.-]+$", low)
            and not low.endswith(_DOC_EXTENSIONS)):
        return True
    if low.endswith(".def") and (re.search(r"singularity|apptainer|container", low)
                                 or any(_CONTAINER_DIRS.match(d) for d in dirs)
                                 or _parent(path) in roots):
        return True
    if low in _BINDER_NAMES:
        return _parent(path) in roots or bool(dirs) and dirs[-1] in ("binder", ".binder")
    return False


# ═══ The vocabulary ═══════════════════════════════════════════════════════════

@functools.lru_cache(maxsize=1)
def vocabulary() -> tuple[dict[str, Any], ...]:
    """The tools of `vocabulary/tools.json`, as they are written there."""
    return tuple(json.loads(VOCABULARY_FILE.read_text(encoding="utf-8"))["tools"])


def check_vocabulary(tools: Iterable[dict[str, Any]]) -> list[str]:
    """What is wrong with a vocabulary: missing keys, duplicated ids, or a name (import,
    function, command, package, file pattern) that would point to two tools."""
    problems: list[str] = []
    owners: dict[tuple[str, str], str] = {}

    def claim(space: str, name: str, tool: str) -> None:
        other = owners.setdefault((space, name), tool)
        if other != tool:
            problems.append(f"{space} name {name!r} belongs to both {other!r} and {tool!r}")

    ids: set[str] = set()
    for t in tools:
        tid = t.get("id", "")
        if not isinstance(tid, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", tid):
            problems.append(f"bad id {tid!r}")
            continue
        if tid in ids:
            problems.append(f"duplicate id {tid!r}")
        ids.add(tid)
        for key in ("name", "kind", "homepage", "rrid"):
            if not isinstance(t.get(key), str):
                problems.append(f"{tid}: {key} missing")
        if t.get("kind") not in _KINDS:
            problems.append(f"{tid}: kind {t.get('kind')!r} is not one of {sorted(_KINDS)}")
        rrid = t.get("rrid", "")
        if rrid and not re.fullmatch(r"RRID:SCR_\d{6}", rrid):
            problems.append(f"{tid}: malformed RRID {rrid!r}")
        for key in _LISTS:
            v = t.get(key)
            if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
                problems.append(f"{tid}: {key} must be a list of names")
        if not any(t.get(k) for k in ("python", "r", "matlab", "julia", "shell", "packages", "files")):
            problems.append(f"{tid}: no name to recognize it by")
        for space in ("python", "r", "julia"):
            for n in t.get(space) or ():
                claim(space, n, tid)
        for n in t.get("r") or ():
            claim("r (case-insensitive)", n.lower(), tid)
        for n in t.get("matlab") or ():
            claim("matlab prefix" if n.endswith("*") else "matlab", n, tid)
        for n in t.get("shell") or ():
            claim("shell prefix" if n.endswith("*") else "shell", n, tid)
        for n in t.get("files") or ():
            claim("file pattern", n.lower(), tid)
        for n in _package_names(t):
            claim("package", n, tid)
    for (space, name), tid in owners.items():
        if space == "package" and name in ids and name != tid:
            problems.append(f"package name {name!r} of {tid!r} is the id of another tool")
    return problems


def _normalize(name: str) -> str:
    """A distribution name as PyPI compares them (PEP 503)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _package_names(tool: dict[str, Any]) -> set[str]:
    names = {_normalize(p) for p in tool.get("packages") or ()}
    names |= {_normalize(p) for p in tool.get("python") or () if "." not in p}
    return names


@dataclass(frozen=True)
class _Index:
    ids: frozenset[str]
    python: dict[str, str]
    r: dict[str, str]
    r_lower: dict[str, str]
    julia: dict[str, str]
    matlab: dict[str, str]
    matlab_prefixes: tuple[tuple[str, str], ...]
    shell: dict[str, str]
    shell_prefixes: tuple[tuple[str, str], ...]
    env: dict[str, str]
    packages: dict[str, str]
    file_patterns: tuple[tuple[str, str], ...]


@functools.lru_cache(maxsize=1)
def _index() -> _Index:
    tools = vocabulary()
    problems = check_vocabulary(tools)
    if problems:
        raise ValueError("vocabulary/tools.json: " + "; ".join(problems[:10]))
    python, r, r_lower, julia, matlab, shell, env, packages = ({} for _ in range(8))
    mprefix, sprefix, patterns = [], [], []
    for t in tools:
        tid = t["id"]
        python.update({n: tid for n in t["python"]})
        r.update({n: tid for n in t["r"]})
        r_lower.update({n.lower(): tid for n in t["r"]})
        julia.update({n: tid for n in t["julia"]})
        for n in t["matlab"]:
            if n.endswith("*"):
                mprefix.append((n[:-1], tid))
            else:
                matlab[n] = tid
        for n in t["shell"]:
            if n.startswith("$"):
                env[n[1:]] = tid
            elif n.endswith("*"):
                sprefix.append((n[:-1], tid))
            else:
                shell[n] = tid
        packages.update({n: tid for n in _package_names(t)})
        patterns += [(p.lower(), tid) for p in t["files"]]
    by_length = lambda pairs: tuple(sorted(pairs, key=lambda x: -len(x[0])))
    return _Index(frozenset(t["id"] for t in tools), python, r, r_lower, julia, matlab,
                  by_length(mprefix), shell, by_length(sprefix), env, packages, tuple(patterns))


def _lookup(name: str, exact: dict[str, str], prefixes: tuple[tuple[str, str], ...]) -> str:
    """The tool a name belongs to: an exact name first, else the longest prefix."""
    tool = exact.get(name)
    if tool:
        return tool
    for prefix, tid in prefixes:
        if name.startswith(prefix) and len(name) > len(prefix):
            return tid
    return ""


# ═══ Detection ════════════════════════════════════════════════════════════════

class _Hits(dict):
    """tool id → (route, method), keeping the strongest route; "ast" if any hit came from it."""

    def add(self, tool: str, route: str, method: str = "regex") -> None:
        if not tool:
            return
        old = self.get(tool)
        if old is None:
            self[tool] = (route, method)
            return
        best = route if _RANK[route] < _RANK[old[0]] else old[0]
        self[tool] = (best, "ast" if "ast" in (method, old[1]) else "regex")

    def merge(self, other: dict[str, tuple[str, str]], route: str | None = None) -> None:
        for tool, (r, m) in other.items():
            self.add(tool, route or r, m)


def detect_tools(files: list[tuple[str, str, str]]) -> list[dict[str, Any]]:
    """The tools a repository's stored scripts use, most evidence first.

    `files`: (path, language, text) — the rows of the `file` table; `language` as stored
    there ("Python", "Jupyter", "MATLAB"…) or empty (the extension decides). A path with
    an empty text still counts for the tools its file type belongs to (`.hoc` → NEURON).

    One dict per tool: `tool` (vocabulary id), `evidence` (number of files where it
    appears), `via` (`import`, `call` or `file`: the route of most of those files, the
    strongest on a tie), `examples` (up to 3 paths, shallowest first), and `detected_by`
    (`ast` when a parsed Python file contributed, else `regex`).
    """
    idx = _index()
    files = [(p, lang or "", _as_text(text)) for p, lang, text in files or () if p]
    paths = [p for p, _, _ in files]
    local = _Local(_local_python_modules(paths), _local_matlab_functions(paths))
    found: dict[str, dict[str, str]] = defaultdict(dict)
    parsed: dict[str, bool] = defaultdict(bool)
    for path, language, text in files:
        for tool, (route, method) in _detect_file(path, language, text, idx, local).items():
            prev = found[tool].get(path)
            if prev is None or _RANK[route] < _RANK[prev]:
                found[tool][path] = route
            parsed[tool] |= method == "ast"
    out = []
    for tool, per_file in found.items():
        routes = Counter(per_file.values())
        via = min(routes, key=lambda r: (-routes[r], _RANK[r]))
        examples = sorted(per_file, key=lambda p: (per_file[p] != via, p.count("/"), p))[:3]
        out.append({"tool": tool, "evidence": len(per_file), "via": via, "examples": examples,
                    "detected_by": "ast" if parsed[tool] else "regex"})
    out.sort(key=lambda d: (-d["evidence"], d["tool"]))
    return out


def _as_text(text: Any) -> str:
    """The text, with Unix line ends: every pattern here reads lines on `\\n` (a script
    written on Windows ends its lines with `\\r\\n`)."""
    if text is None:
        return ""
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    return str(text)[:MAX_TEXT].replace("\r\n", "\n").replace("\r", "\n")


@dataclass(frozen=True)
class _Local:
    """What the repository defines itself, and so is not a tool."""
    #: folder → the modules a script of that folder imports from beside it
    python: dict[str, frozenset[str]]
    #: the functions its .m files define
    matlab: frozenset[str]

    def python_for(self, path: str) -> frozenset[str]:
        folder, _, base = path.rpartition("/")
        return self.python.get(folder, frozenset()) - {os.path.splitext(base)[0]}


_NO_LOCAL = _Local({}, frozenset())


def _local_python_modules(paths: Iterable[str]) -> dict[str, frozenset[str]]:
    """A script imports the modules beside it (`neuron.py` next to `run.py`: `import
    neuron` is that file, not the NEURON simulator). Inside a package (a folder with an
    `__init__.py`), an import is absolute: `import cellpose` in `pkg/cellpose.py` is the
    real library."""
    py = [p for p in paths if p.lower().endswith(".py")]
    packages = {p.rpartition("/")[0] for p in py if p.rpartition("/")[2] == "__init__.py"}
    local: dict[str, set[str]] = defaultdict(set)
    for p in py:
        folder, _, base = p.rpartition("/")
        if base == "__init__.py":
            folder, _, base = folder.rpartition("/")
            base += ".py"
        if folder not in packages:
            local[folder].add(base[:-3])
    return {folder: frozenset(names) for folder, names in local.items()}


def _local_matlab_functions(paths: Iterable[str]) -> frozenset[str]:
    return frozenset(p.rpartition("/")[2][:-2] for p in paths if p.endswith(".m"))


# ─── dispatch ─────────────────────────────────────────────────────────────────

_SHELL_EXTENSIONS = {".sh", ".bash", ".zsh", ".ksh", ".csh", ".tcsh", ".slurm", ".sbatch",
                     ".pbs", ".bats"}
_SHEBANG = re.compile(r"^#![ \t]*(\S+)[ \t]*(\S*)")
_NMODL = re.compile(r"\bNEURON\s*\{")


def _file_kind(path: str, language: str, text: str) -> str:
    parts = path.split("/")
    base = parts[-1]
    low = base.lower()
    ext = os.path.splitext(low)[1]
    lang = language.lower()
    if low == "dockerfile" or low.startswith("dockerfile.") or low.endswith(".dockerfile"):
        return "docker"
    if low in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
        return "compose"
    if (low in ("singularity", "apptainer")
            or re.match(r"^(singularity|apptainer)\.[\w.-]+$", low) and not low.endswith(_DOC_EXTENSIONS)
            or ext == ".def" and re.search(r"(?im)^\s*bootstrap\s*:", text[:4000])):
        return "container"
    if (re.match(r"^(requirements[\w.-]*\.(txt|in)|constraints[\w.-]*\.txt)$", low)
            or len(parts) > 1 and parts[-2].lower() == "requirements" and ext in (".txt", ".in")):
        return "requirements"
    if re.match(r"^((environment|conda)[\w.-]*|env)\.ya?ml$", low):
        return "conda"
    if low in ("pyproject.toml", "pipfile", "pixi.toml"):
        return "pytoml"
    if low in ("project.toml", "juliaproject.toml"):
        return "julia_project"
    if low == "setup.cfg":
        return "setup_cfg"
    if low == "setup.py":
        return "setup_py"
    if base == "DESCRIPTION":
        return "description"
    if low == "apt.txt":
        return "apt"
    if ext == ".ipynb" or lang == "jupyter":
        return "notebook"
    if ext in (".rmd", ".qmd", ".rmarkdown"):
        return "rmarkdown"
    if ext in (".py", ".pyw") or lang == "python":
        return "python"
    if ext == ".r" or lang == "r":
        return "r"
    if ext == ".m" or lang == "matlab":
        return "matlab"
    if ext == ".jl" or lang == "julia":
        return "julia"
    if ext in _SHELL_EXTENSIONS or lang == "shell":
        return "shell"
    m = _SHEBANG.match(text)
    if m:
        interpreter = m.group(1).rsplit("/", 1)[-1]
        if interpreter == "env":  # #!/usr/bin/env bash
            interpreter = m.group(2)
        if re.match(r"(ba|z|k|tc|c|da)?sh$", interpreter):
            return "shell"
        if interpreter.startswith("python"):
            return "python"
        if interpreter == "Rscript":
            return "r"
    return ""


def _detect_file(path: str, language: str, text: str, idx: _Index, local: _Local = _NO_LOCAL) -> _Hits:
    hits = _Hits()
    low = path.rsplit("/", 1)[-1].lower()
    for pattern, tool in idx.file_patterns:
        if fnmatch.fnmatchcase(low, pattern):
            if pattern == "*.mod" and (low == "go.mod" or text and not _NMODL.search(text)):
                continue
            hits.add(tool, "file")
    if not text.strip():
        return hits
    kind = _file_kind(path, language, text)
    modules = local.python_for(path)
    if kind == "python":
        hits.merge(_python(text, idx, modules))
    elif kind == "notebook":
        hits.merge(_notebook(text, idx, modules))
    elif kind == "rmarkdown":
        hits.merge(_rmarkdown(text, idx, modules))
    elif kind == "r":
        hits.merge(_r(text, idx))
    elif kind == "matlab":
        hits.merge(_matlab(text, idx, local.matlab))
    elif kind == "julia":
        hits.merge(_julia(text, idx))
    elif kind == "shell":
        hits.merge(_shell(text, idx))
    elif kind == "setup_py":
        hits.merge(_python(text, idx, modules))
        hits.merge(_setup_py(text, idx), route="file")
    elif kind:
        hits.merge(_MANIFESTS[kind](text, idx), route="file")
    return hits


# ─── Python ───────────────────────────────────────────────────────────────────

_SHELL_CALLS = {"system", "popen", "run", "call", "check_call", "check_output", "Popen",
                "getoutput", "getstatusoutput"}


def _python(text: str, idx: _Index, local: frozenset[str] = frozenset()) -> _Hits:
    hits = _Hits()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            tree = None
    if tree is not None:
        _python_ast(tree, idx, local, hits)
    else:
        _python_lines(text, idx, local, hits)
    return hits


def _python_module(dotted: str, idx: _Index, local: frozenset[str], hits: _Hits,
                   method: str) -> None:
    """Every prefix of a dotted module name that the vocabulary knows: `a`, `a.b`, `a.b.c`."""
    parts = dotted.split(".")
    if not parts[0] or parts[0] in local:
        return
    for i in range(1, len(parts) + 1):
        hits.add(idx.python.get(".".join(parts[:i]), ""), "import", method)


def _python_ast(tree: ast.AST, idx: _Index, local: frozenset[str], hits: _Hits) -> None:
    shell_modules = {"os": "os", "subprocess": "subprocess"}  # local name → module
    shell_functions: set[str] = set()                            # `from subprocess import run`
    commands: dict[str, str] = {}                                # variable → command text
    calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                _python_module(a.name, idx, local, hits, "ast")
                if a.name in ("os", "subprocess"):
                    shell_modules[a.asname or a.name] = a.name
        elif isinstance(node, ast.ImportFrom):
            if node.level or not node.module:
                continue
            _python_module(node.module, idx, local, hits, "ast")
            for a in node.names:
                if a.name != "*":
                    _python_module(f"{node.module}.{a.name}", idx, local, hits, "ast")
                if node.module in ("os", "subprocess") and a.name in _SHELL_CALLS:
                    shell_functions.add(a.asname or a.name)
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            command = _python_string(node.value)
            if command:
                commands.setdefault(node.targets[0].id, command)
        elif isinstance(node, ast.Call):
            calls.append(node)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in idx.env:
            hits.add(idx.env[node.value], "call", "ast")
    for node in calls:
        func, args = node.func, node.args
        name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
        owner = func.value.id if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) else ""
        first = args[0] if args else None
        if first is None:
            continue
        if name in ("import_module", "__import__") and isinstance(first, ast.Constant) and isinstance(first.value, str):
            _python_module(first.value, idx, local, hits, "ast")
        elif name == "importr" and isinstance(first, ast.Constant) and isinstance(first.value, str):
            hits.add(idx.r.get(first.value, ""), "import", "ast")
        elif name in _SHELL_CALLS and (owner in shell_modules or (not owner and name in shell_functions)):
            command = _python_string(first)
            if not command and isinstance(first, ast.Name):
                command = commands.get(first.id, "")
            if command:
                hits.merge({t: ("call", "ast") for t in _shell(command, idx)})


def _python_string(node: ast.AST | None) -> str:
    """The literal beginning of a command: a string, an f-string's head, a list's first
    element, `"cmd %s" % x`, `"cmd {}".format(x)`, `"cmd " + x`."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, (ast.List, ast.Tuple)) and node.elts:
        return _python_string(node.elts[0])
    if isinstance(node, ast.JoinedStr):
        head = []
        for v in node.values:
            if not (isinstance(v, ast.Constant) and isinstance(v.value, str)):
                break
            head.append(v.value)
        return "".join(head)
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mod)):
        return _python_string(node.left)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        if node.func.attr == "format":
            return _python_string(node.func.value)
        if node.func.attr == "join" and node.args:  # " ".join(["fslmaths", …])
            return _python_string(node.args[0])
    return ""


_PY_IMPORT_LINE = re.compile(r"^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\s+(.*)|import\s+(.+))$")
_PY_SHELL_LINE = re.compile(
    r"\b(?:os\.system|os\.popen|subprocess\.\w+|sp\.\w+)\s*\(\s*(?:\[\s*)?[fFrRbBuU]?[\"']([^\"'\n]+)")


def _python_lines(text: str, idx: _Index, local: frozenset[str], hits: _Hits) -> None:
    """The fallback for a file `ast` cannot parse: import lines outside docstrings."""
    quote = ""
    for line in text.splitlines():
        if quote:
            if quote in line:
                quote = ""
            continue
        code = line.split("#", 1)[0]
        m = _PY_IMPORT_LINE.match(code)
        if m:
            if m.group(1):
                _python_module(m.group(1), idx, local, hits, "regex")
                for name in re.findall(r"[A-Za-z_]\w*", m.group(2).split(" as ")[0]):
                    _python_module(f"{m.group(1)}.{name}", idx, local, hits, "regex")
            else:
                for item in m.group(3).split(","):
                    name = item.strip().split(" as ")[0].strip()
                    if re.fullmatch(r"[A-Za-z_][\w.]*", name):
                        _python_module(name, idx, local, hits, "regex")
        s = _PY_SHELL_LINE.search(code)
        if s:
            hits.merge({t: ("call", "regex") for t in _shell(s.group(1), idx)})
        for q in ('"""', "'''"):
            if code.count(q) % 2 == 1:
                quote = q
                break


# ─── notebooks and R Markdown ─────────────────────────────────────────────────

_CELL_HEADER = re.compile(r"(?m)^# %%(.*)$")
_CELL_MAGIC = re.compile(r"^\s*%%(\w+)(.*)$")


def _notebook(text: str, idx: _Index, local: frozenset[str] = frozenset()) -> _Hits:
    hits = _Hits()
    cells, kernel = _notebook_cells(text)
    for source in cells:
        language, source = _cell_language(source, kernel)
        if language == "python":
            hits.merge(_python_cell(source, idx, local))
        elif language == "r":
            hits.merge(_r(source, idx))
        elif language == "julia":
            hits.merge(_julia(source, idx))
        elif language == "shell":
            hits.merge(_shell(source, idx))
    return hits


def _notebook_cells(text: str) -> tuple[list[str], str]:
    """The code cells, and the kernel's language: of an .ipynb (JSON), or of the text by
    cells (`# %%` headers) that `oscr.contents.notebook_to_text` stores."""
    if text.lstrip().startswith("{"):
        try:
            nb = json.loads(text)
        except ValueError:
            nb = None
        if isinstance(nb, dict):
            meta = nb.get("metadata") or {}
            language = str((meta.get("kernelspec") or {}).get("language")
                            or (meta.get("language_info") or {}).get("name") or "python").lower()
            raw = nb.get("cells")
            if raw is None:  # nbformat 3
                raw = [c for ws in nb.get("worksheets") or [] for c in ws.get("cells") or []]
            cells = []
            for c in raw or []:
                if not isinstance(c, dict) or c.get("cell_type") != "code":
                    continue
                source = c.get("source", c.get("input", ""))
                cells.append("".join(source) if isinstance(source, list) else str(source))
            return cells, language
    cells, pos, is_code = [], 0, True
    for m in _CELL_HEADER.finditer(text):
        if is_code:
            cells.append(text[pos:m.start()])
        is_code = "[markdown]" not in m.group(1) and "[raw]" not in m.group(1)
        pos = m.end()
    if is_code:
        cells.append(text[pos:])
    return cells, _sniff_language("\n".join(cells))


def _sniff_language(code: str) -> str:
    python = len(re.findall(r"(?m)^\s*(?:import\s+\w|from\s+[\w.]+\s+import\b)", code))
    r = len(re.findall(r"(?m)^\s*(?:library|require)\s*\(|<-", code))
    julia = len(re.findall(r"(?m)^\s*using\s+[A-Z]", code))
    if r > python and r >= julia:
        return "r"
    if julia > python:
        return "julia"
    return "python"


def _cell_language(source: str, kernel: str) -> tuple[str, str]:
    m = _CELL_MAGIC.match(source.lstrip("\n").split("\n", 1)[0])
    kernel = {"ir": "r", "r": "r", "julia": "julia", "bash": "shell", "sh": "shell"}.get(kernel, kernel)
    if not m:
        return (kernel if kernel in ("python", "r", "julia", "shell") else "python"), source
    body = source.lstrip("\n").split("\n", 1)[1] if "\n" in source.lstrip("\n") else ""
    magic, rest = m.group(1).lower(), m.group(2)
    if magic == "r":
        return "r", body
    if magic in ("bash", "sh", "shell") or magic == "script" and re.search(r"\b(ba|z)?sh\b", rest):
        return "shell", body
    if magic == "julia":
        return "julia", body
    if magic in ("time", "timeit", "capture", "prun", "writefile", "debug", "px"):
        return "python", body
    return "", ""


def _python_cell(source: str, idx: _Index, local: frozenset[str]) -> _Hits:
    """A Python cell: `!cmd` lines are shell, `%pip install` lines declare packages, other
    line magics are dropped before parsing."""
    hits = _Hits()
    lines = []
    for line in source.split("\n"):
        s = line.lstrip()
        if s.startswith("!"):
            hits.merge(_shell(s[1:], idx))
            lines.append("")
        elif s.startswith("%"):
            m = re.match(r"%(pip|conda|mamba)\s+install\s+(.*)", s)
            if m:
                hits.merge(_installed(m.group(1), m.group(2).split(), idx))
            lines.append("")
        else:
            lines.append(line)
    hits.merge(_python("\n".join(lines), idx, local))
    return hits


_CHUNK = re.compile(r"(?ms)^[ \t]*```+[ \t]*\{[ \t]*([A-Za-z]+)[^}\n]*\}[ \t]*\n(.*?)^[ \t]*```+[ \t]*$")


def _rmarkdown(text: str, idx: _Index, local: frozenset[str] = frozenset()) -> _Hits:
    hits = _Hits()
    for m in _CHUNK.finditer(text):
        engine, body = m.group(1).lower(), m.group(2)
        if engine == "r":
            hits.merge(_r(body, idx))
        elif engine == "python":
            hits.merge(_python(body, idx, local))
        elif engine in ("bash", "sh"):
            hits.merge(_shell(body, idx))
        elif engine == "julia":
            hits.merge(_julia(body, idx))
    return hits


# ─── lexing: comments out, strings aside ──────────────────────────────────────

_PLACEHOLDER = re.compile(r"\x02(\d+)\x03")


def _lex(text: str, pattern: re.Pattern[str]) -> tuple[str, list[str]]:
    """Comments dropped (their line breaks kept), each string literal replaced by
    `\\x02k\\x03`, `k` its index in the returned list of contents. The pattern names its
    alternatives `comment` and `string`."""
    out, strings, pos = [], [], 0
    for m in pattern.finditer(text):
        out.append(text[pos:m.start()])
        if m.group("string") is not None:
            strings.append(_unquote(m.group("string")))
            out.append(f"\x02{len(strings) - 1}\x03")
        else:
            out.append("\n" * m.group(0).count("\n"))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out), strings


def _unquote(literal: str) -> str:
    m = re.match(r"""^[rR](["'])(-*)[(\[{](.*)[)\]}]\2\1$""", literal, re.S)
    if m:
        return m.group(3)
    for q in ('"""', "'''"):
        if len(literal) >= 6 and literal.startswith(q) and literal.endswith(q):
            return literal[3:-3]
    return literal[1:-1]


def _strings_in(code: str, strings: list[str]) -> list[str]:
    return [strings[int(k)] for k in _PLACEHOLDER.findall(code)]


def _env_hits(strings: Iterable[str], idx: _Index, hits: _Hits) -> None:
    for s in strings:
        if s in idx.env:
            hits.add(idx.env[s], "call")


# ─── R ────────────────────────────────────────────────────────────────────────

_R_LEX = re.compile(r"""(?P<comment>\#[^\n]*)|(?P<string>[rR]["'](-*)(?:\(.*?\)|\[.*?\]|\{.*?\})\3["']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""", re.S)
_R_NAME = r"[A-Za-z][\w.]*"
_R_ARG = rf"(?:({_R_NAME})|\x02(\d+)\x03)"
_R_LOAD = re.compile(rf"(?<![\w.])(?:library|require|requireNamespace|loadNamespace)\s*\(\s*(?:package\s*=\s*)?{_R_ARG}([^()\n]*)")
_R_NAMESPACE = re.compile(rf"(?<![\w.])({_R_NAME})\s*:::?(?=\s*[A-Za-z._`])")
_R_PLOAD = re.compile(r"(?<![\w.])p_load\s*\(([^()]*)\)")
_R_VECTOR = re.compile(rf"(?<![\w.])({_R_NAME})\s*(?:<-|=)\s*c\s*\(([^()]*)\)")
_R_LOAD_VECTOR = re.compile(
    rf"(?<![\w.])(?:lapply|sapply|vapply|map|walk)\s*\(\s*(?:c\s*\(([^()]*)\)|({_R_NAME}))\s*,\s*"
    r"(?:FUN\s*=\s*)?(?:library|require|requireNamespace)\b"
    rf"|p_load\s*\(\s*char\s*=\s*({_R_NAME})"
    rf"|for\s*\(\s*\w+\s+in\s+({_R_NAME})\s*\)\s*\{{?[^}}]*?(?:library|require)\s*\(\s*\w+\s*,\s*character\.only")
_R_INSTALL = re.compile(
    rf"(?<![\w.])(?:install\.packages|BiocManager\s*::\s*install|biocLite|(?:(?:remotes|devtools|pak)\s*::\s*)?"
    rf"(?:install_github|install_gitlab|install_bitbucket|install_cran|install_bioc|pkg_install))"
    rf"\s*\(\s*(?:pkgs\s*=\s*)?(?:c\s*\(([^()]*)\)|\x02(\d+)\x03|(?:setdiff\s*\(\s*)?({_R_NAME}))")
_R_SYSTEM = re.compile(rf"(?<![\w.])system2?\s*\(\s*(?:(?:paste0?|sprintf|glue)\s*\(\s*)?(?:\x02(\d+)\x03|({_R_NAME})\s*[,)])")
_R_COMMAND_VAR = re.compile(rf"(?<![\w.])({_R_NAME})\s*(?:<-|=)\s*(?:(?:paste0?|sprintf|glue)\s*\(\s*)?\x02(\d+)\x03")
_ROXYGEN = re.compile(r"(?m)^\s*#'\s*@import(?:From)?\s+([A-Za-z][\w.]*)")


def _r(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    for name in _ROXYGEN.findall(text):
        hits.add(idx.r.get(name, ""), "import")
    code, strings = _lex(text, _R_LEX)

    def name_of(ident: str | None, k: str | None) -> str:
        return ident if ident else strings[int(k)] if k is not None else ""

    for m in _R_LOAD.finditer(code):
        if m.group(1) and "character.only" in m.group(3):
            continue  # library(pkg, character.only = TRUE): `pkg` is a variable
        hits.add(idx.r.get(name_of(m.group(1), m.group(2)), ""), "import")
    for m in _R_NAMESPACE.finditer(code):
        hits.add(idx.r.get(m.group(1), ""), "import")
    for m in _R_PLOAD.finditer(code):
        for item in m.group(1).split(","):
            item = item.strip()
            s = _PLACEHOLDER.fullmatch(item)
            name = strings[int(s.group(1))] if s else item if re.fullmatch(_R_NAME, item) else ""
            hits.add(idx.r.get(name, ""), "import")
    vectors = {m.group(1): _strings_in(m.group(2), strings) for m in _R_VECTOR.finditer(code)}
    for m in _R_LOAD_VECTOR.finditer(code):
        names = (_strings_in(m.group(1), strings) if m.group(1) is not None
                 else vectors.get(m.group(2) or m.group(3) or m.group(4) or "", []))
        for name in names:
            hits.add(idx.r.get(name, ""), "import")
    for m in _R_INSTALL.finditer(code):
        names = (_strings_in(m.group(1), strings) if m.group(1) is not None
                 else [strings[int(m.group(2))]] if m.group(2) is not None
                 else vectors.get(m.group(3) or "", []))
        for name in names:
            name = name.split("@")[0].rstrip("/").rsplit("/", 1)[-1]
            hits.add(idx.r.get(name, ""), "file")
    commands = {m.group(1): strings[int(m.group(2))] for m in _R_COMMAND_VAR.finditer(code)}
    for m in _R_SYSTEM.finditer(code):
        command = strings[int(m.group(1))] if m.group(1) is not None else commands.get(m.group(2) or "", "")
        if command:
            hits.merge({t: ("call", "regex") for t in _shell(command, idx)})
    _env_hits(strings, idx, hits)
    return hits


# ─── MATLAB ───────────────────────────────────────────────────────────────────

_M_TOKEN = re.compile(r"""(?P<block>^[ \t]*%\{[ \t]*\n.*?^[ \t]*%\}[ \t]*$)|(?P<comment>%[^\n]*)|(?P<cont>\.\.\.[^\n]*\n?)|(?P<dq>"(?:[^"\n]|"")*")|(?P<sq>'(?:[^'\n]|'')*')""", re.M | re.S)
_M_IDENT = re.compile(r"(?<![\w.])([A-Za-z]\w*)")
_M_ASSIGNED = re.compile(
    r"(?<![\w.])([A-Za-z]\w*)\s*(?:(?:\([^()=\n]*(?:\([^()=\n]*\)[^()=\n]*)*\)|\{[^{}=\n]*\})\s*)*"
    r"(?:\.\s*\(?[A-Za-z]\w*\)?\s*(?:(?:\([^()=\n]*\)|\{[^{}=\n]*\})\s*)*)*=(?!=)")
_M_MULTI = re.compile(r"\[([^\[\]=\n]*)\]\s*=(?!=)")
_M_FUNCTION = re.compile(r"(?m)^[ \t]*function\b([^\n]*)")
_M_SIGNATURE = re.compile(r"^\s*(?:\[([^\]]*)\]\s*=\s*|([A-Za-z]\w*)\s*=\s*)?([A-Za-z][\w.]*)\s*(?:\(([^)]*)\))?")
_M_DECLARED = re.compile(r"(?m)^[ \t]*(?:global|persistent)[ \t]+([A-Za-z][\w \t]*)|^[ \t]*catch[ \t]+([A-Za-z]\w*)")
_M_SYSTEM = re.compile(r"(?<![\w.])(?:system|unix|dos)\s*\(\s*(?:(?:sprintf|strcat|horzcat)\s*\(\s*|\[\s*)?(?:\x02(\d+)\x03|([A-Za-z]\w*)\s*[,)])")
_M_COMMAND_VAR = re.compile(r"(?<![\w.])([A-Za-z]\w*)\s*=\s*(?:(?:sprintf|strcat|horzcat)\s*\(\s*|\[\s*)?\x02(\d+)\x03")
_M_BANG = re.compile(r"(?m)^[ \t]*!([^\n]*)")
#: Recognized by their shape rather than by a function name.
_M_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bmatlabbatch\s*\{[^{}\n]*\}\s*\.\s*spm\s*\."), "spm"),
    (re.compile(r"\bBATCH\s*\.\s*(?:Setup|Denoising|Analysis|Preprocessing)\s*\."), "conn"),
)


def _matlab_lex(text: str) -> tuple[str, list[str]]:
    """MATLAB comments out (`%`, `%{ … %}`, `...`), strings aside; a quote that follows
    an identifier, a number, a closing bracket or a dot is a transpose, not a string."""
    out, strings, pos = [], [], 0
    while True:
        m = _M_TOKEN.search(text, pos)
        if not m:
            break
        start = m.start()
        if m.group("sq") is not None and start > 0 and (text[start - 1].isalnum()
                                                         or text[start - 1] in "_)]}.'"):
            out.append(text[pos:start + 1])
            pos = start + 1
            continue
        out.append(text[pos:start])
        if m.group("dq") is not None or m.group("sq") is not None:
            literal = m.group(0)
            strings.append(literal[1:-1].replace(literal[0] * 2, literal[0]))
            out.append(f"\x02{len(strings) - 1}\x03")
        elif m.group("cont") is not None:
            out.append(" ")
        else:
            out.append("\n" * m.group(0).count("\n"))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out), strings


#: MathWorks products: a function of theirs that the repository defines itself (its own
#: `nanmean.m`) shadows the product's. A third-party toolbox copied into the repository
#: (BCT, CircStat, the NIfTI tools) is still that toolbox.
_MATHWORKS = "matlab-"


def _matlab(text: str, idx: _Index, own_functions: frozenset[str] = frozenset()) -> _Hits:
    hits = _Hits()
    code, strings = _matlab_lex(text)
    variables: set[str] = set()
    defined: set[str] = set()
    for m in _M_FUNCTION.finditer(code):
        s = _M_SIGNATURE.match(m.group(1))
        if s:
            defined.add(s.group(3).rsplit(".", 1)[-1])
            for group in (s.group(1), s.group(2), s.group(4)):
                variables.update(re.findall(r"[A-Za-z]\w*", group or ""))
    variables.update(m.group(1) for m in _M_ASSIGNED.finditer(code))
    for m in _M_MULTI.finditer(code):
        variables.update(re.findall(r"[A-Za-z]\w*", m.group(1)))
    for m in _M_DECLARED.finditer(code):
        variables.update(re.findall(r"[A-Za-z]\w*", m.group(1) or m.group(2) or ""))
    variables -= {"function", "end", "for", "if", "while", "global", "persistent"}
    for m in _M_IDENT.finditer(code):
        name = m.group(1)
        tool = _lookup(name, idx.matlab, idx.matlab_prefixes)
        if (not tool or name in variables or name in defined
                or tool.startswith(_MATHWORKS) and name in own_functions):
            continue
        if _matlab_is_call(code, m.start(), m.end()):
            hits.add(tool, "call")
    for pattern, tool in _M_PATTERNS:
        if pattern.search(code):
            hits.add(tool if tool in idx.ids else "", "call")
    commands = {m.group(1): strings[int(m.group(2))] for m in _M_COMMAND_VAR.finditer(code)}
    shell_lines = [m.group(1) for m in _M_BANG.finditer(code)]
    for m in _M_SYSTEM.finditer(code):
        shell_lines.append(strings[int(m.group(1))] if m.group(1) is not None
                           else commands.get(m.group(2) or "", ""))
    for line in shell_lines:
        if line:
            hits.merge({t: ("call", "regex") for t in _shell(line, idx)})
    _env_hits(strings, idx, hits)
    return hits


_M_OPEN = str.maketrans("", "", "([{")
_M_CLOSE = str.maketrans("", "", ")]}")


def _matlab_is_call(code: str, start: int, end: int) -> bool:
    """Is the identifier at code[start:end] called? `name(…)`, a command (`ft_defaults;`,
    `eeglab nogui`), a bare right-hand side (`t = GetSecs;`), a handle (`@ft_x`). Not a
    field (`x.ft_y`), an assignment, a cell index, or a word inside an argument list."""
    after = code[end:end + 80].lstrip(" \t")
    nxt = after[:1]
    if nxt == "(":
        return True
    if nxt == "{" or nxt == "=" and after[1:2] != "=" or nxt == "." and after[1:2].isalpha():
        return False
    line = code[max(0, start - 400):start].rsplit("\n", 1)[-1]
    before = line.rstrip(" \t")
    prev = before[-1:]
    if prev == "@":
        return True
    ends_statement = nxt in ("", ";", ",", "\n")
    if prev in ("", ";", ","):
        # a comma separates statements only outside brackets: `a, b` but not `f(a, b)`
        depth = len(line) - len(line.translate(_M_OPEN)) - (len(line) - len(line.translate(_M_CLOSE)))
        if depth > 0:
            return False
        command_syntax = code[end:end + 1] in (" ", "\t") and bool(re.match(r"[A-Za-z0-9_\-]", nxt))
        return ends_statement or command_syntax
    if prev == "=" and before[-2:-1] not in ("=", "<", ">", "~"):
        return ends_statement
    return False


# ─── Julia ────────────────────────────────────────────────────────────────────

_JL_LEX = re.compile(r'''(?P<comment>\#=.*?=\#|\#[^\n]*)|(?P<string>"""(?:[^"\\]|\\.|"(?!""))*"""|"(?:[^"\\\n]|\\.)*")''', re.S)
_JL_USING = re.compile(r"(?m)^[ \t]*(?:@everywhere[ \t]+)?(?:using|import)[ \t]+([^\n;]+)")
_JL_ADD = re.compile(r"\bPkg\s*\.\s*add\s*\(\s*(\[[^\]]*\]|\x02\d+\x03)")


def _julia(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    code, strings = _lex(text, _JL_LEX)
    for m in _JL_USING.finditer(code):
        items = m.group(1).split(":", 1)[0] if ":" in m.group(1) else m.group(1)
        for item in items.split(","):
            name = item.strip().split(".")[0].split(" ")[0]
            if name:
                hits.add(idx.julia.get(name, ""), "import")
    for m in _JL_ADD.finditer(code):
        for name in _strings_in(m.group(1), strings):
            hits.add(idx.julia.get(name, ""), "file")
    return hits


# ─── Shell ────────────────────────────────────────────────────────────────────

_SH_LEX = re.compile(r"""(?P<comment>(?<![^\s;&|()])\#[^\n]*)|(?P<sq>'[^']*')|(?P<dq>"(?:[^"\\]|\\.)*")|(?P<bq>`(?:[^`\\]|\\.)*`)""", re.S)
#: Where a simple command ends. A brace group is `{ cmd; }`, with spaces: `{out_dir}` (a
#: template's placeholder, `find -exec … {}`) stays a word.
_SH_SPLIT = re.compile(r"\n|;;?|&&|\|\||\||&|\(|\)|\{(?=\s)|(?<=[\s;])\}"
                       r"|(?<![\w$.-])(?:then|do|else|elif|if|while|until|!)(?![\w.-])")
_SH_ASSIGN = re.compile(r"^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=")
_SH_ENV = re.compile(r"\$\{?([A-Za-z_]\w*)|(?:^|[\s;])(?:export\s+)?([A-Za-z_]\w*)=", re.M)
#: Words that run the next word as a command; their options are skipped.
_SH_WRAPPERS = {"sudo", "nohup", "time", "exec", "command", "builtin", "env", "nice", "ionice",
                "stdbuf", "timeout", "srun", "mpirun", "mpiexec", "xargs", "parallel", "caffeinate",
                "eval", "then", "do", "else"}
_SH_INTERPRETERS = {"bash", "sh", "zsh", "tcsh", "csh", "ksh", "source", "."}
_SH_CONTAINERS = {"docker", "podman", "singularity", "apptainer"}
_SH_INSTALLERS = {"pip", "pip3", "conda", "mamba", "micromamba", "apt-get", "apt", "yum", "dnf",
                  "module", "ml", "uv", "spack"}


def _shell(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    text = re.sub(r"\\\r?\n", " ", text)
    code, strings = _shell_lex(text)
    for m in _SH_ENV.finditer(code):
        hits.add(idx.env.get(m.group(1) or m.group(2), ""), "call")
    code = re.sub(r"\$\{([A-Za-z_]\w*)[^}\n]*\}", r"$\1", code)
    for segment in _SH_SPLIT.split(code):
        _shell_segment(segment.split(), strings, idx, hits)
    return hits


def _shell_lex(text: str) -> tuple[str, list[str]]:
    """Comments out; quoted strings aside, except the commands they substitute (`$(…)`,
    backquotes), which stay code."""
    out, strings, pos = [], [], 0
    for m in _SH_LEX.finditer(text):
        out.append(text[pos:m.start()])
        literal = m.group(0)
        if m.group("comment") is not None:
            pass
        elif m.group("bq") is not None:
            out.append(" (" + literal[1:-1] + ") ")
        else:
            strings.append(literal[1:-1])
            out.append(f"\x02{len(strings) - 1}\x03")
            if m.group("dq") is not None:
                out.extend(" (" + inner + ") " for inner in _substitutions(literal[1:-1]))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out), strings


def _substitutions(s: str) -> list[str]:
    """The `$(…)` and backquoted commands inside a double-quoted string."""
    found, i = [], 0
    while True:
        i = s.find("$(", i)
        if i < 0:
            break
        if s.startswith("$((", i):  # arithmetic, not a command
            i += 3
            continue
        depth, j = 1, i + 2
        while j < len(s) and depth:
            depth += {"(": 1, ")": -1}.get(s[j], 0)
            j += 1
        found.append(s[i + 2:j - 1])
        i = j
    found += re.findall(r"`([^`]*)`", s)
    return found


def _shell_word(token: str, strings: list[str]) -> str:
    m = _PLACEHOLDER.fullmatch(token)
    return strings[int(m.group(1))] if m else token


def _shell_segment(tokens: list[str], strings: list[str], idx: _Index, hits: _Hits) -> None:
    """One simple command: its command word, after assignments and wrappers (`sudo`,
    `nohup`, `srun -c 4`…)."""
    i = 0
    while i < len(tokens) and (_SH_ASSIGN.match(tokens[i]) or tokens[i] in _SH_WRAPPERS):
        wrapper = tokens[i] in _SH_WRAPPERS
        i += 1
        while wrapper and i < len(tokens) and (tokens[i].startswith("-") or _SH_ASSIGN.match(tokens[i])
                                               or re.fullmatch(r"\d+[smhd]?", tokens[i])):
            i += 1
    if i >= len(tokens):
        return
    word = _shell_word(tokens[i], strings)
    if word != tokens[i] and re.search(r"\s", word.strip()):
        hits.merge(_shell(word, idx))  # eval "fslmaths $a …": the string is the command
        return
    command = word.rsplit("/", 1)[-1]
    rest = tokens[i + 1:]
    hits.add(_lookup(command, idx.shell, idx.shell_prefixes), "call")
    words = [_shell_word(t, strings) for t in rest]
    python = bool(re.fullmatch(r"python[\d.]*", command))
    if command in _SH_INTERPRETERS and words:
        if words[0] == "-c" and len(words) > 1:  # bash -c "…"
            hits.merge(_shell(words[1], idx))
        else:                                   # bash antsRegistrationSyN.sh …
            hits.add(_lookup(words[0].rsplit("/", 1)[-1], idx.shell, idx.shell_prefixes), "call")
    elif command in _SH_CONTAINERS:
        _container_command(words, idx, hits)
    elif command in _SH_INSTALLERS or python and words[:2] == ["-m", "pip"]:
        _install_line(command, words, idx, hits)
    elif command in ("Rscript", "R") and "-e" in words[:-1]:
        hits.merge(_r(words[words.index("-e") + 1], idx))
    elif python and "-c" in words[:-1]:
        hits.merge(_python(words[words.index("-c") + 1], idx))
    for k, token in enumerate(rest):
        if token in ("-exec", "-execdir") and k + 1 < len(rest):  # find … -exec fslmaths {} …
            _shell_segment(rest[k + 1:], strings, idx, hits)
            break


def _install_line(command: str, words: list[str], idx: _Index, hits: _Hits) -> None:
    """`pip install …`, `python -m pip install …`, `uv pip install …`, `conda install|create …`,
    `apt-get install …`, `module load …`, `ml …`."""
    if command.startswith("python"):
        command, words = "pip", words[2:]
    if command == "uv" and words[:1] == ["pip"]:
        command, words = "pip", words[1:]
    if command == "ml" and words[:1] not in (["load"], ["add"]):
        words = ["load"] + words  # `ml fsl` is `module load fsl`
    verbs = (["load"], ["add"]) if command in ("module", "ml") else (["install"], ["create"], ["add"])
    if words[:1] in verbs:
        hits.merge(_installed(command, words[1:], idx))


def _container_command(words: list[str], idx: _Index, hits: _Hits) -> None:
    """`docker run … nipreps/fmriprep …`, `singularity exec fsl.sif bet …`: the image, and
    the program run inside it."""
    for word in words:
        if word.startswith("-"):
            continue
        tool = _image_tool(word, idx)
        if tool:
            hits.add(tool, "call")
            continue
        hits.add(idx.shell.get(word.rsplit("/", 1)[-1], ""), "call")


def _image_tool(ref: str, idx: _Index) -> str:
    """A container image or image file: `nipreps/fmriprep:23.1`, `ghcr.io/x/y`,
    `fmriprep-20.2.0.simg`."""
    ref = ref.strip("\"'")
    if ref.startswith(("docker://", "library://", "shub://", "oras://")):
        ref = ref.split("://", 1)[1]
    base = ref.rsplit("/", 1)[-1].lower()
    if base.endswith((".sif", ".simg", ".img")):
        stem = re.split(r"[-_:.]", base, maxsplit=1)[0]
        return idx.packages.get(_normalize(stem), "")
    parts = ref.split("@")[0].split("/")
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost"):
        parts = parts[1:]  # the registry: ghcr.io/, docker.io/, localhost:5000/
    parts[-1] = parts[-1].split(":")[0]  # the tag
    name = "/".join(parts).lower()
    return idx.packages.get(name, "") if "/" in name else ""


# ─── package names in dependency files ────────────────────────────────────────

def _package_tool(name: str, idx: _Index) -> str:
    """The tool a distribution name belongs to: PyPI and conda names, conda's `r-x` and
    `bioconductor-x`, Debian's `python3-x`, `r-cran-x`, `r-bioc-x`."""
    name = name.strip().strip("\"'")
    if not name:
        return ""
    low = name.lower()
    for prefix in ("r-cran-", "r-bioc-", "bioconductor-", "r-"):
        if low.startswith(prefix) and low[len(prefix):] in idx.r_lower:
            return idx.r_lower[low[len(prefix):]]
    for prefix in ("python3-", "python-", "py-"):
        if low.startswith(prefix) and _normalize(low[len(prefix):]) in idx.packages:
            return idx.packages[_normalize(low[len(prefix):])]
    return idx.packages.get(_normalize(name), "")


_REQUIREMENT_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _requirement_name(spec: str) -> str:
    """`mne>=1.0; python_version>"3.8"` → mne; `x @ git+…` → x; `git+https://…/fooof.git`
    → fooof; `…#egg=name` → name."""
    spec = spec.strip()
    egg = re.search(r"[#&]egg=([A-Za-z0-9._-]+)", spec)
    if egg:
        return egg.group(1)
    if re.match(r"^[\w+.-]+://|^git@", spec):
        path = spec.split("://", 1)[-1].split("#")[0].split("@")[0].rstrip("/")
        return re.sub(r"\.git$", "", path.rsplit("/", 1)[-1])
    m = _REQUIREMENT_NAME.match(spec)
    return m.group(1) if m else ""


def _installed(manager: str, args: list[str], idx: _Index) -> _Hits:
    """Packages named on an install line (`pip install`, `conda install`, `apt-get
    install`, `module load`): declared, so the route is `file`."""
    hits = _Hits()
    skip_next = False
    for a in args:
        if skip_next:
            skip_next = False
            continue
        if a.startswith("-"):
            skip_next = a in ("-c", "--channel", "-n", "--name", "-p", "--prefix", "-r",
                              "--requirement", "-e", "--editable", "-i", "--index-url",
                              "--extra-index-url", "-f", "--find-links", "--target", "-t")
            continue
        name = a.split("/")[0] if manager in ("module", "ml") else _requirement_name(a.split("::")[-1])
        hits.add(_package_tool(name, idx), "file")
    return hits


def _requirements(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    for line in text.splitlines():
        line = re.split(r"\s#", line, maxsplit=1)[0].strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(("-e ", "--editable")):
            line = line.split(None, 1)[1] if " " in line else ""
        elif line.startswith("-"):
            continue
        hits.add(_package_tool(_requirement_name(line), idx), "file")
    return hits


def _conda(text: str, idx: _Index) -> _Hits:
    """A conda environment: the items under `dependencies:` (and its `pip:` list)."""
    hits = _Hits()
    section = ""
    for line in text.splitlines():
        if re.match(r"^[A-Za-z_][\w-]*\s*:", line):
            section = line.split(":", 1)[0].strip().lower()
            continue
        m = re.match(r"^\s*-\s*([^\s#]+)", line)
        if section != "dependencies" or not m or m.group(1).endswith(":"):
            continue
        item = m.group(1).strip("\"'").split("::")[-1]
        name = _requirement_name(re.split(r"[=<>!~ ]", item, maxsplit=1)[0] if "://" not in item else item)
        hits.add(_package_tool(name, idx), "file")
    return hits


def _pytoml(text: str, idx: _Index) -> _Hits:
    """pyproject.toml (PEP 621, Poetry, dependency groups), Pipfile, pixi.toml."""
    hits = _Hits()
    try:
        data = tomllib.loads(text)
    except (tomllib.TOMLDecodeError, ValueError):
        return hits
    specs: list[str] = []
    project = data.get("project") or {}
    specs += _string_list(project.get("dependencies"))
    for group in (project.get("optional-dependencies") or {}).values():
        specs += _string_list(group)
    for group in (data.get("dependency-groups") or {}).values():
        specs += _string_list(group)
    specs += _string_list((data.get("build-system") or {}).get("requires"))
    poetry = (data.get("tool") or {}).get("poetry") or {}
    tables = [poetry.get("dependencies"), poetry.get("dev-dependencies"),
              data.get("packages"), data.get("dev-packages"), data.get("dependencies"),
              data.get("pypi-dependencies")]
    tables += [g.get("dependencies") for g in (poetry.get("group") or {}).values() if isinstance(g, dict)]
    for table in tables:
        if isinstance(table, dict):
            specs += list(table)
    for spec in specs:
        hits.add(_package_tool(_requirement_name(spec), idx), "file")
    return hits


def _string_list(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def _julia_project(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    try:
        deps = tomllib.loads(text).get("deps") or {}
    except (tomllib.TOMLDecodeError, ValueError):
        return hits
    for name in deps:
        hits.add(idx.julia.get(name, ""), "file")
    return hits


def _setup_py(text: str, idx: _Index) -> _Hits:
    """The `install_requires`, `extras_require`… of a setup.py."""
    hits = _Hits()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            tree = ast.parse(text)
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            tree = None
    specs: list[str] = []
    if tree is not None:
        for node in ast.walk(tree):
            if isinstance(node, ast.keyword) and node.arg in (
                    "install_requires", "requires", "setup_requires", "tests_require", "extras_require"):
                specs += [n.value for n in ast.walk(node.value)
                          if isinstance(n, ast.Constant) and isinstance(n.value, str)]
    else:
        for m in re.finditer(r"install_requires\s*=\s*\[([^\]]*)\]", text):
            specs += re.findall(r"[\"']([^\"']+)[\"']", m.group(1))
    for spec in specs:
        hits.add(_package_tool(_requirement_name(spec), idx), "file")
    return hits


def _setup_cfg(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        parser.read_string(text)
    except configparser.Error:
        return hits
    values = []
    if parser.has_option("options", "install_requires"):
        values.append(parser.get("options", "install_requires"))
    if parser.has_section("options.extras_require"):
        values += [v for _, v in parser.items("options.extras_require")]
    for value in values:
        for spec in re.split(r"[\n;]", value):
            if spec.strip():
                hits.add(_package_tool(_requirement_name(spec), idx), "file")
    return hits


def _description(text: str, idx: _Index) -> _Hits:
    """An R package's DESCRIPTION: Depends, Imports, Suggests, LinkingTo."""
    hits = _Hits()
    for m in re.finditer(r"(?ms)^(?:Depends|Imports|Suggests|LinkingTo|Enhances)\s*:(.*?)(?=^\S|\Z)", text):
        for item in m.group(1).split(","):
            name = re.sub(r"\(.*?\)", "", item, flags=re.S).strip()
            hits.add(idx.r.get(name, ""), "file")
    return hits


def _apt(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            hits.add(_package_tool(line, idx), "file")
    return hits


def _dockerfile(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    text = re.sub(r"\\\r?\n", " ", text)
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        instruction, _, rest = s.partition(" ")
        instruction = instruction.upper()
        if instruction == "FROM":
            words = [w for w in rest.split() if not w.startswith("--")]
            if words:
                hits.add(_image_tool(words[0], idx), "file")
        elif instruction in ("RUN", "CMD", "ENTRYPOINT"):
            body = rest.strip()
            if body.startswith("["):
                try:
                    body = " ".join(str(x) for x in json.loads(body))
                except ValueError:
                    pass
            hits.merge(_shell(body, idx))
        elif instruction == "ENV":
            for name in re.findall(r"(?:^|\s)([A-Za-z_]\w*)(?:=|\s)", " " + rest):
                hits.add(idx.env.get(name, ""), "file")
        elif instruction == "COPY":
            m = re.search(r"--from=(\S+)", rest)
            if m:
                hits.add(_image_tool(m.group(1), idx), "file")
    return hits


def _compose(text: str, idx: _Index) -> _Hits:
    hits = _Hits()
    for m in re.finditer(r"(?m)^\s*image\s*:\s*[\"']?([^\s\"'#]+)", text):
        hits.add(_image_tool(m.group(1), idx), "file")
    return hits


def _container(text: str, idx: _Index) -> _Hits:
    """An Apptainer/Singularity definition: its base image and its sections' commands."""
    hits = _Hits()
    for m in re.finditer(r"(?im)^\s*from\s*:\s*(\S+)", text):
        hits.add(_image_tool(m.group(1), idx), "file")
    body = "\n".join(line for line in text.splitlines()
                     if not re.match(r"^\s*(%\w+|[A-Za-z]+\s*:)", line))
    hits.merge(_shell(body, idx))
    return hits


_MANIFESTS = {
    "docker": _dockerfile, "compose": _compose, "container": _container,
    "requirements": _requirements, "conda": _conda, "pytoml": _pytoml,
    "julia_project": _julia_project, "setup_cfg": _setup_cfg, "description": _description,
    "apt": _apt,
}
