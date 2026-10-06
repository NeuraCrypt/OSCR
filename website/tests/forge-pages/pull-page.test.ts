// A pull request's page (night phase 04, E4; src/lib/pull-page.ts): the header and its sentence,
// the tabs, the conversation's timeline (comments, reviews and their conversations, replies under
// their first comment, outdated said), role labels in words, the checks in words.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  checkWords,
  commentHead,
  eventWords,
  hasSuggestion,
  headName,
  pullHeader,
  pullSentence,
  pullTabsNav,
  reviewWords,
  rolesOf,
  statusWords,
  threadsOf,
  threadWhere,
  timelineOf,
} from "../../src/lib/pull-page.ts";
import { mergeBox } from "../../src/lib/pulls.ts";
import { type El, textOf } from "../../src/lib/repo-view.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada", name: "eeg" };
const SHA = "a".repeat(40);
const actor = (login: string): T.Actor => ({ name: login, login, id: login.length.toString() });

function pr(o: Partial<T.PullRequest> = {}): T.PullRequest {
  return {
    number: 7, id: "1", nodeId: null, title: "Square it", body: "", state: "open", draft: false, merged: false, mergedAt: null, mergeCommit: null,
    author: actor("bob"), createdAt: "2026-09-20T10:00:00Z", updatedAt: "2026-09-21T10:00:00Z", closedAt: null,
    head: { repo: { forge: "github", owner: "bob", name: "eeg" }, ref: "fix", sha: SHA },
    base: { repo: { forge: "github", owner: "ada", name: "eeg" }, ref: "main", sha: "b".repeat(40) },
    mergeable: true, mergeState: "clean", requestedReviewers: [], labels: [], assignees: [], milestone: null, autoMerge: null, maintainerCanModify: true,
    counts: { commits: 2, additions: 1, deletions: 1, changedFiles: 3, comments: 0 },
    ...o,
  };
}

const rc = (id: string, o: Partial<T.ReviewComment> = {}): T.ReviewComment => ({
  id, reviewId: "r1", inReplyTo: null, author: actor("carol"), path: "a.py", line: 3, startLine: null, side: "RIGHT", commit: SHA, originalCommit: SHA,
  body: "Why?", createdAt: `2026-09-21T10:00:0${id}Z`, updatedAt: "", ...o,
});

function* walk(e: El): Generator<El> {
  yield e;
  for (const c of e.children) if (typeof c !== "string") yield* walk(c);
}

describe("the header and the tabs", () => {
  test("who wants to merge what; merged and closed in words; the merge status at the top", () => {
    assert.equal(pullSentence(REPO, pr()), "bob wants to merge 2 commits into main from bob:fix. Opened 2026-09-20.");
    assert.equal(pullSentence(REPO, pr({ merged: true, state: "closed", mergedAt: "2026-09-22T00:00:00Z" })), "bob's 2 commits from bob:fix were merged into main on 2026-09-22.");
    assert.match(pullSentence(REPO, pr({ state: "closed", closedAt: "2026-09-23T00:00:00Z" })), /closed without merging on 2026-09-23/);
    assert.equal(headName(REPO, pr({ head: { repo: null, ref: "gone", sha: SHA } })), "gone (its fork was deleted)");
    assert.equal(headName(REPO, pr({ head: { repo: { forge: "github", owner: "Ada", name: "EEG" }, ref: "x", sha: SHA } })), "x");
    const head = pullHeader(REPO, pr(), mergeBox(pr(), null, null));
    assert.match(textOf(head), /^Square it #7Open bob wants to merge/);
    assert.ok([...walk(head)].some((e) => e.attrs.class === "merge-status ok"));
    const tabs = pullTabsNav(REPO, pr(), "files");
    assert.deepEqual([...walk(tabs)].filter((e) => e.tag === "a").map((e) => e.attrs.href), ["/r/ada/eeg/pull/7", "/r/ada/eeg/pull/7/commits", "/r/ada/eeg/pull/7/checks", "/r/ada/eeg/pull/7/files"]);
    assert.deepEqual([...walk(tabs)].filter((e) => e.attrs["aria-current"] === "page").map(textOf), ["Files changed (3)"]);
  });
});

describe("the conversation", () => {
  test("replies under their first comment; outdated said; a review's conversations under it", () => {
    const threads = threadsOf([rc("2", { inReplyTo: "1", author: actor("bob") }), rc("1"), rc("3", { line: null, path: "b.py" })]);
    assert.deepEqual(threads.map((t) => [t.id, t.comments.map((c) => c.id), t.outdated]), [["1", ["1", "2"], false], ["3", ["3"], true]]);
    assert.equal(threadWhere(threads[0]), "a.py, line 3");
    assert.equal(threadWhere(threads[1]), "b.py (outdated: the lines changed since)");
    assert.equal(threadWhere({ path: "c.py", line: 9, startLine: 5, side: "LEFT", outdated: false }), "c.py, lines 5 to 9 of the old version");

    const reviews: T.Review[] = [
      { id: "r1", author: actor("carol"), state: "CHANGES_REQUESTED", body: "Two things.", commit: SHA, submittedAt: "2026-09-21T10:00:00Z" },
      // GitHub's review made for a reply only: left out, the reply is in its conversation.
      { id: "r2", author: actor("bob"), state: "COMMENTED", body: "", commit: SHA, submittedAt: "2026-09-21T11:00:00Z" },
      { id: "r3", author: actor("dan"), state: "APPROVED", body: "", commit: SHA, submittedAt: "2026-09-22T09:00:00Z" },
    ];
    const comments: T.IssueComment[] = [{ id: "c1", author: actor("ada"), body: "Thanks!", createdAt: "2026-09-21T12:00:00Z", updatedAt: "", reactions: {} }];
    const events: T.TimelineEvent[] = [{ kind: "merged", actor: actor("ada"), createdAt: "2026-09-23T00:00:00Z", subject: SHA }, { kind: "other", actor: null, createdAt: "2026-09-23T00:00:00Z", subject: null }];
    const items = timelineOf(comments, reviews, [rc("1"), rc("2", { inReplyTo: "1", reviewId: "r2", author: actor("bob") })], events);
    assert.deepEqual(items.map((i) => (i.kind === "comment" ? `c:${i.comment.id}` : i.kind === "review" ? `r:${i.review.id}:${i.threads.length}` : `e:${i.event.kind}`)), ["r:r1:1", "c:c1", "r:r3:0", "e:merged"]);
    assert.equal(eventWords(events[0]), "ada merged it (aaaaaaa).");
    assert.equal(reviewWords("CHANGES_REQUESTED"), "requested changes");
  });

  test("roles in words; a comment's head; suggestions found", () => {
    const roles = { author: "bob", paperAuthors: new Set(["carol"]), codeOwners: new Set(["carol", "dan"]) };
    assert.deepEqual(rolesOf("Carol", roles), ["verified author of the paper", "code owner"]);
    assert.deepEqual(rolesOf("bob", roles), ["author"]);
    assert.deepEqual(rolesOf(null, roles), []);
    assert.equal(textOf(commentHead(actor("carol"), "2026-09-21T10:00:00Z", roles, "approved these changes")), "carol (verified author of the paper, code owner) approved these changes on 2026-09-21");
    assert.equal(hasSuggestion("x\n```suggestion\ny\n```"), true);
    assert.equal(hasSuggestion("```python\ny\n```"), false);
  });

  test("the checks in words", () => {
    const run = (status: T.CheckStatus, conclusion: T.CheckConclusion | null): T.CheckRun => ({ id: "1", name: "tests", headSha: SHA, status, conclusion, startedAt: null, completedAt: null, detailsUrl: null, app: null, output: { title: "", summary: "", annotations: 0 } });
    assert.deepEqual(checkWords(run("completed", "success")), { text: "tests: passed", tone: "ok" });
    assert.deepEqual(checkWords(run("completed", "timed_out")), { text: "tests: took too long (timed out)", tone: "warning" });
    assert.deepEqual(checkWords(run("in_progress", null)), { text: "tests: running", tone: "" });
    assert.deepEqual(statusWords({ context: "ci/lint", state: "failure", description: "3 errors", targetUrl: null }), { text: "ci/lint: failed, 3 errors", tone: "warning" });
  });
});
