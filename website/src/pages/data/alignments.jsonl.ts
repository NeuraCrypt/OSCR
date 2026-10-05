// /data/alignments.jsonl: one JSON object per aligned paper (its paragraph to code-line pairs).
// Carries paragraph NUMBERS and short evidence terms only, never a paper's text (scripts/data.mjs).
import type { APIRoute } from "astro";
import { alignmentsJsonl } from "../../lib/apidata";

export const GET: APIRoute = () =>
  new Response(alignmentsJsonl(), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
