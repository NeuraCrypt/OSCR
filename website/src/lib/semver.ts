// Semantic versions (night phase 07, E3; docs/RELEASES.md): the tags of a paper's code read as
// versions (https://semver.org/spec/v2.0.0.html), ordered by their precedence, and the next version
// suggested. Pure functions, no DOM: tested in Node (tests/forge-pages/semver.test.ts).
//
// - A tag reads as a version when it is "MAJOR.MINOR.PATCH", with or without a leading "v", with an
//   optional pre-release ("-rc.1") and build ("+2026.09"); "v1" and "v1.2" (or "1.2") read loosely as
//   1.0.0 and 1.2.0 (many research repositories tag so), and say so (`loose`); a bare number ("2026",
//   "2026-09-28") is none. Anything else is not a version:
//   it is ordered by date, after the versions.
// - Precedence is semver 2.0's §11: numbers compare as numbers; a pre-release is lower than its
//   release; pre-release identifiers compare one by one, numeric ones lower than alphanumeric ones,
//   alphanumeric ones in ASCII order, a longer set higher when all before are equal; build metadata
//   never counts.
// - The next version: a breaking change (a pull request labelled so, or "BREAKING CHANGE" in its
//   title) makes a major one, a new feature a minor one, anything else a patch; under 1.0.0, semver's
//   own rule (anything may change) makes a breaking change a minor one. Each suggestion says why.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers ("rc", 1). */
  pre: (string | number)[];
  build: string[];
  /** "v" when the tag had it. */
  prefix: "v" | "";
  /** Read from "v1" or "v1.2": a version by courtesy. */
  loose: boolean;
}

const NUM = "(0|[1-9]\\d{0,15})";
const IDENT = "[0-9A-Za-z-]+";
const STRICT = new RegExp(`^(v|V)?${NUM}\\.${NUM}\\.${NUM}(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+(${IDENT}(?:\\.${IDENT})*))?$`);
const LOOSE = new RegExp(`^(v|V)?${NUM}(?:\\.${NUM})?(?:-(${IDENT}(?:\\.${IDENT})*))?$`);

/** A pre-release identifier: a number when it is one (without a leading zero), else its text. */
function ident(s: string): string | number {
  return /^(0|[1-9]\d*)$/.test(s) && s.length <= 15 ? Number(s) : s;
}

/** The version a tag names, or null when it names none. */
export function parseSemver(tag: string): SemVer | null {
  if (typeof tag !== "string" || tag.length > 255) return null;
  const s = STRICT.exec(tag);
  if (s) {
    const pre = s[5] ? s[5].split(".") : [];
    // semver: numeric identifiers carry no leading zero.
    if (pre.some((p) => /^0\d+$/.test(p))) return null;
    return { major: Number(s[2]), minor: Number(s[3]), patch: Number(s[4]), pre: pre.map(ident), build: s[6] ? s[6].split(".") : [], prefix: s[1] ? "v" : "", loose: false };
  }
  const l = LOOSE.exec(tag);
  // A bare number is no version ("2026-09-28" is a date): a loose one has its "v" or its minor part.
  if (l && (l[1] || l[3] !== undefined)) {
    const pre = l[4] ? l[4].split(".") : [];
    if (pre.some((p) => /^0\d+$/.test(p))) return null;
    return { major: Number(l[2]), minor: l[3] === undefined ? 0 : Number(l[3]), patch: 0, pre: pre.map(ident), build: [], prefix: l[1] ? "v" : "", loose: true };
  }
  return null;
}

/** The version as a tag writes it (its prefix kept). */
export function formatSemver(v: Pick<SemVer, "major" | "minor" | "patch" | "pre" | "build" | "prefix">): string {
  return `${v.prefix}${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join(".")}` : ""}${v.build.length ? `+${v.build.join(".")}` : ""}`;
}

function comparePre(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1; // a release is higher than its pre-releases
  if (!b.length) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Semver 2.0's precedence: negative when `a` comes before `b`; build metadata never counts. */
export function compareSemver(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre);
}

/** Two tags by their versions; null when either is not one. */
export function compareTags(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  return x && y ? compareSemver(x, y) : null;
}

export type Bump = "major" | "minor" | "patch" | "prerelease";

/** The next version of a kind. A pre-release goes to its own release for major, minor, patch
 *  (semver: 1.2.0-rc.2 is followed by 1.2.0), and counts on for "prerelease" (rc.2 → rc.3; a release
 *  starts the next patch's rc.1). */
export function bump(v: SemVer, kind: Bump): SemVer {
  const base = { ...v, build: [], loose: false };
  if (kind === "prerelease") {
    if (!v.pre.length) return { ...base, patch: v.patch + 1, pre: ["rc", 1] };
    const last = v.pre[v.pre.length - 1];
    return { ...base, pre: typeof last === "number" ? [...v.pre.slice(0, -1), last + 1] : [...v.pre, 1] };
  }
  const released = v.pre.length > 0;
  if (kind === "major") return { ...base, major: released && v.minor === 0 && v.patch === 0 ? v.major : v.major + 1, minor: 0, patch: 0, pre: [] };
  if (kind === "minor") return { ...base, minor: released && v.patch === 0 ? v.minor : v.minor + 1, patch: 0, pre: [] };
  return { ...base, patch: released ? v.patch : v.patch + 1, pre: [] };
}

/** What a merged pull request says of the change it makes, from its labels and its title. */
export function changeKind(pr: { title: string; labels: readonly string[] }): "breaking" | "feature" | "fix" {
  const labels = pr.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => /breaking|semver[-: ]?major|major/.test(l)) || /BREAKING[ -]CHANGE|^[a-z]+(\([^)]*\))?!:/.test(pr.title)) return "breaking";
  if (labels.some((l) => /^(feature|enhancement|feat|new|semver[-: ]?minor|minor)$/.test(l)) || /^feat(\([^)]*\))?:/i.test(pr.title)) return "feature";
  return "fix";
}

export interface Suggestion {
  tag: string;
  kind: Bump;
  why: string;
}

/** The next versions to offer after the latest one, the first the most fitting for what was merged
 *  since. Without a version yet, 0.1.0 and 1.0.0 (a paper's first code is often 1.0.0: the version
 *  the paper describes). */
export function nextVersions(latest: string | null, merged: readonly { title: string; labels: readonly string[] }[] = []): Suggestion[] {
  const v = latest ? parseSemver(latest) : null;
  if (!v) {
    const prefix = latest && /^v/i.test(latest) ? "v" : latest ? "" : "v";
    return [
      { tag: `${prefix}1.0.0`, kind: "major", why: "the first version: the code the paper describes" },
      { tag: `${prefix}0.1.0`, kind: "minor", why: "a first version before the paper's" },
    ];
  }
  const kinds = merged.map(changeKind);
  const breaking = kinds.includes("breaking");
  const feature = kinds.includes("feature");
  const order: Bump[] = [];
  let why: string;
  if (breaking && v.major === 0) {
    order.push("minor", "major", "patch");
    why = "a merged pull request breaks compatibility (under 1.0.0, a minor version says so)";
  } else if (breaking) {
    order.push("major", "minor", "patch");
    why = "a merged pull request breaks compatibility";
  } else if (feature) {
    order.push("minor", "patch", "major");
    why = "a merged pull request adds a feature";
  } else {
    order.push("patch", "minor", "major");
    why = merged.length ? "the merged pull requests fix or tidy" : "nothing was merged since, as far as the page could read";
  }
  const out: Suggestion[] = order.map((kind, i) => ({ tag: formatSemver(bump(v, kind)), kind, why: i === 0 ? why : `a ${kind} version` }));
  out.push({ tag: formatSemver(bump(v, "prerelease")), kind: "prerelease", why: "a pre-release, for a preprint or a manuscript under review" });
  return out;
}

/** Tags in the order a reader expects: versions first, the highest first; then the others, as given
 *  (the caller orders them by date). */
export function sortTags<T>(items: readonly T[], tagOf: (x: T) => string): T[] {
  const versions: { x: T; v: SemVer }[] = [];
  const others: T[] = [];
  for (const x of items) {
    const v = parseSemver(tagOf(x));
    if (v) versions.push({ x, v });
    else others.push(x);
  }
  versions.sort((a, b) => compareSemver(b.v, a.v));
  return [...versions.map((p) => p.x), ...others];
}

/** GitHub's "tag:" qualifier: "v1" matches v1, v1.2 and v1.2.3 (their versions' prefix), a non-version
 *  tag by its text's prefix. */
export function tagMatches(tag: string, wanted: string): boolean {
  const w = wanted.trim();
  if (!w) return true;
  if (tag === w) return true;
  const want = /^(v|V)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(w);
  const v = parseSemver(tag);
  if (want && v) {
    if (Number(want[2]) !== v.major) return false;
    if (want[3] !== undefined && Number(want[3]) !== v.minor) return false;
    if (want[4] !== undefined && Number(want[4]) !== v.patch) return false;
    return true;
  }
  return tag.toLowerCase().startsWith(w.toLowerCase());
}
