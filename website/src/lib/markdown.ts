// One renderer for GitHub Flavored Markdown (night phase 02, E2): READMEs, Markdown files, a
// notebook's text cells, and later the conversations of phases 04 to 06. Pure, no DOM, no
// dependency, testable in Node (tests/forge-pages/markdown.test.ts).
//
// Safe by construction: the result is a view tree (repo-view.ts `h`), never an HTML string. Raw HTML
// in a file goes through GitHub's tag filter here: the tags GitHub keeps and nothing that runs or
// embeds (script, style, iframe, object, embed, form, video, audio, svg, math… are dropped with
// their content); the attributes a tag may carry are listed (href, src, alt, title, width, height,
// open, start, colspan, rowspan, align → a class); `style` and `class` of the authors are dropped,
// so science.css stays the only style; ids carry "user-content-" so none clobbers the page's own.
// Links go through the context's resolver (relative paths to this viewer at the same commit,
// GitHub's addresses of a repository to this viewer too: the owner's rule of 2026-09-29), then
// repo-view.ts safeHref (no javascript:, no data:, no address with "@": no email address hides in
// a link); every text is masked for email addresses.
//
// What it renders: headings with their anchors and the outline, paragraphs, line breaks, emphasis,
// strong, strikethrough, <sub>, <sup>, <ins>, <kbd>, code spans, fenced and indented code
// (highlighted with highlight.js), block quotes and alerts ([!NOTE], [!TIP], [!IMPORTANT],
// [!WARNING], [!CAUTION]), lists, task lists, tables with their alignment, thematic breaks,
// footnotes, collapsed sections (<details>), links (inline, reference, autolinks, bare URLs),
// images (the repository's own read as bytes; an external image is a link the reader follows, never
// loaded by the page: D02-6), dark-only images dropped (no dark theme), HTML comments hidden,
// backslash escapes, entities, emoji shortcodes, math (inline $…$ and $`…`$, blocks $$…$$ and
// ```math, macros: mathml.ts), and scholarly identifiers as links (DOI, arXiv, PMID, PMCID, ORCID
// iD, RRID, SWHID) and full commit ids as links to the commit in this viewer.
// What it shows as source, with a sentence: Mermaid, GeoJSON, TopoJSON and STL blocks (drawing them
// needs inline styles or a map service the pages' policy does not allow: D02-8).

import { EMAIL_MASK, maskEmails } from "../../worker/forge/mask.ts";
import { forgeLinks } from "../../worker/forge/github/links.ts";
import { joinRelative } from "./code-nav.ts";
import { isOwner, isRepoName, repoPath, type RepoCoords } from "./forge.ts";
import { detectLanguage, highlightText, LANGUAGES, type LineNodes } from "./highlight.ts";
import { type Macros, texToMathml } from "./mathml.ts";
import { type Child, type El, h, safeHref, textOf } from "./repo-view.ts";

type Tag = Parameters<typeof h>[0];

export interface MarkdownContext {
  /** A link as written in the file → the address the page gives it, or null (the text stays). The
   *  default keeps https addresses and in-page anchors only. */
  resolveLink?: (href: string) => string | null;
  /** A relative image → the repository path the page reads it from (the script fills the image
   *  from its bytes), or null. */
  resolveImage?: (src: string) => string | null;
  /** The repository, for full commit ids as links. */
  repo?: RepoCoords | null;
  /** Macros defined by the document's math, kept from formula to formula. */
  macros?: Macros;
  /** No highlighting (a very large document). */
  plainCode?: boolean;
  /** The file at the source: the last resort for what the viewer cannot draw (a Mermaid diagram). */
  sourceUrl?: string;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Rendered {
  el: El;
  headings: Heading[];
  /** Relative images the page must read: their repository paths. */
  images: string[];
}

export const USER_CONTENT = "user-content-";

// ─── blocks ──────────────────────────────────────────────────────────────────

type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "math"; tex: string }
  | { t: "quote"; children: Block[]; alert: string | null }
  | { t: "list"; ordered: boolean; start: number; loose: boolean; items: { task: boolean | null; children: Block[] }[] }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; header: string[]; rows: string[][] }
  | { t: "hr" }
  | { t: "html"; text: string };

interface Doc {
  links: Map<string, { href: string; title: string | null }>;
  footnotes: Map<string, Block[]>;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^( {0,3})([-*+])( {1,4}|\t|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])( {1,4}|\t|$)(.*)$/;
const TABLE_DELIM = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FOOTDEF = /^ {0,3}\[\^([^\]\s]{1,100})\]:\s?(.*)$/;
const LINKDEF = /^ {0,3}\[([^\]]{1,999})\]:\s*<?([^\s>]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/;
const HTML_START = /^ {0,3}(?:<!--|<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$))/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;

const blank = (l: string) => /^\s*$/.test(l);
const indentOf = (l: string) => l.length - l.replace(/^ +/, "").length;

/** Whether a line starts a block that interrupts a paragraph. */
function interrupts(line: string): boolean {
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || /^ {0,3}\$\$/.test(line) || (BULLET.test(line) && !blank(line.replace(BULLET, "$4"))) || /^ {0,3}1[.)] /.test(line) || (HTML_START.test(line) && BLOCK_TAGS.has((HTML_START.exec(line)?.[1] ?? "").toLowerCase())) || /^ {0,3}<!--/.test(line);
}

function parseBlocks(lines: string[], doc: Doc, depth = 0): Block[] {
  const out: Block[] = [];
  let i = 0;
  if (depth > 30) return [{ t: "para", text: lines.join("\n") }];
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    // Fenced code (and ```math)
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
        i++;
      }
      i++;
      const lang = fence[2].toLowerCase();
      out.push(lang === "math" ? { t: "math", tex: body.join("\n") } : { t: "code", lang, text: body.join("\n") });
      continue;
    }
    // $$ … $$
    const dollars = /^ {0,3}\$\$(.*)$/.exec(line);
    if (dollars) {
      const rest = dollars[1];
      const close = rest.lastIndexOf("$$");
      if (close >= 0) {
        out.push({ t: "math", tex: rest.slice(0, close) });
        i++;
        continue;
      }
      const body: string[] = [rest];
      i++;
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) body.push(lines[i++].replace(/\$\$\s*$/, ""));
      out.push({ t: "math", tex: body.join("\n") });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ t: "heading", level: atx[1].length, text: (atx[2] ?? "").trim() });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (!blank(lines[i]) && body.length && !blank(body[body.length - 1]) && !interrupts(lines[i])))) {
        body.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(body[0] ?? "");
      out.push({ t: "quote", alert: alert ? alert[1].toLowerCase() : null, children: parseBlocks(alert ? body.slice(1) : body, doc, depth + 1) });
      continue;
    }
    const item = BULLET.exec(line) ?? ORDERED.exec(line);
    if (item) {
      const r = parseList(lines, i, doc, depth);
      out.push(r.block);
      i = r.next;
      continue;
    }
    const footdef = FOOTDEF.exec(line);
    if (footdef) {
      const body = [footdef[2]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (blank(l)) {
          if (i + 1 < lines.length && indentOf(lines[i + 1]) >= 4) {
            body.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) >= 4) body.push(l.slice(4));
        else if (!interrupts(l) && !FOOTDEF.test(l) && !LINKDEF.test(l) && !blank(lines[i - 1])) body.push(l);
        else break;
        i++;
      }
      if (!doc.footnotes.has(footdef[1])) doc.footnotes.set(footdef[1], parseBlocks(body, doc, depth + 1));
      continue;
    }
    const linkdef = LINKDEF.exec(line);
    if (linkdef) {
      const label = linkdef[1].trim().toLowerCase().replace(/\s+/g, " ");
      if (!label.startsWith("^") && !doc.links.has(label)) doc.links.set(label, { href: linkdef[2], title: linkdef[3] ?? linkdef[4] ?? linkdef[5] ?? null });
      i++;
      continue;
    }
    if (HTML_START.test(line)) {
      const body: string[] = [];
      if (/^ {0,3}<!--/.test(line)) {
        while (i < lines.length) {
          body.push(lines[i]);
          if (lines[i].includes("-->")) {
            i++;
            break;
          }
          i++;
        }
      } else {
        while (i < lines.length && !blank(lines[i])) body.push(lines[i++]);
      }
      out.push({ t: "html", text: body.join("\n") });
      continue;
    }
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || blank(lines[i]))) body.push(lines[i++].replace(/^ {4}/, ""));
      while (body.length && blank(body[body.length - 1])) body.pop();
      out.push({ t: "code", lang: "", text: body.join("\n") });
      continue;
    }
    // A table: a header row, then its delimiter row.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        return t.startsWith(":") && t.endsWith(":") ? "center" : t.endsWith(":") ? "right" : t.startsWith(":") ? "left" : null;
      });
      if (align.length === header.length) {
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && !blank(lines[i]) && lines[i].includes("|") && !interrupts(lines[i])) {
          const cells = splitRow(lines[i++]);
          rows.push(header.map((_, k) => cells[k] ?? ""));
        }
        out.push({ t: "table", align, header, rows });
        continue;
      }
    }
    // A paragraph (or a setext heading).
    const para: string[] = [line];
    i++;
    while (i < lines.length && !blank(lines[i])) {
      // A setext underline first ("------" is also a thematic break, which a paragraph yields to).
      const setext = SETEXT.exec(lines[i]);
      if (!setext && interrupts(lines[i])) break;
      if (setext) {
        out.push({ t: "heading", level: setext[1][0] === "=" ? 1 : 2, text: para.join(" ").trim() });
        para.length = 0;
        i++;
        break;
      }
      if (lines[i].includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) break;
      para.push(lines[i++]);
    }
    if (para.length) out.push({ t: "para", text: para.join("\n") });
  }
  return out;
}

function parseList(lines: string[], start: number, doc: Doc, depth: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start]) ?? ORDERED.exec(lines[start])!;
  const ordered = !BULLET.test(lines[start]);
  const bulletChar = ordered ? (first[3] as string) : (first[2] as string);
  const items: { task: boolean | null; children: Block[] }[] = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
    if (!m) break;
    const sameKind = ordered ? m[3] === bulletChar : m[2] === bulletChar;
    if (!sameKind) break;
    const indent = m[1].length;
    const marker = ordered ? m[2].length + 1 : 1;
    const gap = ordered ? m[4] : m[3];
    const firstText = ordered ? m[5] : m[4];
    const content = indent + marker + (gap.length > 4 || gap === "" ? 1 : gap === "\t" ? 2 : gap.length);
    const body: string[] = [firstText];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        sawBlank = true;
        body.push("");
        i++;
        continue;
      }
      if (indentOf(l) >= content) {
        body.push(l.slice(content));
        i++;
        continue;
      }
      if (!sawBlank && !interrupts(l) && !BULLET.test(l) && !ORDERED.test(l)) {
        body.push(l.trimStart());
        i++;
        continue;
      }
      break;
    }
    const sameListNext = () => {
      const next = i < lines.length ? (ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i])) : null;
      return !!next && (ordered ? next[3] === bulletChar : next[2] === bulletChar);
    };
    while (body.length && blank(body[body.length - 1])) {
      body.pop();
      if (sameListNext()) loose = true;
    }
    if (body.some((b, k) => k > 0 && blank(b) && k < body.length - 1)) loose = true;
    let task: boolean | null = null;
    const t = /^\[([ xX])\](?:\s+|$)/.exec(body[0] ?? "");
    if (t) {
      task = t[1] !== " ";
      body[0] = body[0].slice(t[0].length);
    }
    items.push({ task, children: parseBlocks(body, doc, depth + 1) });
    if (i < lines.length && blank(lines[i - 1] ?? "x") && !(BULLET.test(lines[i]) || ORDERED.test(lines[i]))) break;
  }
  return { block: { t: "list", ordered, start: ordered ? Number(first[2]) : 1, loose, items }, next: i };
}

/** A table row's cells: split on "|" outside code spans and escapes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      code = code ? 0 : 1;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// ─── HTML: GitHub's tag filter ───────────────────────────────────────────────

/** Tags whose element and content are dropped. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "textarea", "select", "button",
  "video", "audio", "canvas", "link", "meta", "base", "frame", "frameset", "applet", "title", "head", "input", "option", "xmp",
  "plaintext", "noembed", "noframes", "portal", "dialog", "slot",
]);

/** Tags kept (the rest are dropped, their content kept). */
const KEEP = new Set([
  "a", "b", "i", "em", "strong", "s", "del", "ins", "u", "sub", "sup", "kbd", "samp", "var", "code", "q", "cite", "dfn", "abbr",
  "small", "mark", "br", "img", "p", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "ul", "ol",
  "li", "dl", "dt", "dd", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "details", "summary", "figure",
  "figcaption", "picture", "source", "center", "tt", "strike", "time",
]);

/** Block-level tags that interrupt a paragraph as HTML blocks. */
const BLOCK_TAGS = new Set([
  "div", "p", "details", "summary", "table", "thead", "tbody", "tr", "th", "td", "ul", "ol", "li", "dl", "dt", "dd", "h1", "h2",
  "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "figure", "figcaption", "picture", "center", "img", "a", "br", "section",
  "article", "aside", "nav", "header", "footer", "main", "caption", "tfoot", "sub", "sup", "kbd", "b", "i", "em", "strong", "span",
]);

const VOID = new Set(["br", "img", "hr", "source", "wbr", "input", "meta", "link", "col", "area", "base", "embed", "param", "track"]);
const RENAME: Record<string, string> = { center: "div", tt: "code", strike: "del" };

interface HtmlTok {
  kind: "open" | "close" | "text" | "comment";
  tag?: string;
  attrs?: Record<string, string>;
  selfClosing?: boolean;
  text?: string;
}

const TAG_RE = /^<(\/)?([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/)?>/;
const ATTR_RE = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** The attributes of a tag, their names lowered, their values' entities decoded. */
function attrsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** HTML text into tags, text and comments (a tolerant reading: anything that is not a tag is text). */
export function htmlTokens(html: string): HtmlTok[] {
  const out: HtmlTok[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push({ kind: "text", text: html.slice(i) });
      break;
    }
    if (lt > i) out.push({ kind: "text", text: html.slice(i, lt) });
    const rest = html.slice(lt);
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->");
      out.push({ kind: "comment" });
      i = end < 0 ? html.length : lt + end + 3;
      continue;
    }
    const m = TAG_RE.exec(rest);
    if (!m) {
      out.push({ kind: "text", text: "<" });
      i = lt + 1;
      continue;
    }
    out.push({ kind: m[1] ? "close" : "open", tag: m[2].toLowerCase(), attrs: m[1] ? {} : attrsOf(m[3] ?? ""), selfClosing: !!m[4] });
    i = lt + m[0].length;
  }
  return out;
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: String.fromCharCode(160), copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—",
  ndash: "–", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×", divide: "÷", plusmn: "±",
  deg: "°", micro: "µ", middot: "·", bull: "•", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", le: "≤", ge: "≥",
  ne: "≠", asymp: "≈", infin: "∞", sum: "∑", prod: "∏", minus: "−", sect: "§", para: "¶", dagger: "†", euro: "€", pound: "£",
  yen: "¥", cent: "¢", alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ", mu: "μ", pi: "π", sigma: "σ",
  tau: "τ", phi: "φ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω", check: "✓", ensp: " ", emsp: " ", thinsp: " ", shy: "",
};

/** Entities decoded: named (a common list), decimal and hexadecimal; code point 0, surrogates and
 *  numbers past Unicode become U+FFFD. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (all, dec, hex, name) => {
    if (name) return NAMED[name] ?? all;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return String.fromCharCode(0xfffd);
    return String.fromCodePoint(cp);
  });
}

// ─── the renderer ────────────────────────────────────────────────────────────

const EMOJI: Record<string, number> = {
  tada: 0x1f389, rocket: 0x1f680, warning: 0x26a0, white_check_mark: 0x2705, heavy_check_mark: 0x2714, x: 0x274c, bulb: 0x1f4a1,
  memo: 0x1f4dd, book: 0x1f4d6, books: 0x1f4da, star: 0x2b50, sparkles: 0x2728, bug: 0x1f41b, wrench: 0x1f527, hammer: 0x1f528,
  construction: 0x1f6a7, fire: 0x1f525, zap: 0x26a1, package: 0x1f4e6, computer: 0x1f4bb, chart_with_upwards_trend: 0x1f4c8,
  microscope: 0x1f52c, test_tube: 0x1f9ea, dna: 0x1f9ec, brain: 0x1f9e0, earth_americas: 0x1f30e, "+1": 0x1f44d, thumbsup: 0x1f44d,
  "-1": 0x1f44e, thumbsdown: 0x1f44e, heart: 0x2764, smile: 0x1f604, point_right: 0x1f449, link: 0x1f517, information_source: 0x2139,
  exclamation: 0x2757, question: 0x2753, lock: 0x1f512, calendar: 0x1f4c6, clipboard: 0x1f4cb, mag: 0x1f50d, gear: 0x2699,
  hourglass: 0x231b, pushpin: 0x1f4cc, snake: 0x1f40d, eyes: 0x1f440, stop_sign: 0x1f6d1, no_entry: 0x26d4, new: 0x1f195,
  arrow_right: 0x27a1, arrow_up: 0x2b06, arrow_down: 0x2b07, bar_chart: 0x1f4ca, floppy_disk: 0x1f4be, file_folder: 0x1f4c1,
};

/** ISO 7064 11,2: the check digit of an ORCID iD. */
export function orcidValid(id: string): boolean {
  const digits = id.replace(/-/g, "");
  if (!/^\d{15}[\dX]$/.test(digits)) return false;
  let total = 0;
  for (const c of digits.slice(0, 15)) total = (total + Number(c)) * 2;
  const r = (12 - (total % 11)) % 11;
  return (r === 10 ? "X" : String(r)) === digits[15];
}

/** GFM's end of a bare address: trailing punctuation is not part of it, nor a ")" that closes
 *  nothing inside it ("https://x.org/a_(b)" keeps its ")"; "(see https://x.org/a)" does not). */
function trimAddress(s: string): string {
  let out = s;
  for (;;) {
    const last = out[out.length - 1];
    if (/[?!.,:;*_~'"]/.test(last)) out = out.slice(0, -1);
    else if (last === ")" && (out.match(/\)/g)?.length ?? 0) > (out.match(/\(/g)?.length ?? 0)) out = out.slice(0, -1);
    else return out;
  }
}

/** Scholarly identifiers and commit ids in a text, as links. `trim` cuts a match to what is
 *  linked (bare addresses); `href` gets the linked text. */
const AUTO: { re: RegExp; trim?: (s: string) => string; href: (m: RegExpMatchArray, repo: RepoCoords | null | undefined, shown: string) => string | null }[] = [
  { re: /\b(?:doi|DOI):\s?(10\.\d{4,9}\/[^\s"<>]*[^\s"<>.,;:)\]])/, href: (m) => `https://doi.org/${m[1]}` },
  { re: /\barXiv:\s?(\d{4}\.\d{4,5}(?:v\d{1,3})?|[a-z-]{2,20}(?:\.[A-Z]{2})?\/\d{7})\b/, href: (m) => `https://arxiv.org/abs/${m[1]}` },
  { re: /\bPMID:?\s?(\d{1,9})\b/, href: (m) => `https://pubmed.ncbi.nlm.nih.gov/${m[1]}/` },
  { re: /\b(PMC\d{4,10})\b/, href: (m) => `https://pmc.ncbi.nlm.nih.gov/articles/${m[1]}/` },
  { re: /\bRRID:\s?([A-Za-z]{2,20}_[A-Za-z0-9_:-]{2,40})\b/, href: (m) => `https://scicrunch.org/resolver/RRID:${m[1]}` },
  { re: /\b(swh:1:(?:cnt|dir|rev|rel|snp|ori):[0-9a-f]{40}(?:;[a-z]+=[^\s;<>"]+)*)/, href: (m) => `https://archive.softwareheritage.org/${m[1]}` },
  { re: /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/, href: (m) => (orcidValid(m[1]) ? `https://orcid.org/${m[1]}` : null) },
  { re: /\b([0-9a-f]{40})\b/, href: (m, repo) => (repo ? repoPath(repo, "commit", [m[1]]) : null) },
  { re: /(?<![\w/.@-])(https?:\/\/[^\s<>"]*[^\s<>".,;:!?\]'*_~])/, trim: trimAddress, href: (_m, _r, shown) => shown },
  { re: /(?<![\w/.@-])(www\.[A-Za-z0-9-]+\.[^\s<>"]*[^\s<>".,;:!?\]'*_~])/, trim: trimAddress, href: (_m, _r, shown) => `https://${shown}` },
];

const slugOf = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-")
    .slice(0, 100);

const ALERTS: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

const LANG_ALIASES: Record<string, string> = {
  py: "Python", python3: "Python", ipython: "Python", sh: "Shell", bash: "Shell", zsh: "Shell", shell: "Shell", console: "Shell",
  shellsession: "Shell", js: "JavaScript", ts: "TypeScript", "c++": "C++", cpp: "C++", cxx: "C++", rs: "Rust", rb: "Ruby",
  yml: "YAML", md: "Markdown", tex: "TeX", latex: "TeX", html: "HTML", xml: "XML", jl: "Julia", m: "MATLAB", matlab: "MATLAB",
  octave: "MATLAB", f90: "Fortran", fortran: "Fortran", r: "R", rscript: "R", dockerfile: "Dockerfile", docker: "Dockerfile",
  make: "Makefile", makefile: "Makefile", ps1: "PowerShell", powershell: "PowerShell", bat: "Batchfile", cmd: "Batchfile",
  toml: "TOML", ini: "INI", json: "JSON", jsonc: "JSON", diff: "Diff", patch: "Diff", sql: "SQL", stan: "Stan", nf: "Nextflow",
  snakemake: "Snakemake", cmake: "CMake", go: "Go", golang: "Go", java: "Java", kotlin: "Kotlin", scala: "Scala", swift: "Swift",
  csharp: "C#", "c#": "C#", cs: "C#", php: "PHP", perl: "Perl", lua: "Lua", haskell: "Haskell", hs: "Haskell", ocaml: "OCaml",
  css: "CSS", scss: "SCSS", mathematica: "Wolfram Language", wolfram: "Wolfram Language", sas: "SAS", stata: "Stata",
};

/** A fenced block's info string → Linguist's language name, or null. */
export function fenceLanguage(info: string): string | null {
  const l = info.trim().toLowerCase().split(/[\s{,]/)[0];
  if (!l) return null;
  return LANG_ALIASES[l] ?? LANGUAGES.find((x) => x.toLowerCase() === l) ?? detectLanguage(`x.${l}`);
}

const DIAGRAMS: Record<string, string> = {
  mermaid: "A Mermaid diagram: the viewer shows its source (drawing it needs styles the pages' policy does not allow).",
  geojson: "A GeoJSON map: the viewer shows its data (a map needs a tile service outside the registry).",
  topojson: "A TopoJSON map: the viewer shows its data (a map needs a tile service outside the registry).",
  stl: "An STL 3D model: the viewer shows its source.",
};

class Renderer {
  headings: Heading[] = [];
  images: string[] = [];
  private seen = new Map<string, number>();
  private footRefs: string[] = [];
  private codeJobs: { el: El; text: string; language: string | null }[] = [];
  private ctx: MarkdownContext;
  private doc: Doc;
  private macros: Macros;
  constructor(ctx: MarkdownContext, doc: Doc) {
    this.ctx = ctx;
    this.doc = doc;
    this.macros = ctx.macros ?? new Map();
  }

  // ── links ──

  link(href: string): string | null {
    const raw = decodeEntities(href.trim());
    if (!raw) return null;
    if (this.ctx.resolveLink) {
      const r = this.ctx.resolveLink(raw);
      return r === null ? null : safeHref(r);
    }
    if (raw.startsWith("#")) return safeHref(`#${USER_CONTENT}${slugOf(decodeURIComponent(raw.slice(1)))}`);
    return /^https?:\/\//i.test(raw) ? safeHref(raw) : null;
  }

  private anchor(href: string | null, kids: Child[], title?: string | null): El | Child[] {
    if (!href) return kids;
    const external = /^https?:\/\//.test(href);
    return h("a", { href, title: title ?? null, rel: external ? "nofollow ugc noopener" : null }, ...kids);
  }

  /** An image: the repository's own (read by the page), or an external one as a link. */
  image(src: string, alt: string, title?: string | null, attrs: Record<string, string> = {}): El | null {
    let s = decodeEntities(src.trim());
    if (/#gh-dark-mode-only$/.test(s)) return null;
    s = s.replace(/#gh-light-mode-only$/, "");
    const path = this.ctx.resolveImage ? this.ctx.resolveImage(s) : null;
    if (path) {
      if (this.images.length < 50) this.images.push(path);
      const size: Record<string, string> = {};
      for (const k of ["width", "height"] as const) if (/^\d{1,4}%?$/.test(attrs[k] ?? "")) size[k] = attrs[k];
      return h("img", { alt, title: title ?? null, "data-src": path, class: attrs.align ? `align-${attrs.align}` : null, ...size });
    }
    const href = /^https?:\/\//i.test(s) ? safeHref(s) : null;
    let host = "";
    try {
      host = href ? new URL(href).host : "";
    } catch {
      host = "";
    }
    const label = `${alt || "an image"}${host ? ` (an image at ${host})` : ""}`;
    return href ? h("a", { href, class: "external-image", rel: "nofollow ugc noopener", title: "An image on another site: open it there" }, label) : h("span", { class: "external-image" }, label);
  }

  // ── inlines ──

  inline(text: string): Child[] {
    return this.inlineAt(maskEmails(text), 0);
  }

  /** Where identifiers and bare addresses stand in a text, found before emphasis is read, so an
   *  underscore or a star inside one (RRID:SCR_002823, a_(b)) is not taken for emphasis. */
  private linkSpans(text: string): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    let at = 0;
    for (const x of this.autolink(text)) {
      const len = typeof x === "string" ? x.length : x ? textOf(x).length : 0;
      if (x && typeof x === "object") out.push({ start: at, end: at + len });
      at += len;
    }
    return out;
  }

  private inlineAt(text: string, depth: number): Child[] {
    if (depth > 20) return [text];
    const spans = /[_*~]/.test(text) ? this.linkSpans(text) : [];
    let sp = 0;
    type Item = Child | { delim: string; count: number; open: boolean; close: boolean };
    const items: Item[] = [];
    let buf = "";
    const flush = () => {
      if (buf) items.push(...this.autolink(buf));
      buf = "";
    };
    const stack: El[] = [];
    const push = (x: Child) => {
      flush();
      items.push(x);
    };
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      // an identifier or an address with "_", "*" or "~" in it: one piece of text, linked below
      while (sp < spans.length && spans[sp].end <= i) sp++;
      if (sp < spans.length && spans[sp].start === i) {
        buf += text.slice(i, spans[sp].end);
        i = spans[sp].end;
        continue;
      }
      // escapes
      if (c === "\\" && i + 1 < n) {
        const next = text[i + 1];
        if (next === "\n") {
          push(h("br", null));
          i += 2;
          continue;
        }
        if (/[!-/:-@[-`{-~]/.test(next)) {
          buf += next;
          i += 2;
          continue;
        }
      }
      // hard line break: two spaces then a new line
      if (c === "\n") {
        if (buf.endsWith("  ")) {
          let end = buf.length;
          while (end > 0 && buf[end - 1] === " ") end--;
          buf = buf.slice(0, end);
          push(h("br", null));
        } else buf += "\n";
        i++;
        continue;
      }
      // math with backticks: $`…`$
      if (c === "$" && text[i + 1] === "`") {
        const end = text.indexOf("`$", i + 2);
        if (end > i + 1) {
          push(texToMathml(text.slice(i + 2, end), false, this.macros).el);
          i = end + 2;
          continue;
        }
      }
      // code spans
      if (c === "`") {
        let run = 1;
        while (text[i + run] === "`") run++;
        const close = text.indexOf("`".repeat(run), i + run);
        let k = close;
        while (k >= 0 && text[k + run] === "`") k = text.indexOf("`".repeat(run), k + run + 1);
        if (k >= 0) {
          let code = text.slice(i + run, k).replace(/\n/g, " ");
          if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
          push(h("code", null, code));
          i = k + run;
          continue;
        }
        buf += "`".repeat(run);
        i += run;
        continue;
      }
      // inline math: $…$ up to the next unescaped $; not "$ " nor " $", nor a closing $ before a
      // digit (prices stay text: "$5 and $10")
      if (c === "$" && text[i + 1] !== "$" && !/\s/.test(text[i + 1] ?? " ")) {
        let k = i + 1;
        while (k < n && !(text[k] === "$" && text[k - 1] !== "\\")) k++;
        if (k < n && !/\s/.test(text[k - 1]) && !/\d/.test(text[k + 1] ?? "")) {
          push(texToMathml(text.slice(i + 1, k), false, this.macros).el);
          i = k + 1;
          continue;
        }
        buf += c;
        i++;
        continue;
      }
      // autolinks <https://…>
      if (c === "<") {
        const auto = /^<(https?:\/\/[^\s<>]+)>/.exec(text.slice(i));
        if (auto) {
          const href = this.link(auto[1]);
          push(href ? h("a", { href, rel: "nofollow ugc noopener" }, auto[1]) : auto[1]);
          i += auto[0].length;
          continue;
        }
        if (text.startsWith(`<${EMAIL_MASK}>`, i)) {
          // an email autolink (already masked): the mask, no link
          buf += EMAIL_MASK;
          i += EMAIL_MASK.length + 2;
          continue;
        }
        if (/^<[^\s<>@]+@[^\s<>]+>/.test(text.slice(i))) {
          // an email autolink: masked text, no link
          const m = /^<([^>]+)>/.exec(text.slice(i))!;
          buf += maskEmails(m[1]);
          i += m[0].length;
          continue;
        }
        const comment = text.startsWith("<!--", i) ? text.indexOf("-->", i + 4) : -2;
        if (comment >= 0) {
          i = comment + 3;
          continue;
        }
        const tag = TAG_RE.exec(text.slice(i));
        if (tag) {
          flush();
          const name = tag[2].toLowerCase();
          if (tag[1]) {
            // a closing tag: close up to the matching open element
            const k = stack.map((e) => e.attrs["data-tag"]).lastIndexOf(name);
            if (k >= 0) {
              const closed = stack.splice(k);
              const el = closed[0];
              // everything pushed after the element's marker becomes its children
              const at = items.lastIndexOf(el);
              if (at >= 0) {
                el.children = this.finish(items.splice(at + 1) as Item[]) as (string | El)[];
                delete el.attrs["data-tag"];
              }
            }
          } else if (DROP_WITH_CONTENT.has(name)) {
            const end = new RegExp(`</${name}\\s*>`, "i").exec(text.slice(i + tag[0].length));
            i += tag[0].length + (end ? end.index + end[0].length : text.length);
            continue;
          } else {
            const el = this.htmlElement(name, attrsOf(tag[3] ?? ""));
            if (el) {
              if (VOID.has(name) || tag[4]) items.push(el);
              else {
                el.attrs["data-tag"] = name;
                stack.push(el);
                items.push(el);
              }
            }
          }
          i += tag[0].length;
          continue;
        }
      }
      // images and links
      if ((c === "!" && text[i + 1] === "[") || c === "[") {
        const img = c === "!";
        const open = i + (img ? 1 : 0);
        const close = matchBracket(text, open);
        if (close > open) {
          const label = text.slice(open + 1, close);
          const after = text.slice(close + 1);
          // a footnote reference
          if (!img && /^\^[^\]\s]{1,100}$/.test(label) && this.doc.footnotes.has(label.slice(1))) {
            push(this.footnoteRef(label.slice(1)));
            i = close + 1;
            continue;
          }
          const inl = /^\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/.exec(after);
          let target: { href: string; title: string | null } | null = null;
          let consumed = 0;
          if (inl) {
            target = { href: inl[1], title: inl[2] ?? inl[3] ?? null };
            consumed = inl[0].length;
          } else {
            const ref = /^\[([^\]]*)\]/.exec(after);
            const key = (ref && ref[1] ? ref[1] : label).trim().toLowerCase().replace(/\s+/g, " ");
            const def = this.doc.links.get(key);
            if (def) {
              target = def;
              consumed = ref ? ref[0].length : 0;
            }
          }
          if (target) {
            if (img) {
              const el = this.image(target.href, stripMarks(label), target.title);
              if (el) push(el);
            } else {
              // A link inside a link is not HTML: an external image in a link keeps its words only.
              const kids = this.inlineAt(label, depth + 1).map((k) => (k && typeof k === "object" && k.tag === "a" ? h("span", { class: "external-image" }, ...k.children) : k));
              const a = this.anchor(this.link(target.href), kids, target.title);
              if (Array.isArray(a)) for (const k of a) push(k);
              else push(a);
            }
            i = close + 1 + consumed;
            continue;
          }
        }
      }
      // emphasis and strikethrough delimiters
      if (c === "*" || c === "_" || (c === "~" && text[i + 1] === "~")) {
        let run = 1;
        while (text[i + run] === c) run++;
        if (c === "~" && run !== 2) {
          buf += c.repeat(run);
          i += run;
          continue;
        }
        const before = i === 0 ? " " : text[i - 1];
        const after = text[i + run] ?? " ";
        const ws = (x: string) => /\s/.test(x);
        const punct = (x: string) => /[\p{P}\p{S}]/u.test(x);
        const leftFlanking = !ws(after) && (!punct(after) || ws(before) || punct(before));
        const rightFlanking = !ws(before) && (!punct(before) || ws(after) || punct(after));
        const open = c === "_" ? leftFlanking && (!rightFlanking || punct(before)) : leftFlanking;
        const close = c === "_" ? rightFlanking && (!leftFlanking || punct(after)) : rightFlanking;
        flush();
        items.push({ delim: c, count: run, open, close });
        i += run;
        continue;
      }
      // emoji shortcodes
      if (c === ":") {
        const e = /^:([a-z0-9_+-]{1,40}):/.exec(text.slice(i));
        if (e && EMOJI[e[1]]) {
          buf += String.fromCodePoint(EMOJI[e[1]]);
          i += e[0].length;
          continue;
        }
      }
      // entities
      if (c === "&") {
        const ent = /^&(?:#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(text.slice(i));
        if (ent) {
          buf += decodeEntities(ent[0]);
          i += ent[0].length;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
    // Unclosed inline HTML elements take what follows them.
    for (const el of stack.reverse()) {
      const at = items.lastIndexOf(el);
      if (at >= 0) el.children = this.finish(items.splice(at + 1) as Item[]) as (string | El)[];
      delete el.attrs["data-tag"];
    }
    return this.finish(items);
  }

  /** Emphasis resolved (CommonMark's delimiter matching, simplified); unmatched delimiters stay text. */
  private finish(items: (Child | { delim: string; count: number; open: boolean; close: boolean })[]): Child[] {
    type D = { delim: string; count: number; open: boolean; close: boolean };
    const isD = (x: unknown): x is D => !!x && typeof x === "object" && "delim" in (x as object);
    const list = [...items];
    // CommonMark's "openers bottom": once no opener was found for a kind of closer, the next closer
    // of that kind does not look below the same place again (no quadratic time on "_a_ b__" × 10⁴).
    const bottom = new Map<string, number>();
    for (let ci = 0; ci < list.length; ci++) {
      const closer = list[ci];
      if (!isD(closer) || !closer.close) continue;
      const kind = `${closer.delim}${closer.open ? 1 : 0}${closer.count % 3}`;
      let matched = false;
      for (let oi = ci - 1; oi >= (bottom.get(kind) ?? 0); oi--) {
        const opener = list[oi];
        if (!isD(opener) || !opener.open || opener.delim !== closer.delim) continue;
        if (closer.delim === "~") {
          if (opener.count !== 2 || closer.count !== 2) continue;
        } else if ((opener.close || closer.open) && (opener.count + closer.count) % 3 === 0 && !(opener.count % 3 === 0 && closer.count % 3 === 0)) continue;
        const use = closer.delim === "~" ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
        const tag: Tag = closer.delim === "~" ? "del" : use === 2 ? "strong" : "em";
        const inner = list.splice(oi + 1, ci - oi - 1);
        // The delimiters between the two can no longer match (CommonMark drops them): text.
        const el = h(tag, null, ...flatten(inner));
        opener.count -= use;
        closer.count -= use;
        list.splice(oi + 1, 0, el);
        ci = oi + 1;
        if (opener.count === 0) {
          list.splice(oi, 1);
          ci--;
        }
        if (closer.count === 0) {
          list.splice(ci + 1, 1);
        } else ci--;
        for (const [k, v] of bottom) if (v > oi) bottom.set(k, oi);
        matched = true;
        break;
      }
      if (!matched) bottom.set(kind, ci);
    }
    return flatten(list);
  }

  /** Scholarly identifiers, commit ids and bare addresses in plain text, as links. Each pattern's
   *  next match is kept while the text is walked, so a long text is read once per pattern. */
  private autolink(text: string): Child[] {
    const out: Child[] = [];
    const res = AUTO.map((a) => new RegExp(a.re.source, `${a.re.flags.replace("g", "")}g`));
    /** A pattern's first match at or after `from` that gives a link (an ORCID iD whose check
     *  digit is wrong gives none). */
    const find = (k: number, from: number): RegExpExecArray | null => {
      const re = res[k];
      re.lastIndex = from;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const shown = AUTO[k].trim ? AUTO[k].trim!(m[0]) : m[0];
        if (shown && AUTO[k].href(m, this.ctx.repo, shown)) return m;
        re.lastIndex = m.index + 1;
      }
      return null;
    };
    const next: (RegExpExecArray | null | undefined)[] = AUTO.map(() => undefined);
    let at = 0;
    for (let guard = 0; at < text.length && guard < 2000; guard++) {
      let best: { index: number; shown: string; href: string } | null = null;
      for (let k = 0; k < AUTO.length; k++) {
        const cached = next[k];
        const m = cached === undefined || (cached !== null && cached.index < at) ? find(k, at) : cached;
        next[k] = m;
        if (!m || (best && m.index >= best.index)) continue;
        const shown = AUTO[k].trim ? AUTO[k].trim!(m[0]) : m[0];
        best = { index: m.index, shown, href: AUTO[k].href(m, this.ctx.repo, shown)! };
      }
      if (!best) break;
      if (best.index > at) out.push(text.slice(at, best.index));
      const shown = best.shown;
      // A site path (a commit of this repository) is the site's own; an address goes through the
      // context's resolver (GitHub's addresses of a repository stay in this viewer).
      const target = best.href.startsWith("/") ? safeHref(best.href) : this.link(best.href) ?? safeHref(best.href);
      out.push(target ? h("a", { href: target, rel: /^https?:/.test(target) ? "nofollow ugc noopener" : null }, shown) : shown);
      at = best.index + shown.length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }

  private footnoteRef(id: string): El {
    let n = this.footRefs.indexOf(id) + 1;
    if (!n) {
      this.footRefs.push(id);
      n = this.footRefs.length;
    }
    const slug = slugOf(id) || String(n);
    return h("sup", null, h("a", { href: `#${USER_CONTENT}fn-${slug}`, id: `${USER_CONTENT}fnref-${slug}`, "aria-label": `Footnote ${n}` }, String(n)));
  }

  /** An HTML element GitHub keeps, with the attributes it may carry; null when dropped. */
  private htmlElement(name: string, attrs: Record<string, string>): El | null {
    if (!KEEP.has(name)) return null;
    if (name === "source") return null; // <picture>'s sources: the default image (light) only
    const tag = (RENAME[name] ?? name) as Tag;
    const align = /^(left|center|right)$/i.test(attrs.align ?? "") ? `align-${attrs.align.toLowerCase()}` : null;
    if (name === "img") return this.image(attrs.src ?? "", attrs.alt ?? "", attrs.title ?? null, { width: attrs.width ?? "", height: attrs.height ?? "", align: (attrs.align ?? "").toLowerCase() });
    if (name === "a") {
      const href = attrs.href ? this.link(attrs.href) : null;
      const id = attrs.name || attrs.id ? `${USER_CONTENT}${slugOf(attrs.name || attrs.id)}` : null;
      return h("a", { href, id, title: attrs.title ?? null, rel: href && /^https?:/.test(href) ? "nofollow ugc noopener" : null });
    }
    const out: Record<string, string | null> = { class: name === "center" ? "align-center" : align };
    if (name === "details" && "open" in attrs) out.open = "open";
    if (name === "ol" && /^\d{1,9}$/.test(attrs.start ?? "")) out.start = attrs.start;
    if ((name === "td" || name === "th") && /^\d{1,3}$/.test(attrs.colspan ?? "")) out.colspan = attrs.colspan;
    if ((name === "td" || name === "th") && /^\d{1,3}$/.test(attrs.rowspan ?? "")) out.rowspan = attrs.rowspan;
    if ((name === "abbr" || name === "dfn") && attrs.title) out.title = attrs.title;
    if (/^h[1-6]$/.test(name) && attrs.id) out.id = `${USER_CONTENT}${slugOf(attrs.id)}`;
    return h(tag, out);
  }

  // ── blocks ──

  private heading(level: number, text: string): El {
    const kids = this.inline(text);
    const plain = stripMarks(maskEmails(text));
    let slug = slugOf(plain) || "section";
    const seen = this.seen.get(slug) ?? 0;
    this.seen.set(slug, seen + 1);
    if (seen) slug = `${slug}-${seen}`;
    const id = `${USER_CONTENT}${slug}`;
    this.headings.push({ level, text: plain, id });
    return h(`h${level}` as Tag, { id }, ...kids, " ", h("a", { href: `#${id}`, class: "anchor", "aria-label": `Link to the section ${plain}` }, "§"));
  }

  private code(lang: string, text: string): El {
    const masked = maskEmails(text);
    const diagram = DIAGRAMS[lang];
    const code = h("code", null, masked);
    const language = fenceLanguage(lang);
    if (!this.ctx.plainCode && language) this.codeJobs.push({ el: code, text: masked, language });
    const pre = h("pre", { class: "code-block", "data-lang": /^[a-z0-9+#-]{1,20}$/.test(lang) ? lang : null }, code);
    if (!diagram) return pre;
    const at = this.ctx.sourceUrl ? safeHref(this.ctx.sourceUrl) : null;
    return h("figure", { class: "diagram-source" }, h("figcaption", null, diagram, at ? [" ", h("a", { href: at }, "At the source"), "."] : null), pre);
  }

  blocks(blocks: Block[], tight = false): El[] {
    const root: El = h("div", null);
    const stack: El[] = [root];
    const top = () => stack[stack.length - 1];
    const add = (...els: (El | null)[]) => {
      for (const e of els) if (e) top().children.push(e);
    };
    for (const b of blocks) {
      switch (b.t) {
        case "heading":
          add(this.heading(b.level, b.text));
          break;
        case "para": {
          const kids = this.inline(b.text.trim());
          if (!kids.length) break;
          if (tight) top().children.push(...(kids.filter((k) => k !== null && k !== undefined && k !== false) as (string | El)[]));
          else add(h("p", null, ...kids));
          break;
        }
        case "code":
          add(this.code(b.lang, b.text));
          break;
        case "math":
          add(h("div", { class: "math-block" }, texToMathml(maskEmails(b.tex), true, this.macros).el));
          break;
        case "hr":
          add(h("hr", null));
          break;
        case "quote": {
          const inner = this.blocks(b.children);
          if (b.alert) add(h("div", { class: `markdown-alert markdown-alert-${b.alert}`, role: "note" }, h("p", { class: "markdown-alert-title" }, ALERTS[b.alert] ?? b.alert), ...inner));
          else add(h("blockquote", null, ...inner));
          break;
        }
        case "list": {
          const items = b.items.map((it) => {
            const kids = this.blocks(it.children, !b.loose);
            if (it.task === null) return h("li", null, ...kids);
            return h("li", { class: "task-list-item" }, h("input", { type: "checkbox", disabled: "disabled", checked: it.task ? "checked" : null, "aria-label": it.task ? "Done" : "Not done" }), " ", ...kids);
          });
          const attrs: Record<string, string | null> = { class: b.items.some((it) => it.task !== null) ? "contains-task-list" : null };
          if (b.ordered && b.start !== 1) attrs.start = String(b.start);
          add(h(b.ordered ? "ol" : "ul", attrs, ...items));
          break;
        }
        case "table": {
          const cls = (k: number) => (b.align[k] ? `align-${b.align[k]}` : null);
          add(
            h(
              "div",
              { class: "table-scroll" },
              h(
                "table",
                { class: "markdown" },
                h("thead", null, h("tr", null, ...b.header.map((c, k) => h("th", { class: cls(k) }, ...this.inline(c))))),
                h("tbody", null, ...b.rows.map((r) => h("tr", null, ...r.map((c, k) => h("td", { class: cls(k) }, ...this.inline(c)))))),
              ),
            ),
          );
          break;
        }
        case "html":
          this.htmlBlock(b.text, stack);
          break;
      }
    }
    // Containers left open by the file's HTML close at the end.
    for (const el of stack) delete el.attrs["data-tag"];
    return root.children as El[];
  }

  /** An HTML block: container tags open and close across blocks (so Markdown inside <details> is
   *  rendered); anything else is read as inline content. */
  private htmlBlock(text: string, stack: El[]): void {
    const tokens = htmlTokens(maskEmails(text));
    let inlineBuf = "";
    const flushInline = () => {
      if (inlineBuf.trim()) {
        const kids = this.inline(inlineBuf.trim());
        inlineBuf = "";
        // (what was dropped whole, a <meta> or a <style>, leaves no empty paragraph)
        if (!kids.some((k) => (typeof k === "string" ? k.trim() : !!k))) return;
        const parent = stack[stack.length - 1];
        const tag = parent.attrs["data-tag"];
        // Inline content right inside a block container reads as a paragraph, except in the
        // containers that hold inline content themselves.
        if (tag && /^(summary|p|h[1-6]|td|th|li|dt|dd|figcaption|caption|a|span|sub|sup|b|i|em|strong)$/.test(tag)) parent.children.push(...(kids as (string | El)[]));
        else parent.children.push(h("p", null, ...kids));
      }
      inlineBuf = "";
    };
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.kind === "comment") continue;
      if (t.kind === "text") {
        inlineBuf += t.text;
        continue;
      }
      const name = t.tag!;
      const container = /^(details|summary|div|p|blockquote|dl|dt|dd|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|h[1-6]|figure|figcaption|picture|center|caption|pre)$/.test(name);
      if (!container) {
        // an inline tag: kept as text for the inline reader, which filters it the same way
        inlineBuf += rebuildTag(t);
        continue;
      }
      flushInline();
      if (t.kind === "open") {
        if (DROP_WITH_CONTENT.has(name)) continue;
        const el = this.htmlElement(name, t.attrs ?? {});
        if (!el) continue;
        if (name === "picture") continue; // its <img> comes next; its <source>s are dropped
        el.attrs["data-tag"] = name;
        stack[stack.length - 1].children.push(el);
        if (!t.selfClosing && !VOID.has(name)) stack.push(el);
        else delete el.attrs["data-tag"];
      } else {
        const idx = stack.map((e) => e.attrs["data-tag"]).lastIndexOf(name);
        if (idx > 0) for (const e of stack.splice(idx)) delete e.attrs["data-tag"];
      }
    }
    flushInline();
  }

  footnotes(): El | null {
    if (!this.footRefs.length) return null;
    return h(
      "section",
      { class: "footnotes", "aria-label": "Footnotes" },
      h(
        "ol",
        null,
        ...this.footRefs.map((id, k) => {
          const slug = slugOf(id) || String(k + 1);
          const inner = this.blocks(this.doc.footnotes.get(id) ?? []);
          const back = h("a", { href: `#${USER_CONTENT}fnref-${slug}`, class: "footnote-back", "aria-label": "Back to the text" }, "↩");
          // The way back ends the note's last paragraph, as on GitHub.
          const last = inner[inner.length - 1];
          if (last?.tag === "p") last.children.push(" ", back);
          else inner.push(back);
          return h("li", { id: `${USER_CONTENT}fn-${slug}` }, ...inner);
        }),
      ),
    );
  }

  async highlight(): Promise<void> {
    for (const job of this.codeJobs.slice(0, 200)) {
      const lines = job.text.split("\n");
      const nodes: LineNodes[] = await highlightText(lines, job.language);
      const kids: (string | El)[] = [];
      nodes.forEach((l, k) => {
        if (k) kids.push("\n");
        kids.push(...l);
      });
      job.el.children = kids;
    }
  }
}

/** Inline items with their unmatched delimiters as text, adjacent texts joined. */
function flatten(list: readonly (Child | { delim: string; count: number })[]): Child[] {
  const out: Child[] = [];
  for (const x of list) {
    const s = x && typeof x === "object" && "delim" in x ? x.delim.repeat(x.count) : x;
    if (s === "" || s === null || s === undefined || s === false) continue;
    if (typeof s === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] = (out[out.length - 1] as string) + s;
    else out.push(s as Child);
  }
  return out;
}

/** The index of the "]" that closes the "[" at `open`, or -1. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** A label's text without its marks, for alt texts and headings' slugs. */
function stripMarks(text: string): string {
  return decodeEntities(text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/[*_~`]/g, "")).trim();
}

function rebuildTag(t: HtmlTok): string {
  if (t.kind === "close") return `</${t.tag}>`;
  const attrs = Object.entries(t.attrs ?? {})
    .map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`)
    .join(" ");
  return `<${t.tag}${attrs ? ` ${attrs}` : ""}${t.selfClosing ? " /" : ""}>`;
}

/** Renders a Markdown text into a view tree: `div.markdown-body`, its headings (the outline) and
 *  the relative images the page must read. */
export async function renderMarkdown(source: string, ctx: MarkdownContext = {}): Promise<Rendered> {
  const text = String(source ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const doc: Doc = { links: new Map(), footnotes: new Map() };
  const blocks = parseBlocks(text.split("\n"), doc);
  const r = new Renderer(ctx, doc);
  const body = r.blocks(blocks);
  const foot = r.footnotes();
  await r.highlight();
  return { el: h("div", { class: "markdown-body" }, ...body, foot), headings: r.headings, images: r.images };
}

/** The outline of a document: its headings as a nested list of links. */
export function outline(headings: readonly Heading[]): El | null {
  if (headings.length < 3) return null;
  const min = Math.min(...headings.map((x) => x.level));
  return h(
    "details",
    { class: "outline" },
    h("summary", null, "Outline"),
    h("ul", null, ...headings.map((x) => h("li", { class: `level-${Math.min(6, x.level - min + 1)}` }, h("a", { href: `#${x.id}` }, x.text)))),
  );
}

// ─── resolving a repository's links ──────────────────────────────────────────

export interface RepoLinkContext {
  repo: RepoCoords;
  /** The ref the page shows (a branch, a tag or a commit id). */
  ref: string;
  /** The directory of the document, "" at the root. */
  dir: string;
  /** Whether a path is a directory of the tree (tree/ or blob/). */
  isDir: (path: string) => boolean;
  /** GitHub's web and raw addresses (the fake one in a local run). */
  web?: string;
  raw?: string;
}

/** A path relative to a document's directory ("./a", "../b", "/c" from the root) → the path in
 *  the repository ("" for the root); null when it leaves the repository or is not a path. */
export function joinPath(dir: string, rel: string): string | null {
  if (rel.startsWith("/")) {
    const fromRoot = rel.replace(/^\/+/, "");
    return fromRoot ? joinRelative("", fromRoot) : "";
  }
  if (rel === "" || /^\.\/?$/.test(rel)) return dir;
  return joinRelative(dir, rel);
}

/** An image of the same repository at one of GitHub's raw addresses (raw.githubusercontent.com,
 *  github.com/<o>/<r>/raw/<rev>/…, or blob/…?raw=true): its path, read at the page's commit. */
function ownRawImage(c: RepoLinkContext, src: string): string | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  const same = (o: string, n: string) => o.toLowerCase() === c.repo.owner.toLowerCase() && n.replace(/\.git$/i, "").toLowerCase() === c.repo.name.toLowerCase();
  let parts: string[];
  try {
    parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const rawHost = new URL(c.raw ?? "https://raw.githubusercontent.com").host;
  const webHost = new URL(c.web ?? "https://github.com").host;
  let rest: string[] | null = null;
  if (u.host === rawHost && parts.length >= 4 && same(parts[0], parts[1])) {
    rest = parts.slice(3);
    if (parts[2] === "refs" && (parts[3] === "heads" || parts[3] === "tags")) rest = parts.slice(5);
  } else if (u.host === webHost && parts.length >= 5 && same(parts[0], parts[1]) && (parts[2] === "raw" || (parts[2] === "blob" && /^(?:raw=true|raw=1)$/.test(u.search.slice(1))))) {
    rest = parts.slice(4);
  }
  if (!rest || !rest.length) return null;
  return joinRelative("", rest.join("/"));
}

/** The link and image resolvers of a document of a repository: relative paths to this viewer at
 *  the same ref, anchors to the document's own headings, GitHub's addresses of a repository to
 *  this viewer (readers stay here), other https addresses as they are; images: relative ones and
 *  the same repository's raw addresses, read by the page at the commit. */
export function repoResolvers(c: RepoLinkContext): Pick<MarkdownContext, "resolveLink" | "resolveImage" | "repo"> {
  const links = forgeLinks({ forge: "github", web: c.web ?? "https://github.com" });
  const within = (rel: string): string | null => {
    const [pathPart, hash = ""] = rel.split("#", 2);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart.split("?")[0]);
    } catch {
      return null;
    }
    const path = joinPath(c.dir, decoded);
    if (path === null) return null;
    const anchor = hash ? (/^L\d+(-L\d+)?$/.test(hash) ? `#${hash}` : `#${USER_CONTENT}${slugOf(hash)}`) : "";
    try {
      if (!path) return `${repoPath(c.repo, "tree", c.ref.split("/"))}${anchor}`;
      return `${repoPath(c.repo, c.isDir(path) ? "tree" : "blob", [...c.ref.split("/"), ...path.split("/")])}${anchor}`;
    } catch {
      return null;
    }
  };
  return {
    repo: c.repo,
    resolveLink(href: string): string | null {
      if (href.startsWith("#")) return `#${USER_CONTENT}${slugOf(decodeURIComponent(href.slice(1)))}`;
      if (/^mailto:/i.test(href)) return null;
      if (/^https?:\/\//i.test(href)) {
        const parsed = links.parse(href);
        if (parsed && isOwner(parsed.repo.owner) && isRepoName(parsed.repo.name)) {
          const r = { owner: parsed.repo.owner, name: parsed.repo.name };
          const u = new URL(href);
          const kind = u.pathname.split("/")[3];
          const hash = parsed.lines ? `#L${parsed.lines.start}${parsed.lines.end !== parsed.lines.start ? `-L${parsed.lines.end}` : ""}` : "";
          try {
            if (!parsed.rev) return repoPath(r);
            if (kind === "commit") return repoPath(r, "commit", [parsed.rev]);
            return `${repoPath(r, kind === "tree" ? "tree" : "blob", [...parsed.rev.split("/"), ...(parsed.path ?? "").split("/").filter(Boolean)])}${hash}`;
          } catch {
            return href;
          }
        }
        return href;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
      return within(href);
    },
    resolveImage(src: string): string | null {
      if (/^https?:\/\//i.test(src)) return ownRawImage(c, src);
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(src.split(/[?#]/)[0]);
      } catch {
        return null;
      }
      const path = joinPath(c.dir, decoded);
      return path ? path : null;
    },
  };
}

// ─── READMEs ─────────────────────────────────────────────────────────────────

/** Whether a file name is a README GitHub shows (README, README.md, readme.rst…). */
export const isReadmeName = (name: string): boolean => /^readme(?:\.[A-Za-z0-9]{1,12})?$/i.test(name);

/** Whether a path is Markdown (GitHub's extensions). */
export const isMarkdownPath = (path: string): boolean => /\.(?:md|markdown|mdown|mkdn|mkd|mdwn|mkdown|ron|workbook)$/i.test(path);

/** The README a directory shows: the Markdown one first, then the others (reStructuredText,
 *  text, none); on the repository's home and root, GitHub's precedence: `.github/`, the root,
 *  then `docs/`. */
export function readmeOf(entries: readonly { path: string; type: string }[], dir: string, root = dir === ""): string | null {
  const dirs = root ? [".github", "", "docs"] : [dir];
  for (const d of dirs) {
    const prefix = d ? `${d}/` : "";
    const here = entries.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/") && isReadmeName(e.path.slice(prefix.length)));
    if (!here.length) continue;
    const rank = (p: string) => (isMarkdownPath(p) ? 0 : /\.(?:rst|txt|org|adoc|asciidoc|textile|rdoc|pod|creole|mediawiki|wiki)$/i.test(p) ? 2 : /\/readme$|^readme$/i.test(p) ? 1 : 3);
    here.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
    return here[0].path;
  }
  return null;
}

/** A Markdown text cut at GitHub's 500 KiB, at a line's end: the text and whether it was cut. */
export function cutForRendering(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, cut: false };
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/, "");
  const nl = head.lastIndexOf("\n");
  return { text: nl > 0 ? head.slice(0, nl) : head, cut: true };
}
