// The code views' highlighting (night phase 02, E1): src/lib/highlight.ts. Language detection with
// Linguist's names (override, modelines, file names, extensions, shebangs), highlight.js's
// class-based output read into view trees by a strict parser (no HTML string reaches the page; the
// lines stay the file's own), and EditorConfig's tab width.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  detectLanguage,
  editorConfigGlob,
  editorConfigTabWidth,
  highlightText,
  hljsName,
  LANGUAGES,
  type LineNodes,
  modeline,
  parseHljs,
  plainLines,
  tabClass,
} from "../../src/lib/highlight.ts";
import { type El, textOf, walk } from "../../src/lib/repo-view.ts";

const lineText = (l: LineNodes) => l.map((n) => textOf(n)).join("");
/** The classes of the spans around a piece of text in a line (innermost last). */
function classesAround(line: LineNodes, text: string): string[] {
  const out: string[] = [];
  const visit = (nodes: LineNodes, stack: string[]): boolean => {
    for (const n of nodes) {
      if (typeof n === "string") {
        if (n.includes(text)) {
          out.push(...stack);
          return true;
        }
      } else if (visit(n.children, [...stack, n.attrs.class ?? ""])) return true;
    }
    return false;
  };
  visit(line, []);
  return out;
}

describe("language detection", () => {
  test("extensions and file names give Linguist's names", () => {
    const cases: [string, string | null][] = [
      ["analysis/preprocess.py", "Python"],
      ["R/model.R", "R"],
      ["src/solver.jl", "Julia"],
      ["fit.m", "MATLAB"],
      ["kernel.cu", "CUDA"],
      ["model.f90", "Fortran"],
      ["old.F", "Fortran"],
      ["Makefile", "Makefile"],
      ["docker/Dockerfile", "Dockerfile"],
      ["Dockerfile.gpu", "Dockerfile"],
      ["CMakeLists.txt", "CMake"],
      ["Snakefile", "Snakemake"],
      ["main.nf", "Nextflow"],
      ["CITATION.cff", "YAML"],
      [".gitignore", "Ignore List"],
      ["data/table.csv", "CSV"],
      ["notebooks/fig1.ipynb", "Jupyter Notebook"],
      ["README.md", "Markdown"],
      ["report.Rmd", "Markdown"],
      ["paper.tex", "TeX"],
      ["refs.bib", "BibTeX"],
      ["model.stan", "Stan"],
      ["sim.v", "Verilog"],
      ["LICENSE", "Text"],
      ["mystery.xyz", null],
      ["noextension", null],
    ];
    for (const [path, lang] of cases) assert.equal(detectLanguage(path), lang, path);
  });

  test("a shebang names a script without an extension", () => {
    assert.equal(detectLanguage("bin/run", "#!/usr/bin/env python3\nprint(1)\n"), "Python");
    assert.equal(detectLanguage("bin/run", "#!/bin/bash\necho hi\n"), "Shell");
    assert.equal(detectLanguage("bin/run", "#!/usr/bin/env Rscript\n"), "R");
    assert.equal(detectLanguage("bin/run", "no shebang"), null);
  });

  test("Vim and Emacs modelines win over the extension; .gitattributes wins over all", () => {
    assert.equal(modeline("x = 1\n# vim: set ft=python :\n"), "Python");
    assert.equal(modeline("# -*- mode: julia -*-\n"), "Julia");
    assert.equal(modeline("# -*- ruby -*-\n"), "Ruby");
    assert.equal(detectLanguage("script.txt", "% -*- mode: matlab -*-\nx = 1;\n"), "MATLAB");
    assert.equal(detectLanguage("script.txt", "", "Python"), "Python");
    assert.equal(detectLanguage("script.py", "", "C++"), "C++");
    // An override the viewer does not know is ignored.
    assert.equal(detectLanguage("script.py", "", "Klingon"), "Python");
  });

  test("Linguist's names map to highlight.js's", () => {
    assert.equal(hljsName("Python"), "python");
    assert.equal(hljsName("C++"), "cpp");
    assert.equal(hljsName("Shell"), "bash");
    assert.equal(hljsName("TOML"), "ini");
    assert.equal(hljsName("Text"), null);
    assert.equal(hljsName(null), null);
    assert.ok(LANGUAGES.length > 60);
  });
});

describe("highlight.js's output, read strictly", () => {
  test("spans, escaped text, and spans cut at each end of line then reopened", () => {
    const lines = parseHljs('<span class="hljs-comment">/* a\nb */</span> x &lt; y &amp;&amp; &quot;z&quot; &#x27;q&#x27;\n<span class="hljs-string">&quot;s&quot;</span>');
    assert.equal(lines.length, 3);
    assert.equal(lineText(lines[0]), "/* a");
    assert.equal(lineText(lines[1]), `b */ x < y && "z" 'q'`);
    assert.deepEqual(classesAround(lines[1], "b */"), ["hljs-comment"], "the comment's span reopened on its second line");
    assert.deepEqual(classesAround(lines[2], '"s"'), ["hljs-string"]);
    const nested = parseHljs('<span class="hljs-function"><span class="hljs-keyword">def</span>\n<span class="hljs-title function_">f</span></span>');
    assert.deepEqual(classesAround(nested[0], "def"), ["hljs-function", "hljs-keyword"]);
    assert.deepEqual(classesAround(nested[1], "f"), ["hljs-function", "hljs-title function_"]);
  });

  test("anything but highlight.js's spans and entities is refused", () => {
    for (const bad of [
      '<img src=x onerror="alert(1)">',
      '<span class="x" onclick="y">a</span>',
      '<span class="a">b</span></span>',
      "<b>bold</b>",
      "a &nbsp; b",
      '<span class="a;b">c</span>',
      '<span class="hljs-string" style="color:red">c</span>',
    ]) {
      assert.throws(() => parseHljs(bad), bad);
    }
  });

  test("Python: keywords, strings, comments, numbers, decorators; a docstring over lines", async () => {
    const src = [
      "@dataclass",
      "def band_power(x, fs=256):  # Welch's method",
      '    """The power in a band.',
      "    Still the docstring. # not a comment",
      '    """',
      "    return x * 1.5e3",
    ];
    const lines = await highlightText(src, "Python");
    assert.equal(lines.length, src.length);
    assert.deepEqual(lines.map(lineText), src);
    assert.ok(classesAround(lines[0], "@dataclass").some((c) => c.includes("hljs-meta")));
    assert.ok(classesAround(lines[1], "def").includes("hljs-keyword"));
    assert.ok(classesAround(lines[1], "Welch").includes("hljs-comment"));
    assert.ok(classesAround(lines[1], "256").includes("hljs-number"));
    assert.ok(classesAround(lines[3], "Still the docstring").includes("hljs-string"), "inside the docstring, # is text of the string");
    assert.ok(classesAround(lines[5], "return").includes("hljs-keyword"));
  });

  test("every language keeps every character and every line", async () => {
    const sample = [
      "# comment // other /* block */ -- sql % tex ; ini",
      "x = \"a string with \\\"escape\\\"\" + 'single' + `tick` 0x1F 3.14e-2",
      "def f(a, b): return a @ b  # trailing",
      "\t indented\ttabs and unicode: é ü 漢字",
      "unterminated \"string",
      "",
      "<tag attr=\"v\"> $var ${braced} @decorator \\command{x} <script>alert(1)</script>",
    ];
    for (const lang of LANGUAGES) {
      const out = await highlightText(sample, lang);
      assert.equal(out.length, sample.length, lang);
      assert.deepEqual(out.map(lineText), sample, lang);
      for (const line of out) {
        for (const n of line) {
          if (typeof n === "string") continue;
          for (const el of walk(n)) {
            assert.equal(el.tag, "span", lang);
            assert.deepEqual(Object.keys(el.attrs), ["class"], lang);
            assert.match(el.attrs.class, /^(hljs-|language-)[A-Za-z0-9_ -]+$/, lang);
          }
        }
      }
    }
    assert.deepEqual((await highlightText(sample, null)).map(lineText), sample);
    assert.deepEqual((await highlightText(sample, "Text")).map(lineText), sample);
  });

  test("plain lines: one text node per line, none for an empty line", () => {
    assert.deepEqual(plainLines(["a", "", "b"]), [["a"], [], ["b"]]);
  });

  test("a line of highlighted code is spans of classes only (no attribute but class)", async () => {
    const [line] = await highlightText(['print("<b onmouseover=x>")'], "Python");
    for (const n of line) if (typeof n !== "string") for (const el of walk(n as El)) assert.deepEqual(Object.keys(el.attrs), ["class"]);
    assert.equal(lineText(line), 'print("<b onmouseover=x>")');
  });
});

describe("EditorConfig", () => {
  const config = [
    "root = true",
    "[*]",
    "indent_size = 4",
    "[*.{js,ts}]",
    "indent_size = 2",
    "[Makefile]",
    "indent_style = tab",
    "tab_width = 8",
    "[lib/**.py]",
    "indent_size = 3",
    "[*.go]",
    "indent_size = tab",
  ].join("\n");

  test("the last matching section wins; tab_width wins over indent_size", () => {
    assert.equal(editorConfigTabWidth(config, "a.py"), 4);
    assert.equal(editorConfigTabWidth(config, "src/app.ts"), 2);
    assert.equal(editorConfigTabWidth(config, "Makefile"), 8);
    assert.equal(editorConfigTabWidth(config, "sub/Makefile"), 8);
    assert.equal(editorConfigTabWidth(config, "lib/deep/x.py"), 3);
    assert.equal(editorConfigTabWidth(config, "main.go"), 4, "a width that is not a number is ignored");
    assert.equal(editorConfigTabWidth("", "a.py"), null);
  });

  test("globs", () => {
    assert.equal(editorConfigGlob("*.py").test("a/b/c.py"), true);
    assert.equal(editorConfigGlob("/top.py").test("a/top.py"), false);
    assert.equal(editorConfigGlob("/top.py").test("top.py"), true);
    assert.equal(editorConfigGlob("src/*.c").test("src/a.c"), true);
    assert.equal(editorConfigGlob("src/*.c").test("src/x/a.c"), false);
    assert.equal(editorConfigGlob("[ab].txt").test("a.txt"), true);
    assert.equal(editorConfigGlob("{x,y}.md").test("y.md"), true);
    assert.equal(tabClass(2), "tab-2");
    assert.equal(tabClass(4), "tab-4");
    assert.equal(tabClass(8), "tab-8");
    assert.equal(tabClass(null), "");
  });
});
