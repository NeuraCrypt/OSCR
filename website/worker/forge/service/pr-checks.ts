// The registry's checks on every pull request (night phase 10, E4; docs/AUTOMATION.md "Checks"; D00-4,
// D00-11): on the App's `pull_request` deliveries (opened, synchronize — every push —, reopened,
// ready_for_review; drafts and bots' pull requests included), in waitUntil after the delivery is
// answered, the App's installation reads the pull request's head (its tree, three files as text, its
// changed files: never anything run), checks-core.ts judges, and ONE check run is posted on the head
// commit with an overview, each check's level and reason, and annotations (50 a request, the rest in
// further requests: github/checks.ts).
//
// - The installation token only posts the registry's own check run and reads after the webhook (the
//   App's two acts, D00-4); it is minted narrowed to the repository (read, then `checks: write`), kept
//   in memory for its hour.
// - A head commit whose message ends with GitHub's `skip-checks: true` trailer gets no check run.
// - 0 D1 rows written: the result lives on GitHub (the check run) and in the registry's own view of any
//   commit (/r/<owner>/<name>/checks/<sha>, computed in the reader's browser by the same checks), which
//   is the check run's details page.
// - GitHub requests: 2 token mints (cached for the hour), the head commit, the tree, up to 3 files, up
//   to 3 pages of changed files, the check run (+1 per further 50 annotations): ~10, on the
//   installation's own quota (5,000 an hour and more).
// - The check run's name: "<SITE_NAME>: research checks" when the Worker has SITE_NAME, else "Research
//   code checks" (the Worker never hard-codes the platform's name).

import { GitBackendError } from "../errors.ts";
import type { GitBackend } from "../gitbackend.ts";
import { checkFiles, CHECK_RUN_NAME, CHECK_RUN_SUFFIX, CHECK_TEXT_BYTES, runChecks, skipsChecks, type ChangedFile, type Report } from "../checks-core.ts";
import { PR_FILES_CHECKED } from "./caps.ts";
import { redact } from "./http.ts";
import { all, papersOf } from "./store.ts";
import type { D1Database, ForgeRequest, ForgeServiceEnv, RepoRow } from "./types.ts";
import type { ForgeEvent, RepoRef } from "../types.ts";

/** The pull request actions that bring a new head to check. */
export const CHECK_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/** The check run's name, shown on GitHub. */
export function checkRunName(env: Pick<ForgeServiceEnv, "SITE_NAME">): string {
  const site = (env.SITE_NAME ?? "").trim().slice(0, 60);
  return site ? `${site}${CHECK_RUN_SUFFIX}` : CHECK_RUN_NAME;
}

export interface PullCheck {
  /** The installation that sent the delivery (covering the repository's account: webhook.ts checked
   *  it), when the repository's row names none (an installation on "all" repositories). */
  installation?: string | null;
  backend: GitBackend;
  db: D1Database;
  env: ForgeServiceEnv;
  origin: string;
  repo: RepoRow;
  ref: RepoRef;
  number: number;
  headSha: string;
}

/** The files a tracing map points to in a repository (the key's prefix). */
async function tracedOf(db: D1Database, forge: string, repoId: string): Promise<{ path: string; paper: string; commit: string }[]> {
  const rows = await all<{ path: string; paper_id: string; commit_sha: string }>(
    db.prepare("SELECT path, paper_id, commit_sha FROM traced_paths WHERE forge = ? AND repo_id = ? LIMIT 2000").bind(forge, repoId),
  );
  return rows.map((r) => ({ path: r.path, paper: r.paper_id.replace(/^doi:/, ""), commit: r.commit_sha }));
}

const decoder = new TextDecoder();

/** The registry's checks of one pull request's head, posted as ONE check run. */
export async function checkPullRequest(o: PullCheck): Promise<{ posted: boolean; skipped?: string; report?: Report }> {
  const installationId = o.repo.installation_id ?? o.installation ?? null;
  if (!installationId) return { posted: false, skipped: "the App is not installed on it" };
  const s = o.backend.session({ kind: "installation", installationId });
  const head = await s.git.commit(o.ref, o.headSha, { perPage: 1 });
  if (skipsChecks(head.message)) return { posted: false, skipped: "skip-checks: true" };
  const tree = await s.git.tree(o.ref, o.headSha, { recursive: true });
  const entries = tree.entries.map((e) => ({ path: e.path, type: e.type, size: e.size }));
  const wanted = Object.values(checkFiles(entries.filter((e) => e.type === "blob").map((e) => e.path))).filter((p): p is string => !!p);
  const texts: Record<string, string | null> = {};
  for (const path of wanted) {
    try {
      const f = await s.git.readFile(o.ref, o.headSha, path, { maxBytes: CHECK_TEXT_BYTES });
      texts[path] = f.binary || f.lfs ? null : decoder.decode(f.bytes);
    } catch {
      texts[path] = null;
    }
  }
  const files: ChangedFile[] = [];
  let truncated = false;
  let cursor: string | null = null;
  for (;;) {
    const p = await s.pulls.files(o.ref, o.number, { perPage: 100, cursor });
    files.push(...p.items.map((f) => ({ path: f.path, previousPath: f.previousPath, status: f.status })));
    if (!p.next) break;
    if (files.length >= PR_FILES_CHECKED) {
      truncated = true;
      break;
    }
    cursor = p.next;
  }
  const papers = (await all<{ paper_id: string }>(papersOf(o.db, o.repo.forge, o.repo.repo_id))).map((p) => p.paper_id.replace(/^doi:/, ""));
  const report = runChecks({ entries, truncated: tree.truncated, texts, papers, traced: await tracedOf(o.db, o.repo.forge, o.repo.repo_id), change: { files, truncated } });
  await s.checks.create(o.ref, {
    name: checkRunName(o.env),
    headSha: o.headSha,
    status: "completed",
    conclusion: report.conclusion,
    detailsUrl: `${o.origin}/r/${encodeURIComponent(o.ref.owner)}/${encodeURIComponent(o.ref.name)}/checks/${o.headSha}`,
    output: {
      title: report.title,
      summary: report.summary,
      annotations: report.annotations.map((a) => ({ path: a.path, startLine: a.line, endLine: a.line, level: a.level, title: a.title, message: a.message })),
    },
  });
  return { posted: true, report };
}

/** After a pull request's delivery: its checks, in waitUntil (the delivery's answer does not wait). */
export function queuePullChecks(r: ForgeRequest, event: Extract<ForgeEvent, { kind: "pull_request" }>, repo: RepoRow): void {
  if (!CHECK_ACTIONS.has(event.action)) return;
  const run = checkPullRequest({ installation: event.installation, backend: r.backend(), db: r.db, env: r.env, origin: r.url.origin, repo, ref: event.repo.ref, number: event.number, headSha: event.head.sha }).catch((e: unknown) => {
    const code = e instanceof GitBackendError ? e.code : "error";
    console.error(`forge checks ${event.repo.ref.owner}/${event.repo.ref.name}#${event.number}: ${code}: ${redact(String((e as Error)?.message ?? e)).slice(0, 200)}`);
    return { posted: false };
  });
  r.ctx.waitUntil(run);
}
