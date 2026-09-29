// The automatic moderator, as the site tells it (src/lib/moderation.ts): the same base rules as the
// registry's machine (oscr/moderation.py; both suites read tests/fixtures/moderation_rules.json), what
// the Worker answers a requester (POST /api/reports: `report.expected`), and what may be asked again
// once the rules closed it (a removal request, an author claim, a maintainer claim).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import { ASK_AGAIN, expectedWords, mayAskAgain, reportPath, REVIEW_DAYS, reviewDeadline } from "../../src/lib/moderation.ts";
import { pendingMaintainer } from "../../worker/account/store.ts";
import { rows } from "../account/d1.ts";
import { ada, benOnGithub, body, contributions, EEG, P1, P2, removal, UNLICENSED, type Contributions } from "./world.ts";

describe("the base rules", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/moderation_rules.json", import.meta.url), "utf8")) as {
    cases: { scope: string; reason: string; author_verified: boolean; maintainer: boolean; rule: string; outcome: string }[];
  };

  it("are the machine's, case by case", () => {
    assert.ok(fixture.cases.length >= 20);
    for (const c of fixture.cases) {
      assert.deepEqual(reportPath(c.scope, c.reason, c.author_verified, c.maintainer), { rule: c.rule, outcome: c.outcome }, JSON.stringify(c));
    }
  });

  it("say what will happen, and until when a request waits", () => {
    const t = Date.UTC(2026, 8, 26, 12) / 1000;
    assert.equal(reviewDeadline(t).toISOString().slice(0, 10), "2026-10-26");
    assert.equal(REVIEW_DAYS, 30);
    assert.match(expectedWords({ rule: "report.verified_author", outcome: "apply" }, t), /a verified author of the paper: within about 10 minutes it is accepted/);
    assert.match(expectedWords({ rule: "report.maintainer", outcome: "apply" }, t), /a maintainer of its code/);
    assert.match(expectedWords({ rule: "report.hide_at_once", outcome: "hide" }, t), /hide copies of the authors' code at once .* who may restore it/);
    const review = expectedWords({ rule: "report.review", outcome: "review" }, t);
    assert.match(review, /There is no human moderator on duty at the moment: if no one decides it by 26 October 2026, it is closed without removal/);
    assert.ok(!mayAskAgain({ rule: "report.review", outcome: "review" }) && mayAskAgain({ rule: "report.hide_at_once", outcome: "hide" }));
  });
});

let w: Contributions;
beforeEach(() => {
  w = contributions();
});
afterEach(() => w.restore());

const reports = () => rows(w.db, "reports");

test("the Worker tells the requester what the rules will do", async () => {
  const ben = await benOnGithub(w);
  // A stranger, the whole record: waits for the operator, until its deadline.
  let out = await body(await ben.post("/api/reports", removal({ role: "other" })));
  assert.equal(out.report.expected.outcome, "review");
  assert.match(out.report.expected.words, /no human moderator on duty/);
  assert.equal(out.report.expected.deadline.slice(0, 10), new Date(Date.parse(out.report.created_at) + 30 * 86_400_000).toISOString().slice(0, 10));
  // A stranger, one file's copy, for personal data: hidden at once.
  out = await body(await ben.post("/api/reports", removal({ paper_id: P2, role: "other", scope: "file", repo: UNLICENSED, path: "run.m", reason: "personal_data" })));
  assert.deepEqual([out.report.expected.rule, out.report.expected.outcome], ["report.hide_at_once", "hide"]);
  // A verified author: applied.
  const a = await ada(w);
  out = await body(await a.post("/api/reports", removal({ role: "rights_holder", scope: "map", reason: "other" })));
  assert.deepEqual([out.report.expected.rule, out.report.expected.outcome], ["report.verified_author", "apply"]);
  assert.equal(out.report.author_verified, false, "the stored flag stays the declared author's");
  // The account page's list says it too, while a request is open.
  const mine = await body(await ben.fetch("/api/contributions"));
  // (Newest first: Ben's copy of one file, hidden at once; his whole record, waiting.)
  assert.deepEqual(mine.reports.map((r: { expected: { outcome: string } }) => r.expected.outcome), ["hide", "review"]);
});

test("a maintainer of the named code is told that the rules apply it", async () => {
  const ben = await benOnGithub(w);
  const user = rows(w.db, "users").find((u) => u.github_login === "ben-example")!;
  w.db.sqlite.prepare("INSERT INTO roles (user_id, role, scope_kind, scope_id, granted_by, granted_at) VALUES (?, 'maintainer', 'repo', ?, 'system', 1)").run(user.id, EEG);
  const out = await body(await ben.post("/api/reports", removal({ role: "other", scope: "repository", repo: EEG, reason: "other" })));
  assert.deepEqual([out.report.expected.rule, out.report.expected.outcome], ["report.maintainer", "apply"]);
});

test("a refused request is asked again only in a way the rules decide at once", async () => {
  const ben = await benOnGithub(w);
  await ben.post("/api/reports", removal({ role: "other" }));
  const [first] = reports();
  // Closed by the rules after 30 days (oscr/moderation.py): refused.
  w.db.sqlite.prepare("UPDATE reports SET status = 'rejected', message = 'Closed without removal.', decided_at = created_at + 2592001 WHERE id = ?").run(first.id);
  // The same whole record again: refused, with how to ask again.
  let res = await ben.post("/api/reports", removal({ role: "other" }));
  assert.equal(res.status, 409);
  let out = await body(res);
  assert.equal(out.error.code, "already_decided");
  assert.equal(out.error.message, ASK_AGAIN);
  // The copies only, for copyright: open again, its time now, a new job for the Mac.
  res = await ben.post("/api/reports", removal({ role: "other", scope: "scripts", reason: "copyright" }));
  assert.equal(res.status, 202);
  out = await body(res);
  assert.equal(out.reopened, true);
  assert.deepEqual([out.report.status, out.report.scope, out.report.message, out.report.expected.outcome], ["open", "scripts", "", "hide"]);
  const [again] = reports();
  assert.equal(again.id, first.id);
  assert.equal(again.decided_at, null);
  assert.ok(again.created_at >= first.created_at);
  assert.deepEqual(rows(w.db, "jobs").map((j) => `${j.kind}:${j.ref}`), [`report:${first.id}`, `report:${first.id}`]);
  // An accepted request is never asked again.
  w.db.sqlite.prepare("UPDATE reports SET status = 'accepted' WHERE id = ?").run(first.id);
  res = await ben.post("/api/reports", removal({ role: "other", scope: "scripts", reason: "copyright" }));
  assert.equal(res.status, 409);
  assert.match((await body(res)).error.message, /accepted/);
});

test("asking again counts in the day's limit", async () => {
  const ben = await benOnGithub(w);
  await ben.post("/api/reports", removal({ role: "other" }));
  const [first] = reports();
  w.db.sqlite.prepare("UPDATE reports SET status = 'rejected' WHERE id = ?").run(first.id);
  const user = rows(w.db, "users").find((u) => u.github_login === "ben-example")!;
  // Nine more requests today, on other papers (inserted as the Worker would).
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 9; i++) {
    w.db.sqlite
      .prepare("INSERT INTO reports (user_id, target_kind, target_id, reason, details, requester_role, scope, confirmed, created_at) VALUES (?, 'paper', ?, 'other', '', 'other', 'record', 1, ?)")
      .run(user.id, `doi:10.5555/oscr.limit.${i}`, now);
  }
  const res = await ben.post("/api/reports", removal({ role: "other", scope: "scripts", reason: "copyright" }));
  assert.equal(res.status, 429);
});

test("an author claim the rules closed may be claimed again, one the owner refused may not", async () => {
  const ben = await benOnGithub(w);
  let res = await ben.post("/api/claims", { paper_id: P2, statement: "I wrote the analysis code of this paper." });
  assert.equal(res.status, 202);
  const [claim] = rows(w.db, "claims").filter((c) => c.kind === "author");
  assert.equal(JSON.parse(claim.evidence).orcid_issuer, "sandbox");
  w.db.sqlite.prepare("UPDATE claims SET status = 'rejected', decided_by = 'rules', decided_at = 1, created_at = 1, message = 'Closed.' WHERE id = ?").run(claim.id);
  res = await ben.post("/api/claims", { paper_id: P2, statement: "I added the paper to my ORCID record since." });
  assert.equal(res.status, 202);
  let [row] = rows(w.db, "claims").filter((c) => c.kind === "author");
  assert.deepEqual([row.status, row.decided_by, row.decided_at, row.message], ["pending", "", null, ""]);
  assert.ok(row.created_at > 1, "its 30 days start again");
  assert.equal(JSON.parse(row.evidence).statement, "I added the paper to my ORCID record since.");
  w.db.sqlite.prepare("UPDATE claims SET status = 'rejected', decided_by = 'owner' WHERE id = ?").run(claim.id);
  res = await ben.post("/api/claims", { paper_id: P2, statement: "Once more, please look again." });
  assert.equal((await body(res)).status, "rejected");
  [row] = rows(w.db, "claims").filter((c) => c.kind === "author");
  assert.equal(row.decided_by, "owner");
});

test("a maintainer claim the rules closed is pending again when asked again", async () => {
  await benOnGithub(w);
  const user = rows(w.db, "users").find((u) => u.github_login === "ben-example")!;
  const db = w.env.COMMUNITY!;
  await pendingMaintainer(db, user.id, "gitlab.com/lab/tool", { reason: "not_github" }, 100);
  w.db.sqlite.prepare("UPDATE claims SET status = 'rejected', decided_by = 'rules', decided_at = 200, message = 'Closed.' WHERE kind = 'maintainer'").run();
  const again = await pendingMaintainer(db, user.id, "gitlab.com/lab/tool", { reason: "not_github" }, 5000);
  assert.equal(again.status, "pending");
  const [row] = rows(w.db, "claims").filter((c) => c.kind === "maintainer");
  assert.deepEqual([row.status, row.decided_by, row.created_at, row.message], ["pending", "", 5000, ""]);
  // While pending, asked again: its first time stays.
  await pendingMaintainer(db, user.id, "gitlab.com/lab/tool", { reason: "not_github" }, 9000);
  assert.equal(rows(w.db, "claims").find((c) => c.kind === "maintainer")!.created_at, 5000);
});
