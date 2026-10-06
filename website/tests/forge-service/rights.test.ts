// Data-rights requests (night phase 16, E4; rights.ts): signed in (the proof of identity), behind the
// human check, 3 open at most; the owner answers in the site; the person reads the answer on their page;
// a suspended account may still ask. No email address anywhere.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { validateRights } from "../../worker/forge/service/moderation-core.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows, forgeText } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

describe("data-rights requests", () => {
  test("the payload: a right, words required for a correction or an objection", () => {
    assert.ok(isProblem(validateRights({ right: "forget" })));
    assert.ok(isProblem(validateRights({ right: "rectification", details: "fix" })));
    assert.ok(!isProblem(validateRights({ right: "access" })));
  });

  test("asked (whatever FORGE_OPEN says), answered by the owner, read on the person's page", async () => {
    const ada = await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    assert.equal((await bob.post("/api/forge/rights", { right: "access", turnstile: "" })).status, 403, "the human check");
    const made = await bob.post("/api/forge/rights", { right: "rectification", details: "My affiliation is wrong; write bob@example.org" });
    assert.equal(made.status, 201, JSON.stringify(await body(made)));
    assert.equal(forgeRows(w.forge, "rights_requests")[0].details, "My affiliation is wrong; write [email hidden]");
    // The queue shows it with the person's handles; only the owner answers.
    assert.equal((await bob.fetch("/api/forge/moderation")).status, 403);
    const q = await body(await ada.fetch("/api/forge/moderation"));
    assert.equal(q.rights.length, 1);
    assert.equal(q.rights[0].who.github, "bob-fixture");
    assert.doesNotMatch(JSON.stringify(q.rights), /u_[A-Za-z0-9_-]{10,}/);
    const r = q.rights[0];
    assert.equal((await bob.post("/api/forge/rights/answer", { id: r.id, at: r.at, state: "answered", answer: "Corrected in the catalogue." })).status, 403);
    assert.equal((await ada.post("/api/forge/rights/answer", { id: r.id, at: r.at, state: "answered", answer: "Corrected in the catalogue." })).status, 200);
    const mine = await body(await bob.fetch("/api/forge/moderation/mine"));
    assert.equal(mine.rights[0].state, "answered");
    assert.equal(mine.rights[0].answer, "Corrected in the catalogue.");
    assert.doesNotMatch(forgeText(w.forge), /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  test("three waiting at most; a suspended account may still ask", async () => {
    const ada = await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    for (const right of ["access", "portability", "erasure"]) assert.equal((await bob.post("/api/forge/rights", { right })).status, 201, right);
    assert.equal((await body(await bob.post("/api/forge/rights", { right: "restriction" }))).error.code, "too_many_requests");
    const bobGithub = String([...w.backend.accounts.values()].find((a) => a.login === "bob-fixture")!.id);
    await ada.post("/api/forge/moderation/decide", { op: "hide", target: `person:github:${bobGithub}`, reason: "spam" });
    const q = await body(await ada.fetch("/api/forge/moderation"));
    await ada.post("/api/forge/rights/answer", { id: q.rights[0].id, at: q.rights[0].at, state: "refused", answer: "A copy is on its way on this page." });
    w.advance(86_400); // three a day
    assert.equal((await bob.post("/api/forge/rights", { right: "objection", details: "Stop showing my profile." })).status, 201);
  });
});
