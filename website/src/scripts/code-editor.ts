// The registry's own code editor (night phase 03, E3; docs/WEB_EDITING.md, D03-*): a textarea laid
// over the viewer's own lines, so that editing looks like reading.
//
// - The visible layer is the viewer's `ol.lines.code`: highlight.js's class-based output read into
//   view trees (src/lib/highlight.ts), the numbers in their gutter, each line's exact indentation,
//   tabs at the file's width (science.css `tab-2/4/8`). The textarea above it holds the real text,
//   drawn transparent with its caret and selection: both share one grid cell, one font, one line
//   height and one left padding (science.css `.code-editor`), so the caret sits on the letters.
// - No library that injects styles: CodeMirror (the inventory's choice) writes <style> elements,
//   which the pages' Content-Security-Policy (style-src 'self') and science.css-only forbid.
// - Typing updates only the lines that changed (plain text at once), then the whole file is
//   highlighted again once the typing pauses, within the viewer's limits (plain beyond).
// - Email addresses in the visible layer are hidden in place (worker/forge/mask.ts
//   `maskEmailsInPlace`: the same length, so the columns hold); the textarea keeps the file's text,
//   which is what the commit writes.
// - Keys: Tab and Shift+Tab indent and outdent (after Escape, Tab leaves the editor, as
//   CodeMirror's); Enter keeps the indentation; Ctrl/Cmd+F find and replace, Ctrl/Cmd+G and
//   Shift+Ctrl/Cmd+G the next and previous match, Alt+G go to line; undo and redo are the
//   browser's own (every change goes through its insertText).
// Everything is text nodes and science.css classes: no style attribute, no HTML string.

import { maskEmailsInPlace } from "../../worker/forge/mask.ts";
import { CODE_LIMITS } from "../lib/code-nav.ts";
import {
  type Edit,
  type FindOptions,
  findAll,
  type Indent,
  INDENT_SIZES,
  indentInWords,
  indentSelection,
  indentUnit,
  lineOf,
  newlineKeepingIndent,
  nextMatch,
  offsetOfLine,
  outdentSelection,
  replaceAll,
  type Sel,
} from "../lib/editor.ts";
import { highlightText, type LineNodes, tabClass } from "../lib/highlight.ts";
import { toDom } from "./dom.ts";

type Kid = Node | string | null | false | undefined;

/** An element with text children (never HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

let ids = 0;
const uid = (stem: string) => `${stem}-${++ids}`;

/** The browser's own insertText (undo and redo keep it), else the same change by hand. */
export function applyEdit(ta: HTMLTextAreaElement, e: Edit): void {
  const focused = document.activeElement === ta;
  if (!focused) ta.focus();
  ta.setSelectionRange(e.from, e.to);
  let done = false;
  try {
    done = e.insert === "" && e.from === e.to ? true : document.execCommand("insertText", false, e.insert);
  } catch {
    done = false;
  }
  if (!done) {
    ta.setRangeText(e.insert, e.from, e.to, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  ta.setSelectionRange(e.select.start, e.select.end);
}

export interface CodeEditorOptions {
  text: string;
  language: string | null;
  indent: Indent;
  wrap: boolean;
  /** The textarea's accessible name ("The text of analysis.py"). */
  label: string;
  onInput?: (text: string) => void;
  /** A settings change (indentation, wrapping) the page keeps. */
  onSettings?: (s: { indent: Indent; wrap: boolean }) => void;
  /** The page's own keys (Ctrl+Enter, Ctrl+S…): true when it took the key. */
  onKey?: (ev: KeyboardEvent) => boolean;
}

const HIGHLIGHT_PAUSE = 250;

export class CodeEditor {
  readonly root: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly surface: HTMLDivElement;
  private readonly lines: HTMLOListElement;
  private readonly status: HTMLParagraphElement;
  private readonly findBar: HTMLDivElement;
  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly findSaid: HTMLSpanElement;
  private readonly gotoForm: HTMLFormElement;
  private readonly gotoInput: HTMLInputElement;
  private readonly styleSelect: HTMLSelectElement;
  private readonly sizeSelect: HTMLSelectElement;
  private readonly wrapBox: HTMLInputElement;
  private shown: string[] = [];
  private indent: Indent;
  private language: string | null;
  private wrap: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tabLeaves = false;
  private matches: Sel[] = [];
  private current = -1;
  private readonly opts: CodeEditorOptions;
  private generation = 0;

  constructor(opts: CodeEditorOptions) {
    this.opts = opts;
    this.indent = opts.indent;
    this.language = opts.language;
    this.wrap = opts.wrap;
    const id = uid("editor");

    // The toolbar: indentation, its size, wrapping, find, go to line.
    this.styleSelect = el("select", { id: `${id}-style`, "aria-label": "Indent with" }, el("option", { value: "space" }, "Spaces"), el("option", { value: "tab" }, "Tabs"));
    this.sizeSelect = el("select", { id: `${id}-size`, "aria-label": "Indent size" }, ...INDENT_SIZES.map((n) => el("option", { value: String(n) }, String(n))));
    this.wrapBox = el("input", { type: "checkbox", id: `${id}-wrap` });
    const findButton = el("button", { type: "button", class: "link" }, "Find and replace");
    const gotoButton = el("button", { type: "button", class: "link" }, "Go to line");
    const tools = el(
      "div",
      { class: "editor-tools" },
      el("label", { for: `${id}-style` }, "Indent"),
      " ",
      this.styleSelect,
      " ",
      this.sizeSelect,
      " · ",
      el("label", { for: `${id}-wrap` }, this.wrapBox, " Wrap long lines"),
      " · ",
      findButton,
      " · ",
      gotoButton,
    );

    // Find and replace (hidden until asked).
    this.findInput = el("input", { type: "search", id: `${id}-find`, autocomplete: "off", spellcheck: "false", placeholder: "Find", "aria-label": "Find" });
    this.replaceInput = el("input", { type: "text", id: `${id}-replace`, autocomplete: "off", spellcheck: "false", placeholder: "Replace with", "aria-label": "Replace with" });
    const matchCase = el("input", { type: "checkbox", id: `${id}-case` });
    const wholeWord = el("input", { type: "checkbox", id: `${id}-word` });
    const regex = el("input", { type: "checkbox", id: `${id}-regex` });
    this.findSaid = el("span", { class: "find-said", "aria-live": "polite" });
    const prev = el("button", { type: "button" }, "Previous");
    const next = el("button", { type: "button" }, "Next");
    const replaceOne = el("button", { type: "button" }, "Replace");
    const replaceEvery = el("button", { type: "button" }, "Replace all");
    const closeFind = el("button", { type: "button", class: "link" }, "Close");
    this.findBar = el(
      "div",
      { class: "editor-find", role: "search", hidden: "hidden" },
      el("p", {}, this.findInput, " ", prev, " ", next, " ", this.findSaid),
      el("p", {}, this.replaceInput, " ", replaceOne, " ", replaceEvery),
      el(
        "p",
        { class: "find-options" },
        el("label", { for: `${id}-case` }, matchCase, " Match case"),
        " ",
        el("label", { for: `${id}-word` }, wholeWord, " Whole word"),
        " ",
        el("label", { for: `${id}-regex` }, regex, " Regular expression"),
        " · ",
        closeFind,
      ),
    );
    this.gotoInput = el("input", { type: "text", id: `${id}-goto`, autocomplete: "off", inputmode: "numeric", maxlength: "9", placeholder: "Line" });
    this.gotoForm = el("form", { class: "editor-goto", hidden: "hidden" }, el("label", { for: `${id}-goto` }, "Go to line"), " ", this.gotoInput, " ", el("button", { type: "submit" }, "Go"));

    // The surface: the viewer's lines under a transparent textarea.
    this.lines = el("ol", { class: "lines code editor-lines", "aria-hidden": "true" });
    this.input = el("textarea", {
      class: "editor-input",
      id: `${id}-text`,
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: "off",
      wrap: "off",
      rows: "1",
      "aria-label": opts.label,
      "aria-describedby": `${id}-status`,
    });
    this.input.value = opts.text;
    this.input.setSelectionRange(0, 0);
    this.surface = el("div", { class: "editor-surface" }, el("div", { class: "editor-stack" }, this.lines, this.input));
    this.status = el("p", { class: "editor-status", id: `${id}-status`, "aria-live": "off" });
    this.root = el("div", { class: "code-editor" }, tools, this.findBar, this.gotoForm, this.surface, this.status);

    this.applySettings(false);
    this.renderPlain(this.input.value.split("\n"));
    this.scheduleHighlight(0);
    this.sayPosition();

    // Wiring.
    this.input.addEventListener("input", () => this.changed());
    this.input.addEventListener("scroll", () => {
      // The textarea never scrolls by itself: the surface around it does (their sizes are equal).
      if (this.input.scrollTop) this.input.scrollTop = 0;
      if (this.input.scrollLeft) this.input.scrollLeft = 0;
    });
    this.input.addEventListener("keydown", (ev) => this.key(ev));
    for (const e of ["keyup", "click", "select", "focus"]) this.input.addEventListener(e, () => this.sayPosition());
    this.styleSelect.addEventListener("change", () => {
      this.indent = { ...this.indent, style: this.styleSelect.value === "tab" ? "tab" : "space", from: "default" };
      this.applySettings(true);
    });
    this.sizeSelect.addEventListener("change", () => {
      this.indent = { ...this.indent, size: Number(this.sizeSelect.value) || 4, from: "default" };
      this.applySettings(true);
    });
    this.wrapBox.addEventListener("change", () => {
      this.wrap = this.wrapBox.checked;
      this.applySettings(true);
    });
    findButton.addEventListener("click", () => this.openFind());
    gotoButton.addEventListener("click", () => this.openGoto());
    const options = (): FindOptions => ({ matchCase: matchCase.checked, wholeWord: wholeWord.checked, regex: regex.checked });
    const refind = () => this.search(options(), false);
    this.findInput.addEventListener("input", refind);
    for (const box of [matchCase, wholeWord, regex]) box.addEventListener("change", refind);
    this.findInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.step(ev.shiftKey);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.closeFind();
      }
    });
    this.replaceInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.closeFind();
      }
    });
    prev.addEventListener("click", () => this.step(true));
    next.addEventListener("click", () => this.step(false));
    closeFind.addEventListener("click", () => this.closeFind());
    replaceOne.addEventListener("click", () => {
      const m = this.matches[this.current];
      if (!m) return this.step(false);
      const replacement = this.replaceInput.value;
      applyEdit(this.input, { from: m.start, to: m.end, insert: replacement, select: { start: m.start, end: m.start + replacement.length } });
      this.search(options(), true, m.start + replacement.length);
      this.replaceInput.focus();
    });
    replaceEvery.addEventListener("click", () => {
      const r = replaceAll(this.input.value, this.findInput.value, this.replaceInput.value, options());
      if (typeof r === "string") {
        this.findSaid.textContent = r;
        return;
      }
      if (r.count) applyEdit(this.input, { from: 0, to: this.input.value.length, insert: r.value, select: { start: 0, end: 0 } });
      this.findSaid.textContent = r.count ? `${r.count} replaced.` : "Nothing to replace.";
      this.matches = [];
      this.current = -1;
      this.replaceInput.focus();
    });
    this.gotoForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const n = Number.parseInt(this.gotoInput.value.replace(/^L/i, ""), 10);
      if (!Number.isInteger(n) || n < 1) return;
      this.gotoForm.hidden = true;
      this.goToLine(n);
    });
    this.gotoInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.gotoForm.hidden = true;
        this.input.focus();
      }
    });
  }

  get value(): string {
    return this.input.value;
  }

  /** Replaces the whole text as one change (undo takes it back). */
  set value(text: string) {
    applyEdit(this.input, { from: 0, to: this.input.value.length, insert: text, select: { start: 0, end: 0 } });
  }

  settings(): { indent: Indent; wrap: boolean } {
    return { indent: this.indent, wrap: this.wrap };
  }

  setLanguage(language: string | null): void {
    if (language === this.language) return;
    this.language = language;
    this.scheduleHighlight(0);
  }

  focus(): void {
    this.input.focus();
  }

  /** The caret at a line's start, the line in view. */
  goToLine(n: number): void {
    const offset = offsetOfLine(this.input.value, n);
    this.input.focus();
    this.input.setSelectionRange(offset, offset);
    this.reveal(lineOf(this.input.value, offset));
    this.sayPosition();
  }

  openFind(): void {
    this.findBar.hidden = false;
    const { selectionStart: s, selectionEnd: e } = this.input;
    const picked = this.input.value.slice(s, e);
    if (picked && !picked.includes("\n") && picked.length <= 200) this.findInput.value = picked;
    this.findInput.focus();
    this.findInput.select();
    this.findInput.dispatchEvent(new Event("input"));
  }

  openGoto(): void {
    this.gotoForm.hidden = false;
    this.gotoInput.value = "";
    this.gotoInput.focus();
  }

  // ─── inside ────────────────────────────────────────────────────────────────

  private applySettings(changed: boolean): void {
    this.styleSelect.value = this.indent.style;
    this.sizeSelect.value = String(INDENT_SIZES.includes(this.indent.size as 2 | 4 | 8) ? this.indent.size : 4);
    this.wrapBox.checked = this.wrap;
    const tab = tabClass(this.indent.size);
    this.surface.className = ["editor-surface", tab, this.wrap ? "wrap" : ""].filter(Boolean).join(" ");
    this.lines.className = ["lines", "code", "editor-lines", tab].filter(Boolean).join(" ");
    this.input.setAttribute("wrap", this.wrap ? "soft" : "off");
    this.sayPosition();
    if (changed) this.opts.onSettings?.(this.settings());
  }

  private changed(): void {
    const next = this.input.value.split("\n");
    this.patchLines(next);
    this.input.scrollTop = 0;
    this.input.scrollLeft = 0;
    this.scheduleHighlight(HIGHLIGHT_PAUSE);
    this.sayPosition();
    if (!this.findBar.hidden && this.findInput.value) this.matches = [];
    this.opts.onInput?.(this.input.value);
  }

  private lineItem(nodes: LineNodes | string): HTMLLIElement {
    const li = document.createElement("li");
    if (typeof nodes === "string") li.textContent = nodes;
    else for (const n of nodes) li.appendChild(toDom(n));
    return li;
  }

  /** The lines as plain text, all of them. */
  private renderPlain(lines: string[]): void {
    this.shown = lines;
    this.lines.replaceChildren(...lines.map((l) => this.lineItem(maskEmailsInPlace(l))));
  }

  /** Only the lines that changed, as plain text until the next highlighting. */
  private patchLines(next: string[]): void {
    const old = this.shown;
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let endOld = old.length;
    let endNew = next.length;
    while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) {
      endOld--;
      endNew--;
    }
    const items = this.lines.children;
    const anchor = items[endOld] ?? null;
    for (let i = endOld - 1; i >= start; i--) items[i]?.remove();
    const fresh = document.createDocumentFragment();
    for (let i = start; i < endNew; i++) fresh.appendChild(this.lineItem(maskEmailsInPlace(next[i])));
    this.lines.insertBefore(fresh, anchor);
    this.shown = next;
  }

  private scheduleHighlight(wait: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.highlight(), wait);
  }

  private async highlight(): Promise<void> {
    const text = this.input.value;
    const lines = text.split("\n");
    const tooBig = text.length > CODE_LIMITS.highlightBytes || lines.length > CODE_LIMITS.highlightLines || lines.some((l) => l.length > CODE_LIMITS.highlightLineChars);
    if (tooBig || !this.language) return;
    const generation = ++this.generation;
    const nodes = await highlightText(lines.map(maskEmailsInPlace), this.language);
    // Typed meanwhile: the next pause highlights again.
    if (generation !== this.generation || this.input.value !== text || nodes.length !== lines.length) return;
    this.lines.replaceChildren(...nodes.map((n) => this.lineItem(n)));
    this.shown = lines;
  }

  private sayPosition(): void {
    const v = this.input.value;
    const at = this.input.selectionStart ?? 0;
    const line = lineOf(v, at);
    const column = at - (v.lastIndexOf("\n", at - 1) + 1) + 1;
    const picked = Math.abs((this.input.selectionEnd ?? at) - at);
    this.status.textContent = `Line ${line}, column ${column}${picked ? ` (${picked} selected)` : ""} · ${indentInWords(this.indent)}${this.tabLeaves ? " · Tab now leaves the editor" : ""}`;
  }

  /** A line of the visible layer into view (the surface and the page scroll, not the textarea). */
  private reveal(line: number): void {
    const li = this.lines.children[line - 1] as HTMLElement | undefined;
    li?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  private mark(line: number | null): void {
    for (const li of this.lines.querySelectorAll("li.highlight")) li.classList.remove("highlight");
    if (line !== null) this.lines.children[line - 1]?.classList.add("highlight");
  }

  private search(opts: FindOptions, keepPlace: boolean, from?: number): void {
    const found = findAll(this.input.value, this.findInput.value, opts);
    if (typeof found === "string") {
      this.matches = [];
      this.current = -1;
      this.findSaid.textContent = found;
      this.mark(null);
      return;
    }
    this.matches = found;
    if (!found.length) {
      this.current = -1;
      this.findSaid.textContent = this.findInput.value ? "No match." : "";
      this.mark(null);
      return;
    }
    this.current = nextMatch(found, from ?? (keepPlace ? this.input.selectionStart : this.input.selectionStart));
    this.show();
  }

  private step(backwards: boolean): void {
    if (!this.matches.length) {
      this.findInput.dispatchEvent(new Event("input"));
      if (!this.matches.length) return;
    }
    const m = this.matches[this.current];
    this.current = nextMatch(this.matches, backwards ? (m?.start ?? 0) : (m?.end ?? 0), backwards);
    this.show();
  }

  /** The current match: selected in the text, its line marked and in view, counted in words. */
  private show(): void {
    const m = this.matches[this.current];
    if (!m) return;
    this.input.setSelectionRange(m.start, m.end);
    const line = lineOf(this.input.value, m.start);
    this.mark(line);
    this.reveal(line);
    const over = this.matches.length >= 10_000 ? "over " : "";
    this.findSaid.textContent = `${this.current + 1} of ${over}${this.matches.length.toLocaleString("en-GB")}, line ${line}.`;
  }

  private closeFind(): void {
    this.findBar.hidden = true;
    this.mark(null);
    this.input.focus();
    const m = this.matches[this.current];
    if (m) this.input.setSelectionRange(m.start, m.end);
  }

  private key(ev: KeyboardEvent): void {
    if (this.opts.onKey?.(ev)) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const sel = { start: this.input.selectionStart, end: this.input.selectionEnd };
    if (ev.key === "Escape") {
      this.tabLeaves = true;
      this.sayPosition();
      return;
    }
    if (ev.key === "Tab" && !mod && !ev.altKey) {
      if (this.tabLeaves) {
        this.tabLeaves = false;
        return;
      }
      ev.preventDefault();
      applyEdit(this.input, ev.shiftKey ? outdentSelection(this.input.value, sel, this.indent.size) : indentSelection(this.input.value, sel, indentUnit(this.indent)));
      return;
    }
    this.tabLeaves = false;
    if (ev.key === "Enter" && !mod && !ev.altKey && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      applyEdit(this.input, newlineKeepingIndent(this.input.value, sel, indentUnit(this.indent)));
      return;
    }
    if (mod && !ev.altKey && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      this.openFind();
      return;
    }
    if ((mod && ev.key.toLowerCase() === "g") || ev.key === "F3") {
      ev.preventDefault();
      if (this.findBar.hidden) this.openFind();
      else this.step(ev.shiftKey);
      return;
    }
    if (ev.altKey && !mod && (ev.key.toLowerCase() === "g" || ev.code === "KeyG")) {
      ev.preventDefault();
      this.openGoto();
    }
  }
}
