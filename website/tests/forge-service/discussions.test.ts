// Discussions, the routes (night phase 06, E2; discussions.ts): OSCR's own discussion spaces, read
// and written for a signed-in reader. A space is made on its first discussion; the author's role is
// recorded; texts lose their addresses; FORGE_OPEN gates the writes; the human check guards a new
// discussion and comment; a locked discussion takes comments from maintainers only; a maintainer
// hides a comment and it is gone for others; upvotes and poll votes are counted once; the reads go by
// key. The gate and the public-free-text protections follow the research issues' (research.test.ts).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true", ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

const PAPER = "doi:10.1234/eeg.2026";
const SPACE = `paper:${PAPER}`;

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

async function userId(): Promise<string> {
  const subject = String(w.mock.who.github.id);
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
}
function role(uid: string, r: string, kind: string, id: string): void {
  w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, 'system', ?)").run(uid, r, kind, id, T0);
}
const open = (b: ForgeBrowser, p: Record<string, unknown>) => b.post("/api/forge/discussions/open", p);

describe("opening a discussion", () => {
  test("a verified author opens on a paper: the space is made, the role recorded, the address masked", async () => {
    const b = await signIn(w);
    role(await userId(), "verified_author", "paper", PAPER);
    w.forge.reset();
    const res = await open(b, { space: SPACE, category: "q-a", title: "Why figure 2?", body: "Write me at ada@example.org" });
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    const made = await body(res);
    assert.equal(made.id, 1);
    assert.equal(made.page, "/discussions/1");
    // The space row, the discussion, its index entry, the action row.
    assert.equal(w.forge.totals.written, 4);
    const [space] = forgeRows(w.forge, "discussion_spaces");
    assert.equal(space.space, SPACE);
    const [row] = forgeRows(w.forge, "discussions");
    assert.equal(row.space, SPACE);
    assert.equal(row.format, "qa");
    assert.equal(row.author_role, "verified_author");
    assert.match(String(row.body), /\[email hidden\]/);
    assert.ok(!JSON.stringify(forgeRows(w.forge, "discussions")).includes("ada@example.org"));
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.kind, "discussion_open");
    assert.equal(action.rows, 4);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a second discussion in the same space adds 3 rows (the space is there)", async () => {
    const b = await signIn(w);
    await open(b, { space: SPACE, title: "First" });
    w.forge.reset();
    await open(b, { space: SPACE, title: "Second" });
    assert.equal(w.forge.totals.written, 3);
    assert.equal(forgeRows(w.forge, "discussion_spaces").length, 1);
  });

  test("an unknown category is refused; an announcement needs the maintain role", async () => {
    const b = await signIn(w);
    assert.equal((await open(b, { space: SPACE, category: "nope", title: "x" })).status, 400);
    // Ada is the registry's owner here, but not the paper's author and not a moderator: no maintain.
    assert.equal((await open(b, { space: SPACE, category: "announcements", title: "x" })).status, 403);
    role(await userId(), "verified_author", "paper", PAPER);
    assert.equal((await open(b, { space: SPACE, category: "announcements", title: "x" })).status, 201);
  });

  test("a discussion on an unknown repository is refused", async () => {
    const b = await signIn(w);
    assert.equal((await open(b, { space: "repo:memory:999", title: "x" })).status, 404);
  });

  test("the human check must pass (the always-failing secret refuses the form)", async () => {
    const w2 = forgeWorld({ env: { FORGE_OPEN: "true", TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA" } });
    const b = await signIn(w2);
    const res = await b.post("/api/forge/discussions/open", { space: SPACE, title: "x" });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "human_check");
    w2.restore();
  });
});

describe("comments, answers, moderation", () => {
  async function openOne(b: ForgeBrowser, p: Record<string, unknown> = {}): Promise<number> {
    const res = await open(b, { space: SPACE, category: "q-a", title: "Q", body: "b", ...p });
    return (await body(res)).id as number;
  }

  test("a comment, an upvote counted once, the answer marked by a maintainer", async () => {
    const b = await signIn(w);
    role(await userId(), "verified_author", "paper", PAPER);
    const id = await openOne(b);
    const c = await b.post("/api/forge/discussions/comment", { id, body: "An answer with mail ada@example.org" });
    assert.equal(c.status, 201);
    const [comment] = forgeRows(w.forge, "discussion_comments");
    assert.match(String(comment.body), /\[email hidden\]/);
    // Upvote the comment, twice: the second is a no-op (counted once).
    assert.equal((await b.post("/api/forge/discussions/vote", { id, n: 1 })).status, 200);
    assert.equal((await body(await b.post("/api/forge/discussions/vote", { id, n: 1 }))).unchanged, true);
    assert.equal((forgeRows(w.forge, "discussion_comments")[0] as { upvotes: number }).upvotes, 1);
    // Mark the answer (a maintainer).
    assert.equal((await b.post("/api/forge/discussions/edit", { id, answered: 1 })).status, 200);
    assert.equal((forgeRows(w.forge, "discussions")[0] as { answered: number }).answered, 1);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a maintainer hides a comment; its body is gone for another reader, kept for the owner", async () => {
    const author = await signIn(w);
    role(await userId(), "verified_author", "paper", PAPER);
    const id = await openOne(author);
    await author.post("/api/forge/discussions/comment", { id, body: "secret words" });
    assert.equal((await author.post("/api/forge/discussions/comment", { id, n: 1, hide: "spam" })).status, 200);
    // Bob, another reader, signs in: the comment's body is withheld.
    const bob = await signIn(w, "bob");
    const seen = await body(await bob.fetch(`/api/forge/discussions?id=${id}`));
    const hidden = seen.comments.find((c: Json) => c.n === 1);
    assert.equal(hidden.body, "");
    assert.equal(hidden.moderated, "spam");
    // Ada (the registry owner) still reads it.
    const asOwner = await body(await author.fetch(`/api/forge/discussions?id=${id}`));
    assert.equal(asOwner.comments.find((c: Json) => c.n === 1).body, "secret words");
  });

  test("a locked discussion takes comments from maintainers only", async () => {
    const ada = await signIn(w);
    role(await userId(), "verified_author", "paper", PAPER);
    const id = await openOne(ada);
    assert.equal((await ada.post("/api/forge/discussions/edit", { id, locked: true, lockReason: "too heated" })).status, 200);
    // Bob (signed in, not a maintainer) cannot comment; here FORGE_OPEN is true, so the gate is open.
    const bob = await signIn(w, "bob");
    const res = await bob.post("/api/forge/discussions/comment", { id, body: "let me in" });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "locked");
  });
});

describe("polls and upvotes", () => {
  test("a poll is opened in the Polls category, voted once, the choice changed, the vote taken back", async () => {
    const b = await signIn(w);
    const made = await body(await open(b, { space: SPACE, category: "polls", title: "Pick one", pollOptions: ["A", "B", "C"] }));
    const id = made.id as number;
    const poll = () => ((forgeRows(w.forge, "discussions")[0] as { poll: string }).poll ? JSON.parse((forgeRows(w.forge, "discussions")[0] as { poll: string }).poll) : null);
    assert.equal(poll().options.length, 3);
    // Vote option A.
    assert.equal((await b.post("/api/forge/discussions/vote", { id, option: 0 })).status, 200);
    assert.equal(poll().options[0].votes, 1);
    assert.equal(poll().voters, 1);
    // The same vote again: no change.
    assert.equal((await body(await b.post("/api/forge/discussions/vote", { id, option: 0 }))).unchanged, true);
    // Change to B: A down, B up, voters unchanged.
    await b.post("/api/forge/discussions/vote", { id, option: 1 });
    assert.equal(poll().options[0].votes, 0);
    assert.equal(poll().options[1].votes, 1);
    assert.equal(poll().voters, 1);
    // Take it back.
    await b.post("/api/forge/discussions/vote", { id, option: 1, remove: true });
    assert.equal(poll().voters, 0);
    assert.deepEqual(w.forge.scans, []);
  });

  test("an upvote on the discussion itself is counted once and taken back", async () => {
    const b = await signIn(w);
    const id = (await body(await open(b, { space: SPACE, title: "Hi" }))).id as number;
    const up = () => (forgeRows(w.forge, "discussions")[0] as { upvotes: number }).upvotes;
    assert.equal((await b.post("/api/forge/discussions/vote", { id })).status, 200);
    assert.equal(up(), 1);
    assert.equal((await body(await b.post("/api/forge/discussions/vote", { id }))).unchanged, true);
    await b.post("/api/forge/discussions/vote", { id, remove: true });
    assert.equal(up(), 0);
  });
});

describe("the gate", () => {
  test("FORGE_OPEN unset: a non-owner is refused, the owner may", async () => {
    const closed = forgeWorld({ env: { FORGE_OPEN: undefined } }); // Ada is the owner
    const ada = await signIn(closed);
    assert.equal((await ada.post("/api/forge/discussions/open", { space: SPACE, title: "x" })).status, 201);
    const bob = await signIn(closed, "bob");
    const res = await bob.post("/api/forge/discussions/open", { space: SPACE, title: "y" });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "forge_closed");
    closed.restore();
  });
});
