// /account/security/: a person's sessions, identities, passkeys and security log (night phase 09, E4
// and E5). Reads GET /api/forge/account/security; revokes a session, unlinks an identity, adds and uses
// a passkey (WebAuthn in the browser), renames or removes one. Like every browser script, it never
// names the platform and shows no email address.

import { h } from "../lib/repo-view.ts";
import { show, toDom } from "./dom.ts";
import { signInLine } from "./pull-common.ts";
import { getJson, postJson, problemOf, signedIn } from "./social-client.ts";

const shell = document.getElementById("security-shell");

interface SessionItem { ref: string; agent: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }
interface IdentityItem { provider: string; linkedAt: number }
interface PasskeyItem { ref: string; label: string; alg: string; backedUp: boolean; createdAt: number; lastUsed: number | null }
interface LogItem { at: number; event: string; detail: unknown }
interface View {
  sessions: SessionItem[];
  identities: IdentityItem[];
  passkeys: PasskeyItem[];
  securityLog: LogItem[];
  sudo: { active: boolean; until: number };
}

const when = (t: number): string => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") : "-");

const b64urlToBuf = (s: string): ArrayBuffer =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=")), (c) => c.charCodeAt(0)).buffer;
const bufToB64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function draw(): Promise<void> {
  if (!shell) return;
  const status = shell.querySelector(".summary");
  if (!signedIn()) {
    status?.replaceChildren("Sign in to see your account security.");
    show(document.getElementById("sessions")!, signInLine("Your account security is your account's:"));
    return;
  }
  const r = await getJson("/api/forge/account/security");
  if (!r.ok) return void status?.replaceChildren(problemOf(r.body));
  const data = r.body as unknown as View;
  status?.replaceChildren(`${data.sessions.length} ${data.sessions.length === 1 ? "session" : "sessions"} open; sudo mode ${data.sudo.active ? "on" : "off"}.`);

  // Sessions.
  const sessions = document.getElementById("sessions")!;
  const sRows = data.sessions.map((s) =>
    h("tr", null,
      h("td", null, s.agent + (s.current ? " (this one)" : "")),
      h("td", null, when(s.lastSeenAt)),
      h("td", null, s.current ? "" : h("button", { type: "button", "data-revoke": s.ref }, "Revoke")),
    ),
  );
  show(sessions,
    h("table", { class: "listing" }, h("thead", null, h("tr", null, h("th", null, "Browser"), h("th", null, "Last seen"), h("th", null, ""))), h("tbody", null, ...sRows)),
    data.sessions.length > 1 ? h("p", null, h("button", { type: "button", id: "revoke-others" }, "Sign out every other session")) : "",
  );
  for (const b of sessions.querySelectorAll<HTMLButtonElement>("button[data-revoke]")) {
    b.addEventListener("click", async () => {
      b.disabled = true;
      const out = await postJson("/api/forge/account/sessions", { op: "revoke", idHash: b.dataset.revoke });
      if (!out.ok) return void (b.disabled = false);
      await draw();
    });
  }
  sessions.querySelector<HTMLButtonElement>("#revoke-others")?.addEventListener("click", async () => {
    if (!confirm("Sign out every other session? They will have to sign in again.")) return;
    await postJson("/api/forge/account/sessions", { op: "revoke_others" });
    await draw();
  });

  // Identities.
  const identities = document.getElementById("identities")!;
  show(identities, h("ul", { class: "plain" }, ...data.identities.map((i) =>
    h("li", null, `${i.provider} (linked ${when(i.linkedAt)}) `, data.identities.length > 1 ? h("button", { type: "button", "data-unlink": i.provider }, "Unlink") : h("span", { class: "muted" }, "your only sign-in")),
  )));
  for (const b of identities.querySelectorAll<HTMLButtonElement>("button[data-unlink]")) {
    b.addEventListener("click", async () => {
      if (!confirm(`Unlink ${b.dataset.unlink}? You keep your other ways to sign in.`)) return;
      await postJson("/api/forge/account/identities", { op: "unlink", provider: b.dataset.unlink });
      await draw();
    });
  }

  // Passkeys.
  const passkeys = document.getElementById("passkeys")!;
  show(passkeys, data.passkeys.length
    ? h("table", { class: "listing" }, h("thead", null, h("tr", null, h("th", null, "Passkey"), h("th", null, "Type"), h("th", null, "Last used"), h("th", null, ""))),
        h("tbody", null, ...data.passkeys.map((p) =>
          h("tr", null, h("td", null, p.label), h("td", null, p.alg), h("td", null, p.lastUsed ? when(p.lastUsed) : "never"),
            h("td", null, h("button", { type: "button", "data-remove": p.ref }, "Remove"))))))
    : h("p", { class: "muted" }, "No passkey yet."));
  for (const b of passkeys.querySelectorAll<HTMLButtonElement>("button[data-remove]")) {
    b.addEventListener("click", async () => {
      if (!confirm("Remove this passkey?")) return;
      await postJson("/api/forge/account/passkey", { op: "remove", ref: b.dataset.remove });
      await draw();
    });
  }

  // Passkey actions (add, use for sudo).
  const actions = document.getElementById("passkey-actions")!;
  const supported = typeof window.PublicKeyCredential !== "undefined";
  show(actions, supported
    ? h("p", null, h("button", { type: "button", id: "passkey-add" }, "Add a passkey"), " ", data.passkeys.length ? h("button", { type: "button", id: "passkey-use" }, data.sudo.active ? "Sudo mode is on" : "Use a passkey (sudo mode)") : "")
    : h("p", { class: "warning" }, "This browser does not support passkeys."));
  actions.querySelector<HTMLButtonElement>("#passkey-add")?.addEventListener("click", addPasskey);
  actions.querySelector<HTMLButtonElement>("#passkey-use")?.addEventListener("click", usePasskey);

  // Security log.
  const log = document.getElementById("security-log")!;
  show(log, data.securityLog.length
    ? h("table", { class: "listing" }, h("thead", null, h("tr", null, h("th", null, "When"), h("th", null, "Event"))),
        h("tbody", null, ...data.securityLog.map((e) => h("tr", null, h("td", null, when(e.at)), h("td", null, e.event)))))
    : h("p", { class: "muted" }, "Nothing yet."));
}

function note(message: string, warning = false): void {
  document.getElementById("passkey-note")?.replaceChildren(toDom(h("p", { class: warning ? "warning" : "ok" }, message)));
}

async function addPasskey(): Promise<void> {
  try {
    const label = prompt("A name for this passkey (optional):") ?? "";
    const o = (await postJson("/api/forge/account/passkey", { op: "register_options" })).body as Record<string, any>;
    if (!o.challenge) return note(problemOf(o), true);
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBuf(o.challenge),
        rp: o.rp,
        user: { id: b64urlToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams,
        excludeCredentials: (o.excludeCredentials ?? []).map((c: { id: string }) => ({ type: "public-key", id: b64urlToBuf(c.id) })),
        authenticatorSelection: o.authenticatorSelection,
        timeout: o.timeout,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!cred) return;
    const resp = cred.response as AuthenticatorAttestationResponse;
    const out = await postJson("/api/forge/account/passkey", {
      op: "register_verify",
      id: bufToB64url(cred.rawId),
      clientDataJSON: bufToB64url(resp.clientDataJSON),
      attestationObject: bufToB64url(resp.attestationObject),
      transports: resp.getTransports ? resp.getTransports() : [],
      label,
    });
    if (!out.ok) return note(problemOf(out.body), true);
    note("Passkey added.");
    await draw();
  } catch (e) {
    note(`The passkey could not be added: ${(e as Error).message}`, true);
  }
}

async function usePasskey(): Promise<void> {
  try {
    const o = (await postJson("/api/forge/account/passkey", { op: "auth_options" })).body as Record<string, any>;
    if (!o.challenge) return note(problemOf(o), true);
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBuf(o.challenge),
        rpId: o.rpId,
        allowCredentials: (o.allowCredentials ?? []).map((c: { id: string }) => ({ type: "public-key", id: b64urlToBuf(c.id) })),
        userVerification: o.userVerification,
        timeout: o.timeout,
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return;
    const resp = assertion.response as AuthenticatorAssertionResponse;
    const out = await postJson("/api/forge/account/passkey", {
      op: "auth_verify",
      id: bufToB64url(assertion.rawId),
      clientDataJSON: bufToB64url(resp.clientDataJSON),
      authenticatorData: bufToB64url(resp.authenticatorData),
      signature: bufToB64url(resp.signature),
    });
    if (!out.ok) return note(problemOf(out.body), true);
    note("Sudo mode is on.");
    await draw();
  } catch (e) {
    note(`The passkey could not be used: ${(e as Error).message}`, true);
  }
}

if (typeof document !== "undefined") void draw();
