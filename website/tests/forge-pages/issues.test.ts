// The issues' pure library (night phase 05, E3; src/lib/issues.ts): addresses, the query over both
// kinds of issues, words, task lists, the palette, similar issues, suggestions set by rule, saved
// replies, completion, prefill.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { repoPath } from "../../src/lib/forge.ts";
import {
  BUILT_IN_REPLIES,
  chooserPath,
  completionAt,
  countMatches,
  DEFAULT_LABELS,
  eventInWords,
  fromGithub,
  fromResearch,
  hexOf,
  isPlusOne,
  issueCompletions,
  issuePath,
  issuePrefillOf,
  issueSearchQuery,
  issuesPath,
  matchIssue,
  milestonePath,
  missingDefaults,
  newIssuePath,
  newResearchPath,
  PALETTE,
  paletteOf,
  parseIssueQuery,
  parseIssueTarget,
  parseResearchPath,
  personCompletions,
  planIssueQuery,
  queryWords,
  quoteReply,
  readReplies,
  researchEventInWords,
  ruleSuggestions,
  saveReply,
  deleteReply,
  similarIssues,
  sortIssues,
  stateInWords,
  suggestionInWords,
  taskProgress,
  tasksOf,
  toggleTask,
  typeInWords,
  wordsOf,
  type IssueItem,
} from "../../src/lib/issues.ts";
import type { IssueSummary } from "../../worker/forge/service/research-core.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada-fixture", name: "eeg" };

const gh = (n: number, extra: Partial<T.Issue> = {}): T.Issue => ({
  number: n,
  id: String(1000 + n),
  nodeId: null,
  title: `Issue ${n}`,
  body: "",
  state: "open",
  stateReason: null,
  author: { name: "Bob", login: "bob", id: "2" },
  labels: [],
  assignees: [],
  milestone: null,
  locked: false,
  lockReason: null,
  pinned: null,
  comments: 0,
  reactions: {},
  subIssues: null,
  type: null,
  isPullRequest: false,
  createdAt: `2026-09-${String(n).padStart(2, "0")}T10:00:00Z`,
  updatedAt: `2026-09-${String(n).padStart(2, "0")}T10:00:00Z`,
  closedAt: null,
  ...extra,
});

const rs = (id: number, extra: Partial<IssueSummary> = {}): IssueSummary => ({
  id,
  paper: "doi:10.1234/eeg.2026",
  repo: { forge: "github", id: "101", path: "ada-fixture/eeg" },
  code_url: "",
  type: "mismatch",
  title: `Research ${id}`,
  state: "open",
  close_reason: "",
  resolution: "",
  resolution_ref: "",
  labels: [],
  locked: false,
  pinned: false,
  author: "cy",
  author_via: "github",
  author_role: "",
  comments: 0,
  created_at: 1_790_000_000 + id,
  updated_at: 1_790_000_000 + id,
  closed_at: null,
  anchor: { commit: "", path: "src/filter.py", start: 12, end: 18, paragraph: 14, section: "" },
  outcome: null,
  github_number: null,
  ...extra,
});

const match = (item: IssueItem, q: string, ctx = {}) => matchIssue(item, parseIssueQuery(q).node, ctx);

describe("addresses", () => {
  test("GitHub's shapes in the /r/ shell, and the research shell", () => {
    assert.equal(issuesPath(REPO), "/r/ada-fixture/eeg/issues/");
    assert.equal(issuesPath(REPO, "is:open label:bug"), "/r/ada-fixture/eeg/issues/?q=is%3Aopen+label%3Abug");
    assert.equal(issuePath(REPO, 12), "/r/ada-fixture/eeg/issues/12");
    assert.equal(chooserPath(REPO), "/r/ada-fixture/eeg/issues/new/choose");
    assert.equal(newIssuePath(REPO, { title: "x" }), "/r/ada-fixture/eeg/issues/new?title=x");
    assert.equal(repoPath(REPO, "labels"), "/r/ada-fixture/eeg/labels/");
    assert.equal(milestonePath(REPO, 3), "/r/ada-fixture/eeg/milestone/3");
    assert.deepEqual(parseIssueTarget([]), { list: true });
    assert.deepEqual(parseIssueTarget(["12"]), { number: 12 });
    assert.deepEqual(parseIssueTarget(["new"]), { new: true });
    assert.deepEqual(parseIssueTarget(["new", "choose"]), { choose: true });
    for (const bad of [["0"], ["12", "x"], ["new", "x"], ["abc"], ["99999999999"]]) assert.equal(parseIssueTarget(bad), null, bad.join("/"));
    assert.deepEqual(parseResearchPath("/research/12"), { id: 12 });
    assert.deepEqual(parseResearchPath("/research/new"), { new: true });
    assert.deepEqual(parseResearchPath("/research/"), { list: true });
    assert.equal(parseResearchPath("/research/12/x"), null);
    assert.equal(parseResearchPath("/research/../x"), null);
    assert.equal(newResearchPath({ doi: "10.1/x", type: "mismatch" }), "/research/new?doi=10.1%2Fx&type=mismatch");
  });
});

describe("the query over both kinds", () => {
  const items = [
    fromGithub(gh(1, { labels: ["bug"], comments: 4, reactions: { "+1": 3 } })),
    fromGithub(gh(2, { state: "closed", stateReason: "not_planned", closedAt: "2026-09-03T00:00:00Z", assignees: ["ada-fixture"], milestone: 1 })),
    fromGithub(gh(3, { pinned: true, type: "Bug", locked: true })),
    fromResearch(rs(7)),
    fromResearch(rs(8, { type: "reproduction", state: "closed", close_reason: "completed", resolution: "fixed_in_code", outcome: "failed", anchor: null })),
  ];

  test("GitHub's qualifiers", () => {
    assert.ok(match(items[0], "is:issue is:open label:bug"));
    assert.ok(!match(items[1], "is:open"));
    assert.ok(match(items[1], 'reason:"not planned"'));
    assert.ok(match(items[1], "assignee:@me", { me: "ada-fixture" }));
    assert.ok(match(items[1], "milestone:v2", { milestones: new Map([[1, "v2"]]) }));
    assert.ok(match(items[0], "no:milestone no:assignee"));
    assert.ok(match(items[0], "comments:>3 reactions:3 interactions:7"));
    assert.ok(match(items[2], "is:pinned is:locked type:bug"));
    assert.ok(match(items[0], "-label:wontfix (label:bug OR label:data)"));
    assert.ok(match(items[1], "closed:2026-09-01..2026-09-30"));
    assert.ok(!match(items[0], "is:pr"));
    assert.ok(match(items[0], "#1"));
    assert.ok(!match(items[3], "#7"));
    assert.ok(match(items[3], "research#7"));
  });

  test("the research qualifiers, and the types", () => {
    assert.ok(match(items[3], "is:research type:mismatch doi:10.1234/eeg.2026"));
    assert.ok(match(items[3], "map-link:14:src/filter.py"));
    assert.ok(match(items[3], "map-link:14"));
    assert.ok(match(items[3], "path:src"));
    assert.ok(!match(items[3], "path:sr"));
    assert.ok(match(items[4], "resolution:fixed-in-code outcome:failed"));
    assert.ok(match(items[4], 'outcome:"not reproduced"'));
    assert.ok(!match(items[0], "doi:10.1234/eeg.2026"));
    assert.ok(match(items[4], "has:label") === false);
    assert.equal(typeInWords(items[3]), "Code–paper mismatch");
    assert.equal(typeInWords(items[2]), "Bug");
  });

  test("the plan: the list endpoint's filters, GitHub's search when needed, which kinds", () => {
    const p = planIssueQuery(parseIssueQuery("is:issue is:closed label:bug author:bob sort:comments-asc"));
    assert.deepEqual([p.state, p.labels, p.creator, p.sort, p.direction, p.search, p.github, p.research], ["closed", ["bug"], "bob", "comments", "asc", false, true, true]);
    assert.equal(planIssueQuery(parseIssueQuery("commenter:ada")).search, true);
    const r = planIssueQuery(parseIssueQuery("type:mismatch"));
    assert.deepEqual([r.github, r.research], [false, true]);
    const g = planIssueQuery(parseIssueQuery("-is:research milestone:v2"));
    assert.deepEqual([g.github, g.research, g.milestone], [true, false, "v2"]);
    assert.deepEqual(planIssueQuery(parseIssueQuery("sort:reactions-+1-desc")).reaction, "+1");
    assert.deepEqual(parseIssueQuery("frobnicate:x").errors, ["frobnicate: is not a qualifier the registry reads."]);
    assert.equal(issueSearchQuery("commenter:ada is:research doi:10.1/x"), "is:issue commenter:ada");
    assert.equal(issueSearchQuery("is:issue label:bug"), "is:issue label:bug");
  });

  test("sorts: pinned open issues first, then the sort; best match by the words", () => {
    const plan = planIssueQuery(parseIssueQuery("sort:created-desc"));
    assert.deepEqual(sortIssues(items, plan).map((i) => `${i.kind[0]}${i.number}`), ["g3", "r8", "r7", "g2", "g1"]);
    const byComments = sortIssues(items, planIssueQuery(parseIssueQuery("sort:comments-desc")));
    assert.equal(byComments[1].number, 1);
    const q = parseIssueQuery("filter order");
    const best = sortIssues([fromGithub(gh(4, { title: "Order of the filter" })), fromGithub(gh(5, { title: "Unrelated", body: "filter" }))], planIssueQuery(parseIssueQuery("sort:best-match")), queryWords(q.node));
    assert.equal(best[0].number, 4);
    assert.ok(countMatches(5, "1..5") && !countMatches(6, "1..5") && countMatches(9, ">=9") && countMatches(3, "3"));
  });
});

describe("words", () => {
  test("states, reasons, resolutions, events", () => {
    assert.equal(stateInWords(fromGithub(gh(1))), "Open");
    assert.equal(stateInWords(fromGithub(gh(1, { state: "closed", stateReason: "duplicate" }))), "Closed as a duplicate");
    assert.equal(stateInWords(fromGithub(gh(1, { state: "closed", stateReason: null }))), "Closed as completed");
    assert.equal(stateInWords(fromResearch(rs(1, { state: "closed", close_reason: "not_planned", resolution: "not_a_mismatch" }))), "Closed: not a mismatch");
    assert.equal(eventInWords({ kind: "labeled", actor: null, createdAt: "", subject: "bug" }), "added the label “bug”");
    assert.equal(eventInWords({ kind: "cross-referenced", actor: null, createdAt: "", subject: "ada/eeg#4" }), "mentioned this in ada/eeg#4");
    assert.equal(eventInWords({ kind: "other", actor: null, createdAt: "", subject: null }), null);
    assert.equal(researchEventInWords({ k: "closed", by: "a", at: 1, s: "completed paper_corrected 10.1/erratum" }), "closed this: the paper was corrected (10.1/erratum)");
    assert.equal(researchEventInWords({ k: "closed", by: "a", at: 1, s: "duplicate  research#1" }), "closed this as a duplicate (research#1)");
    assert.equal(researchEventInWords({ k: "merged", by: "a", at: 1, s: "#4" }), "closed this by merging the pull request #4: fixed in the code");
  });
});

describe("task lists", () => {
  const text = "Steps:\n- [ ] Figure 1\n- [x] Figure 2\n```\n- [ ] not a task\n```\n* [ ] #12\n1. [X] research#3";
  test("found outside code; progress; one ticked, the rest unchanged", () => {
    const t = tasksOf(text);
    assert.deepEqual(t.map((x) => [x.line, x.checked, x.ref]), [[1, false, null], [2, true, null], [6, false, "#12"], [7, true, "research#3"]]);
    assert.deepEqual(taskProgress(text), { done: 2, total: 4 });
    const next = toggleTask(text, 0, true)!;
    assert.equal(next.split("\n")[1], "- [x] Figure 1");
    assert.equal(next.split("\n").length, text.split("\n").length);
    assert.equal(toggleTask(text, 1, false)!.split("\n")[2], "- [ ] Figure 2");
    assert.equal(toggleTask(text, 9, true), null);
  });
});

describe("labels", () => {
  test("a hex colour to the palette's nearest; the defaults a repository lacks", () => {
    assert.equal(PALETTE.length, 16);
    assert.equal(paletteOf("d73a4a"), "red");
    assert.equal(paletteOf("0e8a16"), "green");
    assert.equal(paletteOf("FFFFFF"), "white");
    assert.equal(paletteOf("no"), "gray");
    assert.equal(hexOf("blue"), "0075ca");
    for (const l of DEFAULT_LABELS) assert.ok(PALETTE.some((p) => p.name === paletteOf(l.color)));
    assert.deepEqual(DEFAULT_LABELS.slice(-3).map((l) => l.name), ["data", "environment", "numerical difference"]);
    assert.equal(missingDefaults([{ name: "Bug" }, { name: "data" }]).length, DEFAULT_LABELS.length - 2);
  });
});

describe("writing", () => {
  test("similar issues by shared words, the same file and paragraph weighing more", () => {
    const items = [fromGithub(gh(1, { title: "The band power filter uses the wrong order" })), fromGithub(gh(2, { title: "Typo in README" })), fromResearch(rs(3, { title: "Filter order differs" }))];
    const found = similarIssues({ title: "Wrong filter order in band power", path: "src/filter.py", paragraph: 14 }, items);
    assert.deepEqual(found.map((f) => f.item.number), [1, 3]);
    assert.deepEqual(similarIssues({ title: "x" }, items), []);
    assert.ok(wordsOf("The filters and the analyses").has("filter"));
  });

  test("suggestions set by rule, each with its reason, never twice", () => {
    const s = ruleSuggestions("Figure 3 differs from the paper: I get 0.12 instead of 0.61 with numpy 2.1 and the OpenNeuro dataset.");
    assert.deepEqual(s.map((x) => [x.field, x.value]), [["type", "reproduction"], ["label", "data"], ["label", "environment"], ["label", "numerical difference"]]);
    assert.ok(s.every((x) => x.source === "rule" && x.reason));
    assert.equal(suggestionInWords(s[0]), "The type “Reproduction failure”, set by rule: it says a result of the paper did not come out.");
    assert.deepEqual(ruleSuggestions("Traceback: IndexError", { type: "Bug" }).map((x) => x.value), []);
    assert.deepEqual(ruleSuggestions("paragraph 14 says order 2 but the code uses 4").map((x) => x.value), ["mismatch"]);
  });

  test("saved replies kept in the browser; the built-in ones; +1; quotes", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    assert.deepEqual(readReplies(store), []);
    assert.ok(saveReply(store, { name: "Thanks", body: "Thank you for the report." }));
    assert.ok(saveReply(store, { name: "Thanks", body: "Thanks!" }));
    assert.deepEqual(readReplies(store), [{ name: "Thanks", body: "Thanks!" }]);
    assert.ok(!saveReply(store, { name: " ", body: "x" }));
    deleteReply(store, "Thanks");
    assert.deepEqual(readReplies(store), []);
    assert.equal(readReplies(null).length, 0);
    assert.equal(BUILT_IN_REPLIES[0].name, "Duplicate issue");
    assert.ok(isPlusOne("+1") && isPlusOne(" me too! ") && !isPlusOne("+1, and on Windows too"));
    assert.equal(quoteReply("a\nb"), "> a\n> b\n\n");
  });

  test("“@” and “#” completion", () => {
    assert.deepEqual(completionAt("See #1", 6), { kind: "#", query: "1", start: 4 });
    assert.deepEqual(completionAt("cc @ad", 6), { kind: "@", query: "ad", start: 3 });
    assert.equal(completionAt("mail a@b", 8), null);
    const items = [fromGithub(gh(12, { title: "Filter" })), fromGithub(gh(3, { title: "Other" }))];
    assert.deepEqual(issueCompletions("1", items).map((i) => i.number), [12]);
    assert.deepEqual(issueCompletions("oth", items).map((i) => i.number), [3]);
    assert.deepEqual(personCompletions("a", ["ada-fixture", "bob", "ada-fixture", "a@b.org"]), ["ada-fixture"]);
  });

  test("prefill by address: GitHub's parameters and the registry's, each checked", () => {
    const p = issuePrefillOf("?title=Order%0Aof&labels=bug,data&assignees=ada,no%20t&milestone=3&doi=https://doi.org/10.1234/EEG&commit=" + "a".repeat(40) + "&path=src/f.py&lines=L12-L18&paragraph=14&template=research:mismatch");
    assert.equal(p.title, "Order of");
    assert.deepEqual(p.labels, ["bug", "data"]);
    assert.deepEqual(p.assignees, ["ada"]);
    assert.equal(p.milestone, 3);
    assert.equal(p.doi, "10.1234/eeg");
    assert.deepEqual(p.lines, { start: 12, end: 18 });
    assert.equal(p.paragraph, 14);
    assert.equal(p.template, "research:mismatch");
    const bad = issuePrefillOf("?path=../x&commit=abc&template=../../x.md&milestone=0");
    assert.deepEqual([bad.path, bad.commit, bad.template, bad.milestone], [null, null, null, null]);
  });
});
