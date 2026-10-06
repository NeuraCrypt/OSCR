// The figures of the hosting guides (/hosting/…), in words, taken at build time from the forge's
// limits (worker/forge/limits.ts, GITHUB_LIMITS) and the registry's own caps
// (worker/forge/service/caps.ts). No page writes a figure itself: each one comes from here, so a
// limit changed there changes every sentence that states it (tests/forge-pages/limits-text.test.ts).
//
// - Units as GitHub states them. limits.ts writes each value in GitHub's own unit: binary
//   (100 * 2 ** 20, "100 MiB") or decimal (2 * 10 ** 9, "2 GB"). `bytesText` gives the largest
//   unit that divides the value exactly, binary before decimal at the same size, so the value
//   comes back in the unit it was written in; a value one byte short of one ("each file under
//   2 GiB": 2 * 2 ** 30 - 1) reads "under 2 GiB".
// - The figures GITHUB_LIMITS does not hold (tree limits, the push policy, the token rules, Pages)
//   are GITHUB_GUIDE_FIGURES below, each with GitHub's page as its source, read on 2026-09-28
//   (docs/GITHUB_PARITY.md). They belong with GITHUB_LIMITS; they sit here because the adapters
//   and the test double never enforce them.
// - Each figure has its source: GitHub's documentation page (SOURCES), or the registry's own caps.
//
// Build time only (Astro frontmatter); it never names the platform.

import { GITHUB_LIMITS, type BackendLimits } from "../../worker/forge/limits.ts";
import { ACTION_PAYLOAD_BYTES, ASSET_UPLOAD_BYTES, DAY_SECONDS, PER_ACCOUNT_DAY } from "../../worker/forge/service/caps.ts";
import { TOKEN_DAYS } from "./forge.ts";

// ─── Units ───────────────────────────────────────────────────────────────────

export type Unit = "GiB" | "GB" | "MiB" | "MB" | "KiB" | "kB" | "bytes";

/** Largest first; at the same size, the binary unit first (limits.ts writes 2 ** 20 for MiB). */
const UNITS: readonly { unit: Exclude<Unit, "bytes">; size: number }[] = [
  { unit: "GiB", size: 2 ** 30 },
  { unit: "GB", size: 10 ** 9 },
  { unit: "MiB", size: 2 ** 20 },
  { unit: "MB", size: 10 ** 6 },
  { unit: "KiB", size: 2 ** 10 },
  { unit: "kB", size: 10 ** 3 },
];

/** Each unit in words, and its size in bytes: the pages say which kind GitHub uses. */
export const UNIT_WORDS: Readonly<Record<Unit, { word: string; plural: string; bytes: number; binary: boolean }>> = {
  GiB: { word: "gibibyte", plural: "gibibytes", bytes: 2 ** 30, binary: true },
  GB: { word: "gigabyte", plural: "gigabytes", bytes: 10 ** 9, binary: false },
  MiB: { word: "mebibyte", plural: "mebibytes", bytes: 2 ** 20, binary: true },
  MB: { word: "megabyte", plural: "megabytes", bytes: 10 ** 6, binary: false },
  KiB: { word: "kibibyte", plural: "kibibytes", bytes: 2 ** 10, binary: true },
  kB: { word: "kilobyte", plural: "kilobytes", bytes: 10 ** 3, binary: false },
  bytes: { word: "byte", plural: "bytes", bytes: 1, binary: false },
};

/** A count as the site writes it: "100,000". */
export function countText(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`not a count: ${n}`);
  const sign = n < 0 ? "-" : "";
  const [whole, frac] = String(Math.abs(n)).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (frac ? `.${frac}` : "");
}

/** The smallest unit a size one byte short of it is said "under" in: GitHub writes "under 2 GiB"
 *  for a limit of 2 GiB minus one byte; a small count of bytes is said as it is ("1,023 bytes"). */
const UNDER_FROM = 2 ** 20;

/** The value in the unit it was written in, and whether it is one byte short of it. */
export function sizeOf(bytes: number): { value: number; unit: Unit; under: boolean } {
  if (!Number.isInteger(bytes) || bytes < 0) throw new RangeError(`not a size in bytes: ${bytes}`);
  for (const under of [false, true]) {
    const n = under ? bytes + 1 : bytes;
    if (n === 0) break;
    for (const { unit, size } of UNITS) {
      if (under && size < UNDER_FROM) continue;
      if (n % size === 0) return { value: n / size, unit, under };
    }
  }
  return { value: bytes, unit: "bytes", under: false };
}

/** "100 MiB", "2 GB", "under 2 GiB", "1,500 kB". */
export function bytesText(bytes: number): string {
  const { value, unit, under } = sizeOf(bytes);
  return `${under ? "under " : ""}${countText(value)} ${unit}`;
}

/** "100 mebibytes", "2 gigabytes", "under 2 gibibytes". */
export function bytesInWords(bytes: number): string {
  const { value, unit, under } = sizeOf(bytes);
  const w = UNIT_WORDS[unit];
  return `${under ? "under " : ""}${countText(value)} ${value === 1 ? w.word : w.plural}`;
}

/** The unit a value is stated in. */
export const unitOf = (bytes: number): Unit => sizeOf(bytes).unit;

/** One sentence that says what the units of a page mean, for the units it uses, binary first:
 *  "MiB (mebibyte) = 1,048,576 bytes, … ; GB (gigabyte) = 1,000,000,000 bytes." */
export function unitsSentence(sizes: readonly number[]): string {
  const used = [...new Set(sizes.map(unitOf))].filter((u) => u !== "bytes");
  const order = (u: Unit) => (UNIT_WORDS[u].binary ? 0 : 1) * 100 - UNIT_WORDS[u].bytes / 2 ** 30;
  used.sort((a, b) => order(a) - order(b));
  const part = (u: Unit) => `${u} (${UNIT_WORDS[u].word}) = ${countText(UNIT_WORDS[u].bytes)} bytes`;
  const binary = used.filter((u) => UNIT_WORDS[u].binary).map(part);
  const decimal = used.filter((u) => !UNIT_WORDS[u].binary).map(part);
  const bits = [
    binary.length ? `binary units: ${binary.join(", ")}` : "",
    decimal.length ? `decimal units: ${decimal.join(", ")}` : "",
  ].filter(Boolean);
  return `Each limit keeps the unit GitHub states it in; ${bits.join("; ")}.`;
}

// ─── GitHub's documentation, the source of every figure ──────────────────────

const DOCS = "https://docs.github.com/en";
export const SOURCES = {
  largeFiles: `${DOCS}/repositories/working-with-files/managing-large-files/about-large-files-on-github`,
  repositoryLimits: `${DOCS}/repositories/creating-and-managing-repositories/repository-limits`,
  pushLimit: `${DOCS}/get-started/using-git/troubleshooting-the-2-gb-push-limit`,
  pushPolicy: `${DOCS}/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-the-push-policy-for-your-repository`,
  troubleshootingRules: `${DOCS}/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules`,
  availableRules: `${DOCS}/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets`,
  pushRulePathExceptions: "https://github.blog/changelog/2026-08-25-push-rules-in-rulesets-now-support-path-exceptions",
  releases: `${DOCS}/repositories/releasing-projects-on-github/about-releases`,
  lfsBilling: `${DOCS}/billing/concepts/product-billing/git-lfs`,
  budgets: `${DOCS}/billing/concepts/budgets-and-alerts`,
  setUpBudgets: `${DOCS}/billing/how-tos/set-up-budgets`,
  billingCycles: `${DOCS}/billing/concepts/billing-cycles`,
  pagesLimits: `${DOCS}/pages/getting-started-with-github-pages/github-pages-limits`,
  aboutLfs: `${DOCS}/repositories/working-with-files/managing-large-files/about-git-large-file-storage`,
  installingLfs: `${DOCS}/repositories/working-with-files/managing-large-files/installing-git-large-file-storage`,
  configuringLfs: `${DOCS}/repositories/working-with-files/managing-large-files/configuring-git-large-file-storage`,
  lfsCollaboration: `${DOCS}/repositories/working-with-files/managing-large-files/collaboration-with-git-large-file-storage`,
  movingToLfs: `${DOCS}/repositories/working-with-files/managing-large-files/moving-a-file-in-your-repository-to-git-large-file-storage`,
  removingFromLfs: `${DOCS}/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage`,
  lfsUploadFailures: `${DOCS}/repositories/working-with-files/managing-large-files/resolving-git-large-file-storage-upload-failures`,
  lfsArchives: `${DOCS}/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-git-lfs-objects-in-archives-of-your-repository`,
  lfsLocking: "https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md",
  lineEndings: `${DOCS}/get-started/git-basics/configuring-git-to-handle-line-endings`,
  cloning: `${DOCS}/repositories/creating-and-managing-repositories/cloning-a-repository`,
  cloningErrors: `${DOCS}/repositories/creating-and-managing-repositories/troubleshooting-cloning-errors`,
  credentialCache: `${DOCS}/get-started/git-basics/caching-your-github-credentials-in-git`,
  remotes: `${DOCS}/get-started/git-basics/managing-remote-repositories`,
  pushing: `${DOCS}/get-started/using-git/pushing-commits-to-a-remote-repository`,
  upstreamRemote: `${DOCS}/pull-requests/how-tos/work-with-forks/configuring-a-remote-repository-for-a-fork`,
  renaming: `${DOCS}/repositories/creating-and-managing-repositories/renaming-a-repository`,
  defaultBranchName: `${DOCS}/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-the-default-branch-name-for-your-repositories`,
  signingTags: `${DOCS}/authentication/managing-commit-signature-verification/signing-tags`,
  releasesAndTags: `${DOCS}/repositories/releasing-projects-on-github/viewing-your-repositorys-releases-and-tags`,
  movingFiles: `${DOCS}/repositories/working-with-files/managing-files/moving-a-file-to-a-new-location`,
  renamingFiles: `${DOCS}/repositories/working-with-files/managing-files/renaming-a-file`,
  ssh: `${DOCS}/authentication/connecting-to-github-with-ssh`,
  sshChanges: "https://github.blog/changelog/2026-09-22-security-improvements-for-ssh",
  sha1Sunset: "https://github.blog/changelog/2026-04-20-sunsetting-sha-1-in-https-on-github",
  sha1Off: "https://github.blog/changelog/2026-09-15-sha-1-in-https-on-github-sunset",
  pushProtection: `${DOCS}/code-security/how-tos/secure-your-secrets/work-with-leak-prevention/push-protection-on-the-command-line`,
  secretScanningScope: `${DOCS}/code-security/reference/secret-security/secret-scanning-scope`,
  dependabotNotifications: `${DOCS}/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/configure-dependabot-notifications`,
  blockEmailPushes: `${DOCS}/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address`,
  changingCommitMessage: `${DOCS}/pull-requests/how-tos/commit-changes/changing-a-commit-message`,
  sensitiveData: `${DOCS}/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository`,
  personalTokens: `${DOCS}/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens`,
  tokenExpiry: `${DOCS}/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation`,
  aboutAuthentication: `${DOCS}/authentication/keeping-your-account-and-data-secure/about-authentication-to-github`,
  tokenPermissions: `${DOCS}/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens`,
  tokenTemplates: "https://github.blog/changelog/2025-08-26-improved-repository-creation-generally-available-plus-ruleset-insights-improvements/",
  credentialRevocation: "https://github.blog/changelog/2026-08-18-credential-revocation-and-deauthorization-by-token-type",
  artifactMetadata: "https://github.blog/changelog/2026-01-13-new-fine-grained-permission-for-artifact-metadata-is-now-generally-available",
  vulnerabilityAlerts: "https://github.blog/changelog/2026-09-03-github-actions-early-september-2026-updates",
  npmTokens: "https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes",
  npmBypass2fa: "https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens",
  filterRepo: "https://github.com/newren/git-filter-repo",
  duplicating: `${DOCS}/repositories/creating-and-managing-repositories/duplicating-a-repository`,
  restoring: `${DOCS}/repositories/creating-and-managing-repositories/restoring-a-deleted-repository`,
} as const;
export type SourceKey = keyof typeof SOURCES;

/** git's own documentation. */
export const GIT_DOCS = {
  clone: "https://git-scm.com/docs/git-clone",
  push: "https://git-scm.com/docs/git-push",
  remote: "https://git-scm.com/docs/git-remote",
  tag: "https://git-scm.com/docs/git-tag",
  config: "https://git-scm.com/docs/git-config",
  credentialCache: "https://git-scm.com/docs/git-credential-cache",
  partialClone: "https://git-scm.com/docs/partial-clone",
  gitattributes: "https://git-scm.com/docs/gitattributes",
  rebase: "https://git-scm.com/docs/git-rebase",
  mv: "https://git-scm.com/docs/git-mv",
  lfs: "https://git-lfs.com/",
} as const;

/** The data archives the large-files guide sends data to (D00-9). */
export const DATA_HOMES = {
  zenodo: "https://zenodo.org/",
  zenodoGithub: "https://help.zenodo.org/docs/github/",
  huggingFaceDatasets: "https://huggingface.co/docs/hub/datasets",
  huggingFaceStorage: "https://huggingface.co/docs/hub/storage-limits",
} as const;

// ─── The figures GITHUB_LIMITS does not hold ─────────────────────────────────

export interface GuideFigures {
  /** "less than 5 GB is strongly recommended" (repository-limits). */
  repoStronglyBytes: number;
  /** Tree limits (repository-limits): entries in one directory, directory depth, branches. */
  directoryEntries: number;
  directoryDepth: number;
  branchesAdvised: number;
  /** Repositories one account may own (repository-limits). */
  reposPerAccount: number;
  /** Push policy: branch and tag updates one push may make, by default and at least; with
   *  rulesets, a push updating more refs than this is refused (push-policy, troubleshooting-rules). */
  refUpdatesDefault: number;
  refUpdatesMinimum: number;
  refUpdatesRulesets: number;
  /** GitHub Pages: the published site, and the source repository's recommended size (pages-limits). */
  pagesSiteBytes: number;
  pagesRepoBytes: number;
  /** Fine-grained personal access tokens (personal-tokens): the longest custom expiry, and the
   *  most one account may hold; the default expiry is `tokenDefaultDays`. */
  tokenDefaultDays: number;
  tokenMaxDays: number;
  tokenCount: number;
  /** A token's name and its description, in characters (personal-tokens; the name as the
   *  template URL takes it, forge.ts tokenTemplateUrl). */
  tokenNameChars: number;
  tokenDescriptionChars: number;
  /** GitHub revokes a personal access token left unused this many years (token-expiration). */
  tokenUnusedYears: number;
  /** npm's granular write tokens expire within this many days (npm changelog, 2025-11-05). */
  npmWriteTokenDays: number;
  /** New RSA keys for SSH are at least this many bits (SSH changelog, 2026-09-22). */
  sshRsaMinBits: number;
}

export const GITHUB_GUIDE_FIGURES: GuideFigures = {
  repoStronglyBytes: 5 * 10 ** 9,
  directoryEntries: 3_000,
  directoryDepth: 50,
  branchesAdvised: 5_000,
  reposPerAccount: 100_000,
  refUpdatesDefault: 5,
  refUpdatesMinimum: 2,
  refUpdatesRulesets: 1_000,
  pagesSiteBytes: 10 ** 9,
  pagesRepoBytes: 10 ** 9,
  tokenDefaultDays: 30,
  tokenMaxDays: 366,
  tokenCount: 50,
  tokenNameChars: 40,
  tokenDescriptionChars: 1_024,
  tokenUnusedYears: 1,
  npmWriteTokenDays: 90,
  sshRsaMinBits: 3072,
};

/** The registry's own caps (caps.ts): what passes through its Worker, and what one account may do
 *  in 24 hours. */
export interface RegistryCaps {
  actionBytes: number;
  assetBytes: number;
  perAccountDay: { actions: number; creations: number; links: number };
  /** The window of the per-account caps, rolling (caps.ts). */
  windowSeconds: number;
  /** The expiry the registry's pre-filled token link asks GitHub for (forge.ts TOKEN_DAYS). */
  tokenTemplateDays: number;
}

export const REGISTRY_CAPS: RegistryCaps = {
  actionBytes: ACTION_PAYLOAD_BYTES,
  assetBytes: ASSET_UPLOAD_BYTES,
  perAccountDay: { ...PER_ACCOUNT_DAY },
  windowSeconds: DAY_SECONDS,
  tokenTemplateDays: TOKEN_DAYS,
};

// ─── The facts the pages print ───────────────────────────────────────────────

/** Every figure of the guides, as the pages print it. */
export interface HostingFacts {
  file: string;
  fileWarn: string;
  fileInWords: string;
  webUpload: string;
  blobApi: string;
  push: string;
  pushInWords: string;
  repoIdeal: string;
  repoStrongly: string;
  directoryEntries: string;
  directoryDepth: string;
  branchesAdvised: string;
  reposPerAccount: string;
  refUpdatesDefault: string;
  refUpdatesMinimum: string;
  refUpdatesRulesets: string;
  releaseAsset: string;
  releaseAssets: string;
  lfs: boolean;
  lfsFile: string;
  lfsStorage: string;
  lfsBandwidth: string;
  pagesSite: string;
  pagesRepo: string;
  actionBytes: string;
  assetBytes: string;
  perDayActions: string;
  perDayCreations: string;
  perDayLinks: string;
  /** "24 hours": the per-account caps' rolling window. */
  capWindow: string;
  tokenDefaultDays: string;
  tokenTemplateDays: string;
  tokenMaxDays: string;
  tokenCount: string;
  tokenNameChars: string;
  tokenDescriptionChars: string;
  /** "a year", "2 years". */
  tokenUnused: string;
  npmWriteTokenDays: string;
  sshRsaMinBits: string;
  /** The heading of GitHub's page on the push limit, with the limit as GitHub states it. */
  pushLimitTitle: string;
  /** What the units of the limits page mean. */
  units: string;
}

export function hostingFacts(
  limits: BackendLimits = GITHUB_LIMITS,
  figures: GuideFigures = GITHUB_GUIDE_FIGURES,
  caps: RegistryCaps = REGISTRY_CAPS,
): HostingFacts {
  const lfs = limits.lfs;
  const none = "none (no Git LFS)";
  return {
    file: bytesText(limits.fileBytes),
    fileWarn: bytesText(limits.fileWarnBytes),
    fileInWords: bytesInWords(limits.fileBytes),
    webUpload: bytesText(limits.webUploadBytes),
    blobApi: bytesText(limits.blobApiBytes),
    push: bytesText(limits.pushBytes),
    pushInWords: bytesInWords(limits.pushBytes),
    repoIdeal: bytesText(limits.repoRecommendedBytes),
    repoStrongly: bytesText(figures.repoStronglyBytes),
    directoryEntries: countText(figures.directoryEntries),
    directoryDepth: countText(figures.directoryDepth),
    branchesAdvised: countText(figures.branchesAdvised),
    reposPerAccount: countText(figures.reposPerAccount),
    refUpdatesDefault: countText(figures.refUpdatesDefault),
    refUpdatesMinimum: countText(figures.refUpdatesMinimum),
    refUpdatesRulesets: countText(figures.refUpdatesRulesets),
    releaseAsset: bytesText(limits.releaseAssetBytes),
    releaseAssets: countText(limits.releaseAssets),
    lfs: lfs !== null,
    lfsFile: lfs ? bytesText(lfs.fileBytes) : none,
    lfsStorage: lfs ? bytesText(lfs.storageBytes) : none,
    lfsBandwidth: lfs ? bytesText(lfs.bandwidthBytesPerMonth) : none,
    pagesSite: bytesText(figures.pagesSiteBytes),
    pagesRepo: bytesText(figures.pagesRepoBytes),
    actionBytes: bytesText(caps.actionBytes),
    assetBytes: bytesText(caps.assetBytes),
    perDayActions: countText(caps.perAccountDay.actions),
    perDayCreations: countText(caps.perAccountDay.creations),
    perDayLinks: countText(caps.perAccountDay.links),
    capWindow: `${countText(caps.windowSeconds / 3600)} ${caps.windowSeconds === 3600 ? "hour" : "hours"}`,
    tokenDefaultDays: countText(figures.tokenDefaultDays),
    tokenTemplateDays: countText(caps.tokenTemplateDays),
    tokenMaxDays: countText(figures.tokenMaxDays),
    tokenCount: countText(figures.tokenCount),
    tokenNameChars: countText(figures.tokenNameChars),
    tokenDescriptionChars: countText(figures.tokenDescriptionChars),
    tokenUnused: figures.tokenUnusedYears === 1 ? "a year" : `${countText(figures.tokenUnusedYears)} years`,
    npmWriteTokenDays: countText(figures.npmWriteTokenDays),
    sshRsaMinBits: String(figures.sshRsaMinBits),
    pushLimitTitle: `Troubleshooting the ${bytesText(limits.pushBytes)} push limit`,
    units: unitsSentence([
      limits.fileBytes, limits.fileWarnBytes, limits.webUploadBytes, limits.pushBytes, limits.repoRecommendedBytes,
      figures.repoStronglyBytes, limits.releaseAssetBytes + 1, figures.pagesSiteBytes, caps.actionBytes, caps.assetBytes,
      ...(lfs ? [lfs.fileBytes, lfs.storageBytes, lfs.bandwidthBytesPerMonth] : []),
    ]),
  };
}

/** One row of a table of limits: what, the figure, and where it is stated. `source` is GitHub's
 *  page, or null for the registry's own caps. */
export interface LimitRow {
  what: string;
  value: string;
  source: string | null;
}

/** The limits page's tables, by section. */
export function limitTables(
  limits: BackendLimits = GITHUB_LIMITS,
  figures: GuideFigures = GITHUB_GUIDE_FIGURES,
  caps: RegistryCaps = REGISTRY_CAPS,
): { sizes: LimitRow[]; tree: LimitRow[]; pushPolicy: LimitRow[]; registry: LimitRow[]; lfs: LimitRow[]; pages: LimitRow[] } {
  const t = hostingFacts(limits, figures, caps);
  return {
    sizes: [
      { what: "A file in git: GitHub warns above", value: t.fileWarn, source: SOURCES.largeFiles },
      { what: "A file in git: GitHub blocks it above", value: t.file, source: SOURCES.largeFiles },
      { what: "A file added through GitHub's web upload page", value: t.webUpload, source: SOURCES.largeFiles },
      { what: "One push", value: t.push, source: SOURCES.repositoryLimits },
      { what: "A repository, ideally under", value: t.repoIdeal, source: SOURCES.repositoryLimits },
      { what: "A repository, strongly recommended under", value: t.repoStrongly, source: SOURCES.repositoryLimits },
      { what: "A release asset (each file)", value: t.releaseAsset, source: SOURCES.releases },
      { what: "Assets in one release", value: t.releaseAssets, source: SOURCES.releases },
    ],
    tree: [
      { what: "Entries in one directory", value: t.directoryEntries, source: SOURCES.repositoryLimits },
      { what: "Levels of directories", value: t.directoryDepth, source: SOURCES.repositoryLimits },
      { what: "Branches in one repository (advised)", value: t.branchesAdvised, source: SOURCES.repositoryLimits },
      { what: "Repositories one account may own", value: t.reposPerAccount, source: SOURCES.repositoryLimits },
    ],
    pushPolicy: [
      { what: "Branch and tag updates per push, by default when the policy is on", value: t.refUpdatesDefault, source: SOURCES.pushPolicy },
      { what: "Branch and tag updates per push, the lowest setting", value: t.refUpdatesMinimum, source: SOURCES.pushPolicy },
      { what: "Branch and tag updates per push, refused above this when rulesets apply", value: t.refUpdatesRulesets, source: SOURCES.troubleshootingRules },
    ],
    registry: [
      { what: "One web action through the registry (a commit's files, a text)", value: t.actionBytes, source: null },
      { what: "One release asset uploaded through the registry", value: t.assetBytes, source: null },
      { what: `Repositories one account creates through the registry in ${t.capWindow}`, value: t.perDayCreations, source: null },
      { what: `Repositories one account links in ${t.capWindow}`, value: t.perDayLinks, source: null },
      { what: `Actions of every kind one account makes through the registry in ${t.capWindow}`, value: t.perDayActions, source: null },
    ],
    lfs: t.lfs
      ? [
          { what: "One file in Git LFS (GitHub Free)", value: t.lfsFile, source: SOURCES.aboutLfs },
          { what: "LFS storage per account (GitHub Free)", value: t.lfsStorage, source: SOURCES.lfsBilling },
          { what: "LFS downloads per account and month (GitHub Free)", value: t.lfsBandwidth, source: SOURCES.lfsBilling },
        ]
      : [],
    pages: [
      { what: "A published GitHub Pages site", value: t.pagesSite, source: SOURCES.pagesLimits },
      { what: "The source repository of a Pages site (recommended)", value: t.pagesRepo, source: SOURCES.pagesLimits },
    ],
  };
}
