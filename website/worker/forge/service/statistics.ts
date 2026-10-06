// The repository-statistics read (night phase 12, E3; docs/STATISTICS.md):
//
// GET /api/forge/stats?id=<forge>:<repo_id> or ?path=<owner>/<name>
//   OSCR's own statistics for one repository: "Used by" (how many papers and repositories depend on
//   it, with a bounded sample), the research marks the insights charts overlay, and the history of the
//   registry's own stars. GitHub's statistics (Pulse, contributors, commits, code frequency) are NOT
//   here: the reader's browser reads them from GitHub directly (0 Worker and 0 Mac requests, D12-1).
//
// It reads only, by the key's prefix (forge, repo_id): one repo_stats row, and the repo_dependents and
// repo_marks key ranges, never a scan (tests/forge-service/statistics.test.ts checks the plan). The
// facts are the Mac's (oscr usedby); the Worker never computes them. Signed in, like the security read
// (budget §15.6): these are public facts (no personal data), but the read is kept to signed-in readers
// so the signed-out page costs the Worker nothing; the insights charts themselves work signed out, from
// GitHub.

import { who } from "./who.ts";
import { json, problem } from "./http.ts";
import { hiddenOne } from "./hidden.ts";
import { all, dependentsOf, first, marksOf, repoByKey, repoByPath, statsOf } from "./store.ts";
import { NOT_FOUND, parseTarget, serviceForge } from "./read.ts";
import type { ForgeRequest, RepoRow } from "./types.ts";
import type { Dependent, Point, ResearchMark, StatsFacts } from "../../../src/lib/stats.ts";

interface StatsRow {
  usedby_papers: number;
  usedby_repos: number;
  stars: string;
}

interface DependentRow {
  dep_kind: "paper" | "repo";
  dep_ref: string;
  via: string;
  owner: string;
  name: string;
  slug: string;
  title: string;
}

interface MarkRow {
  kind: "paper" | "map" | "tag";
  ref: string;
  t: number;
  label: string;
}

/** Parse the star history JSON ([[day, total], …]) into points, defensively. */
function starsOf(raw: string): Point[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")
      .map(([t, v]) => ({ t, v }));
  } catch {
    return [];
  }
}

function dependentView(row: DependentRow): Dependent {
  return row.dep_kind === "paper"
    ? { kind: "paper", via: row.via, doi: row.dep_ref, slug: row.slug || null, title: row.title || null }
    : { kind: "repo", via: row.via, owner: row.owner, name: row.name };
}

export async function handleStats(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return problem(400, "invalid", "Name one repository: ?id=<forge>:<id> or ?path=<owner>/<name>.");
  const row =
    "id" in target
      ? await first<RepoRow>(repoByKey(r.db, target.forge, target.id))
      : await first<RepoRow>(repoByPath(r.db, target.forge, target.owner, target.name));
  if (!row || row.state === "hidden") return problem(404, "not_found", NOT_FOUND);
  // A repository hidden by moderation shows none of its statistics here.
  if (await hiddenOne(r.db, "repo", `${row.forge}:${row.repo_id}`)) {
    return problem(410, "moderated", "This repository is hidden from the registry's pages.");
  }
  const [statsRow, depRows, markRows] = await Promise.all([
    first<StatsRow>(statsOf(r.db, row.forge, row.repo_id)),
    all<DependentRow>(dependentsOf(r.db, row.forge, row.repo_id)),
    all<MarkRow>(marksOf(r.db, row.forge, row.repo_id)),
  ]);
  const dependents: Dependent[] = depRows.map(dependentView);
  const marks: ResearchMark[] = markRows.map((m) => ({ t: m.t, kind: m.kind, label: m.label }));
  const answer: StatsFacts = {
    forge: row.forge,
    id: row.repo_id,
    usedBy: {
      papers: statsRow?.usedby_papers ?? 0,
      repos: statsRow?.usedby_repos ?? 0,
      dependents,
    },
    marks,
    stars: statsRow ? starsOf(statsRow.stars) : [],
  };
  return json(answer);
}
