// Releases in the reader's browser (night phase 07, E3; docs/RELEASES.md): pure functions, no DOM,
// testable in Node (tests/forge-pages/releases.test.ts). The release pages (src/scripts/
// repo-releases.ts) build on it.
//
// Releases and tags are GitHub's objects (D00-6), read on the reader's own quota and written as the
// person, one authorization each (worker/forge/service/act-releases.ts); the registry's own is the tie
// of a release to a version of a paper, and the tracing map versioned with it (the static layer's
// `releases`, oscr/forgelayer.py).
//
//   addresses        releases/, releases/tag/<tag>, releases/new?…, releases/edit/<tag>,
//                    releases/latest[/download/<file>], releases/download/<tag>/<file>,
//                    releases/changelog, tags/
//   the form         GitHub's query parameters (tag, target, title, body, prerelease) and the
//                    registry's (doi, paper_version), each checked; the text masked
//   the list         the qualifiers draft:, prerelease:, tag: (a version's prefix), created:, latest:,
//                    immutable:, and the registry's paper:, doi:, version:; free words; ordered by
//                    version, then date
//   notes            generated in the browser as GitHub generates them (merged pull requests, grouped
//                    by `.github/release.yml`'s categories, its exclusions, the catch-all), with the
//                    registry's research sections: the tracing-map links whose lines changed, the
//                    research issues fixed; the full changelog's comparison
//   words            a release's states ("Latest", "Pre-release", "Draft", "Immutable": words, never a
//                    pill), a paper's versions, sizes, the source archives and why they are GitHub's
//   the changelog    every published release's notes, in version order, as one Markdown text
//
// Like every browser script, it never names the platform.

import { PAPER_VERSIONS, VERSION_WORDS, type PaperVersion } from "../../worker/forge/service/act-releases.ts";
import { maskEmails } from "../../worker/forge/mask.ts";
import type * as T from "../../worker/forge/types.ts";
import { parseYaml } from "./citation.ts";
import { GITHUB, repoPath, type RepoCoords } from "./forge.ts";
import { dateMatches, parseQuery, type ParsedQuery, type QueryNode } from "./pulls.ts";
import { compareSemver, parseSemver, tagMatches } from "./semver.ts";

export { PAPER_VERSIONS, VERSION_WORDS, type PaperVersion };

// ─── addresses ───────────────────────────────────────────────────────────────

export type ReleaseTarget =
  | { kind: "list" }
  | { kind: "tag"; tag: string }
  | { kind: "new" }
  | { kind: "edit"; tag: string }
  | { kind: "latest" }
  | { kind: "latest-download"; file: string }
  | { kind: "download"; tag: string; file: string }
  | { kind: "changelog" };

/** What the segments after releases/ name (GitHub's shapes; a tag may hold "/"). */
export function parseReleaseTarget(rest: readonly string[]): ReleaseTarget | null {
  if (!rest.length) return { kind: "list" };
  const [first, ...more] = rest;
  if (first === "tag" && more.length) return { kind: "tag", tag: more.join("/") };
  if (first === "edit" && more.length) return { kind: "edit", tag: more.join("/") };
  if (first === "new" && !more.length) return { kind: "new" };
  if (first === "changelog" && !more.length) return { kind: "changelog" };
  if (first === "latest" && !more.length) return { kind: "latest" };
  if (first === "latest" && more.length === 2 && more[0] === "download") return { kind: "latest-download", file: more[1] };
  if (first === "download" && more.length >= 2) return { kind: "download", tag: more.slice(0, -1).join("/"), file: more[more.length - 1] };
  return null;
}

const segs = (tag: string) => tag.split("/");
export const releasesPath = (repo: RepoCoords, q?: string): string => `${repoPath(repo, "releases")}${q ? `?${new URLSearchParams({ q })}` : ""}`;
export const releasePath = (repo: RepoCoords, tag: string): string => repoPath(repo, "releases", ["tag", ...segs(tag)]);
export const editReleasePath = (repo: RepoCoords, tag: string): string => repoPath(repo, "releases", ["edit", ...segs(tag)]);
export const latestReleasePath = (repo: RepoCoords): string => repoPath(repo, "releases", ["latest"]);
export const changelogPath = (repo: RepoCoords): string => repoPath(repo, "releases", ["changelog"]);
export const tagsPath = (repo: RepoCoords): string => repoPath(repo, "tags");
export function newReleasePath(repo: RepoCoords, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `${repoPath(repo, "releases", ["new"])}${q ? `?${q}` : ""}`;
}

/** GitHub's own addresses: the files are GitHub's (the registry never downloads an asset), and so are
 *  the source archives and the feeds. */
const web = (repo: RepoCoords, base = GITHUB) => `${base}/${repo.owner}/${repo.name}`;
const enc = (tag: string) => tag.split("/").map(encodeURIComponent).join("/");
export const assetDownloadUrl = (repo: RepoCoords, tag: string, file: string, base?: string): string => `${web(repo, base)}/releases/download/${enc(tag)}/${encodeURIComponent(file)}`;
export const latestDownloadUrl = (repo: RepoCoords, file: string, base?: string): string => `${web(repo, base)}/releases/latest/download/${encodeURIComponent(file)}`;
export const releaseWebUrl = (repo: RepoCoords, tag: string, base?: string): string => `${web(repo, base)}/releases/tag/${enc(tag)}`;
export const newReleaseWebUrl = (repo: RepoCoords, tag?: string, base?: string): string => `${web(repo, base)}/releases/new${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`;

/** The source archives GitHub builds for a tag, on request. */
export function sourceArchives(repo: RepoCoords, tag: string, base?: string): { zip: string; tarball: string } {
  const root = `${web(repo, base)}/archive/refs/tags/${enc(tag)}`;
  return { zip: `${root}.zip`, tarball: `${root}.tar.gz` };
}

/** Why the registry links the archives and the feeds at the source (the owner's rule: GitHub is the
 *  last resort, and says why). */
export const ARCHIVES_WHY =
  "GitHub builds these archives when they are asked for, from the tag: their contents follow the tag, but their bytes, and so their checksum, may change when GitHub changes its compression. The files attached to the release, and Software Heritage's copy, keep theirs.";
export const FEEDS_WHY =
  "The feeds are GitHub's: the registry writes no file per repository, and a feed read through it would spend its daily requests. A feed reader can follow GitHub's.";
export const feedUrls = (repo: RepoCoords, base?: string): { releases: string; tags: string } => ({ releases: `${web(repo, base)}/releases.atom`, tags: `${web(repo, base)}/tags.atom` });

// ─── the form's query parameters ─────────────────────────────────────────────

export interface ReleasePrefill {
  tag?: string;
  target?: string;
  title?: string;
  body?: string;
  prerelease?: boolean;
  doi?: string;
  paperVersion?: PaperVersion;
}

const TAG_TEXT = /^[^\s~^:?*[\\\u0000-\u001f\u007f]{1,255}$/;

/** GitHub's parameters of releases/new (tag, target, title, body, prerelease=1) and the registry's
 *  (doi, paper_version), each checked; only prefilling: nothing is written without the person. */
export function releasePrefill(search: string): ReleasePrefill {
  const q = new URLSearchParams(search);
  const out: ReleasePrefill = {};
  const tag = q.get("tag");
  if (tag && TAG_TEXT.test(tag) && !tag.includes("..")) out.tag = tag;
  const target = q.get("target");
  if (target && TAG_TEXT.test(target) && !target.includes("..")) out.target = target;
  const title = q.get("title");
  if (title) out.title = maskEmails(title.replace(/[\u0000-\u001f]/g, " ").slice(0, 256));
  const body = q.get("body");
  if (body) out.body = maskEmails(body.slice(0, 20_000));
  if (q.get("prerelease") === "1" || q.get("prerelease") === "true") out.prerelease = true;
  const doi = (q.get("doi") ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "");
  if (/^10\.\d{4,9}\/[^\s"<>@]{1,190}$/.test(doi)) out.doi = doi.toLowerCase();
  const version = q.get("paper_version");
  if ((PAPER_VERSIONS as readonly (string | null)[]).includes(version)) out.paperVersion = version as PaperVersion;
  return out;
}

// ─── the list: order, latest, the query ──────────────────────────────────────

/** A release as the list shows it: GitHub's, and the registry's ties to papers. */
export interface ReleaseTie {
  tag: string;
  paper: { doi: string; slug: string | null; title: string | null };
  version: PaperVersion;
  label: string;
  status: "linked" | "proposed";
  commit: string | null;
  shown: string | null;
  map: { digest: string; pairs: number; commit: string | null; at: number | null } | null;
  deposit: { doi: string; record: string | null } | null;
}

/** The layer's `releases` of a repository, checked (a value that is not what the Mac writes is
 *  dropped). */
export function parseTies(value: unknown): ReleaseTie[] {
  if (!Array.isArray(value)) return [];
  const out: ReleaseTie[] = [];
  const hex = (v: unknown, n?: number[]) => (typeof v === "string" && /^[0-9a-f]+$/.test(v) && (!n || n.includes(v.length)) ? v : null);
  for (const t of value.slice(0, 500)) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const p = r.paper as Record<string, unknown> | undefined;
    if (typeof r.tag !== "string" || !p || typeof p.doi !== "string" || !(PAPER_VERSIONS as readonly unknown[]).includes(r.version)) continue;
    const m = r.map as Record<string, unknown> | null | undefined;
    const d = r.deposit as Record<string, unknown> | null | undefined;
    out.push({
      tag: r.tag,
      paper: { doi: p.doi, slug: typeof p.slug === "string" ? p.slug : null, title: typeof p.title === "string" ? p.title : null },
      version: r.version as PaperVersion,
      label: typeof r.label === "string" ? r.label : "",
      status: r.status === "linked" ? "linked" : "proposed",
      commit: hex(r.commit, [40, 64]),
      shown: hex(r.shown, [64]),
      map: m && typeof m === "object" && hex(m.digest, [64]) ? { digest: m.digest as string, pairs: Number(m.pairs) || 0, commit: hex(m.commit, [40, 64]), at: typeof m.at === "number" ? m.at : null } : null,
      deposit: d && typeof d === "object" && typeof d.doi === "string" && /^10\.\d{4,9}\//.test(d.doi) ? { doi: d.doi, record: typeof d.record === "string" && d.record.startsWith("https://") ? d.record : null } : null,
    });
  }
  return out;
}

/** Releases newest version first (semver 2.0's precedence); tags that are no version after them, the
 *  newest first; drafts before everything (they are the person's work in progress). */
export function sortReleases(items: readonly T.Release[]): T.Release[] {
  const time = (r: T.Release) => r.publishedAt ?? r.createdAt;
  return [...items].sort((a, b) => {
    if (a.draft !== b.draft) return a.draft ? -1 : 1;
    const x = parseSemver(a.tagName);
    const y = parseSemver(b.tagName);
    if (x && y) return compareSemver(y, x) || (time(b) < time(a) ? -1 : time(b) > time(a) ? 1 : 0);
    if (x) return -1;
    if (y) return 1;
    return time(b) < time(a) ? -1 : time(b) > time(a) ? 1 : 0;
  });
}

/** GitHub's rule for the latest release when nobody set one ("legacy"): among the published releases
 *  that are no pre-release, the highest version, then the newest. GitHub's own answer
 *  (releases/latest) is what the pages show; this says why. */
export function legacyLatest(items: readonly T.Release[]): T.Release | null {
  const candidates = items.filter((r) => !r.draft && !r.prerelease);
  return sortReleases(candidates)[0] ?? null;
}

export const RELEASE_QUALIFIERS = ["draft", "prerelease", "tag", "created", "published", "latest", "immutable", "paper", "doi", "version", "is"] as const;

export function parseReleaseQuery(q: string): ParsedQuery {
  return parseQuery(q, RELEASE_QUALIFIERS);
}

export interface ReleaseMatchContext {
  /** GitHub's latest release, by id. */
  latestId?: string | null;
  /** The ties of the registry, by tag. */
  ties?: ReadonlyMap<string, readonly ReleaseTie[]>;
}

const yes = (v: string) => /^(true|yes|1)$/i.test(v);

/** Whether a release matches a query node: words in its title, notes and tag; the qualifiers. */
export function matchRelease(r: T.Release, node: QueryNode, ctx: ReleaseMatchContext = {}): boolean {
  switch (node.op) {
    case "and":
      return node.items.every((x) => matchRelease(r, x, ctx));
    case "or":
      return node.items.some((x) => matchRelease(r, x, ctx));
    case "not":
      return !matchRelease(r, node.item, ctx);
    case "text": {
      const t = node.value.toLowerCase();
      return `${r.name}\n${r.body}\n${r.tagName}`.toLowerCase().includes(t);
    }
    case "term": {
      const v = node.value;
      const ties = ctx.ties?.get(r.tagName) ?? [];
      switch (node.key) {
        case "draft":
          return r.draft === yes(v);
        case "prerelease":
          return r.prerelease === yes(v);
        case "immutable":
          return r.immutable === yes(v);
        case "latest":
          return (ctx.latestId === r.id) === yes(v);
        case "is":
          return v === "draft" ? r.draft : v === "prerelease" ? r.prerelease : v === "latest" ? ctx.latestId === r.id : v === "immutable" ? r.immutable : v === "published" ? !r.draft : false;
        case "tag":
          return tagMatches(r.tagName, v);
        case "created":
          return dateMatches(r.createdAt, v);
        case "published":
          return dateMatches(r.publishedAt, v);
        case "paper":
        case "doi": {
          const want = v.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:/, "");
          return ties.some((t) => t.paper.doi.toLowerCase() === want || (t.paper.slug ?? "") === v);
        }
        case "version":
          return ties.some((t) => t.version === v.toLowerCase());
        default:
          return true;
      }
    }
  }
}

// ─── words ───────────────────────────────────────────────────────────────────

export interface StateWord {
  words: string;
  tone: "ok" | "warning" | "";
}

/** A release's states in words (CLAUDE.md: never a pill). */
export function releaseStates(r: Pick<T.Release, "id" | "draft" | "prerelease" | "immutable">, latestId: string | null): StateWord[] {
  const out: StateWord[] = [];
  if (r.draft) out.push({ words: "Draft", tone: "warning" });
  if (latestId !== null && r.id === latestId) out.push({ words: "Latest", tone: "ok" });
  if (r.prerelease) out.push({ words: "Pre-release", tone: "warning" });
  if (r.immutable) out.push({ words: "Immutable", tone: "ok" });
  return out;
}

/** "the accepted manuscript (revision 2) of doi:…" */
export const tieInWords = (t: Pick<ReleaseTie, "version" | "label">): string => `${VERSION_WORDS[t.version]}${t.label ? ` (${t.label})` : ""}`;

/** A size as people read it. */
export function sizeInWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** An asset's GitHub download count, in words (GitHub counts; the source archives are not counted). */
export const downloadsInWords = (n: number): string => (n === 0 ? "not downloaded yet" : n === 1 ? "downloaded once" : `downloaded ${n} times`);

// ─── generated notes ─────────────────────────────────────────────────────────

/** `.github/release.yml`'s changelog configuration (GitHub's keys). */
export interface ReleaseConfig {
  exclude: { labels: string[]; authors: string[] };
  categories: { title: string; labels: string[]; exclude: { labels: string[]; authors: string[] } }[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 100) : typeof v === "string" && v ? [v] : []);

/** `.github/release.yml` (or `.github/release.yaml`) read as GitHub reads it; null when it holds no
 *  changelog configuration. Problems are said, never thrown. */
export function parseReleaseConfig(text: string): { config: ReleaseConfig | null; problems: string[] } {
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text.slice(0, 64 * 1024));
  } catch {
    return { config: null, problems: ["The file is not YAML the registry can read."] };
  }
  const changelog = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>).changelog : undefined;
  if (!changelog || typeof changelog !== "object" || Array.isArray(changelog)) return { config: null, problems: ["It has no “changelog” section."] };
  const c = changelog as Record<string, unknown>;
  const ex = (v: unknown) => {
    const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    return { labels: strings(o.labels), authors: strings(o.authors) };
  };
  const categories: ReleaseConfig["categories"] = [];
  if (c.categories !== undefined && !Array.isArray(c.categories)) problems.push("“categories” is not a list.");
  for (const [i, raw] of (Array.isArray(c.categories) ? c.categories : []).slice(0, 50).entries()) {
    const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!o || typeof o.title !== "string" || !o.title.trim()) {
      problems.push(`Category ${i + 1} has no title: GitHub skips it.`);
      continue;
    }
    const labels = strings(o.labels);
    if (!labels.length) {
      problems.push(`The category “${o.title}” names no label: GitHub requires one (“*” for the rest).`);
      continue;
    }
    categories.push({ title: o.title.trim(), labels, exclude: ex(o.exclude) });
  }
  return { config: { exclude: ex(c.exclude), categories }, problems };
}

/** A research repository's `.github/release.yml`, offered to commit (the editor's new-file form):
 *  the categories a paper's reader needs first. */
export const RESEARCH_RELEASE_YML = `# How GitHub and the registry group a release's generated notes.
# https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes
changelog:
  exclude:
    labels:
      - ignore-for-release
  categories:
    - title: Changes that affect the results
      labels:
        - numerical difference
        - results
        - breaking-change
    - title: Fixes
      labels:
        - bug
    - title: Data
      labels:
        - data
    - title: Environment
      labels:
        - environment
        - dependencies
    - title: Documentation
      labels:
        - documentation
    - title: Other changes
      labels:
        - "*"
`;

export interface NotesPull {
  number: number;
  title: string;
  author: string | null;
  labels: readonly string[];
  /** The people its commits name as co-authors (their GitHub logins), credited beside its author. */
  coAuthors?: readonly string[];
}

export interface NotesMapLink {
  paper: string;
  paragraph: number;
  section: string;
  path: string;
  start: number;
  end: number;
}

export interface NotesResearch {
  id: number;
  title: string;
  type: string;
}

export interface NotesInput {
  repo: RepoCoords;
  tag: string;
  previousTag: string | null;
  /** The pull requests merged between the previous tag and the target, oldest first. */
  pulls: readonly NotesPull[];
  config: ReleaseConfig | null;
  /** The tracing-map links on lines the range changed (to look at again). */
  mapLinks?: readonly NotesMapLink[];
  /** The research issues fixed in the range. */
  research?: readonly NotesResearch[];
  /** The registry's own address ("https://…"): the notes link its pages (the comparison, the pull
   *  requests), GitHub's when it is not given. */
  site?: string | null;
  /** A person to thank first: "@login" contributors new since the previous tag. */
  newContributors?: readonly { login: string; number: number }[];
}

const RESEARCH_TYPE_WORDS: Readonly<Record<string, string>> = { code_error: "code error", mismatch: "code–paper mismatch", reproduction: "reproduction failure" };

/** Whether a pull request is kept out by an exclusion. */
const excluded = (p: NotesPull, ex: { labels: string[]; authors: string[] }) =>
  p.labels.some((l) => ex.labels.includes(l)) || (p.author !== null && ex.authors.some((a) => a.toLowerCase() === p.author!.toLowerCase()));

/** The notes as GitHub generates them, from the pull requests merged since the previous tag, grouped by
 *  `.github/release.yml`, with the registry's research sections and the full changelog's comparison.
 *  Every text masked for email addresses. */
export function generateNotes(input: NotesInput): string {
  const base = (input.site ?? "").replace(/\/+$/, "");
  const pullUrl = (n: number) => (base ? `${base}${repoPath(input.repo, "pull", [String(n)])}` : `${web(input.repo)}/pull/${n}`);
  const line = (p: NotesPull) => {
    const who = [p.author, ...(p.coAuthors ?? [])].filter((x, i, all): x is string => !!x && all.indexOf(x) === i).map((x) => `@${x}`);
    return `* ${maskEmails(p.title.replace(/\s+/g, " ").trim())}${who.length ? ` by ${who.join(", ")}` : ""} in ${pullUrl(p.number)}`;
  };
  const cfg = input.config;
  const kept = input.pulls.filter((p) => !(cfg && excluded(p, cfg.exclude)));
  const out: string[] = ["## What's Changed"];
  if (cfg && cfg.categories.length) {
    const groups = new Map<string, NotesPull[]>();
    const other: NotesPull[] = [];
    for (const p of kept) {
      const cat = cfg.categories.find((c) => !excluded(p, c.exclude) && (c.labels.includes("*") || p.labels.some((l) => c.labels.includes(l))));
      if (cat) groups.set(cat.title, [...(groups.get(cat.title) ?? []), p]);
      else other.push(p);
    }
    for (const c of cfg.categories) {
      const items = groups.get(c.title);
      if (items?.length) out.push(`### ${maskEmails(c.title)}`, ...items.map(line));
    }
    if (other.length) out.push("### Other Changes", ...other.map(line));
  } else {
    out.push(...kept.map(line));
  }
  if (!kept.length) out.push("No pull request was merged in this range.");
  if (input.newContributors?.length) {
    out.push("", "## New Contributors", ...input.newContributors.map((c) => `* @${c.login} made their first contribution in ${pullUrl(c.number)}`));
  }
  const links = input.mapLinks ?? [];
  const research = input.research ?? [];
  if (links.length || research.length) {
    out.push("", "## For the paper");
    if (links.length) {
      out.push("### Tracing-map links whose lines changed (to look at again)");
      for (const l of links.slice(0, 100)) {
        const lines = l.start === l.end ? `line ${l.start}` : `lines ${l.start}–${l.end}`;
        out.push(`* ${maskEmails(l.paper)}: paragraph ${l.paragraph}${l.section ? ` (${maskEmails(l.section)})` : ""} ↔ \`${l.path}\` ${lines}`);
      }
    }
    if (research.length) {
      out.push("### Research issues fixed");
      for (const r of research.slice(0, 100)) {
        const url = base ? `${base}/research/${r.id}` : `research#${r.id}`;
        out.push(`* ${maskEmails(r.title)} (${RESEARCH_TYPE_WORDS[r.type] ?? r.type}): ${url}`);
      }
    }
  }
  if (input.previousTag) {
    const cmp = base ? `${base}${repoPath(input.repo, "compare", [`${input.previousTag}...${input.tag}`])}` : `${web(input.repo)}/compare/${enc(input.previousTag)}...${enc(input.tag)}`;
    out.push("", `**Full Changelog**: ${cmp}`);
  }
  return out.join("\n");
}

/** The previous release a new one is compared with: the highest version below `tag` among the
 *  published releases that are no pre-release (a pre-release compares with the one before it, a
 *  pre-release included); without versions, the newest published before. */
export function previousTag(tag: string, items: readonly T.Release[]): string | null {
  const published = items.filter((r) => !r.draft && r.tagName !== tag);
  const v = parseSemver(tag);
  if (v) {
    const below = published
      .map((r) => ({ r, v: parseSemver(r.tagName) }))
      .filter((x): x is { r: T.Release; v: NonNullable<ReturnType<typeof parseSemver>> } => x.v !== null && compareSemver(x.v, v) < 0 && (v.pre.length > 0 || !x.r.prerelease));
    below.sort((a, b) => compareSemver(b.v, a.v));
    if (below.length) return below[0].r.tagName;
  }
  const newest = [...published].sort((a, b) => ((b.publishedAt ?? b.createdAt) < (a.publishedAt ?? a.createdAt) ? -1 : 1));
  return newest[0]?.tagName ?? null;
}

/** The merged pull requests of a range: those whose merge commit is one of the range's commits (the
 *  comparison of the previous tag with the target), oldest first. */
export function pullsInRange(pulls: readonly T.PullRequest[], commits: readonly Pick<T.CommitSummary, "sha" | "message">[]): T.PullRequest[] {
  const shas = new Set(commits.map((c) => c.sha));
  return pulls.filter((p) => p.merged && p.mergeCommit && shas.has(p.mergeCommit)).sort((a, b) => ((a.mergedAt ?? "") < (b.mergedAt ?? "") ? -1 : 1));
}

/** The co-authors a commit message names ("Co-authored-by: Name <…>"), by the GitHub login their
 *  address carries when it is GitHub's no-reply one; nobody else (no address is ever shown). */
export function coAuthorLogins(messages: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const x of m.matchAll(/^Co-authored-by:[^<\n]*<(?:\d+\+)?([A-Za-z0-9][A-Za-z0-9-]{0,38})@users\.noreply\.github\.com>/gim)) {
      if (!out.includes(x[1])) out.push(x[1]);
    }
  }
  return out;
}

// ─── the changelog ───────────────────────────────────────────────────────────

/** Every published release's notes, the highest version first, as one Markdown text (the "Keep a
 *  Changelog" shape: a heading per release with its date). */
export function changelogText(repo: RepoCoords, items: readonly T.Release[]): string {
  const published = sortReleases(items.filter((r) => !r.draft));
  const out = [`# Changelog of ${repo.owner}/${repo.name}`, ""];
  for (const r of published) {
    const day = (r.publishedAt ?? r.createdAt).slice(0, 10);
    out.push(`## [${r.tagName}] — ${day}${r.prerelease ? " (pre-release)" : ""}`, "");
    if (r.name && r.name !== r.tagName) out.push(`**${maskEmails(r.name)}**`, "");
    const body = maskEmails(r.body.trim());
    out.push(body || "No notes.", "");
  }
  if (!published.length) out.push("No release is published yet.");
  return out.join("\n").trimEnd() + "\n";
}

// ─── export-ignore ───────────────────────────────────────────────────────────

/** A .gitattributes pattern as a test on a path (gitignore's rules without negation: a pattern with no
 *  "/" matches a name at any depth; "**" any depth; a directory's pattern covers what is under it). */
function attributePattern(pattern: string): (path: string) => boolean {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*") {
      re += ".*";
      i++;
      if (p[i + 1] === "/") i++;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const whole = new RegExp(`^${re}(?:/.*)?$`);
  const name = new RegExp(`(?:^|/)${re}(?:/.*)?$`);
  return (path) => (anchored ? whole.test(path) : name.test(path));
}

/** The paths an archive of the tag leaves out: `.gitattributes`' `export-ignore` (its root file; git
 *  reads deeper ones too: the page says so). `export-subst` placeholders are named, never run. */
export function exportIgnored(gitattributes: string, paths: readonly string[]): { ignored: string[]; substituted: string[] } {
  const rules: { test: (p: string) => boolean; attr: "ignore" | "subst"; on: boolean }[] = [];
  for (const raw of gitattributes.split(/\r?\n/).slice(0, 2_000)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    for (const a of attrs) {
      const m = /^(-|!)?export-(ignore|subst)$/.exec(a);
      if (m) rules.push({ test: attributePattern(pattern), attr: m[2] as "ignore" | "subst", on: !m[1] });
    }
  }
  const ignored: string[] = [];
  const substituted: string[] = [];
  for (const path of paths) {
    let ig = false;
    let sub = false;
    for (const r of rules) {
      if (!r.test(path)) continue;
      if (r.attr === "ignore") ig = r.on;
      else sub = r.on;
    }
    if (ig) ignored.push(path);
    else if (sub) substituted.push(path);
  }
  return { ignored, substituted };
}

// ─── a file checked against its digest ───────────────────────────────────────

/** Whether a file's SHA-256 (computed in the reader's browser, the file never leaving the computer) is
 *  the asset's, as GitHub computed it at upload. */
export function digestVerdict(computed: string, expected: string | null): { same: boolean | null; words: string } {
  if (!expected) return { same: null, words: "GitHub gave no SHA-256 for this file: nothing to compare with." };
  const same = computed.toLowerCase() === expected.toLowerCase();
  return {
    same,
    words: same ? "The same file: its SHA-256 is the one GitHub computed when it was attached." : "Not the same file: its SHA-256 differs from the one GitHub computed when it was attached.",
  };
}
