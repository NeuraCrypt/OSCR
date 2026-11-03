// The platform's name, for the badges the Worker draws (worker/badge.ts): the Worker never names the
// platform itself, so that the name stays in one configuration variable (SITE_NAME, src/config.ts).
import type { APIRoute } from "astro";
import { SITE_NAME, SITE_TAGLINE } from "../../config";

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ name: SITE_NAME, tagline: SITE_TAGLINE }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
