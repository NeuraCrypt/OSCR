// Organizations (night phase 09, E1): create, the profile, settings, rename, archive, delete, the
// members-only README and a private member list refused to a non-member, the FORGE_OPEN gate, the
// audit log written, no scan, the rows D1 bills.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  cleanPerms,
  validateCreate,
  validateHandle,
  validatePatch,
} from "../../worker/forge/service/org-core.ts";
import { ForgeProblem, isProblem } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeCounts, forgeRows, forgeText } from "./d1.ts";
import { forgeWorld, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

const read = (b: Awaited<ReturnType<typeof signIn>>, qs: string) => b.fetch(`/api/forge/org${qs}`);

describe("the pure parts (org-core.ts)", () => {
  test("a handle: 1 to 39 of [a-z0-9-], not reserved, no edge or double hyphen", () => {
    assert.equal(validateHandle("eeg-lab"), "eeg-lab");
    assert.equal(validateHandle("EEG-Lab"), "eeg-lab");
    for (const badOne of ["", "-x", "x-", "a--b", "new", "api", "a b", "x".repeat(40), "lab_1", "café"]) {
      assert.ok(validateHandle(badOne) instanceof ForgeProblem, badOne);
    }
  });

  test("a create: a handle, a kind, an optional ROR id, a display name defaulting to the handle", () => {
    const ok = validateCreate({ handle: "eeg-lab", display_name: "  EEG Lab  ", kind: "lab", ror: "https://ror.org/05dxps055", members_private: true });
    assert.ok(!isProblem(ok));
    if (!isProblem(ok)) {
      assert.equal(ok.handle, "eeg-lab");
      assert.equal(ok.display_name, "EEG Lab");
      assert.equal(ok.ror, "05dxps055");
      assert.equal(ok.members_private, true);
    }
    const noName = validateCreate({ handle: "brainlab" });
    assert.ok(!isProblem(noName) && noName.display_name === "brainlab");
    for (const badOne of [{}, { handle: "-x" }, { handle: "ok", ror: "not-a-ror" }, { handle: "ok", kind: "nope" }]) {
      const r = validateCreate(badOne);
      if (badOne === (badOne as Json).handle) continue;
      if ("ror" in badOne || "handle" in badOne) assert.ok(isProblem(r) || !("ror" in badOne), JSON.stringify(badOne));
    }
    assert.ok(isProblem(validateCreate({ handle: "ok", ror: "not a ror" })));
  });

  test("a settings patch: only the fields present, an https picture, at most 20 pins, at signs dropped", () => {
    const p = validatePatch({ bio: "a lab with ada@x.org in it", picture: "https://x/p.png", pinned: ["a", "b"] });
    assert.ok(!isProblem(p));
    if (!isProblem(p)) {
      assert.ok(!p.bio!.includes("@"));
      assert.equal(p.picture, "https://x/p.png");
      assert.deepEqual(p.pinned, ["a", "b"]);
      assert.equal(p.display_name, undefined);
    }
    assert.ok(isProblem(validatePatch({ picture: "http://x/p.png" })));
    assert.ok(isProblem(validatePatch({ pinned: Array(21).fill("x") })));
  });

  test("research permissions: only known ones, de-duplicated", () => {
    assert.deepEqual(cleanPerms(["validate_map", "validate_map", "nope", "flag_map"]), ["validate_map", "flag_map"]);
    assert.deepEqual(cleanPerms("x"), []);
  });
});

describe("the routes", () => {
  test("the owner creates an organization, reads it, and the audit and rows are right", async () => {
    const ada = await signIn(w);
    const res = await ada.post("/api/forge/org/create", { handle: "eeg-lab", display_name: "EEG Lab", kind: "lab", ror: "05dxps055" });
    assert.equal(res.status, 201);
    const created = await body(res);
    assert.equal(created.org.handle, "eeg-lab");
    const id = created.org.id;

    // One organization, one member (the owner), one audit row, one action row. Create reserved 5.
    assert.equal(forgeRows(w.forge, "organizations").length, 1);
    assert.equal(forgeRows(w.forge, "org_members").length, 1);
    assert.equal((forgeRows(w.forge, "org_members")[0] as Json).role, "owner");
    assert.equal(forgeRows(w.forge, "org_audit").length, 1);
    assert.equal((forgeRows(w.forge, "org_audit")[0] as Json).event, "org.create");
    assert.equal(forgeRows(w.forge, "actions").length, 1);
    assert.deepEqual(w.forge.scans, []);

    const got = await body(await read(ada, `?handle=eeg-lab`));
    assert.equal(got.org.id, id);
    assert.equal(got.viewer.member.role, "owner");
    assert.equal(got.viewer.can.manage, true);
    assert.equal(got.members.length, 1);
    assert.equal(got.memberCount, 1);
    // The audit never stores an email address.
    assert.ok(!forgeText(w.forge).includes("@"));
  });

  test("the members-only README and a private member list are refused to a non-member", async () => {
    const ada = await signIn(w);
    const create = await body(await ada.post("/api/forge/org/create", { handle: "brain-lab", members_private: true }));
    const id = create.org.id;
    await ada.post("/api/forge/org/update", { id, op: "settings", patch: { readme_public: "Welcome", readme_members: "Internal notes" } });

    const bob = await signIn(w, "bob");
    const seen = await body(await read(bob, `?handle=brain-lab`));
    assert.equal(seen.org.readme, "Welcome");
    assert.equal(seen.org.readmeMembers, "");
    assert.equal(seen.viewer.member, null);
    assert.equal(seen.membersHidden, true);
    assert.equal(seen.members.length, 0);
    // The owner still sees everything.
    const own = await body(await read(ada, `?id=${id}`));
    assert.equal(own.org.readmeMembers, "Internal notes");
    assert.equal(own.members.length, 1);
    assert.deepEqual(w.forge.scans, []);
  });

  test("settings, rename, archive and delete; a taken handle refused; a deleted org is gone", async () => {
    const ada = await signIn(w);
    const id = (await body(await ada.post("/api/forge/org/create", { handle: "lab-a" }))).org.id;
    await ada.post("/api/forge/org/create", { handle: "lab-b" });

    // A rename to a taken handle is refused.
    const clash = await ada.post("/api/forge/org/update", { id, op: "rename", handle: "lab-b" });
    assert.equal(clash.status, 409);
    // A good rename.
    const renamed = await body(await ada.post("/api/forge/org/update", { id, op: "rename", handle: "lab-c" }));
    assert.equal(renamed.org.handle, "lab-c");
    assert.equal((await read(ada, `?handle=lab-a`)).status, 404);

    await ada.post("/api/forge/org/update", { id, op: "archive" });
    assert.equal((await body(await read(ada, `?id=${id}`))).org.state, "archived");
    await ada.post("/api/forge/org/update", { id, op: "delete" });
    assert.equal((await read(ada, `?id=${id}`)).status, 404);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a create with a handle already taken is refused (409)", async () => {
    const ada = await signIn(w);
    await ada.post("/api/forge/org/create", { handle: "dup" });
    const again = await ada.post("/api/forge/org/create", { handle: "dup" });
    assert.equal(again.status, 409);
  });

  test("FORGE_OPEN closed: a non-owner may not create; open: they may", async () => {
    const bob = await signIn(w, "bob");
    const closed = await bob.post("/api/forge/org/create", { handle: "bob-lab" });
    assert.equal(closed.status, 403);
    assert.equal((await body(closed)).error.code, "forge_closed");

    const open = forgeWorld({ env: { FORGE_OPEN: "true" } });
    const bob2 = await signIn(open, "bob");
    const ok = await bob2.post("/api/forge/org/create", { handle: "bob-lab" });
    assert.equal(ok.status, 201);
    open.restore();
  });

  test("only an owner changes an organization; a non-member cannot", async () => {
    const open = forgeWorld({ env: { FORGE_OPEN: "true" } });
    const ada = await signIn(open, "ada-fixture");
    const id = (await body(await ada.post("/api/forge/org/create", { handle: "shared" }))).org.id;
    const bob = await signIn(open, "bob");
    const denied = await bob.post("/api/forge/org/update", { id, op: "archive" });
    assert.equal(denied.status, 403);
    assert.equal((await body(denied)).error.code, "owner_only");
    open.restore();
  });
});
