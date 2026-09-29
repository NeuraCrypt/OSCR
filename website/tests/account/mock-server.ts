// The end-to-end run's outside world, over HTTP, on this machine only:
// - the mock ORCID, GitHub and Google of mock.ts: `wrangler dev` points at them through ORCID_ISSUER,
//   GITHUB_URL, GITHUB_API_URL and GOOGLE_ISSUER (docs/ACCOUNTS.md, "Local end-to-end run");
// - under /checks/, doi.org and the forges the contributions' checks ask (Phase 6,
//   tests/contributions/places.ts): `wrangler dev --var CHECKS_URL:<this>/checks`;
// - under /zenodo/, the Zenodo sandbox of the Mac's job runner (`OSCR_ZENODO_SANDBOX_URL`);
// - night phase 16: /turnstile/siteverify, Cloudflare Turnstile's verification with its test secrets.
//
//   node --experimental-strip-types tests/account/mock-server.ts [port, default 9471]
//
// POST /control {"who": {...}, "github": {...}, "deny": false, "places": {...}} sets who signs in at
// each provider, what GitHub's API answers and which DOIs and pages exist; GET /control/log lists the
// requests received, GET /control/zenodo the deposits.
import { createServer } from "node:http";
import { MockPlaces, MockZenodo } from "../contributions/places.ts";
import { MockProviders } from "./mock.ts";

const port = Number(process.argv[2] ?? 9471);
const base = `http://127.0.0.1:${port}`;
const mock = new MockProviders(base);
const places = new MockPlaces();
const zenodo = new MockZenodo(`${base}/zenodo`);

type Control = {
  who?: Partial<MockProviders["who"]>;
  deny?: boolean;
  github?: { publicMembers?: string[]; contributors?: Record<string, string[] | number>; commits?: Record<string, number>; fail?: number };
  places?: { dois?: string[]; pages?: Record<string, number>; noHead?: string[]; silent?: string[] };
};

function control(c: Control): void {
  if (c.who) Object.assign(mock.who, c.who);
  if (c.deny !== undefined) mock.deny = c.deny;
  if (c.github) {
    if (c.github.publicMembers) mock.github.publicMembers = new Set(c.github.publicMembers.map((m) => m.toLowerCase()));
    if (c.github.contributors) mock.github.contributors = new Map(Object.entries(c.github.contributors).map(([k, v]) => [k.toLowerCase(), v]));
    if (c.github.commits) mock.github.commits = new Map(Object.entries(c.github.commits).map(([k, v]) => [k.toLowerCase(), v]));
    if (c.github.fail !== undefined) mock.github.fail = c.github.fail;
  }
  if (c.places) {
    for (const doi of c.places.dois ?? []) places.dois.add(doi.toLowerCase());
    for (const [url, status] of Object.entries(c.places.pages ?? {})) places.page(url, status);
    for (const p of c.places.noHead ?? []) places.noHead.add(p);
    for (const p of c.places.silent ?? []) places.silent.add(p);
  }
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const path = req.url ?? "/";
  if (path === "/control" && req.method === "POST") {
    control(JSON.parse(body.toString("utf8") || "{}") as Control);
    res.writeHead(204).end();
    return;
  }
  if (path === "/control/log") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ providers: mock.log, checks: places.log, zenodo: zenodo.calls }));
    return;
  }
  if (path === "/control/zenodo") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(zenodo.deposits));
    return;
  }
  // Night phase 16: Cloudflare Turnstile's siteverify as its documented test secrets make it answer
  // (the secret 1x…AA passes any token, 2x…AA fails every one): `wrangler dev --var
  // TURNSTILE_VERIFY_URL:<this>/turnstile/siteverify`. Never Cloudflare itself.
  if (path === "/turnstile/siteverify" && req.method === "POST") {
    const form = new URLSearchParams(body.toString("utf8"));
    const pass = form.get("secret") === "1x0000000000000000000000000000000AA" && !!form.get("response");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: pass, "error-codes": pass ? [] : ["invalid-input-response"] }));
    return;
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, value);
  }
  const method = req.method ?? "GET";
  const request = new Request(`${base}${path}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
  let answer: Response;
  if (path.startsWith("/checks/")) {
    try {
      answer = places.answerMapped(method, request.url);
    } catch {
      res.destroy();            // a place that does not answer
      return;
    }
  } else if (path.startsWith("/zenodo/")) answer = await zenodo.handle(request);
  else answer = await mock.handle(request);
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  res.end(Buffer.from(await answer.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`mock providers, places and Zenodo on ${base}`));
