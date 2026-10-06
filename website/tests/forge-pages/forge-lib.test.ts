// The GitHub side's browser library (src/lib/forge.ts): the URL scheme of the repository pages,
// git's commands and GitHub's own addresses (never one of the registry's: D00-3), the static
// layer's shards (the same numbers as the Mac's: tests/fixtures/forge-shards.json), and the body
// of one authorized action's start.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  apiStart,
  backPath,
  cloneCommands,
  cloneUrl,
  codespacesUrl,
  desktopUrl,
  GITHUB,
  isOwner,
  isRepoName,
  LAYER_SHARDS,
  layerShard,
  layerUrl,
  isPathSegment,
  parseRepoPath,
  type RepoView,
  viewPath,
  payloadText,
  repoPath,
  repoWebUrl,
  sha256Hex,
  tokenTemplateUrl,
  TOKEN_PAGE,
  zipUrl,
} from "../../src/lib/forge.ts";
import { ACTION_KINDS } from "../../worker/forge/service/types.ts";

const EEG = { owner: "oscr-fixture", name: "eeg-analysis" };

describe("the URL scheme of the repository pages", () => {
  test("parse and build round trip, for every view", () => {
    for (const repo of [EEG, { owner: "Ada", name: "My.Repo_2" }, { owner: "a", name: "b" }, { owner: "lab-ror", name: ".github" }]) {
      for (const view of ["home", "settings", "branches"] as const) {
        const path = repoPath(repo, view);
        assert.deepEqual(parseRepoPath(path), { ...repo, view }, path);
      }
    }
    assert.equal(repoPath(EEG), "/r/oscr-fixture/eeg-analysis/");
    assert.equal(repoPath(EEG, "settings"), "/r/oscr-fixture/eeg-analysis/settings/");
    assert.equal(repoPath(EEG, "branches"), "/r/oscr-fixture/eeg-analysis/branches/");
    // The final "/" is optional; the case is kept (GitHub's paths are case-insensitive).
    assert.deepEqual(parseRepoPath("/r/Ada/EEG"), { owner: "Ada", name: "EEG", view: "home" });
    assert.deepEqual(parseRepoPath("/r/ada/eeg/settings"), { owner: "ada", name: "eeg", view: "settings" });
  });

  test("the code views of phase 02 carry their segments (D02-1)", () => {
    const cases: [string, RepoView, string[], string][] = [
      ["/r/oscr-fixture/eeg-analysis/tree/main/", "tree", ["main"], "/r/oscr-fixture/eeg-analysis/tree/main/"],
      ["/r/oscr-fixture/eeg-analysis/tree/feature/x/src/", "tree", ["feature", "x", "src"], "/r/oscr-fixture/eeg-analysis/tree/feature/x/src/"],
      ["/r/oscr-fixture/eeg-analysis/blob/main/analysis/preprocess.py", "blob", ["main", "analysis", "preprocess.py"], "/r/oscr-fixture/eeg-analysis/blob/main/analysis/preprocess.py"],
      ["/r/oscr-fixture/eeg-analysis/blob/main/a%20b%23c.txt", "blob", ["main", "a b#c.txt"], "/r/oscr-fixture/eeg-analysis/blob/main/a%20b%23c.txt"],
      ["/r/oscr-fixture/eeg-analysis/commits/", "commits", [], "/r/oscr-fixture/eeg-analysis/commits/"],
      ["/r/oscr-fixture/eeg-analysis/commits/main/README.md", "commits", ["main", "README.md"], "/r/oscr-fixture/eeg-analysis/commits/main/README.md/"],
      ["/r/oscr-fixture/eeg-analysis/commit/0123456789abcdef0123456789abcdef01234567", "commit", ["0123456789abcdef0123456789abcdef01234567"], "/r/oscr-fixture/eeg-analysis/commit/0123456789abcdef0123456789abcdef01234567/"],
      ["/r/oscr-fixture/eeg-analysis/compare/v1.0...main/", "compare", ["v1.0...main"], "/r/oscr-fixture/eeg-analysis/compare/v1.0...main/"],
      ["/r/oscr-fixture/eeg-analysis/find/main/", "find", ["main"], "/r/oscr-fixture/eeg-analysis/find/main/"],
      ["/r/oscr-fixture/eeg-analysis/search/", "search", [], "/r/oscr-fixture/eeg-analysis/search/"],
      // Phase 03: GitHub's editing shapes.
      ["/r/oscr-fixture/eeg-analysis/edit/main/analysis.py", "edit", ["main", "analysis.py"], "/r/oscr-fixture/eeg-analysis/edit/main/analysis.py"],
      ["/r/oscr-fixture/eeg-analysis/new/main/", "new", ["main"], "/r/oscr-fixture/eeg-analysis/new/main/"],
      ["/r/oscr-fixture/eeg-analysis/new/main/docs", "new", ["main", "docs"], "/r/oscr-fixture/eeg-analysis/new/main/docs/"],
      ["/r/oscr-fixture/eeg-analysis/upload/main/data/", "upload", ["main", "data"], "/r/oscr-fixture/eeg-analysis/upload/main/data/"],
      ["/r/oscr-fixture/eeg-analysis/delete/main/docs/old.md", "delete", ["main", "docs", "old.md"], "/r/oscr-fixture/eeg-analysis/delete/main/docs/old.md"],
      // Phase 05: GitHub's issue shapes.
      ["/r/oscr-fixture/eeg-analysis/issues", "issues", [], "/r/oscr-fixture/eeg-analysis/issues/"],
      ["/r/oscr-fixture/eeg-analysis/issues/12", "issues", ["12"], "/r/oscr-fixture/eeg-analysis/issues/12"],
      ["/r/oscr-fixture/eeg-analysis/issues/new/choose", "issues", ["new", "choose"], "/r/oscr-fixture/eeg-analysis/issues/new/choose"],
      ["/r/oscr-fixture/eeg-analysis/labels", "labels", [], "/r/oscr-fixture/eeg-analysis/labels/"],
      ["/r/oscr-fixture/eeg-analysis/milestones/", "milestones", [], "/r/oscr-fixture/eeg-analysis/milestones/"],
      ["/r/oscr-fixture/eeg-analysis/milestone/3", "milestone", ["3"], "/r/oscr-fixture/eeg-analysis/milestone/3"],
    ];
    for (const [path, view, rest, canonical] of cases) {
      const parsed = parseRepoPath(path);
      assert.deepEqual(parsed, { ...EEG, view, rest }, path);
      assert.equal(viewPath(EEG, parsed!), canonical, path);
      assert.deepEqual(parseRepoPath(canonical), parsed, canonical);
    }
    assert.throws(() => repoPath(EEG, "blob", ["main", ".."]));
    assert.equal(isPathSegment("a/b"), false);
    assert.equal(isPathSegment("..."), true);
  });

  test("anything else is not a repository page", () => {
    for (const path of [
      "/r/", "/r/ada/", "/r/ada", "/repositories/", "/x/ada/eeg/", "r/ada/eeg/",
      "/r/ada/eeg/home/", "/r/ada/eeg/wiki/", "/r/ada/eeg/settings/x/", "/r/ada/eeg/tree/", "/r/ada/eeg/blob/main/",
      "/r/ada/eeg/commit/", "/r/ada/eeg/commit/a/b/", "/r/ada/eeg/search/x/", "/r/ada/eeg/tree/main/../x/", "/r/ada/eeg/blob/main/a%2Fb",
      "/r/ada/eeg/blob/main/a%00b", "/r/ada/eeg/tree/main/./x/", "/r/ada/eeg/issues/1/2/3", "/r/ada/eeg/milestone/", "/r/ada/eeg/labels/x",
      "/r/ada/eeg.git/", "/r/../eeg/", "/r/ada/../", "/r/a%2Fb/eeg/", "/r/ada/e%20g/", "/r/ada/%E0%A4%A/",
      `/r/${"a".repeat(101)}/eeg/`, "/r/ada/e<script>/",
    ]) {
      assert.equal(parseRepoPath(path), null, path);
    }
    assert.throws(() => repoPath({ owner: "a/b", name: "c" }));
    assert.throws(() => repoPath({ owner: "a", name: "c.git" }));
    assert.equal(isOwner("oscr-fixture"), true);
    assert.equal(isOwner(".."), false);
    assert.equal(isRepoName("x.git"), false);
    assert.equal(isRepoName("x.github"), true);
  });
});

describe("git and GitHub's own addresses", () => {
  test("the clone commands: https, partial, shallow, all to github.com", () => {
    assert.equal(cloneUrl(EEG), "https://github.com/oscr-fixture/eeg-analysis.git");
    assert.deepEqual(cloneCommands(EEG), {
      https: "git clone https://github.com/oscr-fixture/eeg-analysis.git",
      partial: "git clone --filter=blob:none https://github.com/oscr-fixture/eeg-analysis.git",
      shallow: "git clone --depth 1 https://github.com/oscr-fixture/eeg-analysis.git",
    });
    // Nothing that is not a checked name reaches a command.
    assert.throws(() => cloneCommands({ owner: "a;rm -rf ~", name: "b" }));
    assert.throws(() => cloneCommands({ owner: "a", name: "$(id)" }));
  });

  test("ZIP, GitHub Desktop, Codespaces: GitHub's links", () => {
    assert.equal(repoWebUrl(EEG), "https://github.com/oscr-fixture/eeg-analysis");
    assert.equal(zipUrl(EEG), "https://github.com/oscr-fixture/eeg-analysis/archive/HEAD.zip");
    assert.equal(zipUrl(EEG, "main"), "https://github.com/oscr-fixture/eeg-analysis/archive/refs/heads/main.zip");
    assert.equal(zipUrl(EEG, "feature/a b"), "https://github.com/oscr-fixture/eeg-analysis/archive/refs/heads/feature/a%20b.zip");
    assert.equal(desktopUrl(EEG), "x-github-client://openRepo/https://github.com/oscr-fixture/eeg-analysis");
    assert.equal(codespacesUrl(EEG), "https://codespaces.new/oscr-fixture/eeg-analysis");
    for (const url of [zipUrl(EEG), desktopUrl(EEG), codespacesUrl(EEG), cloneUrl(EEG)]) {
      const host = new URL(url.replace("x-github-client://openRepo/", "")).host;
      assert.ok(host === "github.com" || host === "codespaces.new", url);
    }
  });

  test("the token template: GitHub's pre-filled fine-grained token page, one repository, Contents write, an expiry", () => {
    const url = new URL(tokenTemplateUrl(EEG));
    assert.equal(`${url.origin}${url.pathname}`, TOKEN_PAGE);
    assert.equal(url.origin, GITHUB);
    const q = url.searchParams;
    assert.equal(q.get("target_name"), "oscr-fixture");
    assert.equal(q.get("contents"), "write");
    assert.equal(q.get("expires_in"), "30");
    assert.ok((q.get("name") ?? "").length <= 40 && q.get("name")?.includes("eeg-analysis"));
    assert.match(q.get("description") ?? "", /Only select repositories/);
    assert.match(q.get("description") ?? "", /oscr-fixture\/eeg-analysis/);
    assert.ok((q.get("description") ?? "").length <= 1024);
    // Nothing else: no other permission, no address of the registry.
    assert.deepEqual([...q.keys()].sort(), ["contents", "description", "expires_in", "name", "target_name"]);
    assert.ok(!/workers\.dev|localhost/.test(url.toString()));
    assert.equal(new URL(tokenTemplateUrl(EEG, 1000)).searchParams.get("expires_in"), "366");
    assert.equal(new URL(tokenTemplateUrl(EEG, 0)).searchParams.get("expires_in"), "1");
    const long = new URL(tokenTemplateUrl({ owner: "a", name: "x".repeat(100) })).searchParams.get("name") ?? "";
    assert.equal(long.length, 40);
  });
});

describe("OSCR's static layer", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/forge-shards.json", import.meta.url), "utf8")) as { pairs: [string, string][] };

  test("layerShard matches the pairs the Mac must match (tests/fixtures/forge-shards.json)", async () => {
    assert.ok(fixture.pairs.length >= 10);
    for (const [path, shard] of fixture.pairs) {
      const [owner, name] = path.split("/");
      assert.equal(await layerShard(owner, name), shard, path);
    }
  });

  test("two digits, below 64, the case ignored, as SHA-256's first byte says", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const shard = await layerShard(`owner${i}`, `Repo-${i}`);
      assert.match(shard, /^\d{2}$/);
      assert.ok(Number(shard) < LAYER_SHARDS);
      const digest = createHash("sha256").update(`owner${i}/repo-${i}`).digest();
      assert.equal(Number(shard), digest[0] % 64);
      seen.add(shard);
    }
    assert.ok(seen.size > 50, "the shards are spread");
    assert.equal(await layerShard("OSCR-Fixture", "EEG-Analysis"), await layerShard("oscr-fixture", "eeg-analysis"));
    assert.equal(layerUrl("07"), "/forge/layer/07.json");
  });
});

describe("one authorized action: the start's body", () => {
  test("the digest is the SHA-256 of the payload's exact text, which the page keeps", async () => {
    const payload = { name: "eeg-analysis", description: "Code for the EEG study", papers: ["doi:10.5555/oscr.fixture.1"] };
    const { body, payload: text } = await apiStart({
      kind: "create",
      repo: null,
      payload,
      back: "/new/",
    });
    assert.equal(text, JSON.stringify(payload));
    assert.equal(text, payloadText(payload));
    assert.equal(body.digest, createHash("sha256").update(text, "utf8").digest("hex"));
    assert.equal(body.digest, await sha256Hex(text));
    assert.deepEqual(body, { kind: "create", repo: null, branch: null, expectedHead: null, digest: body.digest, back: "/new/" });
    // The payload itself never goes to the start.
    assert.ok(!JSON.stringify(body).includes("Code for the EEG study"));
    const branch = await apiStart({
      kind: "branch_delete",
      repo: { forge: "github", id: "101" },
      branch: "old",
      expectedHead: "a".repeat(40),
      payload: { branch: "old" },
      back: "/r/ada/eeg/branches/",
      install: true,
    });
    assert.deepEqual(branch.body.repo, { forge: "github", id: "101" });
    assert.equal(branch.body.branch, "old");
    assert.equal(branch.body.install, true);
    assert.ok(ACTION_KINDS.includes(branch.body.kind));
  });

  test("the page to come back to is a page of this site", () => {
    assert.equal(backPath("/r/ada/eeg/settings/"), "/r/ada/eeg/settings/");
    for (const bad of ["https://evil.example/", "//evil.example/", "/api/forge/act", "javascript:alert(1)", "/a?b=c", "", 7, null, `/${"a".repeat(300)}`]) {
      assert.equal(backPath(bad), "/repositories/", String(bad));
    }
  });
});
