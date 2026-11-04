// Scientific tools (2026-11-03): a section of its own for research software shown from its
// repository, added BY HAND (`npm run scitool:add -- https://github.com/<owner>/<name>`), never
// harvested. It is independent of the papers by construction:
//
//   - its data is one committed manifest per tool, src/scitools/<slug>.json, written by
//     scripts/scitool-add.mjs; scripts/data.mjs, the harvester's export, the Mac's nightly, D1 and
//     Hugging Face never read or write it, and nothing of the papers' pipeline reads it;
//   - a manifest pins one commit and lists the repository's text files (path, size, SHA-256, lines,
//     language); the TEXT is never copied into the registry: the reader's browser fetches a file
//     from raw.githubusercontent.com at the pinned commit, checks its SHA-256 and masks its email
//     addresses (src/lib/source.ts `fetchVerified`, the same check as the papers' fallback);
//   - a fixed number of pages: one list, and one page per tool up to SCITOOLS_MAX (a hand-made
//     list, held by tests/scitools.test.ts), so the site's file budget (src/lib/shards.ts) moves by
//     at most SCITOOLS_MAX + 1 files.
//
// Pure: the pages (src/pages/scientific-tools/), the browser (src/scripts/scitool.ts), the add
// script and the tests share it. Nothing here names the platform.

/** The most tools the section holds (each is one static page). */
export const SCITOOLS_MAX = 100;
/** The most files a manifest lists, and the largest file it lists (as the papers' fallback). */
export const SCITOOL_FILES_MAX = 5_000;
export const SCITOOL_FILE_MAX_BYTES = 1_000_000;
/** The address of the section. Not /tools/: that is the papers' entities (the libraries found in
 *  the authors' code), and it stays theirs. */
export const SCITOOLS_PATH = "/scientific-tools/";
/** The one origin the tools' pages connect to besides the site (public/_headers). */
export const SCITOOL_ORIGIN = "https://raw.githubusercontent.com";

export interface SciToolFile {
  path: string;
  size: number;
  sha256: string;
  lines: number;
  language: string;
}

export interface SciTool {
  slug: string;
  name: string;
  description: string;
  repository: { host: "github"; owner: string; name: string; url: string };
  commit: string;
  committed_at: string;
  added: string;
  licence: { spdx: string; file: string };
  homepage: string;
  readme: string;
  files: SciToolFile[];
  skipped: { binary: number; large: number; over_limit: number };
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GH_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EMAIL = /[\w.+-]+\s*[@＠]\s*[\w-]+(?:\.[\w-]+)+/;

/** A GitHub repository's link, as a person pastes it: its owner and name, or null. */
export function parseGithubUrl(url: string): { owner: string; name: string } | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/.exec(url.trim());
  if (!m || !GH_NAME.test(m[1]) || !GH_NAME.test(m[2])) return null;
  return { owner: m[1], name: m[2] };
}

/** A slug from a repository's name: lower case, [a-z0-9-]. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "tool";
}

/** A path as an address: each part percent-encoded, the slashes kept. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Where the reader's browser fetches a file: GitHub's raw file at the pinned commit. */
export function rawUrl(tool: Pick<SciTool, "repository" | "commit">, path: string): string {
  const r = tool.repository;
  return `${SCITOOL_ORIGIN}/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}/${tool.commit}/${encodePath(path)}`;
}

/** The file on GitHub, at the pinned commit (the "source" link). */
export function blobUrl(tool: Pick<SciTool, "repository" | "commit">, path: string): string {
  return `${tool.repository.url}/blob/${tool.commit}/${encodePath(path)}`;
}

export const toolUrl = (slug: string) => `${SCITOOLS_PATH}${slug}/`;

const EXT: Record<string, string> = {
  py: "Python", pyi: "Python", ipynb: "Jupyter Notebook", pyx: "Cython", r: "R", rmd: "R Markdown",
  jl: "Julia", m: "MATLAB", mat: "MATLAB", c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++",
  cu: "CUDA", f: "Fortran", f90: "Fortran", f95: "Fortran", rs: "Rust", go: "Go", java: "Java",
  kt: "Kotlin", scala: "Scala", js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript",
  tsx: "TypeScript", jsx: "JavaScript", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  sql: "SQL", html: "HTML", css: "CSS", md: "Markdown", rst: "reStructuredText", tex: "TeX",
  json: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML", ini: "INI", cfg: "INI", xml: "XML",
  csv: "CSV", tsv: "TSV", txt: "Text", lock: "Text", cff: "YAML", nf: "Nextflow", smk: "Snakemake",
  stan: "Stan", do: "Stata", sas: "SAS", pl: "Perl", rb: "Ruby", lua: "Lua", swift: "Swift",
};
const NAMES: Record<string, string> = {
  makefile: "Makefile", dockerfile: "Dockerfile", snakefile: "Snakemake", license: "Text", notice: "Text",
  "cmakelists.txt": "CMake",
};

/** What the search and the lists need of a tool (the page carries it as a data attribute, so the
 *  search finds the tools with no request: they are never in D1). */
export interface SciToolCard {
  slug: string;
  name: string;
  description: string;
  repo: string;
  url: string;
  languages: string[];
}

export function toolCard(t: SciTool): SciToolCard {
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    repo: `${t.repository.owner}/${t.repository.name}`,
    url: t.repository.url,
    languages: languagesOf(t.files).slice(0, 3).map((l) => l.language),
  };
}

/** The tools a search's words find: every word (quotes and the operators user:, org:, repo:,
 *  type:, is:, in:, doi: dropped; a -word excludes) in the tool's name, description, repository,
 *  languages or "scientific tool". An empty query finds none. */
export function matchTools(cards: SciToolCard[], q: string): SciToolCard[] {
  const words = q.toLowerCase().replace(/["“”]/g, " ").split(/\s+/).filter((w) => w && !/^-?(?:user|org|repo|type|is|in|doi):/.test(w));
  const want = words.filter((w) => !w.startsWith("-"));
  const not = words.filter((w) => w.startsWith("-") && w.length > 1).map((w) => w.slice(1));
  if (!want.length) return [];
  return cards.filter((c) => {
    const text = [c.slug, c.name, c.description, c.repo, ...c.languages, "scientific tool"].join(" ").toLowerCase();
    return want.every((w) => text.includes(w)) && !not.some((w) => text.includes(w));
  });
}

/** A file's language, from its name (as the add script records it). */
export function languageOf(path: string): string {
  const base = path.split("/").pop()!.toLowerCase();
  if (NAMES[base]) return NAMES[base];
  const dot = base.lastIndexOf(".");
  return dot > 0 ? EXT[base.slice(dot + 1)] ?? "Text" : "Text";
}

/** The first README at the repository's root, the one the page opens on. */
export function readmeOf(paths: string[]): string {
  const root = paths.filter((p) => !p.includes("/") && /^readme(\.[a-z0-9]+)?$/i.test(p));
  const rank = (p: string) => [".md", ".rst", ".txt", ""].indexOf((/\.[a-z0-9]+$/i.exec(p)?.[0] ?? "").toLowerCase());
  return root.sort((a, b) => (rank(a) < 0 ? 9 : rank(a)) - (rank(b) < 0 ? 9 : rank(b)))[0] ?? "";
}

/** The licence a licence file's text names, as an SPDX identifier, or "" when it is not recognised
 *  (then the page says "see the licence file": never guessed further). */
export function licenceOf(text: string): string {
  const t = text.replace(/\s+/g, " ");
  if (/Apache License,? Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return /Version 3/i.test(t) ? "LGPL-3.0" : "LGPL-2.1";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return /Version 3/i.test(t) ? "GPL-3.0" : "GPL-2.0";
  if (/Mozilla Public License,? (Version|v\.?) ?2\.0/i.test(t)) return "MPL-2.0";
  if (/Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name/i.test(t) || /3\. /.test(t) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/CC0 1\.0 Universal/i.test(t)) return "CC0-1.0";
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return "Unlicense";
  return "";
}

/** The licence file at the repository's root, or "". */
export function licenceFileOf(paths: string[]): string {
  return paths.find((p) => !p.includes("/") && /^(licen[cs]e|copying)(\.[a-z0-9]+)?$/i.test(p)) ?? "";
}

export interface TreeDir {
  name: string;
  path: string;
  dirs: TreeDir[];
  files: SciToolFile[];
}

/** The files as folders: each folder's sub-folders first, then its files, each by name. */
export function treeOf(files: SciToolFile[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  const byPath = new Map<string, TreeDir>([["", root]]);
  for (const f of files) {
    const parts = f.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = byPath.get(path);
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [] };
        byPath.set(path, next);
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push(f);
  }
  const sort = (d: TreeDir) => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name, "en"));
    d.files.sort((a, b) => a.path.localeCompare(b.path, "en"));
    d.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

/** The languages of a tool's code, the most lines first (the text formats left out). */
export function languagesOf(files: SciToolFile[]): { language: string; lines: number }[] {
  const PROSE = new Set(["Text", "Markdown", "reStructuredText", "JSON", "YAML", "TOML", "INI", "CSV", "TSV", "XML", "HTML", "CSS", "TeX"]);
  const sum = new Map<string, number>();
  for (const f of files) if (!PROSE.has(f.language)) sum.set(f.language, (sum.get(f.language) ?? 0) + f.lines);
  return [...sum].map(([language, lines]) => ({ language, lines })).sort((a, b) => b.lines - a.lines || a.language.localeCompare(b.language));
}

/** What is wrong with a manifest (empty when it is whole): the tests and the add script run it,
 *  so a malformed manifest never reaches a build. */
export function problemsOf(t: SciTool, file = ""): string[] {
  const p: string[] = [];
  const at = file ? `${file}: ` : "";
  if (!SLUG.test(t.slug ?? "")) p.push(`${at}slug ${JSON.stringify(t.slug)} is not [a-z0-9-]`);
  if (file && file !== `${t.slug}.json`) p.push(`${at}the file is not named after its slug`);
  if (!t.name || typeof t.name !== "string" || t.name.length > 120) p.push(`${at}name missing or too long`);
  if (typeof t.description !== "string" || t.description.length > 600) p.push(`${at}description missing or over 600 characters`);
  for (const [k, v] of [["name", t.name], ["description", t.description]] as const) {
    if (typeof v === "string" && EMAIL.test(v)) p.push(`${at}${k} holds an email address`);
    if (typeof v === "string" && v.includes(String.fromCharCode(0x2014))) p.push(`${at}${k} holds an em dash`);
  }
  const r = t.repository;
  if (!r || r.host !== "github" || !GH_NAME.test(r.owner ?? "") || !GH_NAME.test(r.name ?? "") ||
      r.url !== `https://github.com/${r.owner}/${r.name}`) p.push(`${at}repository is not a GitHub repository`);
  if (!HEX40.test(t.commit ?? "")) p.push(`${at}commit is not a full SHA-1`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.added ?? "")) p.push(`${at}added is not a date`);
  if (typeof t.committed_at !== "string") p.push(`${at}committed_at missing`);
  if (!t.licence || typeof t.licence.spdx !== "string" || typeof t.licence.file !== "string") p.push(`${at}licence missing`);
  if (typeof t.homepage !== "string" || (t.homepage && !/^https:\/\/[^\s"<>]+$/.test(t.homepage))) p.push(`${at}homepage is not an https link`);
  if (!Array.isArray(t.files) || t.files.length === 0) p.push(`${at}no file`);
  else {
    if (t.files.length > SCITOOL_FILES_MAX) p.push(`${at}more than ${SCITOOL_FILES_MAX} files`);
    const seen = new Set<string>();
    for (const f of t.files) {
      if (typeof f.path !== "string" || !f.path || f.path.startsWith("/") || f.path.split("/").some((s) => s === "" || s === "." || s === "..")) {
        p.push(`${at}bad path ${JSON.stringify(f.path)}`);
        continue;
      }
      if (seen.has(f.path)) p.push(`${at}${f.path} listed twice`);
      seen.add(f.path);
      if (!HEX64.test(f.sha256 ?? "")) p.push(`${at}${f.path}: sha256 is not a SHA-256`);
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > SCITOOL_FILE_MAX_BYTES) p.push(`${at}${f.path}: bad size`);
      if (!Number.isInteger(f.lines) || f.lines < 0) p.push(`${at}${f.path}: bad line count`);
      if (typeof f.language !== "string" || !f.language) p.push(`${at}${f.path}: no language`);
    }
    if (t.readme && !seen.has(t.readme)) p.push(`${at}readme ${t.readme} is not among the files`);
    if (t.licence?.file && !seen.has(t.licence.file)) p.push(`${at}licence file ${t.licence.file} is not among the files`);
  }
  const s = t.skipped;
  if (!s || ![s.binary, s.large, s.over_limit].every((x) => Number.isInteger(x) && x >= 0)) p.push(`${at}skipped counts missing`);
  return p;
}

/** The tools, the most recently added first, then by name. */
export function ordered(tools: SciTool[]): SciTool[] {
  return [...tools].sort((a, b) => b.added.localeCompare(a.added) || a.name.localeCompare(b.name, "en"));
}
