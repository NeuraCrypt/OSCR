// Outgoing webhooks (night phase 10, E3; docs/AUTOMATION.md "Webhooks"): what a hook is, the address
// it may post to, what it sends and how it is signed, its rows in D1 oscr_forge `hooks` and
// `hook_deliveries` (migrations/d1-forge/0009_automation.sql). The routes and the deliveries: hooks.ts.
//
// - A hook is registered by a signed-in person on a repository the registry knows ("repo:<forge>:<id>")
//   or on a paper ("paper:doi:10.…"), for some of its events (events.ts EVENT_KINDS, the same ones the
//   in-site inbox shows: they are public in the registry) or all of them.
// - Its address: https, no user part, no fragment; never this machine, a private network, a
//   link-local, carrier-grade NAT, multicast or reserved address, nor the registry itself; a name must
//   have a dot and not end in a local suffix (.local, .internal, .localhost…); an address by its IPv6
//   number is not taken; the port is 443 or above 1023. Checked when it is registered and again before
//   every delivery. The Worker never resolves names itself: the delivery leaves from Cloudflare's
//   network, never from the owner's, and it never follows a redirection (a 3xx is a failure).
//   Development only: HOOKS_ALLOW_LOCAL=1 lets http on localhost and 127.0.0.1 through (the local
//   end-to-end run's receiver); it is never in wrangler.toml.
// - Its secret signs every delivery (HMAC-SHA-256 of the raw body, `X-Hub-Signature-256:
//   sha256=<hex>`, GitHub's own scheme, so the receivers' usual code verifies it). The secret is never
//   stored: it is derived from the server key (SESSION_KEY, purpose "hook") and the hook's id and
//   `salt`; it is answered once, when the hook is made or its secret rotated (a new salt).
// - What a delivery holds: the event as the inbox shows it (its kind, its title — masked —, the
//   address of its page in the registry, its time, the actor's GitHub id and login), never a text,
//   never an address of a person, never an account's id.

import { hmac, randomToken } from "../../account/crypto.ts";
import { maskEmails } from "../mask.ts";
import { signBody } from "../hmac.ts";
import { utf8 } from "../objects.ts";
import { utcDay } from "./caps.ts";
import { EVENT_KINDS, type EventKind, type EventRow } from "./events.ts";
import { readSubject } from "./social-core.ts";
import { ForgeProblem, type D1Database, type D1PreparedStatement, type Write } from "./types.ts";

/** Hooks an account may hold, and hooks on one subject (a delivery's fan-out). */
export const HOOKS_PER_ACCOUNT = 10;
export const HOOKS_PER_SUBJECT = 10;
/** One attempt's wait for an answer, the waits between attempts, and the attempts at most. */
export const HOOK_TIMEOUT_MS = 5_000;
export const RETRY_WAITS_MS = [1_000, 4_000] as const;
/** The sends one request may make for its events' hooks (the free plan's 50 subrequests a request,
 *  shared with GitHub's calls of the same request). */
export const HOOK_SENDS_PER_REQUEST = 20;
/** Failures in a row after which a hook pauses itself. */
export const PAUSE_AFTER_FAILURES = 10;
/** How far back a hook's recent deliveries are read (and redelivered). */
export const DELIVERY_DAYS = 7;
export const HOOK_BODY_BYTES = 4 * 1024;

/** The events a paper's hooks can ask for; a repository's are the others. */
export const PAPER_EVENTS: readonly EventKind[] = ["research_opened", "research_comment", "research_closed", "research_reopened", "code_linked", "release_tied"];
export const REPO_EVENTS: readonly EventKind[] = EVENT_KINDS.filter((k) => !PAPER_EVENTS.includes(k));

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

// ─── the address ─────────────────────────────────────────────────────────────

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".private", ".localdomain", ".test", ".invalid", ".onion", ".arpa"];
/** Public names that resolve to any address one writes into them: a way around the name rules. */
const REBINDERS = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "vcap.me", "traefik.me", "local.gd"];

/** Whether an IPv4 address (dotted quad) is private, loopback, link-local, shared, reserved or
 *  multicast: anything but a public unicast address. */
export function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** A hook's address as stored, or the problem that refuses it. `siteHost`: the registry's own host,
 *  refused (a hook never posts to the Worker itself). */
export function hookUrl(value: unknown, o: { allowLocal?: boolean; siteHost?: string } = {}): string | ForgeProblem {
  if (typeof value !== "string") return bad("A webhook needs the address it posts to.");
  const v = value.trim();
  if (v.length < 10 || v.length > 500) return bad("A webhook's address is 10 to 500 characters.");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return bad("This is not an address.");
  }
  if (u.username || u.password || v.includes("@")) return bad("A webhook's address holds no user name, password or at sign.");
  if (u.hash) return bad("A webhook's address has no fragment (#…).");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  const local = !!o.allowLocal && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
  if (local) return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : bad("A webhook posts over https.");
  if (u.protocol !== "https:") return bad("A webhook posts over https only: its deliveries are signed, and they travel encrypted.");
  if (u.port && !(u.port === "443" || Number(u.port) >= 1024)) return bad("A webhook's port is 443, or above 1023.");
  if (host.startsWith("[")) return bad("An address by its IPv6 number is not taken: give its name.");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (privateIpv4(host)) return bad("A webhook never posts to this machine, a private network or a reserved address.");
  } else {
    if (!host.includes(".") || host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
      return bad("A webhook never posts to this machine or a local network: give a public name.");
    }
    if (REBINDERS.some((r) => host === r || host.endsWith(`.${r}`))) return bad("This name can point anywhere, a private network included: give your receiver's own name.");
  }
  if (o.siteHost && host === o.siteHost.toLowerCase()) return bad("A webhook never posts to the registry itself.");
  return u.toString();
}

// ─── what a hook asks for ────────────────────────────────────────────────────

export interface HookRequest {
  subject: string;
  url: string;
  /** "*" or the events, sorted. */
  events: "*" | EventKind[];
}

/** The events a subject's hooks may ask for. */
export const eventsFor = (subject: string): readonly EventKind[] => (subject.startsWith("paper:") ? PAPER_EVENTS : REPO_EVENTS);

/** The events of a request, checked against its subject; "*" for all. */
export function readEvents(value: unknown, subject: string): "*" | EventKind[] | ForgeProblem {
  if (value === undefined || value === "*" || (Array.isArray(value) && value.length === 1 && value[0] === "*")) return "*";
  if (!Array.isArray(value) || !value.length) return bad("Choose the events it receives, or all of them.");
  const allowed = eventsFor(subject);
  const out: EventKind[] = [];
  for (const e of value) {
    if (typeof e !== "string" || !(allowed as readonly string[]).includes(e)) {
      return bad(`“${String(e).slice(0, 40)}” is not an event of a ${subject.startsWith("paper:") ? "paper" : "repository"}.`);
    }
    if (!out.includes(e as EventKind)) out.push(e as EventKind);
  }
  return out.sort((a, b) => EVENT_KINDS.indexOf(a) - EVENT_KINDS.indexOf(b));
}

/** A new hook: its subject (a repository by id, a paper by DOI), its address, its events. */
export function validateHook(payload: unknown, o: { allowLocal?: boolean; siteHost?: string } = {}): HookRequest | ForgeProblem {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!p) return bad("The request is not readable.");
  const subject = readSubject(p.subject);
  if (!subject || subject.startsWith("topic:")) return bad("A webhook follows a repository (repo:<forge>:<id>) or a paper (paper:doi:10.…).");
  const url = hookUrl(p.url, o);
  if (url instanceof ForgeProblem) return url;
  const events = readEvents(p.events, subject);
  if (events instanceof ForgeProblem) return events;
  return { subject, url, events };
}

export const eventsText = (events: "*" | readonly string[]): string => (events === "*" ? "*" : events.join(" "));

/** Whether a hook wants an event. */
export const wants = (hook: Pick<HookRow, "events">, kind: string): boolean => hook.events === "*" || hook.events.split(" ").includes(kind);

// ─── the secret and the signature ────────────────────────────────────────────

/** A hook's secret: derived from the server key, the hook's id and its salt; never stored. */
export async function hookSecret(serverKey: string, id: string, salt: string): Promise<string> {
  return `whsec_${await hmac(serverKey, "hook", `${id}\n${salt}`)}`;
}

/** "sha256=<hex>" of a body under a secret (GitHub's X-Hub-Signature-256). */
export const signDelivery = (secret: string, body: string): Promise<string> => signBody(secret, utf8(body));

export const newHookId = (): string => randomToken(12);
export const newSalt = (): string => randomToken(12);

// ─── what a delivery holds ───────────────────────────────────────────────────

export interface Payload {
  event: string;
  delivery: string;
  hook: { id: string; subject: string };
  sent_at: string;
  [k: string]: unknown;
}

const iso = (t: number) => new Date(t * 1000).toISOString();

/** A ping: what the receiver answers 2xx to, for the hook to be active. */
export function pingPayload(hook: { id: string; subject: string; events: string }, guid: string, t: number): Payload {
  return { event: "ping", delivery: guid, hook: { id: hook.id, subject: hook.subject }, sent_at: iso(t), events: hook.events === "*" ? "*" : hook.events.split(" "), zen: "Code, traced to its paper." };
}

/** An event, as the inbox shows it: its kind, its title (masked), its page in the registry (an
 *  absolute address), its time, the actor's public GitHub id and login; never a text. */
export function eventPayload(hook: { id: string; subject: string }, e: EventRow, guid: string, origin: string, t: number): Payload {
  const url = /^\/(?![/\\])/.test(e.url) ? `${origin}${e.url}` : `${origin}/`;
  const repo = e.repo_path ? { path: e.repo_path, url: `${origin}/r/${e.repo_path}/` } : null;
  const doi = e.subject.startsWith("paper:doi:") ? e.subject.slice("paper:doi:".length) : e.paper_id.startsWith("doi:") ? e.paper_id.slice(4) : null;
  return {
    event: e.kind,
    delivery: guid,
    hook: { id: hook.id, subject: hook.subject },
    sent_at: iso(t),
    subject: e.subject,
    at: iso(e.at),
    thread: e.thread,
    title: maskEmails(e.title),
    url,
    repository: repo,
    paper: doi ? { doi, url: `https://doi.org/${doi}` } : null,
    actor: { github_id: e.actor_github || null, login: e.actor_name ? maskEmails(e.actor_name) : null },
  };
}

// ─── rows ────────────────────────────────────────────────────────────────────

export interface HookRow {
  user_id: string;
  id: string;
  subject: string;
  url: string;
  events: string;
  active: number;
  salt: string;
  created_at: number;
  updated_at: number;
}

export interface DeliveryRow {
  day: number;
  hook_id: string;
  at: number;
  guid: string;
  event: string;
  ev_subject: string;
  ev_at: number;
  ev_nonce: string;
  status: number;
  ok: number;
  attempts: number;
  ms: number;
  words: string;
  redelivery: number;
}

/** A hook made: its row and its index entry (2 rows). */
export function hookInsert(db: D1Database, h: Omit<HookRow, "updated_at">): Write {
  return {
    rows: 2,
    stmt: db
      .prepare("INSERT INTO hooks (user_id, id, subject, url, events, active, salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(h.user_id, h.id, h.subject, h.url, h.events, h.active, h.salt, Math.floor(h.created_at), Math.floor(h.created_at)),
  };
}

/** A hook changed: its events, its state, its salt (1 row: none of them is in the index). */
export function hookUpdate(db: D1Database, userId: string, id: string, set: { events?: string; active?: 0 | 1; salt?: string }, t: number): Write {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (set.events !== undefined) (cols.push("events = ?"), vals.push(set.events));
  if (set.active !== undefined) (cols.push("active = ?"), vals.push(set.active));
  if (set.salt !== undefined) (cols.push("salt = ?"), vals.push(set.salt));
  cols.push("updated_at = ?");
  vals.push(Math.floor(t));
  return { rows: 1, stmt: db.prepare(`UPDATE hooks SET ${cols.join(", ")} WHERE user_id = ? AND id = ?`).bind(...vals, userId, id) };
}

/** A hook deleted: its row and its index entry (2 rows). Its deliveries stay until they age out. */
export function hookDelete(db: D1Database, userId: string, id: string): Write {
  return { rows: 2, stmt: db.prepare("DELETE FROM hooks WHERE user_id = ? AND id = ?").bind(userId, id) };
}

/** A person's hooks (the key's prefix). */
export function hooksOf(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("SELECT * FROM hooks WHERE user_id = ? ORDER BY created_at LIMIT ?").bind(userId, HOOKS_PER_ACCOUNT + 5);
}

/** A subject's hooks (hooks_subject), the active ones only when asked. */
export function hooksOn(db: D1Database, subject: string, activeOnly: boolean): D1PreparedStatement {
  return db
    .prepare(`SELECT * FROM hooks WHERE subject = ?${activeOnly ? " AND active = 1" : ""} ORDER BY created_at LIMIT ?`)
    .bind(subject, HOOKS_PER_SUBJECT + (activeOnly ? 0 : 5));
}

/** One delivery (1 row). */
export function deliveryInsert(db: D1Database, d: Omit<DeliveryRow, "day">): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO hook_deliveries (day, hook_id, at, guid, event, ev_subject, ev_at, ev_nonce, status, ok, attempts, ms, words, redelivery) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        utcDay(d.at),
        d.hook_id,
        Math.floor(d.at),
        d.guid,
        d.event.slice(0, 40),
        d.ev_subject.slice(0, 220),
        Math.floor(d.ev_at),
        d.ev_nonce.slice(0, 120),
        Math.max(0, Math.min(599, Math.floor(d.status))),
        d.ok ? 1 : 0,
        Math.max(1, Math.min(5, d.attempts)),
        Math.max(0, Math.floor(d.ms)),
        maskEmails(d.words).replace(/@/g, " ").slice(0, 120),
        d.redelivery ? 1 : 0,
      ),
  };
}

/** A hook's deliveries of the last DELIVERY_DAYS days, the newest first (a key range per day). */
export function deliveriesOf(db: D1Database, hookId: string, t: number, limit = 50): D1PreparedStatement {
  const today = utcDay(t);
  const days = Array.from({ length: DELIVERY_DAYS }, (_, i) => today - i);
  return db
    .prepare(`SELECT * FROM hook_deliveries WHERE day IN (${days.map(() => "?").join(", ")}) AND hook_id = ? ORDER BY at DESC LIMIT ?`)
    .bind(...days, hookId, limit);
}

/** A hook as its person's page shows it: never its salt or secret, never the account's id. */
export function hookView(h: HookRow) {
  return {
    id: h.id,
    subject: h.subject,
    url: h.url,
    events: h.events === "*" ? "*" : h.events.split(" "),
    active: h.active === 1,
    created_at: iso(h.created_at),
    updated_at: iso(h.updated_at),
  };
}

export function deliveryView(d: DeliveryRow) {
  return {
    guid: d.guid,
    event: d.event,
    at: iso(d.at),
    status: d.status,
    ok: d.ok === 1,
    attempts: d.attempts,
    ms: d.ms,
    words: d.words,
    redelivery: d.redelivery === 1,
    redeliverable: d.event !== "ping" && !!d.ev_subject,
  };
}
