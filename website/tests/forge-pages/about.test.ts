// The About panel (night phase 02, E6): src/lib/attributes.ts (.gitattributes as Linguist reads it,
// its patterns, its defaults for vendored, generated and documentation paths) and src/lib/about.ts
// (languages in words from the tree, community health files by GitHub's precedence, the owner's
// defaults, the overview's links in the registry's viewer).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { communityFiles, languagesInWords, languageStats, overviewLinks, ownerDefaults } from "../../src/lib/about.ts";
import { attributesOf, parseAttributes, patternRe } from "../../src/lib/attributes.ts";
import { textOf, walk } from "../../src/lib/repo-view.ts";

const blob = (path: string, size = 100) => ({ path, type: "blob" as const, size, mode: "100644" as const });

describe(".gitattributes", () => {
  test("patterns: a name at any depth, anchored paths, **, directories", () => {
    const m = (p: string, path: string) => patternRe(p)!.test(path);
    assert.ok(m("*.m", "src/a.m"));
    assert.ok(m("*.m", "a.m"));
    assert.ok(!m("/*.m", "src/a.m"));
    assert.ok(m("/*.m", "a.m"));
    assert.ok(m("docs/**", "docs/a/b.md"));
    assert.ok(m("vendor/", "vendor/lib/x.js"));
    assert.ok(m("src/**/gen_*.py", "src/a/b/gen_x.py"));
    assert.ok(m("src/**/gen_*.py", "src/gen_x.py"));
    assert.ok(!m("src/*.py", "src/a/b.py"));
    assert.ok(m("data?.csv", "data1.csv"));
    assert.equal(patternRe("# comment"), null);
  });

  test("linguist's attributes, the last rule winning; the defaults", () => {
    const rules = parseAttributes("*.m linguist-language=MATLAB\nthird_party/** -linguist-vendored\n*.ipynb linguist-documentation\nsrc/gen/** linguist-generated=true\n*.bin binary\nnotes/*.md linguist-detectable\n");
    assert.equal(attributesOf(rules, "src/a.m").language, "MATLAB");
    assert.equal(attributesOf(rules, "third_party/x.c").vendored, false, "undone by the repository");
    assert.equal(attributesOf(rules, "vendor/x.c").vendored, true, "Linguist's default");
    assert.equal(attributesOf(rules, "node_modules/a/b.js").vendored, true);
    assert.equal(attributesOf(rules, "docs/guide.py").documentation, true);
    assert.equal(attributesOf(rules, "nb/x.ipynb").documentation, true);
    assert.equal(attributesOf(rules, "src/gen/x.py").generated, true);
    assert.equal(attributesOf(rules, "package-lock.json").generated, true);
    assert.equal(attributesOf(rules, "a.bin").binary, true);
    assert.equal(attributesOf(rules, "notes/a.md").detectable, true);
    assert.deepEqual(attributesOf(rules, "src/model.py"), {});
  });
});

describe("languages", () => {
  test("bytes per language, data and prose aside, vendored and documentation aside, overrides obeyed", () => {
    const entries = [blob(".editorconfig", 60), blob(".gitignore", 30), blob("a.py", 800), blob("b.R", 150), blob("run.sh", 50), blob("data.csv", 10_000), blob("README.md", 5_000), blob("vendor/lib.js", 9_000), blob("docs/x.py", 9_000), blob("model.m", 100), { path: "sub", type: "tree" as const, size: null, mode: "040000" as const }];
    const stats = languageStats(entries, "*.m linguist-language=MATLAB\n");
    assert.deepEqual(stats.map((s) => [s.language, s.bytes]), [["Python", 800], ["R", 150], ["MATLAB", 100], ["Shell", 50]]);
    assert.equal(languagesInWords(stats), "Python 72.7%, R 13.6%, MATLAB 9.1%, Shell 4.5%");
    const detectable = languageStats([blob("a.py", 100), blob("notes/n.md", 100)], "notes/*.md linguist-detectable\n");
    assert.deepEqual(detectable.map((s) => s.language), ["Markdown", "Python"]);
    assert.equal(languagesInWords([]), "");
  });

  test("the first six, then other", () => {
    const stats = ["A", "B", "C", "D", "E", "F", "G"].map((language, k) => ({ language, bytes: 1, percent: k === 6 ? 2 : 98 / 6 }));
    assert.match(languagesInWords(stats), /, other 2\.0%$/);
  });
});

describe("community health files", () => {
  test(".github/, then the root, then docs/; the licence at the root only", () => {
    const files = communityFiles([
      blob("CODE_OF_CONDUCT.md"),
      blob(".github/CODE_OF_CONDUCT.md"),
      blob("docs/CONTRIBUTING.md"),
      blob("LICENSE"),
      blob("docs/LICENSE.md"),
      blob("SECURITY.md"),
      blob(".github/FUNDING.yml"),
      blob("CITATION.cff"),
    ]);
    assert.deepEqual(files.map((f) => [f.kind, f.path]), [
      ["code_of_conduct", ".github/CODE_OF_CONDUCT.md"],
      ["contributing", "docs/CONTRIBUTING.md"],
      ["license", "LICENSE"],
      ["security", "SECURITY.md"],
      ["funding", ".github/FUNDING.yml"],
      ["citation", "CITATION.cff"],
    ]);
    assert.deepEqual(ownerDefaults(files).map((d) => d.path), ["SUPPORT.md"]);
  });

  test("the overview's links stay in the registry; a default says whose", () => {
    const files = [...communityFiles([blob("LICENSE"), blob("CONTRIBUTING.md")]), { kind: "code_of_conduct" as const, label: "Code of conduct", path: "CODE_OF_CONDUCT.md", fromOwner: true }];
    const el = overviewLinks({ owner: "lab", name: "tool" }, "main", files)!;
    const links = [...walk(el)].filter((e) => e.tag === "a");
    assert.deepEqual(links.map((a) => a.attrs.href), ["/r/lab/tool/blob/main/CONTRIBUTING.md", "/r/lab/tool/blob/main/LICENSE", "/r/lab/.github/blob/HEAD/CODE_OF_CONDUCT.md"]);
    assert.match(textOf(el), /Code of conduct \(lab's default\)/);
    assert.equal(overviewLinks({ owner: "lab", name: "tool" }, "main", []), null);
  });
});
