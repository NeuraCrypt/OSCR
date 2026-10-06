// The shapes the repository-statistics layer shares between the Worker (worker/forge/service/
// statistics.ts, traffic.ts) and the browser (src/scripts/repo-insights.ts), and the pure chart
// inputs (src/lib/stats-view.ts). Types and tiny pure helpers only: no DOM, no runtime of the view,
// so the Worker imports it without pulling the charts in. See docs/STATISTICS.md (night phase 12).

/** A point in a time series: a Unix-seconds timestamp and a value. */
export interface Point {
  t: number;
  v: number;
}

/** A diverging point (code frequency): additions up, deletions down (negative). */
export interface DivergingPoint {
  t: number;
  up: number;
  down: number;
}

/** A ranked row (contributors, referrers, popular pages). */
export interface RankedBar {
  label: string;
  value: number;
  note?: string;
}

/** A research mark overlaid on a chart: a commit a paper or a map cites, or a tag tied to a paper
 *  version or a DOI. OSCR's own fact, never read from GitHub. The timestamp is when the commit or the
 *  tag was made (so it lands on the chart's time axis). */
export interface ResearchMark {
  t: number;
  kind: "paper" | "map" | "tag";
  label: string;
}

/** One dependant of a repository, for "Used by" (the research angle: a paper counts, not only a
 *  repository). A repository dependant names its owner and repo; a paper names its DOI and slug.
 *  `via` is the package through which it depends (e.g. "PyPI:numpy"). */
export interface Dependent {
  kind: "paper" | "repo";
  via: string;
  /** kind === "repo". */
  owner?: string;
  name?: string;
  /** kind === "paper". */
  doi?: string;
  slug?: string | null;
  title?: string | null;
}

/** GET /api/forge/stats?id=… : OSCR's own statistics facts for one repository (the Mac computed
 *  them; the Worker reads a key range, never a scan). The GitHub charts are read in the browser and
 *  are not here; these are the parts only OSCR has. */
export interface StatsFacts {
  forge: "github";
  id: string | null;
  /** "Used by": how many papers and repositories depend on this one, and a sample of each. */
  usedBy: {
    papers: number;
    repos: number;
    dependents: Dependent[];
  };
  /** The research marks for the insights charts. */
  marks: ResearchMark[];
  /** Star history: the cumulative count of OSCR-native stars over time (phase 08), oldest first. */
  stars: Point[];
}

/** An empty facts answer (a repository OSCR knows but has no statistics for yet). */
export function emptyStats(id: string | null): StatsFacts {
  return { forge: "github", id, usedBy: { papers: 0, repos: 0, dependents: [] }, marks: [], stars: [] };
}
