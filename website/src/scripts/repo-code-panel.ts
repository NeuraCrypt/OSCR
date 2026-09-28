// The /r/ shell's Code button and the quick setup of an empty repository (night phase 01, E7).
// View trees (src/lib/repo-view.ts `h`) that the shell turns into DOM nodes, and `wireCopy`, the
// "Copy" buttons under each block of commands. Testable in Node: nothing here touches the DOM until
// wireCopy is called.
//
// Git goes straight to github.com with GitHub's own credentials (D00-3): every command and every
// link here is GitHub's (src/lib/forge.ts: cloneCommands, zipUrl, desktopUrl, codespacesUrl,
// tokenTemplateUrl), never one of the registry's, which issues no git token and sees no code.
// Like every browser script, it never names the platform: the page hands its name in (`site`).

import {
  cloneCommands,
  cloneUrl,
  codespacesUrl,
  desktopUrl,
  tokenTemplateUrl,
  zipUrl,
  type RepoCoords,
} from "../lib/forge.ts";
import { type El, h, link, siteName } from "../lib/repo-view.ts";

/** A branch name that may go into a command to copy as it is: git allows ";", "$", "`" or "|" in
 *  ref names, which a shell would read. Anything else becomes "main", GitHub's default. */
export function commandBranch(branch: string | null | undefined): string {
  return typeof branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) && !branch.includes("..") && !/[./]$/.test(branch)
    ? branch
    : "main";
}

/** A block of commands to copy, and its Copy button. */
export const commands = (lines: string[]): El[] => [
  h("pre", { class: "commands" }, h("code", null, lines.join("\n"))),
  h("button", { class: "copy", type: "button" }, "Copy"),
];

export interface PanelOptions {
  /** The default branch, when GitHub said. */
  defaultBranch?: string | null;
  /** The repository it was forked from, when GitHub said: the upstream remote. */
  parent?: RepoCoords | null;
  isTemplate?: boolean;
  site?: string | null;
}

/** The commands of GitHub's guides on remotes: the upstream of a fork, a changed address, a local
 *  clone after a rename (of the repository or of its default branch). */
export function remoteCommands(repo: RepoCoords, options: PanelOptions = {}): { upstream: string[]; setUrl: string[]; afterRename: string[] } {
  const url = cloneUrl(repo);
  const branch = commandBranch(options.defaultBranch);
  const upstream = options.parent ? cloneUrl(options.parent) : url;
  return {
    upstream: [`git remote add upstream ${upstream}`, "git fetch upstream", `git merge upstream/${branch}`],
    setUrl: [`git remote set-url origin ${url}`, "git remote -v"],
    afterRename: [`git remote set-url origin ${url}`, "git fetch origin", `git branch -u origin/${branch} ${branch}`, "git remote set-head origin -a"],
  };
}

/** The Code button: a <details class="panel"> that opens without a script. */
export function codePanel(repo: RepoCoords, options: PanelOptions = {}): El {
  const site = siteName(options.site);
  const clone = cloneCommands(repo);
  const remotes = remoteCommands(repo, options);
  return h(
    "details",
    { class: "panel" },
    h("summary", null, "Code"),
    h("h3", null, "Clone over HTTPS"),
    h("p", null, h("code", null, cloneUrl(repo))),
    ...commands([clone.https]),
    h("h3", null, "Partial and shallow clones"),
    h("p", null, "Every commit, with the files' contents fetched only when checked out (a partial clone):"),
    ...commands([clone.partial]),
    h("p", null, "The last commit only (a shallow clone), the quickest to download:"),
    ...commands([clone.shallow]),
    h("h3", null, "Download or open"),
    h(
      "ul",
      null,
      h("li", null, "Download ZIP: GitHub builds the archive, so it comes from the source. ", link(zipUrl(repo, options.defaultBranch ? commandBranch(options.defaultBranch) : null), "At the source"), "."),
      h("li", null, link(desktopUrl(repo), "Open with GitHub Desktop"), ", GitHub's application for your computer."),
      h("li", null, link(codespacesUrl(repo), "Open in a codespace"), ": GitHub's, on your own Codespaces quota."),
    ),
    h("h3", null, "Pushing: GitHub's credentials, not your account here"),
    h(
      "p",
      null,
      `git talks to github.com directly: ${site} never sees your code, your password or your token. When git asks for a password, give it a GitHub token, never the sign-in of ${site}. `,
      link(tokenTemplateUrl(repo), "Make a token for this repository on GitHub"),
      ` (pre-filled: Contents read and write, 30 days; choose "Only select repositories" and pick ${repo.owner}/${repo.name}), or sign in once with GitHub Desktop or GitHub's command line tool.`,
    ),
    h("h3", null, "Remotes"),
    h("p", null, options.parent ? "Follow the repository it was forked from (the upstream remote):" : "In a fork of it, follow this repository (the upstream remote):"),
    ...commands(remotes.upstream),
    h("p", null, "Point a clone at this address (change the remote's address):"),
    ...commands(remotes.setUrl),
    h("p", null, "Update a local clone after a rename of the repository or of its default branch:"),
    ...commands(remotes.afterRename),
  );
}

/** "Use this template": the creation page, pre-filled with this template (/new/, E2). */
export function useTemplate(repo: RepoCoords): El {
  return h("p", null, link(`/new/?template=${repo.owner}/${repo.name}`, "Use this template"), ": a new repository in your own GitHub account, from its files.");
}

/** The quick setup of an empty repository: its address, then GitHub's four ways to fill it. */
export function quickSetup(repo: RepoCoords, options: PanelOptions = {}): El {
  const url = cloneUrl(repo);
  const branch = commandBranch(options.defaultBranch);
  return h(
    "section",
    { class: "setup", id: "quick-setup" },
    h("h2", null, "Quick setup: this repository is empty"),
    h("p", null, "Its address for git, on GitHub:"),
    ...commands([url]),
    ...commands([`git clone ${url}`]),
    h("h3", null, "Create a new repository on the command line"),
    ...commands([
      `echo "# ${repo.name}" >> README.md`,
      `git init -b ${branch}`,
      "git add README.md",
      'git commit -m "First commit"',
      `git remote add origin ${url}`,
      `git push -u origin ${branch}`,
    ]),
    h("h3", null, "Push an existing repository from the command line"),
    ...commands([`git remote add origin ${url}`, `git branch -M ${branch}`, `git push -u origin ${branch}`]),
    h("h3", null, "Add code that is not in git yet"),
    h("p", null, "In the folder of the code:"),
    ...commands([`git init -b ${branch}`, "git add .", 'git commit -m "First commit"', `git remote add origin ${url}`, `git push -u origin ${branch}`]),
    h("h3", null, "Import code from another repository"),
    h("p", null, link("/new/import/", "Import it on your own machine"), ": every commit id kept, so the tracing maps that cite them stay valid."),
    h("p", null, "Files over 100 MiB cannot be pushed to GitHub: ", link("/hosting/large-files/", "large files and data"), "."),
  );
}

/** The Copy buttons: each copies the block of commands just before it. */
export function wireCopy(root: HTMLElement): void {
  root.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("button.copy");
    const pre = button?.previousElementSibling;
    if (!(button instanceof HTMLButtonElement) || !pre || pre.tagName !== "PRE") return;
    const done = (said: string) => {
      button.textContent = said;
      setTimeout(() => (button.textContent = "Copy"), 2000);
    };
    navigator.clipboard?.writeText(pre.textContent ?? "").then(
      () => done("Copied"),
      () => done("Select the text to copy it"),
    ) ?? done("Select the text to copy it");
  });
}
