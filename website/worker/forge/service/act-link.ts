// The mirror mode (D00-2): linking an existing public repository the person administers or
// maintains (mode 'installed' when the App is on it, 'public' otherwise; a private one is refused
// and its name never stored), and adding or removing its paper links. 20 links per account a day.
//
// STUB, created by the foundation (F) of phase 01 and owned by E3, which fills it with the specs of
// link and papers (types.ts ActionSpec; the payloads and rows: docs/FORGE.md). Until then the array is empty,
// and start answers 400 for these kinds (no such action).

import type { AnyActionSpec } from "./types.ts";

export const LINK_ACTIONS: readonly AnyActionSpec[] = [];
