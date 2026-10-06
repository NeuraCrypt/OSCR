// The snippets' shell (night phase 13; docs/SNIPPETS.md): /snippets/ (discover), /snippets/new (the
// create form), /snippets/?owner=<login> (a person's snippets), /snippet/<owner>/<folder>/ and
// /snippets/?id=<n> (one snippet). Snippets are the registry's own gists (D00-6): a few lines of code,
// their files in a folder of the person's `snippets` GitHub repository, read in the registry's own
// reader and discussed here.
//
// Read: signed in, live (GET /api/forge/snippets). Written: the record's native routes (edit, comment,
// star) and the authorized commits (snippet_create, snippet_revise, snippet_fork, through the one
// authorized action: confirmAction). Every text is a text node, masked for addresses by `el`; the
// files are shown by the registry's reader (/r/…/blob/…), never copied here. Like every browser
// script, it never names the platform.

import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import { confirmAction, el, signedInHint, signInLine, whoIsHere } from "./pull-common.ts";
import type { FileMeta, Passage, SnippetCommentView, SnippetView, Visibility } from "../../worker/forge/service/snippets-core.ts";

interface Summary {
  id: number; owner: string; folder: string; title: string; visibility: Visibility; files: number;
  languages: string[]; stars: number; comments: number; forks: number; paper: boolean; author: string;
  author_via: "github" | "orcid" | "name"; updated_at: number;
}
interface OneRead {
  snippet: SnippetView & { mine: boolean };
  comments: (SnippetCommentView & { mine: boolean })[];
  stargazers: { starrer: string; starrer_via: string; at: number }[];
  starred: boolean;
  can: { write: boolean; comment: boolean; edit: boolean; star: boolean; fork: boolean; triage: boolean };
}

const shell = document.getElementById("snippets-shell") as HTMLElement | null;

function summary(line: string): void {
  const p = shell?.querySelector(".summary");
  if (p) p.textContent = line;
}

async function post(path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const who = await whoIsHere();
  if ("message" in who) return { ok: false, status: 0, body: { error: { message: who.message } } };
  try {
    const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": who.csrf }, body: JSON.stringify(payload) });
    return { ok: res.ok, status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, body: { error: { message: "The registry could not be reached." } } };
  }
}

const problemOf = (body: Record<string, unknown>): string => {
  const e = body.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message : "The registry did not take it.";
};

async function read(query: string): Promise<Record<string, unknown> | { problem: string; status: number }> {
  if (!signedInHint()) return { problem: "Sign in with GitHub to read and act on snippets here.", status: 0 };
  try {
    const res = await fetch(`/api/forge/snippets${query}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if (!res.ok) return { problem: problemOf(body), status: res.status };
    return body;
  } catch {
    return { problem: "The registry could not be reached.", status: 0 };
  }
}

const dayOf = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10);
const visWords = (v: Visibility): string => (v === "unlisted" ? "unlisted" : "public");

/** A snippet's own page in the registry. */
const snippetHref = (owner: string, folder: string): string => `/snippet/${owner.toLowerCase()}/${folder.toLowerCase()}/`;
/** A file in the registry's reader, at the pinned revision. */
const fileHref = (owner: string, folder: string, revision: string, path: string): string =>
  `/r/${owner.toLowerCase()}/snippets/blob/${revision}/${encodeURIComponent(folder)}/${path.split("/").map(encodeURIComponent).join("/")}`;

// ─── render: a list (discover, or a person's) ─────────────────────────────────

function renderList(title: string, list: Summary[], extra?: Node): void {
  if (!shell) return;
  const items = list.map((s) =>
    el("dd", { class: "snippet-row" },
      el("a", { class: "title", href: snippetHref(s.owner, s.folder) }, s.title),
      el("span", { class: "line" },
        el("span", { class: "label" }, `${s.owner} · `),
        s.languages.length ? el("span", {}, s.languages.join(", ") + " · ") : null,
        el("span", {}, `${s.files} ${s.files === 1 ? "file" : "files"} · ★ ${s.stars} · ${s.comments} ${s.comments === 1 ? "comment" : "comments"} · ⑂ ${s.forks}`),
        s.visibility === "unlisted" ? el("span", { class: "warning" }, " · unlisted") : null,
        s.paper ? el("span", { class: "ok" }, " · tied to a paper") : null,
      ),
    ),
  );
  shell.replaceChildren(
    el("h1", {}, title),
    el("p", {}, el("a", { href: "/snippets/new" }, "New snippet"), " · ", el("a", { href: "/snippets/" }, "Discover")),
    extra ?? document.createTextNode(""),
    list.length ? el("dl", { class: "listing" }, ...items) : el("p", {}, "No snippets yet."),
  );
}

// ─── render: one snippet ──────────────────────────────────────────────────────

function passageLine(p: Passage): Node {
  const doi = p.paperId.replace(/^doi:/, "");
  const where = [p.section && `§ ${p.section}`, p.paragraph && `paragraph ${p.paragraph}`, p.startLine && (p.endLine && p.endLine !== p.startLine ? `lines ${p.startLine}-${p.endLine}` : `line ${p.startLine}`)].filter(Boolean).join(", ");
  return el("div", { class: "line" },
    el("span", { class: "label" }, "Paper passage: "),
    el("a", { href: `https://doi.org/${doi}`, rel: "noopener" }, doi),
    where ? el("span", {}, ` (${where})`) : null,
  );
}

function fileList(s: SnippetView): Node {
  return el("ul", {},
    ...s.files.map((f: FileMeta) =>
      el("li", {},
        el("a", { href: fileHref(s.owner, s.folder, s.revision, f.path) }, f.path),
        el("span", { class: "muted" }, ` — ${f.language || "text"}, ${f.lines} ${f.lines === 1 ? "line" : "lines"}, ${f.size} bytes`),
      ),
    ),
  );
}

function commentsBlock(r: OneRead): Node {
  const list = r.comments.map((c) =>
    el("li", { class: "comment" + (c.hidden ? " warning" : "") },
      el("span", { class: "label" }, `${c.author} · ${dayOf(c.created_at)}${c.edited_at ? " (edited)" : ""}${c.hidden ? ` · hidden (${c.hidden})` : ""}: `),
      el("span", {}, c.deleted ? "(deleted)" : c.body),
    ),
  );
  return el("div", { class: "comments" },
    el("h3", {}, `Comments (${r.comments.length})`),
    r.comments.length ? el("ol", {}, ...list) : el("p", {}, "No comments yet."),
  );
}

function renderSnippet(r: OneRead): void {
  if (!shell) return;
  const s = r.snippet;
  const side = el("aside", { class: "sidebar" },
    el("h3", {}, "About"),
    el("ul", {},
      el("li", {}, `By ${s.author}`),
      el("li", {}, `★ ${s.stars} stars`),
      el("li", {}, `⑂ ${s.forks} forks`),
      el("li", {}, `${visWords(s.visibility)}`),
      s.forkedFrom ? el("li", {}, el("a", { href: `/snippets/?id=${s.forkedFrom}` }, `Forked from #${s.forkedFrom}`)) : null,
    ),
    el("p", {}, "Cite: ", el("code", {}, citation(s))),
  );
  const actions = el("div", { class: "snippet-actions" });
  const body = el("div", { class: "body" },
    el("h1", {}, s.title),
    s.visibility === "unlisted" ? el("p", { class: "warning" }, "Unlisted: it is not in discover, search or feeds, but anyone with the link, or browsing the repository, can read it.") : null,
    s.hidden ? el("p", { class: "warning" }, `Hidden (${s.hidden}).`) : null,
    s.description ? el("p", {}, s.description) : null,
    s.passage ? passageLine(s.passage) : null,
    el("h3", {}, "Files"),
    fileList(s),
    actions,
    commentsBlock(r),
    r.can.comment ? commentForm(s.id) : (r.can.write ? null : signInLine("Sign in with GitHub to comment.")),
  );
  mountActions(actions, r);
  shell.replaceChildren(
    el("p", {}, el("a", { href: "/snippets/" }, "← Discover"), " · ", el("a", { href: `/snippets/?owner=${s.owner}` }, `${s.owner}'s snippets`)),
    el("div", { class: "record" }, body, side),
  );
}

function citation(s: SnippetView): string {
  const where = typeof location !== "undefined" ? location.origin : "";
  return `${s.author}. “${s.title}”. ${where}${snippetHref(s.owner, s.folder)} (rev ${s.revision.slice(0, 7)}).`;
}

function mountActions(box: HTMLElement, r: OneRead): void {
  const s = r.snippet;
  const kids: Node[] = [];
  if (r.can.star) {
    const star = el("button", { type: "button" }, r.starred ? "Unstar" : "Star");
    star.addEventListener("click", async () => {
      star.disabled = true;
      const res = await post("/api/forge/snippets/star", { id: s.id, on: !r.starred });
      star.disabled = false;
      if (res.ok) { r.starred = !r.starred; star.textContent = r.starred ? "Unstar" : "Star"; }
    });
    kids.push(star);
  }
  if (r.can.fork) {
    const forkBox = el("span", {});
    const fork = el("button", { type: "button" }, "Fork");
    fork.addEventListener("click", () => void confirmAction(forkBox, { input: { kind: "snippet_fork", repo: null, payload: { id: s.id }, back: location.pathname }, sentence: `Fork the snippet “${s.title}” into your snippets repository` }));
    kids.push(fork, forkBox);
  }
  if (r.can.edit) kids.push(editControls(s));
  if (r.can.triage && !s.mine) kids.push(hideControl(s));
  box.replaceChildren(...kids);
}

function editControls(s: SnippetView): Node {
  const said = el("span", {});
  const kids: Node[] = [];
  if (s.visibility === "unlisted") {
    const pub = el("button", { type: "button" }, "Make public");
    pub.addEventListener("click", async () => { const r = await post("/api/forge/snippets/edit", { id: s.id, visibility: "public" }); said.textContent = r.ok ? "Now public." : problemOf(r.body); if (r.ok) location.reload(); });
    kids.push(pub);
  }
  const toggle = el("button", { type: "button" }, s.commentsOff ? "Turn comments on" : "Turn comments off");
  toggle.addEventListener("click", async () => { const r = await post("/api/forge/snippets/edit", { id: s.id, commentsOff: !s.commentsOff }); said.textContent = r.ok ? "Done." : problemOf(r.body); if (r.ok) location.reload(); });
  kids.push(toggle, said);
  return el("span", { class: "owner-actions" }, ...kids);
}

function hideControl(s: SnippetView): Node {
  const said = el("span", {});
  const hide = el("button", { type: "button" }, s.hidden ? "Show again" : "Hide");
  hide.addEventListener("click", async () => { const r = await post("/api/forge/snippets/edit", { id: s.id, hide: s.hidden ? "" : "off-topic" }); said.textContent = r.ok ? "Done." : problemOf(r.body); if (r.ok) location.reload(); });
  return el("span", {}, hide, said);
}

function commentForm(id: number): Node {
  const said = el("p", { class: "summary", "aria-live": "polite" });
  const text = el("textarea", { rows: "3", "aria-label": "Your comment" }) as HTMLTextAreaElement;
  const send = el("button", { type: "submit" }, "Comment");
  const form = el("form", {}, el("h3", {}, "Add a comment"), text, el("div", {}, send), said);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    const turnstile = await humanToken(send);
    if (turnstile === null) return void (said.textContent = HUMAN_WAIT);
    const r = await post("/api/forge/snippets/comment", { id, body: text.value, turnstile });
    if (r.ok) location.reload();
    else said.textContent = problemOf(r.body);
  });
  return form;
}

// ─── render: the create form ──────────────────────────────────────────────────

function newForm(): void {
  if (!shell) return;
  const confirm = el("div", {});
  const title = el("input", { type: "text", "aria-label": "Title", maxlength: "200" }) as HTMLInputElement;
  const description = el("textarea", { rows: "2", "aria-label": "Description" }) as HTMLTextAreaElement;
  const vis = el("select", { "aria-label": "Visibility" }, el("option", { value: "public" }, "Public"), el("option", { value: "unlisted" }, "Unlisted")) as HTMLSelectElement;
  const files = el("div", {});
  const addFileRow = (): void => {
    const name = el("input", { type: "text", "aria-label": "File name", placeholder: "filter.py" }) as HTMLInputElement;
    const content = el("textarea", { rows: "6", "aria-label": "File content", spellcheck: "false" }) as HTMLTextAreaElement;
    files.appendChild(el("div", { class: "snippet-file" }, name, content));
  };
  addFileRow();
  const add = el("button", { type: "button" }, "Add a file");
  add.addEventListener("click", addFileRow);
  const paperId = el("input", { type: "text", "aria-label": "Paper DOI (optional)", placeholder: "doi:10.…" }) as HTMLInputElement;
  const section = el("input", { type: "text", "aria-label": "Paper section (optional)", placeholder: "Methods" }) as HTMLInputElement;
  const submit = el("button", { type: "submit" }, "Prepare the snippet");
  const form = el("form", {},
    el("h1", {}, "New snippet"),
    el("p", {}, el("label", {}, "Title ", title)),
    el("p", {}, el("label", {}, "Description ", description)),
    el("p", {}, el("label", {}, "Visibility ", vis), el("span", { class: "muted" }, " Unlisted keeps it out of lists, search and feeds, but anyone with the link, or browsing your repository, can read it. You can make it public later, never unlisted again.")),
    el("h3", {}, "Files"), files, el("p", {}, add),
    el("h3", {}, "Tie it to a paper (optional)"),
    el("p", {}, el("label", {}, "DOI ", paperId), " ", el("label", {}, "Section ", section)),
    el("p", {}, submit),
    confirm,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const fs = [...files.querySelectorAll(".snippet-file")].map((d) => {
      const [n, c] = [d.querySelector("input") as HTMLInputElement, d.querySelector("textarea") as HTMLTextAreaElement];
      return { path: n.value.trim(), content: c.value };
    }).filter((f) => f.path && f.content);
    if (!title.value.trim()) return void confirm.replaceChildren(el("p", { class: "warning" }, "Give the snippet a title."));
    if (!fs.length) return void confirm.replaceChildren(el("p", { class: "warning" }, "Add at least one file with a name and content."));
    const payload: Record<string, unknown> = { title: title.value.trim(), description: description.value, visibility: vis.value, files: fs };
    if (paperId.value.trim()) payload.passage = { paperId: paperId.value.trim(), section: section.value.trim() };
    void confirmAction(confirm, { input: { kind: "snippet_create", repo: null, payload, back: "/snippets/" }, sentence: `Create the ${vis.value} snippet “${title.value.trim()}” in your snippets repository (${fs.length} ${fs.length === 1 ? "file" : "files"})` }, { drafts: fs.map((f) => f.content) });
  });
  shell.replaceChildren(form);
}

// ─── routing ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!shell) return;
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  if (!signedInHint()) {
    shell.querySelector(".summary")?.replaceWith(signInLine("Sign in with GitHub to read and share snippets."));
    return;
  }
  // One snippet: /snippet/<owner>/<folder>/ or /snippets/?id=<n>.
  const one = /^\/snippet\/([^/]+)\/([^/]+)\/?$/.exec(path);
  if (one || params.has("id")) {
    summary("Reading the snippet…");
    const query = params.has("id") ? `?id=${encodeURIComponent(params.get("id") ?? "")}` : `?owner=${encodeURIComponent(one![1])}&folder=${encodeURIComponent(one![2])}`;
    const body = await read(query);
    if ("problem" in body) return void summary(body.problem);
    return renderSnippet(body as unknown as OneRead);
  }
  // The create form.
  if (/\/snippets\/new\/?$/.test(path)) return newForm();
  // A person's snippets.
  if (params.has("owner")) {
    summary("Reading…");
    const body = await read(`?owner=${encodeURIComponent(params.get("owner") ?? "")}`);
    if ("problem" in body) return void summary(body.problem);
    return renderList(`${params.get("owner")}'s snippets`, (body.snippets as Summary[]) ?? []);
  }
  // Discover.
  summary("Reading…");
  const body = await read("");
  if ("problem" in body) return void summary(body.problem);
  renderList("Snippets", (body.snippets as Summary[]) ?? []);
}

void main();
