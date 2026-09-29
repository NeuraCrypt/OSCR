// The ways into an issue from the code (night phase 05, E6): a file's selected lines offer
// "Reference in a new issue" (GitHub's, the lines' permalink in its text) and, when the repository
// is attached to a paper, "Report a code–paper mismatch" or "a code error" on these lines (the
// registry's research forms, prefilled with the file, the lines and the commit). The Code ↔ Paper
// reader offers "Report a mismatch" on each of its matches (src/pages/paper/[slug]/code.astro).
// Links only: nothing is read or written here. Like every browser script, it never names the
// platform.

import { lineHash } from "../lib/code-nav.ts";
import { repoPath } from "../lib/forge.ts";
import { newIssuePath } from "../lib/issues.ts";
import { h } from "../lib/repo-view.ts";
import { lineMenuExtras } from "./repo-code.ts";

lineMenuExtras.push(({ env, opened, path, selection }) => {
  const lines = selection.end > selection.start ? `${selection.start}-${selection.end}` : String(selection.start);
  const permalink = `${location.origin}${repoPath(env.repo, "blob", [opened.commit, ...path.split("/")])}${lineHash(selection)}`;
  const issue = newIssuePath(env.repo, { blank: "1", body: `${permalink}\n\n` });
  const papers = env.layer?.papers ?? [];
  const research = (type: string) => newIssuePath(env.repo, { template: `research:${type}`, "field.path": path, "field.lines": lines, "field.commit": opened.commit, ...(papers[0] ? { doi: papers[0].doi } : {}) });
  return h(
    "p",
    { class: "line-issues" },
    h("a", { href: issue }, "Reference in a new issue"),
    papers.length ? [" · ", h("a", { href: research("mismatch") }, "Report a code–paper mismatch on these lines"), " · ", h("a", { href: research("code_error") }, "a code error")] : null,
  );
});
