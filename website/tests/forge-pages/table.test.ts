// CSV and TSV tables and the other rich files (night phase 02, E5): src/lib/table.ts (RFC 4180
// parsing, the header, numbered rows, numbers aligned, a ragged row said, the row limit) and
// src/lib/rich.ts (what the viewer says of a map, a 3D model, a diagram, another markup, a PDF).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { textOf, walk } from "../../src/lib/repo-view.ts";
import { geoSummary, isPdf, richNote, stlTriangles } from "../../src/lib/rich.ts";
import { parseDelimited, tableDelimiter, tableView } from "../../src/lib/table.ts";

describe("parseDelimited", () => {
  test("quotes, doubled quotes, delimiters and line breaks inside quotes, CRLF, a BOM, blank lines", () => {
    const p = parseDelimited('﻿a,b,c\r\n1,"x, y",3\n\n2,"say ""hi""","multi\nline"\n', ",");
    assert.deepEqual(p.rows, [["a", "b", "c"], ["1", "x, y", "3"], ["2", 'say "hi"', "multi\nline"]]);
    assert.equal(p.ragged, null);
    assert.equal(p.unclosed, false);
    assert.equal(p.more, 0);
  });

  test("a ragged row and an unclosed quote are found", () => {
    const p = parseDelimited("a,b\n1,2,3\n4", ",");
    assert.deepEqual(p.ragged, { row: 2, columns: 3, expected: 2 });
    assert.ok(parseDelimited('a,b\n1,"open', ",").unclosed);
  });

  test("tabs; the row limit", () => {
    assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t").rows, [["a", "b"], ["1", "2"]]);
    const big = parseDelimited(`h\n${"1\n".repeat(50)}`, ",", 11);
    assert.equal(big.rows.length, 11);
    assert.equal(big.more, 40);
    assert.equal(tableDelimiter("data/x.CSV"), ",");
    assert.equal(tableDelimiter("x.tsv"), "\t");
    assert.equal(tableDelimiter("x.txt"), null);
  });
});

describe("tableView", () => {
  test("the header, rows numbered, a column of numbers aligned right, the filter, email addresses masked", () => {
    const el = tableView(parseDelimited("subject,age,contact\n1,24,ada@example.org\n2,31,-\n", ","));
    const ths = [...walk(el)].filter((e) => e.tag === "th");
    assert.deepEqual(ths.map(textOf), ["#", "subject", "age", "contact"]);
    assert.equal(ths[2].attrs.class, "num");
    assert.equal(ths[3].attrs.class, undefined);
    const firstRow = [...walk(el)].find((e) => e.tag === "tr" && e.attrs.id === "row-2")!;
    assert.deepEqual(firstRow.children.map((c) => textOf(c as never)), ["1", "1", "24", "[email hidden]"]);
    assert.ok([...walk(el)].some((e) => e.tag === "input" && e.attrs.id === "table-filter"));
  });

  test("a ragged row and a cut are said", () => {
    const text = textOf(tableView({ ...parseDelimited("a,b\n1,2,3\n", ","), more: 10 }));
    assert.match(text, /Row 2 has 3 columns, not 2 as the header/);
    assert.match(text, /The first 1 rows of 11 are shown/);
  });
});

describe("rich files", () => {
  test("GeoJSON and TopoJSON in words", () => {
    const fc = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point" } }, { type: "Feature", geometry: { type: "Point" } }, { type: "Feature", geometry: { type: "Polygon" } }] });
    assert.equal(geoSummary("a.geojson", fc), "A GeoJSON FeatureCollection of 3 features (2 Point, 1 Polygon).");
    assert.equal(geoSummary("a.topojson", JSON.stringify({ type: "Topology", objects: { states: {}, rivers: {} } })), "A TopoJSON topology of 2 objects (states, rivers).");
    assert.equal(geoSummary("a.json", '{"a":1}'), null);
    assert.equal(geoSummary("a.geojson", "{bad"), null);
    assert.match(textOf(richNote("maps/a.geojson", fc, new Uint8Array())!), /tile service outside the registry/);
  });

  test("STL: binary and ASCII triangles", () => {
    const bin = new Uint8Array(84 + 2 * 50);
    new DataView(bin.buffer).setUint32(80, 2, true);
    assert.deepEqual(stlTriangles(bin), { format: "binary", triangles: 2 });
    const ascii = new TextEncoder().encode("solid cube\nfacet normal 0 0 1\nendfacet\nfacet normal 0 1 0\nendfacet\nendsolid");
    assert.deepEqual(stlTriangles(ascii), { format: "ASCII", triangles: 2 });
    assert.match(textOf(richNote("m.stl", null, bin)!), /An STL 3D model \(binary\) of 2 triangles/);
  });

  test("diagrams and other markups are said; plain source is not", () => {
    assert.match(textOf(richNote("d.mmd", "graph TD", new Uint8Array())!), /Mermaid diagram/);
    assert.match(textOf(richNote("docs/index.rst", "Title\n=====", new Uint8Array())!), /reStructuredText: the viewer shows its source/);
    assert.equal(richNote("a.py", "x = 1", new Uint8Array()), null);
  });

  test("a PDF by its signature", () => {
    assert.ok(isPdf(new TextEncoder().encode("%PDF-1.7\n...")));
    assert.ok(!isPdf(new TextEncoder().encode("<html>")));
  });
});
