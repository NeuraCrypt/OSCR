// POST /api/forge/webhook: GitHub's deliveries for the mirror mode (the design's §8, §17). Not
// signed in and not gated by FORGE_OPEN. The body refused over WEBHOOK_BYTES (413) before any
// hashing; the signature checked in constant time with GITHUB_APP_WEBHOOK_SECRET (401; 503 when the
// secret is unset); the allowlisted events recorded in at most 2 rows with their delivery row
// (store.ts deliveryRow, deliverySeen: a redelivery writes nothing); no email address copied.
//
// STUB, created by the foundation (F) of phase 01 and owned by E3, which builds it: until then it
// answers 501 not_built. The contract (the route, its body, its answers, the rows it writes):
// docs/FORGE.md.

import { notBuilt } from "./http.ts";
import type { ForgeRequest } from "./types.ts";

export async function handleWebhook(_r: ForgeRequest): Promise<Response> {
  return notBuilt("webhook");
}
