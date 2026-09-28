// Line diffs, unified patches and three-way merges (worker/forge/diff.ts), on fixtures whose
// answers are git's, and on random texts: a patch applied to the old text gives the new one, and
// the edit script is as short as the longest common subsequence allows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diff3, diffLines, fileDiff, lineStats, merge3, patch, splitLines } from "../../worker/forge/diff.ts";

/** Apply unified hunks (as `patch` writes them) to a text. */
function apply(old: string, hunks: string): string {
  if (!hunks) return old;
  const src = splitLines(old);
  const out: string[] = [];
  let at = 0;
  // Whether the new text's last line so far came from a hunk, and then whether it lacks "\n".
  let fromHunk = false;
  let noEol = false;
  const lines = hunks.split("\n");
  for (let i = 0; i < lines.length; ) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[i]);
    assert.ok(m, `a hunk header: ${lines[i]}`);
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const from = oldCount === 0 ? oldStart : oldStart - 1;
    while (at < from) {
      out.push(src.lines[at++]);
      fromHunk = false;
    }
    i++;
    for (; i < lines.length && !lines[i].startsWith("@@"); i++) {
      const l = lines[i];
      const marked = i + 1 < lines.length && lines[i + 1].startsWith("\\");
      if (l.startsWith("\\")) continue;
      if (l.startsWith(" ")) {
        assert.equal(src.lines[at], l.slice(1));
        out.push(src.lines[at++]);
      } else if (l.startsWith("-")) {
        assert.equal(src.lines[at], l.slice(1));
        at++;
        continue;
      } else if (l.startsWith("+")) {
        out.push(l.slice(1));
      }
      fromHunk = true;
      noEol = marked;
    }
  }
  while (at < src.lines.length) {
    out.push(src.lines[at++]);
    fromHunk = false;
  }
  if (!out.length) return "";
  const finalNewline = fromHunk ? !noEol : src.finalNewline;
  return out.join("\n") + (finalNewline ? "\n" : "");
}

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const randomText = (): string => {
  const n = Math.floor(random() * 12);
  const lines = Array.from({ length: n }, () => "abcd"[Math.floor(random() * 4)]);
  return lines.join("\n") + (n && random() < 0.8 ? "\n" : "");
};

test("writes hunks as git does", () => {
  assert.equal(patch("a\nb\nc\n", "a\nB\nc\n"), "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  assert.equal(patch("", "x\ny\n"), "@@ -0,0 +1,2 @@\n+x\n+y");
  assert.equal(patch("x\n", ""), "@@ -1 +0,0 @@\n-x");
  assert.equal(patch("a", "a\n"), "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a");
  assert.equal(patch("same\n", "same\n"), "");
  const old = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const changed = old.replace("l2\n", "L2\n").replace("l10\n", "L10\n");
  assert.equal(
    patch(old, changed),
    "@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n@@ -7,6 +7,6 @@\n l7\n l8\n l9\n-l10\n+L10\n l11\n l12",
  );
  const touching = old.replace("l2\n", "L2\n").replace("l9\n", "L9\n");
  assert.equal(patch(old, touching).split("\n").filter((l) => l.startsWith("@@")).length, 1, "hunks whose contexts touch are one");
});

test("counts the lines added and removed", () => {
  assert.deepEqual(lineStats("a\nb\n", "a\nc\nd\n"), { additions: 2, deletions: 1 });
  assert.deepEqual(lineStats("", ""), { additions: 0, deletions: 0 });
});

test("gives edit scripts as short as possible, whose patches rebuild the new text", () => {
  for (let n = 0; n < 400; n++) {
    const a = randomText();
    const b = randomText();
    const la = splitLines(a).lines;
    const lb = splitLines(b).lines;
    const ops = diffLines(la, lb);
    assert.equal(ops.filter((o) => o.kind === "equal").length, lcs(la, lb), `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    let ia = 0;
    let ib = 0;
    for (const o of ops) {
      if (o.kind === "equal") {
        assert.equal(o.a, ia++);
        assert.equal(o.b, ib++);
      } else if (o.kind === "delete") assert.equal(o.a, ia++);
      else assert.equal(o.b, ib++);
    }
    assert.equal(ia, la.length);
    assert.equal(ib, lb.length);
    assert.equal(apply(a, patch(a, b)), b, `${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
});

test("writes a file's diff with git's header", () => {
  assert.equal(fileDiff({ old: "m.py", new: "m.py" }, "a\n", "b\n"), "diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1 +1 @@\n-a\n+b\n");
  assert.match(fileDiff({ old: null, new: "new.txt" }, null, "x\n"), /^diff --git a\/new.txt b\/new.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new.txt\n/);
  assert.match(fileDiff({ old: "fig.png", new: "fig.png" }, "", "", true), /Binary files a\/fig.png and b\/fig.png differ/);
});

test("merges three versions: separate edits merge, the same line edited twice conflicts", () => {
  const base = "one\ntwo\nthree\nfour\nfive\n";
  const clean = merge3(base, "ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\n");
  assert.deepEqual(clean, { clean: true, conflicts: 0, text: "ONE\ntwo\nthree\nfour\nFIVE\n" });
  const same = merge3(base, "one\nTWO\nthree\nfour\nfive\n", "one\nTWO\nthree\nfour\nfive\n");
  assert.equal(same.text, "one\nTWO\nthree\nfour\nfive\n");
  const clash = merge3(base, "one\n2 (ours)\nthree\nfour\nfive\n", "one\n2 (theirs)\nthree\nfour\nfive\n", { ours: "main", base: "base", theirs: "feature" });
  assert.equal(clash.clean, false);
  assert.equal(clash.conflicts, 1);
  assert.equal(clash.text, "one\n<<<<<<< main\n2 (ours)\n||||||| base\ntwo\n=======\n2 (theirs)\n>>>>>>> feature\nthree\nfour\nfive\n");
  const chunks = diff3(["a", "b", "c"], ["a", "B", "c"], ["a", "b", "c", "d"]);
  assert.deepEqual(chunks, [
    { kind: "stable", lines: ["a"] },
    { kind: "ours", lines: ["B"] },
    { kind: "stable", lines: ["c"] },
    { kind: "theirs", lines: ["d"] },
  ]);
});
