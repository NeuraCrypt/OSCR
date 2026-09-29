// The registry's own checks, which run no code (night phase 10, E4; docs/AUTOMATION.md "Checks";
// D00-11): pure functions over a tree's listing and a few files read as text, shared by the Worker
// (a check run on every pull request, service/pr-checks.ts) and the reader's browser (the checks at any
// commit, a paper's cited one included: src/scripts/repo-checks.ts). Nothing of the repository is
// built, installed, imported or run, here or anywhere in the registry: files are read as text, and only
// the few this module names.
//
// The checks, each with its level, its reason in words and how to resolve it:
//   licence      a licence file at the root, and which licence it is (recognised from its text);
//   environment  a file that says how the code runs again (environments.ts: requirements, conda,
//                renv, Julia, a container, a lock file…);
//   doi          the paper the code belongs to: linked in the registry, or at least a DOI named in
//                CITATION.cff or the README;
//   citation     CITATION.cff: present, readable, with a title, authors and a DOI;
//   map          the tracing maps' coherence: a file a map points to still there; on a pull request, a
//                file a map points to deleted or renamed (failure), or changed (notice: the map stays
//                valid at its pinned commit, its author may want a new version);
//   sizes        files over 50 MiB (GitHub warns at 50 MiB, refuses 100 MiB; archives and data
//                belong in a data repository, with a DOI);
//   readme       a README, which says how to install or run the code.
// Conclusion: failure only when the change itself breaks traceability (a map's file deleted or renamed,
// the licence file removed, CITATION.cff broken by the change); neutral when something is missing;
// success otherwise. The pull request's author sees the reason and the way out of each.
//
// No platform name: the caller names the check run.

import { environmentFiles, KIND_WORDS } from "../../src/lib/environments.ts";
import { citationOfCff, doiOf, parseYaml } from "../../src/lib/citation.ts";
import { maskEmails } from "./mask.ts";

/** The check run's name on GitHub: "<SITE_NAME>: research checks", or this without SITE_NAME
 *  (service/pr-checks.ts names it; the pages recognise it). */
export const CHECK_RUN_NAME = "Research code checks";
export const CHECK_RUN_SUFFIX = ": research checks";
export const isRegistryCheckRun = (name: string): boolean => name === CHECK_RUN_NAME || name.endsWith(CHECK_RUN_SUFFIX);

export type Level = "failure" | "warning" | "notice" | "ok";
export type CheckId = "licence" | "environment" | "doi" | "citation" | "map" | "sizes" | "readme";
export const CHECK_IDS: readonly CheckId[] = ["licence", "environment", "doi", "citation", "map", "sizes", "readme"];

export const CHECK_WORDS: Readonly<Record<CheckId, string>> = {
  licence: "Licence",
  environment: "Environment",
  doi: "The paper's DOI",
  citation: "CITATION.cff",
  map: "Tracing maps",
  sizes: "File sizes",
  readme: "README",
};

export interface Annotation {
  path: string;
  line: number;
  level: "notice" | "warning" | "failure";
  title: string;
  message: string;
}

export interface Finding {
  id: CheckId;
  level: Level;
  /** What was found, in words. */
  words: string;
  /** How to resolve it (empty when there is nothing to do). */
  fix: string;
  annotations: Annotation[];
}

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
}

export interface CheckInput {
  /** The tree at the commit: paths and blob sizes. */
  entries: { path: string; type: string; size: number | null }[];
  /** The forge cut the listing. */
  truncated: boolean;
  /** The texts read (checkFiles names them); null when the file could not be read. */
  texts: Record<string, string | null>;
  /** The DOIs the registry links the repository to ("10.…"). */
  papers: string[];
  /** The files tracing maps point to. */
  traced: { path: string; paper: string; commit: string }[];
  /** A pull request's changed files, when checking one. */
  change?: { files: ChangedFile[]; truncated: boolean } | null;
}

export interface Report {
  conclusion: "success" | "neutral" | "failure";
  title: string;
  /** Markdown, for the check run's summary (and plain enough for a page). */
  summary: string;
  findings: Finding[];
  annotations: Annotation[];
}

/** Over this, a file is said too large for a repository (GitHub warns at 50 MiB). */
export const LARGE_FILE_BYTES = 50 * 2 ** 20;
/** The most a text read for the checks weighs. */
export const CHECK_TEXT_BYTES = 256 * 1024;

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)(\.(md|txt|rst))?$/i;
const README_FILE = /^readme(\.(md|markdown|rst|txt|org|adoc))?$/i;

const root = (paths: readonly string[], re: RegExp): string | null => paths.find((p) => !p.includes("/") && re.test(p)) ?? null;

/** The files the checks read at a commit, from its listing: the licence, CITATION.cff, the README. */
export function checkFiles(paths: readonly string[]): { licence: string | null; citation: string | null; readme: string | null } {
  return { licence: root(paths, LICENCE_FILE), citation: paths.includes("CITATION.cff") ? "CITATION.cff" : null, readme: root(paths, README_FILE) };
}

/** A licence recognised from its text (its SPDX id), or null. The first 4 KiB decide. */
export function licenceOf(text: string): string | null {
  const t = text.slice(0, 4096).replace(/\s+/g, " ").toLowerCase();
  const has = (...words: string[]) => words.every((w) => t.includes(w));
  if (has("apache license", "version 2.0")) return "Apache-2.0";
  if (has("mozilla public license", "2.0")) return "MPL-2.0";
  if (has("gnu affero general public license", "version 3")) return "AGPL-3.0";
  if (has("gnu lesser general public license", "version 3")) return "LGPL-3.0";
  if (has("gnu lesser general public license", "version 2.1")) return "LGPL-2.1";
  if (has("gnu general public license", "version 3")) return "GPL-3.0";
  if (has("gnu general public license", "version 2")) return "GPL-2.0";
  if (has("european union public licence")) return "EUPL-1.2";
  if (has("permission is hereby granted, free of charge")) return "MIT";
  if (has("redistribution and use in source and binary forms")) return has("neither the name") || has("names of its contributors") ? "BSD-3-Clause" : "BSD-2-Clause";
  if (has("permission to use, copy, modify, and/or distribute this software")) return "ISC";
  if (has("this is free and unencumbered software released into the public domain")) return "Unlicense";
  if (has("cc0 1.0 universal")) return "CC0-1.0";
  if (has("attribution-sharealike 4.0 international")) return "CC-BY-SA-4.0";
  if (has("attribution 4.0 international")) return "CC-BY-4.0";
  if (has("boost software license")) return "BSL-1.0";
  if (has("artistic license 2.0")) return "Artistic-2.0";
  if (has("cecill")) return "CECILL-2.1";
  return null;
}

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"<>)\]]+/;

function licenceCheck(x: CheckInput, paths: string[], files: ReturnType<typeof checkFiles>): Finding {
  const removed = x.change?.files.find((f) => f.status === "removed" && LICENCE_FILE.test(f.path) && !f.path.includes("/"));
  if (removed) {
    return { id: "licence", level: "failure", words: `This change deletes the licence file ${removed.path}: without it, nobody may reuse the code.`, fix: "Keep the licence file, or replace it with another open licence in the same change.", annotations: [] };
  }
  if (!files.licence) {
    return { id: "licence", level: "warning", words: "No licence file: others may read the code but not reuse it, and the registry keeps no copy of its scripts.", fix: "Add a LICENSE file with an open licence (MIT, Apache-2.0, BSD-3-Clause, GPL-3.0…).", annotations: [] };
  }
  const text = x.texts[files.licence];
  const spdx = text ? licenceOf(text) : null;
  if (!spdx) {
    return {
      id: "licence",
      level: "warning",
      words: `The licence file ${files.licence} names no licence the registry recognises.`,
      fix: "Use a standard licence's text as it is, so that people and tools recognise it.",
      annotations: text ? [{ path: files.licence, line: 1, level: "warning", title: "Licence not recognised", message: "This text is not a standard licence the registry recognises." }] : [],
    };
  }
  return { id: "licence", level: "ok", words: `${spdx}, in ${files.licence}.`, fix: "", annotations: [] };
}

function environmentCheck(paths: string[]): Finding {
  const env = environmentFiles(paths);
  const main = env.filter((f) => f.kind !== "script");
  if (!main.length) {
    return {
      id: "environment",
      level: "warning",
      words: env.length ? `Only scripts say how the code runs (${env.map((f) => f.path).join(", ")}): no file lists its dependencies.` : "No file says how the code runs again: its dependencies and their versions are unknown.",
      fix: "Add an environment file: requirements.txt, environment.yml, renv.lock, Project.toml, a Dockerfile… with versions pinned.",
      annotations: [],
    };
  }
  const words = main.slice(0, 4).map((f) => `${f.path} (${KIND_WORDS[f.kind]})`).join(", ");
  return { id: "environment", level: "ok", words: `${words}${main.length > 4 ? `, and ${main.length - 4} more` : ""}.`, fix: "", annotations: [] };
}

function doiCheck(x: CheckInput, files: ReturnType<typeof checkFiles>): Finding {
  if (x.papers.length) {
    return { id: "doi", level: "ok", words: `Linked in the registry to ${x.papers.length === 1 ? "its paper" : `${x.papers.length} papers`}: ${x.papers.slice(0, 3).join(", ")}.`, fix: "", annotations: [] };
  }
  const named = [files.citation, files.readme].map((p) => (p ? x.texts[p] : null)).map((t) => (t ? DOI_IN_TEXT.exec(t)?.[0] ?? null : null)).find(Boolean);
  if (named) {
    return { id: "doi", level: "notice", words: `A DOI is named (${named.replace(/[.,;]+$/, "")}), but the repository is not linked to its paper in the registry.`, fix: "Link the repository to its paper (the repository's page, Papers), so that the paper's readers find its code.", annotations: [] };
  }
  return { id: "doi", level: "warning", words: "No paper is linked, and no DOI is named: readers cannot tell which paper this code belongs to.", fix: "Link the repository to its paper in the registry, or name the paper's DOI in CITATION.cff or the README.", annotations: [] };
}

function citationCheck(x: CheckInput, files: ReturnType<typeof checkFiles>): Finding {
  const changed = x.change?.files.find((f) => f.path === "CITATION.cff" && (f.status === "modified" || f.status === "added" || f.status === "changed"));
  if (!files.citation) {
    const removed = x.change?.files.find((f) => f.path === "CITATION.cff" && f.status === "removed");
    if (removed) return { id: "citation", level: "failure", words: "This change deletes CITATION.cff: the repository no longer says how to cite it.", fix: "Keep CITATION.cff.", annotations: [] };
    return { id: "citation", level: "warning", words: "No CITATION.cff: GitHub, Zenodo and reference managers cannot say how to cite this code.", fix: "Add a CITATION.cff with its title, authors (with their ORCID iDs) and the paper's DOI (the registry's editor writes one from the paper).", annotations: [] };
  }
  const text = x.texts[files.citation];
  if (text === null || text === undefined) return { id: "citation", level: "notice", words: "CITATION.cff could not be read.", fix: "", annotations: [] };
  let version = "";
  try {
    const top = parseYaml(text);
    version = top && typeof top === "object" && !Array.isArray(top) && typeof top["cff-version"] === "string" ? String(top["cff-version"]) : "";
  } catch {
    version = "";
  }
  const cff = citationOfCff(text);
  const broken = !cff || !version;
  if (broken) {
    const words = !version ? "CITATION.cff has no cff-version, or is not readable as YAML." : "CITATION.cff has no title or no author.";
    return {
      id: "citation",
      level: changed ? "failure" : "warning",
      words: changed ? `This change leaves CITATION.cff unusable: ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words,
      fix: "Write cff-version, message, title and authors (the Citation File Format 1.2.0).",
      annotations: [{ path: "CITATION.cff", line: 1, level: changed ? "failure" : "warning", title: "CITATION.cff", message: words }],
    };
  }
  const doi = cff.work.doi ?? cff.software.doi ?? doiOf(text);
  if (!doi) {
    return { id: "citation", level: "notice", words: `CITATION.cff cites “${maskEmails(cff.work.title).slice(0, 120)}”, without a DOI.`, fix: "Add the paper's DOI (doi:, or a preferred-citation with its DOI).", annotations: [{ path: "CITATION.cff", line: 1, level: "notice", title: "No DOI", message: "The citation names no DOI." }] };
  }
  return { id: "citation", level: "ok", words: `CITATION.cff cites “${maskEmails(cff.work.title).slice(0, 120)}” (${doi}).`, fix: "", annotations: [] };
}

function mapCheck(x: CheckInput, paths: Set<string>): Finding {
  if (!x.traced.length) return { id: "map", level: "ok", words: "No tracing map points to this repository yet.", fix: "", annotations: [] };
  const byPath = new Map<string, { paper: string; commit: string }[]>();
  for (const t of x.traced) byPath.set(t.path, [...(byPath.get(t.path) ?? []), { paper: t.paper, commit: t.commit }]);
  const annotations: Annotation[] = [];
  const failures: string[] = [];
  const notices: string[] = [];
  const gone: string[] = [];
  const papersOf = (p: string) => [...new Set((byPath.get(p) ?? []).map((m) => m.paper))].join(", ");
  if (x.change) {
    for (const f of x.change.files) {
      const from = f.status === "renamed" ? (f.previousPath ?? f.path) : f.path;
      if (!byPath.has(from)) continue;
      if (f.status === "removed" || f.status === "renamed") {
        failures.push(`${from} (${papersOf(from)}) is ${f.status === "removed" ? "deleted" : `renamed to ${f.path}`}`);
      } else if (f.status === "modified" || f.status === "changed") {
        notices.push(from);
        annotations.push({ path: f.path, line: 1, level: "notice", title: "Traced by a paper", message: `A tracing map of ${papersOf(from)} points to this file, pinned to commit ${(byPath.get(from) ?? [])[0]?.commit.slice(0, 7)}: the map stays valid there; after this change, its author may want a new version.` });
      }
    }
  } else if (!x.truncated) {
    for (const p of byPath.keys()) if (!paths.has(p)) gone.push(p);
  }
  if (failures.length) {
    return { id: "map", level: "failure", words: `A tracing map points to ${failures.length === 1 ? "a file" : "files"} this change takes away: ${failures.join("; ")}.`, fix: "Keep the file where the map points, or ask the map's author to trace the new place first (the map stays valid at its pinned commit).", annotations };
  }
  if (gone.length) {
    return { id: "map", level: "warning", words: `Tracing maps point to ${gone.length === 1 ? "a file" : `${gone.length} files`} this commit no longer has: ${gone.slice(0, 5).join(", ")}. The maps stay valid at their pinned commits.`, fix: "Nothing is broken for the paper; its authors may trace the code's new place in a new version of the map.", annotations: [] };
  }
  if (notices.length) {
    return { id: "map", level: "notice", words: `This change touches ${notices.length === 1 ? "a file" : `${notices.length} files`} a tracing map points to: ${notices.slice(0, 5).join(", ")}.`, fix: "The maps stay valid at their pinned commits; the paper's authors may want to review this change.", annotations };
  }
  return { id: "map", level: "ok", words: `Every file the tracing maps point to is still here (${byPath.size}).`, fix: "", annotations: [] };
}

function sizesCheck(x: CheckInput): Finding {
  const big = x.entries.filter((e) => e.type === "blob" && (e.size ?? 0) > LARGE_FILE_BYTES);
  if (!big.length) return { id: "sizes", level: "ok", words: "No file over 50 MiB.", fix: "", annotations: [] };
  const mib = (n: number) => `${Math.round(n / 2 ** 20)} MiB`;
  return {
    id: "sizes",
    level: "warning",
    words: `${big.length === 1 ? "A file weighs" : `${big.length} files weigh`} over 50 MiB: ${big.slice(0, 5).map((e) => `${e.path} (${mib(e.size ?? 0)})`).join(", ")}.`,
    fix: "Put data and archives in a data repository with a DOI (Zenodo, OSF, a field's own), and link it from the README.",
    annotations: [],
  };
}

function readmeCheck(x: CheckInput, files: ReturnType<typeof checkFiles>): Finding {
  if (!files.readme) return { id: "readme", level: "warning", words: "No README: nothing says what the code does, nor how to run it.", fix: "Add a README: what the code does, the paper it belongs to, how to install and run it.", annotations: [] };
  const text = x.texts[files.readme];
  if (!text) return { id: "readme", level: "ok", words: `README: ${files.readme}.`, fix: "", annotations: [] };
  if (!/\b(install|installation|usage|getting started|requirements|how to run|quick ?start|reproduc)/i.test(text)) {
    return { id: "readme", level: "notice", words: `The README (${files.readme}) does not say how to install or run the code.`, fix: "Add a section on installing and running it, to reproduce the paper's results.", annotations: [{ path: files.readme, line: 1, level: "notice", title: "How to run it", message: "No section on installing or running the code." }] };
  }
  return { id: "readme", level: "ok", words: `README: ${files.readme}, with how to run the code.`, fix: "", annotations: [] };
}

const LEVEL_WORDS: Readonly<Record<Level, string>> = { failure: "Failed", warning: "To look at", notice: "Note", ok: "Passed" };

/** The checks at a commit (and, with `change`, of a pull request's change). */
export function runChecks(x: CheckInput): Report {
  const paths = x.entries.filter((e) => e.type === "blob").map((e) => e.path);
  const files = checkFiles(paths);
  const findings = [
    licenceCheck(x, paths, files),
    environmentCheck(paths),
    doiCheck(x, files),
    citationCheck(x, files),
    mapCheck(x, new Set(paths)),
    sizesCheck(x),
    readmeCheck(x, files),
  ];
  const count = (l: Level) => findings.filter((f) => f.level === l).length;
  const failed = count("failure");
  const warned = count("warning");
  const conclusion = failed ? "failure" : warned ? "neutral" : "success";
  const passed = count("ok") + count("notice");
  const title = failed
    ? `${failed} ${failed === 1 ? "check fails" : "checks fail"}: ${findings.filter((f) => f.level === "failure").map((f) => CHECK_WORDS[f.id].toLowerCase()).join(", ")}`
    : warned
      ? `${passed} passed, ${warned} to look at`
      : `All ${findings.length} checks passed`;
  const lines = findings.map((f) => `- **${CHECK_WORDS[f.id]}** — ${LEVEL_WORDS[f.level]}. ${f.words}${f.fix ? ` ${f.fix}` : ""}`);
  const notes: string[] = [];
  if (x.truncated) notes.push("The forge cut the tree's listing: files beyond it were not looked at.");
  if (x.change?.truncated) notes.push("The change has more files than the registry reads: the tracing maps were checked against the first ones.");
  const summary = [
    "These checks read the repository's files as text; they never run its code.",
    "",
    ...lines,
    ...(notes.length ? ["", ...notes] : []),
  ].join("\n");
  const annotations = findings.flatMap((f) => f.annotations).map((a) => ({ ...a, message: maskEmails(a.message) }));
  return { conclusion, title, summary: maskEmails(summary), findings, annotations };
}

/** A commit message's `skip-checks: true` trailer (GitHub's own), which asks for no check. */
export function skipsChecks(message: string): boolean {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  return paragraphs.length > 1 && /^skip-checks:\s*true\s*$/im.test(last);
}
