// A repository's settings as authorized actions (budget W3: at most 2 rows plus the action row):
// rename, description and homepage, topics, features, template flag, default branch, archive and
// unarchive, transfer (pending until the new owner accepts).
//
// STUB, created by the foundation (F) of phase 01 and owned by E4, which fills it with the specs of
// rename, edit, topics, features, template, default_branch, archive, unarchive and transfer
// (types.ts ActionSpec; the payloads and rows: docs/FORGE.md). Until then the array is empty, and
// start answers 400 for these kinds (no such action).

import type { AnyActionSpec } from "./types.ts";

export const SETTINGS_ACTIONS: readonly AnyActionSpec[] = [];
