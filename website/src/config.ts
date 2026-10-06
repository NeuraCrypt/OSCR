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

/** Who operates the platform, as the privacy page and the terms name them: the operator's name
 *  and postal address (the data controller's, under the GDPR). Empty until the owner fills them,
 *  here or at build time (OPERATOR_NAME=… OPERATOR_ADDRESS=… npm run build): the pages then say
 *  that they are published before the public launch, and `npm run check` prints a launch warning. */
export const OPERATOR_NAME: string = import.meta.env.OPERATOR_NAME || "Yann V. Bellec";
export const OPERATOR_ADDRESS: string = import.meta.env.OPERATOR_ADDRESS || "2024 2nd Ave N Ste C, Ground Floor, Birmingham, AL 35203, USA";

/** The platform's source code, public (Apache-2.0): the About page, the footer, the policies. */
export const SOURCE_URL = "https://github.com/NeuraCrypt/OSCR";

/** Night phase 16: Turnstile's site key (public), written into the forms that need the human check
 *  (reports, appeals, research issues and comments, profiles, lists, tokens, webhooks, data-rights
 *  requests). Set at build time (`TURNSTILE_SITE_KEY=… npm run build`, or website/.env); unset, those
 *  forms say the check is not set up and cannot be sent. Its secret is a Cloudflare secret, never here. */
export const TURNSTILE_SITE_KEY: string = import.meta.env.TURNSTILE_SITE_KEY || "0x4AAAAAAFPa5GcnoA1H5hKL";
