// One web commit as an authorized action (night phase 03, E1; act-commit.ts): through start, the
// double's GitHub and act, with the real registry. The file changes as asked, as the person, in ONE
// commit whose parent is the head the page saw; the action row is the only row written; a branch that
// moved is refused (409, offer new_branch) and nothing is recorded; a new branch starts at that head
// (phase 04's pull request hook); trailers are the registry's own (co-authors' and the signer's
// GitHub no-reply addresses); a person who may not write proposes the change from a fork.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { COMMIT_ACTIONS, commitMessage, commitSpec, describeCommit, validateCommit, type CommitParsed } from "../../worker/forge/service/act-commit.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { base64, text, utf8 } from "../../worker/forge/objects.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { authorize, githubId, signIn, watchAuth } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });
const read = async (path: string, rev = "main") => text((await ada().git.readFile(REF, rev, path)).bytes);
const exists = async (path: string, rev = "main") => ada().git.readFile(REF, rev, path).then(() => true, () => false);

/** Ada's repository on the double, with a few files; NOT known to the registry (no repos row): a
 *  commit needs none. Returns its id and the head of main. */
async function repository(): Promise<{ id: string; head: string }> {
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  const head0 = await ada().git.resolve(REF, "main");
  await ada().git.createCommit(REF, {
    branch: "main",
    expectedHead: head0,
    message: "The analysis",
    changes: [
      { op: "put", path: "analysis.py", content: utf8("import numpy\n\ndef band_power(x):\n    return x\n") },
      { op: "put", path: "run.sh", content: utf8("#!/bin/sh\npython analysis.py\n"), executable: true },
      { op: "put", path: "docs/guide.md", content: utf8("# Guide\n") },
    ],
  });
  return { id: info.key.id, head: await ada().git.resolve(REF, "main") };
}

const commit = (id: string, head: string, payload: Record<string, unknown>, branch = "main"): StartInput => ({
  kind: "commit",
  repo: { forge: "memory", id },
  branch,
  expectedHead: head,
  payload: { branch, base: head, message: "Update analysis.py", ...payload },
  back: "/r/ada-fixture/eeg/blob/main/analysis.py",
});

describe("a web commit", () => {
  test("an edit: one commit as Ada, its parent the head the page saw; the action row only; the token revoked", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const seen = watchAuth(w);
    w.forge.reset();
    const run = await authorize(w, b, commit(id, head, { changes: [{ op: "put", path: "analysis.py", text: "import numpy\n\ndef band_power(x):\n    return x ** 2\n" }] }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.match(await read("analysis.py"), /x \*\* 2/);
    const now = await ada().git.resolve(REF, "main");
    assert.equal(r.sha, now);
    assert.equal(r.branch, "main");
    assert.deepEqual(r.base, { branch: "main", sha: head });
    assert.equal(r.newBranch, false);
    assert.equal(r.pullRequest, null);
    assert.equal(r.page, `/r/ada-fixture/eeg/commit/${now}/`);
    const c = await ada().git.commit(REF, now);
    assert.equal(c.author?.login, ADA_LOGIN);
    assert.deepEqual(c.parents, [head]);
    assert.equal(c.message, "Update analysis.py");
    assert.equal(run.actBody!.sentence, "Commit “Update analysis.py” to the branch main (1 file written)");
    // One row: the action's own, kind commit, on the repository's id.
    assert.equal(w.forge.totals.written, 1);
    const [row] = forgeRows(w.forge, "actions");
    assert.equal(row.kind, "commit");
    assert.equal(row.repo_id, id);
    assert.equal(row.rows, 1);
    await Promise.all(w.ctx.waited);
    assert.deepEqual(seen.revoked, seen.issued);
    assert.ok(!JSON.stringify(run.actBody).includes(seen.issued[0]));
  });

  test("create, delete and move in one commit; an executable file keeps its bit; bytes as base64", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const run = await authorize(
      w,
      b,
      commit(id, head, {
        message: "Reorganize",
        changes: [
          { op: "put", path: "src/new.py", text: "print(1)\n" },
          { op: "put", path: "figures/f.png", base64: base64(png) },
          { op: "delete", path: "docs/guide.md" },
          { op: "move", from: "analysis.py", to: "src/analysis.py" },
          { op: "put", path: "run.sh", text: "#!/bin/sh\npython src/analysis.py\n", executable: true },
        ],
      }),
    );
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(await read("src/new.py"), "print(1)\n");
    assert.deepEqual([...(await ada().git.readFile(REF, "main", "figures/f.png")).bytes], [...png]);
    assert.equal(await exists("docs/guide.md"), false);
    assert.equal(await exists("analysis.py"), false);
    assert.match(await read("src/analysis.py"), /band_power/);
    const tree = await ada().git.tree(REF, "main", { recursive: true });
    assert.equal(tree.entries.find((e) => e.path === "run.sh")?.mode, "100755");
    assert.match(run.actBody!.sentence, /3 files written, 1 file moved, 1 file deleted/);
    assert.equal(w.forge.totals.written, 1);
  });

  test("the branch moved since the page read it: 409 conflict, offer new_branch, nothing recorded, the branch as it was", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    let moved = "";
    w.forge.reset();
    const run = await authorize(w, b, commit(id, head, { changes: [{ op: "put", path: "analysis.py", text: "mine\n" }] }), {
      between: async () => {
        await ada().git.createCommit(REF, { branch: "main", expectedHead: head, message: "Someone else", changes: [{ op: "put", path: "other.txt", content: utf8("x\n") }] });
        moved = await ada().git.resolve(REF, "main");
      },
    });
    assert.equal(run.act?.status, 409, JSON.stringify(run.actBody));
    assert.equal(run.actBody?.error.code, "conflict");
    assert.equal(run.actBody?.error.offer, "new_branch");
    assert.equal(await ada().git.resolve(REF, "main"), moved);
    assert.match(await read("analysis.py"), /band_power/);
    assert.equal(w.forge.totals.written, 0);
    // The same change on a new branch from the head the page saw: accepted.
    const again = await authorize(w, b, commit(id, head, { newBranch: "ada-patch-1", changes: [{ op: "put", path: "analysis.py", text: "mine\n" }] }));
    assert.equal(again.act?.status, 200, JSON.stringify(again.actBody));
    assert.equal(await read("analysis.py", "ada-patch-1"), "mine\n");
    assert.equal(await ada().git.resolve(REF, "main"), moved);
  });

  test("a new branch: made at the head seen, the commit on it; the comparison and phase 04's pull request hook", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const run = await authorize(w, b, commit(id, head, { newBranch: "fix/units", changes: [{ op: "put", path: "analysis.py", text: "fixed\n" }] }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.equal(r.branch, "fix/units");
    assert.equal(r.newBranch, true);
    assert.equal(r.compare, "/r/ada-fixture/eeg/compare/main...fix/units/");
    assert.deepEqual(r.pullRequest, { repo: "ada-fixture/eeg", base: "main", head: "fix/units" });
    assert.equal(await ada().git.resolve(REF, "main"), head);
    assert.deepEqual((await ada().git.commit(REF, r.sha)).parents, [head]);
    assert.match(run.actBody!.sentence, /on a new branch fix\/units, from main/);
    // The same name again: refused in words.
    const clash = await authorize(w, b, commit(id, head, { newBranch: "fix/units", changes: [{ op: "put", path: "analysis.py", text: "again\n" }] }));
    assert.equal(clash.act?.status, 409);
    assert.equal(clash.actBody?.error.code, "branch_exists");
  });

  test("a payload prepared for another branch or head, or a target without a head: refused, nothing done", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const other = await authorize(w, b, { ...commit(id, head, { changes: [{ op: "put", path: "a.txt", text: "a\n" }] }), payload: { branch: "main", base: "f".repeat(40), message: "x", changes: [{ op: "put", path: "a.txt", text: "a\n" }] } });
    assert.equal(other.act?.status, 400);
    assert.equal(await exists("a.txt"), false);
    const headless = await authorize(w, b, { ...commit(id, head, { changes: [{ op: "put", path: "a.txt", text: "a\n" }] }), expectedHead: null });
    assert.equal(headless.start.status, 400);
  });

  test("trailers: co-authors and the sign-off with GitHub's no-reply addresses; a repository that requires it signs off", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    const adaId = githubId(w, ADA_LOGIN);
    const run = await authorize(
      w,
      b,
      commit(id, head, {
        message: "Fix the units",
        description: "The band power was in µV, not V.",
        coAuthors: [{ login: "grace-h", id: "4242" }],
        signOff: true,
        changes: [{ op: "put", path: "analysis.py", text: "v2\n" }],
      }),
    );
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const message = (await ada().git.commit(REF, run.actBody!.result.sha)).message;
    assert.equal(
      message,
      `Fix the units\n\nThe band power was in µV, not V.\n\nCo-authored-by: grace-h <4242+grace-h@users.noreply.github.com>\nSigned-off-by: ${ADA_LOGIN} <${adaId}+${ADA_LOGIN}@users.noreply.github.com>`,
    );
    w.backend.requireSignoff(REF);
    const head2 = await ada().git.resolve(REF, "main");
    const required = await authorize(w, b, commit(id, head2, { message: "Again", changes: [{ op: "put", path: "analysis.py", text: "v3\n" }] }));
    assert.equal(required.act?.status, 200, JSON.stringify(required.actBody));
    assert.match((await ada().git.commit(REF, required.actBody!.result.sha)).message, /\n\nSigned-off-by: ada-fixture </);
    assert.match(required.actBody!.result.notes.join(" "), /signed off/);
  });

  test("propose changes: a person who may not write gets a fork and a branch there; without propose, 403 offer propose", async () => {
    w = forgeWorld({ env: { FORGE_OPEN: "true" } });
    await signIn(w);
    const { id, head } = await repository();
    const bob = await signIn(w, "bob-fixture");
    const refused = await authorize(w, bob, commit(id, head, { changes: [{ op: "put", path: "analysis.py", text: "bob\n" }] }), { login: "bob-fixture" });
    assert.equal(refused.act?.status, 403, JSON.stringify(refused.actBody));
    assert.equal(refused.actBody?.error.offer, "propose");
    const run = await authorize(w, bob, commit(id, head, { propose: true, changes: [{ op: "put", path: "analysis.py", text: "bob\n" }] }), { login: "bob-fixture" });
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.equal(r.proposed, true);
    assert.equal(r.owner, "bob-fixture");
    assert.equal(r.branch, `bob-fixture-patch-${head.slice(0, 7)}`);
    assert.equal(r.compare, `/r/ada-fixture/eeg/compare/main...bob-fixture:bob-fixture-patch-${head.slice(0, 7)}/`);
    assert.deepEqual(r.pullRequest, { repo: "ada-fixture/eeg", base: "main", head: `bob-fixture:${r.branch}` });
    assert.equal(await ada().git.resolve(REF, "main"), head);
    const fork = { forge: "memory" as const, owner: "bob-fixture", name: "eeg" };
    assert.equal(text((await ada().git.readFile(fork, r.branch, "analysis.py")).bytes), "bob\n");
    assert.equal(forgeRows(w.forge, "actions").filter((a) => a.kind === "commit").length, 1);
  });

  test("a private repository is refused (the registry works on public ones)", async () => {
    const b = await signIn(w);
    const { id, head } = await repository();
    w.backend.repos.get(id)!.visibility = "private";
    const run = await authorize(w, b, commit(id, head, { changes: [{ op: "put", path: "analysis.py", text: "x\n" }] }));
    assert.equal(run.act?.status, 403);
    assert.equal(run.actBody?.error.code, "not_public");
  });
});

describe("the commit's payload (validate, describe)", () => {
  const base = { branch: "main", base: "a".repeat(40), message: "Update README.md", changes: [{ op: "put", path: "README.md", text: "# x\n" }] };
  const refused = (p: unknown) => {
    const v = validateCommit(p);
    assert.ok(isProblem(v), JSON.stringify(p).slice(0, 120));
    return v.message;
  };

  test("what is refused before any request, in words", () => {
    assert.match(refused({ ...base, changes: [] }), /changes no file/);
    assert.match(refused({ ...base, changes: Array.from({ length: 101 }, (_, i) => ({ op: "put", path: `f${i}.txt`, text: "" })) }), /at most 100 files/);
    for (const path of [".git/config", "a/../b", "/abs", "a//b", "a/./b", "x/.GIT/y", ""]) {
      assert.match(refused({ ...base, changes: [{ op: "put", path, text: "" }] }), /path|missing/);
    }
    assert.match(refused({ ...base, changes: [{ op: "put", path: "a", text: "" }, { op: "delete", path: "a" }] }), /twice/);
    assert.match(refused({ ...base, changes: [{ op: "put", path: "a", base64: "not base64!" }] }), /not readable/);
    assert.match(refused({ ...base, changes: [{ op: "put", path: "a", text: "x", base64: "eA==" }] }), /not readable/);
    assert.match(refused({ ...base, changes: [{ op: "chmod", path: "a" }] }), /not an edit/);
    assert.match(refused({ ...base, message: "  " }), /Write a commit message/);
    assert.match(refused({ ...base, message: "two\nlines" }), /one line/);
    assert.match(refused({ ...base, message: "x".repeat(501) }), /at most 500/);
    assert.match(refused({ ...base, description: "x".repeat(60_001) }), /description/);
    assert.match(refused({ ...base, branch: "a..b" }), /branch name/);
    assert.match(refused({ ...base, branch: "refs/heads/main" }), /branch name/);
    assert.match(refused({ ...base, base: "main" }), /head/);
    assert.match(refused({ ...base, newBranch: "main" }), /name of the branch/);
    assert.match(refused({ ...base, coAuthors: [{ login: "x", id: "abc" }] }), /numeric id/);
    assert.match(refused({ ...base, coAuthors: [{ login: "a", id: "1" }, { login: "a", id: "1" }] }), /twice/);
    assert.match(refused({ ...base, coAuthors: Array.from({ length: 11 }, (_, i) => ({ login: `u${i}`, id: String(i) })) }), /At most 10/);
    assert.match(refused({ ...base, coAuthors: [{ login: "x <evil@example.org>", id: "1" }] }), /GitHub account/);
    assert.match(refused({ ...base, signOff: "yes" }), /sign-off/);
  });

  test("the sentence and the message", () => {
    const p = validateCommit({ ...base, newBranch: "docs", coAuthors: [{ login: "grace-h", id: "7" }], signOff: true, changes: [{ op: "put", path: "a", text: "" }, { op: "move", from: "b", to: "c" }, { op: "delete", path: "d" }] }) as CommitParsed;
    assert.equal(describeCommit(p), "Commit “Update README.md” on a new branch docs, from main (1 file written, 1 file moved, 1 file deleted; with 1 co-author, signed off)");
    assert.equal(commitMessage({ message: "One", description: "", coAuthors: [] }, null), "One");
    assert.equal(commitMessage({ message: "One", description: "Two\n", coAuthors: [] }, { login: "a", id: "1" }), "One\n\nTwo\n\nSigned-off-by: a <1+a@users.noreply.github.com>");
  });

  test("registered, on no repository row, and its target needs a branch and a head", () => {
    assert.equal(ACTIONS.get("commit"), commitSpec);
    assert.deepEqual(COMMIT_ACTIONS.map((s) => s.kind), ["commit"]);
    assert.equal(commitSpec.needsRepo, false);
    assert.ok(commitSpec.checkTarget!({ kind: "commit", repo: { forge: "github", id: "1" }, branch: "main", expectedHead: null }));
    assert.ok(commitSpec.checkTarget!({ kind: "commit", repo: null, branch: "main", expectedHead: "a".repeat(40) }));
    assert.equal(commitSpec.checkTarget!({ kind: "commit", repo: { forge: "github", id: "1" }, branch: "main", expectedHead: "a".repeat(40) }), null);
  });
});
