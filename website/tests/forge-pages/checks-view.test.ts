// The checks of a commit in the repository's pages (night phase 10, E5; src/lib/checks-view.ts): the
// workflows read as text (never run), the environments they test in words, the registry's findings, the
// researcher's CI as GitHub reports it, the statuses posted to the registry, the papers' cited commits.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runChecks } from "../../worker/forge/checks-core.ts";
import { citedCommits, ciView, findingsView, postedView, readWorkflow, testedEnvironments, workflowPaths, workflowsView } from "../../src/lib/checks-view.ts";
import { textOf } from "../../src/lib/repo-view.ts";
import type * as T from "../../worker/forge/types.ts";
import { parseRepoPath, repoPath } from "../../src/lib/forge.ts";

const WORKFLOW = `name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        python-version: ["3.10", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
      - run: python -m pytest
  r:
    runs-on: ubuntu-latest
    container: rocker/r-ver:4.3.1
    steps:
      - run: Rscript -e 'testthat::test_dir("tests")'
`;

describe("workflows, read as text", () => {
  test("the workflow files of a tree", () => {
    assert.deepEqual(workflowPaths(["README.md", ".github/workflows/b.yaml", ".github/workflows/a.yml", ".github/workflows/sub/c.yml", ".github/actions/x.yml"]), [".github/workflows/a.yml", ".github/workflows/b.yaml"]);
  });

  test("a workflow as data: its name, triggers, jobs, runners, matrix, container, actions", () => {
    const w = readWorkflow(".github/workflows/tests.yml", WORKFLOW)!;
    assert.equal(w.name, "Tests");
    assert.deepEqual(w.triggers, ["push", "pull_request"]);
    assert.deepEqual(w.jobs.map((j) => j.id), ["test", "r"]);
    assert.deepEqual(w.jobs[0].matrix, [{ key: "os", values: ["ubuntu-latest", "macos-latest"] }, { key: "python-version", values: ["3.10", "3.12"] }]);
    assert.deepEqual(w.jobs[0].uses, ["actions/checkout@v4", "actions/setup-python@v5"]);
    assert.equal(w.jobs[1].container, "rocker/r-ver:4.3.1");
    assert.deepEqual(testedEnvironments([w]), ["Systems: ubuntu-latest, macos-latest.", "Python: 3.10, 3.12.", "Containers: rocker/r-ver:4.3.1."]);
    assert.equal(readWorkflow("x.yml", ""), null);
    const text = textOf(workflowsView([w]));
    assert.match(text, /Tests \(\.github\/workflows\/tests\.yml\): started by push, pull_request; 2 jobs/);
    assert.match(text, /never run here/);
    assert.match(textOf(workflowsView([])), /No GitHub Actions workflow/);
  });
});

describe("the address", () => {
  test("checks/<ref> in the one /r/ shell: a branch, a commit, the default branch", () => {
    assert.deepEqual(parseRepoPath("/r/ada/eeg/checks/main"), { owner: "ada", name: "eeg", view: "checks", rest: ["main"] });
    assert.deepEqual(parseRepoPath("/r/ada/eeg/checks/"), { owner: "ada", name: "eeg", view: "checks", rest: [] });
    const sha = "a".repeat(40);
    assert.equal(repoPath({ owner: "ada", name: "eeg" }, "checks", [sha]), `/r/ada/eeg/checks/${sha}/`);
  });
});

describe("the views", () => {
  test("the registry's findings: each check in words, with the way out; never run", () => {
    const report = runChecks({ entries: [{ path: "a.py", type: "blob", size: 10 }], truncated: false, texts: {}, papers: [], traced: [] });
    const text = textOf(findingsView(report));
    assert.match(text, /Licence: to look at\. No licence file/);
    assert.match(text, /never run its code/);
  });

  test("the researcher's CI: runs and statuses counted, the logs at the source, said why", () => {
    const run = (name: string, conclusion: T.CheckRun["conclusion"]): T.CheckRun => ({ id: "1", name, headSha: "a".repeat(40), status: "completed", conclusion, startedAt: null, completedAt: null, detailsUrl: null, app: null, output: { title: "", summary: "", annotations: 0 } });
    assert.match(textOf(ciView([run("Research code checks", "neutral")], null, "https://github.com/o/r")), /the registry's checks, posted by its App on GitHub/);
    const el = ciView([run("tests", "success"), run("lint", "failure")], { state: "pending", statuses: [{ context: "ci/lab", state: "pending", description: "", targetUrl: null }] }, "https://github.com/o/r/commit/abc/checks");
    const text = textOf(el);
    assert.match(text, /1 passed, 1 failed, 1 running/);
    assert.match(text, /tests: passed/);
    assert.match(text, /asks for a sign-in to download them/);
    assert.match(textOf(ciView([], null, "https://github.com/o/r")), /No test reported/);
  });

  test("the statuses posted to the registry: signed out, none, some", () => {
    assert.match(textOf(postedView(null, false)), /Sign in to see/);
    assert.match(textOf(postedView({ state: null, statuses: [] }, true)), /None: no outside service/);
    const text = textOf(postedView({ state: "success", statuses: [{ context: "repro/figure-2", state: "success", description: "matches", target_url: "https://repro.example/1", by: "GitHub Actions: Tests", via: "oidc", at: "2026-09-29T10:00:00Z" }] }, true));
    assert.match(text, /repro\/figure-2: passed — matches — posted by GitHub Actions: Tests \(GitHub Actions, its own token\), 2026-09-29/);
  });

  test("the papers' cited commits, once each", () => {
    const maps = [
      { paper: "eeg", title: "EEG", doi: "10.1/a", commit: "a".repeat(40) },
      { paper: "eeg", title: "EEG", doi: "10.1/a", commit: "a".repeat(40) },
      { paper: "meg", title: "", doi: "10.1/b", commit: "b".repeat(40) },
      { paper: "x", title: "X", doi: "10.1/c", commit: "not-a-commit" },
      { paper: "z", title: "Z", doi: "10.1/z", commit: "0".repeat(40) },
    ];
    assert.deepEqual(citedCommits(maps), [{ paper: "eeg", title: "EEG", commit: "a".repeat(40) }, { paper: "meg", title: "10.1/b", commit: "b".repeat(40) }]);
  });
});
