// The badges (src/lib/badge.ts, worker/badge.ts; docs/BADGE.md): what they say, how they are drawn,
// their addresses and snippets, and the Worker's routes (image, shields.io endpoint, link), its
// headers (CORS, cache, ETag, a policy that lets the SVG load and run nothing) and its reads (static
// files only). The data is mocked with the real shard names, so the test needs no build.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import worker from "../worker/index.ts";
import type { Assets } from "../worker/pages.ts";
import { lookupShard, shardOf, SHARDS } from "../src/lib/shards.ts";
import { REPO_SHARDS } from "../src/lib/apispec.ts";
import {
  badgeDoi, badgeMessage, badgeRepoKey, badgeUrls, cleanText, endpointJson, hasBadge, readOptions, renderBadge, snippet,
  textWidth, DEFAULT_OPTIONS,
} from "../src/lib/badge.ts";

const ctx = { waitUntil: () => undefined };
const ORIGIN = "https://openscicode.org";
const get = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);

const DOI = "10.5555/oscr.fixture.1";
const SLUG = "doi_10.5555_oscr.fixture.1";
const VALID = "10.5555/oscr.fixture.2";
const VSLUG = "doi_10.5555_oscr.fixture.2";
const REPO = "github.com/oscr-fixture/eeg-analysis";
const MANY = "github.com/oscr-fixture/toolbox";

async function files(): Promise<Record<string, string>> {
  const lookup: Record<string, Record<string, unknown>> = {};
  const add = async (doi: string, entry: unknown[]) => {
    const s = await lookupShard(doi);
    (lookup[s] ??= {})[doi] = entry;
  };
  await add(DOI, ["code_verified", "2026-09-20", SLUG]);
  await add(VALID, ["code_found", "2026-09-20", VSLUG]);
  await add("10.5555/nopage", ["none", "2026-09-20"]);
  const papers: Record<string, Record<string, unknown>> = {};
  const paper = async (slug: string, rec: unknown) => ((papers[await shardOf(slug, SHARDS.paper)] ??= {})[slug] = rec);
  await paper(SLUG, {
    slug: SLUG, doi: DOI, title: "A synthetic EEG study", published: "2026-03-02", status: "code_verified", journal: { title: "eLife" },
    code: [{ repo: REPO, url: `https://${REPO}`, license: "MIT", scripts: 12, languages: { Python: 10, R: 2 } }], map_doi: "", links: { record: `/paper/${SLUG}/` },
  });
  await paper(VSLUG, { slug: VSLUG, doi: VALID, title: "Validated", status: "code_found", code: [{ repo: MANY, url: `https://${MANY}` }], map_doi: "10.5281/zenodo.9" });
  const repos: Record<string, Record<string, unknown>> = {};
  const repo = async (key: string, rec: unknown) => ((repos[await shardOf(key, REPO_SHARDS)] ??= {})[key] = rec);
  await repo(REPO, { repo: REPO, url: `https://${REPO}`, license: "MIT", scripts: 12, languages: { Python: 10 }, papers: [{ doi: DOI, title: "A synthetic EEG study", record: `/paper/${SLUG}/` }] });
  await repo(MANY, { repo: MANY, papers: [{ doi: DOI, title: "One", record: "/paper/a/" }, { doi: VALID, title: "Two", record: "/paper/b/" }] });
  const out: Record<string, string> = {
    "/badge/site.json": JSON.stringify({ name: "OSCR" }),
    "/badge/tools.json": JSON.stringify({
      "github.com/yannbellec/evoparam": { slug: "evoparam", name: "evoparam", page: "/scientific-tools/evoparam/", licence: "Apache-2.0", files: 40, languages: { Python: 900 } },
    }),
  };
  for (const [s, v] of Object.entries(lookup)) out[`/lookup/${s}.json`] = JSON.stringify(v);
  for (const [s, v] of Object.entries(papers)) out[`/data/papers/${s}.json`] = JSON.stringify(v);
  for (const [s, v] of Object.entries(repos)) out[`/data/repos/${s}.json`] = JSON.stringify(v);
  return out;
}

let reads: string[] = [];
function assets(map: Record<string, string>): Assets {
  return {
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      reads.push(path);
      const file = map[path];
      return file === undefined ? new Response(null, { status: 404 }) : new Response(file, { status: 200 });
    },
  };
}

let env: { ASSETS: Assets };
beforeEach(async () => {
  reads = [];
  env = { ASSETS: assets(await files()) };
});

describe("what a badge says", () => {
  it("says the paper's state, in words, with its tone", () => {
    assert.deepEqual(badgeMessage({ kind: "paper", status: "code_verified" }), { text: "paper ↔ code", tone: "info" });
    assert.deepEqual(badgeMessage({ kind: "paper", status: "code_found", mapDoi: "10.5281/zenodo.9" }), { text: "paper ↔ code · validated", tone: "ok" });
    assert.equal(badgeMessage({ kind: "paper", status: "on_request" }).text, "code on request");
    assert.equal(badgeMessage({ kind: "paper", status: "data_only" }).text, "data only");
    assert.deepEqual(badgeMessage({ kind: "unknown" }), { text: "not registered", tone: "muted" });
    assert.equal(badgeMessage({ kind: "read", doi: "10.1/x" }).text, "read, no code found");
    assert.equal(badgeMessage({ kind: "repo", papers: 3 }).text, "code of 3 papers");
  });

  it("says another fact when asked, and falls back to the state when it has none", () => {
    const f = { kind: "paper" as const, doi: DOI, scripts: 1, languages: { Python: 3, R: 1 }, license: "MIT", journal: "eLife", year: "2026", repos: 2 };
    assert.equal(badgeMessage(f, "doi").text, DOI);
    assert.equal(badgeMessage(f, "scripts").text, "1 script");
    assert.equal(badgeMessage(f, "language").text, "Python + 1");
    assert.equal(badgeMessage(f, "license").text, "MIT");
    assert.equal(badgeMessage(f, "journal").text, "eLife, 2026");
    assert.equal(badgeMessage(f, "code").text, "2 repositories");
    assert.equal(badgeMessage(f, "map").text, "no validated map yet");
    assert.equal(badgeMessage({ kind: "paper" }, "license").text, "paper ↔ code");
  });

  it("reads its options from a query, dropping what it does not know", () => {
    const o = readOptions(new URLSearchParams("style=LARGE&show=doi&theme=light&text=hello%20a@b.org&missing=hide&x=1"));
    assert.deepEqual(o, { style: "large", show: "doi", theme: "light", text: "hello", missing: "hide" });
    assert.deepEqual(readOptions(new URLSearchParams("style=pill&show=views")), DEFAULT_OPTIONS);
    assert.equal(cleanText("a\u2014b\u0000c".padEnd(80, "x")).length, 40);
    assert.ok(!cleanText("a\u2014b").includes("\u2014"));
  });
});

describe("how a badge is drawn", () => {
  it("is an accessible SVG, its text escaped, its logo inside it, never a rounded pill", () => {
    const svg = renderBadge("OSCR", { kind: "paper" }, { ...DEFAULT_OPTIONS, text: `<script>"&` });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /role="img" aria-label="OSCR: &lt;script&gt;&quot;&amp;"/);
    assert.match(svg, /<title>OSCR: &lt;script&gt;&quot;&amp;<\/title>/);
    assert.ok(!svg.includes("<script"));
    assert.match(svg, /xlink:href="data:image\/png;base64,/);
    assert.ok(!/\srx=/.test(svg), "no rounded corners");
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), "loads nothing from elsewhere");
    assert.ok(!svg.includes("\u2014"));
  });

  it("fits its width to its text, and its shapes to their sizes", () => {
    const w = (svg: string) => Number(/ width="([\d.]+)"/.exec(svg)![1]);
    const short = renderBadge("OSCR", { kind: "paper" }, { ...DEFAULT_OPTIONS, text: "ab" });
    const long = renderBadge("OSCR", { kind: "paper" }, { ...DEFAULT_OPTIONS, text: "a much longer text here" });
    assert.ok(w(long) > w(short) + 80);
    assert.match(renderBadge("OSCR", { kind: "paper" }, { ...DEFAULT_OPTIONS, style: "large" }), / height="28"/);
    assert.ok(!renderBadge("OSCR", { kind: "paper" }, { ...DEFAULT_OPTIONS, style: "mark" }).includes("<text"));
    const card = renderBadge("OSCR", { kind: "paper", title: "T".repeat(200), journal: "eLife", year: "2026", doi: DOI }, { ...DEFAULT_OPTIONS, style: "card" });
    assert.match(card, /width="420" height="64"/);
    assert.match(card, /T…<\/text>/);
    assert.equal(renderBadge("OSCR", { kind: "unknown" }, { ...DEFAULT_OPTIONS, missing: "hide" }).includes('width="0"'), true);
    assert.ok(Math.abs(textWidth("paper ↔ code") - 75) < 10);
  });

  it("answers shields.io's endpoint schema", () => {
    const j = endpointJson("OSCR", { kind: "paper", mapDoi: "10.5281/zenodo.9" });
    assert.equal(j.schemaVersion, 1);
    assert.equal(j.label, "OSCR");
    assert.equal(j.message, "paper ↔ code · validated");
    assert.match(j.color, /^[0-9a-f]{6}$/i);
    assert.match(j.logoSvg, /^<svg /);
    assert.equal(j.isError, false);
  });
});

describe("its addresses and snippets", () => {
  it("normalizes DOIs and repositories as the registry keys them", () => {
    assert.equal(badgeDoi("https://doi.org/10.1234/ABC"), "10.1234/abc");
    assert.equal(badgeDoi("not a doi"), "");
    assert.equal(badgeRepoKey("https://github.com/Lab/EEG.git"), "github.com/lab/eeg");
    assert.equal(badgeRepoKey("git@github.com:Lab/EEG.git"), "github.com/lab/eeg");
    assert.equal(badgeRepoKey("https://github.com/lab/eeg/tree/main/src"), "github.com/lab/eeg");
    assert.equal(badgeRepoKey("https://gitlab.com/group/sub/proj/-/tree/main"), "gitlab.com/group/sub/proj");
    assert.equal(badgeRepoKey("https://huggingface.co/datasets/Org/Set"), "huggingface.co/datasets/org/set");
    assert.equal(badgeRepoKey("https://huggingface.co/Org/Model/blob/main/README.md"), "huggingface.co/org/model");
    assert.equal(badgeRepoKey("https://huggingface.co/spaces/x"), "");
    assert.equal(badgeRepoKey("github.com/only"), "");
  });

  it("writes the same addresses as the command line (cli/tests/test_badge.py)", () => {
    assert.deepEqual(badgeUrls(ORIGIN, { kind: "doi", doi: "10.1234/a#b c" }).image, `${ORIGIN}/badge/doi/10.1234/a%23b%20c.svg`);
    const r = badgeUrls(ORIGIN, { kind: "repo", repo: "github.com/lab/eeg" }, { style: "large", show: "doi" }, "map");
    assert.equal(r.image, `${ORIGIN}/badge/repo/github.com/lab/eeg.svg?style=large&show=doi`);
    assert.equal(r.link, `${ORIGIN}/badge/repo/github.com/lab/eeg?to=map`);
    assert.equal(r.json, `${ORIGIN}/badge/repo/github.com/lab/eeg.json?show=doi`);
    assert.ok(r.shields.startsWith("https://img.shields.io/endpoint?url=https%3A%2F%2F"));
    assert.equal(badgeUrls("https://x.org", { kind: "doi", doi: "10.1/fig.svg" }).image, "https://x.org/badge/doi.svg?doi=10.1%2Ffig.svg");
    assert.equal(snippet("markdown", "I", "L", "OSCR"), "[![OSCR](I)](L)");
    assert.equal(snippet("rst", "I", "L", "OSCR"), ".. image:: I\n   :target: L\n   :alt: OSCR");
    assert.equal(snippet("html", "I?a&b", "L", "OSCR"), '<a href="L"><img src="I?a&amp;b" alt="OSCR"></a>');
    assert.equal(snippet("latex", "I", "https://x.org/a_b%c", "OSCR"), "\\href{https://x.org/a\\_b\\%c}{\\includegraphics[height=1.2em]{oscr-badge.png}}");
  });

  it("finds a badge already in a README, in any of its forms", () => {
    assert.ok(hasBadge("[![OSCR](https://openscicode.org/badge/doi/10.1/x.svg)](…)", "openscicode.org"));
    assert.ok(hasBadge("![x](https://img.shields.io/endpoint?url=https%3A%2F%2Fopenscicode.org%2Fbadge%2Fdoi%2F10.1%2Fx.json)", "openscicode.org"));
    assert.ok(hasBadge("<!-- oscr-badge:start -->", "openscicode.org"));
    assert.ok(hasBadge("https://openscicode.org/badge.svg", "openscicode.org"));
    assert.ok(!hasBadge("# A README", "openscicode.org"));
  });
});

describe("the Worker's badges", () => {
  it("draws a paper's badge from the static files only, cached and embeddable", async () => {
    const res = await worker.fetch(get(`/badge/doi/${DOI}.svg`), env, ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /^image\/svg\+xml/);
    assert.match(res.headers.get("Cache-Control") ?? "", /max-age=3600/);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
    assert.ok(res.headers.get("ETag"));
    const svg = await res.text();
    assert.match(svg, /aria-label="OSCR: paper ↔ code"/);
    assert.ok(reads.every((p) => /^\/(lookup|data\/papers|badge\/site)/.test(p)), reads.join(" "));
  });

  it("says validated, unknown, read, and a repository's paper", async () => {
    assert.match(await (await worker.fetch(get(`/badge/doi/${VALID}.svg`), env, ctx)).text(), /validated/);
    assert.match(await (await worker.fetch(get("/badge/doi/10.9999/unknown.svg"), env, ctx)).text(), /not registered/);
    assert.match(await (await worker.fetch(get("/badge/doi/10.5555/nopage.svg"), env, ctx)).text(), /read, no code found/);
    assert.match(await (await worker.fetch(get(`/badge/repo/${REPO}.svg?show=scripts`), env, ctx)).text(), /12 scripts/);
    assert.match(await (await worker.fetch(get(`/badge/repo/${MANY}.svg`), env, ctx)).text(), /code of 2 papers/);
    const hidden = await (await worker.fetch(get("/badge/repo/gitlab.com/g/unknown.svg?missing=hide"), env, ctx)).text();
    assert.match(hidden, /width="0"/);
    // A DOI with characters of its own, percent-encoded, and the query form.
    assert.equal((await worker.fetch(get(`/badge/doi/${encodeURIComponent(DOI).replace(/%2F/g, "/")}.svg`), env, ctx)).status, 200);
    assert.match(await (await worker.fetch(get(`/badge/doi.svg?doi=${encodeURIComponent(DOI)}`), env, ctx)).text(), /paper ↔ code/);
  });

  it("answers shields.io's endpoint", async () => {
    const res = await worker.fetch(get(`/badge/doi/${DOI}.json?show=doi`), env, ctx);
    assert.match(res.headers.get("Content-Type") ?? "", /^application\/json/);
    const j = JSON.parse(await res.text());
    assert.equal(j.schemaVersion, 1);
    assert.equal(j.message, DOI);
  });

  it("links to the paper, or where the reader asked, or to the submission", async () => {
    const at = async (path: string) => {
      const res = await worker.fetch(get(path), env, ctx);
      assert.equal(res.status, 302, path);
      return res.headers.get("Location");
    };
    assert.equal(await at(`/badge/doi/${DOI}`), `${ORIGIN}/paper/${SLUG}/`);
    assert.equal(await at(`/badge/doi/${DOI}?to=map`), `${ORIGIN}/paper/${SLUG}/#map`);
    assert.equal(await at(`/badge/doi/${DOI}?to=code`), `https://${REPO}`);
    assert.equal(await at(`/badge/doi/${DOI}?to=doi`), `https://doi.org/${DOI}`);
    assert.equal(await at(`/badge/doi/${DOI}?to=nowhere`), `${ORIGIN}/paper/${SLUG}/`);
    assert.equal(await at("/badge/doi/10.9999/unknown"), `${ORIGIN}/submit/?doi=10.9999%2Funknown`);
    assert.equal(await at("/badge/doi/10.5555/nopage"), `${ORIGIN}/lookup/?doi=10.5555%2Fnopage`);
    assert.equal(await at(`/badge/repo/${REPO}`), `${ORIGIN}/paper/${SLUG}/`);
    assert.equal(await at(`/badge/repo/${MANY}`), `${ORIGIN}/badge/?repo=${encodeURIComponent(MANY)}`);
    assert.equal(await at("/badge/repo/github.com/x/y"), `${ORIGIN}/submit/?code=${encodeURIComponent("https://github.com/x/y")}`);
    assert.equal(await at("/badge/repo/github.com/YannBellec/evoparam"), `${ORIGIN}/scientific-tools/evoparam/`);
    assert.equal(await at("/badge/repo/github.com/yannbellec/evoparam?to=code"), "https://github.com/yannbellec/evoparam");
  });

  it("draws a scientific tool's badge from /badge/tools.json", async () => {
    const svg = await (await worker.fetch(get("/badge/repo/github.com/yannbellec/evoparam.svg"), env, ctx)).text();
    assert.match(svg, /scientific tool/);
    const card = await (await worker.fetch(get("/badge/repo/github.com/yannbellec/evoparam.svg?style=card"), env, ctx)).text();
    assert.match(card, /evoparam/);
    assert.match(card, /Apache-2\.0 · Python/);
    assert.match(card, /40 files/);
    assert.deepEqual(badgeMessage({ kind: "tool", languages: { Python: 3 } }, "language"), { text: "Python", tone: "info" });
    assert.deepEqual(badgeMessage({ kind: "tool" }, "doi"), { text: "scientific tool", tone: "info" });
  });

  it("revalidates, answers HEAD and OPTIONS, refuses a write, and still draws a malformed address", async () => {
    const first = await worker.fetch(get(`/badge/doi/${DOI}.svg`), env, ctx);
    const tag = first.headers.get("ETag")!;
    const again = await worker.fetch(get(`/badge/doi/${DOI}.svg`, { headers: { "If-None-Match": tag } }), env, ctx);
    assert.equal(again.status, 304);
    const head = await worker.fetch(get(`/badge/doi/${DOI}.svg`, { method: "HEAD" }), env, ctx);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await worker.fetch(get(`/badge/doi/${DOI}.svg`, { method: "OPTIONS" }), env, ctx)).status, 204);
    assert.equal((await worker.fetch(get(`/badge/doi/${DOI}.svg`, { method: "POST" }), env, ctx)).status, 405);
    const bad = await worker.fetch(get("/badge/doi/nonsense.svg"), env, ctx);
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /bad address/);
  });

  it("leaves every other path to the pages", async () => {
    const res = await worker.fetch(get("/badge/elsewhere/x"), env, ctx);
    assert.notEqual(res.headers.get("Content-Type"), "image/svg+xml; charset=utf-8");
  });
});

describe("the box on every paper's and tool's page", () => {
  it("gives the three snippets between their marks, and each GitHub README", async () => {
    const { badgeBox, BOX_MARKS } = await import("../src/lib/badge.ts");
    const box = badgeBox("https://example.org", { kind: "doi", doi: "10.1234/abc" }, "Registry", [
      { name: "owner/name", url: "https://github.com/Owner/Name.git", readme: "README.md" },
      { name: "elsewhere", url: "https://gitlab.com/a/b" },
    ]);
    assert.equal(box.image, "https://example.org/badge/doi/10.1234/abc.svg");
    assert.deepEqual(box.snippets.map((s) => s.format), ["markdown", "rst", "html"]);
    for (const s of box.snippets) {
      assert.ok(s.text.startsWith(BOX_MARKS[s.format].start) && s.text.endsWith(BOX_MARKS[s.format].end), s.format);
      assert.ok(s.text.includes(box.link));
    }
    assert.match(box.snippets[1].text, /^\.\. oscr-badge:start\n\n\.\. image:: /);
    assert.deepEqual(box.github, [{ name: "owner/name", readme: "README.md", url: "https://github.com/Owner/Name/blob/HEAD/README.md" }]);
  });
  it("is on a paper rendered on demand, named as the shell names the platform", async () => {
    const { paperView } = await import("../src/lib/render.ts");
    const p = {
      id: "doi:10.1234/abc", slug: "doi_10.1234_abc", doi: "10.1234/abc", title: "T", journal: { text: "J", href: "" }, published: "2020-01-01",
      type: "", license: "", status: "code_verified", notices: [], authors: [], institutions: [], categories: [],
      code: [{ repo: "github.com/o/n", name: "o/n", url: "https://github.com/o/n", license: "", state: "alive" }],
      files: 0, pairs: 0, map: "", datasets: [], data: [], tools: [], europepmc: "",
    };
    const html = paperView(p as never, "https://example.org", "Registry").html;
    assert.match(html, /id="badge"/);
    assert.match(html, /https:\/\/example\.org\/badge\/doi\/10\.1234\/abc\.svg/);
    assert.doesNotMatch(paperView(p as never).html, /id="badge"/);
  });
});

describe("the badge put in a README by the registry's editor", () => {
  it("goes under the title, replaces what is between its marks, and never twice", async () => {
    const { insertBadge, markedSnippet, readmeFormat, badgeEditUrl } = await import("../src/lib/badge.ts");
    const md = markedSnippet("markdown", "[![R](https://e.org/b.svg)](https://e.org/b)");
    const once = insertBadge("# Title\n\nText.\n", "markdown", md);
    assert.equal(once, `# Title\n\n${md}\n\nText.\n`);
    assert.equal(insertBadge(once, "markdown", md), once);
    const md2 = markedSnippet("markdown", "[![R](https://e.org/c.svg)](https://e.org/c)");
    assert.equal(insertBadge(once, "markdown", md2), `# Title\n\n${md2}\n\nText.\n`);
    assert.equal(insertBadge("---\nlicense: mit\n---\n# Card\nx\n", "markdown", md), `---\nlicense: mit\n---\n# Card\n\n${md}\n\nx\n`);
    const rst = markedSnippet("rst", ".. image:: https://e.org/b.svg");
    assert.equal(insertBadge("evoparam\n========\n\nText.\n", "rst", rst), `evoparam\n========\n\n${rst}\n\nText.\n`);
    assert.equal(insertBadge("", "markdown", md), `${md}\n`);
    assert.equal(readmeFormat("docs/README.rst"), "rst");
    assert.equal(readmeFormat("README"), "markdown");
    assert.equal(readmeFormat("README.adoc"), null);
    assert.equal(badgeEditUrl("o", "n", "main", "README.md", { kind: "doi", doi: "10.1/x" }), "/r/o/n/edit/main/README.md?badge=doi%3A10.1%2Fx");
    const { badgeSubject } = await import("../src/lib/badge.ts");
    assert.deepEqual(badgeSubject("doi:10.1234/X"), { kind: "doi", doi: "10.1234/x" });
    assert.deepEqual(badgeSubject("repo:github.com/O/N"), { kind: "repo", repo: "github.com/o/n" });
    assert.equal(badgeSubject("[![evil](https://bad.example/x.svg)](https://bad.example)"), null);
    assert.equal(badgeSubject(null), null);
  });
});

describe("a paper's page as schema.org data", () => {
  it("is the article and each repository citing it, with no way to close its script", async () => {
    const { paperJsonLd } = await import("../src/lib/badge.ts");
    const ld = paperJsonLd("https://example.org", { slug: "doi_10.1234_x", doi: "10.1234/x", title: "A </script> title", journal: "J", published: "2026-01-02",
      code: [{ url: "https://github.com/o/n", repo: "github.com/o/n" }, { url: "http://x@y.org", repo: "y.org" }] });
    assert.ok(!ld.includes("<"));
    const g = JSON.parse(ld)["@graph"];
    assert.equal(g[0]["@type"], "ScholarlyArticle");
    assert.equal(g[0]["@id"], "https://doi.org/10.1234/x");
    assert.equal(g[0].name, "A </script> title");
    assert.deepEqual(g.slice(1), [{ "@type": "SoftwareSourceCode", codeRepository: "https://github.com/o/n", name: "github.com/o/n", citation: { "@id": "https://doi.org/10.1234/x" } }]);
  });
});
