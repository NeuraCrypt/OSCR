// The mirror mode's actions (night phase 01, E3; worker/forge/service/act-link.ts): link an existing
// public repository the person administers or maintains (installed when one of their installations
// of the App covers it, public otherwise), and add or remove its papers. Driven end to end through
// start, the double's GitHub and act (authorize.ts), with the real registry of action kinds.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { describeLink, describePapers, LINK_ACTIONS, validateLink, validatePapers } from "../../worker/forge/service/act-link.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeCounts, forgeRows, forgeText } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld();
});
afterEach(() => w.restore());

const P1 = "10.5555/oscr.fixture.1";
const P2 = "10.5555/oscr.fixture.2";
const userOf = (id: string): string =>
  (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(id) as { user_id: string }).user_id;
const role = (userId: string, r: string, kind: string, scope: string) =>
  w.db.sqlite
    .prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, 'system', ?)")
    .run(userId, r, kind, scope, T0);
const session = (token: string) => w.backend.session({ kind: "user", token });
const repoOf = (name: string) => [...w.backend.repos.values()].find((r) => r.name === name);
const link = (owner: string, name: string, papers: string[] = []): StartInput => ({
  kind: "link",
  repo: { forge: "memory", owner, name },
  payload: { repository: `${owner}/${name}`, papers },
  back: "/new/link/",
});

async function adaRepo(name: string): Promise<void> {
  await session(w.ada.token()).repos.create({ name, visibility: "public", autoInit: true });
}

describe("link", () => {
  test("with the App installed on the account: mode installed, the installation recorded once; ≤ 5 rows with a known installation", async () => {
    const b = await signIn(w);
    role(userOf(w.ada.user.id), "verified_author", "paper", `doi:${P1}`);
    await adaRepo("eeg");
    await adaRepo("eeg-two");
    await adaRepo("eeg-three");
    const installation = w.backend.install(ADA_LOGIN);
    w.forge.reset();
    const first = await authorize(w, b, link(ADA_LOGIN, "eeg", [P1]));
    assert.equal(first.act?.status, 200, JSON.stringify(first.actBody));
    const result = first.actBody?.result;
    assert.deepEqual([result.mode, result.installation, result.page], ["installed", installation, "/r/ada-fixture/eeg/"]);
    assert.deepEqual(result.papers, [{ doi: P1, status: "linked" }]);
    // The others of the installation the person may link next, not linked yet.
    assert.deepEqual(result.others.map((o: { name: string }) => o.name).sort(), ["eeg-three", "eeg-two"]);
    assert.equal(first.actBody?.sentence, "Link your public repository ada-fixture/eeg to the registry, attached to one paper");
    // repos 2 + paper 1 + installation 1 (new) + job 1 + action 1.
    assert.equal(w.forge.totals.written, 6);
    const [row] = forgeRows(w.forge, "repos");
    assert.deepEqual([row.mode, row.installation_id, row.owner_login, row.name], ["installed", installation, "ada-fixture", "eeg"]);
    assert.deepEqual(forgeRows(w.forge, "installations").map((i) => i.id), [installation]);
    assert.deepEqual(forgeRows(w.forge, "jobs").map((j) => j.kind), ["link"]);
    // The installation known: 5 rows.
    w.forge.reset();
    const second = await authorize(w, b, link(ADA_LOGIN, "eeg-two", [P2]));
    assert.equal(second.act?.status, 200, JSON.stringify(second.actBody));
    assert.equal(second.actBody?.result.papers[0].status, "proposed");
    assert.deepEqual(second.actBody?.result.others.map((o: { name: string }) => o.name), ["eeg-three"]);
    assert.equal(w.forge.totals.written, 5);
    assert.deepEqual(w.forge.scans, []);
  });

  test("without the App: mode public, read every night; linked again: 409", async () => {
    const b = await signIn(w);
    await adaRepo("plain");
    const run = await authorize(w, b, link(ADA_LOGIN, "plain"));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.deepEqual([run.actBody?.result.mode, run.actBody?.result.installation], ["public", null]);
    const [row] = forgeRows(w.forge, "repos");
    assert.deepEqual([row.mode, row.installation_id], ["public", null]);
    const again = await authorize(w, b, link(ADA_LOGIN, "plain"));
    assert.equal(again.act?.status, 409);
    assert.equal(again.actBody?.error.code, "already_linked");
    assert.equal(forgeCounts(w.forge).repos, 1);
  });

  test("a repository the person only reads is refused (403), nothing recorded", async () => {
    const bob = w.backend.addUser("bob-fixture");
    await session(bob.token()).repos.create({ name: "bobs-code", visibility: "public", autoInit: true });
    const b = await signIn(w);
    const run = await authorize(w, b, link("bob-fixture", "bobs-code"));
    assert.equal(run.act?.status, 403);
    assert.equal(run.actBody?.error.code, "not_maintainer");
    assert.equal(forgeCounts(w.forge).repos, 0);
    assert.equal(forgeCounts(w.forge).actions, 0);
    // A maintainer may.
    w.backend.grant({ forge: "memory", owner: "bob-fixture", name: "bobs-code" }, ADA_LOGIN, "maintain");
    const allowed = await authorize(w, b, link("bob-fixture", "bobs-code"));
    assert.equal(allowed.act?.status, 200, JSON.stringify(allowed.actBody));
  });

  test("a private repository is refused, and its name is in no D1 text", async () => {
    const b = await signIn(w);
    await adaRepo("secret-lab-notes");
    const r = repoOf("secret-lab-notes");
    assert.ok(r);
    r.visibility = "private";
    const run = await authorize(w, b, link(ADA_LOGIN, "secret-lab-notes"));
    assert.equal(run.act?.status, 403);
    assert.equal(run.actBody?.error.code, "not_public");
    assert.ok(!JSON.stringify(run.actBody).includes("secret-lab-notes"));
    assert.ok(!forgeText(w.forge).includes("secret-lab-notes"));
    assert.equal(forgeCounts(w.forge).repos, 0);
  });

  test("the 21st link of the day is refused with 429", async () => {
    const b = await signIn(w);
    await adaRepo("one-more");
    const user = userOf(w.ada.user.id);
    for (let i = 0; i < PER_ACCOUNT_DAY.links; i++) await seed.action(w.forge, { userId: user, kind: "link", t: T0 - 60 - i });
    const run = await authorize(w, b, link(ADA_LOGIN, "one-more"));
    assert.equal(run.start.status, 429);
    assert.equal(run.startBody.error.cap, "links");
  });

  test("the payload names the repository the page named, by path; nothing else", async () => {
    const b = await signIn(w);
    await adaRepo("eeg");
    await adaRepo("other");
    const mismatch = await authorize(w, b, { ...link(ADA_LOGIN, "eeg"), payload: { repository: `${ADA_LOGIN}/other` } });
    assert.equal(mismatch.act?.status, 400);
    assert.equal(forgeCounts(w.forge).repos, 0);
    const byId = await authorize(w, b, { ...link(ADA_LOGIN, "eeg"), repo: { forge: "memory", id: "1" } });
    assert.equal(byId.start.status, 400);
    assert.ok(isProblem(validateLink({ repository: "a/b/c" })));
    assert.ok(isProblem(validateLink({ repository: "ada/eeg", papers: ["x"] })));
    assert.equal(describeLink({ repository: "ada/eeg", papers: [] }), "Link your public repository ada/eeg to the registry");
  });
});

describe("papers", () => {
  async function linked(b: Awaited<ReturnType<typeof signIn>>): Promise<string> {
    await adaRepo("eeg");
    const run = await authorize(w, b, link(ADA_LOGIN, "eeg", [P2]));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    return String(run.actBody?.result.id);
  }

  test("added and removed by a person who administers the repository; statuses by role; 1 row a paper", async () => {
    const b = await signIn(w);
    const id = await linked(b);
    role(userOf(w.ada.user.id), "verified_author", "paper", `doi:${P1}`);
    w.forge.reset();
    const run = await authorize(w, b, {
      kind: "papers",
      repo: { forge: "memory", id },
      payload: { repository: `${ADA_LOGIN}/eeg`, add: [P1], remove: [P2] },
      back: "/r/ada-fixture/eeg/",
    });
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.deepEqual(run.actBody?.result.added, [{ doi: P1, status: "linked" }]);
    assert.deepEqual(run.actBody?.result.removed, [P2]);
    assert.equal(run.actBody?.sentence, `Attach one paper to and detach one paper from ${ADA_LOGIN}/eeg`);
    assert.deepEqual(forgeRows(w.forge, "repo_papers").map((p) => [p.paper_id, p.status]), [[`doi:${P1}`, "linked"]]);
    assert.equal(w.forge.totals.written, 3);
    // No write on GitHub: the action is the permission check.
    assert.equal(forgeCounts(w.forge).jobs, 1);
  });

  test("someone who may not maintain it is refused; an unknown repository is 404 before GitHub", async () => {
    const b = await signIn(w);
    const id = await linked(b);
    w.env.FORGE_OPEN = "true";
    const bob = await signIn(w, "bob-fixture");
    const refused = await authorize(w, bob, {
      kind: "papers",
      repo: { forge: "memory", id },
      payload: { repository: `${ADA_LOGIN}/eeg`, add: [P1] },
      back: "/",
    }, { login: "bob-fixture" });
    assert.equal(refused.act?.status, 403);
    const unknown = await authorize(w, b, { kind: "papers", repo: { forge: "memory", id: "999999" }, payload: { repository: "a/b", add: [P1] }, back: "/" });
    assert.equal(unknown.start.status, 404);
    assert.ok(isProblem(validatePapers({ repository: "a/b" })));
    assert.ok(isProblem(validatePapers({ repository: "a/b", add: [P1], remove: [P1] })));
    assert.equal(describePapers({ repository: "a/b", add: [P1, P2], remove: [] }), "Attach 2 papers to a/b");
  });

  test("link and papers are registered", () => {
    assert.deepEqual(LINK_ACTIONS.map((s) => s.kind), ["link", "papers"]);
    assert.equal(ACTIONS.get("link"), LINK_ACTIONS[0]);
    assert.equal(ACTIONS.get("papers"), LINK_ACTIONS[1]);
  });
});

describe("the /new/link/ page", () => {
  test("the address pre-fills the repository and the papers; the rest is dropped", async () => {
    const { prefillLink, repoFromInput } = await import("../../src/scripts/link-repo.ts");
    const { form, installation, dropped } = prefillLink(`?repo=ada-fixture%2Feeg&paper=${P1}&paper=doi:${P2}&installation=4242&setup_action=install&x=1`);
    assert.deepEqual(form, { repository: "ada-fixture/eeg", papers: [P1, P2], install: false });
    assert.equal(installation, "4242");
    assert.deepEqual(dropped, ["x"]);
    assert.deepEqual(prefillLink("?repo=a%20b&paper=nope&installation=12x").dropped.sort(), ["installation", "paper", "repo"]);
    for (const [text, want] of [
      ["lab/eeg", "lab/eeg"],
      ["https://github.com/lab/eeg", "lab/eeg"],
      ["https://github.com/lab/eeg.git", "lab/eeg"],
      ["github.com/lab/eeg/tree/main/src", "lab/eeg"],
      ["https://gitlab.com/lab/eeg", null],
      ["lab/eeg/extra", null],
      ["../x", null],
    ] as const) {
      const r = repoFromInput(text);
      assert.equal(r ? `${r.owner}/${r.name}` : null, want, text);
    }
  });

  test("the form declares the action the Worker accepts, with the Worker's sentence; install when asked", async () => {
    const { declareLink } = await import("../../src/scripts/link-repo.ts");
    const d = declareLink({ repository: "https://github.com/lab/eeg", papers: [P1], install: true });
    assert.ok(!("problem" in d));
    assert.deepEqual(d.input, { kind: "link", repo: { forge: "github", owner: "lab", name: "eeg" }, payload: { repository: "lab/eeg", papers: [P1] }, back: "/new/link/", install: true });
    assert.equal(d.sentence, "Link your public repository lab/eeg to the registry, attached to one paper.");
    assert.ok(!isProblem(validateLink(d.input.payload)));
    assert.ok("problem" in declareLink({ repository: "nope", papers: [], install: false }));
    assert.ok("problem" in declareLink({ repository: "lab/eeg", papers: ["x"], install: false }));
  });

  test("the callback page says the papers' statuses and offers the installation's other repositories", async () => {
    const { outcomeOf } = await import("../../src/scripts/forge-client.ts");
    const pending = { kind: "link", payload: "{}", digest: "a".repeat(64), sentence: "s", back: "/new/link/", at: T0 };
    const o = outcomeOf(
      {
        status: 200,
        body: {
          sentence: "Link your public repository lab/eeg to the registry",
          back: "/new/link/",
          result: {
            page: "/r/lab/eeg/",
            papers: [{ doi: P1, status: "linked" }, { doi: P2, status: "proposed" }],
            others: [{ owner: "lab", name: "eeg-two" }, { owner: "lab", name: "<script>" }, { owner: "javascript:", name: "x" }],
          },
        },
      },
      pending,
    );
    assert.equal(o.tone, "ok");
    assert.ok(o.text.includes("Its papers: 1 paper linked, 1 proposed to their authors."));
    assert.deepEqual(o.links, [
      { href: "/r/lab/eeg/", text: "The repository's page" },
      { href: "/new/link/", text: "Back to the page you came from" },
      { href: "/new/link/?repo=lab%2Feeg-two", text: "Link lab/eeg-two too" },
    ]);
  });

  test("the page: one script of the site, the form shown by it, the fields it reads", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../../src/pages/new/link.astro", import.meta.url), "utf8");
    const script = readFileSync(new URL("../../src/scripts/link-repo.ts", import.meta.url), "utf8");
    const scripts = [...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][2], /^\s*import "\.\.\/\.\.\/scripts\/link-repo";\s*$/);
    assert.ok(!/\son[a-z]+=/i.test(page) && !/\sstyle=/i.test(page) && !/<style/i.test(page));
    assert.match(page, /<form id="link-form" hidden>/);
    for (const name of ["repository", "papers", "install"]) assert.ok(page.includes(`name="${name}"`) && script.includes(`"${name}"`), name);
    for (const id of ["link-form", "link-installed", "link-message", "link-confirm"]) assert.ok(page.includes(`id="${id}"`) && script.includes(`"${id}"`), id);
  });
});
