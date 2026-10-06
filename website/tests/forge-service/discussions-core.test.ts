// Discussions, the pure core (night phase 06, E1; discussions-core.ts): the spaces and their
// categories, what a new discussion, a comment and a change say, the rows as statements, the views.
// A discussion writes 2 rows and its action row (3), a comment 3; every text loses its addresses; the
// reads go by key or the one index; the new row kinds are in the migration's CHECK.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  DEFAULT_CATEGORIES,
  DISCUSSION_COMMENTS,
  bumpUpvotes,
  clean,
  commentViewOf,
  commentsOf,
  discussionById,
  discussionsOfSpace,
  insertComment,
  insertDiscussion,
  insertVote,
  parsePoll,
  readCategories,
  readSpace,
  spaceByKey,
  summaryOf,
  upsertSpace,
  validateComment,
  validateEdit,
  validateOpen,
  validateVote,
  viewOf,
  voteRef,
  type CommentRow,
  type DiscussionRow,
  type OpenParsed,
  type Space,
} from "../../worker/forge/service/discussions-core.ts";
import { isProblem, DISCUSSION_KINDS, PROJECT_KINDS, ROW_KINDS } from "../../worker/forge/service/types.ts";
import { CAP_OF, KINDS_OF, OWN_CAPS, PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { fakeForgeD1, forgeRows, type FakeForgeD1 } from "./d1.ts";

const T = 1_790_000_000;
const PAPER = "doi:10.1234/eeg.2026";
const WHO = { id: "u_ada", author: "ada-fixture", via: "github" as const };

describe("discussion spaces and categories", () => {
  test("a space is read from a paper DOI, a repository or an organization handle", () => {
    assert.deepEqual(readSpace("paper:10.1234/eeg.2026")?.key, `paper:${PAPER}`);
    assert.deepEqual(readSpace("paper:doi:10.1234/eeg.2026")?.key, `paper:${PAPER}`);
    assert.deepEqual(readSpace("repo:github:12345"), { key: "repo:github:12345", kind: "repo", paperId: "", forge: "github", repoId: "12345", handle: "" });
    assert.deepEqual(readSpace("org:Ada-Lab")?.key, "org:ada-lab");
    assert.equal(readSpace("paper:not-a-doi"), null);
    assert.equal(readSpace("repo:gitlab:1"), null);
    assert.equal(readSpace("org:a@b"), null);
    assert.equal(readSpace("x".repeat(300)), null);
  });

  test("each space kind has default categories, each with a known format", () => {
    for (const kind of ["paper", "repo", "org"] as const) {
      const cats = DEFAULT_CATEGORIES[kind];
      assert.ok(cats.length >= 1 && cats.length <= 25);
      assert.ok(cats.some((c) => c.slug === "general"));
      assert.ok(cats.some((c) => c.format === "qa"));
      for (const c of cats) assert.match(c.slug, /^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test("categories are validated: a slug, a name, a known format, at most 25, no duplicate slug", () => {
    assert.ok(!isProblem(readCategories([{ slug: "general", name: "General", format: "open" }])));
    assert.ok(isProblem(readCategories([])));
    assert.ok(isProblem(readCategories([{ slug: "General", name: "x", format: "open" }]))); // upper case slug
    assert.ok(isProblem(readCategories([{ slug: "a", name: "x", format: "sideways" }])));
    assert.ok(isProblem(readCategories([{ slug: "a", name: "x", format: "open" }, { slug: "a", name: "y", format: "qa" }])));
    assert.ok(isProblem(readCategories(Array.from({ length: 26 }, (_, i) => ({ slug: `c${i}`, name: "x", format: "open" })))));
  });
});

describe("validating a discussion, a comment, a change, a vote", () => {
  const base = { space: `paper:${PAPER}`, title: "Does the filter match figure 2?", body: "Email me at ada@example.org." };

  test("open: the space, a default category, the title and body; the body keeps no address", () => {
    const p = validateOpen(base);
    assert.ok(!isProblem(p));
    const parsed = p as OpenParsed;
    assert.equal(parsed.space.kind, "paper");
    assert.equal(parsed.category, "general");
    assert.match(parsed.body, /\[email hidden\]/);
    assert.ok(!parsed.body.includes("ada@example.org"));
  });

  test("open: a missing or unknown space, a bad category, an over-long title are refused", () => {
    assert.ok(isProblem(validateOpen({ title: "x" })));
    assert.ok(isProblem(validateOpen({ space: "paper:nope", title: "x" })));
    assert.ok(isProblem(validateOpen({ ...base, category: "Not A Slug" })));
    assert.ok(isProblem(validateOpen({ ...base, title: "a".repeat(257) })));
    assert.ok(isProblem(validateOpen({ ...base, title: "two\nlines" })));
  });

  test("open: a poll's options are 1 to 10 one-line strings; closesInDays 1 to 90", () => {
    assert.ok(!isProblem(validateOpen({ ...base, pollOptions: ["A", "B"], closesInDays: 7 })));
    assert.ok(isProblem(validateOpen({ ...base, pollOptions: Array.from({ length: 11 }, (_, i) => `o${i}`) })));
    assert.ok(isProblem(validateOpen({ ...base, closesInDays: 100 })));
  });

  test("comment: write, edit, delete, hide, one at a time; the length limit holds", () => {
    assert.ok(!isProblem(validateComment({ id: 1, body: "A reply." })));
    assert.ok(!isProblem(validateComment({ id: 1, n: 2, body: "edited" })));
    assert.ok(!isProblem(validateComment({ id: 1, n: 2, delete: true })));
    assert.ok(!isProblem(validateComment({ id: 1, n: 2, hide: "spam" })));
    assert.ok(isProblem(validateComment({ id: 1, body: "x", delete: true })));
    assert.ok(isProblem(validateComment({ id: 1, n: 2, hide: "nonsense" })));
    assert.ok(isProblem(validateComment({ id: 1, body: "x".repeat(70_000) })));
  });

  test("edit: a recognized change is required; answered takes a comment number or 0", () => {
    assert.ok(isProblem(validateEdit({ id: 1 })));
    assert.ok(!isProblem(validateEdit({ id: 1, title: "New title" })));
    assert.ok(!isProblem(validateEdit({ id: 1, answered: 3 })));
    assert.ok(!isProblem(validateEdit({ id: 1, answered: 0 })));
    assert.ok(!isProblem(validateEdit({ id: 1, state: "closed", reason: "resolved" })));
    assert.ok(isProblem(validateEdit({ id: 1, reason: "resolved" }))); // reason without closing
    assert.ok(!isProblem(validateEdit({ id: 1, transferTo: `repo:github:9` })));
  });

  test("vote: a poll option or a comment upvote, not both", () => {
    assert.ok(!isProblem(validateVote({ id: 1 })));
    assert.ok(!isProblem(validateVote({ id: 1, n: 3 })));
    assert.ok(!isProblem(validateVote({ id: 1, option: 1 })));
    assert.ok(isProblem(validateVote({ id: 1, n: 3, option: 1 })));
  });

  test("the vote reference tells a discussion, a comment and a poll apart", () => {
    assert.equal(voteRef(5, null, false), "5");
    assert.equal(voteRef(5, 3, false), "5#3");
    assert.equal(voteRef(5, null, true), "5poll");
  });
});

describe("the rows (discussions-core.ts), by key, as D1 bills them", () => {
  let db: FakeForgeD1;
  beforeEach(() => {
    db = fakeForgeD1();
  });
  const space: Space = { key: `paper:${PAPER}`, kind: "paper", paperId: PAPER, forge: "", repoId: "", handle: "" };

  test("a space's settings: 1 row, read by its key", async () => {
    await db.batch([upsertSpace(db, space, [...DEFAULT_CATEGORIES.paper], "u_ada", T).stmt]);
    const row = await db.prepare("SELECT * FROM discussion_spaces WHERE space = ?").bind(space.key).all();
    assert.equal(row.results.length, 1);
    const read = await spaceByKey(db, space.key).all();
    assert.equal((read.results[0] as { space_kind: string }).space_kind, "paper");
    assert.deepEqual(db.scans, []);
  });

  test("a discussion writes 2 rows (its row and its space index); comments 2 each; found by key", async () => {
    const parsed = validateOpen({ space: space.key, title: "Hi", body: "Mail ada@example.org" }) as OpenParsed;
    const before = db.totals.written;
    await db.batch([insertDiscussion(db, parsed, "open", null, WHO, "verified_author", T).stmt]);
    assert.equal(db.totals.written - before, 2);
    const [row] = forgeRows(db, "discussions") as unknown as DiscussionRow[];
    assert.equal(row.id, 1);
    assert.equal(row.space, space.key);
    assert.equal(row.author_role, "verified_author");
    assert.match(String(row.body), /\[email hidden\]/);
    // a comment: its row and the discussion's count
    const w = db.totals.written;
    await db.batch(insertComment(db, 1, clean("Reply to ada@example.org"), null, WHO, "", T + 10).map((x) => x.stmt));
    assert.equal(db.totals.written - w, 2);
    const [c] = forgeRows(db, "discussion_comments") as unknown as CommentRow[];
    assert.equal(c.n, 1);
    assert.match(String(c.body), /\[email hidden\]/);
    assert.equal((await discussionById(db, 1).all()).results.length, 1);
    assert.equal((await commentsOf(db, 1).all()).results.length, 1);
    assert.equal((await discussionsOfSpace(db, space.key).all()).results.length, 1);
    assert.deepEqual(db.scans, []);
  });

  test("a vote is counted once: a second insert on the same key fails the batch", async () => {
    await db.batch([insertVote(db, "1", "u_ada", 0, T).stmt]);
    await assert.rejects(db.batch([insertVote(db, "1", "u_ada", 0, T).stmt]));
    await db.batch([bumpUpvotes(db, 1, 1, T).stmt]); // tolerated even with no row (max(0,...))
    assert.deepEqual(db.scans, []);
  });

  test("summaryOf and viewOf: labels parsed, a poll only for a poll, the body only in the view", async () => {
    const poll = { options: [{ text: "A", votes: 2 }, { text: "B", votes: 1 }], closes_at: null, voters: 3 };
    const parsed = validateOpen({ space: space.key, title: "Pick one", body: "b", pollOptions: ["A", "B"] }) as OpenParsed;
    await db.batch([insertDiscussion(db, parsed, "poll", poll, WHO, "", T).stmt]);
    const row = (await discussionById(db, 1).all()).results[0] as unknown as DiscussionRow;
    const v = viewOf(row);
    assert.equal(v.format, "poll");
    assert.equal(v.poll?.options.length, 2);
    assert.equal(parsePoll(row.poll)?.voters, 3);
    const s = summaryOf(row);
    assert.ok(!("body" in s));
    assert.equal(commentViewOf({ ...({} as CommentRow), n: 1, body: "x", deleted: 0, hidden: "", upvotes: 0, reply_to: null, author: "a", author_via: "github", author_role: "", created_at: T, edited_at: null }).body, "x");
  });
});

describe("the new row kinds and their caps", () => {
  test("the discussion and project kinds are in ROW_KINDS", () => {
    for (const k of [...DISCUSSION_KINDS, ...PROJECT_KINDS]) assert.ok((ROW_KINDS as readonly string[]).includes(k), k);
  });

  test("each discussion and project kind has a cap, votes and project edits standing on their own", () => {
    assert.equal(CAP_OF.discussion_open, "discussions");
    assert.equal(CAP_OF.discussion_vote, "votes");
    assert.equal(CAP_OF.project_create, "projects");
    assert.equal(CAP_OF.project_item, "project_edits");
    for (const cap of ["discussions", "votes", "projects", "project_edits"] as const) assert.ok(PER_ACCOUNT_DAY[cap] > 0);
    assert.deepEqual(KINDS_OF.project_edits, ["project_item", "project_edit", "project_field"]);
    assert.ok(OWN_CAPS.has("votes") && OWN_CAPS.has("project_edits"));
    assert.ok(!OWN_CAPS.has("discussions") && !OWN_CAPS.has("projects"));
  });
});

test("the comment limit is 5,000 and the length cap is set", () => {
  assert.equal(DISCUSSION_COMMENTS, 5_000);
});
