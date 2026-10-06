// Who may do what in a session: the rule shared by every backend (the GitHub adapter and the test
// double), checked before any request is made.
//
// - A write in an anonymous session is `unauthorized`: a person must authorize it.
// - OSCR's rule for installation sessions (D00-4): they act as the App itself, post check runs
//   and read an installed repository after its webhook. Every other mutation is `forbidden`,
//   "installation sessions only post check runs". A person's write always uses that person's own
//   token (GitHub's best practice), so the App never becomes a way around a collaborator's rights.
// - A check run created or updated in a user session is `forbidden`: check runs are the App's acts.
// - A method whose capability the session lacks is `unsupported`, with the forge page that can do
//   it as `fallbackUrl` when there is one (blame → links.blame, search → links.search, import →
//   links.importer).

import { GitBackendError } from "./errors.ts";
import type { Capability } from "./limits.ts";
import type { CredentialKind } from "./types.ts";

/** What a method does: read, write (any mutation but check runs), or post a check run. */
export type Act = "read" | "write" | "check";

export const INSTALLATION_RULE = "installation sessions only post check runs";

export function guard(
  kind: CredentialKind,
  caps: ReadonlySet<Capability>,
  act: Act,
  need?: Capability | null,
  fallbackUrl?: string | null,
): void {
  if (act !== "read") {
    if (kind === "anonymous") throw new GitBackendError("unauthorized", "a write needs a person's authorization");
    if (kind === "installation" && act === "write") throw new GitBackendError("forbidden", INSTALLATION_RULE);
    if (kind === "user" && act === "check") throw new GitBackendError("forbidden", "check runs are the App's acts");
    if (!caps.has("write")) throw new GitBackendError("unsupported", `this forge takes no write from ${kind} sessions`);
  } else if (!caps.has("read")) {
    throw new GitBackendError("unsupported", `this forge serves no read to ${kind} sessions`);
  }
  if (need && !caps.has(need)) {
    throw new GitBackendError("unsupported", `this forge does not offer "${need}" to ${kind} sessions`, fallbackUrl ? { fallbackUrl } : {});
  }
}
