// Phase 09 (organizations, teams, roles and account security) end to end, on this machine (night
// phase 09; docs/ORGANIZATIONS.md). Against the Worker started with FORGE_OPEN=true (Ada is the owner;
// Bob is a second account), over HTTP, with the sign-in mock and the fake GitHub:
//   - Ada creates an organization with a members-only README and a private member list;
//   - Ada invites Bob, Bob accepts, Ada sets a research permission on Bob;
//   - the members-only README is refused to Bob while he is not a member, shown once he is;
//   - Bob is removed (the leaving checklist comes back);
//   - Ada registers a passkey (WebAuthn, a real ES256 key) and uses it to enter sudo mode;
//   - Ada revokes one of her two sessions;
//   - Ada exports the audit log as CSV.
// Nothing is remote.
//
//   SITE=… MOCK=… FAKE=… node --experimental-strip-types tests/forge-service/e2e-organizations.ts

const SITE = process.env.SITE ?? "http://localhost:8791";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9491";
const FAKE = process.env.FAKE ?? "http://127.0.0.1:9490";
const ORIGIN = new URL(SITE).origin;
const RP_ID = new URL(SITE).hostname;

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

class Client {
  jar = new Map<string, string>();
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(SITE) && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.startsWith(SITE)) {
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(";");
        const i = pair.indexOf("=");
        const maxAge = attrs.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
        if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(pair.slice(0, i).trim());
        else this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    }
    return res;
  }
  async navigate(url: string): Promise<URL> {
    let current = url;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.request(current);
      const loc = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
      return new URL(current);
    }
    throw new Error("too many redirects");
  }
  async get(path: string): Promise<{ status: number; data: Json }> {
    const res = await this.request(`${SITE}${path}`, { headers: { Accept: "application/json" } });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }
  async raw(path: string): Promise<{ status: number; type: string; text: string }> {
    const res = await this.request(`${SITE}${path}`);
    return { status: res.status, type: res.headers.get("Content-Type") ?? "", text: await res.text() };
  }
  async post(path: string, body: unknown): Promise<{ status: number; data: Json }> {
    const me = (await this.get("/api/account/me")).data;
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
    if (typeof me.csrf === "string") headers["X-CSRF-Token"] = me.csrf;
    const res = await this.request(`${SITE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }
}

const seed = (await (await fetch(`${FAKE}/control/seed`)).json()) as { ada: { id: string }; bob: { id: string } };

async function signIn(who: "ada" | "bob"): Promise<Client> {
  const person = who === "ada" ? { id: Number(seed.ada.id), login: "ada-fixture", name: "Ada Fixture" } : { id: Number(seed.bob.id), login: "bob-fixture", name: "Bob Fixture" };
  await fetch(`${MOCK}/control`, { method: "POST", body: JSON.stringify({ who: { github: person } }) });
  const c = new Client();
  const landed = await c.navigate(`${SITE}/api/auth/github/start?return=/account/`);
  check(`${who} signed in`, landed.pathname === "/account/", landed.toString());
  return c;
}

// ─── a test authenticator (a real ES256 key, a real signature) ───────────────────
const b64url = (b: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=")), (c) => c.charCodeAt(0));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
function cborUint(n: number): Uint8Array {
  if (n < 24) return new Uint8Array([n]);
  if (n < 256) return new Uint8Array([24, n]);
  if (n < 65536) return new Uint8Array([25, n >> 8, n & 0xff]);
  return new Uint8Array([26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function head(major: number, n: number): Uint8Array { const u = cborUint(n); u[0] |= major << 5; return u; }
function cbor(v: unknown): Uint8Array {
  if (typeof v === "number") return v < 0 ? head(1, -1 - v) : head(0, v);
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (typeof v === "string") { const b = new TextEncoder().encode(v); return concat(head(3, b.length), b); }
  if (v instanceof Map) { const parts = [head(5, v.size)]; for (const [k, val] of v) parts.push(cbor(k), cbor(val)); return concat(...parts); }
  throw new Error("unsupported");
}
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): Uint8Array => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = concat(new Uint8Array([0]), v); return concat(new Uint8Array([0x02, v.length]), v); };
  const seq = concat(int(raw.slice(0, 32)), int(raw.slice(32, 64)));
  return concat(new Uint8Array([0x30, seq.length]), seq);
}
const sha = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

class Authenticator {
  key!: CryptoKey;
  pub!: CryptoKey;
  credId = crypto.getRandomValues(new Uint8Array(32));
  count = 0;
  async init(): Promise<void> { const p = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); this.key = p.privateKey; this.pub = p.publicKey; }
  async authData(withCred: boolean): Promise<Uint8Array> {
    const rpIdHash = await sha(new TextEncoder().encode(RP_ID));
    const flags = 0x01 | 0x04 | (withCred ? 0x40 : 0);
    const count = new Uint8Array([(this.count >>> 24) & 0xff, (this.count >> 16) & 0xff, (this.count >> 8) & 0xff, this.count & 0xff]);
    if (!withCred) return concat(rpIdHash, new Uint8Array([flags]), count);
    const jwk = await crypto.subtle.exportKey("jwk", this.pub);
    const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]);
    const credLen = new Uint8Array([this.credId.length >> 8, this.credId.length & 0xff]);
    return concat(rpIdHash, new Uint8Array([flags]), count, new Uint8Array(16), credLen, this.credId, cbor(cose));
  }
  client(type: string, challenge: string): Uint8Array { return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: ORIGIN })); }
  async attestation(challenge: string): Promise<Json> {
    const att = new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", await this.authData(true)]]);
    return { id: b64url(this.credId), clientDataJSON: b64url(this.client("webauthn.create", challenge)), attestationObject: b64url(cbor(att)) };
  }
  async assertion(challenge: string): Promise<Json> {
    this.count += 1;
    const authData = await this.authData(false);
    const client = this.client("webauthn.get", challenge);
    const signed = concat(authData, await sha(client));
    const rawSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.key, signed));
    return { id: b64url(this.credId), clientDataJSON: b64url(client), authenticatorData: b64url(authData), signature: b64url(rawToDer(rawSig)) };
  }
}

// ─── the run ────────────────────────────────────────────────────────────────────
const ada = await signIn("ada");
const bob = await signIn("bob");

// 1. Ada creates an organization, private membership, a members-only README.
const created = await ada.post("/api/forge/org/create", { handle: "e2e-lab", display_name: "E2E Lab", kind: "lab", members_private: true });
check("Ada creates an organization", created.status === 201, created.data?.error ?? created.data?.org?.handle);
const id = created.data.org.id as string;
await ada.post("/api/forge/org/update", { id, op: "settings", patch: { readme_public: "Public welcome", readme_members: "Internal protocol" } });

// 2. The members-only README is refused to Bob while he is not a member.
const before = await bob.get(`/api/forge/org?id=${id}`);
check("Bob (non-member) does not see the members-only README", before.data.org?.readmeMembers === "", before.data.org?.readmeMembers);
check("Bob (non-member) does not see the private member list", before.data.membersHidden === true && (before.data.members ?? []).length === 0);

// 3. Ada invites Bob; Bob accepts; a research permission is set and read.
const invited = await ada.post("/api/forge/org/members", { id, op: "invite", githubId: String(seed.bob.id), role: "member" });
check("Ada invites Bob", invited.status === 201, invited.data?.error ?? invited.data?.inviteId);
const accepted = await bob.post("/api/forge/org/members", { id, op: "accept", inviteId: invited.data.inviteId });
check("Bob accepts the invitation", accepted.data?.joined === true, accepted.data?.error);
await ada.post("/api/forge/org/members", { id, op: "set_perms", githubId: String(seed.bob.id), perms: ["validate_map"] });
const asMember = await bob.get(`/api/forge/org?id=${id}`);
check("Bob now sees the members-only README", asMember.data.org?.readmeMembers === "Internal protocol");
check("Bob's research permission is set", JSON.stringify(asMember.data.viewer?.member?.perms) === JSON.stringify(["validate_map"]), asMember.data.viewer?.member?.perms);

// 4. Ada removes Bob (the leaving checklist comes back).
const removed = await ada.post("/api/forge/org/members", { id, op: "remove", githubId: String(seed.bob.id) });
check("Ada removes Bob, with a leaving checklist", Array.isArray(removed.data?.checklist) && removed.data.checklist.length >= 3, removed.data?.error);

// 5. Ada registers a passkey and uses it to enter sudo mode.
const auth = new Authenticator();
await auth.init();
const regOpts = await ada.post("/api/forge/account/passkey", { op: "register_options" });
check("Ada gets passkey registration options", regOpts.status === 200 && regOpts.data.rp?.id === RP_ID, regOpts.data?.error);
const reg = await ada.post("/api/forge/account/passkey", { op: "register_verify", ...(await auth.attestation(regOpts.data.challenge)), label: "e2e key" });
check("Ada registers a passkey (WebAuthn verified in the Worker)", reg.status === 201, reg.data?.error);
const authOpts = await ada.post("/api/forge/account/passkey", { op: "auth_options" });
const sudo = await ada.post("/api/forge/account/passkey", { op: "auth_verify", ...(await auth.assertion(authOpts.data.challenge)) });
check("Ada enters sudo mode with the passkey", sudo.data?.sudo?.active === true, sudo.data?.error);

// 6. Ada revokes one of her two sessions.
const ada2 = await signIn("ada");
const view = await ada.get("/api/forge/account/security");
const other = (view.data.sessions as Json[]).find((s) => !s.current);
check("Ada has a second session", !!other, (view.data.sessions as Json[]).length);
const revoked = await ada.post("/api/forge/account/sessions", { op: "revoke", idHash: other?.ref });
check("Ada revokes the other session", revoked.data?.ok === true, revoked.data?.error);
const gone = await ada2.get("/api/forge/account/security");
check("the revoked session no longer works", gone.status === 401, gone.status);

// 7. Ada exports the audit log as CSV.
const csv = await ada.raw(`/api/forge/org/audit?id=${id}&format=csv`);
check("Ada exports the audit log as CSV", csv.status === 200 && csv.type.startsWith("text/csv") && csv.text.startsWith("at,event,actor,target,detail"), csv.type);
check("the audit log records the organization's history", /org\.create/.test(csv.text) && /member\.invite/.test(csv.text) && /member\.join/.test(csv.text));

console.log(failures === 0 ? "\nphase 09: all checks passed" : `\nphase 09: ${failures} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
