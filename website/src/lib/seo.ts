// What search engines are told about each page (2026-11-08, after Google Search Console listed pages
// as duplicates without a canonical, soft 404s, pages with a redirect and pages excluded by noindex
// or by robots.txt). Shared by the layout (src/layouts/Base.astro), the browser's shell scripts
// (src/scripts/entity.ts, src/scripts/paper-shell.ts), the Worker (worker/pages.ts) and the check
// (scripts/check.mjs). Nothing here reads a file or the network.
//
// - Every page indexed has ONE <link rel="canonical">: an absolute https address of the site, no
//   "www.", a trailing slash, no query and no fragment (canonicalHref). The same page also answers
//   at the free workers.dev address and at variants of its address (an author's iD in lower case):
//   the canonical names the one address to index.
// - A shell (one page served for many addresses: an entity's, a paper rendered on demand, the
//   GitHub side's) carries no canonical in its HTML, since the HTML alone cannot know the address it
//   answers. The Worker writes it into a paper's page; the browser's script writes an entity's once
//   the entity is found. Such a page carries <meta name="site-origin"> for them to read the site's
//   own address.
// - NOINDEX_PATHS lists the pages kept out of search engines on purpose: the signed-in reader's own
//   pages, the forms, the search, the 404 page and the GitHub side's shells (dormant behind
//   FORGE_OPEN, one shell for any address, empty for an unknown one). None is in the sitemap.

/** The pages that carry <meta name="robots" content="noindex"> in their HTML, by path. */
export const NOINDEX_PATHS: readonly string[] = [
  // The 404 page (the Worker also answers it with the status 404).
  "/404/",
  // The search: a form, and its results depend on the query (robots.txt also keeps /search/?… out).
  "/search/",
  // The signed-in reader's own pages and the forms.
  "/account/", "/account/moderation/", "/account/security/", "/data-rights/", "/device/", "/feed/", "/forge/authorized/",
  "/moderation/", "/new/", "/new/import/", "/new/link/", "/notifications/", "/organizations/", "/removal/", "/report/",
  "/repositories/", "/settings/blocked/", "/settings/hooks/", "/settings/preferences/", "/settings/tokens/", "/stars/",
  "/submit/",
  // The GitHub side's shells (public/_redirects serves each for every address under it).
  "/r/", "/research/", "/snippets/", "/u/",
];

/** The pages whose HTML is a shell for many addresses: no canonical in the HTML (see above). The
 *  shell of the papers rendered on demand is built at /paper/404/ (dist/paper/404.html). */
export const SHELL_PATHS: readonly string[] = [
  "/404/", "/paper/404/", "/author/", "/journal/", "/institution/", "/tool/", "/dataset/", "/r/", "/research/", "/snippets/", "/u/",
];

/** A page's path as these lists name it: "/about/index.html", "/about" → "/about/"; "/404.html" → "/404/". */
export function pagePath(path: string): string {
  let p = path.split(/[?#]/)[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/index\.html$/, "/").replace(/\.html$/, "/");
  return p.endsWith("/") ? p : `${p}/`;
}

export const isNoindexPath = (path: string) => NOINDEX_PATHS.includes(pagePath(path));
export const isShellPath = (path: string) => SHELL_PATHS.includes(pagePath(path));

/** The address search engines should index for a path of the site: https, no "www.", the site's
 *  host, a trailing slash (but on a file such as /papers.atom), no query, no fragment. */
export function canonicalHref(site: string | URL, path: string): string {
  const url = new URL(path, site);
  url.protocol = "https:";
  url.hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
  url.port = "";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/") && !/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += "/";
  return url.href;
}

/** The canonical link of a page, as the layout and the Worker write it. */
export const canonicalTag = (href: string) => `<link rel="canonical" href="${href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;

/** The robots tag of a page kept out of search engines. */
export const NOINDEX_TAG = '<meta name="robots" content="noindex">';

/** Every canonical address a page's HTML names. */
export const canonicalsOf = (html: string): string[] =>
  [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

/** The page's HTML keeps it out of search engines. */
export const hasNoindex = (html: string): boolean => /<meta\s+name="robots"\s+content="[^"]*\bnoindex\b/i.test(html);

/** The site's address named by a shell's <meta name="site-origin">, else the one it was served from. */
export function siteOrigin(doc: Document): string {
  return doc.querySelector<HTMLMetaElement>('meta[name="site-origin"]')?.content || doc.location.origin;
}

/** The browser's side: give the page this canonical address (one link, replaced if there is one). */
export function setCanonical(doc: Document, href: string): void {
  let link = doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!link) {
    link = doc.createElement("link");
    link.rel = "canonical";
    doc.head.append(link);
  }
  link.href = href;
}

/** The browser's side: keep the page out of search engines (an unknown entity, a missing paper). */
export function setNoindex(doc: Document): void {
  doc.querySelector('link[rel="canonical"]')?.remove();
  if (doc.querySelector('meta[name="robots"]')) return;
  const robots = doc.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex";
  doc.head.append(robots);
}

/** Does robots.txt keep a path from every robot ("User-agent: *")? Google's rules: the longest
 *  matching rule wins, Allow over Disallow on a tie; "*" matches any characters, "$" ends the path. */
export function robotsBlocks(robots: string, path: string): boolean {
  const rules: { allow: boolean; rx: RegExp; length: number }[] = [];
  let forAll = false;
  let inAgents = false;
  for (const raw of robots.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!inAgents) forAll = false;
      inAgents = true;
      if (value === "*") forAll = true;
      continue;
    }
    inAgents = false;
    if (!forAll || (field !== "allow" && field !== "disallow") || value === "") continue;
    const body = value.endsWith("$") ? value.slice(0, -1) : value;
    const rx = new RegExp(`^${body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${value.endsWith("$") ? "$" : ""}`);
    rules.push({ allow: field === "allow", rx, length: value.length });
  }
  let best: { allow: boolean; length: number } | undefined;
  for (const r of rules) {
    if (!r.rx.test(path)) continue;
    if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
  }
  return best !== undefined && !best.allow;
}
