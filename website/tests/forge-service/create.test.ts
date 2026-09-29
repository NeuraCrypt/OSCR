// Creating a repository (night phase 01, E2; worker/forge/service/act-create.ts): the actions
// create and generate, driven end to end through start, the double's GitHub and act (authorize.ts),
// with the real registry of action kinds. The repository exists on the double with the files asked;
// the first branch takes the chosen name; a template is generated with one or all of its branches;
// a wrong name or a private visibility is refused before GitHub is asked anything; the papers are
// linked or proposed by the person's roles; a creation writes at most 6 rows; the 11th of the day is
// refused; a name taken is said in words; FORGE_OPEN closed refuses everyone but the owner.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { CREATE_ACTIONS, describeCreate, validateCreate, validateGenerate } from "../../worker/forge/service/act-create.ts";
import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { CLOSED_MESSAGE } from "../../worker/forge/service/gate.ts";
import { paperId, readPapers } from "../../worker/forge/service/papers.ts";
import { isProblem } from "../../worker/forge/service/types.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeCounts, forgeRows } from "./d1.ts";
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
const create = (payload: Record<string, unknown>, back = "/new/"): StartInput => ({ kind: "create", repo: null, payload, back });
const repoOf = (name: string) => [...w.backend.repos.values()].find((r) => r.name === name);
const adaSession = () => w.backend.session({ kind: "user", token: w.ada.token() });
const ref = (owner: string, name: string) => ({ forge: "memory" as const, owner, name });
const text = async (owner: string, name: string, rev: string, path: string) =>
  new TextDecoder().decode((await adaSession().git.readFile(ref(owner, name), rev, path)).bytes);

describe("create", () => {
  test("a repository with a README, a .gitignore and a licence, attached to a paper Ada authored: at most 6 rows", async () => {
    const b = await signIn(w);
    role(userOf(w.ada.user.id), "verified_author", "paper", `doi:${P1}`);
    w.forge.reset();
    const run = await authorize(
      w,
      b,
      create({ name: "eeg-study", description: "Code for the EEG study", readme: true, gitignore: "Python", license: "mit", papers: [P1, P2] }),
    );
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const repo = repoOf("eeg-study");
    assert.ok(repo);
    assert.equal(repo.defaultBranch, "main");
    assert.match(await text(ADA_LOGIN, "eeg-study", "main", "README.md"), /^# eeg-study/);
    assert.match(await text(ADA_LOGIN, "eeg-study", "main", ".gitignore"), /\S/);
    assert.match(await text(ADA_LOGIN, "eeg-study", "main", "LICENSE"), /\S/);
    assert.equal(run.actBody?.result.page, "/r/ada-fixture/eeg-study/");
    assert.deepEqual(run.actBody?.result.papers, [
      { doi: P1, status: "linked" },
      { doi: P2, status: "proposed" },
    ]);
    assert.match(run.actBody?.sentence, /^Create the public repository eeg-study in your GitHub account, with a README, a Python \.gitignore and the MIT License, attached to 2 papers$/);
    // repos 2 + papers 2 + job 1 + action 1: 6 rows with two papers; with one paper, 5.
    assert.deepEqual(forgeCounts(w.forge), { actions: 1, deliveries: 0, installations: 0, jobs: 1, repo_papers: 2, repos: 1, research_comments: 0, research_issues: 0, traced_paths: 0 });
    assert.equal(w.forge.totals.written, 6);
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.rows, 6);
    const [row] = forgeRows(w.forge, "repos");
    assert.deepEqual([row.mode, row.owner_login, row.name, row.default_branch, row.template, row.linked_by], ["created", "ada-fixture", "eeg-study", "main", 0, userOf(w.ada.user.id)]);
    const [job] = forgeRows(w.forge, "jobs");
    assert.deepEqual([job.kind, job.repo_id, job.user_id], ["link", repo.id, userOf(w.ada.user.id)]);
    assert.deepEqual(w.forge.scans, []);
  });

  test("an empty repository: no branch, no file; the first branch's name needs a first file", async () => {
    const b = await signIn(w);
    const run = await authorize(w, b, create({ name: "empty-one" }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.equal(repoOf("empty-one")?.defaultBranch, null);
    assert.equal(run.actBody?.result.defaultBranch, null);
    assert.equal(run.actBody?.sentence, "Create the public repository empty-one in your GitHub account, empty");
    const refused = validateCreate({ name: "x", defaultBranch: "trunk" });
    assert.ok(isProblem(refused) && /first push names it/.test(refused.message));
  });

  test("the first branch takes the chosen name; a template is marked", async () => {
    const b = await signIn(w);
    const run = await authorize(w, b, create({ name: "trunk-repo", readme: true, defaultBranch: "trunk", template: true, features: { wiki: false } }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const repo = repoOf("trunk-repo");
    assert.equal(repo?.defaultBranch, "trunk");
    assert.equal(repo?.isTemplate, true);
    assert.equal(repo?.features.wiki, false);
    assert.equal(run.actBody?.result.defaultBranch, "trunk");
    assert.deepEqual(run.actBody?.result.notes, []);
    const [row] = forgeRows(w.forge, "repos");
    assert.deepEqual([row.default_branch, row.template], ["trunk", 1]);
  });

  test("refused before GitHub is asked: a wrong name, a private visibility, an unknown template or licence, a repository named", async () => {
    const b = await signIn(w);
    // Every session the service opens on the double: none, when the payload is refused.
    const sessions: ReturnType<typeof w.backend.session>[] = [];
    const open = w.backend.session.bind(w.backend);
    w.backend.session = (credential) => {
      const s = open(credential);
      sessions.push(s);
      return s;
    };
    for (const payload of [
      { name: "a b" },
      { name: "x.git" },
      { name: "..", readme: true },
      { name: "ok", visibility: "private", private: true, gitignore: "Cobol" },
      { name: "ok", license: "proprietary" },
      { name: "ok", homepage: "javascript:alert(1)" },
      { name: "ok", homepage: "http://example.org" },
      { name: "ok", papers: ["not-a-doi"] },
      { name: "ok", features: { pages: true } },
    ]) {
      const run = await authorize(w, b, create(payload));
      assert.equal(run.start.status, 200, JSON.stringify(payload));
      assert.equal(run.act?.status, 400, JSON.stringify(payload));
      assert.equal(run.actBody?.error.code, "bad_payload", JSON.stringify(payload));
      assert.equal(forgeCounts(w.forge).repos, 0);
    }
    // Only the authorization itself reached GitHub: no session, no repository call (cost 0).
    assert.equal(sessions.length, 0);
    // A private repository is never asked for: the payload's visibility is not read, the answer is public.
    const s = validateCreate({ name: "ok", visibility: "private" });
    assert.ok(!isProblem(s));
    // Create and generate name no existing repository.
    const named = await authorize(w, b, { kind: "create", repo: { forge: "memory", owner: ADA_LOGIN, name: "eeg" }, payload: { name: "x" }, back: "/new/" });
    assert.equal(named.start.status, 400);
  });

  test("a name already taken: 409 in words, nothing recorded", async () => {
    const b = await signIn(w);
    await adaSession().repos.create({ name: "taken", visibility: "public" });
    const run = await authorize(w, b, create({ name: "taken" }));
    assert.equal(run.act?.status, 409);
    assert.match(run.actBody?.error.message, /\S/);
    assert.ok(!/token|gh[opsu]_/i.test(JSON.stringify(run.actBody)));
    assert.equal(forgeCounts(w.forge).repos, 0);
    assert.equal(forgeCounts(w.forge).actions, 0);
  });

  test("the 11th creation of the day is refused with 429", async () => {
    const b = await signIn(w);
    const user = userOf(w.ada.user.id);
    for (let i = 0; i < PER_ACCOUNT_DAY.creations; i++) await seed.action(w.forge, { userId: user, kind: i % 2 ? "create" : "generate", t: T0 - 60 - i });
    const run = await authorize(w, b, create({ name: "eleventh" }));
    assert.equal(run.start.status, 429);
    assert.equal(run.startBody.error.cap, "creations");
    assert.equal(repoOf("eleventh"), undefined);
  });

  test("FORGE_OPEN closed: another account is refused; open: it may create", async () => {
    await signIn(w);
    const bob = await signIn(w, "bob-fixture");
    const closed = await authorize(w, bob, create({ name: "bobs" }), { login: "bob-fixture" });
    assert.equal(closed.start.status, 403);
    assert.equal(closed.startBody.error.message, CLOSED_MESSAGE);
    w.env.FORGE_OPEN = "true";
    const open = await authorize(w, bob, create({ name: "bobs" }), { login: "bob-fixture" });
    assert.equal(open.act?.status, 200, JSON.stringify(open.actBody));
    assert.equal(open.actBody?.result.owner, "bob-fixture");
  });
});

describe("generate", () => {
  async function template(): Promise<void> {
    const s = adaSession();
    const t = await s.repos.create({ name: "compendium", visibility: "public", autoInit: true, isTemplate: true });
    const head = await s.git.resolve(t.ref, "main");
    await s.git.createBranch(t.ref, "gh-pages", head);
  }

  test("from a template, with its default branch only, then with all its branches", async () => {
    const b = await signIn(w);
    await template();
    const one = await authorize(w, b, {
      kind: "generate",
      repo: null,
      payload: { template: { owner: ADA_LOGIN, name: "compendium" }, owner: ADA_LOGIN, name: "study-one", papers: [P1] },
      back: "/new/",
    });
    assert.equal(one.act?.status, 200, JSON.stringify(one.actBody));
    assert.deepEqual([...(repoOf("study-one")?.branches.keys() ?? [])], ["main"]);
    assert.equal(one.actBody?.result.page, "/r/ada-fixture/study-one/");
    assert.equal(one.actBody?.sentence, "Create the public repository ada-fixture/study-one from the template ada-fixture/compendium (its default branch), attached to one paper");
    const all = await authorize(w, b, {
      kind: "generate",
      repo: null,
      payload: { template: { owner: ADA_LOGIN, name: "compendium" }, owner: ADA_LOGIN, name: "study-all", includeAllBranches: true },
      back: "/new/",
    });
    assert.equal(all.act?.status, 200, JSON.stringify(all.actBody));
    assert.deepEqual([...(repoOf("study-all")?.branches.keys() ?? [])].sort(), ["gh-pages", "main"]);
    const rows = forgeRows(w.forge, "repos");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.mode === "created"));
    // A repository that is not a template: GitHub's refusal in words, nothing recorded.
    await adaSession().repos.create({ name: "plain", visibility: "public", autoInit: true });
    const refused = await authorize(w, b, {
      kind: "generate",
      repo: null,
      payload: { template: { owner: ADA_LOGIN, name: "plain" }, owner: ADA_LOGIN, name: "study-no" },
      back: "/new/",
    });
    assert.equal(refused.act?.status, 400);
    assert.equal(forgeRows(w.forge, "repos").length, 2);
  });

  test("the payload: a template named owner/name, an account, a name", () => {
    assert.ok(isProblem(validateGenerate({ template: "ada/compendium", owner: "ada", name: "x" })));
    assert.ok(isProblem(validateGenerate({ template: { owner: "ada", name: "c" }, owner: "a b", name: "x" })));
    assert.ok(isProblem(validateGenerate({ template: { owner: "ada", name: "c" }, owner: "ada", name: "x", includeAllBranches: "yes" })));
    assert.deepEqual(validateGenerate({ template: { owner: "ada", name: "c" }, owner: "lab", name: "x", papers: [`https://doi.org/${P1.toUpperCase()}`] }), {
      template: { owner: "ada", name: "c" },
      owner: "lab",
      name: "x",
      description: "",
      includeAllBranches: false,
      papers: [`doi:${P1}`],
    });
  });
});

describe("the registry and the papers", () => {
  test("create and generate are registered, with their spec", () => {
    assert.deepEqual(CREATE_ACTIONS.map((s) => s.kind), ["create", "generate"]);
    assert.equal(ACTIONS.get("create"), CREATE_ACTIONS[0]);
    assert.equal(ACTIONS.get("generate"), CREATE_ACTIONS[1]);
    assert.ok(CREATE_ACTIONS.every((s) => !s.needsRepo));
  });

  test("DOIs as people write them, and their limits", () => {
    assert.equal(paperId("10.5555/OSCR.Fixture.1"), `doi:${P1}`);
    assert.equal(paperId("doi:10.5555/oscr.fixture.1"), `doi:${P1}`);
    assert.equal(paperId("https://doi.org/10.5555/oscr.fixture.1"), `doi:${P1}`);
    for (const bad of ["", "10.55/x", "10.5555/", "10.5555/a b", "10.5555/x@y", 12, null]) assert.equal(paperId(bad), null, String(bad));
    assert.deepEqual(readPapers([P1, P1.toUpperCase()]), [`doi:${P1}`]);
    assert.ok(isProblem(readPapers(Array.from({ length: 21 }, (_, i) => `10.5555/x.${i}`))));
    assert.ok(isProblem(readPapers("10.5555/x")));
  });

  test("the sentence the page confirms says what will be made", () => {
    const p = validateCreate({ name: "eeg", readme: true, license: "apache-2.0", defaultBranch: "trunk", template: true, papers: [P1] });
    assert.ok(!isProblem(p));
    assert.equal(
      describeCreate(p),
      "Create the public repository eeg in your GitHub account, with a README and the Apache License 2.0, its first branch named trunk, marked as a template, attached to one paper",
    );
  });
});
