// The community profile and its checklist (night phase 12, E5; docs/STATISTICS.md): the health files
// a research repository should have, and the research-readiness the registry cares about on top of
// GitHub's list. Pure functions, no DOM, no network: the community files are read in the reader's
// browser (src/scripts/repo-insights.ts) from GitHub directly, and turned into this checklist, which
// is tested in Node (tests/forge-pages/community-view.test.ts).
//
// GitHub shows a "community standards" checklist; the registry shows the same health files AND what a
// paper needs: a licence that lets the code be shared, a CITATION.cff (better with a DOI), and a paper
// linked with a tracing map. Colour and the tick come from science.css (.checklist).

import { h } from "./repo-view.ts";
import type { El } from "./repo-view.ts";

/** What the browser found of a repository's community health, to build the checklist from. */
export interface CommunityInput {
  hasReadme: boolean;
  hasDescription: boolean;
  /** The repository's licence, as GitHub states it (SPDX id), and whether it lets the code be shared. */
  licence: { spdx: string; redistributable: boolean } | null;
  /** A CITATION.cff: whether it is there, and whether it carries a DOI. */
  citation: { present: boolean; doi: boolean };
  hasCodeOfConduct: boolean;
  hasContributing: boolean;
  hasSecurity: boolean;
  /** How many papers the registry has linked to the repository (from OSCR's layer), and how many of
   *  those carry a tracing map. */
  papers: number;
  maps: number;
}

export interface ChecklistItem {
  label: string;
  done: boolean;
  /** A short research note (why it matters for a paper's code), always shown. */
  note: string;
}

/** The SPDX ids whose licences let code be redistributed (a short, conservative list; an unknown or
 *  missing licence is treated as not shareable, never guessed). */
const REDISTRIBUTABLE = new Set([
  "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "GPL-2.0-only", "GPL-2.0-or-later",
  "GPL-3.0-only", "GPL-3.0-or-later", "LGPL-2.1-or-later", "LGPL-3.0-or-later", "MPL-2.0",
  "ISC", "Unlicense", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "EUPL-1.2", "Zlib",
]);

/** Whether an SPDX id is in the redistributable set (case-insensitively). */
export function isRedistributable(spdx: string): boolean {
  if (!spdx) return false;
  for (const id of REDISTRIBUTABLE) if (id.toLowerCase() === spdx.toLowerCase()) return true;
  return false;
}

/** The checklist: GitHub's health files, then what a paper's code needs. */
export function communityChecklist(c: CommunityInput): ChecklistItem[] {
  return [
    { label: "Description", done: c.hasDescription, note: "One line that says what the code is, so a reader finds it." },
    { label: "README", done: c.hasReadme, note: "How to install and run it: the first thing a reviewer reads." },
    {
      label: "Licence that allows reuse",
      done: !!c.licence && c.licence.redistributable,
      note: c.licence
        ? (c.licence.redistributable ? `${c.licence.spdx}: the code may be shared and built on.` : `${c.licence.spdx}: a reader cannot be sure the code may be reused; a recognised open licence is clearer.`)
        : "No licence: by default no one may reuse the code, which blocks reproduction.",
    },
    {
      label: "Citation file (CITATION.cff)",
      done: c.citation.present,
      note: c.citation.present
        ? (c.citation.doi ? "Present, with a DOI: the code is citable as published." : "Present; adding a DOI makes it citable as a fixed version.")
        : "Absent: a CITATION.cff tells people how to cite the code.",
    },
    { label: "Code of conduct", done: c.hasCodeOfConduct, note: "How people are expected to behave around the project." },
    { label: "Contributing guide", done: c.hasContributing, note: "How to propose a change, so others can improve the code." },
    { label: "Security policy", done: c.hasSecurity, note: "How to report a vulnerability privately." },
    {
      label: "A paper linked with a tracing map",
      done: c.maps > 0,
      note: c.papers
        ? (c.maps ? `${c.papers} paper${c.papers === 1 ? "" : "s"} linked, ${c.maps} with a tracing map that ties the paper to the code.` : `${c.papers} paper${c.papers === 1 ? "" : "s"} linked; a tracing map would tie each paper's claims to the code.`)
        : "No paper linked yet: link the paper this code belongs to.",
    },
  ];
}

/** How many items are met, as a short score. */
export function checklistScore(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length };
}

/** The checklist as a view tree (ul.checklist, a tick or a dot per item, the note beside it). */
export function communityView(c: CommunityInput): El {
  const items = communityChecklist(c);
  const score = checklistScore(items);
  return h(
    "div",
    { class: "community" },
    h("p", null, `This repository meets ${score.done} of ${score.total} of the registry's community and research checks.`),
    h("ul", { class: "checklist" }, ...items.map((i) =>
      h("li", { class: i.done ? "done" : "todo" }, h("strong", null, i.label), " ", h("span", { class: "muted" }, i.note)))),
  );
}
