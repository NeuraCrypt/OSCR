// What the fake GitHub holds for night phase 02 (code navigation): the fixture study's repository
// grows the files a researcher's code has (scripts the tracing map points to, a notebook, a table,
// figures, Markdown with math, a citation file, an EditorConfig, a file with a bidirectional
// character) and some history (two more commits, a tag, a branch whose name holds "/"), so that
// the local run and the screenshots show every kind of view. Development data only.
import type { GitSession } from "./../../worker/forge/gitbackend.ts";
import type * as T from "./../../worker/forge/types.ts";
import { deflateSync } from "node:zlib";

const te = new TextEncoder();

/** A small PNG (a grey gradient with a band), made here: no binary file in the repository. */
export function gradientPng(width = 96, height = 48): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(te.encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * (1 + width * 3) + 1 + x * 3;
      const band = x > width * 0.35 && x < width * 0.5;
      const v = Math.round(230 - (160 * x) / width);
      raw.set(band ? [31, 59, 77] : [v, v, Math.min(255, v + 15)], i);
    }
  }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    total.set(p, at);
    at += p.length;
  }
  return total;
}

const ANALYSIS_V1 = `"""Spectral analysis of the resting-state EEG (the fixture study, doi:10.5555/oscr.fixture.1)."""
import numpy as np
from scipy.signal import welch


def band_power(x, fs, lo=8.0, hi=12.0):
    """Mean power in the band [lo, hi] Hz, by Welch's method."""
    f, pxx = welch(x, fs=fs, nperseg=2 * fs)
    band = (f >= lo) & (f <= hi)
    return np.trapz(pxx[band], f[band])


def alpha_ratio(eyes_closed, eyes_open, fs):
    return band_power(eyes_closed, fs) / band_power(eyes_open, fs)
`;

const ANALYSIS_V2 = ANALYSIS_V1.replace(
  "def alpha_ratio(eyes_closed, eyes_open, fs):\n    return band_power(eyes_closed, fs) / band_power(eyes_open, fs)\n",
  "def alpha_ratio(eyes_closed, eyes_open, fs, lo=8.0, hi=12.0):\n    \"\"\"The alpha ratio of the paper's Figure 2.\"\"\"\n    closed = band_power(eyes_closed, fs, lo, hi)\n    return closed / band_power(eyes_open, fs, lo, hi)\n",
);

const PLOT = `import matplotlib.pyplot as plt


def show(freqs, power, band=(8, 12)):
    plt.semilogy(freqs, power)
    plt.axvspan(*band, alpha=0.2)
    plt.xlabel("Frequency (Hz)")
    plt.show()
`;

const README = `# eeg-analysis

The code of the fixture study (doi:10.5555/oscr.fixture.1): preprocessing, epochs and statistics.

> [!NOTE]
> The band power follows Welch's method, as in the paper's Methods.

## Running it

Run \`python analysis/preprocess.py\`, then:

\`\`\`python
from analysis import band_power
power = band_power(x, fs=256)
\`\`\`

The alpha ratio is $r = P_{\\alpha}^{closed} / P_{\\alpha}^{open}$, with

$$P = \\int_{8}^{12} S(f)\\, df$$

| file | what |
|:---|---:|
| [analysis.py](analysis.py) | spectra |
| [plot.py](plot.py) | the figure |

- [x] preprocessing
- [ ] statistics

![The spectrum](figures/spectrum.png)
[![A badge](https://img.shields.io/badge/licence-MIT-green)](https://opensource.org/licenses/MIT)

Contact: ada.fixture@example.org. See also arXiv:2101.00001 and ORCID 0000-0002-1825-0097.
`;

const NOTEBOOK = (png: string) =>
  JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# Figure 1\n", "\n", "The power spectrum of one subject; the $\\alpha$ band (8–12 Hz) is shaded."] },
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          source: ["from analysis import band_power\n", "print(round(band_power(x, fs=256), 3))"],
          outputs: [{ output_type: "stream", name: "stdout", text: ["0.412\n"] }],
        },
        {
          cell_type: "code",
          execution_count: 2,
          metadata: {},
          source: ["show(f, pxx)"],
          outputs: [
            { output_type: "display_data", metadata: {}, data: { "image/png": png, "text/plain": ["<Figure size 640x480>"] } },
            { output_type: "display_data", metadata: {}, data: { "text/html": ["<script>alert('never runs')</script><b>table</b>"], "text/plain": ["   subject  alpha\n0        1   0.41"] } },
          ],
        },
        {
          cell_type: "code",
          execution_count: 3,
          metadata: {},
          source: ["1 / 0"],
          outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"] }],
        },
      ],
    },
    null,
    1,
  );

const CSV = "subject,age,alpha_closed,alpha_open\n1,24,0.412,0.201\n2,31,0.388,0.215\n3,27,\"0.5, approx.\",0.190\n4,45,0.301,0.188\n";

const METHODS = `# Methods

## Spectral analysis

Power was estimated with Welch's method [^1]; the ratio is

\`\`\`math
r = \\frac{P_{closed}}{P_{open}}
\`\`\`

<details>
<summary>Parameters</summary>

Segments of \`2 * fs\` samples, Hann window.

</details>

[^1]: Welch, P. (1967). doi:10.1109/TAU.1967.1161901
`;

const CITATION = `cff-version: 1.2.0
message: "If you use this software, please cite it as below."
title: "eeg-analysis: the code of the fixture study"
version: 1.0.0
date-released: 2026-09-01
doi: 10.5555/oscr.fixture.code
license: MIT
authors:
  - family-names: Fixture
    given-names: Ada
    orcid: "https://orcid.org/0000-0002-1825-0097"
  - name: "The Fixture Lab"
preferred-citation:
  type: article
  title: "Resting-state alpha in the fixture study"
  doi: 10.5555/oscr.fixture.1
  journal: "Journal of Fixtures"
  year: 2026
  authors:
    - family-names: Fixture
      given-names: Ada
`;

const SPECTRUM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="#fff"/><rect x="80" y="10" width="40" height="100" fill="#dde6ee"/><polyline fill="none" stroke="#1f3b4d" stroke-width="2" points="10,20 40,45 70,60 95,30 110,35 130,70 170,85 230,100"/><script>alert("never runs in an img")</script></svg>`;

/** Adds phase 02's files and history to the fixture study's repository. */
export async function seedCodeTour(org: GitSession, repo: T.RepoRef): Promise<void> {
  const png = gradientPng();
  const pngB64 = Buffer.from(png).toString("base64");
  const head = await org.git.resolve(repo, "main");
  await org.git.createCommit(repo, {
    branch: "main",
    expectedHead: head,
    message: "Add the paper's scripts, a notebook, the data and the figures\n\nSigned-off-by: Ada Fixture <ada.fixture@example.org>",
    changes: [
      { op: "put", path: "analysis.py", content: te.encode(ANALYSIS_V1) },
      { op: "put", path: "plot.py", content: te.encode(PLOT) },
      { op: "put", path: "README.md", content: te.encode(README) },
      { op: "put", path: "notebooks/figure1.ipynb", content: te.encode(NOTEBOOK(pngB64)) },
      { op: "put", path: "data/subjects.csv", content: te.encode(CSV) },
      { op: "put", path: "docs/methods.md", content: te.encode(METHODS) },
      { op: "put", path: "figures/spectrum.png", content: png },
      { op: "put", path: "figures/pipeline.svg", content: te.encode(SPECTRUM_SVG) },
      { op: "put", path: "CITATION.cff", content: te.encode(CITATION) },
      { op: "put", path: ".editorconfig", content: te.encode("root = true\n[*.py]\nindent_size = 4\n[Makefile]\ntab_width = 8\n") },
      { op: "put", path: "tools/access.py", content: te.encode(`def is_admin(level):\n    # Check the level ${String.fromCodePoint(0x202e)} ${String.fromCodePoint(0x2066)}\n    return level == "admin"\n`) },
    ],
  });
  const v1 = await org.git.resolve(repo, "main");
  await org.git.createTag(repo, { name: "v1.0", sha: v1, message: "The version of the paper" });
  await org.git.createCommit(repo, {
    branch: "main",
    expectedHead: v1,
    message: "Pass the band to alpha_ratio (the paper's Figure 2)",
    changes: [
      { op: "put", path: "analysis.py", content: te.encode(ANALYSIS_V2) },
      { op: "put", path: "data/subjects.csv", content: te.encode(`${CSV}5,52,0.296,0.201\n`) },
    ],
  });
  const v2 = await org.git.resolve(repo, "main");
  await org.git.createBranch(repo, "feature/epochs-v2", v2);
}

/** Phase 04: a pull request from a fork, reviewed, with a suggestion and a reply, what the pull
 *  request pages show (the screenshots), and a CODEOWNERS file. Bob forks the study's repository
 *  and proposes a Hann window in band_power (the lines the paper's map links: its Methods'
 *  paragraph); Ada, who owns the Python files, suggests a change; Bob answers. Returns the numbers. */
export async function seedPulls(ada: GitSession, bob: GitSession, repo: T.RepoRef): Promise<{ issue: number; pull: number }> {
  const main = await ada.git.resolve(repo, "main");
  await ada.git.createCommit(repo, {
    branch: "main",
    expectedHead: main,
    message: "Name the owners of the analysis code",
    changes: [{ op: "put", path: ".github/CODEOWNERS", content: te.encode("# The analysis code's owners\n*.py @ada-fixture\ndocs/ @ada-fixture\n") }],
  });
  const issue = await ada.issues.create(repo, { title: "band_power ignores the window the Methods name", body: "The Methods use a Hann window; the code relies on SciPy's default." });
  const { repo: fork } = await bob.repos.fork(repo);
  const base = await bob.git.resolve(fork.ref, "main");
  const current = new TextDecoder().decode((await bob.git.readFile(fork.ref, base, "analysis.py")).bytes);
  const changed = current.replace(
    '    """Mean power in the band [lo, hi] Hz, by Welch\'s method."""\n    f, pxx = welch(x, fs=fs, nperseg=2 * fs)\n',
    '    """Mean power in the band [lo, hi] Hz, by Welch\'s method with a Hann window."""\n    f, pxx = welch(x, fs=fs, nperseg=2 * fs, window="hann")\n',
  );
  await bob.git.createCommit(fork.ref, { branch: "hann-window", expectedHead: null, createFrom: base, message: "Use a Hann window in band_power, as the Methods say", changes: [{ op: "put", path: "analysis.py", content: te.encode(changed) }] });
  const pull = await bob.pulls.create(repo, {
    title: "Use a Hann window in band_power",
    head: `${fork.ref.owner}:hann-window`,
    base: "main",
    body: `Fixes #${issue.number}.\n\nWelch's method with the Hann window the paper's Methods name, rather than SciPy's default.\n\n- [x] The tests pass.\n- [ ] The alpha ratio of Figure 2 checked again.`,
    maintainerCanModify: true,
  });
  const head = (await ada.pulls.get(repo, pull.number)).head.sha;
  const line = changed.split("\n").findIndex((l) => l.includes('window="hann"')) + 1;
  await ada.pulls.review(repo, pull.number, {
    event: "COMMENT",
    commit: head,
    body: "Thank you. One suggestion, so that the window is said where it is used.",
    comments: [{ path: "analysis.py", line, side: "RIGHT", body: 'Say which paragraph this follows:\n```suggestion\n    f, pxx = welch(x, fs=fs, nperseg=2 * fs, window="hann")  # Methods, spectral analysis\n```' }],
  });
  const first = (await ada.pulls.comments(repo, pull.number)).items[0];
  await bob.pulls.reply(repo, pull.number, first.id, "Good idea: apply it when you merge.");
  await ada.issues.comment(repo, pull.number, "The paper's Figure 2 uses band_power: this changes a line its tracing map links. I will re-run the figure before merging.");
  return { issue: issue.number, pull: pull.number };
}

/** Phase 05: the issues the issue pages show (the screenshots): GitHub's default labels and the
 *  research ones, a milestone for the journal's revision, an issue with a task list, a reaction, a
 *  comment and a sub-issue, pinned; one closed as completed, one as not planned. Returns the
 *  numbers. */
export async function seedIssues(ada: GitSession, bob: GitSession, repo: T.RepoRef): Promise<{ figure: number; docs: number; question: number }> {
  for (const [name, color, description] of [
    ["bug", "d73a4a", "Something isn't working"],
    ["documentation", "0075ca", "Improvements or additions to documentation"],
    ["good first issue", "7057ff", "Good for newcomers"],
    ["question", "d876e3", "Further information is requested"],
    ["data", "1d76db", "The data the code reads or writes"],
    ["environment", "fbca04", "Versions, packages, the system the code runs on"],
    ["numerical difference", "e99695", "Results differ from the paper's numbers"],
  ] as const) {
    await ada.issues.createLabel(repo, { name, color, description }).catch(() => undefined);
  }
  const revision = await ada.issues.createMilestone(repo, { title: "Revision for the journal", description: "What the reviewers asked before the paper's second version.", dueOn: "2026-12-01T00:00:00Z" });
  const figure = await bob.issues.create(repo, {
    title: "Figure 2's alpha ratio differs with SciPy 1.14",
    body: "Running `python plot.py` with SciPy 1.14 gives an alpha ratio of 0.31 for subject 3, where the paper's Figure 2 shows 0.29.\n\n- [x] Checked with the paper's data\n- [ ] Tried SciPy 1.11, the version of the paper\n- [ ] Compared the Welch parameters",
  });
  await ada.issues.update(repo, figure.number, { labels: ["numerical difference", "environment"], milestone: revision.number, assignees: ["ada-fixture"], type: "Bug" });
  await ada.issues.react(repo, { issue: figure.number }, "eyes");
  await ada.issues.comment(repo, figure.number, "Thank you. SciPy changed Welch's default detrending in 1.12; the paper used 1.11. I will pin the version in the environment file.");
  const pin = await ada.issues.create(repo, { title: "Pin SciPy to the paper's version", body: "The environment file names `scipy==1.11.4`." });
  await ada.issues.update(repo, pin.number, { labels: ["environment"], milestone: revision.number });
  await ada.issues.addSubIssue(repo, figure.number, pin.number);
  await ada.issues.pin(repo, figure.number, true);
  const docs = await ada.issues.create(repo, { title: "Document the preprocessing parameters", body: "The band-pass edges and the epoch length, in the README." });
  await ada.issues.update(repo, docs.number, { labels: ["documentation", "good first issue"] });
  await ada.issues.update(repo, docs.number, { state: "closed", stateReason: "completed" });
  const question = await bob.issues.create(repo, { title: "Will there be a Docker image?", body: "It would help to run the analysis as it was." });
  await ada.issues.update(repo, question.number, { labels: ["question"], state: "closed", stateReason: "not_planned" });
  await ada.issues.comment(repo, question.number, "Not planned: the environment file and the lock file are enough to run it as it was.");
  return { figure: figure.number, docs: docs.number, question: question.number };
}

const ENVIRONMENT_YML = `name: eeg-analysis
channels:
  - conda-forge
dependencies:
  - python=3.11
  - numpy=1.26.4
  - scipy=1.11.4
  - matplotlib>=3.8
  - pip
  - pip:
      - mne==1.6.0
`;

const REQUIREMENTS = `# The paper's environment (pip)
numpy==1.26.4
scipy>=1.11,<1.12
matplotlib
mne==1.6.0
`;

const DOCKERFILE = `FROM python:3.11-slim@sha256:${"4".repeat(64)}
WORKDIR /study
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "plot.py"]
`;

const DEVCONTAINER = `{
  // The study's development container
  "name": "eeg-analysis",
  "image": "mcr.microsoft.com/devcontainers/python:3.11",
  "postCreateCommand": "pip install -r requirements.txt"
}
`;

const RELEASE_YML = `changelog:
  exclude:
    labels:
      - ignore-for-release
  categories:
    - title: Changes that affect the results
      labels:
        - numerical difference
    - title: Environment
      labels:
        - environment
    - title: Other changes
      labels:
        - "*"
`;

/** Phase 07: the releases the release pages show (the screenshots) and the environment files a release
 *  carries: the paper's version on the existing tag v1.0, published, with its notes and a file (the
 *  source data of Figure 2); the environment files and the notes' configuration committed; a
 *  pre-release for the journal's revision at the new head; and a draft, seen only by the people who may
 *  push. Returns their tags. */
export async function seedReleases(ada: GitSession, repo: T.RepoRef): Promise<{ published: string; prerelease: string; draft: string }> {
  const published = await ada.releases.create(repo, {
    tagName: "v1.0",
    name: "The code of the published paper",
    body: "The version of the code the paper's **Figures 1 and 2** were made with.\n\n## How to run it\n\n```\nconda env create -f environment.yml\npython plot.py\n```\n\nThe source data of Figure 2 is attached below.",
    makeLatest: true,
  });
  const data = te.encode("subject,alpha_ratio\n1,2.05\n2,1.80\n3,0.29\n4,1.60\n");
  await ada.releases.uploadAsset(repo, published.id, { name: "figure-2-source-data.csv", label: "Source data of Figure 2", contentType: "text/csv", size: data.length, body: data });
  const head = await ada.git.resolve(repo, "main");
  await ada.git.createCommit(repo, {
    branch: "main",
    expectedHead: head,
    message: "Pin the environment of the paper (conda, pip, a container)",
    changes: [
      { op: "put", path: "environment.yml", content: te.encode(ENVIRONMENT_YML) },
      { op: "put", path: "requirements.txt", content: te.encode(REQUIREMENTS) },
      { op: "put", path: "Dockerfile", content: te.encode(DOCKERFILE) },
      { op: "put", path: ".devcontainer/devcontainer.json", content: te.encode(DEVCONTAINER) },
      { op: "put", path: ".gitattributes", content: te.encode("notebooks/ export-ignore\n*.ipynb export-ignore\n") },
      { op: "put", path: ".github/release.yml", content: te.encode(RELEASE_YML) },
      { op: "put", path: "pyproject.toml", content: te.encode('[project]\nname = "eeg-analysis"\nversion = "1.1.0rc1"\nrequires-python = ">=3.11"\ndependencies = [\n  "numpy>=1.26",\n  "scipy>=1.11,<1.12",\n  "mne==1.6.0",\n]\n') },
    ],
  });
  const rc = await ada.git.resolve(repo, "main");
  await ada.releases.create(repo, {
    tagName: "v1.1.0-rc.1",
    target: rc,
    name: "The revision for the journal (under review)",
    body: "The code of the manuscript's second version, as sent to the reviewers.\n\nThe environment is now pinned: `environment.yml`, `requirements.txt` and a container.",
    prerelease: true,
  });
  await ada.releases.create(repo, { tagName: "v1.1.0", target: rc, name: "The revision, accepted", body: "Draft: to publish once the journal accepts the revision.", draft: true });
  return { published: "v1.0", prerelease: "v1.1.0-rc.1", draft: "v1.1.0" };
}
