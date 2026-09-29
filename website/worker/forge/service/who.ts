// Who asks a route the site and the public API share (night phase 10, E2): the person behind the
// token the API router found (api.ts sets `r.principal` after bearer.ts, its scope and its rate limit),
// or else the session of the site's own pages (account/guard.ts `signedIn`: for a POST, the site's
// Origin and the session's CSRF token too).
//
// The routes that read it (read.ts, research.ts, social.ts, inbox.ts) are then one code for both: the
// same validation, the same FORGE_OPEN, the same caps and the same rows, whichever way a person asks.
// The authorized actions on GitHub (start, act, asset) never read a principal: they need the person's
// own authorization on GitHub, in their browser, one action at a time (D00-4).

import { signedIn, type SignedIn } from "../../account/guard.ts";
import type { ForgeRequest } from "./types.ts";

export function who(r: ForgeRequest, a: { post: boolean; touch: boolean }): Promise<SignedIn | Response> {
  if (r.principal) return Promise.resolve(r.principal);
  return signedIn(r.request, r.env, r.t, a);
}
