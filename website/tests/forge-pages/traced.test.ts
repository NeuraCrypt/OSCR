// Tracing maps in the code view (night phase 02, E4): src/lib/traced.ts. The shards built from the
// catalogue (no paper text), permalinks read as trace points the same way as the Mac
// (tests/fixtures/permalinks.json), a map's lines found again in another version (moved, or by
// their symbol when the map's commit is gone), the lines' colours, "explain these lines", and the
// map links a commit's hunks change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { hunksOf, parsePatch } from "../../src/lib/history.ts";
import { type El, textOf, walk } from "../../src/lib/repo-view.ts";
import {
  commitTouches,
  explainLines,
  hunksTouch,
  lineMarks,
  locate,
  locateBySymbol,
  pairClass,
  type PaperForMaps,
  parsePermalink,
  relocate,
  repoKey,
  tracedEntries,
  type TracedMap,
  tracedNote,
  tracedUrl,
} from "../../src/lib/traced.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

const paper = (over: Partial<PaperForMaps> = {}): PaperForMaps => ({
  slug: "doi_10.5555_x",
  title: "A study",
  doi: "doi:10.5555/x",
  code: [{ repo: "github.com/Lab/Tool", commit: SHA }],
  card: null,
  method: "lexical-v1",
  pairs: [
    { pair: 2, paragraph: 5, section: "Results", repo: "github.com/Lab/Tool", path: "plot.py", start_line: 4, end_line: 6, symbol: "show" },
    { pair: 1, paragraph: 3, section: "Methods › Spectral analysis", repo: "github.com/Lab/Tool", path: "analysis.py", start_line: 6, end_line: 10, symbol: "band_power" },
  ],
  ...over,
});

describe("the shards", () => {
  test("maps grouped by repository, at the pinned commit, sorted, with no paper text", () => {
    const maps = tracedEntries([paper({ card: { doi: "10.5281/zenodo.1" } })]);
    assert.deepEqual([...maps.keys()], ["lab/tool"]);
    const [m] = maps.get("lab/tool")!;
    assert.equal(m.commit, SHA);
    assert.equal(m.doi, "10.5555/x");
    assert.equal(m.validated, true);
    assert.equal(m.mapDoi, "10.5281/zenodo.1");
    assert.deepEqual(m.pairs.map((p) => p.pair), [1, 2]);
    assert.deepEqual(Object.keys(m.pairs[0]).sort(), ["end", "pair", "paragraph", "path", "section", "start", "symbol"]);
    assert.equal(tracedUrl("07"), "/forge/traced/07.json");
  });

  test("pairs without a commit, a sound path or range, or on another host are left out", () => {
    const bad = paper({
      code: [{ repo: "github.com/lab/tool", commit: "not-a-sha" }],
    });
    assert.equal(tracedEntries([bad]).size, 0);
    const odd = paper({
      pairs: [
        { pair: 1, paragraph: 1, section: "", repo: "gitlab.com/lab/tool", path: "a.py", start_line: 1, end_line: 2, symbol: "" },
        { pair: 2, paragraph: 1, section: "", repo: "github.com/lab/tool", path: "../a.py", start_line: 1, end_line: 2, symbol: "" },
        { pair: 3, paragraph: 1, section: "", repo: "github.com/lab/tool", path: "a.py", start_line: 5, end_line: 2, symbol: "" },
        { pair: 4, paragraph: 1, section: "", repo: "github.com/lab/tool", path: "a.py", start_line: 1, end_line: 2, symbol: "f" },
      ],
    });
    assert.deepEqual(tracedEntries([odd]).get("lab/tool")![0].pairs.map((p) => p.pair), [4]);
    assert.equal(repoKey("https://github.com/Lab/Tool.git"), "lab/tool");
    assert.equal(repoKey("gitlab.com/lab/tool"), null);
  });
});

describe("permalinks", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/permalinks.json", import.meta.url), "utf8")) as {
    web: string;
    sites: string[];
    cases: { url: string; point: unknown }[];
  };
  test("the same trace points as the Mac (tests/fixtures/permalinks.json)", () => {
    assert.ok(fixture.cases.length >= 30);
    for (const c of fixture.cases) assert.deepEqual(parsePermalink(c.url, { web: fixture.web, sites: fixture.sites }), c.point, c.url);
  });
});

describe("the lines a map links, in the version shown", () => {
  const v1 = ["import numpy", "", "def band_power(x):", "    f = welch(x)", "    return f", "", "def other():", "    pass"];
  const v2 = ["import numpy", "import scipy", "", "# band power", "def band_power(x):", "    f = welch(x)", "    return f", "", "def other():", "    pass"];

  test("relocate: the same lines where they are now; nothing when they changed", () => {
    assert.deepEqual(relocate(v1, v2, 3, 5), { start: 5, end: 7 });
    assert.deepEqual(relocate(v1, v1, 3, 5), { start: 3, end: 5 });
    assert.equal(relocate(v1, v2.map((l) => l.replace("welch", "periodogram")), 3, 5), null);
    assert.equal(relocate(v1, v2, 2, 2), null, "a blank line alone cannot be found again");
    assert.equal(relocate(v1, v2, 7, 99), null);
    assert.deepEqual(relocate(["a  ", "b"], ["x", "a", "b"], 1, 2), { start: 2, end: 3 }, "trailing spaces do not count");
  });

  test("the nearest copy when the lines appear twice", () => {
    const dup = ["x", "y", "z", "x", "y"];
    assert.deepEqual(relocate(["q", "q", "q", "x", "y"], dup, 4, 5), { start: 4, end: 5 });
  });

  test("by its symbol when the map's commit is gone", () => {
    assert.deepEqual(locateBySymbol(v2, 5, 7, "band_power"), { start: 5, end: 7 }, "its definition is in the lines");
    assert.deepEqual(locateBySymbol(v2, 1, 3, "band_power"), { start: 5, end: 7 }, "moved to the definition");
    assert.deepEqual(locateBySymbol(["x = band_power(y)", "z"], 1, 2, "band_power"), { start: 1, end: 2 }, "no definition, the name in the lines");
    assert.deepEqual(locateBySymbol(["power <- function(x) {", "  x", "}"], 9, 10, "power"), { start: 1, end: 2 });
    assert.equal(locateBySymbol(v2, 1, 2, "missing"), null);
    assert.equal(locateBySymbol(v2, 1, 2, "not a name!"), null);
  });

  test("locate: exact at the map's commit, moved at another, by symbol when the commit is gone", async () => {
    const map = tracedEntries([paper({ pairs: [{ pair: 1, paragraph: 3, section: "Methods", repo: "github.com/lab/tool", path: "a.py", start_line: 3, end_line: 5, symbol: "band_power" }] })]).get("lab/tool")!;
    const exact = await locate(map, "a.py", SHA, v1, async () => assert.fail("no read at the map's commit"));
    assert.deepEqual(exact.map((l) => [l.how, l.lines]), [["exact", { start: 3, end: 5 }]]);
    const moved = await locate(map, "a.py", OTHER, v2, async (c) => (c === SHA ? v1 : null));
    assert.deepEqual(moved.map((l) => [l.how, l.lines]), [["moved", { start: 5, end: 7 }]]);
    const gone = await locate(map, "a.py", OTHER, v2, async () => null);
    assert.deepEqual(gone.map((l) => [l.how, l.lines]), [["symbol", { start: 3, end: 5 }]], "its definition is in the same lines");
    const goneMoved = await locate(map, "a.py", OTHER, ["# a", "# b", "# c", "# d", "# e", "# f", "def band_power(x):", "  pass"], async () => null);
    assert.deepEqual(goneMoved.map((l) => [l.how, l.lines]), [["symbol", { start: 7, end: 8 }]], "moved to its definition");
    const lost = await locate(map, "a.py", OTHER, ["nothing here"], async () => v1);
    assert.deepEqual(lost.map((l) => [l.how, l.lines]), [["lost", null]]);
    assert.deepEqual(await locate(map, "b.py", SHA, v1, async () => v1), [], "another file");
  });

  test("the lines' colours are the reader's", async () => {
    const maps = tracedEntries([paper()]).get("lab/tool")!;
    const found = await locate(maps, "analysis.py", SHA, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`), async () => null);
    const marks = lineMarks(found);
    assert.deepEqual([...marks.keys()], [6, 7, 8, 9, 10]);
    assert.equal(marks.get(6), "traced pair-1");
    assert.equal(pairClass(7), "pair-1");
    assert.equal(pairClass(12), "pair-6");
  });
});

describe("in words", () => {
  const maps = (): TracedMap[] => tracedEntries([paper({ card: { doi: "10.5281/zenodo.1" } })]).get("lab/tool")!;

  test("the note: each range selects its lines, each paragraph opens the paper beside the code", async () => {
    const found = await locate(maps(), "analysis.py", SHA, Array.from({ length: 12 }, () => "x"), async () => null);
    const note = tracedNote(found, SHA)!;
    const hrefs = [...walk(note)].filter((e) => e.tag === "a").map((a) => a.attrs.href);
    assert.deepEqual(hrefs, ["/paper/doi_10.5555_x/", "#L6-L10", "/paper/doi_10.5555_x/code/#pair-1"]);
    assert.match(textOf(note), /validated by an author/);
    assert.match(textOf(note), /Paragraph 3 of Methods › Spectral analysis/);
    assert.doesNotMatch(JSON.stringify(note), /github\.com/, "never sends the reader to GitHub");
    assert.equal(tracedNote([], SHA), null);
  });

  test("at another commit the note says where the map was made; a lost range says so", async () => {
    const found = await locate(maps(), "analysis.py", OTHER, ["nothing"], async () => ["a", "b", "c", "d", "e", "def band_power(): pass", "x", "y", "z", "w"]);
    const note = tracedNote(found, OTHER)!;
    assert.match(textOf(note), /made at commit 0123456/);
    assert.match(textOf(note), /lines 6 to 10 at 0123456, changed since/);
  });

  test("explain these lines: the paragraphs linked to the selection", async () => {
    const found = await locate(maps(), "analysis.py", SHA, Array.from({ length: 12 }, () => "x"), async () => null);
    const said = explainLines(found, { start: 9, end: 20 })!;
    assert.match(textOf(said), /Paragraph 3 of Methods › Spectral analysis of A study/);
    assert.equal(explainLines(found, { start: 1, end: 5 }), null);
  });
});

describe("a commit: the map links it changed", () => {
  test("hunks touch a range by a deleted line in it or a line added inside it", () => {
    const old = ["a", "b", "c", "d", "e", "f"];
    const edited = ["a", "b", "C", "d", "e", "f"];
    const hunks = hunksOf(old.join("\n"), edited.join("\n"), 0);
    assert.ok(hunksTouch(hunks, { start: 2, end: 4 }));
    assert.ok(!hunksTouch(hunks, { start: 4, end: 6 }));
    const added = hunksOf(old.join("\n"), ["a", "b", "new", "c", "d", "e", "f"].join("\n"), 0);
    assert.ok(hunksTouch(added, { start: 2, end: 3 }), "a line added between lines 2 and 3");
    assert.ok(!hunksTouch(added, { start: 3, end: 4 }), "added before the range");
    assert.ok(!hunksTouch(added, { start: 1, end: 2 }), "added after the range");
    const patch = parsePatch("@@ -6,5 +6,6 @@\n def band_power(x):\n-    f = welch(x)\n+    f = welch(x, nperseg=512)\n+    f = f * 2\n     return f\n");
    assert.ok(hunksTouch(patch, { start: 6, end: 10 }));
    assert.ok(!hunksTouch(patch, { start: 1, end: 5 }));
  });

  test("the block says which links changed, which were kept, which could not be found", () => {
    const [map] = tracedEntries([paper()]).get("lab/tool")!;
    const el = commitTouches([
      { map, pair: map.pairs[0], path: "analysis.py", state: "changed" },
      { map, pair: map.pairs[1], path: "plot.py", state: "unknown" },
    ])!;
    const text = textOf(el);
    assert.match(text, /This commit changed lines that a tracing map links to a paper/);
    assert.match(text, /analysis\.py lines 6 to 10 at 0123456: Paragraph 3 of Methods › Spectral analysis of A study/);
    assert.match(text, /One link could not be found/);
    const kept = commitTouches([{ map, pair: map.pairs[0], path: "analysis.py", state: "kept" }])!;
    assert.match(textOf(kept), /changed a file a tracing map links, not the linked lines/);
    assert.equal(commitTouches([]), null);
    assert.ok([...walk(el as El)].every((e) => e.tag !== "a" || e.attrs.href.startsWith("/paper/")));
  });
});
