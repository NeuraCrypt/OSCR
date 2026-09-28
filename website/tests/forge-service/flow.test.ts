// The flow cookie of one authorized action (worker/forge/service/flow.ts; the design's §10.2 step 2
// and §17): sealed and opened with the server key under the HMAC purpose "forge", never valid as the
// sign-in's flow ("flow") or a CSRF token ("csrf") and the other way round; refused when expired,
// altered, signed with another key or malformed; its attributes; the return page a path of this
// site only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SESSION_KEY } from "../account/browser.ts";
import { base64url, hmac } from "../../worker/account/crypto.ts";
import { openFlow, sealFlow, type Flow } from "../../worker/account/flow.ts";
import { csrfToken, csrfValid } from "../../worker/account/session.ts";
import { FLOW_SECONDS } from "../../worker/forge/service/caps.ts";
import {
  callbackUrl,
  clearFlowCookie,
  FORGE_COOKIE,
  FORGE_PURPOSE,
  flowCookie,
  openForgeFlow,
  repoTarget,
  sameOriginPath,
  sealForgeFlow,
  type ForgeFlow,
} from "../../worker/forge/service/flow.ts";

const NOW = 1_790_596_800;
const SID = "a".repeat(64);
const DIGEST = "0123456789abcdef".repeat(4);

function aFlow(over: Partial<ForgeFlow> = {}): ForgeFlow {
  return {
    v: 1,
    st: "s".repeat(43),
    cv: "v".repeat(43),
    act: { kind: "rename", forge: "github", repo: { forge: "github", id: "4242" }, branch: "main", expectedHead: "f".repeat(40), digest: DIGEST },
    sid: SID,
    rt: "/r/ada/eeg/settings/",
    ins: false,
    exp: NOW + FLOW_SECONDS,
    ...over,
  };
}

function signInFlow(): Flow {
  return { v: 1, p: "github", st: "s".repeat(43), cv: "v".repeat(43), n: "n".repeat(43), in: "signin", sid: "", rp: "", rt: "/account/", exp: NOW + 600 };
}

describe("the flow cookie", () => {
  test("seal and open: the same flow comes back", async () => {
    const flow = aFlow();
    const value = await sealForgeFlow(SESSION_KEY, flow);
    assert.deepEqual(await openForgeFlow(SESSION_KEY, value, NOW), flow);
    // A flow by path, and one without a repository (create), round trip too.
    const byPath = aFlow({ act: { ...aFlow().act, repo: { forge: "github", owner: "ada", name: "eeg" } } });
    assert.deepEqual(await openForgeFlow(SESSION_KEY, await sealForgeFlow(SESSION_KEY, byPath), NOW), byPath);
    const none = aFlow({ act: { kind: "create", forge: "github", repo: null, branch: null, expectedHead: null, digest: DIGEST }, ins: true });
    assert.deepEqual(await openForgeFlow(SESSION_KEY, await sealForgeFlow(SESSION_KEY, none), NOW), none);
    // It holds no token: the state, the verifier, the declared action, the session's hash, the page.
    const decoded = Buffer.from(value.split(".")[0], "base64url").toString("utf8");
    assert.deepEqual(Object.keys(JSON.parse(decoded)).sort(), ["act", "cv", "exp", "ins", "rt", "sid", "st", "v"]);
  });

  test("purpose separation: a forge flow is never a sign-in flow or a CSRF token, and the other way round", async () => {
    assert.equal(FORGE_PURPOSE, "forge");
    // A sign-in flow's cookie, opened as a forge flow: refused (its signature is for "flow").
    const signin = await sealFlow(SESSION_KEY, signInFlow());
    assert.equal(await openForgeFlow(SESSION_KEY, signin, NOW), null);
    // A forge flow's cookie, opened as a sign-in flow: refused.
    const forge = await sealForgeFlow(SESSION_KEY, aFlow());
    assert.equal(await openFlow(SESSION_KEY, forge, NOW), null);
    // The same body signed for "flow" or "csrf" is not a forge flow; signed for "forge" it is.
    const body = forge.split(".")[0];
    for (const purpose of ["flow", "csrf"]) {
      assert.equal(await openForgeFlow(SESSION_KEY, `${body}.${await hmac(SESSION_KEY, purpose, body)}`, NOW), null, purpose);
    }
    assert.notEqual(await openForgeFlow(SESSION_KEY, `${body}.${await hmac(SESSION_KEY, "forge", body)}`, NOW), null);
    // A CSRF token is not a forge signature, and a forge signature is not a CSRF token.
    const csrf = await csrfToken(SESSION_KEY, SID);
    assert.equal(await openForgeFlow(SESSION_KEY, `${body}.${csrf}`, NOW), null);
    assert.equal(await csrfValid(SESSION_KEY, SID, forge.split(".")[1]), false);
  });

  test("refused: expired, altered, another key, malformed, or not a flow this code wrote", async () => {
    const value = await sealForgeFlow(SESSION_KEY, aFlow());
    // Expired: valid up to its second, not after.
    assert.notEqual(await openForgeFlow(SESSION_KEY, value, NOW + FLOW_SECONDS), null);
    assert.equal(await openForgeFlow(SESSION_KEY, value, NOW + FLOW_SECONDS + 1), null);
    // Altered: the body changed (another repository, another digest), the signature kept.
    const [body, sig] = value.split(".");
    const other = base64url(new TextEncoder().encode(JSON.stringify(aFlow({ act: { ...aFlow().act, digest: "1".repeat(64) } }))));
    assert.equal(await openForgeFlow(SESSION_KEY, `${other}.${sig}`, NOW), null);
    assert.equal(await openForgeFlow(SESSION_KEY, `${body}.${sig.slice(0, -2)}AA`, NOW), null);
    // Another server key.
    assert.equal(await openForgeFlow(`${SESSION_KEY}-other`, value, NOW), null);
    // Malformed values.
    for (const bad of [null, undefined, "", "abc", `${body}.`, `.${sig}`, `${value}.x`, "x".repeat(5000), `${body}!.${sig}`]) {
      assert.equal(await openForgeFlow(SESSION_KEY, bad, NOW), null, String(bad).slice(0, 20));
    }
    // Signed by the server, but not a flow of this shape: each is refused.
    const shapes: unknown[] = [
      { ...aFlow(), v: 2 },
      { ...aFlow(), st: "short" },
      { ...aFlow(), sid: "not-a-hash" },
      { ...aFlow(), rt: "https://elsewhere.test/" },
      { ...aFlow(), rt: "//elsewhere.test/" },
      { ...aFlow(), act: { ...aFlow().act, kind: "drop_table" } },
      { ...aFlow(), act: { ...aFlow().act, digest: "XYZ" } },
      { ...aFlow(), act: { ...aFlow().act, branch: "a..b" } },
      { ...aFlow(), act: { ...aFlow().act, expectedHead: "main" } },
      { ...aFlow(), act: { ...aFlow().act, repo: { forge: "gitlab", id: "1" } } },
      { ...aFlow(), exp: "tomorrow" },
      [aFlow()],
    ];
    for (const shape of shapes) {
      const b = base64url(new TextEncoder().encode(JSON.stringify(shape)));
      assert.equal(await openForgeFlow(SESSION_KEY, `${b}.${await hmac(SESSION_KEY, "forge", b)}`, NOW), null, JSON.stringify(shape).slice(0, 80));
    }
  });

  test("another session's cookie is a valid seal, bound to that session's hash (act compares it)", async () => {
    const mine = await openForgeFlow(SESSION_KEY, await sealForgeFlow(SESSION_KEY, aFlow()), NOW);
    const theirs = await openForgeFlow(SESSION_KEY, await sealForgeFlow(SESSION_KEY, aFlow({ sid: "b".repeat(64) })), NOW);
    assert.equal(mine?.sid, SID);
    assert.notEqual(theirs?.sid, mine?.sid);
  });

  test("the cookie: __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes; cleared with Max-Age=0", async () => {
    const set = await flowCookie(SESSION_KEY, aFlow());
    assert.ok(set.startsWith(`${FORGE_COOKIE}=`));
    assert.equal(FORGE_COOKIE, "__Host-oscr_forge");
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${FLOW_SECONDS}`]) assert.ok(set.includes(attribute), attribute);
    assert.ok(!/Domain=/i.test(set));
    assert.equal(FLOW_SECONDS, 600);
    const cleared = clearFlowCookie();
    assert.ok(cleared.startsWith(`${FORGE_COOKIE}=;`));
    assert.ok(cleared.includes("Max-Age=0"));
  });

  test("the return page: a path of this site only", () => {
    for (const ok of ["/", "/repositories/", "/r/ada/eeg/settings/", "/new/link/", "/paper/10.1000_x/"]) assert.equal(sameOriginPath(ok), ok);
    for (const bad of [
      "",
      "repositories/",
      "//evil.test/",
      "https://evil.test/",
      "/\\evil.test",
      "/api/forge/act",
      "/a/../api/x",
      "/r/?next=https://evil.test",
      "/r/#x",
      "javascript:alert(1)",
      `/${"a".repeat(200)}`,
      null,
      42,
    ]) {
      assert.equal(sameOriginPath(bad), null, String(bad));
    }
    assert.equal(callbackUrl("https://registry.test"), "https://registry.test/forge/authorized/");
  });

  test("a repository as a page names it: by id or by path, on the backend's forge only", () => {
    assert.deepEqual(repoTarget({ forge: "github", id: "42" }, "github"), { forge: "github", id: "42" });
    assert.deepEqual(repoTarget({ forge: "github", owner: "ada", name: "eeg" }, "github"), { forge: "github", owner: "ada", name: "eeg" });
    assert.equal(repoTarget(null, "github"), null);
    for (const bad of [
      { forge: "memory", id: "42" },
      { forge: "github", id: "abc" },
      { forge: "github", id: "42", owner: "ada" },
      { forge: "github", owner: "ada", name: "eeg.git" },
      { forge: "github", owner: "../x", name: "eeg" },
      { forge: "github", owner: "ada" },
      "ada/eeg",
      [],
    ]) {
      assert.equal(repoTarget(bad, "github"), undefined, JSON.stringify(bad));
    }
  });
});
