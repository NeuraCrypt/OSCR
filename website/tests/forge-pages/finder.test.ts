// The file finder and the search of a repository (night phase 02, E7): src/lib/finder.ts. Fuzzy
// matching GitHub's way (letters in order, names and runs preferred), vendored and generated files
// left out unless .gitattributes brings them back, the search's query, plan and limits, the lines
// found with their words marked, and links that stay in the registry's viewer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { finderFiles, finderList, findFiles, fuzzyMatch, markedPath, parseQuery, SEARCH_LIMITS, searchPlan, searchResults, searchText } from "../../src/lib/finder.ts";
import { textOf, walk } from "../../src/lib/repo-view.ts";

const repo = { owner: "lab", name: "tool" };
const blob = (path: string, size = 100) => ({ path, type: "blob" as const, size, mode: "100644" as const });

describe("the finder", () => {
  test("letters in order; none out of order", () => {
    const m = fuzzyMatch("anpy", "analysis/preprocess.py")!;
    assert.ok(m);
    assert.equal(m.at.length, 4);
    assert.equal(fuzzyMatch("zz", "analysis.py"), null);
    assert.equal(fuzzyMatch("yp", "py"), null);
    assert.deepEqual(fuzzyMatch("", "a.py"), { path: "a.py", score: 0, at: [] });
  });

  test("the file's name, a name's start and a run are preferred", () => {
    const files = ["src/analysis/helpers.py", "analysis.py", "docs/an_alysis.md", "tests/test_analysis.py", "vendor/analysis.js"];
    const ranked = findFiles(files, "analysis").map((m) => m.path);
    assert.equal(ranked[0], "analysis.py");
    assert.ok(ranked.indexOf("tests/test_analysis.py") < ranked.indexOf("src/analysis/helpers.py"));
    assert.deepEqual(findFiles(files, "plot"), []);
    assert.equal(findFiles(files, "a", 2).length, 2);
  });

  test("vendored and generated files are left out, unless .gitattributes says otherwise", () => {
    const entries = [blob("a.py"), blob("node_modules/x/index.js"), blob("vendor/lib.c"), blob("package-lock.json"), blob("third_party/tool.c"), { path: "src", type: "tree" as const, size: null, mode: "040000" as const }];
    assert.deepEqual(finderFiles(entries), ["a.py"]);
    assert.deepEqual(finderFiles(entries, "vendor/** -linguist-vendored\n"), ["a.py", "vendor/lib.c"]);
  });

  test("the list: links in the viewer, matched letters marked", () => {
    const m = fuzzyMatch("ap", "a.py")!;
    assert.deepEqual(markedPath(m).map((x) => (typeof x === "string" ? x : `[${textOf(x as never)}]`)).join(""), "[a].[p]y");
    const el = finderList(repo, "main", [m], 12);
    assert.equal([...walk(el)].find((e) => e.tag === "a")!.attrs.href, "/r/lab/tool/blob/main/a.py");
    assert.match(textOf(el), /1 of 12 files/);
    assert.match(textOf(finderList(repo, "main", [], 3)), /No file matches/);
  });
});

describe("the search", () => {
  test("the query: words and qualifiers", () => {
    assert.deepEqual(parseQuery('band power path:analysis/ language:Python'), { text: "band power", path: "analysis/", language: "Python", caseSensitive: false });
    assert.deepEqual(parseQuery('"alpha ratio" lang:r', true), { text: "alpha ratio", path: null, language: "r", caseSensitive: true });
    assert.equal(parseQuery("path:src/"), null, "qualifiers alone search nothing");
    assert.equal(parseQuery("x".repeat(201)), null);
  });

  test("the plan: text files within the limits, qualifiers applied, a large repository refused", () => {
    const q = parseQuery("x")!;
    const entries = [blob("a.py"), blob("b.R"), blob("fig.png"), blob("data/big.csv", 500 * 1024), blob("node_modules/m.js"), blob("empty.txt", 0), blob("nb.ipynb")];
    assert.deepEqual(searchPlan(entries, q), { files: ["a.py", "b.R"], tooLarge: false, skipped: 1 });
    assert.deepEqual(searchPlan(entries, parseQuery("x language:R")!).files, ["b.R"]);
    assert.deepEqual(searchPlan(entries, parseQuery("x path:A.PY")!).files, ["a.py"]);
    const many = Array.from({ length: SEARCH_LIMITS.files + 1 }, (_, k) => blob(`f${k}.py`, 10));
    assert.equal(searchPlan(many, q).tooLarge, true);
    assert.equal(searchPlan([blob("a.py", 300 * 1024), ...Array.from({ length: 15 }, (_, k) => blob(`b${k}.py`, 300 * 1024))], q).tooLarge, true, "over 4 MB");
  });

  test("lines with the phrase, or all the words; case as asked; five lines kept a file", () => {
    const text = "def band_power(x):\n    # the Band Power\n    return power_of(band)\nnothing\n" + "band power\n".repeat(10);
    const hit = searchText("a.py", text, parseQuery("band power")!)!;
    assert.equal(hit.count, 13);
    assert.equal(hit.lines.length, SEARCH_LIMITS.linesPerFile);
    assert.deepEqual(hit.lines[0], { n: 1, text: "def band_power(x):", at: [4, 8, 9, 14] }, "both words on the line, apart");
    assert.deepEqual(hit.lines[1], { n: 2, text: "    # the Band Power", at: [10, 20] }, "the phrase, whatever its case");
    assert.equal(hit.lines[2].n, 3);
    assert.equal(searchText("a.py", text, parseQuery("Band Power", true)!)!.count, 1);
    assert.equal(searchText("a.py", "nothing", parseQuery("band")!), null);
  });

  test("results link to the lines in the viewer, the words marked, email addresses masked", () => {
    const hit = searchText("src/a.py", "x = 1\ncontact = 'ada@example.org' # alpha\n", parseQuery("alpha")!)!;
    const el = searchResults(repo, "main", [hit]);
    const hrefs = [...walk(el)].filter((e) => e.tag === "a").map((a) => a.attrs.href);
    assert.deepEqual(hrefs, ["/r/lab/tool/blob/main/src/a.py", "/r/lab/tool/blob/main/src/a.py#L2"]);
    assert.equal(textOf([...walk(el)].find((e) => e.tag === "mark")!), "alpha");
    assert.doesNotMatch(JSON.stringify(el), /@example/);
  });

  test("bounded time on many paths", () => {
    const files = Array.from({ length: 20_000 }, (_, k) => `dir${k % 50}/sub${k % 7}/file_${k}_analysis_module.py`);
    const t = performance.now();
    findFiles(files, "anmod");
    assert.ok(performance.now() - t < 3000);
  });
});
