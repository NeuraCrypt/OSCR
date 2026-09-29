// The files of a repository as a tree, for the code pane of the Code ↔ Paper reader: folders
// first, then files, each in natural order ("Figure2" before "Figure10"); a folder that holds
// only one folder is shown with it ("src/main/java"), as editors do. Pure: tested in
// tests/reader.test.ts.

export type TreeFile = { name: string; path: string; file: number };
export type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: TreeFile[]; count: number };

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byName = (x: { name: string }, y: { name: string }) => collator.compare(x.name, y.name) || (x.name < y.name ? -1 : 1);

/** The tree of files, `file` being each one's index among the reader's files. */
export function buildTree(entries: readonly { path: string; file: number }[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [], count: 0 };
  const dirs = new Map<string, TreeDir>([["", root]]);
  const dirOf = (path: string): TreeDir => {
    const known = dirs.get(path);
    if (known) return known;
    const cut = path.lastIndexOf("/");
    const parent = dirOf(cut < 0 ? "" : path.slice(0, cut));
    const d: TreeDir = { name: path.slice(cut + 1), path, dirs: [], files: [], count: 0 };
    parent.dirs.push(d);
    dirs.set(path, d);
    return d;
  };
  for (const e of entries) {
    const path = e.path.replace(/^\/+|\/+$/g, "");
    const cut = path.lastIndexOf("/");
    dirOf(cut < 0 ? "" : path.slice(0, cut)).files.push({ name: path.slice(cut + 1), path, file: e.file });
  }
  const finish = (d: TreeDir): TreeDir => {
    d.dirs = d.dirs.map(finish);
    // A folder that holds a single folder and no file: shown as one ("src/main").
    d.dirs = d.dirs.map((x) => {
      let y = x;
      while (y.files.length === 0 && y.dirs.length === 1) y = { ...y.dirs[0], name: `${y.name}/${y.dirs[0].name}` };
      return y;
    });
    d.dirs.sort(byName);
    d.files.sort(byName);
    d.count = d.files.length + d.dirs.reduce((n, x) => n + x.count, 0);
    return d;
  };
  return finish(root);
}

/** The folders to open to show a file: its path's ancestors ("a", "a/b"). */
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
