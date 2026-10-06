// The accessibility baseline the whole site shares (night phase 15): the skip link, the main
// landmark, one top heading, the language, and the site-wide script, checked in the BUILT pages
// across the phases; and the accessibility statement page itself. NIGHT_RUN §4: each page's own
// phase set its baseline; this phase audits and completes it.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const DIST = join(ROOT, "dist");
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
const EM_DASH = /—/;

// Representative built pages, one or more per area of the site. A page absent from this fixture
// build is skipped (not every route is in the small fixture catalogue).
const BUILT = [
  "index.html",
  "about/index.html",
  "accessibility/index.html",
  "settings/preferences/index.html",
  "limits/index.html",
  "privacy/index.html",
  "terms/index.html",
  "repositories/index.html",
  "explore/index.html",
  "notifications/index.html",
  "search/index.html",
  "lookup/index.html",
];

const freshBuild = existsSync(join(DIST, "index.html")) && statSync(join(DIST, "index.html")).mtimeMs >= statSync(join(ROOT, "src/layouts/Base.astro")).mtimeMs;

describe("every built page carries the accessibility baseline", () => {
  for (const rel of BUILT) {
    test(`/${rel}`, (t) => {
      const file = join(DIST, rel);
      if (!freshBuild || !existsSync(file)) {
        t.skip("not built, or built before Base.astro last changed: npm run build, then npm test");
        return;
      }
      const html = readFileSync(file, "utf8");
      assert.match(html, /<html lang="en">/, "the page declares its language");
      assert.match(html, /<a class="skip-link" href="#main">/, "the skip link is the first focusable element");
      assert.match(html, /<main id="main">/, "the main landmark the skip link points to");
      assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1, "exactly one top heading");
      assert.match(html, /<header class="masthead">/, "the banner landmark");
      assert.match(html, /<footer>/, "the footer landmark");
      // The site-wide script (preferences, shortcuts, palette) is on every page.
      assert.match(html, /<script type="module" src="\/_astro\/[^"]*Base\.astro[^"]*"><\/script>/, "the site-wide script");
    });
  }
});

describe("the skip link points at the landmark it names", () => {
  test("Base.astro: the skip link href and the main id agree", () => {
    const base = read("src/layouts/Base.astro");
    const href = base.match(/class="skip-link" href="#([^"]+)"/)?.[1];
    assert.ok(href);
    assert.match(base, new RegExp(`<main id="${href}">`));
  });
});

// ─── The accessibility statement page ───────────────────────────────────────

describe("/accessibility/ (the statement)", () => {
  const page = read("src/pages/accessibility.astro");
  const markup = page.replace(/^---[\s\S]*?\n---\n/, "");
  const css = read("src/styles/science.css");
  const cssHasClass = (name: string): boolean => new RegExp(`\\.${name.replace(/-/g, "\\-")}(?![\\w-])`).test(css);

  test("takes the platform's name from config and names no platform literally", () => {
    assert.match(page, /from "\.\.\/config"/);
    assert.doesNotMatch(page, /\bOSCR\b|Open Scientific Code Registry/);
  });

  test("no email address, no em dash", () => {
    assert.doesNotMatch(page, EMAIL);
    assert.doesNotMatch(page, EM_DASH);
  });

  test("names the baseline features (true of the code)", () => {
    for (const phrase of ["Skip to the content", "Landmarks", "Keyboard shortcuts", "command palette", "Visible focus", "Reduced motion", "reflow", "also tables", "MathML"]) {
      assert.ok(page.includes(phrase), phrase);
    }
  });

  test("science.css only: no style element or attribute, only its classes", () => {
    assert.doesNotMatch(markup, /<style|\sstyle=|stylesheet/i);
    const classes = [...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    assert.deepEqual([...new Set(classes)].filter((c) => !cssHasClass(c)), []);
  });

  test("a static page: no script, no call to the Worker", () => {
    assert.doesNotMatch(markup, /<script/i);
    assert.doesNotMatch(page, /\/api\/|fetch\(/);
  });

  test("its links lead to pages that exist", () => {
    const links = [...markup.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]);
    for (const l of links) {
      // a top-level page .astro, or a nested index.astro
      const a = join(ROOT, "src/pages", `${l.replace(/\/$/, "")}.astro`);
      const b = join(ROOT, "src/pages", l, "index.astro");
      assert.ok(existsSync(a) || existsSync(b), `${l} has no page`);
    }
  });
});
