// Blocks (night phase 16, E2): who a person blocked, read by the key's prefix (their own few rows).
// The routes are blocks.ts; the migration is 0010_moderation.sql. A block is silent: the blocked
// person is never told, and nothing they can read says so.

import { all } from "./store.ts";
import type { D1Database } from "./types.ts";

export interface BlockRow {
  user_id: string;
  blocked: string;
  blocked_github: string;
  label: string;
  note: string;
  at: number;
}

/** The people this account blocked: their account ids and GitHub numeric ids (one key range). */
export async function blockedBy(db: D1Database, userId: string): Promise<{ users: Set<string>; github: Set<string> }> {
  const rows = await all<Pick<BlockRow, "blocked" | "blocked_github">>(db.prepare("SELECT blocked, blocked_github FROM blocks WHERE user_id = ? LIMIT 1000").bind(userId));
  return { users: new Set(rows.map((r) => r.blocked)), github: new Set(rows.map((r) => r.blocked_github).filter(Boolean)) };
}
