// A release's file through the Worker (night phase 07, E5; asset.ts, act.ts `runAction`): start
// asset_upload, GitHub (the double), then POST /api/forge/asset with the file as the body. The file
// streamed to GitHub as the person, never parsed; its length held to the one declared; GitHub's
// SHA-256 against the page's; refused before GitHub when too large, malformed or for another action.
// And the callback page's side: the file taken from the tab's store, posted with the completion.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { arrive } from "../../src/scripts/forge-authorized.ts";
import { ASSET_PATH, PENDING_KEY, toBase64url, type FileStore } from "../../src/scripts/forge-client.ts";
import { fromBase64url, heldTo } from "../../worker/forge/service/asset.ts";
import { ASSET_UPLOAD_BYTES } from "../../worker/forge/service/caps.ts";
import { handleForge } from "../../worker/forge/service/index.ts";
import { signIn, start, watchAuth } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, keepCookies, type ForgeBrowser, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });
const DATA = new TextEncoder().encode("subject,alpha_ratio\n1,2.05\n2,1.80\n3,0.29\n");
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");

async function draft(): Promise<{ id: string; release: string }> {
  const id = (await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true })).key.id;
  const head = await ada().git.resolve(REF, "main");
  const release = await ada().releases.create(REF, { tagName: "v1.0.0", target: head, draft: true });
  return { id, release: release.id };
}

const input = (id: string, payload: Record<string, unknown>, kind = "asset_upload"): StartInput => ({
  kind: kind as StartInput["kind"],
  repo: { forge: "memory", id },
  branch: null,
  expectedHead: null,
  payload,
  back: "/r/ada-fixture/eeg/releases/",
});

/** POST /api/forge/asset as the callback page does: the completion in headers, the file as the body. */
async function postFile(b: ForgeBrowser, bytes: Uint8Array, h: Record<string, string>): Promise<{ res: Response; body: Json }> {
  const csrf = (await b.me()).csrf as string;
  const headers = new Headers({ "Content-Type": "application/octet-stream", Origin: b.origin, "X-CSRF-Token": csrf, "Content-Length": String(bytes.length), ...h });
  if (b.jar.size) headers.set("Cookie", [...b.jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const request = new Request(new URL(ASSET_PATH, b.origin), { method: "POST", headers, body: bytes as Uint8Array<ArrayBuffer> });
  const res = (await handleForge(request, w.env, w.ctx, w.deps)) as Response;
  keepCookies(b, res);
  return { res, body: (await res.clone().json().catch(() => ({}))) as Json };
}

/** Start the action, approve on the double's GitHub; the completion's headers. */
async function authorized(b: ForgeBrowser, i: StartInput): Promise<Record<string, string>> {
  const s = await start(b, i);
  assert.equal(s.res.status, 200, JSON.stringify(s.body));
  const { code, state } = w.backend.authorize(String(s.body.location), ADA_LOGIN);
  return { "X-Forge-Code": code, "X-Forge-State": state, "X-Forge-Payload": toBase64url(s.payload) };
}

describe("POST /api/forge/asset", () => {
  test("the file streamed to GitHub as Ada: its digest GitHub's, the action row only, the token revoked", async () => {
    const b = await signIn(w);
    const { id, release } = await draft();
    const seen = watchAuth(w);
    const headers = await authorized(b, input(id, { release, name: "figure-2 source data.csv", label: "Source data of Figure 2", size: DATA.length, sha256: await sha(DATA), contentType: "text/csv" }));
    w.forge.reset();
    const { res, body } = await postFile(b, DATA, headers);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.result.digest, await sha(DATA));
    assert.equal(body.result.size, DATA.length);
    assert.match(body.sentence, /^Attach the file figure-2 source data\.csv \(\d+ bytes, SHA-256 [0-9a-f]{12}…\), labelled “Source data of Figure 2”, to the release$/);
    const [asset] = (await ada().releases.get(REF, release)).assets;
    assert.equal(asset.name, "figure-2 source data.csv");
    assert.equal(asset.label, "Source data of Figure 2");
    assert.equal(w.forge.totals.written, 1);
    assert.equal(forgeRows(w.forge, "actions")[0].kind, "asset_upload");
    assert.deepEqual(seen.revoked, seen.issued);
    assert.ok(res.headers.getSetCookie().some((c) => /^__Host-oscr_forge=;/.test(c)), "the flow cleared");
    // One authorization, one attempt: the same completion again is refused.
    const again = await postFile(b, DATA, headers);
    assert.equal(again.res.status, 400);
    assert.equal(again.body.error.code, "bad_state");
  });

  test("refused before GitHub: too large, no length, a malformed completion, a size other than confirmed", async () => {
    const b = await signIn(w);
    const { id, release } = await draft();
    const seen = watchAuth(w);
    const payload = { release, name: "a.csv", size: DATA.length, sha256: await sha(DATA), contentType: "text/csv" };
    const headers = await authorized(b, input(id, payload));
    const big = await postFile(b, DATA, { ...headers, "Content-Length": String(ASSET_UPLOAD_BYTES + 1) });
    assert.equal(big.res.status, 413);
    assert.match(big.body.error.message, /GitHub's own release page/);
    const none = await postFile(b, DATA, { ...(await authorized(b, input(id, payload))), "Content-Length": "0" });
    assert.equal(none.res.status, 411);
    const bad = await postFile(b, DATA, { ...(await authorized(b, input(id, payload))), "X-Forge-Payload": "not base64 %%" });
    assert.equal(bad.res.status, 400);
    assert.deepEqual(seen.issued, [], "no code was exchanged");
    // The file that arrives is not the size confirmed: the spec refuses it, nothing reaches GitHub.
    const other = new TextEncoder().encode("x,y\n");
    const short = await postFile(b, other, await authorized(b, input(id, payload)));
    assert.equal(short.res.status, 400);
    assert.equal(short.body.error.code, "bad_size");
    assert.deepEqual((await ada().releases.get(REF, release)).assets, []);
    assert.equal(forgeRows(w.forge, "actions").length, 0);
  });

  test("the route completes a file only; act never carries one; another file than confirmed is removed again", async () => {
    const b = await signIn(w);
    const { id, release } = await draft();
    const drafts = await postFile(b, DATA, await authorized(b, input(id, {}, "release_drafts")));
    assert.equal(drafts.res.status, 400);
    assert.equal(drafts.body.error.code, "bad_request");
    // Confirmed with one digest, another file sent (same length): GitHub's digest differs.
    const twin = new Uint8Array(DATA);
    twin[0] = "S".charCodeAt(0);
    const payload = { release, name: "a.csv", size: DATA.length, sha256: await sha(DATA), contentType: "text/csv" };
    const swapped = await postFile(b, twin, await authorized(b, input(id, payload)));
    assert.equal(swapped.res.status, 502);
    assert.equal(swapped.body.error.code, "digest_mismatch");
    assert.deepEqual((await ada().releases.get(REF, release)).assets, [], "removed again, as Ada");
    assert.equal(forgeRows(w.forge, "actions").length, 0);
  });

  test("signed in, from the registry's own page, with its CSRF token: else refused before anything is read", async () => {
    const b = await signIn(w);
    const { id, release } = await draft();
    const seen = watchAuth(w);
    const headers = await authorized(b, input(id, { release, name: "a.csv", size: DATA.length, sha256: await sha(DATA), contentType: "text/csv" }));
    const noCsrf = await postFile(b, DATA, { ...headers, "X-CSRF-Token": "forged" });
    assert.equal(noCsrf.res.status, 403);
    assert.equal(noCsrf.body.error.code, "bad_csrf");
    const elsewhere = await postFile(b, DATA, { ...headers, Origin: "https://evil.example" });
    assert.equal(elsewhere.res.status, 403);
    assert.equal(elsewhere.body.error.code, "bad_origin");
    b.jar.clear();
    const out = new Request(new URL(ASSET_PATH, b.origin), { method: "POST", headers: { Origin: b.origin, "Content-Length": String(DATA.length), ...headers }, body: DATA as Uint8Array<ArrayBuffer> });
    assert.equal(((await handleForge(out, w.env, w.ctx, w.deps)) as Response).status, 401);
    assert.deepEqual(seen.issued, [], "no code was exchanged");
    assert.deepEqual((await ada().releases.get(REF, release)).assets, []);
  });

  test("closed to everyone but the owner while FORGE_OPEN is unset", async () => {
    w.restore();
    w = forgeWorld();
    const { id, release } = await draft();
    const bob = await signIn(w, "bob");
    const s = await start(bob, input(id, { release, name: "a.csv", size: 3, sha256: "c".repeat(64), contentType: "text/csv" }));
    assert.equal(s.res.status, 403);
    assert.equal(s.body.error.code, "forge_closed");
  });
});

describe("the pieces", () => {
  test("base64url both ways, UTF-8 names kept; anything else refused", () => {
    const text = JSON.stringify({ name: "données α.csv", label: "Figure 2, source" });
    assert.equal(fromBase64url(toBase64url(text)), text);
    for (const v of [null, "", "a+b", "a/b", "==", "x".repeat(9000)]) assert.equal(fromBase64url(v), null, String(v).slice(0, 10));
  });

  test("a body held to its declared length: longer or shorter fails", async () => {
    const stream = (parts: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
    assert.equal(await new Response(heldTo(stream(["ab", "cd"]), 4)).text(), "abcd");
    await assert.rejects(new Response(heldTo(stream(["ab", "cde"]), 4)).text());
    await assert.rejects(new Response(heldTo(stream(["ab"]), 4)).text());
  });

  test("the callback page: the file taken from the tab's store, posted with the completion; none kept, said", async () => {
    const payload = JSON.stringify({ release: "7", name: "a.csv", size: 3, sha256: "c".repeat(64), contentType: "text/csv" });
    const pending = { kind: "asset_upload", payload, digest: "d".repeat(64), sentence: "Attach the file a.csv", back: "/r/ada-fixture/eeg/releases/", at: 1000 };
    const session = new Map<string, string>();
    const storage = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) };
    const taken: string[] = [];
    const files: FileStore = { put: async () => true, take: async (k) => (taken.push(k), new Blob(["abc"])) };
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url === "/api/account/me") return Response.json({ signed_in: true, csrf: "tok" });
      return Response.json({ result: { id: "5", name: "a.csv", size: 3, digest: null, release: "7", page: "/r/ada-fixture/eeg/releases/", links: [], notes: [] }, sentence: "Attach the file a.csv", back: pending.back });
    }) as unknown as typeof fetch;
    session.set(PENDING_KEY, JSON.stringify(pending));
    const out = await arrive("?code=abc&state=xyz", { storage, files, fetch: fetchStub, now: () => 1010 });
    assert.deepEqual(taken, [pending.digest]);
    const post = calls.find((c) => c.url === ASSET_PATH)!;
    const h = new Headers(post.init.headers);
    assert.equal(h.get("X-Forge-Code"), "abc");
    assert.equal(h.get("X-Forge-State"), "xyz");
    assert.equal(fromBase64url(h.get("X-Forge-Payload")), payload);
    assert.equal(h.get("X-CSRF-Token"), "tok");
    assert.ok(post.init.body instanceof Blob);
    assert.equal(out[0].tone, "ok");
    // No file kept (another tab, a private window): said, nothing posted.
    session.set(PENDING_KEY, JSON.stringify(pending));
    calls.length = 0;
    const none = await arrive("?code=abc&state=xyz", { storage, files: { put: async () => true, take: async () => null }, fetch: fetchStub, now: () => 1010 });
    assert.equal(none[0].tone, "warning");
    assert.match(none[0].text[0], /not kept in this tab/);
    assert.ok(!calls.some((c) => c.url === ASSET_PATH));
  });
});
