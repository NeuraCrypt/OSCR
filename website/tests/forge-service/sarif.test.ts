// Code scanning: SARIF uploaded through the token API (night phase 11, E4: worker/forge/service/sarif.ts).
// The registry parses and shows it, runs no analyser; the upload replaces the repository's results.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parseSarif } from "../../worker/forge/service/sarif.ts";
import { handleApi } from "../../worker/forge/service/api.ts";
import { forgeWorld, seed, T0, type ForgeBrowser, type ForgeWorld } from "./world.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
const body = async (res: Response): Promise<Json> => (await res.clone().json()) as Json;
const ORIGIN = "https://registry.example";
const HEAD = "a".repeat(40);

const SARIF = {
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "CodeQL", rules: [{ id: "py/sql-injection", name: "SQL injection", defaultConfiguration: { level: "error" }, properties: { "security-severity": "9.1" }, helpUri: "https://example.test/help" }] } },
    results: [{
      ruleId: "py/sql-injection",
      level: "error",
      message: { text: "User input flows into a SQL query" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "app/db.py" }, region: { startLine: 42 } } }],
      codeFlows: [{ threadFlows: [{ locations: [
        { location: { physicalLocation: { artifactLocation: { uri: "app/web.py" }, region: { startLine: 10 } } } },
        { location: { physicalLocation: { artifactLocation: { uri: "app/db.py" }, region: { startLine: 42 } } } },
      ] }] }],
    }],
  }],
};

describe("parseSarif", () => {
  test("a result becomes an alert with severity, rule, location and data flow", () => {
    const alerts = parseSarif(SARIF);
    assert.equal(alerts.length, 1);
    const a = alerts[0];
    assert.equal(a.severity, "critical"); // security-severity 9.1
    assert.equal(a.ruleName, "SQL injection");
    assert.equal(a.path, "app/db.py");
    assert.equal(a.line, 42);
    assert.equal(a.flow.length, 2);
    assert.equal(a.help, "https://example.test/help");
  });

  test("level maps to severity when no security-severity; a malformed doc yields nothing", () => {
    const doc = { runs: [{ results: [{ ruleId: "x", level: "warning", message: { text: "m" }, locations: [] }] }] };
    assert.equal(parseSarif(doc)[0].severity, "moderate");
    assert.deepEqual(parseSarif({ not: "sarif" }), []);
    assert.deepEqual(parseSarif(null), []);
  });

  test("an email in a message is masked", () => {
    const doc = { runs: [{ results: [{ ruleId: "x", message: { text: "see admin@example.org" }, locations: [] }] }] };
    assert.doesNotMatch(parseSarif(doc)[0].message, /admin@example\.org/);
  });
});

let w: ForgeWorld;
beforeEach(() => { w = forgeWorld({ env: { ACCOUNT_DEV_METRICS: "1" } }); });
afterEach(() => w.restore());

function call(path: string, token: string, payload: unknown): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return handleApi(request, w.env, w.ctx, w.deps) as Promise<Response>;
}

describe("POST /api/forge/v1/security/sarif", () => {
  async function token(scope: string): Promise<string> {
    const b: ForgeBrowser = w.browser();
    await b.signIn("github");
    const res = await b.post("/api/forge/tokens/write", { op: "create", name: "ci", scopes: [scope], days: 30 });
    return (await body(res)).token as string;
  }

  test("a token with security:write uploads SARIF; the alerts are stored and shown", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    const res = await call("/api/forge/v1/security/sarif", await token("security:write"), { repo: "ada/eeg", commit: HEAD, ref: "main", sarif: SARIF });
    assert.equal(res.status, 201, JSON.stringify(await body(res)));
    assert.equal((await body(res)).alerts, 1);
    const rows = w.forge.sqlite.prepare("SELECT severity, path, source FROM security_alerts WHERE kind = 'sarif'").all() as { severity: string; path: string; source: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, "critical");
    assert.equal(rows[0].path, "app/db.py");
    assert.equal(rows[0].source, "ci");
  });

  test("a second upload replaces the earlier results", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    const t = await token("security:write");
    await call("/api/forge/v1/security/sarif", t, { repo: "ada/eeg", commit: HEAD, ref: "main", sarif: SARIF });
    await call("/api/forge/v1/security/sarif", t, { repo: "ada/eeg", commit: HEAD, ref: "main", sarif: { version: "2.1.0", runs: [{ results: [] }] } });
    assert.equal((w.forge.sqlite.prepare("SELECT count(*) AS n FROM security_alerts WHERE kind = 'sarif'").get() as { n: number }).n, 0);
  });

  test("an unknown repository is 404; a wrong scope is refused", async () => {
    await seed.repo(w.forge, { repoId: "101", ownerLogin: "ada", name: "eeg", mode: "public", head: HEAD });
    const res = await call("/api/forge/v1/security/sarif", await token("security:write"), { repo: "ada/none", sarif: SARIF });
    assert.equal(res.status, 404);
    const res2 = await call("/api/forge/v1/security/sarif", await token("statuses:write"), { repo: "ada/eeg", sarif: SARIF });
    assert.equal(res2.status, 403);
  });
});
