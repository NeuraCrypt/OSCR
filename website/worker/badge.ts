// The badges of papers and repositories (docs/BADGE.md), drawn on demand. Routed by index.ts before
// the pages: no static file lives under /badge/doi/ or /badge/repo/ (the generator is the one page
// /badge/), so these requests reach the Worker through `not_found_handling = "none"`, with no change
// to wrangler.toml.
//
//   GET /badge/doi/<doi>.svg       a paper's badge (src/lib/badge.ts: ?style=, ?show=, ?theme=, ?text=)
//   GET /badge/doi/<doi>.json      the same facts for shields.io's endpoint badge
//   GET /badge/doi/<doi>           the badge's link: a redirect to the paper's page (?to= map, cite,
//                                  reader, code, doi, api); an unknown DOI to /submit/?doi=, a DOI read
//                                  without a page to the DOI lookup
//   GET /badge/repo/<host>/<path>[.svg|.json]   the same for a repository (?missing=hide for GitLab's
//                                  group badges); its link goes to its paper, to the generator when it
//                                  is the code of several, to /submit/ when unknown
//   GET /badge/doi.svg?doi=…       the query form, for a DOI that ends as a suffix would
//
// Cost: every request runs the Worker (the free plan's 100,000 a day). So every answer is cached an
// hour by the browser, GitHub's camo proxy and Cloudflare's own cache (the Cache API on the custom
// domain), and served stale for a day while it refreshes; it reads only static files through the
// ASSETS binding (free): one lookup shard and one /data/ shard, two for a repository with one paper.
// No D1, no secret, no cookie, nothing of the reader kept. When the daily quota is spent, a badge
// is not drawn: the documented fallback is the static /badge.svg and /badge.png (no Worker at all).
import { DATA_BASE, REPO_SHARDS } from "../src/lib/apispec.ts";
import {
  BADGE_MAX_AGE, BADGE_STALE, BADGE_TARGETS, badgeDoi, badgeRepoKey, endpointJson, readOptions, renderBadge,
  type BadgeFacts, type BadgeTarget,
} from "../src/lib/badge.ts";
import { lookupShard, shardOf, SHARDS } from "../src/lib/shards.ts";
import type { Context, Env } from "./env.ts";
import { asset, type Assets } from "./pages.ts";

/** The headers every badge answer carries: anyone may embed it (CORS, CORP), the SVG may load
 *  nothing (its logo is inside it) and run nothing. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const SVG_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
const CACHE = `public, max-age=${BADGE_MAX_AGE}, s-maxage=${BADGE_MAX_AGE}, stale-while-revalidate=${BADGE_STALE}`;

/** A paper's record in /data/papers/NN.json, as much of it as a badge reads (src/lib/apidata.ts). */
type ApiPaper = {
  doi?: string;
  slug?: string;
  title?: string;
  published?: string;
  status?: string;
  journal?: { title?: string };
  code?: { url?: string; license?: string; scripts?: number | null; languages?: Record<string, number> }[];
  map_doi?: string;
  links?: { record?: string };
};
type ApiRepo = {
  repo?: string;
  url?: string;
  license?: string;
  scripts?: number | null;
  languages?: Record<string, number>;
  papers?: { doi?: string; title?: string; record?: string }[];
};

/** What a badge resolves to: its facts, and where its link goes. */
type Resolved = { facts: BadgeFacts; page: string; code: string; doi: string; api: string; many?: string; tool?: boolean };

async function readJson<T>(assets: Assets, url: URL, path: string): Promise<T | undefined> {
  try {
    const res = await asset(assets, url, path);
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** The platform's name, as the build wrote it (/badge/site.json, from SITE_NAME): the Worker never
 *  names the platform itself. Kept while the isolate lives. */
let siteName: string | undefined;
async function nameOf(assets: Assets, url: URL): Promise<string> {
  if (siteName) return siteName;
  const site = await readJson<{ name?: string }>(assets, url, "/badge/site.json");
  if (site?.name) siteName = site.name;
  return site?.name || url.hostname;
}

function sumScripts(code: ApiPaper["code"]): number | null {
  const known = (code ?? []).map((c) => c.scripts).filter((n): n is number => typeof n === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

function mergeLanguages(code: ApiPaper["code"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of code ?? []) for (const [k, v] of Object.entries(c.languages ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** A paper by its DOI: the lookup shard, then (when it has a page) its /data/ record. */
async function byDoi(assets: Assets, url: URL, doi: string): Promise<Resolved> {
  const lookup = await readJson<Record<string, [string, string, string?]>>(assets, url, `/lookup/${await lookupShard(doi)}.json`);
  const entry = lookup && Object.hasOwn(lookup, doi) ? lookup[doi] : undefined;
  const api = `/api/v1/paper/${encodeURIComponent(doi)}`;
  const doiUrl = `https://doi.org/${doi}`;
  if (!entry) return { facts: { kind: "unknown", doi }, page: `/submit/?doi=${encodeURIComponent(doi)}`, code: "", doi: doiUrl, api };
  const slug = entry[2];
  if (!slug) return { facts: { kind: "read", doi, status: entry[0] }, page: `/lookup/?doi=${encodeURIComponent(doi)}`, code: "", doi: doiUrl, api };
  const shard = await readJson<Record<string, ApiPaper>>(assets, url, `${DATA_BASE}/papers/${await shardOf(slug, SHARDS.paper)}.json`);
  const p = shard && Object.hasOwn(shard, slug) ? shard[slug] : {};
  const page = p.links?.record || `/paper/${slug}/`;
  const code = p.code ?? [];
  return {
    facts: {
      kind: "paper",
      doi,
      status: p.status || entry[0],
      title: p.title,
      journal: p.journal?.title,
      year: (p.published ?? "").slice(0, 4),
      mapDoi: p.map_doi,
      repos: code.length,
      scripts: sumScripts(code),
      languages: mergeLanguages(code),
      license: code.find((c) => c.license)?.license,
    },
    page,
    code: code.find((c) => c.url)?.url ?? "",
    doi: doiUrl,
    api,
  };
}

/** A repository by its key: its /data/repos/ record; with one paper, that paper's facts too. */
async function byRepo(assets: Assets, url: URL, key: string): Promise<Resolved> {
  const shard = await readJson<Record<string, ApiRepo>>(assets, url, `${DATA_BASE}/repos/${await shardOf(key, REPO_SHARDS)}.json`);
  const r = shard && Object.hasOwn(shard, key) ? shard[key] : undefined;
  const repoUrl = `https://${key}`;
  if (!r) {
    // A scientific tool's repository (src/pages/badge/tools.json.ts): its page in the registry.
    const tools = await readJson<Record<string, { name: string; page: string; licence: string; files: number; languages: Record<string, number> }>>(assets, url, "/badge/tools.json");
    const t = tools && Object.hasOwn(tools, key.toLowerCase()) ? tools[key.toLowerCase()] : undefined;
    if (t) {
      return {
        facts: { kind: "tool", title: t.name, license: t.licence, languages: t.languages, scripts: t.files },
        page: t.page,
        code: repoUrl,
        doi: "",
        api: t.page,
        tool: true,
      };
    }
    return { facts: { kind: "unknown" }, page: `/submit/?code=${encodeURIComponent(repoUrl)}`, code: repoUrl, doi: "", api: `/api/v1/repository/${key}` };
  }
  const papers = (r.papers ?? []).filter((p) => p.doi);
  const base: BadgeFacts = { kind: "repo", papers: papers.length, scripts: r.scripts ?? null, languages: r.languages ?? {}, license: r.license };
  const api = `/api/v1/repository/${key}`;
  if (papers.length === 1) {
    const one = await byDoi(assets, url, badgeDoi(papers[0].doi ?? ""));
    const f = one.facts;
    return {
      facts: { ...base, doi: f.doi, title: f.title ?? papers[0].title, journal: f.journal, year: f.year, mapDoi: f.mapDoi, status: f.status, repos: f.repos },
      page: one.facts.kind === "paper" ? one.page : papers[0].record || one.page,
      code: r.url || repoUrl,
      doi: one.doi,
      api,
    };
  }
  return { facts: base, page: `/badge/?repo=${encodeURIComponent(key)}`, code: r.url || repoUrl, doi: "", api, many: key };
}

/** The badge's link, by `?to=`. */
function target(res: Resolved, to: BadgeTarget): string {
  const known = res.facts.kind === "paper" || (res.facts.kind === "repo" && !res.many && res.facts.papers);
  if (res.tool) return to === "code" ? res.code : res.page;
  if (!known) return to === "code" && res.code ? res.code : res.page;
  switch (to) {
    case "map":
      return `${res.page}#map`;
    case "cite":
      return `${res.page}#cite`;
    case "reader":
      return `${res.page}#code`;
    case "code":
      return res.code || res.page;
    case "doi":
      return res.doi || res.page;
    case "api":
      return res.api;
    default:
      return res.page;
  }
}

/** A strong validator of the body (the camo proxy and browsers revalidate with it). */
async function etagOf(body: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  return `"${Array.from(d.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function cacheOf(): Cache | undefined {
  // `caches.default` exists in the Workers runtime only, and works on a custom domain (worker/api.ts).
  return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
}

/** Answers a /badge/doi/… or /badge/repo/… request; undefined for any other path. */
export async function handleBadge(request: Request, env: Env, ctx: Context): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  const m = /^\/badge\/(doi|repo)(?:(\.svg|\.json)$|\/(.+)$|$)/.exec(path);
  if (!m) return undefined;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...BASE_HEADERS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Max-Age": "86400" } });
  }
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS", ...BASE_HEADERS } });
  if (!env.ASSETS) return new Response("Not found", { status: 404, headers: BASE_HEADERS });

  // The kind of answer: the image, the shields.io endpoint, or the link.
  let rest = m[3] ?? "";
  let format: "svg" | "json" | "link" = m[2] === ".svg" ? "svg" : m[2] === ".json" ? "json" : "link";
  if (rest) {
    const ext = /\.(svg|json)$/i.exec(rest);
    if (ext) {
      format = ext[1].toLowerCase() as "svg" | "json";
      rest = rest.slice(0, -ext[0].length);
    }
  }
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // kept as typed
  }

  const cache = request.method === "GET" ? cacheOf() : undefined;
  const key = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return conditional(request, hit);
  }

  const assets = env.ASSETS;
  let resolved: Resolved;
  if (m[1] === "doi") {
    const doi = badgeDoi(decoded || url.searchParams.get("doi") || "");
    if (!doi) return bad(format, "Give a DOI: /badge/doi/10.1234/abcd.svg.", head);
    resolved = await byDoi(assets, url, doi);
  } else {
    const repo = badgeRepoKey(`https://${decoded || (url.searchParams.get("repo") ?? "").replace(/^https?:\/\//i, "")}`);
    if (!repo) return bad(format, "Give a repository: /badge/repo/github.com/owner/name.svg.", head);
    resolved = await byRepo(assets, url, repo);
  }

  let response: Response;
  if (format === "link") {
    const to = (url.searchParams.get("to") ?? "paper").toLowerCase() as BadgeTarget;
    const where = target(resolved, BADGE_TARGETS.includes(to) ? to : "paper");
    response = new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: new URL(where, url).toString(), "Cache-Control": CACHE } });
  } else {
    const name = await nameOf(assets, url);
    const options = readOptions(url.searchParams);
    const body = format === "svg" ? renderBadge(name, resolved.facts, options) : JSON.stringify(endpointJson(name, resolved.facts, options));
    response = new Response(body, {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "Content-Type": format === "svg" ? "image/svg+xml; charset=utf-8" : "application/json; charset=utf-8",
        ...(format === "svg" ? { "Content-Security-Policy": SVG_POLICY } : {}),
        "Cache-Control": CACHE,
        ETag: await etagOf(body),
      },
    });
  }
  if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => undefined));
  return conditional(request, response);
}

/** 304 when the reader already holds this answer; no body for a HEAD. */
function conditional(request: Request, res: Response): Response {
  const tag = res.headers.get("ETag");
  if (tag && request.headers.get("If-None-Match")?.split(/\s*,\s*/).includes(tag)) {
    return new Response(null, { status: 304, headers: res.headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: res.status, headers: res.headers });
  return res;
}

/** A malformed address: still an image (a broken one tells the README's reader nothing). */
function bad(format: "svg" | "json" | "link", message: string, head: boolean): Response {
  const headers = { ...BASE_HEADERS, "Cache-Control": "no-store" };
  if (format === "link") return new Response(head ? null : message, { status: 400, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  if (format === "json") {
    return new Response(head ? null : JSON.stringify({ schemaVersion: 1, label: "badge", message: "bad address", isError: true }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const body = renderBadge("badge", { kind: "unknown" }, { style: "flat", show: "status", theme: "blue", text: "bad address", missing: "show" });
  return new Response(head ? null : body, { status: 400, headers: { ...headers, "Content-Type": "image/svg+xml; charset=utf-8", "Content-Security-Policy": SVG_POLICY } });
}
