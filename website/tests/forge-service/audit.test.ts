// The organization audit log and the security overview (night phase 09, E3): every org-scoped write
// leaves one audit row; an owner or a moderator reads it with filters, a text search and a CSV export;
// a non-manager is refused; the security overview aggregates phase 11's open alerts over pinned
// repositories.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { githubId, signIn } from "./authorize.ts";
import { forgeWorld, T0, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true", ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

describe("the audit log", () => {
  test("every write leaves an audit row; filters, search and CSV; a non-manager is refused", async () => {
    const ada = await signIn(w, "ada-fixture");
    const bob = await signIn(w, "bob");
    const id = (await body(await ada.post("/api/forge/org/create", { handle: "eeg-lab" }))).org.id;
    const inviteId = (await body(await ada.post("/api/forge/org/members", { id, op: "invite", githubId: githubId(w, "bob") }))).inviteId;
    await bob.post("/api/forge/org/members", { id, op: "accept", inviteId });

    const log = await body(await ada.fetch(`/api/forge/org/audit?id=${id}`));
    const events = log.events.map((e: Json) => e.event);
    assert.ok(events.includes("org.create") && events.includes("member.invite") && events.includes("member.join"));
    // Newest first.
    assert.ok(log.events[0].at >= log.events[log.events.length - 1].at);

    // Filter by event.
    const invites = await body(await ada.fetch(`/api/forge/org/audit?id=${id}&event=member.invite`));
    assert.equal(invites.events.length, 1);
    // Text search over the target/event.
    const search = await body(await ada.fetch(`/api/forge/org/audit?id=${id}&q=create`));
    assert.equal(search.events.every((e: Json) => /create/i.test(e.event) || /create/i.test(e.target)), true);
    assert.ok(search.events.length >= 1);

    // CSV export.
    const csv = await ada.fetch(`/api/forge/org/audit?id=${id}&format=csv`);
    assert.equal(csv.headers.get("Content-Type")?.startsWith("text/csv"), true);
    assert.ok((await csv.text()).startsWith("at,event,actor,target,detail"));

    // A non-member cannot read the audit.
    const carol = await signIn(w, "carol");
    assert.equal((await carol.fetch(`/api/forge/org/audit?id=${id}`)).status, 403);
    // A moderator can.
    await ada.post("/api/forge/org/members", { id, op: "set_role", githubId: githubId(w, "bob"), role: "moderator" });
    assert.equal((await bob.fetch(`/api/forge/org/audit?id=${id}`)).status, 200);
    assert.deepEqual(w.forge.scans, []);
  });

  test("filter by actor's handle; an unknown actor is an empty page, never the whole log", async () => {
    const ada = await signIn(w, "ada-fixture");
    const id = (await body(await ada.post("/api/forge/org/create", { handle: "lab-a" }))).org.id;
    const byAda = await body(await ada.fetch(`/api/forge/org/audit?id=${id}&actor=ada-fixture`));
    assert.ok(byAda.events.length >= 1);
    const byNobody = await body(await ada.fetch(`/api/forge/org/audit?id=${id}&actor=nobody-here`));
    assert.equal(byNobody.events.length, 0);
  });
});

describe("the security overview", () => {
  test("aggregates open phase 11 alerts over the pinned repositories, dismissed excluded", async () => {
    const ada = await signIn(w, "ada-fixture");
    const id = (await body(await ada.post("/api/forge/org/create", { handle: "sec-lab" }))).org.id;
    // Seed two alerts on a memory repository (as the Mac's facts push would), one dismissed.
    const sql = w.forge.sqlite;
    const ins = sql.prepare("INSERT INTO security_alerts (forge, repo_id, kind, ref, severity, found_at, updated_at) VALUES ('memory', '101', ?, ?, ?, ?, ?)");
    ins.run("osv", "GHSA-1", "critical", T0, T0);
    ins.run("osv", "GHSA-2", "low", T0, T0);
    sql.prepare("INSERT INTO alert_triage (forge, repo_id, kind, ref, state, updated_at) VALUES ('memory', '101', 'osv', 'GHSA-2', 'dismissed', ?)").run(T0);

    await ada.post("/api/forge/org/update", { id, op: "settings", patch: { pinned: ["101"] } });
    const overview = await body(await ada.fetch(`/api/forge/org/security?id=${id}&forge=memory`));
    assert.equal(overview.pinnedCount, 1);
    assert.equal(overview.totals.open, 1);
    assert.equal(overview.totals.critical, 1);
    assert.equal(overview.totals.dismissed, 1);
    assert.equal(overview.repos[0].bySeverity.critical, 1);
    assert.deepEqual(w.forge.scans, []);
  });
});
