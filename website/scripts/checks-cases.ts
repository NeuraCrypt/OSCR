// Writes tests/fixtures/checks-cases.json (night phase 14; D14-6): the cases the registry's checks
// (worker/forge/checks-core.ts) and citations (src/lib/citation.ts) answer, with their answers, for the
// command line's Python port (cli/src/oscr_cli/checks.py, citation.py) to answer alike. After a change of
// the rules:
//   node --experimental-strip-types scripts/checks-cases.ts
// Two tests hold the file: website/tests/forge-pages/checks-parity.test.ts (the file is the TypeScript's
// answers) and cli/tests/test_registry.py (the Python answers the same).
import { writeFileSync } from "node:fs";
import { runChecks, type CheckInput } from "../worker/forge/checks-core.ts";
import { apa, bibtex, citationOfCff, citationOfCodemeta } from "../src/lib/citation.ts";
import { environmentFiles } from "../src/lib/environments.ts";

const MIT = "MIT License\n\nCopyright (c) 2026 The authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";
const APACHE = "                                 Apache License\n                           Version 2.0, January 2004\n";
const BSD3 = "BSD 3-Clause License\n\nRedistribution and use in source and binary forms, with or without\nmodification...\nNeither the name of the copyright holder nor the names of its contributors may be used\n";
const GPL3 = "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n";
const CFF_OK = `cff-version: 1.2.0
message: "If you use this software, please cite the paper."
title: eeg-analysis
authors:
  - family-names: Lovelace
    given-names: Ada
    orcid: https://orcid.org/0000-0002-1825-0097
preferred-citation:
  type: article
  title: "A synthetic EEG study"
  journal: eLife
  volume: "12"
  issue: "3"
  start: "101"
  end: "118"
  year: "2026"
  month: "3"
  doi: 10.5555/oscr.fixture.1
  authors:
    - family-names: Lovelace
      given-names: Ada Augusta
    - name-particle: van
      family-names: Rossum
      given-names: Guido
    - name: The EEG Consortium
`;
const CFF_NO_DOI = "cff-version: 1.2.0\ntitle: Contact ada@example.org for the tool\nauthors:\n  - name: A Lab\n";
const CFF_BROKEN = "title: no version\nauthors:\n  - name: Someone\n";
const README_RUN = "# Tool\n\nThe code of doi:10.5555/oscr.fixture.1.\n\n## Installation\n\npip install .\n";
const README_BARE = "# Tool\n\nIt does things. See 10.1234/abc.def, and more.\n";

const blob = (path: string, size = 100) => ({ path, type: "blob", size });

const base = (over: Partial<CheckInput>): CheckInput => ({ entries: [], truncated: false, texts: {}, papers: [], traced: [], change: null, ...over });

const CHECKS: { name: string; input: CheckInput }[] = [
  {
    name: "a complete repository",
    input: base({
      entries: [blob("LICENSE"), blob("README.md"), blob("CITATION.cff"), blob("requirements.txt"), blob("analysis/preprocess.py"), blob("plot.py"), { path: "docs", type: "tree", size: null }],
      texts: { LICENSE: MIT, "README.md": README_RUN, "CITATION.cff": CFF_OK },
      papers: ["10.5555/oscr.fixture.1"],
      traced: [{ path: "analysis/preprocess.py", paper: "10.5555/oscr.fixture.1", commit: "0123456789abcdef0123456789abcdef01234567" }, { path: "plot.py", paper: "10.5555/oscr.fixture.1", commit: "0123456789abcdef0123456789abcdef01234567" }],
    }),
  },
  { name: "nothing but a script", input: base({ entries: [blob("run.m")] }) },
  {
    name: "Apache, only scripts, a README without how to run, a CITATION.cff without DOI, a DOI in the README",
    input: base({
      entries: [blob("LICENSE.txt"), blob("readme.rst"), blob("CITATION.cff"), blob("setup.py"), blob("Makefile")],
      texts: { "LICENSE.txt": APACHE, "readme.rst": README_BARE, "CITATION.cff": CFF_NO_DOI },
    }),
  },
  {
    name: "an unknown licence, a broken CITATION.cff, a large file, a traced file gone",
    input: base({
      entries: [blob("COPYING"), blob("CITATION.cff"), blob("data/raw.h5", 120 * 2 ** 20), blob("environment.yml"), blob("README")],
      texts: { COPYING: "All rights reserved, by the authors.", "CITATION.cff": CFF_BROKEN, README: null },
      traced: [{ path: "src/gone.py", paper: "10.5555/oscr.fixture.2", commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }],
    }),
  },
  {
    name: "the same, the listing cut",
    input: base({ entries: [blob("src/x.py")], truncated: true, traced: [{ path: "src/gone.py", paper: "p", commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }] }),
  },
  {
    name: "a change that deletes the licence and CITATION.cff and renames a traced file",
    input: base({
      entries: [blob("README.md"), blob("src/new.py")],
      texts: { "README.md": README_RUN },
      traced: [{ path: "src/old.py", paper: "10.5555/oscr.fixture.1", commit: "0123456789abcdef0123456789abcdef01234567" }],
      change: {
        files: [
          { path: "LICENSE", previousPath: null, status: "removed" },
          { path: "CITATION.cff", previousPath: null, status: "removed" },
          { path: "src/new.py", previousPath: "src/old.py", status: "renamed" },
        ],
        truncated: true,
      },
    }),
  },
  {
    name: "a change that breaks CITATION.cff and touches a traced file",
    input: base({
      entries: [blob("LICENSE.md"), blob("CITATION.cff"), blob("src/a.py"), blob("pyproject.toml")],
      texts: { "LICENSE.md": BSD3, "CITATION.cff": CFF_BROKEN },
      papers: ["10.1/a", "10.1/b", "10.1/c", "10.1/d"],
      traced: [{ path: "src/a.py", paper: "10.1/a", commit: "1111111111111111111111111111111111111111" }, { path: "src/a.py", paper: "10.1/b", commit: "2222222222222222222222222222222222222222" }],
      change: { files: [{ path: "CITATION.cff", previousPath: null, status: "modified" }, { path: "src/a.py", previousPath: null, status: "modified" }], truncated: false },
    }),
  },
  {
    name: "many environment files",
    input: base({
      entries: [
        blob("LICENSE"), blob("requirements-dev.txt"), blob("requirements.txt"), blob("binder/environment.yml"), blob(".devcontainer/devcontainer.json"),
        blob(".devcontainer/py/devcontainer.json"), blob("recipe/meta.yaml"), blob("DESCRIPTION"), blob("sub/package.json"), blob("package.json"),
        blob("Dockerfile.gpu"), blob("renv.lock"), blob("uv.lock"), blob("runtime.txt"), blob("apt.txt"), blob("postBuild"), blob("src/requirements.txt"),
      ],
      texts: { LICENSE: GPL3 },
    }),
  },
];

const CFF_BLOCKS = `# A comment
cff-version: "1.2.0"
message: >
  Please cite
  this software.
"title": 'It''s a tool'
abstract: |
  Line one
  Line two
keywords: [eeg, "meg", 'fmri']
authors:
  - given-names: Marie
    family-names: Curie
    affiliation: A lab # a comment
  -
    name: "The \\"Team\\""
version: 2.0.1
date-released: 2026-09-29
identifiers:
  - type: url
    value: https://example.org
  - type: doi
    value: 10.5281/zenodo.1234567
repository-code: https://github.com/lab/tool
publisher:
  name: Zenodo
`;
const CODEMETA = JSON.stringify({ "@context": "https://doi.org/10.5063/schema/codemeta-2.0", name: "tool", version: "1.0", author: [{ givenName: "Ada", familyName: "Lovelace", "@id": "https://orcid.org/0000-0002-1825-0097", email: "ada@example.org" }], identifier: "https://doi.org/10.5281/zenodo.42", datePublished: "2025-02-03", codeRepository: "https://github.com/lab/tool" });
const MANY = `cff-version: 1.2.0\ntitle: Big collaboration\nauthors:\n${Array.from({ length: 23 }, (_, i) => `  - family-names: Person${i}\n    given-names: Jean-Luc P${i}`).join("\n")}\n`;

const CITATIONS: { name: string; kind: "cff" | "codemeta"; text: string }[] = [
  { name: "a preferred citation, an article", kind: "cff", text: CFF_OK },
  { name: "block scalars, flow lists, quoted keys, comments, identifiers", kind: "cff", text: CFF_BLOCKS },
  { name: "without a DOI, an address in the title", kind: "cff", text: CFF_NO_DOI },
  { name: "no cff-version is still a citation", kind: "cff", text: CFF_BROKEN },
  { name: "no author: none", kind: "cff", text: "cff-version: 1.2.0\ntitle: alone\n" },
  { name: "more than 20 authors", kind: "cff", text: MANY },
  { name: "codemeta.json", kind: "codemeta", text: CODEMETA },
  { name: "codemeta.json unreadable", kind: "codemeta", text: "{not json" },
];

const out = {
  about: "The registry's checks and citations, with their answers (night phase 14, D14-6): written by website/scripts/checks-cases.ts from the TypeScript (checks-core.ts, citation.ts, environments.ts); cli/src/oscr_cli/checks.py and citation.py must answer alike (cli/tests/test_registry.py).",
  checks: CHECKS.map((c) => ({ name: c.name, input: c.input, expected: runChecks(c.input) })),
  environments: CHECKS.map((c) => ({ paths: c.input.entries.filter((e) => e.type === "blob").map((e) => e.path), expected: environmentFiles(c.input.entries.filter((e) => e.type === "blob").map((e) => e.path)) })),
  citations: CITATIONS.map((c) => {
    const cit = c.kind === "cff" ? citationOfCff(c.text) : citationOfCodemeta(c.text);
    return { name: c.name, kind: c.kind, text: c.text, expected: cit ? { citation: cit, apa: apa(cit.work), bibtex: bibtex(cit.work), softwareApa: apa(cit.software), softwareBibtex: bibtex(cit.software) } : null };
  }),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = new URL("../../tests/fixtures/checks-cases.json", import.meta.url);
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`written: ${file.pathname}`);
}

export { out as CASES };
