// The release pages' view trees and the drafts kept in the tab (night phase 07, E4;
// src/lib/release-view.ts, src/lib/release-stash.ts): states in words, the tie to a paper's version,
// the files with their digests (GitHub's links), the archives and why, a tag's row, the drafts a
// person saw.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseTies } from "../../src/lib/releases.ts";
import { checkRelease, repoOfPage, STASH_KEY, stashAnswer, stashedDrafts } from "../../src/lib/release-stash.ts";
import { archivesBlock, assetsTable, notesExcerpt, paperLink, releaseHead, releaseRow, statesLine, tagRow, tieBlock } from "../../src/lib/release-view.ts";
import { textOf, walk, type El } from "../../src/lib/repo-view.ts";
import type * as T from "../../worker/forge/types.ts";

const REPO = { owner: "ada-fixture", name: "eeg" };
const SHA = "a".repeat(40);
const actor = { id: "1", login: "ada-fixture", name: null } as unknown as T.Actor;
const rel = (o: Partial<T.Release> = {}): T.Release => ({ id: "9", tagName: "v1.0.0", target: SHA, name: "Accepted code", body: "", draft: false, prerelease: false, immutable: false, author: actor, createdAt: "2026-09-01T10:00:00Z", publishedAt: "2026-09-02T10:00:00Z", assets: [], webUrl: "", ...o });
const all = (e: El) => [...walk(e)];
const hrefs = (e: El) => all(e).map((x) => x.attrs.href).filter(Boolean);
const [TIE] = parseTies([
  { tag: "v1.0.0", paper: { doi: "10.1234/eeg.2026", slug: "doi_10.1234_eeg.2026", title: "A study (ada@example.org)" }, version: "accepted", label: "revision 2", status: "linked", commit: SHA, shown: null, map: { digest: "d".repeat(64), pairs: 2, commit: "b".repeat(40), at: 1 }, deposit: { doi: "10.5281/zenodo.9", record: null } },
]);

describe("the list and the head", () => {
  test("a row: the title linked, the states in words, the code at its commit, the paper's version", () => {
    const row = releaseRow(REPO, rel({ prerelease: true }), "9", [TIE], "Figures 2 to 4.");
    const text = textOf(row);
    assert.match(text, /Accepted code Latest · Pre-release/);
    assert.match(text, /Tag v1\.0\.0 at commit aaaaaaa · published 2026-09-02 by ada-fixture/);
    assert.match(text, /Goes with the accepted manuscript \(revision 2\) of A study \(\[email hidden\]\)/);
    assert.ok(!text.includes("ada@example.org"));
    assert.deepEqual(hrefs(row), ["/r/ada-fixture/eeg/releases/tag/v1.0.0", "/r/ada-fixture/eeg/tree/v1.0.0/", `/r/ada-fixture/eeg/commit/${SHA}/`, "/paper/doi_10.1234_eeg.2026/"]);
    const states = all(row).filter((x) => x.attrs.class?.startsWith("state "));
    assert.deepEqual(states.map((s) => [textOf(s), s.attrs.class]), [["Latest", "state ok"], ["Pre-release", "state warning"]]);
    assert.ok(!all(row).some((x) => /pill|badge/.test(x.attrs.class ?? "")));
  });

  test("a draft: not linked (GitHub shows it to writers only), its edit link, the tag made at publication", () => {
    const row = releaseRow(REPO, rel({ draft: true, publishedAt: null, target: "main" }), null, [], "");
    assert.match(textOf(row), /Draft/);
    assert.match(textOf(row), /from main \(GitHub makes the tag when the draft is published\)/);
    assert.ok(hrefs(row).includes("/r/ada-fixture/eeg/releases/edit/v1.0.0"));
    assert.ok(!hrefs(row).includes("/r/ada-fixture/eeg/releases/tag/v1.0.0"));
  });

  test("the head says an immutable release's rule; the excerpt is text", () => {
    assert.match(textOf(releaseHead(REPO, rel({ immutable: true }), null, SHA)), /Immutable.*GitHub keeps its tag and its files as they are/s);
    assert.equal(notesExcerpt("## What's Changed\n* Fix by @bob in [#3](https://x)\n```\ncode\n```\nMail ada@example.org"), "What's Changed Fix by @bob in #3 Mail [email hidden]");
    assert.equal(statesLine([]), null);
  });
});

test("the tie: the version, the map versioned with its commit, the real Zenodo's DOI, the Mac's words", () => {
  const els = tieBlock([TIE], [{ kind: "deposit", paper: "10.1234/eeg.2026", outcome: "done", message: "Deposited, ada@example.org" }], [{ kind: "archive" }]);
  const text = els.map(textOf).join("\n");
  assert.match(text, /It goes with the accepted manuscript \(revision 2\) of A study/);
  assert.match(text, /versioned with it: digest dddddddddddd, 2 paragraph–line pairs in this repository; the map's lines are at commit bbbbbbb, the release at aaaaaaa\./);
  assert.match(text, /Zenodo DOI: 10\.5281\/zenodo\.9/);
  assert.match(text, /Zenodo: Deposited, \[email hidden\]/);
  assert.match(text, /not answered yet: software heritage/);
  assert.deepEqual(els.flatMap(hrefs), ["/paper/doi_10.1234_eeg.2026/", "https://doi.org/10.5281/zenodo.9"]);
  assert.match(textOf(tieBlock([])[1]), /tied to no version of a paper yet/);
  assert.equal(textOf(paperLink({ paper: { doi: "10.1/x", slug: null, title: null } }) as El), "doi:10.1/x");
});

test("the files: GitHub's links, sizes, digests, GitHub's counts; the archives and why", () => {
  const assets: T.ReleaseAsset[] = [{ id: "5", name: "figure 2.csv", label: "Source data", contentType: "text/csv", size: 2048, downloads: 3, downloadUrl: "https://evil.example/x", createdAt: "2026-09-02T00:00:00Z", digest: "e".repeat(64) }];
  const table = assetsTable(REPO, "v1.0.0", assets);
  assert.deepEqual(hrefs(table), ["https://github.com/ada-fixture/eeg/releases/download/v1.0.0/figure%202.csv"], "never the answer's own address");
  assert.match(textOf(table), /figure 2\.csv Source data.*2\.0 KiB.*eeeeeeeeeeeeeeee….*downloaded 3 times.*2026-09-02/s);
  assert.equal(textOf(assetsTable(REPO, "v1", [])), "No file is attached to this release.");
  const archives = archivesBlock(REPO, "v1.0.0");
  assert.deepEqual(archives.flatMap(hrefs), ["https://github.com/ada-fixture/eeg/archive/refs/tags/v1.0.0.zip", "https://github.com/ada-fixture/eeg/archive/refs/tags/v1.0.0.tar.gz"]);
  assert.match(textOf(archives[1]), /may change/);
});

test("a tag's row: its commit, its kind, its release or a link to draft one", () => {
  const row = tagRow(REPO, { name: "paper-v1", sha: SHA, annotation: { sha: "c".repeat(40), message: "Submitted", tagger: null } }, null);
  assert.match(textOf(row), /paper-v1.*aaaaaaa.*annotated: Submitted.*Draft a release from it.*zip · tar\.gz/s);
  assert.ok(hrefs(row).includes("/r/ada-fixture/eeg/releases/new?tag=paper-v1"));
  assert.match(textOf(tagRow(REPO, { name: "v1", sha: SHA, annotation: null }, rel({ tagName: "v1" }))), /lightweight.*Accepted code/s);
});

describe("the drafts kept in the tab", () => {
  function memory(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } as unknown as Storage & { data: Map<string, string> };
  }
  const view = (o: Record<string, unknown> = {}) => ({ id: "11", tag: "v2.0.0", target: SHA, name: "Next", body: "Draft notes", draft: true, prerelease: false, immutable: false, createdAt: "2026-09-10T00:00:00Z", publishedAt: null, assets: [], ...o });

  test("the drafts GitHub showed, then one saved, one published, one deleted", () => {
    const s = memory();
    stashAnswer("release_drafts", { repo: "Ada-Fixture/EEG", drafts: [view(), view({ id: "12", tag: "v3", draft: false })] }, s, 100);
    assert.deepEqual(stashedDrafts(REPO, s)?.drafts.map((d) => d.tag), ["v2.0.0"], "a published one is no draft");
    stashAnswer("release_create", { page: "/r/ada-fixture/eeg/releases/", release: view({ id: "13", tag: "v2.1.0" }) }, s, 101);
    assert.deepEqual(stashedDrafts(REPO, s)?.drafts.map((d) => d.tag), ["v2.1.0", "v2.0.0"]);
    stashAnswer("release_edit", { page: "/r/ada-fixture/eeg/releases/tag/v2.0.0", release: view({ draft: false }) }, s, 102);
    assert.deepEqual(stashedDrafts(REPO, s)?.drafts.map((d) => d.tag), ["v2.1.0"]);
    stashAnswer("release_delete", { page: "/r/ada-fixture/eeg/releases/", id: "13" }, s, 103);
    assert.deepEqual(stashedDrafts(REPO, s)?.drafts, []);
    stashAnswer("commit", { page: "/r/ada-fixture/eeg/", release: view() }, s, 104);
    assert.deepEqual(stashedDrafts(REPO, s)?.drafts, [], "another kind's answer is not a release");
    assert.deepEqual(Object.keys(JSON.parse(s.data.get(STASH_KEY) ?? "{}")), ["ada-fixture/eeg"], "kept by repository, in lower case");
  });

  test("checked: a bad id, a bad digest, an unknown page; a storage that refuses", () => {
    assert.equal(checkRelease({ id: "x", tag: "v1" }), null);
    assert.equal(checkRelease({ id: "1", tag: "v1", assets: [{ id: "2", name: "a", digest: "not-hex" }] })?.assets[0].digest, null);
    assert.equal(repoOfPage("/research/1"), null);
    assert.equal(repoOfPage("/r/ada/eeg/releases/"), "ada/eeg");
    const refusing = { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => undefined } as unknown as Storage;
    stashAnswer("release_drafts", { repo: "ada/eeg", drafts: [view()] }, refusing, 1);
    assert.equal(stashedDrafts(REPO, null), null);
  });
});
