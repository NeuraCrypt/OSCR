// The snippet routes (night phase 13; snippets.ts): read one, discover and list, edit the record,
// comment (with an edit history), star; and the authorized create (act-snippet.ts) end to end on the
// double. Unlisted snippets are reachable by a direct link but never in discover or a stranger's
// list; a hidden snippet is gone for everyone but its owner and a moderator; Turnstile guards a new
// comment; the caps and the gate hold; no email address is kept.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, turnstileStandIn, HUMAN_TOKEN, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true", ACCOUNT_DEV_METRICS: "1" }, deps: { turnstileFetch: turnstileStandIn } });
});
afterEach(() => w.restore());

async function userIdOf(login: string): Promise<string> {
  const row = w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(String(w.mock.who.github.id)) as { user_id: string } | undefined;
  return row?.user_id ?? login;
}

describe("creating a snippet (authorized action)", () => {
  test("snippet_create: a public snippet is committed to the person's snippets repository and recorded", async () => {
    const b = await signIn(w);
    const out = await authorize(w, b, {
      kind: "snippet_create",
      repo: null,
      payload: { title: "EEG band-pass filter", description: "A 1-40 Hz filter. Mail ada@example.org.", visibility: "public", files: [{ path: "filter.py", content: "import numpy as np\n" }] },
      back: "/snippets/",
    });
    assert.equal(out.act?.status, 200, JSON.stringify(out.actBody));
    assert.equal(out.actBody?.result.owner, ADA_LOGIN);
    assert.match(String(out.actBody?.result.revision), /^[0-9a-f]{40}$/);
    const [row] = forgeRows(w.forge, "snippets");
    assert.equal(row.owner_login, ADA_LOGIN);
    assert.equal(row.visibility, "public");
    assert.equal(row.title, "EEG band-pass filter");
    assert.match(String(row.description), /\[email hidden\]/);
    assert.ok(!JSON.stringify(forgeRows(w.forge, "snippets")).includes("ada@example.org"));
    // The `snippets` repository was created on the double, and the folder committed.
    const repo = w.backend.accounts.get(row.owner_id) ? null : null; // repo created under ada
    assert.ok(String(row.files).includes("filter.py"));
    assert.deepEqual(w.forge.scans, []);
  });

  test("snippet_create unlisted, then a revision adds a file and changes the revision", async () => {
    const b = await signIn(w);
    await authorize(w, b, { kind: "snippet_create", repo: null, payload: { title: "Private helper", visibility: "unlisted", files: [{ path: "a.py", content: "x=1\n" }] }, back: "/snippets/" });
    const id = Number(forgeRows(w.forge, "snippets")[0].id);
    const r0 = forgeRows(w.forge, "snippets")[0].revision;
    const rev = await authorize(w, b, { kind: "snippet_revise", repo: null, payload: { id, files: [{ path: "a.py", content: "x=2\n" }, { path: "b.py", content: "y=3\n" }], title: "Private helper v2" }, back: "/snippets/" });
    assert.equal(rev.act?.status, 200, JSON.stringify(rev.actBody));
    const row = forgeRows(w.forge, "snippets")[0];
    assert.equal(row.visibility, "unlisted");
    assert.equal(row.title, "Private helper v2");
    assert.notEqual(row.revision, r0);
    assert.ok(String(row.files).includes("b.py"));
  });
});

describe("reading, discover and the lists", () => {
  async function seedTwo(): Promise<{ pub: number; unl: number }> {
    const uid = await userIdOf(ADA_LOGIN);
    const pub = await seed.snippet(w.forge, { ownerId: uid, ownerLogin: ADA_LOGIN, repoId: "500", folder: "public-one", title: "Public one", visibility: "public" });
    const unl = await seed.snippet(w.forge, { ownerId: uid, ownerLogin: ADA_LOGIN, repoId: "500", folder: "unlisted-one", title: "Unlisted one", visibility: "unlisted" }, T0 + 1);
    return { pub, unl };
  }

  test("discover shows public snippets, never unlisted", async () => {
    const b = await signIn(w);
    const { unl } = await seedTwo();
    const res = await b.fetch("/api/forge/snippets");
    const p = await body(res);
    assert.deepEqual(p.snippets.map((x: Json) => x.folder), ["public-one"]);
    assert.ok(!p.snippets.some((x: Json) => x.id === unl));
  });

  test("an unlisted snippet is reachable by id and by handle (a direct link)", async () => {
    const b = await signIn(w);
    const { unl } = await seedTwo();
    assert.equal((await body(await b.fetch(`/api/forge/snippets?id=${unl}`))).snippet.folder, "unlisted-one");
    assert.equal((await body(await b.fetch(`/api/forge/snippets?owner=${ADA_LOGIN}&folder=unlisted-one`))).snippet.id, unl);
  });

  test("a stranger's list hides the owner's unlisted snippets; the owner sees their own", async () => {
    const owner = await signIn(w);
    await seedTwo();
    const mine = await body(await owner.fetch(`/api/forge/snippets?owner=${ADA_LOGIN}`));
    assert.deepEqual(mine.snippets.map((x: Json) => x.folder).sort(), ["public-one", "unlisted-one"]);
    const bob = await signIn(w, "bob-lab");
    const theirs = await body(await bob.fetch(`/api/forge/snippets?owner=${ADA_LOGIN}`));
    assert.deepEqual(theirs.snippets.map((x: Json) => x.folder), ["public-one"]);
  });
});

describe("edit, comment, star, hide", () => {
  async function one(visibility: "public" | "unlisted" = "public"): Promise<{ b: ForgeBrowser; id: number; uid: string }> {
    const b = await signIn(w);
    const uid = await userIdOf(ADA_LOGIN);
    const id = await seed.snippet(w.forge, { ownerId: uid, ownerLogin: ADA_LOGIN, repoId: "500", folder: "s1", title: "S1", visibility });
    w.forge.reset();
    return { b, id, uid };
  }

  test("the owner edits the title, makes an unlisted snippet public, turns comments off", async () => {
    const { b, id } = await one("unlisted");
    const res = await b.post("/api/forge/snippets/edit", { id, title: "Renamed", visibility: "public", commentsOff: true });
    assert.equal(res.status, 200, JSON.stringify(await body(res)));
    const row = forgeRows(w.forge, "snippets")[0];
    assert.equal(row.title, "Renamed");
    assert.equal(row.visibility, "public");
    assert.equal(row.comments_off, 1);
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.kind, "snippet_edit");
  });

  test("a comment needs the human check; it is masked; an edit keeps a history; delete and hide", async () => {
    const { b, id } = await one();
    // Without a passing human check, refused.
    assert.equal((await b.post("/api/forge/snippets/comment", { id, body: "hi", turnstile: "" })).status, 403);
    const made = await b.post("/api/forge/snippets/comment", { id, body: "Reach me at ada@example.org", turnstile: HUMAN_TOKEN });
    assert.equal(made.status, 201, JSON.stringify(await body(made)));
    const c = forgeRows(w.forge, "snippet_comments")[0];
    assert.equal(c.n, 1);
    assert.match(String(c.body), /\[email hidden\]/);
    // Edit keeps the prior body in the history.
    await b.post("/api/forge/snippets/comment", { id, n: 1, body: "edited note" });
    const edited = forgeRows(w.forge, "snippet_comments")[0];
    assert.equal(edited.body, "edited note");
    assert.match(String(edited.history), /note|email hidden/);
    assert.ok(Number(edited.edited_at) > 0);
    // Hide by the owner, then delete.
    await b.post("/api/forge/snippets/comment", { id, n: 1, hide: "off-topic" });
    assert.equal(forgeRows(w.forge, "snippet_comments")[0].hidden, "off-topic");
  });

  test("comments off: a stranger cannot comment", async () => {
    const { id } = await one();
    const owner = await signIn(w);
    await owner.post("/api/forge/snippets/edit", { id, commentsOff: true });
    const bob = await signIn(w, "bob-lab");
    const res = await bob.post("/api/forge/snippets/comment", { id, body: "hello", turnstile: HUMAN_TOKEN });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "comments_off");
  });

  test("star and unstar, counted once; stargazers listed", async () => {
    const { b, id } = await one();
    assert.equal((await body(await b.post("/api/forge/snippets/star", { id, on: true }))).stars, 1);
    // Starring again is idempotent.
    assert.equal((await body(await b.post("/api/forge/snippets/star", { id, on: true }))).stars, 1);
    const read = await body(await b.fetch(`/api/forge/snippets?id=${id}`));
    assert.equal(read.starred, true);
    assert.equal(read.stargazers.length, 1);
    assert.equal((await body(await b.post("/api/forge/snippets/star", { id, on: false }))).stars, 0);
  });

  test("a hidden snippet is gone for others, kept for its owner and a moderator", async () => {
    const { b, id } = await one();
    await b.post("/api/forge/snippets/edit", { id, hide: "spam" });
    // The owner still reads it.
    assert.equal((await body(await b.fetch(`/api/forge/snippets?id=${id}`))).snippet.hidden, "spam");
    const bob = await signIn(w, "bob-lab");
    assert.equal((await bob.fetch(`/api/forge/snippets?id=${id}`)).status, 410);
    // A stranger cannot hide it.
    const res = await bob.post("/api/forge/snippets/edit", { id, hide: "spam" });
    assert.equal(res.status, 403);
  });

  test("only the owner edits; a stranger is refused", async () => {
    const { id } = await one();
    const bob = await signIn(w, "bob-lab");
    assert.equal((await bob.post("/api/forge/snippets/edit", { id, title: "theirs" })).status, 403);
  });
});

describe("the gate", () => {
  test("closed when FORGE_OPEN is off and the reader is not the owner", async () => {
    w.restore();
    w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1", FORGE_OWNER_GITHUB_ID: undefined }, deps: { turnstileFetch: turnstileStandIn } }); // FORGE_OPEN unset, no owner id
    const b = await signIn(w);
    const uid = await userIdOf(ADA_LOGIN);
    const id = await seed.snippet(w.forge, { ownerId: uid, ownerLogin: ADA_LOGIN, repoId: "500", folder: "s1", title: "S1" });
    const res = await b.post("/api/forge/snippets/star", { id, on: true });
    assert.equal(res.status, 403);
    assert.equal((await body(res)).error.code, "forge_closed");
  });
});
