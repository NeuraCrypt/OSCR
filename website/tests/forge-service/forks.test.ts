// Forks as authorized actions (night phase 04, E1; act-forks.ts): GitHub makes the fork as the
// person, in their account or an organization of theirs; "Sync fork" fast-forwards, merges, or says
// there is nothing to do; a conflict leaves the fork's branch as it was. The action row only.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import { describeFork, FORK_ACTIONS, validateFork, type ForkParsed } from "../../worker/forge/service/act-forks.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import type { FileChange } from "../../worker/forge/types.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const FORK = { forge: "memory" as const, owner: "bob-fixture", name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });
const put = (path: string, content: string): FileChange => ({ op: "put", path, content: utf8(content) });
const commitOn = async (repo: typeof REF, changes: FileChange[]) => {
  const head = await ada().git.resolve(repo, "main");
  return (await ada().git.createCommit(repo, { branch: "main", expectedHead: head, message: "A change", changes })).sha;
};

async function repository(): Promise<string> {
  const info = await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true });
  await commitOn(REF, [put("analysis.py", "a = 1\n")]);
  return info.key.id;
}

const on = (kind: string, id: string, payload: Record<string, unknown>): StartInput => ({
  kind: kind as StartInput["kind"],
  repo: { forge: "memory", id },
  branch: null,
  expectedHead: null,
  payload,
  back: "/r/ada-fixture/eeg/",
});

describe("fork", () => {
  test("Bob forks Ada's repository into his account: the fork's page, the action row only", async () => {
    await signIn(w);
    const id = await repository();
    const bob = await signIn(w, "bob-fixture");
    w.forge.reset();
    const run = await authorize(w, bob, on("fork", id, {}), { login: "bob-fixture" });
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const r = run.actBody!.result;
    assert.equal(r.owner, "bob-fixture");
    assert.equal(r.parent, "ada-fixture/eeg");
    assert.equal(r.page, "/r/bob-fixture/eeg/");
    assert.deepEqual(r.links, [{ href: "/r/bob-fixture/eeg/", text: "Your fork, bob-fixture/eeg" }]);
    assert.equal(run.actBody!.sentence, "Fork this repository into your GitHub account, with all its branches");
    assert.equal(await ada().git.resolve(FORK, "main"), await ada().git.resolve(REF, "main"));
    assert.equal(w.forge.totals.written, 1);
    assert.equal(forgeRows(w.forge, "actions")[0].kind, "fork");
    // Forking again finds the same fork (GitHub keeps one per account).
    const again = await authorize(w, bob, on("fork", id, {}), { login: "bob-fixture" });
    assert.equal(again.actBody!.result.forkId, r.forkId);
    assert.match(again.actBody!.result.notes[0], /already there/);
  });

  test("into an organization the person does not belong to: refused in words", async () => {
    await signIn(w);
    const id = await repository();
    w.backend.addOrg("lab", [ADA_LOGIN]);
    const bob = await signIn(w, "bob-fixture");
    const run = await authorize(w, bob, on("fork", id, { owner: "lab" }), { login: "bob-fixture" });
    assert.ok(run.act && run.act.status >= 400, JSON.stringify(run.actBody));
    assert.equal(forgeRows(w.forge, "actions").length, 0);
  });
});

describe("fork_sync", () => {
  test("up to date, a fast-forward, a merge, then a conflict that leaves the branch as it was", async () => {
    await signIn(w);
    const id = await repository();
    const bob = await signIn(w, "bob-fixture");
    const forked = await authorize(w, bob, on("fork", id, {}), { login: "bob-fixture" });
    const forkId = forked.actBody!.result.forkId as string;
    const sync = () => authorize(w, bob, on("fork_sync", forkId, { branch: "main" }), { login: "bob-fixture" });
    const none = await sync();
    assert.equal(none.act?.status, 200, JSON.stringify(none.actBody));
    assert.equal(none.actBody!.result.status, "up_to_date");
    assert.equal(none.actBody!.sentence, "Sync the branch main of this fork with the same branch of its upstream repository");
    const up = await commitOn(REF, [put("NEWS.md", "news\n")]);
    const ff = await sync();
    assert.equal(ff.actBody!.result.status, "fast_forward");
    assert.equal(ff.actBody!.result.sha, up);
    assert.equal(await ada().git.resolve(FORK, "main"), up);
    // Ada is a collaborator of nothing on Bob's fork: the double's owner session writes it as Bob would.
    w.backend.repos.get(forkId)!.collaborators.set(w.ada.user.id, "write");
    await commitOn(FORK, [put("bob.txt", "bob\n")]);
    await commitOn(REF, [put("NEWS.md", "more news\n")]);
    const merged = await sync();
    assert.equal(merged.actBody!.result.status, "merged");
    await commitOn(FORK, [put("analysis.py", "a = 2\n")]);
    await commitOn(REF, [put("analysis.py", "a = 3\n")]);
    const before = await ada().git.resolve(FORK, "main");
    const clash = await sync();
    assert.equal(clash.act?.status, 409);
    assert.equal(clash.actBody?.error.code, "conflict");
    assert.equal(await ada().git.resolve(FORK, "main"), before);
    const notFork = await authorize(w, bob, on("fork_sync", id, { branch: "main" }), { login: "bob-fixture" });
    assert.equal(notFork.act?.status, 400);
    assert.equal(notFork.actBody?.error.code, "not_a_fork");
  });
});

describe("the payloads", () => {
  test("validate and describe; registered in act-forks.ts", () => {
    assert.equal(describeFork(validateFork({ owner: "lab", name: "eeg-fork", defaultBranchOnly: true }) as ForkParsed), "Fork this repository into the organization lab, named eeg-fork, its default branch only");
    for (const bad of [null, { owner: "not a login" }, { name: "x.git" }, { name: "../x" }, { defaultBranchOnly: "yes" }]) {
      assert.ok(isProblem(validateFork(bad)), JSON.stringify(bad));
    }
    for (const spec of FORK_ACTIONS) {
      assert.equal(ACTIONS.get(spec.kind), spec);
      assert.equal(REGISTERED_IN[spec.kind], "act-forks.ts");
    }
  });
});
