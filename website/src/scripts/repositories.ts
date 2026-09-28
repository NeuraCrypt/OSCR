// "Your repositories" (/repositories/), in the reader's browser: the repositories the registry knows
// in the reader's GitHub account (GET /api/forge/mine), the ones waiting for deletion first with
// their dates, the filters (GitHub's mirror: and template: qualifiers, adapted), the next pages,
// and the caps of one account. A reader without the hint cookie (`__Host-oscr_signed_in=1`) is
// signed out: the page shows its sentence and asks the Worker nothing. Everything is written with
// DOM text nodes, never as HTML. Like every browser script, it never names the platform.
//
// The pure functions (exported) are tested in Node: tests/forge-service/read.test.ts. The page's
// own part runs only in a browser.

import { repoPath } from "../lib/forge.ts";

export const HINT = "__Host-oscr_signed_in=1";
export const MINE_PATH = "/api/forge/mine";

type Mode = "created" | "installed" | "public";
type State = "active" | "archived" | "pending_deletion" | "hidden" | "deleted" | "gone";

export interface MineItem {
  forge: string;
  id: string;
  owner: string;
  name: string;
  url: string;
  mode: Mode;
  state: State;
  template: boolean;
  papers: number;
  headAt: number | null;
  lastSeen: number;
  deleteAfter: number | null;
}

export interface MineAnswer {
  github: string | null;
  filters: { mode: string | null; template: boolean | null };
  repositories: MineItem[];
  next: string | null;
  pending?: MineItem[];
  caps?: { limits: Record<string, number>; used: Record<string, number> };
  open?: boolean;
  sentence?: string;
  error?: { code: string; message: string };
}

/** Whether the page may ask the Worker: only when the hint cookie says a session is there. A
 *  signed-out reader costs no request. */
export function shouldAsk(cookie: string): boolean {
  return typeof cookie === "string" && cookie.split(/;\s*/).includes(HINT);
}

/** The address of one page of the list, with the filters the form holds. */
export function mineUrl(filters: { mode?: string; template?: string }, after: string | null = null): string {
  const q = new URLSearchParams();
  if (filters.mode && ["created", "installed", "public", "mirror"].includes(filters.mode)) q.set("mode", filters.mode);
  if (filters.template === "true" || filters.template === "false") q.set("template", filters.template);
  if (after) q.set("after", after);
  const s = q.toString();
  return s ? `${MINE_PATH}?${s}` : MINE_PATH;
}

/** A day as the pages write it: 2026-10-28 (UTC). */
export const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/** How the registry holds a repository, in words. */
export function modeWords(mode: Mode): string {
  if (mode === "created") return "created through the registry";
  if (mode === "installed") return "linked, with the App installed (its pushes arrive as they happen)";
  return "linked, public, without the App (read every night)";
}

/** A repository's state in words, and its tone (science.css .ok, .warning): never a pill. */
export function stateWords(r: Pick<MineItem, "state" | "deleteAfter">): { text: string; tone: "" | "ok" | "warning" } {
  switch (r.state) {
    case "active":
      return { text: "active", tone: "ok" };
    case "archived":
      return { text: "archived: read only", tone: "" };
    case "pending_deletion":
      return {
        text: r.deleteAfter !== null ? `waiting for deletion: it leaves the registry after ${day(r.deleteAfter)}` : "waiting for deletion",
        tone: "warning",
      };
    case "deleted":
      return { text: "deleted", tone: "warning" };
    case "gone":
      return { text: "no longer on GitHub", tone: "warning" };
    default:
      return { text: r.state, tone: "" };
  }
}

/** The restore link of a pending deletion: the repository's settings page, where one authorization
 *  on GitHub cancels it (E4's restore action). */
export function restoreLink(r: Pick<MineItem, "owner" | "name">): { href: string; text: string } {
  return {
    href: repoPath({ owner: r.owner, name: r.name }, "settings"),
    text: "Restore it from its settings page: one authorization on GitHub cancels the deletion and unarchives it",
  };
}

// ─── the page ────────────────────────────────────────────────────────────────

type Part = string | { href: string; text: string } | { strong: string };

function write(el: HTMLElement | null, tone: "" | "ok" | "warning", ...parts: Part[]) {
  if (!el) return;
  if (tone) el.className = tone;
  else el.removeAttribute("class");
  el.replaceChildren(...parts.map(node));
}

function node(p: Part): Node {
  if (typeof p === "string") return document.createTextNode(p);
  if ("strong" in p) {
    const s = document.createElement("strong");
    s.textContent = p.strong;
    return s;
  }
  // Only this site's pages become links; anything else stays text.
  if (!/^\/(?!\/)/.test(p.href)) return document.createTextNode(p.text);
  const a = document.createElement("a");
  a.href = p.href;
  a.textContent = p.text;
  return a;
}

/** A span of text with a class of science.css (.ok, .warning, .label, .num), or none. */
function span(text: string, cls: "" | "ok" | "warning" | "label" | "num"): HTMLSpanElement {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function line(label: string, ...content: (Part | Node)[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "line";
  div.append(span(`${label}: `, "label"));
  for (const c of content) div.append(c instanceof Node ? c : node(c));
  return div;
}

function entry(list: HTMLElement, r: MineItem, n: number) {
  const dt = document.createElement("dt");
  dt.append(span(`[${n}]`, "num"));
  dt.append(" ", node({ href: r.url, text: `${r.owner}/${r.name}` }));
  const dd = document.createElement("dd");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = `${r.owner} / ${r.name}${r.template ? ", a template" : ""}`;
  dd.append(title);
  dd.append(line("Mode", modeWords(r.mode)));
  const s = stateWords(r);
  dd.append(line("Status", span(s.text, s.tone)));
  dd.append(line("Papers", r.papers === 0 ? "none attached yet" : `${r.papers} attached`));
  const seen = r.headAt !== null ? `last push seen ${day(r.headAt)}` : "no push seen yet";
  dd.append(line("Seen", `${seen}; the registry's row last changed ${day(r.lastSeen)}`));
  list.append(dt, dd);
}

function pendingItem(r: MineItem): HTMLLIElement {
  const li = document.createElement("li");
  li.append(node({ href: r.url, text: `${r.owner}/${r.name}` }), ": ");
  const s = stateWords(r);
  li.append(span(s.text, s.tone), ". ");
  li.append(node(restoreLink(r)), ".");
  return li;
}

function capsRows(table: HTMLElement | null, caps: NonNullable<MineAnswer["caps"]>) {
  const body = table?.querySelector("tbody");
  if (!table || !body) return;
  const words: Record<string, string> = {
    actions: "Authorized actions of every kind",
    creations: "Repositories created",
    links: "Repositories linked",
  };
  body.replaceChildren(
    ...Object.keys(words).map((k) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = words[k];
      const used = document.createElement("td");
      used.className = "num";
      used.textContent = String(caps.used[k] ?? 0);
      const limit = document.createElement("td");
      limit.className = "num";
      limit.textContent = String(caps.limits[k] ?? "");
      tr.append(th, used, limit);
      return tr;
    }),
  );
  table.removeAttribute("hidden");
}

function page() {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const message = byId("repos-message");
  const list = byId("repos-list");
  const more = byId<HTMLButtonElement>("repos-more");
  const form = byId<HTMLFormElement>("repos-filter");
  let count = 0;
  let next: string | null = null;

  const filters = () => ({
    mode: byId<HTMLSelectElement>("repos-mode")?.value ?? "",
    template: byId<HTMLSelectElement>("repos-template")?.value ?? "",
  });

  const signedOut = () => {
    byId("repos-signed-in")?.setAttribute("hidden", "");
    byId("repos-signed-out")?.removeAttribute("hidden");
  };

  async function load(after: string | null) {
    // The guard: no hint cookie, no request.
    if (!shouldAsk(document.cookie)) return signedOut();
    if (more) more.disabled = true;
    let answer: MineAnswer;
    let status = 0;
    try {
      const res = await fetch(mineUrl(filters(), after), { credentials: "same-origin", headers: { Accept: "application/json" } });
      status = res.status;
      answer = (await res.json()) as MineAnswer;
    } catch {
      return write(message, "warning", "The registry could not be reached. Please try again in a moment.");
    }
    if (status === 401) return signedOut();
    if (answer.error) return write(message, "warning", answer.error.message);
    byId("repos-signed-out")?.setAttribute("hidden", "");
    byId("repos-signed-in")?.removeAttribute("hidden");
    write(message, "");
    if (answer.github === null) {
      byId("repos-no-github")?.removeAttribute("hidden");
      form?.setAttribute("hidden", "");
      return;
    }
    write(byId("repos-login"), "", { strong: answer.github });
    if (after === null) {
      list?.replaceChildren();
      count = 0;
      const pending = answer.pending ?? [];
      const pendingList = byId("repos-pending-list");
      pendingList?.replaceChildren(...pending.map(pendingItem));
      if (pending.length) byId("repos-pending")?.removeAttribute("hidden");
      else byId("repos-pending")?.setAttribute("hidden", "");
      if (answer.caps) capsRows(byId("repos-caps"), answer.caps);
      if (answer.open === false) byId("repos-closed")?.removeAttribute("hidden");
    }
    for (const r of answer.repositories) if (list) entry(list, r, ++count);
    const empty = byId("repos-empty");
    if (count === 0) empty?.removeAttribute("hidden");
    else empty?.setAttribute("hidden", "");
    next = answer.next;
    if (more) {
      more.disabled = false;
      if (next) more.removeAttribute("hidden");
      else more.setAttribute("hidden", "");
    }
  }

  form?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void load(null);
  });
  more?.addEventListener("click", () => {
    if (next) void load(next);
  });
  void load(null);
}

if (typeof document !== "undefined") page();
