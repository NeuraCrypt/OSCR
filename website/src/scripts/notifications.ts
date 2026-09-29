// /notifications/: the in-site inbox (night phase 08, E5; docs/SOCIAL.md "Notifications"). In the site
// only: no email is ever sent, no address asked (the owner's decision D5). One request a view (GET
// /api/forge/social/inbox, computed from what the reader watches and follows); the views (Inbox,
// Unread, Saved, Done, Read) and GitHub's filters (repo:, org:, author:, is:, reason:) apply in the
// browser; each change is one request (POST /api/forge/social/notices: 1 row a thread, ≤ 25 at once).
// Like every browser script, it never names the platform.

import { h, type El } from "../lib/repo-view.ts";
import { groupThreads, inView, LEVEL_WORDS, matchesThread, parseInboxQuery, sitePath, targetHref, targetWords, VIEW_WORDS, VIEWS, type Thread, type View } from "../lib/social.ts";
import { show, toDom } from "./dom.ts";
import { el } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn, type Json } from "./social-client.ts";

const root = document.getElementById("notifications-shell");
const params = new URLSearchParams(location.search);
const view: View = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "inbox";
let q = (params.get("q") ?? "").trim();

interface Inbox {
  threads: Thread[];
  partial: boolean;
  subjects: number;
  settings: { participating?: boolean; watching?: boolean; filters?: { name: string; q: string }[] };
  retentionDays: number;
  can: { write: boolean };
}

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const addr = (v: View, query = q) => {
  const p = new URLSearchParams();
  if (v !== "inbox") p.set("view", v);
  if (query) p.set("q", query);
  const s = p.toString();
  return s ? `/notifications/?${s}` : "/notifications/";
};

function viewsBar(inbox: Inbox): El {
  const unread = inbox.threads.filter((t) => inView(t, "unread")).length;
  return h("nav", { class: "tabs", "aria-label": "Views" }, h("ul", null, VIEWS.map((v) => h("li", null, h("a", { href: addr(v), "aria-current": v === view ? "page" : null }, VIEW_WORDS[v], v === "unread" && unread ? ` ${unread}` : "")))));
}

async function change(op: string, threads: Thread[], said: HTMLElement): Promise<boolean> {
  const r = await postJson("/api/forge/social/notices", { op, threads: threads.map((t) => ({ key: t.key, title: t.title || t.words, url: t.url })) });
  if (!r.ok) {
    said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
    return false;
  }
  return true;
}

function threadRow(t: Thread, selected: Set<string>, redraw: () => void, said: HTMLElement): HTMLElement {
  const pick = el("input", { type: "checkbox", "aria-label": `Select ${t.title || t.words}` });
  (pick as HTMLInputElement).checked = selected.has(t.key);
  pick.addEventListener("change", () => ((pick as HTMLInputElement).checked ? selected.add(t.key) : selected.delete(t.key)));
  // Only a path of this site: the registry shows everything; a thread's address is its own page here.
  const url = sitePath(t.url) ?? "/notifications/";
  const title = el("a", { href: url }, t.title || t.words);
  // Opening a thread marks it read (one request), then goes there.
  title.addEventListener("click", async (ev) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || !t.unread) return;
    ev.preventDefault();
    await change("read", [t], said);
    location.href = url;
  });
  const act = (label: string, op: string, apply: () => void) => {
    const b = el("button", { type: "button" }, label);
    b.addEventListener("click", async () => {
      if (await change(op, [t], said)) {
        apply();
        redraw();
      }
    });
    return b;
  };
  const buttons = [
    t.unread ? act("Mark as read", "read", () => (t.unread = false)) : act("Mark as unread", "unread", () => (t.unread = true)),
    t.done ? act("Move to Inbox", "undone", () => (t.done = false)) : act("Done", "done", () => ((t.done = true), (t.unread = false))),
    t.saved ? act("Unsave", "unsave", () => (t.saved = false)) : act("Save", "save", () => (t.saved = true)),
    t.expired ? null : act("Unsubscribe", "unsubscribe", () => ((t.done = true), (t.unread = false))),
  ].filter((b): b is HTMLButtonElement => !!b);
  return el(
    "li",
    { class: `notice${t.unread ? " unread" : ""}` },
    pick,
    " ",
    t.unread ? el("strong", {}, title) : title,
    el("span", { class: "notice-what" }, ` ${t.words}`),
    el(
      "p",
      { class: "line" },
      t.expired ? "Saved; its activity is past the 3 months kept." : `${t.latest.actor ? `${t.latest.actor} ` : ""}${t.latest.words}${t.count > 1 ? ` (${t.count} events)` : ""} · ${dayOf(t.latest.at)} · ${t.reasonWords}`,
    ),
    el("p", { class: "notice-actions" }, ...buttons.flatMap((b, i) => (i ? [" ", b] : [b]))),
  );
}

async function watching(box: HTMLElement): Promise<void> {
  const got = await getJson("/api/forge/social/mine");
  if (!got.ok) return;
  const follows = ((got.body.follows ?? []) as { target: string; level: string; label: string; auto: boolean }[]).filter((f) => !f.target.startsWith("thread:"));
  const threads = ((got.body.follows ?? []) as { target: string; level: string; label: string }[]).filter((f) => f.target.startsWith("thread:"));
  const list = el("ul", { class: "watching" });
  for (const f of follows) {
    const href = targetHref(f.target, f.label);
    const stop = el("button", { type: "button" }, f.target.startsWith("repo:") || f.target.startsWith("paper:") ? "Unwatch" : "Unfollow");
    stop.addEventListener("click", async () => {
      const r = await postJson("/api/forge/social/follow", { target: f.target, on: false });
      if (r.ok) stop.closest("li")?.remove();
    });
    const words = targetWords(f.target, f.label);
    list.append(el("li", {}, href ? el("a", { href }, words) : words, f.target.startsWith("repo:") ? ` · ${LEVEL_WORDS[f.level] ?? f.level}` : "", " ", stop));
  }
  box.replaceChildren(
    el("h2", { id: "watching" }, "What you watch and follow"),
    follows.length ? list : el("p", {}, "Nothing yet: watch a repository or a paper from its page, follow a person or an author from theirs."),
    el("p", { class: "explain" }, `${threads.filter((t) => t.level !== "ignore").length} conversations followed because you took part in them; ${threads.filter((t) => t.level === "ignore").length} unsubscribed.`),
  );
}

function settingsBox(inbox: Inbox, said: HTMLElement): HTMLElement {
  const s = inbox.settings;
  const box = el("section", { class: "notice-settings" }, el("h2", { id: "settings" }, "Settings"));
  const toggle = (key: "participating" | "watching", words: string) => {
    const c = el("input", { type: "checkbox", id: `set-${key}` });
    (c as HTMLInputElement).checked = s[key] !== false;
    c.addEventListener("change", async () => {
      const next = { ...s, [key]: (c as HTMLInputElement).checked };
      const r = await postJson("/api/forge/social/notices", { op: "settings", settings: next });
      if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
      s[key] = (c as HTMLInputElement).checked;
      said.textContent = "Settings saved.";
      location.reload();
    });
    return el("p", {}, c, " ", el("label", { for: `set-${key}` }, words));
  };
  box.append(
    toggle("participating", "Show what involves me: conversations I opened or took part in, and where I am @mentioned"),
    toggle("watching", "Show the activity of what I watch: repositories, papers, organizations"),
    el("p", { class: "explain" }, "Notifications stay in this site: no email is ever sent, and no email address is asked for. They are kept 3 months; a saved one stays, with its words."),
  );
  return box;
}

async function main(): Promise<void> {
  if (!root) return;
  if (!signedIn()) {
    show(root, h("h1", null, "Notifications"), h("p", null, "Sign in to read your notifications: what happens on the repositories and papers you watch, the conversations you take part in, where you are mentioned. ", h("a", { href: "/account/" }, "Sign in")), h("p", { class: "explain" }, "They stay in this site: no email is ever sent."));
    return;
  }
  const got = await getJson("/api/forge/social/inbox");
  if (!got.ok) {
    show(root, h("h1", null, "Notifications"), h("p", { class: "warning" }, problemOf(got.body)));
    return;
  }
  const inbox = got.body as unknown as Inbox;
  const said = el("p", { class: "said", "aria-live": "polite" });
  const selected = new Set<string>();
  const listBox = el("div", {});
  const watchBox = el("div", {});
  const filterInput = el("input", { type: "search", name: "q", value: q, "aria-label": "Filter notifications", placeholder: "repo:owner/name is:unread reason:mention" });
  const filterForm = el("form", { class: "notice-filter", role: "search" }, filterInput, " ", el("button", { type: "submit" }, "Filter"));
  filterForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    q = (filterInput as HTMLInputElement).value.trim();
    history.replaceState(null, "", addr(view));
    redraw();
  });
  const saveFilter = el("button", { type: "button" }, "Save this filter");
  saveFilter.addEventListener("click", async () => {
    if (!q) return void (said.textContent = "Type a filter first.");
    const filters = [...(inbox.settings.filters ?? []), { name: q.slice(0, 40), q }].slice(-15);
    const r = await postJson("/api/forge/social/notices", { op: "settings", settings: { ...inbox.settings, filters } });
    if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
    inbox.settings.filters = filters;
    said.textContent = "Filter saved.";
    redraw();
  });
  const bulk = (label: string, op: string, apply: (t: Thread) => void) => {
    const b = el("button", { type: "button" }, label);
    b.addEventListener("click", async () => {
      const chosen = inbox.threads.filter((t) => selected.has(t.key)).slice(0, 25);
      if (!chosen.length) return void (said.textContent = "Select notifications first (25 at a time).");
      if (await change(op, chosen, said)) {
        chosen.forEach(apply);
        selected.clear();
        redraw();
      }
    });
    return b;
  };
  const allRead = el("button", { type: "button" }, "Mark all as read");
  allRead.addEventListener("click", async () => {
    const r = await postJson("/api/forge/social/notices", { op: "all_read" });
    if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
    inbox.threads.forEach((t) => (t.unread = false));
    redraw();
  });
  function redraw(): void {
    const f = parseInboxQuery(q);
    const s = inbox.settings;
    const shown = inbox.threads.filter((t) => inView(t, view) && matchesThread(t, f)).filter((t) => {
      const involves = ["mention", "author", "participating"].includes(t.reason);
      return involves ? s.participating !== false : s.watching !== false;
    });
    const groups = groupThreads(shown);
    listBox.replaceChildren(
      toDom(viewsBar(inbox)),
      filterForm,
      el("p", { class: "notice-filters" }, ...(inbox.settings.filters ?? []).flatMap((x, i) => [i ? " · " : "Your filters: ", el("a", { href: addr(view, x.q) }, x.name)]), (inbox.settings.filters ?? []).length ? " · " : "", saveFilter),
      f.unknown.length ? el("p", { class: "explain" }, `Not understood as filters: ${f.unknown.join(", ")}.`) : "",
      el("p", { class: "notice-bulk" }, bulk("Mark as read", "read", (t) => (t.unread = false)), " ", bulk("Done", "done", (t) => ((t.done = true), (t.unread = false))), " ", bulk("Save", "save", (t) => (t.saved = true)), " ", allRead),
      said,
      shown.length
        ? el("div", {}, ...groups.flatMap((g) => [el("h2", { class: "notice-group" }, g.label), el("ul", { class: "notices" }, ...g.threads.map((t) => threadRow(t, selected, redraw, said)))]))
        : el("p", { class: "summary" }, view === "inbox" && !q ? "All caught up: nothing new in what you watch and take part in." : "No notification here."),
      inbox.partial ? el("p", { class: "explain" }, `The inbox reads the ${inbox.subjects} most recently followed repositories, papers and conversations; older ones are left out until you unwatch some.`) : "",
      inbox.can.write ? "" : el("p", { class: "explain" }, "Until the registry opens with its content rules, only its owner may change notifications' states; you can read yours."),
    );
  }
  root.replaceChildren(toDom(h("h1", null, "Notifications")), listBox, watchBox, settingsBox(inbox, said));
  redraw();
  void watching(watchBox);
}

void main();
export type { Json };
