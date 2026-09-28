// The list of the authors' files, in the code pane of the Code ↔ Paper reader: first the files
// that have matches with the paper (with their number), then every file in its folders (one
// tree per repository when the paper has several), and a filter for long lists. Each file is a
// link to itself in the reader (it opens in a new tab too); a file whose text is not here is
// muted. Rendered by the browser from the reader's data: the page holds the list once.
import { plural } from "../lib/format";
import { fileHref, type ReaderData } from "../lib/reader";
import { ancestors, buildTree, type TreeDir } from "../lib/tree";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Open every folder of a repository whose files are fewer than this. */
const OPEN_ALL = 40;
/** Offer a filter past this many files. */
const FILTER_FROM = 15;
/** Show at most this many files that match a filter. */
const FILTER_MAX = 300;

export function fileTree(nav: HTMLElement, data: ReaderData, base: string, pick: (file: number) => void) {
  const multi = data.repos.length > 1;
  const links = new Map<number, HTMLAnchorElement[]>();
  const folders = new Map<string, HTMLDetailsElement>();
  let current = -1;

  function fileLink(i: number, label: string): HTMLAnchorElement {
    const f = data.files[i];
    const r = data.repos[f.repo];
    const a = el("a");
    a.href = fileHref(base, r.repo, f.path, multi, "code");
    a.dataset.file = String(i);
    a.title = f.text ? f.path : `${f.path}: not shown here, at the source`;
    if (!f.text) a.classList.add("elsewhere");
    a.append(el("span", "name", label));
    if (f.pairs.length) {
      const c = el("span", "count", String(f.pairs.length));
      c.title = plural(f.pairs.length, "match", "matches");
      a.append(c);
    }
    if (!links.has(i)) links.set(i, []);
    links.get(i)!.push(a);
    return a;
  }

  const item = (child: Node) => {
    const li = el("li");
    li.append(child);
    return li;
  };

  function branch(d: TreeDir, repo: number, open: (path: string) => boolean): HTMLUListElement {
    const ul = el("ul");
    for (const sub of d.dirs) {
      const det = el("details");
      det.open = open(sub.path);
      const sum = el("summary", "", sub.name);
      sum.title = sub.path;
      det.append(sum, branch(sub, repo, open));
      folders.set(`${repo}\u0000${sub.path}`, det);
      ul.append(item(det));
    }
    for (const f of d.files) ul.append(item(fileLink(f.file, f.name)));
    return ul;
  }

  // The files with matches, the most matched first.
  const matched = data.files
    .map((f, i) => ({ f, i }))
    .filter((x) => x.f.pairs.length > 0)
    .sort((x, y) => y.f.pairs.length - x.f.pairs.length || Math.min(...x.f.pairs) - Math.min(...y.f.pairs));
  const openAt = new Set<string>();
  for (const { f } of matched.length <= 30 ? matched : []) for (const a of ancestors(f.path)) openAt.add(`${f.repo}\u0000${a}`);

  const parts: HTMLElement[] = [];
  let filter: HTMLInputElement | null = null;
  if (data.files.length >= FILTER_FROM) {
    filter = el("input");
    filter.type = "search";
    filter.placeholder = "Filter the files";
    filter.setAttribute("aria-label", "Filter the files by name");
    const p = el("p", "filter");
    p.append(filter);
    parts.push(p);
  }
  const results = el("ul", "results");
  results.hidden = true;
  parts.push(results);

  const lists = el("div");
  if (matched.length) {
    lists.append(el("h4", "", "With matches"));
    const ul = el("ul");
    for (const { f, i } of matched) ul.append(item(fileLink(i, f.path)));
    lists.append(ul);
  }
  lists.append(el("h4", "", matched.length ? "All files" : "Files"));
  data.repos.forEach((r, ri) => {
    const own = data.files.map((f, i) => ({ path: f.path, file: i })).filter((x) => data.files[x.file].repo === ri);
    const tree = buildTree(own);
    const open = (p: string) => own.length < OPEN_ALL || openAt.has(`${ri}\u0000${p}`);
    let body: HTMLElement;
    if (own.length) body = branch(tree, ri, open);
    else {
      body = el("p", "muted", r.read ? "No file of it could be read here." : "Its files were not read here: ");
      if (!r.read) {
        const a = el("a", "", "at the source");
        a.href = r.url;
        body.append(a, ".");
      }
    }
    const extra = r.note ? el("p", "muted", r.note) : null;
    if (multi) {
      const det = el("details", "repo");
      det.open = own.length > 0 && data.repos.length <= 4;
      const sum = el("summary");
      sum.append(el("strong", "", r.name), el("span", "muted", ` ${r.license || "no license"}${own.length ? `, ${plural(own.length, "file")}` : ""}`));
      det.append(sum, body);
      if (extra) det.append(extra);
      folders.set(`${ri}\u0000`, det);
      lists.append(det);
    } else {
      lists.append(body);
      if (extra) lists.append(extra);
    }
  });
  parts.push(lists);
  nav.replaceChildren(...parts);

  filter?.addEventListener("input", () => {
    const q = filter!.value.trim().toLowerCase();
    lists.hidden = q !== "";
    results.hidden = q === "";
    if (!q) return;
    const found = data.files.map((f, i) => ({ f, i })).filter((x) => x.f.path.toLowerCase().includes(q));
    results.replaceChildren(
      ...found.slice(0, FILTER_MAX).map((x) => item(fileLink(x.i, multi ? `${data.repos[x.f.repo].name}: ${x.f.path}` : x.f.path))),
      ...(found.length === 0 ? [el("li", "muted", "No file has this in its name.")] : []),
      ...(found.length > FILTER_MAX ? [el("li", "muted", `and ${plural(found.length - FILTER_MAX, "more file")}`)] : []),
    );
    mark(current);
  });

  nav.addEventListener("click", (ev) => {
    const a = (ev.target as Element).closest<HTMLAnchorElement>("a[data-file]");
    if (!a || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    pick(Number(a.dataset.file));
  });

  function mark(i: number) {
    for (const a of Array.from(nav.querySelectorAll('a[aria-current="true"]'))) a.removeAttribute("aria-current");
    for (const a of Array.from(nav.querySelectorAll<HTMLAnchorElement>(`a[data-file="${i}"]`))) a.setAttribute("aria-current", "true");
  }

  return {
    /** File i is shown: mark it, open its folders, and bring it into the list's view. */
    setCurrent(i: number) {
      current = i;
      mark(i);
      const f = data.files[i];
      if (!f) return;
      if (multi) folders.get(`${f.repo}\u0000`)?.setAttribute("open", "");
      for (const a of ancestors(f.path)) folders.get(`${f.repo}\u0000${a}`)?.setAttribute("open", "");
      const target = (links.get(i) ?? []).find((a) => a.offsetParent !== null);
      if (!target || nav.hidden) return;
      const top = target.getBoundingClientRect().top - nav.getBoundingClientRect().top;
      if (top < 0 || top > nav.clientHeight - 24) nav.scrollTop += top - nav.clientHeight / 3;
    },
  };
}
