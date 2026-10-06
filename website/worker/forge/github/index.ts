// The GitHub backend: GitBackend over GitHub's REST and GraphQL APIs, with the network reached
// only through the injected `fetch` (the browser passes globalThis.fetch.bind(globalThis), the
// tests a mock). Zero dependencies: fetch and WebCrypto, in workerd, Node 22+ and browsers.
//
//   const backend = githubBackend(githubConfigFromEnv(env), { fetch: globalThis.fetch.bind(globalThis) });
//   await backend.session({ kind: "user", token }).git.createCommit(repo, { … });
//
// Configuration (GitHubConfig), from the Worker's env (ForgeEnv):
// - Cloudflare secrets, created by the owner (tools/setup_cloudflare.sh, extended in phase 01):
//   GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY (GitHub's
//   PEM as it is, PKCS#1 or PKCS#8) and GITHUB_APP_WEBHOOK_SECRET; the variable GITHUB_APP_SLUG.
//   Never in the code, never in wrangler.toml.
// - Development only: FORGE_GITHUB_WEB_URL, FORGE_GITHUB_API_URL, FORGE_GITHUB_UPLOADS_URL and
//   FORGE_GITHUB_RAW_URL point at a mock. Addresses must be https, or http on localhost only (the
//   rule of account/providers.ts); anything else is refused.
// Without the App's values, user and installation sessions are `unsupported` ("the GitHub App is
// not set up yet"); anonymous sessions still work.
//
// Sessions:
// - anonymous: no Authorization header; files come from the raw CDN; the capabilities of
//   limits.ts (no blame, no code search, no review threads: GraphQL and code search need a
//   credential). What a rate-limited reader cannot do here, `fallbackUrl` shows on GitHub.
// - user: `Authorization: Bearer <the person's token>`, for one action; the token is never
//   stored, logged or put in an error.
// - installation: tokens minted with the App's JWT (app.ts), narrowed to the repository and the
//   act, cached in memory only. Installation sessions only post check runs (rules.ts, D00-4).
//
// Files: http.ts (requests, errors, pages), map.ts (answers → types), graphql.ts (documents),
// repos.ts, git.ts, pulls.ts, issues.ts, releases.ts, checks.ts (the methods and their
// endpoints), webhooks.ts, app.ts, auth.ts, links.ts.
// Once the App exists, check against real answers (docs/NIGHT_RUN.md, the design's §18): the
// GraphQL error types for a stale expectedHeadOid, the largest createCommitOnBranch payload, blame
// within GraphQL's 10 s, webhook payload sizes.

import { GitBackendError, invalid } from "../errors.ts";
import type { GitBackend, GitSession } from "../gitbackend.ts";
import { GITHUB_CAPABILITIES, GITHUB_LIMITS } from "../limits.ts";
import type * as T from "../types.ts";
import { installationToken, TOKEN_CACHE, TOKEN_PERMISSIONS, type TokenCache } from "./app.ts";
import { checkToken, githubAuth, NOT_SET_UP } from "./auth.ts";
import { checkOps } from "./checks.ts";
import type { Ctx } from "./ctx.ts";
import { gitOps } from "./git.ts";
import { type Endpoints, Http, type Scope } from "./http.ts";
import { issueOps } from "./issues.ts";
import { forgeLinks } from "./links.ts";
import { pullOps } from "./pulls.ts";
import { releaseOps } from "./releases.ts";
import { repoOps } from "./repos.ts";
import { githubWebhooks } from "./webhooks.ts";

export interface GitHubConfig {
  /** Default https://github.com. */
  web?: string;
  /** Default https://api.github.com (GraphQL: <api>/graphql). */
  api?: string;
  /** Default https://uploads.github.com. */
  uploads?: string;
  /** Default https://raw.githubusercontent.com. */
  raw?: string;
  /** Public. */
  appSlug?: string;
  /** Cloudflare secret. */
  appId?: string;
  /** Cloudflare secret. */
  clientId?: string;
  /** Cloudflare secret. */
  clientSecret?: string;
  /** Cloudflare secret: GitHub's PEM, PKCS#1 or PKCS#8. */
  privateKey?: string;
  /** Cloudflare secret. */
  webhookSecret?: string;
  /** Default 10,000. */
  timeoutMs?: number;
}

export interface GitHubDeps {
  fetch: typeof fetch;
  /** Unix seconds. */
  now?: () => number;
  tokenCache?: TokenCache;
}

/** The Worker's values for the GitHub App (11 of the 64 variables a Worker may have, with FORGE). */
export interface ForgeEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_SLUG?: string;
  FORGE_GITHUB_WEB_URL?: string;
  FORGE_GITHUB_API_URL?: string;
  FORGE_GITHUB_UPLOADS_URL?: string;
  FORGE_GITHUB_RAW_URL?: string;
}

/** An address: https, or http on this machine only (a development mock); without its final "/". */
export function address(value: string | undefined, fallback: string, name: string): string {
  const v = (value ?? "").trim().replace(/\/+$/, "");
  if (!v) return fallback;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw invalid(`${name} is not an address`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.search || u.hash || u.username || u.password) {
    throw invalid(`${name} must be https, or http on localhost`);
  }
  return v;
}

const value = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

export function githubConfigFromEnv(env: ForgeEnv): GitHubConfig {
  return {
    web: address(env.FORGE_GITHUB_WEB_URL, "https://github.com", "FORGE_GITHUB_WEB_URL"),
    api: address(env.FORGE_GITHUB_API_URL, "https://api.github.com", "FORGE_GITHUB_API_URL"),
    uploads: address(env.FORGE_GITHUB_UPLOADS_URL, "https://uploads.github.com", "FORGE_GITHUB_UPLOADS_URL"),
    raw: address(env.FORGE_GITHUB_RAW_URL, "https://raw.githubusercontent.com", "FORGE_GITHUB_RAW_URL"),
    appSlug: value(env.GITHUB_APP_SLUG),
    appId: value(env.GITHUB_APP_ID),
    clientId: value(env.GITHUB_APP_CLIENT_ID),
    clientSecret: value(env.GITHUB_APP_CLIENT_SECRET),
    // A PEM keeps its line breaks.
    privateKey: env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY.trim() ? env.GITHUB_APP_PRIVATE_KEY : undefined,
    webhookSecret: value(env.GITHUB_APP_WEBHOOK_SECRET),
  };
}

export function githubBackend(config: GitHubConfig, deps: GitHubDeps): GitBackend {
  if (!deps || typeof deps.fetch !== "function") throw new TypeError("githubBackend needs a fetch");
  const endpoints: Endpoints = {
    web: address(config.web, "https://github.com", "web"),
    api: address(config.api, "https://api.github.com", "api"),
    uploads: address(config.uploads, "https://uploads.github.com", "uploads"),
    raw: address(config.raw, "https://raw.githubusercontent.com", "raw"),
  };
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const cache = deps.tokenCache ?? TOKEN_CACHE;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const links = forgeLinks({ forge: "github", web: endpoints.web, appSlug: config.appSlug ?? null });
  const issuer = config.clientId || config.appId || "";
  const privateKey = config.privateKey ?? "";

  return {
    forge: "github",
    limits: GITHUB_LIMITS,
    links,
    webhooks: githubWebhooks(),
    auth: githubAuth({ endpoints, clientId: config.clientId, clientSecret: config.clientSecret, appSlug: config.appSlug, fetch: deps.fetch, now, timeoutMs }),
    capabilities: (kind) => GITHUB_CAPABILITIES[kind],

    session(credential: T.Credential): GitSession {
      const kind = credential?.kind;
      if (kind !== "anonymous" && kind !== "user" && kind !== "installation") throw invalid("not a credential");
      let authorization: (scope: Scope) => Promise<string | null>;
      if (kind === "anonymous") {
        authorization = async () => null;
      } else if (kind === "user") {
        if (!config.clientId || !config.clientSecret) throw new GitBackendError("unsupported", NOT_SET_UP);
        const header = `Bearer ${checkToken((credential as { token: string }).token)}`;
        authorization = async () => header;
      } else {
        const installationId = (credential as { installationId: string }).installationId;
        if (typeof installationId !== "string" || !/^\d{1,20}$/.test(installationId)) throw invalid("not an installation id");
        if (!issuer || !privateKey) throw new GitBackendError("unsupported", NOT_SET_UP);
        authorization = async (scope) => {
          const token = await installationToken({
            http,
            installationId,
            repo: scope.repo ?? null,
            permissions: TOKEN_PERMISSIONS[scope.act === "check" ? "check" : "read"],
            issuer,
            privateKey,
            now: now(),
            cache,
          });
          return `Bearer ${token}`;
        };
      }
      const http: Http = new Http({ fetch: deps.fetch, now, endpoints, timeoutMs, kind, authorization: (s) => authorization(s) });
      const ctx: Ctx = { kind, caps: GITHUB_CAPABILITIES[kind], limits: GITHUB_LIMITS, links, http, now };
      return {
        credential: kind,
        repos: repoOps(ctx),
        git: gitOps(ctx),
        pulls: pullOps(ctx),
        issues: issueOps(ctx),
        releases: releaseOps(ctx),
        checks: checkOps(ctx),
        cost: () => ({ ...http.spent }),
      };
    },
  };
}
