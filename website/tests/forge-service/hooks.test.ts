// Outgoing webhooks (night phase 10, E3; hooks-core.ts, hooks.ts): an address never on a private
// network or this machine; pinged before it is active; signed with a secret derived from the server key
// (never stored, answered once); delivered after the batch that wrote the event, in waitUntil, retried
// within the request, never following a redirection; each delivery 1 row; paused after ten failures;
// redelivered, rotated, paused and deleted by its person; FORGE_OPEN on every new write.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { handleApi } from "../../worker/forge/service/api.ts";
import { eventWrite, type EventRow } from "../../worker/forge/service/events.ts";
import {
  eventPayload,
  HOOKS_PER_ACCOUNT,
  hookSecret,
  hookUrl,
  PAUSE_AFTER_FAILURES,
  privateIpv4,
  readEvents,
  signDelivery,
  validateHook,
} from "../../worker/forge/service/hooks-core.ts";
import { handleForge } from "../../worker/forge/service/index.ts";
import { upsertInstallation } from "../../worker/forge/service/store.ts";
import { ForgeProblem, isProblem } from "../../worker/forge/service/types.ts";
import type { ForgeEvent, RepoStub } from "../../worker/forge/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const RECEIVER = "https://hooks.lab.example/oscr";
const PAPER = "paper:doi:10.1234/eeg.2026";
const WEBHOOK_SECRET = "whsec-test-0123456789";
const INST = "7001";

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
}

/** A receiver: records every request, answers from a script (the last answer repeats). */
function receiver(answers: (number | "throw")[] = [200]) {
  const got: Received[] = [];
  let i = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    got.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? ""), redirect: init?.redirect });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (a === "throw") throw new TypeError("connection refused");
    return new Response("thanks, ada@example.org", { status: a, headers: a >= 300 && a < 400 ? { Location: "http://169.254.169.254/" } : {} });
  }) as typeof fetch;
  return { got, fetchFn, answer: (next: (number | "throw")[]) => ((answers = next), (i = 0)) };
}

let w: ForgeWorld;
let rx: ReturnType<typeof receiver>;
beforeEach(async () => {
  rx = receiver();
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1", GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET }, deps: { hookFetch: (...a: Parameters<typeof fetch>) => rx.fetchFn(...a) } });
  await w.forge.batch([upsertInstallation(w.forge, { forge: "memory", id: INST, accountId: "5001", accountLogin: "lab", accountType: "organization", selection: "all", suspended: false }, T0).stmt]);
  await seed.repo(w.forge, { repoId: "101", ownerId: "5001", ownerLogin: "lab", name: "eeg", mode: "installed", installationId: INST, defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: "doi:10.1234/eeg.2026", status: "linked" }] });
  w.forge.reset();
});
afterEach(() => w.restore());

const sig = (secret: string, raw: string) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

async function makeHook(b: ForgeBrowser, extra: Json = {}): Promise<Json> {
  const res = await b.post("/api/forge/hooks/write", { op: "create", subject: PAPER, url: RECEIVER, events: "*", ...extra });
  return { status: res.status, ...(await body(res)) };
}

async function settle(): Promise<void> {
  await Promise.all(w.ctx.waited);
  w.ctx.waited.length = 0;
}

describe("the address (SSRF)", () => {
  test("https, a public name or address; never this machine, a private network, a local name, the registry itself", () => {
    assert.equal(hookUrl("https://hooks.lab.example/x?y=1"), "https://hooks.lab.example/x?y=1");
    assert.equal(hookUrl("https://93.184.215.14:8443/in"), "https://93.184.215.14:8443/in");
    const refused = [
      "http://hooks.lab.example/x",
      "https://localhost/x",
      "https://localhost./x",
      "https://127.0.0.1/x",
      "https://2130706433/x",
      "https://0x7f.0.0.1/x",
      "https://0.0.0.0/x",
      "https://10.1.2.3/x",
      "https://172.16.0.9/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/x",
      "https://224.0.0.1/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://metadata.google.internal/x",
      "https://printer.local/x",
      "https://intranet/x",
      "https://app.localhost/x",
      "https://127.0.0.1.nip.io/x",
      "https://user:pass@hooks.lab.example/x",
      "https://hooks.lab.example:22/x",
      "https://hooks.lab.example/x#frag",
      "ftp://hooks.lab.example/x",
      "javascript:alert(1)",
      "https://registry.example/api/forge/webhook",
    ];
    for (const u of refused) assert.ok(hookUrl(u, { siteHost: "registry.example" }) instanceof ForgeProblem, u);
    assert.ok(privateIpv4("198.18.0.1") && privateIpv4("192.0.2.1") && !privateIpv4("8.8.8.8"));
    // Development only: the local receiver.
    assert.equal(hookUrl("http://127.0.0.1:9492/hook", { allowLocal: true }), "http://127.0.0.1:9492/hook");
    assert.ok(hookUrl("http://10.0.0.1/hook", { allowLocal: true }) instanceof ForgeProblem);
  });

  test("the development switches are never in the Worker's configuration", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    for (const name of ["HOOKS_ALLOW_LOCAL", "GITHUB_OIDC_ISSUER", "FORGE_OPEN =", "API_LIMITER"]) assert.ok(!toml.includes(name), name);
  });

  test("a hook's subject and events: a repository's or a paper's own", () => {
    assert.equal(readEvents("*", PAPER), "*");
    assert.deepEqual(readEvents(["research_closed", "research_opened"], PAPER), ["research_opened", "research_closed"]);
    assert.ok(readEvents(["issue_opened"], PAPER) instanceof ForgeProblem);
    assert.deepEqual(readEvents(["release_published", "issue_opened"], "repo:github:5"), ["issue_opened", "release_published"]);
    assert.ok(readEvents(["research_opened"], "repo:github:5") instanceof ForgeProblem);
    const ok = validateHook({ subject: "paper:https://doi.org/10.1234/EEG.2026", url: RECEIVER });
    assert.ok(!isProblem(ok) && ok.subject === PAPER && ok.events === "*");
    assert.ok(isProblem(validateHook({ subject: "topic:eeg", url: RECEIVER })));
  });

  test("the secret: derived, never stored; the signature is GitHub's scheme", async () => {
    const a = await hookSecret("k".repeat(40), "hook-id-00000001", "salt-00000000001");
    assert.match(a, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(a, await hookSecret("k".repeat(40), "hook-id-00000001", "salt-00000000001"));
    assert.notEqual(a, await hookSecret("k".repeat(40), "hook-id-00000001", "salt-00000000002"));
    assert.notEqual(a, await hookSecret("j".repeat(40), "hook-id-00000001", "salt-00000000001"));
    assert.equal(await signDelivery(a, '{"a":1}'), sig(a, '{"a":1}'));
  });

  test("a payload: the event's words, an absolute page, no text, no account id", () => {
    const e = { subject: PAPER, at: T0, nonce: "n1", kind: "research_opened", thread: "research:7", title: "Ask ada@example.org", url: "/research/7", repo_path: "lab/eeg", paper_id: "doi:10.1234/eeg.2026", actor_user: "u_secret_id", actor_github: "42", actor_name: "ada-fixture", thread_author: "", mentions: "", ref: "" } as EventRow;
    const p = eventPayload({ id: "h".repeat(16), subject: PAPER }, e, "g", "https://registry.example", T0);
    assert.equal(p.url, "https://registry.example/research/7");
    assert.deepEqual(p.paper, { doi: "10.1234/eeg.2026", url: "https://doi.org/10.1234/eeg.2026" });
    const text = JSON.stringify(p);
    assert.ok(!text.includes("u_secret_id") && !text.includes("ada@example.org"));
  });
});

describe("making a hook", () => {
  test("pinged first, signed, active on 2xx; its secret answered once; 4 rows; listed without it", async () => {
    const b = await signIn(w);
    const made = await makeHook(b);
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.equal(made.written, 4);
    assert.equal(made.hook.active, true);
    assert.equal(made.ping.ok, true);
    assert.equal(rx.got.length, 1);
    const ping = rx.got[0];
    assert.equal(ping.url, RECEIVER);
    assert.equal(ping.redirect, "manual");
    assert.equal(ping.headers["x-hook-event"], "ping");
    assert.equal(ping.headers["x-hub-signature-256"], sig(made.secret, ping.body));
    assert.equal(JSON.parse(ping.body).hook.id, made.hook.id);
    // Nothing secret in D1: the salt only.
    const [row] = forgeRows(w.forge, "hooks");
    assert.equal(row.active, 1);
    assert.ok(!JSON.stringify(forgeRows(w.forge, "hooks")).includes(made.secret));
    const [d] = forgeRows(w.forge, "hook_deliveries");
    assert.deepEqual([d.event, d.status, d.ok], ["ping", 200, 1]);
    assert.ok(!String(d.words).includes("@"));
    const list = await body(await b.fetch("/api/forge/hooks"));
    assert.equal(list.hooks.length, 1);
    assert.ok(!JSON.stringify(list).includes(made.secret) && !JSON.stringify(list).includes(String(row.salt)));
    assert.deepEqual(w.forge.scans, []);
  });

  test("a receiver that fails the ping: made, not active; pinged again later, active", async () => {
    const b = await signIn(w);
    rx.answer([404]);
    const made = await makeHook(b);
    assert.equal(made.status, 201);
    assert.equal(made.hook.active, false);
    assert.equal(made.ping.words, "the receiver answered 404");
    rx.answer([200]);
    const again = await body(await b.post("/api/forge/hooks/write", { op: "ping", id: made.hook.id }));
    assert.equal(again.active, true);
    assert.equal(forgeRows(w.forge, "hooks")[0].active, 1);
  });

  test("refused: an address, an unknown repository, twice the same, the account's cap, Origin, CSRF, FORGE_OPEN", async () => {
    const b = await signIn(w);
    assert.equal((await makeHook(b, { url: "https://10.0.0.8/hook" })).status, 400);
    assert.equal((await makeHook(b, { subject: "repo:memory:999" })).error.code, "unknown_subject");
    assert.equal((await makeHook(b)).status, 201);
    assert.equal((await makeHook(b)).error.code, "already_hooked");
    for (let i = 1; i < HOOKS_PER_ACCOUNT; i++) assert.equal((await makeHook(b, { url: `${RECEIVER}/${i}` })).status, 201);
    assert.equal((await makeHook(b, { url: `${RECEIVER}/x` })).error.code, "too_many_hooks");
    assert.equal((await b.post("/api/forge/hooks/write", { op: "create", subject: PAPER, url: RECEIVER }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post("/api/forge/hooks/write", { op: "create", subject: PAPER, url: RECEIVER }, { csrf: "no" })).status, 403);
    const bob = await signIn(w, "bob-fixture");
    rx.got.length = 0;
    const closed = await makeHook(bob, { url: `${RECEIVER}/bob` });
    assert.equal(closed.error.code, "forge_closed");
    assert.equal(rx.got.length, 0, "nothing is sent for a refused hook");
  });
});

describe("delivering events", () => {
  test("a research issue opened: its paper's hook gets it after the batch, signed; 1 row; the text never", async () => {
    const b = await signIn(w);
    const made = await makeHook(b);
    rx.got.length = 0;
    w.forge.reset();
    const opened = await b.post("/api/forge/research/open", {
      paper: "10.1234/eeg.2026",
      repo: { forge: "memory", id: "101", path: "lab/eeg" },
      type: "mismatch",
      title: "The filter's order is 4, the paper says 2",
      body: "Private data: ada@example.org",
      commit: "a".repeat(40),
      path: "src/filter.py",
      lines: { start: 12, end: 18 },
      paragraph: 14,
    });
    assert.equal(opened.status, 201, JSON.stringify(await body(opened)));
    const id = (await body(opened)).id;
    await settle();
    assert.equal(rx.got.length, 1);
    const got = rx.got[0];
    const p = JSON.parse(got.body);
    assert.equal(p.event, "research_opened");
    assert.equal(p.thread, `research:${id}`);
    assert.equal(p.url, `${ORIGIN}/research/${id}`);
    assert.equal(got.headers["x-hub-signature-256"], sig(made.secret, got.body));
    assert.equal(got.headers["x-hook-delivery"], p.delivery);
    assert.ok(!got.body.includes("ada@example.org") && !got.body.includes("Private data"));
    const deliveries = forgeRows(w.forge, "hook_deliveries").filter((d) => d.event === "research_opened");
    assert.equal(deliveries.length, 1);
    assert.deepEqual(w.forge.scans, []);
  });

  test("an event of GitHub's webhook: the repository's hook gets it once", async () => {
    const b = await signIn(w);
    const res = await b.post("/api/forge/hooks/write", { op: "create", subject: "repo:memory:101", url: RECEIVER, events: ["issue_comment"] });
    assert.equal(res.status, 201);
    // The list names the repository by its path.
    assert.equal((await body(await b.fetch("/api/forge/hooks"))).hooks[0].label, "lab/eeg");
    rx.got.length = 0;
    const stub: RepoStub = { key: { forge: "memory", id: "101" }, ref: { forge: "memory", owner: "lab", name: "eeg" }, visibility: "public", defaultBranch: "main" };
    const bob = { name: "bob-fixture", login: "bob-fixture", id: "77" };
    const event: ForgeEvent = { kind: "issue_comment", delivery: "d-hook-1", installation: INST, action: "created", number: 3, title: "The filter", isPull: false, commentId: "9001", author: bob, mentions: [], repo: stub, sender: bob };
    const d = await w.backend.deliver(event, WEBHOOK_SECRET);
    const post = () => handleForge(new Request(new URL("/api/forge/webhook", ORIGIN), { method: "POST", headers: d.headers, body: d.body as Uint8Array<ArrayBuffer> }), w.env, w.ctx, w.deps);
    assert.equal(((await post()) as Response).status, 200);
    await settle();
    assert.equal(rx.got.length, 1);
    assert.equal(JSON.parse(rx.got[0].body).event, "issue_comment");
    // GitHub redelivers it: nothing twice.
    await post();
    await settle();
    assert.equal(rx.got.length, 1);
  });

  test("retries within the request (5xx, no answer), never after a 4xx or a redirection", async () => {
    const b = await signIn(w);
    await makeHook(b);
    const write = (n: string) => w.forge.batch([eventWrite(w.forge, { subject: PAPER, at: T0, nonce: n, kind: "research_comment", thread: "research:1", title: "t", url: "/research/1" }).stmt]);
    const { queueHooks } = await import("../../worker/forge/service/hooks.ts");
    const r = { db: w.forge, env: w.env, url: new URL(ORIGIN), t: T0, ctx: w.ctx, deps: w.deps } as never;
    const cases: [(number | "throw")[], number, boolean, string][] = [
      [[500, "throw", 200], 3, true, "delivered"],
      [[503, 503, 503], 3, false, "the receiver answered 503"],
      [[404], 1, false, "the receiver answered 404"],
      [[302], 1, false, "a redirection, not followed"],
    ];
    for (const [i, [answers, attempts, ok, words]] of cases.entries()) {
      rx.answer(answers);
      rx.got.length = 0;
      await write(`nonce-000-${i}`);
      queueHooks(r, [{ subject: PAPER, at: T0, nonce: `nonce-000-${i}` }]);
      await settle();
      assert.equal(rx.got.length, attempts, JSON.stringify(answers));
      const row = forgeRows(w.forge, "hook_deliveries").find((d) => d.ev_nonce === `nonce-000-${i}`)!;
      assert.deepEqual([row.attempts, row.ok === 1, row.words], [attempts, ok, words]);
    }
  });

  test("ten failures in a row pause the hook; a ping brings it back", async () => {
    const b = await signIn(w);
    const made = await makeHook(b);
    rx.answer([400]);
    const { queueHooks } = await import("../../worker/forge/service/hooks.ts");
    // Each event a second after the other (the deliveries' order is their time).
    const at = (t: number) => ({ db: w.forge, env: w.env, url: new URL(ORIGIN), t, ctx: w.ctx, deps: w.deps }) as never;
    const r = at(T0 + 60);
    for (let i = 0; i < PAUSE_AFTER_FAILURES; i++) {
      await w.forge.batch([eventWrite(w.forge, { subject: PAPER, at: T0 + i, nonce: `failure-${i}`, kind: "research_comment", thread: "research:1", title: "t", url: "/research/1" }).stmt]);
      queueHooks(at(T0 + 1 + i), [{ subject: PAPER, at: T0 + i, nonce: `failure-${i}` }]);
      await settle();
      assert.equal(forgeRows(w.forge, "hooks")[0].active, i < PAUSE_AFTER_FAILURES - 1 ? 1 : 0, `after ${i + 1} failures`);
    }
    assert.equal(forgeRows(w.forge, "hooks")[0].active, 0);
    rx.got.length = 0;
    await w.forge.batch([eventWrite(w.forge, { subject: PAPER, at: T0 + 50, nonce: "after-pause", kind: "research_comment", thread: "research:1", title: "t", url: "/research/1" }).stmt]);
    queueHooks(r, [{ subject: PAPER, at: T0 + 50, nonce: "after-pause" }]);
    await settle();
    assert.equal(rx.got.length, 0, "a paused hook receives nothing");
    rx.answer([200]);
    assert.equal((await body(await b.post("/api/forge/hooks/write", { op: "ping", id: made.hook.id }))).active, true);
  });
});

describe("its person's other acts", () => {
  test("recent deliveries; a redelivery; a new secret; pause and delete never refused by FORGE_OPEN", async () => {
    const b = await signIn(w);
    const made = await makeHook(b);
    rx.answer([500]);
    await w.forge.batch([eventWrite(w.forge, { subject: PAPER, at: T0, nonce: "redeliver-1", kind: "research_closed", thread: "research:1", title: "t", url: "/research/1" }).stmt]);
    const { queueHooks } = await import("../../worker/forge/service/hooks.ts");
    queueHooks({ db: w.forge, env: w.env, url: new URL(ORIGIN), t: T0, ctx: w.ctx, deps: w.deps } as never, [{ subject: PAPER, at: T0, nonce: "redeliver-1" }]);
    await settle();
    const list = await body(await b.fetch(`/api/forge/hooks/deliveries?id=${made.hook.id}`));
    assert.equal(list.deliveries.length, 2);
    const failed = list.deliveries.find((d: Json) => d.event === "research_closed");
    assert.equal(failed.ok, false);
    assert.equal(failed.redeliverable, true);
    rx.answer([200]);
    rx.got.length = 0;
    const again = await body(await b.post("/api/forge/hooks/write", { op: "redeliver", id: made.hook.id, guid: failed.guid }));
    assert.equal(again.sent.ok, true);
    assert.equal(JSON.parse(rx.got[0].body).event, "research_closed");
    assert.equal(forgeRows(w.forge, "hook_deliveries").filter((d) => d.redelivery === 1).length, 1);
    // A new secret: the next ping is signed with it.
    const rotated = await body(await b.post("/api/forge/hooks/write", { op: "rotate", id: made.hook.id }));
    assert.notEqual(rotated.secret, made.secret);
    rx.got.length = 0;
    await b.post("/api/forge/hooks/write", { op: "ping", id: made.hook.id });
    assert.equal(rx.got[0].headers["x-hub-signature-256"], sig(rotated.secret, rx.got[0].body));
    // The forge closes to everyone: pausing and deleting still work.
    w.env.FORGE_OWNER_GITHUB_ID = undefined;
    assert.equal((await b.post("/api/forge/hooks/write", { op: "ping", id: made.hook.id })).status, 403);
    assert.equal((await b.post("/api/forge/hooks/write", { op: "update", id: made.hook.id, active: false })).status, 200);
    assert.equal(forgeRows(w.forge, "hooks")[0].active, 0);
    assert.equal((await b.post("/api/forge/hooks/write", { op: "delete", id: made.hook.id })).status, 200);
    assert.equal(forgeRows(w.forge, "hooks").length, 0);
  });

  test("through the public API with a token: hooks:read and hooks:write", async () => {
    const b = await signIn(w);
    const token = (await body(await b.post("/api/forge/tokens/write", { op: "create", name: "ci", scopes: ["hooks:write"] }))).token;
    const call = (path: string, payload?: unknown) =>
      handleApi(
        new Request(`${ORIGIN}${path}`, { method: payload ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) }, body: payload ? JSON.stringify(payload) : undefined }),
        w.env,
        w.ctx,
        w.deps,
      ) as Promise<Response>;
    const made = await call("/api/forge/v1/hooks/write", { op: "create", subject: PAPER, url: RECEIVER });
    assert.equal(made.status, 201, JSON.stringify(await body(made)));
    assert.equal((await body(await call("/api/forge/v1/hooks"))).hooks.length, 1);
  });
});
