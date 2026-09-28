// The search's query language, shared by the Worker (website/worker/search.ts turns a query
// into an FTS5 MATCH expression) and the search page (which highlights the words searched in
// the titles, and builds a query from the advanced form).
//
// What a reader may type:
//
//   eeg alpha                   both words (AND is implicit)
//   "working memory"            a phrase
//   eeg OR meg, eeg AND meg     operators, in capitals; AND binds tighter than OR
//   NOT meg, -meg               an exclusion
//   (eeg OR meg) alpha          parentheses
//   neuro*                      a prefix, of 3 characters at least
//   title:eeg author:"Smith J"  a field, before a word, a phrase or a group: title:(eeg OR meg).
//                               Fields: title, author, journal, keyword, mesh, tool, repo, id
//                               (DOI, PMID, PMCID, dataset, RRID), abstract.
//
// Whatever is typed ends up inside FTS5 double quotes: no input can inject FTS5 syntax, and the
// translation always yields a valid expression, or none. A query that FTS5 would find too costly
// is cut down (LIMITS), and the reader is told what was left out.

export type Field = "title" | "author" | "journal" | "keyword" | "mesh" | "tool" | "repo" | "id" | "abstract";

/** What may be written before a colon, and the field it means. */
export const FIELD_NAMES: Readonly<Record<string, Field>> = {
  title: "title",
  author: "author",
  authors: "author",
  journal: "journal",
  keyword: "keyword",
  keywords: "keyword",
  mesh: "mesh",
  tool: "tool",
  tools: "tool",
  repo: "repo",
  repository: "repo",
  code: "repo",
  id: "id",
  doi: "id",
  pmid: "id",
  pmcid: "id",
  abstract: "abstract",
};

/** The column of the full-text index (migrations/d1/search/) that each field searches. */
export const FIELD_COLUMNS: Readonly<Record<Field, string>> = {
  title: "title",
  author: "authors",
  journal: "journal",
  keyword: "keywords",
  mesh: "mesh",
  tool: "tools",
  repo: "repos",
  id: "ids",
  abstract: "abstract",
};

/** The columns a word without a field searches: all the text, not the filter tokens. */
export const TEXT_COLUMNS: readonly string[] = [
  "title", "keywords", "mesh", "authors", "journal", "repos", "tools", "ids", "abstract",
];

export const LIMITS = {
  /** Characters of a query. */
  chars: 500,
  /** Words and phrases. */
  terms: 24,
  /** Nested parentheses. */
  depth: 6,
  /** Prefix searches (neuro*), the costliest for the index. */
  prefixes: 4,
  /** Letters or digits before the star of a prefix. */
  prefixMin: 3,
} as const;

export type Node =
  | { t: "word"; text: string; prefix: boolean; field?: Field }
  | { t: "phrase"; text: string; prefix: boolean; field?: Field }
  | { t: "and"; items: Node[] }
  | { t: "or"; items: Node[] }
  | { t: "not"; item: Node }
  | { t: "group"; item: Node; field: Field };

export type Parsed = { node: Node | null; notices: string[] };

type Tok =
  | { k: "word"; text: string }
  | { k: "phrase"; text: string; prefix: boolean }
  | { k: "field"; field: Field }
  | { k: "lp" }
  | { k: "rp" }
  | { k: "and" }
  | { k: "or" }
  | { k: "not" };

const QUOTES = new Set(['"', "“", "”", "„", "«", "»"]);
const SPACE = /\s/;
const ALNUM = /[\p{L}\p{N}]/u;

function lex(s: string, notices: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (SPACE.test(c)) {
      i += 1;
    } else if (c === "(") {
      toks.push({ k: "lp" });
      i += 1;
    } else if (c === ")") {
      toks.push({ k: "rp" });
      i += 1;
    } else if (QUOTES.has(c)) {
      let j = i + 1;
      while (j < s.length && !QUOTES.has(s[j])) j += 1;
      if (j >= s.length) notices.push("A quote was not closed: it was closed at the end of the query.");
      const text = s.slice(i + 1, j);
      i = j + 1;
      const prefix = s[i] === "*";
      if (prefix) i += 1;
      toks.push({ k: "phrase", text, prefix });
    } else if (c === "-" && i + 1 < s.length && !SPACE.test(s[i + 1]) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      // "-meg", "-(a b)", -"a b", -title:x: an exclusion. A hyphen inside a word (mne-python)
      // stays in the word.
      toks.push({ k: "not" });
      i += 1;
    } else {
      let j = i;
      while (j < s.length && !SPACE.test(s[j]) && s[j] !== "(" && s[j] !== ")" && !QUOTES.has(s[j])) j += 1;
      let word = s.slice(i, j);
      i = j;
      const field = /^([A-Za-z]+):(.*)$/s.exec(word);
      if (field && FIELD_NAMES[field[1].toLowerCase()]) {
        toks.push({ k: "field", field: FIELD_NAMES[field[1].toLowerCase()] });
        word = field[2];
        if (!word) continue; // title:"…" or title:(…): what follows is the next token
        toks.push({ k: "word", text: word });
        continue;
      }
      if (word === "AND" || word === "&&") toks.push({ k: "and" });
      else if (word === "OR" || word === "||") toks.push({ k: "or" });
      else if (word === "NOT") toks.push({ k: "not" });
      else toks.push({ k: "word", text: word.startsWith("+") ? word.slice(1) : word });
    }
  }
  return toks;
}

/** A word as the index knows it: a web address loses its scheme ("https://github.com/a/b" →
 *  "github.com/a/b"), a doi.org address becomes its DOI, and stray stars go. */
function cleanWord(text: string): string {
  let w = text.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "").replace(/^https?:\/\/(?:www\.)?/i, "");
  w = w.replace(/\*/g, " ").trim();
  return w;
}

class Parser {
  private pos = 0;
  private terms = 0;
  private prefixes = 0;
  private readonly toks: Tok[];
  private readonly notices: string[];
  constructor(toks: Tok[], notices: string[]) {
    this.toks = toks;
    this.notices = notices;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  parse(): Node | null {
    const parts: Node[] = [];
    while (this.pos < this.toks.length) {
      const before = this.pos;
      const n = this.parseOr(0);
      if (n) parts.push(n);
      if (this.peek()?.k === "rp" || this.pos === before) this.pos += 1; // a stray ")"
    }
    return parts.length === 0 ? null : parts.length === 1 ? parts[0] : { t: "and", items: parts };
  }

  private parseOr(depth: number): Node | null {
    const items: Node[] = [];
    const first = this.parseAnd(depth);
    if (first) items.push(first);
    while (this.peek()?.k === "or") {
      this.pos += 1;
      const next = this.parseAnd(depth);
      if (next) items.push(next);
    }
    return items.length === 0 ? null : items.length === 1 ? items[0] : { t: "or", items };
  }

  private parseAnd(depth: number): Node | null {
    const items: Node[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.k === "or" || t.k === "rp") break;
      if (t.k === "and") {
        this.pos += 1;
        continue;
      }
      const u = this.parseUnary(depth);
      if (u) items.push(u);
    }
    return items.length === 0 ? null : items.length === 1 ? items[0] : { t: "and", items };
  }

  private parseUnary(depth: number): Node | null {
    let negate = false;
    while (this.peek()?.k === "not") {
      this.pos += 1;
      negate = !negate;
    }
    const p = this.parsePrimary(depth, undefined);
    if (!p) return null;
    return negate ? { t: "not", item: p } : p;
  }

  private parsePrimary(depth: number, field: Field | undefined): Node | null {
    const t = this.peek();
    if (!t || t.k === "or" || t.k === "rp" || t.k === "and" || t.k === "not") {
      // An operator where a word was expected ("title: OR x", "NOT NOT", "a NOT"): skipped.
      if (t && t.k !== "rp") this.pos += 1;
      return null;
    }
    this.pos += 1;
    if (t.k === "field") return this.parsePrimary(depth, t.field);
    if (t.k === "lp") {
      const inner = depth + 1 >= LIMITS.depth ? this.flat(depth) : this.parseOr(depth + 1);
      if (this.peek()?.k === "rp") this.pos += 1;
      if (!inner) return null;
      return field ? { t: "group", item: inner, field } : inner;
    }
    const text = t.k === "phrase" ? t.text.replace(/\*/g, " ").trim() : cleanWord(t.text);
    let prefix = t.k === "phrase" ? t.prefix : t.text.endsWith("*");
    if (!ALNUM.test(text)) return null;
    if (this.terms >= LIMITS.terms) {
      if (this.terms === LIMITS.terms) this.notices.push(`Only the first ${LIMITS.terms} words and phrases were searched.`);
      this.terms += 1;
      return null;
    }
    this.terms += 1;
    if (prefix) {
      const last = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).pop() ?? "";
      if ([...last].length < LIMITS.prefixMin) {
        this.notices.push(`A prefix needs ${LIMITS.prefixMin} letters at least: “${text}*” was searched as a whole word.`);
        prefix = false;
      } else if (this.prefixes >= LIMITS.prefixes) {
        this.notices.push(`Only ${LIMITS.prefixes} prefixes (word*) are searched per query: “${text}*” was searched as a whole word.`);
        prefix = false;
      } else {
        this.prefixes += 1;
      }
    }
    return { t: t.k === "phrase" ? "phrase" : "word", text, prefix, ...(field ? { field } : {}) };
  }

  /** Past the nesting limit, the rest of a group is read as plain words. */
  private flat(depth: number): Node | null {
    this.notices.push(`Parentheses nested more than ${LIMITS.depth} deep were ignored.`);
    const items: Node[] = [];
    let open = 1;
    while (this.pos < this.toks.length) {
      const t = this.peek()!;
      if (t.k === "lp") open += 1;
      if (t.k === "rp" && --open === 0) break;
      if (t.k === "word" || t.k === "phrase") {
        const p = this.parsePrimary(depth, undefined);
        if (p) items.push(p);
      } else {
        this.pos += 1;
      }
    }
    return items.length === 0 ? null : items.length === 1 ? items[0] : { t: "and", items };
  }
}

/** Read a query, tolerantly: an unbalanced quote or parenthesis, a dangling operator or an
 *  unknown field never fails; `notices` says what was changed. */
export function parseQuery(input: string): Parsed {
  const notices: string[] = [];
  let text = input ?? "";
  if (text.length > LIMITS.chars) {
    text = text.slice(0, LIMITS.chars);
    notices.push(`Only the first ${LIMITS.chars} characters of the query were read.`);
  }
  const node = new Parser(lex(text, notices), notices).parse();
  return { node, notices };
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The FTS5 MATCH expression of a query: every word inside double quotes, with its columns.
 *  `all` is the token every row carries (ALL_TOKEN in facets.ts): a query of exclusions only
 *  ("NOT meg") keeps every paper but those. */
export function toMatch(node: Node, all: string): string {
  const everything = `{facets} : ${quote(all)}`;
  const columns = (field?: Field) => `{${field ? FIELD_COLUMNS[field] : TEXT_COLUMNS.join(" ")}}`;
  const ser = (n: Node, field?: Field): string => {
    switch (n.t) {
      case "word":
      case "phrase":
        return `${columns(n.field ?? field)} : ${quote(n.text)}${n.prefix ? "*" : ""}`;
      case "group":
        return ser(n.item, n.field);
      case "not":
        return `(${everything} NOT ${ser(n.item, field)})`;
      case "or":
        return `(${n.items.map((i) => ser(i, field)).join(" OR ")})`;
      case "and": {
        const positive = n.items.filter((i) => i.t !== "not").map((i) => ser(i, field));
        const negative = n.items.flatMap((i) => (i.t === "not" ? [ser(i.item, field)] : []));
        let out = positive.length === 0 ? everything : positive.length === 1 ? positive[0] : `(${positive.join(" AND ")})`;
        for (const x of negative) out = `(${out} NOT ${x})`;
        return out;
      }
    }
  };
  return ser(node);
}

export type Term = { text: string; prefix: boolean };

/** The words and phrases searched in the titles (neither excluded nor limited to another
 *  field): what the search page highlights. */
export function titleTerms(node: Node | null): Term[] {
  const out: Term[] = [];
  const walk = (n: Node, field?: Field) => {
    if (n.t === "not") return;
    if (n.t === "group") return walk(n.item, n.field);
    if (n.t === "and" || n.t === "or") return n.items.forEach((i) => walk(i, field));
    const f = n.field ?? field;
    if (!f || f === "title") out.push({ text: n.text, prefix: n.prefix });
  };
  if (node) walk(node);
  return out;
}

/** A character as the index compares it: without its accents, in lower case. */
const fold = (ch: string) => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const isWordChar = (ch: string | undefined) => ch !== undefined && ALNUM.test(ch);

/** The title cut into pieces, `mark` on the words searched: as FTS5 matches them, whole words
 *  (or word beginnings for a prefix), without regard to case and accents. */
export function highlight(title: string, terms: Term[]): { text: string; mark: boolean }[] {
  const chars = [...title];
  const folded = chars.map(fold);
  const marked = new Array<boolean>(chars.length).fill(false);
  const words = terms.flatMap((t) => {
    const parts = t.text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => [...w].map(fold).join(""));
    return parts.map((w, k) => ({ w, prefix: t.prefix && k === parts.length - 1 }));
  });
  for (let i = 0; i < chars.length; i += 1) {
    if (!isWordChar(chars[i]) || isWordChar(chars[i - 1])) continue;
    let end = i;
    while (end < chars.length && isWordChar(chars[end])) end += 1;
    const word = folded.slice(i, end).join("");
    for (const { w, prefix } of words) {
      if (prefix ? word.startsWith(w) : word === w) {
        for (let k = i; k < end; k += 1) marked[k] = true;
      }
    }
  }
  const out: { text: string; mark: boolean }[] = [];
  chars.forEach((ch, i) => {
    const last = out[out.length - 1];
    if (last && last.mark === marked[i]) last.text += ch;
    else out.push({ text: ch, mark: marked[i] });
  });
  return out;
}

/** The query a field means, for the masthead's "where to search" and the advanced form:
 *  ("title", "eeg alpha") → "title:(eeg alpha)". */
export function fielded(field: Field, text: string): string {
  const t = text.trim();
  if (!t) return "";
  return /^"[^"]*"$/.test(t) || !/\s/.test(t) ? `${field}:${t}` : `${field}:(${t})`;
}
