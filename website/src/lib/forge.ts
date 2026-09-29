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

/** The views of the /r/ shell. Phase 01: home, settings, branches. Phase 02 (code navigation,
 *  D02-1) adds GitHub's own shapes after /r/<owner>/<name>/:
 *  - tree/<ref>/<path…>, blob/<ref>/<path…>: a directory, a file (a branch's name may hold "/":
 *    the page resolves the longest branch or tag that prefixes the segments, as GitHub does);
 *  - commits/<ref>/<path…>: the history of a branch, or of a file; commit/<sha>: one commit;
 *  - compare/<base>...<head>: a comparison (three dots; refs may hold "/");
 *  - find/<ref>: the file finder; search: the search in the repository (?q=);
 *  - docs/<ref>/<page…>: the repository's documentation (its Markdown) read as pages (E5: GitHub
 *    Pages adapted, no author HTML or JavaScript).
 *  Phase 03 (editing in the browser, D03-*) adds GitHub's own editing shapes: edit/<branch>/<path…>
 *  (a file), new/<branch>/<dir…> (a new file; ?filename= and ?value= prefill it, as GitHub's),
 *  upload/<branch>/<dir…> (files uploaded into a folder), delete/<branch>/<path…> (a file or a
 *  folder). */
export type RepoView =
  | "home" | "settings" | "branches" | "tree" | "blob" | "commits" | "commit" | "compare" | "find" | "search" | "docs"
  | "edit" | "new" | "upload" | "delete";
export const REPO_VIEWS: readonly RepoView[] = ["home", "settings", "branches"];
/** The views that carry segments after their name (a ref, a path, a commit, a comparison). */
export const CODE_VIEWS: readonly RepoView[] = ["tree", "blob", "commits", "commit", "compare", "find", "search", "docs", "edit", "new", "upload", "delete"];
/** The editing views (phase 03): they act on a branch, and their changes are commits. */
export const EDIT_VIEWS: readonly RepoView[] = ["edit", "new", "upload", "delete"];

export interface RepoCoords {
  owner: string;
  name: string;
}

export interface RepoPath extends RepoCoords {
  view: RepoView;
  /** The segments after a code view's name, decoded: the ref and the path, a commit, a comparison.
   *  Present for the code views only. */
  rest?: string[];
}

/** An account name as GitHub's addresses carry it (paths.ts SEGMENT). */
export const isOwner = (value: unknown): value is string => typeof value === "string" && SEGMENT.test(value);

/** A repository name (paths.ts: SEGMENT, and not ending in ".git"). */
export const isRepoName = (value: unknown): value is string =>
  typeof value === "string" && SEGMENT.test(value) && !/\.git$/i.test(value);

/** One decoded segment of a ref or a path: not empty, not "." or "..", no "/" (an encoded "%2F"
 *  would make a path ambiguous), no control character, at most 255 characters. */
export const isPathSegment = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\/\u0000-\u001f\u007f]/.test(value);

/** How many segments each code view takes: [at least, at most]. */
const SEGMENTS: Partial<Record<RepoView, [number, number]>> = {
  tree: [1, 64],
  blob: [2, 64],
  commits: [0, 64],
  commit: [1, 1],
  compare: [1, 64],
  find: [0, 64],
  search: [0, 0],
  docs: [0, 64],
  edit: [2, 64],
  new: [1, 64],
  upload: [1, 64],
  delete: [2, 64],
};

/** The repository and the view a path of the shell names, or null: /r/<owner>/<name>/ (the final
 *  "/" optional), then nothing, "settings/", "branches/", or a code view and its segments. */
export function parseRepoPath(pathname: string): RepoPath | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/r/") || pathname.length > 4200) return null;
  let parts: string[];
  try {
    parts = pathname.slice(3).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  if (parts.length < 2) return null;
  const [owner, name, view = "home", ...rest] = parts;
  if (!isOwner(owner) || !isRepoName(name)) return null;
  if (parts.length === 2) return { owner, name, view: "home" };
  const bounds = SEGMENTS[view as RepoView];
  if (bounds) {
    if (rest.length < bounds[0] || rest.length > bounds[1] || !rest.every(isPathSegment)) return null;
    return { owner, name, view: view as RepoView, rest };
  }
  if (parts.length > 3 || view === "home" || !(REPO_VIEWS as readonly string[]).includes(view)) return null;
  return { owner, name, view: view as RepoView };
}

/** The shell's path of a repository's view: "/r/ada/eeg/", "/r/ada/eeg/settings/",
 *  "/r/ada/eeg/blob/main/src/a.py" (a code view: its segments, each escaped; no final "/" after a
 *  file, as GitHub writes it). */
export function repoPath(repo: RepoCoords, view: RepoView = "home", rest: readonly string[] = []): string {
  if (!isOwner(repo.owner) || !isRepoName(repo.name)) throw new TypeError("not a repository");
  const base = `/r/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/`;
  if (view === "home") return base;
  if (!SEGMENTS[view]) return `${base}${view}/`;
  const segs = rest.flatMap((s) => s.split("/")).filter((s) => s !== "");
  if (!segs.every(isPathSegment)) throw new TypeError("not a path");
  const tail = segs.map(encodeURIComponent).join("/");
  if (view === "blob" || view === "edit" || view === "delete") return `${base}${view}/${tail}`;
  return tail ? `${base}${view}/${tail}/` : `${base}${view}/`;
}

/** The path of what a RepoPath names (its view and segments). */
export const viewPath = (repo: RepoCoords, target: Pick<RepoPath, "view" | "rest">): string => repoPath(repo, target.view, target.rest ?? []);

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

// ─── drafts of the editor (phase 03) ─────────────────────────────────────────

/** The prefix of the editor's drafts in localStorage (src/lib/editor.ts): the callback page drops
 *  only keys that carry it, once the commit is made. */
export const DRAFT_PREFIX = "oscr-draft:";

/** Whether a key is one of the editor's drafts. */
export const isDraftKey = (key: unknown): key is string => typeof key === "string" && key.startsWith(DRAFT_PREFIX) && key.length <= 5000;

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
