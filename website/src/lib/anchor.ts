// The pairs placed in a copy of the paper numbered differently: when Europe PMC does not answer,
// the reader's browser reads PubMed Central's copy of the same article (NCBI), whose paragraphs
// may not be numbered like Europe PMC's (a statement, a list or a box more or less). A pair
// names its paragraph by number, its section's title and a few short terms of it (its
// `evidence`): it stays on its number when that paragraph has its section and its terms, and
// otherwise goes to the paragraph that has the most of its terms (its section's first); a pair
// no paragraph fits is left out, and the pane says how many. Pure: tested in
// tests/reader.test.ts.

/** A paragraph of the copy read: its section's titles ("Methods › Spike sorting") and its text. */
export type CopyParagraph = { section: string; text: string };
export type Placeable = { pair: number; paragraph: number; section: string; evidence: string[] };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** How many of the terms the text holds. */
function held(terms: string[], text: string): number {
  let n = 0;
  for (const t of terms) if (t && text.includes(t)) n += 1;
  return n;
}

/** Where each pair goes in the copy (pair → paragraph index), and how many moved or were left. */
export function placePairs(pairs: Placeable[], copy: CopyParagraph[]): { at: Map<number, number>; moved: number; lost: number } {
  const paras = copy.map((p) => ({ section: norm(p.section), text: norm(p.text) }));
  const at = new Map<number, number>();
  let moved = 0;
  let lost = 0;
  for (const p of pairs) {
    const terms = [...new Set(p.evidence.map(norm).filter(Boolean))];
    const section = norm(p.section);
    const need = terms.length ? Math.max(1, Math.ceil(terms.length / 2)) : 0;
    const fits = (i: number) => {
      const q = paras[i];
      return !!q && (!section || q.section === section) && held(terms, q.text) >= need;
    };
    // The paragraph with the most of its terms (its section first), the nearest to its number
    // on a tie; its own number when that paragraph fits and holds as many. Without terms, a pair
    // cannot be told from its neighbours: it keeps its number if that paragraph fits.
    let best = -1;
    let score = -1;
    if (terms.length) {
      paras.forEach((q, i) => {
        const s = held(terms, q.text) * 2 + (section && q.section === section ? 1 : 0);
        const closer = best >= 0 && s === score && Math.abs(i - p.paragraph) < Math.abs(best - p.paragraph);
        if (s > score || closer) {
          best = i;
          score = s;
        }
      });
    }
    const own = fits(p.paragraph) ? held(terms, paras[p.paragraph].text) : -1;
    if (own >= 0 && (best < 0 || own >= held(terms, paras[best].text))) {
      at.set(p.pair, p.paragraph);
      continue;
    }
    const enough = best >= 0 && held(terms, paras[best].text) >= Math.max(need, Math.ceil(terms.length * 0.6));
    if (enough) {
      at.set(p.pair, best);
      if (best !== p.paragraph) moved += 1;
    } else lost += 1;
  }
  return { at, moved, lost };
}
