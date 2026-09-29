// The sitemap's pure parts (src/lib/sitemap.ts gathers the paths from the build's data): the shards,
// their names, and the XML. Nothing here reads a file; the tests import it directly.
import { SITEMAP_SHARDS, SITEMAP_URLS } from "./shards.ts";

/** The paths in shards of `size` at most. Past SITEMAP_SHARDS shards, the build fails: the budget
 *  of files must be raised knowingly. */
export function sitemapShards(paths: readonly string[], size = SITEMAP_URLS, most = SITEMAP_SHARDS): string[][] {
  const shards: string[][] = [];
  for (let i = 0; i < paths.length; i += size) shards.push(paths.slice(i, i + size));
  if (shards.length > most) throw new Error(`the sitemap needs ${shards.length} shards, more than SITEMAP_SHARDS (${most})`);
  return shards.length ? shards : [[]];
}

/** The name of shard `n` (from 0): /sitemaps/00.xml. */
export const shardName = (n: number) => `${String(n).padStart(2, "0")}.xml`;

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A shard's XML, the site's origin before each path. */
export function urlset(paths: readonly string[], site: URL): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...paths.map((p) => `<url><loc>${escapeXml(new URL(p, site).href)}</loc></url>`),
    `</urlset>`,
    ``,
  ].join("\n");
}

/** The sitemap index's XML. */
export function sitemapIndex(shards: number, site: URL): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...Array.from({ length: shards }, (_, n) => `<sitemap><loc>${escapeXml(new URL(`/sitemaps/${shardName(n)}`, site).href)}</loc></sitemap>`),
    `</sitemapindex>`,
    ``,
  ].join("\n");
}
