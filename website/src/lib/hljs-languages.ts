// The highlighter's languages, each loaded only when a file needs it: every loader is its own
// small file of the site (/_astro/…), fetched by the highlighter's worker
// (src/scripts/highlight-worker.ts). The ids are those of src/lib/code.ts (LANGUAGE_IDS); a test
// checks that each one loads (tests/reader.test.ts). highlight.js is BSD-3-Clause; its output
// is class-based (`hljs-keyword`), styled by science.css.
import type { LanguageFn } from "highlight.js";
import { hoc, nmodl } from "./grammars.ts";

type Loader = () => Promise<{ default: LanguageFn }>;
const own = (fn: LanguageFn): Loader => () => Promise.resolve({ default: fn });

export const LOADERS: Readonly<Record<string, Loader>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  dos: () => import("highlight.js/lib/languages/dos"),
  fortran: () => import("highlight.js/lib/languages/fortran"),
  go: () => import("highlight.js/lib/languages/go"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  hoc: own(hoc),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  julia: () => import("highlight.js/lib/languages/julia"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  latex: () => import("highlight.js/lib/languages/latex"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  mathematica: () => import("highlight.js/lib/languages/mathematica"),
  matlab: () => import("highlight.js/lib/languages/matlab"),
  nmodl: own(nmodl),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  sas: () => import("highlight.js/lib/languages/sas"),
  scala: () => import("highlight.js/lib/languages/scala"),
  sql: () => import("highlight.js/lib/languages/sql"),
  stan: () => import("highlight.js/lib/languages/stan"),
  stata: () => import("highlight.js/lib/languages/stata"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/** The languages a language embeds (a Dockerfile's shell lines, an HTML page's style and
 *  scripts), loaded with it. */
export const EMBEDS: Readonly<Record<string, readonly string[]>> = {
  dockerfile: ["bash"],
  xml: ["css", "javascript"],
  php: ["xml"],
  markdown: ["xml"],
};
