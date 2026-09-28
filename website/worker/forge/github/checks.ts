// Checks on GitHub (phases 04 and 10): https://docs.github.com/en/rest/checks and
// https://docs.github.com/en/rest/commits/statuses.
//
//   runs     GET …/commits/{rev}/check-runs
//   status   GET …/commits/{rev}/status (the combined status of the researcher's own CI)
//   create   POST …/check-runs, then PATCH …/check-runs/{id} for each further 50 annotations
//   update   PATCH …/check-runs/{id}, 50 annotations a request
//
// Check runs are the App's acts: only installation sessions create or update them (rules.ts), with
// a token narrowed to this repository and to `checks: write`. The run's name is shown on GitHub:
// the caller builds it from SITE_NAME, never a hard-coded name. OSCR's checks run no code.

import { invalid } from "../errors.ts";
import type { CheckOps } from "../gitbackend.ts";
import { checkId, checkObjectId, checkRev } from "../paths.ts";
import type * as T from "../types.ts";
import { type Ctx, need, paged, R, scope } from "./ctx.ts";
import { nextPage, readJson, restPage } from "./http.ts";
import { escapePath } from "./links.ts";
import * as map from "./map.ts";

const STATUSES = new Set(["queued", "in_progress", "completed"]);
const CONCLUSIONS = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"]);
const LEVELS = new Set(["notice", "warning", "failure"]);

function checkUrl(u: unknown): string {
  if (typeof u !== "string" || u.length > 2000) throw invalid("not an address");
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw invalid("not an address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("not an address");
  return u;
}

function annotations(list: T.CheckAnnotation[] | undefined): Record<string, unknown>[] {
  return (list ?? []).map((a) => {
    if (!a || typeof a.path !== "string" || !a.path || !Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine) {
      throw invalid("not an annotation");
    }
    if (!LEVELS.has(a.level) || typeof a.message !== "string" || !a.message) throw invalid("not an annotation");
    return { path: a.path, start_line: a.startLine, end_line: a.endLine, annotation_level: a.level, title: a.title, message: a.message.slice(0, 64 * 1024) };
  });
}

/** The request body of a create or an update, and the annotations left for further requests. */
function runBody(p: T.CheckRunPatch & { headSha?: string }, per: number): { body: Record<string, unknown>; rest: Record<string, unknown>[] } {
  if (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100)) throw invalid("not a check name");
  if (p.status !== undefined && !STATUSES.has(p.status)) throw invalid("not a check status");
  if (p.conclusion !== undefined && !CONCLUSIONS.has(p.conclusion)) throw invalid("not a conclusion");
  if (p.detailsUrl !== undefined) checkUrl(p.detailsUrl);
  if (p.externalId !== undefined && (typeof p.externalId !== "string" || p.externalId.length > 200)) throw invalid("not an external id");
  const all = annotations(p.output?.annotations);
  let output: Record<string, unknown> | undefined;
  if (p.output) {
    if (typeof p.output.title !== "string" || typeof p.output.summary !== "string") throw invalid("an output has a title and a summary");
    output = { title: p.output.title, summary: p.output.summary.slice(0, 65_535), text: p.output.text?.slice(0, 65_535), annotations: all.slice(0, per) };
  }
  const body: Record<string, unknown> = {
    name: p.name,
    head_sha: p.headSha,
    status: p.status,
    conclusion: p.conclusion,
    details_url: p.detailsUrl,
    external_id: p.externalId,
    output,
  };
  if (p.conclusion !== undefined && p.status === undefined) body.status = "completed";
  return { body, rest: all.slice(per) };
}

export function checkOps(ctx: Ctx): CheckOps {
  const { http, links, limits } = ctx;
  const per = limits.checkAnnotationsPerRequest;

  /** The annotations beyond the first request's, 50 a PATCH. */
  const more = async (repo: T.RepoRef, id: string, output: { title: string; summary: string }, rest: Record<string, unknown>[]): Promise<unknown> => {
    let last: unknown = null;
    for (let i = 0; i < rest.length; i += per) {
      last = await http.json({
        method: "PATCH",
        path: `${R(repo)}/check-runs/${id}`,
        json: { output: { title: output.title, summary: output.summary, annotations: rest.slice(i, i + per) } },
        scope: scope(repo, "check"),
      });
    }
    return last;
  };

  return {
    async runs(repo, rev, page) {
      need(ctx, "read", "checkRuns");
      const path = `${R(repo)}/commits/${escapePath(checkRev(rev))}/check-runs`;
      const p = restPage(page);
      const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: links.commit(repo, rev) });
      const answer = map.obj(await readJson(res), "check runs");
      return paged(answer.check_runs, map.checkRun, nextPage(res, p.page));
    },

    async create(repo, input) {
      need(ctx, "check", "checkRuns");
      const path = `${R(repo)}/check-runs`;
      if (!input || typeof input.name !== "string") throw invalid("a check run has a name");
      checkObjectId(input.headSha);
      const { body, rest } = runBody(input, per);
      const made = map.checkRun(await http.json({ method: "POST", path, json: body, scope: scope(repo, "check") }));
      if (!rest.length || !input.output) return made;
      return map.checkRun(await more(repo, made.id, input.output, rest));
    },

    async update(repo, id, patch) {
      need(ctx, "check", "checkRuns");
      const path = `${R(repo)}/check-runs/${checkId(id, "check run id")}`;
      const { body, rest } = runBody(patch ?? {}, per);
      const done = map.checkRun(await http.json({ method: "PATCH", path, json: body, scope: scope(repo, "check") }));
      if (!rest.length || !patch.output) return done;
      return map.checkRun(await more(repo, done.id, patch.output, rest));
    },

    async status(repo, rev) {
      need(ctx, "read");
      const path = `${R(repo)}/commits/${escapePath(checkRev(rev))}/status`;
      return map.combinedStatus(await http.json({ path, scope: scope(repo, "read"), view: links.commit(repo, rev) }));
    },
  };
}
