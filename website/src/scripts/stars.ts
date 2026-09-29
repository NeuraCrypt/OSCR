// /stars/: the reader's stars and star lists (night phase 08, E5; docs/SOCIAL.md "Stars"). The
// registry's own (it never stars on GitHub): repositories, papers, topics; searched, sorted and
// filtered in the browser; lists public or private (32 at most), proposed as a collection, exported as
// references (BibTeX, RIS) in the browser. One request to read (GET /api/forge/social/mine), one per
// change (2 rows). Like every browser script, it never names the platform.

import { bibtex, ris, subjectHref, subjectKind, subjectWords, type RefItem } from "../lib/social.ts";
import { el } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn } from "./social-client.ts";

const root = document.getElementById("stars-shell");

interface Star {
  subject: string;
  kind: string;
  label: string;
  at: number;
}
interface List {
  id: number;
  name: string;
  description: string;
  public: boolean;
  collection: string;
  items: string[];
}

const COLLECTION_WORDS: Record<string, string> = {
  "": "",
  proposed: "Proposed as a collection: the registry's owner decides.",
  accepted: "A collection on the Explore page.",
  declined: "Not taken as a collection.",
};

function download(name: string, text: string, type: string): HTMLAnchorElement {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }, name);
  return a;
}

async function main(): Promise<void> {
  if (!root) return;
  if (!signedIn()) {
    root.replaceChildren(el("h1", {}, "Your stars"), el("p", {}, "Sign in to star repositories, papers and topics, and gather them into lists you can export as references. ", el("a", { href: "/account/" }, "Sign in")));
    return;
  }
  const got = await getJson("/api/forge/social/mine");
  if (!got.ok) {
    root.replaceChildren(el("h1", {}, "Your stars"), el("p", { class: "warning" }, problemOf(got.body)));
    return;
  }
  const stars = (got.body.stars ?? []) as Star[];
  const lists = (got.body.lists ?? []) as List[];
  const can = !!(got.body.can as { write?: boolean } | undefined)?.write;
  const said = el("p", { class: "said", "aria-live": "polite" });
  const labelOf = (s: string) => stars.find((x) => x.subject === s)?.label ?? "";
  const refs = (items: string[]): RefItem[] => items.map((s) => ({ subject: s, name: subjectKind(s) === "repository" ? labelOf(s) : undefined, title: subjectKind(s) === "paper" ? labelOf(s) : undefined }));

  // The stars: search, sort, filter.
  const search = el("input", { type: "search", "aria-label": "Search your stars", placeholder: "Search your stars" });
  const sort = el("select", { "aria-label": "Sort" }, el("option", { value: "recent" }, "Recently starred"), el("option", { value: "name" }, "Name"));
  const kind = el("select", { "aria-label": "What" }, el("option", { value: "" }, "Everything"), el("option", { value: "repository" }, "Repositories"), el("option", { value: "paper" }, "Papers"), el("option", { value: "topic" }, "Topics"));
  const listBox = el("ul", { class: "stars" });
  const drawStars = () => {
    const words = search.value.trim().toLowerCase();
    const shown = stars
      .filter((s) => !kind.value || subjectKind(s.subject) === kind.value)
      .filter((s) => !words || `${s.label} ${s.subject}`.toLowerCase().includes(words))
      .sort((a, b) => (sort.value === "name" ? subjectWords(a.subject, a.label).localeCompare(subjectWords(b.subject, b.label)) : b.at - a.at));
    listBox.replaceChildren(
      ...shown.map((s) => {
        const href = subjectHref(s.subject, s.label);
        const words = subjectWords(s.subject, s.label);
        const off = el("button", { type: "button" }, "Unstar");
        off.addEventListener("click", async () => {
          const r = await postJson("/api/forge/social/star", { subject: s.subject, on: false });
          if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
          stars.splice(stars.indexOf(s), 1);
          for (const l of lists) l.items = l.items.filter((x) => x !== s.subject);
          drawStars();
          drawLists();
        });
        const inLists = lists.filter((l) => l.items.includes(s.subject)).map((l) => l.name);
        return el(
          "li",
          {},
          href ? el("a", { href }, words) : words,
          ` · ${subjectKind(s.subject)} · starred ${new Date(s.at * 1000).toISOString().slice(0, 10)}`,
          inLists.length ? ` · in ${inLists.join(", ")}` : "",
          " ",
          off,
        );
      }),
    );
    if (!shown.length) listBox.replaceChildren(el("li", {}, stars.length ? "None matches." : "No star yet: star a repository, a paper or a topic from its page."));
  };
  for (const c of [search, sort, kind]) c.addEventListener(c === search ? "input" : "change", drawStars);

  // The lists.
  const listsBox = el("div", {});
  const drawLists = () => {
    listsBox.replaceChildren(
      ...lists.map((l) => {
        const items = el("ul", {}, ...l.items.map((s) => {
          const href = subjectHref(s, labelOf(s));
          const words = subjectWords(s, labelOf(s));
          return el("li", {}, href ? el("a", { href }, words) : words);
        }));
        const del = el("button", { type: "button" }, "Delete");
        del.addEventListener("click", async () => {
          const r = await postJson("/api/forge/social/list", { op: "delete", id: l.id });
          if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
          lists.splice(lists.indexOf(l), 1);
          drawLists();
        });
        const vis = el("button", { type: "button" }, l.public ? "Make private" : "Make public");
        vis.addEventListener("click", async () => {
          const r = await postJson("/api/forge/social/list", { op: "edit", id: l.id, public: !l.public });
          if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
          l.public = !l.public;
          if (!l.public) l.collection = "";
          drawLists();
        });
        const propose = el("button", { type: "button" }, l.collection === "proposed" || l.collection === "accepted" ? "Withdraw as a collection" : "Propose as a collection");
        propose.addEventListener("click", async () => {
          const on = !(l.collection === "proposed" || l.collection === "accepted");
          const r = await postJson("/api/forge/social/list", { op: "propose", id: l.id, propose: on });
          if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
          l.collection = String(r.body.collection ?? (on ? "proposed" : ""));
          drawLists();
        });
        const origin = location.origin;
        const slug = l.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || `list-${l.id}`;
        return el(
          "section",
          { class: "star-list" },
          el("h3", {}, l.name, el("span", { class: "list-state" }, l.public ? " public" : " private")),
          l.description ? el("p", {}, l.description) : "",
          COLLECTION_WORDS[l.collection] ? el("p", { class: "explain" }, COLLECTION_WORDS[l.collection]) : "",
          l.items.length ? items : el("p", { class: "explain" }, "Empty: add to it from a star's page (Lists)."),
          el("p", {}, "Export as references: ", download(`${slug}.bib`, bibtex(refs(l.items), origin), "application/x-bibtex"), " · ", download(`${slug}.ris`, ris(refs(l.items), origin), "application/x-research-info-systems")),
          el("p", { class: "list-actions" }, vis, " ", l.public ? propose : "", " ", del),
        );
      }),
    );
    if (!lists.length) listsBox.replaceChildren(el("p", { class: "explain" }, "No list yet."));
  };
  const name = el("input", { type: "text", maxlength: "32", "aria-label": "The new list's name", placeholder: "Name" });
  const description = el("input", { type: "text", maxlength: "160", "aria-label": "Its description", placeholder: "Description (optional)" });
  const isPublic = el("input", { type: "checkbox", id: "new-list-public" });
  isPublic.checked = true;
  const create = el("form", { class: "list-form" }, name, " ", description, " ", el("label", { for: "new-list-public" }, isPublic, " Public"), " ", el("button", { type: "submit" }, "Create a list"));
  create.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await postJson("/api/forge/social/list", { op: "create", name: name.value, description: description.value, public: isPublic.checked });
    if (!r.ok) return void said.replaceChildren(el("span", { class: "warning" }, problemOf(r.body)));
    lists.push({ id: Number(r.body.id), name: name.value.trim(), description: description.value.trim(), public: isPublic.checked, collection: "", items: [] });
    name.value = "";
    description.value = "";
    drawLists();
  });
  root.replaceChildren(
    el("h1", {}, "Your stars"),
    el("p", { class: "summary" }, `${stars.length} ${stars.length === 1 ? "star" : "stars"}, ${lists.length} ${lists.length === 1 ? "list" : "lists"}. Stars are the registry's own: nothing is starred on GitHub.`),
    can ? "" : el("p", { class: "explain" }, "Until the registry opens with its content rules, only its owner may star and make lists; you can read yours."),
    el("p", { class: "star-filters" }, search, " ", sort, " ", kind),
    said,
    listBox,
    el("h2", { id: "lists" }, "Lists"),
    create,
    listsBox,
  );
  drawStars();
  drawLists();
}

void main();
