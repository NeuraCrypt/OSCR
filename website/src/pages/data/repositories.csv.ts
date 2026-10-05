// /data/repositories.csv: one row per repository the registry knows (the small bulk export).
import type { APIRoute } from "astro";
import { repositoriesCsv } from "../../lib/apidata";

export const GET: APIRoute = () =>
  new Response(repositoriesCsv(), { headers: { "Content-Type": "text/csv; charset=utf-8" } });
