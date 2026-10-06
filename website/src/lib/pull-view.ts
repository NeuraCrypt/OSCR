// The pull request pages' view trees (night phase 04, E3–E4): pure, no DOM, testable in Node
// (tests/forge-pages/pull-view.test.ts). The scripts (src/scripts/repo-pulls.ts, repo-pull.ts,
// repo-forks.ts) show them through src/scripts/dom.ts: allowed elements only, text masked for email
// addresses (every title, body and comment is someone's text: it never becomes markup).
//
// - `declarePull`: any action of phase 04 declared with the Worker's own validate and sentence
//   (worker/forge/service/act-pulls.ts, act-forks.ts; D01-28), on the repository GitHub named by id.
// - The list's rows, the search's rows, a fork's row, the closing references in words, the fork's
//   status against its upstream.

import { ACTIONS } from "../../worker/forge/service/actions.ts";
import { isProblem, type ActionKind } from "../../worker/forge/service/types.ts";
import type * as T from "../../worker/forge/types.ts";
import { plural } from "./format.ts";
import { repoPath, type RepoCoords, type StartInput } from "./forge.ts";
import { type IssueRef, pullPath, pullStateInWords } from "./pulls.ts";
import { type El, h } from "./repo-view.ts";

// ─── one action, declared as the Worker checks it ────────────────────────────

export interface Declared {
  input: StartInput;
  sentence: string;
}

/** An action of phase 04 on a repository, by GitHub's id: the Worker's own validation and
 *  sentence, or the problem in words. */
export function declarePull(
  repo: RepoCoords & { id: string | null },
  kind: ActionKind,
  payload: Record<string, unknown>,
  back: string,
  extra: { branch?: string | null; expectedHead?: string | null } = {},
): Declared | { problem: string } {
  const spec = ACTIONS.get(kind);
  if (!spec) return { problem: "This action is not offered yet." };
  if (!repo.id) return { problem: "The repository's id is not known yet: reload the page." };
  const parsed = spec.validate(payload);
  if (isProblem(parsed)) return { problem: parsed.message };
  const refused = spec.checkTarget?.({ kind, repo: { forge: "github", id: repo.id }, branch: extra.branch ?? null, expectedHead: extra.expectedHead ?? null }) ?? null;
  if (refused) return { problem: refused.message };
  return {
    input: { kind, repo: { forge: "github", id: repo.id }, payload, back, branch: extra.branch ?? null, expectedHead: extra.expectedHead ?? null },
    sentence: `${spec.describe(parsed)}.`.replace(/\.\.$/, "."),
  };
}

// ─── the list ────────────────────────────────────────────────────────────────

/** "2026-09-20" of an ISO time. */
export const dayOf = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

/** The state's words and their tone (a status is said in words, never with a pill). */
export function stateOf(p: Pick<T.PullRequest, "state" | "draft" | "merged">): { words: string; tone: string } {
  const words = pullStateInWords(p);
  return { words, tone: p.merged ? "ok" : p.state === "open" && !p.draft ? "" : "muted" };
}

/** One pull request of the list: its state in words, its title (its page in the registry), its
 *  number, who opened it and when, its branches, labels and reviews asked. `select`: a checkbox for
 *  the bulk actions. */
export function pullRow(repo: RepoCoords, p: T.PullRequest, select = false): El {
  const s = stateOf(p);
  const from = p.head.repo && p.head.repo.owner.toLowerCase() !== repo.owner.toLowerCase() ? `${p.head.repo.owner}:${p.head.ref}` : p.head.ref;
  return h(
    "li",
    { class: "pull-row" },
    select ? h("input", { type: "checkbox", name: "pull", value: String(p.number), "aria-label": `Choose #${p.number}` }) : null,
    h(
      "div",
      null,
      h("p", { class: "title" }, h("span", { class: `pull-state ${s.tone}` }, s.words), " ", h("a", { href: pullPath(repo, p.number) }, p.title)),
      h(
        "p",
        { class: "line" },
        `#${p.number} opened ${dayOf(p.createdAt)} by ${p.author.login ?? p.author.name}`,
        ` · ${from} → ${p.base.ref}`,
        p.labels.length ? ` · Labels: ${p.labels.join(", ")}` : null,
        p.requestedReviewers.length ? ` · Review asked of ${p.requestedReviewers.join(", ")}` : null,
        p.merged && p.mergedAt ? ` · merged ${dayOf(p.mergedAt)}` : p.state === "closed" && p.closedAt ? ` · closed ${dayOf(p.closedAt)}` : null,
      ),
    ),
  );
}

/** One pull request as GitHub's search gives it (an issue's fields: no branches, no merge state). */
export function searchRow(repo: RepoCoords, i: T.Issue): El {
  return h(
    "li",
    { class: "pull-row" },
    h(
      "div",
      null,
      h("p", { class: "title" }, h("span", { class: `pull-state ${i.state === "open" ? "" : "muted"}` }, i.state === "open" ? "Open" : "Closed"), " ", h("a", { href: pullPath(repo, i.number) }, i.title)),
      h("p", { class: "line" }, `#${i.number} opened ${dayOf(i.createdAt)} by ${i.author.login ?? i.author.name}`, i.labels.length ? ` · Labels: ${i.labels.join(", ")}` : null, i.comments ? ` · ${plural(i.comments, "comment")}` : null),
    ),
  );
}

// ─── references ──────────────────────────────────────────────────────────────

/** The issues a pull request will close, in words, with their pages (the registry's for this
 *  repository's issues when phase 05 has them; for now the issue's number). */
export function closingNotice(refs: readonly IssueRef[], closes: boolean, base: string, repo: RepoCoords): El | null {
  if (!refs.length) return null;
  const names = refs.map((r) => (r.owner.toLowerCase() === repo.owner.toLowerCase() && r.name.toLowerCase() === repo.name.toLowerCase() ? `#${r.number}` : `${r.owner}/${r.name}#${r.number}`));
  return h(
    "p",
    { class: "closing" },
    closes
      ? `Merging it closes ${names.join(", ")} (its text says ${refs.length === 1 ? "so" : "so for each"}, with a closing keyword).`
      : `Its text names ${names.join(", ")} with a closing keyword, but GitHub closes issues only when a pull request merges into the default branch, not ${base}.`,
  );
}

/** The registry's research issues a pull request says it fixes ("Fixes research#12", phase 05): its
 *  merge into the default branch closes them as "fixed in the code", at the merge commit. */
export function researchClosingNotice(ids: readonly number[], closes: boolean, base: string): El {
  const links = ids.flatMap((id, i) => [i ? (i === ids.length - 1 ? " and " : ", ") : "", h("a", { href: `/research/${id}` }, `research#${id}`)]);
  return h(
    "p",
    { class: "closing" },
    closes
      ? ["Merging it in the registry closes the research ", ids.length === 1 ? "issue " : "issues ", ...links, ": fixed in the code, at the merge commit."]
      : ["Its text names the research ", ids.length === 1 ? "issue " : "issues ", ...links, ` with a closing keyword, but a merge closes issues only into the default branch, not ${base}.`],
  );
}

// ─── forks ───────────────────────────────────────────────────────────────────

/** One fork of the list: its page in the registry, its owner, when it was last pushed. */
export function forkRow(f: T.RepoInfo): El {
  return h(
    "li",
    null,
    h("a", { href: repoPath(f.ref) }, `${f.ref.owner}/${f.ref.name}`),
    f.pushedAt ? ` · last pushed ${dayOf(f.pushedAt)}` : null,
    f.description ? h("span", { class: "line" }, `, ${f.description}`) : null,
  );
}

/** A fork's branch against the same branch of its upstream: behind (the upstream's commits it
 *  lacks), ahead (its own), in words. */
export function forkStatusWords(branch: string, upstream: string, behind: number, ahead: number): string {
  if (!behind && !ahead) return `This fork's ${branch} is even with ${upstream}.`;
  if (behind && !ahead) return `This fork's ${branch} is ${plural(behind, "commit")} behind ${upstream}.`;
  if (ahead && !behind) return `This fork's ${branch} is ${plural(ahead, "commit")} ahead of ${upstream}.`;
  return `This fork's ${branch} is ${plural(ahead, "commit")} ahead of, and ${plural(behind, "commit")} behind, ${upstream}.`;
}
