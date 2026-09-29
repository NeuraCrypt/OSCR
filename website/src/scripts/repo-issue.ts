// An issue's page in the /r/ shell (night phase 05, E5; docs/ISSUES.md): issues/<n>.
//
// Read in the reader's browser, on the reader's own GitHub quota (D00-5): the issue (1), its comments
// (1), its timeline (1), what blocks it (1), its sub-issues (1, when it has some), the labels' colours
// and the milestone (1 each, when it has some). A number that is a pull request goes to its page.
// Signed out, the Worker is asked nothing.
//
// Every write is one authorized action made by GitHub as the person (act-issues.ts): comment, edit
// or delete one's comment, react, edit the title and the text, tick a task, close as completed, not
// planned or a duplicate, reopen, labels, assignees, milestone, type, lock, pin, transfer, a sub-issue
// or a dependency, a branch for the issue. GitHub is the competitor: nothing here sends the reader
// there.
//
// Comments are someone's text: rendered by the registry's own Markdown renderer into view trees,
// "#12" and "research#3" linked, email addresses masked, never HTML, never run.

import { maskEmails } from "../../worker/forge/mask.ts";
import { issueBranchName, LOCK_REASONS } from "../../worker/forge/service/act-issues.ts";
import type * as T from "../../worker/forge/types.ts";
import { closedInWords, eventLine, issueHeader, issueTimeline, mentionsOf, participants, reactionsLine, sidebarFacts } from "../lib/issue-page.ts";
import { dayOf, linkRefs } from "../lib/issue-view.ts";
import {
  BUILT_IN_REPLIES,
  completionAt,
  fromGithub,
  fromResearch,
  isPlusOne,
  issueCompletions,
  issuePath,
  issuesPath,
  newIssuePath,
  personCompletions,
  quoteReply,
  REACTIONS,
  readReplies,
  saveReply,
  tasksOf,
  toggleTask,
  type IssueItem,
} from "../lib/issues.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { commentHead, type Roles } from "../lib/pull-page.ts";
import { pullPath } from "../lib/pulls.ts";
import { declarePull } from "../lib/pull-view.ts";
import { type El, h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { confirmAction, el, signedInHint, signInLine, whoIsHere } from "./pull-common.ts";
import { type CodeEnv, failed, repoRef } from "./repo-code.ts";
import { issueViews, readResearch } from "./repo-issues.ts";

interface Frame {
  env: CodeEnv;
  issue: T.Issue;
  comments: T.IssueComment[];
  back: string;
  signedIn: boolean;
  me: string | null;
}

const button = (label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement => {
  const b = el("button", { type: "button", ...attrs }, label);
  b.addEventListener("click", onClick);
  return b;
};

function act(f: Frame, box: HTMLElement, kind: Parameters<typeof declarePull>[1], payload: Record<string, unknown>): void {
  void confirmAction(box, declarePull({ ...f.env.repo, id: f.env.info.key.id }, kind, payload, f.back));
}

/** Someone's Markdown as the registry renders it, references linked. */
async function body(text: string, env: CodeEnv): Promise<El> {
  if (!text.trim()) return h("p", { class: "muted-note" }, "No description.");
  return linkRefs((await renderMarkdown(text, { repo: env.repo })).el, env.repo);
}

const storage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

async function mountIssue(slot: HTMLElement, env: CodeEnv, number: number): Promise<void> {
  show(slot, h("p", { "aria-live": "polite" }, `Reading the issue #${number}…`));
  const ref = repoRef(env);
  let issue: T.Issue;
  try {
    issue = await env.session.issues.get(ref, number);
  } catch (e) {
    failed(slot, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/issues/${number}`, "issue");
    return;
  }
  if (issue.isPullRequest) {
    // GitHub numbers issues and pull requests together: this number is a pull request.
    location.replace(pullPath(env.repo, number));
    return;
  }
  document.title = `${issue.title} · #${issue.number} · ${env.repo.owner}/${env.repo.name}`;
  const [comments, events, blockedBy, subIssues, labels, milestones] = await Promise.all([
    env.session.issues.comments(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.IssueComment[]),
    env.session.issues.timeline(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.TimelineEvent[]),
    env.session.issues.blockedBy(ref, number, { perPage: 50 }).then((p) => p.items).catch(() => [] as T.Issue[]),
    issue.subIssues?.total ? env.session.issues.subIssues(ref, number, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.Issue[]) : Promise.resolve([] as T.Issue[]),
    issue.labels.length || signedInHint() ? env.session.issues.labels(ref, { perPage: 100 }).then((p) => p.items).catch(() => [] as T.Label[]) : Promise.resolve([] as T.Label[]),
    issue.milestone !== null || signedInHint() ? env.session.issues.milestones(ref, "all", { perPage: 100 }).then((p) => p.items).catch(() => [] as T.Milestone[]) : Promise.resolve([] as T.Milestone[]),
  ]);
  const signedIn = signedInHint();
  const who = signedIn ? await whoIsHere() : null;
  const f: Frame = { env, issue, comments, back: issuePath(env.repo, number), signedIn, me: who && "login" in who ? who.login : null };
  const roles: Roles = { author: issue.author.login, paperAuthors: new Set((env.layer?.reviewers ?? []).map((r) => r.login.toLowerCase())), codeOwners: new Set() };
  const colors = new Map(labels.map((l) => [l.name.toLowerCase(), l.color]));

  // The description and the timeline.
  const parts: El[] = [
    h(
      "div",
      { class: "comment issue-description", id: "issue-body" },
      commentHead(issue.author, issue.createdAt, roles, "opened it"),
      await body(issue.body, env),
      reactionsLine(issue.reactions),
    ),
  ];
  for (const item of issueTimeline(comments, events)) {
    if (item.kind === "event") {
      parts.push(eventLine(item.event, env.repo));
      continue;
    }
    const c = item.comment;
    parts.push(
      h(
        "div",
        { class: "comment", id: `issuecomment-${c.id}`, "data-comment": c.id },
        commentHead(c.author, c.createdAt, roles, c.updatedAt && c.updatedAt !== c.createdAt ? "commented (edited)" : "commented"),
        await body(c.body, env),
        reactionsLine(c.reactions),
      ),
    );
  }
  const closed = closedInWords(issue, comments);
  const branch = issueBranchName(number, issue.title);
  let branchExists = false;
  try {
    await env.session.git.getBranch(ref, branch);
    branchExists = true;
  } catch {
    branchExists = false;
  }
  const facts = sidebarFacts(
    env.repo,
    issue,
    {
      colors,
      milestone: milestones.find((m) => m.number === issue.milestone) ?? null,
      subIssues,
      blockedBy,
      people: participants(issue, comments),
      branch: branchExists ? branch : null,
      mentions: mentionsOf(events, env.repo),
    },
    (name) => issuesPath(env.repo, `is:issue is:open label:"${name}"`),
  );
  show(
    slot,
    issueHeader(issue),
    h(
      "div",
      { class: "record pull-record" },
      h(
        "div",
        { class: "body", id: "issue-main" },
        h("section", { class: "timeline", "aria-label": "Conversation" }, ...parts),
        closed ? h("p", { class: "status-line" }, closed) : null,
        h("div", { id: "issue-tasks" }),
        h("div", { id: "comment-form" }),
      ),
      h("div", { class: "sidebar", id: "issue-side" }, ...facts, h("div", { id: "issue-actions" })),
    ),
  );
  const main = slot.querySelector<HTMLElement>("#issue-main") as HTMLElement;
  wireComments(f, main);
  tasksPanel(f, slot.querySelector<HTMLElement>("#issue-tasks") as HTMLElement);
  await commentForm(f, slot.querySelector<HTMLElement>("#comment-form") as HTMLElement);
  sideActions(f, slot.querySelector<HTMLElement>("#issue-actions") as HTMLElement, labels, milestones, branchExists ? null : branch);
}

/** Under each comment (signed in): react, quote, and for one's own, edit and delete. */
function wireComments(f: Frame, main: HTMLElement): void {
  const text = () => main.ownerDocument.querySelector<HTMLTextAreaElement>("#comment-text");
  const blocks: [HTMLElement, T.IssueComment | null][] = [[main.querySelector<HTMLElement>("#issue-body") as HTMLElement, null]];
  for (const c of f.comments) {
    const node = main.querySelector<HTMLElement>(`[data-comment="${c.id}"]`);
    if (node) blocks.push([node, c]);
  }
  for (const [node, c] of blocks) {
    const said = el("div", { "aria-live": "polite" });
    const bar = el("p", { class: "comment-actions" });
    const quote = button("Quote", () => {
      const t = text();
      if (!t) return;
      // A quote is shown: its addresses stay hidden (CLAUDE.md), the quote saying "[email hidden]".
      t.value = `${t.value}${t.value && !t.value.endsWith("\n") ? "\n\n" : ""}${quoteReply(maskEmails(c ? c.body : f.issue.body))}`;
      t.focus();
    });
    bar.append(quote, " ", el("a", { href: newIssuePath(f.env.repo, { title: maskEmails(`Follow-up: ${f.issue.title}`).slice(0, 200), body: `${quoteReply(maskEmails(c ? c.body : f.issue.body)).slice(0, 6000)}From #${f.issue.number}.` }) }, "Reference in a new issue"));
    if (f.signedIn) {
      const pick = el("select", { "aria-label": "React" });
      pick.append(el("option", { value: "" }, "React…"), ...REACTIONS.map((r) => el("option", { value: r.key }, `${r.char} ${r.words}`)));
      const react = button("Add", () => pick.value && act(f, said, "issue_react", { number: f.issue.number, ...(c ? { comment: c.id } : {}), reaction: pick.value }));
      const unreact = button("Take mine back", () => pick.value && act(f, said, "issue_react", { number: f.issue.number, ...(c ? { comment: c.id } : {}), reaction: pick.value, remove: true }));
      bar.append(" · ", pick, " ", react, " ", unreact);
      const mine = f.me !== null && (c ? c.author.login : f.issue.author.login)?.toLowerCase() === f.me.toLowerCase();
      if (mine || !c) {
        const edit = button("Edit", () => editBox(f, node, c, said));
        bar.append(" · ", edit);
      }
      if (mine && c) bar.append(" ", button("Delete", () => act(f, said, "issue_comment", { number: f.issue.number, comment: c.id, delete: true })));
    }
    node.append(bar, said);
  }
}

/** The text's editor, in place: the description (and the title), or one's comment. */
function editBox(f: Frame, node: HTMLElement, c: T.IssueComment | null, said: HTMLElement): void {
  if (node.querySelector(".edit-box")) return;
  // A text that holds an email address is never shown whole, and a masked copy written back would
  // lose the address (D04-16): such a text is edited on GitHub, said.
  const raw = c ? c.body : `${f.issue.title}\n${f.issue.body}`;
  if (maskEmails(raw) !== raw) {
    said.replaceChildren(el("p", { class: "explain" }, "This text holds an email address, which the registry never shows: it cannot be edited here without losing it. Its author edits it ", el("a", { href: `${f.env.endpoints.web}/${f.env.repo.owner}/${f.env.repo.name}/issues/${f.issue.number}`, rel: "noopener noreferrer" }, "at the source"), "."));
    return;
  }
  const area = el("textarea", { class: "pull-text", rows: "8", "aria-label": c ? "The comment" : "The description" });
  area.value = c ? c.body : f.issue.body;
  const title = el("input", { type: "text", maxlength: "256", "aria-label": "The title" });
  title.value = f.issue.title;
  const save = button("Save", () => {
    if (c) act(f, said, "issue_comment", { number: f.issue.number, comment: c.id, body: area.value });
    else {
      const payload: Record<string, unknown> = { number: f.issue.number };
      if (title.value.trim() !== f.issue.title) payload.title = title.value;
      if (area.value !== f.issue.body) payload.body = area.value;
      act(f, said, "issue_edit", payload);
    }
  });
  const box = el("div", { class: "edit-box" }, ...(c ? [] : [el("p", {}, title)]), area, el("p", {}, save, " ", button("Cancel", () => box.remove())));
  node.append(box);
}

/** The task list: its boxes, ticked in the browser, saved as ONE edit of the text. */
function tasksPanel(f: Frame, into: HTMLElement): void {
  const tasks = tasksOf(f.issue.body);
  if (!tasks.length) return;
  const boxes = tasks.map((t, i) => {
    const b = el("input", { type: "checkbox", id: `task-${i}` });
    b.checked = t.checked;
    if (!f.signedIn) b.disabled = true;
    return el("li", {}, el("label", { for: `task-${i}` }, b, ` ${t.text}`));
  });
  const said = el("div", { "aria-live": "polite" });
  const save = f.signedIn
    ? button("Save the ticks", () => {
        let text: string | null = f.issue.body;
        boxes.forEach((li, i) => {
          const b = li.querySelector("input") as HTMLInputElement;
          if (text !== null && b.checked !== tasks[i].checked) text = toggleTask(text, i, b.checked);
        });
        if (text === null || text === f.issue.body) {
          said.replaceChildren(el("p", {}, "Nothing changed."));
          return;
        }
        act(f, said, "issue_edit", { number: f.issue.number, body: text });
      })
    : null;
  const done = tasks.filter((t) => t.checked).length;
  into.replaceChildren(
    el(
      "section",
      { class: "task-panel", "aria-label": "Tasks" },
      el("h3", {}, `Tasks: ${done} of ${tasks.length} done`),
      el("ul", { class: "task-list" }, ...boxes),
      save ? el("p", {}, save, el("span", { class: "explain" }, " (one edit of the description; a task that names an issue completes when that issue closes)")) : el("p", { class: "explain" }, "Signed in, the author and the people who triage tick them here."),
      said,
    ),
  );
}

async function commentForm(f: Frame, into: HTMLElement): Promise<void> {
  if (!f.signedIn) {
    into.replaceChildren(signInLine("Sign in with GitHub to comment: the comment is posted as you."));
    return;
  }
  if (f.issue.locked) {
    into.append(el("p", { class: "explain" }, `The conversation is locked${f.issue.lockReason ? ` as ${f.issue.lockReason}` : ""}: only the repository's collaborators comment now.`));
  }
  const text = el("textarea", { class: "pull-text", id: "comment-text", rows: "6", "aria-label": "Your comment" });
  const preview = el("div", { class: "pull-preview", hidden: "" });
  const said = el("div", { "aria-live": "polite" });
  const complete = el("div", { class: "completions", "aria-live": "polite" });
  // Saved replies: the built-in ones and this browser's.
  const replies = el("select", { "aria-label": "Saved replies" });
  const fill = () => {
    replies.replaceChildren(el("option", { value: "" }, "Saved replies…"), ...[...BUILT_IN_REPLIES, ...readReplies(storage())].map((r, i) => el("option", { value: String(i) }, r.name)));
  };
  fill();
  replies.addEventListener("change", () => {
    const all = [...BUILT_IN_REPLIES, ...readReplies(storage())];
    const r = all[Number(replies.value)];
    if (r) text.value = `${text.value}${text.value && !text.value.endsWith("\n") ? "\n" : ""}${r.body}`;
    replies.value = "";
    text.focus();
  });
  const replyName = el("input", { type: "text", maxlength: "100", placeholder: "A name for this reply", "aria-label": "The reply's name" });
  const keep = button("Save as a reply", () => {
    said.replaceChildren(el("p", {}, saveReply(storage(), { name: replyName.value, body: text.value }) ? "Saved in this browser." : "Not saved: give it a name and a text (100 replies at most)."));
    fill();
  });
  // "#" and "@": the repository's recent issues and the research ones, the people who took part.
  let known: IssueItem[] | null = null;
  text.addEventListener("input", async () => {
    const at = completionAt(text.value, text.selectionStart ?? text.value.length);
    if (!at) {
      complete.replaceChildren();
      return;
    }
    let options: [string, string][] = [];
    if (at.kind === "#") {
      if (!known) {
        known = [];
        try {
          known = (await f.env.session.issues.list(repoRef(f.env), { state: "all", sort: "updated", includePulls: true }, { perPage: 50 })).items.map(fromGithub);
        } catch {
          known = [];
        }
        known.push(...(await readResearch(f.env)).items.map(fromResearch));
      }
      options = issueCompletions(at.query, known).map((i) => [`${i.kind === "research" ? "research" : ""}#${i.number}`, `${i.kind === "research" ? "research" : ""}#${i.number} ${i.title}`]);
    } else {
      options = personCompletions(at.query, participants(f.issue, f.comments)).map((p) => [`@${p}`, `@${p}`]);
    }
    complete.replaceChildren(
      ...options.map(([insert, label]) =>
        button(label, () => {
          const caret = text.selectionStart ?? text.value.length;
          text.value = `${text.value.slice(0, at.start)}${insert} ${text.value.slice(caret)}`;
          complete.replaceChildren();
          text.focus();
        }, { class: "link" }),
      ),
    );
  });
  const previewButton = button("Preview", async () => {
    if (!preview.hidden) {
      preview.hidden = true;
      previewButton.textContent = "Preview";
      return;
    }
    preview.replaceChildren(toDom(await body(text.value, f.env)));
    preview.hidden = false;
    previewButton.textContent = "Back to the text";
  });
  const send = button(
    "Comment",
    () => {
      if (isPlusOne(text.value)) {
        said.replaceChildren(
          el("p", {}, "A “+1” says more as a reaction: it counts, and nobody gets a message. ",
            button("React 👍 instead", () => act(f, said, "issue_react", { number: f.issue.number, reaction: "+1" })), " ",
            button("Comment anyway", () => act(f, said, "issue_comment", { number: f.issue.number, body: text.value }))),
        );
        return;
      }
      act(f, said, "issue_comment", { number: f.issue.number, body: text.value });
    },
    { class: "primary", id: "comment-send" },
  );
  into.append(
    el(
      "section",
      { class: "comment-form", "aria-label": "Add a comment" },
      el("h3", {}, "Add a comment"),
      text,
      complete,
      preview,
      el("p", {}, send, " ", previewButton, " ", replies),
      el("p", { class: "explain" }, replyName, " ", keep, " Saved replies are kept in this browser only."),
      said,
    ),
  );
}

/** The sidebar's actions (signed in): close with a reason, reopen, labels, assignees, milestone, type,
 *  lock, pin, transfer, sub-issues, dependencies, a branch, duplicate the issue. */
function sideActions(f: Frame, into: HTMLElement, labels: readonly T.Label[], milestones: readonly T.Milestone[], branch: string | null): void {
  const { issue, env } = f;
  const dup = el("p", { class: "summary-line" }, el("a", { href: newIssuePath(env.repo, { title: maskEmails(issue.title), body: maskEmails(issue.body).slice(0, 6000), labels: issue.labels.join(",") }) }, "Duplicate this issue"), ": a new one, prefilled (no comments).");
  if (!f.signedIn) {
    into.replaceChildren(el("h3", {}, "Act"), el("p", { class: "summary-line" }, "Signed in, you comment, react, and — as GitHub allows your account — close, label, assign, lock, pin or transfer it here."), dup);
    return;
  }
  const said = el("div", { "aria-live": "polite" });
  const n = issue.number;
  const sections: HTMLElement[] = [];
  // Close, reopen.
  if (issue.state === "open") {
    const dupOf = el("input", { type: "text", size: "6", placeholder: "#", "aria-label": "Duplicate of" });
    sections.push(
      el("p", {}, button("Close as completed", () => act(f, said, "issue_edit", { number: n, state: "closed", reason: "completed" })), " ", button("Close as not planned", () => act(f, said, "issue_edit", { number: n, state: "closed", reason: "not_planned" }))),
      el("p", {}, "Duplicate of ", dupOf, " ", button("Close as a duplicate", () => act(f, said, "issue_edit", { number: n, state: "closed", reason: "duplicate", duplicateOf: Number(dupOf.value.replace(/^#/, "")) }))),
    );
  } else sections.push(el("p", {}, button("Reopen", () => act(f, said, "issue_edit", { number: n, state: "open" }))));
  // Labels.
  if (labels.length) {
    const pick = el("select", { "aria-label": "A label" }, ...labels.map((l) => el("option", { value: l.name }, l.name)));
    sections.push(el("p", {}, "Label ", pick, " ", button("Add", () => act(f, said, "issue_edit", { number: n, labels: { add: [pick.value] } })), " ", button("Remove", () => act(f, said, "issue_edit", { number: n, labels: { remove: [pick.value] } }))));
  }
  // Assignees.
  const person = el("input", { type: "text", size: "12", placeholder: "GitHub login", "aria-label": "A GitHub login" });
  sections.push(el("p", {}, "Assign ", person, " ", button("Add", () => act(f, said, "issue_edit", { number: n, assignees: { add: [person.value.replace(/^@/, "").trim()] } })), " ", button("Remove", () => act(f, said, "issue_edit", { number: n, assignees: { remove: [person.value.replace(/^@/, "").trim()] } }))));
  // Milestone.
  const ms = el("select", { "aria-label": "A milestone" }, el("option", { value: "" }, "None"), ...milestones.filter((m) => m.state === "open").map((m) => el("option", { value: String(m.number) }, m.title)));
  sections.push(el("p", {}, "Milestone ", ms, " ", button("Set", () => act(f, said, "issue_edit", { number: n, milestone: ms.value ? Number(ms.value) : null }))));
  // Type (an organization's).
  const type = el("input", { type: "text", size: "10", placeholder: "Bug, Task…", "aria-label": "The issue's type" });
  sections.push(el("p", {}, "Type ", type, " ", button("Set", () => act(f, said, "issue_edit", { number: n, type: type.value.trim() || null }))));
  // Relationships.
  const other = el("input", { type: "text", size: "6", placeholder: "#", "aria-label": "Another issue" });
  const num = () => Number(other.value.replace(/^#/, ""));
  sections.push(
    el(
      "p",
      {},
      "Issue ",
      other,
      " ",
      button("Add as a sub-issue", () => act(f, said, "issue_relation", { number: n, sub: { add: num() } })),
      " ",
      button("Remove", () => act(f, said, "issue_relation", { number: n, sub: { remove: num() } })),
      " ",
      button("Blocked by it", () => act(f, said, "issue_relation", { number: n, blockedBy: { add: num() } })),
      " ",
      button("Not blocked by it", () => act(f, said, "issue_relation", { number: n, blockedBy: { remove: num() } })),
    ),
    el("p", { class: "summary-line" }, el("a", { href: newIssuePath(env.repo, { parent: String(n) }) }, "Create a sub-issue")),
  );
  // Lock, pin, transfer.
  const reason = el("select", { "aria-label": "The lock's reason" }, el("option", { value: "" }, "No reason"), ...LOCK_REASONS.map((r) => el("option", { value: r }, r)));
  sections.push(
    issue.locked
      ? el("p", {}, button("Unlock the conversation", () => act(f, said, "issue_lock", { number: n, locked: false })))
      : el("p", {}, reason, " ", button("Lock the conversation", () => act(f, said, "issue_lock", { number: n, locked: true, ...(reason.value ? { reason: reason.value } : {}) }))),
    el("p", {}, button("Pin it", () => act(f, said, "issue_pin", { number: n, pinned: true })), " ", button("Unpin it", () => act(f, said, "issue_pin", { number: n, pinned: false }))),
  );
  const to = el("input", { type: "text", size: "14", placeholder: "another repository", "aria-label": "The repository it moves to" });
  sections.push(el("p", {}, "Transfer to ", to, " ", button("Transfer", () => act(f, said, "issue_transfer", { number: n, to: to.value.trim() })), el("span", { class: "explain" }, ` (a repository of ${env.repo.owner})`)));
  // A branch for the issue.
  if (branch && env.info.defaultBranch) {
    sections.push(el("p", {}, button(`Create the branch ${branch}`, () => act(f, said, "issue_branch", { number: n, name: branch, from: env.info.defaultBranch })), el("span", { class: "explain" }, ` from ${env.info.defaultBranch}`)));
  }
  into.replaceChildren(el("h3", {}, "Act"), el("p", { class: "explain" }, "Each is one authorization on GitHub, as you; GitHub decides what your account may do."), ...sections, dup, said);
}

issueViews.page = mountIssue;

export { dayOf };
