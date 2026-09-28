// POST /api/forge/start: the first half of one authorized action (D00-2). The signed-in person says
// what they want done ({kind, payload}); the Worker checks it (the kind, the payload, the gate, the
// caps) and answers the address of GitHub's authorization page, with a signed state bound to the
// action and to the session.
//
// STUB, created by the foundation (F) of phase 01 and owned by E1, which builds it: until then it
// answers 501 not_built. The contract (the route, its body, its answers): docs/FORGE.md.

import { notBuilt } from "./http.ts";
import type { ForgeRequest } from "./types.ts";

export async function handleStart(_r: ForgeRequest): Promise<Response> {
  return notBuilt("start");
}
