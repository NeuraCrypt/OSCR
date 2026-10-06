// A pull request's page in the /r/ shell (night phase 04, E4; docs/PULL_REQUESTS.md):
// pull/<n> (the conversation), pull/<n>/commits, pull/<n>/checks. Files changed is repo-pull-files.ts
// (E5), the conflicts repo-conflicts.ts (E6); both use `pullFrame`.
//
// Read in the reader's browser, on the reader's own GitHub quota (D00-5): the pull request (1); the
// conversation adds its comments (1), reviews (1), review comments (1), commits (1, their messages'
// closing keywords), the checks of its head (2); the files (1) and the merge base (1) only when the
// repository has tracing maps (the maps' shard is a file of this site). Signed out, the Worker is
// asked nothing; signed in, the layer (1, the shell's) names the paper's verified authors.
//
// Every write is one authorized action made by GitHub as the person (act-pulls.ts): comment, reply,
// resolve, close or reopen, draft or ready, reviewers, merge (at the head shown: a head that moved is
// refused), auto-merge, update branch, revert, delete or restore the branch. GitHub is the
// competitor: nothing here sends the reader there, but a check's own log (a CI's page) as a last
// resort, said.
//
// Comments are someone's text: rendered by the registry's own Markdown renderer into view trees,
// email addresses masked, never HTML, never run.

import { maskEmails } from "../../worker/forge/mask.ts";
import type * as T from "../../worker/forge/types.ts";
import { codeownersPath, ownersOfChange, parseCodeowners } from "../lib/codeowners.ts";
import { repoPath } from "../lib/forge.ts";
import { commitList } from "../lib/history.ts";
import { detectLanguage } from "../lib/highlight.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import {
  checkWords,
  commentHead,
  eventWords,
  hasSuggestion,
  pullHeader,
  pullTabsNav,
  reviewWords,
  type Roles,
  statusWords,
  type Thread,
  threadWhere,
  timelineOf,
} from "../lib/pull-page.ts";
import { closingNotice, declarePull, researchClosingNotice } from "../lib/pull-view.ts";
import { researchClosing } from "../../worker/forge/service/research-core.ts";
import {
  changeSummary,
  checksSummary,
  closingRefs,
  defaultMergeMessage,
  mergeBox,
  type MergeBox,
  pullPath,
  type PullTab,
  reviewsSummary,
  suggestReviewers,
  summaryInWords,
} from "../lib/pulls.ts";
import { type El, h } from "../lib/repo-view.ts";
import { commitTouches } from "../lib/traced.ts";
import { show, toDom } from "./dom.ts";
import { confirmAction, el, signedInHint, signInLine, textAt } from "./pull-common.ts";
import { type CodeEnv, repoRef } from "./repo-code.ts";
import { pullFailed, pullTabs } from "./repo-pulls.ts";
import { changeTouches, tracedMaps } from "./repo-traced.ts";

// ─── the frame every tab shares ──────────────────────────────────────────────

export interface PullFrame {
  env: CodeEnv;
  pr: T.PullRequest;
  /** The tab's body and the sidebar. */
  main: HTMLElement;
  side: HTMLElement;
  /** The page GitHub's answer comes back to. */
  back: string;
  signedIn: boolean;
}

/** Reads the pull request (1 request) and draws its header, its tabs and an empty body and sidebar;
 *  null when GitHub did not answer (said in the slot). */
export async function pullFrame(slot: HTMLElement, env: CodeEnv, number: number, tab: PullTab): Promise<PullFrame | null> {
  show(slot, h("p", { "aria-live": "polite" }, `Reading the pull request #${number}…`));
  let pr: T.PullRequest;
  try {
    pr = await env.session.pulls.get(repoRef(env), number);
  } catch (e) {
    pullFailed(slot, env, e, number);
    return null;
  }
  document.title = `${pr.title} · #${pr.number} · ${env.repo.owner}/${env.repo.name}`;
  // Files changed and the conflicts take the page's whole width (the diffs have their own tree).
  const wide = tab === "files" || tab === "conflicts";
  show(
    slot,
    pullHeader(env.repo, pr, mergeBox(pr, null, null)),
    pullTabsNav(env.repo, pr, tab),
    wide ? h("div", { class: "pull-wide", id: "pull-main" }) : h("div", { class: "record pull-record" }, h("div", { class: "body", id: "pull-main" }), h("div", { class: "sidebar", id: "pull-side" })),
  );
  return {
    env,
    pr,
    main: slot.querySelector<HTMLElement>("#pull-main") as HTMLElement,
    side: slot.querySelector<HTMLElement>("#pull-side") ?? document.createElement("div"),
    back: pullPath(env.repo, number, tab),
    signedIn: signedInHint(),
  };
}

/** One action of this pull request, confirmed in `box`. */
function act(f: PullFrame, box: HTMLElement, kind: Parameters<typeof declarePull>[1], payload: Record<string, unknown>, extra: { branch?: string | null; expectedHead?: string | null } = {}): void {
  void confirmAction(box, declarePull({ ...f.env.repo, id: f.env.info.key.id }, kind, payload, f.back, extra));
}

const button = (label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement => {
  const b = el("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
};

/** A Markdown body as the registry renders it (someone's text: view trees, addresses masked). */
async function body(text: string, env: CodeEnv): Promise<El> {
  if (!text.trim()) return h("p", { class: "muted-note" }, "No description.");
  return (await renderMarkdown(text, { repo: env.repo })).el;
}

// ─── the conversation ────────────────────────────────────────────────────────

async function mountConversation(slot: HTMLElement, env: CodeEnv, number: number): Promise<void> {
  const f = await pullFrame(slot, env, number, "conversation");
  if (!f) return;
  const { pr } = f;
  const ref = repoRef(env);
  show(f.main, h("p", { "aria-live": "polite" }, "Reading the conversation…"));
  const [comments, reviews, reviewComments, commits] = await Promise.all([
    env.session.issues.comments(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.IssueComment[]),
    env.session.pulls.reviews(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.Review[]),
    env.session.pulls.comments(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.ReviewComment[]),
    env.session.pulls.commits(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.CommitSummary[]),
  ]);
  const paperAuthors = new Set((env.layer?.reviewers ?? []).map((r) => r.login.toLowerCase()));
  const roles: Roles = { author: pr.author.login, paperAuthors, codeOwners: new Set() };
  const reviewSummary = reviewsSummary(reviews, pr.requestedReviewers, pr.author.login);
  let checks: ReturnType<typeof checksSummary> | null = null;
  try {
    const [runs, status] = await Promise.all([env.session.checks.runs(ref, pr.head.sha, { perPage: 100 }), env.session.checks.status(ref, pr.head.sha).catch(() => null)]);
    checks = checksSummary(runs.items, status);
  } catch {
    checks = null;
  }
  const box = mergeBox(pr, checks, reviewSummary);
  const status = slot.querySelector(".merge-status");
  if (status) {
    status.className = `merge-status ${box.tone}`;
    status.textContent = box.status;
  }

  // The description and the timeline.
  const parts: El[] = [
    h("div", { class: "comment pull-description" }, commentHead(pr.author, pr.createdAt, roles, "opened it"), await body(pr.body, env)),
  ];
  for (const item of timelineOf(comments, reviews, reviewComments)) {
    if (item.kind === "comment") {
      parts.push(h("div", { class: "comment", id: `comment-${item.comment.id}` }, commentHead(item.comment.author, item.comment.createdAt, roles), await body(item.comment.body, env)));
    } else if (item.kind === "review") {
      const r = item.review;
      const threads: El[] = [];
      for (const t of item.threads) threads.push(await threadView(f, t, roles));
      parts.push(
        h(
          "div",
          { class: `comment review review-${r.state.toLowerCase()}`, id: `review-${r.id}` },
          commentHead(r.author, r.submittedAt ?? "", roles, reviewWords(r.state)),
          r.body.trim() ? await body(r.body, env) : null,
          ...threads,
        ),
      );
    } else parts.push(h("p", { class: "timeline-event" }, eventWords(item.event)));
  }
  show(f.main, h("section", { class: "timeline", "aria-label": "Conversation" }, ...parts), h("div", { id: "merge-box" }), h("div", { id: "comment-form" }));
  wireThreads(f);
  mergeBoxView(f, f.main.querySelector<HTMLElement>("#merge-box") as HTMLElement, box, commits);
  commentForm(f, f.main.querySelector<HTMLElement>("#comment-form") as HTMLElement);
  await sidebar(f, roles, reviewSummary, commits);
}

/** A conversation: where it is, its comments, and (signed in) reply and resolve. */
async function threadView(f: PullFrame, t: Thread, roles: Roles): Promise<El> {
  const comments: El[] = [];
  for (const c of t.comments) {
    comments.push(
      h(
        "div",
        { class: "thread-comment", id: `r${c.id}` },
        commentHead(c.author, c.createdAt, roles),
        await body(c.body, f.env),
        hasSuggestion(c.body) ? h("p", { class: "suggestion-note" }, "A suggested change: ", h("a", { href: `${pullPath(f.env.repo, f.pr.number, "files")}#r${c.id}` }, "see it in Files changed"), ", where it can be applied.") : null,
      ),
    );
  }
  return h(
    "div",
    { class: `thread${t.outdated ? " outdated" : ""}`, "data-thread": t.id },
    h("p", { class: "thread-where" }, h("a", { href: `${pullPath(f.env.repo, f.pr.number, "files")}#r${t.id}` }, threadWhere(t))),
    ...comments,
    f.signedIn ? h("p", { class: "thread-actions" }, h("button", { type: "button", class: "link", "data-reply": t.id }, "Reply"), " · ", h("button", { type: "button", class: "link", "data-resolve": t.id }, "Resolve the conversation"), " · ", h("button", { type: "button", class: "link", "data-unresolve": t.id }, "Unresolve it")) : null,
    h("div", { class: "thread-box", "aria-live": "polite" }),
  );
}

function wireThreads(f: PullFrame): void {
  f.main.querySelectorAll<HTMLElement>("div.thread").forEach((t) => {
    const id = t.dataset.thread ?? "";
    const box = t.querySelector<HTMLElement>(".thread-box");
    if (!box) return;
    t.querySelector("[data-reply]")?.addEventListener("click", () => {
      const text = el("textarea", { class: "pull-text", rows: "4", "aria-label": "Your reply" });
      const send = button("Reply", () => act(f, said, "pull_comment", { number: f.pr.number, body: text.value, replyTo: id }), { class: "primary" });
      const said = el("div", { "aria-live": "polite" });
      box.replaceChildren(text, el("p", {}, send), said);
      text.focus();
    });
    t.querySelector("[data-resolve]")?.addEventListener("click", () => act(f, box, "pull_thread", { number: f.pr.number, comment: id, resolved: true }));
    t.querySelector("[data-unresolve]")?.addEventListener("click", () => act(f, box, "pull_thread", { number: f.pr.number, comment: id, resolved: false }));
  });
}

/** The comment form (signed in), with a preview. */
function commentForm(f: PullFrame, into: HTMLElement): void {
  if (!f.signedIn) {
    into.replaceChildren(signInLine("Sign in with GitHub to comment: the comment is posted as you."));
    return;
  }
  const text = el("textarea", { class: "pull-text", id: "comment-text", rows: "6", "aria-label": "Your comment" });
  const preview = el("div", { class: "pull-preview", hidden: "" });
  const said = el("div", { "aria-live": "polite" });
  const previewButton = button("Preview", async () => {
    if (!preview.hidden) {
      preview.hidden = true;
      previewButton.textContent = "Preview";
      return;
    }
    preview.replaceChildren(toDom((await renderMarkdown(text.value, { repo: f.env.repo })).el));
    preview.hidden = false;
    previewButton.textContent = "Back to the text";
  });
  const send = button("Comment", () => act(f, said, "pull_comment", { number: f.pr.number, body: text.value }), { class: "primary", id: "comment-send" });
  const state = f.pr.merged ? null : f.pr.state === "open" ? button("Close the pull request", () => act(f, said, "pull_edit", { number: f.pr.number, state: "closed" })) : button("Reopen it", () => act(f, said, "pull_edit", { number: f.pr.number, state: "open" }));
  into.replaceChildren(el("section", { class: "comment-form", "aria-label": "Add a comment" }, el("h3", {}, "Add a comment"), text, preview, el("p", {}, send, " ", previewButton, ...(state ? [" ", state] : [])), said));
}

// ─── the merge box ───────────────────────────────────────────────────────────

const METHOD_WORDS: Record<T.MergeMethod, string> = { merge: "Create a merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

function mergeBoxView(f: PullFrame, into: HTMLElement, box: MergeBox, commits: readonly T.CommitSummary[]): void {
  const { pr, env } = f;
  const said = el("div", { "aria-live": "polite" });
  const lines = [el("p", { class: `merge-status ${box.tone}` }, box.status), ...box.lines.map((l) => el("p", {}, l))];
  const section = el("section", { class: "merge-box", "aria-label": "Merging" }, el("h3", {}, "Merging"), ...lines);
  into.replaceChildren(section);
  if (pr.merged) {
    if (f.signedIn) {
      section.append(
        el("p", {}, button("Revert", () => act(f, said, "pull_revert", { number: pr.number })), " GitHub opens a new pull request that undoes this one; it is reviewed and merged like any other."),
      );
      void branchButtons(f, section, said);
    }
    section.append(said);
    return;
  }
  if (pr.state === "closed") {
    if (f.signedIn) void branchButtons(f, section, said);
    section.append(said);
    return;
  }
  if (!f.signedIn) {
    section.append(signInLine("Sign in with GitHub to merge, review or update it: GitHub decides whether your account may, and the registry acts as you."));
    return;
  }
  if (pr.draft) {
    section.append(el("p", {}, button("Ready for review", () => act(f, said, "pull_edit", { number: pr.number, draft: false }), { class: "primary" }), " Reviewers can then approve it, and it can be merged."), said);
    return;
  }
  if (box.conflicts) {
    section.append(
      el("p", {}, el("a", { href: pullPath(env.repo, pr.number, "conflicts"), class: "primary-link" }, "Resolve the conflicts"), ` here, in the browser: the registry shows each one, and the result is committed on ${pr.head.ref} as you.`),
    );
  }
  if (box.behind || box.conflicts || pr.mergeState === "behind") {
    section.append(el("p", {}, button("Update branch", () => act(f, said, "pull_update", { number: pr.number, head: pr.head.sha })), ` GitHub merges ${pr.base.ref} into ${pr.head.ref}${box.conflicts ? " (it cannot while they conflict)" : ""}.`));
  }
  // The merge: the method, GitHub's default message, the branch deleted after.
  const method = el("select", { id: "merge-method", name: "method" });
  for (const m of ["merge", "squash", "rebase"] as T.MergeMethod[]) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = METHOD_WORDS[m];
    method.append(o);
  }
  const title = el("input", { type: "text", id: "merge-title", name: "title", maxlength: "500", autocomplete: "off" });
  const message = el("textarea", { class: "pull-text", id: "merge-message", rows: "4", "aria-label": "The commit's message" });
  const del = el("input", { type: "checkbox", id: "merge-delete" });
  del.checked = env.info.features.deleteBranchOnMerge || headIsHere(f);
  const fill = () => {
    // GitHub's default message, masked like every text the page shows (the person writes theirs).
    const d = defaultMergeMessage(pr, method.value as T.MergeMethod, commits);
    title.value = maskEmails(d.title);
    message.value = maskEmails(d.message);
    const rebase = method.value === "rebase";
    title.disabled = rebase;
    message.disabled = rebase;
  };
  method.addEventListener("change", fill);
  fill();
  const merge = button("Merge", () => {
    const m = method.value as T.MergeMethod;
    const payload: Record<string, unknown> = { number: pr.number, method: m, head: pr.head.sha, deleteBranch: del.checked };
    // Phase 05: the research issues its text says it fixes ("Fixes research#12"), closed by the merge
    // into the default branch as "fixed in the code" (the Worker checks the text again).
    const researchIds = researchClosing(`${pr.title}\n${pr.body}`).slice(0, 5);
    if (researchIds.length && env.info.defaultBranch !== null && pr.base.ref === env.info.defaultBranch) payload.closes = researchIds;
    if (m !== "rebase") {
      payload.title = title.value;
      payload.message = message.value;
    }
    act(f, said, "pull_merge", payload, { expectedHead: pr.head.sha });
  }, { class: "primary", id: "merge-go" });
  const auto = pr.autoMerge
    ? button("Disable auto-merge", () => act(f, said, "pull_edit", { number: pr.number, autoMerge: null }))
    : button("Enable auto-merge", () => act(f, said, "pull_edit", { number: pr.number, autoMerge: method.value }));
  section.append(
    el(
      "div",
      { class: "merge-form" },
      el("p", {}, el("label", { for: "merge-method" }, "How "), method),
      el("p", {}, el("label", { for: "merge-title" }, "The commit's title"), el("br"), title),
      el("p", {}, message),
      headIsHere(f) || pr.maintainerCanModify ? el("p", {}, del, " ", el("label", { for: "merge-delete" }, `Delete the branch ${pr.head.ref} after merging (it can be restored from here)`)) : null,
      el("p", {}, merge, " ", auto, " ", el("span", { class: "explain" }, `At ${pr.head.sha.slice(0, 7)}, the version this page shows: if a commit arrives meanwhile, nothing is merged.`)),
      el("p", {}, button("Convert to draft", () => act(f, said, "pull_edit", { number: pr.number, draft: true }), { class: "link" })),
    ),
    said,
  );
  if (!box.mergeable) merge.textContent = "Merge (GitHub decides)";
}

const headIsHere = (f: PullFrame): boolean => {
  const r = f.pr.head.repo;
  return !!r && r.owner.toLowerCase() === f.env.repo.owner.toLowerCase() && r.name.toLowerCase() === f.env.repo.name.toLowerCase();
};

/** After a merge or a close: delete the head branch, or restore it (1 request: whether it is there). */
async function branchButtons(f: PullFrame, section: HTMLElement, said: HTMLElement): Promise<void> {
  const where = f.pr.head.repo;
  if (!where) return;
  let exists: boolean;
  try {
    const b = await f.env.session.git.getBranch(where, f.pr.head.ref);
    if (b.sha !== f.pr.head.sha) return; // the branch moved on: it is someone's work, not this pull request's
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) section.insertBefore(el("p", {}, button("Delete the branch", () => act(f, said, "pull_edit", { number: f.pr.number, headBranch: "delete" })), ` ${f.pr.head.ref} is not needed any more; it can be restored from here.`), said);
  else section.insertBefore(el("p", {}, button("Restore the branch", () => act(f, said, "pull_edit", { number: f.pr.number, headBranch: "restore" })), ` ${f.pr.head.ref} was deleted; GitHub can make it again at ${f.pr.head.sha.slice(0, 7)}.`), said);
}

// ─── the sidebar ─────────────────────────────────────────────────────────────

async function sidebar(f: PullFrame, roles: Roles, reviews: ReturnType<typeof reviewsSummary>, commits: readonly T.CommitSummary[]): Promise<void> {
  const { pr, env } = f;
  const ref = repoRef(env);
  const said = el("div", { "aria-live": "polite" });
  const parts: Node[] = [];

  // Reviewers.
  const rows: HTMLElement[] = [];
  for (const l of reviews.approved) rows.push(el("li", { class: "ok" }, `${l}: approved`));
  for (const l of reviews.changesRequested) rows.push(el("li", { class: "warning" }, `${l}: changes requested`));
  for (const l of reviews.commented) rows.push(el("li", {}, `${l}: commented`));
  for (const l of reviews.requested) {
    const li = el("li", {}, `${l}: review asked`);
    if (f.signedIn && pr.state === "open") li.append(" ", button("Remove", () => act(f, said, "pull_edit", { number: pr.number, reviewers: { remove: [l] } }), { class: "link" }));
    rows.push(li);
  }
  parts.push(el("h3", {}, "Reviewers"), rows.length ? el("ul", { class: "reviewers" }, ...rows) : el("p", {}, "No review yet."));
  if (f.signedIn && pr.state === "open") {
    const who = el("input", { type: "text", id: "ask-review", autocomplete: "off", spellcheck: "false", placeholder: "a GitHub login" });
    const ask = button("Ask", () => act(f, said, "pull_edit", { number: pr.number, reviewers: { add: who.value.split(/[\s,]+/).map((s) => s.replace(/^@/, "")).filter(Boolean) } }));
    parts.push(el("p", { class: "ask-review" }, el("label", { for: "ask-review" }, "Ask for a review "), who, " ", ask));
  }
  const suggestedBox = el("div");
  parts.push(suggestedBox, said);

  // Labels, assignees.
  if (pr.labels.length) parts.push(el("h3", {}, "Labels"), el("p", {}, maskEmails(pr.labels.join(", "))));
  if (pr.labels.some((l) => /alters[ -]reported[ -]results/i.test(l))) parts.push(el("p", { class: "warning" }, "Its author or a reviewer says it alters results reported in the paper."));
  if (pr.assignees.length) parts.push(el("h3", {}, "Assignees"), el("p", {}, pr.assignees.join(", ")));

  // Development: the issues it closes.
  const refs = closingRefs([pr.title, pr.body, ...commits.map((c) => c.message)], env.repo, env.endpoints.web);
  const closes = env.info.defaultBranch !== null && pr.base.ref === env.info.defaultBranch;
  const note = closingNotice(refs, closes, pr.base.ref, env.repo);
  // Phase 05: the research issues it says it fixes, closed by the merge as "fixed in the code".
  const researchIds = researchClosing(`${pr.title}\n${pr.body}`);
  const researchNote = researchIds.length ? toDom(researchClosingNotice(researchIds, closes, pr.base.ref)) : null;
  parts.push(el("h3", {}, "Development"));
  if (note) parts.push(toDom(note));
  if (researchNote) parts.push(researchNote);
  if (!note && !researchNote) parts.push(el("p", {}, "No issue named with a closing keyword (“Fixes #12”, “Fixes research#3”)."));

  // The papers, the tracing-map links it touches, the change in numbers.
  const papers = env.layer?.papers ?? [];
  parts.push(el("h3", {}, "Papers"), papers.length ? el("ul", {}, ...papers.map((p) => el("li", {}, p.slug ? el("a", { href: `/paper/${p.slug}/` }, p.title ?? p.doi) : `doi:${p.doi}`))) : el("p", {}, "The repository is not linked to a paper."));
  const research = el("div", { "aria-live": "polite" });
  parts.push(research);
  f.side.replaceChildren(...parts);

  // What needs the files: the maps (only when the repository has some), CODEOWNERS (signed in, to
  // suggest reviewers), the summary.
  const maps = await tracedMaps(env).catch(() => []);
  if (!maps.length && !f.signedIn) {
    research.replaceChildren(el("p", {}, el("a", { href: pullPath(env.repo, pr.number, "files") }, "The files changed"), ", in the registry's viewer."));
    return;
  }
  let files: T.FileChangeSummary[] = [];
  try {
    files = (await env.session.pulls.files(ref, pr.number, { perPage: 100 })).items;
  } catch {
    return;
  }
  const summary = summaryInWords(changeSummary(files, (p) => detectLanguage(p)));
  const blocks: Node[] = [el("h3", {}, "The change, in numbers"), ...summary.map((s) => el("p", { class: "summary-line" }, s))];
  if (maps.length) {
    try {
      const base = (await env.session.git.compare(ref, pr.base.sha, pr.head.sha, { perPage: 1 })).mergeBase;
      const touched = await changeTouches(env, files, base);
      const traced = commitTouches(touched, { subject: "This pull request", verb: "changes" });
      if (traced) blocks.push(toDom(traced));
    } catch {
      // said by the files tab
    }
  }
  research.replaceChildren(...blocks);

  if (f.signedIn && pr.state === "open") {
    const def = env.info.defaultBranch;
    let codeowners = null;
    if (def) {
      try {
        const tree = await env.session.git.tree(ref, def, { recursive: true });
        const path = codeownersPath(tree.entries.map((e) => e.path));
        if (path) codeowners = parseCodeowners((await textAt(env, def, path, 3 * 1024 * 1024)) ?? "", path);
      } catch {
        codeowners = null;
      }
    }
    if (codeowners) for (const o of ownersOfChange(codeowners, files.map((x) => x.path))) if (o.owner.kind === "user") (roles.codeOwners as Set<string>).add(o.owner.login.toLowerCase());
    const suggested = suggestReviewers({ codeowners, paths: files.map((x) => x.path), authors: env.layer?.reviewers ?? [], author: pr.author.login, requested: [...pr.requestedReviewers, ...reviews.approved, ...reviews.changesRequested] });
    const asks = suggested.filter((s) => s.login);
    if (asks.length) {
      suggestedBox.replaceChildren(
        el("h3", {}, "Suggested reviewers"),
        el("ul", { class: "reviewers" }, ...asks.map((s) => el("li", {}, button(`Ask ${s.login}`, () => act(f, said, "pull_edit", { number: pr.number, reviewers: { add: [s.login as string] } }), { class: "link" }), `: ${s.reasons.join("; ")}`))),
        el("p", { class: "explain" }, "GitHub asks reviews of the repository's collaborators only: a paper's author who is not one reviews here all the same, by commenting."),
      );
    }
  }
}

// ─── commits and checks ──────────────────────────────────────────────────────

async function mountCommits(slot: HTMLElement, env: CodeEnv, number: number): Promise<void> {
  const f = await pullFrame(slot, env, number, "commits");
  if (!f) return;
  try {
    const page = await env.session.pulls.commits(repoRef(env), number, { perPage: 100 });
    show(f.main, page.items.length ? h("div", null, ...commitList(env.repo, page.items)) : h("p", null, "No commit."), page.next ? h("p", null, "The first 100 commits; the others are in its history.") : null);
  } catch (e) {
    pullFailed(f.main, env, e, number);
  }
}

async function mountChecks(slot: HTMLElement, env: CodeEnv, number: number): Promise<void> {
  const f = await pullFrame(slot, env, number, "checks");
  if (!f) return;
  const ref = repoRef(env);
  try {
    const [runs, status] = await Promise.all([env.session.checks.runs(ref, f.pr.head.sha, { perPage: 100 }), env.session.checks.status(ref, f.pr.head.sha).catch(() => null)]);
    const items: El[] = [
      ...runs.items.map((r) => {
        const w = checkWords(r);
        return h("li", { class: w.tone }, w.text, r.output.title ? `, ${r.output.title}` : "", r.detailsUrl ? [" · ", h("a", { href: r.detailsUrl, rel: "nofollow noopener" }, "its log, at the source")] : null);
      }),
      ...(status?.statuses ?? []).map((s) => {
        const w = statusWords(s);
        return h("li", { class: w.tone }, w.text, s.targetUrl ? [" · ", h("a", { href: s.targetUrl, rel: "nofollow noopener" }, "its page, at the source")] : null);
      }),
    ];
    const sum = checksSummary(runs.items, status);
    show(
      f.main,
      h("h3", null, `Checks of ${f.pr.head.sha.slice(0, 7)}, the pull request's last commit`),
      h("p", { class: sum.failed ? "warning" : sum.total && !sum.running ? "ok" : "" }, sum.total ? `${sum.passed} passed, ${sum.failed} failed, ${sum.running} running, ${sum.skipped} skipped or neutral.` : "No check reported: the repository runs none on its pull requests, or they have not started."),
      items.length ? h("ul", { class: "checks" }, ...items) : null,
      h("p", { class: "explain" }, "The checks are the repository's own (its continuous integration, on GitHub) and the registry's (a licence, an environment, the paper's DOI, CITATION.cff, the tracing maps: read as text, never run); the registry never runs code. A check's log stays on its own service: the link goes there."),
      // Phase 10: the registry's view of this commit: its checks in words, the statuses posted to the registry.
      h("p", null, h("a", { href: repoPath(env.repo, "checks", [f.pr.head.sha]) }, "Every check of this commit in the registry"), ": what its checks found, the tests' environments, the statuses outside services posted."),
    );
  } catch (e) {
    pullFailed(f.main, env, e, number);
  }
}

pullTabs.conversation = mountConversation;
pullTabs.commits = mountCommits;
pullTabs.checks = mountChecks;
