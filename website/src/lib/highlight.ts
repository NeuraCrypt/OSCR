// Syntax highlighting for the code views (night phase 02, E1): language detection with Linguist's
// names, highlight.js for the tokens (the owner's choice, 2026-09-29: class-based output, styled in
// science.css, no style attribute), and EditorConfig's tab width. Testable in Node
// (tests/forge-pages/highlight.test.ts).
//
// - Detection (`detectLanguage`): an override first (the repository's `.gitattributes`
//   `linguist-language`), then a Vim or Emacs modeline in the first or last five lines, then the
//   file name, the extension, a shebang. Linguist's names, mapped to highlight.js's (`hljsName`).
// - Highlighting (`highlightText`): highlight.js's core and ONE module per language, loaded when a
//   file needs it (each its own small chunk of the site). Its output is HTML text of <span
//   class="hljs-…"> and escaped text only; `parseHljs` reads exactly that and nothing else (any
//   other markup is refused, and the file is shown plain), into view trees: no HTML string ever
//   reaches the page. The spans are cut at each end of line and reopened on the next, so the view
//   keeps one `li` per line (ol.lines) and the tracing maps' line numbers hold.
// - The classes are highlight.js's own (`hljs-keyword`, `hljs-title function_`…), styled in
//   science.css; a parallel branch (`code-first`, the paper reader) uses the same classes, so the
//   two viewers share one set of rules.
// - EditorConfig (`editorConfigTabWidth`): the tab width a repository's `.editorconfig` sets for a
//   file, shown with science.css's `.tab-2`, `.tab-4`, `.tab-8`.
//
// Email addresses are masked in the whole text before it is highlighted (an address never spans a
// line, so the lines hold).

import type { HLJSApi, LanguageFn } from "highlight.js";
import { maskEmails } from "../../worker/forge/mask.ts";
import { type El, h } from "./repo-view.ts";

/** One line of highlighted code: text and spans of highlight.js's classes. */
export type LineNodes = (string | El)[];


// ─── language names ──────────────────────────────────────────────────────────

/** highlight.js's modules, one chunk each, loaded when a file needs one. */
const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  julia: () => import("highlight.js/lib/languages/julia"),
  matlab: () => import("highlight.js/lib/languages/matlab"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  fortran: () => import("highlight.js/lib/languages/fortran"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  scala: () => import("highlight.js/lib/languages/scala"),
  swift: () => import("highlight.js/lib/languages/swift"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  php: () => import("highlight.js/lib/languages/php"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  stan: () => import("highlight.js/lib/languages/stan"),
  nix: () => import("highlight.js/lib/languages/nix"),
  bash: () => import("highlight.js/lib/languages/bash"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  dos: () => import("highlight.js/lib/languages/dos"),
  sql: () => import("highlight.js/lib/languages/sql"),
  latex: () => import("highlight.js/lib/languages/latex"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ocaml: () => import("highlight.js/lib/languages/ocaml"),
  lua: () => import("highlight.js/lib/languages/lua"),
  perl: () => import("highlight.js/lib/languages/perl"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  mathematica: () => import("highlight.js/lib/languages/mathematica"),
  sas: () => import("highlight.js/lib/languages/sas"),
  stata: () => import("highlight.js/lib/languages/stata"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
  asciidoc: () => import("highlight.js/lib/languages/asciidoc"),
  scheme: () => import("highlight.js/lib/languages/scheme"),
  lisp: () => import("highlight.js/lib/languages/lisp"),
  clojure: () => import("highlight.js/lib/languages/clojure"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  erlang: () => import("highlight.js/lib/languages/erlang"),
  fsharp: () => import("highlight.js/lib/languages/fsharp"),
  dart: () => import("highlight.js/lib/languages/dart"),
  prolog: () => import("highlight.js/lib/languages/prolog"),
  verilog: () => import("highlight.js/lib/languages/verilog"),
  vhdl: () => import("highlight.js/lib/languages/vhdl"),
  glsl: () => import("highlight.js/lib/languages/glsl"),
  tcl: () => import("highlight.js/lib/languages/tcl"),
  awk: () => import("highlight.js/lib/languages/awk"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  gradle: () => import("highlight.js/lib/languages/gradle"),
  properties: () => import("highlight.js/lib/languages/properties"),
  coq: () => import("highlight.js/lib/languages/coq"),
  maxima: () => import("highlight.js/lib/languages/maxima"),
  gams: () => import("highlight.js/lib/languages/gams"),
  scilab: () => import("highlight.js/lib/languages/scilab"),
  delphi: () => import("highlight.js/lib/languages/delphi"),
  ada: () => import("highlight.js/lib/languages/ada"),
  d: () => import("highlight.js/lib/languages/d"),
  nim: () => import("highlight.js/lib/languages/nim"),
  crystal: () => import("highlight.js/lib/languages/crystal"),
  vim: () => import("highlight.js/lib/languages/vim"),
  llvm: () => import("highlight.js/lib/languages/llvm"),
  x86asm: () => import("highlight.js/lib/languages/x86asm"),
  elm: () => import("highlight.js/lib/languages/elm"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  scss: () => import("highlight.js/lib/languages/scss"),
  less: () => import("highlight.js/lib/languages/less"),
};

/** Linguist's names → highlight.js's. A language not listed is shown plain. */
const HLJS: Record<string, string> = {
  Python: "python", Cython: "python", Snakemake: "python", R: "r", Julia: "julia", MATLAB: "matlab", Octave: "matlab",
  C: "c", "C++": "cpp", CUDA: "cpp", "Objective-C": "objectivec", Fortran: "fortran", JavaScript: "javascript",
  TypeScript: "typescript", Go: "go", Rust: "rust", Java: "java", Kotlin: "kotlin", Scala: "scala", Swift: "swift",
  "C#": "csharp", PHP: "php", Groovy: "groovy", Nextflow: "groovy", Gradle: "gradle", Stan: "stan", Nix: "nix",
  Shell: "bash", PowerShell: "powershell", Batchfile: "dos", SQL: "sql", TeX: "latex", BibTeX: "latex", HTML: "xml",
  XML: "xml", SVG: "xml", CSS: "css", SCSS: "scss", Less: "less", JSON: "json", GeoJSON: "json", TopoJSON: "json",
  "Jupyter Notebook": "json", YAML: "yaml", TOML: "ini", INI: "ini", "Git Config": "ini", EditorConfig: "ini",
  "Java Properties": "properties", Makefile: "makefile", Dockerfile: "dockerfile", CMake: "cmake", Haskell: "haskell",
  OCaml: "ocaml", Lua: "lua", Perl: "perl", Ruby: "ruby", "Wolfram Language": "mathematica", SAS: "sas", Stata: "stata",
  Markdown: "markdown", Diff: "diff", AsciiDoc: "asciidoc", Scheme: "scheme", "Common Lisp": "lisp", Clojure: "clojure",
  Elixir: "elixir", Erlang: "erlang", "F#": "fsharp", Dart: "dart", Prolog: "prolog", Verilog: "verilog", VHDL: "vhdl",
  GLSL: "glsl", Tcl: "tcl", Awk: "awk", "Protocol Buffer": "protobuf", GraphQL: "graphql", Coq: "coq", Maxima: "maxima",
  GAMS: "gams", Scilab: "scilab", Pascal: "delphi", Ada: "ada", D: "d", Nim: "nim", Crystal: "crystal", "Vim Script": "vim",
  LLVM: "llvm", Assembly: "x86asm", Elm: "elm",
};

/** Every language the viewer highlights, by Linguist's name. */
export const LANGUAGES: readonly string[] = Object.keys(HLJS).sort();

/** highlight.js's name for a Linguist language, or null (shown plain). */
export const hljsName = (language: string | null | undefined): string | null => (language && HLJS[language]) || null;

// ─── language detection ──────────────────────────────────────────────────────

const EXTENSIONS: Record<string, string> = {
  py: "Python", pyw: "Python", pyi: "Python", pyx: "Cython", pxd: "Cython", smk: "Snakemake",
  r: "R", rmd: "Markdown", qmd: "Markdown", jl: "Julia", m: "MATLAB", mlx: "MATLAB",
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++", cu: "CUDA", cuh: "CUDA", mm: "Objective-C",
  f: "Fortran", for: "Fortran", f77: "Fortran", f90: "Fortran", f95: "Fortran", f03: "Fortran", f08: "Fortran",
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript",
  go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", swift: "Swift", cs: "C#", php: "PHP",
  groovy: "Groovy", nf: "Nextflow", stan: "Stan", nix: "Nix",
  sh: "Shell", bash: "Shell", zsh: "Shell", ksh: "Shell", fish: "Shell", ps1: "PowerShell", psm1: "PowerShell", bat: "Batchfile", cmd: "Batchfile",
  sql: "SQL", tex: "TeX", sty: "TeX", cls: "TeX", bib: "BibTeX", bst: "BibTeX",
  html: "HTML", htm: "HTML", xhtml: "HTML", xml: "XML", svg: "SVG", css: "CSS",
  json: "JSON", jsonc: "JSON", geojson: "GeoJSON", topojson: "TopoJSON", ipynb: "Jupyter Notebook", cff: "YAML",
  yml: "YAML", yaml: "YAML", toml: "TOML", ini: "INI", cfg: "INI", conf: "INI", properties: "INI",
  md: "Markdown", markdown: "Markdown", mdx: "Markdown", rst: "reStructuredText", adoc: "AsciiDoc", asciidoc: "AsciiDoc", org: "Org",
  txt: "Text", csv: "CSV", tsv: "TSV", tab: "TSV", diff: "Diff", patch: "Diff",
  hs: "Haskell", ml: "OCaml", mli: "OCaml", lua: "Lua", pl: "Perl", pm: "Perl", rb: "Ruby",
  wl: "Wolfram Language", nb: "Wolfram Language", pro: "IDL", sas: "SAS", do: "Stata", ado: "Stata",
  cmake: "CMake", mk: "Makefile", mmd: "Mermaid", mermaid: "Mermaid", stl: "STL", dockerfile: "Dockerfile",
  scm: "Scheme", ss: "Scheme", lisp: "Common Lisp", lsp: "Common Lisp", clj: "Clojure", cljs: "Clojure", ex: "Elixir", exs: "Elixir",
  erl: "Erlang", hrl: "Erlang", fs: "F#", fsx: "F#", dart: "Dart", v: "Verilog", sv: "Verilog", vhd: "VHDL", vhdl: "VHDL",
  glsl: "GLSL", frag: "GLSL", vert: "GLSL", tcl: "Tcl", awk: "Awk", proto: "Protocol Buffer", graphql: "GraphQL", gql: "GraphQL",
  gradle: "Gradle", coq: "Coq", mac: "Maxima", gms: "GAMS", sci: "Scilab", sce: "Scilab", pas: "Pascal", adb: "Ada", ads: "Ada",
  d: "D", nim: "Nim", cr: "Crystal", vim: "Vim Script", ll: "LLVM", asm: "Assembly", s: "Assembly", elm: "Elm", less: "Less",
  scss: "SCSS", prolog: "Prolog",
};

const FILENAMES: Record<string, string> = {
  makefile: "Makefile", gnumakefile: "Makefile", dockerfile: "Dockerfile", containerfile: "Dockerfile",
  "cmakelists.txt": "CMake", snakefile: "Snakemake", vagrantfile: "Ruby", rakefile: "Ruby", gemfile: "Ruby",
  ".gitignore": "Ignore List", ".dockerignore": "Ignore List", ".gitattributes": "Git Attributes", ".gitmodules": "Git Config",
  ".editorconfig": "EditorConfig", ".rprofile": "R", "pipfile": "TOML", "cargo.lock": "TOML", "nextflow.config": "Nextflow",
  ".bashrc": "Shell", ".zshrc": "Shell", ".profile": "Shell", "license": "Text", "copying": "Text", "requirements.txt": "Text",
  "citation.cff": "YAML", ".zenodo.json": "JSON", "codemeta.json": "JSON",
};

const SHEBANGS: [RegExp, string][] = [
  [/\bpython[0-9.]*\b/, "Python"],
  [/\bRscript\b/, "R"],
  [/\bjulia\b/, "Julia"],
  [/\b(?:ba|z|k|da)?sh\b/, "Shell"],
  [/\bperl\b/, "Perl"],
  [/\bruby\b/, "Ruby"],
  [/\bnode\b/, "JavaScript"],
  [/\bnextflow\b/, "Nextflow"],
];

/** Modeline names (Vim filetypes, Emacs modes) → Linguist names. */
const MODES: Record<string, string> = {
  python: "Python", r: "R", ess: "R", julia: "Julia", matlab: "MATLAB", octave: "MATLAB", c: "C", cpp: "C++", "c++": "C++",
  fortran: "Fortran", f90: "Fortran", javascript: "JavaScript", js: "JavaScript", typescript: "TypeScript", sh: "Shell", bash: "Shell",
  zsh: "Shell", "shell-script": "Shell", sql: "SQL", tex: "TeX", latex: "TeX", html: "HTML", xml: "XML", css: "CSS", json: "JSON",
  yaml: "YAML", toml: "TOML", markdown: "Markdown", go: "Go", rust: "Rust", java: "Java", perl: "Perl", ruby: "Ruby", lua: "Lua",
  haskell: "Haskell", ocaml: "OCaml", make: "Makefile", makefile: "Makefile", cmake: "CMake", dockerfile: "Dockerfile", text: "Text",
};

/** A language name from a modeline in the first or last five lines, or null. */
export function modeline(text: string): string | null {
  const lines = text.split("\n");
  const near = [...lines.slice(0, 5), ...lines.slice(Math.max(5, lines.length - 5))];
  for (const l of near) {
    const vim = /(?:^|\s)(?:vim?|ex):.*?\b(?:ft|filetype|syntax)=([A-Za-z0-9+_-]+)/.exec(l);
    if (vim && MODES[vim[1].toLowerCase()]) return MODES[vim[1].toLowerCase()];
    const emacs = /-\*-\s*(?:.*?mode:\s*)?([A-Za-z0-9+_-]+)\s*(?:;.*?)?-\*-/.exec(l);
    if (emacs && MODES[emacs[1].toLowerCase()]) return MODES[emacs[1].toLowerCase()];
  }
  return null;
}

/** Linguist's name for a file: `override` (.gitattributes linguist-language) when it is a name
 *  this file knows, then a modeline, the file name, the extension, a shebang; null when none
 *  says (the file is shown as plain text). */
export function detectLanguage(path: string, text = "", override?: string | null): string | null {
  if (override) {
    const known = LANGUAGES.find((l) => l.toLowerCase() === override.toLowerCase().replace(/_/g, " "));
    if (known) return known;
  }
  const fromModeline = text ? modeline(text) : null;
  if (fromModeline) return fromModeline;
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (FILENAMES[base]) return FILENAMES[base];
  if (/^dockerfile\./.test(base) || /\.dockerfile$/.test(base)) return "Dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot > 0 || (dot === 0 && base.length > 1)) {
    const ext = base.slice(dot + 1);
    if (ext === "r" && base.endsWith(".r")) return "R";
    if (EXTENSIONS[ext]) return EXTENSIONS[ext];
  }
  const first = text.split("\n", 1)[0] ?? "";
  if (first.startsWith("#!")) for (const [re, lang] of SHEBANGS) if (re.test(first)) return lang;
  return null;
}

// ─── highlighting ────────────────────────────────────────────────────────────

let core: Promise<HLJSApi> | null = null;
const loaded = new Map<string, Promise<boolean>>();

async function hljsCore(): Promise<HLJSApi> {
  core ??= import("highlight.js/lib/core").then((m) => {
    const api = (m.default ?? m) as HLJSApi;
    api.configure({ classPrefix: "hljs-", ignoreUnescapedHTML: true, throwUnescapedHTML: false });
    return api;
  });
  return core;
}

/** highlight.js with `name` registered (and, for HTML, CSS and JavaScript inside it); false when
 *  the module could not be loaded (the file is then shown plain). */
async function withLanguage(name: string): Promise<HLJSApi | null> {
  const api = await hljsCore();
  const load = (n: string): Promise<boolean> => {
    let p = loaded.get(n);
    if (!p) {
      const loader = LOADERS[n];
      p = loader
        ? loader().then(
            (m) => {
              api.registerLanguage(n, m.default);
              return true;
            },
            () => false,
          )
        : Promise.resolve(false);
      loaded.set(n, p);
    }
    return p;
  };
  if (!(await load(name))) return null;
  if (name === "xml") await Promise.all([load("css"), load("javascript")]);
  if (name === "markdown") await Promise.all([load("python"), load("bash"), load("r")]);
  return api;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const CLASS = /^[A-Za-z0-9_ -]{1,80}$/;

/** highlight.js's HTML output as lines of view trees: <span class="…">, </span> and escaped text,
 *  nothing else (anything else throws). Each line opens the spans still open at its start. */
export function parseHljs(html: string): LineNodes[] {
  const lines: LineNodes[] = [];
  // The open spans of the current line, outermost first, and their classes.
  let open: El[] = [];
  const classes: string[] = [];
  let line: LineNodes = [];
  const add = (node: string | El) => {
    const parent = open[open.length - 1];
    if (parent) parent.children.push(node);
    else line.push(node);
  };
  const reopen = () => {
    open = [];
    for (const c of classes) {
      const span = h("span", { class: c });
      if (open.length) open[open.length - 1].children.push(span);
      else line.push(span);
      open.push(span);
    }
  };
  const text = (t: string) => {
    const parts = t.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) {
        lines.push(line);
        line = [];
        reopen();
      }
      if (p) add(p);
    });
  };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<span class="', i)) {
      const end = html.indexOf('">', i);
      const cls = end < 0 ? "" : html.slice(i + 13, end);
      if (!CLASS.test(cls)) throw new Error("unexpected markup");
      const span = h("span", { class: cls });
      add(span);
      open.push(span);
      classes.push(cls);
      i = end + 2;
    } else if (html.startsWith("</span>", i)) {
      if (!classes.length) throw new Error("unexpected markup");
      classes.pop();
      open.pop();
      i += 7;
    } else if (html[i] === "<") {
      throw new Error("unexpected markup");
    } else {
      const next = html.indexOf("<", i);
      const chunk = html.slice(i, next < 0 ? html.length : next);
      if (/&(?!amp;|lt;|gt;|quot;|#x27;|#39;)/.test(chunk)) throw new Error("unexpected entity");
      text(chunk.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e]));
      i = next < 0 ? html.length : next;
    }
  }
  lines.push(line);
  return lines.map((l) => prune(l));
}

/** Drops the empty spans a reopened line may hold. */
function prune(nodes: LineNodes): LineNodes {
  const out: LineNodes = [];
  for (const n of nodes) {
    if (typeof n === "string") out.push(n);
    else {
      n.children = prune(n.children);
      if (n.children.length) out.push(n);
    }
  }
  return out;
}

/** The lines of a text, plain: one text node per line, masked for email addresses. */
export function plainLines(lines: readonly string[]): LineNodes[] {
  return lines.map((l) => (l ? [maskEmails(l)] : []));
}

/** The lines of a text, highlighted in `language` (Linguist's name), or plain when the language is
 *  unknown, its module cannot load, or highlight.js fails. The whole text is masked for email
 *  addresses BEFORE it is highlighted (an address split over several spans would escape a mask
 *  applied span by span); an address never spans a line, so the number of lines is always the
 *  text's own. */
export async function highlightText(lines: readonly string[], language: string | null): Promise<LineNodes[]> {
  const name = hljsName(language);
  if (!name || name === "plaintext" || !lines.length) return plainLines(lines);
  try {
    const api = await withLanguage(name);
    if (!api) return plainLines(lines);
    const out = parseHljs(api.highlight(maskEmails(lines.join("\n")), { language: name, ignoreIllegals: true }).value);
    if (out.length !== lines.length) return plainLines(lines);
    return out;
  } catch {
    return plainLines(lines);
  }
}

// ─── EditorConfig ────────────────────────────────────────────────────────────

/** An EditorConfig glob as a regular expression over a path from the repository's root. */
export function editorConfigGlob(glob: string): RegExp {
  let g = glob.trim();
  const anchored = g.includes("/");
  if (g.startsWith("/")) g = g.slice(1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end < 0) {
        re += "\\{";
        continue;
      }
      const inner = g.slice(i + 1, end);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
      re += range ? "-?\\d+" : `(?:${inner.split(",").map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += `[${g.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
}

/** The tab width `.editorconfig` (at the repository's root) sets for a path: tab_width, else
 *  indent_size when a number; the last matching section wins. null when it says nothing. */
export function editorConfigTabWidth(config: string, path: string): number | null {
  let tab: number | null = null;
  let indent: number | null = null;
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
    const n = Number(kv[2].trim());
    if (!Number.isInteger(n) || n < 1 || n > 16) continue;
    if (key === "tab_width") tab = n;
    else if (key === "indent_size") indent = n;
  }
  return tab ?? indent;
}

/** science.css's class for a tab width: tab-2, tab-4 (its default for code) or tab-8. */
export function tabClass(width: number | null): string {
  if (width === null) return "";
  if (width <= 2) return "tab-2";
  if (width <= 4) return "tab-4";
  return "tab-8";
}
