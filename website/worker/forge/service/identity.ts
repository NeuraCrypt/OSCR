// Who acts (the design's §10.2 step 5, and §17 "Identity"): the GitHub account that authorized an
// action must be the one linked to the signed-in account of the registry, in oscr_community
// `identities` (provider 'github', the subject being GitHub's numeric user id).
//
// - Linked to this account: it acts (its login refreshed in `users` when GitHub renamed it: 1 row,
//   only then).
// - Linked to nobody, and the account has no GitHub identity yet: it is linked now, under the
//   sign-in's own rules (account/store.ts `linkIdentity`: 2 rows, plus 1 for the login), so that one
//   GitHub account belongs to one account of the registry.
// - Linked to another account of the registry: 409 identity_conflict, nothing done.
// - Linked to nobody, but the account already has another GitHub identity: 409 identity_mismatch,
//   nothing done (an account has at most one identity per provider).
//
// Only the id and the login are read from GitHub: never a name, never an email address.

import { AccountError, identitiesOf, identityOwner, linkIdentity, refreshUser, type User } from "../../account/store.ts";
import type { Person } from "../../account/providers.ts";
import { ForgeProblem, type D1Database } from "./types.ts";

export interface GithubAccount {
  id: string;
  login: string;
}

const conflict = (login: string) =>
  new ForgeProblem(
    409,
    "identity_conflict",
    `The GitHub account ${login} is linked to another account of the registry: nothing was done. Sign in to that account, or authorize with the GitHub account linked to yours.`,
  );

const mismatch = (login: string) =>
  new ForgeProblem(
    409,
    "identity_mismatch",
    `You authorized as the GitHub account ${login}, but your account of the registry is linked to another GitHub account: nothing was done. Sign in to GitHub with the linked account, then start again.`,
  );

/** The numeric id of the GitHub account linked to this user, or null (the identities_user index:
 *  the user's few identities read). */
export async function linkedGithub(community: D1Database, userId: string): Promise<string | null> {
  const mine = await identitiesOf(community, userId);
  return mine.find((i) => i.provider === "github")?.subject ?? null;
}

/** The signed-in user, once the GitHub account that authorized is known to be theirs (linked now
 *  when nobody has it), or the problem that says why it is not. */
export async function requireIdentity(community: D1Database, user: User, github: GithubAccount, t: number): Promise<User | ForgeProblem> {
  const id = String(github.id);
  if (!/^\d{1,20}$/.test(id)) return new ForgeProblem(401, "unauthorized", "GitHub did not say which account authorized: please start the action again.");
  const person: Person = { provider: "github", subject: id, name: "", handle: github.login };
  const owner = await identityOwner(community, "github", id);
  if (owner === user.id) return refreshUser(community, user, person);
  if (owner) return conflict(github.login);
  if ((await linkedGithub(community, user.id)) !== null) return mismatch(github.login);
  try {
    return await linkIdentity(community, user, person, t);
  } catch (e) {
    if (e instanceof AccountError && e.code === "identity_in_use") return conflict(github.login);
    if (e instanceof AccountError && e.code === "provider_already_linked") return mismatch(github.login);
    throw e;
  }
}
