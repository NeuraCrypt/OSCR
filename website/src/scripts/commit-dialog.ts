// The commit dialog (night phase 03, E3; docs/WEB_EDITING.md): what the editor, the upload page and
// the delete page open to commit a change, as GitHub's "Commit changes" dialog, inside the registry.
//
// - The message (GitHub's default as its placeholder) and the extended description.
// - Where the commit goes: the branch shown, or a new branch made at the version the change started
//   from, whose pull request is phase 04's (the answer names it: `pullRequest`). When the branch
//   moved since the change started, only a new branch is offered (or bringing the change onto the
//   latest version first, in the editor): the Worker's compare-and-swap would refuse the rest.
// - "Propose changes": when GitHub says the person may not write to the repository, their own copy
//   (a fork) takes the change, on a new branch.
// - Co-authors by their GitHub accounts, read from GitHub's public API in the reader's browser (one
//   request each, on the reader's quota): the Worker writes their no-reply addresses, never one
//   typed here. The sign-off (required when the repository says so).
// - The research link: the tracing-map links the change touches, before the commit
//   (src/lib/commit-view.ts `mapNotice`); a new branch is then chosen by default.
// - The secret warning (src/lib/secrets.ts): committing anyway needs a tick.
// - Then the one sentence the Worker repeats (declareCommit: its own validate and describe), the
//   confirmation, GitHub, and /forge/authorized/ (forge-client.ts). The session's CSRF token and the
//   GitHub login are read once, when the dialog opens (GET /api/account/me), and reused by the
//   start: no extra request.
// Everything is text nodes; like every browser script, it never names the platform.

import type { PayloadChange } from "../../worker/forge/service/act-commit.ts";
import { type FileTouch, declareCommit, mapNotice, touchedLinks } from "../lib/commit-view.ts";
import { branchProblem, coAuthorLogins, patchBranch } from "../lib/editor.ts";
import { findSecrets, secretsInWords } from "../lib/secrets.ts";
import type { CodeEnv } from "./repo-code.ts";
import { el } from "./code-editor.ts";
import { toDom } from "./dom.ts";
import { showConfirm, startAction } from "./forge-client.ts";

export interface DialogContext {
  env: CodeEnv;
  /** The branch the page shows, and its head now. */
  branch: string;
  head: string;
  /** The commit the change was made on (the head when the change started). */
  base: string;
  /** The repository's branches, for the new branch's name. */
  branches: readonly string[];
  defaultMessage: string;
  /** The change set, or why it cannot be committed yet (in words). */
  changes(): PayloadChange[] | string;
  /** The files and their map links (the research notice). */
  touches(): Promise<FileTouch[]>;
  /** The texts the commit writes, by path (the secret warning). */
  texts(): [string, string][];
  /** The editor's drafts the callback page drops once the commit is made. */
  drafts: string[];
  /** The page GitHub's answer comes back to. */
  back: string;
  onClose?(): void;
}

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

/** The signed-in reader's CSRF token and GitHub login (GET /api/account/me), or why not. */
async function whoIsHere(): Promise<{ csrf: string; login: string | null } | { message: string; signIn: boolean }> {
  try {
    const res = await fetch("/api/account/me", { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Json;
    if (!body.signed_in || typeof body.csrf !== "string") {
      return { message: "Sign in with GitHub to commit: the change is made as you, with your own GitHub account. Your change stays kept in this browser meanwhile.", signIn: true };
    }
    const login = typeof body.handles?.github === "string" ? body.handles.github : null;
    return { csrf: body.csrf, login };
  } catch {
    return { message: "The registry could not be reached: check the connection, then try again. Your change stays kept in this browser.", signIn: false };
  }
}

/** Co-authors' GitHub accounts, read from GitHub's public API (the reader's quota): their ids. */
async function resolveCoAuthors(env: CodeEnv, logins: readonly string[]): Promise<{ login: string; id: string }[] | string> {
  const out: { login: string; id: string }[] = [];
  for (const login of logins) {
    try {
      const res = await fetch(`${env.endpoints.api}/users/${encodeURIComponent(login)}`, { headers: { Accept: "application/vnd.github+json" } });
      if (res.status === 404) return `No GitHub account is named ${login}.`;
      if (!res.ok) return "GitHub did not answer about the co-authors: try again in a moment, or leave them out.";
      const u = (await res.json()) as Json;
      if (typeof u.login !== "string" || !Number.isSafeInteger(u.id)) return "GitHub's answer about a co-author is not readable.";
      if (u.type === "Organization") return `${u.login} is an organization: a co-author is a person.`;
      out.push({ login: u.login, id: String(u.id) });
    } catch {
      return "GitHub could not be reached for the co-authors: check the connection, or leave them out.";
    }
  }
  return out;
}

const radio = (name: string, value: string, checked: boolean, id: string) => {
  const r = el("input", { type: "radio", name, value, id });
  r.checked = checked;
  return r;
};

/** Opens the dialog in `root` (a section under the editor). */
export async function openCommitDialog(root: HTMLElement, ctx: DialogContext): Promise<void> {
  const changes = ctx.changes();
  if (typeof changes === "string") {
    root.replaceChildren(el("p", { class: "warning" }, changes));
    root.hidden = false;
    return;
  }
  root.hidden = false;
  root.replaceChildren(el("p", { "aria-live": "polite" }, "Preparing the commit…"));
  const who = await whoIsHere();
  if ("message" in who) {
    root.replaceChildren(el("p", { class: "warning" }, who.message), who.signIn ? el("p", {}, el("a", { href: "/account/" }, "Sign in")) : "");
    return;
  }
  const { env } = ctx;
  const moved = ctx.base !== ctx.head;
  const suggestion = patchBranch(who.login, ctx.branches);

  // The research link: the map links the change touches.
  let touched: ReturnType<typeof touchedLinks> = [];
  try {
    touched = touchedLinks(await ctx.touches());
  } catch {
    touched = [];
  }
  const notice = mapNotice(touched, ctx.branch);
  const secrets = ctx.texts().flatMap(([path, text]) => secretsInWords(path, findSecrets(text)));

  const message = el("input", { type: "text", id: "commit-message", name: "message", autocomplete: "off", maxlength: "500", placeholder: ctx.defaultMessage });
  const description = el("textarea", { id: "commit-description", name: "description", rows: "3", placeholder: "Add an optional extended description…" });
  const direct = radio("where", "direct", !moved && !touched.length, "commit-direct");
  const fresh = radio("where", "new", moved || touched.length > 0, "commit-new");
  if (moved) direct.disabled = true;
  const branchName = el("input", { type: "text", id: "commit-branch", name: "branch", autocomplete: "off", spellcheck: "false", maxlength: "200" });
  branchName.value = suggestion;
  const propose = el("input", { type: "checkbox", id: "commit-propose", name: "propose" });
  propose.checked = true;
  const coAuthors = el("input", { type: "text", id: "commit-coauthors", name: "coauthors", autocomplete: "off", spellcheck: "false", placeholder: "GitHub accounts, separated by commas" });
  const signOff = el("input", { type: "checkbox", id: "commit-signoff", name: "signoff" });
  if (env.info.signoffRequired) {
    signOff.checked = true;
    signOff.disabled = true;
  }
  const secretsOk = el("input", { type: "checkbox", id: "commit-secrets-ok" });
  const said = el("div", { "aria-live": "polite" });
  const confirmBox = el("div", {});
  const submit = el("button", { type: "submit" }, env.info.signoffRequired ? "Sign off and commit changes" : "Commit changes");
  const cancel = el("button", { type: "button" }, "Cancel");

  const form = el(
    "form",
    { class: "commit-dialog-form" },
    el("h2", {}, "Commit changes"),
    notice ? toDom(notice) : null,
    moved
      ? el(
          "p",
          { class: "warning" },
          `The branch ${ctx.branch} moved since this change started (its head is now ${ctx.head.slice(0, 7)}): the change goes on a new branch, made at the version you edited. Its comparison with ${ctx.branch} then shows both.`,
        )
      : null,
    secrets.length
      ? el(
          "div",
          { class: "secret-warning", role: "alert" },
          el("p", { class: "warning" }, "This change seems to hold a secret: anyone can read a public repository, and its history keeps it even after it is removed."),
          el("ul", {}, ...secrets.map((s) => el("li", {}, s))),
          el("p", {}, "Remove it and revoke it where it was issued; GitHub may also block the commit. "),
          el("p", {}, el("label", { for: "commit-secrets-ok" }, secretsOk, " These are not secrets (test values, or already revoked): commit anyway")),
        )
      : null,
    el("p", {}, el("label", { for: "commit-message" }, "Commit message"), el("br"), message),
    el("p", {}, el("label", { for: "commit-description" }, "Extended description"), el("br"), description),
    el(
      "fieldset",
      { class: "choices" },
      el("legend", {}, "Where the commit goes"),
      el(
        "label",
        { for: "commit-direct" },
        direct,
        ` Commit directly to the ${ctx.branch} branch.`,
        moved ? el("span", { class: "explain" }, "Not possible now: the branch moved since this change started.") : null,
      ),
      el(
        "label",
        { for: "commit-new" },
        fresh,
        " Create a new branch for this commit and start a pull request.",
        el("span", { class: "explain" }, `Made at the version you edited${touched.length ? "; recommended, since the change touches tracing-map links" : ""}. The comparison with ${ctx.branch} is shown next, in the registry.`),
      ),
      el("p", { class: "branch-name" }, el("label", { for: "commit-branch" }, "New branch's name"), el("br"), branchName),
    ),
    el(
      "p",
      {},
      el("label", { for: "commit-propose" }, propose, " If GitHub says I may not write to this repository, propose the change from my own copy of it (a fork), on a new branch there."),
    ),
    el("p", {}, el("label", { for: "commit-coauthors" }, "Co-authors (optional)"), el("br"), coAuthors),
    el(
      "p",
      {},
      el(
        "label",
        { for: "commit-signoff" },
        signOff,
        " Sign off: I certify that I may contribute this change under the repository's licence (the Developer Certificate of Origin).",
        env.info.signoffRequired ? el("span", { class: "explain" }, "The repository requires it for commits made from the web.") : null,
      ),
    ),
    el(
      "p",
      { class: "explain" },
      "GitHub makes the commit as you and signs it. Its author's address is the one your GitHub settings give to commits made on the web: GitHub's no-reply address when you keep yours private (Settings, Emails).",
    ),
    el("p", {}, submit, " ", cancel),
    said,
    confirmBox,
  );
  root.replaceChildren(form);
  message.focus();

  const whereNew = () => fresh.checked;
  const syncBranch = () => {
    branchName.disabled = !whereNew();
  };
  syncBranch();
  direct.addEventListener("change", syncBranch);
  fresh.addEventListener("change", syncBranch);
  cancel.addEventListener("click", () => {
    root.replaceChildren();
    root.hidden = true;
    ctx.onClose?.();
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const say = (text: string) => said.replaceChildren(el("p", { class: "warning" }, text));
    said.replaceChildren();
    const current = ctx.changes();
    if (typeof current === "string") return say(current);
    if (secrets.length && !secretsOk.checked) return say("Tick the box under the warning to commit what looks like a secret, or remove it first.");
    let newBranch: string | undefined;
    if (whereNew()) {
      const problem = branchProblem(branchName.value.trim(), ctx.branches);
      if (problem) return say(problem);
      newBranch = branchName.value.trim();
    }
    const logins = coAuthorLogins(coAuthors.value);
    if (typeof logins === "string") return say(logins);
    const resolved = logins.length ? await resolveCoAuthors(env, logins) : [];
    if (typeof resolved === "string") return say(resolved);
    const payload = {
      branch: ctx.branch,
      base: ctx.base,
      ...(newBranch ? { newBranch } : {}),
      propose: propose.checked,
      message: message.value.trim() || ctx.defaultMessage,
      ...(description.value.trim() ? { description: description.value } : {}),
      ...(resolved.length ? { coAuthors: resolved } : {}),
      ...(signOff.checked ? { signOff: true } : {}),
      changes: current,
    };
    const d = declareCommit({ owner: env.repo.owner, name: env.repo.name, id: env.info.key.id }, payload, ctx.back);
    if ("problem" in d) return say(d.problem);
    showConfirm(confirmBox, d.sentence, () => startAction(d.input, d.sentence, { csrf: who.csrf }, { drafts: ctx.drafts }));
    confirmBox.scrollIntoView({ block: "nearest" });
  });
}
