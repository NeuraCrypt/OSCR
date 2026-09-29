// A pull request's conflicts, resolved in the browser (night phase 04, E6; docs/PULL_REQUESTS.md;
// D00-7): pull/<n>/conflicts.
//
// The three versions of each file come from GitHub on the reader's quota (the merge base, by one
// comparison; the base's changes since, by another; the texts are raw reads, not counted), the
// conflicting hunks are computed on the reader's CPU (src/lib/conflicts.ts), each conflict gets its
// choice (the pull request's lines, the base's, both, or the reader's own), and the result is ONE
// commit with two parents on the pull request's branch, made by GitHub as the person (phase 03's
// `commit` with `mergeParent`). A fork's branch takes it when the pull request allows edits by
// maintainers (GitHub decides). What the browser does not resolve is said, with the command line.
//
// Everything is text nodes (the files' lines are someone's text, masked for email addresses).

import { maskEmails } from "../../worker/forge/mask.ts";
import { base64, isBinary, isUtf8, text as utf8Text } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { declareCommit } from "../lib/commit-view.ts";
import { type Choice, commandLine, type FileMerge, hasMarkers, mergeFile, mergePlan, type ResolutionChange, resolutionFits, resolutionMessage, resolveFile, withMarkers } from "../lib/conflicts.ts";
import { pullPath } from "../lib/pulls.ts";
import { h } from "../lib/repo-view.ts";
import { el } from "./code-editor.ts";
import { show } from "./dom.ts";
import { confirmAction, signInLine, textAt } from "./pull-common.ts";
import { type CodeEnv, repoRef } from "./repo-code.ts";
import { pullFrame } from "./repo-pull.ts";
import { pullFailed, pullTabs } from "./repo-pulls.ts";

const CHOICES: [Exclude<Choice, object> | "own", string][] = [
  ["ours", "Keep the pull request's lines"],
  ["theirs", "Keep the base's lines"],
  ["ours-then-theirs", "Keep both, the pull request's first"],
  ["theirs-then-ours", "Keep both, the base's first"],
  ["own", "Write the lines myself"],
];

async function mountConflicts(slot: HTMLElement, env: CodeEnv, number: number): Promise<void> {
  const f = await pullFrame(slot, env, number, "conflicts");
  if (!f) return;
  const { pr } = f;
  const ref = repoRef(env);
  if (pr.state !== "open") {
    show(f.main, h("p", null, "The pull request is closed: there is nothing to resolve."));
    return;
  }
  const guide = (why: string[]) =>
    h(
      "section",
      { class: "conflict-guide" },
      h("h3", null, "With git, on your computer"),
      ...why.map((w) => h("p", { class: "warning" }, w)),
      h("pre", { class: "commands" }, commandLine({ baseRepo: `${env.repo.owner}/${env.repo.name}`, base: pr.base.ref, headRepo: pr.head.repo ? `${pr.head.repo.owner}/${pr.head.repo.name}` : null, head: pr.head.ref, web: env.endpoints.web }).join("\n")),
    );
  if (pr.mergeable === true) {
    show(f.main, h("p", { class: "ok" }, `No conflicts: ${pr.head.ref} merges into ${pr.base.ref} as it is.`), h("p", null, h("a", { href: pullPath(env.repo, number) }, "Back to the merge box")));
    return;
  }
  if (!pr.head.repo) {
    show(f.main, h("p", { class: "warning" }, "The fork this pull request came from was deleted: its branch cannot take a resolution."));
    return;
  }
  show(f.main, h("p", { "aria-live": "polite" }, "Reading the three versions…"));
  // The merge base, the pull request's changes from it, the base's changes from it (3 requests).
  let mergeBase: string;
  let ours: T.FileChangeSummary[];
  let theirs: T.FileChangeSummary[];
  try {
    const both = await env.session.git.compare(ref, pr.base.sha, pr.head.sha, { perPage: 100 });
    mergeBase = both.mergeBase;
    ours = both.files.items;
    theirs = mergeBase === pr.base.sha ? [] : (await env.session.git.compare(ref, mergeBase, pr.base.sha, { perPage: 100 })).files.items;
  } catch (e) {
    pullFailed(f.main, env, e, number);
    return;
  }
  const plan = mergePlan(ours, theirs);
  if (plan.problems.length || !plan.both.length) {
    show(
      f.main,
      h("p", null, plan.both.length ? "Some of its conflicts are beyond what the browser resolves:" : `GitHub says ${pr.head.ref} and ${pr.base.ref} conflict, but no file changed on both sides as text: resolve it with git.`),
      guide(plan.problems),
    );
    return;
  }
  const merges: FileMerge[] = [];
  for (const path of plan.both) {
    const [a, o, b] = await Promise.all([textAt(env, mergeBase, path), textAt(env, pr.head.sha, path), textAt(env, pr.base.sha, path)]);
    if (a === null || o === null || b === null) {
      show(f.main, guide([`${path} could not be read in one of its three versions (too large, or not text).`]));
      return;
    }
    merges.push(mergeFile(path, a, o, b));
  }
  const conflicts = merges.reduce((n, m) => n + m.conflicts, 0);
  // Each conflict's choice, by file; a file edited whole replaces its choices.
  const choices = merges.map((m) => Array.from({ length: m.conflicts }, () => null as Choice | null));
  const whole = new Map<number, string>();
  const said = el("div", { "aria-live": "polite" });
  const progress = el("p", { class: "status-line" });
  const count = () => {
    const done = choices.reduce((n, cs, i) => n + (whole.has(i) ? cs.length : cs.filter((c) => c !== null).length), 0);
    progress.textContent = `${done} of ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"} resolved, in ${merges.length} ${merges.length === 1 ? "file" : "files"}. ${plan.theirs.length ? `${plan.theirs.length} ${plan.theirs.length === 1 ? "file" : "files"} only ${pr.base.ref} changed ${plan.theirs.length === 1 ? "comes" : "come"} with the merge as ${pr.base.ref} has ${plan.theirs.length === 1 ? "it" : "them"}.` : ""}`;
    return done;
  };
  const sections = merges.map((m, i) => fileSection(m, i, choices[i], whole, pr, count));
  const commit = el("button", { type: "button", class: "primary", id: "resolve-commit" }, `Commit the merge on ${pr.head.ref}`);
  commit.addEventListener("click", async () => {
    if (count() < conflicts) {
      said.replaceChildren(el("p", { class: "warning" }, "Choose how each conflict is resolved first."));
      return;
    }
    const changes: ResolutionChange[] = [];
    for (let i = 0; i < merges.length; i++) {
      const text = whole.get(i) ?? resolveFile(merges[i], choices[i]);
      if (text === null) return;
      if (hasMarkers(text)) {
        said.replaceChildren(el("p", { class: "warning" }, `${merges[i].path} still holds a conflict marker (<<<<<<<, ======= or >>>>>>>): finish it first.`));
        return;
      }
      changes.push({ op: "put", path: merges[i].path, text });
    }
    // What only the base changed comes with the merge (the commit starts from the pull request's tree).
    for (const t of plan.theirs) {
      if (t.status === "removed") {
        changes.push({ op: "delete", path: t.path });
        continue;
      }
      if (t.previousPath) changes.push({ op: "delete", path: t.previousPath });
      try {
        const file = await env.session.git.readFile(ref, pr.base.sha, t.path, { maxBytes: 700 * 1024 });
        changes.push(isUtf8(file.bytes) && !isBinary(file.bytes) ? { op: "put", path: t.path, text: utf8Text(file.bytes) } : { op: "put", path: t.path, base64: base64(file.bytes) });
      } catch {
        said.replaceChildren(el("p", { class: "warning" }, `${t.path} could not be read on ${pr.base.ref}: merge with git instead.`));
        return;
      }
    }
    const too = resolutionFits(changes);
    if (too) {
      said.replaceChildren(el("p", { class: "warning" }, too));
      return;
    }
    const head = pr.head.repo as T.RepoRef;
    const d = declareCommit({ owner: head.owner, name: head.name, id: null }, { branch: pr.head.ref, base: pr.head.sha, mergeParent: pr.base.sha, message: resolutionMessage(pr.base.ref, pr.head.ref), changes }, pullPath(env.repo, number));
    await confirmAction(said, d);
  });
  show(f.main, h("p", null, `${pr.head.ref} and ${pr.base.ref} both changed the same lines. Choose, for each conflict, which lines the merge keeps; the registry then commits the merge on ${pr.head.ref}, as you, with both as its parents — GitHub makes the commit, and the pull request can then be merged.`));
  f.main.append(progress, ...sections, f.signedIn ? el("p", {}, commit) : signInLine("Sign in with GitHub to commit the resolution: the merge commit is made as you."), said, toNode(guide([])));
  count();
}

const toNode = (e: ReturnType<typeof h>): Node => {
  const box = document.createElement("div");
  show(box, e);
  return box;
};

/** One file's conflicts: each with its three versions and its choices; or the whole file, edited. */
function fileSection(m: FileMerge, i: number, choices: (Choice | null)[], whole: Map<number, string>, pr: T.PullRequest, count: () => number): HTMLElement {
  const section = el("section", { class: "file-diff conflict-file", id: `conflict-${i + 1}` });
  const head = el("header", {}, el("h3", {}, m.path), el("p", {}, `${m.conflicts} ${m.conflicts === 1 ? "conflict" : "conflicts"}`));
  const body = el("div", { class: "file-body" });
  let n = 0;
  let stable: string[] = [];
  const flushStable = () => {
    if (!stable.length) return;
    const shown = stable.length > 6 ? [...stable.slice(0, 2), `… ${stable.length - 4} lines alike …`, ...stable.slice(-2)] : stable;
    body.append(el("pre", { class: "conflict-context" }, maskEmails(shown.join("\n"))));
    stable = [];
  };
  for (const c of m.chunks) {
    if (c.kind !== "conflict") {
      stable.push(...c.lines);
      continue;
    }
    flushStable();
    const index = n++;
    const own = el("textarea", { class: "pull-text", rows: String(Math.min(12, Math.max(3, c.ours.length + c.theirs.length))), "aria-label": "The lines the merge keeps", hidden: "" });
    own.value = [...c.ours, ...c.theirs].join("\n");
    own.addEventListener("input", () => {
      choices[index] = { lines: own.value.split("\n") };
      count();
    });
    const radios = el("fieldset", { class: "choices" }, el("legend", {}, `Conflict ${index + 1}`));
    for (const [value, label] of CHOICES) {
      const id = `c-${i + 1}-${index + 1}-${value}`;
      const r = el("input", { type: "radio", name: `c-${i + 1}-${index + 1}`, id, value });
      r.addEventListener("change", () => {
        own.hidden = value !== "own";
        choices[index] = value === "own" ? { lines: own.value.split("\n") } : value;
        count();
      });
      radios.append(el("p", {}, r, " ", el("label", { for: id }, label)));
    }
    body.append(
      el(
        "div",
        { class: "conflict" },
        el("p", { class: "conflict-side" }, `The pull request (${pr.head.ref}):`),
        el("pre", { class: "conflict-ours" }, maskEmails(c.ours.join("\n")) || "(these lines deleted)"),
        el("p", { class: "conflict-side" }, `The base (${pr.base.ref}):`),
        el("pre", { class: "conflict-theirs" }, maskEmails(c.theirs.join("\n")) || "(these lines deleted)"),
        c.base.length ? el("details", {}, el("summary", {}, "As they were before both changes"), el("pre", {}, maskEmails(c.base.join("\n")))) : null,
        radios,
        own,
      ),
    );
  }
  flushStable();
  // Or the whole file, with git's markers, edited by hand.
  const edit = el("button", { type: "button", class: "link" }, "Edit the whole file instead");
  const area = el("textarea", { class: "pull-text", rows: "16", "aria-label": `${m.path}, with its conflict markers`, hidden: "" });
  edit.addEventListener("click", () => {
    area.hidden = !area.hidden;
    if (!area.hidden) {
      area.value = whole.get(i) ?? withMarkers(m, { ours: pr.head.ref, theirs: pr.base.ref });
      whole.set(i, area.value);
    } else whole.delete(i);
    count();
  });
  area.addEventListener("input", () => whole.set(i, area.value));
  section.append(head, body, el("p", { class: "conflict-whole" }, edit), area);
  return section;
}

pullTabs.conflicts = mountConflicts;
