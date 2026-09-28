// The repository's Settings page, inside the /r/ shell (/r/<owner>/<name>/settings/): the settings
// in a dl.settings, each change one authorized action confirmed in a sentence (forge-client.ts),
// and section.danger for archive, transfer and deletion (D00-10). The shell (repo-shell.ts, E7)
// calls mountSettings with what it read; a reader without admin sees no action.
//
// STUB, created by the foundation (F) of phase 01 so that the shell can import it; owned by E8,
// which builds it. Everything is written as text nodes, never as HTML; like every browser script,
// it never names the platform.
import type { ShellRepo } from "../lib/forge.ts";

export function mountSettings(root: HTMLElement, repo: ShellRepo): void {
  const p = document.createElement("p");
  p.className = "warning";
  p.textContent = `The settings of ${repo.owner}/${repo.name} are not built yet: GitHub's own settings page can change them.`;
  root.replaceChildren(p);
}
