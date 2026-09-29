// The file finder (night phase 02, E7; key `t`) and the text search of a repository, in the
// registry's viewer. Pure, no DOM, testable in Node (tests/forge-pages/finder.test.ts).
//
// - The finder matches the tree's file paths as the reader types, GitHub's way: the letters of the
//   query in order (a fuzzy subsequence), better at the start of a name, in the file's name, and in
//   a run; vendored and generated files are left out as on GitHub (Linguist's defaults and the
//   repository's .gitattributes, which can bring them back).
// - The search reads the text of a small repository in the reader's browser (raw reads, not counted
//   in the reader's GitHub quota), within limits, and only when the form is sent; beyond the limits,
//   GitHub's code search (it needs a GitHub sign-in) is the last resort, said as such.

import type * as T from "../../worker/forge/types.ts";
import { attributesOf, parseAttributes } from "./attributes.ts";
import { refSegments } from "./code-nav.ts";
import { repoPath, type RepoCoords } from "./forge.ts";
import { detectLanguage } from "./highlight.ts";
import { type Child, type El, h } from "./repo-view.ts";

// ─── the finder ──────────────────────────────────────────────────────────────

export interface Match {
  path: string;
  score: number;
  /** The indices of the path's characters the query matched. */
  at: number[];
}

const isSep = (c: string | undefined) => c === undefined || c === "/" || c === "_" || c === "-" || c === "." || c === " ";

/** How well a query's letters match a path, in order; null when they do not all appear. The best
 *  placement is kept (a dynamic programme over the query's letters, bounded by the path's length). */
export function fuzzyMatch(query: string, path: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { path, score: 0, at: [] };
  const p = path.toLowerCase();
  if (q.length > p.length || path.length > 1000) return null;
  // A cheap test first: the query's letters in order at all.
  for (let i = 0, j = 0; i < q.length; i++, j++) {
    j = p.indexOf(q[i], j);
    if (j < 0) return null;
  }
  const base = path.lastIndexOf("/") + 1;
  // score[i][j]: the best score of q[0..i] with q[i] at p[j]; from: where q[i-1] was.
  const n = q.length;
  const m = p.length;
  let prev = new Float64Array(m).fill(-Infinity);
  const from: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const cur = new Float64Array(m).fill(-Infinity);
    const back = new Int32Array(m).fill(-1);
    let best = -Infinity;
    let bestAt = -1;
    for (let j = 0; j < m; j++) {
      // the best placement of the previous letter strictly before j
      if (i > 0 && j > 0 && prev[j - 1] > best) {
        best = prev[j - 1];
        bestAt = j - 1;
      }
      if (p[j] !== q[i]) continue;
      let s = 1;
      if (isSep(path[j - 1]) || (path[j - 1] && /[a-z]/.test(path[j - 1]) && /[A-Z]/.test(path[j]))) s += 3;
      if (j >= base) s += 1;
      if (j === base) s += 2;
      if (i === 0) {
        cur[j] = s - j * 0.01;
      } else {
        const run = prev[j - 1] ?? -Infinity;
        const viaRun = run > -Infinity ? run + s + 4 : -Infinity;
        const viaGap = best > -Infinity ? best + s - 0.5 : -Infinity;
        if (viaRun >= viaGap && viaRun > -Infinity) {
          cur[j] = viaRun;
          back[j] = j - 1;
        } else if (viaGap > -Infinity) {
          cur[j] = viaGap;
          back[j] = bestAt;
        }
      }
    }
    from.push(back);
    prev = cur;
  }
  let end = -1;
  for (let j = 0; j < m; j++) if (prev[j] > -Infinity && (end < 0 || prev[j] > prev[end])) end = j;
  if (end < 0) return null;
  const at: number[] = [];
  for (let i = n - 1, j = end; i >= 0; i--) {
    at.unshift(j);
    j = from[i][j];
  }
  // A shorter path wins a tie.
  return { path, score: prev[end] - path.length * 0.001, at };
}

/** The files the finder lists: blobs, less vendored and generated ones (unless .gitattributes says
 *  otherwise). */
export function finderFiles(entries: readonly Pick<T.TreeEntry, "path" | "type">[], gitattributes = ""): string[] {
  const rules = parseAttributes(gitattributes);
  return entries
    .filter((e) => e.type === "blob")
    .map((e) => e.path)
    .filter((p) => {
      const a = attributesOf(rules, p);
      return !a.vendored && !a.generated;
    });
}

/** The best matches of a query, best first (at most `limit`). */
export function findFiles(files: readonly string[], query: string, limit = 100): Match[] {
  const out: Match[] = [];
  for (const f of files) {
    const m = fuzzyMatch(query, f);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** A path with its matched letters marked. */
export function markedPath(m: Match): Child[] {
  const out: Child[] = [];
  const at = new Set(m.at);
  let run = "";
  let marked = false;
  const flush = () => {
    if (run) out.push(marked ? h("mark", null, run) : run);
    run = "";
  };
  for (let i = 0; i < m.path.length; i++) {
    const hit = at.has(i);
    if (hit !== marked) {
      flush();
      marked = hit;
    }
    run += m.path[i];
  }
  flush();
  return out;
}

/** The finder's list: each file a link to its view, the matched letters marked. */
export function finderList(repo: RepoCoords, ref: string, matches: readonly Match[], total: number): El {
  return h(
    "div",
    null,
    h("p", { class: "finder-count", "aria-live": "polite" }, matches.length ? `${matches.length === total ? total.toLocaleString("en-GB") : `${matches.length} of ${total.toLocaleString("en-GB")}`} ${total === 1 ? "file" : "files"}` : "No file matches."),
    h("ol", { class: "finder-results" }, ...matches.map((m, k) => h("li", { class: k === 0 ? "selected" : null }, h("a", { href: repoPath(repo, "blob", refSegments(ref, m.path)) }, ...markedPath(m))))),
  );
}

// ─── the text search ─────────────────────────────────────────────────────────

/** What the browser reads to search a repository: at most so many files and bytes; a file above
 *  GitHub's own 384 KB is not searched (GitHub does not index it either). */
export const SEARCH_LIMITS = { files: 300, bytes: 4 * 1024 * 1024, fileBytes: 384 * 1024, results: 100, linesPerFile: 5, lineChars: 2_000 } as const;

export interface SearchQuery {
  text: string;
  path: string | null;
  language: string | null;
  caseSensitive: boolean;
}

/** "alpha path:src/ language:python" → the words and the qualifiers. */
export function parseQuery(q: string, caseSensitive = false): SearchQuery | null {
  let path: string | null = null;
  let language: string | null = null;
  const words: string[] = [];
  for (const token of q.trim().match(/"[^"]*"|\S+/g) ?? []) {
    const m = /^(path|language|lang):(.+)$/i.exec(token);
    if (m) {
      const v = m[2].replace(/^"|"$/g, "");
      if (m[1].toLowerCase() === "path") path = v;
      else language = v;
    } else words.push(token.replace(/^"|"$/g, ""));
  }
  const text = words.join(" ");
  if (!text || text.length > 200) return null;
  return { text, path, language, caseSensitive };
}

/** The files a search reads: text files within the limits, the qualifiers applied; and whether the
 *  repository is too large to search here. */
export function searchPlan(entries: readonly Pick<T.TreeEntry, "path" | "type" | "size" | "mode">[], q: SearchQuery, gitattributes = ""): { files: string[]; tooLarge: boolean; skipped: number } {
  const rules = parseAttributes(gitattributes);
  const candidates = entries.filter((e) => {
    if (e.type !== "blob" || e.mode === "120000" || e.size === null || e.size === 0) return false;
    const a = attributesOf(rules, e.path);
    if (a.vendored || a.generated || a.binary) return false;
    if (/\.(?:png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|bz2|xz|7z|tar|jar|whl|so|dylib|dll|exe|bin|dat|npy|npz|h5|hdf5|mat|parquet|feather|pkl|pickle|pt|pth|ckpt|onnx|nii|edf|fif|mp4|mov|avi|mp3|wav|ttf|woff2?|otf|eot|stl|ipynb)$/i.test(e.path)) return false;
    if (q.path && !e.path.toLowerCase().includes(q.path.toLowerCase().replace(/^\//, ""))) return false;
    if (q.language && (detectLanguage(e.path) ?? "").toLowerCase() !== q.language.toLowerCase()) return false;
    return true;
  });
  const within = candidates.filter((e) => (e.size ?? 0) <= SEARCH_LIMITS.fileBytes);
  const bytes = within.reduce((s, e) => s + (e.size ?? 0), 0);
  const tooLarge = within.length > SEARCH_LIMITS.files || bytes > SEARCH_LIMITS.bytes;
  return { files: tooLarge ? [] : within.map((e) => e.path), tooLarge, skipped: candidates.length - within.length };
}

export interface Hit {
  path: string;
  lines: { n: number; text: string; at: number[] }[];
  count: number;
}

/** The lines of a text that hold the query's words (all of them, in any order), with where. */
export function searchText(path: string, text: string, q: SearchQuery): Hit | null {
  const words = q.text.split(/\s+/).filter(Boolean);
  const norm = (s: string) => (q.caseSensitive ? s : s.toLowerCase());
  const want = words.map(norm);
  const lines = text.split(/\r\n|\n|\r/);
  const hit: Hit = { path, lines: [], count: 0 };
  // The whole query first (a phrase), else every word on the line.
  const phrase = norm(q.text);
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k].length > SEARCH_LIMITS.lineChars ? lines[k].slice(0, SEARCH_LIMITS.lineChars) : lines[k];
    const l = norm(line);
    let at: number[] = [];
    const p = l.indexOf(phrase);
    if (p >= 0) at = [p, p + phrase.length];
    else if (want.length > 1 && want.every((w) => l.includes(w))) at = want.flatMap((w) => [l.indexOf(w), l.indexOf(w) + w.length]);
    else continue;
    hit.count++;
    if (hit.lines.length < SEARCH_LIMITS.linesPerFile) hit.lines.push({ n: k + 1, text: line, at });
  }
  return hit.count ? hit : null;
}

/** A line with the found words marked. */
function markedLine(text: string, at: number[]): Child[] {
  const ranges: [number, number][] = [];
  for (let i = 0; i + 1 < at.length; i += 2) ranges.push([at[i], at[i + 1]]);
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Child[] = [];
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s < pos) continue;
    if (s > pos) out.push(text.slice(pos, s));
    out.push(h("mark", null, text.slice(s, e)));
    pos = e;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** The results: each file, its first matching lines, each line a link to it in the file view. */
export function searchResults(repo: RepoCoords, ref: string, hits: readonly Hit[]): El {
  return h(
    "ol",
    { class: "search-results" },
    ...hits.map((hit) => {
      const file = repoPath(repo, "blob", refSegments(ref, hit.path));
      return h(
        "li",
        null,
        h("p", { class: "search-file" }, h("a", { href: file }, hit.path), ` · ${hit.count === 1 ? "1 line" : `${hit.count.toLocaleString("en-GB")} lines`}`),
        h(
          "ol",
          { class: "search-lines" },
          ...hit.lines.map((l) => h("li", null, h("a", { href: `${file}#L${l.n}`, class: "search-line-num" }, String(l.n)), " ", h("code", null, ...markedLine(l.text, l.at)))),
        ),
      );
    }),
  );
}
