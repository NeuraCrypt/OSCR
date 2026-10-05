// Membership, roles, research permissions and teams (night phase 09, E2): the owner invites, a
// member accepts and sets their visibility, research permissions are set and read, the last owner is
// protected, removal returns the leaving checklist, teams are made, and the member list exports as CSV.
// An invitation names a person who already has an OSCR account (signed in at least once): the owner
// invites by their GitHub id, ORCID iD or OSCR user id, each a key lookup.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { githubId, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  // Open, so a non-owner (Bob) may accept an invitation and act on his own membership.
  w = forgeWorld({ env: { FORGE_OPEN: "true", ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

/** Ada (the owner) with a fresh organization, and Bob and Carol signed in so they have accounts. */
async function setup(handle = "eeg-lab", extra: Json = {}) {
  const ada = await signIn(w, "ada-fixture");
  const bob = await signIn(w, "bob");
  const carol = await signIn(w, "carol");
  const id = (await body(await ada.post("/api/forge/org/create", { handle, ...extra }))).org.id;
  return { ada, bob, carol, id };
}

async function invite(ada: Awaited<ReturnType<typeof signIn>>, id: string, login: string, extra: Json = {}): Promise<string> {
  const r = await body(await ada.post("/api/forge/org/members", { id, op: "invite", githubId: githubId(w, login), ...extra }));
  return r.inviteId as string;
}

describe("membership and roles", () => {
  test("invite by GitHub id, accept, the member joins with the invited role and perms", async () => {
    const { ada, bob, id } = await setup();
    const inviteId = await invite(ada, id, "bob", { role: "moderator", perms: ["validate_map", "nope", "validate_map"] });
    assert.equal(typeof inviteId, "string");
    assert.equal(forgeRows(w.forge, "org_invitations").length, 1);

    const accepted = await body(await bob.post("/api/forge/org/members", { id, op: "accept", inviteId }));
    assert.equal(accepted.joined, true);
    const seen = await body(await bob.fetch(`/api/forge/org?id=${id}`));
    assert.equal(seen.viewer.member.role, "moderator");
    assert.deepEqual(seen.viewer.member.perms, ["validate_map"]);
    assert.equal(seen.memberCount, 2);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a wrong invitee cannot accept; an expired invitation is refused", async () => {
    const { ada, bob, carol, id } = await setup("brain-lab");
    const inviteId = await invite(ada, id, "bob", { days: 1 });
    const notYours = await carol.post("/api/forge/org/members", { id, op: "accept", inviteId });
    assert.equal(notYours.status, 403);
    w.advance(2 * 86_400);
    const expired = await bob.post("/api/forge/org/members", { id, op: "accept", inviteId });
    assert.equal(expired.status, 410);
  });

  test("set_perms and set_role by the owner; the last owner is protected", async () => {
    const { ada, bob, id } = await setup("lab-x");
    const inviteId = await invite(ada, id, "bob");
    await bob.post("/api/forge/org/members", { id, op: "accept", inviteId });

    await ada.post("/api/forge/org/members", { id, op: "set_perms", githubId: githubId(w, "bob"), perms: ["propose_map", "flag_map"] });
    const seen = await body(await bob.fetch(`/api/forge/org?id=${id}`));
    assert.deepEqual(seen.viewer.member.perms, ["propose_map", "flag_map"]);

    const lastOwner = await ada.post("/api/forge/org/members", { id, op: "leave" });
    assert.equal(lastOwner.status, 409);
    await ada.post("/api/forge/org/members", { id, op: "set_role", githubId: githubId(w, "bob"), role: "owner" });
    const left = await body(await ada.post("/api/forge/org/members", { id, op: "leave" }));
    assert.ok(Array.isArray(left.checklist) && left.checklist.length >= 3);
    assert.deepEqual(w.forge.scans, []);
  });

  test("remove a member returns the leaving checklist; a non-manager cannot", async () => {
    const { ada, bob, id } = await setup("lab-y");
    const inviteId = await invite(ada, id, "bob");
    await bob.post("/api/forge/org/members", { id, op: "accept", inviteId });
    const denied = await bob.post("/api/forge/org/members", { id, op: "remove", githubId: githubId(w, "ada-fixture") });
    assert.equal(denied.status, 403);
    const removed = await body(await ada.post("/api/forge/org/members", { id, op: "remove", githubId: githubId(w, "bob") }));
    assert.ok(Array.isArray(removed.checklist));
    assert.equal((await body(await ada.fetch(`/api/forge/org?id=${id}`))).memberCount, 1);
  });

  test("a member sets their own visibility; a private member is hidden from a non-member", async () => {
    const { ada, bob, carol, id } = await setup("vis-lab");
    const inviteId = await invite(ada, id, "bob");
    await bob.post("/api/forge/org/members", { id, op: "accept", inviteId });
    await bob.post("/api/forge/org/members", { id, op: "set_visibility", private: true });
    const seen = await body(await carol.fetch(`/api/forge/org?id=${id}`));
    assert.equal(seen.members.some((m: Json) => m.private), false);
    assert.equal(seen.members.length, 1); // only Ada (public)
  });
});

describe("teams and export", () => {
  test("a team is made, a member added, and a non-member cannot be added", async () => {
    const { ada, bob, id } = await setup("team-lab");
    const inviteId = await invite(ada, id, "bob");
    await bob.post("/api/forge/org/members", { id, op: "accept", inviteId });

    assert.equal((await ada.post("/api/forge/org/teams", { id, op: "create", teamId: "analysis", name: "Analysis", visibility: "visible" })).status, 201);
    // Carol has an account but is not a member of the organization: she cannot be put in a team.
    const notMember = await ada.post("/api/forge/org/teams", { id, op: "member", teamId: "analysis", githubId: githubId(w, "carol") });
    assert.equal(notMember.status, 409);
    assert.equal((await ada.post("/api/forge/org/teams", { id, op: "member", teamId: "analysis", githubId: githubId(w, "bob"), teamRole: "maintainer" })).status, 200);
    assert.equal(forgeRows(w.forge, "team_members").length, 1);
    assert.deepEqual(w.forge.scans, []);
  });

  test("the member list exports as CSV to a member, and is refused to a non-member", async () => {
    const { ada, carol, id } = await setup("csv-lab");
    const csv = await ada.fetch(`/api/forge/org?id=${id}&export=members`);
    assert.equal(csv.headers.get("Content-Type")?.startsWith("text/csv"), true);
    const text = await csv.text();
    assert.ok(text.startsWith("handle,role,research_permissions,private"));
    assert.equal((await carol.fetch(`/api/forge/org?id=${id}&export=members`)).status, 403);
  });
});
