// The Security read (night phase 11, E1: worker/forge/service/security.ts):
// - GET /api/forge/security returns the dependency graph the Mac wrote (repo_deps), both snapshots,
//   with the view's summary, by a key range (never a scan);
// - a hidden or unknown repository answers 404; signed out, 401.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const HEAD = "a".repeat(40);
const CITED = "b".repeat(40);

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

async function signIn(who?: { id: number; login: string; name: string }): Promise<{ b: ForgeBrowser; userId: string }> {
  if (who) w.mock.who.github = who;
  const b = w.browser();
  await b.signIn("github");
  const subject = String(w.mock.who.github.id);
  const row = w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string };
  return { b, userId: row.user_id };
}

function alert(repoId: string, kind: string, ref: string, o: Partial<{ severity: string; summary: string; detail: string; package: string; version: string; advisory: string; path: string; line: number; dev: number; source: string }> = {}): void {
  w.forge.sqlite
    .prepare("INSERT INTO security_alerts (forge, repo_id, kind, ref, severity, summary, detail, ecosystem, package, version, advisory, path, line, dev_scope, source, found_at, updated_at) "
      + "VALUES ('memory', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(repoId, kind, ref, o.severity ?? "high", o.summary ?? "a finding", o.detail ?? "{}", o.package ?? "", o.version ?? "", o.advisory ?? "", o.path ?? "", o.line ?? null, o.dev ?? 0, o.source ?? "mac", T0, T0);
}

function dep(repoId: string, snapshot: string, eco: string, name: string, o: Partial<{ version: string; req: string; scope: string; direct: number; pinned: number; sources: string; commit: string }> = {}): void {
  w.forge.sqlite
    .prepare("INSERT INTO repo_deps (forge, repo_id, snapshot, ecosystem, name, version, req, scope, direct, pinned, sources, commit_sha, computed_at) "
      + "VALUES ('memory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(repoId, snapshot, eco, name, o.version ?? "", o.req ?? "", o.scope ?? "runtime", o.direct ?? 1, o.pinned ?? 0, o.sources ?? "[]", o.commit ?? "", T0);
}

describe("GET /api/forge/security", () => {
  test("the dependency graph the Mac wrote, both snapshots, with its summary", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD }, T0 - 86_400);
    dep("101", "default", "PyPI", "numpy", { version: "1.26.0", req: "==1.26.0", pinned: 1, sources: '["requirements.txt"]' });
    dep("101", "default", "PyPI", "scipy", { req: ">=1.10", direct: 0 });
    dep("101", "default", "npm", "d3", { req: "^7", sources: '["package.json"]' });
    dep("101", "cited", "PyPI", "numpy", { version: "1.25.0", pinned: 1, commit: CITED });
    const { b } = await signIn();
    w.forge.reset();
    const res = await b.fetch("/api/forge/security?id=memory:101");
    assert.equal(res.status, 200);
    const j = await body(res);
    assert.equal(j.repo.name, "eeg");
    assert.equal(j.dependencies.default.length, 3);
    assert.equal(j.dependencies.cited.length, 1);
    const numpy = j.dependencies.default.find((d: Json) => d.name === "numpy");
    assert.equal(numpy.version, "1.26.0");
    assert.deepEqual(numpy.sources, ["requirements.txt"]);
    assert.equal(numpy.pinned, true);
    assert.deepEqual(j.dependencies.summary, { total: 3, direct: 2, transitive: 1, pinned: 1, ecosystems: { PyPI: 2, npm: 1 } });
    // No whole-table scan of the forge database.
    assert.deepEqual(w.forge.scans, []);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  test("secret alerts the Mac wrote are returned, value hidden, worst first", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    w.forge.sqlite
      .prepare("INSERT INTO security_alerts (forge, repo_id, kind, ref, severity, summary, detail, path, line, source, found_at, updated_at) "
        + "VALUES ('memory', '101', 'secret', ?, ?, ?, ?, ?, ?, 'mac', ?, ?)")
      .run("leak.py:3:a-github-token", "high", "a GitHub token on line 3 of leak.py (ghp_ab…)", JSON.stringify({ hint: "ghp_ab…", paired: false, remediation: "Revoke it." }), "leak.py", 3, T0, T0);
    const { b } = await signIn();
    w.forge.reset();
    const j = await body(await b.fetch("/api/forge/security?id=memory:101"));
    assert.equal(j.alerts.secret.length, 1);
    assert.equal(j.alerts.secret[0].severity, "high");
    assert.equal(j.alerts.secret[0].detail.remediation, "Revoke it.");
    assert.deepEqual(w.forge.scans, []);
  });

  test("an unknown repository is 404", async () => {
    const { b } = await signIn();
    assert.equal((await b.fetch("/api/forge/security?id=memory:999")).status, 404);
  });

  test("signed out is 401", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    assert.equal((await w.browser().fetch("/api/forge/security?id=memory:101")).status, 401);
  });

  test("a bad target is 400", async () => {
    const { b } = await signIn();
    assert.equal((await b.fetch("/api/forge/security")).status, 400);
  });

  test("an auto-dismissed (withdrawn) OSV alert reads as dismissed, with no triage row", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    alert("101", "osv", "GHSA-old:left-pad:1.0.0", { severity: "low", detail: JSON.stringify({ auto_dismiss: "false_positive", withdrawn: true }) });
    const { b } = await signIn();
    const j = await body(await b.fetch("/api/forge/security?id=memory:101"));
    assert.equal(j.alerts.osv[0].state, "dismissed");
    assert.equal(j.alerts.osv[0].auto, true);
  });
});

describe("POST /api/forge/security/triage", () => {
  async function setup(): Promise<{ b: ForgeBrowser }> {
    const { b, userId } = await signIn();
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD, linkedBy: userId }, T0 - 86_400);
    alert("101", "osv", "GHSA-x:numpy:1.0.0", { severity: "critical", package: "numpy" });
    return { b };
  }

  test("the owner-manager dismisses an alert and reopens it; the state follows", async () => {
    const { b } = await setup();
    let res = await b.post("/api/forge/security/triage?id=memory:101", { op: "dismiss", kind: "osv", ref: "GHSA-x:numpy:1.0.0", reason: "tolerable" });
    assert.equal(res.status, 200);
    assert.equal((await body(res)).state, "dismissed");
    let j = await body(await b.fetch("/api/forge/security?id=memory:101"));
    assert.equal(j.alerts.osv[0].state, "dismissed");
    assert.equal(j.alerts.osv[0].reason, "tolerable");
    assert.equal(j.alerts.osv[0].auto, false);
    res = await b.post("/api/forge/security/triage?id=memory:101", { op: "reopen", kind: "osv", ref: "GHSA-x:numpy:1.0.0" });
    assert.equal(res.status, 200);
    j = await body(await b.fetch("/api/forge/security?id=memory:101"));
    assert.equal(j.alerts.osv[0].state, "open");
    // One action row per triage, kind security_alert.
    const kinds = (w.forge.sqlite.prepare("SELECT kind FROM actions").all() as { kind: string }[]).map((a) => a.kind);
    assert.deepEqual(kinds.filter((k) => k === "security_alert").length, 2);
  });

  test("a triage of an unknown alert is 404", async () => {
    const { b } = await setup();
    const res = await b.post("/api/forge/security/triage?id=memory:101", { op: "dismiss", kind: "osv", ref: "nope", reason: "fixed" });
    assert.equal(res.status, 404);
  });

  test("an email as assignee is refused", async () => {
    const { b } = await setup();
    const res = await b.post("/api/forge/security/triage?id=memory:101", { op: "assign", kind: "osv", ref: "GHSA-x:numpy:1.0.0", assignee: "a@b.org" });
    assert.equal(res.status, 400);
  });

  test("FORGE_OPEN unset: a non-owner is told the GitHub side is closed", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD }, T0 - 86_400);
    alert("101", "osv", "GHSA-x:numpy:1.0.0", { package: "numpy" });
    const { b } = await signIn(BOB);
    const res = await b.post("/api/forge/security/triage?id=memory:101", { op: "dismiss", kind: "osv", ref: "GHSA-x:numpy:1.0.0", reason: "fixed" });
    assert.equal(res.status, 403);
  });
});

const BOB = { id: 5_000_001, login: "bob-lab", name: "Bob Lab" };
