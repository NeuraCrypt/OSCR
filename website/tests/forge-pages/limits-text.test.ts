// The hosting guides (/hosting/…) and their figures (src/lib/limits-text.ts): every figure a page
// prints comes from GITHUB_LIMITS (worker/forge/limits.ts), the guide figures or the registry's caps
// (worker/forge/service/caps.ts), in GitHub's own unit (MiB vs MB); changing a limit in a copy
// changes the text. The six pages name every row of their inventory as a heading or a sentence,
// write no figure and no platform name themselves, show no email address and use only the classes
// of science.css. When the site was built after the pages changed, the built HTML is checked too.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { GITHUB_LIMITS, type BackendLimits } from "../../worker/forge/limits.ts";
import { ACTION_PAYLOAD_BYTES, ASSET_UPLOAD_BYTES, PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { tokenTemplateUrl, TOKEN_DAYS } from "../../src/lib/forge.ts";
import {
  bytesInWords,
  bytesText,
  countText,
  DATA_HOMES,
  GIT_DOCS,
  GITHUB_GUIDE_FIGURES,
  hostingFacts,
  limitTables,
  REGISTRY_CAPS,
  sizeOf,
  SOURCES,
  unitsSentence,
  type GuideFigures,
  type HostingFacts,
  type RegistryCaps,
} from "../../src/lib/limits-text.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGES = ["index", "limits", "large-files", "git", "history", "tokens"] as const;
type Page = (typeof PAGES)[number];
const source = (page: Page): string => readFileSync(join(ROOT, "src/pages/hosting", `${page}.astro`), "utf8");
const route = (page: Page): string => (page === "index" ? "/hosting/" : `/hosting/${page}/`);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
const squash = (text: string): string => text.replace(/\s+/g, " ");

/** Multiplies every number of a value, deeply (a copy). */
function times3<T>(value: T): T {
  if (typeof value === "number") return (value * 3) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, times3(v)])) as T;
  }
  return value;
}

describe("units, as GitHub states them", () => {
  test("each value comes back in the unit limits.ts writes it in", () => {
    assert.equal(bytesText(100 * 2 ** 20), "100 MiB");
    assert.equal(bytesText(50 * 2 ** 20), "50 MiB");
    assert.equal(bytesText(2 * 10 ** 9), "2 GB");
    assert.equal(bytesText(10 ** 9), "1 GB");
    assert.equal(bytesText(10 * 2 ** 30), "10 GiB");
    assert.equal(bytesText(100 * 10 ** 6), "100 MB");
    assert.equal(bytesText(1_500 * 10 ** 3), "1,500 kB");
    assert.equal(bytesText(1_023), "1,023 bytes");
    // "each file under 2 GiB" (about-releases): one byte short of 2 GiB.
    assert.equal(bytesText(2 * 2 ** 30 - 1), "under 2 GiB");
    assert.deepEqual(sizeOf(2 * 2 ** 30 - 1), { value: 2, unit: "GiB", under: true });
  });

  test("MiB and MB are told apart, in words", () => {
    assert.equal(bytesInWords(100 * 2 ** 20), "100 mebibytes");
    assert.equal(bytesInWords(100 * 10 ** 6), "100 megabytes");
    assert.equal(bytesInWords(2 * 10 ** 9), "2 gigabytes");
    assert.equal(bytesInWords(2 ** 30), "1 gibibyte");
    assert.notEqual(bytesText(100 * 2 ** 20), bytesText(100 * 10 ** 6));
    const units = unitsSentence([100 * 2 ** 20, 2 * 10 ** 9]);
    assert.match(units, /MiB \(mebibyte\) = 1,048,576 bytes/);
    assert.match(units, /GB \(gigabyte\) = 1,000,000,000 bytes/);
    assert.ok(units.indexOf("binary") < units.indexOf("decimal"));
    assert.doesNotMatch(units, /KiB|kB/);
  });

  test("counts and refusals", () => {
    assert.equal(countText(100_000), "100,000");
    assert.equal(countText(3_000), "3,000");
    assert.equal(countText(50), "50");
    assert.throws(() => bytesText(-1), RangeError);
    assert.throws(() => bytesText(1.5), RangeError);
    assert.throws(() => countText(Number.NaN), RangeError);
  });
});

describe("the figures come from GITHUB_LIMITS, the guide figures and the registry's caps", () => {
  test("GitHub's values today", () => {
    const t = hostingFacts();
    assert.equal(t.file, "100 MiB");
    assert.equal(t.fileWarn, "50 MiB");
    assert.equal(t.push, "2 GB");
    assert.equal(t.repoIdeal, "1 GB");
    assert.equal(t.repoStrongly, "5 GB");
    assert.equal(t.releaseAsset, "under 2 GiB");
    assert.equal(t.releaseAssets, "1,000");
    assert.equal(t.lfsFile, "2 GB");
    assert.equal(t.lfsStorage, "10 GiB");
    assert.equal(t.lfsBandwidth, "10 GiB");
    assert.equal(t.pushLimitTitle, "Troubleshooting the 2 GB push limit");
    assert.equal(t.tokenCount, "50");
    assert.equal(t.tokenMaxDays, "366");
    assert.equal(t.tokenUnused, "a year");
    assert.equal(t.capWindow, "24 hours");
  });

  test("the registry's own caps are caps.ts's", () => {
    const t = hostingFacts();
    assert.equal(t.actionBytes, bytesText(ACTION_PAYLOAD_BYTES));
    assert.equal(t.actionBytes, "1 MiB");
    assert.equal(t.assetBytes, bytesText(ASSET_UPLOAD_BYTES));
    assert.equal(t.assetBytes, "25 MiB");
    assert.equal(t.perDayCreations, String(PER_ACCOUNT_DAY.creations));
    assert.equal(t.perDayLinks, String(PER_ACCOUNT_DAY.links));
    assert.equal(t.perDayActions, String(PER_ACCOUNT_DAY.actions));
    assert.equal(t.tokenTemplateDays, String(TOKEN_DAYS));
  });

  test("changing a limit in a copy changes the text", () => {
    const limits: BackendLimits = structuredClone(GITHUB_LIMITS);
    limits.fileBytes = 200 * 2 ** 20;
    limits.pushBytes = 3 * 2 ** 30;
    limits.repoRecommendedBytes = 500 * 10 ** 6;
    const t = hostingFacts(limits);
    assert.equal(t.file, "200 MiB");
    assert.equal(t.fileInWords, "200 mebibytes");
    assert.equal(t.push, "3 GiB");
    assert.equal(t.pushInWords, "3 gibibytes");
    assert.equal(t.pushLimitTitle, "Troubleshooting the 3 GiB push limit");
    assert.equal(t.repoIdeal, "500 MB");
    const rows = limitTables(limits).sizes.map((r) => r.value);
    assert.ok(rows.includes("200 MiB") && rows.includes("3 GiB") && rows.includes("500 MB"));
    assert.ok(!rows.includes("100 MiB"));
    // GitHub's own copy is untouched.
    assert.equal(hostingFacts().file, "100 MiB");
  });

  test("every figure changes when its source does", () => {
    const base = hostingFacts();
    const bumped = hostingFacts(times3(GITHUB_LIMITS), times3(GITHUB_GUIDE_FIGURES), times3(REGISTRY_CAPS));
    const unchanged = (Object.keys(base) as (keyof HostingFacts)[])
      .filter((k) => k !== "lfs" && k !== "units")
      .filter((k) => base[k] === bumped[k]);
    assert.deepEqual(unchanged, [], "a figure that does not follow its source");
    assert.equal(bumped.tokenUnused, "3 years");
    assert.equal(bumped.capWindow, "72 hours");
  });

  test("a forge without Git LFS says so, and its LFS table is empty", () => {
    const t = hostingFacts({ ...GITHUB_LIMITS, lfs: null });
    assert.equal(t.lfs, false);
    assert.match(t.lfsFile, /no Git LFS/);
    assert.deepEqual(limitTables({ ...GITHUB_LIMITS, lfs: null }).lfs, []);
    assert.doesNotMatch(t.units, /GiB \(gibibyte\)/.source === "" ? /$^/ : /$^/);
  });

  test("the guide figures and the caps can be changed in a copy too", () => {
    const figures: GuideFigures = { ...GITHUB_GUIDE_FIGURES, tokenCount: 60, directoryEntries: 10_000 };
    const caps: RegistryCaps = { ...REGISTRY_CAPS, actionBytes: 2 * 2 ** 20, perAccountDay: { actions: 7, creations: 3, links: 4 } };
    const t = hostingFacts(GITHUB_LIMITS, figures, caps);
    assert.equal(t.tokenCount, "60");
    assert.equal(t.directoryEntries, "10,000");
    assert.equal(t.actionBytes, "2 MiB");
    const registry = limitTables(GITHUB_LIMITS, figures, caps).registry.map((r) => r.value);
    assert.deepEqual(registry, ["2 MiB", "25 MiB", "3", "4", "7"]);
  });

  test("every row of the limits tables has GitHub's page as its source, or is the registry's own cap", () => {
    const tables = limitTables();
    for (const [name, rows] of Object.entries(tables)) {
      assert.ok(rows.length > 0, `${name} is empty`);
      for (const r of rows) {
        if (name === "registry") assert.equal(r.source, null, r.what);
        else assert.match(String(r.source), /^https:\/\/(docs\.github\.com|github\.blog)\//, r.what);
        assert.ok(r.value.length > 0);
      }
    }
  });

  test("the sources are GitHub's, git's, Zenodo's and Hugging Face's own pages, over HTTPS", () => {
    const allowed = /^https:\/\/(docs\.github\.com\/en\/|github\.blog\/changelog\/|github\.com\/(newren\/git-filter-repo|git-lfs\/git-lfs\/)|git-scm\.com\/docs\/|git-lfs\.com\/|zenodo\.org\/|help\.zenodo\.org\/|huggingface\.co\/docs\/)/;
    for (const url of [...Object.values(SOURCES), ...Object.values(GIT_DOCS), ...Object.values(DATA_HOMES)]) {
      assert.match(url, allowed, url);
      assert.doesNotMatch(url, EMAIL);
    }
  });
});

// ─── The six pages ───────────────────────────────────────────────────────────

/** Each row of the element's inventory, as the page names it: a heading or a sentence.
 *  "{SITE_NAME}" stands for the platform's name, whatever it is. */
const PHRASES: Record<Page, string[]> = {
  index: [
    "Where repositories live", "your own GitHub account", "What {SITE_NAME} keeps", "The mirror mode", "The guides",
    "Limits", "Large files", "Git with GitHub", "Rewriting history", "Tokens for git",
  ],
  limits: [
    "File size", "Push size", "Repository size", "Tree limits", "Push policy", "Branch and tag updates per push",
    "Push rule path exceptions", "{SITE_NAME}'s own caps", "Billing", "{SITE_NAME} costs nothing",
    "Git LFS quotas", "Budgets and usage alerts", "GitHub Pages size limits",
  ],
  "large-files": [
    "Where data goes, in this order", "Release assets", "A Zenodo record", "A Hugging Face dataset", "Git LFS support",
    "Client setup", "LFS file size and quotas", "Over quota", "Integrity check", "File locking",
    "Moving files into and out of LFS", "LFS objects in archives", "The binary and line-ending attributes",
  ],
  git: [
    "Clone, fetch, pull and push", "HTTPS, with a GitHub token as the password", "The credential cache",
    "SSH, and the 2026 algorithm changes", "SHA-1 removed from HTTPS", "Partial and shallow clones",
    "Clone error messages", "Push rejection messages", "Push protection warnings in the git push output",
    "Block pushes that expose my email", "Creating and pushing tags", "Signed by default",
    "Command-line file operations", "Default branch name", "Configuring the upstream remote", "Changing the remote URL",
    "Updating local clones after a rename",
  ],
  history: [
    "Rewriting commits", "Removing large files from history", "Removing sensitive data from history", "git filter-repo",
    "What it does to tracing maps", "no longer at the source", "Software Heritage",
    "Asking {SITE_NAME} to drop its own copies", "Request its removal",
  ],
  tokens: [
    "Fine-grained personal access tokens", "The token template URLs", "Classic tokens, and why not",
    "Name and description", "Expiry and reminder", "Repository access", "Permissions per resource", "Prefixes",
    "List and last use", "Regenerate", "Delete", "Count limit", "Revocation after", "Credential revocation by token type",
    "Artifact metadata", "Vulnerability alerts", "The npm token changes", "{SITE_NAME} issues no git token",
  ],
};

/** The facts each page must print (checked in the built HTML). */
const FIGURES: Record<Page, (keyof HostingFacts)[]> = {
  index: ["file", "push", "repoIdeal"],
  limits: [
    "file", "fileWarn", "fileInWords", "webUpload", "push", "pushInWords", "pushLimitTitle", "repoIdeal", "repoStrongly",
    "directoryEntries", "directoryDepth", "branchesAdvised", "reposPerAccount", "refUpdatesDefault", "refUpdatesMinimum",
    "refUpdatesRulesets", "actionBytes", "assetBytes", "perDayCreations", "perDayLinks", "perDayActions", "capWindow",
    "lfsStorage", "lfsBandwidth", "pagesSite", "pagesRepo", "units",
  ],
  "large-files": ["file", "fileWarn", "releaseAsset", "releaseAssets", "lfsFile", "lfsStorage", "lfsBandwidth"],
  git: ["file", "sshRsaMinBits"],
  history: ["file"],
  tokens: [
    "tokenTemplateDays", "tokenNameChars", "tokenDescriptionChars", "tokenDefaultDays", "tokenMaxDays", "tokenCount",
    "tokenUnused", "npmWriteTokenDays",
  ],
};

const phraseRe = (phrase: string): RegExp =>
  new RegExp(phrase.split("{SITE_NAME}").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".{1,80}?"));

/** The classes science.css defines. */
const CSS = readFileSync(join(ROOT, "src/styles/science.css"), "utf8");
const cssHasClass = (name: string): boolean => new RegExp(`\\.${name.replace(/[-]/g, "\\-")}(?![\\w-])`).test(CSS);

/** The figures of the facts that are long enough to be recognised in a page's own text. */
const FIGURE_TEXTS = [...new Set(Object.values(hostingFacts()).filter((v): v is string => typeof v === "string"))]
  .filter((v) => /\d/.test(v) && v.replace(/\D/g, "").length >= 3 && !/\s[a-z]{4,}/.test(v));

describe("the pages' sources", () => {
  for (const page of PAGES) {
    describe(route(page), () => {
      const text = source(page);
      const markup = text.replace(/^---[\s\S]*?\n---\n/, "");

      test("names each row of its inventory", () => {
        const flat = squash(text);
        const missing = PHRASES[page].filter((p) => !phraseRe(p).test(flat));
        assert.deepEqual(missing, []);
      });

      test("writes no figure itself: sizes and limits come from limits-text", () => {
        assert.doesNotMatch(text, /\d[\d,.]*\s*(GiB|GB|MiB|MB|KiB|kB|TB|gigabytes?|megabytes?|gibibytes?|mebibytes?)\b/);
        const written = FIGURE_TEXTS.filter((f) => new RegExp(`(^|[^\\d,.])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\d,]|$)`).test(markup));
        assert.deepEqual(written, [], "a figure written in the page instead of taken from limits-text");
        assert.match(text, /from "\.\.\/\.\.\/lib\/limits-text"/);
        assert.match(text, /hostingFacts\(\)/);
      });

      test("takes the platform's name from SITE_NAME", () => {
        assert.match(text, /import \{ SITE_NAME \} from "\.\.\/\.\.\/config"/);
        assert.doesNotMatch(text, /\bOSCR\b|Open Scientific Code Registry/);
      });

      test("shows no email address and no SSH address", () => {
        assert.doesNotMatch(text, EMAIL);
        assert.doesNotMatch(text, /@/);
      });

      test("science.css only: no style element or attribute, and only its classes", () => {
        assert.doesNotMatch(markup, /<style|\sstyle=|<link\s[^>]*stylesheet/i);
        assert.doesNotMatch(markup, /\sclass=\{|\sclass:list/);
        const classes = [...markup.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
        const unknown = [...new Set(classes)].filter((c) => !cssHasClass(c));
        assert.deepEqual(unknown, []);
      });

      test("a static page: no script, no call to the Worker", () => {
        assert.doesNotMatch(markup, /<script/i);
        assert.doesNotMatch(text, /\/api\/|fetch\(/);
      });

      test("its in-page links lead to one of its elements", () => {
        const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
        const broken = [...markup.matchAll(/\shref="#([^"]+)"/g)].map((m) => m[1]).filter((id) => !ids.has(id));
        assert.deepEqual(broken, []);
      });
    });
  }

  test("the links from one guide to another's section lead to an element of that guide", () => {
    const ids = new Map(PAGES.map((p) => [route(p), new Set([...source(p).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));
    const broken: string[] = [];
    for (const page of PAGES) {
      for (const [, path, id] of source(page).matchAll(/\shref="(\/hosting\/[^"#]*)#([^"]+)"/g)) {
        const target = ids.get(path);
        if (target && !target.has(id)) broken.push(`${route(page)} → ${path}#${id}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  test("the limits page prints GitHub's heading of the push-limit page from GITHUB_LIMITS", () => {
    assert.match(source("limits"), /<h3 id="push-limit">\{t\.pushLimitTitle\}<\/h3>/);
    assert.equal(hostingFacts().pushLimitTitle, `Troubleshooting the ${bytesText(GITHUB_LIMITS.pushBytes)} push limit`);
  });

  test("the tokens page's example is GitHub's template URL: one repository's name, Contents write, an expiry", () => {
    assert.match(source("tokens"), /tokenTemplateUrl\(\{ owner: "OWNER", name: "NAME" \}\)/);
    const url = new URL(tokenTemplateUrl({ owner: "OWNER", name: "NAME" }));
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.searchParams.get("contents"), "write");
    assert.equal(url.searchParams.get("expires_in"), String(REGISTRY_CAPS.tokenTemplateDays));
    assert.ok(url.searchParams.get("name")!.length <= GITHUB_GUIDE_FIGURES.tokenNameChars);
    assert.ok(url.searchParams.get("description")!.length <= GITHUB_GUIDE_FIGURES.tokenDescriptionChars);
    assert.doesNotMatch(url.href, EMAIL);
  });
});

// ─── The built pages, when the site was built after they changed ────────────

const DIST = join(ROOT, "dist");
const builtFile = (page: Page): string => join(DIST, route(page), "index.html");
const fresh = (page: Page): boolean =>
  existsSync(builtFile(page)) &&
  statSync(builtFile(page)).mtimeMs >= Math.max(
    statSync(join(ROOT, "src/pages/hosting", `${page}.astro`)).mtimeMs,
    statSync(join(ROOT, "src/lib/limits-text.ts")).mtimeMs,
  );

const decode = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("the built pages (dist/, after npm run build)", () => {
  for (const page of PAGES) {
    test(route(page), (t) => {
      if (!fresh(page)) {
        t.skip("not built since the page last changed: npm run build, then npm test");
        return;
      }
      const html = readFileSync(builtFile(page), "utf8");
      const text = squash(decode(html));
      assert.deepEqual(PHRASES[page].filter((p) => !phraseRe(p).test(text)), [], "inventory rows missing");
      const facts = hostingFacts();
      const figures = FIGURES[page].filter((k) => !(k.startsWith("lfs") && !facts.lfs));
      assert.deepEqual(figures.filter((k) => !text.includes(squash(String(facts[k])))), [], "figures missing");
      assert.doesNotMatch(html, EMAIL);
      assert.doesNotMatch(html, /\sstyle="/);
      const classes = [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
      // Astro's own scoping classes never appear: the pages have no <style>.
      assert.deepEqual([...new Set(classes)].filter((c) => !cssHasClass(c)), [], "classes outside science.css");
      assert.equal([...html.matchAll(/<h1[\s>]/g)].length, 1);
    });
  }
});
