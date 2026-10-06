// The contract (contract.ts) on the GitHub adapter itself: githubBackend(…, { fetch: fake.fetch }),
// where the fake GitHub (fake-github.ts) answers from a MemoryBackend's state in GitHub's shapes.
// Every request the adapter writes, every answer it maps and every error it classifies is then
// checked against the same cases as the double.
import { createHmac, generateKeyPairSync } from "node:crypto";
import { githubBackend } from "../../worker/forge/github/index.ts";
import { utf8 } from "../../worker/forge/objects.ts";
import type * as T from "../../worker/forge/types.ts";
import { type Harness, type Person, runContract } from "./contract.ts";
import { FakeGitHub } from "./fake-github.ts";
import { MemoryBackend } from "./memory.ts";

const CLIENT = { id: "Iv23liFAKECLIENT", secret: "fake-client-secret" };
const SECRET = "fake-webhook-secret";
const TREE_ENTRIES = 8;
const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

/** The double's events as GitHub's: the same, with GitHub as their forge. */
function asGitHub<V>(v: V): V {
  if (Array.isArray(v)) return v.map(asGitHub) as V;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = k === "forge" && x === "memory" ? "github" : asGitHub(x);
  return out as V;
}

const memory = (r: T.RepoRef): T.RepoRef => ({ ...r, forge: "memory" });

async function harness(): Promise<Harness> {
  const double = new MemoryBackend({ limits: { treeEntries: TREE_ENTRIES } });
  const fake = new FakeGitHub(double, CLIENT);
  const backend = githubBackend(
    { clientId: CLIENT.id, clientSecret: CLIENT.secret, appSlug: "code-registry", appId: "1", privateKey: KEY, webhookSecret: SECRET },
    { fetch: fake.fetch, now: () => double.now(), tokenCache: new Map() },
  );
  const person = (login: string): Person => ({ login, token: double.addUser(login).token() });
  const owner = person("ada-owner");
  const collaborator = person("bo-collaborator");
  const stranger = person("cy-stranger");
  const installationId = double.install(owner.login);
  double.events();
  return {
    backend,
    owner,
    collaborator,
    stranger,
    installationId,
    webhookSecret: SECRET,
    treeEntries: TREE_ENTRIES,
    releaseAssetBytes: backend.limits.releaseAssetBytes,
    now: () => double.now(),
    async seed(spec) {
      const s = backend.session({ kind: "user", token: (spec.as ?? owner).token });
      const repo = await s.repos.create({ name: spec.name, visibility: "public", autoInit: true, description: spec.description });
      const files = Object.entries(spec.files ?? {});
      if (files.length) {
        const head = await s.git.resolve(repo.ref, "main");
        const changes: T.FileChange[] = files.map(([path, c]) => ({ op: "put", path, content: typeof c === "string" ? utf8(c) : c }));
        await s.git.createCommit(repo.ref, { branch: "main", expectedHead: head, changes, message: "Add the files" });
      }
      double.grant(memory(repo.ref), collaborator.login, "write");
      return s.repos.get(repo.ref);
    },
    grant: async (repo, login, permission) => double.grant(memory(repo), login, permission),
    acceptTransfer: async (key) => double.acceptTransfer(key.id),
    authorize: async (url, login) => double.authorize(url, login),
    events: () => asGitHub(double.events()),
    async deliver(event) {
      const { event: name, payload } = FakeGitHub.payload(event);
      const body = utf8(JSON.stringify(payload));
      const headers = new Headers({
        "Content-Type": "application/json",
        "X-GitHub-Event": name,
        "X-GitHub-Delivery": event.delivery,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      });
      return { headers, body };
    },
    setStatus: async (repo, sha, context, state) => double.setStatus(memory(repo), sha, context, state),
    limit: (kind, remaining, resetAt) => double.limit(kind, remaining, resetAt),
  };
}

runContract("the GitHub adapter, on a fake GitHub", harness);
