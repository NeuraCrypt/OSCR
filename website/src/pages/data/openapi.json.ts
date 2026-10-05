// /data/openapi.json: the OpenAPI 3.1 description of the public read API, built from the routes
// themselves (src/lib/apispec.ts). Directly fetchable; the Worker also serves it at
// /api/v1/openapi.json with the request's own origin as the server.
import type { APIRoute } from "astro";
import { buildOpenapi } from "../../lib/apispec";

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildOpenapi("https://openscicode.org")), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
