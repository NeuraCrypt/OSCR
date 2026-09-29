// Tracing maps in the code view (night phase 02, E4): the research core of the viewer. A tracing
// map links paragraphs of a paper's Methods to line ranges of its code, at a pinned commit. The
// code view marks those lines (the reader's .pair-N colours), says which paragraphs they carry out
// ("explain these lines", with no model: the map's own links), and a commit's page lists the map
// links whose lines it changed ("ask about a commit"). Pure functions, no DOM, testable in Node
// (tests/forge-pages/traced.test.ts).
//
// - The maps reach the browser as ≤ 64 static shards, /forge/traced/NN.json (NN as the layer's:
//   the first byte of SHA-256 of "owner/name" in lower case, mod 64), built from the catalogue's
//   alignments (src/pages/forge/traced/[shard].json.ts): per repository, each paper's map with its
//   pinned commit and its pairs (path, lines, section, paragraph number, symbol). No paper text
//   ever goes into a shard: the paragraphs are read in the Code ↔ Paper reader, under its rules.
// - Trace points (forge, repository, commit, path, lines) are read from permalinks: GitHub's
//   (https://github.com/<o>/<r>/blob/<sha>/<path>#L1-L5) and the registry's own
//   (/r/<o>/<r>/blob/<sha>/<path>#L1-L5). The Mac reads them the same way (oscr/forge.py
//   `parse_permalink`; both checked against tests/fixtures/permalinks.json).
// - At another commit than the map's, the lines are found again: the map's lines, read at its
//   commit (a raw read, not counted in the reader's GitHub quota), are looked for in the version
//   shown; when the map's commit cannot be read any more, by the map's symbol.

import type { Hunk } from "./history.ts";
import { type Child, type El, h } from "./repo-view.ts";

/** A pair's colour, the Code ↔ Paper reader's own (src/lib/lines.ts `pairClass`, science.css
 *  .pair-1 … .pair-6), so that a pair has one colour in the reader and in the code view. */
export const pairClass = (pair: number): string => `pair-${((((pair - 1) % 6) + 6) % 6) + 1}`;

// ─── the shards ──────────────────────────────────────────────────────────────

/** One link of a map: lines of a file ↔ a paragraph of the paper. */
export interface TracedPair {
  pair: number;
  path: string;
  start: number;
  end: number;
  /** The paper's section heading ("Methods › Spectral analysis"), not its text. */
  section: string;
  /** The paragraph's number in the paper's body. */
  paragraph: number;
  symbol: string;
}

/** A paper's map of one repository, at its pinned commit. */
export interface TracedMap {
  /** The paper's slug: /paper/<slug>/ and its reader /paper/<slug>/code/. */
  paper: string;
  title: string;
  doi: string;
  commit: string;
  method: string;
  /** Validated by an author (then it has a Zenodo DOI). */
  validated: boolean;
  mapDoi: string | null;
  pairs: TracedPair[];
}

/** A shard: "owner/name" in lower case → the maps of that repository. */
export type TracedShard = Record<string, TracedMap[]>;

export const tracedUrl = (shard: string): string => `/forge/traced/${shard}.json`;

/** "github.com/Owner/Name" (the catalogue's form) → "owner/name"; null for another host. */
export function repoKey(repo: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(repo.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What the build reads of a paper (src/lib/catalog.ts): its slug, title, DOI, its code (the
 *  pinned commits), its card and its alignment's pairs. */
export interface PaperForMaps {
  slug: string;
  title: string;
  doi: string;
  code: { repo: string; commit: string }[];
  card: { doi?: string } | null;
  method: string;
  pairs: { pair: number; paragraph: number; section: string; repo: string; path: string; start_line: number; end_line: number; symbol: string }[];
}

/** The maps of every repository, from the papers: pairs grouped by repository, each map at the
 *  commit the paper's code was read at. Pairs without a valid commit, path or range are left out. */
export function tracedEntries(papers: readonly PaperForMaps[]): Map<string, TracedMap[]> {
  const out = new Map<string, TracedMap[]>();
  for (const p of papers) {
    const byRepo = new Map<string, TracedPair[]>();
    for (const x of p.pairs) {
      const key = repoKey(x.repo);
      if (!key || !Number.isInteger(x.start_line) || !Number.isInteger(x.end_line) || x.start_line < 1 || x.end_line < x.start_line) continue;
      if (!x.path || x.path.startsWith("/") || x.path.split("/").some((s) => s === "" || s === "." || s === "..")) continue;
      const list = byRepo.get(key) ?? [];
      list.push({ pair: x.pair, path: x.path, start: x.start_line, end: x.end_line, section: x.section, paragraph: x.paragraph, symbol: x.symbol });
      byRepo.set(key, list);
    }
    for (const [key, pairs] of byRepo) {
      const commit = p.code.find((c) => repoKey(c.repo) === key)?.commit ?? "";
      if (!SHA.test(commit)) continue;
      const map: TracedMap = {
        paper: p.slug,
        title: p.title,
        doi: p.doi.replace(/^doi:/i, ""),
        commit,
        method: p.method,
        validated: !!p.card?.doi,
        mapDoi: p.card?.doi ?? null,
        pairs: pairs.sort((a, b) => a.pair - b.pair),
      };
      out.set(key, [...(out.get(key) ?? []), map]);
    }
  }
  return out;
}

// ─── trace points: permalinks ────────────────────────────────────────────────

export interface TracePoint {
  forge: "github";
  owner: string;
  name: string;
  commit: string;
  path: string;
  lines: { start: number; end: number } | null;
}

const SEGMENT = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

/** A permalink (a file at a commit id, with its lines) → its trace point; null for anything else
 *  (a branch's address moves, so it is no trace point). GitHub's addresses on `web`, the
 *  registry's own /r/ paths (relative, or on one of `sites`). */
export function parsePermalink(url: string, opts: { web?: string; sites?: readonly string[] } = {}): TracePoint | null {
  // No space, control character or backslash: URL parsers differ on them (the Mac's must agree).
  // Nor a "." or ".." segment, nor an escaped "/": the browser's URL would resolve them.
  if (typeof url !== "string" || url.length > 4096 || /[\s\u0000-\u001f\u007f\\]/.test(url) || /%(?![0-9A-Fa-f]{2})|%2f/i.test(url)) return null;
  if (/\/(?:\.|%2e){1,2}(?=\/|$|[?#])/i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url, "https://registry.invalid");
  } catch {
    return null;
  }
  const web = new URL(opts.web ?? "https://github.com");
  const sites = (opts.sites ?? []).map((s) => {
    try {
      return new URL(s).host.toLowerCase();
    } catch {
      return "";
    }
  });
  let parts: string[];
  try {
    parts = u.pathname.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts[0] !== "") return null;
  parts = parts.slice(1);
  const relative = url.startsWith("/") && !url.startsWith("//");
  if (!relative && !/^https?:\/\//i.test(url)) return null;
  const host = u.host.toLowerCase();
  if (relative || sites.includes(host)) {
    if (parts[0] !== "r") return null;
    parts = parts.slice(1);
  } else if (host === web.host.toLowerCase()) {
    if (u.protocol !== web.protocol) return null;
  } else return null;
  const [owner, name, kind, commit, ...rest] = parts;
  if (!owner || !name || kind !== "blob" || !SHA.test(commit ?? "") || !SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  const path = rest.join("/");
  if (!path || rest.some((s) => s === "" || s === "." || s === ".." || /[\u0000-\u001f]/.test(s))) return null;
  let lines: TracePoint["lines"] = null;
  if (u.hash) {
    // GitHub's line anchors: #L3, #L3-L7 (either order), with columns (#L3C1-L7C9) ignored.
    const m = /^#L(\d{1,7})(?:C\d{1,5})?(?:-L(\d{1,7})(?:C\d{1,5})?)?$/.exec(u.hash);
    const a = Number(m?.[1] ?? 0);
    const b = Number(m?.[2] ?? m?.[1] ?? 0);
    if (!m || a < 1 || b < 1) return null;
    lines = { start: Math.min(a, b), end: Math.max(a, b) };
  }
  return { forge: "github", owner, name: name.replace(/\.git$/i, ""), commit, path, lines };
}

// ─── the lines a map links, in the version shown ─────────────────────────────

/** A pair where the page found it: its lines in the version shown, or null when not found. */
export interface Located {
  map: TracedMap;
  pair: TracedPair;
  lines: { start: number; end: number } | null;
  /** How it was found: at the map's own commit, moved, by its symbol, or not. */
  how: "exact" | "moved" | "symbol" | "lost";
}

const norm = (l: string) => l.replace(/\s+$/, "");

/** The range of the map's version found in the version shown: the same lines, where they are
 *  now (the nearest copy when there are several); null when they changed. */
export function relocate(oldLines: readonly string[], newLines: readonly string[], start: number, end: number): { start: number; end: number } | null {
  if (start < 1 || end > oldLines.length || end < start) return null;
  const block = oldLines.slice(start - 1, end).map(norm);
  // A range of blank lines alone cannot be found again.
  if (block.every((l) => !l.trim())) return null;
  let best: number | null = null;
  for (let i = 0; i + block.length <= newLines.length; i++) {
    if (norm(newLines[i]) !== block[0]) continue;
    let same = true;
    for (let k = 1; k < block.length && same; k++) same = norm(newLines[i + k]) === block[k];
    if (same && (best === null || Math.abs(i + 1 - start) < Math.abs(best + 1 - start))) best = i;
  }
  return best === null ? null : { start: best + 1, end: best + block.length };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Without the map's version: its range where its symbol still stands (the same lines when the
 *  symbol is in them, else the range moved to the symbol's definition); null otherwise. */
export function locateBySymbol(lines: readonly string[], start: number, end: number, symbol: string): { start: number; end: number } | null {
  const sym = symbol.replace(/\(\)$/, "").split(/[.:]/).pop() ?? "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(sym)) return null;
  const word = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(sym)}(?![A-Za-z0-9_])`);
  const def = new RegExp(`(?:\\b(?:def|function|class|fn|func|sub|subroutine|procedure|module|struct|interface)\\s+${escapeRe(sym)}(?![A-Za-z0-9_]))|(?:^\\s*${escapeRe(sym)}\\s*(?:<-|=)\\s*function\\b)`, "i");
  const len = end - start;
  const inRange = end <= lines.length;
  const at = lines.findIndex((l) => def.test(l)) + 1;
  // Its definition inside the range, or no definition but the name in it: the same lines.
  if (inRange && ((at >= start && at <= end) || (!at && lines.slice(start - 1, end).some((l) => word.test(l))))) return { start, end };
  // Its definition elsewhere: the range moves there.
  if (at) return { start: at, end: Math.min(lines.length, at + len) };
  return null;
}

/** The pairs of the maps on one file, found in the version shown. `atMap(commit)` gives the
 *  file's lines at a map's commit (null when that commit cannot be read). */
export async function locate(
  maps: readonly TracedMap[],
  path: string,
  shownCommit: string,
  shown: readonly string[],
  atMap: (commit: string) => Promise<string[] | null>,
): Promise<Located[]> {
  const out: Located[] = [];
  for (const map of maps) {
    const pairs = map.pairs.filter((p) => p.path === path);
    if (!pairs.length) continue;
    const exact = map.commit === shownCommit;
    const old = exact ? null : await atMap(map.commit).catch(() => null);
    for (const pair of pairs) {
      if (exact) {
        out.push({ map, pair, lines: pair.end <= shown.length ? { start: pair.start, end: pair.end } : null, how: pair.end <= shown.length ? "exact" : "lost" });
        continue;
      }
      const found = old ? relocate(old, shown, pair.start, pair.end) : locateBySymbol(shown, pair.start, pair.end, pair.symbol);
      out.push({ map, pair, lines: found, how: !found ? "lost" : old ? (found.start === pair.start ? "exact" : "moved") : "symbol" });
    }
  }
  return out;
}

/** The lines' classes: each located pair in its colour (the reader's .pair-N). A line in two
 *  pairs keeps the first. */
export function lineMarks(located: readonly Located[]): Map<number, string> {
  const marks = new Map<number, string>();
  for (const l of located) {
    if (!l.lines) continue;
    for (let n = l.lines.start; n <= l.lines.end; n++) if (!marks.has(n)) marks.set(n, `traced ${pairClass(l.pair.pair)}`);
  }
  return marks;
}

// ─── in words ────────────────────────────────────────────────────────────────

export const readerUrl = (map: Pick<TracedMap, "paper">, pair?: number): string => `/paper/${encodeURIComponent(map.paper)}/code/${pair ? `#pair-${pair}` : ""}`;
const range = (r: { start: number; end: number }) => (r.end > r.start ? `lines ${r.start} to ${r.end}` : `line ${r.start}`);
const lineAnchor = (r: { start: number; end: number }) => (r.end > r.start ? `#L${r.start}-L${r.end}` : `#L${r.start}`);
const short = (sha: string) => sha.slice(0, 7);

/** One pair in words: "Paragraph 3 of Methods › Spectral analysis". */
const paragraphOf = (p: TracedPair): string => `Paragraph ${p.paragraph}${p.section ? ` of ${p.section}` : ""}`;

/** The note above a traced file: which of its lines the maps link, and to which paragraphs; each
 *  range selects its lines, each paragraph opens the paper beside the code. */
export function tracedNote(located: readonly Located[], shownCommit: string): El | null {
  if (!located.length) return null;
  const byMap = new Map<TracedMap, Located[]>();
  for (const l of located) byMap.set(l.map, [...(byMap.get(l.map) ?? []), l]);
  const blocks: El[] = [];
  for (const [map, ls] of byMap) {
    const moved = ls.some((l) => l.how === "moved" || l.how === "symbol");
    blocks.push(
      h(
        "p",
        null,
        `A tracing map${map.validated ? ", validated by an author," : ""} links ${ls.length === 1 ? "lines" : "parts"} of this file to the paper `,
        h("a", { href: `/paper/${encodeURIComponent(map.paper)}/` }, map.title || map.doi),
        map.commit === shownCommit ? "." : ` (made at commit ${short(map.commit)}${moved ? "; the lines are found again in this version" : ""}).`,
      ),
      h(
        "ul",
        null,
        ...ls.map((l) =>
          h(
            "li",
            { class: pairClass(l.pair.pair) },
            l.lines ? h("a", { href: lineAnchor(l.lines) }, range(l.lines)) : h("span", null, `${range(l.pair)} at ${short(map.commit)}, changed since`),
            l.pair.symbol ? [" (", h("code", null, l.pair.symbol), ")"] : null,
            ": ",
            h("a", { href: readerUrl(map, l.pair.pair) }, paragraphOf(l.pair)),
            l.how === "symbol" ? " — found by its name: the map's commit is no longer at the source" : null,
          ),
        ),
      ),
    );
  }
  return h("div", { class: "traced-note", role: "note" }, h("p", { class: "traced-title" }, "Tracing maps"), ...blocks);
}

/** "Explain these lines": the paragraphs the maps link to the lines selected. */
export function explainLines(located: readonly Located[], selection: { start: number; end: number }): El | null {
  const hits = located.filter((l) => l.lines && l.lines.start <= selection.end && l.lines.end >= selection.start);
  if (!hits.length) return null;
  return h(
    "p",
    { class: "traced-explain" },
    "What these lines carry out, as the tracing map says: ",
    ...hits.flatMap((l, i): Child[] => [i ? "; " : null, h("a", { href: readerUrl(l.map, l.pair.pair) }, paragraphOf(l.pair)), ` of ${l.map.title || l.map.doi}`]),
    ".",
  );
}

// ─── a commit: the map links it changed ──────────────────────────────────────

/** Whether a file's hunks change lines of a range of its old version: a deleted line inside it,
 *  or a line added between two of its lines. */
export function hunksTouch(hunks: readonly Hunk[], r: { start: number; end: number }): boolean {
  for (const hunk of hunks) {
    // The old line before the hunk's first line ("@@ -2,0 …" adds after line 2: git's convention).
    let before = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    for (const l of hunk.lines) {
      if (l.kind === "del" && l.old !== null && l.old >= r.start && l.old <= r.end) return true;
      if (l.kind === "add" && before >= r.start && before < r.end) return true;
      if (l.old !== null) before = l.old;
    }
  }
  return false;
}

export interface Touched {
  map: TracedMap;
  pair: TracedPair;
  path: string;
  /** Changed, not changed, or unknown (the lines could not be found in the parent). */
  state: "changed" | "kept" | "unknown";
}

/** "Ask about a commit": the map links on the files a commit changed, and whether it changed
 *  their lines. `what`: who changes them ("This commit"; phase 04: "This pull request", "changes"). */
export function commitTouches(touched: readonly Touched[], what: { subject: string; verb: string } = { subject: "This commit", verb: "changed" }): El | null {
  if (!touched.length) return null;
  const changed = touched.filter((t) => t.state === "changed");
  const unknown = touched.filter((t) => t.state === "unknown");
  const item = (t: Touched) =>
    h("li", { class: pairClass(t.pair.pair) }, h("code", null, t.path), ` ${range(t.pair)} at ${short(t.map.commit)}: `, h("a", { href: readerUrl(t.map, t.pair.pair) }, paragraphOf(t.pair)), ` of ${t.map.title || t.map.doi}`);
  return h(
    "div",
    { class: "traced-note", role: "note" },
    h("p", { class: "traced-title" }, "Tracing maps"),
    changed.length
      ? h("p", null, `${what.subject} ${what.verb} lines that ${changed.length === 1 ? "a tracing map links" : "tracing maps link"} to a paper:`)
      : h("p", null, `${what.subject} ${what.verb} ${touched.length === 1 ? "a file" : "files"} a tracing map links, not the linked lines${unknown.length ? " as far as they can be found" : ""}.`),
    changed.length ? h("ul", null, ...changed.map(item)) : null,
    unknown.length ? h("p", null, `${unknown.length === 1 ? "One link" : `${unknown.length} links`} could not be found in the ${what.subject === "This commit" ? "commit's parent" : "version it starts from"} (the file changed too much since the map's commit):`) : null,
    unknown.length ? h("ul", null, ...unknown.map(item)) : null,
  );
}
