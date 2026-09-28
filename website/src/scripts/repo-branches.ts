// The repository's Branches page, inside the /r/ shell (/r/<owner>/<name>/branches/; night phase 01,
// E8): the branches read in the reader's browser on their own GitHub quota (one request per 100
// branches; the last commit of each only when a view needs it, one request per branch, at most
// DATED), in a table.branches, with GitHub's views (overview, default, yours, active, stale, all)
// and a search by name; create, rename and delete as authorized actions (E4), never the default
// branch, which is said in words. The pure logic: src/lib/repo-settings-view.ts.
//
// Everything is written as text nodes, never as HTML; like every browser script, it never names the
// platform.

import type { GitSession } from "../../worker/forge/gitbackend.ts";
import type { ShellRepo } from "../lib/forge.ts";
import { access, ago, BRANCH_VIEWS, branchView, declare, deletable, type BranchRow, type BranchView } from "../lib/repo-settings-view.ts";
import type { ActionKind } from "../../worker/forge/service/types.ts";
import { showConfirm, startAction } from "./forge-client.ts";

/** Branches whose last commit is read for the views by date (one request each). */
export const DATED = 30;
/** Pages of 100 branches read at most. */
export const PAGES = 3;

const VIEW_WORDS: Record<BranchView, string> = {
  overview: "Overview",
  default: "Default",
  yours: "Yours",
  active: "Active",
  stale: "Stale",
  all: "All branches",
};

type Kid = Node | string | null | false | undefined;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
}

export async function listBranches(session: GitSession, repo: ShellRepo): Promise<BranchRow[]> {
  const ref = { forge: "github" as const, owner: repo.owner, name: repo.name };
  const rows: BranchRow[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < PAGES; i++) {
    const page = await session.git.listBranches(ref, { cursor, perPage: 100 });
    for (const b of page.items) rows.push({ name: b.name, sha: b.sha, protected: b.protected, date: null, author: null });
    cursor = page.next;
    if (!cursor) break;
  }
  return rows;
}

/** The last commit of up to DATED branches, for the views by date. */
export async function dateBranches(session: GitSession, repo: ShellRepo, rows: BranchRow[]): Promise<void> {
  const ref = { forge: "github" as const, owner: repo.owner, name: repo.name };
  for (const r of rows.filter((x) => x.date === null).slice(0, DATED)) {
    const page = await session.git.commits(ref, { rev: r.sha }, { perPage: 1 });
    const c = page.items[0];
    if (!c) continue;
    const t = Date.parse(c.committedAt);
    r.date = Number.isFinite(t) ? Math.floor(t / 1000) : null;
    r.author = c.author.login;
  }
}

export function mountBranches(root: HTMLElement, repo: ShellRepo, deps: { session?: GitSession; me?: string | null } = {}): void {
  const site = document.getElementById("repo-shell")?.dataset.site || "the registry";
  const can = access(repo, site);
  const back = `/r/${repo.owner}/${repo.name}/branches/`;
  const now = () => Math.floor(Date.now() / 1000);
  let rows: BranchRow[] = [];
  let view: BranchView = "overview";
  let query = "";
  let dated = false;
  let me = deps.me ?? null;

  const said = el("p", { role: "status" });
  const box = el("div", { "aria-live": "polite" });
  const table = el("table", { class: "branches" });
  const nav = el("nav", { class: "tabs", "aria-label": "Branch views" });
  const search = el("input", { type: "search", name: "q", placeholder: "Search branches", autocomplete: "off", spellcheck: "false" });
  search.id = "branch-search";

  function act(kind: ActionKind, payload: Record<string, unknown>): void {
    const d = declare(repo, kind, payload, back);
    if ("problem" in d) {
      box.replaceChildren(el("p", { class: "warning" }, d.problem));
      return;
    }
    showConfirm(box, d.sentence, () => startAction(d.input, d.sentence));
    box.scrollIntoView({ block: "nearest" });
  }

  function draw(): void {
    const ul = el("ul");
    for (const v of BRANCH_VIEWS) {
      const a = el("a", { href: `#${v}` }, VIEW_WORDS[v]);
      if (v === view) a.setAttribute("aria-current", "page");
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        void choose(v);
      });
      ul.append(el("li", {}, a));
    }
    nav.replaceChildren(ul);
    const shown = branchView(rows, view, { defaultBranch: repo.defaultBranch, me, now: now(), query });
    const head = el("tr", {}, el("th", { text: "Branch" }), el("th", { text: "Last commit" }), el("th", { text: "By" }), can.act ? el("th", { text: "Change" }) : null);
    const body = shown.map((r) => {
      const isDefault = r.name === repo.defaultBranch;
      const name = el("td", {}, el("a", { href: `${repo.web}/tree/${encodeURIComponent(r.name)}` }, r.name), isDefault ? " (the default branch)" : "", r.protected ? " (protected)" : "");
      const changes = el("td");
      if (can.act) {
        const rename = el("button", { type: "button" }, "Rename");
        rename.addEventListener("click", () => {
          const to = el("input", { type: "text", name: "to", autocomplete: "off", spellcheck: "false", maxlength: "255" });
          to.value = r.name;
          const go = el("button", { type: "submit" }, "Rename");
          const f = el("form", {}, el("label", {}, `New name for ${r.name} `, to), " ", go);
          f.addEventListener("submit", (ev) => {
            ev.preventDefault();
            act("branch_rename", { from: r.name, to: to.value.trim() });
          });
          box.replaceChildren(f);
          to.focus();
        });
        changes.append(rename);
        if (deletable(r, repo.defaultBranch)) {
          const del = el("button", { type: "button" }, "Delete");
          del.addEventListener("click", () => act("branch_delete", { name: r.name }));
          changes.append(" ", del);
        }
      }
      return el("tr", {}, name, el("td", { text: ago(r.date, now()) }), el("td", { text: r.author ?? "" }), can.act ? changes : null);
    });
    table.replaceChildren(el("thead", {}, head), el("tbody", {}, ...body));
    said.textContent = shown.length
      ? `${shown.length} ${shown.length === 1 ? "branch" : "branches"}${query ? ` matching “${query}”` : ""}.`
      : view === "yours" && !me
        ? "Sign in with GitHub to see your branches."
        : "No branch here.";
  }

  async function choose(v: BranchView): Promise<void> {
    view = v;
    if (v === "yours" && me === null && repo.signedIn) {
      // The reader's GitHub handle (one request, signed in only).
      try {
        const answer = (await (await fetch("/api/account/me", { credentials: "same-origin", headers: { Accept: "application/json" } })).json()) as { handles?: { github?: string | null } };
        me = answer?.handles?.github ?? null;
      } catch {
        me = null;
      }
    }
    if (!dated && (v === "yours" || v === "active" || v === "stale") && deps.session) {
      dated = true;
      said.textContent = "Reading the last commit of each branch on GitHub…";
      try {
        await dateBranches(deps.session, repo, rows);
      } catch {
        said.textContent = "GitHub did not answer every request (its hourly quota for readers who are not signed in is small): some dates are missing.";
      }
    }
    draw();
  }

  search.addEventListener("input", () => {
    query = search.value;
    draw();
  });

  const create = el("form", {});
  if (can.act && repo.defaultBranch) {
    const name = el("input", { type: "text", name: "name", autocomplete: "off", spellcheck: "false", maxlength: "255" });
    const from = el("input", { type: "text", name: "from", autocomplete: "off", spellcheck: "false", maxlength: "255" });
    from.value = repo.defaultBranch;
    create.append(
      el("h3", { text: "Create a branch" }),
      el("p", {}, el("label", {}, "Name ", name), " ", el("label", {}, "from the branch, tag or commit ", from), " ", el("button", { type: "submit" }, "Create")),
    );
    create.addEventListener("submit", (ev) => {
      ev.preventDefault();
      act("branch_create", { name: name.value.trim(), from: from.value.trim() });
    });
  }

  const parts: (HTMLElement | null)[] = [
    el("h2", { text: "Branches" }),
    el("p", {}, repo.defaultBranch ? `The default branch is ${repo.defaultBranch}: new clones check it out, and it cannot be deleted.` : "The repository is empty: its first push makes its first branch."),
    can.act ? null : el("p", {}, can.why),
    nav,
    el("p", {}, el("label", { for: "branch-search" }, "Search "), search),
    said,
    table,
    create,
    box,
  ];
  root.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));

  if (!deps.session || !repo.defaultBranch) {
    draw();
    return;
  }
  said.textContent = "Reading the branches on GitHub…";
  listBranches(deps.session, repo)
    .then((r) => {
      rows = r;
      draw();
    })
    .catch(() => {
      said.className = "warning";
      said.textContent = "GitHub did not answer (its hourly quota for readers who are not signed in may be spent): the branches are on GitHub's own page.";
      said.append(" ", el("a", { href: `${repo.web}/branches` }, "Branches on GitHub"));
    });
}
