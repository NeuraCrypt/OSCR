// A pull request's Files changed, in the registry's own viewer (night phase 04, E5;
// docs/PULL_REQUESTS.md): pull/<n>/files.
//
// - The diffs of phase 02 (repo-history.ts `mountFiles`): unified or split, whitespace shown or
//   hidden, the tree of changed files and its filter, highlighted on each side; the commit selector
//   (?commit=<sha>: one commit's changes).
// - "Viewed" on each file, kept in this browser (a file changed since is unviewed again), and the
//   review's progress.
// - Comments on a line (click its number), several lines (shift-click the last), a deleted line (the
//   old side), with a suggested change ("Suggest": the lines as they are, to edit). A comment goes at
//   once (one authorization: a review of one comment) or into the pending review, kept in this
//   browser until it is submitted as ONE review: Comment, Approve or Request changes.
// - The conversations under their lines, outdated said; reply and resolve.
// - Suggestions applied — one, or a batch — as ONE commit on the pull request's branch, made by
//   GitHub as the person, with each suggester as a co-author (phase 03's `commit` action).
// - The tracing-map links each file touches (the paper, the paragraph, the lines): the research
//   layer of phase 04.
//
// Read on the reader's own GitHub quota: the pull request (1), its files (1 to 3 pages of 100), its
// review comments (1), the maps' shard (a file of this site) and, for maps, the merge base (1) and
// raw files (not counted). Signed out, the Worker is asked nothing.

import { maskEmails } from "../../worker/forge/mask.ts";
import type { PayloadChange } from "../../worker/forge/service/act-commit.ts";
import type * as T from "../../worker/forge/types.ts";
import { declareCommit } from "../lib/commit-view.ts";
import type { Hunk } from "../lib/history.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { commentHead, type Roles, type Thread, threadsOf, threadWhere } from "../lib/pull-page.ts";
import { declarePull } from "../lib/pull-view.ts";
import {
  applySuggestions,
  commentable,
  commentRange,
  dropPendingReview,
  isViewed,
  type PendingComment,
  type PendingReview,
  readPendingReview,
  readViewed,
  reviewKey,
  type Suggestion,
  suggestionBody,
  suggestionOf,
  writePendingReview,
  writeViewed,
} from "../lib/pulls.ts";
import { type El, h } from "../lib/repo-view.ts";
import { commitTouches, readerUrl, pairClass, type Touched } from "../lib/traced.ts";
import { show, toDom } from "./dom.ts";
import { localStore } from "./forge-client.ts";
import { confirmAction, el, signInLine, textAt, whoIsHere } from "./pull-common.ts";
import { type CodeEnv, repoRef } from "./repo-code.ts";
import { diffOptions, mountFiles } from "./repo-history.ts";
import { type PullFrame, pullFrame } from "./repo-pull.ts";
import { pullFailed, pullTabs } from "./repo-pulls.ts";
import { changeTouches, tracedMaps } from "./repo-traced.ts";

/** Pages of 100 files read at most (GitHub lists 3,000; the registry reads the first 300). */
export const FILE_PAGES = 3;

const now = () => Math.floor(Date.now() / 1000);

interface FilesState {
  f: PullFrame;
  files: T.FileChangeSummary[];
  /** The review comments, as conversations, by path. */
  threads: Map<string, Thread[]>;
  pending: PendingReview;
  viewed: Map<string, string>;
  /** The suggestions chosen for one commit. */
  batch: Map<string, Suggestion>;
  roles: Roles;
  /** The patch hunks of each file (the lines that take comments), by index. */
  hunks: Map<number, Hunk[]>;
  /** Where the page says what it does (a confirmation, a problem). */
  said: HTMLElement;
  /** The line a comment starts at (shift-click extends it). */
  anchor: { index: number; side: "LEFT" | "RIGHT"; line: number } | null;
}

async function mountPullFiles(slot: HTMLElement, env: CodeEnv, number: number): Promise<void> {
  const f = await pullFrame(slot, env, number, "files");
  if (!f) return;
  const { pr } = f;
  const ref = repoRef(env);
  const params = new URLSearchParams(env.search);
  const only = params.get("commit");
  show(f.main, h("p", { "aria-live": "polite" }, "Reading the files…"));

  // One commit's changes (the commit selector): read only.
  let commits: T.CommitSummary[] = [];
  try {
    commits = (await env.session.pulls.commits(ref, number, { perPage: 100 })).items;
  } catch {
    commits = [];
  }
  const selector = commitSelector(f, commits, only);
  if (only && /^[0-9a-f]{40}$/.test(only) && commits.some((c) => c.sha === only)) {
    try {
      const c = await env.session.git.commit(ref, only, { perPage: 100 });
      const { mode, hideWhitespace } = diffOptions(env);
      show(f.main, selector, h("p", { class: "status-line" }, `The changes of one commit, ${only.slice(0, 7)}: “${c.message.split("\n")[0]}”. Comments are written on all the changes.`), h("div", { id: "pull-files" }));
      wireSelector(f);
      await mountFiles(f.main.querySelector<HTMLElement>("#pull-files") as HTMLElement, { env, oldRev: c.parents[0] ?? null, newRev: c.sha, mode, hideWhitespace }, c.files.items, null);
    } catch (e) {
      pullFailed(f.main, env, e, number);
    }
    return;
  }

  let files: T.FileChangeSummary[] = [];
  let reviewComments: T.ReviewComment[] = [];
  try {
    let cursor: string | null = null;
    for (let i = 0; i < FILE_PAGES; i++) {
      const page = await env.session.pulls.files(ref, number, { perPage: 100, cursor });
      files.push(...page.items);
      cursor = page.next;
      if (!cursor) break;
    }
    reviewComments = (await env.session.pulls.comments(ref, number, { perPage: 100 }).catch(() => ({ items: [] as T.ReviewComment[] }))).items;
  } catch (e) {
    pullFailed(f.main, env, e, number);
    return;
  }
  const store = localStore();
  const threads = new Map<string, Thread[]>();
  for (const t of threadsOf(reviewComments)) threads.set(t.path, [...(threads.get(t.path) ?? []), t]);
  const st: FilesState = {
    f,
    files,
    threads,
    pending: readPendingReview(store, env.repo, number, now()) ?? { commit: pr.head.sha, comments: [], body: "", at: now() },
    viewed: readViewed(store, env.repo, number),
    batch: new Map(),
    roles: { author: pr.author.login, paperAuthors: new Set((env.layer?.reviewers ?? []).map((r) => r.login.toLowerCase())), codeOwners: new Set() },
    hunks: new Map(),
    said: el("div", { "aria-live": "polite", class: "review-said" }),
    anchor: null,
  };
  const { mode, hideWhitespace } = diffOptions(env);
  // The files' patches run from the merge base (1 request): the old side of "more context".
  let mergeBase = pr.base.sha;
  try {
    mergeBase = (await env.session.git.compare(ref, pr.base.sha, pr.head.sha, { perPage: 1 })).mergeBase;
  } catch {
    // the base's head then; only "more context" reads it
  }
  const bar = el("div", { class: "review-bar" });
  show(f.main, selector, h("div", { id: "pull-traced" }), h("div", { id: "pull-files" }));
  f.main.insertBefore(bar, f.main.querySelector("#pull-files"));
  f.main.insertBefore(st.said, f.main.querySelector("#pull-files"));
  wireSelector(f);
  drawBar(st, bar);
  if (!files.length) {
    show(f.main.querySelector<HTMLElement>("#pull-files") as HTMLElement, h("p", null, "No file changed."));
    return;
  }
  const into = f.main.querySelector<HTMLElement>("#pull-files") as HTMLElement;
  await mountFiles(
    into,
    {
      env,
      oldRev: mergeBase,
      newRev: pr.head.sha,
      mode,
      hideWhitespace,
      hooks: {
        header: (file, i) =>
          h("p", { class: "file-review" }, h("input", { type: "checkbox", id: `viewed-${i + 1}`, "data-viewed": String(i), checked: isViewed(st.viewed, file) ? "checked" : null }), " ", h("label", { for: `viewed-${i + 1}` }, "Viewed")),
        filled: (section, file, i, patchHunks) => {
          st.hunks.set(i, patchHunks);
          decorate(st, section, file, i);
        },
      },
    },
    files,
    null,
  );
  wireViewed(st, into, bar);
  // The research layer: the tracing-map links each file touches, against the merge base.
  void flagMaps(st, mergeBase);
  // A link to a comment (#r<id>) or a line (#diff-3-R12) scrolls there once drawn.
  if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" }), 1500);
}

// ─── the commit selector ─────────────────────────────────────────────────────

function commitSelector(f: PullFrame, commits: readonly T.CommitSummary[], only: string | null): El {
  return h(
    "form",
    { class: "commit-select", id: "commit-select" },
    h("label", { for: "commit-pick" }, "Changes from "),
    h(
      "select",
      { id: "commit-pick", name: "commit" },
      h("option", { value: "", selected: only ? null : "selected" }, commits.length === 1 ? "its one commit" : `all ${commits.length} commits`),
      ...commits.map((c) => h("option", { value: c.sha, selected: only === c.sha ? "selected" : null }, `${c.sha.slice(0, 7)} ${c.message.split("\n")[0].slice(0, 80)}`)),
    ),
  );
}

function wireSelector(f: PullFrame): void {
  f.main.querySelector<HTMLSelectElement>("#commit-pick")?.addEventListener("change", (ev) => {
    const v = (ev.target as HTMLSelectElement).value;
    const p = new URLSearchParams(f.env.search);
    if (v) p.set("commit", v);
    else p.delete("commit");
    const q = p.toString();
    location.assign(`${location.pathname}${q ? `?${q}` : ""}`);
  });
}

// ─── the review bar: progress, the pending review, the batch ────────────────

function drawBar(st: FilesState, bar: HTMLElement): void {
  const { f } = st;
  const seen = st.files.filter((x) => isViewed(st.viewed, x)).length;
  const parts: (Node | string)[] = [el("p", { class: "review-progress" }, `${seen} of ${st.files.length} ${st.files.length === 1 ? "file" : "files"} viewed.`)];
  if (!f.signedIn) {
    parts.push(signInLine("Sign in with GitHub to comment on lines, suggest changes and review: GitHub records the review as yours."));
    bar.replaceChildren(...parts);
    return;
  }
  const n = st.pending.comments.length;
  const finish = el("button", { type: "button", class: "primary", id: "review-finish" }, n ? `Finish your review (${n} pending ${n === 1 ? "comment" : "comments"})` : "Review changes");
  finish.addEventListener("click", () => reviewPanel(st, bar));
  parts.push(el("p", {}, finish, " ", el("span", { class: "explain" }, "Click a line's number to comment on it; shift-click another to take several lines.")));
  if (st.batch.size) {
    const apply = el("button", { type: "button", id: "batch-apply" }, `Commit the ${st.batch.size} chosen ${st.batch.size === 1 ? "suggestion" : "suggestions"}`);
    apply.addEventListener("click", () => void applyBatch(st, [...st.batch.values()]));
    parts.push(el("p", {}, apply, " ", el("span", { class: "explain" }, `One commit on ${f.pr.head.ref}, as you, each suggester a co-author.`)));
  }
  bar.replaceChildren(...parts);
}

function reviewPanel(st: FilesState, bar: HTMLElement): void {
  const { f } = st;
  const text = el("textarea", { class: "pull-text", id: "review-body", rows: "5", "aria-label": "The review's summary" });
  text.value = st.pending.body;
  text.addEventListener("input", () => {
    st.pending.body = text.value;
    st.pending.at = now();
    writePendingReview(localStore(), f.env.repo, f.pr.number, st.pending);
  });
  const choice = (value: string, label: string, explain: string, checked = false) => {
    const id = `review-${value.toLowerCase()}`;
    const input = el("input", { type: "radio", name: "review-event", id, value });
    input.checked = checked;
    return el("label", { for: id }, input, ` ${label}`, el("span", { class: "explain" }, explain));
  };
  const said = el("div", { "aria-live": "polite" });
  const submit = el("button", { type: "button", class: "primary", id: "review-submit" }, "Submit the review");
  submit.addEventListener("click", () => {
    const event = (bar.querySelector<HTMLInputElement>("input[name=review-event]:checked")?.value ?? "COMMENT") as T.ReviewEvent;
    const comments = st.pending.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, ...(c.startLine ? { startLine: c.startLine, startSide: c.side } : {}), body: c.body }));
    // The pending review is dropped by the callback page once GitHub took it, and only then.
    void confirmAction(said, declarePull({ ...f.env.repo, id: f.env.info.key.id }, "pull_review", { number: f.pr.number, commit: st.pending.commit, event, body: text.value, comments }, f.back), { drafts: [reviewKey(f.env.repo, f.pr.number)] });
  });
  const discard = el("button", { type: "button", class: "link" }, "Discard the pending review");
  discard.addEventListener("click", () => {
    if (st.pending.comments.length && !confirm("Discard the pending comments? They are kept only in this browser.")) return;
    dropPendingReview(localStore(), f.env.repo, f.pr.number);
    st.pending = { commit: f.pr.head.sha, comments: [], body: "", at: now() };
    location.reload();
  });
  const stale = st.pending.comments.length && st.pending.commit !== f.pr.head.sha ? el("p", { class: "warning" }, `The pending comments were written on ${st.pending.commit.slice(0, 7)}; the pull request moved to ${f.pr.head.sha.slice(0, 7)} since. The review is submitted on the version they were written on.`) : null;
  bar.replaceChildren(
    el(
      "section",
      { class: "review-panel", "aria-label": "Finish your review" },
      el("h3", {}, "Finish your review"),
      el("p", {}, `${st.pending.comments.length} pending line ${st.pending.comments.length === 1 ? "comment" : "comments"}, kept in this browser until you submit them.`),
      ...(stale ? [stale] : []),
      text,
      el(
        "fieldset",
        { class: "choices" },
        el("legend", {}, "Your review"),
        choice("COMMENT", "Comment", "general feedback, without approving", true),
        choice("APPROVE", "Approve", "it can be merged as far as you are concerned (its author may not approve their own)"),
        choice("REQUEST_CHANGES", "Request changes", "what must change before it is merged (a summary is optional)"),
      ),
      el("p", {}, submit, " ", discard),
      said,
    ),
  );
  text.focus();
}

// ─── a file: its conversations, its comment forms, "Viewed" ─────────────────

function wireViewed(st: FilesState, into: HTMLElement, bar: HTMLElement): void {
  into.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t?.dataset?.viewed) return;
    const i = Number(t.dataset.viewed);
    const file = st.files[i];
    if (!file) return;
    if (t.checked) st.viewed.set(file.path, file.blob ?? "removed");
    else st.viewed.delete(file.path);
    writeViewed(localStore(), st.f.env.repo, st.f.pr.number, st.viewed);
    const body = t.closest("section.file-diff")?.querySelector<HTMLElement>(".file-body");
    if (body) body.hidden = t.checked;
    drawBar(st, bar);
  });
  // Files viewed on the blob they have now start folded.
  st.files.forEach((file, i) => {
    if (!isViewed(st.viewed, file)) return;
    const body = into.querySelector<HTMLElement>(`#diff-${i + 1} .file-body`);
    if (body) body.hidden = true;
  });
}

/** After a file's diff is drawn: its conversations and pending comments under their lines, and the
 *  number cells that open a comment. */
function decorate(st: FilesState, section: HTMLElement, file: T.FileChangeSummary, index: number): void {
  const table = section.querySelector<HTMLTableElement>("table.diff");
  if (!table) return;
  const cols = table.classList.contains("split") ? 4 : 3;
  const rowOf = (side: "LEFT" | "RIGHT", line: number): HTMLTableRowElement | null =>
    (table.querySelector(`#diff-${index + 1}-${side === "LEFT" ? "L" : "R"}${line}`)?.closest("tr") as HTMLTableRowElement | null) ?? null;
  const insertAfter = (row: HTMLTableRowElement, node: HTMLElement) => {
    const tr = document.createElement("tr");
    tr.className = "comment-row";
    const td = document.createElement("td");
    td.colSpan = cols;
    td.append(node);
    tr.append(td);
    row.after(tr);
  };
  // The conversations.
  for (const t of st.threads.get(file.path) ?? []) {
    const row = t.line !== null ? rowOf(t.side, t.line) : null;
    const node = document.createElement("div");
    node.className = "thread-slot";
    void threadNode(st, t).then((n) => node.replaceWith(n));
    if (row) insertAfter(row, node);
    else if (t.outdated) {
      // An outdated conversation: above the file's diff, said.
      const body = section.querySelector(".file-body");
      body?.insertBefore(node, body.firstChild);
    }
  }
  // The pending comments.
  for (const c of st.pending.comments.filter((x) => x.path === file.path)) {
    const row = rowOf(c.side, c.line);
    if (row) insertAfter(row, pendingNode(st, c));
  }
  if (!st.f.signedIn || st.f.pr.state !== "open") return;
  // Click a number: a comment on that line; shift-click: several lines, in one hunk.
  table.querySelectorAll<HTMLElement>("td.num[data-line]").forEach((cell) => {
    cell.classList.add("commentable");
    cell.setAttribute("title", "Comment on this line (shift-click another to take several)");
    cell.addEventListener("click", (ev) => {
      const side = cell.dataset.side === "L" ? "LEFT" : "RIGHT";
      const line = Number(cell.dataset.line);
      const hunks = st.hunks.get(index) ?? [];
      if (commentable(hunks, side, line) === null) {
        st.said.replaceChildren(el("p", { class: "warning" }, "GitHub takes comments on the lines its diff shows: this one is context the registry added. Comment on a changed line or one next to it."));
        return;
      }
      if ((ev as MouseEvent).shiftKey && st.anchor && st.anchor.index === index && st.anchor.side === side) {
        const r = commentRange(hunks, side, st.anchor.line, line);
        if (!r) {
          st.said.replaceChildren(el("p", { class: "warning" }, "A comment on several lines stays within one part of the diff (one hunk)."));
          return;
        }
        commentForm(st, file, index, side, r.start, r.end, cell.closest("tr") as HTMLTableRowElement, insertAfter, rowOf(side, r.end));
        return;
      }
      st.anchor = { index, side, line };
      commentForm(st, file, index, side, line, line, cell.closest("tr") as HTMLTableRowElement, insertAfter, null);
    });
  });
}

/** The lines a comment covers, as the head's file has them (for a suggestion to start from). */
async function linesOf(st: FilesState, path: string, start: number, end: number): Promise<string[] | null> {
  const text = await textAt(st.f.env, st.f.pr.head.sha, path);
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  return lines.slice(start - 1, end);
}

function commentForm(
  st: FilesState,
  file: T.FileChangeSummary,
  index: number,
  side: "LEFT" | "RIGHT",
  start: number,
  end: number,
  row: HTMLTableRowElement,
  insertAfter: (row: HTMLTableRowElement, node: HTMLElement) => void,
  endRow: HTMLTableRowElement | null,
): void {
  row.closest("tbody")?.querySelectorAll("tr.comment-form-row").forEach((r) => r.remove());
  const text = el("textarea", { class: "pull-text", rows: "4", "aria-label": `Your comment on ${file.path}` });
  const where = el("p", { class: "thread-where" }, maskEmails(`${file.path}, ${start === end ? `line ${end}` : `lines ${start} to ${end}`}${side === "LEFT" ? " of the old version" : ""}`));
  const said = el("div", { "aria-live": "polite" });
  const suggest = el("button", { type: "button" }, "Suggest a change");
  suggest.disabled = side === "LEFT";
  suggest.addEventListener("click", async () => {
    const lines = await linesOf(st, file.path, start, end);
    if (!lines) {
      said.replaceChildren(el("p", { class: "warning" }, "The file could not be read to start the suggestion from its lines."));
      return;
    }
    // Lines that hold an email address are never shown, so they are not offered for editing: the
    // suggestion would write the hidden form back.
    if (lines.some((l) => maskEmails(l) !== l)) {
      said.replaceChildren(el("p", { class: "warning" }, "These lines hold an email address, which the registry never shows: describe the change in words instead."));
      return;
    }
    text.value = `${text.value ? `${text.value}\n` : ""}${suggestionBody(lines)}`;
    text.focus();
  });
  const comment: PendingComment = { path: file.path, line: end, side, body: "", ...(start !== end ? { startLine: start } : {}) };
  const now1 = el("button", { type: "button", class: "primary" }, "Comment now");
  now1.addEventListener("click", () => {
    comment.body = text.value;
    const payload = { number: st.f.pr.number, commit: st.f.pr.head.sha, event: "COMMENT", comments: [{ path: comment.path, line: comment.line, side, ...(comment.startLine ? { startLine: comment.startLine, startSide: side } : {}), body: comment.body }] };
    void confirmAction(said, declarePull({ ...st.f.env.repo, id: st.f.env.info.key.id }, "pull_review", payload, st.f.back));
  });
  const later = el("button", { type: "button" }, "Add to the review");
  later.addEventListener("click", () => {
    if (!text.value.trim()) {
      said.replaceChildren(el("p", { class: "warning" }, "Write the comment first."));
      return;
    }
    comment.body = text.value;
    if (st.pending.commit !== st.f.pr.head.sha && st.pending.comments.length === 0) st.pending.commit = st.f.pr.head.sha;
    st.pending.comments.push(comment);
    st.pending.at = now();
    const kept = writePendingReview(localStore(), st.f.env.repo, st.f.pr.number, st.pending);
    box.closest("tr")?.remove();
    insertAfter(endRow ?? row, pendingNode(st, comment));
    const bar = st.f.main.querySelector<HTMLElement>(".review-bar");
    if (bar) drawBar(st, bar);
    if (!kept) st.said.replaceChildren(el("p", { class: "warning" }, "This browser keeps nothing for this site: the pending comment lives until the page is left."));
  });
  const cancel = el("button", { type: "button", class: "link" }, "Cancel");
  cancel.addEventListener("click", () => box.closest("tr")?.remove());
  const box = el("div", { class: "comment-box" }, where, text, el("p", {}, now1, " ", later, " ", suggest, " ", cancel), said);
  insertAfter(endRow ?? row, box);
  (box.closest("tr") as HTMLTableRowElement).classList.add("comment-form-row");
  text.focus();
}

function pendingNode(st: FilesState, c: PendingComment): HTMLElement {
  const node = el("div", { class: "thread pending" }, el("p", { class: "thread-where" }, maskEmails(`${threadWhere({ path: c.path, line: c.line, startLine: c.startLine ?? null, side: c.side, outdated: false })} — pending, in this browser`)));
  void renderMarkdown(c.body, { repo: st.f.env.repo }).then((r) => node.append(toDom(r.el)));
  const drop = el("button", { type: "button", class: "link" }, "Delete it");
  drop.addEventListener("click", () => {
    st.pending.comments = st.pending.comments.filter((x) => x !== c);
    writePendingReview(localStore(), st.f.env.repo, st.f.pr.number, st.pending);
    node.closest("tr")?.remove();
    const bar = st.f.main.querySelector<HTMLElement>(".review-bar");
    if (bar) drawBar(st, bar);
  });
  node.append(el("p", { class: "thread-actions" }, drop));
  return node;
}

/** A conversation under its line: its comments (a suggestion shown as the change it makes, with
 *  Apply and Add to the batch), reply and resolve. */
async function threadNode(st: FilesState, t: Thread): Promise<HTMLElement> {
  const { f } = st;
  const node = el("div", { class: `thread${t.outdated ? " outdated" : ""}`, id: `r${t.id}` });
  node.append(toDom(h("p", { class: "thread-where" }, threadWhere(t))));
  for (const c of t.comments) {
    const one = el("div", { class: "thread-comment", id: `r${c.id}` });
    const s = suggestionOf(c);
    // A suggestion is shown as the change it makes, not as its block of text.
    const text = s && typeof s === "object" ? c.body.replace(/^[ \t]*```suggestion[ \t]*\r?\n[\s\S]*?^[ \t]*```[ \t]*$/m, "").trim() : c.body;
    one.append(toDom(commentHead(c.author, c.createdAt, st.roles)));
    if (text) one.append(toDom((await renderMarkdown(text, { repo: f.env.repo })).el));
    if (s && typeof s === "object") {
      const current = await linesOf(st, s.path, s.start, s.end);
      if (current) one.append(toDom(suggestionDiff(current, s.lines)));
      if (f.signedIn && f.pr.state === "open") {
        const said = el("div", { "aria-live": "polite" });
        const apply = el("button", { type: "button" }, "Apply this suggestion");
        apply.addEventListener("click", () => void applyBatch(st, [s], said));
        const add = el("button", { type: "button", class: "link" }, st.batch.has(s.id) ? "Remove from the batch" : "Add to the batch");
        add.addEventListener("click", () => {
          if (st.batch.has(s.id)) st.batch.delete(s.id);
          else st.batch.set(s.id, s);
          add.textContent = st.batch.has(s.id) ? "Remove from the batch" : "Add to the batch";
          const bar = f.main.querySelector<HTMLElement>(".review-bar");
          if (bar) drawBar(st, bar);
        });
        one.append(el("p", { class: "thread-actions" }, apply, " ", add), said);
      }
    } else if (typeof s === "string") one.append(el("p", { class: "explain" }, s));
    node.append(one);
  }
  if (f.signedIn) {
    const box = el("div", { "aria-live": "polite" });
    const reply = el("button", { type: "button", class: "link" }, "Reply");
    reply.addEventListener("click", () => {
      const text = el("textarea", { class: "pull-text", rows: "3", "aria-label": "Your reply" });
      const said = el("div", { "aria-live": "polite" });
      const send = el("button", { type: "button", class: "primary" }, "Reply");
      send.addEventListener("click", () => void confirmAction(said, declarePull({ ...f.env.repo, id: f.env.info.key.id }, "pull_comment", { number: f.pr.number, body: text.value, replyTo: t.id }, f.back)));
      box.replaceChildren(text, el("p", {}, send), said);
      text.focus();
    });
    const resolve = el("button", { type: "button", class: "link" }, "Resolve the conversation");
    resolve.addEventListener("click", () => void confirmAction(box, declarePull({ ...f.env.repo, id: f.env.info.key.id }, "pull_thread", { number: f.pr.number, comment: t.id, resolved: true }, f.back)));
    node.append(el("p", { class: "thread-actions" }, reply, " · ", resolve), box);
  }
  return node;
}

/** A suggestion as the change it makes: the lines now, the lines suggested. */
function suggestionDiff(now: readonly string[], next: readonly string[]): El {
  return h(
    "div",
    { class: "suggestion" },
    h("p", { class: "suggestion-title" }, "Suggested change"),
    h(
      "table",
      { class: "diff unified", "aria-label": "Suggested change" },
      h(
        "tbody",
        null,
        ...now.map((l) => h("tr", { class: "del" }, h("td", { class: "code del" }, h("span", { class: "sign", "aria-hidden": "true" }, "−"), l))),
        ...next.map((l) => h("tr", { class: "add" }, h("td", { class: "code add" }, h("span", { class: "sign", "aria-hidden": "true" }, "+"), l))),
      ),
    ),
  );
}

// ─── suggestions applied: one commit ─────────────────────────────────────────

async function applyBatch(st: FilesState, list: Suggestion[], box: HTMLElement = st.said): Promise<void> {
  const { f } = st;
  const head = f.pr.head;
  if (!head.repo) {
    box.replaceChildren(el("p", { class: "warning" }, "The fork this pull request came from was deleted: its suggestions cannot be applied."));
    return;
  }
  const byPath = new Map<string, Suggestion[]>();
  for (const s of list) byPath.set(s.path, [...(byPath.get(s.path) ?? []), s]);
  const changes: PayloadChange[] = [];
  for (const [path, ss] of byPath) {
    const text = await textAt(f.env, head.sha, path, 700 * 1024);
    if (text === null) {
      box.replaceChildren(el("p", { class: "warning" }, `${path} could not be read at the pull request's head: nothing was changed.`));
      return;
    }
    const next = applySuggestions(text, ss);
    if (typeof next !== "string") {
      box.replaceChildren(el("p", { class: "warning" }, next.problem));
      return;
    }
    changes.push({ op: "put", path, text: next });
  }
  // Each suggester is a co-author, but the person who commits (as on GitHub).
  const who = await whoIsHere();
  const me = "login" in who && who.login ? who.login.toLowerCase() : "";
  const coAuthors = [...new Map(list.filter((s) => s.author.login && s.author.login.toLowerCase() !== me && s.author.id && /^\d+$/.test(s.author.id)).map((s) => [s.author.id as string, { login: s.author.login as string, id: s.author.id as string }])).values()].slice(0, 10);
  const payload = {
    branch: head.ref,
    base: head.sha,
    message: list.length === 1 ? "Apply suggestion from code review" : "Apply suggestions from code review",
    coAuthors,
    changes,
  };
  const d = declareCommit({ owner: head.repo.owner, name: head.repo.name, id: null }, payload, f.back);
  await confirmAction(box, "problem" in d ? d : { input: d.input, sentence: d.sentence });
}

// ─── the research layer: the tracing-map links each file touches ────────────

async function flagMaps(st: FilesState, base: string): Promise<void> {
  const { f } = st;
  const maps = await tracedMaps(f.env).catch(() => []);
  if (!maps.length) return;
  const touched = await changeTouches(f.env, st.files, base).catch(() => [] as Touched[]);
  if (!touched.length) return;
  const top = f.main.querySelector<HTMLElement>("#pull-traced");
  const note = commitTouches(touched, { subject: "This pull request", verb: "changes" });
  if (top && note) show(top, note);
  // Each file's own links, above its diff.
  st.files.forEach((file, i) => {
    const mine = touched.filter((t) => t.path === (file.previousPath ?? file.path));
    if (!mine.length) return;
    const section = f.main.querySelector<HTMLElement>(`#diff-${i + 1}`);
    const body = section?.querySelector(".file-body");
    if (!section || !body) return;
    const list = h(
      "div",
      { class: "traced-note file-traced", role: "note" },
      h("p", { class: "traced-title" }, `Tracing-map links on ${file.path}`),
      h(
        "ul",
        null,
        ...mine.map((t) =>
          h(
            "li",
            { class: pairClass(t.pair.pair) },
            `${t.pair.end > t.pair.start ? `lines ${t.pair.start} to ${t.pair.end}` : `line ${t.pair.start}`} at ${t.map.commit.slice(0, 7)}: `,
            h("a", { href: readerUrl(t.map, t.pair.pair) }, `Paragraph ${t.pair.paragraph}${t.pair.section ? ` of ${t.pair.section}` : ""}`),
            ` of ${t.map.title || t.map.doi} — ${t.state === "changed" ? "these lines change" : t.state === "kept" ? "not changed" : "could not be found in the version it starts from"}.`,
          ),
        ),
      ),
    );
    section.insertBefore(toDom(list), body);
  });
}

pullTabs.files = mountPullFiles;
