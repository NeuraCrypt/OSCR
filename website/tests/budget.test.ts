// The site's file budget (src/lib/shards.ts): the number of files does not grow with the
// catalogue; the markup of the pages rendered on demand (src/lib/render.ts); and the Worker's
// route for the pages no static file answers (worker/pages.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  a, doiUrl, entityView, esc, href, listing, missingEntity, paperView, wrapParts,
  type AuthorRecord, type PaperRecord, type Row, type ToolRecord,
} from "../src/lib/render.ts";
import {
  ENTITY_ROWS_MAX, ENTITY_TYPES, FILE_MARGIN, FIXED_FILES_MAX, groupShards, keyOf, lookupShard, MAX_CATEGORIES, packEntities,
  SHARDS, shardOf, STATIC_PAPERS, staticSelection,
} from "../src/lib/shards.ts";
import worker from "../worker/index.ts";
import { type Assets, fillShell, handlePage, PAPER_HEADERS } from "../worker/pages.ts";

const ctx = { waitUntil: () => undefined };

describe("the shards", () => {
  it("are named the way oscr/entities.py names the lookup's (the same test vectors on both sides)", async () => {
    assert.equal(await lookupShard("10.5555/oscr.fixture.5"), "04");
    assert.equal(await shardOf("10.5555/oscr.fixture.5", 256), "04", "256 shards: the lookup's rule");
    assert.equal(await shardOf("0000-0000-0000-0028", 64), "20");
    assert.equal(await shardOf("0000-0000-0000-001X", 1024), "373");
    assert.equal(await shardOf("05a0dhs15", 512), "196");
    assert.equal(await shardOf("doi_10.5555_oscr.fixture.2", 256), "09");
    assert.equal(await shardOf("anything", 1), "00");
  });

  it("are a power of two per type", async () => {
    for (const n of Object.values(SHARDS)) assert.ok(n >= 1 && n <= 65_536 && (n & (n - 1)) === 0, String(n));
    await assert.rejects(shardOf("x", 100), RangeError);
    await assert.rejects(shardOf("x", 131_072), RangeError);
  });

  it("read a key from an address the way the build names it", () => {
    assert.equal(keyOf("author", "0000-0000-0000-001x"), "0000-0000-0000-001X");
    assert.equal(keyOf("institution", "05A0DHS15"), "05a0dhs15");
    assert.equal(keyOf("paper", "doi_10.5555_oscr.fixture.2"), "doi_10.5555_oscr.fixture.2");
    assert.equal(keyOf("tool", "a%2Fb"), "");
    assert.equal(keyOf("tool", "%E0%A4%A"), "");
    assert.equal(keyOf("tool", "<script>"), "");
    assert.equal(keyOf("tool", "x".repeat(161)), "");
  });
});

/** A synthetic entity with `papers` papers, as the build packs it. */
const entity = (i: number, papers: number) => ({
  key: `${String(i).padStart(4, "0")}-0000-0000-000${i % 10}`,
  record: { name: `Author ${i}` },
  rows: Array.from({ length: papers }, (_, j) => [`doi_10.5555_p${(i * 7 + j) % 50_000}`, { title: `Paper ${j}` }] as [string, unknown]),
});

describe("the number of files", () => {
  it("of an entity type stays at most its shards, from 10 entities to 100,000", async () => {
    for (const count of [10, 1_000, 100_000]) {
      const packed = await packEntities(Array.from({ length: count }, (_, i) => entity(i, 3)), SHARDS.author);
      assert.ok(packed.size <= SHARDS.author, `${count} entities: ${packed.size} files`);
      assert.equal([...packed.values()].reduce((n, s) => n + Object.keys(s.entities).length, 0), count);
      if (count >= 100_000) assert.equal(packed.size, SHARDS.author, "every shard used, none more");
    }
  });

  it("of the papers stays at most 2 × STATIC_PAPERS static files and SHARDS.paper records", async () => {
    for (const count of [100, 10_000, 90_000]) {
      const papers = Array.from({ length: count }, (_, i) => ({
        slug: `doi_10.5555_p${i}`,
        published: `20${String(10 + (i % 17)).padStart(2, "0")}-0${1 + (i % 9)}-1${i % 10}`,
      }));
      const chosen = staticSelection(papers);
      assert.equal(chosen.size, Math.min(count, STATIC_PAPERS));
      const records = await groupShards(papers.filter((p) => !chosen.has(p.slug)).map((p) => [p.slug, p] as const), SHARDS.paper);
      assert.ok(records.size <= SHARDS.paper, `${count} papers: ${records.size} record files`);
      // The static ones are the most recent.
      const oldest = [...chosen].map((s) => papers.find((p) => p.slug === s)!.published).sort()[0];
      assert.ok(papers.every((p) => chosen.has(p.slug) || p.published <= oldest));
    }
    // What the check (scripts/check.mjs) holds the build to adds up to the margin.
    assert.ok(2 * STATIC_PAPERS + FIXED_FILES_MAX <= FILE_MARGIN);
    // The shards (the lookup's 256 with them), the lots of scripts and the category pages leave
    // room for the fixed pages and bundles.
    const shardFiles = Object.values(SHARDS).reduce((n, x) => n + x, 0) + 256;
    assert.ok(shardFiles + 128 + MAX_CATEGORIES + 100 <= FIXED_FILES_MAX, `${shardFiles} shard files`);
  });

  it("chooses the same static papers at every build, ties broken by name", () => {
    const papers = [
      { slug: "b", published: "2026-09-21" },
      { slug: "a", published: "2026-09-21" },
      { slug: "c", published: "2026-09" },
      { slug: "d", published: "2026-09-22" },
    ];
    assert.deepEqual([...staticSelection(papers, 3)], ["d", "a", "b"]);
    assert.deepEqual([...staticSelection([...papers].reverse(), 3)], ["d", "a", "b"]);
  });

  it("writes each paper's row once per shard, however many of its entities list it", async () => {
    const packed = await packEntities(
      Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, record: {}, rows: [["shared", { n: i }] as [string, unknown]] })),
      4,
    );
    for (const s of packed.values()) assert.deepEqual(Object.keys(s.rows), ["shared"]);
  });
});

const row = (over: Partial<Row> = {}): Row => ({
  slug: "doi_10.5555_x.1",
  doi: "10.5555/x.1",
  title: "A <b>bold</b> study & more",
  journal: "Journal of \"Tests\"",
  published: "2026-09-21",
  status: "code_verified",
  code: [{ repo: "github.com/lab/x", url: "https://github.com/lab/x", name: "lab/x", license: "MIT" }],
  files: 3,
  pairs: 2,
  map: "",
  data: 0,
  reader: true,
  ...over,
});

describe("the markup", () => {
  it("escapes every text and keeps only web addresses and this site's paths as links", () => {
    assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    assert.equal(href("javascript:alert(1)"), "");
    assert.equal(href("//evil.example/x"), "");
    assert.equal(href("https://ok.example/a?b=1"), "https://ok.example/a?b=1");
    assert.equal(href("/author/x/"), "/author/x/");
    assert.equal(a("x", "javascript:alert(1)"), "x");
    assert.equal(a("x", "data:text/html,1", "code"), `<span class="code">x</span>`);
    assert.equal(doiUrl("10.1002/(SICI)1097-0258<1661::AID>3.0.CO;2-2"), "https://doi.org/10.1002/(SICI)1097-0258%3C1661::AID%3E3.0.CO;2-2");
    assert.deepEqual(wrapParts("https://doi.org/10.1016/j.x"), ["https://", "doi.org/", "10.1016/", "j.x"]);
    // A long name in a link may break, on a phone: after a slash, or inside a run of 24 characters.
    assert.equal(a("gitlab.esrf.fr/night_rail/applications", "https://x.example/", "code"),
      `<a class="code" href="https://x.example/">gitlab.esrf.fr/<wbr>night_rail/<wbr>applications</a>`);
    assert.equal(a("model_neural_tube_patterning_and_isthmic", ""), "model_neural_tube_patter<wbr>ning_and_isthmic");
  });

  it("lists papers the catalogue's way, the reader linked only where it is built", () => {
    const html = listing([row(), row({ slug: "doi_10.5555_x.2", doi: "10.5555/x.2", reader: false }), row({
      slug: "doi_10.5555_x.3", doi: "10.5555/x.3", published: "2026-09-20", status: "on_request", code: [], data: 2,
    })]);
    assert.equal(html.match(/<h2 class="day">/g)?.length, 2);
    assert.equal(html.match(/<dt>/g)?.length, 3);
    assert.equal(html.match(/class="reader-link"/g)?.length, 1);
    assert.ok(html.includes(`<a class="reader-link" href="/paper/doi_10.5555_x.1/code/">Code ↔ Paper</a>`));
    assert.ok(html.includes("A &lt;b&gt;bold&lt;/b&gt; study &amp; more"));
    assert.ok(html.includes(`<span class="ok">code verified</span>, 3 files readable, 2 matches`));
    assert.ok(html.includes(`<a href="/paper/doi_10.5555_x.3/#data">data</a>`));
    assert.ok(html.includes("2 datasets cited"));
    assert.ok(!/<script|style=/.test(html));
    assert.ok(listing([row()], { searchable: true }).includes(`data-journal="journal of &quot;tests&quot;"`));
  });

  it("renders an entity with its links, and says what it leaves out", () => {
    const author: AuthorRecord = {
      orcid: "0000-0000-0000-001X",
      name: "Ada <img src=x onerror=alert(1)>",
      counts: { papers: ENTITY_ROWS_MAX + 7, with_code: 1 },
      affiliations: ["Lab & Co"],
      institutions: [{ text: "Fixture University", href: "/institution/0fixtur00/" }, { text: "Elsewhere", href: "" }],
      tools: [{ text: "NumPy", href: "/tool/numpy/" }],
      tools_total: 3,
      papers: ["doi_10.5555_x.1", "doi_10.5555_missing"],
      search: "/search/?q=author%3A%22Ada%22",
    };
    const v = entityView("author", author, { "doi_10.5555_x.1": row() });
    assert.equal(v.title, author.name);
    assert.ok(v.html.startsWith("<h1>Ada &lt;img src=x onerror=alert(1)&gt;</h1>"));
    assert.ok(v.html.includes(`<a href="https://orcid.org/0000-0000-0000-001X">`));
    assert.ok(v.html.includes(`<a href="/institution/0fixtur00/">Fixture University</a>, Elsewhere`));
    assert.ok(v.html.includes(`<a href="/tool/numpy/">NumPy</a>, and 2 more</div>`));
    assert.ok(v.html.includes("<h2>Papers</h2>"));
    assert.ok(v.html.includes(`The 1 most recent of its ${ENTITY_ROWS_MAX + 7} papers are listed here; <a href="/search/?q=author%3A%22Ada%22">all of them in the search</a>.`));
    const tool: ToolRecord = {
      name: "NumPy", kind: "library", homepage: "javascript:x", rrid: "RRID:SCR_008633", rrid_url: "https://scicrunch.org/resolver/RRID:SCR_008633",
      counts: { papers: 1, with_code: 1, repositories: 3 }, repositories: [{ text: "lab/x", href: "https://github.com/lab/x" }],
      papers: ["doi_10.5555_x.1"], search: "",
    };
    const t = entityView("tool", tool, { "doi_10.5555_x.1": row() });
    assert.ok(!t.html.includes("javascript"));
    assert.ok(t.html.includes(`<details open><summary>3 repositories whose code uses NumPy</summary>`));
    assert.ok(t.html.includes(`<li>and 2 other repositories, with less evidence</li>`));
    assert.ok(!t.html.includes("most recent of its"));
    for (const type of ENTITY_TYPES) {
      const m = missingEntity(type, "0000-x");
      assert.match(m.html, /^<h1>No such [a-z]+<\/h1>/);
      assert.ok(m.html.includes(`href="/${type}s/"`));
    }
  });

  it("renders a paper past the static ones: its record, and what it leaves out", () => {
    const v = paperView(PAPER);
    for (const id of ["overview", "code", "data"]) assert.ok(v.html.includes(`<section id="${id}">`), id);
    assert.ok(v.html.includes(`<p class="warning"><strong>This paper has been retracted</strong> (26 September 2026)`));
    assert.ok(v.html.includes(`<a href="/author/0000-0000-0000-0028/">Ben Example</a>, Dan Nameless`));
    assert.ok(v.html.includes(`${STATIC_PAPERS.toLocaleString("en-GB")} most recent papers have a fuller page`));
    assert.ok(v.html.includes(`<a class="code" href="https://github.com/oscr-fixture/unlicensed">`));
    assert.ok(v.html.includes(`<span class="ok">the link answers</span>`));
    assert.ok(v.html.includes(`<a href="https://doi.org/10.5555/oscr.fixture.2">10.5555/<wbr>oscr.fixture.2</a>`));
    assert.ok(v.html.startsWith(`<div class="record"><div class="body"><h1>`) && v.html.includes(`<aside class="sidebar">`));
    assert.equal(v.crumb, "doi:10.5555/oscr.fixture.2");
    // The data links other than the datasets', and the Contribute section of the static pages, with
    // the ids their script (src/scripts/paper-actions.ts) reads.
    assert.ok(v.html.includes(`<h3>Data links</h3><ul><li><a class="code" href="https://osf.io/abcde/">osf:abcde</a> — OSF</li></ul>`));
    assert.ok(v.html.includes(`<section id="contribute" data-paper="doi:10.5555/oscr.fixture.2" data-doi="10.5555/oscr.fixture.2" data-digest="" data-back="/paper/doi_10.5555_oscr.fixture.2/">`));
    for (const id of ["contribute-status", "contribute-signed-out", "contribute-signed-in", "contribute-who", "claim-block", "claim-state",
      "claim-form", "claim-statement", "edit-block", "edit-form", "edit-links", "edit-add", "edit-add-role", "edit-note", "edit-state",
      "removal", "removal-signed-out", "removal-state", "removal-form", "removal-reason", "removal-details"]) {
      assert.ok(v.html.includes(` id="${id}"`), id);
    }
    assert.ok(v.html.includes(`<li data-repo="github.com/oscr-fixture/unlicensed" data-role="code">`));
    assert.ok(v.html.includes(`<li data-repo="osf:abcde" data-role="data">`));
    assert.ok(v.html.includes(`<option value="code" selected>the authors&#39; code</option>`));
    assert.ok(v.html.includes(`<a href="/api/auth/orcid/start?return=/paper/doi_10.5555_oscr.fixture.2/">Sign in with ORCID</a>`));
    assert.ok(v.html.includes(`<li><a href="#contribute">Contribute</a></li>`));
    assert.ok(!/<script|style=/.test(v.html));
    const cited = paperView({ ...PAPER, datasets: [{ text: "ds000001", href: "/dataset/ds000001/" }], data: [{ ...PAPER.data[0], cited: true }] });
    assert.ok(cited.html.includes(`<h3>Datasets cited</h3>`) && !cited.html.includes("Data links"), "a cited dataset's link is not listed twice");
    const folded = paperView({ ...PAPER, authors: Array.from({ length: 30 }, (_, i) => ({ text: `A${i}`, href: "" })) });
    assert.ok(folded.html.includes("<details><summary>and 10 other authors</summary>"));
  });
});

const PAPER: PaperRecord = {
  id: "doi:10.5555/oscr.fixture.2",
  slug: "doi_10.5555_oscr.fixture.2",
  doi: "10.5555/oscr.fixture.2",
  title: "A synthetic study whose code has no license",
  journal: { text: "Journal of Synthetic Fixtures", href: "/journal/issn-0000-0019/" },
  published: "2026-09-22",
  type: "Research article",
  license: "CC BY-NC-ND 4.0",
  status: "code_verified",
  notices: [{ kind: "retraction", id: "10.5555/r.2", date: "2026-09-26", source: "Retraction Watch", url: "https://doi.org/10.5555/r.2" }],
  authors: [{ text: "Ben Example", href: "/author/0000-0000-0000-0028/" }, { text: "Dan Nameless", href: "" }],
  institutions: [{ text: "Fixture University (Netherlands)", href: "/institution/0fixtur00/" }],
  categories: [{ text: "EEG (modality)", href: "/browse/modality/eeg/" }],
  code: [{ repo: "github.com/oscr-fixture/unlicensed", name: "oscr-fixture/unlicensed", url: "https://github.com/oscr-fixture/unlicensed", license: "", state: "alive" }],
  files: 1,
  pairs: 0,
  map: "",
  datasets: [],
  data: [{ repo: "osf:abcde", url: "https://osf.io/abcde/", repository: "OSF", cited: false }],
  tools: [],
  europepmc: "https://europepmc.org/article/PMC/PMC0000002",
};

const SHELL =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Paper — OSCR</title>` +
  `<meta name="description" content="A paper."><meta name="application-name" content="OSCR">` +
  `<meta property="og:title" content="Paper"><meta property="og:description" content="A paper."></head><body>` +
  `<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">OSCR</a> › <a href="/">Catalogue</a> › <span id="crumb">Paper</span></nav>` +
  `<main><div id="paper"><h1>Paper</h1><script type="module" src="/_astro/paper-shell.js"></script></div></main>` +
  `<footer>OSCR</footer></body></html>`;
const NOT_FOUND = "<!doctype html><title>Page not found — OSCR</title><main><h1>Page not found</h1></main>";

/** The Worker's static assets: a few files, and html_handling's redirect of "/x.html" to "/x". */
function assets(files: Record<string, string>): Assets & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      asked.push(path);
      if (path.endsWith(".html")) {
        return new Response(null, { status: 307, headers: { Location: path.slice(0, -5) } });
      }
      const file = files[path] ?? files[`${path}.html`];
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file, { status: 200 });
    },
  };
}
const site = () =>
  assets({
    "/paper/404.html": SHELL,
    "/404.html": NOT_FOUND,
    "/records/paper/09.json": JSON.stringify({ [PAPER.slug]: PAPER }),
  });
const get = (path: string, init?: RequestInit) => new Request(`https://oscr.example${path}`, init);

describe("a page that no static file answers (worker/pages.ts)", () => {
  it("is a paper's page past the static ones, rendered from its record, with the static pages' headers", async () => {
    const files = site();
    const res = await handlePage(get(`/paper/${PAPER.slug}/`), files);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<title>A synthetic study whose code has no license — OSCR</title>"));
    assert.ok(html.includes(`<span id="crumb">doi:10.5555/oscr.fixture.2</span>`));
    assert.ok(html.includes(`<meta property="og:title" content="A synthetic study whose code has no license">`));
    assert.ok(html.includes(`<main><div class="record"><div class="body"><h1>`));
    assert.ok(!html.includes(`<div id="paper">`), "the shell's content is replaced with the paper's");
    assert.ok(html.includes(`</section></div><aside class="sidebar">`));
    assert.ok(
      html.includes(`</aside></div><script type="module" src="/_astro/paper-shell.js"></script></main>`),
      "the shell's script stays, after the page: it runs the Contribute section",
    );
    assert.ok(html.includes("<footer>OSCR</footer>"));
    for (const [k, v] of Object.entries(PAPER_HEADERS)) assert.equal(res.headers.get(k), v, k);
    assert.deepEqual(files.asked, ["/records/paper/09.json", "/paper/404.html", "/paper/404"]);
  });

  it("gives the paper's page the headers public/_headers gives the static ones", () => {
    const rules = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
    const block = rules.split(/\n(?=\S)/).find((b) => b.startsWith("/paper/:slug/"))!;
    const declared = Object.fromEntries(
      block.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
    );
    assert.deepEqual(declared, PAPER_HEADERS);
  });

  it("sends the reader and the address without its slash to the page", async () => {
    const reader = await handlePage(get(`/paper/${PAPER.slug}/code/`), site());
    assert.equal(reader.status, 302);
    assert.equal(reader.headers.get("Location"), `https://oscr.example/paper/${PAPER.slug}/#code`);
    const bare = await handlePage(get(`/paper/${PAPER.slug}`), site());
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("Location"), `https://oscr.example/paper/${PAPER.slug}/`);
  });

  it("is the site's 404 page for anything else, a paper it does not know included", async () => {
    for (const path of ["/paper/doi_10.5555_unknown/", "/nothing/", "/paper/%E0%A4%A/", "/paper/a/b/c/", "/author"]) {
      const res = await handlePage(get(path), site());
      assert.equal(res.status, 404, path);
      assert.ok((await res.text()).includes("<h1>Page not found</h1>"), path);
    }
    const head = await handlePage(get(`/paper/${PAPER.slug}/`, { method: "HEAD" }), site());
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await handlePage(get(`/paper/${PAPER.slug}/`, { method: "POST" }), site())).status, 405);
  });

  it("is reached through the Worker's entry point, but not for /api/*", async () => {
    const env = { ASSETS: site() };
    assert.equal((await worker.fetch(get(`/paper/${PAPER.slug}/`), env, ctx)).status, 200);
    const api = await worker.fetch(get("/api/nothing"), env, ctx);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error.code, "not_found");
  });

  it("fills a shell with escaped text, and refuses one that lacks what it replaces", () => {
    const out = fillShell(SHELL, { title: `A "quoted" <title> & $1 $&`, description: "d <x>", crumb: "c & c", html: "<p>body</p>" })!;
    assert.ok(out.includes("<title>A &quot;quoted&quot; &lt;title&gt; &amp; $1 $&amp; — OSCR</title>"));
    assert.ok(out.includes(`<meta name="description" content="d &lt;x&gt;">`));
    assert.ok(out.includes(`<span id="crumb">c &amp; c</span>`));
    assert.ok(out.includes(`<main><p>body</p><script type="module" src="/_astro/paper-shell.js"></script></main>`));
    // Only the build's module scripts stay: nothing inline, nothing from elsewhere.
    const other = SHELL.replace(
      `<script type="module" src="/_astro/paper-shell.js"></script>`,
      `<script>alert(1)</script><script type="module" src="//evil.example/x.js"></script>`,
    );
    assert.ok(fillShell(other, { title: "", description: "", crumb: "", html: "<p>body</p>" })!.includes("<main><p>body</p></main>"));
    assert.equal(fillShell("<html><body>no main</body></html>", { title: "", description: "", crumb: "", html: "" }), null);
  });
});
