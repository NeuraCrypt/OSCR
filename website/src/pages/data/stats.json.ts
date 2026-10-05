// /data/stats.json: the catalogue's figures (the /api/v1/stats endpoint reads this file). A static
// asset, served by the CDN for free; the Worker reads the same file.
import type { APIRoute } from "astro";
import { apiStats } from "../../lib/apidata";

export const GET: APIRoute = () =>
  new Response(JSON.stringify(apiStats()), { headers: { "Content-Type": "application/json; charset=utf-8" } });
