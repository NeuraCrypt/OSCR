// An issue's page, pure parts (night phase 05, E5; src/lib/issue-page.ts): the header in words, the
// timeline in time order, events in words and links, reactions, what closed it, the sidebar's facts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { closedInWords, eventLine, issueHeader, issueTimeline, mentionsOf, participants, reactionsLine, sidebarFacts } from "../../src/lib/issue-page.ts";
import type { El } from "../../src/lib/repo-view.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "oscr-fixture", name: "eeg-analysis" };
const textOf = (n: El | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const find = (n: El, pred: (x: El) => boolean): El[] => [...(pred(n) ? [n] : []), ...n.children.flatMap((c) => (typeof c === "string" ? [] : find(c, pred)))];
const actor = (login: string): T.Actor => ({ name: login, login, id: "1" });

const issue = (extra: Partial<T.Issue> = {}): T.Issue => ({
  number: 3, id: "3", nodeId: null, title: "Figure 2 differs", body: "- [x] a\n- [ ] b", state: "open", stateReason: null, author: actor("bob"),
  labels: ["bug"], assignees: ["ada"], milestone: 1, locked: false, lockReason: null, pinned: null, comments: 2, reactions: { eyes: 2, "+1": 1 }, subIssues: null,
  type: "Bug", isPullRequest: false, createdAt: "2026-09-20T10:00:00Z", updatedAt: "2026-09-21T10:00:00Z", closedAt: null, ...extra,
});
const comment = (id: string, at: string, body: string, who = "ada"): T.IssueComment => ({ id, author: actor(who), body, createdAt: at, updatedAt: at, reactions: {} });

describe("an issue's page", () => {
  test("the header in words: state, type, who, tasks, the lock", () => {
    assert.equal(textOf(issueHeader(issue())), "Figure 2 differs #3Open · Bug · opened 2026-09-20 by bob · 2 comments · 1 of 2 tasks done");
    assert.match(textOf(issueHeader(issue({ state: "closed", stateReason: "not_planned", locked: true, lockReason: "too heated" }))), /^Figure 2 differs #3Closed as not planned · Bug .* · locked as too heated: only collaborators comment$/);
  });

  test("the timeline: comments and events in time order, a comment's own event left out", () => {
    const items = issueTimeline(
      [comment("2", "2026-09-21T00:00:00Z", "b"), comment("1", "2026-09-20T12:00:00Z", "a")],
      [
        { kind: "labeled", actor: actor("ada"), createdAt: "2026-09-20T11:00:00Z", subject: "bug" },
        { kind: "commented", actor: actor("ada"), createdAt: "2026-09-20T12:00:00Z", subject: null },
        { kind: "other", actor: null, createdAt: "2026-09-20T13:00:00Z", subject: null },
      ],
    );
    assert.deepEqual(items.map((i) => (i.kind === "comment" ? `c${i.comment.id}` : i.event.kind)), ["labeled", "c1", "c2"]);
  });

  test("events: a mention of this repository's issue links to the registry's page", () => {
    const e = eventLine({ kind: "cross-referenced", actor: actor("ada"), createdAt: "2026-09-22T00:00:00Z", subject: "oscr-fixture/eeg-analysis#9" }, REPO);
    assert.equal(textOf(e), "ada mentioned this in #9 on 2026-09-22");
    assert.equal(find(e, (x) => x.tag === "a")[0].attrs.href, "/r/oscr-fixture/eeg-analysis/issues/9");
    assert.equal(textOf(eventLine({ kind: "cross-referenced", actor: actor("ada"), createdAt: "", subject: "other/repo#2" }, REPO)), "ada mentioned this in other/repo#2");
    assert.deepEqual(mentionsOf([{ kind: "cross-referenced", actor: null, createdAt: "", subject: "oscr-fixture/eeg-analysis#9" }, { kind: "cross-referenced", actor: null, createdAt: "", subject: "OSCR-fixture/EEG-analysis#9" }, { kind: "closed", actor: null, createdAt: "", subject: null }], REPO), ["#9"]);
  });

  test("reactions as characters and names; what closed it; the participants", () => {
    assert.equal(textOf(reactionsLine({ eyes: 2, "+1": 1 })!), "👍 thumbs up 1 · 👀 eyes 2");
    assert.equal(reactionsLine({}), null);
    assert.equal(closedInWords(issue(), []), null);
    assert.equal(closedInWords(issue({ state: "closed", stateReason: "duplicate", closedAt: "2026-09-23T00:00:00Z" }), [comment("1", "", "Duplicate of #2")]), "Closed as a duplicate: a duplicate of #2 on 2026-09-23.");
    assert.equal(closedInWords(issue({ state: "closed", stateReason: "reopened" }), []), "Closed as completed.");
    assert.deepEqual(participants(issue(), [comment("1", "", "x", "cy"), comment("2", "", "y", "bob")]), ["bob", "cy", "ada"]);
  });

  test("the sidebar's facts: labels with their marks, the milestone's progress, sub-issues, what blocks it", () => {
    const facts = sidebarFacts(
      REPO,
      issue(),
      {
        colors: new Map([["bug", "d73a4a"]]),
        milestone: { number: 1, title: "Revision", description: "", state: "open", dueOn: null, openIssues: 1, closedIssues: 1 },
        subIssues: [issue({ number: 4, title: "Pin SciPy", state: "closed" })],
        blockedBy: [issue({ number: 5, title: "The data", state: "open" })],
        people: ["bob", "ada"],
        branch: "3-figure-2-differs",
        mentions: ["#9"],
      },
      (n) => `/labels/${n}`,
    );
    const t = facts.map(textOf).join("|");
    assert.match(t, /Assignees\|ada\|Labels\|bug\|Type\|Bug\|Milestone\|Revision: 1 of 2 issues closed \(50%\)/);
    assert.match(t, /Sub-issues: 1 of 1 closed\.\|#4 Pin SciPy \(closed\)\|Blocked: 1 issue it waits for is still open\.\|Blocked by #5 The data/);
    assert.match(t, /Its branch: 3-figure-2-differs\.\|Mentioned in #9/);
    const marks = facts.flatMap((x) => find(x, (e) => e.attrs.class === "label-mark"));
    assert.equal(marks[0].attrs["data-color"], "red");
  });
});
