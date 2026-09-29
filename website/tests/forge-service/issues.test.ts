// GitHub's issues as authorized actions (night phase 05, E1; act-issues.ts): through start, the
// double's GitHub and act, with the real registry. Each action is ONE act made by GitHub as the
// person, the action row the only row written, GitHub's refusals said in words.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import {
  BULK_ISSUES,
  BULK_LABELLED,
  describeIssueEdit,
  describeIssueLabels,
  describeIssueOpen,
  describeIssueReact,
  describeIssueRelation,
  ISSUE_ACTIONS,
  issueBranchName,
  validateIssueComment,
  validateIssueEdit,
  validateIssueLabels,
  validateIssueLock,
  validateIssueMilestone,
  validateIssueOpen,
  validateIssueReact,
  validateIssueRelation,
  type IssueEditParsed,
  type IssueLabelsParsed,
  type IssueOpenParsed,
} from "../../worker/forge/service/act-issues.ts";
import { ACTION_KINDS, isProblem } from "../../worker/forge/service/types.ts";
import { authorize, githubId, signIn, watchAuth } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

/** Ada's public repository on the double (not known to the registry: no repos row is needed). */
async function repository(name = "eeg"): Promise<string> {
  return (await ada().repos.create({ name, visibility: "public", autoInit: true })).key.id;
}

const on = (kind: string, id: string, payload: Record<string, unknown>, extra: Partial<StartInput> = {}): StartInput => ({
  kind: kind as StartInput["kind"],
  repo: { forge: "memory", id },
  branch: null,
  expectedHead: null,
  payload,
  back: "/r/ada-fixture/eeg/issues",
  ...extra,
});

describe("issue_open", () => {
  test("opens the issue as Ada with labels, an assignee and a milestone; the action row only; the token revoked", async () => {
    const b = await signIn(w);
    const id = await repository();
    const m = await ada().issues.createMilestone(REF, { title: "Revision 1" });
    const seen = watchAuth(w);
    w.forge.reset();
    const run = await authorize(w, b, on("issue_open", id, { title: "Figure 3 differs from the paper", body: "Run with seed 42.", labels: ["bug", "numerical difference"], assignees: [ADA_LOGIN], milestone: m.number }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    const issue = await ada().issues.get(REF, r.number);
    assert.equal(issue.title, "Figure 3 differs from the paper");
    assert.deepEqual(issue.labels, ["bug", "numerical difference"]);
    assert.deepEqual(issue.assignees, [ADA_LOGIN]);
    assert.equal(issue.milestone, m.number);
    assert.equal(r.page, `/r/ada-fixture/eeg/issues/${r.number}`);
    assert.deepEqual(r.links[0], { href: r.page, text: `The issue #${r.number}` });
    assert.equal(run.actBody!.sentence, `Open the issue “Figure 3 differs from the paper” (labelled “bug” and “numerical difference”; assigned to ada-fixture; in the milestone #${m.number})`);
    assert.equal(w.forge.totals.written, 1);
    const [row] = forgeRows(w.forge, "actions");
    assert.equal(row.kind, "issue_open");
    assert.equal(row.repo_id, id);
    await Promise.all(w.ctx.waited);
    assert.deepEqual(seen.revoked, seen.issued);
    assert.ok(!JSON.stringify(run.actBody).includes(seen.issued[0]));
    assert.ok(!JSON.stringify(forgeRows(w.forge, "actions")).includes("Figure 3"));
  });

  test("a reader who does not triage: GitHub keeps the issue and drops the labels, said; a sub-issue of a parent", async () => {
    const id = await repository();
    const parent = await ada().issues.create(REF, { title: "Reproduce the paper" });
    const b = await signIn(w, "bob-fixture");
    const run = await authorize(w, b, on("issue_open", id, { title: "Table 2", labels: ["bug"], parent: parent.number }), { login: "bob-fixture" });
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.deepEqual((await ada().issues.get(REF, r.number)).labels, []);
    assert.match(r.notes.join(" "), /without the labels: only people who triage/);
    // Making it a sub-issue needs write: said, the issue kept.
    assert.match(r.notes.join(" "), new RegExp(`did not make it a sub-issue of #${parent.number}`));
    const own = await authorize(w, await signIn(w), on("issue_open", id, { title: "Figure 1", parent: parent.number }));
    assert.equal(own.act?.status, 200, JSON.stringify(own.actBody));
    assert.deepEqual((await ada().issues.subIssues(REF, parent.number)).items.map((i) => i.number), [own.actBody!.result.number]);
  });

  test("a type on a personal repository is refused by GitHub, said; issues turned off", async () => {
    const b = await signIn(w);
    const id = await repository();
    const typed = await authorize(w, b, on("issue_open", id, { title: "Typed", type: "Bug" }));
    assert.equal(typed.act?.status, 422);
    assert.match(typed.actBody?.error.message, /issue types belong to organizations/);
    await ada().repos.update(REF, { features: { issues: false } } as never);
    w.backend.repos.get(id)!.features.issues = false;
    const off = await authorize(w, b, on("issue_open", id, { title: "Off" }));
    assert.equal(off.act?.status, 410);
    assert.match(off.actBody?.error.message, /turned off/);
    assert.equal(forgeRows(w.forge, "actions").length, 0);
  });

  test("validate and describe", () => {
    const ok = validateIssueOpen({ title: "  A title  ", labels: ["a"], parent: 3 }) as IssueOpenParsed;
    assert.equal(ok.title, "A title");
    assert.equal(describeIssueOpen(ok), "Open the issue “A title” (labelled “a”; as a sub-issue of #3)");
    for (const p of [null, {}, { title: "" }, { title: "a\nb" }, { title: "x".repeat(257) }, { title: "t", labels: "bug" }, { title: "t", labels: ["a", "A"] }, { title: "t", labels: [" padded"] }, { title: "t", assignees: ["not a login"] }, { title: "t", milestone: 0 }, { title: "t", parent: "3" }, { title: "t", body: 3 }]) {
      assert.ok(isProblem(validateIssueOpen(p)), JSON.stringify(p));
    }
  });
});

describe("issue_edit", () => {
  test("title and description; close as not planned; reopen; close as a duplicate with GitHub's comment", async () => {
    const b = await signIn(w);
    const id = await repository();
    const i = await ada().issues.create(REF, { title: "Wrong constant" });
    const other = await ada().issues.create(REF, { title: "Same" });
    const edit = await authorize(w, b, on("issue_edit", id, { number: i.number, title: "Wrong constant in eq. 3", body: "Details." }));
    assert.equal(edit.act?.status, 200, JSON.stringify(edit.actBody));
    assert.equal((await ada().issues.get(REF, i.number)).title, "Wrong constant in eq. 3");
    assert.equal(edit.actBody!.sentence, `The issue #${i.number}: change its title and its description`);
    const np = await authorize(w, b, on("issue_edit", id, { number: i.number, state: "closed", reason: "not_planned" }));
    assert.equal(np.act?.status, 200, JSON.stringify(np.actBody));
    assert.deepEqual(np.actBody!.result.issues[0], { number: i.number, state: "closed", reason: "not_planned", labels: [], assignees: [] });
    const re = await authorize(w, b, on("issue_edit", id, { number: i.number, state: "open" }));
    assert.equal(re.actBody!.result.issues[0].state, "open");
    const dup = await authorize(w, b, on("issue_edit", id, { number: other.number, state: "closed", reason: "duplicate", duplicateOf: i.number }));
    assert.equal(dup.act?.status, 200, JSON.stringify(dup.actBody));
    assert.equal(dup.actBody!.sentence, `The issue #${other.number}: close it as a duplicate of #${i.number}`);
    assert.equal((await ada().issues.get(REF, other.number)).stateReason, "duplicate");
    assert.deepEqual((await ada().issues.comments(REF, other.number)).items.map((c) => c.body), [`Duplicate of #${i.number}`]);
    assert.equal(forgeRows(w.forge, "actions").length, 4);
  });

  test("labels added and removed from what GitHub has; assignees; a milestone set and cleared", async () => {
    const b = await signIn(w);
    const id = await repository();
    const i = await ada().issues.create(REF, { title: "x", labels: ["bug", "data"] });
    const m = await ada().issues.createMilestone(REF, { title: "v2" });
    const run = await authorize(w, b, on("issue_edit", id, { number: i.number, labels: { add: ["environment"], remove: ["bug"] }, assignees: { add: [ADA_LOGIN] }, milestone: m.number }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const now = await ada().issues.get(REF, i.number);
    assert.deepEqual(now.labels, ["data", "environment"]);
    assert.deepEqual(now.assignees, [ADA_LOGIN]);
    assert.equal(now.milestone, m.number);
    const cleared = await authorize(w, b, on("issue_edit", id, { number: i.number, milestone: null }));
    assert.equal(cleared.act?.status, 200);
    assert.equal((await ada().issues.get(REF, i.number)).milestone, null);
  });

  test("bulk: close several at once in ONE authorization; label several; a pull request refused", async () => {
    const b = await signIn(w);
    const id = await repository();
    const ns: number[] = [];
    for (let n = 0; n < 3; n++) ns.push((await ada().issues.create(REF, { title: `Issue ${n}` })).number);
    const run = await authorize(w, b, on("issue_edit", id, { numbers: ns, state: "closed", reason: "completed" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(run.actBody!.sentence, `The issues #${ns[0]}, #${ns[1]} and #${ns[2]}: close them as completed`);
    for (const n of ns) assert.equal((await ada().issues.get(REF, n)).state, "closed");
    const labelled = await authorize(w, b, on("issue_edit", id, { numbers: ns, labels: { add: ["wontfix"] } }));
    assert.equal(labelled.act?.status, 200, JSON.stringify(labelled.actBody));
    for (const n of ns) assert.deepEqual((await ada().issues.get(REF, n)).labels, ["wontfix"]);
    assert.equal(forgeRows(w.forge, "actions").length, 2);
  });

  test("validate: several issues take state, labels, assignees and milestones only; caps", () => {
    assert.ok(isProblem(validateIssueEdit({ numbers: [1, 2], title: "x" })));
    assert.ok(isProblem(validateIssueEdit({ numbers: [1, 2], type: "Bug" })));
    assert.ok(isProblem(validateIssueEdit({ numbers: Array.from({ length: BULK_ISSUES + 1 }, (_, i) => i + 1), state: "closed" })));
    assert.ok(!isProblem(validateIssueEdit({ numbers: Array.from({ length: BULK_ISSUES }, (_, i) => i + 1), state: "closed" })));
    assert.ok(isProblem(validateIssueEdit({ numbers: Array.from({ length: BULK_LABELLED + 1 }, (_, i) => i + 1), labels: { add: ["a"] } })));
    assert.ok(isProblem(validateIssueEdit({ number: 1 })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, reason: "completed" })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, state: "closed", reason: "wontfix" })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, state: "closed", reason: "duplicate", duplicateOf: 1 })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, state: "closed", duplicateOf: 2 })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, labels: { add: ["a"], remove: ["A"] } })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, labels: {} })));
    assert.ok(isProblem(validateIssueEdit({ number: 1, number2: 2, numbers: [1] })));
    const closed = validateIssueEdit({ number: 4, state: "closed" }) as IssueEditParsed;
    assert.equal(closed.reason, "completed");
    assert.equal(describeIssueEdit(closed), "The issue #4: close it as completed");
    const l = validateIssueEdit({ number: 4, labels: { add: ["a", "b"], remove: ["c"] }, assignees: { remove: ["bob"] }, type: null }) as IssueEditParsed;
    assert.equal(describeIssueEdit(l), "The issue #4: add the labels “a” and “b”; remove the label “c”; unassign bob; clear its type");
  });
});

describe("comments, reactions, lock, pin", () => {
  test("a comment, its edit and its deletion; someone else's refused", async () => {
    const b = await signIn(w);
    const id = await repository();
    const i = await ada().issues.create(REF, { title: "Question" });
    const c = await authorize(w, b, on("issue_comment", id, { number: i.number, body: "Which dataset?" }));
    assert.equal(c.act?.status, 200, JSON.stringify(c.actBody));
    const cid = c.actBody!.result.comment;
    assert.equal((await ada().issues.comments(REF, i.number)).items[0].body, "Which dataset?");
    const e = await authorize(w, b, on("issue_comment", id, { number: i.number, comment: cid, body: "Which dataset, exactly?" }));
    assert.equal(e.act?.status, 200, JSON.stringify(e.actBody));
    assert.equal(e.actBody!.sentence, `Edit your comment on the issue #${i.number}`);
    assert.equal((await ada().issues.comments(REF, i.number)).items[0].body, "Which dataset, exactly?");
    const bob = await signIn(w, "bob-fixture");
    const theirs = await authorize(w, bob, on("issue_comment", id, { number: i.number, comment: cid, body: "mine now" }), { login: "bob-fixture" });
    assert.equal(theirs.act?.status, 403);
    const d = await authorize(w, await signIn(w), on("issue_comment", id, { number: i.number, comment: cid, delete: true }));
    assert.equal(d.act?.status, 200, JSON.stringify(d.actBody));
    assert.deepEqual((await ada().issues.comments(REF, i.number)).items, []);
    assert.ok(isProblem(validateIssueComment({ number: 1, body: "  " })));
    assert.ok(isProblem(validateIssueComment({ number: 1, comment: "12", delete: true, body: "x" })));
    assert.ok(isProblem(validateIssueComment({ number: 1, delete: true })));
    assert.ok(isProblem(validateIssueComment({ number: 1, comment: "../1", body: "x" })));
  });

  test("a reaction added and taken back, on the issue and on a comment", async () => {
    const b = await signIn(w);
    const id = await repository();
    const i = await ada().issues.create(REF, { title: "Nice" });
    const c = await ada().issues.comment(REF, i.number, "Thanks");
    const run = await authorize(w, b, on("issue_react", id, { number: i.number, reaction: "hooray" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal((await ada().issues.get(REF, i.number)).reactions.hooray, 1);
    assert.equal(run.actBody!.sentence, `React with “hooray” on the issue #${i.number}`);
    const onComment = await authorize(w, b, on("issue_react", id, { number: i.number, comment: c.id, reaction: "+1" }));
    assert.equal(onComment.act?.status, 200, JSON.stringify(onComment.actBody));
    const back = await authorize(w, b, on("issue_react", id, { number: i.number, reaction: "hooray", remove: true }));
    assert.equal(back.act?.status, 200, JSON.stringify(back.actBody));
    assert.equal((await ada().issues.get(REF, i.number)).reactions.hooray, undefined);
    assert.equal(describeIssueReact({ number: 2, comment: "5", reaction: "+1", remove: true }), "Take back your “thumbs up” reaction on a comment of the issue #2");
    assert.ok(isProblem(validateIssueReact({ number: 1, reaction: "smile" })));
  });

  test("lock with a reason and unlock; pin three at most", async () => {
    const b = await signIn(w);
    const id = await repository();
    const i = await ada().issues.create(REF, { title: "Heated" });
    const lock = await authorize(w, b, on("issue_lock", id, { number: i.number, locked: true, reason: "too heated" }));
    assert.equal(lock.act?.status, 200, JSON.stringify(lock.actBody));
    assert.equal((await ada().issues.get(REF, i.number)).lockReason, "too heated");
    const unlock = await authorize(w, b, on("issue_lock", id, { number: i.number, locked: false }));
    assert.equal(unlock.actBody!.result.locked, false);
    assert.ok(isProblem(validateIssueLock({ number: 1, locked: false, reason: "spam" })));
    assert.ok(isProblem(validateIssueLock({ number: 1, locked: true, reason: "boring" })));
    const ns: number[] = [];
    for (let n = 0; n < 4; n++) ns.push((await ada().issues.create(REF, { title: `P${n}` })).number);
    for (const n of ns.slice(0, 3)) assert.equal((await authorize(w, b, on("issue_pin", id, { number: n, pinned: true }))).act?.status, 200);
    const fourth = await authorize(w, b, on("issue_pin", id, { number: ns[3], pinned: true }));
    assert.equal(fourth.act?.status, 409);
    assert.match(fourth.actBody?.error.message, /three issues at most/);
  });
});

describe("transfer, relationships, a branch", () => {
  test("transfer to another repository of the same account: a new number there", async () => {
    const b = await signIn(w);
    const id = await repository();
    await repository("eeg-data");
    const i = await ada().issues.create(REF, { title: "Belongs to the data" });
    const run = await authorize(w, b, on("issue_transfer", id, { number: i.number, to: "eeg-data" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const moved = run.actBody!.result.moved;
    assert.equal((await ada().issues.get({ ...REF, name: "eeg-data" }, moved)).title, "Belongs to the data");
    assert.equal(run.actBody!.result.page, `/r/ada-fixture/eeg-data/issues/${moved}`);
    const self = await authorize(w, b, on("issue_transfer", id, { number: moved, to: "eeg" }));
    assert.equal(self.act?.status, 400);
  });

  test("a sub-issue added and removed; blocked by and unblocked; a loop refused", async () => {
    const b = await signIn(w);
    const id = await repository();
    const parent = await ada().issues.create(REF, { title: "Campaign" });
    const child = await ada().issues.create(REF, { title: "Figure 2" });
    const add = await authorize(w, b, on("issue_relation", id, { number: parent.number, sub: { add: child.number } }));
    assert.equal(add.act?.status, 200, JSON.stringify(add.actBody));
    assert.deepEqual((await ada().issues.subIssues(REF, parent.number)).items.map((x) => x.number), [child.number]);
    const loop = await authorize(w, b, on("issue_relation", id, { number: child.number, sub: { add: parent.number } }));
    assert.equal(loop.act?.status, 422);
    const rm = await authorize(w, b, on("issue_relation", id, { number: parent.number, sub: { remove: child.number } }));
    assert.equal(rm.act?.status, 200);
    const block = await authorize(w, b, on("issue_relation", id, { number: child.number, blockedBy: { add: parent.number } }));
    assert.equal(block.act?.status, 200, JSON.stringify(block.actBody));
    assert.deepEqual((await ada().issues.blockedBy(REF, child.number)).items.map((x) => x.number), [parent.number]);
    assert.equal(describeIssueRelation({ number: 3, relation: "blockedBy", op: "add", other: 1 }), "Mark the issue #3 as blocked by #1");
    assert.ok(isProblem(validateIssueRelation({ number: 1, sub: { add: 1 } })));
    assert.ok(isProblem(validateIssueRelation({ number: 1, sub: { add: 2 }, blockedBy: { add: 3 } })));
    assert.ok(isProblem(validateIssueRelation({ number: 1, sub: { add: 2, remove: 3 } })));
  });

  test("create a branch for an issue, named as GitHub names it", async () => {
    const b = await signIn(w);
    const id = await repository();
    const i = await ada().issues.create(REF, { title: "Résultats différents: Table 2!" });
    const name = issueBranchName(i.number, i.title);
    assert.equal(name, `${i.number}-resultats-differents-table-2`);
    const run = await authorize(w, b, on("issue_branch", id, { number: i.number, name, from: "main" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(await ada().git.resolve(REF, name), await ada().git.resolve(REF, "main"));
    const again = await authorize(w, b, on("issue_branch", id, { number: i.number, name, from: "main" }));
    assert.equal(again.act?.status, 409);
    const other = await authorize(w, b, on("issue_branch", id, { number: i.number, name: "fix-it", from: "main" }));
    assert.equal(other.start.status, 200);
    assert.equal(other.act?.status, 400);
  });
});

describe("labels and milestones", () => {
  test("the default labels in ONE authorization; one that exists left as it is; change and delete", async () => {
    const b = await signIn(w);
    const id = await repository();
    await ada().issues.createLabel(REF, { name: "bug", color: "d73a4a", description: "" });
    const defaults = [
      { name: "bug", color: "b60205", description: "Something is not working" },
      { name: "data", color: "0e8a16", description: "The data the code reads or writes" },
      { name: "numerical difference", color: "fbca04", description: "Results differ from the paper's" },
    ];
    const run = await authorize(w, b, on("issue_labels", id, { create: defaults }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(run.actBody!.result.created, 2);
    assert.match(run.actBody!.result.notes.join(" "), /“bug” already exists/);
    assert.equal((await ada().issues.labels(REF)).items.find((l) => l.name === "bug")?.color, "d73a4a");
    const change = await authorize(w, b, on("issue_labels", id, { update: [{ name: "data", newName: "dataset", color: "1d76db" }], delete: ["bug"] }));
    assert.equal(change.act?.status, 200, JSON.stringify(change.actBody));
    const names = (await ada().issues.labels(REF)).items.map((l) => l.name).sort();
    assert.deepEqual(names, ["dataset", "numerical difference"]);
    assert.equal(forgeRows(w.forge, "actions").length, 2);
    const p = validateIssueLabels({ create: [{ name: "a", color: "ffffff" }], delete: ["b"] }) as IssueLabelsParsed;
    assert.equal(describeIssueLabels(p), "Create the label “a”; delete the label “b” (it leaves every issue and pull request that has it)");
    for (const x of [{}, { create: [{ name: "a", color: "red" }] }, { create: [{ name: "a", color: "ffffff" }], delete: ["A"] }, { update: [{ name: "a" }] }, { create: [{ name: "a", color: "ffffff", description: "x".repeat(101) }] }, { delete: Array.from({ length: 26 }, (_, i) => `l${i}`) }]) {
      assert.ok(isProblem(validateIssueLabels(x)), JSON.stringify(x));
    }
  });

  test("a milestone created, closed and deleted", async () => {
    const b = await signIn(w);
    const id = await repository();
    const c = await authorize(w, b, on("issue_milestone", id, { title: "Revision for the journal", dueOn: "2026-12-01" }));
    assert.equal(c.act?.status, 200, JSON.stringify(c.actBody));
    const n = c.actBody!.result.number;
    assert.equal(c.actBody!.sentence, "Create the milestone “Revision for the journal”, due on 2026-12-01");
    assert.equal(c.actBody!.result.page, `/r/ada-fixture/eeg/milestone/${n}`);
    const closed = await authorize(w, b, on("issue_milestone", id, { number: n, state: "closed" }));
    assert.equal(closed.act?.status, 200, JSON.stringify(closed.actBody));
    assert.equal((await ada().issues.milestones(REF, "all")).items[0].state, "closed");
    const d = await authorize(w, b, on("issue_milestone", id, { number: n, delete: true }));
    assert.equal(d.act?.status, 200, JSON.stringify(d.actBody));
    assert.deepEqual((await ada().issues.milestones(REF, "all")).items, []);
    for (const x of [{}, { number: 1 }, { title: "a\nb" }, { title: "x", dueOn: "next week" }, { number: 1, delete: true, title: "x" }, { number: 1, state: "done" }]) {
      assert.ok(isProblem(validateIssueMilestone(x)), JSON.stringify(x));
    }
  });
});

describe("the gate and the registry", () => {
  test("FORGE_OPEN unset: another account's issue refused at start, nothing written", async () => {
    const closed = forgeWorld({ env: { FORGE_OWNER_GITHUB_ID: "999999" } });
    try {
      const id = (await closed.backend.session({ kind: "user", token: closed.ada.token() }).repos.create({ name: "eeg", visibility: "public", autoInit: true })).key.id;
      const b = await signIn(closed);
      const run = await authorize(closed, b, on("issue_open", id, { title: "x" }));
      assert.equal(run.start.status, 403);
      assert.equal(run.startBody.error.code, "forge_closed");
      assert.equal(forgeRows(closed.forge, "actions").length, 0);
    } finally {
      closed.restore();
    }
  });

  test("registered in act-issues.ts, every kind in ACTION_KINDS, on no repository row", () => {
    assert.equal(ISSUE_ACTIONS.length, 11);
    for (const spec of ISSUE_ACTIONS) {
      assert.equal(ACTIONS.get(spec.kind), spec);
      assert.equal(REGISTERED_IN[spec.kind], "act-issues.ts");
      assert.ok(ACTION_KINDS.includes(spec.kind));
      assert.equal(spec.needsRepo, false);
      assert.ok(spec.checkTarget!({ kind: spec.kind, repo: null, branch: null, expectedHead: null }));
    }
  });

  test("the githubId helper names Bob", () => {
    assert.ok(/^\d+$/.test(githubId(w, "bob-fixture")));
  });
});
