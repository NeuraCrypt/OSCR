// Semantic versions (night phase 07, E3; src/lib/semver.ts): reading tags, semver 2.0's precedence,
// the next version and why, the tag: qualifier.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bump, changeKind, compareSemver, compareTags, formatSemver, nextVersions, parseSemver, sortTags, tagMatches } from "../../src/lib/semver.ts";

describe("reading a tag as a version", () => {
  test("strict versions, with or without v, pre-release and build", () => {
    assert.deepEqual(parseSemver("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: [], build: [], prefix: "v", loose: false });
    assert.deepEqual(parseSemver("1.0.0-rc.1+2026.09"), { major: 1, minor: 0, patch: 0, pre: ["rc", 1], build: ["2026", "09"], prefix: "", loose: false });
    assert.deepEqual(parseSemver("v2.0.0-alpha.beta")?.pre, ["alpha", "beta"]);
    assert.equal(formatSemver(parseSemver("v1.0.0-rc.1+b5")!), "v1.0.0-rc.1+b5");
  });

  test("loose versions (v1, v1.2) are read, and say so; the rest is no version", () => {
    assert.deepEqual(parseSemver("v1"), { major: 1, minor: 0, patch: 0, pre: [], build: [], prefix: "v", loose: true });
    assert.equal(parseSemver("2.4")?.minor, 4);
    for (const tag of ["paper-v1", "2026-09-28", "v1.2.3.4", "01.2.3", "v1.0.0-rc.01", "latest", "", "v"]) assert.equal(parseSemver(tag), null, tag);
  });
});

describe("precedence (semver 2.0 §11)", () => {
  test("the specification's own order", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    for (let i = 0; i + 1 < order.length; i++) assert.ok(compareSemver(parseSemver(order[i])!, parseSemver(order[i + 1])!) < 0, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareTags("v1.0.0+a", "1.0.0+b"), 0, "build metadata never counts");
    assert.equal(compareTags("v1", "paper"), null);
  });

  test("sorting tags: versions first, highest first; the others after, as given", () => {
    const tags = ["paper-final", "v1.0.0", "v1.10.0", "v1.2.0", "v2.0.0-rc.1", "submitted", "v2.0.0"];
    assert.deepEqual(sortTags(tags, (t) => t), ["v2.0.0", "v2.0.0-rc.1", "v1.10.0", "v1.2.0", "v1.0.0", "paper-final", "submitted"]);
  });
});

describe("the next version", () => {
  test("bumps: a pre-release goes to its release; a release's pre-release starts the next patch", () => {
    const v = (s: string) => parseSemver(s)!;
    assert.equal(formatSemver(bump(v("v1.2.3"), "patch")), "v1.2.4");
    assert.equal(formatSemver(bump(v("v1.2.3"), "minor")), "v1.3.0");
    assert.equal(formatSemver(bump(v("v1.2.3"), "major")), "v2.0.0");
    assert.equal(formatSemver(bump(v("v1.2.0-rc.2"), "minor")), "v1.2.0");
    assert.equal(formatSemver(bump(v("v2.0.0-rc.2"), "major")), "v2.0.0");
    assert.equal(formatSemver(bump(v("v1.2.0-rc.2"), "prerelease")), "v1.2.0-rc.3");
    assert.equal(formatSemver(bump(v("v1.2.3"), "prerelease")), "v1.2.4-rc.1");
    assert.equal(formatSemver(bump(v("1.0.0+build"), "patch")), "1.0.1");
  });

  test("what was merged decides, and each suggestion says why", () => {
    assert.equal(changeKind({ title: "Use a Hann window", labels: ["breaking-change"] }), "breaking");
    assert.equal(changeKind({ title: "feat!: new output format", labels: [] }), "breaking");
    assert.equal(changeKind({ title: "feat: add the figure 5 script", labels: [] }), "feature");
    assert.equal(changeKind({ title: "Fix the seed", labels: ["bug"] }), "fix");
    const breaking = nextVersions("v1.4.2", [{ title: "Change the band limits", labels: ["breaking"] }]);
    assert.deepEqual(breaking.map((s) => s.tag), ["v2.0.0", "v1.5.0", "v1.4.3", "v1.4.3-rc.1"]);
    assert.match(breaking[0].why, /breaks compatibility/);
    const early = nextVersions("0.3.1", [{ title: "x", labels: ["breaking-change"] }]);
    assert.equal(early[0].tag, "0.4.0", "under 1.0.0 a minor version says a breaking change");
    assert.equal(nextVersions("v1.0.0", [{ title: "feat: x", labels: [] }])[0].tag, "v1.1.0");
    assert.equal(nextVersions("v1.0.0")[0].tag, "v1.0.1");
    assert.deepEqual(nextVersions(null).map((s) => s.tag), ["v1.0.0", "v0.1.0"]);
    assert.deepEqual(nextVersions("paper-final").map((s) => s.tag), ["1.0.0", "0.1.0"]);
  });
});

test("the tag: qualifier matches a version's prefix, or a tag's text", () => {
  assert.ok(tagMatches("v1.2.3", "v1"));
  assert.ok(tagMatches("v1.2.3", "1.2"));
  assert.ok(!tagMatches("v1.2.3", "v1.3"));
  assert.ok(!tagMatches("v11.0.0", "v1"));
  assert.ok(tagMatches("paper-v2", "paper"));
  assert.ok(tagMatches("anything", ""));
});
