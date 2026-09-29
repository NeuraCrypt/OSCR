// The code views of the /r/ shell (night phase 02, E1): the files of a directory (tree/), a file
// (blob/), and the files on the repository's home, in the registry's own code viewer. Everything
// is read in the reader's browser, on the reader's own GitHub quota (D00-5): a signed-out reader
// asks the Worker nothing.
//
// The owner's rule (2026-09-29): everything is shown here; the reader is sent to GitHub only as a
// last resort, when they ask for something the registry cannot show (blame, a file too large, a
// licence that forbids showing it, GitHub's own limit reached), through a discreet "At the source"
// link after a sentence that says why (code-nav.ts `atSource`).
//
// What a view costs the reader's 60 anonymous requests an hour, at most (the tab keeps immutable
// answers, src/lib/gitcache.ts, so a second visit usually costs 0 to 1):
// - the repository (the shell's own request), the branches (1; the tags only when the ref is not a
//   branch, or when the switcher opens), the tree of the commit (1, recursive, kept for the tab);
// - the latest change of the path (1, shown after the rest);
// - files are raw reads (raw.githubusercontent.com: not counted in the 60).
//
// The views are built by src/lib/code-nav.ts (pure) and shown through src/scripts/dom.ts (no HTML
// string is ever parsed); highlighting is highlight.js's class-based output read into view trees
// (src/lib/highlight.ts). Rendered files (Markdown, notebooks, tables) plug in through
// `renderers` (E2, E5).
//
// Keys (not while typing): t the file finder, w the branch and tag switcher, y the permalink (the
// address at the commit id), l jump to a line, b blame at the source. Lines: click a number in the
// gutter, shift-click to extend; the line menu copies the permalink or the lines.

import { GitBackendError } from "../../worker/forge/errors.ts";
import type { GitSession } from "../../worker/forge/gitbackend.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import { text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import {
  atSource,
  classifyFile,
  CODE_LIMITS,
  codeBlock,
  degradedView,
  entryAt,
  fileInfo,
  fileTable,
  fileTree,
  githubLinks,
  imageType,
  isDirectory,
  joinRelative,
  licenceShows,
  lineCounts,
  lineHash,
  linesInWords,
  listDirectory,
  type LineRange,
  parseGitmodules,
  parseLineHash,
  pathCrumbs,
  permalink,
  readLimit,
  refLabel,
  type RefLists,
  refSegments,
  refSwitcher,
  type ResolvedRef,
  resolveRefPath,
  shortSha,
  sizeInWords,
  submoduleTarget,
  textLines,
  unicodeWarnings,
} from "../lib/code-nav.ts";
import { repoPath, type RepoCoords, type RepoPath } from "../lib/forge.ts";
import { detectLanguage, editorConfigTabWidth, highlightText, type LineNodes, plainLines } from "../lib/highlight.ts";
import { type Child, dateOfIso, type El, h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";

/** What the shell hands the code views. */
export interface CodeEnv {
  /** The repository as GitHub serves it (its own case). */
  repo: RepoCoords;
  info: T.RepoInfo;
  /** An anonymous session, cached for the tab. */
  session: GitSession;
  endpoints: { api: string; raw: string; web: string };
  site: string;
  target: RepoPath;
  /** The query string of the address (?plain=1, ?raw=1). */
  search: string;
}

/** A file the page read, handed to the renderers. */
export interface ReadFile {
  env: CodeEnv;
  ref: ResolvedRef;
  commit: string;
  path: string;
  entry: T.TreeEntry | null;
  entries: readonly T.TreeEntry[];
  bytes: Uint8Array;
  text: string | null;
  language: string | null;
}

/** A way to render a file (Markdown, a notebook, a table): its view, or null to show the source. */
export interface Renderer {
  name: string;
  claims(path: string, language: string | null): boolean;
  render(file: ReadFile): Promise<El | null>;
  /** Once the view is in the page: what the rendered view reads after (its images). */
  mounted?(root: HTMLElement, file: ReadFile): Promise<void>;
}

/** The renderers of the blob view, filled by the rendering modules (E2, E5). */
export const renderers: Renderer[] = [];

/** What the views know once the ref is opened. */
export interface Opened {
  ref: ResolvedRef;
  commit: string;
  refs: RefLists | null;
  entries: T.TreeEntry[];
  truncated: boolean;
}

export const repoRef = (env: Pick<CodeEnv, "repo">): T.RepoRef => ({ forge: "github", owner: env.repo.owner, name: env.repo.name });

/** The branches (and the tags when needed) as the switcher lists them. */
export async function readRefs(env: CodeEnv, withTags: boolean): Promise<RefLists | null> {
  try {
    const branches = await env.session.git.listBranches(repoRef(env), { perPage: 100 });
    const tags = withTags ? await env.session.git.listTags(repoRef(env), { perPage: 100 }) : { items: [], next: null };
    return {
      branches: branches.items.map((b) => ({ name: b.name, sha: b.sha })),
      tags: tags.items.map((t) => ({ name: t.name, sha: t.sha })),
      complete: branches.next === null && tags.next === null,
    };
  } catch (e) {
    if (e instanceof GitBackendError && e.code === "rate_limited") throw e;
    return null;
  }
}

/** Resolves the ref the segments name (the longest branch or tag first) to a commit. */
export async function resolveRef(env: CodeEnv, segments: readonly string[]): Promise<{ ref: ResolvedRef; commit: string; refs: RefLists | null }> {
  let refs = await readRefs(env, false);
  let ref = resolveRefPath(segments, refs, env.info.defaultBranch);
  if (ref.kind === "unknown" && segments.length) {
    refs = (await readRefs(env, true)) ?? refs;
    ref = resolveRefPath(segments, refs, env.info.defaultBranch);
  }
  const commit = ref.sha ?? (await env.session.git.resolve(repoRef(env), ref.ref));
  return { ref, commit, refs };
}

/** Opens the ref the segments name, then reads the commit's tree, recursively (kept for the tab's
 *  life). */
export async function openRef(env: CodeEnv, segments: readonly string[]): Promise<Opened> {
  const { ref, commit, refs } = await resolveRef(env, segments);
  const tree = await env.session.git.tree(repoRef(env), commit, { recursive: true });
  return { ref, commit, refs, entries: tree.entries, truncated: tree.truncated };
}

/** The entries of one directory when the recursive tree was cut (a very large repository). */
async function entriesUnder(env: CodeEnv, opened: Opened, dir: string): Promise<T.TreeEntry[]> {
  if (!opened.truncated || listDirectory(opened.entries, dir).length) return opened.entries;
  const t = await env.session.git.tree(repoRef(env), opened.commit, dir ? { path: dir } : {});
  return [...opened.entries, ...t.entries];
}

/** The same place at the source (GitHub's page): only ever behind `atSource`. */
export const sourceUrl = (env: Pick<CodeEnv, "repo" | "endpoints">, kind: "tree" | "blob" | "blame", ref: string, path: string): string => {
  const links = githubLinks(env.endpoints.web);
  if (kind === "tree") return links.tree(repoRef(env), ref, path || undefined);
  if (kind === "blame") return links.blame(repoRef(env), ref, path);
  return links.blob(repoRef(env), ref, path);
};

/** A failure in words; the source's link only when it may still show it. */
export function failed(slot: HTMLElement, e: unknown, source: string, what: string): void {
  const err = e instanceof GitBackendError ? e : new GitBackendError("unavailable", "GitHub did not answer");
  show(slot, degradedView({ code: err.code, retryAfter: err.retryAfter ?? null }, source, what));
}

/** The line above a view: the switcher, the path, the actions. */
function codeHead(env: CodeEnv, opened: Opened, view: "tree" | "blob", path: string, actions: Child[]): El {
  return h(
    "div",
    { class: "code-head" },
    refSwitcher(env.repo, view, opened.ref, path, opened.refs, env.info.defaultBranch),
    pathCrumbs(env.repo, opened.ref.ref, path, view === "blob"),
    actions.length ? h("p", { class: "file-actions" }, ...actions.flatMap((a, i) => (i ? [" · ", a] : [a]))) : null,
  );
}

/** A view beside the repository's file tree. */
const withTree = (env: CodeEnv, opened: Opened, path: string, main: (El | null)[]): El =>
  h("div", { class: "code-layout" }, fileTree(env.repo, opened.ref.ref, opened.entries, path), h("div", { class: "code-main" }, main));

/** "Latest change: <message> (<sha>, <day>)" for a path, filled after the rest (1 request). */
async function latestChange(env: CodeEnv, opened: Opened, path: string, into: HTMLElement): Promise<void> {
  try {
    const page = await env.session.git.commits(repoRef(env), { rev: opened.commit, path: path || undefined }, { perPage: 1 });
    const c = page.items[0];
    if (!c) return;
    const first = maskEmails(c.message.split("\n")[0].trim()).slice(0, 200);
    const day = dateOfIso(c.committedAt ?? c.authoredAt);
    show(
      into,
      h(
        "p",
        { class: "latest" },
        "Latest change: ",
        h("a", { href: repoPath(env.repo, "commit", [c.sha]) }, first || shortSha(c.sha)),
        ` (${shortSha(c.sha)}${day ? `, ${day}` : ""}) · `,
        h("a", { href: repoPath(env.repo, "commits", refSegments(opened.ref.ref, path)) }, "History"),
      ),
    );
  } catch {
    // a nicety: the view stands without it
  }
}

// ─── the directory ───────────────────────────────────────────────────────────

/** What the tree view adds under its table (E2: the directory's README). */
export const treeExtras: ((slot: HTMLElement, env: CodeEnv, opened: Opened, dir: string) => Promise<void>)[] = [];

async function submodulesOf(env: CodeEnv, opened: Opened): Promise<Record<string, string>> {
  if (!opened.entries.some((e) => e.type === "commit")) return {};
  try {
    const f = await env.session.git.readFile(repoRef(env), opened.commit, ".gitmodules", { maxBytes: 64 * 1024 });
    const map = parseGitmodules(utf8Text(f.bytes));
    const out: Record<string, string> = {};
    for (const e of opened.entries) {
      if (e.type !== "commit" || !map[e.path]) continue;
      const target = submoduleTarget(map[e.path], e.sha);
      if (target) out[e.path] = target;
    }
    return out;
  } catch {
    return {};
  }
}

/** The files of a directory at a ref: the switcher, the path, the tree pane, the table, the latest
 *  change. On the repository's home (`home`), the table alone. */
export async function mountTree(slot: HTMLElement, env: CodeEnv, segments: readonly string[], opts: { home?: boolean } = {}): Promise<Opened | null> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the files…"));
  let opened: Opened;
  try {
    opened = await openRef(env, segments);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", segments[0] ?? env.info.defaultBranch ?? "HEAD", segments.slice(1).join("/")), "directory");
    return null;
  }
  current = { env, opened, path: opened.ref.path, lines: null, selection: null, anchor: null };
  const dir = opened.ref.path;
  if (dir && !isDirectory(opened.entries, dir) && !opened.truncated) {
    if (entryAt(opened.entries, dir)) {
      // A file: tree/ addresses of files go to their blob/ view, as on GitHub.
      const rest = refSegments(opened.ref.ref, dir);
      history.replaceState(null, "", repoPath(env.repo, "blob", rest) + location.hash);
      await mountBlob(slot, { ...env, target: { ...env.target, view: "blob", rest } }, rest);
      return opened;
    }
    show(slot, codeHead(env, opened, "tree", "", []), degradedView({ code: "not_found" }, "", "directory"));
    wireSwitcher(slot, env, opened, "");
    return opened;
  }
  let entries: T.TreeEntry[];
  try {
    entries = await entriesUnder(env, opened, dir);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "tree", opened.ref.ref, dir), "directory");
    return opened;
  }
  const listing = listDirectory(entries, dir);
  const submodules = await submodulesOf(env, opened);
  const actions: Child[] = [
    h("a", { href: repoPath(env.repo, "find", refSegments(opened.ref.ref)) }, "Go to file"),
    h("a", { href: repoPath(env.repo, "commits", refSegments(opened.ref.ref, dir)) }, "History"),
  ];
  const main: (El | null)[] = [
    codeHead(env, opened, "tree", dir, actions),
    h("div", { id: "latest-change", "aria-live": "polite" }),
    opened.truncated ? h("p", { class: "warning" }, "This repository's tree is very large (over 100,000 entries): its directories are read one by one.") : null,
    fileTable(env.repo, opened.ref.ref, dir, listing, submodules),
    h("div", { id: "tree-extras" }),
  ];
  show(slot, opts.home ? h("div", null, main) : withTree(env, opened, dir, main));
  wireSwitcher(slot, env, opened, dir);
  const latest = slot.querySelector<HTMLElement>("#latest-change");
  if (latest && !opts.home) void latestChange(env, opened, dir, latest);
  const extras = slot.querySelector<HTMLElement>("#tree-extras");
  if (extras) {
    // Each extra in its own place (the documentation's link, the README), in the order registered.
    const places = treeExtras.map(() => extras.appendChild(document.createElement("div")));
    await Promise.all(treeExtras.map((extra, k) => extra(places[k], env, opened, dir).catch(() => undefined)));
  }
  return opened;
}

// ─── the file ────────────────────────────────────────────────────────────────

let editorConfig: { commit: string; text: string | null } | null = null;

/** The repository's root .editorconfig at the commit (a raw read, not counted), once per page. */
async function editorConfigText(env: CodeEnv, opened: Opened): Promise<string | null> {
  if (editorConfig?.commit === opened.commit) return editorConfig.text;
  let text: string | null = null;
  if (entryAt(opened.entries, ".editorconfig")) {
    try {
      text = utf8Text((await env.session.git.readFile(repoRef(env), opened.commit, ".editorconfig", { maxBytes: 64 * 1024 })).bytes);
    } catch {
      text = null;
    }
  }
  editorConfig = { commit: opened.commit, text };
  return text;
}

/** The state of the file view the keys and the line menu act on. */
interface FileState {
  env: CodeEnv;
  opened: Opened;
  path: string;
  lines: string[] | null;
  selection: LineRange | null;
  anchor: number | null;
}

let current: FileState | null = null;

/** Extra lines under the line menu for a selection (E4: what a tracing map links to the lines). */
export const lineMenuExtras: ((state: { env: CodeEnv; opened: Opened; path: string; selection: LineRange }) => El | null)[] = [];

/** Line classes (E4: a tracing map's .pair-N) for a file, from its lines as shown. */
export const lineMarkers: ((env: CodeEnv, opened: Opened, path: string, lines: readonly string[]) => Promise<Map<number, string>>)[] = [];

/** What a binary file is, in the viewer (E5: a PDF to open in the browser's viewer, an STL model). */
export const binaryViews: ((path: string, bytes: Uint8Array) => El | null)[] = [];

/** Notes above a file's lines (E4: which lines the tracing maps link; E5: a map, a model, a markup). */
export const blobNotes: ((env: CodeEnv, opened: Opened, path: string, lines: readonly string[]) => Promise<El | null>)[] = [];

/** The lines of a text as the viewer shows them: masked, highlighted within the limits. */
export async function viewLines(text: string, language: string | null): Promise<{ lines: string[]; nodes: LineNodes[]; plain: boolean }> {
  const lines = textLines(maskEmails(text));
  const tooBig = text.length > CODE_LIMITS.highlightBytes || lines.length > CODE_LIMITS.highlightLines || lines.some((l) => l.length > CODE_LIMITS.highlightLineChars);
  const nodes = tooBig ? plainLines(lines) : await highlightText(lines, language);
  return { lines, nodes, plain: tooBig };
}

/** The file at a ref: its header, then its lines, its image, or what it is in words. */
export async function mountBlob(slot: HTMLElement, env: CodeEnv, segments: readonly string[]): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Reading the file…"));
  let opened: Opened;
  try {
    opened = await openRef(env, segments);
  } catch (e) {
    failed(slot, e, sourceUrl(env, "blob", segments[0] ?? "HEAD", segments.slice(1).join("/")), "file");
    return;
  }
  const path = opened.ref.path;
  if (!path || isDirectory(opened.entries, path)) {
    const rest = refSegments(opened.ref.ref, path);
    history.replaceState(null, "", repoPath(env.repo, "tree", rest));
    await mountTree(slot, { ...env, target: { ...env.target, view: "tree", rest } }, rest);
    return;
  }
  const entry = entryAt(opened.entries, path);
  const gh = repoRef(env);
  const params = new URLSearchParams(env.search);
  const plain = params.get("plain") === "1";
  const raw = params.get("raw") === "1";
  const here = repoPath(env.repo, "blob", refSegments(opened.ref.ref, path));
  /** The actions of the file's header: Raw and Copy for a text only, Download once it is read. */
  const headOf = (what: "text" | "bytes" | "none"): El =>
    codeHead(env, opened, "blob", path, [
      what === "text" ? (raw ? h("strong", null, "Raw") : h("a", { href: `${here}?raw=1` }, "Raw")) : null,
      what !== "none" ? h("button", { type: "button", class: "link", id: "download-file" }, "Download") : null,
      what === "text" ? h("button", { type: "button", class: "link", id: "copy-file" }, "Copy") : null,
      h("a", { href: repoPath(env.repo, "commits", refSegments(opened.ref.ref, path)) }, "History"),
      h("a", { href: permalink(env.repo, opened.commit, path), id: "permalink" }, "Permalink"),
    ].filter((a): a is El => a !== null));
  let head = headOf("none");
  const page = (...main: (El | null)[]) => withTree(env, opened, path, [head, ...main]);
  const finish = () => wireSwitcher(slot, env, opened, path);
  const state: FileState = { env, opened, path, lines: null, selection: null, anchor: null };
  current = state;
  if (!entry && !opened.truncated) {
    show(slot, page(degradedView({ code: "not_found" }, "", "file")));
    finish();
    return;
  }
  const kind0 = classifyFile(entry, null, path);
  if (kind0 === "submodule") {
    const target = (await submodulesOf(env, opened))[path];
    show(slot, page(h("p", null, `A submodule: another repository, at commit ${shortSha(entry!.sha)}. `, target ? h("a", { href: target }, "Open it at that commit") : "Its address is in .gitmodules.", ".")));
    finish();
    return;
  }
  const licence = licenceShows(env.info.licenseSpdx);
  if (!licence.show && kind0 !== "symlink") {
    show(slot, page(fileInfo({ size: entry?.size ?? null, language: null, kind: kind0 }), atSource(`${licence.why} Its authors can add an open licence to show them.`, sourceUrl(env, "blob", opened.commit, path))));
    finish();
    return;
  }
  if (kind0 === "too_large") {
    show(
      slot,
      page(
        fileInfo({ size: entry?.size ?? null, language: null, kind: kind0 }),
        atSource(`This file is larger than the viewer shows (${sizeInWords(CODE_LIMITS.displayBytes)} of text, ${sizeInWords(CODE_LIMITS.imageBytes)} for an image, a notebook or a PDF).`, sourceUrl(env, "blob", opened.commit, path)),
      ),
    );
    finish();
    return;
  }
  let file: T.FileContent;
  try {
    file = await env.session.git.readFile(gh, opened.commit, path, { maxBytes: readLimit(path) });
  } catch (e) {
    show(slot, page(h("div", { id: "file-failure" })));
    const into = slot.querySelector<HTMLElement>("#file-failure");
    if (into) failed(into, e, sourceUrl(env, "blob", opened.commit, path), "file");
    finish();
    return;
  }
  const kind = classifyFile(entry, file, path);
  head = headOf(kind === "text" ? "text" : kind === "lfs" || kind === "symlink" ? "none" : "bytes");
  const body: (El | null)[] = [];
  const size = file.size;
  let after: (() => Promise<void>) | null = null;
  if (kind === "symlink") {
    const target = utf8Text(file.bytes).trim();
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const resolved = joinRelative(dir, target);
    const there = resolved !== null && (entryAt(opened.entries, resolved) || isDirectory(opened.entries, resolved));
    body.push(
      h(
        "p",
        null,
        "A symbolic link to ",
        there ? h("a", { href: repoPath(env.repo, isDirectory(opened.entries, resolved!) ? "tree" : "blob", refSegments(opened.ref.ref, resolved!)) }, target) : h("code", null, target),
        there ? "." : ", outside this repository or missing.",
      ),
    );
  } else if (kind === "lfs") {
    body.push(
      fileInfo({ size: file.lfs?.size ?? null, language: null, kind }),
      atSource(
        `Stored with Git LFS: the repository holds a pointer (${sizeInWords(size)}) to a file of ${sizeInWords(file.lfs?.size ?? null)}. The viewer does not read it, since every download counts in its owner's LFS bandwidth.`,
        sourceUrl(env, "blob", opened.commit, path),
      ),
    );
  } else if (kind === "image") {
    const type = imageType(path) ?? "application/octet-stream";
    const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type }));
    body.push(fileInfo({ size, language: null, kind }), h("figure", { class: "file-image" }, h("img", { src: url, alt: path.split("/").pop() ?? path })));
  } else if (kind === "binary") {
    const view = binaryViews.map((f) => f(path, file.bytes)).find((x): x is El => !!x);
    body.push(fileInfo({ size, language: null, kind }), view ?? h("p", null, "A binary file: it has no lines to show. Download it to open it with its program."));
  } else if (kind === "empty") {
    body.push(fileInfo({ size: 0, language: null, kind }), h("p", null, "This file is empty."));
  } else {
    const text = utf8Text(file.bytes);
    const language = detectLanguage(path, text);
    const read: ReadFile = { env, ref: opened.ref, commit: opened.commit, path, entry, entries: opened.entries, bytes: file.bytes, text, language };
    const claimed = renderers.find((r) => r.claims(path, language));
    let rendered: El | null = null;
    if (claimed && !plain && !raw) {
      try {
        rendered = await claimed.render(read);
      } catch {
        rendered = null;
      }
    }
    const shown = await viewLines(text, language);
    state.lines = shown.lines;
    const warnings = unicodeWarnings(text);
    body.push(fileInfo({ lines: lineCounts(shown.lines), size, language, kind, executable: entry?.mode === "100755" }));
    if (claimed && !raw) {
      body.push(h("p", { class: "view-switch" }, rendered ? [h("strong", null, "Rendered"), " · ", h("a", { href: `${here}?plain=1` }, "Source")] : [h("a", { href: here }, "Rendered"), " · ", h("strong", null, "Source")]));
    }
    if (warnings.bidi || warnings.hidden) {
      body.push(
        h(
          "p",
          { class: "warning" },
          warnings.bidi
            ? `This file contains ${warnings.bidi === 1 ? "a bidirectional Unicode character" : `${warnings.bidi} bidirectional Unicode characters`}, which can make text read differently from how it runs. `
            : "",
          warnings.hidden ? `It contains ${warnings.hidden === 1 ? "a character that does not show" : `${warnings.hidden} characters that do not show`}. ` : "",
          "Each is shown below as its code point, never applied.",
        ),
      );
    }
    if (raw) body.push(h("pre", { class: "raw" }, shown.lines.join("\n")));
    else if (rendered) {
      body.push(rendered);
      if (claimed?.mounted) after = () => claimed.mounted!(slot, read);
    }
    else {
      if (shown.plain) body.push(h("p", null, `Shown without highlighting: over ${sizeInWords(CODE_LIMITS.highlightBytes)}, ${CODE_LIMITS.highlightLines.toLocaleString("en-GB")} lines, or a line of over ${CODE_LIMITS.highlightLineChars.toLocaleString("en-GB")} characters.`));
      const tab = editorConfigTabWidth((await editorConfigText(env, opened)) ?? "", path);
      let marks = new Map<number, string>();
      for (const m of lineMarkers) {
        try {
          marks = new Map([...marks, ...(await m(env, opened, path, shown.lines))]);
        } catch {
          // a marker is a nicety
        }
      }
      for (const note of blobNotes) body.push(await note(env, opened, path, shown.lines).catch(() => null));
      body.push(
        h("div", { class: "line-menu", id: "line-menu", hidden: "hidden", "aria-live": "polite" }),
        h("form", { class: "jump", id: "jump-form", hidden: "hidden" }, h("label", { for: "jump-line" }, "Go to line"), " ", h("input", { type: "text", id: "jump-line", name: "line", autocomplete: "off", maxlength: "15", placeholder: "12 or 12-20" }), " ", h("button", { type: "submit" }, "Go")),
        codeBlock(shown.nodes, { tabWidth: tab, marks, label: `The lines of ${path}` }),
      );
    }
    body.push(atSource("Who last changed each line (blame) is shown by GitHub to signed-in readers only.", sourceUrl(env, "blame", opened.commit, path)));
  }
  show(slot, page(...body));
  finish();
  wireFile(slot, state, file.bytes);
  if (after) await after().catch(() => undefined);
}

// ─── wiring ──────────────────────────────────────────────────────────────────

/** The switcher: filters as the reader types; the tags are read when it opens. */
export function wireSwitcher(slot: HTMLElement, env: CodeEnv, opened: Pick<Opened, "ref">, path: string): void {
  const details = slot.querySelector<HTMLDetailsElement>("#ref-switcher");
  if (!details) return;
  const filter = () => {
    const input = details.querySelector<HTMLInputElement>("#ref-filter");
    const q = (input?.value ?? "").trim().toLowerCase();
    for (const li of details.querySelectorAll<HTMLLIElement>(".ref-list li")) li.hidden = q !== "" && !(li.textContent ?? "").toLowerCase().includes(q);
  };
  details.addEventListener("input", filter);
  details.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      details.open = false;
      details.querySelector("summary")?.focus();
      return;
    }
    if (ev.key !== "Enter" || !(ev.target instanceof HTMLInputElement)) return;
    ev.preventDefault();
    const first = details.querySelector<HTMLAnchorElement>(".ref-list li:not([hidden]) a");
    if (first) location.assign(first.href);
  });
  let tagsRead = false;
  details.addEventListener("toggle", async () => {
    if (!details.open) return;
    details.querySelector<HTMLInputElement>("#ref-filter")?.focus();
    if (tagsRead) return;
    tagsRead = true;
    const lists = await readRefs(env, true).catch(() => null);
    if (!lists) return;
    const view = env.target.view === "blob" ? "blob" : env.target.view === "commits" ? "commits" : "tree";
    const fresh = toDom(refSwitcher(env.repo, view, opened.ref, path, lists, env.info.defaultBranch)) as HTMLElement;
    const panel = fresh.querySelector(".refs-panel");
    const old = details.querySelector(".refs-panel");
    const typed = details.querySelector<HTMLInputElement>("#ref-filter")?.value ?? "";
    if (panel && old) {
      old.replaceWith(panel);
      const input = details.querySelector<HTMLInputElement>("#ref-filter");
      if (input) {
        input.value = typed;
        input.focus();
        filter();
      }
    }
  });
}

export async function copy(text: string, button: HTMLElement, idle: string): Promise<void> {
  const done = (said: string) => {
    button.textContent = said;
    setTimeout(() => (button.textContent = idle), 2000);
  };
  try {
    await navigator.clipboard.writeText(text);
    done("Copied");
  } catch {
    done("Select the text to copy it");
  }
}

function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Selects lines: marks them, says them in the line menu, keeps them in the address. */
function select(slot: HTMLElement, state: FileState, range: LineRange | null, scroll: boolean): void {
  const lines = slot.querySelectorAll<HTMLLIElement>("ol.lines.code > li");
  for (const li of slot.querySelectorAll<HTMLLIElement>("ol.lines.code > li.highlight")) li.classList.remove("highlight");
  const max = lines.length;
  const r = range && range.start <= max ? { start: range.start, end: Math.min(range.end, max) } : null;
  state.selection = r;
  const menu = slot.querySelector<HTMLElement>("#line-menu");
  if (!r) {
    if (menu) menu.hidden = true;
    return;
  }
  for (let n = r.start; n <= r.end; n++) lines[n - 1]?.classList.add("highlight");
  if (scroll) lines[r.start - 1]?.scrollIntoView({ block: "center" });
  if (!menu) return;
  const { env, opened, path } = state;
  const extras = lineMenuExtras.map((f) => {
    try {
      return f({ env, opened, path, selection: r });
    } catch {
      return null;
    }
  });
  const said = linesInWords(r);
  show(
    menu,
    h(
      "p",
      null,
      h("strong", null, `${said[0].toUpperCase()}${said.slice(1)} selected`),
      ": ",
      h("button", { type: "button", class: "link", id: "copy-permalink" }, "Copy permalink"),
      " · ",
      h("button", { type: "button", class: "link", id: "copy-lines" }, "Copy lines"),
      " · ",
      h("button", { type: "button", class: "link", id: "clear-lines" }, "Clear"),
    ),
    ...extras.filter((x): x is El => !!x),
  );
  menu.hidden = false;
}

/** The address of the selection, at the ref the reader opened (or at the commit: the permalink). */
function selectionUrl(state: FileState, atCommit: boolean, search = location.search): string {
  const r = state.selection;
  const base = atCommit ? permalink(state.env.repo, state.opened.commit, state.path) : repoPath(state.env.repo, "blob", refSegments(state.opened.ref.ref, state.path));
  return `${base}${search}${r ? lineHash(r) : ""}`;
}

function wireFile(slot: HTMLElement, state: FileState, bytes: Uint8Array): void {
  const name = state.path.split("/").pop() ?? "file";
  slot.querySelector("#download-file")?.addEventListener("click", () => download(bytes, name));
  const copyButton = slot.querySelector<HTMLElement>("#copy-file");
  if (copyButton) {
    if (state.lines === null) copyButton.hidden = true;
    else copyButton.addEventListener("click", () => void copy(state.lines!.join("\n"), copyButton, "Copy"));
  }
  const list = slot.querySelector<HTMLOListElement>("ol.lines.code");
  const initial = parseLineHash(location.hash);
  if (list && initial) select(slot, state, initial, true);
  list?.addEventListener("click", (ev) => {
    const li = (ev.target as Element | null)?.closest?.("li");
    if (!li || li.parentElement !== list) return;
    // The line's number is its ::before, in the gutter (the li's left padding).
    const pad = parseFloat(getComputedStyle(li).paddingLeft) || 0;
    if (ev.clientX - li.getBoundingClientRect().left > pad) return;
    const n = Number(li.id.slice(1));
    if (!Number.isInteger(n)) return;
    const range = ev.shiftKey && state.anchor !== null ? { start: Math.min(state.anchor, n), end: Math.max(state.anchor, n) } : { start: n, end: n };
    if (!ev.shiftKey) state.anchor = n;
    select(slot, state, range, false);
    history.replaceState(null, "", selectionUrl(state, false));
  });
  slot.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t || !state.selection) return;
    if (t.id === "copy-permalink") {
      void copy(new URL(selectionUrl(state, true, ""), location.origin).href, t, "Copy permalink");
    } else if (t.id === "copy-lines" && state.lines) {
      const r = state.selection;
      void copy(state.lines.slice(r.start - 1, r.end).join("\n"), t, "Copy lines");
    } else if (t.id === "clear-lines") {
      state.anchor = null;
      select(slot, state, null, false);
      history.replaceState(null, "", selectionUrl(state, false));
    }
  });
  window.addEventListener("hashchange", () => select(slot, state, parseLineHash(location.hash), true));
  const form = slot.querySelector<HTMLFormElement>("#jump-form");
  form?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const value = (form.querySelector<HTMLInputElement>("#jump-line")?.value ?? "").trim().replace(/\s/g, "").replace(/^L/i, "");
    const r = parseLineHash(`#L${value.replace(/-L?/i, "-L")}`);
    if (!r) return;
    state.anchor = r.start;
    select(slot, state, r, true);
    history.replaceState(null, "", selectionUrl(state, false));
    form.hidden = true;
  });
}

let keysWired = false;

/** The keys of the code views (GitHub's): t, w, y, l, b. Never while typing, never with a
 *  modifier. */
export function wireKeys(env: CodeEnv): void {
  if (keysWired) return;
  keysWired = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const state = current;
    const ref = state?.opened.ref.ref ?? env.info.defaultBranch ?? "";
    switch (ev.key) {
      case "t":
        ev.preventDefault();
        location.assign(repoPath(env.repo, "find", refSegments(ref)));
        break;
      case "w": {
        const d = document.querySelector<HTMLDetailsElement>("#ref-switcher");
        if (d) {
          ev.preventDefault();
          d.open = true;
          document.querySelector<HTMLInputElement>("#ref-filter")?.focus();
        }
        break;
      }
      case "y":
        if (state?.path && state.lines !== null) {
          ev.preventDefault();
          history.replaceState(null, "", selectionUrl(state, true));
          const a = document.querySelector<HTMLAnchorElement>("#permalink");
          if (a) a.textContent = "Permalink (this address)";
        }
        break;
      case "l": {
        const form = document.querySelector<HTMLFormElement>("#jump-form");
        if (form) {
          ev.preventDefault();
          form.hidden = false;
          form.querySelector<HTMLInputElement>("#jump-line")?.focus();
        }
        break;
      }
      case "b":
        // Blame is GitHub's (it needs a GitHub sign-in): the reader's own request, at the source.
        if (state?.path && state.lines !== null) {
          ev.preventDefault();
          location.assign(`${sourceUrl(env, "blame", state.opened.commit, state.path)}${state.selection ? lineHash(state.selection) : ""}`);
        }
        break;
    }
  });
}

/** The code views, by the shell's target; each element registers its own. */
export const codeViews: Partial<Record<string, (slot: HTMLElement, env: CodeEnv) => Promise<void>>> = {
  tree: async (slot, env) => void (await mountTree(slot, env, env.target.rest ?? [])),
  blob: (slot, env) => mountBlob(slot, env, env.target.rest ?? []),
};

export async function mountCode(slot: HTMLElement, env: CodeEnv): Promise<void> {
  wireKeys(env);
  const view = codeViews[env.target.view];
  if (view) await view(slot, env);
  else show(slot, h("p", null, "This view of the repository is not built yet."));
}

/** The ref's label for the page's title. */
export const titleRef = (opened: Opened | null): string => (opened ? refLabel(opened.ref) : "");
