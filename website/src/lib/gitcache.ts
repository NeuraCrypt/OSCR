// The tab's cache of GitHub's answers (night phase 02, E1): a signed-out reader has 60 anonymous
// requests an hour (D00-5), so what never changes is asked once per tab.
//
// - A tree, a commit, a commit list or a comparison asked at full commit ids never changes: it is
//   kept for the tab's life.
// - The repository, its branches, its tags, its languages and its licence change: they are kept 5
//   minutes (GitHub's own answers say `max-age=60`; a page reloaded within minutes needs no
//   request).
// - Raw files are not counted in the 60 and the browser's own cache keeps them: not here.
//
// The store is the tab's sessionStorage (a key per answer, "oscr-gh:" first), with a copy in
// memory for the page; a store that is full, missing or refuses (a private window) only loses the
// saving, never the answer. Nothing is kept that a signed-out reader could not read on GitHub: no
// token, no private repository (anonymous sessions only), and the answers' text is the forge's own
// (renderers mask email addresses when they show it).

import type { GitSession } from "../../worker/forge/gitbackend.ts";
import { isObjectId } from "../../worker/forge/paths.ts";
import type * as T from "../../worker/forge/types.ts";

/** The part of Storage the cache uses (sessionStorage in the browser, a Map in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export const CACHE_PREFIX = "oscr-gh:";
/** How long an answer that can change is kept. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** An answer larger than this stays in memory only (sessionStorage holds ~5 MB a site). */
export const CACHE_ENTRY_CHARS = 1_500_000;

interface Entry {
  /** Unix milliseconds after which it is asked again; 0: never. */
  until: number;
  value: unknown;
}

export interface GitCache {
  get<V>(key: string, ttl: number | null, ask: () => Promise<V>): Promise<V>;
  /** How many answers came from the cache (the tests count them). */
  readonly hits: number;
}

/** A cache over `store` (null: memory only). `ttl` null keeps the answer for the tab's life. */
export function gitCache(store: KeyValueStore | null, now: () => number = () => Date.now()): GitCache {
  const memory = new Map<string, Entry>();
  let hits = 0;
  const read = (key: string): Entry | null => {
    const m = memory.get(key);
    if (m) return m;
    if (!store) return null;
    try {
      const raw = store.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const e = JSON.parse(raw) as Entry;
      if (!e || typeof e !== "object" || typeof e.until !== "number") return null;
      memory.set(key, e);
      return e;
    } catch {
      return null;
    }
  };
  const write = (key: string, e: Entry) => {
    memory.set(key, e);
    if (!store) return;
    let text: string;
    try {
      text = JSON.stringify(e);
    } catch {
      return;
    }
    if (text.length > CACHE_ENTRY_CHARS) return;
    try {
      store.setItem(CACHE_PREFIX + key, text);
    } catch {
      // Full: drop this tab's older answers, then try once more.
      try {
        const keys: string[] = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
        }
        for (const k of keys) store.removeItem(k);
        store.setItem(CACHE_PREFIX + key, text);
      } catch {
        // memory only
      }
    }
  };
  return {
    get hits() {
      return hits;
    },
    async get<V>(key: string, ttl: number | null, ask: () => Promise<V>): Promise<V> {
      const e = read(key);
      if (e && (e.until === 0 || e.until > now())) {
        hits += 1;
        return e.value as V;
      }
      const value = await ask();
      write(key, { until: ttl === null ? 0 : now() + ttl, value });
      return value;
    },
  };
}

const refKey = (r: T.RepoRef) => `${r.forge}/${r.owner}/${r.name}`.toLowerCase();
const pageKey = (p?: T.PageRequest) => `${p?.cursor ?? ""}:${p?.perPage ?? ""}`;

/** The same anonymous session, its reads that never change and a few that change slowly asked
 *  once. Every other method is the session's own. */
export function cachedSession(session: GitSession, cache: GitCache): GitSession {
  const repos = session.repos;
  const git = session.git;
  const reposOver: Partial<typeof repos> = {
    get: (ref) => cache.get(`repo:${refKey(ref)}`, CACHE_TTL_MS, () => repos.get(ref)),
    languages: (ref) => cache.get(`languages:${refKey(ref)}`, CACHE_TTL_MS, () => repos.languages(ref)),
    license: (ref) => cache.get(`license:${refKey(ref)}`, CACHE_TTL_MS, () => repos.license(ref)),
  };
  const gitOver: Partial<typeof git> = {
    listBranches: (ref, page) => cache.get(`branches:${refKey(ref)}:${pageKey(page)}`, CACHE_TTL_MS, () => git.listBranches(ref, page)),
    listTags: (ref, page) => cache.get(`tags:${refKey(ref)}:${pageKey(page)}`, CACHE_TTL_MS, () => git.listTags(ref, page)),
    resolve: (ref, rev) => (isObjectId(rev) ? Promise.resolve(rev) : cache.get(`resolve:${refKey(ref)}:${rev}`, 60_000, () => git.resolve(ref, rev))),
    tree: (ref, rev, options = {}) =>
      isObjectId(rev)
        ? cache.get(`tree:${refKey(ref)}:${rev}:${options.path ?? ""}:${options.recursive ? 1 : 0}`, null, () => git.tree(ref, rev, options))
        : git.tree(ref, rev, options),
    commit: (ref, sha, page) =>
      isObjectId(sha) ? cache.get(`commit:${refKey(ref)}:${sha}:${pageKey(page)}`, null, () => git.commit(ref, sha, page)) : git.commit(ref, sha, page),
    commits: (ref, filter = {}, page) =>
      filter.rev && isObjectId(filter.rev) && !filter.since && !filter.until
        ? cache.get(`commits:${refKey(ref)}:${JSON.stringify(filter)}:${pageKey(page)}`, null, () => git.commits(ref, filter, page))
        : git.commits(ref, filter, page),
    compare: (ref, base, head, page) =>
      isObjectId(base) && isObjectId(head)
        ? cache.get(`compare:${refKey(ref)}:${base}:${head}:${pageKey(page)}`, null, () => git.compare(ref, base, head, page))
        : git.compare(ref, base, head, page),
  };
  const over = <O extends object>(target: O, overrides: Partial<O>): O =>
    new Proxy(target, {
      get(t, p, receiver) {
        if (Object.prototype.hasOwnProperty.call(overrides, p)) return (overrides as Record<PropertyKey, unknown>)[p];
        const v = Reflect.get(t, p, receiver);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return over(session, { repos: over(repos, reposOver), git: over(git, gitOver) } as Partial<GitSession>);
}

/** The tab's sessionStorage, or null when the browser refuses it. */
export function tabStore(): KeyValueStore | null {
  try {
    const s = globalThis.sessionStorage;
    if (!s) return null;
    s.getItem("oscr-gh:probe");
    return s;
  } catch {
    return null;
  }
}
