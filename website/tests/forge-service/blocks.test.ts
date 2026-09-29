// Blocks and interaction limits (night phase 16, E2; blocks.ts): a block is silent (the refusal names
// no one), keeps the blocked person out of the blocker's repositories and research issues, stops them
// following the blocker, and leaves the blocker's list with a label and a note (never an account id);
// an interaction limit, with a duration, on a repository or on every repository a person manages, keeps
// out new accounts, non-contributors or everyone but the managers. 2 rows each; no scan.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { validateBlock, validateLimit } from "../../worker/forge/service/moderation-core.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import type { StartInput as PageStart } from "../../src/lib/forge.ts";
import { signIn, start } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true" } });
});
afterEach(() => w.restore());

const PAPER = "doi:10.1234/eeg.2026";

async function userIdOf(login: string): Promise<string> {
  const account = [...w.backend.accounts.values()].find((a) => a.login === login)!;
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(String(account.id)) as { user_id: string }).user_id;
}
const githubOf = (login: string) => String([...w.backend.accounts.values()].find((a) => a.login === login)!.id);

/** Bob's repository on the double, known to the registry (Bob linked it) and linked to the paper. */
async function bobsRepo(bobId: string): Promise<string> {
  const bob = [...w.backend.accounts.values()].find((a) => a.login === "bob-fixture")!;
  const id = (await w.backend.session({ kind: "user", token: w.backend.issueToken(bob.id) }).repos.create({ name: "tool", visibility: "public", autoInit: true })).key.id;
  await seed.repo(w.forge, { repoId: id, ownerLogin: "bob-fixture", ownerId: bob.id, name: "tool", linkedBy: bobId, defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: PAPER, status: "linked" }] });
  return id;
}

const openOn = (b: ForgeBrowser, repoId: string) =>
  b.post("/api/forge/research/open", { paper: "10.1234/eeg.2026", repo: { forge: "memory", id: repoId, path: "bob-fixture/tool" }, type: "code_error", title: "It crashes", body: "At line 3." });

const commentOn = (repoId: string): PageStart => ({ kind: "issue_comment", repo: { forge: "memory", id: repoId }, branch: null, expectedHead: null, payload: { number: 1, body: "Hi" }, back: "/r/bob-fixture/tool/issues" });

describe("the pure parts", () => {
  test("a block names a person or the author of a research issue or comment; a limit a repository or the account, a level and a duration", () => {
    assert.ok(!isProblem(validateBlock({ target: "person:github:12", on: true, note: "spam, see x@y.org" })));
    assert.equal((validateBlock({ target: "research:3#2", on: true }) as { target: { kind: string } }).target.kind, "comment");
    assert.ok(isProblem(validateBlock({ target: "repo:github:5", on: true })));
    assert.ok(isProblem(validateBlock({ target: "person:github:12" })));
    assert.deepEqual(validateLimit({ scope: "repo:github:5", level: "managers", duration: "1w" }), { scope: "repo:github:5", level: "managers", seconds: 7 * 86_400 });
    assert.deepEqual(validateLimit({ scope: "account", level: null }), { scope: "account", level: null, seconds: 0 });
    assert.ok(isProblem(validateLimit({ scope: "account", level: "managers", duration: "2y" })));
    assert.ok(isProblem(validateLimit({ scope: "repo:gitlab:5", level: "managers", duration: "1w" })));
  });
});

describe("blocks", () => {
  test("Bob blocks Carol from her comment: silent refusals of her comments, her reaction on GitHub, her follow; unblocked, she takes part again", async () => {
    await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const bobId = await userIdOf("bob-fixture");
    const repo = await bobsRepo(bobId);
    const carol = await signIn(w, "carol-fixture");
    const opened = await openOn(bob, repo);
    assert.equal(opened.status, 201, JSON.stringify(await body(opened)));
    const issue = (await body(opened)).id as number;
    assert.equal((await carol.post("/api/forge/research/comment", { id: issue, body: "Buy my course" })).status, 200);
    // Blocked from her comment: the registry finds her account; the list keeps her handle, never an id.
    const blocked = await bob.post("/api/forge/blocks/write", { target: `research:${issue}#1`, on: true, note: "spam; mail spam@example.org" });
    assert.equal(blocked.status, 200, JSON.stringify(await body(blocked)));
    const list = await body(await bob.fetch("/api/forge/blocks"));
    assert.equal(list.blocks.length, 1);
    assert.equal(list.blocks[0].label, "carol-fixture");
    assert.equal(list.blocks[0].ref, `github:${githubOf("carol-fixture")}`);
    assert.equal(list.blocks[0].note, "spam; mail [email hidden]");
    assert.doesNotMatch(JSON.stringify(list), /u_[A-Za-z0-9_-]{10,}/);
    // Her comment on his issue, a research issue on his repository, a comment on GitHub through the
    // registry, a follow of Bob: refused, and the words name no one.
    const refused = await carol.post("/api/forge/research/comment", { id: issue, body: "Again" });
    assert.equal(refused.status, 403);
    assert.equal((await body(refused)).error.code, "blocked");
    assert.doesNotMatch((await body(refused)).error.message, /bob/i);
    assert.equal((await openOn(carol, repo)).status, 403);
    const onGithub = await start(carol, commentOn(repo));
    assert.equal(onGithub.res.status, 403);
    assert.equal(onGithub.body.error.code, "blocked");
    assert.equal((await start(carol, { ...commentOn(repo), kind: "issue_react" })).res.status, 403);
    assert.equal((await body(await carol.post("/api/forge/social/follow", { target: `github:${githubOf("bob-fixture")}`, on: true }))).error.code, "blocked");
    // Someone else still comments; Bob still does.
    const dan = await signIn(w, "dan-fixture");
    assert.equal((await dan.post("/api/forge/research/comment", { id: issue, body: "Same here" })).status, 200);
    // Unblocked by its ref: she comments again.
    assert.equal((await bob.post("/api/forge/blocks/write", { ref: list.blocks[0].ref, on: false })).status, 200);
    assert.equal(forgeRows(w.forge, "blocks").length, 0);
    assert.equal((await carol.post("/api/forge/research/comment", { id: issue, body: "Sorry" })).status, 200);
  });

  test("one cannot block oneself; 2 rows a block; FORGE_OPEN gates it like every write", async () => {
    await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    await signIn(w, "carol-fixture");
    assert.equal((await bob.post("/api/forge/blocks/write", { target: `person:github:${githubOf("bob-fixture")}`, on: true })).status, 400);
    w.forge.reset();
    assert.equal((await bob.post("/api/forge/blocks/write", { target: `person:github:${githubOf("carol-fixture")}`, on: true })).status, 200);
    assert.equal(w.forge.totals.written, 2);
    assert.deepEqual(w.forge.scans, []);
    delete w.env.FORGE_OPEN;
    assert.equal((await body(await bob.post("/api/forge/blocks/write", { target: `person:github:${githubOf("carol-fixture")}`, on: false }))).error.code, "forge_closed");
  });
});

describe("interaction limits", () => {
  test("a repository's limit: managers only, then existing users; an account's limit covers its repositories; only a manager sets one", async () => {
    await signIn(w, ADA_LOGIN);
    const bob = await signIn(w, "bob-fixture");
    const bobId = await userIdOf("bob-fixture");
    const repo = await bobsRepo(bobId);
    const carol = await signIn(w, "carol-fixture");
    assert.equal((await carol.post("/api/forge/limits/write", { scope: `repo:memory:${repo}`, level: "managers", duration: "1w" })).status, 403, "not hers");
    assert.equal((await bob.post("/api/forge/limits/write", { scope: `repo:memory:${repo}`, level: "managers", duration: "1w" })).status, 200);
    const limited = await openOn(carol, repo);
    assert.equal(limited.status, 403);
    assert.equal((await body(limited)).error.code, "limited");
    assert.equal((await start(carol, commentOn(repo))).res.status, 403);
    assert.equal((await openOn(bob, repo)).status, 201, "its manager still may");
    const seen = await body(await carol.fetch(`/api/forge/limits?repo=memory:${repo}`));
    assert.equal(seen.inForce.level, "managers");
    assert.equal(seen.can.manage, false);
    // Existing users: Carol's account is an hour old; two days later she may.
    w.db.sqlite.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(w.clock.t - 3_600, await userIdOf("carol-fixture"));
    assert.equal((await bob.post("/api/forge/limits/write", { scope: `repo:memory:${repo}`, level: "existing_users", duration: "1w" })).status, 200);
    assert.equal((await openOn(carol, repo)).status, 403);
    w.advance(2 * 86_400);
    assert.equal((await openOn(carol, repo)).status, 201);
    // Lifted, then an account-wide limit of Bob's covers his repository.
    assert.equal((await bob.post("/api/forge/limits/write", { scope: `repo:memory:${repo}`, level: null })).status, 200);
    assert.equal((await bob.post("/api/forge/limits/write", { scope: "account", level: "contributors", duration: "24h" })).status, 200);
    assert.equal((await openOn(carol, repo)).status, 403);
    assert.equal((await body(await bob.fetch("/api/forge/blocks"))).limit.level, "contributors");
    // A verified author of the paper is a contributor.
    w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, 'verified_author', 'paper', ?, 'system', ?)").run(await userIdOf("carol-fixture"), PAPER, T0);
    assert.equal((await openOn(carol, repo)).status, 201);
    // The limit ends by itself.
    w.advance(2 * 86_400);
    w.db.sqlite.prepare("DELETE FROM roles WHERE role = 'verified_author'").run();
    assert.equal((await openOn(carol, repo)).status, 201);
  });
});
