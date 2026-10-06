// The interface strings in one place (src/lib/strings.ts, night phase 15, localization): the shape
// is complete, nothing names the platform or uses an em dash, the language seam picks English by
// default, and the new client features take their frame strings from here, not hand-written copies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { STRINGS, STRINGS_BY_LANG, stringsFor } from "../../src/lib/strings.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const EM_DASH = /—/;

/** Every leaf string of the table, deeply. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const v of Object.values(value)) leaves(v, out);
  return out;
}

describe("the strings table", () => {
  test("every leaf is a non-empty string", () => {
    const all = leaves(STRINGS);
    assert.ok(all.length > 0);
    for (const s of all) assert.ok(s.length > 0);
  });

  test("no string names the platform or uses an em dash", () => {
    for (const s of leaves(STRINGS)) {
      assert.doesNotMatch(s, /\bOSCR\b|Open Scientific Code Registry/);
      assert.doesNotMatch(s, EM_DASH);
    }
  });

  test("the skip link, the palette and the shortcut frame are all present", () => {
    assert.ok(STRINGS.skipToContent);
    assert.ok(STRINGS.palette.placeholder && STRINGS.palette.empty && STRINGS.palette.hint);
    assert.ok(STRINGS.shortcuts.title && STRINGS.shortcuts.close);
    assert.ok(STRINGS.preferences.title && STRINGS.preferences.reset);
  });
});

describe("the language seam", () => {
  test("English is the only language for now, and the default", () => {
    assert.deepEqual(Object.keys(STRINGS_BY_LANG), ["en"]);
    assert.equal(stringsFor("en"), STRINGS);
    assert.equal(stringsFor("en-GB"), STRINGS);
    assert.equal(stringsFor("fr"), STRINGS); // unknown falls back, never throws
    assert.equal(stringsFor(null), STRINGS);
    assert.equal(stringsFor(undefined), STRINGS);
  });

  test("a future table would have the same shape (checked structurally on English)", () => {
    const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o).sort() : []);
    assert.deepEqual(keys(STRINGS.palette.groups), ["commands", "go", "issues", "people", "search"]);
  });
});

describe("the client features read the central strings", () => {
  test("Base.astro, the palette, the shortcuts script and the preferences page import strings", () => {
    assert.match(read("src/layouts/Base.astro"), /from "\.\.\/lib\/strings"/);
    assert.match(read("src/lib/palette.ts"), /from "\.\/strings\.ts"/);
    assert.match(read("src/scripts/shortcuts.ts"), /from "\.\.\/lib\/strings\.ts"/);
    assert.match(read("src/scripts/palette.ts"), /from "\.\.\/lib\/strings\.ts"/);
    assert.match(read("src/pages/settings/preferences.astro"), /from "\.\.\/\.\.\/lib\/strings"/);
  });

  test("the palette uses the central group titles, not its own copies", () => {
    const palette = read("src/lib/palette.ts");
    assert.match(palette, /STRINGS\.palette\.groups\.go/);
    // No hand-written duplicate of the group titles.
    assert.doesNotMatch(palette, /go:\s*"Go to"/);
  });
});
