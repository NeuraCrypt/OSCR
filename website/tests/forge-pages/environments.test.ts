// The environment a release carries, read as text (night phase 07, E6; src/lib/environments.ts): the
// files found, what each says in words (pins, lock files, images by digest, what runs at build or on
// the machine that opens it), where it runs (Binder, Codespaces: who runs it), the packages declared.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  environmentFiles,
  imagePin,
  installLine,
  isPackageName,
  openElsewhere,
  packagesOf,
  parseDcf,
  parseJsonc,
  parseToml,
  pipRequirement,
  readEnvironment,
  readRequirements,
  registryUrl,
} from "../../src/lib/environments.ts";

const words = (r: ReturnType<typeof readEnvironment>) => r.checks.map((c) => `${c.tone}: ${c.words}`);

test("the environment files of a tree, where Binder and the containers look, in order", () => {
  const files = environmentFiles([
    "README.md",
    "requirements.txt",
    "requirements-dev.txt",
    "environment.yml",
    "binder/postBuild",
    "binder/apt.txt",
    ".devcontainer/devcontainer.json",
    ".devcontainer/gpu/devcontainer.json",
    "Dockerfile",
    "src/requirements.txt",
    "renv.lock",
    "DESCRIPTION",
    "pyproject.toml",
    "poetry.lock",
    "Project.toml",
    "Manifest.toml",
    "setup.py",
    "docs/environment.yml",
  ]);
  assert.deepEqual(files.map((f) => `${f.kind}:${f.path}`), [
    "conda:environment.yml",
    "pip:requirements-dev.txt",
    "pip:requirements.txt",
    "lock:poetry.lock",
    "renv:renv.lock",
    "r-description:DESCRIPTION",
    "julia-project:Project.toml",
    "julia-manifest:Manifest.toml",
    "pyproject:pyproject.toml",
    "docker:Dockerfile",
    "devcontainer:.devcontainer/devcontainer.json",
    "devcontainer:.devcontainer/gpu/devcontainer.json",
    "apt:binder/apt.txt",
    "script:binder/postBuild",
    "script:setup.py",
  ]);
});

describe("pip", () => {
  test("pins, ranges, none, sources, hashes, included files", () => {
    assert.deepEqual(pipRequirement("numpy==1.26.4  # the paper's"), { name: "numpy", pin: "exact", spec: "==1.26.4" });
    assert.deepEqual(pipRequirement("scipy>=1.11,<1.12"), { name: "scipy", pin: "range", spec: ">=1.11,<1.12" });
    assert.deepEqual(pipRequirement("mne[hdf5]"), { name: "mne", pin: "none", spec: "" });
    assert.equal(pipRequirement("numpy==1.*")?.pin, "range");
    assert.equal(pipRequirement("-e git+https://github.com/x/y.git#egg=ytool")?.pin, "source");
    assert.equal(pipRequirement("tool @ https://example.org/tool-1.0.tar.gz")?.name, "tool");
    assert.equal(pipRequirement("--index-url https://pypi.org/simple"), null);
    const r = readRequirements("-r base.txt\nnumpy==1.26.4 \\\n    --hash=sha256:abc\nscipy\n");
    assert.deepEqual(r.includes, ["base.txt"]);
    assert.equal(r.hashes, true);
    assert.deepEqual(r.reqs.map((x) => [x.name, x.pin]), [["numpy", "exact"], ["scipy", "none"]]);
  });

  test("in words: all pinned is ok; otherwise said, with the unversioned named; addresses masked", () => {
    const all = readEnvironment({ path: "requirements.txt", kind: "pip" }, "numpy==1.26.4\nscipy==1.11.4\n");
    assert.deepEqual(words(all), ["ok: Every package is pinned to an exact version (2)."]);
    const some = readEnvironment({ path: "requirements.txt", kind: "pip" }, "# ask ada@example.org\nnumpy==1.26.4\nscipy>=1.11\nmatplotlib\n");
    assert.deepEqual(words(some), ["warning: 1 of the 3 packages pinned to an exact version; the others may resolve to newer versions than the paper's.", "warning: No version at all for matplotlib."]);
    assert.equal(some.summary, "pip's requirements: 3 packages");
  });
});

test("conda: the Python version, conda's and pip's packages, the channels", () => {
  const r = readEnvironment(
    { path: "environment.yml", kind: "conda" },
    "name: eeg\nchannels:\n  - conda-forge\ndependencies:\n  - python=3.11\n  - numpy=1.26.4\n  - scipy=1.11.4\n  - matplotlib>=3.8\n  - pip\n  - pip:\n      - mne==1.6.0\n",
  );
  assert.equal(r.summary, "a conda environment (eeg): 5 conda packages and 1 from pip, from conda-forge");
  assert.deepEqual(words(r), [": Python 3.11.", "warning: 4 of the 5 packages pinned to an exact version; the others may resolve to newer versions than the paper's."]);
  const defaults = readEnvironment({ path: "environment.yml", kind: "conda" }, "dependencies:\n  - numpy\n");
  assert.ok(words(defaults).some((w) => /default channel/.test(w)));
});

test("lock files, renv, Julia: pinned in words", () => {
  const renv = readEnvironment({ path: "renv.lock", kind: "renv" }, JSON.stringify({ R: { Version: "4.3.2" }, Packages: { ggplot2: { Package: "ggplot2", Version: "3.4.4" } } }));
  assert.equal(renv.summary, "R's renv lock file: R 4.3.2, 1 packages");
  assert.deepEqual(words(renv), ["ok: A lock file: every package's version is pinned."]);
  const julia = readEnvironment({ path: "Project.toml", kind: "julia-project" }, 'name = "EEGTools"\nversion = "0.2.0"\n[deps]\nDSP = "717857b8-e6f2-59f4-9121-6e50c889abd2"\nFFTW = "7a1cc6ca-52ef-59f5-83cd-3a7055c09341"\n[compat]\nDSP = "0.7"\njulia = "1.9"\n');
  assert.equal(julia.summary, "a Julia project (EEGTools): 2 dependencies");
  assert.deepEqual(words(julia), [": Julia 1.9.", "warning: Compatibility bounds for 1 of the 2 dependencies; a Manifest.toml pins them exactly."]);
  assert.deepEqual(words(readEnvironment({ path: "poetry.lock", kind: "lock" }, "")), ["ok: poetry.lock: every version is pinned."]);
});

test("containers: the base image by digest or by tag; network fetches and pipes to a shell; never built", () => {
  const pinned = readEnvironment({ path: "Dockerfile", kind: "docker" }, `FROM python:3.11-slim@sha256:${"4".repeat(64)}\nRUN pip install -r requirements.txt\n`);
  assert.deepEqual(words(pinned), ["ok: The base image is pinned by its digest: the same image, always."]);
  const risky = readEnvironment({ path: "Dockerfile", kind: "docker" }, "FROM ubuntu AS build\nFROM build\nADD https://example.org/tool.tgz /opt/\nRUN curl -fsSL https://get.example.org | sh\nRUN pip install numpy\n");
  assert.deepEqual(words(risky), [
    "warning: The base image (ubuntu) has no version (“latest” is whatever it is on the day it is pulled).",
    "warning: It adds a file from an address at build: what is there may change.",
    "warning: It runs a script fetched from the network at build: read it first; it is not pinned.",
    ": 1 pip install names packages in the Dockerfile itself: check their versions there.",
  ]);
  assert.deepEqual(imagePin("ghcr.io/lab/eeg:1.0"), { image: "ghcr.io/lab/eeg:1.0", pin: "tag" });
  assert.equal(imagePin("localhost:5000/x").pin, "latest");
  const dev = readEnvironment({ path: ".devcontainer/devcontainer.json", kind: "devcontainer" }, '{\n  // a comment\n  "name": "eeg", "image": "mcr.microsoft.com/devcontainers/python:3.11",\n  "features": {"ghcr.io/devcontainers/features/r:1": {}},\n  "postCreateCommand": "pip install -r requirements.txt",\n}\n');
  assert.equal(dev.summary, "a development container (eeg): the image mcr.microsoft.com/devcontainers/python:3.11");
  assert.ok(words(dev).some((w) => /runs commands on the machine that opens it \(postCreateCommand\)/.test(w)));
  assert.ok(words(dev).some((w) => /named by a tag/.test(w)));
  assert.deepEqual(words(readEnvironment({ path: "x/devcontainer.json", kind: "devcontainer" }, "{ not json")), ["warning: It could not be read as JSON."]);
});

test("scripts are named, never read as code", () => {
  const r = readEnvironment({ path: "setup.py", kind: "script" }, "import os\nos.system('rm -rf /')\n");
  assert.match(r.summary, /read as text only, never run/);
  assert.deepEqual(r.requirements, []);
});

test("where it runs: Binder when it has a file Binder reads, Codespaces always, each saying who runs it", () => {
  const repo = { owner: "oscr-fixture", name: "eeg-analysis" };
  const out = openElsewhere(repo, "v1.1.0-rc.1", environmentFiles(["environment.yml", ".devcontainer/devcontainer.json"]));
  assert.deepEqual(out.map((o) => [o.service, o.url]), [
    ["Binder", "https://mybinder.org/v2/gh/oscr-fixture/eeg-analysis/v1.1.0-rc.1"],
    ["GitHub Codespaces", "https://codespaces.new/oscr-fixture/eeg-analysis/tree/v1.1.0-rc.1"],
  ]);
  assert.match(out[0].who, /free public service.*The registry runs nothing/);
  assert.match(out[1].who, /your own GitHub account.*development container/);
  assert.deepEqual(openElsewhere(repo, "paper/v1", []).map((o) => o.url), ["https://codespaces.new/oscr-fixture/eeg-analysis/tree/paper/v1"]);
});

test("the packages the manifests declare: their registry, their page, an install line at the version", () => {
  const pkgs = packagesOf([
    { path: "pyproject.toml", kind: "pyproject", text: '[project]\nname = "eeg-tools"\nversion = "1.2.0"\ndependencies = [\n  "numpy>=1.26",\n  "scipy",\n]\n' },
    { path: "DESCRIPTION", kind: "r-description", text: "Package: eegR\nVersion: 0.3.1\nTitle: EEG\nImports: signal,\n    ggplot2 (>= 3.4)\n" },
    { path: "Project.toml", kind: "julia-project", text: 'name = "EEGTools"\nversion = "0.2.0"\n' },
    { path: "package.json", kind: "npm", text: '{"name": "internal", "private": true}' },
    { path: "recipe/meta.yaml", kind: "conda-recipe", text: 'package:\n  name: eeg-tools\n  version: "1.2.0"\n' },
    { path: "setup.cfg", kind: "setupcfg", text: "[metadata]\nname = eeg-tools\n" },
  ]);
  assert.deepEqual(pkgs.map((p) => [p.registry, p.name, p.version, p.source]), [
    ["pypi", "eeg-tools", "1.2.0", "pyproject.toml"],
    ["cran", "eegR", "0.3.1", "DESCRIPTION"],
    ["julia", "EEGTools", "0.2.0", "Project.toml"],
    ["conda-forge", "eeg-tools", "1.2.0", "recipe/meta.yaml"],
  ]);
  assert.deepEqual(pkgs.map(installLine), [
    "pip install eeg-tools==1.2.0",
    'remotes::install_version("eegR", version = "0.3.1")',
    'using Pkg; Pkg.add(name = "EEGTools", version = "0.2.0")',
    "conda install -c conda-forge eeg-tools=1.2.0",
  ]);
  assert.deepEqual(pkgs.map(registryUrl), ["https://pypi.org/project/eeg-tools/", "https://cran.r-project.org/package=eegR", "https://juliahub.com/ui/Packages/General/EEGTools", "https://anaconda.org/conda-forge/eeg-tools"]);
  assert.equal(registryUrl({ registry: "npm", name: "@lab/eeg" }), "https://www.npmjs.com/package/@lab/eeg");
  for (const bad of ["", "a b", "../x", "x".repeat(300), "a@b"]) assert.ok(!isPackageName("pypi", bad), bad);
});

test("the small readers: TOML, DCF, JSONC", () => {
  const t = parseToml('title = "x" # c\n[tool.poetry.dependencies]\npython = "^3.11"\nnumpy = "1.26.4"\n[project]\nclassifiers = [\n "a",\n "b" ]\n');
  assert.equal(t[""].title, "x");
  assert.equal(t["tool.poetry.dependencies"].numpy, "1.26.4");
  assert.deepEqual(t.project.classifiers, ["a", "b"]);
  assert.deepEqual(parseDcf("Package: x\nDepends: R (>= 4.0),\n  methods\n"), { Package: "x", Depends: "R (>= 4.0), methods" });
  assert.deepEqual(parseJsonc('{"a": "// not a comment", /* c */ "b": [1,],}'), { a: "// not a comment", b: [1] });
});
