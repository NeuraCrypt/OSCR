// TeX to MathML (night phase 02, E2): src/lib/mathml.ts. The math researchers write in READMEs and
// notebooks, drawn by the browser itself: fractions, roots, scripts and limits, Greek letters,
// operators, fences, fonts, accents, matrices and cases, macros kept across formulas; a command it
// does not know is shown as its source, never guessed; the source is always kept as an annotation;
// no attribute a view may not carry, and a recursive macro stops.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Macros, texToMathml, tokenize } from "../../src/lib/mathml.ts";
import { allowedAttr, type El, MATH_TAGS, textOf, walk } from "../../src/lib/repo-view.ts";

const math = (tex: string, display = false, macros?: Macros) => texToMathml(tex, display, macros);
const tags = (el: El): string[] => [...walk(el)].map((e) => e.tag);
const find = (el: El, tag: string) => [...walk(el)].find((e) => e.tag === tag);
/** The formula's body, without <math>, <semantics> and the annotation. */
const body = (el: El): El => ((el.children[0] as El).children[0] as El);

describe("texToMathml", () => {
  test("a formula keeps its source as an annotation; only MathML elements and allowed attributes", () => {
    const { el, unknown } = math("\\frac{a}{b} + \\sqrt[3]{x^2} - \\sum_{i=1}^{n} x_i", true);
    assert.equal(el.tag, "math");
    assert.equal(el.attrs.display, "block");
    assert.equal(unknown, 0);
    const annotation = find(el, "annotation")!;
    assert.equal(annotation.attrs.encoding, "application/x-tex");
    assert.equal(textOf(annotation), "\\frac{a}{b} + \\sqrt[3]{x^2} - \\sum_{i=1}^{n} x_i");
    for (const e of walk(el)) {
      assert.ok((MATH_TAGS as readonly string[]).includes(e.tag), e.tag);
      for (const k of Object.keys(e.attrs)) assert.ok(allowedAttr(k), `${k} on ${e.tag}`);
      assert.ok(!("data-limits" in e.attrs));
    }
    for (const t of ["mfrac", "mroot", "msup", "munderover"]) assert.ok(tags(el).includes(t), t);
  });

  test("limits: under and over in display math, scripts inline; integrals keep scripts", () => {
    assert.ok(tags(math("\\sum_{i}^{n}", true).el).includes("munderover"));
    assert.ok(tags(math("\\sum_{i}^{n}", false).el).includes("msubsup"));
    assert.ok(tags(math("\\int_0^1", true).el).includes("msubsup"));
    assert.ok(tags(math("\\lim_{x \\to 0}", true).el).includes("munder"));
  });

  test("letters, numbers, operators, Greek, functions", () => {
    const b = body(math("2.5x \\cdot \\alpha \\leq \\Omega \\sin y").el);
    const kids = b.children as El[];
    assert.deepEqual(
      kids.map((k) => [k.tag, textOf(k)]),
      [["mn", "2.5"], ["mi", "x"], ["mo", "⋅"], ["mi", "α"], ["mo", "≤"], ["mi", "Ω"], ["mi", "sin"], ["mi", "y"]],
    );
    assert.equal(kids[5].attrs.mathvariant, "normal");
    assert.equal(textOf(body(math("a - b").el).children[1] as El), "−", "a minus sign, not a hyphen");
  });

  test("primes, fences, text, operator names, fonts, accents, spaces", () => {
    const e = math("f''(x) \\left( \\frac{1}{2} \\right] \\text{if } \\operatorname{Var} \\mathbf{v} \\mathbb{R} \\hat{\\theta} \\quad \\overline{AB}").el;
    assert.equal(textOf(find(e, "msup")!.children[1] as El), "′′");
    const fences = [...walk(e)].filter((x) => x.attrs.fence === "true").map(textOf);
    assert.deepEqual(fences, ["(", "]"]);
    const plain = [...walk(e)].filter((x) => x.tag === "mo" && textOf(x) === "(" && !x.attrs.fence);
    assert.deepEqual(plain.map((x) => x.attrs.stretchy), ["false"], "a bracket written as such keeps its size");
    assert.equal(textOf(find(e, "mtext")!), "if ");
    assert.ok([...walk(e)].some((x) => x.tag === "mo" && textOf(x) === "Var"));
    assert.ok([...walk(e)].some((x) => x.attrs.mathvariant === "bold" && textOf(x) === "v"));
    assert.ok([...walk(e)].some((x) => x.attrs.mathvariant === "double-struck" && textOf(x) === "R"));
    assert.ok([...walk(e)].some((x) => x.tag === "mover" && x.attrs.accent === "true"));
    assert.ok([...walk(e)].some((x) => x.tag === "mspace" && x.attrs.width === "1em"));
  });

  test("matrices and cases", () => {
    const m = math("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", true).el;
    const table = find(m, "mtable")!;
    assert.equal(table.children.length, 2);
    assert.deepEqual((table.children as El[]).map((r) => (r.children as El[]).map(textOf)), [["a", "b"], ["c", "d"]]);
    assert.deepEqual([...walk(m)].filter((x) => x.attrs.fence).map(textOf), ["(", ")"]);
    const c = math("f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}", true).el;
    assert.equal(find(c, "mtable")!.attrs.columnalign, "left left");
    const a = math("\\begin{aligned} a &= b \\\\ c &= d \\\\ \\end{aligned}", true).el;
    assert.equal(find(a, "mtable")!.children.length, 2, "a trailing \\\\ adds no empty row");
  });

  test("macros: \\newcommand with arguments, \\def, kept for the document's next formulas", () => {
    const macros: Macros = new Map();
    math("\\newcommand{\\norm}[1]{\\left\\| #1 \\right\\|} \\def\\E{\\mathbb{E}}", false, macros);
    const e = math("\\norm{x} + \\E", false, macros).el;
    assert.equal(textOf(body(e)), "‖x‖+E");
    assert.ok([...walk(e)].some((x) => x.attrs.mathvariant === "double-struck"));
    assert.equal(math("\\norm{x}").unknown, 1, "another document does not know them");
  });

  test("a recursive or exploding macro stops", () => {
    const t = performance.now();
    const r = math("\\newcommand{\\a}{\\a\\a}\\a");
    assert.ok(r.unknown >= 1);
    const r2 = math("\\def\\a{\\b\\b\\b\\b}\\def\\b{\\c\\c\\c\\c}\\def\\c{\\d\\d\\d\\d}\\def\\d{\\e\\e\\e\\e}\\def\\e{xxxxxxxx}\\a\\a\\a\\a");
    assert.ok(r2.unknown >= 1);
    assert.ok(performance.now() - t < 2000);
  });

  test("an unknown command is shown as its source, never guessed; colours are dropped", () => {
    const r = math("\\foo{x} + \\color{red} y + \\textcolor{blue}{z} \\begin{tikzcd}\\end{tikzcd}");
    const unknown = [...walk(r.el)].filter((x) => x.attrs.class === "math-unknown").map(textOf);
    assert.deepEqual(unknown, ["\\foo", "\\begin{tikzcd}"]);
    assert.equal(r.unknown, 2);
    assert.doesNotMatch(JSON.stringify(r.el.children[0]).replace(/"annotation"[\s\S]*$/, ""), /red|blue/);
  });

  test("the tokenizer: commands, groups, scripts, comments, rows", () => {
    assert.deepEqual(
      tokenize("\\alpha_{1}^2 % note\n\\\\ #1 &").map((t) => t.t),
      ["cmd", "sub", "open", "char", "close", "sup", "char", "space", "row", "space", "arg", "space", "amp"],
    );
  });

  test("broken TeX never throws: unbalanced groups and stray scripts", () => {
    for (const tex of ["{{{x", "}}}", "^", "_{", "\\frac{a}", "\\sqrt[", "\\left(", "\\begin{matrix} a &", "x^^y", "\\\\\\\\"]) {
      const r = math(tex, true);
      assert.equal(r.el.tag, "math", tex);
      assert.equal(textOf(find(r.el, "annotation")!), tex);
    }
  });
});
