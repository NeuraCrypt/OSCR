// What the accounts never keep: no email address (decision D5: notifications stay in the site), no
// provider token, no session id, no secret of the sign-in. The providers here offer an address in
// every answer (GitHub's /user, an `email` claim in the ID tokens), and a name made of one.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanName } from "../../worker/account/providers.ts";
import { world, type World } from "./browser.ts";
import { addFacts, everyText, rows } from "./d1.ts";
import { CLIENTS, OFFERED_EMAIL } from "./mock.ts";

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.restore());

test("no email address is stored, whatever the providers offer", async () => {
  addFacts(w.db, { repos: [["github.com/lab-org/tool", "github.com", "lab-org"]] });
  w.mock.who.orcid = { sub: "0000-0002-1825-0097", name: "Josiah Carberry (josiah@brown.example)" };
  w.mock.who.github = { id: 99, login: "josiah", name: "josiah.carberry@example.edu" };
  w.mock.who.google = { sub: "1234567890", name: "Josiah ＠ Brown" };
  const b = w.browser();
  await b.signIn("orcid");
  await b.signIn("github");
  await b.signIn("google");
  w.mock.github.publicMembers.add("lab-org/josiah");
  const res = await b.post("/api/account/maintainer", { repo: "github.com/lab-org/tool" });
  await b.approve(String(((await res.json()) as { url: string }).url));
  const text = everyText(w.db);
  assert.ok(!text.includes("@") && !text.includes("＠"), text);
  assert.ok(!text.includes(OFFERED_EMAIL));
  assert.equal(rows(w.db, "users")[0].display_name, "Josiah Carberry");
  const me = JSON.stringify(await b.me());
  assert.ok(!me.includes("@"), me);
});

test("the schema has no column for an address", () => {
  const tables = w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  for (const { name } of tables) {
    const columns = w.db.sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
    for (const c of columns) assert.doesNotMatch(c.name, /mail|phone|address/i, `${name}.${c.name}`);
  }
  // And a name with an at sign cannot even be written.
  assert.throws(() => w.db.sqlite.prepare("INSERT INTO users (id, display_name, created_at) VALUES ('u_x', 'a@b.org', 1)").run());
});

test("no token, code, verifier or secret of a sign-in is stored", async () => {
  const b = w.browser();
  const start = await b.fetch("/api/auth/orcid/start");
  const at = new URL(start.headers.get("Location") ?? "");
  const back = new URL(w.mock.authorize(at.toString()));
  await b.fetch(back.pathname + back.search);
  await b.signIn("github");
  const text = everyText(w.db);
  const secrets = [
    back.searchParams.get("code") ?? "",
    at.searchParams.get("state") ?? "",
    at.searchParams.get("nonce") ?? "",
    ...Object.values(CLIENTS).map((c) => c.secret),
    "mock-orcid-token",
    "mock-github-token",
  ];
  for (const s of secrets) assert.ok(s && !text.includes(s), s);
  const verifiers = w.mock.log.map((l) => l.form.code_verifier).filter(Boolean);
  assert.equal(verifiers.length, 2);
  for (const v of verifiers) assert.ok(!text.includes(v));
});

test("a name keeps no address, no control character, and at most 100 characters", () => {
  assert.equal(cleanName("Ada Fixture"), "Ada Fixture");
  assert.equal(cleanName("Ada (ada@lab.org) Fixture"), "Ada Fixture");
  assert.equal(cleanName("ada.fixture@example.org"), "");
  assert.equal(cleanName("Lab @ University"), "Lab University");
  assert.equal(cleanName("Ada‮erutxiF\u0000"), "Ada erutxiF");
  assert.equal(cleanName("  many   spaces  "), "many spaces");
  assert.equal(Array.from(cleanName("é".repeat(300))).length, 100);
  assert.equal(cleanName(null), "");
  assert.equal(cleanName(42), "");
});
