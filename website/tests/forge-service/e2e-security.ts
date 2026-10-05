// Phase 11 (security and quality) end to end, on this machine (night phase 11; docs/SECURITY_QUALITY.md).
// Against the Worker started with FORGE_OPEN=true (Ada is the owner and manages the repository) and the
// security facts the Mac seeded (tests/forge-service/seed_security.py: a dependency graph, OSV alerts
// raised through the FAKE OSV, a secret alert), it shows the dependency graph, dismisses an OSV alert,
// shows the secret alert (reported, never blocking), ingests a SARIF file through the token API and
// shows it, files a private vulnerability report and publishes it, and builds an SBOM from the graph.
//
//   SITE=… REPO_ID=… node --experimental-strip-types tests/forge-service/e2e-security.ts

const SITE = process.env.SITE ?? "http://localhost:8791";
const REPO_ID = process.env.REPO_ID ?? "";
const ORIGIN = new URL(SITE).origin;

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;
let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

class Client {
  jar = new Map<string, string>();
  private keep(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.startsWith(SITE) && this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.startsWith(SITE)) this.keep(res);
    return res;
  }
  async navigate(url: string): Promise<URL> {
    let current = url;
    for (let i = 0; i < 10; i++) {
      const res = await this.request(current);
      const loc = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
      return new URL(current);
    }
    throw new Error("too many redirects");
  }
  async me(): Promise<Json> { return (await this.request(`${SITE}/api/account/me`, { headers: { Accept: "application/json" } })).json(); }
  async get(path: string): Promise<{ status: number; data: Json }> {
    const res = await this.request(`${SITE}${path}`, { headers: { Accept: "application/json" } });
    return { status: res.status, data: (await res.json()) as Json };
  }
  async post(path: string, body: unknown): Promise<{ status: number; data: Json }> {
    const csrf = (await this.me()).csrf as string;
    const payload = body && typeof body === "object" && !("turnstile" in (body as object)) ? { ...(body as object), turnstile: "XXXX.DUMMY.TOKEN.XXXX" } : body;
    const res = await this.request(`${SITE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "X-CSRF-Token": csrf }, body: JSON.stringify(payload) });
    return { status: res.status, data: (await res.json().catch(() => ({})) ) as Json };
  }
}

const id = `github:${REPO_ID}`;
const ada = new Client();
const landed = await ada.navigate(`${SITE}/api/auth/github/start?return=/repositories/`);
check("Ada signed in", landed.pathname === "/repositories/", landed.toString());

// 1. The dependency graph the Mac computed.
let sec = (await ada.get(`/api/forge/security?id=${id}`)).data;
const names = (sec.dependencies?.default ?? []).map((d: Json) => d.name);
check("the dependency graph is shown", names.includes("numpy") && names.includes("d3") && names.includes("actions/checkout"), names);
check("numpy is pinned to 1.26.0 from the lock/requirement", (sec.dependencies.default.find((d: Json) => d.name === "numpy") ?? {}).version === "1.26.0");

// 2. An OSV alert, raised through the fake OSV, dismissed.
const vuln = (sec.alerts?.osv ?? []).find((a: Json) => a.package === "numpy");
const mal = (sec.alerts?.osv ?? []).find((a: Json) => a.detail?.malware);
check("an OSV vulnerability alert is raised", !!vuln && vuln.severity === "critical", vuln);
check("a malicious-package alert is raised", !!mal, mal);
const dismiss = await ada.post(`/api/forge/security/triage?id=${id}`, { op: "dismiss", kind: "osv", ref: vuln.ref, reason: "tolerable" });
check("the OSV alert is dismissed", dismiss.status === 200 && dismiss.data.state === "dismissed", dismiss.data);
sec = (await ada.get(`/api/forge/security?id=${id}`)).data;
check("the dismissal is kept", (sec.alerts.osv.find((a: Json) => a.ref === vuln.ref) ?? {}).state === "dismissed");

// 3. A secret alert that does not block.
const secret = (sec.alerts?.secret ?? [])[0];
check("a secret alert is shown (reported, never blocking)", !!secret && !/ghp_a{36}/.test(JSON.stringify(secret)), secret);

// 4. SARIF ingested through the token API and shown.
const token = (await ada.post("/api/forge/tokens/write", { op: "create", name: "e2e-ci", scopes: ["security:write"], days: 30 })).data.token as string;
const sarif = { version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL", rules: [{ id: "py/url-redirect", name: "Open redirect", defaultConfiguration: { level: "error" }, properties: { "security-severity": "7.5" } }] } }, results: [{ ruleId: "py/url-redirect", level: "error", message: { text: "Untrusted input in a redirect" }, locations: [{ physicalLocation: { artifactLocation: { uri: "app/views.py" }, region: { startLine: 88 } } }] }] }] };
const upload = await fetch(`${SITE}/api/v1/security/sarif`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ repo: `github:${REPO_ID}`, commit: "a".repeat(40), ref: "main", sarif }) });
check("SARIF uploaded through the API", upload.status === 201, await upload.clone().text());
sec = (await ada.get(`/api/forge/security?id=${id}`)).data;
check("the code-scanning alert is shown", (sec.alerts.sarif ?? []).some((a: Json) => a.path === "app/views.py"), sec.alerts.sarif);

// 5. A private vulnerability report, filed and published.
const open = await ada.post(`/api/forge/advisory/open?id=${id}`, { title: "Open redirect in the viewer", severity: "high", summary: "A crafted URL redirects off-site.", affected: "< 1.2" });
check("a private vulnerability report is filed", open.status === 201 && typeof open.data.ref === "string", open.data);
const ref = open.data.ref as string;
check("a message is posted in the private thread", (await ada.post(`/api/forge/advisory/post?id=${id}`, { ref, body: "Fix queued." })).status === 201);
check("the advisory is published", (await ada.post(`/api/forge/advisory/edit?id=${id}`, { ref, op: "publish" })).status === 200);
const adv = (await ada.get(`/api/forge/advisory?id=${id}&ref=${ref}`)).data;
check("the published advisory reads back", adv.advisory?.state === "published" && (adv.advisory.thread ?? []).length === 1, adv.advisory);

// 6. The SBOM: the data the browser builds it from (the licence and the dependency graph).
check("the licence facts are present for the SBOM and compatibility", sec.licence?.spdx === "MIT" && sec.dependencies.default.length >= 3, sec.licence);

console.log(failures === 0 ? "\nphase 11: every check passed" : `\nphase 11: ${failures} FAILED`);
if (failures > 0) process.exit(1);
