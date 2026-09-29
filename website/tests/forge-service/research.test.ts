// Research issues (night phase 05, E2; research-core.ts, research.ts, act-research.ts, and the merge
// that closes them in act-pulls.ts): the registry's own issues, in D1 oscr_forge. A new issue writes 3
// rows, a comment 3, a change 2; FORGE_OPEN gates every write; the texts lose their addresses; the
// reads go by key or index; a pull request that says "Fixes research#N" closes it at its merge.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { StartInput } from "../../src/lib/forge.ts";
import { ACTIONS, REGISTERED_IN } from "../../worker/forge/service/actions.ts";
import { copyBody, RESEARCH_ACTIONS } from "../../worker/forge/service/act-research.ts";
import { describePullMerge, validatePullMerge, type PullMergeParsed } from "../../worker/forge/service/act-pulls.ts";
import { PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import {
  clean,
  personOf,
  readReport,
  researchClosing,
  researchRefs,
  RESOLUTIONS_OF,
  validateComment,
  validateEdit,
  validateOpen,
  type OpenParsed,
} from "../../worker/forge/service/research-core.ts";
import { ACTION_KINDS, AUTOMATION_KINDS, isProblem, RESEARCH_KINDS, ROW_KINDS, SOCIAL_KINDS } from "../../worker/forge/service/types.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import { authorize, signIn } from "./authorize.ts";
import { forgeRows } from "./d1.ts";
import { ADA_LOGIN, forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

let w: ForgeWorld;
beforeEach(() => {
  w = forgeWorld({ env: { FORGE_OPEN: "true", ACCOUNT_DEV_METRICS: "1" } });
});
afterEach(() => w.restore());

const PAPER = "doi:10.1234/eeg.2026";
const HEAD = "a".repeat(40);
const REF = { forge: "memory" as const, owner: ADA_LOGIN, name: "eeg" };
const ada = () => w.backend.session({ kind: "user", token: w.ada.token() });

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;

/** Ada's repository on the double, known to the registry and linked to the paper. */
async function linkedRepo(): Promise<string> {
  const id = (await ada().repos.create({ name: "eeg", visibility: "public", autoInit: true })).key.id;
  await seed.repo(w.forge, { repoId: id, ownerLogin: ADA_LOGIN, name: "eeg", defaultBranch: "main" }, T0 - 86_400, { papers: [{ paperId: PAPER, status: "linked" }] });
  return id;
}

const mismatch = (repoId: string, extra: Record<string, unknown> = {}) => ({
  paper: "10.1234/EEG.2026",
  repo: { forge: "memory", id: repoId, path: "ada-fixture/eeg" },
  type: "mismatch",
  title: "The filter's order is 4, the paper says 2",
  body: "See §2.3. Write to ada@example.org for the data.",
  commit: HEAD,
  path: "src/filter.py",
  lines: { start: 12, end: 18 },
  paragraph: 14,
  section: "2.3 Filtering",
  ...extra,
});

async function userId(): Promise<string> {
  const subject = String(w.mock.who.github.id);
  return (w.db.sqlite.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(subject) as { user_id: string }).user_id;
}

function role(uid: string, r: string, kind: string, id: string): void {
  w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, ?, ?, ?, 'system', ?)").run(uid, r, kind, id, T0);
}

async function open(b: ForgeBrowser, payload: Record<string, unknown>): Promise<Response> {
  return b.post("/api/forge/research/open", payload);
}

describe("opening a research issue", () => {
  test("a mismatch on a linked repository: 3 rows (5 with phase 08's event and the author's follow of the thread), the address masked, the author named by GitHub login", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    w.forge.reset();
    const res = await open(b, mismatch(repoId));
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    const made = await body(res);
    assert.equal(made.id, 1);
    assert.equal(made.page, "/research/1");
    // The issue, its index entry, the action row; phase 08: the paper's event and the thread followed.
    assert.equal(w.forge.totals.written, 5);
    const [event] = forgeRows(w.forge, "events");
    assert.deepEqual([event.subject, event.kind, event.thread, event.url, event.actor_name], [`paper:${PAPER}`, "research_opened", "research:1", "/research/1", ADA_LOGIN]);
    assert.deepEqual(forgeRows(w.forge, "follows").map((f) => [f.target, f.auto]), [[`thread:paper:${PAPER}#research:1`, 1]]);
    const [row] = forgeRows(w.forge, "research_issues");
    assert.equal(row.paper_id, PAPER);
    assert.equal(row.repo_path, "ada-fixture/eeg");
    assert.equal(row.author, ADA_LOGIN);
    assert.equal(row.author_via, "github");
    assert.equal(row.start_line, 12);
    assert.match(String(row.body), /\[email hidden\]/);
    assert.ok(!JSON.stringify(forgeRows(w.forge, "research_issues")).includes("ada@example.org"));
    const [action] = forgeRows(w.forge, "actions");
    assert.equal(action.kind, "research_open");
    assert.equal(action.rows, 5);
    assert.equal(action.subject, `paper:${PAPER}`);
    assert.equal(action.nonce, event.nonce);
    assert.equal(action.repo_id, repoId);
    assert.deepEqual(w.forge.scans, []);
  });

  test("a reproduction failure carries its report; code hosted elsewhere is named by its address", async () => {
    const b = await signIn(w);
    const res = await open(b, {
      paper: "https://doi.org/10.1234/eeg.2026",
      code: "https://zenodo.org/records/123456",
      type: "reproduction",
      title: "Figure 3 does not come out",
      report: { outcome: "failed", environment: "Python 3.12, numpy 2.1", datasets: ["10.18112/openneuro.ds000117.v1.0.0"], command: "python run.py --seed 1", expected: "r = 0.61", observed: "r = 0.12", figure: "Figure 3" },
    });
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    const [row] = forgeRows(w.forge, "research_issues");
    assert.equal(row.code_url, "https://zenodo.org/records/123456");
    assert.equal(row.repo_id, "");
    const report = JSON.parse(String(row.report));
    assert.equal(report.outcome, "failed");
    assert.deepEqual(report.datasets, ["doi:10.18112/openneuro.ds000117.v1.0.0"]);
  });

  test("refused: code the registry does not know as the paper's, a mismatch without its link, a report on another type", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    const other = await open(b, mismatch(repoId, { paper: "10.9999/other" }));
    assert.equal(other.status, 404);
    assert.equal((await body(other)).error.code, "unknown_code");
    const noLink = await open(b, mismatch(repoId, { paragraph: undefined }));
    assert.equal(noLink.status, 400);
    assert.equal((await open(b, { ...mismatch(repoId), type: "code_error", report: { outcome: "failed", observed: "x" } })).status, 400);
    assert.equal((await open(b, { paper: "10.1234/eeg.2026", code: "https://evil.example/x", type: "code_error", title: "x" })).status, 400);
    assert.equal(forgeRows(w.forge, "research_issues").length, 0);
    assert.equal(forgeRows(w.forge, "actions").length, 0);
  });

  test("the Mac's paper_repo fact is enough for a catalogue repository the registry does not follow", async () => {
    const b = await signIn(w);
    w.db.sqlite.prepare("INSERT INTO paper_repo (repo, paper_id) VALUES ('github.com/ada-fixture/eeg', ?)").run(PAPER);
    const res = await open(b, mismatch("777"));
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    assert.equal(forgeRows(w.forge, "research_issues")[0].repo_id, "777");
  });

  test("FORGE_OPEN unset: only the owner writes; another account is refused, nothing written", async () => {
    const closed = forgeWorld({ env: { FORGE_OWNER_GITHUB_ID: "999999" } });
    try {
      const b = await signIn(closed);
      closed.db.sqlite.prepare("INSERT INTO paper_repo (repo, paper_id) VALUES ('github.com/ada-fixture/eeg', ?)").run(PAPER);
      const res = await b.post("/api/forge/research/open", mismatch("777"));
      assert.equal(res.status, 403);
      assert.equal((await body(res)).error.code, "forge_closed");
      assert.equal(forgeRows(closed.forge, "research_issues").length, 0);
    } finally {
      closed.restore();
    }
  });

  test("signed out, a wrong Origin, no CSRF token: refused", async () => {
    const repoId = await linkedRepo();
    assert.equal((await w.browser().post("/api/forge/research/open", mismatch(repoId), { csrf: null })).status, 401);
    const b = await signIn(w);
    assert.equal((await b.post("/api/forge/research/open", mismatch(repoId), { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post("/api/forge/research/open", mismatch(repoId), { csrf: null })).status, 403);
    assert.equal(forgeRows(w.forge, "research_issues").length, 0);
  });

  test("the day's cap of research issues per account", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    const uid = await userId();
    for (let i = 0; i < PER_ACCOUNT_DAY.research; i++) await seed.action(w.forge, { userId: uid, kind: "research_open" as never, t: T0 - 60 - i });
    const res = await open(b, mismatch(repoId));
    assert.equal(res.status, 429);
    assert.match((await body(res)).error.message, /20 research issues opened/);
  });
});

describe("reading, commenting, changing", () => {
  test("the list by paper and repository, one issue with its comments; what the reader may do", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    await open(b, mismatch(repoId));
    await open(b, { paper: PAPER, code: "https://osf.io/abcde", type: "code_error", title: "Off by one" });
    const list = await body(await b.fetch(`/api/forge/research?paper=${encodeURIComponent(PAPER)}`));
    assert.deepEqual(list.issues.map((i: Json) => i.id), [2, 1]);
    assert.equal(list.issues[1].anchor.paragraph, 14);
    assert.equal(list.issues[1].type, "mismatch");
    const mine = await body(await b.fetch(`/api/forge/research?paper=${encodeURIComponent(PAPER)}&repo=memory:${repoId}`));
    assert.deepEqual(mine.issues.map((i: Json) => i.id), [1]);
    const one = await b.fetch("/api/forge/research?id=1");
    const got = await body(one);
    assert.equal(got.issue.title, "The filter's order is 4, the paper says 2");
    assert.equal(got.issue.mine, true);
    assert.equal(got.can.edit, true);
    // Ada owns the repository on GitHub, as the registry knows it: she triages its research issues.
    assert.equal(got.can.triage, true);
    const bob = await signIn(w, "bob-fixture");
    const theirs = await body(await bob.fetch("/api/forge/research?id=1"));
    assert.deepEqual([theirs.issue.mine, theirs.can.edit, theirs.can.triage, theirs.can.comment], [false, false, false, true]);
    assert.ok(!("author_id" in got.issue));
    assert.equal((await b.fetch("/api/forge/research?id=99")).status, 404);
    assert.equal((await b.fetch("/api/forge/research?paper=not-a-doi")).status, 400);
    assert.equal((await w.browser().fetch("/api/forge/research?id=1")).status, 401);
    assert.deepEqual(w.forge.scans, []);
  });

  test("comments: 3 rows each (4 with phase 08's event; the author already follows the thread), numbered; an edit by its author; a deletion; a locked issue takes its triagers' only", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    await open(b, mismatch(repoId));
    w.forge.reset();
    const c = await b.post("/api/forge/research/comment", { id: 1, body: "The same on the fork." });
    assert.equal(c.status, 200, JSON.stringify(await body(c)));
    assert.equal(w.forge.totals.written, 4);
    await b.post("/api/forge/research/comment", { id: 1, body: "And with numpy 2." });
    const got = await body(await b.fetch("/api/forge/research?id=1"));
    assert.deepEqual(got.comments.map((x: Json) => [x.n, x.body]), [[1, "The same on the fork."], [2, "And with numpy 2."]]);
    assert.equal(got.issue.comments, 2);
    assert.equal((await b.post("/api/forge/research/comment", { id: 1, n: 1, body: "The same on the fork (v2)." })).status, 200);
    assert.equal((await b.post("/api/forge/research/comment", { id: 1, n: 2, delete: true })).status, 200);
    const after = await body(await b.fetch("/api/forge/research?id=1"));
    assert.equal(after.comments[0].body, "The same on the fork (v2).");
    assert.equal(after.comments[1].deleted, true);
    assert.equal(after.comments[1].body, "");
    // Bob, a reader: comments; may not edit Ada's, nor hide it.
    const bob = await signIn(w, "bob-fixture");
    assert.equal((await bob.post("/api/forge/research/comment", { id: 1, body: "+1" })).status, 200);
    assert.equal((await bob.post("/api/forge/research/comment", { id: 1, n: 1, body: "mine" })).status, 403);
    assert.equal((await bob.post("/api/forge/research/comment", { id: 1, n: 1, hide: "spam" })).status, 403);
    // Ada becomes a verified author of the paper: she locks; Bob may not comment any more.
    const ada2 = await signIn(w);
    role(await userId(), "verified_author", "paper", PAPER);
    assert.equal((await ada2.post("/api/forge/research/edit", { id: 1, locked: true, lockReason: "resolved" })).status, 200);
    const locked = await bob.post("/api/forge/research/comment", { id: 1, body: "again" });
    assert.equal(locked.status, 403);
    assert.equal((await body(locked)).error.code, "locked");
    assert.equal((await ada2.post("/api/forge/research/comment", { id: 1, body: "Fixed in v1.2." })).status, 200);
  });

  test("close with a resolution the type allows; reopen; labels and pins for triagers only; 2 rows a change (3 when it closes or reopens: phase 08's event)", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    await open(b, mismatch(repoId));
    w.forge.reset();
    const wrong = await b.post("/api/forge/research/edit", { id: 1, state: "closed", resolution: "data_available" });
    assert.equal(wrong.status, 400);
    const closed = await b.post("/api/forge/research/edit", { id: 1, state: "closed", resolution: "paper_corrected", ref: "10.1234/eeg.2026.erratum" });
    assert.equal(closed.status, 200, JSON.stringify(await body(closed)));
    assert.equal(w.forge.totals.written, 3);
    let got = (await body(await b.fetch("/api/forge/research?id=1"))).issue;
    assert.equal(got.state, "closed");
    assert.equal(got.close_reason, "completed");
    assert.equal(got.resolution, "paper_corrected");
    assert.equal(got.events.at(-1).k, "closed");
    assert.equal((await b.post("/api/forge/research/edit", { id: 1, state: "open" })).status, 200);
    got = (await body(await b.fetch("/api/forge/research?id=1"))).issue;
    assert.equal(got.state, "open");
    assert.equal(got.resolution, "");
    // Bob, neither the issue's author nor a triager: no labels, no change.
    const bob = await signIn(w, "bob-fixture");
    assert.equal((await bob.post("/api/forge/research/edit", { id: 1, labels: { add: ["numerical difference"] } })).status, 403);
    // Ada manages the repository (it is in her GitHub account): she labels and pins.
    const ada2 = await signIn(w);
    assert.equal((await ada2.post("/api/forge/research/edit", { id: 1, labels: { add: ["numerical difference"] }, pinned: true })).status, 200);
    got = (await body(await b.fetch("/api/forge/research?id=1"))).issue;
    assert.deepEqual(got.labels, ["numerical difference"]);
    assert.equal(got.pinned, true);
    assert.deepEqual(got.events.map((e: Json) => e.k), ["closed", "reopened", "labeled", "pinned"]);
    // Bob may not change Ada's issue; a maintainer role lets him triage it.
    const bob2 = await signIn(w, "bob-fixture");
    assert.equal((await bob2.post("/api/forge/research/edit", { id: 1, title: "Mine" })).status, 403);
    role(await userId(), "maintainer", "repo", "github.com/ada-fixture/eeg");
    assert.equal((await bob2.post("/api/forge/research/edit", { id: 1, labels: { add: ["data"] } })).status, 200);
    assert.deepEqual(w.forge.scans, []);
  });

  test("the person who linked a repository in the registry triages its research issues (D04-10's managers)", async () => {
    const b = await signIn(w);
    const uid = await userId();
    await seed.repo(w.forge, { repoId: "555", ownerLogin: "oscr-lab", name: "pipeline", linkedBy: uid }, T0 - 86_400, { papers: [{ paperId: PAPER, status: "linked" }] });
    await seed.repo(w.forge, { repoId: "556", ownerLogin: "oscr-lab", name: "other", linkedBy: "u_someone" }, T0 - 86_400, { papers: [{ paperId: PAPER, status: "linked" }] });
    const bob = await signIn(w, "bob-fixture");
    assert.equal((await bob.post("/api/forge/research/open", { ...mismatch("555"), repo: { forge: "memory", id: "555", path: "oscr-lab/pipeline" } })).status, 201);
    assert.equal((await bob.post("/api/forge/research/open", { ...mismatch("556"), repo: { forge: "memory", id: "556", path: "oscr-lab/other" } })).status, 201);
    const ada2 = await signIn(w);
    assert.equal((await ada2.post("/api/forge/research/edit", { id: 1, labels: { add: ["data"] } })).status, 200);
    assert.equal((await ada2.post("/api/forge/research/edit", { id: 2, labels: { add: ["data"] } })).status, 403);
    void b;
  });

  test("the timeline keeps the last 100 events", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    role(await userId(), "verified_author", "paper", PAPER);
    await open(b, mismatch(repoId));
    const many = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ k: "edited", by: "x", at: i })));
    w.forge.sqlite.prepare("UPDATE research_issues SET events = ? WHERE id = 1").run(many);
    assert.equal((await b.post("/api/forge/research/edit", { id: 1, labels: { add: ["data"] }, pinned: true })).status, 200);
    const events = (await body(await b.fetch("/api/forge/research?id=1"))).issue.events;
    assert.ok(events.length <= 100);
    assert.deepEqual(events.slice(-2).map((e: Json) => e.k), ["labeled", "pinned"]);
    assert.equal(events[0].at, 2);
  });

  test("a duplicate names the other research issue; three pinned per paper at most", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    role(await userId(), "verified_author", "paper", PAPER);
    for (let i = 0; i < 4; i++) await open(b, mismatch(repoId, { title: `M${i}` }));
    const dup = await b.post("/api/forge/research/edit", { id: 2, state: "closed", reason: "duplicate", duplicateOf: 1 });
    assert.equal(dup.status, 200, JSON.stringify(await body(dup)));
    assert.equal((await body(await b.fetch("/api/forge/research?id=2"))).issue.resolution_ref, "research#1");
    for (const id of [1, 2, 3]) assert.equal((await b.post("/api/forge/research/edit", { id, pinned: true })).status, 200);
    const fourth = await b.post("/api/forge/research/edit", { id: 4, pinned: true });
    assert.equal(fourth.status, 409);
    assert.equal((await b.post("/api/forge/research/edit", { id: 4, state: "closed", reason: "duplicate", duplicateOf: 99 })).status, 400);
  });
});

describe("the research issue on GitHub and in a merge", () => {
  const on = (kind: string, id: string, payload: Record<string, unknown>, extra: Partial<StartInput> = {}): StartInput => ({
    kind: kind as StartInput["kind"],
    repo: { forge: "memory", id },
    branch: null,
    expectedHead: null,
    payload,
    back: "/research/1",
    ...extra,
  });

  test("copied to GitHub by its author, once: an ordinary issue with the type's label; 2 rows", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    await ada().issues.createLabel(REF, { name: "code–paper mismatch", color: "fbca04", description: "" });
    await open(b, mismatch(repoId));
    w.forge.reset();
    const run = await authorize(w, b, on("research_copy", repoId, { id: 1 }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    const n = run.actBody!.result.number;
    const issue = await ada().issues.get(REF, n);
    assert.equal(issue.title, "The filter's order is 4, the paper says 2");
    assert.deepEqual(issue.labels, ["code–paper mismatch"]);
    assert.match(issue.body, /research#1/);
    assert.match(issue.body, /https:\/\/doi\.org\/10\.1234\/eeg\.2026/);
    assert.match(issue.body, /blob\/a{40}\/src\/filter\.py#L12-L18/);
    assert.ok(!issue.body.includes("ada@example.org"));
    assert.equal(w.forge.totals.written, 2);
    assert.equal(forgeRows(w.forge, "research_issues")[0].github_number, n);
    const again = await authorize(w, b, on("research_copy", repoId, { id: 1 }));
    assert.equal(again.act?.status, 409);
    const bob = await signIn(w, "bob-fixture");
    const theirs = await authorize(w, bob, on("research_copy", repoId, { id: 1 }), { login: "bob-fixture" });
    assert.equal(theirs.act?.status, 403);
  });

  test("a pull request that says “Fixes research#1” closes it at its merge into the default branch; one that does not, not", async () => {
    const b = await signIn(w);
    const repoId = await linkedRepo();
    await open(b, mismatch(repoId));
    await open(b, mismatch(repoId, { title: "Another" }));
    const base = await ada().git.resolve(REF, "main");
    await ada().git.createCommit(REF, { branch: "fix", expectedHead: null, createFrom: base, changes: [{ op: "put", path: "src/filter.py", content: utf8("order = 2\n") }], message: "Order 2, as the paper" });
    const pr = await ada().pulls.create(REF, { title: "Filter of order 2", body: "Fixes research#1. Mentions research#2.", head: "fix", base: "main" });
    const head = (await ada().pulls.get(REF, pr.number)).head.sha;
    w.forge.reset();
    const run = await authorize(w, b, on("pull_merge", repoId, { number: pr.number, method: "squash", head, closes: [1, 2] }, { expectedHead: head }));
    assert.equal(run.act?.status, 200, JSON.stringify(run.actBody));
    assert.deepEqual(run.actBody!.result.closed, [1]);
    assert.match(run.actBody!.result.notes.join(" "), /research#2 stays open: the pull request does not say it fixes it/);
    assert.match(run.actBody!.sentence, /closes the research issues research#1, research#2 as fixed in the code/);
    // The research issue closed and the action row; phase 08: the merge's event (no App on the repository).
    assert.equal(w.forge.totals.written, 3);
    const [one, two] = forgeRows(w.forge, "research_issues");
    assert.equal(one.state, "closed");
    assert.equal(one.resolution, "fixed_in_code");
    assert.equal(one.resolution_ref, run.actBody!.result.sha);
    assert.equal(two.state, "open");
    assert.equal(JSON.parse(String(one.events)).at(-1).k, "merged");
  });

  test("registered in act-research.ts; the kinds of the action rows", () => {
    for (const spec of RESEARCH_ACTIONS) {
      assert.equal(ACTIONS.get(spec.kind), spec);
      assert.equal(REGISTERED_IN[spec.kind], "act-research.ts");
      assert.ok(ACTION_KINDS.includes(spec.kind));
    }
    assert.deepEqual([...ROW_KINDS], [...ACTION_KINDS, ...RESEARCH_KINDS, ...SOCIAL_KINDS, ...AUTOMATION_KINDS]);
    for (const k of RESEARCH_KINDS) assert.equal(ACTIONS.get(k as never), undefined);
  });
});

describe("the pure parts", () => {
  test("references and closing keywords: research#N, never inside code, never after a word", () => {
    assert.deepEqual(researchRefs("Fixes research#12, see research#3 and `research#4`\n```\nfixes research#5\n```"), [
      { id: 12, keyword: "fixes" },
      { id: 3, keyword: null },
    ]);
    assert.deepEqual(researchClosing("Resolves: research#7. closes research#8"), [7, 8]);
    assert.deepEqual(researchRefs("myresearch#9 x/research#10"), []);
    assert.deepEqual(researchClosing("Fixes #3"), []);
  });

  test("validation of a new issue, a comment, a change", () => {
    const ok = validateOpen(mismatch("5")) as OpenParsed;
    assert.equal(ok.paper, PAPER);
    assert.deepEqual(ok.anchor, { commit: HEAD, path: "src/filter.py", start: 12, end: 18, paragraph: 14, section: "2.3 Filtering" });
    for (const bad of [
      { ...mismatch("5"), paper: "nope" },
      { ...mismatch("5"), type: "bug" },
      { ...mismatch("5"), path: "../etc/passwd" },
      { ...mismatch("5"), commit: "abc" },
      { ...mismatch("5"), lines: { start: 20, end: 3 } },
      { ...mismatch("5"), repo: { forge: "gitlab", id: "5", path: "a/b" } },
      { ...mismatch("5"), title: "two\nlines" },
      { ...mismatch("5"), labels: Array.from({ length: 11 }, (_, i) => `l${i}`) },
    ]) {
      assert.ok(isProblem(validateOpen(bad)), JSON.stringify(bad));
    }
    assert.ok(isProblem(readReport({ outcome: "failed" })));
    assert.ok(isProblem(readReport({ outcome: "maybe", observed: "x" })));
    assert.ok(isProblem(readReport({ outcome: "failed", observed: "x", datasets: ["https://evil.example/d"] })));
    assert.ok(isProblem(validateComment({ id: 1, body: "x", delete: true })));
    assert.ok(isProblem(validateComment({ id: 1, hide: "boring", n: 2 })));
    assert.ok(isProblem(validateEdit({ id: 1 })));
    assert.ok(isProblem(validateEdit({ id: 1, resolution: "fixed_in_code" })));
    assert.ok(isProblem(validateEdit({ id: 1, state: "closed", resolution: "not_a_mismatch", reason: "completed" })));
    assert.ok(isProblem(validateEdit({ id: 1, state: "closed", reason: "duplicate", duplicateOf: 1 })));
    assert.deepEqual(RESOLUTIONS_OF.mismatch, ["fixed_in_code", "paper_corrected", "not_a_mismatch"]);
  });

  test("texts lose addresses and hidden characters; a person is named by a public handle only", () => {
    assert.equal(clean("mail ada@example.org\r\nnow\u202e"), "mail [email hidden]\nnow");
    assert.deepEqual(personOf({ id: "u1", display_name: "Ada", orcid: "0000-0002-1825-0097", github_login: null, created_at: 0 }), { id: "u1", author: "0000-0002-1825-0097", via: "orcid" });
    assert.deepEqual(personOf({ id: "u1", display_name: "Ada <ada@example.org>", orcid: null, github_login: null, created_at: 0 }).author.includes("@"), false);
  });

  test("the copy's text; the merge's closes", () => {
    const text = copyBody({ id: 7, type: "reproduction", body: "It fails.", paper_id: PAPER, repo_path: "ada-fixture/eeg", commit_sha: HEAD, path: "run.py", start_line: 3, end_line: 3, paragraph: null, section: "" });
    assert.match(text, /^It fails\.\n\n---\n\n\*\*Reproduction failure\*\*, about the paper https:\/\/doi\.org\/10\.1234\/eeg\.2026\./);
    assert.match(text, /run\.py#L3 \(line 3\)/);
    assert.match(text, /research#7\.$/);
    const p = validatePullMerge({ number: 3, method: "merge", head: HEAD, closes: [4, 4, 5] }) as PullMergeParsed;
    assert.deepEqual(p.closes, [4, 5]);
    assert.ok(isProblem(validatePullMerge({ number: 3, method: "merge", head: HEAD, closes: [1, 2, 3, 4, 5, 6] })));
    assert.equal(describePullMerge({ ...p, closes: [] }), `Merge the pull request #3 (a merge commit) at ${HEAD.slice(0, 7)}`);
  });
});
