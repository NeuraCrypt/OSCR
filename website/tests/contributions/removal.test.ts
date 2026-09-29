// A removal request (the page /removal/; POST /api/reports, worker/contributions/index.ts, with the
// rules of src/lib/removal.ts): sign-in required, the site's Origin and the session's CSRF token, who
// asks, what to remove (a repository and a file among the paper's own), why, a justification without
// an email address, an https evidence link, both confirmations, the paper's existence, the daily limit;
// and the rules themselves, as the page's script applies them before its review step.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  addressIn, checkRequest, DETAILS_MAX, detailsLength, factsFromPage, factsOfRecord, httpsUrl, loadFacts, paperOf, removalUrl, slugOf,
} from "../../src/lib/removal.ts";
import { returnPath, withQuery } from "../../worker/account/http.ts";
import { paperSlug } from "../../worker/account/index.ts";
import { ORIGIN } from "../account/browser.ts";
import { everyText, rows } from "../account/d1.ts";
import { FACTS_P1, FACTS_P3, FILES_P1, recordP2, staticPage } from "./assets.ts";
import { ada, benOnGithub, body, contributions, EEG, P1, P2, P3, removal, UNLICENSED, type Contributions } from "./world.ts";

let w: Contributions;
beforeEach(() => {
  w = contributions();
});
afterEach(() => w.restore());

const code = async (res: Response) => (await body(res)).error?.code;
const reports = () => rows(w.db, "reports");

// ---------------------------------------------------------------------------------------------
// Who may ask, and from where.

test("signed out, a request is refused and nothing is written", async () => {
  const b = w.browser();
  const res = await b.post("/api/reports", removal(), { csrf: null });
  assert.equal(res.status, 401);
  assert.equal(await code(res), "signed_out");
  assert.equal(reports().length, 0);
  assert.equal(rows(w.db, "jobs").length, 0);
});

test("a request must come from the site's own page, with the session's CSRF token", async () => {
  const b = await ada(w);
  let res = await b.post("/api/reports", removal(), { origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(await code(res), "bad_origin");
  res = await b.post("/api/reports", removal(), { origin: null });
  assert.equal(await code(res), "bad_origin");
  res = await b.post("/api/reports", removal(), { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(await code(res), "bad_origin");
  res = await b.post("/api/reports", removal(), { csrf: "forged-token" });
  assert.equal(res.status, 403);
  assert.equal(await code(res), "bad_csrf");
  res = await b.post("/api/reports", removal(), { csrf: null });
  assert.equal(await code(res), "bad_csrf");
  assert.equal(reports().length, 0);
  assert.equal((await b.post("/api/reports", removal())).status, 202);
});

// ---------------------------------------------------------------------------------------------
// What a request says.

test("a complete request: who asks, what, why, the justification, the evidence, the confirmations", async () => {
  const b = await ada(w);
  const res = await b.post(
    "/api/reports",
    removal({ scope: "file", repo: EEG, path: "plot.py", reason: "copyright", evidence_url: "https://lab.example/notice", role: "author" }),
  );
  assert.equal(res.status, 202);
  const out = await body(res);
  assert.equal(out.status, "open");
  assert.equal(out.report.removal_url, "/removal/?paper=doi%3A10.5555%2Foscr.fixture.1");
  assert.deepEqual(
    [out.report.role, out.report.author_verified, out.report.scope, out.report.repo, out.report.path, out.report.evidence_url, out.report.confirmed],
    ["author", true, "file", EEG, "plot.py", "https://lab.example/notice", true],
  );
  const [row] = reports();
  assert.deepEqual(
    [row.requester_role, row.author_verified, row.scope, row.scope_repo, row.scope_path, row.evidence_url, row.confirmed, row.status],
    ["author", 1, "file", EEG, "plot.py", "https://lab.example/notice", 1, "open"],
  );
  assert.equal(row.updated_at, null);
  assert.deepEqual(rows(w.db, "jobs").map((j) => `${j.kind}:${j.ref}`), [`report:${row.id}`]);
  // The paper's page state carries it, for /removal/ to show.
  const state = await body(await b.fetch(`/api/contributions/paper?id=${encodeURIComponent(P1)}`));
  assert.equal(state.report.scope, "file");
  assert.equal(state.author, true);
});

test("an author is verified only when the account's ORCID iD is among the paper's authors", async () => {
  const b = await ada(w);
  await b.post("/api/reports", removal({ paper_id: P2, role: "author" }));
  const ben = await benOnGithub(w);
  await ben.post("/api/reports", removal({ paper_id: P1, role: "author" }));
  await ben.post("/api/reports", removal({ paper_id: P3, role: "rights_holder" }));
  assert.deepEqual(
    reports().map((r) => [r.target_id, r.requester_role, r.author_verified]),
    [[P2, "author", 0], [P1, "author", 0], [P3, "rights_holder", 0]],
  );
  // Ada, on her own paper: verified.
  await b.post("/api/reports", removal({ paper_id: P1, role: "author" }));
  assert.equal(reports().find((r) => r.target_id === P1 && r.author_verified === 1)?.requester_role, "author");
});

test("who, what and why are among the form's choices", async () => {
  const b = await ada(w);
  const cases: [Record<string, unknown>, string][] = [
    [{ role: "owner" }, "bad_role"],
    [{ role: undefined }, "bad_role"],
    [{ scope: "everything" }, "bad_scope"],
    [{ reason: "spam" }, "bad_reason"],
    [{ reason: "author_request" }, "bad_reason"],
    [{ paper_id: "not a paper" }, "bad_paper"],
    [{ paper_id: "doi:10.5555/oscr.fixture.99" }, "unknown_paper"],
  ];
  for (const [change, expected] of cases) assert.equal(await code(await b.post("/api/reports", removal(change))), expected, JSON.stringify(change));
  assert.equal(reports().length, 0);
});

test("a repository and a file are the paper's own", async () => {
  const b = await ada(w);
  const cases: [Record<string, unknown>, string][] = [
    [{ scope: "repository", repo: "" }, "unknown_repo"],
    [{ scope: "repository", repo: UNLICENSED }, "unknown_repo"],
    [{ scope: "repository", repo: "https://github.com/oscr-fixture/eeg-analysis" }, "unknown_repo"],
    [{ scope: "file", repo: EEG, path: "" }, "unknown_file"],
    [{ scope: "file", repo: EEG, path: "../../etc/passwd" }, "unknown_file"],
    [{ scope: "file", repo: EEG, path: "run.m" }, "unknown_file"],
    [{ scope: "file", repo: UNLICENSED, path: "run.m" }, "unknown_repo"],
    [{ paper_id: P3, scope: "scripts" }, "no_code"],
    [{ paper_id: P3, scope: "map" }, "no_code"],
    [{ paper_id: P3, scope: "repository", repo: EEG }, "no_code"],
  ];
  for (const [change, expected] of cases) assert.equal(await code(await b.post("/api/reports", removal(change))), expected, JSON.stringify(change));
  assert.equal(reports().length, 0);
  // Paper 2 is rendered on demand: its record names its repository and its file.
  assert.equal((await b.post("/api/reports", removal({ paper_id: P2, scope: "file", repo: UNLICENSED, path: "run.m" }))).status, 202);
  for (const scope of ["scripts", "map"]) {
    assert.equal((await b.post("/api/reports", removal({ paper_id: P1, scope }))).status, scope === "scripts" ? 202 : 200, scope);
  }
  assert.equal((await b.post("/api/reports", removal({ paper_id: P1, scope: "repository", repo: EEG, path: "ignored.py" }))).status, 200);
  assert.deepEqual(
    reports().map((r) => [r.target_id, r.scope, r.scope_repo, r.scope_path]),
    [[P2, "file", UNLICENSED, "run.m"], [P1, "repository", EEG, ""]],
  );
});

test("the justification: 30 to 2,000 characters, and never an email address", async () => {
  const b = await ada(w);
  let res = await b.post("/api/reports", removal({ details: "Please remove it." }));
  assert.equal(res.status, 400);
  const short = await body(res);
  assert.equal(short.error.code, "short_details");
  assert.match(short.error.message, /at least 30 characters \(17 now\)/);
  assert.equal(await code(await b.post("/api/reports", removal({ details: `${"a".repeat(29)}     ` }))), "short_details");
  assert.equal(await code(await b.post("/api/reports", removal({ details: "word ".repeat(401) }))), "long_details");
  for (const text of [
    "Please write to me at ada.fixture@lab.example.org about this record, it is mine.",
    "Please write to me at ada.fixture [at] lab.example.org about this record, it is mine.",
    "Please write to me at ada.fixture＠lab.example.org about this record, it is mine.",
    "My handle is @ada, and this record shows my unpublished data without consent.",
  ]) {
    res = await b.post("/api/reports", removal({ details: text }));
    assert.equal(res.status, 400, text);
    const out = await body(res);
    assert.equal(out.error.code, "email_in_text", text);
    assert.equal(out.error.field, "details");
    assert.match(out.error.message, /never keeps an email address/);
  }
  assert.equal(reports().length, 0);
  assert.ok(!everyText(w.db).includes("lab.example.org"));
  // At the limits: accepted, and stored as typed (spaces collapsed).
  assert.equal((await b.post("/api/reports", removal({ details: `  ${"é".repeat(DETAILS_MAX)}  ` }))).status, 202);
  assert.equal(Array.from(String(reports()[0].details)).length, DETAILS_MAX);
});

test("the evidence link is https, or nothing", async () => {
  const b = await ada(w);
  for (const url of ["http://lab.example/notice", "javascript:alert(1)", "https://user:pw@lab.example/", "https://lab.example/?to=a@b.org", "lab.example/notice", `https://lab.example/${"x".repeat(300)}`]) {
    const res = await b.post("/api/reports", removal({ evidence_url: url }));
    assert.equal(await code(res), "bad_evidence", url);
  }
  assert.equal(reports().length, 0);
  assert.equal((await b.post("/api/reports", removal({ evidence_url: "  https://lab.example/notice  " }))).status, 202);
  assert.equal(reports()[0].evidence_url, "https://lab.example/notice");
});

test("both confirmations, given as such", async () => {
  const b = await ada(w);
  for (const change of [{ confirm_accurate: false }, { confirm_review: false }, { confirm_accurate: "yes" }, { confirm_review: undefined }]) {
    assert.equal(await code(await b.post("/api/reports", removal(change))), "not_confirmed", JSON.stringify(change));
  }
  assert.equal(reports().length, 0);
});

test("an incorrect record may still be asked for removal (the page suggests a correction first)", async () => {
  const b = await ada(w);
  assert.equal((await b.post("/api/reports", removal({ reason: "incorrect", role: "other" }))).status, 202);
});

// ---------------------------------------------------------------------------------------------
// What it costs.

test("ten new requests a day per account; completing an open one is not a new one", async () => {
  const ben = await benOnGithub(w);
  const user = rows(w.db, "users")[0].id as string;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 10; i++) {
    w.db.sqlite
      .prepare("INSERT INTO reports (user_id, target_kind, target_id, reason, details, created_at) VALUES (?, 'paper', ?, 'copyright', '', ?)")
      .run(user, `doi:10.5555/earlier.${i}`, now - 60);
  }
  const res = await ben.post("/api/reports", removal({ paper_id: P3, role: "other" }));
  assert.equal(res.status, 429);
  assert.equal(await code(res), "too_many");
  // Yesterday's requests do not count.
  w.db.sqlite.prepare("UPDATE reports SET created_at = created_at - 86400").run();
  assert.equal((await ben.post("/api/reports", removal({ paper_id: P3, role: "other" }))).status, 202);
  // Completing it while it is open: allowed whatever the count.
  w.db.sqlite.prepare("UPDATE reports SET created_at = ? WHERE target_id LIKE 'doi:10.5555/earlier.%'").run(now - 60);
  const again = await ben.post("/api/reports", removal({ paper_id: P3, role: "other", reason: "incorrect" }));
  assert.equal(again.status, 200);
  const done = reports().find((r) => r.target_id === P3)!;
  assert.equal(done.reason, "incorrect");
  assert.ok(Number(done.updated_at) >= now);
});

test("a new request writes its row, its index entry and its job; completing it, the row and a job", async () => {
  const b = await ada(w);
  const writes = () => w.db.queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q) && !/sessions/i.test(q));
  const before = writes().length;
  await b.post("/api/reports", removal());
  assert.deepEqual(writes().slice(before).map((q) => q.split(" ").slice(0, 3).join(" ")), ["INSERT INTO reports", "INSERT INTO jobs"]);
  const mid = writes().length;
  await b.post("/api/reports", removal({ reason: "other" }));
  assert.deepEqual(writes().slice(mid).map((q) => q.split(" ").slice(0, 2).join(" ")), ["UPDATE reports", "INSERT INTO"]);
});

test("the Worker reads the top of a static page only, through its own assets", async () => {
  const b = await ada(w);
  await b.post("/api/reports", removal());
  const page = `/paper/${FACTS_P1.slug}/`;
  assert.deepEqual(w.assets.asked, [page]);
  assert.ok((w.assets.read.get(page) ?? 0) <= 8192, `read ${w.assets.read.get(page)} bytes of ${w.assets.files.get(page)?.length}`);
  // A paper rendered on demand: no static page, then its record.
  w.assets.asked.length = 0;
  await b.post("/api/reports", removal({ paper_id: P2 }));
  assert.deepEqual(w.assets.asked.map((p) => p.replace(/[0-9a-f]{2}\.json$/, "NN.json")), [`/paper/${recordP2().slug}/`, "/records/paper/NN.json"]);
  // No assets bound: unavailable, never a guess.
  delete (w.env as { ASSETS?: unknown }).ASSETS;
  const res = await b.post("/api/reports", removal({ paper_id: P3 }));
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------------------------
// Sign-in returns to the same page, its query included.

test("a sign-in started on /removal/ comes back to it, with its paper", async () => {
  const b = w.browser();
  const back = removalUrl(P1);
  const landed = await b.signIn("orcid", { query: `?return=${encodeURIComponent(back)}` });
  assert.equal(landed.pathname, "/removal/");
  assert.equal(landed.searchParams.get("paper"), P1);
  assert.equal(landed.searchParams.get("signed_in"), "orcid");
  assert.equal(landed.origin, ORIGIN);
});

test("the page to come back to: a path of the site, its query URL-safe, never elsewhere", () => {
  for (const good of ["/removal/?paper=doi%3A10.5555%2Foscr.fixture.1", "/removal/?paper=doi:10.5555/oscr.fixture.1", "/x?y=1&z=2", "/account/"]) {
    assert.equal(returnPath(good), good, good);
  }
  for (const bad of [
    "//evil.example/", "/\\evil.example", "/removal/?paper=x#frag", "/removal/?next=\\\\evil", "/removal/?p=a b", "/api/reports?x=1",
    "https://evil.example/?/", "/removal/?to=<script>", "/removal/?x=" + "a".repeat(300), "/removal/?who=a@b",
  ]) {
    assert.equal(returnPath(bad), "/account/", bad);
  }
  assert.equal(withQuery("/removal/?paper=x", { signed_in: "orcid" }), "/removal/?paper=x&signed_in=orcid");
  assert.equal(withQuery("/account/", { error: "denied" }), "/account/?error=denied");
});

// ---------------------------------------------------------------------------------------------
// The rules themselves (src/lib/removal.ts), as the page applies them before its review step.

test("a page's address names a paper by its id or its DOI", () => {
  assert.deepEqual(paperOf("doi:10.5555/OSCR.fixture.1"), { id: P1, doi: "10.5555/oscr.fixture.1", slug: "doi_10.5555_oscr.fixture.1" });
  assert.equal(paperOf("https://doi.org/10.5555/oscr.fixture.1")?.id, P1);
  assert.equal(paperOf("10.5555%2Foscr.fixture.1")?.id, P1);
  assert.equal(paperOf("pmcid:pmc123")?.id, "pmcid:PMC123");
  assert.equal(paperOf("epmc:MED_123")?.slug, "epmc_med_123");
  for (const bad of [null, "", "nothing", "doi:11.1/x", "javascript:alert(1)"]) assert.equal(paperOf(bad), null, String(bad));
  for (const id of [P1, "pmcid:PMC123", "doi:10.1002/(sici)1097-4679", "epmc:MED_1"]) assert.equal(slugOf(id), paperSlug(id), id);
});

test("the form's own checks: the same rules and words as the Worker's", () => {
  const ok = checkRequest(removal({ scope: "file", repo: EEG, path: FILES_P1[1] }), FACTS_P1);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.request.path, "plot.py");
  const refused = checkRequest(removal({ details: "Too short." }), FACTS_P1);
  assert.ok(!refused.ok);
  assert.equal(!refused.ok && refused.field, "details");
  assert.equal(detailsLength("  a \n\n b  "), 3);
  assert.equal(addressIn("write to a.b@lab.example.org now"), "a.b@lab.example.org");
  assert.equal(addressIn("the at-sign in @decorators is not an address"), "");
  assert.equal(httpsUrl("https://lab.example/a?b=c"), "https://lab.example/a?b=c");
  assert.equal(httpsUrl("http://lab.example/"), "");
});

test("a paper's facts: from its record, or from the top of its static page", async () => {
  const facts = factsOfRecord(recordP2());
  assert.deepEqual(facts.repos.map((r) => [r.repo, r.copies, r.files]), [[UNLICENSED, false, ["run.m"]]]);
  const page = new Response(staticPage(FACTS_P3, 10));
  assert.deepEqual(await factsFromPage(page), FACTS_P3);
  assert.equal(await factsFromPage(new Response("<main><h1>No facts here</h1></main>")), null);
  assert.equal(await factsFromPage(new Response("nothing", { status: 404 })), null);
  // A page that says anything: only the facts' shape is kept.
  const odd = new Response(`<main><script type="application/json" id="paper-facts">{"id":"doi:10.1/x","repos":[{"repo":1},{"repo":"a/b","files":[1,"x"]}],"authors":["A",2]}</script></main>`);
  assert.deepEqual((await factsFromPage(odd))?.repos, [{ repo: "a/b", name: "a/b", url: "", license: "", copies: false, files: ["x"], more: 0 }]);
  // The browser reads the record first, the Worker the page first.
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    return w.assets.fetch(new URL(path, ORIGIN));
  };
  assert.equal((await loadFacts(get, FACTS_P1.slug, "record-first"))?.title, FACTS_P1.title);
  assert.deepEqual(asked.map((p) => p.replace(/[0-9a-f]{2}\.json$/, "NN.json")), ["/records/paper/NN.json", `/paper/${FACTS_P1.slug}/`]);
  assert.equal(await loadFacts(get, "doi_10.5555_nothing", "page-first"), null);
  assert.equal(await loadFacts(get, "../../etc", "page-first"), null);
});
