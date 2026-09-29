// The releases' pure library (night phase 07, E3; src/lib/releases.ts): addresses, the form's
// parameters, the order and the latest rule, the query, words, generated notes with
// `.github/release.yml` and the research sections, the changelog, export-ignore, a file's digest.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRepoPath, repoPath } from "../../src/lib/forge.ts";
import {
  changelogPath,
  changelogText,
  coAuthorLogins,
  digestVerdict,
  editReleasePath,
  exportIgnored,
  generateNotes,
  latestDownloadUrl,
  legacyLatest,
  matchRelease,
  newReleasePath,
  parseReleaseConfig,
  parseReleaseQuery,
  parseReleaseTarget,
  parseTies,
  previousTag,
  pullsInRange,
  releasePath,
  releasePrefill,
  releaseStates,
  RESEARCH_RELEASE_YML,
  sizeInWords,
  sortReleases,
  sourceArchives,
  tagsPath,
  type NotesPull,
} from "../../src/lib/releases.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada-fixture", name: "eeg" };
const actor = { id: "1", login: "ada-fixture", name: null } as unknown as T.Actor;

function rel(tag: string, o: Partial<T.Release> = {}): T.Release {
  return { id: tag, tagName: tag, target: "main", name: tag, body: "", draft: false, prerelease: false, immutable: false, author: actor, createdAt: "2026-09-01T00:00:00Z", publishedAt: "2026-09-01T00:00:00Z", assets: [], webUrl: "", ...o };
}

describe("addresses", () => {
  test("GitHub's shapes after /r/, the tag's slashes kept", () => {
    assert.deepEqual(parseReleaseTarget([]), { kind: "list" });
    assert.deepEqual(parseReleaseTarget(["tag", "paper", "v1"]), { kind: "tag", tag: "paper/v1" });
    assert.deepEqual(parseReleaseTarget(["edit", "v1.0.0"]), { kind: "edit", tag: "v1.0.0" });
    assert.deepEqual(parseReleaseTarget(["new"]), { kind: "new" });
    assert.deepEqual(parseReleaseTarget(["latest"]), { kind: "latest" });
    assert.deepEqual(parseReleaseTarget(["latest", "download", "data.csv"]), { kind: "latest-download", file: "data.csv" });
    assert.deepEqual(parseReleaseTarget(["download", "v1", "data.csv"]), { kind: "download", tag: "v1", file: "data.csv" });
    assert.deepEqual(parseReleaseTarget(["changelog"]), { kind: "changelog" });
    for (const bad of [["tag"], ["new", "x"], ["latest", "x"], ["download", "v1"], ["unknown"]]) assert.equal(parseReleaseTarget(bad), null, bad.join("/"));
    assert.equal(releasePath(REPO, "paper/v1"), "/r/ada-fixture/eeg/releases/tag/paper/v1");
    assert.equal(editReleasePath(REPO, "v1.0.0"), "/r/ada-fixture/eeg/releases/edit/v1.0.0");
    assert.equal(newReleasePath(REPO, { tag: "v2" }), "/r/ada-fixture/eeg/releases/new?tag=v2");
    assert.equal(changelogPath(REPO), "/r/ada-fixture/eeg/releases/changelog");
    assert.equal(tagsPath(REPO), "/r/ada-fixture/eeg/tags/");
    assert.equal(repoPath(REPO, "releases"), "/r/ada-fixture/eeg/releases/");
    assert.deepEqual(parseRepoPath("/r/ada-fixture/eeg/releases/tag/v1.0.0"), { owner: "ada-fixture", name: "eeg", view: "releases", rest: ["tag", "v1.0.0"] });
    assert.deepEqual(parseRepoPath("/r/ada-fixture/eeg/tags/"), { owner: "ada-fixture", name: "eeg", view: "tags", rest: [] });
    assert.equal(parseRepoPath("/r/ada-fixture/eeg/tags/x"), null);
  });

  test("the files, the archives and the feeds are GitHub's links", () => {
    assert.equal(latestDownloadUrl(REPO, "data set.csv"), "https://github.com/ada-fixture/eeg/releases/latest/download/data%20set.csv");
    assert.deepEqual(sourceArchives(REPO, "paper/v1"), {
      zip: "https://github.com/ada-fixture/eeg/archive/refs/tags/paper/v1.zip",
      tarball: "https://github.com/ada-fixture/eeg/archive/refs/tags/paper/v1.tar.gz",
    });
  });
});

test("the form's parameters: GitHub's and the registry's, checked, the text masked", () => {
  const p = releasePrefill("?tag=v1.2.0&target=main&title=Accepted%20code&body=Write%20to%20ada%40example.org&prerelease=1&doi=https://doi.org/10.1234/EEG.2026&paper_version=accepted");
  assert.deepEqual(p, { tag: "v1.2.0", target: "main", title: "Accepted code", body: "Write to [email hidden]", prerelease: true, doi: "10.1234/eeg.2026", paperVersion: "accepted" });
  assert.deepEqual(releasePrefill("?tag=a..b&target=x%20y&doi=11.2/x&paper_version=draft"), {});
});

describe("the list", () => {
  test("drafts first, then versions highest first, then the rest newest first; GitHub's legacy latest", () => {
    const items = [
      rel("paper-final", { publishedAt: "2026-09-20T00:00:00Z" }),
      rel("v1.0.0"),
      rel("v1.10.0"),
      rel("v2.0.0-rc.1", { prerelease: true }),
      rel("v1.2.0"),
      rel("v3.0.0", { draft: true, publishedAt: null }),
      rel("submitted", { publishedAt: "2026-08-01T00:00:00Z" }),
    ];
    assert.deepEqual(sortReleases(items).map((r) => r.tagName), ["v3.0.0", "v2.0.0-rc.1", "v1.10.0", "v1.2.0", "v1.0.0", "paper-final", "submitted"]);
    assert.equal(legacyLatest(items)?.tagName, "v1.10.0", "neither a draft nor a pre-release");
    assert.equal(previousTag("v1.10.0", items), "v1.2.0");
    assert.equal(previousTag("v2.0.0-rc.2", items), "v2.0.0-rc.1", "a pre-release compares with the pre-release before it");
    assert.equal(previousTag("v2.0.0", items), "v1.10.0", "a release skips the pre-releases");
    assert.equal(previousTag("v0.1.0", items), "paper-final", "no version below: the newest published");
  });

  test("the qualifiers and words; the registry's paper: and version:", () => {
    const ties = new Map([["v1.0.0", parseTies([{ tag: "v1.0.0", paper: { doi: "10.1234/eeg.2026", slug: "doi_10.1234_eeg.2026", title: "EEG" }, version: "accepted", label: "", status: "linked", commit: "a".repeat(40), shown: null, map: null, deposit: null }])]]);
    const items = [rel("v1.0.0", { body: "Figures 2 to 4" }), rel("v1.1.0-rc.1", { prerelease: true, createdAt: "2026-09-20T00:00:00Z" }), rel("v2.0.0", { draft: true, immutable: false })];
    const find = (q: string) => items.filter((r) => matchRelease(r, parseReleaseQuery(q).node, { latestId: "v1.0.0", ties })).map((r) => r.tagName);
    assert.deepEqual(find("figures"), ["v1.0.0"]);
    assert.deepEqual(find("prerelease:true"), ["v1.1.0-rc.1"]);
    assert.deepEqual(find("draft:false tag:v1"), ["v1.0.0", "v1.1.0-rc.1"]);
    assert.deepEqual(find("created:>=2026-09-10"), ["v1.1.0-rc.1"]);
    assert.deepEqual(find("is:latest"), ["v1.0.0"]);
    assert.deepEqual(find("doi:10.1234/EEG.2026"), ["v1.0.0"]);
    assert.deepEqual(find("version:accepted OR is:draft"), ["v1.0.0", "v2.0.0"]);
    assert.deepEqual(find("-tag:v1"), ["v2.0.0"]);
    assert.deepEqual(parseReleaseQuery("stars:5").errors, ["stars: is not a qualifier the registry reads."]);
    assert.deepEqual(releaseStates(rel("v1", { prerelease: true, immutable: true }), "v1"), [
      { words: "Latest", tone: "ok" },
      { words: "Pre-release", tone: "warning" },
      { words: "Immutable", tone: "ok" },
    ]);
    assert.deepEqual(releaseStates(rel("v2", { draft: true }), "v1"), [{ words: "Draft", tone: "warning" }]);
    assert.equal(sizeInWords(1), "1 byte");
    assert.equal(sizeInWords(1536), "1.5 KiB");
    assert.equal(sizeInWords(25 * 2 ** 20), "25 MiB");
  });

  test("the layer's ties are checked", () => {
    const [t] = parseTies([
      { tag: "v1", paper: { doi: "10.1/x", slug: null, title: null }, version: "published", label: "vor", status: "linked", commit: "b".repeat(40), shown: "c".repeat(64), map: { digest: "d".repeat(64), pairs: 3, commit: "e".repeat(40), at: 1 }, deposit: { doi: "10.5281/zenodo.9", record: "javascript:alert(1)" } },
      { tag: "v2", paper: { doi: "10.1/x" }, version: "draft" },
      "nothing",
    ]);
    assert.equal(t.map?.pairs, 3);
    assert.deepEqual(t.deposit, { doi: "10.5281/zenodo.9", record: null });
    assert.equal(parseTies([{ tag: "v2", paper: { doi: "10.1/x" }, version: "draft" }]).length, 0);
  });
});

describe("generated notes", () => {
  const pulls: NotesPull[] = [
    { number: 3, title: "Fix the random seed", author: "bob", labels: ["bug"] },
    { number: 4, title: "Hann window in band_power", author: "bob", labels: ["numerical difference"], coAuthors: ["ada-fixture"] },
    { number: 5, title: "Bump numpy", author: "dependabot", labels: ["dependencies"] },
    { number: 6, title: "Typo in the README (ask ada@example.org)", author: "cleo", labels: [] },
    { number: 7, title: "Internal", author: "bob", labels: ["ignore-for-release"] },
  ];

  test("GitHub's shape without a configuration; the registry's pages when it is known", () => {
    const text = generateNotes({ repo: REPO, tag: "v1.1.0", previousTag: "v1.0.0", pulls: pulls.slice(0, 1), config: null, site: "https://registry.test" });
    assert.equal(text, "## What's Changed\n* Fix the random seed by @bob in https://registry.test/r/ada-fixture/eeg/pull/3\n\n**Full Changelog**: https://registry.test/r/ada-fixture/eeg/compare/v1.0.0...v1.1.0/");
    const github = generateNotes({ repo: REPO, tag: "v1.1.0", previousTag: null, pulls: [], config: null });
    assert.equal(github, "## What's Changed\nNo pull request was merged in this range.");
  });

  test("the research release.yml: exclusions, categories in order, the catch-all; the research sections; co-authors credited; addresses masked", () => {
    const { config, problems } = parseReleaseConfig(RESEARCH_RELEASE_YML);
    assert.deepEqual(problems, []);
    assert.equal(config?.categories.length, 6);
    const text = generateNotes({
      repo: REPO,
      tag: "v1.1.0",
      previousTag: "v1.0.0",
      pulls,
      config,
      mapLinks: [{ paper: "A synthetic EEG study", paragraph: 14, section: "2.3 Filtering", path: "src/filter.py", start: 12, end: 18 }],
      research: [{ id: 12, title: "The filter's order is 4, the paper says 2", type: "mismatch" }],
    });
    assert.equal(
      text,
      [
        "## What's Changed",
        "### Changes that affect the results",
        "* Hann window in band_power by @bob, @ada-fixture in https://github.com/ada-fixture/eeg/pull/4",
        "### Fixes",
        "* Fix the random seed by @bob in https://github.com/ada-fixture/eeg/pull/3",
        "### Environment",
        "* Bump numpy by @dependabot in https://github.com/ada-fixture/eeg/pull/5",
        "### Other changes",
        "* Typo in the README (ask [email hidden]) by @cleo in https://github.com/ada-fixture/eeg/pull/6",
        "",
        "## For the paper",
        "### Tracing-map links whose lines changed (to look at again)",
        "* A synthetic EEG study: paragraph 14 (2.3 Filtering) ↔ `src/filter.py` lines 12–18",
        "### Research issues fixed",
        "* The filter's order is 4, the paper says 2 (code–paper mismatch): research#12",
        "",
        "**Full Changelog**: https://github.com/ada-fixture/eeg/compare/v1.0.0...v1.1.0",
      ].join("\n"),
    );
  });

  test("without a catch-all, the rest goes under Other Changes; category exclusions; problems said", () => {
    const { config, problems } = parseReleaseConfig(`changelog:
  exclude:
    authors: [dependabot]
  categories:
    - title: Fixes
      labels: [bug]
      exclude:
        authors: [bob]
    - title: Nameless
    - labels: [x]
`);
    assert.equal(problems.length, 2);
    const text = generateNotes({ repo: REPO, tag: "v2", previousTag: null, pulls, config });
    assert.ok(!text.includes("Bump numpy"));
    assert.match(text, /### Other Changes\n\* Fix the random seed/);
    assert.equal(parseReleaseConfig("not: yaml: [").config, null);
    assert.deepEqual(parseReleaseConfig("other: 1").problems, ["It has no “changelog” section."]);
  });

  test("the range's pull requests, by their merge commits; co-authors by their GitHub no-reply address only", () => {
    const pr = (n: number, merge: string | null, at: string) => ({ number: n, merged: merge !== null, mergeCommit: merge, mergedAt: at }) as unknown as T.PullRequest;
    const found = pullsInRange([pr(1, "a", "2026-09-02"), pr(2, "b", "2026-09-01"), pr(3, "z", "2026-09-03"), pr(4, null, "")], [{ sha: "a", message: "" }, { sha: "b", message: "" }]);
    assert.deepEqual(found.map((p) => p.number), [2, 1]);
    assert.deepEqual(coAuthorLogins(["Fix\n\nCo-authored-by: Ada <123+ada-fixture@users.noreply.github.com>\nCo-authored-by: Bob <bob@example.org>", "Co-authored-by: Cleo <cleo@users.noreply.github.com>"]), ["ada-fixture", "cleo"]);
  });
});

test("the changelog: every published release's notes, highest version first, masked", () => {
  const text = changelogText(REPO, [rel("v1.0.0", { body: "First. ada@example.org" }), rel("v1.1.0", { name: "Revision", body: "", publishedAt: "2026-09-20T00:00:00Z" }), rel("v2.0.0", { draft: true })]);
  assert.equal(text, "# Changelog of ada-fixture/eeg\n\n## [v1.1.0] — 2026-09-20\n\n**Revision**\n\nNo notes.\n\n## [v1.0.0] — 2026-09-01\n\nFirst. [email hidden]\n");
});

test("export-ignore and export-subst, as git archive reads them", () => {
  const attrs = "# archives\n/tests export-ignore\n*.ipynb export-ignore\ndocs/** export-ignore\ndocs/keep.md -export-ignore\nsrc/_version.py export-subst\n";
  const paths = ["tests/test_a.py", "src/tests/x.py", "nb/a.ipynb", "docs/a.md", "docs/keep.md", "src/_version.py", "src/a.py"];
  assert.deepEqual(exportIgnored(attrs, paths), { ignored: ["tests/test_a.py", "nb/a.ipynb", "docs/a.md"], substituted: ["src/_version.py"] });
});

test("a file checked against the asset's digest", () => {
  assert.equal(digestVerdict("ABC", "abc").same, true);
  assert.equal(digestVerdict("abc", "abd").same, false);
  assert.equal(digestVerdict("abc", null).same, null);
});
