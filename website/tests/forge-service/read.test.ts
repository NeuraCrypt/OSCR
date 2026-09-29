// The forge service's reads (night phase 01, E6: worker/forge/service/read.ts) and the "Your
// repositories" page (src/pages/repositories.astro, src/scripts/repositories.ts):
// - GET /api/forge/repo: OSCR's layer for one repository, from seeded oscr_forge and oscr_community
//   rows (the documented JSON), the reader's roles computed from the community's facts, a hidden
//   repository answered 404 without its name, at most 12 rows read and none written, never a scan;
// - GET /api/forge/mine: the reader's repositories paged by cursor, filtered by mode (mirror:) and
//   template (template:), the pending deletions first with their dates, the caps;
// - signed out: 401 with the stale cookies cleared; every answer no-store;
// - the page: no request without the hint cookie (the script's pure decision, and its guard).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ORIGIN } from "../account/browser.ts";
import { addFacts } from "../account/d1.ts";
import worker from "../../worker/index.ts";
import { GRACE_SECONDS, PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { JOBS_TAIL, parseMine, parseTarget, stateSentence, statusLine } from "../../worker/forge/service/read.ts";
import { updateRepo } from "../../worker/forge/service/store.ts";
import { day, HINT, mineUrl, modeWords, restoreLink, shouldAsk, stateWords } from "../../src/scripts/repositories.ts";
import { forgeCounts, type FakeForgeD1 } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const HEAD = "a".repeat(40);
const ORCID = "0000-0000-0000-001X";
const ONE = "doi:10.1234/one";
const TWO = "doi:10.1234/two";
const EEG_KEY = "github.com/ada-fixture/eeg-pipeline";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

/** A signed-in browser for the GitHub account the mock gives (Ada by default), and its user id. */
async function signIn(who?: { id: number; login: string; name: string }): Promise<{ b: ForgeBrowser; userId: string }> {
  if (who) w.mock.who.github = who;
  const b = w.browser();
  await b.signIn("github");
  const subject = String(w.mock.who.github.id);
  const row = w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string };
  return { b, userId: row.user_id };
}

const BOB = { id: 5_000_001, login: "bob-lab", name: "Bob Lab" };

function traced(db: FakeForgeD1, repoId: string, rows: [string, string][]): void {
  for (const [path, paper] of rows) {
    db.sqlite
      .prepare("INSERT INTO traced_paths (forge, repo_id, path, paper_id, commit_sha, ranges) VALUES ('memory', ?, ?, ?, ?, 2)")
      .run(repoId, path, paper, HEAD);
  }
}

function role(userId: string, r: string, kind: string, id: string): void {
  w.db.sqlite
    .prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, 'system', ?)")
    .run(userId, r, kind, id, T0);
}

/** The EEG repository of the documented example: installed, a template, two papers, three traced
 *  paths, one job waiting and one answered. */
async function seedEeg(linkedBy: string): Promise<void> {
  await seed.repo(
    w.forge,
    { repoId: "101", ownerLogin: "Ada-Fixture", name: "EEG-Pipeline", mode: "installed", installationId: "9", defaultBranch: "main", head: HEAD, headAt: T0 - 3600, template: true, linkedBy },
    T0 - 86_400,
    { papers: [{ paperId: ONE, status: "linked" }, { paperId: TWO, status: "proposed" }] },
  );
  traced(w.forge, "101", [["src/filter.py", ONE], ["src/epochs.py", ONE], ["run.m", TWO]]);
  await seed.job(w.forge, { kind: "link", repoId: "101", userId: linkedBy }, T0 - 600);
  await seed.job(w.forge, { kind: "push", repoId: "101", ref: HEAD }, T0 - 300);
  await seed.job(w.forge, { kind: "link", repoId: "202" }, T0 - 200);
  // The Mac answered the first one.
  w.forge.sqlite.prepare("UPDATE jobs SET done_at = ?, outcome = 'done' WHERE id = 1").run(T0 - 100);
}

/** No statement read a whole table: the forge's plans (d1.ts records them) and the community's. */
function assertNoScan(): void {
  assert.deepEqual(w.forge.scans, []);
  const tables = new Set((w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
  for (const query of w.db.queries) {
    if (!/^\s*SELECT/i.test(query)) continue;
    const plan = w.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
    for (const { detail } of plan) {
      const m = /^SCAN (\w+)/.exec(detail);
      assert.ok(!(m && tables.has(m[1])), `${detail} :: ${query}`);
    }
  }
}

const rowsRead = (res: Response): number => Number(res.headers.get("X-D1-Rows-Read")) + Number(res.headers.get("X-D1-Forge-Rows-Read"));
const rowsWritten = (res: Response): number => Number(res.headers.get("X-D1-Rows-Written")) + Number(res.headers.get("X-D1-Forge-Rows-Written"));

describe("GET /api/forge/repo", () => {
  test("seeded rows give the documented layer: mode, status line, papers, roles, maps, jobs", async () => {
    const { b, userId } = await signIn();
    await seedEeg(userId);
    w.db.sqlite.prepare("UPDATE users SET orcid = ? WHERE id = ?").run(ORCID, userId);
    addFacts(w.db, { papers: [[ORCID, ONE, "one-2026", "Filtering EEG"]], repos: [[EEG_KEY, "github.com", "ada-fixture"]] });
    role(userId, "verified_author", "paper", ONE);
    w.db.queries.length = 0;
    w.forge.reset();

    const res = await b.fetch("/api/forge/repo?id=memory:101");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await body(res), {
      forge: "memory",
      id: "101",
      owner: "ada-fixture",
      name: "eeg-pipeline",
      url: "/r/ada-fixture/eeg-pipeline/",
      mode: "installed",
      template: true,
      defaultBranch: "main",
      head: HEAD,
      headAt: T0 - 3600,
      lastSeen: T0 - 86_400,
      status: {
        webhooks: true,
        polled: false,
        sentence: "Linked, with the registry's App installed: GitHub sends the registry its pushes as they happen. Last push seen: 2026-09-28.",
      },
      state: "active",
      deleteAfter: null,
      stateSentence: null,
      restore: false,
      papers: [
        { doi: "10.1234/one", status: "linked", slug: "one-2026", title: "Filtering EEG", at: T0 - 86_400 },
        { doi: "10.1234/two", status: "proposed", slug: null, title: null, at: T0 - 86_400 },
      ],
      roles: ["verified_author", "maintainer", "owner", "linked_by"],
      authorOf: ["10.1234/one"],
      maps: 2,
      paths: 3,
      jobs: [{ id: 2, kind: "push", ref: HEAD, createdAt: T0 - 300, notBefore: null }],
      // Phase 04: the verified authors with a GitHub login, the reviewers a pull request suggests.
      reviewers: [{ login: "ada-fixture", papers: ["10.1234/one"] }],
    });
    // Budget R6: at most 12 rows read in both databases (phase 04's authors included), none
    // written, never a scan.
    assert.ok(rowsRead(res) <= 12, `rows read: ${rowsRead(res)}`);
    assert.ok(rowsRead(res) >= 5);
    assert.equal(rowsWritten(res), 0);
    assert.equal(w.forge.totals.written, 0);
    assertNoScan();
  });

  test("by path, in any letter case, the same layer; the answer never names an email or a user id", async () => {
    const { b, userId } = await signIn();
    await seedEeg(userId);
    const byId = await body(await b.fetch("/api/forge/repo?id=memory:101"));
    const res = await b.fetch("/api/forge/repo?path=Ada-Fixture/EEG-Pipeline");
    assert.equal(res.status, 200);
    const byPath = await body(res);
    assert.deepEqual(byPath, byId);
    assert.ok(rowsRead(res) <= 12);
    const text = JSON.stringify(byPath);
    assert.ok(!text.includes(userId), "the linker's user id stays in the database");
    assert.ok(!text.includes("@"));
    assertNoScan();
  });

  test("roles come from the community's facts: another reader has none until a fact or a role names them", async () => {
    const ada = await signIn();
    await seedEeg(ada.userId);
    const { b: bob, userId: bobId } = await signIn(BOB);
    let layer = await body(await bob.fetch("/api/forge/repo?id=memory:101"));
    assert.deepEqual(layer.roles, []);
    // Phase 04: the paper's authors are suggested only to those who manage the code or wrote a paper.
    assert.deepEqual(layer.reviewers, []);
    assert.deepEqual(layer.authorOf, []);
    assert.equal(layer.restore, false);
    // Paper facts are the reader's own: Bob authored none, so no slug or title from them.
    assert.ok(layer.papers.every((p: Json) => p.slug === null && p.title === null));

    // The Mac's repo_owner fact naming Bob's login makes him a maintainer (as verify.ts does).
    addFacts(w.db, { repos: [[EEG_KEY, "github.com", "bob-lab"]] });
    layer = await body(await bob.fetch("/api/forge/repo?id=memory:101"));
    assert.deepEqual(layer.roles, ["maintainer"]);
    // A maintainer role alone does too; a verified author of the other paper is one of it only.
    addFacts(w.db, { repos: [[EEG_KEY, "github.com", "someone-else"]] });
    assert.deepEqual((await body(await bob.fetch("/api/forge/repo?id=memory:101"))).roles, []);
    role(bobId, "maintainer", "repo", EEG_KEY);
    role(bobId, "verified_author", "paper", TWO);
    role(bobId, "verified_author", "paper", "doi:10.9999/not-linked");
    layer = await body(await bob.fetch("/api/forge/repo?id=memory:101"));
    assert.deepEqual(layer.roles, ["verified_author", "maintainer"]);
    assert.deepEqual(layer.authorOf, ["10.1234/two"]);
    // Ada: the owner of the account and the one who linked it; no maintainer fact names her now.
    assert.deepEqual((await body(await ada.b.fetch("/api/forge/repo?id=memory:101"))).roles, ["owner", "linked_by"]);
    assertNoScan();
  });

  test("a public mirror is polled; a pending deletion gives its date and restore to those who may", async () => {
    const ada = await signIn();
    const deleteAfter = T0 + GRACE_SECONDS;
    await seed.repo(w.forge, { repoId: "303", ownerLogin: ADA_LOGIN, name: "old-analysis", mode: "public", linkedBy: ada.userId }, T0, {
      state: "pending_deletion",
      deleteAfter,
    });
    const layer = await body(await ada.b.fetch("/api/forge/repo?path=ada-fixture/old-analysis"));
    assert.equal(layer.mode, "public");
    assert.deepEqual(layer.status, {
      webhooks: false,
      polled: true,
      sentence:
        "Linked, public and without the registry's App: read only, the registry's computer reads it every night. No push seen yet. Last seen: 2026-09-28.",
    });
    assert.equal(layer.state, "pending_deletion");
    assert.equal(layer.deleteAfter, deleteAfter);
    assert.equal(layer.stateSentence, "Asked for deletion: it leaves the registry after 2026-10-28, and can be restored until then.");
    assert.equal(layer.restore, true);
    assert.deepEqual(layer.papers, []);
    assert.equal(layer.maps, 0);
    assert.equal(layer.paths, 0);
    const bob = await signIn(BOB);
    assert.equal((await body(await bob.b.fetch("/api/forge/repo?path=ada-fixture/old-analysis"))).restore, false);
    // A created repository with the App installed receives webhooks; archived and gone in words.
    assert.equal(statusLine({ mode: "created", installation_id: "9", head_at: null, updated_at: T0 }).webhooks, true);
    assert.equal(statusLine({ mode: "created", installation_id: null, head_at: null, updated_at: T0 }).polled, true);
    assert.equal(stateSentence({ state: "archived", delete_after: null }), "Archived on GitHub: read only.");
    assert.match(stateSentence({ state: "gone", delete_after: null }) ?? "", /No longer on GitHub/);
    assert.equal(stateSentence({ state: "active", delete_after: null }), null);
  });

  test("a hidden repository is 404, like an unknown or private one, and its name never appears", async () => {
    const ada = await signIn();
    await seed.repo(w.forge, { repoId: "404", ownerLogin: ADA_LOGIN, name: "secret-lab-notes", mode: "public", linkedBy: ada.userId });
    await w.forge.batch([updateRepo(w.forge, "memory", "404", { state: "hidden" }, T0).stmt]);
    const unknown = await ada.b.fetch("/api/forge/repo?id=memory:999");
    const unknownBody = await unknown.text();
    for (const path of ["/api/forge/repo?id=memory:404", "/api/forge/repo?path=ada-fixture/secret-lab-notes", "/api/forge/repo?path=ada-fixture/a-private-one"]) {
      const res = await ada.b.fetch(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      const text = await res.text();
      assert.equal(text, unknownBody, path);
      assert.ok(!text.includes("secret"), path);
      assert.equal(JSON.parse(text).error.code, "not_found");
    }
    // Nor in the list.
    const mine = await ada.b.fetch("/api/forge/mine");
    assert.ok(!(await mine.text()).includes("secret"));
  });

  test("pending jobs are read from a bounded tail of the jobs table: the rows returned stay bounded", async () => {
    const { b, userId } = await signIn();
    await seedEeg(userId);
    // JOBS_TAIL jobs of another repository after Eeg's: Eeg's waiting push falls out of the tail.
    for (let i = 0; i < JOBS_TAIL; i++) await seed.job(w.forge, { kind: "link", repoId: "909" }, T0 - 100 + i);
    await seed.job(w.forge, { kind: "push", repoId: "101", ref: HEAD }, T0);
    w.forge.reset();
    const res = await b.fetch("/api/forge/repo?id=memory:101");
    const layer = await body(res);
    assert.deepEqual(layer.jobs.map((j: Json) => j.createdAt), [T0]);
    assert.ok(Number(res.headers.get("X-D1-Forge-Rows-Read")) <= 12);
    assertNoScan();
  });

  test("a query naming no repository, or two, or a wrong one, is 400 in words", async () => {
    const { b } = await signIn();
    for (const q of ["", "?id=", "?id=gitlab:1", "?id=memory:", "?id=memory:1&path=a/b", "?path=a", "?path=a/b/c", "?path=../x", "?path=a/b.git", "?path=a%20b/c"]) {
      const res = await b.fetch(`/api/forge/repo${q}`);
      assert.equal(res.status, 400, q);
      const e = (await body(res)).error;
      assert.equal(e.code, "invalid", q);
      assert.match(e.message, /\?id=<forge>:<id> or \?path=<owner>\/<name>/);
    }
    const u = (q: string) => new URL(`https://registry.test/api/forge/repo${q}`);
    assert.deepEqual(parseTarget(u("?id=github:123"), "github"), { forge: "github", id: "123" });
    assert.deepEqual(parseTarget(u("?path=/Ada/eeg/"), "memory"), { forge: "memory", owner: "Ada", name: "eeg" });
    assert.equal(w.forge.totals.written, 0);
  });
});

describe("GET /api/forge/mine", () => {
  /** Ada's five repositories (and one of Bob's, one hidden), the papers of two of them. */
  async function seedMine(adaId: string): Promise<void> {
    const r = (repoId: string, name: string, mode: "created" | "installed" | "public", extra: { template?: boolean } = {}) => ({
      repoId,
      ownerLogin: ADA_LOGIN,
      name,
      mode,
      installationId: mode === "public" ? null : "9",
      linkedBy: adaId,
      ...extra,
    });
    await seed.repo(w.forge, r("1", "a-created", "created"), T0, { papers: [{ paperId: ONE, status: "linked" }, { paperId: TWO, status: "linked" }] });
    await seed.repo(w.forge, r("2", "b-installed", "installed"));
    await seed.repo(w.forge, r("3", "c-public", "public", { template: true }), T0, { papers: [{ paperId: ONE, status: "proposed" }] });
    await seed.repo(w.forge, r("4", "d-pending", "public"), T0, { state: "pending_deletion", deleteAfter: T0 + GRACE_SECONDS });
    await seed.repo(w.forge, r("5", "e-template", "created", { template: true }));
    await seed.repo(w.forge, r("6", "f-hidden", "public"), T0, { state: "hidden" });
    await seed.repo(w.forge, { repoId: "7", ownerLogin: "bob-lab", name: "a-bob", mode: "public", linkedBy: adaId });
  }
  const names = (a: Json) => a.repositories.map((x: Json) => x.name);

  test("pages by cursor, by name; the first page carries the pending deletions, the caps and the gate", async () => {
    const { b, userId } = await signIn();
    await seedMine(userId);
    await seed.action(w.forge, { userId, kind: "link", t: T0 - 3600 });
    w.db.queries.length = 0;
    w.forge.reset();

    const res1 = await b.fetch("/api/forge/mine?limit=2");
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("Cache-Control"), "no-store");
    assert.equal(rowsWritten(res1), 0);
    const p1 = await body(res1);
    assert.equal(p1.github, ADA_LOGIN);
    assert.deepEqual(p1.filters, { mode: null, template: null });
    assert.deepEqual(names(p1), ["a-created", "b-installed"]);
    assert.equal(p1.next, "b-installed");
    assert.deepEqual(p1.repositories[0], {
      forge: "memory",
      id: "1",
      owner: ADA_LOGIN,
      name: "a-created",
      url: "/r/ada-fixture/a-created/",
      mode: "created",
      state: "active",
      template: false,
      papers: 2,
      headAt: null,
      lastSeen: T0,
      deleteAfter: null,
    });
    // The pending deletions come first, with their dates, whatever page they are on.
    assert.deepEqual(p1.pending.map((x: Json) => [x.name, x.state, x.deleteAfter]), [["d-pending", "pending_deletion", T0 + GRACE_SECONDS]]);
    assert.deepEqual(p1.caps, { limits: PER_ACCOUNT_DAY, used: { actions: 1, creations: 0, links: 1, research: 0 } });
    assert.equal(p1.open, true);

    const p2 = await body(await b.fetch(`/api/forge/mine?limit=2&after=${p1.next}`));
    assert.deepEqual(names(p2), ["c-public", "d-pending"]);
    assert.equal(p2.repositories[0].papers, 1);
    assert.equal(p2.repositories[0].template, true);
    assert.equal(p2.pending, undefined);
    assert.equal(p2.caps, undefined);
    const p3 = await body(await b.fetch(`/api/forge/mine?limit=2&after=${p2.next}`));
    assert.deepEqual(names(p3), ["e-template"]);
    assert.equal(p3.next, null);
    // Hidden ones and other accounts' are never listed.
    const all = await body(await b.fetch("/api/forge/mine"));
    assert.deepEqual(names(all), ["a-created", "b-installed", "c-public", "d-pending", "e-template"]);
    assert.equal(all.next, null);
    assert.equal(w.forge.totals.written, 0);
    assertNoScan();
  });

  test("filters: mode (the mirror: qualifier adapted) and template (the template: qualifier)", async () => {
    const { b, userId } = await signIn();
    await seedMine(userId);
    const list = async (q: string) => body(await b.fetch(`/api/forge/mine?${q}`));
    assert.deepEqual(names(await list("mode=mirror")), ["b-installed", "c-public", "d-pending"]);
    assert.deepEqual(names(await list("mode=created")), ["a-created", "e-template"]);
    assert.deepEqual(names(await list("mode=installed")), ["b-installed"]);
    assert.deepEqual(names(await list("mode=public")), ["c-public", "d-pending"]);
    assert.deepEqual(names(await list("template=true")), ["c-public", "e-template"]);
    assert.deepEqual(names(await list("template=false")), ["a-created", "b-installed", "d-pending"]);
    assert.deepEqual(names(await list("mode=mirror&template=true")), ["c-public"]);
    assert.deepEqual((await list("mode=mirror&template=true")).filters, { mode: "mirror", template: true });
    // The mirror filter pages across both modes by the same cursor.
    const m1 = await list("mode=mirror&limit=2");
    assert.deepEqual(names(m1), ["b-installed", "c-public"]);
    assert.equal(m1.next, "c-public");
    const m2 = await list(`mode=mirror&limit=2&after=${m1.next}`);
    assert.deepEqual(names(m2), ["d-pending"]);
    assert.equal(m2.next, null);
    for (const q of ["mode=fork", "template=yes", "limit=0", "limit=abc", "after=../x"]) {
      const res = await b.fetch(`/api/forge/mine?${q}`);
      assert.equal(res.status, 400, q);
      assert.equal((await body(res)).error.code, "invalid", q);
    }
    assert.equal((parseMine(new URL("https://x/api/forge/mine?limit=500")) as { limit: number }).limit, 50);
    assertNoScan();
  });

  test("a reader without a GitHub account gets a sentence; the gate is closed to anyone but the owner", async () => {
    const google = w.browser();
    await google.signIn("google");
    const g = await google.fetch("/api/forge/mine");
    assert.equal(g.status, 200);
    const answer = await body(g);
    assert.equal(answer.github, null);
    assert.deepEqual(answer.repositories, []);
    assert.match(answer.sentence, /link your GitHub account/);
    assert.equal(Number(g.headers.get("X-D1-Forge-Rows-Read")), 0);

    const bob = await signIn(BOB);
    const b = await body(await bob.b.fetch("/api/forge/mine"));
    assert.equal(b.github, BOB.login);
    assert.deepEqual(b.repositories, []);
    assert.equal(b.open, false);
    w.restore();
    w = forgeWorld({ env: { FORGE_OPEN: "true" } });
    const open = await signIn(BOB);
    assert.equal((await body(await open.b.fetch("/api/forge/mine"))).open, true);
  });
});

describe("signed out", () => {
  test("401 on both routes, no-store, and a stale session's cookies cleared (guard.ts)", async () => {
    for (const path of ["/api/forge/repo?id=memory:1", "/api/forge/mine"]) {
      const fresh = w.browser();
      const res = await fresh.fetch(path);
      assert.equal(res.status, 401, path);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      assert.equal((await body(res)).error.code, "signed_out");
      assert.deepEqual(res.headers.getSetCookie(), [], "no cookie to clear");

      const stale = w.browser();
      stale.jar.set("__Host-oscr_session", "no-such-session-value");
      stale.jar.set("__Host-oscr_signed_in", "1");
      const again = await stale.fetch(path);
      assert.equal(again.status, 401, path);
      const cleared = again.headers.getSetCookie();
      assert.ok(cleared.some((c) => c.startsWith("__Host-oscr_session=;") && /Max-Age=0/.test(c)), path);
      assert.ok(cleared.some((c) => c.startsWith("__Host-oscr_signed_in=;") && /Max-Age=0/.test(c)), path);
      assert.equal(stale.cookie("__Host-oscr_signed_in"), null);
    }
    assert.ok(Object.values(forgeCounts(w.forge)).every((n) => n === 0));
    assert.equal(w.forge.totals.read, 0);
  });

  test("through the Worker: built (never 501), with or without the final /, HEAD reads like GET, personal headers", async () => {
    const ctx = { waitUntil() {} };
    for (const path of ["/api/forge/repo", "/api/forge/mine"]) {
      for (const p of [path, `${path}/`]) {
        for (const method of ["GET", "HEAD"]) {
          const res = await worker.fetch(new Request(new URL(p, ORIGIN), { method }), w.env, ctx);
          assert.equal(res.status, 401, `${method} ${p}`);
          assert.equal(res.headers.get("Cache-Control"), "no-store", p);
          assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", p);
          if (method === "GET") assert.equal((await body(res)).error.code, "signed_out", p);
        }
      }
    }
    // Signed in: the repository route without a query is 400 in words, the list answers.
    const { b } = await signIn();
    assert.equal((await b.fetch("/api/forge/repo")).status, 400);
    assert.equal((await b.fetch("/api/forge/mine/")).status, 200);
    assert.equal(w.forge.totals.written, 0);
  });
});

describe("the /repositories/ page", () => {
  const script = readFileSync(new URL("../../src/scripts/repositories.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../src/pages/repositories.astro", import.meta.url), "utf8");

  test("no request without the hint cookie: the script's decision, and its guard before its only fetch", () => {
    assert.equal(shouldAsk(""), false);
    assert.equal(shouldAsk("__Host-oscr_signed_in="), false);
    assert.equal(shouldAsk("other=1"), false);
    assert.equal(shouldAsk("x__Host-oscr_signed_in=1"), false);
    assert.equal(shouldAsk(HINT), true);
    assert.equal(shouldAsk("theme=light; __Host-oscr_signed_in=1; b=2"), true);
    // One request in the whole script, after the guard.
    assert.equal(script.match(/\bfetch\(/g)?.length, 1);
    const guard = script.indexOf("if (!shouldAsk(document.cookie)) return signedOut();");
    assert.ok(guard > 0 && guard < script.indexOf("await fetch("));
    // The page's own part never runs outside a browser.
    assert.match(script, /if \(typeof document !== "undefined"\) page\(\);\s*$/);
  });

  test("the script's addresses and words", () => {
    assert.equal(mineUrl({}), "/api/forge/mine");
    assert.equal(mineUrl({ mode: "mirror", template: "true" }, "c-public"), "/api/forge/mine?mode=mirror&template=true&after=c-public");
    assert.equal(mineUrl({ mode: "fork", template: "maybe" }), "/api/forge/mine");
    assert.equal(day(T0 + GRACE_SECONDS), "2026-10-28");
    assert.deepEqual(stateWords({ state: "pending_deletion", deleteAfter: T0 + GRACE_SECONDS }), {
      text: "waiting for deletion: it leaves the registry after 2026-10-28",
      tone: "warning",
    });
    assert.deepEqual(stateWords({ state: "active", deleteAfter: null }), { text: "active", tone: "ok" });
    assert.match(modeWords("public"), /without the App/);
    const link = restoreLink({ owner: "ada-fixture", name: "old-analysis" });
    assert.equal(link.href, "/r/ada-fixture/old-analysis/settings/");
    assert.match(link.text, /one authorization on GitHub cancels the deletion/);
  });

  test("the page: its links, the sign-in, the script as a file, science.css only, no platform name", () => {
    for (const href of ['href="/new/"', 'href="/new/link/"', 'href="/new/import/"', 'href="/api/auth/github/start?return=/repositories/"', 'href="/account/"']) {
      assert.ok(page.includes(href), href);
    }
    assert.match(page, /<script>\s*import "..\/scripts\/repositories";\s*<\/script>/);
    assert.doesNotMatch(page, /<style|style=/);
    assert.doesNotMatch(page.replace(/^---[\s\S]*?---/, ""), /OSCR/);
    assert.match(page, /class="listing"/);
    assert.match(page, /class="danger"/);
    assert.match(page, /class="limits"/);
    for (const id of ["repos-signed-out", "repos-signed-in", "repos-list", "repos-pending-list", "repos-more", "repos-filter", "repos-mode", "repos-template", "repos-caps"]) {
      assert.ok(page.includes(`id="${id}"`), id);
      assert.ok(script.includes(`"${id}"`), id);
    }
  });
});
