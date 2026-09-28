// Custom autolinks to external resources as authorized actions (E1), on a repository the registry
// knows, as the person (GitHub requires its admin). The action row only.
//
//   autolink_create  {keyPrefix, urlTemplate (with <num>), isAlphanumeric?}
//   autolink_delete  {id}
//
// Research use (the Settings page, E8): a repository's issues and commits that mention an RRID
// ("RRID:SCR_…"), a protocol id or a lab's sample ids become links to their resolvers.

import { AUTOLINK_PREFIX, checkAutolink } from "../paths.ts";
import type { Autolink } from "../types.ts";
import { current, followed, onRepository } from "./act-settings.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec } from "./types.ts";

export interface AutolinkDone {
  id: string;
  autolink: Autolink;
  /** The repository's autolinks after the action. */
  autolinks: Autolink[];
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const autolinkCreateSpec: ActionSpec<{ keyPrefix: string; urlTemplate: string; isAlphanumeric: boolean }, AutolinkDone> = {
  kind: "autolink_create",
  needsRepo: true,
  checkTarget: onRepository,
  validate(payload) {
    try {
      return checkAutolink(payload);
    } catch {
      if (isObject(payload) && typeof payload.keyPrefix === "string" && !AUTOLINK_PREFIX.test(payload.keyPrefix)) {
        return bad("The prefix is letters, digits and . - _ + = : / #, at most 32 characters.");
      }
      return bad("The address is an https (or http) address holding <num>, where the identifier goes.");
    }
  },
  describe: (p) => `Link every “${p.keyPrefix}…” in the repository's issues and commits to ${p.urlTemplate}`,
  async perform(ctx) {
    const row = followed(ctx.repo, ["active"]);
    const info = await current(ctx as ActionContext<unknown>, row);
    const made = await ctx.session.repos.createAutolink(info.ref, ctx.parsed);
    const autolinks = await ctx.session.repos.autolinks(info.ref);
    return { result: { id: row.repo_id, autolink: made, autolinks }, writes: [], repo: { forge: row.forge, repoId: row.repo_id } };
  },
  check: (r, p, ctx) =>
    r.id === ctx.repo?.repo_id && r.autolink.keyPrefix === p.keyPrefix && r.autolink.urlTemplate === p.urlTemplate && r.autolink.isAlphanumeric === p.isAlphanumeric,
};

export const autolinkDeleteSpec: ActionSpec<{ id: string }, AutolinkDone> = {
  kind: "autolink_delete",
  needsRepo: true,
  checkTarget: onRepository,
  validate: (payload) => (isObject(payload) && typeof payload.id === "string" && /^\d{1,20}$/.test(payload.id) ? { id: payload.id } : bad("Name the autolink to delete.")),
  describe: () => "Delete this autolink of the repository",
  async perform(ctx) {
    const row = followed(ctx.repo, ["active"]);
    const info = await current(ctx as ActionContext<unknown>, row);
    const before = await ctx.session.repos.autolinks(info.ref);
    const gone = before.find((a) => a.id === ctx.parsed.id);
    if (!gone) throw new ForgeProblem(404, "not_found", "The repository has no such autolink (any more): nothing was done.");
    await ctx.session.repos.deleteAutolink(info.ref, gone.id);
    const autolinks = await ctx.session.repos.autolinks(info.ref);
    return { result: { id: row.repo_id, autolink: gone, autolinks }, writes: [], repo: { forge: row.forge, repoId: row.repo_id } };
  },
  check: (r, p, ctx) => r.id === ctx.repo?.repo_id && r.autolink.id === p.id && !r.autolinks.some((a) => a.id === p.id),
};

export const AUTOLINK_ACTIONS: readonly AnyActionSpec[] = [autolinkCreateSpec, autolinkDeleteSpec];
