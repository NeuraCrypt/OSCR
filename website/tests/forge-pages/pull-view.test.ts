// The pull request pages' view trees (night phase 04, E3; src/lib/pull-view.ts): actions declared
// with the Worker's own rules and sentence, the list's rows (the state in words, no address shown),
// the closing references, a fork's row and standing; the callback's links (the creation form's
// "?expand=1" and nothing else).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { closingNotice, declarePull, forkRow, forkStatusWords, pullRow, searchRow, stateOf } from "../../src/lib/pull-view.ts";
import { textOf, type El } from "../../src/lib/repo-view.ts";
import { viewerLinks } from "../../src/scripts/forge-client.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada", name: "eeg", id: "42" };
const SHA = "a".repeat(40);

function pr(o: Partial<T.PullRequest> = {}): T.PullRequest {
  return {
    number: 7, id: "1", nodeId: null, title: "Square it (ada@example.org)", body: "", state: "open", draft: false, merged: false, mergedAt: null, mergeCommit: null,
    author: { name: "bob", login: "bob", id: "2" }, createdAt: "2026-09-20T10:00:00Z", updatedAt: "2026-09-21T10:00:00Z", closedAt: null,
    head: { repo: { forge: "github", owner: "bob", name: "eeg" }, ref: "fix", sha: SHA },
    base: { repo: { forge: "github", owner: "ada", name: "eeg" }, ref: "main", sha: "b".repeat(40) },
    mergeable: true, mergeState: "clean", requestedReviewers: ["carol"], labels: ["analysis"], assignees: [], milestone: null, autoMerge: null, maintainerCanModify: true,
    counts: { commits: 1, additions: 1, deletions: 1, changedFiles: 1, comments: 0 },
    ...o,
  };
}

function* walk(e: El): Generator<El> {
  yield e;
  for (const c of e.children) if (typeof c !== "string") yield* walk(c);
}

describe("declarePull", () => {
  test("the Worker's own sentence and target; its refusals in words", () => {
    const d = declarePull(REPO, "pull_merge", { number: 7, method: "squash", head: SHA }, "/r/ada/eeg/pull/7", { expectedHead: SHA });
    assert.ok("input" in d);
    assert.equal(d.sentence, "Merge the pull request #7 (squash and merge) at aaaaaaa.");
    assert.deepEqual(d.input.repo, { forge: "github", id: "42" });
    assert.equal(d.input.expectedHead, SHA);
    const bad = declarePull(REPO, "pull_merge", { number: 7, method: "octopus", head: SHA }, "/");
    assert.ok("problem" in bad && /merge commit, a squash or a rebase/.test(bad.problem));
    assert.ok("problem" in declarePull({ ...REPO, id: null }, "fork", {}, "/"));
    const noBase = declarePull(REPO, "pull_open", { base: "main", head: "fix", title: "x" }, "/");
    assert.ok("problem" in noBase, "pull_open needs its base as the target's branch");
    assert.ok("input" in declarePull(REPO, "pull_open", { base: "main", head: "fix", title: "x" }, "/", { branch: "main" }));
  });
});

describe("the rows", () => {
  test("a pull request: the state in a word, its page in the registry, no address shown", () => {
    const row = pullRow(REPO, pr(), true);
    const text = textOf(row);
    assert.match(text, /^Open Square it/);
    assert.ok(!text.includes("example.org"));
    assert.match(text, /#7 opened 2026-09-20 by bob · bob:fix → main · Labels: analysis · Review asked of carol/);
    const links = [...walk(row)].filter((e) => e.tag === "a").map((e) => e.attrs.href);
    assert.deepEqual(links, ["/r/ada/eeg/pull/7"]);
    assert.ok([...walk(row)].some((e) => e.tag === "input" && e.attrs.value === "7"));
    assert.equal(stateOf(pr({ merged: true, state: "closed" })).words, "Merged");
    assert.equal(stateOf(pr({ draft: true })).words, "Draft");
    assert.equal(stateOf(pr({ state: "closed" })).tone, "muted");
    assert.match(textOf(pullRow(REPO, pr({ head: { repo: { forge: "github", owner: "ada", name: "eeg" }, ref: "fix", sha: SHA } }))), / fix → main/);
    const issue = { number: 9, id: "9", nodeId: null, title: "T", body: "", state: "closed", stateReason: null, author: { name: "x", login: "x", id: null }, labels: [], assignees: [], milestone: null, locked: false, lockReason: null, pinned: null, comments: 2, reactions: {}, subIssues: null, isPullRequest: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", closedAt: null } as T.Issue;
    assert.match(textOf(searchRow(REPO, issue)), /^Closed T#9 opened 2026-01-01 by x · 2 comments$/);
  });

  test("closing references in words; a fork's row and standing", () => {
    const refs = [{ owner: "ada", name: "eeg", number: 3, keyword: "fixes" }, { owner: "ada", name: "other", number: 4, keyword: "closes" }];
    assert.match(textOf(closingNotice(refs, true, "main", REPO)), /^Merging it closes #3, ada\/other#4/);
    assert.match(textOf(closingNotice(refs, false, "dev", REPO)), /only when a pull request merges into the default branch, not dev/);
    assert.equal(closingNotice([], true, "main", REPO), null);
    const fork = { ref: { forge: "github", owner: "bob", name: "eeg" }, pushedAt: "2026-09-01T00:00:00Z", description: "Bob's copy" } as T.RepoInfo;
    assert.equal(textOf(forkRow(fork)), "bob/eeg · last pushed 2026-09-01 — Bob's copy");
    assert.equal(forkStatusWords("main", "ada/eeg:main", 0, 0), "This fork's main is even with ada/eeg:main.");
    assert.equal(forkStatusWords("main", "ada/eeg:main", 3, 0), "This fork's main is 3 commits behind ada/eeg:main.");
    assert.equal(forkStatusWords("main", "ada/eeg:main", 0, 1), "This fork's main is 1 commit ahead of ada/eeg:main.");
    assert.equal(forkStatusWords("main", "ada/eeg:main", 2, 1), "This fork's main is 1 commit ahead of, and 2 commits behind, ada/eeg:main.");
  });
});

describe("the callback's links", () => {
  test("the creation form's ?expand=1, nothing else after a path", () => {
    const ok = viewerLinks([
      { href: "/r/ada/eeg/compare/main...ada-patch-1/?expand=1", text: "Open a pull request" },
      { href: "/r/ada/eeg/pull/7", text: "The pull request" },
      { href: "/r/ada/eeg/compare/main...x/?expand=1&title=x", text: "no" },
      { href: "/r/ada/eeg/compare/main...x/?next=https://evil.example", text: "no" },
      { href: "//evil.example/r/a/b/", text: "no" },
    ]);
    assert.deepEqual(ok.map((l) => l.href), ["/r/ada/eeg/compare/main...ada-patch-1/?expand=1", "/r/ada/eeg/pull/7"]);
  });
});
