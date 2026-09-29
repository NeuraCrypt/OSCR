// Data rights (worker/rights/index.ts, with the rules of src/lib/rights.ts; the page /data-rights/):
// what the site's database holds about the account, shown to it; a request recorded with the account's
// own ORCID iD — never one the form names — and its legal deadline; one open request per right, five a
// day; no email address, anywhere; the guards every write goes through. The Mac's answers are
// tests/test_rights.py's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { oneMonthAfter } from "../../src/lib/moderation.ts";
import { checkRights, dueAt, expectedWords, KINDS, RIGHTS_PER_DAY } from "../../src/lib/rights.ts";
import { handleRights } from "../../worker/rights/index.ts";
import worker from "../../worker/index.ts";
import { ORIGIN } from "../account/browser.ts";
import { everyText, rows } from "../account/d1.ts";
import { ADA, ada, BEN, benOnGithub, body, contributions, P1, removal, type Contributions } from "./world.ts";

let w: Contributions;
beforeEach(() => {
  w = contributions();
});
afterEach(() => w.restore());

const req = (path: string, init?: RequestInit) => new Request(new URL(path, ORIGIN), init);
const code = async (res: Response) => (await body(res)).error?.code;
const ask = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, details: "", confirm: true, ...extra });
const requests = () => rows(w.db, "rights");

describe("the legal deadline", () => {
  it("is one calendar month later, as the machine computes it", () => {
    const cases = JSON.parse(readFileSync(new URL("../../../tests/fixtures/one_month.json", import.meta.url), "utf8")) as { from: string; due: string }[];
    assert.ok(cases.length >= 6);
    for (const c of cases) {
      const t = Date.parse(`${c.from}T12:34:56Z`) / 1000;
      assert.equal(new Date(oneMonthAfter(t) * 1000).toISOString().slice(0, 10), c.due, c.from);
      assert.equal(new Date(oneMonthAfter(t) * 1000).toISOString().slice(11, 19), "12:34:56", c.from);
    }
    assert.equal(dueAt(1_790_424_000), oneMonthAfter(1_790_424_000));
  });
});

describe("a request's rules", () => {
  it("one right among five, words without an email address, a rectification that says what, the confirmation", () => {
    assert.deepEqual(KINDS.map(([k]) => k), ["access", "erasure", "objection", "rectification", "account"]);
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "everything" }, "bad_kind"],
      [{ kind: undefined }, "bad_kind"],
      [{ details: "Write to me at ada.fixture@lab.example.org please." }, "email_in_text"],
      [{ details: "Write to me at ada.fixture [at] lab.example.org please." }, "email_in_text"],
      [{ details: "My handle is @ada." }, "email_in_text"],
      [{ details: "word ".repeat(201) }, "long_details"],
      [{ kind: "rectification", details: "fix" }, "short_details"],
      [{ confirm: false }, "not_confirmed"],
      [{ confirm: "yes" }, "not_confirmed"],
    ];
    for (const [change, expected] of cases) {
      const c = checkRights({ ...ask("access"), ...change });
      assert.equal(c.ok ? "ok" : c.code, expected, JSON.stringify(change));
    }
    const ok = checkRights(ask("rectification", { details: "  My affiliation is the Institute of Invented Methods.  " }));
    assert.ok(ok.ok && ok.request.details === "My affiliation is the Institute of Invented Methods.");
  });

  it("says truthfully what happens, and when", () => {
    const t = Date.parse("2026-09-29T10:00:00Z") / 1000;
    const orcid = { orcid: ADA, proof: "orcid" as const };
    const sandbox = { orcid: ADA, proof: "orcid-sandbox" as const };
    const none = { orcid: "", proof: "" as const };
    assert.match(expectedWords("access", orcid, t), /field by field — your email address masked/);
    assert.match(expectedWords("access", sandbox, t), /shows no contact detail to them/);
    assert.match(expectedWords("access", none, t), /cannot tell by itself.*by 29 October 2026 at the latest.*never closed unanswered/);
    assert.match(expectedWords("erasure", orcid, t), /are erased.*never collects again.*rewrites its history/);
    assert.match(expectedWords("objection", none, t), /by 29 October 2026 at the latest/);
    assert.match(expectedWords("rectification", orcid, t), /The operator corrects.*by 29 October 2026.*never closed unanswered/);
    assert.match(expectedWords("account", none, t), /your account is deleted.*signed out everywhere/);
    for (const [k] of KINDS) for (const who of [orcid, sandbox, none]) assert.doesNotMatch(expectedWords(k, who, t), /OSCR/);
  });
});

// ---------------------------------------------------------------------------------------------
// The routes.

test("the data rights answer for their path only, GET and POST", async () => {
  for (const path of ["/", "/api/right", "/api/rights/1", "/api/account/me"]) assert.equal(await handleRights(req(path), w.env), null, path);
  const ctx = { waitUntil() {} };
  const res = await worker.fetch(req("/api/rights"), w.env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await body(res), { signed_in: false, available: true });
  assert.equal((await handleRights(req("/api/rights", { method: "DELETE" }), w.env))?.status, 405);
  assert.deepEqual(await body((await handleRights(req("/api/rights"), { ...w.env, COMMUNITY: undefined })) as Response), {
    signed_in: false,
    available: false,
  });
});

test("signed out, from another site or without the session's token: refused, nothing written", async () => {
  const signedOut = w.browser();
  let res = await signedOut.post("/api/rights", ask("access"), { csrf: null });
  assert.equal(res.status, 401);
  const b = await ada(w);
  res = await b.post("/api/rights", ask("access"), { origin: "https://evil.example" });
  assert.equal(await code(res), "bad_origin");
  res = await b.post("/api/rights", ask("access"), { csrf: "forged" });
  assert.equal(await code(res), "bad_csrf");
  assert.equal(requests().length, 0);
  assert.equal(rows(w.db, "jobs").length, 0);
});

test("the account sees what the site's database holds about it", async () => {
  const b = await ada(w);
  const me = await body(await b.fetch("/api/rights"));
  assert.equal(me.signed_in, true);
  assert.deepEqual(me.handles, { orcid: ADA, github: null });
  assert.deepEqual(me.orcid, { orcid: ADA, proof: "orcid-sandbox" });
  assert.deepEqual(me.held.identities.map((i: { provider: string; subject: string }) => [i.provider, i.subject]), [["orcid", ADA]]);
  assert.equal(me.held.sessions.length, 1);
  assert.ok(me.held.roles.some((r: { role: string; scope_id: string }) => r.role === "verified_author" && r.scope_id === P1));
  assert.deepEqual(me.held.requests, { claims: 0, submissions: 0, edits: 0, validations: 0, reports: 0, rights: 0 });
  assert.equal(me.limits.rights, RIGHTS_PER_DAY);
  assert.ok(typeof me.csrf === "string" && me.csrf.length > 20);
});

test("a request is recorded with the account's own iD, its proof and its legal deadline, and its job", async () => {
  const b = await ada(w);
  const before = Math.floor(Date.now() / 1000);
  // The form cannot name another person: an iD in the body is ignored.
  const res = await b.post("/api/rights", ask("access", { orcid: BEN, user_id: "u_someone" }));
  assert.equal(res.status, 202);
  const out = await body(res);
  assert.equal(out.status, "open");
  assert.equal(out.request.kind, "access");
  assert.match(out.request.expected.words, /ORCID's sandbox/);
  const [row] = requests();
  assert.deepEqual([row.kind, row.orcid, row.proof, row.status, row.answer], ["access", ADA, "orcid-sandbox", "open", "{}"]);
  assert.ok((row.created_at as number) >= before);
  assert.equal(row.due_at, oneMonthAfter(row.created_at as number));
  assert.deepEqual(rows(w.db, "jobs").map((j) => `${j.kind}:${j.ref}`), [`rights:${row.id}`]);
  // Signed in with orcid.org, the proof says so.
  w.env.ORCID_ISSUER = "https://orcid.org";
  await b.post("/api/rights", ask("erasure"));
  assert.equal(requests().find((r) => r.kind === "erasure")?.proof, "orcid");
});

test("a GitHub account asks without an iD, and is told the operator answers within the month", async () => {
  const ben = await benOnGithub(w);
  const out = await body(await ben.post("/api/rights", ask("erasure", { orcid: ADA })));
  assert.equal(out.status, "open");
  assert.match(out.request.expected.words, /Your account has no ORCID iD.*at the latest \(one month/);
  const [row] = requests();
  assert.deepEqual([row.orcid, row.proof], ["", ""]);
});

test("one open request per right; five a day, counted from the rows", async () => {
  const b = await ada(w);
  assert.equal((await b.post("/api/rights", ask("access"))).status, 202);
  const again = await b.post("/api/rights", ask("access"));
  assert.equal(again.status, 409);
  const out = await body(again);
  assert.equal(out.error.code, "already_open");
  assert.equal(out.request.kind, "access");
  // Answered, it may be asked again.
  w.db.sqlite.exec("UPDATE rights SET status = 'done'");
  for (const kind of ["access", "erasure", "objection", "account"]) assert.equal((await b.post("/api/rights", ask(kind))).status, 202, kind);
  w.db.sqlite.exec("UPDATE rights SET status = 'done'");
  const tooMany = await b.post("/api/rights", ask("rectification", { details: "My affiliation changed last year." }));
  assert.equal(tooMany.status, 429);
  assert.equal(await code(tooMany), "too_many");
  assert.equal(requests().length, RIGHTS_PER_DAY);
  // A day later, the account may ask again.
  w.db.sqlite.exec("UPDATE rights SET created_at = created_at - 86401");
  assert.equal((await b.post("/api/rights", ask("rectification", { details: "My affiliation changed last year." }))).status, 202);
});

test("no email address, and the texts lose anything that looks like one", async () => {
  const b = await ada(w);
  for (const details of ["Write to ada.fixture@lab.example.org", "Write to ada＠lab.example.org"]) {
    const res = await b.post("/api/rights", ask("access", { details }));
    assert.equal(await code(res), "email_in_text");
  }
  await b.post("/api/rights", ask("rectification", { details: "My family name is spelled Fixture-Smith, not Fixture." }));
  assert.equal(requests().length, 1);
  assert.doesNotMatch(everyText(w.db), /@/);
});

test("the list carries each request's answer and deadline", async () => {
  const b = await ada(w);
  await b.post("/api/rights", ask("access"));
  const answer = JSON.stringify({ version: 1, matched: "orcid", contacts: { rows: 1, listed: [{ fields: { email: "a…e at lab.example.org" } }] } });
  w.db.sqlite.prepare("UPDATE rights SET status = 'done', answer = ?, message = 'Answered.', decided_at = created_at").run(answer);
  const me = await body(await b.fetch("/api/rights"));
  const [r] = me.requests;
  assert.equal(r.status, "done");
  assert.equal(r.answer.contacts.listed[0].fields.email, "a…e at lab.example.org");
  assert.equal(r.expected, null);
  assert.ok(r.due_at && r.decided_at);
  // The database refuses an at sign in an answer, as in every text.
  assert.throws(() => w.db.sqlite.prepare("UPDATE rights SET answer = ?").run(JSON.stringify({ email: "a@b.org" })));
});

// ---------------------------------------------------------------------------------------------
// A removal asked for personal data.

test("a removal asked for personal data that waits says the GDPR's month, never closed unanswered", async () => {
  const ben = await benOnGithub(w);
  const res = await ben.post("/api/reports", removal({ role: "named_person", reason: "personal_data", scope: "record" }));
  const out = await body(res);
  assert.equal(out.report.expected.rule, "report.personal_data");
  assert.match(out.report.expected.words, /one month, as the GDPR requires\): it is never closed unanswered/);
  const created = Date.parse(out.report.created_at) / 1000;
  assert.equal(Date.parse(out.report.expected.deadline) / 1000, oneMonthAfter(created));
  // Another reason keeps the rules' 30 days.
  const other = await body(await ben.post("/api/reports", removal({ paper_id: "doi:10.5555/oscr.fixture.3", role: "other", reason: "other" })));
  assert.equal(other.report.expected.rule, "report.review");
});
