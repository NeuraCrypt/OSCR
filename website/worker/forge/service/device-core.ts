// The command line's sign-in to the registry (night phase 14; docs/API.md "The command line's sign-in";
// DECISIONS.md D14-2): a device-code flow (RFC 8628's shape) that writes no row until a person decides.
// The routes are device.ts; the command line's side is cli/src/oscr_cli/oscrauth.py.
//
// - A **request** (the scopes, the token's life, a name, the expiry, a random nonce) is sealed with the
//   server key: `<payload>.<HMAC>`, both base64url, under the purpose "device-request". The approval page's
//   address carries it (`/device/?r=…`), so the page can say what is asked without a row.
// - The **device code** the command line polls with is another seal of the same nonce and expiry, under
//   another purpose ("device-code"), with the prefix `oscr_dc_` (secret scanners, `redact`). A request's
//   address never lets anyone poll: the device code stays in the terminal's memory.
// - The **user code** is 8 consonants derived from the nonce by the server key ("device-user"): the person
//   types it on the page, from their terminal, so that an address someone else sent them is not approved
//   by a click. Consonants only: no word, no 0/O or 1/I to confuse.
// - The **grant** row (D1 `device_grants`, migration 0011) is written when the person approves or refuses;
//   it is keyed by (the UTC day of the expiry, SHA-256 of "device\n" + nonce). The token is made when
//   the command line collects it, answered once, and only its digest kept (tokens-core.ts).
// - Codes live 15 minutes; a code is polled at most every 5 seconds (this isolate's memory: `slow_down`
//   past it); an address asks for at most 10 codes a minute (this isolate's memory). Nothing is counted
//   in D1.

import { base64url, fromBase64url, hmac, hmacCheck, sha256Hex } from "../../account/crypto.ts";
import { utcDay } from "./caps.ts";
import { cleanLine } from "./social-core.ts";
import { EXPIRY, isScope, SCOPES, type Scope } from "./tokens-core.ts";
import { ForgeProblem, type D1Database, type D1PreparedStatement, type Write } from "./types.ts";

/** How long a code is good for (seconds). */
export const DEVICE_SECONDS = 15 * 60;
/** The least time between two polls of one code (seconds). */
export const POLL_SECONDS = 5;
/** Codes one address may ask for in a minute (this isolate). */
export const CODES_PER_MINUTE = 10;
/** Wrong user codes typed for one request before the page stops taking them (this isolate). */
export const WRONG_CODES = 5;
/** A token's life when the command line asks none. */
export const DEFAULT_DAYS = EXPIRY.default;
export const DEVICE_PREFIX = "oscr_dc_";
export const DEVICE_BODY_BYTES = 2 * 1024;
/** The user code's letters: consonants without vowels (no word) nor Y. */
export const USER_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const SEAL = /^([A-Za-z0-9_-]{8,400})\.([A-Za-z0-9_-]{43})$/;

export interface DeviceRequest {
  /** The random nonce (16 bytes, base64url). */
  nonce: string;
  /** Unix seconds: when the code stops being good. */
  exp: number;
  scopes: Scope[];
  days: number;
  name: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64json = (v: unknown): string => base64url(encoder.encode(JSON.stringify(v)));
function unb64json(text: string): unknown {
  try {
    return JSON.parse(decoder.decode(fromBase64url(text)));
  } catch {
    return null;
  }
}

/** Scopes as a number (one bit each, SCOPES' order): short in an address. */
export const scopeMask = (scopes: readonly Scope[]): number => scopes.reduce((m, s) => m | (1 << SCOPES.indexOf(s)), 0);
export const scopesOfMask = (mask: number): Scope[] => SCOPES.filter((_, i) => (mask >> i) & 1);

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);

/** What the command line asks: known scopes (at least one), a life of 1 to 366 days, a short name. */
export function validateAsk(payload: unknown): { scopes: Scope[]; days: number; name: string } | ForgeProblem {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!p) return bad("The request is not readable.");
  if (!Array.isArray(p.scopes) || !p.scopes.length || p.scopes.length > SCOPES.length) return bad("Say what the token may do: scopes, at least one.");
  const scopes: Scope[] = [];
  for (const s of p.scopes) {
    if (!isScope(s)) return bad(`“${String(s).slice(0, 40)}” is not a scope of the registry's tokens.`);
    if (!scopes.includes(s)) scopes.push(s);
  }
  scopes.sort((a, b) => SCOPES.indexOf(a) - SCOPES.indexOf(b));
  const days = p.days === undefined ? DEFAULT_DAYS : p.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < EXPIRY.min || days > EXPIRY.max) {
    return bad(`A token expires after ${EXPIRY.min} to ${EXPIRY.max} days: none lives for ever.`);
  }
  const name = p.name === undefined ? "Command line" : cleanLine(p.name, 40);
  if (!name) return bad("A token needs a name.");
  if (name.includes("@")) return bad("A token's name holds no address.");
  return { scopes, days, name };
}

/** The request sealed for the approval page's address. */
export async function sealRequest(key: string, r: DeviceRequest): Promise<string> {
  const payload = b64json({ v: 1, n: r.nonce, e: r.exp, s: scopeMask(r.scopes), d: r.days, m: r.name });
  return `${payload}.${await hmac(key, "device-request", payload)}`;
}

/** A sealed request read back, or null when its seal or its fields are not the registry's. */
export async function openRequest(key: string, text: unknown): Promise<DeviceRequest | null> {
  if (typeof text !== "string") return null;
  const m = SEAL.exec(text);
  if (!m || !(await hmacCheck(key, "device-request", m[1], m[2]))) return null;
  const v = unb64json(m[1]) as { v?: unknown; n?: unknown; e?: unknown; s?: unknown; d?: unknown; m?: unknown } | null;
  if (!v || v.v !== 1 || typeof v.n !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(v.n)) return null;
  if (typeof v.e !== "number" || typeof v.s !== "number" || typeof v.d !== "number" || typeof v.m !== "string") return null;
  const scopes = scopesOfMask(v.s);
  if (!scopes.length) return null;
  return { nonce: v.n, exp: v.e, scopes, days: v.d, name: v.m };
}

/** The device code the command line polls with. */
export async function sealDevice(key: string, r: Pick<DeviceRequest, "nonce" | "exp">): Promise<string> {
  const payload = b64json({ v: 1, n: r.nonce, e: r.exp });
  return `${DEVICE_PREFIX}${payload}.${await hmac(key, "device-code", payload)}`;
}

/** A device code read back: its nonce and expiry, or null. */
export async function openDevice(key: string, text: unknown): Promise<Pick<DeviceRequest, "nonce" | "exp"> | null> {
  if (typeof text !== "string" || !text.startsWith(DEVICE_PREFIX)) return null;
  const m = SEAL.exec(text.slice(DEVICE_PREFIX.length));
  if (!m || !(await hmacCheck(key, "device-code", m[1], m[2]))) return null;
  const v = unb64json(m[1]) as { v?: unknown; n?: unknown; e?: unknown } | null;
  if (!v || v.v !== 1 || typeof v.n !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(v.n) || typeof v.e !== "number") return null;
  return { nonce: v.n, exp: v.e };
}

/** The 8 letters the person types, derived from the nonce by the server key. */
export async function userCode(key: string, nonce: string): Promise<string> {
  const bytes = fromBase64url(await hmac(key, "device-user", nonce));
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_ALPHABET[bytes[i] % USER_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** What a person typed, as a user code: letters only, upper case, a dash in the middle; "" otherwise. */
export function typedCode(text: unknown): string {
  if (typeof text !== "string") return "";
  const letters = text.toUpperCase().replace(/[\s-]+/g, "");
  if (letters.length !== 8) return "";
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return USER_CODE.test(code) ? code : "";
}

/** The grant's key: the UTC day of the expiry, and the SHA-256 of the nonce. */
export async function grantKey(r: Pick<DeviceRequest, "nonce" | "exp">): Promise<{ day: number; ref: string }> {
  return { day: utcDay(r.exp), ref: await sha256Hex(`device\n${r.nonce}`) };
}

export type GrantState = "approved" | "denied" | "collected";

export interface GrantRow {
  day: number;
  ref: string;
  user_id: string;
  scopes: string;
  days: number;
  name: string;
  state: GrantState;
  decided_at: number;
  expires_at: number;
  collected_at: number | null;
}

export function grantOf(db: D1Database, k: { day: number; ref: string }): D1PreparedStatement {
  return db.prepare("SELECT * FROM device_grants WHERE day = ? AND ref = ?").bind(k.day, k.ref);
}

/** A person's decision: 1 row, and none when a decision is there already. */
export function grantInsert(db: D1Database, row: Omit<GrantRow, "collected_at">): Write {
  return {
    rows: 1,
    stmt: db
      .prepare(
        "INSERT INTO device_grants (day, ref, user_id, scopes, days, name, state, decided_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, ref) DO NOTHING",
      )
      .bind(row.day, row.ref, row.user_id, row.scopes, row.days, row.name, row.state, Math.floor(row.decided_at), Math.floor(row.expires_at)),
  };
}

/** The approved grant marked collected: its one token (1 row; 0 changes when another poll took it). */
export function grantCollect(db: D1Database, k: { day: number; ref: string }, t: number): D1PreparedStatement {
  return db.prepare("UPDATE device_grants SET state = 'collected', collected_at = ? WHERE day = ? AND ref = ? AND state = 'approved'").bind(Math.floor(t), k.day, k.ref);
}

// ─── this isolate's limits (no row) ──────────────────────────────────────────

const MAX_KEYS = 5_000;
const POLLS = new Map<string, number>();
const CODES = new Map<string, { minute: number; n: number }>();
const WRONG = new Map<string, number>();

/** A poll of a code: false (slow down) when the last one was under POLL_SECONDS ago. */
export function takePoll(nonce: string, t: number, polls = POLLS): boolean {
  const last = polls.get(nonce);
  if (polls.size >= MAX_KEYS) polls.clear();
  if (last !== undefined && t - last < POLL_SECONDS) return false;
  polls.set(nonce, t);
  return true;
}

/** A code asked from an address: false past CODES_PER_MINUTE this minute. The address lives in this
 *  isolate's memory for the minute only: never written, never logged. */
export function takeCode(address: string, t: number, codes = CODES): boolean {
  if (!address) return true;
  const minute = Math.floor(t / 60);
  const w = codes.get(address);
  if (w && w.minute === minute) {
    if (w.n >= CODES_PER_MINUTE) return false;
    w.n += 1;
    return true;
  }
  if (codes.size >= MAX_KEYS) codes.clear();
  codes.set(address, { minute, n: 1 });
  return true;
}

/** One more wrong user code typed for a request; true while under WRONG_CODES. */
export function wrongCode(nonce: string, wrong = WRONG): boolean {
  if (wrong.size >= MAX_KEYS) wrong.clear();
  const n = (wrong.get(nonce) ?? 0) + 1;
  wrong.set(nonce, n);
  return n < WRONG_CODES;
}

export const tooManyWrong = (nonce: string, wrong = WRONG): boolean => (wrong.get(nonce) ?? 0) >= WRONG_CODES;
