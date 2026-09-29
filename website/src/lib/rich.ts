// The other rich files of a repository (night phase 02, E5): what the viewer says of a file it
// shows as source, or reads without drawing. Pure, no DOM, testable in Node
// (tests/forge-pages/table.test.ts).
//
// - GeoJSON and TopoJSON: a map needs a tile service outside the registry (D02-8): the viewer shows
//   the data and says what it holds (the collection, its features by geometry).
// - STL: a 3D model; its triangles counted (ASCII or binary); the 3D view is deferred.
// - Mermaid files (.mmd, .mermaid): the source (drawing it needs styles the pages' policy forbids).
// - Other markups (reStructuredText, AsciiDoc, Org, Textile, RDoc, Pod, Creole, MediaWiki): the
//   source, with a sentence.
// - PDF: its bytes checked ("%PDF-"), opened in the browser's own PDF viewer from an object URL of
//   type application/pdf (a PDF never becomes a page of this site) or downloaded.

import { plural } from "./format.ts";
import { type El, h } from "./repo-view.ts";

const MARKUPS: [RegExp, string][] = [
  [/\.(?:rst|rest)$/i, "reStructuredText"],
  [/\.(?:adoc|asciidoc|asc)$/i, "AsciiDoc"],
  [/\.org$/i, "Org"],
  [/\.textile$/i, "Textile"],
  [/\.rdoc$/i, "RDoc"],
  [/\.pod6?$/i, "Pod"],
  [/\.creole$/i, "Creole"],
  [/\.(?:mediawiki|wiki)$/i, "MediaWiki"],
];

/** A GeoJSON or TopoJSON text in words: "A GeoJSON FeatureCollection of 12 features (10 Point,
 *  2 Polygon)"; null when it is not one. */
export function geoSummary(path: string, text: string): string | null {
  const geo = /\.geojson$/i.test(path);
  const topo = /\.topojson$/i.test(path);
  if (!geo && !topo && !/\.json$/i.test(path)) return null;
  if (text.length > 20_000_000) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const o = j as { type?: unknown; features?: unknown; geometries?: unknown; objects?: unknown };
  if (!o || typeof o !== "object") return null;
  const kinds = new Map<string, number>();
  const add = (t: unknown) => typeof t === "string" && kinds.set(t, (kinds.get(t) ?? 0) + 1);
  if (o.type === "Topology" && o.objects && typeof o.objects === "object") {
    const names = Object.keys(o.objects as object);
    return `A TopoJSON topology of ${plural(names.length, "object")}${names.length ? ` (${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""})` : ""}.`;
  }
  if (o.type === "FeatureCollection" && Array.isArray(o.features)) {
    for (const f of o.features as { geometry?: { type?: unknown } | null }[]) add(f?.geometry?.type ?? "no geometry");
    const said = [...kinds].map(([k, n]) => `${n.toLocaleString("en-GB")} ${k}`).join(", ");
    return `A GeoJSON FeatureCollection of ${plural((o.features as unknown[]).length, "feature")}${said ? ` (${said})` : ""}.`;
  }
  if (o.type === "GeometryCollection" && Array.isArray(o.geometries)) return `A GeoJSON GeometryCollection of ${plural((o.geometries as unknown[]).length, "geometry", "geometries")}.`;
  if (o.type === "Feature" || ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(String(o.type))) return `A GeoJSON ${String(o.type)}.`;
  return geo || topo ? "A map file the viewer could not read as GeoJSON or TopoJSON." : null;
}

/** An STL model's triangles: binary (80-byte header, then a count) or ASCII ("facet" lines). */
export function stlTriangles(bytes: Uint8Array): { format: "binary" | "ASCII"; triangles: number } | null {
  if (bytes.length >= 84) {
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + n * 50 === bytes.length) return { format: "binary", triangles: n };
  }
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
  if (/^\s*solid\b/i.test(head)) {
    const text = new TextDecoder("latin1").decode(bytes);
    return { format: "ASCII", triangles: (text.match(/\bfacet\s+normal\b/gi) ?? []).length };
  }
  return null;
}

/** The sentence above a file the viewer shows as source although it is more than text; null for
 *  plain source. */
export function richNote(path: string, text: string | null, bytes: Uint8Array): El | null {
  const say = (...kids: (string | El)[]) => h("p", { class: "rich-note" }, ...kids);
  if (/\.(?:geojson|topojson)$/i.test(path) || (/\.json$/i.test(path) && text && /"type"\s*:\s*"(?:FeatureCollection|Topology|GeometryCollection)"/.test(text.slice(0, 4096)))) {
    const s = text ? geoSummary(path, text) : null;
    if (s) return say(`${s} Drawing it as a map needs a tile service outside the registry: the viewer shows its data.`);
  }
  if (/\.stl$/i.test(path)) {
    const t = stlTriangles(bytes);
    return say(t ? `An STL 3D model (${t.format}) of ${plural(t.triangles, "triangle")}.` : "An STL 3D model.", " The viewer does not draw it in 3D yet: its source is below, or download it for a 3D program.");
  }
  if (/\.(?:mmd|mermaid)$/i.test(path)) return say("A Mermaid diagram: the viewer shows its source (drawing it needs styles the pages' policy does not allow).");
  for (const [re, name] of MARKUPS) if (re.test(path)) return say(`${name}: the viewer shows its source.`);
  return null;
}

/** Whether bytes are a PDF (its signature in the first kilobyte, as readers accept it). */
export const isPdf = (bytes: Uint8Array): boolean => new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
