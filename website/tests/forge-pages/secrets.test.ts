// The editor's warning before a commit that may carry a secret (night phase 03, E2;
// src/lib/secrets.ts). The test values are assembled when the test runs, so that no token-shaped
// string sits in the repository's own files (GitHub's push protection reads those too).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PATTERNS, findSecrets, secretsInWords } from "../../src/lib/secrets.ts";

const join = (...parts: string[]) => parts.join("");
const noise = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2rS4tU6vW8yZ0cF"[(i * 7) % 32]).join("");

describe("secrets before a commit", () => {
  test("the kinds match the shared fixture (phase 11's scan uses the same list)", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/secret_patterns.json", import.meta.url), "utf8")) as { kinds: string[] };
    assert.deepEqual(PATTERNS.map((p) => p.kind), fixture.kinds);
  });

  test("token shapes found by kind and line, the value hidden", () => {
    const github = join("gh", "p_", noise(36));
    const aws = join("AK", "IA", "Q3EGRT5YJK7WPL2M");
    const key = join("-----BEGIN ", "OPENSSH PRIVATE", " KEY-----");
    const hf = join("hf", "_", noise(34));
    const text = `import os\nTOKEN = "${github}"\n\n# keys\nAWS = '${aws}'\n${key}\nHF=${hf}\n`;
    const found = findSecrets(text);
    assert.deepEqual(found.map((f) => [f.line, f.kind]), [
      [2, "a GitHub token"],
      [5, "an AWS access key"],
      [6, "a private key"],
      [7, "a Hugging Face token"],
    ]);
    for (const f of found) assert.ok(f.hint.endsWith("…") && f.hint.length <= 7, f.hint);
    assert.ok(!JSON.stringify(found).includes(github));
    assert.deepEqual(secretsInWords("config.py", found.slice(0, 1)), [`Line 2 of config.py: a GitHub token (${github.slice(0, 6)}…).`]);
  });

  test("a password in an address; not the documentation's placeholders", () => {
    const url = join("postgres", "://ada:", "s3cr3t-pass", "@db.example.org/eeg");
    assert.equal(findSecrets(`DB = "${url}"`)[0].kind, "a password in an address");
    assert.deepEqual(findSecrets(join("AK", "IAIOSFODNN7", "EXAMPLE")), []);
    assert.deepEqual(findSecrets(join("gh", "p_", "X".repeat(36))), []);
    assert.deepEqual(findSecrets("def band_power(x):\n    return x ** 2\n"), []);
  });

  test("bounded: at most 50 findings", () => {
    const many = Array.from({ length: 80 }, () => join("AK", "IA", "Q3EGRT5YJK7WPL2M")).join("\n");
    assert.equal(findSecrets(many).length, 50);
  });
});
