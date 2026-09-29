// Templates and writing aids of the registry's editor (night phase 03, E5; src/lib/templates.ts):
// licences and codes of conduct filled (no email address ever), CITATION.cff and a research README
// from the paper, metadata files checked as written, the Markdown toolbar's edits, pasting and the
// slash commands; the community checklist's missing files (src/lib/about.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { communityFiles, missingCommunity } from "../../src/lib/about.ts";
import { citationOfCff } from "../../src/lib/citation.ts";
import type { Edit } from "../../src/lib/editor.ts";
import {
  checkMetadata,
  citationTemplate,
  fillConduct,
  fillLicence,
  isCitationName,
  isConductName,
  isLicenceName,
  markdownEdit,
  pasteAsLink,
  pasteAsTable,
  readmeTemplate,
  slashCommand,
} from "../../src/lib/templates.ts";

const apply = (v: string, e: Edit) => v.slice(0, e.from) + e.insert + v.slice(e.to);

describe("licences and codes of conduct", () => {
  test("names, placeholders filled", () => {
    assert.ok(isLicenceName("LICENSE") && isLicenceName("licence.md") && isLicenceName("COPYING"));
    assert.ok(!isLicenceName("src/LICENSE") && !isLicenceName(null));
    assert.ok(isConductName("CODE_OF_CONDUCT.md") && isConductName(".github/code-of-conduct.md"));
    assert.ok(isCitationName("CITATION.cff") && !isCitationName("docs/CITATION.cff"));
    assert.equal(fillLicence("Copyright (c) [year] [fullname]", { year: 2026, holder: "Ada Lab" }), "Copyright (c) 2026 Ada Lab");
    assert.equal(fillLicence("Copyright [yyyy] [name of copyright owner]", { year: 2026, holder: " " }), "Copyright 2026 the authors");
    assert.equal(fillLicence("Copyright (C) <year>  <name of author>", { year: 2026, holder: "Ada" }), "Copyright (C) 2026  Ada");
  });

  test("a code of conduct's contact is the repository's page, never an address", () => {
    const body = "Report to [INSERT CONTACT METHOD]. Or write to conduct@example.org. [PROJECT NAME] pledges.";
    const out = fillConduct(body, { project: "eeg-analysis", contact: "the maintainers, through https://site.test/r/o/n/" });
    assert.equal(out, "Report to the maintainers, through https://site.test/r/o/n/. Or write to the maintainers, through https://site.test/r/o/n/. eeg-analysis pledges.");
    assert.ok(!out.includes("@"));
  });
});

describe("CITATION.cff and README", () => {
  const repo = { owner: "oscr-fixture", name: "eeg-analysis", web: "https://github.com/oscr-fixture/eeg-analysis" };
  test("a CITATION.cff from the paper reads as the viewer reads it, the paper first, no address", () => {
    const text = citationTemplate(repo, { doi: "10.5555/oscr.fixture.1", title: "Band power in resting EEG" }, "MIT");
    const c = citationOfCff(text)!;
    assert.equal(c.preferred, true);
    assert.equal(c.work.title, "Band power in resting EEG");
    assert.equal(c.work.doi, "10.5555/oscr.fixture.1");
    assert.equal(c.software.title, "eeg-analysis");
    assert.ok(!text.includes("@"));
    assert.match(text, /^license: MIT$/m);
    assert.equal(checkMetadata("CITATION.cff", text)!.ok, true);
    assert.equal(citationOfCff(citationTemplate(repo, null, null))!.preferred, false);
  });

  test("metadata checked as written: what is missing, an email address, JSON", () => {
    assert.match(checkMetadata("CITATION.cff", "title: x\n")!.said, /cff-version is missing.*message is missing.*authors are missing/);
    assert.match(checkMetadata("CITATION.cff", "cff-version: 1.2.0\nmessage: m\ntitle: t\nauthors:\n  - name: Ada\n    email: ada@example.org\n")!.said, /email address/);
    assert.equal(checkMetadata("codemeta.json", "{")!.ok, false);
    assert.equal(checkMetadata(".zenodo.json", '{"title": "x"}')!.ok, true);
    assert.equal(checkMetadata("analysis.py", "x"), null);
  });

  test("a research README names the paper", () => {
    assert.match(readmeTemplate({ name: "eeg" }, { doi: "10.5555/x", title: "T" }), /^# eeg\n[\s\S]*“T”, doi:10\.5555\/x[\s\S]*## How to cite/);
  });

  test("the community checklist's missing files, the licence and the citation first", () => {
    const found = communityFiles([{ path: "LICENSE", type: "blob" }, { path: ".github/CONTRIBUTING.md", type: "blob" }]);
    assert.deepEqual(missingCommunity(found).map((m) => m.filename), ["CITATION.cff", "CODE_OF_CONDUCT.md", "SECURITY.md"]);
  });
});

describe("Markdown", () => {
  test("bold, italic and code wrap the selection or a placeholder, and unwrap", () => {
    const v = "a word here";
    const bold = markdownEdit(v, { start: 2, end: 6 }, "bold");
    assert.equal(apply(v, bold), "a **word** here");
    assert.deepEqual(bold.select, { start: 4, end: 8 });
    assert.equal(apply("a **word** here", markdownEdit("a **word** here", { start: 2, end: 10 }, "bold")), v);
    assert.equal(apply("", markdownEdit("", { start: 0, end: 0 }, "italic")), "_text_");
    assert.equal(apply("x\ny", markdownEdit("x\ny", { start: 0, end: 3 }, "code")), "```\nx\ny\n```");
  });

  test("a link around the selection, or around a URL selected", () => {
    const v = "see the paper";
    const e = markdownEdit(v, { start: 4, end: 13 }, "link");
    assert.equal(apply(v, e), "see [the paper](url)");
    assert.equal(apply(v, e).slice(e.select.start, e.select.end), "url");
    assert.equal(apply("https://doi.org/x", markdownEdit("https://doi.org/x", { start: 0, end: 17 }, "link")), "[text](https://doi.org/x)");
  });

  test("lists, quotes and headings on every selected line, toggled", () => {
    const v = "one\ntwo\n";
    const b = apply(v, markdownEdit(v, { start: 0, end: 7 }, "bullets"));
    assert.equal(b, "- one\n- two\n");
    assert.equal(apply(b, markdownEdit(b, { start: 0, end: 11 }, "bullets")), v);
    assert.equal(apply(v, markdownEdit(v, { start: 0, end: 7 }, "numbers")), "1. one\n2. two\n");
    assert.equal(apply(v, markdownEdit(v, { start: 0, end: 7 }, "tasks")), "- [ ] one\n- [ ] two\n");
    assert.equal(apply(v, markdownEdit(v, { start: 1, end: 1 }, "quote")), "> one\ntwo\n");
    assert.equal(apply(v, markdownEdit(v, { start: 5, end: 5 }, "heading")), "one\n### two\n");
  });

  test("a URL pasted over a selection is a link; spreadsheet cells a table", () => {
    const v = "the data";
    const e = pasteAsLink(v, { start: 4, end: 8 }, " https://zenodo.org/records/1 ");
    assert.equal(apply(v, e!), "the [data](https://zenodo.org/records/1)");
    assert.equal(pasteAsLink(v, { start: 4, end: 4 }, "https://x.org"), null);
    assert.equal(pasteAsLink(v, { start: 4, end: 8 }, "not a url"), null);
    assert.equal(pasteAsTable("id\tage\ns01\t31\ns|2\t28\n"), "| id | age |\n| --- | --- |\n| s01 | 31 |\n| s\\|2 | 28 |\n");
    assert.equal(pasteAsTable("one line\twith a tab"), null);
    assert.equal(pasteAsTable("a\tb\nc\n"), null);
  });

  test("slash commands", () => {
    const t = slashCommand("/table 1x2")!;
    assert.equal(t.insert, "| Column 1 | Column 2 |\n| --- | --- |\n|   |   |");
    assert.equal(t.insert.slice(...t.select), "Column 1");
    assert.equal(slashCommand("/code python")!.insert, "```python\n\n```");
    assert.match(slashCommand("/details")!.insert, /<summary>Summary<\/summary>/);
    assert.equal(slashCommand("/cite doi:10.5555/oscr.fixture.1")!.insert, "[doi:10.5555/oscr.fixture.1](https://doi.org/10.5555/oscr.fixture.1)");
    assert.equal(slashCommand("the /table here"), null);
    assert.equal(slashCommand("/nothing"), null);
  });
});
