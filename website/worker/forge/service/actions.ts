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
// A kind registered twice, or one that is not in ACTION_KINDS, stops the Worker at load.

import { AUTOLINK_ACTIONS } from "./act-autolinks.ts";
import { COMMIT_ACTIONS } from "./act-commit.ts";
import { CREATE_ACTIONS } from "./act-create.ts";
import { DELETE_ACTIONS } from "./act-delete.ts";
import { LINK_ACTIONS } from "./act-link.ts";
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
]);
