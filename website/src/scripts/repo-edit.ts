// Editing a file in the registry (night phase 03, E3; docs/WEB_EDITING.md, D03-*): the views
// edit/<branch>/<path> (a file; the key `e` and "Edit" in the file view open it) and
// new/<branch>/<dir> (a new file; `?filename=` and `?value=` prefill it, as GitHub's), inside the /r/
// shell. Everything happens in the registry; GitHub is only where the commit is made, as the person.
//
// - The editor is the registry's own (code-editor.ts): the viewer's lines under a transparent
//   textarea, highlight.js's classes, the gutter, the file's indentation (EditorConfig, else its
//   own), wrapping, find and replace, go to line, undo.
// - The name field renames and moves ("a/b.py" makes folders, "../" goes up), as GitHub's.
// - Edit, Preview (the viewer's own renderers: Markdown, notebooks, tables) and Changes (the diff).
// - The draft is kept in the reader's browser (localStorage) as it is typed, until committed: a
//   closed tab, a refused commit or a branch that moved loses nothing. When the branch moved since
//   the draft started, the page says so: when this file did not change, the change simply applies
//   to the latest version; when it did, the change can be merged onto it (a three-way merge in the
//   browser) or committed to a new branch made at the version edited.
// - "Commit changes…" opens the commit dialog (commit-dialog.ts) with the tracing-map links the
//   change touches.
// What it costs: the view's reads (the branches, the tree, the file: raw), `.editorconfig` (raw),
// the maps' shard (a file of this site); nothing of the Worker until the commit.

import { merge3 } from "../../worker/forge/diff.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import { isUtf8, text as utf8Text, utf8 } from "../../worker/forge/objects.ts";
import type { PayloadChange } from "../../worker/forge/service/act-commit.ts";
import { atSource, classifyFile, entryAt, isDirectory, licenceShows, pathCrumbs, refSegments, sizeInWords, textLines, unicodeWarnings } from "../lib/code-nav.ts";
import { commitBack, type FileTouch } from "../lib/commit-view.ts";
import * as E from "../lib/editor.ts";
import { repoPath } from "../lib/forge.ts";
import { detectLanguage } from "../lib/highlight.ts";
import { diffTable, hunksOf } from "../lib/history.ts";
import { type El, h } from "../lib/repo-view.ts";
import { CodeEditor, el } from "./code-editor.ts";
import { openCommitDialog } from "./commit-dialog.ts";
import { show, toDom } from "./dom.ts";
import { codeViews, type CodeEnv, failed, openRef, type Opened, type ReadFile, renderers, repoRef, sourceUrl } from "./repo-code.ts";
import { mapLinksIn } from "./repo-traced.ts";

/** The largest file the editor opens: its text, escaped in the commit's JSON, stays inside the
 *  Worker's 1 MiB (D00-7). Larger: git, or GitHub's own editor, at the source. */
export const EDIT_BYTES = 512 * 1024;
/** A `?value=` prefill at most (GitHub's new-file address). */
export const PREFILL_CHARS = 100_000;
const SETTINGS_KEY = "oscr-editor-settings";
const DRAFT_PAUSE = 600;

// ─── hooks for what comes after (E4, E5) ─────────────────────────────────────

/** What the editor offers for a name (E5: a licence or a code of conduct template, a CITATION.cff):
 *  shown under the name field when the name changes. */
export interface NameContext {
  env: CodeEnv;
  branch: string;
  path: string | null;
  editor: CodeEditor;
  /** true for a new file. */
  created: boolean;
}
export const nameHelpers: ((ctx: NameContext) => Promise<El | HTMLElement | null>)[] = [];

/** Writing aids mounted with the editor (E5: the Markdown toolbar and its keys; E4: images dropped
 *  into a Markdown file). `extra` adds files to the commit (an image beside the Markdown). */
export interface AidContext {
  env: CodeEnv;
  branch: string;
  editor: CodeEditor;
  host: HTMLElement;
  path: () => string | null;
  language: () => string | null;
  extra: Map<string, PayloadChange>;
  changed: () => void;
}
export const editorAids: ((ctx: AidContext) => void)[] = [];

// ─── the page ────────────────────────────────────────────────────────────────

const localStore = (): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null => {
  try {
    const s = globalThis.localStorage;
    s.getItem(SETTINGS_KEY);
    return s;
  } catch {
    return null;
  }
};

function savedWrap(): boolean {
  try {
    return JSON.parse(localStore()?.getItem(SETTINGS_KEY) ?? "{}")?.wrap === true;
  } catch {
    return false;
  }
}

function keepWrap(wrap: boolean): void {
  try {
    localStore()?.setItem(SETTINGS_KEY, JSON.stringify({ wrap }));
  } catch {
    // a convenience
  }
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const now = () => Math.floor(Date.now() / 1000);

/** The repository's .editorconfig at a commit (a raw read), or "". */
async function editorConfigAt(env: CodeEnv, opened: Opened): Promise<string> {
  if (!entryAt(opened.entries, ".editorconfig")) return "";
  try {
    return utf8Text((await env.session.git.readFile(repoRef(env), opened.commit, ".editorconfig", { maxBytes: 64 * 1024 })).bytes);
  } catch {
    return "";
  }
}

/** A file's text at a commit (a raw read), or null. */
async function textAt(env: CodeEnv, commit: string, path: string): Promise<string | null> {
  try {
    const f = await env.session.git.readFile(repoRef(env), commit, path, { maxBytes: EDIT_BYTES });
    return f.binary || f.lfs || !isUtf8(f.bytes) ? null : utf8Text(f.bytes);
  } catch {
    return null;
  }
}

/** The page when the view is not on a branch (a tag or a commit): files are edited on a branch. */
function notOnBranch(env: CodeEnv, what: string, rest: string): El {
  const branch = env.info.defaultBranch;
  return h(
    "div",
    { class: "editor-page" },
    h("p", { class: "warning" }, `Files are ${what} on a branch; this address names a tag or a commit.`),
    branch ? h("p", null, h("a", { href: repoPath(env.repo, env.target.view, refSegments(branch, rest)) }, `The same on the ${branch} branch`)) : null,
  );
}

export async function mountEditor(slot: HTMLElement, env: CodeEnv, mode: "edit" | "new"): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, "Opening the editor…"));
  let opened: Opened;
  try {
    opened = await openRef(env, env.target.rest ?? []);
  } catch (e) {
    const rest = env.target.rest ?? [];
    failed(slot, e, sourceUrl(env, mode === "edit" ? "blob" : "tree", rest[0] ?? "HEAD", rest.slice(1).join("/")), mode === "edit" ? "file" : "directory");
    return;
  }
  if (opened.ref.kind !== "branch") {
    show(slot, notOnBranch(env, mode === "edit" ? "edited" : "created", opened.ref.path));
    return;
  }
  const branch = opened.ref.ref;
  const target = opened.ref.path;
  const params = new URLSearchParams(env.search);

  // What is edited: an existing file, or a new one in a folder.
  let original: string | null = null;
  let dir = target;
  let executable = false;
  let before = "";
  let held: E.Held = { text: "", eol: "\n", bom: false };
  if (mode === "edit") {
    const entry = entryAt(opened.entries, target);
    if (!entry || isDirectory(opened.entries, target)) {
      show(
        slot,
        h(
          "div",
          { class: "editor-page" },
          h("p", { class: "warning" }, isDirectory(opened.entries, target) ? `${target} is a folder.` : `There is no file ${target} on ${branch}.`),
          h("p", null, h("a", { href: repoPath(env.repo, "new", refSegments(branch, isDirectory(opened.entries, target) ? target : parentOf(target))) }, "Create a new file"), " instead."),
        ),
      );
      return;
    }
    const licence = licenceShows(env.info.licenseSpdx);
    if (!licence.show) {
      show(
        slot,
        h(
          "div",
          { class: "editor-page" },
          atSource(`${licence.why} The registry edits the files it may show.`, sourceUrl(env, "blob", branch, target)),
          h("p", null, "Its authors can add an open licence here first: ", h("a", { href: `${repoPath(env.repo, "new", refSegments(branch))}?filename=LICENSE` }, "create a LICENSE file"), "."),
        ),
      );
      return;
    }
    const kind = classifyFile(entry, null, target);
    if (kind === "submodule" || kind === "symlink" || (entry.size ?? 0) > EDIT_BYTES) {
      const why =
        kind === "submodule"
          ? "A submodule is another repository: it is changed there, or with git."
          : kind === "symlink"
            ? "A symbolic link is changed with git."
            : `This file is larger than the editor opens (${sizeInWords(EDIT_BYTES)}): git, or GitHub's own editor, can change it.`;
      show(slot, h("div", { class: "editor-page" }, atSource(why, sourceUrl(env, "blob", branch, target))));
      return;
    }
    let bytes: Uint8Array;
    try {
      const f = await env.session.git.readFile(repoRef(env), opened.commit, target, { maxBytes: EDIT_BYTES });
      if (f.lfs || f.binary) {
        show(slot, h("div", { class: "editor-page" }, atSource(f.lfs ? "This file is stored with Git LFS: it is changed with git." : "This is a binary file: the editor changes text. Upload a new version instead.", sourceUrl(env, "blob", branch, target)), f.binary ? h("p", null, h("a", { href: repoPath(env.repo, "upload", refSegments(branch, parentOf(target))) }, "Upload files into its folder")) : null));
        return;
      }
      bytes = f.bytes;
    } catch (e) {
      failed(slot, e, sourceUrl(env, "blob", branch, target), "file");
      return;
    }
    if (!isUtf8(bytes)) {
      show(slot, h("div", { class: "editor-page" }, atSource("This file is not in UTF-8: the browser could not write it back as it is. git can change it.", sourceUrl(env, "blob", branch, target))));
      return;
    }
    before = utf8Text(bytes);
    held = E.hold(before);
    original = target;
    dir = parentOf(target);
    executable = entry.mode === "100755";
  } else if (target && !isDirectory(opened.entries, target) && entryAt(opened.entries, target)) {
    // new/<branch>/<a file>: its folder.
    dir = parentOf(target);
  }

  const config = await editorConfigAt(env, opened);
  // A new file's draft is the folder's, or the named file's when the address names one (?filename=).
  const named = mode === "new" ? (params.get("filename") ?? "").slice(0, 255) : "";
  const draftKey = E.draftKey(env.repo, branch, mode === "edit" ? `edit:${original}` : `new:${dir}/${named}`);
  const store = localStore();
  const draft = E.readDraft(store, draftKey, now());

  // The version the change is made on, and the text the editor starts from.
  let base = opened.commit;
  let startText = held.text;
  let startName = original ? baseOf(original) : (params.get("filename") ?? "").slice(0, 255);
  /** The text a three-way merge brought onto the latest version, once the person asked for it. */
  let startMerged: string | null = null;
  const notes: (El | HTMLElement)[] = [];
  if (mode === "new" && !draft) {
    const value = params.get("value");
    if (value) {
      startText = value.slice(0, PREFILL_CHARS).replace(/\r\n?/g, "\n");
      // A text that came with the address (a link someone made): said, so that it is read first.
      notes.push(el("p", { class: "warning" }, "This file's text came with the address you followed: read it before you commit it."));
    }
  }
  if (draft) {
    startText = draft.text;
    startName = original && draft.path === original ? baseOf(original) : draft.path.startsWith(`${dir}/`) || !dir ? draft.path.slice(dir ? dir.length + 1 : 0) : `/${draft.path}`;
    if (draft.base === opened.commit) {
      notes.push(el("p", { class: "ok" }, "Your change, kept in this browser, is back where you left it."));
    } else if (mode === "new") {
      notes.push(el("p", {}, `The branch ${branch} moved since your new file was started: it will be created on the latest version.`));
    } else {
      // The branch moved since the draft started: is this file still as it was then?
      const then = await textAt(env, draft.base, original!);
      if (then !== null && E.hold(then).text === held.text) {
        notes.push(el("p", {}, `The branch ${branch} moved since your change started, but not this file: your change applies to the latest version.`));
      } else if (then !== null) {
        base = draft.base;
        const merged = merge3(E.hold(then).text, draft.text, held.text, { ours: "your change", base: "the version you edited", theirs: `${branch} now` });
        const bring = el("button", { type: "button" }, "Bring my change onto the latest version");
        const box = el(
          "div",
          { class: "editor-moved", role: "note" },
          el(
            "p",
            { class: "warning" },
            `This file changed on ${branch} since your change started (at ${draft.base.slice(0, 7)}). As it is, your change goes on a new branch made at the version you edited.`,
          ),
          merged.clean
            ? el("p", {}, "The two changes do not touch the same lines: ", bring, " (a three-way merge, made here; check the Changes tab after).")
            : el("p", {}, `The two changes touch the same lines (${merged.conflicts} ${merged.conflicts === 1 ? "place" : "places"}): commit yours on a new branch, and its comparison with ${branch} shows both.`),
        );
        bring.addEventListener("click", () => {
          base = opened.commit;
          startMerged = merged.text;
          box.replaceChildren(el("p", { class: "ok" }, `Your change now applies to the latest version of ${branch}.`));
          editor.value = merged.text;
        });
        notes.push(box);
      } else {
        base = draft.base;
        notes.push(el("p", { class: "warning" }, `The branch ${branch} moved since your change started: it goes on a new branch made at the version you edited.`));
      }
    }
  }
  // The text the change is compared with: the file at `base`.
  const beforeAt = async (): Promise<string> => (base === opened.commit || original === null ? held.text : E.hold((await textAt(env, base, original)) ?? held.text).text);

  const language0 = detectLanguage(original ?? startName ?? "", startText);
  const indent = E.indentFor(startText, E.editorConfigFor(config, original ?? (startName ? `${dir ? `${dir}/` : ""}${startName}` : "")), original ?? startName);
  const editor = new CodeEditor({
    text: startText,
    language: language0,
    indent,
    wrap: savedWrap(),
    label: original ? `The text of ${original}` : "The new file's text",
    onInput: () => changed(),
    onSettings: (s) => keepWrap(s.wrap),
    onKey: (ev) => {
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key === "Enter") {
        ev.preventDefault();
        void commit();
        return true;
      }
      if (mod && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        saveDraft(true);
        return true;
      }
      if (mod && ev.shiftKey && ev.key.toLowerCase() === "p") {
        ev.preventDefault();
        select(current === "preview" ? "edit" : "preview");
        return true;
      }
      return false;
    },
  });

  // The name field: a rename or a move, as GitHub's.
  const nameInput = el("input", { type: "text", id: "edit-name", name: "name", autocomplete: "off", spellcheck: "false", maxlength: "4096", placeholder: "Name your file…", "aria-label": "The file's name" });
  nameInput.value = startName;
  const nameSaid = el("p", { class: "edit-name-said", "aria-live": "polite" });
  const helper = el("div", { class: "name-helper" });
  const crumbs = toDom(pathCrumbs(env.repo, branch, dir, false)) as HTMLElement;
  crumbs.classList.add("edit-crumbs");
  const tabs = el("div", { class: "editor-tabs", role: "tablist", "aria-label": "Editor" });
  const panels = {
    edit: el("div", { class: "editor-panel", role: "tabpanel" }, editor.root),
    preview: el("div", { class: "editor-panel preview", role: "tabpanel", hidden: "hidden" }),
    changes: el("div", { class: "editor-panel changes", role: "tabpanel", hidden: "hidden" }),
  };
  type Tab = keyof typeof panels;
  let current: Tab = "edit";
  const tabButtons: Record<Tab, HTMLButtonElement> = {
    edit: el("button", { type: "button", role: "tab", "aria-selected": "true" }, "Edit"),
    preview: el("button", { type: "button", role: "tab", "aria-selected": "false" }, "Preview"),
    changes: el("button", { type: "button", role: "tab", "aria-selected": "false" }, "Changes"),
  };
  tabs.append(tabButtons.edit, tabButtons.preview, tabButtons.changes);
  const draftSaid = el("span", { class: "editor-draft", "aria-live": "polite" });
  const commitButton = el("button", { type: "button", class: "primary" }, "Commit changes…");
  const discard = el("button", { type: "button", class: "link", hidden: "hidden" }, "Discard the change");
  const cancelHref = original ? repoPath(env.repo, "blob", refSegments(branch, original)) : repoPath(env.repo, "tree", refSegments(branch, dir));
  const dialog = el("section", { class: "commit-dialog", "aria-label": "Commit changes", hidden: "hidden" });
  const extra = new Map<string, PayloadChange>();
  const warnings = unicodeWarnings(startText);

  const page = el(
    "div",
    { class: "editor-page" },
    el(
      "div",
      { class: "edit-head" },
      crumbs,
      el("p", { class: "edit-name" }, nameInput, el("span", { class: "edit-branch" }, ` in ${branch}`)),
      el("p", { class: "edit-actions" }, el("a", { href: cancelHref }, "Cancel"), " ", commitButton),
    ),
    nameSaid,
    helper,
    ...notes.map((n) => (n instanceof HTMLElement ? n : toDom(n))),
    warnings.bidi || warnings.hidden ? el("p", { class: "warning" }, "This file holds characters that do not show, or that change the direction of the text: the viewer shows them as their code points; here they are as they are.") : null,
    tabs,
    panels.edit,
    panels.preview,
    panels.changes,
    el("p", { class: "editor-foot" }, draftSaid, " ", discard),
    dialog,
  );
  slot.replaceChildren(page);
  document.title = `Editing ${original ?? "a new file"} · ${document.title.replace(/^Editing [^·]+· /, "")}`;

  // ─── state ─────────────────────────────────────────────────────────────────

  const pathNow = (): string | null => (nameInput.value.trim() ? E.resolvePath(dir, nameInput.value) : null);
  const languageNow = () => detectLanguage(pathNow() ?? original ?? "", editor.value);
  const configNow = () => E.editorConfigFor(config, pathNow() ?? original ?? "");
  const afterText = () => E.release(editor.value, held, configNow());

  const problemOfName = (): string | null => {
    if (!nameInput.value.trim()) return "Name your file.";
    const p = pathNow();
    if (!p) return "This name is not one a repository may hold (an empty part, “..” above the repository, or “.git”).";
    return E.pathTaken(p, opened.entries, original);
  };

  function changesNow(): PayloadChange[] | string {
    const problem = problemOfName();
    if (problem) return problem;
    const path = pathNow()!;
    // Untouched in the editor, the file is compared as it is (a file with mixed line endings is not
    // rewritten by opening it).
    const after = editor.value === held.text && startMerged === null ? before : afterText();
    const own = E.changesOf({ original, path, before: original === null ? null : before, after, executable });
    const all = [...own, ...[...extra.values()].filter((c) => !own.some((o) => "path" in o && "path" in c && o.path === c.path))];
    if (!all.length) return "Nothing changed yet.";
    return all;
  }

  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  function saveDraft(now_ = false): void {
    clearTimeout(draftTimer);
    const run = () => {
      const path = pathNow() ?? (nameInput.value.trim() || original || "");
      const unchanged = original !== null && editor.value === held.text && path === original && startMerged === null;
      if (unchanged || (original === null && !editor.value && !nameInput.value.trim())) {
        E.dropDraft(store, draftKey);
        draftSaid.textContent = "";
        discard.hidden = true;
        return;
      }
      discard.hidden = false;
      const kept = E.writeDraft(store, draftKey, { v: 1, base, original, path, text: editor.value, at: now() });
      draftSaid.textContent = kept
        ? `Your change is kept in this browser (${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}) until it is committed.`
        : "This browser keeps nothing for this site: the change is lost if the page closes before it is committed.";
    };
    if (now_) run();
    else draftTimer = setTimeout(run, DRAFT_PAUSE);
  }

  function changed(): void {
    saveDraft();
    if (current !== "edit") void fill(current);
  }

  async function nameChanged(): Promise<void> {
    const problem = nameInput.value.trim() ? problemOfName() : null;
    nameSaid.textContent = problem ?? (pathNow() && original && pathNow() !== original ? `Renamed to ${pathNow()}.` : "");
    nameSaid.className = problem ? "edit-name-said warning" : "edit-name-said";
    editor.setLanguage(languageNow());
    tabButtons.preview.hidden = !claimed();
    const nodes: (El | HTMLElement)[] = [];
    for (const f of nameHelpers) {
      const x = await f({ env, branch, path: pathNow(), editor, created: original === null }).catch(() => null);
      if (x) nodes.push(x);
    }
    helper.replaceChildren(...nodes.map((n) => (n instanceof HTMLElement ? n : toDom(n))));
    saveDraft();
  }
  nameInput.addEventListener("input", () => void nameChanged());

  const claimed = () => renderers.find((r) => r.claims(pathNow() ?? original ?? "", languageNow())) ?? null;

  async function fill(tab: Tab): Promise<void> {
    if (tab === "preview") {
      const r = claimed();
      if (!r) return show(panels.preview, h("p", null, "Nothing to preview for this kind of file: the Changes tab shows the change."));
      const path = pathNow() ?? original ?? "file";
      const text = editor.value;
      const file: ReadFile = { env, ref: opened.ref, commit: opened.commit, path, entry: null, entries: opened.entries, bytes: utf8(text), text, language: languageNow() };
      try {
        const view = await r.render(file);
        show(panels.preview, view ?? h("p", null, "This file could not be rendered as it is."));
        if (view && r.mounted) await r.mounted(panels.preview, file).catch(() => undefined);
      } catch {
        show(panels.preview, h("p", null, "This file could not be rendered as it is."));
      }
      return;
    }
    if (tab === "changes") {
      const was = await beforeAt();
      const now_ = editor.value;
      const path = pathNow();
      const renamed = original && path && path !== original ? h("p", null, `Renamed from ${original} to ${path}.`) : null;
      if (was === now_ && !renamed && !extra.size) return show(panels.changes, h("p", null, "No change yet."));
      const stats = E.editStats(was, now_);
      const hunks = hunksOf(maskEmails(was), maskEmails(now_));
      show(
        panels.changes,
        renamed,
        original === null ? h("p", null, `A new file of ${stats.added} ${stats.added === 1 ? "line" : "lines"}.`) : h("p", null, `${stats.added} ${stats.added === 1 ? "line" : "lines"} added, ${stats.removed} removed.`),
        hunks.length ? diffTable(hunks, "unified", undefined, "The change") : null,
        extra.size ? h("p", null, `And ${extra.size} ${extra.size === 1 ? "file" : "files"} added with it: ${[...extra.keys()].join(", ")}.`) : null,
      );
    }
  }

  function select(tab: Tab): void {
    if (tab === "preview" && !claimed()) tab = "changes";
    current = tab;
    for (const t of Object.keys(panels) as Tab[]) {
      panels[t].hidden = t !== tab;
      tabButtons[t].setAttribute("aria-selected", t === tab ? "true" : "false");
    }
    if (tab === "edit") editor.focus();
    else void fill(tab);
  }
  for (const t of Object.keys(tabButtons) as Tab[]) tabButtons[t].addEventListener("click", () => select(t));
  tabs.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    const order = (Object.keys(tabButtons) as Tab[]).filter((t) => !tabButtons[t].hidden);
    const i = order.indexOf(current);
    const next = order[(i + (ev.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    select(next);
    tabButtons[next].focus();
  });

  discard.addEventListener("click", () => {
    E.dropDraft(store, draftKey);
    location.assign(cancelHref);
  });

  // ─── the commit ────────────────────────────────────────────────────────────

  let branches: string[] | null = null;
  async function commit(): Promise<void> {
    saveDraft(true);
    if (!branches) {
      try {
        branches = (await env.session.git.listBranches(repoRef(env), { perPage: 100 })).items.map((b) => b.name);
      } catch {
        branches = [branch];
      }
    }
    const path = pathNow();
    const changes = changesNow();
    const created = original === null;
    await openCommitDialog(dialog, {
      env,
      branch,
      head: opened.commit,
      base,
      branches,
      defaultMessage: typeof changes === "string" ? "" : created ? E.createMessage(path ?? "file") : E.defaultMessage(changes),
      changes: changesNow,
      touches: async (): Promise<FileTouch[]> => {
        if (original === null) return [];
        const was = await beforeAt();
        const located = await mapLinksIn(env, base, original, textLines(maskEmails(was)));
        if (!located.length) return [];
        const p = pathNow() ?? original;
        return [{ path: original, kind: p !== original ? "move" : "edit", before: was, after: editor.value, to: p, located }];
      },
      texts: () => [[pathNow() ?? original ?? "the file", editor.value]],
      drafts: [draftKey],
      back: commitBack(env.repo, location.pathname),
    });
    dialog.scrollIntoView({ block: "start" });
  }
  commitButton.addEventListener("click", () => void commit());

  for (const aid of editorAids) {
    try {
      aid({ env, branch, editor, host: page, path: pathNow, language: languageNow, extra, changed });
    } catch {
      // an aid is a convenience
    }
  }
  await nameChanged();
  if (draft) saveDraft(true);
  if (location.hash.startsWith("#L")) editor.goToLine(Number.parseInt(location.hash.slice(2), 10) || 1);
  else if (mode === "new" && !nameInput.value) nameInput.focus();
  else editor.focus();
}

codeViews.edit = (slot, env) => mountEditor(slot, env, "edit");
codeViews.new = (slot, env) => mountEditor(slot, env, "new");
