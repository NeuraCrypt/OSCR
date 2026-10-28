// /data/articles.csv.gz: one row per paper (the small bulk export). A static download, gzipped: the
// plain CSV grew past Cloudflare's 25 MiB asset limit, which the deploy skips (.assetsignore).
import type { APIRoute } from "astro";
import { gzipSync } from "node:zlib";
import { articlesCsv } from "../../lib/apidata";

export const GET: APIRoute = () =>
  new Response(gzipSync(articlesCsv(), { level: 9 }), { headers: { "Content-Type": "application/gzip" } });
