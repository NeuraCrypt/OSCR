// The catalogue's lists (src/lib/lists.ts): the home page's latest days, the pages of the list of
// every paper by date, and their pager.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestDays, listPaging, listUrl, newestFirst, pagerPages } from "../src/lib/lists.ts";
import { listing, type Row } from "../src/lib/render.ts";
import { HOME_PAPERS, LIST_PAGE, LIST_PAGES_MAX } from "../src/lib/shards.ts";

const paper = (slug: string, published: string) => ({ slug, published });

describe("the lists", () => {
  it("orders the most recent first, a month after its days, no date last, ties by name", () => {
    const order = newestFirst([paper("b", "2026-09-21"), paper("n", ""), paper("m", "2026-09"), paper("a", "2026-09-21"), paper("z", "2026-09-22")]);
    assert.deepEqual(order.map((p) => p.slug), ["z", "a", "b", "m", "n"]);
  });

  it("shows whole days on the home page, up to its number of papers", () => {
    const days = ["2026-09-28", "2026-09-27", "2026-09-26", "2026-09-25"];
    const papers = days.flatMap((d, i) => Array.from({ length: 30 + i }, (_, j) => paper(`${d}-${j}`, d)));
    const home = latestDays(papers, 100);
    // 30 + 31 + 32 = 93; the fourth day's 33 would pass 100.
    assert.equal(home.shown.length, 93);
    assert.equal(home.days, 3);
    assert.equal(home.cut, false);
    assert.ok(home.shown.every((p) => p.published >= "2026-09-26"));
  });

  it("cuts a first day that holds more than the home page's number, and says so", () => {
    const papers = Array.from({ length: 150 }, (_, j) => paper(`p${String(j).padStart(3, "0")}`, "2026-09-28"));
    const home = latestDays([...papers, paper("older", "2026-09-27")]);
    assert.equal(home.shown.length, HOME_PAPERS);
    assert.equal(home.cut, true);
    assert.equal(latestDays([]).shown.length, 0);
  });

  it("keeps a bounded number of the list's pages, whatever the catalogue's size", () => {
    assert.deepEqual(listPaging(0), { size: LIST_PAGE, pages: 1 });
    assert.deepEqual(listPaging(4_554), { size: LIST_PAGE, pages: 46 });
    assert.deepEqual(listPaging(LIST_PAGE * LIST_PAGES_MAX), { size: LIST_PAGE, pages: LIST_PAGES_MAX });
    for (const total of [20_001, 50_000, 90_000, 1_000_000]) {
      const { size, pages } = listPaging(total);
      assert.ok(pages <= LIST_PAGES_MAX, `${total}: ${pages} pages`);
      assert.ok(size * pages >= total, `${total}: every paper on a page`);
    }
    assert.equal(listUrl(1), "/list/");
    assert.equal(listUrl(7), "/list/7/");
  });

  it("names the first, the last and the pages around this one in the pager", () => {
    assert.deepEqual(pagerPages(1, 1), [1]);
    assert.deepEqual(pagerPages(1, 10), [1, 2, 3, 0, 10]);
    assert.deepEqual(pagerPages(6, 10), [1, 0, 4, 5, 6, 7, 8, 0, 10]);
    assert.deepEqual(pagerPages(10, 10), [1, 0, 8, 9, 10]);
  });

  it("goes on counting on a page of the list, and says how many papers a day has in all", () => {
    const row = (slug: string, published: string): Row => ({
      slug, doi: `10.5555/${slug}`, title: slug, journal: "J", published, status: "on_request", code: [], files: 0, pairs: 0, map: "", data: 0, reader: false,
    });
    const html = listing([row("a", "2026-09-21"), row("b", "2026-09-21")], { start: 100, dayTotals: new Map([["2026-09-21", 5]]) });
    assert.ok(html.includes('<span class="num">[101]</span>'));
    assert.ok(html.includes('<span class="num">[102]</span>'));
    assert.ok(html.includes("(5 papers, 2 on this page)"));
    assert.ok(listing([row("a", "2026-09-21")]).includes("(1 paper)"));
  });
});
