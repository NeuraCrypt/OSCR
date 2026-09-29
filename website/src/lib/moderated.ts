// What moderation hid, as of last night, for the build (night phase 16): src/data/moderation.json,
// written by scripts/data.mjs from the export's forge/moderation.json (oscr/moderation.py). The public
// notices (the /notices/ page) and the hidden repositories with their papers (a line on each paper's
// page, so that its tracing map stays explained). Build-time only: nothing here runs in a browser.
import { existsSync, readFileSync } from "node:fs";

export interface Notice {
  date: string;
  updated: string;
  what: string;
  reason: string;
  notice: string;
  state: "hidden" | "restored";
  by: string;
  counter_notice: boolean;
  appeal: "" | "open" | "accepted" | "rejected";
}

export interface HiddenRepo {
  path: string;
  words: string;
  since: number;
}

interface Moderation {
  notices: Notice[];
  repos: Record<string, { words: string; since: number; papers: string[] }>;
}

/** Relative to website/, where the build runs (as lib/catalog.ts reads src/data/). */
const FILE = "src/data/moderation.json";

function load(): Moderation {
  try {
    if (!existsSync(FILE)) return { notices: [], repos: {} };
    const m = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Moderation>;
    return { notices: Array.isArray(m.notices) ? m.notices : [], repos: m.repos && typeof m.repos === "object" ? m.repos : {} };
  } catch {
    return { notices: [], repos: {} };
  }
}

const data = load();

/** The public notices, the newest first. */
export const NOTICES: readonly Notice[] = data.notices;

const byPaper = new Map<string, HiddenRepo[]>();
for (const [path, r] of Object.entries(data.repos)) {
  for (const doi of r.papers) {
    const key = doi.toLowerCase();
    byPaper.set(key, [...(byPaper.get(key) ?? []), { path, words: r.words, since: r.since }]);
  }
}

/** The repositories linked to a paper (by its DOI) that moderation hid. */
export const hiddenReposOf = (doi: string): readonly HiddenRepo[] => byPaper.get(doi.toLowerCase()) ?? [];
