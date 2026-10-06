// A person's authorization of one action, through OSCR's GitHub App (the user-to-server flow,
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
//
// - Authorization URL: {web}/login/oauth/authorize?client_id=…&redirect_uri=…&state=…
//   &code_challenge=…&code_challenge_method=S256. A GitHub App takes no `scope`: its permissions
//   are the App's.
// - Exchange: POST {web}/login/oauth/access_token, as a form, Accept: application/json, with
//   client_id, client_secret, code, redirect_uri and code_verifier, server to server (the client
//   secret never leaves the Worker). The answer carries access_token and expires_in (8 hours);
//   the refresh token is dropped, unused. GitHub answers a refused code with 200 and an `error`
//   field: `unauthorized`.
// - Who: GET {api}/user; only `id` and `login` are read, never the name or the email address.
// - Revocation: DELETE {api}/applications/{client_id}/token, Basic client_id:client_secret, JSON
//   {"access_token": "…"}: 204. The forge service runs it after the action, in
//   ctx.waitUntil(auth.revoke(token).catch(…)); a token already gone (404) is not an error.
// - Installations the person can see: GET /user/installations and
//   /user/installations/{id}/repositories (user tokens), each repository with the person's own
//   permission (the linking page of the mirror mode).
// - Installation page: {web}/apps/{slug}/installations/new?state=…. The App is set to "Request
//   user authorization (OAuth) during installation", so the return can already carry a code.
// - The CLI (phase 14) uses the device flow on its own: the token goes to the researcher's
//   keychain and never touches OSCR.
// Without the App's client id and secret (Cloudflare secrets), every method is `unsupported`
// ("the GitHub App is not set up yet"). No token is ever written in a message or a URL.

import { GitBackendError, invalid } from "../errors.ts";
import type { ForgeAuth } from "../gitbackend.ts";
import type * as T from "../types.ts";
import { type Endpoints, Http, nextPage, readJson, restPage } from "./http.ts";
import * as map from "./map.ts";

export const NOT_SET_UP = "the GitHub App is not set up yet";

export function checkToken(token: unknown): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_.~+/=-]{1,512}$/.test(token)) throw new GitBackendError("unauthorized", "not a token");
  return token;
}

function checkRedirect(uri: unknown): string {
  if (typeof uri !== "string" || uri.length > 500) throw invalid("not a redirect address");
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw invalid("not a redirect address");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.hash) throw invalid("not a redirect address");
  return uri;
}

const BASE64URL = /^[A-Za-z0-9_-]{16,256}$/;

export function githubAuth(o: {
  endpoints: Endpoints;
  clientId?: string;
  clientSecret?: string;
  appSlug?: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
}): ForgeAuth {
  const http = new Http({ fetch: o.fetch, now: o.now, endpoints: o.endpoints, timeoutMs: o.timeoutMs, kind: "user", authorization: async () => null });
  const client = (): { id: string; secret: string } => {
    if (!o.clientId || !o.clientSecret) throw new GitBackendError("unsupported", NOT_SET_UP);
    return { id: o.clientId, secret: o.clientSecret };
  };
  const bearer = (token: string) => `Bearer ${checkToken(token)}`;

  return {
    authorizeUrl(input) {
      const { id } = client();
      if (typeof input?.state !== "string" || !BASE64URL.test(input.state)) throw invalid("not a state");
      if (typeof input.codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) throw invalid("not a PKCE challenge");
      const u = new URL(`${o.endpoints.web}/login/oauth/authorize`);
      u.searchParams.set("client_id", id);
      u.searchParams.set("redirect_uri", checkRedirect(input.redirectUri));
      u.searchParams.set("state", input.state);
      u.searchParams.set("code_challenge", input.codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async exchange(input) {
      const { id, secret } = client();
      if (typeof input?.code !== "string" || !/^[A-Za-z0-9_.-]{1,200}$/.test(input.code)) throw new GitBackendError("unauthorized", "not a code");
      if (typeof input.codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) throw invalid("not a PKCE verifier");
      const form = new URLSearchParams({
        client_id: id,
        client_secret: secret,
        code: input.code,
        redirect_uri: checkRedirect(input.redirectUri),
        code_verifier: input.codeVerifier,
      });
      const answer = map.obj(
        await http.json({ method: "POST", base: "web", path: "/login/oauth/access_token", body: form, contentType: "application/x-www-form-urlencoded", accept: "application/json", authorization: null }),
        "token",
      );
      if (answer.error !== undefined) throw new GitBackendError("unauthorized", "the forge refused the code");
      const token = map.str(answer, "access_token");
      const expiresIn = map.optNum(answer, "expires_in");
      return { token: checkToken(token), expiresAt: expiresIn === null ? null : o.now() + expiresIn };
    },

    async whoAmI(token) {
      const me = map.obj(await http.json({ path: "/user", authorization: bearer(token) }), "user");
      return { id: map.id(me), login: map.str(me, "login") };
    },

    async revoke(token) {
      const { id, secret } = client();
      await http.send({
        method: "DELETE",
        path: `/applications/${encodeURIComponent(id)}/token`,
        json: { access_token: checkToken(token) },
        authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        ok: [404],
        label: "DELETE /applications/{client_id}/token",
      });
    },

    installUrl(state) {
      if (!o.appSlug) throw new GitBackendError("unsupported", NOT_SET_UP);
      if (typeof state !== "string" || !BASE64URL.test(state)) throw invalid("not a state");
      return `${o.endpoints.web}/apps/${encodeURIComponent(o.appSlug)}/installations/new?${new URLSearchParams({ state })}`;
    },

    async installations(token, page) {
      const p = restPage(page);
      const res = await http.send({ path: "/user/installations", query: { per_page: p.perPage, page: p.page }, authorization: bearer(token) });
      const answer = map.obj(await readJson(res), "installations");
      return { items: map.list(answer.installations, "installations").map(map.installation), next: nextPage(res, p.page) };
    },

    async installationRepositories(token, installationId, page) {
      if (typeof installationId !== "string" || !/^\d{1,20}$/.test(installationId)) throw invalid("not an installation id");
      const p = restPage(page);
      const res = await http.send({
        path: `/user/installations/${installationId}/repositories`,
        query: { per_page: p.perPage, page: p.page },
        authorization: bearer(token),
      });
      const answer = map.obj(await readJson(res), "repositories");
      return {
        items: map.list(answer.repositories, "repositories").map((r) => ({
          ...map.stub(r),
          permission: (map.permissionOf(map.obj(r, "repository").permissions) ?? "none") as T.Permission,
        })),
        next: nextPage(res, p.page),
      };
    },
  };
}
