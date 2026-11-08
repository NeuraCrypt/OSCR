// The sitemap (2026-09-29): every page a search engine may index, the fixed and information pages,
// the list by date, the categories, the entity lists, every paper with a page (built ahead of time or
// rendered on demand), every author, journal, institution, tool and dataset, as paths, then split
// into shards of SITEMAP_URLS addresses at most (the protocol's limit is 50,000): /sitemaps/NN.xml,
// listed by /sitemap.xml. At most SITEMAP_SHARDS files, whatever the catalogue's size; the forms
// (account, submission, removal), the search and the 404 pages are left out: a page kept out of search
// engines (src/lib/seo.ts, NOINDEX_PATHS) is never listed, and scripts/check.mjs holds every address
// to a page that answers 200 at once, is not kept out by robots.txt and names itself as canonical.
import { withPage } from "./catalog";
import {
  authorLetters, authors, authorUrl, categoryPages, datasets, datasetUrl, institutions, institutionUrl, journals,
  journalUrl, tools, toolUrl,
} from "./entities";
import { ABOUT, HELP, pageExists, POLICIES } from "./info";
import { listPaging, listUrl, newestFirst } from "./lists";
import { sciTools } from "./scitools-data";
import { isNoindexPath } from "./seo";
import { SCITOOLS_PATH } from "./scitools";

/** Every path the sitemap lists, once each, in a stable order. */
export function sitemapPaths(): string[] {
  const fixed = [
    "/", "/lookup/", "/browse/", "/authors/", "/journals/", "/institutions/", "/tools/", "/datasets/",
    "/help/", "/policies/", ...[...ABOUT, ...HELP, ...POLICIES].map((l) => l.href),
  ].filter((p) => pageExists(p));
  const { pages } = listPaging(withPage.length);
  const paths = [
    ...fixed,
    ...Array.from({ length: pages }, (_, i) => listUrl(i + 1)),
    ...categoryPages.map((c) => c.url),
    ...authorLetters.map((g) => `/authors/${g.slug}/`),
    ...newestFirst(withPage).map((a) => `/paper/${a.slug}/`),
    ...authors.map((a) => authorUrl(a.orcid)),
    ...journals.map((j) => journalUrl(j.id)),
    ...institutions.map((i) => institutionUrl(i.id)),
    ...tools.map((t) => toolUrl(t.id)),
    ...datasets.map((d) => datasetUrl(d.id)),
    ...(sciTools.length ? [SCITOOLS_PATH, ...sciTools.map((t) => `${SCITOOLS_PATH}${t.slug}/`)] : []),
  ];
  return [...new Set(paths.filter((p) => p !== "" && !isNoindexPath(p)))];
}

export { shardName, sitemapIndex, sitemapShards, urlset } from "./sitemap-xml.ts";
