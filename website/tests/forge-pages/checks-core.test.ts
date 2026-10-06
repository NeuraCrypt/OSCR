// The registry's checks, which run no code (night phase 10, E4; worker/forge/checks-core.ts): a licence,
// an environment, the paper's DOI, CITATION.cff, the tracing maps' coherence, file sizes, the README;
// failure only when a change breaks traceability; the words say why and how to resolve it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkFiles, licenceOf, runChecks, skipsChecks, type CheckInput } from "../../worker/forge/checks-core.ts";

const MIT = "MIT License\n\nCopyright (c) 2026 Ada\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software";
const CFF = "cff-version: 1.2.0\nmessage: Cite the paper\ntitle: EEG filters\nauthors:\n  - family-names: Fixture\n    given-names: Ada\ndoi: 10.1234/eeg.2026\n";
const README = "# EEG filters\n\nThe code of the paper.\n\n## Installation\n\npip install -r requirements.txt\n";

const blob = (path: string, size = 100) => ({ path, type: "blob", size });

function input(extra: Partial<CheckInput> = {}): CheckInput {
  return {
    entries: [blob("LICENSE"), blob("CITATION.cff"), blob("README.md"), blob("requirements.txt"), blob("src/filter.py"), { path: "src", type: "tree", size: null }],
    truncated: false,
    texts: { LICENSE: MIT, "CITATION.cff": CFF, "README.md": README },
    papers: ["10.1234/eeg.2026"],
    traced: [{ path: "src/filter.py", paper: "10.1234/eeg.2026", commit: "a".repeat(40) }],
    ...extra,
  };
}

const level = (r: ReturnType<typeof runChecks>, id: string) => r.findings.find((f) => f.id === id)?.level;

describe("the checks", () => {
  test("a traceable repository: every check passes, conclusion success, words that say what was found", () => {
    const r = runChecks(input());
    assert.equal(r.conclusion, "success", r.summary);
    assert.equal(r.title, "All 7 checks passed");
    assert.match(r.summary, /never run its code/);
    assert.match(r.findings[0].words, /^MIT, in LICENSE\.$/);
    assert.match(r.findings.find((f) => f.id === "environment")!.words, /requirements\.txt/);
    assert.deepEqual(r.annotations, []);
  });

  test("the files it reads: the root's licence, CITATION.cff, the README; nothing else", () => {
    assert.deepEqual(checkFiles(["COPYING", "docs/LICENSE", "readme.rst", "CITATION.cff", "setup.py"]), { licence: "COPYING", citation: "CITATION.cff", readme: "readme.rst" });
    assert.deepEqual(checkFiles(["src/a.py"]), { licence: null, citation: null, readme: null });
  });

  test("licences recognised from their text", () => {
    assert.equal(licenceOf(MIT), "MIT");
    assert.equal(licenceOf("Apache License\nVersion 2.0, January 2004"), "Apache-2.0");
    assert.equal(licenceOf("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007"), "GPL-3.0");
    assert.equal(licenceOf("Redistribution and use in source and binary forms ... Neither the name of"), "BSD-3-Clause");
    assert.equal(licenceOf("Attribution 4.0 International"), "CC-BY-4.0");
    assert.equal(licenceOf("All rights reserved."), null);
  });

  test("what is missing is to look at (neutral), with the way out", () => {
    const r = runChecks(input({ entries: [blob("src/filter.py")], texts: {}, papers: [], traced: [] }));
    assert.equal(r.conclusion, "neutral");
    for (const id of ["licence", "environment", "doi", "citation", "readme"]) assert.equal(level(r, id), "warning", id);
    assert.ok(r.findings.every((f) => f.level === "ok" || f.fix.length > 10));
    assert.match(r.title, /to look at/);
  });

  test("a DOI named but not linked: a notice; a README without how to run: a notice with its annotation", () => {
    const r = runChecks(input({ papers: [], texts: { LICENSE: MIT, "CITATION.cff": CFF, "README.md": "# Code\n\nSee https://doi.org/10.1234/eeg.2026." } }));
    assert.equal(level(r, "doi"), "notice");
    assert.equal(level(r, "readme"), "notice");
    assert.ok(r.annotations.some((a) => a.path === "README.md"));
    assert.equal(r.conclusion, "success");
  });

  test("CITATION.cff: unreadable, without authors, without a DOI", () => {
    assert.equal(level(runChecks(input({ texts: { LICENSE: MIT, "CITATION.cff": "title: x\n", "README.md": README } })), "citation"), "warning");
    const noDoi = runChecks(input({ texts: { LICENSE: MIT, "CITATION.cff": CFF.replace(/doi:.*\n/, ""), "README.md": README } }));
    assert.equal(level(noDoi, "citation"), "notice");
  });

  test("a change that deletes or renames a traced file fails, with the paper named; one that edits it is a notice with an annotation", () => {
    const deleted = runChecks(input({ entries: input().entries.filter((e) => e.path !== "src/filter.py"), change: { files: [{ path: "src/filter.py", previousPath: null, status: "removed" }], truncated: false } }));
    assert.equal(deleted.conclusion, "failure");
    assert.match(deleted.findings.find((f) => f.id === "map")!.words, /src\/filter\.py \(10\.1234\/eeg\.2026\) is deleted/);
    assert.match(deleted.title, /1 check fails: tracing maps/);
    const renamed = runChecks(input({ change: { files: [{ path: "src/filters.py", previousPath: "src/filter.py", status: "renamed" }], truncated: false } }));
    assert.match(renamed.findings.find((f) => f.id === "map")!.words, /renamed to src\/filters\.py/);
    const edited = runChecks(input({ change: { files: [{ path: "src/filter.py", previousPath: null, status: "modified" }], truncated: false } }));
    assert.equal(level(edited, "map"), "notice");
    assert.equal(edited.annotations[0].path, "src/filter.py");
    assert.equal(edited.conclusion, "success");
  });

  test("the change deletes the licence or breaks CITATION.cff: failure; at a commit, a traced file gone: a warning", () => {
    const noLicence = runChecks(input({ entries: input().entries.filter((e) => e.path !== "LICENSE"), change: { files: [{ path: "LICENSE", previousPath: null, status: "removed" }], truncated: false } }));
    assert.equal(level(noLicence, "licence"), "failure");
    const broken = runChecks(input({ texts: { LICENSE: MIT, "CITATION.cff": "nope", "README.md": README }, change: { files: [{ path: "CITATION.cff", previousPath: null, status: "modified" }], truncated: false } }));
    assert.equal(level(broken, "citation"), "failure");
    const gone = runChecks(input({ entries: input().entries.filter((e) => e.path !== "src/filter.py") }));
    assert.equal(level(gone, "map"), "warning");
    assert.match(gone.findings.find((f) => f.id === "map")!.words, /stay valid at their pinned commits/);
  });

  test("large files; addresses never in the words; skip-checks: true as GitHub reads it", () => {
    const r = runChecks(input({ entries: [...input().entries, blob("data/raw.h5", 80 * 2 ** 20)] }));
    assert.equal(level(r, "sizes"), "warning");
    assert.match(r.findings.find((f) => f.id === "sizes")!.words, /data\/raw\.h5 \(80 MiB\)/);
    const masked = runChecks(input({ texts: { LICENSE: "Write to ada@example.org", "CITATION.cff": CFF, "README.md": README } }));
    assert.ok(!masked.summary.includes("ada@example.org"));
    assert.ok(skipsChecks("Fix the filter\n\nskip-checks: true"));
    assert.ok(!skipsChecks("skip-checks: true"));
    assert.ok(!skipsChecks("Fix\n\nskip-checks: false"));
  });
});
