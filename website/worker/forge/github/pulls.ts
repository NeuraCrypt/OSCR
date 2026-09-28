// Pull requests and reviews on GitHub (phase 04): https://docs.github.com/en/rest/pulls and, for
// what REST lacks, GraphQL.
//
//   list / get / files / commits   GET …/pulls, …/pulls/{n}, …/pulls/{n}/files, …/pulls/{n}/commits
//                                  (a list's items carry no counts: 0 there, get() has them)
//   create / update                POST …/pulls; PATCH …/pulls/{n}
//   setDraft                       GET …/pulls/{n} (its node id), then GraphQL
//                                  markPullRequestReadyForReview / convertPullRequestToDraft
//   requestReviewers / remove      POST / DELETE …/pulls/{n}/requested_reviewers
//   reviews / review               GET / POST …/pulls/{n}/reviews {event, body, commit_id, comments[]}
//   comments / reply               GET …/pulls/{n}/comments; POST …/pulls/{n}/comments/{id}/replies
//   threads / resolveThread        GraphQL pullRequest.reviewThreads; resolveReviewThread /
//                                  unresolveReviewThread
//   merge                          PUT …/pulls/{n}/merge {merge_method, sha: expectedHead}: 405 →
//                                  not_mergeable, 409 → conflict (the head moved)
//   updateBranch                   PUT …/pulls/{n}/update-branch {expected_head_sha}
//   autoMerge                      GET …/pulls/{n}, then GraphQL enablePullRequestAutoMerge (with
//                                  expectedHeadOid) / disablePullRequestAutoMerge
//   revert                         GET …/pulls/{n}, GraphQL revertPullRequest, then GET the new one

import { GitBackendError, invalid } from "../errors.ts";
import type { PullOps } from "../gitbackend.ts";
import { checkBody, checkId, checkLogin, checkNumber, checkObjectId, checkPath, checkRefName, checkTitle } from "../paths.ts";
import type * as T from "../types.ts";
import { type Ctx, need, paged, R, scope } from "./ctx.ts";
import * as Q from "./graphql.ts";
import { graphPage, nextPage, readJson, restPage } from "./http.ts";
import * as map from "./map.ts";

const METHODS = new Set(["merge", "squash", "rebase"]);
const EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

function checkHead(head: unknown): string {
  if (typeof head !== "string") throw invalid("not a head");
  const i = head.indexOf(":");
  if (i >= 0) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(head.slice(0, i))) throw invalid("not a head");
    checkRefName(head.slice(i + 1), "branch");
  } else checkRefName(head, "branch");
  return head;
}

function checkLogins(logins: unknown): string[] {
  if (!Array.isArray(logins) || !logins.length || logins.length > 15) throw invalid("1 to 15 logins");
  return logins.map(checkLogin);
}

export function pullOps(ctx: Ctx): PullOps {
  const { http, links } = ctx;
  const pullPage = (repo: T.RepoRef, n: number) => `${links.repo(repo)}/pull/${n}`;

  const get = async (repo: T.RepoRef, number: number): Promise<T.PullRequest> => {
    need(ctx, "read");
    const path = `${R(repo)}/pulls/${checkNumber(number)}`;
    return map.pull(await http.json({ path, scope: scope(repo, "read"), view: pullPage(repo, number) }));
  };

  const listOf = async <V>(repo: T.RepoRef, number: number, what: string, mapper: (v: unknown) => V, page?: T.PageRequest): Promise<T.Page<V>> => {
    need(ctx, "read");
    const path = `${R(repo)}/pulls/${checkNumber(number)}/${what}`;
    const p = restPage(page);
    const res = await http.send({ path, query: { per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view: pullPage(repo, number) });
    return paged(await readJson(res), mapper, nextPage(res, p.page));
  };

  const setReviewers = async (repo: T.RepoRef, number: number, logins: string[], method: "POST" | "DELETE") => {
    need(ctx, "write");
    const path = `${R(repo)}/pulls/${checkNumber(number)}/requested_reviewers`;
    const reviewers = checkLogins(logins);
    return map.pull(await http.json({ method, path, json: { reviewers } }));
  };

  return {
    async list(repo, filter = {}, page) {
      need(ctx, "read");
      const path = `${R(repo)}/pulls`;
      if (filter.state !== undefined && !["open", "closed", "all"].includes(filter.state)) throw invalid("not a state");
      if (filter.head !== undefined) checkHead(filter.head);
      if (filter.base !== undefined) checkRefName(filter.base, "branch");
      if (filter.sort !== undefined && !["created", "updated", "popularity", "long-running"].includes(filter.sort)) throw invalid("not a sort");
      if (filter.direction !== undefined && filter.direction !== "asc" && filter.direction !== "desc") throw invalid("not a direction");
      const p = restPage(page);
      const res = await http.send({
        path,
        query: { state: filter.state, head: filter.head, base: filter.base, sort: filter.sort, direction: filter.direction, per_page: p.perPage, page: p.page },
        scope: scope(repo, "read"),
        view: `${links.repo(repo)}/pulls`,
      });
      return paged(await readJson(res), map.pull, nextPage(res, p.page));
    },

    get,
    files: (repo, number, page) => listOf(repo, number, "files", map.fileChange, page),
    commits: (repo, number, page) => listOf(repo, number, "commits", map.commit, page),

    async create(repo, input) {
      need(ctx, "write");
      const path = `${R(repo)}/pulls`;
      checkTitle(input?.title);
      checkHead(input.head);
      checkRefName(input.base, "branch");
      const body = {
        title: input.title,
        body: checkBody(input.body),
        head: input.head,
        base: input.base,
        draft: input.draft === true,
        maintainer_can_modify: input.maintainerCanModify,
      };
      return map.pull(await http.json({ method: "POST", path, json: body }));
    },

    async update(repo, number, patch) {
      need(ctx, "write");
      const path = `${R(repo)}/pulls/${checkNumber(number)}`;
      if (patch.title !== undefined) checkTitle(patch.title);
      if (patch.body !== undefined) checkBody(patch.body);
      if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") throw invalid("not a state");
      if (patch.base !== undefined) checkRefName(patch.base, "branch");
      return map.pull(await http.json({ method: "PATCH", path, json: { title: patch.title, body: patch.body, state: patch.state, base: patch.base } }));
    },

    async setDraft(repo, number, draft) {
      need(ctx, "write", "draftToggle");
      const pr = await get(repo, number);
      if (pr.draft === draft) return pr;
      if (!pr.nodeId) throw new GitBackendError("unavailable", "unexpected answer from the forge (node id)");
      const data = await http.graphql(draft ? Q.CONVERT_TO_DRAFT : Q.READY_FOR_REVIEW, { id: pr.nodeId }, { mutation: true });
      const key = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
      const isDraft = Q.dig(data, key, "pullRequest", "isDraft");
      if (typeof isDraft !== "boolean") throw new GitBackendError("unavailable", "unexpected answer from the forge (isDraft)");
      return { ...pr, draft: isDraft };
    },

    requestReviewers: (repo, number, logins) => setReviewers(repo, number, logins, "POST"),
    removeReviewers: (repo, number, logins) => setReviewers(repo, number, logins, "DELETE"),

    reviews: (repo, number, page) => listOf(repo, number, "reviews", map.review, page),

    async review(repo, number, input) {
      need(ctx, "write");
      const path = `${R(repo)}/pulls/${checkNumber(number)}/reviews`;
      if (!input || !EVENTS.has(input.event)) throw invalid("not a review event");
      const body = checkBody(input.body);
      if (input.commit !== undefined) checkObjectId(input.commit);
      const comments = (input.comments ?? []).map((c) => {
        const side = c.side ?? "RIGHT";
        if (side !== "LEFT" && side !== "RIGHT") throw invalid("not a side");
        const out: Record<string, unknown> = { path: checkPath(c.path), line: checkNumber(c.line, "line"), side, body: checkBody(c.body, "comment", true) };
        if (c.startLine !== undefined) {
          out.start_line = checkNumber(c.startLine, "line");
          out.start_side = c.startSide ?? side;
        }
        return out;
      });
      if (input.event === "REQUEST_CHANGES" && !body.trim() && !comments.length) throw invalid("a change request says what to change");
      const json = { event: input.event, body: body || undefined, commit_id: input.commit, comments: comments.length ? comments : undefined };
      return map.review(await http.json({ method: "POST", path, json }));
    },

    comments: (repo, number, page) => listOf(repo, number, "comments", map.reviewComment, page),

    async reply(repo, number, commentId, body) {
      need(ctx, "write");
      const path = `${R(repo)}/pulls/${checkNumber(number)}/comments/${checkId(commentId, "comment id")}/replies`;
      return map.reviewComment(await http.json({ method: "POST", path, json: { body: checkBody(body, "reply", true) } }));
    },

    async threads(repo, number, page) {
      R(repo);
      checkNumber(number);
      need(ctx, "read", "reviewThreads", `${pullPage(repo, number)}/files`);
      const p = graphPage(page);
      const data = await http.graphql(
        Q.THREADS,
        { owner: repo.owner, name: repo.name, number, first: p.first, after: p.after },
        { mutation: false, scope: scope(repo, "read"), view: `${pullPage(repo, number)}/files` },
      );
      const conn = Q.dig(data, "repository", "pullRequest", "reviewThreads");
      if (!conn) throw new GitBackendError("not_found", "no such pull request");
      const c = map.obj(conn, "reviewThreads");
      const info = map.obj(c.pageInfo, "pageInfo");
      return { items: map.list(c.nodes, "threads").map(map.thread), next: info.hasNextPage === true ? map.str(info, "endCursor") : null };
    },

    async resolveThread(repo, threadId, resolved) {
      R(repo);
      need(ctx, "write", "reviewThreads");
      const id = checkId(threadId, "thread id");
      const data = await http.graphql(resolved ? Q.RESOLVE_THREAD : Q.UNRESOLVE_THREAD, { id }, { mutation: true });
      return map.thread(Q.dig(data, resolved ? "resolveReviewThread" : "unresolveReviewThread", "thread"));
    },

    async merge(repo, number, input) {
      need(ctx, "write");
      const path = `${R(repo)}/pulls/${checkNumber(number)}/merge`;
      if (!input || !METHODS.has(input.method)) throw invalid("not a merge method");
      checkObjectId(input.expectedHead);
      if (input.title !== undefined) checkTitle(input.title);
      if (input.message !== undefined) checkBody(input.message, "message");
      const answer = map.obj(
        await http.json({
          method: "PUT",
          path,
          json: { merge_method: input.method, sha: input.expectedHead, commit_title: input.title, commit_message: input.message },
          context: "pull-merge",
        }),
        "merge",
      );
      if (answer.merged === false) throw new GitBackendError("not_mergeable", "the forge did not merge this pull request");
      return { sha: map.sha(answer) };
    },

    async updateBranch(repo, number, expectedHead) {
      need(ctx, "write");
      const path = `${R(repo)}/pulls/${checkNumber(number)}/update-branch`;
      if (expectedHead !== undefined) checkObjectId(expectedHead);
      await http.send({ method: "PUT", path, json: { expected_head_sha: expectedHead } });
    },

    async autoMerge(repo, number, method) {
      need(ctx, "write", "autoMerge");
      if (method !== null && !METHODS.has(method)) throw invalid("not a merge method");
      const pr = await get(repo, number);
      if (!pr.nodeId) throw new GitBackendError("unavailable", "unexpected answer from the forge (node id)");
      if (method === null) {
        await http.graphql(Q.DISABLE_AUTO_MERGE, { id: pr.nodeId }, { mutation: true });
        return { ...pr, autoMerge: null };
      }
      const data = await http.graphql(Q.ENABLE_AUTO_MERGE, { id: pr.nodeId, method: method.toUpperCase(), head: pr.head.sha }, { mutation: true });
      const set = Q.dig(data, "enablePullRequestAutoMerge", "pullRequest", "autoMergeRequest", "mergeMethod");
      return { ...pr, autoMerge: typeof set === "string" && METHODS.has(set.toLowerCase()) ? (set.toLowerCase() as T.MergeMethod) : method };
    },

    async revert(repo, number, input = {}) {
      need(ctx, "write", "revertPullRequest");
      if (input.title !== undefined) checkTitle(input.title);
      if (input.body !== undefined) checkBody(input.body);
      const pr = await get(repo, number);
      if (!pr.merged) throw invalid("only a merged pull request is reverted");
      if (!pr.nodeId) throw new GitBackendError("unavailable", "unexpected answer from the forge (node id)");
      const data = await http.graphql(
        Q.REVERT_PULL,
        { input: { pullRequestId: pr.nodeId, title: input.title, body: input.body, draft: input.draft === true } },
        { mutation: true },
      );
      const n = Q.dig(data, "revertPullRequest", "revertPullRequest", "number");
      if (typeof n !== "number") throw new GitBackendError("unavailable", "unexpected answer from the forge (revert)");
      return get(repo, n);
    },
  };
}
