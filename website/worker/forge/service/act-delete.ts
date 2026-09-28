// Deletion (D00-10): the request archives on GitHub and hides in OSCR for GRACE_SECONDS (30 days,
// a delete_due job); restore within that time; the final deletion only as the person's own fresh
// authorization, never a timer. And the Software Heritage request (D00-15): an archive job.
//
// STUB, created by the foundation (F) of phase 01 and owned by E4, which fills it with the specs of
// delete_request, restore, delete_final and software_heritage (types.ts ActionSpec; the payloads and rows: docs/FORGE.md). Until then the array is empty,
// and start answers 400 for these kinds (no such action).

import type { AnyActionSpec } from "./types.ts";

export const DELETE_ACTIONS: readonly AnyActionSpec[] = [];
