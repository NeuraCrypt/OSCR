// The sitemap's index (src/lib/sitemap.ts): the shards /sitemaps/NN.xml, SITEMAP_SHARDS at most.
import type { APIRoute } from "astro";
import { sitemapIndex, sitemapPaths, sitemapShards } from "../lib/sitemap";

export const GET: APIRoute = ({ site }) =>
  new Response(sitemapIndex(sitemapShards(sitemapPaths()).length, site!), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
