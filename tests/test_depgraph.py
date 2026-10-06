"""The dependency graph parser (night phase 11, E1; oscr/depgraph.py). Pure, no I/O."""
from __future__ import annotations

from oscr import depgraph as dg


def names(nodes, ecosystem=None):
    return sorted(n.name for n in nodes if ecosystem is None or n.ecosystem == ecosystem)


def find(nodes, name, ecosystem=None):
    for n in nodes:
        if n.name == name and (ecosystem is None or n.ecosystem == ecosystem):
            return n
    raise AssertionError(f"{name} not found")


def test_requirements_pin_and_range():
    deps = dg.parse_file("requirements.txt",
                         "numpy==1.26.0\nscipy>=1.10 ; python_version>'3.8'\n# a comment\n-r other.txt\nmne[hdf5]~=1.5\n")
    g = dg.merge(deps)
    assert names(g) == ["mne", "numpy", "scipy"]
    assert find(g, "numpy").version == "1.26.0" and find(g, "numpy").pinned
    assert find(g, "scipy").constraint.startswith(">=1.10") and not find(g, "scipy").pinned
    assert find(g, "mne").constraint == "~=1.5"


def test_requirements_url():
    g = dg.graph({"requirements.txt": "git+https://github.com/x/fooof.git@main#egg=fooof\n"})
    assert names(g) == ["fooof"]
    assert find(g, "fooof").ecosystem == "PyPI"


def test_pyproject_pep621_and_groups():
    text = (
        "[project]\nname='x'\ndependencies=['requests>=2','rich']\n"
        "[project.optional-dependencies]\nplot=['matplotlib']\n"
        "[dependency-groups]\ndev=['pytest>=8']\n"
        "[build-system]\nrequires=['hatchling']\n"
    )
    g = dg.graph({"pyproject.toml": text})
    assert find(g, "requests").scope == "runtime"
    assert find(g, "matplotlib").scope == "optional"
    assert find(g, "pytest").scope == "dev"
    assert find(g, "hatchling").scope == "build"


def test_pyproject_poetry():
    text = ("[tool.poetry.dependencies]\npython='^3.11'\nnumpy='^1.26'\n"
            "[tool.poetry.group.dev.dependencies]\npytest='*'\n")
    g = dg.graph({"pyproject.toml": text})
    assert "python" not in names(g)
    assert find(g, "numpy").constraint == "^1.26"
    assert find(g, "pytest").scope == "dev"


def test_conda_with_pip():
    text = ("name: env\ndependencies:\n  - python=3.11\n  - numpy=1.26.0\n  - pip\n  - pip:\n"
            "    - torch==2.1.0\n")
    g = dg.graph({"environment.yml": text})
    assert find(g, "numpy", "conda").version == "1.26.0"
    assert find(g, "torch", "PyPI").version == "2.1.0"


def test_r_description_and_renv():
    desc = "Package: x\nImports:\n    dplyr,\n    ggplot2 (>= 3.0)\nSuggests: testthat\n"
    renv = '{"Packages": {"dplyr": {"Package": "dplyr", "Version": "1.1.4"}}}'
    g = dg.graph({"DESCRIPTION": desc, "renv.lock": renv})
    assert find(g, "ggplot2").constraint == ">= 3.0"
    assert find(g, "testthat").scope == "optional"
    dplyr = find(g, "dplyr")
    assert dplyr.version == "1.1.4" and dplyr.direct  # manifest + lock merged


def test_julia_project_and_manifest():
    proj = '[deps]\nDataFrames = "a93c6f00-1111"\n[compat]\nDataFrames = "1.6"\n'
    manifest = '[[deps.DataFrames]]\nversion = "1.6.1"\n'
    g = dg.graph({"Project.toml": proj, "Manifest.toml": manifest})
    df = find(g, "DataFrames", "Julia")
    assert df.constraint == "1.6" and df.version == "1.6.1" and df.direct


def test_npm_package_and_lock():
    pkg = '{"dependencies": {"lodash": "^4.17.21"}, "devDependencies": {"jest": "29.0.0"}}'
    lock = ('{"lockfileVersion": 3, "packages": {"": {}, "node_modules/lodash": {"version": "4.17.21"},'
            ' "node_modules/jest": {"version": "29.0.0"}}}')
    g = dg.graph({"package.json": pkg, "package-lock.json": lock})
    lodash = find(g, "lodash", "npm")
    assert lodash.version == "4.17.21" and lodash.constraint == "^4.17.21" and lodash.direct
    assert find(g, "jest", "npm").scope == "dev"


def test_yarn_and_pnpm_lock():
    yarn = 'lodash@^4.17.21:\n  version "4.17.21"\n  resolved "https://..."\n'
    pnpm = "packages:\n  /lodash@4.17.21:\n    resolution: {integrity: sha}\n"
    g1 = dg.graph({"yarn.lock": yarn})
    assert find(g1, "lodash", "npm").version == "4.17.21"
    g2 = dg.graph({"pnpm-lock.yaml": pnpm})
    assert find(g2, "lodash", "npm").version == "4.17.21"


def test_github_actions():
    wf = "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./local\n"
    g = dg.graph({".github/workflows/ci.yml": wf})
    assert names(g, "Actions") == ["actions/checkout"]
    assert find(g, "actions/checkout").scope == "actions"


def test_poetry_and_uv_lock_transitive():
    poetry = '[[package]]\nname = "idna"\nversion = "3.6"\ncategory = "main"\n'
    uv = '[[package]]\nname = "urllib3"\nversion = "2.1.0"\n'
    g = dg.graph({"poetry.lock": poetry, "uv.lock": uv})
    assert find(g, "idna").version == "3.6" and not find(g, "idna").direct
    assert find(g, "urllib3").version == "2.1.0"


def test_source_precedence_and_paths():
    g = dg.graph({"pyproject.toml": "[project]\ndependencies=['requests>=2']\n",
                  "uv.lock": '[[package]]\nname = "requests"\nversion = "2.31.0"\n'})
    req = find(g, "requests")
    assert req.version == "2.31.0" and req.constraint == ">=2" and req.direct
    assert req.sources[0] == "pyproject.toml" and "uv.lock" in req.sources


def test_summary_counts():
    g = dg.graph({"requirements.txt": "numpy==1.26.0\nscipy\n"})
    s = dg.summary(g)
    assert s["total"] == 2 and s["pinned"] == 1 and s["direct"] == 2


def test_malformed_never_raises():
    assert dg.parse_file("pyproject.toml", "this is : not ][ toml") == []
    assert dg.parse_file("package.json", "{not json") == []
    assert dg.parse_file("unknown.cfg", "x") == []


def test_is_manifest():
    assert dg.is_manifest("src/requirements-dev.txt")
    assert dg.is_manifest(".github/workflows/test.yaml")
    assert not dg.is_manifest("README.md")
