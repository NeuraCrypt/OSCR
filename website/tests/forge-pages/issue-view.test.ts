// The issue pages' view trees (night phase 05, E4; src/lib/issue-view.ts): research issues read
// field by field, the list's rows for both kinds, labels as words with a colour mark, references as
// links, milestones in words.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  issueRow,
  labelEl,
  linkRefs,
  milestoneInWords,
  parseComments,
  parseSummaries,
  parseSummary,
  parseView,
  whereInWords,
} from "../../src/lib/issue-view.ts";
import { fromGithub, fromResearch } from "../../src/lib/issues.ts";
import { h, type El } from "../../src/lib/repo-view.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada-fixture", name: "eeg" };

const textOf = (n: El | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
const find = (n: El, pred: (x: El) => boolean): El[] => [...(pred(n) ? [n] : []), ...n.children.flatMap((c) => (typeof c === "string" ? [] : find(c, pred)))];

const summary = {
  id: 7,
  paper: "doi:10.1234/eeg.2026",
  repo: { forge: "github", id: "101", path: "ada-fixture/eeg" },
  code_url: "",
  type: "mismatch",
  title: "Order 4, not 2 (ask ada@example.org)",
  state: "closed",
  close_reason: "not_planned",
  resolution: "not_a_mismatch",
  resolution_ref: "",
  labels: ["data"],
  locked: false,
  pinned: true,
  author: "cy",
  author_via: "github",
  author_role: "verified_author",
  comments: 2,
  created_at: 1_790_000_000,
  updated_at: 1_790_000_100,
  closed_at: 1_790_000_200,
  anchor: { commit: "a".repeat(40), path: "src/filter.py", start: 12, end: 18, paragraph: 14, section: "2.3 Filtering" },
  outcome: null,
  github_number: 3,
};

describe("research issues read field by field", () => {
  test("a summary: masked, typed, what is not one dropped", () => {
    const s = parseSummary(summary)!;
    assert.equal(s.title, "Order 4, not 2 (ask [email hidden])");
    assert.equal(s.resolution, "not_a_mismatch");
    assert.deepEqual(s.anchor?.start, 12);
    for (const bad of [null, [], { ...summary, id: 0 }, { ...summary, type: "bug" }, { ...summary, paper: "10.1/x" }, { ...summary, title: 3 }]) assert.equal(parseSummary(bad), null, JSON.stringify(bad));
    assert.equal(parseSummary({ ...summary, repo: { forge: "github", id: "1", path: "../etc" } })!.repo, null);
    assert.equal(parseSummary({ ...summary, code_url: "javascript:alert(1)" })!.code_url, "");
    assert.equal(parseSummary({ ...summary, state: "open" })!.resolution, "");
    assert.deepEqual(parseSummaries([summary, { nope: 1 }]).map((x) => x.id), [7]);
    assert.deepEqual(parseSummaries("x"), []);
  });

  test("a whole view, its report and events; comments", () => {
    const v = parseView({ ...summary, type: "reproduction", body: "Mail me: a@b.org", report: { outcome: "failed", environment: "py", datasets: ["doi:10.1234/x", "javascript:x"], observed: "0.1" }, events: [{ k: "closed", by: "cy", at: 5, s: "completed" }, { k: "<script>", at: 1 }] })!;
    assert.equal(v.body, "Mail me: [email hidden]");
    assert.deepEqual(v.report?.datasets, ["doi:10.1234/x"]);
    assert.deepEqual(v.events.map((e) => e.k), ["closed"]);
    const c = parseComments([{ n: 1, author: "bob", body: "x@y.org", created_at: 1, deleted: false, mine: true }, { author: "no number" }]);
    assert.equal(c.length, 1);
    assert.equal(c[0].body, "[email hidden]");
    assert.equal(c[0].mine, true);
  });
});

describe("rows and labels", () => {
  test("a GitHub issue's row: its state in words, its page in the registry, labels with their colour mark", () => {
    const i: T.Issue = {
      number: 4, id: "4", nodeId: null, title: "Crash", body: "- [x] a\n- [ ] b", state: "open", stateReason: null, author: { name: "Bob", login: "bob", id: "2" },
      labels: ["bug"], assignees: ["ada"], milestone: 1, locked: false, lockReason: null, pinned: null, comments: 1, reactions: {}, subIssues: { total: 2, completed: 1 },
      type: "Bug", isPullRequest: false, createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z", closedAt: null,
    };
    const row = issueRow(REPO, fromGithub(i), { select: true, colors: new Map([["bug", "d73a4a"]]), milestones: new Map([[1, "v2"]]) });
    const t = textOf(row);
    assert.match(t, /^Open · Bug Crash#4 opened 2026-09-20 by bob · 1 comment · Assigned to ada · Milestone: v2 · 1 of 2 tasks done · 1 of 2 sub-issues closedLabels: bug$/);
    assert.equal(find(row, (x) => x.tag === "a")[0].attrs.href, "/r/ada-fixture/eeg/issues/4");
    assert.equal(find(row, (x) => x.attrs.class === "label-mark")[0].attrs["data-color"], "red");
    assert.equal(find(row, (x) => x.tag === "input").length, 1);
    assert.ok(!JSON.stringify(row).includes("style"));
  });

  test("a research issue's row: its type, where it points, the copy, as of last night; no box to choose it", () => {
    const row = issueRow(REPO, fromResearch(parseSummary(summary)!), { select: true, asOfLastNight: true });
    const t = textOf(row);
    assert.match(t, /Closed: not a mismatch · Code–paper mismatch Order 4, not 2/);
    assert.match(t, /research#7 opened .* by cy · the paper's paragraph 14 · src\/filter\.py, lines 12–18 · 2 comments · copied to GitHub as #3 · as of last night/);
    assert.equal(find(row, (x) => x.tag === "a")[0].attrs.href, "/research/7");
    assert.equal(find(row, (x) => x.tag === "input").length, 0);
    assert.equal(whereInWords({ paragraph: null, path: "a.py", lines: { start: 3, end: 3 } }), "a.py, line 3");
    assert.equal(labelEl("x", "zzz").children.length, 2);
  });

  test("milestones in words", () => {
    assert.equal(milestoneInWords({ number: 1, title: "v2", description: "", state: "open", dueOn: "2026-12-01T00:00:00Z", openIssues: 2, closedIssues: 3 }), "3 of 5 issues closed (60%), due 2026-12-01");
    assert.equal(milestoneInWords({ number: 1, title: "v2", description: "", state: "closed", dueOn: null, openIssues: 0, closedIssues: 0 }), "No issue yet; closed");
  });
});

describe("references as links", () => {
  test("#12 and research#3 become links; code and links are left alone", () => {
    const tree = h("div", null, h("p", null, "See #12 and research#3, not a#4 or `x`."), h("code", null, "#5"), h("a", { href: "/x" }, "#6"));
    const out = linkRefs(tree, REPO);
    const links = find(out, (x) => x.tag === "a").map((a) => [a.attrs.href, textOf(a)]);
    assert.deepEqual(links, [["/r/ada-fixture/eeg/issues/12", "#12"], ["/research/3", "research#3"], ["/x", "#6"]]);
    assert.equal(textOf(out), textOf(tree));
    assert.deepEqual(find(linkRefs(h("p", null, "#1"), null), (x) => x.tag === "a"), []);
  });
});
