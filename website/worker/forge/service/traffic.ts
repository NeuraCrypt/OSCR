// The privacy-respecting traffic read (night phase 12, E4; docs/STATISTICS.md, D12-3):
//
// GET /api/forge/traffic?id=<forge>:<repo_id> or ?path=<owner>/<name>
//   A repository's traffic, shown to its MAINTAINERS ONLY: page views and visits per day (14 days)
//   and per week (104 weeks), referring sites and popular pages, as AGGREGATES. There is no
//   unique-visitor count and nothing per person: the registry never asks Cloudflare for `uniques`,
//   and the parser drops anything it does not expect. A non-maintainer is refused (403), so this
//   data never leaks to the static layer, the search, a feed, a webhook or the public API.
//
// It is read from Cloudflare's GraphQL analytics with a READ-ONLY token the owner creates (Account
// Analytics: Read) and keeps in the keychain (org.oscr.cloudflare-analytics), set as a Cloudflare
// secret. The token is never read, printed or created by this code; it only authorises the request.
// Unset (or no account id / site tag): the view says traffic is not enabled. In development the
// endpoint is a local stand-in (CLOUDFLARE_ANALYTICS_URL); the tests inject the fetch
// (deps.analyticsFetch).

import { who } from "./who.ts";
import { json, problem } from "./http.ts";
import { hiddenOne } from "./hidden.ts";
import { first, repoByKey, repoByPath } from "./store.ts";
import { managersOf } from "./blocks.ts";
import { NOT_FOUND, parseTarget, serviceForge } from "./read.ts";
import type { ForgeRequest, ForgeServiceEnv, RepoRow } from "./types.ts";
import type { RankedBar, TrafficBucket, TrafficFacts } from "../../../src/lib/stats.ts";

const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const DAY = 86400;

/** Whether the owner has set up the read-only analytics token, the account and the site tag. */
export function trafficReady(env: ForgeServiceEnv): boolean {
  return !!(env.CLOUDFLARE_ANALYTICS_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ANALYTICS_SITE_TAG);
}

/** Where the GraphQL analytics endpoint is: Cloudflare's, or (development only) a local stand-in. */
function endpoint(env: ForgeServiceEnv): string {
  const local = (env.CLOUDFLARE_ANALYTICS_URL ?? "").trim();
  if (local && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/[^\s]*$/.test(local)) return local;
  return CF_GRAPHQL;
}

const EMPTY: Omit<TrafficFacts, "configured" | "note"> = { days: [], weeks: [], referrers: [], pages: [] };

/** A path prefix that selects a repository's own pages on the site (its /r/ pages). */
const repoPrefix = (owner: string, name: string): string => `/r/${owner}/${name}/`;

/** The GraphQL query: page views and visits by day and by week, plus top referrers and top paths, all
 *  filtered to this repository's pages. It never asks for `uniques` or any per-person field. */
function query(account: string, site: string, prefix: string, now: number): { query: string; variables: Record<string, unknown> } {
  const since = (n: number): string => new Date((now - n * DAY) * 1000).toISOString();
  return {
    query: `query Traffic($account: String!, $site: String!, $prefix: String!, $sinceDays: Time!, $sinceWeeks: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        days: rumPageloadEventsAdaptiveGroups(limit: 100, orderBy: [date_ASC], filter: { siteTag: $site, date_geq: $sinceDays, date_leq: $until, requestPath_like: $prefix }) { dimensions { date } count sum { visits } }
        weeks: rumPageloadEventsAdaptiveGroups(limit: 200, orderBy: [date_ASC], filter: { siteTag: $site, date_geq: $sinceWeeks, date_leq: $until, requestPath_like: $prefix }) { dimensions { date } count sum { visits } }
        referrers: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { siteTag: $site, date_geq: $sinceWeeks, date_leq: $until, requestPath_like: $prefix }) { dimensions { refererHost } count }
        pages: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { siteTag: $site, date_geq: $sinceWeeks, date_leq: $until, requestPath_like: $prefix }) { dimensions { requestPath } count }
      } }
    }`,
    variables: {
      account, site, prefix: `${prefix}%`,
      sinceDays: since(14), sinceWeeks: since(104 * 7), until: since(0),
    },
  };
}

/** Parse Cloudflare's answer into aggregate buckets, dropping anything unexpected. Weekly buckets are
 *  folded to the start of their ISO week so a day series and a week series both read cleanly. */
function parse(data: unknown): Omit<TrafficFacts, "configured" | "note"> {
  const acc = (data as { data?: { viewer?: { accounts?: unknown[] } } })?.data?.viewer?.accounts?.[0] as
    | { days?: unknown[]; weeks?: unknown[]; referrers?: unknown[]; pages?: unknown[] }
    | undefined;
  if (!acc) return { ...EMPTY };
  const dayOf = (s: string): number => Math.floor(Date.parse(s) / 1000 / DAY) * DAY;
  const buckets = (rows: unknown[] | undefined, weekly: boolean): TrafficBucket[] => {
    const out = new Map<number, TrafficBucket>();
    for (const row of rows ?? []) {
      const r = row as { dimensions?: { date?: string }; count?: number; sum?: { visits?: number } };
      if (!r.dimensions?.date) continue;
      let t = dayOf(r.dimensions.date);
      if (weekly) t = t - (((new Date(t * 1000).getUTCDay() + 6) % 7) * DAY); // Monday of that week
      const cur = out.get(t) ?? { t, views: 0, visits: 0 };
      cur.views += typeof r.count === "number" ? r.count : 0;
      cur.visits += typeof r.sum?.visits === "number" ? r.sum.visits : 0;
      out.set(t, cur);
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  };
  const ranked = (rows: unknown[] | undefined, dim: "refererHost" | "requestPath"): RankedBar[] => {
    const out: RankedBar[] = [];
    for (const row of rows ?? []) {
      const r = row as { dimensions?: Record<string, string>; count?: number };
      const label = r.dimensions?.[dim];
      if (label === undefined || label === null || typeof r.count !== "number") continue;
      out.push({ label: label === "" ? "(direct)" : label, value: r.count });
    }
    return out;
  };
  return {
    days: buckets(acc.days, false),
    weeks: buckets(acc.weeks, true),
    referrers: ranked(acc.referrers, "refererHost"),
    pages: ranked(acc.pages, "requestPath"),
  };
}

export async function handleTraffic(r: ForgeRequest): Promise<Response> {
  const s = await who(r, { post: false, touch: false });
  if (s instanceof Response) return s;
  const target = parseTarget(r.url, serviceForge(r));
  if (!target) return problem(400, "invalid", "Name one repository: ?id=<forge>:<id> or ?path=<owner>/<name>.");
  const row =
    "id" in target
      ? await first<RepoRow>(repoByKey(r.db, target.forge, target.id))
      : await first<RepoRow>(repoByPath(r.db, target.forge, target.owner, target.name));
  if (!row || row.state === "hidden") return problem(404, "not_found", NOT_FOUND);
  if (await hiddenOne(r.db, "repo", `${row.forge}:${row.repo_id}`)) {
    return problem(410, "moderated", "This repository is hidden from the registry's pages.");
  }
  // Maintainer-only: the traffic never leaves the people who manage the repository in the registry.
  if (!(await managersOf(s.db, row)).has(s.user.id)) {
    return problem(403, "forbidden", "A repository's traffic is shown only to the people who maintain it in the registry.");
  }
  if (!trafficReady(r.env)) {
    const answer: TrafficFacts = { configured: false, ...EMPTY, note: "Traffic is not enabled: the operator has not set up a read-only analytics token." };
    return json(answer);
  }
  const fetcher = r.deps.analyticsFetch ?? fetch;
  const q = query(r.env.CLOUDFLARE_ACCOUNT_ID!, r.env.CLOUDFLARE_ANALYTICS_SITE_TAG!, repoPrefix(row.owner_login, row.name), r.t);
  let parsed: Omit<TrafficFacts, "configured" | "note"> = { ...EMPTY };
  let note: string | undefined;
  try {
    const res = await fetcher(endpoint(r.env), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${r.env.CLOUDFLARE_ANALYTICS_TOKEN!}` },
      body: JSON.stringify(q),
    });
    if (res.ok) parsed = parse(await res.json());
    else note = "The analytics source could not be read just now.";
  } catch {
    note = "The analytics source could not be read just now.";
  }
  const answer: TrafficFacts = { configured: true, ...parsed, note };
  return json(answer);
}
