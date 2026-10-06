// Submissions (worker/contributions/index.ts, checks.ts, links.ts): a DOI and code links, checked at
// once, the DOI resolves, each link answers, the place is one the registry knows, then a row and a
// job for the Mac; the draft it writes back, revised and published by the submitter.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { everyText, rows } from "../account/d1.ts";
import { checkDoi, checkLink, target } from "../../worker/contributions/checks.ts";
import { normalizeDoi, recognize } from "../../worker/contributions/links.ts";
import { ada, benOnGithub, body, contributions, type Contributions } from "./world.ts";

let w: Contributions;
beforeEach(() => {
  w = contributions();
});
afterEach(() => w.restore());

const NEW = { doi: "https://doi.org/10.5555/OSCR.fixture.7", code_urls: ["https://github.com/oscr-fixture/new-code/tree/main"], note: "The code of our paper." };

test("a submission: the DOI and the links checked at once, then a row and a job for the Mac", async () => {
  const b = await ada(w);
  const res = await b.post("/api/submissions", NEW);
  assert.equal(res.status, 201);
  const out = await body(res);
  assert.equal(out.status, "queued");
  assert.equal(out.submission.doi, "10.5555/oscr.fixture.7");
  assert.deepEqual(out.submission.code_urls, ["https://github.com/oscr-fixture/new-code"]);
  assert.equal(out.submission.checks.doi, "ok");
  assert.deepEqual(out.submission.checks.links.map((l: { key: string; outcome: string }) => [l.key, l.outcome]), [["github.com/oscr-fixture/new-code", "ok"]]);
  const [row] = rows(w.db, "submissions");
  assert.equal(row.status, "queued");
  assert.deepEqual(rows(w.db, "jobs").map((j) => [j.kind, j.ref, j.user_id]), [["submission", row.id, row.user_id]]);
  // Only the DOI proxy's handle API and the recognized place were asked.
  assert.deepEqual(w.places.asked(), ["GET https://doi.org/api/handles/10.5555/oscr.fixture.7", "HEAD https://github.com/oscr-fixture/new-code"]);
});

test("a DOI that is not registered, or a link that does not answer: refused, nothing written", async () => {
  const b = await ada(w);
  let res = await b.post("/api/submissions", { ...NEW, doi: "10.5555/not.registered" });
  assert.equal(res.status, 422);
  assert.equal((await body(res)).error.code, "unknown_doi");
  res = await b.post("/api/submissions", { ...NEW, code_urls: ["https://github.com/oscr-fixture/gone"] });
  assert.equal(res.status, 422);
  const dead = await body(res);
  assert.equal(dead.error.code, "dead_links");
  assert.match(dead.error.message, /github\.com\/oscr-fixture\/gone/);
  assert.equal(rows(w.db, "submissions").length + rows(w.db, "jobs").length, 0);
});

test("a place that does not answer, or refuses HEAD, is not refused: the Mac verifies every link anyway", async () => {
  const b = await ada(w);
  w.places.silent.add("https://zenodo.org");
  w.places.noHead.add("https://github.com");
  const res = await b.post("/api/submissions", { ...NEW, code_urls: ["https://github.com/oscr-fixture/new-code", "https://zenodo.org/records/1234567"] });
  assert.equal(res.status, 201);
  const checks = (await body(res)).submission.checks.links;
  assert.deepEqual(checks.map((c: { outcome: string; status: number | null }) => [c.outcome, c.status]), [["ok", 200], ["unchecked", null]]);
  assert.ok(w.places.asked().includes("GET https://github.com/oscr-fixture/new-code"), "GET after HEAD was refused");
});

test("only the places the registry knows: an arbitrary address is never fetched", async () => {
  const b = await ada(w);
  for (const url of ["https://example.org/our-code", "http://127.0.0.1:8080/admin", "file:///etc/passwd", "https://github.com/orgs/some-org/x", "javascript:alert(1)"]) {
    const res = await b.post("/api/submissions", { ...NEW, code_urls: [url] });
    assert.equal(res.status, 400, url);
    assert.equal((await body(res)).error.code, "unknown_place", url);
  }
  assert.deepEqual(w.places.asked(), []);
});

test("what a form may hold: a DOI, one to five links", async () => {
  const b = await ada(w);
  const code = async (payload: unknown) => (await body(await b.post("/api/submissions", payload))).error?.code;
  assert.equal(await code({ ...NEW, doi: "not a doi" }), "bad_doi");
  assert.equal(await code({ ...NEW, doi: 42 }), "bad_doi");
  assert.equal(await code({ ...NEW, code_urls: [] }), "no_links");
  assert.equal(await code({ ...NEW, code_urls: "https://github.com/a/b" }), "no_links");
  assert.equal(await code({ ...NEW, code_urls: Array.from({ length: 6 }, (_, i) => `https://github.com/a/b${i}`) }), "too_many_links");
  // The same repository twice counts once.
  const res = await b.post("/api/submissions", { ...NEW, code_urls: ["https://github.com/oscr-fixture/new-code", "github.com/oscr-fixture/new-code.git"] });
  assert.deepEqual((await body(res)).submission.code_urls, ["https://github.com/oscr-fixture/new-code"]);
});

test("one submission per account and DOI; ten a day", async () => {
  const b = await ada(w);
  assert.equal((await b.post("/api/submissions", NEW)).status, 201);
  const again = await b.post("/api/submissions", NEW);
  assert.equal(again.status, 409);
  assert.equal((await body(again)).error.code, "already_submitted");
  for (let i = 0; i < 9; i++) {
    w.places.dois.add(`10.5555/batch.${i}`);
    assert.equal((await b.post("/api/submissions", { ...NEW, doi: `10.5555/batch.${i}` })).status, 201, `submission ${i + 2}`);
  }
  w.places.dois.add("10.5555/batch.x");
  const eleventh = await b.post("/api/submissions", { ...NEW, doi: "10.5555/batch.x" });
  assert.equal(eleventh.status, 429);
  assert.equal((await body(eleventh)).error.code, "too_many");
  assert.equal(rows(w.db, "submissions").length, 10);
  // Another account has its own day.
  const ben = await benOnGithub(w);
  assert.equal((await ben.post("/api/submissions", { ...NEW, doi: "10.5555/batch.x" })).status, 201);
});

test("the draft the Mac writes back: revised by the submitter, then published", async () => {
  const b = await ada(w);
  const { submission } = await body(await b.post("/api/submissions", NEW));
  const id = submission.id as number;
  // Not before the Mac answered.
  assert.equal((await b.post(`/api/submissions/${id}/publish`)).status, 409);
  assert.equal((await b.post(`/api/submissions/${id}/revise`, { code_urls: NEW.code_urls })).status, 409);
  // The Mac's answer (oscr jobs poll): a draft, and the submitter is one of the paper's authors.
  const draft = { paper: { id: "doi:10.5555/oscr.fixture.7", title: "A submitted study" }, links: [{ key: "github.com/oscr-fixture/new-code", state: "alive", license: "MIT" }] };
  w.db.sqlite
    .prepare("UPDATE submissions SET status = 'draft', paper_id = ?, author = 1, draft = ?, updated_at = updated_at + 1 WHERE id = ?")
    .run("doi:10.5555/oscr.fixture.7", JSON.stringify(draft), id);
  const listed = await body(await b.fetch("/api/contributions"));
  assert.equal(listed.submissions[0].status, "draft");
  assert.deepEqual(listed.submissions[0].draft, draft);
  assert.equal(listed.submissions[0].url, "/paper/doi_10.5555_oscr.fixture.7/");
  // Corrected: queued again, one more job.
  let res = await b.post(`/api/submissions/${id}/revise`, { code_urls: ["https://github.com/oscr-fixture/new-code", "https://zenodo.org/records/1234567"], note: "And its archive." });
  assert.equal(res.status, 200);
  assert.equal((await body(res)).submission.revisions, 1);
  assert.deepEqual(rows(w.db, "jobs").map((j) => j.kind), ["submission", "submission"]);
  // The next draft, published: an author's goes out at once.
  w.db.sqlite.prepare("UPDATE submissions SET status = 'draft' WHERE id = ?").run(id);
  res = await b.post(`/api/submissions/${id}/publish`);
  assert.equal(res.status, 200);
  assert.equal((await body(res)).status, "publishing");
  assert.deepEqual(rows(w.db, "jobs").map((j) => j.kind), ["submission", "submission", "publish"]);
  assert.equal((await b.post(`/api/submissions/${id}/publish`)).status, 409, "once");
});

test("a draft published by someone who is not among the paper's authors goes to the owner", async () => {
  const ben = await benOnGithub(w);
  const { submission } = await body(await ben.post("/api/submissions", NEW));
  w.db.sqlite.prepare("UPDATE submissions SET status = 'draft', author = 0 WHERE id = ?").run(submission.id);
  const res = await ben.post(`/api/submissions/${submission.id}/publish`);
  assert.equal((await body(res)).status, "moderation");
  // Nobody else's submission can be touched.
  const b = await ada(w);
  assert.equal((await b.post(`/api/submissions/${submission.id}/revise`, { code_urls: NEW.code_urls })).status, 404);
  assert.equal((await b.post(`/api/submissions/${submission.id}/publish`)).status, 404);
});

test("a submission keeps no email address: the note loses it", async () => {
  const b = await ada(w);
  await b.post("/api/submissions", { ...NEW, note: "Write to ada.fixture@example.org or ada [at] example [dot] org, please." });
  const [row] = rows(w.db, "submissions");
  assert.equal(row.note, "Write to or , please.");
  assert.ok(!everyText(w.db).includes("@"));
});

test("links as people type them become the registry's keys, as the harvester's (oscr/links.py)", () => {
  const cases: [string, "code" | "data", string | null][] = [
    ["https://github.com/Owner/Repo/tree/main", "code", "github.com/owner/repo"],
    ["git@github.com:Owner/Repo.git", "code", "github.com/owner/repo"],
    ["https://gitlab.com/Group/Sub/Proj/-/tree/x", "code", "gitlab.com/group/sub/proj"],
    ["https://zenodo.org/records/123", "code", "zenodo:123"],
    ["https://doi.org/10.5281/zenodo.123", "code", "zenodo:123"],
    ["https://osf.io/AbCdE/", "code", "osf:abcde"],
    ["https://figshare.com/articles/software/_/12345", "code", "figshare:12345"],
    ["https://huggingface.co/org/model", "code", "huggingface.co/org/model"],
    ["https://codeocean.com/capsule/1234/tree", "code", "codeocean:1234"],
    ["https://openneuro.org/datasets/ds000117", "data", "openneuro:ds000117"],
    ["https://openneuro.org/datasets/ds000117", "code", null],
    ["https://dandiarchive.org/dandiset/000001", "data", "dandi:000001"],
    ["https://doi.org/10.5061/dryad.abc123", "data", "doi:10.5061/dryad.abc123"],
    ["https://doi.org/10.5061/dryad.abc123", "code", null],
    ["https://example.org/code", "code", null],
  ];
  for (const [text, role, key] of cases) assert.equal(recognize(text, role)?.key ?? null, key, `${text} (${role})`);
  assert.equal(normalizeDoi("doi: 10.1234/ABC"), "10.1234/abc");
  assert.equal(normalizeDoi("https://dx.doi.org/10.1234%2Fabc"), "10.1234/abc");
  assert.equal(normalizeDoi("11.1234/abc"), "");
});

test("the development mock of the checks: http on this machine only", async () => {
  assert.equal(target({ CHECKS_URL: "http://127.0.0.1:9480/checks" }, "https://github.com/o/r?x=1"), "http://127.0.0.1:9480/checks/github.com/o/r?x=1");
  assert.equal(target({ CHECKS_URL: "http://checks.example/checks" }, "https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(target({}, "https://github.com/o/r"), "https://github.com/o/r");
  w.places.dois.add("10.1/x");
  assert.deepEqual(await checkDoi({}, "10.1/x"), { outcome: "ok", status: 200 });
  assert.deepEqual(await checkDoi({}, "10.1/y"), { outcome: "missing", status: 404 });
  const gone = await checkLink({}, recognize("https://github.com/a/gone", "code")!);
  assert.equal(gone.outcome, "missing");
});
