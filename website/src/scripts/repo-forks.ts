// Forks in the /r/ shell (night phase 04, E3; docs/PULL_REQUESTS.md): the fork form (fork/), the
// fork list (forks/), and on a repository's home the fork's standing against its upstream, with
// "Sync fork" and "Contribute" (a pull request into the upstream).
//
// GitHub makes the fork and syncs it, as the person (act-forks.ts: one authorization each). The
// list is 1 request of the reader's quota (100 forks); a fork's standing 3 (the two branches, the
// comparison), read only on a fork's home. Signed out, the Worker is asked nothing.
//
// Everything is text nodes; like every browser script, it never names the platform.

import type * as T from "../../worker/forge/types.ts";
import { repoPath } from "../lib/forge.ts";
import { declarePull, forkRow, forkStatusWords } from "../lib/pull-view.ts";
import { newPullPath } from "../lib/pulls.ts";
import { h } from "../lib/repo-view.ts";
import { show } from "./dom.ts";
import { confirmAction, el, signedInHint, signInLine, whoIsHere } from "./pull-common.ts";
import { type CodeEnv, codeViews, failed, repoRef } from "./repo-code.ts";

/** Forks listed on one page (GitHub's largest page). */
export const FORKS_PAGE = 100;

// ─── fork/: the form ─────────────────────────────────────────────────────────

async function mountForkForm(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const full = `${env.repo.owner}/${env.repo.name}`;
  const intro = [
    h("h2", null, `Fork ${full}`),
    h("p", null, "A fork is your own copy of the repository, in your GitHub account or an organization of yours: you change it freely, then propose your changes back with a pull request. GitHub makes it, as you."),
    h(
      "ul",
      null,
      h("li", null, "A fork of a public repository is public. It stays when the original is deleted or made private (it then leaves its network)."),
      h("li", null, "GitHub keeps one fork of a repository per account: forking again finds the one you have."),
      h("li", null, "The tracing maps of its papers keep pointing at the original's commits; a fork has no paper until someone links one."),
    ),
  ];
  if (!signedInHint()) {
    show(slot, ...intro);
    slot.append(signInLine("Sign in with GitHub to fork it: the fork is made as you."));
    return;
  }
  show(slot, ...intro, h("p", { "aria-live": "polite" }, "Reading your account…"));
  const who = await whoIsHere();
  const login = "login" in who ? who.login : null;
  const owner = el("input", { type: "text", id: "fork-owner", name: "owner", autocomplete: "off", spellcheck: "false", maxlength: "39" });
  owner.value = login ?? "";
  const name = el("input", { type: "text", id: "fork-name", name: "name", autocomplete: "off", spellcheck: "false", maxlength: "100" });
  name.value = env.repo.name;
  const only = el("input", { type: "checkbox", id: "fork-only", name: "only" });
  only.checked = true;
  const said = el("div", { "aria-live": "polite" });
  const go = el("button", { type: "submit", class: "primary" }, "Create the fork");
  const form = el(
    "form",
    { class: "fork-form" },
    el("p", {}, el("label", { for: "fork-owner" }, "Into the account "), owner, el("span", { class: "explain" }, login ? ` (yours is ${login}; an organization's login puts it there)` : " (your login, or an organization's)")),
    el("p", {}, el("label", { for: "fork-name" }, "Named "), name),
    el("p", {}, only, " ", el("label", { for: "fork-only" }, `Copy the default branch only${env.info.defaultBranch ? ` (${env.info.defaultBranch})` : ""}; the other branches can be copied later from the Branches page`)),
    el("p", {}, go),
    said,
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const o = owner.value.trim();
    const payload: Record<string, unknown> = { defaultBranchOnly: only.checked };
    if (o && (!login || o.toLowerCase() !== login.toLowerCase())) payload.owner = o;
    if (name.value.trim() && name.value.trim() !== env.repo.name) payload.name = name.value.trim();
    void confirmAction(said, declarePull({ ...env.repo, id: env.info.key.id }, "fork", payload, repoPath(env.repo, "forks")));
  });
  show(slot, ...intro);
  if ("message" in who) slot.append(signInLine(who.message));
  else slot.append(form);
}

codeViews.fork = mountForkForm;

// ─── forks/: the list ────────────────────────────────────────────────────────

async function mountForks(slot: HTMLElement, env: CodeEnv): Promise<void> {
  show(slot, h("h2", null, "Forks"), h("p", { "aria-live": "polite" }, "Reading the forks…"));
  let page: T.Page<T.RepoInfo>;
  try {
    page = await env.session.repos.forks(repoRef(env), { perPage: FORKS_PAGE });
  } catch (e) {
    const box = document.createElement("div");
    show(slot, h("h2", null, "Forks"));
    slot.append(box);
    failed(box, e, `${env.endpoints.web}/${env.repo.owner}/${env.repo.name}/forks`, "forks");
    return;
  }
  show(
    slot,
    h("div", { class: "code-head" }, h("h2", null, "Forks"), h("p", { class: "file-actions" }, h("a", { href: repoPath(env.repo, "fork") }, "Fork it"))),
    env.info.parent ? h("p", null, "This repository is itself a fork of ", h("a", { href: repoPath(env.info.parent) }, `${env.info.parent.owner}/${env.info.parent.name}`), ".") : null,
    page.items.length
      ? h("p", { class: "status-line" }, `${page.items.length}${page.next ? "+" : ""} ${page.items.length === 1 ? "fork" : "forks"}, the most recent first${page.next ? ` (the first ${FORKS_PAGE})` : ""}.`)
      : h("p", null, "No public fork yet."),
    page.items.length ? h("ul", { class: "fork-list" }, ...page.items.map(forkRow)) : null,
  );
}

codeViews.forks = mountForks;

// ─── a fork's home: its standing, Sync fork, Contribute ─────────────────────

/** On a repository's home: "Fork · Forks", and for a fork, its default branch against the same
 *  branch of its upstream (3 requests), with Sync fork and Contribute. */
export async function mountForkStatus(slot: HTMLElement, env: CodeEnv): Promise<void> {
  const links = h("p", { class: "fork-links" }, h("a", { href: repoPath(env.repo, "fork") }, "Fork this repository"), " · ", h("a", { href: repoPath(env.repo, "forks") }, "Its forks"), " · ", h("a", { href: repoPath(env.repo, "pulls") }, "Pull requests"));
  const parent = env.info.parent;
  const branch = env.info.defaultBranch;
  if (!parent || !branch) {
    show(slot, links);
    return;
  }
  const upstream = `${parent.owner}/${parent.name}:${branch}`;
  show(slot, links, h("p", null, "Forked from ", h("a", { href: repoPath(parent) }, `${parent.owner}/${parent.name}`), "."));
  let behind = 0;
  let ahead = 0;
  try {
    const [up, mine] = await Promise.all([env.session.git.getBranch(parent, branch), env.session.git.getBranch(repoRef(env), branch)]);
    if (up.sha !== mine.sha) {
      const cmp = await env.session.git.compare(repoRef(env), mine.sha, up.sha, { perPage: 1 });
      behind = cmp.aheadBy;
      ahead = cmp.behindBy;
    }
  } catch {
    return; // the upstream's branch may not exist: nothing to say
  }
  const said = el("div", { "aria-live": "polite" });
  const status = el("p", { class: "status-line fork-status" }, forkStatusWords(branch, upstream, behind, ahead));
  const actions = el("p", {});
  if (behind && signedInHint()) {
    const sync = el("button", { type: "button", id: "fork-sync" }, "Sync fork");
    sync.addEventListener("click", () => void confirmAction(said, declarePull({ ...env.repo, id: env.info.key.id }, "fork_sync", { branch }, repoPath(env.repo))));
    actions.append(sync, ahead ? " (GitHub merges the two in a merge commit, or says where they conflict)" : " (GitHub moves it forward to the upstream's commits)");
  }
  if (ahead) {
    if (actions.childNodes.length) actions.append(" · ");
    actions.append(el("a", { href: newPullPath(parent, branch, `${env.repo.owner}:${branch}`) }, `Contribute: open a pull request into ${parent.owner}/${parent.name}`));
  }
  slot.append(status, ...(actions.childNodes.length ? [actions] : []), said);
}
