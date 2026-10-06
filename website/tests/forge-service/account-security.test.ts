// Account security (night phase 09, E4): a person lists their sessions and revokes one or all the
// others (a true delete of the row), lists their identities and unlinks one (never the last), reads
// their personal security log and exports it. Not gated by FORGE_OPEN: a person's own account.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, T0, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

async function userId(): Promise<string> {
  const subject = String(w.mock.who.github.id);
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
}

describe("sessions", () => {
  test("list two sessions, revoke the other; the revoked session no longer works", async () => {
    const a1 = await signIn(w, "ada-fixture");
    const a2 = await signIn(w, "ada-fixture"); // a second browser, a second session for the same account

    const view = await body(await a1.fetch("/api/forge/account/security"));
    assert.equal(view.sessions.length, 2);
    assert.equal(view.sessions.filter((x: Json) => x.current).length, 1);
    const other = view.sessions.find((x: Json) => !x.current);

    const revoked = await body(await a1.post("/api/forge/account/sessions", { op: "revoke", idHash: other.ref }));
    assert.equal(revoked.ok, true);
    assert.equal(revoked.wasCurrent, false);
    // a2's session is gone: it is signed out now.
    assert.equal((await a2.fetch("/api/forge/account/security")).status, 401);
    // One session left, and a security-log row plus its action row were written.
    assert.equal(forgeRows(w.forge, "security_log").length, 1);
    assert.equal((forgeRows(w.forge, "security_log")[0] as Json).event, "session.revoke");
    assert.deepEqual(w.forge.scans, []);
  });

  test("revoke_others keeps the current session, ends the rest", async () => {
    const a1 = await signIn(w, "ada-fixture");
    await signIn(w, "ada-fixture");
    await signIn(w, "ada-fixture");
    const out = await body(await a1.post("/api/forge/account/sessions", { op: "revoke_others" }));
    assert.equal(out.revoked, 2);
    const view = await body(await a1.fetch("/api/forge/account/security"));
    assert.equal(view.sessions.length, 1);
    assert.equal(view.sessions[0].current, true);
  });
});

describe("identities and the security log", () => {
  test("the last identity cannot be unlinked; with two, one can; the log records it and exports", async () => {
    const ada = await signIn(w, "ada-fixture");
    // Only a GitHub identity so far: it cannot be unlinked.
    const refused = await ada.post("/api/forge/account/identities", { op: "unlink", provider: "github" });
    assert.equal(refused.status, 409);

    // Link a second identity (an ORCID iD) directly, as a real sign-in with ORCID would.
    const uid = await userId();
    w.db.sqlite.prepare("INSERT INTO identities (provider, subject, user_id, linked_at) VALUES ('orcid', '0000-0002-1825-0097', ?, ?)").run(uid, T0);
    w.db.sqlite.prepare("UPDATE users SET orcid = '0000-0002-1825-0097' WHERE id = ?").run(uid);

    const view = await body(await ada.fetch("/api/forge/account/security"));
    assert.equal(view.identities.length, 2);
    assert.equal(view.sudo.active, false);

    const unlinked = await body(await ada.post("/api/forge/account/identities", { op: "unlink", provider: "github" }));
    assert.equal(unlinked.unlinked, "github");
    assert.equal((await body(await ada.fetch("/api/forge/account/security"))).identities.length, 1);

    // The security log holds both the identity unlink and nothing else; export is CSV.
    const log = forgeRows(w.forge, "security_log");
    assert.ok(log.some((row) => (row as Json).event === "identity.unlink"));
    const csv = await ada.fetch("/api/forge/account/security?format=csv");
    assert.equal(csv.headers.get("Content-Type")?.startsWith("text/csv"), true);
    assert.ok((await csv.text()).startsWith("at,event,detail"));
    assert.deepEqual(w.forge.scans, []);
  });
});
