// The social pages' pure part (night phase 08, E5; src/lib/social.ts): the shards match the Mac's; the
// addresses of what one stars and follows are this site's; the inbox's filters and views; a list as
// references; the calendar; the identicon without an image.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { textOf, walk } from "../../src/lib/repo-view.ts";
import {
  bibtex,
  calendar,
  calendarView,
  groupThreads,
  hueOf,
  identiconCells,
  identiconView,
  inView,
  levelOf,
  matchesThread,
  parseInboxQuery,
  parsePersonPath,
  personUrl,
  ris,
  socialShard,
  subjectHref,
  subjectWords,
  targetHref,
  targetWords,
  type Thread,
} from "../../src/lib/social.ts";

const thread = (over: Partial<Thread> = {}): Thread => ({
  key: "repo:github:1#issue:3",
  subject: "repo:github:1",
  thread: "issue:3",
  words: "issue #3",
  title: "The filter's order",
  url: "/r/lab/eeg/issues/3",
  repo: "lab/eeg",
  paper: null,
  latest: { kind: "issue_comment", words: "commented on the issue", at: 1_790_596_800, actor: "bob-fixture" },
  count: 1,
  reason: "subscribed",
  reasonWords: "You watch the repository",
  unread: true,
  done: false,
  saved: false,
  ...over,
});

describe("the social layer's addresses", () => {
  it("the shards are the Mac's (the same pairs on both sides)", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/social-shards.json", import.meta.url), "utf8")) as { pairs: [string, string][] };
    for (const [key, shard] of fixture.pairs) assert.equal(await socialShard(key), shard, key);
  });

  it("a person's page by GitHub login or ORCID iD; anything else names nobody", () => {
    assert.equal(parsePersonPath("/u/Ada-Fixture/"), "ada-fixture");
    assert.equal(parsePersonPath("/u/0000-0002-1825-009x"), "0000-0002-1825-009X");
    for (const bad of ["/u/", "/u/a--b/", "/u/-x/", "/u/a/b/", "/u/%E0%A4%A/"]) assert.equal(parsePersonPath(bad), null, bad);
    assert.equal(personUrl("Alex"), "/u/alex/");
    assert.equal(personUrl("0000-0002-1825-009x"), "/u/0000-0002-1825-009X/");
  });

  it("subjects and targets link to this site's pages, in words", () => {
    assert.equal(subjectHref("repo:github:1", "lab/eeg"), "/r/lab/eeg/");
    assert.equal(subjectHref("repo:github:1", "javascript:x"), null);
    assert.equal(subjectHref("paper:doi:10.1234/eeg.2026"), "/lookup/?doi=10.1234%2Feeg.2026");
    assert.equal(subjectHref("topic:eeg"), "/explore/?topic=eeg");
    assert.equal(subjectWords("paper:doi:10.1/x"), "doi:10.1/x");
    assert.equal(targetHref("orcid:0000-0002-1825-0097"), "/u/0000-0002-1825-0097/");
    assert.equal(targetHref("github:9", "ada-fixture"), "/u/ada-fixture/");
    assert.equal(targetHref("github:9", "<script>"), null);
    assert.equal(targetHref("owner:github:lab"), "/search/?type=repositories&q=user%3Alab");
    assert.equal(targetHref("category:modality/eeg"), "/browse/modality/eeg/");
    assert.equal(targetHref("thread:repo:github:1#issue:3"), null);
    assert.equal(targetWords("orcid:0000-0002-1825-0097", "Josiah Carberry"), "the author Josiah Carberry");
  });
});

describe("the inbox", () => {
  it("GitHub's filters and the registry's: repo:, org:, author:, is:, reason:, words", () => {
    const f = parseInboxQuery("repo:lab/eeg is:unread is:issue reason:subscribed filter nonsense:x");
    assert.deepEqual([f.repo, f.is, f.reason, f.words, f.unknown], ["lab/eeg", ["unread", "issue"], ["subscribed"], ["filter"], ["nonsense:x"]]);
    assert.ok(matchesThread(thread(), f));
    assert.ok(!matchesThread(thread({ unread: false }), f));
    assert.ok(!matchesThread(thread(), parseInboxQuery("org:neuro")));
    assert.ok(matchesThread(thread(), parseInboxQuery("author:bob-fixture")));
    assert.ok(matchesThread(thread({ repo: null, paper: "10.1/x", thread: "research:1" }), parseInboxQuery("is:research is:paper")));
  });

  it("the views: Inbox is what is not done, Saved stays saved, Read is read and not done", () => {
    const t = [thread(), thread({ key: "b", unread: false }), thread({ key: "c", done: true, unread: false, saved: true })];
    assert.deepEqual(t.filter((x) => inView(x, "inbox")).map((x) => x.key), ["repo:github:1#issue:3", "b"]);
    assert.deepEqual(t.filter((x) => inView(x, "unread")).map((x) => x.key), ["repo:github:1#issue:3"]);
    assert.deepEqual(t.filter((x) => inView(x, "saved")).map((x) => x.key), ["c"]);
    assert.deepEqual(t.filter((x) => inView(x, "done")).map((x) => x.key), ["c"]);
    assert.deepEqual(t.filter((x) => inView(x, "read")).map((x) => x.key), ["b"]);
    assert.deepEqual(groupThreads([thread(), thread({ key: "p", repo: null, paper: "10.1/x" })]).map((g) => g.label), ["lab/eeg", "doi:10.1/x"]);
  });
});

describe("a list as references", () => {
  it("BibTeX and RIS: papers by DOI, repositories by their page here; topics are no reference", () => {
    const items = [
      { subject: "paper:doi:10.1234/eeg.2026", title: "Filtering EEG {before} epoching & more" },
      { subject: "repo:github:1", name: "lab/eeg" },
      { subject: "topic:eeg" },
    ];
    const bib = bibtex(items, "https://oscr.example");
    assert.match(bib, /@article\{doi_10_1234_eeg_2026,\n  title = \{Filtering EEG before epoching \\& more\},\n  doi = \{10.1234\/eeg.2026\}/);
    assert.match(bib, /@software\{lab_eeg,\n  title = \{lab\/eeg\},\n  url = \{https:\/\/oscr.example\/r\/lab\/eeg\/\}/);
    assert.ok(!bib.includes("topic"));
    const r = ris(items, "https://oscr.example");
    assert.match(r, /^TY {2}- JOUR\r\nTI {2}- Filtering EEG \{before\} epoching & more\r\nDO {2}- 10.1234\/eeg.2026\r\n/);
    assert.match(r, /TY {2}- COMP\r\nTI {2}- lab\/eeg\r\nUR {2}- https:\/\/oscr.example\/r\/lab\/eeg\/\r\nER {2}- \r\n$/);
  });
});

describe("the calendar and the identicon", () => {
  it("a year in weeks, Sunday first; levels from the counts; the publications as dots", () => {
    const c = calendar({ "2026-09-28": 3, "2026-09-01": 9 }, ["2026-09-15", "2026-09-15", "bad"], "2026-09-28");
    assert.equal(c.total, 12);
    assert.equal(c.published, 2);
    assert.ok(c.weeks.every((w) => w.length <= 7));
    const days = c.weeks.flat().filter((d) => d !== null);
    assert.equal(days.length, 365);
    assert.equal(days.at(-1)?.day, "2026-09-28");
    assert.equal(days.at(-1)?.level, 2);
    assert.deepEqual([0, 1, 2, 5, 12].map(levelOf), [0, 1, 2, 3, 4]);
    const view = calendarView(c);
    const cells = [...walk(view)].filter((e) => e.tag === "td");
    assert.ok(cells.some((e) => e.attrs.class === "level-4"));
    assert.ok(cells.some((e) => (e.attrs.class ?? "").includes("published") && textOf(e) === "•"));
    assert.ok(cells.every((e) => !("style" in e.attrs)));
  });

  it("the identicon: 5 × 5 cells, mirrored, stable, a hue by class", async () => {
    const a = await identiconCells("ada-fixture");
    assert.deepEqual(a, await identiconCells("Ada-Fixture"));
    assert.ok(a.every((row) => row.length === 5 && row[0] === row[4] && row[1] === row[3]));
    assert.equal(hueOf("ada-fixture"), hueOf("ADA-fixture"));
    const v = identiconView(a, 11);
    assert.equal(v.attrs.class, "identicon hue-3");
    assert.equal([...walk(v)].filter((e) => e.tag === "td").length, 25);
  });
});
