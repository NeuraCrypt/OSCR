// Private vulnerability reporting (night phase 11, E5: worker/forge/service/advisory.ts): an advisory
// is opened, discussed in a private thread, published or withdrawn by the maintainers; it is private
// to its reporter and the maintainers until published; it never leaks to a non-collaborator.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const HEAD = "a".repeat(40);
const BOB = { id: 5_000_001, login: "bob-lab", name: "Bob Lab" };
const CAROL = { id: 5_000_002, login: "carol", name: "Carol" };

let w: ForgeWorld;
beforeEach(() => { w = forgeWorld({ env: { FORGE_OPEN: "true" } }); });
afterEach(() => w.restore());

async function signIn(who?: { id: number; login: string; name: string }): Promise<{ b: ForgeBrowser; userId: string }> {
  if (who) w.mock.who.github = who;
  const b = w.browser();
  await b.signIn("github");
  const subject = String(w.mock.who.github.id);
  const row = w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string };
  return { b, userId: row.user_id };
}

describe("private vulnerability reporting", () => {
  test("a report is opened, discussed, published; it is private until then", async () => {
    // Ada manages the repository (she linked it).
    const adaWho = w.mock.who.github;
    const ada = await signIn();
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD, linkedBy: ada.userId }, T0 - 86_400);
    // Bob reports a vulnerability privately.
    const bob = await signIn(BOB);
    const open = await bob.b.post("/api/forge/advisory/open?id=memory:101", { title: "Path traversal in the loader", severity: "high", summary: "A crafted path escapes the sandbox.", affected: "< 2.0" });
    assert.equal(open.status, 201);
    const ref = (await body(open)).ref as string;
    // Bob sees his own report; a stranger (Carol) does not.
    assert.equal((await (await signIn(CAROL)).b.fetch(`/api/forge/advisory?id=memory:101&ref=${ref}`)).status, 403);
    // Ada (a manager) sees it and posts in the private thread.
    const adaB = (await signIn(adaWho)).b;
    assert.equal((await adaB.fetch(`/api/forge/advisory?id=memory:101&ref=${ref}`)).status, 200);
    assert.equal((await adaB.post("/api/forge/advisory/post?id=memory:101", { ref, body: "Thanks, confirmed." })).status, 201);
    // Ada drafts (update), then publishes.
    assert.equal((await adaB.post("/api/forge/advisory/edit?id=memory:101", { ref, op: "update", severity: "critical", cve: "CVE-2026-0001" })).status, 200);
    assert.equal((await adaB.post("/api/forge/advisory/edit?id=memory:101", { ref, op: "publish" })).status, 200);
    // Now Carol, a stranger, may read the published advisory.
    const carol = (await signIn(CAROL)).b;
    const seen = await body(await carol.fetch(`/api/forge/advisory?id=memory:101&ref=${ref}`));
    assert.equal(seen.advisory.state, "published");
    assert.equal(seen.advisory.severity, "critical");
    assert.equal(seen.advisory.cve, "CVE-2026-0001");
    // It never left to a public output: these tables hold it alone (no index, no feed, no event).
    const events = (w.forge.sqlite.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;
    assert.equal(events, 0);
  });

  test("a non-manager cannot publish; a stranger cannot post", async () => {
    const ada = await signIn();
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD, linkedBy: ada.userId }, T0 - 86_400);
    const bob = await signIn(BOB);
    const ref = (await body(await bob.b.post("/api/forge/advisory/open?id=memory:101", { title: "x" }))).ref as string;
    // Bob (the reporter, not a manager) cannot publish.
    assert.equal((await bob.b.post("/api/forge/advisory/edit?id=memory:101", { ref, op: "publish" })).status, 403);
    // Carol (a stranger) cannot post in the thread.
    const carol = (await signIn(CAROL)).b;
    assert.equal((await carol.post("/api/forge/advisory/post?id=memory:101", { ref, body: "hi" })).status, 403);
  });

  test("the list shows only what the reader may see; the title masks an address", async () => {
    const ada = await signIn();
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD, linkedBy: ada.userId }, T0 - 86_400);
    const bob = await signIn(BOB);
    await bob.b.post("/api/forge/advisory/open?id=memory:101", { title: "report me at admin@example.org", summary: "x" });
    // Carol sees none (nothing published, she is neither reporter nor manager).
    const carol = await body(await (await signIn(CAROL)).b.fetch("/api/forge/advisory?id=memory:101"));
    assert.equal(carol.advisories.length, 0);
    // Bob sees his own; the address is masked.
    const his = await body(await bob.b.fetch("/api/forge/advisory?id=memory:101"));
    assert.equal(his.advisories.length, 1);
    assert.doesNotMatch(his.advisories[0].title, /admin@example\.org/);
  });

  test("FORGE_OPEN unset: a non-owner cannot open a report", async () => {
    delete w.env.FORGE_OPEN;
    const ada = await signIn();
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD, linkedBy: ada.userId }, T0 - 86_400);
    const bob = (await signIn(BOB)).b;
    assert.equal((await bob.post("/api/forge/advisory/open?id=memory:101", { title: "x" })).status, 403);
  });
});
