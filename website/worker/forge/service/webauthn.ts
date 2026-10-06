// Passkeys and security keys (WebAuthn), for sudo mode (night phase 09, E5; docs/ACCOUNTS.md). The
// Worker verifies a registration and an assertion itself, with WebCrypto only (webauthn-core.ts): no
// dependency, nothing paid, and only a PUBLIC key is kept. A passkey is a step up for a signed-in
// person (sudo mode), not the first sign-in, so the account is known and a credential is read by
// (user_id, cred_id): a key, never a scan.
//
//   POST /api/forge/account/passkey   signed in  {op}:
//     register_options  → the creation options (a challenge, the rp, the user, excludeCredentials)
//     register_verify   → verify the attestation, store the public key (a passkey.add log row)
//     auth_options      → the request options (a challenge, allowCredentials)
//     auth_verify       → verify the assertion, enter sudo mode (a sudo.enter log row)
//     rename            → {ref, label}
//     remove            → {ref}
//
// Not gated by FORGE_OPEN: securing your own account is always allowed. The account's `security` cap
// and the day's rows apply to the writes (register, remove, rename, sudo). The challenge lives in a
// server-signed, short-lived cookie bound to the session (webauthn-core.ts), never in D1.

import { signedIn, type SignedIn } from "../../account/guard.ts";
import { readCookie, clearCookie } from "../../account/http.ts";
import { dailyCaps, globalCap, overCap } from "./gate.ts";
import { json, problemAnswer } from "./http.ts";
import { linkedGithub } from "./identity.ts";
import { readJsonBody } from "./automation.ts";
import { securityLogWrite } from "./org-core.ts";
import { all, newNonce, rowsOf, statements } from "./store.ts";
import {
  base64url,
  bytesOf,
  CHALLENGE_COOKIE,
  CHALLENGE_SECONDS,
  coseToKey,
  decodeCbor,
  newChallenge,
  openChallenge,
  parseAuthData,
  parseClientData,
  rpIdHash,
  sameBytes,
  signChallenge,
  SUDO_SECONDS,
  verifyAssertion,
  type PublicKey,
} from "./webauthn-core.ts";
import { ForgeProblem, type ForgeRequest, type Write } from "./types.ts";

const bad = (message: string) => new ForgeProblem(400, "bad_payload", message);
const PASSKEY_BODY_BYTES = 16 * 1024;
const PASSKEYS_PER_ACCOUNT = 20;

interface CredRow {
  cred_id: string;
  cose: string;
  alg: number;
  sign_count: number;
  label: string;
}

function rpOf(r: ForgeRequest): { id: string; origin: string } {
  return { id: r.url.hostname, origin: r.url.origin };
}

function setChallengeCookie(value: string): string {
  return `${CHALLENGE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CHALLENGE_SECONDS}`;
}

/** The caps and the day's rows for a passkey write (not FORGE_OPEN); the linked GitHub id for the row. */
async function gate(r: ForgeRequest, s: SignedIn, rows: number): Promise<ForgeProblem | { github: string }> {
  const caps = await dailyCaps(r.db, s.user.id, "passkey", r.t);
  if (caps.exceeded) return overCap(caps.exceeded);
  const quota = await globalCap(r.db, r.t, rows);
  if (quota) return quota;
  return { github: (await linkedGithub(s.db, s.user.id)) ?? "" };
}

async function commit(r: ForgeRequest, userId: string, github: string, writes: Write[], event: string): Promise<number> {
  const action = {
    rows: 1,
    stmt: r.db
      .prepare("INSERT INTO actions (day, user_id, at, nonce, kind, forge, repo_id, github_user, outcome, rows, subject) VALUES (?, ?, ?, ?, 'passkey', '', '', ?, 'done', ?, ?)")
      .bind(Math.floor(r.t / 86_400), userId, Math.floor(r.t), newNonce(), github, 1 + rowsOf(writes), event.slice(0, 342)),
  };
  await r.db.batch([...statements(writes), action.stmt]);
  return 1 + rowsOf(writes);
}

export async function handlePasskeyWrite(r: ForgeRequest): Promise<Response> {
  const s = await signedIn(r.request, r.env, r.t, { post: true, touch: true });
  if (s instanceof Response) return s;
  const say = (p: ForgeProblem) => problemAnswer(p, s.cookies);
  const body = (await readJsonBody(r, PASSKEY_BODY_BYTES)) as Record<string, unknown> | ForgeProblem;
  if (body instanceof ForgeProblem) return say(body);
  const op = typeof body.op === "string" ? body.op : "";
  const key = r.env.SESSION_KEY as string;
  const sessionHash = s.session.idHash;
  const rp = rpOf(r);

  const mine = await all<CredRow>(r.db.prepare("SELECT cred_id, cose, alg, sign_count, label FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at LIMIT 50").bind(s.user.id));

  if (op === "register_options") {
    const challenge = newChallenge();
    const cookie = setChallengeCookie(await signChallenge(key, "create", sessionHash, challenge, r.t));
    return json(
      {
        challenge,
        rp: { id: rp.id, name: "Open Scientific Code Registry" },
        user: { id: base64url(new TextEncoder().encode(s.user.id)), name: s.user.display_name || "member", displayName: s.user.display_name || "member" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        excludeCredentials: mine.map((c) => ({ type: "public-key", id: c.cred_id })),
        authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
        timeout: CHALLENGE_SECONDS * 1000,
        attestation: "none",
      },
      200,
      [...s.cookies, cookie],
    );
  }

  if (op === "auth_options") {
    if (!mine.length) return say(new ForgeProblem(409, "no_passkey", "You have no passkey yet: add one first."));
    const challenge = newChallenge();
    const cookie = setChallengeCookie(await signChallenge(key, "get", sessionHash, challenge, r.t));
    return json(
      { challenge, rpId: rp.id, allowCredentials: mine.map((c) => ({ type: "public-key", id: c.cred_id })), userVerification: "preferred", timeout: CHALLENGE_SECONDS * 1000 },
      200,
      [...s.cookies, cookie],
    );
  }

  if (op === "register_verify") {
    const expected = await openChallenge(key, "create", sessionHash, readCookie(r.request, CHALLENGE_COOKIE), r.t);
    const clear = clearCookie(CHALLENGE_COOKIE);
    const sayClear = (p: ForgeProblem) => problemAnswer(p, [...s.cookies, clear]);
    if (!expected) return sayClear(new ForgeProblem(400, "no_challenge", "This registration has expired or was started elsewhere: start again."));
    const clientBytes = bytesOf(String(body.clientDataJSON ?? ""));
    const attBytes = bytesOf(String(body.attestationObject ?? ""));
    if (!clientBytes || !attBytes) return sayClear(bad("The registration is not readable."));
    const client = parseClientData(clientBytes);
    if (!client || client.type !== "webauthn.create") return sayClear(bad("This is not a passkey registration."));
    if (client.challenge !== expected) return sayClear(new ForgeProblem(400, "bad_challenge", "The registration does not match the challenge: start again."));
    if (client.origin !== rp.origin) return sayClear(new ForgeProblem(400, "bad_origin", "The registration came from another site."));
    let att: unknown;
    try {
      att = decodeCbor(attBytes).value;
    } catch {
      return sayClear(bad("The attestation is not readable."));
    }
    const authDataRaw = att instanceof Map ? att.get("authData") : null;
    if (!(authDataRaw instanceof Uint8Array)) return sayClear(bad("The attestation has no authenticator data."));
    const authData = parseAuthData(authDataRaw);
    if (!sameBytes(authData.rpIdHash, await rpIdHash(rp.id))) return sayClear(new ForgeProblem(400, "bad_rp", "The passkey is for another site."));
    if (!authData.up || !authData.at || !authData.credId || !authData.cose) return sayClear(bad("The passkey did not confirm presence or carried no key."));
    const pub = coseToKey(authData.cose);
    if (!pub) return sayClear(new ForgeProblem(400, "bad_key", "This passkey uses an algorithm the registry does not take (only ES256 and RS256)."));
    const credId = base64url(authData.credId);
    if (mine.some((c) => c.cred_id === credId)) return sayClear(new ForgeProblem(409, "already_registered", "This passkey is already on your account."));
    if (mine.length >= PASSKEYS_PER_ACCOUNT) return sayClear(new ForgeProblem(409, "too_many", `An account holds ${PASSKEYS_PER_ACCOUNT} passkeys at most: remove one first.`));
    const gated = await gate(r, s, 2);
    if (gated instanceof ForgeProblem) return sayClear(gated);
    const label = typeof body.label === "string" ? body.label.replace(/@/g, "").trim().slice(0, 60) : "";
    const transports = Array.isArray(body.transports) ? JSON.stringify((body.transports as unknown[]).filter((x) => typeof x === "string").slice(0, 8)) : "[]";
    const insert: Write = {
      rows: 1,
      stmt: r.db
        .prepare("INSERT INTO webauthn_credentials (user_id, cred_id, cose, alg, sign_count, label, transports, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(s.user.id, credId, JSON.stringify(pub.jwk), pub.alg, authData.signCount, label, transports, authData.uv ? 1 : 0, Math.floor(r.t)),
    };
    const written = await commit(r, s.user.id, gated.github, [insert, securityLogWrite(r.db, { userId: s.user.id, at: r.t, nonce: newNonce(), event: "passkey.add", detail: { alg: pub.alg === -7 ? "ES256" : "RS256", label } })], "passkey.add");
    return json({ ok: true, written, ref: credId.slice(0, 16), alg: pub.alg === -7 ? "ES256" : "RS256" }, 201, [...s.cookies, clear]);
  }

  if (op === "auth_verify") {
    const expected = await openChallenge(key, "get", sessionHash, readCookie(r.request, CHALLENGE_COOKIE), r.t);
    const clear = clearCookie(CHALLENGE_COOKIE);
    const sayClear = (p: ForgeProblem) => problemAnswer(p, [...s.cookies, clear]);
    if (!expected) return sayClear(new ForgeProblem(400, "no_challenge", "This step has expired or was started elsewhere: start again."));
    const rawId = String(body.id ?? "");
    const clientBytes = bytesOf(String(body.clientDataJSON ?? ""));
    const authBytes = bytesOf(String(body.authenticatorData ?? ""));
    const sig = bytesOf(String(body.signature ?? ""));
    if (!/^[A-Za-z0-9_-]+$/.test(rawId) || !clientBytes || !authBytes || !sig) return sayClear(bad("The assertion is not readable."));
    const client = parseClientData(clientBytes);
    if (!client || client.type !== "webauthn.get") return sayClear(bad("This is not a passkey assertion."));
    if (client.challenge !== expected) return sayClear(new ForgeProblem(400, "bad_challenge", "The assertion does not match the challenge: start again."));
    if (client.origin !== rp.origin) return sayClear(new ForgeProblem(400, "bad_origin", "The assertion came from another site."));
    const cred = mine.find((c) => c.cred_id === rawId);
    if (!cred) return sayClear(new ForgeProblem(404, "no_passkey", "That passkey is not on your account."));
    const authData = parseAuthData(authBytes);
    if (!sameBytes(authData.rpIdHash, await rpIdHash(rp.id))) return sayClear(new ForgeProblem(400, "bad_rp", "The assertion is for another site."));
    if (!authData.up) return sayClear(bad("The passkey did not confirm presence."));
    let pub: PublicKey;
    try {
      pub = { alg: cred.alg as PublicKey["alg"], jwk: JSON.parse(cred.cose) as JsonWebKey };
    } catch {
      return sayClear(new ForgeProblem(500, "bad_stored_key", "The stored passkey could not be read."));
    }
    const ok = await verifyAssertion(pub, authBytes, clientBytes, sig);
    if (!ok) return sayClear(new ForgeProblem(400, "bad_signature", "The passkey's signature did not verify."));
    // Clone detection: a counter that went backward (when both sides count) is refused.
    if (cred.sign_count > 0 && authData.signCount > 0 && authData.signCount <= cred.sign_count) {
      return sayClear(new ForgeProblem(409, "counter", "This passkey's counter went backward, which can mean a copy: it was not accepted. Remove it and add a new one."));
    }
    const gated = await gate(r, s, 2);
    if (gated instanceof ForgeProblem) return sayClear(gated);
    const until = Math.floor(r.t) + SUDO_SECONDS;
    const writes: Write[] = [
      { rows: 1, stmt: r.db.prepare("UPDATE webauthn_credentials SET sign_count = ?, last_used = ? WHERE user_id = ? AND cred_id = ?").bind(Math.max(authData.signCount, cred.sign_count), Math.floor(r.t), s.user.id, rawId) },
      { rows: 1, stmt: r.db.prepare("INSERT INTO sudo_sessions (session_hash, user_id, until) VALUES (?, ?, ?) ON CONFLICT (session_hash) DO UPDATE SET until = excluded.until, user_id = excluded.user_id").bind(sessionHash, s.user.id, until) },
      securityLogWrite(r.db, { userId: s.user.id, at: r.t, nonce: newNonce(), event: "sudo.enter", detail: { ref: rawId.slice(0, 16) } }),
    ];
    const written = await commit(r, s.user.id, gated.github, writes, "sudo.enter");
    return json({ ok: true, written, sudo: { active: true, until } }, 200, [...s.cookies, clear]);
  }

  // rename and remove (by the credential's ref, its first 16 base64url characters).
  if (op === "rename" || op === "remove") {
    const ref = typeof body.ref === "string" ? body.ref : "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(ref)) return say(bad("Which passkey? Give its ref from the list."));
    const cred = mine.find((c) => c.cred_id.slice(0, ref.length) === ref);
    if (!cred) return say(new ForgeProblem(404, "no_passkey", "No passkey of yours with that ref."));
    const gated = await gate(r, s, 2);
    if (gated instanceof ForgeProblem) return say(gated);
    if (op === "rename") {
      const label = typeof body.label === "string" ? body.label.replace(/@/g, "").trim().slice(0, 60) : "";
      const written = await commit(r, s.user.id, gated.github, [{ rows: 1, stmt: r.db.prepare("UPDATE webauthn_credentials SET label = ? WHERE user_id = ? AND cred_id = ?").bind(label, s.user.id, cred.cred_id) }, securityLogWrite(r.db, { userId: s.user.id, at: r.t, nonce: newNonce(), event: "passkey.rename", detail: { label } })], "passkey.rename");
      return json({ ok: true, written, label }, 200, s.cookies);
    }
    const written = await commit(r, s.user.id, gated.github, [{ rows: 1, stmt: r.db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ? AND cred_id = ?").bind(s.user.id, cred.cred_id) }, securityLogWrite(r.db, { userId: s.user.id, at: r.t, nonce: newNonce(), event: "passkey.remove", detail: {} })], "passkey.remove");
    return json({ ok: true, written }, 200, s.cookies);
  }

  return say(bad("Say what to do: register_options, register_verify, auth_options, auth_verify, rename or remove."));
}
