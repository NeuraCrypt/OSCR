// Maintainer verification, through GitHub's API with the person's own token (fresh from the
// callback: 5,000 requests an hour are theirs, not the Worker's shared address's 60). In order,
// stopping at the first yes, three API requests at most:
//
// 1. the signed-in login is the repository's owner in `repo_owner` (no request);
// 2. it is a public member of the owning organization: GET /orgs/{owner}/public_members/{login}
//    answers 204;
// 3. it is among the repository's public contributors: GET /repos/{owner}/{name}/contributors
//    (the first 100, by number of commits);
// 4. when that list was full or refused (a very large history), a commit of the login in the
//    repository: GET /repos/{owner}/{name}/commits?author={login}&per_page=1.
//
// No answer, or a no: the claim waits for a moderator (Phase 7).

import { githubApi, type Provider } from "./providers.ts";

export type Via = "owner" | "org_member" | "contributor" | "commit_author";

export interface MaintainerCheck {
  verified: boolean;
  via: Via | null;
  checked: Via[];
  requests: number;
}

/** GitHub could not answer (down, rate-limited, token refused): nothing is decided. */
export class GithubUnavailable extends Error {}

function limited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
}

export async function checkMaintainer(
  p: Provider,
  token: string,
  a: { login: string; owner: string; name: string },
): Promise<MaintainerCheck> {
  const me = a.login.toLowerCase();
  const owner = encodeURIComponent(a.owner);
  const name = encodeURIComponent(a.name);
  const out: MaintainerCheck = { verified: false, via: null, checked: [], requests: 0 };
  const yes = (via: Via): MaintainerCheck => ({ ...out, verified: true, via });
  const ask = async (path: string): Promise<Response> => {
    out.requests += 1;
    const res = await githubApi(p, token, path);
    if (limited(res) || res.status === 401 || res.status >= 500) throw new GithubUnavailable(`GitHub answered ${res.status} for ${path}`);
    return res;
  };

  out.checked.push("owner");
  if (me === a.owner.toLowerCase()) return yes("owner");

  out.checked.push("org_member");
  const member = await ask(`/orgs/${owner}/public_members/${encodeURIComponent(a.login)}`);
  if (member.status === 204) return yes("org_member");

  out.checked.push("contributor");
  const contributors = await ask(`/repos/${owner}/${name}/contributors?per_page=100`);
  let full = contributors.status === 403;          // "the history or contributor list is too large"
  if (contributors.status === 200) {
    const list = (await contributors.json().catch(() => [])) as { login?: unknown }[];
    if (Array.isArray(list) && list.some((c) => typeof c?.login === "string" && c.login.toLowerCase() === me)) return yes("contributor");
    full = Array.isArray(list) && list.length >= 100;
  }
  if (full) {
    out.checked.push("commit_author");
    const commits = await ask(`/repos/${owner}/${name}/commits?author=${encodeURIComponent(a.login)}&per_page=1`);
    if (commits.status === 200) {
      const list = (await commits.json().catch(() => [])) as unknown[];
      if (Array.isArray(list) && list.length > 0) return yes("commit_author");
    }
  }
  return out;
}
