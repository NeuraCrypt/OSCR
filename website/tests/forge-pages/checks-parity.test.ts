// The registry's checks and citations, shared with the command line (night phase 14; D14-6):
// tests/fixtures/checks-cases.json must be what the TypeScript answers today (checks-core.ts,
// citation.ts, environments.ts); the command line's Python port answers the same file
// (cli/tests/test_registry.py). A change of the rules: run scripts/checks-cases.ts, then make the port
// follow.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CASES } from "../../scripts/checks-cases.ts";

test("the shared cases are the TypeScript's answers", () => {
  const file = JSON.parse(readFileSync(new URL("../../../tests/fixtures/checks-cases.json", import.meta.url), "utf8"));
  assert.deepEqual(file, JSON.parse(JSON.stringify(CASES)));
  assert.ok(file.checks.length >= 8 && file.citations.length >= 8);
  // Every level and conclusion appears at least once.
  const levels = new Set(file.checks.flatMap((c: { expected: { findings: { level: string }[] } }) => c.expected.findings.map((f) => f.level)));
  assert.deepEqual([...levels].sort(), ["failure", "notice", "ok", "warning"]);
  const conclusions = new Set(file.checks.map((c: { expected: { conclusion: string } }) => c.expected.conclusion));
  assert.deepEqual([...conclusions].sort(), ["failure", "neutral", "success"]);
});
