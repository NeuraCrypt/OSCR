// Data rights (2026-09-29; the page /data-rights/): what a signed-in person asks about the data the
// registry holds on them, under the EU's General Data Protection Regulation. The Worker shows what
// the site's database holds about the account (it is the account's own data) and records a request
// (a row of `rights` and its job: migrations/d1-community/0004_data_rights.sql); the Mac answers into
// the row (oscr/rights.py, `oscr jobs poll`), by itself when it can prove who asks, else the operator,
// within the legal month. One entry point, `handleRights`, which the Worker's entry calls:
//
//   GET  /api/rights                         what the site's database holds about the account, and its requests
//   POST /api/rights  {kind, details, confirm}   a request: access, erasure, objection, rectification, account
//
// The POST needs the session, its CSRF token and the site's own Origin (account/guard.ts); every answer
// is JSON, `Cache-Control: no-store`. No email address is ever asked for or kept: the person's words lose
// theirs (contributions/text.ts), and the page refuses one first. Costs: docs/CONTRIBUTIONS.md.

import { orcidProof } from "../contributions/index.ts";
import { cleanText } from "../contributions/text.ts";
import { measured, now, readJson, ready, signedIn, staleCookies } from "../account/guard.ts";
import { json, problem } from "../account/http.ts";
import { LABELS } from "../account/providers.ts";
import { csrfToken } from "../account/session.ts";
import { reads, type Identity, type Role } from "../account/store.ts";
import type { AccountEnv, Context, D1Database, D1PreparedStatement } from "../account/types.ts";
import { checkRights, dueAt, expectedWords, RIGHTS_PER_DAY, type Asker } from "../../src/lib/rights.ts";

/** Rows of the account's list of requests. */
const LIST = 20;
const DAY = 86_400;
const COLUMNS = "id, kind, details, orcid, proof, status, answer, message, created_at, due_at, decided_at";

export interface RightsRow {
  id: number;
  kind: string;
  details: string;
  orcid: string;
  proof: "" | "orcid" | "orcid-sandbox";
  status: "open" | "waiting" | "done" | "refused";
  answer: string;
  message: string;
  created_at: number;
  due_at: number;
  decided_at: number | null;
}

const iso = (t: number | null | undefined): string | null => (t ? new Date(t * 1000).toISOString() : null);

function parsed(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A request as the page reads it: while it is open or waits, what will happen and by when. */
export function rightsJson(r: RightsRow) {
  const who: Asker = { orcid: r.orcid ?? "", proof: r.proof ?? "" };
  const pending = r.status === "open" || r.status === "waiting";
  return {
    id: r.id,
    kind: r.kind,
    details: r.details,
    orcid: r.orcid,
    proof: r.proof,
    status: r.status,
    answer: parsed(r.answer || "{}"),
    message: r.message,
    created_at: iso(r.created_at),
    due_at: iso(r.due_at),
    decided_at: iso(r.decided_at),
    expected: pending ? { words: expectedWords(r.kind, who, r.created_at), due: iso(r.due_at) } : null,
  };
}

/** The statements of the account's data, sent in one batch: each reads the account's rows by an index
 *  or a key. */
const held = {
  sessions: (db: D1Database, userId: string): D1PreparedStatement =>
    db
      .prepare("SELECT user_agent_hint, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20")
      .bind(userId),
  counts: (db: D1Database, userId: string): D1PreparedStatement =>
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM claims WHERE user_id = ?1) AS claims, (SELECT COUNT(*) FROM submissions WHERE user_id = ?1) AS submissions, " +
          "(SELECT COUNT(*) FROM edits WHERE user_id = ?1) AS edits, (SELECT COUNT(*) FROM validations WHERE user_id = ?1) AS validations, " +
          "(SELECT COUNT(*) FROM reports WHERE user_id = ?1) AS reports",
      )
      .bind(userId),
  rights: (db: D1Database, userId: string): D1PreparedStatement =>
    db.prepare(`SELECT ${COLUMNS} FROM rights WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${LIST}`).bind(userId),
};

/** The ORCID iD of the account's ORCID identity (the one it signed in with), and which ORCID proved it. */
function askerOf(env: AccountEnv, identities: Identity[]): Asker {
  const orcid = identities.find((i) => i.provider === "orcid")?.subject ?? "";
  return { orcid, proof: orcid ? orcidProof(env) : "" };
}

/** The data rights' answer to `request`, or null when its path is not theirs. */
export async function handleRights(request: Request, env: AccountEnv | object, _ctx?: Context): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (path !== "/api/rights") return null;
  return measured(env as AccountEnv, async (e) => {
    try {
      if (request.method === "GET" || request.method === "HEAD") return await mine(request, e);
      if (request.method === "POST") return await ask(request, e);
      return problem(405, "method_not_allowed", "Use GET or POST.");
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      console.error(`rights: ${message.slice(0, 300)}`);
      if (/D1/.test(message) && /exceeded|limit/i.test(message)) {
        return problem(503, "quota", "The registry has used its daily quota. Please try again tomorrow.");
      }
      return problem(503, "unavailable", "The registry is unavailable at the moment. Please try again later.");
    }
  });
}

async function mine(request: Request, env: AccountEnv): Promise<Response> {
  if (!ready(env)) return json({ signed_in: false, available: false });
  const t = now();
  const s = await signedIn(request, env, t, { post: false, touch: true });
  if (s instanceof Response) {
    if (s.status !== 401) return s;
    return json({ signed_in: false, available: true }, 200, staleCookies(request));
  }
  const { db, user } = s;
  const [ids, roles, sessions, counts, requests] = await db.batch([
    reads.identities(db, user.id),
    reads.roles(db, user.id),
    held.sessions(db, user.id),
    held.counts(db, user.id),
    held.rights(db, user.id),
  ]);
  const identities = (ids?.results ?? []) as unknown as Identity[];
  const asker = askerOf(env, identities);
  const rows = (requests?.results ?? []) as unknown as RightsRow[];
  return json(
    {
      signed_in: true,
      available: true,
      user: { display_name: user.display_name, created_at: iso(user.created_at) },
      handles: { orcid: user.orcid, github: user.github_login },
      orcid: asker,
      held: {
        identities: identities.map((i) => ({
          provider: i.provider,
          label: LABELS[i.provider],
          // ORCID's is the iD; GitHub's, the account's number (the login is in `handles`); Google's, an
          // opaque number that names nothing else.
          subject: i.subject,
          linked_at: iso(i.linked_at),
        })),
        sessions: ((sessions?.results ?? []) as { user_agent_hint: string; created_at: number; last_seen_at: number; expires_at: number }[]).map(
          (x) => ({ browser: x.user_agent_hint, created_at: iso(x.created_at), last_seen_at: iso(x.last_seen_at), expires_at: iso(x.expires_at) }),
        ),
        roles: ((roles?.results ?? []) as unknown as Role[]).map((r) => ({
          role: r.role,
          scope_kind: r.scope_kind,
          scope_id: r.scope_id,
          granted_by: r.granted_by === "system" || r.granted_by === "rules" || r.granted_by === "owner" ? r.granted_by : "someone",
          granted_at: iso(r.granted_at),
        })),
        requests: { ...((counts?.results ?? [])[0] as Record<string, number> | undefined), rights: rows.length },
      },
      requests: rows.map(rightsJson),
      limits: { rights: RIGHTS_PER_DAY },
      csrf: await csrfToken(s.key, s.session.idHash),
    },
    200,
    s.cookies,
  );
}

/** A request: 3 rows written (the row, its index entry, the job). One open request per right, and
 *  RIGHTS_PER_DAY a day, counted from the account's rows through the index. */
async function ask(request: Request, env: AccountEnv): Promise<Response> {
  const t = now();
  const s = await signedIn(request, env, t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const body = await readJson(request);
  if (!body) return problem(400, "bad_request", "The form could not be read: reload the page, then try again.", s.cookies);
  const checked = checkRights(body);
  if (!checked.ok) return json({ error: { code: checked.code, message: checked.message, field: checked.field } }, checked.status, s.cookies);
  const { db, user } = s;
  const { kind } = checked.request;
  const [open, recent, ids] = await db.batch([
    db
      .prepare(`SELECT ${COLUMNS} FROM rights WHERE user_id = ? AND kind = ? AND status IN ('open', 'waiting') ORDER BY id DESC LIMIT 1`)
      .bind(user.id, kind),
    db.prepare("SELECT COUNT(*) AS n FROM rights WHERE user_id = ? AND created_at > ?").bind(user.id, t - DAY),
    reads.identities(db, user.id),
  ]);
  const before = ((open?.results ?? [])[0] as RightsRow | undefined) ?? null;
  if (before) {
    return json(
      { error: { code: "already_open", message: "You already asked for this, and it is not answered yet: its answer comes below." }, request: rightsJson(before) },
      409,
      s.cookies,
    );
  }
  const n = Number(((recent?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0);
  if (n >= RIGHTS_PER_DAY) {
    return problem(429, "too_many", `You have made ${n} requests in the last 24 hours, the most one account may: please come back tomorrow.`, s.cookies);
  }
  // Who asks is the account's own ORCID identity, never what the form says: the Mac answers about it only.
  const asker = askerOf(env, (ids?.results ?? []) as unknown as Identity[]);
  const details = cleanText(checked.request.details, 1000);
  const [inserted] = await db.batch([
    db
      .prepare("INSERT INTO rights (user_id, kind, details, orcid, proof, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(user.id, kind, details, asker.orcid, asker.proof, t, dueAt(t)),
    db.prepare("INSERT INTO jobs (kind, ref, user_id, created_at) VALUES ('rights', last_insert_rowid(), ?, ?)").bind(user.id, t),
  ]);
  const id = Number(inserted?.meta?.last_row_id ?? 0);
  const row = await db.prepare(`SELECT ${COLUMNS} FROM rights WHERE id = ? AND user_id = ?`).bind(id, user.id).first<RightsRow>();
  return json({ status: "open", request: row ? rightsJson(row) : { id } }, 202, s.cookies);
}
