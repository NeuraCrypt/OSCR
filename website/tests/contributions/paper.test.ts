// What a reader may do from a paper's page (worker/contributions/index.ts): the page's state, a
// manual author claim, a correction of the record (verified authors and maintainers only), the
// validation of the tracing map (verified authors, with their ORCID iD), a removal request.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { everyText, rows } from "../account/d1.ts";
import { orcidProof } from "../../worker/contributions/index.ts";
import { ada, ADA, benOnGithub, body, contributions, DIGEST, EEG, P1, P2, P3, removal, UNLICENSED, type Contributions } from "./world.ts";

let w: Contributions;
beforeEach(() => {
  w = contributions();
});
afterEach(() => w.restore());

const jobs = () => rows(w.db, "jobs").map((j) => `${j.kind}:${j.ref}`);
const state = async (b: { fetch: (p: string) => Promise<Response> }, paper: string) =>
  body(await b.fetch(`/api/contributions/paper?id=${encodeURIComponent(paper)}`));

test("a paper's page learns who reads it and what they may do there", async () => {
  const b = await ada(w);
  let s = await state(b, P1);
  assert.equal(s.signed_in, true);
  assert.equal(s.author, true);
  assert.equal(s.user.orcid, ADA);
  assert.deepEqual(s.maintains, []);
  assert.equal(s.claim, null);
  assert.equal(s.validation, null);
  assert.match(s.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await state(b, P2)).author, false);
  // Once asked, the page shows each request's state.
  await b.post("/api/validations", { paper_id: P1, map_digest: DIGEST });
  await b.post("/api/reports", removal({ paper_id: P1 }));
  s = await state(b, P1);
  assert.equal(s.validation.status, "queued");
  assert.equal(s.report.status, "open");
  assert.ok(!JSON.stringify(s).includes("@"));
});

// ---------------------------------------------------------------------------------------------
// Manual author claims.

test("an author the metadata does not name claims the paper by hand: pending, for the owner", async () => {
  const ben = await benOnGithub(w);
  const claim = { paper_id: P2, statement: "I am the second author; my ORCID iD is missing from the paper's metadata.", link: "https://lab.example/people/ben" };
  const res = await ben.post("/api/claims", claim);
  assert.equal(res.status, 202);
  const out = await body(res);
  assert.equal(out.status, "pending");
  assert.equal(out.claim.link, "https://lab.example/people/ben");
  const [row] = rows(w.db, "claims");
  assert.equal(row.kind, "author");
  assert.equal(row.paper_id, P2);
  assert.equal(row.status, "pending");
  assert.deepEqual(JSON.parse(String(row.evidence)).github, "ben-example");
  assert.deepEqual(jobs(), [`claim:${row.id}`]);
  // Asked again while pending: the same claim, its evidence replaced, one more job.
  const again = await body(await ben.post("/api/claims", { ...claim, statement: "Second author, see the lab's page." }));
  assert.equal(again.claim.id, row.id);
  assert.equal(rows(w.db, "claims").length, 1);
  assert.equal(JSON.parse(String(rows(w.db, "claims")[0].evidence)).statement, "Second author, see the lab's page.");
  assert.deepEqual(jobs(), [`claim:${row.id}`, `claim:${row.id}`]);
  // The owner decides (oscr claims refuse): a decided claim stays as it is.
  w.db.sqlite.prepare("UPDATE claims SET status = 'rejected', decided_by = 'owner', decided_at = 1, message = 'Not among the authors.' WHERE id = ?").run(row.id as number);
  const decided = await body(await ben.post("/api/claims", claim));
  assert.equal(decided.status, "rejected");
  assert.equal(decided.claim.message, "Not among the authors.");
  assert.equal(jobs().length, 2);
  // The page shows it.
  assert.equal((await state(ben, P2)).claim.status, "rejected");
});

test("a claim needs a statement; a verified author needs none; the link is a web address", async () => {
  const b = await ada(w);
  assert.equal((await body(await b.post("/api/claims", { paper_id: P1, statement: "" }))).status, "verified");
  const ben = await benOnGithub(w);
  assert.equal((await body(await ben.post("/api/claims", { paper_id: P2, statement: "me" }))).error.code, "no_statement");
  assert.equal((await body(await ben.post("/api/claims", { paper_id: P2, statement: "I wrote the paper.", link: "javascript:alert(1)" }))).error.code, "bad_link");
  assert.equal((await body(await ben.post("/api/claims", { paper_id: "not a paper", statement: "I wrote the paper." }))).error.code, "bad_paper");
  assert.equal(rows(w.db, "claims").length, 0);
});

test("a claim's words keep no email address", async () => {
  const ben = await benOnGithub(w);
  await ben.post("/api/claims", { paper_id: P2, statement: "Ask me at ben.example@lab.example.org, I am the second author." });
  const [row] = rows(w.db, "claims");
  assert.equal(JSON.parse(String(row.evidence)).statement, "Ask me at , I am the second author.");
  assert.ok(!everyText(w.db).includes("@"));
});

test("claims: ten a day, and twenty waiting at once", async () => {
  const ben = await benOnGithub(w);
  for (let i = 0; i < 10; i++) {
    assert.equal((await ben.post("/api/claims", { paper_id: `doi:10.5555/claim.${i}`, statement: "I am one of the authors." })).status, 202);
  }
  const res = await ben.post("/api/claims", { paper_id: "doi:10.5555/claim.x", statement: "I am one of the authors." });
  assert.equal(res.status, 429);
});

test("a maintainer claim that waits (Phase 5) is now in the owner's queue too", async () => {
  const b = await ada(w);
  w.db.sqlite.prepare("INSERT INTO repo_owner (repo, host, owner) VALUES ('gitlab.com/lab/tool', 'gitlab.com', 'lab')").run();
  const res = await b.post("/api/account/maintainer", { repo: "https://gitlab.com/lab/tool" });
  assert.equal(res.status, 202);
  const [claim] = rows(w.db, "claims");
  assert.deepEqual(jobs(), [`claim:${claim.id}`]);
});

// ---------------------------------------------------------------------------------------------
// Edits.

test("a verified author corrects the record: well-defined changes, a job for the Mac", async () => {
  const b = await ada(w);
  const changes = [
    { op: "add", url: "https://zenodo.org/records/1234567", role: "code" },
    { op: "add", url: "https://openneuro.org/datasets/ds000117", role: "data" },
    { op: "role", repo: "doi:10.5555/oscr.fixture.data.1", role: "data" },
    { op: "remove", repo: "github.com/someone/else" },
  ];
  const res = await b.post("/api/edits", { paper_id: P1, changes, note: "The archive of the code, and the dataset." });
  assert.equal(res.status, 202);
  const out = await body(res);
  assert.equal(out.edit.as_role, "verified_author");
  assert.deepEqual(out.edit.changes, [
    { op: "add", url: "https://zenodo.org/records/1234567", key: "zenodo:1234567", role: "code" },
    { op: "add", url: "https://openneuro.org/datasets/ds000117", key: "openneuro:ds000117", role: "data" },
    { op: "role", repo: "doi:10.5555/oscr.fixture.data.1", role: "data" },
    { op: "remove", repo: "github.com/someone/else" },
  ]);
  const [row] = rows(w.db, "edits");
  assert.equal(row.status, "queued");
  assert.deepEqual(jobs(), [`edit:${row.id}`]);
  // The links added were checked; nothing else was asked.
  assert.deepEqual(w.places.asked(), ["HEAD https://zenodo.org/records/1234567", "HEAD https://openneuro.org/datasets/ds000117"]);
  const listed = await body(await b.fetch("/api/contributions"));
  assert.equal(listed.edits[0].url, "/paper/doi_10.5555_oscr.fixture.1/");
});

test("only a verified author of the paper, or a maintainer of its code", async () => {
  const changes = [{ op: "role", repo: EEG, role: "code" }];
  const b = await ada(w);
  const res = await b.post("/api/edits", { paper_id: P2, changes });
  assert.equal(res.status, 403);
  assert.equal((await body(res)).error.code, "not_author");
  const ben = await benOnGithub(w);
  assert.equal((await ben.post("/api/edits", { paper_id: P1, changes })).status, 403);
  // Ben maintains github.com/oscr-fixture/unlicensed, the code of paper 2.
  const user = rows(w.db, "users").find((u) => u.github_login === "ben-example")!.id as string;
  w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, 'maintainer', 'repo', ?, 'system', 1)").run(user, UNLICENSED);
  // GitHub showed him as a contributor only: not trusted to change the paper's record (lib/moderation.ts).
  w.db.sqlite
    .prepare("INSERT INTO claims (user_id, kind, repo, evidence, status, created_at, decided_by, decided_at) VALUES (?, 'maintainer', ?, ?, 'verified', 1, 'system', 1)")
    .run(user, UNLICENSED, JSON.stringify({ via: "contributor" }));
  const contributor = await ben.post("/api/edits", { paper_id: P2, as: "maintainer", repo: UNLICENSED, changes: [{ op: "role", repo: UNLICENSED, role: "tool" }] });
  assert.equal(contributor.status, 403);
  assert.match((await body(contributor)).error.message, /Only the owner of this repository, or a public member of its organization/);
  // Its owner, then.
  w.db.sqlite.prepare("UPDATE claims SET evidence = ? WHERE user_id = ? AND kind = 'maintainer'").run(JSON.stringify({ via: "owner" }), user);
  assert.equal((await ben.post("/api/edits", { paper_id: P1, as: "maintainer", repo: UNLICENSED, changes })).status, 403, "not paper 1's code");
  let ok = await ben.post("/api/edits", { paper_id: P2, as: "maintainer", repo: `https://${UNLICENSED}`, changes: [{ op: "role", repo: UNLICENSED, role: "tool" }] });
  assert.equal(ok.status, 202);
  assert.equal((await body(ok)).edit.as_role, "maintainer");
  // A maintainer speaks for their own repository: removing another link is not theirs to do.
  ok = await ben.post("/api/edits", { paper_id: P2, as: "maintainer", repo: UNLICENSED, changes: [{ op: "remove", repo: EEG }] });
  assert.equal(ok.status, 403);
  // Adding a link is.
  ok = await ben.post("/api/edits", { paper_id: P2, as: "maintainer", repo: UNLICENSED, changes: [{ op: "add", url: "https://zenodo.org/records/1234567", role: "code" }] });
  assert.equal(ok.status, 202);
  assert.deepEqual(rows(w.db, "edits").map((e) => [e.as_role, e.repo]), [["maintainer", UNLICENSED], ["maintainer", UNLICENSED]]);
});

test("a change is one of three shapes; a link added must answer", async () => {
  const b = await ada(w);
  const code = async (changes: unknown) => (await body(await b.post("/api/edits", { paper_id: P1, changes }))).error?.code;
  assert.equal(await code([]), "no_changes");
  assert.equal(await code("remove everything"), "no_changes");
  assert.equal(await code(Array.from({ length: 11 }, (_, i) => ({ op: "remove", repo: `github.com/a/b${i}` }))), "too_many_changes");
  assert.equal(await code([{ op: "rewrite", html: "<script>" }]), "bad_change");
  assert.equal(await code([{ op: "role", repo: EEG, role: "owner" }]), "bad_change");
  assert.equal(await code([{ op: "remove", repo: "https://github.com/a/b" }]), "bad_change");
  assert.equal(await code([{ op: "add", url: "https://github.com/a/b", role: "tool" }]), "bad_change");
  assert.equal(await code([{ op: "add", url: "https://example.org/x", role: "code" }]), "unknown_place");
  assert.equal(await code([{ op: "add", url: "https://github.com/oscr-fixture/gone", role: "code" }]), "dead_links");
  assert.equal(rows(w.db, "edits").length, 0);
});

// ---------------------------------------------------------------------------------------------
// Validations.

test("a verified author validates the map with the ORCID iD they signed in with", async () => {
  const b = await ada(w);
  const res = await b.post("/api/validations", { paper_id: P1, map_digest: DIGEST.toUpperCase() });
  assert.equal(res.status, 202);
  const out = await body(res);
  assert.equal(out.validation.orcid, ADA);
  assert.equal(out.validation.proof, "orcid-sandbox", "the sandbox's iDs are tests");
  const [row] = rows(w.db, "validations");
  assert.deepEqual([row.orcid, row.map_digest, row.status, row.proof], [ADA, DIGEST, "queued", "orcid-sandbox"]);
  assert.deepEqual(jobs(), [`validation:${row.id}`]);
  // Once queued, not twice; once deposited, not again for the same map.
  assert.equal((await body(await b.post("/api/validations", { paper_id: P1, map_digest: DIGEST }))).error.code, "already_queued");
  w.db.sqlite.prepare("UPDATE validations SET status = 'deposited', instance = 'sandbox', doi = '10.5072/zenodo.1' WHERE id = ?").run(row.id as number);
  assert.equal((await body(await b.post("/api/validations", { paper_id: P1, map_digest: DIGEST }))).error.code, "already_validated");
  // A map that changed since can be validated again.
  assert.equal((await b.post("/api/validations", { paper_id: P1, map_digest: "cd".repeat(32) })).status, 202);
});

test("the proof is 'orcid' only when the registry signs in with orcid.org", () => {
  assert.equal(orcidProof({}), "orcid-sandbox");
  assert.equal(orcidProof({ ORCID_ISSUER: "https://sandbox.orcid.org" }), "orcid-sandbox");
  assert.equal(orcidProof({ ORCID_ISSUER: "https://orcid.org/" }), "orcid");
});

test("no validation without an ORCID iD, by someone who is not an author, or of another map", async () => {
  const ben = await benOnGithub(w);
  assert.equal((await body(await ben.post("/api/validations", { paper_id: P2, map_digest: DIGEST }))).error.code, "no_orcid");
  const b = await ada(w);
  assert.equal((await body(await b.post("/api/validations", { paper_id: P2, map_digest: DIGEST }))).error.code, "not_author");
  assert.equal((await body(await b.post("/api/validations", { paper_id: P1, map_digest: "not-a-digest" }))).error.code, "bad_map");
  assert.equal(rows(w.db, "validations").length, 0);
});

test("a verified author by the owner's decision validates too (the Mac checks the ORCID iD)", async () => {
  const b = await ada(w);
  const user = rows(w.db, "users")[0].id as string;
  w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, 'verified_author', 'paper', ?, 'owner', 1)").run(user, P2);
  assert.equal((await b.post("/api/validations", { paper_id: P2, map_digest: DIGEST })).status, 202);
});

// ---------------------------------------------------------------------------------------------
// Removal requests (the page /removal/; every rule of the form: removal.test.ts).

test("a removal request from any record: open, for the owner; completed while open; decided, it stays", async () => {
  const ben = await benOnGithub(w);
  const res = await ben.post("/api/reports", removal({ paper_id: P3, role: "named_person", reason: "personal_data" }));
  assert.equal(res.status, 202);
  const [row] = rows(w.db, "reports");
  assert.deepEqual([row.status, row.requester_role, row.scope, row.confirmed, row.author_verified], ["open", "named_person", "record", 1, 0]);
  assert.deepEqual(jobs(), [`report:${row.id}`]);
  const again = await ben.post("/api/reports", removal({ paper_id: P3, role: "named_person", reason: "incorrect" }));
  assert.equal(again.status, 200);
  assert.equal((await body(again)).updated, true);
  assert.equal(rows(w.db, "reports")[0].reason, "incorrect");
  assert.equal(jobs().length, 2);
  // Decided: it stays decided.
  w.db.sqlite.prepare("UPDATE reports SET status = 'rejected', message = 'The record is correct.' WHERE id = ?").run(row.id as number);
  const decided = await ben.post("/api/reports", removal({ paper_id: P3 }));
  assert.equal(decided.status, 409);
  assert.equal((await body(decided)).report.message, "The record is correct.");
});

test("the account page lists what the account asked", async () => {
  const b = await ada(w);
  await b.post("/api/reports", removal({ paper_id: P3, reason: "copyright" }));
  await b.post("/api/validations", { paper_id: P1, map_digest: DIGEST });
  await b.post("/api/edits", { paper_id: P1, changes: [{ op: "remove", repo: "github.com/a/b" }] });
  const listed = await body(await b.fetch("/api/contributions"));
  assert.deepEqual(
    [listed.submissions.length, listed.edits.length, listed.validations.length, listed.reports.length],
    [0, 1, 1, 1],
  );
  assert.equal(listed.reports[0].url, "/paper/doi_10.5555_oscr.fixture.3/");
  assert.equal(listed.reports[0].removal_url, "/removal/?paper=doi%3A10.5555%2Foscr.fixture.3");
  assert.deepEqual(listed.limits, { submissions: 10, edits: 20, validations: 10, reports: 10, claims: 10 });
});
