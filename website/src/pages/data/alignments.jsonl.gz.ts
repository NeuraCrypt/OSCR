// /data/alignments.jsonl.gz: one JSON object per aligned paper (its paragraph to code-line pairs).
// Carries paragraph NUMBERS and short evidence terms only, never a paper's text (scripts/data.mjs).
// Gzipped: the plain file reached Cloudflare's 25 MiB asset limit, which the deploy skips.
import type { APIRoute } from "astro";
import { gzipSync } from "node:zlib";
import { alignmentsJsonl } from "../../lib/apidata";

export const GET: APIRoute = () =>
  new Response(gzipSync(alignmentsJsonl(), { level: 9 }), { headers: { "Content-Type": "application/gzip" } });
