// The registry's own statistics charts (night phase 12, E1; src/lib/stats-view.ts): pure view trees
// (inline SVG) and their table and CSV. No DOM, no network: the charts are numbers turned into an El
// tree, so they are checked here in Node.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { El } from "../../src/lib/repo-view.ts";
import { textOf } from "../../src/lib/repo-view.ts";
import {
  dataTable, dayOf, divergingColumns, rankedBars, timeSeriesChart, toCsv,
  type Point,
} from "../../src/lib/stats-view.ts";

/** Every element of a given tag in a tree. */
function find(node: string | El, tag: string): El[] {
  if (typeof node === "string") return [];
  const out: El[] = node.tag === tag ? [node] : [];
  for (const c of node.children) out.push(...find(c, tag));
  return out;
}

const WEEK = 7 * 86400;
const base = 1_700_000_000;
const series = (n: number): Point[] => Array.from({ length: n }, (_, i) => ({ t: base + i * WEEK, v: i * 2 }));

describe("toCsv", () => {
  test("quotes fields with a comma, a quote or a newline, and doubles quotes", () => {
    const csv = toCsv(["name", "n"], [["plain", "1"], ['a,b', "2"], ['say "hi"', "3"], ["line\nbreak", "4"]]);
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "name,n");
    assert.equal(lines[1], "plain,1");
    assert.equal(lines[2], '"a,b",2');
    assert.equal(lines[3], '"say ""hi""",3');
    assert.equal(lines[4], '"line\nbreak",4');
    assert.ok(csv.endsWith("\r\n"));
  });
});

describe("dayOf", () => {
  test("is the UTC day of a Unix-seconds timestamp", () => {
    assert.equal(dayOf(1_700_000_000), "2023-11-14");
  });
});

describe("timeSeriesChart", () => {
  test("draws an svg with a line path and a baseline, and labels the chart for a screen reader", () => {
    const fig = timeSeriesChart({ title: "Commits", unit: "commits", series: [{ label: "Commits", points: series(5), area: true }] });
    assert.equal(fig.tag, "figure");
    const svg = find(fig, "svg");
    assert.equal(svg.length, 1);
    assert.ok(String(svg[0].attrs["aria-label"]).includes("Commits"));
    assert.ok(find(fig, "path").some((p) => p.attrs.class?.includes("line")));
    assert.ok(find(fig, "path").some((p) => p.attrs.class?.includes("area")));
    assert.ok(find(fig, "line").some((l) => l.attrs.class === "axis"));
    // Every path carries only geometry and a class, never a colour attribute.
    for (const p of find(fig, "path")) {
      assert.ok(!("fill" in p.attrs) && !("stroke" in p.attrs), "no colour attribute on a shape");
    }
  });

  test("overlays a research mark as a dashed line and a dot, both with a title", () => {
    const fig = timeSeriesChart({
      title: "Commits", series: [{ label: "Commits", points: series(5) }],
      marks: [{ t: base + 2 * WEEK, kind: "paper", label: "Cited in Methods" }],
    });
    const markLines = find(fig, "line").filter((l) => l.attrs.class?.includes("mark") && !l.attrs.class?.includes("axis"));
    assert.equal(markLines.length, 1);
    assert.ok(markLines[0].attrs.class?.includes("mark-paper"));
    assert.equal(textOf(markLines[0]), "Cited by a paper: Cited in Methods");
    const dots = find(fig, "circle").filter((c) => c.attrs.class?.includes("mark-dot"));
    assert.equal(dots.length, 1);
  });

  test("an empty series is said in words, not drawn", () => {
    const fig = timeSeriesChart({ title: "Commits", series: [{ label: "Commits", points: [] }] });
    assert.equal(find(fig, "svg").length, 0);
    assert.ok(textOf(fig).includes("nothing to show"));
  });
});

describe("divergingColumns", () => {
  test("additions above and deletions below a zero line, each a titled rect", () => {
    const fig = divergingColumns({
      title: "Code frequency", upLabel: "added", downLabel: "removed",
      points: [{ t: base, up: 100, down: -40 }, { t: base + WEEK, up: 20, down: -60 }],
    });
    const rects = find(fig, "rect");
    assert.equal(rects.filter((r) => r.attrs.class?.includes("col-up")).length, 2);
    assert.equal(rects.filter((r) => r.attrs.class?.includes("col-down")).length, 2);
    assert.ok(textOf(rects[0]).includes("added"));
  });
});

describe("rankedBars", () => {
  test("draws the top rows longest first, each bar and value labelled", () => {
    const fig = rankedBars({
      title: "Contributors", unit: "commits", top: 2,
      bars: [{ label: "ada", value: 30 }, { label: "bob", value: 80 }, { label: "cat", value: 10 }],
    });
    const bars = find(fig, "rect");
    assert.equal(bars.length, 2, "only the top 2 are drawn");
    // The longest (bob, 80) is first.
    assert.ok(textOf(bars[0]).startsWith("bob"));
  });
});

describe("dataTable", () => {
  test("has a caption, a header row and a body, first cell a row header", () => {
    const t = dataTable("Commits by week", ["Week", "Commits"], [["2023-11-14", "4"], ["2023-11-21", "6"]]);
    assert.equal(t.tag, "table");
    assert.equal(find(t, "caption").length, 1);
    assert.equal(find(t, "thead").length, 1);
    assert.equal(find(t, "tbody")[0].children.length, 2);
    const firstBodyRow = find(t, "tbody")[0].children[0] as El;
    assert.equal((firstBodyRow.children[0] as El).tag, "th");
    assert.equal((firstBodyRow.children[1] as El).tag, "td");
  });
});
