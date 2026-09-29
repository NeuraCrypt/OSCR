// The catalogue's lists, whatever its size (src/lib/shards.ts; docs/ARCHITECTURE.md, "How pages
// are rendered, and the file budget"):
//
//   - the home page shows the latest days of publication, whole, up to HOME_PAPERS papers with
//     their authors' code (~130 KB of HTML, where it held every paper: 3.5 MB on 2026-09-29);
//   - /list/, /list/2/, … show every paper with a page (decision D2), the most recent first,
//     LIST_PAGE a page in LIST_PAGES_MAX pages at most: every paper is one link away from a
//     static page, whatever the catalogue's size.
//
// Pure functions, shared by the pages and the tests: nothing here reads a file.
import { HOME_PAPERS, LIST_PAGE, LIST_PAGES_MAX } from "./shards.ts";

type Dated = { slug: string; published: string };

/** The order of every list: the most recent first (a partial date, 2026-09, after the days of its
 *  month; no date last), then by page name, so that every build of an export lists the same. */
export function newestFirst<T extends Dated>(papers: readonly T[]): T[] {
  return [...papers].sort((x, y) =>
    x.published === y.published ? (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0) : x.published < y.published ? 1 : -1,
  );
}

/** The home page's papers: whole days, the most recent first, while they hold at most `max`
 *  papers. The first day always shows, cut at `max` when it holds more (`cut`). */
export function latestDays<T extends Dated>(papers: readonly T[], max = HOME_PAPERS): { shown: T[]; days: number; cut: boolean } {
  const sorted = newestFirst(papers);
  const shown: T[] = [];
  let days = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].published === sorted[i].published) j += 1;
    if (days > 0 && shown.length + (j - i) > max) break;
    shown.push(...sorted.slice(i, Math.min(j, i + max)));
    days += 1;
    if (j - i > max) return { shown, days, cut: true };
    i = j;
  }
  return { shown, days, cut: false };
}

/** The list's pages for `total` papers: LIST_PAGE a page while that makes at most LIST_PAGES_MAX
 *  pages; past it, LIST_PAGES_MAX pages of more papers each. At least one page, even empty. */
export function listPaging(total: number, page = LIST_PAGE, most = LIST_PAGES_MAX): { size: number; pages: number } {
  const size = Math.max(page, Math.ceil(total / most));
  return { size, pages: Math.max(1, Math.ceil(total / size)) };
}

/** The address of the list's page `n` (1 is /list/ itself). */
export const listUrl = (n: number) => (n <= 1 ? "/list/" : `/list/${n}/`);

/** The pages a pager names around page `n` of `pages`: the first, the last, and `around` on each
 *  side of `n`; 0 stands for a gap ("…"). */
export function pagerPages(n: number, pages: number, around = 2): number[] {
  const out: number[] = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || Math.abs(p - n) <= around) out.push(p);
    else if (out[out.length - 1] !== 0) out.push(0);
  }
  return out;
}
