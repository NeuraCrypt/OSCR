// /u/<GitHub login or ORCID iD>/: a person's profile (night phase 08, E5; docs/SOCIAL.md "Profiles"),
// ONE shell for everyone (public/_redirects "/u/* /u/ 200": no file per person). Signed out: last
// night's static shard (0 Worker requests); signed in: live (GET /api/forge/social/person, and their
// activity). The profile README is the person's <login>/<login> repository's README, read from GitHub
// in the reader's browser (raw files: not counted in the reader's quota) and rendered by the
// registry's own Markdown renderer. The picture is an identicon of cells, never an image from
// elsewhere. Milestones are said in words; the calendar counts contributions made in the registry,
// with the person's publications from the catalogue. Like every browser script, it never names the
// platform.

import { renderMarkdown } from "../lib/markdown.ts";
import { githubEndpoints, h, type El } from "../lib/repo-view.ts";
import {
  calendar,
  calendarView,
  hueOf,
  identiconCells,
  identiconView,
  parsePersonPath,
  personUrl,
  sitePath,
  subjectHref,
  subjectWords,
  targetHref,
  targetWords,
} from "../lib/social.ts";
import { show, toDom } from "./dom.ts";
import { el } from "./pull-common.ts";
import { mountSocial } from "./social-buttons.ts";
import { authorPapers, getJson, postJson, problemOf, signedIn, socialEntry, type Json } from "./social-client.ts";

const root = document.getElementById("profile-shell");
const endpoints = githubEndpoints({ api: root?.dataset.githubApi ?? null, raw: root?.dataset.githubRaw ?? null });
const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

interface Profile {
  name?: string;
  bio?: string;
  pronouns?: string;
  location?: string;
  timezone?: string;
  website?: string;
  links?: string[];
  company?: string;
  pinned?: string[];
  status?: string;
  busy?: boolean;
  private?: boolean;
  readme?: boolean;
}

interface Person {
  account: boolean;
  me: boolean;
  handles: { github: string | null; githubId?: string | null; orcid: string | null };
  profile: Profile | null;
  private: boolean;
  lists: { id: number; name: string; description: string; items: string[] }[];
  stars: string[];
  follows: string[];
  followers: number | null;
  following: number | null;
  live: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The person as last night's shard says (signed out, or before the live answer). */
async function fromShard(handle: string): Promise<Person | null> {
  const e = await socialEntry(`person:${handle}`);
  if (!e) return null;
  const hs = (e.handles ?? {}) as { github?: string | null; orcid?: string | null };
  return {
    account: e.account !== false,
    me: false,
    handles: { github: hs.github ?? (ORCID.test(handle) ? null : handle), orcid: hs.orcid ?? (ORCID.test(handle) ? handle : null) },
    profile: (e.profile as Profile | undefined) ?? null,
    private: e.private === true,
    lists: Array.isArray(e.lists) ? (e.lists as Person["lists"]) : [],
    stars: Array.isArray(e.stars) ? (e.stars as string[]) : [],
    follows: Array.isArray(e.follows) ? (e.follows as string[]) : [],
    followers: typeof e.followers === "number" ? e.followers : 0,
    following: typeof e.following === "number" ? e.following : null,
    live: false,
  };
}

/** A GitHub login's numeric id, from GitHub on the reader's quota (the registry names people by it). */
async function githubIdOf(login: string): Promise<string | null> {
  try {
    const res = await fetch(`${endpoints.api}/users/${encodeURIComponent(login)}`, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) return null;
    const id = ((await res.json()) as { id?: unknown }).id;
    return typeof id === "number" ? String(id) : null;
  } catch {
    return null;
  }
}

async function live(handle: string): Promise<{ person: Person | null; githubId: string | null; problem?: string }> {
  const githubId = ORCID.test(handle) ? null : await githubIdOf(handle);
  const path = ORCID.test(handle) ? `/api/forge/social/person?orcid=${handle}` : githubId ? `/api/forge/social/person?github=${githubId}` : null;
  if (!path) return { person: null, githubId };
  const got = await getJson(path);
  if (!got.ok) return { person: null, githubId, problem: problemOf(got.body) };
  const b = got.body;
  const hs = (b.handles ?? {}) as Person["handles"];
  return {
    githubId: hs.githubId ?? githubId,
    person: {
      account: b.account === true,
      me: b.me === true,
      handles: { github: hs.github ?? null, githubId: hs.githubId ?? githubId, orcid: hs.orcid ?? (ORCID.test(handle) ? handle : null) },
      profile: (b.profile as Profile | undefined) ?? null,
      private: (b.profile as Profile | undefined)?.private === true && b.me !== true,
      lists: Array.isArray(b.lists) ? (b.lists as Person["lists"]) : [],
      stars: Array.isArray(b.stars) ? (b.stars as { subject: string }[]).map((s) => s.subject) : [],
      follows: Array.isArray(b.follows) ? (b.follows as { target: string }[]).map((f) => f.target) : [],
      followers: null,
      following: null,
      live: true,
    },
  };
}

/** The registry's names of repositories and papers (last night's shard: "owner/name", the title). */
async function namesOf(subjects: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(subjects)].filter((s) => s.startsWith("repo:") || s.startsWith("paper:")).slice(0, 120).map(async (s) => {
      const e = await socialEntry(s);
      if (e && typeof e.name === "string" && e.name) out.set(s, e.name);
    }),
  );
  return out;
}

async function readme(login: string): Promise<El | null> {
  try {
    const res = await fetch(`${endpoints.raw}/${encodeURIComponent(login)}/${encodeURIComponent(login)}/HEAD/README.md`, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 200_000);
    return (await renderMarkdown(text, { repo: { forge: "github", owner: login, name: login } as never })).el;
  } catch {
    return null;
  }
}

function editForm(p: Profile, said: HTMLElement): HTMLElement {
  const field = (id: string, label: string, value: string, max: number) =>
    el("p", { class: "line" }, el("label", { for: `pf-${id}` }, label), " ", el("input", { type: "text", id: `pf-${id}`, value, maxlength: String(max) }));
  const check = (id: string, label: string, on: boolean) => {
    const c = el("input", { type: "checkbox", id: `pf-${id}` });
    c.checked = on;
    return el("p", {}, c, " ", el("label", { for: `pf-${id}` }, label));
  };
  const form = el(
    "form",
    { class: "profile-form" },
    field("name", "Name", p.name ?? "", 100),
    field("bio", "Bio", p.bio ?? "", 300),
    field("pronouns", "Pronouns", p.pronouns ?? "", 40),
    field("company", "Company or lab", p.company ?? "", 100),
    field("location", "Location", p.location ?? "", 100),
    field("timezone", "Time zone (IANA: Europe/Paris)", p.timezone ?? "", 64),
    field("website", "Website (https)", p.website ?? "", 200),
    field("links", "Other links (https, separated by spaces, 4 at most)", (p.links ?? []).join(" "), 900),
    field("pinned", "Pinned (repo:github:<id>, paper:<DOI>, topic:<name>, list:<n>; 6 at most)", (p.pinned ?? []).join(" "), 1500),
    field("status", "Status", p.status ?? "", 80),
    check("busy", "Busy: others see that you may answer late", !!p.busy),
    check("readme", "Show my profile README (the README of my <login>/<login> repository on GitHub)", p.readme !== false),
    check("private", "Private profile: my activity, stars, lists and follows are mine only", !!p.private),
    el("p", { class: "explain" }, "No email address is asked for or shown; an address typed in a text is hidden."),
    el("button", { type: "submit" }, "Save the profile"),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = (id: string) => (form.querySelector(`#pf-${id}`) as HTMLInputElement).value.trim();
    const c = (id: string) => (form.querySelector(`#pf-${id}`) as HTMLInputElement).checked;
    const r = await postJson("/api/forge/social/profile", {
      name: v("name"), bio: v("bio"), pronouns: v("pronouns"), company: v("company"), location: v("location"), timezone: v("timezone"),
      website: v("website"), links: v("links").split(/\s+/).filter(Boolean), pinned: v("pinned").split(/\s+/).filter(Boolean), status: v("status"),
      busy: c("busy"), readme: c("readme"), private: c("private"),
    });
    said.replaceChildren(r.ok ? "Profile saved." : el("span", { class: "warning" }, problemOf(r.body)));
    if (r.ok) setTimeout(() => location.reload(), 400);
  });
  return el("details", { class: "panel" }, el("summary", {}, "Edit your profile"), form);
}

async function main(): Promise<void> {
  if (!root) return;
  const handle = parsePersonPath(location.pathname);
  if (!handle) {
    show(root, h("h1", null, "Person"), h("p", { class: "warning" }, "This address names nobody: it reads /u/<GitHub login>/ or /u/<ORCID iD>/."));
    return;
  }
  let person = await fromShard(handle);
  let githubId: string | null = null;
  let problem = "";
  if (signedIn()) {
    const got = await live(handle);
    githubId = got.githubId;
    if (got.person) person = got.person;
    if (got.problem) problem = got.problem;
  }
  const orcid = person?.handles.orcid ?? (ORCID.test(handle) ? handle : null);
  const login = person?.handles.github ?? (ORCID.test(handle) ? null : handle);
  const p = person?.profile ?? null;
  document.title = `${p?.name || handle}${document.title.includes(" — ") ? document.title.slice(document.title.indexOf(" — ")) : ""}`;
  const said = el("p", { class: "said", "aria-live": "polite" });
  const head = el("div", { class: "profile-head" });
  head.append(toDom(identiconView(await identiconCells(handle), hueOf(handle))));
  head.append(
    el(
      "div",
      {},
      el("h1", {}, p?.name || handle),
      el("p", { class: "handles" }, login ? `${login}` : "", login && orcid ? " · " : "", orcid ? el("a", { href: `https://orcid.org/${orcid}` }, `ORCID iD ${orcid}`) : "", p?.pronouns ? ` · ${p.pronouns}` : ""),
      p?.status ? el("p", { class: "status" }, p.busy ? "Busy · " : "", p.status) : "",
    ),
  );
  const follow = el("div", {});
  const blocks: (Node | string)[] = [head, follow, said];
  const names = await namesOf([...(p?.pinned ?? []), ...(person?.stars ?? []).slice(0, 100), ...(person?.lists ?? []).flatMap((l) => l.items)]);
  const item = (s: string) => {
    const href = subjectHref(s, names.get(s));
    const words = subjectWords(s, names.get(s));
    return el("li", {}, href ? el("a", { href }, words) : words);
  };
  if (problem) blocks.push(el("p", { class: "warning" }, problem));
  if (!person) {
    blocks.push(el("p", {}, orcid ? "This author has no account in the registry yet: follow them by their ORCID iD, and their activity reaches your feed once they sign in." : "Nothing is known of this person in the registry yet (as of last night)."));
  }
  if (person?.private) blocks.push(el("p", { class: "explain" }, "This profile is private: its activity, stars, lists and follows are its owner's only."));
  if (p) {
    const facts: (Node | string)[] = [];
    if (p.bio) facts.push(el("p", { class: "bio" }, p.bio));
    const line = [p.company, p.location, p.timezone].filter(Boolean).join(" · ");
    if (line) facts.push(el("p", {}, line));
    const links = [p.website, ...(p.links ?? [])].filter((x): x is string => typeof x === "string" && /^https:\/\/[^\s@/\\]+\.[^\s@/\\]+(?:\/[^\s@\\]*)?$/.test(x));
    if (links.length) facts.push(el("p", {}, ...links.flatMap((u, i) => [i ? " · " : "", el("a", { href: u, rel: "nofollow ugc" }, u.replace(/^https:\/\//, ""))])));
    blocks.push(...facts);
  }
  if (person && (person.followers !== null || person.following !== null)) blocks.push(el("p", { class: "summary" }, `${person.followers ?? 0} followers${person.following !== null ? ` · following ${person.following}` : ""} (as of last night)`));
  if (person?.me && p) blocks.push(editForm(p, said));
  else if (person?.me) blocks.push(editForm({}, said));
  // Pinned.
  if (p?.pinned?.length) {
    blocks.push(el("h2", {}, "Pinned"), el("ul", { class: "pinned" }, ...p.pinned.map((s) => {
      if (s.startsWith("list:")) {
        const l = person?.lists.find((x) => `list:${x.id}` === s);
        return el("li", {}, l ? `The list ${l.name}` : "A list");
      }
      return item(s);
    })));
  }
  // The profile README.
  const readmeBox = el("section", { class: "readme markdown-body" });
  readmeBox.hidden = true;
  blocks.push(readmeBox);
  // Milestones, the calendar, the timeline.
  const activity = el("section", { class: "activity" });
  blocks.push(activity);
  // Lists, stars, follows.
  if (person && !person.private) {
    if (person.lists.length) {
      blocks.push(el("h2", {}, "Lists"), ...person.lists.map((l) => el("section", { class: "star-list" }, el("h3", {}, l.name), l.description ? el("p", {}, l.description) : "", el("ul", {}, ...l.items.map(item)))));
    }
    if (person.stars.length) {
      blocks.push(el("h2", {}, "Stars"), el("ul", { class: "stars" }, ...person.stars.slice(0, 100).map(item)));
    }
    if (person.follows.length) {
      blocks.push(el("h2", {}, "Follows"), el("ul", {}, ...person.follows.map((t) => {
        const label = t.startsWith("person:") ? t.slice(7) : "";
        const href = t.startsWith("person:") ? personUrl(label) : targetHref(t);
        const words = t.startsWith("person:") ? label : targetWords(t);
        return el("li", {}, href ? el("a", { href }, words) : words);
      })));
    }
  }
  root.replaceChildren(...blocks);
  // Follow: by GitHub account when there is one, else by ORCID iD.
  const target = githubId ? `github:${githubId}` : orcid ? `orcid:${orcid}` : null;
  if (target && !person?.me) void mountSocial(follow, { target, label: login ?? orcid ?? handle, watch: "person" });
  if (login && p?.readme !== false && !person?.private) {
    void readme(login).then((r) => {
      if (!r) return;
      readmeBox.replaceChildren(el("h2", { class: "readme-name" }, `${login}/README.md`), toDom(r));
      readmeBox.hidden = false;
    });
  }
  // The publications of the catalogue, by ORCID iD, and the registry's contributions (signed in).
  const papers = orcid ? await authorPapers(orcid) : [];
  let counts: Record<string, number> = {};
  let milestones: { words: string }[] = [];
  let timeline: { at: number; words: string; title: string; url: string; about: string }[] = [];
  if (signedIn() && person?.account && !person.private) {
    const q = githubId ? `github=${githubId}` : orcid ? `orcid=${orcid}` : "";
    if (q) {
      const got = await getJson(`/api/forge/social/activity?${q}`);
      if (got.ok) {
        counts = (got.body.calendar ?? {}) as Record<string, number>;
        milestones = (got.body.milestones ?? []) as { words: string }[];
        timeline = (got.body.timeline ?? []) as typeof timeline;
      }
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const cal = calendar(counts, papers.map((x) => x.date), today);
  const nodes: (Node | string)[] = [];
  if (milestones.length || papers.length) {
    nodes.push(el("h2", {}, "Milestones"), el("ul", { class: "milestones" }, ...milestones.map((m) => el("li", {}, m.words)), papers.length ? el("li", {}, `${papers.length} ${papers.length === 1 ? "paper" : "papers"} in the catalogue, the latest ${papers[0].date}`) : ""));
  }
  // Nothing to show for someone the registry knows only by an ORCID iD, with no paper in the catalogue.
  if (person?.account === false || (!person && !papers.length)) {
    if (!papers.length) return void activity.replaceChildren(...nodes);
  }
  nodes.push(
    el("h2", {}, "Contributions"),
    el("p", { class: "summary" }, `${cal.total} contributions in the registry and ${cal.published} papers published in the last year${signedIn() ? "" : " (sign in to see the contributions)"}.`),
    el("div", { class: "calendar-scroll" }, toDom(calendarView(cal))),
    el("p", { class: "explain" }, "A darker cell: more contributions that day (issues, pull requests, reviews, releases, research issues made in the registry); a dot: a paper published."),
  );
  if (timeline.length) {
    nodes.push(el("h2", {}, "Activity"), el("ul", { class: "timeline" }, ...timeline.slice(0, 50).map((x) => el("li", {}, `${new Date(x.at * 1000).toISOString().slice(0, 10)} · ${x.words} `, sitePath(x.url) ? el("a", { href: sitePath(x.url)! }, x.title || x.about) : x.title || x.about))));
  }
  if (papers.length) {
    nodes.push(el("h2", {}, "Papers"), el("ul", {}, ...papers.slice(0, 50).map((x) => el("li", {}, el("a", { href: `/paper/${x.slug}/` }, x.title), x.date ? ` · ${x.date}` : ""))));
  }
  activity.replaceChildren(...nodes);
}

void main();
export type { Json };
