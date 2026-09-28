// POST /api/forge/webhook (night phase 01, E3; worker/forge/service/webhook.ts): GitHub's
// deliveries for the mirror mode. Deliveries are built with MemoryBackend.deliver (the double's
// codec), and one with GitHub's own codec through the Worker's entry (FORGE_OPEN unset). A bad
// signature is 401; an oversized body is 413 before the signature is checked; a delivery from an
// installation the registry does not know changes nothing; a redelivery writes nothing; an older
// push is ignored; a rename moves the path; deleted is gone; privatized is hidden with no name; an
// installation removed leaves its repositories public; at most 2 rows per delivery; no email address
// in any row.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { handleForge } from "../../worker/forge/service/index.ts";
import { first, repoByPath, upsertInstallation } from "../../worker/forge/service/store.ts";
import type { RepoRow } from "../../worker/forge/service/types.ts";
import type { ForgeEvent, RepoStub } from "../../worker/forge/types.ts";
import worker from "../../worker/index.ts";
import { forgeCounts, forgeRows, forgeText } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

const SECRET = "whsec-test-0123456789";
const SHA = (c: string) => c.repeat(40);
const OWNER_ID = "5001";
const INST = "7001";

let w: ForgeWorld;
beforeEach(async () => {
  w = forgeWorld({ env: { GITHUB_APP_WEBHOOK_SECRET: SECRET } });
  await w.forge.batch([
    upsertInstallation(w.forge, { forge: "memory", id: INST, accountId: OWNER_ID, accountLogin: "lab", accountType: "organization", selection: "all", suspended: false }, T0).stmt,
  ]);
  await seed.repo(w.forge, { repoId: "101", ownerId: OWNER_ID, ownerLogin: "lab", name: "eeg", mode: "installed", installationId: INST, defaultBranch: "main", head: SHA("a"), headAt: T0 - 100 });
  w.forge.reset();
});
afterEach(() => w.restore());

let n = 0;
const delivery = () => `d-${++n}`;
const stub = (id = "101", owner = "lab", name = "eeg", visibility: RepoStub["visibility"] = "public"): RepoStub => ({
  key: { forge: "memory", id },
  ref: { forge: "memory", owner, name },
  visibility,
  defaultBranch: "main",
});
const sender = { name: "ada-fixture", login: "ada-fixture", id: "9" };
type PushEvent = Extract<ForgeEvent, { kind: "push" }>;
type RepositoryEvent = Extract<ForgeEvent, { kind: "repository" }>;
const push = (after: string, pushedAt: number, extra: Partial<PushEvent> = {}): PushEvent => ({
  kind: "push",
  delivery: delivery(),
  installation: INST,
  repo: stub(),
  ref: "refs/heads/main",
  before: SHA("a"),
  after,
  created: false,
  deleted: false,
  forced: false,
  pushedAt,
  commits: [{ sha: after, added: [], removed: [], modified: ["analysis.py"] }],
  pusher: { name: "Ada Fixture", login: "ada-fixture", id: "9" },
  ...extra,
});
const repository = (action: RepositoryEvent["action"], repo = stub()): RepositoryEvent => ({
  kind: "repository",
  delivery: delivery(),
  installation: INST,
  action,
  repo,
  previous: null,
  sender,
});

async function send(event: ForgeEvent | { headers: Headers; body: Uint8Array }, secret = SECRET): Promise<{ status: number; body: Record<string, unknown>; written: number }> {
  const d = "headers" in event ? event : await w.backend.deliver(event, secret);
  const before = w.forge.totals.written;
  const req = new Request(new URL("/api/forge/webhook", ORIGIN), { method: "POST", headers: d.headers, body: d.body as Uint8Array<ArrayBuffer> });
  const res = (await handleForge(req, w.env, w.ctx, w.deps)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, written: w.forge.totals.written - before };
}

const row = async (id = "101") => (w.forge.sqlite.prepare("SELECT * FROM repos WHERE repo_id = ?").get(id) ?? null) as RepoRow | null;

describe("the delivery itself", () => {
  test("a bad signature: 401, nothing written", async () => {
    const res = await send(push(SHA("b"), T0), "another-secret");
    assert.equal(res.status, 401);
    assert.equal(res.written, 0);
  });

  test("over 1 MiB: 413 before the signature is checked", async () => {
    let verified = 0;
    const verify = w.backend.webhooks.verify.bind(w.backend.webhooks);
    w.backend.webhooks.verify = async (...a) => {
      verified++;
      return verify(...a);
    };
    const big = await w.backend.deliver({ ...push(SHA("b"), T0), commits: [{ sha: SHA("b"), added: ["x".repeat(2 ** 20)], removed: [], modified: [] }] }, SECRET);
    assert.equal((await send(big)).status, 413);
    // Declared too large: refused without reading.
    const declared = new Headers(big.headers);
    declared.set("Content-Length", String(2 ** 20 + 1));
    assert.equal((await send({ headers: declared, body: new Uint8Array(10) })).status, 413);
    assert.equal(verified, 0);
    assert.equal(forgeCounts(w.forge).deliveries, 0);
  });

  test("the App's webhook secret unset: 503 not_configured", async () => {
    w.env.GITHUB_APP_WEBHOOK_SECRET = undefined;
    const res = await send(push(SHA("b"), T0));
    assert.equal(res.status, 503);
    assert.equal(res.body.error && (res.body.error as { code: string }).code, "not_configured");
  });

  test("ping, refs, releases and pull requests: acknowledged, nothing stored", async () => {
    for (const e of [
      { kind: "ping", delivery: delivery() },
      { kind: "ref", delivery: delivery(), installation: INST, action: "created", refType: "branch", ref: "refs/pull/1/head", repo: stub(), sender },
    ] as ForgeEvent[]) {
      const res = await send(e);
      assert.equal(res.status, 200);
      assert.equal(res.written, 0);
    }
  });
});

describe("pushes", () => {
  test("a push to the default branch moves the head: 2 rows with its delivery; redelivered, nothing", async () => {
    const e = push(SHA("b"), T0);
    const res = await send(e);
    assert.equal(res.status, 200);
    assert.equal(res.written, 2);
    const r = await row();
    assert.deepEqual([r?.head, r?.head_at], [SHA("b"), T0]);
    assert.deepEqual(forgeRows(w.forge, "deliveries").map((d) => [d.delivery, d.event, d.rows]), [[e.delivery, "push", 2]]);
    const again = await send(await w.backend.deliver(e, SECRET));
    assert.equal(again.written, 0);
    assert.equal(again.body.duplicate, true);
  });

  test("an older push is ignored; another branch's too", async () => {
    await send(push(SHA("b"), T0));
    const older = await send(push(SHA("c"), T0 - 50));
    assert.equal(older.written, 0);
    assert.equal((await row())?.head, SHA("b"));
    const other = await send(push(SHA("d"), T0 + 10, { ref: "refs/heads/feature" }));
    assert.equal(other.written, 0);
  });

  test("a push to a repository with tracing maps asks the Mac for a push job: 2 rows, redelivered 0", async () => {
    w.forge.sqlite
      .prepare("INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) VALUES ('memory', '101', 'analysis.py', 'doi:10.5555/oscr.fixture.1', ?, 2)")
      .run(SHA("a"));
    const e = push(SHA("b"), T0);
    const res = await send(e);
    assert.equal(res.written, 2);
    assert.deepEqual(forgeRows(w.forge, "jobs").map((j) => [j.kind, j.repo_id, j.ref]), [["push", "101", SHA("b")]]);
    assert.equal((await row())?.head, SHA("b"));
    // Idempotent by itself: no delivery row, and a redelivery writes nothing.
    assert.equal(forgeCounts(w.forge).deliveries, 0);
    assert.equal((await send(await w.backend.deliver(e, SECRET))).written, 0);
    assert.equal(forgeCounts(w.forge).jobs, 1);
  });

  test("an installation the registry does not know, or not the repository's: nothing changes", async () => {
    const res = await send({ ...push(SHA("b"), T0), installation: "9999" });
    assert.equal(res.status, 200);
    assert.equal(res.written, 0);
    const none = await send({ ...push(SHA("b"), T0), installation: null });
    assert.equal(none.written, 0);
    const unknownRepo = await send({ ...push(SHA("b"), T0), repo: stub("202", "lab", "other") });
    assert.equal(unknownRepo.written, 0);
    assert.equal((await row())?.head, SHA("a"));
  });

  test("no email address reaches a row: pusher and commit authors", async () => {
    const e = push(SHA("b"), T0) as unknown as Record<string, unknown>;
    (e.pusher as Record<string, unknown>).email = "ada.fixture@example.org";
    e.commits = [{ sha: SHA("b"), added: [], removed: [], modified: ["a.py"], author: { name: "Ada", email: "ada.fixture@example.org" } }];
    const res = await send(e as unknown as ForgeEvent);
    assert.equal(res.written, 2);
    assert.ok(!forgeText(w.forge).includes("@"));
    assert.ok(!forgeText(w.forge).includes("example.org"));
  });
});

describe("repositories", () => {
  test("renamed: the path moves (2 rows, no delivery row) and repoByPath finds it; redelivered, nothing", async () => {
    const e = repository("renamed", stub("101", "lab", "EEG-Study"));
    const res = await send(e);
    assert.equal(res.written, 2);
    const r = await row();
    assert.deepEqual([r?.owner_login, r?.name], ["lab", "eeg-study"]);
    assert.equal((await first<RepoRow>(repoByPath(w.forge, "memory", "lab", "EEG-Study")))?.repo_id, "101");
    assert.equal(await first<RepoRow>(repoByPath(w.forge, "memory", "lab", "eeg")), null);
    assert.equal((await send(await w.backend.deliver(e, SECRET))).written, 0);
    // Transferred to another account the installation covers by login.
    await w.forge.batch([
      upsertInstallation(w.forge, { forge: "memory", id: "7002", accountId: "5002", accountLogin: "new-lab", accountType: "organization", selection: "all", suspended: false }, T0).stmt,
    ]);
    const moved = await send({ ...repository("transferred", stub("101", "new-lab", "eeg-study")), installation: "7002" });
    assert.equal(moved.written, 2);
    assert.equal((await row())?.owner_login, "new-lab");
  });

  test("archived, unarchived, deleted (gone), privatized (hidden, its name blanked)", async () => {
    assert.equal((await send(repository("archived"))).written, 2);
    assert.equal((await row())?.state, "archived");
    assert.equal((await send(repository("unarchived"))).written, 2);
    assert.equal((await row())?.state, "active");
    assert.equal((await send(repository("deleted"))).written, 2);
    assert.equal((await row())?.state, "gone");
    await seed.repo(w.forge, { repoId: "103", ownerId: OWNER_ID, ownerLogin: "lab", name: "private-soon", mode: "installed", installationId: INST });
    const hidden = await send(repository("privatized", stub("103", "lab", "private-soon", "private")));
    assert.ok(hidden.written <= 2);
    const r = await row("103");
    assert.deepEqual([r?.state, r?.owner_login, r?.name], ["hidden", "", ""]);
    assert.ok(!forgeText(w.forge).includes("private-soon"));
    // Publicized, created: nothing until a person links it.
    assert.equal((await send(repository("publicized", stub("103", "lab", "private-soon")))).written, 0);
  });
});

describe("installations", () => {
  const installation = (action: Extract<ForgeEvent, { kind: "installation" }>["action"], id = INST, suspended = false): ForgeEvent => ({
    kind: "installation",
    delivery: delivery(),
    action,
    installation: { id, account: { id: OWNER_ID, login: "lab", type: "organization" }, selection: "all", suspended },
    sender,
  });

  test("created, suspended, unsuspended: the installation row (2 rows with the delivery)", async () => {
    const created = await send(installation("created", "7010"));
    assert.equal(created.written, 2);
    assert.deepEqual(forgeRows(w.forge, "installations").map((i) => i.id).sort(), [INST, "7010"]);
    await send(installation("suspend"));
    assert.equal(forgeRows(w.forge, "installations").find((i) => i.id === INST)?.suspended, 1);
    // Suspended: its pushes change nothing.
    assert.equal((await send(push(SHA("b"), T0))).written, 0);
    await send(installation("unsuspend"));
    assert.equal((await send(push(SHA("b"), T0))).written, 2);
  });

  test("deleted: its repositories fall back to public, read every night", async () => {
    const res = await send(installation("deleted"));
    assert.equal(res.status, 200);
    const r = await row();
    assert.deepEqual([r?.mode, r?.installation_id], ["public", null]);
    assert.equal(forgeRows(w.forge, "installations").length, 0);
    assert.deepEqual(w.forge.scans, []);
    // Redelivered or unknown: nothing.
    assert.equal((await send(installation("deleted"))).written, 0);
  });

  test("repositories added and removed: installed, then public; a private one's name is never stored", async () => {
    await seed.repo(w.forge, { repoId: "104", ownerId: OWNER_ID, ownerLogin: "lab", name: "mirror", mode: "public" });
    const added: ForgeEvent = {
      kind: "installation_repositories",
      delivery: delivery(),
      action: "added",
      installation: { id: INST, account: { id: OWNER_ID, login: "lab", type: "organization" }, selection: "selected", suspended: false },
      added: [stub("104", "lab", "mirror"), stub("105", "lab", "hush-hush-project", "private")],
      removed: [],
      sender,
    };
    const res = await send(added);
    assert.equal(res.written, 2);
    assert.deepEqual([(await row("104"))?.mode, (await row("104"))?.installation_id], ["installed", INST]);
    assert.ok(!forgeText(w.forge).includes("hush-hush-project"));
    const removed = await send({ ...added, delivery: delivery(), action: "removed", added: [], removed: [stub("104", "lab", "mirror")] });
    assert.equal(removed.written, 2);
    assert.deepEqual([(await row("104"))?.mode, (await row("104"))?.installation_id], ["public", null]);
  });
});

describe("through the Worker, with GitHub's own codec", () => {
  test("a push signed by GitHub, FORGE_OPEN unset: the head moves; the emails stay out", async () => {
    const env = { ...w.env, FORGE_OPEN: undefined };
    await seed.repo(w.forge, { forge: "github", repoId: "301", ownerId: "6001", ownerLogin: "lab", name: "gh-eeg", mode: "installed", installationId: "8001", defaultBranch: "main" });
    await w.forge.batch([
      upsertInstallation(w.forge, { forge: "github", id: "8001", accountId: "6001", accountLogin: "lab", accountType: "organization", selection: "all", suspended: false }, T0).stmt,
    ]);
    const payload = {
      ref: "refs/heads/main",
      before: SHA("a"),
      after: SHA("e"),
      created: false,
      deleted: false,
      forced: false,
      repository: { id: 301, name: "gh-eeg", full_name: "lab/gh-eeg", owner: { login: "lab", id: 6001 }, visibility: "public", default_branch: "main", pushed_at: T0 + 5 },
      pusher: { name: "ada-fixture", email: "ada.fixture@example.org" },
      sender: { login: "ada-fixture", id: 9 },
      installation: { id: 8001 },
      commits: [{ id: SHA("e"), added: [], removed: [], modified: ["a.py"], author: { name: "Ada", email: "ada.fixture@example.org", username: "ada-fixture" } }],
    };
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const request = (signature: string) =>
      new Request(new URL("/api/forge/webhook", ORIGIN), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958", "X-Hub-Signature-256": signature },
        body,
      });
    const refused = await worker.fetch(request(sign("not-the-secret")), env, w.ctx);
    assert.equal(refused.status, 401);
    const res = await worker.fetch(request(sign(SECRET)), env, w.ctx);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const r = w.forge.sqlite.prepare("SELECT head, head_at FROM repos WHERE forge = 'github' AND repo_id = '301'").get() as { head: string; head_at: number };
    assert.deepEqual([r.head, r.head_at], [SHA("e"), T0 + 5]);
    assert.ok(!forgeText(w.forge).includes("@"));
  });
});
