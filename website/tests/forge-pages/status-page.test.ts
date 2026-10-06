// The /status page (src/lib/status-page.ts and the page): the availability the Mac wrote becomes the
// view, the quotas read in words, and the placeholder is shown until the checks are enabled.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { QUOTAS, builtInWords, dayLabel, percent, summarize, type StatusData } from "../../src/lib/status-page.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
const EM_DASH = /—/;

const day = (date: string, state: StatusData["days"][number]["state"], uptime: number | null, checks = 10): StatusData["days"][number] => ({
  date,
  checks,
  ok: uptime == null ? 0 : Math.round(uptime * checks),
  state,
  uptime,
});

const enabled: StatusData = {
  enabled: true,
  generated_at: "2026-10-05T12:00:00Z",
  window_days: 90,
  checks_per_day: 288,
  interval_seconds: 300,
  days: [day("2026-10-03", "down", 0.2), day("2026-10-04", "partial", 0.7), day("2026-10-05", "up", 1)],
  incidents: [{ start: "2026-09-28T06:00:00Z", end: "2026-09-28T07:00:00Z", checks: 3, title: "The site did not answer" }],
  total_checks: 30,
  ok_checks: 29,
  overall_uptime: 0.9667,
};

describe("formatting", () => {
  test("percent, or a word when nothing is measured", () => {
    assert.equal(percent(0.9954), "99.54%");
    assert.equal(percent(1), "100.00%");
    assert.equal(percent(null), "not measured yet");
  });

  test("the build time reads in words, UTC", () => {
    assert.equal(builtInWords("2026-10-05T12:00:00Z"), "5 October 2026, 12:00 UTC");
    assert.equal(builtInWords("garbage"), "garbage");
  });

  test("a day's label names the date, the state and the uptime", () => {
    assert.match(dayLabel(day("2026-10-05", "up", 1)), /5 October 2026: fully available \(100\.00% of 10 checks\)/);
    assert.match(dayLabel(day("2026-10-01", "none", null, 0)), /no check recorded/);
  });
});

describe("summarize", () => {
  test("an enabled file becomes the grid, the overall and the incidents", () => {
    const v = summarize(enabled);
    assert.equal(v.enabled, true);
    assert.equal(v.overall, "96.67%");
    assert.equal(v.days.length, 3);
    assert.equal(v.incidents.length, 1);
    assert.match(v.incidents[0].title, /did not answer/);
    assert.match(v.summary, /Availability over the last 90 days: 96\.67%/);
  });

  test("the placeholder (checks not enabled) shows no grid and says so", () => {
    const v = summarize({ enabled: false, days: [], incidents: [] } as Partial<StatusData>);
    assert.equal(v.enabled, false);
    assert.equal(v.days.length, 0);
    assert.match(v.summary, /not running yet/);
  });

  test("a malformed file degrades to the placeholder, never throws", () => {
    assert.doesNotThrow(() => summarize(null));
    assert.doesNotThrow(() => summarize({} as Partial<StatusData>));
    assert.equal(summarize({ enabled: true } as Partial<StatusData>).enabled, false); // no days
  });
});

describe("the quotas", () => {
  test("each is a fact in words, no email, no em dash, no platform name", () => {
    assert.ok(QUOTAS.length >= 3);
    for (const q of QUOTAS) {
      assert.ok(q.what && q.limit && q.whenSpent);
      for (const s of [q.what, q.limit, q.whenSpent]) {
        assert.doesNotMatch(s, EMAIL);
        assert.doesNotMatch(s, EM_DASH);
        assert.doesNotMatch(s, /\bOSCR\b|Open Scientific Code Registry/);
      }
    }
  });
});

// ─── The built page ──────────────────────────────────────────────────────────

const DIST = join(ROOT, "dist", "status", "index.html");
const SRC = [
  join(ROOT, "src/pages/status.astro"),
  join(ROOT, "src/lib/status-page.ts"),
  join(ROOT, "src/data/site-status.json"),
];
const fresh = existsSync(DIST) && SRC.every((s) => !existsSync(s) || statSync(DIST).mtimeMs >= statSync(s).mtimeMs);

describe("the built /status page", () => {
  test("renders with a single heading, no email, science.css classes only", (t) => {
    if (!fresh) {
      t.skip("not built since the page or its data changed: npm run build, then npm test");
      return;
    }
    const html = readFileSync(DIST, "utf8");
    assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1);
    assert.match(html, /Service status/);
    assert.match(html, /Daily quotas/);
    assert.doesNotMatch(html, EMAIL);
    assert.doesNotMatch(html, /\sstyle="/);
    // The fixture status is enabled, so the grid is present.
    assert.match(html, /class="status-grid"/);
  });
});
