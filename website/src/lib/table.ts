// CSV and TSV files as tables in the registry's viewer (night phase 02, E5), as GitHub shows them:
// the first row as the header, the rows numbered, a filter, and a sentence when a row has another
// number of columns than the header. Pure, no DOM, testable in Node (tests/forge-pages/table.test.ts).
// Every cell is text (masked for email addresses by the view trees); nothing in a cell is a formula
// or markup.

import { type El, h } from "./repo-view.ts";

/** What the table shows at most (GitHub: 512 KB, then a preview). */
export const TABLE_LIMITS = { rows: 1_000, cellChars: 2_000 } as const;

/** Whether a path is a table the viewer draws, and its delimiter. */
export function tableDelimiter(path: string): "," | "\t" | null {
  if (/\.csv$/i.test(path)) return ",";
  if (/\.(?:tsv|tab)$/i.test(path)) return "\t";
  return null;
}

export interface Parsed {
  rows: string[][];
  /** The first row whose number of columns differs from the header's (1-based, the header is 1). */
  ragged: { row: number; columns: number; expected: number } | null;
  /** A quoted field that never closes. */
  unclosed: boolean;
  /** Whether rows were left out past the limit. */
  more: number;
}

/** RFC 4180: fields separated by the delimiter, rows by CR LF, LF or CR; a field in double quotes
 *  may hold the delimiter, line breaks and "" for a quote. At most `maxRows` rows are kept. */
export function parseDelimited(text: string, delimiter: string, maxRows = TABLE_LIMITS.rows + 1): Parsed {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atStart = true;
  let total = 0;
  let unclosed = false;
  const endRow = () => {
    // A blank line is no row.
    if (!row.length && field === "" && !quoted) {
      atStart = true;
      return;
    }
    row.push(field);
    field = "";
    atStart = true;
    total++;
    if (rows.length < maxRows) rows.push(row);
    row = [];
  };
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      atStart = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      atStart = false;
    }
  }
  if (quoted) {
    unclosed = true;
    quoted = false;
    row.push(field);
    field = "";
    total++;
    if (rows.length < maxRows) rows.push(row);
  } else if (field !== "" || row.length) endRow();
  const expected = rows[0]?.length ?? 0;
  let ragged: Parsed["ragged"] = null;
  for (let k = 1; k < rows.length && !ragged; k++) if (rows[k].length !== expected) ragged = { row: k + 1, columns: rows[k].length, expected };
  return { rows, ragged, unclosed, more: Math.max(0, total - rows.length) };
}

const clip = (s: string) => (s.length > TABLE_LIMITS.cellChars ? `${s.slice(0, TABLE_LIMITS.cellChars)}…` : s);
const numeric = (s: string) => /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*%?\s*$/.test(s);

/** The table's view: the sentences (a ragged row, a cut), a filter, then the table with the rows
 *  numbered; a column of numbers is aligned right. */
export function tableView(parsed: Parsed): El {
  const [header = [], ...body] = parsed.rows.slice(0, TABLE_LIMITS.rows + 1);
  const width = Math.max(header.length, ...body.map((r) => r.length));
  const numericCol = Array.from({ length: width }, (_, c) => body.length > 0 && body.every((r) => r[c] === undefined || r[c] === "" || numeric(r[c])));
  const cls = (c: number) => (numericCol[c] ? "num" : null);
  const notes: El[] = [];
  if (parsed.ragged) notes.push(h("p", { class: "warning" }, `Row ${parsed.ragged.row} has ${parsed.ragged.columns} ${parsed.ragged.columns === 1 ? "column" : "columns"}, not ${parsed.ragged.expected} as the header: the table may read wrongly, the source is exact.`));
  if (parsed.unclosed) notes.push(h("p", { class: "warning" }, "A quoted field never closes: the table may read wrongly, the source is exact."));
  const shown = body.length;
  const all = shown + parsed.more;
  if (parsed.more > 0) notes.push(h("p", null, `The first ${shown.toLocaleString("en-GB")} rows of ${all.toLocaleString("en-GB")} are shown; the source has them all.`));
  return h(
    "div",
    { class: "data-table" },
    ...notes,
    h("p", { class: "table-filter" }, h("label", { for: "table-filter" }, "Filter the rows "), h("input", { type: "search", id: "table-filter", autocomplete: "off", spellcheck: "false", placeholder: "Text in any cell" }), " ", h("span", { id: "table-count", "aria-live": "polite" }, `${shown.toLocaleString("en-GB")} ${shown === 1 ? "row" : "rows"}`)),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        { class: "data" },
        h("thead", null, h("tr", null, h("th", { class: "row-num" }, "#"), ...Array.from({ length: width }, (_, c) => h("th", { class: cls(c) }, clip(header[c] ?? ""))))),
        h("tbody", null, ...body.map((r, k) => h("tr", { id: `row-${k + 2}` }, h("td", { class: "row-num" }, String(k + 1)), ...Array.from({ length: width }, (_, c) => h("td", { class: cls(c) }, clip(r[c] ?? "")))))),
      ),
    ),
  );
}
