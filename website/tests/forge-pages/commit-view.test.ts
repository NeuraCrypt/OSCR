// The commit dialog's pure part (night phase 03, E3; src/lib/commit-view.ts): the commit declared
// with the Worker's own rules and sentence, where GitHub's answer comes back to, and the research
// link: the tracing-map links a change touches, said before the commit.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commitBack, declareCommit, mapNotice, touchedLinks, type FileTouch } from "../../src/lib/commit-view.ts";
import type { Located, TracedMap } from "../../src/lib/traced.ts";
import { describeCommit, validateCommit, type CommitParsed } from "../../worker/forge/service/act-commit.ts";

const REPO = { owner: "oscr-fixture", name: "eeg-analysis", id: "4242" };
const HEAD = "a".repeat(40);
const payload = { branch: "main", base: HEAD, message: "Fix the band edges", changes: [{ op: "put" as const, path: "analysis.py", text: "x\n" }] };

const text = (n: { tag: string; children: unknown[] } | string | null): string =>
  n === null ? "" : typeof n === "string" ? n : n.children.map((c) => text(c as never)).join("");

describe("the commit, declared", () => {
  test("the Worker's own sentence and target: the repository by id, the branch and the head seen", () => {
    const d = declareCommit(REPO, payload, "/r/oscr-fixture/eeg-analysis/edit/main/analysis.py");
    assert.ok("input" in d);
    assert.equal(d.sentence, `${describeCommit(validateCommit(payload) as CommitParsed)}.`);
    assert.equal(d.sentence, "Commit “Fix the band edges” to the branch main (1 file written).");
    assert.deepEqual(d.input.repo, { forge: "github", id: "4242" });
    assert.equal(d.input.kind, "commit");
    assert.equal(d.input.branch, "main");
    assert.equal(d.input.expectedHead, HEAD);
    const byPath = declareCommit({ ...REPO, id: null }, payload, "/x/");
    assert.ok("input" in byPath);
    assert.deepEqual(byPath.input.repo, { forge: "github", owner: "oscr-fixture", name: "eeg-analysis" });
  });

  test("a payload the Worker would refuse is said on the page", () => {
    const d = declareCommit(REPO, { ...payload, changes: [{ op: "put", path: ".git/hooks/x", text: "" }] }, "/x/");
    assert.ok("problem" in d);
    assert.match(d.problem, /path/);
  });

  test("GitHub's answer comes back to the editor, when its address is one a return may carry", () => {
    assert.equal(commitBack(REPO, "/r/oscr-fixture/eeg-analysis/edit/main/analysis.py"), "/r/oscr-fixture/eeg-analysis/edit/main/analysis.py");
    assert.equal(commitBack(REPO, "/r/oscr-fixture/eeg-analysis/edit/main/a%20b.py"), "/r/oscr-fixture/eeg-analysis/");
  });
});

describe("the tracing-map links a change touches", () => {
  const map: TracedMap = { paper: "eeg-paper", title: "Band power in resting EEG", doi: "10.5555/x", commit: HEAD, method: "rules", validated: false, mapDoi: null, pairs: [] };
  const located = (start: number, end: number, pair = 1): Located => ({
    map,
    pair: { pair, path: "analysis.py", start, end, section: "Methods › Spectral analysis", paragraph: 3, symbol: "band_power" },
    lines: { start, end },
    how: "exact",
  });
  const before = "a\nb\nc\nd\ne\n";

  test("changed lines, moved and deleted files; untouched ranges stay out", () => {
    const edit: FileTouch = { path: "analysis.py", kind: "edit", before, after: before.replace("c", "C"), located: [located(2, 3), located(5, 5, 2)] };
    assert.deepEqual(touchedLinks([edit]).map((t) => [t.located.pair.pair, t.why]), [[1, "lines"]]);
    const moved: FileTouch = { path: "analysis.py", kind: "move", before, after: before, to: "src/analysis.py", located: [located(2, 3)] };
    assert.deepEqual(touchedLinks([moved]).map((t) => t.why), ["moved"]);
    const gone: FileTouch = { path: "analysis.py", kind: "delete", located: [located(2, 3), located(5, 5, 2)] };
    assert.deepEqual(touchedLinks([gone]).map((t) => t.why), ["deleted", "deleted"]);
    const lost: FileTouch = { path: "analysis.py", kind: "edit", before, after: before, located: [{ ...located(2, 3), lines: null, how: "lost" }] };
    assert.equal(touchedLinks([lost]).length, 1);
  });

  test("the notice names the paper, the paragraph and the lines, and what a new branch keeps", () => {
    const n = mapNotice(touchedLinks([{ path: "analysis.py", kind: "edit", before, after: before.replace("b", "B"), located: [located(2, 3)] }]), "main");
    const said = text(n as never);
    assert.match(said, /touches a link of a tracing map/);
    assert.match(said, /analysis\.py, lines 2 to 3: Paragraph 3 of Methods › Spectral analysis of Band power in resting EEG, lines 2 to 3 change\./);
    assert.match(said, /keeps pointing at its own commit/);
    assert.equal(mapNotice([], "main"), null);
  });
});
