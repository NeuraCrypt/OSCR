// Email addresses in free text (worker/forge/mask.ts), in parity with the Mac's
// oscr/catalog.py::mask_emails: both read the pairs of tests/fixtures/emails.json (the Python side
// in tests/test_forge.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EMAIL_MASK, maskEmails } from "../../worker/forge/mask.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/emails.json", import.meta.url), "utf8")) as {
  cases: { input: string; expected: string }[];
};

test("masks email addresses exactly as the Mac does (the shared fixture)", () => {
  assert.ok(fixture.cases.length >= 20);
  for (const { input, expected } of fixture.cases) assert.equal(maskEmails(input), expected, JSON.stringify(input));
});

test("keeps the lines, so line numbers and tracing maps still hold", () => {
  const code = "# a@example.org\nx = 1\n# b@example.org c@example.org\n";
  const masked = maskEmails(code);
  assert.equal(masked.split("\n").length, code.split("\n").length);
  assert.equal(masked, `# ${EMAIL_MASK}\nx = 1\n# ${EMAIL_MASK} ${EMAIL_MASK}\n`);
});

test("leaves a git remote and a text without an at sign alone", () => {
  assert.equal(maskEmails("git@github.com:ada/compendium.git"), "git@github.com:ada/compendium.git");
  const plain = "nothing to hide";
  assert.equal(maskEmails(plain), plain);
});
