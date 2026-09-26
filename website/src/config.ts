// The name of the platform is not final: it lives HERE, and nowhere else in the
// website. Every page, title, meta tag and sentence that names the platform takes it
// from this module. Change it at build time without touching the code:
//
//   SITE_NAME=… SITE_TAGLINE=… npm run build
//
// Build-time only (Astro frontmatter): the browser scripts never name the platform.

/** The short name: the masthead, the breadcrumb, the end of every <title>. */
export const SITE_NAME: string = import.meta.env.SITE_NAME || "OSCR";

/** The long form of the name, where there is room for it. When only SITE_NAME is
 *  changed, the long form follows it, so that no stale name remains anywhere. */
export const SITE_TAGLINE: string =
  import.meta.env.SITE_TAGLINE || (import.meta.env.SITE_NAME ? SITE_NAME : "Open Scientific Code Registry");

/** "OSCR (Open Scientific Code Registry)", or the name alone when there is no long form. */
export const SITE_FULL_NAME = SITE_TAGLINE === SITE_NAME ? SITE_NAME : `${SITE_NAME} (${SITE_TAGLINE})`;
