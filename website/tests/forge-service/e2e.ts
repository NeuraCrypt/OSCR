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

// Phase 07, after the Mac's forge poll (e2e.sh runs it between the two): the tracing map versioned
// with the release, and the deposit of its validated map on the MOCK Zenodo sandbox — never a real one.
const STATE_FILE = process.env.E2E_STATE ?? "";
if (process.argv[2] === "after-mac") {
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { jar: [string, string][]; id: string; tag: string };
  const ada = new Client();
  ada.jar = new Map(saved.jar);
  const layer = (await (await ada.request(`${SITE}/api/forge/repo?id=github:${saved.id}`)).json()) as Json;
  const answered = (layer.answered ?? []) as Json[];
  const release = answered.find((a) => a.kind === "release" && a.ref === saved.tag);
  check("the Mac versioned the paper's tracing map with the release", release?.outcome === "done" && /is versioned with the release/.test(String(release?.message)), answered);
  const deposit = answered.find((a) => a.kind === "deposit" && a.ref === saved.tag);
  check("the Mac deposited the release's validated map on Zenodo's sandbox (the mock), a DOI said", deposit?.outcome === "done" && /deposited on Zenodo \(sandbox\): DOI 10\.5072\//.test(String(deposit?.message)), deposit);
  const tie = ((layer.releaseTies ?? []) as Json[]).find((t) => t.tag === saved.tag);
  check("the tie holds the map's digest the Mac versioned", /^[0-9a-f]{64}$/.test(String(tie?.shown)), tie);
  const log = (await (await fetch(`${MOCK}/control/log`)).json()) as Json;
  const calls = (log.zenodo ?? []) as string[];
  // The fixture's map has a DOI already: the release's validated map is a new version of its record.
  check("Zenodo was the local mock only: a new version of the map's record, its file, the publication", calls.some((c) => /^POST \/api\/records(\/[^/]+\/versions)?$/.test(c)) && calls.some((c) => /\/content$/.test(c)) && calls.some((c) => /\/actions\/publish$/.test(c)), calls);
  const deposits = ((await (await fetch(`${MOCK}/control/zenodo`)).json().catch(() => [])) ?? []) as Json[];
  const meta = deposits.map((d) => d.metadata as Json).find((m) => m?.version === saved.tag);
  check("the record: the release's tag as its version; IsSupplementTo the paper; References the release's code", !!meta && JSON.stringify(meta.related_identifiers).includes("issupplementto") && JSON.stringify(meta.related_identifiers).includes("/tree/"), meta ? { version: meta.version, related: meta.related_identifiers } : deposits.length);
  check("the code itself was not deposited: the record holds the map only", !!meta && /holds the map only/.test(String(meta.description)), meta?.description);
  console.log(failures ? `${failures} check(s) failed` : "every check passed");
  process.exit(failures ? 1 : 0);
}

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

// 4c. Phase 04: pull requests through the fake GitHub — open one, comment on a line with a
// suggestion, apply it (a commit on the pull request's branch), a merge at a head that moved refused,
// the merge, and a second pull request refused on its conflict.
for (const page of [
  "/r/oscr-fixture/eeg-analysis/pulls/",
  "/r/oscr-fixture/eeg-analysis/pull/2",
  "/r/oscr-fixture/eeg-analysis/pull/2/files",
  "/r/oscr-fixture/eeg-analysis/pull/2/conflicts",
  "/r/oscr-fixture/eeg-analysis/fork/",
  "/r/oscr-fixture/eeg-analysis/forks/",
]) {
  const res = await anon.request(`${SITE}${page}`);
  check(`GET ${page}: 200, the shell`, res.status === 200 && /text\/html/.test(res.headers.get("Content-Type") ?? ""), res.status);
}
{
  const branchHead = async (b: string) => String(((await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/branches/${b}`)).json()) as Json).commit?.sha ?? "");
  const start = await headOf();
  const analysis = await rawAt(start, "analysis.py");
  const line = "    f, pxx = welch(x, fs=fs, nperseg=2 * fs)";
  check("pulls: analysis.py has the line the map links", analysis.includes(line));
  const onBranch = async (branch: string, text: string, message: string) =>
    ada.act("commit", { forge: "github", id }, { branch: "main", base: start, newBranch: branch, message, propose: false, changes: [{ op: "put", path: "analysis.py", text }] }, "/r/oscr-fixture/eeg-analysis/", { branch: "main", expectedHead: start });
  const welch = await onBranch("e2e-welch", analysis.replace(line, `${line.slice(0, -1)}, window="hann")`), "Use a Hann window");
  const clash = await onBranch("e2e-clash", analysis.replace(line, `${line.slice(0, -1)}, window="boxcar")`), "Use a boxcar window");
  check("pulls: two branches from the same main", welch.status === 200 && clash.status === 200, [welch.data, clash.data]);
  const open = (head: string, title: string) => ada.act("pull_open", { forge: "github", id }, { base: "main", head, title, body: "Fixes #1." }, "/r/oscr-fixture/eeg-analysis/pulls", { branch: "main" });
  const a = await open("e2e-welch", "Use a Hann window (e2e)");
  check("pull_open: a pull request opened as Ada, the action row only", a.status === 200 && Number.isInteger(a.data.result?.number) && a.written === 1, [a.status, a.data, a.written]);
  check("pull_open: its page in the registry", a.data.result?.page === `/r/oscr-fixture/eeg-analysis/pull/${a.data.result?.number}`, a.data.result?.page);
  check("pull_open: no token in the answer", !/gh[opsu]_|memtok|token/i.test(JSON.stringify(a.data)), a.data);
  const b = await open("e2e-clash", "Use a boxcar window (e2e)");
  check("pull_open: a second one, on the same lines", b.status === 200, b.data);
  const na = Number(a.data.result?.number);
  const nb = Number(b.data.result?.number);
  const headA = await branchHead("e2e-welch");
  const lineNo = (await rawAt(headA, "analysis.py")).split("\n").findIndex((l) => l.includes('window="hann"')) + 1;
  const suggestion = `Say which paragraph this follows:\n\`\`\`suggestion\n${line.slice(0, -1)}, window="hann")  # Methods\n\`\`\``;
  const review = await ada.act("pull_review", { forge: "github", id }, { number: na, commit: headA, event: "COMMENT", comments: [{ path: "analysis.py", line: lineNo, side: "RIGHT", body: suggestion }] }, `/r/oscr-fixture/eeg-analysis/pull/${na}/files`);
  check("pull_review: a comment on a line, with a suggestion, the action row only", review.status === 200 && review.data.result?.comments === 1 && review.written === 1, [review.status, review.data, review.written]);
  const comments = (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/pulls/${na}/comments`)).json()) as Json[];
  check("pull_review: GitHub holds the comment on its line", comments.length === 1 && comments[0].line === lineNo && /```suggestion/.test(String(comments[0].body)), comments.map((c) => [c.line, c.path]));
  // The page applies it: the head's file with the suggestion's lines, one commit on the branch.
  const { applySuggestions, suggestionOf } = await import("../../src/lib/pulls.ts");
  const sug = suggestionOf({ id: String(comments[0].id), path: "analysis.py", line: lineNo, startLine: null, side: "RIGHT", body: String(comments[0].body), author: { name: "ada-fixture", login: "ada-fixture", id: seed.ada.id } });
  const applied = sug && typeof sug === "object" ? applySuggestions(await rawAt(headA, "analysis.py"), [sug]) : null;
  check("suggestion: read and applied in the page", typeof applied === "string" && applied.includes("# Methods"), applied);
  const commit = await ada.act("commit", { forge: "github", id }, { branch: "e2e-welch", base: headA, message: "Apply suggestion from code review", propose: false, changes: [{ op: "put", path: "analysis.py", text: applied }] }, `/r/oscr-fixture/eeg-analysis/pull/${na}/files`, { branch: "e2e-welch", expectedHead: headA });
  const headA2 = await branchHead("e2e-welch");
  check("suggestion: applied as one commit on the pull request's branch", commit.status === 200 && commit.data.result?.sha === headA2 && (await rawAt(headA2, "analysis.py")).includes("# Methods"), commit.data);
  const stale = await ada.act("pull_merge", { forge: "github", id }, { number: na, method: "squash", head: headA }, `/r/oscr-fixture/eeg-analysis/pull/${na}`, { expectedHead: headA });
  check("pull_merge: at a head that moved, refused (409, offer reload), nothing written", stale.status === 409 && stale.data.error?.offer === "reload" && stale.written === 0, [stale.status, stale.data, stale.written]);
  const merged = await ada.act("pull_merge", { forge: "github", id }, { number: na, method: "squash", head: headA2, deleteBranch: true }, `/r/oscr-fixture/eeg-analysis/pull/${na}`, { expectedHead: headA2 });
  check("pull_merge: squashed by GitHub as Ada, the branch deleted, the action row only", merged.status === 200 && merged.data.result?.sha === (await headOf()) && merged.data.result?.branchDeleted === true && merged.written === 1, [merged.status, merged.data, merged.written]);
  check("pull_merge: main has the suggestion", (await rawAt("main", "analysis.py")).includes('window="hann")  # Methods'));
  const headB = await branchHead("e2e-clash");
  const conflict = await ada.act("pull_merge", { forge: "github", id }, { number: nb, method: "merge", head: headB }, `/r/oscr-fixture/eeg-analysis/pull/${nb}`, { expectedHead: headB });
  check("pull_merge: a conflict is refused (409, offer conflicts), nothing merged, nothing written", conflict.status === 409 && conflict.data.error?.code === "not_mergeable" && conflict.data.error?.offer === "conflicts" && conflict.written === 0, [conflict.status, conflict.data, conflict.written]);
  const pr = (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/pulls/${nb}`)).json()) as Json;
  check("pull_merge: the conflicting one still open", pr.state === "open" && pr.merged !== true, [pr.state, pr.merged]);
}

// 4d. Phase 05: issues. The pages are the /r/ shell and the /research/ shell; a GitHub issue opened,
// labelled, commented and closed with a reason through the fake GitHub; a research issue (a
// code–paper mismatch) opened, labelled, commented and closed with a resolution, in the registry's
// own D1 (3, 2 and 2 rows); a second one closed by the merge of a pull request that says it fixes it.
for (const page of [
  "/r/oscr-fixture/eeg-analysis/issues/",
  "/r/oscr-fixture/eeg-analysis/issues/3",
  "/r/oscr-fixture/eeg-analysis/issues/new/choose",
  "/r/oscr-fixture/eeg-analysis/labels/",
  "/r/oscr-fixture/eeg-analysis/milestones/",
  "/r/oscr-fixture/eeg-analysis/milestone/1",
  "/research/1",
  "/research/new?type=mismatch&doi=10.5555/oscr.fixture.1",
]) {
  const res = await anon.request(`${SITE}${page}`);
  check(`GET ${page}: 200, a shell`, res.status === 200 && /text\/html/.test(res.headers.get("Content-Type") ?? ""), res.status);
}
{
  const researchCsp = (await anon.request(`${SITE}/research/1`)).headers.get("Content-Security-Policy") ?? "";
  check("the /research/ shell's CSP: this site only", /connect-src 'self';/.test(researchCsp) && /script-src 'self'/.test(researchCsp), researchCsp);
  const fakeIssue = async (n: number) => (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/issues/${n}`)).json()) as Json;
  // A GitHub issue, typed (the organization's types), labelled, commented, closed with a reason.
  const opened = await ada.act("issue_open", { forge: "github", id }, { title: "The epoch length is not the paper's (e2e)", body: "The Methods say 2 s epochs; the code cuts 1 s ones.", labels: ["bug"], type: "Bug" }, "/r/oscr-fixture/eeg-analysis/issues");
  const n = Number(opened.data.result?.number);
  check("issue_open: opened as Ada with its type and label, the action row only", opened.status === 200 && opened.written === 1 && (await fakeIssue(n)).type?.name === "Bug", [opened.status, opened.data, opened.written]);
  const labelled = await ada.act("issue_edit", { forge: "github", id }, { number: n, labels: { add: ["numerical difference"] } }, `/r/oscr-fixture/eeg-analysis/issues/${n}`);
  check("issue_edit: labelled", labelled.status === 200 && (await fakeIssue(n)).labels?.map((l: Json) => l.name).sort().join(",") === "bug,numerical difference", labelled.data);
  const commented = await ada.act("issue_comment", { forge: "github", id }, { number: n, body: "Confirmed with the paper's data." }, `/r/oscr-fixture/eeg-analysis/issues/${n}`);
  check("issue_comment: a comment, the action row only", commented.status === 200 && commented.written === 1, [commented.status, commented.data]);
  const closedIssue = await ada.act("issue_edit", { forge: "github", id }, { number: n, state: "closed", reason: "not_planned" }, `/r/oscr-fixture/eeg-analysis/issues/${n}`);
  const afterClose = await fakeIssue(n);
  check("issue_edit: closed as not planned", closedIssue.status === 200 && afterClose.state === "closed" && afterClose.state_reason === "not_planned", [closedIssue.data, afterClose.state, afterClose.state_reason]);
  // A research issue: the registry's own, in D1.
  const mismatch = { paper: "10.5555/oscr.fixture.1", repo: { forge: "github", id, path: "oscr-fixture/eeg-analysis" }, type: "mismatch", title: "band_power: SciPy's default window, the Methods say Hann (e2e)", body: "Contact: someone@example.org", path: "analysis.py", lines: { start: 4, end: 6 }, paragraph: 3 };
  const research = await ada.post("/api/forge/research/open", mismatch);
  const rid = Number(research.data.id);
  check("research open: a code–paper mismatch, 3 rows (the row, its index, the action row)", research.status === 201 && rid > 0 && ada.written === 3, [research.status, research.data, ada.written]);
  const read = (await (await ada.request(`${SITE}/api/forge/research?id=${rid}`)).json()) as Json;
  check("research read: live, its tracing-map link, the address hidden", read.issue?.type === "mismatch" && read.issue?.anchor?.paragraph === 3 && !JSON.stringify(read).includes("someone@example.org") && !("author_id" in (read.issue ?? {})), read.issue);
  check("research read: Ada, who linked the repository, triages it", read.can?.triage === true, read.can);
  const rlabel = await ada.post("/api/forge/research/edit", { id: rid, labels: { add: ["numerical difference"] } });
  check("research edit: labelled, 2 rows", rlabel.status === 200 && ada.written === 2, [rlabel.status, rlabel.data, ada.written]);
  const rcomment = await ada.post("/api/forge/research/comment", { id: rid, body: "The window changes the alpha ratio of Figure 2." });
  check("research comment: 3 rows (the comment, the issue's count, the action row)", rcomment.status === 200 && ada.written === 3, [rcomment.status, rcomment.data, ada.written]);
  const rclose = await ada.post("/api/forge/research/edit", { id: rid, state: "closed", resolution: "paper_corrected", ref: "10.5555/oscr.fixture.correction.1" });
  const closedRead = (await (await ada.request(`${SITE}/api/forge/research?id=${rid}`)).json()) as Json;
  check("research edit: closed with a resolution, 2 rows", rclose.status === 200 && closedRead.issue?.state === "closed" && closedRead.issue?.resolution === "paper_corrected" && closedRead.issue?.close_reason === "completed", [rclose.data, closedRead.issue?.state, closedRead.issue?.resolution]);
  // A second one, closed by a pull request that says "Fixes research#N".
  const second = await ada.post("/api/forge/research/open", { ...mismatch, title: "The band edges differ from Table 1 (e2e)", type: "code_error", paragraph: undefined });
  const rid2 = Number(second.data.id);
  check("research open: a code error", second.status === 201 && rid2 > rid, second.data);
  const base = await headOf();
  const text = `${await rawAt(base, "analysis.py")}\n# The band edges of Table 1.\n`;
  const branched2 = await ada.act("commit", { forge: "github", id }, { branch: "main", base, newBranch: "e2e-bands", message: "Take the band edges from Table 1", propose: false, changes: [{ op: "put", path: "analysis.py", text }] }, "/r/oscr-fixture/eeg-analysis/", { branch: "main", expectedHead: base });
  const pull = await ada.act("pull_open", { forge: "github", id }, { base: "main", head: "e2e-bands", title: "Band edges from Table 1", body: `Fixes research#${rid2}.` }, "/r/oscr-fixture/eeg-analysis/pulls", { branch: "main" });
  const np = Number(pull.data.result?.number);
  const pullHead = String(((await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/pulls/${np}`)).json()) as Json).head?.sha ?? "");
  const merge = await ada.act("pull_merge", { forge: "github", id }, { number: np, method: "merge", head: pullHead, closes: [rid2] }, `/r/oscr-fixture/eeg-analysis/pull/${np}`, { expectedHead: pullHead });
  const fixed = (await (await ada.request(`${SITE}/api/forge/research?id=${rid2}`)).json()) as Json;
  check("pull_merge: the pull request that says “Fixes research#N” closes it, fixed in the code at the merge commit (2 rows)", branched2.status === 200 && merge.status === 200 && merge.data.result?.closed?.[0] === rid2 && merge.written === 2 && fixed.issue?.state === "closed" && fixed.issue?.resolution === "fixed_in_code" && fixed.issue?.resolution_ref === merge.data.result?.sha, [merge.status, merge.data, merge.written, fixed.issue?.state, fixed.issue?.resolution]);
  // The copy of a research issue on GitHub, by its author (a new one: the first is closed, it may
  // still be copied).
  const copy = await ada.act("research_copy", { forge: "github", id }, { id: rid }, `/research/${rid}`);
  const copied = await fakeIssue(Number(copy.data.result?.number));
  check("research_copy: an ordinary issue with the type's label, its number named back (2 rows)", copy.status === 200 && copy.written === 2 && copied.labels?.some((l: Json) => l.name === "code–paper mismatch") && /research#/.test(String(copied.body)), [copy.status, copy.data, copy.written]);
}

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

// 5b. Phase 07: releases. The pages are the /r/ shell; Ada links her ORCID iD (a verified author of the
// fixture's paper), publishes a release with notes (hers and GitHub's generated ones), tied to the
// accepted manuscript with the map she saw, asking for Software Heritage and the Zenodo deposit of the
// map (jobs for the Mac: e2e.sh runs it next, its Zenodo the mock sandbox); she attaches no file here
// (the browser's run does); she deletes a tag no release uses, and a tag a release uses is refused.
for (const page of [
  "/r/oscr-fixture/eeg-analysis/releases/",
  "/r/oscr-fixture/eeg-analysis/releases/tag/v1.0",
  "/r/oscr-fixture/eeg-analysis/releases/new?tag=v1.2.0",
  "/r/oscr-fixture/eeg-analysis/releases/latest",
  "/r/oscr-fixture/eeg-analysis/tags/",
  "/r/oscr-fixture/eeg-analysis/environment/",
]) {
  const res = await anon.request(`${SITE}${page}`);
  check(`GET ${page}: 200, the shell`, res.status === 200 && /text\/html/.test(res.headers.get("Content-Type") ?? ""), res.status);
}
{
  const orcid = await ada.navigate(`${SITE}/api/auth/orcid/start?return=/account/`);
  const me = await ada.me();
  check("Ada links her ORCID iD: a verified author of the fixture's paper", orcid.pathname === "/account/" && JSON.stringify(me).includes("doi:10.5555/oscr.fixture.1"), [orcid.toString(), me.roles]);
  const head = await headOf();
  const MAP = process.env.MAP_DIGEST ?? "";
  check("the fixture paper's map digest, from the Mac (e2e.sh)", /^[0-9a-f]{64}$/.test(MAP), MAP);
  const notes = "The code of the accepted manuscript.\n\n## For the paper\n### Tracing-map links whose lines changed (to look at again)\n* paragraph 3 ↔ `analysis.py` lines 6–10";
  const made = await ada.act(
    "release_create",
    { forge: "github", id },
    { tag: "v1.2.0", target: head, name: "The code of the accepted manuscript", body: notes, generateNotes: true, latest: "true", paper: { doi: "10.5555/oscr.fixture.1", version: "accepted" }, map: MAP, archive: true, deposit: true },
    "/r/oscr-fixture/eeg-analysis/releases/",
  );
  check("release_create: published as Ada, GitHub's tag at the commit the page showed", made.status === 200 && made.data.result?.tag === "v1.2.0" && made.data.result?.draft === false, made.data);
  check("release_create: the tie, the map's version, Software Heritage and Zenodo asked: 5 rows", made.written === 5 && JSON.stringify(made.data.result?.jobs) === JSON.stringify(["release", "archive", "deposit"]), [made.written, made.data.result?.jobs]);
  check("release_create: the tie is linked (Ada is a verified author)", made.data.result?.papers?.[0]?.status === "linked", made.data.result?.papers);
  check("release_create: the sentence confirmed", /^Publish the release v1\.2\.0 “The code of the accepted manuscript” at commit [0-9a-f]{7} \(set as the latest; GitHub's generated notes added\); tie it to the accepted manuscript of doi:10\.5555\/oscr\.fixture\.1/.test(String(made.data.sentence)), made.data.sentence);
  const onGitHub = (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/releases/tags/v1.2.0`)).json()) as Json;
  check("GitHub holds the release: Ada's notes, then GitHub's generated ones", String(onGitHub.body).startsWith("The code of the accepted manuscript.") && /## What's Changed/.test(String(onGitHub.body)), String(onGitHub.body).slice(0, 200));
  const tags = (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/tags?per_page=100`)).json()) as Json[];
  const tagged = String(tags.find((t) => t.name === "v1.2.0")?.commit?.sha ?? "");
  check("GitHub made the tag at that commit", tagged === head, [tagged, head]);
  const latest = (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/releases/latest`)).json()) as Json;
  check("GitHub's latest release is it", latest.tag_name === "v1.2.0", latest.tag_name);
  const taken = await ada.act("release_create", { forge: "github", id }, { tag: "v1.2.0", target: head }, "/r/oscr-fixture/eeg-analysis/releases/");
  check("release_create: the same tag again is refused, nothing written", taken.status === 409 && taken.data.error?.code === "tag_taken" && taken.written === 0, [taken.status, taken.data]);
  const used = await ada.act("tag_delete", { forge: "github", id }, { name: "v1.2.0", confirm: "v1.2.0" }, "/r/oscr-fixture/eeg-analysis/tags/");
  check("tag_delete: a tag a published release (and a paper) uses is refused", used.status === 409 && ["tied", "released"].includes(String(used.data.error?.code)), used.data);
  const tag = await ada.act("tag_create", { forge: "github", id }, { name: "e2e-scratch", target: head, message: "A tag to delete" }, "/r/oscr-fixture/eeg-analysis/tags/");
  const untag = await ada.act("tag_delete", { forge: "github", id }, { name: "e2e-scratch", confirm: "e2e-scratch" }, "/r/oscr-fixture/eeg-analysis/tags/");
  check("tag_create, tag_delete: an annotated tag made, then deleted, as Ada (the action row each)", tag.status === 200 && tag.data.result?.annotated === true && untag.status === 200 && tag.written === 1 && untag.written === 1, [tag.data, untag.data]);
  const drafts = await ada.act("release_drafts", { forge: "github", id }, {}, "/r/oscr-fixture/eeg-analysis/releases/");
  check("release_drafts: the seeded draft, read as Ada, masked, the action row only", drafts.status === 200 && drafts.data.result?.drafts?.some((d: Json) => d.tag === "v1.1.0") && drafts.written === 1, drafts.data.result?.drafts?.map((d: Json) => d.tag));
  const layer = (await (await ada.request(`${SITE}/api/forge/repo?id=github:${id}`)).json()) as Json;
  check("the signed-in layer: the live tie, the Mac's jobs pending", layer.releaseTies?.some((t: Json) => t.tag === "v1.2.0" && t.shown === MAP) && ["release", "archive", "deposit"].every((k) => layer.jobs?.some((j: Json) => j.kind === k && j.ref === "v1.2.0")), [layer.releaseTies, layer.jobs]);
  const pkg = await ada.act("package_confirm", { forge: "github", id }, { registry: "pypi", name: "eeg-analysis", version: "1.1.0rc1", source: "pyproject.toml", confirm: true }, "/r/oscr-fixture/eeg-analysis/environment/");
  check("package_confirm: the package the manifest declares, confirmed by Ada (2 rows)", pkg.status === 200 && pkg.data.result?.status === "confirmed" && pkg.written === 2, [pkg.status, pkg.data, pkg.written]);
  if (STATE_FILE) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(STATE_FILE, JSON.stringify({ jar: [...ada.jar], id, tag: "v1.2.0" }));
  }
}

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
// Phase 04: Bob's fork and pull request actions are refused at start too (FORGE_OPEN unset).
const bobFork = await bob.act("fork", { forge: "github", id }, {}, "/r/oscr-fixture/eeg-analysis/fork/");
check("FORGE_OPEN unset: Bob's fork is refused at start (403 forge_closed)", bobFork.start === 403 && bobFork.data.error?.code === "forge_closed", bobFork.data);
const bobPull = await bob.act("pull_comment", { forge: "github", id }, { number: 2, body: "Bob's comment" }, "/r/oscr-fixture/eeg-analysis/pull/2");
check("FORGE_OPEN unset: Bob's comment is refused at start (403 forge_closed)", bobPull.start === 403 && bobPull.data.error?.code === "forge_closed", bobPull.data);
// Phase 05: Bob's issue and research writes are refused too (FORGE_OPEN unset); he may read.
const bobIssue = await bob.act("issue_open", { forge: "github", id }, { title: "Bob's issue" }, "/r/oscr-fixture/eeg-analysis/issues");
check("FORGE_OPEN unset: Bob's issue is refused at start (403 forge_closed)", bobIssue.start === 403 && bobIssue.data.error?.code === "forge_closed", bobIssue.data);
// Phase 07: Bob's release and file are refused at start too (FORGE_OPEN unset).
const bobRelease = await bob.act("release_create", { forge: "github", id }, { tag: "v9.9.9", target: "0".repeat(40) }, "/r/oscr-fixture/eeg-analysis/releases/");
check("FORGE_OPEN unset: Bob's release is refused at start (403 forge_closed)", bobRelease.start === 403 && bobRelease.data.error?.code === "forge_closed", bobRelease.data);
const bobAsset = await bob.act("asset_upload", { forge: "github", id }, { release: "1", name: "x.csv", size: 1, sha256: "c".repeat(64), contentType: "text/csv" }, "/r/oscr-fixture/eeg-analysis/releases/");
check("FORGE_OPEN unset: Bob's file is refused at start (403 forge_closed)", bobAsset.start === 403 && bobAsset.data.error?.code === "forge_closed", bobAsset.data);
const bobResearch = await bob.post("/api/forge/research/open", { paper: "10.5555/oscr.fixture.1", repo: { forge: "github", id, path: "oscr-fixture/eeg-analysis" }, type: "code_error", title: "Bob's" });
check("FORGE_OPEN unset: Bob's research issue is refused (403 forge_closed), nothing written", bobResearch.status === 403 && bobResearch.data.error?.code === "forge_closed" && bob.written === 0, [bobResearch.status, bobResearch.data]);
const bobReads = await bob.request(`${SITE}/api/forge/research?id=1`);
check("Bob may read a research issue", bobReads.status === 200, bobReads.status);
const bobMine = await bob.request(`${SITE}/api/forge/mine`);
check("Bob may still read his dashboard", bobMine.status === 200, bobMine.status);
await post(`${FAKE}/control`, { login: "ada-fixture" });

console.log(failures ? `${failures} check(s) failed` : "every check passed");
process.exit(failures ? 1 : 0);
