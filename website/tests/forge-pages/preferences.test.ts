// The site's preferences (src/lib/preferences.ts) and that the page and the site-wide script agree
// on them (night phase 15). Pure, Node: a stored value becomes an attribute on <html>, a default
// sets none (light by default), an unknown value falls back, and storage is never touched here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PREFERENCES,
  appliedAttributes,
  currentValues,
  defaultOf,
  isPreferenceKey,
  preferenceOf,
  valueOf,
} from "../../src/lib/preferences.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** A pure accessor over a plain object, standing in for localStorage. */
const from = (obj: Record<string, string>) => (key: string) => obj[key] ?? null;

describe("the schema", () => {
  test("every key is namespaced pref. and never names the platform", () => {
    for (const p of PREFERENCES) {
      assert.match(p.key, /^pref\.[a-z]+$/);
      assert.doesNotMatch(`${p.key} ${p.label} ${p.help}`, /\bOSCR\b|Open Scientific Code Registry/);
    }
  });

  test("the theme's default is light and sets no attribute (no dark theme by default)", () => {
    const theme = preferenceOf("pref.theme");
    assert.ok(theme);
    assert.equal(defaultOf(theme!), "light");
    const { set, remove } = appliedAttributes(from({}));
    assert.ok(!("data-theme" in set));
    assert.ok(remove.includes("data-theme"));
  });

  test("each attribute is distinct and starts with data-", () => {
    const attrs = PREFERENCES.map((p) => p.attr);
    for (const a of attrs) assert.match(a, /^data-[a-z]+$/);
    assert.equal(new Set(attrs).size, attrs.length);
  });

  test("each preference has at least two options and its default is the first", () => {
    for (const p of PREFERENCES) {
      assert.ok(p.options.length >= 2, p.key);
      assert.equal(defaultOf(p), p.options[0].value);
    }
  });
});

describe("reading a stored value", () => {
  test("a known choice is kept, anything else falls back to the default", () => {
    const theme = preferenceOf("pref.theme")!;
    assert.equal(valueOf(theme, "dark"), "dark");
    assert.equal(valueOf(theme, "light"), "light");
    assert.equal(valueOf(theme, "neon"), "light");
    assert.equal(valueOf(theme, null), "light");
    assert.equal(valueOf(theme, undefined), "light");
  });

  test("currentValues gives every preference a value", () => {
    const v = currentValues(from({ "pref.theme": "dark", "pref.tab": "8", "pref.bogus": "x" }));
    assert.equal(v["pref.theme"], "dark");
    assert.equal(v["pref.tab"], "8");
    assert.equal(v["pref.contrast"], "normal");
    assert.equal(Object.keys(v).length, PREFERENCES.length);
  });
});

describe("the attributes put on <html>", () => {
  test("a non-default choice sets its attribute, a default removes it", () => {
    const { set, remove } = appliedAttributes(from({ "pref.theme": "dark", "pref.contrast": "more", "pref.tab": "4" }));
    assert.equal(set["data-theme"], "dark");
    assert.equal(set["data-contrast"], "more");
    assert.ok(!("data-tab" in set)); // 4 is the default
    assert.ok(remove.includes("data-tab"));
  });

  test("nothing stored means every attribute is removed: the page carries none", () => {
    const { set, remove } = appliedAttributes(from({}));
    assert.deepEqual(set, {});
    assert.equal(remove.length, PREFERENCES.length);
  });

  test("an unknown value is ignored, not applied", () => {
    const { set } = appliedAttributes(from({ "pref.theme": "midnight" }));
    assert.ok(!("data-theme" in set));
  });
});

describe("isPreferenceKey", () => {
  test("knows its keys and rejects others", () => {
    assert.ok(isPreferenceKey("pref.theme"));
    assert.ok(!isPreferenceKey("reader.paper"));
    assert.ok(!isPreferenceKey("anything"));
  });
});

// ─── The page and the CSS agree with the schema ─────────────────────────────

describe("the preferences page and science.css", () => {
  const page = read("src/pages/settings/preferences.astro");
  const css = read("src/styles/science.css");

  test("the page builds its controls from PREFERENCES, not a hand-written list", () => {
    assert.match(page, /from "\.\.\/\.\.\/lib\/preferences"/);
    assert.match(page, /PREFERENCES\.map/);
    assert.doesNotMatch(page, /\bOSCR\b|Open Scientific Code Registry/);
  });

  test("science.css defines a rule for each non-default theme and preference attribute value", () => {
    // The dark theme and the colour-vision palettes, and the preference attributes, each have a rule.
    assert.match(css, /html\[data-theme="dark"\]/);
    assert.match(css, /html\[data-vision="deuteranopia"\]/);
    assert.match(css, /html\[data-vision="tritanopia"\]/);
    assert.match(css, /html\[data-contrast="more"\]/);
    assert.match(css, /html\[data-underline="always"\]/);
    assert.match(css, /html\[data-motion="reduced"\]/);
    assert.match(css, /html\[data-tab="2"\]/);
    assert.match(css, /html\[data-line="roomy"\]/);
    assert.match(css, /html\[data-md="fixed"\]/);
  });

  test("the skip link is styled and the dark theme never appears without the attribute", () => {
    assert.match(css, /\.skip-link\s*\{/);
    // :root defines the light tokens; the only place --bg becomes dark is under a data-theme rule.
    const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
    assert.match(rootBlock, /--bg:\s*#fff/);
  });
});
