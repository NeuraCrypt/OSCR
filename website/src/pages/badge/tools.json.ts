// The scientific tools, for the badges the Worker draws (worker/badge.ts): a tool's repository is in
// no paper's record, so /badge/repo/<host>/<path> finds it here (src/lib/scitools.ts). One small
// file, a fixed count whatever the number of tools (at most SCITOOLS_MAX).
import type { APIRoute } from "astro";
import { badgeRepoKey } from "../../lib/badge";
import { sciTools } from "../../lib/scitools-data";
import { languagesOf, SCITOOLS_PATH } from "../../lib/scitools";

export const GET: APIRoute = () => {
  const tools: Record<string, { slug: string; name: string; page: string; licence: string; files: number; languages: Record<string, number> }> = {};
  for (const t of sciTools) {
    const key = badgeRepoKey(t.repository.url).toLowerCase();
    if (!key) continue;
    tools[key] = {
      slug: t.slug,
      name: t.name,
      page: `${SCITOOLS_PATH}${t.slug}/`,
      licence: t.licence.spdx,
      files: t.files.length,
      languages: Object.fromEntries(languagesOf(t.files).map((l) => [l.language, l.lines])),
    };
  }
  return new Response(JSON.stringify(tools), { headers: { "Content-Type": "application/json; charset=utf-8" } });
};
