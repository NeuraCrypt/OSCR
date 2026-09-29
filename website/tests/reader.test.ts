// The Code ↔ Paper reader's logic (src/lib/code.ts, tree.ts, prefs.ts, reader.ts, lines.ts): the
// language of a file, a notebook's and an R Markdown file's segments, the highlighter's lines, the
// links to lines (#L10-L20), the list of files, the choices kept in the browser, the pairs
// joined to their files, and the paper's request to Europe PMC (a time limit, one more try).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hljs from "highlight.js/lib/core";
import {
  anchorText, clampRange, escapeHtml, LANGUAGE_IDS, languageOf, lineAnchor, planOf, sizeInWords, sniffLanguage, splitHighlighted,
  unComment,
} from "../src/lib/code.ts";
import { EMBEDS, LOADERS } from "../src/lib/hljs-languages.ts";
import { decorate, lineClass, pairClass, sourceLines, splitLines, wholeFile } from "../src/lib/lines.ts";
import { PREFS, readPref, writePref, type Store } from "../src/lib/prefs.ts";
import { placePairs } from "../src/lib/anchor.ts";
import { HttpError, TimeoutError, withRetry, worthRetrying } from "../src/lib/retry.ts";
import {
  encodePath, fileHref, fromSource, initialFile, mapPairs, readerFiles, sourceOf, sourceWhy, whyNotShown, type LotFileIn, type PairIn, type RepoIn,
} from "../src/lib/reader.ts";
import { ancestors, buildTree } from "../src/lib/tree.ts";

describe("the language of a file", () => {
  it("is read from its extension, its name, then the harvester's label", () => {
    const id = (path: string, label = "") => languageOf(path, label).id;
    assert.equal(id("analysis/run.py"), "python");
    assert.equal(id("Figure4/jds_detect.m", "MATLAB"), "matlab");
    assert.equal(id("stats.R"), "r");
    assert.equal(id("model.jl"), "julia");
    assert.equal(id("src/kernel.c"), "c");
    assert.equal(id("include/net.h", "C/C++"), "cpp");
    assert.equal(id("gpu/step.cu"), "cpp");
    assert.equal(id("Main.java"), "java");
    assert.equal(id("app.js"), "javascript");
    assert.equal(id("app.tsx"), "typescript");
    assert.equal(id("run.sh"), "bash");
    assert.equal(id("query.sql"), "sql");
    assert.equal(id("env.yml"), "yaml");
    assert.equal(id("CITATION.cff"), "yaml");
    assert.equal(id("data.json"), "json");
    assert.equal(id("README.md"), "markdown");
    assert.equal(id("Makefile"), "makefile");
    assert.equal(id("docker/Dockerfile"), "dockerfile");
    assert.equal(id("Dockerfile.gpu"), "dockerfile");
    assert.equal(id("CMakeLists.txt"), "cmake");
    assert.equal(id("mechanisms/kv.mod", "NEURON"), "nmodl");
    assert.equal(id("cell.hoc", "NEURON"), "hoc");
    assert.equal(id("model.stan"), "stan");
    assert.equal(id("clean.do"), "stata");
    assert.equal(id("solver.f90"), "fortran");
    assert.equal(id("LICENSE", "License"), "");
    assert.equal(id("notes.txt", "Text"), "");
    // An unknown extension: the harvester's label, else plain text.
    assert.equal(id("script.weird", "Python"), "python");
    assert.equal(id("script.weird"), "");
    assert.equal(languageOf("syntax.sps", "SPSS").name, "SPSS");
  });

  it("knows notebooks and literate files", () => {
    assert.deepEqual(languageOf("demo.ipynb", "Jupyter"), { id: "python", name: "Jupyter notebook", mode: "notebook" });
    assert.equal(languageOf("report.Rmd").mode, "literate");
    assert.equal(languageOf("report.Rmd").name, "R Markdown");
    assert.equal(languageOf("paper.qmd", "Quarto").mode, "literate");
    assert.equal(languageOf("live.mlx", "MATLAB").name, "MATLAB live script");
  });

  it("only names languages the highlighter can load, each of which loads and highlights", async () => {
    assert.deepEqual([...LANGUAGE_IDS].sort(), Object.keys(LOADERS).sort());
    for (const deps of Object.values(EMBEDS)) for (const d of deps) assert.ok(Object.hasOwn(LOADERS, d), d);
    for (const id of LANGUAGE_IDS) {
      const fn = (await LOADERS[id]()).default;
      hljs.registerLanguage(id, fn);
      const html = hljs.highlight("x = 1 # one\nfunction y() { return 'two' }", { language: id, ignoreIllegals: true }).value;
      assert.equal(splitHighlighted(html).length, 2, id);
      assert.ok(!/style=/.test(html), `${id}: classes only`);
    }
    for (const path of ["a.py", "a.m", "a.R", "a.cpp", "a.h", "a.cu", "a.sh", "a.mod", "a.hoc", "a.nb", "a.do", "Makefile", "Dockerfile"]) {
      const { id } = languageOf(path);
      assert.ok(id === "" || (LANGUAGE_IDS as readonly string[]).includes(id), path);
    }
  });
});

describe("a notebook and an R Markdown file", () => {
  // As the harvester stores a notebook (oscr/contents.py, notebook_to_text).
  const notebook = splitLines(
    ["# %% [markdown]", "# # Title", "# Some *text*.", "", "# %%", "library(ggplot2)", "x <- c(1, 2)", "", "# %%", "plot(x)"].join("\n") + "\n",
  );

  it("splits a notebook into cells: headers, Markdown without its comment marks, code in the kernel's language", () => {
    const plan = planOf(notebook, languageOf("a.ipynb"));
    assert.equal(plan.roles.get(0), "cell-markdown");
    assert.equal(plan.roles.get(1), "prose");
    assert.equal(plan.roles.get(4), "cell-code");
    assert.equal(plan.roles.get(8), "cell-code");
    assert.equal(plan.roles.get(5), undefined);
    assert.deepEqual(plan.segments, [
      { from: 0, to: 1, lang: "" },
      { from: 1, to: 4, lang: "markdown", strip: true },
      { from: 4, to: 5, lang: "" },
      { from: 5, to: 8, lang: "r" },
      { from: 8, to: 9, lang: "" },
      { from: 9, to: 10, lang: "r" },
    ]);
    // Every line is in exactly one segment.
    assert.equal(plan.segments.reduce((n, s) => n + s.to - s.from, 0), notebook.length);
    assert.equal(unComment("# # Title"), "# Title");
    assert.equal(unComment("#"), "");
  });

  it("guesses the kernel the way the harvester does", () => {
    assert.equal(sniffLanguage("import numpy as np\nx = 1"), "python");
    assert.equal(sniffLanguage("library(dplyr)\nx <- 1\ny <- 2"), "r");
    assert.equal(sniffLanguage("using Plots\nusing DataFrames"), "julia");
    assert.equal(sniffLanguage(""), "python");
  });

  it("keeps a notebook stored as JSON in one piece", () => {
    assert.deepEqual(planOf(['{"cells": []}'], languageOf("a.ipynb")).segments, [{ from: 0, to: 1, lang: "json" }]);
  });

  it("reads R Markdown as YAML, Markdown and chunks of code in their language", () => {
    const lines = ["---", "title: x", "---", "", "Some text.", "```{r setup, include=FALSE}", "library(x)", "```", "More.", "```{python}", "import os", "```"];
    const plan = planOf(lines, languageOf("a.Rmd"));
    assert.deepEqual(plan.segments, [
      { from: 0, to: 3, lang: "yaml" },
      { from: 3, to: 6, lang: "markdown" },
      { from: 6, to: 7, lang: "r" },
      { from: 7, to: 9, lang: "markdown" },
      { from: 9, to: 10, lang: "markdown" },
      { from: 10, to: 11, lang: "python" },
      { from: 11, to: 12, lang: "markdown" },
    ].reduce<{ from: number; to: number; lang: string }[]>((out, s) => {
      // Neighbours of the same language are one segment.
      const last = out[out.length - 1];
      if (last && last.to === s.from && last.lang === s.lang) last.to = s.to;
      else out.push({ ...s });
      return out;
    }, []));
    assert.equal(plan.roles.get(4), "prose");
    assert.equal(plan.roles.get(6), undefined, "a chunk's code is code");
  });

  it("reads a plain file in one segment", () => {
    assert.deepEqual(planOf(["a", "b"], languageOf("a.py")).segments, [{ from: 0, to: 2, lang: "python" }]);
  });
});

describe("the highlighter's lines", () => {
  it("close a span at the end of a line and open it again on the next", () => {
    const html = `<span class="hljs-comment">/* one\ntwo */</span> x\n<span class="hljs-string">&quot;y&quot;</span>`;
    assert.deepEqual(splitHighlighted(html), [
      `<span class="hljs-comment">/* one</span>`,
      `<span class="hljs-comment">two */</span> x`,
      `<span class="hljs-string">&quot;y&quot;</span>`,
    ]);
  });

  it("keep nested spans, empty lines and a stray <", () => {
    const html = `<span class="a"><span class="b">x\n\ny</span></span> <`;
    assert.deepEqual(splitHighlighted(html), [
      `<span class="a"><span class="b">x</span></span>`,
      `<span class="a"><span class="b"></span></span>`,
      `<span class="a"><span class="b">y</span></span> &lt;`,
    ]);
    assert.deepEqual(splitHighlighted(""), [""]);
  });

  it("give one piece per line of a real file, highlighted by highlight.js", async () => {
    hljs.registerLanguage("python", (await LOADERS.python()).default);
    const text = 'def f(x):\n    """Two\n    lines."""\n    return x  # <done>\n';
    const lines = splitLines(text);
    const out = splitHighlighted(hljs.highlight(lines.join("\n"), { language: "python" }).value);
    assert.equal(out.length, lines.length);
    assert.ok(out[0].includes(`<span class="hljs-keyword">def</span>`));
    assert.ok(out[1].startsWith(`    <span class="hljs-string">`) && out[1].endsWith("</span>"));
    assert.ok(out[2].startsWith(`<span class="hljs-string">`), "the string goes on");
    assert.ok(out[3].includes("&lt;done&gt;"), "the text is escaped");
    assert.equal(escapeHtml(`<a href="x">'`), "&lt;a href=&quot;x&quot;&gt;&#x27;");
  });
});

describe("a link to lines", () => {
  it("reads #L10, #L10-L20 and #L10-20, in any order", () => {
    assert.deepEqual(lineAnchor("#L10"), { start: 10, end: 10 });
    assert.deepEqual(lineAnchor("#L10-L20"), { start: 10, end: 20 });
    assert.deepEqual(lineAnchor("L10-20"), { start: 10, end: 20 });
    assert.deepEqual(lineAnchor("#L20-L10"), { start: 10, end: 20 });
    assert.deepEqual(lineAnchor("#l7"), { start: 7, end: 7 });
    for (const bad of ["", "#", "#L", "#L0", "#L-3", "#Lx", "#pair-3", "#L1-L2-L3", "#code", "#L12345678"]) assert.equal(lineAnchor(bad), null, bad);
  });

  it("writes them back, and keeps them within the file", () => {
    assert.equal(anchorText({ start: 10, end: 10 }), "L10");
    assert.equal(anchorText({ start: 10, end: 20 }), "L10-L20");
    assert.deepEqual(clampRange({ start: 10, end: 20 }, 15), { start: 10, end: 15 });
    assert.equal(clampRange({ start: 16, end: 20 }, 15), null);
    assert.equal(clampRange({ start: 1, end: 1 }, 0), null);
  });

  it("says a size in words", () => {
    assert.equal(sizeInWords(812), "812 B");
    assert.equal(sizeInWords(2150), "2.1 KB");
    assert.equal(sizeInWords(2048), "2 KB");
    assert.equal(sizeInWords(38_900), "38 KB");
    assert.equal(sizeInWords(1_300_000), "1.2 MB");
  });
});

describe("the list of files", () => {
  const tree = buildTree(
    ["Figure10/b.m", "Figure2/a.m", "README.md", "src/main/java/App.java", "src/main/java/Util.java", "Figure2/c.m", "setup.py"].map(
      (path, file) => ({ path, file }),
    ),
  );

  it("puts folders first, then files, in natural order", () => {
    assert.deepEqual(tree.dirs.map((d) => d.name), ["Figure2", "Figure10", "src/main/java"]);
    assert.deepEqual(tree.files.map((f) => f.name), ["README.md", "setup.py"]);
    assert.deepEqual(tree.dirs[0].files.map((f) => f.name), ["a.m", "c.m"]);
  });

  it("shows a folder that holds only one folder with it, and counts the files", () => {
    const java = tree.dirs[2];
    assert.equal(java.path, "src/main/java");
    assert.deepEqual(java.files.map((f) => f.file), [3, 4]);
    assert.equal(tree.count, 7);
    assert.equal(tree.dirs[0].count, 2);
  });

  it("opens the folders of a file", () => {
    assert.deepEqual(ancestors("a/b/c.py"), ["a", "a/b"]);
    assert.deepEqual(ancestors("c.py"), []);
  });
});

describe("the choices kept in the browser", () => {
  const memory = (): Store & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  const refusing: Store = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
  };

  it("keeps the paper pane hidden, and reads it back", () => {
    const m = memory();
    assert.equal(readPref(() => m, PREFS.paper, ["shown", "hidden"], "shown"), "shown");
    assert.equal(writePref(() => m, PREFS.paper, "hidden"), true);
    assert.equal(m.data.get("reader.paper"), "hidden");
    assert.equal(readPref(() => m, PREFS.paper, ["shown", "hidden"], "shown"), "hidden");
  });

  it("falls back to the default when storage is missing, refuses, or holds something else", () => {
    assert.equal(readPref(() => refusing, PREFS.paper, ["shown", "hidden"], "shown"), "shown");
    assert.equal(writePref(() => refusing, PREFS.paper, "hidden"), false);
    assert.equal(readPref(() => null, PREFS.wrap, ["on", "off"], "off"), "off");
    assert.equal(writePref(() => null, PREFS.wrap, "on"), false);
    assert.equal(
      readPref(() => {
        throw new Error("no localStorage here");
      }, PREFS.files, ["shown", "hidden"], "shown"),
      "shown",
    );
    const m = memory();
    m.data.set(PREFS.paper, "<script>");
    assert.equal(readPref(() => m, PREFS.paper, ["shown", "hidden"], "shown"), "shown");
  });

  it("never names the platform in its keys", () => {
    for (const k of Object.values(PREFS)) assert.match(k, /^reader\.[a-z]+$/);
  });
});

describe("the reader's files and pairs", () => {
  const file = (path: string, text: string | null, over: Partial<LotFileIn> = {}): LotFileIn => ({
    path, language: "", kind: "script", lines: text === null ? 3 : splitLines(text).length, text, truncated: false, note: "",
    source_url: `https://github.com/lab/x/blob/abc/${encodePath(path)}`, ...over,
  });
  const repos: RepoIn[] = [
    {
      repo: "github.com/lab/x", url: "https://github.com/lab/x", name: "lab/x", license: "MIT", state: "alive", lot: "07",
      entry: {
        commit: "abc", license: "MIT", published: true,
        files: [
          file("README.md", "# x\n", { kind: "doc" }),
          file("fig 1/plot.py", "import x\n\nplot()\n"),
          file("analysis.py", "a = 1\nb = 2\n"),
          file("live.mlx", null, { note: "binary file: readable only at the source" }),
          { path: "…", language: "", kind: "note", lines: null, text: null, truncated: false, note: "repository limit reached", source_url: "" },
        ],
      },
    },
    {
      repo: "zenodo:1", url: "https://zenodo.org/records/1", name: "Zenodo 1", license: "", state: "alive", lot: "08",
      entry: {
        commit: "", license: "", published: false,
        files: [
          file("code.zip/run.m", null, { source_url: "https://zenodo.org/records/1" }),
          file("code.zip/util.m", null, { source_url: "https://zenodo.org/records/1" }),
        ],
      },
    },
    { repo: "github.com/lab/dead", url: "https://github.com/lab/dead", name: "lab/dead", license: "", state: "dead", lot: "09" },
  ];
  const pair = (n: number, repo: string, path: string, start: number, end: number): PairIn => ({
    pair: n, paragraph: 10 + n, section: n === 2 ? "" : "Methods", repo, path, start_line: start, end_line: end, score: 0.5, evidence: ["term"],
  });

  it("lists every file, says why a text is not here, and keeps the texts apart", () => {
    const { repos: rs, files, texts } = readerFiles(repos);
    assert.deepEqual(files.map((f) => f.path), ["README.md", "fig 1/plot.py", "analysis.py", "live.mlx", "code.zip/run.m", "code.zip/util.m"]);
    assert.deepEqual(files.map((f) => f.why), ["", "", "", "binary", "license", "license"]);
    assert.deepEqual(files.map((f) => f.text), [true, true, true, false, false, false]);
    assert.equal(files[2].bytes, 12);
    assert.equal(files[4].bytes, null);
    assert.equal(texts.get(2), "a = 1\nb = 2\n");
    assert.ok(!texts.has(4));
    assert.equal(rs[0].note, "repository limit reached");
    assert.deepEqual(rs.map((r) => [r.read, r.published]), [[true, true], [true, false], [false, false]]);
  });

  it("says when a copy was withheld at a removal request, a repository's or one file's", () => {
    const WITHHELD = "Withheld from this site at a removal request: read it at the source.";
    const held: RepoIn[] = [
      { ...repos[0], entry: { ...repos[0].entry!, files: [file("a.py", null, { note: WITHHELD }), file("b.py", "b = 1\n")] } },
      { ...repos[0], repo: "github.com/lab/y", entry: { ...repos[0].entry!, published: false, files: [file("c.py", null, { note: WITHHELD })] } },
    ];
    const { files } = readerFiles(held);
    assert.deepEqual(files.map((f) => f.why), ["withheld", "", "withheld"]);
    assert.equal(whyNotShown(files[0], { license: "MIT" }), "This file is not shown here: it was withheld at a removal request.");
    // A note written before 2026-09-29 says it the same way.
    const before = readerFiles([{ ...repos[0], entry: { ...repos[0].entry!, files: [file("a.py", null, { note: "Withheld from this site at a removal request, after a moderator's review: read it at the source." })] } }]);
    assert.equal(before.files[0].why, "withheld");
  });

  it("carries the facts of a file held back for its license, and where the browser fetches it", () => {
    const DIGEST = "ab".repeat(32);
    const source = { via: "github", url: "https://raw.githubusercontent.com/lab/h/" + "c".repeat(40) + "/{path}", at: "c".repeat(40) };
    const held: RepoIn[] = [
      {
        repo: "github.com/lab/h", url: "https://github.com/lab/h", name: "lab/h", license: "", state: "alive", lot: "10",
        entry: {
          commit: "c".repeat(40), license: "", published: false, source, redistributable: "no",
          files: [
            file("run.m", null, { sha256: DIGEST, size: 1234, note: "This repository has no license" }),
            file("old.m", null, { note: "This repository has no license" }),
            file("cut.m", null, { note: "Withheld from this site at a removal request: read it at the source." }),
            file("inside.m", null, { sha256: DIGEST, size: 10, via: "swh" }),
          ],
        },
      },
      // A template that leaves the allowed places is not kept: the files are linked, not fetched.
      { ...repos[0], repo: "github.com/lab/z", entry: { ...repos[0].entry!, published: false, source: { via: "github", url: "https://evil.example/{path}", at: "x" }, files: [file("z.py", null, { sha256: DIGEST, size: 3 })] } },
    ];
    const { repos: rs, files } = readerFiles(held);
    assert.deepEqual(rs[0].source, { via: "github", url: source.url, at: source.at });
    assert.deepEqual(rs[1].source, { via: "", why: "host" });
    assert.deepEqual(files.map((f) => [f.path, f.why, f.sha256 !== "", f.bytes, f.via]), [
      ["run.m", "license", true, 1234, ""],
      ["old.m", "license", false, null, ""],
      ["cut.m", "withheld", false, null, ""],
      ["inside.m", "license", true, 10, "swh"],
      ["z.py", "license", true, 3, ""],
    ]);
    assert.deepEqual(files.map((f) => fromSource(rs, f)), [true, false, false, true, false]);
    // Nothing in the page's data holds a text of it.
    assert.ok(files.every((f) => !f.text));
    assert.match(whyNotShown(files[0], rs[0]), /keeps no copy of this file: its repository has no license.*shows it from its source/);
    assert.match(whyNotShown(files[1], rs[0]), /has no license, so its authors keep all their rights to it\.$/);
    // With nothing copied, the reader opens on a file it can show from the source.
    assert.equal(initialFile(files, rs), 0);
    // A copied repository never carries a source.
    assert.equal(readerFiles(repos).repos[0].source, null);
  });

  it("writes a file's address at the source once per repository when it can", () => {
    const { repos: rs, files } = readerFiles(repos);
    assert.equal(rs[0].sourcePrefix, "https://github.com/lab/x/blob/abc/");
    assert.equal(files[1].source, "", "derived from the prefix");
    assert.equal(sourceOf(rs[0], files[1]), "https://github.com/lab/x/blob/abc/fig%201/plot.py");
    assert.equal(rs[1].sourceSame, "https://zenodo.org/records/1");
    assert.equal(sourceOf(rs[1], files[4]), "https://zenodo.org/records/1");
    // An address the prefix does not give is kept as it is.
    const odd = readerFiles([{ ...repos[0], entry: { ...repos[0].entry!, files: [file("a.py", "x\n"), file("b.py", "y\n", { source_url: "https://elsewhere.example/b" })] } }]);
    assert.equal(odd.files[1].source, "https://elsewhere.example/b");
    assert.equal(sourceOf(odd.repos[0], odd.files[1]), "https://elsewhere.example/b");
  });

  it("joins each pair to its file, with its lines at the source", () => {
    const { repos: rs, files } = readerFiles(repos);
    const pairs = mapPairs(
      [pair(3, "github.com/lab/x", "analysis.py", 1, 2), pair(1, "github.com/lab/x", "fig 1/plot.py", 3, 3), pair(2, "zenodo:1", "code.zip/run.m", 4, 9),
        pair(4, "github.com/lab/x", "gone.py", 1, 1), pair(5, "github.com/lab/x", "analysis.py", 2, 2)],
      rs,
      files,
    );
    assert.deepEqual(pairs.map((p) => [p.pair, p.file]), [[1, 1], [2, 4], [3, 2], [4, -1], [5, 2]]);
    assert.deepEqual(files[2].pairs, [3, 5]);
    assert.equal(pairs[0].source, "https://github.com/lab/x/blob/abc/fig%201/plot.py#L3");
    assert.equal(pairs[2].source, "https://github.com/lab/x/blob/abc/analysis.py#L1-L2");
    assert.equal(pairs[1].source, "https://zenodo.org/records/1", "an archive has no lines to point at");
    assert.equal(pairs[1].label, "§ paragraph 12");
    assert.equal(pairs[0].label, "§ Methods");
    assert.equal(pairs[3].source, "https://github.com/lab/x");
    // analysis.py has 2 lines: pair 3 (lines 1–2) is the whole file, a weak match; pair 5 is not.
    assert.deepEqual(pairs.map((p) => [p.pair, p.whole]), [[1, false], [2, false], [3, true], [4, false], [5, false]]);
  });

  it("opens on the file with the most matches, else the first script whose text is here", () => {
    const { repos: rs, files } = readerFiles(repos);
    mapPairs([pair(1, "github.com/lab/x", "fig 1/plot.py", 1, 1), pair(2, "github.com/lab/x", "analysis.py", 1, 1), pair(3, "github.com/lab/x", "analysis.py", 2, 2)], rs, files);
    assert.equal(initialFile(files), 2);
    const plain = readerFiles(repos).files;
    assert.equal(initialFile(plain), 1, "README.md is a document, not a script");
    assert.equal(initialFile(readerFiles([repos[1]]).files), 0, "no text anywhere: the first file, which says why");
    assert.equal(initialFile([]), -1);
  });

  it("links to a file in the reader, naming the repository only when there are several", () => {
    assert.equal(fileHref("/paper/p/", "github.com/lab/x", "fig 1/plot.py", false, "L3-L5"), "/paper/p/?path=fig+1%2Fplot.py#L3-L5");
    assert.equal(fileHref("/paper/p/", "github.com/lab/x", "a.py", true, "code"), "/paper/p/?repo=github.com%2Flab%2Fx&path=a.py#code");
    assert.equal(fileHref("/paper/p/", "r", "a.py", false), "/paper/p/?path=a.py");
  });
});

describe("the lines of a file", () => {
  it("are split like the harvester and the forges count them", () => {
    assert.deepEqual(splitLines("a\r\nb\n"), ["a", "b"]);
    assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
    assert.deepEqual(splitLines(""), [""]);
  });

  it("carry their pairs, the link on the first line that is not blank", () => {
    const { cover, link } = decorate(["", "x", "y", "z"], [{ pair: 2, start: 1, end: 3 }, { pair: 1, start: 3, end: 9 }]);
    assert.deepEqual(cover.get(3), [1, 2]);
    assert.deepEqual(cover.get(4), [1]);
    assert.equal(cover.get(5), undefined, "within the file");
    assert.equal(link.get(2), 2);
    assert.equal(link.get(3), 1);
    assert.equal(pairClass(7), "pair-1");
    assert.equal(lineClass(1, false), "pair-1");
    assert.equal(lineClass(8, true), "pair-2 whole");
    assert.equal(lineClass(undefined, false), undefined);
    assert.equal(sourceLines("https://gitlab.com/a/b/-/blob/c/d.py", 3, 5), "https://gitlab.com/a/b/-/blob/c/d.py#L3-5");
  });
});

describe("a match with the whole file", () => {
  it("is a range that covers 90 % of the file's lines at least", () => {
    assert.equal(wholeFile(1, 107, 107), true);
    assert.equal(wholeFile(1, 100, 107), true, "the last lines blank or an end");
    assert.equal(wholeFile(1, 37, 312), false);
    assert.equal(wholeFile(1, 500, 21), true, "a range past the end");
    assert.equal(wholeFile(1, 3, null), false, "a file whose length is not known");
    assert.equal(wholeFile(2, 2, 2), false);
  });

  it("does not tint the lines it alone covers, and yields to a match of given lines", () => {
    const lines = ["function f", "  a", "  b", "", "  c", "end"];
    const { cover, link, color, weak } = decorate(lines, [
      { pair: 1, start: 1, end: 6, whole: true }, { pair: 2, start: 3, end: 5 }, { pair: 3, start: 1, end: 6, whole: true },
    ]);
    assert.deepEqual(cover.get(1), [1, 3]);
    assert.deepEqual(cover.get(3), [2, 1, 3], "the given lines' pair first");
    assert.deepEqual([link.get(1), link.get(2), link.get(3)], [1, 3, 2]);
    assert.deepEqual([...weak].sort(), [1, 2, 6]);
    assert.deepEqual([1, 2, 3, 6].map((n) => color.get(n)), [1, 3, 2, 1], "a weak line takes the color of the pair linked there");
  });

  it("colors a line by its narrowest range of given lines", () => {
    const { color } = decorate(["a", "b", "c", "d"], [{ pair: 1, start: 1, end: 4 }, { pair: 2, start: 2, end: 3 }]);
    assert.deepEqual([1, 2, 3, 4].map((n) => color.get(n)), [1, 2, 2, 1]);
  });
});

describe("the paper's request to Europe PMC", () => {
  /** An attempt that answers after `ms` (or never, and then only an abort ends it). */
  const after = (ms: number | null, answer: () => Promise<string>) => (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const t = ms === null ? null : setTimeout(() => answer().then(resolve, reject), ms);
      signal.addEventListener("abort", () => {
        if (t) clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  it("waits for a slow answer within the time limit, and says it is slow", async () => {
    const slow: number[] = [];
    const text = await withRetry(after(40, async () => "<article/>"), { timeout: 500, slowAfter: 10, onSlow: (n) => slow.push(n) });
    assert.equal(text, "<article/>");
    assert.deepEqual(slow, [1]);
  });

  it("tries once more when the first try gets no answer in time, or a server's error", async () => {
    let n = 0;
    const retried: number[] = [];
    const text = await withRetry((signal) => (++n === 1 ? after(null, async () => "")(signal) : Promise.resolve("second")), {
      timeout: 30, pause: 1, onRetry: (k) => retried.push(k),
    });
    assert.equal(text, "second");
    assert.equal(n, 2);
    assert.deepEqual(retried, [2]);
    let m = 0;
    assert.equal(await withRetry(async () => (++m === 1 ? Promise.reject(new HttpError(503)) : "ok"), { pause: 1 }), "ok");
    assert.equal(m, 2);
  });

  it("gives up after its tries with a TimeoutError, and at once for a missing text", async () => {
    let n = 0;
    await assert.rejects(withRetry((signal) => (n++, after(null, async () => "")(signal)), { timeout: 20, pause: 1 }), (e: unknown) => {
      assert.ok(e instanceof TimeoutError);
      assert.equal(n, 2);
      return true;
    });
    let m = 0;
    await assert.rejects(withRetry(async () => (m++, Promise.reject(new HttpError(404))), { pause: 1 }), HttpError);
    assert.equal(m, 1, "a text Europe PMC does not have is not asked again");
  });

  it("knows which failures may pass", () => {
    assert.equal(worthRetrying(new TimeoutError(20)), true);
    assert.equal(worthRetrying(new TypeError("Failed to fetch")), true);
    assert.equal(worthRetrying(new HttpError(502)), true);
    assert.equal(worthRetrying(new HttpError(429)), true);
    assert.equal(worthRetrying(new HttpError(404)), false);
    assert.equal(worthRetrying(new Error("the full text is not valid XML")), false);
  });
});

describe("a file the reader does not show", () => {
  const f = (why: "" | "license" | "binary" | "missing", note = "", path = "a.m") => ({ why, note, path });
  it("says why, in a sentence, and never twice that the source has it", () => {
    assert.match(whyNotShown(f("license"), { license: "" }), /no license, so its authors keep all their rights/);
    assert.match(whyNotShown(f("license"), { license: "GPL-3.0-only" }), /\(GPL-3\.0-only\) does not allow republishing it\.$/);
    assert.match(whyNotShown(f("binary", "", "x.mlx"), { license: "MIT" }), /live script is a binary file/);
    assert.match(
      whyNotShown(f("missing", "too large a repository to show every file here: read it at the source"), { license: "MIT" }),
      /too large for the registry to keep the text of every file/,
    );
    assert.match(whyNotShown(f("missing", "too much text in this part of the site to show every file here: read it at the source"), { license: "MIT" }), /did not fit\.$/);
    assert.equal(whyNotShown(f("missing", "extraction failed; read it at the source"), { license: "MIT" }), "This file is not shown here: extraction failed.");
    assert.equal(whyNotShown(f("missing"), { license: "MIT" }), "This file is not shown here: its text was not kept.");
    assert.equal(whyNotShown(f(""), { license: "MIT" }, "HTTP 503"), "This file could not be loaded here (HTTP 503).");
  });

  it("says, where it leads to the source, why one would go there", () => {
    assert.equal(sourceWhy("0123456789abcdef", true), "Shown here as the registry read it at commit 0123456. The source has the authors' latest version and its history.");
    assert.match(sourceWhy("", false), /^Not shown here\. The source has the file/);
  });
});

describe("the pairs in PubMed Central's copy of a paper", () => {
  const copy = [
    { section: "Introduction", text: "Sleep is a state of reduced responsiveness." },
    { section: "Data availability", text: "All data are in the supplementary files." },
    { section: "Methods › Spike sorting", text: "Units were sorted with Kilosort 2.5 and curated in Phy." },
    { section: "Methods › Ripples", text: "Ripples were detected between 150 and 250 Hz, at 3 SD above the mean." },
    { section: "Methods › Ripples", text: "Ripple rates were compared with a Wilcoxon test." },
  ];
  const pair = (n: number, paragraph: number, section: string, evidence: string[]) => ({ pair: n, paragraph, section, evidence });

  it("keeps a pair on its number when that paragraph has its section and its terms", () => {
    const r = placePairs([pair(1, 2, "Methods › Spike sorting", ["Kilosort", "Phy", "curated"])], copy);
    assert.deepEqual([...r.at], [[1, 2]]);
    assert.deepEqual([r.moved, r.lost], [0, 0]);
  });

  it("moves a pair whose number is off (a paragraph less in this copy) to the one with its terms", () => {
    // Europe PMC's copy had a second statement: its paragraph 4 is this copy's 3.
    const r = placePairs([pair(1, 4, "Methods › Ripples", ["150 and 250 Hz", "3 SD", "ripples were detected"]), pair(2, 5, "Methods › Ripples", ["Wilcoxon", "ripple rates"])], copy);
    assert.deepEqual([...r.at], [[1, 3], [2, 4]]);
    assert.equal(r.moved, 2);
  });

  it("prefers the paragraph that holds more of its terms, and leaves out a pair no paragraph fits", () => {
    const r = placePairs(
      [pair(1, 4, "Methods › Ripples", ["ripple", "wilcoxon test"]), pair(2, 1, "Results", ["theta phase", "place cells", "decoding"])],
      copy,
    );
    assert.equal(r.at.get(1), 4);
    assert.equal(r.at.has(2), false);
    assert.equal(r.lost, 1);
  });
});
