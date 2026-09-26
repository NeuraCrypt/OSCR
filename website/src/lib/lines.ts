// Code lines and pairs, shared by the build (the file prerendered in the reader)
// and by the reader's browser (the files it loads on demand): both must number the
// lines and place the pairs in exactly the same way.
import { plural } from "./format";

/** A match between a paragraph of the paper and a range of lines of a file. */
export type Span = { pair: number; start: number; end: number };

/** The text of a file, one entry per line. Lines are numbered like the harvester
 *  (its `lines` field) and the forges do: split on "\n" only, a final newline does
 *  not open an extra line, and the "\r" of a Windows line ending is not shown. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** The color of a pair: six soft colors, used in turn (science.css, .pair-1 … .pair-6). */
export const pairClass = (pair: number) => `pair-${((((pair - 1) % 6) + 6) % 6) + 1}`;

/** Which pairs cover each line (line number → pair numbers), and the line that
 *  carries the link of each pair: the first non-blank line of its range. */
export function decorate(lines: string[], spans: Span[]) {
  const cover = new Map<number, number[]>();
  const link = new Map<number, number>();
  for (const s of [...spans].sort((x, y) => x.pair - y.pair)) {
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
  return { cover, link };
}

/** A piece of text, or a link. */
export type Part = string | { href: string; text: string };

/** The line under the file selector: what is shown, under which license, and where
 *  the source is. `block` is a whole repository whose files are read at the source. */
export function fileInfo(
  v: { block: boolean; language?: string; lines?: number | null; truncated?: boolean; text?: boolean; source?: string },
  r: { name: string; url: string; license: string },
): Part[] {
  const license = r.license || "no license";
  if (v.block) return [`${r.name} · ${license} · not republished here: `, { href: r.url, text: "open the repository" }];
  const what = [v.language || "Text", v.lines ? plural(v.lines, "line") : "", r.name, license].filter(Boolean).join(" · ");
  const source = v.source || r.url;
  if (!v.text) return [`${what} · not republished here: `, { href: source, text: "read it at the source" }];
  const parts: Part[] = [`${what} · `, { href: source, text: "at the source" }];
  if (v.truncated) parts.push(" · shortened here: the full file is at the source");
  return parts;
}

/** A link to the exact lines at the source, when the forge has a syntax for it. */
export function sourceLines(url: string, start: number, end: number): string {
  if (!url || url.includes("#")) return url;
  const range = end > start ? [start, end] : [start];
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//.test(url)) return `${url}#${range.map((n) => `L${n}`).join("-")}`;
  if (/^https:\/\/codeberg\.org\/[^/]+\/[^/]+\/src\//.test(url)) return `${url}#${range.map((n) => `L${n}`).join("-")}`;
  if (/\/-\/blob\//.test(url)) return `${url}#L${range.join("-")}`;
  return url;
}
