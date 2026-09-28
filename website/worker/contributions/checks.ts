// The immediate checks of a submission or a correction, in the Worker, within the free plan
// (10 ms of CPU and 50 subrequests a request; waiting on the network costs no CPU):
//
// - the DOI resolves: the DOI proxy's handle API (https://doi.org/api/handles/<doi>), one small
//   JSON answer, without following the DOI to its publisher;
// - each link answers: a HEAD request on its page (a GET when the place refuses HEAD), without
//   following redirects (a redirect is an answer). 404 or 410: missing, refused at once. Anything
//   else that is not an answer (a timeout, 429, 5xx, a page behind a sign-in): "unchecked", left to
//   the Mac, which verifies every link anyway;
// - the place is one the registry knows (links.ts); the Worker never fetches another address.
//
// Not here: the license. It needs a forge's API (GitHub's: 60 requests an hour for the Worker's
// shared addresses), so the Mac reads it, with its own token, when it verifies the repository.
//
// At most 1 + 2 × 5 subrequests for a submission (the DOI, then HEAD and perhaps GET for each of
// five links), all at once, each stopped after TIMEOUT_MS.

import { handleUrl, type Recognized } from "./links.ts";

/** Sent with every check: it does not name the platform (like the accounts' USER_AGENT). */
export const USER_AGENT = "code-registry-checks";
export const TIMEOUT_MS = 6000;

export type Outcome = "ok" | "missing" | "unchecked";

export interface LinkCheck {
  url: string;
  key: string;
  outcome: Outcome;
  status: number | null;
}

export interface CheckEnv {
  /** Development only: every check goes to this local mock instead (https://github.com/o/r →
   *  <CHECKS_URL>/github.com/o/r). http on this machine only, like the providers' mocks. */
  CHECKS_URL?: string;
}

/** Where a check goes: the real address, or the development mock's copy of it. */
export function target(env: CheckEnv, url: string): string {
  const mock = (env.CHECKS_URL ?? "").trim().replace(/\/+$/, "");
  if (!mock) return url;
  let m: URL;
  try {
    m = new URL(mock);
  } catch {
    return url;
  }
  const local = m.hostname === "localhost" || m.hostname === "127.0.0.1" || m.hostname === "[::1]";
  if (m.protocol !== "http:" || !local) return url;
  const u = new URL(url);
  return `${mock}/${u.host}${u.pathname}${u.search}`;
}

async function ask(env: CheckEnv, url: string, method: "HEAD" | "GET"): Promise<Response | null> {
  try {
    return await fetch(target(env, url), {
      method,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: method === "GET" ? "text/html,application/json" : "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** Whether a DOI is registered. */
export async function checkDoi(env: CheckEnv, doi: string): Promise<{ outcome: Outcome; status: number | null }> {
  const res = await ask(env, handleUrl(doi), "GET");
  if (!res) return { outcome: "unchecked", status: null };
  const body = (await res.json().catch(() => null)) as { responseCode?: unknown } | null;
  if (res.status === 200 && body?.responseCode === 1) return { outcome: "ok", status: 200 };
  if (res.status === 404 || body?.responseCode === 100) return { outcome: "missing", status: res.status };
  return { outcome: "unchecked", status: res.status };
}

function outcomeOf(status: number): Outcome {
  if (status >= 200 && status < 400) return "ok";
  if (status === 404 || status === 410) return "missing";
  return "unchecked";
}

/** Whether a recognized link answers. */
export async function checkLink(env: CheckEnv, link: Recognized): Promise<LinkCheck> {
  if (link.via === "doi") {
    const d = await checkDoi(env, link.key.slice(4));
    return { url: link.url, key: link.key, outcome: d.outcome, status: d.status };
  }
  let res = await ask(env, link.check, "HEAD");
  // A place that refuses HEAD is asked again with GET; its body is not read.
  if (res && (res.status === 405 || res.status === 501)) {
    await res.body?.cancel();
    res = await ask(env, link.check, "GET");
  }
  if (!res) return { url: link.url, key: link.key, outcome: "unchecked", status: null };
  await res.body?.cancel().catch(() => undefined);
  return { url: link.url, key: link.key, outcome: outcomeOf(res.status), status: res.status };
}

/** Every link at once. */
export function checkLinks(env: CheckEnv, links: Recognized[]): Promise<LinkCheck[]> {
  return Promise.all(links.map((l) => checkLink(env, l)));
}
