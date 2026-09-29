// A pull request's conflicts, resolved in the reader's browser (night phase 04, E6; D00-7,
// D04-*): pure, no DOM, testable in Node (tests/forge-pages/conflicts.test.ts).
//
// GitHub makes the merge commit of a resolution only on its own page; the registry does it the way
// D00-7 set: the three versions of each file come from GitHub (the merge base, the pull request's
// head, the base's head), the conflicting hunks are computed here on the reader's CPU
// (worker/forge/diff.ts `diff3`), and the result is ONE commit with two parents — [the pull
// request's head, the base's head] — on the pull request's branch, made by GitHub as the person
// (phase 03's `commit` action with `mergeParent`). The commit starts from the pull request's tree:
// its changes are the resolved files and the files only the base changed.
//
// What is resolved here: text files changed on both sides. What is not (said, with the command
// line): a file deleted or renamed on one side and changed on the other, a binary file changed on
// both, more than the commit's 100 files or the Worker's 1 MiB.

import { diff3, type Diff3Chunk, splitLines } from "../../worker/forge/diff.ts";
import type * as T from "../../worker/forge/types.ts";

/** A change of the resolution's commit, as the commit action takes it. */
export type ResolutionChange = { op: "put"; path: string; text: string } | { op: "put"; path: string; base64: string } | { op: "delete"; path: string };

/** The files a commit from the browser changes at most (worker/forge/service/caps.ts COMMIT_FILES). */
export const RESOLUTION_FILES = 100;
/** The payload's bytes at most, under the Worker's 1 MiB with JSON's escapes. */
export const RESOLUTION_BYTES = 950 * 1024;

// ─── which files ─────────────────────────────────────────────────────────────

export interface MergePlan {
  /** Changed on both sides: merged here, hunk by hunk. */
  both: string[];
  /** Changed on the base's side only: taken as the base has them. */
  theirs: Pick<T.FileChangeSummary, "path" | "status" | "previousPath">[];
  /** What the browser does not resolve, in words (then: the command line). */
  problems: string[];
}

const touched = (f: Pick<T.FileChangeSummary, "path" | "previousPath">) => [f.path, ...(f.previousPath ? [f.previousPath] : [])];

/** The plan of a resolution: `ours`, the pull request's changes from the merge base; `theirs`, the
 *  base's changes from the merge base. */
export function mergePlan(ours: readonly T.FileChangeSummary[], theirs: readonly T.FileChangeSummary[]): MergePlan {
  const mine = new Map<string, T.FileChangeSummary>();
  for (const f of ours) for (const p of touched(f)) mine.set(p, f);
  const plan: MergePlan = { both: [], theirs: [], problems: [] };
  for (const t of theirs) {
    const o = touched(t).map((p) => mine.get(p)).find((x) => x);
    if (!o) {
      plan.theirs.push({ path: t.path, status: t.status, previousPath: t.previousPath });
      continue;
    }
    if (t.status === "removed" || o.status === "removed") {
      plan.problems.push(`${t.path} was deleted on one side and changed on the other: decide with git whether it stays.`);
    } else if (t.status === "renamed" || o.status === "renamed" || t.path !== o.path) {
      plan.problems.push(`${t.path} was renamed on one side and changed on the other: git follows renames better than the browser.`);
    } else if (t.patch === null || o.patch === null) {
      plan.problems.push(`${t.path} changed on both sides and is binary (or too large to compare): choose its version with git.`);
    } else plan.both.push(t.path);
  }
  return plan;
}

// ─── one file ────────────────────────────────────────────────────────────────

export interface FileMerge {
  path: string;
  chunks: Diff3Chunk[];
  conflicts: number;
  /** Whether the result ends with a newline (the side that changed it wins, as git does). */
  finalNewline: boolean;
  /** The file's line ending, kept. */
  eol: "\n" | "\r\n";
}

/** The three-way merge of a file's texts: the merge base, the pull request's (ours), the base's
 *  (theirs). */
export function mergeFile(path: string, base: string, ours: string, theirs: string): FileMerge {
  const eol: "\n" | "\r\n" = /\r\n/.test(ours) || /\r\n/.test(theirs) ? "\r\n" : "\n";
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  const [o, a, b] = [splitLines(norm(base)), splitLines(norm(ours)), splitLines(norm(theirs))];
  const chunks = diff3(o.lines, a.lines, b.lines);
  return {
    path,
    chunks,
    conflicts: chunks.filter((c) => c.kind === "conflict").length,
    finalNewline: a.finalNewline === o.finalNewline ? b.finalNewline : a.finalNewline,
    eol,
  };
}

/** A conflict's resolution: one side, both in either order, or the reader's own lines. */
export type Choice = "ours" | "theirs" | "ours-then-theirs" | "theirs-then-ours" | { lines: string[] };

/** The lines a choice keeps. */
export function chosen(c: Extract<Diff3Chunk, { kind: "conflict" }>, choice: Choice): string[] {
  if (typeof choice === "object") return choice.lines;
  switch (choice) {
    case "ours":
      return c.ours;
    case "theirs":
      return c.theirs;
    case "ours-then-theirs":
      return [...c.ours, ...c.theirs];
    case "theirs-then-ours":
      return [...c.theirs, ...c.ours];
  }
}

/** The file's text once each conflict has its choice (in order); null while one has none. */
export function resolveFile(m: FileMerge, choices: readonly (Choice | null)[]): string | null {
  const out: string[] = [];
  let n = 0;
  for (const c of m.chunks) {
    if (c.kind !== "conflict") {
      out.push(...c.lines);
      continue;
    }
    const choice = choices[n++];
    if (!choice) return null;
    out.push(...chosen(c, choice));
  }
  if (!out.length) return "";
  return out.join(m.eol) + (m.finalNewline ? m.eol : "");
}

/** The file with git's conflict markers, for a reader who prefers to edit it whole. */
export function withMarkers(m: FileMerge, labels: { ours: string; theirs: string }): string {
  const out: string[] = [];
  for (const c of m.chunks) {
    if (c.kind !== "conflict") out.push(...c.lines);
    else out.push(`<<<<<<< ${labels.ours}`, ...c.ours, "=======", ...c.theirs, `>>>>>>> ${labels.theirs}`);
  }
  return out.join(m.eol) + (m.finalNewline && out.length ? m.eol : "");
}

/** Whether a text still holds a conflict marker (a line that starts with one of git's). */
export const hasMarkers = (text: string): boolean => /^(<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(text);

// ─── the commit ──────────────────────────────────────────────────────────────

/** GitHub's own message for it. */
export const resolutionMessage = (base: string, head: string): string => `Merge branch '${base}' into ${head}`;

/** The resolution's changes checked against the commit's limits, or why they do not fit. */
export function resolutionFits(changes: readonly ResolutionChange[]): string | null {
  if (changes.length > RESOLUTION_FILES) {
    return `The resolution changes ${changes.length} files: a commit from the browser takes at most ${RESOLUTION_FILES}. Merge with git instead (the commands below).`;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(changes)).byteLength;
  if (bytes > RESOLUTION_BYTES) return "The resolution is larger than the registry passes to GitHub (about 1 MiB): merge with git instead (the commands below).";
  return null;
}

/** The command line that does the same merge, for what the browser does not resolve. */
export function commandLine(o: { baseRepo: string; base: string; headRepo: string | null; head: string; web?: string }): string[] {
  const web = o.web ?? "https://github.com";
  const fromFork = o.headRepo && o.headRepo.toLowerCase() !== o.baseRepo.toLowerCase();
  return [
    fromFork ? `git clone ${web}/${o.headRepo}.git && cd ${o.headRepo?.split("/")[1]}` : `git clone ${web}/${o.baseRepo}.git && cd ${o.baseRepo.split("/")[1]}`,
    `git checkout ${o.head}`,
    fromFork ? `git pull ${web}/${o.baseRepo}.git ${o.base}` : `git merge origin/${o.base}`,
    "# resolve the conflicts in your editor, then:",
    "git add -A && git commit",
    `git push origin ${o.head}`,
  ];
}
