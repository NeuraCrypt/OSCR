// Star, Watch and Follow (night phase 08, E5): the registry's own, never GitHub's (OSCR never stars or
// follows on GitHub). Mounted on the repository pages (repo-shell.ts), a paper's page and an author's
// page (any element with data-social: data-subject, data-target, data-label, data-watch = repository |
// paper | person). The counts are last night's (the static shard: a signed-out reader asks the Worker
// nothing); signed in, the reader's own state (1 request) and each change (1 request, 2 rows). Until
// the GitHub side opens (FORGE_OPEN), only the registry's owner may change them: the page says so.

import { LEVEL_WORDS } from "../lib/social.ts";
import { el } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn, socialEntry, type Json } from "./social-client.ts";

export interface SocialItem {
  subject?: string;
  target?: string;
  label: string;
  watch?: "repository" | "paper" | "person";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** The buttons of one subject, in `box` (a div.social-actions). */
export async function mountSocial(box: HTMLElement, item: SocialItem): Promise<void> {
  box.classList.add("social-actions");
  const said = el("span", { class: "said", "aria-live": "polite" });
  const entry = (item.subject ? await socialEntry(item.subject) : null) ?? (item.target ? await socialEntry(item.target.startsWith("orcid:") ? `person:${item.target.slice(6)}` : item.target) : null);
  let stars = Number((entry?.stars as number | undefined) ?? 0);
  const watchers = Number((entry?.watchers as number | undefined) ?? 0);
  const followers = Number((entry?.followers as number | undefined) ?? 0);
  if (!signedIn()) {
    const parts: (Node | string)[] = [];
    if (item.subject) parts.push(`${plural(stars, "star")}`);
    if (item.watch === "repository" || item.watch === "paper") parts.push(`${plural(watchers, "watcher")}`);
    if (item.watch === "person") parts.push(`${plural(followers, "follower")}`);
    box.replaceChildren(el("span", {}, `${parts.join(" · ")} (as of last night). `), el("a", { href: "/account/" }, "Sign in"), " to star, watch or follow here.");
    return;
  }
  const asked = [item.subject, item.target].filter((x): x is string => !!x);
  const got = await getJson(`/api/forge/social?${asked.map((s) => `s=${encodeURIComponent(s)}`).join("&")}`);
  if (!got.ok) {
    box.replaceChildren(el("span", { class: "warning" }, problemOf(got.body)));
    return;
  }
  const subjects = (got.body.subjects ?? {}) as Record<string, { starred: boolean; lists: number[]; follow: { level: string; events: string[] } | null }>;
  const lists = (got.body.lists ?? []) as { id: number; name: string; public: boolean }[];
  const can = !!(got.body.can as Json | undefined)?.write;
  let starred = item.subject ? !!subjects[item.subject]?.starred : false;
  let follow = item.target ? (subjects[item.target]?.follow ?? null) : null;
  const inLists = new Set(item.subject ? (subjects[item.subject]?.lists ?? []) : []);
  const nodes: Node[] = [];
  if (item.subject) {
    const star = el("button", { type: "button", "aria-pressed": String(starred) });
    const draw = () => {
      star.textContent = starred ? `Unstar (${plural(stars, "star")})` : `Star (${plural(stars, "star")})`;
      star.setAttribute("aria-pressed", String(starred));
    };
    draw();
    star.addEventListener("click", async () => {
      star.disabled = true;
      const r = await postJson("/api/forge/social/star", { subject: item.subject, label: item.label, on: !starred });
      star.disabled = false;
      if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
      if (!r.body.unchanged) stars += starred ? -1 : 1;
      starred = !starred;
      draw();
      said.textContent = starred ? "Starred." : "Unstarred.";
    });
    nodes.push(star);
    if (lists.length) {
      const details = el("details", { class: "lists-menu" }, el("summary", {}, "Lists"));
      for (const l of lists) {
        const box2 = el("input", { type: "checkbox", id: `list-${l.id}` });
        (box2 as HTMLInputElement).checked = inLists.has(l.id);
        box2.addEventListener("change", async () => {
          const on = (box2 as HTMLInputElement).checked;
          const r = await postJson("/api/forge/social/list", { op: on ? "add" : "remove", id: l.id, subject: item.subject, label: item.label });
          if (!r.ok) {
            (box2 as HTMLInputElement).checked = !on;
            return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
          }
          if (on && !starred) {
            starred = true;
            stars += 1;
          }
          said.textContent = on ? `Added to ${l.name}.` : `Taken out of ${l.name}.`;
        });
        details.append(el("p", {}, box2, " ", el("label", { for: `list-${l.id}` }, `${l.name}${l.public ? "" : " (private)"}`)));
      }
      nodes.push(details);
    }
  }
  if (item.target && (item.watch === "repository" || item.watch === "paper")) {
    const levels = item.watch === "repository" ? ["", "participating", "all", "custom", "ignore"] : ["", "all"];
    const select = el("select", { "aria-label": item.watch === "repository" ? "Watch this repository" : "Watch this paper" });
    for (const l of levels) {
      const o = el("option", { value: l }, l === "" ? "Not watching" : LEVEL_WORDS[l]);
      if ((follow?.level ?? "") === l) (o as HTMLOptionElement).selected = true;
      select.append(o);
    }
    const custom = el("fieldset", { class: "choices custom-watch" }, el("legend", {}, "Tell me about"));
    const kinds: [string, string][] = [["issues", "Issues"], ["pulls", "Pull requests"], ["releases", "Releases"], ["research", "Research issues"]];
    for (const [k, words] of kinds) {
      const c = el("input", { type: "checkbox", id: `watch-${k}`, value: k });
      (c as HTMLInputElement).checked = follow?.level === "custom" && (follow.events ?? []).includes(k);
      custom.append(el("label", { for: `watch-${k}` }, c, ` ${words}`));
    }
    const apply = el("button", { type: "button" }, "Save");
    custom.append(apply);
    custom.hidden = (follow?.level ?? "") !== "custom";
    const save = async (level: string) => {
      const events = [...custom.querySelectorAll("input:checked")].map((x) => (x as HTMLInputElement).value);
      if (level === "custom" && !events.length) return void said.replaceChildren(el("span", { class: "warning" }, "Pick what to be told about."));
      const r = await postJson("/api/forge/social/follow", level ? { target: item.target, label: item.label, level, events, on: true } : { target: item.target, on: false });
      if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
      follow = level ? { level, events } : null;
      said.textContent = level ? `Watching: ${LEVEL_WORDS[level].toLowerCase()}. Notifications stay in this site: no email is ever sent.` : "Not watching.";
    };
    select.addEventListener("change", () => {
      const level = (select as HTMLSelectElement).value;
      custom.hidden = level !== "custom";
      if (level !== "custom") void save(level);
    });
    apply.addEventListener("click", () => void save("custom"));
    nodes.push(el("span", {}, `${plural(watchers, "watcher")}: `), select, custom);
  }
  if (item.target && item.watch === "person") {
    const button = el("button", { type: "button", "aria-pressed": String(!!follow) });
    let n = followers;
    const draw = () => {
      button.textContent = follow ? `Unfollow (${plural(n, "follower")})` : `Follow (${plural(n, "follower")})`;
      button.setAttribute("aria-pressed", String(!!follow));
    };
    draw();
    button.addEventListener("click", async () => {
      const r = await postJson("/api/forge/social/follow", follow ? { target: item.target, on: false } : { target: item.target, label: item.label, on: true });
      if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
      if (!r.body.unchanged) n += follow ? -1 : 1;
      follow = follow ? null : { level: "all", events: [] };
      draw();
      said.textContent = follow ? "Following: their activity reaches your feed." : "Not following.";
    });
    nodes.push(button);
  }
  if (!can) nodes.push(el("span", { class: "explain" }, " The registry opens stars, watching and following to everyone with its content rules; until then, only its owner can change them."));
  box.replaceChildren(...nodes, " ", said);
}

/** Every element of the page that asks for the buttons (data-social). */
export function mountAll(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-social]")) {
    const d = node.dataset;
    if (!d.subject && !d.target) continue;
    void mountSocial(node, { subject: d.subject || undefined, target: d.target || undefined, label: d.label ?? "", watch: (d.watch as SocialItem["watch"]) || undefined });
  }
}

if (typeof document !== "undefined") mountAll();
