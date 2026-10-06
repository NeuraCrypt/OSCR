// The GitHub side's search answers without what moderation hid since the index's last push (night
// phase 16): research issues by their number, repositories by their path (the repos_path index, then
// the moderation key). People and topics leave the index at the next push (oscr/moderation.py).

import { hiddenAmong } from "./hidden.ts";
import { all } from "./store.ts";
import type { D1Database } from "./types.ts";

type Result = { k?: unknown; n?: unknown; path?: unknown };

export async function withoutHidden(db: D1Database, results: unknown[]): Promise<unknown[]> {
  const list = results as Result[];
  const issues = list.filter((x) => x?.k === "issue" && Number.isInteger(x.n)).map((x) => String(x.n));
  const paths = list.filter((x) => x?.k === "repository" && typeof x.path === "string" && /^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(x.path as string)).map((x) => (x.path as string).toLowerCase());
  if (!issues.length && !paths.length) return results;
  const hiddenIssues = await hiddenAmong(db, "research", issues);
  const ids = new Map<string, string>();
  for (const path of paths) {
    const [owner, name] = path.split("/");
    for (const r of await all<{ forge: string; repo_id: string }>(db.prepare("SELECT forge, repo_id FROM repos WHERE forge = 'github' AND owner_login = ? AND name = ? LIMIT 1").bind(owner, name))) {
      ids.set(`${r.forge}:${r.repo_id}`, path);
    }
  }
  const hiddenRepos = new Set([...(await hiddenAmong(db, "repo", ids.keys())).keys()].map((k) => ids.get(k)));
  return list.filter((x) => !(x?.k === "issue" && hiddenIssues.has(String(x.n))) && !(x?.k === "repository" && hiddenRepos.has(String(x.path).toLowerCase())));
}
