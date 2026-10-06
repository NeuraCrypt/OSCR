// Takedowns (night phase 16, E5; moderation.ts, /copyright/): a copyright notice needs an account (its
// claimant is answered in the site), a report of private information does not; a copyright takedown is
// answered with a counter-notice (its two statements), and restored by the owner.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

const WORK = "It copies the figures of my 2024 paper, doi:10.1234/mine.2024, without the licence.";

describe("takedowns", () => {
  test("a copyright notice needs an account; private information does not; the counter-notice restores", async () => {
    const ada = await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const opened = await bob.post("/api/forge/research/open", { paper: "10.1234/eeg.2026", code: "https://zenodo.org/records/123", type: "code_error", title: "Crash", body: "Figures copied here." });
    const issue = (await body(opened)).id;
    const anon = w.browser();
    const refused = await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "copyright", details: WORK, turnstile: "XXXX.DUMMY.TOKEN.XXXX" }, { csrf: null });
    assert.equal(refused.status, 401);
    assert.equal((await body(refused)).error.code, "sign_in_required");
    assert.equal((await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "private_information", turnstile: "XXXX.DUMMY.TOKEN.XXXX" }, { csrf: null })).status, 201);
    const carol = await signIn(w, "carol-fixture");
    assert.equal((await carol.post("/api/forge/report", { target: `research:${issue}`, reason: "copyright", details: WORK })).status, 201);
    // Hidden for copyright; Bob answers with a counter-notice (both statements), the owner restores.
    assert.equal((await ada.post("/api/forge/moderation/decide", { op: "hide", target: `research:${issue}`, reason: "copyright", notice: "A research issue was hidden after a copyright notice." })).status, 200);
    const mine = await body(await bob.fetch("/api/forge/moderation/mine"));
    assert.equal(mine.hidden[0].counterNotice, true);
    const half = await bob.post("/api/forge/appeal", { target: `research:${issue}`, kind: "counter_notice", text: "These figures are mine: I made them for this issue.", goodFaith: true });
    assert.equal(half.status, 400);
    const sent = await bob.post("/api/forge/appeal", { target: `research:${issue}`, kind: "counter_notice", text: "These figures are mine: I made them for this issue.", goodFaith: true, accurate: true });
    assert.equal(sent.status, 200, JSON.stringify(await body(sent)));
    const q = await body(await ada.fetch("/api/forge/moderation"));
    assert.equal(q.appeals[0].appealKind, "counter_notice");
    assert.equal((await ada.post("/api/forge/moderation/decide", { op: "appeal", target: `research:${issue}`, appeal: "accepted" })).status, 200);
    assert.equal((await carol.fetch(`/api/forge/research?id=${issue}`)).status, 200, "restored");
    const row = forgeRows(w.forge, "moderation")[0];
    assert.equal(row.state, "restored");
    assert.match(String(row.notice), /Restored on \d{4}-\d{2}-\d{2}\./);
    assert.equal(forgeRows(w.forge, "content_reports").filter((x) => x.state === "open").length, 0, "every report of it answered");
  });

  test("a counter-notice answers a copyright takedown only", async () => {
    const ada = await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const issue = (await body(await bob.post("/api/forge/research/open", { paper: "10.1234/eeg.2026", code: "https://zenodo.org/records/123", type: "code_error", title: "Crash", body: "Spam?" }))).id;
    await ada.post("/api/forge/moderation/decide", { op: "hide", target: `research:${issue}`, reason: "spam" });
    const res = await bob.post("/api/forge/appeal", { target: `research:${issue}`, kind: "counter_notice", text: "This is not a copyright matter at all.", goodFaith: true, accurate: true });
    assert.equal(res.status, 400);
    assert.equal((await bob.post("/api/forge/appeal", { target: `research:${issue}`, text: "This is a real bug report, not spam." })).status, 200);
  });
});
