// Test support: one authorized action driven end to end, the way a browser and a person do it
// (the design's §10.2): the page's start (src/lib/forge.ts `apiStart`: the declaration and the
// payload's exact text), POST /api/forge/start, the person approving on the double's GitHub
// (`backend.authorize(location, login)`), then POST /api/forge/act with {code, state, payload}.
// Reused by the action elements (E2–E5): `authorize(w, b, {kind, repo, payload})`.
//
// Also: `signIn` (a browser signed in with GitHub as a given person of the double), `fakeAction`
// (a spec to register through deps.actions), and `watchAuth` (the tokens the double issued, and
// every revocation asked).
import { ACT_PATH, apiStart, START_PATH, type StartInput } from "../../src/lib/forge.ts";
import { registry } from "../../worker/forge/service/actions.ts";
import { insertRepo } from "../../worker/forge/service/store.ts";
import { ForgeProblem, type ActionRegistry, type AnyActionSpec } from "../../worker/forge/service/types.ts";
import { SEGMENT } from "../../worker/forge/paths.ts";
import { ADA_LOGIN, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const bodyOf = async (res: Response): Promise<Json> => (await res.clone().json().catch(() => ({}))) as Json;

/** A browser signed in with GitHub as `login`, a person of the double (added when new): the mock
 *  GitHub sign-in names the same numeric id as the double's GitHub. */
export async function signIn(w: ForgeWorld, login = ADA_LOGIN): Promise<ForgeBrowser> {
  const account = [...w.backend.accounts.values()].find((a) => a.login === login) ?? w.backend.addUser(login).user;
  w.mock.who.github = { id: Number(account.id), login, name: login };
  const b = w.browser();
  await b.signIn("github");
  return b;
}

/** The numeric id of a person of the double. */
export function githubId(w: ForgeWorld, login: string): string {
  const account = [...w.backend.accounts.values()].find((a) => a.login === login) ?? w.backend.addUser(login).user;
  return account.id;
}

export interface Authorized {
  start: Response;
  startBody: Json;
  /** Where start sent the browser (GitHub's page), or null when it refused. */
  location: string | null;
  code: string | null;
  state: string | null;
  /** The act's answer, or null when start refused. */
  act: Response | null;
  actBody: Json | null;
  /** The payload's exact text the page kept. */
  payload: string;
}

export interface AuthorizeOptions {
  /** Who approves on GitHub (default: Ada). */
  login?: string;
  /** Change the act's body before it is sent (a wrong state, another payload…). */
  editAct?: (body: { code: string; state: string; payload: string }) => unknown;
  /** Called between GitHub and act (the clock moves, the environment changes…). */
  between?: () => void | Promise<void>;
}

/** POST /api/forge/start with the page's own declaration of `input`. */
export async function start(b: ForgeBrowser, input: StartInput): Promise<{ res: Response; body: Json; payload: string }> {
  const { body, payload } = await apiStart(input);
  const res = await b.post(START_PATH, body);
  return { res, body: await bodyOf(res), payload };
}

/** POST /api/forge/act with {code, state, payload}. */
export async function act(b: ForgeBrowser, body: unknown): Promise<{ res: Response; body: Json }> {
  const res = await b.post(ACT_PATH, body);
  return { res, body: await bodyOf(res) };
}

/** One authorized action: start, the person approving on GitHub, act. */
export async function authorize(w: ForgeWorld, b: ForgeBrowser, input: StartInput, opts: AuthorizeOptions = {}): Promise<Authorized> {
  const s = await start(b, input);
  const out: Authorized = { start: s.res, startBody: s.body, location: null, code: null, state: null, act: null, actBody: null, payload: s.payload };
  if (s.res.status !== 200) return out;
  out.location = String(s.body.location);
  const { code, state } = w.backend.authorize(out.location, opts.login ?? ADA_LOGIN);
  out.code = code;
  out.state = state;
  await opts.between?.();
  const plain = { code, state, payload: s.payload };
  const a = await act(b, opts.editAct ? opts.editAct(plain) : plain);
  out.act = a.res;
  out.actBody = a.body;
  return out;
}

/** The tokens the double issued through the exchange, and every revocation asked. */
export function watchAuth(w: ForgeWorld): { issued: string[]; revoked: string[] } {
  const seen = { issued: [] as string[], revoked: [] as string[] };
  const auth = w.backend.auth as { exchange: typeof w.backend.auth.exchange; revoke: typeof w.backend.auth.revoke };
  const exchange = auth.exchange.bind(auth);
  const revoke = auth.revoke.bind(auth);
  auth.exchange = async (input) => {
    const t = await exchange(input);
    seen.issued.push(t.token);
    return t;
  };
  auth.revoke = async (token) => {
    seen.revoked.push(token);
    return revoke(token);
  };
  return seen;
}

/** A fake action for the tests: by default the kind "create", which creates a public repository in
 *  the person's own account as the person, and records it (repos: 2 rows). `overrides` replace any
 *  part of the spec. The context each perform got is kept in `seen`. */
export function fakeAction(overrides: Partial<AnyActionSpec> = {}): AnyActionSpec & { seen: unknown[] } {
  const seen: unknown[] = [];
  const spec: AnyActionSpec & { seen: unknown[] } = {
    kind: "create",
    needsRepo: false,
    seen,
    validate(payload: unknown) {
      const p = payload as { name?: unknown } | null;
      if (!p || typeof p !== "object" || typeof p.name !== "string" || !SEGMENT.test(p.name)) {
        return new ForgeProblem(400, "bad_payload", "The repository's name is missing.");
      }
      return { name: p.name };
    },
    describe: (parsed: { name: string }) => `Create the public repository ${parsed.name}`,
    async perform(ctx) {
      seen.push(ctx);
      const info = await ctx.session.repos.create({ name: ctx.parsed.name, visibility: "public", autoInit: true });
      const writes = [
        insertRepo(
          ctx.db,
          {
            forge: info.key.forge,
            repoId: info.key.id,
            ownerId: info.owner.id,
            ownerLogin: info.owner.login,
            name: info.ref.name,
            mode: "created",
            defaultBranch: info.defaultBranch,
            linkedBy: ctx.user.id,
          },
          ctx.t,
        ),
      ];
      return { result: { id: info.key.id, owner: info.ref.owner, name: info.ref.name }, writes, repo: { forge: info.key.forge, repoId: info.key.id } };
    },
    check: (result: { name: string }, parsed: { name: string }) => result.name === parsed.name,
    ...overrides,
  };
  return spec;
}

/** A registry of these specs, for deps.actions. */
export const actions = (...specs: AnyActionSpec[]): ActionRegistry => registry(specs);
