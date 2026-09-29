// The pull requests' pure library (night phase 04, E2; src/lib/pulls.ts): addresses, the list's
// query, references and closing keywords, the merge box in words, GitHub's default messages, the
// change summary, suggestions, comment anchors, what the browser keeps, templates and prefill, and
// the reviewers suggested.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCodeowners } from "../../src/lib/codeowners.ts";
import { isDraftKey, parseRepoPath, repoPath } from "../../src/lib/forge.ts";
import { hunksOf } from "../../src/lib/history.ts";
import {
  applySuggestions,
  changeSummary,
  checksSummary,
  chosenTemplate,
  closesOnMerge,
  closingRefs,
  commentable,
  commentRange,
  defaultMergeMessage,
  defaultTitle,
  findTemplates,
  isViewed,
  issueRefs,
  matchPull,
  mergeBox,
  newPullPath,
  parsePullQuery,
  parsePullTarget,
  planQuery,
  prefillOf,
  pullPath,
  pullsPath,
  readPendingReview,
  readViewed,
  reviewKey,
  researchTemplate,
  reviewsSummary,
  searchQuery,
  suggestionBody,
  suggestionOf,
  suggestionsOf,
  suggestReviewers,
  summaryInWords,
  writePendingReview,
  writeViewed,
} from "../../src/lib/pulls.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada", name: "eeg" };
const SHA = "a".repeat(40);

function pr(o: Partial<T.PullRequest> = {}): T.PullRequest {
  return {
    number: 7,
    id: "1",
    nodeId: null,
    title: "Square the band power",
    body: "Fixes #3.",
    state: "open",
    draft: false,
    merged: false,
    mergedAt: null,
    mergeCommit: null,
    author: { name: "ada", login: "ada", id: "1" },
    createdAt: "2026-09-20T10:00:00Z",
    updatedAt: "2026-09-21T10:00:00Z",
    closedAt: null,
    head: { repo: { forge: "github", owner: "bob", name: "eeg" }, ref: "fix", sha: SHA },
    base: { repo: { forge: "github", owner: "ada", name: "eeg" }, ref: "main", sha: "b".repeat(40) },
    mergeable: true,
    mergeState: "clean",
    requestedReviewers: [],
    labels: [],
    assignees: [],
    milestone: null,
    autoMerge: null,
    maintainerCanModify: true,
    counts: { commits: 1, additions: 1, deletions: 1, changedFiles: 1, comments: 0 },
    ...o,
  };
}

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe("addresses", () => {
  test("GitHub's shapes after /r/<owner>/<name>/", () => {
    assert.deepEqual(parseRepoPath("/r/ada/eeg/pulls"), { owner: "ada", name: "eeg", view: "pulls", rest: [] });
    assert.deepEqual(parseRepoPath("/r/ada/eeg/pull/12/files"), { owner: "ada", name: "eeg", view: "pull", rest: ["12", "files"] });
    assert.deepEqual(parseRepoPath("/r/ada/eeg/fork"), { owner: "ada", name: "eeg", view: "fork", rest: [] });
    assert.equal(parseRepoPath("/r/ada/eeg/pulls/x"), null);
    assert.deepEqual(parsePullTarget(["12"]), { number: 12, tab: "conversation" });
    assert.deepEqual(parsePullTarget(["12", "changes"]), { number: 12, tab: "files" });
    assert.deepEqual(parsePullTarget(["new", "feature", "x"]), { newFrom: "feature/x" });
    assert.equal(parsePullTarget(["012"]), null);
    assert.equal(parsePullTarget(["12", "blame"]), null);
    assert.equal(pullPath(REPO, 12), "/r/ada/eeg/pull/12");
    assert.equal(pullPath(REPO, 12, "files"), "/r/ada/eeg/pull/12/files");
    assert.equal(pullsPath(REPO, "is:pr is:closed"), "/r/ada/eeg/pulls/?q=is%3Apr+is%3Aclosed");
    assert.equal(repoPath(REPO, "forks"), "/r/ada/eeg/forks/");
    assert.equal(newPullPath(REPO, "main", "bob:fix"), "/r/ada/eeg/compare/main...bob%3Afix/?expand=1");
  });
});

describe("the list's query", () => {
  test("qualifiers, negation, OR and parentheses", () => {
    const q = parsePullQuery('is:pr is:open author:ada -label:"work in progress" (base:main OR base:dev) band');
    assert.deepEqual(q.errors, []);
    const yes = pr({ labels: [] });
    assert.equal(matchPull(yes, q.node), true);
    assert.equal(matchPull(pr({ labels: ["Work in progress"] }), q.node), false);
    assert.equal(matchPull(pr({ base: { ...yes.base, ref: "release" } }), q.node), false);
    assert.equal(matchPull(pr({ author: { name: "bob", login: "bob", id: "2" } }), q.node), false);
    assert.equal(matchPull(pr({ title: "Other" }), q.node), false);
    assert.equal(matchPull(pr(), parsePullQuery("review-requested:@me").node, { me: "carol" }), false);
    assert.equal(matchPull(pr({ requestedReviewers: ["carol"] }), parsePullQuery("review-requested:@me").node, { me: "carol" }), true);
    assert.equal(matchPull(pr({ merged: true, state: "closed" }), parsePullQuery("is:merged").node), true);
    assert.equal(matchPull(pr({ draft: true }), parsePullQuery("draft:false").node), false);
    assert.equal(matchPull(pr(), parsePullQuery("created:>=2026-09-20 updated:2026-09-01..2026-09-30").node), true);
    assert.equal(matchPull(pr(), parsePullQuery("created:<2026-09-20").node), false);
    assert.equal(matchPull(pr(), parsePullQuery("no:label no:assignee").node), true);
    assert.equal(matchPull(pr(), parsePullQuery("head:bob:fix").node), true);
    assert.deepEqual(parsePullQuery("colour:red (x").errors.length, 2);
  });

  test("the plan: the list endpoint when it can, GitHub's search when it must", () => {
    assert.deepEqual(planQuery(parsePullQuery("is:pr is:open base:main sort:updated-asc")), { state: "open", base: "main", head: null, sort: "updated", direction: "asc", search: false });
    assert.equal(planQuery(parsePullQuery("is:merged")).state, "closed");
    assert.equal(planQuery(parsePullQuery("is:open OR is:closed")).state, "all");
    assert.equal(planQuery(parsePullQuery("review:approved")).search, true);
    assert.equal(planQuery(parsePullQuery("reviewed-by:bob")).search, true);
    assert.equal(searchQuery("review:approved"), "is:pr review:approved");
    assert.equal(searchQuery("is:pr review:none"), "is:pr review:none");
  });
});

describe("references", () => {
  test("closing keywords, one per reference; plain mentions; code left out", () => {
    const refs = issueRefs("Fixes #3, closes ada/other#4 and resolves https://github.com/ada/eeg/issues/5. See #6. `fixes #9`\n```\nfixes #10\n```", REPO);
    assert.deepEqual(refs.map((r) => [`${r.owner}/${r.name}#${r.number}`, r.keyword]), [
      ["ada/eeg#3", "fixes"],
      ["ada/other#4", "closes"],
      ["ada/eeg#5", "resolves"],
      ["ada/eeg#6", null],
    ]);
    assert.deepEqual(closingRefs(["Fixes #3", "Resolved: #3", "See #8"], REPO).map((r) => r.number), [3]);
    assert.equal(issueRefs("color#3 abc#4", REPO).length, 0);
    assert.equal(closesOnMerge(pr(), "main"), true);
    assert.equal(closesOnMerge(pr({ base: { ...pr().base, ref: "dev" } }), "main"), false);
  });
});

describe("the merge box", () => {
  const run = (conclusion: T.CheckConclusion | null, status: T.CheckStatus = "completed"): T.CheckRun => ({ id: "1", name: "tests", headSha: SHA, status, conclusion, startedAt: null, completedAt: null, detailsUrl: null, app: null, output: { title: "", summary: "", annotations: 0 } });
  const review = (login: string, state: T.Review["state"], at: string): T.Review => ({ id: at, author: { name: login, login, id: null }, state, body: "", commit: SHA, submittedAt: at });

  test("checks and reviews counted; each reviewer's last decisive review", () => {
    const c = checksSummary([run("success"), run("failure"), run(null, "in_progress")], { state: "pending", statuses: [{ context: "ci", state: "success", description: "", targetUrl: null }] });
    assert.deepEqual(c, { total: 4, passed: 2, failed: 1, running: 1, skipped: 0 });
    const r = reviewsSummary([review("bob", "CHANGES_REQUESTED", "1"), review("bob", "COMMENTED", "2"), review("carol", "APPROVED", "3"), review("ada", "APPROVED", "4"), review("dan", "COMMENTED", "5")], ["erin", "carol"], "ada");
    assert.deepEqual(r, { approved: ["carol"], changesRequested: ["bob"], commented: ["dan"], requested: ["erin"] });
  });

  test("the states in words", () => {
    assert.match(mergeBox(pr(), null, null).status, /can be merged: no conflicts/);
    assert.equal(mergeBox(pr(), null, null).tone, "ok");
    const dirty = mergeBox(pr({ mergeable: false, mergeState: "dirty" }), null, null);
    assert.equal(dirty.conflicts, true);
    assert.equal(dirty.mergeable, false);
    assert.match(dirty.status, /conflicts with main/);
    assert.match(mergeBox(pr({ mergeable: null, mergeState: "unknown" }), null, null).status, /still checking/);
    assert.match(mergeBox(pr({ draft: true, mergeState: "draft" }), null, null).status, /draft/);
    assert.equal(mergeBox(pr({ mergeState: "behind" }), null, null).behind, true);
    assert.match(mergeBox(pr({ mergeState: "blocked" }), null, null).status, /blocked/);
    const failing = mergeBox(pr(), { total: 1, passed: 0, failed: 1, running: 0, skipped: 0 }, { approved: [], changesRequested: [], commented: [], requested: ["bob"] });
    assert.equal(failing.tone, "warning");
    assert.deepEqual(failing.lines, ["Review asked of bob.", "Checks of its last commit: 1 failed."]);
    assert.match(mergeBox(pr({ merged: true, state: "closed", mergedAt: "2026-09-22T00:00:00Z" }), null, null).status, /^Merged into main on 2026-09-22/);
    assert.match(mergeBox(pr({ state: "closed" }), null, null).status, /^Closed without merging/);
  });

  test("GitHub's default merge messages", () => {
    assert.deepEqual(defaultMergeMessage(pr(), "merge"), { title: "Merge pull request #7 from bob/fix", message: "Square the band power" });
    assert.deepEqual(defaultMergeMessage(pr(), "squash", [{ message: "One\n\nbody" }, { message: "Two" }]), { title: "Square the band power (#7)", message: "* One\n* Two" });
    assert.deepEqual(defaultMergeMessage(pr(), "rebase"), { title: "", message: "" });
    assert.equal(defaultTitle("ada-patch-1", []), "Ada patch 1");
    assert.equal(defaultTitle("bob:fix/band_power", [{ message: "a" }, { message: "b" }]), "Band power");
    assert.equal(defaultTitle("x", [{ message: "Square it\n\nbecause" }]), "Square it");
  });
});

describe("the change summary", () => {
  test("lines per language, notebooks, data, licence, environment, citation, workflows", () => {
    const lang = (p: string) => (p.endsWith(".py") ? "Python" : p.endsWith(".R") ? "R" : null);
    const s = changeSummary(
      [
        { path: "src/a.py", additions: 10, deletions: 2 },
        { path: "fig.ipynb", additions: 30, deletions: 0 },
        { path: "data/x.csv", additions: 100, deletions: 0 },
        { path: "LICENSE", additions: 1, deletions: 1 },
        { path: "environment.yml", additions: 1, deletions: 0 },
        { path: "CITATION.cff", additions: 2, deletions: 0 },
        { path: ".github/workflows/test.yml", additions: 3, deletions: 0 },
        { path: "b.R", additions: 1, deletions: 1 },
      ],
      lang,
    );
    assert.equal(s.files, 8);
    assert.deepEqual(s.languages[0], { language: "Other", lines: 108 });
    assert.deepEqual(s.notebooks, ["fig.ipynb"]);
    assert.deepEqual(s.data, ["data/x.csv"]);
    assert.deepEqual(s.licence, ["LICENSE"]);
    assert.deepEqual(s.dependencies, ["environment.yml"]);
    assert.deepEqual(s.citation, ["CITATION.cff"]);
    assert.deepEqual(s.workflows, [".github/workflows/test.yml"]);
    const words = summaryInWords(s, 2);
    assert.equal(words[0], "8 files changed: 148 lines added, 4 lines deleted.");
    assert.ok(words.includes("2 tracing-map links to a paper are touched."));
    assert.ok(words.some((w) => /licence changes/.test(w)));
  });
});

describe("suggestions", () => {
  const author = { name: "bob", login: "bob", id: "2" };
  test("parsed, applied one or as a batch; overlap and outdated refused", () => {
    assert.deepEqual(suggestionsOf("Try:\n```suggestion\nb = 2 ** 2\nc = 3\n```\n"), [["b = 2 ** 2", "c = 3"]]);
    assert.deepEqual(suggestionsOf("```suggestion\n```"), [[]]);
    assert.equal(suggestionBody(["x"], "Why not"), "Why not\n```suggestion\nx\n```");
    const one = suggestionOf({ id: "1", path: "a.py", line: 2, startLine: null, side: "RIGHT", body: "```suggestion\nB\n```", author });
    assert.ok(one && typeof one === "object");
    assert.match(String(suggestionOf({ id: "1", path: "a.py", line: null, startLine: null, side: "RIGHT", body: "```suggestion\nB\n```", author })), /Outdated/);
    assert.match(String(suggestionOf({ id: "1", path: "a.py", line: 2, startLine: null, side: "LEFT", body: "```suggestion\nB\n```", author })), /old side/);
    assert.equal(suggestionOf({ id: "1", path: "a.py", line: 2, startLine: null, side: "RIGHT", body: "plain", author }), null);
    assert.equal(applySuggestions("a\nb\nc\n", [{ start: 2, end: 2, lines: ["B"] }]), "a\nB\nc\n");
    assert.equal(applySuggestions("a\r\nb\r\nc", [{ start: 1, end: 2, lines: ["x", "y", "z"] }, { start: 3, end: 3, lines: [] }]), "x\r\ny\r\nz");
    assert.deepEqual(applySuggestions("a\nb\n", [{ start: 1, end: 2, lines: [] }, { start: 2, end: 2, lines: ["B"] }]), { problem: "Two suggestions change the same lines: apply them one at a time." });
    assert.ok(typeof applySuggestions("a\n", [{ start: 2, end: 3, lines: ["x"] }]) === "object");
  });

  test("which lines take a comment; a multi-line comment stays in one hunk", () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const neu = old.replace("line 5", "line five").replace("line 25", "line twenty-five");
    const hunks = hunksOf(old, neu);
    assert.equal(hunks.length, 2);
    assert.equal(commentable(hunks, "RIGHT", 5), 0);
    assert.equal(commentable(hunks, "LEFT", 5), 0);
    assert.equal(commentable(hunks, "RIGHT", 15), null);
    assert.deepEqual(commentRange(hunks, "RIGHT", 6, 3), { start: 3, end: 6 });
    assert.equal(commentRange(hunks, "RIGHT", 5, 25), null);
  });
});

describe("what the browser keeps", () => {
  test("the pending review and the files viewed, per pull request", () => {
    const s = new MemStore();
    // The callback page drops it once GitHub took the review (one of the drafts it may drop).
    assert.ok(isDraftKey(reviewKey(REPO, 7)));
    assert.equal(readPendingReview(s, REPO, 7, 100), null);
    assert.ok(writePendingReview(s, REPO, 7, { commit: SHA, comments: [{ path: "a.py", line: 2, side: "RIGHT", body: "?" }], body: "", at: 100 }));
    assert.equal(readPendingReview(s, REPO, 7, 200)?.comments.length, 1);
    assert.equal(readPendingReview(s, REPO, 7, 100 + 31 * 24 * 3600), null);
    assert.equal(readPendingReview(null, REPO, 7, 100), null);
    const viewed = readViewed(s, REPO, 7);
    viewed.set("a.py", "c".repeat(40));
    writeViewed(s, REPO, 7, viewed);
    assert.equal(isViewed(readViewed(s, REPO, 7), { path: "a.py", blob: "c".repeat(40) }), true);
    assert.equal(isViewed(readViewed(s, REPO, 7), { path: "a.py", blob: "d".repeat(40) }), false);
  });
});

describe("templates and prefill", () => {
  test("where GitHub finds them; the research template", () => {
    const t = findTemplates([".github/PULL_REQUEST_TEMPLATE.md", ".github/PULL_REQUEST_TEMPLATE/bug.md", ".github/PULL_REQUEST_TEMPLATE/data.md", ".github/PULL_REQUEST_TEMPLATE/deep/x.md", "README.md"]);
    assert.deepEqual(t, { single: ".github/PULL_REQUEST_TEMPLATE.md", several: [".github/PULL_REQUEST_TEMPLATE/bug.md", ".github/PULL_REQUEST_TEMPLATE/data.md"] });
    assert.equal(chosenTemplate(t.several, "DATA.md"), ".github/PULL_REQUEST_TEMPLATE/data.md");
    assert.equal(chosenTemplate(t.several, "none.md"), null);
    assert.equal(findTemplates(["docs/pull_request_template.md"]).single, "docs/pull_request_template.md");
    const r = researchTemplate([{ title: "EEG bands", doi: "10.5555/x" }]);
    assert.match(r, /Does it alter results reported in the paper\?/);
    assert.match(r, /EEG bands \(doi:10\.5555\/x\)/);
    assert.match(r, /Fixes #/);
  });

  test("GitHub's query parameters, checked", () => {
    const p = prefillOf("?expand=1&title=Fix%0Ait&body=Hello&template=bug.md&labels=a,b&assignees=ada,not%20ok&reviewers=bob&draft=1");
    assert.deepEqual(p, { title: "Fix it", body: "Hello", template: "bug.md", labels: ["a", "b"], assignees: ["ada"], reviewers: ["bob"], draft: true, expand: true });
    assert.equal(prefillOf("?template=../x.md").template, null);
    assert.equal(prefillOf("").expand, false);
  });
});

describe("reviewers suggested", () => {
  test("code owners, then the paper's verified authors; never the author or someone asked", () => {
    const co = parseCodeowners("*.py @carol @ada\ndocs/ @org/writers\n");
    const s = suggestReviewers({
      codeowners: co,
      paths: ["src/a.py", "docs/x.md"],
      authors: [{ login: "carol", papers: ["EEG bands"] }, { login: "dan", papers: ["EEG bands", "Other"] }, { login: "erin", papers: ["x"] }],
      author: "ada",
      requested: ["erin"],
    });
    assert.deepEqual(s.map((x) => [x.login, x.reasons]), [
      ["carol", ["owns src/a.py (CODEOWNERS)", "a verified author of the paper EEG bands"]],
      [null, ["owns docs/x.md (CODEOWNERS)"]],
      ["dan", ["a verified author of 2 of its papers"]],
    ]);
  });
});
