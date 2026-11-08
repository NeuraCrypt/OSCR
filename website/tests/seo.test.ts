// What search engines are told (src/lib/seo.ts, 2026-11-08): one canonical address a page, the shells'
// written by their script or by the Worker, noindex on the pages kept out on purpose, robots.txt read
// as Google reads it, and a real 404 from the Worker for a paper it does not know.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  canonicalHref, canonicalsOf, canonicalTag, hasNoindex, isNoindexPath, isShellPath, NOINDEX_PATHS, NOINDEX_TAG, pagePath,
  robotsBlocks, setCanonical, setNoindex, SHELL_PATHS, siteOrigin,
} from "../src/lib/seo.ts";
import type { PaperRecord } from "../src/lib/render.ts";
import { ENTITY_TYPES } from "../src/lib/shards.ts";
import { GET as robotsRoute } from "../src/pages/robots.txt.ts";
import { type Assets, fillShell, handlePage } from "../worker/pages.ts";

const SITE = "https://openscicode.org";
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** A page of src/pages for a path: "/about/" is about.astro or about/index.astro; "/404/" is 404.astro. */
const pageSource = (path: string) => {
  const p = path.replace(/^\/|\/$/g, "");
  return [`src/pages/${p}.astro`, `src/pages/${p}/index.astro`].some((f) => existsSync(new URL(`../${f}`, import.meta.url)));
};

describe("the canonical address (src/lib/seo.ts)", () => {
  it("is absolute, https, without www, with its trailing slash, without a query or a fragment", () => {
    assert.equal(canonicalHref(SITE, "/about/"), "https://openscicode.org/about/");
    assert.equal(canonicalHref(SITE, "/about"), "https://openscicode.org/about/");
    assert.equal(canonicalHref("http://www.openscicode.org", "/list/2/?x=1#top"), "https://openscicode.org/list/2/");
    assert.equal(canonicalHref(`${SITE}/`, "/"), "https://openscicode.org/");
    assert.equal(canonicalHref(SITE, "/author/0000-0003-3689-554X/"), "https://openscicode.org/author/0000-0003-3689-554X/");
    // A file keeps its name: no slash after it.
    assert.equal(canonicalHref(SITE, "/papers.atom"), "https://openscicode.org/papers.atom");
  });

  it("is written once, escaped, and read back", () => {
    const tag = canonicalTag("https://openscicode.org/a/?x=1&y=2");
    assert.equal(tag, '<link rel="canonical" href="https://openscicode.org/a/?x=1&amp;y=2">');
    assert.deepEqual(canonicalsOf(`<head>${tag}</head>`), ["https://openscicode.org/a/?x=1&y=2"]);
    assert.ok(hasNoindex(`<head>${NOINDEX_TAG}</head>`));
    assert.ok(!hasNoindex('<meta name="description" content="noindex">'));
  });

  it("names a page by its path, its file or its address alike", () => {
    assert.equal(pagePath("/about/index.html"), "/about/");
    assert.equal(pagePath("/about"), "/about/");
    assert.equal(pagePath("/404.html"), "/404/");
    assert.equal(pagePath("/paper/404.html"), "/paper/404/");
    assert.equal(pagePath("/search/?q=eeg"), "/search/");
    assert.equal(pagePath("/index.html"), "/");
  });
});

describe("the pages kept out of search engines, and the shells", () => {
  it("are pages of the site", () => {
    for (const p of [...NOINDEX_PATHS, ...SHELL_PATHS]) assert.ok(pageSource(p === "/paper/404/" ? "/paper/404/" : p), p);
  });

  it("never include a page meant for search engines: the information pages, the lists, the papers, the entities", () => {
    const info = [...src("src/lib/info.ts").matchAll(/href: "(\/[^"#]*)"/g)].map((m) => m[1]);
    assert.ok(info.length > 20, "the information pages are read from src/lib/info.ts");
    const meant = [...info, "/", "/lookup/", "/browse/", "/list/", "/list/2/", "/authors/", "/journals/", "/institutions/", "/tools/",
      "/datasets/", "/api/", "/badge/", "/scientific-tools/", "/paper/doi_10.5555_x/", "/author/0000-0002-1825-0097/",
      "/journal/issn-0000-0000/", "/explore/", "/status/", "/hosting/", "/developers/"];
    for (const p of meant) assert.ok(!isNoindexPath(p), p);
    for (const p of meant.filter((x) => !/^\/(author|journal)\/./.test(x))) assert.ok(!isShellPath(p), p);
  });

  it("keep the signed-in reader's pages, the forms, the search and the GitHub side's shells out", () => {
    for (const p of ["/account/", "/submit/", "/removal/", "/data-rights/", "/settings/tokens/", "/search/", "/404/", "/r/", "/u/", "/research/", "/snippets/"]) {
      assert.ok(isNoindexPath(p), p);
    }
    assert.ok(isNoindexPath("/search/?q=eeg"));
  });

  it("hold every shell public/_redirects serves for many addresses", () => {
    const redirects = existsSync(new URL("../public/_redirects", import.meta.url)) ? src("public/_redirects") : "";
    const targets = [...redirects.matchAll(/^\S+\s+(\S+)\s+200\s*$/gm)].map((m) => m[1]);
    for (const t of targets) assert.ok(isShellPath(t), t);
    for (const t of ENTITY_TYPES) assert.ok(isShellPath(`/${t}/`), t);
    assert.ok(isShellPath("/paper/404.html"));
  });

  it("are applied by the layout: one canonical on every page but the shells, a noindex on the pages kept out", () => {
    const base = src("src/layouts/Base.astro");
    assert.match(base, /isShellPath\(Astro\.url\.pathname\)/);
    assert.match(base, /isNoindexPath\(Astro\.url\.pathname\)/);
    assert.match(base, /<link rel="canonical" href=\{canonicalUrl\} \/>/);
    assert.match(base, /<meta name="robots" content="noindex" \/>/);
    assert.match(base, /<meta name="site-origin" content=/);
  });

  it("leave the search and every page kept out off the sitemap", () => {
    const sitemap = src("src/lib/sitemap.ts");
    assert.ok(!sitemap.includes('"/search/"'));
    assert.match(sitemap, /!isNoindexPath\(p\)/);
  });
});

describe("robots.txt (src/pages/robots.txt.ts), read as Google reads it", () => {
  const robots = async () => (await (robotsRoute as (c: { site: URL }) => Response)({ site: new URL(SITE) })).text();

  it("keeps the Worker's routes and the search's results out, and lets the pages in", async () => {
    const txt = await robots();
    assert.match(txt, /^Sitemap: https:\/\/openscicode\.org\/sitemap\.xml$/m);
    for (const p of ["/api/search", "/api/v1/paper/x", "/api/auth/orcid/start", "/search/?q=eeg"]) assert.ok(robotsBlocks(txt, p), p);
    for (const p of ["/", "/api/", "/search/", "/paper/doi_10.5555_x/", "/author/0000-0002-1825-0097/", "/list/2/", "/help/api/"]) {
      assert.ok(!robotsBlocks(txt, p), p);
    }
  });

  it("follows the longest rule, Allow on a tie, '*' and '$', for every robot", () => {
    const txt = "User-agent: Other\nDisallow: /\n\nUser-agent: *\nDisallow: /a/\nAllow: /a/b\nDisallow: /*.json$\nDisallow: /c\nAllow: /c\n";
    assert.ok(robotsBlocks(txt, "/a/x"));
    assert.ok(!robotsBlocks(txt, "/a/b/c"));
    assert.ok(robotsBlocks(txt, "/d/e.json"));
    assert.ok(!robotsBlocks(txt, "/d/e.json/x"));
    assert.ok(!robotsBlocks(txt, "/c/x"), "a tie goes to Allow");
    assert.ok(!robotsBlocks(txt, "/z/"), "the Other robot's rules are not everyone's");
  });
});

/** A minimal document: a head of elements, and the selectors the shell scripts use. */
function fakeDocument(origin: string, siteOriginMeta?: string) {
  type El = { tag: string; rel?: string; name?: string; content?: string; href?: string; remove(): void };
  const head: El[] = [];
  const make = (tag: string): El => {
    const el: El = { tag, remove: () => void head.splice(head.indexOf(el), 1) };
    return el;
  };
  if (siteOriginMeta) head.push(Object.assign(make("meta"), { name: "site-origin", content: siteOriginMeta }));
  const doc = {
    location: { origin },
    head: { append: (el: El) => void head.push(el) },
    createElement: make,
    querySelector(sel: string) {
      const m = sel.match(/^(\w+)\[(\w+)="([^"]+)"\]$/)!;
      return head.find((e) => e.tag === m[1] && (e as Record<string, unknown>)[m[2]] === m[3]) ?? null;
    },
  };
  return { doc: doc as unknown as Document, head };
}

describe("the shells' scripts (src/scripts/entity.ts, src/scripts/paper-shell.ts)", () => {
  it("give a found entity its canonical address on the site's own host, and keep an unknown one out", () => {
    const { doc, head } = fakeDocument("https://oscr.yannbellec-b.workers.dev", SITE);
    assert.equal(siteOrigin(doc), SITE);
    setCanonical(doc, canonicalHref(siteOrigin(doc), "/author/0000-0003-3689-554X/"));
    setCanonical(doc, canonicalHref(siteOrigin(doc), "/author/0000-0003-3689-554X/"));
    assert.deepEqual(head.filter((e) => e.rel === "canonical").map((e) => e.href), ["https://openscicode.org/author/0000-0003-3689-554X/"]);
    setNoindex(doc);
    setNoindex(doc);
    assert.equal(head.filter((e) => e.rel === "canonical").length, 0, "a page kept out names no canonical");
    assert.equal(head.filter((e) => e.name === "robots" && e.content === "noindex").length, 1);
    assert.equal(siteOrigin(fakeDocument("https://openscicode.org").doc), SITE, "without the meta, the page's own origin");
  });

  it("are the ones that use these helpers", () => {
    const entity = src("src/scripts/entity.ts");
    assert.match(entity, /setNoindex\(document\)/);
    assert.match(entity, /setCanonical\(document, canonical\)/);
    assert.match(entity, /canonicalHref\(siteOrigin\(document\), `\/\$\{t\}\/\$\{encodeURIComponent\(key\)\}\/`\)/);
    const paper = src("src/scripts/paper-shell.ts");
    assert.match(paper, /setNoindex\(document\)/);
    assert.match(paper, /setCanonical\(document, canonicalHref\(siteOrigin\(document\), `\/paper\/\$\{slug\}\/`\)\)/);
  });
});

// The Worker's pages (worker/pages.ts).
const SHELL =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Paper: OSCR</title>` +
  `<meta name="description" content="A paper."><meta name="application-name" content="OSCR">` +
  `<meta name="site-origin" content="https://openscicode.org">` +
  `<meta property="og:title" content="Paper"><meta property="og:description" content="A paper."><meta property="og:type" content="website"></head><body>` +
  `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">OSCR</a> › <span id="crumb">Paper</span></nav>` +
  `<main id="main"><div id="paper"><h1>Paper</h1><script type="module" src="/_astro/paper-shell.js"></script></div></main></body></html>`;
const SLUG = "doi_10.5555_oscr.seo.2";
const RECORD: PaperRecord = {
  id: "doi:10.5555/oscr.seo.2",
  slug: SLUG,
  doi: "10.5555/oscr.seo.2",
  title: "A paper rendered on demand",
  journal: { text: "Journal of Synthetic Fixtures", href: "/journal/issn-0000-0019/" },
  published: "2020-01-01",
  type: "Research article",
  license: "CC BY 4.0",
  status: "code_verified",
  notices: [],
  authors: [{ text: "Ben Example", href: "/author/0000-0000-0000-0028/" }],
  institutions: [],
  categories: [],
  code: [],
  files: 0,
  pairs: 0,
  map: "",
  datasets: [],
  data: [],
  tools: [],
  europepmc: "",
};

function assets(files: Record<string, string>): Assets {
  return {
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith(".html")) return new Response(null, { status: 307, headers: { Location: path.slice(0, -5) } });
      const file = files[path] ?? files[`${path}.html`];
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file, { status: 200 });
    },
  };
}

describe("the Worker's pages (worker/pages.ts)", async () => {
  const { shardOf, SHARDS } = await import("../src/lib/shards.ts");
  const shard = await shardOf(SLUG, SHARDS.paper);
  const site = () =>
    assets({
      "/paper/404.html": SHELL,
      "/404.html": "<!doctype html><head><title>Page not found: OSCR</title></head><main><h1>Page not found</h1></main>",
      [`/records/paper/${shard}.json`]: JSON.stringify({ [SLUG]: RECORD }),
      "/paper/doi_10.5555_static.1/": "<!doctype html><p>a static paper</p>",
    });

  it("write one canonical address and og:url into a shell, the site's host whatever the request's", async () => {
    const res = await handlePage(new Request(`https://oscr.yannbellec-b.workers.dev/paper/${SLUG}/`), site());
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.deepEqual(canonicalsOf(html), [`https://openscicode.org/paper/${SLUG}/`]);
    assert.ok(html.includes(`<meta property="og:url" content="https://openscicode.org/paper/${SLUG}/">`));
    assert.ok(!hasNoindex(html));
  });

  it("replace a canonical a shell already had, and add one where the shell has no place for it", () => {
    const view = { title: "T", description: "", crumb: "c", html: "<p>x</p>" };
    const withOne = SHELL.replace("</head>", '<link rel="canonical" href="https://openscicode.org/paper/404/"></head>');
    assert.deepEqual(canonicalsOf(fillShell(withOne, view, "https://openscicode.org/paper/a/")!), ["https://openscicode.org/paper/a/"]);
    const bare = SHELL.replace(/<meta name="application-name"[^>]*>/, "");
    assert.deepEqual(canonicalsOf(fillShell(bare, view, "https://openscicode.org/paper/a/")!), ["https://openscicode.org/paper/a/"]);
    assert.deepEqual(canonicalsOf(fillShell(SHELL, view)!), [], "no address given, none written");
  });

  it("answer a paper the registry does not know with a real 404, never an empty page with 200", async () => {
    for (const path of ["/paper/doi_10.5555_unknown/", "/paper/DOI_10.5555_UNKNOWN/", "/author", "/nothing/"]) {
      const res = await handlePage(new Request(`${SITE}${path}`), site());
      assert.equal(res.status, 404, path);
    }
  });

  it("send a slug in capitals to the paper's one address, static or rendered on demand", async () => {
    const onDemand = await handlePage(new Request(`${SITE}/paper/${SLUG.toUpperCase()}/`), site());
    assert.equal(onDemand.status, 301);
    assert.equal(onDemand.headers.get("Location"), `${SITE}/paper/${SLUG}/`);
    const statics = await handlePage(new Request(`${SITE}/paper/DOI_10.5555_STATIC.1/`), site());
    assert.equal(statics.status, 301);
    assert.equal(statics.headers.get("Location"), `${SITE}/paper/doi_10.5555_static.1/`);
  });
});
