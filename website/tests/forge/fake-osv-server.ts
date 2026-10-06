// A fake OSV (osv.dev) for the end-to-end run (night phase 11): the batch endpoint and the vuln
// details endpoint, from a fixed table. Nothing reaches the real OSV; the registry's OSV client
// (oscr/osv.py) is pointed here with OSV_API_URL. CORS open, like the other fakes.
//
//   node --experimental-strip-types tests/forge/fake-osv-server.ts <port>

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 9493);

// One known vulnerability and one malicious package, affecting the fixture's pinned versions.
const VULNS: Record<string, unknown> = {
  "GHSA-fixture-numpy": {
    id: "GHSA-fixture-numpy",
    summary: "A buffer overflow in numpy's array handling",
    aliases: ["CVE-2026-0001"],
    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
  },
  "MAL-2026-0001": {
    id: "MAL-2026-0001",
    summary: "Malicious package: colourama (a typosquat of colorama)",
  },
};
const AFFECTS: Record<string, string[]> = {
  "PyPI\nnumpy\n1.26.0": ["GHSA-fixture-numpy"],
  "PyPI\ncolourama\n0.1.0": ["MAL-2026-0001"],
};

function read(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/v1/querybatch" && req.method === "POST") {
    const body = JSON.parse((await read(req)) || "{}") as { queries?: { package?: { name?: string; ecosystem?: string }; version?: string }[] };
    const results = (body.queries ?? []).map((q) => {
      const key = `${q.package?.ecosystem}\n${q.package?.name}\n${q.version}`;
      const ids = AFFECTS[key] ?? [];
      return { vulns: ids.map((id) => ({ id })) };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
    return;
  }
  const vuln = /^\/v1\/vulns\/(.+)$/.exec(url.pathname);
  if (vuln && VULNS[vuln[1]]) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(VULNS[vuln[1]]));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
server.listen(port, "127.0.0.1", () => console.log(`fake OSV on ${port}`));
