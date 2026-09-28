// Git objects in memory, with real object ids (SHA-1, as git computes them), for the test double
// (memory.ts):
// - blob: "blob <size>\0" + bytes;
// - tree: the entries sorted as git sorts them (a tree's name compares as name + "/"), each
//   "<mode> <name>\0" + the 20 raw bytes of its id; modes are written 100644, 100755, 120000,
//   40000 (no leading zero in the object) and 160000;
// - commit: "tree <id>\n" + ("parent <id>\n")* + "author <name> <> <time> +0000\n" +
//   "committer <name> <> <time> +0000\n\n" + message. The email is empty (<>) on purpose, so none
//   is ever invented;
// - tag: "object <id>\ntype commit\ntag <name>\ntagger <name> <> <time> +0000\n\n" + message.
// Known ids: the empty tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904; the blob "hello world\n"
// 3b18e512dba79e4c8300dd08aeb37f8e728b8dad.
//
// Also here: flattening a tree to its files, building nested trees back from them, ancestors,
// merge bases, and the path-level three-way merge the double uses (a path changed on one side
// takes that side; changed identically on both, that change; differently on both, a conflict).

import { diffLines, lineStats, patch, splitLines } from "../../worker/forge/diff.ts";
import { concat, fromHex, isBinary, objectId, text, utf8 } from "../../worker/forge/objects.ts";
import type { Actor, FileChangeSummary, ObjectId, TreeEntry } from "../../worker/forge/types.ts";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const ZERO = "0000000000000000000000000000000000000000";

export type Mode = TreeEntry["mode"];

export interface BlobObject {
  type: "blob";
  bytes: Uint8Array;
}
export interface TreeObject {
  type: "tree";
  entries: { name: string; mode: Mode; sha: ObjectId }[];
}
export interface CommitObject {
  type: "commit";
  tree: ObjectId;
  parents: ObjectId[];
  author: Actor;
  committer: Actor;
  /** Unix seconds. */
  authoredAt: number;
  committedAt: number;
  message: string;
  verified: boolean;
  /** Creation order, to sort commits made in the same second. */
  seq: number;
}
export interface TagObject {
  type: "tag";
  object: ObjectId;
  name: string;
  tagger: Actor;
  at: number;
  message: string;
}
export type GitObject = BlobObject | TreeObject | CommitObject | TagObject;

/** A file in a flattened tree. */
export interface FlatEntry {
  mode: Mode;
  sha: ObjectId;
}
export type Flat = Map<string, FlatEntry>;

const typeOf = (mode: Mode): TreeEntry["type"] => (mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob");

const encoder = new TextEncoder();
function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** git's order of tree entries. */
export function gitOrder(a: { name: string; mode: Mode }, b: { name: string; mode: Mode }): number {
  return compareBytes(a.mode === "040000" ? `${a.name}/` : a.name, b.mode === "040000" ? `${b.name}/` : b.name);
}

const stamp = (who: Actor, at: number) => `${who.name.replace(/[<>\n]/g, "")} <> ${at} +0000`;

export class ObjectStore {
  readonly objects = new Map<ObjectId, GitObject>();
  private seq = 0;

  get(sha: ObjectId): GitObject | undefined {
    return this.objects.get(sha);
  }

  blob(sha: ObjectId): BlobObject | undefined {
    const o = this.objects.get(sha);
    return o?.type === "blob" ? o : undefined;
  }

  tree(sha: ObjectId): TreeObject | undefined {
    if (sha === EMPTY_TREE && !this.objects.has(sha)) return { type: "tree", entries: [] };
    const o = this.objects.get(sha);
    return o?.type === "tree" ? o : undefined;
  }

  commit(sha: ObjectId): CommitObject | undefined {
    const o = this.objects.get(sha);
    return o?.type === "commit" ? o : undefined;
  }

  tag(sha: ObjectId): TagObject | undefined {
    const o = this.objects.get(sha);
    return o?.type === "tag" ? o : undefined;
  }

  /** A commit id from a commit or an annotated tag's id. */
  peel(sha: ObjectId): ObjectId | undefined {
    const o = this.objects.get(sha);
    if (o?.type === "commit") return sha;
    if (o?.type === "tag") return this.peel(o.object);
    return undefined;
  }

  async putBlob(bytes: Uint8Array): Promise<ObjectId> {
    const sha = await objectId("blob", bytes);
    if (!this.objects.has(sha)) this.objects.set(sha, { type: "blob", bytes });
    return sha;
  }

  async putTree(entries: { name: string; mode: Mode; sha: ObjectId }[]): Promise<ObjectId> {
    const sorted = [...entries].sort(gitOrder);
    const body = concat(sorted.flatMap((e) => [utf8(`${e.mode === "040000" ? "40000" : e.mode} ${e.name}\u0000`), fromHex(e.sha)]));
    const sha = await objectId("tree", body);
    if (!this.objects.has(sha)) this.objects.set(sha, { type: "tree", entries: sorted });
    return sha;
  }

  async putCommit(c: Omit<CommitObject, "type" | "seq">): Promise<ObjectId> {
    const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${stamp(c.author, c.authoredAt)}`, `committer ${stamp(c.committer, c.committedAt)}`];
    const sha = await objectId("commit", utf8(`${lines.join("\n")}\n\n${c.message}`));
    if (!this.objects.has(sha)) this.objects.set(sha, { type: "commit", ...c, seq: ++this.seq });
    return sha;
  }

  async putTag(t: Omit<TagObject, "type">): Promise<ObjectId> {
    const body = `object ${t.object}\ntype commit\ntag ${t.name}\ntagger ${stamp(t.tagger, t.at)}\n\n${t.message}`;
    const sha = await objectId("tag", utf8(body));
    if (!this.objects.has(sha)) this.objects.set(sha, { type: "tag", ...t });
    return sha;
  }

  /** Every file below a tree, by path from the root (blobs, symbolic links, submodules). */
  flatten(treeSha: ObjectId | null, prefix = "", out: Flat = new Map()): Flat {
    if (!treeSha) return out;
    const tree = this.tree(treeSha);
    if (!tree) throw new Error(`no tree ${treeSha}`);
    for (const e of tree.entries) {
      const path = prefix + e.name;
      if (e.mode === "040000") this.flatten(e.sha, `${path}/`, out);
      else out.set(path, { mode: e.mode, sha: e.sha });
    }
    return out;
  }

  /** The nested trees of these files; the root's id. */
  async writeFlat(flat: Flat): Promise<ObjectId> {
    interface Dir {
      files: Map<string, FlatEntry>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split("/");
      let d = root;
      for (const p of parts.slice(0, -1)) {
        let next = d.dirs.get(p);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          d.dirs.set(p, next);
        }
        d = next;
      }
      d.files.set(parts[parts.length - 1], entry);
    }
    const write = async (d: Dir): Promise<ObjectId> => {
      const entries: { name: string; mode: Mode; sha: ObjectId }[] = [];
      for (const [name, e] of d.files) entries.push({ name, mode: e.mode, sha: e.sha });
      for (const [name, sub] of d.dirs) entries.push({ name, mode: "040000", sha: await write(sub) });
      return this.putTree(entries);
    };
    return write(root);
  }

  /** The entry at `path` in a tree ("" is the tree itself). */
  at(treeSha: ObjectId, path: string): { mode: Mode; sha: ObjectId } | undefined {
    if (!path) return { mode: "040000", sha: treeSha };
    let current: { mode: Mode; sha: ObjectId } = { mode: "040000", sha: treeSha };
    for (const part of path.split("/")) {
      if (current.mode !== "040000") return undefined;
      const tree = this.tree(current.sha);
      const e = tree?.entries.find((x) => x.name === part);
      if (!e) return undefined;
      current = { mode: e.mode, sha: e.sha };
    }
    return current;
  }

  /** A tree's entries, with paths from the root: its children, or everything below it
   *  (depth first, as git lists a recursive tree). */
  entries(treeSha: ObjectId, prefix: string, recursive: boolean): TreeEntry[] {
    const out: TreeEntry[] = [];
    const walk = (sha: ObjectId, pre: string) => {
      for (const e of this.tree(sha)?.entries ?? []) {
        const path = pre + e.name;
        const size = e.mode === "040000" || e.mode === "160000" ? null : (this.blob(e.sha)?.bytes.length ?? null);
        out.push({ path, mode: e.mode, type: typeOf(e.mode), sha: e.sha, size });
        if (recursive && e.mode === "040000") walk(e.sha, `${path}/`);
      }
    };
    walk(treeSha, prefix);
    return out;
  }

  /** A commit and everything it descends from. */
  ancestors(sha: ObjectId): Set<ObjectId> {
    const seen = new Set<ObjectId>();
    const stack = [sha];
    while (stack.length) {
      const s = stack.pop() as ObjectId;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const p of this.commit(s)?.parents ?? []) stack.push(p);
    }
    return seen;
  }

  /** The best common ancestor of two commits, or null. */
  mergeBase(a: ObjectId, b: ObjectId): ObjectId | null {
    const inA = this.ancestors(a);
    const common = [...this.ancestors(b)].filter((s) => inA.has(s));
    if (!common.length) return null;
    const best = common.filter((c) => !common.some((d) => d !== c && this.ancestors(d).has(c)));
    best.sort((x, y) => this.order(y) - this.order(x));
    return best[0];
  }

  /** Newest first: commit time, then creation order. */
  order(sha: ObjectId): number {
    const c = this.commit(sha);
    return c ? c.committedAt * 1e6 + c.seq : 0;
  }

  /** The commits of `head` that `base` lacks, oldest first. */
  missing(base: ObjectId | null, head: ObjectId): ObjectId[] {
    const have = base ? this.ancestors(base) : new Set<ObjectId>();
    return [...this.ancestors(head)].filter((s) => !have.has(s)).sort((x, y) => this.order(x) - this.order(y));
  }

  /** The files changed from one tree to another, as a forge lists them (no rename detection:
   *  a move is a removal and an addition). */
  changes(fromTree: ObjectId | null, toTree: ObjectId): FileChangeSummary[] {
    const a = this.flatten(fromTree);
    const b = this.flatten(toTree);
    const paths = [...new Set([...a.keys(), ...b.keys()])].sort(compareBytes);
    const out: FileChangeSummary[] = [];
    for (const path of paths) {
      const x = a.get(path);
      const y = b.get(path);
      if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
      const status = !x ? "added" : !y ? "removed" : x.sha === y.sha ? "changed" : "modified";
      const before = x ? this.blob(x.sha)?.bytes : undefined;
      const after = y ? this.blob(y.sha)?.bytes : undefined;
      const binary = (before && isBinary(before)) || (after && isBinary(after));
      const oldText = before ? text(before) : "";
      const newText = after ? text(after) : "";
      const tooLong = splitLines(oldText).lines.length > 2000 || splitLines(newText).lines.length > 2000;
      const stats = binary ? { additions: 0, deletions: 0 } : lineStats(oldText, newText);
      out.push({
        path,
        previousPath: null,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        patch: binary || tooLong ? null : patch(oldText, newText) || null,
        blob: y ? y.sha : null,
      });
    }
    return out;
  }

  /** Line-by-line authorship of a file along the first-parent history ending at `commit`: ranges
   *  that cover every line once. */
  blame(commit: ObjectId, path: string): { startLine: number; endLine: number; commit: ObjectId }[] {
    const versions: { commit: ObjectId; blob: ObjectId }[] = [];
    let c: ObjectId | undefined = commit;
    while (c) {
      const obj = this.commit(c) as CommitObject;
      const here = this.at(obj.tree, path);
      if (!here) break;
      const parent: ObjectId | undefined = obj.parents[0];
      const before = parent ? this.at((this.commit(parent) as CommitObject).tree, path) : undefined;
      if (!before || before.sha !== here.sha) versions.push({ commit: c, blob: here.sha });
      if (!before) break;
      c = parent;
    }
    versions.reverse();
    let lines: string[] = [];
    let owners: ObjectId[] = [];
    for (const v of versions) {
      const next = splitLines(text(this.blob(v.blob)?.bytes ?? new Uint8Array())).lines;
      const nextOwners: ObjectId[] = new Array(next.length);
      for (const op of diffLines(lines, next)) {
        if (op.kind === "equal") nextOwners[op.b] = owners[op.a];
        else if (op.kind === "insert") nextOwners[op.b] = v.commit;
      }
      lines = next;
      owners = nextOwners;
    }
    const ranges: { startLine: number; endLine: number; commit: ObjectId }[] = [];
    owners.forEach((owner, i) => {
      const last = ranges[ranges.length - 1];
      if (last && last.commit === owner && last.endLine === i) last.endLine = i + 1;
      else ranges.push({ startLine: i + 1, endLine: i + 1, commit: owner });
    });
    return ranges;
  }
}

const same = (x: FlatEntry | undefined, y: FlatEntry | undefined) => (x === undefined ? y === undefined : y !== undefined && x.sha === y.sha && x.mode === y.mode);

/** The path-level three-way merge: the merged files, and the paths changed differently on both
 *  sides. */
export function mergeFlat(base: Flat, ours: Flat, theirs: Flat): { merged: Flat; conflicts: string[] } {
  const merged: Flat = new Map();
  const conflicts: string[] = [];
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let take: FlatEntry | undefined;
    if (same(o, t)) take = o;
    else if (same(o, b)) take = t;
    else if (same(t, b)) take = o;
    else {
      conflicts.push(path);
      continue;
    }
    if (take) merged.set(path, take);
  }
  return { merged, conflicts: conflicts.sort() };
}

/** Whether a set of files is a valid tree: no path is also a directory of another. */
export function isTreeShaped(flat: Flat): boolean {
  for (const path of flat.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (flat.has(parts.slice(0, i).join("/"))) return false;
  }
  return true;
}
