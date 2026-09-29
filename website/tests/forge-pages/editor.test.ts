// The registry's file editor, its pure part (night phase 03, E2; src/lib/editor.ts): line endings
// and marks kept, EditorConfig, indentation (declared, detected, the default), indent and outdent,
// Enter, find and replace, names and moves as GitHub's name field reads them, the change set and
// its messages, branch names and co-authors, drafts in the browser, and which lines a change
// touches (the tracing-map notice).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  branchProblem,
  changesOf,
  coAuthorLogins,
  coveredLines,
  createMessage,
  defaultMessage,
  detectIndent,
  draftKey,
  dropDraft,
  editorConfigFor,
  editStats,
  findAll,
  hold,
  indentFor,
  indentInWords,
  indentSelection,
  indentUnit,
  isDraftKey,
  lineEnding,
  lineOf,
  newlineKeepingIndent,
  nextMatch,
  offsetOfLine,
  outdentSelection,
  patchBranch,
  pathTaken,
  readDraft,
  release,
  replaceAll,
  resolvePath,
  touchesLines,
  writeDraft,
  type Draft,
  type Edit,
} from "../../src/lib/editor.ts";

/** An edit applied to a text, as the page applies it. */
const apply = (value: string, e: Edit) => value.slice(0, e.from) + e.insert + value.slice(e.to);

describe("the file in and out of the editor", () => {
  test("line endings: LF, CRLF and CR kept; a byte-order mark kept", () => {
    assert.equal(lineEnding("a\nb\n"), "\n");
    assert.equal(lineEnding("a\r\nb\r\nc\n"), "\r\n");
    assert.equal(lineEnding("a\rb\r"), "\r");
    assert.equal(lineEnding(""), "\n");
    const h = hold("\ufeffa\r\nb\r\n");
    assert.deepEqual(h, { text: "a\nb\n", eol: "\r\n", bom: true });
    assert.equal(release(h.text + "c\n", h), "\ufeffa\r\nb\r\nc\r\n");
    assert.equal(release("x\ny", { eol: "\n", bom: false }), "x\ny");
  });

  test("EditorConfig's final newline and trailing whitespace apply on the way out only", () => {
    const held = { eol: "\n" as const, bom: false };
    assert.equal(release("a  \nb", held, { insertFinalNewline: true, trimTrailingWhitespace: true }), "a\nb\n");
    assert.equal(release("a\n\n", held, { insertFinalNewline: false }), "a");
    assert.equal(release("", held, { insertFinalNewline: true }), "");
  });

  test("EditorConfig: sections, the last one wins, unset, values in any case", () => {
    const config = "root = true\n[*]\nindent_style = space\nindent_size = 4\nend_of_line = lf\ninsert_final_newline = true\n\n[Makefile]\nindent_style = tab\n\n[*.{js,ts}]\nindent_size = 2\n[*.md]\ntrim_trailing_whitespace = FALSE\nindent_size = unset\n";
    assert.deepEqual(editorConfigFor(config, "src/a.py"), { indentStyle: "space", indentSize: 4, endOfLine: "lf", insertFinalNewline: true });
    assert.equal(editorConfigFor(config, "web/app.ts").indentSize, 2);
    assert.equal(editorConfigFor(config, "Makefile").indentStyle, "tab");
    const md = editorConfigFor(config, "README.md");
    assert.equal(md.trimTrailingWhitespace, false);
    assert.equal(md.indentSize, undefined);
    assert.deepEqual(editorConfigFor("[*]\nindent_size = tab\ntab_width = 8\n", "a.c"), { indentSize: "tab", tabWidth: 8 });
  });

  test("indentation: declared, else the file's own, else 4 spaces (tabs for a Makefile or Go)", () => {
    assert.deepEqual(detectIndent("def f():\n    if x:\n        y()\n    return 1\n"), { style: "space", size: 4 });
    assert.deepEqual(detectIndent("a:\n  b:\n    c: 1\n  d: 2\n"), { style: "space", size: 2 });
    assert.deepEqual(detectIndent("int main() {\n\treturn 0;\n\t{\n\t\tx;\n\t}\n}\n"), { style: "tab", size: 4 });
    assert.equal(detectIndent("no indentation\nat all\n"), null);
    assert.deepEqual(indentFor("  a\n", { indentStyle: "tab", tabWidth: 8 }), { style: "tab", size: 8, from: "editorconfig" });
    assert.deepEqual(indentFor("x\n", { indentStyle: "space", indentSize: 2 }), { style: "space", size: 2, from: "editorconfig" });
    assert.deepEqual(indentFor("a\n  b\n", {}), { style: "space", size: 2, from: "file" });
    assert.deepEqual(indentFor("", {}, "src/Makefile"), { style: "tab", size: 4, from: "default" });
    assert.deepEqual(indentFor("", {}, "a.py"), { style: "space", size: 4, from: "default" });
    assert.equal(indentUnit({ style: "tab", size: 8 }), "\t");
    assert.equal(indentUnit({ style: "space", size: 2 }), "  ");
    assert.equal(indentInWords({ style: "space", size: 2, from: "file" }), "2 spaces, as the file does");
  });
});

describe("editing a selection", () => {
  test("Tab at the caret: spaces to the next stop, or a tab", () => {
    const e = indentSelection("ab", { start: 1, end: 1 }, "    ");
    assert.equal(apply("ab", e), "a   b");
    assert.deepEqual(e.select, { start: 4, end: 4 });
    assert.equal(apply("ab", indentSelection("ab", { start: 0, end: 0 }, "\t")), "\tab");
  });

  test("Tab and Shift+Tab on selected lines; blank lines stay blank; a line ending the selection at its start is left out", () => {
    const v = "a\n\nb\nc\n";
    const e = indentSelection(v, { start: 0, end: 5 }, "  ");
    assert.equal(apply(v, e), "  a\n\n  b\nc\n");
    assert.deepEqual(e.select, { start: 2, end: 9 });
    const back = apply(v, e);
    const o = outdentSelection(back, e.select, 2);
    assert.equal(apply(back, o), v);
    assert.equal(apply("\t\tx", outdentSelection("\t\tx", { start: 2, end: 2 }, 4)), "\tx");
    assert.equal(apply(" x", outdentSelection(" x", { start: 1, end: 1 }, 4)), "x");
    assert.deepEqual(coveredLines("ab\ncd\nef", { start: 1, end: 6 }), { from: 0, to: 5 });
  });

  test("Enter keeps the line's indentation, one level more after an opening line", () => {
    const v = "    x = 1";
    assert.equal(apply(v, newlineKeepingIndent(v, { start: v.length, end: v.length }, "    ")), "    x = 1\n    ");
    const d = "def f():";
    assert.equal(apply(d, newlineKeepingIndent(d, { start: d.length, end: d.length }, "    ")), "def f():\n    ");
    const c = "    # note:";
    assert.equal(apply(c, newlineKeepingIndent(c, { start: c.length, end: c.length }, "  ")), "    # note:\n    ");
  });

  test("lines and offsets", () => {
    const v = "a\nbb\nccc";
    assert.equal(lineOf(v, 0), 1);
    assert.equal(lineOf(v, 3), 2);
    assert.equal(lineOf(v, 8), 3);
    assert.equal(offsetOfLine(v, 3), 5);
    assert.equal(offsetOfLine(v, 99), 5);
  });
});

describe("find and replace", () => {
  const text = "Band power, band power; BANDwidth.\nband";
  test("words, match case, whole word, regular expressions; a bad expression in words", () => {
    assert.equal((findAll(text, "band") as unknown[]).length, 4);
    assert.equal((findAll(text, "band", { matchCase: true }) as unknown[]).length, 2);
    assert.equal((findAll(text, "band", { wholeWord: true }) as unknown[]).length, 3);
    assert.deepEqual(findAll(text, "b[a-z]+d", { regex: true, matchCase: true }), [{ start: 12, end: 16 }, { start: 35, end: 39 }]);
    assert.match(findAll(text, "(", { regex: true }) as string, /regular expression/);
    assert.deepEqual(findAll(text, ""), []);
    assert.deepEqual(findAll("aaa", "a*", { regex: true }).length, 1);
  });

  test("the next match wraps around, both ways", () => {
    const m = [{ start: 2, end: 3 }, { start: 8, end: 9 }];
    assert.equal(nextMatch(m, 0), 0);
    assert.equal(nextMatch(m, 3), 1);
    assert.equal(nextMatch(m, 9), 0);
    assert.equal(nextMatch(m, 8, true), 0);
    assert.equal(nextMatch(m, 1, true), 1);
    assert.equal(nextMatch([], 0), -1);
  });

  test("replace all, with groups for regular expressions only", () => {
    assert.deepEqual(replaceAll("a.b a.b", "a.b", "x"), { value: "x x", count: 2 });
    assert.deepEqual(replaceAll("f(1) f(2)", "f\\((\\d)\\)", "g($1)", { regex: true }), { value: "g(1) g(2)", count: 2 });
    assert.deepEqual(replaceAll("$1", "$1", "$&"), { value: "$&", count: 1 });
  });
});

describe("names, moves and the change set", () => {
  test("a name as GitHub's name field reads it", () => {
    assert.equal(resolvePath("docs", "guide.md"), "docs/guide.md");
    assert.equal(resolvePath("docs", "api/index.md"), "docs/api/index.md");
    assert.equal(resolvePath("docs/api", "../intro.md"), "docs/intro.md");
    assert.equal(resolvePath("docs", "/README.md"), "README.md");
    assert.equal(resolvePath("", "../x"), null);
    assert.equal(resolvePath("", ".git/config"), null);
    assert.equal(resolvePath("", "a/.GIT/b"), null);
    assert.equal(resolvePath("", "folder/"), null);
    assert.equal(resolvePath("", "  "), null);
    assert.equal(resolvePath("", "a\\b"), null);
  });

  test("a path already taken, a folder, a file where a folder would go", () => {
    const entries = [{ path: "a.py", type: "blob" }, { path: "docs", type: "tree" }, { path: "docs/x.md", type: "blob" }];
    assert.match(pathTaken("a.py", entries, null)!, /already exists/);
    assert.equal(pathTaken("a.py", entries, "a.py"), null);
    assert.match(pathTaken("docs", entries, null)!, /is a folder/);
    assert.match(pathTaken("a.py/b.py", entries, null)!, /is a file/);
    assert.equal(pathTaken("docs/y.md", entries, null), null);
  });

  test("the change set: new, edited, unchanged, moved, moved and edited; the executable bit", () => {
    assert.deepEqual(changesOf({ original: null, path: "n.py", before: null, after: "x\n", executable: false }), [{ op: "put", path: "n.py", text: "x\n" }]);
    assert.deepEqual(changesOf({ original: "a.py", path: "a.py", before: "1", after: "2", executable: false }), [{ op: "put", path: "a.py", text: "2" }]);
    assert.deepEqual(changesOf({ original: "a.py", path: "a.py", before: "1", after: "1", executable: false }), []);
    assert.deepEqual(changesOf({ original: "a.py", path: "src/a.py", before: "1", after: "1", executable: false }), [{ op: "move", from: "a.py", to: "src/a.py" }]);
    assert.deepEqual(changesOf({ original: "a.py", path: "b.py", before: "1", after: "2", executable: false }), [{ op: "delete", path: "a.py" }, { op: "put", path: "b.py", text: "2" }]);
    assert.deepEqual(changesOf({ original: "run.sh", path: "run.sh", before: "1", after: "2", executable: true }), [{ op: "put", path: "run.sh", text: "2", executable: true }]);
  });

  test("GitHub's default messages", () => {
    assert.equal(defaultMessage([{ op: "put", path: "docs/README.md", text: "" }]), "Update README.md");
    assert.equal(defaultMessage([{ op: "move", from: "a.py", to: "b.py" }]), "Rename a.py to b.py");
    assert.equal(defaultMessage([{ op: "move", from: "a.py", to: "src/a.py" }]), "Move a.py to src");
    assert.equal(defaultMessage([{ op: "delete", path: "a.py" }, { op: "put", path: "b.py", text: "" }]), "Rename a.py to b.py");
    assert.equal(defaultMessage([{ op: "delete", path: "a/x.py" }]), "Delete x.py");
    assert.equal(defaultMessage([{ op: "delete", path: "d/a" }, { op: "delete", path: "d/b" }], { folder: "d" }), "Delete d directory");
    assert.equal(defaultMessage([], { uploaded: true }), "Add files via upload");
    assert.equal(createMessage("src/new.py"), "Create new.py");
  });

  test("branch names and GitHub's suggestion", () => {
    assert.equal(branchProblem("fix/units", ["main"]), null);
    assert.match(branchProblem("main", ["main"])!, /already exists/);
    assert.match(branchProblem("a b", [])!, /not a branch name/);
    assert.match(branchProblem("refs/heads/x", [])!, /not a branch name/);
    assert.match(branchProblem(" ", [])!, /Name the new branch/);
    assert.equal(patchBranch("ada", ["main", "ada-patch-1"]), "ada-patch-2");
    assert.equal(patchBranch(null, []), "patch-1");
  });

  test("co-authors typed as GitHub accounts", () => {
    assert.deepEqual(coAuthorLogins("@grace-h, ada  Grace-H"), ["grace-h", "ada"]);
    assert.match(coAuthorLogins("grace <g@example.org>") as string, /not a GitHub account/);
    assert.deepEqual(coAuthorLogins(""), []);
  });
});

describe("drafts in the reader's browser", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
  };
  const draft: Draft = { v: 1, base: "a".repeat(40), original: "a.py", path: "a.py", text: "x", at: 1000 };

  test("kept, read back, dropped; a month old or malformed is dropped when read; no storage is no draft", () => {
    const { m, s } = store();
    const key = draftKey({ owner: "Ada", name: "EEG" }, "main", "a.py");
    assert.equal(key, "oscr-draft:ada/eeg:main:a.py");
    assert.ok(isDraftKey(key));
    assert.ok(!isDraftKey("forge-pending"));
    assert.ok(writeDraft(s, key, draft));
    assert.deepEqual(readDraft(s, key, 2000), draft);
    assert.equal(readDraft(s, key, 1000 + 31 * 86_400), null);
    assert.equal(m.size, 0);
    m.set(key, "{not json");
    assert.equal(readDraft(s, key, 2000), null);
    writeDraft(s, key, draft);
    dropDraft(s, key);
    assert.equal(m.size, 0);
    assert.equal(readDraft(null, key, 0), null);
    assert.equal(writeDraft(null, key, draft), false);
    assert.equal(writeDraft(s, key, { ...draft, text: "x".repeat(1_000_001) }), false);
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => undefined };
    assert.equal(writeDraft(full, key, draft), false);
  });
});

describe("what a change touches", () => {
  const before = "l1\nl2\nl3\nl4\nl5\nl6\n";
  test("a line of the range changed or deleted, or lines inserted inside it; not around it", () => {
    const range = { start: 2, end: 4 };
    assert.ok(touchesLines(before, before.replace("l3", "L3"), range));
    assert.ok(touchesLines(before, before.replace("l2\n", ""), range));
    assert.ok(touchesLines(before, before.replace("l2\n", "l2\nnew\n"), range));
    assert.ok(!touchesLines(before, before.replace("l1\n", "l1\nnew\n"), range));
    assert.ok(!touchesLines(before, before.replace("l4\n", "l4\nnew\n"), range));
    assert.ok(!touchesLines(before, before.replace("l6", "L6"), range));
    assert.ok(!touchesLines(before, before, range));
    assert.deepEqual(editStats(before, before.replace("l3", "L3") + "l7\n"), { added: 2, removed: 1 });
  });
});
