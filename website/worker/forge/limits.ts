// A forge's limits and a session's capabilities: data, not behaviour. The pages show the limits
// (at creation, in the editor); the adapters and the test double enforce the ones OSCR crosses.
//
// OSCR's own caps (1 MiB per authorized action, 25 MiB per release asset through the Worker,
// 100 files per web commit…) are not the backend's: they belong to the forge service of phase 01
// (`forge/service/caps.ts`).
//
// CPU, for those caps (V8 on the Mac, Node 26 and Node 22, 2026-09-29; to confirm in workerd,
// whose V8 follows Chrome's):
// - JSON.parse then JSON.stringify of an action's payload (file contents in base64): 1 MiB
//   0.6 to 2.8 ms, 2 MiB 1.1 to 5.4 ms, 5 MiB 2.7 to 13.5 ms. Many small objects (a webhook's
//   shape) cost more: 3.0 to 3.5 ms a MiB, 15 to 19 ms at 5 MiB. So 1 MiB fits a Worker's 10 ms
//   with room for the rest; 5 MiB does not.
// - base64 of 1 MiB (createCommitOnBranch's contents): 0.13 ms natively, 2.2 ms without
//   (objects.ts).
// - The webhook's HMAC-SHA-256 over 1 MiB: 0.5 ms; its parse, 3.1 to 3.4 ms (github/webhooks.ts).
//
// GitHub's values, as read on 2026-09-28:
// - https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github
// - https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
// - https://docs.github.com/en/billing/concepts/product-billing/git-lfs
// - https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
// - https://docs.github.com/en/rest/git/trees (recursive: 100,000 entries, 7 MB)
// - https://docs.github.com/en/rest/commits/commits (compare: 250 commits; 300 files a page, 3,000 in all)
// - https://docs.github.com/en/rest/checks/runs (50 annotations a request)
// - https://docs.github.com/en/webhooks/webhook-events-and-payloads (25 MB per delivery)

import type { CredentialKind } from "./types.ts";

export interface BackendLimits {
  perPage: number;
  /** The forge refuses larger files in git. */
  fileBytes: number;
  fileWarnBytes: number;
  /** The forge's own web upload page. */
  webUploadBytes: number;
  blobApiBytes: number;
  pushBytes: number;
  repoRecommendedBytes: number;
  /** Recursive listing. */
  treeEntries: number;
  treeBytes: number;
  compareCommits: number;
  diffFilesPerPage: number;
  diffFilesTotal: number;
  pullDiffLines: number;
  pullDiffBytes: number;
  rebaseMergeCommits: number;
  releaseAssetBytes: number;
  releaseAssets: number;
  checkAnnotationsPerRequest: number;
  webhookBytes: number;
  /** Per owner account; null when the forge has no LFS. */
  lfs: { storageBytes: number; bandwidthBytesPerMonth: number; fileBytes: number } | null;
}

export const GITHUB_LIMITS: BackendLimits = {
  perPage: 100,
  /** Blocked above 100 MiB. */
  fileBytes: 100 * 2 ** 20,
  fileWarnBytes: 50 * 2 ** 20,
  webUploadBytes: 25 * 2 ** 20,
  blobApiBytes: 100 * 10 ** 6,
  pushBytes: 2 * 10 ** 9,
  /** "ideally < 1 GB, < 5 GB strongly recommended". */
  repoRecommendedBytes: 10 ** 9,
  treeEntries: 100_000,
  treeBytes: 7 * 10 ** 6,
  compareCommits: 250,
  diffFilesPerPage: 300,
  diffFilesTotal: 3_000,
  pullDiffLines: 20_000,
  pullDiffBytes: 10 ** 6,
  rebaseMergeCommits: 100,
  /** "each file under 2 GiB"; no total or bandwidth limit. */
  releaseAssetBytes: 2 * 2 ** 30 - 1,
  releaseAssets: 1_000,
  checkAnnotationsPerRequest: 50,
  webhookBytes: 25 * 10 ** 6,
  lfs: { storageBytes: 10 * 2 ** 30, bandwidthBytesPerMonth: 10 * 2 ** 30, fileBytes: 2 * 10 ** 9 },
};

/** What `readFile` reads at most unless told otherwise (10 MB), and `diff` (1 MB). */
export const DEFAULT_READ_BYTES = 10 * 10 ** 6;
export const DEFAULT_DIFF_BYTES = 10 ** 6;
/** Characters of an issue, pull-request or comment body (GitHub's limit). */
export const BODY_CHARS = 65_536;
/** Bytes of a commit message. */
export const MESSAGE_BYTES = 64 * 1024;

export type Capability =
  | "read" | "write"
  /** git.rawUrl() gives browser-readable addresses (CORS). */
  | "rawUrls"
  | "createRepository" | "transfer" | "serverImport"
  | "blame" | "searchCode" | "reviewThreads" | "draftToggle" | "autoMerge" | "revertPullRequest"
  | "pinIssue" | "transferIssue" | "subIssues" | "issueDependencies"
  | "multiParentCommits" | "orphanCommits"
  | "checkRuns" | "releaseAssets" | "lfs";

export const CAPABILITIES: readonly Capability[] = [
  "read", "write", "rawUrls", "createRepository", "transfer", "serverImport", "blame", "searchCode",
  "reviewThreads", "draftToggle", "autoMerge", "revertPullRequest", "pinIssue", "transferIssue",
  "subIssues", "issueDependencies", "multiParentCommits", "orphanCommits", "checkRuns",
  "releaseAssets", "lfs",
];

/** GitHub's capabilities per credential kind. A capability present means the feature can be
 *  used as far as the session may: "reading only" features (sub-issues, dependencies and assets
 *  for anonymous and installation sessions; check runs for users) are present, and their writes
 *  are refused by rules.ts (`unauthorized` when anonymous, `forbidden` otherwise).
 *
 *  | capability | anonymous | user | installation |
 *  |---|---|---|---|
 *  | read, rawUrls, lfs (pointers only) | yes | yes | yes |
 *  | write | no | yes | only checks.create and checks.update |
 *  | createRepository, transfer | no | yes | no |
 *  | serverImport | no | no | no |
 *  | blame, searchCode, reviewThreads | no (GraphQL; authenticated code search) | yes | yes (unused) |
 *  | draftToggle, autoMerge, revertPullRequest, pinIssue, transferIssue | no | yes | no |
 *  | subIssues, issueDependencies, releaseAssets | reading only | yes | reading only |
 *  | checkRuns | reading only | reading only (the App's acts) | reading and writing |
 *  | multiParentCommits, orphanCommits | no | yes | no | */
export const GITHUB_CAPABILITIES: Record<CredentialKind, ReadonlySet<Capability>> = {
  anonymous: new Set<Capability>(["read", "rawUrls", "lfs", "subIssues", "issueDependencies", "releaseAssets", "checkRuns"]),
  user: new Set<Capability>([
    "read", "write", "rawUrls", "lfs", "createRepository", "transfer", "blame", "searchCode", "reviewThreads",
    "draftToggle", "autoMerge", "revertPullRequest", "pinIssue", "transferIssue", "subIssues", "issueDependencies",
    "releaseAssets", "checkRuns", "multiParentCommits", "orphanCommits",
  ]),
  installation: new Set<Capability>([
    "read", "write", "rawUrls", "lfs", "blame", "searchCode", "reviewThreads", "subIssues", "issueDependencies",
    "releaseAssets", "checkRuns",
  ]),
};
