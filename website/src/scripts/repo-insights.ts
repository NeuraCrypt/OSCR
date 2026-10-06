// insights/: the Insights tab of a repository (night phase 12, E1/E2; docs/STATISTICS.md).
//
// GitHub is the competitor, so every statistic is drawn in the registry's OWN charts (inline SVG,
// src/lib/stats-view.ts), never a chart library and never a GitHub image. The reader's browser reads
// GitHub's statistics API DIRECTLY (0 Worker and 0 Mac requests: a discreet "read at the source"
// note), on the reader's own quota; GitHub answers 202 with no body while it computes a statistic, so
// each read retries a few times and says "GitHub is still computing" if it is not ready. The research
// marks (a commit a paper or a map cites, a tag tied to a paper version or a DOI) and the star history
// are OSCR's own facts, read from GET /api/forge/stats; "Used by" is drawn by repo-usedby.ts (E3).
//
// Every chart is also a table, with a CSV download and a PNG download (the PNG is rasterised from the
// live SVG in the browser, colours inlined, so nothing leaves the page). Like every browser script,
// it never names the platform.

import type { StatsFacts } from "../lib/stats.ts";
import {
  dataTable, dayOf, divergingColumns, parseCodeFrequency, parseCommitActivity, parseContributors, parseParticipation,
  rankedBars, timeSeriesChart, toCsv,
  type DivergingPoint, type Point, type RankedBar, type ResearchMark,
} from "../lib/stats-view.ts";
import { h } from "../lib/repo-view.ts";
import { number } from "../lib/format.ts";
import { show, toDom } from "./dom.ts";
import { getJson } from "./social-client.ts";
import { codeViews, type CodeEnv } from "./repo-code.ts";

/** The result of reading one of GitHub's statistics in the browser. */
type StatResult = { state: "ok"; data: unknown } | { state: "computing" } | { state: "empty" } | { state: "failed"; status: number };

/** Read one GitHub statistics endpoint directly, on the reader's quota. GitHub answers 202 (no body)
 *  while it computes; retry a few times, then say so. 204 means an empty repository. */
async function readStat(env: CodeEnv, name: string, tries = 4): Promise<StatResult> {
  const url = `${env.endpoints.api}/repos/${encodeURIComponent(env.repo.owner)}/${encodeURIComponent(env.repo.name)}/stats/${name}`;
  for (let i = 0; i < tries; i++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    } catch {
      return { state: "failed", status: 0 };
    }
    if (res.status === 202) {
      await new Promise((r) => setTimeout(r, 900 * (i + 1)));
      continue;
    }
    if (res.status === 204) return { state: "empty" };
    if (!res.ok) return { state: "failed", status: res.status };
    try {
      return { state: "ok", data: await res.json() };
    } catch {
      return { state: "failed", status: res.status };
    }
  }
  return { state: "computing" };
}

/** OSCR's own facts (research marks, star history, used-by), signed in; graceful when absent. */
async function readFacts(env: CodeEnv): Promise<StatsFacts | null> {
  const id = env.layer?.id ?? env.info.key.id;
  if (!id) return null;
  try {
    const r = await getJson(`/api/forge/stats?id=${encodeURIComponent(`${env.info.key.forge}:${id}`)}`);
    if (!r.ok) return null;
    return r.body as unknown as StatsFacts;
  } catch {
    return null;
  }
}

/** A section's slot, with a heading and a "reading" line until its chart is ready. */
function section(id: string, title: string): HTMLElement {
  const s = document.createElement("section");
  s.dataset.stat = id;
  s.append(toDom(h("h3", null, title)), toDom(h("p", { "aria-live": "polite" }, "Reading at the source…")));
  return s;
}

/** Put a chart, its table (folded), and its downloads into a section. */
function place(sec: HTMLElement, chart: ReturnType<typeof h>, table: { caption: string; headers: string[]; rows: string[][] } | null, base: string): void {
  const box = document.createElement("div");
  box.className = "figure-with-table";
  box.append(toDom(chart));
  if (table && table.rows.length) {
    const details = document.createElement("details");
    details.className = "chart-data";
    details.append(toDom(h("summary", null, "The numbers")));
    details.append(toDom(dataTable(table.caption, table.headers, table.rows)));
    box.append(details);
    box.append(downloads(base, table, box));
  }
  const heading = sec.querySelector("h3");
  sec.replaceChildren(...(heading ? [heading] : []), box);
}

/** The CSV and PNG download buttons for a chart. */
function downloads(base: string, table: { headers: string[]; rows: string[][] }, box: HTMLElement): HTMLElement {
  const bar = document.createElement("p");
  bar.className = "chart-downloads";
  const csv = document.createElement("button");
  csv.type = "button";
  csv.textContent = "Download CSV";
  csv.addEventListener("click", () => saveBlob(new Blob([toCsv(table.headers, table.rows)], { type: "text/csv;charset=utf-8" }), `${base}.csv`));
  const png = document.createElement("button");
  png.type = "button";
  png.textContent = "Download PNG";
  png.addEventListener("click", () => {
    const svg = box.querySelector("svg");
    if (svg) svgToPng(svg, `${base}.png`);
  });
  bar.append(csv, png);
  return bar;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The SVG properties to carry into the clone so the PNG renders in colour on its own. */
const INLINE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-size", "font-family", "text-anchor"];

/** Rasterise the live SVG to a PNG in the browser (colours inlined from the page's computed styles),
 *  so the exported image is self-contained and nothing of the page leaves. */
function svgToPng(svg: SVGSVGElement, filename: string): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const origs = [svg, ...svg.querySelectorAll("*")];
  const clones = [clone, ...clone.querySelectorAll("*")];
  origs.forEach((node, i) => {
    const target = clones[i] as SVGElement | undefined;
    if (!target || !(node instanceof Element)) return;
    const cs = getComputedStyle(node as Element);
    for (const prop of INLINE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== "none" && v !== "normal") target.setAttribute(prop, v);
      else if (v === "none" && (prop === "fill" || prop === "stroke")) target.setAttribute(prop, "none");
    }
  });
  const vb = (svg.getAttribute("viewBox") ?? "0 0 720 220").split(/\s+/).map(Number);
  const scale = 2;
  const w = (vb[2] || 720) * scale;
  const hgt = (vb[3] || 220) * scale;
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(hgt));
  const xml = new XMLSerializer().serializeToString(clone);
  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', xml], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = hgt;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff";
      ctx.fillRect(0, 0, w, hgt);
      ctx.drawImage(img, 0, 0, w, hgt);
      canvas.toBlob((out) => {
        if (out) saveBlob(out, filename);
        URL.revokeObjectURL(url);
      }, "image/png");
    }
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function saySection(sec: HTMLElement, words: string, cls = ""): void {
  const heading = sec.querySelector("h3");
  sec.replaceChildren(...(heading ? [heading] : []), toDom(h("p", cls ? { class: cls } : null, words)));
}

const COMPUTING = "The source is still computing this statistic. Reload in a moment.";
const failedWords = (status: number): string =>
  status === 0 || status >= 500
    ? "This statistic could not be read at the source just now."
    : status === 403 || status === 429
      ? "The source's hourly limit for anonymous readers is spent; it resets within the hour."
      : status === 404
        ? "The source does not expose this statistic."
        : "This statistic could not be read.";

// ─── the sections ─────────────────────────────────────────────────────────────

async function mountCommitActivity(sec: HTMLElement, env: CodeEnv, marks: ResearchMark[]): Promise<void> {
  const r = await readStat(env, "commit_activity");
  if (r.state === "computing") return saySection(sec, COMPUTING, "warning");
  if (r.state === "empty") return saySection(sec, "No commits in the last year.");
  if (r.state === "failed") return saySection(sec, failedWords(r.status), "warning");
  const pts: Point[] = parseCommitActivity(r.data);
  const chart = timeSeriesChart({
    title: "Commits per week", unit: "commits", series: [{ label: "Commits", points: pts, area: true, tone: 1 }],
    marks, caption: "Read at the source. A dashed mark is a commit a paper or a map cites.",
  });
  place(sec, chart, { caption: "Commits per week", headers: ["Week", "Commits"], rows: pts.map((p) => [dayOf(p.t), number(p.v)]) }, `${env.repo.name}-commits`);
}

async function mountParticipation(sec: HTMLElement, env: CodeEnv): Promise<void> {
  const r = await readStat(env, "participation");
  if (r.state === "computing") return saySection(sec, COMPUTING, "warning");
  if (r.state === "failed") return saySection(sec, failedWords(r.status), "warning");
  if (r.state === "empty") return saySection(sec, "No activity to show.");
  const { all, owner } = parseParticipation(r.data, Math.floor(Date.now() / 1000));
  if (!all.length) return saySection(sec, "No activity to show.");
  const chart = timeSeriesChart({
    title: "Weekly commits: everyone and the owner", unit: "commits",
    series: [{ label: "Everyone", points: all, tone: 2 }, { label: "Repository owner", points: owner, tone: 4 }],
    caption: "Read at the source. The last 52 weeks.",
  });
  const rows = all.map((p, i) => [dayOf(p.t), number(p.v), number(owner[i]?.v ?? 0)]);
  place(sec, chart, { caption: "Weekly commits", headers: ["Week", "Everyone", "Owner"], rows }, `${env.repo.name}-participation`);
}

async function mountCodeFrequency(sec: HTMLElement, env: CodeEnv): Promise<void> {
  const r = await readStat(env, "code_frequency");
  if (r.state === "computing") return saySection(sec, COMPUTING, "warning");
  if (r.state === "empty") return saySection(sec, "No changes to show.");
  if (r.state === "failed") return saySection(sec, failedWords(r.status), "warning");
  const pts: DivergingPoint[] = parseCodeFrequency(r.data);
  const chart = divergingColumns({
    title: "Lines added and removed per week", points: pts, upLabel: "added", downLabel: "removed",
    caption: "Read at the source.",
  });
  place(sec, chart, { caption: "Lines added and removed per week", headers: ["Week", "Added", "Removed"], rows: pts.map((p) => [dayOf(p.t), number(p.up), number(Math.abs(p.down))]) }, `${env.repo.name}-code-frequency`);
}

async function mountContributors(sec: HTMLElement, env: CodeEnv): Promise<void> {
  const r = await readStat(env, "contributors");
  if (r.state === "computing") return saySection(sec, COMPUTING, "warning");
  if (r.state === "empty") return saySection(sec, "No contributors yet.");
  if (r.state === "failed") return saySection(sec, failedWords(r.status), "warning");
  const bars: RankedBar[] = parseContributors(r.data).slice(0, 100);
  const chart = rankedBars({
    title: "Top contributors", bars, unit: "commits", top: 10,
    caption: "Read at the source, by commit count (merge commits included). The top 10 are drawn; the table lists up to 100.",
  });
  place(sec, chart, { caption: "Contributors by commit count", headers: ["Contributor", "Commits"], rows: bars.map((b) => [b.label, number(b.value)]) }, `${env.repo.name}-contributors`);
}

function mountStars(sec: HTMLElement, env: CodeEnv, stars: Point[]): void {
  if (!stars.length) return saySection(sec, "No stars in the registry yet.");
  const chart = timeSeriesChart({
    title: "Stars in the registry over time", unit: "stars",
    series: [{ label: "Stars", points: stars, step: true, area: true, tone: 3 }],
    caption: "The registry's own stars (not GitHub's), oldest first.",
  });
  place(sec, chart, { caption: "Stars over time", headers: ["Day", "Stars"], rows: stars.map((p) => [dayOf(p.t), number(p.v)]) }, `${env.repo.name}-stars`);
}

codeViews.insights = async (slot, env) => {
  const root = document.createElement("div");
  root.className = "insights";
  root.append(toDom(h("h2", null, "Insights")));
  root.append(toDom(h("p", { class: "at-source" }, "The registry draws these charts itself. The source's own statistics are read in your browser, on your quota; the research marks and the star history are the registry's.")));
  const secCommits = section("commit_activity", "Commit activity");
  const secParticipation = section("participation", "Participation");
  const secCode = section("code_frequency", "Code frequency");
  const secContributors = section("contributors", "Contributors");
  const secStars = section("stars", "Star history");
  root.append(secCommits, secParticipation, secCode, secContributors, secStars);
  show(slot, h("div", { class: "insights" }));
  slot.replaceChildren(root);

  const facts = await readFacts(env);
  const marks = facts?.marks ?? [];
  const stars = facts?.stars ?? [];
  // The GitHub reads run together; the facts are already in.
  await Promise.all([
    mountCommitActivity(secCommits, env, marks),
    mountParticipation(secParticipation, env),
    mountCodeFrequency(secCode, env),
    mountContributors(secContributors, env),
  ]);
  mountStars(secStars, env, stars);
};
