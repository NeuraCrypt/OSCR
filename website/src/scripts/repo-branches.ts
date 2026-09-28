// The repository's Branches page, inside the /r/ shell (/r/<owner>/<name>/branches/): the branches
// read in the reader's browser on their own GitHub quota, in a table.branches, with GitHub's views
// (default, yours, active, stale) and a search by name; create, rename and delete as authorized
// actions (never the default branch). The shell (repo-shell.ts, E7) calls mountBranches.
//
// STUB, created by the foundation (F) of phase 01 so that the shell can import it; owned by E8,
// which builds it. Everything is written as text nodes, never as HTML; like every browser script,
// it never names the platform.
import type { ShellRepo } from "../lib/forge.ts";

export function mountBranches(root: HTMLElement, repo: ShellRepo): void {
  const p = document.createElement("p");
  p.className = "warning";
  p.textContent = `The branches of ${repo.owner}/${repo.name} are not listed here yet: GitHub's own page lists them.`;
  root.replaceChildren(p);
}
