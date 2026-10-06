// A pull request's conflicts resolved in the browser (night phase 04, E6; src/lib/conflicts.ts):
// which files merge here and which do not, one file's conflicts and their choices, the markers,
// the commit's limits and the command line.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chosen, commandLine, hasMarkers, mergeFile, mergePlan, resolutionFits, resolutionMessage, resolveFile, withMarkers } from "../../src/lib/conflicts.ts";
import type * as T from "../../worker/forge/types.ts";

const f = (path: string, status: T.FileStatus = "modified", o: Partial<T.FileChangeSummary> = {}): T.FileChangeSummary => ({ path, previousPath: null, status, additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b", blob: null, ...o });

describe("the plan", () => {
  test("both sides: merged here; the base's alone: taken; deletions, renames and binaries: said", () => {
    const plan = mergePlan(
      [f("a.py"), f("gone.py"), f("new.py", "renamed", { previousPath: "old.py" }), f("fig.png", "modified", { patch: null }), f("mine.py")],
      [f("a.py"), f("gone.py", "removed"), f("old.py"), f("fig.png", "modified", { patch: null }), f("theirs.py"), f("dropped.py", "removed"), f("moved.py", "renamed", { previousPath: "was.py" })],
    );
    assert.deepEqual(plan.both, ["a.py"]);
    assert.deepEqual(plan.theirs.map((x) => [x.path, x.status]), [["theirs.py", "modified"], ["dropped.py", "removed"], ["moved.py", "renamed"]]);
    assert.equal(plan.problems.length, 3);
    assert.match(plan.problems[0], /gone\.py was deleted on one side/);
    assert.match(plan.problems[1], /renamed/);
    assert.match(plan.problems[2], /binary/);
  });
});

describe("one file", () => {
  const base = "a\nb\nc\nd\ne\n";
  const ours = "a\nB (pr)\nc\nd\ne\nf\n";
  const theirs = "a\nB (main)\nc\nD\ne\n";

  test("the conflicts found; the rest merged as git does", () => {
    const m = mergeFile("x.py", base, ours, theirs);
    assert.equal(m.conflicts, 1);
    assert.equal(resolveFile(m, [null]), null);
    assert.equal(resolveFile(m, ["ours"]), "a\nB (pr)\nc\nD\ne\nf\n");
    assert.equal(resolveFile(m, ["theirs"]), "a\nB (main)\nc\nD\ne\nf\n");
    assert.equal(resolveFile(m, ["ours-then-theirs"]), "a\nB (pr)\nB (main)\nc\nD\ne\nf\n");
    assert.equal(resolveFile(m, [{ lines: ["B (both)"] }]), "a\nB (both)\nc\nD\ne\nf\n");
    const conflict = m.chunks.find((c) => c.kind === "conflict");
    assert.ok(conflict && conflict.kind === "conflict");
    assert.deepEqual(chosen(conflict, "theirs-then-ours"), ["B (main)", "B (pr)"]);
  });

  test("line endings kept; markers written and found", () => {
    const m = mergeFile("w.txt", "a\r\nb\r\n", "a\r\nX\r\n", "a\r\nY\r\n");
    assert.equal(resolveFile(m, ["theirs"]), "a\r\nY\r\n");
    const marked = withMarkers(m, { ours: "fix", theirs: "main" });
    assert.equal(marked, "a\r\n<<<<<<< fix\r\nX\r\n=======\r\nY\r\n>>>>>>> main\r\n");
    assert.equal(hasMarkers(marked), true);
    assert.equal(hasMarkers("a\n==== not a marker\nb"), false);
    assert.equal(mergeFile("same.py", base, ours, ours).conflicts, 0);
  });
});

describe("the commit", () => {
  test("its message, its limits, the command line", () => {
    assert.equal(resolutionMessage("main", "fix"), "Merge branch 'main' into fix");
    assert.equal(resolutionFits([{ op: "put", path: "a", text: "x" }]), null);
    assert.match(String(resolutionFits(Array.from({ length: 101 }, (_, i) => ({ op: "delete" as const, path: `f${i}` })))), /at most 100/);
    assert.match(String(resolutionFits([{ op: "put", path: "big", text: "x".repeat(1_000_000) }])), /1 MiB/);
    assert.deepEqual(commandLine({ baseRepo: "ada/eeg", base: "main", headRepo: "bob/eeg", head: "fix" }).slice(0, 3), ["git clone https://github.com/bob/eeg.git && cd eeg", "git checkout fix", "git pull https://github.com/ada/eeg.git main"]);
    assert.equal(commandLine({ baseRepo: "ada/eeg", base: "main", headRepo: "ada/eeg", head: "fix" })[2], "git merge origin/main");
  });
});
