// Who may write, and how much: the forge service's gate (docs/FORGE.md "FORGE_OPEN" and "Caps").
//
// - FORGE_OPEN (D01-1). Until phase 16's content rules, the write routes (start, act) answer only
//   to the owner: the GitHub account whose numeric id is FORGE_OWNER_GITHUB_ID. `mayWrite` is asked
//   at start (the GitHub identity linked to the signed-in account) and again at act (the account
//   GitHub says authorized the action). FORGE_OPEN="true" opens them to every signed-in account -
//   night phase 16: only once the content rules are in force (`rulesReady`: Turnstile's secret set).
//   Webhooks and the signed-in reads are not gated.
// - The per-account caps (100 authorized actions, 10 repositories created, 20 linked in 24 hours):
//   counted from the account's action rows, two key ranges of `actions` ((yesterday, user) and
//   (today, user)): no write, no counter row. Rows read: the account's actions of the last 24 hours.
// - The global cap (5,000 rows a UTC day, every account and every webhook together): the `rows` of
//   today's action and delivery rows, one key range of each (the key starts with the day). Rows
//   read: today's action and delivery rows, at most FORGE_ROWS_PER_DAY each (every row counts at
//   least its own row, so reading more cannot change the answer). Asked once per authorized
//   action, at act, just before anything is written (D01-12); a webhook writes at most 2 rows and
//   is not asked, its rows count in the total the next action sees.

import { CAP_OF, CAP_WORDS, FORGE_ROWS_PER_DAY, KINDS_OF, OWN_CAPS, PER_ACCOUNT_DAY, untilNextDay, utcDay, type Cap } from "./caps.ts";
import { turnstileReady } from "./turnstile.ts";
import { ForgeProblem, type D1Database, type ForgeServiceEnv, type RowKind } from "./types.ts";

export const CLOSED_MESSAGE = "The GitHub side opens to the public with its content rules; until then, only the owner of the registry can act here.";

/** Night phase 16: whether the content rules are all in force, so that FORGE_OPEN may open the GitHub
 *  side to everyone. The rules, caps, reports, blocks and limits are code; the one thing the owner must
 *  set is the human check, Turnstile's secret (turnstile.ts). Without it, FORGE_OPEN="true" opens
 *  nothing: the write routes stay the owner's, and a report cannot be sent. */
export const rulesReady = (env: ForgeServiceEnv): boolean => turnstileReady(env);

/** Whether the GitHub side is open to everyone: FORGE_OPEN="true" AND the content rules in force. */
export const forgeOpen = (env: ForgeServiceEnv): boolean => (env.FORGE_OPEN ?? "").trim() === "true" && rulesReady(env);

/** Whether this GitHub account may use the write routes. Closed to everyone when neither the switch
 *  (FORGE_OPEN="true", with the content rules in force: forgeOpen) nor FORGE_OWNER_GITHUB_ID is set. */
export function mayWrite(env: ForgeServiceEnv, githubId: string | number | null | undefined): boolean {
  if (forgeOpen(env)) return true;
  const owner = (env.FORGE_OWNER_GITHUB_ID ?? "").trim();
  if (!/^\d{1,20}$/.test(owner)) return false;
  const id = githubId === null || githubId === undefined ? "" : String(githubId).trim();
  return id === owner;
}

/** The answer to an account the gate keeps out: 403 forge_closed. */
export function closed(): ForgeProblem {
  return new ForgeProblem(403, "forge_closed", CLOSED_MESSAGE);
}

export interface DailyCaps {
  /** What the account did in the last 24 hours. */
  used: Record<Cap, number>;
  limits: typeof PER_ACCOUNT_DAY;
  /** The first cap this kind of action would go over, or null. */
  exceeded: { cap: Cap; limit: number; used: number } | null;
}

/** The account's use of its caps in the 24 hours before `t`, and whether one more action of `kind`
 *  goes over one. Reads only. */
export async function dailyCaps(db: D1Database, userId: string, kind: RowKind, t: number): Promise<DailyCaps> {
  const today = utcDay(t);
  const rows = (
    await db
      .prepare("SELECT kind, count(*) AS n FROM actions WHERE day IN (?, ?) AND user_id = ? AND at > ? GROUP BY kind")
      .bind(today - 1, today, userId, Math.floor(t) - 86_400)
      .all<{ kind: string; n: number }>()
  ).results;
  const by = new Map(rows.map((r) => [r.kind, Number(r.n)]));
  const count = (kinds: readonly string[]) => kinds.reduce((n, k) => n + (by.get(k) ?? 0), 0);
  const standalone = new Set([...OWN_CAPS].flatMap((c) => KINDS_OF[c as Exclude<Cap, "actions">]));
  const used = {
    actions: [...by].reduce((a, [k, n]) => a + (standalone.has(k as RowKind) ? 0 : n), 0),
    ...Object.fromEntries(Object.entries(KINDS_OF).map(([cap, kinds]) => [cap, count(kinds)])),
  } as Record<Cap, number>;
  const specific = CAP_OF[kind];
  // Phase 08: a social write counts toward its own cap only.
  const caps: Cap[] = specific && OWN_CAPS.has(specific) ? [] : ["actions"];
  if (specific) caps.push(specific);
  let exceeded: DailyCaps["exceeded"] = null;
  for (const cap of caps) {
    if (used[cap] + 1 > PER_ACCOUNT_DAY[cap]) {
      exceeded = { cap, limit: PER_ACCOUNT_DAY[cap], used: used[cap] };
      break;
    }
  }
  return { used, limits: PER_ACCOUNT_DAY, exceeded };
}

/** The answer to an account over a cap: 429 too_many, the cap in words. */
export function overCap(exceeded: NonNullable<DailyCaps["exceeded"]>): ForgeProblem {
  return new ForgeProblem(
    429,
    "too_many",
    `You have reached ${CAP_WORDS[exceeded.cap](exceeded.limit)} in the last 24 hours, the most one account may: please come back tomorrow.`,
    { cap: exceeded.cap, limit: exceeded.limit },
  );
}

/** The rows the forge service wrote today (UTC), every account and every webhook together; phase 10
 *  adds the outgoing webhooks' deliveries (1 row each, hook_deliveries: one key range, like the
 *  others). */
export async function globalRowsToday(db: D1Database, t: number): Promise<number> {
  const day = utcDay(t);
  const row = (
    await db
      .prepare(
        "SELECT (SELECT coalesce(sum(rows), 0) FROM (SELECT rows FROM actions WHERE day = ? LIMIT ?)) + " +
          "(SELECT coalesce(sum(rows), 0) FROM (SELECT rows FROM deliveries WHERE day = ? LIMIT ?)) + " +
          "(SELECT count(*) FROM (SELECT 1 FROM hook_deliveries WHERE day = ? LIMIT ?)) AS n",
      )
      .bind(day, FORGE_ROWS_PER_DAY, day, FORGE_ROWS_PER_DAY, day, FORGE_ROWS_PER_DAY)
      .all<{ n: number }>()
  ).results[0];
  return Number(row?.n ?? 0);
}

/** A problem when writing `adding` more rows today would go over FORGE_ROWS_PER_DAY, else null:
 *  503 quota, with the seconds until the next UTC day. */
export async function globalCap(db: D1Database, t: number, adding: number): Promise<ForgeProblem | null> {
  const today = await globalRowsToday(db, t);
  if (today + Math.max(0, adding) <= FORGE_ROWS_PER_DAY) return null;
  return new ForgeProblem(503, "quota", "The GitHub side has used its share of today's database writes. Please try again tomorrow.", {
    retryAfter: untilNextDay(t),
  });
}
