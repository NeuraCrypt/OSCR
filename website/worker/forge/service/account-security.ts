// Account security (night phase 09, E4; docs/ACCOUNTS.md): a person's sessions, their sign-in
// identities, their passkeys, their personal security log, and sudo mode. Sessions and identities
// live in oscr_community (account/session.ts, account/store.ts); the passkeys, the security log and
// the sudo marker live in oscr_forge (webauthn.ts, 0013_organizations.sql).
//
//   GET  /api/forge/account/security     signed in  sessions, identities, passkeys, the security log,
//                                                    sudo state; ?format=csv exports the security log
//   POST /api/forge/account/sessions     signed in  {op: revoke, idHash} | {op: revoke_others}
//   POST /api/forge/account/identities   signed in  {op: unlink, provider} (never the last identity)
//
// These are the person's own account: not gated by FORGE_OPEN (you may always revoke your own session
// or unlink an identity, even when the GitHub side is closed to the public), only by the account's
// `security` cap and the day's rows. A session revoked is a true delete of its row: its cookie is then
// worth nothing. No email address is read or stored.

import { signedIn } from "../../account/guard.ts";
import { identitiesOf } from "../../account/store.ts";
import { agentHint } from "../../account/session.ts";
import { dailyCaps, globalCap, overCap } from "./gate.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { readJsonBody } from "./automation.ts";
import { securityLogOf, securityLogWrite } from "./org-core.ts";
import { all, newNonce, rowsOf, statements } from "./store.ts";
import { ForgeProblem, type D1Database, type ForgeRequest, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const ORG_BODY_BYTES = 8 * 1024;

interface SessionRow {
  id_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent_hint: string;
}

interface CredRow {
  cred_id: string;
  alg: number;
  sign_count: number;
  label: string;
  transports: string;
  backed_up: number;
  created_at: number;
  last_used: number | null;
}

interface LogRow {
  at: number;
  event: string;
  detail: string;
}

/** The person's sessions, never an id (only a short fingerprint of the hash so the page can mark one
 *  to revoke), the current one flagged. */
async function sessionsView(community: D1Database, userId: string, currentHash: string) {
  const rows = await all<SessionRow>(community.prepare("SELECT id_hash, created_at, expires_at, last_seen_at, user_agent_hint FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 100").bind(userId));
  return rows.map((row) => ({ ref: row.id_hash.slice(0, 16), agent: row.user_agent_hint || "a browser", createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, current: row.id_hash === currentHash }));
}

export async function handleAccountSecurity(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: false, touch: false });
  if (s instanceof Response) return s;
  const currentHash = s.session.idHash;

  if (r.url.searchParams.get("format") === "csv") {
    const log = await all<LogRow>(securityLogOf(r.db, s.user.id, 500));
    const lines = ["at,event,detail"];
    for (const row of log) lines.push([row.at, row.event, /[",\n]/.test(row.detail) ? `"${row.detail.replace(/"/g, '""')}"` : row.detail].join(","));
    const res = new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="security-log.csv"' } });
    for (const c of s.cookies) res.headers.append("Set-Cookie", c);
    return res;
  }

  const identities = (await identitiesOf(s.db, s.user.id)).map((i) => ({ provider: i.provider, linkedAt: i.linked_at }));
  const passkeys = (await all<CredRow>(r.db.prepare("SELECT cred_id, alg, sign_count, label, transports, backed_up, created_at, last_used FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").bind(s.user.id))).map((c) => ({
    ref: c.cred_id.slice(0, 16),
    label: c.label || "a passkey",
    alg: c.alg === -7 ? "ES256" : "RS256",
    backedUp: c.backed_up === 1,
    createdAt: c.created_at,
    lastUsed: c.last_used,
  }));
  const log = (await all<LogRow>(securityLogOf(r.db, s.user.id, 100))).map((row) => ({ at: row.at, event: row.event, detail: safe(row.detail) }));
  const sudo = await r.db.prepare("SELECT until FROM sudo_sessions WHERE session_hash = ?").bind(currentHash).first<{ until: number }>();
  return json(
    {
      sessions: await sessionsView(s.db, s.user.id, currentHash),
      identities,
      passkeys,
      securityLog: log,
      sudo: { active: !!sudo && sudo.until > r.t, until: sudo?.until ?? 0 },
      agentHere: agentHint(r.request.headers.get("User-Agent")),
    },
    200,
    s.cookies,
  );
}

/** Log a security event and its action row in oscr_forge (the caps and the day's rows already
 *  checked). The account-changing delete itself was done first, in oscr_community. */
async function logSecurity(r: ForgeRequest, userId: string, github: string, kind: "session" | "identity", event: string, detail: Record<string, unknown>): Promise<number> {
  const nonce = newNonce();
  const writes: Write[] = [securityLogWrite(r.db, { userId, at: r.t, nonce, event, detail })];
  const action = {
    rows: 1,
    stmt: r.db
      .prepare("INSERT INTO actions (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows, subject) VALUES (?, ?, ?, ?, ?, '', '', ?, 'done', ?, ?)")
      .bind(Math.floor(r.t / 86_400), userId, Math.floor(r.t), newNonce(), kind, github, 1 + rowsOf(writes), event.slice(0, 342)),
  };
  await r.db.batch([...statements(writes), action.stmt]);
  return 1 + rowsOf(writes);
}

async function gate(r: ForgeRequest, userId: string, rows: number): Promise<ForgeProblem | null> {
  const caps = await dailyCaps(r.db, userId, "session", r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  return globalCap(r.db, r.t, rows);
}

export async function handleSessionsWrite(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = (await readJsonBody(r, ORG_BODY_BYTES)) as Record<string, unknown> | ForgeProblem;
  if (body instanceof ForgeProblem) return say(body);
  const op = typeof body.op === "string" ? body.op : "";
  const blocked = await gate(r, s.user.id, 2);
  if (blocked) return say(blocked);
  const github = (await linkedGithub(s.db, s.user.id)) ?? "";

  if (op === "revoke") {
    const ref = typeof body.idHash === "string" ? body.idHash : "";
    if (!/^[0-9a-f]{8,64}$/.test(ref)) return say(bad("Which session? Give its ref from the list."));
    // The ref is the first 16 hex of the session's hash; match a session of this user by that prefix.
    const match = await s.db.prepare("SELECT id_hash FROM sessions WHERE user_id = ? AND substr(id_hash, 1, ?) = ? LIMIT 1").bind(s.user.id, ref.length, ref).first<{ id_hash: string }>();
    if (!match) return say(new ForgeProblem(404, "no_session", "No session of yours with that ref: it may have ended already."));
    await s.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash = ?").bind(s.user.id, match.id_hash).run();
    const written = await logSecurity(r, s.user.id, github, "session", "session.revoke", { current: match.id_hash === s.session.idHash });
    return json({ ok: true, written, revoked: ref, wasCurrent: match.id_hash === s.session.idHash }, 200, s.cookies);
  }
  if (op === "revoke_others") {
    const res = await s.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(s.user.id, s.session.idHash).run();
    const written = await logSecurity(r, s.user.id, github, "session", "session.revoke_others", { count: res.meta?.changes ?? 0 });
    return json({ ok: true, written, revoked: res.meta?.changes ?? 0 }, 200, s.cookies);
  }
  return say(bad("Say what to do: revoke or revoke_others."));
}

export async function handleIdentitiesWrite(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = (await readJsonBody(r, ORG_BODY_BYTES)) as Record<string, unknown> | ForgeProblem;
  if (body instanceof ForgeProblem) return say(body);
  if (body.op !== "unlink") return say(bad("Say what to do: unlink."));
  const provider = String(body.provider);
  if (!["orcid", "github", "google"].includes(provider)) return say(bad("A provider is orcid, github or google."));
  const mine = await identitiesOf(s.db, s.user.id);
  const theOne = mine.find((i) => i.provider === provider);
  if (!theOne) return say(new ForgeProblem(404, "not_linked", "Your account has no identity of that provider."));
  if (mine.length <= 1) return say(new ForgeProblem(409, "last_identity", "This is your only way to sign in: link another before you unlink this one."));
  const blocked = await gate(r, s.user.id, 2);
  if (blocked) return say(blocked);
  // Remove the identity and, when it carried the account's handle, that handle (a later sign-in of
  // another linked provider refreshes it).
  const stmts = [s.db.prepare("DELETE FROM identities WHERE provider = ? AND subject = ? AND user_id = ?").bind(provider, theOne.subject, s.user.id)];
  if (provider === "orcid") stmts.push(s.db.prepare("UPDATE users SET orcid = NULL WHERE id = ?").bind(s.user.id));
  if (provider === "github") stmts.push(s.db.prepare("UPDATE users SET github_login = NULL WHERE id = ?").bind(s.user.id));
  await s.db.batch(stmts);
  const github = provider === "github" ? "" : (await linkedGithub(s.db, s.user.id)) ?? "";
  const written = await logSecurity(r, s.user.id, github, "identity", "identity.unlink", { provider });
  return json({ ok: true, written, unlinked: provider }, 200, s.cookies);
}

function safe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
