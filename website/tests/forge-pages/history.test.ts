// History, commits, diffs and comparisons in the registry's viewer (night phase 02, E3):
// src/lib/history.ts. Patches read with their line numbers, hunks computed from two texts at any
// context, whitespace ignored as git diff -w does, the split view's rows, the tables, the commit's
// header and list (email addresses masked, no link to GitHub), the .diff built here, and the
// comparisons' specs (three and two dots, forks, relative refs).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type * as T from "../../worker/forge/types.ts";
import {
  actorInWords,
  changedTree,
  commitHeader,
  commitList,
  commitsByDay,
  comparePath,
  comparisonInWords,
  diffTable,
  diffText,
  hunksOf,
  hunkStats,
  ignoreWhitespace,
  messageParts,
  parseCompare,
  parsePatch,
  parseRefSpec,
  refSpecText,
  splitRows,
  statusInWords,
  treeChanges,
  verifiedInWords,
} from "../../src/lib/history.ts";
import { type El, textOf, walk } from "../../src/lib/repo-view.ts";

const EEG = { owner: "oscr-fixture", name: "eeg-analysis" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PARENT = "fedcba9876543210fedcba9876543210fedcba98";
const EMAIL = "ada.fixture@example.org";
const hrefs = (el: El | El[]) => (Array.isArray(el) ? el : [el]).flatMap((e) => [...walk(e)].map((x) => x.attrs.href).filter(Boolean));

const PATCH = ["@@ -1,4 +1,5 @@ def f():", " a = 1", "-b = 2", "+b = 3", "+c = 4", " d = 5", " ", "@@ -10 +11,0 @@", "-gone", "\\ No newline at end of file"].join("\n");

describe("patches", () => {
  test("hunks, with each line's numbers on each side", () => {
    const hunks = parsePatch(PATCH);
    assert.equal(hunks.length, 2);
    const [a, b] = hunks;
    assert.deepEqual([a.oldStart, a.oldLines, a.newStart, a.newLines, a.section], [1, 4, 1, 5, "def f():"]);
    assert.deepEqual(a.lines.map((l) => [l.kind, l.old, l.new, l.text]), [
      ["context", 1, 1, "a = 1"],
      ["del", 2, null, "b = 2"],
      ["add", null, 2, "b = 3"],
      ["add", null, 3, "c = 4"],
      ["context", 3, 4, "d = 5"],
      ["context", 4, 5, ""],
    ]);
    assert.deepEqual(b.lines.map((l) => [l.kind, l.old, l.new]), [["del", 10, null], ["note", null, null]]);
    assert.equal(b.lines[1].text, "No newline at end of file");
    assert.deepEqual(hunkStats(hunks), { additions: 2, deletions: 2 });
    assert.deepEqual(parsePatch(null), []);
    assert.deepEqual(parsePatch("not a patch"), []);
  });

  test("hunks computed from two texts, at any context, the whole file included", () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const neu = old.replace("line 15\n", "line fifteen\n");
    const three = hunksOf(old, neu);
    assert.equal(three.length, 1);
    assert.equal(three[0].lines.length, 3 + 2 + 3);
    const twenty = hunksOf(old, neu, 20);
    assert.equal(twenty[0].lines.length, 31, "the whole file: 29 unchanged, 1 deleted, 1 added");
    const all = hunksOf(old, neu, Number.POSITIVE_INFINITY);
    assert.equal(all[0].lines.filter((l) => l.kind === "context").length, 29);
    assert.deepEqual(hunksOf("same\n", "same\n"), []);
  });

  test("whitespace ignored: a line changed only in its spaces becomes context", () => {
    const hunks = parsePatch(["@@ -1,3 +1,3 @@", "-if x:", "-  y = 1", "+if  x:", "+    y = 2", " z"].join("\n"));
    const w = ignoreWhitespace(hunks);
    assert.equal(w.length, 1);
    assert.deepEqual(w[0].lines.map((l) => [l.kind, l.text]), [
      ["context", "if  x:"],
      ["del", "  y = 1"],
      ["add", "    y = 2"],
      ["context", "z"],
    ]);
    assert.deepEqual(ignoreWhitespace(parsePatch(["@@ -1 +1 @@", "-a  b", "+a b"].join("\n"))), [], "a hunk left with no change is dropped");
  });

  test("the split view pairs each deletion with the addition at its rank", () => {
    const rows = splitRows(parsePatch(PATCH)[0]);
    assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
      ["a = 1", "a = 1"],
      ["b = 2", "b = 3"],
      [null, "c = 4"],
      ["d = 5", "d = 5"],
      ["", ""],
    ]);
  });

  test("a diff as a table: unified has three cells a row, split four; hunk headers are rows", () => {
    const hunks = parsePatch(PATCH);
    const unified = diffTable(hunks, "unified");
    assert.equal(unified.tag, "table");
    assert.equal(unified.attrs.class, "diff unified");
    const rows = [...walk(unified)].filter((e) => e.tag === "tr");
    assert.equal(rows.filter((r) => r.attrs.class === "hunk").length, 2);
    assert.ok(rows.filter((r) => r.attrs.class !== "hunk").every((r) => r.children.length === 3));
    const split = diffTable(hunks, "split");
    assert.ok([...walk(split)].filter((e) => e.tag === "tr" && e.attrs.class !== "hunk").every((r) => r.children.length === 4));
    assert.match(textOf(unified), /@@ -1,4 \+1,5 @@ def f\(\)/);
    const signs = [...walk(unified)].filter((e) => e.attrs.class === "sign").map((e) => textOf(e));
    assert.ok(signs.includes("+") && signs.includes("−"));
  });
});

describe("commits", () => {
  const commit = (o: Partial<T.CommitSummary> = {}): T.CommitSummary => ({
    sha: SHA,
    parents: [PARENT],
    tree: SHA,
    message: `Pass the band to alpha_ratio\n\nAs in Figure 2.\n\nSigned-off-by: Ada Fixture <${EMAIL}>`,
    author: { name: "Ada Fixture", login: "ada-fixture", id: "1" },
    authoredAt: "2026-09-28T10:00:00Z",
    committer: { name: "Ada Fixture", login: "ada-fixture", id: "1" },
    committedAt: "2026-09-28T10:00:00Z",
    verified: true,
    ...o,
  });

  test("a commit's header: its title, its body (masked), who, its parents, its signature in words", () => {
    const head = commitHeader(EEG, commit());
    const text = textOf(head);
    assert.match(text, /^Pass the band to alpha_ratio/);
    assert.match(text, /As in Figure 2\./);
    assert.ok(!text.includes(EMAIL));
    assert.match(text, /Signed-off-by: Ada Fixture <\[email hidden\]>/);
    assert.match(text, /Ada Fixture \(ada-fixture\) wrote it on 28 September 2026\./);
    assert.match(text, /Signed, and the signature verified by GitHub\./);
    assert.deepEqual(hrefs(head), [`/r/oscr-fixture/eeg-analysis/commit/${PARENT}/`, `/r/oscr-fixture/eeg-analysis/tree/${SHA}/`]);
    assert.match(textOf(commitHeader(EEG, commit({ parents: [], verified: null }))), /the first commit.*GitHub did not say whether it is signed/);
    assert.match(textOf(commitHeader(EEG, commit({ committer: { name: "GitHub", login: "web-flow", id: "2" }, committedAt: "2026-09-29T08:00:00Z" }))), /GitHub \(web-flow\) committed it on 29 September 2026/);
  });

  test("the list, by day, each commit its page and its files; no link to GitHub", () => {
    const items = [commit(), commit({ sha: PARENT, parents: [], message: "First", committedAt: "2026-09-27T09:00:00Z", verified: false })];
    assert.deepEqual(commitsByDay(items).map((g) => [g.day, g.items.length]), [["2026-09-28", 1], ["2026-09-27", 1]]);
    const list = commitList(EEG, items, { path: "analysis.py" });
    assert.equal(list.length, 4);
    assert.equal(list[0].tag, "h2");
    assert.equal(textOf(list[0]), "Commits on 28 September 2026");
    for (const href of hrefs(list)) assert.ok(href.startsWith("/r/oscr-fixture/eeg-analysis/"), href);
    assert.ok(hrefs(list).includes(`/r/oscr-fixture/eeg-analysis/blob/${SHA}/analysis.py`));
    assert.match(textOf(list[1]), /signed/);
  });

  test("words: people, statuses, signatures, message parts", () => {
    assert.equal(actorInWords({ name: "Ada", login: "ada", id: "1" }), "Ada (ada)");
    assert.equal(actorInWords({ name: `x ${EMAIL}`, login: null, id: null }), "x [email hidden]");
    assert.equal(actorInWords(null), "someone");
    assert.equal(statusInWords({ status: "renamed", previousPath: "old.py" }), "renamed from old.py");
    assert.equal(statusInWords({ status: "removed", previousPath: null }), "deleted");
    assert.equal(verifiedInWords(false), "Not signed, or the signature not verified.");
    assert.deepEqual(messageParts("Title\r\n\r\nBody\n"), { title: "Title", body: "Body" });
  });

  test("the changed files as a tree of links to their diffs", () => {
    const tree = changedTree([
      { path: "analysis.py", status: "modified" },
      { path: "data/subjects.csv", status: "added" },
      { path: "data/raw/old.csv", status: "removed" },
    ]);
    assert.deepEqual(hrefs(tree), ["#file-3", "#file-2", "#file-1"]);
    assert.match(textOf(tree), /3 files changed/);
    assert.match(textOf(tree), /old\.csv \(deleted\)/);
  });

  test("the .diff is built here, with git's headers, and never an email address", () => {
    const text = diffText([
      { path: "a.py", previousPath: null, status: "modified", patch: `@@ -1 +1 @@\n-x = 1\n+x = 2  # ${EMAIL}` },
      { path: "img.png", previousPath: null, status: "added", patch: null },
      { path: "new.py", previousPath: "old.py", status: "renamed", patch: "" },
    ]);
    assert.match(text, /^diff --git a\/a\.py b\/a\.py\n--- a\/a\.py\n\+\+\+ b\/a\.py\n@@ -1 \+1 @@/);
    assert.match(text, /Binary files \/dev\/null and b\/img\.png differ/);
    assert.match(text, /rename from old\.py\nrename to new\.py/);
    assert.ok(!text.includes(EMAIL));
  });
});

describe("comparisons", () => {
  test("three dots, two dots, forks, relative refs", () => {
    assert.deepEqual(parseCompare("main...feature/x", "main"), {
      base: { owner: null, repo: null, ref: "main", ancestry: [] },
      head: { owner: null, repo: null, ref: "feature/x", ancestry: [] },
      dots: 3,
    });
    assert.equal(parseCompare("v1.0..main", "main")?.dots, 2);
    assert.deepEqual(parseCompare("feature", "main")?.base.ref, "main", "a lone ref is compared with the default branch");
    assert.deepEqual(parseRefSpec("ada:eeg-fork:feature"), { owner: "ada", repo: "eeg-fork", ref: "feature", ancestry: [] });
    assert.deepEqual(parseRefSpec("ada:feature"), { owner: "ada", repo: null, ref: "feature", ancestry: [] });
    assert.deepEqual(parseRefSpec("main~3"), { owner: null, repo: null, ref: "main", ancestry: [["~", 3]] });
    assert.deepEqual(parseRefSpec("v1.0^^"), { owner: null, repo: null, ref: "v1.0", ancestry: [["^", 1], ["^", 1]] });
    assert.deepEqual(parseRefSpec("HEAD^2~1")?.ancestry, [["^", 2], ["~", 1]]);
    for (const bad of ["", "a:b:c:d", "ma..in", "/x", "x/", "a b", "main~999", "bad owner!:x", "x;rm"]) assert.equal(parseRefSpec(bad), null, bad);
    assert.equal(parseCompare("a...b...c", "main"), null);
    assert.equal(refSpecText(parseRefSpec("ada:eeg-fork:v1.0~2")!), "ada:eeg-fork:v1.0~2");
    assert.equal(comparePath(EEG, "main...feature/x"), "/r/oscr-fixture/eeg-analysis/compare/main...feature/x/");
  });

  test("how head stands against base, in words", () => {
    assert.equal(comparisonInWords({ status: "ahead", aheadBy: 2, behindBy: 0 }, "main", "dev"), "dev is 2 commits ahead of main.");
    assert.equal(comparisonInWords({ status: "identical", aheadBy: 0, behindBy: 0 }, "main", "dev"), "dev and main are the same commit.");
    assert.equal(comparisonInWords({ status: "diverged", aheadBy: 1, behindBy: 3 }, "main", "dev"), "dev and main have diverged: dev is 1 commit ahead of main, and 3 commits behind.");
    assert.equal(comparisonInWords({ status: "behind", aheadBy: 0, behindBy: 4 }, "main", "dev"), "dev is 4 commits behind main, with nothing new.");
  });

  test("two dots: the files that differ between two trees", () => {
    const e = (path: string, sha: string): T.TreeEntry => ({ path, mode: "100644", type: "blob", sha: sha.repeat(40).slice(0, 40), size: 1 });
    const changes = treeChanges([e("a.py", "1"), e("b.py", "2"), e("gone.py", "3")], [e("a.py", "1"), e("b.py", "4"), e("new.py", "5")]);
    assert.deepEqual(changes.map((c) => [c.path, c.status]), [["b.py", "modified"], ["gone.py", "removed"], ["new.py", "added"]]);
  });
});
