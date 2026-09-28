// The test double's shared machinery (memory.ts): repositories as GitBackend shows them,
// revisions, ref updates with the events GitHub would send, commits, merges, licences, READMEs
// and languages.

import { GitBackendError } from "../../worker/forge/errors.ts";
import { isBinary, text, utf8 } from "../../worker/forge/objects.ts";
import { isObjectId } from "../../worker/forge/paths.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Flat, mergeFlat } from "./gitobjects.ts";
import { type Account, type Call, iso, type MemRepo, type MemoryBackend } from "./memory.ts";

export const notFound = (what = "not found") => new GitBackendError("not_found", what);

/** The repositories of one fork network (they share objects, as on GitHub). */
export function network(b: MemoryBackend, r: MemRepo): MemRepo[] {
  const root = (x: MemRepo): string => {
    let cur = x;
    for (let i = 0; i < 100 && cur.parentId; i++) {
      const p = b.repos.get(cur.parentId);
      if (!p) break;
      cur = p;
    }
    return cur.id;
  };
  const mine = root(r);
  return [...b.repos.values()].filter((x) => !x.deleted && root(x) === mine);
}

/** Whether a commit belongs to the repository's network (reachable from one of its refs). */
export function reachable(b: MemoryBackend, r: MemRepo, sha: T.ObjectId): boolean {
  for (const x of network(b, r)) {
    for (const head of [...x.branches.values(), ...x.tags.values()]) {
      const c = b.store.peel(head);
      if (c && b.store.ancestors(c).has(sha)) return true;
    }
  }
  return false;
}

/** A revision's commit: a full id in the network, a branch, a tag (peeled), "refs/…" or HEAD. */
export function resolveRev(b: MemoryBackend, r: MemRepo, rev: T.Rev): T.ObjectId {
  let name: string = rev;
  if (isObjectId(rev)) {
    const c = b.store.peel(rev);
    if (!c || !reachable(b, r, c)) throw notFound("no such commit");
    return c;
  }
  if (name === "HEAD") {
    if (!r.defaultBranch) throw notFound("the repository is empty");
    name = r.defaultBranch;
  }
  if (name.startsWith("refs/heads/")) {
    const sha = r.branches.get(name.slice(11));
    if (!sha) throw notFound("no such branch");
    return sha;
  }
  if (name.startsWith("refs/tags/")) {
    const t = r.tags.get(name.slice(10));
    const c = t ? b.store.peel(t) : undefined;
    if (!c) throw notFound("no such tag");
    return c;
  }
  const branch = r.branches.get(name);
  if (branch) return branch;
  const tag = r.tags.get(name);
  const c = tag ? b.store.peel(tag) : undefined;
  if (c) return c;
  throw notFound("no such revision");
}

/** Move a branch (null: delete it), with the events GitHub sends: `ref` on creation and
 *  deletion, `push` always, `pull_request` "synchronize" for the pull requests it heads. */
export function setBranch(c: Call, r: MemRepo, name: string, sha: T.ObjectId | null): void {
  const b = c.b;
  const before = r.branches.get(name) ?? null;
  if (sha === null) r.branches.delete(name);
  else r.branches.set(name, sha);
  if (sha !== null && r.defaultBranch === null) r.defaultBranch = name;
  const sender = c.actor();
  const installation = b.installationFor(r);
  if (before === null && sha !== null) b.record({ kind: "ref", delivery: "", installation, action: "created", refType: "branch", ref: name, repo: b.stub(r), sender });
  if (before !== null && sha === null) b.record({ kind: "ref", delivery: "", installation, action: "deleted", refType: "branch", ref: name, repo: b.stub(r), sender });
  b.pushed(r, sender, `refs/heads/${name}`, before, sha);
  if (sha === null) return;
  for (const x of b.repos.values()) {
    for (const issue of x.issues.values()) {
      const p = issue.pull;
      if (!p || issue.state !== "open" || p.headRepoId !== r.id || p.headRef !== name || p.headSha === sha) continue;
      p.headSha = sha;
      issue.updatedAt = b.now();
      b.record({ kind: "pull_request", delivery: "", installation: b.installationFor(x), action: "synchronize", number: issue.number, repo: b.stub(x), head: { ref: name, sha }, base: { ref: p.baseRef }, merged: false, sender });
    }
  }
}

/** Move a tag (null: delete it), with its `ref` and `push` events. */
export function setTag(c: Call, r: MemRepo, name: string, target: T.ObjectId | null): void {
  const b = c.b;
  const before = r.tags.get(name) ?? null;
  if (target === null) r.tags.delete(name);
  else r.tags.set(name, target);
  const sender = c.actor();
  const installation = b.installationFor(r);
  b.record({ kind: "ref", delivery: "", installation, action: target === null ? "deleted" : "created", refType: "tag", ref: name, repo: b.stub(r), sender });
  b.pushed(r, sender, `refs/tags/${name}`, before, target);
}

/** A new commit of these files; the branch is not moved here. */
export async function makeCommit(
  c: Call,
  o: { flat: Flat; parents: T.ObjectId[]; message: string; author?: T.Actor; authoredAt?: number },
): Promise<{ sha: T.ObjectId; tree: T.ObjectId }> {
  const b = c.b;
  const tree = await b.store.writeFlat(o.flat);
  const committer = c.kind === "user" ? c.actor() : { name: b.appSlug, login: null, id: null };
  const sha = await b.store.putCommit({
    tree,
    parents: o.parents,
    author: o.author ?? committer,
    committer,
    authoredAt: o.authoredAt ?? b.now(),
    committedAt: b.now(),
    message: o.message,
    verified: true,
  });
  return { sha, tree };
}

/** The path-level three-way merge of two commits: the merged files, or the conflicting paths. */
export function mergeCommits(b: MemoryBackend, ours: T.ObjectId, theirs: T.ObjectId): { merged: Flat; conflicts: string[] } {
  const base = b.store.mergeBase(ours, theirs);
  return mergeFlat(b.flat(base), b.flat(ours), b.flat(theirs));
}

/** A commit as GitBackend shows it. */
export function commitOut(b: MemoryBackend, sha: T.ObjectId): T.CommitSummary {
  const c = b.store.commit(sha);
  if (!c) throw notFound("no such commit");
  return {
    sha,
    parents: [...c.parents],
    tree: c.tree,
    message: c.message,
    author: { ...c.author },
    authoredAt: iso(c.authoredAt),
    committer: { ...c.committer },
    committedAt: iso(c.committedAt),
    verified: c.verified,
  };
}

// ─── what a repository's home shows ───────────────────────────────────────

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:\.(?:md|txt|rst))?$/i;

/** The licence file at the root, and the SPDX id its text says (a few common ones). */
export function licenseOf(b: MemoryBackend, head: T.ObjectId | undefined): { spdx: string | null; path: string } | null {
  if (!head) return null;
  const tree = b.store.tree((b.store.commit(head) as { tree: string }).tree);
  const entry = tree?.entries.filter((e) => e.mode !== "040000" && LICENSE_FILE.test(e.name)).sort((x, y) => x.name.localeCompare(y.name))[0];
  if (!entry) return null;
  const t = text(b.store.blob(entry.sha)?.bytes ?? new Uint8Array());
  let spdx: string | null = null;
  if (/MIT License/i.test(t)) spdx = "MIT";
  else if (/Apache License/i.test(t) && /Version 2\.0/.test(t)) spdx = "Apache-2.0";
  else if (/GNU GENERAL PUBLIC LICENSE/.test(t) && /Version 3/.test(t)) spdx = "GPL-3.0";
  else if (/BSD 3-Clause/i.test(t)) spdx = "BSD-3-Clause";
  else if (/Creative Commons Attribution 4\.0/i.test(t)) spdx = "CC-BY-4.0";
  else if (/CC0 1\.0/i.test(t)) spdx = "CC0-1.0";
  return { spdx, path: entry.name };
}

export function licenseText(key: string, owner: string): string {
  switch (key.toLowerCase()) {
    case "mit":
      return `MIT License\n\nCopyright (c) 2026 ${owner}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n`;
    case "apache-2.0":
      return "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n";
    case "gpl-3.0":
      return "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";
    case "cc-by-4.0":
      return "Creative Commons Attribution 4.0 International Public License\n";
    case "cc0-1.0":
      return "CC0 1.0 Universal\n";
    default:
      return `${key} license\n`;
  }
}

export function gitignoreText(template: string): string {
  if (template.toLowerCase() === "python") return "__pycache__/\n*.py[cod]\n.venv/\n";
  if (template.toLowerCase() === "r") return ".Rhistory\n.RData\n.Rproj.user/\n";
  return `# ${template}\n`;
}

const LANGUAGES: Record<string, string> = {
  py: "Python", r: "R", jl: "Julia", m: "MATLAB", js: "JavaScript", ts: "TypeScript", c: "C", h: "C", cpp: "C++",
  cc: "C++", hpp: "C++", f90: "Fortran", f: "Fortran", sh: "Shell", ipynb: "Jupyter Notebook", rs: "Rust", go: "Go",
  java: "Java", scala: "Scala", html: "HTML", css: "CSS", tex: "TeX", stan: "Stan", do: "Stata", sas: "SAS",
};

/** Bytes per language at a commit, by file extension (a small linguist). */
export function languagesOf(b: MemoryBackend, head: T.ObjectId | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!head) return out;
  for (const [path, e] of b.flat(head)) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
    const lang = ext ? LANGUAGES[ext] : undefined;
    const blob = b.store.blob(e.sha);
    if (!lang || !blob || isBinary(blob.bytes)) continue;
    out[lang] = (out[lang] ?? 0) + blob.bytes.length;
  }
  return out;
}

/** A repository as GitBackend shows it to this session. */
export function info(c: Call, r: MemRepo): T.RepoInfo {
  const b = c.b;
  const owner = b.accounts.get(r.ownerId) as Account;
  const head = r.defaultBranch ? r.branches.get(r.defaultBranch) : undefined;
  let size = 0;
  if (head) for (const e of b.flat(head).values()) size += b.store.blob(e.sha)?.bytes.length ?? 0;
  const live = (id: string | null) => {
    const x = id ? b.repos.get(id) : undefined;
    return x && !x.deleted ? b.refOf(x) : null;
  };
  const ref = b.refOf(r);
  return {
    key: { forge: "memory", id: r.id },
    nodeId: r.nodeId,
    ref,
    owner: { id: owner.id, login: owner.login, type: owner.type },
    visibility: r.visibility,
    archived: r.archived,
    disabled: r.disabled,
    isTemplate: r.isTemplate,
    parent: live(r.parentId),
    template: live(r.templateId),
    defaultBranch: r.defaultBranch,
    description: r.description,
    homepage: r.homepage,
    topics: [...r.topics],
    licenseSpdx: licenseOf(b, head)?.spdx ?? null,
    sizeKb: Math.ceil(size / 1024),
    createdAt: iso(r.createdAt),
    pushedAt: r.pushedAt === null ? null : iso(r.pushedAt),
    features: { ...r.features },
    permission: c.kind === "anonymous" ? null : c.permission(r),
    webUrl: b.links.repo(ref),
    cloneUrl: b.links.clone(ref),
  };
}

/** A new, empty repository. */
export function newRepo(b: MemoryBackend, ownerId: string, name: string, o: Partial<MemRepo> = {}): MemRepo {
  const id = b.nextId();
  const r: MemRepo = {
    id,
    nodeId: `R_mem${id}`,
    ownerId,
    name,
    visibility: "public",
    archived: false,
    disabled: false,
    deleted: false,
    isTemplate: false,
    parentId: null,
    templateId: null,
    defaultBranch: null,
    description: "",
    homepage: "",
    topics: [],
    features: { issues: true, wiki: true, autoMerge: false, deleteBranchOnMerge: false },
    createdAt: b.now(),
    pushedAt: null,
    collaborators: new Map(),
    branches: new Map(),
    protectedBranches: new Set(),
    tags: new Map(),
    counter: 0,
    issues: new Map(),
    labels: new Map(),
    milestones: new Map(),
    milestoneCounter: 0,
    releases: new Map(),
    pendingTransfer: null,
    autolinks: new Map(),
    checkRuns: new Map(),
    statuses: new Map(),
    threads: new Map(),
    ...o,
  };
  b.repos.set(id, r);
  b.paths.set(`${(b.accounts.get(ownerId) as Account).login}/${name}`.toLowerCase(), id);
  b.redirects.delete(`${(b.accounts.get(ownerId) as Account).login}/${name}`.toLowerCase());
  return r;
}

/** Whether a path is taken on an account (a live repository, not a redirect). */
export function taken(b: MemoryBackend, ownerLogin: string, name: string): boolean {
  const id = b.paths.get(`${ownerLogin}/${name}`.toLowerCase());
  return Boolean(id && !b.repos.get(id)?.deleted);
}

export const bytesOf = utf8;
