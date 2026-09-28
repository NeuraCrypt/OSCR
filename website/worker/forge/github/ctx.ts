// What every method of a GitHub session shares: the credential's kind and capabilities, the
// limits, the links, the request core and the clock. Each group (repos.ts, git.ts, pulls.ts,
// issues.ts, releases.ts, checks.ts) is a factory over it.

import type { ForgeLinks } from "../gitbackend.ts";
import type { BackendLimits, Capability } from "../limits.ts";
import { checkRepo } from "../paths.ts";
import { type Act, guard } from "../rules.ts";
import type { CredentialKind, Page, RepoRef } from "../types.ts";
import type { Http, Scope } from "./http.ts";
import { list } from "./map.ts";

export interface Ctx {
  kind: CredentialKind;
  caps: ReadonlySet<Capability>;
  limits: BackendLimits;
  links: ForgeLinks;
  http: Http;
  now: () => number;
}

/** "/repos/{owner}/{name}", escaped, once the names are checked. */
export function R(repo: RepoRef): string {
  checkRepo(repo);
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** The rule of rules.ts for this session. */
export function need(ctx: Ctx, act: Act, capability?: Capability | null, fallbackUrl?: string | null): void {
  guard(ctx.kind, ctx.caps, act, capability, fallbackUrl);
}

/** An installation token's scope: this repository, and what the act needs. */
export function scope(repo: RepoRef, act: Scope["act"]): Scope {
  return { act, repo: repo.name };
}

/** A REST list answer as a page. */
export function paged<T>(items: unknown, map: (v: unknown) => T, next: string | null, what = "list"): Page<T> {
  return { items: list(items, what).map(map), next };
}
