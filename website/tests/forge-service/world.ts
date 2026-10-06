// Test support: the forge service's world. The accounts' world (tests/account/browser.ts: the
// community database, the mock providers as `fetch`, a browser with a cookie jar) plus:
// - `forge`, the forge database (d1.ts: node:sqlite from migrations/d1-forge/, D1's billing, the
//   query plans' scans);
// - `backend`, the test double of every forge (tests/forge/memory.ts), on the world's clock, where
//   Ada has a GitHub account ("ada-fixture") whose id is the one the mock GitHub sign-in gives: a
//   GitHub sign-in and an authorized action name the same person;
// - the environment: the accounts', FORGE, and FORGE_OWNER_GITHUB_ID = Ada's GitHub id (Ada is the
//   owner, so FORGE_OPEN unset lets her act and nobody else);
// - `deps` for handleForge (the double, the clock), and a `ctx` that keeps what waitUntil got;
// - `browser()`: a browser whose /api/forge/* requests go to handleForge with those deps, the rest
//   to the accounts and the contributions as before.
// And `seed`: rows written through store.ts, for the tests that need a state to start from.
import { Browser, world, type World } from "../account/browser.ts";
import { MemoryBackend } from "../forge/memory.ts";
import { handleForge, isForgePath } from "../../worker/forge/service/index.ts";
import { actionRow, deliveryRow, insertJob, insertRepo, linkPapers, newNonce, updateRepo, type NewRepo } from "../../worker/forge/service/store.ts";
import { insertSnippet, type NewSnippet, type Person } from "../../worker/forge/service/snippets-core.ts";
import type { Context, ForgeDeps, ForgeServiceEnv, JobKind, Outcome, PaperStatus, RepoState, RowKind, Write } from "../../worker/forge/service/types.ts";
import { fakeForgeD1, type FakeForgeD1 } from "./d1.ts";
import { TEST_SECRET_PASS } from "../../worker/forge/service/turnstile.ts";

/** 2026-09-28 12:00 UTC, the double's own default time. */
export const T0 = 1_790_596_800;
export const ADA_LOGIN = "ada-fixture";

export interface ForgeWorld extends World {
  forge: FakeForgeD1;
  backend: MemoryBackend;
  /** Ada's account on the double's GitHub (its token() mints a user token). */
  ada: ReturnType<MemoryBackend["addUser"]>;
  env: ForgeServiceEnv;
  deps: ForgeDeps;
  ctx: Context & { waited: Promise<unknown>[] };
  clock: { t: number };
  advance(seconds: number): void;
  browser: () => ForgeBrowser;
}

/** Cloudflare's siteverify as its documented test secrets make it answer (night phase 16): the secret
 *  1x…AA passes any token, 2x…AA fails every one. Never Cloudflare itself from a test. */
export const turnstileStandIn: typeof fetch = async (_url, init) => {
  const form = new URLSearchParams(String(init?.body ?? ""));
  const pass = form.get("secret") === TEST_SECRET_PASS && !!form.get("response");
  return new Response(JSON.stringify({ success: pass, "error-codes": pass ? [] : ["invalid-input-response"] }), { headers: { "Content-Type": "application/json" } });
};

/** The token a page sends once Turnstile's widget passed (Cloudflare's documented dummy token). */
export const HUMAN_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** The routes whose forms carry the human check (night phase 16): the test browser sends the widget's
 *  token with them, as a page does once the check passed, unless a test sends its own. */
export const HUMAN_ROUTES = new Set([
  "/api/forge/research/open", "/api/forge/research/comment", "/api/forge/social/profile", "/api/forge/social/list",
  "/api/forge/tokens/write", "/api/forge/hooks/write", "/api/forge/report", "/api/forge/appeal", "/api/forge/rights",
  "/api/forge/device/decide",
  "/api/forge/discussions/open", "/api/forge/discussions/comment",
  "/api/forge/projects/create", "/api/forge/projects/item",
  "/api/forge/snippets/comment",
]);

/** A fresh world. `env` overrides the environment (FORGE_OPEN, FORGE_OWNER_GITHUB_ID: undefined to
 *  unset), `deps` the service's dependencies. Night phase 16: Turnstile is set up with Cloudflare's
 *  always-passing test secret and a local stand-in of siteverify (the switch FORGE_OPEN needs it). */
export function forgeWorld(opts: { env?: Partial<ForgeServiceEnv>; deps?: Partial<ForgeDeps>; t?: number } = {}): ForgeWorld {
  const base = world();
  const clock = { t: opts.t ?? T0 };
  const forge = fakeForgeD1();
  const backend = new MemoryBackend({ now: () => clock.t });
  const ada = backend.addUser(ADA_LOGIN);
  base.mock.who.github = { id: Number(ada.user.id), login: ADA_LOGIN, name: "Ada Fixture" };
  const env: ForgeServiceEnv = { ...base.env, FORGE: forge, FORGE_OWNER_GITHUB_ID: ada.user.id, TURNSTILE_SECRET_KEY: TEST_SECRET_PASS, ...opts.env };
  const waited: Promise<unknown>[] = [];
  const ctx = { waited, waitUntil: (p: Promise<unknown>) => void waited.push(p.catch(() => undefined)) };
  const deps: ForgeDeps = { backend, now: () => clock.t, turnstileFetch: turnstileStandIn, ...opts.deps };
  const w: ForgeWorld = {
    ...base,
    forge,
    backend,
    ada,
    env,
    deps,
    ctx,
    clock,
    advance: (seconds: number) => void (clock.t += seconds),
    browser: () => new ForgeBrowser(w),
  };
  return w;
}

/** The Set-Cookie headers of an answer into a browser's jar, as a browser keeps them. */
export function keepCookies(b: Browser, res: Response): void {
  b.setCookies = res.headers.getSetCookie();
  for (const c of b.setCookies) {
    const [pair, ...attributes] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
    if (maxAge && Number(maxAge.split("=")[1]) <= 0) b.jar.delete(name);
    else b.jar.set(name, pair.slice(i + 1).trim());
  }
}

/** A browser in front of the forge service (with the world's deps), the accounts and the
 *  contributions. */
export class ForgeBrowser extends Browser {
  w: ForgeWorld;

  constructor(w: ForgeWorld) {
    super(w.env, w.mock);
    this.w = w;
  }

  /** A POST as a page sends it; to a form with the human check, with the widget's token (unless given). */
  async post(path: string, body?: unknown, opts: { csrf?: string | null; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const withToken = HUMAN_ROUTES.has(new URL(path, this.origin).pathname) && body && typeof body === "object" && !Array.isArray(body) && !("turnstile" in body)
      ? { ...(body as Record<string, unknown>), turnstile: HUMAN_TOKEN }
      : body;
    return super.post(path, withToken, opts);
  }

  async fetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const url = new URL(path, this.origin);
    if (!isForgePath(url.pathname)) return super.fetch(path, init);
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const request = new Request(url, { method: init.method ?? "GET", headers, body: init.body });
    const res = (await handleForge(request, this.env, this.w.ctx, this.w.deps)) as Response;
    keepCookies(this, res);
    return res;
  }
}

/** Writes in one batch, as the service sends them. */
async function run(db: FakeForgeD1, writes: Write[]): Promise<void> {
  await db.batch(writes.map((x) => x.stmt));
}

/** Rows written straight into the forge database through store.ts, for a starting state. */
export const seed = {
  async repo(
    db: FakeForgeD1,
    r: Partial<NewRepo> & { repoId: string; ownerLogin: string; name: string },
    t = T0,
    extra: { state?: RepoState; deleteAfter?: number | null; papers?: { paperId: string; status: PaperStatus }[] } = {},
  ): Promise<void> {
    const repo: NewRepo = { forge: "memory", ownerId: "1", mode: "public", linkedBy: "u_seed", ...r };
    const writes: Write[] = [insertRepo(db, repo, t)];
    if (extra.state) writes.push(updateRepo(db, repo.forge, repo.repoId, { state: extra.state, deleteAfter: extra.deleteAfter ?? null }, t));
    if (extra.papers?.length) writes.push(...linkPapers(db, repo.forge, repo.repoId, extra.papers, repo.linkedBy, t));
    await run(db, writes);
  },
  async action(
    db: FakeForgeD1,
    a: { userId: string; kind: RowKind; t: number; rows?: number; outcome?: Outcome; forge?: string; repoId?: string; githubUser?: string },
  ): Promise<void> {
    await run(db, [actionRow(db, { nonce: newNonce(), rows: 1, outcome: "done", ...a })]);
  },
  async delivery(db: FakeForgeD1, d: { delivery: string; t: number; rows?: number; event?: string }): Promise<void> {
    await run(db, [deliveryRow(db, { event: "push", rows: 1, ...d })]);
  },
  async job(db: FakeForgeD1, j: { kind: JobKind; forge?: string; repoId: string; ref?: string; userId?: string; notBefore?: number | null }, t = T0): Promise<void> {
    await run(db, [insertJob(db, { forge: "memory", ...j }, t)]);
  },
  /** A snippet's record (night phase 13): the row is written straight, for the native routes' tests.
   *  Its files and revision are an authorized commit elsewhere; here the manifest is enough. */
  async snippet(
    db: FakeForgeD1,
    s: { ownerId: string; ownerLogin: string; repoId: string; folder: string; title: string } & Partial<NewSnippet>,
    t = T0,
  ): Promise<number> {
    const who: Person = s.who ?? { id: s.ownerId, author: s.ownerLogin, via: "github" };
    const write = insertSnippet(db, {
      ownerId: s.ownerId, ownerLogin: s.ownerLogin, forge: s.forge ?? "memory", repoId: s.repoId, folder: s.folder,
      revision: s.revision ?? "a".repeat(40), visibility: s.visibility ?? "public", title: s.title, description: s.description ?? "",
      manifest: s.manifest ?? [{ path: "a.py", language: "Python", size: 10, lines: 1 }],
      passage: s.passage ?? { paperId: "", section: "", paragraph: null, startLine: null, endLine: null },
      forkedFrom: s.forkedFrom ?? null, who, role: s.role ?? "",
    }, t);
    await run(db, [write]);
    return Number((db.sqlite.prepare("SELECT id FROM snippets WHERE owner_login = ? AND folder = ?").get(s.ownerLogin.toLowerCase(), s.folder.toLowerCase()) as { id: number }).id);
  },
};
