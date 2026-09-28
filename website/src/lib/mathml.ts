// TeX math to MathML (night phase 02, E2): the math of a README, a Markdown file or a notebook,
// rendered by the reader's browser itself (MathML Core: Chrome, Edge, Firefox, Safari). No
// library, no font, no CSS of its own: science.css stays the only style, and the pages'
// Content-Security-Policy is untouched. Pure functions, testable in Node
// (tests/forge-pages/mathml.test.ts).
//
// What it reads: the TeX researchers write in Markdown (GitHub's math is MathJax's): letters,
// numbers and operators; ^ and _ (with primes); \frac, \dfrac, \tfrac, \binom, \sqrt[n]{…};
// Greek letters; the usual relations, arrows and operators; \sum, \prod, \int and their limits;
// \left…\right; \mathbf, \mathrm, \mathit, \mathbb, \mathcal, \mathsf, \mathtt, \boldsymbol,
// \text, \operatorname, \sin and the other functions; accents (\hat, \bar, \vec, \tilde, \dot,
// \ddot, \overline, \underline); spaces; matrix, pmatrix, bmatrix, Bmatrix, vmatrix, Vmatrix,
// cases, aligned, align, array, gathered; \newcommand, \renewcommand and \def macros (with #1…#9),
// kept for the rest of the document, as GitHub keeps them.
// What it does not: any command it does not know is shown as its source (an <mtext> of class
// "math-unknown"), never guessed; the source is always kept in <annotation encoding=
// "application/x-tex"> (copy, screen readers). Nothing here can run: MathML Core has no script,
// no link and no style, and the view trees carry only the attributes repo-view.ts allows.

import { type El, h } from "./repo-view.ts";

type Tag = Parameters<typeof h>[0];
const m = (tag: string, attrs: Record<string, string> | null, ...children: (El | string)[]) => h(tag as Tag, attrs, ...children);

// ─── symbols ─────────────────────────────────────────────────────────────────

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

/** Commands that are identifiers (ordinary symbols). */
const IDENTS: Record<string, string> = {
  infty: "∞", partial: "∂", nabla: "∇", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", emptyset: "∅", varnothing: "∅",
  prime: "′", top: "⊤", bot: "⊥", angle: "∠", triangle: "△", Box: "□", degree: "°", dagger: "†", ddagger: "‡",
};

/** Commands that are operators, relations, arrows, delimiters. */
const OPS: Record<string, string> = {
  cdot: "⋅", times: "×", div: "÷", pm: "±", mp: "∓", ast: "∗", star: "⋆", circ: "∘", bullet: "∙", oplus: "⊕", ominus: "⊖",
  otimes: "⊗", odot: "⊙", wedge: "∧", land: "∧", vee: "∨", lor: "∨", neg: "¬", lnot: "¬", setminus: "∖", cap: "∩", cup: "∪",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", sim: "∼", simeq: "≃", cong: "≅", equiv: "≡",
  propto: "∝", ll: "≪", gg: "≫", prec: "≺", succ: "≻", preceq: "⪯", succeq: "⪰", in: "∈", notin: "∉", ni: "∋",
  subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", mid: "∣", parallel: "∥", perp: "⊥", models: "⊨", vdash: "⊢",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐",
  Leftrightarrow: "⇔", iff: "⟺", implies: "⟹", mapsto: "↦", longrightarrow: "⟶", longleftarrow: "⟵", uparrow: "↑",
  downarrow: "↓", forall: "∀", exists: "∃", nexists: "∄", therefore: "∴", because: "∵", ldots: "…", cdots: "⋯",
  vdots: "⋮", ddots: "⋱", dots: "…", colon: ":", lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", lceil: "⌈",
  rceil: "⌉", lfloor: "⌊", rfloor: "⌋", vert: "|", Vert: "‖", lvert: "|", rvert: "|", lVert: "‖", rVert: "‖",
  "{": "{", "}": "}", "|": "‖", backslash: "∖",
};

/** Large operators: limits above and below in display math. */
const BIG: Record<string, string> = {
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂",
  bigoplus: "⨁", bigotimes: "⨂", bigvee: "⋁", bigwedge: "⋀",
};
const INTEGRALS = new Set(["int", "iint", "iiint", "oint"]);

/** Functions written upright; the second group takes limits under them. */
const FUNCS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp", "deg", "dim", "hom", "ker", "arg", "gcd", "Pr", "tr", "Tr", "rank", "sgn", "var", "cov", "E"]);
const LIMIT_FUNCS = new Set(["lim", "limsup", "liminf", "max", "min", "sup", "inf", "det", "argmax", "argmin"]);

const SPACES: Record<string, string> = { ",": "0.1667em", ":": "0.2222em", ">": "0.2222em", ";": "0.2778em", " ": "0.25em", quad: "1em", qquad: "2em", enspace: "0.5em", thinspace: "0.1667em" };

const FONTS: Record<string, string> = {
  mathbf: "bold", mathrm: "normal", mathit: "italic", mathbb: "double-struck", mathcal: "script", mathscr: "script",
  mathfrak: "fraktur", mathsf: "sans-serif", mathtt: "monospace", boldsymbol: "bold-italic", bm: "bold-italic", textbf: "bold",
  textit: "italic", textrm: "normal", emph: "italic",
};

const ACCENTS: Record<string, [string, "over" | "under"]> = {
  hat: ["^", "over"], widehat: ["^", "over"], bar: ["‾", "over"], overline: ["‾", "over"], vec: ["→", "over"],
  overrightarrow: ["→", "over"], tilde: ["~", "over"], widetilde: ["~", "over"], dot: ["˙", "over"], ddot: ["¨", "over"],
  check: ["ˇ", "over"], breve: ["˘", "over"], acute: ["´", "over"], grave: ["`", "over"], underline: ["_", "under"],
  overbrace: ["⏞", "over"], underbrace: ["⏟", "under"],
};

const MATRICES: Record<string, [string, string] | null> = {
  matrix: null, smallmatrix: null, pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"],
  Vmatrix: ["‖", "‖"], cases: ["{", ""], aligned: null, align: null, "align*": null, gathered: null, array: null, split: null,
};

// ─── tokens ──────────────────────────────────────────────────────────────────

type Tok = { t: "cmd"; v: string } | { t: "char"; v: string } | { t: "open" } | { t: "close" } | { t: "sup" } | { t: "sub" } | { t: "amp" } | { t: "row" } | { t: "space" } | { t: "arg"; n: number };

export function tokenize(tex: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < tex.length) {
    const c = tex[i];
    if (c === "\\") {
      const next = tex[i + 1] ?? "";
      if (next === "\\") {
        out.push({ t: "row" });
        i += 2;
      } else if (/[A-Za-z]/.test(next)) {
        let j = i + 1;
        while (j < tex.length && /[A-Za-z]/.test(tex[j])) j++;
        if (tex[j] === "*" && /^(align|equation|gather)$/.test(tex.slice(i + 1, j))) j++;
        out.push({ t: "cmd", v: tex.slice(i + 1, j) });
        i = j;
      } else {
        out.push({ t: "cmd", v: next });
        i += 2;
      }
    } else if (c === "{") (out.push({ t: "open" }), i++);
    else if (c === "}") (out.push({ t: "close" }), i++);
    else if (c === "^") (out.push({ t: "sup" }), i++);
    else if (c === "_") (out.push({ t: "sub" }), i++);
    else if (c === "&") (out.push({ t: "amp" }), i++);
    else if (c === "#" && /[1-9]/.test(tex[i + 1] ?? "")) (out.push({ t: "arg", n: Number(tex[i + 1]) }), (i += 2));
    else if (/\s/.test(c)) {
      while (i < tex.length && /\s/.test(tex[i])) i++;
      out.push({ t: "space" });
    } else if (c === "%") {
      // a comment: the rest of the line, its end and the next line's indentation (TeX's rule)
      while (i < tex.length && tex[i] !== "\n") i++;
      while (i < tex.length && /\s/.test(tex[i])) i++;
    } else {
      const cp = tex.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push({ t: "char", v: ch });
      i += ch.length;
    }
  }
  return out;
}

// ─── macros ──────────────────────────────────────────────────────────────────

export interface Macro {
  args: number;
  body: Tok[];
}

/** The macros a document defines, kept from one formula to the next. */
export type Macros = Map<string, Macro>;

const MAX_EXPANSIONS = 500;

// ─── the parser ──────────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  private expansions = 0;
  unknown = 0;
  private toks: Tok[];
  private macros: Macros;
  private display: boolean;
  constructor(toks: Tok[], macros: Macros, display: boolean) {
    this.toks = toks;
    this.macros = macros;
    this.display = display;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private skipSpaces(): void {
    while (this.peek()?.t === "space") this.i++;
  }

  /** A group's tokens: {…} or a single token. */
  private rawArg(): Tok[] {
    this.skipSpaces();
    const t = this.peek();
    if (!t) return [];
    if (t.t !== "open") {
      this.i++;
      return [t];
    }
    let depth = 0;
    const start = ++this.i;
    while (this.i < this.toks.length) {
      const x = this.toks[this.i];
      if (x.t === "open") depth++;
      else if (x.t === "close") {
        if (depth === 0) break;
        depth--;
      }
      this.i++;
    }
    const out = this.toks.slice(start, this.i);
    this.i++;
    return out;
  }

  /** A group's text, for \text, \operatorname, environments' names. */
  private textArg(): string {
    return this.rawArg()
      .map((t) => (t.t === "char" ? t.v : t.t === "space" ? " " : t.t === "cmd" ? (t.v.length === 1 ? t.v : `\\${t.v}`) : ""))
      .join("");
  }

  /** A group parsed as math. */
  private arg(): El {
    const toks = this.rawArg();
    const sub = new Parser(toks, this.macros, this.display);
    sub.expansions = this.expansions;
    const kids = sub.parseList(() => false);
    this.unknown += sub.unknown;
    this.expansions = sub.expansions;
    return kids.length === 1 ? kids[0] : m("mrow", null, ...kids);
  }

  /** Atoms until `stop` says so (the token is left in place). */
  parseList(stop: (t: Tok) => boolean): El[] {
    const out: El[] = [];
    for (;;) {
      this.skipSpaces();
      const t = this.peek();
      if (!t || stop(t)) break;
      if (t.t === "close") {
        this.i++;
        continue;
      }
      const atom = this.atom();
      if (atom === null) continue;
      out.push(this.scripts(atom));
    }
    return out;
  }

  /** ^ and _ (and primes) after an atom. */
  private scripts(base: El): El {
    let sup: El | null = null;
    let sub: El | null = null;
    for (;;) {
      this.skipSpaces();
      const t = this.peek();
      if (t?.t === "sup") {
        this.i++;
        sup = this.arg();
      } else if (t?.t === "sub") {
        this.i++;
        sub = this.arg();
      } else if (t?.t === "char" && t.v === "'") {
        this.i++;
        let primes = "′";
        while (this.peek()?.t === "char" && (this.peek() as { v: string }).v === "'") {
          this.i++;
          primes += "′";
        }
        sup = m("mo", null, primes);
      } else break;
    }
    if (!sup && !sub) return base;
    const limits = this.display && base.attrs["data-limits"] === "1";
    const b = { ...base, attrs: Object.fromEntries(Object.entries(base.attrs).filter(([k]) => k !== "data-limits")) };
    if (limits) {
      if (sup && sub) return m("munderover", null, b, sub, sup);
      return sub ? m("munder", null, b, sub) : m("mover", null, b, sup!);
    }
    if (sup && sub) return m("msubsup", null, b, sub, sup);
    return sub ? m("msub", null, b, sub) : m("msup", null, b, sup!);
  }

  private atom(): El | null {
    const t = this.toks[this.i++];
    switch (t.t) {
      case "open": {
        this.i--;
        return this.arg();
      }
      case "char":
        return this.char(t.v);
      case "sup":
      case "sub":
        // A script with no base: an empty base.
        this.i--;
        return m("mrow", null);
      case "amp":
      case "row":
        return null;
      case "arg":
        return m("mi", null, `#${t.n}`);
      case "cmd":
        return this.command(t.v);
      default:
        return null;
    }
  }

  private char(c: string): El {
    if (/[0-9]/.test(c)) {
      let n = c;
      while (this.peek()?.t === "char" && /^[0-9.]$/.test((this.peek() as { v: string }).v)) n += (this.toks[this.i++] as { v: string }).v;
      return m("mn", null, n);
    }
    if (/\p{L}/u.test(c)) return m("mi", null, c);
    if (c === "~") return m("mspace", { width: "0.25em" });
    // A bracket written as such keeps its size, as in TeX (\left and \right make it stretch).
    if ("()[]|".includes(c)) return m("mo", { stretchy: "false" }, c);
    if ("+-=<>/,;:!?.*".includes(c) || /\p{S}|\p{P}/u.test(c)) return m("mo", null, c === "-" ? "−" : c === "*" ? "∗" : c);
    return m("mi", null, c);
  }

  private unknownCmd(name: string): El {
    this.unknown++;
    return m("mtext", { class: "math-unknown", title: "A command the viewer does not know" }, `\\${name}`);
  }

  private command(name: string): El | null {
    // A document's own macros first: \renewcommand and \def may redefine a built-in.
    const macro = this.macros.get(name);
    if (macro) return this.expand(name, macro);
    if (name in SPACES) return m("mspace", { width: SPACES[name] });
    if (name === "!") return null;
    if (GREEK[name]) return m("mi", /^[A-Z]/.test(name) ? { mathvariant: "normal" } : null, GREEK[name]);
    if (IDENTS[name]) return m("mi", null, IDENTS[name]);
    if (OPS[name]) return m("mo", /^(?:[{}|]|[lr]?[vV]ert|langle|rangle|[lr](?:ceil|floor)|lbrace|rbrace)$/.test(name) ? { stretchy: "false" } : null, OPS[name]);
    if (BIG[name]) return m("mo", { largeop: "true", movablelimits: INTEGRALS.has(name) ? "false" : "true", "data-limits": INTEGRALS.has(name) ? "0" : "1" }, BIG[name]);
    if (FUNCS.has(name)) return m("mi", name.length > 1 ? null : { mathvariant: "normal" }, name);
    if (LIMIT_FUNCS.has(name)) return m("mo", { movablelimits: "true", "data-limits": "1" }, name.replace(/^arg(max|min)$/, "arg $1"));
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac":
      case "cfrac": {
        const a = this.arg();
        const b = this.arg();
        return m("mfrac", null, a, b);
      }
      case "binom":
      case "dbinom":
      case "tbinom": {
        const a = this.arg();
        const b = this.arg();
        return m("mrow", null, m("mo", null, "("), m("mfrac", { linethickness: "0" }, a, b), m("mo", null, ")"));
      }
      case "sqrt": {
        this.skipSpaces();
        if (this.peek()?.t === "char" && (this.peek() as { v: string }).v === "[") {
          this.i++;
          const idx: Tok[] = [];
          while (this.i < this.toks.length && !(this.toks[this.i].t === "char" && (this.toks[this.i] as { v: string }).v === "]")) idx.push(this.toks[this.i++]);
          this.i++;
          const sub = new Parser(idx, this.macros, false);
          const n = sub.parseList(() => false);
          return m("mroot", null, this.arg(), n.length === 1 ? n[0] : m("mrow", null, ...n));
        }
        return m("msqrt", null, this.arg());
      }
      case "left": {
        const open = this.delimiter();
        const inner = this.parseList((t) => t.t === "cmd" && t.v === "right");
        if (this.peek()?.t === "cmd") this.i++;
        const close = this.delimiter();
        return m("mrow", null, ...(open ? [m("mo", { fence: "true", stretchy: "true" }, open)] : []), ...inner, ...(close ? [m("mo", { fence: "true", stretchy: "true" }, close)] : []));
      }
      case "right":
        return null;
      case "big":
      case "Big":
      case "bigg":
      case "Bigg":
      case "bigl":
      case "bigr":
      case "Bigl":
      case "Bigr":
      case "biggl":
      case "biggr": {
        const d = this.delimiter();
        return d ? m("mo", { stretchy: "false" }, d) : null;
      }
      case "text":
      case "textnormal":
      case "mbox":
      case "hbox":
        return m("mtext", null, this.textArg());
      case "operatorname":
      case "operatorname*":
        return m("mo", { movablelimits: "true" }, this.textArg());
      case "displaystyle":
      case "textstyle":
      case "scriptstyle":
      case "limits":
      case "nolimits":
        return null;
      case "not": {
        const next = this.atom();
        return next ? m("mrow", null, next, m("mo", null, "̸")) : null;
      }
      case "begin":
        return this.environment(this.textArg());
      case "end":
        this.textArg();
        return null;
      case "newcommand":
      case "renewcommand":
      case "def": {
        this.define(name);
        return null;
      }
      case "color":
      case "textcolor": {
        // Colours are dropped: science.css is the only style.
        this.textArg();
        return name === "textcolor" ? this.arg() : null;
      }
      case "label":
      case "tag":
        this.textArg();
        return null;
      case "overset":
      case "stackrel": {
        const over = this.arg();
        return m("mover", null, this.arg(), over);
      }
      case "underset": {
        const under = this.arg();
        return m("munder", null, this.arg(), under);
      }
      case "pmod": {
        const a = this.arg();
        return m("mrow", null, m("mspace", { width: "1em" }), m("mo", null, "("), m("mi", null, "mod"), m("mspace", { width: "0.25em" }), a, m("mo", null, ")"));
      }
      case "bmod":
      case "mod":
        return m("mo", null, "mod");
    }
    if (FONTS[name]) {
      const inner = this.arg();
      return withVariant(inner, FONTS[name]);
    }
    if (ACCENTS[name]) {
      const [mark, where] = ACCENTS[name];
      const base = this.arg();
      return where === "over" ? m("mover", { accent: "true" }, base, m("mo", { stretchy: /^(overline|widehat|widetilde|overrightarrow|overbrace)$/.test(name) ? "true" : "false" }, mark)) : m("munder", { accentunder: "true" }, base, m("mo", null, mark));
    }
    return this.unknownCmd(name);
  }

  private delimiter(): string | null {
    this.skipSpaces();
    const t = this.toks[this.i++];
    if (!t) return null;
    if (t.t === "char") return t.v === "." ? null : t.v;
    if (t.t === "cmd") return OPS[t.v] ?? (t.v === "{" || t.v === "}" ? t.v : t.v === "|" ? "‖" : null);
    if (t.t === "open") return "{";
    if (t.t === "close") return "}";
    return null;
  }

  private define(kind: string): void {
    this.skipSpaces();
    let name: string | null = null;
    if (kind === "def") {
      const t = this.toks[this.i++];
      if (t?.t === "cmd") name = t.v;
      let args = 0;
      while (this.peek()?.t === "arg") {
        args = Math.max(args, (this.toks[this.i++] as { n: number }).n);
      }
      const body = this.rawArg();
      if (name && /^[A-Za-z]+$/.test(name)) this.macros.set(name, { args, body });
      return;
    }
    const target = this.rawArg();
    if (target[0]?.t === "cmd") name = target[0].v;
    let args = 0;
    this.skipSpaces();
    if (this.peek()?.t === "char" && (this.peek() as { v: string }).v === "[") {
      this.i++;
      let digits = "";
      while (this.peek()?.t === "char" && (this.peek() as { v: string }).v !== "]") digits += (this.toks[this.i++] as { v: string }).v;
      this.i++;
      args = Math.min(9, Number(digits) || 0);
    }
    const body = this.rawArg();
    if (name && /^[A-Za-z]+$/.test(name) && !(name in SPACES)) this.macros.set(name, { args, body });
  }

  private expand(name: string, macro: Macro): El | null {
    if (++this.expansions > MAX_EXPANSIONS) return this.unknownCmd(name);
    const args: Tok[][] = [];
    for (let k = 0; k < macro.args; k++) args.push(this.rawArg());
    const body: Tok[] = [];
    for (const t of macro.body) {
      if (t.t === "arg") body.push({ t: "open" }, ...(args[t.n - 1] ?? []), { t: "close" });
      else body.push(t);
    }
    const sub = new Parser(body, this.macros, this.display);
    sub.expansions = this.expansions;
    const kids = sub.parseList(() => false);
    this.expansions = sub.expansions;
    this.unknown += sub.unknown;
    return kids.length === 1 ? kids[0] : m("mrow", null, ...kids);
  }

  private environment(env: string): El {
    if (!(env in MATRICES)) return this.unknownCmd(`begin{${env}}`);
    if (env === "array") this.textArg(); // the column spec
    const rows: El[][] = [[]];
    let cell: El[] = [];
    const endCell = () => {
      rows[rows.length - 1].push(m("mtd", null, ...(cell.length ? [cell.length === 1 ? cell[0] : m("mrow", null, ...cell)] : [])));
      cell = [];
    };
    for (;;) {
      const part = this.parseList((t) => t.t === "amp" || t.t === "row" || (t.t === "cmd" && t.v === "end"));
      cell.push(...part);
      const t = this.toks[this.i];
      if (!t) break;
      if (t.t === "amp") {
        this.i++;
        endCell();
      } else if (t.t === "row") {
        this.i++;
        endCell();
        rows.push([]);
      } else {
        this.i++;
        this.textArg();
        break;
      }
    }
    endCell();
    if (rows.length > 1 && rows[rows.length - 1].every((c) => !c.children.length)) rows.pop();
    const align = /^(aligned|align|align\*|split)$/.test(env) ? "right left" : env === "cases" ? "left left" : null;
    const table = m("mtable", align ? { columnalign: align } : null, ...rows.map((r) => m("mtr", null, ...r)));
    const fences = MATRICES[env];
    if (!fences) return table;
    return m("mrow", null, ...(fences[0] ? [m("mo", { fence: "true", stretchy: "true" }, fences[0])] : []), table, ...(fences[1] ? [m("mo", { fence: "true", stretchy: "true" }, fences[1])] : []));
  }
}

/** The same tree, its identifiers in `variant` (bold, double-struck…). */
function withVariant(el: El, variant: string): El {
  if (el.tag === "mi" || el.tag === "mn" || el.tag === "mo" || el.tag === "mtext") return { ...el, attrs: { ...el.attrs, mathvariant: variant } };
  return { ...el, children: el.children.map((c) => (typeof c === "string" ? c : withVariant(c, variant))) };
}

/** Removes the parser's own marks (data-limits) from a finished tree. */
function clean(el: El): El {
  const attrs = Object.fromEntries(Object.entries(el.attrs).filter(([k]) => k !== "data-limits"));
  return { ...el, attrs, children: el.children.map((c) => (typeof c === "string" ? c : clean(c))) };
}

export interface MathResult {
  el: El;
  /** How many commands were not understood (shown as their source). */
  unknown: number;
}

/** A formula as MathML: <math display="block"|…> with its TeX source kept as an annotation. The
 *  macros a document defines are kept in `macros` for its later formulas. */
export function texToMathml(tex: string, display: boolean, macros: Macros = new Map()): MathResult {
  const source = String(tex ?? "").slice(0, 20_000);
  let kids: El[];
  let unknown = 0;
  try {
    const p = new Parser(tokenize(source), macros, display);
    kids = p.parseList(() => false);
    unknown = p.unknown;
  } catch {
    kids = [m("mtext", { class: "math-unknown" }, source)];
    unknown = 1;
  }
  const body = clean(kids.length === 1 ? kids[0] : m("mrow", null, ...kids));
  const el = m(
    "math",
    display ? { display: "block" } : null,
    m("semantics", null, body.tag === "mrow" ? body : m("mrow", null, body), m("annotation", { encoding: "application/x-tex" }, source)),
  );
  return { el, unknown };
}
