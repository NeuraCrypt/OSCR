// The fake GitHub (fake-github.ts) served over HTTP, on this machine only, for `wrangler dev` and a
// browser (night phase 01's end-to-end run, tests/forge-service/e2e.sh):
//
//   /api/…   api.github.com       FORGE_GITHUB_API_URL=http://127.0.0.1:<port>/api
//   /web/…   github.com           FORGE_GITHUB_WEB_URL=http://127.0.0.1:<port>/web
//   /raw/…   raw.githubusercontent.com
//
// and what a person does on GitHub's own pages: GET /web/login/oauth/authorize approves at once as
// the person /control names (a redirect to the callback with the code and the state), and
// GET /web/apps/<slug>/installations/new installs the App on that person's account and comes back
// with installation_id and setup_action. Answers carry CORS headers, as GitHub's API does, so that a
// page of the site reads it in the browser.
//
//   node --experimental-strip-types tests/forge/fake-github-server.ts [port, default 9490]
//
// GET /control/seed: the people and repositories made at start. POST /control {"login": "…"}: who
// approves next. POST /control {"offline": true}: every answer becomes 503 (the degraded state).
// POST /control/install {"account": "…"}: the App installed on that account (night phase 10's check
// runs), its installation's id answered.
// Development values only: the App's client id and secret are the e2e's own (FAKE_CLIENT_ID,
// FAKE_CLIENT_SECRET), never real ones.
import { createServer } from "node:http";
import { FakeGitHub } from "./fake-github.ts";
import { seedCodeTour, seedIssues, seedPulls, seedReleases } from "./fake-github-seed.ts";
import { MemoryBackend } from "./memory.ts";

const port = Number(process.argv[2] ?? 9490);
const base = `http://127.0.0.1:${port}`;
const client = { id: process.env.FAKE_CLIENT_ID ?? "Iv23liE2ETESTCLIENT", secret: process.env.FAKE_CLIENT_SECRET ?? "e2e-test-secret-not-real" };
const double = new MemoryBackend({ web: `${base}/web`, appSlug: process.env.FAKE_APP_SLUG ?? "code-registry-dev" });
const fake = new FakeGitHub(double, client);

// The people and repositories of the run.
const ada = double.addUser("ada-fixture");
const bob = double.addUser("bob-fixture");
double.addOrg("oscr-fixture", ["ada-fixture"]);
const org = double.session({ kind: "user", token: ada.token() });
const te = new TextEncoder();
const eeg = await org.repos.create({ name: "eeg-analysis", visibility: "public", autoInit: true, description: "EEG preprocessing and analysis for the fixture study", homepage: "https://doi.org/10.5555/oscr.fixture.1", licenseTemplate: "mit" });
// Moved into the organization, as the fixture's repositories live there.
await org.repos.transfer(eeg.ref, { newOwner: "oscr-fixture" });
const eegRef = { forge: "memory" as const, owner: "oscr-fixture", name: "eeg-analysis" };
const head = await org.git.resolve(eegRef, "main");
await org.git.createCommit(eegRef, {
  branch: "main",
  expectedHead: head,
  message: "Add the analysis",
  changes: [
    { op: "put", path: "analysis/preprocess.py", content: te.encode("import numpy as np\n\ndef bandpass(x, lo, hi):\n    return x\n") },
    { op: "put", path: "README.md", content: te.encode("# eeg-analysis\n\nThe code of the fixture study (doi:10.5555/oscr.fixture.1): preprocessing, epochs and statistics.\n\nRun `python analysis/preprocess.py`.\n") },
  ],
});
const newest = await org.git.resolve(eegRef, "main");
await org.git.createBranch(eegRef, "feature-epochs", newest);
await org.git.createBranch(eegRef, "old-idea", head);
// Phase 02: the files and history the code views show (tests/forge/fake-github-seed.ts).
await seedCodeTour(org, eegRef);
await org.repos.setTopics(eegRef, ["eeg", "neuroscience"]);
// Phase 04: a pull request from Bob's fork, reviewed with a suggestion (the pull request pages).
const pulls = await seedPulls(org, double.session({ kind: "user", token: bob.token() }), eegRef);
// Phase 05: labels, a milestone and issues (the issue pages).
const issues = await seedIssues(org, double.session({ kind: "user", token: bob.token() }), eegRef);
// Phase 07: releases (a published one with a file, a pre-release, a draft) and the environment files.
const releases = await seedReleases(org, eegRef);
const empty = await org.repos.create({ name: "empty-repo", visibility: "public" });
await org.repos.transfer(empty.ref, { newOwner: "oscr-fixture" });
await org.repos.create({ name: "compendium", visibility: "public", autoInit: true, isTemplate: true, description: "A research compendium: code, data and environment" });

let login = "ada-fixture";
let offline = false;

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type, X-GitHub-Api-Version, If-None-Match",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "ETag, Link, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
};

const HOSTS: Record<string, string> = { api: "api.github.com", web: "github.com", raw: "raw.githubusercontent.com", uploads: "uploads.github.com" };

async function answer(method: string, url: URL, headers: Headers, body: Uint8Array): Promise<Response> {
  if (url.pathname === "/control/seed") {
    return Response.json({ ada: { id: ada.user.id, login: "ada-fixture" }, bob: { id: bob.user.id, login: "bob-fixture" }, repos: ["oscr-fixture/eeg-analysis", "oscr-fixture/empty-repo", "ada-fixture/compendium"], pulls, issues, releases });
  }
  // Night phase 10: the App installed on an account (every repository), as GitHub's installation page
  // does it; the end-to-end run then tells the Worker through the installation webhook.
  if (url.pathname === "/control/install" && method === "POST") {
    const c = JSON.parse(new TextDecoder().decode(body) || "{}") as { account?: string };
    return Response.json({ id: double.install(c.account ?? "oscr-fixture") });
  }
  if (url.pathname === "/control" && method === "POST") {
    const c = JSON.parse(new TextDecoder().decode(body) || "{}") as { login?: string; offline?: boolean };
    if (c.login) login = c.login;
    if (c.offline !== undefined) offline = c.offline;
    return Response.json({ login, offline });
  }
  if (offline) return Response.json({ message: "Service Unavailable" }, { status: 503 });
  const [, prefix, ...rest] = url.pathname.split("/");
  const host = HOSTS[prefix];
  if (!host) return new Response("Not Found", { status: 404 });
  const path = `/${rest.join("/")}`;
  // What a person does on GitHub's own pages.
  if (host === "github.com" && method === "GET" && path === "/login/oauth/authorize") {
    const { code, state } = double.authorize(url.toString(), login);
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }
  const install = /^\/apps\/[^/]+\/installations\/new$/.exec(path);
  if (host === "github.com" && method === "GET" && install) {
    const id = double.install(login);
    const back = new URL(`${process.env.SITE ?? "http://localhost:8791"}/forge/authorized/`);
    back.searchParams.set("installation_id", id);
    back.searchParams.set("setup_action", "install");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return new Response(null, { status: 302, headers: { Location: back.toString() } });
  }
  const target = new URL(`https://${host}${path}${url.search}`);
  return fake.handle(method, target, headers, body);
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? "/", base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  let out: Response;
  if (req.method === "OPTIONS") out = new Response(null, { status: 204 });
  else {
    try {
      out = await answer(req.method ?? "GET", url, headers, new Uint8Array(Buffer.concat(chunks)));
    } catch (e) {
      out = Response.json({ message: String((e as Error)?.message ?? e) }, { status: 500 });
    }
  }
  const h: Record<string, string> = { ...cors };
  out.headers.forEach((v, k) => (h[k] = v));
  res.writeHead(out.status, h);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`fake GitHub on ${base} (ada-fixture is ${ada.user.id})`));

