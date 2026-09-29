// Pull requests as authorized actions (night phase 04, E1; act-pulls.ts, act-commit.ts's merge
// parent): through start, the double's GitHub and act, with the real registry. Each action is ONE act
// made by GitHub as the person, the action row the only row written, GitHub's refusals said in words;
// a head that moved refuses a merge; a conflict resolved in the browser is a commit with two parents.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import {
  BULK_PULLS,
  describePullEdit,
  describePullMerge,
  describePullOpen,
  describePullReview,
  isHead,
  numbersInWords,
  PULL_ACTIONS,
  validatePullComment,
  validatePullEdit,
  validatePullMerge,
  validatePullOpen,
  validatePullReview,
  type PullEditParsed,
  type PullMergeParsed,
  type PullOpenParsed,
  type PullReviewParsed,
} from "../../worker/forge/service/act-pulls.ts";
import { describeCommit, validateCommit, type CommitParsed } from "../../worker/forge/service/act-commit.ts";
import { text, utf8 } from "../../worker/forge/objects.ts";
import type { FileChange } from "../../worker/forge/types.ts";
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
const put = (path: string, content: string): FileChange => ({ op: "put", path, content: utf8(content) });
const read = async (path: string, rev = "main") => text((await ada().git.readFile(REF, rev, path)).bytes);

/** Ada's public repository on the double (not known to the registry: no repos row is needed). */
async function repository(): Promise<string> {
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  const head = await ada().git.resolve(REF, "main");
  await ada().git.createCommit(REF, { branch: "main", expectedHead: head, message: "The analysis", changes: [put("analysis.py", "a = 1\nb = 2\nc = 3\n"), put("README.md", "# EEG\n")] });
  return info.key.id;
}

/** A branch from main with one commit on it. */
async function branchWith(name: string, changes: FileChange[], from = "main"): Promise<string> {
  const base = await ada().git.resolve(REF, from);
  return (await ada().git.createCommit(REF, { branch: name, expectedHead: null, createFrom: base, changes, message: `Work on ${name}` })).sha;
}

const on = (kind: string, id: string, payload: Record<string, unknown>, extra: Partial<StartInput> = {}): StartInput => ({
  kind: kind as StartInput["kind"],
  repo: { forge: "memory", id },
  branch: null,
  expectedHead: null,
  payload,
  back: "/r/ada-fixture/eeg/pulls",
  ...extra,
});

async function opened(title = "Square the band power", branch = "work"): Promise<{ id: string; number: number; head: string }> {
  const id = await repository();
  const head = await branchWith(branch, [put("analysis.py", "a = 1\nb = 4\nc = 3\n")]);
  const pr = await ada().pulls.create(REF, { title, head: branch, base: "main" });
  return { id, number: pr.number, head };
}

describe("pull_open", () => {
  test("opens the pull request as Ada, asks a reviewer, writes the action row only; the token revoked", async () => {
    const b = await signIn(w);
    const id = await repository();
    await branchWith("work", [put("analysis.py", "a = 1\nb = 4\nc = 3\n")]);
    w.backend.repos.get(id)!.collaborators.set(githubId(w, "bob-fixture"), "write");
    const seen = watchAuth(w);
    w.forge.reset();
    const run = await authorize(w, b, on("pull_open", id, { base: "main", head: "work", title: "Square the band power", body: "Fixes #3.", reviewers: ["bob-fixture"] }, { branch: "main" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    const pr = await ada().pulls.get(REF, r.number);
    assert.equal(pr.title, "Square the band power");
    assert.equal(pr.author.login, ADA_LOGIN);
    assert.deepEqual(pr.requestedReviewers, ["bob-fixture"]);
    assert.equal(r.page, `/r/ada-fixture/eeg/pull/${r.number}`);
    assert.deepEqual(r.links[0], { href: `/r/ada-fixture/eeg/pull/${r.number}`, text: `The pull request #${r.number}` });
    assert.equal(run.actBody!.sentence, "Open the pull request “Square the band power” from work into main (asking bob-fixture to review it)");
    assert.equal(w.forge.totals.written, 1);
    const [row] = forgeRows(w.forge, "actions");
    assert.equal(row.kind, "pull_open");
    assert.equal(row.repo_id, id);
    await Promise.all(w.ctx.waited);
    assert.deepEqual(seen.revoked, seen.issued);
    assert.ok(!JSON.stringify(run.actBody).includes(seen.issued[0]));
  });

  test("a draft; one already open; a base other than the page's; a branch with nothing new", async () => {
    const b = await signIn(w);
    const id = await repository();
    await branchWith("work", [put("x.txt", "x\n")]);
    const draft = await authorize(w, b, on("pull_open", id, { base: "main", head: "work", title: "Draft", draft: true }, { branch: "main" }));
    assert.equal(draft.act?.status, 200, JSON.stringify(draft.actBody));
    assert.equal((await ada().pulls.get(REF, draft.actBody!.result.number)).draft, true);
    assert.match(draft.actBody!.result.notes.join(" "), /draft/);
    const again = await authorize(w, b, on("pull_open", id, { base: "main", head: "work", title: "Again" }, { branch: "main" }));
    assert.equal(again.act?.status, 409);
    assert.equal(again.actBody?.error.code, "already_open");
    const other = await authorize(w, b, on("pull_open", id, { base: "main", head: "work", title: "x" }, { branch: "dev" }));
    assert.equal(other.act?.status, 400);
    const noTarget = await authorize(w, b, on("pull_open", id, { base: "main", head: "work", title: "x" }));
    assert.equal(noTarget.start.status, 400);
    assert.equal(forgeRows(w.forge, "actions").length, 1);
  });
});

describe("pull_edit", () => {
  test("title and description; close and reopen; draft and ready; reviewers asked and removed", async () => {
    const b = await signIn(w);
    const { id, number } = await opened();
    w.backend.repos.get(id)!.collaborators.set(githubId(w, "bob-fixture"), "read");
    const edit = await authorize(w, b, on("pull_edit", id, { number, title: "Square it", body: "Better." }));
    assert.equal(edit.act?.status, 200, JSON.stringify(edit.actBody));
    assert.equal((await ada().pulls.get(REF, number)).title, "Square it");
    assert.equal(edit.actBody!.sentence, `The pull request #${number}: change its title, its description`);
    const closed = await authorize(w, b, on("pull_edit", id, { number, state: "closed" }));
    assert.equal(closed.act?.status, 200, JSON.stringify(closed.actBody));
    assert.equal((await ada().pulls.get(REF, number)).state, "closed");
    const reopened = await authorize(w, b, on("pull_edit", id, { number, state: "open" }));
    assert.equal(reopened.actBody!.result.pulls[0].state, "open");
    const draft = await authorize(w, b, on("pull_edit", id, { number, draft: true }));
    assert.equal(draft.actBody!.result.pulls[0].draft, true);
    const ready = await authorize(w, b, on("pull_edit", id, { number, draft: false }));
    assert.equal(ready.actBody!.result.pulls[0].draft, false);
    await authorize(w, b, on("pull_edit", id, { number, reviewers: { add: ["bob-fixture"] } }));
    assert.deepEqual((await ada().pulls.get(REF, number)).requestedReviewers, ["bob-fixture"]);
    await authorize(w, b, on("pull_edit", id, { number, reviewers: { remove: ["bob-fixture"] } }));
    assert.deepEqual((await ada().pulls.get(REF, number)).requestedReviewers, []);
    assert.ok(forgeRows(w.forge, "actions").every((r) => r.kind === "pull_edit" && r.rows === 1));
  });

  test("several closed at once (one authorization), then the head branch deleted and restored", async () => {
    const b = await signIn(w);
    const { id, number } = await opened();
    await branchWith("two", [put("two.txt", "2\n")]);
    const second = (await ada().pulls.create(REF, { title: "Two", head: "two", base: "main" })).number;
    const bulk = await authorize(w, b, on("pull_edit", id, { numbers: [number, second], state: "closed" }));
    assert.equal(bulk.act?.status, 200, JSON.stringify(bulk.actBody));
    assert.equal(bulk.actBody!.sentence, `Close the pull requests #${number} and #${second}`);
    assert.deepEqual((await ada().pulls.list(REF, { state: "closed" })).items.map((p) => p.number).sort(), [number, second].sort());
    assert.equal(forgeRows(w.forge, "actions").length, 1);
    const del = await authorize(w, b, on("pull_edit", id, { number, headBranch: "delete" }));
    assert.equal(del.act?.status, 200, JSON.stringify(del.actBody));
    await assert.rejects(ada().git.getBranch(REF, "work"));
    const restored = await authorize(w, b, on("pull_edit", id, { number, headBranch: "restore" }));
    assert.equal(restored.act?.status, 200, JSON.stringify(restored.actBody));
    assert.equal((await ada().git.getBranch(REF, "work")).sha, (await ada().pulls.get(REF, number)).head.sha);
  });

  test("an open pull request's branch is not deleted; auto-merge needs the repository's setting", async () => {
    const b = await signIn(w);
    const { id, number } = await opened();
    const del = await authorize(w, b, on("pull_edit", id, { number, headBranch: "delete" }));
    assert.equal(del.act?.status, 409);
    assert.equal(del.actBody?.error.code, "still_open");
    const auto = await authorize(w, b, on("pull_edit", id, { number, autoMerge: "squash" }));
    assert.equal(auto.act?.status, 422);
    assert.equal(auto.actBody?.error.code, "auto_merge");
    w.backend.repos.get(id)!.features.autoMerge = true;
    const on2 = await authorize(w, b, on("pull_edit", id, { number, autoMerge: "squash" }));
    assert.equal(on2.act?.status, 200, JSON.stringify(on2.actBody));
    assert.equal((await ada().pulls.get(REF, number)).autoMerge, "squash");
    assert.match(on2.actBody!.sentence, /enable auto-merge \(squash and merge\)/);
  });
});

describe("pull_review, pull_comment, pull_thread", () => {
  test("Bob approves; Ada may not approve her own; a line comment with a suggestion; a reply; a conversation resolved", async () => {
    await signIn(w);
    const { id, number, head } = await opened();
    const bobId = githubId(w, "bob-fixture");
    w.backend.repos.get(id)!.collaborators.set(bobId, "write");
    const bob = await signIn(w, "bob-fixture");
    const suggestion = "Keep it a square:\n```suggestion\nb = 2 ** 2\n```";
    const review = await authorize(w, bob, on("pull_review", id, { number, commit: head, event: "APPROVE", body: "Good.", comments: [{ path: "analysis.py", line: 2, body: suggestion }] }), { login: "bob-fixture" });
    assert.equal(review.act?.status, 200, JSON.stringify(review.actBody));
    assert.equal(review.actBody!.result.review.state, "APPROVED");
    assert.equal(review.actBody!.sentence, `Approve the pull request #${number} at ${head.slice(0, 7)}, with 1 line comment (1 suggested change)`);
    const comments = (await ada().pulls.comments(REF, number)).items;
    assert.equal(comments.length, 1);
    assert.equal(comments[0].author.login, "bob-fixture");
    assert.match(comments[0].body, /```suggestion/);

    const own = await signIn(w);
    const selfApprove = await authorize(w, own, on("pull_review", id, { number, commit: head, event: "APPROVE" }));
    assert.equal(selfApprove.act?.status, 422);
    assert.equal(selfApprove.actBody?.error.code, "own_pull");

    const reply = await authorize(w, own, on("pull_comment", id, { number, body: "Applied, thanks.", replyTo: comments[0].id }));
    assert.equal(reply.act?.status, 200, JSON.stringify(reply.actBody));
    assert.equal((await ada().pulls.comments(REF, number)).items.length, 2);
    const talk = await authorize(w, own, on("pull_comment", id, { number, body: "Merging tomorrow." }));
    assert.equal(talk.act?.status, 200, JSON.stringify(talk.actBody));
    assert.equal((await ada().issues.comments(REF, number)).items.length, 1);

    const resolve = await authorize(w, own, on("pull_thread", id, { number, comment: comments[0].id, resolved: true }));
    assert.equal(resolve.act?.status, 200, JSON.stringify(resolve.actBody));
    assert.equal(resolve.actBody!.result.resolved, true);
    assert.equal((await ada().pulls.threads(REF, number)).items[0].resolved, true);
    const missing = await authorize(w, own, on("pull_thread", id, { number, comment: "999999", resolved: true }));
    assert.equal(missing.act?.status, 404);
    // Six actions attempted by act, four recorded (the refusals write nothing).
    assert.equal(forgeRows(w.forge, "actions").length, 4);
  });

  test("a line comment on a line the pull request does not show is refused in words, nothing posted", async () => {
    const b = await signIn(w);
    const { id, number, head } = await opened();
    const run = await authorize(w, b, on("pull_review", id, { number, commit: head, event: "COMMENT", comments: [{ path: "nowhere.py", line: 1, body: "?" }] }));
    assert.equal(run.act?.status, 422, JSON.stringify(run.actBody));
    assert.equal(run.actBody?.error.code, "not_reviewed");
    assert.equal((await ada().pulls.comments(REF, number)).items.length, 0);
  });
});

describe("pull_merge, pull_update, pull_revert", () => {
  test("merges at the head the page saw; a head that moved is refused; the branch deleted after", async () => {
    const b = await signIn(w);
    const { id, number, head } = await opened();
    const moved = (await ada().git.createCommit(REF, { branch: "work", expectedHead: head, message: "More", changes: [put("more.txt", "m\n")] })).sha;
    const stale = await authorize(w, b, on("pull_merge", id, { number, method: "merge", head }, { expectedHead: head }));
    assert.equal(stale.act?.status, 409);
    assert.equal(stale.actBody?.error.offer, "reload");
    assert.equal((await ada().pulls.get(REF, number)).merged, false);
    const run = await authorize(w, b, on("pull_merge", id, { number, method: "squash", head: moved, title: "Square the band power (#1)", deleteBranch: true }, { expectedHead: moved }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const pr = await ada().pulls.get(REF, number);
    assert.equal(pr.merged, true);
    assert.equal(await ada().git.resolve(REF, "main"), run.actBody!.result.sha);
    assert.equal(run.actBody!.result.branchDeleted, true);
    await assert.rejects(ada().git.getBranch(REF, "work"));
    assert.equal(await read("analysis.py"), "a = 1\nb = 4\nc = 3\n");
    assert.equal(run.actBody!.sentence, `Merge the pull request #${number} (squash and merge) at ${moved.slice(0, 7)}, then delete its branch`);
    assert.equal(forgeRows(w.forge, "actions").length, 1);

    const revert = await authorize(w, b, on("pull_revert", id, { number }));
    assert.equal(revert.act?.status, 200, JSON.stringify(revert.actBody));
    const r = revert.actBody!.result;
    assert.ok(r.revert > number);
    assert.match((await ada().pulls.get(REF, r.revert)).title, /^Revert/);
    assert.equal(r.page, `/r/ada-fixture/eeg/pull/${r.revert}`);
  });

  test("conflicts: GitHub will not merge (409, offer conflicts); resolved in the browser as a commit with two parents, then merged", async () => {
    const b = await signIn(w);
    const { id, number, head } = await opened();
    // main changes the same line meanwhile.
    const main0 = await ada().git.resolve(REF, "main");
    const main1 = (await ada().git.createCommit(REF, { branch: "main", expectedHead: main0, message: "Other", changes: [put("analysis.py", "a = 1\nb = 3\nc = 3\n"), put("NEWS.md", "news\n")] })).sha;
    assert.equal((await ada().pulls.get(REF, number)).mergeable, false);
    const refused = await authorize(w, b, on("pull_merge", id, { number, method: "merge", head }, { expectedHead: head }));
    assert.equal(refused.act?.status, 409);
    assert.equal(refused.actBody?.error.code, "not_mergeable");
    assert.equal(refused.actBody?.error.offer, "conflicts");
    const update = await authorize(w, b, on("pull_update", id, { number, head }));
    assert.equal(update.act?.status, 409);
    assert.equal(update.actBody?.error.offer, "conflicts");
    // The browser's resolution: the conflicting file resolved, the base's own new file taken.
    const resolution = {
      branch: "work",
      base: head,
      mergeParent: main1,
      message: "Merge branch 'main' into work",
      changes: [
        { op: "put", path: "analysis.py", text: "a = 1\nb = 4\nc = 3\n" },
        { op: "put", path: "NEWS.md", text: "news\n" },
      ],
    };
    const done = await authorize(w, b, { kind: "commit", repo: { forge: "memory", id }, branch: "work", expectedHead: head, payload: resolution, back: `/r/ada-fixture/eeg/pull/${number}/conflicts` });
    assert.equal(done.act?.status, 200, JSON.stringify(done.actBody));
    assert.equal(done.actBody!.result.merged, main1);
    assert.equal(done.actBody!.sentence, `Commit “Merge branch 'main' into work” to the branch work, merging ${main1.slice(0, 7)} into it (2 files written)`);
    const tip = await ada().git.commit(REF, done.actBody!.result.sha);
    assert.deepEqual(tip.parents, [head, main1]);
    const pr = await ada().pulls.get(REF, number);
    assert.equal(pr.mergeable, true);
    const merged = await authorize(w, b, on("pull_merge", id, { number, method: "merge", head: pr.head.sha }, { expectedHead: pr.head.sha }));
    assert.equal(merged.act?.status, 200, JSON.stringify(merged.actBody));
    assert.equal(await read("analysis.py"), "a = 1\nb = 4\nc = 3\n");
    assert.equal(await read("NEWS.md"), "news\n");
  });

  test("a resolution that keeps the branch's every line: a merge commit with no file written", async () => {
    const b = await signIn(w);
    const { id, number, head } = await opened();
    const main0 = await ada().git.resolve(REF, "main");
    const main1 = (await ada().git.createCommit(REF, { branch: "main", expectedHead: main0, message: "Other", changes: [put("analysis.py", "a = 1\nb = 3\nc = 3\n")] })).sha;
    const done = await authorize(w, b, { kind: "commit", repo: { forge: "memory", id }, branch: "work", expectedHead: head, payload: { branch: "work", base: head, mergeParent: main1, message: "Merge branch 'main' into work", changes: [] }, back: "/" });
    assert.equal(done.act?.status, 200, JSON.stringify(done.actBody));
    assert.match(done.actBody!.sentence, /no file changed beyond the merge/);
    assert.equal((await ada().pulls.get(REF, number)).mergeable, true);
  });

  test("update branch: GitHub merges the base into the head when they do not conflict", async () => {
    const b = await signIn(w);
    const { id, number, head } = await opened();
    const main0 = await ada().git.resolve(REF, "main");
    await ada().git.createCommit(REF, { branch: "main", expectedHead: main0, message: "Other", changes: [put("NEWS.md", "news\n")] });
    const run = await authorize(w, b, on("pull_update", id, { number, head }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const pr = await ada().pulls.get(REF, number);
    assert.notEqual(pr.head.sha, head);
    assert.equal(await read("NEWS.md", "work"), "news\n");
  });
});

describe("suggestions applied on a fork's pull request (Allow edits by maintainers)", () => {
  test("Ada commits Bob's suggestion to his fork's branch while the pull request allows it; refused when it does not", async () => {
    const b = await signIn(w);
    const id = await repository();
    const bobId = githubId(w, "bob-fixture");
    // Bob's fork and branch, made through the double as Bob.
    const bobSession = () => w.backend.session({ kind: "user", token: w.backend.issueToken(bobId) });
    const { repo: fork } = await bobSession().repos.fork(REF);
    const base = await bobSession().git.resolve(fork.ref, "main");
    const head = (await bobSession().git.createCommit(fork.ref, { branch: "tweak", expectedHead: null, createFrom: base, message: "Tweak", changes: [put("analysis.py", "a = 1\nb = 5\nc = 3\n")] })).sha;
    const pr = await bobSession().pulls.create(REF, { title: "Tweak", head: "bob-fixture:tweak", base: "main", maintainerCanModify: true });
    const payload = { branch: "tweak", base: head, message: "Apply suggestion from code review", coAuthors: [{ login: "bob-fixture", id: bobId }], changes: [{ op: "put", path: "analysis.py", text: "a = 1\nb = 25\nc = 3\n" }] };
    const done = await authorize(w, b, { kind: "commit", repo: { forge: "memory", owner: "bob-fixture", name: "eeg" }, branch: "tweak", expectedHead: head, payload, back: `/r/ada-fixture/eeg/pull/${pr.number}/files` });
    assert.equal(done.act?.status, 200, JSON.stringify(done.actBody));
    assert.equal(text((await ada().git.readFile(fork.ref, "tweak", "analysis.py")).bytes), "a = 1\nb = 25\nc = 3\n");
    assert.match((await ada().git.commit(fork.ref, done.actBody!.result.sha)).message, /Co-authored-by: bob-fixture <\d+\+bob-fixture@users\.noreply\.github\.com>/);
    // The pull request no longer allows it: GitHub refuses, said with the offer to propose.
    w.backend.repos.get(id)!.issues.get(pr.number)!.pull!.maintainerCanModify = false;
    const now = await ada().git.resolve(fork.ref, "tweak");
    const refused = await authorize(w, b, { kind: "commit", repo: { forge: "memory", owner: "bob-fixture", name: "eeg" }, branch: "tweak", expectedHead: now, payload: { ...payload, base: now }, back: "/" });
    assert.equal(refused.act?.status, 403, JSON.stringify(refused.actBody));
    assert.equal(refused.actBody?.error.offer, "propose");
  });
});

describe("the payloads (validate, describe)", () => {
  test("pull_open", () => {
    const ok = validatePullOpen({ base: "main", head: "bob:fix-1", title: " Fix it ", body: "a\r\nb", reviewers: ["ada"] }) as PullOpenParsed;
    assert.equal(isProblem(ok), false);
    assert.equal(ok.title, "Fix it");
    assert.equal(ok.body, "a\nb");
    assert.equal(ok.maintainerCanModify, true);
    assert.equal(describePullOpen(ok), "Open the pull request “Fix it” from bob:fix-1 into main (asking ada to review it)");
    for (const bad of [
      null,
      { base: "main", head: "main", title: "x" },
      { base: "main", head: "work", title: "" },
      { base: "main", head: "work", title: "two\nlines" },
      { base: "main", head: "bad owner:work", title: "x" },
      { base: "refs/heads/main", head: "work", title: "x" },
      { base: "main", head: "work", title: "x", reviewers: ["a", "A"] },
      { base: "main", head: "work", title: "x", reviewers: Array.from({ length: 16 }, (_, i) => `r${i}`) },
      { base: "main", head: "work", title: "x", draft: "yes" },
      { base: "main", head: "work", title: "x", body: "x".repeat(70_000) },
    ]) {
      assert.ok(isProblem(validatePullOpen(bad)), JSON.stringify(bad).slice(0, 80));
    }
    assert.ok(isHead("work") && isHead("ada:work/x") && !isHead(":work") && !isHead("a:b:c/.."));
  });

  test("pull_edit", () => {
    const one = validatePullEdit({ number: 3, state: "closed" }) as PullEditParsed;
    assert.equal(describePullEdit(one), "The pull request #3: close it");
    assert.equal(describePullEdit(validatePullEdit({ numbers: [3, 4, 7], state: "open" }) as PullEditParsed), "Reopen the pull requests #3, #4 and #7");
    assert.equal(describePullEdit(validatePullEdit({ number: 3, headBranch: "restore" }) as PullEditParsed), "Restore the head branch of the pull request #3");
    assert.equal(describePullEdit(validatePullEdit({ number: 3, draft: false, reviewers: { add: ["a", "b"] } }) as PullEditParsed), "The pull request #3: mark it ready for review; ask a and b to review it");
    assert.equal(describePullEdit(validatePullEdit({ number: 3, autoMerge: null }) as PullEditParsed), "The pull request #3: disable auto-merge");
    for (const bad of [
      { number: 3 },
      { number: 0, state: "closed" },
      { numbers: [], state: "closed" },
      { numbers: Array.from({ length: BULK_PULLS + 1 }, (_, i) => i + 1), state: "closed" },
      { numbers: [1, 2], title: "x" },
      { number: 1, numbers: [2], state: "closed" },
      { number: 1, state: "merged" },
      { number: 1, headBranch: "delete", state: "closed" },
      { number: 1, autoMerge: "fast" },
      { number: 1, reviewers: { add: ["a"], remove: ["A"] } },
    ]) {
      assert.ok(isProblem(validatePullEdit(bad)), JSON.stringify(bad));
    }
    assert.equal(numbersInWords([1]), "#1");
  });

  test("pull_review", () => {
    const sha = "a".repeat(40);
    const p = validatePullReview({ number: 2, commit: sha, event: "COMMENT", comments: [{ path: "a.py", line: 5, startLine: 3, body: "```suggestion\nx\n```" }] }) as PullReviewParsed;
    assert.equal(p.suggestions, 1);
    assert.equal(p.comments[0].startSide, "RIGHT");
    assert.equal(describePullReview(p), "Comment on a line of the pull request #2 at aaaaaaa: a suggested change");
    assert.equal(describePullReview(validatePullReview({ number: 2, commit: sha, event: "REQUEST_CHANGES", body: "No." }) as PullReviewParsed), "Request changes on the pull request #2 at aaaaaaa");
    for (const bad of [
      { number: 2, commit: sha, event: "COMMENT" },
      { number: 2, commit: "abc", event: "APPROVE" },
      { number: 2, commit: sha, event: "LGTM" },
      { number: 2, commit: sha, event: "COMMENT", comments: [{ path: "../x", line: 1, body: "x" }] },
      { number: 2, commit: sha, event: "COMMENT", comments: [{ path: "a.py", line: 3, startLine: 3, body: "x" }] },
      { number: 2, commit: sha, event: "COMMENT", comments: [{ path: "a.py", line: 3, side: "LEFT", body: "```suggestion\nx\n```" }] },
      { number: 2, commit: sha, event: "COMMENT", comments: [{ path: "a.py", line: 3, body: " " }] },
    ]) {
      assert.ok(isProblem(validatePullReview(bad)), JSON.stringify(bad));
    }
  });

  test("pull_merge, pull_comment, and the commit's merge parent", () => {
    const sha = "b".repeat(40);
    assert.equal(describePullMerge(validatePullMerge({ number: 4, method: "merge", head: sha }) as PullMergeParsed), "Merge the pull request #4 (a merge commit) at bbbbbbb");
    assert.ok(isProblem(validatePullMerge({ number: 4, method: "rebase", head: sha, title: "x" })));
    assert.ok(isProblem(validatePullMerge({ number: 4, method: "octopus", head: sha })));
    assert.ok(isProblem(validatePullComment({ number: 4, body: "" })));
    assert.ok(isProblem(validatePullComment({ number: 4, body: "x", replyTo: "abc" })));
    const base = { branch: "work", base: "a".repeat(40), message: "Merge branch 'main' into work", changes: [] };
    const merge = validateCommit({ ...base, mergeParent: sha }) as CommitParsed;
    assert.equal(merge.mergeParent, sha);
    assert.equal(describeCommit(merge), "Commit “Merge branch 'main' into work” to the branch work, merging bbbbbbb into it (no file changed beyond the merge)");
    assert.ok(isProblem(validateCommit(base)), "an ordinary commit still changes a file");
    assert.ok(isProblem(validateCommit({ ...base, mergeParent: base.base })));
    assert.ok(isProblem(validateCommit({ ...base, mergeParent: sha, newBranch: "x" })));
    assert.ok(isProblem(validateCommit({ ...base, mergeParent: "short" })));
  });

  test("registered in act-pulls.ts, every kind in ACTION_KINDS, on no repository row", () => {
    for (const spec of PULL_ACTIONS) {
      assert.equal(ACTIONS.get(spec.kind), spec);
      assert.equal(REGISTERED_IN[spec.kind], "act-pulls.ts");
      assert.ok(ACTION_KINDS.includes(spec.kind));
      assert.equal(spec.needsRepo, false);
      assert.ok(spec.checkTarget!({ kind: spec.kind, repo: null, branch: "main", expectedHead: null }));
    }
  });
});
