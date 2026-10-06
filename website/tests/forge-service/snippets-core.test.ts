// Snippets, the pure core (night phase 13; snippets-core.ts): what a new snippet, a revision, an edit
// and a comment say, the rows as statements, the views. A snippet's description and comments lose
// their email addresses; a snippet's files become a manifest (no content) for the record; the reads go
// by key or an index (never a scan); the new row kinds are in the migration's CHECK.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  COMMENT_CHARS,
  SNIPPET_COMMENTS,
  SNIPPET_FILES_MAX,
  bumpForks,
  bumpStars,
  clean,
  commentViewOf,
  deleteStar,
  insertSnippet,
  insertSnippetComment,
  insertStar,
  languageOf,
  parseManifest,
  passageOf,
  publicSnippets,
  pushHistory,
  slugify,
  snippetById,
  snippetByHandle,
  snippetCommentsOf,
  snippetsOfOwner,
  stargazersOf,
  updateSnippet,
  validateComment,
  validateCreate,
  validateEdit,
  validateRevise,
  viewOf,
  type CreateParsed,
  type NewSnippet,
  type SnippetRow,
} from "../../worker/forge/service/snippets-core.ts";
import { isProblem, ROW_KINDS, SNIPPET_KINDS } from "../../worker/forge/service/types.ts";
import { CAP_OF, CAP_WORDS, KINDS_OF, OWN_CAPS, PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { fakeForgeD1, forgeRows, type FakeForgeD1 } from "./d1.ts";

const T = 1_790_000_000;
const WHO = { id: "u_ada", author: "ada-fixture", via: "github" as const };
const base = {
  title: "EEG band-pass filter",
  description: "A 1-40 Hz filter. Reach me at ada@example.org.",
  files: [{ path: "filter.py", content: "import numpy as np\nx = 1\n" }],
};

describe("languages, slugs", () => {
  test("a file's language comes from its extension, a few from the whole name", () => {
    assert.equal(languageOf("filter.py"), "Python");
    assert.equal(languageOf("Model.R"), "R");
    assert.equal(languageOf("notebook.ipynb"), "Jupyter Notebook");
    assert.equal(languageOf("Snakefile"), "Snakemake");
    assert.equal(languageOf("data.unknownext"), "");
  });

  test("a slug is lower case, a-z 0-9 and -, never empty", () => {
    assert.equal(slugify("EEG band-pass filter!"), "eeg-band-pass-filter");
    assert.equal(slugify("   "), "snippet");
    assert.ok(slugify("x".repeat(200)).length <= 48);
  });
});

describe("validating a snippet, a revision, an edit, a comment", () => {
  test("create: title, visibility, files; the description keeps no address; the manifest has no content", () => {
    const p = validateCreate(base);
    assert.ok(!isProblem(p));
    const parsed = p as CreateParsed;
    assert.equal(parsed.visibility, "public");
    assert.match(parsed.description, /\[email hidden\]/);
    assert.ok(!parsed.description.includes("ada@example.org"));
    assert.equal(parsed.manifest.length, 1);
    assert.equal(parsed.manifest[0].language, "Python");
    assert.equal(parsed.manifest[0].lines, 2);
    assert.ok(parsed.manifest[0].size > 0);
    assert.ok(!("content" in (parsed.manifest[0] as Record<string, unknown>)));
    assert.equal(parsed.changes.length, 1);
    assert.equal(parsed.changes[0].op, "put");
  });

  test("create: unlisted is accepted; a missing title, no file, a folder path, duplicate files, too many files are refused", () => {
    assert.equal((validateCreate({ ...base, visibility: "unlisted" }) as CreateParsed).visibility, "unlisted");
    assert.ok(isProblem(validateCreate({ ...base, visibility: "secret" })));
    assert.ok(isProblem(validateCreate({ ...base, title: "" })));
    assert.ok(isProblem(validateCreate({ ...base, files: [] })));
    assert.ok(isProblem(validateCreate({ ...base, files: [{ path: "a/b.py", content: "x" }] })));
    assert.ok(isProblem(validateCreate({ ...base, files: [{ path: "a.py", content: "x" }, { path: "A.py", content: "y" }] })));
    assert.ok(isProblem(validateCreate({ ...base, files: Array.from({ length: SNIPPET_FILES_MAX + 1 }, (_, i) => ({ path: `f${i}.py`, content: "x" })) })));
  });

  test("create: a paper passage is a DOI with an optional section, paragraph and lines", () => {
    const p = validateCreate({ ...base, passage: { paperId: "doi:10.1234/eeg", section: "Methods", paragraph: 3, startLine: 1, endLine: 2 } }) as CreateParsed;
    assert.equal(p.passage.paperId, "doi:10.1234/eeg");
    assert.equal(p.passage.paragraph, 3);
    assert.ok(isProblem(validateCreate({ ...base, passage: { paperId: "not-a-doi" } })));
    assert.ok(isProblem(validateCreate({ ...base, passage: { paperId: "doi:10.1/x", startLine: 5, endLine: 2 } })));
    // No DOI: an empty passage, not a refusal.
    assert.equal((validateCreate({ ...base, passage: { section: "Methods" } }) as CreateParsed).passage.paperId, "");
  });

  test("revise: names the snippet and its files; title and description are optional", () => {
    assert.ok(!isProblem(validateRevise({ id: 1, files: base.files })));
    assert.ok(!isProblem(validateRevise({ id: 1, files: base.files, title: "New" })));
    assert.ok(isProblem(validateRevise({ files: base.files })));
    assert.ok(isProblem(validateRevise({ id: 1, files: [] })));
  });

  test("edit: a change is required; only 'public' is accepted for visibility (never unlisted again)", () => {
    assert.ok(isProblem(validateEdit({ id: 1 })));
    assert.ok(!isProblem(validateEdit({ id: 1, title: "New title" })));
    assert.ok(!isProblem(validateEdit({ id: 1, visibility: "public" })));
    assert.ok(isProblem(validateEdit({ id: 1, visibility: "unlisted" })));
    assert.ok(!isProblem(validateEdit({ id: 1, commentsOff: true })));
    assert.ok(!isProblem(validateEdit({ id: 1, hide: "spam" })));
    assert.ok(isProblem(validateEdit({ id: 1, hide: "nonsense" })));
  });

  test("comment: write, edit, delete, hide, one at a time; the length limit holds; no address kept", () => {
    assert.ok(!isProblem(validateComment({ id: 1, body: "A note. Mail ada@example.org" })));
    assert.ok(!isProblem(validateComment({ id: 1, n: 2, body: "edited" })));
    assert.ok(!isProblem(validateComment({ id: 1, n: 2, delete: true })));
    assert.ok(!isProblem(validateComment({ id: 1, n: 2, hide: "abuse" })));
    assert.ok(isProblem(validateComment({ id: 1, body: "x", delete: true })));
    assert.ok(isProblem(validateComment({ id: 1, body: "x".repeat(COMMENT_CHARS + 1) })));
    const c = validateComment({ id: 1, body: "Mail ada@example.org" });
    assert.ok(!isProblem(c) && !(c as { body: string }).body!.includes("ada@example.org"));
  });
});

describe("the rows (snippets-core.ts), by key, as D1 bills them", () => {
  let db: FakeForgeD1;
  beforeEach(() => {
    db = fakeForgeD1();
  });
  const newSnip = (over: Partial<NewSnippet> = {}): NewSnippet => ({
    ownerId: "u_ada", ownerLogin: "ada", forge: "memory", repoId: "7", folder: "eeg-filter",
    revision: "a".repeat(40), visibility: "public", title: "EEG filter", description: "d",
    manifest: [{ path: "filter.py", language: "Python", size: 20, lines: 2 }],
    passage: { paperId: "", section: "", paragraph: null, startLine: null, endLine: null },
    forkedFrom: null, who: WHO, role: "verified_author", ...over,
  });

  test("a snippet writes 3 rows (its row and 2 indexes); found by id, by handle, in the owner's list", async () => {
    const before = db.totals.written;
    await db.batch([insertSnippet(db, newSnip(), T).stmt]);
    assert.equal(db.totals.written - before, 3);
    const [row] = forgeRows(db, "snippets") as unknown as SnippetRow[];
    assert.equal(row.id, 1);
    assert.equal(row.owner_login, "ada");
    assert.equal(row.author_role, "verified_author");
    assert.equal((await snippetById(db, 1).all()).results.length, 1);
    assert.equal((await snippetByHandle(db, "ada", "eeg-filter").all()).results.length, 1);
    assert.equal((await snippetsOfOwner(db, "ada").all()).results.length, 1);
    assert.deepEqual(db.scans, []);
  });

  test("discover lists public snippets, never unlisted; by the discover index", async () => {
    await db.batch([insertSnippet(db, newSnip({ folder: "a" }), T).stmt]);
    await db.batch([insertSnippet(db, newSnip({ folder: "b", visibility: "unlisted" }), T + 1).stmt]);
    const found = (await publicSnippets(db, 2 ** 31, 100).all()).results as unknown as SnippetRow[];
    assert.equal(found.length, 1);
    assert.equal(found[0].folder, "a");
    assert.deepEqual(db.scans, []);
  });

  test("a comment: its row and the snippet's count; a star is counted once; forks bump", async () => {
    await db.batch([insertSnippet(db, newSnip(), T).stmt]);
    const w = db.totals.written;
    await db.batch(insertSnippetComment(db, 1, clean("Reply to ada@example.org"), null, WHO, "", T + 10).map((x) => x.stmt));
    assert.equal(db.totals.written - w, 2);
    assert.equal((await snippetCommentsOf(db, 1).all()).results.length, 1);
    await db.batch([insertStar(db, 1, WHO, T).stmt, bumpStars(db, 1, 1, T).stmt]);
    await assert.rejects(db.batch([insertStar(db, 1, WHO, T).stmt]));
    assert.equal((await stargazersOf(db, 1).all()).results.length, 1);
    await db.batch([deleteStar(db, 1, "u_ada").stmt, bumpStars(db, 1, -1, T).stmt]);
    await db.batch([bumpForks(db, 1, T).stmt]);
    assert.equal(((await snippetById(db, 1).all()).results[0] as unknown as SnippetRow).forks, 1);
    assert.deepEqual(db.scans, []);
  });

  test("making a snippet public moves the discover index (2 rows); other edits write 1", async () => {
    await db.batch([insertSnippet(db, newSnip({ visibility: "unlisted" }), T).stmt]);
    const vis = updateSnippet(db, 1, { visibility: "public" }, T + 5);
    assert.equal(vis.rows, 2);
    const ttl = updateSnippet(db, 1, { title: "New" }, T + 6);
    assert.equal(ttl.rows, 1);
    await db.batch([vis.stmt]);
    assert.equal(((await snippetById(db, 1).all()).results[0] as unknown as SnippetRow).visibility, "public");
    assert.deepEqual(db.scans, []);
  });

  test("the views: manifest parsed, passage only when a DOI, a comment's history counted", () => {
    const row = { paper_id: "doi:10.1/x", section: "Methods", paragraph: 2, start_line: 1, end_line: 3 } as SnippetRow;
    assert.equal(passageOf(row)?.paragraph, 2);
    assert.equal(passageOf({ ...row, paper_id: "" } as SnippetRow), null);
    assert.equal(parseManifest(JSON.stringify([{ path: "a.py", language: "Python", size: 3, lines: 1 }])).length, 1);
    const view = viewOf({ ...newSnipRow(), files: JSON.stringify([{ path: "a.py", language: "Python", size: 3, lines: 1 }]) });
    assert.equal(view.files.length, 1);
    assert.equal(view.visibility, "public");
    const hist = pushHistory("[]", "old body", T);
    assert.equal(commentViewOf({ ...commentRow(), history: hist }).edits, 1);
  });
});

function newSnipRow(): SnippetRow {
  return {
    id: 1, owner_id: "u_ada", owner_login: "ada", forge: "memory", repo_id: "7", folder: "eeg-filter",
    revision: "a".repeat(40), visibility: "public", title: "EEG filter", description: "", files: "[]",
    paper_id: "", section: "", paragraph: null, start_line: null, end_line: null, stars: 0, comments: 0,
    forks: 0, forked_from: null, comments_off: 0, hidden: "", author: "ada", author_via: "github",
    author_role: "", created_at: T, updated_at: T,
  };
}
function commentRow() {
  return {
    snippet_id: 1, n: 1, author_id: "u_ada", author: "ada", author_via: "github" as const, author_role: "" as const,
    body: "x", reply_to: null, history: "[]", created_at: T, edited_at: null, deleted: 0, hidden: "" as const,
  };
}

describe("the new row kinds and their cap", () => {
  test("the snippet kinds are in ROW_KINDS", () => {
    for (const k of SNIPPET_KINDS) assert.ok((ROW_KINDS as readonly string[]).includes(k), k);
    for (const k of ["snippet_create", "snippet_revise", "snippet_fork"] as const) assert.ok((ROW_KINDS as readonly string[]).includes(k), k);
  });

  test("the native snippet writes share one cap, standing on its own; the commits count toward actions", () => {
    assert.equal(CAP_OF.snippet_comment, "snippets");
    assert.equal(CAP_OF.snippet_edit, "snippets");
    assert.equal(CAP_OF.snippet_star, "snippets");
    assert.equal(CAP_OF.snippet_create, undefined);
    assert.ok(PER_ACCOUNT_DAY.snippets > 0);
    assert.deepEqual(KINDS_OF.snippets, ["snippet_edit", "snippet_comment", "snippet_star"]);
    assert.ok(OWN_CAPS.has("snippets"));
    assert.match(CAP_WORDS.snippets(3), /snippets/);
  });
});

test("the comment limit is 5,000", () => {
  assert.equal(SNIPPET_COMMENTS, 5_000);
});
