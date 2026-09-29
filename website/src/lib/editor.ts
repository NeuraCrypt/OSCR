// The registry's own file editor, its pure part (night phase 03, E2; docs/WEB_EDITING.md): no DOM,
// testable in Node (tests/forge-pages/editor.test.ts). The page (src/scripts/repo-edit.ts) lays a
// textarea over the viewer's own lines (ol.lines.code, highlight.js's classes, the gutter) and asks
// this module everything else:
// - the file as the editor holds it and as the commit writes it back: line endings (a textarea
//   holds "\n" only; CRLF files keep CRLF), a byte-order mark kept, EditorConfig's
//   `insert_final_newline` and `trim_trailing_whitespace` applied on the way out only;
// - indentation: EditorConfig's `indent_style`, `indent_size`, `tab_width` first, else what the
//   file itself uses (tabs, or the most common step of its spaces), else 4 spaces (a Makefile:
//   tabs); indent and outdent of the selected lines, Enter keeping the line's own indentation;
// - find and replace (words, match case, whole word, regular expressions; bounded), go to line;
// - the change set of an edit (edited, created, renamed, moved, or renamed and edited) as the
//   commit action's payload (worker/forge/service/act-commit.ts), with GitHub's default messages;
// - new names as GitHub's name field reads them ("a/b.py" makes folders, "../" goes up);
// - drafts kept in the reader's browser (localStorage, every access in try/catch) until committed;
// - which lines of the original a change touches, for the tracing-map notice of the commit dialog.
// Like every browser module, it never names the platform.

import { diffLines, splitLines } from "../../worker/forge/diff.ts";
import type { PayloadChange } from "../../worker/forge/service/act-commit.ts";
import { isRefName, LOGIN } from "../../worker/forge/paths.ts";
import { editorConfigGlob } from "./highlight.ts";

// ─── the file in and out of the editor ───────────────────────────────────────

export type Eol = "\n" | "\r\n" | "\r";

export interface Held {
  /** The text with "\n" line breaks only, without a byte-order mark: what the textarea holds. */
  text: string;
  /** The file's dominant line ending, restored on the way out. */
  eol: Eol;
  bom: boolean;
}

/** The dominant line ending of a text ("\n" when it has none). */
export function lineEnding(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (crlf > lf && crlf >= cr) return "\r\n";
  if (cr > lf && cr > crlf) return "\r";
  return "\n";
}

/** A file's text as the editor holds it. */
export function hold(fileText: string): Held {
  const bom = fileText.charCodeAt(0) === 0xfeff;
  const body = bom ? fileText.slice(1) : fileText;
  return { text: body.replace(/\r\n?/g, "\n"), eol: lineEnding(body), bom };
}

/** The editor's text as the file is written: the file's line ending and mark, and EditorConfig's
 *  final newline and trailing whitespace rules. */
export function release(text: string, held: Pick<Held, "eol" | "bom">, props: Pick<EditorConfig, "insertFinalNewline" | "trimTrailingWhitespace"> = {}): string {
  let t = text.replace(/\r\n?/g, "\n");
  if (props.trimTrailingWhitespace) t = t.replace(/[ \t]+$/gm, "");
  if (props.insertFinalNewline === true && t !== "" && !t.endsWith("\n")) t += "\n";
  if (props.insertFinalNewline === false) t = t.replace(/\n+$/, "");
  if (held.eol !== "\n") t = t.replace(/\n/g, held.eol);
  return held.bom ? `﻿${t}` : t;
}

// ─── EditorConfig and indentation ────────────────────────────────────────────

export interface EditorConfig {
  indentStyle?: "tab" | "space";
  /** A number, or the tab width ("tab"). */
  indentSize?: number | "tab";
  tabWidth?: number;
  endOfLine?: "lf" | "crlf" | "cr";
  insertFinalNewline?: boolean;
  trimTrailingWhitespace?: boolean;
  charset?: string;
}

/** What `.editorconfig` (at the repository's root) sets for a path: the last matching section wins,
 *  key by key; `unset` clears a key. */
export function editorConfigFor(config: string, path: string): EditorConfig {
  const out: EditorConfig = {};
  let matches = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[(.*)\]$/.exec(line);
    if (section) {
      try {
        matches = editorConfigGlob(section[1]).test(path);
      } catch {
        matches = false;
      }
      continue;
    }
    if (!matches) continue;
    const kv = /^([A-Za-z_]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim().toLowerCase();
    const n = Number(value);
    const num = Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
    const bool = value === "true" ? true : value === "false" ? false : null;
    if (value === "unset") {
      const map: Record<string, keyof EditorConfig> = {
        indent_style: "indentStyle", indent_size: "indentSize", tab_width: "tabWidth", end_of_line: "endOfLine",
        insert_final_newline: "insertFinalNewline", trim_trailing_whitespace: "trimTrailingWhitespace", charset: "charset",
      };
      if (map[key]) delete out[map[key]];
      continue;
    }
    if (key === "indent_style" && (value === "tab" || value === "space")) out.indentStyle = value;
    else if (key === "indent_size" && (num !== null || value === "tab")) out.indentSize = num ?? "tab";
    else if (key === "tab_width" && num !== null) out.tabWidth = num;
    else if (key === "end_of_line" && (value === "lf" || value === "crlf" || value === "cr")) out.endOfLine = value;
    else if (key === "insert_final_newline" && bool !== null) out.insertFinalNewline = bool;
    else if (key === "trim_trailing_whitespace" && bool !== null) out.trimTrailingWhitespace = bool;
    else if (key === "charset") out.charset = value;
  }
  return out;
}

export interface Indent {
  style: "tab" | "space";
  /** Spaces per level; for tabs, the tab's width on screen. */
  size: number;
  /** Where it comes from, said in the toolbar. */
  from: "editorconfig" | "file" | "default";
}

export const INDENT_SIZES = [2, 4, 8] as const;

/** How a text indents: "tab" when most indented lines start with a tab, else the most common step
 *  between the indentation of consecutive lines (2, 4 or 8), or null when it does not indent. */
export function detectIndent(text: string): { style: "tab" | "space"; size: number } | null {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  const lines = text.split("\n").slice(0, 10_000);
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith("\t")) tabs++;
    else if (lead.length >= 2) spaces++;
    if (!lead.includes("\t")) {
      const step = Math.abs(lead.length - previous);
      if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
      previous = lead.length;
    }
  }
  if (!tabs && !spaces) return null;
  if (tabs > spaces) return { style: "tab", size: 4 };
  let best = 4;
  let count = -1;
  for (const size of INDENT_SIZES) {
    // A step of 4 in a 2-space file counts for 2 as well.
    const votes = [...steps].filter(([s]) => s % size === 0).reduce((n, [s, c]) => n + (s === size ? c * 2 : c), 0);
    if (votes > count || (votes === count && size < best)) {
      best = size;
      count = votes;
    }
  }
  return { style: "space", size: best };
}

/** The indentation the editor uses for a file: EditorConfig's, else the file's, else 4 spaces (a
 *  Makefile or a Go file: tabs, as their tools want). */
export function indentFor(text: string, config: EditorConfig, path = ""): Indent {
  const tabWidth = config.tabWidth ?? (typeof config.indentSize === "number" ? config.indentSize : 4);
  if (config.indentStyle) {
    const size = config.indentStyle === "tab" ? tabWidth : typeof config.indentSize === "number" ? config.indentSize : tabWidth;
    return { style: config.indentStyle, size, from: "editorconfig" };
  }
  const seen = detectIndent(text);
  if (seen) return { ...seen, size: typeof config.indentSize === "number" ? config.indentSize : seen.size, from: "file" };
  if (/(?:^|\/)(?:GNUmakefile|[Mm]akefile)$|\.(?:mk|go)$/.test(path)) return { style: "tab", size: tabWidth, from: "default" };
  return { style: "space", size: typeof config.indentSize === "number" ? config.indentSize : 4, from: "default" };
}

export const indentUnit = (i: Pick<Indent, "style" | "size">): string => (i.style === "tab" ? "\t" : " ".repeat(i.size));

export const indentInWords = (i: Indent): string =>
  `${i.style === "tab" ? `tabs (shown ${i.size} wide)` : `${i.size} spaces`}${i.from === "editorconfig" ? ", as .editorconfig says" : i.from === "file" ? ", as the file does" : ""}`;

// ─── editing a selection ─────────────────────────────────────────────────────

export interface Sel {
  start: number;
  end: number;
}

/** A replacement of [from, to) by `insert`, then the selection: what the page applies with the
 *  browser's own insertText (so that undo and redo keep working). */
export interface Edit {
  from: number;
  to: number;
  insert: string;
  select: Sel;
}

const lineStart = (value: string, offset: number): number => value.lastIndexOf("\n", offset - 1) + 1;
const lineEnd = (value: string, offset: number): number => {
  const i = value.indexOf("\n", offset);
  return i < 0 ? value.length : i;
};

/** The whole lines a selection covers: [from, to) (a selection ending at a line's start leaves that
 *  line out, as editors do). */
export function coveredLines(value: string, sel: Sel): { from: number; to: number } {
  const from = lineStart(value, sel.start);
  let endAt = sel.end;
  if (sel.end > sel.start && value[sel.end - 1] === "\n") endAt = sel.end - 1;
  return { from, to: lineEnd(value, Math.max(endAt, from)) };
}

/** Tab: one level more at the caret (an empty selection), or on every line selected. */
export function indentSelection(value: string, sel: Sel, unit: string): Edit {
  if (sel.start === sel.end) {
    let insert = unit;
    if (unit !== "\t") {
      // Spaces up to the next stop, as editors do.
      const column = sel.start - lineStart(value, sel.start);
      insert = " ".repeat(unit.length - (column % unit.length));
    }
    return { from: sel.start, to: sel.end, insert, select: { start: sel.start + insert.length, end: sel.start + insert.length } };
  }
  const { from, to } = coveredLines(value, sel);
  const lines = value.slice(from, to).split("\n");
  const out = lines.map((l) => (l.trim() ? unit + l : l));
  const added = out.reduce((n, l, i) => n + l.length - lines[i].length, 0);
  const firstAdded = out[0].length - lines[0].length;
  return { from, to, insert: out.join("\n"), select: { start: sel.start + firstAdded, end: sel.end + added } };
}

/** Shift+Tab: one level less on every line the selection covers (a tab, or up to `size` spaces). */
export function outdentSelection(value: string, sel: Sel, size: number): Edit {
  const { from, to } = coveredLines(value, sel);
  const lines = value.slice(from, to).split("\n");
  const removed: number[] = [];
  const out = lines.map((l) => {
    const m = l.startsWith("\t") ? 1 : /^ */.exec(l)![0].length >= 1 ? Math.min(size, /^ */.exec(l)![0].length) : 0;
    removed.push(m);
    return l.slice(m);
  });
  const total = removed.reduce((a, b) => a + b, 0);
  const start = Math.max(from, sel.start - removed[0]);
  return { from, to, insert: out.join("\n"), select: { start, end: Math.max(start, sel.end - total) } };
}

/** Enter: a new line with the current line's own indentation (one level more after a line that
 *  opens a block: ":" in Python, "{", "(" or "[" at its end). */
export function newlineKeepingIndent(value: string, sel: Sel, unit: string): Edit {
  const start = lineStart(value, sel.start);
  const line = value.slice(start, sel.start);
  let lead = /^[ \t]*/.exec(line)![0];
  if (/[:{([]\s*$/.test(line) && !/^\s*#/.test(line)) lead += unit;
  const insert = `\n${lead}`;
  return { from: sel.start, to: sel.end, insert, select: { start: sel.start + insert.length, end: sel.start + insert.length } };
}

/** The 1-based line of an offset. */
export function lineOf(value: string, offset: number): number {
  let n = 1;
  for (let i = value.indexOf("\n"); i >= 0 && i < offset; i = value.indexOf("\n", i + 1)) n++;
  return n;
}

/** The offset where a 1-based line starts (clamped to the text). */
export function offsetOfLine(value: string, line: number): number {
  let offset = 0;
  for (let n = 1; n < line; n++) {
    const i = value.indexOf("\n", offset);
    if (i < 0) return offset;
    offset = i + 1;
  }
  return offset;
}

// ─── find and replace ────────────────────────────────────────────────────────

export interface FindOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

/** Matches found at most: beyond, the page says "over 10,000". */
export const FIND_LIMIT = 10_000;

/** The pattern a query makes, or the problem in words (an invalid regular expression). */
export function findPattern(query: string, opts: FindOptions = {}): RegExp | string | null {
  if (!query) return null;
  if (query.length > 1000) return "The search is too long.";
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${opts.matchCase ? "" : "i"}`);
  } catch {
    return "This is not a regular expression the browser reads.";
  }
}

/** Every match of a query in the text (at most FIND_LIMIT; an empty match is skipped). */
export function findAll(value: string, query: string, opts: FindOptions = {}): Sel[] | string {
  const re = findPattern(query, opts);
  if (re === null) return [];
  if (typeof re === "string") return re;
  const out: Sel[] = [];
  for (const m of value.matchAll(re)) {
    if (!m[0].length) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length });
    if (out.length >= FIND_LIMIT) break;
  }
  return out;
}

/** The match to go to from an offset: the first at or after it (or before it, backwards),
 *  wrapping around. -1 when there is none. */
export function nextMatch(matches: readonly Sel[], offset: number, backwards = false): number {
  if (!matches.length) return -1;
  if (backwards) {
    for (let i = matches.length - 1; i >= 0; i--) if (matches[i].start < offset) return i;
    return matches.length - 1;
  }
  const i = matches.findIndex((m) => m.start >= offset);
  return i < 0 ? 0 : i;
}

/** Replace every match; `$1` and `$&` work with regular expressions only. */
export function replaceAll(value: string, query: string, replacement: string, opts: FindOptions = {}): { value: string; count: number } | string {
  const re = findPattern(query, opts);
  if (re === null) return { value, count: 0 };
  if (typeof re === "string") return re;
  let count = 0;
  const out = value.replace(re, (...args) => {
    const match = args[0] as string;
    if (!match.length) return match;
    count++;
    if (!opts.regex) return replacement;
    return replacement.replace(/\$(\$|&|\d{1,2})/g, (_, k: string) => (k === "$" ? "$" : k === "&" ? match : String(args[Number(k)] ?? "")));
  });
  return { value: out, count };
}

// ─── names, moves and the change set ─────────────────────────────────────────

const PATH_PART = (s: string) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git" && !/[\u0000-\u001f\u007f\\]/.test(s) && s.length <= 255;

/** The path a name typed in a directory names, as GitHub's name field reads it: "a/b.py" makes
 *  folders, "../" goes up a level, "/" at the start is the repository's root; null when it leaves
 *  the repository or names what a repository may not hold (".git", an empty part). */
export function resolvePath(dir: string, typed: string): string | null {
  const t = typed.trim();
  if (!t || t.length > 4096) return null;
  const parts = t.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const raw of t.replace(/^\/+/, "").split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    if (!PATH_PART(raw)) return null;
    parts.push(raw.normalize("NFC"));
  }
  if (!parts.length || t.endsWith("/")) return null;
  return parts.join("/");
}

/** Why a path cannot be written (it is a folder, or another file is there already), or null. */
export function pathTaken(path: string, entries: readonly { path: string; type: string }[], original: string | null): string | null {
  if (path === original) return null;
  const e = entries.find((x) => x.path === path);
  if (e) return e.type === "tree" ? `${path} is a folder.` : `A file named ${path} already exists: choose another name.`;
  // A file where the new path needs a folder ("a.txt/b.py" when a.txt is a file).
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const x = entries.find((y) => y.path === prefix);
    if (x && x.type !== "tree" && prefix !== original) return `${prefix} is a file, so it cannot hold ${parts.slice(i).join("/")}.`;
  }
  return null;
}

export interface FileEdit {
  /** The file's path before (null: a new file). */
  original: string | null;
  /** Its path now (the name field). */
  path: string;
  /** The file's text as read (null: a new file), and the text to write, both as the file holds them
   *  (release() applied). */
  before: string | null;
  after: string;
  executable: boolean;
}

/** The commit's changes for one file: a new file, an edit, a move (same content: the file is not
 *  sent again), or a move with an edit (the old path deleted, the new one written). */
export function changesOf(e: FileEdit): PayloadChange[] {
  const put: PayloadChange = e.executable ? { op: "put", path: e.path, text: e.after, executable: true } : { op: "put", path: e.path, text: e.after };
  if (e.original === null) return [put];
  if (e.original === e.path) return e.before === e.after ? [] : [put];
  if (e.before === e.after && !e.executable) return [{ op: "move", from: e.original, to: e.path }];
  return [{ op: "delete", path: e.original }, put];
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** GitHub's default commit message for a change set. */
export function defaultMessage(changes: readonly PayloadChange[], opts: { uploaded?: boolean; folder?: string | null } = {}): string {
  if (opts.uploaded) return "Add files via upload";
  if (opts.folder !== undefined && opts.folder !== null && changes.every((c) => c.op === "delete")) return `Delete ${opts.folder} directory`;
  if (changes.length === 2 && changes[0].op === "delete" && changes[1].op === "put") {
    const from = changes[0].path;
    const to = changes[1].path;
    return dirName(from) === dirName(to) ? `Rename ${baseName(from)} to ${baseName(to)}` : `Move and update ${baseName(to)}`;
  }
  if (changes.length === 1) {
    const c = changes[0];
    if (c.op === "move") return dirName(c.from) === dirName(c.to) ? `Rename ${baseName(c.from)} to ${baseName(c.to)}` : `Move ${baseName(c.from)} to ${dirName(c.to) || "the root"}`;
    if (c.op === "delete") return `Delete ${baseName(c.path)}`;
    return `Update ${baseName(c.path)}`;
  }
  if (changes.every((c) => c.op === "delete")) return `Delete ${changes.length} files`;
  return `Update ${changes.length} files`;
}

/** The default message of a new file: "Create <name>". */
export const createMessage = (path: string): string => `Create ${baseName(path)}`;

// ─── branches and co-authors ─────────────────────────────────────────────────

/** A branch name the commit may make: a ref name, not "refs/…", not one that exists. */
export function branchProblem(name: string, existing: readonly string[]): string | null {
  if (!name.trim()) return "Name the new branch.";
  if (!isRefName(name) || name.startsWith("refs/")) return "This is not a branch name git takes (no spaces, “..”, “~”, “^”, “:”, “?”, “*”, “[” or “\\”).";
  if (existing.includes(name)) return `A branch named ${name} already exists: choose another name.`;
  return null;
}

/** GitHub's suggestion for a new branch: "<login>-patch-<n>", the first one free. */
export function patchBranch(login: string | null, existing: readonly string[]): string {
  const who = login && LOGIN.test(login) ? login : "patch";
  const stem = login && LOGIN.test(login) ? `${who}-patch` : "patch";
  for (let n = 1; n < 1000; n++) if (!existing.includes(`${stem}-${n}`)) return `${stem}-${n}`;
  return `${stem}-${Date.now()}`;
}

/** Co-authors typed as GitHub accounts ("@grace, ada-l"): their logins, or the problem. */
export function coAuthorLogins(typed: string): string[] | string {
  const parts = typed.split(/[\s,;]+/).map((p) => p.replace(/^@/, "")).filter(Boolean);
  const bad = parts.find((p) => !LOGIN.test(p) || p.length > 39);
  if (bad) return `${bad} is not a GitHub account's name.`;
  const out = [...new Set(parts.map((p) => p.toLowerCase()))].map((low) => parts.find((p) => p.toLowerCase() === low)!);
  return out.length > 10 ? "At most 10 co-authors." : out;
}

// ─── drafts in the reader's browser ──────────────────────────────────────────

export const DRAFT_PREFIX = "oscr-draft:";
/** A draft older than this is dropped when read (a month). */
export const DRAFT_DAYS = 30;
/** A draft larger than this is not kept (localStorage holds about 5 MB per site). */
export const DRAFT_CHARS = 1_000_000;

export interface Draft {
  v: 1;
  /** The commit the edit started from (the branch's head then). */
  base: string;
  /** The path of the file edited (null: a new file), and the path typed now. */
  original: string | null;
  path: string;
  text: string;
  /** Unix seconds. */
  at: number;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

/** The draft's key: the repository, the branch, and the file (or the folder of a new file). */
export function draftKey(repo: { owner: string; name: string }, branch: string, what: string): string {
  return `${DRAFT_PREFIX}${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}:${branch}:${what}`;
}

export function readDraft(store: Store, key: string, now: number): Draft | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    const fresh = d && d.v === 1 && typeof d.text === "string" && typeof d.path === "string" && /^[0-9a-f]{40,64}$/.test(d.base) && typeof d.at === "number";
    if (!fresh || now - d.at > DRAFT_DAYS * 86_400) {
      store.removeItem(key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

/** Keeps a draft; false when the browser would not (no storage, full, or too large). */
export function writeDraft(store: Store, key: string, draft: Draft): boolean {
  if (!store || draft.text.length > DRAFT_CHARS) return false;
  try {
    store.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function dropDraft(store: Store, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // nothing to do
  }
}

/** Whether a key is a draft's (the callback page drops only those). */
export const isDraftKey = (key: unknown): key is string => typeof key === "string" && key.startsWith(DRAFT_PREFIX) && key.length <= 5000;

// ─── what a change touches ───────────────────────────────────────────────────

/** Whether an edit changes the original's lines start..end (1-based): a line of it deleted or
 *  changed, or lines inserted between two of its lines. */
export function touchesLines(before: string, after: string, range: { start: number; end: number }): boolean {
  const a = splitLines(before).lines;
  const b = splitLines(after).lines;
  let lastA = -1;
  for (const op of diffLines(a, b)) {
    if (op.kind === "equal") lastA = op.a;
    else if (op.kind === "delete") {
      lastA = op.a;
      if (op.a + 1 >= range.start && op.a + 1 <= range.end) return true;
    } else {
      // An insertion after original line lastA + 1 (1-based): inside the range when it falls
      // between two of its lines.
      const after1 = lastA + 1;
      if (after1 >= range.start && after1 < range.end) return true;
    }
  }
  return false;
}

/** How many lines an edit adds and removes, for the dialog. */
export function editStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(splitLines(before).lines, splitLines(after).lines)) {
    if (op.kind === "insert") added++;
    else if (op.kind === "delete") removed++;
  }
  return { added, removed };
}
