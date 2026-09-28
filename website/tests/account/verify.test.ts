// The verifications (worker/account/store.ts, verify.ts): a verified author from the papers' ORCID
// iDs, on sign-in and on request; a maintainer through GitHub's API (mocked), else a pending claim.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { world, type World } from "./browser.ts";
import { addFacts, everyText, rows } from "./d1.ts";

const ADA = "0000-0000-0000-001X";
const P1 = "doi:10.5555/oscr.fixture.1";
const P3 = "doi:10.5555/oscr.fixture.3";
const P4 = "doi:10.5555/oscr.fixture.4";

let w: World;
beforeEach(() => {
  w = world();
  addFacts(w.db, {
    papers: [
      [ADA, P1, "doi_10.5555_oscr.fixture.1", "A synthetic EEG study for the OSCR build test"],
      [ADA, P3, "doi_10.5555_oscr.fixture.3", "A synthetic study with code on request"],
      ["0000-0000-0000-0028", P4, "doi_10.5555_oscr.fixture.4", "A synthetic study that shares its data only"],
    ],
    repos: [
      ["github.com/oscr-fixture/eeg-analysis", "github.com", "oscr-fixture"],
      ["github.com/lab-org/tool", "github.com", "lab-org"],
      ["github.com/big-org/huge", "github.com", "big-org"],
      ["github.com/big-org/refused", "github.com", "big-org"],
      ["gitlab.com/synthetic-group/sub/eeg-tools", "gitlab.com", "synthetic-group"],
    ],
  });
});
afterEach(() => w.restore());

const authorRoles = () => rows(w.db, "roles").filter((r) => r.role === "verified_author").map((r) => r.scope_id).sort();

test("an ORCID iD the papers name makes a verified author of those papers, at sign-in", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  assert.deepEqual(authorRoles(), [P1, P3]);
  assert.ok(rows(w.db, "roles").every((r) => r.granted_by === "system"));
  const me = await b.me();
  assert.deepEqual(me.roles.map((r: { role: string }) => r.role), ["member", "verified_author", "verified_author"]);
  assert.deepEqual(
    me.papers.map((p: { url: string; title: string; doi: string }) => [p.url, p.doi]),
    [
      ["/paper/doi_10.5555_oscr.fixture.1/", "10.5555/oscr.fixture.1"],
      ["/paper/doi_10.5555_oscr.fixture.3/", "10.5555/oscr.fixture.3"],
    ],
  );
});

test("on request, the author roles follow the facts; a moderator's grant stays", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  const user = rows(w.db, "users")[0].id as string;
  addFacts(w.db, { papers: [[ADA, P4, "doi_10.5555_oscr.fixture.4", "A synthetic study that shares its data only"]] });
  w.db.sqlite.prepare("DELETE FROM paper_orcid WHERE orcid = ? AND paper_id = ?").run(ADA, P3);
  w.db.sqlite
    .prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, 'verified_author', 'paper', 'doi:10.5555/by-hand', 'u_moderator', 1)")
    .run(user);
  const res = await b.post("/api/account/authorship");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { granted: number; revoked: number; papers: { url: string }[] };
  assert.equal(body.granted, 1);
  assert.equal(body.revoked, 1);
  assert.deepEqual(authorRoles(), ["doi:10.5555/by-hand", P1, P4]);
  // The moderator's paper has no fact: its page is named by the same rule as catalog.slug.
  assert.ok(body.papers.some((p) => p.url === "/paper/doi_10.5555_by-hand/"));
});

test("an account without an ORCID iD has nothing to verify, until it links one", async () => {
  const b = w.browser();
  await b.signIn("github");
  const res = await b.post("/api/account/authorship");
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "no_orcid");
  assert.equal((await b.signIn("orcid")).search, "?linked=orcid");
  assert.deepEqual(authorRoles(), [P1, P3], "linking ORCID verified the papers");
});

/** The claim form, then GitHub's round trip; returns where the browser lands. */
async function claim(b: ReturnType<World["browser"]>, repo: string): Promise<{ status: number; body: Record<string, unknown>; landed?: URL }> {
  const res = await b.post("/api/account/maintainer", { repo });
  const body = (await res.json()) as Record<string, unknown>;
  if (body.status !== "redirect") return { status: res.status, body };
  return { status: res.status, body, landed: await b.approve(String(body.url)) };
}

const maintainers = () => rows(w.db, "roles").filter((r) => r.role === "maintainer").map((r) => r.scope_id);
const claims = () => rows(w.db, "claims").map((c) => [c.repo, c.status, JSON.parse(String(c.evidence)).via ?? null]);

test("the owner of the repository is its maintainer: GitHub is only asked who they are", async () => {
  w.mock.who.github = { id: 9001, login: "OSCR-Fixture", name: "The fixture lab" };
  const b = w.browser();
  await b.signIn("github");
  const calls = w.mock.githubCalls().length;
  const r = await claim(b, "https://github.com/OSCR-Fixture/EEG-Analysis/tree/main/src");
  assert.equal(r.body.status, "redirect");
  assert.equal(r.landed?.search, "?maintainer=verified&repo=github.com%2Foscr-fixture%2Feeg-analysis");
  assert.deepEqual(w.mock.githubCalls().slice(calls), ["/user"]);
  assert.deepEqual(maintainers(), ["github.com/oscr-fixture/eeg-analysis"]);
  assert.deepEqual(claims(), [["github.com/oscr-fixture/eeg-analysis", "verified", "owner"]]);
  const again = await claim(b, "oscr-fixture/eeg-analysis");
  assert.deepEqual(again.body, { status: "verified", repo: "github.com/oscr-fixture/eeg-analysis", already: true });
  const me = await b.me();
  assert.deepEqual(me.repositories, [{ repo: "github.com/oscr-fixture/eeg-analysis", url: "https://github.com/oscr-fixture/eeg-analysis" }]);
});

test("a public member of the owning organization, then a contributor, are maintainers", async () => {
  const b = w.browser();
  await b.signIn("github");
  w.mock.github.publicMembers.add("lab-org/ada-fixture");
  let calls = w.mock.githubCalls().length;
  assert.equal((await claim(b, "github.com/lab-org/tool")).landed?.searchParams.get("maintainer"), "verified");
  assert.deepEqual(w.mock.githubCalls().slice(calls), ["/user", "/orgs/lab-org/public_members/ada-fixture"]);

  w.mock.github.contributors.set("big-org/huge", ["someone", "Ada-Fixture"]);
  calls = w.mock.githubCalls().length;
  assert.equal((await claim(b, "github.com/big-org/huge")).landed?.searchParams.get("maintainer"), "verified");
  assert.deepEqual(w.mock.githubCalls().slice(calls), [
    "/user",
    "/orgs/big-org/public_members/ada-fixture",
    "/repos/big-org/huge/contributors",
  ]);
  assert.deepEqual(claims().map((c) => c[2]).sort(), ["contributor", "org_member"]);
});

test("a large repository: when the contributors are too many to list, a commit of the login", async () => {
  const b = w.browser();
  await b.signIn("github");
  w.mock.github.contributors.set("big-org/huge", Array.from({ length: 100 }, (_, i) => `person-${i}`));
  w.mock.github.commits.set("big-org/huge/ada-fixture", 3);
  w.mock.github.contributors.set("big-org/refused", 403);
  w.mock.github.commits.set("big-org/refused/ada-fixture", 1);
  assert.equal((await claim(b, "github.com/big-org/huge")).landed?.searchParams.get("maintainer"), "verified");
  assert.equal((await claim(b, "github.com/big-org/refused")).landed?.searchParams.get("maintainer"), "verified");
  assert.deepEqual(claims().map((c) => c[2]), ["commit_author", "commit_author"]);
  assert.ok(w.mock.githubCalls().length <= 2 * 4 + 1, "at most the user and three checks per claim");
});

test("no evidence: a pending claim, and no role", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  w.mock.github.contributors.set("lab-org/tool", ["someone-else"]);
  const r = await claim(b, "github.com/lab-org/tool");
  assert.equal(r.landed?.searchParams.get("maintainer"), "pending");
  assert.deepEqual(maintainers(), []);
  assert.deepEqual(claims(), [["github.com/lab-org/tool", "pending", null]]);
  // The check linked the GitHub account on the way.
  assert.deepEqual(rows(w.db, "identities").map((i) => i.provider).sort(), ["github", "orcid"]);
  const me = await b.me();
  assert.deepEqual(me.claims.map((c: { repo: string; status: string }) => [c.repo, c.status]), [["github.com/lab-org/tool", "pending"]]);
});

test("GitHub unavailable: nothing is decided", async () => {
  const b = w.browser();
  await b.signIn("github");
  w.mock.github.fail = 502;
  const r = await claim(b, "github.com/lab-org/tool");
  assert.equal(r.landed?.searchParams.get("maintainer"), "unavailable");
  assert.deepEqual(rows(w.db, "claims"), []);
  assert.deepEqual(maintainers(), []);
});

test("outside GitHub: the claim waits for a moderator at once", async () => {
  const b = w.browser();
  await b.signIn("google");
  const r = await claim(b, "https://gitlab.com/Synthetic-Group/sub/eeg-tools/-/tree/main");
  assert.equal(r.status, 202);
  assert.equal(r.body.status, "pending");
  assert.deepEqual(claims(), [["gitlab.com/synthetic-group/sub/eeg-tools", "pending", null]]);
  assert.equal(JSON.parse(String(rows(w.db, "claims")[0].evidence)).reason, "not_github");
});

test("the claim form: a repository of the registry only", async () => {
  const b = w.browser();
  await b.signIn("github");
  const unknown = await b.post("/api/account/maintainer", { repo: "https://github.com/someone/elsewhere" });
  assert.equal(unknown.status, 404);
  for (const repo of ["", "not a repository", "https://example.org/a/b", "https://zenodo.org/records/123"]) {
    assert.equal((await b.post("/api/account/maintainer", { repo })).status, 400, repo);
  }
  assert.equal((await b.post("/api/account/maintainer")).status, 400, "no body");
});

test("the GitHub account checked must be the one the account holds", async () => {
  const b = w.browser();
  await b.signIn("github");
  const res = await b.post("/api/account/maintainer", { repo: "github.com/lab-org/tool" });
  const { url } = (await res.json()) as { url: string };
  w.mock.who.github = { id: 31337, login: "lab-org", name: "Someone else" };
  const landed = await b.approve(url);
  assert.equal(landed.searchParams.get("error"), "other_github_account");
  assert.deepEqual(maintainers(), []);
});

test("a check belongs to the session that asked for it", async () => {
  const b = w.browser();
  await b.signIn("github");
  const res = await b.post("/api/account/maintainer", { repo: "github.com/lab-org/tool" });
  const { url } = (await res.json()) as { url: string };
  const other = w.browser();
  await other.signIn("github");
  b.jar.set("__Host-oscr_session", other.cookie("__Host-oscr_session") ?? "");
  assert.equal((await b.approve(url)).searchParams.get("error"), "session_changed");
  assert.deepEqual(rows(w.db, "claims"), []);
});

test("the GitHub token used for the check is never kept", async () => {
  const b = w.browser();
  await b.signIn("orcid");
  w.mock.github.publicMembers.add("lab-org/ada-fixture");
  await claim(b, "github.com/lab-org/tool");
  const text = everyText(w.db);
  assert.doesNotMatch(text, /mock-github-token|mock-orcid-token/);
  assert.ok(w.mock.log.some((l) => (l.authorization ?? "").startsWith("Bearer mock-github-token-")), "it was used");
});

test("twenty claims waiting are enough", async () => {
  const b = w.browser();
  await b.signIn("google");
  for (let i = 0; i < 20; i++) addFacts(w.db, { repos: [[`gitlab.com/g/p${i}`, "gitlab.com", "g"]] });
  for (let i = 0; i < 20; i++) assert.equal((await b.post("/api/account/maintainer", { repo: `gitlab.com/g/p${i}` })).status, 202);
  addFacts(w.db, { repos: [["gitlab.com/g/one-more", "gitlab.com", "g"]] });
  const res = await b.post("/api/account/maintainer", { repo: "gitlab.com/g/one-more" });
  assert.equal(res.status, 429);
});
