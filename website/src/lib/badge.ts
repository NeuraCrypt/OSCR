// The registry's badge (docs/BADGE.md): what it says, how it is drawn, and where it points. Pure
// functions, shared by the Worker (worker/badge.ts, which draws a paper's or a repository's badge on
// demand), by the build (the generic /badge.svg, the help page, a paper's Contribute section), and
// by the reader's browser (the generator /badge/, src/scripts/badge.ts). It never reads
// import.meta.env: the platform's name is passed in (SITE_NAME at build time, /badge/site.json in the
// Worker), so the name still lives in one configuration variable.
//
// The design follows what the badges people already trust do (shields.io, Zenodo's DOI badge,
// Software Heritage's, JOSS's): an SVG of 20 pixels' height, two parts, the left one the platform's
// mark, the right one a short fact; an accessible name (role="img", aria-label, <title>); text sized
// to fit (Verdana's widths, then textLength so that no font substitution overflows). The house
// rules hold: a flat rectangle, never a rounded pill, no decorative uppercase, no em dash.
import { LOGO_BLUE, LOGO_PX, LOGO_WHITE } from "./badge-logo.ts";

/** The logo's blue (public/brand, tools/make_logo_assets.py). */
export const BADGE_BLUE = "#04408F";
/** The right part's grounds, by tone: the masthead's colour, a sober green, a grey. */
export const BADGE_TONES = { info: "#1f3b4d", ok: "#2b6b3f", muted: "#5f5f5f", warning: "#7a4f00" } as const;
export type BadgeTone = keyof typeof BADGE_TONES;

/** The badge's shapes: 20 pixels (the README's), 28 (a web page's header), the mark alone, a card. */
export const BADGE_STYLES = ["flat", "large", "mark", "card"] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];
/** What the right part says. `status` (the default) is what the registry knows of the paper. */
export const BADGE_SHOWS = ["status", "doi", "map", "code", "scripts", "language", "license", "journal"] as const;
export type BadgeShow = (typeof BADGE_SHOWS)[number];
/** Where the badge's link goes (the Worker's redirect, `?to=`). */
export const BADGE_TARGETS = ["paper", "code", "map", "cite", "reader", "doi", "api"] as const;
export type BadgeTarget = (typeof BADGE_TARGETS)[number];

/** The longest text a reader may put on a badge (`text=`). */
export const TEXT_MAX = 40;
/** How long a badge may be kept by a browser, GitHub's camo proxy and Cloudflare's cache: the
 *  records change once a night, so an hour is fresh enough and keeps the Worker's requests low;
 *  stale-while-revalidate lets a cache answer at once while it fetches the new one. */
export const BADGE_MAX_AGE = 3600;
export const BADGE_STALE = 86_400;

/** What the registry knows of a paper or a repository, as the badge needs it (worker/badge.ts reads
 *  it from the static lookup and /data/ files; the generator from the same files in the browser). */
export type BadgeFacts = {
  /** paper: a paper with a page; read: read, no page (no code found); repo: a repository the
   *  registry knows; unknown: neither. */
  kind: "paper" | "read" | "repo" | "unknown";
  doi?: string;
  status?: string;
  title?: string;
  journal?: string;
  year?: string;
  mapDoi?: string;
  /** The paper's code repositories, or the repository's papers. */
  repos?: number;
  papers?: number;
  scripts?: number | null;
  languages?: Record<string, number>;
  license?: string;
};

export type BadgeOptions = {
  style: BadgeStyle;
  show: BadgeShow;
  theme: "blue" | "light";
  /** A reader's own text for the right part (at most TEXT_MAX characters), else "". */
  text: string;
  /** For an unknown key: draw the badge (`show`), or nothing (`hide`: an empty image, for a
   *  GitLab group badge that every project of the group carries). */
  missing: "show" | "hide";
};

export const DEFAULT_OPTIONS: BadgeOptions = { style: "flat", show: "status", theme: "blue", text: "", missing: "show" };

/** A badge's options from a URL's query, anything unknown dropped (never an error: a badge answers). */
export function readOptions(q: URLSearchParams): BadgeOptions {
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const v = (q.get(name) ?? "").toLowerCase() as T;
    return allowed.includes(v) ? v : fallback;
  };
  return {
    style: pick("style", BADGE_STYLES, "flat"),
    show: pick("show", BADGE_SHOWS, "status"),
    theme: pick("theme", ["blue", "light"] as const, "blue"),
    text: cleanText(q.get("text") ?? ""),
    missing: pick("missing", ["show", "hide"] as const, "show"),
  };
}

/** A reader's own text: printable, one line, no email address, at most TEXT_MAX characters. */
export function cleanText(raw: string): string {
  return Array.from(
    raw
      .replace(/[\u0000-\u001f\u007f-\u009f\u2013-\u2015]/g, " ")
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, TEXT_MAX)
    .join("");
}

/** The query that reproduces options (only what differs from the defaults), "" or "?…". */
export function optionQuery(o: Partial<BadgeOptions>): string {
  const q = new URLSearchParams();
  for (const k of ["style", "show", "theme", "text", "missing"] as const) {
    const v = o[k];
    if (v && v !== DEFAULT_OPTIONS[k]) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The main language: the one with the most files. */
function mainLanguage(langs: Record<string, number> | undefined): string {
  const top = Object.entries(langs ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (!top.length) return "";
  return top.length > 1 ? `${top[0][0]} + ${top.length - 1}` : top[0][0];
}

/** What the right part says, and its tone. */
export function badgeMessage(f: BadgeFacts, show: BadgeShow = "status"): { text: string; tone: BadgeTone } {
  if (f.kind === "unknown") return { text: "not registered", tone: "muted" };
  if (f.kind === "read") return { text: show === "doi" && f.doi ? f.doi : "read, no code found", tone: "muted" };
  const validated = !!f.mapDoi;
  switch (show) {
    case "doi":
      if (f.doi) return { text: f.doi, tone: "info" };
      break;
    case "map":
      return validated ? { text: `map ${f.mapDoi}`, tone: "ok" } : { text: "no validated map yet", tone: "muted" };
    case "code":
      if (f.kind === "repo") return f.papers ? { text: `code of ${plural(f.papers, "paper")}`, tone: "info" } : { text: "not registered", tone: "muted" };
      if (f.repos) return { text: plural(f.repos, "repository", "repositories"), tone: "info" };
      break;
    case "scripts":
      if (typeof f.scripts === "number") return { text: plural(f.scripts, "script"), tone: "info" };
      break;
    case "language": {
      const l = mainLanguage(f.languages);
      if (l) return { text: l, tone: "info" };
      break;
    }
    case "license":
      if (f.license) return { text: f.license, tone: "info" };
      break;
    case "journal":
      if (f.journal) return { text: [f.journal, f.year].filter(Boolean).join(", "), tone: "info" };
      break;
  }
  if (f.kind === "repo") {
    if (!f.papers) return { text: "not registered", tone: "muted" };
    return f.papers === 1 ? { text: validated ? "paper ↔ code · validated" : "paper ↔ code", tone: validated ? "ok" : "info" } : { text: `code of ${plural(f.papers, "paper")}`, tone: "info" };
  }
  switch (f.status) {
    case "on_request":
      return { text: "code on request", tone: "info" };
    case "data_only":
      return { text: "data only", tone: "info" };
    default:
      return validated ? { text: "paper ↔ code · validated", tone: "ok" } : { text: "paper ↔ code", tone: "info" };
  }
}

// ── drawing ──────────────────────────────────────────────────────────────────────────────────────

/** Verdana's advance widths (units of 1/2048 em) for the characters a badge says; others take the
 *  average. textLength then makes any substituted font fit the same box. */
const VERDANA: Record<string, number> = {
  " ": 720, "!": 823, '"': 1033, "#": 1882, "$": 1430, "%": 2477, "&": 1638, "'": 563, "(": 1047, ")": 1047, "*": 1430,
  "+": 1882, ",": 745, "-": 1069, ".": 745, "/": 1251, ":": 1003, ";": 1003, "<": 1882, "=": 1882, ">": 1882, "?": 1251,
  "@": 2252, "[": 1047, "\\": 1251, "]": 1047, "_": 1430, "|": 1047, "·": 745, "↔": 2048, "–": 1430,
  A: 1401, B: 1405, C: 1430, D: 1577, E: 1294, F: 1178, G: 1587, H: 1540, I: 865, J: 1032, K: 1423, L: 1145, M: 1739,
  N: 1530, O: 1615, P: 1238, Q: 1615, R: 1426, S: 1401, T: 1243, U: 1500, V: 1401, W: 2025, X: 1403, Y: 1243, Z: 1405,
  a: 1229, b: 1271, c: 1066, d: 1271, e: 1219, f: 719, g: 1271, h: 1296, i: 562, j: 683, k: 1186, l: 562, m: 1996,
  n: 1296, o: 1243, p: 1271, q: 1271, r: 874, s: 1067, t: 807, u: 1296, v: 1186, w: 1675, x: 1186, y: 1186, z: 1084,
};
const DIGIT = 1303;
const AVERAGE = 1300;

/** A text's width in pixels, in Verdana at `size` pixels. */
export function textWidth(text: string, size = 11): number {
  let units = 0;
  for (const ch of Array.from(text)) units += /\d/.test(ch) ? DIGIT : (VERDANA[ch] ?? AVERAGE);
  return (units / 2048) * size;
}

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A text cut to fit `max` pixels, with an ellipsis. */
function fit(text: string, max: number, size: number): string {
  if (textWidth(text, size) <= max) return text;
  const chars = Array.from(text);
  while (chars.length && textWidth(`${chars.join("")}…`, size) > max) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The logo part: the mark, `h` pixels high, on the logo's blue (or white in the light theme). */
function logoPart(x: number, height: number, markH: number, pad: number, theme: BadgeOptions["theme"]): { svg: string; width: number } {
  const markW = r1((LOGO_PX.width / LOGO_PX.height) * markH);
  const width = r1(markW + 2 * pad);
  const ground = theme === "light" ? "#ffffff" : BADGE_BLUE;
  const href = theme === "light" ? LOGO_BLUE : LOGO_WHITE;
  return {
    width,
    svg:
      `<rect x="${x}" width="${width}" height="${height}" fill="${ground}"/>` +
      `<image x="${r1(x + pad)}" y="${r1((height - markH) / 2)}" width="${markW}" height="${markH}" xlink:href="${href}"/>`,
  };
}

/** A badge, as an SVG document (the image's whole text). `name` is the platform's (SITE_NAME). */
export function renderBadge(name: string, f: BadgeFacts, o: BadgeOptions = DEFAULT_OPTIONS): string {
  if (f.kind === "unknown" && o.missing === "hide") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" role="presentation"/>`;
  }
  if (o.style === "card") return renderCard(name, f, o);
  const said = o.text ? { text: o.text, tone: "info" as BadgeTone } : badgeMessage(f, o.show);
  const large = o.style === "large";
  const height = large ? 28 : 20;
  const size = large ? 13 : 11;
  const markH = large ? 14 : 10;
  const pad = large ? 9 : 6;
  const logo = logoPart(0, height, markH, pad, o.theme);
  const label = `${name}: ${said.text}`;
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="WIDTH" height="${height}" ` +
    `viewBox="0 0 WIDTH ${height}" role="img" aria-label="${escapeXml(label)}"><title>${escapeXml(label)}</title>`;
  let width = logo.width;
  let body = logo.svg;
  if (o.style !== "mark") {
    const text = fit(said.text, 360, size);
    const tw = r1(textWidth(text, size));
    const right = r1(tw + 2 * pad);
    body +=
      `<rect x="${width}" width="${right}" height="${height}" fill="${BADGE_TONES[said.tone]}"/>` +
      `<text x="${r1(width + pad)}" y="${r1(height / 2 + size * 0.36)}" fill="#ffffff" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" ` +
      `font-size="${size}" textLength="${tw}" lengthAdjust="spacingAndGlyphs">${escapeXml(text)}</text>`;
    width = r1(width + right);
  }
  if (o.theme === "light") {
    // A thin frame, so that the white part keeps its edge on a white page.
    body += `<rect x="0.5" y="0.5" width="${r1(width - 1)}" height="${height - 1}" fill="none" stroke="${BADGE_BLUE}"/>`;
  }
  return `${head.replace(/WIDTH/g, String(width))}${body}</svg>`;
}

/** The card: a larger badge for a web page, a lab's site or a slide (the title, the journal, what
 *  the registry knows), 420 × 64 pixels. */
function renderCard(name: string, f: BadgeFacts, o: BadgeOptions): string {
  const W = 420;
  const H = 64;
  const said = o.text ? { text: o.text, tone: "info" as BadgeTone } : badgeMessage(f, "status");
  const logo = logoPart(0, H, 16, 14, o.theme);
  const x = logo.width + 12;
  const room = W - x - 12;
  // Bold Verdana is about an eighth wider than the regular widths the table gives.
  const title = fit(f.title || f.doi || (f.kind === "unknown" ? "Not in the registry yet" : ""), room / 1.14, 13);
  const meta = fit([f.journal, f.year, f.doi && f.title ? `doi:${f.doi}` : ""].filter(Boolean).join(" · "), room, 11);
  const state = fit(
    [said.text, f.repos ? plural(f.repos, "repository", "repositories") : "", typeof f.scripts === "number" ? plural(f.scripts, "script") : ""]
      .filter(Boolean)
      .join(" · "),
    room,
    11,
  );
  const label = `${name}: ${[f.title, said.text].filter(Boolean).join(", ")}`;
  const font = `font-family="Verdana,DejaVu Sans,Geneva,sans-serif"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `role="img" aria-label="${escapeXml(label)}"><title>${escapeXml(label)}</title>` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    logo.svg +
    `<text x="${x}" y="22" fill="#1a1a1a" ${font} font-size="13" font-weight="bold">${escapeXml(title)}</text>` +
    (meta ? `<text x="${x}" y="39" fill="#555555" ${font} font-size="11">${escapeXml(meta)}</text>` : "") +
    `<text x="${x}" y="55" fill="${BADGE_TONES[said.tone]}" ${font} font-size="11">${escapeXml(state)}</text>` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#c8c8c8"/>` +
    `</svg>`
  );
}

/** The shields.io endpoint's answer (shields.io/badges/endpoint-badge): the same facts, for a
 *  reader who wants shields' own styles (`https://img.shields.io/endpoint?url=…`). */
export function endpointJson(name: string, f: BadgeFacts, o: BadgeOptions = DEFAULT_OPTIONS) {
  const said = o.text ? { text: o.text, tone: "info" as BadgeTone } : badgeMessage(f, o.show);
  return {
    schemaVersion: 1,
    label: name,
    message: said.text,
    color: BADGE_TONES[said.tone].slice(1),
    labelColor: BADGE_BLUE.slice(1),
    isError: f.kind === "unknown",
    logoSvg: logoSvg(),
    cacheSeconds: BADGE_MAX_AGE,
  };
}

/** The mark alone as an SVG (shields.io's `logoSvg` wants an SVG text). */
export function logoSvg(): string {
  const w = r1((LOGO_PX.width / LOGO_PX.height) * 14);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="14" viewBox="0 0 ${w} 14"><image width="${w}" height="14" xlink:href="${LOGO_WHITE}"/></svg>`;
}

// ── addresses and snippets ───────────────────────────────────────────────────────────────────────

/** A repository's key as the registry writes it (oscr/links.py): host/owner/name, lower case; a
 *  GitLab project keeps its groups; a Hugging Face dataset or Space keeps its kind. "" when the text
 *  is not a repository's address. */
export function badgeRepoKey(text: string): string {
  let t = (text ?? "").trim();
  if (!t || t.length > 300 || /\s/.test(t)) return "";
  t = t.replace(/^git\+/i, "").replace(/^git@([^:/]+):/i, "$1/");
  t = t.replace(/^(?:https?|git|ssh):\/\//i, "").replace(/^[^@/]+@/, "").replace(/^www\./i, "");
  t = t.split(/[?#]/)[0];
  const parts = t.split("/").filter(Boolean);
  if (parts.length < 3) return "";
  const host = parts[0].toLowerCase().replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return "";
  let path: string[];
  if (host === "huggingface.co") {
    path = ["datasets", "spaces"].includes(parts[1].toLowerCase()) ? parts.slice(1, 4) : parts.slice(1, 3);
    if (path.length < 2 || (path.length === 2 && ["datasets", "spaces"].includes(path[0].toLowerCase()))) return "";
  } else if (host === "gitlab.com" || host.startsWith("gitlab.")) {
    const cut = parts.indexOf("-");
    path = cut >= 0 ? parts.slice(1, cut) : parts.slice(1);
    path = path.filter((s, i) => !(i >= 2 && ["tree", "blob"].includes(s))); // a URL copied from a file
  } else {
    path = parts.slice(1, 3);
  }
  path = path.map((s, i, all) => (i === all.length - 1 ? s.replace(/\.git$/i, "") : s));
  if (path.length < 2 || !path.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..")) return "";
  return `${host}/${path.join("/")}`.toLowerCase();
}

/** "https://doi.org/10.1234/ABC" or "doi:10.1234/abc" → "10.1234/abc"; "" when it is not a DOI.
 *  The same rule as normalizeDoi in worker/v1/index.ts, src/scripts/lookup.ts and oscr/entities.py. */
export function badgeDoi(text: string): string {
  let doi = (text ?? "").trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  if (doi.includes("%")) {
    try {
      doi = decodeURIComponent(doi);
    } catch {
      // not an encoded DOI: kept as typed
    }
  }
  doi = doi.toLowerCase();
  return /^10\.\d{3,9}\/\S+$/.test(doi) ? doi : "";
}

/** A DOI in a path: every character but the slash percent-encoded (a DOI may hold ?, # or %). */
export const doiPath = (doi: string) => doi.split("/").map(encodeURIComponent).join("/");

/** What the badge is about: a paper (by its DOI) or a repository (by its key). */
export type BadgeSubject = { kind: "doi"; doi: string } | { kind: "repo"; repo: string };

/** The badge's addresses: its image, its shields.io endpoint, and its link (the Worker's redirect). */
export function badgeUrls(origin: string, s: BadgeSubject, o: Partial<BadgeOptions> = {}, to: BadgeTarget = "paper") {
  const base = s.kind === "doi" ? `${origin}/badge/doi/${doiPath(s.doi)}` : `${origin}/badge/repo/${s.repo}`;
  // A DOI that ends as a badge's suffix would be read as one: such a DOI goes in the query.
  const odd = s.kind === "doi" && /\.(svg|json)$/i.test(s.doi);
  const q = optionQuery(o);
  const join = (suffix: string, query: string) =>
    odd ? `${origin}/badge/doi${suffix}?doi=${encodeURIComponent((s as { doi: string }).doi)}${query ? `&${query.slice(1)}` : ""}` : `${base}${suffix}${query}`;
  const json = join(".json", optionQuery({ show: o.show, text: o.text }));
  return {
    image: join(".svg", q),
    json,
    shields: `https://img.shields.io/endpoint?url=${encodeURIComponent(json)}`,
    link: join("", to === "paper" ? "" : `?to=${to}`),
  };
}

export const SNIPPET_FORMATS = [
  { id: "markdown", label: "Markdown", where: "README.md on GitHub, GitLab, Codeberg, Bitbucket; a Hugging Face model, dataset or Space card; PyPI; a Jupyter notebook; MkDocs" },
  { id: "html", label: "HTML", where: "a web page, a lab's site, a Quarto or R Markdown document, pkgdown, Sphinx's raw HTML, a README that mixes HTML" },
  { id: "rst", label: "reStructuredText", where: "README.rst, PyPI, Sphinx and Read the Docs" },
  { id: "asciidoc", label: "AsciiDoc", where: "README.adoc on GitHub or GitLab, Antora" },
  { id: "org", label: "Org", where: "README.org on GitHub or GitLab, Emacs" },
  { id: "latex", label: "LaTeX", where: "a poster, slides or a thesis (with the hyperref package; the PNG mark, LaTeX reads no SVG)" },
] as const;
export type SnippetFormat = (typeof SNIPPET_FORMATS)[number]["id"];

/** A badge's snippet in a markup. */
export function snippet(format: SnippetFormat, image: string, link: string, alt: string): string {
  switch (format) {
    case "markdown":
      return `[![${alt.replace(/[[\]]/g, "")}](${image})](${link})`;
    case "html":
      return `<a href="${escapeXml(link)}"><img src="${escapeXml(image)}" alt="${escapeXml(alt)}"></a>`;
    case "rst":
      return `.. image:: ${image}\n   :target: ${link}\n   :alt: ${alt}`;
    case "asciidoc":
      return `image:${image}[${alt.replace(/[\]]/g, "")},link="${link}"]`;
    case "org":
      return `[[${link}][${image}]]`;
    case "latex":
      // LaTeX reads no SVG: the static PNG (/badge.png, saved next to the .tex as oscr-badge.png).
      return `\\href{${link.replace(/([%#&_])/g, "\\$1")}}{\\includegraphics[height=1.2em]{oscr-badge.png}}`;
  }
}

/** The marks the CLI and the generator put around a badge in a README, so that it is replaced, never
 *  added twice (the same as cli/src/oscr_cli/badge.py). */
export const README_MARKS = { start: "<!-- oscr-badge:start -->", end: "<!-- oscr-badge:end -->" } as const;

/** Whether a README's text already carries the registry's badge (any form: the generic image, a
 *  paper's, a repository's, a shields.io endpoint's, the CLI's marks). `host` is the site's host. */
export function hasBadge(readme: string, host: string): boolean {
  const text = readme.toLowerCase();
  const h = host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return text.includes(`${h}/badge`) || text.includes(`${h}%2fbadge`) || text.includes(README_MARKS.start);
}

// ── the "Add the badge" box (every paper's and every scientific tool's page) ─────────────────────────

/** The marks around a badge in a README, by markup (cli/src/oscr_cli/badge.py MARKS). A snippet copied
 *  with its marks is one that `oscr badge --write`, the GitHub Action and the App replace in place. */
export const BOX_MARKS: Record<"markdown" | "rst" | "html", { start: string; end: string }> = {
  markdown: README_MARKS,
  html: README_MARKS,
  rst: { start: ".. oscr-badge:start", end: ".. oscr-badge:end" },
};

/** A snippet between its marks, ready to paste (rst keeps a blank line around its directive). */
export function markedSnippet(format: keyof typeof BOX_MARKS, text: string): string {
  const m = BOX_MARKS[format];
  return format === "rst" ? `${m.start}\n\n${text}\n\n${m.end}` : `${m.start}\n${text}\n${m.end}`;
}

/** A repository whose README a box points to: its name, its address, its README's path when known. */
export interface BoxRepo {
  name: string;
  url: string;
  readme?: string;
}

/** What the box shows, for a paper (its DOI) or a repository (a scientific tool): the image, the
 *  three common snippets with their marks, and for each GitHub repository its README on GitHub,
 *  where the author edits it themselves (the registry asks GitHub for nothing). */
export function badgeBox(origin: string, subject: BadgeSubject, alt: string, repos: readonly BoxRepo[] = []) {
  const urls = badgeUrls(origin, subject);
  const formats = ["markdown", "rst", "html"] as const;
  return {
    image: urls.image,
    link: urls.link,
    snippets: formats.map((f) => ({
      format: f,
      label: SNIPPET_FORMATS.find((s) => s.id === f)!.label,
      text: markedSnippet(f, snippet(f, urls.image, urls.link, alt)),
    })),
    github: repos
      .filter((r) => /^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(r.url))
      .map((r) => {
        const base = r.url.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/").slice(0, 5).join("/");
        return { name: r.name, readme: r.readme ?? "", url: r.readme ? `${base}/blob/HEAD/${r.readme}` : base };
      }),
  };
}
export type BadgeBox = ReturnType<typeof badgeBox>;
