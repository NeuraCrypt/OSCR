// The registry's own statistics charts (night phase 12, E1; docs/STATISTICS.md). Pure functions, no
// DOM, no network: they turn numbers into a view tree (src/lib/repo-view.ts `h`), so they are tested
// in Node (tests/forge-pages/stats-view.test.ts) and rendered in the browser by toDom.
//
// GitHub is the competitor: every statistic is drawn here, in the registry's own inline SVG, never a
// chart library and never a GitHub image (binding directive of phase 12). Each chart is ALSO a table
// (`dataTable`) with a CSV download (`toCsv`); the PNG download rasterises the live SVG in the
// browser (src/scripts/repo-insights.ts), so it is not this module's concern.
//
// Colour is never an attribute: the shapes carry geometry only, and science.css's `.chart` classes
// give them colour, so a chart reads the same in light and dark. The research marks (commits a paper
// or a map cites, tags tied to a paper version or a DOI) are overlaid from OSCR's own facts, handed
// in as `marks`; this module does not know where they come from (E2/E3 read the layer or the API).

import { number } from "./format.ts";
import { h } from "./repo-view.ts";
import type { El } from "./repo-view.ts";

// ─── the shapes a chart is built from ────────────────────────────────────────

/** A point in a time series: a Unix-seconds timestamp and a value. */
export interface Point {
  t: number;
  v: number;
}

/** One line of a time-series chart. `tone` picks a science.css colour class (.series-1…6). */
export interface Series {
  label: string;
  points: Point[];
  tone?: number;
  /** A step line (stars over time): the value holds until the next point. */
  step?: boolean;
  /** Fill the area under the line (a single-series chart reads better filled). */
  area?: boolean;
}

/** A research mark overlaid on a time-series chart: what a paper or a map cites, or a tag tied to a
 *  paper version or a DOI. It is OSCR's own fact, never read from GitHub. */
export interface ResearchMark {
  t: number;
  kind: "paper" | "map" | "tag";
  label: string;
}

const W = 720;
const H = 220;
const PAD = { left: 10, right: 10, top: 14, bottom: 26 } as const;
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** A number rounded to at most 2 decimals, as a stable string for an SVG coordinate. */
const coord = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "0");

/** The day of a Unix-seconds timestamp, as YYYY-MM-DD in UTC (a chart's x labels and a table's key). */
export function dayOf(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

// ─── the time-series chart (commit activity, participation, star history) ─────

export interface TimeSeriesOptions {
  title: string;
  series: Series[];
  marks?: ResearchMark[];
  /** The unit named in the value labels and the caption ("commits", "stars"). */
  unit?: string;
  /** Force the y axis to start at zero (counts), rather than at the data's minimum. */
  zero?: boolean;
  /** A short caption under the chart. */
  caption?: string;
}

interface Scale {
  min: number;
  max: number;
  xs: number[];
  x(t: number): number;
  y(v: number): number;
}

function buildScale(series: Series[], zero: boolean): Scale | null {
  const ts = new Set<number>();
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      ts.add(p.t);
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
  }
  if (!ts.size) return null;
  if (zero) min = Math.min(min, 0);
  if (min === max) {
    // A flat series: give it a band so the line sits in the middle.
    max = min + 1;
  }
  const times = [...ts].sort((a, b) => a - b);
  const tMin = times[0];
  const tMax = times[times.length - 1];
  const span = tMax - tMin || 1;
  const x = (t: number): number => PAD.left + ((t - tMin) / span) * PLOT_W;
  const y = (v: number): number => PAD.top + (1 - (v - min) / (max - min)) * PLOT_H;
  return { min, max, xs: times.map(x), x, y };
}

function linePath(points: Point[], sc: Scale, step: boolean): string {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let d = "";
  let prevY = 0;
  sorted.forEach((p, i) => {
    const px = sc.x(p.t);
    const py = sc.y(p.v);
    if (i === 0) {
      d += `M${coord(px)} ${coord(py)}`;
    } else if (step) {
      d += `L${coord(px)} ${coord(prevY)}L${coord(px)} ${coord(py)}`;
    } else {
      d += `L${coord(px)} ${coord(py)}`;
    }
    prevY = py;
  });
  return d;
}

/** A time-series chart as an inline-SVG figure (also rendered as a table by the caller). */
export function timeSeriesChart(opts: TimeSeriesOptions): El {
  const sc = buildScale(opts.series, opts.zero ?? true);
  if (!sc) {
    return h("figure", { class: "chart chart-empty" }, h("figcaption", null, `${opts.title}: nothing to show yet.`));
  }
  const baselineY = sc.y(Math.max(sc.min, 0));
  const parts: El[] = [
    // The baseline (zero, or the floor of the band).
    h("line", { class: "axis", x1: coord(PAD.left), y1: coord(baselineY), x2: coord(W - PAD.right), y2: coord(baselineY) }),
  ];
  // The research marks first, so the lines draw over them.
  for (const m of opts.marks ?? []) {
    const mx = sc.x(m.t);
    if (!Number.isFinite(mx) || mx < PAD.left - 0.5 || mx > W - PAD.right + 0.5) continue;
    parts.push(h("line", { class: `mark mark-${m.kind}`, x1: coord(mx), y1: coord(PAD.top), x2: coord(mx), y2: coord(PAD.top + PLOT_H) },
      h("title", null, `${markWord(m.kind)}: ${m.label}`)));
    parts.push(h("circle", { class: `mark-dot mark-${m.kind}`, cx: coord(mx), cy: coord(PAD.top), r: "3" }, h("title", null, `${markWord(m.kind)}: ${m.label}`)));
  }
  opts.series.forEach((s, i) => {
    const tone = s.tone ?? i + 1;
    if (s.area) {
      const first = sc.x(Math.min(...s.points.map((p) => p.t)));
      const last = sc.x(Math.max(...s.points.map((p) => p.t)));
      const d = `${linePath(s.points, sc, !!s.step)}L${coord(last)} ${coord(baselineY)}L${coord(first)} ${coord(baselineY)}Z`;
      parts.push(h("path", { class: `area area-${tone}`, d }));
    }
    parts.push(h("path", { class: `line line-${tone}`, d: linePath(s.points, sc, !!s.step) }, h("title", null, s.label)));
  });
  // The value labels (max and min) and the date labels (first and last).
  const times = opts.series.flatMap((s) => s.points.map((p) => p.t));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  parts.push(
    h("text", { class: "tick tick-y", x: coord(PAD.left), y: coord(PAD.top - 3) }, number(Math.round(sc.max))),
    h("text", { class: "tick tick-x", x: coord(PAD.left), y: coord(H - 8) }, dayOf(tMin)),
    h("text", { class: "tick tick-x tick-end", x: coord(W - PAD.right), y: coord(H - 8), "text-anchor": "end" }, dayOf(tMax)),
  );
  return h(
    "figure",
    { class: "chart chart-line" },
    h("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": chartAria(opts) }, ...parts),
    legend(opts.series, opts.marks ?? []),
    opts.caption ? h("figcaption", null, opts.caption) : null,
  );
}

function chartAria(opts: TimeSeriesOptions): string {
  const n = opts.series.reduce((m, s) => Math.max(m, s.points.length), 0);
  return `${opts.title}: ${number(n)} points${opts.unit ? ` of ${opts.unit}` : ""}. The table below gives every value.`;
}

const markWord = (k: ResearchMark["kind"]): string => (k === "paper" ? "Cited by a paper" : k === "map" ? "On a tracing map" : "Tagged for a paper or a DOI");

// ─── a diverging column chart (code frequency: additions up, deletions down) ──

export interface DivergingPoint {
  t: number;
  up: number;
  down: number;
}

export interface DivergingOptions {
  title: string;
  points: DivergingPoint[];
  upLabel: string;
  downLabel: string;
  caption?: string;
}

/** Additions above a zero line, deletions below: the shape of a repository's churn over time. */
export function divergingColumns(opts: DivergingOptions): El {
  const pts = [...opts.points].sort((a, b) => a.t - b.t);
  if (!pts.length) return h("figure", { class: "chart chart-empty" }, h("figcaption", null, `${opts.title}: nothing to show yet.`));
  const maxUp = Math.max(1, ...pts.map((p) => p.up));
  const maxDown = Math.max(1, ...pts.map((p) => Math.abs(p.down)));
  const span = maxUp + maxDown;
  const zeroY = PAD.top + (maxUp / span) * PLOT_H;
  const bw = PLOT_W / pts.length;
  const barW = Math.max(1, bw * 0.7);
  const parts: El[] = [];
  pts.forEach((p, i) => {
    const cx = PAD.left + (i + 0.5) * bw;
    const x = cx - barW / 2;
    const upH = (p.up / span) * PLOT_H;
    const downH = (Math.abs(p.down) / span) * PLOT_H;
    if (p.up) parts.push(h("rect", { class: "col col-up", x: coord(x), y: coord(zeroY - upH), width: coord(barW), height: coord(upH) }, h("title", null, `${dayOf(p.t)}: +${number(p.up)} ${opts.upLabel}`)));
    if (p.down) parts.push(h("rect", { class: "col col-down", x: coord(x), y: coord(zeroY), width: coord(barW), height: coord(downH) }, h("title", null, `${dayOf(p.t)}: -${number(Math.abs(p.down))} ${opts.downLabel}`)));
  });
  parts.push(h("line", { class: "axis", x1: coord(PAD.left), y1: coord(zeroY), x2: coord(W - PAD.right), y2: coord(zeroY) }));
  parts.push(
    h("text", { class: "tick tick-y", x: coord(PAD.left), y: coord(PAD.top - 3) }, `+${number(maxUp)}`),
    h("text", { class: "tick tick-x", x: coord(PAD.left), y: coord(H - 8) }, dayOf(pts[0].t)),
    h("text", { class: "tick tick-x tick-end", x: coord(W - PAD.right), y: coord(H - 8), "text-anchor": "end" }, dayOf(pts[pts.length - 1].t)),
  );
  return h(
    "figure",
    { class: "chart chart-diverging" },
    h("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": `${opts.title}: ${number(pts.length)} weeks. The table below gives every value.` }, ...parts),
    h("p", { class: "chart-legend" },
      h("span", { class: "key key-up" }, opts.upLabel), " ",
      h("span", { class: "key key-down" }, opts.downLabel)),
    opts.caption ? h("figcaption", null, opts.caption) : null,
  );
}

// ─── ranked horizontal bars (contributors, popular content, referrers) ────────

export interface RankedBar {
  label: string;
  value: number;
  /** An optional sub-value shown after the label (a contributor's additions, say). */
  note?: string;
}

export interface RankedOptions {
  title: string;
  bars: RankedBar[];
  unit: string;
  /** How many to draw (the rest stay in the table). */
  top?: number;
  caption?: string;
}

/** A horizontal bar per row, longest first, the value at the end: contributors, referrers, pages. */
export function rankedBars(opts: RankedOptions): El {
  const sorted = [...opts.bars].sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, opts.top ?? 10);
  if (!shown.length) return h("figure", { class: "chart chart-empty" }, h("figcaption", null, `${opts.title}: nothing to show yet.`));
  const max = Math.max(1, ...shown.map((b) => b.value));
  const rowH = 22;
  const chartH = shown.length * rowH + 6;
  const parts: El[] = [];
  shown.forEach((b, i) => {
    const y = i * rowH + 3;
    const w = (b.value / max) * PLOT_W;
    parts.push(h("rect", { class: `bar bar-${(i % 6) + 1}`, x: coord(PAD.left), y: coord(y), width: coord(Math.max(1, w)), height: "15" }, h("title", null, `${b.label}: ${number(b.value)} ${opts.unit}`)));
    parts.push(h("text", { class: "bar-label", x: coord(PAD.left + 4), y: coord(y + 11) }, b.label));
    parts.push(h("text", { class: "bar-value", x: coord(W - PAD.right), y: coord(y + 11), "text-anchor": "end" }, number(b.value)));
  });
  return h(
    "figure",
    { class: "chart chart-ranked" },
    h("svg", { viewBox: `0 0 ${W} ${chartH}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": `${opts.title}: ${number(shown.length)} of ${number(sorted.length)} rows. The table below gives every value.` }, ...parts),
    opts.caption ? h("figcaption", null, opts.caption) : null,
  );
}

// ─── the legend, the table and the CSV every chart carries ────────────────────

function legend(series: Series[], marks: ResearchMark[]): El | null {
  const items: El[] = [];
  if (series.length > 1) {
    series.forEach((s, i) => items.push(h("span", { class: `key series-${s.tone ?? i + 1}` }, s.label)));
  }
  const kinds = new Set(marks.map((m) => m.kind));
  for (const k of kinds) items.push(h("span", { class: `key mark-${k}` }, markWord(k)));
  return items.length ? h("p", { class: "chart-legend" }, ...items) : null;
}

/** A chart's data as a table (every chart is also a table). `rows` are already strings. */
export function dataTable(caption: string, headers: string[], rows: string[][]): El {
  return h(
    "table",
    { class: "chart-table" },
    h("caption", null, caption),
    h("thead", null, h("tr", null, ...headers.map((head) => h("th", null, head)))),
    h("tbody", null, ...rows.map((r) => h("tr", null, ...r.map((cell, i) => h(i === 0 ? "th" : "td", null, cell))))),
  );
}

/** RFC 4180 CSV of a table (a field with a comma, a quote or a newline is quoted; quotes doubled). */
export function toCsv(headers: string[], rows: string[][]): string {
  const cell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = (r: string[]): string => r.map(cell).join(",");
  return [line(headers), ...rows.map(line)].join("\r\n") + "\r\n";
}
