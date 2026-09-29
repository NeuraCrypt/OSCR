// A repository's packages, confirmed or declined by a person who may push (night phase 07, E6;
// act-packages.ts): one authorized action, GitHub asked as the person whether they may push, one row
// kept (repo_packages), nothing written on GitHub; the signed-in layer answers them.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import { describePackage, packageConfirmSpec, validatePackage, type PackageParsed } from "../../worker/forge/service/act-packages.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

async function repository(): Promise<string> {
  const id = (await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true })).key.id;
  await seed.repo(w.forge, { repoId: id, ownerLogin: ADA_LOGIN, name: "eeg", defaultBranch: "main" }, T0 - 86_400);
  return id;
}

const on = (id: string, payload: Record<string, unknown>): StartInput => ({ kind: "package_confirm", repo: { forge: "memory", id }, branch: null, expectedHead: null, payload, back: "/r/ada-fixture/eeg/environment/" });

describe("package_confirm", () => {
  test("Ada confirms, then declines: one row kept, the action row; the layer answers it; nothing on GitHub", async () => {
    const b = await signIn(w);
    const id = await repository();
    w.forge.reset();
    const yes = await authorize(w, b, on(id, { registry: "pypi", name: "eeg-tools", version: "1.2.0", source: "pyproject.toml", confirm: true }));
    assert.equal(yes.act?.status, 200, JSON.stringify(yes.actBody));
    assert.equal(yes.actBody!.sentence, "Confirm that the repository publishes the package eeg-tools (1.2.0) at PyPI");
    assert.equal(yes.actBody!.result.page, "/r/ada-fixture/eeg/environment/");
    assert.equal(w.forge.totals.written, 2);
    const [row] = forgeRows(w.forge, "repo_packages");
    assert.deepEqual([row.registry, row.name, row.status, row.version, row.source], ["pypi", "eeg-tools", "confirmed", "1.2.0", "pyproject.toml"]);
    const no = await authorize(w, b, on(id, { registry: "pypi", name: "eeg-tools", confirm: false }));
    assert.equal(no.act?.status, 200);
    assert.equal(forgeRows(w.forge, "repo_packages").length, 1);
    assert.equal(forgeRows(w.forge, "repo_packages")[0].status, "declined");
    const layer = (await (await b.fetch(`/api/forge/repo?id=memory:${id}`)).json()) as Record<string, unknown>;
    assert.deepEqual(layer.packages, [{ registry: "pypi", name: "eeg-tools", status: "declined", version: "", source: "" }]);
    assert.ok(!JSON.stringify(layer).includes(String(row.by_user)));
    assert.deepEqual(w.forge.scans, []);
  });

  test("only a person who may push; validation before GitHub", async () => {
    const id = await repository();
    const bob = await signIn(w, "bob");
    const run = await authorize(w, bob, on(id, { registry: "cran", name: "eegR", confirm: true }), { login: "bob" });
    assert.equal(run.act?.status, 403);
    assert.equal(run.actBody!.error.code, "not_maintainer");
    assert.equal(forgeRows(w.forge, "repo_packages").length, 0);
    for (const bad of [
      { registry: "maven", name: "x", confirm: true },
      { registry: "pypi", name: "has space", confirm: true },
      { registry: "npm", name: "UPPER", confirm: true },
      { registry: "pypi", name: "ok", confirm: "yes" },
      { registry: "pypi", name: "ok", confirm: true, source: "../../etc" },
      { registry: "pypi", name: "ok", confirm: true, version: "1 2" },
    ]) {
      assert.ok(isProblem(validatePackage(bad)), JSON.stringify(bad));
    }
    const npm = validatePackage({ registry: "npm", name: "@lab/eeg", confirm: false }) as PackageParsed;
    assert.equal(describePackage(npm), "Decline the package @lab/eeg at npm: the repository does not publish it");
    assert.equal(REGISTERED_IN.package_confirm, "act-packages.ts");
    assert.equal(ACTIONS.get("package_confirm"), packageConfirmSpec);
  });
});
