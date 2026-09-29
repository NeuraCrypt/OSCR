// Jupyter notebooks in the registry's viewer (night phase 02, E5): an .ipynb file (nbformat 4, and
// 3's worksheets) rendered from its JSON, as GitHub renders it, and never run. Pure, no DOM,
// testable in Node (tests/forge-pages/notebook.test.ts).
//
// - Markdown cells go through the one renderer (src/lib/markdown.ts, math included); their
//   attachments (attachment:name) are shown from the notebook's own bytes.
// - Code cells: the source highlighted in the kernel's language (highlight.js), "In [n]".
// - Outputs, the richest form the viewer may show: images (PNG, JPEG, GIF, WebP, and SVG as an
//   image, which runs nothing) as data: addresses; Markdown and LaTeX rendered; text and streams
//   as text; errors with their traceback, terminal colour codes removed. HTML and JavaScript outputs
//   and widgets never run: their text form is shown when the notebook has one, else a sentence.
// - Every text is masked for email addresses (the view trees do it: repo-view.ts `h`).

import { maskEmails } from "../../worker/forge/mask.ts";
import { highlightText, type LineNodes, plainLines } from "./highlight.ts";
import { fenceLanguage, type MarkdownContext, renderMarkdown } from "./markdown.ts";
import { type Macros, texToMathml } from "./mathml.ts";
import { type El, h, safeSrc } from "./repo-view.ts";

/** What the viewer shows of a notebook at most. */
export const NOTEBOOK_LIMITS = { cells: 2_000, outputChars: 100_000, highlightChars: 200_000 } as const;

type Json = Record<string, unknown>;

/** A notebook's multiline string (a list of lines, or one string). */
export function joinSource(x: unknown): string {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.filter((s): s is string => typeof s === "string").join("");
  return "";
}

/** Terminal escape sequences (colours, cursor moves, titles) removed. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[@-Z\\-_]/g, "").replace(/\r(?!\n)/g, "\n");
}

const cut = (text: string, max: number = NOTEBOOK_LIMITS.outputChars): { text: string; cut: boolean } =>
  text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };

/** A base64 payload as a notebook stores it (lines, spaces) → one clean string, or null. */
function base64Of(x: unknown): string | null {
  const s = joinSource(x).replace(/\s+/g, "");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? s : null;
}

/** UTF-8 text → base64 (for an SVG output shown as an image). */
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** An image output's data: address, or null. */
export function imageSrc(data: Json): string | null {
  for (const t of IMAGE_TYPES) {
    const b = base64Of(data[t]);
    if (b) return safeSrc(`data:${t};base64,${b}`);
  }
  const svg = joinSource(data["image/svg+xml"]);
  if (svg) return safeSrc(`data:image/svg+xml;base64,${utf8Base64(svg)}`);
  return null;
}

/** The kernel's language, as Linguist names it. */
export function notebookLanguage(nb: Json): string | null {
  const meta = (nb.metadata ?? {}) as Json;
  const kernel = (meta.kernelspec ?? {}) as Json;
  const info = (meta.language_info ?? {}) as Json;
  for (const x of [kernel.language, info.name, kernel.name, meta.language]) {
    if (typeof x === "string" && x) {
      const l = fenceLanguage(x.replace(/^python\d*$/i, "python").replace(/^ir$/i, "r"));
      if (l) return l;
    }
  }
  return null;
}

/** nbformat 3's worksheets as nbformat 4's cells (input → source, prompt_number → count,
 *  pyout → execute_result). */
function cellsOf(nb: Json): Json[] {
  if (Array.isArray(nb.cells)) return nb.cells as Json[];
  const sheets = Array.isArray(nb.worksheets) ? (nb.worksheets as Json[]) : [];
  return sheets.flatMap((w) => (Array.isArray(w.cells) ? (w.cells as Json[]) : [])).map((c) => {
    if (c.cell_type === "heading") return { cell_type: "markdown", source: `${"#".repeat(Number(c.level) || 1)} ${joinSource(c.source)}` };
    if (c.cell_type !== "code") return c;
    const outputs = (Array.isArray(c.outputs) ? (c.outputs as Json[]) : []).map((o) => {
      const type = o.output_type === "pyout" ? "execute_result" : o.output_type === "pyerr" ? "error" : o.output_type;
      if (type === "stream") return { output_type: "stream", name: o.stream ?? "stdout", text: o.text };
      if (type === "error") return o;
      const data: Json = {};
      for (const [k, v] of Object.entries({ text: "text/plain", png: "image/png", jpeg: "image/jpeg", svg: "image/svg+xml", html: "text/html", latex: "text/latex", markdown: "text/markdown" })) if (o[k] !== undefined) data[v] = o[k];
      return { output_type: type, data, execution_count: o.prompt_number };
    });
    return { cell_type: "code", source: c.input, execution_count: c.prompt_number, outputs };
  });
}

export interface NotebookResult {
  el: El;
  language: string | null;
  cells: number;
}

const count = (n: unknown): string => (Number.isInteger(n) ? String(n) : " ");

/** A notebook's JSON → its view tree; null when it is not a notebook the viewer reads. */
export async function renderNotebook(json: string, ctx: MarkdownContext = {}): Promise<NotebookResult | null> {
  let nb: Json;
  try {
    nb = JSON.parse(json) as Json;
  } catch {
    return null;
  }
  if (!nb || typeof nb !== "object" || Array.isArray(nb) || !(Array.isArray(nb.cells) || Array.isArray(nb.worksheets))) return null;
  const language = notebookLanguage(nb);
  const macros: Macros = ctx.macros ?? new Map();
  const all = cellsOf(nb);
  const cells = all.slice(0, NOTEBOOK_LIMITS.cells);
  let highlighted = 0;
  const out: El[] = [];
  for (const cell of cells) {
    const type = cell.cell_type;
    const source = maskEmails(joinSource(cell.source));
    if (type === "markdown") {
      const attachments: Record<string, string> = {};
      for (const [name, data] of Object.entries((cell.attachments ?? {}) as Record<string, Json>)) {
        const src = data && typeof data === "object" ? imageSrc(data) : null;
        if (src) attachments[name] = src;
      }
      const r = await renderMarkdown(source, { ...ctx, macros, attachments });
      out.push(h("div", { class: "nb-cell nb-markdown" }, r.el));
    } else if (type === "code") {
      const lines = source.split("\n");
      highlighted += source.length;
      const nodes: LineNodes[] = highlighted > NOTEBOOK_LIMITS.highlightChars ? plainLines(lines) : await highlightText(lines, language);
      const code = h("code", null, ...nodes.flatMap((l, k) => (k ? ["\n", ...l] : l)));
      const outputs = (Array.isArray(cell.outputs) ? (cell.outputs as Json[]) : []).map((o) => output(o, ctx, macros));
      out.push(
        h(
          "div",
          { class: "nb-cell nb-code" },
          h("div", { class: "nb-input" }, h("span", { class: "nb-prompt" }, `In [${count(cell.execution_count)}]:`), h("pre", { class: "code-block" }, code)),
          ...(await Promise.all(outputs)),
        ),
      );
    } else if (type === "raw") {
      out.push(h("div", { class: "nb-cell nb-raw" }, h("pre", null, source)));
    }
  }
  if (all.length > cells.length) out.push(h("p", { class: "warning" }, `This notebook has ${all.length.toLocaleString("en-GB")} cells: the first ${cells.length.toLocaleString("en-GB")} are shown.`));
  return { el: h("div", { class: "notebook" }, ...out), language, cells: all.length };
}

/** One output, the richest form the viewer may show. */
async function output(o: Json, ctx: MarkdownContext, macros: Macros): Promise<El> {
  const kind = o.output_type;
  const box = (cls: string, ...kids: (El | string | null)[]) => h("div", { class: `nb-output ${cls}` }, ...kids);
  const text = (t: string, cls: string) => {
    const c = cut(stripAnsi(maskEmails(t)));
    return box(cls, h("pre", null, c.text), c.cut ? h("p", { class: "nb-note" }, "This output is longer than the viewer shows: the rest is in the file's source.") : null);
  };
  if (kind === "stream") return text(joinSource(o.text), o.name === "stderr" ? "nb-stream nb-stderr" : "nb-stream");
  if (kind === "error") {
    const tb = Array.isArray(o.traceback) ? (o.traceback as unknown[]).filter((x): x is string => typeof x === "string").join("\n") : "";
    return text(tb || `${String(o.ename ?? "Error")}: ${String(o.evalue ?? "")}`, "nb-error");
  }
  if (kind !== "execute_result" && kind !== "display_data" && kind !== "update_display_data") return box("nb-note", h("p", null, "An output the viewer does not read."));
  const data = (o.data ?? {}) as Json;
  const prompt = kind === "execute_result" ? h("span", { class: "nb-prompt" }, `Out [${count(o.execution_count)}]:`) : null;
  const src = imageSrc(data);
  if (src) return box("nb-image", prompt, h("img", { src, alt: cut(joinSource(data["text/plain"]) || "An output image", 200).text }));
  const md = joinSource(data["text/markdown"]);
  if (md) return box("nb-rendered", prompt, (await renderMarkdown(maskEmails(md), { ...ctx, macros })).el);
  const latex = joinSource(data["text/latex"]).trim();
  if (latex) {
    const tex = latex.replace(/^\$\$([\s\S]*)\$\$$/, "$1").replace(/^\$([\s\S]*)\$$/, "$1").replace(/^\\\[([\s\S]*)\\\]$/, "$1");
    return box("nb-rendered", prompt, h("div", { class: "math-block" }, texToMathml(maskEmails(tex), true, macros).el));
  }
  const json = data["application/json"];
  const plain = joinSource(data["text/plain"]);
  const active = ["text/html", "application/javascript", "application/vnd.jupyter.widget-view+json", "application/vnd.plotly.v1+json", "application/vnd.bokehjs_load.v0+json"].filter((t) => data[t] !== undefined);
  if (plain) {
    const c = cut(stripAnsi(maskEmails(plain)));
    return box("nb-text", prompt, h("pre", null, c.text), active.length ? h("p", { class: "nb-note" }, "Its HTML or interactive form is not run here: the text form is shown.") : null);
  }
  if (json !== undefined) return text(JSON.stringify(json, null, 2), "nb-text");
  if (active.length) return box("nb-note", prompt, h("p", null, `An ${active.includes("text/html") ? "HTML" : "interactive"} output: the viewer never runs a notebook's HTML or JavaScript, and this one has no text form.`));
  return box("nb-note", prompt, h("p", null, "An output the viewer does not read."));
}
