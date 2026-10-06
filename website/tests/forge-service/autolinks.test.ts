// Custom autolinks as authorized actions (night phase 01, E5; act-autolinks.ts): created and deleted
// on the double through start, GitHub and act, one action row each; refused before GitHub when the
// template has no <num>; a prefix already there is 409.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { AUTOLINK_ACTIONS } from "../../worker/forge/service/act-autolinks.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const RRID = { keyPrefix: "RRID:", urlTemplate: "https://scicrunch.org/resolver/RRID:<num>", isAlphanumeric: true };
const on = (id: string, kind: StartInput["kind"], payload: unknown): StartInput => ({ kind, repo: { forge: "memory", id }, payload, back: "/r/ada-fixture/eeg/settings/" });

async function known(): Promise<string> {
  const info = await w.backend.session({ kind: "user", token: w.ada.token() }).repos.create({ name: "eeg", visibility: "public", autoInit: true });
  await seed.repo(w.forge, { repoId: info.key.id, ownerId: info.owner.id, ownerLogin: ADA_LOGIN, name: "eeg", mode: "created", defaultBranch: "main" });
  return info.key.id;
}

describe("autolinks", () => {
  test("created, then deleted, through the authorized action: one action row each", async () => {
    const b = await signIn(w);
    const id = await known();
    w.forge.reset();
    const made = await authorize(w, b, on(id, "autolink_create", RRID));
    assert.equal(made.act?.status, 200, JSON.stringify(made.actBody));
    assert.equal(made.actBody?.sentence, "Link every “RRID:…” in the repository's issues and commits to https://scicrunch.org/resolver/RRID:<num>");
    const autolink = made.actBody?.result.autolink;
    assert.deepEqual([...(w.backend.repos.get(id)?.autolinks.values() ?? [])].map((a) => a.keyPrefix), ["RRID:"]);
    const clash = await authorize(w, b, on(id, "autolink_create", { ...RRID, urlTemplate: "https://example.org/<num>" }));
    assert.equal(clash.act?.status, 409);
    const gone = await authorize(w, b, on(id, "autolink_delete", { id: autolink.id }));
    assert.equal(gone.act?.status, 200, JSON.stringify(gone.actBody));
    assert.equal(w.backend.repos.get(id)?.autolinks.size, 0);
    assert.deepEqual(forgeRows(w.forge, "actions").map((a) => [a.kind, a.rows]).sort(), [["autolink_create", 1], ["autolink_delete", 1]]);
    assert.equal(w.forge.totals.written, 2);
  });

  test("a template without <num>, a bad prefix, an unknown id: refused in words", async () => {
    const b = await signIn(w);
    const id = await known();
    for (const payload of [{ keyPrefix: "RRID:", urlTemplate: "https://scicrunch.org/resolver/" }, { keyPrefix: "a b", urlTemplate: "https://x.org/<num>" }]) {
      const run = await authorize(w, b, on(id, "autolink_create", payload));
      assert.equal(run.act?.status, 400, JSON.stringify(payload));
    }
    const unknown = await authorize(w, b, on(id, "autolink_delete", { id: "123" }));
    assert.equal(unknown.act?.status, 404);
    assert.equal(forgeRows(w.forge, "actions").length, 0);
  });

  test("the two kinds are registered", () => {
    assert.deepEqual(AUTOLINK_ACTIONS.map((s) => s.kind), ["autolink_create", "autolink_delete"]);
    for (const s of AUTOLINK_ACTIONS) assert.equal(ACTIONS.get(s.kind), s);
  });
});
