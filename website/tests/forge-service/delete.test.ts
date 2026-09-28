// Deletion (night phase 01, E4; act-delete.ts; D00-10): the request archives on GitHub and hides in
// the registry for 30 days with a delete_due job; restore within the period; the final deletion only
// after a request and only as the person's fresh authorization (no timer path exists); the Software
// Heritage request is one job and nothing on GitHub.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { DELETE_ACTIONS } from "../../worker/forge/service/act-delete.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { GRACE_SECONDS } from "../../worker/forge/service/caps.ts";
import type { RepoRow } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const row = (id: string) => w.forge.sqlite.prepare("SELECT * FROM repos WHERE repo_id = ?").get(id) as unknown as RepoRow;
const on = (id: string, kind: StartInput["kind"], payload: unknown): StartInput => ({ kind, repo: { forge: "memory", id }, payload, back: "/r/ada-fixture/eeg/settings/" });

async function known(): Promise<string> {
  const info = await w.backend.session({ kind: "user", token: w.ada.token() }).repos.create({ name: "eeg", visibility: "public", autoInit: true });
  await seed.repo(w.forge, { repoId: info.key.id, ownerId: info.owner.id, ownerLogin: ADA_LOGIN, name: "eeg", mode: "created", defaultBranch: "main" });
  return info.key.id;
}

describe("deletion", () => {
  test("the request needs the exact name typed and the count of maps shown", async () => {
    const b = await signIn(w);
    const id = await known();
    for (const payload of [{ confirmName: "eeg", maps: 0 }, { confirmName: "ada-fixture/eeg-x", maps: 0 }, { confirmName: "ada-fixture/eeg" }]) {
      const run = await authorize(w, b, on(id, "delete_request", payload));
      assert.equal(run.act?.status, 400, JSON.stringify(payload));
      assert.equal(row(id).state, "active");
      assert.equal(w.backend.repos.get(id)?.archived, false);
    }
    // A map was added since the page was shown: 409, reload.
    w.forge.sqlite
      .prepare("INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) VALUES ('memory', ?, 'a.py', 'doi:10.5555/oscr.fixture.1', ?, 1)")
      .run(id, "a".repeat(40));
    const stale = await authorize(w, b, on(id, "delete_request", { confirmName: "ada-fixture/eeg", maps: 0 }));
    assert.equal(stale.act?.status, 409);
  });

  test("requested: archived on GitHub, pending for 30 days with a delete_due job; restored within them", async () => {
    const b = await signIn(w);
    const id = await known();
    w.forge.reset();
    const run = await authorize(w, b, on(id, "delete_request", { confirmName: "Ada-Fixture/EEG", maps: 0 }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(w.backend.repos.get(id)?.archived, true);
    assert.deepEqual([row(id).state, row(id).delete_after], ["pending_deletion", T0 + GRACE_SECONDS]);
    const [job] = forgeRows(w.forge, "jobs");
    assert.deepEqual([job.kind, job.not_before], ["delete_due", T0 + GRACE_SECONDS]);
    assert.equal(w.forge.totals.written, 3);
    assert.equal(w.backend.repos.get(id)?.deleted, false);
    w.advance(10 * 86_400);
    const restored = await authorize(w, b, on(id, "restore", {}));
    assert.equal(restored.act?.status, 200, JSON.stringify(restored.actBody));
    assert.equal(w.backend.repos.get(id)?.archived, false);
    assert.deepEqual([row(id).state, row(id).delete_after], ["active", null]);
    // Restore outside a grace period: 409.
    assert.equal((await authorize(w, b, on(id, "restore", {}))).act?.status, 409);
  });

  test("the final deletion: refused before a request; after it, deleted on GitHub by the person's authorization", async () => {
    const b = await signIn(w);
    const id = await known();
    const early = await authorize(w, b, on(id, "delete_final", { confirmName: "ada-fixture/eeg" }));
    assert.equal(early.act?.status, 409);
    assert.equal(w.backend.repos.get(id)?.deleted, false);
    await authorize(w, b, on(id, "delete_request", { confirmName: "ada-fixture/eeg", maps: 0 }));
    const wrong = await authorize(w, b, on(id, "delete_final", { confirmName: "ada-fixture/other" }));
    assert.equal(wrong.act?.status, 400);
    const run = await authorize(w, b, on(id, "delete_final", { confirmName: "ada-fixture/eeg" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(w.backend.repos.get(id)?.deleted, true);
    assert.equal(row(id).state, "deleted");
    assert.match(run.actBody?.result.notes[0], /90 days/);
  });

  test("after the grace period the Mac only hides it; the final deletion is still the person's", async () => {
    const b = await signIn(w);
    const id = await known();
    await authorize(w, b, on(id, "delete_request", { confirmName: "ada-fixture/eeg", maps: 0 }));
    // What oscr/forgejobs.py's delete_due does at the end of the period.
    w.forge.sqlite.prepare("UPDATE repos SET state = 'hidden' WHERE repo_id = ?").run(id);
    assert.equal(w.backend.repos.get(id)?.deleted, false);
    const run = await authorize(w, b, on(id, "delete_final", { confirmName: "ada-fixture/eeg" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(w.backend.repos.get(id)?.deleted, true);
  });

  test("no timer path: only delete_final calls repos.delete in the service, and the Mac never deletes", () => {
    const dir = new URL("../../worker/forge/service/", import.meta.url);
    const callers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /repos\.delete\(/.test(readFileSync(new URL(f, dir), "utf8")));
    assert.deepEqual(callers, ["act-delete.ts"]);
    const source = readFileSync(new URL("act-delete.ts", dir), "utf8");
    assert.equal(source.match(/repos\.delete\(/g)?.length, 1);
    assert.ok(source.indexOf("repos.delete(") > source.indexOf("export const deleteFinalSpec"));
    const mac = readFileSync(new URL("../../../oscr/forgejobs.py", import.meta.url), "utf8");
    // The Mac reads the forges and never deletes there: no DELETE request, no delete call.
    assert.ok(!/\.delete\(|["']DELETE["']/.test(mac));
  });

  test("Software Heritage: one archive job, nothing on GitHub", async () => {
    const b = await signIn(w);
    const id = await known();
    const before = JSON.stringify(w.backend.repos.get(id));
    w.forge.reset();
    const run = await authorize(w, b, on(id, "software_heritage", {}));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.deepEqual(forgeRows(w.forge, "jobs").map((j) => [j.kind, j.repo_id]), [["archive", id]]);
    assert.equal(w.forge.totals.written, 2);
    assert.equal(JSON.stringify(w.backend.repos.get(id)), before);
  });

  test("the four kinds are registered", () => {
    assert.deepEqual(DELETE_ACTIONS.map((s) => s.kind), ["delete_request", "restore", "delete_final", "software_heritage"]);
    for (const s of DELETE_ACTIONS) assert.equal(ACTIONS.get(s.kind), s);
  });
});
