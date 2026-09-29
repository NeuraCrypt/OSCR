// The registry of authorized actions: every kind of types.ts ACTION_KINDS, with the spec that
// validates, describes, performs and checks it. start.ts and act.ts (E1) look a kind up here, or
// in the registry a test injects (ForgeDeps.actions).
//
// Registration points (each element exports one array from its own file, and adds nothing here):
//   act-create.ts     CREATE_ACTIONS     create, generate                                  (E2)
//   act-link.ts       LINK_ACTIONS       link, papers                                      (E3)
//   act-settings.ts   SETTINGS_ACTIONS   rename, edit, topics, features, template,
//                                        default_branch, archive, unarchive, transfer      (E4)
//   act-refs.ts       REF_ACTIONS        branch_create, branch_rename, branch_delete       (E4)
//   act-delete.ts     DELETE_ACTIONS     delete_request, restore, delete_final,
//                                        software_heritage                                 (E4)
//   act-autolinks.ts  AUTOLINK_ACTIONS   autolink_create, autolink_delete                  (E5)
//   act-commit.ts     COMMIT_ACTIONS     commit                                (phase 03, E1)
//   act-forks.ts      FORK_ACTIONS       fork, fork_sync                       (phase 04, E1)
//   act-pulls.ts      PULL_ACTIONS       pull_open, pull_edit, pull_review, pull_comment,
//                                        pull_thread, pull_merge, pull_update, pull_revert
//                                                                              (phase 04, E1)
//   act-issues.ts     ISSUE_ACTIONS      issue_open, issue_edit, issue_comment, issue_react,
//                                        issue_lock, issue_pin, issue_transfer, issue_relation,
//                                        issue_branch, issue_labels, issue_milestone (phase 05, E1)
//   act-research.ts   RESEARCH_ACTIONS   research_copy                         (phase 05, E2)
//   act-releases.ts   RELEASE_ACTIONS    release_create, release_edit, release_delete,
//                                        release_drafts, release_research, tag_create,
//                                        tag_delete, asset_upload, asset_delete (phase 07, E1)
// (The registry's own writes of research issues, research_open, research_comment and research_edit,
// are routes of research.ts, not authorized actions: they are in RESEARCH_KINDS, not here.)
// A kind registered twice, or one that is not in ACTION_KINDS, stops the Worker at load.

import { AUTOLINK_ACTIONS } from "./act-autolinks.ts";
import { COMMIT_ACTIONS } from "./act-commit.ts";
import { CREATE_ACTIONS } from "./act-create.ts";
import { DELETE_ACTIONS } from "./act-delete.ts";
import { FORK_ACTIONS } from "./act-forks.ts";
import { ISSUE_ACTIONS } from "./act-issues.ts";
import { LINK_ACTIONS } from "./act-link.ts";
import { PULL_ACTIONS } from "./act-pulls.ts";
import { RELEASE_ACTIONS } from "./act-releases.ts";
import { RESEARCH_ACTIONS } from "./act-research.ts";
import { REF_ACTIONS } from "./act-refs.ts";
import { SETTINGS_ACTIONS } from "./act-settings.ts";
import { isActionKind, type ActionKind, type ActionRegistry, type AnyActionSpec } from "./types.ts";

/** Which file registers each kind. */
export const REGISTERED_IN: Readonly<Record<ActionKind, string>> = {
  create: "act-create.ts",
  generate: "act-create.ts",
  link: "act-link.ts",
  papers: "act-link.ts",
  rename: "act-settings.ts",
  edit: "act-settings.ts",
  topics: "act-settings.ts",
  features: "act-settings.ts",
  template: "act-settings.ts",
  default_branch: "act-settings.ts",
  archive: "act-settings.ts",
  unarchive: "act-settings.ts",
  transfer: "act-settings.ts",
  branch_create: "act-refs.ts",
  branch_rename: "act-refs.ts",
  branch_delete: "act-refs.ts",
  autolink_create: "act-autolinks.ts",
  autolink_delete: "act-autolinks.ts",
  delete_request: "act-delete.ts",
  restore: "act-delete.ts",
  delete_final: "act-delete.ts",
  software_heritage: "act-delete.ts",
  commit: "act-commit.ts",
  fork: "act-forks.ts",
  fork_sync: "act-forks.ts",
  pull_open: "act-pulls.ts",
  pull_edit: "act-pulls.ts",
  pull_review: "act-pulls.ts",
  pull_comment: "act-pulls.ts",
  pull_thread: "act-pulls.ts",
  pull_merge: "act-pulls.ts",
  pull_update: "act-pulls.ts",
  pull_revert: "act-pulls.ts",
  issue_open: "act-issues.ts",
  issue_edit: "act-issues.ts",
  issue_comment: "act-issues.ts",
  issue_react: "act-issues.ts",
  issue_lock: "act-issues.ts",
  issue_pin: "act-issues.ts",
  issue_transfer: "act-issues.ts",
  issue_relation: "act-issues.ts",
  issue_branch: "act-issues.ts",
  issue_labels: "act-issues.ts",
  issue_milestone: "act-issues.ts",
  research_copy: "act-research.ts",
  release_create: "act-releases.ts",
  release_edit: "act-releases.ts",
  release_delete: "act-releases.ts",
  release_drafts: "act-releases.ts",
  release_research: "act-releases.ts",
  tag_create: "act-releases.ts",
  tag_delete: "act-releases.ts",
  asset_upload: "act-releases.ts",
  asset_delete: "act-releases.ts",
};

/** A registry of these specs; a duplicate or an unknown kind is a programming error. */
export function registry(specs: readonly AnyActionSpec[]): ActionRegistry {
  const map = new Map<ActionKind, AnyActionSpec>();
  for (const spec of specs) {
    if (!isActionKind(spec?.kind)) throw new TypeError(`not an action kind: ${String(spec?.kind)}`);
    if (map.has(spec.kind)) throw new TypeError(`the action ${spec.kind} is registered twice`);
    map.set(spec.kind, spec);
  }
  return map;
}

export const ACTIONS: ActionRegistry = registry([
  ...CREATE_ACTIONS,
  ...LINK_ACTIONS,
  ...SETTINGS_ACTIONS,
  ...REF_ACTIONS,
  ...DELETE_ACTIONS,
  ...AUTOLINK_ACTIONS,
  ...COMMIT_ACTIONS,
  ...FORK_ACTIONS,
  ...PULL_ACTIONS,
  ...ISSUE_ACTIONS,
  ...RESEARCH_ACTIONS,
  ...RELEASE_ACTIONS,
]);
