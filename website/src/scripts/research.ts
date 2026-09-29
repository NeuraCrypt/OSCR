// The research issues' shell (night phase 05, E6; docs/ISSUES.md): /research/<n>, /research/new and
// /research/?paper=<doi>. Research issues are the registry's own (D00-6): a code error, a code–paper
// mismatch (one tracing-map link: the paper's paragraph, the file's lines at a commit), a
// reproduction failure (its report), about a paper's code — a GitHub repository the registry knows,
// or code hosted elsewhere.
//
// Read: signed in, live (GET /api/forge/research, 1 request); signed out, from the nightly static
// shard /forge/research/NN.json (NN = the number mod 64, "as of last night"; 0 Worker requests).
// Written: the registry's own routes (POST /api/forge/research/open, /comment, /edit: 1 request each,
// the session's CSRF token, FORGE_OPEN), and its copy on GitHub as an ordinary issue, the author's
// one authorized action (research_copy).
//
// Everything is text nodes: someone's text is rendered by the registry's own Markdown renderer
// into view trees, "#12" and "research#3" linked, email addresses masked, never HTML, never run.
// Like every browser script, it never names the platform.

import { HUMAN_WAIT, humanToken } from "./human-check.ts";
import type { CommentView, IssueSummary, IssueView, ResearchType, Resolution } from "../../worker/forge/service/research-core.ts";
import { HIDE_REASONS, OUTCOME_WORDS, RESOLUTION_WORDS, RESOLUTIONS_OF, TYPE_WORDS } from "../../worker/forge/service/research-core.ts";
import { answerKey, prefillAnswers, researchForm, researchPayload, RESEARCH_FORMS, type Answers, type FormElement, type IssueTemplate } from "../lib/issue-forms.ts";
import { byline, dayOfSeconds, labelEl, linkRefs, parseComments, parseSummaries, parseView, roleInWords } from "../lib/issue-view.ts";
import { reportHref } from "../lib/moderation.ts";
import { fromResearch, issuePrefillOf, parseResearchPath, researchEventInWords, researchPath, stateInWords } from "../lib/issues.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { declarePull } from "../lib/pull-view.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { confirmAction, el, signedInHint, signInLine, whoIsHere } from "./pull-common.ts";

interface Read {
  issue: IssueView & { mine: boolean };
  comments: (CommentView & { mine: boolean; moderated: string })[];
  can: { write: boolean; comment: boolean; edit: boolean; triage: boolean };
  live: boolean;
}

const NONE = { write: false, comment: false, edit: false, triage: false };

async function post(path: string, payload: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const who = await whoIsHere();
  if ("message" in who) return { ok: false, body: { error: { message: who.message } } };
  try {
    const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": who.csrf }, body: JSON.stringify(payload) });
    return { ok: res.ok, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, body: { error: { message: "The registry could not be reached: check the connection, then try again." } } };
  }
}

const problemOf = (body: Record<string, unknown>): string => {
  const e = body.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message : "The registry did not take it.";
};

/** The nightly shard of an issue: NN = its number mod 64. */
export const shardOf = (id: number): string => `/forge/research/${String(id % 64).padStart(2, "0")}.json`;

async function readIssue(id: number): Promise<Read | { problem: string }> {
  if (signedInHint()) {
    try {
      const res = await fetch(`/api/forge/research?id=${id}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 404) return { problem: `The registry has no research issue #${id}.` };
      // Night phase 16: hidden by moderation, for everyone but its author and the owner.
      if (res.status === 410) return { problem: `Research issue #${id} is hidden by moderation: ${(body.error as { moderation?: { words?: string } } | undefined)?.moderation?.words ?? "it broke the rules"}. See the notices (/notices/).` };
      if (res.ok) {
        const issue = parseView(body.issue);
        if (!issue) return { problem: "The registry's answer is not readable." };
        const can = (body.can ?? {}) as Record<string, unknown>;
        return {
          issue: { ...issue, mine: (body.issue as { mine?: unknown }).mine === true },
          comments: parseComments(body.comments),
          can: { write: can.write === true, comment: can.comment === true, edit: can.edit === true, triage: can.triage === true },
          live: true,
        };
      }
    } catch {
      // the nightly copy below
    }
  }
  try {
    const res = await fetch(shardOf(id), { headers: { Accept: "application/json" } });
    if (res.ok) {
      const shard = (await res.json()) as Record<string, { issue?: unknown; comments?: unknown }>;
      const entry = shard[String(id)];
      const issue = entry ? parseView(entry.issue) : null;
      if (issue) return { issue: { ...issue, mine: false }, comments: parseComments(entry?.comments).map((c) => ({ ...c, mine: false })), can: NONE, live: false };
    }
  } catch {
    // said below
  }
  return { problem: signedInHint() ? `The registry has no research issue #${id}, or could not be reached.` : `Research issue #${id} is not in last night's copy (a newer one, or none of this number): sign in to read it live.` };
}

/** The code an issue is about: the registry's page of the repository and its lines, or the address
 *  elsewhere ("at the source", said). */
function codeLine(i: IssueSummary): El {
  if (i.repo) {
    const [owner, name] = i.repo.path.split("/");
    const base = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/`;
    const a = i.anchor;
    const lines = a?.start ? `#L${a.start}${a.end && a.end !== a.start ? `-L${a.end}` : ""}` : "";
    const file = a?.path ? (a.commit ? `${base}blob/${a.commit}/${a.path.split("/").map(encodeURIComponent).join("/")}${lines}` : null) : null;
    const where = a?.path ? `${a.path}${a.start ? `, lines ${a.start}–${a.end ?? a.start}` : ""}` : "";
    return h(
      "p",
      { class: "summary-line" },
      h("a", { href: base }, i.repo.path),
      a?.path ? [" · ", file ? h("a", { href: file }, where) : where, a.commit ? ` at ${a.commit.slice(0, 7)}` : " (no commit named: the lines may have moved)"] : null,
    );
  }
  const host = (() => {
    try {
      return new URL(i.code_url).host;
    } catch {
      return "";
    }
  })();
  return h("p", { class: "summary-line" }, "Hosted elsewhere: ", i.code_url ? h("a", { href: i.code_url, rel: "noopener noreferrer" }, host || i.code_url) : "not named", i.anchor?.path ? ` · ${i.anchor.path}${i.anchor.start ? `, lines ${i.anchor.start}–${i.anchor.end ?? i.anchor.start}` : ""}` : "", ". Its authors may take issues there too; the registry keeps this one beside the paper.");
}

/** Someone's Markdown, "#12" linked to the issue's repository (when it is on GitHub) and
 *  "research#3" to the research issue. */
async function markdown(text: string, repo: { owner: string; name: string } | null = null): Promise<El> {
  if (!text.trim()) return h("p", { class: "muted-note" }, "No description.");
  return linkRefs((await renderMarkdown(text, repo ? { repo } : {})).el, repo);
}

async function mountIssue(root: HTMLElement, id: number): Promise<void> {
  const read = await readIssue(id);
  if ("problem" in read) {
    show(root, h("h1", null, `research#${id}`), h("p", { class: "warning" }, read.problem));
    return;
  }
  const { issue: i, comments, can, live } = read;
  document.title = `${i.title} · research#${i.id}${document.title.includes(" — ") ? document.title.slice(document.title.indexOf(" — ")) : ""}`;
  const item = fromResearch(i);
  const coords = i.repo ? { owner: i.repo.path.split("/")[0], name: i.repo.path.split("/")[1] } : null;
  const md = (text: string) => markdown(text, coords);
  const parts: El[] = [
    h(
      "div",
      { class: "comment issue-description", id: "issue-body" },
      h("p", { class: "comment-head" }, h("strong", null, byline(i.author, i.author_via)), i.author_role ? h("span", { class: "role" }, ` (${roleInWords(i.author_role)})`) : null, ` opened it on ${dayOfSeconds(i.created_at)}`),
      await md(i.body),
    ),
  ];
  // Comments and events, in time order.
  const timeline: { at: number; el: El }[] = [];
  for (const c of comments) {
    const head = h(
      "p",
      { class: "comment-head" },
      h("strong", null, byline(c.author, c.author_via)),
      c.author_role ? h("span", { class: "role" }, ` (${roleInWords(c.author_role)})`) : null,
      ` commented on ${dayOfSeconds(c.created_at)}${c.edited_at ? " (edited)" : ""}`,
      c.deleted || c.mine ? null : h("span", { class: "muted" }, " · ", h("a", { href: reportHref(`research:${i.id}#${c.n}`, `comment ${c.n} on “${i.title}”`) }, "Report")),
    );
    // Night phase 16: hidden by moderation, its words withheld (its author reads them, with the line).
    const moderated = c.moderated ? h("p", { class: "moderated" }, `Hidden by moderation: ${c.moderated}.`) : null;
    const content = c.deleted
      ? h("p", { class: "muted-note" }, "A deleted comment.")
      : c.moderated && !c.body
        ? moderated
        : c.hidden
          ? h("details", null, h("summary", null, `Hidden as ${c.hidden}: show it`), await md(c.body))
          : c.moderated
            ? h("div", null, moderated, await md(c.body))
            : await md(c.body);
    timeline.push({ at: c.created_at, el: h("div", { class: "comment", id: `comment-${c.n}`, "data-n": String(c.n) }, head, content) });
  }
  for (const e of i.events) timeline.push({ at: e.at, el: h("p", { class: "timeline-event" }, h("strong", null, e.by || "someone"), ` ${researchEventInWords(e)} on ${dayOfSeconds(e.at)}`) });
  timeline.sort((a, b) => a.at - b.at);
  parts.push(...timeline.map((t) => t.el));

  const report = i.report
    ? h(
        "section",
        { class: "task-panel research-report", "aria-label": "The reproduction report" },
        h("h3", null, `The reproduction report: ${OUTCOME_WORDS[i.report.outcome]}`),
        h(
          "dl",
          { class: "settings" },
          ...([
            ["The figure or table", i.report.figure],
            ["The environment", i.report.environment],
            ["The command", i.report.command],
            ["What the paper reports", i.report.expected],
            ["What came out", i.report.observed],
          ] as [string, string][]).filter(([, v]) => v).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, k === "The environment" || k === "The command" ? h("pre", { class: "commands" }, v) : v)]),
          i.report.datasets.length ? [h("dt", null, "The data"), h("dd", null, ...i.report.datasets.flatMap((d, n) => [n ? ", " : "", d.startsWith("doi:") ? h("a", { href: `https://doi.org/${d.slice(4)}`, rel: "noopener noreferrer" }, d) : h("a", { href: d, rel: "noopener noreferrer" }, d)]))] : null,
        ),
        h("p", { class: "explain" }, "The registry runs nothing: this is the reader's own account of what they ran."),
      )
    : null;
  show(
    root,
    h(
      "div",
      { class: "pull-head issue-head" },
      h("h2", null, i.title, " ", h("span", { class: "pull-number" }, `research#${i.id}`)),
      h(
        "p",
        { class: "status-line" },
        h("span", { class: `issue-state${i.state === "open" ? "" : " muted"}` }, stateInWords(item)),
        ` · ${TYPE_WORDS[i.type]} · opened ${dayOfSeconds(i.created_at)} by ${byline(i.author, i.author_via)}`,
        i.locked ? ` · locked${i.lock_reason ? ` as ${i.lock_reason}` : ""}` : "",
        live ? "" : " · as of last night",
        i.mine ? "" : " · ",
        i.mine ? "" : h("a", { href: reportHref(`research:${i.id}`, i.title) }, "Report"),
      ),
    ),
    h(
      "div",
      { class: "record pull-record" },
      h("div", { class: "body" }, h("section", { class: "timeline", "aria-label": "Conversation" }, ...parts), report, h("div", { id: "research-comment" })),
      h(
        "div",
        { class: "sidebar" },
        h("h3", null, "The paper"),
        h("p", { class: "summary-line" }, h("a", { href: `/lookup/?doi=${encodeURIComponent(i.paper.replace(/^doi:/, ""))}` }, i.paper), i.anchor?.paragraph ? `: paragraph ${i.anchor.paragraph}${i.anchor.section ? ` (${i.anchor.section})` : ""}` : ""),
        h("h3", null, "The code"),
        codeLine(i),
        i.resolution ? [h("h3", null, "Resolution"), h("p", { class: "summary-line ok" }, `${RESOLUTION_WORDS[i.resolution]}${i.resolution_ref ? ` (${i.resolution_ref})` : ""}`)] : null,
        i.labels.length ? [h("h3", null, "Labels"), h("p", { class: "summary-line" }, ...i.labels.flatMap((l, n) => [n ? ", " : "", labelEl(l, null)]))] : null,
        i.github_number && i.repo ? [h("h3", null, "On GitHub"), h("p", { class: "summary-line" }, "Copied as ", h("a", { href: `/r/${i.repo.path}/issues/${i.github_number}` }, `the ordinary issue #${i.github_number}`), ".")] : null,
        h("div", { id: "research-actions" }),
      ),
    ),
  );
  const actions = root.querySelector<HTMLElement>("#research-actions") as HTMLElement;
  const form = root.querySelector<HTMLElement>("#research-comment") as HTMLElement;
  if (!signedInHint()) {
    form.replaceChildren(signInLine("Sign in to comment: the paper's authors and the code's maintainers read it here."));
    return;
  }
  if (!live) return;
  wireComments(root, read);
  commentForm(form, read);
  sideActions(actions, read);
}

function button(label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
  const b = el("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
}

async function send(said: HTMLElement, path: string, payload: Record<string, unknown>): Promise<void> {
  said.replaceChildren(el("p", {}, "Sending…"));
  const r = await post(path, payload);
  if (!r.ok) {
    said.replaceChildren(el("p", { class: "warning" }, problemOf(r.body)));
    return;
  }
  location.reload();
}

function wireComments(root: HTMLElement, r: Read): void {
  for (const c of r.comments) {
    const node = root.querySelector<HTMLElement>(`[data-n="${c.n}"]`);
    if (!node || c.deleted) continue;
    const said = el("div", { "aria-live": "polite" });
    const bar = el("p", { class: "comment-actions" });
    if (c.mine) {
      bar.append(
        button("Edit", () => {
          if (node.querySelector(".edit-box")) return;
          const area = el("textarea", { class: "pull-text", rows: "6", "aria-label": "The comment" });
          area.value = c.body;
          node.append(el("div", { class: "edit-box" }, area, el("p", {}, button("Save", () => void send(said, "/api/forge/research/comment", { id: r.issue.id, n: c.n, body: area.value })))));
        }),
        " ",
      );
    }
    if (c.mine || r.can.triage) bar.append(button("Delete", () => void send(said, "/api/forge/research/comment", { id: r.issue.id, n: c.n, delete: true })), " ");
    if (r.can.triage) {
      const why = el("select", { "aria-label": "Hide it as" }, el("option", { value: "" }, c.hidden ? "Show it again" : "Hide it as…"), ...HIDE_REASONS.map((x) => el("option", { value: x }, x)));
      bar.append(why, " ", button(c.hidden ? "Apply" : "Hide", () => void send(said, "/api/forge/research/comment", { id: r.issue.id, n: c.n, hide: why.value })));
    }
    // Night phase 16: block the author of a comment (silent; the reader's page says what it does).
    if (!c.mine && r.live) {
      bar.append(
        button("Block its author", async () => {
          if (!confirm("Block the author of this comment? They will not be able to comment on your research issues or in the repositories you manage, nor follow you, and their activity leaves your notifications. They are not told. Your blocks: /settings/blocked/")) return;
          const res = await post("/api/forge/blocks/write", { target: `research:${r.issue.id}#${c.n}`, on: true });
          said.replaceChildren(el("p", { class: res.ok ? "ok" : "warning" }, res.ok ? "Blocked. Your blocks are on /settings/blocked/." : problemOf(res.body)));
        }),
        " ",
      );
    }
    if (bar.childNodes.length) node.append(bar, said);
  }
}

function commentForm(into: HTMLElement, r: Read): void {
  if (!r.can.write) {
    into.replaceChildren(el("p", { class: "explain" }, "The registry's research issues open to everyone with its content rules; until then, only its owner writes here."));
    return;
  }
  if (!r.can.comment) {
    into.replaceChildren(el("p", { class: "explain" }, "The conversation is locked: the paper's verified authors and the code's maintainers comment now."));
    return;
  }
  const text = el("textarea", { class: "pull-text", id: "comment-text", rows: "6", "aria-label": "Your comment" });
  const said = el("div", { "aria-live": "polite" });
  // Night phase 16: a new comment passes the human check (human-check.ts).
  const sendButton: HTMLButtonElement = button("Comment", async () => {
    const turnstile = await humanToken(sendButton);
    if (turnstile === null) return void said.replaceChildren(el("p", { class: "warning" }, HUMAN_WAIT));
    void send(said, "/api/forge/research/comment", { id: r.issue.id, body: text.value, turnstile });
  }, { class: "primary", id: "comment-send" });
  into.replaceChildren(el("section", { class: "comment-form", "aria-label": "Add a comment" }, el("h3", {}, "Add a comment"), text, el("p", {}, sendButton), said));
}

function sideActions(into: HTMLElement, r: Read): void {
  const i = r.issue;
  const said = el("div", { "aria-live": "polite" });
  const parts: HTMLElement[] = [];
  if (r.can.edit) {
    if (i.state === "open") {
      const resolution = el("select", { "aria-label": "The resolution" }, ...RESOLUTIONS_OF[i.type].map((x) => el("option", { value: x }, RESOLUTION_WORDS[x])));
      const ref = el("input", { type: "text", size: "18", maxlength: "300", placeholder: "a commit, a DOI…", "aria-label": "What settles it" });
      parts.push(
        el("p", {}, "Close: ", resolution, " ", ref, " ", button("Close", () => void send(said, "/api/forge/research/edit", { id: i.id, state: "closed", resolution: resolution.value as Resolution, ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) }))),
        el("p", {}, button("Close as not planned", () => void send(said, "/api/forge/research/edit", { id: i.id, state: "closed", reason: "not_planned" }))),
      );
      const dup = el("input", { type: "text", size: "6", placeholder: "research#", "aria-label": "Duplicate of" });
      parts.push(el("p", {}, "Duplicate of ", dup, " ", button("Close as a duplicate", () => void send(said, "/api/forge/research/edit", { id: i.id, state: "closed", reason: "duplicate", duplicateOf: Number(dup.value.replace(/^research#|^#/, "")) }))));
    } else parts.push(el("p", {}, button("Reopen", () => void send(said, "/api/forge/research/edit", { id: i.id, state: "open" }))));
    const title = el("input", { type: "text", maxlength: "256", "aria-label": "The title" });
    title.value = i.title;
    const area = el("textarea", { class: "pull-text", rows: "5", "aria-label": "The description" });
    area.value = i.body;
    parts.push(el("details", {}, el("summary", {}, "Edit the title and the description"), el("p", {}, title), area, el("p", {}, button("Save", () => void send(said, "/api/forge/research/edit", { id: i.id, ...(title.value !== i.title ? { title: title.value } : {}), ...(area.value !== i.body ? { body: area.value } : {}) })))));
  }
  if (r.can.triage) {
    const label = el("input", { type: "text", size: "14", maxlength: "50", placeholder: "a label", "aria-label": "A label" });
    parts.push(el("p", {}, "Label ", label, " ", button("Add", () => void send(said, "/api/forge/research/edit", { id: i.id, labels: { add: [label.value.trim()] } })), " ", button("Remove", () => void send(said, "/api/forge/research/edit", { id: i.id, labels: { remove: [label.value.trim()] } }))));
    parts.push(el("p", {}, i.locked ? button("Unlock the conversation", () => void send(said, "/api/forge/research/edit", { id: i.id, locked: false })) : button("Lock the conversation", () => void send(said, "/api/forge/research/edit", { id: i.id, locked: true })), " ", button(i.pinned ? "Unpin it" : "Pin it on the paper", () => void send(said, "/api/forge/research/edit", { id: i.id, pinned: !i.pinned }))));
  }
  if (i.mine && i.repo && !i.github_number) {
    const [owner, name] = i.repo.path.split("/");
    const copy = button("Copy it to GitHub", () =>
      void confirmAction(said, declarePull({ owner, name, id: i.repo!.id }, "research_copy", { id: i.id }, researchPath(i.id))),
    );
    parts.push(el("p", {}, copy, el("span", { class: "explain" }, " as an ordinary issue of the repository, with its type's label: one authorization, as you; the research issue stays here and names the copy.")));
  }
  if (!parts.length) return;
  into.replaceChildren(el("h3", {}, "Act"), ...parts, said);
}

// ─── /research/new ───────────────────────────────────────────────────────────

async function fieldDom(e: FormElement, key: string, value: string | string[] | undefined): Promise<HTMLElement> {
  const id = `f-${key}`;
  if (e.type === "markdown") {
    const d = el("div", { class: "form-markdown" });
    d.append(toDom((await renderMarkdown(e.value)).el));
    return d;
  }
  const label = el("label", { for: id }, `${e.label}${e.required ? " (required)" : ""}`);
  const desc = e.description ? el("p", { class: "explain" }, e.description) : "";
  if (e.type === "dropdown") {
    const s = el("select", { id, "data-key": key });
    for (const o of e.options) {
      const opt = el("option", { value: o.label }, o.label);
      opt.selected = Array.isArray(value) ? value.includes(o.label) : value === o.label;
      s.append(opt);
    }
    return el("div", { class: "form-field" }, label, desc, s);
  }
  const input = e.type === "textarea" ? el("textarea", { id, rows: "4", "data-key": key }) : el("input", { type: "text", id, "data-key": key, autocomplete: "off" });
  input.value = typeof value === "string" ? value : "";
  return el("div", { class: "form-field" }, label, desc, input);
}

function answersOf(form: HTMLElement, t: IssueTemplate): Answers {
  const out: Answers = {};
  t.elements.forEach((e, i) => {
    if (e.type === "markdown") return;
    const key = answerKey(e, i);
    const node = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!node) return;
    out[key] = node instanceof HTMLSelectElement ? [...node.selectedOptions].map((o) => o.value) : node.value;
  });
  return out;
}

async function mountNew(root: HTMLElement): Promise<void> {
  const q = new URLSearchParams(location.search);
  const prefill = issuePrefillOf(location.search);
  const type = (["mismatch", "reproduction", "code_error"] as ResearchType[]).find((t) => t === q.get("type")) ?? null;
  // A GitHub repository's research issue is filed in its /r/ page, beside its other issues.
  const repo = prefill.repo && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(prefill.repo) ? prefill.repo : null;
  if (repo && type) {
    const next = new URLSearchParams(location.search);
    next.delete("type");
    next.delete("repo");
    next.set("template", `research:${type}`);
    location.replace(`/r/${repo}/issues/new?${next}`);
    return;
  }
  if (!type) {
    show(
      root,
      h("h1", null, "A new research issue"),
      h("p", null, "About the paper ", prefill.doi ? `doi:${prefill.doi}` : "(named by its DOI)", ":"),
      h("ul", { class: "template-list" }, ...RESEARCH_FORMS.map((f) => h("li", null, h("p", { class: "title" }, h("a", { href: `/research/new?${new URLSearchParams({ ...Object.fromEntries(q), type: f.research as string })}` }, f.name)), h("p", { class: "line" }, f.about)))),
    );
    return;
  }
  const t = researchForm(type);
  const answers = prefillAnswers(t, location.search);
  const doi = el("input", { type: "text", id: "rs-doi", autocomplete: "off", placeholder: "10.…" });
  doi.value = prefill.doi ?? "";
  const code = el("input", { type: "text", id: "rs-code", autocomplete: "off", placeholder: "https://zenodo.org/records/…" });
  code.value = q.get("code") ?? "";
  const title = el("input", { type: "text", id: "issue-title", maxlength: "256", autocomplete: "off" });
  title.value = prefill.title ?? "";
  const fields = el("div", { class: "issue-form-fields" });
  for (const [n, e] of t.elements.entries()) fields.append(await fieldDom(e, answerKey(e, n), answers[answerKey(e, n)]));
  const said = el("div", { "aria-live": "polite" });
  const form = el(
    "section",
    { class: "pull-form issue-form", "aria-label": t.name },
    el("h2", {}, `New research issue: ${TYPE_WORDS[type]}`),
    el("p", { class: "explain" }, t.about),
    el("p", {}, el("label", { for: "rs-doi" }, "The paper's DOI "), doi),
    el("p", {}, el("label", { for: "rs-code" }, "The code's address "), code, el("br"), el("span", { class: "explain" }, "A GitHub repository's issues are filed on its page in the registry; here, code hosted elsewhere (Zenodo, OSF, Software Heritage, GitLab…).")),
    el("p", {}, el("label", { for: "issue-title" }, "Title"), el("br"), title),
    fields,
    el("p", {}, button("Open the research issue", async () => {
      if (!signedInHint()) {
        said.replaceChildren(signInLine("Sign in to open a research issue."));
        return;
      }
      const { payload, problems } = researchPayload(t, answersOf(form, t), title.value);
      if (problems.length) {
        said.replaceChildren(el("p", { class: "warning" }, problems.join(" ")));
        return;
      }
      Object.assign(payload, { paper: doi.value.trim(), code: code.value.trim() });
      if (prefill.section && !payload.section) payload.section = prefill.section;
      const turnstile = await humanToken(form.querySelector<HTMLElement>('button[type="submit"]') ?? form);
      if (turnstile === null) return void said.replaceChildren(el("p", { class: "warning" }, HUMAN_WAIT));
      const r = await post("/api/forge/research/open", { ...payload, turnstile });
      if (!r.ok) {
        said.replaceChildren(el("p", { class: "warning" }, problemOf(r.body)));
        return;
      }
      location.assign(researchPath(Number(r.body.id)));
    }, { class: "primary", id: "issue-create" })),
    said,
  );
  root.replaceChildren(form);
}

// ─── /research/?paper= ───────────────────────────────────────────────────────

async function mountList(root: HTMLElement): Promise<void> {
  const paper = new URLSearchParams(location.search).get("paper") ?? "";
  if (!paper) {
    show(root, h("h1", null, "Research issues"), h("p", null, "Research issues belong to a paper: open them from the paper's page, its Discussion and Reproductions."));
    return;
  }
  if (!signedInHint()) {
    show(root, h("h1", null, "Research issues"));
    root.append(signInLine("Signed out, a paper's research issues are listed on its page (as of last night); sign in to read them live here."));
    return;
  }
  const res = await fetch(`/api/forge/research?paper=${encodeURIComponent(paper)}`, { credentials: "same-origin", headers: { Accept: "application/json" } }).catch(() => null);
  const body = res ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const items = parseSummaries(body.issues);
  show(
    root,
    h("h1", null, `Research issues of ${paper}`),
    items.length
      ? h("ul", { class: "issue-list" }, ...items.map((s) => h("li", { class: "issue-row" }, h("div", null, h("p", { class: "title" }, h("span", { class: `issue-state${s.state === "open" ? "" : " muted"}` }, stateInWords(fromResearch(s))), ` · ${TYPE_WORDS[s.type]} `, h("a", { href: researchPath(s.id) }, s.title)), h("p", { class: "line" }, `research#${s.id} opened ${dayOfSeconds(s.created_at)} by ${byline(s.author, s.author_via)}`)))))
      : h("p", null, res?.ok ? "None yet." : "The registry could not be reached."),
    h("p", null, h("a", { href: `/research/new?${new URLSearchParams({ doi: paper.replace(/^doi:/, "") })}` }, "Open a research issue about it")),
  );
}

async function main(): Promise<void> {
  const root = document.getElementById("research-shell");
  if (!root) return;
  const target = parseResearchPath(location.pathname);
  if (!target) {
    show(root, h("h1", null, "Research issue"), h("p", { class: "warning" }, "This address names no research issue: /research/<number>."));
    return;
  }
  if ("id" in target) await mountIssue(root, target.id);
  else if ("new" in target) await mountNew(root);
  else await mountList(root);
}

if (typeof document !== "undefined") void main();
