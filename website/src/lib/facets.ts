// The search's facets, shared by the Worker (website/worker/) and the search page. The Mac
// writes the same codes and tokens (oscr/d1.py, FACETS and facet_token): a test on each side
// checks that they agree.
//
// A facet is a URL parameter (`/search/?modality=eeg&tool=MNE-Python`). In the full-text index,
// each value of a paper is a token of the `facets` column: "zz" + the facet's code + the first
// 12 hexadecimal characters of the SHA-1 of the normalized value. A filter is then a MATCH on
// that column, and several values of one facet are OR-ed, different facets AND-ed.

export type Facet = {
  /** The URL parameter, and the key of the API's `facets`. */
  param: string;
  /** Two letters: the token prefix and the code in the index's `fx` column. */
  code: string;
  /** The heading shown on the search page. */
  label: string;
  /** How many values the counts keep (the most frequent first; years: all, newest first). */
  top: number;
};

export const FACETS: readonly Facet[] = [
  { param: "status", code: "st", label: "Status", top: 12 },
  { param: "year", code: "yr", label: "Year", top: 40 },
  { param: "modality", code: "mo", label: "Modality", top: 12 },
  { param: "organism", code: "or", label: "Organism", top: 12 },
  { param: "population", code: "po", label: "Population", top: 12 },
  { param: "subfield", code: "sf", label: "Subfield", top: 12 },
  { param: "tool", code: "to", label: "Tool", top: 12 },
  { param: "language", code: "la", label: "Code language", top: 12 },
  { param: "journal", code: "jo", label: "Journal", top: 12 },
  { param: "data", code: "ds", label: "Dataset repository", top: 12 },
  { param: "host", code: "ho", label: "Code host", top: 12 },
  { param: "code_license", code: "cl", label: "Code license", top: 12 },
  { param: "type", code: "ty", label: "Article type", top: 12 },
  { param: "license", code: "li", label: "Article license", top: 12 },
  { param: "matches", code: "al", label: "Code ↔ Paper matches", top: 12 },
  { param: "oa", code: "oa", label: "Open access", top: 12 },
];

export const FACET_BY_PARAM: ReadonlyMap<string, Facet> = new Map(FACETS.map((f) => [f.param, f]));
export const FACET_BY_CODE: ReadonlyMap<string, Facet> = new Map(FACETS.map((f) => [f.code, f]));

/** The token every row of the index carries: a query made of filters or dates only, or of
 *  exclusions only, starts from it. */
export const ALL_TOKEN = "zzall";

/** A value as it is hashed: Unicode NFKC, spaces collapsed, lower case. `journal=neuroimage`
 *  finds "NeuroImage". The same rule as normalize_value in oscr/d1.py. */
export function normalizeValue(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The index token of one value of one facet. */
export async function facetToken(code: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(normalizeValue(value)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `zz${code}${hex.slice(0, 12)}`;
}
