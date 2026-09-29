// robots.txt: every page may be indexed, and the sitemap lists them. The Worker's routes (/api/) and
// the search's results (/search/?…) are left out: each costs a request of the site's daily free quota
// (a robot that runs a page's scripts would spend it), and search results are not pages to index.
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) =>
  new Response(
    ["User-agent: *", "Disallow: /api/", "Disallow: /search/?", "", `Sitemap: ${new URL("/sitemap.xml", site).href}`, ""].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
