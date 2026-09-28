// The code browser of the /r/ shell (night phase 02, E1): src/lib/code-nav.ts (refs, listings,
// files, hidden Unicode, lines and permalinks, the views), src/lib/gitcache.ts (the tab's cache of
// GitHub's answers), and src/scripts/repo-code.ts `openRef` read through the real GitHub adapter
// against the fake GitHub, anonymously, as the reader's browser does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { githubBackend } from "../../worker/forge/github/index.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import {
  atSource,
  classifyFile,
  codeBlock,
  codePoint,
  degradedView,
  entryAt,
  fileInfo,
  fileTable,
  fileTree,
  imageType,
  isDirectory,
  joinRelative,
  licenceShows,
  lineCounts,
  lineHash,
  linesInWords,
  listDirectory,
  parseGitmodules,
  parseLineHash,
  pathCrumbs,
  permalink,
  refSwitcher,
  resolveRefPath,
  revealHidden,
  sizeInWords,
  submoduleTarget,
  textLines,
  unicodeWarnings,
} from "../../src/lib/code-nav.ts";
import { CACHE_PREFIX, cachedSession, gitCache, type KeyValueStore } from "../../src/lib/gitcache.ts";
import { highlightText, plainLines } from "../../src/lib/highlight.ts";
import { type El, textOf, walk } from "../../src/lib/repo-view.ts";
import { type CodeEnv, openRef } from "../../src/scripts/repo-code.ts";
import { FakeGitHub } from "../forge/fake-github.ts";
import { MemoryBackend } from "../forge/memory.ts";

const EEG = { owner: "oscr-fixture", name: "eeg-analysis" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const EMAIL = "private.person@example.org";
const cp = (n: number) => String.fromCodePoint(n);
const hrefs = (el: El) => [...walk(el)].map((e) => e.attrs.href).filter(Boolean);

const entry = (path: string, type: T.EntryType = "blob", mode: T.TreeEntry["mode"] = "100644", size: number | null = 10): T.TreeEntry => ({
  path,
  mode: type === "tree" ? "040000" : type === "commit" ? "160000" : mode,
  type,
  sha: SHA,
  size: type === "blob" ? size : null,
});

describe("refs and paths", () => {
  const refs = {
    branches: [
      { name: "main", sha: "1".repeat(40) },
      { name: "feature", sha: "2".repeat(40) },
      { name: "feature/x", sha: "3".repeat(40) },
    ],
    tags: [{ name: "v1.0", sha: "4".repeat(40) }],
    complete: true,
  };

  test("the longest branch or tag that prefixes the segments wins, as on GitHub", () => {
    assert.deepEqual(resolveRefPath(["feature", "x", "src", "a.py"], refs), { ref: "feature/x", kind: "branch", sha: "3".repeat(40), path: "src/a.py" });
    assert.deepEqual(resolveRefPath(["feature", "y.py"], refs), { ref: "feature", kind: "branch", sha: "2".repeat(40), path: "y.py" });
    assert.deepEqual(resolveRefPath(["v1.0", "README.md"], refs), { ref: "v1.0", kind: "tag", sha: "4".repeat(40), path: "README.md" });
    assert.deepEqual(resolveRefPath([SHA, "a", "b"], refs), { ref: SHA, kind: "commit", sha: SHA, path: "a/b" });
    assert.deepEqual(resolveRefPath(["other", "a"], refs), { ref: "other", kind: "unknown", sha: null, path: "a" });
    assert.deepEqual(resolveRefPath(["main"], null), { ref: "main", kind: "unknown", sha: null, path: "" });
    assert.deepEqual(resolveRefPath([], refs, "main"), { ref: "main", kind: "branch", sha: "1".repeat(40), path: "" });
  });

  test("a directory listing: directories first, single-directory chains collapsed, kinds in words", () => {
    const entries = [
      entry("README.md"),
      entry("src", "tree"),
      entry("src/main", "tree"),
      entry("src/main/java", "tree"),
      entry("src/main/java/App.java"),
      entry("src/main/java/Util.java"),
      entry("docs", "tree"),
      entry("docs/index.md"),
      entry("docs/img", "tree"),
      entry("vendor-lib", "commit"),
      entry("run.sh", "blob", "100755"),
      entry("latest", "blob", "120000"),
      entry("file10.txt"),
      entry("file9.txt"),
    ];
    const root = listDirectory(entries, "");
    assert.deepEqual(root.map((e) => [e.name, e.kind]), [
      ["docs", "dir"],
      ["src/main/java", "dir"],
      ["vendor-lib", "submodule"],
      ["file9.txt", "file"],
      ["file10.txt", "file"],
      ["latest", "symlink"],
      ["README.md", "file"],
      ["run.sh", "executable"],
    ]);
    assert.equal(root.find((e) => e.name === "src/main/java")?.path, "src/main/java");
    assert.deepEqual(listDirectory(entries, "docs").map((e) => e.name), ["img", "index.md"]);
    assert.equal(isDirectory(entries, "src/main"), true);
    assert.equal(isDirectory(entries, "README.md"), false);
    assert.equal(isDirectory(entries, ""), true);
    assert.equal(entryAt(entries, "run.sh")?.mode, "100755");
  });

  test("sizes, lines and lines of code", () => {
    assert.equal(sizeInWords(0), "0 bytes");
    assert.equal(sizeInWords(1), "1 byte");
    assert.equal(sizeInWords(612), "612 bytes");
    assert.equal(sizeInWords(4200), "4.2 KB");
    assert.equal(sizeInWords(1_300_000), "1.3 MB");
    assert.equal(sizeInWords(250_000), "250 KB");
    assert.deepEqual(textLines("a\r\nb\rc\n"), ["a", "b", "c"]);
    assert.deepEqual(textLines("a\n\n"), ["a", ""]);
    assert.deepEqual(textLines(""), []);
    assert.deepEqual(lineCounts(["x = 1", "", "  ", "y"]), { lines: 4, loc: 2 });
  });
});

describe("files", () => {
  test("what a file is, before and after reading it", () => {
    assert.equal(classifyFile(entry("m", "commit")), "submodule");
    assert.equal(classifyFile(entry("l", "blob", "120000")), "symlink");
    assert.equal(classifyFile(entry("fig.png"), null, "fig.png"), "image");
    assert.equal(classifyFile(entry("big.png", "blob", "100644", 11 * 1024 * 1024), null, "big.png"), "too_large");
    assert.equal(classifyFile(entry("big.csv", "blob", "100644", 2 * 1024 * 1024), null, "big.csv"), "too_large");
    assert.equal(classifyFile(entry("logo.svg"), { binary: false, lfs: null, size: 300 }, "logo.svg"), "text", "an SVG is text, rendered as an image");
    assert.equal(classifyFile(entry("data.bin"), { binary: true, lfs: null, size: 30 }, "data.bin"), "binary");
    assert.equal(classifyFile(entry("data.h5"), { binary: false, lfs: { oid: "a".repeat(64), size: 9e9 }, size: 130 }, "data.h5"), "lfs");
    assert.equal(classifyFile(entry("empty"), { binary: false, lfs: null, size: 0 }, "empty"), "empty");
    assert.equal(imageType("a/b/Figure.JPG"), "image/jpeg");
    assert.equal(imageType("x.svg"), "image/svg+xml");
    assert.equal(imageType("x.py"), null);
  });

  test("hidden and bidirectional Unicode: counted, and shown as code points, never applied", () => {
    const rlo = cp(0x202e);
    const zwsp = cp(0x200b);
    const bom = cp(0xfeff);
    const text = `${bom}access_level = "user${rlo} ${cp(0x2066)}// admin${cp(0x2069)}"\nx${zwsp}y = 1\n`;
    assert.deepEqual(unicodeWarnings(text), { bidi: 3, hidden: 1 });
    assert.deepEqual(unicodeWarnings(`${bom}plain`), { bidi: 0, hidden: 0 }, "a leading byte order mark is ordinary");
    const shown = revealHidden(`a${rlo}b`);
    assert.equal(shown.length, 3);
    assert.equal((shown[1] as El).attrs.class, "hidden-char");
    assert.equal(textOf(shown[1] as El), `⟨U+202E⟩`);
    assert.equal(codePoint(zwsp), "U+200B");
    assert.deepEqual(revealHidden("nothing"), ["nothing"]);
    const block = codeBlock(plainLines([`x = "${rlo}"`]));
    assert.ok(!textOf(block).includes(rlo), "the character itself never reaches the page");
    assert.ok(textOf(block).includes("⟨U+202E⟩"));
  });

  test("the lines: one li per line, ids L1…, tab width, marks, emails masked", async () => {
    const lines = ["import numpy as np", "", `# by ${EMAIL}`];
    const block = codeBlock(await highlightText(lines, "Python"), { tabWidth: 2, marks: new Map([[1, "pair-1"]]) });
    assert.equal(block.tag, "ol");
    assert.equal(block.attrs.class, "lines code tab-2");
    assert.equal(block.children.length, 3);
    const lis = block.children as El[];
    assert.deepEqual(lis.map((l) => l.attrs.id), ["L1", "L2", "L3"]);
    assert.equal(lis[0].attrs.class, "pair-1");
    assert.equal(lis[1].children.length, 0);
    assert.ok(!textOf(block).includes(EMAIL));
    assert.match(textOf(block), /\[email hidden\]/);
  });

  test("the file's header line", () => {
    assert.equal(textOf(fileInfo({ lines: { lines: 23, loc: 19 }, size: 612, language: "Python", kind: "text" })), "23 lines (19 loc) · 612 bytes · Python");
    assert.equal(textOf(fileInfo({ size: 4200, language: null, kind: "image" })), "4.2 KB · an image");
    assert.equal(textOf(fileInfo({ size: 130, language: null, kind: "lfs", executable: true })), "130 bytes · stored with Git LFS · executable");
  });
});

describe("lines and permalinks", () => {
  test("#L12, #L12-L20, columns ignored, the order fixed", () => {
    assert.deepEqual(parseLineHash("#L12"), { start: 12, end: 12 });
    assert.deepEqual(parseLineHash("#L20-L12"), { start: 12, end: 20 });
    assert.deepEqual(parseLineHash("L3C5-L4C2"), { start: 3, end: 4 });
    for (const bad of ["", "#", "#L0", "#12", "#L1-", "#Lx", "#L1-L2-L3", "#L99999999"]) assert.equal(parseLineHash(bad), null, bad);
    assert.equal(lineHash({ start: 5, end: 5 }), "#L5");
    assert.equal(lineHash({ start: 5, end: 9 }), "#L5-L9");
    assert.equal(linesInWords({ start: 5, end: 9 }), "lines 5 to 9");
    assert.equal(linesInWords({ start: 5, end: 5 }), "line 5");
  });

  test("a permalink is at a commit id, on this site", () => {
    assert.equal(permalink(EEG, SHA, "analysis/pre process.py", { start: 6, end: 10 }), `/r/oscr-fixture/eeg-analysis/blob/${SHA}/analysis/pre%20process.py#L6-L10`);
    assert.equal(permalink(EEG, SHA, "a.py"), `/r/oscr-fixture/eeg-analysis/blob/${SHA}/a.py`);
    assert.throws(() => permalink(EEG, "main", "a.py"));
  });
});

describe("the views", () => {
  test("the path: each directory a link to its tree at the same ref", () => {
    const crumbs = pathCrumbs(EEG, "feature/x", "analysis/sub/a.py", true);
    assert.equal(textOf(crumbs), "eeg-analysis / analysis / sub / a.py");
    assert.deepEqual(hrefs(crumbs), [
      "/r/oscr-fixture/eeg-analysis/tree/feature/x/",
      "/r/oscr-fixture/eeg-analysis/tree/feature/x/analysis/",
      "/r/oscr-fixture/eeg-analysis/tree/feature/x/analysis/sub/",
    ]);
    assert.equal(textOf(pathCrumbs(EEG, "main", "", false)), "eeg-analysis");
  });

  test("the switcher lists branches and tags, keeps the view and the path, marks the current one", () => {
    const refs = { branches: [{ name: "main", sha: SHA }, { name: "dev", sha: SHA }], tags: [{ name: "v1.0", sha: SHA }], complete: false };
    const s = refSwitcher(EEG, "blob", { ref: "dev", kind: "branch" }, "src/a.py", refs, "main");
    assert.equal(s.tag, "details");
    assert.match(textOf(s), /^Branch: dev/);
    assert.match(textOf(s), /main \(default\)/);
    assert.match(textOf(s), /The first 100 of each/);
    assert.deepEqual(hrefs(s), [
      "/r/oscr-fixture/eeg-analysis/blob/main/src/a.py",
      "/r/oscr-fixture/eeg-analysis/blob/v1.0/src/a.py",
      "/r/oscr-fixture/eeg-analysis/branches/",
    ]);
    assert.match(textOf(refSwitcher(EEG, "tree", { ref: SHA, kind: "commit" }, "", null, "main")), /^Commit: 0123456/);
  });

  test("the files table: links to tree and blob views, submodules to their repository at the commit", () => {
    const entries = listDirectory([entry("a", "tree"), entry("a/x.py"), entry("b.py", "blob", "100644", 4200), entry("lib", "commit")], "");
    const table = fileTable(EEG, "main", "", entries, { lib: "/r/other/lib/tree/0123456789abcdef0123456789abcdef01234567/" });
    assert.equal(table.tag, "table");
    assert.deepEqual(hrefs(table), [
      "/r/oscr-fixture/eeg-analysis/tree/main/a/",
      "/r/other/lib/tree/0123456789abcdef0123456789abcdef01234567/",
      "/r/oscr-fixture/eeg-analysis/blob/main/b.py",
    ]);
    assert.match(textOf(table), /b\.pyfile4\.2 KB/);
    assert.match(textOf(table), /lib @ 0123456submodule/);
    const sub = fileTable(EEG, "main", "a/b", []);
    assert.match(textOf(sub), /This directory is empty/);
    assert.equal(hrefs(sub)[0], "/r/oscr-fixture/eeg-analysis/tree/main/a/");
  });

  test(".gitmodules, submodule addresses, relative targets of symbolic links", () => {
    const map = parseGitmodules('[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/lab/lib.git\n[submodule "x"]\n\tpath = ext/x\n\turl = git@github.com:lab/x.git\n');
    assert.deepEqual(map, { lib: "https://github.com/lab/lib.git", "ext/x": "git@github.com:lab/x.git" });
    assert.equal(submoduleTarget(map.lib, SHA), `/r/lab/lib/tree/${SHA}/`);
    assert.equal(submoduleTarget(map["ext/x"], SHA), `/r/lab/x/tree/${SHA}/`);
    assert.equal(submoduleTarget("https://gitlab.com/lab/y.git", SHA), "https://gitlab.com/lab/y.git");
    assert.equal(submoduleTarget("../relative.git", SHA), null);
    assert.equal(joinRelative("a/b", "../c/d.py"), "a/c/d.py");
    assert.equal(joinRelative("", "x/./y"), "x/y");
    assert.equal(joinRelative("a", "../../out"), null);
    assert.equal(joinRelative("a", "/etc/passwd"), null);
  });

  test("GitHub unreadable: said in words; the source a discreet last resort, never for what does not exist", () => {
    const v = degradedView({ code: "rate_limited", retryAfter: 120 }, "https://github.com/oscr-fixture/eeg-analysis/tree/main", "directory");
    assert.match(textOf(v), /60 requests an hour.*this directory shows again in about 2 minutes\.Until then, the directory can only be read where it is hosted\. At the source\./);
    assert.deepEqual(hrefs(v), ["https://github.com/oscr-fixture/eeg-analysis/tree/main"]);
    const missing = degradedView({ code: "not_found" }, "https://github.com/x/y", "file");
    assert.match(textOf(missing), /There is no file at this address/);
    assert.deepEqual(hrefs(missing), [], "nothing to find at the source either");
    assert.match(textOf(degradedView(null, "https://github.com/x/y", "file")), /GitHub, where this repository is hosted, did not answer/);
    const src = atSource("Blame needs a GitHub sign-in.", "https://github.com/x/y/blame/main/a.py");
    assert.equal(src.attrs.class, "at-source");
    assert.equal(textOf(src), "Blame needs a GitHub sign-in. At the source.");
  });

  test("the licence decides whether files are shown: open licences yes; none, or unidentified, no", () => {
    for (const spdx of ["MIT", "GPL-3.0", "Apache-2.0", "CC-BY-4.0", "CC-BY-NC-4.0", "BSD-3-Clause", "Unlicense", "CC0-1.0", "EUPL-1.2"]) assert.deepEqual(licenceShows(spdx), { show: true }, spdx);
    const none = licenceShows(null);
    assert.equal(none.show, false);
    assert.match((none as { why: string }).why, /no licence: its authors keep every right/);
    const other = licenceShows("NOASSERTION");
    assert.match((other as { why: string }).why, /one GitHub could not identify/);
    assert.match((licenceShows("Proprietary-1") as { why: string }).why, /\(Proprietary-1\) is not one that lets others show its files/);
  });

  test("the file tree: nested lists, the current path open and marked, directories open without a script", () => {
    const entries = [entry("README.md"), entry("src", "tree"), entry("src/a.py"), entry("src/lib", "tree"), entry("src/lib/b.py"), entry("docs", "tree"), entry("docs/x.md")];
    const tree = fileTree(EEG, "main", entries, "src/lib/b.py");
    assert.equal(tree.tag, "nav");
    assert.equal(tree.attrs.class, "file-tree");
    const details = [...walk(tree)].filter((e) => e.tag === "details");
    const opened = details.filter((d) => d.attrs.open === "open").map((d) => textOf(d.children[0] as El));
    assert.deepEqual(opened, ["Files", "src/", "lib/"]);
    const current = [...walk(tree)].filter((e) => e.attrs["aria-current"] === "page");
    assert.deepEqual(current.map((e) => e.attrs.href), ["/r/oscr-fixture/eeg-analysis/blob/main/src/lib/b.py"]);
    assert.ok(hrefs(tree).includes("/r/oscr-fixture/eeg-analysis/tree/main/docs/"));
    assert.ok(hrefs(tree).includes("/r/oscr-fixture/eeg-analysis/blob/main/docs/x.md"), "a small repository's tree is whole");
  });
});

// ─── reading through the adapter, anonymously ────────────────────────────────

async function world() {
  const double = new MemoryBackend();
  const fake = new FakeGitHub(double, { id: "Iv23liFAKECLIENT", secret: "fake-client-secret" });
  const calls: string[] = [];
  const counting: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.host}${url.pathname}`);
    return fake.fetch(input, init);
  };
  const backend = githubBackend({}, { fetch: counting, now: () => double.now(), tokenCache: new Map() });
  const token = double.addUser("oscr-fixture").token();
  const as = double.session({ kind: "user", token });
  const repo = await as.repos.create({ name: "eeg-analysis", visibility: "public", autoInit: true });
  const head = await as.git.resolve(repo.ref, "main");
  await as.git.createCommit(repo.ref, {
    branch: "main",
    expectedHead: head,
    message: "Add the analysis",
    changes: [
      { op: "put", path: "analysis/preprocess.py", content: utf8("import numpy as np\n") },
      { op: "put", path: ".editorconfig", content: utf8("[*.py]\nindent_size = 2\n") },
    ],
  });
  const main = await as.git.resolve(repo.ref, "main");
  await as.git.createBranch(repo.ref, "feature/x", head);
  await as.git.createTag(repo.ref, { name: "v1.0", sha: main });
  const store = new Map<string, string>();
  const kv: KeyValueStore = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    get length() {
      return store.size;
    },
    key: (i) => [...store.keys()][i] ?? null,
  };
  const cache = gitCache(kv);
  const session = cachedSession(backend.session({ kind: "anonymous" }), cache);
  const info = await session.repos.get({ forge: "github", ...EEG });
  const env: CodeEnv = {
    repo: EEG,
    info,
    session,
    endpoints: { api: "https://api.github.com", raw: "https://raw.githubusercontent.com", web: "https://github.com" },
    site: "OSCR",
    target: { ...EEG, view: "tree", rest: ["main"] },
    search: "",
  };
  return { double, calls, env, head, main, store, cache };
}

describe("opening a ref, anonymously, on the reader's quota", () => {
  test("a branch whose name holds '/', a tag, a commit id; the tree read once per commit", async () => {
    const w = await world();
    const a = await openRef(w.env, ["feature", "x", "analysis"]);
    assert.equal(a.ref.ref, "feature/x");
    assert.equal(a.ref.kind, "branch");
    assert.equal(a.commit, w.head);
    assert.equal(a.ref.path, "analysis");
    const b = await openRef(w.env, ["main", "analysis", "preprocess.py"]);
    assert.equal(b.commit, w.main);
    assert.ok(entryAt(b.entries, "analysis/preprocess.py"));
    const t = await openRef(w.env, ["v1.0"]);
    assert.equal(t.ref.kind, "tag");
    assert.equal(t.commit, w.main);
    const c = await openRef(w.env, [w.main, "analysis"]);
    assert.equal(c.ref.kind, "commit");
    // The same commit's tree again, and the branches again: from the tab's cache.
    const before = w.calls.filter((x) => x.startsWith("api.github.com")).length;
    await openRef(w.env, ["main", "analysis"]);
    const after = w.calls.filter((x) => x.startsWith("api.github.com")).length;
    assert.equal(after, before, "no request to GitHub's API");
    assert.ok([...w.store.keys()].every((k) => k.startsWith(CACHE_PREFIX)));
    assert.ok(w.cache.hits >= 2);
  });

  test("an unknown ref is resolved by GitHub (one request), or not found", async () => {
    const w = await world();
    const r = await openRef(w.env, [w.head.slice(0, 40)]);
    assert.equal(r.commit, w.head);
    await assert.rejects(openRef(w.env, ["no-such-branch"]), (e: Error & { code?: string }) => e.code === "not_found" || e.code === "invalid");
  });

  test("the anonymous limit reached: a rate_limited error the view says in words", async () => {
    const w = await world();
    w.double.limit("anonymous", 0, w.double.now() + 600);
    await assert.rejects(openRef(w.env, ["main", "zzz"]), (e: Error & { code?: string }) => e.code === "rate_limited");
  });
});

describe("the tab's cache", () => {
  test("a store that refuses or is full loses the saving, never the answer", async () => {
    const refusing: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
      length: 0,
      key: () => null,
    };
    const cache = gitCache(refusing);
    let asked = 0;
    const ask = async () => ++asked;
    assert.equal(await cache.get("k", null, ask), 1);
    assert.equal(await cache.get("k", null, ask), 1, "kept in memory for the page");
    let now = 1000;
    const timed = gitCache(null, () => now);
    assert.equal(await timed.get("t", 100, ask), 2);
    now = 1050;
    assert.equal(await timed.get("t", 100, ask), 2);
    now = 1200;
    assert.equal(await timed.get("t", 100, ask), 3, "asked again once its time is over");
  });

  test("the pages use the cache (the shell wraps its anonymous session)", () => {
    const shell = readFileSync(new URL("../../src/scripts/repo-shell.ts", import.meta.url), "utf8");
    assert.match(shell, /cachedSession\(githubBackend\(endpoints/);
  });
});
