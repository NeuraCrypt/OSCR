// A research issue copied to GitHub as an ordinary issue (night phase 05, E2; D00-6, D05-*): the
// registry keeps its research issues, and never posts on GitHub on its own (D00-6: "OSCR never acts
// on GitHub on its own initiative"); its AUTHOR may ask for a copy on the repository, one at a time.
//
//   research_copy  {id}: GitHub opens an issue as the person, in the repository the research issue is
//                  about (the page declares it; it must be that one), titled like it, its text followed
//                  by the paper's DOI, the file and lines at the commit, and the registry's reference
//                  ("research#12"); the label of its type ("code–paper mismatch"…) when the person may
//                  label. The research issue then names the copy (2 rows: its row, the action row).
//
// A second copy is refused (the research issue names the first); a research issue about code
// hosted elsewhere has no GitHub repository to copy to: its page says so.

import { GitBackendError } from "../errors.ts";
import type { Issue } from "../types.ts";
import { declaredRepo, onDeclaredRepo } from "./act-pulls.ts";
import { issuePage } from "./act-issues.ts";
import { issueById, TYPE_WORDS, updateIssue, type IssueRow, type ResearchType } from "./research-core.ts";
import { first } from "./store.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec } from "./types.ts";

/** The label a copy carries: the type's name, in lower case ("code–paper mismatch"). */
export const TYPE_LABEL: Readonly<Record<ResearchType, string>> = {
  code_error: "code error",
  mismatch: "code–paper mismatch",
  reproduction: "reproduction failure",
};

/** GitHub's permalink of a file's lines at a commit. */
const permalink = (repoPath: string, commit: string, path: string, start: number | null, end: number | null): string =>
  `https://github.com/${repoPath}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}${start ? `#L${start}${end && end !== start ? `-L${end}` : ""}` : ""}`;

/** The copy's text: the research issue's own, then what it is about, in plain Markdown. */
export function copyBody(i: Pick<IssueRow, "id" | "type" | "body" | "paper_id" | "repo_path" | "commit_sha" | "path" | "start_line" | "end_line" | "paragraph" | "section">): string {
  const about = [`**${TYPE_WORDS[i.type]}**, about the paper https://doi.org/${i.paper_id.replace(/^doi:/, "")}.`];
  if (i.paragraph) about.push(`The paper: paragraph ${i.paragraph}${i.section ? ` (${i.section})` : ""}.`);
  if (i.path) {
    const lines = i.start_line ? (i.end_line && i.end_line !== i.start_line ? `lines ${i.start_line}–${i.end_line}` : `line ${i.start_line}`) : "";
    about.push(`The code: ${i.commit_sha && i.repo_path ? permalink(i.repo_path, i.commit_sha, i.path, i.start_line, i.end_line) : `\`${i.path}\``}${lines ? ` (${lines})` : ""}.`);
  }
  about.push(`Reported in the registry as research#${i.id}.`);
  return `${i.body.trim()}${i.body.trim() ? "\n\n---\n\n" : ""}${about.join("\n")}`.slice(0, 65_000);
}

export interface CopyDone {
  id: string;
  research: number;
  number: number;
  page: string;
  notes: string[];
  links: { href: string; text: string }[];
}

export const researchCopySpec: ActionSpec<{ id: number }, CopyDone> = {
  kind: "research_copy",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    const p = payload as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || typeof p.id !== "number" || !Number.isInteger(p.id) || p.id < 1 || p.id > 2 ** 31) {
      return new ForgeProblem(400, "bad_payload", "Name the research issue by its number.");
    }
    return { id: p.id };
  },
  describe: (p) => `Copy the research issue research#${p.id} to GitHub as an ordinary issue of its repository`,
  async perform(ctx) {
    const issue = await first<IssueRow>(issueById(ctx.db, ctx.parsed.id));
    if (!issue) throw new ForgeProblem(404, "not_found", "The registry has no research issue of this number: nothing was done.");
    if (issue.author_id !== ctx.user.id) throw new ForgeProblem(403, "not_author", "Only the research issue's author copies it to GitHub: nothing was done.");
    if (issue.github_number) throw new ForgeProblem(409, "already_copied", `It was copied already, as the issue #${issue.github_number}: nothing was done.`);
    if (!issue.repo_id) throw new ForgeProblem(409, "not_on_github", "Its code is not on GitHub: there is no repository to copy it to. Nothing was done.");
    const target = ctx.target.repo;
    if (!target || !("id" in target) || target.id !== issue.repo_id || target.forge !== issue.forge) {
      throw new ForgeProblem(400, "bad_request", "This copy was prepared for another repository: nothing was done.");
    }
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    let made: Issue;
    try {
      made = await ctx.session.issues.create(info.ref, { title: issue.title, body: copyBody({ ...issue, repo_path: `${info.ref.owner}/${info.ref.name}` }), labels: [TYPE_LABEL[issue.type]] });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "gone") throw new ForgeProblem(410, "issues_off", "The repository's issues are turned off on GitHub: nothing was done. The research issue stays in the registry.");
      if (e instanceof GitBackendError && e.code === "forbidden") throw new ForgeProblem(403, "forbidden", "GitHub says your account may not open an issue there: nothing was done.");
      throw e;
    }
    const notes = made.labels.length ? [] : [`GitHub opened it without the label “${TYPE_LABEL[issue.type]}”: only people who triage the repository's issues set labels.`];
    const page = issuePage(info.ref, made.number);
    const at = Math.floor(ctx.t);
    return {
      result: {
        id: info.key.id,
        research: issue.id,
        number: made.number,
        page,
        notes,
        links: [
          { href: page, text: `The ordinary issue #${made.number}` },
          { href: `/research/${issue.id}`, text: `The research issue research#${issue.id}` },
        ],
      },
      writes: [updateIssue(ctx.db, issue.id, { github_number: made.number }, [{ k: "copied", by: ctx.github.login, at, s: `#${made.number}` }], ctx.t, "github_number IS NULL")],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, p, ctx) => r.research === p.id && Number.isInteger(r.number) && r.number > 0 && (!ctx.target.repo || !("id" in ctx.target.repo) || r.id === ctx.target.repo.id),
};

export const RESEARCH_ACTIONS: readonly AnyActionSpec[] = [researchCopySpec];
