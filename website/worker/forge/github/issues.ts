// Issues on GitHub (phase 05): https://docs.github.com/en/rest/issues and, for transfers and
// pins, GraphQL. OSCR's scientific issue types live in D1, not here (D00-6).
//
//   list / get / create / update   GET / POST …/issues; GET / PATCH …/issues/{n} (state_reason).
//                                  GitHub lists pull requests as issues: they are dropped here
//                                  unless `includePulls`, so a page may hold fewer items
//   lock / unlock                  PUT / DELETE …/issues/{n}/lock {lock_reason}
//   comments …                     …/issues/{n}/comments; …/issues/comments/{id}
//   react                          POST …/issues/{n}/reactions or …/issues/comments/{id}/reactions
//   unreact                        GET /user (who the session is), GET the reactions of that kind
//                                  (up to 5 pages) to find the session's own, then DELETE
//                                  …/reactions/{reaction_id}
//   labels, milestones             …/labels, …/labels/{name}; …/milestones, …/milestones/{n}
//   sub-issues                     GET / POST …/issues/{n}/sub_issues {sub_issue_id} (the child's
//                                  id, read first); DELETE …/issues/{n}/sub_issue
//   dependencies                   GET / POST …/issues/{n}/dependencies/blocked_by {issue_id};
//                                  DELETE …/dependencies/blocked_by/{issue_id}
//   transfer                       GraphQL transferIssue {issueId, repositoryId} (both node ids
//                                  read first), then GET the issue at its new number
//   pin                            GraphQL pinIssue / unpinIssue
//   timeline                       GET …/issues/{n}/timeline
//   search                         GET /search/issues?q=repo:{o}/{r} {query} (anonymous: 10 a minute)

import { GitBackendError, invalid } from "../errors.ts";
import type { IssueOps, IssueTarget } from "../gitbackend.ts";
import { checkBody, checkId, checkLogin, checkNumber, checkTitle } from "../paths.ts";
import type * as T from "../types.ts";
import { type Ctx, need, paged, R, scope } from "./ctx.ts";
import * as Q from "./graphql.ts";
import { nextPage, readJson, restPage } from "./http.ts";
import * as map from "./map.ts";

const REACTIONS = new Set(["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"]);
const LOCKS = new Set(["off-topic", "too heated", "resolved", "spam"]);
const REASONS = new Set(["completed", "not_planned", "duplicate", "reopened"]);

function checkLabelName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.length > 50 || /[\u0000-\u001f]/.test(name)) throw invalid("not a label name");
  return name;
}

function checkColor(color: unknown): string {
  if (typeof color !== "string" || !/^[0-9a-fA-F]{6}$/.test(color)) throw invalid("a colour is 6 hex digits");
  return color.toLowerCase();
}

function checkReaction(r: unknown): T.Reaction {
  if (typeof r !== "string" || !REACTIONS.has(r)) throw invalid("not a reaction");
  return r as T.Reaction;
}

function checkTime(t: unknown): string {
  if (typeof t !== "string" || Number.isNaN(Date.parse(t))) throw invalid("not a time");
  return t;
}

/** An issue type's name (an organization's: "Bug", "Task"…). */
export function checkIssueType(t: unknown): string {
  if (typeof t !== "string" || !t.trim() || t.length > 50 || /[\u0000-\u001f]/.test(t)) throw invalid("not an issue type");
  return t.trim();
}

function checkQuery(q: unknown): string {
  if (typeof q !== "string" || q.length > 256 || /[\u0000-\u001f]/.test(q)) throw invalid("not a search");
  return q.trim();
}

export function issueOps(ctx: Ctx): IssueOps {
  const { http, links } = ctx;
  const issuePage = (repo: T.RepoRef, n?: number) => `${links.repo(repo)}/issues${n ? `/${n}` : ""}`;

  const get = async (repo: T.RepoRef, number: number): Promise<T.Issue> => {
    need(ctx, "read");
    const path = `${R(repo)}/issues/${checkNumber(number)}`;
    return map.issue(await http.json({ path, scope: scope(repo, "read"), view: issuePage(repo, number) }));
  };

  const listAt = async <V>(repo: T.RepoRef, sub: string, mapper: (v: unknown) => V, page: T.PageRequest | undefined, view: string, query: Record<string, string | undefined> = {}): Promise<T.Page<V>> => {
    need(ctx, "read");
    const path = `${R(repo)}/${sub}`;
    const p = restPage(page);
    const res = await http.send({ path, query: { ...query, per_page: p.perPage, page: p.page }, scope: scope(repo, "read"), view });
    return paged(await readJson(res), mapper, nextPage(res, p.page));
  };

  const reactionsPath = (repo: T.RepoRef, target: IssueTarget): string => {
    if (target && "issue" in target) return `${R(repo)}/issues/${checkNumber(target.issue)}/reactions`;
    if (target && "comment" in target) return `${R(repo)}/issues/comments/${checkId(target.comment, "comment id")}/reactions`;
    throw invalid("not a reaction target");
  };

  /** The database id of an issue (sub-issues and dependencies name issues by it). */
  const idOf = async (repo: T.RepoRef, number: number): Promise<string> => (await get(repo, number)).id;

  return {
    async list(repo, filter = {}, page) {
      need(ctx, "read");
      R(repo);
      if (filter.state !== undefined && !["open", "closed", "all"].includes(filter.state)) throw invalid("not a state");
      const labels = filter.labels?.map(checkLabelName);
      const milestone = filter.milestone === undefined ? undefined : typeof filter.milestone === "number" ? String(checkNumber(filter.milestone)) : filter.milestone === "none" ? "none" : filter.milestone === "any" ? "*" : undefined;
      if (filter.milestone !== undefined && milestone === undefined) throw invalid("not a milestone");
      const assignee = filter.assignee === undefined ? undefined : filter.assignee === "any" ? "*" : filter.assignee === "none" ? "none" : checkLogin(filter.assignee);
      if (filter.creator !== undefined) checkLogin(filter.creator);
      if (filter.mentioned !== undefined) checkLogin(filter.mentioned);
      if (filter.since !== undefined) checkTime(filter.since);
      if (filter.sort !== undefined && !["created", "updated", "comments"].includes(filter.sort)) throw invalid("not a sort");
      if (filter.direction !== undefined && filter.direction !== "asc" && filter.direction !== "desc") throw invalid("not a direction");
      const found = await listAt(repo, "issues", map.issue, page, issuePage(repo), {
        state: filter.state,
        labels: labels?.join(","),
        milestone,
        assignee,
        creator: filter.creator,
        mentioned: filter.mentioned,
        since: filter.since,
        sort: filter.sort,
        direction: filter.direction,
      });
      return filter.includePulls ? found : { items: found.items.filter((i) => !i.isPullRequest), next: found.next };
    },

    get,

    async create(repo, input) {
      need(ctx, "write");
      const path = `${R(repo)}/issues`;
      const body = {
        title: checkTitle(input?.title),
        body: checkBody(input.body) || undefined,
        labels: input.labels?.map(checkLabelName),
        assignees: input.assignees?.map(checkLogin),
        milestone: input.milestone === undefined ? undefined : checkNumber(input.milestone),
        type: input.type === undefined ? undefined : checkIssueType(input.type),
      };
      return map.issue(await http.json({ method: "POST", path, json: body }));
    },

    async update(repo, number, patch) {
      need(ctx, "write");
      const path = `${R(repo)}/issues/${checkNumber(number)}`;
      if (!patch || typeof patch !== "object") throw invalid("no change");
      if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") throw invalid("not a state");
      if (patch.stateReason !== undefined && !REASONS.has(patch.stateReason)) throw invalid("not a state reason");
      const body = {
        title: patch.title === undefined ? undefined : checkTitle(patch.title),
        body: patch.body === undefined ? undefined : checkBody(patch.body),
        state: patch.state,
        state_reason: patch.stateReason,
        labels: patch.labels?.map(checkLabelName),
        assignees: patch.assignees?.map(checkLogin),
        milestone: patch.milestone === undefined ? undefined : patch.milestone === null ? null : checkNumber(patch.milestone),
        type: patch.type === undefined ? undefined : patch.type === null ? null : checkIssueType(patch.type),
      };
      return map.issue(await http.json({ method: "PATCH", path, json: body }));
    },

    async lock(repo, number, reason) {
      need(ctx, "write");
      const path = `${R(repo)}/issues/${checkNumber(number)}/lock`;
      if (reason !== undefined && !LOCKS.has(reason)) throw invalid("not a lock reason");
      await http.send({ method: "PUT", path, json: reason ? { lock_reason: reason } : {} });
    },

    async unlock(repo, number) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: `${R(repo)}/issues/${checkNumber(number)}/lock` });
    },

    comments: (repo, number, page) => listAt(repo, `issues/${checkNumber(number)}/comments`, map.issueComment, page, issuePage(repo, number)),

    async comment(repo, number, body) {
      need(ctx, "write");
      const path = `${R(repo)}/issues/${checkNumber(number)}/comments`;
      return map.issueComment(await http.json({ method: "POST", path, json: { body: checkBody(body, "comment", true) } }));
    },

    async editComment(repo, commentId, body) {
      need(ctx, "write");
      const path = `${R(repo)}/issues/comments/${checkId(commentId, "comment id")}`;
      return map.issueComment(await http.json({ method: "PATCH", path, json: { body: checkBody(body, "comment", true) } }));
    },

    async deleteComment(repo, commentId) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: `${R(repo)}/issues/comments/${checkId(commentId, "comment id")}` });
    },

    async react(repo, target, reaction) {
      need(ctx, "write");
      const path = reactionsPath(repo, target);
      await http.send({ method: "POST", path, json: { content: checkReaction(reaction) } });
    },

    async unreact(repo, target, reaction) {
      need(ctx, "write");
      const path = reactionsPath(repo, target);
      const content = checkReaction(reaction);
      const me = map.obj(await http.json({ path: "/user", scope: { act: "read" } }), "user");
      const myId = map.id(me);
      for (let page = 1; page <= 5; page++) {
        const res = await http.send({ path, query: { content, per_page: 100, page }, scope: scope(repo, "read") });
        for (const r of map.list(await readJson(res), "reactions")) {
          const o = map.obj(r, "reaction");
          const u = o.user ? map.obj(o.user, "user") : null;
          if (u && map.optId(u) === myId) {
            await http.send({ method: "DELETE", path: `${path}/${map.id(o)}` });
            return;
          }
        }
        if (!nextPage(res, page)) return;
      }
    },

    labels: (repo, page) => listAt(repo, "labels", map.label, page, `${links.repo(repo)}/labels`),

    async createLabel(repo, label) {
      need(ctx, "write");
      const path = `${R(repo)}/labels`;
      const body = { name: checkLabelName(label?.name), color: checkColor(label.color), description: checkBody(label.description ?? "", "description").slice(0, 100) };
      return map.label(await http.json({ method: "POST", path, json: body }));
    },

    async updateLabel(repo, name, patch) {
      need(ctx, "write");
      const path = `${R(repo)}/labels/${encodeURIComponent(checkLabelName(name))}`;
      const body = {
        new_name: patch.name === undefined ? undefined : checkLabelName(patch.name),
        color: patch.color === undefined ? undefined : checkColor(patch.color),
        description: patch.description === undefined ? undefined : checkBody(patch.description, "description").slice(0, 100),
      };
      return map.label(await http.json({ method: "PATCH", path, json: body }));
    },

    async deleteLabel(repo, name) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: `${R(repo)}/labels/${encodeURIComponent(checkLabelName(name))}` });
    },

    milestones(repo, state, page) {
      if (state !== undefined && !["open", "closed", "all"].includes(state)) throw invalid("not a state");
      return listAt(repo, "milestones", map.milestone, page, `${links.repo(repo)}/milestones`, { state });
    },

    async createMilestone(repo, input) {
      need(ctx, "write");
      const path = `${R(repo)}/milestones`;
      const body = {
        title: checkTitle(input?.title),
        description: input.description === undefined ? undefined : checkBody(input.description, "description"),
        due_on: input.dueOn === undefined || input.dueOn === null ? undefined : checkTime(input.dueOn),
        state: input.state,
      };
      return map.milestone(await http.json({ method: "POST", path, json: body }));
    },

    async updateMilestone(repo, number, patch) {
      need(ctx, "write");
      const path = `${R(repo)}/milestones/${checkNumber(number)}`;
      if (patch.state !== undefined && patch.state !== "open" && patch.state !== "closed") throw invalid("not a state");
      const body = {
        title: patch.title === undefined ? undefined : checkTitle(patch.title),
        description: patch.description === undefined ? undefined : checkBody(patch.description, "description"),
        due_on: patch.dueOn === undefined ? undefined : patch.dueOn === null ? null : checkTime(patch.dueOn),
        state: patch.state,
      };
      return map.milestone(await http.json({ method: "PATCH", path, json: body }));
    },

    async deleteMilestone(repo, number) {
      need(ctx, "write");
      await http.send({ method: "DELETE", path: `${R(repo)}/milestones/${checkNumber(number)}` });
    },

    subIssues(repo, number, page) {
      need(ctx, "read", "subIssues");
      return listAt(repo, `issues/${checkNumber(number)}/sub_issues`, map.issue, page, issuePage(repo, number));
    },

    async addSubIssue(repo, parent, child) {
      need(ctx, "write", "subIssues");
      const path = `${R(repo)}/issues/${checkNumber(parent)}/sub_issues`;
      checkNumber(child);
      const id = await idOf(repo, child);
      await http.send({ method: "POST", path, json: { sub_issue_id: Number(id) } });
    },

    async removeSubIssue(repo, parent, child) {
      need(ctx, "write", "subIssues");
      const path = `${R(repo)}/issues/${checkNumber(parent)}/sub_issue`;
      checkNumber(child);
      const id = await idOf(repo, child);
      await http.send({ method: "DELETE", path, json: { sub_issue_id: Number(id) } });
    },

    blockedBy(repo, number, page) {
      need(ctx, "read", "issueDependencies");
      return listAt(repo, `issues/${checkNumber(number)}/dependencies/blocked_by`, map.issue, page, issuePage(repo, number));
    },

    async addBlockedBy(repo, number, blocker) {
      need(ctx, "write", "issueDependencies");
      const path = `${R(repo)}/issues/${checkNumber(number)}/dependencies/blocked_by`;
      checkNumber(blocker);
      const id = await idOf(repo, blocker);
      await http.send({ method: "POST", path, json: { issue_id: Number(id) } });
    },

    async removeBlockedBy(repo, number, blocker) {
      need(ctx, "write", "issueDependencies");
      const path = `${R(repo)}/issues/${checkNumber(number)}/dependencies/blocked_by`;
      checkNumber(blocker);
      const id = await idOf(repo, blocker);
      await http.send({ method: "DELETE", path: `${path}/${id}` });
    },

    async transfer(repo, number, to) {
      need(ctx, "write", "transferIssue");
      R(repo);
      R(to);
      checkNumber(number);
      const issue = await get(repo, number);
      const target = map.repo(await http.json({ path: R(to), scope: scope(to, "read") }));
      if (!issue.nodeId || !target.nodeId) throw new GitBackendError("unavailable", "unexpected answer from the forge (node id)");
      const data = await http.graphql(Q.TRANSFER_ISSUE, { issue: issue.nodeId, repo: target.nodeId }, { mutation: true });
      const n = Q.dig(data, "transferIssue", "issue", "number");
      if (typeof n !== "number") throw new GitBackendError("unavailable", "unexpected answer from the forge (transfer)");
      return get(to, n);
    },

    async pin(repo, number, pinned) {
      need(ctx, "write", "pinIssue");
      const issue = await get(repo, number);
      if (!issue.nodeId) throw new GitBackendError("unavailable", "unexpected answer from the forge (node id)");
      await http.graphql(pinned ? Q.PIN_ISSUE : Q.UNPIN_ISSUE, { id: issue.nodeId }, { mutation: true });
    },

    timeline: (repo, number, page) => listAt(repo, `issues/${checkNumber(number)}/timeline`, map.timelineEvent, page, issuePage(repo, number)),

    async search(repo, query, page) {
      need(ctx, "read");
      R(repo);
      const q = checkQuery(query);
      const p = restPage(page);
      const res = await http.send({
        path: "/search/issues",
        query: { q: `repo:${repo.owner}/${repo.name} ${q}`.trim(), per_page: p.perPage, page: p.page },
        scope: scope(repo, "read"),
        view: `${issuePage(repo)}?${new URLSearchParams({ q })}`,
      });
      const answer = map.obj(await readJson(res), "search");
      return paged(answer.items, map.issue, nextPage(res, p.page));
    },
  };
}
