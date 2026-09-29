// The About panel of a repository's home (night phase 02, E6): its languages in words, computed from
// the tree the page already read (Linguist's way: bytes per language, vendored, generated and
// documentation files aside, .gitattributes obeyed), its community health files (GitHub's
// precedence: .github/, the root, docs/; the owner's .github repository as the default), and the
// overview's links to them, all in the registry's viewer. Pure, no DOM, testable in Node
// (tests/forge-pages/about.test.ts).

import type * as T from "../../worker/forge/types.ts";
import { type Attributes, attributesOf, parseAttributes } from "./attributes.ts";
import { refSegments } from "./code-nav.ts";
import { repoPath, type RepoCoords } from "./forge.ts";
import { detectLanguage } from "./highlight.ts";
import { type El, h } from "./repo-view.ts";

// ─── languages ───────────────────────────────────────────────────────────────

/** Linguist's data and prose languages: left out of the statistics unless linguist-detectable. */
const NOT_COUNTED = new Set([
  "JSON", "YAML", "TOML", "INI", "CSV", "TSV", "XML", "SVG", "GeoJSON", "TopoJSON", "Markdown", "Text", "reStructuredText",
  "AsciiDoc", "Org", "Diff", "STL", "BibTeX", "Mermaid", "EditorConfig", "Ignore List", "Git Attributes", "Git Config",
]);

export interface LanguageShare {
  language: string;
  bytes: number;
  percent: number;
}

/** Bytes per language over the tree's files, largest first, with their share. */
export function languageStats(entries: readonly Pick<T.TreeEntry, "path" | "type" | "size" | "mode">[], gitattributes = ""): LanguageShare[] {
  const rules = parseAttributes(gitattributes);
  const bytes = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== "blob" || e.mode === "120000" || !e.size) continue;
    const a: Attributes = attributesOf(rules, e.path);
    if (a.vendored || a.generated || a.documentation) continue;
    const language = detectLanguage(e.path, "", a.language);
    if (!language) continue;
    if (a.detectable === false || (NOT_COUNTED.has(language) && a.detectable !== true)) continue;
    bytes.set(language, (bytes.get(language) ?? 0) + e.size);
  }
  const total = [...bytes.values()].reduce((s, n) => s + n, 0);
  return [...bytes]
    .map(([language, n]) => ({ language, bytes: n, percent: total ? (100 * n) / total : 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language));
}

/** "Python 81.2%, R 12.0%, Shell 6.8%": the first six, then "other". */
export function languagesInWords(stats: readonly LanguageShare[]): string {
  if (!stats.length) return "";
  const top = stats.slice(0, 6).map((s) => `${s.language} ${s.percent < 0.1 ? "<0.1" : s.percent.toFixed(1)}%`);
  const rest = stats.slice(6).reduce((n, s) => n + s.percent, 0);
  return [...top, ...(rest >= 0.05 ? [`other ${rest.toFixed(1)}%`] : [])].join(", ");
}

// ─── community health files ──────────────────────────────────────────────────

export type CommunityKind = "code_of_conduct" | "contributing" | "license" | "security" | "support" | "funding" | "governance" | "citation";

const KINDS: { kind: CommunityKind; label: string; re: RegExp; where: ("github" | "root" | "docs")[] }[] = [
  { kind: "code_of_conduct", label: "Code of conduct", re: /^code[-_]of[-_]conduct(?:\.(?:md|markdown|txt|rst))?$/i, where: ["github", "root", "docs"] },
  { kind: "contributing", label: "Contributing", re: /^contributing(?:\.(?:md|markdown|txt|rst))?$/i, where: ["github", "root", "docs"] },
  { kind: "license", label: "Licence", re: /^(?:licen[cs]e|copying)(?:[-._][A-Za-z0-9.-]+)?(?:\.(?:md|markdown|txt|rst))?$/i, where: ["root"] },
  { kind: "security", label: "Security", re: /^security(?:\.(?:md|markdown|txt|rst))?$/i, where: ["github", "root", "docs"] },
  { kind: "support", label: "Support", re: /^support(?:\.(?:md|markdown|txt|rst))?$/i, where: ["github", "root", "docs"] },
  { kind: "funding", label: "Funding", re: /^funding\.ya?ml$/i, where: ["github"] },
  { kind: "governance", label: "Governance", re: /^governance(?:\.(?:md|markdown|txt|rst))?$/i, where: ["github", "root", "docs"] },
  { kind: "citation", label: "Citation", re: /^citation\.cff$/i, where: ["root"] },
];

const DIRS = { github: ".github", root: "", docs: "docs" } as const;

export interface CommunityFile {
  kind: CommunityKind;
  label: string;
  path: string;
  /** From the owner's .github repository (GitHub's default community files). */
  fromOwner: boolean;
}

/** The community health files of a tree, by GitHub's precedence: .github/, the root, docs/. */
export function communityFiles(entries: readonly Pick<T.TreeEntry, "path" | "type">[]): CommunityFile[] {
  const out: CommunityFile[] = [];
  for (const k of KINDS) {
    for (const w of k.where) {
      const dir = DIRS[w];
      const prefix = dir ? `${dir}/` : "";
      const hit = entries
        .filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/") && k.re.test(e.path.slice(prefix.length)))
        .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0];
      if (hit) {
        out.push({ kind: k.kind, label: k.label, path: hit.path, fromOwner: false });
        break;
      }
    }
  }
  return out;
}

/** The files GitHub takes from the owner's .github repository when a repository has none: the
 *  paths to try there (its root), for the kinds missing here. */
export function ownerDefaults(found: readonly CommunityFile[]): { kind: CommunityKind; label: string; path: string }[] {
  const have = new Set(found.map((f) => f.kind));
  const names: Partial<Record<CommunityKind, string>> = { code_of_conduct: "CODE_OF_CONDUCT.md", contributing: "CONTRIBUTING.md", security: "SECURITY.md", support: "SUPPORT.md" };
  return KINDS.filter((k) => names[k.kind] && !have.has(k.kind)).map((k) => ({ kind: k.kind, label: k.label, path: names[k.kind]! }));
}

/** The community checklist's missing files (night phase 03: "Add" opens the registry's editor on the
 *  file, its template offered there): the licence and the citation first, research's own. */
export function missingCommunity(found: readonly CommunityFile[]): { kind: CommunityKind; label: string; filename: string }[] {
  const have = new Set(found.map((f) => f.kind));
  const wanted: { kind: CommunityKind; label: string; filename: string }[] = [
    { kind: "license", label: "a licence", filename: "LICENSE" },
    { kind: "citation", label: "CITATION.cff", filename: "CITATION.cff" },
    { kind: "code_of_conduct", label: "a code of conduct", filename: "CODE_OF_CONDUCT.md" },
    { kind: "contributing", label: "contributing guidelines", filename: "CONTRIBUTING.md" },
    { kind: "security", label: "a security policy", filename: "SECURITY.md" },
  ];
  return wanted.filter((w) => !have.has(w.kind));
}

/** The overview's links (README, code of conduct, contributing, licence, security…), each to the
 *  file in this viewer; a default from the owner's .github repository says so. */
export function overviewLinks(repo: RepoCoords, ref: string, files: readonly CommunityFile[], ownerRef = "HEAD"): El | null {
  const shown = files.filter((f) => f.kind !== "citation" && f.kind !== "funding");
  if (!shown.length) return null;
  const link = (f: CommunityFile) =>
    f.fromOwner
      ? h("a", { href: repoPath({ owner: repo.owner, name: ".github" }, "blob", refSegments(ownerRef, f.path)), title: `The default of every repository of ${repo.owner}` }, `${f.label} (${repo.owner}'s default)`)
      : h("a", { href: repoPath(repo, "blob", refSegments(ref, f.path)) }, f.label);
  return h("ul", { class: "community" }, ...shown.map((f) => h("li", null, link(f))));
}
