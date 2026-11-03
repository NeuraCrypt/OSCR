// Scientific tools (src/lib/scitools.ts): the committed manifests are whole (a malformed one would
// stop the build), the section stays within its fixed number of pages, its page's policy lets the
// viewer reach GitHub's raw files and nothing else, and nothing of the papers' pipeline reads it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { headersFor, parseHeaders } from "../src/lib/headers.ts";
import {
  blobUrl, languageOf, languagesOf, licenceFileOf, licenceOf, parseGithubUrl, problemsOf, rawUrl, readmeOf,
  SCITOOL_ORIGIN, SCITOOLS_MAX, slugOf, treeOf, type SciTool,
} from "../src/lib/scitools.ts";

const DIR = new URL("../src/scitools/", import.meta.url);
const names = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const tools = names.map((f) => [f, JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as SciTool] as const);

describe("the committed manifests", () => {
  it("are whole, one per repository and per slug, within SCITOOLS_MAX", () => {
    assert.ok(names.length <= SCITOOLS_MAX);
    for (const [f, t] of tools) assert.deepEqual(problemsOf(t, f), [], f);
    const repos = tools.map(([, t]) => t.repository.url.toLowerCase());
    assert.equal(new Set(repos).size, repos.length);
  });
  it("hold the first tool, evoparam, pinned", () => {
    const evo = tools.find(([, t]) => t.slug === "evoparam")?.[1];
    assert.ok(evo);
    assert.equal(evo.repository.url, "https://github.com/yannbellec/evoparam");
    assert.match(evo.commit, /^[0-9a-f]{40}$/);
    assert.equal(evo.licence.spdx, "Apache-2.0");
    assert.equal(evo.readme, "README.rst");
  });
});

describe("the manifest's rules", () => {
  const good: SciTool = {
    slug: "demo", name: "demo", description: "A demo.",
    repository: { host: "github", owner: "lab", name: "demo", url: "https://github.com/lab/demo" },
    commit: "a".repeat(40), committed_at: "2026-11-01T00:00:00Z", added: "2026-11-03",
    licence: { spdx: "MIT", file: "LICENSE" }, homepage: "", readme: "README.md",
    files: [
      { path: "README.md", size: 10, sha256: "b".repeat(64), lines: 1, language: "Markdown" },
      { path: "LICENSE", size: 10, sha256: "c".repeat(64), lines: 1, language: "Text" },
      { path: "src/a.py", size: 10, sha256: "d".repeat(64), lines: 3, language: "Python" },
    ],
    skipped: { binary: 0, large: 0, over_limit: 0 },
  };
  it("accept a whole manifest", () => assert.deepEqual(problemsOf(good, "demo.json"), []));
  it("refuse what would break a page or leak", () => {
    const bad = (patch: Partial<SciTool>) => problemsOf({ ...good, ...patch }, "demo.json").length > 0;
    assert.ok(bad({ slug: "Demo" }));
    assert.ok(bad({ commit: "main" }));
    assert.ok(bad({ description: "write to someone@example.org" }));
    assert.ok(bad({ description: `a ${String.fromCharCode(0x2014)} b` }));
    assert.ok(bad({ homepage: "javascript:alert(1)" }));
    assert.ok(bad({ repository: { ...good.repository, url: "https://evil.example/lab/demo" } }));
    assert.ok(bad({ files: [{ ...good.files[0], path: "../x" }] }));
    assert.ok(bad({ readme: "MISSING.md" }));
    assert.ok(problemsOf(good, "other.json").length > 0);
  });
});

describe("the helpers", () => {
  it("read a GitHub link as a person pastes it", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/yannbellec/evoparam"), { owner: "yannbellec", name: "evoparam" });
    assert.deepEqual(parseGithubUrl("github.com/a/b.git"), { owner: "a", name: "b" });
    assert.deepEqual(parseGithubUrl("https://github.com/a/b/"), { owner: "a", name: "b" });
    assert.equal(parseGithubUrl("https://gitlab.com/a/b"), null);
    assert.equal(parseGithubUrl("https://github.com/a"), null);
  });
  it("address files at the pinned commit, each part encoded", () => {
    const t = { repository: { host: "github" as const, owner: "a", name: "b", url: "https://github.com/a/b" }, commit: "f".repeat(40) };
    assert.equal(rawUrl(t, "x y/z#.py"), `${SCITOOL_ORIGIN}/a/b/${"f".repeat(40)}/x%20y/z%23.py`);
    assert.equal(blobUrl(t, "m.py"), `https://github.com/a/b/blob/${"f".repeat(40)}/m.py`);
  });
  it("name slugs, languages, readmes and licences", () => {
    assert.equal(slugOf("My_Tool.jl"), "my-tool-jl");
    assert.equal(languageOf("a/b.py"), "Python");
    assert.equal(languageOf("Makefile"), "Makefile");
    assert.equal(readmeOf(["docs/README.md", "README.rst", "README.md"]), "README.md");
    assert.equal(licenceFileOf(["src/LICENSE", "LICENSE.txt"]), "LICENSE.txt");
    assert.equal(licenceOf("Apache License\n Version 2.0, January 2004"), "Apache-2.0");
    assert.equal(licenceOf("Permission is hereby granted, free of charge, to any person"), "MIT");
    assert.equal(licenceOf("All rights reserved."), "");
  });
  it("lay the files out as folders", () => {
    const f = (path: string) => ({ path, size: 1, sha256: "0".repeat(64), lines: 1, language: languageOf(path) });
    const root = treeOf([f("b.py"), f("src/z.py"), f("src/a/x.py"), f("a.md")]);
    assert.deepEqual(root.files.map((x) => x.path), ["a.md", "b.py"]);
    assert.deepEqual(root.dirs.map((d) => d.path), ["src"]);
    assert.deepEqual(root.dirs[0].dirs.map((d) => d.path), ["src/a"]);
    assert.deepEqual(languagesOf([f("a.py"), f("b.md")]), [{ language: "Python", lines: 1 }]);
  });
});

describe("independent of the papers, and held to its policy", () => {
  it("the page connects to the site and GitHub's raw files only", () => {
    const rules = parseHeaders(readFileSync(new URL("../public/_headers", import.meta.url), "utf8"));
    const csp = headersFor(rules, "/scientific-tools/evoparam/").get("content-security-policy") ?? "";
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1].trim().split(/\s+/);
    assert.deepEqual(connect, ["'self'", SCITOOL_ORIGIN]);
    const list = headersFor(rules, "/scientific-tools/").get("content-security-policy") ?? "";
    assert.match(list, /connect-src 'self';/);
  });
  it("the export's copy step never touches its folder", () => {
    const data = readFileSync(new URL("../scripts/data.mjs", import.meta.url), "utf8");
    assert.ok(!data.includes("scitools"));
    assert.ok(!data.includes("scientific-tools"));
  });
});
