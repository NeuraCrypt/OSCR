// The GitHub side end to end, on this machine (night phase 01; docs/FORGE.md, "Local end-to-end
// run"): the Worker in `wrangler dev --env local` with its local D1 (oscr_community, oscr_forge), the
// sign-in mocks (tests/account/mock-server.ts) and the fake GitHub over HTTP
// (tests/forge/fake-github-server.ts). Real HTTP, redirects and cookies; D1's count of the rows each
// step writes (ACCOUNT_DEV_METRICS=1). Prints each check; exits 1 on a failure.
//
//   node --experimental-strip-types tests/forge-service/e2e.ts
//
// Not a unit test (no .test.ts): it needs the three servers running (tests/forge-service/e2e.sh).
import { createHash, createHmac } from "node:crypto";

const SITE = process.env.SITE ?? "http://localhost:8791";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9491";
const FAKE = process.env.FAKE ?? "http://127.0.0.1:9490";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "e2e-webhook-secret";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", body: JSON.stringify(body) });

type Json = Record<string, any>; // deno-lint-ignore no-explicit-any

/** A browser over real HTTP: a cookie jar for the site, redirects followed by hand. */
class Client {
  jar = new Map<string, string>();
  written = 0;

  private keep(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attributes] = c.split(";");
      const i = pair.indexOf("=");
      const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
      if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(pair.slice(0, i).trim());
      else this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const ours = url.startsWith(SITE);
    if (ours && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (ours) {
      this.keep(res);
      this.written = Number(res.headers.get("X-D1-Forge-Rows-Written") ?? 0);
    }
    return res;
  }

  async navigate(url: string): Promise<URL> {
    let current = url;
    for (let hops = 0; hops < 10; hops++) {
      const res = await this.request(current);
      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return new URL(current);
    }
    throw new Error(`too many redirects from ${url}`);
  }

  async me(): Promise<Json> {
    return (await this.request(`${SITE}/api/account/me`, { headers: { Accept: "application/json" } })).json();
  }

  async post(path: string, body: unknown): Promise<{ status: number; data: Json }> {
    const csrf = (await this.me()).csrf as string;
    const res = await this.request(`${SITE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: new URL(SITE).origin, "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Json };
  }

  /** One authorized action, as the page and the callback page do it: start, GitHub (the fake
   *  approves at once), act. */
  async act(kind: string, repo: unknown, payload: unknown, back = "/repositories/", on: { branch?: string; expectedHead?: string } = {}): Promise<{ start: number; status: number; data: Json; written: number }> {
    const text = JSON.stringify(payload);
    const digest = createHash("sha256").update(text).digest("hex");
    const s = await this.post("/api/forge/start", { kind, repo, branch: on.branch ?? null, expectedHead: on.expectedHead ?? null, digest, back });
    if (s.status !== 200) return { start: s.status, status: s.status, data: s.data, written: 0 };
    const landed = await this.navigate(String(s.data.location));
    const code = landed.searchParams.get("code");
    const state = landed.searchParams.get("state");
    const a = await this.post("/api/forge/act", { code, state, payload: text });
    return { start: 200, status: a.status, data: a.data, written: this.written };
  }
}

const seed = (await (await fetch(`${FAKE}/control/seed`)).json()) as { ada: { id: string }; bob: { id: string } };

// 0. Signed out: the reads ask for a session; the pages are static.
const anon = new Client();
check("signed out: GET /api/forge/mine is 401", (await anon.request(`${SITE}/api/forge/mine`)).status === 401);
for (const page of ["/new/", "/new/link/", "/repositories/", "/r/oscr-fixture/eeg-analysis/", "/r/oscr-fixture/eeg-analysis/settings/", "/hosting/limits/"]) {
  const res = await anon.request(`${SITE}${page}`);
  check(`GET ${page}: 200, a static page`, res.status === 200 && /text\/html/.test(res.headers.get("Content-Type") ?? ""), res.status);
}
// Phase 02: the code views are the same static shell (no Worker, no D1), and the tracing maps a
// static shard of 64, with the fixture's map and no paper text.
for (const page of [
  "/r/oscr-fixture/eeg-analysis/tree/main/docs/",
  "/r/oscr-fixture/eeg-analysis/blob/main/analysis.py",
  "/r/oscr-fixture/eeg-analysis/commits/main/",
  "/r/oscr-fixture/eeg-analysis/commit/main/",
  "/r/oscr-fixture/eeg-analysis/compare/main...main/",
  "/r/oscr-fixture/eeg-analysis/docs/",
  "/r/oscr-fixture/eeg-analysis/find/main/",
  "/r/oscr-fixture/eeg-analysis/search/?q=band",
]) {
  const res = await anon.request(`${SITE}${page}`);
  check(`GET ${page}: 200, the shell`, res.status === 200 && /text\/html/.test(res.headers.get("Content-Type") ?? ""), res.status);
}
{
  const shard = String(createHash("sha256").update("oscr-fixture/eeg-analysis").digest()[0] % 64).padStart(2, "0");
  const res = await anon.request(`${SITE}/forge/traced/${shard}.json`);
  const body = res.status === 200 ? ((await res.json()) as Record<string, { commit: string; pairs: Record<string, unknown>[] }[]>) : {};
  const maps = body["oscr-fixture/eeg-analysis"] ?? [];
  check(`GET /forge/traced/${shard}.json: the fixture's map, its links only`, maps.length === 1 && maps[0].pairs.length === 2 && maps[0].pairs.every((p) => !("evidence" in p) && !("text" in p)), JSON.stringify(maps).slice(0, 200));
}
const csp = (await anon.request(`${SITE}/r/oscr-fixture/eeg-analysis/`)).headers.get("Content-Security-Policy") ?? "";
check("the /r/ shell's CSP: scripts of the site only; GitHub's API and raw files to connect to", /script-src 'self'/.test(csp) && /connect-src 'self' https:\/\/api\.github\.com https:\/\/raw\.githubusercontent\.com/.test(csp), csp);

// 1. Ada signs in with GitHub (the mock names the double's own Ada).
await post(`${MOCK}/control`, { who: { github: { id: Number(seed.ada.id), login: "ada-fixture", name: "Ada Fixture" } } });
const ada = new Client();
let landed = await ada.navigate(`${SITE}/api/auth/github/start?return=/repositories/`);
check("Ada signed in with GitHub", landed.pathname === "/repositories/", landed.toString());
let mine = (await (await ada.request(`${SITE}/api/forge/mine`)).json()) as Json;
check("Your repositories: none yet", Array.isArray(mine.repositories) && mine.repositories.length === 0, mine);

// 2. Create a repository: start, GitHub, act.
const created = await ada.act("create", null, { name: "eeg-study", readme: true, gitignore: "Python", license: "mit", papers: ["10.5555/oscr.fixture.1"] }, "/new/");
check("create: done as Ada on GitHub", created.status === 200 && created.data.result?.page === "/r/ada-fixture/eeg-study/", created.data);
check("create: at most 6 rows written", created.written > 0 && created.written <= 6, created.written);
check("create: the sentence confirmed", /^Create the public repository eeg-study in your GitHub account/.test(String(created.data.sentence)), created.data.sentence);
check("create: no token in the answer", !/gh[opsu]_|memtok|token/i.test(JSON.stringify(created.data)), created.data);

// 3. Link the fixture's repository (Ada administers the organization): public, no App.
const linked = await ada.act("link", { forge: "github", owner: "oscr-fixture", name: "eeg-analysis" }, { repository: "oscr-fixture/eeg-analysis", papers: ["10.5555/oscr.fixture.1"] }, "/new/link/");
check("link: done, mode public (no installation)", linked.status === 200 && linked.data.result?.mode === "public", linked.data);
check("link: at most 5 rows written", linked.written > 0 && linked.written <= 5, linked.written);
const layer = (await (await ada.request(`${SITE}/api/forge/repo?path=oscr-fixture/eeg-analysis`)).json()) as Json;
check("GET /api/forge/repo: the layer, with its paper", layer.mode === "public" && layer.papers?.length === 1, layer);
mine = (await (await ada.request(`${SITE}/api/forge/mine`)).json()) as Json;
check("Your repositories: the created one", mine.repositories?.some((r: Json) => r.name === "eeg-study"), mine.repositories?.map((r: Json) => r.name));
const id = String(linked.data.result?.id);

// 4. Settings and branches on the linked repository.
const topics = await ada.act("topics", { forge: "github", id }, { topics: ["eeg", "neuroscience", "open-science"] }, "/r/oscr-fixture/eeg-analysis/settings/");
check("topics: done, the action row only", topics.status === 200 && topics.written === 1, [topics.status, topics.written, topics.data]);
const branch = await ada.act("branch_create", { forge: "github", id }, { name: "e2e-branch", from: "main" }, "/r/oscr-fixture/eeg-analysis/branches/");
check("branch_create: done", branch.status === 200 && branch.data.result?.name === "e2e-branch", branch.data);
const noDefault = await ada.act("branch_delete", { forge: "github", id }, { name: "main" });
check("branch_delete of the default branch: refused before GitHub", noDefault.status === 400 && noDefault.data.error?.code === "default_branch", noDefault.data);
const autolink = await ada.act("autolink_create", { forge: "github", id }, { keyPrefix: "RRID:SCR_", urlTemplate: "https://scicrunch.org/resolver/RRID:SCR_<num>", isAlphanumeric: false });
check("autolink_create: done", autolink.status === 200 && autolink.data.result?.autolink?.keyPrefix === "RRID:SCR_", autolink.data);

// 4b. Phase 03: web commits through the fake GitHub (one commit made by GitHub as Ada, the
// compare-and-swap on the head the page saw, a new branch at that head).
for (const page of [
  "/r/oscr-fixture/eeg-analysis/edit/main/analysis.py",
  "/r/oscr-fixture/eeg-analysis/new/main/docs/",
  "/r/oscr-fixture/eeg-analysis/upload/main/",
  "/r/oscr-fixture/eeg-analysis/delete/main/docs/methods.md",
]) {
  const res = await anon.request(`${SITE}${page}`);
  check(`GET ${page}: 200, the shell`, res.status === 200 && /text\/html/.test(res.headers.get("Content-Type") ?? ""), res.status);
}
const headOf = async () => String(((await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/branches/main`)).json()) as Json).commit?.sha ?? "");
const rawAt = async (ref: string, path: string) => (await fetch(`${FAKE}/raw/oscr-fixture/eeg-analysis/${ref}/${path}`)).text();
const seen = await headOf();
const readme = `${await rawAt(seen, "README.md")}\nEdited in the registry's own editor.\n`;
const edit = { branch: "main", base: seen, message: "Say where the README was edited", propose: false, changes: [{ op: "put", path: "README.md", text: readme }] };
const committed = await ada.act("commit", { forge: "github", id }, edit, "/r/oscr-fixture/eeg-analysis/edit/main/README.md", { branch: "main", expectedHead: seen });
const after1 = await headOf();
check("commit: an edit committed through the fake GitHub, as Ada", committed.status === 200 && committed.data.result?.sha === after1 && after1 !== seen, committed.data);
check("commit: the action row only (1 row)", committed.written === 1, committed.written);
check("commit: the file changed on the branch", (await rawAt("main", "README.md")) === readme);
check("commit: the answer links the registry's own viewer", Array.isArray(committed.data.result?.links) && committed.data.result.links.every((l: Json) => String(l.href).startsWith("/r/oscr-fixture/eeg-analysis/")), committed.data.result?.links);
check("commit: the sentence confirmed", committed.data.sentence === "Commit “Say where the README was edited” to the branch main (1 file written)", committed.data.sentence);
const stale = await ada.act("commit", { forge: "github", id }, { ...edit, message: "Too late", changes: [{ op: "put", path: "README.md", text: "stale\n" }] }, "/r/oscr-fixture/eeg-analysis/edit/main/README.md", { branch: "main", expectedHead: seen });
check("commit: a branch that moved is refused (409, offer new_branch), nothing written", stale.status === 409 && stale.data.error?.code === "conflict" && stale.data.error?.offer === "new_branch" && stale.written === 0, [stale.status, stale.data, stale.written]);
check("commit: the branch as it was after the first commit", (await headOf()) === after1);
const branched = await ada.act("commit", { forge: "github", id }, { ...edit, message: "The same change, on its own branch", newBranch: "ada-patch-1", changes: [{ op: "put", path: "README.md", text: "stale\n" }] }, "/r/oscr-fixture/eeg-analysis/edit/main/README.md", { branch: "main", expectedHead: seen });
const patchHead = String(((await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/branches/ada-patch-1`)).json()) as Json).commit?.sha ?? "");
check("commit: a new branch at the head the page saw, the change on it", branched.status === 200 && branched.data.result?.branch === "ada-patch-1" && patchHead === branched.data.result?.sha && (await rawAt("ada-patch-1", "README.md")) === "stale\n", branched.data);
check("commit: the new branch's comparison and phase 04's pull request hook", branched.data.result?.compare === "/r/oscr-fixture/eeg-analysis/compare/main...ada-patch-1/" && branched.data.result?.pullRequest?.head === "ada-patch-1", branched.data.result);
check("commit: main untouched by the new branch", (await headOf()) === after1);
const moved = await ada.act("commit", { forge: "github", id }, { branch: "main", base: after1, message: "Move the docs", propose: false, changes: [{ op: "move", from: "docs/methods.md", to: "docs/methods/index.md" }] }, "/r/oscr-fixture/eeg-analysis/", { branch: "main", expectedHead: after1 });
check("commit: a move through the Git data API", moved.status === 200 && (await rawAt("main", "docs/methods/index.md")).length > 0, moved.data);

// 5. Webhooks: GitHub's signature, an installation, a push.
async function deliver(event: string, payload: Json, secret = WEBHOOK_SECRET): Promise<{ status: number; data: Json; written: number }> {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const res = await fetch(`${SITE}/api/forge/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": crypto.randomUUID(), "X-Hub-Signature-256": sig },
    body,
  });
  return { status: res.status, data: (await res.json()) as Json, written: Number(res.headers.get("X-D1-Forge-Rows-Written") ?? 0) };
}
const repoJson = await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis`)).json();
const installation = { id: 777, account: { login: "oscr-fixture", id: repoJson.owner.id, type: "Organization" }, repository_selection: "all" };
const bad = await deliver("installation", { action: "created", installation, sender: { login: "ada-fixture", id: Number(seed.ada.id) } }, "not-the-secret");
check("webhook: a bad signature is 401", bad.status === 401, bad);
const inst = await deliver("installation", { action: "created", installation, sender: { login: "ada-fixture", id: Number(seed.ada.id) } });
check("webhook: an installation recorded, 2 rows", inst.status === 200 && inst.written === 2, inst);
const pushedAt = Math.floor(Date.now() / 1000);
const push = await deliver("push", {
  ref: "refs/heads/main",
  before: "0".repeat(40),
  after: "a".repeat(40),
  created: false,
  deleted: false,
  forced: false,
  repository: { id: Number(id), name: "eeg-analysis", full_name: "oscr-fixture/eeg-analysis", owner: { login: "oscr-fixture", id: repoJson.owner.id }, visibility: "public", default_branch: "main", pushed_at: pushedAt },
  pusher: { name: "ada-fixture", email: "ada.fixture@example.org" },
  sender: { login: "ada-fixture", id: Number(seed.ada.id) },
  installation: { id: 777 },
  commits: [],
});
check("webhook: a push moves the head (≤ 2 rows)", push.status === 200 && push.written >= 1 && push.written <= 2, push);
const after = (await (await ada.request(`${SITE}/api/forge/repo?id=github:${id}`)).json()) as Json;
check("the layer shows the push", after.headAt === pushedAt && after.head === "a".repeat(40), [after.head, after.headAt]);

// 6. FORGE_OPEN unset: Bob may read, not act.
await post(`${MOCK}/control`, { who: { github: { id: Number(seed.bob.id), login: "bob-fixture", name: "Bob Fixture" } } });
await post(`${FAKE}/control`, { login: "bob-fixture" });
const bob = new Client();
landed = await bob.navigate(`${SITE}/api/auth/github/start?return=/repositories/`);
check("Bob signed in with GitHub", landed.pathname === "/repositories/", landed.toString());
const closed = await bob.act("create", null, { name: "bobs-repo" });
check("FORGE_OPEN unset: Bob's action is refused at start (403 forge_closed)", closed.start === 403 && closed.data.error?.code === "forge_closed", closed.data);
const bobHead = String(((await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/branches/main`)).json()) as Json).commit?.sha ?? "");
const bobCommit = await bob.act("commit", { forge: "github", id }, { branch: "main", base: bobHead, message: "Bob's", propose: true, changes: [{ op: "put", path: "b.txt", text: "b\n" }] }, "/r/oscr-fixture/eeg-analysis/", { branch: "main", expectedHead: bobHead });
check("FORGE_OPEN unset: Bob's commit is refused at start too", bobCommit.start === 403 && bobCommit.data.error?.code === "forge_closed", bobCommit.data);
const bobMine = await bob.request(`${SITE}/api/forge/mine`);
check("Bob may still read his dashboard", bobMine.status === 200, bobMine.status);
await post(`${FAKE}/control`, { login: "ada-fixture" });

console.log(failures ? `${failures} check(s) failed` : "every check passed");
process.exit(failures ? 1 : 0);
