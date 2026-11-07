// The site's own words carry none of the signs of machine-written English that scripts/style-signs.mjs
// lists (2026-11-07): negative parallelisms ("X, not Y", "not just", "rather than"), a list of
// overused words, "serves as", hollow phrases, long or short dashes. Curly quotes are checked on the
// pages and components; the GitHub side's libraries and the Worker still use them inside strings
// their tests read word for word. A line that must keep a sign says why: `style-ok: <reason>`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { signs } from "../scripts/style-signs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("the site's own text (scripts/style-signs.mjs)", () => {
  const found = signs(ROOT);
  it("has no negative parallelism, overused word, avoided copula, hollow phrase or dash", () => {
    const bad = found.filter((s) => s.sign !== "curly quote");
    assert.deepEqual(bad.map((s) => `${s.file}:${s.line} [${s.sign}] ${s.text.slice(0, 120)}`), []);
  });
  it("has no curly quote on the pages and components", () => {
    const bad = found.filter((s) => s.sign === "curly quote" && /^src\/(pages|components)\//.test(s.file));
    assert.deepEqual(bad.map((s) => `${s.file}:${s.line} ${s.text.slice(0, 120)}`), []);
  });
});
