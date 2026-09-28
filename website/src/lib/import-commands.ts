// Imports run on the researcher's machine (D00-8): the commands the import page and the guides
// show, built in the browser (or at build time for the guides' examples) by pure functions, tested
// in Node (tests/forge-pages/import-commands.test.ts). Nothing here makes a request: no import runs
// in the Worker or on the Mac, and GitHub's own importer is only a link.
//
// - Every value that reaches a command is validated first, then single-quoted (`shq`): a source is
//   an https or ssh git address whose characters are letters, digits and ". _ ~ - /" only (no user
//   and password in an https address, no query, no space, no shell metacharacter); a name is
//   GitHub's (paths.ts SEGMENT); a branch has no leading "-". A value that fails is refused (null or
//   a TypeError), never cleaned into something else.
// - The mirror keeps every commit id (git clone --mirror, git push --mirror), so the tracing maps
//   pinned to the source's commits stay valid on the copy. The source host's hidden refs
//   (GitHub's refs/pull/*, GitLab's refs/merge-requests/*, Bitbucket's refs/pull-requests/*…), which
//   GitHub refuses on push, are left out with explicit refspecs, and deleted from the local mirror
//   before the push.
// - Git LFS objects move only when asked (git lfs fetch --all, then git lfs push --all).
// - The commands never hold a credential: git asks GitHub for the person's own (a credential helper,
//   SSH, or a token typed when git asks), and the registry never sees it (D00-3).
// - A Zenodo, figshare or OSF record becomes ONE commit whose message cites the record's DOI: an
//   archive has no history.
// - "Import from the paper": the lookup shard of the paper's DOI (/lookup/NNN.json, the SHA-1 rule
//   of oscr/entities.py) gives its page and its code links (`code`, the https addresses of the
//   paper's code, added to each entry by scripts/data.mjs); `prefillFromPaper` turns them into
//   sources and the paper to link.
//
// Like every browser script, it never names the platform.

import { forgeLinks } from "../../worker/forge/github/links.ts";
import { SEGMENT, isRefName } from "../../worker/forge/paths.ts";
import { cloneUrl, GITHUB, isOwner, isRepoName, layerShard, layerUrl, type RepoCoords } from "./forge.ts";

export type { RepoCoords };

// ─── shell quoting ───────────────────────────────────────────────────────────

/** A value as ONE word of a POSIX shell: single quotes, a quote inside written '\''. Nothing between
 *  single quotes is interpreted ($, `, \, ;, |, &, spaces, globs). */
export function shq(value: string): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("not a value for a command");
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The text of a list of command lines (comments start with "#"). */
export const commandText = (lines: readonly string[]): string => lines.join("\n");

// ─── git addresses ───────────────────────────────────────────────────────────

/** A host name: dotted labels of letters, digits and inner hyphens (no "localhost", no user part). */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A path segment of a git address. */
const PART = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,100}$/;
/** An ssh user: starts with a letter or digit, so it can never read as an option. */
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GitSource {
  /** The address as the commands use it: "https://gitlab.com/lab/eeg.git", "git@codeberg.org:lab/eeg.git". */
  url: string;
  scheme: "https" | "ssh";
  host: string;
  /** "lab/eeg" (GitLab's subgroups kept: "lab/group/eeg"), without ".git". */
  path: string;
  /** A name for the new repository: the last segment, as GitHub accepts it. */
  name: string;
  /** "gitlab.com/lab/eeg", for sentences. */
  label: string;
  /** The repository on GitHub, when the source is one (link it rather than import it). */
  github: RepoCoords | null;
}

const githubLinks = forgeLinks({ forge: "github", web: GITHUB });

/** GitHub's own importer page (links.importer()): a web import, which does not move LFS objects. */
export const IMPORTER_URL = githubLinks.importer();

function pathParts(path: string): string[] | null {
  const parts = path.split("/");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  if (!parts.length || parts.length > 10) return null;
  // A web address of GitLab or Forgejo: "/lab/eeg/-/tree/main" is the repository "lab/eeg".
  const dash = parts.indexOf("-");
  const repo = dash > 0 ? parts.slice(0, dash) : parts;
  if (!repo.every((p) => PART.test(p))) return null;
  return repo;
}

function source(scheme: "https" | "ssh", host: string, parts: string[], url: (path: string) => string): GitSource | null {
  host = host.toLowerCase();
  if (!HOST.test(host)) return null;
  let repoParts = parts;
  if (host === "github.com" || host === "www.github.com") {
    host = "github.com";
    // github.com/<owner>/<name>, and its web addresses (/tree/…, /blob/…) reduced to the repository.
    if (parts.length < 2) return null;
    repoParts = parts.slice(0, 2);
  } else if (host === "bitbucket.org" && parts.length > 2 && ["src", "branch", "commits"].includes(parts[2])) {
    repoParts = parts.slice(0, 2);
  }
  const last = repoParts[repoParts.length - 1].replace(/\.git$/i, "");
  if (!last || !PART.test(last)) return null;
  const path = [...repoParts.slice(0, -1), last].join("/");
  const name = last.replace(/~/g, "-");
  if (!isRepoName(name)) return null;
  let github: RepoCoords | null = null;
  if (host === "github.com") {
    const [owner, repoName] = [repoParts[0], last];
    if (!isOwner(owner) || !isRepoName(repoName) || !SEGMENT.test(owner)) return null;
    github = { owner, name: repoName };
  }
  return { url: url(`${path}.git`), scheme, host, path, name, label: `${host}/${path}`, github };
}

/** An https or ssh git address, or null. Accepted:
 *  - https://host[:port]/path[.git] (a repository's web address on GitHub, GitLab, Bitbucket or
 *    Codeberg is reduced to the repository);
 *  - user@host:path[.git] (scp-like ssh) and ssh://user@host[:port]/path[.git].
 *  Refused: http, git://, file://, local paths, a user or password in an https address, a query,
 *  a fragment, "%", a space, any shell metacharacter, a ".." segment. */
export function parseGitUrl(text: unknown): GitSource | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > 400) return null;
  let m = /^https:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9._~/-]+)$/.exec(value);
  if (m) {
    const [, host, port, rest] = m;
    const parts = pathParts(rest);
    if (!parts || (port && (Number(port) < 1 || Number(port) > 65535))) return null;
    // github.com: a repository's address or one of its web pages (tree, blob…), never a page of
    // GitHub itself (/settings/…, /orgs/…): links.parse's rules.
    if (/^(?:www\.)?github\.com$/i.test(host) && (port || !githubLinks.parse(`${GITHUB}/${rest}`))) return null;
    const hostPort = port ? `${host.toLowerCase()}:${Number(port)}` : host.toLowerCase();
    return source("https", host, parts, (p) => `https://${hostPort === "www.github.com" ? "github.com" : hostPort}/${p}`);
  }
  m = /^ssh:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/([A-Za-z0-9._~/-]+)$/.exec(value);
  if (m) {
    const [, user, host, port, rest] = m;
    const parts = pathParts(rest);
    if (!USER.test(user) || !parts || (port && (Number(port) < 1 || Number(port) > 65535))) return null;
    const at = `${user}@${host.toLowerCase()}${port ? `:${Number(port)}` : ""}`;
    return source("ssh", host, parts, (p) => `ssh://${at}/${p}`);
  }
  m = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~][A-Za-z0-9._~/-]*)$/.exec(value);
  if (m) {
    const [, user, host, rest] = m;
    const parts = pathParts(rest);
    if (!USER.test(user) || !parts) return null;
    return source("ssh", host, parts, (p) => `${user}@${host.toLowerCase()}:${p}`);
  }
  return null;
}

/** The new repository on GitHub, checked: git's https address. */
export function destinationUrl(dest: RepoCoords): string {
  if (!dest || !isOwner(dest.owner) || !isRepoName(dest.name)) throw new TypeError("not a repository");
  return cloneUrl(dest);
}

/** A branch name for a command: git's rules (paths.ts), and letters, digits, ". _ - /" only, never
 *  a leading "-". */
export const isBranch = (value: unknown): value is string =>
  isRefName(value) && /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value);

/** A folder of a repository: relative, "/"-separated, letters, digits, ". _ - " and spaces, no "."
 *  or ".." component, no leading "-". */
export function isFolder(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 300) return false;
  const parts = value.replace(/\/+$/, "").split("/");
  return parts.every((p) => /^[A-Za-z0-9_.][A-Za-z0-9 ._-]*$/.test(p) && p !== "." && p !== ".." && !p.endsWith(" "));
}

// ─── the mirror: every commit id kept ────────────────────────────────────────

/** The source hosts' hidden refs, which GitHub refuses on push: GitHub's and Forgejo's pull
 *  requests, Bitbucket's, GitLab's merge requests and its internal refs. */
export const HIDDEN_REFS = ["refs/pull", "refs/pull-requests", "refs/merge-requests", "refs/pipelines", "refs/keep-around", "refs/environments"];

/** The explicit refspecs a mirror fetches: branches and tags, nothing else. */
export const MIRROR_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];

export interface MirrorOptions {
  /** The source uses Git LFS: fetch every LFS object, push them after the mirror. */
  lfs?: boolean;
}

/** The folder a mirror is cloned into: "<name>.git". */
export const mirrorFolder = (dest: RepoCoords): string => `${dest.name}.git`;

/** Duplicate a repository into an EMPTY repository on GitHub, every commit id kept:
 *  git clone --mirror, the explicit refspecs, the hidden refs deleted, git push --mirror; with LFS
 *  when asked. */
export function mirrorCommands(src: GitSource, dest: RepoCoords, options: MirrorOptions = {}): string[] {
  if (!src || !parseGitUrl(src.url)) throw new TypeError("not a git address");
  const to = shq(destinationUrl(dest));
  const folder = shq(mirrorFolder(dest));
  const lines = [
    `git clone --mirror ${shq(src.url)} ${folder}`,
    `cd ${folder}`,
    "# Branches and tags only: the source's hidden refs (pull and merge requests) stay behind.",
    `git config --replace-all remote.origin.fetch ${shq(MIRROR_REFSPECS[0])}`,
    `git config --add remote.origin.fetch ${shq(MIRROR_REFSPECS[1])}`,
    `git for-each-ref --format=${shq("delete %(refname)")} ${HIDDEN_REFS.join(" ")} | git update-ref --stdin`,
  ];
  if (options.lfs) lines.push("git lfs fetch --all origin");
  lines.push(`git push --mirror ${to}`);
  if (options.lfs) lines.push(`git lfs push --all ${to}`);
  return lines;
}

/** An ongoing mirror kept by the person: the same folder, fetched and pushed again when they choose
 *  (by hand, or from their own scheduler). */
export function ongoingMirrorCommands(dest: RepoCoords, options: MirrorOptions = {}): string[] {
  const to = shq(destinationUrl(dest));
  const lines = [`cd ${shq(mirrorFolder(dest))}`, `git remote set-url --push origin ${to}`, "git fetch --prune origin"];
  if (options.lfs) lines.push("git lfs fetch --all origin");
  lines.push("git push --mirror");
  if (options.lfs) lines.push(`git lfs push --all ${to}`);
  return lines;
}

// ─── other version control systems: their converters ─────────────────────────

export type ConvertKind = "svn" | "git-svn" | "hg" | "tfvc" | "perforce";
export const CONVERT_KINDS: readonly ConvertKind[] = ["svn", "git-svn", "hg", "tfvc", "perforce"];

export interface ConvertInput {
  kind: ConvertKind;
  /** svn: https://, svn:// or svn+ssh://user@; hg: https:// or ssh://user@; tfvc: the collection's
   *  https address; perforce: the depot path, "//depot/project". */
  source: string;
  dest: RepoCoords;
  /** TFVC: the path in the collection, "$/Project/Main". */
  tfvcPath?: string;
  /** Perforce: the server, "ssl:perforce.example.org:1666" or "perforce.example.org:1666". */
  p4port?: string;
  /** Map the old system's users to names and commit addresses (a file the person writes). */
  authors?: boolean;
  /** Move the files over 50 MB into Git LFS before the first push (the converted history is new:
   *  rewriting it costs nothing). */
  lfs?: boolean;
}

const URLISH = /^([a-z+]+):\/\/(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[A-Za-z0-9._~/-]*)?$/;

/** A source address of a converter, or null: only the schemes of that system, the same characters
 *  as a git address, a user only with ssh. */
export function checkConvertSource(kind: ConvertKind, text: unknown): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > 400) return null;
  if (kind === "perforce") {
    // "//depot/project" or "//depot/project/...": every segment starts with a letter, a digit or "_".
    const depot = value.replace(/\/\.\.\.$/, "");
    return /^\/\/[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/.test(depot) ? depot : null;
  }
  const m = URLISH.exec(value);
  if (!m) return null;
  const [, scheme, user, host, port, path = ""] = m;
  const schemes: Record<ConvertKind, string[]> = {
    svn: ["https", "svn", "svn+ssh"],
    "git-svn": ["https", "svn", "svn+ssh"],
    hg: ["https", "ssh"],
    tfvc: ["https"],
    perforce: [],
  };
  if (!schemes[kind].includes(scheme) || !HOST.test(host.toLowerCase())) return null;
  if (user && !(scheme === "ssh" || scheme === "svn+ssh")) return null;
  if (user && !USER.test(user)) return null;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (path.split("/").some((p) => p === "." || p === "..")) return null;
  return value;
}

/** TFVC's path in a collection: "$/Project/Main". */
export const isTfvcPath = (value: unknown): value is string =>
  typeof value === "string" && /^\$\/[A-Za-z0-9_][A-Za-z0-9 ._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9 ._-]*)*$/.test(value) &&
  !value.split("/").some((p) => p === ".." || p.endsWith(" "));

/** Perforce's server address: "[ssl:]host:port". */
export const isP4Port = (value: unknown): value is string =>
  typeof value === "string" && /^(?:ssl:|tcp:)?([a-z0-9.-]+):(\d{1,5})$/i.test(value) &&
  HOST.test(value.replace(/^(?:ssl:|tcp:)/i, "").split(":")[0].toLowerCase());

const LFS_MIGRATE = "git lfs migrate import --everything --above=50MB";

/** Push a converted history (new commits: nothing on GitHub to keep). */
function pushAll(to: string, lfs: boolean | undefined): string[] {
  return [...(lfs ? [LFS_MIGRATE] : []), `git remote add origin ${to}`, "git push -u origin --all", "git push origin --tags"];
}

/** The commands of a converter, per source kind: Subversion (svn2git, or git svn), Mercurial
 *  (hg-fast-export), TFVC (git-tfs), Perforce (git p4). A converted history gets new commit ids. */
export function convertCommands(input: ConvertInput): string[] {
  const src = checkConvertSource(input.kind, input.source);
  if (!src) throw new TypeError("not a source address for this converter");
  const to = shq(destinationUrl(input.dest));
  const name = shq(input.dest.name);
  const authors = input.authors;
  switch (input.kind) {
    case "svn":
      return [
        `mkdir ${name}`,
        `cd ${name}`,
        `svn2git ${shq(src)}${authors ? " --authors ../authors.txt" : ""}`,
        ...pushAll(to, input.lfs),
      ];
    case "git-svn":
      return [
        `git svn clone --stdlayout --prefix=svn/${authors ? " --authors-file=authors.txt" : ""} ${shq(src)} ${name}`,
        `cd ${name}`,
        "# If the clone stops (a long history, the network), run this until it ends:",
        "git svn fetch",
        "git branch -M main",
        ...(input.lfs ? [LFS_MIGRATE] : []),
        `git remote add origin ${to}`,
        "git push -u origin main",
      ];
    case "hg": {
      const hgFolder = shq(`${input.dest.name}-hg`);
      return [
        `hg clone ${shq(src)} ${hgFolder}`,
        `git init ${name}`,
        `cd ${name}`,
        "git config core.ignoreCase false",
        `hg-fast-export.sh -r ${shq(`../${input.dest.name}-hg`)}${authors ? " -A ../authors.txt" : ""} -M main`,
        "git checkout main",
        ...pushAll(to, input.lfs),
      ];
    }
    case "tfvc": {
      if (!isTfvcPath(input.tfvcPath)) throw new TypeError("not a TFVC path");
      return [
        `git tfs clone ${shq(src)} ${shq(input.tfvcPath)} ${name} --branches=all${authors ? " --authors=authors.txt" : ""}`,
        `cd ${name}`,
        ...pushAll(to, input.lfs),
      ];
    }
    case "perforce": {
      if (!isP4Port(input.p4port)) throw new TypeError("not a Perforce server address");
      return [
        "# Sign in to Perforce first (p4 login): git p4 uses that session.",
        `P4PORT=${shq(input.p4port)} git p4 clone ${shq(`${src}@all`)} ${name}`,
        `cd ${name}`,
        "git branch -M main",
        ...(input.lfs ? [LFS_MIGRATE] : []),
        `git remote add origin ${to}`,
        "git push -u origin main",
      ];
    }
  }
}

// ─── a subfolder into a new repository, and subtree merges ───────────────────

/** Split a subfolder of a repository into a new repository: its history kept for that folder, with
 *  new commit ids (maps pinned to the old commits stay on the old repository). */
export function splitCommands(src: GitSource, folder: string, dest: RepoCoords): string[] {
  if (!src || !parseGitUrl(src.url)) throw new TypeError("not a git address");
  if (!isFolder(folder)) throw new TypeError("not a folder");
  const name = shq(dest.name);
  return [
    `git clone ${shq(src.url)} ${name}`,
    `cd ${name}`,
    `git filter-repo --subdirectory-filter ${shq(folder.replace(/\/+$/, ""))}`,
    `git remote add origin ${shq(destinationUrl(dest))}`,
    "git push -u origin --all",
    "git push origin --tags",
  ];
}

/** Bring another repository into a folder of the current one, its history kept (a subtree merge),
 *  run inside the receiving repository; then the source's new commits, later. */
export function subtreeCommands(src: GitSource, folder: string, branch = "main"): string[] {
  if (!src || !parseGitUrl(src.url)) throw new TypeError("not a git address");
  if (!isFolder(folder)) throw new TypeError("not a folder");
  if (!isBranch(branch)) throw new TypeError("not a branch name");
  const remote = shq(src.name);
  const ref = shq(`${src.name}/${branch}`);
  const prefix = shq(`${folder.replace(/\/+$/, "")}/`);
  return [
    `git remote add ${remote} ${shq(src.url)}`,
    `git fetch ${remote}`,
    `git merge -s ours --no-commit --allow-unrelated-histories ${ref}`,
    `git read-tree --prefix=${prefix} -u ${ref}`,
    `git commit -m ${shq(`Subtree merge of ${src.label} into ${folder.replace(/\/+$/, "")}/`)}`,
    "# Later, to bring in the source's new commits:",
    `git pull -s subtree ${remote} ${shq(branch)}`,
  ];
}

// ─── a Zenodo, figshare or OSF record: one commit that cites its DOI ─────────

export type RecordKind = "zenodo" | "figshare" | "osf" | "other";

export interface ArchiveRecord {
  kind: RecordKind;
  /** The record's DOI, normalized ("10.5281/zenodo.123"). */
  doi: string;
  /** The record's number on its repository, when the DOI says it. */
  id: string | null;
  /** The address of all its files at once, when the repository has one; otherwise null (the
   *  person downloads them from the record's page). */
  download: string | null;
  /** "the Zenodo record", for sentences and the commit message. */
  label: string;
}

/** "https://doi.org/10.1234/ABC" or "doi:10.1234/abc" → "10.1234/abc"; "" when it is not a DOI.
 *  The rule of normalize_doi (oscr/entities.py) and of the DOI lookup (src/scripts/lookup.ts). */
export function normalizeDoi(text: unknown): string {
  if (typeof text !== "string") return "";
  let doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  if (doi.includes("%")) {
    try {
      doi = decodeURIComponent(doi);
    } catch {
      // not an encoded DOI: kept as typed
    }
  }
  doi = doi.toLowerCase();
  return /^10\.\d{3,9}\/\S+$/.test(doi) ? doi : "";
}

/** A DOI safe in a command and a commit message: the DOI characters records use, nothing else. */
const SAFE_DOI = /^10\.\d{4,9}\/[a-z0-9._;()/:-]{1,200}$/;

/** A record from its DOI or its page's address, or null. */
export function parseRecord(text: unknown): ArchiveRecord | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  let doi = normalizeDoi(value);
  if (!doi) {
    let m = /^https:\/\/(?:www\.)?zenodo\.org\/(?:records?|deposit)\/(\d{1,12})\/?$/i.exec(value);
    if (m) doi = `10.5281/zenodo.${m[1]}`;
    m = /^https:\/\/osf\.io\/([a-z0-9]{5,12})\/?$/i.exec(value);
    if (m) doi = `10.17605/osf.io/${m[1].toLowerCase()}`;
    m = /^https:\/\/(?:[a-z0-9-]+\.)?figshare\.com\/articles\/(?:[^/?#\s]+\/){0,2}(\d{1,12})(?:\/(\d{1,4}))?\/?$/i.exec(value);
    if (m) doi = `10.6084/m9.figshare.${m[1]}${m[2] ? `.v${m[2]}` : ""}`;
  }
  if (!doi || !SAFE_DOI.test(doi)) return null;
  let m = /^10\.5281\/zenodo\.(\d{1,12})$/.exec(doi);
  if (m) return { kind: "zenodo", doi, id: m[1], download: `https://zenodo.org/records/${m[1]}/files-archive`, label: "the Zenodo record" };
  m = /^10\.6084\/m9\.figshare\.(\d{1,12})(?:\.v(\d{1,4}))?$/.exec(doi);
  if (m) {
    const url = `https://figshare.com/ndownloader/articles/${m[1]}${m[2] ? `/versions/${m[2]}` : ""}`;
    return { kind: "figshare", doi, id: m[1], download: url, label: "the figshare record" };
  }
  m = /^10\.17605\/osf\.io\/([a-z0-9]{5,12})$/.exec(doi);
  if (m) {
    return {
      kind: "osf",
      doi,
      id: m[1],
      download: `https://files.osf.io/v1/resources/${m[1]}/providers/osfstorage/?zip=`,
      label: "the OSF project",
    };
  }
  return { kind: "other", doi, id: null, download: null, label: "the record" };
}

/** The commit message of an archive's import: it cites the record's DOI, twice (as "doi:" and as
 *  its address). */
export function recordCommitMessage(record: ArchiveRecord): [string, string] {
  return [
    `Import the files of ${record.label} doi:${record.doi}`,
    `Source: https://doi.org/${record.doi}. An archive has no history: this commit holds the files as published in the record.`,
  ];
}

/** A record's files as ONE commit on the default branch, pushed to an empty repository. */
export function recordCommands(record: ArchiveRecord, dest: RepoCoords): string[] {
  if (!record || !SAFE_DOI.test(record.doi)) throw new TypeError("not a record");
  const name = shq(dest.name);
  const [subject, body] = recordCommitMessage(record);
  const get = record.download
    ? [`curl -L --fail -o ../record.zip ${shq(record.download)}`]
    : [`# Download the record's files from https://doi.org/${record.doi} as ../record.zip (or unpack them here yourself).`];
  return [
    `mkdir ${name}`,
    `cd ${name}`,
    "git init -b main",
    ...get,
    "unzip ../record.zip",
    "git add -A",
    `git commit -m ${shq(subject)} -m ${shq(body)}`,
    `git remote add origin ${shq(destinationUrl(dest))}`,
    "git push -u origin main",
  ];
}

// ─── several repositories at once: a script the researcher runs ──────────────

export interface BulkItem {
  source: GitSource;
  dest: RepoCoords;
  lfs: boolean;
}

export const BULK_MAX = 100;

/** The list of the bulk import, one repository a line: "<git address> [name | owner/name] [lfs]".
 *  Blank lines and "#" comments are skipped; every refusal names its line. */
export function parseBulkList(text: string, owner: string): { items: BulkItem[]; errors: string[] } {
  const items: BulkItem[] = [];
  const errors: string[] = [];
  if (!isOwner(owner)) return { items, errors: ["Your GitHub account name is missing or not valid."] };
  const taken = new Set<string>();
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const n = i + 1;
    const words = line.split(/\s+/);
    const src = parseGitUrl(words[0]);
    if (!src) {
      errors.push(`Line ${n}: not an https or ssh git address.`);
      return;
    }
    let lfs = false;
    let dest: RepoCoords = { owner, name: src.name };
    for (const word of words.slice(1)) {
      if (word.toLowerCase() === "lfs") lfs = true;
      else if (word.includes("/")) {
        const [o, r, ...more] = word.split("/");
        if (more.length || !isOwner(o) || !isRepoName(r)) {
          errors.push(`Line ${n}: "${word}" is not an account and repository name.`);
          return;
        }
        dest = { owner: o, name: r };
      } else if (isRepoName(word)) dest = { owner, name: word };
      else {
        errors.push(`Line ${n}: "${word}" is not a repository name.`);
        return;
      }
    }
    const key = `${dest.owner}/${dest.name}`.toLowerCase();
    if (taken.has(key)) {
      errors.push(`Line ${n}: ${dest.owner}/${dest.name} is already the destination of another line.`);
      return;
    }
    taken.add(key);
    items.push({ source: src, dest, lfs });
  });
  if (items.length > BULK_MAX) errors.push(`At most ${BULK_MAX} repositories in one script.`);
  return { items: items.slice(0, BULK_MAX), errors };
}

/** A POSIX sh script of mirror imports: "set -eu", then one block per repository, each in its own
 *  subshell (a "cd" never leaks into the next). It holds no credential: git asks for the person's. */
export function bulkScript(items: readonly BulkItem[]): string {
  if (!items.length) throw new TypeError("no repository");
  if (items.length > BULK_MAX) throw new TypeError("too many repositories");
  const out = [
    "#!/bin/sh",
    `# Imports ${items.length} ${items.length === 1 ? "repository" : "repositories"} into GitHub, every commit id kept`,
    "# (git clone --mirror, then git push --mirror). Generated in your browser, run on your computer.",
    "# Before running it, create each repository on GitHub, EMPTY (no README, licence or .gitignore).",
    "# It holds no credential: git asks GitHub for yours, as it does for any push.",
    "# Run it in an empty folder: sh import.sh",
    "set -eu",
  ];
  items.forEach((item, i) => {
    out.push("", `# ${i + 1} of ${items.length}: ${item.source.label} -> ${item.dest.owner}/${item.dest.name}${item.lfs ? " (with LFS)" : ""}`, "(");
    for (const line of mirrorCommands(item.source, item.dest, { lfs: item.lfs })) out.push(`  ${line}`);
    out.push(")");
  });
  out.push("", `echo ${shq(`Done: ${items.length} ${items.length === 1 ? "repository" : "repositories"} pushed.`)}`, "");
  return out.join("\n");
}

// ─── import from the paper: the lookup shard ─────────────────────────────────

/** An entry of /lookup/NNN.json: its status, the day it was read, its page, and (scripts/data.mjs)
 *  the https addresses of its code. */
export interface LookupEntry {
  status: string;
  read_on: string;
  slug?: string;
  code?: string[];
}

export type LookupShard = Record<string, LookupEntry>;

/** The lookup shard of a normalized DOI: the first 3 hex characters of its SHA-1 (oscr/entities.py). */
export async function lookupShardOf(doi: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(doi));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 3);
}

export const lookupUrl = (shard: string): string => `/lookup/${shard}.json`;

/** The https addresses a lookup entry carries for a paper's code links (the catalogue's `code[].url`,
 *  as scripts/data.mjs keeps them): https only, no user part, each once, at most 20. */
export function lookupCode(code: unknown): string[] {
  if (!Array.isArray(code)) return [];
  const out: string[] = [];
  for (const c of code) {
    const url = typeof c === "string" ? c : c && typeof c === "object" ? (c as { url?: unknown }).url : null;
    if (typeof url !== "string" || !/^https:\/\/[^\s/@]+\/\S*$/.test(url) || url.length > 400) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length === 20) break;
  }
  return out;
}

/** Whether a paper's code link is a git repository: a known git host (GitHub, GitLab, Bitbucket,
 *  Codeberg, SourceForge's git, a lab's own "gitlab." or "git." server) or an address ending in
 *  ".git". A lab's web page is not. */
export function isGitHost(url: string): boolean {
  const m = /^https:\/\/([^/\s:@]+)(?::\d+)?\//i.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return (
    /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.code\.sf\.net|framagit\.org|salsa\.debian\.org)$/.test(host) ||
    /^(?:gitlab|git|forgejo|gitea)\./.test(host) ||
    /\.git\/?$/i.test(url)
  );
}

export interface PaperPrefill {
  doi: string;
  /** In the catalogue's lookup. */
  found: boolean;
  slug: string | null;
  status: string | null;
  /** The paper's code links that are git repositories: GitHub ones are linked as they are (the
   *  mirror mode), the others imported. */
  sources: GitSource[];
  /** Its Zenodo, figshare or OSF records: imported as one commit citing their DOI. */
  records: ArchiveRecord[];
  /** Links that are neither (a lab's page): shown, not used. */
  other: string[];
  /** The papers the new repository is linked to. */
  papers: string[];
}

/** What "import from the paper" prefills, from the paper's lookup shard; null when `doiText` is not
 *  a DOI. A paper that is not in the shard gives found = false and the paper still to link. */
export function prefillFromPaper(doiText: unknown, shard: LookupShard | null | undefined): PaperPrefill | null {
  const doi = normalizeDoi(doiText);
  if (!doi) return null;
  const entry = shard && Object.prototype.hasOwnProperty.call(shard, doi) ? shard[doi] : null;
  const out: PaperPrefill = {
    doi,
    found: !!entry,
    slug: entry && typeof entry.slug === "string" && /^[a-z0-9._-]+$/.test(entry.slug) ? entry.slug : null,
    status: entry && typeof entry.status === "string" ? entry.status : null,
    sources: [],
    records: [],
    other: [],
    papers: [doi],
  };
  for (const url of lookupCode(entry?.code)) {
    const record = parseRecord(url);
    if (record && record.kind !== "other" && record.doi !== doi) {
      if (!out.records.some((r) => r.doi === record.doi)) out.records.push(record);
      continue;
    }
    const git = isGitHost(url) ? parseGitUrl(url) : null;
    if (git) {
      if (!out.sources.some((s) => s.url === git.url)) out.sources.push(git);
      continue;
    }
    if (!out.other.includes(url)) out.other.push(url);
  }
  return out;
}

// ─── the next steps: create the empty repository, then link it ───────────────

/** /new/ pre-filled for an import: the name, a description, the papers, and NO README (an import
 *  needs an empty repository). */
export function newRepoUrl(o: { name: string; description?: string; papers?: readonly string[] }): string {
  if (!isRepoName(o.name)) throw new TypeError("not a repository name");
  const params = new URLSearchParams({ name: o.name });
  if (o.description) params.set("description", o.description.slice(0, 350));
  for (const doi of o.papers ?? []) if (normalizeDoi(doi)) params.append("paper", normalizeDoi(doi));
  params.set("readme", "0");
  return `/new/?${params}`;
}

/** /new/link/ pre-filled: the repository on GitHub and the papers to link it to. */
export function linkRepoUrl(repo: RepoCoords, papers: readonly string[] = []): string {
  if (!isOwner(repo.owner) || !isRepoName(repo.name)) throw new TypeError("not a repository");
  const params = new URLSearchParams({ repo: `${repo.owner}/${repo.name}` });
  for (const doi of papers) if (normalizeDoi(doi)) params.append("paper", normalizeDoi(doi));
  return `/new/link/?${params}`;
}

// ─── leaving: backups, the layer, GitHub's migration archive, Software Heritage ──

/** A complete backup with git alone: a mirror clone (with LFS objects when asked), and one bundle
 *  file that holds every branch and tag. */
export function backupCommands(repo: RepoCoords, options: MirrorOptions = {}): string[] {
  const url = shq(destinationUrl(repo));
  const folder = shq(mirrorFolder(repo));
  const bundle = shq(`${repo.name}.bundle`);
  return [
    `git clone --mirror ${url} ${folder}`,
    `cd ${folder}`,
    ...(options.lfs ? ["git lfs fetch --all origin"] : []),
    `git bundle create ${shq(`../${repo.name}.bundle`)} --all`,
    "cd ..",
    `git bundle verify ${bundle}`,
    "# To restore: clone the bundle, then push it to a new empty repository.",
    `git clone ${bundle} ${shq(`${repo.name}-restored`)}`,
  ];
}

export interface MigrationOptions {
  excludeGitData?: boolean;
  excludeMetadata?: boolean;
  excludeAttachments?: boolean;
  excludeReleases?: boolean;
  excludeOwnerProjects?: boolean;
}

/** GitHub's migration archive of a repository's metadata (the user migrations API), with the GitHub
 *  CLI and the person's own sign-in: start it, follow its state, download it. The repository is not
 *  locked. */
export function migrationArchiveCommands(repo: RepoCoords, o: MigrationOptions = {}): string[] {
  destinationUrl(repo);
  const flags = [
    `-f ${shq(`repositories[]=${repo.owner}/${repo.name}`)}`,
    "-F lock_repositories=false",
    `-F exclude_git_data=${!!o.excludeGitData}`,
    `-F exclude_metadata=${!!o.excludeMetadata}`,
    `-F exclude_attachments=${!!o.excludeAttachments}`,
    `-F exclude_releases=${!!o.excludeReleases}`,
    `-F exclude_owner_projects=${!!o.excludeOwnerProjects}`,
  ];
  return [
    `MIGRATION_ID=$(gh api --method POST /user/migrations ${flags.join(" ")} --jq .id)`,
    "# Its state: pending, exporting, exported or failed. Wait for exported:",
    `gh api "/user/migrations/$MIGRATION_ID" --jq .state`,
    `gh api "/user/migrations/$MIGRATION_ID/archive" > ${shq(`${repo.name}-migration.tar.gz`)}`,
  ];
}

/** A commit's identifier at Software Heritage. */
export const isSwhRev = (value: unknown): value is string => typeof value === "string" && /^swh:1:rev:[0-9a-f]{40}$/.test(value);

/** Restore a commit's history from Software Heritage (its Vault cooks a bare git repository), then
 *  push it into an empty repository on GitHub. */
export function swhRestoreCommands(swhid: string, dest: RepoCoords): string[] {
  if (!isSwhRev(swhid)) throw new TypeError("not a Software Heritage commit identifier");
  const api = `https://archive.softwareheritage.org/api/1/vault/git-bare/${swhid}/`;
  return [
    "# Ask the archive to prepare it (once), then ask again until its status is done:",
    `curl -X POST ${shq(api)}`,
    `curl ${shq(api)}`,
    `curl -L --fail -o restore.tar.gz ${shq(`${api}raw/`)}`,
    "mkdir restore",
    "tar -xzf restore.tar.gz -C restore",
    "cd restore/*",
    "git log --oneline -3",
    `git push --mirror ${shq(destinationUrl(dest))}`,
  ];
}

/** OSCR's layer for one repository, as the person downloads it: its entry in the static shard, and
 *  where it came from. */
export interface LayerExport {
  repository: string;
  exported_at: string;
  source: string;
  layer: unknown;
}

/** The export of a repository's layer from its shard's JSON (already fetched); null entry when the
 *  registry keeps nothing about it. */
export async function layerExport(repo: RepoCoords, shardJson: unknown, now: Date): Promise<LayerExport> {
  if (!isOwner(repo.owner) || !isRepoName(repo.name)) throw new TypeError("not a repository");
  const shard = await layerShard(repo.owner, repo.name);
  const key = `${repo.owner}/${repo.name}`.toLowerCase();
  const entries = shardJson && typeof shardJson === "object" && !Array.isArray(shardJson) ? (shardJson as Record<string, unknown>) : {};
  return {
    repository: `${repo.owner}/${repo.name}`,
    exported_at: now.toISOString(),
    source: layerUrl(shard),
    layer: Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null,
  };
}

/** "owner/name" typed by a person (or a github.com address), or null. */
export function parseRepoInput(text: unknown): RepoCoords | null {
  if (typeof text !== "string") return null;
  const value = text.trim().replace(/\/+$/, "");
  const git = parseGitUrl(value);
  if (git?.github) return git.github;
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!m) return null;
  const name = m[2].replace(/\.git$/i, "");
  return isOwner(m[1]) && isRepoName(name) ? { owner: m[1], name } : null;
}

// ─── the plan the import page shows ──────────────────────────────────────────

export interface ImportSteps {
  /** The new repository on GitHub. */
  dest: RepoCoords;
  /** Step 1: /new/, pre-filled, with no README (an import needs an empty repository). */
  createUrl: string;
  /** Last step: /new/link/, pre-filled with the repository and the papers. */
  linkUrl: string;
}

/** The two steps around an import's commands: create the empty repository first, link it after. */
export function importSteps(owner: string, name: string, papers: readonly string[], description: string): ImportSteps {
  const dest = { owner, name };
  destinationUrl(dest);
  return {
    dest,
    createUrl: newRepoUrl({ name, description, papers }),
    linkUrl: linkRepoUrl(dest, papers),
  };
}

export interface MirrorPlan extends ImportSteps {
  commands: string[];
  /** The commands of an ongoing mirror, when asked. */
  ongoing: string[] | null;
  /** A source already on GitHub can be linked as it is (the mirror mode), without a copy. */
  linkInstead: string | null;
}

/** Everything the page shows for a git source: create, the mirror's commands, link; or link the
 *  GitHub source itself. */
export function mirrorPlan(o: {
  source: GitSource;
  owner: string;
  name: string;
  lfs?: boolean;
  ongoing?: boolean;
  papers?: readonly string[];
}): MirrorPlan {
  const papers = o.papers ?? [];
  const steps = importSteps(o.owner, o.name, papers, `Imported from ${o.source.label}`);
  return {
    ...steps,
    commands: mirrorCommands(o.source, steps.dest, { lfs: o.lfs }),
    ongoing: o.ongoing ? ongoingMirrorCommands(steps.dest, { lfs: o.lfs }) : null,
    linkInstead: o.source.github ? linkRepoUrl(o.source.github, papers) : null,
  };
}

/** The name of the file the layer's export is saved as. */
export function layerFileName(repo: RepoCoords): string {
  destinationUrl(repo);
  return `${repo.owner}-${repo.name}-layer.json`.toLowerCase();
}
