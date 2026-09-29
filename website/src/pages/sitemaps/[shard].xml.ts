// A shard of the sitemap (src/lib/sitemap.ts): SITEMAP_URLS addresses at most.
import type { APIRoute } from "astro";
import { shardName, sitemapPaths, sitemapShards, urlset } from "../../lib/sitemap";

export function getStaticPaths() {
  return sitemapShards(sitemapPaths()).map((paths, n) => ({ params: { shard: shardName(n).replace(/\.xml$/, "") }, props: { paths } }));
}

export const GET: APIRoute = ({ props, site }) =>
  new Response(urlset((props as { paths: string[] }).paths, site!), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
