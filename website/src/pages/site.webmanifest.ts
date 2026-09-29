// The web app manifest (the icons a phone uses for a bookmark on its home screen): the platform's
// name from SITE_NAME and SITE_TAGLINE (src/config.ts), the logo's icons (public/, made from the
// owner's logo: public/brand/). One file.
import type { APIRoute } from "astro";
import { SITE_NAME, SITE_TAGLINE } from "../config";

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      name: SITE_TAGLINE,
      short_name: SITE_NAME,
      start_url: "/",
      display: "browser",
      background_color: "#ffffff",
      theme_color: "#1f3b4d",
      icons: [
        { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    }),
    { headers: { "Content-Type": "application/manifest+json" } },
  );
