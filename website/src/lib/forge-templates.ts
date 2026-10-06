// The choices of a new repository's first files (night phase 01, E2): GitHub's .gitignore templates
// and licence keys, as static lists (no request to GitHub's REST API: /gitignore/templates and
// /licenses change rarely, and the page must work signed out and offline). The Worker checks a
// creation's payload against the same lists (worker/forge/service/act-create.ts).
//
// Each licence says why a licence matters here: a licence that allows redistribution, confirmed by
// the repository's own LICENSE file (which GitHub writes at creation), lets the registry keep and
// publish copies of the scripts (CLAUDE.md, "Only verified licenses leave the Mac"), and makes
// archiving and reuse possible. Without one, nobody may reuse the code, and the registry keeps no
// copy of it: its pages link to the code at the source.

/** GitHub's .gitignore templates the page offers (the names of github/gitignore's root templates,
 *  as GitHub's API takes them), research languages first. */
export const GITIGNORE_TEMPLATES: readonly string[] = [
  "Python", "R", "Julia", "C", "C++", "CMake", "CUDA", "Fortran", "Java", "Kotlin", "Scala", "Go", "Rust",
  "Haskell", "OCaml", "Node", "TeX", "LabVIEW", "Modelica", "IGORPro", "Processing", "ROS", "Unity",
];

export const isGitignoreTemplate = (value: unknown): value is string =>
  typeof value === "string" && GITIGNORE_TEMPLATES.includes(value);

export interface Licence {
  /** GitHub's key (its API's `license_template`). */
  key: string;
  spdx: string;
  name: string;
  /** One line: what it lets others do. */
  explain: string;
  /** Allows redistribution: the registry may keep and publish copies of the scripts. */
  open: boolean;
}

/** GitHub's licence templates (its API's keys, with their SPDX ids), permissive ones first. */
export const LICENCES: readonly Licence[] = [
  { key: "mit", spdx: "MIT", name: "MIT License", explain: "Short and permissive: anyone may reuse the code, keeping the copyright notice.", open: true },
  { key: "apache-2.0", spdx: "Apache-2.0", name: "Apache License 2.0", explain: "Permissive, with an explicit patent grant; changes must be stated.", open: true },
  { key: "bsd-3-clause", spdx: "BSD-3-Clause", name: "BSD 3-Clause License", explain: "Permissive; the authors' names may not be used to promote derived work.", open: true },
  { key: "bsd-2-clause", spdx: "BSD-2-Clause", name: "BSD 2-Clause License", explain: "Permissive and short, like MIT.", open: true },
  { key: "gpl-3.0", spdx: "GPL-3.0", name: "GNU General Public License v3.0", explain: "Copyleft: derived programs must be shared under the same licence.", open: true },
  { key: "gpl-2.0", spdx: "GPL-2.0", name: "GNU General Public License v2.0", explain: "The earlier copyleft licence, still used by older projects.", open: true },
  { key: "lgpl-2.1", spdx: "LGPL-2.1", name: "GNU Lesser General Public License v2.1", explain: "Copyleft for the library itself; programs that use it may have any licence.", open: true },
  { key: "agpl-3.0", spdx: "AGPL-3.0", name: "GNU Affero General Public License v3.0", explain: "Copyleft that also covers software offered over a network.", open: true },
  { key: "mpl-2.0", spdx: "MPL-2.0", name: "Mozilla Public License 2.0", explain: "Copyleft file by file: changed files stay open, the rest may not.", open: true },
  { key: "epl-2.0", spdx: "EPL-2.0", name: "Eclipse Public License 2.0", explain: "Weak copyleft, common in Java and modelling tools.", open: true },
  { key: "bsl-1.0", spdx: "BSL-1.0", name: "Boost Software License 1.0", explain: "Permissive; no notice needed in compiled programs.", open: true },
  { key: "cc0-1.0", spdx: "CC0-1.0", name: "Creative Commons Zero v1.0 Universal", explain: "Public domain dedication: no condition at all.", open: true },
  { key: "unlicense", spdx: "Unlicense", name: "The Unlicense", explain: "Public domain dedication, written for software.", open: true },
  { key: "cc-by-4.0", spdx: "CC-BY-4.0", name: "Creative Commons Attribution 4.0", explain: "For text and data rather than code: reuse with credit.", open: true },
];

export const licenceOf = (key: unknown): Licence | null => LICENCES.find((l) => l.key === key) ?? null;

export const isLicenceKey = (value: unknown): value is string => licenceOf(value) !== null;

/** Why a licence matters, in the page's words (the site's name handed in: a browser script never
 *  names the platform). */
export function whyLicence(site: string): string[] {
  return [
    `A licence lets others reuse your code, and lets ${site} keep and publish copies of your scripts next to the paper: ` +
      "it publishes a copy only when the repository's own licence file allows redistribution, and GitHub writes that file for you here.",
    "It also makes archiving possible: Software Heritage and Zenodo keep what its licence lets them keep.",
    `Without a licence, nobody may legally reuse the code, and ${site} keeps no copy: its pages link to the code on GitHub.`,
  ];
}

/** The branch names a person may choose for the first branch (GitHub's own default is "main"). */
export const DEFAULT_BRANCH = "main";

/** The licence the page offers by default (the person may choose another, or none). */
export const DEFAULT_LICENCE = "mit";
