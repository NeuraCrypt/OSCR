// The code browser of the /r/ shell (night phase 02, E1): pure functions, no DOM, testable in Node
// (tests/forge-pages/code-nav.test.ts). The script src/scripts/repo-code.ts reads GitHub in the
// reader's browser and turns the view trees built here into DOM nodes (src/scripts/dom.ts).
//
// - Refs (`resolveRefPath`): GitHub's addresses put the ref and the path in the same segments
//   (tree/feature/x/src/a.py); the longest branch or tag that prefixes them wins, as on GitHub, a
//   full commit id is a commit, anything else is read as a one-segment ref.
// - The directory listing (`listDirectory`) comes from ONE recursive tree per commit (kept for the
//   tab's life, src/lib/gitcache.ts): directories first, then files; a chain of single
//   directories is shown as one entry ("src/main/java"), as GitHub does; submodules and symbolic
//   links are said in words.
// - Files (`classifyFile`, CODE_LIMITS): text up to 1 MiB in the page, highlighted up to 512 KiB
//   and 20,000 lines; images read as bytes and shown from an object URL (no external request);
//   binary files and LFS pointers said as such (an LFS object is never fetched: it would spend the
//   owner's LFS bandwidth, D00-9); larger files are GitHub's raw links.
// - Hidden and bidirectional Unicode (`unicodeWarnings`, `revealHidden`): a warning, and every
//   such character shown as a visible marker, never applied (the "Trojan Source" attacks).
// - Lines (`parseLineHash`, `lineHash`, `permalink`): #L12, #L12-L20 (columns ignored), and the
//   permalink at a commit id, the unit tracing maps point to (src/lib/traced.ts).
//
// Every text is masked for email addresses before it is shown (lines are masked one by one, so
// the numbers hold); links go through safeHref. The platform is never named here.

import { forgeLinks } from "../../worker/forge/github/links.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import { isObjectId } from "../../worker/forge/paths.ts";
import type * as T from "../../worker/forge/types.ts";
import { isPathSegment, repoPath, type RepoCoords } from "./forge.ts";
import { plural } from "./format.ts";
import { type LineNodes, tabClass } from "./highlight.ts";
import { type Child, type El, h, link } from "./repo-view.ts";

// ─── limits ──────────────────────────────────────────────────────────────────

/** What the page shows of a file, and above what it links to GitHub's raw file instead (D02-4). */
export const CODE_LIMITS = {
  /** A text file larger than this is not read: GitHub's raw link. */
  displayBytes: 1024 * 1024,
  /** Highlighted up to this size and line count; plain text beyond. */
  highlightBytes: 512 * 1024,
  highlightLines: 20_000,
  /** A line longer than this is shown plain. */
  highlightLineChars: 5_000,
  /** A Markdown file (a README) is rendered up to this size, then cut, as GitHub cuts at 500 KiB. */
  renderBytes: 500 * 1024,
  /** An image is read and shown up to this size. */
  imageBytes: 10 * 1024 * 1024,
  /** Entries listed in one directory before "and N more" (GitHub: 1,000). */
  listEntries: 1_000,
} as const;

// ─── refs ────────────────────────────────────────────────────────────────────

export interface RefLists {
  branches: { name: string; sha: string }[];
  tags: { name: string; sha: string }[];
  /** The lists are complete (fewer than a page each). */
  complete: boolean;
}

export interface ResolvedRef {
  /** The ref as written in the address: a branch, a tag, a commit id, or a guess. */
  ref: string;
  kind: "branch" | "tag" | "commit" | "unknown";
  /** The commit it names, when the lists said (a branch's or a tag's head), or the id itself. */
  sha: string | null;
  /** The path after it, "" for the root. */
  path: string;
}

/** The ref and the path the segments after tree/, blob/, commits/ or find/ name. */
export function resolveRefPath(segments: readonly string[], refs: RefLists | null, fallback?: string | null): ResolvedRef {
  if (!segments.length) return { ref: fallback ?? "", kind: fallback ? "branch" : "unknown", sha: refs?.branches.find((b) => b.name === fallback)?.sha ?? null, path: "" };
  if (isObjectId(segments[0])) return { ref: segments[0], kind: "commit", sha: segments[0], path: segments.slice(1).join("/") };
  if (refs) {
    for (let k = segments.length; k >= 1; k--) {
      const name = segments.slice(0, k).join("/");
      const b = refs.branches.find((x) => x.name === name);
      if (b) return { ref: name, kind: "branch", sha: b.sha, path: segments.slice(k).join("/") };
      const t = refs.tags.find((x) => x.name === name);
      if (t) return { ref: name, kind: "tag", sha: t.sha, path: segments.slice(k).join("/") };
    }
  }
  return { ref: segments[0], kind: "unknown", sha: null, path: segments.slice(1).join("/") };
}

/** The segments of a ref and a path, for repoPath. */
export const refSegments = (ref: string, path = ""): string[] => [...ref.split("/"), ...path.split("/")].filter((s) => s !== "");

/** A short form of a commit id: its first 7 characters. */
export const shortSha = (sha: string): string => (isObjectId(sha) ? sha.slice(0, 7) : sha);

/** A ref as the page says it: a commit id shortened, a branch or a tag as it is. */
export const refLabel = (r: Pick<ResolvedRef, "ref" | "kind">): string => (r.kind === "commit" ? shortSha(r.ref) : r.ref);

// ─── the directory listing ───────────────────────────────────────────────────

export interface ListingEntry {
  /** What the listing shows: a name, or a chain of single directories ("src/main/java"). */
  name: string;
  /** From the repository's root. */
  path: string;
  kind: "dir" | "file" | "symlink" | "submodule" | "executable";
  size: number | null;
  sha: string;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** The entries directly under `dir` ("" for the root), directories first, each group by name. */
export function listDirectory(entries: readonly T.TreeEntry[], dir: string): ListingEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const direct = entries.filter((e) => e.path.startsWith(prefix) && e.path.length > prefix.length && !e.path.slice(prefix.length).includes("/"));
  const out: ListingEntry[] = direct.map((e) => ({
    name: e.path.slice(prefix.length),
    path: e.path,
    kind:
      e.type === "tree" ? "dir" : e.type === "commit" ? "submodule" : e.mode === "120000" ? "symlink" : e.mode === "100755" ? "executable" : "file",
    size: e.type === "blob" ? e.size : null,
    sha: e.sha,
  }));
  // A directory holding only one directory is shown as one entry, as GitHub does.
  for (const d of out) {
    if (d.kind !== "dir") continue;
    for (let depth = 0; depth < 20; depth++) {
      const inside = entries.filter((e) => e.path.startsWith(`${d.path}/`) && !e.path.slice(d.path.length + 1).includes("/"));
      if (inside.length !== 1 || inside[0].type !== "tree") break;
      d.path = inside[0].path;
      d.name = d.path.slice(prefix.length);
      d.sha = inside[0].sha;
    }
  }
  const rank = (e: ListingEntry) => (e.kind === "dir" ? 0 : e.kind === "submodule" ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name));
}

/** The tree entry at a path, or null. */
export const entryAt = (entries: readonly T.TreeEntry[], path: string): T.TreeEntry | null => entries.find((e) => e.path === path) ?? null;

/** Whether a path names a directory of the tree ("" is the root). */
export const isDirectory = (entries: readonly T.TreeEntry[], path: string): boolean =>
  path === "" || entries.some((e) => e.path === path && e.type === "tree");

// ─── sizes and words ─────────────────────────────────────────────────────────

/** "612 bytes", "4.2 KB", "1.3 MB" (decimal units, as GitHub writes them). */
export function sizeInWords(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return plural(bytes, "byte");
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** Lines, and lines of code (not blank), as GitHub's file header says them. */
export function lineCounts(lines: readonly string[]): { lines: number; loc: number } {
  return { lines: lines.length, loc: lines.filter((l) => l.trim() !== "").length };
}

/** A text's lines: "\n", "\r\n" or "\r" end a line; a final end of line adds no empty line. */
export function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ─── files ───────────────────────────────────────────────────────────────────

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml",
};

/** The media type of an image the page can show, from its extension; null otherwise. */
export function imageType(path: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext ? (IMAGE_TYPES[ext] ?? null) : null;
}

export type FileKind = "text" | "image" | "binary" | "lfs" | "too_large" | "symlink" | "submodule" | "empty";

/** How the page shows a file, from its tree entry (before reading: a file too large is not read)
 *  and, once read, from its bytes. */
export function classifyFile(entry: Pick<T.TreeEntry, "mode" | "type" | "size"> | null, file?: Pick<T.FileContent, "binary" | "lfs" | "size"> | null, path = ""): FileKind {
  if (entry?.type === "commit") return "submodule";
  if (entry?.mode === "120000") return "symlink";
  const size = file?.size ?? entry?.size ?? null;
  if (file?.lfs) return "lfs";
  if (imageType(path) && !/\.svg$/i.test(path)) return size !== null && size > CODE_LIMITS.imageBytes ? "too_large" : "image";
  if (size !== null && size > CODE_LIMITS.displayBytes) return "too_large";
  if (file?.binary) return "binary";
  if (size === 0) return "empty";
  return "text";
}

// ─── hidden and bidirectional Unicode ────────────────────────────────────────

/** Characters that reorder text (bidirectional controls): the "Trojan Source" attacks. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
/** Characters that do not show (zero-width, invisible separators, a byte order mark after the
 *  first character, soft hyphens, fillers). */
const HIDDEN = /[\u200B-\u200F\u2028\u2029\u2060-\u2064\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u3164\uFEFF\uFFA0]/g;

/** How many bidirectional and hidden characters a text holds (a leading BOM is not counted). */
export function unicodeWarnings(text: string): { bidi: number; hidden: number } {
  const t = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return { bidi: t.match(BIDI)?.length ?? 0, hidden: t.match(HIDDEN)?.length ?? 0 };
}

/** The code point of a character, as "U+202E". */
export const codePoint = (c: string): string => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/** A text with every bidirectional or hidden character replaced by a visible marker
 *  (span.hidden-char, its code point in words): the reader sees it, and nothing is reordered. */
export function revealHidden(text: string): (string | El)[] {
  const re = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\u2060-\u2064\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u3164\uFEFF\uFFA0]/g;
  if (!re.test(text)) return [text];
  re.lastIndex = 0;
  const out: (string | El)[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push(h("span", { class: "hidden-char", title: `A hidden or bidirectional character, ${codePoint(m[0])}` }, `⟨${codePoint(m[0])}⟩`));
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// ─── lines, permalinks ───────────────────────────────────────────────────────

export interface LineRange {
  start: number;
  end: number;
}

/** "#L12" → 12–12, "#L20-L12" → 12–20, "#L3C5-L4C2" → 3–4; null otherwise. */
export function parseLineHash(hash: string): LineRange | null {
  const m = /^#?L(\d{1,7})(?:C\d{1,6})?(?:-L(\d{1,7})(?:C\d{1,6})?)?$/.exec(hash ?? "");
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2] ?? m[1]);
  if (a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** "#L12" or "#L12-L20". */
export const lineHash = (r: LineRange): string => (r.end > r.start ? `#L${r.start}-L${r.end}` : `#L${r.start}`);

/** "line 12", "lines 12 to 20". */
export const linesInWords = (r: LineRange): string => (r.end > r.start ? `lines ${r.start} to ${r.end}` : `line ${r.start}`);

/** The permalink of a file (and its lines) at a commit, on this site: /r/<o>/<n>/blob/<sha>/<path>. */
export function permalink(repo: RepoCoords, commit: string, path: string, lines?: LineRange | null): string {
  if (!isObjectId(commit)) throw new TypeError("a permalink needs a commit id");
  return `${repoPath(repo, "blob", refSegments(commit, path))}${lines ? lineHash(lines) : ""}`;
}

/** GitHub's own addresses for a repository (the reader's fallbacks, blame, raw files). */
export function githubLinks(web: string) {
  return forgeLinks({ forge: "github", web });
}

// ─── view trees ──────────────────────────────────────────────────────────────

/** The path under the ref switcher: the repository's name, then each directory, each a link to
 *  its tree view at the same ref; the last one plain. */
export function pathCrumbs(repo: RepoCoords, ref: string, path: string, isFile: boolean): El {
  const parts = path ? path.split("/") : [];
  const items: Child[] = [];
  items.push(parts.length ? h("a", { href: repoPath(repo, "tree", refSegments(ref)) }, repo.name) : h("strong", null, repo.name));
  parts.forEach((p, i) => {
    items.push(" / ");
    const last = i === parts.length - 1;
    items.push(last ? h("strong", null, p) : h("a", { href: repoPath(repo, "tree", refSegments(ref, parts.slice(0, i + 1).join("/"))) }, p));
  });
  if (!isFile && parts.length) items.push(" /");
  return h("p", { class: "path-crumbs", "aria-label": "Path" }, ...items);
}

/** The branch and tag switcher (key w): a <details> that opens without a script; the script
 *  filters it. Each entry keeps the view and the path. */
export function refSwitcher(repo: RepoCoords, view: "tree" | "blob" | "commits" | "find", current: Pick<ResolvedRef, "ref" | "kind">, path: string, refs: RefLists | null, defaultBranch: string | null): El {
  const at = (name: string) => repoPath(repo, view === "blob" && !path ? "tree" : view, refSegments(name, path));
  const item = (name: string, extra?: string) =>
    h("li", null, name === current.ref ? h("strong", { "aria-current": "true" }, name) : h("a", { href: at(name) }, name), extra ? ` ${extra}` : null);
  const label = current.kind === "tag" ? "Tag" : current.kind === "commit" ? "Commit" : "Branch";
  const branches = refs?.branches ?? [];
  const tags = refs?.tags ?? [];
  return h(
    "details",
    { class: "refs", id: "ref-switcher" },
    h("summary", null, `${label}: `, h("code", null, refLabel(current))),
    h(
      "div",
      { class: "refs-panel" },
      h("label", { for: "ref-filter" }, "Find a branch or a tag"),
      h("input", { type: "search", id: "ref-filter", name: "ref", autocomplete: "off", spellcheck: "false", placeholder: "main, v1.0…" }),
      h("h3", null, "Branches"),
      branches.length
        ? h("ul", { class: "ref-list" }, branches.map((b) => item(b.name, b.name === defaultBranch ? "(default)" : undefined)))
        : h("p", null, refs ? "No branch." : "The branches could not be read."),
      h("h3", null, "Tags"),
      tags.length ? h("ul", { class: "ref-list" }, tags.map((t) => item(t.name))) : h("p", null, refs ? "No tag." : "The tags could not be read."),
      refs && !refs.complete ? h("p", null, "The first 100 of each are listed; the others are on GitHub's branch and tag pages.") : null,
      h("p", null, h("a", { href: repoPath(repo, "branches") }, "All the branches")),
    ),
  );
}

/** The files of a directory, as a table (GitHub's files list, read by a screen reader as one). */
export function fileTable(repo: RepoCoords, ref: string, dir: string, entries: readonly ListingEntry[], submodules: Record<string, string> = {}): El {
  const shown = entries.slice(0, CODE_LIMITS.listEntries);
  const rows: El[] = [];
  if (dir) {
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    rows.push(h("tr", null, h("td", { class: "name" }, h("a", { href: repoPath(repo, "tree", refSegments(ref, parent)), "aria-label": "Parent directory" }, "..")), h("td", null, ""), h("td", { class: "num" }, "")));
  }
  for (const e of shown) {
    let name: Child;
    let what: string;
    switch (e.kind) {
      case "dir":
        name = h("a", { href: repoPath(repo, "tree", refSegments(ref, e.path)) }, `${e.name}/`);
        what = "directory";
        break;
      case "submodule": {
        const target = submodules[e.path];
        name = target ? h("a", { href: target }, `${e.name} @ ${shortSha(e.sha)}`) : `${e.name} @ ${shortSha(e.sha)}`;
        what = "submodule";
        break;
      }
      case "symlink":
        name = h("a", { href: repoPath(repo, "blob", refSegments(ref, e.path)) }, e.name);
        what = "symbolic link";
        break;
      default:
        name = h("a", { href: repoPath(repo, "blob", refSegments(ref, e.path)) }, e.name);
        what = e.kind === "executable" ? "executable file" : "file";
    }
    rows.push(h("tr", null, h("td", { class: "name" }, name), h("td", { class: "what" }, what), h("td", { class: "num" }, e.size !== null ? sizeInWords(e.size) : "")));
  }
  return h(
    "table",
    { class: "files" },
    h("caption", null, dir ? `${dir}/` : "Files", entries.length > shown.length ? ` — the first ${shown.length.toLocaleString("en-GB")} of ${plural(entries.length, "entry", "entries")}` : ""),
    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Kind"), h("th", { class: "num" }, "Size"))),
    h("tbody", null, rows, shown.length ? null : h("tr", null, h("td", { colspan: "3" }, "This directory is empty."))),
  );
}

/** Where a submodule points, from .gitmodules: its path → its address. */
export function parseGitmodules(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let path: string | null = null;
  let url: string | null = null;
  const flush = () => {
    if (path && url) out[path] = url;
    path = url = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[submodule\b/.test(line)) {
      flush();
      continue;
    }
    const kv = /^(path|url)\s*=\s*(.+)$/.exec(line);
    if (kv) {
      if (kv[1] === "path") path = kv[2].trim();
      else url = kv[2].trim();
    }
  }
  flush();
  return out;
}

/** A submodule's page: this site's /r/ view of a GitHub repository at the recorded commit, or the
 *  address itself when it is another https host; null otherwise (a relative or ssh address). */
export function submoduleTarget(url: string, commit: string): string | null {
  const gh = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
  if (gh) {
    try {
      return repoPath({ owner: gh[1], name: gh[2] }, "tree", [commit]);
    } catch {
      return null;
    }
  }
  return /^https:\/\/[^\s@]+$/.test(url) ? url : null;
}

/** Hidden characters shown as markers, in every text of a line's view trees. */
function revealIn(nodes: readonly (string | El)[]): (string | El)[] {
  const out: (string | El)[] = [];
  for (const n of nodes) {
    if (typeof n === "string") out.push(...revealHidden(n));
    else out.push({ ...n, children: revealIn(n.children) });
  }
  return out;
}

/** The lines of a file: ol.lines.code, one li per line (id "L<n>"), the numbers in a gutter
 *  (science.css), each line's highlight.js spans kept; hidden characters shown as markers; tabs
 *  at the repository's EditorConfig width. `marks` adds classes to lines (a tracing map's
 *  .pair-N). */
export function codeBlock(lines: readonly LineNodes[], options: { tabWidth?: number | null; marks?: Map<number, string>; label?: string } = {}): El {
  const cls = ["lines", "code", tabClass(options.tabWidth ?? null)].filter(Boolean).join(" ");
  return h(
    "ol",
    { class: cls, "aria-label": options.label ?? "The file's lines" },
    lines.map((line, i) => h("li", { id: `L${i + 1}`, class: options.marks?.get(i + 1) ?? null }, revealIn(line))),
  );
}

/** The file's header line: "23 lines (19 loc) · 612 bytes · Python", with what it is in words. */
export function fileInfo(o: { lines?: { lines: number; loc: number } | null; size: number | null; language: string | null; kind: FileKind; executable?: boolean }): El {
  const parts: string[] = [];
  if (o.lines) parts.push(`${plural(o.lines.lines, "line")} (${o.lines.loc.toLocaleString("en-GB")} loc)`);
  if (o.size !== null) parts.push(sizeInWords(o.size));
  if (o.language && o.kind === "text") parts.push(o.language);
  if (o.kind === "image") parts.push("an image");
  if (o.kind === "binary") parts.push("a binary file");
  if (o.kind === "lfs") parts.push("stored with Git LFS");
  if (o.executable) parts.push("executable");
  return h("p", { class: "file-info" }, parts.join(" · "));
}

/** Masks each line of a text for email addresses, keeping the lines as they are. */
export const maskLines = (lines: readonly string[]): string[] => lines.map((l) => maskEmails(l));

/** A discreet link to the same place at the source, with the sentence that says why the reader
 *  is sent there (the owner's rule, 2026-09-29: GitHub only as a last resort, when the reader asks
 *  for something the registry cannot show: blame, a file too large, a licence that forbids
 *  showing, GitHub's own limit reached). */
export function atSource(why: string, url: string): El {
  return h("p", { class: "at-source" }, why, " ", link(url, "At the source"), ".");
}

/** The sentence when GitHub cannot be read for a view; the source's link only when the source may
 *  still show it (the reader's limit, an outage), never for what does not exist. */
export function degradedView(error: { code: string; retryAfter?: number | null } | null, sourceUrl: string, what: string): El {
  switch (error?.code) {
    case "rate_limited": {
      const minutes = error.retryAfter ? Math.max(1, Math.ceil(error.retryAfter / 60)) : null;
      return h(
        "div",
        null,
        h("p", { class: "warning" }, `GitHub's limit for reading without signing in is reached from your connection (60 requests an hour, shared by the pages you open)${minutes ? `; this ${what} shows again in about ${plural(minutes, "minute")}` : ""}.`),
        atSource(`Until then, the ${what} can only be read where it is hosted.`, sourceUrl),
      );
    }
    case "not_found":
      return h("p", { class: "warning" }, `There is no ${what} at this address: it may have been moved, renamed or deleted.`);
    case "invalid":
      return h("p", { class: "warning" }, `This address does not name a ${what}.`);
    case "too_large":
      return h("div", null, h("p", { class: "warning" }, `This ${what} is too large to show here.`), atSource("It can be read where it is hosted.", sourceUrl));
    default:
      return h(
        "div",
        null,
        h("p", { class: "warning" }, "GitHub, where this repository is hosted, did not answer: it may be down, or this device offline. Try again in a moment."),
        atSource(`The ${what} may still be readable where it is hosted.`, sourceUrl),
      );
  }
}

// ─── licences: what the viewer may show ──────────────────────────────────────

/** The licences GitHub detects (choosealicense.com's, all open) and the Mac's list of open
 *  licences (oscr/repos.py _OPEN, _CONDITIONS): under any of them, a file may be shown to a reader.
 *  Without a licence (all rights reserved) or with one GitHub cannot identify ("NOASSERTION"), the
 *  viewer lists the files but shows none of their contents (the owner's rule, D02-7). */
const OPEN_LICENCES = new Set([
  "MIT", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear", "BSD-4-Clause", "BSD-2-Clause-Patent", "0BSD", "Apache-2.0",
  "ISC", "Unlicense", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0", "CC-BY-ND-4.0",
  "GPL-2.0", "GPL-3.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1", "LGPL-3.0",
  "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later",
  "MPL-2.0", "EPL-1.0", "EPL-2.0", "CECILL-2.1", "EUPL-1.1", "EUPL-1.2", "Artistic-2.0", "BSL-1.0", "Zlib", "Python-2.0",
  "WTFPL", "NCSA", "PostgreSQL", "UPL-1.0", "MulanPSL-2.0", "OSL-3.0", "AFL-3.0", "ECL-2.0", "LPPL-1.3c", "MS-PL", "MS-RL",
  "OFL-1.1", "ODbL-1.0", "Vim", "CERN-OHL-P-2.0", "CERN-OHL-S-2.0", "CERN-OHL-W-2.0", "BlueOak-1.0.0",
]);

export type Showable = { show: true } | { show: false; why: string };

/** Whether the viewer shows a repository's files, from its licence's SPDX id (GitHub's detection;
 *  the registry's own verified licence when it has one). */
export function licenceShows(spdx: string | null | undefined): Showable {
  if (spdx && OPEN_LICENCES.has(spdx)) return { show: true };
  if (!spdx) return { show: false, why: "This repository has no licence: its authors keep every right to its files, so they are not shown here." };
  return { show: false, why: `This repository's licence (${spdx === "NOASSERTION" || spdx === "other" ? "one GitHub could not identify" : spdx}) is not one that lets others show its files, so they are not shown here.` };
}

// ─── the file tree ───────────────────────────────────────────────────────────

/** Above this many entries, the file tree shows only the path to the current file and its
 *  neighbours (every directory stays a link to its own listing). */
export const TREE_FULL_ENTRIES = 2_000;

/** The repository's file tree (the pane beside a file or a directory): nested lists, a directory
 *  a <details> that opens without a script, the ancestors of the current path open, the current
 *  entry marked. */
export function fileTree(repo: RepoCoords, ref: string, entries: readonly T.TreeEntry[], current: string): El {
  const full = entries.length <= TREE_FULL_ENTRIES;
  const ancestors = new Set<string>();
  const parts = current ? current.split("/") : [];
  for (let i = 1; i <= parts.length; i++) ancestors.add(parts.slice(0, i).join("/"));
  const level = (dir: string, depth: number): El | null => {
    const items = listDirectory(entries, dir);
    if (!items.length) return null;
    return h(
      "ul",
      null,
      items.map((e) => {
        const here = e.path === current;
        if (e.kind === "dir") {
          const open = ancestors.has(e.path);
          const inner = full || open ? level(e.path, depth + 1) : null;
          const a = h("a", { href: repoPath(repo, "tree", refSegments(ref, e.path)), "aria-current": here ? "page" : null }, `${e.name}/`);
          if (!inner) return h("li", { class: "dir" }, a);
          return h("li", { class: "dir" }, h("details", { open: open ? "open" : null }, h("summary", null, a), inner));
        }
        const label = e.kind === "submodule" ? `${e.name} @ ${shortSha(e.sha)}` : e.name;
        return h("li", null, e.kind === "submodule" ? label : h("a", { href: repoPath(repo, "blob", refSegments(ref, e.path)), "aria-current": here ? "page" : null }, label));
      }),
    );
  };
  return h(
    "nav",
    { class: "file-tree", "aria-label": "Files" },
    h("details", { open: "open" }, h("summary", null, "Files"), level("", 0) ?? h("p", null, "No file.")),
  );
}

/** A path segment check for paths read from a repository (a symbolic link's target). */
export function joinRelative(dir: string, target: string): string | null {
  if (!target || target.startsWith("/") || target.length > 4096) return null;
  const parts = dir ? dir.split("/") : [];
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (isPathSegment(seg)) parts.push(seg);
    else return null;
  }
  return parts.join("/");
}
