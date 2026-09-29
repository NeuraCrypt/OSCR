// /explore/: discovery (night phase 08, E5; docs/SOCIAL.md "Explore"): what the registry's readers
// starred and followed this week (trending repositories, papers, people), the topics (curated first,
// with their aliases; ?topic=<name> for one topic), and the collections (public star lists the owner
// accepted). All from last night's static file /social/explore.json: 0 Worker requests; a topic's star
// button asks the Worker only for a signed-in reader. Like every browser script, it never names the
// platform.

import { EXPLORE_URL, personUrl, subjectHref, subjectWords } from "../lib/social.ts";
import { el } from "./pull-common.ts";
import { mountSocial } from "./social-buttons.ts";

const root = document.getElementById("explore-shell");

interface Explore {
  generated_at: number;
  days: number;
  repositories: { subject: string; name: string; stars: number; week: number }[];
  papers: { subject: string; doi: string; title: string; stars: number; week: number }[];
  people: { handle: string; week: number }[];
  topics: { name: string; description: string; featured: boolean; stars: number; aliases: string[] }[];
  collections: { name: string; description: string; by: string; items: { subject: string; name: string }[] }[];
}

async function main(): Promise<void> {
  if (!root) return;
  let data: Explore | null = null;
  try {
    const res = await fetch(EXPLORE_URL, { headers: { Accept: "application/json" } });
    data = res.ok ? ((await res.json()) as Explore) : null;
  } catch {
    data = null;
  }
  const topic = new URLSearchParams(location.search).get("topic");
  if (topic && /^[a-z0-9][a-z0-9-]{0,49}$/.test(topic)) {
    const t = data?.topics.find((x) => x.name === topic || x.aliases.includes(topic));
    const name = t?.name ?? topic;
    const star = el("div", {});
    root.replaceChildren(
      el("p", {}, el("a", { href: "/explore/" }, "Explore"), " › Topics"),
      el("h1", {}, name),
      t?.description ? el("p", { class: "summary" }, t.description) : el("p", { class: "summary" }, "A topic of the registry's readers."),
      t?.aliases.length ? el("p", { class: "explain" }, `Also called: ${t.aliases.join(", ")}.`) : "",
      star,
      el("p", {}, el("a", { href: `/search/?type=repositories&q=${encodeURIComponent(name.replace(/-/g, " "))}` }, `Repositories about ${name}`), " · ", el("a", { href: `/search/?q=${encodeURIComponent(name.replace(/-/g, " "))}` }, `Papers about ${name}`)),
    );
    void mountSocial(star, { subject: `topic:${name}`, label: name });
    return;
  }
  const when = data?.generated_at ? new Date(data.generated_at * 1000).toISOString().slice(0, 10) : null;
  const section = (title: string, id: string, nodes: (Node | string)[], empty: string) => [el("h2", { id }, title), nodes.length ? el("ol", { class: "results" }, ...nodes) : el("p", { class: "explain" }, empty)];
  root.replaceChildren(
    el("h1", {}, "Explore"),
    el("p", { class: "summary" }, `What the registry's readers star and follow${data ? `, in the ${data.days} days before ${when}` : ""}. Stars and follows are the registry's own, never GitHub's.`),
    ...section(
      "Trending repositories",
      "repositories",
      (data?.repositories ?? []).map((r) => el("li", {}, el("a", { href: `/r/${r.name}/` }, r.name), ` · ${r.week} new ${r.week === 1 ? "star" : "stars"} this week, ${r.stars} in all`)),
      "No repository was starred this week.",
    ),
    ...section(
      "Trending papers",
      "papers",
      (data?.papers ?? []).map((p) => el("li", {}, el("a", { href: subjectHref(p.subject) ?? "/" }, p.title || `doi:${p.doi}`), ` · ${p.week} new ${p.week === 1 ? "star" : "stars"} this week`)),
      "No paper was starred this week.",
    ),
    ...section(
      "People followed this week",
      "people",
      (data?.people ?? []).map((p) => el("li", {}, el("a", { href: personUrl(p.handle) }, p.handle), ` · ${p.week} new ${p.week === 1 ? "follower" : "followers"}`)),
      "Nobody was followed this week.",
    ),
    el("h2", { id: "topics" }, "Topics"),
    (data?.topics ?? []).length
      ? el("ul", { class: "topics" }, ...(data?.topics ?? []).map((t) => el("li", {}, el("a", { href: `/explore/?topic=${t.name}` }, t.name), t.featured ? " · curated" : "", t.stars ? ` · ${t.stars} ${t.stars === 1 ? "star" : "stars"}` : "", t.description ? el("p", { class: "line" }, t.description) : "")))
      : el("p", { class: "explain" }, "The topics are published with the registry's nightly files."),
    el("h2", { id: "collections" }, "Collections"),
    (data?.collections ?? []).length
      ? el("div", {}, ...(data?.collections ?? []).map((c) => el("section", { class: "star-list" }, el("h3", {}, c.name), el("p", { class: "explain" }, "Gathered by ", el("a", { href: personUrl(c.by) }, c.by), c.description ? `: ${c.description}` : ""), el("ul", {}, ...c.items.map((i) => {
          const href = subjectHref(i.subject, i.name);
          return el("li", {}, href ? el("a", { href }, i.name || subjectWords(i.subject)) : i.name || subjectWords(i.subject));
        })))))
      : el("p", { class: "explain" }, "No collection yet: a public star list can be proposed as one from your Stars page; the registry's owner decides."),
    el("h2", { id: "more" }, "Elsewhere in the registry"),
    el("p", {}, el("a", { href: "/research/" }, "Research issues"), " to help with · ", el("a", { href: "/browse/" }, "Browse the catalogue"), " · ", el("a", { href: "/feed/" }, "Your feed")),
  );
}

void main();
