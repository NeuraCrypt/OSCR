// Line diffs, unified patches and three-way merges: pure, dependency-free, the same in the Worker,
// the browser and the test double.
//
// - `diffLines`: Myers' O(ND) algorithm ("An O(ND) Difference Algorithm and Its Variations",
//   1986), after the common prefix and suffix are set aside.
// - `patch` and `fileDiff`: unified diffs as git writes them: 3 lines of context, "@@ -a,b +c,d @@"
//   hunks (a count of 1 is left out; an empty side starts at the line before), and
//   "\ No newline at end of file" after a last line without one. `patch` is the hunks alone, as
//   GitHub's `files[].patch`; `fileDiff` adds the "diff --git" header, as a ".diff" answer.
// - `diff3` and `merge3`: the three-way merge of one file (Khanna, Kunal and Pierce, "A Formal
//   Investigation of Diff3", 2007), for the browser's conflict resolution of phase 04: the reader's
//   own CPU computes the hunks, the Worker only commits the resolved files.
//
// Lines are split on "\n" only; a "\r" stays part of its line.

export interface Lines {
  lines: string[];
  /** false when the last line has no "\n" (git: "\ No newline at end of file"). */
  finalNewline: boolean;
}

export function splitLines(text: string): Lines {
  if (text === "") return { lines: [], finalNewline: true };
  const lines = text.split("\n");
  const finalNewline = lines[lines.length - 1] === "";
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

export function joinLines(l: Lines): string {
  if (l.lines.length === 0) return "";
  return l.lines.join("\n") + (l.finalNewline ? "\n" : "");
}

export type DiffOp =
  | { kind: "equal"; a: number; b: number }
  | { kind: "delete"; a: number }
  | { kind: "insert"; b: number };

/** The edit script from `a` to `b`: indices into each, in order. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffOp[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "equal", a: i, b: i });
  out.push(...myers(a, b, start, endA, start, endB));
  for (let i = 0; endA + i < a.length; i++) out.push({ kind: "equal", a: endA + i, b: endB + i });
  return out;
}

function myers(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): DiffOp[] {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0) return Array.from({ length: m }, (_, i) => ({ kind: "insert", b: b0 + i }) as DiffOp);
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ kind: "delete", a: a0 + i }) as DiffOp);
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  // Walk the trace back from (n, m) to (0, 0).
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "equal", a: a0 + x, b: b0 + y });
    }
    if (down) {
      y--;
      ops.push({ kind: "insert", b: b0 + y });
    } else {
      x--;
      ops.push({ kind: "delete", a: a0 + x });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "equal", a: a0 + x, b: b0 + y });
  }
  return ops.reverse();
}

/** How many lines a change adds and removes. */
export function lineStats(oldText: string, newText: string): { additions: number; deletions: number } {
  const [a, b] = keyed(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const op of diffLines(a.keys, b.keys)) {
    if (op.kind === "insert") additions++;
    else if (op.kind === "delete") deletions++;
  }
  return { additions, deletions };
}

interface Keyed {
  lines: string[];
  /** The lines as compared: a last line without "\n" differs from the same line with one. */
  keys: string[];
  finalNewline: boolean;
}

const NO_EOL = "\u0000\\ No newline at end of file";

function keyed(oldText: string, newText: string): [Keyed, Keyed] {
  const make = (t: string): Keyed => {
    const l = splitLines(t);
    const keys = l.lines.slice();
    if (!l.finalNewline && keys.length) keys[keys.length - 1] += NO_EOL;
    return { lines: l.lines, keys, finalNewline: l.finalNewline };
  };
  return [make(oldText), make(newText)];
}

const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`);

/** The unified hunks from `oldText` to `newText`, without file headers ("" when equal). */
export function patch(oldText: string, newText: string, context = 3): string {
  const [a, b] = keyed(oldText, newText);
  const ops = diffLines(a.keys, b.keys);
  const changed = ops.map((op, i) => (op.kind === "equal" ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  // Group the changes whose contexts touch.
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= 2 * context + 1) last[1] = i;
    else groups.push([i, i]);
  }
  const out: string[] = [];
  const line = (prefix: string, side: Keyed, index: number) => {
    out.push(prefix + side.lines[index]);
    if (!side.finalNewline && index === side.lines.length - 1) out.push("\\ No newline at end of file");
  };
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let oldStart = -1;
    let newStart = -1;
    let oldCount = 0;
    let newCount = 0;
    // Where each side starts: the first line of that side in the hunk, or after the line before.
    let aBefore = 0;
    let bBefore = 0;
    for (let i = 0; i < from; i++) {
      const op = ops[i];
      if (op.kind !== "insert") aBefore = op.a + 1;
      if (op.kind !== "delete") bBefore = op.b + 1;
    }
    const body: string[] = [];
    const saved = out.length;
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op.kind === "equal") {
        if (oldStart < 0) oldStart = op.a + 1;
        if (newStart < 0) newStart = op.b + 1;
        oldCount++;
        newCount++;
        line(" ", b, op.b);
      } else if (op.kind === "delete") {
        if (oldStart < 0) oldStart = op.a + 1;
        oldCount++;
        line("-", a, op.a);
      } else {
        if (newStart < 0) newStart = op.b + 1;
        newCount++;
        line("+", b, op.b);
      }
    }
    body.push(...out.splice(saved));
    if (oldStart < 0) oldStart = aBefore + 1;
    if (newStart < 0) newStart = bBefore + 1;
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`, ...body);
  }
  return out.join("\n");
}

/** One file's diff as git writes it ("diff --git a/… b/…", then the hunks). `null` is an absent
 *  side (an added or removed file); a binary side gives "Binary files … differ". */
export function fileDiff(
  paths: { old: string | null; new: string | null },
  oldText: string | null,
  newText: string | null,
  binary = false,
): string {
  const aPath = paths.old ?? paths.new ?? "";
  const bPath = paths.new ?? paths.old ?? "";
  const head = [`diff --git a/${aPath} b/${bPath}`];
  if (paths.old === null) head.push("new file mode 100644");
  if (paths.new === null) head.push("deleted file mode 100644");
  const from = paths.old === null ? "/dev/null" : `a/${aPath}`;
  const to = paths.new === null ? "/dev/null" : `b/${bPath}`;
  if (binary) return [...head, `Binary files ${from} and ${to} differ`, ""].join("\n");
  const hunks = patch(oldText ?? "", newText ?? "");
  if (!hunks) return [...head, ""].join("\n");
  return [...head, `--- ${from}`, `+++ ${to}`, hunks, ""].join("\n");
}

// ─── three-way ────────────────────────────────────────────────────────────

export type Diff3Chunk =
  | { kind: "stable"; lines: string[] }
  | { kind: "ours" | "theirs" | "both"; lines: string[] }
  | { kind: "conflict"; base: string[]; ours: string[]; theirs: string[] };

/** For each line of `base`, the line of `other` it is matched with (-1: none). */
function matches(base: readonly string[], other: readonly string[]): Int32Array {
  const map = new Int32Array(base.length).fill(-1);
  for (const op of diffLines(base, other)) if (op.kind === "equal") map[op.a] = op.b;
  return map;
}

const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

/** The chunks of a three-way merge: stable runs, one-sided changes, and conflicts. */
export function diff3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): Diff3Chunk[] {
  const mo = matches(base, ours);
  const mt = matches(base, theirs);
  const chunks: Diff3Chunk[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  for (;;) {
    let i2 = i;
    while (i2 < base.length && !(mo[i2] >= j && mt[i2] >= k)) i2++;
    const j2 = i2 < base.length ? mo[i2] : ours.length;
    const k2 = i2 < base.length ? mt[i2] : theirs.length;
    if (i2 > i || j2 > j || k2 > k) {
      const o = base.slice(i, i2);
      const a = ours.slice(j, j2);
      const b = theirs.slice(k, k2);
      if (same(a, o)) chunks.push({ kind: "theirs", lines: b });
      else if (same(b, o)) chunks.push({ kind: "ours", lines: a });
      else if (same(a, b)) chunks.push({ kind: "both", lines: a });
      else chunks.push({ kind: "conflict", base: o, ours: a, theirs: b });
    }
    if (i2 >= base.length) break;
    let n = 0;
    while (i2 + n < base.length && mo[i2 + n] === j2 + n && mt[i2 + n] === k2 + n) n++;
    chunks.push({ kind: "stable", lines: base.slice(i2, i2 + n) });
    i = i2 + n;
    j = j2 + n;
    k = k2 + n;
  }
  return chunks.filter((c) => c.kind === "conflict" || c.lines.length > 0);
}

export interface Merge3 {
  clean: boolean;
  conflicts: number;
  /** The merged text; conflicts are written with git's markers. */
  text: string;
}

/** A three-way merge of one file's text, with git's conflict markers where both sides changed
 *  the same lines differently. */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  labels: { ours: string; base: string; theirs: string } = { ours: "ours", base: "base", theirs: "theirs" },
): Merge3 {
  const [o, a, b] = [splitLines(base), splitLines(ours), splitLines(theirs)];
  const out: string[] = [];
  let conflicts = 0;
  for (const c of diff3(o.lines, a.lines, b.lines)) {
    if (c.kind !== "conflict") {
      out.push(...c.lines);
      continue;
    }
    conflicts++;
    out.push(`<<<<<<< ${labels.ours}`, ...c.ours, `||||||| ${labels.base}`, ...c.base, "=======", ...c.theirs, `>>>>>>> ${labels.theirs}`);
  }
  // The last line's newline: the side that changed it wins, as for any line.
  const finalNewline = a.finalNewline === o.finalNewline ? b.finalNewline : a.finalNewline;
  return { clean: conflicts === 0, conflicts, text: joinLines({ lines: out, finalNewline: out.length ? finalNewline : true }) };
}
