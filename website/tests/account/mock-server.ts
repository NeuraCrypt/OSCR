// The end-to-end run's providers: the mock ORCID, GitHub and Google of mock.ts, over HTTP, on this
// machine only. `wrangler dev` points at it through ORCID_ISSUER, GITHUB_URL, GITHUB_API_URL and
// GOOGLE_ISSUER (docs/ACCOUNTS.md, "Local end-to-end run").
//
//   node --experimental-strip-types tests/account/mock-server.ts [port, default 9471]
//
// POST /control {"who": {...}, "github": {...}, "deny": false} sets who signs in at each provider
// and what GitHub's API answers; GET /control/log lists the requests received.
import { createServer } from "node:http";
import { MockProviders } from "./mock.ts";

const port = Number(process.argv[2] ?? 9471);
const mock = new MockProviders(`http://127.0.0.1:${port}`);

type Control = {
  who?: Partial<MockProviders["who"]>;
  deny?: boolean;
  github?: { publicMembers?: string[]; contributors?: Record<string, string[] | number>; commits?: Record<string, number>; fail?: number };
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
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(mock.log));
    return;
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, value);
  }
  const method = req.method ?? "GET";
  const answer = await mock.handle(new Request(`http://127.0.0.1:${port}${path}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body }));
  res.writeHead(answer.status, Object.fromEntries(answer.headers));
  res.end(Buffer.from(await answer.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`mock providers on http://127.0.0.1:${port}`));
