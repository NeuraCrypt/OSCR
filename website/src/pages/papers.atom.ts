// /papers.atom: the newest papers with their authors' code, as an Atom feed (docs/BADGE_OUTREACH.md
// "Altmetric"): one file, the newest FEED_PAPERS, rebuilt with the site. A reader's feed reader, or a
// service that follows new research (Altmetric), reads it; it names no person and no address.
import type { APIRoute } from "astro";
import { SITE_NAME } from "../config";
import { withPage } from "../lib/catalog";
import { newestFirst } from "../lib/lists";

/** How many papers the feed holds. */
export const FEED_PAPERS = 100;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (d: string) => (/^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(0, 10)}T00:00:00Z` : "1970-01-01T00:00:00Z");

export const GET: APIRoute = ({ site }) => {
  const base = new URL("/", site);
  const papers = newestFirst(withPage.filter((a) => a.code.length > 0)).slice(0, FEED_PAPERS);
  const entries = papers.map((a) => {
    const page = new URL(`/paper/${a.slug}/`, base).href;
    const repos = a.code.length === 1 ? "one code repository" : `${a.code.length} code repositories`;
    return [
      "  <entry>",
      `    <title>${esc(a.title ?? "")}</title>`,
      `    <link rel="alternate" type="text/html" href="${esc(page)}"/>`,
      a.doi ? `    <link rel="related" href="${esc(`https://doi.org/${a.doi}`)}"/>` : "",
      `    <id>${esc(page)}</id>`,
      `    <updated>${day(a.published ?? "")}</updated>`,
      `    <summary>${esc(`${a.journal ? `${a.journal}. ` : ""}The authors' code, verified on ${SITE_NAME}: ${repos}.${a.doi ? ` doi:${a.doi}` : ""}`)}</summary>`,
      "  </entry>",
    ].filter(Boolean).join("\n");
  });
  const self = new URL("/papers.atom", base).href;
  const body = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${esc(SITE_NAME)}: new papers with their code</title>`,
    `  <link rel="self" type="application/atom+xml" href="${esc(self)}"/>`,
    `  <link rel="alternate" type="text/html" href="${esc(base.href)}"/>`,
    `  <id>${esc(self)}</id>`,
    `  <updated>${papers.length ? day(papers[0].published ?? "") : "1970-01-01T00:00:00Z"}</updated>`,
    `  <author><name>${esc(SITE_NAME)}</name></author>`,
    ...entries,
    "</feed>",
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "application/atom+xml; charset=utf-8" } });
};
