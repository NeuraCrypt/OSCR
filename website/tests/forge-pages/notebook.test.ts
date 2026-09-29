// Jupyter notebooks in the registry's viewer (night phase 02, E5): src/lib/notebook.ts. Cells as
// saved: Markdown through the one renderer (math, attachments), code highlighted in the kernel's
// language, outputs in their richest safe form (images as data: addresses, Markdown and LaTeX
// rendered, text, streams, errors without terminal codes); HTML, JavaScript and widgets never run;
// email addresses masked; nbformat 3 read too; a file that is not a notebook gives null.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { imageSrc, joinSource, notebookLanguage, renderNotebook, stripAnsi } from "../../src/lib/notebook.ts";
import { allowedAttr, type El, safeSrc, TAGS, textOf, walk } from "../../src/lib/repo-view.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const nb = (cells: unknown[], metadata: unknown = { kernelspec: { name: "python3", language: "python" } }) => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata, cells });
const all = (el: El, tag: string) => [...walk(el)].filter((e) => e.tag === tag);

describe("renderNotebook", () => {
  test("markdown, code and outputs, as saved", async () => {
    const r = (await renderNotebook(
      nb([
        { cell_type: "markdown", source: ["# Figure 1\n", "The $\\alpha$ band."] },
        { cell_type: "code", execution_count: 1, source: ["def f(x):\n", "    return x"], outputs: [{ output_type: "stream", name: "stdout", text: ["0.412\n"] }] },
        { cell_type: "code", execution_count: 2, source: "f(1)", outputs: [{ output_type: "execute_result", execution_count: 2, data: { "text/plain": ["1"] } }] },
        { cell_type: "raw", source: "raw text" },
      ]),
    ))!;
    assert.equal(r.cells, 4);
    assert.equal(r.language, "Python");
    const text = textOf(r.el);
    assert.match(text, /Figure 1/);
    assert.match(text, /In \[1\]:def f\(x\):\n {4}return x/);
    assert.match(text, /0\.412/);
    assert.match(text, /Out \[2\]:1/);
    assert.match(text, /raw text/);
    assert.equal(all(r.el, "math").length, 1);
    assert.ok([...walk(r.el)].some((e) => e.attrs.class === "hljs-keyword" && textOf(e) === "def"));
  });

  test("images as data: addresses; SVG as an image; attachments in Markdown cells", async () => {
    const r = (await renderNotebook(
      nb([
        { cell_type: "code", source: "plot()", outputs: [{ output_type: "display_data", data: { "image/png": [PNG.slice(0, 20), "\n", PNG.slice(20)], "text/plain": ["<Figure>"] } }] },
        { cell_type: "code", source: "svg()", outputs: [{ output_type: "display_data", data: { "image/svg+xml": ["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"] } }] },
        { cell_type: "markdown", source: "![fig](attachment:a.png) ![gone](attachment:b.png)", attachments: { "a.png": { "image/png": PNG } } },
      ]),
    ))!;
    const imgs = all(r.el, "img");
    assert.equal(imgs.length, 3);
    assert.equal(imgs[0].attrs.src, `data:image/png;base64,${PNG}`);
    assert.equal(imgs[0].attrs.alt, "<Figure>");
    assert.match(imgs[1].attrs.src, /^data:image\/svg\+xml;base64,/);
    assert.equal(imgs[2].attrs.src, `data:image/png;base64,${PNG}`);
    assert.match(textOf(r.el), /gone/);
    for (const i of imgs) assert.equal(safeSrc(i.attrs.src), i.attrs.src);
  });

  test("HTML, JavaScript and widgets never run: their text form, or a sentence", async () => {
    const r = (await renderNotebook(
      nb([
        {
          cell_type: "code",
          source: "df",
          outputs: [
            { output_type: "execute_result", data: { "text/html": ["<script>alert(1)</script><table><tr><td>1</td></tr></table>"], "text/plain": ["   a\n0  1"] } },
            { output_type: "display_data", data: { "application/javascript": ["alert(1)"] } },
            { output_type: "display_data", data: { "application/vnd.jupyter.widget-view+json": { model_id: "x" } } },
          ],
        },
      ]),
    ))!;
    const json = JSON.stringify(r.el);
    assert.doesNotMatch(json, /alert|<script|<table/);
    const text = textOf(r.el);
    assert.match(text, / {3}a\n0 {2}1/);
    assert.match(text, /Its HTML or interactive form is not run here/);
    assert.match(text, /never runs a notebook's HTML or JavaScript/);
    for (const e of walk(r.el)) {
      assert.ok((TAGS as readonly string[]).includes(e.tag), e.tag);
      for (const k of Object.keys(e.attrs)) assert.ok(allowedAttr(k), k);
    }
  });

  test("Markdown and LaTeX outputs are rendered", async () => {
    const r = (await renderNotebook(
      nb([{ cell_type: "code", source: "x", outputs: [{ output_type: "display_data", data: { "text/markdown": ["**bold**"] } }, { output_type: "display_data", data: { "text/latex": ["$$\\frac{1}{2}$$"] } }] }]),
    ))!;
    assert.equal(all(r.el, "strong").length, 1);
    assert.equal(all(r.el, "mfrac").length, 1);
  });

  test("errors keep their traceback without terminal codes; stderr is marked; email addresses masked", async () => {
    const r = (await renderNotebook(
      nb([
        {
          cell_type: "code",
          source: "1/0 # ask ada@example.org",
          outputs: [
            { output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"] },
            { output_type: "stream", name: "stderr", text: "warning from bob@example.org\n" },
          ],
        },
      ]),
    ))!;
    const text = textOf(r.el);
    assert.match(text, /ZeroDivisionError: division by zero/);
    assert.doesNotMatch(text, /\u001b|@example/);
    assert.ok([...walk(r.el)].some((e) => e.attrs.class === "nb-output nb-error"));
    assert.ok([...walk(r.el)].some((e) => e.attrs.class === "nb-output nb-stream nb-stderr"));
  });

  test("nbformat 3's worksheets", async () => {
    const v3 = JSON.stringify({
      nbformat: 3,
      metadata: { language: "python" },
      worksheets: [{ cells: [{ cell_type: "heading", level: 2, source: "Old" }, { cell_type: "code", input: ["print(1)"], prompt_number: 4, outputs: [{ output_type: "pyout", prompt_number: 4, text: ["1"] }] }] }],
    });
    const r = (await renderNotebook(v3))!;
    assert.equal(r.cells, 2);
    assert.equal(all(r.el, "h2").length, 1);
    assert.match(textOf(r.el), /In \[4\]:print\(1\)[\s\S]*Out \[4\]:1/);
  });

  test("not a notebook: null", async () => {
    assert.equal(await renderNotebook("{not json"), null);
    assert.equal(await renderNotebook("[1,2]"), null);
    assert.equal(await renderNotebook('{"a": 1}'), null);
  });

  test("helpers", () => {
    assert.equal(joinSource(["a", "b\n", 3, "c"]), "ab\nc");
    assert.equal(stripAnsi("\u001b[1;32mok\u001b[0m\u001b]0;title\u0007 done\rnext"), "ok done\nnext");
    assert.equal(imageSrc({ "image/png": "not base64!" }), null);
    assert.equal(notebookLanguage({ metadata: { kernelspec: { name: "ir", language: "R" } } }), "R");
    assert.equal(notebookLanguage({ metadata: { language_info: { name: "julia" } } }), "Julia");
    assert.equal(notebookLanguage({}), null);
  });
});
