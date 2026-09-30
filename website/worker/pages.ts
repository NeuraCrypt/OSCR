// The pages that no static file answers (wrangler.toml: `not_found_handling = "none"`, so the
// assets hand such a request to the Worker instead of serving 404.html themselves).
//
//   GET /paper/<slug>/        a paper past STATIC_PAPERS (src/lib/shards.ts): its record, read
//                             in /records/paper/NN.json, rendered into the paper's shell
//                             (/paper/404.html) with lib/render.ts's markup, status 200
//   GET /paper/<slug>/code/   the Code ↔ Paper reader's former address: 301 to /paper/<slug>/,
//                             its query kept (?path=…: the file shown), with no fragment so that
//                             the browser keeps the one asked for (#pair-3, #L10-L20); the reader
//                             is the first section of the page (static or rendered here)
//   anything else             the site's 404 page, status 404
//
// Cost of one such page: one Worker request (out of the free plan's 100,000 a day), two reads
// of the Worker's own static assets through the ASSETS binding (free: no request is counted),
// no D1 row. CPU: one JSON shard parsed and one page rendered, well under a millisecond on
// today's shards (measured in V8: docs/PLATFORM_PLAN.md §6).
import { esc, paperView, type PaperRecord, type View } from "../src/lib/render.ts";
import { keyOf, shardOf, SHARDS } from "../src/lib/shards.ts";

/** The Worker's own static assets (wrangler.toml, `[assets] binding = "ASSETS"`). */
export interface Assets {
  fetch(input: Request | URL | string): Promise<Response>;
}

/** The headers of a paper's page, the same as public/_headers gives the static ones (the
 *  Worker's answers do not get _headers'; a test checks that they agree). */
export const PAPER_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://www.ebi.ac.uk https://eutils.ncbi.nlm.nih.gov https://raw.githubusercontent.com https://gitlab.com https://bitbucket.org https://codeberg.org https://huggingface.co https://zenodo.org https://archive.softwareheritage.org; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "Referrer-Policy": "same-origin",
};

/** How long a browser keeps a page: the records change once a night. */
const CACHE = "public, max-age=600";

/** The headers public/_headers gives every file of the site (its "/*" block, 2026-09-29): the
 *  Worker's pages get them too, the 404 page as they are, a paper's page with PAPER_HEADERS over
 *  them (its own policy in place of the strict one). A test checks that they agree. */
export const SITE_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), browsing-topics=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

const html = (body: string | null, status: number, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE, ...SITE_HEADERS, ...extra },
  });

/** A file of the site, through the assets (no Worker request). html_handling may answer a
 *  "/x.html" with a redirect to "/x": followed once. (Also the removal requests' way to read a
 *  paper's facts, worker/contributions/index.ts.) */
export async function asset(assets: Assets, url: URL, path: string): Promise<Response> {
  const res = await assets.fetch(new Request(new URL(path, url)));
  const moved = res.headers.get("Location");
  if (res.status >= 300 && res.status < 400 && moved) return assets.fetch(new Request(new URL(moved, url)));
  return res;
}

/** The record of a paper rendered on demand, or undefined when the registry has none. */
export async function paperRecord(assets: Assets, url: URL, slug: string): Promise<PaperRecord | undefined> {
  const res = await asset(assets, url, `/records/paper/${await shardOf(slug, SHARDS.paper)}.json`);
  if (!res.ok) return undefined;
  const shard = (await res.json()) as Record<string, PaperRecord>;
  return Object.hasOwn(shard, slug) ? shard[slug] : undefined;
}

/** The build's module scripts (this site's files, never inline: the Content-Security-Policy
 *  allows no other) in a piece of HTML. */
const SCRIPT = /<script type="module" src="\/(?!\/)[^"<>]*"><\/script>/g;

/** A shell page (the build's HTML) with a view in place of <main>'s content, and its title,
 *  description and breadcrumb. The shell's scripts stay, after the view: the shell's own script
 *  (src/scripts/paper-shell.ts) then finds the view already there and runs the Contribute
 *  section's. The platform's name is the shell's own (<meta name="application-name">). null when
 *  the shell lacks what is replaced. */
export function fillShell(shell: string, view: View): string | null {
  const start = shell.indexOf("<main>");
  const end = shell.lastIndexOf("</main>");
  if (start < 0 || end < start || !/<title>[^<]*<\/title>/.test(shell)) return null;
  const site = shell.match(/<meta name="application-name" content="([^"]*)"/)?.[1] ?? "";
  const title = `${esc(view.title)}${site ? `: ${site}` : ""}`;
  const attr = (name: string, value: string) => (s: string) =>
    s.replace(new RegExp(`(<meta (?:name|property)="${name}" content=")[^"]*(")`), (_, a: string, b: string) => `${a}${esc(value)}${b}`);
  const scripts = (shell.slice(start, end).match(SCRIPT) ?? []).join("");
  let out = shell.slice(0, start + "<main>".length) + view.html + scripts + shell.slice(end);
  out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
  out = out.replace(/(<span id="crumb">)[^<]*(<\/span>)/, (_, a: string, b: string) => `${a}${esc(view.crumb)}${b}`);
  if (view.description) out = attr("og:description", view.description)(attr("description", view.description)(out));
  return attr("og:title", view.title)(out);
}

/** The site's 404 page, with its status. */
async function notFound(assets: Assets, url: URL, head: boolean): Promise<Response> {
  const res = await asset(assets, url, "/404.html");
  return html(head || !res.ok ? null : await res.text(), 404);
}

const PAPER = /^\/paper\/([^/]+)(\/code)?(\/?)$/;

/** A request that no static file answers. */
export async function handlePage(request: Request, assets: Assets | undefined): Promise<Response> {
  const url = new URL(request.url);
  const head = request.method === "HEAD";
  if (!assets) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && !head) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = url.pathname.match(PAPER);
  const slug = m ? keyOf("paper", m[1]) : "";
  // /paper/<slug>/code/: to the page itself, whether it is static or rendered here (which then
  // says whether the registry has it). No file answers it any more.
  if (m && slug && m[2]) return Response.redirect(new URL(`/paper/${slug}/${url.search}`, url).toString(), 301);
  const record = slug ? await paperRecord(assets, url, slug) : undefined;
  if (!m || !record) return notFound(assets, url, head);
  // /paper/<slug>: to the page itself.
  if (!m[3] || m[1] !== slug) return Response.redirect(new URL(`/paper/${slug}/`, url).toString(), 301);
  const shell = await asset(assets, url, "/paper/404.html");
  const page = shell.ok ? fillShell(await shell.text(), paperView(record)) : null;
  if (page === null) return new Response("This page could not be rendered.", { status: 500 });
  return html(head ? null : page, 200, PAPER_HEADERS);
}
