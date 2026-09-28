// Branches as authorized actions: create (from a branch, a tag or a commit), rename (GitHub
// retargets pull requests and the default branch), delete (never the default branch).
//
// STUB, created by the foundation (F) of phase 01 and owned by E4, which fills it with the specs of
// branch_create, branch_rename and branch_delete (types.ts ActionSpec; the payloads and rows: docs/FORGE.md). Until then the array is empty,
// and start answers 400 for these kinds (no such action).

import type { AnyActionSpec } from "./types.ts";

export const REF_ACTIONS: readonly AnyActionSpec[] = [];
