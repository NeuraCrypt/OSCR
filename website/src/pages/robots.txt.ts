// robots.txt: robots may read every page, and the sitemap lists the pages to index (the others say
// noindex in their own HTML: src/lib/seo.ts NOINDEX_PATHS). The Worker's routes (/api/…) and
// the search's results (/search/?…) are left out: each costs a request of the site's daily free quota
// (a robot that runs a page's scripts would spend it), and search results are not pages to index.
// The API's own page, /api/ (linked from every page's footer), stays open: "$" ends the address, so
// the rule names that page alone (src/lib/seo.ts robotsBlocks reads the rules the same way).
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) =>
  new Response(
    ["User-agent: *", "Allow: /api/$", "Disallow: /api/", "Disallow: /search/?", "", `Sitemap: ${new URL("/sitemap.xml", site).href}`, ""].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
