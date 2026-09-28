// One authorized action, in the reader's browser (D00-4; the design's §10.2; docs/FORGE.md "One
// authorized action"). The pages of the GitHub side (/new/, /new/link/, a repository's Settings and
// Branches) use it the same way:
//
//   1. `showConfirm(root, sentence, onConfirm)`: the sentence the person confirms, in a `.confirm`
//      block ("Create the public repository eeg-study in your GitHub account"), with a button that
//      goes to GitHub and one that cancels;
//   2. `startAction(input, sentence)`: the payload's exact text and its SHA-256 (src/lib/forge.ts
//      `apiStart`), the payload kept in this tab's sessionStorage (never sent to start), POST
//      /api/forge/start with the session's CSRF token (read from GET /api/account/me, as account.ts
//      reads it), then `location.assign` to GitHub's page;
//   3. GitHub sends the tab back to /forge/authorized/ (forge-authorized.ts), which takes the kept
//      payload (`takePending`) and posts {code, state, payload} to /api/forge/act
//      (`completeAction`), then says the outcome in words (`outcomeOf`).
//
// Nothing here runs when the module loads, and everything the page shows is written as text nodes,
// never as HTML. The token GitHub issues never reaches the browser: the Worker exchanges the code,
// acts, and revokes it. Like every browser script, it never names the platform: "the registry".

import { ACT_PATH, apiStart, backPath, START_PATH, type StartBody, type StartInput } from "../lib/forge.ts";
import { ACTION_PAYLOAD_BYTES, FLOW_SECONDS } from "../../worker/forge/service/caps.ts";

/** The sessionStorage key of the action waiting for GitHub's answer (one at a time: the Worker
 *  keeps one flow cookie). */
export const PENDING_KEY = "forge-pending";
/** The page that receives GitHub's answer. */
export const CALLBACK_PAGE = "/forge/authorized/";
/** Where the mirror mode's link page is, with an installation preselected. */
export const LINK_PAGE = "/new/link/";

/** The action this tab confirmed, kept until GitHub sends the tab back. */
export interface Pending {
  kind: string;
  /** The payload's exact text: its SHA-256 was bound at start. */
  payload: string;
  digest: string;
  /** The sentence the person confirmed. */
  sentence: string;
  /** The page to come back to (a path of this site). */
  back: string;
  /** When it was kept (Unix seconds). */
  at: number;
  /** The declaration posted to start (without `install`): after an installation of the App, the
   *  callback page declares the same action again, for an ordinary authorization (resumeAction). */
  start?: StartBody;
}

/** What the page shows: a tone (`.ok`, `.warning`, or none), sentences, and links. */
export interface Outcome {
  tone: "" | "ok" | "warning";
  text: string[];
  links: { href: string; text: string }[];
}

export interface ClientDeps {
  fetch?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  assign?: (url: string) => void;
  /** Unix seconds. */
  now?: () => number;
  /** The session's CSRF token, when the page already has it. */
  csrf?: string;
}

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const encoder = new TextEncoder();
/** An account or repository name (worker/forge/paths.ts SEGMENT). */
const SEGMENT_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The tab's sessionStorage, or null when the browser keeps none (a private window, blocked data). */
export function sessionStore(): ClientDeps["storage"] {
  try {
    const s = globalThis.sessionStorage;
    const probe = "forge-probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

const UNREACHABLE = "The registry could not be reached: check the connection, then try again.";

async function getJson(f: typeof fetch, path: string, init?: RequestInit): Promise<{ status: number; body: Json } | null> {
  try {
    const res = await f(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Json };
  } catch {
    return null;
  }
}

/** The session's CSRF token (GET /api/account/me), or the sentence that says why there is none. */
export async function readCsrf(deps: ClientDeps = {}): Promise<{ csrf: string } | { message: string; signIn: boolean }> {
  if (deps.csrf) return { csrf: deps.csrf };
  const me = await getJson(deps.fetch ?? fetch, "/api/account/me");
  if (!me) return { message: UNREACHABLE, signIn: false };
  if (me.body.error?.message) return { message: String(me.body.error.message), signIn: false };
  if (!me.body.signed_in || typeof me.body.csrf !== "string" || !me.body.csrf) {
    return { message: "Sign in first: the action is carried out as you, with your own GitHub account.", signIn: true };
  }
  return { csrf: me.body.csrf };
}

/** Whether GitHub's address is one the tab may go to: an absolute http(s) address, never a script. */
export function safeLocation(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export type Started = { ok: true; location: string } | { ok: false; message: string; code: string; signIn?: boolean };

/** Steps 1–2: keep the payload, POST start, and send the tab to GitHub. The payload never goes to
 *  start: only its SHA-256 does. */
export async function startAction(input: StartInput, sentence: string, deps: ClientDeps = {}): Promise<Started> {
  const storage = deps.storage === undefined ? sessionStore() : deps.storage;
  if (!storage) {
    return {
      ok: false,
      code: "no_storage",
      message: "This browser keeps nothing for this tab (a private window, or site data blocked), so the action could not be carried back from GitHub: nothing was done.",
    };
  }
  const { body, payload } = await apiStart(input);
  if (encoder.encode(payload).byteLength > ACTION_PAYLOAD_BYTES) {
    return { ok: false, code: "too_large", message: "This action is larger than the registry can pass to GitHub (1 MiB): GitHub's own page, or git, can do it." };
  }
  const token = await readCsrf(deps);
  if ("message" in token) return { ok: false, code: token.signIn ? "signed_out" : "unavailable", message: token.message, signIn: token.signIn };
  const { install: _install, ...plain } = body;
  const pending: Pending = { kind: body.kind, payload, digest: body.digest, sentence, back: body.back, at: (deps.now ?? nowSeconds)(), start: plain };
  return sendStart(body, pending, storage, token.csrf, deps);
}

/** After an installation of the App: the same action, declared again for an ordinary authorization
 *  (GitHub's authorization page with PKCE; the person who just installed the App is sent back at
 *  once). The installation page's own code is never used: it was not asked with a PKCE challenge. */
export async function resumeAction(pending: Pending, deps: ClientDeps = {}): Promise<Started> {
  const storage = deps.storage === undefined ? sessionStore() : deps.storage;
  if (!storage || !pending.start) {
    return { ok: false, code: "no_storage", message: "This tab no longer holds the action you confirmed: nothing was done. Go back to the page, then start it again." };
  }
  const token = await readCsrf(deps);
  if ("message" in token) return { ok: false, code: token.signIn ? "signed_out" : "unavailable", message: token.message, signIn: token.signIn };
  return sendStart(pending.start, { ...pending, at: (deps.now ?? nowSeconds)() }, storage, token.csrf, deps);
}

/** Keeps the action in the tab, POSTs start, and sends the tab to GitHub's address. */
async function sendStart(
  body: StartBody,
  pending: Pending,
  storage: NonNullable<ClientDeps["storage"]>,
  csrf: string,
  deps: ClientDeps,
): Promise<Started> {
  try {
    storage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    return { ok: false, code: "no_storage", message: "This browser could not keep the action for the return from GitHub (its storage is full): nothing was done." };
  }
  const res = await getJson(deps.fetch ?? fetch, START_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
  const location = res?.status === 200 ? safeLocation(res.body.location) : null;
  if (!res || !location) {
    storage.removeItem(PENDING_KEY);
    if (!res) return { ok: false, code: "network", message: UNREACHABLE };
    const e = res.body.error ?? {};
    return {
      ok: false,
      code: String(e.code ?? "unavailable"),
      message: String(e.message ?? "The registry could not start the action. Please try again."),
      signIn: res.status === 401,
    };
  }
  (deps.assign ?? ((url: string) => globalThis.location.assign(url)))(location);
  return { ok: true, location };
}

/** The action this tab kept, removed at once (one return, one attempt), or why there is none. */
export function takePending(storage: ClientDeps["storage"], now: number): Pending | "none" | "expired" {
  if (!storage) return "none";
  let text: string | null = null;
  try {
    text = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
  } catch {
    return "none";
  }
  if (!text) return "none";
  let p: Json;
  try {
    p = JSON.parse(text) as Json;
  } catch {
    return "none";
  }
  if (!p || typeof p.payload !== "string" || typeof p.digest !== "string" || typeof p.at !== "number") return "none";
  if (now - p.at > FLOW_SECONDS) return "expired";
  const pending: Pending = {
    kind: String(p.kind ?? ""),
    payload: p.payload,
    digest: p.digest,
    sentence: typeof p.sentence === "string" ? p.sentence : "",
    back: backPath(p.back),
    at: p.at,
  };
  const st = p.start as Json | undefined;
  // The declaration kept for a new authorization: the same action (its digest), nothing else.
  if (st && typeof st === "object" && typeof st.kind === "string" && st.digest === p.digest) {
    pending.start = {
      kind: st.kind as StartBody["kind"],
      repo: st.repo && typeof st.repo === "object" ? (st.repo as StartBody["repo"]) : null,
      branch: typeof st.branch === "string" ? st.branch : null,
      expectedHead: typeof st.expectedHead === "string" ? st.expectedHead : null,
      digest: p.digest,
      back: backPath(st.back),
    };
  }
  return pending;
}

/** What GitHub put in the callback's address, checked (anything else is ignored). */
export interface Return {
  code: string | null;
  state: string | null;
  /** The App's installation, when the return comes from its installation page. */
  installationId: string | null;
  setupAction: "install" | "update" | "request" | null;
  /** GitHub's error, when the person did not authorize ("access_denied"). */
  error: string | null;
}

export function readReturn(search: string): Return {
  const q = new URLSearchParams(search);
  const get = (name: string, shape: RegExp) => {
    const v = q.get(name);
    return v !== null && shape.test(v) ? v : null;
  };
  const setup = q.get("setup_action");
  return {
    code: get("code", /^[A-Za-z0-9_-]{1,200}$/),
    state: get("state", /^[A-Za-z0-9_-]{1,256}$/),
    installationId: get("installation_id", /^\d{1,20}$/),
    setupAction: setup === "install" || setup === "update" || setup === "request" ? setup : null,
    error: get("error", /^[a-z_]{1,64}$/),
  };
}

/** Whether the address carries anything of GitHub's (then the page removes it at once). */
export const hasReturn = (search: string): boolean => /[?&](code|state|installation_id|setup_action|error|error_description)=/.test(search);

/** Step 3: POST {code, state, payload} to act. */
export async function completeAction(ret: Return, pending: Pending, deps: ClientDeps = {}): Promise<{ status: number; body: Json } | null> {
  const token = await readCsrf(deps);
  if ("message" in token) return { status: token.signIn ? 401 : 503, body: { error: { code: token.signIn ? "signed_out" : "unavailable", message: token.message } } };
  return getJson(deps.fetch ?? fetch, ACT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token.csrf },
    body: JSON.stringify({ code: ret.code, state: ret.state, payload: pending.payload }),
  });
}

const backLink = (href: string) => ({ href: backPath(href), text: "Back to the page you came from" });

/** The installation's part of the outcome: installed (with the link page, the installation
 *  preselected), or requested from an organization's owners. */
export function installationOutcome(ret: Return): Outcome | null {
  if (!ret.installationId && ret.setupAction !== "request") return null;
  if (ret.setupAction === "request") {
    return {
      tone: "",
      text: ["The App's installation was requested from the organization's owners. Once one of them approves it, come back to link the repository."],
      links: [{ href: LINK_PAGE, text: "Link a repository" }],
    };
  }
  return {
    tone: "ok",
    text: [
      ret.setupAction === "update"
        ? "The App's installation was updated on GitHub: the repositories it may read are the ones you chose there."
        : "The App is installed on GitHub, on the repositories you chose there.",
    ],
    links: [{ href: `${LINK_PAGE}?installation=${ret.installationId}`, text: "Link one of its repositories to your paper" }],
  };
}

/** The outcome of act, in words, with a link back (and GitHub's own page when there is one). */
export function outcomeOf(res: { status: number; body: Json } | null, pending: Pending): Outcome {
  if (!res) return { tone: "warning", text: [UNREACHABLE, "GitHub's authorization was used up: go back to the page, then start the action again."], links: [backLink(pending.back)] };
  const back = backLink(typeof res.body.back === "string" ? res.body.back : pending.back);
  if (res.status === 200) {
    const done = typeof res.body.sentence === "string" && res.body.sentence ? res.body.sentence : pending.sentence;
    const text = [`Done, as you, on GitHub: ${done}.`.replace(/\.\.$/, ".")];
    if (res.body.outcome && res.body.outcome !== "done") text.push(`The registry noted it as ${String(res.body.outcome).replace(/_/g, " ")}.`);
    const result = (res.body.result ?? {}) as Json;
    // What did not go as asked (a first branch GitHub kept under its own name), in words.
    if (Array.isArray(result.notes)) for (const n of result.notes) if (typeof n === "string" && n) text.push(n);
    // Its papers: linked at once, or proposed to their authors.
    if (Array.isArray(result.papers) && result.papers.length) {
      const linked = result.papers.filter((p: Json) => p?.status === "linked").length;
      const proposed = result.papers.length - linked;
      const parts = [linked ? `${linked} ${linked === 1 ? "paper" : "papers"} linked` : "", proposed ? `${proposed} proposed to their authors` : ""].filter(Boolean);
      text.push(`Its papers: ${parts.join(", ")}.`);
    }
    // A new or linked repository: its page on this site (its quick setup when empty), a /r/ path only.
    const page = typeof result.page === "string" && result.page.startsWith("/r/") && backPath(result.page) === result.page ? result.page : null;
    const links = page ? [{ href: page, text: "The repository's page" }, back] : [back];
    // The other repositories of the same installation, to link next (each its own action).
    if (Array.isArray(result.others)) {
      for (const o of result.others.slice(0, 20)) {
        if (!o || !SEGMENT_RE.test(String(o.owner)) || !SEGMENT_RE.test(String(o.name))) continue;
        links.push({ href: `/new/link/?repo=${encodeURIComponent(`${o.owner}/${o.name}`)}`, text: `Link ${o.owner}/${o.name} too` });
      }
    }
    return { tone: "ok", text, links };
  }
  const e = (res.body.error ?? {}) as Json;
  const text = [String(e.message ?? "The action could not be carried out. Please try again.")];
  const links = [back];
  if (e.offer === "new_branch") {
    text.push("Go back to the page: it shows the branch as it is now, and offers to put your change on a new branch instead.");
  }
  if (res.status === 401 && e.code !== "unauthorized") links.push({ href: "/account/", text: "Sign in" });
  if (typeof e.fallbackUrl === "string" && safeLocation(e.fallbackUrl)?.startsWith("https://github.com/")) {
    links.push({ href: e.fallbackUrl, text: "Do it on GitHub's own page" });
  }
  return { tone: "warning", text, links };
}

/** Writes an outcome into an element: its paragraphs and links as text nodes. */
export function render(root: HTMLElement, outcomes: Outcome[]): void {
  const nodes: HTMLElement[] = [];
  for (const o of outcomes) {
    for (const sentence of o.text) {
      const p = document.createElement("p");
      if (o.tone) p.className = o.tone;
      p.textContent = sentence;
      nodes.push(p);
    }
    if (o.links.length) {
      const ul = document.createElement("ul");
      for (const l of o.links) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = l.href;
        a.textContent = l.text;
        li.append(a);
        ul.append(li);
      }
      nodes.push(ul);
    }
  }
  root.replaceChildren(...nodes);
}

/** Step 1: the sentence the person confirms, in a `.confirm` block, with "Confirm on GitHub" and
 *  "Cancel". `onConfirm` runs once; its failure is said under the sentence, in words. */
export function showConfirm(root: HTMLElement, sentence: string, onConfirm: () => Promise<Started>, onCancel?: () => void): void {
  const box = document.createElement("div");
  box.className = "confirm";
  const p = document.createElement("p");
  p.className = "sentence";
  p.textContent = sentence;
  const how = document.createElement("p");
  how.textContent = "GitHub asks you to authorize it, then the registry carries out this action as you, once, and forgets the authorization.";
  const buttons = document.createElement("p");
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "Confirm on GitHub";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const said = document.createElement("div");
  said.setAttribute("aria-live", "polite");
  buttons.append(go, document.createTextNode(" "), cancel);
  box.append(p, how, buttons, said);
  root.replaceChildren(box);
  go.addEventListener("click", async () => {
    go.disabled = true;
    cancel.disabled = true;
    const out = await onConfirm();
    if (out.ok) return;
    render(said, [{ tone: "warning", text: [out.message], links: out.signIn ? [{ href: "/account/", text: "Sign in" }] : [] }]);
    go.disabled = false;
    cancel.disabled = false;
  });
  cancel.addEventListener("click", () => {
    root.replaceChildren();
    onCancel?.();
  });
}
