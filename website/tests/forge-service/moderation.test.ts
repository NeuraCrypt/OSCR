// Content rules (night phase 16, E1; moderation-core.ts, moderation.ts, hidden.ts, turnstile.ts):
// reports with or without an account behind Turnstile, the owner's queue and decisions, what the reads
// drop once something is hidden, a suspended account's writes refused (its tokens revoked, its hooks
// paused), appeals and restoration. 3 rows a report; no email address stored; no scan.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { hiddenEventFilter } from "../../worker/forge/service/hidden.ts";
import {
  cleanText,
  keyOf,
  readTarget,
  validateAppeal,
  validateDecision,
  validateReport,
} from "../../worker/forge/service/moderation-core.ts";
import { checkTurnstile, SITEVERIFY, TEST_SECRET_FAIL, TEST_SECRET_PASS, verifyUrl } from "../../worker/forge/service/turnstile.ts";
import { isProblem, type ForgeServiceEnv } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows, forgeText } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

/** Cloudflare's siteverify as its test secrets make it answer: 1x…AA passes, 2x…AA fails. */
export const standIn: typeof fetch = async (_url, init) => {
  const form = new URLSearchParams(String(init?.body ?? ""));
  const pass = form.get("secret") === TEST_SECRET_PASS && !!form.get("response");
  return new Response(JSON.stringify({ success: pass, "error-codes": pass ? [] : ["invalid-input-response"] }), { headers: { "Content-Type": "application/json" } });
};

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true", TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }, deps: { turnstileFetch: standIn } });
});
afterEach(() => w.restore());

const PAPER = "doi:10.1234/eeg.2026";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

async function userIdOf(login: string): Promise<string> {
  const account = [...w.backend.accounts.values()].find((a) => a.login === login)!;
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(String(account.id)) as { user_id: string }).user_id;
}

/** Ada (the owner) and Bob, both signed in; Bob opens a research issue and comments on it. */
async function scene(): Promise<{ ada: ForgeBrowser; bob: ForgeBrowser; issue: number; bobId: string; bobGithub: string }> {
  const ada = await signIn(w, ADA_LOGIN);
  const bob = await signIn(w, "bob-fixture");
  const res = await bob.post("/api/forge/research/open", {
    paper: "10.1234/eeg.2026",
    code: "https://zenodo.org/records/123",
    type: "code_error",
    title: "The script crashes",
    body: "It stops at line 3.",
  });
  assert.equal(res.status, 201, JSON.stringify(await body(res)));
  const issue = (await body(res)).id as number;
  assert.equal((await bob.post("/api/forge/research/comment", { id: issue, body: "Still crashing, write to bob@example.org" })).status, 200);
  const bobGithub = String([...w.backend.accounts.values()].find((a) => a.login === "bob-fixture")!.id);
  return { ada, bob, issue, bobId: await userIdOf("bob-fixture"), bobGithub };
}

describe("the pure parts", () => {
  test("targets: people, repositories, research issues and comments, GitHub's issues, pulls, releases, lists, statuses, snippets", () => {
    assert.deepEqual(readTarget("person:github:12"), { kind: "person", target: "person:github:12" });
    assert.deepEqual(readTarget("person:orcid:0000-0002-1825-0097"), { kind: "person", target: "person:orcid:0000-0002-1825-0097" });
    assert.equal(readTarget("person:orcid:0000-0002-1825-0098"), null, "the check digit");
    assert.deepEqual(readTarget("research:3#2"), { kind: "comment", target: "research:3#2" });
    assert.deepEqual(keyOf(readTarget("research:3#2")!), { kind: "comment", key: "3#2" });
    assert.deepEqual(keyOf(readTarget("pull:github:5#7")!), { kind: "pull", key: "github:5#7" });
    assert.deepEqual(keyOf(readTarget("release:github:5/v1.0/rc")!), { kind: "release", key: "github:5/v1.0/rc" });
    assert.deepEqual(keyOf(readTarget(`status:github:5:${"a".repeat(40)}:ci/tests`)!), { kind: "status", key: `github:5:${"a".repeat(40)}:ci/tests` });
    assert.equal(readTarget("list:github:12/3")?.kind, "list");
    assert.equal(readTarget("snippet:9")?.kind, "snippet");
    for (const bad of ["repo:gitlab:1", "research:0", "release:github:5/a@b", "person:12", "status:github:5:xyz:ci", "", 7, "x".repeat(401)]) assert.equal(readTarget(bad), null, String(bad));
  });

  test("texts: addresses masked, at signs made harmless, control characters dropped, cut", () => {
    assert.equal(cleanText("Mail ada@example.org or @bob\u0007!", 100), "Mail [email hidden] or ＠bob!");
    assert.equal(cleanText("x".repeat(50), 10), "x".repeat(10));
  });

  test("payloads: a report's reason and words; a decision; an appeal and a counter-notice's statements", () => {
    assert.ok(isProblem(validateReport({ target: "research:1", reason: "nope" })));
    assert.ok(isProblem(validateReport({ target: "research:1", reason: "other", details: "bad" })));
    assert.ok(isProblem(validateReport({ target: "research:1", reason: "copyright", details: "mine" })));
    const ok = validateReport({ target: "research:1", reason: "abuse", details: "Threats, see ada@example.org", turnstile: TOKEN });
    assert.ok(!isProblem(ok) && ok.details === "Threats, see [email hidden]" && ok.turnstile === TOKEN);
    assert.ok(isProblem(validateDecision({ op: "hide", target: "research:1" })), "a reason");
    assert.ok(isProblem(validateDecision({ op: "dismiss" })), "a report");
    assert.ok(isProblem(validateDecision({ op: "hide", target: "snippet:1", reason: "spam" })));
    const person = validateDecision({ op: "hide", target: "person:github:12", reason: "spam", scope: "profile" });
    assert.ok(!isProblem(person) && person.scope === "profile");
    assert.ok(isProblem(validateAppeal({ target: "research:1", text: "short" })));
    assert.ok(isProblem(validateAppeal({ target: "research:1", kind: "counter_notice", text: "This is my own work, published under CC BY.", goodFaith: true })));
    assert.ok(!isProblem(validateAppeal({ target: "research:1", kind: "counter_notice", text: "This is my own work, published under CC BY.", goodFaith: true, accurate: true })));
  });

  test("Turnstile: Cloudflare's test secrets through the stand-in; refused when not set up; never Cloudflare from a test", async () => {
    const env = (secret?: string): ForgeServiceEnv => ({ TURNSTILE_SECRET_KEY: secret }) as ForgeServiceEnv;
    assert.equal(await checkTurnstile(env(TEST_SECRET_PASS), TOKEN, standIn), null);
    assert.equal((await checkTurnstile(env(TEST_SECRET_FAIL), TOKEN, standIn))?.code, "human_check");
    assert.equal((await checkTurnstile(env(TEST_SECRET_PASS), "", standIn))?.code, "human_check");
    assert.equal((await checkTurnstile(env(undefined), TOKEN, standIn))?.status, 503);
    assert.equal((await checkTurnstile(env(TEST_SECRET_PASS), TOKEN, async () => { throw new Error("down"); }))?.code, "human_check_unavailable");
    assert.equal(verifyUrl({} as ForgeServiceEnv), SITEVERIFY);
    assert.equal(verifyUrl({ TURNSTILE_VERIFY_URL: "http://127.0.0.1:9491/siteverify" } as ForgeServiceEnv), "http://127.0.0.1:9491/siteverify");
    assert.equal(verifyUrl({ TURNSTILE_VERIFY_URL: "https://evil.example/siteverify" } as ForgeServiceEnv), SITEVERIFY, "a stand-in on this machine only");
  });
});

describe("reports", () => {
  test("without an account: the site's Origin and Turnstile, 3 rows, no reporter kept; the day's cap", async () => {
    const { issue } = await scene();
    const anon = w.browser();
    const before = w.forge.totals.written;
    const res = await anon.post("/api/forge/report", { target: `research:${issue}#1`, reason: "private_information", details: "It names a patient; mail x@y.org", turnstile: TOKEN }, { csrf: null });
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    const rows = forgeRows(w.forge, "content_reports");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reporter, "");
    assert.equal(rows[0].details, "It names a patient; mail [email hidden]");
    assert.equal(rows[0].state, "open");
    assert.equal(w.forge.totals.written - before, 3, "the report, its open entry, the action row");
    // Another site, no Turnstile, the always-fail key: refused, nothing written.
    assert.equal((await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN }, { csrf: null, origin: "https://evil.example" })).status, 403);
    assert.equal((await body(await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: "" }, { csrf: null }))).error.code, "human_check");
    w.env.TURNSTILE_SECRET_KEY = TEST_SECRET_FAIL;
    assert.equal((await body(await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN }, { csrf: null }))).error.code, "human_check");
    delete w.env.TURNSTILE_SECRET_KEY;
    assert.equal((await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN }, { csrf: null })).status, 503);
    w.env.TURNSTILE_SECRET_KEY = TEST_SECRET_PASS;
    assert.equal(forgeRows(w.forge, "content_reports").length, 1);
    // Something the registry does not have: 404; a snippet: not built.
    assert.equal((await anon.post("/api/forge/report", { target: "research:999", reason: "spam", turnstile: TOKEN }, { csrf: null })).status, 404);
    assert.equal((await anon.post("/api/forge/report", { target: "snippet:1", reason: "spam", turnstile: TOKEN }, { csrf: null })).status, 501);
    // The day's reports without an account: 50 in all.
    for (let i = 0; i < 49; i++) await seed.action(w.forge, { userId: "", kind: "report", t: T0 - i });
    const over = await anon.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN }, { csrf: null });
    assert.equal(over.status, 429);
    assert.doesNotMatch(forgeText(w.forge), /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "no email address stored");
  });

  test("signed in: the CSRF token, once per thing while open, 20 a day", async () => {
    const { ada, issue } = await scene();
    assert.equal((await ada.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN }, { csrf: "wrong" })).status, 403);
    assert.equal((await ada.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN })).status, 201);
    assert.equal((await body(await ada.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN }))).error.code, "already_reported");
    assert.notEqual(forgeRows(w.forge, "content_reports")[0].reporter, "");
    const adaId = await userIdOf(ADA_LOGIN);
    for (let i = 0; i < 19; i++) await seed.action(w.forge, { userId: adaId, kind: "report", t: T0 - 10 - i });
    assert.equal((await ada.post("/api/forge/report", { target: `research:${issue}#1`, reason: "spam", turnstile: TOKEN })).status, 429);
  });
});

describe("the owner's queue and decisions", () => {
  test("the queue is the owner's; it never names a reporter", async () => {
    const { ada, bob, issue } = await scene();
    await w.browser().post("/api/forge/report", { target: `research:${issue}#1`, reason: "abuse", turnstile: TOKEN }, { csrf: null });
    await ada.post("/api/forge/report", { target: `research:${issue}`, reason: "spam", turnstile: TOKEN });
    assert.equal((await bob.fetch("/api/forge/moderation")).status, 403);
    assert.equal((await bob.post("/api/forge/moderation/decide", { op: "dismiss", report: 1 })).status, 403);
    w.forge.reset();
    const q = await body(await ada.fetch("/api/forge/moderation"));
    assert.equal(q.reports.length, 2);
    assert.deepEqual(q.reports.map((x: Json) => x.signedIn).sort(), [false, true]);
    assert.doesNotMatch(JSON.stringify(q), /u_[A-Za-z0-9_-]{10,}/, "no account id");
    assert.deepEqual(w.forge.scans, []);
    // Dismissed: out of the queue.
    assert.equal((await ada.post("/api/forge/moderation/decide", { op: "dismiss", report: q.reports[0].id })).status, 200);
    assert.equal((await body(await ada.fetch("/api/forge/moderation"))).reports.length, 1);
  });

  test("a comment hidden: its words withheld from everyone but its author and the owner; its reports closed; the appeal, then restored", async () => {
    const { ada, bob, issue } = await scene();
    await w.browser().post("/api/forge/report", { target: `research:${issue}#1`, reason: "abuse", turnstile: TOKEN }, { csrf: null });
    const res = await ada.post("/api/forge/moderation/decide", { op: "hide", target: `research:${issue}#1`, reason: "abuse", message: "Please keep it civil." });
    assert.equal(res.status, 200, JSON.stringify(await body(res)));
    assert.equal(forgeRows(w.forge, "content_reports")[0].state, "actioned");
    const carol = await signIn(w, "carol-fixture");
    const seen = await body(await carol.fetch(`/api/forge/research?id=${issue}`));
    assert.equal(seen.comments[0].body, "");
    assert.equal(seen.comments[0].moderated.reason, "abuse");
    const own = await body(await bob.fetch(`/api/forge/research?id=${issue}`));
    assert.match(own.comments[0].body, /Still crashing/);
    // Bob's page says it, and lets him appeal (Turnstile), once.
    const mine = await body(await bob.fetch("/api/forge/moderation/mine"));
    assert.equal(mine.hidden.length, 1);
    assert.equal(mine.hidden[0].message, "Please keep it civil.");
    assert.equal(mine.hidden[0].canAppeal, true);
    assert.equal((await bob.post("/api/forge/appeal", { target: `research:${issue}#1`, text: "It quoted the error, nothing more.", turnstile: TOKEN })).status, 200);
    assert.equal((await body(await bob.post("/api/forge/appeal", { target: `research:${issue}#1`, text: "It quoted the error, nothing more.", turnstile: TOKEN }))).error.code, "appeal_open");
    assert.equal((await carol.post("/api/forge/appeal", { target: `research:${issue}#1`, text: "Not mine but I appeal anyway, please.", turnstile: TOKEN })).status, 404);
    const q = await body(await ada.fetch("/api/forge/moderation"));
    assert.equal(q.appeals.length, 1);
    assert.equal((await ada.post("/api/forge/moderation/decide", { op: "appeal", target: `research:${issue}#1`, appeal: "accepted" })).status, 200);
    const back = await body(await carol.fetch(`/api/forge/research?id=${issue}`));
    assert.match(back.comments[0].body, /Still crashing/);
    assert.equal(back.comments[0].moderated, undefined);
    assert.equal(forgeRows(w.forge, "moderation")[0].state, "restored");
  });

  test("a research issue hidden: 410 for others, gone from the paper's list; comments on it refused", async () => {
    const { ada, bob, issue } = await scene();
    await ada.post("/api/forge/moderation/decide", { op: "hide", target: `research:${issue}`, reason: "spam" });
    const carol = await signIn(w, "carol-fixture");
    const one = await carol.fetch(`/api/forge/research?id=${issue}`);
    assert.equal(one.status, 410);
    assert.equal((await body(one)).error.moderation.reason, "spam");
    assert.equal((await body(await carol.fetch(`/api/forge/research?paper=10.1234/eeg.2026`))).issues.length, 0);
    assert.equal((await body(await bob.fetch(`/api/forge/research?paper=10.1234/eeg.2026`))).issues.length, 1, "its author still sees it");
    assert.equal((await carol.post("/api/forge/research/comment", { id: issue, body: "Me too" })).status, 410);
    assert.equal((await ada.fetch(`/api/forge/research?id=${issue}`)).status, 200, "the owner reads it");
  });

  test("an account suspended: its writes refused, its issues and comments withheld, its person page says so, its tokens revoked and hooks paused", async () => {
    const { ada, bob, issue, bobId, bobGithub } = await scene();
    w.forge.sqlite.prepare("INSERT INTO api_tokens (digest, id, user_id, name, scopes, created_at, expires_at) VALUES (?, ?, ?, 'ci', 'statuses:write', ?, ?)").run("f".repeat(64), "t".repeat(16), bobId, T0, T0 + 86_400);
    w.forge.sqlite.prepare("INSERT INTO hooks (user_id, id, subject, url, events, active, salt, created_at, updated_at) VALUES (?, ?, ?, 'https://hooks.lab.example/x', '*', 1, ?, ?, ?)").run(bobId, "h".repeat(16), `paper:${PAPER}`, "s".repeat(16), T0, T0);
    const res = await ada.post("/api/forge/moderation/decide", { op: "hide", target: `person:github:${bobGithub}`, reason: "spam", notice: "A spam account was suspended." });
    assert.equal(res.status, 200, JSON.stringify(await body(res)));
    assert.deepEqual(forgeRows(w.forge, "moderation").map((x) => x.kind).sort(), ["account", "github"]);
    assert.equal(forgeRows(w.forge, "api_tokens").length, 0);
    assert.equal(forgeRows(w.forge, "hooks")[0].active, 0);
    const refused = await bob.post("/api/forge/research/comment", { id: issue, body: "Again" });
    assert.equal(refused.status, 403);
    assert.equal((await body(refused)).error.code, "suspended");
    assert.equal((await bob.post("/api/forge/social/star", { subject: "topic:eeg", on: true })).status, 403);
    const carol = await signIn(w, "carol-fixture");
    assert.equal((await carol.fetch(`/api/forge/research?id=${issue}`)).status, 410);
    const person = await body(await carol.fetch(`/api/forge/social/person?github=${bobGithub}`));
    assert.equal(person.suspended, true);
    assert.equal(person.profile, undefined);
    assert.equal((await body(await carol.fetch(`/api/forge/social/activity?github=${bobGithub}`))).suspended, true);
    // Bob reads his page and may appeal.
    const mine = await body(await bob.fetch("/api/forge/moderation/mine"));
    assert.equal(mine.suspended, true);
    assert.equal((await bob.post("/api/forge/appeal", { target: `person:github:${bobGithub}`, text: "I am a researcher; the links were my papers.", turnstile: TOKEN })).status, 200);
    // Restored: he writes again (his tokens are gone for good; his hooks wait for him).
    const restored = await ada.post("/api/forge/moderation/decide", { op: "restore", target: `person:github:${bobGithub}` });
    assert.equal(restored.status, 200, JSON.stringify(await body(restored)));
    const again = await bob.post("/api/forge/research/comment", { id: issue, body: "Thanks" });
    assert.equal(again.status, 200, JSON.stringify(await body(again)));
    assert.equal(forgeRows(w.forge, "hooks")[0].active, 0);
  });

  test("a repository hidden: its layer answers 410 but to whoever manages it and the owner", async () => {
    const ada = await signIn(w, ADA_LOGIN);
    const adaId = await userIdOf(ADA_LOGIN);
    await seed.repo(w.forge, { repoId: "77", ownerLogin: "lab", name: "tool", linkedBy: adaId });
    assert.equal((await ada.post("/api/forge/moderation/decide", { op: "hide", target: "repo:memory:77", reason: "malware" })).status, 200);
    const bob = await signIn(w, "bob-fixture");
    const res = await bob.fetch("/api/forge/repo?id=memory:77");
    assert.equal(res.status, 410);
    assert.equal((await body(res)).error.moderation.reason, "malware");
    const own = await body(await ada.fetch("/api/forge/repo?id=memory:77"));
    assert.equal(own.moderation.reason, "malware");
  });

  test("the events of a suspended account, a hidden repository or a hidden thread are left out (inbox, feed, webhooks)", async () => {
    const e = (x: Partial<{ subject: string; thread: string; actor_user: string; actor_github: string }>) => ({ subject: "repo:github:5", thread: "issue:1", actor_user: "", actor_github: "", ...x });
    w.forge.sqlite.exec(`INSERT INTO moderation (kind, ref, target, state, reason, by_whom, created_at, updated_at) VALUES
      ('account', 'u_spam', 'person:github:9', 'hidden', 'spam', 'owner', ${T0}, ${T0}),
      ('github', '9', 'person:github:9', 'hidden', 'spam', 'owner', ${T0}, ${T0}),
      ('repo', 'github:6', 'repo:github:6', 'hidden', 'malware', 'owner', ${T0}, ${T0}),
      ('research', '4', 'research:4', 'hidden', 'abuse', 'owner', ${T0}, ${T0}),
      ('pull', 'github:5#2', 'pull:github:5#2', 'hidden', 'spam', 'owner', ${T0}, ${T0}),
      ('research', '5', 'research:5', 'restored', 'abuse', 'owner', ${T0}, ${T0})`);
    w.forge.reset();
    const events = [
      e({ actor_user: "u_spam" }), e({ actor_github: "9" }), e({ subject: "repo:github:6" }), e({ subject: `paper:${PAPER}`, thread: "research:4" }),
      e({ thread: "pull:2" }), e({ subject: `paper:${PAPER}`, thread: "research:5" }), e({ actor_user: "u_ok", actor_github: "8" }), e({ actor_user: "u_blocked" }),
    ];
    const hidden = await hiddenEventFilter(w.forge, events, { users: new Set(["u_blocked"]), github: new Set() });
    assert.deepEqual(events.map(hidden), [true, true, true, true, true, false, false, true]);
    assert.deepEqual(w.forge.scans, []);
  });
});
