// Test support: a browser in front of `handleAccount`, with a cookie jar and the mock providers
// installed as `fetch`. It follows a sign-in the way a real browser does: the start's redirect, the
// provider's page (which approves at once), the callback.
import { handleAccount } from "../../worker/account/index.ts";
import { forgetKeys } from "../../worker/account/jwt.ts";
import type { AccountEnv } from "../../worker/account/types.ts";
import { fakeD1, type FakeD1 } from "./d1.ts";
import { MockProviders } from "./mock.ts";

export const ORIGIN = "https://registry.test";
export const SESSION_KEY = "test-server-key-0123456789-abcdefghijklmnopqrstuvwxyz";

export interface World {
  db: FakeD1;
  mock: MockProviders;
  env: AccountEnv;
  browser: () => Browser;
  restore: () => void;
}

/** A fresh database, fresh providers, and `fetch` pointed at them (until `restore`). */
export function world(overrides: Partial<AccountEnv> = {}): World {
  const db = fakeD1();
  const mock = new MockProviders();
  const env: AccountEnv = { COMMUNITY: db, SESSION_KEY, ...mock.env(), ...overrides };
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => mock.handle(new Request(input, init))) as typeof fetch;
  forgetKeys();
  return {
    db,
    mock,
    env,
    browser: () => new Browser(env, mock),
    restore: () => {
      globalThis.fetch = real;
      forgetKeys();
    },
  };
}

export class Browser {
  jar = new Map<string, string>();
  /** The Set-Cookie headers of the last answer, as sent. */
  setCookies: string[] = [];

  env: AccountEnv;
  mock: MockProviders;
  origin: string;

  constructor(env: AccountEnv, mock: MockProviders, origin = ORIGIN) {
    this.env = env;
    this.mock = mock;
    this.origin = origin;
  }

  cookie(name: string): string | null {
    return this.jar.get(name) ?? null;
  }

  private keep(res: Response): void {
    this.setCookies = res.headers.getSetCookie();
    for (const c of this.setCookies) {
      const [pair, ...attributes] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(name);
      else this.jar.set(name, pair.slice(i + 1).trim());
    }
  }

  async fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const request = new Request(new URL(path, this.origin), { method: init.method ?? "GET", headers, body: init.body });
    const res = (await handleAccount(request, this.env)) ?? new Response("a static page", { status: 299 });
    this.keep(res);
    return res;
  }

  /** The account, as /api/account/me answers it. */
  async me(): Promise<Record<string, any>> {
    return (await this.fetch("/api/account/me")).json();
  }

  /** A POST from the account page: its Origin and the session's CSRF token, unless told otherwise. */
  async post(path: string, body?: unknown, opts: { csrf?: string | null; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
    const origin = opts.origin === undefined ? this.origin : opts.origin;
    if (origin !== null) headers.Origin = origin;
    const csrf = opts.csrf === undefined ? (await this.me()).csrf : opts.csrf;
    if (csrf) headers["X-CSRF-Token"] = csrf;
    return this.fetch(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** From a provider's authorization address to the page the callback sends the browser to. */
  async approve(atProvider: string, edit?: (u: URL) => void): Promise<URL> {
    const u = new URL(atProvider);
    edit?.(u);
    const back = new URL(this.mock.authorize(u.toString()));
    const res = await this.fetch(back.pathname + back.search);
    return new URL(res.headers.get("Location") ?? "/", this.origin);
  }

  /** A whole sign-in: the start, the provider, the callback. Returns where the browser lands. */
  async signIn(provider: string, opts: { query?: string; edit?: (u: URL) => void } = {}): Promise<URL> {
    const start = await this.fetch(`/api/auth/${provider}/start${opts.query ?? ""}`);
    const location = start.headers.get("Location") ?? "";
    if (!location.startsWith(this.mock.base)) return new URL(location, this.origin);
    return this.approve(location, opts.edit);
  }
}
