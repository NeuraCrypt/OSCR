// Branches as authorized actions (E1), on a repository the registry knows, as the person on
// GitHub (GitHub requires write, and its rulesets may refuse: said in words). The action row only,
// except a rename of the default branch (repos 1).
//
//   branch_create  {name, from}   from a branch, a tag or a full commit id
//   branch_rename  {from, to}     GitHub moves the default branch and retargets open pull requests;
//                                 a branch of that name already there is 409
//   branch_delete  {name}         never the default branch: refused before any request

import { isObjectId, isRefName } from "../paths.ts";
import { followed, onRepository } from "./act-settings.ts";
import { updateRepo } from "./store.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec, type Write } from "./types.ts";

export interface BranchDone {
  id: string;
  name: string;
  sha: string;
  /** The repository's default branch after the action. */
  defaultBranch: string | null;
  notes: string[];
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A branch name as the site takes it: a ref name, and no "refs/" prefix to confuse with a ref. */
const isBranchName = (v: unknown): v is string => isRefName(v) && !String(v).startsWith("refs/");

async function located(ctx: ActionContext<unknown>) {
  const row = followed(ctx.repo, ["active"]);
  const info = await ctx.session.repos.getById({ forge: row.forge, id: row.repo_id });
  if (info.key.id !== row.repo_id) throw new ForgeProblem(502, "mismatch", "GitHub answered for another repository: nothing was done.");
  return { row, info };
}

export const branchCreateSpec: ActionSpec<{ name: string; from: string }, BranchDone> = {
  kind: "branch_create",
  needsRepo: true,
  checkTarget: onRepository,
  validate(payload) {
    if (!isObject(payload) || !isBranchName(payload.name)) return bad("The new branch's name is not a branch name.");
    if (!(isRefName(payload.from) || isObjectId(payload.from))) return bad("Start it from a branch, a tag or a full commit id.");
    return { name: payload.name, from: payload.from as string };
  },
  describe: (p) => `Create the branch ${p.name} from ${p.from}`,
  async perform(ctx) {
    const { row, info } = await located(ctx as ActionContext<unknown>);
    const sha = isObjectId(ctx.parsed.from) ? ctx.parsed.from : await ctx.session.git.resolve(info.ref, ctx.parsed.from);
    const b = await ctx.session.git.createBranch(info.ref, ctx.parsed.name, sha);
    return {
      result: { id: row.repo_id, name: b.name, sha: b.sha, defaultBranch: info.defaultBranch, notes: [] },
      writes: [],
      repo: { forge: row.forge, repoId: row.repo_id, branch: b.name },
    };
  },
  check: (r, p, ctx) => r.id === ctx.repo?.repo_id && r.name === p.name,
};

export const branchRenameSpec: ActionSpec<{ from: string; to: string }, BranchDone> = {
  kind: "branch_rename",
  needsRepo: true,
  checkTarget: onRepository,
  validate(payload) {
    if (!isObject(payload) || !isBranchName(payload.from) || !isBranchName(payload.to)) return bad("Name the branch and its new name.");
    if (payload.from === payload.to) return bad("The new name is the same.");
    return { from: payload.from, to: payload.to };
  },
  describe: (p) => `Rename the branch ${p.from} to ${p.to}`,
  async perform(ctx) {
    const { row, info } = await located(ctx as ActionContext<unknown>);
    const b = await ctx.session.git.renameBranch(info.ref, ctx.parsed.from, ctx.parsed.to);
    const wasDefault = info.defaultBranch === ctx.parsed.from;
    const writes: Write[] = wasDefault ? [updateRepo(ctx.db, row.forge, row.repo_id, { defaultBranch: b.name }, ctx.t, { differs: true })] : [];
    const notes = ["Open pull requests from or into it now use the new name; clones keep the old one until they fetch: git branch -m, then git fetch --prune."];
    if (wasDefault) notes.unshift(`${b.name} stays the default branch.`);
    return {
      result: { id: row.repo_id, name: b.name, sha: b.sha, defaultBranch: wasDefault ? b.name : info.defaultBranch, notes },
      writes,
      repo: { forge: row.forge, repoId: row.repo_id, branch: b.name },
    };
  },
  check: (r, p, ctx) => r.id === ctx.repo?.repo_id && r.name === p.to,
};

export const branchDeleteSpec: ActionSpec<{ name: string }, BranchDone> = {
  kind: "branch_delete",
  needsRepo: true,
  checkTarget: onRepository,
  validate: (payload) => (isObject(payload) && isBranchName(payload.name) ? { name: payload.name } : bad("Name the branch to delete.")),
  describe: (p) => `Delete the branch ${p.name}`,
  async perform(ctx) {
    // Never the default branch: refused before any request.
    if (ctx.repo && ctx.parsed.name === ctx.repo.default_branch) {
      throw new ForgeProblem(400, "default_branch", "The default branch cannot be deleted: make another branch the default first.");
    }
    const { row, info } = await located(ctx as ActionContext<unknown>);
    if (ctx.parsed.name === info.defaultBranch) {
      throw new ForgeProblem(400, "default_branch", "The default branch cannot be deleted: make another branch the default first.");
    }
    const branch = await ctx.session.git.getBranch(info.ref, ctx.parsed.name);
    await ctx.session.git.deleteBranch(info.ref, ctx.parsed.name);
    return {
      result: {
        id: row.repo_id,
        name: branch.name,
        sha: branch.sha,
        defaultBranch: info.defaultBranch,
        notes: [`Its last commit, ${branch.sha.slice(0, 12)}, stays reachable on GitHub for a while: a branch made from it brings it back.`],
      },
      writes: [],
      repo: { forge: row.forge, repoId: row.repo_id, branch: branch.name },
    };
  },
  check: (r, p, ctx) => r.id === ctx.repo?.repo_id && r.name === p.name,
};

export const REF_ACTIONS: readonly AnyActionSpec[] = [branchCreateSpec, branchRenameSpec, branchDeleteSpec];
