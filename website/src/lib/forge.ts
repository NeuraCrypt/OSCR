// The GitHub side's shared browser library (night phase 01): pure functions, no DOM, testable in
// Node (tests/forge-pages/forge-lib.test.ts). The pages of phase 01 build on it: the /r/ shell
// (E7), its Settings and Branches pages (E8), /new/ (E2), /new/link/ (E3), /repositories/ (E6).
//
// - The URL scheme of the repository pages (D01-5): /r/<owner>/<name>/, /r/<owner>/<name>/settings/,
//   /r/<owner>/<name>/branches/. One static shell serves them all (public/_redirects: "/r/* /r/ 200",
//   no file per repository, C5). Phase 02 may add views under /r/ and keeps these.
// - Git goes straight to github.com with GitHub's own credentials (D00-3): the clone commands, the
//   Code button's links (ZIP, GitHub Desktop, Codespaces) and GitHub's pre-filled fine-grained token
//   page are GitHub's addresses, never one of the registry's. OSCR issues no git token.
// - OSCR's layer for signed-out readers is a static shard, /forge/layer/NN.json: NN = the first
//   byte of SHA-256 of "owner/name" in lower case, mod 64 (`layerShard`; the Mac writes the same:
//   oscr/forgelayer.py, both checked against tests/fixtures/forge-shards.json).
// - One authorized action (D00-4): `apiStart` builds the body of POST /api/forge/start and the
//   payload's exact text, whose SHA-256 the start binds; the callback page posts that same text to
//   /api/forge/act.
//
// Like every browser script, it never names the platform.

import { SEGMENT } from "../../worker/forge/paths.ts";
import type { ActionKind, RepoMode, RepoState, RepoTarget } from "../../worker/forge/service/types.ts";
import type { Permission } from "../../worker/forge/types.ts";

export type { ActionKind, RepoTarget };

/** GitHub's web address: every git and download link goes there. */
export const GITHUB = "https://github.com";

// ─── the URL scheme of the repository pages ──────────────────────────────────

export type RepoView = "home" | "settings" | "branches";
export const REPO_VIEWS: readonly RepoView[] = ["home", "settings", "branches"];

export interface RepoCoords {
  owner: string;
  name: string;
}

export interface RepoPath extends RepoCoords {
  view: RepoView;
}

/** An account name as GitHub's addresses carry it (paths.ts SEGMENT). */
export const isOwner = (value: unknown): value is string => typeof value === "string" && SEGMENT.test(value);

/** A repository name (paths.ts: SEGMENT, and not ending in ".git"). */
export const isRepoName = (value: unknown): value is string =>
  typeof value === "string" && SEGMENT.test(value) && !/\.git$/i.test(value);

/** The repository and the view a path of the shell names, or null: /r/<owner>/<name>/ (the final
 *  "/" optional), then nothing, "settings/" or "branches/". */
export function parseRepoPath(pathname: string): RepoPath | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/r/")) return null;
  let parts: string[];
  try {
    parts = pathname.slice(3).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  if (parts.length < 2 || parts.length > 3) return null;
  const [owner, name, view = "home"] = parts;
  if (!isOwner(owner) || !isRepoName(name)) return null;
  if (view === "home" || !(REPO_VIEWS as readonly string[]).includes(view)) return parts.length === 2 ? { owner, name, view: "home" } : null;
  return { owner, name, view: view as RepoView };
}

/** The shell's path of a repository's view: "/r/ada/eeg/", "/r/ada/eeg/settings/". */
export function repoPath(repo: RepoCoords, view: RepoView = "home"): string {
  if (!isOwner(repo.owner) || !isRepoName(repo.name)) throw new TypeError("not a repository");
  const base = `/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/`;
  return view === "home" ? base : `${base}${view}/`;
}

// ─── GitHub's own addresses: git, downloads, tokens ──────────────────────────

function checked(repo: RepoCoords): RepoCoords {
  if (!repo || !isOwner(repo.owner) || !isRepoName(repo.name)) throw new TypeError("not a repository");
  return repo;
}

/** The repository's page on GitHub. */
export const repoWebUrl = (repo: RepoCoords): string => `${GITHUB}/${checked(repo).owner}/${repo.name}`;

/** git's https address: github.com, never the registry (D00-3). */
export const cloneUrl = (repo: RepoCoords): string => `${repoWebUrl(repo)}.git`;

/** The clone commands the Code button and the quick-setup page show. Owner and name are checked
 *  (letters, digits, ".", "_", "-"), so the commands need no quoting. */
export function cloneCommands(repo: RepoCoords): { https: string; partial: string; shallow: string } {
  const url = cloneUrl(repo);
  return {
    https: `git clone ${url}`,
    /** Every commit, no file contents until checked out (a partial clone). */
    partial: `git clone --filter=blob:none ${url}`,
    /** The last commit only (a shallow clone). */
    shallow: `git clone --depth 1 ${url}`,
  };
}

/** The "Download ZIP" address: a branch's, or the default branch's (HEAD). */
export function zipUrl(repo: RepoCoords, branch?: string | null): string {
  const base = `${repoWebUrl(repo)}/archive`;
  if (!branch) return `${base}/HEAD.zip`;
  return `${base}/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}.zip`;
}

/** "Open with GitHub Desktop": GitHub's own link scheme, which the desktop application answers. */
export const desktopUrl = (repo: RepoCoords): string => `x-github-client://openRepo/${repoWebUrl(repo)}`;

/** "Open in a codespace": GitHub's page, on the researcher's own Codespaces quota. */
export const codespacesUrl = (repo: RepoCoords): string => `https://codespaces.new/${checked(repo).owner}/${repo.name}`;

/** GitHub's page that makes a fine-grained personal access token, pre-filled (GitHub's "token
 *  template URLs"): Contents read and write, the repository's owner as the resource owner, an
 *  expiry, a name from the repository. The person picks the one repository on that page (GitHub
 *  offers no parameter for it: the description says so). The token is made on GitHub and used by
 *  git on github.com: it never passes through the registry. */
export const TOKEN_PAGE = `${GITHUB}/settings/personal-access-tokens/new`;
export const TOKEN_DAYS = 30;

export function tokenTemplateUrl(repo: RepoCoords, days = TOKEN_DAYS): string {
  const { owner, name } = checked(repo);
  const expires = Math.min(366, Math.max(1, Math.floor(days)));
  const params = new URLSearchParams({
    name: `git for ${name}`.slice(0, 40),
    description:
      `git clone, pull and push for ${owner}/${name}. Under "Repository access", choose ` +
      `"Only select repositories" and pick ${owner}/${name}.`,
    target_name: owner,
    expires_in: String(expires),
    contents: "write",
  });
  return `${TOKEN_PAGE}?${params}`;
}

// ─── OSCR's layer ────────────────────────────────────────────────────────────

/** Shards of the static layer: /forge/layer/00.json … /forge/layer/63.json. */
export const LAYER_SHARDS = 64;

const encoder = new TextEncoder();

/** The shard of a repository's entry in OSCR's static layer: the first byte of SHA-256 of
 *  "owner/name" in lower case, mod 64, as two digits ("00" to "63"). */
export async function layerShard(owner: string, name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${owner}/${name}`.toLowerCase())));
  return String(digest[0] % LAYER_SHARDS).padStart(2, "0");
}

/** The address of a shard; its entries are keyed by "owner/name" in lower case. */
export const layerUrl = (shard: string): string => `/forge/layer/${shard}.json`;

/** How OSCR knows a repository: made or linked through it (created, installed, public), or only
 *  through the catalogue's code links (catalogue: read only, nobody linked it). */
export type LayerMode = "catalogue" | RepoMode;

export interface ShellPaper {
  /** "10.1234/abcd". */
  doi: string;
  /** The paper's page, /paper/<slug>/, when it has one. */
  slug: string | null;
  title: string | null;
  /** linked (by a verified author or a maintainer) or proposed; null in the catalogue's layer. */
  status: "linked" | "proposed" | null;
}

/** OSCR's layer over a repository, from the static shard (signed out) or GET /api/forge/repo
 *  (signed in). */
export interface ShellLayer {
  forge: "github";
  /** The forge's durable id. */
  id: string | null;
  mode: LayerMode;
  state: RepoState;
  /** When the forge says the default branch was last pushed (Unix seconds), as OSCR saw it. */
  headAt: number | null;
  /** When OSCR last checked it (the Mac's polling), when known. */
  lastSeen: number | null;
  papers: ShellPaper[];
  /** How many tracing maps (papers) and traced paths point to it. */
  maps: number;
  paths: number | null;
  /** The end of the grace period of a deletion asked for. */
  deleteAfter: number | null;
  /** The reader's roles on the layer: "linked_by", "verified_author", "maintainer" (signed in). */
  roles: string[];
}

/** What the /r/ shell knows of a repository, and hands to mountSettings and mountBranches
 *  (src/scripts/repo-settings.ts, repo-branches.ts). Read in the reader's browser: GitHub's
 *  anonymous answers (on the reader's own quota) and OSCR's layer. */
export interface ShellRepo extends RepoCoords {
  forge: "github";
  view: RepoView;
  /** The forge's durable id, once read. */
  id: string | null;
  /** null for an empty repository. */
  defaultBranch: string | null;
  empty: boolean;
  archived: boolean;
  isTemplate: boolean;
  description: string;
  homepage: string;
  topics: string[];
  /** The reader's own permission, when known (GitHub does not tell an anonymous reader). */
  permission: Permission | null;
  /** The repository's page on GitHub. */
  web: string;
  /** OSCR's layer, or null when OSCR does not know the repository. */
  layer: ShellLayer | null;
  signedIn: boolean;
}

// ─── one authorized action: the start's request ──────────────────────────────

export const START_PATH = "/api/forge/start";
export const ACT_PATH = "/api/forge/act";

export interface StartInput {
  kind: ActionKind;
  repo: RepoTarget | null;
  branch?: string | null;
  expectedHead?: string | null;
  /** The action's payload: kept by the page, posted to /api/forge/act after GitHub. */
  payload: unknown;
  /** The page to come back to: a path of this site. */
  back: string;
  /** Install the App first (the mirror mode's installation page), then authorize. */
  install?: boolean;
}

/** The body of POST /api/forge/start: the declared action, never its payload. */
export interface StartBody {
  kind: ActionKind;
  repo: RepoTarget | null;
  branch: string | null;
  expectedHead: string | null;
  /** SHA-256 (hex) of the payload's exact text. */
  digest: string;
  back: string;
  install?: true;
}

/** The exact text of a payload: what is hashed at start and posted at act. */
export const payloadText = (payload: unknown): string => JSON.stringify(payload ?? {});

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A page of this site to come back to, or "/repositories/": never another site, never /api/. */
export function backPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || !/^\/[A-Za-z0-9._~\-/]*$/.test(value)) return "/repositories/";
  if (value.startsWith("//") || value.startsWith("/api/")) return "/repositories/";
  return value;
}

/** The start's body, and the payload's text the page keeps for act. */
export async function apiStart(input: StartInput): Promise<{ body: StartBody; payload: string }> {
  const payload = payloadText(input.payload);
  const body: StartBody = {
    kind: input.kind,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    expectedHead: input.expectedHead ?? null,
    digest: await sha256Hex(payload),
    back: backPath(input.back),
  };
  if (input.install) body.install = true;
  return { body, payload };
}
