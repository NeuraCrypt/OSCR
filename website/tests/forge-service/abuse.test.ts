// Abuse limits and the switch (night phase 16, E3; turnstile.ts requireHuman, gate.ts forgeOpen,
// bearer.ts): every public write form of the site passes the human check server-side (research issues
// and comments, profiles, star lists, tokens, webhooks); a request of the public API carries its token
// instead; FORGE_OPEN opens nothing while Turnstile is not set up; a suspended account makes no token;
// an address sending wrong tokens is refused before any read.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { handleApi } from "../../worker/forge/service/api.ts";
import { BAD_TOKENS_PER_MINUTE } from "../../worker/forge/service/bearer.ts";
import { TEST_SECRET_FAIL } from "../../worker/forge/service/turnstile.ts";
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

const ISSUE = { paper: "10.1234/eeg.2026", code: "https://zenodo.org/records/123", type: "code_error", title: "It crashes", body: "At line 3." };
const NONE = { turnstile: "" };

describe("the human check on every public write form", () => {
  test("research issues and comments, profiles, lists, tokens, webhooks: refused without it, taken with it", async () => {
    await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const cases: [string, Record<string, unknown>][] = [
      ["/api/forge/research/open", ISSUE],
      ["/api/forge/social/profile", { name: "Bob", bio: "EEG" }],
      ["/api/forge/social/list", { op: "create", name: "Reading", description: "", public: true }],
      ["/api/forge/tokens/write", { op: "create", name: "ci", scopes: ["research:read"], days: 30 }],
      ["/api/forge/hooks/write", { op: "create", subject: "paper:doi:10.1234/eeg.2026", url: "https://hooks.lab.example/x", events: "*" }],
    ];
    for (const [path, payload] of cases) {
      const refused = await bob.post(path, { ...payload, ...NONE });
      assert.equal(refused.status, 403, path);
      assert.equal((await body(refused)).error.code, "human_check", path);
    }
    assert.equal(forgeRows(w.forge, "research_issues").length + forgeRows(w.forge, "profiles").length + forgeRows(w.forge, "star_lists").length + forgeRows(w.forge, "api_tokens").length + forgeRows(w.forge, "hooks").length, 0);
    // With the widget's token (the test browser sends Cloudflare's dummy token, as a page does).
    const opened = await bob.post("/api/forge/research/open", ISSUE);
    assert.equal(opened.status, 201);
    const id = (await body(opened)).id;
    assert.equal((await bob.post("/api/forge/research/comment", { id, body: "More", ...NONE })).status, 403);
    assert.equal((await bob.post("/api/forge/research/comment", { id, body: "More" })).status, 200);
    // An edit of one's own comment is not asked again.
    assert.equal((await bob.post("/api/forge/research/comment", { id, n: 1, body: "More words", ...NONE })).status, 200);
    assert.equal((await bob.post("/api/forge/social/profile", { name: "Bob" })).status, 200);
    // Cloudflare's always-failing test secret: every check fails.
    w.env.TURNSTILE_SECRET_KEY = TEST_SECRET_FAIL;
    assert.equal((await body(await bob.post("/api/forge/research/open", ISSUE))).error.code, "human_check");
  });

  test("a request of the public API carries its token (made behind the check) and is not asked", async () => {
    await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const made = await body(await bob.post("/api/forge/tokens/write", { op: "create", name: "script", scopes: ["research:write"], days: 30 }));
    const request = new Request("https://registry.example/api/v1/research/open", {
      method: "POST",
      headers: { Authorization: `Bearer ${made.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(ISSUE),
    });
    const res = (await handleApi(request, w.env, w.ctx, w.deps)) as Response;
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
  });
});

describe("the switch", () => {
  test("FORGE_OPEN without Turnstile opens nothing: the owner writes, nobody else", async () => {
    delete w.env.TURNSTILE_SECRET_KEY;
    const ada = await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const refused = await bob.post("/api/forge/research/open", ISSUE);
    assert.equal(refused.status, 403);
    assert.equal((await body(refused)).error.code, "forge_closed");
    assert.equal((await ada.post("/api/forge/research/open", { ...ISSUE, ...NONE })).status, 201, "the owner, not asked while the check is not set up");
    // Reports need the check whatever the switch says.
    assert.equal((await w.browser().post("/api/forge/report", { target: "research:1", reason: "spam" }, { csrf: null })).status, 503);
    // Set up: everyone, each behind the check.
    w.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
    assert.equal((await bob.post("/api/forge/research/open", ISSUE)).status, 201);
    // Unset: back to the owner only.
    delete w.env.FORGE_OPEN;
    assert.equal((await body(await bob.post("/api/forge/research/open", ISSUE))).error.code, "forge_closed");
  });
});

describe("abuse", () => {
  test("a suspended account makes no token", async () => {
    const ada = await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const bobGithub = String([...w.backend.accounts.values()].find((a) => a.login === "bob-fixture")!.id);
    assert.equal((await ada.post("/api/forge/moderation/decide", { op: "hide", target: `person:github:${bobGithub}`, reason: "spam" })).status, 200);
    const res = await bob.post("/api/forge/tokens/write", { op: "create", name: "ci", scopes: ["research:read"], days: 30 });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "suspended");
  });

  test("an address sending wrong tokens is refused before any read, for the rest of the minute", async () => {
    const call = (ip: string) =>
      handleApi(new Request("https://registry.example/api/v1/user", { headers: { Authorization: `Bearer oscr_pat_${"x".repeat(43)}`, "CF-Connecting-IP": ip } }), w.env, w.ctx, w.deps) as Promise<Response>;
    for (let i = 0; i < BAD_TOKENS_PER_MINUTE; i++) assert.equal((await call("203.0.113.9")).status, 401);
    w.forge.reset();
    const refused = await call("203.0.113.9");
    assert.equal(refused.status, 429);
    assert.equal((await body(refused)).error.code, "too_many_bad_tokens");
    assert.equal(w.forge.totals.queries, 0, "no read of D1");
    assert.equal((await call("198.51.100.4")).status, 401, "another address is not refused");
    w.advance(60);
    assert.equal((await call("203.0.113.9")).status, 401, "the next minute");
  });
});
