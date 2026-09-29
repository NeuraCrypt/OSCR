// Forks as authorized actions (night phase 04, E1; docs/PULL_REQUESTS.md; D00-4, D04-*): GitHub
// makes the fork, as the person, in their own account or an organization they belong to; "Sync
// fork" brings a fork's branch up to date with the upstream branch of the same name (GitHub's
// merge-upstream: a fast-forward, or a merge commit when both moved apart; a conflict leaves the
// branch as it was).
//
//   fork       {owner?, name?, defaultBranchOnly?}   on the repository the page declared
//   fork_sync  {branch}                              on the fork the page declared
//
// The action row only (1 row): a fork is GitHub's object, not the registry's (it enters the
// registry's layer only when someone links it to a paper, as any repository).

import { GitBackendError } from "../errors.ts";
import { isRefName, LOGIN, SEGMENT } from "../paths.ts";
import type { SyncForkResult } from "../types.ts";
import { declaredRepo, onDeclaredRepo } from "./act-pulls.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const pageOf = (owner: string, name: string): string => `/r/${owner.toLowerCase()}/${name.toLowerCase()}/`;

export interface ForkParsed {
  /** An organization's login; null: the person's own account. */
  owner: string | null;
  name: string | null;
  defaultBranchOnly: boolean;
}

export interface ForkDone {
  /** The repository forked (its GitHub id). */
  id: string;
  owner: string;
  name: string;
  forkId: string;
  /** The fork's parent, as GitHub says: "owner/name". */
  parent: string | null;
  ready: boolean;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

export function validateFork(payload: unknown): ForkParsed | ForgeProblem {
  if (!isObject(payload)) return bad("The fork is not readable.");
  const p = payload;
  if (p.owner !== undefined && p.owner !== null && (typeof p.owner !== "string" || !LOGIN.test(p.owner) || p.owner.length > 39)) {
    return bad("The fork goes into your account or an organization: its login.");
  }
  if (p.name !== undefined && p.name !== null && (typeof p.name !== "string" || !SEGMENT.test(p.name) || /\.git$/i.test(p.name))) {
    return bad("The fork's name is a repository name: letters, digits, “.”, “-” and “_”.");
  }
  if (p.defaultBranchOnly !== undefined && typeof p.defaultBranchOnly !== "boolean") return bad("The choice of branches is not true or false.");
  return { owner: (p.owner as string | null | undefined) ?? null, name: (p.name as string | null | undefined) ?? null, defaultBranchOnly: p.defaultBranchOnly === true };
}

export const describeFork = (p: ForkParsed): string =>
  `Fork this repository into ${p.owner ? `the organization ${p.owner}` : "your GitHub account"}${p.name ? `, named ${p.name}` : ""}${p.defaultBranchOnly ? ", its default branch only" : ", with all its branches"}`;

export const forkSpec: ActionSpec<ForkParsed, ForkDone> = {
  kind: "fork",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate: validateFork,
  describe: describeFork,
  async perform(ctx) {
    const p = ctx.parsed;
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    // The person's own account is the one GitHub names: an organization only when asked.
    const organization = p.owner && p.owner.toLowerCase() !== ctx.github.login.toLowerCase() ? p.owner : undefined;
    let made;
    try {
      made = await ctx.session.repos.fork(info.ref, { organization, name: p.name ?? undefined, defaultBranchOnly: p.defaultBranchOnly });
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") throw new ForgeProblem(409, "name_taken", `A repository named ${p.name ?? info.ref.name} already exists there: choose another name.`);
      if (e instanceof GitBackendError && e.code === "forbidden") throw new ForgeProblem(403, "forbidden", `GitHub says your account may not create repositories in ${p.owner ?? "this account"}: nothing was done.`);
      throw e;
    }
    const f = made.repo;
    const page = pageOf(f.ref.owner, f.ref.name);
    const notes = [
      made.ready ? "The fork was already there: GitHub keeps one fork of a repository per account." : "GitHub is copying the repository: the fork may take a minute before its files show.",
      "A fork of a public repository is public, and belongs to its network: if the original is deleted or made private, GitHub keeps the fork.",
    ];
    return {
      result: {
        id: info.key.id,
        owner: f.ref.owner,
        name: f.ref.name,
        forkId: f.key.id,
        parent: f.parent ? `${f.parent.owner}/${f.parent.name}` : null,
        ready: made.ready,
        page,
        links: [{ href: page, text: `Your fork, ${f.ref.owner}/${f.ref.name}` }],
        notes,
      },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id },
    };
  },
  check: (r, _p, ctx) =>
    (ctx.target.repo && "id" in ctx.target.repo ? r.id === ctx.target.repo.id : true) &&
    typeof r.forkId === "string" &&
    r.forkId !== r.id,
};

export interface ForkSyncDone extends SyncForkResult {
  id: string;
  branch: string;
  sha: string | null;
  page: string;
  links: { href: string; text: string }[];
  notes: string[];
}

export const forkSyncSpec: ActionSpec<{ branch: string }, ForkSyncDone> = {
  kind: "fork_sync",
  needsRepo: false,
  checkTarget: onDeclaredRepo,
  validate(payload) {
    if (!isObject(payload) || !isRefName(payload.branch) || String(payload.branch).startsWith("refs/")) return bad("Name the fork's branch to sync.");
    return { branch: payload.branch as string };
  },
  describe: (p) => `Sync the branch ${p.branch} of this fork with the same branch of its upstream repository`,
  async perform(ctx) {
    const info = await declaredRepo(ctx as ActionContext<unknown>);
    if (!info.parent) throw new ForgeProblem(400, "not_a_fork", "This repository is not a fork: there is no upstream to sync with.");
    let done: SyncForkResult;
    try {
      done = await ctx.session.repos.syncFork(info.ref, ctx.parsed.branch);
    } catch (e) {
      if (e instanceof GitBackendError && e.code === "conflict") {
        throw new ForgeProblem(409, "conflict", `The fork's ${ctx.parsed.branch} and its upstream changed the same lines: GitHub cannot sync it by itself. Nothing was done: open a pull request from the upstream branch into your fork, and resolve the conflicts there.`);
      }
      if (e instanceof GitBackendError && e.code === "not_found") throw new ForgeProblem(404, "no_branch", `The branch ${ctx.parsed.branch} is not in the fork or in its upstream.`);
      throw e;
    }
    const sha = await ctx.session.git.resolve(info.ref, ctx.parsed.branch).catch(() => null);
    const page = pageOf(info.ref.owner, info.ref.name);
    const notes = [
      done.status === "up_to_date"
        ? `Nothing to do: ${ctx.parsed.branch} already holds every commit of ${done.upstream ?? "its upstream"}.`
        : done.status === "fast_forward"
          ? `${ctx.parsed.branch} moved forward to ${done.upstream ?? "its upstream"}'s commits.`
          : `${ctx.parsed.branch} and ${done.upstream ?? "its upstream"} had both moved: GitHub merged them in a merge commit.`,
    ];
    return {
      result: { ...done, id: info.key.id, branch: ctx.parsed.branch, sha, page, links: [{ href: page, text: "The fork" }], notes },
      writes: [],
      repo: { forge: info.key.forge, repoId: info.key.id, branch: ctx.parsed.branch },
    };
  },
  check: (r, p, ctx) => (ctx.target.repo && "id" in ctx.target.repo ? r.id === ctx.target.repo.id : true) && r.branch === p.branch,
};

export const FORK_ACTIONS: readonly AnyActionSpec[] = [forkSpec, forkSyncSpec];
