// The pure logic of the repository's Settings and Branches pages (night phase 01, E8), inside the /r/
// shell: who may act here, each action declared the way the Worker checks it (its own validate and
// its own sentence, worker/forge/service/act-*.ts), the typed-name check of a deletion, what a
// deletion and a transfer change, the research autolinks offered, and GitHub's branch views
// (default, yours, active, stale) with a search by name. Testable in Node: no DOM here.
// The pages (src/scripts/repo-settings.ts, repo-branches.ts) never name the platform: `site` is
// handed in.

import type { ShellRepo, StartInput } from "./forge.ts";
import { TRANSFER_EFFECTS } from "../../worker/forge/service/act-settings.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { GRACE_SECONDS } from "../../worker/forge/service/caps.ts";
import { isProblem, type ActionKind } from "../../worker/forge/service/types.ts";

export const GRACE_DAYS = Math.round(GRACE_SECONDS / 86_400);
/** A branch with no commit for this long is stale, as GitHub's Branches page says (3 months). */
export const STALE_SECONDS = 90 * 86_400;

// ─── who may act here ────────────────────────────────────────────────────────

/** The roles of the layer that open the settings' actions here (GitHub still decides: a person
 *  without admin is refused there, in words). */
const ACTING_ROLES = ["owner", "maintainer", "linked_by"];

export interface Access {
  /** The actions are offered. */
  act: boolean;
  /** Why not, in words; "" when they are. */
  why: string;
}

/** Whether the page offers the actions to this reader: signed in, on a repository the registry
 *  follows, as its owner, a maintainer, or the person who linked it. Anyone else sees the settings
 *  read only, with GitHub's own page. */
export function access(repo: ShellRepo, site: string): Access {
  if (!repo.signedIn) return { act: false, why: `Sign in with GitHub to change its settings here: GitHub decides who may, and ${site} acts as you.` };
  const layer = repo.layer;
  if (!layer || layer.id === null) return { act: false, why: `${capital(site)} does not follow this repository: link it first, then its settings open here.` };
  if (!["active", "archived", "pending_deletion"].includes(layer.state)) return { act: false, why: `${capital(site)} does not follow this repository any more.` };
  if (!layer.roles.some((r) => ACTING_ROLES.includes(r))) {
    return { act: false, why: "Your account is not this repository's owner or maintainer here: its settings on GitHub show what you may change." };
  }
  return { act: true, why: "" };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ─── one action, declared as the Worker checks it ────────────────────────────

/** The action `kind` on this repository with `payload`: the Worker's own validate and sentence (so
 *  the page says exactly what the Worker will do), or the problem in words. `back`: this page. */
export function declare(
  repo: ShellRepo,
  kind: ActionKind,
  payload: Record<string, unknown>,
  back: string,
  extra: { branch?: string | null; expectedHead?: string | null } = {},
): { input: StartInput; sentence: string } | { problem: string } {
  const spec = ACTIONS.get(kind);
  if (!spec) return { problem: "This action is not offered yet." };
  const id = repo.layer?.id ?? repo.id;
  if (!id) return { problem: "The repository's id is not known yet: reload the page." };
  const parsed = spec.validate(payload);
  if (isProblem(parsed)) return { problem: parsed.message };
  return {
    input: { kind, repo: { forge: "github", id }, payload, back, branch: extra.branch ?? null, expectedHead: extra.expectedHead ?? null },
    sentence: `${spec.describe(parsed)}.`.replace(/\.\.$/, "."),
  };
}

// ─── deletion and transfer ───────────────────────────────────────────────────

/** A deletion's name check: exactly "owner/name", letter case included, as GitHub asks it. */
export const typedNameMatches = (typed: string, repo: { owner: string; name: string }): boolean => typed === `${repo.owner}/${repo.name}`;

/** What a deletion changes, in words, with the maps and paths that point to the repository. */
export function deleteConsequences(repo: ShellRepo, site: string): string[] {
  const maps = repo.layer?.maps ?? 0;
  const paths = repo.layer?.paths ?? null;
  const out: string[] = [];
  if (maps > 0) {
    out.push(
      `${maps} tracing ${maps === 1 ? "map points" : "maps point"} to it` +
        (paths ? `, through ${paths} traced ${paths === 1 ? "path" : "paths"}` : "") +
        ": they will say “no longer at the source”, and keep the script copies its licence allowed and the Software Heritage archive when there is one.",
    );
  } else {
    out.push("No tracing map points to it.");
  }
  out.push(
    `First, it is archived on GitHub and hidden from ${site}'s pages for ${GRACE_DAYS} days, during which you can restore it.`,
    "Then deleting it on GitHub stays your own act, with a new authorization: nothing is ever deleted on a timer.",
    "GitHub keeps a deleted repository for 90 days more: its owner can restore it from GitHub's settings.",
    "Its GitHub Pages site, if it has one, goes with it.",
  );
  return out;
}

/** What a transfer changes (GitHub's documentation), and the acceptance a person must give. */
export function transferText(newOwner: string): string[] {
  const out = [...TRANSFER_EFFECTS];
  if (newOwner) out.unshift(`${newOwner} must accept it on GitHub within a day, unless it is an organization you administer.`);
  return out;
}

// ─── research autolinks ──────────────────────────────────────────────────────

export interface SuggestedAutolink {
  keyPrefix: string;
  urlTemplate: string;
  isAlphanumeric: boolean;
  explain: string;
}

/** Identifiers a research repository's issues and commits often cite. GitHub's autolinks match
 *  letters, digits and hyphens after the prefix: the prefixes keep what comes before. */
export const SUGGESTED_AUTOLINKS: readonly SuggestedAutolink[] = [
  {
    keyPrefix: "RRID:SCR_",
    urlTemplate: "https://scicrunch.org/resolver/RRID:SCR_<num>",
    isAlphanumeric: false,
    explain: "Research Resource Identifiers of software tools (RRID:SCR_003070 for ImageJ).",
  },
  {
    keyPrefix: "RRID:AB_",
    urlTemplate: "https://scicrunch.org/resolver/RRID:AB_<num>",
    isAlphanumeric: false,
    explain: "Research Resource Identifiers of antibodies.",
  },
  {
    keyPrefix: "PMID:",
    urlTemplate: "https://pubmed.ncbi.nlm.nih.gov/<num>/",
    isAlphanumeric: false,
    explain: "PubMed identifiers of papers.",
  },
];

// ─── branches ────────────────────────────────────────────────────────────────

export type BranchView = "overview" | "default" | "yours" | "active" | "stale" | "all";
export const BRANCH_VIEWS: readonly BranchView[] = ["overview", "default", "yours", "active", "stale", "all"];

export interface BranchRow {
  name: string;
  sha: string;
  protected: boolean;
  /** When its last commit was made (Unix seconds), when read. */
  date: number | null;
  /** The GitHub login of its last commit's author, when GitHub links one. */
  author: string | null;
}

const newestFirst = (a: BranchRow, b: BranchRow) => (b.date ?? 0) - (a.date ?? 0) || a.name.localeCompare(b.name);

/** The branches of one view, as GitHub's Branches page sorts them, filtered by a search on the
 *  name (letter case aside). "overview" is the default branch, then the others newest first. */
export function branchView(
  rows: readonly BranchRow[],
  view: BranchView,
  o: { defaultBranch: string | null; me: string | null; now: number; query?: string },
): BranchRow[] {
  const q = (o.query ?? "").trim().toLowerCase();
  const found = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : [...rows];
  const isDefault = (r: BranchRow) => r.name === o.defaultBranch;
  const active = (r: BranchRow) => r.date !== null && o.now - r.date < STALE_SECONDS;
  switch (view) {
    case "default":
      return found.filter(isDefault);
    case "yours":
      return o.me ? found.filter((r) => !isDefault(r) && r.author !== null && r.author.toLowerCase() === o.me?.toLowerCase()).sort(newestFirst) : [];
    case "active":
      return found.filter((r) => !isDefault(r) && active(r)).sort(newestFirst);
    case "stale":
      return found.filter((r) => !isDefault(r) && r.date !== null && !active(r)).sort(newestFirst);
    case "all":
      return found.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return [...found.filter(isDefault), ...found.filter((r) => !isDefault(r)).sort(newestFirst)];
  }
}

/** The branches the page offers to delete: never the default branch, nor a protected one. */
export const deletable = (row: BranchRow, defaultBranch: string | null): boolean => row.name !== defaultBranch && !row.protected;

/** "3 days ago", "2 months ago": a branch's last commit, in words. */
export function ago(date: number | null, now: number): string {
  if (date === null) return "not read";
  const s = Math.max(0, now - date);
  const units: [number, string][] = [[365 * 86_400, "year"], [30 * 86_400, "month"], [86_400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [size, word] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${word}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
