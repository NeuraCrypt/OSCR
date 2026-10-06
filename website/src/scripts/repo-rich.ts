// Rich files in the /r/ shell's file view (night phase 02, E5): Jupyter notebooks rendered and never
// run (src/lib/notebook.ts), CSV and TSV files as tables with a filter (src/lib/table.ts), a PDF
// opened in the browser's own PDF viewer, and a sentence above what the viewer shows as source
// although it is more (a map, a 3D model, a diagram, another markup: src/lib/rich.ts). Each has
// its source view too (?plain=1), with its line anchors.
//
// What it costs: nothing more than the file (a raw read, not counted in the reader's GitHub quota);
// a notebook's Markdown images of the repository are raw reads as well.

import { isDirectory } from "../lib/code-nav.ts";
import { repoResolvers } from "../lib/markdown.ts";
import { renderNotebook } from "../lib/notebook.ts";
import { h } from "../lib/repo-view.ts";
import { isPdf, richNote } from "../lib/rich.ts";
import { parseDelimited, tableDelimiter, tableView } from "../lib/table.ts";
import { binaryViews, blobNotes, renderers } from "./repo-code.ts";
import { fillImages } from "./repo-markdown.ts";

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// ─── notebooks ───────────────────────────────────────────────────────────────

renderers.push({
  name: "notebook",
  claims: (path) => /\.ipynb$/i.test(path),
  async render(file) {
    if (file.text === null) return null;
    const r = await renderNotebook(file.text, {
      ...repoResolvers({ repo: file.env.repo, ref: file.ref.ref, dir: dirOf(file.path), isDir: (p) => isDirectory(file.entries, p), web: file.env.endpoints.web, raw: file.env.endpoints.raw }),
    });
    if (!r) return null;
    return h(
      "div",
      null,
      h("p", { class: "rich-note" }, `A Jupyter notebook of ${r.cells.toLocaleString("en-GB")} ${r.cells === 1 ? "cell" : "cells"}${r.language ? ` in ${r.language}` : ""}, as it was saved: the viewer shows its outputs and never runs it.`),
      r.el,
    );
  },
  mounted: (root, file) => fillImages(root, file.env, file.commit, file.entries),
});

// ─── SVG images: drawn as an image (an <img> runs no script, loads nothing), their source a click away

renderers.push({
  name: "svg",
  claims: (path) => /\.svg$/i.test(path),
  render: async (file) => h("figure", { class: "file-image" }, h("img", { alt: file.path.split("/").pop() ?? file.path, "data-svg": "1" })),
  async mounted(root, file) {
    const img = root.querySelector<HTMLImageElement>("figure.file-image img[data-svg]");
    if (img) img.src = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: "image/svg+xml" }));
  },
});

// ─── tables ──────────────────────────────────────────────────────────────────

renderers.push({
  name: "table",
  claims: (path) => tableDelimiter(path) !== null,
  async render(file) {
    const delimiter = tableDelimiter(file.path);
    if (file.text === null || !delimiter) return null;
    const parsed = parseDelimited(file.text, delimiter);
    return parsed.rows.length ? tableView(parsed) : null;
  },
  async mounted(root) {
    const input = root.querySelector<HTMLInputElement>("#table-filter");
    const said = root.querySelector<HTMLElement>("#table-count");
    const rows = [...root.querySelectorAll<HTMLTableRowElement>("table.data tbody tr")];
    const texts = rows.map((r) => (r.textContent ?? "").toLowerCase());
    input?.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      let n = 0;
      rows.forEach((r, k) => {
        r.hidden = q !== "" && !texts[k].includes(q);
        if (!r.hidden) n++;
      });
      if (said) said.textContent = `${n.toLocaleString("en-GB")} ${n === 1 ? "row" : "rows"}${q ? ` of ${rows.length.toLocaleString("en-GB")}` : ""}`;
    });
  },
});

// ─── what the viewer shows as source although it is more ─────────────────────

blobNotes.push(async (_env, _opened, path, lines) => richNote(path, lines.join("\n"), new TextEncoder().encode(lines.slice(0, 20).join("\n"))));

// ─── binary files: a PDF, an STL model ───────────────────────────────────────

let pdf: Uint8Array | null = null;

binaryViews.push((path, bytes) => {
  if (/\.pdf$/i.test(path) || isPdf(bytes)) {
    if (!isPdf(bytes)) return null;
    pdf = bytes;
    return h(
      "p",
      null,
      "A PDF document. ",
      h("button", { type: "button", class: "link", id: "open-pdf" }, "Open it in your browser's PDF viewer"),
      " (a new tab, from the bytes read here), or download it.",
    );
  }
  if (/\.stl$/i.test(path)) return richNote(path, null, bytes);
  return null;
});

document.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (t?.id !== "open-pdf" || !pdf) return;
  // Typed application/pdf: the browser's PDF viewer shows it; it never becomes a page of this site.
  const url = URL.createObjectURL(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
