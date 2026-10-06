// History, commits, diffs and comparisons in the registry's own viewer (night phase 02, E3): pure
// functions, no DOM, testable in Node (tests/forge-pages/history.test.ts). The script
// src/scripts/repo-history.ts reads GitHub in the reader's browser and shows the view trees built
// here.
//
// - Patches (`parsePatch`): GitHub's `files[].patch` (hunks only) into lines with their numbers on
//   each side; `hunksOf` computes them from two texts with worker/forge/diff.ts (the same Myers
//   diff the test double uses), at any context: the reader's browser expands the context from the
//   raw files, which GitHub does not count in the reader's 60 requests.
// - Whitespace (`ignoreWhitespace`): each hunk diffed again with the whitespace removed, as `git diff
//   -w` does; a line that changed only in its spaces becomes context.
// - Views: a diff unified or split (`table.diff`, one row per line, the numbers in their own
//   cells), a file's header (its status in words, +/−), a commit's header (message, people, day,
//   parents, verification in words), the commit list grouped by day (`h2.day`), the files a
//   commit changed as a tree, and the `.diff` a reader downloads (built here from the patches; a
//   `.patch` would carry the authors' email addresses, which the registry never shows).
// - Comparisons (`parseCompare`): base...head (three dots: from the merge base) or base..head (two
//   dots: the two trees directly, computed here), a ref of a fork as owner:ref or owner:repo:ref,
//   relative refs (main~3, v1.0^, HEAD^^).
//
// Every text is masked for email addresses (h() masks its strings; commit messages carry
// Signed-off-by lines); authors are names and logins, never links to GitHub (the owner's rule,
// 2026-09-29: readers stay in the registry).

import { diffLines, patch as unifiedHunks } from "../../worker/forge/diff.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import { isObjectId } from "../../worker/forge/paths.ts";
import type * as T from "../../worker/forge/types.ts";
import { refSegments, shortSha, sizeInWords } from "./code-nav.ts";
import { isOwner, isRepoName, repoPath, type RepoCoords } from "./forge.ts";
import { plural } from "./format.ts";
import type { LineNodes } from "./highlight.ts";
import { type Child, dateOfIso, type El, h } from "./repo-view.ts";

// ─── patches ─────────────────────────────────────────────────────────────────

export interface DiffLine {
  kind: "context" | "add" | "del" | "note";
  /** The line's number in the old file (context, del), or null. */
  old: number | null;
  /** The line's number in the new file (context, add), or null. */
  new: number | null;
  text: string;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What follows the second "@@" (git's function context), masked. */
  section: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** A unified patch (hunks, optionally after git's file headers) into hunks and numbered lines.
 *  Lines that are not part of a hunk are skipped; "\ No newline at end of file" is a note. */
export function parsePatch(text: string | null | undefined): Hunk[] {
  if (typeof text !== "string" || !text) return [];
  const out: Hunk[] = [];
  let hunk: Hunk | null = null;
  let o = 0;
  let n = 0;
  // What the hunk's header announced and is not read yet: past it, a line is not the hunk's.
  let leftOld = 0;
  let leftNew = 0;
  for (const raw of text.split("\n")) {
    const m = HUNK.exec(raw);
    if (m) {
      hunk = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), section: maskEmails(m[5] ?? ""), lines: [] };
      out.push(hunk);
      o = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      n = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
      leftOld = hunk.oldLines;
      leftNew = hunk.newLines;
      continue;
    }
    if (!hunk) continue;
    const c = raw[0];
    if (c === "\\") {
      hunk.lines.push({ kind: "note", old: null, new: null, text: raw.slice(2) });
      continue;
    }
    if (leftOld <= 0 && leftNew <= 0) continue;
    const body = raw.slice(1);
    if (c === "+") {
      hunk.lines.push({ kind: "add", old: null, new: n++, text: body });
      leftNew--;
    } else if (c === "-") {
      hunk.lines.push({ kind: "del", old: o++, new: null, text: body });
      leftOld--;
    } else if (c === " " || raw === "") {
      // An empty line inside a hunk is a context line whose space a tool dropped.
      hunk.lines.push({ kind: "context", old: o++, new: n++, text: body });
      leftOld--;
      leftNew--;
    }
  }
  return out;
}

/** The hunks from `oldText` to `newText` at `context` lines of context (Infinity: the whole file). */
export function hunksOf(oldText: string, newText: string, context = 3): Hunk[] {
  const lines = Math.max(oldText.split("\n").length, newText.split("\n").length);
  return parsePatch(unifiedHunks(oldText, newText, Number.isFinite(context) ? context : lines + 1));
}

const squash = (s: string) => s.replace(/\s+/g, "");

/** Each hunk again, whitespace ignored (git diff -w): a line changed only in its whitespace becomes
 *  context (shown as its new text); hunks left with no change are dropped. */
export function ignoreWhitespace(hunks: readonly Hunk[]): Hunk[] {
  const out: Hunk[] = [];
  for (const hk of hunks) {
    const olds = hk.lines.filter((l) => l.kind === "context" || l.kind === "del");
    const news = hk.lines.filter((l) => l.kind === "context" || l.kind === "add");
    const ops = diffLines(olds.map((l) => squash(l.text)), news.map((l) => squash(l.text)));
    const lines: DiffLine[] = [];
    for (const op of ops) {
      if (op.kind === "equal") lines.push({ kind: "context", old: olds[op.a].old, new: news[op.b].new, text: news[op.b].text });
      else if (op.kind === "delete") lines.push({ ...olds[op.a], kind: "del" });
      else lines.push({ ...news[op.b], kind: "add" });
    }
    if (lines.some((l) => l.kind !== "context")) out.push({ ...hk, lines });
  }
  return out;
}

/** +/− counts of hunks. */
export function hunkStats(hunks: readonly Hunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hk of hunks) for (const l of hk.lines) (l.kind === "add" ? additions++ : l.kind === "del" ? deletions++ : 0);
  return { additions, deletions };
}

/** The rows of a split view: each deletion paired with the addition at the same rank of its block
 *  of changes; context on both sides. */
export function splitRows(hunk: Hunk): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of hunk.lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
    else {
      flush();
      rows.push(l.kind === "note" ? { left: null, right: l } : { left: l, right: l });
    }
  }
  flush();
  return rows;
}

// ─── views of a diff ─────────────────────────────────────────────────────────

export type DiffMode = "unified" | "split";

/** Highlighted lines of a file, by their numbers on each side (the script fills them). */
export interface SideNodes {
  old: Map<number, LineNodes>;
  new: Map<number, LineNodes>;
}

const lineCell = (l: DiffLine | null, side: "old" | "new", nodes?: SideNodes): El => {
  if (!l) return h("td", { class: "code empty" });
  const n = side === "old" ? l.old : l.new;
  const shown = n !== null && nodes ? nodes[side].get(n) : undefined;
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "note" ? "" : " ";
  return h("td", { class: `code ${l.kind}` }, h("span", { class: "sign", "aria-hidden": "true" }, sign), l.kind === "note" ? h("em", null, l.text) : shown ?? (l.text ? [l.text] : []));
};

/** A line's number cell. With `anchor` (phase 04, a pull request's files), the cell names its side
 *  and line (data-side L or R, data-line) and carries an id ("<anchor>R12"), for comments and links. */
const num = (n: number | null, kind: string, anchor?: { prefix: string; side: "L" | "R" }) =>
  h(
    "td",
    anchor && n !== null ? { class: `num ${kind}`, id: `${anchor.prefix}${anchor.side}${n}`, "data-side": anchor.side, "data-line": String(n) } : { class: `num ${kind}` },
    n === null ? "" : String(n),
  );

/** A diff as a table: unified (old number, new number, the line) or split (old number, old line,
 *  new number, new line). A hunk's header is a row of its own. `anchors` (phase 04): the prefix of
 *  the number cells' ids, which then name their side and line. */
export function diffTable(hunks: readonly Hunk[], mode: DiffMode, nodes?: SideNodes, label = "Changes", anchors?: string): El {
  const rows: El[] = [];
  const at = (side: "L" | "R") => (anchors ? { prefix: anchors, side } : undefined);
  for (const hk of hunks) {
    const header = `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@${hk.section ? ` ${hk.section}` : ""}`;
    rows.push(h("tr", { class: "hunk" }, h("td", { colspan: mode === "split" ? "4" : "3" }, header)));
    if (mode === "unified") {
      // A context line takes comments on the new side, as on GitHub; a deleted line on the old one.
      for (const l of hk.lines) {
        rows.push(h("tr", { class: l.kind }, num(l.old, l.kind, l.kind === "del" ? at("L") : undefined), num(l.new, l.kind, l.kind === "del" ? undefined : at("R")), lineCell(l, l.kind === "del" ? "old" : "new", nodes)));
      }
    } else {
      for (const r of splitRows(hk)) {
        rows.push(
          h("tr", null, num(r.left?.old ?? null, r.left?.kind ?? "empty", at("L")), lineCell(r.left, "old", nodes), num(r.right?.new ?? null, r.right?.kind ?? "empty", at("R")), lineCell(r.right, "new", nodes)),
        );
      }
    }
  }
  return h("table", { class: `diff ${mode}`, "aria-label": label }, h("tbody", null, rows));
}

const STATUS: Record<T.FileStatus, string> = {
  added: "added",
  modified: "modified",
  removed: "deleted",
  renamed: "renamed",
  copied: "copied",
  changed: "changed",
  unchanged: "unchanged",
};

/** A file's status in words ("renamed from a.py"). */
export const statusInWords = (f: Pick<T.FileChangeSummary, "status" | "previousPath">): string =>
  f.status === "renamed" && f.previousPath ? `renamed from ${f.previousPath}` : f.status === "copied" && f.previousPath ? `copied from ${f.previousPath}` : STATUS[f.status] ?? f.status;

/** +3 −1, in words for a screen reader too. */
export function changeCounts(additions: number, deletions: number): El {
  return h("span", { class: "counts", "aria-label": `${plural(additions, "line")} added, ${plural(deletions, "line")} deleted` }, h("span", { class: "added" }, `+${additions}`), " ", h("span", { class: "deleted" }, `−${deletions}`));
}

/** The header of one file's diff: its path (a link to the file at the commit), its status, its
 *  counts, and the way to see it whole. */
export function fileHeader(repo: RepoCoords, commit: string | null, f: Pick<T.FileChangeSummary, "path" | "status" | "previousPath" | "additions" | "deletions">, index: number): El {
  const at = commit && f.status !== "removed" ? h("a", { href: repoPath(repo, "blob", refSegments(commit, f.path)) }, f.path) : h("span", null, f.path);
  return h("header", null, h("h3", { id: `file-${index + 1}` }, at), h("p", null, statusInWords(f), " · ", changeCounts(f.additions, f.deletions)));
}

// ─── commits ─────────────────────────────────────────────────────────────────

/** A person as a commit names them: their name, and their GitHub login when GitHub links one
 *  (no link: readers stay here). Never an email address (Actor has none; the text is masked). */
export const actorInWords = (a: T.Actor | null | undefined): string =>
  a ? `${maskEmails(a.name || a.login || "someone")}${a.login && a.login !== a.name ? ` (${a.login})` : ""}` : "someone";

/** What GitHub says of a commit's signature, in words. */
export function verifiedInWords(verified: boolean | null | undefined): string {
  if (verified === true) return "Signed, and the signature verified by GitHub.";
  if (verified === false) return "Not signed, or the signature not verified.";
  return "GitHub did not say whether it is signed.";
}

/** A commit message's title (its first line) and body (the rest), masked. */
export function messageParts(message: string): { title: string; body: string } {
  const m = maskEmails(message ?? "").replace(/\r\n?/g, "\n");
  const i = m.indexOf("\n");
  return i < 0 ? { title: m.trim(), body: "" } : { title: m.slice(0, i).trim(), body: m.slice(i + 1).replace(/^\n+/, "").trimEnd() };
}

/** A commit's header: its title, its body, who and when, its parents, its signature in words. */
export function commitHeader(repo: RepoCoords, c: T.CommitSummary): El {
  const { title, body } = messageParts(c.message);
  const day = dateOfIso(c.authoredAt);
  const committed = dateOfIso(c.committedAt);
  const sameCommitter = c.committer.name === c.author.name && c.committer.login === c.author.login;
  return h(
    "section",
    { class: "commit-head" },
    h("h2", null, title || "(no message)"),
    body ? h("pre", { class: "message" }, body) : null,
    h(
      "p",
      null,
      `${actorInWords(c.author)} ${day ? `wrote it on ${day}` : "wrote it"}`,
      sameCommitter ? "" : `; ${actorInWords(c.committer)} committed it${committed && committed !== day ? ` on ${committed}` : ""}`,
      ".",
    ),
    h(
      "p",
      null,
      "Commit ",
      h("code", null, c.sha),
      c.parents.length ? [c.parents.length === 1 ? " · parent " : " · parents ", ...c.parents.flatMap((p, i) => [i ? ", " : "", h("a", { href: repoPath(repo, "commit", [p]) }, shortSha(p))])] : " · the first commit",
      " · ",
      h("a", { href: repoPath(repo, "tree", [c.sha]) }, "Browse the files at this commit"),
    ),
    h("p", { class: c.verified ? "ok" : "" }, verifiedInWords(c.verified)),
  );
}

/** The day (UTC) of a commit: when it was committed, else authored. */
const dayOf = (c: T.CommitSummary): string => (c.committedAt ?? c.authoredAt ?? "").slice(0, 10);

/** Commits grouped by the day they were committed, newest first as GitHub lists them. */
export function commitsByDay(items: readonly T.CommitSummary[]): { day: string; items: T.CommitSummary[] }[] {
  const out: { day: string; items: T.CommitSummary[] }[] = [];
  for (const c of items) {
    const d = dayOf(c);
    const last = out[out.length - 1];
    if (last && last.day === d) last.items.push(c);
    else out.push({ day: d, items: [c] });
  }
  return out;
}

/** The commit list: one h2.day per day, then each commit's title (its page), who, its short id,
 *  its signature in words, and its files. */
export function commitList(repo: RepoCoords, items: readonly T.CommitSummary[], opts: { path?: string } = {}): El[] {
  const out: El[] = [];
  for (const g of commitsByDay(items)) {
    out.push(h("h2", { class: "day" }, `Commits on ${dateOfIso(`${g.day}T00:00:00Z`) ?? g.day}`));
    out.push(
      h(
        "ol",
        { class: "commit-list" },
        g.items.map((c) => {
          const { title } = messageParts(c.message);
          return h(
            "li",
            null,
            h("p", { class: "title" }, h("a", { href: repoPath(repo, "commit", [c.sha]) }, title || "(no message)")),
            h(
              "p",
              { class: "line" },
              actorInWords(c.author),
              " · ",
              h("code", null, h("a", { href: repoPath(repo, "commit", [c.sha]) }, shortSha(c.sha))),
              c.verified === true ? [" · ", h("span", { class: "ok" }, "signed")] : null,
              " · ",
              opts.path
                ? h("a", { href: repoPath(repo, "blob", refSegments(c.sha, opts.path)) }, "the file at this commit")
                : h("a", { href: repoPath(repo, "tree", [c.sha]) }, "the files at this commit"),
            ),
          );
        }),
      ),
    );
  }
  return out;
}

/** The files a commit changed, as a tree of links to their diffs below (#file-N). */
export function changedTree(files: readonly Pick<T.FileChangeSummary, "path" | "status">[]): El {
  interface Node {
    dirs: Map<string, Node>;
    files: { name: string; index: number; status: T.FileStatus }[];
  }
  const root: Node = { dirs: new Map(), files: [] };
  files.forEach((f, index) => {
    const parts = f.path.split("/");
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d)!;
    }
    node.files.push({ name: parts[parts.length - 1], index, status: f.status });
  });
  const render = (node: Node): El =>
    h(
      "ul",
      null,
      [...node.dirs.entries()].map(([name, child]) => h("li", { class: "dir" }, `${name}/`, render(child))),
      node.files.map((f) => h("li", null, h("a", { href: `#file-${f.index + 1}` }, f.name), ` (${STATUS[f.status] ?? f.status})`)),
    );
  return h("nav", { class: "file-tree changed", "aria-label": "Files changed" }, h("details", { open: "open" }, h("summary", null, `${plural(files.length, "file")} changed`), render(root)));
}

/** The `.diff` of a commit or a comparison, from its patches (git's headers added). */
export function diffText(files: readonly Pick<T.FileChangeSummary, "path" | "previousPath" | "status" | "patch">[]): string {
  const out: string[] = [];
  for (const f of files) {
    const a = f.previousPath ?? f.path;
    out.push(`diff --git a/${a} b/${f.path}`);
    if (f.status === "added") out.push("new file mode 100644");
    if (f.status === "removed") out.push("deleted file mode 100644");
    if (f.status === "renamed") out.push(`rename from ${a}`, `rename to ${f.path}`);
    if (f.patch === null) {
      out.push(`Binary files ${f.status === "added" ? "/dev/null" : `a/${a}`} and ${f.status === "removed" ? "/dev/null" : `b/${f.path}`} differ`);
      continue;
    }
    if (!f.patch) continue;
    out.push(`--- ${f.status === "added" ? "/dev/null" : `a/${a}`}`, `+++ ${f.status === "removed" ? "/dev/null" : `b/${f.path}`}`, f.patch);
  }
  return maskEmails(`${out.join("\n")}\n`);
}

// ─── comparisons ─────────────────────────────────────────────────────────────

export interface RefSpec {
  /** Another repository of the network (a fork): owner, and its name when given. */
  owner: string | null;
  repo: string | null;
  ref: string;
  /** main~3 → [["~", 3]]; v1^^ → [["^", 1], ["^", 1]]; ^2 names the second parent. */
  ancestry: ["~" | "^", number][];
}

export interface CompareSpec {
  base: RefSpec;
  head: RefSpec;
  /** 3: from the merge base (GitHub's default); 2: the two trees directly. */
  dots: 2 | 3;
}

const REF = /^[A-Za-z0-9._/-]{1,250}$/;

/** A side of a comparison: "main", "v1.0~2", "ada:feature", "ada:eeg-fork:feature". */
export function parseRefSpec(text: string): RefSpec | null {
  const parts = text.split(":");
  if (parts.length > 3) return null;
  const tail = parts[parts.length - 1];
  const owner = parts.length >= 2 ? parts[0] : null;
  const repo = parts.length === 3 ? parts[1] : null;
  if (owner !== null && !isOwner(owner)) return null;
  if (repo !== null && !isRepoName(repo)) return null;
  const m = /^(.*?)((?:[~^]\d*)*)$/.exec(tail);
  if (!m || !m[1] || !REF.test(m[1]) || m[1].includes("..") || m[1].startsWith("/") || m[1].endsWith("/")) return null;
  const ancestry: ["~" | "^", number][] = [];
  for (const a of m[2].matchAll(/([~^])(\d*)/g)) {
    const n = a[2] === "" ? 1 : Number(a[2]);
    if (!Number.isInteger(n) || n < 0 || n > 50) return null;
    ancestry.push([a[1] as "~" | "^", n]);
  }
  return { owner, repo, ref: m[1], ancestry };
}

/** "base...head" or "base..head"; a lone ref compares the default branch with it (base null). */
export function parseCompare(spec: string, defaultBranch: string | null): CompareSpec | null {
  if (typeof spec !== "string" || spec.length > 600) return null;
  let dots: 2 | 3 = 3;
  let parts: string[];
  if (spec.includes("...")) parts = spec.split("...");
  else if (spec.includes("..")) {
    parts = spec.split("..");
    dots = 2;
  } else parts = [defaultBranch ?? "", spec];
  if (parts.length !== 2) return null;
  const base = parseRefSpec(parts[0]);
  const head = parseRefSpec(parts[1]);
  return base && head ? { base, head, dots } : null;
}

/** A ref spec as written. */
export function refSpecText(r: RefSpec): string {
  const tail = `${r.ref}${r.ancestry.map(([op, n]) => (n === 1 ? op : `${op}${n}`)).join("")}`;
  return r.owner ? `${r.owner}:${r.repo ? `${r.repo}:` : ""}${tail}` : tail;
}

/** How head stands against base, in words. */
export function comparisonInWords(c: Pick<T.Comparison, "status" | "aheadBy" | "behindBy">, base: string, head: string): string {
  if (c.status === "identical") return `${head} and ${base} are the same commit.`;
  const ahead = `${plural(c.aheadBy, "commit")} ahead of ${base}`;
  const behind = `${plural(c.behindBy, "commit")} behind`;
  if (c.status === "ahead") return `${head} is ${ahead}.`;
  if (c.status === "behind") return `${head} is ${plural(c.behindBy, "commit")} behind ${base}, with nothing new.`;
  return `${head} and ${base} have diverged: ${head} is ${ahead}, and ${behind}.`;
}

/** The files that differ between two trees (a two-dot comparison, computed here): added, deleted,
 *  modified, by path and blob id. Their patches are computed from the raw files, on demand. */
export function treeChanges(base: readonly T.TreeEntry[], head: readonly T.TreeEntry[]): T.FileChangeSummary[] {
  const a = new Map(base.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  const b = new Map(head.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  const out: T.FileChangeSummary[] = [];
  for (const [path, e] of b) {
    const old = a.get(path);
    if (!old) out.push({ path, previousPath: null, status: "added", additions: 0, deletions: 0, patch: null, blob: e.sha });
    else if (old.sha !== e.sha) out.push({ path, previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null, blob: e.sha });
  }
  for (const [path] of a) if (!b.has(path)) out.push({ path, previousPath: null, status: "removed", additions: 0, deletions: 0, patch: null, blob: null });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** The address of a comparison in this site's viewer. */
export const comparePath = (repo: RepoCoords, spec: string): string => repoPath(repo, "compare", [spec]);

/** The words under a comparison's files when there are more than one page. */
export const moreFiles = (shown: number, total: number | null): Child =>
  total !== null && total > shown ? h("p", null, `${plural(shown, "file")} shown of ${total.toLocaleString("en-GB")}.`) : null;

/** A short description of a file for the lists: its size when known. */
export const sizeNote = (bytes: number | null): string => (bytes === null ? "" : ` (${sizeInWords(bytes)})`);

/** Whether a string names a commit id. */
export const isCommitId = (s: string): boolean => isObjectId(s);
