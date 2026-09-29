// What the /r/ shell shows of a repository (night phase 01, E7): pure functions, no DOM, testable in
// Node (tests/forge-pages/repo-view.test.ts). The shell's script (src/scripts/repo-shell.ts) reads,
// then turns the view trees built here into DOM nodes; the Code button's panel and the quick setup
// of an empty repository are src/scripts/repo-code-panel.ts.
//
// - Reading (`loadRepository`): the repository from GitHub's anonymous API, in the reader's browser
//   and on the reader's own quota (a GitSession over {kind: "anonymous"}: 1 request for the
//   repository, 1 for its latest commit, 1 for its README; 0 Worker requests, D00-5), and OSCR's
//   layer: the static shard /forge/layer/NN.json signed out, GET /api/forge/repo signed in. A rate
//   limit or an outage degrades to a sentence and a link to GitHub; the page never waits on GitHub
//   to show the clone commands, which need no request.
// - Showing: the heading line (.repo-head), the status line in words (p.status-line: how the
//   registry follows the repository and when it last saw it, never a pill), the papers it is
//   attached to, "no longer at the source" for a gone repository, the GitHub Pages site (linked,
//   never rebuilt), a README excerpt.
// - Every text of a view tree goes through `maskEmails` when the tree is built (CLAUDE.md: the site
//   shows no email address); links are this site's paths, https addresses without credentials, or
//   GitHub Desktop's own scheme, and anything else stays text.
//
// Like every browser script, it never names the platform: the page hands its name in (`site`,
// from src/config.ts at build time), or the sentences say "the registry".

import { GitBackendError } from "../../worker/forge/errors.ts";
import type { GitSession } from "../../worker/forge/gitbackend.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import type { RepoState } from "../../worker/forge/service/types.ts";
import type * as T from "../../worker/forge/types.ts";
import {
  GITHUB,
  isOwner,
  isRepoName,
  layerShard,
  layerUrl,
  parseRepoPath,
  repoPath,
  repoWebUrl,
  viewPath,
  type LayerMode,
  type RepoCoords,
  type RepoPath,
  type RepoView,
  type ShellLayer,
  type ShellPaper,
  type ShellRepo,
} from "./forge.ts";
import { dateInWords, plural } from "./format.ts";

// ─── view trees: what the shell turns into DOM nodes ─────────────────────────

/** An element of a view tree. Text children are already masked. */
export interface El {
  tag: Tag;
  attrs: Record<string, string>;
  children: (string | El)[];
}

export type Child = string | El | null | undefined | false;

/** The elements a view may use: science.css's vocabulary, nothing else. Phase 02 adds what a
 *  rendered file needs (GitHub's own tag filter, less what runs or embeds: no script, style,
 *  iframe, object, embed, form posting elsewhere, video or audio) and MathML for math. */
export const HTML_TAGS = [
  "a", "button", "code", "details", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "nav", "p", "pre", "section", "span",
  "strong", "summary", "ul", "ol", "em", "del", "ins", "sub", "sup", "kbd", "samp", "var", "q", "cite", "dfn", "abbr", "s",
  "b", "i", "u", "blockquote", "hr", "br", "img", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "dl", "dt", "dd", "small", "mark", "figure", "figcaption", "time", "input", "label", "form", "header", "footer",
  "select", "option",
] as const;
/** MathML Core's presentation elements (math is rendered by the browser: no script, no font). */
export const MATH_TAGS = [
  "math", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "msub", "msup", "msubsup", "mfrac", "msqrt", "mroot",
  "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom", "semantics", "annotation",
] as const;
export const TAGS = [...HTML_TAGS, ...MATH_TAGS] as const;
export type Tag = (typeof TAGS)[number];

/** The attributes a view may set (no style, no event handler, no inline anything). `src` takes
 *  only an image the page made itself (safeSrc); `id`s from a repository's text carry
 *  "user-content-" (the renderers add it), so none clobbers the page's own. */
export const ATTRS = [
  "class", "href", "id", "aria-label", "aria-current", "aria-live", "type", "open", "hidden",
  "src", "alt", "title", "start", "checked", "disabled", "colspan", "rowspan", "name", "value", "placeholder",
  "autocomplete", "spellcheck", "role", "tabindex", "aria-hidden", "aria-expanded", "aria-controls", "aria-describedby",
  "for", "datetime", "rel", "lang", "maxlength",
  "display", "mathvariant", "stretchy", "accent", "accentunder", "fence", "separator", "lspace", "rspace", "columnalign",
  "linethickness", "encoding", "width", "depth", "height", "movablelimits", "largeop", "symmetric", "scriptlevel",
] as const;

/** An image source a view may carry: an object URL the page made from bytes it read (blob:), or
 *  a data: URL of a raster or SVG image (a notebook's outputs). An <img> never runs a script, so an
 *  SVG shown this way is inert. Anything else is null: no external image loads without the
 *  reader's click (D02-6). */
export function safeSrc(src: unknown): string | null {
  if (typeof src !== "string" || src.length > 15_000_000) return null;
  if (/^blob:(?:https?:\/\/[A-Za-z0-9.:-]+|null)\/[0-9a-fA-F-]{8,64}$/.test(src)) return src;
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/.test(src)) return src;
  return null;
}

/** A link a view may carry: an anchor of this page (#name), a path of this site, an https address
 *  without credentials or "@"
 *  (an email address never hides in a link either), or GitHub Desktop's own scheme on a GitHub
 *  address. Anything else is null, and the view keeps only the link's text. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string" || !href || href.length > 2000 || /[\s"'<>\\@]/.test(href)) return null;
  if (href.startsWith("#")) return /^#[A-Za-z][A-Za-z0-9_.:-]{0,200}$/.test(href) ? href : null;
  if (href.startsWith("/")) return href.startsWith("//") ? null : href;
  if (href.startsWith("x-github-client://openRepo/")) {
    return safeHref(href.slice("x-github-client://openRepo/".length))?.startsWith(`${GITHUB}/`) ? href : null;
  }
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  return u.protocol === "https:" && !u.username && !u.password ? href : null;
}

/** A data attribute a view may set (a script's own state, never read as markup): data-<words>. */
export const isDataAttr = (name: string): boolean => /^data-[a-z]{1,20}(?:-[a-z]{1,20}){0,2}$/.test(name);

/** Whether a view may set this attribute. */
export const allowedAttr = (name: string): boolean => (ATTRS as readonly string[]).includes(name) || isDataAttr(name);

/** The attributes a reader sees or hears as text (a tooltip, an image's words, a label): masked
 *  for email addresses like the text itself (phase 02: a repository's Markdown and notebooks). */
const TEXT_ATTRS = new Set(["title", "alt", "aria-label", "placeholder", "value"]);

/** An element: attributes outside ATTRS (and data-*) are dropped, an unsafe href is dropped (the
 *  text stays), and every text child is masked, and so is every attribute read as text. */
export function h(tag: Tag, attrs: Record<string, string | null | undefined | false> | null, ...children: (Child | Child[])[]): El {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false || !allowedAttr(k)) continue;
    if (k === "href") {
      const safe = safeHref(v);
      if (safe) out.href = safe;
    } else if (k === "src") {
      const safe = safeSrc(v);
      if (safe) out.src = safe;
    } else out[k] = TEXT_ATTRS.has(k) ? maskEmails(String(v)) : String(v);
  }
  const kids: (string | El)[] = [];
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false || c === "") continue;
    kids.push(typeof c === "string" ? maskEmails(c) : c);
  }
  return { tag, attrs: out, children: kids };
}

/** A link, or its text alone when the address is not one a view may carry. */
export const link = (href: string, text: string, cls?: string): El | string =>
  safeHref(href) ? h("a", { href, class: cls }, text) : maskEmails(text);

/** The text a tree shows, as a reader would read it. */
export function textOf(node: string | El | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return node.children.map(textOf).join("");
}

/** Every element of a tree, depth first (the tests walk it). */
export function* walk(node: string | El): Generator<El> {
  if (typeof node === "string") return;
  yield node;
  for (const c of node.children) yield* walk(c);
}

// ─── dates and words ─────────────────────────────────────────────────────────

/** Unix seconds → "28 September 2026"; null when not a time. */
export function dateOf(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : dateInWords(d.toISOString().slice(0, 10));
}

/** An ISO time → "28 September 2026"; null when not a time. */
export function dateOfIso(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : dateOf(t / 1000);
}

/** The platform's name as the page hands it in, or "the registry". */
export const siteName = (site: string | null | undefined): string =>
  typeof site === "string" && site.trim() && !site.includes("@") ? site.trim().slice(0, 60) : "the registry";

/** A sentence's first word: "the registry" → "The registry"; "OSCR" stays. */
export const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ─── OSCR's layer ────────────────────────────────────────────────────────────

/** OSCR's layer as the shell reads it: ShellLayer, with what a gone repository needs. */
export interface ViewLayer extends ShellLayer {
  /** Software Heritage's archive of the repository (a SWHID or an address of its archive), when
   *  the author asked for one (D00-15). */
  swh: string | null;
  /** How many of its files the registry keeps as licensed script copies (the Mac's count). */
  copies: number | null;
}

const LAYER_MODES: readonly LayerMode[] = ["catalogue", "created", "installed", "public"];
const STATES: readonly RepoState[] = ["active", "archived", "pending_deletion", "hidden", "deleted", "gone"];
const DOI = /^10\.\d{4,9}\/\S{1,300}$/;
const SLUG = /^[A-Za-z0-9._-]{1,200}$/;

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};
const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? maskEmails(v.trim()).slice(0, max) : null);

/** A layer entry (the static shard's snake_case, or the API's camelCase), checked field by field;
 *  null when it is not one. */
export function parseLayer(value: unknown): ViewLayer | null {
  const o = record(value);
  if (!o) return null;
  const forge = o.forge ?? "github";
  const mode = o.mode as LayerMode;
  if (forge !== "github" || !LAYER_MODES.includes(mode)) return null;
  const state = (STATES as readonly unknown[]).includes(o.state) ? (o.state as RepoState) : "active";
  const rawId = o.id;
  const id = typeof rawId === "number" && Number.isInteger(rawId) ? String(rawId) : typeof rawId === "string" && /^\d{1,20}$/.test(rawId) ? rawId : null;
  const papers: ShellPaper[] = [];
  for (const p of Array.isArray(o.papers) ? o.papers.slice(0, 50) : []) {
    const r = record(p);
    if (!r || typeof r.doi !== "string" || !DOI.test(r.doi)) continue;
    papers.push({
      doi: r.doi,
      slug: typeof r.slug === "string" && SLUG.test(r.slug) ? r.slug : null,
      title: text(r.title),
      status: r.status === "linked" || r.status === "proposed" ? r.status : null,
    });
  }
  const swh = pick(o, "swh", "software_heritage", "softwareHeritage");
  return {
    forge: "github",
    id,
    mode,
    state,
    headAt: time(pick(o, "head_at", "headAt")),
    lastSeen: time(pick(o, "last_seen", "lastSeen")),
    papers,
    maps: count(o.maps) ?? 0,
    paths: count(o.paths),
    deleteAfter: time(pick(o, "delete_after", "deleteAfter")),
    roles: Array.isArray(o.roles) ? o.roles.filter((r): r is string => typeof r === "string" && /^[a-z_]{1,40}$/.test(r)) : [],
    swh: typeof swh === "string" && swhUrl(swh) ? swh : null,
    copies: count(o.copies),
    reviewers: (Array.isArray(o.reviewers) ? o.reviewers.slice(0, 30) : [])
      .map(record)
      .filter((r): r is Record<string, unknown> => !!r && typeof r.login === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(r.login))
      .map((r) => ({ login: r.login as string, papers: (Array.isArray(r.papers) ? r.papers : []).filter((d): d is string => typeof d === "string" && DOI.test(d)).slice(0, 20) })),
    // Phase 05: the research issues, checked field by field where they are read (issue-view.ts).
    research: Array.isArray(o.research) ? o.research.slice(0, 1000) : undefined,
  };
}

/** Software Heritage's page for a SWHID or an address of its archive; null otherwise. */
export function swhUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (/^swh:1:(?:ori|snp|rel|rev|dir|cnt):[0-9a-f]{40}(?:;[A-Za-z]+=[^\s;]{1,300})*$/.test(value)) return `https://archive.softwareheritage.org/${value}`;
  return value.startsWith("https://archive.softwareheritage.org/") && safeHref(value) ? value : null;
}

// ─── the status line ─────────────────────────────────────────────────────────

/** The paper a repository is "the code of", as a link (its page, or its DOI). */
function paperLink(p: ShellPaper): El | string {
  const label = p.title ?? p.doi;
  return p.slug ? link(`/paper/${p.slug}/`, label) : link(`https://doi.org/${p.doi}`, label);
}

/** How the registry follows the repository, in words: its mode, then its state. */
export function statusLine(layer: ShellLayer | null, siteIn?: string | null, layerUnknown = false): El {
  const site = siteName(siteIn);
  const parts: Child[] = [];
  let tone: "" | "warning" = "";
  if (!layer) {
    parts.push(layerUnknown ? `Whether it is linked to ${site} could not be read just now.` : `Not linked to ${site}.`);
  } else {
    const pushed = dateOf(layer.headAt ?? layer.lastSeen);
    const seen = dateOf(layer.lastSeen ?? layer.headAt);
    switch (layer.mode) {
      case "installed":
        parts.push(`Linked to ${site} with the App installed: ${site} receives its pushes; ${pushed ? `last push seen ${pushed}` : "no push seen yet"}.`);
        break;
      case "created":
        parts.push(`Created with ${site}, with the App installed: ${site} receives its pushes; ${pushed ? `last push seen ${pushed}` : "no push seen yet"}.`);
        break;
      case "public":
        parts.push(`Public, without the App: read only, ${site} checks it every night; ${seen ? `last seen ${seen}` : "not checked yet"}.`);
        break;
      case "catalogue": {
        const [first, ...others] = layer.papers;
        parts.push(`Not linked to ${site}`);
        if (first) {
          parts.push("; the catalogue lists it as the code of ", paperLink(first));
          if (others.length) parts.push(` and of ${plural(others.length, "other paper")}`);
        }
        parts.push(`. ${seen ? `Last seen ${seen}.` : "Not checked yet."}`);
        break;
      }
    }
    switch (layer.state) {
      case "archived":
        parts.push(" Archived: read only.");
        break;
      case "pending_deletion": {
        const after = dateOf(layer.deleteAfter);
        parts.push(after ? ` Waiting for deletion: hidden from ${site} after ${after}, unless its owner restores it.` : " Waiting for deletion.");
        tone = "warning";
        break;
      }
      case "hidden":
      case "deleted":
        parts.push(` Hidden from ${site}.`);
        tone = "warning";
        break;
      case "gone":
        parts.push(" No longer at the source: GitHub does not serve it any more.");
        tone = "warning";
        break;
    }
  }
  return h("p", { class: tone ? `status-line ${tone}` : "status-line", "aria-live": "polite" }, ...parts);
}

// ─── the heading line ────────────────────────────────────────────────────────

export interface HeadFacts {
  owner: string;
  name: string;
  /** Unknown while GitHub has not answered (rate limit, outage): no fact is claimed. */
  info: Pick<T.RepoInfo, "visibility" | "archived" | "disabled" | "isTemplate" | "parent"> | null;
}

/** "owner / name", then what it is in words: public, a template, archived, a fork. The owner is
 *  GitHub's login (the registry has no handles of its own), not a link: readers are not sent to
 *  GitHub (the owner's rule, 2026-09-29). */
export function repoHead({ owner, name, info }: HeadFacts): El {
  const facts: Child[] = [];
  if (info) {
    if (info.visibility === "public") facts.push(h("span", null, "public"));
    if (info.isTemplate) facts.push(h("span", null, "a template"));
    if (info.archived) facts.push(h("span", null, "archived on GitHub: read only"));
    if (info.disabled) facts.push(h("span", null, "disabled by GitHub"));
    if (info.parent && isOwner(info.parent.owner) && isRepoName(info.parent.name)) {
      facts.push(h("span", null, "a fork of ", link(repoPath(info.parent), `${info.parent.owner}/${info.parent.name}`)));
    }
  }
  return h(
    "div",
    { class: "repo-head" },
    h("h1", null, h("span", { class: "owner" }, owner), " / ", name),
    facts.length ? h("span", { class: "facts" }, ...facts) : null,
  );
}

/** The bar of the shell's views, under the heading (nav.tabs, never pills). */
export function repoTabs(repo: RepoCoords, view: RepoView): El {
  // Every code view (tree, blob, commits, commit, compare, find, search) is under Code; a pull
  // request and the list under Pull requests (phase 04); an issue, the list, labels and milestones
  // under Issues (phase 05).
  const shown: RepoView =
    view === "settings" || view === "branches"
      ? view
      : view === "pulls" || view === "pull"
        ? "pulls"
        : view === "issues" || view === "labels" || view === "milestones" || view === "milestone"
          ? "issues"
          : "home";
  const tab = (v: RepoView, label: string) =>
    h("li", null, h("a", { href: repoPath(repo, v), "aria-current": v === shown ? "page" : null }, label));
  return h("nav", { class: "tabs", "aria-label": "Repository" }, h("ul", null, tab("home", "Code"), tab("issues", "Issues"), tab("pulls", "Pull requests"), tab("branches", "Branches"), tab("settings", "Settings")));
}

// ─── the papers, the Pages site, the archive ─────────────────────────────────

/** The papers the repository is attached to, and the tracing maps that point to it. */
export function papersBlock(layer: ShellLayer | null, siteIn?: string | null): El[] {
  const site = siteName(siteIn);
  const out: El[] = [h("h3", null, "Papers")];
  if (!layer || !layer.papers.length) {
    out.push(h("p", null, "Not attached to any paper yet."));
  } else {
    out.push(
      h("ul", null, layer.papers.map((p) => h("li", null, paperLink(p), p.status === "proposed" ? " (proposed, not confirmed yet)" : null))),
    );
  }
  if (layer && layer.maps > 0) {
    out.push(
      h(
        "p",
        null,
        `${plural(layer.maps, "tracing map")} point${layer.maps === 1 ? "s" : ""} to its commits. If the source rewrites its history or disappears, ` +
          `${site} keeps showing the cited commits, marked "no longer at the source".`,
      ),
    );
  }
  return out;
}

/** The repository's GitHub Pages site: a homepage on github.io, or the <owner>.github.io
 *  repository's own site; null when it has none. Linked, never rebuilt. */
export function pagesSite(owner: string, name: string, homepage: string | null | undefined): string | null {
  if (typeof homepage === "string" && safeHref(homepage)) {
    try {
      const u = new URL(homepage);
      if (u.protocol === "https:" && /^[a-z0-9-]{1,39}\.github\.io$/i.test(u.hostname)) return homepage;
    } catch {
      // not an address: no site
    }
  }
  if (isOwner(owner) && name.toLowerCase() === `${owner}.github.io`.toLowerCase() && /^[A-Za-z0-9-]{1,39}$/.test(owner)) {
    return `https://${owner.toLowerCase()}.github.io/`;
  }
  return null;
}

export function pagesBlock(site: string | null, siteIn?: string | null): El[] {
  if (!site) return [];
  return [
    h("h3", null, "Website"),
    h("p", null, "Its GitHub Pages site: ", link(site, site.replace(/^https:\/\//, "").replace(/\/$/, "")), `. GitHub serves it as the authors built it; ${siteName(siteIn)} links to it and never rebuilds it.`),
  ];
}

/** "No longer at the source": what stays of a repository GitHub no longer serves. */
export function goneBlock(repo: RepoCoords, layer: ViewLayer | null, siteIn?: string | null, why = "GitHub does not serve it any more."): El {
  const site = siteName(siteIn);
  const items: El[] = [];
  for (const p of layer?.papers ?? []) {
    if (p.slug) items.push(h("li", null, link(`/paper/${p.slug}/#code`, `The code of ${p.title ?? p.doi}`), `: the script copies ${site} keeps (openly licensed files only) and the cited commits.`));
  }
  const archive = swhUrl(layer?.swh ?? null);
  if (archive) items.push(h("li", null, link(archive, "Its archive at Software Heritage"), ", made when its author asked for it."));
  return h(
    "section",
    { class: "setup" },
    h("h2", null, "No longer at the source"),
    h("p", null, `${repo.owner}/${repo.name}: ${why}`),
    layer && layer.maps > 0
      ? h("p", null, `The commits the tracing maps cite stay listed on the papers' pages, marked "no longer at the source".`)
      : null,
    items.length ? h("ul", null, items) : h("p", null, `${capital(site)} kept no copy of its files.`),
  );
}

// ─── GitHub's answers, in words ──────────────────────────────────────────────

/** A README's opening paragraph as plain text: email addresses masked FIRST (so a cut can never
 *  leave part of one), headings, badges, HTML, tables and code blocks skipped, links reduced to
 *  their text, at most `max` characters. Phase 02 renders the whole README. */
export function readmeExcerpt(source: string, max = 480): string {
  const masked = maskEmails(typeof source === "string" ? source : "");
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    if (current.length) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const raw of masked.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) continue;
    if (!line || /^(#{1,6}\s|<|!\[|\[!\[|---|===|\*\*\*|\||>)/.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  const plain = (paragraphs.find((p) => p.length >= 40) ?? paragraphs[0] ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return maskEmails(plain);
  const cut = plain.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${maskEmails(space > max / 2 ? cut.slice(0, space) : cut)}…`;
}

/** The latest commit, in one line: its short id (its page in the registry's viewer), its day, its
 *  message's first line (masked). */
export function latestCommit(repo: RepoCoords, c: T.CommitSummary): El {
  const first = (c.message ?? "").split("\n")[0].trim().slice(0, 200);
  const day = dateOfIso(c.committedAt ?? c.authoredAt);
  return h(
    "p",
    null,
    "Latest commit ",
    h("code", null, link(repoPath(repo, "commit", [c.sha]), c.sha.slice(0, 7))),
    day ? ` on ${day}` : null,
    first ? `: ${first}` : null,
  );
}

/** Why GitHub could not be read, in words. The repository's page at the source only when the
 *  source may still show it (the reader's limit, an outage), as a discreet last resort (the
 *  owner's rule, 2026-09-29). */
export function degradedBlock(repo: RepoCoords, error: GitBackendError): El {
  const web = repoWebUrl(repo);
  let said: string;
  switch (error.code) {
    case "rate_limited": {
      const minutes = error.retryAfter ? Math.max(1, Math.ceil(error.retryAfter / 60)) : null;
      said =
        "GitHub's limit for reading without signing in is reached from your connection (60 requests an hour, shared by the pages you open)" +
        (minutes ? `; it resets in about ${plural(minutes, "minute")}.` : ".");
      break;
    }
    case "not_found":
      said = "GitHub shows no public repository at this address: it may be private, deleted, or renamed long ago.";
      break;
    case "forbidden":
    case "gone":
      said = "GitHub does not show this repository just now.";
      break;
    default:
      said = "GitHub did not answer: it may be down, or this device offline. Try again in a moment.";
  }
  if (error.code === "not_found") return h("p", { class: "warning" }, said);
  return h("div", null, h("p", { class: "warning" }, said), h("p", { class: "at-source" }, "Until then, it can only be read where it is hosted. ", link(web, "At the source"), "."));
}

// ─── reading: GitHub's anonymous API and OSCR's layer ────────────────────────

/** GitHub's addresses for the shell's reads: GitHub's own, or a local mock (development only: an
 *  http address on this machine, set at build time; anything else is ignored). */
export function githubEndpoints(given: { api?: string | null; raw?: string | null; web?: string | null } = {}): { api: string; raw: string; web: string } {
  const local = (v: string | null | undefined, fallback: string) =>
    typeof v === "string" && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[A-Za-z0-9._/-]*)?$/.test(v) ? v.replace(/\/+$/, "") : fallback;
  return {
    api: local(given.api, "https://api.github.com"),
    raw: local(given.raw, "https://raw.githubusercontent.com"),
    web: local(given.web, GITHUB),
  };
}

export interface ShellDeps {
  /** An anonymous session of githubBackend: the reader's own GitHub quota. */
  session: GitSession;
  /** This site's own files and /api/ routes (same origin, the session's cookie). */
  site: (path: string) => Promise<Response>;
  /** The hint cookie says a session exists: the live layer (GET /api/forge/repo). */
  signedIn: boolean;
}

export interface Loaded {
  /** The path the reader opened. */
  target: RepoPath;
  /** The repository as GitHub serves it now (after a rename, its new owner and name). */
  repo: RepoCoords;
  info: T.RepoInfo | null;
  /** Why GitHub could not be read. */
  error: GitBackendError | null;
  empty: boolean;
  latest: T.CommitSummary | null;
  readme: { path: string; excerpt: string } | null;
  layer: ViewLayer | null;
  /** The layer could not be read (neither the API nor the shard). */
  layerUnknown: boolean;
  /** GitHub answered with another owner or name: a rename or a transfer it redirects. */
  renamed: boolean;
  /** The layer named another repository (another id) at this address: it is not shown. */
  otherRepository: boolean;
}

const asError = (e: unknown): GitBackendError =>
  e instanceof GitBackendError ? e : new GitBackendError("unavailable", "GitHub did not answer");

/** OSCR's layer for one repository: live when signed in, else the static shard; null when OSCR
 *  does not know it; "unknown" when neither could be read. */
export async function readLayer(repo: RepoCoords, deps: Pick<ShellDeps, "site" | "signedIn">): Promise<ViewLayer | null | "unknown"> {
  if (deps.signedIn) {
    try {
      const res = await deps.site(`/api/forge/repo?path=${encodeURIComponent(`${repo.owner}/${repo.name}`)}`);
      if (res.status === 404) return null;
      if (res.ok) {
        const body = record(await res.json());
        return parseLayer(body?.layer ?? body?.repo ?? body);
      }
      // Signed out meanwhile, not built yet, or D1's quota: the static shard says what it knows.
    } catch {
      // the same
    }
  }
  try {
    const res = await deps.site(layerUrl(await layerShard(repo.owner, repo.name)));
    if (res.status === 404) return null;
    if (!res.ok) return "unknown";
    const shard = record(await res.json());
    return shard ? parseLayer(shard[`${repo.owner}/${repo.name}`.toLowerCase()]) : null;
  } catch {
    return "unknown";
  }
}

/** Reads what the shell shows: GitHub (1 to 3 anonymous requests on the reader's quota) and OSCR's
 *  layer (1 static file, or 1 Worker request signed in), at the same time. */
export async function loadRepository(target: RepoPath, deps: ShellDeps): Promise<Loaded> {
  const ref: T.RepoRef = { forge: "github", owner: target.owner, name: target.name };
  const layerRead = readLayer(target, deps);
  const out: Loaded = {
    target,
    repo: { owner: target.owner, name: target.name },
    info: null,
    error: null,
    empty: false,
    latest: null,
    readme: null,
    layer: null,
    layerUnknown: false,
    renamed: false,
    otherRepository: false,
  };
  try {
    out.info = await deps.session.repos.get(ref);
  } catch (e) {
    out.error = asError(e);
  }
  let layer = await layerRead;
  if (out.info) {
    const now = { owner: out.info.ref.owner, name: out.info.ref.name };
    if (isOwner(now.owner) && isRepoName(now.name) && `${now.owner}/${now.name}`.toLowerCase() !== `${target.owner}/${target.name}`.toLowerCase()) {
      out.renamed = true;
      out.repo = now;
      if (layer === null) layer = await readLayer(now, deps);
    } else if (isOwner(now.owner) && isRepoName(now.name)) {
      out.repo = now; // GitHub's own case of the names
    }
  }
  if (layer === "unknown") out.layerUnknown = true;
  else if (layer && out.info && layer.id && layer.id !== out.info.key.id) out.otherRepository = true;
  else out.layer = layer;

  const info = out.info;
  if (info && !info.disabled && target.view === "home") {
    const now: T.RepoRef = { forge: "github", ...out.repo };
    if (info.defaultBranch === null) out.empty = true;
    else {
      try {
        const page = await deps.session.git.commits(now, {}, { perPage: 1, cursor: null });
        out.latest = page.items[0] ?? null;
        out.empty = page.items.length === 0;
      } catch {
        // the latest commit is a nicety: the page shows without it
      }
    }
    if (!out.empty) {
      try {
        const readme = await deps.session.repos.readme(now);
        if (readme && !readme.binary && !readme.lfs) {
          out.readme = { path: readme.path, excerpt: readmeExcerpt(new TextDecoder("utf-8").decode(readme.bytes)) };
        }
      } catch {
        // the same
      }
    }
  }
  return out;
}

/** What the shell hands mountSettings and mountBranches (src/lib/forge.ts ShellRepo). */
export function shellRepo(loaded: Loaded, signedIn: boolean): ShellRepo {
  const i = loaded.info;
  return {
    forge: "github",
    owner: loaded.repo.owner,
    name: loaded.repo.name,
    view: loaded.target.view,
    id: i?.key.id ?? loaded.layer?.id ?? null,
    defaultBranch: i?.defaultBranch ?? null,
    empty: loaded.empty,
    archived: i?.archived ?? false,
    isTemplate: i?.isTemplate ?? false,
    description: maskEmails(i?.description ?? ""),
    homepage: i?.homepage && safeHref(i.homepage) ? i.homepage : "",
    topics: i?.topics ?? [],
    permission: i?.permission ?? null,
    web: repoWebUrl(loaded.repo),
    layer: loaded.layer,
    signedIn,
  };
}

/** The path of the shell for what the reader asked; null when it names no repository. */
export const shellTarget = (pathname: string): RepoPath | null => parseRepoPath(pathname);

/** The same view of the repository at its new address, after GitHub's redirect. */
export const renamedPath = (loaded: Loaded): string | null => (loaded.renamed ? viewPath(loaded.repo, loaded.target) : null);
