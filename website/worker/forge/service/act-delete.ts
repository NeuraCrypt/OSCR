// Deletion (D00-10) and the Software Heritage request (D00-15), as authorized actions (E1).
//
//   delete_request     {confirmName: "owner/name" as the person typed it, maps: the count shown}
//                      archives the repository on GitHub, hides it from the registry's pages at
//                      once (state pending_deletion), and sets the end of the grace period
//                      (delete_after = now + 30 days) with a delete_due job for the Mac, which only
//                      hides it then (D01-8). repos 1 + job 1 + the action row.
//   restore            {} during the grace period: unarchived on GitHub, followed again. repos 1.
//   delete_final       {confirmName} once a deletion was asked (pending, or hidden at the end of
//                      its grace period): the repository deleted on GitHub, as the person, by this
//                      fresh authorization only: no timer, job or token of the registry ever
//                      deletes (the Mac's delete_due job only hides). repos 1.
//   software_heritage  {} a Software Heritage "Save Code Now" request, made by the Mac (an archive
//                      job), on this person's request only; nothing written on GitHub. job 1.

import { GRACE_SECONDS } from "./caps.ts";
import { current, followed, onRepository, pageOf } from "./act-settings.ts";
import { all, insertJob, tracedCount, updateRepo } from "./store.ts";
import { ForgeProblem, type ActionContext, type ActionSpec, type AnyActionSpec, type RepoRow } from "./types.ts";

export interface DeleteDone {
  id: string;
  owner: string;
  name: string;
  state: RepoRow["state"];
  /** The end of the grace period (Unix seconds), when there is one. */
  deleteAfter: number | null;
  page: string;
  notes: string[];
}

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const empty = (payload: unknown) => (isObject(payload) && Object.keys(payload).length === 0 ? {} : bad("This action takes no content."));
const days = Math.round(GRACE_SECONDS / 86_400);

function typedName(payload: Record<string, unknown>): string | ForgeProblem {
  const v = payload.confirmName;
  if (typeof v !== "string" || !v.trim() || v.length > 201) return bad("Type the repository's owner and name to confirm.");
  return v.trim();
}

/** The name the person typed must be the repository's, exactly (letter case aside). */
function confirmed(typed: string, row: RepoRow, label: string): void {
  if (typed.toLowerCase() !== label.toLowerCase()) {
    throw new ForgeProblem(400, "confirm_name", `What you typed is not ${label}: nothing was done.`);
  }
}

const labelOf = (row: RepoRow, info?: { ref: { owner: string; name: string } }) => (info ? `${info.ref.owner}/${info.ref.name}` : `${row.owner_login}/${row.name}`);

export const deleteRequestSpec: ActionSpec<{ confirmName: string; maps: number }, DeleteDone> = {
  kind: "delete_request",
  needsRepo: true,
  checkTarget: onRepository,
  validate(payload) {
    if (!isObject(payload)) return bad("Type the repository's owner and name to confirm.");
    const name = typedName(payload);
    if (typeof name !== "string") return name;
    if (typeof payload.maps !== "number" || !Number.isInteger(payload.maps) || payload.maps < 0) return bad("The count of tracing maps shown is missing.");
    return { confirmName: name, maps: payload.maps };
  },
  describe: (p) =>
    `Ask for the deletion of ${p.confirmName}: archived on GitHub and hidden here now, deleted only if you confirm again after ${days} days` +
    (p.maps ? `; ${p.maps} tracing ${p.maps === 1 ? "map points" : "maps point"} to it` : ""),
  async perform(ctx) {
    const row = followed(ctx.repo);
    confirmed(ctx.parsed.confirmName, row, labelOf(row));
    // The count the page showed is still the count: the person knew what points to it.
    const counted = (await all<{ maps: number }>(tracedCount(ctx.db, row.forge, row.repo_id)))[0]?.maps ?? 0;
    if (Number(counted) !== ctx.parsed.maps) {
      throw new ForgeProblem(409, "maps_changed", "The tracing maps that point to this repository changed since the page was shown: reload it, then ask again.");
    }
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = info.archived ? info : await ctx.session.repos.update(info.ref, { archived: true });
    const deleteAfter = ctx.t + GRACE_SECONDS;
    return {
      result: {
        id: row.repo_id,
        owner: out.ref.owner,
        name: out.ref.name,
        state: "pending_deletion",
        deleteAfter,
        page: pageOf(out.ref),
        notes: [
          `Archived on GitHub and hidden from the registry's pages. Until ${new Date(deleteAfter * 1000).toISOString().slice(0, 10)} (UTC), “Your repositories” can restore it.`,
          "Nothing is deleted on GitHub unless you confirm it yourself afterwards.",
        ],
      },
      writes: [
        updateRepo(ctx.db, row.forge, row.repo_id, { state: "pending_deletion", deleteAfter }, ctx.t, { states: ["active", "archived"] }),
        insertJob(ctx.db, { kind: "delete_due", forge: row.forge, repoId: row.repo_id, userId: ctx.user.id, notBefore: deleteAfter }, ctx.t),
      ],
      repo: { forge: row.forge, repoId: row.repo_id },
    };
  },
  check: (r, _p, ctx) => r.id === ctx.repo?.repo_id,
};

export const restoreSpec: ActionSpec<Record<string, never>, DeleteDone> = {
  kind: "restore",
  needsRepo: true,
  checkTarget: onRepository,
  validate: empty,
  describe: () => "Restore the repository: unarchived on GitHub, and shown again here",
  async perform(ctx) {
    const row = followed(ctx.repo, ["pending_deletion"]);
    const info = await current(ctx as ActionContext<unknown>, row);
    const out = info.archived ? await ctx.session.repos.update(info.ref, { archived: false }) : info;
    return {
      result: { id: row.repo_id, owner: out.ref.owner, name: out.ref.name, state: "active", deleteAfter: null, page: pageOf(out.ref), notes: [] },
      writes: [updateRepo(ctx.db, row.forge, row.repo_id, { state: "active", deleteAfter: null }, ctx.t, { states: ["pending_deletion"] })],
      repo: { forge: row.forge, repoId: row.repo_id },
    };
  },
  check: (r, _p, ctx) => r.id === ctx.repo?.repo_id,
};

export const deleteFinalSpec: ActionSpec<{ confirmName: string }, DeleteDone> = {
  kind: "delete_final",
  needsRepo: true,
  checkTarget: onRepository,
  validate(payload) {
    if (!isObject(payload)) return bad("Type the repository's owner and name to confirm.");
    const name = typedName(payload);
    return typeof name === "string" ? { confirmName: name } : name;
  },
  describe: (p) => `Delete ${p.confirmName} on GitHub, for good`,
  async perform(ctx) {
    const row = ctx.repo;
    // Only after a deletion was asked: pending, or hidden once its grace period ended (D01-8).
    const asked = !!row && (row.state === "pending_deletion" || (row.state === "hidden" && row.delete_after !== null));
    if (!row || !asked) throw new ForgeProblem(409, "not_requested", "Ask for the deletion first: the repository is archived and kept for a grace period before it can be deleted.");
    const info = await current(ctx as ActionContext<unknown>, row);
    confirmed(ctx.parsed.confirmName, row, labelOf(row, info));
    await ctx.session.repos.delete(info.ref);
    return {
      result: {
        id: row.repo_id,
        owner: info.ref.owner,
        name: info.ref.name,
        state: "deleted",
        deleteAfter: row.delete_after,
        page: pageOf(info.ref),
        notes: [
          "Deleted on GitHub. GitHub keeps a deleted repository for 90 days: its owner can restore it from GitHub's settings.",
          "Its tracing maps say “no longer at the source”, and keep the script copies its licence allowed and the Software Heritage archive when there is one.",
        ],
      },
      writes: [updateRepo(ctx.db, row.forge, row.repo_id, { state: "deleted" }, ctx.t, { states: ["pending_deletion", "hidden"] })],
      repo: { forge: row.forge, repoId: row.repo_id },
    };
  },
  check: (r, _p, ctx) => r.id === ctx.repo?.repo_id,
};

export const softwareHeritageSpec: ActionSpec<Record<string, never>, DeleteDone> = {
  kind: "software_heritage",
  needsRepo: true,
  checkTarget: onRepository,
  validate: empty,
  describe: () => "Ask Software Heritage to save the repository now",
  async perform(ctx) {
    const row = followed(ctx.repo, ["active", "archived", "pending_deletion"]);
    // The authorization proves the person's permission on it; nothing is written on GitHub.
    const info = await current(ctx as ActionContext<unknown>, row);
    const permission = await ctx.session.repos.permission(info.ref, ctx.github.login);
    if (permission !== "admin" && permission !== "maintain" && permission !== "write") {
      throw new ForgeProblem(403, "not_maintainer", "Only a person who may push to this repository can ask for its archive here; anyone can on Software Heritage's own site.");
    }
    return {
      result: {
        id: row.repo_id,
        owner: info.ref.owner,
        name: info.ref.name,
        state: row.state,
        deleteAfter: row.delete_after,
        page: pageOf(info.ref),
        notes: ["The request goes to Software Heritage within the hour; the repository's page shows its answer."],
      },
      writes: [insertJob(ctx.db, { kind: "archive", forge: row.forge, repoId: row.repo_id, userId: ctx.user.id }, ctx.t)],
      repo: { forge: row.forge, repoId: row.repo_id },
    };
  },
  check: (r, _p, ctx) => r.id === ctx.repo?.repo_id,
};

export const DELETE_ACTIONS: readonly AnyActionSpec[] = [deleteRequestSpec, restoreSpec, deleteFinalSpec, softwareHeritageSpec];
