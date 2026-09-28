// Code lines and pairs, shared by the build (the file prerendered in the reader)
// and by the reader's browser (the files it loads on demand): both must number the
// lines and place the pairs in exactly the same way.

/** A match between a paragraph of the paper and a range of lines of a file; `whole` when the
 *  range is (nearly) the whole file: a weak match, whose lines are not tinted. */
export type Span = { pair: number; start: number; end: number; whole?: boolean };

/** The text of a file, one entry per line. Lines are numbered like the harvester
 *  (its `lines` field) and the forges do: split on "\n" only, a final newline does
 *  not open an extra line, and the "\r" of a Windows line ending is not shown. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** The color of a pair: six colors, used in turn (science.css, .pair-1 … .pair-6). */
export const pairClass = (pair: number) => `pair-${((((pair - 1) % 6) + 6) % 6) + 1}`;

/** A range that covers the whole file, or nearly (90 % of its lines at least): it ties the
 *  paragraph to the file, not to given lines — a weak match. */
export function wholeFile(start: number, end: number, lines: number | null | undefined): boolean {
  if (!lines || lines < 1) return false;
  const covered = Math.min(end, lines) - Math.max(start, 1) + 1;
  return covered >= Math.ceil(lines * 0.9);
}

/** Which pairs cover each line (line number → pair numbers, the pairs of given lines before
 *  the whole-file ones), the line that carries the link of each pair (the first non-blank line
 *  of its range), the pair whose color each line takes (`color`: the narrowest range of given
 *  lines over it, the most precise; else, on a line only whole-file pairs cover, the pair linked
 *  there), and the lines that only whole-file pairs cover (`weak`: not tinted). */
export function decorate(lines: string[], spans: Span[]) {
  const cover = new Map<number, number[]>();
  const link = new Map<number, number>();
  const color = new Map<number, number>();
  const whole = new Set(spans.filter((s) => s.whole).map((s) => s.pair));
  const width = new Map(spans.map((s) => [s.pair, Math.max(s.start, s.end) - s.start]));
  const order = [...spans].sort((x, y) => Number(!!x.whole) - Number(!!y.whole) || x.pair - y.pair);
  for (const s of order) {
    const from = Math.max(1, s.start);
    const to = Math.min(lines.length, Math.max(s.start, s.end));
    for (let n = from; n <= to; n++) {
      if (!cover.has(n)) cover.set(n, []);
      cover.get(n)!.push(s.pair);
    }
    for (let n = from; n <= to; n++) {
      if (lines[n - 1].trim() && !link.has(n)) {
        link.set(n, s.pair);
        break;
      }
    }
  }
  const weak = new Set<number>();
  for (const [n, ks] of cover) {
    const strong = ks.filter((k) => !whole.has(k));
    if (strong.length) color.set(n, strong.reduce((a, b) => (width.get(b)! < width.get(a)! ? b : a)));
    else {
      weak.add(n);
      color.set(n, link.get(n) ?? ks[0]);
    }
  }
  return { cover, link, color, weak };
}

/** The classes of a line: the color of its pair, and `whole` when only whole-file pairs cover it. */
export const lineClass = (pair: number | undefined, weak: boolean) => (pair ? `${pairClass(pair)}${weak ? " whole" : ""}` : undefined);

/** A piece of text, or a link. */
export type Part = string | { href: string; text: string };

/** A link to the exact lines at the source, when the forge has a syntax for it. */
export function sourceLines(url: string, start: number, end: number): string {
  if (!url || url.includes("#")) return url;
  const range = end > start ? [start, end] : [start];
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//.test(url)) return `${url}#${range.map((n) => `L${n}`).join("-")}`;
  if (/^https:\/\/codeberg\.org\/[^/]+\/[^/]+\/src\//.test(url)) return `${url}#${range.map((n) => `L${n}`).join("-")}`;
  if (/\/-\/blob\//.test(url)) return `${url}#L${range.join("-")}`;
  return url;
}
