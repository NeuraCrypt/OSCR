// The drafts a person saw, kept in the tab (night phase 07, E4; D07-*). A draft release is visible
// only to the people who may push, and the registry keeps no token (D00-4): the page never reads
// drafts anonymously. After an authorized action that shows the drafts (release_drafts) or saves one
// (release_create, release_edit), the callback page keeps what the Worker answered — masked texts,
// never a token — in the tab's sessionStorage, by repository; the releases page lists them, "as
// GitHub showed them to you", and forgets them with the tab. A release published or deleted leaves
// the list. Pure functions over an injected storage: tested in Node.
//
// Like every browser script, it never names the platform.

export const STASH_KEY = "forge-releases";
/** Drafts kept per repository, and the characters of a draft's notes kept. */
export const STASH_DRAFTS = 30;
export const STASH_BODY = 20_000;

export type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

/** A release as the Worker answers it (act-releases.ts `releaseView`). */
export interface StashedRelease {
  id: string;
  tag: string;
  target: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  createdAt: string;
  publishedAt: string | null;
  assets: { id: string; name: string; label: string; size: number; contentType: string; digest: string | null; downloads: number; createdAt: string }[];
}

interface Entry {
  /** When GitHub showed them (Unix seconds). */
  at: number;
  drafts: StashedRelease[];
}

type Stash = Record<string, Entry>;

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

function read(storage: Storage): Stash {
  try {
    const v = JSON.parse(storage?.getItem(STASH_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Stash) : {};
  } catch {
    return {};
  }
}

function write(storage: Storage, stash: Stash): void {
  try {
    storage?.setItem(STASH_KEY, JSON.stringify(stash));
  } catch {
    // a full or blocked storage: the list simply shows no draft
  }
}

/** A release as the Worker answered it, checked; null otherwise. */
export function checkRelease(v: unknown): StashedRelease | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^\d{1,20}$/.test(r.id) || typeof r.tag !== "string" || !r.tag || r.tag.length > 255) return null;
  const str = (x: unknown, max = 500) => (typeof x === "string" ? x.slice(0, max) : "");
  const assets = (Array.isArray(r.assets) ? r.assets : []).slice(0, 100).flatMap((a) => {
    if (!a || typeof a !== "object") return [];
    const x = a as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.name !== "string") return [];
    return [{ id: x.id, name: x.name.slice(0, 255), label: str(x.label, 255), size: Number(x.size) || 0, contentType: str(x.contentType, 200), digest: typeof x.digest === "string" && /^[0-9a-f]{64}$/.test(x.digest) ? x.digest : null, downloads: Number(x.downloads) || 0, createdAt: str(x.createdAt, 40) }];
  });
  return {
    id: r.id,
    tag: r.tag,
    target: str(r.target, 255),
    name: str(r.name, 256),
    body: str(r.body, STASH_BODY),
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    immutable: r.immutable === true,
    createdAt: str(r.createdAt, 40),
    publishedAt: typeof r.publishedAt === "string" ? r.publishedAt.slice(0, 40) : null,
    assets,
  };
}

/** The repository ("owner/name", lower case) a page of the registry's viewer names. */
export function repoOfPage(page: unknown): string | null {
  if (typeof page !== "string") return null;
  const m = /^\/r\/([^/]+)\/([^/]+)\//.exec(page);
  const repo = m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : "";
  return REPO.test(repo) ? repo.toLowerCase() : null;
}

/** What a release action's answer tells the tab (the callback page calls it on a success). */
export function stashAnswer(kind: string, result: unknown, storage: Storage, now: number): void {
  if (!result || typeof result !== "object") return;
  const r = result as Record<string, unknown>;
  const stash = read(storage);
  if (kind === "release_drafts") {
    const repo = typeof r.repo === "string" && REPO.test(r.repo) ? r.repo.toLowerCase() : null;
    if (!repo || !Array.isArray(r.drafts)) return;
    const drafts = r.drafts.map(checkRelease).filter((x): x is StashedRelease => x !== null && x.draft).slice(0, STASH_DRAFTS);
    stash[repo] = { at: now, drafts };
    write(storage, stash);
    return;
  }
  const repo = repoOfPage(r.page);
  if (!repo) return;
  const entry = stash[repo] ?? { at: now, drafts: [] };
  if (kind === "release_create" || kind === "release_edit") {
    const release = checkRelease(r.release);
    if (!release) return;
    entry.drafts = entry.drafts.filter((d) => d.id !== release.id);
    if (release.draft) entry.drafts.unshift(release);
  } else if (kind === "release_delete" && typeof r.id === "string") {
    entry.drafts = entry.drafts.filter((d) => d.id !== r.id);
  } else return;
  entry.drafts = entry.drafts.slice(0, STASH_DRAFTS);
  stash[repo] = entry;
  write(storage, stash);
}

/** The drafts this tab was shown for a repository, and when; null when none was. */
export function stashedDrafts(repo: { owner: string; name: string }, storage: Storage): Entry | null {
  const e = read(storage)[`${repo.owner}/${repo.name}`.toLowerCase()];
  if (!e || !Array.isArray(e.drafts)) return null;
  return { at: Number(e.at) || 0, drafts: e.drafts.map(checkRelease).filter((x): x is StashedRelease => x !== null && x.draft) };
}
