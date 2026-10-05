// /data/articles.csv: one row per paper (the small bulk export). A static download.
import type { APIRoute } from "astro";
import { articlesCsv } from "../../lib/apidata";

export const GET: APIRoute = () =>
  new Response(articlesCsv(), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
