// The commit dialog's pure part (night phase 03, E3; docs/WEB_EDITING.md): no DOM, testable in Node
// (tests/forge-pages/commit-view.test.ts). The dialog itself is src/scripts/commit-dialog.ts; the
// editor (repo-edit.ts) and the upload and delete pages (repo-upload.ts) open it.
// - The commit is declared with the Worker's own rules and sentence (worker/forge/service/
//   act-commit.ts `validateCommit`, `describeCommit`: D01-28): what the page confirms is what the
//   Worker does.
// - The research link (PLATFORM_PLAN §15.6, phase 03): before the commit, the dialog says which
//   tracing-map links the change touches — lines a map links changed, or a file a map links moved
//   or deleted — each with its paper and paragraph, and recommends a new branch.
// - Where the page comes back to after GitHub: the editor itself (its draft kept on a failure).

import { commitSpec, type CommitPayload } from "../../worker/forge/service/act-commit.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import type { ForgeName } from "../../worker/forge/types.ts";
import { touchesLines } from "./editor.ts";
import { backPath, repoPath, type RepoCoords, type StartInput } from "./forge.ts";
import { type El, h } from "./repo-view.ts";
import { type Located, pairClass, readerUrl } from "./traced.ts";

/** The commit as the page declares it: the Worker's own validation and sentence, or the problem. */
export function declareCommit(
  repo: RepoCoords & { id: string | null; forge?: ForgeName },
  payload: CommitPayload,
  back: string,
): { input: StartInput; sentence: string } | { problem: string } {
  const parsed = commitSpec.validate(payload);
  if (isProblem(parsed)) return { problem: parsed.message };
  const forge = repo.forge ?? "github";
  const target = repo.id ? { forge, id: repo.id } : { forge, owner: repo.owner, name: repo.name };
  return {
    input: { kind: "commit", repo: target, branch: payload.branch, expectedHead: payload.base, payload, back },
    sentence: `${commitSpec.describe(parsed)}.`,
  };
}

/** The page GitHub's answer comes back to: the view that opened the dialog (the editor, the upload
 *  or delete page), when its address is one a return may carry; else the repository's home. */
export function commitBack(repo: RepoCoords, pathname: string): string {
  const back = backPath(pathname);
  return back === pathname ? back : repoPath(repo);
}

// ─── the tracing-map links a change touches ──────────────────────────────────

/** A file of the commit, and what the change does to it. */
export interface FileTouch {
  path: string;
  /** "edit": the text changes (before → after); "move": it goes to `to`; "delete": it goes. */
  kind: "edit" | "move" | "delete";
  before?: string;
  after?: string;
  to?: string;
  /** The map links found on the file at the commit the change starts from. */
  located: readonly Located[];
}

export interface TouchedLink {
  located: Located;
  path: string;
  why: "lines" | "moved" | "deleted";
}

/** The links a change touches: a range whose lines change (or cannot be found: then the change is
 *  said to touch it, to be safe), every link of a file moved or deleted. */
export function touchedLinks(files: readonly FileTouch[]): TouchedLink[] {
  const out: TouchedLink[] = [];
  for (const f of files) {
    for (const l of f.located) {
      if (f.kind === "delete") out.push({ located: l, path: f.path, why: "deleted" });
      else if (f.kind === "move" && f.before === f.after) out.push({ located: l, path: f.path, why: "moved" });
      else if (!l.lines || touchesLines(f.before ?? "", f.after ?? "", l.lines)) out.push({ located: l, path: f.path, why: "lines" });
      else if (f.kind === "move") out.push({ located: l, path: f.path, why: "moved" });
    }
  }
  return out;
}

const range = (r: { start: number; end: number }) => (r.end > r.start ? `lines ${r.start} to ${r.end}` : `line ${r.start}`);

/** The dialog's notice: the links touched, each with its paper and paragraph (the reader opens
 *  beside the code), and what it means; null when the change touches none. */
export function mapNotice(touched: readonly TouchedLink[], branch: string): El | null {
  if (!touched.length) return null;
  const item = (t: TouchedLink) => {
    const r = t.located.lines ?? t.located.pair;
    const what = t.why === "deleted" ? "the file is deleted" : t.why === "moved" ? "the file moves" : `${range(r)} change`;
    return h(
      "li",
      { class: pairClass(t.located.pair.pair) },
      h("code", null, t.path),
      `, ${range(r)}: `,
      h("a", { href: readerUrl(t.located.map, t.located.pair.pair) }, `Paragraph ${t.located.pair.paragraph}${t.located.pair.section ? ` of ${t.located.pair.section}` : ""}`),
      ` of ${t.located.map.title || t.located.map.doi} — ${what}.`,
    );
  };
  const papers = new Set(touched.map((t) => t.located.map.paper)).size;
  return h(
    "div",
    { class: "traced-note", role: "note" },
    h("p", { class: "traced-title" }, "Tracing maps"),
    h(
      "p",
      null,
      `This change touches ${touched.length === 1 ? "a link" : `${touched.length} links`} of ${papers === 1 ? "a tracing map" : `${papers} tracing maps`} between the code and ${papers === 1 ? "its paper" : "their papers"}:`,
    ),
    h("ul", null, ...touched.map(item)),
    h(
      "p",
      null,
      `Each map keeps pointing at its own commit, so the paper's links stay valid; this change makes the code of ${branch} differ from what they show. A new branch keeps it reviewable, and the map's authors can re-anchor their map once it is merged.`,
    ),
  );
}
