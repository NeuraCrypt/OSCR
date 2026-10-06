// Night phase 14's end-to-end checks (docs/CLI.md "Local end-to-end run"): the researchers' command line
// (cli/, run as `python -m oscr_cli`, D14-1) against the fake GitHub and `wrangler dev`, after the other
// stages, on the same Worker state. The harness is the person: it approves on GitHub's device page (the
// fake's /control/device) and on the registry's /device/ page (signed in as Ada, with the session's CSRF
// token and Turnstile's test token), refuses once, and lets a code expire (the Worker runs with a
// development life of 12 s: DEVICE_CODE_SECONDS). The credentials go to a throwaway macOS keychain file,
// made here and deleted after; never the person's own.
//
//   SITE=… MOCK=… FAKE=… ROOT=<worktree> [TRANSCRIPTS=<folder>] node --experimental-strip-types tests/forge-service/e2e-cli.ts
//
// Not a unit test: it needs the servers of e2e.sh. Prints each check; exits 1 on a failure.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITE = process.env.SITE ?? "http://localhost:8791";
const MOCK = process.env.MOCK ?? "http://127.0.0.1:9491";
const FAKE = process.env.FAKE ?? "http://127.0.0.1:9490";
const ROOT = process.env.ROOT ?? new URL("../../..", import.meta.url).pathname;
const PYTHON = `${ROOT}/.venv/bin/python`;
const TRANSCRIPTS = process.env.TRANSCRIPTS ?? "";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

type Json = Record<string, any>; // deno-lint-ignore no-explicit-any

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? `, ${typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

// ─── the person on the site ──────────────────────────────────────────────────

class Client {
  jar = new Map<string, string>();

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(SITE) && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.startsWith(SITE)) {
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attributes] = c.split(";");
        const i = pair.indexOf("=");
        const maxAge = attributes.map((a) => a.trim()).find((a) => /^Max-Age=/i.test(a));
        if (maxAge && Number(maxAge.split("=")[1]) <= 0) this.jar.delete(pair.slice(0, i).trim());
        else this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
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

  async get(path: string): Promise<{ status: number; data: Json }> {
    const res = await this.request(`${SITE}${path}`, { headers: { Accept: "application/json" } });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }

  async post(path: string, body: unknown): Promise<{ status: number; data: Json }> {
    const me = (await this.get("/api/account/me")).data;
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: new URL(SITE).origin };
    if (typeof me.csrf === "string") headers["X-CSRF-Token"] = me.csrf;
    const res = await this.request(`${SITE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }

  /** One authorized action (start, GitHub approves at once, act), as the page the command line opened does. */
  async act(kind: string, repo: unknown, payload: unknown): Promise<{ status: number; data: Json }> {
    const text = JSON.stringify(payload);
    const digest = createHash("sha256").update(text).digest("hex");
    const s = await this.post("/api/forge/start", { kind, repo, branch: null, expectedHead: null, digest, back: "/new/link/" });
    if (s.status !== 200) return s;
    const landed = await this.navigate(String(s.data.location));
    return this.post("/api/forge/act", { code: landed.searchParams.get("code"), state: landed.searchParams.get("state"), payload: text });
  }
}

const seed = (await (await fetch(`${FAKE}/control/seed`)).json()) as { ada: { id: string } };
await fetch(`${MOCK}/control`, { method: "POST", body: JSON.stringify({ who: { github: { id: Number(seed.ada.id), login: "ada-fixture", name: "Ada Fixture" } } }) });
const ada = new Client();
const landed = await ada.navigate(`${SITE}/api/auth/github/start?return=/account/`);
check("Ada is signed in on the site (the person who approves)", landed.pathname === "/account/", landed.toString());

// ─── the command line's world: a throwaway home, config, git config and keychain file ──

const TMP = mkdtempSync(join(tmpdir(), "oscr-cli-e2e-"));
const KEYCHAIN = join(TMP, "oscr-cli-e2e.keychain-db");
const KC_PASSWORD = randomBytes(12).toString("hex");
const kc = (...args: string[]) => spawnSync("security", args, { encoding: "utf8" });
const listBefore = kc("list-keychains", "-d", "user").stdout;
kc("create-keychain", "-p", KC_PASSWORD, KEYCHAIN);
kc("unlock-keychain", "-p", KC_PASSWORD, KEYCHAIN);
kc("set-keychain-settings", KEYCHAIN);
check("a throwaway keychain file, outside the person's keychain list", existsSync(KEYCHAIN) && kc("list-keychains", "-d", "user").stdout === listBefore);

const HOST = new URL(SITE).host;
const FAKE_HOST = new URL(FAKE).host;
const ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: join(TMP, "home"),
  PYTHONPATH: `${ROOT}/cli/src`,
  OSCR_CONFIG_DIR: join(TMP, "config"),
  OSCR_KEYCHAIN: KEYCHAIN,
  OSCR_HOST: HOST,
  OSCR_GITHUB_WEB: `${FAKE}/web`,
  OSCR_GITHUB_API: `${FAKE}/api`,
  OSCR_BROWSER: "none",
  GIT_CONFIG_GLOBAL: join(TMP, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada Fixture",
  GIT_COMMITTER_NAME: "Ada Fixture",
  GIT_AUTHOR_EMAIL: "ada@invalid",
  GIT_COMMITTER_EMAIL: "ada@invalid",
};
mkdirSync(ENV.HOME, { recursive: true });

const secrets: string[] = [];
const scrub = (s: string) => {
  let out = s.replace(/r=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}/g, "r=…");
  for (const t of secrets) out = out.split(t).join("[a token]");
  return out;
};
function transcript(name: string, argv: string[], r: { stdout: string; stderr: string; status: number | null }): void {
  if (!TRANSCRIPTS) return;
  mkdirSync(TRANSCRIPTS, { recursive: true });
  const quoted = argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`));
  const body = `$ oscr ${quoted.join(" ")}\n${r.stdout}${r.stderr ? `${r.stderr}` : ""}[exit ${r.status}]\n`;
  const file = join(TRANSCRIPTS, `${name}.txt`);
  writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") + "\n" : "") + scrub(body));
}

function oscr(argv: string[], o: { cwd?: string; input?: string; name?: string; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
  const r = spawnSync(PYTHON, ["-m", "oscr_cli", ...argv], { cwd: o.cwd ?? TMP, env: { ...ENV, ...(o.env ?? {}) }, input: o.input ?? "", encoding: "utf8", timeout: 120_000 });
  if (o.name) transcript(o.name, argv, r);
  return r;
}

/** A sign-in in the background: the harness acts as the person when the terminal says what to do. */
function login(argv: string[], act: { github?: "approve" | "deny"; oscr?: "approve" | "deny" | "wait" }, name = ""): Promise<{ code: number | null; out: string; err: string; request: string; userCode: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, ["-m", "oscr_cli", ...argv], { cwd: TMP, env: ENV });
    let out = "";
    let err = "";
    let request = "";
    let userCode = "";
    let seenGithub = false;
    let seenOscr = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", async (d) => {
      err += d;
      if (!seenGithub && /GitHub: open \S+ and enter the code (\S+)/.test(err)) {
        seenGithub = true;
        await fetch(`${FAKE}/control/device`, { method: "POST", body: JSON.stringify({ action: act.github ?? "approve", login: "ada-fixture" }) });
      }
      const m = /open (\S+\/device\/\?r=(\S+))\n\s+sign in, then type the code ([A-Z]{4}-[A-Z]{4})/.exec(err);
      if (!seenOscr && m) {
        seenOscr = true;
        request = m[2];
        userCode = m[3];
        if (act.oscr === "approve" || act.oscr === "deny") {
          const page = await ada.get(`/api/forge/device?r=${request}`);
          check(`the approval page reads the request (${act.oscr})`, page.status === 200 && page.data.state === "pending" && Array.isArray(page.data.scopes), page.data);
          const decided = await ada.post("/api/forge/device/decide", { request, code: userCode.toLowerCase(), decision: act.oscr, turnstile: TOKEN });
          check(`the person ${act.oscr === "approve" ? "approves" : "refuses"} on /device/, typing the terminal's code`, decided.status === 200 && decided.data.state === (act.oscr === "approve" ? "approved" : "denied"), decided);
        }
      }
    });
    child.on("close", (code) => {
      if (name) transcript(name, argv, { stdout: out, stderr: err, status: code });
      resolve({ code, out, err, request, userCode });
    });
  });
}

const cli = await (await fetch(`${SITE}/api/forge/v1/cli`)).json() as Json;
check("GET /api/forge/v1/cli: the App's public client id, no secret", typeof cli.github?.client_id === "string" && !JSON.stringify(cli).toLowerCase().includes("secret"), cli);

// ─── sign-in: both device flows ──────────────────────────────────────────────

const both = await login(["auth", "login"], { github: "approve", oscr: "approve" }, "01-auth-login");
check("oscr auth login: both device flows, exit 0", both.code === 0, both.err);
check("GitHub's sign-in: the token from GitHub's device flow, kept in the keychain", /GitHub: signed in as ada-fixture/.test(both.err), both.err);
check("the registry's sign-in: approved on /device/", /signed in as ada-fixture\. The token is in the macOS keychain/.test(both.err), both.err);
const ghToken = oscr(["auth", "token", "--github"]).stdout.trim();
const oscrToken = oscr(["auth", "token", "--oscr"]).stdout.trim();
secrets.push(ghToken, oscrToken);
check("the tokens are in the throwaway keychain file only", /^memtok_/.test(ghToken) && /^oscr_pat_/.test(oscrToken)
  && kc("find-generic-password", "-s", "oscr-cli", "-a", `github:${FAKE_HOST}:ada-fixture`, KEYCHAIN).status === 0
  && kc("find-generic-password", "-s", "oscr-cli", "-a", `oscr:${HOST}:ada-fixture`, KEYCHAIN).status === 0);
const hostsText = readFileSync(join(ENV.OSCR_CONFIG_DIR, "hosts.json"), "utf8");
check("hosts.json keeps public handles and scopes, never a token nor an address", !hostsText.includes(ghToken) && !hostsText.includes(oscrToken) && !hostsText.includes("@"), hostsText);
check("the GitHub token never reached the registry: the Worker's log is not asked, the flow went to the fake GitHub", both.err.includes(`${FAKE}/web/login/device`));

const status = oscr(["auth", "status"], { name: "02-auth-status" });
check("oscr auth status: both accounts valid", status.status === 0 && (status.stdout.match(/valid/g) ?? []).length === 2, status.stdout + status.stderr);
const debug = oscr(["auth", "status", "--debug"]);
check("--debug says each request, never a token", debug.stderr.includes("[debug] > GET") && !debug.stderr.includes(ghToken) && !debug.stderr.includes(oscrToken) && !debug.stdout.includes(oscrToken));
const user = oscr(["api", "/user"], { name: "03-api-user" });
check("oscr api /user: the registry's API with the registry's token", user.status === 0 && JSON.parse(user.stdout).github === "ada-fixture", user.stdout + user.stderr);

// git's credential helper: GitHub's host only.
const gh = oscr(["auth", "git-credential", "get"], { input: `protocol=http\nhost=${FAKE_HOST}\n\n` });
const other = oscr(["auth", "git-credential", "get"], { input: `protocol=http\nhost=${HOST}\n\n` });
check("the git credential helper answers GitHub's host, and nothing for the registry's", gh.stdout.includes("username=ada-fixture") && gh.stdout.includes(`password=${ghToken}`) && other.stdout === "");

// ─── a fixture clone: check, cite, trace ─────────────────────────────────────

const WORK = join(TMP, "eeg-analysis");
mkdirSync(join(WORK, "analysis"), { recursive: true });
const git = (...args: string[]) => spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: WORK, env: ENV, encoding: "utf8" });
writeFileSync(join(WORK, "analysis.py"), ["import numpy as np", "", "", "def load(path):", "    return np.load(path)", "", "def band_power(x, lo, hi):", "    spectrum = np.abs(np.fft.rfft(x)) ** 2", "    return spectrum[lo:hi].mean()", "", ""].join("\n"));
writeFileSync(join(WORK, "plot.py"), "import matplotlib\n\n\ndef show(x):\n    return x\n\n");
writeFileSync(join(WORK, "LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n");
writeFileSync(join(WORK, "README.md"), "# eeg-analysis\n\nThe code of doi:10.5555/oscr.fixture.1.\n\n## Installation\n\npip install -r requirements.txt\n");
writeFileSync(join(WORK, "requirements.txt"), "numpy==1.26.4\n");
writeFileSync(join(WORK, "CITATION.cff"), "cff-version: 1.2.0\nmessage: Please cite the paper.\ntitle: eeg-analysis\nauthors:\n  - family-names: Fixture\n    given-names: Ada\npreferred-citation:\n  type: article\n  title: A synthetic EEG study for the OSCR build test\n  journal: The fixture journal\n  year: '2026'\n  doi: 10.5555/oscr.fixture.1\n  authors:\n    - family-names: Fixture\n      given-names: Ada\n");
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "The analysis");
git("remote", "add", "origin", `${FAKE}/web/oscr-fixture/eeg-analysis.git`);

const checked = oscr(["check"], { cwd: WORK, name: "04-check" });
check("oscr check: the registry's checks on the clone, its paper from the live layer, nothing run", checked.status === 0 && checked.stdout.includes("Linked in the registry to its paper: 10.5555/oscr.fixture.1") && checked.stderr.includes("nothing was run"), checked.stdout + checked.stderr);
const cite = oscr(["cite", "--format", "apa"], { cwd: WORK, name: "05-cite" });
check("oscr cite: APA from CITATION.cff", cite.status === 0 && cite.stdout.includes("https://doi.org/10.5555/oscr.fixture.1"), cite.stdout + cite.stderr);
const maps = oscr(["trace", "list"], { cwd: WORK, name: "06-trace" });
check("oscr trace list: the fixture's map from the site's static shard", maps.status === 0 && maps.stdout.includes("10.5555/oscr.fixture.1") && maps.stdout.includes("analysis.py:6–10"), maps.stdout + maps.stderr);
const tcheck = oscr(["trace", "check"], { cwd: WORK, name: "06-trace" });
check("oscr trace check: the map's lines looked for at HEAD (its commit is not in this clone: by its symbol)", tcheck.status === 0 && /band_power|symbol/.test(tcheck.stdout), tcheck.stdout + tcheck.stderr);
const propose = oscr(["trace", "propose", "10.5555/oscr.fixture.1", "analysis.py:7-9=3", "--section", "Methods › Spectral analysis", "--write"], { cwd: WORK, name: "06-trace" });
const proposal = join(WORK, ".oscr", "maps", "10.5555_oscr.fixture.1.json");
check("oscr trace propose: a map from selected lines, written with the code", propose.status === 0 && existsSync(proposal) && JSON.parse(readFileSync(proposal, "utf8")).pairs[0].symbol === "band_power", propose.stderr);
const pcheck = oscr(["trace", "check", "--file", proposal], { cwd: WORK, name: "06-trace" });
check("oscr trace check --file: the proposed map at its own commit", pcheck.status === 0 && pcheck.stdout.includes("at the map's own commit"), pcheck.stdout);

// ─── the GitHub side: repo create, paper link through the site's write path, issue create ──

const created = oscr(["repo", "create", "e2e-cli-tool", "--description", "Made from the command line", "--license", "mit", "--paper", "10.5555/oscr.fixture.1", "--no-browser"], { name: "07-repo-create-paper-link" });
const linkUrl = created.stdout.split("\n").find((l) => l.includes("/new/link/")) ?? "";
check("oscr repo create: public, on GitHub as Ada; the registry's page to link it, pre-filled", created.status === 0 && linkUrl === `${SITE}/new/link/?repo=ada-fixture/e2e-cli-tool&paper=10.5555/oscr.fixture.1`, created.stdout + created.stderr);
const fakeRepo = await fetch(`${FAKE}/api/repos/ada-fixture/e2e-cli-tool`, { headers: { Authorization: `Bearer ${ghToken}` } });
check("the repository exists on the fake GitHub", fakeRepo.status === 200);
const linked = await ada.act("link", { forge: "github", owner: "ada-fixture", name: "e2e-cli-tool" }, { repository: "ada-fixture/e2e-cli-tool", papers: ["10.5555/oscr.fixture.1"] });
check("the page's write path: the link action, authorized on GitHub", linked.status === 200, linked);
const papers = oscr(["paper", "list", "-R", "ada-fixture/e2e-cli-tool", "--json", "doi"], { name: "07-repo-create-paper-link" });
check("oscr paper list: the link, live", papers.status === 0 && JSON.parse(papers.stdout).some((p: Json) => p.doi === "10.5555/oscr.fixture.1"), papers.stdout + papers.stderr);
const known = oscr(["paper", "link", "10.5555/oscr.fixture.2", "-R", "oscr-fixture/eeg-analysis", "--no-browser"], { name: "07-repo-create-paper-link" });
check("oscr paper link on a repository the registry knows: its settings page, pre-filled", known.stdout.trim() === `${SITE}/r/oscr-fixture/eeg-analysis/settings/?paper=10.5555/oscr.fixture.2`, known.stdout + known.stderr);
const issue = oscr(["issue", "create", "--title", "Band edges differ from Table 1 (e2e)", "--body", "Seen from the command line.", "-R", "oscr-fixture/eeg-analysis"], { name: "08-issue-create" });
const n = /issues\/(\d+)/.exec(issue.stdout)?.[1];
const onFake = n ? (await (await fetch(`${FAKE}/api/repos/oscr-fixture/eeg-analysis/issues/${n}`, { headers: { Authorization: `Bearer ${ghToken}` } })).json()) as Json : {};
check("oscr issue create: on GitHub as Ada; the registry's page given", issue.status === 0 && onFake.title === "Band edges differ from Table 1 (e2e)" && issue.stdout.trim().startsWith(`${SITE}/r/oscr-fixture/eeg-analysis/issues/`), issue.stdout + issue.stderr);

// ─── refusals: a wrong scope, a refused approval, an expired code ───────────

const scope = oscr(["issue", "create", "--research", "code_error", "--paper", "10.5555/oscr.fixture.1", "--title", "x", "--body", "y", "-R", "oscr-fixture/eeg-analysis"], { name: "09-refusals" });
check("a wrong scope: the token (repos:read, research:read) may not open a research issue", scope.status === 1 && scope.stderr.includes("research:write"), scope.stderr);
const unknownScope = await fetch(`${SITE}/api/forge/v1/device/code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scopes: ["repos:admin"] }) });
check("a code for an unknown scope: 400, and no row", unknownScope.status === 400, await unknownScope.text());
const refused = await login(["auth", "login", "--oscr"], { oscr: "deny" }, "09-refusals");
check("a refused approval: the terminal hears it (exit 4)", refused.code === 4 && /refused/.test(refused.err), refused.err);
const expired = await login(["auth", "login", "--oscr"], { oscr: "wait" }, "09-refusals");
check("an expired code: the terminal stops (exit 4)", expired.code === 4 && /expired/.test(expired.err), expired.err);
const late = await ada.post("/api/forge/device/decide", { request: expired.request, code: expired.userCode, decision: "approve", turnstile: TOKEN });
check("approving an expired request: 410", late.status === 410, late);

// ─── MCP, then sign-out ──────────────────────────────────────────────────────

const mcp = oscr(["mcp", "serve"], { cwd: WORK, input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check", arguments: { path: WORK } } })}\n` });
const replies = mcp.stdout.trim().split("\n").map((l) => JSON.parse(l) as Json);
check("oscr mcp serve: the check tool answers the command's JSON", replies[1]?.result?.structuredContent?.conclusion !== undefined, mcp.stdout.slice(0, 300));

const out = oscr(["auth", "logout"], { name: "10-auth-logout" });
check("oscr auth logout: both signed out", out.status === 0 && /revoked/.test(out.stderr) && /8 hours/.test(out.stderr), out.stderr);
const revoked = await fetch(`${SITE}/api/forge/v1/user`, { headers: { Authorization: `Bearer ${oscrToken}` } });
check("the registry's token revoked itself", revoked.status === 401);
check("the keychain file holds none of them any more",
  kc("find-generic-password", "-s", "oscr-cli", "-a", `github:${FAKE_HOST}:ada-fixture`, KEYCHAIN).status !== 0
  && kc("find-generic-password", "-s", "oscr-cli", "-a", `oscr:${HOST}:ada-fixture`, KEYCHAIN).status !== 0);

kc("delete-keychain", KEYCHAIN);
check("the throwaway keychain deleted; the person's keychain list as it was", !existsSync(KEYCHAIN) && kc("list-keychains", "-d", "user").stdout === listBefore);
rmSync(TMP, { recursive: true, force: true });

console.log(failures ? `${failures} check(s) failed` : "every check passed");
process.exit(failures ? 1 : 0);
