// CODEOWNERS read in the browser (night phase 04, E2; src/lib/codeowners.ts): GitHub's documented
// examples, its limits (no "!", no "[ ]"), the last rule winning, and owners named by an email
// address never shown.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { codeownersPath, ownerInWords, ownersOf, ownersOfChange, parseCodeowners, patternRe, ruleFor } from "../../src/lib/codeowners.ts";

const logins = (co: ReturnType<typeof parseCodeowners>, path: string) => ownersOf(co, path).map((o) => (o.kind === "user" ? o.login : o.kind === "team" ? `${o.org}/${o.team}` : "email"));

// GitHub's own example file (docs: "Example of a CODEOWNERS file"), shortened.
const EXAMPLE = `# This is a comment.
*       @global-owner1 @global-owner2
*.js    @js-owner #This is an inline comment.
*.go docs@example.com
*.txt @octo-org/octocats
/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/scripts/ @doctocat @octocat
**/logs @octocat
/apps/ @octocat
/apps/github
\\#notes.md @hash-owner
`;

describe("CODEOWNERS", () => {
  const co = parseCodeowners(EXAMPLE);

  test("GitHub's example: the last matching rule wins", () => {
    assert.deepEqual(co.errors, []);
    assert.deepEqual(logins(co, "README.md"), ["global-owner1", "global-owner2"]);
    assert.deepEqual(logins(co, "src/app.js"), ["js-owner"]);
    assert.deepEqual(logins(co, "notes.txt"), ["octo-org/octocats"]);
    assert.deepEqual(logins(co, "main.go"), ["email"]);
    // /build/logs/ names doctocat, but **/logs, later, matches it too and wins.
    assert.deepEqual(logins(co, "build/logs/today.log"), ["octocat"]);
    assert.equal(ruleFor(co, "build/logs/deep/x.txt")?.pattern, "**/logs");
    assert.deepEqual(logins(parseCodeowners("/build/logs/ @doctocat\n"), "build/logs/deep/x.txt"), ["doctocat"]);
    assert.deepEqual(logins(parseCodeowners("/build/logs/ @doctocat\n"), "src/build/logs/x.txt"), []);
    // docs/* is the files directly in docs/ (then /docs/ wins for them, being later).
    assert.deepEqual(logins(co, "docs/getting-started.md"), ["doctocat"]);
    assert.deepEqual(logins(co, "src/docs/a.md"), ["global-owner1", "global-owner2"]);
    // **/logs: a logs directory anywhere, and everything in it.
    assert.deepEqual(logins(co, "deeply/nested/logs/x.txt"), ["octocat"]);
    // /apps/github with no owner: nobody owns it, though /apps/ has an owner.
    assert.deepEqual(logins(co, "apps/github/index.js"), []);
    assert.deepEqual(logins(co, "apps/other/index.js"), ["octocat"]);
    assert.equal(ruleFor(co, "apps/github/index.js")?.pattern, "/apps/github");
    assert.deepEqual(logins(co, "#notes.md"), ["hash-owner"]);
  });

  test("docs/* matches only what is directly in docs/", () => {
    const only = parseCodeowners("docs/* @a\n");
    assert.deepEqual(logins(only, "docs/a.md"), ["a"]);
    assert.deepEqual(logins(only, "docs/build-app/troubleshooting.md"), []);
    const re = patternRe("*.py") as RegExp;
    assert.ok(re.test("a.py") && re.test("src/x/a.py") && !re.test("a.pyc"));
    assert.ok((patternRe("/") as RegExp).test("anything/at/all"));
  });

  test("what GitHub skips is said by line: negation, ranges, a bad owner; an address never shown", () => {
    const bad = parseCodeowners("!secret.txt @a\n[ab].py @b\n*.md not-an-owner\n*.r @good\n*.c ada@example.org\n");
    assert.deepEqual(bad.errors.map((e) => e.line), [1, 2, 3]);
    assert.match(bad.errors[0].message, /negation/);
    assert.match(bad.errors[1].message, /range/);
    assert.equal(bad.rules.length, 2);
    const owners = ownersOf(bad, "x.c");
    assert.deepEqual(owners, [{ kind: "email" }]);
    assert.equal(ownerInWords(owners[0]), "an owner named by an email address (hidden)");
    assert.ok(!JSON.stringify(bad).includes("example.org"));
  });

  test("the file GitHub reads first, and a change's owners", () => {
    assert.equal(codeownersPath(["docs/CODEOWNERS", "CODEOWNERS", "src/a.py"]), "CODEOWNERS");
    assert.equal(codeownersPath([".github/CODEOWNERS", "CODEOWNERS"]), ".github/CODEOWNERS");
    assert.equal(codeownersPath(["README.md"]), null);
    const change = ownersOfChange(parseCodeowners("*.py @py\nsrc/ @src\n"), ["src/a.py", "src/b.py", "tools/c.py"]);
    assert.deepEqual(change.map((c) => [c.owner.kind === "user" ? c.owner.login : "", c.paths]), [["src", ["src/a.py", "src/b.py"]], ["py", ["tools/c.py"]]]);
    assert.equal(parseCodeowners("x".repeat(3 * 1024 * 1024 + 1)).errors[0].line, 0);
  });
});
