// The block identifiers' pages (oscr/blocks.py, src/lib/block.ts, docs/PLAN_BLOCK_IDS.md):
//
//   GET /b/<id>        the block's page: what it names (the paper, the file, the lines, its SWHID),
//                      its status (current, superseded, withdrawn) and how to cite it, rendered into
//                      the site's 404 page as a shell (status 200)
//   GET /b/<id>.json   the same facts, for a program (CORS open: anyone may read them)
//
// An identifier written another way (lower case, an O for a zero) is sent to its one form (301); one
// whose check character is wrong, or that the registry never gave, is a 404 that says so. No file of
// its own: the entry is read in the DOI lookup's shard of the identifier's SHA-1 (/lookup/NN.json),
// through the ASSETS binding (free). Cost: one Worker request, one asset read, no D1 row.
import { blockJson, blockPath, blockView, cleanEntry, normalize, PREFIX } from "../src/lib/block.ts";
import { canonicalHref } from "../src/lib/seo.ts";
import { lookupShard } from "../src/lib/shards.ts";
import { asset, type Assets, fillShell, SITE_HEADERS } from "./pages.ts";

const BLOCK = /^\/b\/([^/]+?)(\.json)?\/?$/;
const CACHE = "public, max-age=600";

function notFound(json: boolean, head: boolean, why: string, shell: string | null): Response {
  if (json) {
    return new Response(head ? null : JSON.stringify({ error: "not_found", message: why }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": CACHE },
    });
  }
  const view = { title: "Block not found", description: why, crumb: "Block", html: `<h1>Block not found</h1><p>${why} <a href="/help/reader/#block-ids">What a block identifier is</a>.</p>` };
  const page = shell ? fillShell(shell, view) : null;
  return new Response(head ? null : page ?? why, {
    status: 404,
    headers: { "Content-Type": page ? "text/html; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": CACHE, ...SITE_HEADERS },
  });
}

/** /b/<id> and /b/<id>.json, or undefined when the path is not a block's. */
export async function handleBlock(request: Request, assets: Assets | undefined): Promise<Response | undefined> {
  const url = new URL(request.url);
  const m = url.pathname.match(BLOCK);
  if (!m) return undefined;
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!assets) return new Response("Not found", { status: 404 });
  const json = Boolean(m[2]);
  const shellRes = json ? null : await asset(assets, url, "/404.html");
  const shell = shellRes?.ok ? await shellRes.text() : null;
  let raw = m[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return notFound(json, head, "This is not a block identifier.", shell);
  }
  const id = normalize(raw.toLowerCase().startsWith(PREFIX) ? raw : `${PREFIX}${raw}`);
  if (!id) return notFound(json, head, "This is not a block identifier: its form or its check character is wrong (a typing mistake?).", shell);
  if (raw !== id || url.pathname.endsWith("/")) return Response.redirect(new URL(`${blockPath(id)}${json ? ".json" : ""}`, url).toString(), 301);
  const res = await asset(assets, url, `/lookup/${await lookupShard(id)}.json`);
  const shard = res.ok ? ((await res.json()) as Record<string, unknown>) : {};
  const entry = Object.hasOwn(shard, id) ? cleanEntry(shard[id]) : null;
  if (!entry) return notFound(json, head, "The registry has given no block this identifier.", shell);
  const site = shell?.match(/<meta name="site-origin" content="([^"]*)"/)?.[1] || url.origin;
  if (json) {
    return new Response(head ? null : JSON.stringify(blockJson(id, entry, url.origin)), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": CACHE },
    });
  }
  const name = shell?.match(/<meta name="application-name" content="([^"]*)"/)?.[1] ?? "";
  // The 404 page is kept out of search engines; a block's page is not.
  const filled = shell ? fillShell(shell, blockView(id, entry, name), canonicalHref(site, blockPath(id)).replace(/\/$/, "")) : null;
  const page = filled?.replace(/<meta name="robots" content="noindex"\s*\/?>/g, "") ?? null;
  if (page === null) return new Response("This page could not be rendered.", { status: 500 });
  return new Response(head ? null : page, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE, ...SITE_HEADERS },
  });
}
