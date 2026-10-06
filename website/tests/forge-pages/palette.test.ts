// The command palette (src/lib/palette.ts): the static index, the prefix parsing, the fuzzy match
// and the grouped results (night phase 15). Pure, Node. Everything is static or a search of the
// registry: no entry needs a request, and none is one-per-entity.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMMANDS,
  DESTINATIONS,
  flatten,
  fuzzy,
  indexEntries,
  parseQuery,
  search,
} from "../../src/lib/palette.ts";

describe("the static index", () => {
  test("every destination is a path of this site, every command runs in place", () => {
    for (const e of DESTINATIONS) {
      assert.equal(e.kind, "go");
      assert.match(e.href ?? "", /^\/[a-z/-]*\/?$/);
      assert.ok(!e.command);
    }
    for (const e of COMMANDS) {
      assert.equal(e.kind, "command");
      assert.match(e.command ?? "", /^[a-z]+(:[a-z]+)?$/);
      assert.ok(!e.href);
    }
  });

  test("the theme commands set the theme (dark is a command, never the default)", () => {
    const dark = COMMANDS.find((c) => c.command === "theme:dark");
    const light = COMMANDS.find((c) => c.command === "theme:light");
    assert.ok(dark && light);
  });

  test("no entry names the platform or uses an em dash", () => {
    for (const e of indexEntries()) {
      assert.doesNotMatch(`${e.title} ${e.keywords ?? ""}`, /\bOSCR\b|Open Scientific Code Registry/);
      assert.doesNotMatch(e.title, /—/);
    }
  });

  test("the ids are unique", () => {
    const ids = indexEntries().map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("parseQuery", () => {
  test("a leading # @ > or / sets the scope", () => {
    assert.deepEqual(parseQuery("#bug"), { scope: "issues", prefix: "#", query: "bug" });
    assert.deepEqual(parseQuery("@ada"), { scope: "people", prefix: "@", query: "ada" });
    assert.deepEqual(parseQuery(">dark"), { scope: "commands", prefix: ">", query: "dark" });
    assert.deepEqual(parseQuery("/theme"), { scope: "commands", prefix: "/", query: "theme" });
    assert.deepEqual(parseQuery("browse"), { scope: "all", prefix: "", query: "browse" });
  });
});

describe("fuzzy", () => {
  test("an empty query matches everything with no ranges", () => {
    assert.deepEqual(fuzzy("Preferences", ""), { score: 0, ranges: [] });
  });

  test("a subsequence matches and reports the ranges; a miss returns null", () => {
    const m = fuzzy("Preferences", "pref");
    assert.ok(m);
    assert.deepEqual(m!.ranges, [[0, 4]]);
    assert.equal(fuzzy("Preferences", "xyz"), null);
  });

  test("a tighter, earlier match scores lower (wins)", () => {
    const early = fuzzy("Search", "se")!;
    const late = fuzzy("Personal tokens", "se")!; // s...e, with a gap
    assert.ok(early.score < late.score);
  });
});

describe("search", () => {
  test("a plain query matches destinations and commands, and offers a registry search", () => {
    const groups = search("pref");
    const go = groups.find((g) => g.kind === "go");
    assert.ok(go && go.matches.some((m) => m.entry.id === "go-preferences"));
    assert.ok(groups.some((g) => g.kind === "search" && g.matches[0].entry.href === "/search/?q=pref&type=papers"));
  });

  test("# searches issues and pull requests, @ searches people, with no static list", () => {
    const hash = search("#memory");
    assert.equal(hash.length, 1);
    assert.equal(hash[0].kind, "issues");
    assert.equal(hash[0].matches[0].entry.href, "/search/?q=memory&type=issues");
    const at = search("@ada lovelace");
    assert.equal(at[0].kind, "people");
    assert.equal(at[0].matches[0].entry.href, "/search/?q=ada%20lovelace&type=people");
  });

  test("a prefix with no query shows no result yet (nothing to search for)", () => {
    assert.deepEqual(search("#")[0].matches, []);
  });

  test("> shows only commands, filtered", () => {
    const groups = search(">dark");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].kind, "command");
    assert.ok(groups[0].matches.every((m) => m.entry.kind === "command"));
    assert.ok(groups[0].matches.some((m) => m.entry.command === "theme:dark"));
  });

  test("an empty query lists the destinations and commands (no search fallback)", () => {
    const groups = search("");
    assert.ok(groups.some((g) => g.kind === "go"));
    assert.ok(!groups.some((g) => g.kind === "search"));
  });

  test("flatten gives the options in display order, for the keyboard navigation", () => {
    const groups = search("s");
    const flat = flatten(groups);
    assert.equal(flat.length, groups.reduce((n, g) => n + g.matches.length, 0));
  });

  test("no result href points off the site: all are this site's paths", () => {
    for (const q of ["pref", "#x", "@y", ">theme", "search", ""]) {
      for (const e of flatten(search(q))) {
        if (e.href) assert.match(e.href, /^\/[a-z/?=&%\d.-]*$/i);
      }
    }
  });
});
