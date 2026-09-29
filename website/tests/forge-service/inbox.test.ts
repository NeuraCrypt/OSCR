// Events, the in-site notifications, the feed and a person's activity (night phase 08, E2; events.ts,
// inbox.ts, and the events research.ts, act.ts and webhook.ts write). One event row per event, fanned
// out on read; the reader's own acts are no notification; a private repository never shows; a state
// is 1 row; no email is ever sent (there is no email anywhere).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { eventOfDelivery, eventsOfAction } from "../../worker/forge/service/events.ts";
import { handleForge } from "../../worker/forge/service/index.ts";
import { validateNotices } from "../../worker/forge/service/inbox.ts";
import { updateRepo, upsertInstallation } from "../../worker/forge/service/store.ts";
import { isProblem, type RepoRow } from "../../worker/forge/service/types.ts";
import type { ForgeEvent, RepoStub } from "../../worker/forge/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

const SECRET = "whsec-test-0123456789";
const INST = "7001";
const PAPER = "doi:10.1234/eeg.2026";
const CARBERRY = "0000-0002-1825-0097";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(async () => {
  w = forgeWorld({ env: { GITHUB_APP_WEBHOOK_SECRET: SECRET, ACCOUNT_DEV_METRICS: "1" } });
  await w.forge.batch([
    upsertInstallation(w.forge, { forge: "memory", id: INST, accountId: "5001", accountLogin: "lab", accountType: "organization", selection: "all", suspended: false }, T0).stmt,
  ]);
  await seed.repo(w.forge, { repoId: "101", ownerId: "5001", ownerLogin: "lab", name: "eeg", mode: "installed", installationId: INST, defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: PAPER, status: "linked" }] });
  w.forge.reset();
});
afterEach(() => w.restore());

let n = 0;
const stub = (visibility: RepoStub["visibility"] = "public"): RepoStub => ({ key: { forge: "memory", id: "101" }, ref: { forge: "memory", owner: "lab", name: "eeg" }, visibility, defaultBranch: "main" });
const bob = { name: "bob-fixture", login: "bob-fixture", id: "77" };

function comment(number: number, mentions: string[] = [], extra: Partial<Extract<ForgeEvent, { kind: "issue_comment" }>> = {}): ForgeEvent {
  return { kind: "issue_comment", delivery: `d-${++n}`, installation: INST, action: "created", number, title: "The filter's order", isPull: false, commentId: String(9000 + n), author: bob, mentions, repo: stub(), sender: bob, ...extra };
}

async function deliver(event: ForgeEvent): Promise<{ status: number; body: Json; written: number }> {
  const d = await w.backend.deliver(event, SECRET);
  const before = w.forge.totals.written;
  const req = new Request(new URL("/api/forge/webhook", ORIGIN), { method: "POST", headers: d.headers, body: d.body as Uint8Array<ArrayBuffer> });
  const res = (await handleForge(req, w.env, w.ctx, w.deps)) as Response;
  return { status: res.status, body: await body(res), written: w.forge.totals.written - before };
}

const inbox = async (b: ForgeBrowser): Promise<Json> => body(await b.fetch("/api/forge/social/inbox"));
const watch = (b: ForgeBrowser, level = "all", extra: Json = {}) => b.post("/api/forge/social/follow", { target: "repo:memory:101", level, on: true, ...extra });

describe("events", () => {
  test("a webhook's issue comment: ONE event row with its delivery row (2); a private repository's none", async () => {
    const got = await deliver(comment(3, ["ada-fixture"]));
    assert.equal(got.status, 200);
    assert.equal(got.written, 2);
    const [e] = forgeRows(w.forge, "events");
    assert.deepEqual([e.subject, e.kind, e.thread, e.url, e.actor_name, e.actor_github, e.mentions, e.thread_author], ["repo:memory:101", "issue_comment", "issue:3", "/r/lab/eeg/issues/3", "bob-fixture", "77", "ada-fixture", "github:77"]);
    // The same delivery again: nothing.
    const again = await w.backend.deliver(comment(3), SECRET);
    void again;
    const hidden = await deliver(comment(4, [], { repo: stub("private") }));
    assert.equal(hidden.written, 0);
    assert.equal(forgeRows(w.forge, "events").length, 1);
  });

  test("pull requests merged and releases published become events; drafts and other actions do not", () => {
    const repo = { forge: "memory", repo_id: "101", owner_login: "lab", name: "eeg" } as RepoRow;
    const merged = eventOfDelivery({ kind: "pull_request", delivery: "x", installation: INST, action: "closed", number: 5, repo: stub(), head: { ref: "a", sha: "1".repeat(40) }, base: { ref: "main" }, merged: true, sender: bob, title: "Faster" }, repo, T0);
    assert.deepEqual([merged?.kind, merged?.thread, merged?.url], ["pull_merged", "pull:5", "/r/lab/eeg/pull/5"]);
    const draft = eventOfDelivery({ kind: "release", delivery: "y", installation: INST, action: "published", repo: stub(), releaseId: "1", tagName: "v1", sender: bob, draft: true }, repo, T0);
    assert.equal(draft, null);
    const labeled = eventOfDelivery({ kind: "issues", delivery: "z", installation: INST, action: "labeled", number: 1, title: "", author: bob, mentions: [], repo: stub(), sender: bob }, repo, T0);
    assert.equal(labeled, null);
  });

  test("an authorized action's events: only where no webhook comes; the threads the person takes part in", () => {
    const base = { user: { id: "u_ada", github: "9", login: ADA_LOGIN }, t: T0, nonce: "n0nce-123" };
    const repo = { forge: "memory", repoId: "5", path: "ada-fixture/eeg" };
    const open = eventsOfAction({ ...base, kind: "issue_open", parsed: { title: "Bug", body: "cc @bob" }, result: { number: 4, page: "/r/ada-fixture/eeg/issues/4" }, repo, installed: false });
    assert.deepEqual(open.events.map((e) => [e.kind, e.thread, e.mentions]), [["issue_opened", "issue:4", ["bob"]]]);
    assert.deepEqual(open.threads, ["repo:memory:5#issue:4"]);
    const installed = eventsOfAction({ ...base, kind: "issue_open", parsed: { title: "Bug" }, result: { number: 4 }, repo, installed: true });
    assert.deepEqual([installed.events.length, installed.threads.length], [0, 1]);
    const tied = eventsOfAction({ ...base, kind: "release_create", parsed: { draft: false, paper: { doi: "10.1234/EEG.2026" } }, result: { tag: "v1.0", page: "/r/ada-fixture/eeg/releases/tag/v1.0" }, repo, installed: true });
    assert.deepEqual(tied.events.map((e) => [e.subject, e.kind]), [[`paper:${PAPER}`, "release_tied"]]);
  });
});

describe("the inbox", () => {
  test("watching a repository: a comment arrives, is read, comes back unread with newer activity, is done, saved, unsubscribed", async () => {
    const ada = await signIn(w);
    await watch(ada);
    await deliver(comment(3));
    w.forge.reset();
    let got = await inbox(ada);
    assert.equal(got.threads.length, 1);
    const t = got.threads[0];
    assert.deepEqual([t.key, t.words, t.title, t.repo, t.reason, t.unread, t.done, t.saved], ["repo:memory:101#issue:3", "issue #3", "The filter's order", "lab/eeg", "subscribed", true, false, false]);
    assert.equal(t.latest.actor, "bob-fixture");
    assert.equal(w.forge.totals.written, 0);
    assert.deepEqual(w.forge.scans, []);
    // Read: 1 row and the action row.
    w.forge.reset();
    const read = await ada.post("/api/forge/social/notices", { op: "read", threads: [{ key: t.key }] });
    assert.equal(read.status, 200, JSON.stringify(await body(read)));
    assert.equal(w.forge.totals.written, 2);
    assert.equal((await inbox(ada)).threads[0].unread, false);
    // Newer activity: unread again.
    w.advance(60);
    await deliver(comment(3));
    got = await inbox(ada);
    assert.equal(got.threads[0].unread, true);
    assert.equal(got.threads[0].count, 2);
    // Done, then saved: done goes with newer activity; saved stays.
    await ada.post("/api/forge/social/notices", { op: "done", threads: [t.key] });
    assert.equal((await inbox(ada)).threads[0].done, true);
    await ada.post("/api/forge/social/notices", { op: "save", threads: [{ key: t.key, title: "The filter's order", url: "/r/lab/eeg/issues/3" }] });
    assert.equal((await inbox(ada)).threads[0].saved, true);
    // Unsubscribed: the thread is silent, even with newer activity.
    await ada.post("/api/forge/social/notices", { op: "unsubscribe", threads: [t.key] });
    w.advance(60);
    await deliver(comment(3));
    got = await inbox(ada);
    assert.equal(got.threads.find((x: Json) => x.key === t.key && !x.expired), undefined);
    assert.deepEqual(w.forge.scans, []);
  });

  test("participating: a mention reaches a reader who watches at that level; an unrelated comment does not", async () => {
    const ada = await signIn(w);
    await watch(ada, "participating");
    await deliver(comment(3));
    assert.equal((await inbox(ada)).threads.length, 0);
    await deliver(comment(4, ["ada-fixture"]));
    const got = await inbox(ada);
    assert.equal(got.threads.length, 1);
    assert.equal(got.threads[0].reason, "mention");
  });

  test("a research issue: the paper's watchers are told; its author follows it and hears the replies; one's own act is no notification", async () => {
    const ada = await signIn(w);
    await ada.post("/api/forge/social/follow", { target: `paper:${PAPER}`, on: true });
    const opened = await ada.post("/api/forge/research/open", { paper: "10.1234/eeg.2026", code: "https://zenodo.org/records/1", type: "code_error", title: "An off-by-one in the epochs", body: "Line 12." });
    assert.equal(opened.status, 201, JSON.stringify(await body(opened)));
    // Ada's own issue: nothing in her inbox.
    assert.equal((await inbox(ada)).threads.length, 0);
    // Someone else comments (written as the registry writes it, with another actor).
    const [row] = forgeRows(w.forge, "events");
    await w.forge.batch([
      w.forge
        .prepare("INSERT INTO events (subject, at, nonce, kind, thread, title, url, actor_user, actor_name, thread_author) VALUES (?, ?, 'other-nonce', 'research_comment', ?, ?, ?, 'u_bob', 'bob-fixture', ?)")
        .bind(row.subject, T0 + 5, row.thread, row.title, row.url, row.thread_author),
    ]);
    const got = await inbox(ada);
    assert.equal(got.threads.length, 1);
    assert.deepEqual([got.threads[0].reason, got.threads[0].paper, got.threads[0].repo, got.threads[0].url], ["author", "10.1234/eeg.2026", null, "/research/1"]);
  });

  test("a repository made private leaves every inbox at once", async () => {
    const ada = await signIn(w);
    await watch(ada);
    await deliver(comment(3));
    assert.equal((await inbox(ada)).threads.length, 1);
    await w.forge.batch([updateRepo(w.forge, "memory", "101", { state: "hidden", ownerLogin: "", name: "" }, T0).stmt]);
    const got = await inbox(ada);
    assert.equal(got.threads.length, 0);
    assert.ok(!JSON.stringify(got).includes("lab/eeg"));
  });

  test("mark all as read: 1 row; the settings: 1 row; the payloads' limits", async () => {
    const ada = await signIn(w);
    await watch(ada);
    await deliver(comment(3));
    await deliver(comment(4));
    w.forge.reset();
    await ada.post("/api/forge/social/notices", { op: "all_read" });
    assert.equal(w.forge.totals.written, 2);
    assert.ok((await inbox(ada)).threads.every((t: Json) => !t.unread));
    const settings = await ada.post("/api/forge/social/notices", { op: "settings", settings: { participating: true, filters: [{ name: "Research", q: "is:research" }] } });
    assert.equal(settings.status, 200);
    assert.deepEqual((await inbox(ada)).settings.filters, [{ name: "Research", q: "is:research" }]);
    assert.ok(isProblem(validateNotices({ op: "read", threads: Array.from({ length: 26 }, (_, i) => `repo:memory:1#issue:${i + 1}`) })));
    assert.ok(isProblem(validateNotices({ op: "read", threads: ["https://evil.example#x"] })));
    assert.ok(isProblem(validateNotices({ op: "save", threads: [{ key: "repo:memory:1#issue:1", url: "//evil.example" }] })) === false);
    const saved = validateNotices({ op: "save", threads: [{ key: "repo:memory:1#issue:1", url: "//evil.example" }] });
    assert.ok(!isProblem(saved) && saved.threads[0].url === "");
  });

  test("FORGE_OPEN unset: another account reads its own inbox, and may not change it", async () => {
    await signIn(w);
    const bobB = await signIn(w, "bob-fixture");
    assert.equal((await bobB.fetch("/api/forge/social/inbox")).status, 200);
    const res = await bobB.post("/api/forge/social/notices", { op: "all_read" });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "forge_closed");
  });
});

describe("the feed and the activity", () => {
  test("following an author by ORCID iD: once they have an account, their public acts reach the feed", async () => {
    const ada = await signIn(w);
    await ada.post("/api/forge/social/follow", { target: `orcid:${CARBERRY}`, on: true });
    await ada.post("/api/forge/social/follow", { target: "repo:memory:101", on: true });
    await deliver(comment(3));
    // Josiah signs in with his ORCID iD, then stars a paper (written as the registry writes it).
    w.mock.who.orcid = { sub: CARBERRY, name: "Josiah Carberry" };
    const josiah = w.browser();
    await josiah.signIn("orcid");
    const jid = (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'orcid' AND subject = ?").get(CARBERRY) as { user_id: string }).user_id;
    await seed.action(w.forge, { userId: jid, kind: "star" as never, t: T0 + 10 });
    w.forge.sqlite.prepare("UPDATE actions SET subject = ? WHERE user_id = ?").run(`paper:${PAPER}`, jid);
    const feed = await body(await ada.fetch("/api/forge/social/feed"));
    const kinds = feed.items.map((i: Json) => [i.kind, i.actor]);
    assert.deepEqual(kinds, [["star", CARBERRY], ["issue_comment", "bob-fixture"]]);
    assert.equal(feed.items[0].about, "10.1234/eeg.2026");
    assert.ok(!JSON.stringify(feed).includes(jid));
    assert.deepEqual(w.forge.scans, []);
  });

  test("a person's activity: the calendar counts contributions, not stars; the milestones in words; private stays private", async () => {
    const ada = await signIn(w);
    await ada.post("/api/forge/research/open", { paper: "10.1234/eeg.2026", code: "https://zenodo.org/records/1", type: "code_error", title: "Epochs", body: "x" });
    await ada.post("/api/forge/social/star", { subject: `paper:${PAPER}`, on: true });
    const mine = await body(await ada.fetch("/api/forge/social/activity?me=1"));
    assert.deepEqual(Object.values(mine.calendar), [1]);
    assert.deepEqual(mine.timeline.map((x: Json) => x.kind).sort(), ["research_opened", "star"]);
    assert.ok(mine.milestones.some((m: Json) => m.key === "research"));
    await ada.post("/api/forge/social/profile", { private: true });
    const bobB = await signIn(w, "bob-fixture");
    const seen = await body(await bobB.fetch(`/api/forge/social/activity?github=${w.ada.user.id}`));
    assert.deepEqual(seen, { account: true, private: true });
    assert.deepEqual(w.forge.scans, []);
  });
});
