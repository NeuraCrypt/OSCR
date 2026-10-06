// One renderer for GitHub Flavored Markdown (night phase 02, E2): src/lib/markdown.ts. What a README
// or a Markdown file becomes: a view tree of allowed elements (GitHub's tag filter, less what runs),
// relative links and images at the page's ref, GitHub's addresses of a repository kept in the
// viewer, email addresses masked everywhere, math as MathML, and the rest of GFM (alerts,
// footnotes, tables, task lists, details). Also: the README a directory shows, the 500 KiB cut,
// and pathological texts rendered in bounded time.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cutForRendering,
  decodeEntities,
  fenceLanguage,
  isMarkdownPath,
  isReadmeName,
  joinPath,
  type MarkdownContext,
  orcidValid,
  outline,
  readmeOf,
  renderMarkdown,
  repoResolvers,
} from "../../src/lib/markdown.ts";
import { allowedAttr, type El, safeHref, TAGS, textOf, walk } from "../../src/lib/repo-view.ts";

const repo = { owner: "lab", name: "tool" };
const ctx = (dir = "", extra: Partial<MarkdownContext> = {}): MarkdownContext => ({
  ...repoResolvers({ repo, ref: "main", dir, isDir: (p) => p === "docs" || p === "src" }),
  ...extra,
});
const render = async (md: string, c: MarkdownContext = ctx()) => (await renderMarkdown(md, c)).el;
const all = (el: El, tag: string) => [...walk(el)].filter((e) => e.tag === tag);
const one = (el: El, tag: string) => {
  const found = all(el, tag);
  assert.ok(found.length, `no <${tag}>`);
  return found[0];
};

/** Every element and attribute of a tree is one a view may carry; no link runs anything. */
function assertSafe(el: El): void {
  for (const e of walk(el)) {
    assert.ok((TAGS as readonly string[]).includes(e.tag), `tag ${e.tag}`);
    for (const [k, v] of Object.entries(e.attrs)) {
      assert.ok(allowedAttr(k), `attribute ${k} on ${e.tag}`);
      assert.notEqual(k, "style");
      if (k === "href") assert.equal(safeHref(v), v, `href ${v}`);
      if (k === "id") assert.ok(v.startsWith("user-content-"), `id ${v}`);
      assert.ok(!/^on/i.test(k), `handler ${k}`);
    }
    assert.ok(!("data-tag" in e.attrs), "the parser's own mark is removed");
  }
}

describe("blocks and inlines", () => {
  test("headings: anchors, unique ids, the outline", async () => {
    const r = await renderMarkdown("# Install *it*\n\n## Usage\n\n## Usage\n\nSetext\n------\n", ctx());
    const [h1, h2a, h2b, h2c] = [...walk(r.el)].filter((e) => /^h\d$/.test(e.tag));
    assert.equal(h1.attrs.id, "user-content-install-it");
    assert.equal(h2a.attrs.id, "user-content-usage");
    assert.equal(h2b.attrs.id, "user-content-usage-1");
    assert.equal(h2c.attrs.id, "user-content-setext");
    assert.equal(one(h1, "a").attrs.href, "#user-content-install-it");
    assert.deepEqual(
      r.headings.map((x) => [x.level, x.text]),
      [[1, "Install it"], [2, "Usage"], [2, "Usage"], [2, "Setext"]],
    );
    const o = outline(r.headings)!;
    assert.equal(o.tag, "details");
    assert.deepEqual(all(o, "a").map((a) => a.attrs.href), r.headings.map((x) => `#${x.id}`));
    assert.equal(outline(r.headings.slice(0, 2)), null, "no outline for two headings");
  });

  test("emphasis, strong, strike, code, escapes, entities, intraword underscores", async () => {
    const el = await render("**b** _i_ ~~s~~ `a*b*` \\*not\\* snake_case_word &copy; &#x41; :tada:");
    assert.equal(textOf(one(el, "strong")), "b");
    assert.equal(textOf(one(el, "em")), "i");
    assert.equal(textOf(one(el, "del")), "s");
    assert.equal(textOf(one(el, "code")), "a*b*");
    assert.match(textOf(el), /\*not\* snake_case_word © A 🎉/);
    assert.equal(all(el, "em").length, 1);
  });

  test("hard breaks, lists, nested lists, task lists, ordered starts", async () => {
    const el = await render("a  \nb\n\n- one\n  - two\n- [x] done\n- [ ] todo\n\n3. three\n4. four\n");
    assert.equal(all(el, "br").length, 1);
    const boxes = all(el, "input");
    assert.deepEqual(boxes.map((b) => [b.attrs.type, b.attrs.disabled, b.attrs.checked ?? null]), [["checkbox", "disabled", "checked"], ["checkbox", "disabled", null]]);
    assert.equal(all(el, "ul").length, 2);
    assert.equal(one(el, "ol").attrs.start, "3");
  });

  test("tables keep their alignment as classes; an escaped pipe stays in its cell", async () => {
    const el = await render("| a | b | c |\n|:--|:-:|--:|\n| 1 | x \\| y | 3 |\n");
    assert.deepEqual(all(el, "th").map((t) => t.attrs.class), ["align-left", "align-center", "align-right"]);
    assert.deepEqual(all(el, "td").map(textOf), ["1", "x | y", "3"]);
    assert.equal(one(el, "table").attrs.class, "markdown");
  });

  test("alerts are said in words; quotes nest", async () => {
    const el = await render("> [!WARNING]\n> Mind the data.\n\n> a\n> > b\n");
    const alert = [...walk(el)].find((e) => e.attrs.class?.includes("markdown-alert-warning"))!;
    assert.equal(textOf(alert.children[0] as El), "Warning");
    assert.equal(all(el, "blockquote").length, 2);
  });

  test("footnotes: numbered in order of use, with a way back", async () => {
    const el = await render("One[^b] two[^a].\n\n[^a]: First.\n[^b]: Second.\n");
    const refs = all(el, "sup").map(textOf);
    assert.deepEqual(refs, ["1", "2"]);
    const section = one(el, "section");
    assert.equal(section.attrs.class, "footnotes");
    assert.deepEqual(all(section, "li").map((l) => l.attrs.id), ["user-content-fn-b", "user-content-fn-a"]);
    assert.match(textOf(section), /Second[\s\S]*First/);
    const firstNote = all(section, "li")[0];
    assert.equal(one(firstNote, "p").children.at(-1) && (one(firstNote, "p").children.at(-1) as El).attrs.class, "footnote-back", "the way back ends the paragraph");
  });

  test("fenced code is highlighted with highlight.js's classes; indented code is kept", async () => {
    const el = await render("```python\ndef f(x):\n    return x\n```\n\n    plain\n    code\n");
    const [a, b] = all(el, "pre");
    assert.equal(a.attrs.class, "code-block");
    assert.ok([...walk(a)].some((e) => e.attrs.class === "hljs-keyword" && textOf(e) === "def"));
    assert.equal(textOf(a), "def f(x):\n    return x");
    assert.equal(textOf(b), "plain\ncode");
    assert.equal(fenceLanguage("py"), "Python");
    assert.equal(fenceLanguage("r"), "R");
    assert.equal(fenceLanguage(""), null);
  });

  test("a Mermaid block is shown as its source, with a sentence and the source's link", async () => {
    const el = await render("```mermaid\ngraph TD; A-->B\n```\n", ctx("", { sourceUrl: "https://github.com/lab/tool/blob/abc/README.md" }));
    const fig = one(el, "figure");
    assert.equal(fig.attrs.class, "diagram-source");
    assert.match(textOf(one(fig, "figcaption")), /Mermaid diagram: the viewer shows its source .* At the source\./);
    assert.equal(textOf(one(fig, "code")), "graph TD; A-->B");
  });
});

describe("links and images", () => {
  test("relative links go to this viewer at the same ref; anchors to the document's headings", async () => {
    const el = await render("[a](../src) [b](src/x.py#L3-L5) [c](../up.md) [d](/README.md) [e](#Usage) [f](./)", ctx("docs"));
    const hrefs = all(el, "a").map((a) => a.attrs.href ?? null);
    assert.deepEqual(hrefs, ["/r/lab/tool/tree/main/src/", "/r/lab/tool/blob/main/docs/src/x.py#L3-L5", "/r/lab/tool/blob/main/up.md", "/r/lab/tool/blob/main/README.md", "#user-content-usage", "/r/lab/tool/tree/main/docs/"]);
    const out = await render("[x](../../etc/passwd)");
    assert.equal(all(out, "a").length, 0, "a path out of the repository stays text");
  });

  test("GitHub's addresses of a repository stay in the viewer; other sites keep their address", async () => {
    const el = await render(
      "[a](https://github.com/other/lib) [b](https://github.com/other/lib/blob/v1.0/src/a.c#L10) [c](https://github.com/other/lib/commit/0123456789abcdef0123456789abcdef01234567) [d](https://example.org/x)",
    );
    assert.deepEqual(all(el, "a").map((a) => a.attrs.href), [
      "/r/other/lib/",
      "/r/other/lib/blob/v1.0/src/a.c#L10",
      "/r/other/lib/commit/0123456789abcdef0123456789abcdef01234567/",
      "https://example.org/x",
    ]);
    assert.equal(all(el, "a")[3].attrs.rel, "nofollow ugc noopener");
  });

  test("javascript:, data: and mailto: links keep their text only", async () => {
    const el = await render('[a](javascript:alert(1)) [b](data:text/html,x) [c](mailto:joe@example.org) <a href="javascript:alert(1)">d</a> <a href="vbscript:x">e</a>');
    for (const a of all(el, "a")) assert.equal(a.attrs.href, undefined);
    assert.doesNotMatch(textOf(el), /@/);
  });

  test("images: the repository's own are read by the page; others are links; dark-only dropped", async () => {
    const r = await renderMarkdown(
      '![fig](figs/a.png) ![ext](https://cdn.example.org/b.png) ![dark](d.png#gh-dark-mode-only) ![light](l.png#gh-light-mode-only) <img src="./c.svg" width="120" onerror="x()"> ![raw](https://raw.githubusercontent.com/lab/tool/main/r.png) ![blob](https://github.com/lab/tool/blob/main/b.png?raw=true) ![other](https://raw.githubusercontent.com/else/where/main/o.png)',
      ctx("docs"),
    );
    const imgs = all(r.el, "img");
    assert.deepEqual(imgs.map((i) => i.attrs["data-src"]), ["docs/figs/a.png", "docs/l.png", "docs/c.svg", "r.png", "b.png"]);
    assert.deepEqual(r.images, ["docs/figs/a.png", "docs/l.png", "docs/c.svg", "r.png", "b.png"]);
    for (const i of imgs) assert.equal(i.attrs.src, undefined, "no source until the page reads the bytes");
    assert.equal(imgs[2].attrs.width, "120");
    assert.ok(!("onerror" in imgs[2].attrs));
    const ext = all(r.el, "a").filter((a) => a.attrs.class === "external-image");
    assert.deepEqual(ext.map((a) => [a.attrs.href, textOf(a)]), [
      ["https://cdn.example.org/b.png", "ext (an image at cdn.example.org)"],
      ["https://raw.githubusercontent.com/else/where/main/o.png", "other (an image at raw.githubusercontent.com)"],
    ]);
    assert.doesNotMatch(textOf(r.el), /dark/);
  });

  test("scholarly identifiers and commit ids become links; an ORCID iD must check", async () => {
    const el = await render("doi:10.1038/s41586-020-2649-2, arXiv:2101.00001, PMID: 12345, PMC1234567, RRID:SCR_002823, 0000-0002-1825-0097 and 0000-0002-1825-0098, 0123456789abcdef0123456789abcdef01234567.");
    const hrefs = all(el, "a").map((a) => a.attrs.href);
    assert.deepEqual(hrefs, [
      "https://doi.org/10.1038/s41586-020-2649-2",
      "https://arxiv.org/abs/2101.00001",
      "https://pubmed.ncbi.nlm.nih.gov/12345/",
      "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/",
      "https://scicrunch.org/resolver/RRID:SCR_002823",
      "https://orcid.org/0000-0002-1825-0097",
      "/r/lab/tool/commit/0123456789abcdef0123456789abcdef01234567/",
    ]);
    assert.ok(orcidValid("0000-0002-1825-0097"));
    assert.ok(!orcidValid("0000-0002-1825-0098"));
  });

  test("bare addresses are linked without their closing punctuation", async () => {
    const el = await render("See https://example.org/a_(b). Or www.example.org/c, then <https://example.org/d> (https://example.org/e).");
    assert.deepEqual(all(el, "a").map((a) => a.attrs.href), ["https://example.org/a_(b)", "https://www.example.org/c", "https://example.org/d", "https://example.org/e"]);
  });

  test("reference links and titles", async () => {
    const el = await render("[text][ref] and [ref]\n\n[ref]: https://example.org/r \"The title\"\n");
    const [a, b] = all(el, "a");
    assert.equal(a.attrs.href, "https://example.org/r");
    assert.equal(a.attrs.title, "The title");
    assert.equal(textOf(b), "ref");
  });
});

describe("GitHub's tag filter", () => {
  test("what runs or embeds is dropped with its content; styles and classes are the authors' own and dropped", async () => {
    const el = await render(
      '<script>alert(1)</script>\n\n<style>body{}</style>\n\n<iframe src="https://x.org"></iframe>\n\n<div style="color:red" class="big" id="top" onclick="x()">kept</div>\n\n<svg><script>1</script></svg> <object data="x"></object><form action="https://evil.example"><input name="q"></form>',
    );
    assertSafe(el);
    const text = textOf(el);
    assert.doesNotMatch(text, /alert|body\{|iframe/);
    const div = [...walk(el)].find((e) => e.tag === "div" && textOf(e).includes("kept") && e !== el)!;
    assert.deepEqual(div.attrs, {});
    assert.equal(all(el, "form").length, 0);
    assert.equal(all(el, "input").length, 0);
  });

  test("details and summary hold Markdown; alignment becomes a class; ids carry user-content-", async () => {
    const el = await render('<details open>\n<summary>More</summary>\n\nHidden **bold**\n\n</details>\n\n<p align="center">centred</p>\n\n<h2 id="x">T</h2>\n\n<a name="here"></a>');
    assertSafe(el);
    const d = one(el, "details");
    assert.equal(d.attrs.open, "open");
    assert.equal(textOf(one(d, "summary")), "More");
    assert.equal(textOf(one(d, "strong")), "bold");
    assert.ok([...walk(el)].some((e) => e.tag === "p" && e.attrs.class === "align-center"));
    assert.ok([...walk(el)].some((e) => e.tag === "h2" && e.attrs.id === "user-content-x"));
    assert.ok(all(el, "a").some((a) => a.attrs.id === "user-content-here"));
  });

  test("inline tags GitHub keeps: kbd, sub, sup, ins; <picture> shows its default (light) image", async () => {
    const el = await render('<kbd>Ctrl</kbd> H<sub>2</sub>O x<sup>2</sup> <ins>new</ins>\n\n<picture>\n<source media="(prefers-color-scheme: dark)" srcset="dark.png">\n<img alt="Logo" src="light.png">\n</picture>');
    for (const t of ["kbd", "sub", "sup", "ins"]) assert.equal(all(el, t).length, 1, t);
    assert.deepEqual(all(el, "img").map((i) => i.attrs["data-src"]), ["light.png"]);
  });

  test("email addresses are masked in text, code, links and alternative texts", async () => {
    const el = await render("Write to joe@example.org or <ann@example.org>.\n\n`bob@example.org`\n\n```\nmail = 'eve@example.org'\n```\n\n![sam@example.org](a.png) [ted@example.org](https://example.org)");
    const everything = JSON.stringify(el);
    assert.doesNotMatch(everything, /@example/);
    assert.match(textOf(el), /\[email hidden\]/);
  });

  test("email addresses are masked in titles and alternative texts too", async () => {
    const el = await render('[a][r] <abbr title="ann@example.org">x</abbr> <img src="a.png" alt="bob@example.org">\n\n[r]: https://example.org "joe@example.org"\n');
    assert.doesNotMatch(JSON.stringify(el), /@example/);
  });

  test("HTML comments are hidden", async () => {
    const el = await render("a <!-- secret --> b\n\n<!--\nblock secret\n-->\n\nc");
    assert.doesNotMatch(textOf(el), /secret/);
  });

  test("entities are decoded, invalid code points replaced", () => {
    assert.equal(decodeEntities("&lt;&amp;&#65;&#x42;&#0;&#xD800;&nope;"), "<&AB��&nope;");
  });
});

describe("math", () => {
  test("inline and display math become MathML; prices stay text", async () => {
    const el = await render("Energy $E = mc^2$ and $`\\alpha`$; it costs $5 and $10.\n\n$$\n\\frac{a}{b}\n$$\n\n```math\n\\sqrt{x}\n```\n");
    const maths = all(el, "math");
    assert.equal(maths.length, 4);
    assert.deepEqual(maths.map((m) => m.attrs.display ?? "inline"), ["inline", "inline", "block", "block"]);
    assert.match(textOf(el), /it costs \$5 and \$10\./);
    assert.equal(textOf(one(maths[0], "annotation")), "E = mc^2");
  });

  test("macros defined in one formula serve the next", async () => {
    const el = await render("$\\newcommand{\\R}{\\mathbb{R}}$ and $x \\in \\R$");
    const second = all(el, "math")[1];
    assert.ok([...walk(second)].some((e) => e.attrs.mathvariant === "double-struck"));
  });
});

describe("READMEs", () => {
  const entries = (paths: string[]) => paths.map((path) => ({ path, type: "blob" }));

  test("names and Markdown paths", () => {
    for (const n of ["README", "README.md", "readme.rst", "Readme.txt"]) assert.ok(isReadmeName(n), n);
    for (const n of ["README-dev.md", "READMEs", "notes.md"]) assert.ok(!isReadmeName(n), n);
    assert.ok(isMarkdownPath("a/b.markdown"));
    assert.ok(!isMarkdownPath("a/b.rst"));
  });

  test("the home: .github/, then the root, then docs/", () => {
    assert.equal(readmeOf(entries(["README.md", ".github/README.md", "docs/README.md"]), ""), ".github/README.md");
    assert.equal(readmeOf(entries(["README.md", "docs/README.md"]), ""), "README.md");
    assert.equal(readmeOf(entries(["docs/README.md", "src/README.md"]), ""), "docs/README.md");
    assert.equal(readmeOf(entries(["src/a.py"]), ""), null);
  });

  test("a directory: its own README only, Markdown first", () => {
    assert.equal(readmeOf(entries(["src/README.rst", "src/README.md", "src/deep/README.md"]), "src"), "src/README.md");
    assert.equal(readmeOf(entries(["src/README.txt"]), "src"), "src/README.txt");
    assert.equal(readmeOf(entries(["README.md"]), "src"), null);
  });

  test("the 500 KiB cut: at a line's end, said", () => {
    const text = "line é\n".repeat(100_000);
    const r = cutForRendering(text, 500 * 1024);
    assert.ok(r.cut);
    assert.ok(new TextEncoder().encode(r.text).length <= 500 * 1024);
    assert.ok(r.text.endsWith("line é"));
    assert.deepEqual(cutForRendering("short", 10), { text: "short", cut: false });
  });

  test("paths relative to a document", () => {
    assert.equal(joinPath("docs", "../a/./b.md"), "a/b.md");
    assert.equal(joinPath("docs", "/x.md"), "x.md");
    assert.equal(joinPath("docs", "/"), "");
    assert.equal(joinPath("", "../x"), null);
    assert.equal(joinPath("docs", "./"), "docs");
  });
});

describe("safety and bounded time", () => {
  test("a hostile document yields only allowed elements and attributes", async () => {
    const el = await render(
      '# <img src=x onerror=alert(1)>\n\n[x](javascript:alert(1) "t")\n\n<a href="https://ok.example" target="_blank" rel="opener">ok</a>\n\n<table><tr><td style="x" colspan="2" rowspan="999999">c</td></tr></table>\n\n<math><mi>x</mi></math> <textarea>t</textarea> <button>b</button> <select><option>o</option></select>\n\n<meta http-equiv="refresh" content="0;url=https://evil.example">\n\n<base href="https://evil.example/">',
    );
    assertSafe(el);
    assert.doesNotMatch(JSON.stringify(el), /evil|onerror|target|"opener"/);
    assert.ok(!all(el, "p").some((p) => !textOf(p).trim() && !p.children.some((c) => typeof c !== "string")), "no empty paragraph");
  });

  test("pathological texts render in bounded time", async () => {
    const cases = [
      "*a ".repeat(20000),
      "_a_ b__".repeat(10000),
      "[".repeat(20000) + "x",
      ">".repeat(2000) + " x",
      Array.from({ length: 300 }, (_, i) => `${" ".repeat(i * 2)}- x`).join("\n"),
      "$a ".repeat(20000),
      "<b>".repeat(5000) + "x" + "</b>".repeat(5000),
      "https://x.org/a ".repeat(10000),
      "\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\a\\a}$\\a$",
    ];
    for (const md of cases) {
      const t = performance.now();
      await renderMarkdown(md);
      assert.ok(performance.now() - t < 3000, `${md.slice(0, 20)}… took too long`);
    }
  });
});
