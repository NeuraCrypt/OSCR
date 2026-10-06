// /feed/: the reader's dashboard (night phase 08, E5; docs/SOCIAL.md "Feed"): what the people, authors
// (by ORCID iD, even before they have an account), organizations, repositories and papers they follow
// did in the last 14 days, from the registry's own events (GET /api/forge/social/feed, 1 request), and
// the new papers of the authors they follow, from the catalogue (static shards). "See less like this"
// hides a kind of event (the settings: 1 row). Like every browser script, it never names the platform.

import { el } from "./pull-common.ts";
import { authorPapers, getJson, postJson, problemOf, signedIn } from "./social-client.ts";
import { sitePath, targetHref, targetWords } from "../lib/social.ts";

const root = document.getElementById("feed-shell");

interface Item {
  at: number;
  kind: string;
  words: string;
  title: string;
  url: string;
  actor: string;
  about: string;
  via: string;
}

async function main(): Promise<void> {
  if (!root) return;
  if (!signedIn()) {
    root.replaceChildren(
      el("h1", {}, "Your feed"),
      el("p", {}, "Sign in to follow people, authors (by their ORCID iD), organizations, repositories and papers: what they do reaches your feed. ", el("a", { href: "/account/" }, "Sign in")),
      el("p", {}, "Meanwhile, ", el("a", { href: "/explore/" }, "Explore"), " shows what the registry's readers star and follow this week."),
    );
    return;
  }
  const feed = await getJson("/api/forge/social/feed");
  if (!feed.ok) {
    root.replaceChildren(el("h1", {}, "Your feed"), el("p", { class: "warning" }, problemOf(feed.body)));
    return;
  }
  const settings = (feed.body.settings ?? {}) as { feedHide?: string[] };
  const hide = new Set(settings.feedHide ?? []);
  const items = ((feed.body.items ?? []) as Item[]).filter((i) => !hide.has(i.kind));
  const follows = ((feed.body.follows ?? []) as { target: string; label: string; level: string }[]).filter((f) => !f.target.startsWith("thread:") && f.level !== "ignore");
  // The catalogue's papers of the authors followed by ORCID iD, the last 14 days' first.
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const authors = follows.filter((f) => f.target.startsWith("orcid:")).slice(0, 30);
  const papers = (await Promise.all(authors.map(async (f) => (await authorPapers(f.target.slice(6))).filter((p) => p.date >= since).map((p) => ({ ...p, who: f.label || f.target.slice(6) }))))).flat();
  const said = el("p", { class: "said", "aria-live": "polite" });
  const less = (kind: string) => {
    const b = el("button", { type: "button" }, "See less like this");
    b.addEventListener("click", async () => {
      const next = [...hide, kind];
      const r = await postJson("/api/forge/social/notices", { op: "settings", settings: { ...settings, feedHide: next } });
      if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
      hide.add(kind);
      for (const li of root.querySelectorAll(`li[data-kind="${kind}"]`)) li.remove();
      said.textContent = "Hidden from your feed.";
    });
    return b;
  };
  const list = el(
    "ul",
    { class: "feed" },
    ...items.map((i) =>
      el(
        "li",
        { "data-kind": i.kind },
        `${new Date(i.at * 1000).toISOString().slice(0, 10)} · `,
        i.actor ? el("strong", {}, i.actor) : "",
        ` ${i.words} `,
        sitePath(i.url) ? el("a", { href: sitePath(i.url)! }, i.title || i.about) : i.title || i.about,
        i.title && i.about ? ` · ${i.about}` : "",
        " ",
        less(i.kind),
      ),
    ),
  );
  root.replaceChildren(
    el("h1", {}, "Your feed"),
    el("p", { class: "summary" }, `The last ${Number(feed.body.days ?? 14)} days of what you follow: ${follows.length} people, authors, organizations, repositories and papers. `, el("a", { href: "/notifications/" }, "Your notifications"), " · ", el("a", { href: "/stars/" }, "your stars"), " · ", el("a", { href: "/explore/" }, "Explore")),
    said,
    items.length ? list : el("p", {}, "Nothing new yet: follow people and authors from their pages, watch repositories and papers from theirs."),
    papers.length ? el("h2", {}, "New papers of the authors you follow") : "",
    papers.length ? el("ul", {}, ...papers.map((p) => el("li", {}, `${p.date} · ${p.who}: `, el("a", { href: `/paper/${p.slug}/` }, p.title)))) : "",
    el("h2", {}, "What you follow"),
    follows.length ? el("ul", {}, ...follows.map((f) => {
      const href = targetHref(f.target, f.label);
      const words = targetWords(f.target, f.label);
      return el("li", {}, href ? el("a", { href }, words) : words);
    })) : el("p", { class: "explain" }, "Nothing yet."),
    hide.size ? el("p", { class: "explain" }, `Hidden from your feed: ${[...hide].join(", ").replace(/_/g, " ")}.`) : "",
  );
}

void main();
