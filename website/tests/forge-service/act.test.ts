// One authorized action, end to end (worker/forge/service/start.ts, act.ts, flow.ts, identity.ts;
// the design's §10.2 and its security checklist §17), on the double's GitHub (MemoryBackend) with a
// fake action registered through deps.actions (authorize.ts): start → the person approving on
// GitHub → act.
//
// What each case checks: the answer (its status, its code, its words), the rows (the happy path
// writes exactly the action row and the spec's rows; every refusal writes none), the revocation
// (once, in waitUntil, on every path after the exchange; never before one), and the token (in no
// D1 text, no Set-Cookie, no answer, no console output).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN, SESSION_KEY } from "../account/browser.ts";
import { everyText } from "../account/d1.ts";
import { ACT_PATH, START_PATH, type StartInput } from "../../src/lib/forge.ts";
import { pkceChallenge } from "../../worker/account/crypto.ts";
import { GitBackendError } from "../../worker/forge/errors.ts";
import { ACT_BODY_BYTES, ACT_ROWS_RESERVED } from "../../worker/forge/service/act.ts";
import { ACTION_PAYLOAD_BYTES, FORGE_ROWS_PER_DAY, PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { callbackUrl, FORGE_COOKIE, openForgeFlow } from "../../worker/forge/service/flow.ts";
import { CLOSED_MESSAGE } from "../../worker/forge/service/gate.ts";
import type { ActionContext } from "../../worker/forge/service/types.ts";
import { act, actions, authorize, fakeAction, githubId, signIn, start, watchAuth } from "./authorize.ts";
import { forgeCounts, forgeRows, forgeText } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

const CREATE: StartInput = { kind: "create", repo: null, payload: { name: "eeg-study" }, back: "/repositories/" };

let w: ForgeWorld;
let spec: ReturnType<typeof fakeAction>;
beforeEach(() => {
  w = forgeWorld();
  spec = fakeAction();
  w.deps.actions = actions(spec);
});
afterEach(() => w.restore());

const noRows = () => Object.values(forgeCounts(w.forge)).every((n) => n === 0);
const userOf = (id: string): string =>
  (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(id) as { user_id: string }).user_id;
const settled = () => Promise.all(w.ctx.waited);

/** Everything printed on the console while `run` runs. */
async function printed<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const names = ["log", "info", "warn", "error", "debug"] as const;
  const real = names.map((n) => console[n]);
  for (const n of names) console[n] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { value: await run(), lines };
  } finally {
    names.forEach((n, i) => (console[n] = real[i]));
  }
}

describe("start", () => {
  test("signed in, from the site's page: GitHub's authorization address and the flow cookie; nothing written", async () => {
    const b = await signIn(w);
    w.forge.reset();
    const s = await start(b, CREATE);
    assert.equal(s.res.status, 200, JSON.stringify(s.body));
    const u = new URL(s.body.location);
    assert.equal(`${u.origin}${u.pathname}`, `${w.backend.web}/login/oauth/authorize`);
    assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/forge/authorized/`);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.match(u.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
    const set = s.res.headers.getSetCookie().find((c) => c.startsWith(`${FORGE_COOKIE}=`)) ?? "";
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) assert.ok(set.includes(attribute), attribute);
    // The cookie binds the state, the verifier (only its challenge went to GitHub), the action, its digest, the session.
    const flow = await openForgeFlow(SESSION_KEY, b.cookie(FORGE_COOKIE), T0);
    assert.ok(flow);
    assert.equal(flow.st, u.searchParams.get("state"));
    assert.equal(await pkceChallenge(flow.cv), u.searchParams.get("code_challenge"));
    assert.ok(!s.body.location.includes(flow.cv));
    assert.deepEqual(flow.act, { kind: "create", forge: "memory", repo: null, branch: null, expectedHead: null, digest: flow.act.digest });
    assert.match(flow.act.digest, /^[0-9a-f]{64}$/);
    assert.equal(flow.rt, "/repositories/");
    // Nothing written, no scan; the answer is personal and never cached.
    assert.equal(w.forge.totals.written, 0);
    assert.deepEqual(w.forge.scans, []);
    assert.equal(s.res.headers.get("Cache-Control"), "no-store");
    // The return page is a path of this site, or the default.
    const other = await start(b, { ...CREATE, back: "https://evil.test/" });
    assert.equal((await openForgeFlow(SESSION_KEY, b.cookie(FORGE_COOKIE), T0))?.rt, "/repositories/");
    assert.equal(other.res.status, 200);
  });

  test("the page asks to install the App first: its installation page, with the flow's state", async () => {
    const b = await signIn(w);
    const s = await start(b, { ...CREATE, install: true });
    assert.equal(s.res.status, 200);
    const u = new URL(s.body.location);
    assert.equal(u.pathname, `/apps/${w.backend.appSlug}/installations/new`);
    const flow = await openForgeFlow(SESSION_KEY, b.cookie(FORGE_COOKIE), T0);
    assert.equal(u.searchParams.get("state"), flow?.st);
    assert.equal(flow?.ins, true);
  });

  test("refused: signed out, another site, no CSRF token, a body too large or malformed, a kind not built", async () => {
    const b = await signIn(w);
    const anonymous = w.browser();
    const out = await anonymous.fetch(START_PATH, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(out.status, 401);
    assert.equal((await b.post(START_PATH, {}, { origin: "https://evil.test" })).status, 403);
    assert.equal((await b.post(START_PATH, {}, { csrf: null })).status, 403);
    const big = await b.post(START_PATH, { kind: "create", pad: "x".repeat(9000) });
    assert.equal(big.status, 413);
    const say = async (body: unknown) => {
      const res = await b.post(START_PATH, body);
      return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
    };
    const good = { kind: "create", repo: null, branch: null, expectedHead: null, digest: "a".repeat(64), back: "/new/" };
    for (const bad of [
      { ...good, kind: "drop" },
      { ...good, digest: "nope" },
      { ...good, digest: "A".repeat(64) },
      { ...good, branch: "a..b" },
      { ...good, expectedHead: "main" },
      { ...good, repo: { forge: "github", id: "1" } },
      { ...good, repo: "ada/eeg" },
      { ...good, install: "yes" },
    ]) {
      assert.deepEqual(await say(bad), { status: 400, code: "bad_request" }, JSON.stringify(bad));
    }
    // A kind the registry does not have yet.
    assert.deepEqual(await say({ ...good, kind: "topics" }), { status: 501, code: "not_built" });
    assert.equal(b.cookie(FORGE_COOKIE), null);
    assert.ok(noRows());
  });

  test("an action on a repository the registry does not know: 404 before GitHub; known, its row reaches perform", async () => {
    const rename = fakeAction({
      kind: "rename",
      needsRepo: true,
      async perform(ctx) {
        rename.seen.push(ctx);
        return { result: { id: ctx.repo?.repo_id }, writes: [] };
      },
      check: () => true,
    });
    w.deps.actions = actions(rename);
    const b = await signIn(w);
    const unknown = await start(b, { kind: "rename", repo: { forge: "memory", owner: ADA_LOGIN, name: "nope" }, payload: { name: "x" }, back: "/r/ada-fixture/nope/" });
    assert.equal(unknown.res.status, 404);
    assert.equal(unknown.body.error.code, "unknown_repository");
    const none = await start(b, { kind: "rename", repo: null, payload: { name: "x" }, back: "/" });
    assert.equal(none.res.status, 400);
    await seed.repo(w.forge, { forge: "memory", repoId: "77", ownerLogin: ADA_LOGIN, name: "eeg" });
    const done = await authorize(w, b, { kind: "rename", repo: { forge: "memory", owner: ADA_LOGIN, name: "eeg" }, branch: "main", payload: { name: "x" }, back: "/r/ada-fixture/eeg/" });
    assert.equal(done.act?.status, 200, JSON.stringify(done.actBody));
    const ctx = rename.seen[0] as ActionContext<unknown>;
    assert.equal(ctx.repo?.repo_id, "77");
    assert.deepEqual(ctx.target, { kind: "rename", repo: { forge: "memory", owner: ADA_LOGIN, name: "eeg" }, branch: "main", expectedHead: null });
    const [row] = forgeRows(w.forge, "actions");
    assert.equal(row.repo_id, "77");
    assert.equal(row.rows, 1);
  });

  test("checkTarget refuses a target before GitHub", async () => {
    w.deps.actions = actions(fakeAction({ checkTarget: (t) => (t.branch ? null : new (class extends Error {})() && null) }));
    const strict = fakeAction({ checkTarget: (t) => (t.branch === null ? null : ({ status: 400, code: "bad_target", message: "no branch here", extra: {} }) as never) });
    w.deps.actions = actions(strict);
    const b = await signIn(w);
    const s = await start(b, { ...CREATE, branch: "main" });
    assert.equal(s.res.status, 400);
    assert.equal(s.body.error.code, "bad_target");
  });
});

describe("act", () => {
  test("the happy path: the action as the person, exactly the action row and the spec's rows, the token revoked once", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    w.forge.reset();
    const run = await authorize(w, b, CREATE);
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const repo = [...w.backend.repos.values()].find((r) => r.name === "eeg-study");
    assert.ok(repo);
    assert.deepEqual(run.actBody, {
      result: { id: repo.id, owner: ADA_LOGIN, name: "eeg-study" },
      sentence: "Create the public repository eeg-study",
      outcome: "done",
      back: "/repositories/",
    });
    // perform ran as the person: a user session, Ada's GitHub account, the declared target.
    const ctx = spec.seen[0] as ActionContext<{ name: string }>;
    assert.equal(ctx.session.credential, "user");
    assert.deepEqual(ctx.github, { id: w.ada.user.id, login: ADA_LOGIN });
    assert.equal(ctx.user.id, userOf(w.ada.user.id));
    assert.deepEqual(ctx.parsed, { name: "eeg-study" });
    assert.equal(ctx.repo, null);
    // Exactly the action row and the spec's rows, in one batch, billed as D1 bills them.
    assert.deepEqual(forgeCounts(w.forge), { actions: 1, deliveries: 0, installations: 0, jobs: 0, release_papers: 0, repo_packages: 0, repo_papers: 0, repos: 1, research_comments: 0, research_issues: 0, traced_paths: 0 });
    const [row] = forgeRows(w.forge, "actions");
    assert.equal(row.kind, "create");
    assert.equal(row.user_id, userOf(w.ada.user.id));
    assert.equal(row.github_user, w.ada.user.id);
    assert.equal(row.forge, "memory");
    assert.equal(row.repo_id, repo.id);
    assert.equal(row.outcome, "done");
    assert.equal(row.rows, 3);
    assert.equal(w.forge.totals.written, 3);
    assert.deepEqual(w.forge.scans, []);
    // The flow is over: its cookie cleared.
    assert.ok(run.act?.headers.getSetCookie().some((c) => c.startsWith(`${FORGE_COOKIE}=;`) && c.includes("Max-Age=0")));
    assert.equal(b.cookie(FORGE_COOKIE), null);
    // Revoked once, in waitUntil.
    await settled();
    assert.equal(auth.issued.length, 1);
    assert.deepEqual(auth.revoked, auth.issued);
    assert.equal(w.ctx.waited.length, 1);
    assert.ok(!w.backend.tokens.has(auth.issued[0]));
  });

  test("the token appears in no D1 text, no Set-Cookie, no answer body and no console output, on success and on failure", async () => {
    const auth = watchAuth(w);
    const seen: string[] = [];
    const keep = async (run: Awaited<ReturnType<typeof authorize>>) => {
      for (const res of [run.start, run.act]) {
        if (!res) continue;
        seen.push(await res.clone().text(), ...res.headers.getSetCookie(), [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n"));
      }
    };
    const { lines } = await printed(async () => {
      const b = await signIn(w);
      await keep(await authorize(w, b, CREATE));
      // A refusal after the exchange (the check fails), a GitHub error, an identity conflict.
      w.deps.actions = actions(fakeAction({ check: () => false }));
      await keep(await authorize(w, b, { ...CREATE, payload: { name: "second" } }));
      w.deps.actions = actions(spec);
      w.backend.failNext("repos.create", "conflict");
      await keep(await authorize(w, b, { ...CREATE, payload: { name: "third" } }));
      w.deps.actions = actions(fakeAction({ perform: async (c) => Promise.reject(new Error(`boom with ${(c.session as unknown as { token?: string }).token ?? "no token"}`)) }));
      await keep(await authorize(w, b, { ...CREATE, payload: { name: "fourth" } }));
      await settled();
    });
    assert.equal(auth.issued.length, 4);
    assert.equal(auth.revoked.length, 4);
    const everywhere = [everyText(w.db), forgeText(w.forge), ...seen, ...lines].join("\n");
    for (const token of auth.issued) assert.ok(!everywhere.includes(token), token);
    assert.ok(lines.length > 0);
  });

  test("a payload that is not the one confirmed: 400 bad_digest, before GitHub, nothing written", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    const run = await authorize(w, b, CREATE, { editAct: (x) => ({ ...x, payload: JSON.stringify({ name: "other" }) }) });
    assert.equal(run.act?.status, 400);
    assert.equal(run.actBody?.error.code, "bad_digest");
    assert.ok(noRows());
    assert.equal(auth.issued.length, 0);
    assert.equal(w.ctx.waited.length, 0);
    // The flow is spent: the right payload afterwards finds no flow.
    const again = await act(b, { code: run.code, state: run.state, payload: run.payload });
    assert.equal(again.body.error.code, "bad_state");
    assert.ok(noRows());
  });

  test("a replayed code: GitHub refuses it (401), nothing written, no second token", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    let saved: string | null = null;
    const first = await authorize(w, b, CREATE, { between: () => void (saved = b.cookie(FORGE_COOKIE)) });
    assert.equal(first.act?.status, 200);
    const before = forgeCounts(w.forge);
    // Without its cookie (cleared by the first act): no flow.
    const bare = await act(b, { code: first.code, state: first.state, payload: first.payload });
    assert.equal(bare.res.status, 400);
    assert.equal(bare.body.error.code, "bad_state");
    // With the cookie put back: the code is spent on GitHub's side.
    b.jar.set(FORGE_COOKIE, saved as unknown as string);
    const replay = await act(b, { code: first.code, state: first.state, payload: first.payload });
    assert.equal(replay.res.status, 401);
    assert.equal(replay.body.error.code, "unauthorized");
    assert.deepEqual(forgeCounts(w.forge), before);
    await settled();
    assert.equal(auth.issued.length, 1);
    assert.equal(auth.revoked.length, 1);
  });

  test("a wrong state, a missing cookie, another session's cookie: 400 bad_state, before GitHub", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    const wrong = await authorize(w, b, CREATE, { editAct: (x) => ({ ...x, state: "Z".repeat(43) }) });
    assert.equal(wrong.act?.status, 400);
    assert.equal(wrong.actBody?.error.code, "bad_state");
    assert.match(wrong.actBody?.error.message, /nothing was done/);
    const missing = await authorize(w, b, CREATE, { between: () => void b.jar.delete(FORGE_COOKIE) });
    assert.equal(missing.actBody?.error.code, "bad_state");
    // Ada's other browser (another session of the same account) holding this browser's cookie.
    let saved = "";
    const other: ForgeBrowser = await signIn(w);
    const stolen = await authorize(w, b, CREATE, {
      between: () => {
        saved = b.cookie(FORGE_COOKIE) ?? "";
      },
      editAct: (x) => x,
    });
    assert.equal(stolen.act?.status, 200); // this browser's own completes; the copy below does not
    const s = await start(b, CREATE);
    const { code, state } = w.backend.authorize(s.body.location, ADA_LOGIN);
    other.jar.set(FORGE_COOKIE, b.cookie(FORGE_COOKIE) ?? saved);
    const copy = await act(other, { code, state, payload: s.payload });
    assert.equal(copy.res.status, 400);
    assert.equal(copy.body.error.code, "bad_state");
    // Only the one completed action wrote, and only its exchange happened.
    assert.equal(forgeCounts(w.forge).actions, 1);
    assert.equal(auth.issued.length, 1);
    // An expired flow (10 minutes).
    const late = await authorize(w, b, CREATE, { between: () => w.advance(601) });
    assert.equal(late.actBody?.error.code, "bad_state");
    assert.equal(forgeCounts(w.forge).actions, 1);
  });

  test("the GitHub account is another OSCR account's: 409 identity_conflict, revoked, nothing written", async () => {
    const auth = watchAuth(w);
    // Bob has his own account of the registry, linked to his GitHub account.
    await signIn(w, "bob-fixture");
    const b = await signIn(w, ADA_LOGIN);
    const run = await authorize(w, b, CREATE, { login: "bob-fixture" });
    assert.equal(run.act?.status, 409);
    assert.equal(run.actBody?.error.code, "identity_conflict");
    assert.match(run.actBody?.error.message, /bob-fixture/);
    assert.ok(noRows());
    await settled();
    assert.equal(auth.revoked.length, 1);
    assert.deepEqual(auth.revoked, auth.issued);
    assert.equal(spec.seen.length, 0);
  });

  test("a GitHub account linked to nobody: linked now to an account without one; refused (409) to an account with another", async () => {
    w.env.FORGE_OPEN = "true";
    const auth = watchAuth(w);
    // Ada authorizes as Dave, whom nobody linked: Ada already has her own GitHub identity.
    const ada = await signIn(w, ADA_LOGIN);
    githubId(w, "dave-fixture");
    const mismatch = await authorize(w, ada, CREATE, { login: "dave-fixture" });
    assert.equal(mismatch.act?.status, 409);
    assert.equal(mismatch.actBody?.error.code, "identity_mismatch");
    assert.ok(noRows());
    // Carol signed in with ORCID only: the GitHub account that authorizes is linked to her now.
    const carol = w.browser();
    await carol.signIn("orcid");
    const eve = githubId(w, "eve-fixture");
    const linked = await authorize(w, carol, CREATE, { login: "eve-fixture" });
    assert.equal(linked.act?.status, 200, JSON.stringify(linked.actBody));
    const me = await carol.me();
    assert.ok(me.identities.some((i: { provider: string; handle: string }) => i.provider === "github" && i.handle === "eve-fixture"));
    const [row] = forgeRows(w.forge, "actions");
    assert.equal(row.github_user, eve);
    assert.equal(row.user_id, userOf(eve));
    await settled();
    assert.equal(auth.revoked.length, 2);
  });

  test("spec.check says GitHub's answer is not what was authorized: 502 mismatch, nothing recorded, revoked", async () => {
    const auth = watchAuth(w);
    w.deps.actions = actions(fakeAction({ check: () => false }));
    const b = await signIn(w);
    const run = await authorize(w, b, CREATE);
    assert.equal(run.act?.status, 502);
    assert.equal(run.actBody?.error.code, "mismatch");
    assert.match(run.actBody?.error.message, /recorded nothing/);
    assert.ok(noRows());
    await settled();
    assert.equal(auth.revoked.length, 1);
  });

  test("the branch moved (GitHub's conflict): 409 with offer new_branch, revoked, nothing written", async () => {
    const auth = watchAuth(w);
    w.backend.failNext("repos.create", "conflict");
    const b = await signIn(w);
    const run = await authorize(w, b, CREATE);
    assert.equal(run.act?.status, 409);
    assert.equal(run.actBody?.error.code, "conflict");
    assert.equal(run.actBody?.error.offer, "new_branch");
    assert.ok(noRows());
    await settled();
    assert.equal(auth.revoked.length, 1);
    assert.ok(run.act?.headers.getSetCookie().some((c) => c.startsWith(`${FORGE_COOKIE}=;`)));
  });

  test("FORGE_OPEN: closed to a non-owner at start and at act (403 forge_closed); the owner acts", async () => {
    const auth = watchAuth(w);
    const bob = await signIn(w, "bob-fixture");
    const closed = await start(bob, CREATE);
    assert.equal(closed.res.status, 403);
    assert.deepEqual(closed.body.error, { code: "forge_closed", message: CLOSED_MESSAGE });
    assert.equal(bob.cookie(FORGE_COOKIE), null);
    // Opened at start, closed again before act: refused at act, after the exchange (revoked).
    w.env.FORGE_OPEN = "true";
    const run = await authorize(w, bob, CREATE, { login: "bob-fixture", between: () => void delete w.env.FORGE_OPEN });
    assert.equal(run.start.status, 200);
    assert.equal(run.act?.status, 403);
    assert.equal(run.actBody?.error.code, "forge_closed");
    assert.ok(noRows());
    await settled();
    assert.equal(auth.revoked.length, 1);
    // The owner, with FORGE_OPEN unset.
    const ada = await signIn(w, ADA_LOGIN);
    assert.equal((await authorize(w, ada, CREATE)).act?.status, 200);
    // Without FORGE_OWNER_GITHUB_ID, nobody.
    delete w.env.FORGE_OWNER_GITHUB_ID;
    assert.equal((await start(ada, CREATE)).res.status, 403);
  });

  test("the daily caps: 429 with the cap in words, at start and at act; nothing written", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    const user = userOf(w.ada.user.id);
    for (let i = 0; i < PER_ACCOUNT_DAY.creations; i++) await seed.action(w.forge, { userId: user, kind: "create", t: T0 - 3600 - i });
    const before = forgeCounts(w.forge);
    const s = await start(b, CREATE);
    assert.equal(s.res.status, 429);
    assert.equal(s.body.error.code, "too_many");
    assert.match(s.body.error.message, /10 repositories created in the last 24 hours/);
    assert.equal(s.body.error.cap, "creations");
    // At act: under the cap at start, over it by act (another tab's actions).
    const other = fakeAction({ kind: "edit" });
    w.deps.actions = actions(other);
    for (let i = 0; i < PER_ACCOUNT_DAY.actions - PER_ACCOUNT_DAY.creations - 1; i++) await seed.action(w.forge, { userId: user, kind: "topics", t: T0 - 60 - i });
    const run = await authorize(w, b, { ...CREATE, kind: "edit" }, {
      between: () => seed.action(w.forge, { userId: user, kind: "topics", t: T0 - 1 }),
    });
    assert.equal(run.start.status, 200);
    assert.equal(run.act?.status, 429);
    assert.match(run.actBody?.error.message, /100 authorized actions in the last 24 hours/);
    assert.equal(forgeCounts(w.forge).actions, before.actions + PER_ACCOUNT_DAY.actions - PER_ACCOUNT_DAY.creations);
    assert.equal(forgeCounts(w.forge).repos, 0);
    await settled();
    assert.equal(auth.revoked.length, 1);
  });

  test("the global cap: 503 quota before GitHub is asked to act", async () => {
    const b = await signIn(w);
    const room = FORGE_ROWS_PER_DAY - ACT_ROWS_RESERVED + 1;
    for (let left = room, i = 0; left > 0; i++) {
      const rows = Math.min(1000, left);
      await seed.action(w.forge, { userId: `u_other${i}`, kind: "edit", t: T0 - i, rows });
      left -= rows;
    }
    const run = await authorize(w, b, CREATE);
    assert.equal(run.act?.status, 503);
    assert.equal(run.actBody?.error.code, "quota");
    assert.ok(Number(run.act?.headers.get("Retry-After")) > 0);
    assert.equal(spec.seen.length, 0);
    assert.equal(forgeCounts(w.forge).repos, 0);
  });

  test("a payload over 1 MiB: 413, before GitHub; a body over the read cap: 413 without reading it", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    const run = await authorize(w, b, { ...CREATE, payload: { name: "eeg", pad: "x".repeat(ACTION_PAYLOAD_BYTES) } });
    assert.equal(run.start.status, 200);
    assert.equal(run.act?.status, 413);
    assert.equal(run.actBody?.error.code, "too_large");
    assert.match(run.actBody?.error.message, /1 MiB/);
    // Exactly 1 MiB of payload passes the size check (and fails only on its content).
    const pad = "x".repeat(ACTION_PAYLOAD_BYTES - JSON.stringify({ name: "eeg", pad: "" }).length);
    const edge = await authorize(w, b, { ...CREATE, payload: { name: "eeg", pad } });
    assert.equal(edge.act?.status, 200, JSON.stringify(edge.actBody).slice(0, 200));
    const count = forgeCounts(w.forge);
    // A body larger than the read cap.
    await start(b, CREATE);
    const csrf = (await b.me()).csrf as string;
    const huge = await b.fetch(ACT_PATH, {
      method: "POST",
      headers: { Origin: ORIGIN, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "c", state: "s", payload: "y".repeat(ACT_BODY_BYTES) }),
    });
    assert.equal(huge.status, 413);
    assert.deepEqual(forgeCounts(w.forge), count);
    assert.equal(auth.issued.length, 1);
  });

  test("refused before GitHub: signed out, another site, no CSRF token, not JSON, a malformed body, a payload the spec refuses", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    const anonymous = w.browser();
    assert.equal((await anonymous.fetch(ACT_PATH, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal((await b.post(ACT_PATH, {}, { origin: "https://evil.test" })).status, 403);
    assert.equal((await b.post(ACT_PATH, {}, { csrf: null })).status, 403);
    const text = await b.post(ACT_PATH, undefined, { headers: { "Content-Type": "text/plain" } });
    assert.equal(text.status, 400);
    for (const bad of [{}, { code: "c", state: "s" }, { code: "c", state: "s", payload: { name: "x" } }, { code: "", state: "s", payload: "{}" }, []]) {
      const res = await b.post(ACT_PATH, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    // The spec's validate, on the payload whose digest was confirmed.
    const run = await authorize(w, b, { ...CREATE, payload: { name: "../bad" } });
    assert.equal(run.act?.status, 400);
    assert.equal(run.actBody?.error.code, "bad_payload");
    // Not JSON at all, with its own digest.
    const s = await start(b, CREATE);
    assert.equal(s.res.status, 200);
    assert.ok(noRows());
    assert.equal(auth.issued.length, 0);
    assert.equal(w.ctx.waited.length, 0);
  });

  test("a failure after the exchange (GitHub unreachable at whoAmI, perform throwing): revoked once each, in words", async () => {
    const auth = watchAuth(w);
    const b = await signIn(w);
    const who = w.backend.auth.whoAmI;
    w.backend.auth.whoAmI = async () => {
      throw new GitBackendError("unavailable", "GitHub timed out");
    };
    const down = await authorize(w, b, CREATE);
    w.backend.auth.whoAmI = who;
    assert.equal(down.act?.status, 503);
    assert.equal(down.actBody?.error.code, "unavailable");
    w.deps.actions = actions(fakeAction({ perform: () => Promise.reject(new Error("a bug")) }));
    const { value: bug } = await printed(() => authorize(w, b, CREATE));
    assert.equal(bug.act?.status, 503);
    assert.equal(bug.actBody?.error.code, "unavailable");
    assert.ok(noRows());
    await settled();
    assert.equal(auth.issued.length, 2);
    assert.deepEqual(auth.revoked, auth.issued);
    assert.equal(w.ctx.waited.length, 2);
  });

  test("the installation's return carries a code: the same act completes the action", async () => {
    const b = await signIn(w);
    const s = await start(b, { ...CREATE, install: true });
    const flow = await openForgeFlow(SESSION_KEY, b.cookie(FORGE_COOKIE), T0);
    assert.ok(flow);
    // GitHub installs the App, then asks the person's authorization (the App's setting), and comes back.
    const url = w.backend.auth.authorizeUrl({ state: flow.st, codeChallenge: await pkceChallenge(flow.cv), redirectUri: callbackUrl(ORIGIN) });
    const { code, state } = w.backend.authorize(url, ADA_LOGIN);
    assert.equal(state, new URL(s.body.location).searchParams.get("state"));
    const done = await act(b, { code, state, payload: s.payload });
    assert.equal(done.res.status, 200, JSON.stringify(done.body));
    assert.equal(forgeCounts(w.forge).actions, 1);
  });
});

// ─── the browser's side: forge-client.ts and the callback page (forge-authorized.ts) ──────────────

/** A tab's sessionStorage. */
function tabStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

/** The page's `fetch`, through the test browser (which adds the site's Origin to a POST, as a
 *  browser does), every request kept. */
function pageFetch(b: ForgeBrowser, log: { path: string; body: string }[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if ((init.method ?? "GET") === "POST") headers.Origin = ORIGIN;
    log.push({ path, body: typeof init.body === "string" ? init.body : "" });
    return b.fetch(path, { method: init.method, headers, body: typeof init.body === "string" ? init.body : undefined });
  }) as typeof fetch;
}

describe("the browser's side", () => {
  const SENTENCE = "Create the public repository eeg-study in your GitHub account";

  test("confirm, start, GitHub, the callback page: the action done, said in words, the address's code never reused", async () => {
    const { startAction, PENDING_KEY } = await import("../../src/scripts/forge-client.ts");
    const { arrive } = await import("../../src/scripts/forge-authorized.ts");
    const b = await signIn(w);
    w.forge.reset();
    const storage = tabStorage();
    const log: { path: string; body: string }[] = [];
    const assigned: string[] = [];
    const deps = { fetch: pageFetch(b, log), storage, assign: (u: string) => void assigned.push(u), now: () => T0 };
    const started = await startAction(CREATE, SENTENCE, deps);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.deepEqual(assigned, [started.ok ? started.location : ""]);
    // The payload stays in the tab: start got its SHA-256 only, with the CSRF token of /api/account/me.
    const startCall = log.find((l) => l.path === START_PATH);
    assert.ok(startCall);
    assert.ok(!startCall.body.includes("eeg-study"));
    const kept = JSON.parse(storage.map.get(PENDING_KEY) ?? "{}");
    assert.equal(kept.payload, JSON.stringify({ name: "eeg-study" }));
    assert.equal(kept.sentence, SENTENCE);
    assert.equal(JSON.parse(startCall.body).digest, kept.digest);
    // GitHub, then the callback page.
    const { code, state } = w.backend.authorize(assigned[0], ADA_LOGIN);
    const said = await arrive(`?code=${code}&state=${state}`, deps);
    assert.deepEqual(said, [
      { tone: "ok", text: ["Done, as you, on GitHub: Create the public repository eeg-study."], links: [{ href: "/repositories/", text: "Back to the page you came from" }] },
    ]);
    assert.equal(log.filter((l) => l.path === ACT_PATH).length, 1);
    assert.equal(forgeCounts(w.forge).actions, 1);
    assert.equal(forgeCounts(w.forge).repos, 1);
    // The kept action is gone: the same address again does nothing and says so.
    assert.equal(storage.map.size, 0);
    const again = await arrive(`?code=${code}&state=${state}`, deps);
    assert.equal(again[0].tone, "warning");
    assert.match(again[0].text[0], /holds no action waiting/);
    assert.equal(log.filter((l) => l.path === ACT_PATH).length, 1);
    assert.equal(forgeCounts(w.forge).actions, 1);
  });

  test("back from installing the App with an action waiting: the action authorized again the ordinary way, then done", async () => {
    const { startAction, PENDING_KEY } = await import("../../src/scripts/forge-client.ts");
    const { arrive } = await import("../../src/scripts/forge-authorized.ts");
    const b = await signIn(w);
    w.forge.reset();
    const storage = tabStorage();
    const log: { path: string; body: string }[] = [];
    const assigned: string[] = [];
    const deps = { fetch: pageFetch(b, log), storage, assign: (u: string) => void assigned.push(u), now: () => T0 };
    const started = await startAction({ ...CREATE, install: true }, SENTENCE, deps);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.match(assigned[0], /\/installations\/new\?state=/);
    // The declaration is kept with the payload, without the installation.
    const kept = JSON.parse(storage.map.get(PENDING_KEY) ?? "{}");
    assert.equal(kept.start.digest, kept.digest);
    assert.equal(kept.start.install, undefined);
    // GitHub installed the App and came back, with a code of its own: that code is not used; the
    // same action is declared again, and the tab goes to GitHub's authorization page (PKCE).
    const back = await arrive("?code=from-installation&state=whatever&installation_id=4242&setup_action=install", deps);
    assert.equal(back.length, 2);
    assert.equal(back[0].tone, "ok");
    assert.match(back[1].text[0], /Carrying on with the action you confirmed/);
    assert.equal(log.filter((l) => l.path === ACT_PATH).length, 0);
    assert.equal(log.filter((l) => l.path === START_PATH).length, 2);
    const again = JSON.parse(log.filter((l) => l.path === START_PATH)[1].body);
    assert.equal(again.install, undefined);
    assert.equal(again.digest, kept.digest);
    assert.equal(assigned.length, 2);
    assert.match(assigned[1], /code_challenge=/);
    // GitHub authorizes at once; the callback page carries the action out.
    const { code, state } = w.backend.authorize(assigned[1], ADA_LOGIN);
    const said = await arrive(`?code=${code}&state=${state}`, deps);
    assert.equal(said[0].tone, "ok", JSON.stringify(said));
    assert.equal(forgeCounts(w.forge).actions, 1);
    assert.equal(forgeCounts(w.forge).repos, 1);
    // An installation return whose kept action predates the declaration (no `start`): its code is
    // posted as before (act checks it), never a second declaration.
    storage.setItem(PENDING_KEY, JSON.stringify({ kind: "create", payload: "{}", digest: "a".repeat(64), sentence: "s", back: "/new/", at: T0 }));
    const plain = await arrive("?code=abc&state=def&installation_id=4242&setup_action=install", deps);
    assert.equal(plain[1].tone, "warning");
    assert.equal(log.filter((l) => l.path === START_PATH).length, 2);
  });

  test("the callback page's refusals and returns: no action kept, expired, denied, an installation, a conflict", async () => {
    const { outcomeOf, readReturn, takePending, PENDING_KEY } = await import("../../src/scripts/forge-client.ts");
    const { arrive } = await import("../../src/scripts/forge-authorized.ts");
    const log: { path: string; body: string }[] = [];
    const b = await signIn(w);
    const deps = { fetch: pageFetch(b, log), storage: tabStorage(), now: () => T0 };
    // Opened directly: nothing is waiting.
    assert.match((await arrive("", deps))[0].text[0], /Nothing is waiting here/);
    // A pending action older than ten minutes: expired, never posted.
    const old = { kind: "create", payload: "{}", digest: "a".repeat(64), sentence: "x", back: "/new/", at: T0 - 601 };
    deps.storage.setItem(PENDING_KEY, JSON.stringify(old));
    assert.match((await arrive("?code=abc&state=def", deps))[0].text[0], /more than ten minutes/);
    // The person said no on GitHub.
    deps.storage.setItem(PENDING_KEY, JSON.stringify({ ...old, at: T0 }));
    const denied = await arrive("?error=access_denied&error_description=The+user+denied", deps);
    assert.deepEqual(denied[0].text, ["You did not authorize the action on GitHub: nothing was done."]);
    assert.equal(denied[0].links[0].href, "/new/");
    assert.equal(deps.storage.map.size, 0);
    // An installation without an action: the link page, the installation preselected.
    const installed = await arrive("?installation_id=4242&setup_action=install", deps);
    assert.equal(installed[0].tone, "ok");
    assert.deepEqual(installed[0].links, [{ href: "/new/link/?installation=4242", text: "Link one of its repositories to your paper" }]);
    // With the code GitHub adds when it asks the user's authorization, but no action kept.
    const withCode = await arrive("?code=abc&state=def&installation_id=4242&setup_action=install", deps);
    assert.equal(withCode.length, 2);
    assert.match(withCode[1].text[0], /No other action was waiting/);
    // Requested from an organization's owners.
    assert.match((await arrive("?setup_action=request", deps))[0].text[0], /requested from the organization's owners/);
    assert.equal(log.filter((l) => l.path === ACT_PATH).length, 0);
    // Malformed values are ignored, never echoed.
    assert.deepEqual(readReturn("?code=<b>&state=a%20b&installation_id=12x&setup_action=delete&error=Bad!"), {
      code: null,
      state: null,
      installationId: null,
      setupAction: null,
      error: null,
    });
    assert.equal(takePending(null, T0), "none");
    // The branch moved: the offer of a new branch, in words; GitHub's own page only on github.com.
    const pending = { kind: "rename", payload: "{}", digest: "a".repeat(64), sentence: "s", back: "/r/ada/eeg/settings/", at: T0 };
    const conflict = outcomeOf(
      { status: 409, body: { error: { code: "conflict", message: "The branch moved.", offer: "new_branch", fallbackUrl: "https://evil.test/x" } } },
      pending,
    );
    assert.equal(conflict.tone, "warning");
    assert.match(conflict.text[1], /new branch/);
    assert.deepEqual(conflict.links, [{ href: "/r/ada/eeg/settings/", text: "Back to the page you came from" }]);
    const fallback = outcomeOf({ status: 422, body: { error: { code: "too_large", message: "Too large.", fallbackUrl: "https://github.com/ada/eeg/upload" } } }, pending);
    assert.equal(fallback.links[1].href, "https://github.com/ada/eeg/upload");
    // A return page from the answer or the kept action is a path of this site, or the default.
    assert.equal(outcomeOf({ status: 200, body: { back: "https://evil.test/", sentence: "Done" } }, pending).links[0].href, "/repositories/");
    assert.equal(outcomeOf(null, pending).tone, "warning");
  });

  test("start's refusals in the page: no storage, signed out, closed; nothing kept, the tab stays", async () => {
    const { startAction, safeLocation, PENDING_KEY } = await import("../../src/scripts/forge-client.ts");
    const assigned: string[] = [];
    const assign = (u: string) => void assigned.push(u);
    const log: { path: string; body: string }[] = [];
    // No storage: refused before any request.
    const b = await signIn(w);
    const none = await startAction(CREATE, "s", { fetch: pageFetch(b, log), storage: null, assign });
    assert.deepEqual([none.ok, none.ok ? "" : none.code, log.length], [false, "no_storage", 0]);
    // Signed out: the sentence asks to sign in, nothing started.
    const anonymous = w.browser();
    const storage = tabStorage();
    const out = await startAction(CREATE, "s", { fetch: pageFetch(anonymous, log), storage, assign });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.signIn, true);
    assert.equal(log.some((l) => l.path === START_PATH), false);
    // Closed (a non-owner while FORGE_OPEN is unset): the Worker's sentence; nothing kept.
    const bob = await signIn(w, "bob-fixture");
    const closed = await startAction(CREATE, "s", { fetch: pageFetch(bob, log), storage, assign });
    assert.deepEqual(closed.ok ? null : [closed.code, closed.message], ["forge_closed", CLOSED_MESSAGE]);
    assert.equal(storage.map.has(PENDING_KEY), false);
    // Too large for act: refused in the page.
    const big = await startAction({ ...CREATE, payload: { name: "x".repeat(ACTION_PAYLOAD_BYTES) } }, "s", { fetch: pageFetch(b, log), storage, assign });
    assert.equal(big.ok ? "" : big.code, "too_large");
    assert.deepEqual(assigned, []);
    // Only an http(s) address is followed.
    assert.equal(safeLocation("javascript:alert(1)"), null);
    assert.equal(safeLocation("data:text/html,x"), null);
    assert.equal(safeLocation("https://github.com/login/oauth/authorize?x=1"), "https://github.com/login/oauth/authorize?x=1");
  });

  test("the callback page: its script is a file of the site (no inline code), it removes the code at once", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../../src/pages/forge/authorized.astro", import.meta.url), "utf8");
    const scripts = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0][1], "");
    assert.match(scripts[0][2], /^\s*import "\.\.\/\.\.\/scripts\/forge-authorized";\s*$/);
    assert.ok(!/\son[a-z]+=/i.test(page));
    assert.ok(page.includes('id="forge-outcome"'));
    const script = readFileSync(new URL("../../src/scripts/forge-authorized.ts", import.meta.url), "utf8");
    const main = script.slice(script.indexOf("async function main"));
    // replaceState comes before the first await of the page.
    assert.ok(main.indexOf("history.replaceState") < main.indexOf("await"));
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(script + readFileSync(new URL("../../src/scripts/forge-client.ts", import.meta.url), "utf8")));
  });
});
