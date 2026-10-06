// A repository's .gitattributes as Linguist reads it (night phase 02, E6): which language a file is
// (linguist-language), and which files the language statistics, the file finder and the diffs leave
// aside (linguist-vendored, -generated, -documentation, -detectable), with Linguist's own defaults
// for vendored and documentation paths. Pure, no DOM, testable in Node (tests/forge-pages/about.test.ts).

export interface Attributes {
  language?: string;
  vendored?: boolean;
  generated?: boolean;
  documentation?: boolean;
  detectable?: boolean;
  /** `binary` or `-diff`: git shows no text diff. */
  binary?: boolean;
  /** `filter=lfs`: git stores the file with Git LFS (phase 03: the upload page refuses it, since a
   *  commit made by GitHub from the browser would store the bytes themselves). */
  lfs?: boolean;
}

interface Rule {
  re: RegExp;
  attrs: Attributes;
}

/** A gitattributes pattern as a regular expression over a path from the root: a pattern without
 *  "/" (but a trailing one) matches a name at any depth; "*" stays in one name, "**" crosses
 *  directories, "?" is one character, [..] a class; a leading "/" anchors at the root. */
export function patternRe(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (!p || p.startsWith("#") || p.length > 500) return null;
  if (p.startsWith("\\")) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        const body = p.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        re += `[${body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  // A directory's pattern also matches what is inside it (Linguist's vendored "dir/**" habit).
  const tail = dirOnly ? "/.*" : "(?:/.*)?";
  try {
    return new RegExp(anchored ? `^${re}${tail}$` : `(?:^|/)${re}${tail}$`);
  } catch {
    return null;
  }
}

const TRUE = (v: string | undefined) => v === undefined || v === "true" || v === "set";

/** The lines of a .gitattributes file as rules, in order (a later rule wins, as in git). */
export function parseAttributes(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 2_000)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // A pattern may be quoted; attributes are separated by spaces.
    const m = /^("(?:[^"\\]|\\.)*"|\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const re = patternRe(m[1].startsWith('"') ? m[1].slice(1, -1) : m[1]);
    if (!re) continue;
    const attrs: Attributes = {};
    for (const token of m[2].split(/\s+/)) {
      const neg = token.startsWith("-") || token.startsWith("!");
      const [name, value] = (neg ? token.slice(1) : token).split("=", 2);
      const on = neg ? false : TRUE(value) || value !== "false";
      switch (name) {
        case "linguist-language":
          if (!neg && value) attrs.language = value.replace(/_/g, " ");
          break;
        case "linguist-vendored":
          attrs.vendored = neg ? false : value === "false" ? false : on;
          break;
        case "linguist-generated":
          attrs.generated = neg ? false : value === "false" ? false : on;
          break;
        case "linguist-documentation":
          attrs.documentation = neg ? false : value === "false" ? false : on;
          break;
        case "linguist-detectable":
          attrs.detectable = neg ? false : value === "false" ? false : on;
          break;
        case "binary":
          attrs.binary = !neg;
          break;
        case "diff":
          if (neg) attrs.binary = true;
          break;
        case "filter":
          attrs.lfs = !neg && value === "lfs";
          break;
      }
    }
    if (Object.keys(attrs).length) rules.push({ re, attrs });
  }
  return rules;
}

/** Linguist's own defaults (vendor.yml, documentation.yml, generated paths), the common ones. */
const VENDORED = /(?:^|\/)(?:node_modules|bower_components|vendor|vendors|third[-_]?party|external|extern|deps|\.yarn|site-packages|dist-packages|Godeps|Pods|Carthage)\/|(?:^|\/)[^/]+\.min\.(?:js|css)$|(?:^|\/)(?:jquery|bootstrap|d3|three|plotly|mathjax)[^/]*\.js$|(?:^|\/)\.(?:github|gitlab|circleci|devcontainer)\//i;
const DOCUMENTATION = /(?:^|\/)(?:docs?|Documentation|man|examples?|samples?|demos?)\/|(?:^|\/)(?:README|CHANGELOG|CHANGES|CONTRIBUTING|COPYING|INSTALL|LICEN[CS]E|NEWS)(?:\.[^/]*)?$/i;
const GENERATED = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|renv\.lock)$|\.(?:pb\.go|pb\.cc|pb\.h|_pb2\.py|designer\.cs)$|(?:^|\/)(?:__pycache__|\.ipynb_checkpoints)\//i;

/** A path's attributes: the defaults, then every rule that matches, in order. */
export function attributesOf(rules: readonly Rule[], path: string): Attributes {
  const out: Attributes = {};
  if (VENDORED.test(path)) out.vendored = true;
  if (DOCUMENTATION.test(path)) out.documentation = true;
  if (GENERATED.test(path)) out.generated = true;
  for (const r of rules) if (r.re.test(path)) Object.assign(out, r.attrs);
  return out;
}
