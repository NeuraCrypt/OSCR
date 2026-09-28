// The code pane's viewer, in the reader's browser: one file at a time, its lines numbered in a
// gutter (one `li` of `ol.lines` per line, numbered by science.css), the pairs' colors on
// them, the syntax highlighted by the worker (highlighter.ts), the lines one links to
// (#L10-L20), and the file's header: its path, its language, its size, its license, and the
// buttons (wrap, copy, link, raw) and the menu that leads to the source. A file whose text is
// not here says why, and links to it at the source. Like every browser script, it never names
// the platform.
import {
  anchorText, CELL_LABELS, clampRange, HIGHLIGHT_MAX_BYTES, HIGHLIGHT_MAX_LINES, languageOf, planOf, sizeInWords, unComment,
  type Lang, type Plan, type Range,
} from "../lib/code";
import { plural } from "../lib/format";
import { decorate, lineClass, pairClass, splitLines } from "../lib/lines";
import { sourceOf, sourceWhy, whyNotShown, type ReaderData, type ReaderPair } from "../lib/reader";
import { highlight } from "./highlighter";
import { link, pairLink } from "./reader-paper";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const motion: ScrollBehavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/** Scroll a pane's scrolling box to put `target` near its top (or its middle), with context. */
export function scrollInto(box: HTMLElement, target: HTMLElement, where: "top" | "center" = "top") {
  const offset = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  const top = where === "center" ? offset - box.clientHeight / 3 : offset - 48;
  box.scrollTo({ top: Math.max(0, top), behavior: motion });
}

/** Copy a text: the Clipboard API, else a selection copied the old way. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el("textarea", "clip");
    area.value = text;
    area.setAttribute("readonly", "");
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export type CodeView = ReturnType<typeof codeView>;

export function codeView(data: ReaderData, hooks: { url(file: number, range: Range | null): string; say(text: string): void }) {
  const viewer = byId("code-view");
  const ol = byId<HTMLOListElement>("lines");
  const note = byId("file-note");
  const away = byId("unavailable");
  const end = byId("file-end");
  const path = byId("file-path");
  const facts = byId("file-facts");
  const wrapBtn = byId<HTMLButtonElement>("wrap-lines");
  const copyBtn = byId<HTMLButtonElement>("copy-file");
  const linkBtn = byId<HTMLButtonElement>("link-lines");
  const rawBtn = byId<HTMLButtonElement>("raw-file");
  const sources = byId("source-links");

  let current = -1;
  let lines: string[] = [];
  let raw = "";
  let lang: Lang = languageOf("");
  let plan: Plan = { segments: [], roles: new Map() };
  let selection: Range | null = null;
  let anchor = 0;
  let generation = 0;
  let gutter = 0;
  const cache = new Map<number, string[]>();
  /** The lines marked for the pair being read, with the classes they had before. */
  let marked: { li: HTMLElement; before: string }[] = [];

  /* ---------- The header ---------- */

  function head(i: number) {
    const f = data.files[i];
    const r = data.repos[f.repo];
    const parts = f.path.split("/");
    path.replaceChildren(
      el("span", "repo", r.name),
      ...parts.flatMap((p, k) => [el("span", "sep", "/"), k === parts.length - 1 ? el("strong", "", p) : el("span", "", p)]),
    );
    const l = languageOf(f.path, f.language);
    facts.textContent = [
      l.name,
      f.lines !== null ? plural(f.lines, "line") : "",
      f.bytes !== null ? sizeInWords(f.bytes) : "",
      r.license || "no license",
      f.pairs.length ? plural(f.pairs.length, "match", "matches") : data.pairs.length ? "no match with the paper" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    for (const b of [copyBtn, rawBtn, wrapBtn]) b.disabled = !f.text;
    const at = sourceOf(r, f);
    const items = [
      link(at, at === r.url ? "The repository at the source" : "This file at the source"),
      at === r.url ? null : link(r.url, `The repository at the source (${r.name})`),
    ];
    sources.replaceChildren(
      ...items.filter((x): x is HTMLAnchorElement => x !== null).map((x) => {
        const li = el("li");
        li.append(x);
        return li;
      }),
      el("li", "why", sourceWhy(r.commit, f.text)),
    );
    linkBtn.textContent = "Link";
  }

  /** The line after the last one: the file, its license, and the source, discreetly. */
  function footer(i: number) {
    const f = data.files[i];
    const r = data.repos[f.repo];
    end.replaceChildren(
      `${f.path.split("/").pop()}${r.commit ? ` at commit ${r.commit.slice(0, 7)}` : ""}, ${r.license ? `under ${r.license}` : "no license"} · `,
      link(sourceOf(r, f), "at the source"),
    );
    end.hidden = false;
  }

  /* ---------- The lines ---------- */

  type Marks = ReturnType<typeof decorate>;
  function lineItem(n: number, text: string, m: Marks): HTMLLIElement {
    const li = document.createElement("li");
    const ks = m.cover.get(n);
    if (ks) {
      li.className = lineClass(m.color.get(n), m.weak.has(n))!;
      li.dataset.pairs = ks.join(" ");
    }
    const role = plan.roles.get(n - 1);
    let shown = text;
    if (role && role.startsWith("cell-")) {
      li.classList.add("cell");
      shown = CELL_LABELS[role];
    } else if (role === "prose") {
      li.classList.add("prose");
      if (lang.mode === "notebook") shown = unComment(text);
    }
    const k = m.link.get(n);
    if (k) li.append(pairLink(k, shown, "paragraph"));
    else li.textContent = shown;
    return li;
  }

  function build() {
    const spans = data.files[current].pairs
      .map((k) => data.pairs.find((p) => p.pair === k)!)
      .map((p) => ({ pair: p.pair, start: p.start, end: p.end, whole: p.whole }));
    const marks = decorate(lines, spans);
    const out = document.createDocumentFragment();
    lines.forEach((line, n0) => out.append(lineItem(n0 + 1, line, marks)));
    marked = [];
    ol.replaceChildren(out);
  }

  function gutterOf(): number {
    const first = ol.firstElementChild;
    if (!first) return 0;
    const s = getComputedStyle(first, "::before");
    return parseFloat(s.width) + parseFloat(s.marginRight || "0");
  }

  /** The notes above the lines: the file's (shortened, not highlighted), then the pair's. */
  let fileNotes: (string | Node)[][] = [];
  let pairNote: (string | Node)[] = [];
  function notes(parts: (string | Node)[][] = fileNotes) {
    fileNotes = parts;
    const kept = [...parts, pairNote].filter((p) => p.length);
    note.replaceChildren(...kept.flatMap((p, i) => (i ? [" ", ...p] : p)));
    note.hidden = kept.length === 0;
  }

  /** Lay out the text of file i (its lines already in `lines`), and color it. */
  function settle(i: number, rebuild: boolean) {
    const f = data.files[i];
    const r = data.repos[f.repo];
    lang = languageOf(f.path, f.language);
    plan = planOf(lines, lang);
    ol.className = `lines${lines.length >= 10_000 ? " digits-5" : lines.length >= 1_000 ? " digits-4" : ""}`;
    if (rebuild || plan.roles.size) build();
    ol.hidden = false;
    away.hidden = true;
    away.replaceChildren();
    head(i);
    footer(i);
    gutter = gutterOf();
    const bytes = f.bytes ?? raw.length;
    const tooBig = bytes > HIGHLIGHT_MAX_BYTES || lines.length > HIGHLIGHT_MAX_LINES;
    pairNote = [];
    notes([
      f.truncated ? ["Shortened: only the first part of this file was kept here; ", link(sourceOf(r, f), "the whole file is at the source"), "."] : [],
      tooBig ? [`Syntax highlighting is off for this file: past ${sizeInWords(HIGHLIGHT_MAX_BYTES)} or ${plural(HIGHLIGHT_MAX_LINES, "line")}, it would slow the page.`] : [],
    ]);
    const gen = ++generation;
    if (tooBig || !plan.segments.some((s) => s.lang)) return;
    const known = cache.get(i);
    if (known) return paint(gen, known);
    void highlight(lines, plan.segments).then((html) => {
      if (!html || html.length !== lines.length) return;
      cache.set(i, html);
      if (cache.size > 16) cache.delete(cache.keys().next().value!);
      paint(gen, html);
    });
  }

  /** Put the highlighted lines in place, a few hundred per frame: a long file never freezes the page. */
  function paint(gen: number, html: string[]) {
    let k = 0;
    const step = () => {
      if (gen !== generation) return;
      const stop = Math.min(html.length, k + 500);
      for (; k < stop; k++) {
        const li = ol.children[k] as HTMLElement | undefined;
        if (!li) return;
        if (li.classList.contains("cell")) continue;
        const first = li.firstElementChild;
        (first && first.matches("a[data-pair]") ? first : li).innerHTML = html[k];
      }
      if (k < html.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- What is shown ---------- */

  /** The file the build wrote into the page: its lines are read back from it. */
  function adopt(i: number) {
    current = i;
    lines = Array.from(ol.children, (li) => li.textContent ?? "");
    raw = lines.join("\n") + (data.initialEol && lines.length ? "\n" : "");
    selection = null;
    settle(i, false);
  }

  /** File i, from its text. */
  function show(i: number, text: string) {
    current = i;
    raw = text;
    lines = splitLines(text);
    selection = null;
    settle(i, true);
    viewer.scrollTo({ top: 0, left: 0 });
  }

  /** File i, whose text is not here (or could not be loaded): why, and where it is. */
  function showAway(i: number, failure = "") {
    current = i;
    generation += 1;
    lines = [];
    raw = "";
    selection = null;
    const f = data.files[i];
    const r = data.repos[f.repo];
    head(i);
    for (const b of [copyBtn, rawBtn, wrapBtn]) b.disabled = true;
    ol.replaceChildren();
    ol.hidden = true;
    fileNotes = [];
    pairNote = [];
    note.hidden = true;
    end.hidden = true;
    const at = sourceOf(r, f);
    const p = el("p", "warning", whyNotShown(f, r, failure));
    const go = el("p");
    go.append(at === r.url ? "It can be read in its repository, " : "It can be read at the source: ", link(at, at === r.url ? r.name : f.path), ".");
    away.replaceChildren(p, go);
    if (f.pairs.length) {
      const intro = el("p", "", `Its ${plural(f.pairs.length, "match", "matches")} with the paper, at the source:`);
      const ul = el("ul");
      for (const k of f.pairs) {
        const pr = data.pairs.find((x) => x.pair === k)!;
        const li = el("li", pairClass(k));
        li.dataset.pairs = String(k);
        li.append(
          pairLink(k, `[${k}]`, "paragraph"),
          " ",
          link(pr.source || at, pr.whole ? "the whole file" : `lines ${pr.start}–${pr.end}`),
          ` ↔ ${pr.label}${pr.whole ? " · a weak match" : ""}`,
        );
        ul.append(li);
      }
      away.append(intro, ul);
    }
    away.hidden = false;
    viewer.scrollTo({ top: 0, left: 0 });
  }

  function loading(i: number) {
    head(i);
    note.replaceChildren(`Loading ${data.files[i].path}…`);
    note.hidden = false;
  }

  /* ---------- Lines one links to ---------- */

  function select(r: Range | null, scroll: boolean) {
    for (const li of Array.from(ol.querySelectorAll(".is-selected"))) li.classList.remove("is-selected");
    selection = r ? clampRange(r, lines.length) : null;
    if (selection) {
      for (let n = selection.start; n <= selection.end; n++) ol.children[n - 1].classList.add("is-selected");
      linkBtn.textContent = selection.end > selection.start ? `Link to lines ${selection.start}–${selection.end}` : `Link to line ${selection.start}`;
      if (scroll) scrollInto(viewer, ol.children[selection.start - 1] as HTMLElement, "center");
    } else linkBtn.textContent = "Link";
    return selection;
  }

  /** A click in the gutter selects its line; with Shift, the lines from the last one clicked. */
  ol.addEventListener("click", (ev) => {
    const li = (ev.target as Element).closest("li");
    if (!li || li.parentElement !== ol) return;
    if (ev.clientX - viewer.getBoundingClientRect().left > gutter) return;
    ev.preventDefault();
    ev.stopPropagation();
    const n = Array.prototype.indexOf.call(ol.children, li) + 1;
    const r = ev.shiftKey && anchor ? { start: Math.min(anchor, n), end: Math.max(anchor, n) } : { start: n, end: n };
    if (!ev.shiftKey) anchor = n;
    select(r, false);
    history.replaceState(null, "", hooks.url(current, selection));
  });

  /* ---------- The buttons ---------- */

  const flash = (b: HTMLButtonElement, text: string) => {
    const before = b.textContent ?? "";
    b.textContent = text;
    hooks.say(text);
    setTimeout(() => {
      if (b.textContent === text) b.textContent = before;
    }, 1600);
  };
  copyBtn.addEventListener("click", async () => flash(copyBtn, (await copyText(raw)) ? "Copied" : "Copy failed"));
  linkBtn.addEventListener("click", async () => {
    const url = hooks.url(current, selection);
    history.replaceState(null, "", url);
    flash(linkBtn, (await copyText(new URL(url, location.href).href)) ? "Link copied" : "The link is in the address bar");
  });
  rawBtn.addEventListener("click", () => {
    const f = data.files[current];
    if (!f?.text) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([raw], { type: "text/plain;charset=utf-8" }));
    a.download = f.path.split("/").pop() || "file.txt";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });

  function setWrap(on: boolean) {
    viewer.classList.toggle("is-wrapped", on);
    wrapBtn.setAttribute("aria-pressed", String(on));
    gutter = gutterOf();
  }

  /* ---------- Pairs ---------- */

  /** Mark pair p's lines (or its entry, for a file not shown here); the element to bring into view. */
  function markPair(p: ReaderPair): HTMLElement | null {
    if (p.file !== current || p.file < 0) return null;
    if (!ol.hidden && lines.length) {
      pairNote = p.whole
        ? [`Match ${p.pair} covers the whole file: a weak match, which ties its paragraph to this file rather than to given lines.`]
        : [];
      notes();
      // Its lines take its color while it is read (a line of two pairs has the narrower's).
      const color = pairClass(p.pair);
      let first: HTMLElement | null = null;
      const to = Math.min(ol.children.length, Math.max(p.start, p.end));
      for (let n = Math.max(1, p.start); n <= to; n++) {
        const li = ol.children[n - 1] as HTMLElement;
        marked.push({ li, before: li.className });
        li.className = `${li.className.replace(/\bpair-\d\b/, "").trim()} ${color} is-active`.trim();
        if (p.whole && li.querySelector(`:scope > a[data-pair="${p.pair}"]`)) li.classList.add("lead");
        first ??= li;
      }
      return first;
    }
    const li = away.querySelector<HTMLElement>(`li[data-pairs~="${p.pair}"]`);
    li?.classList.add("is-active");
    return li;
  }

  /** No pair is being read any more. */
  function unmark() {
    for (const { li, before } of marked) li.className = before;
    marked = [];
    if (!pairNote.length) return;
    pairNote = [];
    notes();
  }

  return {
    adopt,
    show,
    showAway,
    loading,
    select,
    setWrap,
    markPair,
    unmark,
    get current() {
      return current;
    },
    get selection() {
      return selection;
    },
    get lineCount() {
      return lines.length;
    },
    anchorOf: (r: Range | null) => (r ? anchorText(r) : ""),
    viewer,
  };
}
