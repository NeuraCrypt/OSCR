// The classification's vocabulary (oscr/vocabulary/categories.json, the harvester's own: the facets,
// their values, definitions and examples; decisions D6 and D7), read when the site is built, with
// each value's count from the export's categories (src/lib/entities.ts). The taxonomy page's data.
import vocabulary from "../../../oscr/vocabulary/categories.json";
import { categories, facets } from "./entities";

type Value = { value: string; id: string; name: string; definition: string; examples?: string[]; aliases?: string[] };
type Facet = { name: string; multi: boolean; definition: string; values: Value[] };
type Vocabulary = { version: string; about: string; facets: Record<string, Facet> };

export const VOCABULARY = vocabulary as unknown as Vocabulary;

/** Whether a paper is in scope: the vocabulary's definition of neuroscience (facet `on_topic`). */
export const SCOPE = VOCABULARY.facets.on_topic;

/** The facets the site shows (Browse, the search's filters): every facet but `on_topic`, each value
 *  with its definition, examples, the papers with a page it counts, and its Browse page. Values the
 *  export holds but the vocabulary does not (an older label) follow, with their counts. */
export const TAXONOMY = Object.entries(VOCABULARY.facets)
  .filter(([facet]) => facet !== "on_topic")
  .map(([facet, spec]) => {
    const found = categories.facets[facet] ?? {};
    const shown = new Map((facets.find((f) => f.facet === facet)?.values ?? []).map((v) => [v.value, v]));
    const known = new Set(spec.values.map((v) => v.value));
    return {
      facet,
      name: spec.name,
      multi: spec.multi,
      definition: spec.definition,
      values: spec.values.map((v) => ({
        ...v,
        papers: found[v.value]?.counts.papers ?? 0,
        withCode: found[v.value]?.counts.with_code ?? 0,
        url: shown.get(v.value)?.url ?? "",
      })),
      others: Object.entries(found)
        .filter(([value]) => !known.has(value))
        .map(([value, c]) => ({ value, name: c.name || value, papers: c.counts.papers, withCode: c.counts.with_code, url: shown.get(value)?.url ?? "" })),
    };
  });
