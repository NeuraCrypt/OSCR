// The papers a repository is attached to (night phase 01; docs/FORGE.md "Action kinds"): the DOIs an
// action's payload names, checked, and the status each one takes in `repo_papers`. Shared by the
// actions that attach papers: create and generate (act-create.ts, E2), link and papers
// (act-link.ts, E3).
//
// A paper is a DOI ("10.…"), stored as "doi:10.…" in lower case, as oscr_community's paper ids. Its
// status is `linked` when the person is a verified author of the paper, or a maintainer of the
// repository (oscr_community `roles`, granted by the ORCID sign-in's facts or by the owner), and
// `proposed` otherwise: the paper's authors then decide, and the Mac adds nothing to the paper's
// record (oscr/forgejobs.py `run_link` checks the same roles again).

import type { ForgeName } from "../types.ts";
import { all } from "./store.ts";
import { ForgeProblem, type D1Database, type PaperStatus } from "./types.ts";

/** The most papers one action attaches (the action's rows stay within the day's budget). */
export const PAPERS_MAX = 20;

/** The host of the repository keys oscr_community uses (roles' scope_id, repo_owner.repo). The
 *  test double ("memory") stands for GitHub in the tests' world. */
export const COMMUNITY_HOST: Readonly<Record<ForgeName, string>> = { github: "github.com", memory: "github.com" };

/** "github.com/<owner>/<name>" in lower case: a repository as oscr_community names it. */
export const communityRepoKey = (forge: ForgeName, owner: string, name: string): string =>
  `${COMMUNITY_HOST[forge]}/${owner}/${name}`.toLowerCase();

const DOI = /^10\.\d{4,9}\/[^\s"<>]+$/;

/** A DOI as a person gives it ("10.…", "doi:10.…", "https://doi.org/10.…"), as a paper id
 *  ("doi:10.…", lower case), or null. */
export function paperId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const doi = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  if (doi.length > 200 || !DOI.test(doi) || /[\u0000-\u001f\u007f@]/.test(doi)) return null;
  return `doi:${doi}`;
}

/** The papers of a payload: a list of DOIs (absent: none), each checked, duplicates dropped. */
export function readPapers(value: unknown, what = "papers"): string[] | ForgeProblem {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return new ForgeProblem(400, "bad_payload", `The ${what} are not a list of DOIs.`);
  if (value.length > PAPERS_MAX) return new ForgeProblem(400, "bad_payload", `At most ${PAPERS_MAX} papers in one action.`);
  const out: string[] = [];
  for (const v of value) {
    const id = paperId(v);
    if (!id) return new ForgeProblem(400, "bad_payload", `“${String(v).slice(0, 80)}” is not a DOI (10.…).`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The status each paper takes for this person, in ONE read of oscr_community by the roles' key
 *  (the person's verified_author roles among these papers, and their maintainer role on the
 *  repository). */
export async function paperStatuses(
  community: D1Database,
  userId: string,
  papers: readonly string[],
  repoKey: string,
): Promise<{ paperId: string; status: PaperStatus }[]> {
  if (!papers.length) return [];
  const rows = await all<{ role: string; scope_id: string }>(
    community
      .prepare(
        "SELECT role, scope_id FROM roles WHERE user_id = ? AND (" +
          `(role = 'verified_author' AND scope_kind = 'paper' AND scope_id IN (${papers.map(() => "?").join(", ")})) OR ` +
          "(role = 'maintainer' AND scope_kind = 'repo' AND scope_id = ?))",
      )
      .bind(userId, ...papers, repoKey.toLowerCase()),
  );
  const maintainer = rows.some((r) => r.role === "maintainer");
  const authored = new Set(rows.filter((r) => r.role === "verified_author").map((r) => r.scope_id.toLowerCase()));
  return papers.map((p) => ({ paperId: p, status: maintainer || authored.has(p) ? "linked" : "proposed" }));
}
