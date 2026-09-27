// A paper's status in words, shared by the build and by the reader's browser (the DOI
// lookup): a status is said in words, with the tone of science.css (`ok`, `warning`),
// never with a pill.

/** The status, in words; `tone` is `ok`, `warning` or nothing (science.css). */
export const STATUSES: Record<string, { label: string; tone: "ok" | "warning" | "" }> = {
  code_verified: { label: "code verified", tone: "ok" },
  code_found: { label: "code found, not verified yet", tone: "warning" },
  code_empty: { label: "empty repository", tone: "warning" },
  code_dead: { label: "dead link", tone: "warning" },
  on_request: { label: "code on request", tone: "" },
  data_only: { label: "data only", tone: "" },
  none: { label: "no code", tone: "" },
  no_fulltext: { label: "full text unavailable", tone: "" },
};
export const status = (s: string) => STATUSES[s] ?? { label: s.replace(/_/g, " "), tone: "" as const };

/** The statuses of the papers that have a page (the owner's decision D2). */
export const PAGE_STATUSES = new Set(["code_verified", "code_found", "code_empty", "code_dead", "on_request", "data_only"]);
