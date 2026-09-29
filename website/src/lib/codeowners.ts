// CODEOWNERS, read in the reader's browser (night phase 04, E2; D04-*): GitHub's file that names who
// owns which paths of a repository, read from the tree the page already has (GitBackend has no
// method for it: gitbackend.ts, PullOps), parsed here the way GitHub documents it:
// https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
//
// - GitHub looks in .github/, then the root, then docs/, and uses the first CODEOWNERS it finds on
//   the base branch (`CODEOWNERS_PATHS`).
// - One rule per line: a pattern, then owners (@user, @org/team, or an email address); `#` starts a
//   comment, `\#` escapes a pattern that starts with one. A pattern with no owner means "no owner"
//   for what it matches.
// - Patterns follow .gitignore's, with GitHub's own differences: `!` (negation) and `[ ]` (ranges)
//   are not supported, and make the line an error that GitHub skips; `docs/*` matches the files
//   directly in docs/, not deeper; a pattern without a wildcard in its last part matches a file, or
//   a directory and everything in it.
// - The last matching rule wins.
// - A file larger than 3 MB is not read by GitHub at all.
//
// Email addresses are owners GitHub accepts; the registry never shows one (CLAUDE.md): an owner
// given by address is said as "an owner named by an email address (hidden)", never as its text.

/** Where GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
/** GitHub ignores a larger file. */
export const CODEOWNERS_BYTES = 3 * 1024 * 1024;

export type Owner =
  | { kind: "user"; login: string }
  | { kind: "team"; org: string; team: string }
  /** An owner named by an email address: its text is never kept. */
  | { kind: "email" };

export interface OwnerRule {
  /** 1-based line of the file. */
  line: number;
  pattern: string;
  owners: Owner[];
  /** The pattern as a regular expression over repository paths (no leading "/"). */
  re: RegExp;
}

export interface OwnerError {
  line: number;
  message: string;
}

export interface CodeOwners {
  path: string;
  rules: OwnerRule[];
  errors: OwnerError[];
}

const USER = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;
const TEAM = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The first CODEOWNERS of the tree, in GitHub's order, or null. */
export function codeownersPath(paths: Iterable<string>): string | null {
  const have = new Set(paths);
  return CODEOWNERS_PATHS.find((p) => have.has(p)) ?? null;
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|\\]/g, "\\$&");

/** A CODEOWNERS pattern as a regular expression over repository paths, or the reason it is not
 *  one GitHub supports. */
export function patternRe(raw: string): RegExp | string {
  let p = raw.startsWith("\\#") ? raw.slice(1) : raw;
  if (p.startsWith("!")) return "“!” (negation) is not supported in CODEOWNERS.";
  if (/[[\]]/.test(p)) return "“[ ]” (a range of characters) is not supported in CODEOWNERS.";
  if (!p) return "An empty pattern.";
  // Anchored to the root: a leading "/", or a "/" inside the pattern (a trailing one does not count).
  const anchored = p.startsWith("/") || p.replace(/^\/+/, "").replace(/\/+$/, "").includes("/");
  const dir = p.endsWith("/");
  if (dir) p = p.replace(/\/+$/, "");
  p = p.replace(/^\/+/, "");
  // "/" alone: the root, and so everything.
  if (!p) return anchored ? /^.*$/ : "An empty pattern.";
  const parts = p.split("/");
  const last = parts[parts.length - 1];
  const wildLast = /[*?]/.test(last);
  let re = "";
  parts.forEach((part, i) => {
    const end = i === parts.length - 1;
    if (part === "**") {
      // "**/" any leading directories; "/**" everything inside; "/**/" zero or more directories.
      re += end ? ".*" : "(?:[^/]+/)*";
      return;
    }
    re += part.split("").map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : escapeRe(ch))).join("");
    if (!end) re += "/";
  });
  // A directory pattern owns everything inside; a pattern whose last part has no wildcard matches a
  // file, or a directory and its contents; `docs/*` matches only what is directly in docs/.
  const tail = dir ? "/.*" : last === "**" ? "" : wildLast ? "" : "(?:/.*)?";
  const head = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${head}${re}${tail}$`);
}

/** Parses a CODEOWNERS file: its rules in order, and the lines GitHub would skip, with why. */
export function parseCodeowners(text: string, path: string = CODEOWNERS_PATHS[0]): CodeOwners {
  const rules: OwnerRule[] = [];
  const errors: OwnerError[] = [];
  if (new TextEncoder().encode(text).byteLength > CODEOWNERS_BYTES) {
    return { path, rules, errors: [{ line: 0, message: "The file is larger than 3 MB: GitHub does not read it at all." }] };
  }
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    // A comment starts with "#" (a pattern that starts with one is escaped: "\#").
    const content = raw.replace(/(^|\s)#.*$/, "$1").trim();
    if (!content) return;
    const [pattern, ...rest] = content.split(/\s+/);
    const re = patternRe(pattern);
    if (typeof re === "string") {
      errors.push({ line, message: re });
      return;
    }
    const owners: Owner[] = [];
    for (const o of rest) {
      const team = TEAM.exec(o);
      const user = USER.exec(o);
      if (team) owners.push({ kind: "team", org: team[1], team: team[2] });
      else if (user) owners.push({ kind: "user", login: user[1] });
      else if (EMAIL.test(o)) owners.push({ kind: "email" });
      else {
        errors.push({ line, message: "An owner is @user, @organization/team or an email address: this one is none of them, so GitHub skips the line." });
        return;
      }
    }
    rules.push({ line, pattern, owners, re });
  });
  return { path, rules, errors };
}

/** The rule that decides a path (the last that matches), or null. */
export function ruleFor(co: Pick<CodeOwners, "rules">, path: string): OwnerRule | null {
  for (let i = co.rules.length - 1; i >= 0; i--) if (co.rules[i].re.test(path)) return co.rules[i];
  return null;
}

/** A path's owners (none when no rule matches, or the last rule names nobody). */
export function ownersOf(co: Pick<CodeOwners, "rules">, path: string): Owner[] {
  return ruleFor(co, path)?.owners ?? [];
}

export const ownerKey = (o: Owner): string => (o.kind === "user" ? `@${o.login}` : o.kind === "team" ? `@${o.org}/${o.team}` : "email");

/** An owner in words, never an address. */
export const ownerInWords = (o: Owner): string =>
  o.kind === "user" ? o.login : o.kind === "team" ? `the team ${o.org}/${o.team}` : "an owner named by an email address (hidden)";

/** The owners of a change: each owner with the changed paths they own, most paths first. */
export function ownersOfChange(co: Pick<CodeOwners, "rules">, paths: readonly string[]): { owner: Owner; paths: string[] }[] {
  const by = new Map<string, { owner: Owner; paths: string[] }>();
  for (const path of paths) {
    for (const o of ownersOf(co, path)) {
      const k = ownerKey(o).toLowerCase();
      const e = by.get(k) ?? { owner: o, paths: [] };
      e.paths.push(path);
      by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => b.paths.length - a.paths.length || ownerKey(a.owner).localeCompare(ownerKey(b.owner)));
}
