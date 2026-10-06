// Templates and writing aids in the registry's editor (night phase 03, E5; docs/WEB_EDITING.md),
// plugged into repo-edit.ts's hooks (nameHelpers, editorAids). The rules are src/lib/templates.ts.
//
// - Under the name field: a licence picker for LICENSE, a code-of-conduct picker for
//   CODE_OF_CONDUCT.md (their texts from GitHub's licences and codes-of-conduct API, in the reader's
//   browser: one request of the reader's quota when a template is chosen), CITATION.cff from a paper
//   the repository is linked to, a research README.
// - Under the editor: CITATION.cff, codemeta.json and .zenodo.json checked as they are written.
// - For Markdown: a toolbar of plain words, its keys (Ctrl/Cmd+B, I, E, K; Ctrl/Cmd+Shift+7, 8 and
//   . for lists and quotes), a URL pasted over a selection made a link, cells pasted from a
//   spreadsheet made a table, and the slash commands /table, /code, /details, /cite <DOI> (Enter at
//   the end of the line). Every change goes through the browser's insertText: undo takes it back.
// Nothing here writes HTML; every text is a text node.

import { isMarkdownPath } from "../lib/markdown.ts";
import { repoPath } from "../lib/forge.ts";
import {
  CONDUCT_CHOICES,
  checkMetadata,
  citationTemplate,
  fillConduct,
  fillLicence,
  isCitationName,
  isConductName,
  isLicenceName,
  isReadmeName,
  LICENCE_CHOICES,
  licenceForRegistry,
  type MarkdownAction,
  markdownEdit,
  pasteAsLink,
  pasteAsTable,
  readmeTemplate,
  slashCommand,
} from "../lib/templates.ts";
import { applyEdit, el } from "./code-editor.ts";
import type { CodeEnv } from "./repo-code.ts";
import { editorAids, nameHelpers } from "./repo-edit.ts";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A template's text from GitHub's API (the reader's own quota), or the problem in words. */
async function fromGitHub(env: CodeEnv, path: string): Promise<string | { problem: string }> {
  try {
    const res = await fetch(`${env.endpoints.api}${path}`, { headers: { Accept: "application/vnd.github+json" } });
    if (res.status === 403 || res.status === 429) return { problem: "GitHub's limit for reading without signing in is reached from your connection: try again in a while." };
    if (!res.ok) return { problem: "GitHub did not give this template: try another, or write the file." };
    const j = (await res.json()) as { body?: unknown };
    return typeof j.body === "string" && j.body.length < 200_000 ? j.body : { problem: "GitHub's answer is not a template." };
  } catch {
    return { problem: "GitHub could not be reached: check the connection, or write the file." };
  }
}

// ─── under the name field ────────────────────────────────────────────────────

nameHelpers.push(async ({ env, path, editor }) => {
  if (!isLicenceName(path)) return null;
  const site = env.site || "the registry";
  const choose = el("select", { id: "licence-choice", "aria-label": "Licence" }, ...LICENCE_CHOICES.map((l) => el("option", { value: l.key }, l.name)));
  const holder = el("input", { type: "text", id: "licence-holder", autocomplete: "off", value: env.repo.owner, "aria-label": "Copyright holder" });
  const explain = el("p", { class: "explain" });
  const said = el("p", { "aria-live": "polite" });
  const use = el("button", { type: "button" }, "Use this licence");
  const sayWhat = () => {
    const l = LICENCE_CHOICES.find((x) => x.key === choose.value)!;
    explain.textContent = `${l.explain} ${capital(licenceForRegistry(l, site))}`;
  };
  choose.addEventListener("change", sayWhat);
  sayWhat();
  use.addEventListener("click", async () => {
    said.textContent = "Reading the licence's text…";
    const body = await fromGitHub(env, `/licenses/${encodeURIComponent(choose.value)}`);
    if (typeof body !== "string") {
      said.textContent = body.problem;
      return;
    }
    editor.value = fillLicence(body, { year: new Date().getFullYear(), holder: holder.value });
    said.textContent = "The licence's text is in the editor: read it, then commit.";
  });
  return el(
    "div",
    { class: "template-picker" },
    el("p", {}, el("strong", {}, "Choose a licence template"), ", a licence lets others reuse the code, and lets the registry keep and show copies of it."),
    el("p", {}, choose, " ", el("label", { for: "licence-holder" }, "Copyright holder "), holder, " ", use),
    explain,
    said,
  );
});

nameHelpers.push(async ({ env, path, editor }) => {
  if (!isConductName(path)) return null;
  const choose = el("select", { id: "conduct-choice", "aria-label": "Code of conduct" }, ...CONDUCT_CHOICES.map((c) => el("option", { value: c.key }, c.name)));
  const said = el("p", { "aria-live": "polite" });
  const use = el("button", { type: "button" }, "Use this code of conduct");
  use.addEventListener("click", async () => {
    said.textContent = "Reading the text…";
    const body = await fromGitHub(env, `/codes_of_conduct/${encodeURIComponent(choose.value)}`);
    if (typeof body !== "string") {
      said.textContent = body.problem;
      return;
    }
    const contact = `the maintainers, through this repository's page in the registry (${location.origin}${repoPath(env.repo)})`;
    editor.value = fillConduct(body, { project: env.repo.name, contact });
    said.textContent = "The text is in the editor, its contact set to the repository's page (the registry shows no email address).";
  });
  return el("div", { class: "template-picker" }, el("p", {}, el("strong", {}, "Choose a code of conduct"), " "), el("p", {}, choose, " ", use), said);
});

nameHelpers.push(async ({ env, path, editor, created }) => {
  if (!isCitationName(path) && !isReadmeName(path)) return null;
  // Offered for a new file (or an empty one): an existing README or citation is the authors' own.
  if (!created && editor.value.trim()) return null;
  const papers = env.layer?.papers ?? [];
  const citation = isCitationName(path);
  const buttons = (papers.length ? papers.slice(0, 5) : [null]).map((p) => {
    const b = el("button", { type: "button" }, p ? `From the paper ${p.title ?? p.doi}` : citation ? "Start from a template" : "Start from a research README");
    b.addEventListener("click", () => {
      const paper = p ? { doi: p.doi, title: p.title } : null;
      editor.value = citation
        ? citationTemplate({ owner: env.repo.owner, name: env.repo.name, web: `https://github.com/${env.repo.owner}/${env.repo.name}` }, paper, env.info.licenseSpdx)
        : readmeTemplate(env.repo, paper);
      editor.focus();
    });
    return b;
  });
  return el(
    "div",
    { class: "template-picker" },
    el("p", {}, el("strong", {}, citation ? "A CITATION.cff" : "A README for research code"), citation ? ", GitHub and the registry offer “Cite this repository” from it; the paper comes first." : ", what it does, the paper, how to run it, the data, the licence, how to cite."),
    el("p", {}, ...buttons.flatMap((b, i) => (i ? [" ", b] : [b]))),
  );
});

// ─── under the editor: research metadata checked as written ──────────────────

editorAids.push((ctx) => {
  const said = el("p", { class: "metadata-check", "aria-live": "polite", hidden: "hidden" });
  ctx.editor.root.after(said);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const r = checkMetadata(ctx.path(), ctx.editor.value);
    said.hidden = !r;
    said.className = r ? `metadata-check ${r.ok ? "ok" : "warning"}` : "metadata-check";
    said.textContent = r?.said ?? "";
  };
  ctx.editor.input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(check, 400);
  });
  ctx.host.querySelector("#edit-name")?.addEventListener("input", () => setTimeout(check, 50));
  check();
});

// ─── Markdown: the toolbar, its keys, pasting, slash commands ────────────────

const BUTTONS: [MarkdownAction, string, string][] = [
  ["heading", "Heading", ""],
  ["bold", "Bold", "B"],
  ["italic", "Italic", "I"],
  ["quote", "Quote", ""],
  ["code", "Code", "E"],
  ["link", "Link", "K"],
  ["bullets", "Bullets", ""],
  ["numbers", "Numbers", ""],
  ["tasks", "Tasks", ""],
];

editorAids.push((ctx) => {
  const isMarkdown = () => {
    const p = ctx.path();
    return (!!p && isMarkdownPath(p)) || ctx.language() === "Markdown";
  };
  const ta = ctx.editor.input;
  const act = (a: MarkdownAction) => applyEdit(ta, markdownEdit(ta.value, { start: ta.selectionStart, end: ta.selectionEnd }, a));
  const bar = el(
    "div",
    { class: "md-toolbar", role: "toolbar", "aria-label": "Markdown", hidden: "hidden" },
    ...BUTTONS.flatMap(([a, label, key], i) => {
      const b = el("button", { type: "button", title: key ? `${label} (Ctrl or ⌘ + ${key})` : label }, label);
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", () => act(a));
      return i ? [" ", b] : [b];
    }),
    el("span", { class: "md-hint" }, " · Type /table, /code, /details or /cite 10.… on a line, then Enter"),
  );
  ctx.editor.root.prepend(bar);
  const sync = () => {
    bar.hidden = !isMarkdown();
  };
  ctx.host.querySelector("#edit-name")?.addEventListener("input", () => setTimeout(sync, 0));
  sync();

  // Keys before the editor's own (the capture phase on its box).
  ctx.editor.root.addEventListener(
    "keydown",
    (ev) => {
      if (ev.target !== ta || !isMarkdown()) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      let a: MarkdownAction | null = null;
      if (mod && !ev.shiftKey && !ev.altKey) a = k === "b" ? "bold" : k === "i" ? "italic" : k === "e" ? "code" : k === "k" ? "link" : null;
      if (mod && ev.shiftKey) a = ev.code === "Digit7" ? "numbers" : ev.code === "Digit8" ? "bullets" : ev.code === "Period" ? "quote" : null;
      if (a) {
        ev.preventDefault();
        ev.stopPropagation();
        act(a);
        return;
      }
      if (ev.key === "Enter" && !mod && !ev.shiftKey && !ev.altKey && ta.selectionStart === ta.selectionEnd) {
        const at = ta.selectionStart;
        const start = ta.value.lastIndexOf("\n", at - 1) + 1;
        const end = ta.value.indexOf("\n", at) < 0 ? ta.value.length : ta.value.indexOf("\n", at);
        if (at !== end) return;
        const cmd = slashCommand(ta.value.slice(start, end));
        if (!cmd) return;
        ev.preventDefault();
        ev.stopPropagation();
        applyEdit(ta, { from: start, to: end, insert: cmd.insert, select: { start: start + cmd.select[0], end: start + cmd.select[1] } });
      }
    },
    true,
  );
  ctx.editor.root.addEventListener(
    "paste",
    (ev) => {
      if (ev.target !== ta || !isMarkdown() || ev.clipboardData?.files.length) return;
      const text = ev.clipboardData?.getData("text/plain") ?? "";
      const sel = { start: ta.selectionStart, end: ta.selectionEnd };
      const link = pasteAsLink(ta.value, sel, text);
      if (link) {
        ev.preventDefault();
        ev.stopPropagation();
        applyEdit(ta, link);
        return;
      }
      const table = pasteAsTable(text);
      if (table) {
        ev.preventDefault();
        ev.stopPropagation();
        applyEdit(ta, { from: sel.start, to: sel.end, insert: table, select: { start: sel.start + table.length, end: sel.start + table.length } });
      }
    },
    true,
  );
});
