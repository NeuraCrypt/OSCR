// The code viewer's pure logic, shared by the build, the reader's browser, the highlighter's
// worker and the tests (tests/reader.test.ts): nothing here touches the page, a file or the
// network.
//
//   - languageOf: in which highlighter language a file is read, and its name in words;
//   - planOf: how a notebook or an R Markdown file splits into runs of lines of one language
//     each (the lines keep their numbers, so that the pairs and the anchors still hold);
//   - splitHighlighted: the highlighter's HTML, one piece per line;
//   - lineAnchor / anchorText: the "#L10-L20" of a link to lines;
//   - sizeInWords: "2.1 KB".

/** How a file is read: `id`, a highlight.js language ("" for plain text); `name`, in words;
 *  `mode`: a plain file, a notebook (cells stored as text, `# %%` headers), or a literate
 *  file (R Markdown, Quarto: Markdown with fenced chunks of code). */
export type Lang = { id: string; name: string; mode: "code" | "notebook" | "literate" };

/** The languages the highlighter's worker can load (src/lib/hljs-languages.ts): every `id`
 *  given here is one of them. "nmodl" and "hoc", NEURON's, are the registry's own grammars
 *  (src/lib/grammars.ts). */
export const LANGUAGE_IDS = [
  "bash", "c", "cmake", "cpp", "csharp", "css", "diff", "dockerfile", "dos", "fortran", "go", "haskell", "hoc", "ini",
  "java", "javascript", "json", "julia", "kotlin", "latex", "lua", "makefile", "markdown", "mathematica", "matlab", "nmodl",
  "perl", "php", "powershell", "python", "r", "ruby", "rust", "sas", "scala", "sql", "stan", "stata", "swift", "typescript",
  "xml", "yaml",
] as const;

const code = (id: string, name: string): Lang => ({ id, name, mode: "code" });
const TEXT = code("", "Text");

/** By extension, in lower case. */
const BY_EXT: Record<string, Lang> = {
  py: code("python", "Python"), pyw: code("python", "Python"), pyi: code("python", "Python"), pyx: code("python", "Cython"),
  ipynb: { id: "python", name: "Jupyter notebook", mode: "notebook" },
  m: code("matlab", "MATLAB"), mlx: code("matlab", "MATLAB live script"),
  r: code("r", "R"),
  rmd: { id: "r", name: "R Markdown", mode: "literate" },
  qmd: { id: "python", name: "Quarto", mode: "literate" },
  jl: code("julia", "Julia"),
  c: code("c", "C"),
  h: code("cpp", "C/C++ header"), hh: code("cpp", "C++ header"), hpp: code("cpp", "C++ header"), hxx: code("cpp", "C++ header"),
  cc: code("cpp", "C++"), cpp: code("cpp", "C++"), cxx: code("cpp", "C++"), "c++": code("cpp", "C++"), ino: code("cpp", "Arduino"),
  cu: code("cpp", "CUDA"), cuh: code("cpp", "CUDA"),
  java: code("java", "Java"),
  js: code("javascript", "JavaScript"), mjs: code("javascript", "JavaScript"), cjs: code("javascript", "JavaScript"),
  jsx: code("javascript", "JavaScript (JSX)"),
  ts: code("typescript", "TypeScript"), mts: code("typescript", "TypeScript"), cts: code("typescript", "TypeScript"),
  tsx: code("typescript", "TypeScript (TSX)"),
  sh: code("bash", "Shell"), bash: code("bash", "Shell"), zsh: code("bash", "Shell"), ksh: code("bash", "Shell"),
  slurm: code("bash", "Shell (Slurm)"), sbatch: code("bash", "Shell (Slurm)"), pbs: code("bash", "Shell (PBS)"),
  sql: code("sql", "SQL"),
  yml: code("yaml", "YAML"), yaml: code("yaml", "YAML"), cff: code("yaml", "YAML"),
  json: code("json", "JSON"), geojson: code("json", "JSON"),
  md: code("markdown", "Markdown"), markdown: code("markdown", "Markdown"),
  mk: code("makefile", "Makefile"), mak: code("makefile", "Makefile"),
  dockerfile: code("dockerfile", "Dockerfile"),
  pl: code("perl", "Perl"), pm: code("perl", "Perl"),
  go: code("go", "Go"),
  rs: code("rust", "Rust"),
  f: code("fortran", "Fortran"), for: code("fortran", "Fortran"), f77: code("fortran", "Fortran"), f90: code("fortran", "Fortran"),
  f95: code("fortran", "Fortran"), f03: code("fortran", "Fortran"), f08: code("fortran", "Fortran"),
  stan: code("stan", "Stan"),
  do: code("stata", "Stata"), ado: code("stata", "Stata"),
  sas: code("sas", "SAS"),
  nb: code("mathematica", "Mathematica"), wl: code("mathematica", "Wolfram Language"), wls: code("mathematica", "Wolfram Language"),
  scala: code("scala", "Scala"),
  mod: code("nmodl", "NEURON NMODL"),
  hoc: code("hoc", "NEURON hoc"), ses: code("hoc", "NEURON session"),
  xml: code("xml", "XML"), html: code("xml", "HTML"), htm: code("xml", "HTML"), svg: code("xml", "SVG"),
  toml: code("ini", "TOML"), ini: code("ini", "INI"), cfg: code("ini", "Configuration"),
  cmake: code("cmake", "CMake"),
  tex: code("latex", "LaTeX"), sty: code("latex", "LaTeX"),
  ps1: code("powershell", "PowerShell"),
  bat: code("dos", "Batch"), cmd: code("dos", "Batch"),
  css: code("css", "CSS"),
  diff: code("diff", "Diff"), patch: code("diff", "Diff"),
  lua: code("lua", "Lua"), rb: code("ruby", "Ruby"), php: code("php", "PHP"), kt: code("kotlin", "Kotlin"),
  swift: code("swift", "Swift"), cs: code("csharp", "C#"), hs: code("haskell", "Haskell"),
  sps: code("", "SPSS"),
  txt: TEXT, rst: code("", "reStructuredText"), csv: code("", "CSV"), tsv: code("", "TSV"),
};

/** By the whole name of the file, in lower case. */
const BY_NAME: Record<string, Lang> = {
  makefile: code("makefile", "Makefile"), gnumakefile: code("makefile", "Makefile"),
  dockerfile: code("dockerfile", "Dockerfile"), containerfile: code("dockerfile", "Containerfile"),
  "cmakelists.txt": code("cmake", "CMake"),
  snakefile: code("python", "Snakemake"),
  license: code("", "License"), licence: code("", "License"), copying: code("", "License"), "license.txt": code("", "License"),
  "licence.txt": code("", "License"), "license.md": code("markdown", "License"), "licence.md": code("markdown", "License"),
  readme: TEXT,
};

/** By the harvester's name of the language (oscr/repos.py, oscr/contents.py), when the file's
 *  name says nothing. */
const BY_LABEL: Record<string, Lang> = {
  matlab: BY_EXT.m, python: BY_EXT.py, r: BY_EXT.r, "c/c++": BY_EXT.h, "c++": BY_EXT.cpp, c: BY_EXT.c, shell: BY_EXT.sh,
  jupyter: BY_EXT.ipynb, javascript: BY_EXT.js, java: BY_EXT.java, typescript: BY_EXT.ts, julia: BY_EXT.jl, perl: BY_EXT.pl,
  go: BY_EXT.go, rust: BY_EXT.rs, fortran: BY_EXT.f90, quarto: BY_EXT.qmd, cuda: BY_EXT.cu, stan: BY_EXT.stan, stata: BY_EXT.do,
  sas: BY_EXT.sas, mathematica: BY_EXT.nb, scala: BY_EXT.scala, spss: BY_EXT.sps, license: code("", "License"), text: TEXT,
  neuron: code("hoc", "NEURON"),
};

/** The language of a file, from its path, else from the harvester's name for it. */
export function languageOf(path: string, label = ""): Lang {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (/^(dockerfile|containerfile)[._-]/.test(name)) return BY_NAME.dockerfile;
  if (/^makefile[._-]/.test(name)) return BY_NAME.makefile;
  if (/^(licen[cs]e|copying)([._-]|$)/.test(name)) return name.endsWith(".md") ? BY_NAME["license.md"] : BY_NAME.license;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  if (ext && Object.hasOwn(BY_EXT, ext)) return BY_EXT[ext];
  const known = BY_LABEL[label.trim().toLowerCase()];
  return known ?? (label.trim() ? code("", label.trim()) : TEXT);
}

/* ---------- Notebooks and literate files ---------- */

/** A run of lines [from, to) read in one language. `strip`: the notebook's Markdown lines,
 *  stored as comments ("# " + the line), are shown without it. */
export type Segment = { from: number; to: number; lang: string; strip?: boolean };
/** What a line is, beyond its language: the header of a notebook's cell ("# %%"), or a line
 *  of prose (a Markdown cell, the text of an R Markdown file). */
export type Role = "cell-code" | "cell-markdown" | "cell-raw" | "prose";
export type Plan = { segments: Segment[]; roles: Map<number, Role> };

/** The language of a notebook's code, the way the harvester guesses it (oscr/repofeatures.py,
 *  `_sniff_language`): Python unless R or Julia is clearly more frequent. */
export function sniffLanguage(code: string): "python" | "r" | "julia" {
  const python = (code.match(/^\s*(?:import\s+\w|from\s+[\w.]+\s+import\b)/gm) ?? []).length;
  const r = (code.match(/^\s*(?:library|require)\s*\(|<-/gm) ?? []).length;
  const julia = (code.match(/^\s*using\s+[A-Z]/gm) ?? []).length;
  if (r > python && r >= julia) return "r";
  if (julia > python) return "julia";
  return "python";
}

const CELL = /^# %%(.*)$/;
/** The chunk languages of R Markdown and Quarto that the highlighter knows. */
const CHUNK: Record<string, string> = {
  r: "r", python: "python", py: "python", julia: "julia", bash: "bash", sh: "bash", sql: "sql", stan: "stan", c: "c",
  cpp: "cpp", rcpp: "cpp", js: "javascript", ojs: "javascript", yaml: "yaml", matlab: "matlab", octave: "matlab",
};

/** How the lines of a file are highlighted: one segment for a plain file; for a notebook, one
 *  per cell (its header is a role of its own); for R Markdown or Quarto, Markdown around the
 *  fenced chunks, each in its language, and YAML for the front matter. */
export function planOf(lines: readonly string[], lang: Lang): Plan {
  const roles = new Map<number, Role>();
  const segments: Segment[] = [];
  const push = (from: number, to: number, l: string, strip = false) => {
    if (to <= from) return;
    const last = segments[segments.length - 1];
    if (last && last.to === from && last.lang === l && !!last.strip === strip) last.to = to;
    else segments.push(strip ? { from, to, lang: l, strip } : { from, to, lang: l });
  };
  if (lang.mode === "notebook") {
    // A notebook the harvester could not read as JSON is stored as it was.
    if (lines.length && lines[0].trimStart().startsWith("{")) return { segments: [{ from: 0, to: lines.length, lang: "json" }], roles };
    const heads = lines.map((l, i) => (CELL.test(l) ? i : -1)).filter((i) => i >= 0);
    const codeLines = lines.filter((l, i) => !CELL.test(l) && !isMarkdownLine(lines, heads, i));
    const kernel = sniffLanguage(codeLines.join("\n"));
    if (!heads.length || heads[0] > 0) push(0, heads.length ? heads[0] : lines.length, kernel);
    heads.forEach((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
      const kind = /\[markdown\]/.test(lines[h]) ? "markdown" : /\[raw\]/.test(lines[h]) ? "raw" : "code";
      roles.set(h, `cell-${kind}` as Role);
      push(h, h + 1, "");
      if (kind === "markdown") {
        for (let i = h + 1; i < end; i++) roles.set(i, "prose");
        push(h + 1, end, "markdown", true);
      } else push(h + 1, end, kind === "raw" ? "" : kernel);
    });
    return { segments, roles };
  }
  if (lang.mode === "literate") {
    let i = 0;
    // The front matter, between two "---" lines at the top.
    if (lines[0]?.trim() === "---") {
      const close = lines.findIndex((l, j) => j > 0 && /^(---|\.\.\.)\s*$/.test(l));
      if (close > 0) {
        push(0, close + 1, "yaml");
        i = close + 1;
      }
    }
    let prose = i;
    while (i < lines.length) {
      const open = lines[i].match(/^\s*(`{3,}|~{3,})\s*\{?\s*([A-Za-z0-9_+-]*)[^`]*$/);
      if (!open) {
        i += 1;
        continue;
      }
      const fence = open[1];
      const inner = CHUNK[open[2].toLowerCase()] ?? "";
      let close = i + 1;
      while (close < lines.length && !lines[close].trim().startsWith(fence)) close += 1;
      for (let j = prose; j < i; j++) roles.set(j, "prose");
      push(prose, i, "markdown");
      push(i, i + 1, "markdown");
      push(i + 1, Math.min(close, lines.length), inner);
      if (close < lines.length) push(close, close + 1, "markdown");
      i = close + 1;
      prose = i;
    }
    for (let j = prose; j < lines.length; j++) roles.set(j, "prose");
    push(prose, lines.length, "markdown");
    return { segments, roles };
  }
  push(0, lines.length, lang.id);
  return { segments, roles };
}

/** Line i belongs to a Markdown cell of a notebook. */
function isMarkdownLine(lines: readonly string[], heads: number[], i: number): boolean {
  let h = -1;
  for (const x of heads) {
    if (x > i) break;
    h = x;
  }
  return h >= 0 && /\[markdown\]/.test(lines[h]);
}

/** A Markdown line of a notebook without the "# " it is stored with. */
export const unComment = (line: string) => line.replace(/^# ?/, "");

/** What the header of a notebook's cell says, in place of its "# %%". */
export const CELL_LABELS: Record<string, string> = {
  "cell-code": "Code cell",
  "cell-markdown": "Markdown cell",
  "cell-raw": "Raw cell",
};

/* ---------- The highlighter's HTML ---------- */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** highlight.js's HTML, one piece per line: a span open at the end of a line (a string or a
 *  comment over several lines) is closed there and opened again on the next one, so that each
 *  line stands alone. The HTML holds only `<span class="…">`, `</span>` and escaped text. */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  const token = /<span class="[^"<>]*">|<\/span>|\n|[^<\n]+|</g;
  for (const m of html.matchAll(token)) {
    const t = m[0];
    if (t === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (t === "</span>") {
      open.pop();
      line += t;
    } else if (t.startsWith("<span")) {
      open.push(t);
      line += t;
    } else line += t === "<" ? "&lt;" : t;
  }
  out.push(line + "</span>".repeat(open.length));
  return out;
}

/* ---------- Links to lines ---------- */

export type Range = { start: number; end: number };

/** "#L10", "#L10-L20" or "#L10-20" (in any order) → the lines, or null. */
export function lineAnchor(hash: string): Range | null {
  const m = hash.replace(/^#/, "").match(/^L(\d{1,7})(?:-L?(\d{1,7}))?$/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b < 1) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** The anchor of lines: "L10", or "L10-L20". */
export const anchorText = (r: Range) => (r.end > r.start ? `L${r.start}-L${r.end}` : `L${r.start}`);

/** The lines of a range that a file of `count` lines has, or null when it has none of them. */
export function clampRange(r: Range, count: number): Range | null {
  if (count < 1 || r.start > count) return null;
  return { start: r.start, end: Math.min(r.end, count) };
}

/* ---------- Sizes ---------- */

/** "812 B", "2.1 KB", "38 KB", "1.2 MB". */
export function sizeInWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)} ${units[u]}`;
}

/** The size in bytes of a text, in UTF-8. */
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/** Past these, the highlighter is not asked: the text is shown plain, and the page says so. */
export const HIGHLIGHT_MAX_BYTES = 400_000;
export const HIGHLIGHT_MAX_LINES = 20_000;
