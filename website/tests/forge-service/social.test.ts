// The registry's social layer (night phase 08, E1; social-core.ts, social.ts): stars, star lists,
// follows and watch levels, profiles, in D1 oscr_forge. Each write is 2 rows (its row, the action
// row); FORGE_OPEN gates every write; the social cap stands apart from the 100 authorized actions; the
// reads go by the person's key, never a scan; no answer names an account's id or an address.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import {
  cleanLine,
  httpsUrl,
  orcidChecks,
  readSubject,
  readTarget,
  validateFollow,
  validateList,
  validateProfile,
  validateStar,
} from "../../worker/forge/service/social-core.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const CARBERRY = "0000-0002-1825-0097";
const PAPER = "paper:doi:10.1234/eeg.2026";

async function userId(): Promise<string> {
  const subject = String(w.mock.who.github.id);
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
}

describe("the pure parts", () => {
  test("subjects: a repository by its id, a paper by its DOI written any way, a topic", () => {
    assert.equal(readSubject("repo:github:123"), "repo:github:123");
    assert.equal(readSubject("paper:https://doi.org/10.1234/EEG.2026"), PAPER);
    assert.equal(readSubject("paper:doi:10.1234/eeg.2026"), PAPER);
    assert.equal(readSubject("topic:neuroscience"), "topic:neuroscience");
    for (const bad of ["repo:gitlab:1", "repo:github:abc", "topic:Neuro", "topic:-x", "paper:11.2/x", "owner:github:ada", "", 7]) assert.equal(readSubject(bad), null, String(bad));
  });

  test("targets: people by GitHub id or ORCID iD (the check digit verified), organizations, entities, threads", () => {
    assert.ok(orcidChecks(CARBERRY));
    assert.ok(orcidChecks("0000-0000-0000-001X"));
    assert.ok(!orcidChecks("0000-0002-1825-0098"));
    assert.equal(readTarget(`orcid:${CARBERRY}`), `orcid:${CARBERRY}`);
    assert.equal(readTarget("orcid:0000-0002-1825-0098"), null);
    assert.equal(readTarget("github:42"), "github:42");
    assert.equal(readTarget("owner:github:Neuro-Lab"), "owner:github:neuro-lab");
    assert.equal(readTarget("owner:github:bad--name"), null);
    assert.equal(readTarget("journal:j-neurosci"), "journal:j-neurosci");
    assert.equal(readTarget("category:method/eeg"), "category:method/eeg");
    assert.equal(readTarget("tool:../etc"), null);
    assert.equal(readTarget(`thread:${PAPER}#research:3`), `thread:${PAPER}#research:3`);
    assert.equal(readTarget("thread:repo:github:1#issue:12"), "thread:repo:github:1#issue:12");
    assert.equal(readTarget("thread:topic:x#issue:1"), null);
    assert.equal(readTarget("repo:github:5"), "repo:github:5");
    assert.equal(readTarget("topic:x"), null);
  });

  test("texts: addresses masked, control characters dropped; websites https without a user part", () => {
    assert.equal(cleanLine("Write to ada@example.org\u0007 now", 300), "Write to [email hidden] now");
    assert.equal(httpsUrl("https://lab.example.org/ada"), "https://lab.example.org/ada");
    for (const bad of ["http://lab.example.org", "https://ada:pw@lab.example.org", "javascript:alert(1)", "https://localhost"]) assert.equal(httpsUrl(bad), null, bad);
  });

  test("payloads: a watch's level and custom events; a list's operations; a profile's fields", () => {
    const watch = validateFollow({ target: "repo:github:5", level: "custom", events: ["releases", "issues"], on: true });
    assert.ok(!isProblem(watch) && watch.level === "custom" && watch.events.join(" ") === "issues releases");
    assert.ok(isProblem(validateFollow({ target: "repo:github:5", level: "custom", events: [], on: true })));
    assert.ok(isProblem(validateFollow({ target: "github:5", level: "participating", on: true })));
    assert.ok(isProblem(validateStar({ subject: "repo:github:5" })));
    assert.ok(isProblem(validateList({ op: "create", name: "" })));
    assert.ok(isProblem(validateList({ op: "add", id: 33, subject: PAPER })));
    const p = validateProfile({ name: "Ada @ Lab", bio: "EEG, ada@example.org", website: "https://ada.example.org", links: ["https://orcid.org/0000"], pinned: ["repo:github:5", "list:2"], timezone: "Europe/Paris" }, T0);
    assert.ok(!isProblem(p));
    if (!isProblem(p)) {
      assert.equal(p.name, "Ada Lab");
      assert.equal(p.bio, "EEG, [email hidden]");
      assert.deepEqual(p.pinned, ["repo:github:5", "list:2"]);
    }
    assert.ok(isProblem(validateProfile({ website: "http://x.org" }, T0)));
    assert.ok(isProblem(validateProfile({ timezone: "Paris; DROP" }, T0)));
    assert.ok(isProblem(validateProfile({ statusUntil: T0 - 1 }, T0)));
  });
});

describe("stars and lists", () => {
  test("star a repository: 2 rows; again: nothing; unstar: the star and its list entries", async () => {
    const b = await signIn(w);
    w.forge.reset();
    const res = await b.post("/api/forge/social/star", { subject: "repo:memory:11", label: "ada-fixture/eeg", on: true });
    assert.equal(res.status, 200, JSON.stringify(await body(res)));
    assert.equal((await body(res)).written, 2);
    assert.equal(w.forge.totals.written, 2);
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.kind, "star");
    assert.equal(action.subject, "repo:memory:11");
    assert.equal(action.repo_id, "11");
    assert.equal(action.rows, 2);
    w.forge.reset();
    const again = await body(await b.post("/api/forge/social/star", { subject: "repo:memory:11", on: true }));
    assert.equal(again.unchanged, true);
    assert.equal(w.forge.totals.written, 0);
    // A list, the star in it, then unstarring removes the entry too.
    const made = await body(await b.post("/api/forge/social/list", { op: "create", name: "EEG pipelines", description: "Filters", public: true }));
    assert.equal(made.id, 1);
    await b.post("/api/forge/social/list", { op: "add", id: 1, subject: "repo:memory:11" });
    w.forge.reset();
    const off = await body(await b.post("/api/forge/social/star", { subject: "repo:memory:11", on: false }));
    assert.equal(off.written, 3);
    assert.equal(forgeRows(w.forge, "star_list_items").length, 0);
    assert.deepEqual(w.forge.scans, []);
  });

  test("adding to a list stars the entry; the list's limits; a private list is no collection", async () => {
    const b = await signIn(w);
    await b.post("/api/forge/social/list", { op: "create", name: "Papers to read" });
    w.forge.reset();
    const add = await body(await b.post("/api/forge/social/list", { op: "add", id: 1, subject: "paper:10.1234/EEG.2026", label: "An EEG paper" }));
    assert.equal(add.written, 3);
    assert.equal(forgeRows(w.forge, "stars")[0].subject, PAPER);
    const dup = await b.post("/api/forge/social/list", { op: "create", name: "papers to read" });
    assert.equal(dup.status, 409);
    const proposed = await body(await b.post("/api/forge/social/list", { op: "propose", id: 1 }));
    assert.equal(proposed.collection, "proposed");
    await b.post("/api/forge/social/list", { op: "edit", id: 1, public: false });
    assert.equal(forgeRows(w.forge, "star_lists")[0].collection, "");
    const refused = await b.post("/api/forge/social/list", { op: "propose", id: 1 });
    assert.equal(refused.status, 409);
    w.forge.reset();
    const del = await body(await b.post("/api/forge/social/list", { op: "delete", id: 1 }));
    assert.equal(del.written, 3);
    assert.equal(forgeRows(w.forge, "star_lists").length, 0);
    assert.deepEqual(w.forge.scans, []);
  });

  test("the reader's own stars, lists and follows, and the buttons' state", async () => {
    const b = await signIn(w);
    await b.post("/api/forge/social/star", { subject: "topic:eeg", label: "eeg", on: true });
    await b.post("/api/forge/social/list", { op: "create", name: "Private", public: false });
    await b.post("/api/forge/social/list", { op: "add", id: 1, subject: "topic:eeg" });
    await b.post("/api/forge/social/follow", { target: "repo:memory:11", level: "participating", on: true });
    const mine = await body(await b.fetch("/api/forge/social/mine"));
    assert.equal(mine.stars.length, 1);
    assert.equal(mine.stars[0].kind, "topic");
    assert.deepEqual(mine.lists[0].items, ["topic:eeg"]);
    assert.equal(mine.lists[0].public, false);
    assert.equal(mine.follows[0].level, "participating");
    assert.equal(mine.can.write, true);
    assert.ok(!JSON.stringify(mine).includes(await userId()));
    const state = await body(await b.fetch("/api/forge/social?s=topic:eeg&s=repo:memory:11"));
    assert.equal(state.subjects["topic:eeg"].starred, true);
    assert.deepEqual(state.subjects["topic:eeg"].lists, [1]);
    assert.equal(state.subjects["repo:memory:11"].follow.level, "participating");
    const tooMany = await b.fetch(`/api/forge/social?${Array.from({ length: 21 }, (_, i) => `s=topic:t${i}`).join("&")}`);
    assert.equal(tooMany.status, 400);
    assert.deepEqual(w.forge.scans, []);
  });
});

describe("follows", () => {
  test("follow a catalogue author by ORCID iD before they have an account; watch levels; stop", async () => {
    const b = await signIn(w);
    w.forge.reset();
    const f = await b.post("/api/forge/social/follow", { target: `orcid:${CARBERRY}`, label: "Josiah Carberry", on: true });
    assert.equal(f.status, 200, JSON.stringify(await body(f)));
    assert.equal(w.forge.totals.written, 2);
    const person = await body(await b.fetch(`/api/forge/social/person?orcid=${CARBERRY}`));
    assert.equal(person.account, false);
    assert.equal(person.following.orcid, "all");
    const watch = await body(await b.post("/api/forge/social/follow", { target: "repo:memory:11", level: "custom", events: ["releases"], on: true }));
    assert.deepEqual(watch.follow, { level: "custom", events: ["releases"] });
    const same = await body(await b.post("/api/forge/social/follow", { target: "repo:memory:11", level: "custom", events: ["releases"], on: true }));
    assert.equal(same.unchanged, true);
    const stop = await body(await b.post("/api/forge/social/follow", { target: `orcid:${CARBERRY}`, on: false }));
    assert.equal(stop.written, 2);
    assert.equal(forgeRows(w.forge, "follows").length, 1);
  });

  test("one does not follow oneself", async () => {
    const b = await signIn(w);
    const res = await b.post("/api/forge/social/follow", { target: `github:${w.ada.user.id}`, on: true });
    assert.equal(res.status, 400);
  });

  test("a person's profile: public lists and stars; a private profile keeps them; never the account's id", async () => {
    const ada = await signIn(w);
    await ada.post("/api/forge/social/profile", { name: "Ada Fixture", bio: "EEG methods. Mail ada@example.org", website: "https://ada.example.org", pinned: ["repo:memory:11"] });
    await ada.post("/api/forge/social/star", { subject: PAPER, label: "EEG", on: true });
    await ada.post("/api/forge/social/list", { op: "create", name: "Public list" });
    await ada.post("/api/forge/social/list", { op: "create", name: "Hidden list", public: false });
    const id = await userId();
    const profile = forgeRows(w.forge, "profiles")[0];
    assert.equal(profile.bio, "EEG methods. Mail [email hidden]");
    // Bob reads Ada's profile (reads are open to signed-in readers; writes are the owner's).
    const bob = await signIn(w, "bob-fixture");
    const seen = await body(await bob.fetch(`/api/forge/social/person?github=${w.ada.user.id}`));
    assert.equal(seen.account, true);
    assert.equal(seen.me, false);
    assert.equal(seen.profile.name, "Ada Fixture");
    assert.deepEqual(seen.lists.map((l: Json) => l.name), ["Public list"]);
    assert.equal(seen.stars.length, 1);
    assert.equal(seen.handles.github, "ada-fixture");
    assert.ok(!JSON.stringify(seen).includes(id));
    // Private: nothing but the profile's own words.
    await ada.post("/api/forge/social/profile", { name: "Ada Fixture", private: true });
    const hidden = await body(await bob.fetch(`/api/forge/social/person?github=${w.ada.user.id}`));
    assert.deepEqual([hidden.stars.length, hidden.lists.length, hidden.follows.length], [0, 0, 0]);
    assert.equal(hidden.profile.private, true);
    const bad = await bob.fetch("/api/forge/social/person?github=1&orcid=0000-0002-1825-0097");
    assert.equal(bad.status, 400);
  });
});

describe("the gate and the caps", () => {
  test("FORGE_OPEN unset: only the owner writes; others read, and are told why", async () => {
    await signIn(w);
    const bob = await signIn(w, "bob-fixture");
    w.forge.reset();
    for (const [path, payload] of [
      ["/api/forge/social/star", { subject: PAPER, on: true }],
      ["/api/forge/social/follow", { target: `orcid:${CARBERRY}`, on: true }],
      ["/api/forge/social/list", { op: "create", name: "Mine" }],
      ["/api/forge/social/profile", { name: "Bob" }],
    ] as const) {
      const res = await bob.post(path, payload);
      assert.equal(res.status, 403, path);
      assert.equal((await body(res)).error.code, "forge_closed");
    }
    assert.equal(w.forge.totals.written, 0);
    assert.equal((await body(await bob.fetch("/api/forge/social/mine"))).can.write, false);
  });

  test("Origin, CSRF and sign-in are required for every write", async () => {
    const b = await signIn(w);
    assert.equal((await b.post("/api/forge/social/star", { subject: PAPER, on: true }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post("/api/forge/social/star", { subject: PAPER, on: true }, { csrf: null })).status, 403);
    const out = w.browser();
    assert.equal((await out.post("/api/forge/social/star", { subject: PAPER, on: true }, { csrf: null })).status, 401);
    assert.equal((await out.fetch("/api/forge/social/mine")).status, 401);
    assert.equal(forgeRows(w.forge, "stars").length, 0);
  });

  test("the social cap stands apart: 300 a day, and the 100 authorized actions stay whole", async () => {
    const b = await signIn(w);
    const uid = await userId();
    for (let i = 0; i < PER_ACCOUNT_DAY.social; i++) await seed.action(w.forge, { userId: uid, kind: "star" as never, t: T0 - 100 + i / 1000 });
    const res = await b.post("/api/forge/social/star", { subject: PAPER, on: true });
    assert.equal(res.status, 429);
    assert.equal((await body(res)).error.cap, "social");
    // The authorized actions are not touched by the social writes: a research issue still opens.
    const { dailyCaps } = await import("../../worker/forge/service/gate.ts");
    const caps = await dailyCaps(w.forge, uid, "research_open", T0);
    assert.equal(caps.used.actions, 0);
    assert.equal(caps.exceeded, null);
  });
});
