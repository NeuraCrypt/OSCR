// The command palette (night phase 15): Ctrl/Cmd+K opens a box that jumps to a page or runs a
// command. Pure, no DOM, tested in Node (tests/forge-pages/palette.test.ts). The script
// (src/scripts/palette.ts) wires it.
//
// Everything here is STATIC: a fixed list of destinations and commands, built into the page, so the
// palette asks the Worker for nothing (CLAUDE.md: 0 requests for the client features, and no file
// per entity). It never lists issues, people or repositories one by one (that would need a request
// or a file per entity). Instead a prefix turns the query into a search: # for issues and pull
// requests, @ for people and organizations, > (or /) for commands; with no prefix, the matching
// destinations and commands, and a fallback that searches the whole registry.
//
// It never names the platform: a sentence that needs the registry's name takes it from the page.

export type Kind = "go" | "command" | "issues" | "people" | "search";

export interface PaletteEntry {
  /** A stable id, for the option's DOM id and the tests. */
  id: string;
  kind: Kind;
  /** What the option reads. */
  title: string;
  /** A faint word on the right (the kind, a hint). */
  hint?: string;
  /** Go to a path of this site. */
  href?: string;
  /** Run a command the script knows (theme:dark, theme:light, contrast:more, contrast:normal,
   *  help). Never a path. */
  command?: string;
  /** Extra words that match but are not shown. */
  keywords?: string;
}

/** The fixed destinations. Only pages that exist; no file per entity. */
export const DESTINATIONS: readonly PaletteEntry[] = [
  { id: "go-home", kind: "go", title: "Home", href: "/", keywords: "catalogue latest" },
  { id: "go-search", kind: "go", title: "Search", href: "/search/" },
  { id: "go-browse", kind: "go", title: "Browse", href: "/browse/", keywords: "facets topics" },
  { id: "go-lookup", kind: "go", title: "DOI lookup", href: "/lookup/", keywords: "doi find paper" },
  { id: "go-repositories", kind: "go", title: "Repositories", href: "/repositories/", keywords: "code git" },
  { id: "go-explore", kind: "go", title: "Explore", href: "/explore/", keywords: "discover" },
  { id: "go-notifications", kind: "go", title: "Notifications", href: "/notifications/", keywords: "inbox" },
  { id: "go-account", kind: "go", title: "Account", href: "/account/", keywords: "profile sign in" },
  { id: "go-new", kind: "go", title: "New repository", href: "/new/", keywords: "create add host" },
  { id: "go-submit", kind: "go", title: "Submit a paper", href: "/submit/", keywords: "add contribute" },
  { id: "go-preferences", kind: "go", title: "Preferences", href: "/settings/preferences/", keywords: "theme dark settings options" },
  { id: "go-tokens", kind: "go", title: "Personal tokens", href: "/settings/tokens/", keywords: "api key" },
  { id: "go-about", kind: "go", title: "About", href: "/about/" },
  { id: "go-developers", kind: "go", title: "API and developers", href: "/developers/", keywords: "api reference" },
  { id: "go-limits", kind: "go", title: "Limits", href: "/limits/", keywords: "quota" },
  { id: "go-privacy", kind: "go", title: "Privacy", href: "/privacy/" },
  { id: "go-terms", kind: "go", title: "Terms", href: "/terms/" },
];

/** The commands the palette can run without leaving the page. */
export const COMMANDS: readonly PaletteEntry[] = [
  { id: "cmd-theme-dark", kind: "command", title: "Switch to the dark theme", command: "theme:dark", keywords: "night" },
  { id: "cmd-theme-light", kind: "command", title: "Switch to the light theme", command: "theme:light", keywords: "day default" },
  { id: "cmd-contrast-more", kind: "command", title: "Increase the contrast", command: "contrast:more", keywords: "accessibility" },
  { id: "cmd-contrast-normal", kind: "command", title: "Normal contrast", command: "contrast:normal" },
  { id: "cmd-help", kind: "command", title: "Show the keyboard shortcuts", command: "help", keywords: "keys ?" },
];

/** Destinations and commands added by later elements of this phase (so the palette lists them once
 *  those pages exist). They are concatenated by indexEntries. */
export const LATER_DESTINATIONS: PaletteEntry[] = [
  { id: "go-status", kind: "go", title: "Service status", href: "/status/", keywords: "uptime incidents availability" },
  { id: "go-accessibility", kind: "go", title: "Accessibility", href: "/accessibility/", keywords: "a11y conformance screen reader" },
];

/** The whole static index. */
export function indexEntries(): PaletteEntry[] {
  return [...DESTINATIONS, ...LATER_DESTINATIONS, ...COMMANDS];
}

export interface Parsed {
  scope: "all" | "commands" | "issues" | "people";
  prefix: string;
  query: string;
}

/** The raw text split into a scope (a leading # @ > or /) and the rest. */
export function parseQuery(raw: string): Parsed {
  const text = raw.replace(/^\s+/, "");
  const c = text[0];
  if (c === "#") return { scope: "issues", prefix: "#", query: text.slice(1).trim() };
  if (c === "@") return { scope: "people", prefix: "@", query: text.slice(1).trim() };
  if (c === ">" || c === "/") return { scope: "commands", prefix: c, query: text.slice(1).trim() };
  return { scope: "all", prefix: "", query: text.trim() };
}

export interface Match {
  entry: PaletteEntry;
  score: number;
  /** The ranges of the title that matched, for highlighting. */
  ranges: [number, number][];
}

/** A case-insensitive subsequence match of `query` in `text`, with the matched ranges and a score
 *  (smaller is better: a tighter, earlier match wins). null when it does not match. */
export function fuzzy(text: string, query: string): { score: number; ranges: [number, number][] } | null {
  if (!query) return { score: 0, ranges: [] };
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const ranges: [number, number][] = [];
  let ti = 0;
  let gaps = 0;
  let firstAt = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found < 0) return null;
    if (firstAt < 0) firstAt = found;
    if (found > ti && ranges.length) gaps += found - ti;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    ti = found + 1;
  }
  return { score: firstAt + gaps * 2, ranges };
}

export interface ResultGroup {
  kind: Kind;
  title: string;
  matches: Match[];
}

const GROUP_TITLES: Record<Kind, string> = {
  go: "Go to",
  command: "Commands",
  issues: "Issues and pull requests",
  people: "People and organizations",
  search: "Search",
};

const searchHref = (type: string, q: string): string => `/search/?q=${encodeURIComponent(q)}&type=${type}`;

/** The results for a raw query, grouped and ordered. A prefix narrows the scope; a non-empty query
 *  with no prefix also offers to search the whole registry. Every entry is static or a search of
 *  the registry: 0 requests. */
export function search(raw: string, index = indexEntries()): ResultGroup[] {
  const { scope, query } = parseQuery(raw);
  const groups: ResultGroup[] = [];

  if (scope === "issues" || scope === "people") {
    const type = scope === "issues" ? "issues" : "people";
    const kind: Kind = scope;
    const matches: Match[] = query
      ? [{ entry: { id: `search-${type}`, kind, title: `Search ${GROUP_TITLES[kind].toLowerCase()} for "${query}"`, hint: "search", href: searchHref(type, query) }, score: 0, ranges: [] }]
      : [];
    groups.push({ kind, title: GROUP_TITLES[kind], matches });
    return groups;
  }

  const pool = scope === "commands" ? index.filter((e) => e.kind === "command") : index;
  const byKind = new Map<Kind, Match[]>();
  for (const entry of pool) {
    const m = fuzzy(`${entry.title} ${entry.keywords ?? ""}`.trim(), query);
    if (!m) continue;
    // The ranges are computed against the title alone (keywords are not shown).
    const titleMatch = fuzzy(entry.title, query);
    const match: Match = { entry, score: m.score, ranges: titleMatch?.ranges ?? [] };
    const list = byKind.get(entry.kind) ?? [];
    list.push(match);
    byKind.set(entry.kind, list);
  }
  const order: Kind[] = scope === "commands" ? ["command"] : ["go", "command"];
  for (const kind of order) {
    const list = (byKind.get(kind) ?? []).sort((a, b) => a.score - b.score || a.entry.title.localeCompare(b.entry.title));
    if (list.length) groups.push({ kind, title: GROUP_TITLES[kind], matches: list });
  }

  if (scope === "all" && query) {
    groups.push({
      kind: "search",
      title: GROUP_TITLES.search,
      matches: [{ entry: { id: "search-all", kind: "search", title: `Search the registry for "${query}"`, hint: "search", href: searchHref("papers", query) }, score: 0, ranges: [] }],
    });
  }
  return groups;
}

/** The flat ordered list of entries a results view would show (for the keyboard navigation). */
export function flatten(groups: ResultGroup[]): PaletteEntry[] {
  return groups.flatMap((g) => g.matches.map((m) => m.entry));
}
