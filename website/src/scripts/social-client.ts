// The social pages' requests (night phase 08, E5): the static shards (signed out, and the counts for
// everyone: 0 Worker requests), the Worker's social routes (signed in: 1 request a read; a write with
// the session's CSRF token). Like every browser script, it never names the platform.

import { authorsUrl, socialShard, socialUrl } from "../lib/social.ts";
import { signedInHint, whoIsHere } from "./pull-common.ts";

export type Json = Record<string, unknown>;

const shards = new Map<string, Promise<Record<string, unknown>>>();

/** A shard of a static family, read once per page (none yet: an empty object). */
function shardOf(url: string): Promise<Record<string, unknown>> {
  let p = shards.get(url);
  if (!p) {
    p = fetch(url, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : {}))
      .then((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}))
      .catch(() => ({}));
    shards.set(url, p);
  }
  return p;
}

/** A key's entry in the social layer as of last night (oscr/social.py), or null. */
export async function socialEntry(key: string): Promise<Json | null> {
  const entry = (await shardOf(socialUrl(await socialShard(key))))[key];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Json;
  // An ORCID iD whose person has a GitHub login points to their entry.
  if (typeof e.see === "string" && e.see.startsWith("person:")) {
    const seen = (await shardOf(socialUrl(await socialShard(e.see))))[e.see];
    return seen && typeof seen === "object" ? (seen as Json) : null;
  }
  return e;
}

export interface AuthorPaper {
  doi: string;
  title: string;
  date: string;
  slug: string;
}

/** The catalogue's papers of an author, by ORCID iD (built with the site). */
export async function authorPapers(orcid: string): Promise<AuthorPaper[]> {
  const list = (await shardOf(authorsUrl(await socialShard(orcid))))[orcid];
  return Array.isArray(list) ? (list as AuthorPaper[]).filter((p) => p && typeof p.doi === "string") : [];
}

export const signedIn = (): boolean => signedInHint();

/** A signed-in read of the Worker: its body, or a problem in words. */
export async function getJson(path: string): Promise<{ ok: boolean; status: number; body: Json }> {
  try {
    const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Json;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: { message: "The registry could not be reached: check the connection, then try again." } } };
  }
}

/** A social write: the session's CSRF token, JSON; the answer, or a problem in words. */
export async function postJson(path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: Json }> {
  const who = await whoIsHere();
  if ("message" in who) return { ok: false, status: 401, body: { error: { message: who.message } } };
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": who.csrf },
      body: JSON.stringify(payload),
    });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Json;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: { message: "The registry could not be reached: check the connection, then try again." } } };
  }
}

/** A problem's words, from an answer. */
export const problemOf = (body: Json): string => {
  const e = body.error as { message?: unknown } | undefined;
  return typeof e?.message === "string" ? e.message : "The registry could not do it: please try again.";
};
