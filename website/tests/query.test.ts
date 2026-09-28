// The query language (src/lib/query.ts): what a reader types, the FTS5 expression it becomes,
// and the proof, on a real FTS5 table, that every expression is valid and means what it says.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fielded, highlight, LIMITS, parseQuery, titleTerms, toMatch } from "../src/lib/query.ts";
import { FTS5_READY, NO_FTS5 } from "./d1.ts";

const ALL = "zzall";
const match = (q: string) => {
  const p = parseQuery(q);
  return p.node ? toMatch(p.node, ALL) : null;
};
const TEXT = "{title keywords mesh authors journal repos tools ids abstract}";

// A small index with the real schema (when this Node's SQLite can build it).
const db = new DatabaseSync(":memory:");
if (FTS5_READY) db.exec(readFileSync(new URL("../../migrations/d1/search/0001_search.sql", import.meta.url), "utf8"));
const docs: [number, Record<string, string>][] = [
  [1, { title: "Alpha waves of EEG in working memory", authors: "Ada Lovelace", tools: "MNE-Python", ids: "10.1038/s41586-020-2649-2" }],
  [2, { title: "MEG and EEG source imaging", authors: "Ben Smith", abstract: "cortical oscillations" }],
  [3, { title: "Zürich fMRI study of memory", authors: "Clara Müller", journal: "NeuroImage" }],
  [4, { title: "Neuroimaging pipelines", repos: "github.com/lab/pipeline", keywords: "reproducibility" }],
];
for (const [rowid, cols] of FTS5_READY ? docs : []) {
  db.prepare("INSERT INTO paper_fts (rowid, title, keywords, authors, journal, repos, tools, ids, abstract, facets, fx) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(rowid, cols.title ?? "", cols.keywords ?? "", cols.authors ?? "", cols.journal ?? "", cols.repos ?? "", cols.tools ?? "",
      cols.ids ?? "", cols.abstract ?? "", ALL, "[0]");
}
const found = (q: string) => {
  const m = match(q);
  if (m === null) return null;
  return db.prepare("SELECT rowid FROM paper_fts WHERE paper_fts MATCH ? ORDER BY rowid").all(m).map((r) => Number(r.rowid));
};

describe("the translation to FTS5", () => {
  it("quotes every word and searches the text columns only", () => {
    assert.equal(match("eeg"), `${TEXT} : "eeg"`);
    assert.equal(match("eeg alpha"), `(${TEXT} : "eeg" AND ${TEXT} : "alpha")`);
  });

  it("keeps phrases, prefixes, fields and groups", () => {
    assert.equal(match('"working memory"'), `${TEXT} : "working memory"`);
    assert.equal(match("neuro*"), `${TEXT} : "neuro"*`);
    assert.equal(match("title:eeg"), '{title} : "eeg"');
    assert.equal(match('author:"Smith B"'), '{authors} : "Smith B"');
    assert.equal(match("title:(eeg OR meg)"), '({title} : "eeg" OR {title} : "meg")');
    assert.equal(match("title:(eeg author:ada)"), '({title} : "eeg" AND {authors} : "ada")');
  });

  it("turns exclusions into NOT, from every paper when nothing else is searched", () => {
    assert.equal(match("eeg -meg"), `(${TEXT} : "eeg" NOT ${TEXT} : "meg")`);
    assert.equal(match("eeg NOT meg"), `(${TEXT} : "eeg" NOT ${TEXT} : "meg")`);
    assert.equal(match("NOT meg"), `({facets} : "${ALL}" NOT ${TEXT} : "meg")`);
    assert.equal(match("-meg"), `({facets} : "${ALL}" NOT ${TEXT} : "meg")`);
  });

  it("binds AND tighter than OR", () => {
    assert.equal(match("a1 OR b2 c3"), `(${TEXT} : "a1" OR (${TEXT} : "b2" AND ${TEXT} : "c3"))`);
  });

  it("never lets FTS5 syntax through", { skip: NO_FTS5 }, () => {
    // Every quote, star, colon, caret or NEAR( typed stays inside a quoted string.
    for (const q of ['a"b', "col:x", "^start", "NEAR(a b)", "x + y", "a AND", "OR b", "(((", ")))", '"', "{title}:x", "'; DROP TABLE papers; --"]) {
      const m = match(q);
      if (m === null) continue;
      assert.doesNotThrow(() => db.prepare("SELECT rowid FROM paper_fts WHERE paper_fts MATCH ?").all(m), `${q} → ${m}`);
    }
    assert.equal(match('say "hi'), `(${TEXT} : "say" AND ${TEXT} : "hi")`);
  });

  it("reads identifiers and web addresses as the index stores them", () => {
    assert.equal(match("doi:10.1038/s41586-020-2649-2"), '{ids} : "10.1038/s41586-020-2649-2"');
    assert.equal(match("https://doi.org/10.1038/s41586-020-2649-2"), `${TEXT} : "10.1038/s41586-020-2649-2"`);
    assert.equal(match("https://github.com/lab/pipeline"), `${TEXT} : "github.com/lab/pipeline"`);
    assert.equal(match("mne-python"), `${TEXT} : "mne-python"`);
  });

  it("drops what cannot be searched, and says what it changed", () => {
    assert.equal(match(""), null);
    assert.equal(match("AND OR NOT ( ) - *"), null);
    assert.equal(match("title:"), null);
    const short = parseQuery("ab*");
    assert.equal(short.node && toMatch(short.node, ALL), `${TEXT} : "ab"`);
    assert.match(short.notices[0], /3 letters/);
    const long = parseQuery(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "));
    assert.equal((toMatch(long.node!, ALL).match(/" AND/g) ?? []).length, LIMITS.terms - 1);
    assert.match(long.notices.join(" "), /first 24/);
    const deep = parseQuery("(".repeat(20) + "eeg" + ")".repeat(20));
    assert.equal(deep.node && toMatch(deep.node, ALL), `${TEXT} : "eeg"`);
    assert.ok(parseQuery("x".repeat(LIMITS.chars + 50)).notices.some((n) => /characters/.test(n)));
    const prefixes = parseQuery("neur* memo* oscil* cortic* synap*");
    assert.equal((toMatch(prefixes.node!, ALL).match(/"\*/g) ?? []).length, LIMITS.prefixes);
  });
});

describe("the translation on a real FTS5 index", { skip: NO_FTS5 }, () => {
  it("finds what the reader asked for", () => {
    assert.deepEqual(found("eeg"), [1, 2]);
    assert.deepEqual(found("eeg -meg"), [1]);
    assert.deepEqual(found("NOT eeg"), [3, 4]);
    assert.deepEqual(found('"working memory"'), [1]);
    assert.deepEqual(found("memory OR imaging"), [1, 2, 3]);
    assert.deepEqual(found("zurich"), [3]);                        // accents folded
    assert.deepEqual(found("neuro*"), [3, 4]);                     // NeuroImage, Neuroimaging
    assert.deepEqual(found("author:smith"), [2]);
    assert.deepEqual(found("title:smith"), []);
    assert.deepEqual(found("tool:mne-python"), [1]);
    assert.deepEqual(found("doi:10.1038/s41586-020-2649-2"), [1]);
    assert.deepEqual(found("https://github.com/lab/pipeline"), [4]);
    assert.deepEqual(found("keyword:reproducibility"), [4]);
    assert.deepEqual(found("title:(eeg OR fmri) -meg"), [1, 3]);
    assert.deepEqual(found("eeg OR -memory"), [1, 2, 4]);
  });

  it("never matches the filter tokens with a word", () => {
    assert.deepEqual(found(ALL), []);
  });
});

describe("the words shown highlighted", () => {
  it("are the positive words searched in the title", () => {
    const terms = titleTerms(parseQuery('eeg -meg author:smith title:"working memory" neuro*').node);
    assert.deepEqual(terms, [
      { text: "eeg", prefix: false },
      { text: "working memory", prefix: false },
      { text: "neuro", prefix: true },
    ]);
  });

  it("are marked whole, without regard to case and accents", () => {
    const marks = (title: string, q: string) =>
      highlight(title, titleTerms(parseQuery(q).node)).filter((s) => s.mark).map((s) => s.text);
    assert.deepEqual(marks("EEG alpha in Zürich and in zurich", "eeg zurich"), ["EEG", "Zürich", "zurich"]);
    assert.deepEqual(marks("Neuroimaging of neurons; neural", "neuro*"), ["Neuroimaging", "neurons"]);
    assert.deepEqual(marks("MEGA and meg", "meg"), ["meg"]);
    assert.equal(highlight("A title", []).map((s) => s.text).join(""), "A title");
  });
});

describe("the fields of the masthead and the advanced form", () => {
  it("put a field before a word, a phrase or a group", () => {
    assert.equal(fielded("title", "eeg"), "title:eeg");
    assert.equal(fielded("title", "eeg alpha"), "title:(eeg alpha)");
    assert.equal(fielded("author", '"Smith B"'), 'author:"Smith B"');
    assert.equal(fielded("id", "  "), "");
  });
});
