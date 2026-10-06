// "Cite this repository" (night phase 02, E6): src/lib/citation.ts. CITATION.cff read through a
// YAML subset (mappings, sequences, quoted scalars, flow lists, block scalars), codemeta.json, the
// preferred citation first, APA 7 and BibTeX, email addresses never shown.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { apa, bibtex, citationOfCff, citationOfCodemeta, doiOf, parseYaml } from "../../src/lib/citation.ts";

const CFF = `cff-version: 1.2.0
message: "If you use this software, please cite it as below."
title: "eeg-analysis: the code of the fixture study"
version: 1.0.0
date-released: 2026-09-01
doi: 10.5555/oscr.fixture.code
repository-code: "https://github.com/oscr-fixture/eeg-analysis"
authors:
  - family-names: Fixture
    given-names: Ada Lovelace
    email: ada@example.org
    orcid: "https://orcid.org/0000-0002-1825-0097"
  - family-names: Beethoven
    name-particle: van
    given-names: Ludwig
  - name: "The Fixture Lab"
keywords: [eeg, "alpha band"]
abstract: >
  A folded
  abstract.
preferred-citation:
  type: article
  title: "Resting-state alpha in the fixture study"
  doi: 10.5555/oscr.fixture.1
  journal: "Journal of Fixtures"
  year: 2026
  volume: 12
  issue: 3
  start: 45
  end: 67
  authors:
    - family-names: Fixture
      given-names: Ada
`;

describe("the YAML subset", () => {
  test("mappings, sequences of mappings, quotes, flow lists, block scalars, comments", () => {
    const y = parseYaml(`a: 1 # a comment\nb: "x: y"\nc: 'it''s'\nd: [p, "q r"]\ne: |\n  line 1\n  line 2\nf:\n  - g: 1\n    h: 2\n  - plain\nk:\n  l: m\n`) as Record<string, unknown>;
    assert.deepEqual(y, { a: "1", b: "x: y", c: "it's", d: ["p", "q r"], e: "line 1\nline 2", f: [{ g: "1", h: "2" }, "plain"], k: { l: "m" } });
  });

  test("a hostile key does not reach the prototype", () => {
    const y = parseYaml("__proto__:\n  polluted: yes\n") as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.ok(!("polluted" in y));
  });
});

describe("the citation", () => {
  test("CITATION.cff: the preferred citation first, the software kept", () => {
    const c = citationOfCff(CFF)!;
    assert.equal(c.preferred, true);
    assert.equal(c.work.title, "Resting-state alpha in the fixture study");
    assert.equal(c.software.version, "1.0.0");
    assert.deepEqual(c.software.authors.map((p) => [p.family, p.given, p.name, p.orcid]), [
      ["Fixture", "Ada Lovelace", "", "https://orcid.org/0000-0002-1825-0097"],
      ["van Beethoven", "Ludwig", "", null],
      ["", "", "The Fixture Lab", null],
    ]);
    assert.doesNotMatch(JSON.stringify(c), /@example/);
  });

  test("APA 7", () => {
    const c = citationOfCff(CFF)!;
    assert.equal(apa(c.work), "Fixture, A. (2026). Resting-state alpha in the fixture study. Journal of Fixtures, 12(3), 45–67. https://doi.org/10.5555/oscr.fixture.1");
    assert.equal(apa(c.software), "Fixture, A. L., van Beethoven, L., & The Fixture Lab. (2026). eeg-analysis: the code of the fixture study (Version 1.0.0) [Computer software]. https://doi.org/10.5555/oscr.fixture.code");
  });

  test("BibTeX", () => {
    const c = citationOfCff(CFF)!;
    assert.equal(
      bibtex(c.software),
      "@software{Fixture_eeg-analysis_2026,\n  author = {Fixture, Ada Lovelace and van Beethoven, Ludwig and {The Fixture Lab}},\n  title = {{eeg-analysis: the code of the fixture study}},\n  version = {1.0.0},\n  year = {2026},\n  doi = {10.5555/oscr.fixture.code},\n  month = sep,\n  url = {https://github.com/oscr-fixture/eeg-analysis}\n}",
    );
    assert.match(bibtex(c.work), /^@article\{Fixture_Resting-state_2026,[\s\S]*pages = \{45--67\}/);
  });

  test("codemeta.json", () => {
    const c = citationOfCodemeta(JSON.stringify({ name: "tool", version: "2.1", identifier: "https://doi.org/10.5281/zenodo.123", datePublished: "2025-03-04", author: [{ givenName: "Ada", familyName: "Fixture", "@id": "https://orcid.org/0000-0002-1825-0097", email: "ada@example.org" }] }))!;
    assert.equal(apa(c.work), "Fixture, A. (2025). tool (Version 2.1) [Computer software]. https://doi.org/10.5281/zenodo.123");
    assert.equal(citationOfCodemeta("{bad"), null);
    assert.equal(citationOfCodemeta('{"name":"x"}'), null, "no author");
  });

  test("no title or no author: no citation", () => {
    assert.equal(citationOfCff("cff-version: 1.2.0\ntitle: x\n"), null);
    assert.equal(doiOf("https://doi.org/10.1000/abc."), "10.1000/abc");
  });
});
