// POST /api/forge/act: the second half of one authorized action. The page GitHub sent the person
// back to posts {code, state}; the Worker exchanges the code for a token used once and never
// stored, checks the person on GitHub, performs the action and writes OSCR's rows.
//
// STUB, created by the foundation (F) of phase 01 and owned by E1, which builds it: until then it
// answers 501 not_built. The contract (the route, its body, its answers, the rows it writes):
// docs/FORGE.md.

import { notBuilt } from "./http.ts";
import type { ForgeRequest } from "./types.ts";

export async function handleAct(_r: ForgeRequest): Promise<Response> {
  return notBuilt("act");
}
