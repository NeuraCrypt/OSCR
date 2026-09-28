// The registry's badge (Phase 6): ONE static image for every paper — the site holds at most 20,000
// files, so there is no badge per paper — a flat rectangle, never a rounded pill, with the
// platform's name (SITE_NAME) and what it says of the paper. The README's snippet makes it a link
// to the paper's page (src/components/paper/Contribute.astro).
import type { APIRoute } from "astro";
import { SITE_NAME } from "../config";

/** What the badge says after the platform's name. */
const SAYS = "paper ↔ code";
/** Colours of the image (not of the site's pages): the masthead's, and a dark grey. */
const LEFT = "#555555";
const RIGHT = "#1f3b4d";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Verdana at 11 px is about 7 px a character: each part is sized for its text, which fits it exactly (textLength). */
const width = (text: string) => Math.round(Array.from(text).length * 7 + 12);

function badge(name = SITE_NAME, says = SAYS): string {
  const left = width(name);
  const right = width(says);
  const total = left + right;
  const label = `${name}: ${says}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escape(label)}">`,
    `<title>${escape(label)}</title>`,
    `<rect width="${left}" height="20" fill="${LEFT}"/>`,
    `<rect x="${left}" width="${right}" height="20" fill="${RIGHT}"/>`,
    `<g fill="#ffffff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`,
    `<text x="${left / 2}" y="14" textLength="${left - 12}" lengthAdjust="spacingAndGlyphs">${escape(name)}</text>`,
    `<text x="${left + right / 2}" y="14" textLength="${right - 12}" lengthAdjust="spacingAndGlyphs">${escape(says)}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

export const GET: APIRoute = () =>
  new Response(badge(), { headers: { "Content-Type": "image/svg+xml; charset=utf-8" } });
