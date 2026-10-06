// A repository's settings as authorized actions (night phase 01, E4; act-settings.ts): each kind
// changes the double as asked and the registry's rows as documented (docs/FORGE.md), through start,
// the double's GitHub and act, with the real registry of action kinds. A rename keeps the id and
// repoByPath finds the new path; a transfer is pending, then done; a person with write only is
// refused by GitHub; a check() mismatch records nothing.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { renameSpec, SETTINGS_ACTIONS } from "../../worker/forge/service/act-settings.ts";
import { ACTIONS, registry } from "../../worker/forge/service/actions.ts";
import { first, repoByPath } from "../../worker/forge/service/store.ts";
import type { RepoRow } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeCounts, forgeRows, SOCIAL_EMPTY } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const session = (token: string) => w.backend.session({ kind: "user", token });
const repoOf = (id: string) => w.backend.repos.get(id);
const row = (id: string) => w.forge.sqlite.prepare("SELECT * FROM repos WHERE repo_id = ?").get(id) as unknown as RepoRow;

/** Ada's repository on the double, known to the registry (mode created). */
async function known(name = "eeg"): Promise<string> {
  const info = await session(w.ada.token()).repos.create({ name, visibility: "public", autoInit: true });
  await seed.repo(w.forge, { repoId: info.key.id, ownerId: info.owner.id, ownerLogin: ADA_LOGIN, name, mode: "created", defaultBranch: "main" });
  return info.key.id;
}
const on = (id: string, kind: StartInput["kind"], payload: unknown): StartInput => ({ kind, repo: { forge: "memory", id }, payload, back: `/r/${ADA_LOGIN}/eeg/settings/` });

describe("settings", () => {
  test("rename: GitHub renames it, the id stays, the path moves (repos 2 + the action)", async () => {
    const b = await signIn(w);
    const id = await known();
    w.forge.reset();
    const run = await authorize(w, b, on(id, "rename", { name: "eeg-study" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(repoOf(id)?.name, "eeg-study");
    assert.equal(run.actBody?.result.page, "/r/ada-fixture/eeg-study/");
    assert.match(run.actBody?.result.notes[0], /sends the old address/);
    assert.equal((await first<RepoRow>(repoByPath(w.forge, "memory", ADA_LOGIN, "EEG-Study")))?.repo_id, id);
    assert.equal(w.forge.totals.written, 3);
    assert.equal(forgeRows(w.forge, "actions")[0].rows, 3);
    // A name already taken: 409 in words, nothing recorded.
    await known("taken");
    const clash = await authorize(w, b, on(id, "rename", { name: "taken" }));
    assert.equal(clash.act?.status, 409);
    assert.equal(row(id).name, "eeg-study");
  });

  test("edit, topics, features: GitHub changes them; only the action row here", async () => {
    const b = await signIn(w);
    const id = await known();
    w.forge.reset();
    const edit = await authorize(w, b, on(id, "edit", { description: "EEG pipeline", homepage: "https://doi.org/10.5555/oscr.fixture.1" }));
    assert.equal(edit.act?.status, 200, JSON.stringify(edit.actBody));
    assert.deepEqual([repoOf(id)?.description, repoOf(id)?.homepage], ["EEG pipeline", "https://doi.org/10.5555/oscr.fixture.1"]);
    const topics = await authorize(w, b, on(id, "topics", { topics: ["eeg", "Neuroscience", "eeg"] }));
    assert.equal(topics.act?.status, 200, JSON.stringify(topics.actBody));
    assert.deepEqual([...(repoOf(id)?.topics ?? [])].sort(), ["eeg", "neuroscience"]);
    const features = await authorize(w, b, on(id, "features", { wiki: false, deleteBranchOnMerge: true }));
    assert.equal(features.act?.status, 200, JSON.stringify(features.actBody));
    assert.deepEqual([repoOf(id)?.features.wiki, repoOf(id)?.features.deleteBranchOnMerge], [false, true]);
    assert.equal(features.actBody?.sentence, "Turn on deleting a branch once merged, and turn off the wiki");
    assert.equal(w.forge.totals.written, 3);
    assert.deepEqual(forgeCounts(w.forge), { actions: 3, deliveries: 0, installations: 0, jobs: 0, release_papers: 0, repo_packages: 0, repo_papers: 0, repos: 1, research_comments: 0, research_issues: 0, traced_paths: 0, ...SOCIAL_EMPTY });
    // Refused before GitHub: a script as a website, an upper-case topic list too long.
    assert.equal((await authorize(w, b, on(id, "edit", { homepage: "javascript:alert(1)" }))).act?.status, 400);
    assert.equal((await authorize(w, b, on(id, "topics", { topics: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).act?.status, 400);
  });

  test("template, default branch, archive and unarchive: GitHub and one row each", async () => {
    const b = await signIn(w);
    const id = await known();
    const s = session(w.ada.token());
    await s.git.createBranch({ forge: "memory", owner: ADA_LOGIN, name: "eeg" }, "trunk", await s.git.resolve({ forge: "memory", owner: ADA_LOGIN, name: "eeg" }, "main"));
    w.forge.reset();
    assert.equal((await authorize(w, b, on(id, "template", { template: true }))).act?.status, 200);
    assert.equal(repoOf(id)?.isTemplate, true);
    assert.equal(row(id).template, 1);
    assert.equal((await authorize(w, b, on(id, "default_branch", { branch: "trunk" }))).act?.status, 200);
    assert.equal(repoOf(id)?.defaultBranch, "trunk");
    assert.equal(row(id).default_branch, "trunk");
    assert.equal((await authorize(w, b, on(id, "archive", {}))).act?.status, 200);
    assert.equal(repoOf(id)?.archived, true);
    assert.equal(row(id).state, "archived");
    assert.equal((await authorize(w, b, on(id, "unarchive", {}))).act?.status, 200);
    assert.equal(repoOf(id)?.archived, false);
    assert.equal(row(id).state, "active");
    // 4 actions, each its row and one repos row.
    assert.equal(w.forge.totals.written, 8);
    // A branch that does not exist: GitHub's refusal in words; nothing recorded.
    const missing = await authorize(w, b, on(id, "default_branch", { branch: "nope" }));
    assert.equal(missing.act?.status, 400);
    assert.equal(row(id).default_branch, "trunk");
  });

  test("transfer: pending until the new owner accepts; to an organization Ada administers, done at once", async () => {
    const b = await signIn(w);
    const id = await known();
    w.backend.addUser("bob-fixture");
    w.forge.reset();
    const pending = await authorize(w, b, on(id, "transfer", { newOwner: "bob-fixture" }));
    assert.equal(pending.act?.status, 200, JSON.stringify(pending.actBody));
    assert.equal(pending.actBody?.outcome, "pending");
    assert.equal(pending.actBody?.result.status, "pending");
    assert.match(pending.actBody?.result.notes[0], /must accept the transfer on GitHub within a day/);
    assert.equal(row(id).owner_login, ADA_LOGIN);
    assert.equal(forgeRows(w.forge, "actions")[0].outcome, "pending");
    assert.equal(w.forge.totals.written, 1);
    w.backend.acceptTransfer(id);
    // An organization Ada administers: done at once, the path follows.
    const id2 = await known("eeg-two");
    w.backend.addOrg("lab", [ADA_LOGIN]);
    const done = await authorize(w, b, on(id2, "transfer", { newOwner: "lab", newName: "eeg-lab" }));
    assert.equal(done.act?.status, 200, JSON.stringify(done.actBody));
    assert.equal(done.actBody?.result.status, "done");
    assert.deepEqual([row(id2).owner_login, row(id2).name], ["lab", "eeg-lab"]);
    assert.ok(done.actBody?.result.notes.some((n: string) => /follows it by its id/.test(n)));
  });

  test("a person with write only is refused by GitHub; a repository the registry no longer follows too", async () => {
    await signIn(w);
    const id = await known();
    w.env.FORGE_OPEN = "true";
    const bob = await signIn(w, "bob-fixture");
    w.backend.grant({ forge: "memory", owner: ADA_LOGIN, name: "eeg" }, "bob-fixture", "write");
    const run = await authorize(w, bob, on(id, "rename", { name: "bobs-now" }), { login: "bob-fixture" });
    assert.equal(run.act?.status, 403);
    assert.equal(repoOf(id)?.name, "eeg");
    assert.equal(row(id).name, "eeg");
    const b = await signIn(w);
    w.forge.sqlite.prepare("UPDATE repos SET state = 'gone' WHERE repo_id = ?").run(id);
    const gone = await authorize(w, b, on(id, "archive", {}));
    assert.equal(gone.act?.status, 409);
    assert.equal(repoOf(id)?.archived, false);
  });

  test("check() says GitHub's answer is not what was authorized: nothing recorded", async () => {
    const b = await signIn(w);
    const id = await known();
    w.deps.actions = registry([{ ...renameSpec, check: () => false }]);
    w.forge.reset();
    const run = await authorize(w, b, on(id, "rename", { name: "whatever" }));
    assert.equal(run.act?.status, 502);
    assert.equal(w.forge.totals.written, 0);
    // GitHub did rename it: the registry still has the old path, and follows the id later.
    assert.equal(row(id).name, "eeg");
  });

  test("the nine kinds are registered", () => {
    assert.deepEqual(SETTINGS_ACTIONS.map((s) => s.kind), ["rename", "edit", "topics", "features", "template", "default_branch", "archive", "unarchive", "transfer"]);
    for (const s of SETTINGS_ACTIONS) {
      assert.equal(ACTIONS.get(s.kind), s);
      assert.equal(s.needsRepo, true);
    }
  });
});
