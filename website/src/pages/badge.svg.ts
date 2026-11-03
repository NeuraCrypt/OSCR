// The generic badge: ONE static image, for wherever a badge drawn on demand cannot go or should not
// cost a Worker request (docs/BADGE.md). The same drawing as a paper's badge (src/lib/badge.ts), the
// owner's mark and "paper ↔ code"; the link around it makes it a paper's. A paper's own badge, which
// says what the registry knows of it, is /badge/doi/<doi>.svg (worker/badge.ts).
import type { APIRoute } from "astro";
import { SITE_NAME } from "../config";
import { renderBadge } from "../lib/badge";

export const GET: APIRoute = () =>
  new Response(renderBadge(SITE_NAME, { kind: "paper", status: "code_verified" }), {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8" },
  });
